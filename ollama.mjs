import { readFileSync } from "fs";
import { extname, relative } from "path";

// ─── PRECISION MODES ─────────────────────────────────────
// maxTokens : ceiling for model output (keep low — context files need precision, not verbosity)
// maxChars  : input budget for file content before truncation kicks in
export const PRECISION_MODES = {
  fast: {
    label: "Fast",
    maxTokens: 2000,
    maxChars: 8000,
    temp: 0.1,
    desc: "Role + exports list. Best for large codebases where speed matters.",
  },
  standard: {
    label: "Standard",
    maxTokens: 5000,
    maxChars: 16000,
    temp: 0.15,
    desc: "Role, key exports, dependencies, gotchas. Best balance.",
  },
  deep: {
    label: "Deep",
    maxTokens: 9000,
    maxChars: 26000,
    temp: 0.2,
    desc: "Full analysis: architecture, side effects, watch-outs.",
  },
  adaptive: {
    label: "Adaptive",
    maxTokens: 9000,   // ceiling — actual limit comes from resolved tier
    maxChars: 26000,   // ceiling
    temp: 0.15,
    desc: "Scales depth by file size. Short → Fast, medium → Standard, large → Deep.",
    isAdaptive: true,
  },
};

// Adaptive tier thresholds measured against raw file content length (chars)
var ADAPTIVE_THRESHOLDS = {
  fast: 3000,       // < 3 000 chars  (~50 lines avg)  → fast
  standard: 15000,  // 3 000–15 000   (~250 lines avg) → standard
  // > 15 000 chars → deep
};

// Returns an effective mode object (always fast/standard/deep) with `_name` set.
// Handles the adaptive pseudo-mode transparently so the rest of the code is clean.
function getEffectiveMode(precision, contentLength) {
  if (precision !== "adaptive") {
    var base = PRECISION_MODES[precision] || PRECISION_MODES.standard;
    return Object.assign({}, base, { _name: precision });
  }
  if (contentLength < ADAPTIVE_THRESHOLDS.fast) {
    return Object.assign({}, PRECISION_MODES.fast, { _name: "fast" });
  }
  if (contentLength < ADAPTIVE_THRESHOLDS.standard) {
    return Object.assign({}, PRECISION_MODES.standard, { _name: "standard" });
  }
  return Object.assign({}, PRECISION_MODES.deep, { _name: "deep" });
}

// ─── OLLAMA CHECK ─────────────────────────────────────────
export async function checkOllama(host) {
  try {
    var r = await fetch(host + "/api/tags", {
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) {
      var d = await r.json();
      var models = (d.models || []).map(function (m) {
        var isCloud = /[:\-]cloud\b/i.test(m.name) || m.size === 0;
        return { name: m.name, isCloud: isCloud };
      });
      return { ok: true, models: models };
    }
    return { ok: false };
  } catch (e) {
    return { ok: false };
  }
}

// ─── THINKING MODEL STRIPPING ─────────────────────────────
function stripThinking(text) {
  if (!text) return text;
  var cleaned = text.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
  if (cleaned === "" && text.includes("<think")) return "";
  return cleaned;
}

function isThinkingModel(modelName) {
  if (!modelName) return false;
  var lower = modelName.toLowerCase();
  return (
    lower.includes("qwen3") ||
    lower.includes("deepseek-r1") ||
    lower.includes("qwq")
  );
}

// ─── IMPORT-AWARE SLIDING WINDOW ─────────────────────────
// For large files: always preserve the import block at the top (it describes
// dependencies), then show head + tail of the body. This ensures the model
// sees both what the file imports AND what it exports, even for very large files.
function smartTruncate(content, maxChars) {
  if (content.length <= maxChars) return content;

  var lines = content.split("\n");

  // Step 1: extract the import block (usually the first N lines of a source file)
  var importLines = [];
  var importEnd = 0;
  var foundImports = false;

  for (var i = 0; i < Math.min(100, lines.length); i++) {
    var trimmed = lines[i].trim();

    // Allow blank/comment lines within the import block
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("'use ") ||   // 'use strict' etc.
      trimmed.startsWith('"use ')
    ) {
      if (foundImports) importLines.push(lines[i]);
      continue;
    }

    // Detect import/require/use lines
    var isImport =
      trimmed.startsWith("import ") ||
      trimmed.startsWith("from ") ||
      trimmed.startsWith("use ") ||          // Rust
      trimmed.startsWith("using ") ||        // C#
      trimmed.startsWith("require ") ||      // Go
      /^(const|let|var)\s+\S+\s*=\s*require/.test(trimmed) ||
      /^@?(import|use)\s/.test(trimmed);     // PHP / Dart / etc.

    if (isImport) {
      foundImports = true;
      importLines.push(lines[i]);
      importEnd = i + 1;
    } else if (foundImports) {
      // First non-import line after imports → stop
      break;
    } else if (i > 8) {
      // No imports in first 8 lines → this file doesn't have a standard import block
      break;
    }
  }

  var importBlock = importLines.join("\n");
  var bodyText = lines.slice(importEnd).join("\n");

  // Step 2: allocate remaining budget between head and tail of body
  var budget = maxChars - importBlock.length - 180; // reserve space for the ellipsis message

  if (budget <= 100) {
    // Import block alone consumed the budget — just head-truncate the full file
    return content.slice(0, maxChars - 60) + "\n\n// ...[file truncated for analysis]...";
  }

  var headSize = Math.floor(budget * 0.58); // ~58% head — captures class/function defs
  var tailSize = Math.floor(budget * 0.28); // ~28% tail — captures exports at bottom

  if (bodyText.length <= headSize + tailSize) {
    return (importBlock ? importBlock + "\n" : "") + bodyText;
  }

  var head = bodyText.slice(0, headSize);
  var tail = bodyText.slice(bodyText.length - tailSize);
  var omitted = bodyText.length - headSize - tailSize;
  var sep = "\n\n// ...[" + omitted + " chars omitted — middle section]...\n\n";

  return (importBlock ? importBlock + "\n" : "") + head + sep + tail;
}

// ─── PROMPT BUILDER ───────────────────────────────────────
// Each tier has a carefully structured template optimised for AI coding assistant
// context files. The goal is: actionable, specific, non-generic information.
function buildPromptForTier(tier, rel, ext, truncated, projectDesc, modelName) {
  var ctx = projectDesc
    ? 'Project context: "' + projectDesc + '"\n\n'
    : "";

  var thinkSuffix = isThinkingModel(modelName) ? "\n\n/no_think" : "";

  var preamble =
    "You are generating a single entry for an AI coding assistant context file.\n" +
    "Use actual names from the code — avoid generic phrases like 'utility functions' or 'helper methods'.\n" +
    "STRICT RULES — violating any of these makes the output useless:\n" +
    "1. Every sentence must be specific to THIS exact file. If it would be true for any file in any project, remove it.\n" +
    "2. Never write the phrase 'single source of truth'.\n" +
    "3. Never write boilerplate like 'validate inputs', 'handle errors gracefully', 'ensure compatibility', or 'maintain consistency'.\n" +
    "4. If a field has nothing specific to say about this file, write exactly: none\n" +
    "5. Do not start sentences with 'Without this file' or 'If deleted'.\n" +
    "6. Only state facts you can directly verify in the file content shown below. Do not invent file names, function names, or behaviors that are not visible in the code.\n" +
    "Reply ONLY with the markdown block below. No preamble. No code fences around your answer.\n\n";

  var template;

  if (tier === "fast") {
    // Minimal: one-liner + exports. For tiny files or speed-priority runs.
    template =
      "### `" + rel + "`\n" +
      "**Role:** [One precise sentence — what this file does and what it uniquely owns in this project]\n" +
      "**Exports:** [Comma-separated: `name`, `name2` — or write \"none\" if nothing is exported]";

  } else if (tier === "standard") {
    // Balanced: role, key exports, non-obvious deps, watch-outs.
    template =
      "### `" + rel + "`\n" +
      "**Role:** [2-3 sentences — the specific responsibility of this file in this project]\n" +
      "**Key exports:** [One per line: `name` — what it does and returns. Up to 8 entries. Write \"none\" if nothing exported]\n" +
      "**Non-obvious deps:** [Only surprising imports: version-sensitive libs, env vars consumed, global singletons, external services. Do NOT list fs, path, os, http or other ubiquitous stdlib. Write \"none\" if nothing unusual]\n" +
      "**Watch out:** [File-specific gotchas: global state mutations, ordering constraints, shape-sensitive objects, side effects on import. Write \"none\" if safe to edit freely]";

  } else {
    // Deep: full architecture + file-specific watch-outs.
    template =
      "### `" + rel + "`\n" +
      "**Role:** [2-3 sentences — what this file exclusively owns and manages in this project's architecture]\n" +
      "**Key exports:** [One per line: `name(params)` — what it does, return type if non-obvious. Up to 15 entries]\n" +
      "**Non-obvious deps:** [Each surprising dependency: external libs with version-sensitive behavior, env vars consumed, global singletons, implicit ordering. Do NOT list fs, path, os, http. Write \"none\" if nothing unusual]\n" +
      "**Side effects:** [Observable effects on import or call: global state mutations, event subscriptions, disk writes, timers, network calls. Write \"none\" if pure]\n" +
      "**Architecture:** [What this file directly imports from this project (list them by name), what global state or singletons it initializes or owns, which of its exports are stable public API vs internal helpers]\n" +
      "**Watch out:** [File-specific gotchas: invariants that must hold, ordering constraints, shape-sensitive objects, non-obvious failure modes. Write \"none\" if safe to edit freely]";
  }

  return (
    ctx +
    preamble +
    template +
    thinkSuffix +
    "\n\nFile: `" + rel + "` (" + ext + ")\n```" + ext + "\n" +
    truncated +
    "\n```"
  );
}

// ─── LOOP DETECTOR ────────────────────────────────────────
function detectAndFixLoop(text) {
  if (!text) return text;

  var lines = text.split("\n");

  // Strategy 1: line-level repetition — same non-trivial line seen 3+ times
  var seen = new Map();
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.length < 8) continue;
    var key = line.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, i);
      continue;
    }
    var count = 0;
    for (var j = 0; j <= i; j++) {
      if (lines[j].trim().toLowerCase() === key) count++;
    }
    if (count >= 3) {
      var cutAt = 0, hits = 0;
      for (var k = 0; k < lines.length; k++) {
        if (lines[k].trim().toLowerCase() === key) {
          hits++;
          if (hits === 2) { cutAt = k; break; }
        }
      }
      return (
        lines.slice(0, cutAt).join("\n").trimEnd() +
        "\n*(output truncated — repetition detected)*"
      );
    }
  }

  // Strategy 2: ngram repetition on raw text
  var chunkSize = 60;
  var chunksSeen = new Map();
  for (var ci = 0; ci < text.length - chunkSize; ci += 20) {
    var chunk = text.slice(ci, ci + chunkSize).trim().toLowerCase();
    if (chunk.length < 20) continue;
    chunksSeen.set(chunk, (chunksSeen.get(chunk) || 0) + 1);
    if (chunksSeen.get(chunk) >= 4) {
      var firstIdx = text.toLowerCase().indexOf(chunk);
      if (firstIdx > 100) {
        return (
          text.slice(0, firstIdx).trimEnd() +
          "\n*(output truncated — repetition detected)*"
        );
      }
    }
  }

  return text;
}

// ─── LIST CAP ─────────────────────────────────────────────
function capListSection(text, maxItems) {
  if (!text || maxItems <= 0) return text;
  var sectionRe = /(\*\*Key exports:\*\*)([\s\S]*?)(\n\*\*[A-Z]|\n###|$)/;
  var match = text.match(sectionRe);
  if (!match) return text;

  var prefix = match[1];
  var body = match[2];
  var suffix = match[3];

  var itemLines = body.split("\n").filter(function (l) {
    return /^\s*[-*`\d]/.test(l) && l.trim().length > 0;
  });

  if (itemLines.length <= maxItems) return text;

  var kept = itemLines.slice(0, maxItems);
  var overflow = itemLines.length - maxItems;
  var newBody =
    "\n" +
    kept.join("\n") +
    "\n*...and " + overflow + " more (file too large to list all)*";
  return text.replace(sectionRe, prefix + newBody + suffix);
}

// ─── MAIN ANALYSIS FUNCTION ───────────────────────────────
export async function analyzeFileWithOllama(
  filePath,
  projectRoot,
  config,
  signal,
) {
  var rel = relative(projectRoot, filePath);
  var ext = extname(filePath).replace(".", "") || "txt";

  var content;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (e) {
    return { content: null, error: "Cannot read file: " + e.message };
  }

  if (!content.trim()) {
    return { content: null, error: "File is empty" };
  }

  // Resolve effective mode — adaptive is transparently mapped to fast/standard/deep
  var mode = getEffectiveMode(config.precision, content.length);
  var tier = mode._name; // always 'fast' | 'standard' | 'deep'

  var truncated = smartTruncate(content, mode.maxChars);

  var prompt = buildPromptForTier(
    tier,
    rel,
    ext,
    truncated,
    config.projectDescription || "",
    config.model,
  );

  var messages = [{ role: "user", content: prompt }];

  // Cap for Key exports section — scales with analysis depth
  var maxListItems = tier === "fast" ? 0 : tier === "standard" ? 8 : 15;

  function postProcess(raw) {
    if (!raw) return raw;
    raw = stripThinking(raw);
    raw = raw
      .replace(/^```(?:markdown)?\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();
    // Normalize template artifacts: **Field:** [none] → **Field:** none
    // The model sometimes echoes the bracket syntax when it means "none"
    raw = raw.replace(/(\*\*[^*\n]+\*\*:)\s*\[none\]/gi, "$1 none");
    raw = detectAndFixLoop(raw);
    raw = capListSection(raw, maxListItems);
    return raw;
  }

  // ─── ATTEMPT 1: Native Ollama API ───────────────────────
  try {
    var res = await fetch(config.ollamaHost + "/api/chat", {
      method: "POST",
      signal: signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: messages,
        stream: false,
        options: {
          num_predict: mode.maxTokens,
          temperature: mode.temp,
          repeat_penalty: 1.35,
          repeat_last_n: 128,
        },
      }),
    });

    if (!res.ok) {
      var errText = await res.text().catch(function () { return ""; });
      console.log(
        "[ollama] Native API HTTP " + res.status + ": " + errText.slice(0, 200),
      );
    } else {
      var data = await res.json();
      var text =
        data.message && data.message.content ? data.message.content.trim() : "";
      text = postProcess(text);
      if (text) return { content: text, error: null };
      console.log("[ollama] Native API returned empty, trying OpenAI endpoint…");
    }
  } catch (e) {
    if (e.name === "AbortError") throw e;
    console.log(
      "[ollama] Native API error: " + e.message + ", trying OpenAI endpoint…",
    );
  }

  // ─── ATTEMPT 2: OpenAI-compatible endpoint ───────────────
  try {
    var res2 = await fetch(config.ollamaHost + "/v1/chat/completions", {
      method: "POST",
      signal: signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: messages,
        temperature: mode.temp,
        max_tokens: mode.maxTokens,
        frequency_penalty: 0.3,
        stream: false,
      }),
    });

    if (!res2.ok) {
      var errText2 = await res2.text().catch(function () { return ""; });
      return {
        content: null,
        error:
          "Both Ollama APIs failed. HTTP " +
          res2.status +
          ": " +
          errText2.slice(0, 300),
      };
    }

    var data2 = await res2.json();
    var text2 =
      data2.choices &&
      data2.choices[0] &&
      data2.choices[0].message &&
      data2.choices[0].message.content
        ? data2.choices[0].message.content.trim()
        : "";

    text2 = postProcess(text2);
    if (!text2) {
      return {
        content: null,
        error:
          'Model "' +
          config.model +
          '" returned empty after both attempts. Try a different model.',
      };
    }

    return { content: text2, error: null };
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return { content: null, error: "Ollama request failed: " + e.message };
  }
}

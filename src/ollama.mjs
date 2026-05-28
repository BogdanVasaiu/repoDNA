import { readFileSync, appendFileSync } from "fs";
import { extname, relative } from "path";
import { LOG_FILE } from "./debug.mjs";

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
    if (precision !== "fast" && contentLength < 300) {
      return Object.assign({}, PRECISION_MODES.fast, { _name: "fast" });
    }
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
      signal: AbortSignal.timeout(10000), // 10s — Ollama can be slow when loading models
    });
    if (r.ok) {
      var d = await r.json();
      var models = (d.models || []).map(function (m) {
        var isCloud = /[:\-]cloud\b/i.test(m.name) || m.size === 0;
        return { name: m.name, isCloud: isCloud, size: m.size || 0 };
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

// ─── STRUCTURE SANITIZER ──────────────────────────────────
// Weak models commonly leave a code fence (``` or ~~~) unclosed at the end
// of their output. When file sections get joined into CLAUDE.md, that
// dangling fence swallows the next file's content — and sometimes the
// document footer — producing nonsensical edges in the rendered preview.
// Likewise, stray h1/h2/h3 headers inside the body would break the section
// parser that anchors files by their `### \`path\`` header.
function sanitizeStructure(text) {
  if (!text) return text;

  // Single pass: walk lines tracking fence state, and at every field-label
  // boundary (e.g. "**Watch out:**" at column 0) close any open fence first.
  // Field labels can't legitimately appear inside a code block — if a fence
  // looks open at that point, the model forgot a closer earlier.
  var lines = text.split(/\r?\n/);
  var inFence = false;
  var fenceCh = "";
  var fenceLen = 0;
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var fm = line.match(/^( {0,3})(`{3,}|~{3,})/);
    if (fm) {
      var fc = fm[2][0], fl = fm[2].length;
      if (!inFence) { inFence = true; fenceCh = fc; fenceLen = fl; }
      else if (fc === fenceCh && fl >= fenceLen) { inFence = false; }
      out.push(line);
      continue;
    }
    // Field label at column 0: "**Something:**" — close any leaking fence.
    if (inFence && /^\*\*[^*\n]{1,40}:\*\*/.test(line)) {
      out.push(fenceCh === "~" ? "~~~" : "```");
      inFence = false;
      fenceCh = "";
      fenceLen = 0;
      out.push(line);
      continue;
    }
    if (!inFence) {
      // Demote stray top-level headers (h1/h2/h3) to h4. The canonical file
      // header is prepended by the caller; anything stronger inside the
      // body would create a fake section in the assembled CLAUDE.md.
      line = line.replace(/^(#{1,3})([ \t]+\S)/, "####$2");
    }
    out.push(line);
  }
  // If we still finished inside a fence, close it.
  if (inFence) {
    out.push(fenceCh === "~" ? "~~~" : "```");
  }
  return out.join("\n");
}

// ─── STRUCTURE VALIDATOR ──────────────────────────────────
// After postProcess() runs, every legitimate response must hit a few
// hard structural marks. If it doesn't, we know the model went off-template
// and a retry is worth attempting. The validator only reports — it does
// not mutate text.
var REQUIRED_FIELDS_BY_TIER = {
  fast:     ["Role", "Exports"],
  standard: ["Role", "Key exports", "Non-obvious deps", "Watch out"],
  deep:     ["Role", "Key exports", "Non-obvious deps", "Side effects", "Architecture", "Watch out"],
};

function _norm(label) { return label.replace(/s$/, "").toLowerCase(); }

// Allowed bold field labels at column 0. Stored normalized so the check is
// case-insensitive ("Watch Out" == "Watch out", "Side Effects" == "Side effects").
var ALLOWED_LABELS_NORM = new Set([
  "Role", "Exports", "Export", "Key exports", "Key export",
  "Non-obvious deps", "Non-obvious dep",
  "Watch out", "Side effects", "Side effect", "Architecture",
].map(_norm));

function validateModelOutput(text, tier) {
  var reasons = [];
  if (!text || text.trim().length < 60) {
    return { ok: false, reasons: ["output is too short — likely truncated or empty"] };
  }

  // Collect every bold field label that appears at column 0.
  var labelRe = /^\*\*([^*\n]{1,40}):\*\*/gm;
  var foundLabels = [];
  var m;
  while ((m = labelRe.exec(text)) !== null) foundLabels.push(m[1].trim());

  // Required fields present?
  var required = REQUIRED_FIELDS_BY_TIER[tier] || REQUIRED_FIELDS_BY_TIER.standard;
  var foundNorm = foundLabels.map(_norm);
  for (var i = 0; i < required.length; i++) {
    if (foundNorm.indexOf(_norm(required[i])) === -1) {
      reasons.push('missing required **' + required[i] + ':** field');
    }
  }

  // Rogue field labels — model invented something not in our schema.
  for (var j = 0; j < foundLabels.length; j++) {
    if (!ALLOWED_LABELS_NORM.has(_norm(foundLabels[j]))) {
      reasons.push('unexpected field "**' + foundLabels[j] + ':**" (not in template)');
      break;
    }
  }

  // Unfilled template brackets: model echoed the instruction placeholders.
  if (/\*\*\w[^*\n]{0,30}:\*\*\s*\[[A-Z][^\]]{4,}\]/.test(text)) {
    reasons.push("a field still contains the template placeholder (e.g. [One precise sentence...])");
  }

  // Echoed prompt content — the model included our instructions in its reply.
  if (/STRICT RULES|Reply ONLY|preamble[\s.]/i.test(text)) {
    reasons.push("output echoed prompt instructions");
  }

  // Role must have actual content. "none" is acceptable for Exports/etc. but
  // never for Role — every file has a role.
  var roleM = text.match(/^\*\*Role:\*\*[ \t]*(.*)$/m);
  if (roleM) {
    var roleVal = roleM[1].trim();
    var roleLower = roleVal.toLowerCase().replace(/[.\s]+$/, "");
    if (roleVal.length < 10 || roleLower === "none" || roleLower === "n/a") {
      reasons.push("Role field has no real content");
    }
  }

  return { ok: reasons.length === 0, reasons: reasons };
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

  // Walk lines once, tracking fence state. Bullets only count as items when
  // they're OUTSIDE a fenced code block — otherwise a stray ``` inside an
  // item's code sample gets counted as a separate "item" and the kept slice
  // can leave a fence dangling, which then leaks into Non-obvious deps /
  // Watch out and renders them as code.
  var rawLines = body.split("\n");
  var inFence = false;
  var fenceCh = "";
  var fenceLen = 0;
  var itemStartLines = [];
  for (var i = 0; i < rawLines.length; i++) {
    var fm = rawLines[i].match(/^( {0,3})(`{3,}|~{3,})/);
    if (fm) {
      var fc = fm[2][0], fl = fm[2].length;
      if (!inFence) { inFence = true; fenceCh = fc; fenceLen = fl; }
      else if (fc === fenceCh && fl >= fenceLen) { inFence = false; }
      continue;
    }
    if (inFence) continue;
    if (/^\s*[-*\d]/.test(rawLines[i]) && rawLines[i].trim().length > 0) {
      itemStartLines.push(i);
    }
  }

  if (itemStartLines.length <= maxItems) return text;

  // Keep everything up to (but not including) the line where item #(maxItems+1)
  // starts. That preserves the bullets' descriptions and any code blocks that
  // belong to kept items, instead of filtering to just bullet lines.
  var cutAt = itemStartLines[maxItems];
  var kept = rawLines.slice(0, cutAt).join("\n").replace(/\s+$/, "");

  // If the kept slice ends with a fence still open, close it before the
  // truncation marker so the fence can't bleed into the next field.
  var keptOpen = "";
  var keptOpenLen = 0;
  var keptLines = kept.split("\n");
  for (var k = 0; k < keptLines.length; k++) {
    var km = keptLines[k].match(/^( {0,3})(`{3,}|~{3,})/);
    if (!km) continue;
    var kc = km[2][0], kl = km[2].length;
    if (!keptOpen) { keptOpen = kc; keptOpenLen = kl; }
    else if (kc === keptOpen && kl >= keptOpenLen) { keptOpen = ""; keptOpenLen = 0; }
  }
  var fenceCloser = keptOpen ? "\n" + (keptOpen === "~" ? "~~~" : "```") : "";

  var overflow = itemStartLines.length - maxItems;
  var newBody =
    "\n" +
    kept +
    fenceCloser +
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
  var rel = relative(projectRoot, filePath).replace(/\\/g, "/");
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

  // Hard floor: never waste standard/deep tokens on trivially small files.
  // The model can't produce meaningful structured output for <300 chars anyway,
  // so override to fast regardless of the user-chosen precision.
  if (tier !== "fast" && content.length < 300) {
    mode = Object.assign({}, PRECISION_MODES.fast, { _name: "fast" });
    tier = "fast";
  }

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
    // Normalize field labels to bold — two patterns weaker models produce:
    // 1. Heading style:  "### Architecture:" or "#### Watch out:"
    // 2. Plain text:     "Architecture:"  (standalone line, no bold markers)
    // Both create structural noise; normalize to "**Field:**".
    var _fields = "Role|Key exports?|Exports?|Non-obvious deps?|Watch out|Side effects?|Architecture";
    raw = raw.replace(
      new RegExp("^#{2,4}[ \\t]+(" + _fields + ")[ \\t]*:?\\**[ \\t]*$", "gim"),
      function (_, f) { return "**" + f + ":**"; }
    );
    raw = raw.replace(
      new RegExp("^(" + _fields + ")\\s*:\\s*$", "gim"),
      function (_, f) { return "**" + f + ":**"; }
    );
    // Always emit the canonical ### `rel` header.
    // Weaker models often include their own ### line with no backticks or wrong path
    // separators (forward slash on Windows), so startsWith("### `") silently failed
    // and produced a duplicate. Strip any leading ### line unconditionally, then
    // re-emit ours in the correct form.
    // Strip any trailing horizontal rule the model appends — the builder adds its
    // own --- separator between entries, so a trailing one creates a double ---
    raw = raw.replace(/(\n\s*---+\s*)+$/, "").trimEnd();
    raw = raw.replace(/^###[ \t]+[^\n]*\n?/, "").trimStart();
    raw = sanitizeStructure(raw);
    raw = "### `" + rel + "`\n" + raw;
    return raw;
  }

  // One round-trip to the model: tries the native Ollama endpoint first,
  // falls back to the OpenAI-compatible endpoint if native fails or is
  // empty. Returns the raw (un-postprocessed) text plus tok/s if available,
  // or an `error` string if both endpoints failed hard.
  async function callOnce(msgs, temp, maxTokens) {
    // Native
    try {
      var t1 = Date.now();
      var res = await fetch(config.ollamaHost + "/api/chat", {
        method: "POST",
        signal: signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages: msgs,
          stream: false,
          options: {
            num_predict: maxTokens,
            temperature: temp,
            repeat_penalty: 1.35,
            repeat_last_n: 128,
          },
        }),
      });
      if (res.ok) {
        var data = await res.json();
        var raw =
          data.message && data.message.content ? data.message.content.trim() : "";
        var tps = null;
        if (data.eval_count > 0 && data.eval_duration > 0) {
          tps = Math.round(data.eval_count / (data.eval_duration / 1e9));
        } else if (data.eval_count > 0) {
          var w1 = (Date.now() - t1) / 1000;
          if (w1 > 0) tps = Math.round(data.eval_count / w1);
        }
        if (raw) return { raw: raw, tokensPerSecond: tps, error: null };
        console.log("[ollama] Native API returned empty, trying OpenAI endpoint…");
      } else {
        var errText = await res.text().catch(function () { return ""; });
        console.log(
          "[ollama] Native API HTTP " + res.status + ": " + errText.slice(0, 200),
        );
      }
    } catch (e) {
      if (e.name === "AbortError") throw e;
      console.log(
        "[ollama] Native API error: " + e.message + ", trying OpenAI endpoint…",
      );
    }
    // OpenAI fallback
    try {
      var t2 = Date.now();
      var res2 = await fetch(config.ollamaHost + "/v1/chat/completions", {
        method: "POST",
        signal: signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages: msgs,
          temperature: temp,
          max_tokens: maxTokens,
          frequency_penalty: 0.3,
          stream: false,
        }),
      });
      if (!res2.ok) {
        var errText2 = await res2.text().catch(function () { return ""; });
        return {
          raw: null,
          tokensPerSecond: null,
          error:
            "Both Ollama APIs failed. HTTP " +
            res2.status +
            ": " +
            errText2.slice(0, 300),
        };
      }
      var data2 = await res2.json();
      var raw2 =
        data2.choices &&
        data2.choices[0] &&
        data2.choices[0].message &&
        data2.choices[0].message.content
          ? data2.choices[0].message.content.trim()
          : "";
      var tps2 = null;
      if (data2.usage) {
        var totalToks =
          (data2.usage.completion_tokens || 0) + (data2.usage.prompt_tokens || 0);
        var w2 = (Date.now() - t2) / 1000;
        if (totalToks > 0 && w2 > 0) tps2 = Math.round(totalToks / w2);
      }
      return { raw: raw2, tokensPerSecond: tps2, error: null };
    } catch (e) {
      if (e.name === "AbortError") throw e;
      return { raw: null, tokensPerSecond: null, error: "Ollama request failed: " + e.message };
    }
  }

  // Retry loop: if the validator finds structural problems, ask the model to
  // try again with a corrective preface. Cap at one retry so a stubborn model
  // can't blow up latency or token cost.
  var maxAttempts = 2;
  var attemptMessages = messages;
  var attemptTemp = mode.temp;
  var lastContent = null;
  var lastTokens = null;
  var lastReasons = null;

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    var r = await callOnce(attemptMessages, attemptTemp, mode.maxTokens);
    if (r.error && !r.raw) {
      // Hard transport failure — bail with the error string.
      if (attempt === 0) return { content: null, error: r.error };
      // If first attempt produced content, prefer that over the retry's failure.
      return { content: lastContent, error: null, tokensPerSecond: lastTokens };
    }
    if (!r.raw) {
      if (attempt === 0) {
        return {
          content: null,
          error:
            'Model "' + config.model + '" returned empty. Try a different model.',
        };
      }
      return { content: lastContent, error: null, tokensPerSecond: lastTokens };
    }

    var processed = postProcess(r.raw);
    var v = validateModelOutput(processed, tier);

    if (v.ok) {
      return { content: processed, error: null, tokensPerSecond: r.tokensPerSecond };
    }

    // Validation failed. Remember this attempt in case we exhaust retries.
    lastContent = processed;
    lastTokens = r.tokensPerSecond;
    lastReasons = v.reasons;

    if (attempt + 1 < maxAttempts) {
      if (process.env.REPODNA_DEBUG === "1") {
        var issues = v.reasons.map(function (r) {
          return r
            .replace(/\*\*/g, "")
            .replace(/^missing required (.+?) field$/, "missing: $1")
            .replace(/^unexpected field "(.+?)" \(not in template\)$/, "rogue field: $1")
            .replace(/^a field still contains the template placeholder.*$/, "unfilled placeholder")
            .replace(/^output is too short.*$/, "output too short");
        });
        appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), event: "validation_retry", file: rel, tier: tier, tps: r.tokensPerSecond, issues: issues }) + "\n");
      }
      // Build a tighter retry: prepend a one-shot correction, lower temp.
      var correction =
        "RETRY: Your previous reply violated the required template. Fix these issues:\n" +
        v.reasons.map(function (x) { return "  - " + x; }).join("\n") + "\n" +
        "Output ONLY the markdown block. Every required **Field:** must be present, " +
        "at column 0, on its own line. No extra fields. No echoed instructions.\n\n";
      attemptMessages = [
        { role: "user", content: correction + messages[0].content },
      ];
      attemptTemp = Math.max(0.05, mode.temp * 0.4);
    }
  }

  // Retries exhausted — accept the last output. postProcess + sanitizeStructure
  // already guarantee the file's section won't structurally break the assembled
  // CLAUDE.md, so this is preferable to marking the file as failed.
  return {
    content: lastContent,
    error: null,
    tokensPerSecond: lastTokens,
    validation: { ok: false, reasons: lastReasons },
  };
}

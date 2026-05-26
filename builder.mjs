import { readFileSync, existsSync } from "fs";
import { join, extname, dirname, relative as relPath } from "path";
import { assignCategory } from "./classifier.mjs";

const CATEGORY_META = {
  "source-code": { label: "💻 Source Code",   title: "Source Code" },
  config:        { label: "⚙️ Configuration",  title: "Configuration" },
  docs:          { label: "📄 Documentation",  title: "Documentation" },
  styles:        { label: "🎨 CSS Styles",     title: "CSS Styles" },
  templates:     { label: "🖼️ Templates",      title: "Templates" },
  "data-schema": { label: "🗄️ Data Schema",   title: "Data Schema" },
  notebooks:     { label: "📓 Notebooks",      title: "Notebooks" },
  scripts:       { label: "📜 Scripts",        title: "Scripts" },
  images:        { label: "🖼️ Images",         title: "Images" },
  svg:           { label: "🔷 SVG",            title: "SVG" },
  fonts:         { label: "🔤 Fonts",          title: "Fonts" },
  "audio-video": { label: "🎬 Media",          title: "Media" },
  archives:      { label: "📦 Archives",       title: "Archives" },
  locks:         { label: "🔒 Lock files",     title: "Lock Files" },
  generated:     { label: "⚡ Generated",      title: "Generated Files" },
  logs:          { label: "📋 Logs",           title: "Logs" },
  certs:         { label: "🛡️ Certificates",   title: "Certificates" },
  unknown:       { label: "📄 Other",          title: "Other Files" },
};

export function categorize(rel) {
  const ext = extname(rel).replace(/^\./, "");
  return assignCategory(ext);
}

// ─── STATIC IMPORT PARSER ────────────────────────────────
const SOURCE_EXTS = new Set([
  "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx",
  "vue", "svelte", "py", "go", "rs",
]);

function parseImports(filePath, projectRoot) {
  const ext = extname(filePath).toLowerCase().replace(/^\./, "");
  if (!SOURCE_EXTS.has(ext)) return [];

  let src;
  try {
    src = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const found = new Set();

  const esRe =
    /(?:import|export)\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = esRe.exec(src)) !== null) {
    const spec = m[1];
    if (spec.startsWith(".")) found.add(spec);
  }

  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(src)) !== null) {
    if (m[1].startsWith(".")) found.add(m[1]);
  }

  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqRe.exec(src)) !== null) {
    if (m[1].startsWith(".")) found.add(m[1]);
  }

  if (ext === "py") {
    const pyRe = /^(?:from|import)\s+(\.[\w.]*)/gm;
    while ((m = pyRe.exec(src)) !== null) found.add(m[1]);
  }

  return [...found];
}

export function buildDependencyGraph(fileList, projectRoot) {
  const graph = {};
  for (const relPath of fileList) {
    const absPath = join(projectRoot, relPath);
    const imports = parseImports(absPath, projectRoot);
    if (imports.length) {
      graph[relPath] = imports;
    }
  }
  return graph;
}

function formatDependencyGraph(graph) {
  const entries = Object.entries(graph);
  if (!entries.length) return "";

  const lines = ["## Dependency Graph\n"];
  lines.push("> Auto-extracted from static import analysis.\n");

  const importedBy = {};
  for (const [src, deps] of entries) {
    for (const dep of deps) {
      if (!importedBy[dep]) importedBy[dep] = [];
      importedBy[dep].push(src);
    }
  }

  for (const [src, deps] of entries.sort((a, b) => b[1].length - a[1].length)) {
    lines.push(
      `**\`${src}\`** imports: ${deps.map((d) => `\`${d}\``).join(", ")}`,
    );
  }

  const popular = Object.entries(importedBy)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8);
  if (popular.length) {
    lines.push("\n### Most imported modules");
    for (const [mod, importers] of popular) {
      lines.push(
        `- \`${mod}\` ← used by ${importers.length} file${importers.length > 1 ? "s" : ""}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

function buildAsciiTreeMd(filePaths) {
  if (!filePaths || !filePaths.length) return "";

  const root = {};
  for (const p of filePaths) {
    const parts = p.replace(/\\/g, "/").split("/");
    let node = root;
    for (const part of parts) {
      if (!node[part]) node[part] = {};
      node = node[part];
    }
  }

  const lines = [];
  function render(node, prefix) {
    const keys = Object.keys(node).sort((a, b) => {
      const aDir = Object.keys(node[a]).length > 0;
      const bDir = Object.keys(node[b]).length > 0;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
    keys.forEach((key, i) => {
      const isLast = i === keys.length - 1;
      const isDir = Object.keys(node[key]).length > 0;
      lines.push(prefix + (isLast ? "└── " : "├── ") + key + (isDir ? "/" : ""));
      render(node[key], prefix + (isLast ? "    " : "│   "));
    });
  }
  render(root, "");

  const escaped = lines
    .join("\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return (
    "## File Tree\n\n" +
    '<pre class="file-tree-block">' +
    escaped +
    "</pre>\n"
  );
}

var AGENT_TITLES = {
  claude:   "CLAUDE.md",
  codex:    "AGENTS.md",
  copilot:  "Copilot Instructions",
  cursor:   "Cursor Rules",
  windsurf: "AGENTS.md",
  opencode: "AGENTS.md",
  openclaw: "AGENTS.md",
  gemini:   "GEMINI.md",
  roocode:  "AGENTS.md",
  amp:      "AGENT.md",
  cline:    "Cline Rules",
  generic:  "AGENTS.md",
};

// ─── BUILD DOCUMENT HEADER ───────────────────────────────
// When smart update (changesOnly) is used, different files may have been
// analysed at different points with potentially different settings, so
// showing a single precision label in the header would be misleading.
// In that case we show "Smart Update" instead.
function buildHeader(config) {
  var docTitle = AGENT_TITLES[config.agentTarget] || "CLAUDE.md";
  var modelLine = "Model: `" + config.model + "`";

  var precisionLine;
  if (config.changesOnly) {
    // Smart update: precision label is omitted because the document
    // is assembled from a mix of cached and freshly-analysed results.
    precisionLine = "Smart Update";
  } else {
    // Normal full run — show precision label.
    // Map 'adaptive' to a human-friendly label.
    var p = config.precision || "standard";
    var precisionLabel =
      p === "adaptive" ? "Adaptive" :
      p === "fast"     ? "Fast" :
      p === "deep"     ? "Deep" :
                         "Standard";
    precisionLine = "Precision: **" + precisionLabel + "**";
  }

  return (
    "# " + docTitle + "\n" +
    "> Auto-generated by repoDNA · " + precisionLine + " · " + modelLine + "\n" +
    "> Generated: " + new Date().toISOString() + "\n"
  );
}

export function buildClaudeMd(results, config, fileList = [], projectRoot = "", treeFiles = null) {
  const cleanNone = (s) =>
    s.replace(/(\*\*[^*\n]+\*\*:)\s*\[none\]/gi, "$1 none");

  // Safety net for cached items from runs that predate the model-output
  // sanitizer: walk lines, balance fences, and close any open fence when a
  // **Field:** label appears (field labels can't be inside a code block).
  const balanceFences = (s) => {
    if (!s) return s;
    const ls = s.split(/\r?\n/);
    let inFence = false, fenceCh = "", fenceLen = 0;
    const out = [];
    for (const line of ls) {
      const fm = line.match(/^( {0,3})(`{3,}|~{3,})/);
      if (fm) {
        const fc = fm[2][0], fl = fm[2].length;
        if (!inFence) { inFence = true; fenceCh = fc; fenceLen = fl; }
        else if (fc === fenceCh && fl >= fenceLen) { inFence = false; }
        out.push(line);
        continue;
      }
      if (inFence && /^\*\*[^*\n]{1,40}:\*\*/.test(line)) {
        out.push(fenceCh === "~" ? "~~~" : "```");
        inFence = false; fenceCh = ""; fenceLen = 0;
      }
      out.push(line);
    }
    if (inFence) out.push(fenceCh === "~" ? "~~~" : "```");
    return out.join("\n");
  };

  const sanitizeItem = (s) => balanceFences(cleanNone(s));

  const section = (title, key) => {
    const items = results[key] || [];
    if (!items.length) return "";
    return `\n## ${title}\n\n${items.map(sanitizeItem).join("\n\n---\n\n")}\n`;
  };
  const desc = config.projectDescription || "No description provided.";
  const sections = Object.keys(CATEGORY_META)
    .map((k) => section(CATEGORY_META[k].title, k))
    .filter(Boolean)
    .join("");

  let depGraph = "";
  if (fileList.length && projectRoot) {
    try {
      const graph = buildDependencyGraph(fileList, projectRoot);
      depGraph = formatDependencyGraph(graph);
    } catch {}
  }

  let treeSection = "";
  const treeMode = config.fileTreeMode || "none";
  if (treeMode !== "none" && treeFiles && treeFiles.length) {
    treeSection = buildAsciiTreeMd(treeFiles);
  }

  return (
    buildHeader(config) +
    "\n---\n" +
    "\n## Project Overview\n\n " + desc + "\n\n" +
    "---\n" +
    (treeSection ? "\n" + treeSection + "\n---\n" : "") +
    (depGraph    ? "\n" + depGraph    + "\n---\n" : "") +
    " " + sections +
    "\n---\n" +
    "*Generated by [repoDNA](https://github.com/BogdanVasaiu/repodna)*\n"
  );
}
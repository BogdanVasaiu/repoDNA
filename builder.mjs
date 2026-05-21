import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";

const CATEGORY_META = {
  stores: { label: "🗄️ Stores", title: "Stores & State" },
  components_chat: { label: "💬 Chat", title: "Chat Components" },
  components_dashboards: {
    label: "📊 Dashboards",
    title: "Dashboard Components",
  },
  components_shared: { label: "🧩 Shared UI", title: "Shared Components" },
  components_widgets: { label: "🔧 Widgets", title: "Widget Components" },
  components_other: { label: "📦 Components", title: "Other Components" },
  composables: { label: "🪝 Composables", title: "Composables & Hooks" },
  plugins: { label: "⚙️ Plugins", title: "Plugins & Config" },
  router: { label: "🔀 Router", title: "Router & Routes" },
  services: { label: "🔌 Services", title: "Services & API" },
  layouts: { label: "🖼️ Layouts", title: "Layouts & Pages" },
  styles: { label: "🎨 Styles", title: "Styles & CSS" },
  utils: { label: "🛠️ Utils", title: "Utilities & Helpers" },
  types: { label: "📐 Types", title: "TypeScript Types" },
  tests: { label: "🧪 Tests", title: "Tests" },
  scripts: { label: "📜 Scripts", title: "Scripts" },
  assets: { label: "🖼️ Assets", title: "Assets" },
  other: { label: "📄 Other", title: "Other Files" },
};

export function categorize(rel) {
  const r = rel.replace(/\\/g, "/");
  // Images, fonts, audio and video assets get their own section regardless of folder name
  if (/\.(svg|png|jpg|jpeg|gif|webp|ico|bmp|tiff|avif|heic|heif|raw|woff2?|ttf|eot|otf|mp4|avi|mov|mkv|webm|mp3|wav|ogg|flac|aac|m4a|opus|aiff)$/i.test(r)) return "assets";
  if (/\/(stores?|redux|zustand|mobx|jotai|recoil)\//.test(r)) return "stores";
  if (/\/components\/chat/.test(r)) return "components_chat";
  if (/\/components\/(dashboard|admin)/.test(r)) return "components_dashboards";
  if (/\/components\/(shared|common|ui|base)/.test(r))
    return "components_shared";
  if (/\/components\/widget/.test(r)) return "components_widgets";
  if (/\/components\//.test(r)) return "components_other";
  if (/\/(composables|hooks)\//.test(r)) return "composables";
  if (/\/(plugins|lib|config)\//.test(r)) return "plugins";
  if (/\/(router|routes|routing)\//.test(r)) return "router";
  if (/\/(services|api|client|requests)\//.test(r)) return "services";
  if (/\/(layouts|templates|pages|views)\//.test(r)) return "layouts";
  if (/\/(scss|styles?|css)\//.test(r) || /\.(scss|css|less|sass)$/.test(r))
    return "styles";
  if (/\/(utils|helpers|shared|common)\//.test(r)) return "utils";
  if (/\/(types|interfaces)\//.test(r) || r.endsWith(".d.ts")) return "types";
  if (
    /\/(tests?|__tests__|spec)\//.test(r) ||
    /\.(spec|test)\.[tj]sx?$/.test(r)
  )
    return "tests";
  if (/\/scripts\//.test(r) || /\.(sh|bash|zsh|ps1)$/.test(r)) return "scripts";
  return "other";
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

  const section = (title, key) => {
    const items = results[key] || [];
    if (!items.length) return "";
    return `\n## ${title}\n\n${items.map(cleanNone).join("\n\n---\n\n")}\n`;
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
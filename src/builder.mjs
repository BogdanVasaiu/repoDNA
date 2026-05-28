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
  "rb",                                              // Ruby
  "php",                                             // PHP
  "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx",  // C / C++
  "dart",                                            // Dart / Flutter
  "gd",                                              // GDScript / Godot
  "java",                                            // Java
  "kt", "kts",                                       // Kotlin
  "scala", "sc",                                     // Scala
  "cs", "csx",                                       // C# / .NET / Unity
  "ex", "exs",                                       // Elixir
]);
const JS_EXTS = new Set([
  "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx", "vue", "svelte",
]);
const C_EXTS = new Set([
  "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx",
]);
// Languages where modules/namespaces are declared inside the file (not by
// file path). For these we do a project-wide discovery pass to learn which
// symbols are internal, then filter imports against that set.
const PKG_EXTS = new Set([
  "java", "kt", "kts", "scala", "sc", "cs", "csx", "ex", "exs",
]);

// Project-level info that's cheap to compute once and reuse across files.
// Reset whenever the projectRoot changes (rare — once per run).
let _projectInfo = { root: null, tsAliases: null, goModule: null, dartPackage: null };

function getProjectInfo(projectRoot) {
  if (_projectInfo.root === projectRoot) return _projectInfo;
  const info = { root: projectRoot, tsAliases: null, goModule: null, dartPackage: null };

  // tsconfig.json / jsconfig.json — read compilerOptions.paths for alias map.
  // Falls back to a sensible default ("@/*" → "src/*") if neither config has
  // paths defined, since that's near-universal in Vite/Vue/Next projects.
  let aliasMap = null;
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const p = join(projectRoot, name);
    if (!existsSync(p)) continue;
    try {
      // tsconfig.json often has comments / trailing commas — strip both.
      const raw = readFileSync(p, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/,(\s*[}\]])/g, "$1");
      const cfg = JSON.parse(raw);
      const baseUrl = (cfg.compilerOptions && cfg.compilerOptions.baseUrl) || ".";
      const paths = (cfg.compilerOptions && cfg.compilerOptions.paths) || {};
      if (Object.keys(paths).length) {
        aliasMap = { baseUrl, paths };
        break;
      }
    } catch {}
  }
  if (!aliasMap && existsSync(join(projectRoot, "src"))) {
    aliasMap = { baseUrl: ".", paths: { "@/*": ["src/*"] } };
  }
  info.tsAliases = aliasMap;

  // go.mod — extract the module path so we can spot internal Go imports.
  const goMod = join(projectRoot, "go.mod");
  if (existsSync(goMod)) {
    try {
      const m = readFileSync(goMod, "utf-8").match(/^module\s+(\S+)/m);
      if (m) info.goModule = m[1];
    } catch {}
  }

  // pubspec.yaml — Dart/Flutter package name. Lets us classify
  // `package:<name>/...` imports as internal vs external.
  const pubspec = join(projectRoot, "pubspec.yaml");
  if (existsSync(pubspec)) {
    try {
      const m = readFileSync(pubspec, "utf-8").match(/^name:\s*(\S+)/m);
      if (m) info.dartPackage = m[1];
    } catch {}
  }

  _projectInfo = info;
  return info;
}

// Convert an absolute path under projectRoot into a "./..." spec relative to
// the importing file's directory. Returns null if outside the project.
function toRelativeSpec(absTarget, fromFileAbs, projectRoot) {
  const rootAbs = projectRoot.replace(/\\/g, "/");
  const targetNorm = absTarget.replace(/\\/g, "/");
  if (!targetNorm.startsWith(rootAbs)) return null;
  let r = relPath(dirname(fromFileAbs), absTarget).replace(/\\/g, "/");
  if (!r.startsWith(".")) r = "./" + r;
  return r;
}

// Resolve a TS/JS alias spec like "@/stores/foo" to an absolute path under
// projectRoot, using the alias map from tsconfig/jsconfig (or the default).
function resolveTsAlias(spec, projectInfo) {
  if (!projectInfo.tsAliases) return null;
  const { baseUrl, paths } = projectInfo.tsAliases;
  for (const pattern of Object.keys(paths)) {
    const target = paths[pattern][0]; // first candidate
    if (!target) continue;
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (spec === prefix || spec.startsWith(prefix + "/")) {
        const rest = spec === prefix ? "" : spec.slice(prefix.length + 1);
        const tgt = target.endsWith("/*") ? target.slice(0, -2) : target;
        return join(projectInfo.root, baseUrl, tgt, rest);
      }
    } else if (spec === pattern) {
      return join(projectInfo.root, baseUrl, target);
    }
  }
  return null;
}

function parseImports(filePath, projectRoot) {
  const ext = extname(filePath).toLowerCase().replace(/^\./, "");
  if (!SOURCE_EXTS.has(ext)) return [];

  let src;
  try {
    src = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const info = getProjectInfo(projectRoot);
  const found = new Set();

  // ─── JS / TS / JSX / TSX / Vue / Svelte ────────────────
  if (JS_EXTS.has(ext)) {
    // Strip block + line comments so example imports inside JSDoc or `//`
    // notes don't get matched as real edges. The `(?<=^|\s)` guard on `//`
    // skips URL schemes like `https://`, which have no whitespace before
    // the `//`. Same approach as the C/Rust/Java branches below.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    const add = (spec) => {
      if (!spec) return;
      if (spec.startsWith(".")) {
        found.add(spec);
        return;
      }
      // Non-relative spec — try alias resolution.
      const abs = resolveTsAlias(spec, info);
      if (abs) {
        const r = toRelativeSpec(abs, filePath, projectRoot);
        if (r) found.add(r);
      }
    };
    // Static import + re-export: `import X from "...";` / `export … from "...";`
    const esRe = /(?:import|export)\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/g;
    // Side-effect import: `import "...";`
    const sideRe = /(?:^|\s)import\s+['"]([^'"]+)['"]/g;
    // Dynamic import: `import("...")`
    const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    // CommonJS: `require("...")`
    const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    for (const re of [esRe, sideRe, dynRe, reqRe]) {
      while ((m = re.exec(stripped)) !== null) add(m[1]);
    }
    return [...found];
  }

  // ─── Python ────────────────────────────────────────────
  if (ext === "py") {
    // Relative: `from .x import …` / `import .x` / `from .. import …`
    const re = /^(?:from|import)\s+(\.[\w.]*)/gm;
    let m;
    while ((m = re.exec(src)) !== null) found.add(m[1]);
    return [...found];
  }

  // ─── Go ────────────────────────────────────────────────
  if (ext === "go") {
    const mod = info.goModule;
    if (!mod) return []; // no go.mod → can't distinguish internal vs external
    // Strip comments so example imports inside `//` or `/* */` docs don't
    // leak through. The URL guard on `//` mirrors the JS branch above.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    const addGo = (spec) => {
      if (spec === mod) {
        found.add(".");
      } else if (spec.startsWith(mod + "/")) {
        found.add("./" + spec.slice(mod.length + 1));
      }
    };
    // Block: `import ( "a"\n alias "b" )`
    const blockRe = /\bimport\s*\(([\s\S]*?)\)/g;
    let bm;
    while ((bm = blockRe.exec(stripped)) !== null) {
      const itemRe = /(?:\.|_|\w+\s+)?"([^"]+)"/g;
      let im;
      while ((im = itemRe.exec(bm[1])) !== null) addGo(im[1]);
    }
    // Single: `import "a"` / `import alias "a"`
    const singleRe = /\bimport\s+(?:\.|_|\w+\s+)?"([^"]+)"/g;
    let sm;
    while ((sm = singleRe.exec(stripped)) !== null) addGo(sm[1]);
    return [...found];
  }

  // ─── Ruby ──────────────────────────────────────────────
  if (ext === "rb") {
    // `require_relative './foo'` — always internal, path may be bare ("foo").
    const rrRe = /\brequire_relative\s+["']([^"']+)["']/g;
    let m;
    while ((m = rrRe.exec(src)) !== null) {
      const s = m[1];
      found.add(s.startsWith(".") ? s : "./" + s);
    }
    // `require './foo'` — only treat as internal if path is explicitly relative.
    // Plain `require 'gem'` is an external gem; we can't distinguish without
    // a Gemfile/load-path walk, so skip.
    const reqRe = /\brequire\s+["'](\.[^"']+)["']/g;
    while ((m = reqRe.exec(src)) !== null) found.add(m[1]);
    return [...found];
  }

  // ─── PHP ───────────────────────────────────────────────
  if (ext === "php") {
    // `require '…'`, `require_once '…'`, `include '…'`, `include_once '…'`
    // — keep paths that are clearly file-relative. `__DIR__ . '/x.php'`
    // concatenations aren't single string literals, so we miss those.
    // Strip `/* */` and `//` comments first to avoid matching examples
    // inside PHPDoc. The URL guard mirrors the JS branch above. (PHP
    // also supports `#` comments, but those occur inside string
    // interpolation contexts that need string-aware handling — left
    // alone to stay safe.)
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    const re = /\b(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const s = m[1];
      if (s.startsWith(".") || /^[\w][\w./-]*\.(php|inc)$/i.test(s)) {
        found.add(s.startsWith(".") ? s : "./" + s);
      }
    }
    return [...found];
  }

  // ─── C / C++ / Objective-C headers ─────────────────────
  if (C_EXTS.has(ext)) {
    // Strip comments so `// #include "x.h"` doesn't pollute the graph.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // `#include "foo.h"` — quoted form = project-local convention.
    // `#include <foo.h>` — system/external; skip.
    const re = /^\s*#\s*include\s*"([^"]+)"/gm;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const s = m[1];
      found.add(s.startsWith(".") ? s : "./" + s);
    }
    return [...found];
  }

  // ─── Dart / Flutter ────────────────────────────────────
  if (ext === "dart") {
    // The line-anchored regex already filters `// import '...'`, but a
    // block comment can put an `import` statement at start-of-line —
    // strip those before matching. URL guard on `//` mirrors JS.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    const re = /^\s*(?:import|export|part)\s+["']([^"']+)["']/gm;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const s = m[1];
      if (s.startsWith("dart:")) continue;          // dart core libs
      if (s.startsWith("package:")) {
        const after = s.slice("package:".length);
        const slash = after.indexOf("/");
        if (slash === -1) continue;
        const pkg = after.slice(0, slash);
        if (info.dartPackage && pkg === info.dartPackage) {
          // Internal package import — Dart packages live under `lib/`.
          const abs = join(projectRoot, "lib", after.slice(slash + 1));
          const r = toRelativeSpec(abs, filePath, projectRoot);
          if (r) found.add(r);
        }
        // External package → drop
      } else {
        // Plain relative path: `import 'foo.dart'` / `import '../bar.dart'`
        found.add(s.startsWith(".") ? s : "./" + s);
      }
    }
    return [...found];
  }

  // ─── GDScript / Godot ──────────────────────────────────
  if (ext === "gd") {
    // `preload("res://path/to/scene.gd")` and `load("res://...")` — paths are
    // always rooted at the project (`res://`). Convert to file-relative for
    // consistency with the rest of the graph.
    const re = /\b(?:preload|load)\s*\(\s*["']res:\/\/([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const abs = join(projectRoot, m[1]);
      const r = toRelativeSpec(abs, filePath, projectRoot);
      if (r) found.add(r);
    }
    return [...found];
  }

  // ─── Rust ──────────────────────────────────────────────
  if (ext === "rs") {
    // Drop line comments and block comments so `use foo;` inside them
    // doesn't pollute the graph.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // Match `use crate::foo::…;`, `use super::…;`, `use self::…;`. The body
    // can span lines with `{ a, b::{c, d} }`; we only need the leading path.
    const useRe = /\buse\s+((?:crate|super|self))(::[\w:]+)?/g;
    let m;
    while ((m = useRe.exec(stripped)) !== null) {
      const tail = (m[2] || "").replace(/::/g, "/");
      found.add("./" + m[1] + tail);
    }
    // `mod foo;` declarations are also internal edges.
    const modRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm;
    while ((m = modRe.exec(stripped)) !== null) {
      found.add("./" + m[1]);
    }
    return [...found];
  }

  // ─── Java / Kotlin / Scala ─────────────────────────────
  // Imports point at a fully-qualified class/object: `com.foo.bar.Baz`.
  // The project's discovery pass populated `info.internalSymbols` with
  // every package declared inside the project (`com.foo.bar`). An import
  // is internal when its containing package is in that set.
  if (ext === "java" || ext === "kt" || ext === "kts" ||
      ext === "scala" || ext === "sc") {
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const re = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;?\s*$/gm;
    const internal = info.internalSymbols || new Set();
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const imp = m[1].replace(/\.\*$/, "");
      // Walk back from full path to root, looking for a known package.
      const segs = imp.split(".");
      let hit = false;
      for (let i = segs.length - 1; i >= 1; i--) {
        const prefix = segs.slice(0, i).join(".");
        if (internal.has(prefix)) {
          found.add(imp);
          hit = true;
          break;
        }
      }
      if (!hit && internal.has(imp)) found.add(imp);
    }
    return [...found];
  }

  // ─── C# (.NET / Unity) ─────────────────────────────────
  // `using Foo.Bar;` references a namespace. Match against namespaces
  // discovered in this project.
  if (ext === "cs" || ext === "csx") {
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // Skip `using static …`, `using alias = …` for simplicity — keep plain
    // `using Foo.Bar;`.
    const re = /^\s*using\s+([\w.]+)\s*;\s*$/gm;
    const internal = info.internalSymbols || new Set();
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const ns = m[1];
      // Exact match OR ancestor match (importing a sub-namespace).
      if (internal.has(ns)) {
        found.add(ns);
        continue;
      }
      // Or an ancestor — e.g. project declares `MyApp.Services.Auth`,
      // a file uses `using MyApp.Services;` to access the parent.
      for (const sym of internal) {
        if (sym === ns || sym.startsWith(ns + ".")) {
          found.add(ns);
          break;
        }
      }
    }
    return [...found];
  }

  // ─── Elixir ────────────────────────────────────────────
  // `alias MyApp.Foo`, `import MyApp.Foo`, `use MyApp.Foo`, `require ...`
  // — all reference module names directly.
  if (ext === "ex" || ext === "exs") {
    const stripped = src.replace(/#[^\n]*/g, "");
    const re = /\b(?:alias|import|require|use)\s+([A-Z][\w.]*)/g;
    const internal = info.internalSymbols || new Set();
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const mod = m[1];
      if (internal.has(mod)) {
        found.add(mod);
      } else {
        // Check if it's a sub-module of an internal one
        for (const sym of internal) {
          if (mod.startsWith(sym + ".") || sym.startsWith(mod + ".")) {
            found.add(mod);
            break;
          }
        }
      }
    }
    return [...found];
  }

  return [...found];
}

// Walk the file list once to collect every package/namespace/module declared
// inside the project. The per-file parser uses this set to distinguish
// internal imports (the only edges we care about) from external libraries
// in languages where the file extension alone doesn't tell us.
function discoverInternalSymbols(fileList, projectRoot) {
  const symbols = new Set();
  for (const rel of fileList) {
    const ext = extname(rel).toLowerCase().replace(/^\./, "");
    if (!PKG_EXTS.has(ext)) continue;
    let src;
    try {
      src = readFileSync(join(projectRoot, rel), "utf-8");
    } catch {
      continue;
    }
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/#[^\n]*/g, "");

    if (ext === "java" || ext === "kt" || ext === "kts" ||
        ext === "scala" || ext === "sc") {
      // One `package com.foo.bar;` (Java/Scala use `;`, Kotlin doesn't).
      const m = stripped.match(/^\s*package\s+([\w.]+)\s*;?\s*$/m);
      if (m) symbols.add(m[1]);
    } else if (ext === "cs" || ext === "csx") {
      // Both block (`namespace Foo {`) and file-scoped (`namespace Foo;`).
      const re = /\bnamespace\s+([\w.]+)\s*[;{]/g;
      let m;
      while ((m = re.exec(stripped)) !== null) symbols.add(m[1]);
    } else if (ext === "ex" || ext === "exs") {
      // `defmodule MyApp.Foo do`
      const re = /\bdefmodule\s+([A-Z][\w.]*)\s+do\b/g;
      let m;
      while ((m = re.exec(stripped)) !== null) symbols.add(m[1]);
    }
  }
  return symbols;
}

export function buildDependencyGraph(fileList, projectRoot) {
  // Populate the per-project info cache (tsconfig aliases, go module,
  // dart package) and run the discovery pass for module-declaration
  // languages. Done once, reused for every file.
  const info = getProjectInfo(projectRoot);
  info.internalSymbols = discoverInternalSymbols(fileList, projectRoot);

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
  // includeDepGraph defaults to true to preserve historical behavior. Explicit
  // `false` in the config (from the Advanced Options toggle) suppresses the
  // section entirely.
  if (config.includeDepGraph !== false && fileList.length && projectRoot) {
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
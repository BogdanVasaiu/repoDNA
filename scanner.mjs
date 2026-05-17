import { readdirSync, statSync, lstatSync } from "fs";
import { join, extname } from "path";
import {
  classifyNode,
  assignCategory,
  detectProjectType,
  computeEffectiveRules,
  computeFinalStatus,
} from "./classifier.mjs";

const MAX_DEPTH = 20;
const MAX_FILES = 50000;

export function scanProject(
  rootPath,
  customRules = {},
  globalExclusions = {},
  globalInclusions = {},
) {
  const nodes = [];
  const rootFiles = [];
  let fileCount = 0;
  let timedOut = false;

  // Get root files for project type detection
  try {
    const entries = readdirSync(rootPath);
    for (const e of entries) {
      rootFiles.push(e);
    }
  } catch {}

  const projectType = detectProjectType(rootFiles);
  const rules = computeEffectiveRules(
    customRules,
    globalExclusions,
    globalInclusions,
  );
  const excludedFolders = rules.excludedFolders;

  function walk(dir, depth, parentPath) {
    if (depth > MAX_DEPTH) return;
    if (fileCount > MAX_FILES) {
      timedOut = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (fileCount > MAX_FILES) {
        timedOut = true;
        return;
      }
      const full = join(dir, entry);
      let lstat, stat;
      try {
        lstat = lstatSync(full);
      } catch {
        continue;
      }
      const isSymlink = lstat.isSymbolicLink();
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      const relPath = parentPath ? parentPath + "/" + entry : entry;
      const isHidden = entry.startsWith(".");
      const ext = extname(entry).toLowerCase().replace(/^\./, "");

      if (stat.isDirectory()) {
        const node = {
          id: relPath,
          name: entry,
          type: "directory",
          extension: null,
          size: 0,
          depth: depth,
          isHidden: isHidden,
          isSymlink: isSymlink,
          autoStatus: "included",
          autoExcludeReason: null,
          userOverride: null,
          finalStatus: "included",
          categoryId: null,
          children: [],
        };
        const cls = classifyNode(node, projectType, rules);
        node.autoStatus = cls.autoStatus;
        node.autoExcludeReason = cls.autoExcludeReason;
        node.finalStatus = computeFinalStatus(node);

        if (
          cls.autoStatus === "excluded" &&
          excludedFolders.has(entry.toLowerCase())
        ) {
          nodes.push(node);
          fileCount++;
          continue;
        }

        walk(full, depth + 1, relPath);
        nodes.push(node);
        fileCount++;
      } else {
        const node = {
          id: relPath,
          name: entry,
          type: "file",
          extension: ext || null,
          size: stat.size,
          depth: depth,
          isHidden: isHidden,
          isSymlink: isSymlink,
          autoStatus: "included",
          autoExcludeReason: null,
          userOverride: null,
          finalStatus: "included",
          categoryId: null,
          children: [],
        };
        if (isSymlink) {
          node.autoStatus = "excluded";
          node.autoExcludeReason = "Symlink — potrebbe causare loop";
        } else {
          const cls = classifyNode(node, projectType, rules);
          node.autoStatus = cls.autoStatus;
          node.autoExcludeReason = cls.autoExcludeReason;
        }
        node.categoryId = assignCategory(node.extension);
        node.finalStatus = computeFinalStatus(node);
        nodes.push(node);
        fileCount++;
      }
    }
  }

  walk(rootPath, 0, "");

  const tree = buildTree(nodes);

  return {
    tree: tree,
    nodes: nodes,
    projectType: projectType,
    fileCount: fileCount,
    timedOut: timedOut,
  };
}

function buildTree(nodes) {
  const map = {};
  const roots = [];
  for (const n of nodes) {
    map[n.id] = { ...n, children: [] };
  }
  for (const n of nodes) {
    const parts = n.id.split("/");
    if (parts.length === 1) {
      roots.push(map[n.id]);
    } else {
      const parentId = parts.slice(0, -1).join("/");
      if (map[parentId]) {
        map[parentId].children.push(map[n.id]);
      }
    }
  }

  function calcDirStatus(node) {
    if (node.type !== "directory") return node.finalStatus;
    let hasIncluded = false;
    for (const child of node.children) {
      const cs = calcDirStatus(child);
      if (cs === "included") hasIncluded = true;
    }
    if (node.children.length === 0) return node.finalStatus;
    node.finalStatus = hasIncluded ? "included" : "excluded";
    return node.finalStatus;
  }
  function sortNode(node) {
    node.children.sort(function (a, b) {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of node.children) sortNode(child);
  }
  for (const r of roots) {
    sortNode(r);
    calcDirStatus(r);
  }

  return roots.sort(function (a, b) {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function scanProjectExtensions(rootPath) {
  const extCounts = {};
  const excludedFolders = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    "__pycache__",
    "vendor",
    ".cache",
    "coverage",
    "target",
  ]);

  function walk(dir, depth) {
    if (depth > 9) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (excludedFolders.has(entry.toLowerCase())) continue;
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else {
        const ext = extname(entry).toLowerCase();
        if (ext) {
          extCounts[ext] = (extCounts[ext] || 0) + 1;
        }
      }
    }
  }

  walk(rootPath, 0);
  return Object.entries(extCounts)
    .sort(function (a, b) {
      return b[1] - a[1];
    })
    .map(function (pair) {
      return { ext: pair[0], count: pair[1] };
    });
}

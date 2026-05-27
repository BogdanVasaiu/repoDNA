import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── ALL DATA lives in ~/.repodna ───────────────────────
// Global config (UI prefs, project list)
const GLOBAL_CONFIG_DIR = join(homedir(), ".repodna");
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, "config.json");

// Per-project data lives INSIDE the project folder under .repodna/
// (legacy: ~/.repodna/projects/<encoded-path>/ — kept for migration only)
const PROJECTS_DATA_DIR = join(GLOBAL_CONFIG_DIR, "projects");

const DEFAULT_CONFIG = {
  version: 2,
  projects: [],
  lastProjectPath: null,
  ui: {
    defaultTreeDepthExpanded: 2,
    showExcludedNodes: true,
    tokenWarningThreshold: 100000,
  },
  globalExclusions: { folders: [], extensions: [], fileNames: [] },
  globalInclusions: { folders: [], extensions: [], fileNames: [] },
};

function ensureGlobalDir() {
  if (!existsSync(GLOBAL_CONFIG_DIR))
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
}

// Encode a project path to a safe directory name
function encodeProjectPath(projectPath) {
  return Buffer.from(projectPath).toString("base64url").slice(0, 64);
}

// Returns ~/.repodna/projects/<encoded>/ and creates it if needed
function ensureProjectDataDir(projectPath) {
  const dir = join(PROJECTS_DATA_DIR, encodeProjectPath(projectPath));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig() {
  try {
    ensureGlobalDir();
    if (existsSync(GLOBAL_CONFIG_FILE)) {
      const saved = JSON.parse(readFileSync(GLOBAL_CONFIG_FILE, "utf-8"));
      // Migrate v1 format
      if (saved.version === undefined || saved.version < 2) {
        if (saved.lastConfig && !saved.projects) saved.projects = [];
        saved.version = 2;
        saved.projects = saved.projects || [];
        saved.globalExclusions =
          saved.globalExclusions || DEFAULT_CONFIG.globalExclusions;
        saved.globalInclusions =
          saved.globalInclusions || DEFAULT_CONFIG.globalInclusions;
        saveConfig(saved);
      }
      return { ...DEFAULT_CONFIG, ...saved };
    }
  } catch {}
  return { ...DEFAULT_CONFIG, projects: [] };
}

export function saveConfig(cfg) {
  try {
    ensureGlobalDir();
    writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch {}
}

export function getProjectList() {
  return loadConfig().projects || [];
}

export function addProject(
  projectPath,
  projectType = "UNKNOWN",
  description = "",
) {
  const cfg = loadConfig();
  const idx = cfg.projects.findIndex((p) => p.projectPath === projectPath);
  const entry = {
    projectPath,
    projectType,
    description,
    lastUsed: new Date().toISOString(),
    ollamaHost: "http://localhost:11434",
    model: "",
    precision: "standard",
    changesOnly: true,
    fileTreeMode: "all",
    agentTarget: "claude",
    lastOutputFile: "",
    customRules: {
      excludedFolders: [],
      excludedExtensions: [],
      excludedFilenames: [],
      includedFolders: [],
      includedExtensions: [],
      includedFilenames: [],
      removedDefaultExcludedFolders: [],
      removedDefaultExcludedExtensions: [],
      removedDefaultExcludedFilenames: [],
      removedDefaultIncludedFolders: [],
      removedDefaultIncludedExtensions: [],
      removedDefaultIncludedFilenames: [],
    },
  };
  if (idx >= 0) {
    entry.customRules = cfg.projects[idx].customRules || entry.customRules;
    entry.model = cfg.projects[idx].model || entry.model;
    entry.precision = cfg.projects[idx].precision || entry.precision;
    entry.changesOnly = cfg.projects[idx].changesOnly !== undefined ? cfg.projects[idx].changesOnly : true;
    entry.fileTreeMode = cfg.projects[idx].fileTreeMode || "all";
    entry.ollamaHost = cfg.projects[idx].ollamaHost || entry.ollamaHost;
    entry.agentTarget = cfg.projects[idx].agentTarget || "claude";
    entry.lastOutputFile = cfg.projects[idx].lastOutputFile || "";
    entry.userOverrides = cfg.projects[idx].userOverrides || [];
    entry.includeDepGraph = cfg.projects[idx].includeDepGraph !== undefined ? cfg.projects[idx].includeDepGraph : true;
    cfg.projects[idx] = entry;
  } else {
    cfg.projects.push(entry);
  }
  cfg.lastProjectPath = projectPath;
  saveConfig(cfg);

  // Ensure per-project data dir exists inside ~/.repodna/projects/
  ensureProjectDataDir(projectPath);

  return entry;
}

export function removeProject(projectPath) {
  const cfg = loadConfig();
  cfg.projects = cfg.projects.filter((p) => p.projectPath !== projectPath);
  if (cfg.lastProjectPath === projectPath) cfg.lastProjectPath = null;
  // Clear lastConfig so the deleted project isn't restored on next reload
  if (cfg.lastConfig && cfg.lastConfig.projectPath === projectPath) {
    cfg.lastConfig = {};
  }
  saveConfig(cfg);
  try {
    const projectDataDir = join(
      PROJECTS_DATA_DIR,
      encodeProjectPath(projectPath),
    );
    const hashFile = join(projectDataDir, "hashes.json");
    if (existsSync(hashFile)) unlinkSync(hashFile);
    const resultsFile = join(projectDataDir, "results.json");
    if (existsSync(resultsFile)) unlinkSync(resultsFile);
    const newFilesFile = join(projectDataDir, "new-files.json");
    if (existsSync(newFilesFile)) unlinkSync(newFilesFile);
    // Remove the now-empty project directory itself
    if (existsSync(projectDataDir)) rmdirSync(projectDataDir);
  } catch {}
}

export function updateProjectSettings(projectPath, settings) {
  const cfg = loadConfig();
  const proj = cfg.projects.find((p) => p.projectPath === projectPath);
  if (!proj) return;
  Object.assign(proj, settings, { lastUsed: new Date().toISOString() });
  saveConfig(cfg);
}

export function getProject(projectPath) {
  return (
    loadConfig().projects.find((p) => p.projectPath === projectPath) || null
  );
}

// Returns the path to the hashes file stored centrally in ~/.repodna/projects/<encoded>/hashes.json
// No data is ever written inside the user's project directory (only the agent context file is).
export function hashCachePath(projectPath) {
  const dir = ensureProjectDataDir(projectPath);
  return join(dir, "hashes.json");
}

export function resultCachePath(projectPath) {
  const dir = ensureProjectDataDir(projectPath);
  return join(dir, "results.json");
}

export function newFilesCachePath(projectPath) {
  const dir = ensureProjectDataDir(projectPath);
  return join(dir, "new-files.json");
}

export function modelStatsCachePath() {
  ensureGlobalDir();
  return join(GLOBAL_CONFIG_DIR, "model_stats.json");
}
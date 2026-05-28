import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { join, dirname, resolve, extname } from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { createHash } from "crypto";
import { homedir } from "os";
import { execSync, exec } from "child_process";

import {
  loadConfig,
  saveConfig,
  getProjectList,
  addProject,
  removeProject,
  updateProjectSettings,
  getProject,
  hashCachePath,
  resultCachePath,
  newFilesCachePath,
  modelStatsCachePath,
} from "./config.mjs";
import { scanProject, scanProjectExtensions } from "./scanner.mjs";
import {
  checkOllama,
  analyzeFileWithOllama,
  PRECISION_MODES,
} from "./ollama.mjs";
import { buildClaudeMd, categorize, buildDependencyGraph } from "./builder.mjs";
import { getDefaultRules } from "./classifier.mjs";
import { readCache, writeCache, recoverCacheFile } from "./cache.mjs";
import { DATA_SCHEMA } from "./migrations.mjs";
import { migrateStore, validateMigrationsChain } from "./store.mjs";

var GITHUB_REPO = "BogdanVasaiu/repodna";
var _lastModelsRefresh = 0;
var _serverStartId = String(Date.now());
var _updateCheckCache = null;

// ─── STARTUP MIGRATION STATE ──────────────────────────────
// Surfaced via /api/startup-status so the UI can show a blocking overlay
// while per-project caches are migrated/wiped after an update, and a
// one-time banner afterwards summarising what happened.
var startupState = {
  phase: "pending",            // pending | ready | error
  message: "Initializing…",
  progress: { current: 0, total: 0 },
  dataSchema: DATA_SCHEMA,     // current store schema
  events: [],                  // { kind: "migrated"|"wiped", from, to, backup }
  startedAt: 0,
  finishedAt: 0,
};
var AGENT_TARGETS_SERVER = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  copilot: ".github/copilot-instructions.md",
  cursor: ".cursorrules",
  windsurf: "AGENTS.md",
  opencode: "AGENTS.md",
  openclaw: "AGENTS.md",
  gemini: "GEMINI.md",
  roocode: "AGENTS.md",
  amp: "AGENT.md",
  cline: ".clinerules/context.md",
  generic: "AGENTS.md",
};

var __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname points at src/. Resources (public/, docs/, package.json,
// ollama_models.json, repodna-debug.log) live one level up at the repo root.
var ROOT_DIR = join(__dirname, "..");
var PUBLIC_DIR = join(ROOT_DIR, "public");
var DOCS_DIR = join(ROOT_DIR, "docs");
var PORT = 3741;
var pkg = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf-8"));
var REPO_NAME = "repoDNA";
var VERSION = pkg.version;

// ─── DEBUG MODE ───────────────────────────────────────────
var DEBUG_LOG_FILE = join(ROOT_DIR, "repodna-debug.log");

function debugMode() {
  return process.env.REPODNA_DEBUG === "1";
}

function debugLog(obj) {
  if (!debugMode()) return;
  var line =
    JSON.stringify(Object.assign({ ts: new Date().toISOString() }, obj)) + "\n";
  try {
    appendFileSync(DEBUG_LOG_FILE, line);
  } catch (e) {}
}

// ─── SSE STATE ────────────────────────────────────────────
var sseClients = [];
var appState = {
  phase: "wizard", // wizard | running | paused | done
  total: 0,
  done: 0,
  errors: 0,
  current: "",
  elapsed: 0,
  log: [], // ALL logs ever (for full replay)
  currentRunLogStart: 0, // index in log[] where current run starts
  results: {},
  resultEvents: [], // Store all result events for replay
  fileStatuses: {}, // file id -> { status: 'ok'|'error'|'running'|'deleted', content, error }
  runFileList: [], // full ordered list of files for current run (including pending + deleted)
  deletedFiles: [], // files removed from project since last run (for SSE replay)
  fileChangeTypes: {}, // fileId -> 'created'|'modified'|'readded'|'removed' (for SSE replay)
  previewContent: "", // Store current preview for replay
  previewFinal: false,
  config: null,
  sessionStartedAt: null,
  uiPage: 0, // Last wizard page — persisted across refresh
};

var scanCache = {};

// Tracks files fully processed by either the main loop or a retry,
// so the main loop can skip files already handled and the counter stays correct.
var completedFiles = new Set();

function push(event, data) {
  if (event === "progress" && typeof data.elapsed === "number") {
    appState.elapsed = data.elapsed;
  }
  var msg = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (var i = 0; i < sseClients.length; i++) {
    try {
      sseClients[i].write(msg);
    } catch (e) {}
  }
}

function log(type, text) {
  var entry = { type: type, text: text, ts: Date.now() };
  appState.log.push(entry);
  if (appState.log.length > 2000) appState.log.splice(0, 500);
  push("log", entry);
}

// ─── PAUSE SUPPORT ────────────────────────────────────────
var isPaused = false;
var pauseResolvers = [];

function waitIfPaused() {
  if (!isPaused) return Promise.resolve();
  return new Promise(function (resolve) {
    pauseResolvers.push(resolve);
  });
}

function resumeAll() {
  isPaused = false;
  var resolvers = pauseResolvers.slice();
  pauseResolvers = [];
  for (var i = 0; i < resolvers.length; i++) {
    resolvers[i]();
  }
}

// ─── FILE HASH ────────────────────────────────────────────
function fileHash(filePath) {
  try {
    return createHash("md5").update(readFileSync(filePath)).digest("hex");
  } catch (e) {
    return null;
  }
}

// ─── RUNNER ───────────────────────────────────────────────
var runnerAbortController = null;
var retryLock = false; // Signals the main loop to wait while any retry is running
var retryQueue = []; // File IDs queued for serial retry
var retryRunning = false; // Is the retry drain loop active?
var activeRetries = new Map(); // fileId -> AbortController for in-flight retries (per-file stop)
// catResultMaps: { category -> Map<fileId, content> }
// Using a Map per category gives O(1) dedup by fileId, eliminating all duplicate-entry bugs.
var catResultMaps = {};

function catMapsToResults(maps) {
  var out = {};
  for (var cat in maps) {
    out[cat] = [];
    maps[cat].forEach(function (content) {
      out[cat].push(content);
    });
  }
  return out;
}

function getResultFileIds(maps) {
  var ids = new Set();
  for (var cat in maps) {
    maps[cat].forEach(function (_, fileId) { ids.add(fileId); });
  }
  return Array.from(ids);
}

function upsertResult(cat, fileId, content) {
  if (!catResultMaps[cat]) catResultMaps[cat] = new Map();
  catResultMaps[cat].set(fileId, content);
  appState.results = catMapsToResults(catResultMaps);
}

function upsertResultEvent(cat, fileId, content, model, precision) {
  for (var i = 0; i < appState.resultEvents.length; i++) {
    if (appState.resultEvents[i].file === fileId) {
      appState.resultEvents[i] = {
        category: cat,
        file: fileId,
        content: content,
        model: model,
        precision: precision,
      };
      return;
    }
  }
  appState.resultEvents.push({ category: cat, file: fileId, content: content, model: model, precision: precision });
}

async function runAnalysis(config) {
  runnerAbortController = new AbortController();
  var signal = runnerAbortController.signal;
  isPaused = false;
  pauseResolvers = [];

  var outputRelFile = AGENT_TARGETS_SERVER[config.agentTarget] || "CLAUDE.md";
  var outputAbsPath = join(config.projectPath, outputRelFile);
  var outputAbsDir = dirname(outputAbsPath);

  // Clean up old output file if the agent target changed since last run
  var _prevProj = getProject(config.projectPath);
  var _prevOutputFile =
    _prevProj && _prevProj.lastOutputFile ? _prevProj.lastOutputFile : null;
  if (_prevOutputFile && _prevOutputFile !== outputRelFile) {
    var _prevOutputPath = join(config.projectPath, _prevOutputFile);
    try {
      if (existsSync(_prevOutputPath)) {
        unlinkSync(_prevOutputPath);
        log("info", "Removed previous context file: " + _prevOutputFile);
      }
    } catch (e) {
      log("warn", "Could not remove previous context file: " + e.message);
    }
  }

  appState.phase = "running";
  appState.done = 0;
  appState.errors = 0;
  appState.results = {};
  appState.resultEvents = [];
  appState.fileStatuses = {};
  appState.previewContent = "";
  appState.previewFinal = false;
  appState.sessionStartedAt = Date.now();
  appState.config = config;
  catResultMaps = {};
  retryLock = false;
  retryQueue = [];
  retryRunning = false;
  activeRetries.forEach(function (c) { try { c.abort(); } catch (_) {} });
  activeRetries.clear();
  appState.deletedFiles = [];
  appState.fileChangeTypes = {};
  completedFiles = new Set(); // Mark where this run's logs start
  appState.currentRunLogStart = appState.log.length;

  push("phase", { phase: "running" }); // Tell clients where the current-run log boundary is
  push("run_start", { logStart: appState.currentRunLogStart });
  log("info", "Starting analysis: " + config.projectPath);
  log("info", "Model: " + config.model + " | Precision: " + config.precision); // ── Hash cache

  var hashCacheFile = hashCachePath(config.projectPath);
  var resultCacheFileEarly = resultCachePath(config.projectPath);
  var newFilesCacheFileEarly = newFilesCachePath(config.projectPath);

  // Full run (Smart Update OFF) — wipe hash and result caches from disk immediately.
  // new-files.json is intentionally preserved: it tracks which files existed in the
  // previous scan so genuinely new files can still be detected and badged in the UI.
  // This guarantees that an interrupted run leaves a clean slate: the next
  // Smart Update ON run won't find stale hashes and silently skip files.
  if (!config.changesOnly) {
    try { if (existsSync(hashCacheFile)) unlinkSync(hashCacheFile); } catch {}
    try { if (existsSync(resultCacheFileEarly)) unlinkSync(resultCacheFileEarly); } catch {}
    log("info", "Full run — hash and result cache cleared");
  }

  var prevHashes = {};
  try {
    prevHashes = readCache(hashCacheFile, {}) || {};
    log(
      "info",
      "Hash cache: " + Object.keys(prevHashes).length + " previous entries",
    );
  } catch (e) {}

  var customRules = config.customRules || {};
  var globalExclusions = config.globalExclusions || {};
  var globalInclusions = config.globalInclusions || {};
  var scanResult = scanProject(
    config.projectPath,
    customRules,
    globalExclusions,
    globalInclusions,
  );
  var allNodes = scanResult.nodes.filter(function (n) {
    return n.type === "file";
  });

  var userOverrides = new Map(config.userOverrides || []);
  for (var ui = 0; ui < allNodes.length; ui++) {
    var node = allNodes[ui];
    if (userOverrides.has(node.id)) {
      node.userOverride = userOverrides.get(node.id);
      node.finalStatus = node.userOverride;
    }
  }

  var filesToProcess = allNodes.filter(function (n) {
    return n.finalStatus === "included";
  });
  filesToProcess = filesToProcess.filter(function (f) {
    return f.size < 600000;
  });

  function getTreeFiles() {
    var mode = config.fileTreeMode || "none";
    if (mode === "included") return filesToProcess.map(function(f) { return f.id; });
    if (mode === "all") return allNodes.filter(function(n) { return n.type === "file"; }).map(function(f) { return f.id; });
    return null;
  }
  var treeFiles = getTreeFiles();

  // All file IDs that exist on disk right now (excluded or included — doesn't matter).
  // Used to distinguish "actually deleted from filesystem" from "just unselected".
  var allNodeIds = new Set(allNodes.map(function (n) { return n.id; }));

  // ── Step-03 snapshot filter ──────────────────────────────────────────────────
  // The scan-tree endpoint now owns the new-files baseline (updated on every
  // step-03 entry). Files added to disk AFTER the last step-03 scan are not in
  // the snapshot and are excluded from this run — they will show as "new" the
  // next time the user opens step 03.
  var _newFilesCacheFile = newFilesCachePath(config.projectPath);
  var _step03Snapshot = loadNewFilesCache(_newFilesCacheFile);
  if (_step03Snapshot && _step03Snapshot.allFiles && _step03Snapshot.allFiles.length > 0) {
    var _snapshotSet = new Set(_step03Snapshot.allFiles);
    allNodes = allNodes.filter(function(n) { return _snapshotSet.has(n.id); });
  }

  var newHashes = {};
  for (var hi = 0; hi < filesToProcess.length; hi++) {
    var hf = filesToProcess[hi];
    var hFullPath = join(config.projectPath, hf.id);
    newHashes[hf.id] = fileHash(hFullPath);
  }

  // Hash cache to write at the end of this run:
  //   - included files  → current hash from newHashes
  //   - excluded files that still exist on disk → preserve prevHash (no re-analysis needed on re-include if unchanged)
  //   - files actually deleted from disk → omitted (their hash is gone)
  var hashesToSave = Object.assign({}, newHashes);
  var _prevHashKeys = Object.keys(prevHashes);
  for (var _phi = 0; _phi < _prevHashKeys.length; _phi++) {
    var _phid = _prevHashKeys[_phi];
    if (allNodeIds.has(_phid) && !hashesToSave[_phid]) {
      hashesToSave[_phid] = prevHashes[_phid]; // excluded but on disk — keep hash
    }
    // files NOT in allNodeIds are truly deleted → not added → hash dropped
  }

  // ── Load result cache before the filter so we can detect re-added files ──
  var resultCacheFile = resultCachePath(config.projectPath);
  var prevResults = config.changesOnly ? loadResultCache(resultCacheFile) : {};
  // _presentFiles records which files were in the previous run's scan.
  // If a file has a cached result but was NOT in prevPresentFiles, it was deleted
  // and re-added — we can serve it from cache without re-running Ollama.
  var prevPresentFiles = new Set(prevResults._presentFiles || []);
  var hasPresentMeta = prevResults._presentFiles !== undefined;

  // ── Smart update: classify every file and build processableFiles ──
  // fileChangeTypes: fileId -> 'created' | 'modified' | 'readded' | 'removed'
  // 'created'  = no previous hash (brand new file)
  // 'modified' = hash changed since last run
  // 'readded'  = result cached, hash matches, but was absent from last run's scan
  //              → show in UI, serve from cache, skip Ollama
  // 'removed'  = was in last run's results, no longer in the project
  var processableFiles = filesToProcess;
  var readdedFiles = []; // served from cache, shown in UI
  var deletedFiles = [];
  var deletedCount = 0;
  var fileChangeTypes = {}; // stored in appState for SSE replay

  if (config.changesOnly && Object.keys(prevHashes).length > 0) {
    var _prevResultIds = new Set(
      Object.keys(prevResults).filter(function (k) { return k !== "_presentFiles"; })
    );
    var _currentIds = new Set(filesToProcess.map(function (f) { return f.id; }));

    processableFiles = filesToProcess.filter(function (f) {
      var prevResultObj = prevResults[f.id];
      var hasPrevResult = _prevResultIds.has(f.id);
      // Use the hash stored inside the result cache entry (new format).
      // Fall back to prevHashes for caches written before this change.
      var prevFileHash = (prevResultObj && prevResultObj.hash !== undefined)
        ? prevResultObj.hash
        : prevHashes[f.id];
      var hasPrevHash = prevFileHash !== undefined;
      var hashChanged = newHashes[f.id] !== prevFileHash;
      // wasPresent: was this file in the previous scan?
      // If no _presentFiles meta (old cache), assume all result-having files were present.
      var wasPresent = hasPresentMeta ? prevPresentFiles.has(f.id) : hasPrevResult;

      if (!hasPrevHash) {
        fileChangeTypes[f.id] = "created";
        return true; // new file — analyze
      }
      if (hashChanged) {
        fileChangeTypes[f.id] = "modified";
        return true; // changed — analyze
      }
      // Hash matches from here
      if (hasPrevResult && !wasPresent) {
        // Result cached, hash unchanged, but file was absent last run → re-added
        // Serve from cache — no need to re-run Ollama
        fileChangeTypes[f.id] = "readded";
        readdedFiles.push(f.id);
        return false;
      }
      if (!hasPrevResult) {
        // No cached result (e.g. always-failed file) — analyze
        fileChangeTypes[f.id] = "created";
        return true;
      }
      return false; // truly unchanged — serve from cache silently
    });

    // Removed = was in the PREVIOUS SCAN and is no longer in the project.
    // Using prevPresentFiles (not all of _prevResultIds) prevents files deleted
    // in an earlier run from reappearing as "removed" in every subsequent run.
    // Fallback to _prevResultIds when there is no _presentFiles meta (old cache).
    var _removedSource = hasPresentMeta ? prevPresentFiles : _prevResultIds;
    deletedFiles = Array.from(_removedSource).filter(function (id) {
      return !_currentIds.has(id);
    });
    deletedCount = deletedFiles.length;
    for (var _dfi = 0; _dfi < deletedFiles.length; _dfi++) {
      fileChangeTypes[deletedFiles[_dfi]] = "removed";
    }

    var _smartParts = [];
    if (processableFiles.length > 0) _smartParts.push(processableFiles.length + " to process");
    if (readdedFiles.length > 0)     _smartParts.push(readdedFiles.length + " re-added from cache");
    var _unch = filesToProcess.length - processableFiles.length - readdedFiles.length;
    if (_unch > 0)       _smartParts.push(_unch + " unchanged");
    if (deletedCount > 0) _smartParts.push(deletedCount + " removed");
    if (_smartParts.length > 0) log("info", "Smart update: " + _smartParts.join(" · "));

  } else if (config.changesOnly && Object.keys(prevHashes).length === 0) {
    log("info", "Smart update enabled — no previous cache found, processing all files");
  }

  // Every file in the current run must carry a hash-based badge. Smart updates
  // populate them above; first runs and full rebuilds reach this point with an
  // empty fileChangeTypes. Treat anything still missing as "created" so the
  // retried/edited guard has something to protect.
  for (var _bfi = 0; _bfi < processableFiles.length; _bfi++) {
    if (!fileChangeTypes[processableFiles[_bfi].id]) {
      fileChangeTypes[processableFiles[_bfi].id] = "created";
    }
  }

  // ── Inject cached results for unchanged + re-added files ──
  if (config.changesOnly && Object.keys(prevResults).length > 0) {
    var currentFileIdSet = new Set(filesToProcess.map(function (f) { return f.id; }));
    var changedFileIdSet = new Set(processableFiles.map(function (f) { return f.id; }));
    var cachedIds = Object.keys(prevResults).filter(function (k) { return k !== "_presentFiles"; });
    for (var _ci = 0; _ci < cachedIds.length; _ci++) {
      var _cachedId = cachedIds[_ci];
      if (!currentFileIdSet.has(_cachedId)) continue; // removed — drop
      if (changedFileIdSet.has(_cachedId)) continue;  // will be re-analyzed
      var _cached = prevResults[_cachedId];
      upsertResult(_cached.category, _cachedId, _cached.content);
      upsertResultEvent(_cached.category, _cachedId, _cached.content, _cached.model, _cached.precision);
      push("result", { category: _cached.category, file: _cachedId, content: _cached.content, model: _cached.model, precision: _cached.precision });
    }
  }

  var presentFileIds = filesToProcess.map(function (f) { return f.id; });

  appState.total = processableFiles.length;
  appState.deletedFiles = deletedFiles;
  appState.fileChangeTypes = fileChangeTypes;
  appState.runFileList = processableFiles.map(function (f) { return f.id; })
    .concat(readdedFiles)
    .concat(deletedFiles);
  for (var _ri = 0; _ri < readdedFiles.length; _ri++) {
    appState.fileStatuses[readdedFiles[_ri]] = { status: "ok" };
  }
  for (var _di = 0; _di < deletedFiles.length; _di++) {
    appState.fileStatuses[deletedFiles[_di]] = { status: "deleted" };
  }
  push("file_list", { files: appState.runFileList, deletedSet: deletedFiles, changeTypes: fileChangeTypes });
  push("progress", {
    total: appState.total,
    done: 0,
    current: "",
    errors: 0,
    status: "running",
    elapsed: 0,
  });

  // Push an early preview before AI processing starts so the preview panel
  // immediately shows the project overview + file tree (if enabled) + any
  // cached results (smart update). On first run this gives the tree; on
  // subsequent smart-update runs it gives all previously-analyzed files.
  if (processableFiles.length > 0) {
    var _earlyMd = buildClaudeMd(appState.results, config, getResultFileIds(catResultMaps), config.projectPath, treeFiles);
    appState.previewContent = _earlyMd;
    push("preview", { content: _earlyMd, final: false });
  }

  log(
    "scan",
    "Found " +
      allNodes.length +
      " files - processing " +
      processableFiles.length,
  );

  if (processableFiles.length === 0) {
    if (appState.resultEvents.length > 0) {
      // Smart update with no new/modified files — rebuild from cached results.
      // Deletions are already handled above (dropped from currentFileIdSet).
      var _rebuildReason = deletedCount > 0
        ? deletedCount + " file" + (deletedCount > 1 ? "s" : "") + " deleted"
        : "No changed files";
      log("info", _rebuildReason + " — rebuilding " + outputRelFile + " from cached results.");
      var _finalMd = buildClaudeMd(
        appState.results,
        config,
        getResultFileIds(catResultMaps),
        config.projectPath,
        treeFiles
      );
      try {
        if (!existsSync(outputAbsDir))
          mkdirSync(outputAbsDir, { recursive: true });
        writeFileSync(outputAbsPath, _finalMd, "utf-8");
        log("success", outputRelFile + " saved (no changes detected)");
      } catch (e) {
        log("error", "Could not write " + outputRelFile + ": " + e.message);
      }
      appState.previewContent = _finalMd;
      appState.previewFinal = true;
      push("preview", { content: _finalMd, final: true });
      saveResultCache(resultCacheFile, appState.resultEvents, prevResults, presentFileIds, newHashes, allNodeIds);
    } else {
      log("warn", "No files to process.");
    }
    appState.phase = "done";
    push("phase", { phase: "done" });
    push("progress", {
      total: 0,
      done: 0,
      current: "",
      errors: 0,
      status: "done",
      elapsed: 0,
      deletedCount: deletedCount,
    });
    saveHashCache(hashCacheFile, hashesToSave);
    updateProjectSettings(config.projectPath, {
      lastOutputFile: outputRelFile,
      agentTarget: config.agentTarget,
    });
    return;
  }

  var startTime = Date.now();
  // ── Debug: init log for this run
  if (debugMode()) {
    try {
      writeFileSync(DEBUG_LOG_FILE, "");
    } catch (e) {} // clear on each run
    debugLog({
      event: "run_start",
      model: config.model,
      precision: config.precision,
      totalFiles: processableFiles.length,

    });
  }
  var allProcessedIds = filesToProcess.map(function (f) {
    return f.id;
  });

  for (var i = 0; i < processableFiles.length; i++) {
    if (signal.aborted) {
      log("warn", "Analysis stopped by user.");
      break;
    }

    if (isPaused) {
      log("info", "Paused...");
      await waitIfPaused();
      if (signal.aborted) break;
      log("info", "Resumed");
    } // Wait for any in-flight retry to finish before touching shared state

    while (retryLock)
      await new Promise(function (r) {
        setTimeout(r, 50);
      });

    var procFile = processableFiles[i]; // Skip files already handled by a retry (avoid double-processing and double-counting)

    if (completedFiles.has(procFile.id)) continue;

    var procFullPath = join(config.projectPath, procFile.id);
    appState.current = procFile.id;
    appState.fileStatuses[procFile.id] = { status: "running" };
    push("file_status", { file: procFile.id, status: "running" });

    var elapsedSoFar = Math.round((Date.now() - startTime) / 1000);
    push("progress", {
      total: appState.total,
      done: appState.done,
      current: procFile.id,
      errors: appState.errors,
      status: "running",
      elapsed: elapsedSoFar,
    });

    var fileStart = Date.now();
    debugLog({
      event: "file_start",
      file: procFile.id,
      size: procFile.size || 0,
    });

    try {
      var result = await analyzeFileWithOllama(
        procFullPath,
        config.projectPath,
        config,
        signal,
      );

      if (result.content) {
        var displayContent = result.content;
        var cat = categorize(procFile.id);
        upsertResult(cat, procFile.id, displayContent);
        appState.fileStatuses[procFile.id] = {
          status: "ok",
          content: displayContent,
          category: cat,
        };
        push("file_status", { file: procFile.id, status: "ok", tokensPerSecond: result.tokensPerSecond || null });
        var resultEvent = {
          category: cat,
          file: procFile.id,
          content: displayContent,
          model: config.model,
          precision: config.precision,
        };
        upsertResultEvent(cat, procFile.id, displayContent, config.model, config.precision);
        push("result", resultEvent);
        log("success", procFile.id);
      } else {
        var reason = result.error || "Unknown reason";
        appState.fileStatuses[procFile.id] = {
          status: "error",
          error: reason,
        };
        push("file_status", {
          file: procFile.id,
          status: "error",
          error: reason,
        });
        appState.errors++;
        log("warn", "EMPTY: " + procFile.id + " - " + reason);
      }
    } catch (e) {
      if (signal.aborted) break;
      appState.errors++;
      appState.fileStatuses[procFile.id] = {
        status: "error",
        error: e.message,
      };
      push("file_status", {
        file: procFile.id,
        status: "error",
        error: e.message,
      });
      log("error", "FAILED: " + procFile.id + " - " + e.message);
    }
    appState.done++;
    completedFiles.add(procFile.id);
    var fileElapsedSec = (Date.now() - fileStart) / 1000; // moved up: needed for EWMA
    var elapsed2 = Math.round((Date.now() - startTime) / 1000);

    push("progress", {
      total: appState.total,
      done: appState.done,
      current: procFile.id,
      errors: appState.errors,
      status: "running",
      elapsed: elapsed2,
    });

    debugLog({
      event: "file_done",
      file: procFile.id,
      size: procFile.size || 0,
      fileTimeSec: Math.round(fileElapsedSec * 10) / 10,
      done: appState.done,
      total: appState.total,
    });

    var currentMd = buildClaudeMd(appState.results, config, getResultFileIds(catResultMaps), config.projectPath, treeFiles);
    appState.previewContent = currentMd;
    appState.previewFinal = false;
    push("preview", { content: currentMd });
  }

  saveHashCache(hashCacheFile, hashesToSave);
  saveResultCache(resultCacheFile, appState.resultEvents, prevResults, presentFileIds, newHashes, allNodeIds);
  var finalMd = buildClaudeMd(
    appState.results,
    config,
    getResultFileIds(catResultMaps),
    config.projectPath,
    treeFiles
  );
  try {
    if (!existsSync(outputAbsDir)) mkdirSync(outputAbsDir, { recursive: true });
    writeFileSync(outputAbsPath, finalMd, "utf-8");
    log("success", outputRelFile + " saved");
  } catch (e) {
    log("error", "Could not write " + outputRelFile + ": " + e.message);
  }

  appState.previewContent = finalMd;
  appState.previewFinal = true;
  push("preview", { content: finalMd, final: true });

  appState.phase = "done";
  push("phase", { phase: "done" });
  var totalElapsed = Math.round((Date.now() - startTime) / 1000);
  push("progress", {
    total: appState.total,
    done: appState.done,
    current: "",
    errors: appState.errors,
    status: "done",
    elapsed: totalElapsed,
  });
  log(
    "success",
    "Done - " +
      appState.done +
      " files, " +
      appState.errors +
      " errors · " +
      outputRelFile +
      " saved",
  );

  debugLog({
    event: "run_end",
    totalFiles: appState.done,
    errors: appState.errors,
    totalSec: totalElapsed,
  });

  addProject(
    config.projectPath,
    scanResult.projectType,
    config.projectDescription || "",
  );
  updateProjectSettings(config.projectPath, {
    ollamaHost: config.ollamaHost,
    model: config.model,
    precision: config.precision,
    changesOnly: config.changesOnly,
    customRules: config.customRules,
    agentTarget: config.agentTarget,
    lastOutputFile: outputRelFile,
  });
}

// ─── RETRY SINGLE FILE ────────────────────────────────────

// Drain the retry queue one file at a time so concurrent retries never race
// each other or the main loop. An 800 ms gap between items gives rate-limited
// cloud endpoints room to breathe before the next request.
async function drainRetryQueue() {
  if (retryRunning) return;
  retryRunning = true;
  retryLock = true;
  while (retryQueue.length > 0) {
    if (runnerAbortController && runnerAbortController.signal.aborted) break;
    var _item = retryQueue.shift();
    await _executeRetry(_item.fileId, _item.precision);
    if (retryQueue.length > 0)
      await new Promise(function (r) { setTimeout(r, 800); });
  }
  retryRunning = false;
  retryLock = false;
}

// Public entry-point: enqueue fileId (deduplicated) and start the drain loop.
// Deduplicates against both the pending queue AND the currently-executing
// retry so rapid double-clicks can't kick off duplicate analyses for the
// same file.
function retryFile(fileId, precision) {
  if (activeRetries.has(fileId)) {
    return Promise.resolve({ ok: true, deduped: "active" });
  }
  if (retryQueue.some(function(r) { return r.fileId === fileId; })) {
    return Promise.resolve({ ok: true, deduped: "queued" });
  }
  retryQueue.push({ fileId: fileId, precision: precision || null });
  drainRetryQueue().catch(function (e) {
    log("error", "Retry queue crashed: " + e.message);
  });
  return Promise.resolve({ ok: true });
}

async function _executeRetry(fileId, precisionOverride) {
  if (!appState.config) {
    log("error", "Retry skipped: no active config");
    return;
  }
  var config = appState.config;
  var effectiveConfig = precisionOverride
    ? Object.assign({}, config, { precision: precisionOverride })
    : config;
  var filePath = join(config.projectPath, fileId);
  if (!existsSync(filePath)) {
    log("error", "Retry skipped: file not found: " + fileId);
    return;
  }

  // If this file wasn't part of the current run at all, add it so totals stay accurate
  if (!appState.runFileList.includes(fileId)) {
    appState.runFileList.push(fileId);
    appState.total++;
  }
  // If this file hasn't been counted yet (it was pending), count it now
  var isNewCompletion = !completedFiles.has(fileId);
  appState.fileStatuses[fileId] = { status: "running", retrying: true };
  push("file_status", { file: fileId, status: "running", retrying: true });
  var retryLabel = precisionOverride ? fileId + " [" + precisionOverride + "]" : fileId;
  log("info", "Retrying: " + retryLabel);

  // Per-file abort controller — enables a Stop button to halt just this file
  // without killing the whole run. Also forward the global runner abort.
  var perFileAbort = new AbortController();
  activeRetries.set(fileId, perFileAbort);
  var _onGlobalAbort = function () { perFileAbort.abort(); };
  var _globalSignal = runnerAbortController && runnerAbortController.signal;
  if (_globalSignal) _globalSignal.addEventListener("abort", _onGlobalAbort);
  var retrySignal = perFileAbort.signal;

  try {
    var result = await analyzeFileWithOllama(
      filePath,
      config.projectPath,
      effectiveConfig,
      retrySignal,
    );

    if (result.content) {
      var cat = categorize(fileId);
      appState.fileStatuses[fileId] = {
        status: "ok",
        content: result.content,
        category: cat,
      };
      // Only mark as "retried" if no hash-based change badge already covers it
      var _existingCT = appState.fileChangeTypes[fileId];
      var _hashBased = _existingCT === "created" || _existingCT === "modified" ||
                       _existingCT === "readded" || _existingCT === "removed";
      var _retryChangeType = null;
      if (!_hashBased) {
        appState.fileChangeTypes[fileId] = "retried";
        _retryChangeType = "retried";
      }
      push("file_status", { file: fileId, status: "ok", changeType: _retryChangeType, tokensPerSecond: result.tokensPerSecond || null });

      upsertResult(cat, fileId, result.content);
      upsertResultEvent(cat, fileId, result.content, config.model, effectiveConfig.precision);
      push("result", { category: cat, file: fileId, content: result.content, model: config.model, precision: effectiveConfig.precision }); // Mark as completed and update the counter if this is the first time

      completedFiles.add(fileId);
      if (isNewCompletion) {
        appState.done++;
        var startTime2 = appState.sessionStartedAt || Date.now();
        var elapsed3 = Math.round((Date.now() - startTime2) / 1000);
        push("progress", {
          total: appState.total,
          done: appState.done,
          current: fileId,
          errors: appState.errors,
          status: appState.phase,
          elapsed: elapsed3,
        });
      }

      log("success", "Retry OK: " + fileId);

      // Persist retry result to disk immediately.
      // The main run's saveResultCache may have already been called (post-run retry);
      // writing directly here ensures the result survives the next Smart Update ON run.
      try {
        var _retryCacheFile = resultCachePath(config.projectPath);
        var _retryCache = loadResultCache(_retryCacheFile);
        var _retryFileHash = fileHash(join(config.projectPath, fileId));
        if (_retryCache[fileId]) {
          _retryCache[fileId].content = result.content;
          _retryCache[fileId].hash = _retryFileHash;
          _retryCache[fileId].model = config.model;
          _retryCache[fileId].precision = effectiveConfig.precision;
        } else {
          _retryCache[fileId] = {
            category: cat,
            content: result.content,
            hash: _retryFileHash,
            model: config.model,
            precision: effectiveConfig.precision,
          };
        }
        writeFileSync(_retryCacheFile, JSON.stringify(_retryCache));

        // Rebuild output file from the full updated cache (same as update-result)
        var _retryRelFile = AGENT_TARGETS_SERVER[config.agentTarget] || "CLAUDE.md";
        var _retryAbsPath = join(config.projectPath, _retryRelFile);
        var _retryAbsDir = dirname(_retryAbsPath);
        var _retryMaps = {};
        for (var _rk in _retryCache) {
          if (_rk === "_presentFiles") continue;
          var _rEntry = _retryCache[_rk];
          if (!_rEntry || !_rEntry.category) continue;
          if (!_retryMaps[_rEntry.category]) _retryMaps[_rEntry.category] = new Map();
          _retryMaps[_rEntry.category].set(_rk, _rEntry.content);
        }
        var _retryMd = buildClaudeMd(catMapsToResults(_retryMaps), config, getResultFileIds(_retryMaps), config.projectPath, null);
        if (!existsSync(_retryAbsDir)) mkdirSync(_retryAbsDir, { recursive: true });
        writeFileSync(_retryAbsPath, _retryMd, "utf-8");
        appState.previewContent = _retryMd;
        appState.previewFinal = true;
        push("preview", { content: _retryMd, final: true });
      } catch (_retryPersistErr) {
        log("warn", "Could not persist retry to cache: " + _retryPersistErr.message);
        var md = buildClaudeMd(appState.results, config, getResultFileIds(catResultMaps), config.projectPath, null);
        appState.previewContent = md;
        push("preview", { content: md });
      }

      return { ok: true };
    } else {
      var reason = result.error || "Unknown reason";
      appState.fileStatuses[fileId] = { status: "error", error: reason };
      push("file_status", { file: fileId, status: "error", error: reason }); // Count it even on failure so the main loop skips it

      completedFiles.add(fileId);
      if (isNewCompletion) {
        appState.done++;
        appState.errors++;
        var startTime3 = appState.sessionStartedAt || Date.now();
        var elapsed4 = Math.round((Date.now() - startTime3) / 1000);
        push("progress", {
          total: appState.total,
          done: appState.done,
          current: fileId,
          errors: appState.errors,
          status: appState.phase,
          elapsed: elapsed4,
        });
      }

      log("warn", "Retry EMPTY: " + fileId + " - " + reason);
      return { ok: false, error: reason };
    }
  } catch (e) {
    var _globallyAborted = _globalSignal && _globalSignal.aborted;
    if (_globallyAborted) {
      // Whole run was aborted (e.g. user clicked global Stop) — drop silently.
      return;
    }
    if (perFileAbort.signal.aborted) {
      // User clicked Stop on just this file — surface a clear message so the
      // row's retry button reappears and the user knows it was cancelled.
      appState.fileStatuses[fileId] = { status: "error", error: "Stopped" };
      push("file_status", { file: fileId, status: "error", error: "Stopped" });
      log("warn", "Retry stopped: " + fileId);
      return;
    }
    appState.fileStatuses[fileId] = { status: "error", error: e.message };
    push("file_status", { file: fileId, status: "error", error: e.message }); // Count it even on exception so the main loop skips it

    completedFiles.add(fileId);
    if (isNewCompletion) {
      appState.done++;
      appState.errors++;
      var startTime4 = appState.sessionStartedAt || Date.now();
      var elapsed5 = Math.round((Date.now() - startTime4) / 1000);
      push("progress", {
        total: appState.total,
        done: appState.done,
        current: fileId,
        errors: appState.errors,
        status: appState.phase,
        elapsed: elapsed5,
      });
    }

    log("error", "Retry FAILED: " + fileId + " - " + e.message);
  } finally {
    activeRetries.delete(fileId);
    if (_globalSignal) _globalSignal.removeEventListener("abort", _onGlobalAbort);
  }
}

// ─── NEW-FILES CACHE ──────────────────────────────────────
// Tracks which files are new (not seen in the previous scan) so the UI can
// highlight them in the "New" category on the next step-03 load.
// Format: { newFiles: [...ids], allFiles: [...ids] }
// allFiles is the full snapshot used to detect additions in the NEXT run.
function saveNewFilesCache(cacheFile, newFileIds, allFileIds) {
  try {
    writeCache(cacheFile, { newFiles: newFileIds, allFiles: allFileIds });
  } catch (e) {}
}

function loadNewFilesCache(cacheFile) {
  try {
    return readCache(cacheFile, null);
  } catch {}
  return null;
}

// ─── SAVE HASH CACHE ──────────────────────────────────────
function saveHashCache(hashCacheFile, newHashes) {
  try {
    // Save only the current project's files — no accumulation of deleted entries.
    // The "last known hash" for deleted files is now stored in the result cache.
    writeCache(hashCacheFile, newHashes);
  } catch (e) {}
}

function loadResultCache(resultCacheFile) {
  try {
    return readCache(resultCacheFile, {}) || {};
  } catch {}
  return {};
}

function saveResultCache(resultCacheFile, events, prevResults, presentFileIds, newHashes, existingFileIds) {
  try {
    var cache = {};
    // Record which files are in the current scan so the next run can detect re-additions
    if (presentFileIds) cache._presentFiles = presentFileIds;
    // Save results produced in this run, with the current hash embedded
    for (var i = 0; i < events.length; i++) {
      var ef = events[i].file;
      cache[ef] = {
        category: events[i].category,
        content: events[i].content,
        hash: newHashes ? newHashes[ef] : undefined,
        model: events[i].model,
        precision: events[i].precision,
      };
    }
    // Keep results only for files that still exist on disk but weren't in this run
    // (i.e. excluded/unselected files). Truly-deleted files are dropped so they get
    // re-analyzed if the file is later restored, preventing stale results.
    if (prevResults) {
      var currentIds = new Set(Object.keys(cache));
      var prevKeys = Object.keys(prevResults);
      for (var j = 0; j < prevKeys.length; j++) {
        var k = prevKeys[j];
        if (k === "_presentFiles" || currentIds.has(k)) continue;
        // Only keep if the file still exists on disk (excluded, not deleted)
        if (!existingFileIds || existingFileIds.has(k)) cache[k] = prevResults[k];
      }
    }
    writeCache(resultCacheFile, cache);
  } catch {}
}

// ─── STATIC FILE SERVER ──────────────────────────────────
var STATIC_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveFromDir(baseDir, relPath, res) {
  var fullPath = join(baseDir, relPath);
  if (!fullPath.startsWith(baseDir) || !existsSync(fullPath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  var ext = extname(fullPath);
  var contentType = STATIC_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  res.end(readFileSync(fullPath));
}

function serveStatic(filePath, res) {
  if (filePath.startsWith("shared/") || filePath === "shared") {
    serveFromDir(DOCS_DIR, filePath, res);
    return;
  }
  serveFromDir(PUBLIC_DIR, filePath, res);
}

// ─── HTTP SERVER ──────────────────────────────────────────
export function startServer() {
  return new Promise(function (resolve) {
    var server = createServer(async function (req, res) {
      var url = new URL(req.url, "http://localhost:" + PORT);

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      function getBody() {
        return new Promise(function (ok) {
          var b = "";
          req.on("data", function (d) {
            b += d;
          });
          req.on("end", function () {
            try {
              ok(JSON.parse(b));
            } catch (e) {
              ok({});
            }
          });
        });
      }

      function jsonOut(data, status) {
        var s = status || 200;
        res.writeHead(s, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(data));
      } // ── SSE — with FULL state replay for page refresh

      if (url.pathname === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        }); // 1. Phase (includes paused state)

        res.write(
          "event: phase\ndata: " +
            JSON.stringify({ phase: appState.phase }) +
            "\n\n",
        ); // 2. UI page

        res.write(
          "event: ui_page\ndata: " +
            JSON.stringify({ page: appState.uiPage }) +
            "\n\n",
        ); // 3. Current run boundary so client shows only current-run logs

        res.write(
          "event: run_start\ndata: " +
            JSON.stringify({ logStart: appState.currentRunLogStart }) +
            "\n\n",
        ); // 4. All logs (client will filter to current run)

        for (var li = 0; li < appState.log.length; li++) {
          res.write(
            "event: log\ndata: " + JSON.stringify(appState.log[li]) + "\n\n",
          );
        } // 5. File list for current run (all files, including still-pending ones)

        if (appState.config && appState.runFileList.length > 0) {
          res.write(
            "event: file_list\ndata: " +
              JSON.stringify({ files: appState.runFileList, deletedSet: appState.deletedFiles || [], changeTypes: appState.fileChangeTypes || {} }) +
              "\n\n",
          );
          for (var fi = 0; fi < appState.runFileList.length; fi++) {
            var fid = appState.runFileList[fi];
            var fst = appState.fileStatuses[fid];
            var fstStatus = fst ? fst.status : "pending";
            var fstError = fst ? fst.error || null : null;
            // Mark as still-retrying if there's an active per-file controller
            // for it — this lets the client redraw the Stop button on refresh.
            var fstRetrying = activeRetries.has(fid);
            res.write(
              "event: file_status\ndata: " +
                JSON.stringify({
                  file: fid,
                  status: fstStatus,
                  error: fstError,
                  retrying: fstRetrying,
                }) +
                "\n\n",
            );
          }
        } // 6. All result events

        for (var ri = 0; ri < appState.resultEvents.length; ri++) {
          res.write(
            "event: result\ndata: " +
              JSON.stringify(appState.resultEvents[ri]) +
              "\n\n",
          );
        } // 7. Current preview

        if (appState.previewContent) {
          res.write(
            "event: preview\ndata: " +
              JSON.stringify({
                content: appState.previewContent,
                final: appState.previewFinal,
              }) +
              "\n\n",
          );
        } // 8. Current progress

        var elapsed = (appState.phase === "running" && appState.sessionStartedAt)
          ? Math.round((Date.now() - appState.sessionStartedAt) / 1000)
          : appState.elapsed;
        res.write(
          "event: progress\ndata: " +
            JSON.stringify({
              total: appState.total,
              done: appState.done,
              current: appState.current,
              errors: appState.errors,
              status: appState.phase,
              elapsed: elapsed,
            }) +
            "\n\n",
        );

        sseClients.push(res);
        req.on("close", function () {
          var idx = sseClients.indexOf(res);
          if (idx > -1) sseClients.splice(idx, 1);
        });
        return;
      } // ── API: Set UI page

      if (url.pathname === "/api/ping") {
        jsonOut({ ok: true });
        return;
      }

      // ── API: Startup / migration status (used by the UI overlay)
      if (url.pathname === "/api/startup-status") {
        if (req.method === "POST") {
          // Acknowledge events so the post-migration banner only shows once.
          startupState.events = [];
          jsonOut({ ok: true });
          return;
        }
        jsonOut({
          phase: startupState.phase,
          message: startupState.message,
          progress: startupState.progress,
          dataSchema: startupState.dataSchema,
          events: startupState.events,
          startedAt: startupState.startedAt,
          finishedAt: startupState.finishedAt,
        });
        return;
      }

      // ── API: Model stats (tok/s) — persisted in ~/.repodna ──
      if (url.pathname === "/api/model-stats") {
        if (req.method === "GET") {
          try {
            var statsFile = modelStatsCachePath();
            var statsData = existsSync(statsFile) ? JSON.parse(readFileSync(statsFile, "utf-8")) : {};
            jsonOut(statsData);
          } catch { jsonOut({}); }
          return;
        }
        if (req.method === "POST") {
          try {
            var statsBody = await getBody();
            writeFileSync(modelStatsCachePath(), JSON.stringify(statsBody));
          } catch {}
          jsonOut({ ok: true });
          return;
        }
      }

      // ── API: Browse folder (native OS folder picker) ──────
      if (url.pathname === "/api/browse-folder" && req.method === "POST") {
        var picked = null;
        var browseChild = null;
        var clientGone = false;

        req.on("close", function () {
          clientGone = true;
          if (browseChild) { try { browseChild.kill(); } catch (_) {} }
        });

        var execAsync = function (cmd, opts) {
          return new Promise(function (resolve) {
            browseChild = exec(cmd, opts, function (err, stdout) {
              browseChild = null;
              resolve(clientGone || err ? null : (stdout || "").trim() || null);
            });
          });
        };

        try {
          var plt = process.platform;
          if (plt === "win32") {
            var psCmd = [
              "Add-Type -AssemblyName System.Windows.Forms",
              "$o = New-Object System.Windows.Forms.Form",
              "$o.TopMost = $true",
              "$o.WindowState = 'Minimized'",
              "$o.ShowInTaskbar = $false",
              "$o.Show()",
              "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
              "$f.Description = 'Select project folder'",
              "$f.ShowNewFolderButton = $true",
              "if ($f.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }",
              "$o.Dispose()"
            ].join("; ");
            picked = await execAsync(
              "powershell -NoProfile -NonInteractive -Command \"" + psCmd.replace(/"/g, '\\"') + "\"",
              { encoding: "utf8", timeout: 120000 }
            );
          } else if (plt === "darwin") {
            var raw = await execAsync(
              "osascript -e 'set p to choose folder with prompt \"Select project folder\"' -e 'POSIX path of p'",
              { encoding: "utf8", timeout: 120000 }
            );
            picked = raw ? raw.replace(/\/$/, "") || null : null;
          } else {
            // Linux: try zenity then kdialog
            picked = await execAsync(
              "zenity --file-selection --directory --title='Select project folder'",
              { encoding: "utf8", timeout: 120000 }
            );
            if (!picked) {
              picked = await execAsync(
                "kdialog --getexistingdirectory / --title 'Select project folder'",
                { encoding: "utf8", timeout: 120000 }
              );
            }
          }
        } catch (e) { picked = null; }
        if (!clientGone) jsonOut({ ok: !!picked, path: picked });
        return;
      }

      if (url.pathname === "/api/ui-page" && req.method === "POST") {
        var pageBody = await getBody();
        if (typeof pageBody.page === "number") appState.uiPage = pageBody.page;
        jsonOut({ ok: true });
        return;
      } // ── API: Check Node

      if (url.pathname === "/api/check-node") {
        jsonOut({ ok: true, version: process.version.replace("v", "") });
        return;
      } // ── API: Check Ollama

      if (url.pathname === "/api/check-ollama") {
        var host = url.searchParams.get("host") || "http://localhost:11434";
        var ollamaResult = await checkOllama(host);
        var ollamaInstalled = false;
        try { execSync("ollama --version", { stdio: "ignore", timeout: 5000 }); ollamaInstalled = true; } catch (e) {}
        jsonOut(Object.assign({ installed: ollamaInstalled }, ollamaResult));
        return;
      } // ── API: Ollama whoami (cloud model login check)

      if (url.pathname === "/api/ollama-whoami") {
        try {
          var _whoami = execSync("ollama whoami", { stdio: "pipe", timeout: 4000 }).toString().trim();
          jsonOut({ loggedIn: !!_whoami, user: _whoami });
        } catch(e) {
          jsonOut({ loggedIn: false });
        }
        return;
      } // ── API: Scan Tree

      if (url.pathname === "/api/scan-tree") {
        var scanPath = url.searchParams.get("path");
        if (!scanPath || !existsSync(scanPath)) {
          jsonOut({ ok: false });
          return;
        }
        var customRulesStr = url.searchParams.get("customRules") || "{}";
        var parsedRules = {};
        try {
          parsedRules = JSON.parse(customRulesStr);
        } catch (e) {}
        var cfg = loadConfig();
        var result = scanProject(
          scanPath,
          parsedRules,
          cfg.globalExclusions || {},
          cfg.globalInclusions || {},
        );
        scanCache[scanPath] = result;
        var newFileIds = [];
        try {
          var _nfCachePath = newFilesCachePath(scanPath);
          var _nfd = loadNewFilesCache(_nfCachePath);
          var _scannedIds = result.nodes
            .filter(function(n) { return n.type === "file"; })
            .map(function(n) { return n.id; });
          if (_nfd && _nfd.allFiles && _nfd.allFiles.length > 0) {
            var _prevAllSet = new Set(_nfd.allFiles);
            newFileIds = _scannedIds.filter(function(id) { return !_prevAllSet.has(id); });
          }
          // Step 03 owns the snapshot: update it now so the run knows exactly
          // which files were visible when the user last reviewed the tree.
          // Files added after this point are deferred to the next step-03 open.
          saveNewFilesCache(_nfCachePath, newFileIds, _scannedIds);
        } catch (e) {}
        jsonOut({
          ok: true,
          tree: result.tree,
          projectType: result.projectType,
          fileCount: result.fileCount,
          timedOut: result.timedOut,
          newFileIds: newFileIds,
        });
        return;
      } // ── API: Scan Extensions

      if (url.pathname === "/api/scan-extensions") {
        var extPath = url.searchParams.get("path");
        if (!extPath || !existsSync(extPath)) {
          jsonOut({ ok: false, exts: [] });
          return;
        }
        jsonOut({ ok: true, exts: scanProjectExtensions(extPath) });
        return;
      } // ── API: Get Default Rules

      if (url.pathname === "/api/default-rules") {
        jsonOut({ ok: true, rules: getDefaultRules() });
        return;
      } // ── API: Project List

      if (url.pathname === "/api/projects") {
        jsonOut({ ok: true, projects: getProjectList() });
        return;
      } // ── API: Add Project

      if (url.pathname == "/api/projects/add" && req.method == "POST") {
        try {
          var addBody = await getBody();
          if (!addBody || !addBody.projectPath) {
            jsonOut({
              ok: false,
              error: "Invalid body: " + JSON.stringify(addBody),
            });
            return;
          }
          var proj = addProject(
            addBody.projectPath,
            addBody.projectType,
            addBody.description,
          );
          jsonOut({ ok: true, project: proj });
        } catch (e) {
          console.error("ADD PROJECT ERROR:", e);
          jsonOut({ ok: false, error: e.message });
        }
        return;
      } // ── API: Remove Project

      if (url.pathname === "/api/projects/remove" && req.method === "POST") {
        var remBody = await getBody();
        removeProject(remBody.projectPath);
        jsonOut({ ok: true });
        return;
      } // ── API: Update Project Settings

      if (url.pathname === "/api/projects/update" && req.method === "POST") {
        var updBody = await getBody();
        if (!updBody.projectPath) {
          jsonOut({ ok: false, error: "Missing projectPath" });
          return;
        }
        updateProjectSettings(updBody.projectPath, updBody);
        jsonOut({ ok: true });
        return;
      } // ── API: Save/Load Config

      if (url.pathname === "/api/save-config" && req.method === "POST") {
        var saveBody = await getBody();
        var savedCfg = loadConfig();
        savedCfg.lastConfig = saveBody;
        saveConfig(savedCfg);
        jsonOut({ ok: true });
        return;
      }
      if (url.pathname === "/api/load-config") {
        var loadedCfg = loadConfig();
        jsonOut({ config: loadedCfg.lastConfig || null });
        return;
      } // ── API: Run

      if (url.pathname === "/api/run" && req.method === "POST") {
        if (appState.phase === "running") {
          jsonOut({ ok: false, error: "Already running" });
          return;
        }
        var runBody = await getBody();
        jsonOut({ ok: true });
        runAnalysis(runBody).catch(function (e) {
          log("error", "Runner crashed: " + e.message);
        });
        return;
      } // ── API: Abort

      if (url.pathname === "/api/abort" && req.method === "POST") {
        if (runnerAbortController) runnerAbortController.abort();
        // Replace with a fresh controller so retries work after stop.
        // /api/reset (New Analysis) aborts whatever controller is current.
        runnerAbortController = new AbortController();
        resumeAll();
        // Clear the running animation on any in-flight file
        for (var _sf in appState.fileStatuses) {
          if (appState.fileStatuses[_sf] && appState.fileStatuses[_sf].status === "running") {
            appState.fileStatuses[_sf] = { status: "error", error: "Stopped" };
            push("file_status", { file: _sf, status: "error", error: "Stopped" });
          }
        }
        appState.phase = "done";
        push("phase", { phase: "done" });
        jsonOut({ ok: true });
        return;
      } // ── API: Pause/Resume

      if (url.pathname === "/api/pause" && req.method === "POST") {
        isPaused = true;
        appState.phase = "paused";
        push("phase", { phase: "paused" });
        jsonOut({ ok: true });
        return;
      }
      if (url.pathname === "/api/resume" && req.method === "POST") {
        resumeAll();
        appState.phase = "running";
        push("phase", { phase: "running" });
        jsonOut({ ok: true });
        return;
      } // ── API: Retry single file

      if (url.pathname === "/api/retry-file" && req.method === "POST") {
        var retryBody = await getBody();
        if (!retryBody.file) {
          jsonOut({ ok: false, error: "Missing file" });
          return;
        } // Non-blocking: respond immediately, run retry async
        jsonOut({ ok: true });
        retryFile(retryBody.file, retryBody.precision || null).catch(function (e) {
          log("error", "Retry crashed: " + e.message);
        });
        return;
      }

      // ── API: Stop a single in-flight retry (or remove a queued one).
      // The whole-run Stop button uses /api/abort; this one cancels just
      // one file so other files keep processing.
      if (url.pathname === "/api/stop-file" && req.method === "POST") {
        var stopBody = await getBody();
        var stopFid = stopBody && stopBody.file;
        if (!stopFid) { jsonOut({ ok: false, error: "Missing file" }); return; }
        var _stopBefore = retryQueue.length;
        retryQueue = retryQueue.filter(function (r) { return r.fileId !== stopFid; });
        var _dequeued = retryQueue.length < _stopBefore;
        var _ctrl = activeRetries.get(stopFid);
        var _aborted = false;
        if (_ctrl) { _ctrl.abort(); _aborted = true; }
        if (_dequeued && !_aborted) {
          // It was queued but never started — revert to ok so the row drops
          // out of the "running" state and the retry button reappears.
          appState.fileStatuses[stopFid] = { status: "ok" };
          push("file_status", { file: stopFid, status: "ok" });
        }
        jsonOut({ ok: true, dequeued: _dequeued, aborted: _aborted });
        return;
      }

      // ── API: Reset — full server state wipe (called by Exit)
      if (url.pathname === "/api/reset" && req.method === "POST") {
        if (runnerAbortController) runnerAbortController.abort();
        resumeAll();
        appState.phase = "wizard";
        appState.uiPage = 0;
        appState.total = 0;
        appState.done = 0;
        appState.errors = 0;
        appState.current = "";
        appState.log = [];
        appState.currentRunLogStart = 0;
        appState.results = {};
        appState.resultEvents = [];
        appState.fileStatuses = {};
        appState.runFileList = [];
        appState.deletedFiles = [];
        appState.fileChangeTypes = {};
        appState.previewContent = "";
        appState.previewFinal = false;
        appState.config = null;
        appState.sessionStartedAt = null;
        catResultMaps = {};
        completedFiles = new Set();
        retryQueue = [];
        retryRunning = false;
        retryLock = false;
        activeRetries.forEach(function (c) { try { c.abort(); } catch (_) {} });
        activeRetries.clear();
        push("phase", { phase: "wizard" });
        push("ui_page", { page: 0 });
        jsonOut({ ok: true });
        return;
      } 
      
      // ── API: Update a single cached result (client-side edit)
      // Persists the edit in three places: (1) ~/.repodna result cache,
      // (2) live appState (resultEvents + catResultMaps), (3) the project's
      // CLAUDE.md / AGENTS.md / etc. — rebuilt from the updated cache.
      if (url.pathname === "/api/update-result" && req.method === "POST") {
        var urBody = await getBody();
        var urPath = urBody.projectPath;
        var urFile = urBody.file;
        var urContent = urBody.content;
        if (!urPath || !urFile || urContent === undefined) {
          jsonOut({ ok: false, error: "Missing params" });
          return;
        }
        var urCacheFile = resultCachePath(urPath);
        var urCache = loadResultCache(urCacheFile);
        var urCat = urCache[urFile] && urCache[urFile].category;
        if (urCache[urFile]) {
          urCache[urFile].content = urContent;
        }
        try {
          writeFileSync(urCacheFile, JSON.stringify(urCache));
        } catch (urErr) {
          jsonOut({ ok: false, error: "Cache write failed: " + urErr.message });
          return;
        }

        // Mirror into in-memory resultEvents so SSE replays serve updated content
        for (var _ri = 0; _ri < appState.resultEvents.length; _ri++) {
          if (appState.resultEvents[_ri].file === urFile) {
            appState.resultEvents[_ri].content = urContent;
            if (!urCat) urCat = appState.resultEvents[_ri].category;
            break;
          }
        }

        // Mark as "edited" in the run file list, unless a hash-based badge
        // (created/modified/readded/removed) already describes this file in
        // the current run — those reflect on-disk state and must be preserved.
        var _urCT = appState.fileChangeTypes[urFile];
        var _urHashBased = _urCT === "created" || _urCT === "modified" ||
                          _urCT === "readded" || _urCT === "removed";
        var _urChangeType = null;
        if (!_urHashBased) {
          appState.fileChangeTypes[urFile] = "edited";
          _urChangeType = "edited";
        }
        // If the file wasn't in the current run list (e.g. unchanged file
        // served from cache), add it so the activity panel shows it.
        if (!appState.runFileList.includes(urFile)) {
          appState.runFileList.push(urFile);
        }
        if (!appState.fileStatuses[urFile] || appState.fileStatuses[urFile].status !== "ok") {
          appState.fileStatuses[urFile] = { status: "ok" };
        }
        push("file_status", { file: urFile, status: "ok", changeType: _urChangeType });

        // Mirror into catResultMaps + rebuild appState.results
        if (urCat && catResultMaps[urCat]) {
          catResultMaps[urCat].set(urFile, urContent);
          appState.results = catMapsToResults(catResultMaps);
        }

        // Rebuild the project's output file (CLAUDE.md / AGENTS.md / ...)
        // from the freshly-edited cache so the user sees the change on disk.
        var urCfg = appState.config;
        if (!urCfg) {
          var urProj = getProject(urPath);
          if (urProj) {
            urCfg = {
              projectPath: urPath,
              projectDescription: urProj.description || "",
              agentTarget: urProj.agentTarget || "claude",
              model: urProj.model || "",
              precision: urProj.precision || "standard",
              fileTreeMode: urProj.fileTreeMode || "none",
            };
          }
        }
        var urWroteFile = false;
        if (urCfg) {
          // Rebuild appState.results from the on-disk cache so EVERY cached
          // file (not just ones from the current session) is included.
          var urRebuiltMaps = {};
          for (var urKey in urCache) {
            if (urKey === "_presentFiles") continue;
            var urEntry = urCache[urKey];
            if (!urEntry || !urEntry.category) continue;
            if (!urRebuiltMaps[urEntry.category]) urRebuiltMaps[urEntry.category] = new Map();
            urRebuiltMaps[urEntry.category].set(urKey, urEntry.content);
          }
          var urResultsForBuild = catMapsToResults(urRebuiltMaps);
          var urRelFile = AGENT_TARGETS_SERVER[urCfg.agentTarget] || "CLAUDE.md";
          var urAbsPath = join(urCfg.projectPath, urRelFile);
          var urAbsDir = dirname(urAbsPath);
          try {
            var urMd = buildClaudeMd(urResultsForBuild, urCfg, getResultFileIds(urRebuiltMaps), urCfg.projectPath, null);
            if (!existsSync(urAbsDir)) mkdirSync(urAbsDir, { recursive: true });
            writeFileSync(urAbsPath, urMd, "utf-8");
            urWroteFile = true;
            // Also refresh the live preview so the dashboard shows the rebuilt file
            appState.previewContent = urMd;
            appState.previewFinal = true;
            push("preview", { content: urMd, final: true });
          } catch (urBuildErr) {
            // Cache + UI updates already succeeded; the on-disk rebuild failed.
            jsonOut({ ok: true, wroteFile: false, error: "Build failed: " + urBuildErr.message });
            return;
          }
        }
        jsonOut({ ok: true, wroteFile: urWroteFile });
        return;
      }

      // ── API: Ollama Models Catalog
      if (url.pathname === "/api/ollama-models") {
        try {
          var _mf = join(ROOT_DIR, "ollama_models.json");
          jsonOut({ ok: true, data: JSON.parse(readFileSync(_mf, "utf-8")) });
        } catch (e) { jsonOut({ ok: false, error: e.message }); }
        return;
      }

      // ── API: Refresh Models from GitHub (1h rate-limit)
      if (url.pathname === "/api/ollama-models/refresh" && req.method === "POST") {
        var _rl_now = Date.now();
        var _rl_cd  = 60 * 60 * 1000;
        if (_lastModelsRefresh && (_rl_now - _lastModelsRefresh) < _rl_cd) {
          jsonOut({ ok: false, rateLimited: true,
            waitMinutes: Math.ceil((_rl_cd - (_rl_now - _lastModelsRefresh)) / 60000) });
          return;
        }
        try {
          var _rawUrl = "https://raw.githubusercontent.com/" + GITHUB_REPO + "/main/ollama_models.json";
          var _rawRes = await fetch(_rawUrl, { headers: { "User-Agent": "repoDNA/" + VERSION } });
          if (!_rawRes.ok) { jsonOut({ ok: false, error: "GitHub " + _rawRes.status }); return; }
          var _rawTxt = await _rawRes.text();
          var _newMod = JSON.parse(_rawTxt); // validate JSON
          writeFileSync(join(ROOT_DIR, "ollama_models.json"), _rawTxt, "utf-8");
          _lastModelsRefresh = _rl_now;
          jsonOut({ ok: true, data: _newMod });
        } catch (e) { jsonOut({ ok: false, error: e.message }); }
        return;
      }

      // ── API: Check for updates
      // Hits GitHub once per server lifetime, then serves the cached result on
      // every call (so a browser refresh can still render the banner). The
      // response carries serverStartId — the client uses it to scope its
      // "dismissed" flag to this process, so `node main.mjs` restarts get a
      // fresh banner.
      if (url.pathname === "/api/check-update") {
        if (_updateCheckCache) {
          jsonOut({ ...(_updateCheckCache), serverStartId: _serverStartId });
          return;
        }
        try {
          const ghRes = await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
            { headers: { "User-Agent": "repoDNA/" + VERSION } }
          );
          if (!ghRes.ok) {
            _updateCheckCache = { ok: false };
            jsonOut({ ok: false, serverStartId: _serverStartId });
            return;
          }
          const ghData = await ghRes.json();
          const latest = (ghData.tag_name || "").replace(/^v/, "");
          _updateCheckCache = { ok: true, latest, current: VERSION, url: ghData.html_url || "" };
          jsonOut({ ...(_updateCheckCache), serverStartId: _serverStartId });
        } catch (e) {
          jsonOut({ ok: false, error: e.message, serverStartId: _serverStartId });
        }
        return;
      }
      
      // ── Landing page (bundled offline copy of repodna.com from /docs)
      if (url.pathname === "/landing") {
        res.writeHead(302, { Location: "/landing/" });
        res.end();
        return;
      }
      if (url.pathname === "/landing/") {
        var landingHtml = readFileSync(join(DOCS_DIR, "index.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(landingHtml);
        return;
      }
      if (url.pathname.startsWith("/landing/")) {
        serveFromDir(DOCS_DIR, url.pathname.slice("/landing/".length), res);
        return;
      }

      // ── Static files
      var filePath =
        url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (filePath === "index.html") {
        var html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf-8");
        html = html.replaceAll("__REPO_NAME__", REPO_NAME);
        html = html.replaceAll("__VERSION__", VERSION);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }
      serveStatic(filePath, res);
    });

    server.on("error", async function (err) {
      if (err && err.code === "EADDRINUSE") {
        var isOurs = false;
        try {
          var ctl = new AbortController();
          var timer = setTimeout(function () { ctl.abort(); }, 500);
          var probe = await fetch("http://localhost:" + PORT + "/api/ping", { signal: ctl.signal });
          clearTimeout(timer);
          isOurs = probe.ok;
        } catch (_) {}
        var R = "\x1b[31m", C = "\x1b[36m", B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";
        console.log("");
        if (isOurs) {
          console.log("  " + R + "✗" + X + " repoDNA is already running on port " + B + PORT + X + ".");
          console.log("    Open " + C + "http://localhost:" + PORT + X + " in your browser,");
          console.log("    " + D + "or stop the other instance first (Ctrl+C in its terminal)." + X);
        } else {
          console.log("  " + R + "✗" + X + " Port " + B + PORT + X + " is already in use by another process.");
          console.log("    " + D + "Free the port and try again." + X);
        }
        console.log("");
        process.exit(1);
      }
      console.error(err);
      process.exit(1);
    });

    // Migrate/clear incompatible caches BEFORE the server accepts a single
    // request, so no endpoint (project list, file tree, cached results, etc.)
    // can ever read pre-migration data. Synchronous file I/O — fast.
    runStartupMigrations();

    server.listen(PORT, function () {      console.log("");
      console.log("  +------------------------------------------+");
      console.log("  |  repoDNA is running                    |");
      console.log("  |  Open: http://localhost:" + PORT + "             |");
      console.log("  +------------------------------------------+");
      console.log("");
      console.log("  Press Ctrl+C to stop.");
      console.log("");
      // Kick off cache-schema migration for every known project. The UI polls
      // /api/startup-status and shows a blocking overlay until phase === "ready".
      resolve(server);
    });
  });
}

// ─── STARTUP MIGRATIONS ───────────────────────────────────
// Migrates the WHOLE ~/.repodna store (config + all caches) exactly once,
// BEFORE the server accepts any request. Incompatible → the store is moved
// aside to a timestamped backup and recreated empty (start from zero).
// Delegates the actual work to store.mjs / migrations.mjs.
function runStartupMigrations() {
  try {
    startupState.dataSchema = DATA_SCHEMA;
    startupState.phase = "pending";
    startupState.startedAt = Date.now();
    startupState.events = [];

    // Refuse to touch anything if the migration chain itself is malformed.
    var chainProblems = validateMigrationsChain();
    if (chainProblems.length > 0) {
      startupState.phase = "error";
      startupState.message =
        "migrations.mjs is invalid — refusing to touch the data store. Problems: " +
        chainProblems.join("; ");
      startupState.finishedAt = Date.now();
      log("error", startupState.message);
      console.error("\n  \x1b[31m✗ Data-store migration self-check failed\x1b[0m");
      chainProblems.forEach(function (m) { console.error("    " + m); });
      console.error("");
      return;
    }

    var result = migrateStore();        // synchronous; wipes/transforms the store
    startupState.events = result.events || [];
    startupState.progress = { current: 1, total: 1 };
    startupState.phase = "ready";
    startupState.finishedAt = Date.now();
    startupState.message = "Ready";

    if (result.kind === "incompatible") {
      var bak = (result.events[0] && result.events[0].backup) || "(backup)";
      console.log(
        "\n  \x1b[33m⚠ Incompatible data store (schema " + result.from + " → " + result.to + ")\x1b[0m"
      );
      console.log("    Cleared and started fresh. Previous store backed up to:");
      console.log("    \x1b[36m" + bak + "\x1b[0m\n");
      log("info", "Store wiped (incompatible " + result.from + "→" + result.to + "), backup: " + bak);
    } else if (result.kind === "migrated") {
      console.log("\n  \x1b[32m✓ Data store migrated " + result.from + " → " + result.to + "\x1b[0m\n");
      log("info", "Store migrated " + result.from + "→" + result.to);
    } else if (result.kind === "error") {
      log("error", "Store migration error; store was reset. " + JSON.stringify(result.events));
    }
  } catch (e) {
    startupState.phase = "error";
    startupState.message = "Migration error: " + ((e && e.message) || e);
    startupState.finishedAt = Date.now();
  }
}
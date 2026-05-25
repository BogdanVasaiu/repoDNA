// ═══════════════════════════════════════════════════════════
// MARKED CONFIG
// ═══════════════════════════════════════════════════════════
if (window.marked) marked.setOptions({ breaks: true, gfm: true });
function md2html(t) {
  if (!t) return "";
  try {
    return window.marked ? marked.parse(t) : t.replace(/</g, "&lt;");
  } catch {
    return t;
  }
}

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
var S = {
  currentPage: 0,
  ollamaOk: false,
  ollamaChecking: false,
  ollamaHost: "http://localhost:11434",
  ollamaModels: [],
  projectPath: "",
  projectType: "UNKNOWN",
  treeData: [],
  flatNodes: [],
  userOverrides: new Map(),
  precision: "standard",
  model: "",
  changesOnly: false,
  results: {},
  activeTab: null,
  activeTabIsPreview: true,
  previewContent: "",
  previewFinal: false,
  runPhase: "idle", // idle | running | paused | done
  treeFilter: "all",
  treeSearchQuery: "",
  selectedCategories: new Set(),
  fileTreeMode: "none",   // "none" | "included" | "all"
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
  defaultRules: null,
  advActiveTab: "exc-folders",
  dirModalCallback: null,
  dashboardShown: false,
  // File tracking for step-5 list
  fileList: [], // ordered list of file ids for current run
  fileStatuses: {}, // file id -> { status: 'pending'|'running'|'ok'|'error', error? }
  currentRunLogStart: 0, // log index where current run starts
  retryingFiles: new Set(),
  retriedFileIds: new Set(),
  runDone: 0,
  runTotal: 0,
  deletedCount: 0,
  fileChangeTypes: {}, // fileId -> 'created'|'modified'|'readded'|'removed'
  newFileIds: new Set(), // files created in the last smart update (persisted)
  agentTarget: "claude",
};

var _ollamaCatalog = null;   // curated models list from ollama_models.json
var _catalogFilter = "local"; // "local" | "cloud"
var _SPEED_WINDOW = 10; // rolling average over last N files
var _modelStatsCache = {}; // loaded from ~/.repodna/model_stats.json via server
var _sizeFetchScheduled = false;

function _getModelStats() { return _modelStatsCache; }

async function _loadModelStats() {
  try {
    var r = await fetch("/api/model-stats");
    if (r.ok) _modelStatsCache = await r.json();
  } catch(e) {}
}

function _saveModelStat(modelName, tokensPerSecond) {
  if (!modelName || !(tokensPerSecond > 0)) return;
  var s = _modelStatsCache[modelName] || { samples: [] };
  if (!Array.isArray(s.samples)) s.samples = [];
  s.samples.push(tokensPerSecond);
  if (s.samples.length > _SPEED_WINDOW) s.samples.splice(0, s.samples.length - _SPEED_WINDOW);
  s.avg = s.samples.reduce(function(a, b) { return a + b; }, 0) / s.samples.length;
  _modelStatsCache[modelName] = s;
  fetch("/api/model-stats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(_modelStatsCache)
  }).catch(function() {});
}
function _fmtModelSize(bytes) {
  if (!bytes || bytes <= 0) return '—';
  var gb = bytes / 1e9;
  if (gb >= 1) return gb.toFixed(1).replace(/\.0$/, '') + ' GB';
  return Math.round(bytes / 1e6) + ' MB';
}

function _lookupCatalogEntry(modelName) {
  if (!_ollamaCatalog || !_ollamaCatalog.models) return null;
  var bare = modelName.replace(/:latest$/, '');
  for (var i = 0; i < _ollamaCatalog.models.length; i++) {
    var m = _ollamaCatalog.models[i];
    var om = (m.ollama_model || '').replace(/:latest$/, '');
    if (om === bare || om === modelName || m.ollama_model === modelName) return m;
  }
  return null;
}

var _projectsList = [];
var _FILE_COUNTS_KEY = "repodna_file_counts";
function _getFileCounts() {
  try { return JSON.parse(localStorage.getItem(_FILE_COUNTS_KEY) || "{}"); } catch(e) { return {}; }
}
function _setFileCount(path, count) {
  try { var c = _getFileCounts(); c[path] = count; localStorage.setItem(_FILE_COUNTS_KEY, JSON.stringify(c)); } catch(e) {}
}
function _clearFileCount(path) {
  try { var c = _getFileCounts(); delete c[path]; localStorage.setItem(_FILE_COUNTS_KEY, JSON.stringify(c)); } catch(e) {}
}

function _splitPath(p) {
  var m = p.match(/^(.*[\\/])([^\\/]+)[\\/]?$/);
  if (!m) return { base: p };
  return { base: m[2] };
}

var DEFAULT_CUSTOM_RULES = {
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
};

// ═══════════════════════════════════════════════════════════
// UNDO / REDO HISTORY  (step 03 — file selection)
// ───────────────────────────────────────────────────────────
// Patch-based: each entry stores only the diff between userOverrides
// before/after the mutation, plus the rules JSON if customRules changed.
// Capped by entry-count AND byte budget so large projects (10k+ files)
// can't balloon memory. Evicts oldest first; never evicts the last entry
// (so the most recent action stays undoable even if it alone exceeds the
// budget). Single-entry size is approximated, not measured exactly —
// good enough for budget enforcement.
// ═══════════════════════════════════════════════════════════
var History = {
  undo: [],
  redo: [],
  MAX_ENTRIES: 50,
  MAX_BYTES: 5 * 1024 * 1024, // 5 MB total across both stacks
  bytes: 0,
  _snap: null, // pre-mutation snapshot captured by begin()

  begin: function () {
    this._snap = {
      overrides: new Map(S.userOverrides),
      rules: JSON.stringify(S.customRules),
    };
  },
  abort: function () { this._snap = null; },

  commit: function (label, opts) {
    var snap = this._snap;
    this._snap = null;
    if (!snap) return;
    var patch = this._diff(snap, label, opts);
    if (!patch) return;
    this.undo.push(patch);
    this.bytes += patch._bytes;
    // Clear redo on any new branch.
    this._dropRedo();
    this._evict();
    this._updateUi();
  },

  _diff: function (snap, label, opts) {
    var changes = [];
    snap.overrides.forEach(function (v, k) {
      var cur = S.userOverrides.get(k);
      if (cur === undefined) changes.push([k, v, null]);
      else if (cur !== v) changes.push([k, v, cur]);
    });
    S.userOverrides.forEach(function (v, k) {
      if (!snap.overrides.has(k)) changes.push([k, null, v]);
    });
    var curRules = JSON.stringify(S.customRules);
    var rulesChanged = curRules !== snap.rules;
    if (!changes.length && !rulesChanged) return null;
    var bytes = 64; // overhead
    for (var i = 0; i < changes.length; i++) bytes += changes[i][0].length + 12;
    if (rulesChanged) bytes += snap.rules.length + curRules.length;
    return {
      label: label || "Edit",
      changes: changes,
      prevRules: rulesChanged ? snap.rules : null,
      nextRules: rulesChanged ? curRules : null,
      needsRescan: !!(opts && opts.needsRescan) || rulesChanged,
      _bytes: bytes,
    };
  },

  _apply: function (patch, dir) {
    var changes = patch.changes;
    for (var i = 0; i < changes.length; i++) {
      var id = changes[i][0];
      var v = dir < 0 ? changes[i][1] : changes[i][2];
      if (v === null) S.userOverrides.delete(id);
      else S.userOverrides.set(id, v);
    }
    if (patch.prevRules || patch.nextRules) {
      var r = dir < 0 ? patch.prevRules : patch.nextRules;
      if (r) S.customRules = JSON.parse(r);
    }
  },

  undoStep: async function () {
    if (!this.undo.length) return;
    var patch = this.undo.pop();
    this.bytes -= patch._bytes;
    this._apply(patch, -1);
    this.redo.push(patch);
    this.bytes += patch._bytes;
    this._evict();
    await this._after(patch);
  },

  redoStep: async function () {
    if (!this.redo.length) return;
    var patch = this.redo.pop();
    this.bytes -= patch._bytes;
    this._apply(patch, +1);
    this.undo.push(patch);
    this.bytes += patch._bytes;
    this._evict();
    await this._after(patch);
  },

  _after: async function (patch) {
    if (patch.needsRescan) {
      try { await rescanWithRules(); } catch (e) {}
      try { renderAdvContent(); } catch (e) {}
    }
    try { renderTree(); } catch (e) {}
    try { renderCategoryChips(); } catch (e) {}
    try { refreshFileCount(); } catch (e) {}
    try { renderSummary(); } catch (e) {}
    try { saveCurrentProjectSettings(); } catch (e) {}
    this._updateUi();
  },

  _dropRedo: function () {
    for (var i = 0; i < this.redo.length; i++) this.bytes -= this.redo[i]._bytes;
    this.redo.length = 0;
    if (this.bytes < 0) this.bytes = 0;
  },

  _evict: function () {
    // Evict from undo first (oldest), then redo, but never empty either stack
    // if the entry being evicted is the only remaining state. Loop until under both caps.
    var safety = 1000;
    while (safety-- > 0) {
      var totalCount = this.undo.length + this.redo.length;
      if (totalCount <= this.MAX_ENTRIES && this.bytes <= this.MAX_BYTES) break;
      // Pick the oldest entry across both stacks. Undo[0] is older than any redo entry
      // (redo only ever holds entries created via undoStep, which are necessarily newer
      // than the bottom of undo).
      var victim = null;
      if (this.undo.length > 1) victim = this.undo.shift();
      else if (this.redo.length > 1) victim = this.redo.shift();
      else break; // refuse to evict the last entry on each side
      this.bytes -= victim._bytes;
      if (this.bytes < 0) this.bytes = 0;
    }
  },

  reset: function () {
    this.undo.length = 0;
    this.redo.length = 0;
    this.bytes = 0;
    this._snap = null;
    this._updateUi();
  },

  _updateUi: function () {
    var ub = document.getElementById("btn-undo");
    var rb = document.getElementById("btn-redo");
    if (ub) {
      ub.disabled = !this.undo.length;
      ub.title = this.undo.length
        ? "Undo: " + this.undo[this.undo.length - 1].label + "  (Ctrl+Z)"
        : "Nothing to undo";
    }
    if (rb) {
      rb.disabled = !this.redo.length;
      rb.title = this.redo.length
        ? "Redo: " + this.redo[this.redo.length - 1].label + "  (Ctrl+Shift+Z)"
        : "Nothing to redo";
    }
  },
};

// Wrap a synchronous OR async mutation so its diff becomes one history entry.
function withHistory(label, fn, opts) {
  History.begin();
  var ret;
  try { ret = fn(); }
  catch (e) { History.abort(); throw e; }
  if (ret && typeof ret.then === "function") {
    return ret.then(
      function (v) { History.commit(label, opts); return v; },
      function (err) { History.abort(); throw err; }
    );
  }
  History.commit(label, opts);
  return ret;
}

window._historyUndo = function () { History.undoStep(); };
window._historyRedo = function () { History.redoStep(); };

// Keyboard shortcuts — only on step 03 (file selection), and only when no
// editable field has focus (so typing into a rule input or search box doesn't
// trigger undo).
document.addEventListener("keydown", function (e) {
  if (S.currentPage !== 2) return;
  var t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  var meta = e.ctrlKey || e.metaKey;
  if (!meta) return;
  var k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); History.undoStep(); }
  else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); History.redoStep(); }
});

var AGENT_TARGETS = {
  claude: { name: "Claude Code", file: "CLAUDE.md", icon: "Claude-icon.svg" },
  codex: { name: "Codex CLI", file: "AGENTS.md", icon: "Codex-icon.svg" },
  copilot: {
    name: "Copilot CLI",
    file: ".github/copilot-instructions.md",
    icon: "Copilot-icon.svg",
  },
  cursor: { name: "Cursor", file: ".cursorrules", icon: "Cursor-icon.svg" },
  windsurf: { name: "Windsurf", file: "AGENTS.md", icon: "Windsurf-icon.svg" },
  opencode: { name: "OpenCode", file: "AGENTS.md", icon: "OpenCode-icon.svg" },
  openclaw: { name: "OpenClaw", file: "AGENTS.md", icon: "OpenClaw-icon.svg" },
  gemini: { name: "Gemini CLI", file: "GEMINI.md", icon: "Gemini-icon.svg" },
  roocode: { name: "Roo Code", file: "AGENTS.md", icon: "RooCode-icon.svg" },
  amp: { name: "Amp", file: "AGENT.md", icon: "Amp-icon.svg" },
  cline: {
    name: "Cline",
    file: ".clinerules/context.md",
    icon: "Cline-icon.svg",
  },
  generic: { name: "Generic", file: "AGENTS.md", icon: "Generic-icon.svg" },
};

function applyProjectSettings(proj) {
  var p = proj || {};

  // History belongs to a single project session; switching projects drops it.
  try { History.reset(); } catch (e) {}

  // Description — always overwrite (even with empty string)
  document.getElementById("project-desc").value = p.description || "";

  // Model
  S.model = p.model || (S.ollamaModels.length ? S.ollamaModels[0].name : "");
  populateModels();

  // Precision
  S.precision = p.precision || "standard";
  buildModeGrid();

  // changesOnly — explicit boolean, never a falsy check
  S.changesOnly = p.changesOnly === true;
  document
    .getElementById("toggle-changes")
    .classList.toggle("on", S.changesOnly);

  S.fileTreeMode = p.fileTreeMode || "none";
  var ftToggle = document.getElementById("toggle-filetree");
  var ftRow = document.getElementById("filetree-mode-row");
  if (ftToggle) ftToggle.classList.toggle("on", S.fileTreeMode !== "none");
  if (ftRow) ftRow.style.display = S.fileTreeMode !== "none" ? "" : "none";
  var ftInput = document.getElementById("ft-" + S.fileTreeMode);
  if (ftInput) ftInput.checked = true;

  // Ollama host
  S.ollamaHost = p.ollamaHost || "http://localhost:11434";
  document.getElementById("ollama-host").value = S.ollamaHost;

  // customRules — full replace, never merge
  S.customRules = Object.assign({}, DEFAULT_CUSTOM_RULES, p.customRules || {});

  // agentTarget
  S.agentTarget = p.agentTarget || "claude";

  // userOverrides — restore from saved settings; deleted files are cleaned up after flattenNodes
  S.userOverrides = new Map(p.userOverrides || []);
  S.selectedCategories = new Set();
  // If the tree is already rendered (e.g. race at init), re-render it with restored overrides
  if (S.currentPage === 2 && S.flatNodes.length > 0) {
    renderTree();
    renderCategoryChips();
    refreshFileCount();
    renderSummary();
  }
}

// ─── AUTO-SAVE PROJECT SETTINGS ───────────────────────────
var _saveProjectTimer = null;
function _buildProjectPayload() {
  return {
    projectPath: S.projectPath,
    description: document.getElementById("project-desc").value.trim(),
    model: S.model,
    precision: S.precision,
    changesOnly: S.changesOnly,
    ollamaHost: S.ollamaHost,
    customRules: S.customRules,
    agentTarget: S.agentTarget,
    fileTreeMode: S.fileTreeMode,
    userOverrides: Array.from(S.userOverrides.entries()),
  };
}
async function _flushProjectSettings() {
  if (!S.projectPath) return;
  clearTimeout(_saveProjectTimer);
  _saveProjectTimer = null;
  try {
    await fetch("/api/projects/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_buildProjectPayload()),
    });
  } catch {}
}
function saveCurrentProjectSettings() {
  if (!S.projectPath) return;
  clearTimeout(_saveProjectTimer);
  _saveProjectTimer = setTimeout(function () {
    _saveProjectTimer = null;
    _flushProjectSettings();
  }, 600);
}

// ═══════════════════════════════════════════════════════════
// FILE ICONS
// ═══════════════════════════════════════════════════════════
var FICONS = {
  ".ts": { bg: "#3178c6", fg: "#fff", t: "TS" },
  ".tsx": { bg: "#3178c6", fg: "#fff", t: "TSX" },
  ".js": { bg: "#f7df1e", fg: "#1a1a1a", t: "JS" },
  ".jsx": { bg: "#61dafb", fg: "#1a1a1a", t: "JSX" },
  ".mjs": { bg: "#c8a800", fg: "#fff", t: "MJS" },
  ".vue": { bg: "#42b883", fg: "#fff", t: "VUE" },
  ".svelte": { bg: "#ff3e00", fg: "#fff", t: "SV" },
  ".css": { bg: "#264de4", fg: "#fff", t: "CSS" },
  ".scss": { bg: "#cf649a", fg: "#fff", t: "SCSS" },
  ".py": { bg: "#3572a5", fg: "#fff", t: "PY" },
  ".go": { bg: "#00add8", fg: "#fff", t: "GO" },
  ".rs": { bg: "#ce512a", fg: "#fff", t: "RS" },
  ".json": { bg: "#1e2530", fg: "#f7df1e", t: "{}", border: "#555" },
  ".yaml": { bg: "#cb171e", fg: "#fff", t: "YML" },
  ".yml": { bg: "#cb171e", fg: "#fff", t: "YML" },
  ".md": { bg: "#083fa1", fg: "#fff", t: "MD" },
  ".html": { bg: "#e34c26", fg: "#fff", t: "HTML" },
  ".sh": { bg: "#4eaa25", fg: "#fff", t: "SH" },
};
function getFileBadge(ext) {
  var dot = ext && !ext.startsWith(".") ? "." + ext : ext;
  var ic = FICONS[dot] || {
    bg: "#3a4a5a",
    fg: "#aaa",
    t: (ext || "?").replace(".", "").toUpperCase().slice(0, 4),
  };
  var border = ic.border ? "border:1px solid " + ic.border + ";" : "";
  return (
    '<span class="fbadge" style="background:' +
    ic.bg +
    ";color:" +
    ic.fg +
    ";" +
    border +
    '">' +
    ic.t +
    "</span>"
  );
}
function getFolderSvg(c) {
  c = c || "#dcb67a";
  return (
    '<svg width="16" height="14" viewBox="0 0 16 14" fill="none"><path d="M1.5 3A1 1 0 0 1 2.5 2H6.17a1 1 0 0 1 .71.29L8.12 3.5A1 1 0 0 0 8.83 3.8H13.5A1 1 0 0 1 14.5 4.8V11.5A1 1 0 0 1 13.5 12.5H2.5A1 1 0 0 1 1.5 11.5V3Z" fill="' +
    c +
    '" opacity="0.85"/></svg>'
  );
}
var FOLDER_COLORS = {
  src: "#61dafb",
  components: "#a78bfa",
  pages: "#fb923c",
  api: "#34d399",
  utils: "#facc15",
  hooks: "#f472b6",
  store: "#f87171",
  styles: "#cf649a",
  public: "#94a3b8",
  config: "#94a3b8",
  types: "#60a5fa",
  tests: "#a3e635",
  scripts: "#4ade80",
  server: "#e879f9",
  plugins: "#f59e0b",
};
function getFolderColor(name) {
  return "#f472b6";
}
function escHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function formatSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + "KB";
  return (bytes / 1048576).toFixed(1) + "MB";
}

// ═══════════════════════════════════════════════════════════
// OTA UPDATE CHECK
// ═══════════════════════════════════════════════════════════
function semverGt(a, b) {
  // returns true if version string a > b
  var pa = a.split(".").map(Number);
  var pb = b.split(".").map(Number);
  for (var i = 0; i < 3; i++) {
    var na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}

var _UPDATE_DISMISS_KEY = "repodna-update-dismissed";
async function checkForUpdate() {
  try {
    var r = await fetch("/api/check-update");
    var d = await r.json();
    if (!d.ok || !d.latest) return;
    if (!semverGt(d.latest, d.current)) return;

    // Dismissal is scoped to (serverStartId, latestVersion): survives a browser
    // refresh, but a fresh `node main.mjs` boot mints a new id and the banner
    // returns. Falls back to plain version if the server didn't send an id.
    var dismissToken = (d.serverStartId ? d.serverStartId + ":" : "") + d.latest;
    try {
      if (localStorage.getItem(_UPDATE_DISMISS_KEY) === dismissToken) return;
    } catch (e) {}

    var banner  = document.getElementById("update-banner");
    var verEl   = document.getElementById("update-banner-version");
    var curEl   = document.getElementById("update-banner-current");
    var link    = document.getElementById("update-banner-link");
    var copyBtn = document.getElementById("update-banner-copy");
    var copyLbl = document.getElementById("update-banner-copy-label");
    var closeBtn = document.getElementById("update-banner-close");
    if (!banner || !verEl || !link || !copyBtn || !closeBtn) return;

    verEl.textContent = "v" + d.latest;
    if (curEl) curEl.textContent = "you have v" + d.current;
    link.href = d.url;

    var copyResetTimer = null;
    copyBtn.onclick = async function() {
      var cmd = "node update.mjs";
      var ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(cmd);
          ok = true;
        } else {
          var ta = document.createElement("textarea");
          ta.value = cmd; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select();
          ok = document.execCommand("copy");
          document.body.removeChild(ta);
        }
      } catch (e) { ok = false; }
      if (ok) {
        copyBtn.classList.add("is-copied");
        if (copyLbl) copyLbl.textContent = "Copied — run in your terminal";
        if (copyResetTimer) clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(function() {
          copyBtn.classList.remove("is-copied");
          if (copyLbl) copyLbl.textContent = "Copy update command";
        }, 2400);
      }
    };

    closeBtn.onclick = function() {
      try { localStorage.setItem(_UPDATE_DISMISS_KEY, dismissToken); } catch (e) {}
      banner.classList.remove("is-visible");
    };

    banner.classList.add("is-visible");
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════
// FILE EXT HELPER
// ═══════════════════════════════════════════════════════════
function fileExt(path) {
  var m = (path || "").match(/(\.[^./\\]+)$/);
  return m ? m[1] : "";
}

// ═══════════════════════════════════════════════════════════
// APP LOADER
// ═══════════════════════════════════════════════════════════
var _appRevealed = false;
function _revealApp() {
  if (_appRevealed) return;
  _appRevealed = true;
  var loader = document.getElementById("app-loader");
  if (!loader) return;
  loader.classList.add("hidden");
  setTimeout(function () { if (loader.parentNode) loader.parentNode.removeChild(loader); }, 180);
}

// ═══════════════════════════════════════════════════════════
// SSE
// ═══════════════════════════════════════════════════════════
var es = null;
var _sseReconnectTimer = null;
var _sseBackoff = 3000; // ms, grows on repeated failure, capped at 30s
function connectSSE() {
  // Cancel any pending reconnect and close the previous EventSource
  // so we don't leak zombie connections when the server is unreachable.
  if (_sseReconnectTimer) {
    clearTimeout(_sseReconnectTimer);
    _sseReconnectTimer = null;
  }
  if (es) {
    try { es.close(); } catch (_) {}
    es = null;
  }
  // Don't try while the tab is hidden — wait for visibilitychange.
  if (typeof document !== "undefined" && document.hidden) return;
  es = new EventSource("/events");

  // ── Log: only show entries belonging to the current run ──
  es.addEventListener("log", function (e) {
    var d = JSON.parse(e.data);
    if (d.ts >= _currentRunStartTs) appendLog(d);
  });

  // ── run_start: server tells us where this run's logs begin and when it started ──
  es.addEventListener("run_start", function (e) {
    var d = JSON.parse(e.data);
    S.currentRunLogStart = d.logStart;
    document.getElementById("log-list").innerHTML = "";
    document.getElementById("log-count").textContent = "0";
    // Use actual run startedAt so replayed log timestamps pass the >= filter
    _currentRunStartTs = d.startedAt || Date.now() - 86400000;
  });

  // ── ui_page: restore wizard step pills on refresh ──
  es.addEventListener("ui_page", function (e) {
    var d = JSON.parse(e.data);
    var page = typeof d.page === "number" ? d.page : S.currentPage;
    document.querySelectorAll(".wizard-page").forEach(function (p) {
      p.classList.remove("active");
    });
    var pg = document.getElementById("page-" + page);
    if (pg) pg.classList.add("active");
    document.querySelectorAll(".step-pill").forEach(function (p, i) {
      p.classList.remove("active", "done");
      if (i === page) p.classList.add("active");
      else if (i < page) p.classList.add("done");
    });
    S.currentPage = page;
    // Steps 2+ all depend on a scanned tree (projectType, file counts, summary).
    // On refresh from step 3 or 4 the tree was never loaded, so the review showed
    // "UNKNOWN" / 0 files. Load it for any page that needs it, then rebuild the
    // review once the scan finishes so projectType and file count are accurate.
    if (page >= 2 && S.projectPath && S.treeData.length === 0) {
      var _treeReady = loadFileTree();
      if (page === 4) {
        Promise.resolve(_treeReady).then(function () {
          buildReview();
          buildAgentSelector();
        });
      }
    } else if (page === 4 && S.projectPath) {
      buildReview();
      buildAgentSelector();
    }
    _revealApp();
  });

  // ── phase: show dashboard for running/paused/done ──
  es.addEventListener("phase", function (e) {
    var d = JSON.parse(e.data);
    var dash = document.getElementById("dashboard");
    if (dash) dash.classList.remove("run-paused", "run-done");
    if (d.phase === "running") {
      S.runPhase = "running";
      if (!S.dashboardShown) showDashboard();
      updateRunControls();
      _startElapsedTimer();
    }
    if (d.phase === "paused") {
      S.runPhase = "paused";
      if (dash) dash.classList.add("run-paused");
      if (!S.dashboardShown) showDashboard();
      updateRunControls();
      _stopElapsedTimer();
    }
    if (d.phase === "done") {
      S.runPhase = "done";
      if (dash) dash.classList.add("run-done");
      if (!S.dashboardShown) showDashboard();
      updateRunControls();
      _stopElapsedTimer();
      onDone();
    }
    if (d.phase === "wizard") {
      S.runPhase = "idle";
      _stopElapsedTimer();
    }
  });

  es.addEventListener("progress", function (e) {
    updateProgress(JSON.parse(e.data));
  });

  // ── file_list: full ordered list for the run (processable + re-added + deleted) ──
  es.addEventListener("file_list", function (e) {
    var d = JSON.parse(e.data);
    S.fileList = d.files || [];
    S.fileChangeTypes = d.changeTypes || {};
    S.retriedFileIds = new Set();
    var deletedSet = new Set(d.deletedSet || []);
    for (var i = 0; i < S.fileList.length; i++) {
      var fid = S.fileList[i];
      if (deletedSet.has(fid)) {
        S.fileStatuses[fid] = { status: "deleted" };
      } else if (S.fileChangeTypes[fid] === "readded") {
        S.fileStatuses[fid] = { status: "ok" }; // served from cache — no Ollama call
      } else if (!S.fileStatuses[fid]) {
        S.fileStatuses[fid] = { status: "pending" };
      }
    }
    renderFileList();
  });

  es.addEventListener("file_status", function (e) {
    var d = JSON.parse(e.data);
    S.fileStatuses[d.file] = { status: d.status, error: d.error || null, retrying: !!d.retrying };
    // Server-driven output-based badges (retried/edited) — only set if no
    // hash-based badge already covers this file in the current run.
    var _ct = S.fileChangeTypes[d.file];
    var _hashBased = _ct === "created" || _ct === "modified" || _ct === "readded" || _ct === "removed";
    if (d.changeType && !_hashBased) {
      S.fileChangeTypes[d.file] = d.changeType;
    } else if (d.status === "ok" && S.retriedFileIds.has(d.file) && !_ct) {
      // Legacy fallback (pre-server-side change-type): client-side retry tracking
      S.fileChangeTypes[d.file] = "retried";
    }
    updateFileRow(d.file);
    if (d.status === "ok" && d.tokensPerSecond > 0 && S.model) {
      _saveModelStat(S.model, d.tokensPerSecond);
      renderUserModelsSection();
    }
  });

  // ── result: client-side dedup by file id across all categories ──
  es.addEventListener("result", function (e) {
    var d = JSON.parse(e.data);
    var newItem = { file: d.file, content: d.content, model: d.model || null, precision: d.precision || null };
    // Update S.results in-place to preserve card order; remove from old category if it changed
    var foundInPlace = false;
    for (var cat in S.results) {
      var _arr = S.results[cat];
      for (var _j = 0; _j < _arr.length; _j++) {
        if (_arr[_j].file === d.file) {
          if (cat === d.category) {
            _arr[_j] = newItem;
            foundInPlace = true;
          } else {
            _arr.splice(_j, 1);
          }
          break;
        }
      }
      if (foundInPlace) break;
    }
    if (!foundInPlace) {
      if (!S.results[d.category]) S.results[d.category] = [];
      S.results[d.category].push(newItem);
    }
    renderTabs();
    if (!S.activeTabIsPreview) {
      if (!S.activeTab || S.activeTab === d.category) {
        var _rc = document.getElementById("results-content");
        var _cardSel = '.result-card[data-file="' + CSS.escape(d.file) + '"]';
        var _existing = _rc && _rc.querySelector(_cardSel);
        if (_existing) {
          // Card already in DOM — replace in-place (keeps position) unless user is editing it
          if (_existing.dataset.editing !== 'true') {
            _rc.replaceChild(createResultCard(newItem, d.category), _existing);
          }
        } else if (_rc && _rc.querySelector('.result-card[data-editing="true"]')) {
          // Another card is being edited — just append the new one
          _rc.appendChild(createResultCard(newItem, d.category));
        } else {
          renderResults(S.activeTab || d.category);
        }
      }
    }
  });

  es.addEventListener("preview", function (e) {
    var d = JSON.parse(e.data);
    S.previewContent = d.content || "";
    S.previewFinal = !!d.final;
    if (S.activeTabIsPreview) renderPreview();
    renderTabs();
  });

  es.onopen = function () {
    _sseBackoff = 3000; // reset backoff on successful connection
  };

  es.onerror = function () {
    if (_sseReconnectTimer || _serverOffline) return;
    // Show offline immediately — probe will dismiss it within ~300ms if server is still up
    _onServerOffline();
  };
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && _isLeader && !es) connectSSE();
  });
}

// Track the start timestamp of the current run so we only show current-run logs
var _currentRunStartTs = 0;
var _elapsedTimer = null;
var _elapsedBase = 0; // seconds reported by last progress event
var _elapsedBaseTime = 0; // client Date.now() when that report arrived


function _startElapsedTimer() {
  if (_elapsedTimer) clearInterval(_elapsedTimer);
  _elapsedTimer = setInterval(function () {
    if (S.runPhase !== "running") return;

    // Elapsed — sale in tempo reale
    var el = document.getElementById("s-elapsed");
    if (el && _elapsedBaseTime) {
      var total = _elapsedBase + Math.floor((Date.now() - _elapsedBaseTime) / 1000);
      var m = Math.floor(total / 60), s = total % 60;
      el.textContent = m + ":" + String(s).padStart(2, "0");
    }

  }, 1000);
}

function _stopElapsedTimer() {
  if (_elapsedTimer) {
    clearInterval(_elapsedTimer);
    _elapsedTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════
// SERVER OFFLINE DETECTION
// ═══════════════════════════════════════════════════════════
var _serverOffline = false;
var _serverProbeTimer = null;

function _showServerOfflineBanner() {
  if (document.getElementById("server-offline-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "server-offline-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;backdrop-filter:blur(4px);";
  overlay.innerHTML =
    '<div style="background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:32px;max-width:440px;color:#eee;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);">' +
      '<div style="font-size:42px;margin-bottom:8px;">⚡</div>' +
      '<h2 style="margin:0 0 12px;font-size:18px;">Server is not running</h2>' +
      '<p style="margin:0 0 0;color:#aaa;font-size:14px;line-height:1.5;">Start <code style="background:#2a2a2a;padding:2px 6px;border-radius:4px;">node main.mjs</code> to reconnect. This page will reload automatically when the server comes back.</p>' +
    '</div>';
  document.body.appendChild(overlay);
}

function _cutAllCommunication() {
  if (es) { try { es.close(); } catch (_) {} es = null; }
  if (_sseReconnectTimer) { clearTimeout(_sseReconnectTimer); _sseReconnectTimer = null; }
  if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
  if (_saveProjectTimer) { clearTimeout(_saveProjectTimer); _saveProjectTimer = null; }
}

function _doServerProbe() {
  fetch("/api/ping", { cache: "no-store", signal: AbortSignal.timeout(500) })
    .then(function (r) {
      if (!r.ok) throw new Error();
      _serverOffline = false;
      clearInterval(_serverProbeTimer);
      _serverProbeTimer = null;
      window.location.reload();
    })
    .catch(function () {});
}

function _onServerOffline() {
  if (_serverOffline) return;
  _serverOffline = true;
  _cutAllCommunication();
  // Probe immediately — if it was a brief SSE glitch the overlay vanishes in <500ms
  _doServerProbe();
  // Then keep probing every 1s until server comes back
  _serverProbeTimer = setInterval(_doServerProbe, 1000);
  // Small delay before showing the banner so instant-reconnects don't flash it
  setTimeout(function () {
    if (_serverOffline) _showServerOfflineBanner();
  }, 300);
}

// ═══════════════════════════════════════════════════════════
// SINGLE-TAB LOCK
// ═══════════════════════════════════════════════════════════
// The server holds one shared appState; multiple tabs would race on wizard
// page, auto-saves, and run controls. We elect one leader tab via
// BroadcastChannel; other tabs go read-only with a "Take over" overlay.
var _isLeader = false;
var _tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
var _bc = ("BroadcastChannel" in window) ? new BroadcastChannel("repodna-tab-lock") : null;

function _showFollowerBanner() {
  if (document.getElementById("tab-lock-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "tab-lock-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;backdrop-filter:blur(4px);";
  overlay.innerHTML =
    '<div style="background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:32px;max-width:440px;color:#eee;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);">' +
      '<div style="font-size:42px;margin-bottom:8px;">⚠</div>' +
      '<h2 style="margin:0 0 12px;font-size:18px;">Another window is controlling repoDNA</h2>' +
      '<p style="margin:0 0 22px;color:#aaa;font-size:14px;line-height:1.5;">Multiple tabs share the same server state and would clobber each other. Take over here to disconnect the other window.</p>' +
      '<button id="tab-lock-takeover" style="background:#3b82f6;border:0;color:white;padding:10px 18px;border-radius:8px;cursor:pointer;font-size:14px;">Take over here</button>' +
    '</div>';
  document.body.appendChild(overlay);
  document.getElementById("tab-lock-takeover").onclick = function () {
    if (_bc) _bc.postMessage({ type: "takeover", from: _tabId });
    _becomeLeader();
  };
}

function _hideFollowerBanner() {
  var overlay = document.getElementById("tab-lock-overlay");
  if (overlay) overlay.remove();
}

function _becomeLeader() {
  if (_isLeader) return;
  _isLeader = true;
  _hideFollowerBanner();
  if (_bc) _bc.postMessage({ type: "alive", from: _tabId });
  connectSSE();
}

function _becomeFollower() {
  _isLeader = false;
  if (es) { try { es.close(); } catch (_) {} es = null; }
  if (_sseReconnectTimer) { clearTimeout(_sseReconnectTimer); _sseReconnectTimer = null; }
  if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
  if (_saveProjectTimer) { clearTimeout(_saveProjectTimer); _saveProjectTimer = null; }
  _showFollowerBanner();
}

function _attemptLeadership() {
  if (!_bc) { _becomeLeader(); return; } // No BroadcastChannel — best-effort single-tab assumption
  _bc.postMessage({ type: "ping", from: _tabId });
  // If no leader replies within 250ms, claim leadership.
  setTimeout(function () {
    if (!_isLeader && !document.getElementById("tab-lock-overlay")) _becomeLeader();
  }, 250);
}

if (_bc) {
  _bc.onmessage = function (ev) {
    var msg = ev.data || {};
    if (!msg || msg.from === _tabId) return;
    if (msg.type === "ping") {
      if (_isLeader) _bc.postMessage({ type: "alive", from: _tabId });
    } else if (msg.type === "alive") {
      if (_isLeader) {
        // Two leaders: tiebreak by ID (lower wins) so we converge on one.
        if (String(msg.from) < String(_tabId)) _becomeFollower();
      } else {
        _showFollowerBanner();
      }
    } else if (msg.type === "takeover") {
      if (_isLeader) _becomeFollower();
    } else if (msg.type === "leader_closed") {
      if (!_isLeader) _attemptLeadership();
    }
  };
  window.addEventListener("pagehide", function () {
    if (_isLeader && _bc) _bc.postMessage({ type: "leader_closed", from: _tabId });
  });
}

_attemptLeadership();

// ═══════════════════════════════════════════════════════════
// RUN CONTROLS
// ═══════════════════════════════════════════════════════════
function updateRunControls() {
  var dot = document.getElementById("status-dot");
  var pause = document.getElementById("btn-pause");
  var resume = document.getElementById("btn-resume");
  var stop = document.getElementById("btn-stop");
  var newAnalysis = document.getElementById("btn-new-analysis");
  if (!dot) return;
  var active = S.runPhase === "running" || S.runPhase === "paused";
  dot.className =
    "status-dot " +
    (S.runPhase === "running"
      ? "running"
      : S.runPhase === "paused"
        ? "paused"
        : "done");
  pause.style.display = S.runPhase === "running" ? "" : "none";
  resume.style.display = S.runPhase === "paused" ? "" : "none";
  if (stop) stop.style.display = active ? "" : "none";
  if (newAnalysis) newAnalysis.style.display = active ? "none" : "";
}
window._pauseRun = async function () {
  await fetch("/api/pause", { method: "POST" });
};
window._resumeRun = async function () {
  await fetch("/api/resume", { method: "POST" });
};
window._stopRun = async function () {
  if (!confirm("Stop the analysis?")) return;
  // Abort the runner but keep all state in memory so a page refresh can replay it.
  // The SSE "phase: done" event will fire and call onDone() / updateRunControls().
  await fetch("/api/abort", { method: "POST" }).catch(function () {});
};

// ═══════════════════════════════════════════════════════════
// FILE LIST (step 5 — activity panel)
// ═══════════════════════════════════════════════════════════
function renderFileList() {
  var container = document.getElementById("file-run-list");
  if (!container) return;
  container.innerHTML = "";
  var badge = document.getElementById("file-run-count");
  if (S.fileList.length === 0 && S.runPhase !== "idle") {
    container.innerHTML =
      '<div style="color:var(--t4);font-size:11px;padding:10px;font-family:var(--mono);text-align:center">✓ No changed files — all results from cache</div>';
    if (badge) badge.textContent = "0";
    return;
  }
  for (var i = 0; i < S.fileList.length; i++) {
    container.appendChild(createFileRow(S.fileList[i]));
  }
  if (badge) badge.textContent = S.fileList.length;
}

function createFileRow(fid) {
  var st = S.fileStatuses[fid] || { status: "pending" };
  var ext = fileExt(fid);
  var row = document.createElement("div");
  row.className = "file-run-row file-run-" + st.status +
    (st.status === "running" && st.retrying ? " file-run-retrying" : "");
  row.dataset.fileId = fid;

  var statusIcon =
    { pending: "·", running: "⟳", ok: "✓", error: "⚠", deleted: "✕" }[st.status] || "·";
  var statusClass = "frun-status frun-" + st.status;
  var isDeleted = st.status === "deleted";
  var isRetrying = st.status === "running" && st.retrying;
  var isMainRunning = st.status === "running" && !st.retrying;
  var retryBtn;
  if (isDeleted) {
    retryBtn = "";
  } else if (isRetrying) {
    retryBtn = '<button class="frun-stop" title="Stop this file" onclick="_stopFile(\'' +
      escHtml(fid) + "')\">■ stop</button>";
  } else if (isMainRunning) {
    // File is being processed by the main scanner — stopping a single file
    // there would require aborting the whole runner. Hide the button so the
    // user uses the global Stop control instead.
    retryBtn = "";
  } else {
    retryBtn = '<button class="frun-retry" title="Retry this file" onclick="_retryFile(\'' +
      escHtml(fid) + "')\">↺ retry</button>";
  }

  var changeType = S.fileChangeTypes[fid]; // 'created'|'modified'|'readded'|'removed'|'retried'|'edited'|undefined
  var changeBadgeMap = {
    created:  '<span class="frun-change frun-change-created"  title="New file">+</span>',
    modified: '<span class="frun-change frun-change-modified" title="Modified">~</span>',
    readded:  '<span class="frun-change frun-change-readded"  title="Re-added">↩</span>',
    removed:  '<span class="frun-change frun-change-removed"  title="Removed">−</span>',
    retried:  '<span class="frun-change frun-change-retried"  title="Retried">↺</span>',
    edited:   '<span class="frun-change frun-change-edited"   title="Edited">✎</span>',
  };
  var changeBadge = changeBadgeMap[changeType] || "";

  // Main line: status icon + change badge + file-type badge + name + retry
  var mainLine =
    '<div class="frun-row-main">' +
    '<span class="' + statusClass + '">' + statusIcon + "</span>" +
    changeBadge +
    getFileBadge(ext) +
    '<span class="frun-name' + (isDeleted ? " frun-name-deleted" : "") + '" title="' +
    escHtml(fid) +
    '">' +
    escHtml(fid) +
    "</span>" +
    retryBtn +
    "</div>";

  // Error line: only shown when there's an error, below the main line
  var errorLine = st.error
    ? '<div class="frun-error-line" title="' +
      escHtml(st.error) +
      '">⚠ ' +
      escHtml(st.error) +
      "</div>"
    : "";

  row.innerHTML = mainLine + errorLine;
  return row;
}

function updateFileRow(fid) {
  var container = document.getElementById("file-run-list");
  if (!container) return;
  var existing = container.querySelector(
    '[data-file-id="' + CSS.escape(fid) + '"]',
  );
  var newRow = createFileRow(fid);
  if (existing) {
    container.replaceChild(newRow, existing);
  } else {
    // New file (e.g. from retry of a file not in original list)
    if (!S.fileList.includes(fid)) {
      S.fileList.push(fid);
      var _badge = document.getElementById("file-run-count");
      if (_badge) _badge.textContent = S.fileList.length;
    }
    container.appendChild(newRow);
  }
  // Scroll running file into view only when user is already at the bottom (chat-like behavior)
  var st = S.fileStatuses[fid] || {};
  if (st.status === "running") {
    var atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 60;
    if (atBottom) newRow.scrollIntoView({ block: "nearest" });
  }
}

function _refreshResultCard(fid) {
  var container = document.getElementById("results-content");
  if (!container) return;
  var existing = container.querySelector('.result-card[data-file="' + CSS.escape(fid) + '"]');
  if (!existing) return;
  var cat = existing.dataset.cat;
  var items = S.results[cat] || [];
  var item = items.find(function (it) { return it.file === fid; });
  if (!item) return;
  container.replaceChild(createResultCard(item, cat), existing);
}

window._retryFile = async function (fid, precision) {
  // Block re-clicks while the file is already running. The server also
  // dedupes, but this avoids the optimistic UI flicker.
  if ((S.fileStatuses[fid] || {}).status === "running") return;
  if (S.retryingFiles.has(fid)) return;
  var _card = document.querySelector('.result-card[data-file="' + CSS.escape(fid) + '"]');
  if (_card && _card.dataset.editing === 'true') {
    showSnack("Finish or cancel editing this file before retrying.", "warn", 4000);
    return;
  }
  S.retryingFiles.add(fid);
  S.retriedFileIds.add(fid);
  S.fileStatuses[fid] = { status: "running", retrying: true };
  updateFileRow(fid);
  _refreshResultCard(fid); // exits edit mode and disables Edit button while retrying
  try {
    await fetch("/api/retry-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: fid, precision: precision || null }),
    });
  } catch (e) {
    S.fileStatuses[fid] = { status: "error", error: e.message };
    updateFileRow(fid);
  }
  S.retryingFiles.delete(fid);
};

window._stopFile = async function (fid) {
  try {
    await fetch("/api/stop-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: fid }),
    });
  } catch (e) {}
};

window._retryFileWithPrec = function (btn) {
  var ctrl = btn.closest('.retry-ctrl');
  var card = btn.closest('.result-card');
  var sel = ctrl ? ctrl.querySelector('.retry-prec-sel') : null;
  var fid = card ? card.dataset.file : null;
  var prec = sel ? sel.value : null;
  if (fid) window._retryFile(fid, prec);
};

// ═══════════════════════════════════════════════════════════
// PAGE 0 — CHECKS
// ═══════════════════════════════════════════════════════════
async function runChecks() {
  S.ollamaOk = false;
  S.ollamaChecking = true;
  renderUserModelsSection();
  var list = document.getElementById("checks-list");
  list.innerHTML = "";
  var ollamaRow = addCheckRow(list, "🦙", "Ollama", "checking", "Local AI server");
  await checkOllamaRow(ollamaRow);
  S.ollamaChecking = false;
  renderUserModelsSection();
}
async function checkOllamaRow(row) {
  var host =
    document.getElementById("ollama-host").value.trim() ||
    "http://localhost:11434";
  S.ollamaHost = host;
  saveCurrentProjectSettings();

  var MAX_ATTEMPTS = 2;
  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      setCheckStatus(row, "checking", "Retrying…");
      await new Promise(function(r) { setTimeout(r, 3000); });
    }
    try {
      var r = await fetch("/api/check-ollama?host=" + encodeURIComponent(host));
      var d = await r.json();

      // If Ollama is responding or this is the last attempt, commit the result
      if (d.ok || attempt === MAX_ATTEMPTS) {
        S.ollamaOk = d.ok;
        S.ollamaModels = (d.models || []).map(function (m) {
          if (typeof m === "string") return { name: m, isCloud: false, size: 0 };
          return { name: m.name, isCloud: !!m.isCloud, size: m.size || 0 };
        });
        var statusLabel = d.ok
          ? "Running · " + S.ollamaModels.length + " models"
          : d.installed
            ? "Installed but not running — run: ollama serve"
            : "Not installed";
        setCheckStatus(row, d.ok ? "ok" : "error", statusLabel);
        populateModels();
        _updateInstallCard(!d.installed && !d.ok);
        return;
      }
      // First attempt failed — retry once before showing error
    } catch(e) {
      if (attempt === MAX_ATTEMPTS) {
        setCheckStatus(row, "error", "Cannot reach Ollama");
        _updateInstallCard(true);
        return;
      }
    }
  }
}
// ─── INSTALL CARD ─────────────────────────────────────────
var _currentOs = (function () {
  var p = navigator.platform.toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("mac") || p.includes("iphone") || p.includes("ipad")) return "mac";
  return "linux";
})();

var _OS_DATA = {
  windows: {
    methods: [
      {
        label: "Via winget (recommended)",
        cmd: "winget install Ollama.Ollama",
      },
      {
        label: "Or download the installer",
        link: "https://ollama.com/download/OllamaSetup.exe",
        linkLabel: "⬇ Download OllamaSetup.exe",
      },
    ],
    note: "After installation, Ollama starts automatically in the system tray. Run <code>ollama serve</code> in a terminal if it doesn't start.",
  },
  mac: {
    methods: [
      {
        label: "Via Homebrew",
        cmd: "brew install ollama",
      },
      {
        label: "Or download the app",
        link: "https://ollama.com/download/Ollama-darwin.zip",
        linkLabel: "⬇ Download for macOS",
      },
    ],
    note: "After installing, run <code>ollama serve</code> in a terminal to start the server, then click Re-check above.",
  },
  linux: {
    methods: [
      {
        label: "Official one-line install script",
        cmd: "curl -fsSL https://ollama.com/install.sh | sh",
      },
      {
        label: "More options & manual install",
        link: "https://ollama.com/download/linux",
        linkLabel: "⬇ Ollama for Linux",
      },
    ],
    note: "Supports x86_64 and ARM64. The script installs and starts Ollama as a systemd service automatically.",
  },
};

function _updateInstallCard(show) {
  var card = document.getElementById("install-card");
  if (!card) return;
  card.classList.toggle("visible", show);
  var modelsCard = document.getElementById("installed-models-card");
  if (modelsCard) modelsCard.style.display = show ? "none" : "";
  if (show) {
    _selectOs(_currentOs, null);
  }
}

function _updateCloudLoginHint(show) {
  var el = document.getElementById("cloud-login-hint");
  if (el) el.style.display = show ? "flex" : "none";
}

window._dismissCloudLoginHint = function() {
  _updateCloudLoginHint(false);
};

window._selectOs = function (os, btn) {
  _currentOs = os;
  document.querySelectorAll(".install-os-btn").forEach(function (b) {
    b.classList.toggle("active", b.dataset.ostab === os);
  });
  // Render install content
  var data = _OS_DATA[os];
  if (!data) return;
  var html = "";
  for (var i = 0; i < data.methods.length; i++) {
    var m = data.methods[i];
    html += '<div class="install-method">';
    html += '<div class="install-method-label">' + "</div>";
    if (m.cmd) {
      html +=
        '<div class="install-cmd-row">' +
        '<code>' + escHtml(m.cmd) + '</code>' +
        '<button class="install-cmd-copy" onclick="window._copyCmd(this,\'' +
        m.cmd.replace(/'/g, "\\'") +
        "');\">copy</button>" +
        "</div>";
    }
    html += "</div>";
  }
  var content = document.getElementById("os-install-content");
  if (content) content.innerHTML = html;
  var note = document.getElementById("os-install-note");
  if (note) note.innerHTML = data.note || "";
};

window._copyCmd = function (btn, cmd) {
  navigator.clipboard.writeText(cmd).then(function () {
    var orig = btn.textContent;
    btn.textContent = "Copied!";
    btn.style.color = "var(--a)";
    setTimeout(function () {
      btn.textContent = orig;
      btn.style.color = "";
    }, 1800);
  }).catch(function () {
    // Fallback for browsers without clipboard API
    var ta = document.createElement("textarea");
    ta.value = cmd;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    btn.textContent = "Copied!";
    setTimeout(function () { btn.textContent = "Copy"; }, 1800);
  });
};
window._recheckOllama = async function () {
  var rows = document
    .getElementById("checks-list")
    .querySelectorAll(".check-row");
  if (rows.length >= 1) {
    S.ollamaOk = false;
    S.ollamaChecking = true;
    renderUserModelsSection();
    setCheckStatus(rows[0], "checking", "Checking…");
    await checkOllamaRow(rows[0]);
    S.ollamaChecking = false;
  }
  renderUserModelsSection();
};
function addCheckRow(container, icon, name, status, detail) {
  var row = document.createElement("div");
  row.className = "check-row";
  var iconHtml;
  if (name === "Node.js") {
    iconHtml =
      '<img src="/shared/assets/nodejs-icon.svg" width="26" height="26" style="object-fit:contain;flex-shrink:0" alt="Node.js">';
  } else if (name === "Ollama") {
    iconHtml =
      '<img src="/shared/assets/ollama-icon.svg" width="26" height="26" style="object-fit:contain;flex-shrink:0" alt="Ollama">';
  } else {
    iconHtml = '<span class="check-icon">' + icon + "</span>";
  }
  row.innerHTML =
    '<div class="check-label">' +
    iconHtml +
    '<div><div style="font-size:13px;font-weight:500;color:var(--t1)">' +
    escHtml(name) +
    "</div>" +
    '<div class="check-detail">' +
    escHtml(detail) +
    "</div></div>" +
    "</div>" +
    '<span class="check-status ' +
    status +
    '">' +
    (status === "checking" ? "Checking…" : status) +
    "</span>";
  container.appendChild(row);
  return row;
}
function setCheckStatus(row, status, label) {
  var s = row.querySelector(".check-status");
  s.className = "check-status " + status;
  s.textContent = label;
}

// ─── DESC CARD TOGGLE ─────────────────────────────────────
function setDescCardEnabled(on) {
  var card = document.getElementById("desc-card");
  if (!card) return;
  card.style.opacity = on ? "" : "0.45";
  card.style.pointerEvents = on ? "" : "none";
}

function updateModelWarning() {
  var warn = document.getElementById("model-warning");
  if (warn) warn.style.display = S.model ? "none" : "";
}

var _modelDropdownOpen = false;

function _getModelIcon(isCloud, size) {
  size = size || 14;
  return isCloud
    ? '<svg class="model-dropdown-item-icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="currentColor"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>'
    : '<svg class="model-dropdown-item-icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
}

window._toggleModelDropdown = function() {
  var dd = document.getElementById('model-dropdown');
  if (!dd) return;
  _modelDropdownOpen = !_modelDropdownOpen;
  dd.classList.toggle('open', _modelDropdownOpen);
};

window._selectModelDropdown = function(name, isCloud) {
  S.model = name;
  var sel = document.getElementById('model-select');
  if (sel) sel.value = name;
  // update trigger label
  var label = document.getElementById('model-dropdown-label');
  if (label) label.innerHTML = _getModelIcon(isCloud, 15) +
    '<span style="font-family:var(--mono);font-size:12px">' + escHtml(name) + '</span>';
  // mark selected item
  document.querySelectorAll('.model-dropdown-item').forEach(function(el) {
    el.classList.toggle('selected', el.dataset.value === name);
  });
  // close
  _modelDropdownOpen = false;
  var dd = document.getElementById('model-dropdown');
  if (dd) dd.classList.remove('open');
  saveCurrentProjectSettings();
  updateModelWarning();
  _updateCloudLoginHint(isCloud);
};

// close on outside click
document.addEventListener('click', function(e) {
  var dd = document.getElementById('model-dropdown');
  if (dd && !dd.contains(e.target) && _modelDropdownOpen) {
    _modelDropdownOpen = false;
    dd.classList.remove('open');
  }
});

function populateModels() {
  var list = document.getElementById('model-dropdown-list');
  var label = document.getElementById('model-dropdown-label');
  var sel = document.getElementById('model-select'); // hidden native
  if (!list) return;

  if (!S.ollamaModels.length) {
    list.innerHTML = '<div class="model-dropdown-group-label" style="color:var(--t4)">No models found</div>';
    if (label) label.innerHTML = '<span style="color:var(--t4)">— no models found —</span>';
    updateModelWarning();
    return;
  }

  var locals = S.ollamaModels.filter(function(m) { return !m.isCloud; }).sort(function(a,b){ return a.name.localeCompare(b.name); });
  var clouds = S.ollamaModels.filter(function(m) { return m.isCloud; }).sort(function(a,b){ return a.name.localeCompare(b.name); });

  var html = '';
  if (locals.length) {
    html += '<div class="model-dropdown-group-label">Local</div>';
    locals.forEach(function(m) {
      html += '<div class="model-dropdown-item" data-value="' + escHtml(m.name) + '" onclick="window._selectModelDropdown(\'' + escHtml(m.name) + '\',false)">' +
        _getModelIcon(false) +
        '<span class="model-dropdown-item-name">' + escHtml(m.name) + '</span>' +
        '</div>';
    });
  }
  if (clouds.length) {
    html += '<div class="model-dropdown-group-label">Cloud</div>';
    clouds.forEach(function(m) {
      html += '<div class="model-dropdown-item" data-value="' + escHtml(m.name) + '" onclick="window._selectModelDropdown(\'' + escHtml(m.name) + '\',true)">' +
        _getModelIcon(true) +
        '<span class="model-dropdown-item-name">' + escHtml(m.name) + '</span>' +
        '<span class="model-dropdown-item-type">cloud</span>' +
        '</div>';
    });
  }
  list.innerHTML = html;

  // sync hidden select (kept for compatibility)
  if (sel) {
    sel.innerHTML = '<option value="">—</option>' +
      S.ollamaModels.map(function(m){ return '<option value="' + escHtml(m.name) + '">' + escHtml(m.name) + '</option>'; }).join('');
  }

  // restore selected model
  if (S.model) {
    var found = S.ollamaModels.find(function(m){ return m.name === S.model; });
    if (found) window._selectModelDropdown(S.model, !!found.isCloud);
  } else if (label) {
    label.innerHTML = '<span style="color:var(--t4)">— select a model —</span>';
  }

  updateModelWarning();
}

window._setModelChip = function (name) {
  S.model = name;
  var sel = document.getElementById("model-select");
  var manual = document.getElementById("model-manual");
  if (sel) sel.value = "";
  if (manual) manual.value = name;
  saveCurrentProjectSettings();
  updateModelWarning();
};

// ═══════════════════════════════════════════════════════════
// MODELS CATALOG (page 3)
// ═══════════════════════════════════════════════════════════

async function loadOllamaModelsCatalog() {
  var container = document.getElementById("models-catalog-table");
  if (!container) return;
  try {
    var r = await fetch("/api/ollama-models");
    var d = await r.json();
    if (!d.ok) throw new Error(d.error || "fetch failed");
    _ollamaCatalog = d.data;
    renderModelsCatalog();
  } catch (e) {
    if (container) container.innerHTML =
      '<div style="color:var(--err);font-size:12px;padding:10px">Could not load model catalog: ' + escHtml(e.message) + '</div>';
  }
}

(function() {
  var _tip = null;
  document.addEventListener('mouseover', function(e) {
    var wrap = e.target.closest('.mcat-info-wrap');
    if (!wrap) return;
    var tooltip = wrap.querySelector('.mcat-tooltip');
    if (!tooltip) return;
    _tip = tooltip;
    var btn = wrap.querySelector('.mcat-info-btn');
    var r = btn.getBoundingClientRect();
    tooltip.style.left = Math.min(r.left, window.innerWidth - 260) + 'px';
    tooltip.style.top  = (r.bottom + 8) + 'px';
    tooltip.classList.add('visible');
  });
  document.addEventListener('mouseout', function(e) {
    var wrap = e.target.closest('.mcat-info-wrap');
    if (!wrap) return;
    var tooltip = wrap.querySelector('.mcat-tooltip');
    if (tooltip) tooltip.classList.remove('visible');
  });
})();

window._toggleMcatDesc = function(btn) {
  var row = btn.closest('tr');
  if (!row) return;
  var existing = row.nextSibling;
  if (existing && existing.classList && existing.classList.contains('mcat-desc-row')) {
    existing.remove();
    btn.classList.remove('open');
    return;
  }
  btn.classList.add('open');
  var desc = btn.getAttribute('title');
  var tr = document.createElement('tr');
  tr.className = 'mcat-desc-row';
  var colspan = row.querySelectorAll('td').length;
  tr.innerHTML = '<td colspan="' + colspan + '">' + escHtml(desc) + '</td>';
  row.parentNode.insertBefore(tr, row.nextSibling);
};

function _starsHtml(n) {
  var h = "";
  for (var i = 1; i <= 5; i++)
    h += '<span class="mcat-star ' + (i <= n ? "on" : "off") + '">★</span>';
  return h;
}

function _sizeLabel(m) {
  if (!m.size_b && m.size_b !== 0) return "—";
  if (m.active_params_b) return m.size_b + 'B<div style="font-size:10px;color:var(--t4);margin-top:1px">' + m.active_params_b + 'B active</div>';
  return m.size_b + "B";
}

function renderModelsCatalog() {
  var container = document.getElementById("models-catalog-table");
  if (!container) return;
  if (!_ollamaCatalog || !_ollamaCatalog.models) {
    container.innerHTML = '<div style="color:var(--t4);font-size:12px;text-align:center;padding:20px">No catalog loaded.</div>';
    return;
  }
  var models = _ollamaCatalog.models.filter(function(m) { return m.type === _catalogFilter; });
  if (!models.length) {
    container.innerHTML = '<div style="color:var(--t4);font-size:12px;text-align:center;padding:20px">No models in this category.</div>';
    return;
  }

  // Sort by quality desc, then speed desc
  models = models.slice().sort(function(a,b) {
    if (b.quality_stars !== a.quality_stars) return b.quality_stars - a.quality_stars;
    return b.speed_stars - a.speed_stars;
  });

  var isCloud = _catalogFilter === "cloud";
  var isLocal = !isCloud;

  var html = '<table class="mcat-table"><thead><tr>' +
    '<th>Model</th>' +
    '<th>Size</th>' +
    (isLocal ? '<th>VRAM</th>' : '') +
    '<th>Context</th>' +
    '<th class="mcat-th-stars">Quality</th>' +
    '<th class="mcat-th-stars">Speed</th>' +
    '<th></th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    var isRec = m.tags && m.tags.indexOf("recommended") !== -1;
    var isFlagship = m.tags && m.tags.indexOf("flagship") !== -1;
    var badge = isFlagship
      ? '<span class="mcat-badge flagship">flagship</span>'
      : isRec ? '<span class="mcat-badge recommended">recommended</span>'
      : "";
    var vramCell = isLocal ? '<td class="mcat-cell-vram">' + (m.min_vram_gb ? m.min_vram_gb + " GB" : "—") + '</td>' : '';
    var contextLabel = m.context_k >= 1000 ? (m.context_k/1000).toFixed(0) + "M" : m.context_k + "k";
    var pullCmd = "ollama pull " + m.ollama_model;

    var rowClass = "mcat-row" + (isFlagship ? " is-flagship" : isRec ? " is-recommended" : "");
    html += '<tr class="' + rowClass + '">' +
      '<td class="mcat-cell-name">' +
        '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">' +
          '<span class="mcat-name-main">' + escHtml(m.name) + '</span>' +
          (m.description ? '<span class="mcat-info-wrap"><span class="mcat-info-btn">i</span><span class="mcat-tooltip">' + escHtml(m.description) + '</span></span>' : '') +
          badge +
        '</div>' +
      '</td>' +
      '<td class="mcat-cell-size">' + _sizeLabel(m) + '</td>' +
      vramCell +
      '<td class="mcat-cell-ctx">' + contextLabel + '</td>' +
      '<td class="mcat-cell-stars">' + _starsHtml(m.quality_stars) + '</td>' +
      '<td class="mcat-cell-stars">' + _starsHtml(m.speed_stars) + '</td>' +
      '<td class="mcat-cell-action">' +
        '<button class="mcat-pull-btn" onclick="window._showModelPullPopup(\'' +
        escHtml(m.name) + '\',\'' + escHtml(pullCmd) + '\',\'' + escHtml(m.type) + '\')" title="Show pull command">⬇ Pull</button>' +
      '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  var note = _ollamaCatalog.generated_at
    ? '<div style="margin-top:8px;font-size:10px;color:var(--t4);text-align:right">Catalog updated: ' + escHtml(_ollamaCatalog.generated_at) + '</div>'
    : '';
  container.innerHTML = html + note;
}

function renderUserModelsSection() {
  var el = document.getElementById("user-models-section");
  if (!el) return;
  var headerBtn = document.getElementById('imodel-add-header-btn');
  var recheckBtn = document.getElementById('btn-recheck-ollama');
  var ollamaUp = S.ollamaOk;
  var hasModels = S.ollamaModels && S.ollamaModels.length > 0;

  var checking = S.ollamaChecking;
  if (recheckBtn) recheckBtn.classList.toggle('btn-attention', !ollamaUp && !checking);
  if (headerBtn) {
    headerBtn.disabled = !ollamaUp;
    headerBtn.classList.toggle('btn-attention', ollamaUp && !hasModels);
  }

  if (!hasModels) {
    el.innerHTML =
      '<div class="bb-empty" style="min-height:110px">' +
        '<div class="bb-empty-icon">' +
          '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="color:var(--t3)"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>' +
        '</div>' +
        '<div class="bb-empty-title">No models installed</div>' +
        '<div class="bb-empty-sub">Make sure Ollama is running, then pull your first model from the catalog below.</div>' +
      '</div>';
    return;
  }
  var stats = _getModelStats();
  var sortedModels = S.ollamaModels.slice().sort(function(a, b) {
    if (a.isCloud !== b.isCloud) return a.isCloud ? 1 : -1;
    if (!a.isCloud) return (b.size || 0) - (a.size || 0);
    return a.name.localeCompare(b.name);
  });
  var localSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
  var cloudSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
  var html =
    '<div class="imodels-header">' +
      '<span class="imodel-hdr-name">Model</span>' +
      '<span class="imodel-hdr-size">Size</span>' +
      '<span class="imodel-hdr-speed">tok/s</span>' +
    '</div>' +
    '<div class="imodels-list">';
  for (var i = 0; i < sortedModels.length; i++) {
    var m = sortedModels[i];
    var sizeLabel = m.isCloud ? 'cloud' : _fmtModelSize(m.size);
    var stat = stats[m.name];
    var speed = stat && stat.avg > 0 ? '~' + Math.round(stat.avg) : '—';
    html +=
      '<div class="imodel-row">' +
        '<span class="imodel-type-icon ' + (m.isCloud ? 'imodel-cloud' : 'imodel-local') + '">' + (m.isCloud ? cloudSvg : localSvg) + '</span>' +
        '<span class="imodel-name">' + escHtml(m.name) + '</span>' +
        '<span class="imodel-vram">' + sizeLabel + '</span>' +
        '<span class="imodel-speed" title="Avg generation speed from your runs (tok/s)">' + speed + '</span>' +
      '</div>';
  }
  html += '</div>';
  el.innerHTML = html;

  // If any local model is missing size (server not yet restarted, or Ollama gap),
  // fetch fresh model data once in the background and re-render.
  var needsSize = S.ollamaModels.some(function(m) { return !m.isCloud && !m.size; });
  if (needsSize && !_sizeFetchScheduled) {
    _sizeFetchScheduled = true;
    setTimeout(window._refreshModelSizes, 400);
  }
}

window._refreshModelSizes = async function() {
  try {
    var host = S.ollamaHost || 'http://localhost:11434';
    var r = await fetch('/api/check-ollama?host=' + encodeURIComponent(host));
    var d = await r.json();
    if (d.ok && d.models) {
      S.ollamaModels = d.models.map(function(m) {
        if (typeof m === 'string') return { name: m, isCloud: false, size: 0 };
        return { name: m.name, isCloud: !!m.isCloud, size: m.size || 0 };
      });
      renderUserModelsSection();
    }
  } catch(e) {}
};

window._showModelCatalog = function() {
  var card = document.getElementById("models-reference-card");
  if (!card) return;
  card.style.display = '';
  if (!_ollamaCatalog) loadOllamaModelsCatalog();
  setTimeout(function() { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
};

window._hideModelCatalog = function() {
  var card = document.getElementById("models-reference-card");
  if (card) card.style.display = 'none';
};

window._setCatalogFilter = function(filter, btn) {
  _catalogFilter = filter;
  document.querySelectorAll(".mcat-tab").forEach(function(b) { b.classList.remove("active"); });
  if (btn) btn.classList.add("active");
  renderModelsCatalog();
};

window._setCatalogModelSelect = function(modelName) {
  var sel = document.getElementById("model-select");
  if (sel) {
    // Try to find it in the dropdown first
    var found = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === modelName) { sel.value = modelName; found = true; break; }
    }
    // If not in dropdown, still set it as the chosen model
    S.model = modelName;
    if (found) sel.value = modelName;
    saveCurrentProjectSettings();
    updateModelWarning();
  }
};

window._showModelPullPopup = function(name, cmd, type) {
  var popup = document.getElementById("model-pull-popup");
  var title = document.getElementById("mpopup-title");
  var cmdEl = document.getElementById("mpopup-cmd");
  var noteEl = document.getElementById("mpopup-note");
  if (!popup || !title || !cmdEl) return;
  title.textContent = name;
  cmdEl.textContent = cmd;
  var cloudSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px;margin-right:5px;color:var(--t3)"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
  var localSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:5px;color:var(--t3)"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
  noteEl.innerHTML = type === "cloud"
    ? cloudSvg + "Cloud model — requires an Ollama API key. Log in at <a href='https://ollama.com' target='_blank' rel='noopener' style='color:var(--a)'>ollama.com</a> before pulling."
    : localSvg + "Local model — runs entirely on your machine. Make sure you have enough VRAM before pulling.";
  popup.style.display = "flex";
};

window._closeModelPopup = function() {
  var popup = document.getElementById("model-pull-popup");
  if (popup) popup.style.display = "none";
};

window._copyPopupCmd = function() {
  var cmdEl = document.getElementById("mpopup-cmd");
  var btn = document.querySelector("#model-pull-popup .mpopup-term-copy");
  if (!cmdEl || !btn) return;
  var cmd = cmdEl.textContent;
  navigator.clipboard.writeText(cmd).then(function() {
    var orig = btn.textContent;
    btn.textContent = "Copied!";
    btn.style.color = "var(--a)";
    setTimeout(function() { btn.textContent = orig; btn.style.color = ""; }, 1800);
  }).catch(function() {
    var ta = document.createElement("textarea");
    ta.value = cmd; ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    btn.textContent = "Copied!";
    setTimeout(function() { btn.textContent = "copy"; }, 1800);
  });
};

var _RL_KEY = "repodna_models_refresh_ts";
var _RL_MS  = 60 * 60 * 1000; // 1h

window._refreshModelsCatalog = async function() {
  var btn = document.getElementById("btn-refresh-catalog");
  var msg = document.getElementById("catalog-refresh-msg");

  // Client-side rate limit
  try {
    var _last = parseInt(localStorage.getItem(_RL_KEY) || "0");
    var _remaining = _RL_MS - (Date.now() - _last);
    if (_remaining > 0) {
      var _mins = Math.ceil(_remaining / 60000);
      if (msg) { msg.style.display = ""; msg.textContent = "⏳ Next check available in " + _mins + " min."; }
      return;
    }
  } catch(e) {}

  if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
  if (msg) { msg.style.display = "none"; }

  try {
    var r = await fetch("/api/ollama-models/refresh", { method: "POST" });
    var d = await r.json();
    if (d.rateLimited) {
      if (msg) { msg.style.display = ""; msg.textContent = "⏳ Next check available in " + (d.waitMinutes || 60) + " min."; }
      return;
    }
    if (!d.ok) throw new Error(d.error || "unknown error");
    try { localStorage.setItem(_RL_KEY, String(Date.now())); } catch(e) {}
    _ollamaCatalog = d.data;
    renderModelsCatalog();
    if (msg) {
      msg.style.display = "";
      msg.style.color = "var(--a)";
      msg.textContent = "✓ Catalog updated to " + (d.data.generated_at || "latest") + ".";
      setTimeout(function() { msg.style.display = "none"; msg.style.color = ""; }, 4000);
    }
  } catch(e) {
    if (msg) { msg.style.display = ""; msg.style.color = "var(--err)"; msg.textContent = "✗ " + e.message; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "↻ Check for updates"; }
  }
};

// ═══════════════════════════════════════════════════════════
// PAGE 1 — PROJECT
// ═══════════════════════════════════════════════════════════
async function loadProjectList() {
  var list = document.getElementById("projects-list");
  try {
    var r = await fetch("/api/projects");
    var d = await r.json();
    _projectsList = d.projects || [];
    if (!_projectsList.length) {
      list.innerHTML = '<div class="bb-empty"><div class="bb-empty-icon"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="color:var(--t3)"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div><div class="bb-empty-title">No projects yet</div><div class="bb-empty-sub">Paste a folder path and click + Add, or use Browse…</div></div>';
      setDescCardEnabled(false);
      _updatePathAttention();
      return;
    }
    list.innerHTML = _projectsList
      .map(function (p, i) {
        var sp = _splitPath(p.projectPath);
        var counts = _getFileCounts();
        var cnt = counts[p.projectPath];
        var countBadge = cnt != null ? '<span class="proj-count">' + cnt + '</span>' : '';
        var typeBadge = p.projectType ? '<span class="project-type">' + escHtml(p.projectType) + '</span>' : '';
        return (
          '<div class="project-item ' +
          (p.projectPath === S.projectPath ? "active" : "") +
          '" data-pidx="' + i + '" title="' + escHtml(p.projectPath) + '">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;color:var(--t4)"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>' +
          '<div class="project-info">' +
            '<span class="proj-basename">' + escHtml(sp.base) + '</span>' +
            '<span class="proj-dir">' + escHtml(p.projectPath) + '</span>' +
          '</div>' +
          typeBadge +
          countBadge +
          '<button class="project-remove" data-ridx="' + i + '">✕</button>' +
          '</div>'
        );
      })
      .join("");
    list.querySelectorAll(".project-item").forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (e.target.closest(".project-remove")) return;
        var proj = _projectsList[parseInt(el.dataset.pidx)];
        if (proj) selectProject(proj.projectPath);
      });
    });
    list.querySelectorAll(".project-remove").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var proj = _projectsList[parseInt(btn.dataset.ridx)];
        if (proj) removeProject(proj.projectPath);
      });
    });
  } catch {
    list.innerHTML = '<div style="color:var(--red);font-size:12px">Error</div>';
  }
  _updatePathAttention();
}
async function selectProject(path) {
  document.getElementById("project-path").value = "";
  S.projectPath = path;
  setDescCardEnabled(true);
  await onPathChange(path);
  loadProjectList();
  // Persist last selected project (for restore on reload)
  fetch("/api/save-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath: path }),
  }).catch(function () {});
  try {
    var r = await fetch("/api/projects");
    var d = await r.json();
    var proj = (d.projects || []).find(function (p) {
      return p.projectPath === path;
    });
    applyProjectSettings(proj || null);
  } catch {}
}
async function removeProject(path) {
  if (!confirm("Remove this project?")) return;
  await fetch("/api/projects/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath: path }),
  });
  _clearFileCount(path);
  if (S.projectPath === path) {
    S.projectPath = "";
    S.projectType = "UNKNOWN";
    S.treeData = [];
    S.flatNodes = [];
    S.userOverrides = new Map();
    document.getElementById("project-path").value = "";
    // Clear the path hint that was showing the deleted project's info
    var hint = document.getElementById("path-hint");
    if (hint) { hint.textContent = ""; hint.className = "hint"; }
    applyProjectSettings(null);
    setDescCardEnabled(false);
  }
  await loadProjectList();
}
// 'empty' | 'checking' | 'valid' | 'error'
var _pathValidState = "empty";
var _pathDebounceTimer = null;

function _updatePathAttention() {
  var browse = document.getElementById("btn-browse-folder");
  var add = document.getElementById("btn-add-project");
  var hasProjects = _projectsList && _projectsList.length > 0;
  if (hasProjects) {
    if (browse) browse.classList.remove("btn-attention");
    if (add) add.classList.remove("btn-attention");
    return;
  }
  var browseGlows = _pathValidState === "empty" || _pathValidState === "error";
  var addGlows = _pathValidState === "valid";
  if (browse) browse.classList.toggle("btn-attention", browseGlows);
  if (add) add.classList.toggle("btn-attention", addGlows);
}

async function onPathChange(path) {
  // Validation only — never mutates S.projectPath (that's selectProject's job)
  var hint = document.getElementById("path-hint");
  if (!path) {
    hint.textContent = "";
    hint.className = "hint";
    _pathValidState = "empty";
    _updatePathAttention();
    return;
  }
  _pathValidState = "checking";
  _updatePathAttention();
  try {
    var r = await fetch(
      "/api/scan-tree?path=" +
        encodeURIComponent(path) +
        "&customRules=" +
        encodeURIComponent(JSON.stringify(S.customRules)),
    );
    var d = await r.json();
    if (!d.ok) {
      hint.className = "hint red";
      hint.textContent = "Path not found";
      _pathValidState = "error";
      _updatePathAttention();
      return;
    }
    hint.className = "hint";
    hint.textContent = "";
    _setFileCount(path, d.fileCount);
    _pathValidState = "valid";
    _updatePathAttention();
  } catch {
    hint.className = "hint red";
    hint.textContent = "Could not check path";
    _pathValidState = "error";
    _updatePathAttention();
  }
}

(function () {
  var inp = document.getElementById("project-path");
  inp.addEventListener("input", function (e) {
    var v = e.target.value.trim();
    clearTimeout(_pathDebounceTimer);
    var hint = document.getElementById("path-hint");
    if (!v) {
      hint.className = "hint"; hint.textContent = "";
      _pathValidState = "empty";
      _updatePathAttention();
      return;
    }
    // Clear stale error immediately while the user is editing
    if (hint.classList.contains("red")) {
      hint.className = "hint"; hint.textContent = "";
      _pathValidState = "checking";
      _updatePathAttention();
    }
    _pathDebounceTimer = setTimeout(function () { onPathChange(v); }, 520);
  });
  inp.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { clearTimeout(_pathDebounceTimer); onPathChange(e.target.value.trim()); }
  });
  inp.addEventListener("blur", function (e) {
    var v = e.target.value.trim();
    if (v && _pathValidState !== "valid") { clearTimeout(_pathDebounceTimer); onPathChange(v); }
  });
}());
document.getElementById("project-desc").addEventListener("input", function () {
  saveCurrentProjectSettings();
});

// ═══════════════════════════════════════════════════════════
// FOLDER PICKER
// ═══════════════════════════════════════════════════════════
var pickerPath = null;
var _browseAbortCtrl = null;

function _cancelBrowse() {
  if (_browseAbortCtrl) {
    _browseAbortCtrl.abort();
    _browseAbortCtrl = null;
  }
  var btn = document.getElementById("btn-browse-folder");
  if (btn) { btn.disabled = false; btn.textContent = "Browse…"; }
}

window._browsePath = async function () {
  _cancelBrowse();
  var btn = document.getElementById("btn-browse-folder");
  if (btn) { btn.disabled = true; btn.textContent = "Opening…"; }
  _browseAbortCtrl = new AbortController();
  try {
    var r = await fetch("/api/browse-folder", { method: "POST", signal: _browseAbortCtrl.signal });
    var d = await r.json();
    if (d.ok && d.path) {
      document.getElementById("project-path").value = d.path;
      await onPathChange(d.path);
      // Skip the extra "+ Add" click — browsing a folder already signals intent
      // to add it. Manual paste flow still goes through the Add button.
      if (_pathValidState === "valid") {
        await window._addProject();
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      showSnack("Could not open folder picker", "error", 4000);
    }
  } finally {
    _browseAbortCtrl = null;
    if (btn) { btn.disabled = false; btn.textContent = "Browse…"; }
  }
};

window.addEventListener("beforeunload", _cancelBrowse);

window._addProject = async function () {
  var path = document.getElementById("project-path").value.trim();
  if (!path) {
    showSnack('Paste a path or click Browse… to pick a folder.', 'info', 4000);
    document.getElementById("project-path").focus();
    return;
  }
  var hint = document.getElementById("path-hint");
  hint.textContent = "";
  hint.className = "hint";
  try {
    var r = await fetch(
      "/api/scan-tree?path=" +
        encodeURIComponent(path) +
        "&customRules=" +
        encodeURIComponent(JSON.stringify(S.customRules)),
    );
    var d = await r.json();
    if (!d.ok) {
      hint.className = "hint red";
      hint.textContent = "Path doesn't exist or can't be read.";
      _pathValidState = "error";
      _updatePathAttention();
      return;
    }
    // If already exists, just select it without overwriting
    var existing = (_projectsList || []).find(function (p) {
      return p.projectPath === path;
    });
    if (existing) {
      await selectProject(path);
      document.getElementById("project-path").value = "";
      hint.className = "hint";
      hint.textContent = "";
      return;
    }
    S.projectPath = path;
    S.projectType = d.projectType;
    await fetch("/api/projects/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: path,
        projectType: d.projectType,
        description: "",
      }),
    });
    _setFileCount(path, d.fileCount);
    await loadProjectList();
    await selectProject(path);
    document.getElementById("project-path").value = "";
    document.getElementById("project-desc").value = "";
    hint.className = "hint";
    hint.textContent = "";
    _pathValidState = "empty";
    _updatePathAttention();
  } catch (e) {
    hint.className = "hint red";
    hint.textContent = "Error: " + e.message;
    _pathValidState = "error";
    _updatePathAttention();
  }
};

// ═══════════════════════════════════════════════════════════
// PAGE 2 — FILE SELECTION
// ═══════════════════════════════════════════════════════════
async function loadFileTree() {
  var treeEl = document.getElementById("file-tree");
  treeEl.innerHTML =
    '<div class="empty-state" style="min-height:80px"><div class="spinner"></div></div>';
  try {
    var r = await fetch(
      "/api/scan-tree?path=" +
        encodeURIComponent(S.projectPath) +
        "&customRules=" +
        encodeURIComponent(JSON.stringify(S.customRules)),
    );
    var d = await r.json();
    if (!d.ok) {
      treeEl.innerHTML =
        '<div style="color:var(--red);padding:12px">Scan failed</div>';
      return;
    }
    S.treeData = d.tree;
    S.projectType = d.projectType;
    S.newFileIds = new Set(d.newFileIds || []);
    flattenNodes(S.treeData, "");
    // Remove overrides for files that no longer exist (e.g. deleted from disk)
    var _validIds = new Set(S.flatNodes.map(function(n) { return n.id; }));
    for (var _oid of S.userOverrides.keys()) {
      if (!_validIds.has(_oid)) S.userOverrides.delete(_oid);
    }
    renderTree();
    renderSummary();
    renderCategoryChips();
    refreshFileCount();
    if (!S.defaultRules) loadDefaultRules().then(renderAdvSettings);
    else renderAdvSettings();
  } catch (e) {
    treeEl.innerHTML = '<div style="color:var(--red)">Error</div>';
  }
}
function flattenNodes(nodes, prefix) {
  S.flatNodes = [];
  function walk(arr, pfx) {
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      n.id = pfx ? pfx + "/" + n.name : n.name;
      n.isNew = n.type === "file" && S.newFileIds.has(n.id);
      S.flatNodes.push(n);
      if (n.children && n.children.length) walk(n.children, n.id);
    }
  }
  walk(nodes, prefix);
}
function getFinalStatus(node) {
  if (S.userOverrides.has(node.id)) return S.userOverrides.get(node.id);
  if (node.autoStatus === "ambiguous") return "excluded";
  return node.autoStatus;
}
function getDirFinalStatus(node) {
  var hasInc = false;
  function walk(n) {
    if (n.type === "file" && getFinalStatus(n) === "included") hasInc = true;
    if (n.children)
      for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
  }
  walk(node);
  return hasInc ? "included" : "excluded";
}
function getExpandedState() {
  var state = {};
  document.querySelectorAll(".tree-node").forEach(function (n) {
    var id = n.dataset.nodeId;
    if (!id) return;
    var ch = n.querySelector(":scope > .tree-children");
    if (ch) state[id] = !ch.classList.contains("collapsed");
  });
  return state;
}
function applyExpandedState(state) {
  document.querySelectorAll(".tree-node").forEach(function (n) {
    var id = n.dataset.nodeId;
    if (!id || !(id in state)) return;
    var ch = n.querySelector(":scope > .tree-children");
    var tog = n.querySelector(":scope > .tree-row .tree-toggle");
    if (!ch) return;
    if (state[id]) {
      ch.classList.remove("collapsed");
      if (tog) tog.textContent = "▾";
    } else {
      ch.classList.add("collapsed");
      if (tog) tog.textContent = "▸";
    }
  });
}
function applyTreeHighlights() {
  var sel = S.selectedCategories;
  var undecSel = sel.has("__unknown__");
  var newSel = sel.has("__new__");
  var hasCatSel = Array.from(sel).some(function (c) { return c !== "__unknown__" && c !== "__new__"; });
  document.querySelectorAll(".tree-node").forEach(function (el) {
    var nid = el.dataset.nodeId;
    var nd = S.flatNodes.find(function (n) { return n.id === nid; });
    var row = el.querySelector(":scope > .tree-row");
    if (!row) return;
    row.classList.remove("highlight-cat", "highlight-undecided", "highlight-new");
    if (!nd || nd.type !== "file") return;
    if (newSel && nd.isNew) {
      row.classList.add("highlight-new");
    } else if (undecSel && nd.autoStatus === "ambiguous") {
      row.classList.add("highlight-undecided");
    } else if (hasCatSel && sel.has(nd.categoryId || "unknown")) {
      row.classList.add("highlight-cat");
    }
  });
  // Auto-expand any collapsed ancestor folders that contain highlighted files
  document.querySelectorAll(".tree-row.highlight-cat, .tree-row.highlight-undecided, .tree-row.highlight-new").forEach(function (row) {
    var cur = row.parentElement; // .tree-node
    while (cur && cur.id !== "file-tree") {
      var p = cur.parentElement;
      if (!p) break;
      if (p.classList && p.classList.contains("tree-children") && p.classList.contains("collapsed")) {
        p.classList.remove("collapsed");
        var folderNode = p.parentElement;
        if (folderNode) {
          var tog = folderNode.querySelector(":scope > .tree-row .tree-toggle");
          if (tog) tog.textContent = "▾";
        }
      }
      cur = p;
    }
  });
}
function isTreeFilterActive() {
  return (S.treeSearchQuery && S.treeSearchQuery.length > 0) || S.treeFilter !== "all";
}
function renderTree() {
  var expanded = getExpandedState();
  var container = document.getElementById("file-tree");
  container.innerHTML = "";
  // Pre-compute visibility so folder rendering (branch glyphs, mixed-state,
  // Select/Unselect actions) only considers nodes the user actually sees.
  S._visibility = computeTreeVisibility();
  var rootVisible = S.treeData.filter(function (n) { return S._visibility[n.id] !== false; });
  for (var i = 0; i < S.treeData.length; i++) {
    var node = S.treeData[i];
    var isLast = rootVisible.length > 0
      ? node === rootVisible[rootVisible.length - 1]
      : i === S.treeData.length - 1;
    container.appendChild(createTreeNode(node, 0, isLast, []));
  }
  if (Object.keys(expanded).length > 0) applyExpandedState(expanded);
  applyTreeHighlights();
  applyTreeFilters();
  updateExpandToggleLabel();
}
function updateExpandToggleLabel() {
  var btn = document.getElementById("btn-toggle-expand");
  if (!btn) return;
  var anyCollapsed = !!document.querySelector("#file-tree .tree-children.collapsed");
  btn.textContent = anyCollapsed ? "⊞ Expand all" : "⊟ Collapse all";
}

function createTreeNode(node, depth, isLast, lineage) {
  isLast = !!isLast;
  lineage = lineage || [];
  var wrapper = document.createElement("div");
  wrapper.className = "tree-node";
  wrapper.dataset.nodeId = node.id;
  // Indent guides — one column per depth level.
  //   - Column i = depth-1 is the BRANCH column for this node:
  //       └── if this node is last among its siblings, ├── otherwise.
  //   - Column i < depth-1 is a CONTINUATION column for an ancestor's branch.
  //       It carries a vertical pipe IFF that ancestor still has siblings below
  //       this row — i.e., the ancestor at depth (i+1) is NOT last.
  //
  //   `lineage` is built as [root.isLast, parent1.isLast, parent2.isLast, …],
  //   so the ancestor at depth (i+1) lives at lineage[i+1]. Reading lineage[i]
  //   (off by one) was the source of pipes that leaked below a "last" parent or
  //   went missing when a non-last parent sat under a "last" grandparent.
  var indentHTML = "";
  for (var i = 0; i < depth; i++) {
    var isBranchLevel = i === depth - 1;
    var classes = "tree-guide";
    if (isBranchLevel) {
      classes += " tree-guide-branch";
      if (isLast) classes += " tree-guide-last";
    } else if (lineage[i + 1]) {
      classes += " tree-guide-empty";
    }
    indentHTML += '<span class="' + classes + '"></span>';
  }
  if (node.type === "directory") {
    var finalSt = getDirFinalStatus(node);
    var autoSt = node.autoStatus;
    var hasChildren = node.children && node.children.length > 0;
    var isAutoExcluded = autoSt === "excluded";
    var folderColor = getFolderColor(node.name);
    var row = document.createElement("div");
    row.className = "tree-row status-" + finalSt;
    var cbClass, cbIcon;
    if (S.userOverrides.has(node.id)) {
      cbClass = finalSt === "included" ? "cb-included" : "cb-excluded";
      cbIcon = finalSt === "included" ? "✓" : "";
    } else {
      var filterActiveForState = isTreeFilterActive();
      var cs = {};
      function collectSt(n) {
        if (filterActiveForState && S._visibility && S._visibility[n.id] === false) return;
        if (n.type === "file") cs[getFinalStatus(n)] = true;
        if (n.children)
          for (var j = 0; j < n.children.length; j++) collectSt(n.children[j]);
      }
      if (node.children) node.children.forEach(collectSt);
      var keys = Object.keys(cs);
      if (keys.length > 1) {
        cbClass = "cb-mixed";
        cbIcon = "–";
      } else if (keys.length === 1 && keys[0] === "included") {
        cbClass = "cb-included";
        cbIcon = "✓";
      } else if (keys.length === 1) {
        cbClass = "cb-excluded";
        cbIcon = "";
      } else if (finalSt === "included") {
        cbClass = "cb-included";
        cbIcon = "✓";
      } else {
        cbClass = "cb-excluded";
        cbIcon = "";
      }
    }
    var reasonAttrDir = ' title="' + (node.autoExcludeReason ? 'Excluded by rule: ' + escHtml(node.autoExcludeReason) : 'Excluded by a classifier rule') + '"';
    var badge = "";
    if (isAutoExcluded && !S.userOverrides.has(node.id))
      badge = '<span class="tree-badge auto-exc"' + reasonAttrDir + '>excluded</span>';
    else if (autoSt === "ambiguous" && !S.userOverrides.has(node.id))
      badge = '<span class="tree-badge amb" title="No rule matched — click to decide">decide</span>';
    if (S.userOverrides.has(node.id))
      badge =
        finalSt === "included"
          ? '<span class="tree-badge user-inc" title="Manually included">manual</span>'
          : '<span class="tree-badge user-exc" title="Manually excluded">manual</span>';
    // Auto-excluded folders aren't walked by the scanner (children: []), so
    // Select/Unselect can't act on anything. Replace them with a hint pointing
    // the user to Custom Rules, which is where exclusion lives anyway. The hint
    // renders BEFORE the badge so it sits to the left of "excluded" instead of
    // competing with it for the right edge.
    var dirBtnsHTML = hasChildren
      ? '<span class="dir-inline-btns"><button class="dir-btn dir-btn-inc" data-da="include">☑ Select all</button><button class="dir-btn dir-btn-exc" data-da="exclude">☐ Unselect all</button></span>'
      : '';
    var emptyHintHTML = (!hasChildren && isAutoExcluded)
      ? '<span class="dir-empty-hint" title="This folder is excluded by a classifier rule. Remove the rule in Custom Rules → Excluded Folders to include it.">manage in Custom Rules</span>'
      : '';
    row.innerHTML =
      '<span class="tree-checkbox ' +
      cbClass +
      '">' +
      cbIcon +
      '</span>' +
      indentHTML +
      '<span class="tree-toggle">' +
      (hasChildren ? "▸" : "") +
      '</span><span class="tree-ficon">' +
      (isAutoExcluded ? getFolderSvg("#555") : getFolderSvg(folderColor)) +
      '</span><span class="tree-name dir-name ' +
      (finalSt === "excluded" ? "struck" : "") +
      '">' +
      escHtml(node.name) +
      '</span><span class="tree-meta">' +
      emptyHintHTML +
      badge +
      dirBtnsHTML +
      "</span>";
    var childContainer = null;
    if (hasChildren) {
      childContainer = document.createElement("div");
      childContainer.className =
        depth < 2 ? "tree-children" : "tree-children collapsed";
      var childLineage = lineage.concat([isLast]);
      var visibleChildren = node.children.filter(function (c) {
        return !S._visibility || S._visibility[c.id] !== false;
      });
      var lastVisibleChild = visibleChildren.length > 0
        ? visibleChildren[visibleChildren.length - 1]
        : null;
      for (var ci = 0; ci < node.children.length; ci++) {
        var childIsLast = lastVisibleChild
          ? node.children[ci] === lastVisibleChild
          : ci === node.children.length - 1;
        childContainer.appendChild(
          createTreeNode(node.children[ci], depth + 1, childIsLast, childLineage),
        );
      }
      wrapper.appendChild(row);
      wrapper.appendChild(childContainer);
      var toggleEl = row.querySelector(".tree-toggle");
      if (depth < 2) toggleEl.textContent = "▾";
      toggleEl.addEventListener("click", function (e) {
        e.stopPropagation();
        var c = childContainer.classList.toggle("collapsed");
        toggleEl.textContent = c ? "▸" : "▾";
      });
    } else {
      wrapper.appendChild(row);
    }
    row.querySelectorAll(".dir-btn").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var action = btn.dataset.da;
        var filterActive = isTreeFilterActive();
        withHistory(
          (action === "include" ? "Select" : "Unselect") +
            (filterActive ? " visible in folder " : " folder ") + node.name,
          function () {
            function applyAll(n) {
              if (filterActive && S._visibility && S._visibility[n.id] === false) return;
              if (n.type === "file")
                S.userOverrides.set(
                  n.id,
                  action === "include" ? "included" : "excluded",
                );
              if (n.children)
                for (var i = 0; i < n.children.length; i++) applyAll(n.children[i]);
            }
            applyAll(node);
          }
        );
        renderTree();
        renderCategoryChips();
        refreshFileCount();
        renderSummary();
        saveCurrentProjectSettings();
      });
    });
    row.querySelector(".tree-checkbox").addEventListener("click", function (e) {
      e.stopPropagation();
      var filterActive = isTreeFilterActive();
      var allIncluded = true;
      var anyFile = false;
      function checkAll(n) {
        if (filterActive && S._visibility && S._visibility[n.id] === false) return;
        if (n.type === "file") {
          anyFile = true;
          if (getFinalStatus(n) !== "included") allIncluded = false;
        }
        if (n.children) n.children.forEach(checkAll);
      }
      checkAll(node);
      var target = (anyFile && allIncluded) ? "excluded" : "included";
      withHistory(
        (target === "included" ? "Select" : "Unselect") +
          (filterActive ? " visible in folder " : " folder ") + node.name,
        function () {
          function applyAll(n) {
            if (filterActive && S._visibility && S._visibility[n.id] === false) return;
            if (n.type === "file") S.userOverrides.set(n.id, target);
            if (n.children) n.children.forEach(applyAll);
          }
          applyAll(node);
        }
      );
      renderTree();
      renderCategoryChips();
      refreshFileCount();
      renderSummary();
      saveCurrentProjectSettings();
    });
    row.addEventListener("click", function (e) {
      if (
        e.target.closest(".tree-toggle") ||
        e.target.closest(".tree-checkbox") ||
        e.target.closest(".dir-btn")
      )
        return;
      if (hasChildren && childContainer) {
        var c = childContainer.classList.toggle("collapsed");
        toggleEl.textContent = c ? "▸" : "▾";
      }
    });
  } else {
    var finalSt2 = getFinalStatus(node);
    var autoSt2 = node.autoStatus;
    var ext2 = node.extension || "";
    var sizeLabel = node.size ? formatSize(node.size) : "";
    var row2 = document.createElement("div");
    row2.className = "tree-row status-" + finalSt2;
    var reasonAttr2 = ' title="' + (node.autoExcludeReason ? 'Excluded by rule: ' + escHtml(node.autoExcludeReason) : 'Excluded by a classifier rule') + '"';
    var cbClass2, cbIcon2;
    if (S.userOverrides.has(node.id)) {
      cbClass2 = finalSt2 === "included" ? "cb-included" : "cb-excluded";
      cbIcon2 = finalSt2 === "included" ? "✓" : "";
    } else if (autoSt2 === "included") {
      cbClass2 = "cb-included";
      cbIcon2 = "✓";
    } else if (autoSt2 === "ambiguous") {
      cbClass2 = "cb-ambiguous";
      cbIcon2 = "?";
    } else {
      cbClass2 = "cb-excluded";
      cbIcon2 = "";
    }
    var badge2 = "";
    if (autoSt2 === "excluded" && !S.userOverrides.has(node.id))
      badge2 = '<span class="tree-badge auto-exc"' + reasonAttr2 + '>excluded</span>';
    if (autoSt2 === "ambiguous" && !S.userOverrides.has(node.id))
      badge2 = '<span class="tree-badge amb" title="No rule matched — click to decide">decide</span>';
    if (autoSt2 === "ambiguous" && S.userOverrides.has(node.id))
      badge2 = finalSt2 === "included"
        ? '<span class="tree-badge user-inc" title="You chose to include this file">decided ✓</span>'
        : '<span class="tree-badge user-exc" title="You chose to exclude this file">decided ✗</span>';
    if (autoSt2 === "excluded" && S.userOverrides.has(node.id) && finalSt2 === "included")
      badge2 = '<span class="tree-badge user-inc" title="' + (node.autoExcludeReason ? 'Manually included — overrides rule: ' + escHtml(node.autoExcludeReason) : 'Manually included — overrides the exclusion rule') + '">forced ✓</span>';
    var newBadge = node.isNew ? '<span class="tree-badge tree-badge-new" title="New file since last scan">new</span>' : "";
    row2.innerHTML =
      '<span class="tree-checkbox ' +
      cbClass2 +
      '">' +
      cbIcon2 +
      '</span>' +
      indentHTML +
      '<span class="tree-toggle tree-toggle-file"></span><span class="tree-ficon">' +
      getFileBadge(ext2) +
      '</span><span class="tree-name ' +
      (finalSt2 === "excluded" ? "struck" : "") +
      '">' +
      escHtml(node.name) +
      '</span><span class="tree-meta"><span class="tree-size">' +
      sizeLabel +
      "</span>" +
      newBadge +
      badge2 +
      "</span>";
    row2.addEventListener("click", function (e) {
      e.stopPropagation();
      withHistory("Toggle " + node.name, function () {
        if (autoSt2 === "ambiguous") {
          if (!S.userOverrides.has(node.id)) {
            S.userOverrides.set(node.id, "included");
          } else if (S.userOverrides.get(node.id) === "included") {
            S.userOverrides.set(node.id, "excluded");
          } else {
            S.userOverrides.delete(node.id);
          }
        } else {
          if (S.userOverrides.has(node.id)) {
            S.userOverrides.delete(node.id);
          } else {
            S.userOverrides.set(node.id, getFinalStatus(node) === "included" ? "excluded" : "included");
          }
        }
      });
      renderTree();
      renderCategoryChips();
      refreshFileCount();
      renderSummary();
      saveCurrentProjectSettings();
    });
    wrapper.appendChild(row2);
  }
  return wrapper;
}

function renderSummary() {
  var inc = 0,
    exc = 0,
    amb = 0,
    ambDecided = 0,
    totalSize = 0;
  for (var i = 0; i < S.flatNodes.length; i++) {
    var n = S.flatNodes[i];
    if (n.type !== "file") continue;
    var fs = getFinalStatus(n);
    if (fs === "included") {
      inc++;
      totalSize += n.size || 0;
    } else exc++;
    if (n.autoStatus === "ambiguous") {
      amb++;
      if (S.userOverrides.has(n.id)) ambDecided++;
    }
  }
  var tokens = Math.round(totalSize / 4);
  var tokStr = tokens > 1000 ? Math.round(tokens / 1000) + "k" : String(tokens);
  function setEl(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  setEl("p2-type", S.projectType || "—");
  setEl("p2-included", inc);
  setEl("p2-excluded", exc);
  var ambEl = document.getElementById("p2-ambiguous");
  if (ambEl) ambEl.innerHTML = ambDecided + '<span class="p2si-val-sub">/' + amb + '</span>';
  setEl("p2-size", formatSize(totalSize));
  setEl("p2-tokens", tokStr);
}

window._includeAllFiles = function () {
  withHistory("Select all", function () {
    S.flatNodes.forEach(function (n) {
      if (n.type === "file") S.userOverrides.set(n.id, "included");
    });
  });
  renderTree(); renderCategoryChips(); refreshFileCount(); renderSummary(); saveCurrentProjectSettings();
};
window._toggleExpandAll = function (btn) {
  var anyCollapsed = !!document.querySelector("#file-tree .tree-children.collapsed");
  var expand = anyCollapsed; // if anything is collapsed, expand; otherwise collapse
  document.querySelectorAll("#file-tree .tree-children").forEach(function (cc) {
    if (expand) cc.classList.remove("collapsed");
    else cc.classList.add("collapsed");
  });
  document.querySelectorAll("#file-tree .tree-node").forEach(function (node) {
    var children = node.querySelector(":scope > .tree-children");
    if (!children) return;
    var toggle = node.querySelector(":scope > .tree-row .tree-toggle");
    if (!toggle) return;
    toggle.textContent = children.classList.contains("collapsed") ? "▸" : "▾";
  });
  if (btn) btn.textContent = expand ? "⊟ Collapse all" : "⊞ Expand all";
};
window._excludeAllFiles = function () {
  withHistory("Unselect all", function () {
    S.flatNodes.forEach(function (n) {
      if (n.type === "file") S.userOverrides.set(n.id, "excluded");
    });
  });
  renderTree(); renderCategoryChips(); refreshFileCount(); renderSummary(); saveCurrentProjectSettings();
};

function renderCategoryChips() {
  var container = document.getElementById("category-list");
  if (!container) return;
  var catTotal = {}, catIncluded = {};
  var undecidedCount = 0, undecidedDecidedCount = 0;
  for (var i = 0; i < S.flatNodes.length; i++) {
    var n = S.flatNodes[i];
    if (n.type !== "file") continue;
    var cat = n.categoryId || "unknown";
    catTotal[cat] = (catTotal[cat] || 0) + 1;
    if (getFinalStatus(n) === "included") catIncluded[cat] = (catIncluded[cat] || 0) + 1;
    if (n.autoStatus === "ambiguous") {
      undecidedCount++;
      if (S.userOverrides.has(n.id)) undecidedDecidedCount++;
    }
  }
  var _ciN = (_ciN || 0);
  function _ci(d, ca, cb) {
    var id = 'cig' + (++_ciN), fi = 'cif' + _ciN;
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<defs>' +
      '<linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">' +
      '<stop offset="0%" stop-color="' + ca + '"/><stop offset="100%" stop-color="' + cb + '"/>' +
      '</linearGradient>' +
      '<linearGradient id="' + fi + '" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">' +
      '<stop offset="0%" stop-color="' + ca + '" stop-opacity="0.18"/><stop offset="100%" stop-color="' + cb + '" stop-opacity="0.18"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<g fill="url(#' + fi + ')" stroke="url(#' + id + ')">' + d + '</g>' +
      '</svg>';
  }
  var CL = {
    "source-code": { icon: _ci('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', '#4ade80', '#06b6d4'), label: "Source Code" },
    config:        { icon: _ci('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', '#94a3b8', '#818cf8'), label: "Configuration" },
    docs:          { icon: _ci('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>', '#38bdf8', '#818cf8'), label: "Documentation" },
    styles:        { icon: _ci('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>', '#f472b6', '#e879f9'), label: "CSS Styles" },
    templates:     { icon: _ci('<rect x="2" y="2" width="20" height="4" rx="1"/><rect x="2" y="9" width="9" height="8" rx="1"/><rect x="13" y="9" width="9" height="8" rx="1"/><rect x="2" y="20" width="20" height="2" rx="1"/>', '#c084fc', '#818cf8'), label: "Templates" },
    "data-schema": { icon: _ci('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>', '#fb923c', '#fbbf24'), label: "Data Schema" },
    notebooks:     { icon: _ci('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>', '#fbbf24', '#fb923c'), label: "Notebooks" },
    scripts:       { icon: _ci('<path d="M5 8l6 4-6 4M13 19h8"/>', '#22d3ee', '#4ade80'), label: "Scripts" },
    images:        { icon: _ci('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>', '#fb7185', '#fb923c'), label: "Images" },
    svg:           { icon: _ci('<circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><path d="M5 17A12 12 0 0 1 17 5"/>', '#a78bfa', '#f472b6'), label: "SVG" },
    fonts:         { icon: _ci('<path d="M4 5h16M4 5v3M20 5v3M12 5v16M9 21h6"/>', '#fde68a', '#f59e0b'), label: "Fonts" },
    "audio-video": { icon: _ci('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>', '#e879f9', '#c084fc'), label: "Media" },
    archives:      { icon: _ci('<path d="M1 3h22v5H1z M21 8v13H3V8 M10 12h4"/>', '#fdba74', '#fb923c'), label: "Archives" },
    locks:         { icon: _ci('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', '#ef4444', '#f97316'), label: "Lock files" },
    generated:     { icon: _ci('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>', '#818cf8', '#c084fc'), label: "Generated" },
    logs:          { icon: _ci('<path d="M4 4h16v3H4zM4 10h12M4 14h14M4 18h9M4 21h12"/>', '#a3e635', '#4ade80'), label: "Logs" },
    certs:         { icon: _ci('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', '#fcd34d', '#fb923c'), label: "Certificates" },
    unknown:       { icon: _ci('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', '#64748b', '#94a3b8'), label: "Other" },
  };
  var entries = Object.entries(catTotal)
    .filter(function (e) { return e[1] > 0; })
    .sort(function (a, b) { return b[1] - a[1]; });
  function makeBulkMenuHtml(cat) {
    var extra = cat === "__unknown__"
      ? '<button class="cat-und-btn cat-und-table" data-und-action="table" title="Open the resolve table">📋 Table</button>'
      : '';
    return (
      '<button class="cat-und-trigger" type="button">⋯</button>' +
      '<div class="cat-und-btns">' +
      '<button class="cat-und-btn cat-und-inc" data-und-action="include">☑ all</button>' +
      '<button class="cat-und-btn cat-und-exc" data-und-action="exclude">☐ all</button>' +
      extra +
      '</div>'
    );
  }
  var html = "";
  // "New" chip — files created in the last smart update
  var newCount = 0, newIncluded = 0;
  for (var _ni = 0; _ni < S.flatNodes.length; _ni++) {
    var _nn = S.flatNodes[_ni];
    if (_nn.type === "file" && _nn.isNew) {
      newCount++;
      if (getFinalStatus(_nn) === "included") newIncluded++;
    }
  }
  if (newCount > 0) {
    var newSel = S.selectedCategories.has("__new__");
    var newPct = newCount > 0 ? Math.round((newIncluded / newCount) * 100) : 0;
    html +=
      '<div class="cat-item cat-new' + (newSel ? " cat-selected" : "") + '" data-cat="__new__" title="' + newIncluded + '/' + newCount + ' selected">' +
      '<div class="cat-icon-col"><span class="cat-icon">' + _ci('<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>', '#7dd3fc', '#c084fc') + '</span><span class="cat-count">' + newCount + '</span></div>' +
      '<div class="cat-right"><span class="cat-name cat-new-name">New</span>' +
      '<div class="cat-bar-wrap"><div class="cat-bar cat-new-bar"><div class="cat-bar-fill cat-new-bar-fill" style="width:' + newPct + '%"></div></div></div>' +
      '</div>' + makeBulkMenuHtml("__new__") + '</div>';
  }
  if (undecidedCount > 0) {
    var undSel = S.selectedCategories.has("__unknown__");
    var undDecidedPct = Math.round((undecidedDecidedCount / undecidedCount) * 100);
    var undUndecidedPct = 100 - undDecidedPct;
    html +=
      '<div class="cat-item cat-undecided' + (undSel ? " cat-selected" : "") + '" data-cat="__unknown__" title="' + undecidedDecidedCount + '/' + undecidedCount + ' decided">' +
      '<div class="cat-icon-col"><span class="cat-icon">' + _ci('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4"/><circle cx="12" cy="17.5" r="0.4"/>', '#f59e0b', '#ef4444') + '</span><span class="cat-count">' + undecidedCount + '</span></div>' +
      '<div class="cat-right"><span class="cat-name">To decide</span>' +
      '<div class="cat-bar-wrap"><div class="cat-bar cat-und-bar">' +
      '<div class="cat-und-decided-fill" style="width:' + undDecidedPct + '%"></div>' +
      '<div class="cat-und-undecided-fill" style="width:' + undUndecidedPct + '%"></div>' +
      '</div></div>' +
      '</div>' +
      makeBulkMenuHtml("__unknown__") +
      '</div>';
  }
  html += entries.map(function (entry) {
    var cat = entry[0], total = entry[1];
    var inc = catIncluded[cat] || 0;
    var info = CL[cat] || { icon: "📄", label: cat };
    var isSel = S.selectedCategories.has(cat);
    var pct = total > 0 ? Math.round((inc / total) * 100) : 0;
    return (
      '<div class="cat-item' + (isSel ? " cat-selected" : "") + '" data-cat="' + cat + '" title="' + inc + '/' + total + ' selected">' +
      '<div class="cat-icon-col"><span class="cat-icon">' + info.icon + '</span><span class="cat-count">' + total + '</span></div>' +
      '<div class="cat-right"><span class="cat-name">' + info.label + '</span>' +
      '<div class="cat-bar-wrap"><div class="cat-bar"><div class="cat-bar-fill" style="width:' + pct + '%"></div></div></div>' +
      '</div>' + makeBulkMenuHtml(cat) + '</div>'
    );
  }).join("");
  container.innerHTML = html;
  container.querySelectorAll(".cat-item").forEach(function (el) {
    el.addEventListener("click", function (e) {
      if (e.target.closest(".cat-und-trigger") || e.target.closest(".cat-und-btn")) return;
      var cat = el.dataset.cat;
      if (S.selectedCategories.has(cat)) {
        S.selectedCategories.delete(cat);
        el.classList.remove("cat-selected");
      } else {
        S.selectedCategories.add(cat);
        el.classList.add("cat-selected");
      }
      applyTreeHighlights();
    });
  });
  container.querySelectorAll(".cat-und-trigger").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var item = btn.closest(".cat-item");
      if (!item) return;
      // If this chip's menu is already open, close it.
      if (item.classList.contains("cat-und-open")) {
        closeCatMenu(item);
        return;
      }
      // Close any other open menu first.
      document.querySelectorAll(".cat-item.cat-und-open").forEach(closeCatMenu);
      openCatMenu(item, btn);
    });
  });
  container.querySelectorAll(".cat-und-btn").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var item = btn.closest(".cat-item");
      var cat = item ? item.dataset.cat : null;
      var action = btn.dataset.undAction;
      if (action === "table") {
        if (item) closeCatMenu(item);
        window._openResolveTable();
        return;
      }
      var target = action === "include" ? "included" : "excluded";
      var catLabel = cat === "__unknown__" ? "Decide"
                   : cat === "__new__" ? "New files"
                   : cat;
      withHistory(
        (target === "included" ? "Select" : "Unselect") + " category " + catLabel,
        function () {
          S.flatNodes.forEach(function (n) {
            if (n.type !== "file") return;
            var matches;
            if (cat === "__unknown__") matches = n.autoStatus === "ambiguous";
            else if (cat === "__new__") matches = n.isNew;
            else matches = (n.categoryId || "unknown") === cat;
            if (matches) S.userOverrides.set(n.id, target);
          });
        }
      );
      if (item) closeCatMenu(item);
      renderTree();
      renderCategoryChips();
      refreshFileCount();
      renderSummary();
      saveCurrentProjectSettings();
    });
  });
}

function openCatMenu(item, trigger) {
  var menu = item.querySelector(".cat-und-btns");
  if (!menu) return;
  item.classList.add("cat-und-open");
  var r = trigger.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = (r.top + r.height / 2) + "px";
  menu.style.left = (r.right + 6) + "px";
  menu.style.transform = "translateY(-50%)";
  menu.style.zIndex = "1000";
  var onEvent = function (ev) {
    if (!document.body.contains(item)) { closeCatMenu(item); return; }
    if (ev.type === "click") {
      if (item.contains(ev.target) || menu.contains(ev.target)) return;
    }
    closeCatMenu(item);
  };
  item._catMenuCleanup = function () {
    document.removeEventListener("click", onEvent, true);
    window.removeEventListener("scroll", onEvent, true);
    window.removeEventListener("resize", onEvent, true);
  };
  document.addEventListener("click", onEvent, true);
  window.addEventListener("scroll", onEvent, true);
  window.addEventListener("resize", onEvent, true);
}

function closeCatMenu(item) {
  if (!item) return;
  item.classList.remove("cat-und-open");
  var menu = item.querySelector(".cat-und-btns");
  if (menu) menu.style.cssText = "";
  if (item._catMenuCleanup) {
    var c = item._catMenuCleanup;
    item._catMenuCleanup = null;
    c();
  }
}

window._treeFilter = function (f, btn) {
  S.treeFilter = f;
  document
    .querySelectorAll(".tree-filter-group .tree-btn")
    .forEach(function (b) {
      b.classList.remove("active");
    });
  if (btn) btn.classList.add("active");
  // Re-render so folder branch glyphs, mixed-state, and Select/Unselect
  // actions reflect only the currently-visible subset.
  renderTree();
};
window._treeSearch = function (q) {
  S.treeSearchQuery = q;
  renderTree();
};
function computeTreeVisibility() {
  var q = (S.treeSearchQuery || "").toLowerCase();

  function ownMatches(nd) {
    if (q) {
      var name = nd.name.toLowerCase();
      var path = (nd.id || "").toLowerCase();
      if (!name.includes(q) && !path.includes(q)) return false;
    }
    if (nd.type === "directory") {
      // Directories don't have a meaningful status filter — let descendants decide.
      return S.treeFilter === "all";
    }
    var fs = getFinalStatus(nd);
    var isUndecided =
      nd.autoStatus === "ambiguous" && !S.userOverrides.has(nd.id);
    if (S.treeFilter === "included" && fs !== "included") return false;
    if (S.treeFilter === "excluded" && (fs !== "excluded" || isUndecided))
      return false;
    if (S.treeFilter === "ambiguous" && !isUndecided) return false;
    return true;
  }

  // For directories with no visible descendants — typically auto-excluded folders
  // (node_modules, .git, agents/ when excluded) that the scanner doesn't walk into
  // so children is [] — fall back to evaluating the folder on its own status.
  // Without this, those folders disappear from the tree entirely.
  function ownDirMatches(nd) {
    if (q) {
      var name = nd.name.toLowerCase();
      var path = (nd.id || "").toLowerCase();
      if (!name.includes(q) && !path.includes(q)) return false;
    }
    if (S.treeFilter === "all") return true;
    if (S.treeFilter === "ambiguous") return false;
    var fs = getDirFinalStatus(nd);
    if (S.treeFilter === "included") return fs === "included";
    if (S.treeFilter === "excluded") return fs === "excluded";
    return true;
  }

  var visibility = {};
  function compute(nd) {
    var anyChild = false;
    if (nd.children) {
      for (var i = 0; i < nd.children.length; i++) {
        if (compute(nd.children[i])) anyChild = true;
      }
    }
    var visible;
    if (nd.type === "directory") {
      visible = anyChild || ownDirMatches(nd);
    } else {
      visible = ownMatches(nd);
    }
    visibility[nd.id] = visible;
    return visible;
  }
  for (var i = 0; i < S.treeData.length; i++) compute(S.treeData[i]);
  return visibility;
}
function applyTreeFilters() {
  var active = isTreeFilterActive();
  var visibility = S._visibility || {};

  document.querySelectorAll(".tree-node").forEach(function (el) {
    var nid = el.dataset.nodeId || "";
    if (visibility[nid] === false) el.classList.add("hidden-by-filter");
    else el.classList.remove("hidden-by-filter");
  });

  // When filtering is active, auto-expand folders so matches are visible.
  if (active) {
    document.querySelectorAll(".tree-children.collapsed").forEach(function (cc) {
      var folderNode = cc.parentElement;
      if (!folderNode || folderNode.classList.contains("hidden-by-filter")) return;
      cc.classList.remove("collapsed");
      var tog = folderNode.querySelector(":scope > .tree-row .tree-toggle");
      if (tog) tog.textContent = "▾";
    });
  }
}
function refreshFileCount() {
  renderSummary();
}

// ═══════════════════════════════════════════════════════════
// ADVANCED SETTINGS
// ═══════════════════════════════════════════════════════════
window._toggleAdvSettings = function () {}; // no-op, kept for safety
async function loadDefaultRules() {
  try {
    var r = await fetch("/api/default-rules");
    S.defaultRules = (await r.json()).rules;
  } catch {}
}
function renderAdvSettings() {
  var tabs = document.getElementById("adv-tabs");
  var td = [
    { id: "exc-folders", label: "Excluded Folders", icon: "folder", exc: true },
    { id: "exc-exts",    label: "Excluded Extensions", icon: "ext",  exc: true },
    { id: "exc-files",   label: "Excluded Files",      icon: "file", exc: true },
    { id: "inc-exts",    label: "Included Extensions", icon: "ext",  exc: false },
    { id: "inc-files",   label: "Included Files",      icon: "file", exc: false },
  ];
  var _SVGS = {
    folder: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>',
    file:   '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>',
    ext:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>',
  };

  function _iconHtml(t) {
    var color = t.exc ? "#f87171" : "#20e3a0";
    return '<span style="color:' + color + ';display:inline-flex;align-items:center;flex-shrink:0">' + _SVGS[t.icon] + '</span>';
  }

  var active = td.find(function(t){ return t.id === S.advActiveTab; }) || td[0];
  tabs.innerHTML =
    '<div class="adv-csel" id="adv-csel">' +
      '<button class="adv-csel-trigger" id="adv-csel-trigger" type="button">' +
        _iconHtml(active) +
        '<span class="adv-csel-label">' + active.label + '</span>' +
        '<span class="adv-csel-arrow">▾</span>' +
      '</button>' +
      '<div class="adv-csel-dropdown" id="adv-csel-dropdown">' +
        td.map(function(t) {
          return '<button class="adv-csel-option ' + (t.exc ? 'exc' : 'inc') + (t.id === S.advActiveTab ? ' active' : '') +
            '" type="button" data-id="' + t.id + '">' +
            _iconHtml(t) + t.label + '</button>';
        }).join('') +
      '</div>' +
    '</div>';

  var csel    = document.getElementById("adv-csel");
  var trigger = document.getElementById("adv-csel-trigger");
  var dropdown = document.getElementById("adv-csel-dropdown");

  trigger.addEventListener("click", function(e) {
    e.stopPropagation();
    var opening = !csel.classList.contains("open");
    csel.classList.toggle("open");
    if (opening) {
      var r = trigger.getBoundingClientRect();
      dropdown.style.top  = r.top + "px";
      dropdown.style.left = (r.right + 6) + "px";
    }
  });

  dropdown.addEventListener("click", function(e) {
    var btn = e.target.closest(".adv-csel-option");
    if (!btn) return;
    S.advActiveTab = btn.dataset.id;
    csel.classList.remove("open");
    renderAdvSettings();
  });

  document.addEventListener("click", function _closeAdv(e) {
    if (!csel.contains(e.target)) {
      csel.classList.remove("open");
      document.removeEventListener("click", _closeAdv);
    }
  });

  renderAdvContent();
}
function renderAdvContent() {
  var c = document.getElementById("adv-content");
  var dr = S.defaultRules || {};
  var cr = S.customRules;
  var items = [],
    ph = "",
    ak = "";
  switch (S.advActiveTab) {
    case "exc-folders":
      items = (dr.excludedFolders || [])
        .map(function (f) {
          return {
            name: f,
            isDefault: true,
            removeTo: "removedDefaultExcludedFolders",
            isRemoved: cr.removedDefaultExcludedFolders.includes(f),
          };
        })
        .concat(
          cr.excludedFolders.map(function (f) {
            return {
              name: f,
              isDefault: false,
              removeFrom: "excludedFolders",
              isAdded: true,
            };
          }),
        );
      ph = "Folder";
      ak = "excludedFolders";
      break;
    case "exc-exts":
      items = (dr.excludedExtensions || [])
        .map(function (e) {
          return {
            name: e,
            isDefault: true,
            removeTo: "removedDefaultExcludedExtensions",
            isRemoved: cr.removedDefaultExcludedExtensions.includes(e),
          };
        })
        .concat(
          cr.excludedExtensions.map(function (e) {
            return {
              name: e,
              isDefault: false,
              removeFrom: "excludedExtensions",
              isAdded: true,
            };
          }),
        );
      ph = "Extension";
      ak = "excludedExtensions";
      break;
    case "exc-files":
      items = (dr.excludedFilenames || [])
        .map(function (f) {
          return {
            name: f,
            isDefault: true,
            removeTo: "removedDefaultExcludedFilenames",
            isRemoved: cr.removedDefaultExcludedFilenames.includes(f),
          };
        })
        .concat(
          cr.excludedFilenames.map(function (f) {
            return {
              name: f,
              isDefault: false,
              removeFrom: "excludedFilenames",
              isAdded: true,
            };
          }),
        );
      ph = "Filename";
      ak = "excludedFilenames";
      break;
    case "inc-exts":
      items = (dr.includedExtensions || [])
        .map(function (e) {
          return {
            name: e,
            isDefault: true,
            removeTo: "removedDefaultIncludedExtensions",
            isRemoved: cr.removedDefaultIncludedExtensions.includes(e),
          };
        })
        .concat(
          cr.includedExtensions.map(function (e) {
            return {
              name: e,
              isDefault: false,
              removeFrom: "includedExtensions",
              isAdded: true,
            };
          }),
        );
      ph = "Extension";
      ak = "includedExtensions";
      break;
    case "inc-files":
      items = (dr.includedFilenames || [])
        .map(function (f) {
          return {
            name: f,
            isDefault: true,
            removeTo: "removedDefaultIncludedFilenames",
            isRemoved: cr.removedDefaultIncludedFilenames.includes(f),
          };
        })
        .concat(
          cr.includedFilenames.map(function (f) {
            return {
              name: f,
              isDefault: false,
              removeFrom: "includedFilenames",
              isAdded: true,
            };
          }),
        );
      ph = "Filename";
      ak = "includedFilenames";
      break;
  }

  // Added/removed items pinned to top, each group sorted alphabetically
  var _pinned = items.filter(function(it){ return it.isAdded || it.isRemoved; })
    .sort(function(a,b){ return a.name.localeCompare(b.name); });
  var _normal = items.filter(function(it){ return !it.isAdded && !it.isRemoved; })
    .sort(function(a,b){ return a.name.localeCompare(b.name); });
  items = _pinned.concat(_normal);

  var _iconType = S.advActiveTab.endsWith("folders") ? "folder"
               : S.advActiveTab.endsWith("files") ? "file" : "ext";
  var _baseIsExc = S.advActiveTab.startsWith("exc");
  var _SVGS = {
    folder: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>',
    file:   '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>',
    ext:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>',
  };

  var h = '<div class="adv-list">';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var rowClass =
      "adv-item" +
      (it.isAdded
        ? " adv-item-added"
        : it.isRemoved
          ? " adv-item-removed"
          : "");
    var nameStyle = it.isAdded ? "color:var(--a)" : "";
    var tag = it.isAdded
      ? ' <span style="font-size:9px;background:rgba(32,227,160,.12);color:var(--a);padding:1px 5px;border-radius:3px">+added</span>'
      : it.isRemoved
        ? ' <span style="font-size:9px;background:rgba(248,113,113,.1);color:var(--err);padding:1px 5px;border-radius:3px">−removed</span>'
        : '';
    var _effectivelyExc = _baseIsExc ? !it.isRemoved : it.isRemoved;
    var _iconColor = _effectivelyExc ? "#f87171" : "#20e3a0";
    var _icon = '<span style="color:' + _iconColor + ';display:inline-flex;align-items:center;flex-shrink:0">' + _SVGS[_iconType] + '</span>';
    h +=
      '<div class="' +
      rowClass +
      '">' + _icon + '<span class="adv-item-name" style="' +
      nameStyle +
      '">' +
      escHtml(it.name) +
      tag +
      '</span><button class="adv-item-remove" data-ai="' +
      i +
      '">✕</button></div>';
  }
  if (!items.length)
    h +=
      '<div style="color:var(--t4);font-size:12px;padding:8px">No items</div>';
  h += "</div>";
  h +=
    '<div class="adv-add-row"><input class="input" id="adv-add-input" placeholder="' +
    ph +
    '"><button class="btn-inline" id="adv-add-btn" data-ak="' +
    ak +
    '">+ Add</button></div>';
  c.innerHTML = h;
  c._items = items;

  // Cross-list conflict helpers
  var _OPP_CUSTOM = {
    excludedExtensions: "includedExtensions",  includedExtensions: "excludedExtensions",
    excludedFilenames:  "includedFilenames",   includedFilenames:  "excludedFilenames",
    excludedFolders:    "includedFolders",     includedFolders:    "excludedFolders",
  };
  var _REMOVED_KEY = {
    includedExtensions: "removedDefaultIncludedExtensions",
    excludedExtensions: "removedDefaultExcludedExtensions",
    includedFilenames:  "removedDefaultIncludedFilenames",
    excludedFilenames:  "removedDefaultExcludedFilenames",
    includedFolders:    "removedDefaultIncludedFolders",
    excludedFolders:    "removedDefaultExcludedFolders",
  };
  var _RESTORE_TO_KEY = {
    removedDefaultExcludedExtensions: "excludedExtensions",
    removedDefaultIncludedExtensions: "includedExtensions",
    removedDefaultExcludedFilenames:  "excludedFilenames",
    removedDefaultIncludedFilenames:  "includedFilenames",
    removedDefaultExcludedFolders:    "excludedFolders",
    removedDefaultIncludedFolders:    "includedFolders",
  };

  function _showAdvAlert(msg) { showSnack(msg, 'warn'); }

  function _crossConflict(v, targetKey) {
    var dr = S.defaultRules || {};
    var cr = S.customRules;
    var oppKey = _OPP_CUSTOM[targetKey];
    if (!oppKey) return null;
    // conflict with custom opposite list
    if ((cr[oppKey] || []).includes(v)) return oppKey;
    // conflict with active default opposite list (not removed by user)
    var oppDefaults = (dr[oppKey] || []);
    var oppRemovedKey = _REMOVED_KEY[oppKey];
    var oppRemoved = cr[oppRemovedKey] || [];
    if (oppDefaults.includes(v) && !oppRemoved.includes(v)) return oppKey;
    return null;
  }

  c.querySelectorAll(".adv-item-remove").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var idx = parseInt(btn.dataset.ai);
      var it = c._items[idx];
      if (!it) return;
      // When restoring a removed default, check it won't conflict with the opposite custom list
      if (it.isRemoved) {
        var restoredKey = _RESTORE_TO_KEY[it.removeTo];
        var oppKey = restoredKey && _OPP_CUSTOM[restoredKey];
        if (oppKey && (S.customRules[oppKey] || []).includes(it.name)) {
          _showAdvAlert('"' + it.name + '" already exists in the opposite list — remove it there first.');
          return;
        }
      }
      withHistory("Rule change: " + it.name, async function () {
        if (it.isRemoved) {
          S.customRules[it.removeTo] = S.customRules[it.removeTo].filter(
            function (n) { return n !== it.name; },
          );
        } else if (it.isDefault && it.removeTo) {
          if (!S.customRules[it.removeTo]) S.customRules[it.removeTo] = [];
          if (!S.customRules[it.removeTo].includes(it.name))
            S.customRules[it.removeTo].push(it.name);
        } else if (it.removeFrom) {
          S.customRules[it.removeFrom] = S.customRules[it.removeFrom].filter(
            function (n) { return n !== it.name; },
          );
        }
        renderAdvContent();
        await rescanWithRules();
      }, { needsRescan: true });
      saveCurrentProjectSettings();
    });
  });

  var ab = document.getElementById("adv-add-btn");
  var ai = document.getElementById("adv-add-input");
  if (ab) {
    async function _doAdd() {
      var k = ab.dataset.ak;
      var v = ai.value.trim();
      if (!v) return;
      // Same-list duplicate
      var allNames = c._items.map(function(it){ return it.name; });
      if (allNames.includes(v)) {
        _showAdvAlert('"' + v + '" already exists in this list.');
        return;
      }
      // Cross-list conflict
      var conflictKey = _crossConflict(v, k);
      if (conflictKey) {
        _showAdvAlert('"' + v + '" already exists in the opposite list — remove it there first.');
        return;
      }

      // Detect user-override conflicts: files the user manually flipped that
      // the new rule would auto-flip in the opposite direction. Without this
      // popup the rule silently turns them into "forced" or leaves their
      // override in place, which can surprise.
      var conflicts = _findRuleConflicts(k, v);
      var resolution = "apply"; // when there's no conflict, just apply.
      if (conflicts.length > 0) {
        resolution = await _showRuleConflictModal(k, v, conflicts);
        if (resolution === "cancel" || resolution === "view") return;
      }

      ai.value = "";
      withHistory("Add rule " + v, async function () {
        if (!S.customRules[k]) S.customRules[k] = [];
        S.customRules[k].push(v);
        if (resolution === "apply") {
          for (var ci = 0; ci < conflicts.length; ci++) {
            S.userOverrides.delete(conflicts[ci].id);
          }
        }
        renderAdvContent();
        await rescanWithRules();
      }, { needsRescan: true });
      saveCurrentProjectSettings();
    }
    ab.addEventListener("click", _doAdd);
    ai.addEventListener("keydown", function(e){ if (e.key === "Enter") _doAdd(); });
  }
}

// Find files in the current tree whose user override conflicts with a rule
// the user is about to add. "Conflict" = file matches the new rule AND has an
// override pointing the opposite way (manually-included file matched by an
// exclusion rule, manually-excluded file matched by an inclusion rule).
// Only extension/filename rules are checked — folder rules just remove files
// from the tree, no visible conflict to resolve.
function _findRuleConflicts(ruleKey, value) {
  var lower = (value || "").toLowerCase().replace(/^\./, "");
  if (!lower) return [];
  var isExclude = /^excluded/.test(ruleKey);
  var conflictOverride = isExclude ? "included" : "excluded";
  var conflicts = [];
  for (var i = 0; i < S.flatNodes.length; i++) {
    var n = S.flatNodes[i];
    if (n.type !== "file") continue;
    if (!S.userOverrides.has(n.id)) continue;
    if (S.userOverrides.get(n.id) !== conflictOverride) continue;
    var name = (n.name || "").toLowerCase();
    var ext = (n.extension || "").toLowerCase();
    var matches = false;
    if (ruleKey === "excludedExtensions" || ruleKey === "includedExtensions") {
      matches = ext === lower;
    } else if (ruleKey === "excludedFilenames" || ruleKey === "includedFilenames") {
      matches = name === lower;
    } else if (ruleKey === "excludedFolders" || ruleKey === "includedFolders") {
      var parts = (n.id || "").toLowerCase().split(/[\\\/]/);
      matches = parts.includes(lower);
    }
    if (matches) conflicts.push(n);
  }
  return conflicts;
}

function _showRuleConflictModal(ruleKey, value, conflicts) {
  return new Promise(function (resolve) {
    var isExclude = /^excluded/.test(ruleKey);
    var cnt = conflicts.length;
    var ruleLabel = ({
      excludedExtensions: "Excluded Extensions",
      excludedFilenames: "Excluded Files",
      excludedFolders: "Excluded Folders",
      includedExtensions: "Included Extensions",
      includedFilenames: "Included Files",
      includedFolders: "Included Folders",
    })[ruleKey] || ruleKey;
    var subject = isExclude
      ? cnt + " file" + (cnt > 1 ? "s are" : " is") + " currently <b>selected</b> but match this exclusion rule."
      : cnt + " file" + (cnt > 1 ? "s are" : " is") + " currently <b>unselected</b> but would be matched by this inclusion rule.";
    // "(force)" wording is reserved for the case that actually surfaces the
    // "forced ✓" badge in the tree — auto-excluded files kept manually included.
    // For the inverse (auto-included files kept manually excluded) there's no
    // forced badge, so we just say "Keep unselected".
    var btnKeep = isExclude ? "Keep selected (force)" : "Keep unselected";
    var btnApply = isExclude ? "Unselect them too" : "Select them too";

    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "rule-conflict-overlay";
    overlay.innerHTML =
      '<div class="modal unk-modal" style="width:540px">' +
        '<div class="modal-head">' +
          '<span>⚠️ Rule conflict</span>' +
          '<button id="rc-close-x">✕</button>' +
        '</div>' +
        '<div class="unk-modal-body">' +
          '<div class="unk-modal-count">' +
            '<span class="unk-count-num">' + cnt + '</span> file' + (cnt > 1 ? 's' : '') + ' in conflict' +
          '</div>' +
          '<p class="unk-modal-hint">' +
            'Adding <b>"' + escHtml(value) + '"</b> to <b>' + ruleLabel + '</b> — ' + subject +
          '</p>' +
        '</div>' +
        '<div class="modal-foot unk-modal-foot" style="flex-wrap:nowrap">' +
          '<button class="btn btn-sm btn-ghost" id="rc-btn-view">🔍 Review first</button>' +
          '<div class="unk-spacer"></div>' +
          '<button class="btn btn-sm btn-ghost" id="rc-btn-force">' + btnKeep + '</button>' +
          '<button class="btn btn-sm btn-primary" id="rc-btn-apply">' + btnApply + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    function close(result) {
      var el = document.getElementById("rule-conflict-overlay");
      if (el) el.remove();
      resolve(result);
    }
    // Backdrop click and ✕ dismiss without applying — same as "view" cancellation
    // (no rule added). The footer no longer offers an explicit Cancel button.
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close("cancel"); });
    document.getElementById("rc-close-x").addEventListener("click", function () { close("cancel"); });
    document.getElementById("rc-btn-force").addEventListener("click", function () { close("force"); });
    document.getElementById("rc-btn-apply").addEventListener("click", function () { close("apply"); });
    document.getElementById("rc-btn-view").addEventListener("click", function () {
      // Set tree search to the rule value and switch filter so the conflicting
      // files are immediately visible. Excluded rule → user wants to see what's
      // currently selected that'll be hit; included rule → what's unselected.
      S.treeSearchQuery = value;
      S.treeFilter = isExclude ? "included" : "excluded";
      var searchInput = document.getElementById("tree-search-input");
      if (searchInput) searchInput.value = value;
      document.querySelectorAll(".tree-filter-group .tree-btn").forEach(function (b) {
        b.classList.remove("active");
      });
      var targetBtn = document.querySelector(
        ".tree-filter-group .tree-btn." + (isExclude ? "flt-inc" : "flt-exc"),
      );
      if (targetBtn) targetBtn.classList.add("active");
      renderTree();
      close("view");
    });
  });
}
async function rescanWithRules() {
  var treeEl = document.getElementById("file-tree");
  treeEl.innerHTML =
    '<div style="padding:12px"><div class="spinner"></div></div>';
  try {
    var r = await fetch(
      "/api/scan-tree?path=" +
        encodeURIComponent(S.projectPath) +
        "&customRules=" +
        encodeURIComponent(JSON.stringify(S.customRules)),
    );
    var d = await r.json();
    if (d.ok) {
      S.treeData = d.tree;
      S.projectType = d.projectType;
      S.newFileIds = new Set(d.newFileIds || []);
      flattenNodes(S.treeData, "");
      // NOTE: we used to delete userOverrides whose IDs were missing from the new flatNodes.
      // That breaks the apply/undo cycle: a folder-exclude rule hides its descendants from
      // flatNodes, so any user decisions on them got wiped — then undoing the rule could not
      // restore them. We now keep stale overrides; they're harmless (only consulted when the
      // matching node is back in flatNodes) and the server reconciles on run start.
      renderTree();
      renderCategoryChips();
      refreshFileCount();
      renderSummary();
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════
// PAGE 3 — OPTIONS
// ═══════════════════════════════════════════════════════════
function buildModeGrid() {
  var MODES = {
    fast: {
      label: "Fast",
      tag: "Role + exports",
      desc: "1-line summary per file. Fast.",
    },
    standard: {
      label: "Standard",
      tag: "Role · Exports · Deps · Gotchas",
      desc: "Exports, deps, and gotchas.",
    },
    deep: {
      label: "Deep",
      tag: "Full analysis",
      desc: "Full architecture + AI guidance.",
    },
    adaptive: {
      label: "Adaptive",
      tag: "Auto-scales by file size",
      desc: "Auto-scales by file complexity.",
      special: true,
    },
  };
 
  document.getElementById("mode-grid").innerHTML = Object.entries(MODES)
    .map(function (e) {
      var k = e[0],
        m = e[1];
      return (
        '<div class="mode-card' +
        (k === S.precision ? " selected" : "") +
        (m.special ? " mode-adaptive" : "") +
        '" data-mode="' + k + '">' +
        '<div class="mode-card-header">' +
          '<div class="mode-card-name">' + m.label + '</div>' +
          '<span class="mode-badge ' + k + '">' +
          ({ fast: 'QUICK', standard: 'BALANCED', deep: 'THOROUGH', adaptive: 'SMART' }[k]) +
          '</span>' +
        '</div>' +
        '<div class="mode-card-tag">' + m.tag + '</div>' +
        '<div class="mode-card-desc">' + m.desc + '</div>' +
        "</div>"
      );
    })
    .join("");
 
  document.querySelectorAll(".mode-card").forEach(function (el) {
    el.addEventListener("click", function () {
      S.precision = el.dataset.mode;
      buildModeGrid();
      saveCurrentProjectSettings();
    });
  });
}
window._toggleChange = function () {
  S.changesOnly = !S.changesOnly;
  document
    .getElementById("toggle-changes")
    .classList.toggle("on", S.changesOnly);
  if (!S.changesOnly) {
    showSnack("Smart Update OFF — all cache will be cleared and every file re-analyzed from scratch on the next run.", "warn");
  }
  saveCurrentProjectSettings();
};
window._toggleFileTree = function () {
  var isOn = S.fileTreeMode !== "none";
  S.fileTreeMode = isOn ? "none" : "included";
  document.getElementById("toggle-filetree").classList.toggle("on", !isOn);
  var row = document.getElementById("filetree-mode-row");
  row.style.display = !isOn ? "" : "none";
  document.getElementById("ft-" + S.fileTreeMode).checked = S.fileTreeMode !== "none";
  _updateTreeModeHint();
  saveCurrentProjectSettings();
};

window._setTreeMode = function (mode) {
  S.fileTreeMode = mode;
  _updateTreeModeHint();
  saveCurrentProjectSettings();
};

function _updateTreeModeHint() {
  var hints = {
    included: "Shows only analyzed files — compact and focused.",
    all: "Full project shows all scanned files — best for AI orientation.",
  };
  var el = document.getElementById("filetree-hint");
  if (el && hints[S.fileTreeMode]) el.textContent = hints[S.fileTreeMode];
}
// ═══════════════════════════════════════════════════════════
// PAGE 4 — REVIEW
// ═══════════════════════════════════════════════════════════
function buildReview() {
  var _rv =
    document.getElementById("model-manual")?.value?.trim() ||
    document.getElementById("model-select")?.value ||
    S.model;
  if (_rv) S.model = _rv;
  var inc = 0;
  for (var i = 0; i < S.flatNodes.length; i++) {
    if (
      S.flatNodes[i].type === "file" &&
      getFinalStatus(S.flatNodes[i]) === "included"
    )
      inc++;
  }
  var _agent = AGENT_TARGETS[S.agentTarget] || AGENT_TARGETS.claude;
  document.getElementById("review-content").innerHTML = [
    ["📁", "Project", S.projectPath],
    ["🏷️", "Type", S.projectType],
    ["🤖", "Model", S.model],
    ["⚡", "Precision", S.precision],
    ["📄", "Files", String(inc)],
    ["🔁", "Changes", S.changesOnly ? "On" : "Off"],
    ["🛠️", "Agent", _agent.name],
    ["💾", "Output", _agent.file],
  ]
    .map(function (r) {
      return (
        '<div class="review-row"><div class="review-key">' +
        r[0] +
        " " +
        r[1] +
        '</div><div class="review-val">' +
        escHtml(r[2]) +
        "</div></div>"
      );
    })
    .join("");
}

function buildAgentSelector() {
  var grid = document.getElementById("agent-selector-grid");
  if (!grid) return;
  grid.innerHTML = Object.entries(AGENT_TARGETS)
    .map(function (pair) {
      var key = pair[0],
        t = pair[1];
      return (
        '<div class="agent-card ' +
        (key === S.agentTarget ? "selected" : "") +
        '" data-agent="' +
        key +
        '">' +
        '<div class="agent-icon-wrap"><img src="/shared/assets/agents/' +
        t.icon +
        '" alt="' +
        escHtml(t.name) +
        '"></div>' +
        '<div class="agent-card-name">' +
        escHtml(t.name) +
        "</div>" +
        '<div class="agent-card-file">' +
        escHtml(t.file) +
        "</div>" +
        "</div>"
      );
    })
    .join("");
  grid.querySelectorAll(".agent-card").forEach(function (el) {
    el.addEventListener("click", function () {
      S.agentTarget = el.dataset.agent;
      buildAgentSelector();
      buildReview();
      saveCurrentProjectSettings();
    });
  });
}

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// PAGE-2 CONTINUE — intercept when unknowns remain
// ═══════════════════════════════════════════════════════════
window._page2Continue = function () {
  var unresolved = S.flatNodes.filter(function (n) {
    return n.type === "file" && n.autoStatus === "ambiguous" && !S.userOverrides.has(n.id);
  });
  if (!unresolved.length) { window._goToPage(3); return; }

  var cnt = unresolved.length;
  var overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "unk-warning-overlay";
  overlay.innerHTML =
    '<div class="modal unk-modal">' +
      '<div class="modal-head">' +
        '<span>⚠️ Files to decide</span>' +
        '<button id="unk-close-x">✕</button>' +
      '</div>' +
      '<div class="unk-modal-body">' +
        '<div class="unk-modal-count"><span class="unk-count-num">' + cnt + '</span> file' + (cnt > 1 ? 's have' : ' has') + ' no classification yet.</div>' +
        '<p class="unk-modal-hint">These files were flagged as ambiguous by the classifier. You can include or exclude them all now, review them manually in the tree, or skip and keep them excluded by default.</p>' +
      '</div>' +
      '<div class="modal-foot unk-modal-foot">' +
        '<button class="btn btn-sm btn-ghost" id="unk-btn-review">🔍 Review in tree</button>' +
        '<button class="btn btn-sm btn-ghost" id="unk-btn-table">📋 Review in table</button>' +
        '<div class="unk-spacer"></div>' +
        '<button class="btn btn-sm btn-ghost" id="unk-btn-skip">Skip →</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  function closeModal() {
    var el = document.getElementById("unk-warning-overlay");
    if (el) el.remove();
  }
  overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });
  document.getElementById("unk-close-x").addEventListener("click", closeModal);

  document.getElementById("unk-btn-review").addEventListener("click", function () {
    closeModal();
    S.selectedCategories.add("__unknown__");
    renderCategoryChips();
    applyTreeHighlights();
  });
  document.getElementById("unk-btn-table").addEventListener("click", function () {
    closeModal();
    window._openResolveTable();
  });
  document.getElementById("unk-btn-skip").addEventListener("click", function () {
    closeModal();
    window._goToPage(3);
  });
};

// ═══════════════════════════════════════════════════════════
// RESOLVE TABLE — flat list of undecided files with per-row buttons
// ═══════════════════════════════════════════════════════════
window._openResolveTable = function () {
  // Snapshot the state at open. We commit one history entry on Apply ("Done"),
  // or skip the commit entirely on Cancel (the modal reverts on its own).
  History.begin();
  function computeAmbig() {
    var arr = S.flatNodes.filter(function (n) {
      return n.type === "file" && n.autoStatus === "ambiguous" && !S.userOverrides.has(n.id);
    });
    arr.sort(function (a, b) { return a.id.localeCompare(b.id); });
    return arr;
  }

  // Folder index built once per tree state. Cached at modal scope; invalidated on rescan.
  // Holds:
  //   totals[folder]      — count of files (any status) whose path contains folder
  //   placeCount[folder]  — count of distinct parent-path locations the folder name appears in
  var folderIndex = null;

  function buildFolderIndex() {
    var totals = {};
    var places = {};
    var nodes = S.flatNodes;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.type !== "file") continue;
      var parts = n.id.split("/");
      var lim = parts.length - 1;
      var seen = null;
      var prefix = "";
      for (var j = 0; j < lim; j++) {
        var f = parts[j];
        if (f) {
          if (!seen) seen = {};
          if (!seen[f]) {
            seen[f] = 1;
            totals[f] = (totals[f] || 0) + 1;
            if (!places[f]) places[f] = {};
            places[f][prefix] = 1;
          }
        }
        prefix = prefix ? prefix + "/" + f : f;
      }
    }
    var placeCount = {};
    var ks = Object.keys(places);
    for (var k = 0; k < ks.length; k++) placeCount[ks[k]] = Object.keys(places[ks[k]]).length;
    return { totals: totals, placeCount: placeCount };
  }

  function computeSuggestions(files) {
    if (!folderIndex) folderIndex = buildFolderIndex();
    var byExt = {};
    var byFolder = {};
    for (var i = 0; i < files.length; i++) {
      var n = files[i];
      var ext = (n.extension || "").toLowerCase();
      if (ext) byExt[ext] = (byExt[ext] || 0) + 1;
      var parts = n.id.split("/");
      var lim = parts.length - 1;
      var seen = null;
      for (var j = 0; j < lim; j++) {
        var f = parts[j];
        if (!f) continue;
        if (seen && seen[f]) continue;
        if (!seen) seen = {};
        seen[f] = 1;
        byFolder[f] = (byFolder[f] || 0) + 1;
      }
    }
    var PURITY = 0.9;
    var MIN_FOLDER = 3;
    var out = [];
    var extKeys = Object.keys(byExt);
    for (var k = 0; k < extKeys.length; k++) {
      var e = extKeys[k];
      if (byExt[e] >= 2) {
        out.push({ type: "extension", key: e, label: "." + e, count: byExt[e], places: 0 });
      }
    }
    var folderKeys = Object.keys(byFolder);
    for (var m = 0; m < folderKeys.length; m++) {
      var f2 = folderKeys[m];
      var ac = byFolder[f2];
      if (ac < MIN_FOLDER) continue;
      var tc = folderIndex.totals[f2] || ac;
      if (ac / tc < PURITY) continue;
      out.push({
        type: "folder", key: f2, label: f2 + "/",
        count: ac, purity: ac / tc,
        places: folderIndex.placeCount[f2] || 1,
      });
    }
    out.sort(function (a, b) {
      if (a.type !== b.type) return a.type === "extension" ? -1 : 1;
      return b.count - a.count;
    });
    return out.slice(0, 8);
  }

  var ambig = computeAmbig();
  // Immutable list of IDs that were undecided when the modal opened. Reset uses this
  // to clear every per-file decision the user made, regardless of whether the file is
  // still in the current `ambig` array (rule applications shrink `ambig`).
  var originalAmbigIds = ambig.map(function (n) { return n.id; });
  // Snapshot the suggestions surfaced from the original undecided set. We always show
  // these in the strip — even after another rule absorbs all their files — so undoing a
  // rule never makes a previously-visible suggestion vanish. Without this cache, e.g.
  // applying `agents/` then `.svg` then undoing `agents/` would drop `agents/` from the
  // strip entirely (current ambig becomes 1 file, below every threshold).
  var initialSuggestionKeys = computeSuggestions(ambig).map(function (s) {
    return { type: s.type, key: s.key, label: s.label, places: s.places || 0 };
  });
  // Rules applied during THIS modal session. Each entry: {type, key, action, count, label, ruleKey}
  // Kept so the strip can show them with an "undo" affordance even after the underlying
  // files have been reclassified out of the ambig snapshot.
  var appliedRules = [];
  // Serialize rescans: concurrent fetches return out of order and corrupt the tree state.
  var rescanBusy = false;

  if (!ambig.length) {
    showSnack("No undecided files left.", "info", 2500);
    return;
  }

  var existing = document.getElementById("resolve-table-overlay");
  if (existing) existing.remove();

  var overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "resolve-table-overlay";
  overlay.innerHTML =
    '<div class="modal rt-modal">' +
      '<div class="modal-head">' +
        '<span>📋 Resolve undecided files <span class="rt-count-info"><b id="rt-remaining">0</b> remaining of <span id="rt-total">0</span></span></span>' +
      '</div>' +
      '<div class="rt-suggest" id="rt-suggest"></div>' +
      '<div class="rt-toolbar">' +
        '<input class="rt-search" id="rt-search" placeholder="Filter by name or extension…" spellcheck="false">' +
        '<button class="btn btn-sm btn-ghost" id="rt-inc-all">☑ all</button>' +
        '<button class="btn btn-sm btn-ghost" id="rt-exc-all">☐ all</button>' +
      '</div>' +
      '<div class="rt-list" id="rt-list"></div>' +
      '<div class="modal-foot">' +
        '<button class="btn btn-sm btn-ghost" id="rt-reset-all" title="Undo every rule and per-file decision from this session">↺ Reset</button>' +
        '<div class="unk-spacer"></div>' +
        '<button class="btn btn-sm btn-ghost" id="rt-cancel" title="Discard all changes made in this modal and close">Cancel</button>' +
        '<button class="btn btn-sm btn-primary" id="rt-done">Apply</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  // How many files in the CURRENT ambig snapshot a rule would affect right now.
  // Used to label available suggestions — 0 means another active rule has already
  // absorbed all of them (undo that rule to bring them back).
  function currentImpactCount(type, key) {
    var hits = 0;
    for (var i = 0; i < ambig.length; i++) {
      var n = ambig[i];
      if (type === "extension") {
        if ((n.extension || "").toLowerCase() === key) hits++;
      } else {
        var parts = n.id.split("/");
        for (var j = 0; j < parts.length - 1; j++) {
          if (parts[j] === key) { hits++; break; }
        }
      }
    }
    return hits;
  }

  function renderSuggestions() {
    var sEl = document.getElementById("rt-suggest");
    if (!sEl) return;
    var appliedKeySet = {};
    appliedRules.forEach(function (a) { appliedKeySet[a.type + "|" + a.key] = true; });
    // Always show the suggestions surfaced from the original undecided set, minus the
    // ones currently applied. Counts are recomputed live against the current ambig.
    var available = initialSuggestionKeys
      .filter(function (s) { return !appliedKeySet[s.type + "|" + s.key]; })
      .map(function (s) {
        return {
          type: s.type, key: s.key, label: s.label, places: s.places,
          count: currentImpactCount(s.type, s.key),
        };
      });
    if (!available.length && !appliedRules.length) {
      sEl.style.display = "none";
      sEl.innerHTML = "";
      return;
    }
    sEl.style.display = "";
    // Preserve the collapsed state across re-renders.
    var wasCollapsed = sEl.classList.contains("rt-suggest-collapsed");
    var totalCount = available.length + appliedRules.length;
    function placesLabel(s) {
      return (s.places && s.places > 1)
        ? '<span class="rt-suggest-places" title="This folder name appears in ' + s.places + ' places in your project">· ' + s.places + ' places</span>'
        : '';
    }
    var appliedHtml = appliedRules.map(function (a) {
      var cls = a.action === "exclude" ? "rt-applied-exc" : "rt-applied-inc";
      var icon = a.action === "exclude" ? "—" : "✓";
      var verb = a.action === "exclude" ? "excluded" : "included";
      return (
        '<div class="rt-suggest-item rt-applied ' + cls + '" data-type="' + escHtml(a.type) + '" data-key="' + escHtml(a.key) + '">' +
        '<span class="rt-suggest-pattern">' + (a.type === "folder" ? "📁 " : "") + escHtml(a.label) + '</span>' +
        '<span class="rt-applied-status">' + icon + ' ' + verb + ' (' + a.count + ')</span>' +
        '<button class="rt-suggest-btn rt-suggest-undo" data-act="undo" title="Remove this rule">↺ undo</button>' +
        '</div>'
      );
    }).join("");
    var availableHtml = available.map(function (s) {
      var noImpact = s.count === 0;
      var itemClass = "rt-suggest-item" + (noImpact ? " rt-suggest-noimpact" : "");
      var itemTitle = noImpact ? ' title="No undecided files left for this pattern — another rule already covers them"' : "";
      return (
        '<div class="' + itemClass + '" data-type="' + s.type + '" data-key="' + escHtml(s.key) + '"' + itemTitle + '>' +
        '<span class="rt-suggest-pattern">' + (s.type === "folder" ? "📁 " : "") + escHtml(s.label) + '</span>' +
        '<span class="rt-suggest-count">' + s.count + '</span>' +
        placesLabel(s) +
        '<button class="rt-suggest-btn rt-suggest-exc" data-act="exclude" title="Add rule: exclude all of these">+ exclude</button>' +
        '<button class="rt-suggest-btn rt-suggest-inc" data-act="include" title="Add rule: include all of these">+ include</button>' +
        '</div>'
      );
    }).join("");
    sEl.innerHTML =
      '<div class="rt-suggest-head">' +
        '<div class="rt-suggest-label">Suggested rules ' +
          '<span class="rt-suggest-count-total">' + totalCount + '</span>' +
        '</div>' +
        '<button class="rt-suggest-toggle" id="rt-suggest-toggle" title="Hide/show">' +
          (wasCollapsed ? "▸" : "▾") +
        '</button>' +
      '</div>' +
      '<div class="rt-suggest-list">' + appliedHtml + availableHtml + '</div>';
    if (wasCollapsed) sEl.classList.add("rt-suggest-collapsed");
    sEl.querySelectorAll(".rt-suggest-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var item = btn.closest(".rt-suggest-item");
        if (!item) return;
        var act = btn.dataset.act;
        if (act === "undo") undoRule(item.dataset.type, item.dataset.key);
        else applyRule(item.dataset.type, item.dataset.key, act);
      });
    });
    var tog = document.getElementById("rt-suggest-toggle");
    if (tog) tog.addEventListener("click", function () {
      var nowCollapsed = sEl.classList.toggle("rt-suggest-collapsed");
      tog.textContent = nowCollapsed ? "▸" : "▾";
    });
  }

  function setBusy(b) {
    rescanBusy = b;
    var sEl = document.getElementById("rt-suggest");
    var modal = document.querySelector(".rt-modal");
    if (sEl) sEl.style.opacity = b ? ".5" : "";
    if (modal) modal.classList.toggle("rt-busy", b);
  }

  async function applyRule(type, key, action) {
    if (rescanBusy) return;
    var ruleKey;
    if (type === "extension") {
      ruleKey = action === "exclude" ? "excludedExtensions" : "includedExtensions";
    } else {
      ruleKey = action === "exclude" ? "excludedFolders" : "includedFolders";
    }
    if (!S.customRules[ruleKey]) S.customRules[ruleKey] = [];
    if (S.customRules[ruleKey].includes(key)) return; // already applied
    S.customRules[ruleKey].push(key);
    var prevCount = ambig.length;
    setBusy(true);
    try {
      await rescanWithRules();
      folderIndex = null;
      ambig = computeAmbig();
      var resolved = prevCount - ambig.length;
      appliedRules.push({
        type: type,
        key: key,
        action: action,
        count: resolved,
        label: type === "extension" ? "." + key : key + "/",
        ruleKey: ruleKey,
      });
      renderSuggestions();
      renderList();
      try { renderAdvContent(); } catch {}
    } catch (err) {
      showSnack("Could not apply rule", "warn", 3000);
    } finally {
      setBusy(false);
    }
  }

  async function undoRule(type, key) {
    if (rescanBusy) return;
    var idx = -1;
    for (var i = 0; i < appliedRules.length; i++) {
      if (appliedRules[i].type === type && appliedRules[i].key === key) { idx = i; break; }
    }
    if (idx === -1) return;
    var rule = appliedRules[idx];
    setBusy(true);
    try {
      S.customRules[rule.ruleKey] = (S.customRules[rule.ruleKey] || []).filter(function (k) {
        return k !== rule.key;
      });
      await rescanWithRules();
      folderIndex = null;
      ambig = computeAmbig();
      appliedRules.splice(idx, 1);
      renderSuggestions();
      renderList();
      try { renderAdvContent(); } catch {}
    } catch (err) {
      showSnack("Could not undo", "warn", 3000);
    } finally {
      setBusy(false);
    }
  }

  async function resetSession() {
    if (rescanBusy) return;
    var hadRules = appliedRules.length > 0;
    setBusy(true);
    try {
      // 1. Remove every session-applied rule from S.customRules.
      for (var i = 0; i < appliedRules.length; i++) {
        var r = appliedRules[i];
        S.customRules[r.ruleKey] = (S.customRules[r.ruleKey] || []).filter(function (k) {
          return k !== r.key;
        });
      }
      // 2. Rescan only if a rule changed the tree state.
      if (hadRules) {
        await rescanWithRules();
        folderIndex = null;
      }
      // 3. Clear decisions on every file that was originally undecided when the modal opened
      //    — not just those still in the current `ambig` snapshot. This is the key fix:
      //    rule applications shrink `ambig`, so a "reset" that only touched current-ambig
      //    files was leaving prior per-file decisions stuck.
      for (var k = 0; k < originalAmbigIds.length; k++) {
        S.userOverrides.delete(originalAmbigIds[k]);
      }
      appliedRules.length = 0;
      ambig = computeAmbig();
      renderSuggestions();
      renderList();
      saveCurrentProjectSettings();
      try { renderAdvContent(); } catch {}
    } catch (err) {
      showSnack("Could not reset", "warn", 3000);
    } finally {
      setBusy(false);
    }
  }


  function updateCount() {
    var remaining = ambig.filter(function (n) { return !S.userOverrides.has(n.id); }).length;
    var rem = document.getElementById("rt-remaining");
    var tot = document.getElementById("rt-total");
    if (rem) rem.textContent = remaining;
    // Stable total — the count of undecided files the modal opened with. Using
    // ambig.length here would shrink as rules absorb files, making the header read
    // "1 of 1" even though the session started with 29.
    if (tot) tot.textContent = originalAmbigIds.length;
  }

  function renderList() {
    var listEl = document.getElementById("rt-list");
    if (!listEl) return;
    var q = (document.getElementById("rt-search").value || "").toLowerCase();
    var rows = ambig.filter(function (n) {
      if (!q) return true;
      var name = n.name.toLowerCase();
      var path = (n.id || "").toLowerCase();
      var ext = (n.extension || "").toLowerCase();
      return name.includes(q) || path.includes(q) || ext.includes(q);
    });
    if (!rows.length) {
      listEl.innerHTML = '<div class="rt-empty">No files match.</div>';
      updateCount();
      return;
    }
    listEl.innerHTML = rows.map(function (n) {
      var decision = S.userOverrides.get(n.id) || null;
      var ext = n.extension ? "." + n.extension : "—";
      var size = n.size ? formatSize(n.size) : "";
      var actions;
      if (decision === "included") {
        actions =
          '<span class="rt-row-status rt-status-inc">✓ Selected</span>' +
          '<button class="rt-btn rt-btn-undo" data-id="' + escHtml(n.id) + '" data-action="undo">undo</button>';
      } else if (decision === "excluded") {
        actions =
          '<span class="rt-row-status rt-status-exc">— Unselected</span>' +
          '<button class="rt-btn rt-btn-undo" data-id="' + escHtml(n.id) + '" data-action="undo">undo</button>';
      } else {
        actions =
          '<button class="rt-btn rt-btn-inc" data-id="' + escHtml(n.id) + '" data-action="include" title="Select">✓</button>' +
          '<button class="rt-btn rt-btn-exc" data-id="' + escHtml(n.id) + '" data-action="exclude" title="Unselect">✗</button>';
      }
      return (
        '<div class="rt-row' + (decision ? " rt-row-done" : "") + '">' +
          '<div class="rt-row-info">' +
            '<span class="rt-row-ext">' + escHtml(ext) + '</span>' +
            '<span class="rt-row-name" title="' + escHtml(n.id) + '">' + escHtml(n.id) + '</span>' +
            '<span class="rt-row-size">' + escHtml(size) + '</span>' +
          '</div>' +
          '<div class="rt-row-actions">' + actions + '</div>' +
        '</div>'
      );
    }).join("");
    updateCount();
  }

  function close() {
    var el = document.getElementById("resolve-table-overlay");
    if (el) el.remove();
    // Commit the modal session as a single undoable step. needsRescan=true if rules
    // changed inside the modal so undo will trigger a rescan and restore tree shape.
    History.commit("Resolve table", { needsRescan: appliedRules.length > 0 });
    renderTree();
    renderCategoryChips();
    refreshFileCount();
    renderSummary();
    saveCurrentProjectSettings();
  }

  // Discard every in-modal change — applied rules and per-file decisions — and close
  // WITHOUT persisting. We deliberately skip saveCurrentProjectSettings.
  async function cancelSession() {
    if (rescanBusy) {
      // Wait for the in-flight rescan, otherwise reverting customRules mid-fetch leaves
      // S.flatNodes out of sync with the current rule set.
      return;
    }
    var hadRules = appliedRules.length > 0;
    if (hadRules || originalAmbigIds.length) setBusy(true);
    try {
      // 1. Undo any rules added in this session.
      for (var i = 0; i < appliedRules.length; i++) {
        var r = appliedRules[i];
        S.customRules[r.ruleKey] = (S.customRules[r.ruleKey] || []).filter(function (k) {
          return k !== r.key;
        });
      }
      // 2. Rescan only if a rule changed the tree state.
      if (hadRules) {
        await rescanWithRules();
        folderIndex = null;
      }
      // 3. Roll back per-file decisions on files that were originally undecided.
      for (var k = 0; k < originalAmbigIds.length; k++) {
        S.userOverrides.delete(originalAmbigIds[k]);
      }
      appliedRules.length = 0;
    } catch (err) {
      // Best-effort revert. Still close the modal so the user isn't trapped.
    } finally {
      setBusy(false);
    }
    // Close without persisting — and discard the pending history snapshot.
    History.abort();
    var el = document.getElementById("resolve-table-overlay");
    if (el) el.remove();
    renderTree();
    renderCategoryChips();
    refreshFileCount();
    renderSummary();
    try { renderAdvContent(); } catch {}
  }

  document.getElementById("rt-list").addEventListener("click", function (e) {
    var btn = e.target.closest(".rt-btn");
    if (!btn) return;
    var id = btn.dataset.id;
    var action = btn.dataset.action;
    if (action === "include") S.userOverrides.set(id, "included");
    else if (action === "exclude") S.userOverrides.set(id, "excluded");
    else if (action === "undo") S.userOverrides.delete(id);
    renderList();
  });
  document.getElementById("rt-search").addEventListener("input", renderList);
  document.getElementById("rt-inc-all").addEventListener("click", function () {
    ambig.forEach(function (n) { S.userOverrides.set(n.id, "included"); });
    renderList();
  });
  document.getElementById("rt-exc-all").addEventListener("click", function () {
    ambig.forEach(function (n) { S.userOverrides.set(n.id, "excluded"); });
    renderList();
  });
  document.getElementById("rt-reset-all").addEventListener("click", function () {
    resetSession();
  });
  // Intentionally NOT closing on outside-click — accidental backdrop clicks shouldn't
  // commit decisions or rules. Use Apply (save + close), Cancel (revert + close), or Reset.
  document.getElementById("rt-done").addEventListener("click", close);
  document.getElementById("rt-cancel").addEventListener("click", cancelSession);

  renderSuggestions();
  renderList();
  // Onboarding hint: if the suggestion strip has scrollable overflow, snap to the bottom
  // immediately, then smoothly scroll to the top. The slide reveals that the section
  // scrolls and can be collapsed via the chevron — both non-obvious affordances.
  requestAnimationFrame(function () {
    var s = document.getElementById("rt-suggest");
    if (s && s.scrollHeight > s.clientHeight + 4) {
      s.scrollTop = s.scrollHeight;
      setTimeout(function () {
        s.scrollTo({ top: 0, behavior: "smooth" });
      }, 500);
    }
  });
  setTimeout(function () {
    var s = document.getElementById("rt-search");
    if (s) s.focus();
  }, 0);
};

// NAVIGATION
// ═══════════════════════════════════════════════════════════
window._goToPage = function (n) {
  if (n !== 1) _cancelBrowse();
  if (n > 0 && !S.ollamaOk) {
    alert("Ollama must be running.");
    return;
  }
  if (n > 1) {
    // A project must be selected from the registered list — typing in the field is not enough
    var _registered = (_projectsList || []).find(function (p) {
      return p.projectPath === S.projectPath;
    });
    if (!_registered) {
      var _inputVal = document.getElementById("project-path").value.trim();
      if (_inputVal && _pathValidState === "valid") {
        showSnack('Click "+ Add" to register this project before continuing.', "info", 5000);
      } else if (_inputVal) {
        showSnack("That path isn't valid — fix it or use Browse…", "info", 4000);
      } else {
        showSnack("Add a project folder before continuing.", "info", 4000);
      }
      return;
    }
  }
  if (n === 2) loadFileTree();
  if (n === 3) {
    if (!S.model && S.ollamaModels.length) S.model = S.ollamaModels[0].name;
    buildModeGrid();
    populateModels();
  }
  if (n === 4) {
    if (!S.model) {
      updateModelWarning();
      alert("Please select a model before continuing.");
      return;
    }
    buildReview();
    buildAgentSelector();
  }
  document.querySelectorAll(".wizard-page").forEach(function (p) {
    p.classList.remove("active");
  });
  document.getElementById("page-" + n).classList.add("active");
  document.querySelectorAll(".step-pill").forEach(function (p, i) {
    p.classList.remove("active", "done");
    if (i === n) p.classList.add("active");
    else if (i < n) p.classList.add("done");
  });
  S.currentPage = n;
  fetch("/api/ui-page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page: n }),
  }).catch(function () {});
};
// ═══════════════════════════════════════════════════════════
// START RUN
// ═══════════════════════════════════════════════════════════
window._startRun = async function () {
  S.model = document.getElementById("model-select")?.value || S.model;
  // Flush any pending save so overrides are on the server before the run starts
  await _flushProjectSettings();
  var uoa = [];
  S.userOverrides.forEach(function (v, k) {
    uoa.push([k, v]);
  });
  var config = {
    projectPath: S.projectPath,
    projectDescription: document.getElementById("project-desc").value.trim(),
    ollamaHost: S.ollamaHost,
    model: S.model,
    precision: S.precision,
    changesOnly: S.changesOnly,
    userOverrides: uoa,
    customRules: S.customRules,
    agentTarget: S.agentTarget,
    fileTreeMode: S.fileTreeMode,
  };
  try {
    await fetch("/api/save-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  } catch {}
  // Reset file tracking for new run
  S.fileList = [];
  S.fileStatuses = {};
  S.results = {};
  S.deletedCount = 0;
  S.fileChangeTypes = {};
  S.runPhase = "running";
  showDashboard();
  var r = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  var d = await r.json();
  if (!d.ok) {
    alert("Could not start: " + d.error);
    S.runPhase = "idle";
    updateRunControls();
    return;
  }
  updateRunControls();
};

// ═══════════════════════════════════════════════════════════
// INITIAL PREVIEW — shown immediately on run start
// ═══════════════════════════════════════════════════════════
function buildInitialPreview() {
  var rawPath = S.projectPath || '';
  var projectName = rawPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Project';
  var desc = (document.getElementById('project-desc') && document.getElementById('project-desc').value.trim()) || '';
  var agentInfo = AGENT_TARGETS[S.agentTarget] || AGENT_TARGETS.claude;
  var agentFile = agentInfo.file.split('/').pop();
  var model = S.model || '';
  var precision = S.precision || '';

  var lines = [];
  lines.push('# ' + agentFile);
  lines.push('> Auto-generated by repoDNA' + (model ? ' · Model: `' + model + '`' : '') + (precision ? ' · Precision: `' + precision + '`' : ''));
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Project Overview');
  lines.push('');
  if (desc) {
    lines.push(desc);
    lines.push('');
  }
  lines.push('**Path:** `' + (rawPath || '—') + '`');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('<div class="scan-loading"><span class="scan-spinner">⟳</span><span class="scan-label">Scanning files</span><span class="scan-dots"><span>.</span><span>.</span><span>.</span></span></div>');
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════
function showDashboard() {
  document.getElementById("wizard").style.display = "none";
  document.getElementById("dashboard").classList.add("visible");
  S.dashboardShown = true;

  // Clear old UI only if fresh run (no file list yet)
  if (S.fileList.length === 0 && Object.keys(S.results).length === 0) {
    S.activeTab = null;
    S.activeTabIsPreview = true;
    S.previewContent = "";
    S.previewFinal = false;
    document.getElementById("log-list").innerHTML = "";
    document.getElementById("log-count").textContent = "0";
    document.getElementById("tab-bar").innerHTML = "";
  }

  // Always show preview panel
  document.getElementById("results-content").style.display = "none";
  document.getElementById("preview-panel").classList.add("active");
  document.getElementById("results-panel").classList.remove("results-mode");

  if (!S.previewContent) {
    S.previewContent = buildInitialPreview();
  }
  renderPreview();

  document.getElementById("status-dot").className =
    "status-dot " +
    (S.runPhase === "paused"
      ? "paused"
      : S.runPhase === "done"
        ? "done"
        : "running");
  updateRunControls();
  renderTabs();

  // Render file list if we have one (e.g. after page refresh)
  if (S.fileList.length > 0) renderFileList();
}

window._goBackToWizard = function () {
  document.getElementById("wizard").style.display = "";
  document.getElementById("dashboard").classList.remove("visible");
  S.dashboardShown = false;
  S.runPhase = "idle";
};

window._exitToStart = async function () {
  // Cancel any pending settings save — overrides are already on the server from _startRun flush
  clearTimeout(_saveProjectTimer);
  _saveProjectTimer = null;
  // Reset everything server-side (abort + clear state + set phase=wizard)
  await fetch("/api/reset", { method: "POST" }).catch(function () {});
  _stopElapsedTimer();
  // Full client state reset
  S.fileList = [];
  S.fileStatuses = {};
  S.results = {};
  S.runPhase = "idle";
  S.activeTab = null;
  S.activeTabIsPreview = true;
  S.previewContent = "";
  S.previewFinal = false;
  S.dashboardShown = false;
  S.treeData = [];
  S.flatNodes = [];
  // Reset done state
  document.getElementById("dash-top").classList.remove("done");
  document.getElementById("progress-fill").style.width = "0%";
  document.getElementById("progress-label").textContent = "Waiting…";
  var _nb = document.getElementById("btn-new-analysis");
  if (_nb) _nb.classList.remove("done");
  document.getElementById("current-file").textContent = "";
  // Switch to wizard at page 0
  document.getElementById("dashboard").classList.remove("visible");
  document.getElementById("wizard").style.display = "";
  document.querySelectorAll(".wizard-page").forEach(function (p) {
    p.classList.remove("active");
  });
  document.getElementById("page-0").classList.add("active");
  document.querySelectorAll(".step-pill").forEach(function (p, i) {
    p.classList.remove("active", "done");
    if (i === 0) p.classList.add("active");
  });
  S.currentPage = 0;
  // Re-run system checks so step 01 is fresh
  runChecks();
};

function showSnack(msg, type, duration) {
  var container = document.getElementById('snackbar-container');
  if (!container) return;
  var sb = document.createElement('div');
  sb.className = 'snackbar ' + (type === 'info' ? 'snackbar-info' : 'snackbar-warn');
  var icon = type === 'info'
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  sb.innerHTML = icon + '<span></span><button class="snackbar-close" title="Dismiss">✕</button>';
  sb.querySelector('span').textContent = msg;
  sb.querySelector('.snackbar-close').onclick = function() { sb.remove(); };
  container.appendChild(sb);
  if (duration !== 0) setTimeout(function() { if (sb.parentNode) sb.remove(); }, duration || 30000);
}

var _snackbarApiErrorTimer = null;
function _showApiErrorSnackbar(isAuth) {
  if (_snackbarApiErrorTimer) return;
  var container = document.getElementById("snackbar-container");
  if (!container) return;
  var sb = document.createElement("div");
  sb.className = "snackbar snackbar-warn";
  var msg = isAuth
    ? 'Cloud model session expired — run <code style="font-family:var(--mono);font-size:11px">ollama login</code> then retry'
    : 'Ollama API error — if using a cloud model, run <code style="font-family:var(--mono);font-size:11px">ollama login</code>';
  sb.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
    '<span>' + msg + '</span>' +
    '<button class="snackbar-close" onclick="this.closest(\'.snackbar\').remove();_snackbarApiErrorTimer=null" title="Dismiss">✕</button>';
  container.appendChild(sb);
  _snackbarApiErrorTimer = true;
}

var _snackbarOllamaDownTimer = null;
function _showOllamaDownSnackbar() {
  if (_snackbarOllamaDownTimer) return;
  var container = document.getElementById("snackbar-container");
  if (!container) return;
  var sb = document.createElement("div");
  sb.className = "snackbar snackbar-warn";
  sb.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
    '<span>Ollama isn\'t reachable — start the Ollama app, then retry the failed files</span>' +
    '<button class="snackbar-close" onclick="this.closest(\'.snackbar\').remove();_snackbarOllamaDownTimer=null" title="Dismiss">✕</button>';
  container.appendChild(sb);
  _snackbarOllamaDownTimer = true;
}

function appendLog(d) {
  if (d.type === "warn" && d.text) {
    if (d.text.indexOf("HTTP 401") !== -1 || d.text.indexOf("unauthorized") !== -1) {
      _showApiErrorSnackbar(true);
    } else if (d.text.indexOf("Both Ollama APIs failed") !== -1) {
      _showApiErrorSnackbar(false);
    } else if (
      d.text.indexOf("fetch failed") !== -1 ||
      d.text.indexOf("ECONNREFUSED") !== -1
    ) {
      _showOllamaDownSnackbar();
    }
  }
  var list = document.getElementById("log-list");
  var icons = { success: "✓", error: "✗", info: "ℹ", warn: "⚠", scan: "🔍" };
  var div = document.createElement("div");
  div.className = "log-item " + (d.type || "info");
  var t = new Date(d.ts);
  var ts = [t.getHours(), t.getMinutes(), t.getSeconds()]
    .map(function (n) {
      return String(n).padStart(2, "0");
    })
    .join(":");
  div.innerHTML =
    '<span class="log-icon">' +
    (icons[d.type] || "·") +
    '</span><span class="log-text">' +
    escHtml(d.text) +
    '</span><span class="log-time">' +
    ts +
    "</span>";
  list.appendChild(div);
  // Cap the rendered log to avoid unbounded DOM growth on long runs.
  var MAX_LOG_ROWS = 2000;
  while (list.children.length > MAX_LOG_ROWS) {
    list.removeChild(list.firstChild);
  }
  list.scrollTop = list.scrollHeight;
  document.getElementById("log-count").textContent = list.children.length;
}

function updateProgress(d) {
  var pct =
    d.total > 0
      ? Math.round((d.done / d.total) * 100)
      : d.status === "done"
        ? 100
        : 0;
  document.getElementById("progress-fill").style.width = pct + "%";
  document.getElementById("progress-label").textContent =
    pct + "% · " + d.done + "/" + d.total;

  S.runDone = d.done;
  S.runTotal = d.total;

  var progEl = document.getElementById("s-progress");
  if (progEl) progEl.textContent = d.done + "/" + d.total;

  document.getElementById("s-done").textContent = d.done;
  document.getElementById("s-total").textContent = d.total;
  document.getElementById("s-errors").textContent = d.errors || 0;

  _elapsedBase = d.elapsed || 0;
  _elapsedBaseTime = Date.now();
  var _em = Math.floor(_elapsedBase / 60), _es = _elapsedBase % 60;
  document.getElementById("s-elapsed").textContent = _em + ":" + String(_es).padStart(2, "0");

  if (typeof d.deletedCount === "number") S.deletedCount = d.deletedCount;

  if (d.current)
    document.getElementById("current-file").textContent = "→ " + d.current;
  if (d.status === "done") {
    document.getElementById("current-file").textContent = "";
  }
}

function onDone() {
  document.getElementById("status-dot").className = "status-dot done";
  _stopElapsedTimer();

  // Switch top bar to done state — CSS animation handles the rest
  document.getElementById("dash-top").classList.add("done");

  // Make "New Analysis" button prominent
  var newBtn = document.getElementById("btn-new-analysis");
  if (newBtn) newBtn.classList.add("done");

  var total = parseInt(document.getElementById("s-done").textContent) || 0;
  var errors = parseInt(document.getElementById("s-errors").textContent) || 0;
  var sub;
  if (total === 0 && S.previewContent) {
    var _cachedLabel = (
      AGENT_TARGETS[S.agentTarget] || AGENT_TARGETS.claude
    ).file.split("/").pop();
    if (S.deletedCount > 0) {
      var _dn = S.deletedCount;
      sub = "✓ " + _dn + " file" + (_dn > 1 ? "s" : "") + " deleted — " + _cachedLabel + " rebuilt from cache";
    } else {
      sub = "✓ No changes detected — " + _cachedLabel + " rebuilt from cache";
    }
  } else if (total === 0) {
    sub = "⚠ No files to process — check file selection";
    var panel = document.getElementById("preview-panel");
    if (panel)
      panel.innerHTML =
        '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">No files to process.<br>Check your file selection or smart update rules.</div></div>';
  } else {
    var _doneLabel = (AGENT_TARGETS[S.agentTarget] || AGENT_TARGETS.claude).file
      .split("/").pop();
    sub = total + " files · " + errors + " errors · " + _doneLabel + " saved";
  }
  document.getElementById("current-file").textContent = sub;
  updateRunControls();
}
// ═══════════════════════════════════════════════════════════
// RESULTS TABS
// ═══════════════════════════════════════════════════════════
var _mkIcoN = 0;
function _mkIco(d, ca, cb) {
  var id = 'ti' + (++_mkIcoN), fi = 'tf' + _mkIcoN;
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;pointer-events:none">' +
    '<defs>' +
    '<linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">' +
    '<stop offset="0%" stop-color="' + ca + '"/><stop offset="100%" stop-color="' + cb + '"/>' +
    '</linearGradient>' +
    '<linearGradient id="' + fi + '" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">' +
    '<stop offset="0%" stop-color="' + ca + '" stop-opacity="0.18"/><stop offset="100%" stop-color="' + cb + '" stop-opacity="0.18"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<g fill="url(#' + fi + ')" stroke="url(#' + id + ')">' + d + '</g>' +
    '</svg>';
}
var CAT_LABELS = {
  "source-code": _mkIco('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', '#4ade80', '#06b6d4') + ' Source Code',
  config:        _mkIco('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', '#94a3b8', '#818cf8') + ' Configuration',
  docs:          _mkIco('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>', '#38bdf8', '#818cf8') + ' Documentation',
  styles:        _mkIco('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>', '#f472b6', '#e879f9') + ' CSS Styles',
  templates:     _mkIco('<rect x="2" y="2" width="20" height="4" rx="1"/><rect x="2" y="9" width="9" height="8" rx="1"/><rect x="13" y="9" width="9" height="8" rx="1"/><rect x="2" y="20" width="20" height="2" rx="1"/>', '#c084fc', '#818cf8') + ' Templates',
  "data-schema": _mkIco('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>', '#fb923c', '#fbbf24') + ' Data Schema',
  notebooks:     _mkIco('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>', '#fbbf24', '#fb923c') + ' Notebooks',
  scripts:       _mkIco('<path d="M5 8l6 4-6 4M13 19h8"/>', '#22d3ee', '#4ade80') + ' Scripts',
  images:        _mkIco('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>', '#fb7185', '#fb923c') + ' Images',
  svg:           _mkIco('<circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><path d="M5 17A12 12 0 0 1 17 5"/>', '#a78bfa', '#f472b6') + ' SVG',
  fonts:         _mkIco('<path d="M4 5h16M4 5v3M20 5v3M12 5v16M9 21h6"/>', '#fde68a', '#f59e0b') + ' Fonts',
  "audio-video": _mkIco('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>', '#e879f9', '#c084fc') + ' Media',
  archives:      _mkIco('<path d="M1 3h22v5H1z M21 8v13H3V8 M10 12h4"/>', '#fdba74', '#fb923c') + ' Archives',
  locks:         _mkIco('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', '#ef4444', '#f97316') + ' Lock files',
  generated:     _mkIco('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>', '#818cf8', '#c084fc') + ' Generated',
  logs:          _mkIco('<path d="M4 4h16v3H4zM4 10h12M4 14h14M4 18h9M4 21h12"/>', '#a3e635', '#4ade80') + ' Logs',
  certs:         _mkIco('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', '#fcd34d', '#fb923c') + ' Certificates',
  unknown:       _mkIco('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', '#64748b', '#94a3b8') + ' Other',
};

// Discard any in-progress card edits across the results panel. Called when the
// user navigates away (e.g. tab switch) so the file isn't left in edit mode
// while invisible — which would block retries from the file-run-list.
function _discardActiveEdits() {
  var cards = document.querySelectorAll('.result-card[data-editing="true"]');
  cards.forEach(function(card) {
    var cancelBtn = card.querySelector('.result-cancel-btn');
    if (cancelBtn) {
      window._cancelResultEdit(cancelBtn);
    } else {
      card.dataset.editing = 'false';
    }
  });
}

function renderTabs() {
  var bar = document.getElementById("tab-bar");
  bar.innerHTML = "";
  for (var key of Object.keys(CAT_LABELS)) {
    var items = S.results[key] || [];
    if (!items.length) continue;
    var div = document.createElement("div");
    div.className =
      "tab-item" +
      (!S.activeTabIsPreview && S.activeTab === key ? " active" : "");
    div.innerHTML =
      (CAT_LABELS[key] || key) +
      ' <span class="tab-badge">' +
      items.length +
      "</span>";
    (function (k) {
      div.addEventListener("click", function () {
        if (S.activeTab === k && !S.activeTabIsPreview) return;
        _discardActiveEdits();
        S.activeTab = k;
        S.activeTabIsPreview = false;
        renderTabs();
        showResultsPanel();
        renderResults(k);
      });
    })(key);
    bar.appendChild(div);
  }
  var previewTab = document.createElement("div");
  previewTab.className =
    "tab-item tab-preview" + (S.activeTabIsPreview ? " active" : "");
  var liveDot =
    S.previewContent && !S.previewFinal
      ? '<span class="tab-preview-dot"></span>'
      : "";
  var _previewLabel = (
    AGENT_TARGETS[S.agentTarget] || AGENT_TARGETS.claude
  ).file
    .split("/")
    .pop();
  var _t = Date.now() / 1000;
  var _glowDelay = (-(_t % 3)).toFixed(3) + 's';
  var _ctxIco = '<svg class="tab-ctx-ico" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="animation-delay:' + _glowDelay + ';pointer-events:none">'
    + '<defs>'
    + '<linearGradient id="ctx-g" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">'
    + '<stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#818cf8"/>'
    + '</linearGradient>'
    + '<linearGradient id="ctx-f" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">'
    + '<stop offset="0%" stop-color="#38bdf8" stop-opacity="0.15"/><stop offset="100%" stop-color="#818cf8" stop-opacity="0.15"/>'
    + '</linearGradient>'
    + '</defs>'
    + '<rect fill="url(#ctx-f)" stroke="url(#ctx-g)" x="4" y="2" width="16" height="20" rx="2"/>'
    + '<g fill="none" stroke="url(#ctx-g)" stroke-width="1.8" opacity="0.5">'
    + '<line x1="7" y1="9"  x2="17" y2="9"/>'
    + '<line x1="7" y1="13" x2="17" y2="13"/>'
    + '<line x1="7" y1="17" x2="12" y2="17"/>'
    + '</g>'
    + '<rect class="ctx-cursor" x="13" y="15.5" width="1.5" height="3" fill="#7dd3fc" stroke="none"/>'
    + '</svg>';
  previewTab.innerHTML = _ctxIco + '<span class="ctx-lbl">' + _previewLabel + '</span>' + liveDot;
  previewTab.addEventListener("click", function () {
    if (S.activeTabIsPreview) return;
    _discardActiveEdits();
    S.activeTabIsPreview = true;
    renderTabs();
    showPreviewPanel();
    renderPreview();
  });
  bar.appendChild(previewTab);
}

function showResultsPanel() {
  document.getElementById("results-content").style.display = "flex";
  document.getElementById("preview-panel").classList.remove("active");
  document.getElementById("results-panel").classList.add("results-mode");
}
function showPreviewPanel() {
  document.getElementById("results-content").style.display = "none";
  document.getElementById("preview-panel").classList.add("active");
  document.getElementById("results-panel").classList.remove("results-mode");
}

var _PREC_OPTS = ['fast', 'standard', 'deep', 'adaptive'];

function _precSelect(currentPrec, disabled) {
  var opts = _PREC_OPTS.map(function(p) {
    return '<option value="' + p + '"' + (p === currentPrec ? ' selected' : '') + '>' + p + '</option>';
  }).join('');
  return '<select class="retry-prec-sel"' + (disabled ? ' disabled' : '') + ' title="Precision for retry">' + opts + '</select>';
}

function createResultCard(item, cat) {
  var card = document.createElement("div");
  card.className = "result-card";
  card.dataset.mdContent = item.content || '';
  card.dataset.file = item.file || '';
  card.dataset.cat = cat || '';
  var ext = (item.file || "").match(/(\.[^.]+)$/);
  var _fst = S.fileStatuses[item.file] || {};
  var isRunning = _fst.status === 'running';
  var isRetrying = isRunning && _fst.retrying;
  var metaPrec = item.precision || S.precision || 'standard';
  var metaModel = item.model || S.model || '';
  var modelShort = metaModel ? metaModel.split('/').pop().slice(0, 22) : '';
  var metaBadge = (item.precision || item.model)
    ? '<span class="result-meta">' + escHtml(item.precision || '') + (modelShort ? ' · ' + escHtml(modelShort) : '') + '</span>'
    : '';
  var retryOrStop = isRetrying
    ? '<div class="retry-ctrl"><button class="result-stop-btn" onclick="window._stopFile(\'' + escHtml(item.file) + '\')" title="Stop this retry">■ Stop</button></div>'
    : '<div class="retry-ctrl">' +
        _precSelect(metaPrec, isRunning) +
        '<button class="result-retry-btn"' + (isRunning ? ' disabled' : '') + ' onclick="window._retryFileWithPrec(this)" title="Re-analyse this file">↺ Retry</button>' +
      '</div>';
  card.innerHTML =
    '<div class="result-card-head">' +
    getFileBadge(ext ? ext[1] : "") +
    '<span class="result-card-filename">' +
    escHtml(item.file) +
    '</span>' +
    metaBadge +
    retryOrStop +
    '<button class="result-edit-btn" ' + (isRunning ? 'disabled style="opacity:0.4;cursor:not-allowed" ' : '') + 'onclick="window._editResultCard(this)" title="Edit this analysis">Edit</button>' +
    '<button class="result-copy-btn" onclick="window._copyResultCard(this)" title="Copy markdown">Copy</button>' +
    '</div><div class="result-card-body md-body">' +
    md2html(item.content || "") +
    "</div>";
  return card;
}

function renderResults(cat) {
  var container = document.getElementById("results-content");
  var items = S.results[cat] || [];
  if (!items.length) {
    container.innerHTML =
      '<div class="empty-state"><div class="empty-text">No results yet...</div></div>';
    return;
  }
  container.innerHTML = "";
  for (var i = 0; i < items.length; i++) {
    container.appendChild(createResultCard(items[i], cat));
  }
}

function _doCopy(text, btn, label) {
  label = label || 'Copy';
  function flash() {
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    setTimeout(function() { btn.textContent = label; btn.classList.remove('copied'); }, 1500);
  }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(flash).catch(function() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      flash();
    });
  } else {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    flash();
  }
}

window._copyResultCard = function(btn) {
  var card = btn.closest('.result-card');
  var content = card ? (card.dataset.mdContent || '') : '';
  if (content) _doCopy(content, btn);
};

window._editResultCard = function(btn) {
  var card = btn.closest('.result-card');
  if (!card || card.dataset.editing === 'true') return;
  card.dataset.editing = 'true';

  var content = card.dataset.mdContent || '';
  var lines = content.split('\n');
  // Always lock the filename header; if LLM omitted it, synthesize it from card.dataset.file
  var isFileHeader = /^###\s+`/.test(lines[0] || '');
  var titleLine = isFileHeader ? lines[0] : ('### `' + (card.dataset.file || '') + '`');
  var bodyText = isFileHeader ? lines.slice(1).join('\n') : content;

  var bodyDiv = card.querySelector('.result-card-body');
  bodyDiv.innerHTML =
    (titleLine ? '<div class="result-edit-title-lock">' + escHtml(titleLine) + '</div>' : '') +
    '<textarea class="result-edit-textarea">' + escHtml(bodyText) + '</textarea>' +
    '<div class="result-edit-actions">' +
    '<button class="result-apply-btn" onclick="window._applyResultEdit(this)">Apply</button>' +
    '<button class="result-cancel-btn" onclick="window._cancelResultEdit(this)">Cancel</button>' +
    '</div>';

  var ta = bodyDiv.querySelector('.result-edit-textarea');
  ta.style.height = Math.max(180, ta.scrollHeight) + 'px';
  ta.addEventListener('input', function() {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  });

  btn.style.display = 'none';
  var copyBtn = card.querySelector('.result-copy-btn');
  if (copyBtn) copyBtn.style.display = 'none';
  var retryCtrl = card.querySelector('.retry-ctrl');
  if (retryCtrl) {
    retryCtrl.querySelectorAll('button, select').forEach(function(el) { el.disabled = true; });
    retryCtrl.style.opacity = '0.35';
    retryCtrl.style.pointerEvents = 'none';
  }
};

window._cancelResultEdit = function(btn) {
  var card = btn.closest('.result-card');
  if (!card) return;
  card.dataset.editing = 'false';
  var bodyDiv = card.querySelector('.result-card-body');
  bodyDiv.innerHTML = md2html(card.dataset.mdContent || '');
  var editBtn = card.querySelector('.result-edit-btn');
  if (editBtn) editBtn.style.display = '';
  var copyBtn = card.querySelector('.result-copy-btn');
  if (copyBtn) copyBtn.style.display = '';
  var retryCtrl = card.querySelector('.retry-ctrl');
  if (retryCtrl) {
    retryCtrl.querySelectorAll('button, select').forEach(function(el) { el.disabled = false; });
    retryCtrl.style.opacity = '';
    retryCtrl.style.pointerEvents = '';
  }
};

window._applyResultEdit = async function(btn) {
  var card = btn.closest('.result-card');
  if (!card) return;

  var titleLock = card.querySelector('.result-edit-title-lock');
  var ta = card.querySelector('.result-edit-textarea');
  if (!ta) return;

  var titleLine = titleLock ? titleLock.textContent : '';
  var newContent = titleLine ? titleLine + '\n' + ta.value : ta.value;

  var file = card.dataset.file;
  var cat = card.dataset.cat;

  // Update in-memory results
  card.dataset.mdContent = newContent;
  if (cat && S.results[cat]) {
    var entry = S.results[cat].find(function(it) { return it.file === file; });
    if (entry) entry.content = newContent;
  }

  // Persist to server cache
  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    await fetch('/api/update-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: S.projectPath, file: file, content: newContent }),
    });
  } catch (e) {}

  // Exit edit mode and re-render the body as markdown
  card.dataset.editing = 'false';
  var bodyDiv = card.querySelector('.result-card-body');
  bodyDiv.innerHTML = md2html(newContent);
  var editBtn = card.querySelector('.result-edit-btn');
  if (editBtn) editBtn.style.display = '';
  var copyBtn = card.querySelector('.result-copy-btn');
  if (copyBtn) copyBtn.style.display = '';
  // Re-enable retry controls that were disabled when entering edit mode
  var retryCtrl = card.querySelector('.retry-ctrl');
  if (retryCtrl) {
    retryCtrl.querySelectorAll('button, select').forEach(function(el) { el.disabled = false; });
    retryCtrl.style.opacity = '';
    retryCtrl.style.pointerEvents = '';
  }
};

window._copyPreview = function(btn) {
  if (S.previewContent) _doCopy(S.previewContent, btn);
};

// ─── PREVIEW ANCHOR ───────────────────────────────────────
// Tracks which file section the mouse is over so re-renders
// don't shift that section out of view.
var _previewAnchorKey = null;
var _previewListenersAdded = false;
var _previewMouseClientX = -1;
var _previewMouseClientY = -1;
var _previewScrollRafPending = false;

function _updatePreviewAnchor(panel) {
  if (_previewMouseClientX < 0) return;
  var hit = document.elementFromPoint(_previewMouseClientX, _previewMouseClientY);
  var el = hit && hit.closest && hit.closest(".preview-section[data-key]");
  var key = el ? el.getAttribute("data-key") : null;
  if (key === _previewAnchorKey) return;
  var prev = panel.querySelector(".preview-section.anchor-hover");
  if (prev) prev.classList.remove("anchor-hover");
  _previewAnchorKey = key;
  if (el) el.classList.add("anchor-hover");
}

function initPreviewListeners() {
  if (_previewListenersAdded) return;
  var panel = document.getElementById("preview-panel");
  if (!panel) return;
  _previewListenersAdded = true;

  panel.addEventListener("mousemove", function (e) {
    _previewMouseClientX = e.clientX;
    _previewMouseClientY = e.clientY;
    _updatePreviewAnchor(panel);
  });

  panel.addEventListener("mouseleave", function () {
    _previewMouseClientX = -1;
    _previewMouseClientY = -1;
    var prev = panel.querySelector(".preview-section.anchor-hover");
    if (prev) prev.classList.remove("anchor-hover");
    _previewAnchorKey = null;
  });

  panel.addEventListener("scroll", function () {
    if (_previewScrollRafPending || _previewMouseClientX < 0) return;
    _previewScrollRafPending = true;
    requestAnimationFrame(function () {
      _previewScrollRafPending = false;
      _updatePreviewAnchor(panel);
    });
  });
}

// Wraps each h2/h3-delimited section in a div so the anchor logic
// can find it by its data-key.
// h3 with <code>  → file path key  (### `path/to/file`)
// h2 or bare h3   → heading text key  (## Project Overview, ## Styles & CSS, etc.)
// Splitting on both h2 and h3 prevents section headers like "## Utilities & Helpers"
// from being swallowed into the preceding file entry's div.
// The "Generated by repoDNA" footer has no heading, so we inject a hidden <h2>
// before it to give it its own section.
function wrapPreviewSections(html) {
  html = html.replace(
    /(<p>\s*<em>\s*Generated by)/i,
    '<h2 class="preview-footer-anchor" style="display:none">Generated by repoDNA</h2>$1'
  );
  var parts = html.split(/(?=<h[23][\s>])/);
  var out = "";
  for (var i = 0; i < parts.length; i++) {
    var chunk = parts[i];
    if (!chunk.trim()) { out += chunk; continue; }
    var key = "";
    var fileMatch = chunk.match(/<h3[^>]*>[^<]*<code>([^<]+)<\/code>/);
    if (fileMatch) {
      key = fileMatch[1];
    } else if (chunk.indexOf("preview-footer-anchor") !== -1) {
      key = "Generated by repoDNA";
    } else {
      var headingMatch = chunk.match(/<h[23][^>]*>([^<]+)/);
      if (headingMatch) key = headingMatch[1].trim();
    }
    out += '<div class="preview-section"' +
      (key ? ' data-key="' + key.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '"' : "") +
      ">" + chunk + "</div>";
  }
  return out;
}

function findSectionByKey(panel, key) {
  var els = panel.querySelectorAll(".preview-section[data-key]");
  for (var i = 0; i < els.length; i++) {
    if (els[i].getAttribute("data-key") === key) return els[i];
  }
  return null;
}

function renderPreview() {
  var panel = document.getElementById("preview-panel");
  if (!S.previewContent) {
    S.previewContent = buildInitialPreview();
  }
  initPreviewListeners();

  // Capture scroll state before rebuild
  var prevScrollTop = panel.scrollTop;
  var prevScrollHeight = panel.scrollHeight;
  var wasAtBottom = prevScrollHeight - prevScrollTop - panel.clientHeight <= 60;

  // If user is hovering a section, anchor always wins — even at the bottom
  var anchorOffsetFromTop = 0;
  var anchorFound = false;
  if (_previewAnchorKey) {
    var anchorEl = findSectionByKey(panel, _previewAnchorKey);
    if (anchorEl) {
      anchorOffsetFromTop = anchorEl.getBoundingClientRect().top - panel.getBoundingClientRect().top;
      anchorFound = true;
    }
  }

  var badge = S.previewFinal
    ? '<span class="preview-final-badge">final</span>'
    : '<span class="preview-live-badge">● live</span>';
  var _outLabel = (AGENT_TARGETS[S.agentTarget] || AGENT_TARGETS.claude).file
    .split("/")
    .pop();
  panel.innerHTML =
    '<div class="preview-header"><span class="preview-title">' +
    escHtml(_outLabel) +
    "</span>" +
    badge +
    '<button class="result-copy-btn preview-copy-btn" onclick="window._copyPreview(this)" title="Copy full output">Copy</button>' +
    '</div><div class="md-body">' +
    wrapPreviewSections(md2html(S.previewContent)) +
    "</div>";

  // Restore scroll: anchor section keeps its viewport position; fallback to delta
  var postScrollTop = panel.scrollTop;
  if (anchorFound) {
    // Explicit anchor always wins, even when at the bottom
    var newAnchorEl = findSectionByKey(panel, _previewAnchorKey);
    if (newAnchorEl) {
      var newOffset = newAnchorEl.getBoundingClientRect().top - panel.getBoundingClientRect().top;
      panel.scrollTop = postScrollTop + (newOffset - anchorOffsetFromTop);
    } else {
      panel.scrollTop = postScrollTop + (panel.scrollHeight - prevScrollHeight);
    }
  } else if (wasAtBottom) {
    panel.scrollTop = panel.scrollHeight;
  } else {
    panel.scrollTop = postScrollTop + (panel.scrollHeight - prevScrollHeight);
  }

  // Re-apply hover highlight if mouse is still over the anchor section
  if (_previewAnchorKey) {
    var hoveredEl = findSectionByKey(panel, _previewAnchorKey);
    if (hoveredEl) hoveredEl.classList.add("anchor-hover");
  }
}

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
window.addEventListener("DOMContentLoaded", async function () {
  _loadModelStats();
  checkForUpdate();
  runChecks();
  loadOllamaModelsCatalog(); // carica il catalog JSON locale
  buildModeGrid();
  await loadProjectList();

  // Restore last used project (if any) and load its per-project settings
  try {
    var r = await fetch("/api/load-config");
    var d = await r.json();
    var cfg = d.config || {};
    // Apply only truly global settings
    if (cfg.ollamaHost) {
      document.getElementById("ollama-host").value = cfg.ollamaHost;
      S.ollamaHost = cfg.ollamaHost;
    }
    // Restore last project and load all its settings via selectProject.
    // The actual page is restored later by the `ui_page` SSE event, which also
    // triggers tree loading and review rebuilds — keep this block minimal.
    if (cfg.projectPath) {
      await selectProject(cfg.projectPath);
    }
  } catch {}

  populateModels();
  // Fallback: reveal after init in case ui_page SSE event is delayed or never fires
  setTimeout(_revealApp, 800);
});
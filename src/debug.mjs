// debug.mjs
import { existsSync, writeFileSync, unlinkSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

var __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname points at src/. Both files live at the repo root.
var ROOT_DIR = join(__dirname, "..");
var FLAG_FILE = join(ROOT_DIR, ".repodna-debug");
export var LOG_FILE = join(ROOT_DIR, "repodna-debug.log");

export function isDebugEnabled() {
  return existsSync(FLAG_FILE);
}

export function enableDebug() {
  writeFileSync(FLAG_FILE, "1");
}

export function disableDebug() {
  try {
    unlinkSync(FLAG_FILE);
  } catch (_) {}
}

export function clearDebugLog() {
  if (!isDebugEnabled()) return;
  writeFileSync(
    LOG_FILE,
    "=".repeat(60) +
      "\n" +
      "repoDNA debug log — " +
      new Date().toISOString() +
      "\n" +
      "col: file | size_b | act_sec | status\n" +
      "=".repeat(60) +
      "\n",
  );
}

export function debugLog(entry) {
  if (!isDebugEnabled()) return;
  // Human-readable table row + raw JSON on next line
  var row = [
    (entry.file || "—").padEnd(40),
    String(entry.size != null ? entry.size : "—").padStart(8),
    String(entry.fileTimeSec != null ? entry.fileTimeSec.toFixed(2) : "—").padStart(8),
    (entry.event || "—").padStart(10),
  ].join(" | ");

  appendFileSync(LOG_FILE, row + "\n  " + JSON.stringify(entry) + "\n");
}

#!/usr/bin/env node

const B = "\x1b[1m";   // bold
const D = "\x1b[2m";   // dim
const C = "\x1b[36m";  // cyan
const G = "\x1b[32m";  // green
const X = "\x1b[0m";   // reset

console.log("\n  " + B + "repoDNA" + X + " — AI context file generator\n");
console.log("  " + B + "Usage" + X);
console.log("  " + D + "─────────────────────────────────────────────" + X);

console.log("\n  " + C + "node main.mjs" + X + " " + D + "[flags]" + X);
console.log("    Start the repoDNA server and open the UI in your browser.");
console.log("    " + G + "--debug" + X + "    Write per-file stats to repodna-debug.log");
console.log("    " + G + "--no-open" + X + "  Start the server without opening the browser");

console.log("\n  " + C + "node update.mjs" + X + " " + D + "[flags]" + X);
console.log("    Check GitHub for a newer release, analyse data-store compatibility, and update.");
console.log("    " + G + "--list" + X + ", " + G + "-l" + X + "      Show all versions in a table with data compatibility");
console.log("    " + G + "--to <version>" + X + "  Update to a specific release tag (e.g. --to v2.0)");
console.log("    " + G + "--yes" + X + ", " + G + "-y" + X + "       Skip the confirmation prompt");
console.log("    " + G + "--force" + X + ", " + G + "-f" + X + "    Stash local changes automatically before updating");

console.log("\n  " + C + "node uninstall.mjs" + X + " " + D + "[flags]" + X);
console.log("    Remove the ~/.repodna data directory.");
console.log("    " + G + "--yes" + X + ", " + G + "-y" + X + "    Skip the confirmation prompt");

console.log("\n  " + D + "Examples" + X);
console.log("  " + D + "─────────────────────────────────────────────" + X);
console.log("  " + D + "node main.mjs --no-open" + X + "     Start without launching the browser");
console.log("  " + D + "node update.mjs --list" + X + "      List all versions + data compatibility");
console.log("  " + D + "node update.mjs --to v2.0" + X + "   Update to a specific release tag");
console.log("  " + D + "node update.mjs --force" + X + "     Update even with uncommitted changes");
console.log("  " + D + "node uninstall.mjs --yes" + X + "    Uninstall without a prompt\n");

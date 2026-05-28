#!/usr/bin/env node
import { startServer } from "./src/server.mjs";
import { exec } from "child_process";

var args = process.argv.slice(2);
var debugMode = args.includes("--debug");
var noOpen = args.includes("--no-open");

if (args.includes("--help") || args.includes("-h")) {
  await import("./help.mjs");
  process.exit(0);
}

if (debugMode) {
  process.env.REPODNA_DEBUG = "1";
  console.log(
    "  [debug] Debug mode ON — writing per-file stats to repodna-debug.log",
  );
}

startServer()
  .then(function (server) {
    if (noOpen) return;
    var addr = server && typeof server.address === "function" ? server.address() : null;
    var port = addr && typeof addr === "object" ? addr.port : null;
    if (!port) return;
    var url = "http://localhost:" + port;
    var cmd =
      process.platform === "win32" ? 'start "" "' + url + '"'
      : process.platform === "darwin" ? 'open "' + url + '"'
      : 'xdg-open "' + url + '"';
    exec(cmd, function () {});
  })
  .catch(function (e) {
    console.error(e);
    process.exit(1);
  });

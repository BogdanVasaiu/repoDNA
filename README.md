# repoDNA

> Generate AI context files from any codebase — locally, privately, in minutes.

repoDNA scans your project with a local [Ollama](https://ollama.com) model and writes the structured context file your AI coding assistant needs. No cloud API, no API keys, no data leaving your machine.

```bash
git clone https://github.com/BogdanVasaiu/repodna
cd repodna && node main.mjs
```

The UI opens automatically in your default browser at **http://localhost:3741**. Pass `--no-open` to skip the auto-launch (useful for headless/CI):

```bash
node main.mjs --no-open
```

---

## Requirements

| Requirement | Version |
|---|---|
| [Node.js](https://nodejs.org) | 18 or later |
| [Ollama](https://ollama.com) | any recent version |

No `npm install`. No build step. All dependencies are part of Node.js or loaded on demand.

---

## How it works

repoDNA is a five-step wizard that runs in your browser.

**01 — Ollama setup**
Checks whether Ollama is running and lists all locally installed models. If Ollama is not installed, the interface shows the exact install command for your platform (Windows, macOS, Linux). A curated model reference table is also available here, updated regularly, with models ranked by quality, speed, and VRAM requirements — so you can pick and pull the right one before starting.

**02 — Add your projects**
Register one or more local project paths with an optional description. The description is passed to the AI as context before any file is read.

**03 — Select what to scan**
An intelligent classifier examines your project structure — detects Node.js, Python, Rust, Go, and more — and auto-excludes folders like `node_modules`, build output, and binary files. Every decision is visible and overridable per file or per folder. Custom rules are saved per project.

**04 — Configure the analysis**
Select the Ollama model from a dropdown that lists everything currently installed in your Ollama instance. Set the analysis depth (see [precision modes](#analysis-precision) below). Advanced options include:

- **Smart Update** — only re-analyzes files that changed since the last run
- **File tree** — optionally embeds an ASCII tree of the project in the output (included files only, or full project)

**05 — Run**
A live dashboard shows each file being processed, its markdown result appearing in real time, and a running activity log. Failed files can be retried individually. Each result card can also be edited directly in the UI — changes are saved to the cache and the output file is rebuilt immediately from the cache, not from the project. This keeps manual edits safe: the algorithm never overwrites them by re-reading the project files.

---

## Output formats

repoDNA writes the context file in the exact format and location expected by your AI coding tool:

| Agent | Output file |
|---|---|
| Claude Code | `CLAUDE.md` |
| Cursor | `.cursorrules` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Gemini CLI | `GEMINI.md` |
| Windsurf | `AGENTS.md` |
| Codex CLI | `AGENTS.md` |
| Cline | `.clinerules/context.md` |
| Roo Code | `AGENTS.md` |
| Amp | `AGENT.md` |
| OpenCode | `AGENTS.md` |
| Generic | `AGENTS.md` |

---

## Analysis precision

Four modes, selectable per run:

| Mode | What it produces |
|---|---|
| **Fast** | One-line role + exports list. Best for large codebases where speed matters. |
| **Standard** | Role, key exports, non-obvious dependencies, gotchas. Best balance. |
| **Deep** | Full architecture, side effects, ordering constraints, AI guidance. |
| **Adaptive** | Auto-scales per file by size — small files get Fast, large ones get Deep. |

---

## Smart Update

When enabled, repoDNA hashes every analyzed file with MD5. On subsequent runs:

- **unchanged files** → result served from cache instantly
- **modified files** → re-analyzed
- **new files** → analyzed and added
- **deleted files** → removed from the output

The context file is always rebuilt from the internal cache (`~/.repodna/`), never by re-reading the project directly. This is intentional: it prevents the algorithm from being confused by content that was manually edited in the output file. If you want to adjust an entry, use the edit button in the UI — the change is saved to the cache and the output file is rebuilt cleanly from there.

---

## Data storage

All repoDNA data is stored in `~/.repodna/` — never inside your projects. The only file written to a project is the context file itself (e.g. `CLAUDE.md`).

```
~/.repodna/
  config.json              ← global settings and project list
  projects/
    <encoded-path>/
      hashes.json          ← MD5 cache for smart update
      results.json         ← cached analysis results
      new-files.json       ← new file tracking
```

---

## Debug mode

```bash
node main.mjs --debug
```

Writes per-file timing and stats to `repodna-debug.log` in the project directory.

---

## Update

```bash
node update.mjs
```

Checks GitHub for a newer release and pulls it automatically. Your data in `~/.repodna/` is never touched.

If you have uncommitted local changes, the update will abort to protect your work. Use `--force` to stash them automatically and restore them after:

```bash
node update.mjs --force
```

---

## Uninstall

```bash
node uninstall.mjs --yes
```

Removes `~/.repodna/` and all cached data. The cloned folder can then be deleted normally.

---

## License

MIT — see [LICENSE](./LICENSE).

The name **repoDNA**, the logo, and the domain **repodna.com** are the exclusive intellectual property of Bogdan Marian Vasaiu and are not covered by the MIT license. See the LICENSE file for the full brand reservation notice.

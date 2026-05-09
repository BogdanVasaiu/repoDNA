// ─── PRIORITY 1 — Universal Excluded Folders ─────────────
export const DEFAULT_EXCLUDED_FOLDERS = [
  "node_modules",
  "vendor",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "output",
  "target",
  "bin",
  "obj",
  "release",
  "debug",
  ".cache",
  "cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".venv",
  "venv",
  "env",
  "virtualenv",
  ".tox",
  "site-packages",
  ".gradle",
  ".mvn",
  "gradle",
  "Pods",
  "DerivedData",
  ".build",
  "xcuserdata",
  ".idea",
  ".vscode",
  ".vs",
  ".eclipse",
  "nbproject",
  ".settings",
  "__MACOSX",
  ".Spotlight-V100",
  ".Trashes",
  "$RECYCLE.BIN",
  "System Volume Information",
  "coverage",
  ".nyc_output",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".webpack",
  "storybook-static",
  ".repodna", // repoDNA internal data — always skip
];

// ─── PRIORITY 2 — Universal Excluded Filenames ───────────
export const DEFAULT_EXCLUDED_FILENAMES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "Gemfile.lock",
  "Podfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "shrinkwrap.json",
  "npm-shrinkwrap.json",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".gitkeep",
  ".npmignore",
  ".prettierignore",
  ".eslintcache",
  ".stylelintcache",
  "tsconfig.tsbuildinfo",
  // AI coding-assistant context files — these are repoDNA outputs or equivalent
  // files from other tools. Analysing them produces circular or hallucinated output.
  "CLAUDE.md",
  "AGENTS.md",
  "AGENT.md",
  "GEMINI.md",
  "CURSOR.md",
  "WINDSURF.md",
  "CLINE.md",
  "COPILOT.md",
  "OPENCODE.md",
  ".cursorrules",
  ".clinerules",
  ".windsurfrules",
];

// ─── PRIORITY 3 — Universal Excluded Extensions ──────────
export const DEFAULT_EXCLUDED_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "tiff",
  "tif",
  "webp",
  "ico",
  "icns",
  "heic",
  "heif",
  "avif",
  "raw",
  "cr2",
  "nef",
  "mp4",
  "avi",
  "mov",
  "mkv",
  "wmv",
  "flv",
  "webm",
  "m4v",
  "mpeg",
  "mpg",
  "ogv",
  "3gp",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "aac",
  "m4a",
  "wma",
  "opus",
  "aiff",
  "mid",
  "midi",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  "zip",
  "tar",
  "gz",
  "bz2",
  "xz",
  "rar",
  "7z",
  "dmg",
  "iso",
  "img",
  "deb",
  "rpm",
  "pkg",
  "msi",
  "exe",
  "apk",
  "ipa",
  "dll",
  "so",
  "dylib",
  "a",
  "lib",
  "o",
  "class",
  "pyc",
  "pyd",
  "pyo",
  "db",
  "sqlite",
  "sqlite3",
  "mdb",
  "accdb",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "log",
  "logs",
  "pem",
  "key",
  "p12",
  "pfx",
  "crt",
  "cer",
  "der",
  "jks",
  "lock",
  "wasm",
];

// ─── PRIORITY 4 — Universal Included Filenames ───────────
export const DEFAULT_INCLUDED_FILENAMES = [
  "README",
  "README.md",
  "README.txt",
  "README.rst",
  "CHANGELOG",
  "CHANGELOG.md",
  "CONTRIBUTING",
  "CONTRIBUTING.md",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "NOTICE",
  "NOTICE.md",
  "Makefile",
  "makefile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".dockerignore",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".ruby-version",
  ".tool-versions",
  "Procfile",
];

// ─── PRIORITY 5 — Universal Included Extensions ──────────
export const DEFAULT_INCLUDED_EXTENSIONS = [
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "mjs",
  "cjs",
  "ts",
  "mts",
  "cts",
  "jsx",
  "tsx",
  "vue",
  "svelte",
  "astro",
  "py",
  "rb",
  "php",
  "java",
  "kt",
  "kts",
  "groovy",
  "scala",
  "cs",
  "fs",
  "fsx",
  "fsi",
  "vb",
  "go",
  "rs",
  "c",
  "cpp",
  "cc",
  "cxx",
  "h",
  "hpp",
  "hxx",
  "swift",
  "m",
  "mm",
  "dart",
  "lua",
  "r",
  "jl",
  "nim",
  "zig",
  "ex",
  "exs",
  "erl",
  "hrl",
  "clj",
  "cljs",
  "cljc",
  "ml",
  "mli",
  "hs",
  "lhs",
  "pl",
  "pm",
  "t",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "psm1",
  "psd1",
  "bat",
  "cmd",
  "awk",
  "sed",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "config",
  "properties",
  "xml",
  "plist",
  "tf",
  "tfvars",
  "hcl",
  "sql",
  "graphql",
  "gql",
  "prisma",
  "proto",
  "thrift",
  "avro",
  "capnp",
  "md",
  "mdx",
  "rst",
  "txt",
  "adoc",
  "asciidoc",
  "tex",
  "latex",
  "ipynb",
  "gradle",
  "podspec",
  "gemspec",
  "nuspec",
];

// ─── PROJECT TYPE DETECTION ──────────────────────────────
export function detectProjectType(rootFiles) {
  const s = new Set(rootFiles.map((f) => f.toLowerCase()));
  if (s.has("package.json")) return "NODE_JS";
  if (
    s.has("requirements.txt") ||
    s.has("pyproject.toml") ||
    s.has("setup.py") ||
    s.has("setup.cfg")
  )
    return "PYTHON";
  if (s.has("cargo.toml")) return "RUST";
  if (s.has("pom.xml")) return "JAVA_MAVEN";
  if (s.has("build.gradle") || s.has("build.gradle.kts")) return "JAVA_GRADLE";
  if (s.has("gemfile")) return "RUBY";
  if (s.has("go.mod")) return "GO";
  if (s.has("composer.json")) return "PHP";
  if (rootFiles.some((f) => f.endsWith(".sln") || f.endsWith(".csproj")))
    return "DOTNET";
  if (rootFiles.some((f) => f.endsWith(".uproject"))) return "UNREAL";
  if (s.has("pubspec.yaml")) return "FLUTTER";
  if (rootFiles.some((f) => f.endsWith(".xcodeproj"))) return "IOS";
  return "UNKNOWN";
}

// ─── PROJECT-SPECIFIC RULES (PRIORITY 6) ─────────────────
const PROJECT_RULES = {
  NODE_JS: {
    excludedFolders: [
      ".next",
      ".nuxt",
      ".svelte-kit",
      ".turbo",
      "storybook-static",
    ],
    excludedFilenames: [],
    includedFilenames: [],
    includedExtensions: [],
  },
  PYTHON: {
    excludedFolders: [
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      ".venv",
      "venv",
      "env",
      "site-packages",
    ],
    excludedFilenames: [],
    includedFilenames: [
      "requirements.txt",
      "requirements-dev.txt",
      "requirements-prod.txt",
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "tox.ini",
      "pytest.ini",
      "mypy.ini",
      ".flake8",
    ],
    includedExtensions: [],
  },
  RUST: {
    excludedFolders: ["target"],
    excludedFilenames: [],
    includedFilenames: ["Cargo.toml"],
    includedExtensions: [],
  },
  JAVA_MAVEN: {
    excludedFolders: [".gradle", ".mvn", "target"],
    excludedFilenames: [],
    includedFilenames: ["pom.xml"],
    includedExtensions: [],
  },
  JAVA_GRADLE: {
    excludedFolders: [".gradle", "build"],
    excludedFilenames: [],
    includedFilenames: [
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      "gradle.properties",
    ],
    includedExtensions: [],
  },
  GO: {
    excludedFolders: ["vendor"],
    excludedFilenames: [],
    includedFilenames: ["go.mod", "go.sum"],
    includedExtensions: [],
  },
  RUBY: {
    excludedFolders: [".bundle", "vendor"],
    excludedFilenames: [],
    includedFilenames: ["Gemfile", "Gemfile.lock"],
    includedExtensions: [],
  },
  PHP: {
    excludedFolders: ["vendor"],
    excludedFilenames: [],
    includedFilenames: ["composer.json", "composer.lock"],
    includedExtensions: [],
  },
  DOTNET: {
    excludedFolders: ["bin", "obj", ".vs", "packages"],
    excludedFilenames: [],
    includedFilenames: [],
    includedExtensions: [
      "sln",
      "csproj",
      "fsproj",
      "vbproj",
      "props",
      "targets",
    ],
  },
  UNREAL: {
    excludedFolders: [
      "Binaries",
      "Intermediate",
      "Saved",
      "DerivedDataCache",
      "Build",
    ],
    excludedFilenames: [],
    includedFilenames: [],
    includedExtensions: ["cpp", "h", "cs", "uproject", "uplugin", "ini"],
  },
  FLUTTER: {
    excludedFolders: [".dart_tool", "build", ".pub-cache"],
    excludedFilenames: [],
    includedFilenames: [
      "pubspec.yaml",
      "pubspec.lock",
      "analysis_options.yaml",
    ],
    includedExtensions: [],
  },
  IOS: {
    excludedFolders: ["Pods", "DerivedData", "xcuserdata", ".build"],
    excludedFilenames: [],
    includedFilenames: [],
    includedExtensions: [
      "swift",
      "m",
      "mm",
      "h",
      "storyboard",
      "xib",
      "plist",
      "xcconfig",
    ],
  },
  ANDROID: {
    excludedFolders: [".gradle", "build", "captures", ".idea", "generated"],
    excludedFilenames: [],
    includedFilenames: [],
    includedExtensions: ["java", "kt", "xml", "gradle", "kts", "pro"],
  },
};

// ─── CATEGORY DEFINITIONS ────────────────────────────────
export const CATEGORIES = [
  {
    id: "source-code",
    label: "Codice sorgente",
    icon: "💻",
    defaultAutoStatus: "included",
    extensions: new Set([
      "html",
      "htm",
      "css",
      "scss",
      "sass",
      "less",
      "js",
      "mjs",
      "cjs",
      "ts",
      "mts",
      "cts",
      "jsx",
      "tsx",
      "vue",
      "svelte",
      "astro",
      "py",
      "rb",
      "php",
      "java",
      "kt",
      "kts",
      "groovy",
      "scala",
      "cs",
      "fs",
      "fsx",
      "fsi",
      "vb",
      "go",
      "rs",
      "c",
      "cpp",
      "cc",
      "cxx",
      "h",
      "hpp",
      "hxx",
      "swift",
      "m",
      "mm",
      "dart",
      "lua",
      "r",
      "jl",
      "nim",
      "zig",
      "ex",
      "exs",
      "erl",
      "hrl",
      "clj",
      "cljs",
      "cljc",
      "ml",
      "mli",
      "hs",
      "lhs",
      "pl",
      "pm",
      "t",
    ]),
  },
  {
    id: "config",
    label: "Configurazione",
    icon: "⚙️",
    defaultAutoStatus: "included",
    extensions: new Set([
      "json",
      "yaml",
      "yml",
      "toml",
      "ini",
      "cfg",
      "conf",
      "config",
      "properties",
      "xml",
      "plist",
      "tf",
      "tfvars",
      "hcl",
    ]),
  },
  {
    id: "docs",
    label: "Documentazione",
    icon: "📖",
    defaultAutoStatus: "included",
    extensions: new Set([
      "md",
      "mdx",
      "rst",
      "txt",
      "adoc",
      "asciidoc",
      "tex",
      "latex",
    ]),
  },
  {
    id: "styles",
    label: "Stili",
    icon: "🎨",
    defaultAutoStatus: "included",
    extensions: new Set(["css", "scss", "sass", "less"]),
  },
  {
    id: "templates",
    label: "Template / Markup",
    icon: "🖼️",
    defaultAutoStatus: "included",
    extensions: new Set([
      "html",
      "htm",
      "vue",
      "svelte",
      "astro",
      "jsx",
      "tsx",
    ]),
  },
  {
    id: "data-schema",
    label: "Schema e Query",
    icon: "🗄️",
    defaultAutoStatus: "included",
    extensions: new Set([
      "sql",
      "graphql",
      "gql",
      "prisma",
      "proto",
      "thrift",
      "avro",
      "capnp",
    ]),
  },
  {
    id: "notebooks",
    label: "Notebook",
    icon: "📓",
    defaultAutoStatus: "included",
    extensions: new Set(["ipynb"]),
  },
  {
    id: "scripts",
    label: "Script di sistema",
    icon: "📜",
    defaultAutoStatus: "included",
    extensions: new Set([
      "sh",
      "bash",
      "zsh",
      "fish",
      "ps1",
      "psm1",
      "psd1",
      "bat",
      "cmd",
      "awk",
      "sed",
    ]),
  },
  {
    id: "images",
    label: "Immagini",
    icon: "🖼️",
    defaultAutoStatus: "excluded",
    extensions: new Set([
      "png",
      "jpg",
      "jpeg",
      "gif",
      "bmp",
      "tiff",
      "tif",
      "webp",
      "ico",
      "icns",
      "heic",
      "heif",
      "avif",
      "raw",
      "cr2",
      "nef",
    ]),
  },
  {
    id: "svg",
    label: "SVG",
    icon: "✏️",
    defaultAutoStatus: "ambiguous",
    extensions: new Set(["svg"]),
  },
  {
    id: "fonts",
    label: "Font",
    icon: "🔤",
    defaultAutoStatus: "excluded",
    extensions: new Set(["ttf", "otf", "woff", "woff2", "eot"]),
  },
  {
    id: "audio-video",
    label: "Audio e Video",
    icon: "🎬",
    defaultAutoStatus: "excluded",
    extensions: new Set([
      "mp4",
      "avi",
      "mov",
      "mkv",
      "wmv",
      "flv",
      "webm",
      "m4v",
      "mpeg",
      "mpg",
      "ogv",
      "3gp",
      "mp3",
      "wav",
      "ogg",
      "flac",
      "aac",
      "m4a",
      "wma",
      "opus",
      "aiff",
      "mid",
      "midi",
    ]),
  },
  {
    id: "archives",
    label: "Archivi e Binari",
    icon: "📦",
    defaultAutoStatus: "excluded",
    extensions: new Set([
      "zip",
      "tar",
      "gz",
      "bz2",
      "xz",
      "rar",
      "7z",
      "dmg",
      "iso",
      "img",
      "deb",
      "rpm",
      "pkg",
      "msi",
      "exe",
      "apk",
      "ipa",
      "dll",
      "so",
      "dylib",
      "a",
      "lib",
      "o",
      "class",
      "pyc",
      "pyd",
      "pyo",
      "wasm",
    ]),
  },
  {
    id: "locks",
    label: "Lock files",
    icon: "🔒",
    defaultAutoStatus: "excluded",
    extensions: new Set(["lock"]),
  },
  {
    id: "generated",
    label: "File generati",
    icon: "⚙️",
    defaultAutoStatus: "excluded",
    extensions: new Set(["map"]),
  },
  {
    id: "logs",
    label: "Log",
    icon: "📋",
    defaultAutoStatus: "excluded",
    extensions: new Set(["log", "logs"]),
  },
  {
    id: "certs",
    label: "Certificati",
    icon: "🔐",
    defaultAutoStatus: "excluded",
    extensions: new Set([
      "pem",
      "key",
      "p12",
      "pfx",
      "crt",
      "cer",
      "der",
      "jks",
    ]),
  },
  {
    id: "unknown",
    label: "Tipo sconosciuto",
    icon: "❓",
    defaultAutoStatus: "ambiguous",
    extensions: new Set(),
  },
];

export function assignCategory(extension) {
  if (!extension) return "unknown";
  const ext = extension.toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.id !== "unknown" && cat.extensions.has(ext)) return cat.id;
  }
  return "unknown";
}

// ─── COMPUTE EFFECTIVE RULES ─────────────────────────────
export function computeEffectiveRules(
  customRules = {},
  globalExclusions = {},
  globalInclusions = {},
) {
  const cr = {
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
    ...customRules,
  };
  return {
    excludedFolders: new Set([
      ...DEFAULT_EXCLUDED_FOLDERS.filter(
        (f) => !cr.removedDefaultExcludedFolders.includes(f),
      ),
      ...cr.excludedFolders,
      ...(globalExclusions.folders || []),
    ]),
    excludedFilenames: new Set(
      [
        ...DEFAULT_EXCLUDED_FILENAMES.filter(
          (f) => !cr.removedDefaultExcludedFilenames.includes(f),
        ),
        ...cr.excludedFilenames,
        ...(globalExclusions.fileNames || []),
      ].map((f) => f.toLowerCase()),
    ),
    excludedExtensions: new Set(
      [
        ...DEFAULT_EXCLUDED_EXTENSIONS.filter(
          (e) => !cr.removedDefaultExcludedExtensions.includes(e),
        ),
        ...cr.excludedExtensions,
        ...(globalExclusions.extensions || []),
      ].map((e) => e.toLowerCase().replace(/^\./, "")),
    ),
    includedFilenames: new Set([
      ...DEFAULT_INCLUDED_FILENAMES.filter(
        (f) => !cr.removedDefaultIncludedFilenames.includes(f),
      ),
      ...cr.includedFilenames,
      ...(globalInclusions.fileNames || []),
    ]),
    includedExtensions: new Set(
      [
        ...DEFAULT_INCLUDED_EXTENSIONS.filter(
          (e) => !cr.removedDefaultIncludedExtensions.includes(e),
        ),
        ...cr.includedExtensions,
        ...(globalInclusions.extensions || []),
      ].map((e) => e.toLowerCase().replace(/^\./, "")),
    ),
    includedFolders: new Set([
      ...cr.includedFolders,
      ...(globalInclusions.folders || []),
    ]),
  };
}

// ─── CLASSIFY NODE ───────────────────────────────────────
export function classifyNode(node, projectType, rules) {
  // Priority 1: Excluded folders
  if (node.type === "directory") {
    if (node.name === ".repodna") {
      return {
        autoStatus: "excluded",
        autoExcludeReason: "Cartella interna repoDNA — esclusa sempre",
      };
    }
    if (rules.excludedFolders.has(node.name.toLowerCase())) {
      return {
        autoStatus: "excluded",
        autoExcludeReason:
          "Cartella generata/dipendenze — non utile per documentazione",
      };
    }
    if (rules.includedFolders.has(node.name.toLowerCase())) {
      return { autoStatus: "included", autoExcludeReason: null };
    }
    return { autoStatus: "included", autoExcludeReason: null }; // directories pass through
  }

  const nameLower = node.name.toLowerCase();
  const ext = (node.extension || "").toLowerCase();

  // Priority 2: Excluded filenames
  if (rules.excludedFilenames.has(nameLower)) {
    // Special: Cargo.lock
    if (nameLower === "cargo.lock") {
      // Ambiguous by default — let project rules decide
      if (projectType === "RUST")
        return {
          autoStatus: "ambiguous",
          autoExcludeReason:
            "Cargo.lock — decidere in base al tipo di progetto",
        };
    }
    return {
      autoStatus: "excluded",
      autoExcludeReason:
        "File di lock o di sistema — non utile per documentazione",
    };
  }

  // Priority 3: Excluded extensions
  if (ext && rules.excludedExtensions.has(ext)) {
    return {
      autoStatus: "excluded",
      autoExcludeReason: "Estensione binaria/generata — non analizzabile",
    };
  }

  // Priority 4: Included filenames
  if (
    rules.includedFilenames.has(node.name) ||
    rules.includedFilenames.has(nameLower)
  ) {
    return { autoStatus: "included", autoExcludeReason: null };
  }

  // Special: .env.example / .env.sample / .env.template
  if (/^\.env\.(example|sample|template)$/i.test(node.name)) {
    return { autoStatus: "included", autoExcludeReason: null };
  }

  // Priority 5: Included extensions
  if (ext && rules.includedExtensions.has(ext)) {
    // Exception: .min. files
    if (node.name.includes(".min."))
      return {
        autoStatus: "excluded",
        autoExcludeReason: "File minificato — versione generata",
      };
    // Exception: .map
    if (ext === "map")
      return {
        autoStatus: "excluded",
        autoExcludeReason: "Source map — file generato",
      };
    // Exception: .generated. or .gen.
    if (node.name.includes(".generated.") || node.name.includes(".gen."))
      return {
        autoStatus: "excluded",
        autoExcludeReason: "File generato automaticamente",
      };
    // Exception: .env
    if (node.name === ".env")
      return {
        autoStatus: "excluded",
        autoExcludeReason: "Contiene credenziali — non includere mai",
      };
    return { autoStatus: "included", autoExcludeReason: null };
  }

  // Priority 6: Project-specific rules
  const prules = PROJECT_RULES[projectType];
  if (prules) {
    if (prules.excludedFilenames?.some((f) => f.toLowerCase() === nameLower)) {
      return {
        autoStatus: "excluded",
        autoExcludeReason: `File escluso per progetto ${projectType}`,
      };
    }
    if (
      prules.includedFilenames?.some(
        (f) => f === node.name || f.toLowerCase() === nameLower,
      )
    ) {
      return { autoStatus: "included", autoExcludeReason: null };
    }
    if (ext && prules.includedExtensions?.includes(ext)) {
      return { autoStatus: "included", autoExcludeReason: null };
    }
  }

  // Priority 7: File size
  if (node.size > 2 * 1024 * 1024) {
    return {
      autoStatus: "excluded",
      autoExcludeReason: "File molto grande (> 2MB)",
    };
  }
  if (node.size > 500 * 1024) {
    return {
      autoStatus: "ambiguous",
      autoExcludeReason: "File grande (> 500KB) — verificare se utile",
    };
  }

  // Priority 8: Hidden files
  if (node.isHidden) {
    return {
      autoStatus: "excluded",
      autoExcludeReason: "File nascosto non riconosciuto",
    };
  }

  // Priority 9: Fallback
  return {
    autoStatus: "ambiguous",
    autoExcludeReason: "Tipo di file non riconosciuto — verifica manualmente",
  };
}

export function computeFinalStatus(node) {
  if (node.userOverride) return node.userOverride;
  if (node.autoStatus === "ambiguous") return "excluded"; // conservative default
  return node.autoStatus;
}

// ─── GET ALL DEFAULT RULES (for advanced settings UI) ────
export function getDefaultRules() {
  return {
    excludedFolders: [...DEFAULT_EXCLUDED_FOLDERS],
    excludedFilenames: [...DEFAULT_EXCLUDED_FILENAMES],
    excludedExtensions: [...DEFAULT_EXCLUDED_EXTENSIONS],
    includedFilenames: [...DEFAULT_INCLUDED_FILENAMES],
    includedExtensions: [...DEFAULT_INCLUDED_EXTENSIONS],
  };
}
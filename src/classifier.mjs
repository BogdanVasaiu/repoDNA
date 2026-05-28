// ─── PRIORITY 1 — Universal Excluded Folders ─────────────
// Keep this list to items that are genuinely cross-ecosystem.
// Language-specific folders live in PROJECT_RULES and are merged
// into the effective rules at scan time based on detected project type.
export const DEFAULT_EXCLUDED_FOLDERS = [
  // Version control
  ".git", ".svn", ".hg",
  // Universal dependency/vendor directories
  "node_modules", "vendor",
  // Generic build & output directories (used across many ecosystems)
  "dist", "build", "out", "output", "target",
  // Generic caches
  ".cache", "cache",
  // IDE / editor directories
  ".idea", ".vscode", ".vs", ".eclipse", "nbproject", ".settings",
  // OS-generated junk
  "__MACOSX", ".Spotlight-V100", ".Trashes", "$RECYCLE.BIN",
  "System Volume Information",
  // Generic test-coverage output
  "coverage",
  // repoDNA internal data — always skip
  ".repodna",
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
  // Android must come before generic JAVA_GRADLE (it also uses Gradle)
  if (
    s.has("local.properties") &&
    (s.has("build.gradle") || s.has("build.gradle.kts") || s.has("settings.gradle"))
  )
    return "ANDROID";
  if (s.has("build.gradle") || s.has("build.gradle.kts")) return "JAVA_GRADLE";
  if (s.has("build.sbt")) return "SCALA";
  if (s.has("gemfile")) return "RUBY";
  if (s.has("go.mod")) return "GO";
  if (s.has("mix.exs")) return "ELIXIR";
  if (s.has("composer.json")) return "PHP";
  if (rootFiles.some((f) => f.endsWith(".sln") || f.endsWith(".csproj")))
    return "DOTNET";
  if (s.has("cmakelists.txt")) return "C_CPP";
  if (rootFiles.some((f) => f.endsWith(".uproject"))) return "UNREAL";
  // Unity: always has both Assets/ and ProjectSettings/ at root
  if (s.has("assets") && s.has("projectsettings")) return "UNITY";
  if (s.has("project.godot")) return "GODOT";
  if (s.has("pubspec.yaml")) return "FLUTTER";
  // Swift Package Manager (Package.swift) — before Xcode project check
  if (s.has("package.swift")) return "SWIFT";
  if (rootFiles.some((f) => f.endsWith(".xcodeproj") || f.endsWith(".xcworkspace")))
    return "IOS";
  return "UNKNOWN";
}

// ─── PROJECT-SPECIFIC RULES (PRIORITY 6) ─────────────────
// excludedFolders here are ecosystem-specific — they are NOT in DEFAULT_EXCLUDED_FOLDERS.
// computeEffectiveRules merges the detected project type's folders into the rules
// Set so classifyNode's Priority-1 directory check actually sees them.
// UNKNOWN projects get a union of every type's folders as a safe catch-all.
const PROJECT_RULES = {
  NODE_JS: {
    excludedFolders: [
      ".next", ".nuxt", ".svelte-kit", ".turbo",
      ".parcel-cache", ".webpack", "storybook-static", ".nyc_output",
    ],
    excludedFilenames: [],
    includedFilenames: [],
    includedExtensions: [],
  },
  PYTHON: {
    excludedFolders: [
      "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
      ".venv", "venv", "env", "virtualenv", ".tox", "site-packages",
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
    excludedFolders: [],   // "target" is already in DEFAULT_EXCLUDED_FOLDERS
    excludedFilenames: [],
    includedFilenames: ["Cargo.toml"],
    includedExtensions: [],
  },
  JAVA_MAVEN: {
    excludedFolders: [".gradle", ".mvn", "gradle"],
    excludedFilenames: [],
    includedFilenames: ["pom.xml"],
    includedExtensions: [],
  },
  JAVA_GRADLE: {
    excludedFolders: [".gradle", "gradle"],
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
    excludedFolders: [],   // "vendor" is already in DEFAULT_EXCLUDED_FOLDERS
    excludedFilenames: [],
    includedFilenames: ["go.mod", "go.sum"],
    includedExtensions: [],
  },
  RUBY: {
    excludedFolders: [".bundle"],   // "vendor" is already in DEFAULT_EXCLUDED_FOLDERS
    excludedFilenames: [],
    includedFilenames: ["Gemfile", "Gemfile.lock"],
    includedExtensions: [],
  },
  PHP: {
    excludedFolders: [],   // "vendor" is already in DEFAULT_EXCLUDED_FOLDERS
    excludedFilenames: [],
    includedFilenames: ["composer.json", "composer.lock"],
    includedExtensions: [],
  },
  DOTNET: {
    excludedFolders: ["bin", "obj", "packages"],
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
    excludedFolders: ["Binaries", "Intermediate", "Saved", "DerivedDataCache"],
    excludedFilenames: [],
    includedFilenames: [],
    includedExtensions: ["cpp", "h", "cs", "uproject", "uplugin", "ini"],
  },
  FLUTTER: {
    excludedFolders: [".dart_tool", ".pub-cache"],   // "build" is in DEFAULT_EXCLUDED_FOLDERS
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
    excludedFolders: [".gradle", "gradle", "captures", "generated"],
    excludedFilenames: [],
    includedFilenames: ["local.properties", "proguard-rules.pro", "google-services.json"],
    includedExtensions: ["java", "kt", "xml", "gradle", "kts", "pro"],
  },
  ELIXIR: {
    excludedFolders: ["_build", "deps", ".elixir_ls", "cover"],
    excludedFilenames: [],
    includedFilenames: ["mix.exs", "mix.lock", ".formatter.exs", ".credo.exs"],
    includedExtensions: [],
  },
  C_CPP: {
    excludedFolders: ["cmake-build-debug", "cmake-build-release", "CMakeFiles", ".cmake", "bin", "obj", "release", "debug"],
    excludedFilenames: [],
    includedFilenames: [
      "CMakeLists.txt",
      "Makefile",
      "makefile",
      "configure",
      "configure.ac",
      "meson.build",
      "conanfile.txt",
      "conanfile.py",
      "vcpkg.json",
    ],
    includedExtensions: ["c", "cpp", "cc", "cxx", "h", "hpp", "hxx", "ipp", "inl", "s", "asm"],
  },
  SWIFT: {
    excludedFolders: [".build", ".swiftpm", "DerivedData"],
    excludedFilenames: [],
    includedFilenames: ["Package.swift", "Package.resolved", ".swiftlint.yml"],
    includedExtensions: ["swift"],
  },
  UNITY: {
    excludedFolders: ["Library", "Temp", "Logs", "UserSettings", "Builds", "obj"],
    excludedFilenames: [],
    includedFilenames: [],
    includedExtensions: ["cs", "shader", "hlsl", "cginc", "glsl", "compute", "asmdef", "asmref"],
  },
  SCALA: {
    excludedFolders: [".bsp", ".metals", ".scala-build"],   // "target" is in DEFAULT_EXCLUDED_FOLDERS
    excludedFilenames: [],
    includedFilenames: ["build.sbt", "build.properties", ".scalafmt.conf", ".scalafix.conf"],
    includedExtensions: ["scala", "sbt", "sc"],
  },
  GODOT: {
    excludedFolders: [".godot"],
    excludedFilenames: ["export_presets.cfg"],
    includedFilenames: ["project.godot"],
    includedExtensions: ["gd", "gdshader", "gdns", "gdnlib", "tscn", "tres", "gdextension"],
  },
};

// ─── CATEGORY DEFINITIONS ────────────────────────────────
// Order matters — assignCategory returns the first match, so more specific
// categories must come before the broad "source-code" catch-all.
export const CATEGORIES = [
  {
    id: "styles",
    label: "Styles",
    icon: "🎨",
    defaultAutoStatus: "included",
    extensions: new Set(["css", "scss", "sass", "less", "styl", "stylus", "pcss"]),
  },
  {
    id: "templates",
    label: "Templates",
    icon: "🖼️",
    defaultAutoStatus: "included",
    extensions: new Set([
      // Component frameworks
      "html", "htm", "xhtml", "vue", "svelte", "astro", "jsx", "tsx",
      // JS engines
      "hbs", "handlebars", "ejs", "pug", "jade", "njk", "nunjucks", "mustache",
      // Python engines
      "jinja", "jinja2", "j2", "mako",
      // Ruby
      "erb",
      // PHP / generic
      "liquid", "twig", "latte",
      // Java engines
      "jsp", "jspx", "vm", "ftl",
      // ASP.NET / Razor
      "asp", "aspx", "cshtml", "vbhtml",
      // Go templates
      "gohtml", "gotmpl", "tmpl",
      // HAML
      "haml",
      // XSLT
      "xsl", "xslt",
    ]),
  },
  {
    id: "scripts",
    label: "Scripts",
    icon: "📜",
    defaultAutoStatus: "included",
    extensions: new Set([
      // Unix shells
      "sh", "bash", "zsh", "fish", "csh", "ksh", "nu",
      // Windows
      "ps1", "psm1", "psd1", "bat", "cmd", "vbs",
      // Utilities
      "awk", "sed", "tcl", "expect",
    ]),
  },
  {
    id: "shaders",
    label: "Shaders",
    icon: "✨",
    defaultAutoStatus: "included",
    extensions: new Set([
      "shader", "hlsl", "cginc", "glsl", "gdshader",
      "wgsl", "metal", "vert", "frag", "comp", "compute",
      "geom", "tesc", "tese",
      // Ray tracing stages
      "rgen", "rmiss", "rchit", "rahit", "rint", "rcall",
    ]),
  },
  {
    id: "3d-models",
    label: "3D Models",
    icon: "🧊",
    defaultAutoStatus: "ambiguous",
    extensions: new Set([
      // Common interchange
      "obj", "fbx", "gltf", "glb", "dae", "stl", "ply", "x3d", "3ds",
      // USD (Pixar / Apple)
      "usd", "usda", "usdc", "usdz",
      // DCC tools
      "blend", "abc", "mtl", "ma", "mb",
      // CAD
      "igs", "iges", "stp", "step",
    ]),
  },
  {
    id: "game-assets",
    label: "Game Assets",
    icon: "🎮",
    defaultAutoStatus: "ambiguous",
    extensions: new Set([
      // Godot
      "tscn", "tres", "gdns", "gdnlib", "gdextension",
      // Unity
      "prefab", "unity", "mat", "anim", "controller",
      "mask", "asset", "physicsmaterial", "physicsmaterial2d",
      "overridecontroller", "playable", "terrainlayer",
      "asmdef", "asmref",
    ]),
  },
  {
    id: "data-schema",
    label: "Data & Schema",
    icon: "🗄️",
    defaultAutoStatus: "included",
    extensions: new Set([
      "sql", "graphql", "gql", "prisma",
      "proto", "thrift", "avro", "capnp", "fbs",
      // XML schemas & web services
      "wsdl", "xsd", "dtd", "rng",
    ]),
  },
  {
    id: "notebooks",
    label: "Notebooks",
    icon: "📓",
    defaultAutoStatus: "included",
    extensions: new Set(["ipynb", "rmd", "qmd"]),
  },
  {
    id: "source-code",
    label: "Source Code",
    icon: "💻",
    defaultAutoStatus: "included",
    extensions: new Set([
      // JS / TS
      "js", "mjs", "cjs", "ts", "mts", "cts",
      // Python
      "py", "pyw",
      // JVM
      "java", "kt", "kts", "groovy", "scala",
      // .NET
      "cs", "fs", "fsx", "fsi", "vb",
      // Systems languages
      "go", "rs", "c", "cpp", "cc", "cxx", "h", "hpp", "hxx", "ipp", "inl",
      "zig", "nim", "odin", "d", "cr", "v",
      // Assembly
      "asm", "s", "nasm",
      // WebAssembly text
      "wat",
      // Mobile / cross-platform
      "swift", "m", "mm", "dart", "rb", "php",
      // Functional / ML family
      "hs", "lhs", "ml", "mli", "sml", "sig",
      // Erlang / Elixir
      "ex", "exs", "erl", "hrl",
      // Clojure family
      "clj", "cljs", "cljc",
      // Frontend FP
      "elm", "purs",
      // Lisp family
      "lisp", "cl", "lsp", "el", "rkt", "rktl", "scm", "ss",
      // Other FP / emerging
      "gleam", "hx",
      // Scala scripts (Ammonite)
      "sc",
      // Game scripting
      "gd", "coffee", "litcoffee",
      // Hardware description
      "vhd", "vhdl", "sv", "svh",
      // Scripting
      "lua", "r", "jl", "pl", "pm", "t",
      // Legacy / enterprise
      "cob", "cbl", "cpy",
      "ada", "adb", "ads",
      "pas", "pp", "dpr",
      "f", "f90", "f95", "f03", "f08", "for",
      // Blockchain
      "sol", "vy", "cairo", "move",
    ]),
  },
  {
    id: "config",
    label: "Config",
    icon: "⚙️",
    defaultAutoStatus: "included",
    extensions: new Set([
      // Serialization
      "json", "jsonc", "json5", "yaml", "yml", "toml", "ini",
      "cfg", "conf", "config", "properties",
      // Markup-based
      "xml", "plist",
      // IaC
      "tf", "tfvars", "hcl",
      // Build / package defs
      "gradle", "sbt", "podspec", "gemspec", "nuspec",
      "bazel", "bzl",
      // Config languages
      "nix", "dhall", "cue",
      // Xcode
      "xcconfig",
      // Env
      "env", "envrc",
    ]),
  },
  {
    id: "docs",
    label: "Docs",
    icon: "📖",
    defaultAutoStatus: "included",
    extensions: new Set([
      "md", "mdx", "rst", "txt",
      "adoc", "asciidoc", "tex", "latex",
      "wiki", "org", "pod", "man",
      // Gherkin / Cucumber test specs
      "feature",
    ]),
  },
  {
    id: "documents",
    label: "Documents",
    icon: "📄",
    defaultAutoStatus: "excluded",
    extensions: new Set([
      "pdf",
      "doc", "docx", "odt",
      "xls", "xlsx", "ods",
      "ppt", "pptx", "odp",
      "rtf", "pages", "numbers", "key",
    ]),
  },
  {
    id: "localization",
    label: "Localization",
    icon: "🌐",
    defaultAutoStatus: "included",
    extensions: new Set([
      "po", "pot",           // GNU gettext
      "xlf", "xliff",        // XLIFF (iOS / enterprise)
      "strings", "stringsdict", // Apple platforms
      "resx",                // .NET
      "arb",                 // Flutter / Dart
    ]),
  },
  {
    id: "data-files",
    label: "Data Files",
    icon: "📊",
    defaultAutoStatus: "ambiguous",
    extensions: new Set(["csv", "tsv", "jsonl", "ndjson"]),
  },
  {
    id: "images",
    label: "Images",
    icon: "🖼️",
    defaultAutoStatus: "excluded",
    extensions: new Set([
      // Raster
      "png", "jpg", "jpeg", "gif", "bmp",
      "tiff", "tif", "webp", "ico", "icns",
      "heic", "heif", "avif", "raw", "cr2", "nef",
      // GPU / game textures
      "dds", "tga", "exr", "hdr", "ktx", "pvr", "astc",
      // Design source files
      "psd", "psb", "ai", "eps", "xcf", "kra", "ora", "sketch", "fig",
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
    label: "Fonts",
    icon: "🔤",
    defaultAutoStatus: "excluded",
    extensions: new Set(["ttf", "otf", "woff", "woff2", "eot", "fnt", "fon", "pfb", "pfm"]),
  },
  {
    id: "audio-video",
    label: "Audio & Video",
    icon: "🎬",
    defaultAutoStatus: "excluded",
    extensions: new Set([
      // Video (no "ts" — conflicts with TypeScript)
      "mp4", "avi", "mov", "mkv", "wmv", "flv", "webm",
      "m4v", "mpeg", "mpg", "ogv", "3gp", "vob", "f4v", "m2ts",
      // Audio
      "mp3", "wav", "ogg", "flac", "aac", "m4a",
      "wma", "opus", "aiff", "aif", "mid", "midi",
      "amr", "mka", "wv", "ac3",
    ]),
  },
  {
    id: "archives",
    label: "Archives & Binaries",
    icon: "📦",
    defaultAutoStatus: "excluded",
    extensions: new Set([
      // Archives
      "zip", "tar", "gz", "bz2", "xz", "rar", "7z", "zst", "lz", "cab", "cpio",
      // Installers / packages
      "dmg", "iso", "img", "deb", "rpm", "pkg", "msi", "msix",
      "jar", "war", "ear",
      "nupkg", "vsix", "crx", "xpi",
      // Executables & compiled
      "exe", "apk", "ipa", "dll", "so", "dylib",
      "a", "lib", "o", "class", "pyc", "pyd", "pyo", "wasm",
      // Binary data / legacy
      "bin", "dat", "hex", "swf",
    ]),
  },
  {
    id: "databases",
    label: "Databases",
    icon: "🗃️",
    defaultAutoStatus: "excluded",
    extensions: new Set([
      "db", "sqlite", "sqlite3", "db3",
      "mdb", "accdb", "ldb", "sdf", "realm",
    ]),
  },
  {
    id: "locks",
    label: "Lock Files",
    icon: "🔒",
    defaultAutoStatus: "excluded",
    extensions: new Set(["lock"]),
  },
  {
    id: "generated",
    label: "Generated",
    icon: "⚙️",
    defaultAutoStatus: "excluded",
    extensions: new Set([
      "map",
      // Test snapshots (Jest / Vitest)
      "snap",
    ]),
  },
  {
    id: "logs",
    label: "Logs",
    icon: "📋",
    defaultAutoStatus: "excluded",
    extensions: new Set(["log", "logs"]),
  },
  {
    id: "certs",
    label: "Certificates",
    icon: "🔐",
    defaultAutoStatus: "excluded",
    extensions: new Set([
      "pem", "key", "p12", "pfx", "crt", "cer", "der",
      "jks", "keystore",
      "ppk", "pub", "gpg", "pgp", "asc", "p7b", "p7c", "csr",
    ]),
  },
  {
    id: "unknown",
    label: "Unknown",
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
// Pre-compute the union of all project-type folder exclusions so UNKNOWN
// projects get a comprehensive catch-all without runtime iteration cost.
const _UNKNOWN_EXTRA_FOLDERS = (function () {
  const all = new Set();
  for (const r of Object.values(PROJECT_RULES)) {
    for (const f of (r.excludedFolders || [])) all.add(f.toLowerCase());
  }
  return [...all];
})();

export function computeEffectiveRules(
  customRules = {},
  globalExclusions = {},
  globalInclusions = {},
  projectType = "UNKNOWN",
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
  const typeFolders = (
    projectType === "UNKNOWN"
      ? _UNKNOWN_EXTRA_FOLDERS
      : (PROJECT_RULES[projectType]?.excludedFolders || []).map((f) => f.toLowerCase())
  ).filter((f) => !cr.removedDefaultExcludedFolders.includes(f));

  return {
    excludedFolders: new Set([
      ...DEFAULT_EXCLUDED_FOLDERS.filter(
        (f) => !cr.removedDefaultExcludedFolders.includes(f),
      ),
      ...typeFolders,
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
        autoExcludeReason: "repoDNA internal folder — always excluded",
      };
    }
    if (rules.excludedFolders.has(node.name.toLowerCase())) {
      return {
        autoStatus: "excluded",
        autoExcludeReason: "Generated folder or dependencies — skipped",
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
          autoExcludeReason: "Cargo.lock — check if needed for your project type",
        };
    }
    return {
      autoStatus: "excluded",
      autoExcludeReason: "— skipped",
    };
  }

  // Priority 3: Excluded extensions
  if (ext && rules.excludedExtensions.has(ext)) {
    return {
      autoStatus: "excluded",
      autoExcludeReason: "Binary or generated file type — not analysable",
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
        autoExcludeReason: "Minified file — generated output",
      };
    // Exception: .map
    if (ext === "map")
      return {
        autoStatus: "excluded",
        autoExcludeReason: "Source map — generated file",
      };
    // Exception: .generated. or .gen.
    if (node.name.includes(".generated.") || node.name.includes(".gen."))
      return {
        autoStatus: "excluded",
        autoExcludeReason: "Auto-generated file",
      };
    // Exception: .env
    if (node.name === ".env")
      return {
        autoStatus: "excluded",
        autoExcludeReason: "Contains credentials — never include",
      };
    return { autoStatus: "included", autoExcludeReason: null };
  }

  // Priority 6: Project-specific rules
  const prules = PROJECT_RULES[projectType];
  if (prules) {
    if (prules.excludedFilenames?.some((f) => f.toLowerCase() === nameLower)) {
      return {
        autoStatus: "excluded",
        autoExcludeReason: `Excluded for ${projectType} project type`,
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
      autoExcludeReason: "Very large file (> 2 MB) — skipped",
    };
  }
  if (node.size > 500 * 1024) {
    return {
      autoStatus: "ambiguous",
      autoExcludeReason: "Large file (> 500 KB) — check if needed",
    };
  }

  // Priority 8: Hidden files
  if (node.isHidden) {
    return {
      autoStatus: "excluded",
      autoExcludeReason: "Unrecognised hidden file",
    };
  }

  // Priority 9: Fallback
  return {
    autoStatus: "ambiguous",
    autoExcludeReason: "Unrecognised file type — check manually",
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
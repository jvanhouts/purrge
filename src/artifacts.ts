/**
 * What counts as regenerable junk, and what merely looks like it.
 */

/** Always regenerable, whatever the surrounding directory looks like. */
export const ARTIFACT_DIRS = new Set([
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".angular",
  ".turbo",
  ".vercel",
  ".netlify",
  ".parcel-cache",
  ".vite",
  ".output",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "DerivedData",
  ".gradle",
  ".dart_tool",
]);

/**
 * Names that are only artifacts when they sit next to a matching manifest.
 * Without this gate we would happily eat vendored source such as
 * `wwwroot/lib/bootstrap/dist` or `vendor/phpunit/php-token-stream/build`.
 */
export const GATED_ARTIFACT_DIRS = new Map<string, string[]>([
  ["dist", ["package.json", "deno.json", "bun.lockb", "bun.lock"]],
  ["build", ["package.json", "pom.xml", "build.gradle", "build.gradle.kts", "CMakeLists.txt"]],
  ["out", ["package.json"]],
  ["coverage", ["package.json", "pyproject.toml", "setup.py"]],
  ["target", ["Cargo.toml", "pom.xml", "build.sbt"]],
  [".cache", ["package.json"]],
  ["vendor", ["composer.json"]],
  ["Pods", ["Podfile"]],
  [".venv", ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"]],
  ["venv", ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"]],
]);

/** Never walked into while looking for projects. */
export const SKIP_DIRS = new Set([".git", ".hg", ".svn", ".Trash", "Library", ".DS_Store"]);

/** Dependency trees that never contain a project of your own. */
export const NO_DESCEND = new Set(["vendor", "Pods", ".venv", "venv", "Carthage"]);

/** Tauri's Rust app lives below the JavaScript project root. */
export const TAURI_DIR = "src-tauri";

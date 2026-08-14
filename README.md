# purrge 🐱

Cough up the build artifacts your stale projects are sitting on.

`purrge` walks a directory tree, finds every project, works out how long ago you
last touched each one, measures what its `node_modules` / `.next` / `dist` / `Pods`
/ … are costing you, and lets you pick which ones to delete.

```
🐱 purrge
   ~/Documents/projects
   idle 4+ weeks · min 10 MB

3 projects scanned in 3.7s · 2 worth purging

  arrows to move · space to toggle · enter when ready
❯ [✓] old-client-site    52 MB     2y  node_modules dist
  [ ] nested/prototype   52 MB   15mo  node_modules dist

  52 MB across 1 project
  space toggle · a all · n none · enter confirm · esc cancel
```

The footer total is live — it recounts as you tick rows, so you can see what a
selection actually buys you before committing to it.

## Install

Nothing to install — if you have [Bun](https://bun.sh), just run it:

```sh
bunx github:jvanhouts/purrge 8
```

To pin a known version (recommended if you're sharing it around — see below):

```sh
bunx github:jvanhouts/purrge#v0.2.0 8
```

Or keep it on your PATH:

```sh
bun add -g git+https://github.com/jvanhouts/purrge.git
```

[gum](https://github.com/charmbracelet/gum) is optional but it's the nice half —
`brew install gum`. Without it, purrge falls back to plain text and a `y/N`
prompt, so it stays scriptable either way.

### Getting a newer version

Heads up: `bunx github:user/repo` with no ref resolves the default branch **once**
and then caches that commit forever. A later `bunx` run re-uses the cached copy
and silently gives you the old build — bunx has no `--force` or `--no-cache` flag.

Two ways around it:

```sh
bunx github:jvanhouts/purrge#v0.2.0    # pin a tag — a new tag is a new cache key
bun pm cache rm                        # or nuke the cache, then re-run
```

## Usage

```
purrge [weeks] [options]

  -w, --weeks <n>   only projects untouched for n+ weeks (default 4)
  -r, --root <dir>  directory to scan (default: cwd)
  -m, --min <size>  ignore projects below this size (default 10M)
  -a, --all         no age filter — list every project
  -y, --yes         no prompts, purge everything listed
  -n, --dry-run     list what would go, delete nothing
  -j, --json        machine-readable output, never deletes
```

```sh
purrge 8                  # projects idle for 8+ weeks, under cwd
purrge -r ~/code -m 1G    # only the big stuff
purrge -a -j | jq         # inventory everything, delete nothing
```

## How it decides

**What's a project.** Any directory containing an artifact dir. Nesting is fine:
a monorepo root and each of its packages are listed separately, and their sizes
never double-count.

**What's an artifact.** Two tiers, because being wrong here means deleting source:

- *Always* — `node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.astro`, `.turbo`,
  `.vercel`, `.output`, `__pycache__`, `DerivedData`, `.gradle`, and friends.
- *Only next to a matching manifest* — `dist`, `build`, `out`, `target`,
  `coverage`, `vendor`, `Pods`, `.venv`. A `dist/` beside a `package.json` is
  build output; `wwwroot/lib/bootstrap/dist` is vendored source and is left
  alone. On a real tree this gate spared 19 directories that a naive
  name-match would have eaten.

**How old.** The newest mtime among the project's *own* source files, artifacts
excluded and computed recursively. A months-old `node_modules` under an actively
edited `src/` is not stale.

**How big.** `du -sk` per artifact directory (C speed, 8 in flight), with a pure
JS fallback where `du` isn't available.

## Performance

The walk never descends into artifact directories — that's where the file count
lives — so it scales with the size of your source tree, not your dependencies.
Directory reads run 16-wide, sizing 8-wide, deletion 6 projects × 4 dirs wide.
A ~20-project, 40 GB tree scans in under 4 seconds.

## Caveats

- Deletion is real and immediate; nothing goes to the Trash.
- `vendor/` is only reclaimable if your `composer.lock` is committed. Same
  reasoning applies to any lockfile-less dependency dir.
- mtime is a proxy for "am I still working on this", not proof. `--dry-run`
  first if you're unsure.

## License

MIT

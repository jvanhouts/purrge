# purrge 🐱

Cough up the build artifacts your stale projects are sitting on.

`purrge` walks a directory tree, finds every project, works out how long ago you
last touched each one, measures what its `node_modules` / `.next` / `dist` / `Pods`
/ … are costing you, and lets you pick which ones to delete.

```
🐱 purrge
   ~/Documents/projects
   idle 4+ weeks · min 10 MB

  ⠹ sniffing around projects… 41 projects · 6 worth purging
    old-client-site     52 MB     2y
    nested/prototype    52 MB   15mo
    …and 4 more

3 projects scanned in 3.7s · 2 worth purging

  arrows to move · space to toggle · enter when ready
❯ [✓] old-client-site    52 MB     2y  node_modules dist
  [ ] nested/prototype   52 MB   15mo  node_modules dist

  52 MB across 1 project
  space toggle · a all · n none · enter confirm · esc cancel
```

Matches appear in the preview as they are found, biggest first, rather than
after the whole walk finishes — sizing a large `node_modules` takes long enough
that a bare spinner wastes the wait.

The footer total is live too: it recounts as you tick rows, so you can see what
a selection actually buys you before committing to it.

Build artifacts are not the only thing accumulating: `purrge sims` does the
same job for iOS simulators, their runtimes, Xcode device support and Android
emulators, none of which live anywhere near a project.

## Install

Install from npm (purrge uses Bun as its runtime):

```sh
npm install -g purrge
```

Or run the repository directly with [Bun](https://bun.sh):

```sh
bunx github:jvanhouts/purrge 8
```

To pin a known version (recommended if you're sharing it around — see below):

```sh
bunx github:jvanhouts/purrge#v0.4.0 8
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
bunx github:jvanhouts/purrge#v0.4.0    # pin a tag — a new tag is a new cache key
bun pm cache rm                        # or nuke the cache, then re-run
```

## Usage

```
purrge [weeks] [options]
purrge cargo sweep [options]
purrge worktrees [days] [options]
purrge sims [days] [options]
purrge stats [options]

  -w, --weeks <n>   only projects untouched for n+ weeks (default 8)
  -d, --days <n>    cargo sweep / worktree / sim age threshold in days
  -r, --root <dir>  directory to scan (default: cwd)
  -m, --min <size>  ignore projects below this size (default 10M)
  -a, --all         no age filter — list every project
  -y, --yes         no prompts, purge everything listed
  -n, --dry-run     list what would go, delete nothing
  -j, --json        machine-readable output, never deletes
      --stream      stats only: one JSON line per section, as each finishes
  -f, --force       include ones held back as unsafe or in use
```

```sh
purrge 8                  # projects idle for 8+ weeks, under cwd
purrge -r ~/code -m 1G    # only the big stuff
purrge -a -j | jq         # inventory everything, delete nothing
purrge cargo sweep        # remove Cargo targets untouched for 14+ days
purrge cargo sweep -n     # preview stale Cargo/Tauri build outputs
purrge worktrees          # remove git worktrees idle for 14+ days
purrge worktrees 30 -n    # preview worktrees idle for 30+ days
purrge sims               # iOS simulators & Android emulators idle 30+ days
purrge sims 90 -n         # preview the ones untouched for 90+ days
purrge stats              # in use vs stale: projects, worktrees, sims
```

## Worktrees

`purrge worktrees` cleans up the linked git worktrees piling up under a shared
checkout root — the ones a branch-per-worktree workflow leaves behind, each
carrying its own `node_modules`.

```
🐱 purrge
   ~/.whiskers/worktrees
   idle 14+ days · min 10 MB

53 worktrees scanned in 12.3s · 25 worth purging

  · voja-monorepo-feat-filter-traveler-lists   held back — dirty unmerged
  · whiskers-main-7                            held back — dirty
2 worktrees kept back — --force to include them.

❯ [✓] whiskers-chat-refactor   7.5 GB    7d  @20f718a
  [✓] whiskers-main            3.7 GB   10d  settings-sections
```

The roots to scan come from `WORKTREE_ROOTS` in the global config, or from
`--root`. Age is the newest mtime of the worktree's own files — `node_modules`
and other build output excluded, so reinstalling dependencies does not make a
dead branch look alive.

**What it refuses to touch.** A worktree is held back, listed but not offered
up, when removing it would destroy work that exists nowhere else:

- *dirty* — uncommitted changes in the working tree.
- *unmerged* — a detached `HEAD` whose commits no branch contains. A worktree
  on a named branch is never flagged: the branch outlives the directory.

`--force` includes them anyway.

**How it removes them.** Via `git worktree remove` in the parent repository, so
the repo's `.git/worktrees` bookkeeping goes with it and `git worktree list`
stops advertising a path that is no longer there. If git refuses, purrge deletes
the directory and runs `git worktree prune` instead.

## Simulators and emulators

`purrge sims` goes after the phone tooling, which is the one pile that never
shows up in a project scan — the devices live under `~/Library/Developer`, the
runtimes under `/Library`, the AVDs under `~/.android`. It is usually the
biggest single win on a machine that builds for phones: two stale runtimes
outweigh every `node_modules` you own.

```
🐱 purrge
   simulators, runtimes & emulators
   idle 30+ days · min 10 MB

22 items scanned in 1.1s · 20 worth purging

  · iOS 26.5 runtime                            held back — used by 11 sims
  · android-35 google_apis_playstore arm64-v8a  held back — used by 1 avd
2 items kept back — --force to include them.

❯ [✓] iOS 18.3 runtime             8.1 GB  never  runtime 18.3.1
  [✓] iPhone17,1 26.3.1 (23D8133)  5.5 GB    4mo  iOS device support
  [✓] Medium Phone API 35          4.8 GB    3mo  avd android-35
  [ ] iPhone 17 Pro                2.3 GB    2mo  iOS 26.5
```

Five kinds of thing, all of them regenerable:

- *simulators* — one directory per simulated device, from
  `xcrun simctl list devices`. Age is when it was last booted.
- *runtimes* — the downloaded iOS/watchOS/tvOS images simulators are cut from,
  around 8 GB each. Only the ones simctl reports as `deletable` are offered;
  the ones bundled inside Xcode are not yours to remove.
- *device support* — `iPhone17,1 26.3.1 (23D8133)` and friends under
  `~/Library/Developer/Xcode/*` DeviceSupport, copied off a physical device the
  first time you plug it in on a given OS build and kept forever after. Xcode
  re-copies them on the next connect.
- *AVDs* — Android virtual devices under `~/.android/avd`. The `.avd` directory
  and its `.ini` pointer are found through the pointer, not by name: the two do
  not have to match, and often don't.
- *system images* — `<sdk>/system-images/<api>/<tag>/<abi>`, what an AVD is cut
  from.

**What it holds back.** Removing a runtime does not remove the simulators cut
from it — it leaves them behind, unavailable — and the same goes for a system
image an AVD still names. Both are listed with a count of what depends on them
and then set aside; a booted simulator is set aside too, since simctl will
refuse to delete it. `--force` includes them anyway.

**How it removes them.** Through the tool that created it wherever there is
one: `simctl delete` and `simctl runtime delete` so CoreSimulator's own device
index goes with the directory, `avdmanager delete avd` so the pointer file goes
with the AVD. If the tooling is missing or refuses, purrge deletes the same
paths directly. Device support and system images are plain directories and have
never had anything else to update.

`ANDROID_AVD_HOME`, `ANDROID_SDK_ROOT` and `ANDROID_HOME` are honoured. On
Linux the iOS half finds nothing and stays quiet.

## Stats and the menu bar app

`purrge stats` deletes nothing. It reports how much there is and how much of
it has gone stale: project artifacts under `PROJECT_ROOTS`, git worktrees under
`WORKTREE_ROOTS`, and simulators and emulators.

```
  projects  ████████████████████████  14 GB · 232 MB idle 8+ weeks (6 of 22)
  worktrees ████████████████████████  84 GB · 81 GB idle 14+ days (48 of 58, 20 held back)
  sims      ████████████████████████  11 devices · 10 idle 30+ days · 18 GB in runtimes & images
```

`--json` gives the same numbers to anything that wants to draw them.
`--stream` prints one JSON line per section as soon as that section's scan
finishes. Simulators take about a second and a big worktree root takes half a
minute, so nothing has to wait for the slowest scan. One such
thing lives in this repo: **PurrgeBar**, a macOS menu bar app in
[`apps/menubar`](apps/menubar). It shows a bar for each: green for in use, pink
for stale. On the worktree bar, a dimmer pink marks stale worktrees that
purrge holds back because they are dirty or unmerged. Each bar fills in as soon as its own scan is done. During a rescan, the
previous numbers stay on screen. It rescans every 30 minutes, whenever
`~/.purrge/config.yml` changes, and when you ask it to; a config change abandons
a scan already in progress.

```sh
bun run app:install   # build PurrgeBar.app and copy it to ~/Applications
bun run app           # just build it, into apps/menubar/build/
bun run app:dev       # swift run against the working tree
```

It needs macOS 14+, Xcode or the Swift toolchain, and Bun to build. The app
does not need Bun to run: the build compiles purrge into the app bundle with
`bun build --compile`, and the app shells out to that copy. The app never
decides what counts as stale; it draws whatever `purrge stats` reports.
"Edit config…" in its menu opens `~/.purrge/config.yml` and creates it first if
it is missing.

## Configuration

Machine-wide settings live in `~/.purrge/config.yml` — this is where the
worktree roots belong, since they are a fact about your machine rather than
about any one project:

```yaml
PURGE_STALE_WEEKS_AMOUNT: 8
CARGO_SWEEP_STALE_DAYS_AMOUNT: 14
WORKTREE_STALE_DAYS_AMOUNT: 14
SIM_STALE_DAYS_AMOUNT: 30
WORKTREE_ROOTS:
  - ~/.whiskers/worktrees
PROJECT_ROOTS:
  - ~/Documents/projects
```

A `purrge.config.json` in the directory you run purrge from overrides the global
file per project, and environment variables override both:

```json
{
  "PURGE_STALE_WEEKS_AMOUNT": 8,
  "CARGO_SWEEP_STALE_DAYS_AMOUNT": 14
}
```

Lowest precedence first: defaults → `~/.purrge/config.yml` →
`./purrge.config.json` → environment → command-line flags. `WORKTREE_ROOTS` and
`PROJECT_ROOTS` as environment variables are comma- or colon-separated lists.

`PURGE_STALE_WEEKS_AMOUNT` controls the normal project purge age. `purrge cargo
sweep` uses `CARGO_SWEEP_STALE_DAYS_AMOUNT` and detects regular Cargo projects
as well as Tauri projects, including their `src-tauri/target` build output and
bundles. `purrge worktrees` uses `WORKTREE_STALE_DAYS_AMOUNT`, and `purrge
sims` uses `SIM_STALE_DAYS_AMOUNT` (default 30 — simulators live longer between
uses than a branch does).

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
- Deleting an iOS runtime leaves every simulator cut from it in place but
  unavailable; purrge holds those runtimes back, but `--force` does not.
- `purrge sims` sizes device support and system images with `du`, so a first
  run on a cold cache spends a second or two before anything appears.
- A worktree's stashes live in the parent repo and survive it; its reflog does
  not. "Unmerged" is judged against branches, so a commit reachable only from
  another worktree's detached `HEAD` counts as unmerged.

## License

MIT

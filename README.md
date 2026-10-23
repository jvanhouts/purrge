# purrgatory 🐱

Cough up the build artifacts your stale projects are sitting on.

The command is `purrge` — this is where your stale projects wait to be cleared out.

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

purrgatory runs on [Bun](https://bun.sh), so install that first if you haven't:
`curl -fsSL https://bun.sh/install | bash`.

Then put `purrge` on your PATH, pinned to a tag:

```sh
bun install -g github:jvanhouts/purrge#v0.5.0
```

That symlinks `purrge` into `~/.bun/bin`. To upgrade, re-run it with a newer tag.

From npm, once published:

```sh
npm install -g purrgatory
```

Or run it without installing anything:

```sh
bunx github:jvanhouts/purrge#v0.5.0 8
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
bunx github:jvanhouts/purrge#v0.5.0    # pin a tag — a new tag is a new cache key
bun pm cache rm                        # or nuke the cache, then re-run
```

## Usage

```
purrge [weeks] [options]
purrge cargo sweep [options]
purrge worktrees [days] [options]
purrge sims [days] [options]
purrge caches | xcode | docker | tools [options]
purrge doctor [--json] [--add-roots]
purrge history
purrge stats [options]
purrge config [command]

  -w, --weeks <n>   only projects untouched for n+ weeks (default 8)
  -d, --days <n>    cargo sweep / worktree / sim age threshold in days
  -r, --root <dir>  directory to scan (default: PROJECT_ROOTS from config)
  -c, --current     scan the current directory instead
  -m, --min <size>  ignore projects below this size (default 10M)
  -a, --all         no age filter — list every project
  -y, --yes         no prompts, purge everything listed
  -n, --dry-run     list what would go, delete nothing
  -j, --json        machine-readable output, never deletes
      --stream      stats only: one JSON line per section, as each finishes
  -f, --force       include ones held back as unsafe or in use
```

```sh
purrge 8                  # projects idle for 8+ weeks, in your project dirs
purrge -c                 # just the current directory
purrge -r ~/code -m 1G    # only the big stuff
purrge -a -j | jq         # inventory everything, delete nothing
purrge cargo sweep        # remove Cargo targets untouched for 14+ days
purrge cargo sweep -n     # preview stale Cargo/Tauri build outputs
purrge worktrees          # remove git worktrees idle for 14+ days
purrge worktrees 30 -n    # preview worktrees idle for 30+ days
purrge sims               # iOS simulators & Android emulators idle 30+ days
purrge sims 90 -n         # preview the ones untouched for 90+ days
purrge caches -n          # npm, Bun, Gradle, Yarn, CocoaPods… caches
purrge xcode              # DerivedData per project; archives review-only
purrge docker -n          # Docker build cache and unused images
purrge tools              # Node, NDK, Rust and browser versions nothing pins
purrge doctor             # why is the disk full? read-only
purrge history            # what grew between scans
purrge stats              # in use vs stale, free space, every provider
```

A plain `purrge` scans the directories in `PROJECT_ROOTS`. It names them and
asks before it starts (`-y` skips the question). If none are set it prints a
short usage note instead of guessing. Use `-c` for the current directory, or
`-r <dir>` for any other one.

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
1 worktree kept back — --force to include it.

❯ [✓] whiskers-chat-refactor   7.5 GB    7d  @20f718a
  [✓] whiskers-main            3.7 GB   10d  settings-sections
```

purrge looks for worktrees in two places. The first is the folders in
`WORKTREE_ROOTS`, such as `~/.whiskers/worktrees`. The second is every repo
under `PROJECT_ROOTS`: purrge asks each one where its worktrees are, so a
checkout made with a plain `git worktree add` is found wherever it was put,
next to the repo or inside it. `--root` scans only the folder you name.

It only works in that direction. A normal `purrge` run skips linked worktrees
it finds under the project directories, because removing a worktree is
`purrge worktrees`' job. That also keeps `purrge stats` from counting the same
bytes twice. Run `purrge -c` from inside a worktree to purge its build output
alone.

Age is the newest mtime of the worktree's own files — `node_modules`
and other build output excluded, so reinstalling dependencies does not make a
dead branch look alive.

**What it refuses to touch.** A worktree is held back, listed but not offered
up, when it is *unmerged*: a detached `HEAD` whose commits no branch contains.
A worktree on a named branch is never flagged — the branch outlives the
directory. `--force` includes them anyway.

A *dirty* worktree, one with uncommitted changes, is offered up like any other
but marked `dirty` in red in the picker, so you can untick it.

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

## Beyond your projects: caches, Xcode, Docker, tools

Project artifacts are often the smaller part of a full disk. The rest sits in
shared stores no project root contains. Four commands cover them, all with the
same flags (`-n`, `-y`, `-j`, `-f`, `-m`) and the same picker:

| Command | What it inventories | How it cleans |
| --- | --- | --- |
| `purrge caches` | npm `_cacache` and `_npx`, Bun's install cache, Gradle, Yarn Classic and Berry, CocoaPods, Coursier, NuGet, the Cargo registry, uv, Homebrew downloads | The owner's command where one exists (`npm cache clean --force`, `bun pm cache rm`, `yarn cache clean`, `pod cache clean --all`, `uv cache clean`, `dotnet nuget locals`), otherwise the store's directory. Installed global tools (`~/.bun/install/global`, `~/.cargo/bin`) are never touched |
| `purrge xcode` | `DerivedData`, one row per project, named after its workspace; shared module caches; Archives | Deletes the DerivedData folder. Archives are review-only and go to the Trash when picked |
| `purrge docker` | Build cache, images, containers and volumes, through `docker system df -v` | `docker builder prune`, `docker image rm`, `docker rm`, `docker volume rm` — never `docker system prune`, never the VM file |
| `purrge tools` | Volta Node/npm/Yarn versions and downloads, Android NDKs and build tools, Rust toolchains, Playwright and Puppeteer browsers, Ollama models | `rustup toolchain uninstall`, `sdkmanager --uninstall`, `ollama rm`, or the version's directory |

Each finding is one of three things:

- **eligible** — offered up, ticked by default.
- **held back** — listed with the reason and not offered, unless you pass
  `--force`. Examples: npm's cache while an `npm install` runs, DerivedData
  during an active build, an image a container uses, your default Node, a
  version a project pins, the newest NDK.
- **review-only** — Xcode archives (their dSYMs may be your only way to
  symbolicate crashes), stopped containers, every Docker volume (an unattached
  database volume can still be the only copy), Ollama models. `--yes` never
  removes these. With `--force` they join the picker unticked, so only a
  deliberate tick takes one.

Clearing a cache wipes the whole store, and the reason column says so. It
costs offline installs and a slower next install; directory age proves nothing
about whether a cached package is used. Sizes are what `du` measured, so
hardlinked stores and shared Docker layers can free less than they add up to.
After a cleanup purrge reports free space before and after, as well as its
estimate.

Version pins are read from `package.json` `volta` fields, `.nvmrc`,
`.node-version`, `rust-toolchain(.toml)` and Gradle's `ndkVersion` /
`buildToolsVersion` under `PROJECT_ROOTS`. A project outside those roots cannot
pin anything, so run `purrge doctor` first and add the roots it suggests.

## Doctor and history

`purrge doctor` deletes nothing. It starts from the disk itself instead of
from what purrge already knows about:

- free space, with a warning when it is below 10% or 20 GB
- every provider, split into eligible, held back and review-only
- **code roots you have not configured**: directories near the top of your home
  that hold repos with build artifacts, sized with the same scanner, plus
  apps that keep worktrees of their own under Application Support. It offers to
  add them to your config, or `--add-roots` does it without asking
- large artifacts in *active* projects. A 20 GB Tauri `target` in a project
  you touched yesterday is rightly not stale, but it is worth knowing about
- large locations no provider covers, with app state labelled as app state:
  Notion, Cursor, Spotify, your photos
- files over 1 GB, listed without judgement
- locations it could not read. They are unknown, not empty. Grant your terminal
  Full Disk Access to see them
- what is left: OS-reported use minus what was measured, labelled
  *unclassified* rather than explained away

It takes a few minutes, mostly running `du` over your home directory.

Every doctor run, and a `purrge stats` run at most every six hours, appends a
line of sizes to `~/.purrge/history.jsonl`. File contents are never recorded.
Cleanups are logged there too. `purrge history` compares the last two scans and
reports what grew. Only scopes that were complete in both scans count as
growth: a location that appears because Docker was running this time is
"newly visible", not growth.

**Scans that could not see.** A failed `simctl` used to look exactly like a
machine with no simulators. Now every section and provider reports a status:
`complete`, `partial` (some locations unreadable, sizes are a floor),
`unavailable` (Docker's daemon is down, say) or `error`. A `du` that exits
non-zero is reported as partial, not taken at its word. A missing tool is
reported separately from a tool that failed.

## Stats and the menu bar app

`purrge stats` deletes nothing. It reports free disk space, then how much there
is and how much of it has gone stale: project artifacts under `PROJECT_ROOTS`,
git worktrees under `WORKTREE_ROOTS`, simulators and emulators, and every
provider above.

```
  disk      ████████████████████████  9.3 GB free of 460 GB  low on space — run purrge doctor
  projects  ████████████████████████  13 GB · 1.1 MB idle 8+ weeks (4 of 12)
  worktrees ████████████████████████  1.6 GB · 908 KB idle 14+ days (1 of 16)
  sims      ████████████████████████  22 devices · 2.7 GB idle 30+ days (20 of 22)
  images    ████████████████████████  28 GB · 10 GB reclaimable
  caches    ████████████████████████  55 GB · 55 GB eligible, 8.3 MB held back
  xcode     ████████████████████████  16 GB · 14 GB eligible
  docker    ████████████████████████  37 GB · 11 GB eligible, 13 GB held back
  tools     ████████████████████████  25 GB · 14 GB eligible, 6.0 GB held back
```

Simulator totals subtract what purrge would hold back: a stale runtime that
simulators still use is not counted as reclaimable.

`--json` gives the same numbers to anything that wants to draw them.
`--stream` prints one JSON line per section as soon as that section's scan
finishes. Simulators take about a second and a big worktree root takes half a
minute, so nothing has to wait for the slowest scan. One such
thing lives in this repo: **PurrgeBar**, a macOS menu bar app in
[`apps/menubar`](apps/menubar). It shows a bar for each: green for in use, pink
for stale. A dimmer pink marks the stale part purrge holds back: unmerged
worktrees, runtimes still in use. Free disk space comes first, and turns red
and changes the icon to a warning when it runs low. Simulators are drawn by
bytes rather than by device count, so one unused 8 GB runtime registers. Caches,
Xcode, Docker and tools get a line each. A section that could not scan says so
instead of showing zero. Each bar fills in as soon as its own scan is done. During a rescan, the
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

### From the command line

`purrge config` shows every setting and where its value comes from, followed by
the commands that change them. Changes go to `~/.purrge/config.yml`. The file
is created if it is missing, and any comments in it are dropped on write.

```sh
purrge config add projects ~/code .   # add directories to PROJECT_ROOTS
purrge config remove projects ~/code
purrge config set weeks 12            # PURGE_STALE_WEEKS_AMOUNT
purrge config unset worktrees         # back to the default
purrge config get projects
purrge config edit                    # open it in $EDITOR
```

The short key names are `projects`, `worktrees`, `weeks`, `cargo-days`,
`worktree-days` and `sim-days`. The full names work too.

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

- Deletion is real and immediate. Nothing goes to the Trash, except Xcode
  archives.
- Clearing a package cache costs offline installs and slows the next install.
  Each store is its own row, so untick the ones you rely on.
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

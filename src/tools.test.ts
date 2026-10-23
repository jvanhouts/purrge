import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compareVersions,
  exactNodeVersion,
  findPins,
  gradlePins,
  newestPerGroup,
  parseDecimalSize,
  parseOllamaList,
  parsePlaywrightDir,
  parsePuppeteerDir,
  parseRustupList,
  rustToolchainPin,
  toolchainMatches,
  voltaPins,
} from "./tools";

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(prefix: string) {
  const created = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirs.push(created);
  return realpath(created);
}

describe("compareVersions", () => {
  test("compares numerically, not as strings", () => {
    expect(compareVersions("18.20.8", "18.9.0")).toBeGreaterThan(0);
    expect(compareVersions("v20.0.0", "20.0.0")).toBe(0);
    expect(compareVersions("27.1.12297006", "27.0.12077973")).toBeGreaterThan(0);
  });

  test("a missing segment counts as zero", () => {
    expect(compareVersions("36", "35.0.1")).toBeGreaterThan(0);
  });
});

describe("newestPerGroup", () => {
  test("keeps one newest per group", () => {
    const dirs = ["chromium-1105", "chromium-1234", "firefox-1440", "chromium_headless_shell-1234"].map(
      (n) => parsePlaywrightDir(n)!,
    );
    const newest = newestPerGroup(dirs, (d) => d.browser, (d) => d.revision);

    expect([...newest].map((d) => `${d.browser}-${d.revision}`).sort()).toEqual([
      "chromium-1234",
      "chromium_headless_shell-1234",
      "firefox-1440",
    ]);
  });
});

describe("parseRustupList", () => {
  test("reads names and flags", () => {
    const text = "stable-aarch64-apple-darwin (active, default)\nnightly-2024-01-01-aarch64-apple-darwin\n1.75.0-aarch64-apple-darwin (default)\n";

    expect(parseRustupList(text)).toEqual([
      { name: "stable-aarch64-apple-darwin", isDefault: true, isActive: true },
      { name: "nightly-2024-01-01-aarch64-apple-darwin", isDefault: false, isActive: false },
      { name: "1.75.0-aarch64-apple-darwin", isDefault: true, isActive: false },
    ]);
  });

  test("no toolchains installed is an empty list", () => {
    expect(parseRustupList("no installed toolchains\n")).toEqual([]);
  });
});

describe("parseOllamaList", () => {
  test("splits on the column gaps, not the space inside SIZE", () => {
    const text = [
      "NAME                ID              SIZE      MODIFIED     ",
      "x/flux2-klein:4b    50a0c0ab15ac    5.7 GB    5 months ago    ",
      "llama3:8b           365c0bd3c000    812 MB    2 days ago",
    ].join("\n");

    expect(parseOllamaList(text)).toEqual([
      { name: "x/flux2-klein:4b", id: "50a0c0ab15ac", bytes: 5_700_000_000, modified: "5 months ago" },
      { name: "llama3:8b", id: "365c0bd3c000", bytes: 812_000_000, modified: "2 days ago" },
    ]);
  });

  test("a header alone is no models", () => {
    expect(parseOllamaList("NAME  ID  SIZE  MODIFIED\n")).toEqual([]);
  });

  test("sizes are decimal", () => {
    expect(parseDecimalSize("1.5 kB")).toBe(1500);
    expect(parseDecimalSize("nope")).toBeNull();
  });
});

describe("browser directory names", () => {
  test("playwright: browser and revision", () => {
    expect(parsePlaywrightDir("chromium_headless_shell-1234")).toEqual({ browser: "chromium_headless_shell", revision: "1234" });
    expect(parsePlaywrightDir(".links")).toBeNull();
  });

  test("puppeteer: platform kept apart from the build id", () => {
    expect(parsePuppeteerDir("mac_arm-153.0.8010.36")).toEqual({ platform: "mac_arm", buildId: "153.0.8010.36" });
    expect(parsePuppeteerDir("mac-1108766")).toEqual({ platform: "mac", buildId: "1108766" });
  });
});

describe("pin extraction", () => {
  test("volta block of a package.json", () => {
    expect(voltaPins(JSON.stringify({ volta: { node: "20.19.5", yarn: "1.22.19", extends: "../package.json" } }))).toEqual({
      node: "20.19.5",
      yarn: "1.22.19",
    });
    expect(voltaPins("{ not json")).toEqual({});
  });

  test("only exact versions in .nvmrc pin anything", () => {
    expect(exactNodeVersion("v18.18.2\n")).toBe("18.18.2");
    expect(exactNodeVersion("lts/iron")).toBeNull();
    expect(exactNodeVersion("20")).toBeNull();
  });

  test("gradle, groovy and kotlin forms", () => {
    const groovy = `android {\n  ndkVersion "27.0.12077973"\n  buildToolsVersion '35.0.0'\n}`;
    const kts = `android {\n  ndkVersion = "27.1.12297006"\n  buildToolsVersion = "36.0.0"\n}`;

    expect(gradlePins(groovy)).toEqual({ ndk: ["27.0.12077973"], buildTools: ["35.0.0"] });
    expect(gradlePins(kts)).toEqual({ ndk: ["27.1.12297006"], buildTools: ["36.0.0"] });
  });

  test("rust-toolchain, bare and toml", () => {
    expect(rustToolchainPin("1.75.0\n")).toBe("1.75.0");
    expect(rustToolchainPin(`[toolchain]\nchannel = "nightly-2024-01-01"\ncomponents = ["rustfmt"]\n`)).toBe("nightly-2024-01-01");
    expect(rustToolchainPin(`[toolchain]\ncomponents = ["rustfmt"]\n`)).toBeNull();
  });

  test("a channel pin matches the host-suffixed toolchain name", () => {
    expect(toolchainMatches("stable-aarch64-apple-darwin", "stable")).toBe(true);
    expect(toolchainMatches("stable-aarch64-apple-darwin", "beta")).toBe(false);
  });
});

describe("findPins", () => {
  test("collects pins once per project and stays out of node_modules", async () => {
    const root = await scratch("purrge-tools-");
    await mkdir(join(root, "app", "android", "app"), { recursive: true });
    await mkdir(join(root, "app", "node_modules", "dep"), { recursive: true });
    await mkdir(join(root, "rusty"), { recursive: true });
    await writeFile(join(root, "app", "package.json"), JSON.stringify({ volta: { node: "20.19.5" } }));
    await writeFile(join(root, "app", ".nvmrc"), "20.19.5\n");
    await writeFile(join(root, "app", "android", "app", "build.gradle"), `ndkVersion "27.0.12077973"`);
    await writeFile(join(root, "app", "node_modules", "dep", "package.json"), JSON.stringify({ volta: { node: "14.0.0" } }));
    await writeFile(join(root, "rusty", "rust-toolchain.toml"), `[toolchain]\nchannel = "1.75.0"\n`);

    const pins = await findPins([root]);

    expect([...pins.volta]).toEqual([["node@20.19.5", 1]]);
    expect([...pins.ndk]).toEqual([["27.0.12077973", 1]]);
    expect([...pins.rust]).toEqual([["1.75.0", 1]]);
  });
});

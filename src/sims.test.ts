import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSims, isSafe, parseDevices, parseIni, parseRuntimes, runtimeName, type Sim } from "./sims";

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  delete process.env.ANDROID_AVD_HOME;
  delete process.env.ANDROID_SDK_ROOT;
});

async function scratch(prefix: string) {
  const created = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirs.push(created);
  return realpath(created); // macOS hands out /var/…, which is a symlink
}

describe("parseDevices", () => {
  const json = {
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
        {
          udid: "A",
          name: "iPhone 17 Pro",
          dataPath: "/D/A/data",
          logPath: "/L/A",
          logPathSize: 1024,
          state: "Shutdown",
          isAvailable: true,
          lastBootedAt: "2026-06-19T15:42:55Z",
        },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-3": [
        { udid: "B", name: "iPhone 14", dataPath: "/D/B/data", state: "Booted", isAvailable: false },
      ],
    },
  };

  test("flattens the runtime-keyed map, keeping the runtime each device came from", () => {
    const devices = parseDevices(json);
    expect(devices.map((d) => [d.udid, d.runtimeId.endsWith("iOS-26-5")])).toEqual([
      ["A", true],
      ["B", false],
    ]);
  });

  test("fills in the fields simctl only reports sometimes", () => {
    const [a, b] = parseDevices(json);
    expect(a.lastBootedAt).toBe("2026-06-19T15:42:55Z");
    // A never-booted device omits lastBootedAt and logPathSize entirely.
    expect(b.lastBootedAt).toBeNull();
    expect(b.logPathSize).toBe(0);
    expect(b.isAvailable).toBe(false);
  });

  test("survives junk", () => {
    expect(parseDevices(null)).toEqual([]);
    expect(parseDevices({ devices: { x: [{ name: "no udid" }] } })).toEqual([]);
  });
});

describe("parseRuntimes", () => {
  test("keeps only what simctl says it owns, and reads deletable strictly", () => {
    const runtimes = parseRuntimes({
      a: { runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-3", sizeBytes: 10, deletable: true, version: "18.3.1" },
      b: { runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", sizeBytes: 20 },
      c: { notARuntime: true },
    });
    expect(runtimes.map((r) => [r.id, r.deletable])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(runtimes[0].version).toBe("18.3.1");
  });
});

describe("runtimeName", () => {
  test("reads the identifier back as a version", () => {
    expect(runtimeName("com.apple.CoreSimulator.SimRuntime.iOS-26-5")).toBe("iOS 26.5");
    expect(runtimeName("com.apple.CoreSimulator.SimRuntime.watchOS-11-2")).toBe("watchOS 11.2");
    expect(runtimeName("nonsense")).toBe("nonsense");
  });
});

describe("parseIni", () => {
  test("reads both spacings Android writes", () => {
    // The pointer file writes `key=value`; config.ini writes `key = value`.
    expect(parseIni("path=/a/b.avd\ntarget=android-35")).toEqual({ path: "/a/b.avd", target: "android-35" });
    expect(parseIni("AvdId = Medium_Phone\n# note\n\nPlayStore.enabled = true")).toEqual({
      AvdId: "Medium_Phone",
      "PlayStore.enabled": "true",
    });
  });
});

describe("findSims", () => {
  /** An AVD whose directory and pointer file are named differently, as they are. */
  async function makeAndroid(sysdir?: string) {
    const base = await scratch("purrge-sims-");
    const avdHome = join(base, "avd");
    const avd = join(avdHome, "Medium_Phone.avd");
    await mkdir(avd, { recursive: true });
    await writeFile(join(avdHome, "Medium_Phone_API_35.ini"), `avd.ini.encoding=UTF-8\npath=${avd}\n`);
    await writeFile(
      join(avd, "config.ini"),
      `avd.ini.displayname = Medium Phone API 35\n${sysdir ? `image.sysdir.1 = ${sysdir}\n` : ""}`,
    );
    await writeFile(join(avd, "userdata-qemu.img"), "x".repeat(40_000));

    const image = join(base, "sdk", "system-images", "android-35", "google_apis_playstore", "arm64-v8a");
    await mkdir(image, { recursive: true });
    await writeFile(join(image, "system.img"), "x".repeat(40_000));

    process.env.ANDROID_AVD_HOME = avdHome;
    process.env.ANDROID_SDK_ROOT = join(base, "sdk");
    return { avd, image };
  }

  const of = (sims: Sim[], kind: Sim["kind"]) => sims.filter((s) => s.kind === kind);

  test("finds an AVD through its pointer file, not by guessing the name", async () => {
    const { avd } = await makeAndroid();
    const [found] = of(await findSims(), "avd");
    expect(found.dir).toBe(avd);
    expect(found.label).toBe("Medium Phone API 35");
    expect(found.id).toBe("Medium_Phone_API_35");
    // Both halves go, or the next `avdmanager list` reports a broken AVD.
    expect(found.paths).toHaveLength(2);
    expect(found.bytes).toBeGreaterThan(0);
  });

  test("holds back a system image an AVD is still cut from", async () => {
    const { image } = await makeAndroid("system-images/android-35/google_apis_playstore/arm64-v8a/");
    const [found] = of(await findSims(), "sysimage");
    expect(found.dir).toBe(image);
    expect(found.risk).toBe("used by 1 avd");
    expect(isSafe(found)).toBe(false);
  });

  test("offers a system image no AVD references", async () => {
    await makeAndroid();
    const [found] = of(await findSims(), "sysimage");
    expect(found.risk).toBeNull();
    expect(isSafe(found)).toBe(true);
  });

  test("reports nothing rather than throwing when neither toolchain is present", async () => {
    const base = await scratch("purrge-sims-empty-");
    process.env.ANDROID_AVD_HOME = join(base, "nope");
    process.env.ANDROID_SDK_ROOT = join(base, "nope");
    const sims = await findSims();
    expect(of(sims, "avd")).toEqual([]);
    expect(of(sims, "sysimage")).toEqual([]);
  });
});

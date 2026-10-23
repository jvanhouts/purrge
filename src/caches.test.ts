import { describe, expect, test } from "bun:test";
import { holdBackReason, isYarnClassic, npxLabel, parseLocation } from "./caches";

describe("isYarnClassic", () => {
  test("1.x is Classic, anything newer is Berry", () => {
    expect(isYarnClassic("1.22.19\n")).toBe(true);
    expect(isYarnClassic("4.5.1")).toBe(false);
    expect(isYarnClassic("")).toBe(false);
  });
});

describe("parseLocation", () => {
  test("takes the printed path", () => {
    expect(parseLocation("/Users/me/.npm\n")).toBe("/Users/me/.npm");
  });

  test("npm's undefined and empty output mean no opinion", () => {
    expect(parseLocation("undefined\n")).toBeNull();
    expect(parseLocation("")).toBeNull();
  });

  test("a warning before the path is skipped", () => {
    expect(parseLocation("warning: something\n/Users/me/Library/Caches/Yarn/v6\n")).toBe("/Users/me/Library/Caches/Yarn/v6");
  });
});

describe("npxLabel", () => {
  test("names the packages the run installed", () => {
    expect(npxLabel(JSON.stringify({ dependencies: { "create-vite": "^5.0.0" } }), "abc123def456")).toBe("npx create-vite");
  });

  test("falls back to a short hash when package.json is missing or broken", () => {
    expect(npxLabel(null, "abc123def456")).toBe("npx abc123de");
    expect(npxLabel("{nope", "abc123def456")).toBe("npx abc123de");
  });
});

describe("holdBackReason", () => {
  test("an install in progress holds its own store back", () => {
    const commands = ["node /opt/homebrew/bin/npm install", "/usr/bin/zsh"];
    expect(holdBackReason("npm", ["/x/_cacache"], commands)).toBe("npm is running");
    expect(holdBackReason("bun", ["/x/cache"], commands)).toBeNull();
  });

  test("a Gradle daemon holds the Gradle caches", () => {
    const commands = ["/usr/bin/java -Xmx2g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.5"];
    expect(holdBackReason("gradle", [], commands)).toBe("Gradle is running");
  });

  test("npm run and a long-lived npm exec are not installs", () => {
    expect(holdBackReason("npm", [], ["node /opt/homebrew/bin/npm run dev"])).toBeNull();
    expect(holdBackReason("npm", [], ["npm exec mcp-remote https://example.com"])).toBeNull();
  });

  test("an npx entry is held back only while something runs from it", () => {
    const dir = "/Users/me/.npm/_npx/abc123";
    expect(holdBackReason("npx:abc123", [dir], [`node ${dir}/node_modules/.bin/vite`])).toBe("running right now");
    expect(holdBackReason("npx:abc123", [dir], ["node /Users/me/.npm/_npx/other/x"])).toBeNull();
  });

  test("brew cleanup and upgrade both touch the cache", () => {
    expect(holdBackReason("homebrew", [], ["/opt/homebrew/Library/Homebrew/brew.rb upgrade"])).toBe("Homebrew is running");
    expect(holdBackReason("homebrew", [], ["/opt/homebrew/bin/brew list"])).toBeNull();
  });
});

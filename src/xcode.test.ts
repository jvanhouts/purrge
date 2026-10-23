import { describe, expect, test } from "bun:test";
import { activeReason, derivedDataName, type DerivedDataEntry } from "./xcode";

describe("derivedDataName", () => {
  test("strips the workspace hash", () => {
    expect(derivedDataName("App-ausgzxvpmgynfvgldxgkfqsjfova")).toEqual({ name: "App", shared: false });
    expect(derivedDataName("my-app-ausgzxvpmgynfvgldxgkfqsjfova")).toEqual({ name: "my-app", shared: false });
  });

  test("caches without a hash are shared", () => {
    expect(derivedDataName("ModuleCache.noindex")).toEqual({ name: "ModuleCache", shared: true });
  });
});

describe("activeReason", () => {
  const now = 10_000_000;
  const entry = (ago: number): DerivedDataEntry => ({
    dir: "/dd/App-x", workspace: null, lastAccessedAt: null, lastActivityAt: now - ago,
  });

  test("recent activity with a build service running is active", () => {
    expect(activeReason(entry(60_000), ["/Applications/Xcode.app/.../XCBBuildService"], now)).toBe("active build");
  });

  test("recent activity alone is not", () => {
    expect(activeReason(entry(60_000), ["/usr/bin/vim"], now)).toBeNull();
  });

  test("old activity is not, even mid-build", () => {
    expect(activeReason(entry(3_600_000), ["xcodebuild -scheme App"], now)).toBeNull();
  });

  test("a command naming the directory always is", () => {
    expect(activeReason(entry(3_600_000), ["swift-frontend -o /dd/App-x/Build/foo.o"], now)).toBe("active build");
  });
});

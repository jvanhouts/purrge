import { describe, expect, test } from "bun:test";
import { buildDockerFindings, parseBuildCacheSummary, parseDockerDf, parseDockerSize } from "./docker";

const df = parseDockerDf(JSON.stringify({
  Images: [
    { Containers: "0", CreatedAt: "2026-10-22 00:27:26 +0200 CEST", ID: "sha256:76f0358884cb92d9", Repository: "mysql", Tag: "8", Size: "1.1GB", UniqueSize: "1.097GB", SharedSize: "0B" },
    { Containers: "2", CreatedAt: "2026-10-13 19:28:40 +0200 CEST", ID: "sha256:ed4604128082a95a", Repository: "solver", Tag: "local", Size: "184MB", UniqueSize: "184.4MB", SharedSize: "0B" },
    { Containers: "0", CreatedAt: "2026-10-01 10:00:00 +0200 CEST", ID: "sha256:aaaabbbbccccdddd", Repository: "<none>", Tag: "<none>", Size: "50MB", UniqueSize: "20MB", SharedSize: "30MB" },
  ],
  Containers: [
    { ID: "0cd4d24e5041", Names: "pg-worktree", Image: "postgres:18-alpine", State: "exited", Status: "Exited (0) 7 hours ago", Size: "16.4kB", LocalVolumes: "1" },
    { ID: "9f9f9f9f9f9f", Names: "web", Image: "solver:local", State: "running", Status: "Up 2 hours", Size: "1MB", LocalVolumes: "0" },
  ],
  Volumes: [
    { Name: "app-backend", Links: "0", Size: "555.4MB", Labels: "com.docker.compose.volume=postgres-data" },
    { Name: "scratch", Links: "0", Size: "1kB", Labels: "" },
    { Name: "live", Links: "1", Size: "2GB", Labels: "" },
  ],
  BuildCache: [
    { ID: "bp1", InUse: "false", Shared: "false", Size: "28.1MB", LastUsedAt: "2026-10-02 00:06:58.771731716 +0000 UTC", CacheType: "regular" },
    { ID: "bp2", InUse: "true", Shared: "false", Size: "10MB", LastUsedAt: "2026-10-03 00:00:00 +0000 UTC", CacheType: "regular" },
  ],
}))!;
const findings = buildDockerFindings(df);
const byId = (id: string) => findings.find((f) => f.id === id)!;

describe("parseDockerSize", () => {
  test("decimal units", () => {
    expect(parseDockerSize("1.097GB")).toBe(1_097_000_000);
    expect(parseDockerSize("368.6kB")).toBe(368_600);
    expect(parseDockerSize("0B")).toBe(0);
    expect(parseDockerSize("12B")).toBe(12);
  });

  test("garbage is zero", () => {
    expect(parseDockerSize("N/A")).toBe(0);
    expect(parseDockerSize(undefined)).toBe(0);
  });
});

describe("parseDockerDf", () => {
  test("not JSON is null", () => {
    expect(parseDockerDf("Cannot connect to the Docker daemon")).toBeNull();
  });
});

describe("buildDockerFindings", () => {
  test("build cache is one finding of the unused entries", () => {
    const f = byId("docker:build-cache");
    expect(f.disposition).toBe("eligible");
    expect(f.reclaimableEstimateBytes).toBe(28_100_000);
    expect(f.cleanupActionId).toBe("docker-builder-prune");
    expect(f.lastActivityAt).toBe(Date.parse("2026-10-03T00:00:00Z"));
  });

  test("unused images are eligible at their unique size; used ones held back", () => {
    const mysql = byId("docker:image:sha256:76f0358884cb92d9");
    expect(mysql).toMatchObject({ label: "mysql:8", disposition: "eligible", reclaimableEstimateBytes: 1_097_000_000 });
    expect(mysql.lastActivityAt).toBe(Date.parse("2026-10-21T22:27:26Z"));
    expect(byId("docker:image:sha256:ed4604128082a95a")).toMatchObject({ disposition: "held-back", reason: "used by 2 containers" });
    expect(byId("docker:image:sha256:aaaabbbbccccdddd")).toMatchObject({ detail: "dangling image", reclaimableEstimateBytes: 20_000_000 });
  });

  test("stopped containers are review-only, running ones held back", () => {
    expect(byId("docker:container:0cd4d24e5041").disposition).toBe("review-only");
    expect(byId("docker:container:9f9f9f9f9f9f")).toMatchObject({ disposition: "held-back", cleanupActionId: undefined });
  });

  test("volumes are never eligible, and database ones say so", () => {
    const vols = findings.filter((f) => f.id.startsWith("docker:volume:"));
    expect(vols.every((v) => v.disposition !== "eligible")).toBe(true);
    expect(byId("docker:volume:app-backend").reason).toContain("database");
    expect(byId("docker:volume:scratch").reason).not.toContain("database");
    expect(byId("docker:volume:live").disposition).toBe("held-back");
  });
});

describe("parseBuildCacheSummary", () => {
  test("takes Docker's own totals over summed entries, which share parents", () => {
    const text = [
      `{"Active":"10","Reclaimable":"8.379GB (64%)","Size":"12.94GB","TotalCount":"23","Type":"Images"}`,
      `{"Active":"0","Reclaimable":"4.021GB","Size":"4.021GB","TotalCount":"133","Type":"Build Cache"}`,
    ].join("\n");
    const summary = parseBuildCacheSummary(text);
    expect(summary).toEqual({ bytes: 4_021_000_000, reclaimable: 4_021_000_000 });
    expect(buildDockerFindings(df, summary)[0].reclaimableEstimateBytes).toBe(4_021_000_000);
  });
});

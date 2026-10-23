import Foundation

/// Mirrors `Stats` in src/stats.ts — the sections of `purrge stats`.
enum Stats {
    /// One line of `purrge stats --stream`: whichever section just finished.
    struct Update: Decodable, Sendable {
        let disk: Disk?
        let projects: Projects?
        let worktrees: Worktrees?
        let devices: Devices?
        let images: Images?
        let provider: Provider?
    }

    /// Whether a section saw everything. Optional so an older purrge still decodes.
    struct Issue: Decodable, Sendable {
        let code: String
        let message: String
        let path: String?
    }

    struct Disk: Decodable, Sendable {
        let totalBytes: Int64
        let freeBytes: Int64
        let usedBytes: Int64
        /// Below 10% or 20 GiB free, as purrge judges it.
        let low: Bool
    }

    struct Projects: Decodable, Sendable {
        let roots: [String]
        let staleWeeks: Double
        let count: Int
        let staleCount: Int
        let bytes: Int64
        let staleBytes: Int64
        let status: String?
        let issues: [Issue]?
    }

    struct Worktrees: Decodable, Sendable {
        let roots: [String]
        let staleDays: Double
        let count: Int
        let staleCount: Int
        let bytes: Int64
        let staleBytes: Int64
        /// Stale, but unmerged — purrge keeps these without --force.
        let heldBackCount: Int
        let heldBackBytes: Int64
    }

    struct Devices: Decodable, Sendable {
        let staleDays: Double
        let count: Int
        let staleCount: Int
        let bytes: Int64
        let staleBytes: Int64
        /// Stale but booted — purrge keeps these without --force.
        let heldBackCount: Int?
        let heldBackBytes: Int64?
        let status: String?
        let issues: [Issue]?
    }

    /// Runtimes, device support and system images.
    struct Images: Decodable, Sendable {
        let count: Int
        let staleCount: Int
        let bytes: Int64
        let staleBytes: Int64
        /// Stale, but simulators or AVDs are still cut from them.
        let heldBackCount: Int?
        let heldBackBytes: Int64?
    }

    /// Caches, Xcode build output, Docker, tool versions — one each.
    struct Provider: Decodable, Sendable, Identifiable {
        let name: String
        let title: String
        let status: String
        let count: Int
        let bytes: Int64
        let eligibleCount: Int
        let eligibleBytes: Int64
        let heldBackBytes: Int64
        let reviewBytes: Int64
        let issues: [Issue]

        var id: String { name }
    }
}

extension Stats.Images {
    /// What purrge would actually remove: stale, minus what it holds back.
    var reclaimableBytes: Int64 { max(staleBytes - (heldBackBytes ?? 0), 0) }
}

extension Stats.Devices {
    var reclaimableBytes: Int64 { max(staleBytes - (heldBackBytes ?? 0), 0) }
}

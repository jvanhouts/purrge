import Foundation

/// Mirrors `Stats` in src/stats.ts — the sections of `purrge stats`.
enum Stats {
    /// One line of `purrge stats --stream`: whichever section just finished.
    struct Update: Decodable, Sendable {
        let projects: Projects?
        let worktrees: Worktrees?
        let devices: Devices?
        let images: Summary?
    }

    struct Summary: Decodable, Sendable {
        let count: Int
        let staleCount: Int
        let bytes: Int64
        let staleBytes: Int64
    }

    struct Projects: Decodable, Sendable {
        let roots: [String]
        let staleWeeks: Double
        let count: Int
        let staleCount: Int
        let bytes: Int64
        let staleBytes: Int64
    }

    struct Worktrees: Decodable, Sendable {
        let roots: [String]
        let staleDays: Double
        let count: Int
        let staleCount: Int
        let bytes: Int64
        let staleBytes: Int64
        /// Stale, but dirty or unmerged — purrge keeps these without --force.
        let heldBackCount: Int
        let heldBackBytes: Int64
    }

    struct Devices: Decodable, Sendable {
        let staleDays: Double
        let count: Int
        let staleCount: Int
        let bytes: Int64
        let staleBytes: Int64
    }
}

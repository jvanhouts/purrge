import AppKit
import Observation

@MainActor
@Observable
final class StatsModel {
    enum Section: CaseIterable {
        case projects, worktrees, sims
    }

    // Each section keeps its last numbers until a scan replaces them, so a
    // rescan never blanks out a bar that was already drawn.
    private(set) var projects: Stats.Projects?
    private(set) var worktrees: Stats.Worktrees?
    private(set) var devices: Stats.Devices?
    private(set) var images: Stats.Summary?

    /// Sections the running scan has not delivered yet.
    private(set) var pending: Set<Section> = []
    private(set) var error: String?
    private(set) var updatedAt: Date?

    var isLoading: Bool { scan != nil }

    private var scan: Task<Void, Never>?
    private var watcher: ConfigWatcher?
    private var debounce: Task<Void, Never>?

    /// A scan walks every project root and sizes every simulator, so it is kept
    /// well away from anything resembling polling.
    private static let refreshInterval: Duration = .seconds(30 * 60)

    init() {
        watcher = ConfigWatcher(url: PurrgeCLI.configURL) { [weak self] in
            self?.configChanged()
        }
        Task { await self.loop() }
    }

    func isPending(_ section: Section) -> Bool {
        pending.contains(section)
    }

    /// Starts a scan, abandoning one already running: its results would
    /// describe settings that may have just changed.
    func refresh() {
        scan?.cancel()
        scan = Task { await run() }
    }

    private func run() async {
        pending = Set(Section.allCases)
        do {
            for try await update in PurrgeCLI.stats() {
                try Task.checkCancellation()
                apply(update)
            }
            try Task.checkCancellation()
            error = nil
            updatedAt = Date()
        } catch is CancellationError {
            return // superseded — the new scan owns the state now
        } catch {
            if Task.isCancelled { return }
            self.error = error.localizedDescription
        }
        pending = []
        scan = nil
    }

    private func apply(_ update: Stats.Update) {
        if let p = update.projects {
            projects = p
            pending.remove(.projects)
        }
        if let w = update.worktrees {
            worktrees = w
            pending.remove(.worktrees)
        }
        if let d = update.devices {
            devices = d
            images = update.images
            pending.remove(.sims)
        }
    }

    /// One save can fire several events (write, rename, directory change);
    /// wait for them to settle and rescan once.
    private func configChanged() {
        debounce?.cancel()
        debounce = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            refresh()
        }
    }

    /// Opens ~/.purrge/config.yml, seeding it first so there is something to edit.
    func openConfig() {
        let url = PurrgeCLI.configURL
        if !FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? Self.configTemplate.write(to: url, atomically: true, encoding: .utf8)
        }
        NSWorkspace.shared.open(url)
    }

    private func loop() async {
        while !Task.isCancelled {
            refresh()
            try? await Task.sleep(for: Self.refreshInterval)
        }
    }

    private static let configTemplate = """
    # purrge — see https://github.com/jvanhouts/purrge#configuration

    # Directories the menu bar app and `purrge stats` sum projects under.
    PROJECT_ROOTS:
      - ~/Documents/projects

    # Projects untouched for this many weeks count as stale.
    PURGE_STALE_WEEKS_AMOUNT: 8

    # Simulators and emulators idle for this many days count as stale.
    SIM_STALE_DAYS_AMOUNT: 30

    """
}

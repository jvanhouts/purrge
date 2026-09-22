import SwiftUI

@main
struct PurrgeBarApp: App {
    @State private var model = StatsModel()

    init() {
        // The bundled app sets LSUIElement; `swift run` has no Info.plist, so
        // keep it out of the Dock the same way.
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    var body: some Scene {
        MenuBarExtra {
            StatsView(model: model)
        } label: {
            Image(systemName: model.hasStale ? "cat.fill" : "cat")
        }
        .menuBarExtraStyle(.window)
    }
}

extension StatsModel {
    /// The icon fills in once anything has gone stale — a nudge, not an alarm.
    var hasStale: Bool {
        (projects?.staleBytes ?? 0) > 0 || (worktrees?.staleBytes ?? 0) > 0 || (devices?.staleCount ?? 0) > 0
    }
}

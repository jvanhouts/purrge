import SwiftUI

extension Color {
    /// The same pair the CLI prints `purrge stats` in.
    static let inUse = Color(red: 0.0, green: 0.84, blue: 0.53)
    static let stale = Color(red: 1.0, green: 0.53, blue: 0.84)
    /// Stale but not purgeable: the same pink, knocked back.
    static let heldBack = Color.stale.opacity(0.4)
}

struct StatsView: View {
    let model: StatsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("purrge").font(.headline)

            disk
            projects
            worktrees
            devices
            providers
            legend

            if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .wraps()
            }

            Divider()
            footer
        }
        .padding(14)
        .frame(width: 320)
    }

    /// The number that actually ran out. Stale totals of a few megabytes say
    /// nothing about a disk that is 98% full, so free space comes first.
    @ViewBuilder
    private var disk: some View {
        if let d = model.disk {
            StatSection(title: "Disk", trailing: "\(bytes(d.freeBytes)) free", isLoading: model.isPending(.disk)) {
                DiskBar(total: Double(d.totalBytes), used: Double(d.usedBytes), low: d.low)
                if d.low {
                    Label("Low on space. Run `purrge doctor` to see where it went.", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .wraps()
                } else {
                    Text("\(bytes(d.usedBytes)) of \(bytes(d.totalBytes)) used").caption()
                }
            }
        }
    }

    @ViewBuilder
    private var projects: some View {
        let loading = model.isPending(.projects)
        if let p = model.projects {
            if p.roots.isEmpty {
                StatSection(title: "Projects", isLoading: loading) {
                    Text("No project roots yet. Add PROJECT_ROOTS to your config.")
                        .caption()
                        .wraps()
                }
            } else {
                StatSection(title: "Projects", trailing: bytes(p.bytes), isLoading: loading) {
                    UsageBar(total: Double(p.bytes), stale: Double(p.staleBytes))
                    Text("\(bytes(p.staleBytes)) stale · \(p.staleCount) of \(p.count) idle \(Int(p.staleWeeks))+ weeks")
                        .caption()
                    Text(p.roots.map(abbreviate).joined(separator: ", "))
                        .caption()
                        .lineLimit(1)
                        .truncationMode(.middle)
                    HealthNote(status: p.status, issues: p.issues ?? [])
                }
            }
        } else {
            PlaceholderSection(title: "Projects")
        }
    }

    /// Hidden once a scan says there are none — most machines have no worktree
    /// root at all — but held open while the first scan might still find some.
    @ViewBuilder
    private var worktrees: some View {
        let loading = model.isPending(.worktrees)
        if let w = model.worktrees {
            if w.count > 0 {
                StatSection(title: "Worktrees", trailing: bytes(w.bytes), isLoading: loading) {
                    UsageBar(total: Double(w.bytes), stale: Double(w.staleBytes), heldBack: Double(w.heldBackBytes))
                    Text("\(bytes(w.staleBytes)) stale · \(w.staleCount) of \(w.count) idle \(Int(w.staleDays))+ days")
                        .caption()
                    if w.heldBackCount > 0 {
                        Text("\(w.heldBackCount) held back (\(bytes(w.heldBackBytes))): dirty or unmerged")
                            .caption()
                    }
                }
            }
        } else if loading {
            PlaceholderSection(title: "Worktrees")
        }
    }

    /// Bytes, not counts: one unused runtime outweighs twenty idle devices, and
    /// the bar should say so.
    @ViewBuilder
    private var devices: some View {
        if let d = model.devices {
            let images = model.images
            let total = d.bytes + (images?.bytes ?? 0)
            let stale = d.staleBytes + (images?.staleBytes ?? 0)
            let held = (d.heldBackBytes ?? 0) + (images?.heldBackBytes ?? 0)
            StatSection(title: "Simulators", trailing: bytes(total), isLoading: model.isPending(.sims)) {
                UsageBar(total: Double(total), stale: Double(stale), heldBack: Double(held))
                Text("\(bytes(d.reclaimableBytes + (images?.reclaimableBytes ?? 0))) reclaimable · \(d.staleCount) of \(d.count) devices idle \(Int(d.staleDays))+ days")
                    .caption()
                if let images {
                    Text("\(bytes(images.bytes)) in runtimes & images, \(bytes(images.reclaimableBytes)) unused")
                        .caption()
                }
                if held > 0 {
                    Text("\(bytes(held)) held back: still in use by a simulator or booted").caption()
                }
                HealthNote(status: d.status, issues: d.issues ?? [])
            }
        } else {
            PlaceholderSection(title: "Simulators")
        }
    }

    /// Everything outside the project roots: package caches, DerivedData,
    /// Docker, tool versions. One line each — `purrge <name>` has the detail.
    @ViewBuilder
    private var providers: some View {
        if !model.providers.isEmpty {
            StatSection(title: "Caches & build output", isLoading: model.isPending(.providers)) {
                ForEach(model.providers) { p in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(p.title).font(.caption)
                            Spacer()
                            Text(bytes(p.bytes)).font(.caption.monospacedDigit())
                        }
                        UsageBar(total: Double(p.bytes), stale: Double(p.eligibleBytes))
                            .frame(height: 6)
                        if p.status == "complete" {
                            Text("\(bytes(p.eligibleBytes)) eligible · purrge \(p.name)").caption()
                        } else {
                            HealthNote(status: p.status, issues: p.issues)
                        }
                    }
                }
            }
        } else if model.isPending(.providers) {
            PlaceholderSection(title: "Caches & build output")
        }
    }

    private var legend: some View {
        HStack(spacing: 12) {
            LegendDot(color: .inUse, label: "in use")
            LegendDot(color: .stale, label: "stale")
            if (model.worktrees?.heldBackCount ?? 0) > 0
                || (model.devices?.heldBackBytes ?? 0) > 0
                || (model.images?.heldBackBytes ?? 0) > 0 {
                LegendDot(color: .heldBack, label: "held back")
            }
        }
    }

    private var footer: some View {
        HStack {
            if model.isLoading {
                Text("Scanning…").caption()
            } else if let updatedAt = model.updatedAt {
                Text("Updated \(updatedAt, style: .relative) ago")
                    .caption()
            }
            Spacer()
            Button {
                model.refresh()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .disabled(model.isLoading)
            .help("Rescan")

            Menu {
                Button("Edit config…") { model.openConfig() }
                Divider()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuIndicator(.hidden)
            .fixedSize()
        }
        .buttonStyle(.borderless)
    }

    private func bytes(_ n: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: n, countStyle: .file)
    }

    private func abbreviate(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }
}

private struct StatSection<Content: View>: View {
    let title: String
    var trailing: String? = nil
    var isLoading = false
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text(title).font(.subheadline.weight(.semibold))
                if isLoading {
                    ProgressView().controlSize(.mini)
                }
                Spacer()
                if let trailing {
                    Text(trailing).font(.subheadline.monospacedDigit())
                }
            }
            content
                .opacity(isLoading ? 0.6 : 1)
                .animation(.easeOut, value: isLoading)
        }
    }
}

/// A section with nothing to show yet: an empty bar where the real one will go,
/// so the popover does not jump when it arrives.
private struct PlaceholderSection: View {
    let title: String

    var body: some View {
        StatSection(title: title, isLoading: true) {
            UsageBar(total: 0, stale: 0)
            Text("Scanning…").caption()
        }
    }
}

/// In use from the left, stale filling in from the right. Held back is the part
/// of stale that stays put, drawn where the two meet.
struct UsageBar: View {
    let total: Double
    let stale: Double
    var heldBack: Double = 0

    var body: some View {
        GeometryReader { geo in
            let share = { (part: Double) in total > 0 ? min(max(part / total, 0), 1) : 0 }
            let staleShare = share(stale)
            let heldBackShare = min(share(heldBack), staleShare)
            HStack(spacing: 0) {
                if total > 0 {
                    Rectangle().fill(Color.inUse)
                        .frame(width: geo.size.width * (1 - staleShare))
                    Rectangle().fill(Color.heldBack)
                        .frame(width: geo.size.width * heldBackShare)
                    Rectangle().fill(Color.stale)
                } else {
                    Rectangle().fill(.quaternary)
                }
            }
        }
        .frame(height: 10)
        .clipShape(Capsule())
        .animation(.easeOut, value: stale / max(total, 1))
    }
}

/// What a section could not see. Zero simulators because simctl failed is not
/// zero simulators, and should never read like it.
private struct HealthNote: View {
    let status: String?
    let issues: [Stats.Issue]

    var body: some View {
        if let status, status != "complete" {
            let first = issues.first(where: { $0.code != "missing-tool" })?.message
            Label(
                "\(Self.describe(status))\(first.map { ": \($0)" } ?? "")",
                systemImage: "exclamationmark.triangle"
            )
            .font(.caption)
            .foregroundStyle(.orange)
            .lineLimit(2)
            .wraps()
        }
    }

    static func describe(_ status: String) -> String {
        switch status {
        case "partial": "Partial — some places could not be read"
        case "unavailable": "Unavailable — unknown, not empty"
        default: "Scan failed — unknown, not empty"
        }
    }
}

/// Used from the left; turns red once purrge calls the disk low.
private struct DiskBar: View {
    let total: Double
    let used: Double
    let low: Bool

    var body: some View {
        GeometryReader { geo in
            HStack(spacing: 0) {
                Rectangle().fill(low ? Color.red : Color.secondary.opacity(0.6))
                    .frame(width: geo.size.width * (total > 0 ? min(used / total, 1) : 0))
                Rectangle().fill(.quaternary)
            }
        }
        .frame(height: 10)
        .clipShape(Capsule())
    }
}

private struct LegendDot: View {
    let color: Color
    let label: String

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).caption()
        }
    }
}

private extension View {
    func caption() -> some View {
        font(.caption).foregroundStyle(.secondary)
    }

    /// Let long text grow the popover downward instead of being clipped.
    func wraps() -> some View {
        fixedSize(horizontal: false, vertical: true)
    }
}

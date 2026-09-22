import Foundation

/// Calls back whenever ~/.purrge/config.yml is created, edited or replaced.
///
/// Watching the file alone is not enough: most editors save by writing a temp
/// file and renaming it over the original, which leaves a watch on the old
/// file descriptor staring at a file nobody will touch again. The directory is
/// watched too, and the file watch is re-armed whenever the entry changes.
@MainActor
final class ConfigWatcher {
    private let url: URL
    private let onChange: @MainActor () -> Void
    private var directorySource: DispatchSourceFileSystemObject?
    private var fileSource: DispatchSourceFileSystemObject?

    init(url: URL, onChange: @escaping @MainActor () -> Void) {
        self.url = url
        self.onChange = onChange

        let directory = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        directorySource = source(for: directory, events: .write) { [weak self] _ in
            self?.watchFile()
            self?.onChange()
        }
        watchFile()
    }

    private func watchFile() {
        fileSource?.cancel()
        fileSource = source(for: url, events: [.write, .extend, .delete, .rename]) { [weak self] event in
            if !event.isDisjoint(with: [.delete, .rename]) { self?.watchFile() }
            self?.onChange()
        }
    }

    private func source(
        for url: URL,
        events: DispatchSource.FileSystemEvent,
        handler: @escaping @MainActor (DispatchSource.FileSystemEvent) -> Void
    ) -> DispatchSourceFileSystemObject? {
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return nil } // not there yet — the directory watch will catch it arriving
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: events, queue: .main)
        source.setEventHandler { [source] in
            MainActor.assumeIsolated { handler(source.data) }
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        return source
    }
}

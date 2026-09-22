import Foundation

/// The app draws; the CLI decides. Every number comes from `purrge stats`,
/// so "stale" means exactly what it means in the terminal.
enum PurrgeCLI {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static let configURL = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: ".purrge/config.yml")

    /// Where to find purrge, first hit wins:
    /// `PURRGE_BIN`, the copy compiled into the app bundle, then the usual installs.
    static func locate() -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var candidates: [String] = []
        if let bin = ProcessInfo.processInfo.environment["PURRGE_BIN"] { candidates.append(bin) }
        if let bundled = Bundle.main.url(forResource: "purrge", withExtension: nil) { candidates.append(bundled.path) }
        candidates += [
            "\(home)/.bun/bin/purrge",
            "/opt/homebrew/bin/purrge",
            "/usr/local/bin/purrge",
        ]
        return candidates.lazy
            .filter { FileManager.default.isExecutableFile(atPath: $0) }
            .map { URL(filePath: $0) }
            .first
    }

    /// Each section of the stats as soon as purrge has it, via `stats --stream`.
    /// Cancelling the consuming task terminates the scan.
    static func stats() -> AsyncThrowingStream<Stats.Update, Error> {
        AsyncThrowingStream { continuation in
            guard let binary = locate() else {
                continuation.finish(throwing: Failure(message: "purrge not found — build the app with `bun run app`, or set PURRGE_BIN"))
                return
            }

            let process = Process()
            process.executableURL = binary
            process.arguments = ["stats", "--stream"]
            process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

            // Apps launched from Finder get a bare PATH; purrge shells out to
            // `du`, `git` and `xcrun`, and a non-compiled purrge needs `bun`.
            var env = ProcessInfo.processInfo.environment
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            env["PATH"] = ["\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"]
                .joined(separator: ":")
            process.environment = env

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            continuation.onTermination = { _ in
                if process.isRunning { process.terminate() }
            }

            do {
                try process.run()
            } catch {
                continuation.finish(throwing: error)
                return
            }

            DispatchQueue.global().async {
                // Drain stderr alongside stdout: a full pipe would block purrge forever.
                let group = DispatchGroup()
                nonisolated(unsafe) var errData = Data()
                DispatchQueue.global().async(group: group) {
                    errData = stderr.fileHandleForReading.readDataToEndOfFile()
                }

                let decoder = JSONDecoder()
                let handle = stdout.fileHandleForReading
                var buffer = Data()
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    buffer.append(chunk)
                    while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                        let line = buffer[buffer.startIndex..<newline]
                        buffer.removeSubrange(buffer.startIndex...newline)
                        if let update = try? decoder.decode(Stats.Update.self, from: line) {
                            continuation.yield(update)
                        }
                    }
                }

                group.wait()
                process.waitUntilExit()
                if process.terminationStatus == 0 || process.terminationReason == .uncaughtSignal {
                    continuation.finish()
                } else {
                    let message = String(decoding: errData, as: UTF8.self)
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    continuation.finish(throwing: Failure(message: message.isEmpty ? "purrge exited with \(process.terminationStatus)" : message))
                }
            }
        }
    }
}

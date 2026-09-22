// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PurrgeBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "PurrgeBar", path: "Sources/PurrgeBar"),
    ]
)

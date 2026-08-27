// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "WakeWireCodexDesktopBridge",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "CodexDesktopBridgeCore", targets: ["CodexDesktopBridgeCore"]),
    .executable(
      name: "wakewire-codex-desktop-helper",
      targets: ["WakeWireCodexDesktopHelper"]
    ),
    .executable(
      name: "wakewire-codex-desktop-helper-tests",
      targets: ["CodexDesktopBridgeCoreTests"]
    ),
  ],
  targets: [
    .target(
      name: "CodexDesktopBridgeCore",
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("ApplicationServices"),
        .linkedLibrary("sqlite3"),
      ]
    ),
    .executableTarget(
      name: "WakeWireCodexDesktopHelper",
      dependencies: ["CodexDesktopBridgeCore"]
    ),
    // The standalone Command Line Tools on this Mac omit XCTest from
    // SwiftPM's module path. Keep a dependency-free executable test harness
    // so the package remains testable without installing full Xcode.
    .executableTarget(
      name: "CodexDesktopBridgeCoreTests",
      dependencies: ["CodexDesktopBridgeCore"],
      path: "Tests/CodexDesktopBridgeCoreTests",
      linkerSettings: [.linkedLibrary("sqlite3")]
    ),
    .testTarget(
      name: "CodexDesktopBridgeSwiftPMTests",
      dependencies: ["CodexDesktopBridgeCore"],
      path: "Tests/SwiftPMTests"
    ),
  ]
)

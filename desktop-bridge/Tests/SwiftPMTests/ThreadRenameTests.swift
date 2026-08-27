@testable import CodexDesktopBridgeCore

// The standalone Command Line Tools on this Mac ship neither XCTest nor the
// Swift Testing module. This target keeps `swift test` as a compile-time check;
// the dependency-free executable test harness performs the 28 runtime tests.
public func threadRenameSwiftPMCompileCanary() -> DesktopRenameRequest {
  DesktopRenameRequest(
    threadId: "019fa994-d602-76a3-911c-a349c4caceba",
    title: "Slack — ping",
    uiTimeoutMilliseconds: 2_000
  )
}

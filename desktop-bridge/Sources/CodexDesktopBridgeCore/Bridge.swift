import Foundation

public let wakeWireMarkerPrefix = "wakewire:event:v1:"

public struct DesktopCreateRequest: Equatable {
  public let url: URL
  public let marker: String
  public let cwd: String
  public let notBeforeMilliseconds: Int64
  public let uiTimeoutMilliseconds: Int
  public let discoveryTimeoutMilliseconds: Int

  public init(
    url: URL,
    marker: String,
    cwd: String,
    notBeforeMilliseconds: Int64,
    uiTimeoutMilliseconds: Int,
    discoveryTimeoutMilliseconds: Int
  ) {
    self.url = url
    self.marker = marker
    self.cwd = cwd
    self.notBeforeMilliseconds = notBeforeMilliseconds
    self.uiTimeoutMilliseconds = uiTimeoutMilliseconds
    self.discoveryTimeoutMilliseconds = discoveryTimeoutMilliseconds
  }

  public func validate() throws {
    guard isValidWakeWireMarker(marker) else {
      throw DesktopBridgeError.invalidRequest("invalid WakeWire correlation marker")
    }
    guard cwd.hasPrefix("/") else {
      throw DesktopBridgeError.invalidRequest("cwd must be an absolute path")
    }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDirectory),
      isDirectory.boolValue
    else {
      throw DesktopBridgeError.invalidRequest("cwd does not exist or is not a directory")
    }
    guard uiTimeoutMilliseconds > 0, uiTimeoutMilliseconds <= 120_000 else {
      throw DesktopBridgeError.invalidRequest("UI timeout must be between 1 and 120000ms")
    }
    guard discoveryTimeoutMilliseconds > 0, discoveryTimeoutMilliseconds <= 120_000 else {
      throw DesktopBridgeError.invalidRequest(
        "discovery timeout must be between 1 and 120000ms"
      )
    }
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.scheme == "codex",
      components.host == "threads",
      components.path == "/new"
    else {
      throw DesktopBridgeError.invalidRequest("URL must be codex://threads/new")
    }
    guard url.absoluteString.utf8.count <= 128 * 1_024 else {
      throw DesktopBridgeError.invalidRequest("deep link exceeds 131072 bytes")
    }
    var query: [String: String] = [:]
    for item in components.queryItems ?? [] {
      guard let value = item.value, query[item.name] == nil else {
        throw DesktopBridgeError.invalidRequest("deep link has duplicate or empty query values")
      }
      query[item.name] = value
    }
    guard query["path"] == cwd else {
      throw DesktopBridgeError.invalidRequest("deep-link path does not match cwd")
    }
    guard query["prompt"]?.contains(marker) == true else {
      throw DesktopBridgeError.invalidRequest("deep-link prompt does not contain marker")
    }
  }
}

public struct DesktopCreateResult: Codable, Equatable {
  public let threadId: String
  public let marker: String
  public let cwd: String

  public init(threadId: String, marker: String, cwd: String) {
    self.threadId = threadId
    self.marker = marker
    self.cwd = cwd
  }
}

public enum DesktopBridgeError: Error, Equatable, LocalizedError {
  case invalidRequest(String)
  case accessibilityUnavailable(String)
  case screenLocked
  case modalPresent
  case composerNotFound
  case composerAmbiguous
  case sendButtonNotFound
  case sendButtonAmbiguous
  case sendButtonDisabled
  case sendButtonDidNotSubmit
  case markerChanged
  case launchFailed(String)
  case taskDiscoveryFailed(String)
  case stateDatabase(String)
  case applicationUnavailable(String)
  case threadActivationFailed(String)
  case renameDialogNotFound
  case renameDialogAmbiguous
  case renameDialogUnexpected
  case renameTitleFieldUnavailable
  case renameTitleDidNotUpdate(observedCodePoints: Int, expectedCodePoints: Int, focused: Bool?)
  case renameSaveButtonUnavailable
  case renameCancelButtonUnavailable
  case renameDialogDismissFailed
  case renameDidNotComplete
  case renamedTitleNotVisible

  public var errorDescription: String? {
    switch self {
    case .invalidRequest(let message),
      .accessibilityUnavailable(let message),
      .launchFailed(let message),
      .taskDiscoveryFailed(let message),
      .stateDatabase(let message),
      .applicationUnavailable(let message),
      .threadActivationFailed(let message):
      return message
    case .screenLocked:
      return "macOS screen is locked or not on the console"
    case .modalPresent:
      return "Codex Desktop has a modal dialog; refusing to press any control"
    case .composerNotFound:
      return "Codex Desktop composer containing the exact marker was not found in time"
    case .composerAmbiguous:
      return "multiple editable Codex Desktop elements contain the marker"
    case .sendButtonNotFound:
      return "Codex Desktop Send button was not found"
    case .sendButtonAmbiguous:
      return "multiple Codex Desktop Send buttons are visible"
    case .sendButtonDisabled:
      return "Codex Desktop Send button is disabled"
    case .sendButtonDidNotSubmit:
      return "Codex Desktop Send control was activated but the marked composer did not submit"
    case .markerChanged:
      return "Codex Desktop composer marker changed before submission"
    case .renameDialogNotFound:
      return "Codex Desktop Rename chat dialog was not found in time"
    case .renameDialogAmbiguous:
      return "multiple Codex Desktop Rename chat dialogs are visible"
    case .renameDialogUnexpected:
      return "Codex Desktop showed an unexpected dialog while renaming the task"
    case .renameTitleFieldUnavailable:
      return "Codex Desktop Rename chat title field is unavailable or ambiguous"
    case .renameTitleDidNotUpdate(
      let observedCodePoints,
      let expectedCodePoints,
      let focused
    ):
      return "Codex Desktop Rename chat title field did not accept keyboard input "
        + "(observedCodePoints=\(observedCodePoints), "
        + "expectedCodePoints=\(expectedCodePoints), focused=\(String(describing: focused)))"
    case .renameSaveButtonUnavailable:
      return "Codex Desktop Rename chat Save button is unavailable or ambiguous"
    case .renameCancelButtonUnavailable:
      return "Codex Desktop Rename chat Cancel button is unavailable or ambiguous"
    case .renameDialogDismissFailed:
      return "Codex Desktop exact Rename chat dialog did not close after Escape"
    case .renameDidNotComplete:
      return "Codex Desktop Rename chat dialog did not close after Save"
    case .renamedTitleNotVisible:
      return "Codex Desktop did not display the exact renamed task title"
    }
  }
}

public protocol DesktopURLLaunching {
  func open(_ url: URL) throws
}

public protocol DesktopAccessibilitySubmitting {
  /// Must not show a TCC prompt. This check happens before changing UI.
  func preflight() throws
  /// Finds the exact marked editable composer and activates its verified Send control.
  /// `beforeSendActivation` must complete immediately before mouseDown.
  /// If it throws, the implementation must not activate the Send control.
  func submit(
    marker: String,
    timeoutMilliseconds: Int,
    beforeSendActivation: () throws -> Void
  ) throws
}

public protocol FrontmostApplicationManaging {
  func captureFrontmostProcessIdentifier() -> pid_t?
  func activateCodexDesktop(timeoutMilliseconds: Int) throws
  func restoreFrontmostApplication(processIdentifier: pid_t)
}

public protocol DesktopTaskFinding {
  func findTaskId(marker: String, cwd: String, notBeforeMilliseconds: Int64) throws -> String?
}

public enum DesktopSubmissionIntentClaim: Equatable {
  /// No durable Send-attempt barrier exists, so this process may prepare the UI.
  case retryable(marker: String, cwd: String)
  /// Send may already have been activated. Recovery must remain read-only.
  case possibleSend(marker: String, cwd: String)
}

public enum DesktopSubmissionIntentArm: Equatable {
  /// This process exclusively and durably created the Send-attempt barrier.
  case armed
  /// Another process already created the barrier. This process must not Send.
  case existing(marker: String, cwd: String)
}

/// Durable exactly-once guard for the non-idempotent Desktop new-task UI.
public protocol DesktopSubmissionIntentClaiming {
  func claim(marker: String, cwd: String) throws -> DesktopSubmissionIntentClaim
  func arm(marker: String, cwd: String) throws -> DesktopSubmissionIntentArm
}

private struct DesktopSendBarrierAlreadyArmed: Error {}

public protocol DesktopBridgeClock {
  func nowMilliseconds() -> Int64
  func sleep(milliseconds: Int)
}

public struct SystemDesktopBridgeClock: DesktopBridgeClock {
  public init() {}

  public func nowMilliseconds() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1_000)
  }

  public func sleep(milliseconds: Int) {
    Thread.sleep(forTimeInterval: Double(milliseconds) / 1_000)
  }
}

/// Serial orchestration kept independent from AppKit/AX so every state edge is unit-testable.
public final class DesktopBridgeCoordinator {
  private let launcher: DesktopURLLaunching
  private let accessibility: DesktopAccessibilitySubmitting
  private let frontmostApplications: FrontmostApplicationManaging
  private let taskFinder: DesktopTaskFinding
  private let submissionIntents: DesktopSubmissionIntentClaiming
  private let clock: DesktopBridgeClock
  private let discoveryPollMilliseconds: Int

  public init(
    launcher: DesktopURLLaunching,
    accessibility: DesktopAccessibilitySubmitting,
    frontmostApplications: FrontmostApplicationManaging,
    taskFinder: DesktopTaskFinding,
    submissionIntents: DesktopSubmissionIntentClaiming,
    clock: DesktopBridgeClock = SystemDesktopBridgeClock(),
    discoveryPollMilliseconds: Int = 100
  ) {
    self.launcher = launcher
    self.accessibility = accessibility
    self.frontmostApplications = frontmostApplications
    self.taskFinder = taskFinder
    self.submissionIntents = submissionIntents
    self.clock = clock
    self.discoveryPollMilliseconds = max(1, discoveryPollMilliseconds)
  }

  public func create(_ request: DesktopCreateRequest) throws -> DesktopCreateResult {
    try request.validate()

    // Crash recovery is deliberately first: if Send succeeded previously,
    // no Accessibility permission or UI mutation is needed on retry.
    if let existing = try taskFinder.findTaskId(
      marker: request.marker,
      cwd: request.cwd,
      notBeforeMilliseconds: 0
    ) {
      return DesktopCreateResult(
        threadId: existing,
        marker: request.marker,
        cwd: request.cwd
      )
    }

    let intent = try submissionIntents.claim(marker: request.marker, cwd: request.cwd)
    switch intent {
    case .retryable(let marker, let cwd):
      guard marker == request.marker, cwd == request.cwd else {
        throw DesktopBridgeError.taskDiscoveryFailed(
          "existing Desktop submission intent does not match the requested marker and cwd"
        )
      }
      // Accessibility is needed only while this process is still allowed to
      // mutate the UI. An armed possible-Send intent must remain recoverable
      // through read-only task discovery even when TCC or foreground access is
      // unavailable after a Desktop update or restart.
      try accessibility.preflight()
      do {
        try openAndSubmit(request) {
          switch try self.submissionIntents.arm(marker: request.marker, cwd: request.cwd) {
          case .armed:
            return
          case .existing(let marker, let cwd):
            guard marker == request.marker, cwd == request.cwd else {
              throw DesktopBridgeError.taskDiscoveryFailed(
                "existing Desktop Send-attempt barrier does not match the requested marker and cwd"
              )
            }
            throw DesktopSendBarrierAlreadyArmed()
          }
        }
      } catch is DesktopSendBarrierAlreadyArmed {
        // A concurrent helper won the exclusive barrier. Never press Send in
        // this process; continue with the same read-only discovery path used
        // after an uncertain or actual activation.
      }
    case .possibleSend(let marker, let cwd):
      guard marker == request.marker, cwd == request.cwd else {
        throw DesktopBridgeError.taskDiscoveryFailed(
          "existing Desktop submission intent does not match the requested marker and cwd"
        )
      }
    // Legacy v1 intents and v2 intents with an armed barrier may have sent.
    // Recovery is deliberately read-only.
    }

    let deadline = clock.nowMilliseconds() + Int64(request.discoveryTimeoutMilliseconds)
    while true {
      if let threadId = try taskFinder.findTaskId(
        marker: request.marker,
        cwd: request.cwd,
        notBeforeMilliseconds: request.notBeforeMilliseconds
      ) {
        return DesktopCreateResult(
          threadId: threadId,
          marker: request.marker,
          cwd: request.cwd
        )
      }
      let remaining = deadline - clock.nowMilliseconds()
      guard remaining > 0 else { break }
      clock.sleep(
        milliseconds: min(discoveryPollMilliseconds, Int(clamping: remaining))
      )
    }
    throw DesktopBridgeError.taskDiscoveryFailed(
      "Codex Desktop did not persist the marked task before timeout"
    )
  }

  private func openAndSubmit(
    _ request: DesktopCreateRequest,
    beforeSendActivation: () throws -> Void
  ) throws {
    let priorProcessIdentifier = frontmostApplications.captureFrontmostProcessIdentifier()
    defer {
      if let priorProcessIdentifier {
        frontmostApplications.restoreFrontmostApplication(
          processIdentifier: priorProcessIdentifier
        )
      }
    }
    let uiDeadline = clock.nowMilliseconds() + Int64(request.uiTimeoutMilliseconds)
    try launcher.open(request.url)
    let activationRemaining = uiDeadline - clock.nowMilliseconds()
    guard activationRemaining > 0 else {
      throw DesktopBridgeError.accessibilityUnavailable(
        "Codex Desktop did not open before the submission timeout"
      )
    }
    try frontmostApplications.activateCodexDesktop(
      timeoutMilliseconds: Int(clamping: activationRemaining)
    )
    let submissionRemaining = uiDeadline - clock.nowMilliseconds()
    guard submissionRemaining > 0 else {
      throw DesktopBridgeError.accessibilityUnavailable(
        "Codex Desktop did not become frontmost before the submission timeout"
      )
    }
    try accessibility.submit(
      marker: request.marker,
      timeoutMilliseconds: Int(clamping: submissionRemaining),
      beforeSendActivation: beforeSendActivation
    )
  }
}

public func isValidWakeWireMarker(_ marker: String) -> Bool {
  guard marker.hasPrefix(wakeWireMarkerPrefix) else { return false }
  let digest = marker.dropFirst(wakeWireMarkerPrefix.count)
  let bytes = Array(digest.utf8)
  return bytes.count == 64
    && bytes.allSatisfy { byte in
      (48...57).contains(byte) || (97...102).contains(byte)
    }
}

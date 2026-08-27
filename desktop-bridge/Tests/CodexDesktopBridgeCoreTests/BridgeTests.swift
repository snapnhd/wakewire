import CodexDesktopBridgeCore
import Foundation
import SQLite3

@main
private enum BridgeTestRunner {
  static func main() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments.first == "--claim-intent-child" {
      try runIntentClaimChild(arguments)
      return
    }
    if arguments.first == "--arm-intent-child" {
      try runIntentArmChild(arguments)
      return
    }

    let coordinator = DesktopBridgeCoordinatorTests()
    try coordinator.recoversWithoutUI()
    try coordinator.firstClaimCreatesAndRestores()
    try coordinator.existingClaimRecoversWithoutUI()
    try coordinator.armedIntentRecoversWhenPreflightWouldThrow()
    try coordinator.existingClaimTimesOutWithoutUI()
    try coordinator.mismatchedExistingClaimFailsWithoutUI()
    try coordinator.restoresOnFailure()
    try coordinator.retriesAfterDefinitelyPreSendFailure()
    try coordinator.doesNotRetryAfterSendBarrier()
    try coordinator.losingConcurrentArmDoesNotActivateSend()
    try coordinator.doesNotActivateSendWhenArmingFails()
    try coordinator.rejectsMismatchedURL()

    let renameCoordinator = DesktopRenameCoordinatorTests()
    try renameCoordinator.renamesExactTaskAndRestores()
    try renameCoordinator.restoresOnRenameFailure()
    try renameCoordinator.rejectsBeforeChangingUI()

    let renameValidation = DesktopRenameValidationTests()
    try renameValidation.acceptsCanonicalRequestAndJSON()
    try renameValidation.rejectsUnsafeIdentifiersTitlesAndTimeouts()
    try renameValidation.matchesOnlyExactEnglishDialogLabels()
    try renameValidation.matchesVisibleHeaderOrSidebarTitleOnly()
    try renameValidation.matchesOnlyPinnedDialogStructureAndModalRoles()
    try renameValidation.matchesOnlyExactActiveSidebarClassToken()
    try renameValidation.constructsUnicodeSentinelWithoutChangingTitle()

    let intentStore = SubmissionIntentStoreTests()
    try intentStore.privateV2ClaimAndArm()
    try intentStore.legacyV1ClaimRemainsReadOnly()
    try intentStore.rejectsSymlinkedDirectories()
    try intentStore.rejectsSymlinkedSendAttempt()
    try intentStore.concurrentProcessClaimRemainsRetryable()
    try intentStore.concurrentProcessArmIsExclusive()

    let sqlite = SQLiteDesktopTaskFinderTests()
    try sqlite.exactCorrelation()
    try sqlite.draftPreviewIsNotSubmitted()
    try sqlite.ambiguousCorrelation()
    try sqlite.oversizedRolloutFailsClosed()
    AccessibilityLabelTests().labels()
    try AccessibilitySubmitCandidateTests().matchesOnlyTheComposerSendArrow()

    let session = InteractiveSessionTests()
    try session.onConsolePasses()
    try session.offConsoleRejects()
    try session.missingConsoleKeyRejects()
    try session.lockedRejects()
    try session.malformedValuesReject()
    try session.misspelledLegacyKeysReject()
    print("CodexDesktopBridgeCoreTests: 40 passed")
  }

  private static func runIntentClaimChild(_ arguments: [String]) throws {
    guard arguments.count == 4 else {
      throw TestFailure("invalid intent-claim child arguments")
    }
    let store = PrivateFilesystemDesktopSubmissionIntentStore(
      wakeWireDirectory: URL(fileURLWithPath: arguments[1], isDirectory: true)
    )
    let result = try store.claim(marker: arguments[2], cwd: arguments[3])
    switch result {
    case .retryable(let marker, let cwd):
      try check(marker == arguments[2], "child retryable marker")
      try check(cwd == arguments[3], "child retryable cwd")
      print("retryable")
    case .possibleSend(let marker, let cwd):
      try check(marker == arguments[2], "child possible-Send marker")
      try check(cwd == arguments[3], "child possible-Send cwd")
      print("possible-send")
    }
  }

  private static func runIntentArmChild(_ arguments: [String]) throws {
    guard arguments.count == 4 else {
      throw TestFailure("invalid intent-arm child arguments")
    }
    let store = PrivateFilesystemDesktopSubmissionIntentStore(
      wakeWireDirectory: URL(fileURLWithPath: arguments[1], isDirectory: true)
    )
    let result = try store.arm(marker: arguments[2], cwd: arguments[3])
    switch result {
    case .armed:
      print("armed")
    case .existing(let marker, let cwd):
      try check(marker == arguments[2], "child existing barrier marker")
      try check(cwd == arguments[3], "child existing barrier cwd")
      print("existing")
    }
  }
}

private struct DesktopRenameCoordinatorTests {
  func renamesExactTaskAndRestores() throws {
    let launcher = FakeLauncher()
    let accessibility = FakeRenameAccessibility()
    let frontmost = FakeFrontmost(captured: 72)
    let coordinator = DesktopRenameCoordinator(
      launcher: launcher,
      accessibility: accessibility,
      frontmostApplications: frontmost
    )
    let input = renameRequest()

    let result = try coordinator.rename(input)

    try check(
      result == DesktopRenameResult(threadId: input.threadId, title: input.title),
      "rename result"
    )
    try check(accessibility.preflightCalls == 1, "rename Accessibility preflight")
    try check(
      launcher.opened.map(\.absoluteString) == ["codex://threads/\(input.threadId)"],
      "exact task deep link"
    )
    try check(accessibility.renames.count == 1, "one UI rename")
    try check(accessibility.renames[0].0 == input.threadId, "exact renamed thread")
    try check(accessibility.renames[0].1 == input.title, "exact renamed title")
    try check(
      accessibility.renames[0].2 == input.uiTimeoutMilliseconds,
      "rename timeout"
    )
    try check(frontmost.restored == [72], "restore prior app after rename")
  }

  func restoresOnRenameFailure() throws {
    let launcher = FakeLauncher()
    let accessibility = FakeRenameAccessibility(error: .renameDialogNotFound)
    let frontmost = FakeFrontmost(captured: 73)
    let coordinator = DesktopRenameCoordinator(
      launcher: launcher,
      accessibility: accessibility,
      frontmostApplications: frontmost
    )

    try expectError(.renameDialogNotFound) { try coordinator.rename(renameRequest()) }
    try check(launcher.opened.count == 1, "failed rename still opened the exact task")
    try check(frontmost.restored == [73], "restore prior app after rename failure")
  }

  func rejectsBeforeChangingUI() throws {
    let launcher = FakeLauncher()
    let accessibility = FakeRenameAccessibility()
    let frontmost = FakeFrontmost(captured: 74)
    let coordinator = DesktopRenameCoordinator(
      launcher: launcher,
      accessibility: accessibility,
      frontmostApplications: frontmost
    )
    let invalid = DesktopRenameRequest(
      threadId: "not-a-task",
      title: "Slack — ping",
      uiTimeoutMilliseconds: 1_000
    )

    try expectAnyError { try coordinator.rename(invalid) }
    try check(accessibility.preflightCalls == 0, "invalid rename must not preflight")
    try check(launcher.opened.isEmpty, "invalid rename must not open UI")
    try check(accessibility.renames.isEmpty, "invalid rename must not mutate UI")
    try check(frontmost.restored.isEmpty, "invalid rename must not change focus")
  }
}

private struct DesktopRenameValidationTests {
  func acceptsCanonicalRequestAndJSON() throws {
    let input = renameRequest()
    try input.validate()
    let url = try input.deepLinkURL()
    try check(
      url.absoluteString == "codex://threads/\(input.threadId)",
      "canonical rename URL"
    )
    let roundTrip = try JSONDecoder().decode(
      DesktopRenameRequest.self,
      from: JSONEncoder().encode(input)
    )
    try check(roundTrip == input, "rename request JSON round trip")
  }

  func rejectsUnsafeIdentifiersTitlesAndTimeouts() throws {
    let validId = renameRequest().threadId
    let invalidIdentifiers = [
      "019fa994-d602-76a3-911c-a349c4caceb",
      "019FA994-D602-76A3-911C-A349C4CACEBA",
      "{019fa994-d602-76a3-911c-a349c4caceba}",
      "../019fa994-d602-76a3-911c-a349c4caceba",
    ]
    for value in invalidIdentifiers {
      try check(!isValidCodexThreadIdentifier(value), "reject unsafe thread id \(value)")
    }
    try check(isValidCodexThreadIdentifier(validId), "accept canonical thread id")

    for value in ["", " title", "title ", "title\nother", "title\u{0000}other"] {
      try check(!isValidCodexThreadTitle(value), "reject unsafe title")
    }
    try check(isValidCodexThreadTitle(String(repeating: "é", count: 60)), "60 code points")
    try check(
      !isValidCodexThreadTitle(String(repeating: "é", count: 61)),
      "reject more than 60 code points"
    )
    try check(isValidCodexThreadTitle("Slack — ping"), "accept short Unicode title")

    for timeout in [0, -1, 120_001] {
      try expectAnyError {
        try DesktopRenameRequest(
          threadId: validId,
          title: "Slack — ping",
          uiTimeoutMilliseconds: timeout
        ).validate()
      }
    }
  }

  func matchesOnlyExactEnglishDialogLabels() throws {
    try check(isCodexRenameDialogTitle("Rename chat"), "chat dialog title")
    try check(isCodexRenameDialogTitle("Rename task"), "task dialog title")
    try check(!isCodexRenameDialogTitle("Rename project"), "reject project dialog")
    try check(isCodexRenameTitleFieldLabel("Chat title"), "chat title field")
    try check(isCodexRenameTitleFieldLabel("Task title"), "task title field")
    try check(isCodexRenameTitleFieldLabel("Add a title…"), "title placeholder")
    try check(!isCodexRenameTitleFieldLabel("Project name"), "reject project field")
    try check(isCodexRenameSaveLabel("Save"), "save button")
    try check(!isCodexRenameSaveLabel("Save changes"), "reject broad save label")
    try check(isCodexRenameCancelLabel("Cancel"), "cancel button")
    try check(!isCodexRenameCancelLabel("Cancel upload"), "reject broad cancel label")
  }

  func matchesVisibleHeaderOrSidebarTitleOnly() throws {
    let window = CGRect(x: 0, y: 0, width: 1_600, height: 1_000)
    let title = "Slack — ping"
    try check(
      isVisibleCodexThreadTitleCandidate(
        labels: [title],
        role: "AXStaticText",
        hidden: false,
        selectedOrFocused: false,
        frame: CGRect(x: 700, y: 50, width: 160, height: 24),
        windowFrame: window,
        expectedTitle: title
      ),
      "visible header title"
    )
    try check(
      isVisibleCodexThreadTitleCandidate(
        labels: [title],
        role: "AXButton",
        hidden: false,
        selectedOrFocused: true,
        frame: CGRect(x: 20, y: 500, width: 240, height: 30),
        windowFrame: window,
        expectedTitle: title
      ),
      "visible sidebar title"
    )
    try check(
      !isVisibleCodexThreadTitleCandidate(
        labels: [title],
        role: "AXStaticText",
        hidden: false,
        selectedOrFocused: false,
        frame: CGRect(x: 800, y: 600, width: 160, height: 24),
        windowFrame: window,
        expectedTitle: title
      ),
      "conversation-body text is not title evidence"
    )
    try check(
      !isVisibleCodexThreadTitleCandidate(
        labels: [title],
        role: "AXTextField",
        hidden: false,
        selectedOrFocused: true,
        frame: CGRect(x: 700, y: 50, width: 160, height: 24),
        windowFrame: window,
        expectedTitle: title
      ),
      "editable text is not post-save title evidence"
    )
    try check(
      !isVisibleCodexThreadTitleCandidate(
        labels: [title],
        role: "AXStaticText",
        hidden: true,
        selectedOrFocused: false,
        frame: CGRect(x: 700, y: 50, width: 160, height: 24),
        windowFrame: window,
        expectedTitle: title
      ),
      "hidden title is not visible evidence"
    )
    try check(
      !isVisibleCodexThreadTitleCandidate(
        labels: [title],
        role: "AXButton",
        hidden: false,
        selectedOrFocused: false,
        frame: CGRect(x: 20, y: 500, width: 240, height: 30),
        windowFrame: window,
        expectedTitle: title
      ),
      "duplicate unselected sidebar title is not current-task evidence"
    )
    try check(
      !isVisibleCodexThreadTitleCandidate(
        labels: [title],
        role: "AXStaticText",
        hidden: false,
        selectedOrFocused: false,
        frame: CGRect(x: 20, y: 50, width: 240, height: 30),
        windowFrame: window,
        expectedTitle: title
      ),
      "unselected sidebar title near the window top is not header evidence"
    )
  }

  func matchesOnlyPinnedDialogStructureAndModalRoles() throws {
    try check(
      isCodexRenameDialogContainer(role: "AXGroup", subrole: "AXApplicationDialog"),
      "exact application-dialog container"
    )
    try check(
      !isCodexRenameDialogContainer(role: "AXWindow", subrole: "AXApplicationDialog"),
      "reject wrong application-dialog role"
    )
    try check(
      isCodexPotentialRenameDialogContainer(
        role: "AXGroup",
        subrole: "AXApplicationDialog",
        staticTextValues: []
      ),
      "allow the exact dialog container to settle before descendants appear"
    )
    try check(
      isCodexPotentialRenameDialogContainer(
        role: "AXGroup",
        subrole: "AXApplicationDialog",
        staticTextValues: ["Rename chat", "Keep it short and recognizable"]
      ),
      "allow a partially constructed recognized rename dialog"
    )
    try check(
      !isCodexPotentialRenameDialogContainer(
        role: "AXGroup",
        subrole: "AXApplicationDialog",
        staticTextValues: ["Delete chat"]
      ),
      "reject a populated non-rename dialog immediately"
    )
    try check(
      isCodexRenameDialogHeading(role: "AXStaticText", value: "Rename chat"),
      "exact separate rename heading"
    )
    try check(
      !isCodexRenameDialogHeading(role: "AXTextField", value: "Rename chat"),
      "field value cannot impersonate heading"
    )
    try check(
      isCodexRenameFormLandmark(role: "AXGroup", subrole: "AXLandmarkForm"),
      "exact form landmark"
    )
    try check(
      !isCodexRenameFormLandmark(role: "AXLandmark", subrole: "AXLandmarkForm"),
      "reject a form landmark role not exposed by the pinned Desktop build"
    )
    try check(
      isCodexModalAccessibilityElement(
        role: "AXGroup",
        subrole: "AXApplicationDialog",
        modal: nil
      ),
      "application dialog is modal"
    )
    try check(
      isCodexModalAccessibilityElement(role: "AXApplicationDialog", subrole: nil, modal: nil),
      "application-dialog role is modal"
    )
    try check(
      !isCodexModalAccessibilityElement(role: "AXGroup", subrole: nil, modal: false),
      "plain group is not modal"
    )
  }

  func matchesOnlyExactActiveSidebarClassToken() throws {
    let window = CGRect(x: 0, y: 0, width: 1_600, height: 1_000)
    let row = CGRect(x: 12, y: 200, width: 280, height: 32)
    try check(
      codexDOMClassListHasExactActiveSidebarToken([
        "truncate \(codexActiveSidebarClassToken) rounded"
      ]),
      "active token is parsed from exact DOM class list tokens"
    )
    try check(
      !codexDOMClassListHasExactActiveSidebarToken([
        "prefix-\(codexActiveSidebarClassToken)"
      ]),
      "active token substring is rejected"
    )
    try check(
      isCodexActiveSidebarRowCandidate(
        domClassList: ["truncate \(codexActiveSidebarClassToken) rounded"],
        role: "AXGroup",
        frame: row,
        windowFrame: window
      ),
      "exact active-row class token"
    )
    try check(
      !isCodexActiveSidebarRowCandidate(
        domClassList: ["prefix-\(codexActiveSidebarClassToken)"],
        role: "AXGroup",
        frame: row,
        windowFrame: window
      ),
      "class token substring must not match"
    )
    try check(
      !isCodexActiveSidebarRowCandidate(
        domClassList: [codexActiveSidebarClassToken],
        role: "AXStaticText",
        frame: row,
        windowFrame: window
      ),
      "active token must belong to a row-like element"
    )
    try check(
      !isCodexActiveSidebarRowCandidate(
        domClassList: [codexActiveSidebarClassToken],
        role: "AXGroup",
        frame: CGRect(x: 800, y: 200, width: 280, height: 32),
        windowFrame: window
      ),
      "central content cannot impersonate active sidebar row"
    )
  }

  func constructsUnicodeSentinelWithoutChangingTitle() throws {
    let value = "A😀é—Z"
    let sentinel = codexRenameSentinelValue(value)
    try check(sentinel == value + " ", "sentinel preserves the exact Unicode title")
    try check(sentinel.dropLast() == Substring(value), "removing sentinel restores title")
  }
}

private struct DesktopBridgeCoordinatorTests {
  func recoversWithoutUI() throws {
    let input = request()
    let launcher = FakeLauncher()
    let accessibility = FakeAccessibility()
    let frontmost = FakeFrontmost()
    let finder = FakeFinder(results: ["existing-task"])
    let intents = FakeSubmissionIntents(
      results: [.retryable(marker: input.marker, cwd: input.cwd)]
    )
    let coordinator = DesktopBridgeCoordinator(
      launcher: launcher,
      accessibility: accessibility,
      frontmostApplications: frontmost,
      taskFinder: finder,
      submissionIntents: intents,
      clock: FakeClock()
    )

    let result = try coordinator.create(input)

    try check(result.threadId == "existing-task", "recovered task id")
    try check(launcher.opened.isEmpty, "recovery must not open UI")
    try check(accessibility.preflightCalls == 0, "recovery must not request Accessibility")
    try check(intents.calls.isEmpty, "exact recovery must not claim an intent")
    try check(frontmost.activations.isEmpty, "recovery must not activate Codex")
    try check(frontmost.restored.isEmpty, "recovery must not change focus")
  }

  func firstClaimCreatesAndRestores() throws {
    let input = request()
    let intents = FakeSubmissionIntents(
      results: [.retryable(marker: input.marker, cwd: input.cwd)]
    )
    let launcher = FakeLauncher {
      try check(!intents.calls.isEmpty, "intent must be claimed before opening UI")
    }
    let accessibility = FakeAccessibility()
    let frontmost = FakeFrontmost(captured: 42)
    let finder = FakeFinder(results: [nil, nil, "new-task"])
    let clock = FakeClock()
    let coordinator = DesktopBridgeCoordinator(
      launcher: launcher,
      accessibility: accessibility,
      frontmostApplications: frontmost,
      taskFinder: finder,
      submissionIntents: intents,
      clock: clock,
      discoveryPollMilliseconds: 10
    )

    let result = try coordinator.create(input)

    try check(
      result == DesktopCreateResult(threadId: "new-task", marker: input.marker, cwd: input.cwd),
      "created result"
    )
    try check(launcher.opened == [input.url], "deep link open")
    try check(accessibility.preflightCalls == 1, "Accessibility preflight")
    try check(intents.calls.count == 1, "one durable intent claim")
    try check(intents.calls.first?.0 == input.marker, "claimed marker")
    try check(intents.calls.first?.1 == input.cwd, "claimed cwd")
    try check(intents.armCalls.count == 1, "one durable Send-attempt barrier")
    try check(frontmost.activations.count == 1, "activate Codex before submission")
    try check(accessibility.submissions.count == 1, "one AX submission")
    try check(accessibility.submissions.first?.0 == input.marker, "submitted marker")
    try check(
      accessibility.submissions.first?.1 == input.uiTimeoutMilliseconds,
      "submitted timeout"
    )
    try check(frontmost.restored == [42], "restore frontmost app")
    try check(clock.sleeps == [10], "poll duration")
  }

  func existingClaimRecoversWithoutUI() throws {
    let input = request()
    let launcher = FakeLauncher()
    let accessibility = FakeAccessibility()
    let frontmost = FakeFrontmost(captured: 44)
    let finder = FakeFinder(results: [nil, "recovered-task"])
    let intents = FakeSubmissionIntents(
      results: [.possibleSend(marker: input.marker, cwd: input.cwd)]
    )
    let coordinator = DesktopBridgeCoordinator(
      launcher: launcher,
      accessibility: accessibility,
      frontmostApplications: frontmost,
      taskFinder: finder,
      submissionIntents: intents,
      clock: FakeClock()
    )

    let result = try coordinator.create(input)

    try check(result.threadId == "recovered-task", "existing intent recovery task")
    try check(accessibility.preflightCalls == 0, "existing intent must not preflight")
    try check(launcher.opened.isEmpty, "existing intent must not reopen the deep link")
    try check(accessibility.submissions.isEmpty, "existing intent must not resubmit")
    try check(frontmost.activations.isEmpty, "existing intent must not activate Codex")
    try check(frontmost.restored.isEmpty, "existing intent must not change focus")
  }

  func armedIntentRecoversWhenPreflightWouldThrow() throws {
    let input = request()
    let launcher = FakeLauncher {
      throw TestFailure("armed recovery must not launch Desktop")
    }
    let accessibility = FakeAccessibility(
      preflightError: .accessibilityUnavailable("simulated unavailable Accessibility")
    )
    let frontmost = FakeFrontmost(captured: 47)
    let finder = FakeFinder(results: [nil, "recovered-after-restart"])
    let intents = FakeSubmissionIntents(
      results: [.possibleSend(marker: input.marker, cwd: input.cwd)]
    )
    let coordinator = DesktopBridgeCoordinator(
      launcher: launcher,
      accessibility: accessibility,
      frontmostApplications: frontmost,
      taskFinder: finder,
      submissionIntents: intents,
      clock: FakeClock()
    )

    let result = try coordinator.create(input)

    try check(result.threadId == "recovered-after-restart", "armed recovery task id")
    try check(intents.calls.count == 1, "armed recovery reads the durable intent")
    try check(accessibility.preflightCalls == 0, "armed recovery bypasses throwing preflight")
    try check(accessibility.submissions.isEmpty, "armed recovery performs no AX submission")
    try check(launcher.opened.isEmpty, "armed recovery performs no launch")
    try check(frontmost.activations.isEmpty, "armed recovery performs no activation")
    try check(frontmost.restored.isEmpty, "armed recovery does not change focus")
  }

  func existingClaimTimesOutWithoutUI() throws {
    let input = request()
    let launcher = FakeLauncher()
    let accessibility = FakeAccessibility()
    let frontmost = FakeFrontmost(captured: 45)
    let intents = FakeSubmissionIntents(
      results: [.possibleSend(marker: input.marker, cwd: input.cwd)]
    )
    let coordinator = DesktopBridgeCoordinator(
      launcher: launcher,
      accessibility: accessibility,
      frontmostApplications: frontmost,
      taskFinder: FakeFinder(results: [nil]),
      submissionIntents: intents,
      clock: FakeClock(),
      discoveryPollMilliseconds: 1_000
    )

    try expectError(
      .taskDiscoveryFailed("Codex Desktop did not persist the marked task before timeout")
    ) {
      try coordinator.create(input)
    }
    try check(accessibility.preflightCalls == 0, "timed-out intent must not preflight")
    try check(launcher.opened.isEmpty, "timed-out existing intent must not reopen")
    try check(accessibility.submissions.isEmpty, "timed-out existing intent must not resubmit")
    try check(frontmost.restored.isEmpty, "timed-out existing intent must not change focus")
  }

  func mismatchedExistingClaimFailsWithoutUI() throws {
    let input = request()
    let launcher = FakeLauncher()
    let accessibility = FakeAccessibility()
    let frontmost = FakeFrontmost(captured: 46)
    let coordinator = DesktopBridgeCoordinator(
      launcher: launcher,
      accessibility: accessibility,
      frontmostApplications: frontmost,
      taskFinder: FakeFinder(results: [nil]),
      submissionIntents: FakeSubmissionIntents(
        results: [.possibleSend(marker: validMarker(), cwd: "/wrong")]
      ),
      clock: FakeClock()
    )

    try expectError(
      .taskDiscoveryFailed(
        "existing Desktop submission intent does not match the requested marker and cwd"
      )
    ) {
      try coordinator.create(input)
    }
    try check(accessibility.preflightCalls == 0, "mismatched intent must not preflight")
    try check(launcher.opened.isEmpty, "mismatched intent must not open UI")
    try check(accessibility.submissions.isEmpty, "mismatched intent must not submit")
    try check(frontmost.restored.isEmpty, "mismatched intent must not change focus")
  }

  func restoresOnFailure() throws {
    let input = request()
    let launcher = FakeLauncher()
    let accessibility = FakeAccessibility(error: .modalPresent)
    let frontmost = FakeFrontmost(captured: 99)
    let coordinator = DesktopBridgeCoordinator(
      launcher: launcher,
      accessibility: accessibility,
      frontmostApplications: frontmost,
      taskFinder: FakeFinder(results: [nil]),
      submissionIntents: FakeSubmissionIntents(
        results: [.retryable(marker: input.marker, cwd: input.cwd)]
      ),
      clock: FakeClock()
    )

    try expectError(.modalPresent) { try coordinator.create(input) }
    try check(frontmost.restored == [99], "restore focus after AX error")
  }

  func retriesAfterDefinitelyPreSendFailure() throws {
    let input = request()
    let intents = FakeSubmissionIntents(
      results: [
        .retryable(marker: input.marker, cwd: input.cwd),
        .retryable(marker: input.marker, cwd: input.cwd),
      ]
    )
    let firstLauncher = FakeLauncher()
    let firstAccessibility = FakeAccessibility(error: .modalPresent)
    let first = DesktopBridgeCoordinator(
      launcher: firstLauncher,
      accessibility: firstAccessibility,
      frontmostApplications: FakeFrontmost(),
      taskFinder: FakeFinder(results: [nil]),
      submissionIntents: intents,
      clock: FakeClock()
    )
    try expectError(.modalPresent) { try first.create(input) }
    try check(intents.armCalls.isEmpty, "pre-Send failure must not arm")
    try check(firstAccessibility.sendActivations == 0, "pre-Send failure must not activate Send")

    let secondLauncher = FakeLauncher()
    let secondAccessibility = FakeAccessibility()
    let second = DesktopBridgeCoordinator(
      launcher: secondLauncher,
      accessibility: secondAccessibility,
      frontmostApplications: FakeFrontmost(),
      taskFinder: FakeFinder(results: [nil, "retried-task"]),
      submissionIntents: intents,
      clock: FakeClock()
    )
    let result = try second.create(input)
    try check(result.threadId == "retried-task", "retry discovers submitted task")
    try check(firstLauncher.opened.count == 1, "first attempt opens one draft")
    try check(secondLauncher.opened.count == 1, "retry may reopen the unarmed draft")
    try check(intents.armCalls.count == 1, "retry arms exactly once")
    try check(secondAccessibility.sendActivations == 1, "retry activates Send once")
  }

  func doesNotRetryAfterSendBarrier() throws {
    let input = request()
    let intents = FakeSubmissionIntents(
      results: [
        .retryable(marker: input.marker, cwd: input.cwd),
        .possibleSend(marker: input.marker, cwd: input.cwd),
      ]
    )
    let firstAccessibility = FakeAccessibility(errorAfterActivation: .sendButtonDidNotSubmit)
    let first = DesktopBridgeCoordinator(
      launcher: FakeLauncher(),
      accessibility: firstAccessibility,
      frontmostApplications: FakeFrontmost(),
      taskFinder: FakeFinder(results: [nil]),
      submissionIntents: intents,
      clock: FakeClock()
    )
    try expectError(.sendButtonDidNotSubmit) { try first.create(input) }
    try check(intents.armCalls.count == 1, "uncertain Send is armed")
    try check(firstAccessibility.sendActivations == 1, "first process may activate Send")

    let recoveryLauncher = FakeLauncher()
    let recoveryAccessibility = FakeAccessibility()
    let recovery = DesktopBridgeCoordinator(
      launcher: recoveryLauncher,
      accessibility: recoveryAccessibility,
      frontmostApplications: FakeFrontmost(),
      taskFinder: FakeFinder(results: [nil, "recovered-task"]),
      submissionIntents: intents,
      clock: FakeClock()
    )
    let result = try recovery.create(input)
    try check(result.threadId == "recovered-task", "armed recovery discovers original task")
    try check(recoveryLauncher.opened.isEmpty, "armed recovery must not reopen Desktop")
    try check(recoveryAccessibility.submissions.isEmpty, "armed recovery must not resubmit")
    try check(intents.armCalls.count == 1, "armed recovery must not re-arm")
  }

  func doesNotActivateSendWhenArmingFails() throws {
    let input = request()
    let accessibility = FakeAccessibility()
    let intents = FakeSubmissionIntents(
      results: [.retryable(marker: input.marker, cwd: input.cwd)],
      armError: .taskDiscoveryFailed("simulated arm failure")
    )
    let coordinator = DesktopBridgeCoordinator(
      launcher: FakeLauncher(),
      accessibility: accessibility,
      frontmostApplications: FakeFrontmost(),
      taskFinder: FakeFinder(results: [nil]),
      submissionIntents: intents,
      clock: FakeClock()
    )

    try expectError(.taskDiscoveryFailed("simulated arm failure")) {
      try coordinator.create(input)
    }
    try check(intents.armCalls.count == 1, "failed barrier is attempted once")
    try check(accessibility.sendActivations == 0, "failed barrier must prevent Send activation")
  }

  func losingConcurrentArmDoesNotActivateSend() throws {
    let input = request()
    let accessibility = FakeAccessibility()
    let intents = FakeSubmissionIntents(
      results: [.retryable(marker: input.marker, cwd: input.cwd)],
      armResults: [.existing(marker: input.marker, cwd: input.cwd)]
    )
    let coordinator = DesktopBridgeCoordinator(
      launcher: FakeLauncher(),
      accessibility: accessibility,
      frontmostApplications: FakeFrontmost(),
      taskFinder: FakeFinder(results: [nil, "winner-task"]),
      submissionIntents: intents,
      clock: FakeClock()
    )

    let result = try coordinator.create(input)
    try check(result.threadId == "winner-task", "loser follows read-only discovery")
    try check(intents.armCalls.count == 1, "loser observes one existing barrier")
    try check(accessibility.sendActivations == 0, "loser must not activate Send")
  }

  func rejectsMismatchedURL() throws {
    let marker = validMarker()
    let url = URL(
      string: "codex://threads/new?path=/wrong&prompt=missing-marker"
    )!
    let input = DesktopCreateRequest(
      url: url,
      marker: marker,
      cwd: "/expected",
      notBeforeMilliseconds: 1,
      uiTimeoutMilliseconds: 1_000,
      discoveryTimeoutMilliseconds: 1_000
    )

    try expectAnyError { try input.validate() }
  }
}

private struct SubmissionIntentStoreTests {
  func privateV2ClaimAndArm() throws {
    let fixtureRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("wakewire-intent-store-\(UUID().uuidString)", isDirectory: true)
    let wakeWireDirectory = fixtureRoot.appendingPathComponent(".wakewire", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: fixtureRoot) }
    try FileManager.default.createDirectory(
      at: fixtureRoot,
      withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700]
    )

    let store = PrivateFilesystemDesktopSubmissionIntentStore(
      wakeWireDirectory: wakeWireDirectory
    )
    let marker = validMarker()
    let cwd = FileManager.default.temporaryDirectory.path

    let firstClaim = try store.claim(marker: marker, cwd: cwd)
    let secondClaim = try store.claim(marker: marker, cwd: cwd)
    try check(
      firstClaim == .retryable(marker: marker, cwd: cwd),
      "new v2 intent is retryable"
    )
    try check(
      secondClaim == .retryable(marker: marker, cwd: cwd),
      "existing unarmed v2 intent remains retryable"
    )
    let firstArm = try store.arm(marker: marker, cwd: cwd)
    let armedClaim = try store.claim(marker: marker, cwd: cwd)
    try check(firstArm == .armed, "first arm is exclusive")
    try check(
      armedClaim == .possibleSend(marker: marker, cwd: cwd),
      "armed v2 intent becomes read-only"
    )

    let intentDirectory = wakeWireDirectory.appendingPathComponent(
      "desktop-submission-intents-v1",
      isDirectory: true
    )
    let digest = String(marker.dropFirst(wakeWireMarkerPrefix.count))
    let intentFile = intentDirectory.appendingPathComponent("\(digest).json")
    let sendAttemptFile = intentDirectory.appendingPathComponent(
      "\(digest).send-attempt.json"
    )
    let wakeWireMode = try permissions(at: wakeWireDirectory)
    let intentDirectoryMode = try permissions(at: intentDirectory)
    let intentFileMode = try permissions(at: intentFile)
    let sendAttemptFileMode = try permissions(at: sendAttemptFile)
    try check(wakeWireMode == 0o700, "WakeWire directory mode")
    try check(intentDirectoryMode == 0o700, "intent directory mode")
    try check(intentFileMode == 0o600, "intent file mode")
    try check(sendAttemptFileMode == 0o600, "Send-attempt file mode")
  }

  func legacyV1ClaimRemainsReadOnly() throws {
    let fixtureRoot = try makeFixtureRoot(named: "wakewire-intent-legacy")
    defer { try? FileManager.default.removeItem(at: fixtureRoot) }
    let wakeWireDirectory = fixtureRoot.appendingPathComponent(".wakewire", isDirectory: true)
    let store = PrivateFilesystemDesktopSubmissionIntentStore(
      wakeWireDirectory: wakeWireDirectory
    )
    let marker = validMarker()
    let cwd = FileManager.default.temporaryDirectory.path
    _ = try store.claim(marker: marker, cwd: cwd)

    let digest = String(marker.dropFirst(wakeWireMarkerPrefix.count))
    let intentFile =
      wakeWireDirectory
      .appendingPathComponent("desktop-submission-intents-v1", isDirectory: true)
      .appendingPathComponent("\(digest).json")
    let legacy = try JSONSerialization.data(
      withJSONObject: ["version": 1, "marker": marker, "cwd": cwd],
      options: [.sortedKeys]
    )
    try legacy.write(to: intentFile)

    let legacyClaim = try store.claim(marker: marker, cwd: cwd)
    let legacyArm = try store.arm(marker: marker, cwd: cwd)
    try check(
      legacyClaim == .possibleSend(marker: marker, cwd: cwd),
      "legacy v1 intent must remain read-only"
    )
    try check(
      legacyArm == .existing(marker: marker, cwd: cwd),
      "legacy v1 intent cannot be armed for a new Send"
    )
  }

  func rejectsSymlinkedDirectories() throws {
    let rootFixture = try makeFixtureRoot(named: "wakewire-intent-root-symlink")
    defer { try? FileManager.default.removeItem(at: rootFixture) }
    let rootTarget = rootFixture.appendingPathComponent("target", isDirectory: true)
    try FileManager.default.createDirectory(at: rootTarget, withIntermediateDirectories: false)
    let linkedWakeWire = rootFixture.appendingPathComponent(".wakewire", isDirectory: true)
    try FileManager.default.createSymbolicLink(at: linkedWakeWire, withDestinationURL: rootTarget)
    let rootStore = PrivateFilesystemDesktopSubmissionIntentStore(
      wakeWireDirectory: linkedWakeWire
    )
    try expectAnyError {
      try rootStore.claim(marker: validMarker(), cwd: FileManager.default.temporaryDirectory.path)
    }
    let rootTargetContents = try FileManager.default.contentsOfDirectory(atPath: rootTarget.path)
    try check(rootTargetContents.isEmpty, "root symlink target must remain untouched")

    let storeFixture = try makeFixtureRoot(named: "wakewire-intent-store-symlink")
    defer { try? FileManager.default.removeItem(at: storeFixture) }
    let actualWakeWire = storeFixture.appendingPathComponent(".wakewire", isDirectory: true)
    try FileManager.default.createDirectory(
      at: actualWakeWire,
      withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700]
    )
    let storeTarget = storeFixture.appendingPathComponent("target", isDirectory: true)
    try FileManager.default.createDirectory(at: storeTarget, withIntermediateDirectories: false)
    let linkedStore = actualWakeWire.appendingPathComponent(
      "desktop-submission-intents-v1",
      isDirectory: true
    )
    try FileManager.default.createSymbolicLink(at: linkedStore, withDestinationURL: storeTarget)
    let nestedStore = PrivateFilesystemDesktopSubmissionIntentStore(
      wakeWireDirectory: actualWakeWire
    )
    try expectAnyError {
      try nestedStore.claim(marker: validMarker(), cwd: FileManager.default.temporaryDirectory.path)
    }
    let storeTargetContents = try FileManager.default.contentsOfDirectory(atPath: storeTarget.path)
    try check(storeTargetContents.isEmpty, "store symlink target must remain untouched")
  }

  func rejectsSymlinkedSendAttempt() throws {
    let fixtureRoot = try makeFixtureRoot(named: "wakewire-intent-arm-symlink")
    defer { try? FileManager.default.removeItem(at: fixtureRoot) }
    let wakeWireDirectory = fixtureRoot.appendingPathComponent(".wakewire", isDirectory: true)
    let store = PrivateFilesystemDesktopSubmissionIntentStore(
      wakeWireDirectory: wakeWireDirectory
    )
    let marker = validMarker()
    let cwd = FileManager.default.temporaryDirectory.path
    _ = try store.claim(marker: marker, cwd: cwd)

    let target = fixtureRoot.appendingPathComponent("arm-target")
    let original = Data("do-not-touch".utf8)
    try original.write(to: target)
    let digest = String(marker.dropFirst(wakeWireMarkerPrefix.count))
    let sendAttempt =
      wakeWireDirectory
      .appendingPathComponent("desktop-submission-intents-v1", isDirectory: true)
      .appendingPathComponent("\(digest).send-attempt.json")
    try FileManager.default.createSymbolicLink(at: sendAttempt, withDestinationURL: target)

    try expectAnyError { try store.claim(marker: marker, cwd: cwd) }
    try expectAnyError { try store.arm(marker: marker, cwd: cwd) }
    let targetContents = try Data(contentsOf: target)
    try check(targetContents == original, "sidecar symlink target remains untouched")
  }

  func concurrentProcessClaimRemainsRetryable() throws {
    let fixtureRoot = try makeFixtureRoot(named: "wakewire-intent-concurrent")
    defer { try? FileManager.default.removeItem(at: fixtureRoot) }
    let wakeWireDirectory = fixtureRoot.appendingPathComponent(".wakewire", isDirectory: true)
    let marker = wakeWireMarkerPrefix + String(repeating: "b", count: 64)
    let cwd = FileManager.default.temporaryDirectory.path
    let outcomes = try runChildren(
      command: "--claim-intent-child",
      wakeWireDirectory: wakeWireDirectory,
      marker: marker,
      cwd: cwd
    )
    try check(
      outcomes.filter { $0 == "retryable" }.count == 8,
      "all processes may prepare an unarmed v2 draft"
    )
  }

  func concurrentProcessArmIsExclusive() throws {
    let fixtureRoot = try makeFixtureRoot(named: "wakewire-arm-concurrent")
    defer { try? FileManager.default.removeItem(at: fixtureRoot) }
    let wakeWireDirectory = fixtureRoot.appendingPathComponent(".wakewire", isDirectory: true)
    let marker = wakeWireMarkerPrefix + String(repeating: "c", count: 64)
    let cwd = FileManager.default.temporaryDirectory.path
    let store = PrivateFilesystemDesktopSubmissionIntentStore(
      wakeWireDirectory: wakeWireDirectory
    )
    _ = try store.claim(marker: marker, cwd: cwd)

    let outcomes = try runChildren(
      command: "--arm-intent-child",
      wakeWireDirectory: wakeWireDirectory,
      marker: marker,
      cwd: cwd
    )
    try check(outcomes.filter { $0 == "armed" }.count == 1, "exactly one process arms")
    try check(outcomes.filter { $0 == "existing" }.count == 7, "other arms fail closed")
    let armedClaim = try store.claim(marker: marker, cwd: cwd)
    try check(
      armedClaim == .possibleSend(marker: marker, cwd: cwd),
      "concurrently armed intent is read-only"
    )
  }

  private func runChildren(
    command: String,
    wakeWireDirectory: URL,
    marker: String,
    cwd: String
  ) throws -> [String] {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    var children: [(Process, Pipe, Pipe)] = []
    for _ in 0..<8 {
      let process = Process()
      let standardOutput = Pipe()
      let standardError = Pipe()
      process.executableURL = executable
      process.arguments = [command, wakeWireDirectory.path, marker, cwd]
      process.standardOutput = standardOutput
      process.standardError = standardError
      try process.run()
      children.append((process, standardOutput, standardError))
    }

    var outcomes: [String] = []
    for (process, standardOutput, standardError) in children {
      process.waitUntilExit()
      let output =
        String(
          data: standardOutput.fileHandleForReading.readDataToEndOfFile(),
          encoding: .utf8
        )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let error =
        String(
          data: standardError.fileHandleForReading.readDataToEndOfFile(),
          encoding: .utf8
        )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      try check(
        process.terminationStatus == 0,
        "\(command) child failed with status \(process.terminationStatus): \(error)"
      )
      outcomes.append(output)
    }
    return outcomes
  }

  private func makeFixtureRoot(named name: String) throws -> URL {
    let fixtureRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: fixtureRoot,
      withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700]
    )
    return fixtureRoot
  }

  private func permissions(at url: URL) throws -> Int {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    guard let permissions = attributes[.posixPermissions] as? NSNumber else {
      throw TestFailure("missing permissions for \(url.path)")
    }
    return permissions.intValue & 0o777
  }
}

private struct SQLiteDesktopTaskFinderTests {
  func exactCorrelation() throws {
    let temporary = FileManager.default.temporaryDirectory
      .appendingPathComponent("wakewire-desktop-bridge-\(UUID().uuidString).sqlite")
    let rollout = temporary.appendingPathExtension("jsonl")
    defer { try? FileManager.default.removeItem(at: temporary) }
    defer { try? FileManager.default.removeItem(at: rollout) }
    try createFixtureDatabase(at: temporary.path)

    let marker = validMarker()
    try writeStartedRollout(at: rollout, marker: marker)
    var database: OpaquePointer?
    try check(sqlite3_open(temporary.path, &database) == SQLITE_OK, "open SQLite fixture")
    guard let database else { throw TestFailure("missing SQLite fixture handle") }
    defer { sqlite3_close(database) }
    let insert = """
      INSERT INTO threads
        (id, archived, cwd, created_at, created_at_ms, first_user_message, rollout_path)
      VALUES
        ('wrong-cwd', 0, '/wrong', 2, 2000, '\(marker)', NULL),
        ('too-old', 0, '/right', 1, 1000, '\(marker)', NULL),
        ('archived', 1, '/right', 3, 3000, '\(marker)', NULL),
        ('match', 0, '/right', 4, 4000, 'prompt \(marker)', '\(sqlQuote(rollout.path))')
      """
    try check(sqlite3_exec(database, insert, nil, nil, nil) == SQLITE_OK, "insert fixtures")

    let finder = SQLiteDesktopTaskFinder(databasePath: temporary.path)
    let found = try finder.findTaskId(
      marker: marker,
      cwd: "/right",
      notBeforeMilliseconds: 2_000
    )
    try check(found == "match", "exact SQLite correlation")
  }

  func ambiguousCorrelation() throws {
    let temporary = FileManager.default.temporaryDirectory
      .appendingPathComponent("wakewire-desktop-bridge-\(UUID().uuidString).sqlite")
    let firstRollout = temporary.appendingPathExtension("one.jsonl")
    let secondRollout = temporary.appendingPathExtension("two.jsonl")
    defer { try? FileManager.default.removeItem(at: temporary) }
    defer { try? FileManager.default.removeItem(at: firstRollout) }
    defer { try? FileManager.default.removeItem(at: secondRollout) }
    try createFixtureDatabase(at: temporary.path)

    let marker = validMarker()
    try writeStartedRollout(at: firstRollout, marker: marker, turnId: "turn-one")
    try writeStartedRollout(at: secondRollout, marker: marker, turnId: "turn-two")
    var database: OpaquePointer?
    try check(sqlite3_open(temporary.path, &database) == SQLITE_OK, "open SQLite fixture")
    guard let database else { throw TestFailure("missing SQLite fixture handle") }
    defer { sqlite3_close(database) }
    let insert = """
      INSERT INTO threads
        (id, archived, cwd, created_at, created_at_ms, first_user_message, rollout_path)
      VALUES
        ('one', 0, '/right', 1, 1000, '\(marker)', '\(sqlQuote(firstRollout.path))'),
        ('two', 0, '/right', 2, 2000, '\(marker)', '\(sqlQuote(secondRollout.path))')
      """
    try check(sqlite3_exec(database, insert, nil, nil, nil) == SQLITE_OK, "insert fixtures")

    let finder = SQLiteDesktopTaskFinder(databasePath: temporary.path)
    try expectAnyError {
      try finder.findTaskId(marker: marker, cwd: "/right", notBeforeMilliseconds: 0) as Any
    }
  }

  func draftPreviewIsNotSubmitted() throws {
    let temporary = FileManager.default.temporaryDirectory
      .appendingPathComponent("wakewire-desktop-bridge-\(UUID().uuidString).sqlite")
    defer { try? FileManager.default.removeItem(at: temporary) }
    try createFixtureDatabase(at: temporary.path)

    let marker = validMarker()
    var database: OpaquePointer?
    try check(sqlite3_open(temporary.path, &database) == SQLITE_OK, "open SQLite fixture")
    guard let database else { throw TestFailure("missing SQLite fixture handle") }
    defer { sqlite3_close(database) }
    let insert = """
      INSERT INTO threads
        (id, archived, cwd, created_at, created_at_ms, first_user_message, preview)
      VALUES
        ('preview-match', 0, '/right', 4, 4000, '', 'prompt \(marker)')
      """
    try check(sqlite3_exec(database, insert, nil, nil, nil) == SQLITE_OK, "insert fixture")

    let finder = SQLiteDesktopTaskFinder(databasePath: temporary.path)
    let found = try finder.findTaskId(
      marker: marker,
      cwd: "/right",
      notBeforeMilliseconds: 2_000
    )
    try check(found == nil, "draft preview must not prove Desktop submission")
  }

  func oversizedRolloutFailsClosed() throws {
    let temporary = FileManager.default.temporaryDirectory
      .appendingPathComponent("wakewire-desktop-bridge-\(UUID().uuidString).sqlite")
    let rollout = temporary.appendingPathExtension("jsonl")
    defer { try? FileManager.default.removeItem(at: temporary) }
    defer { try? FileManager.default.removeItem(at: rollout) }
    try createFixtureDatabase(at: temporary.path)
    try Data(repeating: 0x78, count: 4 * 1_024 * 1_024 + 1).write(to: rollout)

    let marker = validMarker()
    var database: OpaquePointer?
    try check(sqlite3_open(temporary.path, &database) == SQLITE_OK, "open SQLite fixture")
    guard let database else { throw TestFailure("missing SQLite fixture handle") }
    defer { sqlite3_close(database) }
    let insert = """
      INSERT INTO threads
        (id, archived, cwd, created_at, created_at_ms, first_user_message, rollout_path)
      VALUES
        ('oversized', 0, '/right', 4, 4000, '\(marker)', '\(sqlQuote(rollout.path))')
      """
    try check(sqlite3_exec(database, insert, nil, nil, nil) == SQLITE_OK, "insert fixture")

    let finder = SQLiteDesktopTaskFinder(databasePath: temporary.path)
    try expectAnyError {
      try finder.findTaskId(
        marker: marker,
        cwd: "/right",
        notBeforeMilliseconds: 2_000
      ) as Any
    }
  }
}

private struct AccessibilityLabelTests {
  func labels() {
    precondition(isSendLabel("Send"))
    precondition(isSendLabel("send-message"))
    precondition(isSendLabel("SEND_BUTTON"))
    precondition(!isSendLabel("Send feedback"))
    precondition(!isSendLabel("Resend"))
  }
}

private struct AccessibilitySubmitCandidateTests {
  private let composer = CGRect(x: 950, y: 1009, width: 712, height: 345)
  private let controls = CGRect(x: 938, y: 995, width: 736, height: 399)
  private let send = CGRect(x: 1638, y: 1358, width: 28, height: 28)

  func matchesOnlyTheComposerSendArrow() throws {
    try check(matches(), "exact live unlabeled composer arrow should match")
    try check(
      isComposerSubmitGeometryCandidate(
        subrole: "",
        enabled: true,
        supportsPress: true,
        buttonFrame: send,
        composerFrame: composer,
        controlFrame: controls,
        rightmostButtonMaxX: send.maxX
      ),
      "exact live labeled composer arrow should share the verified geometry"
    )
    try check(!matches(labels: ["Dictate"]), "labeled control should reject")
    try check(!matches(subrole: "AXCloseButton"), "window control should reject")
    try check(!matches(enabled: false), "disabled control should reject")
    try check(!matches(enabled: nil), "missing enabled state should reject")
    try check(!matches(supportsPress: false), "control without AXPress should reject")
    try check(
      !matches(buttonFrame: CGRect(x: 1500, y: 1358, width: 28, height: 28)),
      "non-rightmost control should reject"
    )
    try check(
      !matches(buttonFrame: CGRect(x: 1638, y: 1200, width: 28, height: 28)),
      "control above the composer action row should reject"
    )
    try check(
      !matches(buttonFrame: CGRect(x: 1680, y: 1358, width: 28, height: 28)),
      "control outside the composer group should reject"
    )
    try check(
      !matches(buttonFrame: CGRect(x: 1614, y: 1334, width: 52, height: 52)),
      "oversized control should reject"
    )
  }

  private func matches(
    labels: [String] = ["", "", "", ""],
    subrole: String? = "",
    enabled: Bool? = true,
    supportsPress: Bool = true,
    buttonFrame: CGRect? = nil
  ) -> Bool {
    isUnlabeledComposerSubmitCandidate(
      labels: labels,
      subrole: subrole,
      enabled: enabled,
      supportsPress: supportsPress,
      buttonFrame: buttonFrame ?? send,
      composerFrame: composer,
      controlFrame: controls,
      rightmostButtonMaxX: send.maxX
    )
  }
}

private struct InteractiveSessionTests {
  func onConsolePasses() throws {
    try check(
      isInteractiveDesktopSession(["kCGSSessionOnConsoleKey": true]),
      "on-console session should pass"
    )
  }

  func offConsoleRejects() throws {
    try check(
      !isInteractiveDesktopSession(["kCGSSessionOnConsoleKey": false]),
      "off-console session should reject"
    )
  }

  func missingConsoleKeyRejects() throws {
    try check(!isInteractiveDesktopSession([:]), "missing console key should reject")
    try check(!isInteractiveDesktopSession(nil), "missing session dictionary should reject")
  }

  func lockedRejects() throws {
    try check(
      !isInteractiveDesktopSession([
        "kCGSSessionOnConsoleKey": true,
        "CGSSessionScreenIsLocked": true,
      ]),
      "locked session should reject"
    )
  }

  func malformedValuesReject() throws {
    try check(
      !isInteractiveDesktopSession(["kCGSSessionOnConsoleKey": "true"]),
      "malformed console value should reject"
    )
    try check(
      !isInteractiveDesktopSession([
        "kCGSSessionOnConsoleKey": true,
        "CGSSessionScreenIsLocked": "false",
      ]),
      "malformed lock value should reject"
    )
  }

  func misspelledLegacyKeysReject() throws {
    try check(
      !isInteractiveDesktopSession([
        "CGSSessionOnConsoleKey": true,
        "kCGSessionOnConsoleKey": true,
      ]),
      "misspelled legacy keys should reject"
    )
  }
}

private final class FakeLauncher: DesktopURLLaunching {
  var opened: [URL] = []
  private let beforeOpen: (() throws -> Void)?

  init(beforeOpen: (() throws -> Void)? = nil) {
    self.beforeOpen = beforeOpen
  }

  func open(_ url: URL) throws {
    try beforeOpen?()
    opened.append(url)
  }
}

private final class FakeAccessibility: DesktopAccessibilitySubmitting {
  var preflightCalls = 0
  var submissions: [(String, Int)] = []
  var sendActivations = 0
  let preflightError: DesktopBridgeError?
  let errorBeforeActivation: DesktopBridgeError?
  let errorAfterActivation: DesktopBridgeError?

  init(
    preflightError: DesktopBridgeError? = nil,
    error: DesktopBridgeError? = nil,
    errorAfterActivation: DesktopBridgeError? = nil
  ) {
    self.preflightError = preflightError
    self.errorBeforeActivation = error
    self.errorAfterActivation = errorAfterActivation
  }

  func preflight() throws {
    preflightCalls += 1
    if let preflightError { throw preflightError }
  }

  func submit(
    marker: String,
    timeoutMilliseconds: Int,
    beforeSendActivation: () throws -> Void
  ) throws {
    submissions.append((marker, timeoutMilliseconds))
    if let errorBeforeActivation { throw errorBeforeActivation }
    try beforeSendActivation()
    sendActivations += 1
    if let errorAfterActivation { throw errorAfterActivation }
  }
}

private final class FakeRenameAccessibility: DesktopAccessibilityRenaming {
  var preflightCalls = 0
  var renames: [(String, String, Int)] = []
  let error: DesktopBridgeError?

  init(error: DesktopBridgeError? = nil) {
    self.error = error
  }

  func preflight() throws {
    preflightCalls += 1
  }

  func rename(threadId: String, title: String, timeoutMilliseconds: Int) throws {
    renames.append((threadId, title, timeoutMilliseconds))
    if let error { throw error }
  }
}

private final class FakeFrontmost: FrontmostApplicationManaging {
  let captured: pid_t?
  var activations: [Int] = []
  var restored: [pid_t] = []

  init(captured: pid_t? = nil) {
    self.captured = captured
  }

  func captureFrontmostProcessIdentifier() -> pid_t? { captured }

  func activateCodexDesktop(timeoutMilliseconds: Int) throws {
    activations.append(timeoutMilliseconds)
  }

  func restoreFrontmostApplication(processIdentifier: pid_t) {
    restored.append(processIdentifier)
  }
}

private final class FakeFinder: DesktopTaskFinding {
  private var results: [String?]

  init(results: [String?]) {
    self.results = results
  }

  func findTaskId(
    marker: String,
    cwd: String,
    notBeforeMilliseconds: Int64
  ) throws -> String? {
    if results.isEmpty { return nil }
    return results.removeFirst()
  }
}

private final class FakeSubmissionIntents: DesktopSubmissionIntentClaiming {
  var calls: [(String, String)] = []
  var armCalls: [(String, String)] = []
  private var results: [DesktopSubmissionIntentClaim]
  private var armResults: [DesktopSubmissionIntentArm]
  private let armError: DesktopBridgeError?

  init(
    results: [DesktopSubmissionIntentClaim],
    armResults: [DesktopSubmissionIntentArm] = [.armed],
    armError: DesktopBridgeError? = nil
  ) {
    self.results = results
    self.armResults = armResults
    self.armError = armError
  }

  func claim(marker: String, cwd: String) throws -> DesktopSubmissionIntentClaim {
    calls.append((marker, cwd))
    guard !results.isEmpty else {
      throw TestFailure("missing fake Desktop submission-intent result")
    }
    return results.removeFirst()
  }

  func arm(marker: String, cwd: String) throws -> DesktopSubmissionIntentArm {
    armCalls.append((marker, cwd))
    if let armError { throw armError }
    guard !armResults.isEmpty else {
      throw TestFailure("missing fake Desktop Send-attempt result")
    }
    return armResults.removeFirst()
  }
}

private final class FakeClock: DesktopBridgeClock {
  var now: Int64 = 1_000
  var sleeps: [Int] = []

  func nowMilliseconds() -> Int64 { now }

  func sleep(milliseconds: Int) {
    sleeps.append(milliseconds)
    now += Int64(milliseconds)
  }
}

private func request() -> DesktopCreateRequest {
  let marker = validMarker()
  let cwd = FileManager.default.temporaryDirectory.path
  var components = URLComponents(string: "codex://threads/new")!
  components.queryItems = [
    URLQueryItem(name: "path", value: cwd),
    URLQueryItem(name: "prompt", value: "Do work\n\n[WakeWire correlation: \(marker)]"),
  ]
  return DesktopCreateRequest(
    url: components.url!,
    marker: marker,
    cwd: cwd,
    notBeforeMilliseconds: 1_000,
    uiTimeoutMilliseconds: 2_000,
    discoveryTimeoutMilliseconds: 2_000
  )
}

private func renameRequest() -> DesktopRenameRequest {
  DesktopRenameRequest(
    threadId: "019fa994-d602-76a3-911c-a349c4caceba",
    title: "Slack — ping",
    uiTimeoutMilliseconds: 2_000
  )
}

private func validMarker() -> String {
  wakeWireMarkerPrefix + String(repeating: "a", count: 64)
}

private func createFixtureDatabase(at path: String) throws {
  var database: OpaquePointer?
  guard sqlite3_open(path, &database) == SQLITE_OK, let database else {
    throw DesktopBridgeError.stateDatabase("could not create fixture")
  }
  defer { sqlite3_close(database) }
  let schema = """
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      archived INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_at_ms INTEGER,
      first_user_message TEXT NOT NULL,
      preview TEXT NOT NULL DEFAULT '',
      rollout_path TEXT
    )
    """
  guard sqlite3_exec(database, schema, nil, nil, nil) == SQLITE_OK else {
    throw DesktopBridgeError.stateDatabase("could not create fixture schema")
  }
}

private func writeStartedRollout(
  at url: URL,
  marker: String,
  turnId: String = "turn-1"
) throws {
  let records: [[String: Any]] = [
    [
      "type": "event_msg",
      "payload": ["type": "task_started", "turn_id": turnId],
    ],
    ["type": "turn_context", "payload": ["turn_id": turnId]],
    [
      "type": "response_item",
      "payload": [
        "type": "message",
        "role": "user",
        "content": [["type": "input_text", "text": "prompt \(marker)"]],
      ],
    ],
  ]
  let lines = try records.map { record in
    let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    guard let line = String(data: data, encoding: .utf8) else {
      throw TestFailure("could not encode rollout fixture")
    }
    return line
  }
  try (lines.joined(separator: "\n") + "\n").write(
    to: url,
    atomically: true,
    encoding: .utf8
  )
}

private func sqlQuote(_ value: String) -> String {
  value.replacingOccurrences(of: "'", with: "''")
}

private struct TestFailure: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

private func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  guard condition() else { throw TestFailure(message) }
}

private func expectAnyError(_ operation: () throws -> Any) throws {
  do {
    _ = try operation()
    throw TestFailure("expected an error")
  } catch is TestFailure {
    throw TestFailure("expected a production error")
  } catch {
    return
  }
}

private func expectError<T>(
  _ expected: DesktopBridgeError,
  _ operation: () throws -> T
) throws {
  do {
    _ = try operation()
    throw TestFailure("expected \(expected)")
  } catch let error as DesktopBridgeError {
    try check(error == expected, "expected \(expected), got \(error)")
  }
}

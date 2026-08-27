import AppKit
import ApplicationServices
import Foundation

public struct MacDesktopURLLauncher: DesktopURLLaunching {
  private let workspace: NSWorkspace

  public init(workspace: NSWorkspace = .shared) {
    self.workspace = workspace
  }

  public func open(_ url: URL) throws {
    guard workspace.open(url) else {
      throw DesktopBridgeError.launchFailed("NSWorkspace refused the Codex Desktop URL")
    }
  }
}

public final class MacFrontmostApplicationManager: FrontmostApplicationManaging {
  private let bundleIdentifier: String
  private let clock: DesktopBridgeClock
  private let pollMilliseconds: Int

  public init(
    bundleIdentifier: String = "com.openai.codex",
    clock: DesktopBridgeClock = SystemDesktopBridgeClock(),
    pollMilliseconds: Int = 50
  ) {
    self.bundleIdentifier = bundleIdentifier
    self.clock = clock
    self.pollMilliseconds = max(1, pollMilliseconds)
  }

  public func captureFrontmostProcessIdentifier() -> pid_t? {
    focusedApplicationProcessIdentifier()
      ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
  }

  public func activateCodexDesktop(timeoutMilliseconds: Int) throws {
    let deadline = clock.nowMilliseconds() + Int64(max(1, timeoutMilliseconds))
    var activationRequestedForProcess: pid_t?

    while clock.nowMilliseconds() <= deadline {
      if let application = NSRunningApplication.runningApplications(
        withBundleIdentifier: bundleIdentifier
      ).first(where: { !$0.isTerminated }) {
        if focusedApplicationProcessIdentifier() == application.processIdentifier
        {
          return
        }
        if activationRequestedForProcess != application.processIdentifier {
          guard application.activate(options: [.activateIgnoringOtherApps]) else {
            throw DesktopBridgeError.accessibilityUnavailable(
              "Codex Desktop refused to become frontmost for the verified Send action"
            )
          }
          activationRequestedForProcess = application.processIdentifier
        }
      }

      let remaining = deadline - clock.nowMilliseconds()
      if remaining <= 0 { break }
      clock.sleep(milliseconds: min(pollMilliseconds, Int(clamping: remaining)))
    }
    throw DesktopBridgeError.accessibilityUnavailable(
      "Codex Desktop did not become frontmost for the verified Send action"
    )
  }

  public func restoreFrontmostApplication(processIdentifier: pid_t) {
    guard let application = NSRunningApplication(processIdentifier: processIdentifier),
      !application.isTerminated
    else { return }
    application.activate(options: [.activateIgnoringOtherApps])
  }
}

public final class MacCodexAccessibilitySubmitter: DesktopAccessibilitySubmitting {
  private let bundleIdentifier: String
  private let clock: DesktopBridgeClock
  private let pollMilliseconds: Int
  private let maximumTreeElements: Int

  public init(
    bundleIdentifier: String = "com.openai.codex",
    clock: DesktopBridgeClock = SystemDesktopBridgeClock(),
    pollMilliseconds: Int = 100,
    maximumTreeElements: Int = 5_000
  ) {
    self.bundleIdentifier = bundleIdentifier
    self.clock = clock
    self.pollMilliseconds = max(1, pollMilliseconds)
    self.maximumTreeElements = max(100, maximumTreeElements)
  }

  public func preflight() throws {
    guard AXIsProcessTrusted() else {
      throw DesktopBridgeError.accessibilityUnavailable(
        "Accessibility permission is not granted to the Codex Desktop helper"
      )
    }
    try assertInteractiveSession()
  }

  public func submit(
    marker: String,
    timeoutMilliseconds: Int,
    beforeSendActivation: () throws -> Void
  ) throws {
    guard isValidWakeWireMarker(marker) else {
      throw DesktopBridgeError.invalidRequest("invalid WakeWire correlation marker")
    }
    let deadline = clock.nowMilliseconds() + Int64(timeoutMilliseconds)
    while clock.nowMilliseconds() <= deadline {
      try assertInteractiveSession()
      if let application = NSRunningApplication.runningApplications(
        withBundleIdentifier: bundleIdentifier
      ).first(where: { !$0.isTerminated }) {
        let root = AXUIElementCreateApplication(application.processIdentifier)
        let elements = try accessibilityTree(root: root)
        try refuseModal(elements)

        let composers = elements.filter { element in
          guard isEditable(element), let value = stringAttribute(element, kAXValueAttribute)
          else { return false }
          return value.contains(marker)
        }
        if composers.count > 1 { throw DesktopBridgeError.composerAmbiguous }
        if let composer = composers.first {
          guard let window = owningWindow(for: composer) else {
            throw DesktopBridgeError.accessibilityUnavailable(
              "marked Codex Desktop composer has no owning window"
            )
          }
          let windowElements = try accessibilityTree(root: window)
          try refuseModal(windowElements)
          let sendButtons = sendButtonCandidates(for: composer)
          guard !sendButtons.isEmpty else {
            throw DesktopBridgeError.sendButtonNotFound
          }
          guard sendButtons.count == 1 else {
            throw DesktopBridgeError.sendButtonAmbiguous
          }
          guard boolAttribute(sendButtons[0], kAXEnabledAttribute) != false else {
            throw DesktopBridgeError.sendButtonDisabled
          }
          guard stringAttribute(composer, kAXValueAttribute)?.contains(marker) == true else {
            throw DesktopBridgeError.markerChanged
          }
          try assertInteractiveSession()
          try refuseModal(try accessibilityTree(root: root))
          let revalidatedButtons = sendButtonCandidates(for: composer)
          guard revalidatedButtons.count == 1,
            CFEqual(revalidatedButtons[0], sendButtons[0])
          else { throw DesktopBridgeError.sendButtonNotFound }
          guard actionNames(revalidatedButtons[0])?.contains(kAXPressAction) == true else {
            throw DesktopBridgeError.sendButtonNotFound
          }
          if focusedApplicationProcessIdentifier() != application.processIdentifier
          {
            guard application.activate(options: [.activateIgnoringOtherApps]) else {
              throw DesktopBridgeError.accessibilityUnavailable(
                "Codex Desktop refused to become frontmost for its verified Send control"
              )
            }
            let focusDeadline = min(deadline, clock.nowMilliseconds() + 1_000)
            while clock.nowMilliseconds() <= focusDeadline,
              focusedApplicationProcessIdentifier() != application.processIdentifier
            {
              let remaining = focusDeadline - clock.nowMilliseconds()
              if remaining <= 0 { break }
              clock.sleep(milliseconds: min(pollMilliseconds, Int(clamping: remaining)))
            }
            guard focusedApplicationProcessIdentifier() == application.processIdentifier
            else {
              throw DesktopBridgeError.accessibilityUnavailable(
                "Codex Desktop did not become frontmost for its verified Send control"
              )
            }
            // Activation can rebuild Electron's accessibility tree. Restart
            // discovery so the marked composer and unique control are
            // revalidated from the newly focused window before any click.
            continue
          }
          // Electron 39 can advertise a successful AXPress for a labeled
          // button without dispatching the DOM click. Use one guarded physical
          // click for both labeled and geometry-verified unlabeled controls.
          // There is deliberately no AXPress-then-click fallback: only one
          // non-idempotent Send action is attempted behind the durable barrier.
          try clickVerifiedSendButton(
            revalidatedButtons[0],
            beforeSendActivation: beforeSendActivation
          )
          try waitForMarkedComposerToClear(
            root: root,
            marker: marker,
            deadlineMilliseconds: min(deadline, clock.nowMilliseconds() + 2_000)
          )
          return
        }
      }
      let remaining = deadline - clock.nowMilliseconds()
      if remaining <= 0 { break }
      clock.sleep(milliseconds: min(pollMilliseconds, Int(clamping: remaining)))
    }
    throw DesktopBridgeError.composerNotFound
  }

  private func accessibilityTree(root: AXUIElement) throws -> [AXUIElement] {
    var result: [AXUIElement] = []
    var pending: [AXUIElement] = [root]
    while let element = pending.popLast() {
      result.append(element)
      guard result.count <= maximumTreeElements else {
        throw DesktopBridgeError.accessibilityUnavailable(
          "Codex Desktop accessibility tree exceeded the safety limit"
        )
      }
      if let children = elementArrayAttribute(element, kAXChildrenAttribute) {
        pending.append(contentsOf: children)
      }
    }
    return result
  }

  private func refuseModal(_ elements: [AXUIElement]) throws {
    for element in elements {
      let role = stringAttribute(element, kAXRoleAttribute)
      let subrole = stringAttribute(element, kAXSubroleAttribute)
      if role == kAXSheetRole || subrole == kAXDialogSubrole {
        throw DesktopBridgeError.modalPresent
      }
      if role == kAXWindowRole, boolAttribute(element, kAXModalAttribute) == true {
        throw DesktopBridgeError.modalPresent
      }
    }
  }

  private func isEditable(_ element: AXUIElement) -> Bool {
    let role = stringAttribute(element, kAXRoleAttribute)
    return role == kAXTextAreaRole || role == kAXTextFieldRole || role == kAXComboBoxRole
  }

  private func isStrictSendButton(_ element: AXUIElement) -> Bool {
    guard stringAttribute(element, kAXRoleAttribute) == kAXButtonRole else { return false }
    let attributes = [
      kAXTitleAttribute,
      kAXDescriptionAttribute,
      kAXHelpAttribute,
      kAXIdentifierAttribute,
    ]
    return attributes.compactMap { stringAttribute(element, $0) }.contains(where: isSendLabel)
  }

  /**
   * Codex has exposed the composer arrow as both labeled and unlabeled AXButtons.
   * Keep the compatibility path scoped to the marker-bearing composer: only
   * the nearest ancestor's direct controls are considered, and an unlabeled
   * fallback must be the unique enabled AXPress control at the bottom-right of
   * the composer. We deliberately never click an arbitrary window button or
   * synthesize Return.
   */
  private func sendButtonCandidates(for composer: AXUIElement) -> [AXUIElement] {
    guard let composerFrame = rectAttribute(composer) else { return [] }
    var current: AXUIElement? = composer
    for _ in 0..<12 {
      guard let child = current,
        let parent = elementAttribute(child, kAXParentAttribute),
        let parentFrame = rectAttribute(parent)
      else { return [] }
      guard stringAttribute(parent, kAXRoleAttribute) == kAXGroupRole else {
        current = parent
        continue
      }
      let directButtons = (elementArrayAttribute(parent, kAXChildrenAttribute) ?? []).filter {
        stringAttribute($0, kAXRoleAttribute) == kAXButtonRole
      }
      if !directButtons.isEmpty {
        let buttonFrames = directButtons.compactMap { rectAttribute($0) }
        guard let rightmostButtonMaxX = buttonFrames.map(\.maxX).max() else { return [] }
        let labeled = directButtons.filter { button in
          isStrictSendButton(button)
            && isComposerSubmitGeometryCandidate(
              subrole: stringAttribute(button, kAXSubroleAttribute),
              enabled: boolAttribute(button, kAXEnabledAttribute),
              supportsPress: actionNames(button)?.contains(kAXPressAction) == true,
              buttonFrame: rectAttribute(button),
              composerFrame: composerFrame,
              controlFrame: parentFrame,
              rightmostButtonMaxX: rightmostButtonMaxX
            )
        }
        if !labeled.isEmpty { return labeled }
        let unlabeled = directButtons.filter { button in
          let attributes = [
            kAXTitleAttribute,
            kAXDescriptionAttribute,
            kAXHelpAttribute,
            kAXIdentifierAttribute,
          ]
          return isUnlabeledComposerSubmitCandidate(
            labels: attributes.compactMap { stringAttribute(button, $0) },
            subrole: stringAttribute(button, kAXSubroleAttribute),
            enabled: boolAttribute(button, kAXEnabledAttribute),
            supportsPress: actionNames(button)?.contains(kAXPressAction) == true,
            buttonFrame: rectAttribute(button),
            composerFrame: composerFrame,
            controlFrame: parentFrame,
            rightmostButtonMaxX: rightmostButtonMaxX
          )
        }
        // The first ancestor group with direct buttons is the composer's
        // control strip. Never broaden an unsuccessful match to outer UI.
        return unlabeled
      }
      current = parent
    }
    return []
  }

  private func clickVerifiedSendButton(
    _ button: AXUIElement,
    beforeSendActivation: () throws -> Void
  ) throws {
    guard let frame = rectAttribute(button) else {
      throw DesktopBridgeError.sendButtonNotFound
    }
    let target = CGPoint(x: frame.midX, y: frame.midY)
    guard let eventSource = CGEventSource(stateID: .combinedSessionState),
      let originalPointer = CGEvent(source: eventSource)?.location,
      let mouseDown = CGEvent(
        mouseEventSource: eventSource,
        mouseType: .leftMouseDown,
        mouseCursorPosition: target,
        mouseButton: .left
      ),
      let mouseUp = CGEvent(
        mouseEventSource: eventSource,
        mouseType: .leftMouseUp,
        mouseCursorPosition: target,
        mouseButton: .left
      )
    else {
      throw DesktopBridgeError.accessibilityUnavailable(
        "could not construct a verified mouse click for Codex Desktop Send"
      )
    }
    try beforeSendActivation()
    mouseDown.post(tap: .cghidEventTap)
    clock.sleep(milliseconds: 20)
    mouseUp.post(tap: .cghidEventTap)
    clock.sleep(milliseconds: 20)

    // Restore the pointer only if it is still at our click target. If the user
    // moved it during activation, their movement wins.
    if let currentPointer = CGEvent(source: eventSource)?.location,
      abs(currentPointer.x - target.x) <= 1,
      abs(currentPointer.y - target.y) <= 1,
      let restore = CGEvent(
        mouseEventSource: eventSource,
        mouseType: .mouseMoved,
        mouseCursorPosition: originalPointer,
        mouseButton: .left
      )
    {
      restore.post(tap: .cghidEventTap)
    }
  }

  private func waitForMarkedComposerToClear(
    root: AXUIElement,
    marker: String,
    deadlineMilliseconds: Int64
  ) throws {
    while clock.nowMilliseconds() <= deadlineMilliseconds {
      let elements = try accessibilityTree(root: root)
      try refuseModal(elements)
      let marked = elements.filter { element in
        guard isEditable(element), let value = stringAttribute(element, kAXValueAttribute)
        else { return false }
        return value.contains(marker)
      }
      if marked.isEmpty { return }
      if marked.count > 1 { throw DesktopBridgeError.composerAmbiguous }
      let remaining = deadlineMilliseconds - clock.nowMilliseconds()
      if remaining <= 0 { break }
      clock.sleep(milliseconds: min(pollMilliseconds, Int(clamping: remaining)))
    }
    throw DesktopBridgeError.sendButtonDidNotSubmit
  }

  private func owningWindow(for element: AXUIElement) -> AXUIElement? {
    var current: AXUIElement? = element
    for _ in 0..<32 {
      guard let candidate = current else { return nil }
      if stringAttribute(candidate, kAXRoleAttribute) == kAXWindowRole {
        return candidate
      }
      current = elementAttribute(candidate, kAXParentAttribute)
    }
    return nil
  }
}

/**
 * Deliberately narrow Accessibility adapter for Codex's native Rename chat flow.
 * It never searches for a generic text field or generic button: the exact
 * Rename chat/task heading, one title input, one Save button, and one Cancel
 * button must all belong to the same smallest accessibility subtree.
 */
public final class MacCodexAccessibilityRenamer: DesktopAccessibilityRenaming {
  private let bundleIdentifier: String
  private let clock: DesktopBridgeClock
  private let pollMilliseconds: Int
  private let maximumTreeElements: Int
  private let activationSettleMilliseconds: Int

  public init(
    bundleIdentifier: String = "com.openai.codex",
    clock: DesktopBridgeClock = SystemDesktopBridgeClock(),
    pollMilliseconds: Int = 100,
    maximumTreeElements: Int = 5_000,
    activationSettleMilliseconds: Int = 300
  ) {
    self.bundleIdentifier = bundleIdentifier
    self.clock = clock
    self.pollMilliseconds = max(1, pollMilliseconds)
    self.maximumTreeElements = max(100, maximumTreeElements)
    self.activationSettleMilliseconds = max(0, activationSettleMilliseconds)
  }

  public func preflight() throws {
    guard AXIsProcessTrusted() else {
      throw DesktopBridgeError.accessibilityUnavailable(
        "Accessibility permission is not granted to the Codex Desktop helper"
      )
    }
    try assertInteractiveSession()
  }

  public func rename(threadId: String, title: String, timeoutMilliseconds: Int) throws {
    let request = DesktopRenameRequest(
      threadId: threadId,
      title: title,
      uiTimeoutMilliseconds: timeoutMilliseconds
    )
    try request.validate()
    let deadline = clock.nowMilliseconds() + Int64(timeoutMilliseconds)

    let application = try waitForCodexApplication(deadlineMilliseconds: deadline)
    application.activate(options: [.activateIgnoringOtherApps])
    let (root, window) = try waitForSettledFocusedWindow(
      application: application,
      deadlineMilliseconds: deadline
    )
    try waitForExactActiveThreadIdentifier(
      threadId,
      root: root,
      window: window,
      application: application,
      deadlineMilliseconds: deadline
    )

    try assertInteractiveSession()
    guard focusedApplicationProcessIdentifier() == application.processIdentifier
    else {
      throw DesktopBridgeError.threadActivationFailed(
        "Codex Desktop lost focus before the Rename chat shortcut"
      )
    }
    let existingDialogs = try renameDialogs(root: root)
    if existingDialogs.count > 1 { throw DesktopBridgeError.renameDialogAmbiguous }
    // A pre-existing dialog is not owned by this invocation and cannot be
    // safely bound to the requested task, even when its text happens to match.
    if !existingDialogs.isEmpty { throw DesktopBridgeError.modalPresent }
    try refuseAnyModal(try accessibilityTree(root: root))
    try postRenameShortcut(root: root, window: window, application: application)

    do {
      var dialog = try waitForRenameDialog(root: root, deadlineMilliseconds: deadline)
      if stringAttribute(dialog.input, kAXValueAttribute) == title {
        try clickSaveAndWaitWithCleanup(
          in: dialog,
          root: root,
          window: window,
          application: application,
          title: title,
          deadlineMilliseconds: deadline
        )
        return
      }
      dialog = try typeExactTitle(
        title,
        in: dialog,
        root: root,
        application: application,
        deadlineMilliseconds: deadline
      )

      // Re-read the complete dialog before the non-idempotent Save press.
      let revalidated = try renameDialogs(root: root)
      guard revalidated.count == 1 else {
        throw revalidated.isEmpty
          ? DesktopBridgeError.renameTitleFieldUnavailable
          : DesktopBridgeError.renameDialogAmbiguous
      }
      guard CFEqual(revalidated[0].container, dialog.container),
        CFEqual(revalidated[0].input, dialog.input),
        stringAttribute(revalidated[0].input, kAXValueAttribute) == title
      else {
        throw DesktopBridgeError.renameTitleFieldUnavailable
      }
      dialog = revalidated[0]
      try clickSaveAndWaitWithCleanup(
        in: dialog,
        root: root,
        window: window,
        application: application,
        title: title,
        deadlineMilliseconds: deadline
      )
    } catch let operationError {
      do {
        try dismissExactRenameDialogIfPresent(root: root, application: application)
      } catch let cleanupError {
        throw cleanupError
      }
      throw operationError
    }
  }

  private func waitForCodexApplication(deadlineMilliseconds: Int64) throws
    -> NSRunningApplication
  {
    while clock.nowMilliseconds() <= deadlineMilliseconds {
      try assertInteractiveSession()
      let applications = NSRunningApplication.runningApplications(
        withBundleIdentifier: bundleIdentifier
      ).filter { !$0.isTerminated }
      if applications.count > 1 {
        throw DesktopBridgeError.applicationUnavailable(
          "multiple running Codex Desktop applications matched the bundle identifier"
        )
      }
      if let application = applications.first { return application }
      try poll(deadlineMilliseconds: deadlineMilliseconds)
    }
    throw DesktopBridgeError.applicationUnavailable(
      "Codex Desktop did not launch before the UI timeout"
    )
  }

  private func waitForSettledFocusedWindow(
    application: NSRunningApplication,
    deadlineMilliseconds: Int64
  ) throws -> (AXUIElement, AXUIElement) {
    let root = AXUIElementCreateApplication(application.processIdentifier)
    var stableWindow: AXUIElement?
    var stableActiveSidebarRow: AXUIElement?
    var stableSince: Int64?
    while clock.nowMilliseconds() <= deadlineMilliseconds {
      try assertInteractiveSession()
      guard focusedApplicationProcessIdentifier() == application.processIdentifier
      else {
        stableWindow = nil
        stableActiveSidebarRow = nil
        stableSince = nil
        try poll(deadlineMilliseconds: deadlineMilliseconds)
        continue
      }
      guard let window = elementAttribute(root, kAXFocusedWindowAttribute)
        ?? elementAttribute(root, kAXMainWindowAttribute)
      else {
        stableWindow = nil
        stableActiveSidebarRow = nil
        stableSince = nil
        try poll(deadlineMilliseconds: deadlineMilliseconds)
        continue
      }
      let modals = try modalContainers(root: root)
      if !modals.isEmpty { throw DesktopBridgeError.modalPresent }
      let activeRows = try activeSidebarRows(window: window)
      if activeRows.count > 1 {
        throw DesktopBridgeError.threadActivationFailed(
          "multiple Codex Desktop sidebar rows appeared active after the task deep link"
        )
      }
      guard let activeSidebarRow = activeRows.first else {
        stableWindow = nil
        stableActiveSidebarRow = nil
        stableSince = nil
        try poll(deadlineMilliseconds: deadlineMilliseconds)
        continue
      }
      if let previousWindow = stableWindow,
        let previousRow = stableActiveSidebarRow,
        CFEqual(previousWindow, window),
        CFEqual(previousRow, activeSidebarRow)
      {
        if let stableSince,
          clock.nowMilliseconds() - stableSince >= Int64(activationSettleMilliseconds)
        {
          // Version-pinned boundary: Codex exposes no task id through AX. The
          // exact deep link plus one stable, unchanged active-row class token
          // is therefore the strongest available identity evidence.
          return (root, window)
        }
      } else {
        stableWindow = window
        stableActiveSidebarRow = activeSidebarRow
        stableSince = clock.nowMilliseconds()
      }
      if activationSettleMilliseconds == 0 {
        return (root, window)
      }
      try poll(deadlineMilliseconds: deadlineMilliseconds)
    }
    throw DesktopBridgeError.threadActivationFailed(
      "the exact Codex task deep link did not settle into a focused Desktop window"
    )
  }

  private func waitForExactActiveThreadIdentifier(
    _ threadId: String,
    root: AXUIElement,
    window: AXUIElement,
    application: NSRunningApplication,
    deadlineMilliseconds: Int64
  ) throws {
    try withPreservedGeneralPasteboard { pasteboard, helperOwnedChangeCount in
      while clock.nowMilliseconds() <= deadlineMilliseconds {
        try assertCodexIsFrontmost(application)
        guard let focusedWindow = elementAttribute(root, kAXFocusedWindowAttribute),
          CFEqual(focusedWindow, window)
        else {
          throw DesktopBridgeError.threadActivationFailed(
            "Codex Desktop focused window changed before task identity verification"
          )
        }
        try refuseAnyModal(try accessibilityTree(root: root))
        guard pasteboard.changeCount == helperOwnedChangeCount else {
          throw DesktopBridgeError.threadActivationFailed(
            "the clipboard changed during Codex task identity verification"
          )
        }

        let beforeCopyChangeCount = helperOwnedChangeCount
        try postKey(
          virtualKey: 8,
          flags: [.maskCommand, .maskAlternate],
          processIdentifier: application.processIdentifier
        ) // ANSI C: Copy session ID

        let copyDeadline = min(
          deadlineMilliseconds,
          clock.nowMilliseconds() + 1_000
        )
        while clock.nowMilliseconds() <= copyDeadline,
          pasteboard.changeCount == beforeCopyChangeCount
        {
          try assertCodexIsFrontmost(application)
          try poll(deadlineMilliseconds: copyDeadline)
        }
        guard pasteboard.changeCount != beforeCopyChangeCount else {
          throw DesktopBridgeError.threadActivationFailed(
            "Codex Desktop did not copy its active session ID"
          )
        }
        helperOwnedChangeCount = pasteboard.changeCount

        let copiedIdentifier = pasteboard.string(forType: .string)?
          .trimmingCharacters(in: .whitespacesAndNewlines)
        if copiedIdentifier == threadId { return }
        guard let copiedIdentifier, isValidCodexThreadIdentifier(copiedIdentifier) else {
          throw DesktopBridgeError.threadActivationFailed(
            "Codex Desktop Copy session ID returned an invalid identifier"
          )
        }
        try poll(
          deadlineMilliseconds: min(
            deadlineMilliseconds,
            clock.nowMilliseconds() + 300
          )
        )
      }
      throw DesktopBridgeError.threadActivationFailed(
        "the exact Codex task deep link did not activate the requested session ID"
      )
    }
  }

  private func withPreservedGeneralPasteboard<T>(
    _ operation: (NSPasteboard, inout Int) throws -> T
  ) throws -> T {
    let pasteboard = NSPasteboard.general
    let snapshot = try capturePasteboard(pasteboard)
    var helperOwnedChangeCount = pasteboard.changeCount
    do {
      let result = try operation(pasteboard, &helperOwnedChangeCount)
      guard pasteboard.changeCount == helperOwnedChangeCount else {
        throw DesktopBridgeError.threadActivationFailed(
          "the clipboard changed during Codex task identity verification"
        )
      }
      try restorePasteboard(snapshot, to: pasteboard)
      return result
    } catch let operationError {
      if pasteboard.changeCount == helperOwnedChangeCount {
        do {
          try restorePasteboard(snapshot, to: pasteboard)
        } catch let restoreError {
          throw restoreError
        }
      }
      throw operationError
    }
  }

  private func capturePasteboard(_ pasteboard: NSPasteboard) throws -> PasteboardSnapshot {
    let maximumSnapshotBytes = 8 * 1_024 * 1_024
    var totalBytes = 0
    var capturedItems: [[NSPasteboard.PasteboardType: Data]] = []
    for item in pasteboard.pasteboardItems ?? [] {
      var captured: [NSPasteboard.PasteboardType: Data] = [:]
      for type in item.types {
        guard let data = item.data(forType: type) else {
          throw DesktopBridgeError.threadActivationFailed(
            "the clipboard contains data that cannot be preserved safely"
          )
        }
        totalBytes += data.count
        guard totalBytes <= maximumSnapshotBytes else {
          throw DesktopBridgeError.threadActivationFailed(
            "the clipboard is too large to preserve safely"
          )
        }
        captured[type] = data
      }
      guard !captured.isEmpty else {
        throw DesktopBridgeError.threadActivationFailed(
          "the clipboard contains an item that cannot be preserved safely"
        )
      }
      capturedItems.append(captured)
    }
    return PasteboardSnapshot(items: capturedItems)
  }

  private func restorePasteboard(
    _ snapshot: PasteboardSnapshot,
    to pasteboard: NSPasteboard
  ) throws {
    pasteboard.clearContents()
    if snapshot.items.isEmpty { return }
    let restoredItems = snapshot.items.map { captured -> NSPasteboardItem in
      let item = NSPasteboardItem()
      for (type, data) in captured {
        item.setData(data, forType: type)
      }
      return item
    }
    guard pasteboard.writeObjects(restoredItems) else {
      throw DesktopBridgeError.threadActivationFailed(
        "Codex task identity verification could not restore the clipboard"
      )
    }
  }

  private func postRenameShortcut(
    root: AXUIElement,
    window: AXUIElement,
    application: NSRunningApplication
  ) throws {
    try assertCodexIsFrontmost(application)
    guard let focusedWindow = elementAttribute(root, kAXFocusedWindowAttribute),
      CFEqual(focusedWindow, window)
    else {
      throw DesktopBridgeError.threadActivationFailed(
        "Codex Desktop focused window changed before the Rename chat shortcut"
      )
    }
    try postKey(
      virtualKey: 15,
      flags: [.maskCommand, .maskAlternate],
      processIdentifier: application.processIdentifier
    )
  }

  private func waitForRenameDialog(
    root: AXUIElement,
    deadlineMilliseconds: Int64
  ) throws -> RenameDialogElements {
    let constructionSettleMilliseconds: Int64 = 1_000
    var incompleteDialogFirstSeenAt: Int64?
    while clock.nowMilliseconds() <= deadlineMilliseconds {
      try assertInteractiveSession()
      let dialogs = try renameDialogs(root: root)
      if dialogs.count > 1 { throw DesktopBridgeError.renameDialogAmbiguous }
      if let dialog = dialogs.first { return dialog }
      let modals = try modalContainers(root: root)
      if modals.isEmpty {
        incompleteDialogFirstSeenAt = nil
      } else {
        guard modals.count == 1 else {
          throw DesktopBridgeError.renameDialogUnexpected
        }
        let modal = modals[0]
        let staticTextValues: [String] = try accessibilityTree(root: modal).compactMap {
          element -> String? in
          guard stringAttribute(element, kAXRoleAttribute) == kAXStaticTextRole else {
            return nil
          }
          return stringAttribute(element, kAXValueAttribute)
        }
        guard isCodexPotentialRenameDialogContainer(
          role: stringAttribute(modal, kAXRoleAttribute),
          subrole: stringAttribute(modal, kAXSubroleAttribute),
          staticTextValues: staticTextValues
        ) else {
          throw DesktopBridgeError.renameDialogUnexpected
        }
        let now = clock.nowMilliseconds()
        if let firstSeenAt = incompleteDialogFirstSeenAt {
          if now - firstSeenAt >= constructionSettleMilliseconds {
            throw DesktopBridgeError.renameDialogUnexpected
          }
        } else {
          incompleteDialogFirstSeenAt = now
        }
      }
      try poll(deadlineMilliseconds: deadlineMilliseconds)
    }
    throw DesktopBridgeError.renameDialogNotFound
  }

  private func typeExactTitle(
    _ title: String,
    in dialog: RenameDialogElements,
    root: AXUIElement,
    application: NSRunningApplication,
    deadlineMilliseconds: Int64
  ) throws -> RenameDialogElements {
    guard boolAttribute(dialog.input, kAXEnabledAttribute) != false else {
      throw DesktopBridgeError.renameTitleFieldUnavailable
    }
    let focusResult = AXUIElementSetAttributeValue(
      dialog.input,
      kAXFocusedAttribute as CFString,
      kCFBooleanTrue
    )
    guard focusResult == .success || boolAttribute(dialog.input, kAXFocusedAttribute) == true else {
      throw DesktopBridgeError.renameTitleFieldUnavailable
    }

    var focusedDialog = dialog
    var lastObservedValue = stringAttribute(focusedDialog.input, kAXValueAttribute) ?? ""
    var lastObservedFocused = boolAttribute(focusedDialog.input, kAXFocusedAttribute)
    while clock.nowMilliseconds() <= deadlineMilliseconds {
      try assertCodexIsFrontmost(application)
      let dialogs = try renameDialogs(root: root)
      if dialogs.count > 1 { throw DesktopBridgeError.renameDialogAmbiguous }
      guard let candidate = dialogs.first,
        CFEqual(candidate.container, dialog.container),
        CFEqual(candidate.input, dialog.input)
      else {
        throw DesktopBridgeError.renameTitleFieldUnavailable
      }
      focusedDialog = candidate
      if boolAttribute(candidate.input, kAXFocusedAttribute) == true { break }
      try poll(deadlineMilliseconds: deadlineMilliseconds)
    }
    guard boolAttribute(focusedDialog.input, kAXFocusedAttribute) == true else {
      throw DesktopBridgeError.renameTitleFieldUnavailable
    }

    let sentinelValue = codexRenameSentinelValue(title)
    let setResult = AXUIElementSetAttributeValue(
      focusedDialog.input,
      kAXValueAttribute as CFString,
      sentinelValue as CFString
    )
    guard setResult == .success else {
      throw DesktopBridgeError.renameTitleFieldUnavailable
    }

    var sentinelObserved = false
    while clock.nowMilliseconds() <= deadlineMilliseconds {
      try assertCodexIsFrontmost(application)
      let dialogs = try renameDialogs(root: root)
      if dialogs.count > 1 { throw DesktopBridgeError.renameDialogAmbiguous }
      guard let candidate = dialogs.first,
        CFEqual(candidate.container, dialog.container),
        CFEqual(candidate.input, dialog.input),
        boolAttribute(candidate.input, kAXFocusedAttribute) == true
      else {
        throw DesktopBridgeError.renameTitleFieldUnavailable
      }
      if stringAttribute(candidate.input, kAXValueAttribute) == sentinelValue {
        focusedDialog = candidate
        sentinelObserved = true
        break
      }
      try poll(deadlineMilliseconds: deadlineMilliseconds)
    }
    guard sentinelObserved else {
      throw DesktopBridgeError.renameTitleFieldUnavailable
    }

    // AXValue alone bypasses Chromium/React's input event. Removing a known
    // trailing sentinel with a real Backspace makes the exact desired value a
    // genuine user-edit event without placing sensitive titles on the clipboard.
    try assertSameFocusedRenameDialog(root: root, expected: focusedDialog)
    try postKey(
      virtualKey: 51,
      processIdentifier: application.processIdentifier
    ) // Delete backward

    while clock.nowMilliseconds() <= deadlineMilliseconds {
      try assertCodexIsFrontmost(application)
      let dialogs = try renameDialogs(root: root)
      if dialogs.count > 1 { throw DesktopBridgeError.renameDialogAmbiguous }
      guard let candidate = dialogs.first,
        CFEqual(candidate.container, dialog.container),
        CFEqual(candidate.input, dialog.input),
        boolAttribute(candidate.input, kAXFocusedAttribute) == true
      else {
        throw DesktopBridgeError.renameTitleFieldUnavailable
      }
      lastObservedValue = stringAttribute(candidate.input, kAXValueAttribute) ?? ""
      lastObservedFocused = boolAttribute(candidate.input, kAXFocusedAttribute)
      if lastObservedValue == title { return candidate }
      try poll(deadlineMilliseconds: deadlineMilliseconds)
    }
    throw DesktopBridgeError.renameTitleDidNotUpdate(
      observedCodePoints: lastObservedValue.unicodeScalars.count,
      expectedCodePoints: title.unicodeScalars.count,
      focused: lastObservedFocused
    )
  }

  private func assertSameFocusedRenameDialog(
    root: AXUIElement,
    expected: RenameDialogElements
  ) throws {
    let dialogs = try renameDialogs(root: root)
    guard dialogs.count == 1,
      CFEqual(dialogs[0].container, expected.container),
      CFEqual(dialogs[0].input, expected.input),
      boolAttribute(dialogs[0].input, kAXFocusedAttribute) == true
    else {
      throw DesktopBridgeError.renameTitleFieldUnavailable
    }
  }

  private func postKey(
    virtualKey: CGKeyCode,
    flags: CGEventFlags = [],
    processIdentifier: pid_t
  ) throws {
    guard let source = CGEventSource(stateID: .combinedSessionState),
      let keyDown = CGEvent(
        keyboardEventSource: source,
        virtualKey: virtualKey,
        keyDown: true
      ), let keyUp = CGEvent(
        keyboardEventSource: source,
        virtualKey: virtualKey,
        keyDown: false
      )
    else {
      throw DesktopBridgeError.accessibilityUnavailable(
        "could not construct verified Codex Desktop keyboard events"
      )
    }
    keyDown.flags = flags
    keyUp.flags = flags
    keyDown.postToPid(processIdentifier)
    clock.sleep(milliseconds: 20)
    keyUp.postToPid(processIdentifier)
  }

  private func clickSave(
    in dialog: RenameDialogElements,
    root: AXUIElement,
    window: AXUIElement,
    application: NSRunningApplication
  ) throws {
    try assertCodexIsFrontmost(application)

    if boolAttribute(dialog.input, kAXFocusedAttribute) != true {
      let focusResult = AXUIElementSetAttributeValue(
        dialog.input,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
      )
      guard focusResult == .success,
        boolAttribute(dialog.input, kAXFocusedAttribute) == true
      else {
        throw DesktopBridgeError.renameTitleFieldUnavailable
      }
    }

    let dialogs = try renameDialogs(root: root)
    guard dialogs.count == 1,
      CFEqual(dialogs[0].container, dialog.container),
      CFEqual(dialogs[0].save, dialog.save),
      isExactButton(dialogs[0].save, label: isCodexRenameSaveLabel),
      boolAttribute(dialogs[0].save, kAXEnabledAttribute) == true,
      let buttonFrame = rectAttribute(dialogs[0].save),
      let dialogFrame = rectAttribute(dialogs[0].container),
      let windowFrame = rectAttribute(window),
      let dialogWindow = owningWindow(for: dialogs[0].container),
      CFEqual(dialogWindow, window),
      (24...240).contains(buttonFrame.width),
      (18...80).contains(buttonFrame.height),
      dialogFrame.contains(CGPoint(x: buttonFrame.midX, y: buttonFrame.midY)),
      windowFrame.contains(CGPoint(x: buttonFrame.midX, y: buttonFrame.midY))
    else {
      throw DesktopBridgeError.renameSaveButtonUnavailable
    }

    let target = CGPoint(x: buttonFrame.midX, y: buttonFrame.midY)
    guard let eventSource = CGEventSource(stateID: .combinedSessionState),
      let originalPointer = CGEvent(source: eventSource)?.location,
      let mouseMove = CGEvent(
        mouseEventSource: eventSource,
        mouseType: .mouseMoved,
        mouseCursorPosition: target,
        mouseButton: .left
      ),
      let mouseDown = CGEvent(
        mouseEventSource: eventSource,
        mouseType: .leftMouseDown,
        mouseCursorPosition: target,
        mouseButton: .left
      ),
      let mouseUp = CGEvent(
        mouseEventSource: eventSource,
        mouseType: .leftMouseUp,
        mouseCursorPosition: target,
        mouseButton: .left
      )
    else {
      throw DesktopBridgeError.renameSaveButtonUnavailable
    }

    // Chromium hit-tests PID-scoped mouse events at the real pointer location.
    // Move only the pointer globally, then keep the non-idempotent click bound
    // to Codex's PID. If the user moves the pointer, abort without clicking and
    // leave their movement in place.
    mouseMove.post(tap: .cghidEventTap)
    clock.sleep(milliseconds: 20)
    defer {
      if let currentPointer = CGEvent(source: eventSource)?.location,
        abs(currentPointer.x - target.x) <= 1,
        abs(currentPointer.y - target.y) <= 1,
        let restore = CGEvent(
          mouseEventSource: eventSource,
          mouseType: .mouseMoved,
          mouseCursorPosition: originalPointer,
          mouseButton: .left
        )
      {
        restore.post(tap: .cghidEventTap)
      }
    }

    // Revalidate the focused window, exact dialog, input, and button after
    // event construction so a user navigation race cannot redirect the click.
    try assertCodexIsFrontmost(application)
    guard let focusedWindow = elementAttribute(root, kAXFocusedWindowAttribute),
      CFEqual(focusedWindow, window)
    else {
      throw DesktopBridgeError.renameSaveButtonUnavailable
    }
    let finalDialogs = try renameDialogs(root: root)
    guard finalDialogs.count == 1,
      CFEqual(finalDialogs[0].container, dialog.container),
      CFEqual(finalDialogs[0].input, dialog.input),
      CFEqual(finalDialogs[0].save, dialog.save),
      rectAttribute(finalDialogs[0].save) == buttonFrame,
      boolAttribute(finalDialogs[0].input, kAXFocusedAttribute) == true,
      boolAttribute(finalDialogs[0].save, kAXEnabledAttribute) == true
    else {
      throw DesktopBridgeError.renameSaveButtonUnavailable
    }

    try assertCodexIsFrontmost(application)
    guard let finalFocusedWindow = elementAttribute(root, kAXFocusedWindowAttribute),
      CFEqual(finalFocusedWindow, window),
      let finalPointer = CGEvent(source: eventSource)?.location,
      abs(finalPointer.x - target.x) <= 1,
      abs(finalPointer.y - target.y) <= 1
    else {
      throw DesktopBridgeError.renameSaveButtonUnavailable
    }
    mouseDown.postToPid(application.processIdentifier)
    clock.sleep(milliseconds: 20)
    mouseUp.postToPid(application.processIdentifier)
    clock.sleep(milliseconds: 20)
  }

  private func clickSaveAndWaitWithCleanup(
    in dialog: RenameDialogElements,
    root: AXUIElement,
    window: AXUIElement,
    application: NSRunningApplication,
    title: String,
    deadlineMilliseconds: Int64
  ) throws {
    do {
      try clickSave(
        in: dialog,
        root: root,
        window: window,
        application: application
      )
      try waitForRenameCompletion(
        root: root,
        window: window,
        title: title,
        deadlineMilliseconds: deadlineMilliseconds
      )
    } catch let operationError {
      // Never strand the user's Desktop behind a helper-owned rename dialog.
      do {
        try dismissExactRenameDialogIfPresent(root: root, application: application)
      } catch let cleanupError {
        throw cleanupError
      }
      throw operationError
    }
  }

  private func assertCodexIsFrontmost(_ application: NSRunningApplication) throws {
    try assertInteractiveSession()
    guard focusedApplicationProcessIdentifier() == application.processIdentifier
    else {
      throw DesktopBridgeError.threadActivationFailed(
        "Codex Desktop lost focus during the Rename chat operation"
      )
    }
  }

  private func dismissExactRenameDialogIfPresent(
    root: AXUIElement,
    application: NSRunningApplication
  ) throws {
    let dialogs = try renameDialogs(root: root)
    guard dialogs.count <= 1 else { throw DesktopBridgeError.renameDialogAmbiguous }
    guard let dialog = dialogs.first else { return }
    let deadline = clock.nowMilliseconds() + 1_500
    try assertCodexIsFrontmost(application)
    let revalidated = try renameDialogs(root: root)
    guard revalidated.count == 1,
      CFEqual(revalidated[0].container, dialog.container),
      CFEqual(revalidated[0].input, dialog.input)
    else {
      throw DesktopBridgeError.renameDialogDismissFailed
    }
    try postKey(virtualKey: 53, processIdentifier: application.processIdentifier) // Escape
    while clock.nowMilliseconds() <= deadline {
      let remaining = try renameDialogs(root: root)
      if remaining.isEmpty { return }
      guard remaining.count == 1,
        CFEqual(remaining[0].container, dialog.container)
      else {
        throw DesktopBridgeError.renameDialogDismissFailed
      }
      try poll(deadlineMilliseconds: deadline)
    }
    throw DesktopBridgeError.renameDialogDismissFailed
  }

  private func waitForRenameCompletion(
    root: AXUIElement,
    window: AXUIElement,
    title: String,
    deadlineMilliseconds: Int64
  ) throws {
    var observedClosedDialog = false
    while clock.nowMilliseconds() <= deadlineMilliseconds {
      try assertInteractiveSession()
      let dialogs = try renameDialogs(root: root)
      if dialogs.count > 1 { throw DesktopBridgeError.renameDialogAmbiguous }
      if dialogs.isEmpty {
        observedClosedDialog = true
        if !(try modalContainers(root: root)).isEmpty {
          throw DesktopBridgeError.renameDialogUnexpected
        }
        if try exactTitleIsVisible(window: window, title: title) { return }
      }
      try poll(deadlineMilliseconds: deadlineMilliseconds)
    }
    if observedClosedDialog { throw DesktopBridgeError.renamedTitleNotVisible }
    throw DesktopBridgeError.renameDidNotComplete
  }

  private func exactTitleIsVisible(window: AXUIElement, title: String) throws -> Bool {
    guard let windowFrame = rectAttribute(window) else { return false }
    return try accessibilityTree(root: window).contains { element in
      isVisibleCodexThreadTitleCandidate(
        labels: accessibilityLabels(element),
        role: stringAttribute(element, kAXRoleAttribute),
        hidden: boolAttribute(element, kAXHiddenAttribute),
        selectedOrFocused: elementOrAncestorIsCurrent(element, stoppingAt: window),
        frame: rectAttribute(element),
        windowFrame: windowFrame,
        expectedTitle: title
      )
    }
  }

  private func activeSidebarRows(window: AXUIElement) throws -> [AXUIElement] {
    guard let windowFrame = rectAttribute(window) else {
      throw DesktopBridgeError.threadActivationFailed(
        "Codex Desktop focused window has no Accessibility frame"
      )
    }
    return try accessibilityTree(root: window).filter { element in
      isCodexActiveSidebarRowCandidate(
        domClassList: stringArrayAttribute(element, "AXDOMClassList") ?? [],
        role: stringAttribute(element, kAXRoleAttribute),
        frame: rectAttribute(element),
        windowFrame: windowFrame
      )
    }
  }

  private func renameDialogs(root: AXUIElement) throws -> [RenameDialogElements] {
    let allElements = try accessibilityTree(root: root)
    let inputs = allElements.filter(isEditableForRename)
    var matches: [RenameDialogElements] = []
    for input in inputs {
      var current = elementAttribute(input, kAXParentAttribute)
      for _ in 0..<16 {
        guard let container = current else { break }
        guard isCodexRenameDialogContainer(
          role: stringAttribute(container, kAXRoleAttribute),
          subrole: stringAttribute(container, kAXSubroleAttribute)
        ) else {
          if stringAttribute(container, kAXRoleAttribute) == kAXWindowRole { break }
          current = elementAttribute(container, kAXParentAttribute)
          continue
        }
        let elements = try accessibilityTree(root: container)
        let headings = elements.filter { element in
          isCodexRenameDialogHeading(
            role: stringAttribute(element, kAXRoleAttribute),
            value: stringAttribute(element, kAXValueAttribute)
          )
        }
        let forms = elements.filter { element in
          isCodexRenameFormLandmark(
            role: stringAttribute(element, kAXRoleAttribute),
            subrole: stringAttribute(element, kAXSubroleAttribute)
          )
        }
        guard headings.count == 1, forms.count == 1 else { break }
        let formElements = try accessibilityTree(root: forms[0])
        let editables = formElements.filter(isEditableForRename)
        let saves = formElements.filter { isExactButton($0, label: isCodexRenameSaveLabel) }
        let cancels = formElements.filter { isExactButton($0, label: isCodexRenameCancelLabel) }
        let inputHasKnownLabel = accessibilityLabels(input).contains(
          where: isCodexRenameTitleFieldLabel
        )
        if inputHasKnownLabel, editables.count == 1, CFEqual(editables[0], input),
          saves.count == 1,
          cancels.count == 1
        {
          if !matches.contains(where: { CFEqual($0.container, container) }) {
            matches.append(
              RenameDialogElements(
                container: container,
                input: input,
                save: saves[0],
                cancel: cancels[0]
              )
            )
          }
          break
        }
        if stringAttribute(container, kAXRoleAttribute) == kAXWindowRole { break }
        current = elementAttribute(container, kAXParentAttribute)
      }
    }
    return matches
  }

  private func modalContainers(root: AXUIElement) throws -> [AXUIElement] {
    try accessibilityTree(root: root).filter { element in
      isCodexModalAccessibilityElement(
        role: stringAttribute(element, kAXRoleAttribute),
        subrole: stringAttribute(element, kAXSubroleAttribute),
        modal: boolAttribute(element, kAXModalAttribute)
      )
    }
  }

  private func refuseAnyModal(_ elements: [AXUIElement]) throws {
    if elements.contains(where: { element in
      isCodexModalAccessibilityElement(
        role: stringAttribute(element, kAXRoleAttribute),
        subrole: stringAttribute(element, kAXSubroleAttribute),
        modal: boolAttribute(element, kAXModalAttribute)
      )
    }) {
      throw DesktopBridgeError.modalPresent
    }
  }

  private func isEditableForRename(_ element: AXUIElement) -> Bool {
    let role = stringAttribute(element, kAXRoleAttribute)
    return role == kAXTextFieldRole || role == kAXTextAreaRole
  }

  private func isExactButton(
    _ element: AXUIElement,
    label: (String) -> Bool
  ) -> Bool {
    stringAttribute(element, kAXRoleAttribute) == kAXButtonRole
      && accessibilityLabels(element).contains(where: label)
      && actionNames(element)?.contains(kAXPressAction) == true
  }

  private func accessibilityLabels(_ element: AXUIElement) -> [String] {
    [
      kAXTitleAttribute,
      kAXDescriptionAttribute,
      kAXHelpAttribute,
      kAXIdentifierAttribute,
      kAXValueAttribute,
    ].compactMap { stringAttribute(element, $0) }
  }

  private func elementOrAncestorIsCurrent(
    _ element: AXUIElement,
    stoppingAt window: AXUIElement
  ) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<16 {
      guard let candidate = current else { return false }
      if boolAttribute(candidate, kAXSelectedAttribute) == true
        || boolAttribute(candidate, kAXFocusedAttribute) == true
        || codexDOMClassListHasExactActiveSidebarToken(
          stringArrayAttribute(candidate, "AXDOMClassList") ?? []
        )
      {
        return true
      }
      if CFEqual(candidate, window) { return false }
      current = elementAttribute(candidate, kAXParentAttribute)
    }
    return false
  }

  private func owningWindow(for element: AXUIElement) -> AXUIElement? {
    var current: AXUIElement? = element
    for _ in 0..<32 {
      guard let candidate = current else { return nil }
      if stringAttribute(candidate, kAXRoleAttribute) == kAXWindowRole {
        return candidate
      }
      current = elementAttribute(candidate, kAXParentAttribute)
    }
    return nil
  }

  private func accessibilityTree(root: AXUIElement) throws -> [AXUIElement] {
    var result: [AXUIElement] = []
    var pending: [AXUIElement] = [root]
    while let element = pending.popLast() {
      result.append(element)
      guard result.count <= maximumTreeElements else {
        throw DesktopBridgeError.accessibilityUnavailable(
          "Codex Desktop accessibility tree exceeded the safety limit"
        )
      }
      if let children = elementArrayAttribute(element, kAXChildrenAttribute) {
        pending.append(contentsOf: children)
      }
    }
    return result
  }

  private func poll(deadlineMilliseconds: Int64) throws {
    let remaining = deadlineMilliseconds - clock.nowMilliseconds()
    guard remaining > 0 else { return }
    clock.sleep(milliseconds: min(pollMilliseconds, Int(clamping: remaining)))
  }
}

private struct RenameDialogElements {
  let container: AXUIElement
  let input: AXUIElement
  let save: AXUIElement
  let cancel: AXUIElement
}

private struct PasteboardSnapshot {
  let items: [[NSPasteboard.PasteboardType: Data]]
}

public func isSendLabel(_ rawLabel: String) -> Bool {
  let label =
    rawLabel
    .lowercased()
    .replacingOccurrences(of: "-", with: " ")
    .replacingOccurrences(of: "_", with: " ")
    .split(whereSeparator: { $0.isWhitespace })
    .joined(separator: " ")
  return label == "send" || label == "send message" || label == "send button"
}

/** Pure geometry/metadata predicate shared by labeled and unlabeled send arrows. */
public func isComposerSubmitGeometryCandidate(
  subrole: String?,
  enabled: Bool?,
  supportsPress: Bool,
  buttonFrame: CGRect?,
  composerFrame: CGRect,
  controlFrame: CGRect,
  rightmostButtonMaxX: CGFloat
) -> Bool {
  guard (subrole ?? "").isEmpty,
    enabled == true,
    supportsPress,
    let buttonFrame,
    (20...44).contains(buttonFrame.width),
    (20...44).contains(buttonFrame.height),
    abs(buttonFrame.width - buttonFrame.height) <= 2,
    buttonFrame.minX >= controlFrame.minX,
    buttonFrame.minY >= controlFrame.minY,
    buttonFrame.maxX <= controlFrame.maxX + 1,
    buttonFrame.maxY <= controlFrame.maxY + 1,
    (0...24).contains(controlFrame.maxX - buttonFrame.maxX),
    (0...24).contains(controlFrame.maxY - buttonFrame.maxY),
    buttonFrame.minX >= composerFrame.maxX - 48,
    buttonFrame.minY >= composerFrame.maxY - 16,
    buttonFrame.minY <= composerFrame.maxY + 32,
    abs(buttonFrame.maxX - rightmostButtonMaxX) <= 1
  else { return false }
  return true
}

/** Pure label guard layered over the shared composer-submit geometry. */
public func isUnlabeledComposerSubmitCandidate(
  labels: [String],
  subrole: String?,
  enabled: Bool?,
  supportsPress: Bool,
  buttonFrame: CGRect?,
  composerFrame: CGRect,
  controlFrame: CGRect,
  rightmostButtonMaxX: CGFloat
) -> Bool {
  guard labels.allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
  else { return false }
  return isComposerSubmitGeometryCandidate(
    subrole: subrole,
    enabled: enabled,
    supportsPress: supportsPress,
    buttonFrame: buttonFrame,
    composerFrame: composerFrame,
    controlFrame: controlFrame,
    rightmostButtonMaxX: rightmostButtonMaxX
  )
}

private func assertInteractiveSession() throws {
  guard isInteractiveDesktopSession(CGSessionCopyCurrentDictionary() as? [String: Any]) else {
    throw DesktopBridgeError.screenLocked
  }
}

/** Fail closed unless CoreGraphics reports an unlocked, on-console session. */
public func isInteractiveDesktopSession(_ dictionary: [String: Any]?) -> Bool {
  guard let dictionary else { return false }
  if let rawLocked = dictionary["CGSSessionScreenIsLocked"] {
    guard let locked = rawLocked as? Bool, locked == false else { return false }
  }
  guard let onConsole = dictionary[kCGSessionOnConsoleKey as String] as? Bool else {
    return false
  }
  return onConsole
}

/// Accept NSWorkspace's frontmost application only when the same process also
/// reports itself active. This guards the short-lived helper against a stale
/// cached workspace value while handling Electron builds whose system-wide AX
/// focused application is unavailable or resolves to a renderer child. Fall
/// back to the Accessibility server when there is no active workspace result.
private func focusedApplicationProcessIdentifier() -> pid_t? {
  if let frontmost = NSWorkspace.shared.frontmostApplication, frontmost.isActive {
    return frontmost.processIdentifier
  }
  let systemWide = AXUIElementCreateSystemWide()
  if let application = elementAttribute(systemWide, kAXFocusedApplicationAttribute) {
    var processIdentifier = pid_t()
    if AXUIElementGetPid(application, &processIdentifier) == .success {
      return processIdentifier
    }
  }
  return nil
}

private func copiedAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
    return nil
  }
  return value
}

private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
  copiedAttribute(element, attribute) as? String
}

private func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
  copiedAttribute(element, attribute) as? Bool
}

private func stringArrayAttribute(_ element: AXUIElement, _ attribute: String) -> [String]? {
  if let values = copiedAttribute(element, attribute) as? [String] { return values }
  if let value = copiedAttribute(element, attribute) as? String { return [value] }
  return nil
}

private func actionNames(_ element: AXUIElement) -> [String]? {
  var actions: CFArray?
  guard AXUIElementCopyActionNames(element, &actions) == .success else { return nil }
  return actions as? [String]
}

private func rectAttribute(_ element: AXUIElement) -> CGRect? {
  guard let rawPosition = copiedAttribute(element, kAXPositionAttribute),
    CFGetTypeID(rawPosition) == AXValueGetTypeID(),
    let rawSize = copiedAttribute(element, kAXSizeAttribute),
    CFGetTypeID(rawSize) == AXValueGetTypeID()
  else { return nil }
  var position = CGPoint.zero
  var size = CGSize.zero
  guard
    AXValueGetValue(unsafeDowncast(rawPosition, to: AXValue.self), .cgPoint, &position),
    AXValueGetValue(unsafeDowncast(rawSize, to: AXValue.self), .cgSize, &size)
  else { return nil }
  return CGRect(origin: position, size: size)
}

private func elementArrayAttribute(_ element: AXUIElement, _ attribute: String) -> [AXUIElement]? {
  copiedAttribute(element, attribute) as? [AXUIElement]
}

private func elementAttribute(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
  guard let value = copiedAttribute(element, attribute),
    CFGetTypeID(value) == AXUIElementGetTypeID()
  else { return nil }
  return unsafeDowncast(value, to: AXUIElement.self)
}

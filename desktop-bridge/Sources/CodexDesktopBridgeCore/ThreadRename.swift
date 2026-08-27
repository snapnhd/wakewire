import Foundation

public struct DesktopRenameRequest: Codable, Equatable {
  public let threadId: String
  public let title: String
  public let uiTimeoutMilliseconds: Int

  public init(threadId: String, title: String, uiTimeoutMilliseconds: Int) {
    self.threadId = threadId
    self.title = title
    self.uiTimeoutMilliseconds = uiTimeoutMilliseconds
  }

  public func validate() throws {
    guard isValidCodexThreadIdentifier(threadId) else {
      throw DesktopBridgeError.invalidRequest("threadId must be a canonical lowercase UUID")
    }
    guard isValidCodexThreadTitle(title) else {
      throw DesktopBridgeError.invalidRequest(
        "title must be non-empty, trimmed, single-line, and no larger than 60 code points / 512 bytes"
      )
    }
    guard uiTimeoutMilliseconds > 0, uiTimeoutMilliseconds <= 120_000 else {
      throw DesktopBridgeError.invalidRequest("UI timeout must be between 1 and 120000ms")
    }
  }

  public func deepLinkURL() throws -> URL {
    try validate()
    var components = URLComponents()
    components.scheme = "codex"
    components.host = "threads"
    components.path = "/\(threadId)"
    guard let url = components.url else {
      throw DesktopBridgeError.invalidRequest("could not construct the Codex task URL")
    }
    return url
  }
}

public struct DesktopRenameResult: Codable, Equatable {
  public let threadId: String
  public let title: String

  public init(threadId: String, title: String) {
    self.threadId = threadId
    self.title = title
  }
}

public protocol DesktopAccessibilityRenaming {
  /// Must not show a TCC prompt. This check happens before changing UI.
  func preflight() throws
  /// Renames only the task activated by the exact, validated Codex deep link.
  func rename(threadId: String, title: String, timeoutMilliseconds: Int) throws
}

public final class DesktopRenameCoordinator {
  private let launcher: DesktopURLLaunching
  private let accessibility: DesktopAccessibilityRenaming
  private let frontmostApplications: FrontmostApplicationManaging

  public init(
    launcher: DesktopURLLaunching,
    accessibility: DesktopAccessibilityRenaming,
    frontmostApplications: FrontmostApplicationManaging
  ) {
    self.launcher = launcher
    self.accessibility = accessibility
    self.frontmostApplications = frontmostApplications
  }

  public func rename(_ request: DesktopRenameRequest) throws -> DesktopRenameResult {
    let url = try request.deepLinkURL()
    try accessibility.preflight()

    let priorProcessIdentifier = frontmostApplications.captureFrontmostProcessIdentifier()
    defer {
      if let priorProcessIdentifier {
        frontmostApplications.restoreFrontmostApplication(
          processIdentifier: priorProcessIdentifier
        )
      }
    }

    try launcher.open(url)
    try accessibility.rename(
      threadId: request.threadId,
      title: request.title,
      timeoutMilliseconds: request.uiTimeoutMilliseconds
    )
    return DesktopRenameResult(threadId: request.threadId, title: request.title)
  }
}

public func isValidCodexThreadIdentifier(_ value: String) -> Bool {
  guard let uuid = UUID(uuidString: value) else { return false }
  return uuid.uuidString.lowercased() == value
}

public func isValidCodexThreadTitle(_ value: String) -> Bool {
  guard !value.isEmpty,
    value == value.trimmingCharacters(in: .whitespacesAndNewlines),
    value.unicodeScalars.count <= 60,
    value.utf8.count <= 512,
    !value.unicodeScalars.contains(where: { scalar in
      CharacterSet.controlCharacters.contains(scalar)
        || CharacterSet.newlines.contains(scalar)
    })
  else { return false }
  return true
}

public func isCodexRenameDialogTitle(_ value: String) -> Bool {
  let normalized = normalizedAccessibilityLabel(value)
  return normalized == "rename chat" || normalized == "rename task"
}

public func isCodexRenameDialogContainer(role: String?, subrole: String?) -> Bool {
  role == "AXGroup" && subrole == "AXApplicationDialog"
}

public func isCodexPotentialRenameDialogContainer(
  role: String?,
  subrole: String?,
  staticTextValues: [String]
) -> Bool {
  guard isCodexRenameDialogContainer(role: role, subrole: subrole) else { return false }
  let populatedValues = staticTextValues.filter {
    !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
  return populatedValues.isEmpty || populatedValues.contains(where: isCodexRenameDialogTitle)
}

public func isCodexRenameDialogHeading(role: String?, value: String?) -> Bool {
  role == "AXStaticText" && value.map(isCodexRenameDialogTitle) == true
}

public func isCodexRenameFormLandmark(role: String?, subrole: String?) -> Bool {
  // Codex Desktop 26.721.41059 exposes the HTML form as an AXGroup whose
  // subrole pins it to a form landmark.
  role == "AXGroup" && subrole == "AXLandmarkForm"
}

public func isCodexRenameTitleFieldLabel(_ value: String) -> Bool {
  let normalized = normalizedAccessibilityLabel(value)
  return normalized == "chat title" || normalized == "task title"
    || normalized == "add a title..." || normalized == "add a title…"
}

public func isCodexRenameSaveLabel(_ value: String) -> Bool {
  normalizedAccessibilityLabel(value) == "save"
}

public func isCodexRenameCancelLabel(_ value: String) -> Bool {
  normalizedAccessibilityLabel(value) == "cancel"
}

public func codexRenameSentinelValue(_ title: String) -> String {
  title + " "
}

public let codexActiveSidebarClassToken = "bg-token-list-hover-background"

public func codexDOMClassListHasExactActiveSidebarToken(_ domClassList: [String]) -> Bool {
  domClassList.flatMap {
    $0.split(whereSeparator: { $0.isWhitespace }).map(String.init)
  }.contains(codexActiveSidebarClassToken)
}

public func isCodexModalAccessibilityElement(
  role: String?,
  subrole: String?,
  modal: Bool?
) -> Bool {
  role == "AXSheet" || role == "AXApplicationDialog"
    || subrole == "AXDialog" || subrole == "AXApplicationDialog"
    || (role == "AXWindow" && modal == true)
}

public func isCodexActiveSidebarRowCandidate(
  domClassList: [String],
  role: String?,
  frame: CGRect?,
  windowFrame: CGRect
) -> Bool {
  let permittedRoles = ["AXGroup", "AXButton", "AXLink", "AXCell", "AXRow"]
  let sidebarBoundary = windowFrame.minX + min(max(windowFrame.width * 0.38, 260), 520)
  guard codexDOMClassListHasExactActiveSidebarToken(domClassList),
    permittedRoles.contains(role ?? ""),
    let frame,
    frame.width > 0,
    frame.height > 0,
    frame.intersects(windowFrame),
    frame.minX <= sidebarBoundary,
    frame.maxX <= sidebarBoundary + 32
  else { return false }
  return true
}

public func isVisibleCodexThreadTitleCandidate(
  labels: [String],
  role: String?,
  hidden: Bool?,
  selectedOrFocused: Bool,
  frame: CGRect?,
  windowFrame: CGRect,
  expectedTitle: String
) -> Bool {
  let permittedRoles = ["AXStaticText", "AXButton", "AXLink", "AXCell", "AXRow"]
  guard permittedRoles.contains(role ?? ""),
    hidden != true,
    labels.contains(expectedTitle),
    let frame,
    frame.width > 0,
    frame.height > 0,
    frame.intersects(windowFrame)
  else { return false }

  let headerBoundary = windowFrame.minY + min(max(windowFrame.height * 0.25, 120), 240)
  let sidebarBoundary = windowFrame.minX + min(max(windowFrame.width * 0.38, 260), 520)
  return (frame.minY <= headerBoundary && frame.minX > sidebarBoundary)
    || (frame.minX <= sidebarBoundary && selectedOrFocused)
}

private func normalizedAccessibilityLabel(_ value: String) -> String {
  value
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
    .replacingOccurrences(of: "-", with: " ")
    .replacingOccurrences(of: "_", with: " ")
    .split(whereSeparator: { $0.isWhitespace })
    .joined(separator: " ")
}

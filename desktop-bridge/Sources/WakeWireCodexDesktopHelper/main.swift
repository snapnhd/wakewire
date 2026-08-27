import CodexDesktopBridgeCore
import Foundation

do {
  let arguments = Array(CommandLine.arguments.dropFirst())
  if arguments == ["probe"] {
    // Validate Accessibility and the interactive session; never request a TCC prompt or touch UI.
    try MacCodexAccessibilitySubmitter().preflight()
    print("{\"ok\":true}")
  } else {
    let options = try Options.parse(arguments)
    let request = DesktopCreateRequest(
      url: options.url,
      marker: options.marker,
      cwd: options.cwd,
      notBeforeMilliseconds: options.notBeforeMilliseconds,
      uiTimeoutMilliseconds: options.uiTimeoutMilliseconds,
      discoveryTimeoutMilliseconds: options.discoveryTimeoutMilliseconds
    )
    let coordinator = DesktopBridgeCoordinator(
      launcher: MacDesktopURLLauncher(),
      accessibility: MacCodexAccessibilitySubmitter(),
      frontmostApplications: MacFrontmostApplicationManager(),
      taskFinder: SQLiteDesktopTaskFinder(databasePath: options.stateDatabasePath),
      submissionIntents: PrivateFilesystemDesktopSubmissionIntentStore()
    )
    let result = try coordinator.create(request)
    try printJSON(result)
  }
} catch {
  let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
  FileHandle.standardError.write(Data("wakewire-codex-desktop-helper: \(message)\n".utf8))
  exit(1)
}

private func decodeStandardInput<T: Decodable>() throws -> T {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard !data.isEmpty, data.count <= 256 * 1_024 else {
    throw CLIError.invalidRequestData
  }
  return try JSONDecoder().decode(T.self, from: data)
}

private func printJSON<T: Encodable>(_ value: T) throws {
  let data = try JSONEncoder().encode(value)
  guard let json = String(data: data, encoding: .utf8) else {
    throw CLIError.invalidUTF8
  }
  print(json)
}

private struct Options {
  let url: URL
  let marker: String
  let cwd: String
  let stateDatabasePath: String
  let notBeforeMilliseconds: Int64
  let uiTimeoutMilliseconds: Int
  let discoveryTimeoutMilliseconds: Int

  static func parse(_ arguments: [String]) throws -> Options {
    guard arguments == ["open-and-submit", "--request-json-stdin"] else {
      throw CLIError.usage
    }
    let decoded: Options = try decodeStandardInput()
    guard decoded.stateDatabasePath.hasPrefix("/"), decoded.notBeforeMilliseconds >= 0 else {
      throw CLIError.invalidRequestData
    }
    return decoded
  }
}

extension Options: Decodable {}

private enum CLIError: Error, LocalizedError {
  case usage
  case invalidRequestData
  case invalidUTF8

  var errorDescription: String? {
    switch self {
    case .usage:
      return "usage: probe | open-and-submit --request-json-stdin"
    case .invalidRequestData:
      return "stdin must contain one valid JSON request no larger than 262144 bytes"
    case .invalidUTF8:
      return "could not encode result"
    }
  }
}

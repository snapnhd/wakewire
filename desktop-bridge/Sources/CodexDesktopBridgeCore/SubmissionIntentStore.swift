import Darwin
import Foundation

/// Private, append-only intent and Send-attempt records for Codex Desktop task creation.
/// A v2 intent without its sidecar is retryable. The sidecar is the durable,
/// exclusive barrier that must be created before any non-idempotent Send action.
public final class PrivateFilesystemDesktopSubmissionIntentStore:
  DesktopSubmissionIntentClaiming
{
  private static let storeDirectoryName = "desktop-submission-intents-v1"
  private static let sendAttemptSuffix = ".send-attempt.json"
  private static let maximumIntentBytes = 16 * 1_024

  private let wakeWireDirectory: URL

  public init(
    wakeWireDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".wakewire", isDirectory: true)
  ) {
    self.wakeWireDirectory = wakeWireDirectory
  }

  public func claim(marker: String, cwd: String) throws -> DesktopSubmissionIntentClaim {
    try validate(marker: marker, cwd: cwd)
    return try withStoreDirectory { storeDescriptor, storeDirectory in
      let digest = String(marker.dropFirst(wakeWireMarkerPrefix.count))
      let intentName = "\(digest).json"
      let intentPath = storeDirectory.appendingPathComponent(intentName).path
      let record = SubmissionIntentRecord(version: 2, marker: marker, cwd: cwd)
      let encoded = try encode(record)

      let descriptor = Darwin.openat(
        storeDescriptor,
        intentName,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
        mode_t(S_IRUSR | S_IWUSR)
      )
      if descriptor >= 0 {
        defer { Darwin.close(descriptor) }
        do {
          try setPrivateFilePermissions(descriptor, path: intentPath)
          try writeAll(encoded, to: descriptor, path: intentPath)
          guard Darwin.fsync(descriptor) == 0 else {
            throw posixFailure("cannot sync Desktop submission intent", path: intentPath)
          }
          try syncDirectoryDescriptor(storeDescriptor, path: storeDirectory.path)
          return .retryable(marker: marker, cwd: cwd)
        } catch {
          // A partial published record remains present and fails closed. It is
          // never removed or replaced by a later helper.
          throw error
        }
      }

      let openError = errno
      guard openError == EEXIST else {
        throw posixFailure(
          "cannot exclusively create Desktop submission intent",
          path: intentPath,
          code: openError
        )
      }

      let existing = try readExistingIntent(
        named: intentName,
        in: storeDescriptor,
        displayPath: intentPath
      )
      guard existing.version == 2 else {
        // Version 1 claimed before WakeWire had a distinct Send barrier, so it
        // may already have activated Send and can never be retried safely.
        return .possibleSend(marker: existing.marker, cwd: existing.cwd)
      }
      let sendAttemptName = "\(digest)\(Self.sendAttemptSuffix)"
      let sendAttemptPath = storeDirectory.appendingPathComponent(sendAttemptName).path
      if let armed = try readExistingSendAttemptIfPresent(
        named: sendAttemptName,
        in: storeDescriptor,
        displayPath: sendAttemptPath
      ) {
        guard armed.marker == existing.marker, armed.cwd == existing.cwd else {
          throw DesktopBridgeError.taskDiscoveryFailed(
            "Desktop Send-attempt barrier does not match its submission intent"
          )
        }
        return .possibleSend(marker: existing.marker, cwd: existing.cwd)
      }
      return .retryable(marker: existing.marker, cwd: existing.cwd)
    }
  }

  public func arm(marker: String, cwd: String) throws -> DesktopSubmissionIntentArm {
    try validate(marker: marker, cwd: cwd)
    return try withStoreDirectory { storeDescriptor, storeDirectory in
      let digest = String(marker.dropFirst(wakeWireMarkerPrefix.count))
      let intentName = "\(digest).json"
      let intentPath = storeDirectory.appendingPathComponent(intentName).path
      let intent = try readExistingIntent(
        named: intentName,
        in: storeDescriptor,
        displayPath: intentPath
      )
      guard intent.marker == marker, intent.cwd == cwd else {
        throw DesktopBridgeError.taskDiscoveryFailed(
          "Desktop submission intent does not match the requested marker and cwd"
        )
      }
      guard intent.version == 2 else {
        return .existing(marker: intent.marker, cwd: intent.cwd)
      }

      let sendAttemptName = "\(digest)\(Self.sendAttemptSuffix)"
      let sendAttemptPath = storeDirectory.appendingPathComponent(sendAttemptName).path
      let record = SubmissionSendAttemptRecord(version: 1, marker: marker, cwd: cwd)
      let encoded = try encode(record)
      let descriptor = Darwin.openat(
        storeDescriptor,
        sendAttemptName,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
        mode_t(S_IRUSR | S_IWUSR)
      )
      if descriptor >= 0 {
        defer { Darwin.close(descriptor) }
        do {
          try setPrivateFilePermissions(descriptor, path: sendAttemptPath)
          try writeAll(encoded, to: descriptor, path: sendAttemptPath)
          guard Darwin.fsync(descriptor) == 0 else {
            throw posixFailure(
              "cannot sync Desktop Send-attempt barrier",
              path: sendAttemptPath
            )
          }
          try syncDirectoryDescriptor(storeDescriptor, path: storeDirectory.path)
          return .armed
        } catch {
          // Presence alone permanently closes the Send gate. A partial or
          // unsynced barrier is never unlinked and will fail closed on retry.
          throw error
        }
      }

      let openError = errno
      guard openError == EEXIST else {
        throw posixFailure(
          "cannot exclusively create Desktop Send-attempt barrier",
          path: sendAttemptPath,
          code: openError
        )
      }
      let existing = try readExistingSendAttempt(
        named: sendAttemptName,
        in: storeDescriptor,
        displayPath: sendAttemptPath
      )
      return .existing(marker: existing.marker, cwd: existing.cwd)
    }
  }

  private func validate(marker: String, cwd: String) throws {
    guard isValidWakeWireMarker(marker) else {
      throw DesktopBridgeError.invalidRequest("invalid WakeWire correlation marker")
    }
    guard cwd.hasPrefix("/") else {
      throw DesktopBridgeError.invalidRequest("cwd must be an absolute path")
    }
  }

  private func withStoreDirectory<T>(
    _ operation: (Int32, URL) throws -> T
  ) throws -> T {
    guard wakeWireDirectory.path.hasPrefix("/") else {
      throw DesktopBridgeError.taskDiscoveryFailed(
        "WakeWire submission-intent directory must be absolute"
      )
    }
    let parentDirectory = wakeWireDirectory.deletingLastPathComponent()
    let wakeWireName = wakeWireDirectory.lastPathComponent
    guard isSafePathComponent(wakeWireName) else {
      throw DesktopBridgeError.taskDiscoveryFailed(
        "WakeWire submission-intent directory has an invalid name"
      )
    }

    // Every lookup and mutation is relative to verified directory descriptors;
    // path or symlink swaps cannot redirect either record.
    let parentDescriptor = try openVerifiedCurrentUserDirectory(at: parentDirectory)
    defer { Darwin.close(parentDescriptor) }
    let wakeWireDescriptor = try openOrCreatePrivateDirectory(
      named: wakeWireName,
      in: parentDescriptor,
      displayPath: wakeWireDirectory.path
    )
    defer { Darwin.close(wakeWireDescriptor) }
    let storeDirectory = wakeWireDirectory.appendingPathComponent(
      Self.storeDirectoryName,
      isDirectory: true
    )
    let storeDescriptor = try openOrCreatePrivateDirectory(
      named: Self.storeDirectoryName,
      in: wakeWireDescriptor,
      displayPath: storeDirectory.path
    )
    defer { Darwin.close(storeDescriptor) }
    return try operation(storeDescriptor, storeDirectory)
  }

  private func openVerifiedCurrentUserDirectory(at url: URL) throws -> Int32 {
    let descriptor = Darwin.open(
      url.path,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    guard descriptor >= 0 else {
      throw posixFailure("cannot open WakeWire parent directory", path: url.path)
    }
    do {
      try verifyCurrentUserDirectory(descriptor, path: url.path, makePrivate: false)
      return descriptor
    } catch {
      Darwin.close(descriptor)
      throw error
    }
  }

  private func openOrCreatePrivateDirectory(
    named name: String,
    in parentDescriptor: Int32,
    displayPath: String
  ) throws -> Int32 {
    guard isSafePathComponent(name) else {
      throw DesktopBridgeError.taskDiscoveryFailed(
        "private WakeWire directory has an invalid path component"
      )
    }
    let createResult = Darwin.mkdirat(parentDescriptor, name, mode_t(S_IRWXU))
    let created = createResult == 0
    if !created, errno != EEXIST {
      throw posixFailure("cannot create private WakeWire directory", path: displayPath)
    }
    let descriptor = Darwin.openat(
      parentDescriptor,
      name,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    guard descriptor >= 0 else {
      throw posixFailure("cannot open private WakeWire directory", path: displayPath)
    }
    do {
      try verifyCurrentUserDirectory(descriptor, path: displayPath, makePrivate: true)
      if created {
        try syncDirectoryDescriptor(descriptor, path: displayPath)
        try syncDirectoryDescriptor(parentDescriptor, path: "parent of \(displayPath)")
      }
      return descriptor
    } catch {
      Darwin.close(descriptor)
      throw error
    }
  }

  private func verifyCurrentUserDirectory(
    _ descriptor: Int32,
    path: String,
    makePrivate: Bool
  ) throws {
    var information = stat()
    guard Darwin.fstat(descriptor, &information) == 0 else {
      throw posixFailure("cannot inspect private WakeWire directory", path: path)
    }
    guard information.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
      information.st_uid == Darwin.geteuid()
    else {
      throw DesktopBridgeError.taskDiscoveryFailed(
        "private WakeWire path is not a current-user directory: \(path)"
      )
    }
    if makePrivate, Darwin.fchmod(descriptor, mode_t(S_IRWXU)) != 0 {
      throw posixFailure(
        "cannot set private WakeWire directory permissions",
        path: path
      )
    }
  }

  private func readExistingIntent(
    named name: String,
    in storeDescriptor: Int32,
    displayPath: String
  ) throws -> SubmissionIntentRecord {
    let descriptor = Darwin.openat(storeDescriptor, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else {
      throw posixFailure("cannot open existing Desktop submission intent", path: displayPath)
    }
    defer { Darwin.close(descriptor) }

    var information = stat()
    guard Darwin.fstat(descriptor, &information) == 0 else {
      throw posixFailure("cannot inspect existing Desktop submission intent", path: displayPath)
    }
    guard information.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
      information.st_uid == Darwin.geteuid()
    else {
      throw DesktopBridgeError.taskDiscoveryFailed(
        "Desktop submission intent is not a current-user regular file: \(displayPath)"
      )
    }
    try setPrivateFilePermissions(descriptor, path: displayPath)

    // O_EXCL publishes the directory entry before the winner finishes its
    // small append-only write. Briefly wait for that write; an abandoned or
    // corrupt partial file remains present and ultimately fails closed.
    var latestDecodeError: Error?
    for attempt in 0..<100 {
      guard Darwin.lseek(descriptor, 0, SEEK_SET) >= 0 else {
        throw posixFailure("cannot seek existing Desktop submission intent", path: displayPath)
      }
      let data = try readAll(from: descriptor, path: displayPath)
      do {
        let record = try JSONDecoder().decode(SubmissionIntentRecord.self, from: data)
        guard record.version == 1 || record.version == 2,
          isValidWakeWireMarker(record.marker),
          record.cwd.hasPrefix("/")
        else {
          throw DesktopBridgeError.taskDiscoveryFailed(
            "existing Desktop submission intent has invalid contents"
          )
        }
        return record
      } catch let error as DesktopBridgeError {
        throw error
      } catch {
        latestDecodeError = error
        if attempt < 99 {
          Darwin.usleep(10_000)
        }
      }
    }
    throw DesktopBridgeError.taskDiscoveryFailed(
      "cannot decode existing Desktop submission intent: "
        + (latestDecodeError?.localizedDescription ?? "unknown error")
    )
  }

  private func readExistingSendAttempt(
    named name: String,
    in storeDescriptor: Int32,
    displayPath: String
  ) throws -> SubmissionSendAttemptRecord {
    guard
      let record = try readExistingSendAttemptIfPresent(
        named: name,
        in: storeDescriptor,
        displayPath: displayPath
      )
    else {
      throw DesktopBridgeError.taskDiscoveryFailed(
        "existing Desktop Send-attempt barrier disappeared"
      )
    }
    return record
  }

  private func readExistingSendAttemptIfPresent(
    named name: String,
    in storeDescriptor: Int32,
    displayPath: String
  ) throws -> SubmissionSendAttemptRecord? {
    let descriptor = Darwin.openat(storeDescriptor, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else {
      let openError = errno
      if openError == ENOENT { return nil }
      throw posixFailure(
        "cannot open existing Desktop Send-attempt barrier",
        path: displayPath,
        code: openError
      )
    }
    defer { Darwin.close(descriptor) }

    var information = stat()
    guard Darwin.fstat(descriptor, &information) == 0 else {
      throw posixFailure(
        "cannot inspect existing Desktop Send-attempt barrier",
        path: displayPath
      )
    }
    guard information.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
      information.st_uid == Darwin.geteuid()
    else {
      throw DesktopBridgeError.taskDiscoveryFailed(
        "Desktop Send-attempt barrier is not a current-user regular file: \(displayPath)"
      )
    }
    try setPrivateFilePermissions(descriptor, path: displayPath)

    // The exclusive creator publishes the entry before its small append-only
    // write completes. Wait briefly; an abandoned partial record stays present
    // and ultimately fails closed.
    var latestDecodeError: Error?
    for attempt in 0..<100 {
      guard Darwin.lseek(descriptor, 0, SEEK_SET) >= 0 else {
        throw posixFailure(
          "cannot seek existing Desktop Send-attempt barrier",
          path: displayPath
        )
      }
      let data = try readAll(from: descriptor, path: displayPath)
      do {
        let record = try JSONDecoder().decode(SubmissionSendAttemptRecord.self, from: data)
        guard record.version == 1, isValidWakeWireMarker(record.marker),
          record.cwd.hasPrefix("/")
        else {
          throw DesktopBridgeError.taskDiscoveryFailed(
            "existing Desktop Send-attempt barrier has invalid contents"
          )
        }
        return record
      } catch let error as DesktopBridgeError {
        throw error
      } catch {
        latestDecodeError = error
        if attempt < 99 {
          Darwin.usleep(10_000)
        }
      }
    }
    throw DesktopBridgeError.taskDiscoveryFailed(
      "cannot decode existing Desktop Send-attempt barrier: "
        + (latestDecodeError?.localizedDescription ?? "unknown error")
    )
  }

  private func setPrivateFilePermissions(_ descriptor: Int32, path: String) throws {
    guard Darwin.fchmod(descriptor, mode_t(S_IRUSR | S_IWUSR)) == 0 else {
      throw posixFailure("cannot set Desktop submission intent permissions", path: path)
    }
  }

  private func encode<T: Encodable>(_ record: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    var encoded = try encoder.encode(record)
    encoded.append(0x0A)
    return encoded
  }

  private func writeAll(_ data: Data, to descriptor: Int32, path: String) throws {
    try data.withUnsafeBytes { bytes in
      guard let baseAddress = bytes.baseAddress else { return }
      var offset = 0
      while offset < bytes.count {
        let written = Darwin.write(
          descriptor,
          baseAddress.advanced(by: offset),
          bytes.count - offset
        )
        if written < 0 {
          if errno == EINTR { continue }
          throw posixFailure("cannot write Desktop submission intent", path: path)
        }
        guard written > 0 else {
          throw DesktopBridgeError.taskDiscoveryFailed(
            "cannot write Desktop submission intent: zero-byte write at \(path)"
          )
        }
        offset += written
      }
    }
  }

  private func readAll(from descriptor: Int32, path: String) throws -> Data {
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while true {
      let count = buffer.withUnsafeMutableBytes { bytes in
        Darwin.read(descriptor, bytes.baseAddress, bytes.count)
      }
      if count < 0 {
        if errno == EINTR { continue }
        throw posixFailure("cannot read Desktop submission intent", path: path)
      }
      if count == 0 { return result }
      guard result.count + count <= Self.maximumIntentBytes else {
        throw DesktopBridgeError.taskDiscoveryFailed(
          "existing Desktop submission intent exceeds \(Self.maximumIntentBytes) bytes"
        )
      }
      result.append(contentsOf: buffer.prefix(count))
    }
  }

  private func syncDirectoryDescriptor(_ descriptor: Int32, path: String) throws {
    guard Darwin.fsync(descriptor) == 0 else {
      throw posixFailure("cannot sync Desktop submission-intent directory", path: path)
    }
  }

  private func isSafePathComponent(_ value: String) -> Bool {
    !value.isEmpty && value != "." && value != ".." && !value.contains("/")
      && !value.utf8.contains(0)
  }

  private func posixFailure(
    _ operation: String,
    path: String,
    code: Int32 = errno
  ) -> DesktopBridgeError {
    DesktopBridgeError.taskDiscoveryFailed(
      "\(operation) at \(path): \(String(cString: strerror(code)))"
    )
  }
}

private struct SubmissionIntentRecord: Codable, Equatable {
  let version: Int
  let marker: String
  let cwd: String
}

private struct SubmissionSendAttemptRecord: Codable, Equatable {
  let version: Int
  let marker: String
  let cwd: String
}

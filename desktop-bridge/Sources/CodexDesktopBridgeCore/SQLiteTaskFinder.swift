import Foundation
import SQLite3

private let maximumRolloutProofBytes = 4 * 1_024 * 1_024

public final class SQLiteDesktopTaskFinder: DesktopTaskFinding {
  private let databasePath: String

  public init(databasePath: String) {
    self.databasePath = databasePath
  }

  public func findTaskId(
    marker: String,
    cwd: String,
    notBeforeMilliseconds: Int64
  ) throws -> String? {
    guard isValidWakeWireMarker(marker) else {
      throw DesktopBridgeError.invalidRequest("invalid WakeWire correlation marker")
    }

    var database: OpaquePointer?
    let openResult = sqlite3_open_v2(
      databasePath,
      &database,
      SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX,
      nil
    )
    guard openResult == SQLITE_OK, let database else {
      let detail = database.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
      if let database { sqlite3_close(database) }
      throw DesktopBridgeError.stateDatabase(
        "cannot open Codex Desktop state database read-only: \(detail)"
      )
    }
    defer { sqlite3_close(database) }
    sqlite3_busy_timeout(database, 250)

    let query = """
      SELECT id, rollout_path
        FROM threads
       WHERE archived = 0
         AND cwd = ?1
         AND COALESCE(created_at_ms, created_at * 1000) >= ?2
         AND (instr(first_user_message, ?3) > 0 OR instr(preview, ?4) > 0)
       ORDER BY COALESCE(created_at_ms, created_at * 1000) ASC, id ASC
       LIMIT 129
      """
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, query, -1, &statement, nil) == SQLITE_OK,
      let statement
    else {
      throw DesktopBridgeError.stateDatabase(
        "cannot prepare Codex Desktop state query: \(String(cString: sqlite3_errmsg(database)))"
      )
    }
    defer { sqlite3_finalize(statement) }

    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    guard sqlite3_bind_text(statement, 1, cwd, -1, transient) == SQLITE_OK,
      sqlite3_bind_int64(statement, 2, notBeforeMilliseconds) == SQLITE_OK,
      sqlite3_bind_text(statement, 3, marker, -1, transient) == SQLITE_OK,
      sqlite3_bind_text(statement, 4, marker, -1, transient) == SQLITE_OK
    else {
      throw DesktopBridgeError.stateDatabase("cannot bind Codex Desktop state query")
    }

    var candidates: [(threadId: String, rolloutPath: String?)] = []
    while true {
      let step = sqlite3_step(statement)
      if step == SQLITE_DONE { break }
      guard step == SQLITE_ROW else {
        throw DesktopBridgeError.stateDatabase(
          "Codex Desktop state query failed: \(String(cString: sqlite3_errmsg(database)))"
        )
      }
      guard let text = sqlite3_column_text(statement, 0) else {
        throw DesktopBridgeError.stateDatabase("Codex Desktop returned an empty task id")
      }
      let rolloutPath: String?
      if sqlite3_column_type(statement, 1) == SQLITE_NULL {
        rolloutPath = nil
      } else if let rolloutText = sqlite3_column_text(statement, 1) {
        rolloutPath = String(cString: rolloutText)
      } else {
        throw DesktopBridgeError.stateDatabase(
          "Codex Desktop returned an invalid rollout path"
        )
      }
      candidates.append((threadId: String(cString: text), rolloutPath: rolloutPath))
    }

    guard candidates.count <= 128 else {
      throw DesktopBridgeError.taskDiscoveryFailed(
        "too many Codex Desktop drafts matched a unique WakeWire marker"
      )
    }

    var submitted: [String] = []
    for candidate in candidates {
      guard !candidate.threadId.isEmpty else {
        throw DesktopBridgeError.stateDatabase("Codex Desktop returned an empty task id")
      }
      // Desktop persists a marker-bearing row while New chat is still only a
      // draft. Only a rollout containing a real started turn proves Send.
      guard let rolloutPath = candidate.rolloutPath, !rolloutPath.isEmpty else { continue }
      guard rolloutPath.hasPrefix("/") else {
        throw DesktopBridgeError.stateDatabase(
          "Codex Desktop returned a non-absolute rollout path"
        )
      }
      let data: Data
      do {
        data = try readBoundedRolloutProof(at: URL(fileURLWithPath: rolloutPath))
      } catch let error as DesktopBridgeError {
        throw error
      } catch {
        let failure = error as NSError
        if failure.domain == NSCocoaErrorDomain && failure.code == NSFileNoSuchFileError {
          continue
        }
        throw DesktopBridgeError.stateDatabase(
          "cannot inspect Codex Desktop rollout for task \(candidate.threadId): "
            + error.localizedDescription
        )
      }
      if try rolloutProvesStartedTurn(data, marker: marker) {
        submitted.append(candidate.threadId)
      }
    }
    guard submitted.count <= 1 else {
      throw DesktopBridgeError.taskDiscoveryFailed(
        "multiple submitted Codex Desktop tasks matched a unique WakeWire marker"
      )
    }
    return submitted.first
  }
}

private func rolloutProvesStartedTurn(_ data: Data, marker: String) throws -> Bool {
  guard let rollout = String(data: data, encoding: .utf8) else {
    throw DesktopBridgeError.stateDatabase("Codex Desktop rollout is not valid UTF-8")
  }
  let finalLineMayBePartial = !rollout.hasSuffix("\n")
  let lines = rollout.split(separator: "\n", omittingEmptySubsequences: false)
  var startedTurnIds = Set<String>()
  var contextTurnIds = Set<String>()
  var markerInUserMessage = false

  for (index, rawLine) in lines.enumerated() {
    let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
    if line.isEmpty { continue }
    let record: [String: Any]
    do {
      guard
        let decoded = try JSONSerialization.jsonObject(with: Data(line.utf8))
          as? [String: Any]
      else {
        throw DesktopBridgeError.stateDatabase(
          "Codex Desktop rollout record is not a JSON object"
        )
      }
      record = decoded
    } catch let error as DesktopBridgeError {
      throw error
    } catch {
      // Desktop appends JSONL concurrently. Ignore only an incomplete final
      // record; malformed durable records fail closed.
      if finalLineMayBePartial && index == lines.count - 1 { continue }
      throw DesktopBridgeError.stateDatabase(
        "Codex Desktop rollout contains invalid JSON: \(error.localizedDescription)"
      )
    }
    guard let payload = record["payload"] as? [String: Any] else { continue }

    if record["type"] as? String == "event_msg",
      payload["type"] as? String == "task_started",
      let turnId = payload["turn_id"] as? String,
      !turnId.isEmpty
    {
      startedTurnIds.insert(turnId)
      continue
    }
    if record["type"] as? String == "turn_context",
      let turnId = payload["turn_id"] as? String,
      !turnId.isEmpty
    {
      contextTurnIds.insert(turnId)
      continue
    }
    guard record["type"] as? String == "response_item",
      payload["type"] as? String == "message",
      payload["role"] as? String == "user",
      let content = payload["content"] as? [[String: Any]]
    else { continue }
    markerInUserMessage =
      markerInUserMessage
      || content.contains { item in
        item["type"] as? String == "input_text"
          && (item["text"] as? String)?.contains(marker) == true
      }
  }

  return markerInUserMessage && !startedTurnIds.isDisjoint(with: contextTurnIds)
}

private func readBoundedRolloutProof(at url: URL) throws -> Data {
  let handle = try FileHandle(forReadingFrom: url)
  defer { try? handle.close() }
  let data = try handle.read(upToCount: maximumRolloutProofBytes + 1) ?? Data()
  guard data.count <= maximumRolloutProofBytes else {
    throw DesktopBridgeError.stateDatabase(
      "Codex Desktop rollout proof exceeds \(maximumRolloutProofBytes) bytes"
    )
  }
  return data
}

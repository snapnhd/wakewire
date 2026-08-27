import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  CodexRolloutCompletionReader,
  type CodexRolloutCompletionReaderConfig,
} from "./completion.js";

const THREAD_ID = "019fa935-a17b-7542-a28b-c3dc4d20ff20";
const TURN_ID = "019fa935-a314-7853-b5fd-57af3f88c7ec";
const MARKER = `wakewire:event:v1:${"a".repeat(64)}`;
const OTHER_MARKER = `wakewire:event:v1:${"b".repeat(64)}`;

describe("CodexRolloutCompletionReader", () => {
  it("backfills the supplied Desktop task from task_complete.last_agent_message only", async () => {
    const finalMessage = "I’m doing well today—thanks for asking! How are you doing, CJ?";
    const fixture = await createFixture([
      {
        threadId: THREAD_ID,
        data: jsonl([
          ...turnPrefix(),
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [
                {
                  type: "output_text",
                  text: `${finalMessage}\n\n<oai-mem-citation>private</oai-mem-citation>`,
                },
              ],
            },
          },
          {
            type: "event_msg",
            payload: { type: "agent_message", phase: "final_answer", message: finalMessage },
          },
          taskComplete(finalMessage),
        ]),
      },
    ]);

    try {
      await expect(fixture.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({
          status: "completed",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          finalMessage,
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the durable task_complete text raw for the outbound presentation layer", async () => {
    const raw = 'Done\n\n::git-create-branch{cwd="/tmp/example" branch="codex/example"}\n';
    const fixture = await createFixture([
      { threadId: THREAD_ID, data: jsonl([...turnPrefix(), taskComplete(raw)]) },
    ]);

    try {
      await expect(fixture.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({ status: "completed", finalMessage: raw }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("accepts repeated matching session metadata on a resumed multi-turn task", async () => {
    const earlierTurn = "019fa935-1111-7111-8111-111111111111";
    const fixture = await createFixture([
      {
        threadId: THREAD_ID,
        data: jsonl([
          sessionMeta(THREAD_ID),
          { type: "event_msg", payload: { type: "task_started", turn_id: earlierTurn } },
          { type: "turn_context", payload: { turn_id: earlierTurn } },
          userMessage(OTHER_MARKER),
          taskCompleteFor(earlierTurn, "Earlier answer"),
          sessionMeta(THREAD_ID),
          { type: "event_msg", payload: { type: "task_started", turn_id: TURN_ID } },
          { type: "turn_context", payload: { turn_id: TURN_ID } },
          userMessage(MARKER),
          sessionMeta(THREAD_ID),
          taskComplete("Current answer"),
        ]),
      },
    ]);

    try {
      await expect(fixture.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({
          status: "completed",
          turnId: TURN_ID,
          finalMessage: "Current answer",
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects any conflicting identity among repeated session metadata", async () => {
    const fixture = await createFixture([
      {
        threadId: THREAD_ID,
        data: jsonl([
          ...turnPrefix(),
          sessionMeta("019fa935-2222-7222-8222-222222222222"),
          taskComplete("Must not relay"),
        ]),
      },
    ]);

    try {
      await expect(fixture.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({
          status: "malformed",
          reason: expect.stringContaining("identity"),
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains a trailing record split inside a multibyte UTF-8 code point", async () => {
    const completePrefix = jsonl(turnPrefix());
    const terminal = Buffer.from(JSON.stringify(taskComplete("Finishing 👋")), "utf8");
    const emojiStart = terminal.indexOf(Buffer.from("👋", "utf8"));
    expect(emojiStart).toBeGreaterThan(0);
    const splitInsideEmoji = emojiStart + 2;
    const partialTail = terminal.subarray(0, splitInsideEmoji);
    const data = Buffer.concat([Buffer.from(completePrefix), partialTail]);
    const fixture = await createFixture([{ threadId: THREAD_ID, data }]);

    try {
      const result = await fixture.reader.read({
        threadId: THREAD_ID,
        marker: MARKER,
        turnId: TURN_ID,
      });
      expect(result).toEqual(
        expect.objectContaining({
          status: "pending",
          turnId: TURN_ID,
          committedBytes: Buffer.byteLength(completePrefix),
        }),
      );
      const rolloutPath = fixture.rolloutPaths.get(THREAD_ID);
      if (!rolloutPath) throw new Error("fixture rollout is missing");
      await fs.appendFile(
        rolloutPath,
        Buffer.concat([terminal.subarray(splitInsideEmoji), Buffer.from("\n")]),
      );
      await expect(
        fixture.reader.read({ threadId: THREAD_ID, marker: MARKER, turnId: TURN_ID }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: "completed",
          finalMessage: "Finishing 👋",
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("streams a large backfill once and reads only appended byte ranges", async () => {
    const filler = Array.from({ length: 80 }, (_, index) => ({
      type: "event_msg",
      payload: { type: "token_count", index, text: "x".repeat(96) },
    }));
    const data = jsonl([...turnPrefix(), ...filler, taskComplete("Incremental answer")]);
    expect(Buffer.byteLength(data)).toBeGreaterThan(2_048);
    const fixture = await createFixture([{ threadId: THREAD_ID, data }], {
      scanChunkBytes: 257,
      maxRecordBytes: 2_048,
    });

    try {
      const result = await readUntilTerminal(fixture.reader, {
        threadId: THREAD_ID,
        marker: MARKER,
      });
      expect(result).toEqual(
        expect.objectContaining({
          status: "completed",
          finalMessage: "Incremental answer",
          committedBytes: Buffer.byteLength(data),
        }),
      );
      expect(fixture.readRanges.length).toBeGreaterThan(2);
      for (let index = 1; index < fixture.readRanges.length; index++) {
        const previous = fixture.readRanges[index - 1];
        const current = fixture.readRanges[index];
        if (!previous || !current) throw new Error("fixture read range is missing");
        expect(current.position).toBe(previous.position + previous.bytesRead);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports an exact matching turn_aborted without returning partial assistant output", async () => {
    const fixture = await createFixture([
      {
        threadId: THREAD_ID,
        data: jsonl([
          ...turnPrefix(),
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              phase: "commentary",
              content: [{ type: "output_text", text: "Partial work" }],
            },
          },
          {
            type: "event_msg",
            payload: { type: "turn_aborted", turn_id: TURN_ID, reason: "interrupted" },
          },
        ]),
      },
    ]);

    try {
      await expect(
        fixture.reader.read({ threadId: THREAD_ID, marker: MARKER, turnId: TURN_ID }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: "aborted",
          turnId: TURN_ID,
          abortReason: "interrupted",
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("ignores terminal records belonging to another turn", async () => {
    const fixture = await createFixture([
      {
        threadId: THREAD_ID,
        data: jsonl([
          ...turnPrefix(),
          {
            type: "event_msg",
            payload: {
              type: "task_complete",
              turn_id: "another-turn",
              last_agent_message: "Unrelated answer",
            },
          },
        ]),
      },
    ]);

    try {
      await expect(
        fixture.reader.read({ threadId: THREAD_ID, marker: MARKER, turnId: TURN_ID }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: "pending",
          turnId: TURN_ID,
          reason: expect.stringContaining("terminal record"),
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails ambiguous when the supplied turn does not own the exact marker", async () => {
    const fixture = await createFixture([
      {
        threadId: THREAD_ID,
        data: jsonl([...turnPrefix(), taskComplete("Done")]),
      },
    ]);

    try {
      await expect(
        fixture.reader.read({ threadId: THREAD_ID, marker: MARKER, turnId: "another-turn" }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: "ambiguous",
          reason: expect.stringContaining("does not own"),
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails ambiguous when a marker appears more than once in user-message content", async () => {
    const records = turnPrefix();
    const marked = records.at(-1) as {
      payload: { content: Array<{ text: string }> };
    };
    const firstContent = marked.payload.content[0];
    if (!firstContent) throw new Error("test fixture is missing marked content");
    firstContent.text += ` duplicate ${MARKER}`;
    const fixture = await createFixture([
      { threadId: THREAD_ID, data: jsonl([...records, taskComplete("Done")]) },
    ]);

    try {
      await expect(fixture.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({
          status: "ambiguous",
          reason: expect.stringContaining("multiple user-message locations"),
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports malformed complete JSONL and invalid complete UTF-8 distinctly", async () => {
    const malformedJson = await createFixture([
      { threadId: THREAD_ID, data: `${jsonl(turnPrefix())}{not-json}\n` },
    ]);
    try {
      await expect(
        malformedJson.reader.read({ threadId: THREAD_ID, marker: MARKER }),
      ).resolves.toEqual(
        expect.objectContaining({ status: "malformed", reason: expect.stringContaining("JSON") }),
      );
    } finally {
      await malformedJson.cleanup();
    }

    const invalidUtf8 = await createFixture([
      {
        threadId: THREAD_ID,
        data: Buffer.concat([Buffer.from(jsonl(turnPrefix())), Buffer.from([0xc3, 0x28, 0x0a])]),
      },
    ]);
    try {
      await expect(
        invalidUtf8.reader.read({ threadId: THREAD_ID, marker: MARKER }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: "malformed",
          reason: expect.stringContaining("UTF-8"),
        }),
      );
    } finally {
      await invalidUtf8.cleanup();
    }
  });

  it("resolves only the exact stored thread even when another rollout has the marker", async () => {
    const otherThread = "019fa935-6002-7633-b389-928c1c604ec5";
    const fixture = await createFixture([
      {
        threadId: THREAD_ID,
        data: jsonl([
          sessionMeta(THREAD_ID),
          { type: "event_msg", payload: { type: "task_started", turn_id: TURN_ID } },
        ]),
      },
      {
        threadId: otherThread,
        data: jsonl([
          sessionMeta(otherThread),
          { type: "event_msg", payload: { type: "task_started", turn_id: "other-turn" } },
          { type: "turn_context", payload: { turn_id: "other-turn" } },
          userMessage(MARKER),
          {
            type: "event_msg",
            payload: {
              type: "task_complete",
              turn_id: "other-turn",
              last_agent_message: "Wrong task",
            },
          },
        ]),
      },
    ]);

    try {
      await expect(fixture.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({
          status: "pending",
          threadId: THREAD_ID,
          reason: expect.stringContaining("marked user message"),
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects rollout paths outside the sessions root, final symlinks, and non-files", async () => {
    const outside = await createFixture([
      { threadId: THREAD_ID, data: jsonl([...turnPrefix(), taskComplete("Done")]) },
    ]);
    try {
      const outsidePath = path.join(outside.directory, "outside.jsonl");
      await fs.writeFile(outsidePath, jsonl([...turnPrefix(), taskComplete("Outside")]));
      updateRolloutPath(outside.databasePath, THREAD_ID, outsidePath);
      await expect(outside.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({
          status: "malformed",
          reason: expect.stringContaining("outside"),
        }),
      );
    } finally {
      await outside.cleanup();
    }

    const symlink = await createFixture([
      { threadId: THREAD_ID, data: jsonl([...turnPrefix(), taskComplete("Done")]) },
    ]);
    try {
      const rolloutPath = requireRolloutPath(symlink, THREAD_ID);
      const targetPath = `${rolloutPath}.target`;
      await fs.rename(rolloutPath, targetPath);
      await fs.symlink(targetPath, rolloutPath);
      await expect(symlink.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({
          status: "malformed",
          reason: expect.stringContaining("symbolic link"),
        }),
      );
    } finally {
      await symlink.cleanup();
    }

    const directory = await createFixture([
      { threadId: THREAD_ID, data: jsonl([...turnPrefix(), taskComplete("Done")]) },
    ]);
    try {
      const directoryPath = path.join(directory.sessionsRoot, "not-a-file");
      await fs.mkdir(directoryPath);
      updateRolloutPath(directory.databasePath, THREAD_ID, directoryPath);
      await expect(directory.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({
          status: "malformed",
          reason: expect.stringContaining("regular file"),
        }),
      );
    } finally {
      await directory.cleanup();
    }
  });

  it("fails closed when an incrementally scanned rollout is truncated or replaced", async () => {
    const data = jsonl([...turnPrefix(), taskComplete("Done")]);
    const truncated = await createFixture([{ threadId: THREAD_ID, data }], {
      scanChunkBytes: 32,
    });
    try {
      await expect(truncated.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({ status: "pending" }),
      );
      await fs.truncate(requireRolloutPath(truncated, THREAD_ID), 0);
      await expect(truncated.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({
          status: "malformed",
          reason: expect.stringContaining("truncated"),
        }),
      );
    } finally {
      await truncated.cleanup();
    }

    const replaced = await createFixture([{ threadId: THREAD_ID, data }], {
      scanChunkBytes: 32,
    });
    try {
      await expect(replaced.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({ status: "pending" }),
      );
      const rolloutPath = requireRolloutPath(replaced, THREAD_ID);
      await fs.rename(rolloutPath, `${rolloutPath}.old`);
      await fs.writeFile(rolloutPath, data);
      await expect(replaced.reader.read({ threadId: THREAD_ID, marker: MARKER })).resolves.toEqual(
        expect.objectContaining({
          status: "malformed",
          reason: expect.stringContaining("replaced"),
        }),
      );
    } finally {
      await replaced.cleanup();
    }
  });

  it("bounds one pending JSONL record without imposing a total rollout size cap", async () => {
    const oversizedRecord = await createFixture(
      [
        {
          threadId: THREAD_ID,
          data: jsonl([
            sessionMeta(THREAD_ID),
            { type: "event_msg", payload: { type: "token_count", text: "x".repeat(2_000) } },
          ]),
        },
      ],
      { scanChunkBytes: 128, maxRecordBytes: 512 },
    );
    try {
      const result = await readUntilTerminal(oversizedRecord.reader, {
        threadId: THREAD_ID,
        marker: MARKER,
      });
      expect(result).toEqual(
        expect.objectContaining({
          status: "malformed",
          reason: expect.stringContaining("exceeds"),
        }),
      );
    } finally {
      await oversizedRecord.cleanup();
    }
  });
});

function turnPrefix(): Record<string, unknown>[] {
  return [
    sessionMeta(THREAD_ID),
    { type: "event_msg", payload: { type: "task_started", turn_id: TURN_ID } },
    { type: "turn_context", payload: { turn_id: TURN_ID } },
    userMessage(MARKER),
  ];
}

function sessionMeta(threadId: string): Record<string, unknown> {
  return { type: "session_meta", payload: { id: threadId, session_id: threadId } };
}

function userMessage(marker: string): Record<string, unknown> {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `Please help.\n\n[WakeWire correlation: ${marker}]`,
        },
      ],
    },
  };
}

function taskComplete(finalMessage: string): Record<string, unknown> {
  return taskCompleteFor(TURN_ID, finalMessage);
}

function taskCompleteFor(turnId: string, finalMessage: string): Record<string, unknown> {
  return {
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId, last_agent_message: finalMessage },
  };
}

function jsonl(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function readUntilTerminal(
  reader: CodexRolloutCompletionReader,
  input: { threadId: string; marker: string; turnId?: string },
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await reader.read(input);
    if (result.status !== "pending") return result;
  }
  throw new Error("completion reader did not reach a terminal state");
}

function requireRolloutPath(
  fixture: { rolloutPaths: Map<string, string> },
  threadId: string,
): string {
  const rolloutPath = fixture.rolloutPaths.get(threadId);
  if (!rolloutPath) throw new Error(`fixture rollout is missing for ${threadId}`);
  return rolloutPath;
}

function updateRolloutPath(databasePath: string, threadId: string, rolloutPath: string): void {
  const database = new DatabaseConstructor(databasePath);
  database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(rolloutPath, threadId);
  database.close();
}

async function createFixture(
  entries: Array<{ threadId: string; data: string | Buffer }>,
  config: Omit<CodexRolloutCompletionReaderConfig, "stateDatabasePath" | "sessionsRoot"> = {},
): Promise<{
  reader: CodexRolloutCompletionReader;
  cleanup: () => Promise<void>;
  databasePath: string;
  directory: string;
  readRanges: Array<{ position: number; bytesRead: number }>;
  rolloutPaths: Map<string, string>;
  sessionsRoot: string;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wakewire-completion-"));
  const databasePath = path.join(directory, "state.sqlite");
  const sessionsRoot = path.join(directory, "sessions");
  await fs.mkdir(sessionsRoot);
  const database = new DatabaseConstructor(databasePath);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  const insert = database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)");
  const rolloutPaths = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    const rolloutPath = path.join(sessionsRoot, `rollout-${index}-${entry.threadId}.jsonl`);
    await fs.writeFile(rolloutPath, entry.data);
    insert.run(entry.threadId, rolloutPath);
    rolloutPaths.set(entry.threadId, rolloutPath);
  }
  database.close();
  const readRanges: Array<{ position: number; bytesRead: number }> = [];
  return {
    reader: new CodexRolloutCompletionReader(
      { stateDatabasePath: databasePath, sessionsRoot, ...config },
      {
        readChunk: async (handle, buffer, position) => {
          const result = await handle.read(buffer, 0, buffer.length, position);
          readRanges.push({ position, bytesRead: result.bytesRead });
          return result.bytesRead;
        },
      },
    ),
    cleanup: async () => fs.rm(directory, { recursive: true, force: true }),
    databasePath,
    directory,
    readRanges,
    rolloutPaths,
    sessionsRoot,
  };
}

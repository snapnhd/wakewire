import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const UUID = z.uuid();
const MAX_HOOK_INPUT_BYTES = 8 * 1024 * 1024;

export const CLAUDE_RC_PERMISSION_DENIAL_MESSAGE =
  "WakeWire did not approve this interactive permission request. Do not retry the tool or stop the turn. Continue with information already available or explain that the requested action needs explicit approval.";

const HookCommonSchema = z.object({
  session_id: UUID,
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
});

export const ClaudeRcHookEventSchema = z.discriminatedUnion("hook_event_name", [
  HookCommonSchema.extend({
    hook_event_name: z.literal("SessionStart"),
    prompt_id: UUID.optional(),
    source: z.string().min(1),
  }).passthrough(),
  HookCommonSchema.extend({
    hook_event_name: z.literal("UserPromptSubmit"),
    prompt_id: UUID,
    prompt: z.string().min(1).max(MAX_HOOK_INPUT_BYTES),
  }).passthrough(),
  HookCommonSchema.extend({
    hook_event_name: z.literal("PermissionRequest"),
    prompt_id: UUID,
    tool_name: z.string().min(1),
    tool_input: z.record(z.string(), z.unknown()),
    permission_suggestions: z.array(z.unknown()).optional(),
  }).passthrough(),
  HookCommonSchema.extend({
    hook_event_name: z.literal("PostToolUseFailure"),
    prompt_id: UUID,
    tool_name: z.string().min(1),
    tool_input: z.record(z.string(), z.unknown()),
    tool_use_id: z.string().min(1),
    error: z.string().min(1),
    is_interrupt: z.boolean().optional(),
  }).passthrough(),
  HookCommonSchema.extend({
    hook_event_name: z.literal("Stop"),
    prompt_id: UUID,
    stop_hook_active: z.boolean(),
    last_assistant_message: z.string().min(1).max(MAX_HOOK_INPUT_BYTES),
  }).passthrough(),
  HookCommonSchema.extend({
    hook_event_name: z.literal("StopFailure"),
    prompt_id: UUID,
    error: z.string().min(1),
    error_details: z.string().optional(),
    last_assistant_message: z.string().optional(),
  }).passthrough(),
  HookCommonSchema.extend({
    hook_event_name: z.literal("Notification"),
    prompt_id: UUID.optional(),
    notification_type: z.enum(["idle_prompt", "permission_prompt"]),
    message: z.string(),
    title: z.string().optional(),
  }).passthrough(),
  HookCommonSchema.extend({
    hook_event_name: z.literal("SessionEnd"),
    prompt_id: UUID.optional(),
    reason: z.string().min(1),
  }).passthrough(),
]);

export type ClaudeRcHookEvent = z.infer<typeof ClaudeRcHookEventSchema>;

export const ClaudeRcHookEnvelopeSchema = z
  .object({
    version: z.literal(1),
    eventId: UUID,
    receivedAt: z.iso.datetime({ offset: true }),
    monotonicNs: z.string().regex(/^\d+$/),
    event: ClaudeRcHookEventSchema,
  })
  .strict();

export type ClaudeRcHookEnvelope = z.infer<typeof ClaudeRcHookEnvelopeSchema>;

export interface RunClaudeRcHookOptions {
  input?: NodeJS.ReadableStream | undefined;
  now?: (() => Date) | undefined;
  randomUuid?: (() => string) | undefined;
  monotonicNs?: (() => bigint) | undefined;
}

export interface RunClaudeRcHookResult {
  destination: string;
  hookOutput?: {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest";
      decision: {
        behavior: "deny";
        message: string;
        interrupt: false;
      };
    };
  };
}

/**
 * Persist one Claude lifecycle hook without talking to the WakeWire daemon.
 * Files are append-only capabilities: every event gets a fresh exclusive file,
 * so a daemon restart cannot lose or overwrite a completion notification.
 */
export async function runClaudeRcHook(
  args: readonly string[],
  options: RunClaudeRcHookOptions = {},
): Promise<RunClaudeRcHookResult> {
  const parsedArgs = parseArgs(args);
  const input = await readBounded(options.input ?? process.stdin, MAX_HOOK_INPUT_BYTES);
  const event = ClaudeRcHookEventSchema.parse(JSON.parse(input));
  if (event.session_id !== parsedArgs.sessionId) {
    throw new Error("Claude RC hook session id does not match its immutable binding");
  }
  await assertPrivateDirectory(parsedArgs.eventDir);

  const eventId = z.uuid().parse((options.randomUuid ?? randomUUID)());
  const receivedAt = (options.now ?? (() => new Date()))().toISOString();
  const monotonicNs = (options.monotonicNs ?? process.hrtime.bigint)().toString();
  const envelope: ClaudeRcHookEnvelope = {
    version: 1,
    eventId,
    receivedAt,
    monotonicNs,
    event,
  };
  const destination = path.join(parsedArgs.eventDir, `event-${receivedAt}-${eventId}.json`);
  const handle = await open(destination, "wx", 0o600);
  try {
    assertPrivateOwnedFile(await handle.stat(), destination);
    await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (event.hook_event_name !== "PermissionRequest") return { destination };
  return {
    destination,
    hookOutput: {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: CLAUDE_RC_PERMISSION_DENIAL_MESSAGE,
          interrupt: false,
        },
      },
    },
  };
}

function parseArgs(args: readonly string[]): { eventDir: string; sessionId: string } {
  let eventDir = "";
  let sessionId = "";
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--event-dir") {
      eventDir = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (value === "--session-id") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown Claude RC hook argument: ${value ?? "<missing>"}`);
  }
  if (!path.isAbsolute(eventDir))
    throw new Error("Claude RC hook event directory must be absolute");
  z.uuid().parse(sessionId);
  return { eventDir: path.resolve(eventDir), sessionId };
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const entry = await lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Claude RC hook path is not a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && entry.uid !== uid) {
    throw new Error(`Claude RC hook directory is not owned by the current user: ${directory}`);
  }
  if ((entry.mode & 0o077) !== 0) {
    throw new Error(`Claude RC hook directory is not private: ${directory}`);
  }
}

function assertPrivateOwnedFile(entry: Stats, filename: string): void {
  const uid = process.getuid?.();
  if (!entry.isFile() || (entry.mode & 0o077) !== 0 || (uid !== undefined && entry.uid !== uid)) {
    throw new Error(`Claude RC hook event file is not private: ${filename}`);
  }
}

async function readBounded(stream: NodeJS.ReadableStream, maximum: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes > maximum) throw new Error(`Claude RC hook input exceeded ${maximum} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  void runClaudeRcHook(process.argv.slice(2))
    .then((result) => {
      if (result.hookOutput) process.stdout.write(`${JSON.stringify(result.hookOutput)}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `Claude RC hook failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

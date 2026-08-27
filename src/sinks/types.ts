import type { SandboxPolicy } from "../core/route.js";

/** Reasoning efforts exposed by the installed Codex model catalog. */
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface HermesSessionOptions {
  /** github | linear — becomes HERMES_SESSION_PLATFORM and session source */
  platform: "github" | "linear";
  /** Nested roles.yaml user id: github login or linear email (no prefix). */
  userId: string;
  userName?: string | undefined;
  /**
   * Stable chat/target id for the WorkItem (not per-delivery).
   * e.g. wakewire:github:snapnhd/system#997 or wakewire:linear:FRA-2818
   */
  chatId?: string | undefined;
  /** Hermes desktop sidebar title, e.g. snapnhd/system#997 or FRA-2818 · … */
  sessionTitle?: string | undefined;
  /** Stable session_key per WorkItem target (desktop grouping / resume). */
  sessionKey?: string | undefined;
  /** Sidebar subtitle / display_name (login or email). */
  displayName?: string | undefined;
}

export interface DeliveryOptions {
  sandbox: SandboxPolicy;
  /** Working directory override (used for new threads; ignored for resume by some adapters). */
  cwd?: string | undefined;
  /** Per-delivery model override. Adapter configuration remains the fallback. */
  model?: string | undefined;
  /** Per-delivery Codex reasoning effort. */
  reasoningEffort?: CodexReasoningEffort | undefined;
  /** Stable provider/request id used to recover a submitted first turn after a crash. */
  idempotencyKey?: string | undefined;
  /** Internal: task was host-prepared and may not be materialized in Desktop until activation. */
  preparedThread?: boolean | undefined;
  /** Cooperative cancellation for local provisioning and adapters that support it. */
  signal?: AbortSignal | undefined;
  /**
   * Path D Hermes sink stamp. Required when adapter is `hermes`; ignored by Codex/Claude sinks.
   * Maps to gateway-role-policy via HERMES_SESSION_PLATFORM + HERMES_SESSION_USER_ID.
   */
  hermesSession?: HermesSessionOptions | undefined;
}

export interface DeliveryResult {
  threadId: string;
  turnId?: string | undefined;
  /** Exact durable marker used to bind a Desktop rollout to this request. */
  correlationMarker?: string | undefined;
  /** Final agent message when the adapter runs the turn to completion (SDK/exec adapters). */
  finalResponse?: string | undefined;
}

export interface InterruptResult {
  threadId: string;
  interruptedTurnId?: string | undefined;
}

export interface PrepareThreadOptions extends DeliveryOptions {
  cwd: string;
  idempotencyKey: string;
}

/**
 * Immutable evidence available when reconciling a turn that WakeWire already
 * recorded as submitted. There is intentionally no prompt field: a recovery
 * implementation may inspect the exact durable marker, session, transcript,
 * cwd, and process binding, but it must never paste or replay model input.
 */
export interface SubmittedDeliveryRecoveryOptions {
  requestId: string;
  correlationMarker: string;
  cwd: string;
  signal?: AbortSignal | undefined;
}

/**
 * The one seam between wakewire and any coding agent. v1 ships Codex
 * implementations only; a Claude Code adapter would implement this interface.
 */
export interface AgentAdapter {
  readonly name: string;
  /** Append a turn to an existing thread. */
  deliverToThread(threadId: string, prompt: string, opts: DeliveryOptions): Promise<DeliveryResult>;
  /** Start a new thread in opts.cwd and send the prompt as its first turn. */
  startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult>;
  /**
   * Ensure an empty persistent task exists without starting a model turn.
   * The idempotency key must recover the same task after a crash.
   */
  prepareThread?(opts: PrepareThreadOptions): Promise<{ threadId: string }>;
  /** Set cosmetic task metadata. Failure must never cause a turn to be resubmitted. */
  setThreadTitle?(threadId: string, title: string): Promise<void>;
  /** Read persisted cosmetic metadata when the adapter can verify it safely. */
  readThreadTitle?(threadId: string): Promise<string | null>;
  /** Stop the active turn in an existing task when the adapter can enforce it. */
  interruptThread?(threadId: string): Promise<InterruptResult>;
  /**
   * Observe an already-submitted turn without sending any input.
   *
   * Return the exact completed result only when durable evidence proves it,
   * return null while the outcome remains ambiguous, or throw
   * SubmittedDeliveryInterruptedError for a proven terminal interruption.
   * Implementations must not call start/resume, paste, submit, or otherwise
   * cause a model turn from this recovery-only path.
   */
  recoverSubmittedTurn?(
    threadId: string,
    opts: SubmittedDeliveryRecoveryOptions,
  ): Promise<DeliveryResult | null>;
  /** Cheap reachability check — used to decide held-vs-failed and for status reporting. */
  probe(): Promise<boolean>;
  /** Release connections/child processes on daemon shutdown. */
  close?(): void;
}

/** The target thread has a turn in flight. Retry later; never a failure. */
export class BusyError extends Error {}

/** Codex (app-server or CLI) is not reachable. Retry with backoff, forever. */
export class UnreachableError extends Error {}

/** Delivery can never succeed (unknown thread, invalid target). Fail immediately. */
export class PermanentError extends Error {}

/**
 * Delivery was rejected before an adapter submitted anything to a model.
 *
 * Workers may safely treat this differently from failures observed after a
 * child process or remote request was started, where replay could duplicate a
 * turn. It remains a PermanentError for existing callers.
 */
export class DeliveryNotSubmittedError extends PermanentError {}

/**
 * A durably submitted turn reached an exact terminal interruption without a
 * model-authored final response. It is safe to fail this turn once, notify the
 * source, and release later FIFO turns; it is never safe to replay it.
 */
export class SubmittedDeliveryInterruptedError extends Error {
  constructor(
    message: string,
    readonly sourceReply: string,
  ) {
    super(message);
    this.name = "SubmittedDeliveryInterruptedError";
  }
}

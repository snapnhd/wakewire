import crypto from "node:crypto";
import {
  PermanentSourceReplyError,
  RetryableSourceReplyError,
  type SourceReplyResponderRegistry,
  type SourceReplySendResult,
} from "./reply-responders.js";
import {
  type AgentRequestStore,
  type SourceReplyClaim,
  type SourceReplyJob,
  SourceReplyLeaseConflictError,
} from "./store.js";

export class MissingSourceReplyResponderError extends PermanentSourceReplyError {}

export class SourceReplyDispatcher {
  constructor(private readonly responders: SourceReplyResponderRegistry) {}

  async dispatch(job: SourceReplyJob, signal?: AbortSignal): Promise<SourceReplySendResult> {
    const responder = this.responders.get(job.provider);
    if (!responder) {
      throw new MissingSourceReplyResponderError(`no source reply responder for ${job.provider}`);
    }
    return responder.send(job, signal);
  }
}

export interface SourceReplyWorkerOptions {
  tickMs?: number | undefined;
  initialBackoffMs?: number | undefined;
  backoffCapMs?: number | undefined;
  sendTimeoutMs?: number | undefined;
  leaseMs?: number | undefined;
  leaseOwner?: string | undefined;
  now?: (() => Date) | undefined;
}

/** Crash-safe final-response outbox, independent of progress acknowledgments. */
export class SourceReplyWorker {
  private readonly tickMs: number;
  private readonly initialBackoffMs: number;
  private readonly backoffCapMs: number;
  private readonly sendTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly leaseOwner: string;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private readonly activeControllers = new Set<AbortController>();
  private stopping = false;

  constructor(
    private readonly store: AgentRequestStore,
    private readonly dispatcher: SourceReplyDispatcher,
    options: SourceReplyWorkerOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 100;
    this.initialBackoffMs = options.initialBackoffMs ?? 250;
    this.backoffCapMs = options.backoffCapMs ?? 60_000;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 35_000;
    this.leaseMs = options.leaseMs ?? 45_000;
    this.leaseOwner =
      options.leaseOwner?.trim() || `source-reply:${process.pid}:${crypto.randomUUID()}`;
    this.now = options.now ?? (() => new Date());
    if (this.leaseMs <= this.sendTimeoutMs) {
      throw new TypeError("source reply leaseMs must exceed sendTimeoutMs");
    }
  }

  start(): number {
    if (this.timer) return 0;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    return 0;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const controller of this.activeControllers) controller.abort();
    if (this.activeTick) await this.activeTick;
  }

  wake(): void {
    if (!this.stopping) void this.tick();
  }

  async tick(): Promise<void> {
    if (this.stopping || this.activeTick) return;
    const active = this.runTick();
    this.activeTick = active;
    try {
      await active;
    } finally {
      if (this.activeTick === active) this.activeTick = null;
    }
  }

  private async runTick(): Promise<void> {
    const claimedAt = this.now();
    const [job] = this.store.claimSourceReplies({
      leaseOwner: this.leaseOwner,
      at: claimedAt.toISOString(),
      leaseExpiresAt: new Date(claimedAt.getTime() + this.leaseMs).toISOString(),
      // A single global lane also keeps multiple Slack replies from racing the
      // provider's per-conversation write limit.
      limit: 1,
    });
    if (job && !this.stopping) await this.process(job);
  }

  private async process(job: SourceReplyClaim): Promise<void> {
    if (this.stopping) return;
    const controller = new AbortController();
    this.activeControllers.add(controller);
    try {
      let result: SourceReplySendResult;
      try {
        result = await withTimeout(
          this.dispatcher.dispatch(job, controller.signal),
          this.sendTimeoutMs,
          `source reply timed out after ${this.sendTimeoutMs}ms`,
          () => controller.abort(),
        );
      } catch (error) {
        this.transitionFailure(job, error);
        return;
      }
      try {
        this.store.markSourceReplySent(job.id, this.leaseOwner, result.providerResultId);
      } catch (error) {
        // A replacement owner will reconcile Slack by client_msg_id before it
        // posts. Never mutate a lease that this process no longer owns.
        if (!(error instanceof SourceReplyLeaseConflictError)) throw error;
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  private transitionFailure(job: SourceReplyClaim, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
      if (error instanceof PermanentSourceReplyError) {
        this.store.markSourceReplyFailed(job.id, this.leaseOwner, message);
        return;
      }
      const exponent = Math.min(Math.max(0, job.deliveryAttempt - 1), 30);
      const exponentialDelay = Math.min(this.backoffCapMs, this.initialBackoffMs * 2 ** exponent);
      const delay = Math.max(
        exponentialDelay,
        error instanceof RetryableSourceReplyError ? error.retryAfterMs : 0,
        // The underlying promise may still be settling after the outer guard.
        // Do not let another process claim this effect immediately.
        error instanceof SourceReplySendTimeoutError ? this.leaseMs : 0,
      );
      this.store.holdSourceReply(
        job.id,
        this.leaseOwner,
        message,
        new Date(this.now().getTime() + delay).toISOString(),
      );
    } catch (transitionError) {
      if (!(transitionError instanceof SourceReplyLeaseConflictError)) throw transitionError;
    }
  }
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SourceReplySendTimeoutError(message));
      onTimeout();
    }, timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class SourceReplySendTimeoutError extends Error {}

import {
  type AckResponderRegistry,
  type AckSendResult,
  PermanentAckError,
} from "./responders/types.js";
import type { AckJob, AgentRequestStore } from "./store.js";

export class MissingAckResponderError extends PermanentAckError {}

/** Routes one durable acknowledgment job to its provider implementation. */
export class AckDispatcher {
  constructor(private readonly responders: AckResponderRegistry) {}

  async dispatch(job: AckJob, signal?: AbortSignal): Promise<AckSendResult> {
    const responder = this.responders.get(job.provider);
    if (!responder) {
      throw new MissingAckResponderError(`no acknowledgment responder for ${job.provider}`);
    }
    return responder.send(job, signal);
  }
}

export interface AckWorkerOptions {
  /** Independent fast polling loop; Codex delivery does not share this timer. */
  tickMs?: number | undefined;
  initialBackoffMs?: number | undefined;
  backoffCapMs?: number | undefined;
  /** Bound one provider call so a hung integration cannot block every ack. */
  sendTimeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

/** Crash-safe, ordered acknowledgment outbox worker. */
export class AckWorker {
  private readonly tickMs: number;
  private readonly initialBackoffMs: number;
  private readonly backoffCapMs: number;
  private readonly sendTimeoutMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private readonly activeControllers = new Set<AbortController>();
  private stopping = false;

  constructor(
    private readonly store: AgentRequestStore,
    private readonly dispatcher: AckDispatcher,
    options: AckWorkerOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 100;
    this.initialBackoffMs = options.initialBackoffMs ?? 250;
    this.backoffCapMs = options.backoffCapMs ?? 60_000;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 8_000;
    this.now = options.now ?? (() => new Date());
  }

  /** Reset crash-left `sending` jobs before the independent worker begins. */
  start(): number {
    if (this.timer) return 0;
    this.stopping = false;
    const recovered = this.store.resetAckInFlight();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    return recovered;
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

  /** Prompt an immediate pass after the coordinator commits an outbox row. */
  wake(): void {
    if (this.stopping) return;
    void this.tick();
  }

  /** Process ready jobs oldest first; exposed for deterministic tests and diagnostics. */
  async tick(): Promise<void> {
    if (this.stopping || this.activeTick) return;
    const activeTick = this.runTick();
    this.activeTick = activeTick;
    try {
      await activeTick;
    } finally {
      if (this.activeTick === activeTick) this.activeTick = null;
    }
  }

  private async runTick(): Promise<void> {
    const ready = this.store.listAcksReady(this.now().toISOString());
    // Preserve durable claim order, but do not let one slow provider hold up
    // acknowledgments for unrelated services.
    await Promise.all(ready.map((job) => (this.stopping ? Promise.resolve() : this.process(job))));
  }

  private async process(job: AckJob): Promise<void> {
    if (this.stopping) return;
    const claimed = this.store.claimAckForSend(job.id, this.now().toISOString());
    if (!claimed) return;
    const controller = new AbortController();
    this.activeControllers.add(controller);
    try {
      const result = await withTimeout(
        this.dispatcher.dispatch(claimed, controller.signal),
        this.sendTimeoutMs,
        `acknowledgment timed out after ${this.sendTimeoutMs}ms`,
        () => controller.abort(),
      );
      this.store.markAckSent(claimed.id, result.providerResultId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentAckError) {
        this.store.markAckFailed(claimed.id, message);
        return;
      }
      const exponent = Math.min(claimed.attemptCount, 30);
      const delay = Math.min(this.backoffCapMs, this.initialBackoffMs * 2 ** exponent);
      const nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
      this.store.holdAck(claimed.id, message, nextAttemptAt);
    } finally {
      this.activeControllers.delete(controller);
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
      reject(new Error(message));
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

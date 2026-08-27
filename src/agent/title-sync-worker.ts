import type { Logger } from "../logging.js";
import type { AgentAdapter } from "../sinks/types.js";
import type { WorkItem, WorkItemStore } from "./store.js";
import { providerAwareStoredTitle } from "./thread-title.js";

export interface ThreadTitleWorkerOptions {
  tickMs?: number | undefined;
  batchSize?: number | undefined;
}

/** Upgrade only WakeWire-owned work-item metadata; Desktop state remains untouched here. */
export function upgradeLegacyTaskTitles(store: WorkItemStore): number {
  let upgraded = 0;
  for (const item of store.list()) {
    const title = providerAwareStoredTitle(item.canonicalKind, item.title);
    if (title !== item.title && store.updateTitle(item.id, title)) upgraded++;
  }
  return upgraded;
}

/**
 * Reconciles cosmetic task titles independently from turn delivery. A failed
 * rename can retry without ever resubmitting the authenticated request.
 */
export class ThreadTitleWorker {
  private readonly tickMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private stopping = false;
  private readonly diagnostics = new Map<string, string>();

  constructor(
    private readonly store: WorkItemStore,
    private readonly adapter: AgentAdapter,
    private readonly logger: Logger,
    options: ThreadTitleWorkerOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 1_000;
    this.batchSize = options.batchSize ?? 50;
    if (!Number.isSafeInteger(this.tickMs) || this.tickMs <= 0) {
      throw new TypeError("title sync tickMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize <= 0) {
      throw new TypeError("title sync batchSize must be a positive integer");
    }
  }

  start(): number {
    if (this.timer) return 0;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    void this.tick();
    return 0;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeTick) await this.activeTick;
  }

  wake(): void {
    if (!this.stopping) void this.tick();
  }

  /** Reassert after Desktop's first-turn auto-naming has reached a terminal state. */
  reassert(workItemId: string, threadId: string): void {
    if (!this.store.markCodexThreadTitleDirty(workItemId, threadId)) return;
    this.diagnostics.delete(workItemId);
    this.wake();
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.activeTick) return this.activeTick;
    const operation = this.runTick();
    this.activeTick = operation;
    try {
      await operation;
    } finally {
      if (this.activeTick === operation) this.activeTick = null;
    }
  }

  private async runTick(): Promise<void> {
    if (!this.adapter.setThreadTitle) return;
    for (const item of this.store.listTitleSyncCandidates(this.batchSize)) {
      await this.reconcile(item);
    }
  }

  private async reconcile(candidate: WorkItem): Promise<void> {
    const current = this.store.get(candidate.id);
    const threadId = current?.codexThreadId;
    if (!current || !threadId || current.title !== candidate.title) return;
    try {
      // `codexThreadTitle` being dirty is the durable signal that Codex's
      // metadata path and same-connection readback must run again. A loaded
      // Desktop renderer may still retain its own cached auto-generated title.
      await this.adapter.setThreadTitle?.(threadId, current.title);
      if (this.adapter.readThreadTitle) {
        const confirmed = await this.adapter.readThreadTitle(threadId);
        if (confirmed !== current.title) {
          throw new Error(
            `title readback mismatch (expected ${JSON.stringify(current.title)}, got ${JSON.stringify(confirmed)})`,
          );
        }
      }
      if (!this.store.confirmCodexThreadTitle(current.id, threadId, current.title)) return;
      this.diagnostics.delete(current.id);
      this.logger.info(
        { workItem: current.id, threadId, title: current.title },
        "Codex task title reconciled",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.diagnostics.get(current.id) === message) return;
      this.diagnostics.set(current.id, message);
      this.logger.warn(
        { workItem: current.id, threadId, title: current.title, err: message },
        "Codex task title reconciliation failed; will retry without resubmitting the turn",
      );
    }
  }
}

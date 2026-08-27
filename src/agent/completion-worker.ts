import type { Logger } from "../logging.js";
import type { AgentAdapter } from "../sinks/types.js";
import { PermanentError } from "../sinks/types.js";
import type { CodexCompletionReadResult } from "./completion.js";
import { CodexRolloutCompletionReader } from "./completion.js";
import { DEFAULT_EXECUTION_PROFILE } from "./execution-profile.js";
import { ParentReportFence } from "./parent-report-fence.js";
import {
  buildFinalReplySpec,
  InvalidSourceReplyEventError,
  UnsupportedSourceReplyEventError,
} from "./reply.js";
import { renderSeparateTaskReportPrompt } from "./safety.js";
import type { AgentRequest, AgentRequestStore } from "./store.js";
import { SourceReplyConflictError } from "./store.js";

export interface CodexCompletionReader {
  read(input: {
    threadId: string;
    marker: string;
    turnId?: string | undefined;
  }): Promise<CodexCompletionReadResult>;
}

export interface CompletionWorkerOptions {
  tickMs?: number | undefined;
  onTerminal?: ((request: AgentRequest) => void) | undefined;
  adapter?: AgentAdapter | undefined;
  parentReportFence?: ParentReportFence | undefined;
}

/**
 * Polls only requests durably bound to one Desktop task and marker. Provider
 * delivery remains a separate outbox effect handled by SourceReplyWorker.
 */
export class CompletionWorker {
  private readonly tickMs: number;
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private stopping = false;
  private readonly diagnostics = new Map<string, string>();
  private readonly onTerminal: (request: AgentRequest) => void;
  private readonly adapter: AgentAdapter | null;
  private readonly parentReportFence: ParentReportFence;

  constructor(
    private readonly store: AgentRequestStore,
    private readonly reader: CodexCompletionReader,
    private readonly logger: Logger,
    private readonly onReplyQueued: () => void = () => {},
    options: CompletionWorkerOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 250;
    if (!Number.isSafeInteger(this.tickMs) || this.tickMs <= 0) {
      throw new TypeError("completion tickMs must be a positive integer");
    }
    this.onTerminal = options.onTerminal ?? (() => {});
    this.adapter = options.adapter ?? null;
    this.parentReportFence = options.parentReportFence ?? new ParentReportFence();
  }

  static live(
    store: AgentRequestStore,
    logger: Logger,
    onReplyQueued: () => void,
    options: CompletionWorkerOptions = {},
  ): CompletionWorker {
    return new CompletionWorker(
      store,
      new CodexRolloutCompletionReader(),
      logger,
      onReplyQueued,
      options,
    );
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

  async tick(): Promise<void> {
    if (this.stopping || this.activeTick) return;
    const operation = this.runTick();
    this.activeTick = operation;
    try {
      await operation;
    } finally {
      if (this.activeTick === operation) this.activeTick = null;
    }
  }

  private async runTick(): Promise<void> {
    await Promise.all(
      this.store.listChildAwaitingCompletion().map((request) => this.inspectChild(request)),
    );
    await Promise.all(
      this.store
        .listChildCompletedAwaitingReport()
        .map((request) => this.submitParentReport(request)),
    );
    await Promise.all(
      this.store.listSubmittedAwaitingCompletion().map((request) => this.inspect(request)),
    );
    await this.reconcileChildTitles();
  }

  private async reconcileChildTitles(): Promise<void> {
    if (!this.adapter?.setThreadTitle || !this.adapter.readThreadTitle) return;
    const adapter = this.adapter;
    await Promise.all(
      this.store.listChildTitleSyncCandidates().map(async (orchestration) => {
        const childThreadId = orchestration.childThreadId;
        if (!childThreadId) return;
        try {
          await adapter.setThreadTitle?.(childThreadId, orchestration.childTitle);
          const confirmed = await adapter.readThreadTitle?.(childThreadId);
          if (confirmed !== orchestration.childTitle) {
            throw new Error(
              `title readback mismatch (expected ${JSON.stringify(orchestration.childTitle)}, got ${JSON.stringify(confirmed)})`,
            );
          }
          if (
            this.store.confirmChildTitleSynchronized(
              orchestration.requestId,
              childThreadId,
              orchestration.childTitle,
            )
          ) {
            this.logger.info(
              {
                request: orchestration.requestId,
                childThreadId,
                title: orchestration.childTitle,
              },
              "child Codex task title synchronized",
            );
          }
        } catch (error) {
          this.logger.warn(
            {
              request: orchestration.requestId,
              childThreadId,
              err: errorMessage(error),
            },
            "child Codex task title synchronization remains pending",
          );
        }
      }),
    );
  }

  private async inspectChild(request: AgentRequest): Promise<void> {
    const current = this.store.get(request.id);
    const orchestration = this.store.orchestrationForRequest(request.id);
    if (
      current?.status !== "submitted" ||
      orchestration?.stage !== "child_submitted" ||
      !orchestration.childThreadId ||
      !orchestration.childCorrelationMarker
    ) {
      return;
    }

    let result: CodexCompletionReadResult;
    try {
      result = await this.reader.read({
        threadId: orchestration.childThreadId,
        marker: orchestration.childCorrelationMarker,
        ...(orchestration.childTurnId ? { turnId: orchestration.childTurnId } : {}),
      });
    } catch (error) {
      this.report(current, "error", `child completion reader failed: ${errorMessage(error)}`);
      return;
    }
    if (result.status === "pending") {
      this.report(current, "debug", `child pending: ${result.reason}`);
      return;
    }
    if (result.status === "malformed" || result.status === "ambiguous") {
      this.report(current, "warn", `child ${result.status}: ${result.reason}`);
      return;
    }
    if (result.status === "aborted") {
      this.diagnostics.delete(current.id);
      this.store.setStatus(
        current.id,
        "failed",
        `child Codex Desktop turn ${result.turnId} aborted: ${result.abortReason}`,
      );
      this.logger.info(
        {
          request: current.id,
          parentThreadId: orchestration.parentThreadId,
          childThreadId: result.threadId,
          childTurnId: result.turnId,
        },
        "host-controlled child task ended without a parent report",
      );
      return;
    }

    this.store.markChildCompleted(current.id, result.finalMessage);
    this.diagnostics.delete(current.id);
    this.logger.info(
      {
        request: current.id,
        parentThreadId: orchestration.parentThreadId,
        childThreadId: result.threadId,
        childTurnId: result.turnId,
      },
      "host-controlled child result persisted for parent reporting",
    );
  }

  private async submitParentReport(request: AgentRequest): Promise<void> {
    const current = this.store.get(request.id);
    const orchestration = this.store.orchestrationForRequest(request.id);
    if (
      current?.status !== "submitted" ||
      orchestration?.stage !== "child_completed" ||
      !orchestration.parentThreadId ||
      !orchestration.childFinalResponse
    ) {
      return;
    }
    if (!this.adapter) {
      this.report(current, "error", "parent report adapter is unavailable");
      return;
    }
    const adapter = this.adapter;
    const parentThreadId = orchestration.parentThreadId;
    const prompt = renderSeparateTaskReportPrompt(
      orchestration.reportPromptPrefix,
      orchestration.reportPromptSuffix,
      orchestration.childFinalResponse,
    );
    try {
      await this.parentReportFence.run(current.id, async (signal) => {
        // Registration happens before this recheck. A stop that won the
        // durable transition either blocks run() or makes this return without
        // touching Desktop; a later stop aborts this exact signal and drains it.
        const permitted = this.store.get(current.id);
        const permittedOrchestration = this.store.orchestrationForRequest(current.id);
        if (
          permitted?.status !== "submitted" ||
          permittedOrchestration?.stage !== "child_completed"
        ) {
          return;
        }
        const result = await adapter.deliverToThread(parentThreadId, prompt, {
          sandbox: orchestration.sandbox,
          cwd: orchestration.cwd,
          model: DEFAULT_EXECUTION_PROFILE.model,
          reasoningEffort: DEFAULT_EXECUTION_PROFILE.reasoningEffort,
          idempotencyKey: `${current.id}:parent-report`,
          preparedThread: true,
          signal,
        });
        const latest = this.store.get(current.id);
        const latestOrchestration = this.store.orchestrationForRequest(current.id);
        if (latest?.status !== "submitted" || latestOrchestration?.stage !== "child_completed") {
          return;
        }
        if (!result?.correlationMarker) {
          throw new PermanentError(
            `${adapter.name} did not return a durable parent report correlation marker`,
          );
        }
        this.store.bindParentReport({
          requestId: current.id,
          parentThreadId,
          ...(result.turnId ? { parentTurnId: result.turnId } : {}),
          correlationMarker: result.correlationMarker,
        });
        this.diagnostics.delete(current.id);
        this.logger.info(
          {
            request: current.id,
            parentThreadId: orchestration.parentThreadId,
            parentTurnId: result.turnId,
          },
          "child result submitted once to its parent Codex task",
        );
      });
    } catch (error) {
      const message = `parent report submission failed: ${errorMessage(error)}`;
      if (error instanceof PermanentError) {
        this.store.setStatus(current.id, "failed", message);
      }
      this.report(current, error instanceof PermanentError ? "warn" : "debug", message);
    }
  }

  private async inspect(request: AgentRequest): Promise<void> {
    const current = this.store.get(request.id);
    if (
      current?.status !== "submitted" ||
      !current.codexThreadId ||
      !current.correlationMarker ||
      this.store.sourceReplyForRequest(current.id)
    ) {
      return;
    }

    let result: CodexCompletionReadResult;
    try {
      result = await this.reader.read({
        threadId: current.codexThreadId,
        marker: current.correlationMarker,
        ...(current.codexTurnId ? { turnId: current.codexTurnId } : {}),
      });
    } catch (error) {
      this.report(current, "error", `completion reader failed: ${errorMessage(error)}`);
      return;
    }

    if (result.status === "pending") {
      this.report(current, "debug", result.reason);
      return;
    }
    if (result.status === "malformed" || result.status === "ambiguous") {
      this.report(current, "warn", `${result.status}: ${result.reason}`);
      return;
    }
    if (result.status === "aborted") {
      this.diagnostics.delete(current.id);
      this.onTerminal(current);
      this.store.setStatus(
        current.id,
        "failed",
        `Codex Desktop turn ${result.turnId} aborted: ${result.abortReason}`,
      );
      this.logger.info(
        { request: current.id, threadId: result.threadId, turnId: result.turnId },
        "Codex Desktop request ended without a final source reply",
      );
      return;
    }

    this.onTerminal(current);
    try {
      const spec = buildFinalReplySpec(current.event, result.finalMessage);
      const job = this.store.enqueueFinalReply({
        requestId: current.id,
        codexTurnId: result.turnId,
        spec,
      });
      this.diagnostics.delete(current.id);
      this.logger.info(
        {
          request: current.id,
          reply: job.id,
          provider: job.provider,
          threadId: result.threadId,
          turnId: result.turnId,
        },
        "queued completed Codex answer for its originating source thread",
      );
      this.onReplyQueued();
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof UnsupportedSourceReplyEventError) {
        this.diagnostics.delete(current.id);
        this.store.setStatus(current.id, "completed");
        this.logger.info(
          {
            request: current.id,
            provider: current.event.source,
            threadId: result.threadId,
            turnId: result.turnId,
          },
          "Codex Desktop request completed; final answer remains in Desktop for this provider",
        );
        return;
      }
      if (
        error instanceof InvalidSourceReplyEventError ||
        error instanceof SourceReplyConflictError
      ) {
        this.store.setStatus(current.id, "failed", `cannot queue final source reply: ${message}`);
      }
      this.report(current, "warn", `cannot queue final source reply: ${message}`);
    }
  }

  /** Log a stable state once rather than every 250 ms poll. */
  private report(request: AgentRequest, level: "debug" | "warn" | "error", message: string): void {
    const key = `${level}:${message}`;
    if (this.diagnostics.get(request.id) === key) return;
    this.diagnostics.set(request.id, key);
    this.logger[level](
      {
        request: request.id,
        threadId: request.codexThreadId,
        turnId: request.codexTurnId,
        completionStatus: message,
      },
      "Codex Desktop completion state changed",
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/db.js";
import type { Logger } from "../logging.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "../sinks/types.js";
import { WorkItemStore } from "./store.js";
import { ThreadTitleWorker, upgradeLegacyTaskTitles } from "./title-sync-worker.js";

class TitleAdapter implements AgentAdapter {
  readonly name = "title-test";
  readonly setCalls: Array<{ threadId: string; title: string }> = [];
  actual = new Map<string, string>();
  failures = 0;
  afterSet: (() => void) | null = null;

  async deliverToThread(): Promise<DeliveryResult> {
    throw new Error("turn delivery must not be used by title reconciliation");
  }

  async startThread(_prompt: string, _opts: DeliveryOptions): Promise<DeliveryResult> {
    throw new Error("turn delivery must not be used by title reconciliation");
  }

  async setThreadTitle(threadId: string, title: string): Promise<void> {
    this.setCalls.push({ threadId, title });
    if (this.failures > 0) {
      this.failures--;
      throw new Error("temporary metadata failure");
    }
    this.actual.set(threadId, title);
    this.afterSet?.();
  }

  async readThreadTitle(threadId: string): Promise<string | null> {
    return this.actual.get(threadId) ?? null;
  }

  async probe(): Promise<boolean> {
    return true;
  }
}

function fixture(title = "Slack — Check the deploy") {
  const store = new WorkItemStore(openDatabase(":memory:"));
  const item = store.getOrCreate({ kind: "slack", key: "T:C:1", title });
  store.setCodexThread(item.id, "thread-1");
  const adapter = new TitleAdapter();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  return { store, item, adapter, logger };
}

describe("ThreadTitleWorker", () => {
  it("upgrades and dirties legacy WakeWire-owned task titles for startup reconciliation", () => {
    const context = fixture("CJ — Check the deploy");
    context.store.setCodexThreadTitle(context.item.id, "CJ — Check the deploy");

    expect(upgradeLegacyTaskTitles(context.store)).toBe(1);
    expect(context.store.get(context.item.id)).toMatchObject({
      title: "Slack — Check the deploy",
      codexThreadTitle: null,
    });
    expect(upgradeLegacyTaskTitles(context.store)).toBe(0);
  });

  it("retries a transient metadata failure without delivering another turn", async () => {
    const context = fixture();
    context.adapter.failures = 1;
    const worker = new ThreadTitleWorker(context.store, context.adapter, context.logger);

    await worker.tick();
    expect(context.store.get(context.item.id)?.codexThreadTitle).toBeNull();
    await worker.tick();

    expect(context.adapter.setCalls).toHaveLength(2);
    expect(context.store.get(context.item.id)?.codexThreadTitle).toBe("Slack — Check the deploy");
  });

  it("reasserts the desired title after Desktop auto-naming overwrites it", async () => {
    const context = fixture();
    context.adapter.actual.set("thread-1", "Slack — Check the deploy");
    context.store.setCodexThreadTitle(context.item.id, "Slack — Check the deploy");
    context.adapter.actual.set("thread-1", "Review WakeWire safety policy");
    const worker = new ThreadTitleWorker(context.store, context.adapter, context.logger);

    worker.reassert(context.item.id, "thread-1");
    await worker.tick();

    expect(context.adapter.actual.get("thread-1")).toBe("Slack — Check the deploy");
    expect(context.store.get(context.item.id)?.codexThreadTitle).toBe("Slack — Check the deploy");
  });

  it("reasserts an already-correct persisted title through the metadata path", async () => {
    const context = fixture();
    context.adapter.actual.set("thread-1", "Slack — Check the deploy");
    const worker = new ThreadTitleWorker(context.store, context.adapter, context.logger);

    await worker.tick();

    expect(context.adapter.setCalls).toEqual([
      { threadId: "thread-1", title: "Slack — Check the deploy" },
    ]);
    expect(context.store.get(context.item.id)?.codexThreadTitle).toBe("Slack — Check the deploy");
  });

  it("does not confirm a stale task id when the work item is rebound during the write", async () => {
    const context = fixture();
    context.adapter.afterSet = () => context.store.setCodexThread(context.item.id, "thread-2");
    const worker = new ThreadTitleWorker(context.store, context.adapter, context.logger);

    await worker.tick();

    expect(context.store.get(context.item.id)).toMatchObject({
      codexThreadId: "thread-2",
      codexThreadTitle: null,
    });
  });
});

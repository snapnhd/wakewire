interface ActiveParentReport {
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
}

export interface ParentReportRunResult<T> {
  started: boolean;
  value?: T | undefined;
}

export interface ParentReportDrain {
  activeCount: number;
  settled: Promise<void>;
}

/**
 * One in-memory fence shared by completion and stop workers. A blocked request
 * stays blocked for the daemon lifetime, closing the gap where a report could
 * register after a stop had inspected an empty active-operation map.
 */
export class ParentReportFence {
  private readonly blocked = new Set<string>();
  private readonly active = new Map<string, ActiveParentReport>();

  async run<T>(
    requestId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<ParentReportRunResult<T>> {
    if (this.blocked.has(requestId)) return { started: false };
    if (this.active.has(requestId)) {
      throw new Error(`parent report ${requestId} is already active`);
    }

    const controller = new AbortController();
    let settle = (): void => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry: ActiveParentReport = { controller, settled, settle };
    this.active.set(requestId, entry);
    try {
      return { started: true, value: await operation(controller.signal) };
    } finally {
      if (this.active.get(requestId) === entry) this.active.delete(requestId);
      entry.settle();
    }
  }

  block(requestIds: readonly string[]): ParentReportDrain {
    const active: ActiveParentReport[] = [];
    for (const requestId of new Set(requestIds)) {
      this.blocked.add(requestId);
      const entry = this.active.get(requestId);
      if (!entry) continue;
      active.push(entry);
      entry.controller.abort(new Error("superseded by an authenticated stop request"));
    }
    return {
      activeCount: active.length,
      settled: Promise.allSettled(active.map(({ settled }) => settled)).then(() => undefined),
    };
  }
}

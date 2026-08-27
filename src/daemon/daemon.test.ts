import { describe, expect, it } from "vitest";
import { drainDaemonRuntime } from "./daemon.js";

describe("drainDaemonRuntime", () => {
  it("stops ingress, then drains workers, before closing shared resources", async () => {
    const order: string[] = [];
    let releaseSources: () => void = () => {};
    let releaseServer: () => void = () => {};
    const releaseWorkers: Array<() => void> = [];
    let markWorkersStarted: () => void = () => {};
    const sourcesGate = new Promise<void>((resolve) => {
      releaseSources = resolve;
    });
    const workersStarted = new Promise<void>((resolve) => {
      markWorkersStarted = resolve;
    });
    let workerStarts = 0;
    const workers = ["queue", "acks", "agent"].map((name) => ({
      async stop() {
        order.push(`${name}-start`);
        workerStarts++;
        if (workerStarts === 3) markWorkersStarted();
        await new Promise<void>((resolve) => {
          releaseWorkers.push(resolve);
        });
        order.push(`${name}-drained`);
      },
    }));

    const stopping = drainDaemonRuntime({
      sources: {
        async stopAll() {
          order.push("sources-start");
          await sourcesGate;
          order.push("sources-stopped");
        },
      },
      server: {
        close(callback) {
          order.push("server-start");
          releaseServer = () => {
            order.push("server-stopped");
            callback();
          };
        },
      },
      workers,
      adapter: {
        close() {
          order.push("adapter-closed");
        },
      },
      additionalAdapters: [
        {
          close() {
            order.push("claude-adapter-closed");
          },
        },
      ],
      database: {
        close() {
          order.push("database-closed");
        },
      },
    });

    expect(order).toEqual(["sources-start", "server-start"]);
    releaseSources();
    releaseServer();
    await workersStarted;
    expect(order.slice(0, 2)).toEqual(["sources-start", "server-start"]);
    expect(order).toContain("sources-stopped");
    expect(order).toContain("server-stopped");
    expect(order).not.toContain("adapter-closed");
    expect(order).not.toContain("database-closed");

    for (const release of releaseWorkers) release();
    await stopping;
    expect(order.slice(-3)).toEqual(["adapter-closed", "claude-adapter-closed", "database-closed"]);
    expect(order.filter((entry) => entry.endsWith("-drained"))).toHaveLength(3);
  });
});

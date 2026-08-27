import { createHmac } from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../../core/event.js";
import type { SecretStore } from "../../secrets/store.js";
import { secretNames } from "../../secrets/store.js";
import { GithubWebhookSource } from "./source.js";

describe("GithubWebhookSource replay identity", () => {
  it("uses the signed body digest instead of the mutable delivery header", async () => {
    const sourceId = "github-system";
    const secret = "test-webhook-secret";
    const events: WakeEvent[] = [];
    const source = new GithubWebhookSource(
      sourceId,
      { mode: "listen" },
      memorySecrets([[secretNames.githubWebhookSecret(sourceId), secret]]),
      { emit: (event) => events.push(event), logger: pino({ level: "silent" }) },
    );
    const rawBody = JSON.stringify({
      ref: "refs/heads/main",
      repository: { id: 101, full_name: "snapnhd/system" },
      sender: { id: 99, login: "cj" },
      commits: [],
    });
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    await source.handleWebhook({
      eventName: "push",
      deliveryId: "relay-header-one",
      signature,
      rawBody,
    });
    await source.handleWebhook({
      eventName: "push",
      deliveryId: "relay-header-two",
      signature,
      rawBody,
    });

    expect(events).toHaveLength(2);
    expect(events[0]?.deliveryId).toMatch(/^github-body-sha256-[0-9a-f]{64}$/);
    expect(events[1]?.deliveryId).toBe(events[0]?.deliveryId);
  });

  it("does not require the unsigned delivery header", async () => {
    const sourceId = "github-system";
    const secret = "test-webhook-secret";
    const events: WakeEvent[] = [];
    const source = new GithubWebhookSource(
      sourceId,
      { mode: "listen" },
      memorySecrets([[secretNames.githubWebhookSecret(sourceId), secret]]),
      { emit: (event) => events.push(event), logger: pino({ level: "silent" }) },
    );
    const rawBody = JSON.stringify({
      ref: "refs/heads/main",
      repository: { id: 101, full_name: "snapnhd/system" },
      commits: [],
    });
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    const response = await source.handleWebhook({
      eventName: "push",
      deliveryId: undefined,
      signature,
      rawBody,
    });

    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
  });
});

function memorySecrets(entries: Array<[string, string]>): SecretStore {
  const values = new Map(entries);
  return {
    backend: "file",
    get: (name) => values.get(name) ?? null,
    set: (name, value) => values.set(name, value),
    delete: (name) => {
      values.delete(name);
    },
  };
}

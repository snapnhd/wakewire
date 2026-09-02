import { describe, expect, it, vi } from "vitest";
import { LinearGraphqlActivityTransport } from "./live-responders.js";
import { PermanentAckError } from "./responders/types.js";

function env() {
  return {
    id: "chip-user",
    name: "Chip Byte",
    email: "chip@snapcorp.com",
    organizationId: "org-1",
    apiKey: "lin_api_test",
  };
}

describe("LinearGraphqlActivityTransport.createReaction", () => {
  it("posts reactionCreate against the @chip comment", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { reactionCreate: { success: true, reaction: { id: "rxn-1", emoji: "👀" } } },
      }),
    }));
    const transport = new LinearGraphqlActivityTransport(
      { get: () => undefined } as never,
      fetchImpl as unknown as typeof fetch,
      env(),
    );

    await expect(
      transport.createReaction({
        sourceId: "webhook-linear",
        commentId: "comment-1",
        emoji: "👀",
      }),
    ).resolves.toEqual({ reactionId: "rxn-1" });

    const init = fetchImpl.mock.calls[0]?.[1];
    if (!init) throw new Error("expected Linear request init");
    expect(JSON.parse(String(init.body))).toMatchObject({
      variables: { input: { commentId: "comment-1", emoji: "👀" } },
    });
  });

  it("treats an already-present Linear reaction as success", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [{ message: "An reaction already exists with that user and emoji." }],
      }),
    }));
    const transport = new LinearGraphqlActivityTransport(
      { get: () => undefined } as never,
      fetchImpl as unknown as typeof fetch,
      env(),
    );

    await expect(
      transport.createReaction({
        sourceId: "webhook-linear",
        commentId: "comment-1",
        emoji: "👀",
      }),
    ).resolves.toEqual({ reactionId: "linear:comment-1:👀" });
  });

  it("fails closed without a dedicated Linear API key", async () => {
    const transport = new LinearGraphqlActivityTransport(
      { get: () => undefined } as never,
      vi.fn() as unknown as typeof fetch,
      null,
    );
    await expect(
      transport.createReaction({ sourceId: "webhook-linear", commentId: "c1", emoji: "👀" }),
    ).rejects.toBeInstanceOf(PermanentAckError);
  });
});

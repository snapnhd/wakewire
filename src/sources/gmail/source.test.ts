import { describe, expect, it, vi } from "vitest";
import { GmailImapSource } from "./source.js";

function oneMessageClient(raw: string) {
  return {
    async *fetch() {
      yield { uid: 1, source: Buffer.from(raw) };
    },
  };
}

function makeSource(emit: (event: unknown) => void, persistState = vi.fn()) {
  const source = new GmailImapSource(
    "gmail-chip",
    {
      label: "agent-inbox",
      auth: { kind: "gmail-oauth", user: "chip@snapcorp.com" },
      state: { uidValidity: 1, lastSeenUid: 0 },
    },
    { backend: "file", get: () => null, set: () => {}, delete: () => {} },
    {
      emit,
      logger: {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
        level: "silent",
      } as never,
    },
    persistState,
  );
  return { source, persistState };
}

async function fetchNew(source: GmailImapSource, raw: string): Promise<void> {
  await (
    source as unknown as {
      fetchNew(client: ReturnType<typeof oneMessageClient>): Promise<void>;
    }
  ).fetchNew(oneMessageClient(raw));
}

const raw = [
  "Message-ID: <one@example.com>",
  "From: CJ <cj@snapcorp.com>",
  "To: chip@snapcorp.com",
  "Subject: Test",
  "",
  "hello",
].join("\r\n");

describe("GmailImapSource durable watermark", () => {
  it("does not advance the UID when durable local ingress throws", async () => {
    const { source, persistState } = makeSource(() => {
      throw new Error("sqlite unavailable");
    });
    await expect(fetchNew(source, raw)).rejects.toThrow("sqlite unavailable");
    expect(persistState).not.toHaveBeenCalled();
  });

  it("advances the UID only after durable local ingress returns", async () => {
    const { source, persistState } = makeSource(() => {});
    await fetchNew(source, raw);
    expect(persistState).toHaveBeenCalledWith({ uidValidity: 1, lastSeenUid: 1 });
  });
});

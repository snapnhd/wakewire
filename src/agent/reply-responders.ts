import type { SourceReplyJob } from "./store.js";

export interface SourceReplySendResult {
  providerResultId?: string | undefined;
}

export interface SourceReplyResponder {
  readonly provider: string;
  send(job: SourceReplyJob, signal?: AbortSignal): Promise<SourceReplySendResult>;
}

/** A provider failure that cannot succeed without credentials or job changes. */
export class PermanentSourceReplyError extends Error {}

/** A transient provider failure that supplies a minimum safe retry delay. */
export class RetryableSourceReplyError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
      throw new TypeError("source reply retryAfterMs must be a non-negative integer");
    }
    this.retryAfterMs = retryAfterMs;
  }
}

export class SourceReplyResponderRegistry {
  private readonly responders = new Map<string, SourceReplyResponder>();

  constructor(responders: Iterable<SourceReplyResponder> = []) {
    for (const responder of responders) this.register(responder);
  }

  register(responder: SourceReplyResponder): void {
    const provider = normalizeProvider(responder.provider);
    if (this.responders.has(provider)) {
      throw new Error(`source reply responder already registered for ${provider}`);
    }
    this.responders.set(provider, responder);
  }

  get(provider: string): SourceReplyResponder | undefined {
    return this.responders.get(normalizeProvider(provider));
  }

  list(): string[] {
    return [...this.responders.keys()].sort();
  }
}

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) throw new Error("source reply responder provider is required");
  return normalized;
}

import type { AckJob } from "../store.js";

export interface AckSendResult {
  providerResultId?: string | undefined;
}

export interface AckResponder {
  readonly provider: string;
  send(job: AckJob, signal?: AbortSignal): Promise<AckSendResult>;
}

/** Acknowledgment failures that cannot succeed without changing the job or local configuration. */
export class PermanentAckError extends Error {}

export class AckResponderRegistry {
  private readonly responders = new Map<string, AckResponder>();

  constructor(responders: Iterable<AckResponder> = []) {
    for (const responder of responders) this.register(responder);
  }

  register(responder: AckResponder): void {
    const provider = normalizeProvider(responder.provider);
    if (this.responders.has(provider)) {
      throw new Error(`acknowledgment responder already registered for ${provider}`);
    }
    this.responders.set(provider, responder);
  }

  get(provider: string): AckResponder | undefined {
    return this.responders.get(normalizeProvider(provider));
  }

  list(): string[] {
    return [...this.responders.keys()].sort();
  }
}

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) throw new Error("acknowledgment responder provider is required");
  return normalized;
}

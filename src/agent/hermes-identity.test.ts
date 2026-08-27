import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../core/event.js";
import { PermanentError } from "../sinks/types.js";
import {
  buildHermesDesktopTitle,
  buildHermesSessionKey,
  buildHermesSessionOptions,
  hermesIdentityFromPrincipal,
  hermesTargetFromEvent,
  pickLinearEmail,
} from "./hermes-identity.js";

function event(partial: Partial<WakeEvent> & Pick<WakeEvent, "kind" | "deliveryId">): WakeEvent {
  return {
    source: partial.source ?? "github",
    kind: partial.kind,
    deliveryId: partial.deliveryId,
    occurredAt: partial.occurredAt ?? "2026-08-05T00:00:00.000Z",
    summary: partial.summary ?? "test",
    payload: partial.payload ?? {},
    ...(partial.principal ? { principal: partial.principal } : {}),
  };
}

describe("pickLinearEmail", () => {
  it("prefers @snapcorp.com", () => {
    expect(pickLinearEmail(["cjlazell@gmail.com", "cj@snapcorp.com"])).toBe("cj@snapcorp.com");
  });

  it("falls back to first email", () => {
    expect(pickLinearEmail(["Alice@Example.com"])).toBe("alice@example.com");
  });

  it("returns null when empty", () => {
    expect(pickLinearEmail([])).toBeNull();
  });
});

describe("hermesIdentityFromPrincipal", () => {
  it("stamps github login lowercased from handle", () => {
    const stamp = hermesIdentityFromPrincipal({
      event: event({
        source: "github",
        kind: "issue_comment",
        deliveryId: "d1",
        principal: {
          provider: "github",
          tenantId: "snapcorp",
          subjectId: "123",
          handle: "ChipByte-Snap",
        },
      }),
      person: { emails: ["chip@snapcorp.com"], identities: [] },
      workItemId: "wi-1",
    });
    expect(stamp).toEqual({
      platform: "github",
      userId: "chipbyte-snap",
      chatId: "workitem:wi-1",
    });
  });

  it("stamps linear email preferring snapcorp from person aliases", () => {
    const stamp = hermesIdentityFromPrincipal({
      event: event({
        source: "webhook",
        kind: "Comment",
        deliveryId: "d2",
        principal: {
          provider: "linear",
          tenantId: "snap",
          subjectId: "user_1",
        },
      }),
      person: { emails: ["other@example.com", "cj@snapcorp.com"] },
    });
    expect(stamp).toEqual({
      platform: "linear",
      userId: "cj@snapcorp.com",
    });
  });

  it("fails closed without linear email", () => {
    expect(() =>
      hermesIdentityFromPrincipal({
        event: event({
          source: "webhook",
          kind: "Comment",
          deliveryId: "d3",
          principal: { provider: "linear", tenantId: "t", subjectId: "u" },
        }),
        person: { emails: [] },
      }),
    ).toThrow(PermanentError);
  });
});

describe("hermes session presentation", () => {
  it("builds github session key and desktop title from repo#number", () => {
    const ev = event({
      source: "github",
      kind: "issue_comment",
      deliveryId: "d4",
      principal: {
        provider: "github",
        tenantId: "snapcorp",
        subjectId: "1",
        handle: "chipbyte-snap",
      },
      payload: {
        repo: "snapnhd/system",
        number: 997,
        title: "Orchestrate standalone issue clones",
      },
    });
    const target = hermesTargetFromEvent(ev, { workItemId: "wi-gh" });
    expect(buildHermesSessionKey(target)).toBe("wakewire:github:snapnhd/system#997");
    expect(buildHermesDesktopTitle(target)).toBe(
      "snapnhd/system#997 · Orchestrate standalone issue clones",
    );

    const opts = buildHermesSessionOptions({
      event: ev,
      person: { emails: ["chip@snapcorp.com"] },
      workItemId: "wi-gh",
    });
    expect(opts).toMatchObject({
      platform: "github",
      userId: "chipbyte-snap",
      sessionKey: "wakewire:github:snapnhd/system#997",
      chatId: "wakewire:github:snapnhd/system#997",
      sessionTitle: "snapnhd/system#997 · Orchestrate standalone issue clones",
      displayName: "chipbyte-snap",
    });
  });

  it("builds linear session key and title from identifier", () => {
    const ev = event({
      source: "webhook",
      kind: "Comment",
      deliveryId: "d5",
      principal: {
        provider: "linear",
        tenantId: "snap",
        subjectId: "u1",
        email: "cj@snapcorp.com",
      },
      payload: {
        type: "Comment",
        identifier: "FRA-2818",
        title: "Fraud report polish",
      },
    });
    const opts = buildHermesSessionOptions({
      event: ev,
      person: { emails: ["cj@snapcorp.com"] },
      workItemId: "wi-lin",
      linearIdentifier: "FRA-2818",
      linearTitle: "Fraud report polish",
    });
    expect(opts.sessionKey).toBe("wakewire:linear:FRA-2818");
    expect(opts.chatId).toBe("wakewire:linear:FRA-2818");
    expect(opts.sessionTitle).toBe("FRA-2818 · Fraud report polish");
    expect(opts.platform).toBe("linear");
    expect(opts.userId).toBe("cj@snapcorp.com");
  });
});

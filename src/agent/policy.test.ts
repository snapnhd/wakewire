import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/db.js";
import { PeopleStore } from "../people/store.js";
import {
  CAPABILITY_NAMES,
  chipDispatchDenied,
  effectivePolicy,
  explainPolicy,
  isEnforceableDesktopOwner,
  OWNER_ROLE_POLICY,
  PolicyConfigurationError,
  type PolicyDirectory,
  PR_ROLE_POLICY,
} from "./policy.js";

describe("effectivePolicy", () => {
  it("returns and explains the seeded owner policy", () => {
    const store = new PeopleStore(openDatabase(":memory:"));
    const cj = store.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });
    const effective = effectivePolicy(store, cj.id);

    expect(effective).not.toBeNull();
    if (!effective) throw new Error("expected an effective policy");
    expect(effective?.authorized).toBe(true);
    expect(effective?.policy).toEqual(OWNER_ROLE_POLICY);
    expect(isEnforceableDesktopOwner(effective)).toBe(true);
    for (const capability of CAPABILITY_NAMES) {
      expect(effective?.policy.capabilities[capability]).toBe("full");
    }

    const explanation = explainPolicy(effective);
    expect(explanation.summary).toBe("CJ has the owner role");
    expect(explanation.grants).toContain("desktop: full");
    expect(explanation.grants).toContain("secrets: may use without revealing values");
    expect(explanation.restrictions).toContain("secrets: disclosure denied");
    expect(explanation.restrictions).toContain("authorization policy changes denied");
    expect(explanation.restrictions).toContain("destructive actions denied");
  });

  it("returns a concrete deny policy for a disabled person", () => {
    const store = new PeopleStore(openDatabase(":memory:"));
    const person = store.add({ nickname: "Disabled", roleName: "owner" });
    store.disable(person.id);
    const effective = effectivePolicy(store, person.id);

    if (!effective) throw new Error("expected an effective policy");
    expect(effective?.authorized).toBe(false);
    expect(effective?.policy.destructiveActions).toBe("deny");
    expect(effective?.policy.secrets.use).toBe(false);
    for (const capability of CAPABILITY_NAMES) {
      expect(effective?.policy.capabilities[capability]).toBe("none");
    }
    expect(explainPolicy(effective).summary).toBe("Disabled is disabled");
  });

  it("returns null for an unknown person and fails closed for a missing role", () => {
    const store = new PeopleStore(openDatabase(":memory:"));
    expect(effectivePolicy(store, "15ddb71a-81a1-41de-aad2-2cb2a7c61de2")).toBeNull();

    const person = store.add({ nickname: "CJ", roleName: "owner" });
    const broken: PolicyDirectory = {
      get: () => person,
      getRole: () => null,
    };
    expect(() => effectivePolicy(broken, person.id)).toThrow(PolicyConfigurationError);
  });
});

describe("chipDispatchDenied", () => {
  it("lets a pr role through on Hermes and denies it on Desktop", () => {
    const store = new PeopleStore(openDatabase(":memory:"));
    store.setRole("pr", PR_ROLE_POLICY);
    const chris = store.add({
      nickname: "Chris",
      roleName: "pr",
      emails: ["chris@snapcorp.com"],
    });
    const effective = effectivePolicy(store, chris.id);
    if (!effective) throw new Error("expected an effective policy");
    expect(chipDispatchDenied(effective, "hermes")).toBeNull();
    expect(effective.policy.capabilities).toMatchObject({
      filesystem: "read",
      shell: "read",
      network: "read",
      browser: "read",
      connectedApps: "write",
      sourceReplies: "write",
      git: "read",
    });
    expect(effective.policy.secrets).toEqual({ use: false, disclose: false });
    expect(chipDispatchDenied(effective, "codex-desktop")).toBe("desktop-policy-not-enforceable");
    expect(chipDispatchDenied(effective)).toBe("desktop-policy-not-enforceable");
    expect(isEnforceableDesktopOwner(effective)).toBe(false);
  });
});

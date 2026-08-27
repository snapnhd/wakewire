import { describe, expect, it } from "vitest";
import { OWNER_ROLE_POLICY, RolePolicySchema } from "../agent/policy.js";
import { openDatabase } from "../db/db.js";
import {
  PeopleConflictError,
  PeopleStore,
  PersonNotFoundError,
  RoleNotFoundError,
} from "./store.js";

function setup(): PeopleStore {
  return new PeopleStore(openDatabase(":memory:"));
}

describe("PeopleStore", () => {
  it("seeds an editable owner role without creating a person", () => {
    const store = setup();

    expect(store.list()).toEqual([]);
    expect(store.getRole("OWNER")?.policy).toEqual(OWNER_ROLE_POLICY);
    expect(store.getRole("owner")?.policy.secrets).toEqual({ use: true, disclose: false });
    expect(store.getRole("owner")?.policy.policyAdmin).toBe(false);
    expect(store.getRole("owner")?.policy.destructiveActions).toBe("deny");
  });

  it("adds UUID-keyed people with normalized email aliases and case-insensitive nicknames", () => {
    const store = setup();
    const cj = store.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["CJ@SnapCorp.com", "cjlazell@gmail.com"],
    });

    expect(cj.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(cj).toMatchObject({ nickname: "CJ", roleName: "owner", enabled: true });
    expect(cj.emails).toEqual(["cj@snapcorp.com", "cjlazell@gmail.com"]);
    expect(store.getByNickname("cj")?.id).toBe(cj.id);
    expect(store.resolveEmail("CJ@SNAPCORP.COM")?.id).toBe(cj.id);
    expect(store.list()).toHaveLength(1);
  });

  it("enforces case-insensitive nickname and email uniqueness atomically", () => {
    const store = setup();
    store.add({ nickname: "CJ", roleName: "owner", emails: ["cj@snapcorp.com"] });

    expect(() =>
      store.add({ nickname: "cj", roleName: "owner", emails: ["different@example.com"] }),
    ).toThrow(PeopleConflictError);
    expect(() =>
      store.add({ nickname: "Another", roleName: "owner", emails: ["CJ@SNAPCORP.COM"] }),
    ).toThrow(PeopleConflictError);
    expect(store.resolveEmail("different@example.com")).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  it("disables people without deleting enrollment records", () => {
    const store = setup();
    const cj = store.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });

    expect(store.disable(cj.id)).toBe(true);
    expect(store.disable("15ddb71a-81a1-41de-aad2-2cb2a7c61de2")).toBe(false);
    expect(store.get(cj.id)?.enabled).toBe(false);
    expect(store.list()).toHaveLength(1);
    expect(store.list({ enabledOnly: true })).toEqual([]);
    expect(store.resolveEmail("cj@snapcorp.com")).toBeNull();
    expect(store.resolveEmail("cj@snapcorp.com", { includeDisabled: true })?.id).toBe(cj.id);
  });

  it("attaches and resolves immutable provider identities", () => {
    const store = setup();
    const cj = store.add({
      nickname: "CJ",
      roleName: "owner",
      emails: ["cj@snapcorp.com"],
    });
    const attached = store.attachIdentity({
      personId: cj.id,
      provider: "Slack",
      tenantId: "T-SNAP",
      externalId: "U-CJ",
      handle: "cj",
      displayName: "CJ Lazell",
    });

    expect(attached).toMatchObject({
      provider: "slack",
      tenantId: "T-SNAP",
      externalId: "U-CJ",
    });
    expect(store.resolveIdentity("SLACK", "T-SNAP", "U-CJ")?.person.id).toBe(cj.id);
    expect(store.resolveIdentity("slack", "t-snap", "U-CJ")).toBeNull();

    const updated = store.attachIdentity({
      personId: cj.id,
      provider: "slack",
      tenantId: "T-SNAP",
      externalId: "U-CJ",
      handle: "cj-new",
    });
    expect(updated.handle).toBe("cj-new");

    const other = store.add({ nickname: "Other", roleName: "owner" });
    expect(() =>
      store.attachIdentity({
        personId: other.id,
        provider: "slack",
        tenantId: "T-SNAP",
        externalId: "U-CJ",
      }),
    ).toThrow(PeopleConflictError);

    store.disable(cj.id);
    expect(store.resolveIdentity("slack", "T-SNAP", "U-CJ")).toBeNull();
    expect(
      store.resolveIdentity("slack", "T-SNAP", "U-CJ", { includeDisabled: true })?.person.id,
    ).toBe(cj.id);
  });

  it("supports adding aliases and changing roles with validated structured policies", () => {
    const store = setup();
    const cj = store.add({ nickname: "CJ", roleName: "owner" });
    const reviewer = RolePolicySchema.parse({
      ...structuredClone(OWNER_ROLE_POLICY),
      capabilities: {
        ...OWNER_ROLE_POLICY.capabilities,
        machine: "read",
        desktop: "read",
        shell: "none",
      },
      secrets: { use: false, disclose: false },
      destructiveActions: "deny",
    });

    store.setRole("reviewer", reviewer);
    expect(store.getRole("REVIEWER")?.policy.capabilities.shell).toBe("none");
    expect(store.setRoleForPerson(cj.id, "Reviewer").roleName).toBe("reviewer");
    expect(store.addEmail(cj.id, "CJ@SnapCorp.com").emails).toEqual(["cj@snapcorp.com"]);
    expect(() => store.setRole("invalid", { version: 1 })).toThrow();
    expect(() => store.setRoleForPerson(cj.id, "missing")).toThrow(RoleNotFoundError);
    expect(() =>
      store.addEmail("15ddb71a-81a1-41de-aad2-2cb2a7c61de2", "nobody@example.com"),
    ).toThrow(PersonNotFoundError);
  });
});

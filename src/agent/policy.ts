import { z } from "zod";
import type { Person } from "../people/schema.js";

export const AccessLevelSchema = z.enum(["none", "read", "write", "full"]);

export const CAPABILITY_NAMES = [
  "machine",
  "desktop",
  "filesystem",
  "shell",
  "network",
  "browser",
  "computerUse",
  "connectedApps",
  "sourceReplies",
  "git",
  "deployments",
] as const;

const CapabilitiesSchema = z.object(
  Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, AccessLevelSchema])) as Record<
    (typeof CAPABILITY_NAMES)[number],
    typeof AccessLevelSchema
  >,
);

export const RolePolicySchema = z
  .object({
    version: z.literal(1),
    capabilities: CapabilitiesSchema,
    secrets: z.object({
      use: z.boolean(),
      disclose: z.boolean(),
    }),
    policyAdmin: z.boolean(),
    destructiveActions: z.enum(["deny", "explicit-authenticated-instruction", "allow"]),
  })
  .strict();

export type RolePolicy = z.infer<typeof RolePolicySchema>;

/** Seeded by migration 5 and tightened by migration 8. Runtime edits use PeopleStore.setRole(). */
export const OWNER_ROLE_POLICY: RolePolicy = RolePolicySchema.parse({
  version: 1,
  capabilities: {
    machine: "full",
    desktop: "full",
    filesystem: "full",
    shell: "full",
    network: "full",
    browser: "full",
    computerUse: "full",
    connectedApps: "full",
    sourceReplies: "full",
    git: "full",
    deployments: "full",
  },
  secrets: { use: true, disclose: false },
  policyAdmin: false,
  destructiveActions: "deny",
});

const DISABLED_POLICY: RolePolicy = RolePolicySchema.parse({
  version: 1,
  capabilities: Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, "none"])),
  secrets: { use: false, disclose: false },
  policyAdmin: false,
  destructiveActions: "deny",
});

export interface RoleWithPolicy {
  name: string;
  policy: RolePolicy;
}

export interface PolicyDirectory {
  get(id: string): Person | null;
  getRole(name: string): RoleWithPolicy | null;
}

export interface EffectivePolicy {
  personId: string;
  nickname: string;
  roleName: string;
  authorized: boolean;
  policy: RolePolicy;
}

export interface PolicyExplanation {
  summary: string;
  grants: string[];
  restrictions: string[];
  conditions: string[];
}

export class PolicyConfigurationError extends Error {}

/**
 * Codex Desktop does not currently expose enforceable per-tool capability
 * controls through the private turn API. Until it does, privileged dispatch is
 * restricted to the exact seeded owner policy; narrower custom roles remain
 * useful for configuration and inspection but fail closed at ingress.
 */
export function isEnforceableDesktopOwner(effective: EffectivePolicy): boolean {
  return (
    effective.authorized &&
    effective.roleName.toLowerCase() === "owner" &&
    JSON.stringify(effective.policy) === JSON.stringify(OWNER_ROLE_POLICY)
  );
}

/** Ingress role for Path D GitHub/Linear reviewers. Hermes role-policy gates tools. */
export const PR_ROLE_POLICY: RolePolicy = RolePolicySchema.parse({
  version: 1,
  capabilities: {
    machine: "none",
    desktop: "none",
    filesystem: "read",
    shell: "read",
    network: "read",
    browser: "read",
    computerUse: "none",
    connectedApps: "write",
    sourceReplies: "write",
    git: "read",
    deployments: "none",
  },
  secrets: { use: false, disclose: false },
  policyAdmin: false,
  destructiveActions: "deny",
});

export function sourceRepliesWritable(policy: RolePolicy): boolean {
  const level = policy.capabilities.sourceReplies;
  return level === "write" || level === "full";
}

/**
 * Deny reason for Chip dispatch, or null if the request may proceed.
 * Codex Desktop cannot enforce per-tool roles, so only owner dispatches there.
 * Hermes stamps HERMES_SESSION_* and gateway-role-policy is the tool gate.
 */
export function chipDispatchDenied(
  effective: EffectivePolicy | null,
  sinkAdapterName?: string,
): string | null {
  if (!effective?.authorized || !sourceRepliesWritable(effective.policy)) {
    return "policy-denied";
  }
  if (sinkAdapterName === "hermes") return null;
  if (!isEnforceableDesktopOwner(effective)) return "desktop-policy-not-enforceable";
  return null;
}

/** Resolve a person's role into the policy that authorization code must enforce. */
export function effectivePolicy(
  directory: PolicyDirectory,
  personId: string,
): EffectivePolicy | null {
  const person = directory.get(personId);
  if (!person) return null;
  const role = directory.getRole(person.roleName);
  if (!role) {
    throw new PolicyConfigurationError(
      `person ${person.id} references missing role ${person.roleName}`,
    );
  }
  return {
    personId: person.id,
    nickname: person.nickname,
    roleName: role.name,
    authorized: person.enabled,
    // A disabled principal resolves to an actual deny policy so a caller cannot
    // accidentally enforce the role grants while ignoring `authorized`.
    policy: RolePolicySchema.parse(person.enabled ? role.policy : DISABLED_POLICY),
  };
}

/** Human-readable policy output for CLI/API inspection. */
export function explainPolicy(effective: EffectivePolicy): PolicyExplanation {
  const grants: string[] = [];
  const restrictions: string[] = [];
  const conditions: string[] = [];

  if (!effective.authorized) {
    restrictions.push("person is disabled; no operations are authorized");
  }
  for (const capability of CAPABILITY_NAMES) {
    const level = effective.policy.capabilities[capability];
    const label = humanize(capability);
    if (level === "none") restrictions.push(`${label}: denied`);
    else grants.push(`${label}: ${level}`);
  }
  if (effective.policy.secrets.use) grants.push("secrets: may use without revealing values");
  else restrictions.push("secrets: use denied");
  if (!effective.policy.secrets.disclose) restrictions.push("secrets: disclosure denied");
  else grants.push("secrets: disclosure allowed");
  if (!effective.policy.policyAdmin) restrictions.push("authorization policy changes denied");
  else grants.push("authorization policy changes allowed");

  switch (effective.policy.destructiveActions) {
    case "deny":
      restrictions.push("destructive actions denied");
      break;
    case "explicit-authenticated-instruction":
      conditions.push("destructive actions require an explicit authenticated instruction");
      break;
    case "allow":
      grants.push("destructive actions allowed");
      break;
  }

  return {
    summary: effective.authorized
      ? `${effective.nickname} has the ${effective.roleName} role`
      : `${effective.nickname} is disabled`,
    grants,
    restrictions,
    conditions,
  };
}

function humanize(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

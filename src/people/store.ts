import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import { RolePolicySchema, type RoleWithPolicy } from "../agent/policy.js";
import {
  EmailAliasSchema,
  IdentityProviderSchema,
  type Person,
  type PersonIdentity,
  PersonIdentityInputSchema,
  PersonIdentitySchema,
  type PersonInput,
  PersonInputSchema,
  PersonSchema,
  RoleNameSchema,
} from "./schema.js";

interface PersonRow {
  id: string;
  nickname: string;
  role_name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface IdentityRow {
  person_id: string;
  provider: string;
  tenant_id: string;
  external_id: string;
  handle: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

interface RoleRow {
  name: string;
  policy_json: string;
  created_at: string;
  updated_at: string;
}

export interface RoleRecord extends RoleWithPolicy {
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedIdentity {
  person: Person;
  identity: PersonIdentity;
}

export class PeopleConflictError extends Error {}
export class PersonNotFoundError extends Error {}
export class RoleNotFoundError extends Error {}

/** Persistence for people, enrollment email aliases, provider identities, and roles. */
export class PeopleStore {
  constructor(private readonly db: Database) {}

  add(input: PersonInput): Person {
    const parsed = PersonInputSchema.parse(input);
    if (!this.getRole(parsed.roleName)) {
      throw new RoleNotFoundError(`role ${parsed.roleName} does not exist`);
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    const insertPerson = this.db.prepare(
      `INSERT INTO people (id, nickname, role_name, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    const insertEmail = this.db.prepare(
      "INSERT INTO person_emails (person_id, email, created_at) VALUES (?, ?, ?)",
    );
    try {
      this.db.transaction(() => {
        insertPerson.run(id, parsed.nickname, parsed.roleName, now, now);
        for (const email of new Set(parsed.emails)) insertEmail.run(id, email, now);
      })();
    } catch (err) {
      throw mapConstraint(err, "nickname or email alias is already enrolled");
    }
    return required(this.get(id), "person insert failed");
  }

  get(id: string): Person | null {
    const row = this.db.prepare("SELECT * FROM people WHERE id = ?").get(id) as
      | PersonRow
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  getByNickname(nickname: string): Person | null {
    const normalized = nickname.trim();
    if (!normalized) return null;
    const row = this.db
      .prepare("SELECT * FROM people WHERE nickname = ? COLLATE NOCASE")
      .get(normalized) as PersonRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  /** Administrative listing includes disabled people unless explicitly filtered. */
  list(options: { enabledOnly?: boolean } = {}): Person[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM people ${options.enabledOnly ? "WHERE enabled = 1" : ""}
         ORDER BY nickname COLLATE NOCASE, id`,
      )
      .all() as PersonRow[];
    return rows.map((row) => this.hydrate(row));
  }

  disable(id: string): boolean {
    return (
      this.db
        .prepare("UPDATE people SET enabled = 0, updated_at = ? WHERE id = ?")
        .run(nowIso(), id).changes > 0
    );
  }

  enable(id: string): boolean {
    return (
      this.db
        .prepare("UPDATE people SET enabled = 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), id).changes > 0
    );
  }

  setRoleForPerson(personId: string, roleName: string): Person {
    const parsedRole = RoleNameSchema.parse(roleName);
    const role = this.getRole(parsedRole);
    if (!role) throw new RoleNotFoundError(`role ${parsedRole} does not exist`);
    const result = this.db
      .prepare("UPDATE people SET role_name = ?, updated_at = ? WHERE id = ?")
      .run(role.name, nowIso(), personId);
    if (result.changes === 0) throw new PersonNotFoundError(`person ${personId} does not exist`);
    return required(this.get(personId), "person disappeared after role update");
  }

  addEmail(personId: string, email: string): Person {
    this.requirePerson(personId);
    const normalized = EmailAliasSchema.parse(email);
    try {
      this.db
        .prepare("INSERT INTO person_emails (person_id, email, created_at) VALUES (?, ?, ?)")
        .run(personId, normalized, nowIso());
    } catch (err) {
      throw mapConstraint(err, `email alias ${normalized} is already enrolled`);
    }
    return required(this.get(personId), "person disappeared after email insert");
  }

  resolveEmail(email: string, options: { includeDisabled?: boolean } = {}): Person | null {
    const normalized = EmailAliasSchema.parse(email);
    const row = this.db
      .prepare(
        `SELECT p.* FROM people p
         JOIN person_emails e ON e.person_id = p.id
         WHERE e.email = ? COLLATE NOCASE ${options.includeDisabled ? "" : "AND p.enabled = 1"}`,
      )
      .get(normalized) as PersonRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  attachIdentity(input: unknown): PersonIdentity {
    const parsed = PersonIdentityInputSchema.parse(input);
    this.requirePerson(parsed.personId);
    const existing = this.identityRow(parsed.provider, parsed.tenantId, parsed.externalId);
    if (existing && existing.person_id !== parsed.personId) {
      throw new PeopleConflictError(
        `${parsed.provider} identity ${parsed.tenantId}/${parsed.externalId} is already attached`,
      );
    }
    const now = nowIso();
    if (existing) {
      this.db
        .prepare(
          `UPDATE person_identities SET handle = ?, display_name = ?, updated_at = ?
           WHERE provider = ? AND tenant_id = ? AND external_id = ?`,
        )
        .run(
          parsed.handle ?? null,
          parsed.displayName ?? null,
          now,
          parsed.provider,
          parsed.tenantId,
          parsed.externalId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO person_identities
             (person_id, provider, tenant_id, external_id, handle, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.personId,
          parsed.provider,
          parsed.tenantId,
          parsed.externalId,
          parsed.handle ?? null,
          parsed.displayName ?? null,
          now,
          now,
        );
    }
    return this.toIdentity(
      required(
        this.identityRow(parsed.provider, parsed.tenantId, parsed.externalId),
        "identity insert failed",
      ),
    );
  }

  resolveIdentity(
    provider: string,
    tenantId: string,
    externalId: string,
    options: { includeDisabled?: boolean } = {},
  ): ResolvedIdentity | null {
    const normalizedProvider = IdentityProviderSchema.parse(provider);
    const row = this.identityRow(normalizedProvider, tenantId, externalId);
    if (!row) return null;
    const person = this.get(row.person_id);
    if (!person || (!person.enabled && !options.includeDisabled)) return null;
    return { person, identity: this.toIdentity(row) };
  }

  setRole(name: string, policy: unknown): RoleRecord {
    const parsedName = RoleNameSchema.parse(name);
    const parsedPolicy = RolePolicySchema.parse(policy);
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO roles (name, policy_json, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           policy_json = excluded.policy_json,
           updated_at = excluded.updated_at`,
      )
      .run(parsedName, JSON.stringify(parsedPolicy), now, now);
    return required(this.getRole(parsedName), "role upsert failed");
  }

  getRole(name: string): RoleRecord | null {
    const row = this.db.prepare("SELECT * FROM roles WHERE name = ? COLLATE NOCASE").get(name) as
      | RoleRow
      | undefined;
    return row ? toRole(row) : null;
  }

  listRoles(): RoleRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM roles ORDER BY name COLLATE NOCASE")
      .all() as RoleRow[];
    return rows.map(toRole);
  }

  private requirePerson(id: string): Person {
    const person = this.get(id);
    if (!person) throw new PersonNotFoundError(`person ${id} does not exist`);
    return person;
  }

  private identityRow(provider: string, tenantId: string, externalId: string): IdentityRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM person_identities
         WHERE provider = ? AND tenant_id = ? AND external_id = ?`,
      )
      .get(provider, tenantId, externalId) as IdentityRow | undefined;
    return row ?? null;
  }

  private hydrate(row: PersonRow): Person {
    const emails = (
      this.db
        .prepare(
          "SELECT email FROM person_emails WHERE person_id = ? ORDER BY email COLLATE NOCASE",
        )
        .all(row.id) as Array<{ email: string }>
    ).map(({ email }) => email);
    const identities = (
      this.db
        .prepare(
          `SELECT * FROM person_identities WHERE person_id = ?
           ORDER BY provider, tenant_id, external_id`,
        )
        .all(row.id) as IdentityRow[]
    ).map((identity) => this.toIdentity(identity));
    return PersonSchema.parse({
      id: row.id,
      nickname: row.nickname,
      roleName: row.role_name,
      enabled: row.enabled === 1,
      emails,
      identities,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private toIdentity(row: IdentityRow): PersonIdentity {
    return PersonIdentitySchema.parse({
      personId: row.person_id,
      provider: row.provider,
      tenantId: row.tenant_id,
      externalId: row.external_id,
      handle: row.handle,
      displayName: row.display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}

function toRole(row: RoleRow): RoleRecord {
  return {
    name: row.name,
    policy: RolePolicySchema.parse(JSON.parse(row.policy_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}

function mapConstraint(err: unknown, message: string): Error {
  if (
    err instanceof Error &&
    "code" in err &&
    String((err as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT")
  ) {
    return new PeopleConflictError(message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

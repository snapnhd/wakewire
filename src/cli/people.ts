import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { effectivePolicy, explainPolicy } from "../agent/policy.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import { createLogger } from "../logging.js";
import { resolvePersonAccounts } from "../people/directory.js";
import type { Person } from "../people/schema.js";
import { PeopleStore } from "../people/store.js";
import { createSecretStore } from "../secrets/store.js";

export function registerPeopleCommands(program: Command): void {
  const people = program.command("people").description("Enroll people and immutable provider ids");
  people
    .command("add")
    .requiredOption("--nickname <name>", "name Chip should use")
    .requiredOption("--email <address>", "enrollment email (repeatable)", collect, [])
    .requiredOption(
      "--role <name>",
      "structured access role (owner is currently required for Desktop dispatch)",
    )
    .option("--github-login <login>", "explicit GitHub login when profile email is private")
    .option("--no-resolve", "create the person without querying configured providers")
    .action(
      async (opts: {
        nickname: string;
        email: string[];
        role: string;
        githubLogin?: string;
        resolve: boolean;
      }) => {
        const db = openDatabase();
        try {
          const store = new PeopleStore(db);
          const person = store.add({
            nickname: opts.nickname,
            emails: opts.email,
            roleName: opts.role,
          });
          console.log(`Added ${person.nickname} (${person.id}) with role ${person.roleName}.`);
          if (opts.resolve) {
            await resolveAndPrint(person, store, createStores(db), opts.githubLogin);
          }
        } finally {
          db.close();
        }
      },
    );

  people
    .command("resolve <person>")
    .description("Resolve enrolled emails to Slack, GitHub, and Linear immutable account ids")
    .option("--github-login <login>", "explicit GitHub login when profile email is private")
    .action(async (value: string, opts: { githubLogin?: string }) => {
      const db = openDatabase();
      try {
        const store = new PeopleStore(db);
        const person = requirePerson(store, value);
        await resolveAndPrint(person, store, createStores(db), opts.githubLogin);
      } finally {
        db.close();
      }
    });

  people
    .command("show <person>")
    .description("Show email aliases, pinned provider ids, and role")
    .action((value: string) => {
      const db = openDatabase();
      try {
        console.log(JSON.stringify(requirePerson(new PeopleStore(db), value), null, 2));
      } finally {
        db.close();
      }
    });

  people
    .command("disable <person>")
    .description("Immediately revoke a person's access")
    .action((value: string) => {
      const db = openDatabase();
      try {
        const store = new PeopleStore(db);
        const person = requirePerson(store, value);
        store.disable(person.id);
        console.log(`Disabled ${person.nickname} (${person.id}).`);
      } finally {
        db.close();
      }
    });

  people
    .command("enable <person>")
    .description("Re-enable a previously disabled person")
    .action((value: string) => {
      const db = openDatabase();
      try {
        const store = new PeopleStore(db);
        const person = requirePerson(store, value);
        store.enable(person.id);
        console.log(`Enabled ${person.nickname} (${person.id}).`);
      } finally {
        db.close();
      }
    });

  people
    .command("email-add <person>")
    .description("Add an email alias for provider lookup and Gmail's DMARC-aligned sender gate")
    .requiredOption("--email <address>")
    .option("--github-login <login>", "explicit GitHub login when profile email is private")
    .option("--no-resolve", "add the email without querying configured providers")
    .action(
      async (value: string, opts: { email: string; githubLogin?: string; resolve: boolean }) => {
        const db = openDatabase();
        try {
          const store = new PeopleStore(db);
          const person = store.addEmail(requirePerson(store, value).id, opts.email);
          console.log(`Added ${opts.email.toLowerCase()} to ${person.nickname}.`);
          if (opts.resolve) {
            await resolveAndPrint(person, store, createStores(db), opts.githubLogin);
          }
        } finally {
          db.close();
        }
      },
    );

  people
    .command("set-role <person>")
    .description("Change the role applied to all identities and emails for a person")
    .requiredOption("--role <name>")
    .action((value: string, opts: { role: string }) => {
      const db = openDatabase();
      try {
        const store = new PeopleStore(db);
        const person = store.setRoleForPerson(requirePerson(store, value).id, opts.role);
        console.log(`Set ${person.nickname} to role ${person.roleName}.`);
      } finally {
        db.close();
      }
    });

  people
    .command("identity-add <person>")
    .description("Manually pin an immutable provider id when email lookup is unavailable")
    .requiredOption("--provider <name>")
    .requiredOption("--tenant <id>")
    .requiredOption("--external-id <id>")
    .option("--handle <handle>")
    .option("--display-name <name>")
    .action(
      (
        value: string,
        opts: {
          provider: string;
          tenant: string;
          externalId: string;
          handle?: string;
          displayName?: string;
        },
      ) => {
        const db = openDatabase();
        try {
          const store = new PeopleStore(db);
          const person = requirePerson(store, value);
          const identity = store.attachIdentity({
            personId: person.id,
            provider: opts.provider,
            tenantId: opts.tenant,
            externalId: opts.externalId,
            handle: opts.handle,
            displayName: opts.displayName,
          });
          console.log(JSON.stringify(identity, null, 2));
        } finally {
          db.close();
        }
      },
    );

  const policy = program.command("policy").description("Inspect effective person access");
  policy
    .command("roles")
    .description("List role policies available for enrollment")
    .action(() => {
      const db = openDatabase();
      try {
        console.log(JSON.stringify(new PeopleStore(db).listRoles(), null, 2));
      } finally {
        db.close();
      }
    });

  policy
    .command("role-set <name>")
    .description("Create or replace a structured role from a JSON file")
    .requiredOption("--file <path>", "JSON file containing a versioned role policy")
    .action((name: string, opts: { file: string }) => {
      const db = openDatabase();
      try {
        const file = path.resolve(opts.file);
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
        const role = new PeopleStore(db).setRole(name, parsed);
        console.log(JSON.stringify(role, null, 2));
      } finally {
        db.close();
      }
    });

  policy
    .command("explain")
    .requiredOption("--person <person>")
    .action((opts: { person: string }) => {
      const db = openDatabase();
      try {
        const store = new PeopleStore(db);
        const person = requirePerson(store, opts.person);
        const effective = effectivePolicy(store, person.id);
        if (!effective) throw new Error(`policy for ${opts.person} was not found`);
        console.log(JSON.stringify({ effective, explanation: explainPolicy(effective) }, null, 2));
      } finally {
        db.close();
      }
    });
}

async function resolveAndPrint(
  person: Person,
  people: PeopleStore,
  stores: ReturnType<typeof createStores>,
  githubLogin: string | undefined,
): Promise<void> {
  const secrets = await createSecretStore(createLogger());
  const report = await resolvePersonAccounts({
    person,
    people,
    sources: stores.sources,
    secrets,
    ...(githubLogin ? { githubLogin } : {}),
  });
  for (const identity of report.attached) {
    console.log(
      `Pinned ${identity.provider} ${identity.tenantId}/${identity.externalId}` +
        (identity.handle ? ` (@${identity.handle})` : ""),
    );
  }
  for (const unresolved of report.unresolved) {
    console.log(`Unresolved ${unresolved.provider}: ${unresolved.reason}`);
  }
}

function requirePerson(store: PeopleStore, value: string): Person {
  const person =
    store.get(value) ??
    store.getByNickname(value) ??
    (value.includes("@") ? store.resolveEmail(value, { includeDisabled: true }) : null);
  if (!person) throw new Error(`person ${value} was not found`);
  return person;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

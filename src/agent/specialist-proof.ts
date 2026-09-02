import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SYSTEM_PR_SPECIALIST_PROOF_MARKER = "<!-- wakewire-specialist-proof:v1";
const PROOF_START = `${SYSTEM_PR_SPECIALIST_PROOF_MARKER}\n`;
const PROOF_END = "\n-->";
const MAX_STATE_BYTES = 1_048_576;
const STATE_NAMESPACE = "code-quality-v2";

export type SystemPrSpecialistStatus = "PASS" | "REPAIR" | "ESCALATE";

export interface SystemPrSpecialistProof {
  reviewKey: string;
  headSha: string;
  invocationId: string;
  digest: string;
  status: SystemPrSpecialistStatus;
}

export interface SystemPrSpecialistExpectation {
  reviewKey: string;
  headSha: string;
  invocationId: string;
}

export type SystemPrSpecialistProofLookup = (proof: SystemPrSpecialistProof) => Promise<boolean>;

export function extractSystemPrSpecialistProof(
  response: string,
  expected: SystemPrSpecialistExpectation,
): SystemPrSpecialistProof | null {
  const starts = allIndexes(response, PROOF_START);
  if (starts.length !== 1) return null;
  const bodyStart = (starts[0] ?? -1) + PROOF_START.length;
  const bodyEnd = response.indexOf(PROOF_END, bodyStart);
  if (bodyEnd < bodyStart) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.slice(bodyStart, bodyEnd));
  } catch {
    return null;
  }
  if (!isExactProof(parsed)) return null;
  if (
    parsed.reviewKey !== expected.reviewKey ||
    parsed.headSha !== expected.headSha ||
    parsed.invocationId !== expected.invocationId
  ) {
    return null;
  }
  return parsed;
}

export function renderSystemPrSpecialistProofRequirement(
  expected: SystemPrSpecialistExpectation,
): string {
  return [
    "- COMPLETION PROOF: before this full-review turn can finish, run the specialist coordinator against this exact HEAD and stable review key.",
    "- `SPECIALISTS: INCOMPLETE` is not a verdict. Fix the named evidence failure in this same session and rerun; do not mark the review done or claim approval.",
    `- Pass this host attempt binding to the coordinator exactly as \`--invocation-id ${expected.invocationId}\`; a prior attempt cannot satisfy this turn.`,
    "- End the final assistant message with exactly one machine-readable proof block copied from the trusted coordinator result:",
    PROOF_START.trimEnd(),
    JSON.stringify(
      {
        reviewKey: expected.reviewKey,
        headSha: expected.headSha,
        invocationId: expected.invocationId,
        digest: "<64 lowercase hex from the coordinator>",
        status: "<PASS|REPAIR|ESCALATE>",
      },
      null,
      2,
    ),
    PROOF_END.trimStart(),
    "- WakeWire independently verifies the review key, exact HEAD, digest, verdict, and persisted coordinator state. Prose, a GitHub review, or a PR-body status cannot substitute for this proof.",
  ].join("\n");
}

export function createSystemPrSpecialistProofLookup(
  args: { stateRoot?: string } = {},
): SystemPrSpecialistProofLookup {
  const stateRoot =
    args.stateRoot ??
    path.join(
      process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes"),
      "cache",
      "correctness",
      "specialists",
    );
  return async (proof) => {
    let rootHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      rootHandle = await open(
        stateRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const root = await rootHandle.stat();
      if (!privateOwnedDirectory(root)) return false;
      const stateName = `${STATE_NAMESPACE}-${createHash("sha256")
        .update(proof.reviewKey)
        .digest("hex")}.json`;
      const state = await readPrivateJson(path.join(stateRoot, stateName), stateRoot, root);
      if (!stateContainsProof(state, proof)) return false;
      const attestationName = `wakewire-specialist-v1-${createHash("sha256")
        .update(`${proof.reviewKey}\0${proof.headSha}\0${proof.invocationId}`)
        .digest("hex")}.json`;
      const attestation = await readPrivateJson(
        path.join(stateRoot, attestationName),
        stateRoot,
        root,
      );
      return attestationMatchesProof(attestation, proof);
    } catch {
      return false;
    } finally {
      await rootHandle?.close();
    }
  };
}

async function readPrivateJson(
  filePath: string,
  rootPath: string,
  expectedRoot: Stats,
): Promise<unknown> {
  const rootBefore = await lstat(rootPath);
  if (!sameIdentity(rootBefore, expectedRoot)) throw new Error("specialist proof root changed");
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!privateOwnedFile(before) || before.size > MAX_STATE_BYTES) {
      throw new Error("specialist proof file is unsafe");
    }
    const chunks: Buffer[] = [];
    let position = 0;
    while (position <= MAX_STATE_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_STATE_BYTES + 1 - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const rootAfter = await lstat(rootPath);
    if (
      position > MAX_STATE_BYTES ||
      position !== before.size ||
      !sameIdentity(before, after) ||
      !sameIdentity(rootAfter, expectedRoot)
    ) {
      throw new Error("specialist proof file changed while it was read");
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function allIndexes(value: string, needle: string): number[] {
  const indexes: number[] = [];
  let cursor = 0;
  while (cursor <= value.length - needle.length) {
    const found = value.indexOf(needle, cursor);
    if (found < 0) break;
    indexes.push(found);
    cursor = found + needle.length;
  }
  return indexes;
}

function isExactProof(value: unknown): value is SystemPrSpecialistProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "digest,headSha,invocationId,reviewKey,status" ||
    typeof record.reviewKey !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/u.test(record.reviewKey) ||
    typeof record.headSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(record.headSha) ||
    typeof record.invocationId !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.invocationId) ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    !["PASS", "REPAIR", "ESCALATE"].includes(String(record.status))
  ) {
    return false;
  }
  return true;
}

function privateOwnedDirectory(metadata: Stats): boolean {
  return (
    metadata.isDirectory() &&
    !metadata.isSymbolicLink() &&
    (metadata.mode & 0o7777) === 0o700 &&
    (process.geteuid === undefined || metadata.uid === process.geteuid())
  );
}

function privateOwnedFile(metadata: Stats): boolean {
  return (
    metadata.isFile() &&
    metadata.nlink === 1 &&
    (metadata.mode & 0o7777) === 0o600 &&
    (process.geteuid === undefined || metadata.uid === process.geteuid())
  );
}

function stateContainsProof(state: unknown, proof: SystemPrSpecialistProof): boolean {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const record = state as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "events,review_key,version" ||
    record.version !== 2 ||
    record.review_key !== proof.reviewKey ||
    !Array.isArray(record.events)
  ) {
    return false;
  }
  const events = validateCoordinatorEvents(record.events);
  return Boolean(
    events?.some((event) => event.digest === proof.digest && event.status === proof.status),
  );
}

function validateCoordinatorEvents(
  values: unknown[],
): Array<{ digest: string; status: SystemPrSpecialistStatus }> | null {
  const validated: Array<{ digest: string; status: SystemPrSpecialistStatus }> = [];
  const digests = new Set<string>();
  let previousStatus: SystemPrSpecialistStatus | undefined;
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const event = value as Record<string, unknown>;
    if (
      Object.keys(event).sort().join(",") !== "digest,outputs,round,status" ||
      typeof event.digest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(event.digest) ||
      digests.has(event.digest) ||
      previousStatus === "ESCALATE"
    ) {
      return null;
    }
    const round = previousStatus === "REPAIR" ? 2 : 1;
    const outputStatus = coordinatorOutputStatus(event.outputs);
    const status: SystemPrSpecialistStatus | null =
      outputStatus === "PASS"
        ? "PASS"
        : outputStatus === "FINDINGS"
          ? round === 2
            ? "ESCALATE"
            : "REPAIR"
          : null;
    if (event.round !== round || event.status !== status || status === null) return null;
    validated.push({ digest: event.digest, status });
    digests.add(event.digest);
    previousStatus = status;
  }
  return validated;
}

function attestationMatchesProof(value: unknown, proof: SystemPrSpecialistProof): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attestation = value as Record<string, unknown>;
  return (
    Object.keys(attestation).sort().join(",") ===
      "digest,head_sha,invocation_id,review_key,status,version" &&
    attestation.version === 1 &&
    attestation.review_key === proof.reviewKey &&
    attestation.head_sha === proof.headSha &&
    attestation.invocation_id === proof.invocationId &&
    attestation.digest === proof.digest &&
    attestation.status === proof.status
  );
}

function coordinatorOutputStatus(value: unknown): "PASS" | "FINDINGS" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outputs = value as Record<string, unknown>;
  if (Object.keys(outputs).sort().join(",") !== "code_quality,security") return null;
  const codeQuality = outputs.code_quality;
  const security = outputs.security;
  if (typeof codeQuality !== "string" || typeof security !== "string") return null;
  const codeQualityValid =
    codeQuality === "CODE_QUALITY: PASS" ||
    codeQuality.startsWith("CODE_QUALITY: CHANGE_REQUIRED\n-");
  const securityValid = security === "SECURITY: PASS" || security.startsWith("SECURITY: FIX\n-");
  if (!codeQualityValid || !securityValid) return null;
  const derivedPass = codeQuality === "CODE_QUALITY: PASS" && security === "SECURITY: PASS";
  return derivedPass ? "PASS" : "FINDINGS";
}

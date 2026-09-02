import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSystemPrSpecialistProofLookup,
  extractSystemPrSpecialistProof,
  renderSystemPrSpecialistProofRequirement,
} from "./specialist-proof.js";

const roots: string[] = [];

function proofBlock(overrides: Record<string, unknown> = {}): string {
  return [
    "Review complete.",
    "<!-- wakewire-specialist-proof:v1",
    JSON.stringify(
      {
        reviewKey: "snapnhd/system#1142",
        headSha: "a".repeat(40),
        invocationId: "c".repeat(64),
        digest: "b".repeat(64),
        status: "PASS",
        ...overrides,
      },
      null,
      2,
    ),
    "-->",
  ].join("\n");
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("system PR specialist proof", () => {
  it("extracts one exact proof bound to the expected review key and HEAD", () => {
    expect(
      extractSystemPrSpecialistProof(proofBlock(), {
        reviewKey: "snapnhd/system#1142",
        headSha: "a".repeat(40),
        invocationId: "c".repeat(64),
      }),
    ).toEqual({
      reviewKey: "snapnhd/system#1142",
      headSha: "a".repeat(40),
      invocationId: "c".repeat(64),
      digest: "b".repeat(64),
      status: "PASS",
    });
  });

  it("allows unrelated multiline HTML comments after the unique proof block", () => {
    expect(
      extractSystemPrSpecialistProof(`${proofBlock()}\n<!-- unrelated\nstatus metadata\n-->`, {
        reviewKey: "snapnhd/system#1142",
        headSha: "a".repeat(40),
        invocationId: "c".repeat(64),
      }),
    ).toMatchObject({ status: "PASS", digest: "b".repeat(64) });
  });

  it.each([
    ["missing", "review complete"],
    ["duplicate", `${proofBlock()}\n${proofBlock()}`],
    ["wrong key", proofBlock({ reviewKey: "snapnhd/system#1124" })],
    ["wrong HEAD", proofBlock({ headSha: "c".repeat(40) })],
    ["wrong invocation", proofBlock({ invocationId: "d".repeat(64) })],
    ["incomplete", proofBlock({ status: "INCOMPLETE" })],
  ])("rejects %s proof evidence", (_label, response) => {
    expect(
      extractSystemPrSpecialistProof(response, {
        reviewKey: "snapnhd/system#1142",
        headSha: "a".repeat(40),
        invocationId: "c".repeat(64),
      }),
    ).toBeNull();
  });

  it("requires the exact machine-readable proof in full-review prompts", () => {
    expect(
      renderSystemPrSpecialistProofRequirement({
        reviewKey: "snapnhd/system#1142",
        headSha: "a".repeat(40),
        invocationId: "c".repeat(64),
      }),
    ).toContain('"reviewKey": "snapnhd/system#1142"');
  });

  it("verifies the digest and verdict against the coordinator's private state", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(tmpdir(), "wakewire-specialist-proof-")),
    );
    roots.push(root);
    await chmod(root, 0o700);
    const stateName = `code-quality-v2-${createHash("sha256")
      .update("snapnhd/system#1142")
      .digest("hex")}.json`;
    await writeFile(
      path.join(root, stateName),
      JSON.stringify({
        version: 2,
        review_key: "snapnhd/system#1142",
        events: [
          {
            digest: "b".repeat(64),
            outputs: { code_quality: "CODE_QUALITY: PASS", security: "SECURITY: PASS" },
            round: 1,
            status: "PASS",
          },
        ],
      }),
      { mode: 0o600 },
    );
    await chmod(path.join(root, stateName), 0o600);

    const lookup = createSystemPrSpecialistProofLookup({ stateRoot: root });
    const proof = {
      reviewKey: "snapnhd/system#1142",
      headSha: "a".repeat(40),
      invocationId: "c".repeat(64),
      digest: "b".repeat(64),
      status: "PASS" as const,
    };
    await expect(lookup(proof)).resolves.toBe(false);
    const attestationName = `wakewire-specialist-v1-${createHash("sha256")
      .update(`${proof.reviewKey}\0${proof.headSha}\0${proof.invocationId}`)
      .digest("hex")}.json`;
    await writeFile(
      path.join(root, attestationName),
      JSON.stringify({
        version: 1,
        review_key: proof.reviewKey,
        head_sha: proof.headSha,
        invocation_id: proof.invocationId,
        digest: proof.digest,
        status: proof.status,
      }),
      { mode: 0o600 },
    );
    await chmod(path.join(root, attestationName), 0o600);
    await expect(lookup(proof)).resolves.toBe(true);

    await writeFile(
      path.join(root, stateName),
      JSON.stringify({
        version: 2,
        review_key: proof.reviewKey,
        events: [
          {
            digest: proof.digest,
            outputs: { code_quality: "CODE_QUALITY: PASS", security: "SECURITY: PASS" },
            round: 1,
            status: "PASS",
          },
          {
            digest: "d".repeat(64),
            outputs: { code_quality: "CODE_QUALITY: PASS", security: "SECURITY: PASS" },
            round: 2,
            status: "PASS",
          },
        ],
      }),
      { mode: 0o600 },
    );
    await chmod(path.join(root, stateName), 0o600);
    await expect(lookup(proof)).resolves.toBe(false);

    await expect(
      lookup({
        reviewKey: "snapnhd/system#1142",
        headSha: "a".repeat(40),
        invocationId: "c".repeat(64),
        digest: "c".repeat(64),
        status: "PASS",
      }),
    ).resolves.toBe(false);

    await writeFile(
      path.join(root, stateName),
      JSON.stringify({
        version: 2,
        review_key: "snapnhd/system#1142",
        events: [
          {
            digest: "b".repeat(64),
            outputs: {
              code_quality: "CODE_QUALITY: PASS",
              security: "SECURITY: FIX\n- forged",
            },
            round: 1,
            status: "PASS",
          },
        ],
      }),
      { mode: 0o600 },
    );
    await chmod(path.join(root, stateName), 0o600);
    await expect(
      lookup({
        reviewKey: "snapnhd/system#1142",
        headSha: "a".repeat(40),
        invocationId: "c".repeat(64),
        digest: "b".repeat(64),
        status: "PASS",
      }),
    ).resolves.toBe(false);
  });

  it("rejects a specialist state root with special permission bits", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(tmpdir(), "wakewire-specialist-proof-")),
    );
    roots.push(root);
    const stateName = `code-quality-v2-${createHash("sha256")
      .update("snapnhd/system#1142")
      .digest("hex")}.json`;
    await writeFile(
      path.join(root, stateName),
      JSON.stringify({
        version: 2,
        review_key: "snapnhd/system#1142",
        events: [
          {
            digest: "b".repeat(64),
            outputs: { code_quality: "CODE_QUALITY: PASS", security: "SECURITY: PASS" },
            round: 1,
            status: "PASS",
          },
        ],
      }),
      { mode: 0o600 },
    );
    await chmod(path.join(root, stateName), 0o600);
    await chmod(root, 0o2700);

    const lookup = createSystemPrSpecialistProofLookup({ stateRoot: root });
    await expect(
      lookup({
        reviewKey: "snapnhd/system#1142",
        headSha: "a".repeat(40),
        invocationId: "c".repeat(64),
        digest: "b".repeat(64),
        status: "PASS",
      }),
    ).resolves.toBe(false);
  });
});

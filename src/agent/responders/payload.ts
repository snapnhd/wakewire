import type { AckJob } from "../store.js";
import { PermanentAckError } from "./types.js";

export class InvalidAckJobError extends PermanentAckError {}

export function assertAckJob(job: AckJob, provider: string, kind: string): void {
  if (job.provider.toLowerCase() !== provider) {
    throw new InvalidAckJobError(`expected ${provider} job, received ${job.provider}`);
  }
  if (job.ackKind !== kind) {
    throw new InvalidAckJobError(`expected ${kind} job, received ${job.ackKind}`);
  }
}

export function stringPayload(job: AckJob, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidAckJobError(`${job.provider} acknowledgment is missing payload.${key}`);
  }
  return value.trim();
}

export function optionalStringPayload(job: AckJob, key: string): string | undefined {
  const value = job.payload[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function stringArrayPayload(job: AckJob, key: string): string[] {
  const value = job.payload[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new InvalidAckJobError(`${job.provider} acknowledgment has invalid payload.${key}`);
  }
  return value as string[];
}

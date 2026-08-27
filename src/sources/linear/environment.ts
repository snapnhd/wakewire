import { type LinearViewerIdentity, linearViewerIdentity } from "./token.js";

export interface LinearEnvironmentIdentity extends LinearViewerIdentity {
  apiKey: string;
}

const EXPECTED_LINEAR_USER_NAME = "Chip Byte";
const EXPECTED_LINEAR_USER_EMAIL = "chip@snapcorp.com";

/** A dedicated Chip user API key mounted by 1Password; never persisted by WakeWire. */
export function linearApiKeyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = environment.LINEAR_API_KEY?.trim();
  return value || null;
}

export async function resolveLinearEnvironmentIdentity(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<LinearEnvironmentIdentity | null> {
  const apiKey = linearApiKeyFromEnvironment(environment);
  if (!apiKey) return null;
  const identity = await linearViewerIdentity(apiKey, fetchImpl, "api-key");
  if (
    identity.name.trim().toLocaleLowerCase("en-US") !==
      EXPECTED_LINEAR_USER_NAME.toLocaleLowerCase("en-US") ||
    identity.email.trim().toLocaleLowerCase("en-US") !== EXPECTED_LINEAR_USER_EMAIL
  ) {
    throw new Error(
      `LINEAR_API_KEY belongs to ${identity.name || "an unknown user"} <${identity.email || "unknown email"}>; expected ${EXPECTED_LINEAR_USER_NAME} <${EXPECTED_LINEAR_USER_EMAIL}>`,
    );
  }
  return { ...identity, apiKey };
}

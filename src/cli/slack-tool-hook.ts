import { codexPreToolUseOutput, decideSlackConnectorToolUse } from "../agent/slack-tool-policy.js";

/** Codex PreToolUse hook entrypoint. Invalid input exits 2 so Codex blocks. */
export async function runSlackToolHook(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  let raw = "";
  input.setEncoding("utf8");
  for await (const chunk of input) raw += chunk;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    errorOutput.write("WakeWire blocked malformed Codex hook JSON.\n");
    process.exitCode = 2;
    return;
  }

  const decision = decideSlackConnectorToolUse(payload);
  const hookOutput = codexPreToolUseOutput(decision);
  output.write(`${JSON.stringify(hookOutput)}\n`);
}

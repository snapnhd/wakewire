import { z } from "zod";

export const ExecutionModelSchema = z.enum([
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
]);
export type ExecutionModel = z.infer<typeof ExecutionModelSchema>;

export const ExecutionReasoningEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type ExecutionReasoningEffort = z.infer<typeof ExecutionReasoningEffortSchema>;

export const ExecutionModeSchema = z.enum(["current", "separate"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

const ReadyExecutionProfileSchema = z
  .object({
    version: z.literal(1),
    mode: ExecutionModeSchema,
    model: ExecutionModelSchema,
    reasoningEffort: ExecutionReasoningEffortSchema,
    source: z.enum(["default", "explicit", "ultracode"]),
    clarification: z.null(),
  })
  .strict();

const ClarificationExecutionProfileSchema = z
  .object({
    version: z.literal(1),
    // Clarifications always run in the asking task with the safe defaults.
    mode: z.literal("current"),
    model: z.literal("gpt-5.6-luna"),
    reasoningEffort: z.literal("low"),
    source: z.literal("explicit"),
    clarification: z.string().min(1),
  })
  .strict();

export const ExecutionProfileSchema = z.union([
  ReadyExecutionProfileSchema,
  ClarificationExecutionProfileSchema,
]);
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

export const DEFAULT_EXECUTION_PROFILE = Object.freeze({
  version: 1,
  mode: "current",
  model: "gpt-5.6-luna",
  reasoningEffort: "low",
  source: "default",
  clarification: null,
} satisfies z.infer<typeof ReadyExecutionProfileSchema>);

export const ULTRACODE_EXECUTION_PROFILE = Object.freeze({
  version: 1,
  mode: "current",
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
  source: "ultracode",
  clarification: null,
} satisfies z.infer<typeof ReadyExecutionProfileSchema>);

const MODEL_ALIASES = String.raw`(?:(?:(?:gpt[\s-]*)?(?:5\.6|5[\s-]+6)[\s-]+)?(?:luna|terra|sol)|(?:gpt[\s-]*)?5\.5|(?:gpt[\s-]*)?5\.4(?:[\s-]+mini)?|(?:(?:gpt[\s-]*)?5\.3[\s-]+)?(?:codex[\s-]+)?spark)`;
const MODEL_AT_START = new RegExp(`^(${MODEL_ALIASES})(?![A-Za-z0-9_-])`, "i");
const EFFORT_ALIASES = String.raw`(?:extra[\s-]+high|x[\s-]*high|light|low|medium|high|maximum|max|ultra)`;
const EFFORT_AT_START = new RegExp(`^(${EFFORT_ALIASES})(?![A-Za-z0-9_-])`, "i");

interface CollectedDirectives<T> {
  values: T[];
  invalid: string[];
}

/**
 * Resolve the small, operator-owned model grammar in an authenticated request.
 * Arbitrary model identifiers are never forwarded to Codex.
 */
export function parseExecutionProfile(requestText: string): ExecutionProfile {
  const separateTaskRequests = findSeparateTaskRequests(requestText);
  const mode = separateTaskRequests.length > 0 ? "separate" : "current";

  // Ultracode is intentionally a hard, case-insensitive keyword. Its contract
  // takes precedence over any other model or effort wording in the request.
  if (/\bultracode\b/i.test(requestText)) {
    return {
      ...ULTRACODE_EXECUTION_PROFILE,
      mode,
    };
  }

  const models = collectModelDirectives(requestText, separateTaskRequests);
  const efforts = collectEffortDirectives(requestText, separateTaskRequests);
  collectNaturalSeparateTaskDirectives(requestText, separateTaskRequests, models, efforts);
  const uniqueModels = unique(models.values);
  const uniqueEfforts = unique(efforts.values);
  const problems: string[] = [];

  if (models.invalid.length > 0) {
    problems.push("use one supported model: Luna, Terra, Sol, GPT-5.5, GPT-5.4, Mini, or Spark");
  }
  if (uniqueModels.length > 1) {
    problems.push("choose exactly one model");
  }
  if (efforts.invalid.length > 0) {
    problems.push("use one supported effort: light, low, medium, high, xhigh, max, or ultra");
  }
  if (uniqueEfforts.length > 1) {
    problems.push("choose exactly one effort level");
  }

  const model = uniqueModels[0] ?? DEFAULT_EXECUTION_PROFILE.model;
  const reasoningEffort = uniqueEfforts[0] ?? DEFAULT_EXECUTION_PROFILE.reasoningEffort;
  if (!isCompatible(model, reasoningEffort)) {
    problems.push(`${model} does not support ${reasoningEffort} effort`);
  }

  if (problems.length > 0) {
    return {
      version: 1,
      mode: "current",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      source: "explicit",
      clarification: `Please clarify the execution settings: ${unique(problems).join("; ")}.`,
    };
  }

  return {
    version: 1,
    mode,
    model,
    reasoningEffort,
    source: uniqueModels.length > 0 || uniqueEfforts.length > 0 ? "explicit" : "default",
    clarification: null,
  };
}

function collectModelDirectives(
  text: string,
  separateTaskRequests: readonly SeparateTaskRequest[],
): CollectedDirectives<ExecutionModel> {
  const result: CollectedDirectives<ExecutionModel> = { values: [], invalid: [] };
  const isDirective = (index: number) =>
    !followsDescriptiveSeparateTaskMention(text, index, separateTaskRequests);

  collectKeyed(text, /\bmodel(?:\s+name)?\s*[:=]\s*/gi, MODEL_AT_START, normalizeModel, result);

  collectCaptured(
    text,
    /\b(?:use|select|choose|run\s+with|with)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9._-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._-]*){0,2}?)\s+model\b/gi,
    normalizeModel,
    result,
    isDirective,
  );
  collectCaptured(
    text,
    /\b(?:switch|change|set)\s+(?:the\s+)?model\s+(?:to|as)\s+([A-Za-z0-9][A-Za-z0-9._-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._-]*){0,2})/gi,
    normalizeModel,
    result,
    isDirective,
  );
  collectCaptured(
    text,
    new RegExp(
      `\\b(?:use|using|run\\s+(?:this\\s+)?(?:with|on))\\s+(?:the\\s+)?(${MODEL_ALIASES})(?![A-Za-z0-9_-])`,
      "gi",
    ),
    normalizeModel,
    result,
    isDirective,
  );

  return result;
}

function collectEffortDirectives(
  text: string,
  separateTaskRequests: readonly SeparateTaskRequest[],
): CollectedDirectives<ExecutionReasoningEffort> {
  const result: CollectedDirectives<ExecutionReasoningEffort> = { values: [], invalid: [] };
  const isDirective = (index: number) =>
    !followsDescriptiveSeparateTaskMention(text, index, separateTaskRequests);

  collectKeyed(
    text,
    /\b(?:effort(?:\s+level)?|thinking|reasoning)\s*[:=]\s*/gi,
    EFFORT_AT_START,
    normalizeEffort,
    result,
    isDirective,
  );
  collectCaptured(
    text,
    /\b(?:at|with|use|using)\s+(?:an?\s+)?([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*)?)\s+(?:reasoning\s+)?effort(?:\s+level)?\b/gi,
    normalizeEffort,
    result,
    isDirective,
  );
  collectCaptured(
    text,
    /\b(?:set|change)\s+(?:the\s+)?(?:effort|thinking|reasoning)(?:\s+level)?\s+(?:to|as)\s+([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*)?)/gi,
    normalizeEffort,
    result,
    isDirective,
  );
  collectCaptured(
    text,
    new RegExp(
      `\\b(?:use|using|run\\s+(?:this\\s+)?(?:with|on))\\s+(?:the\\s+)?${MODEL_ALIASES}\\s+(${EFFORT_ALIASES})(?![A-Za-z0-9_-])`,
      "gi",
    ),
    normalizeEffort,
    result,
    isDirective,
  );

  return result;
}

function collectKeyed<T>(
  text: string,
  keyPattern: RegExp,
  validPrefix: RegExp,
  normalize: (raw: string) => T | null,
  result: CollectedDirectives<T>,
  acceptMatch: (index: number) => boolean = () => true,
): void {
  for (const match of text.matchAll(keyPattern)) {
    if (!acceptMatch(match.index ?? 0)) continue;
    const start = (match.index ?? 0) + match[0].length;
    const remainder = text.slice(start);
    const valid = remainder.match(validPrefix)?.[1];
    if (valid) {
      const value = normalize(valid);
      if (value) result.values.push(value);
      continue;
    }
    result.invalid.push(readInvalidValue(remainder));
  }
}

function collectCaptured<T>(
  text: string,
  pattern: RegExp,
  normalize: (raw: string) => T | null,
  result: CollectedDirectives<T>,
  acceptMatch: (index: number) => boolean = () => true,
): void {
  for (const match of text.matchAll(pattern)) {
    if (!acceptMatch(match.index ?? 0)) continue;
    const raw = match[1] ?? "";
    const value = normalize(raw);
    if (value) result.values.push(value);
    else result.invalid.push(raw || "<missing>");
  }
}

function normalizeModel(raw: string): ExecutionModel | null {
  const compact = raw.toLowerCase().replace(/[\s._-]+/g, "");
  if (compact === "luna" || compact === "56luna" || compact === "gpt56luna") {
    return "gpt-5.6-luna";
  }
  if (compact === "terra" || compact === "56terra" || compact === "gpt56terra") {
    return "gpt-5.6-terra";
  }
  if (compact === "sol" || compact === "56sol" || compact === "gpt56sol") {
    return "gpt-5.6-sol";
  }
  if (compact === "55" || compact === "gpt55") return "gpt-5.5";
  if (compact === "54" || compact === "gpt54") return "gpt-5.4";
  if (compact === "54mini" || compact === "gpt54mini" || compact === "mini") {
    return "gpt-5.4-mini";
  }
  if (
    compact === "spark" ||
    compact === "codexspark" ||
    compact === "53codexspark" ||
    compact === "gpt53codexspark"
  ) {
    return "gpt-5.3-codex-spark";
  }
  return null;
}

function normalizeEffort(raw: string): ExecutionReasoningEffort | null {
  const compact = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (compact === "light" || compact === "low") return "low";
  if (compact === "medium") return "medium";
  if (compact === "high") return "high";
  if (compact === "extrahigh" || compact === "xhigh") return "xhigh";
  if (compact === "max" || compact === "maximum") return "max";
  if (compact === "ultra") return "ultra";
  return null;
}

interface SeparateTaskRequest {
  end: number;
}

function findSeparateTaskRequests(text: string): SeparateTaskRequest[] {
  const requests: SeparateTaskRequest[] = [];
  const phrase = /\b(?:separate|seperate|new|another)\s+(?:codex\s+)?(?:chat|task|thread)\b/gi;
  for (const match of text.matchAll(phrase)) {
    const index = match.index ?? 0;
    const clauseStart = Math.max(
      text.lastIndexOf(".", index - 1),
      text.lastIndexOf("!", index - 1),
      text.lastIndexOf("?", index - 1),
      text.lastIndexOf(";", index - 1),
      text.lastIndexOf(",", index - 1),
      text.lastIndexOf("\n", index - 1),
    );
    const prefix = text.slice(clauseStart + 1, index);
    const suffix = text.slice(index + match[0].length);

    if (
      /\b(?:do\s+not|don['’]?t|dont|never|not|no|without|avoid|instead\s+of|rather\s+than)\b(?:\s+\S+){0,5}\s*$/i.test(
        prefix,
      )
    ) {
      continue;
    }

    // An action verb inside descriptive wording is not a request to dispatch.
    // For example, "explain how to use a separate chat" must stay in the
    // asking task even though "use" appears immediately before the phrase.
    if (/\b(?:ability|option)\s+to\b|\b(?:how|whether)\s+to\b/i.test(prefix)) {
      continue;
    }

    if (
      /\b(?:start|open|create|launch|spawn|fork|use|make|have|want|need|prefer|request|ask(?:\s+for)?|begin|spin\s+up)\s+(?:(?:this|that|it|me)\s+)?(?:an?\s+)?$/i.test(
        prefix,
      ) ||
      /\b(?:in|inside|into|via|using|from)\s+(?:an?\s+)?$/i.test(prefix) ||
      (/^\s*(?:(?:please|kindly|let['’]?s)\s+)?(?:an?\s+)?$/i.test(prefix) &&
        /^\s*(?::|[-—]|(?:to|for|with|please)\b)/i.test(suffix))
    ) {
      requests.push({ end: index + match[0].length });
    }
  }
  return requests;
}

function followsDescriptiveSeparateTaskMention(
  text: string,
  directiveIndex: number,
  requests: readonly SeparateTaskRequest[],
): boolean {
  const clauseStart = Math.max(
    text.lastIndexOf(".", directiveIndex - 1),
    text.lastIndexOf("!", directiveIndex - 1),
    text.lastIndexOf("?", directiveIndex - 1),
    text.lastIndexOf(";", directiveIndex - 1),
    text.lastIndexOf(",", directiveIndex - 1),
    text.lastIndexOf("\n", directiveIndex - 1),
  );
  const phrase = /\b(?:separate|seperate|new|another)\s+(?:codex\s+)?(?:chat|task|thread)\b/gi;
  let nearestEnd: number | null = null;
  for (const match of text.slice(clauseStart + 1, directiveIndex).matchAll(phrase)) {
    nearestEnd = clauseStart + 1 + (match.index ?? 0) + match[0].length;
  }
  if (nearestEnd === null) return false;
  return !requests.some((request) => request.end === nearestEnd);
}

/**
 * Natural settings such as "create a new task with Sol at high effort" are
 * accepted only when the preceding task phrase passed the explicit dispatch
 * checks above. This keeps bare prose about models or hypothetical tasks from
 * becoming execution directives.
 */
function collectNaturalSeparateTaskDirectives(
  text: string,
  requests: readonly SeparateTaskRequest[],
  models: CollectedDirectives<ExecutionModel>,
  efforts: CollectedDirectives<ExecutionReasoningEffort>,
): void {
  const settings = new RegExp(
    `^\\s+(?:with|using|on)\\s+(?:the\\s+)?(${MODEL_ALIASES})(?![A-Za-z0-9_-])(?:\\s+(?:at\\s+)?(${EFFORT_ALIASES})(?![A-Za-z0-9_-])(?:\\s+(?:reasoning\\s+)?effort(?:\\s+level)?)?)?`,
    "i",
  );

  for (const request of requests) {
    const match = text.slice(request.end).match(settings);
    if (!match) continue;

    const model = normalizeModel(match[1] ?? "");
    if (model) models.values.push(model);

    const effort = match[2] ? normalizeEffort(match[2]) : null;
    if (effort) efforts.values.push(effort);
  }
}

function isCompatible(model: ExecutionModel, effort: ExecutionReasoningEffort): boolean {
  if (model === "gpt-5.6-sol" || model === "gpt-5.6-terra") return true;
  if (model === "gpt-5.6-luna") return effort !== "ultra";
  return effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh";
}

function readInvalidValue(remainder: string): string {
  return remainder.trimStart().match(/^[^\s,;!?]+/)?.[0] ?? "<missing>";
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

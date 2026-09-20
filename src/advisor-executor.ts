import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  AgentLaunch,
  LAUNCH_PREFLIGHT_TIMEOUT_MS,
  LAUNCH_TERMINAL_TIMEOUT_MS,
  createDefaultAgentLaunchLoader,
  type AgentLaunchAvailableModel,
  type AgentLaunchDefinition,
  type AgentLaunchDependencies,
  type AgentLaunchEventBus,
  type AgentLaunchHost,
  type AgentLaunchModel,
  type AgentLaunchModules,
  type AgentLaunchResult,
} from "./agent-launch.ts";
import { THINKING_LEVEL_NAMES, type ThinkingLevelName, type ThinkingPolicy } from "./types.ts";

export const ADVISOR_TOOL_NAME = "advisor_ask";
export const ADVISOR_AGENT_NAME = "pi-delegation-policy.advisor";
export const ADVISOR_PROTOCOL_VERSION = "0.70.0";
export const ADVISOR_PREFLIGHT_TIMEOUT_MS = LAUNCH_PREFLIGHT_TIMEOUT_MS;
export const ADVISOR_TERMINAL_TIMEOUT_MS = LAUNCH_TERMINAL_TIMEOUT_MS;

/** UTF-8 caps of one advisor request and its reply. */
export const ADVISOR_QUESTION_MAX_BYTES = 2 * 1024;
export const ADVISOR_CONTEXT_MAX_BYTES = 4 * 1024;
export const ADVISOR_ADVICE_MAX_BYTES = 8 * 1024;

const ADVISOR_AGENT_PATH = resolve(
  fileURLToPath(new URL("../agents/pi-delegation-policy.advisor.md", import.meta.url)),
);

export const ADVISOR_THINKING_LEVELS = THINKING_LEVEL_NAMES;
export type AdvisorThinking = ThinkingLevelName;

export type AdvisorModel = AgentLaunchModel<AdvisorThinking>;
export type AdvisorAvailableModel = AgentLaunchAvailableModel;
export type AdvisorEventBus = AgentLaunchEventBus;
export type AdvisorExecutionHost = AgentLaunchHost;
export type AdvisorExecutorModules = AgentLaunchModules;

export const ADVISOR_ERROR_CODES = [
  "advisor-unavailable",
  "advisor-invalid-request",
  "advisor-busy",
  "advisor-failed",
  "advisor-timed-out",
  "advisor-cancelled",
] as const;
export type AdvisorErrorCode = (typeof ADVISOR_ERROR_CODES)[number];

export type AdvisorExecutorRequest = Readonly<{
  /** The bounded window, thread, question and extra context already rendered as text. */
  task: string;
  model: AdvisorModel;
  availableModels: readonly [AdvisorAvailableModel];
}>;

export type AdvisorExecutorResult =
  | { kind: "completed"; value: string }
  | { kind: Exclude<AdvisorErrorCode, "advisor-invalid-request"> };

export type AdvisorRequest = {
  question: string;
  context?: string;
  thinking: AdvisorThinking;
};

export type AdvisorValidation<T> = { ok: true; value: T } | { ok: false; code: AdvisorErrorCode };

export type AdvisorToolResult = {
  content: [{ type: "text"; text: string }];
  details: Record<string, never>;
};

const ADVISOR_INPUT_NAMES = ["question", "context", "thinking"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAdvisorThinking(value: unknown): value is AdvisorThinking {
  return (
    typeof value === "string" && (ADVISOR_THINKING_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Reads the tool input as a plain data record: exotic objects, accessors and
 * unknown keys are rejected instead of being copied or coerced.
 */
function readAdvisorInput(
  value: unknown,
): { question: unknown; context: unknown; thinking: unknown } | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const names = Object.getOwnPropertyNames(value);
    if (!names.every((name) => (ADVISOR_INPUT_NAMES as readonly string[]).includes(name)))
      return undefined;
    if (!names.includes("question") || !names.includes("thinking")) return undefined;

    const read = (name: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      return descriptor.value;
    };
    const question = read("question");
    const thinking = read("thinking");
    if (question === undefined || thinking === undefined) return undefined;
    return { question, context: names.includes("context") ? read("context") : undefined, thinking };
  } catch {
    return undefined;
  }
}

/** A chosen level must stay inside a configured policy; a fixed level is binding. */
function isWithinThinkingPolicy(
  thinking: AdvisorThinking,
  policy: ThinkingPolicy | undefined,
): boolean {
  if (!policy) return true;
  if ("level" in policy) return thinking === policy.level;
  const chosen = THINKING_LEVEL_NAMES.indexOf(thinking);
  return (
    chosen >= THINKING_LEVEL_NAMES.indexOf(policy.min) &&
    chosen <= THINKING_LEVEL_NAMES.indexOf(policy.max)
  );
}

export function parseAdvisorRequest(
  value: unknown,
  constraints: Readonly<{
    supportedThinking: ReadonlySet<AdvisorThinking>;
    thinkingPolicy: ThinkingPolicy | undefined;
  }>,
): AdvisorValidation<AdvisorRequest> {
  const fields = readAdvisorInput(value);
  if (!fields) return { ok: false, code: "advisor-invalid-request" };
  const { question, context, thinking } = fields;
  if (
    typeof question !== "string" ||
    question.length === 0 ||
    Buffer.byteLength(question, "utf8") > ADVISOR_QUESTION_MAX_BYTES ||
    (context !== undefined &&
      (typeof context !== "string" ||
        Buffer.byteLength(context, "utf8") > ADVISOR_CONTEXT_MAX_BYTES)) ||
    !isAdvisorThinking(thinking) ||
    !constraints.supportedThinking.has(thinking) ||
    !isWithinThinkingPolicy(thinking, constraints.thinkingPolicy)
  ) {
    return { ok: false, code: "advisor-invalid-request" };
  }
  return {
    ok: true,
    value: {
      question,
      ...(typeof context === "string" && context.length > 0 ? { context } : {}),
      thinking,
    },
  };
}

function isAdvisorAdvice(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const ADVISOR_LAUNCH = {
  agentName: ADVISOR_AGENT_NAME,
  agentPath: ADVISOR_AGENT_PATH,
  protocolVersion: ADVISOR_PROTOCOL_VERSION,
  // A text result exposes no structured_output, so the child must declare no internal tool.
  internalTools: [],
  // The task is the bounded window, thread, question and extra context already
  // rendered and measured by advisor-context; re-serializing it here would drift.
  buildTask: (request: AdvisorExecutorRequest) => request.task,
  result: { variant: "text", isValue: isAdvisorAdvice },
} satisfies AgentLaunchDefinition<AdvisorExecutorRequest, string>;

export const createDefaultAdvisorExecutorLoader = createDefaultAgentLaunchLoader;

function advisorResult(result: AgentLaunchResult<string>): AdvisorExecutorResult {
  switch (result.kind) {
    case "completed":
      return { kind: "completed", value: result.value };
    case "unavailable":
      return { kind: "advisor-unavailable" };
    case "busy":
      return { kind: "advisor-busy" };
    case "cancelled":
      return { kind: "advisor-cancelled" };
    case "timed-out":
      return { kind: "advisor-timed-out" };
    case "failed":
      return { kind: "advisor-failed" };
  }
}

export function advisorToolError(code: AdvisorErrorCode): AdvisorToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", code }) }],
    details: {},
  };
}

/**
 * Bounded reply: the advice plus the model and thinking that produced it. An
 * advice over the cap is reported as a bounded error; nothing is written, so
 * there is no artifact, temporary file, or recovery surface.
 */
export function finalizeAdvisorAdvice(advice: string, model: AdvisorModel): AdvisorToolResult {
  if (advice.trim().length === 0 || Buffer.byteLength(advice, "utf8") > ADVISOR_ADVICE_MAX_BYTES) {
    return advisorToolError("advisor-failed");
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "advised",
          advice,
          model: `${model.provider}/${model.id}`,
          thinking: model.thinking,
        }),
      },
    ],
    details: {},
  };
}

/**
 * One pending advisor request per instance, independent from the reader's.
 */
export class AdvisorExecutor {
  private readonly launch: AgentLaunch<AdvisorExecutorRequest, string>;

  constructor(dependencies: AgentLaunchDependencies = {}) {
    this.launch = new AgentLaunch(ADVISOR_LAUNCH, dependencies);
  }

  get busy(): boolean {
    return this.launch.busy;
  }

  execute(
    request: AdvisorExecutorRequest,
    host: AdvisorExecutionHost,
    signal?: AbortSignal,
  ): Promise<AdvisorExecutorResult> {
    return this.launch.execute(request, host, signal).then(advisorResult);
  }

  cancel(): void {
    this.launch.cancel();
  }

  rotate(): void {
    this.launch.rotate();
  }

  close(): void {
    this.launch.close();
  }
}

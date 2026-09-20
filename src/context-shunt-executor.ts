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
  type AgentLaunchJsonSchema,
  type AgentLaunchModel,
  type AgentLaunchModules,
  type AgentLaunchResult,
} from "./agent-launch.ts";
import type { SourceSnapshot } from "./context-shunt.ts";
import type { ReaderAnswer, ReaderThinking } from "./context-shunt-reader.ts";

export const CONTEXT_SHUNT_READER_AGENT_NAME = "pi-delegation-policy.context-shunt-inline-reader";
export const CONTEXT_SHUNT_READER_PROTOCOL_VERSION = "0.70.0";
export const READER_PREFLIGHT_TIMEOUT_MS = LAUNCH_PREFLIGHT_TIMEOUT_MS;
export const READER_TERMINAL_TIMEOUT_MS = LAUNCH_TERMINAL_TIMEOUT_MS;

const CONTEXT_SHUNT_READER_AGENT_PATH = resolve(
  fileURLToPath(
    new URL("../agents/pi-delegation-policy.context-shunt-inline-reader.md", import.meta.url),
  ),
);

export type ReaderModel = AgentLaunchModel<ReaderThinking>;
export type ReaderAvailableModel = AgentLaunchAvailableModel;
export type ReaderEventBus = AgentLaunchEventBus;
export type ReaderExecutionHost = AgentLaunchHost;
export type ReaderJsonSchema = AgentLaunchJsonSchema;
export type ReaderExecutorModules = AgentLaunchModules;

export type ReaderExecutorRequest = Readonly<{
  question: string;
  snapshot: SourceSnapshot;
  model: ReaderModel;
  availableModels: readonly [ReaderAvailableModel];
}>;

export type ReaderExecutorResult =
  | { kind: "completed"; value: ReaderAnswer }
  | { kind: "reader-unavailable" }
  | { kind: "reader-busy" }
  | { kind: "cancelled" }
  | { kind: "timed-out" }
  | { kind: "failed" };

export const createDefaultReaderExecutorLoader = createDefaultAgentLaunchLoader;

export function buildReaderTask(request: ReaderExecutorRequest): string {
  return JSON.stringify({
    sourceId: request.snapshot.sourceId,
    question: request.question,
    snapshot: {
      sourceId: request.snapshot.sourceId,
      text: request.snapshot.text,
      lineCount: request.snapshot.lineCount,
    },
  });
}

export function createReaderAnswerSchema(
  snapshot: Pick<SourceSnapshot, "sourceId" | "lineCount">,
): ReaderJsonSchema {
  const citation = {
    type: "object",
    additionalProperties: false,
    required: ["sourceId", "startLine", "endLine"],
    properties: {
      sourceId: { const: snapshot.sourceId },
      startLine: { type: "integer", minimum: 1, maximum: snapshot.lineCount },
      endLine: { type: "integer", minimum: 1, maximum: snapshot.lineCount },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "answer", "citations"],
    properties: {
      status: { enum: ["answered", "insufficient-evidence"] },
      answer: { type: "string", minLength: 1 },
      citations: { type: "array", maxItems: 16, items: citation },
    },
    allOf: [
      {
        if: { properties: { status: { const: "answered" } } },
        then: { properties: { citations: { minItems: 1 } } },
      },
      {
        if: { properties: { status: { const: "insufficient-evidence" } } },
        then: { properties: { citations: { maxItems: 0 } } },
      },
    ],
  };
}

function isReaderAnswer(value: unknown): value is ReaderAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = (value as { status?: unknown }).status;
  return status === "answered" || status === "insufficient-evidence";
}

const READER_LAUNCH = {
  agentName: CONTEXT_SHUNT_READER_AGENT_NAME,
  agentPath: CONTEXT_SHUNT_READER_AGENT_PATH,
  protocolVersion: CONTEXT_SHUNT_READER_PROTOCOL_VERSION,
  internalTools: ["structured_output"],
  buildTask: buildReaderTask,
  result: {
    variant: "structured",
    buildSchema: (request: ReaderExecutorRequest) => createReaderAnswerSchema(request.snapshot),
    isValue: isReaderAnswer,
  },
} satisfies AgentLaunchDefinition<ReaderExecutorRequest, ReaderAnswer>;

function readerResult(result: AgentLaunchResult<ReaderAnswer>): ReaderExecutorResult {
  switch (result.kind) {
    case "completed":
      return { kind: "completed", value: result.value };
    case "unavailable":
      return { kind: "reader-unavailable" };
    case "busy":
      return { kind: "reader-busy" };
    case "cancelled":
      return { kind: "cancelled" };
    case "timed-out":
      return { kind: "timed-out" };
    case "failed":
      return { kind: "failed" };
  }
}

export class ContextShuntExecutor {
  private readonly launch: AgentLaunch<ReaderExecutorRequest, ReaderAnswer>;

  constructor(dependencies: AgentLaunchDependencies = {}) {
    this.launch = new AgentLaunch(READER_LAUNCH, dependencies);
  }

  get busy(): boolean {
    return this.launch.busy;
  }

  execute(
    request: ReaderExecutorRequest,
    host: ReaderExecutionHost,
    signal?: AbortSignal,
  ): Promise<ReaderExecutorResult> {
    return this.launch.execute(request, host, signal).then(readerResult);
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

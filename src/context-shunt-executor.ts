import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { SourceSnapshot } from "./context-shunt.ts";
import type { ReaderAnswer, ReaderThinking } from "./context-shunt-reader.ts";

export const CONTEXT_SHUNT_READER_AGENT_NAME = "pi-delegation-policy.context-shunt-inline-reader";
export const CONTEXT_SHUNT_READER_PROTOCOL_VERSION = "0.66.0";
export const READER_PREFLIGHT_TIMEOUT_MS = 5_000;
export const READER_TERMINAL_TIMEOUT_MS = 120_000;

const CONTEXT_SHUNT_READER_AGENT_PATH = resolve(
  fileURLToPath(
    new URL("../agents/pi-delegation-policy.context-shunt-inline-reader.md", import.meta.url),
  ),
);
const SHA256_LOWER_HEX = /^[0-9a-f]{64}$/;
const DIAGNOSTIC_SEVERITIES = new Set(["warning", "host-required"]);
const DELEGATION_EVENTS = {
  request: "prompt-template:subagent:request",
  started: "prompt-template:subagent:started",
  response: "prompt-template:subagent:response",
  cancel: "prompt-template:subagent:cancel",
} as const;

export type ReaderModel = Readonly<{ provider: string; id: string; thinking: ReaderThinking }>;
export type ReaderAvailableModel = Readonly<{
  provider: string;
  id: string;
  fullId: string;
  reasoning?: boolean;
}>;
export type ReaderEventBus = Readonly<{
  on(event: string, listener: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
}>;
export type ReaderExecutionHost = Readonly<{ cwd: string; events: ReaderEventBus }>;

export type ReaderExecutorRequest = Readonly<{
  question: string;
  snapshot: SourceSnapshot;
  model: ReaderModel;
  availableModels: readonly [ReaderAvailableModel];
}>;

export type ReaderJsonSchema = Readonly<Record<string, unknown>>;
type ReaderLaunchContract = Readonly<Record<string, unknown>>;
type ReaderPreflight = (input: unknown) => Promise<unknown>;
type DynamicModuleLoader = (specifier: string) => Promise<unknown>;

export type ReaderExecutorModules = Readonly<{
  resolveSubagentLaunchContract: ReaderPreflight;
  requestEvent: string;
  startedEvent: string;
  responseEvent: string;
  cancelEvent: string;
}>;

export type ReaderExecutorResult =
  | { kind: "completed"; value: ReaderAnswer }
  | { kind: "reader-unavailable" }
  | { kind: "reader-busy" }
  | { kind: "cancelled" }
  | { kind: "timed-out" }
  | { kind: "failed" };

type Timer = ReturnType<typeof setTimeout>;
type ReaderExecutorDependencies = {
  loader?: () => Promise<ReaderExecutorModules | undefined>;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  createId?: () => string;
};

type ActiveRun = {
  generation: number;
  host: ReaderExecutionHost;
  ownerRunId: string;
  requestId: string;
  nodeId: string;
  modules: ReaderExecutorModules | undefined;
  requestSent: boolean;
  started: boolean;
  settled: boolean;
  cancelSent: boolean;
  unsubscribe: Array<() => void>;
  preflightTimer: Timer | undefined;
  startTimer: Timer | undefined;
  terminalTimer: Timer | undefined;
  removeAbort: (() => void) | undefined;
  settle: (result: ReaderExecutorResult) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function isLowerHexDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_LOWER_HEX.test(value);
}

function isReaderAnswer(value: unknown): value is ReaderAnswer {
  return (
    isRecord(value) && (value.status === "answered" || value.status === "insufficient-evidence")
  );
}

function isPlainStructuredResult(
  value: unknown,
): value is Readonly<{ kind: "structured"; value: unknown }> {
  return (
    isRecord(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.keys(value).length === 2 &&
    value.kind === "structured" &&
    "value" in value
  );
}

function modelName(model: ReaderModel): string {
  return `${model.provider}/${model.id}:${model.thinking}`;
}

export function createDefaultReaderExecutorLoader(
  loadModule: DynamicModuleLoader = (specifier) => import(specifier),
): () => Promise<ReaderExecutorModules | undefined> {
  return () =>
    Promise.all([loadModule("pi-subagents/preflight"), loadModule("pi-subagents/delegation")])
      .then(([preflight, delegation]) => {
        if (!isRecord(preflight) || !isRecord(delegation)) return undefined;
        const resolveLaunchContract = preflight.resolveSubagentLaunchContract;
        const requestEvent = delegation.SUBAGENT_DELEGATION_REQUEST_EVENT;
        const startedEvent = delegation.SUBAGENT_DELEGATION_STARTED_EVENT;
        const responseEvent = delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT;
        const cancelEvent = delegation.SUBAGENT_DELEGATION_CANCEL_EVENT;
        if (
          typeof resolveLaunchContract !== "function" ||
          requestEvent !== DELEGATION_EVENTS.request ||
          startedEvent !== DELEGATION_EVENTS.started ||
          responseEvent !== DELEGATION_EVENTS.response ||
          cancelEvent !== DELEGATION_EVENTS.cancel
        ) {
          return undefined;
        }
        const resolveSubagentLaunchContract: ReaderPreflight = async (input) =>
          resolveLaunchContract(input);
        return {
          resolveSubagentLaunchContract,
          requestEvent,
          startedEvent,
          responseEvent,
          cancelEvent,
        };
      })
      .catch(() => undefined);
}

const defaultLoader = createDefaultReaderExecutorLoader();

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

function createPreflightInput(
  request: ReaderExecutorRequest,
  cwd: string,
  requestId: string,
): Record<string, unknown> {
  return {
    agent: CONTEXT_SHUNT_READER_AGENT_NAME,
    cwd,
    task: buildReaderTask(request),
    context: "fresh",
    model: `${request.model.provider}/${request.model.id}`,
    thinking: request.model.thinking,
    availableModels: request.availableModels,
    artifacts: false,
    output: false,
    outputSchema: createReaderAnswerSchema(request.snapshot),
    skill: false,
    runId: requestId,
  };
}

function validateReaderContract(
  value: unknown,
  request: ReaderExecutorRequest,
  active: Pick<ActiveRun, "requestId" | "host">,
): value is ReaderLaunchContract {
  try {
    if (!isRecord(value) || value.ok !== true || !isRecord(value.contract)) return false;
    const contract = value.contract;
    if (
      contract.version !== 2 ||
      !isRecord(contract.protocol) ||
      contract.protocol.lifecycleArtifactVersion !== 3 ||
      contract.protocol.packageVersion !== CONTEXT_SHUNT_READER_PROTOCOL_VERSION ||
      contract.runId !== active.requestId ||
      !isLowerHexDigest(contract.digest)
    )
      return false;

    if (
      !isRecord(contract.agent) ||
      contract.agent.name !== CONTEXT_SHUNT_READER_AGENT_NAME ||
      contract.agent.localName !== CONTEXT_SHUNT_READER_AGENT_NAME ||
      contract.agent.source !== "package" ||
      (contract.agent.packageName !== undefined &&
        contract.agent.packageName !== "pi-delegation-policy") ||
      contract.agent.definitionProjectionVersion !== 1 ||
      contract.agent.filePath !== CONTEXT_SHUNT_READER_AGENT_PATH ||
      !exactStrings(contract.agent.shadowedCandidates, []) ||
      !isLowerHexDigest(contract.agent.definitionDigest)
    )
      return false;

    const resolvedModel = modelName(request.model);
    if (
      !isLowerHexDigest(contract.launchContractDigest) ||
      contract.context !== "fresh" ||
      contract.model !== resolvedModel ||
      !exactStrings(contract.modelCandidates, [resolvedModel]) ||
      contract.thinking !== request.model.thinking ||
      contract.systemPromptMode !== "replace" ||
      contract.inheritProjectContext !== false ||
      contract.inheritSkills !== false
    )
      return false;

    if (
      !isRecord(contract.skills) ||
      !exactStrings(contract.skills.requested, []) ||
      !exactStrings(contract.skills.resolved, []) ||
      !exactStrings(contract.skills.missing, [])
    )
      return false;

    if (
      !isRecord(contract.tools) ||
      contract.tools.explicitAllowlist !== true ||
      !exactStrings(contract.tools.mcp, []) ||
      !exactStrings(contract.tools.requestedBuiltin, []) ||
      !exactStrings(contract.tools.declaredBuiltin, []) ||
      !exactStrings(contract.tools.effectiveAllowlist, ["structured_output"]) ||
      !exactStrings(contract.tools.requiredChildTools, ["structured_output"]) ||
      !exactStrings(contract.tools.internalTools, ["structured_output"]) ||
      !exactStrings(contract.tools.effectiveMcpTools, []) ||
      !exactStrings(contract.tools.toolExtensionPaths, []) ||
      !exactStrings(contract.tools.configuredExtensions, []) ||
      contract.tools.disableAmbientExtensions !== true ||
      contract.tools.fanoutAuthorized !== false ||
      "capabilityCeiling" in contract.tools ||
      "capabilityAudit" in contract.tools ||
      !Array.isArray(contract.tools.runtimeExtensions) ||
      contract.tools.runtimeExtensions.length === 0 ||
      !contract.tools.runtimeExtensions.every(
        (extension) => typeof extension === "string" && extension.length > 0,
      ) ||
      !exactStrings(contract.tools.extensionArgs, contract.tools.runtimeExtensions)
    )
      return false;

    if (
      !isRecord(contract.roots) ||
      contract.roots.cwd !== resolve(active.host.cwd) ||
      "artifactsDir" in contract.roots ||
      "artifactPaths" in contract.roots ||
      "outputPath" in contract.roots
    )
      return false;

    return (
      Array.isArray(contract.diagnostics) &&
      contract.diagnostics.every(
        (diagnostic) =>
          isRecord(diagnostic) &&
          typeof diagnostic.severity === "string" &&
          DIAGNOSTIC_SEVERITIES.has(diagnostic.severity) &&
          typeof diagnostic.code === "string" &&
          diagnostic.code.length > 0 &&
          typeof diagnostic.message === "string",
      )
    );
  } catch {
    return false;
  }
}

function requestPayload(
  active: ActiveRun,
  request: ReaderExecutorRequest,
): Record<string, unknown> {
  return {
    requestId: active.requestId,
    ownerRunId: active.ownerRunId,
    nodeId: active.nodeId,
    agent: CONTEXT_SHUNT_READER_AGENT_NAME,
    cwd: active.host.cwd,
    task: buildReaderTask(request),
    context: "fresh",
    model: `${request.model.provider}/${request.model.id}`,
    thinking: request.model.thinking,
    timeoutMs: READER_TERMINAL_TIMEOUT_MS,
    artifacts: false,
    skill: false,
    result: { kind: "structured", schema: createReaderAnswerSchema(request.snapshot) },
  };
}

export class ContextShuntExecutor {
  private readonly loader: () => Promise<ReaderExecutorModules | undefined>;
  private readonly setTimer: (callback: () => void, delay: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly createId: () => string;
  private generation = 0;
  private ownerRunId: string;
  private active: ActiveRun | undefined;
  private closed = false;

  constructor(dependencies: ReaderExecutorDependencies = {}) {
    this.loader = dependencies.loader ?? defaultLoader;
    this.setTimer = dependencies.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));
    this.createId = dependencies.createId ?? randomUUID;
    this.ownerRunId = this.createId();
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  execute(
    request: ReaderExecutorRequest,
    host: ReaderExecutionHost,
    signal?: AbortSignal,
  ): Promise<ReaderExecutorResult> {
    if (this.closed) return Promise.resolve({ kind: "reader-unavailable" });
    if (this.active) return Promise.resolve({ kind: "reader-busy" });
    return new Promise((resolveResult) => {
      const active: ActiveRun = {
        generation: this.generation,
        host,
        ownerRunId: this.ownerRunId,
        requestId: this.createId(),
        nodeId: this.createId(),
        modules: undefined,
        requestSent: false,
        started: false,
        settled: false,
        cancelSent: false,
        unsubscribe: [],
        preflightTimer: undefined,
        startTimer: undefined,
        terminalTimer: undefined,
        removeAbort: undefined,
        settle: (result) => {
          if (active.settled) return;
          active.settled = true;
          this.cleanup(active);
          if (this.active === active) this.active = undefined;
          resolveResult(result);
        },
      };
      this.active = active;
      active.preflightTimer = this.setTimer(
        () => active.settle({ kind: "reader-unavailable" }),
        READER_PREFLIGHT_TIMEOUT_MS,
      );
      if (signal) {
        const abort = () => this.cancelActive(active, "cancelled");
        signal.addEventListener("abort", abort, { once: true });
        active.removeAbort = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          this.cancelActive(active, "cancelled");
          return;
        }
      }
      void this.begin(active, request);
    });
  }

  cancel(): void {
    if (this.active) this.cancelActive(this.active, "cancelled");
  }

  rotate(): void {
    this.cancel();
    this.generation += 1;
    this.ownerRunId = this.createId();
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.cancel();
      this.generation += 1;
    }
  }

  private isLive(active: ActiveRun): boolean {
    return (
      !this.closed &&
      !active.settled &&
      this.active === active &&
      active.generation === this.generation &&
      active.ownerRunId === this.ownerRunId
    );
  }

  private async begin(active: ActiveRun, request: ReaderExecutorRequest): Promise<void> {
    let modules: ReaderExecutorModules | undefined;
    try {
      modules = await this.loader();
    } catch {
      modules = undefined;
    }
    if (!this.isLive(active)) return;
    if (!modules) {
      active.settle({ kind: "reader-unavailable" });
      return;
    }
    active.modules = modules;

    let resolved: unknown;
    try {
      resolved = await modules.resolveSubagentLaunchContract(
        createPreflightInput(request, active.host.cwd, active.requestId),
      );
    } catch {
      resolved = undefined;
    }
    if (!this.isLive(active)) return;
    if (!validateReaderContract(resolved, request, active)) {
      active.settle({ kind: "reader-unavailable" });
      return;
    }

    const contract = (resolved as { contract: ReaderLaunchContract }).contract;
    try {
      active.unsubscribe.push(
        active.host.events.on(modules.startedEvent, (payload) => this.onStarted(active, payload)),
      );
      active.unsubscribe.push(
        active.host.events.on(modules.responseEvent, (payload) =>
          this.onResponse(active, contract, request, payload),
        ),
      );
      if (!this.isLive(active)) return;

      active.requestSent = true;
      this.clearPreflightTimer(active);
      active.startTimer = this.setTimer(
        () => this.cancelActive(active, "reader-unavailable"),
        READER_PREFLIGHT_TIMEOUT_MS,
      );
      active.host.events.emit(modules.requestEvent, requestPayload(active, request));
      if (!this.isLive(active)) return;
    } catch {
      if (!active.settled) {
        active.settle({ kind: "reader-unavailable" });
        this.emitCancel(active);
      }
    }
  }

  private matchesTuple(active: ActiveRun, payload: unknown): payload is Record<string, unknown> {
    return (
      isRecord(payload) &&
      payload.requestId === active.requestId &&
      payload.ownerRunId === active.ownerRunId &&
      payload.nodeId === active.nodeId
    );
  }

  private clearPreflightTimer(active: ActiveRun): void {
    if (active.preflightTimer) this.clearTimer(active.preflightTimer);
    active.preflightTimer = undefined;
  }

  private onStarted(active: ActiveRun, payload: unknown): void {
    if (!this.isLive(active) || !this.matchesTuple(active, payload) || active.started) return;
    active.started = true;
    if (active.startTimer) this.clearTimer(active.startTimer);
    active.startTimer = undefined;
    active.terminalTimer = this.setTimer(
      () => this.cancelActive(active, "timed-out"),
      READER_TERMINAL_TIMEOUT_MS,
    );
  }

  private terminalMetadataMatches(
    payload: Record<string, unknown>,
    contract: ReaderLaunchContract,
    request: ReaderExecutorRequest,
    requireAll: boolean,
  ): boolean {
    const expected = {
      agent: CONTEXT_SHUNT_READER_AGENT_NAME,
      model: contract.model,
      thinking: request.model.thinking,
      launchContractDigest: contract.launchContractDigest,
    };
    return Object.entries(expected).every(([key, value]) =>
      requireAll ? payload[key] === value : !(key in payload) || payload[key] === value,
    );
  }

  private onResponse(
    active: ActiveRun,
    contract: ReaderLaunchContract,
    request: ReaderExecutorRequest,
    payload: unknown,
  ): void {
    if (!this.isLive(active) || !this.matchesTuple(active, payload)) return;
    const status = payload.status;
    const earlyUnavailable =
      status === "invalid_request" ||
      status === "unavailable_context" ||
      status === "duplicate_node";

    if (!active.started) {
      if (!earlyUnavailable) return;
      active.settle(
        this.terminalMetadataMatches(payload, contract, request, false)
          ? { kind: "reader-unavailable" }
          : { kind: "failed" },
      );
      return;
    }

    if (status === "completed") {
      if (
        !this.terminalMetadataMatches(payload, contract, request, true) ||
        !isPlainStructuredResult(payload.result) ||
        !isReaderAnswer(payload.result.value)
      ) {
        active.settle({ kind: "failed" });
      } else {
        active.settle({ kind: "completed", value: payload.result.value });
      }
      return;
    }

    if (typeof status !== "string") return;
    if (!this.terminalMetadataMatches(payload, contract, request, false)) {
      active.settle({ kind: "failed" });
      return;
    }
    if (status === "cancelled" || status === "interrupted") {
      active.settle({ kind: "cancelled" });
      return;
    }
    if (status === "timed_out") {
      active.settle({ kind: "timed-out" });
      return;
    }
    if (
      status === "unavailable_context" ||
      status === "invalid_request" ||
      status === "duplicate_node"
    ) {
      active.settle({ kind: "reader-unavailable" });
      return;
    }
    if (
      status === "turn_budget_exhausted" ||
      status === "tool_budget_exhausted" ||
      status === "structured_output_failed" ||
      status === "acceptance_failed" ||
      status === "failed"
    ) {
      active.settle({ kind: "failed" });
    }
  }

  private emitCancel(active: ActiveRun): void {
    if (!active.requestSent || active.cancelSent || !active.modules) return;
    active.cancelSent = true;
    try {
      active.host.events.emit(active.modules.cancelEvent, {
        requestId: active.requestId,
        ownerRunId: active.ownerRunId,
        nodeId: active.nodeId,
      });
    } catch {
      // The local operation remains bounded even when the foreign event bus rejects cancellation.
    }
  }

  private cancelActive(
    active: ActiveRun,
    result: "cancelled" | "reader-unavailable" | "timed-out",
  ): void {
    if (active.settled) return;
    active.settle({ kind: result });
    this.emitCancel(active);
  }

  private cleanup(active: ActiveRun): void {
    for (const timer of [active.preflightTimer, active.startTimer, active.terminalTimer])
      if (timer) this.clearTimer(timer);
    active.preflightTimer = undefined;
    active.startTimer = undefined;
    active.terminalTimer = undefined;
    active.removeAbort?.();
    active.removeAbort = undefined;
    for (const unsubscribe of active.unsubscribe.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // The result has already been settled; broken cleanup hooks cannot revive this run.
      }
    }
  }
}

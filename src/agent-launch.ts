import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export const LAUNCH_PREFLIGHT_TIMEOUT_MS = 5_000;
export const LAUNCH_TERMINAL_TIMEOUT_MS = 120_000;

const PACKAGE_NAME = "pi-delegation-policy";
const SHA256_LOWER_HEX = /^[0-9a-f]{64}$/;
const DIAGNOSTIC_SEVERITIES = new Set(["warning", "host-required"]);
const DELEGATION_EVENTS = {
  request: "prompt-template:subagent:request",
  started: "prompt-template:subagent:started",
  response: "prompt-template:subagent:response",
  cancel: "prompt-template:subagent:cancel",
} as const;

type Timer = ReturnType<typeof setTimeout>;
type DynamicModuleLoader = (specifier: string) => Promise<unknown>;

export type AgentLaunchModel<Thinking extends string = string> = Readonly<{
  provider: string;
  id: string;
  thinking: Thinking;
}>;
export type AgentLaunchAvailableModel = Readonly<{
  provider: string;
  id: string;
  fullId: string;
  reasoning?: boolean;
}>;
export type AgentLaunchEventBus = Readonly<{
  on(event: string, listener: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
}>;
export type AgentLaunchHost = Readonly<{ cwd: string; events: AgentLaunchEventBus }>;

export type AgentLaunchRequest = Readonly<{
  model: AgentLaunchModel;
  availableModels: readonly [AgentLaunchAvailableModel];
}>;

export type AgentLaunchJsonSchema = Readonly<Record<string, unknown>>;
type AgentLaunchContract = Readonly<Record<string, unknown>>;
export type AgentLaunchPreflight = (input: unknown) => Promise<unknown>;

export type AgentLaunchModules = Readonly<{
  resolveSubagentLaunchContract: AgentLaunchPreflight;
  requestEvent: string;
  startedEvent: string;
  responseEvent: string;
  cancelEvent: string;
}>;

export type AgentLaunchResult<Value> =
  | { kind: "completed"; value: Value }
  | { kind: "unavailable" }
  | { kind: "busy" }
  | { kind: "cancelled" }
  | { kind: "timed-out" }
  | { kind: "failed" };

export type AgentLaunchResultExpectation<Request, Value> =
  | Readonly<{
      variant: "structured";
      buildSchema: (request: Request) => AgentLaunchJsonSchema;
      /** Validates the payload carried by the terminal `result.value`. */
      isValue: (value: unknown) => value is Value;
    }>
  | Readonly<{
      variant: "text";
      /** Validates the payload carried by the terminal `result.text`. */
      isValue: (value: unknown) => value is Value;
    }>;

/**
 * Everything one consumer must supply to reuse the strict launch path: the
 * packaged profile it launches, the task it sends, and the result it accepts.
 */
export type AgentLaunchDefinition<Request extends AgentLaunchRequest, Value> = Readonly<{
  agentName: string;
  agentPath: string;
  protocolVersion: string;
  /**
   * Builtin tools the child must expose. A profile that declares no tools and no
   * extensions exposes exactly these, so the contract must report the same list
   * as its effective allowlist, its required child tools, and its internal tools.
   */
  internalTools: readonly string[];
  buildTask: (request: Request) => string;
  result: AgentLaunchResultExpectation<Request, Value>;
}>;

export type AgentLaunchDependencies = {
  loader?: () => Promise<AgentLaunchModules | undefined>;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  createId?: () => string;
};

type ActiveRun<Value> = {
  generation: number;
  host: AgentLaunchHost;
  ownerRunId: string;
  requestId: string;
  nodeId: string;
  modules: AgentLaunchModules | undefined;
  requestSent: boolean;
  started: boolean;
  settled: boolean;
  cancelSent: boolean;
  unsubscribe: Array<() => void>;
  preflightTimer: Timer | undefined;
  startTimer: Timer | undefined;
  terminalTimer: Timer | undefined;
  removeAbort: (() => void) | undefined;
  settle: (result: AgentLaunchResult<Value>) => void;
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

function modelName(model: AgentLaunchModel): string {
  return `${model.provider}/${model.id}:${model.thinking}`;
}

function isPlainResultWrapper(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.keys(value).length === 2
  );
}

function completedValue<Request extends AgentLaunchRequest, Value>(
  result: unknown,
  expectation: AgentLaunchResultExpectation<Request, Value>,
): { ok: true; value: Value } | { ok: false } {
  if (!isPlainResultWrapper(result)) return { ok: false };
  if (expectation.variant === "structured") {
    if (result.kind !== "structured" || !("value" in result)) return { ok: false };
    return expectation.isValue(result.value) ? { ok: true, value: result.value } : { ok: false };
  }
  if (result.kind !== "text" || !("text" in result)) return { ok: false };
  return expectation.isValue(result.text) ? { ok: true, value: result.text } : { ok: false };
}

export function createDefaultAgentLaunchLoader(
  loadModule: DynamicModuleLoader = (specifier) => import(specifier),
): () => Promise<AgentLaunchModules | undefined> {
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
        const resolveSubagentLaunchContract: AgentLaunchPreflight = async (input) =>
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

const defaultLoader = createDefaultAgentLaunchLoader();

function createPreflightInput<Request extends AgentLaunchRequest, Value>(
  request: Request,
  cwd: string,
  requestId: string,
  definition: AgentLaunchDefinition<Request, Value>,
): Record<string, unknown> {
  return {
    agent: definition.agentName,
    cwd,
    task: definition.buildTask(request),
    context: "fresh",
    model: `${request.model.provider}/${request.model.id}`,
    thinking: request.model.thinking,
    availableModels: request.availableModels,
    artifacts: false,
    output: false,
    ...(definition.result.variant === "structured"
      ? { outputSchema: definition.result.buildSchema(request) }
      : {}),
    skill: false,
    runId: requestId,
  };
}

function validateLaunchContract<Request extends AgentLaunchRequest, Value>(
  value: unknown,
  request: Request,
  active: Pick<ActiveRun<Value>, "requestId" | "host">,
  definition: AgentLaunchDefinition<Request, Value>,
): value is AgentLaunchContract {
  try {
    if (!isRecord(value) || value.ok !== true || !isRecord(value.contract)) return false;
    const contract = value.contract;
    if (
      contract.version !== 2 ||
      !isRecord(contract.protocol) ||
      contract.protocol.lifecycleArtifactVersion !== 3 ||
      contract.protocol.packageVersion !== definition.protocolVersion ||
      contract.runId !== active.requestId ||
      !isLowerHexDigest(contract.digest)
    )
      return false;

    if (
      !isRecord(contract.agent) ||
      contract.agent.name !== definition.agentName ||
      contract.agent.localName !== definition.agentName ||
      contract.agent.source !== "package" ||
      (contract.agent.packageName !== undefined && contract.agent.packageName !== PACKAGE_NAME) ||
      contract.agent.definitionProjectionVersion !== 1 ||
      contract.agent.filePath !== definition.agentPath ||
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
      !exactStrings(contract.tools.effectiveAllowlist, definition.internalTools) ||
      !exactStrings(contract.tools.requiredChildTools, definition.internalTools) ||
      !exactStrings(contract.tools.internalTools, definition.internalTools) ||
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

function requestPayload<Request extends AgentLaunchRequest, Value>(
  active: ActiveRun<Value>,
  request: Request,
  definition: AgentLaunchDefinition<Request, Value>,
): Record<string, unknown> {
  return {
    requestId: active.requestId,
    ownerRunId: active.ownerRunId,
    nodeId: active.nodeId,
    agent: definition.agentName,
    cwd: active.host.cwd,
    task: definition.buildTask(request),
    context: "fresh",
    model: `${request.model.provider}/${request.model.id}`,
    thinking: request.model.thinking,
    timeoutMs: LAUNCH_TERMINAL_TIMEOUT_MS,
    artifacts: false,
    skill: false,
    result:
      definition.result.variant === "structured"
        ? { kind: "structured", schema: definition.result.buildSchema(request) }
        : { kind: "text" },
  };
}

/**
 * Strict launch path for one packaged profile: it preflights the executor, binds
 * the returned contract, emits one correlated request, and accepts only a
 * terminal response that matches the bound digest, model and thinking.
 *
 * One instance holds at most one pending run. Every failure reason settles
 * locally; nothing is retried.
 */
export class AgentLaunch<Request extends AgentLaunchRequest, Value> {
  private readonly definition: AgentLaunchDefinition<Request, Value>;
  private readonly loader: () => Promise<AgentLaunchModules | undefined>;
  private readonly setTimer: (callback: () => void, delay: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly createId: () => string;
  private generation = 0;
  private ownerRunId: string;
  private active: ActiveRun<Value> | undefined;
  private closed = false;

  constructor(
    definition: AgentLaunchDefinition<Request, Value>,
    dependencies: AgentLaunchDependencies = {},
  ) {
    this.definition = definition;
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
    request: Request,
    host: AgentLaunchHost,
    signal?: AbortSignal,
  ): Promise<AgentLaunchResult<Value>> {
    if (this.closed) return Promise.resolve({ kind: "unavailable" });
    if (this.active) return Promise.resolve({ kind: "busy" });
    return new Promise((resolveResult) => {
      const active: ActiveRun<Value> = {
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
        () => active.settle({ kind: "unavailable" }),
        LAUNCH_PREFLIGHT_TIMEOUT_MS,
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

  private isLive(active: ActiveRun<Value>): boolean {
    return (
      !this.closed &&
      !active.settled &&
      this.active === active &&
      active.generation === this.generation &&
      active.ownerRunId === this.ownerRunId
    );
  }

  private async begin(active: ActiveRun<Value>, request: Request): Promise<void> {
    let modules: AgentLaunchModules | undefined;
    try {
      modules = await this.loader();
    } catch {
      modules = undefined;
    }
    if (!this.isLive(active)) return;
    if (!modules) {
      active.settle({ kind: "unavailable" });
      return;
    }
    active.modules = modules;

    let resolved: unknown;
    try {
      resolved = await modules.resolveSubagentLaunchContract(
        createPreflightInput(request, active.host.cwd, active.requestId, this.definition),
      );
    } catch {
      resolved = undefined;
    }
    if (!this.isLive(active)) return;
    if (!validateLaunchContract(resolved, request, active, this.definition)) {
      active.settle({ kind: "unavailable" });
      return;
    }

    const contract = (resolved as { contract: AgentLaunchContract }).contract;
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
        () => this.cancelActive(active, "unavailable"),
        LAUNCH_PREFLIGHT_TIMEOUT_MS,
      );
      active.host.events.emit(
        modules.requestEvent,
        requestPayload(active, request, this.definition),
      );
      if (!this.isLive(active)) return;
    } catch {
      if (!active.settled) {
        active.settle({ kind: "unavailable" });
        this.emitCancel(active);
      }
    }
  }

  private matchesTuple(
    active: ActiveRun<Value>,
    payload: unknown,
  ): payload is Record<string, unknown> {
    return (
      isRecord(payload) &&
      payload.requestId === active.requestId &&
      payload.ownerRunId === active.ownerRunId &&
      payload.nodeId === active.nodeId
    );
  }

  private clearPreflightTimer(active: ActiveRun<Value>): void {
    if (active.preflightTimer) this.clearTimer(active.preflightTimer);
    active.preflightTimer = undefined;
  }

  private onStarted(active: ActiveRun<Value>, payload: unknown): void {
    if (!this.isLive(active) || !this.matchesTuple(active, payload) || active.started) return;
    active.started = true;
    if (active.startTimer) this.clearTimer(active.startTimer);
    active.startTimer = undefined;
    active.terminalTimer = this.setTimer(
      () => this.cancelActive(active, "timed-out"),
      LAUNCH_TERMINAL_TIMEOUT_MS,
    );
  }

  private terminalMetadataMatches(
    payload: Record<string, unknown>,
    contract: AgentLaunchContract,
    request: Request,
    requireAll: boolean,
  ): boolean {
    const expected = {
      agent: this.definition.agentName,
      model: contract.model,
      thinking: request.model.thinking,
      launchContractDigest: contract.launchContractDigest,
    };
    return Object.entries(expected).every(([key, value]) =>
      requireAll ? payload[key] === value : !(key in payload) || payload[key] === value,
    );
  }

  private onResponse(
    active: ActiveRun<Value>,
    contract: AgentLaunchContract,
    request: Request,
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
          ? { kind: "unavailable" }
          : { kind: "failed" },
      );
      return;
    }

    if (status === "completed") {
      if (!this.terminalMetadataMatches(payload, contract, request, true)) {
        active.settle({ kind: "failed" });
        return;
      }
      const completed = completedValue(payload.result, this.definition.result);
      active.settle(
        completed.ok ? { kind: "completed", value: completed.value } : { kind: "failed" },
      );
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
      active.settle({ kind: "unavailable" });
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

  private emitCancel(active: ActiveRun<Value>): void {
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
    active: ActiveRun<Value>,
    result: "cancelled" | "unavailable" | "timed-out",
  ): void {
    if (active.settled) return;
    active.settle({ kind: result });
    this.emitCancel(active);
  }

  private cleanup(active: ActiveRun<Value>): void {
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

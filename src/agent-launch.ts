import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const LAUNCH_PREFLIGHT_TIMEOUT_MS = 5_000;
export const LAUNCH_TERMINAL_TIMEOUT_MS = 120_000;

const PACKAGE_NAME = "pi-delegation-policy";
/** The only `pi-permission-system` release whose runtime the reader admits: an exact pin, not a range. */
const PERMISSION_PACKAGE_NAME = "@gotgenes/pi-permission-system";
const PERMISSION_PACKAGE_VERSION = "33.0.3";
/** Synthetic rules that only make `pi-subagents` report its permission runtime path; never sent or executed. */
const PERMISSION_PROBE_RULES = { "pi-delegation-policy-probe": "deny" } as const;
/** Directories searched upward from a runtime entry for the `package.json` that names it. */
const PACKAGE_MANIFEST_SEARCH_DEPTH = 3;
/** `pi-subagents` 0.76.1 `src/api/preflight.ts` and `src/shared/launch-contract.ts`. */
const LAUNCH_CONTRACT_VERSION = 3;
const DEFINITION_PROJECTION_VERSION = 2;
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
export type AgentLaunchHost = Readonly<{
  cwd: string;
  /** Parent session whose host-required child extensions the preflight must see. */
  sessionId: string;
  events: AgentLaunchEventBus;
}>;

export type AgentLaunchRequest = Readonly<{
  model: AgentLaunchModel;
  availableModels: readonly [AgentLaunchAvailableModel];
  context?: "fresh" | "fork";
}>;

export type AgentLaunchJsonSchema = Readonly<Record<string, unknown>>;
type AgentLaunchContract = Readonly<Record<string, unknown>>;
export type AgentLaunchPreflight = (input: unknown) => Promise<unknown>;

/** Terminal metadata the strict path binds; only these names may reach a consumer. */
export type AgentLaunchTerminalField = "agent" | "model" | "thinking" | "launchContractDigest";
/** Statuses the admitted delegation protocol can report for a terminal response. */
export type AgentLaunchTerminalStatus =
  | "invalid_request"
  | "unavailable_context"
  | "duplicate_node"
  | "turn_budget_exhausted"
  | "tool_budget_exhausted"
  | "structured_output_failed"
  | "acceptance_failed"
  | "failed";
export type AgentLaunchFailureCode =
  | "launch-closed"
  | "fork-not-allowed"
  | "host-session-missing"
  | "modules-unavailable"
  | "fork-task-normalizer-unavailable"
  | "preflight-unavailable"
  | "preflight-timeout"
  | "contract-rejected"
  | "request-start-timeout"
  | "request-emit-failed"
  | "terminal-metadata-mismatch"
  | "terminal-result-invalid"
  | "host-terminal-status"
  | "host-status-unrecognized";
/**
 * Facts a consumer may render for a failed launch. Closed literals only: no host payload text,
 * prompt, URL, path or provider message ever enters this type.
 */
export type AgentLaunchFailure = Readonly<{
  code: AgentLaunchFailureCode;
  field?: AgentLaunchTerminalField;
  status?: AgentLaunchTerminalStatus;
}>;

export type AgentLaunchModules = Readonly<{
  resolveSubagentLaunchContract: AgentLaunchPreflight;
  /**
   * Runtime extension lists `pi-subagents` may give a profile with no tools and no extensions: the
   * prompt runtime alone, or that list plus the pinned permission runtime when the host adds it. The
   * contract must report exactly one of these lists in both `runtimeExtensions` and `extensionArgs`.
   */
  admittedRuntimeExtensionLists: () => readonly (readonly string[])[];
  requestEvent: string;
  startedEvent: string;
  responseEvent: string;
  cancelEvent: string;
  /**
   * The public `wrapForkTask` export from `pi-subagents/shared-types`. The executor wraps a fork
   * task before hashing the launch binding, so the preflight must hash the same wrapped task or
   * its digest can never match the terminal one. Absent on builds without that export.
   */
  normalizeForkTask?: (task: string) => string;
}>;

export type AgentLaunchResult<Value> =
  | { kind: "completed"; value: Value }
  | { kind: "unavailable"; reason?: AgentLaunchFailure }
  | { kind: "unavailable-context"; reason?: AgentLaunchFailure }
  | { kind: "busy" }
  | { kind: "cancelled" }
  | { kind: "timed-out" }
  | { kind: "failed"; reason?: AgentLaunchFailure };

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
  /** Only the advisor may send a fork; reader requests remain fresh-only. */
  allowFork?: boolean;
  /**
   * The `pi-subagents` package versions whose launch contract this profile was verified against.
   * An exact, per-profile list: no range, wildcard or fallback, so a new build is rejected until
   * its contract is checked.
   */
  admittedProtocolVersions: readonly string[];
  /**
   * Builtin tools the child must expose. A profile that declares no tools and no
   * extensions exposes exactly these, so the contract must report the same list
   * as its effective allowlist, its required child tools, and its internal tools.
   */
  internalTools: readonly string[];
  /** Exact configured entries admitted only by this profile, never by the shared reader. */
  configuredExtensions?: readonly string[];
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
    Promise.all([
      loadModule("pi-subagents/preflight"),
      loadModule("pi-subagents/delegation"),
      loadModule("pi-subagents/child-tool-plan"),
      loadForkTaskNormalizer(loadModule),
    ])
      .then(([preflight, delegation, childToolPlan, normalizeForkTask]) => {
        if (!isRecord(preflight) || !isRecord(delegation) || !isRecord(childToolPlan)) {
          return undefined;
        }
        const resolveLaunchContract = preflight.resolveSubagentLaunchContract;
        const resolvePiLaunchToolPlan = childToolPlan.resolvePiLaunchToolPlan;
        const requestEvent = delegation.SUBAGENT_DELEGATION_REQUEST_EVENT;
        const startedEvent = delegation.SUBAGENT_DELEGATION_STARTED_EVENT;
        const responseEvent = delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT;
        const cancelEvent = delegation.SUBAGENT_DELEGATION_CANCEL_EVENT;
        if (
          typeof resolveLaunchContract !== "function" ||
          typeof resolvePiLaunchToolPlan !== "function" ||
          requestEvent !== DELEGATION_EVENTS.request ||
          startedEvent !== DELEGATION_EVENTS.started ||
          responseEvent !== DELEGATION_EVENTS.response ||
          cancelEvent !== DELEGATION_EVENTS.cancel
        ) {
          return undefined;
        }
        const resolveSubagentLaunchContract: AgentLaunchPreflight = async (input) =>
          resolveLaunchContract(input);
        // The same public resolver the child launch uses, given the profile's own inputs. Its
        // runtime list depends only on the installed package unless permissions, fast mode or
        // fanout are requested, and the profile requests none of them.
        const admittedRuntimeExtensionLists = (): readonly (readonly string[])[] => {
          const promptOnly: readonly string[] = resolvePiLaunchToolPlan({
            tools: [],
            extensions: [],
            structuredOutput: true,
          }).runtimeExtensions;
          const permission = pinnedPermissionRuntime(
            (input) => resolvePiLaunchToolPlan(input),
            promptOnly,
          );
          return permission === undefined
            ? [promptOnly]
            : [promptOnly, [...promptOnly, permission]];
        };
        return {
          resolveSubagentLaunchContract,
          admittedRuntimeExtensionLists,
          requestEvent,
          startedEvent,
          responseEvent,
          cancelEvent,
          ...(normalizeForkTask ? { normalizeForkTask } : {}),
        };
      })
      .catch(() => undefined);
}

/**
 * The public `wrapForkTask` export, loaded on its own: `pi-subagents` wraps a fork task before it
 * hashes the launch binding, so the preflight needs the same wrapper to bind the same digest. A
 * build without the export only loses fork launches, so its absence never disables the modules the
 * fresh path uses.
 */
function loadForkTaskNormalizer(
  loadModule: DynamicModuleLoader,
): Promise<((task: string) => string) | undefined> {
  return loadModule("pi-subagents/shared-types")
    .then((module) => {
      if (!isRecord(module) || typeof module.wrapForkTask !== "function") return undefined;
      const wrapForkTask = module.wrapForkTask;
      return (task: string): string => {
        const wrapped: unknown = wrapForkTask(task);
        return typeof wrapped === "string" ? wrapped : "";
      };
    })
    .catch(() => undefined);
}

/**
 * The permission runtime entry the host added, when the public probe reports exactly one extra path
 * after the prompt runtime and that path is the pinned scoped package. Any other shape, a probe that
 * throws, or a package that is absent or not pinned yields `undefined`, so prompt-only still works.
 */
function pinnedPermissionRuntime(
  resolvePlan: (input: Record<string, unknown>) => { runtimeExtensions: unknown },
  promptOnly: readonly string[],
): string | undefined {
  try {
    const probed = resolvePlan({
      tools: [],
      extensions: [],
      structuredOutput: true,
      permissionRules: PERMISSION_PROBE_RULES,
    }).runtimeExtensions;
    if (
      !Array.isArray(probed) ||
      probed.length !== promptOnly.length + 1 ||
      !exactStrings(probed.slice(0, promptOnly.length), promptOnly)
    )
      return undefined;
    const entry = probed[promptOnly.length];
    return typeof entry === "string" && isPinnedPermissionEntry(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the nearest manifest above the entry and requires the scoped name, the pin and its declared entry. */
function isPinnedPermissionEntry(entry: string): boolean {
  try {
    const entryPath = resolve(entry);
    let directory = dirname(entryPath);
    for (let depth = 0; depth < PACKAGE_MANIFEST_SEARCH_DEPTH; depth += 1) {
      const manifestPath = resolve(directory, "package.json");
      if (existsSync(manifestPath)) {
        const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
        const declared =
          isRecord(manifest) && isRecord(manifest.pi) && Array.isArray(manifest.pi.extensions)
            ? manifest.pi.extensions[0]
            : undefined;
        return (
          basename(directory) === "pi-permission-system" &&
          basename(dirname(directory)) === "@gotgenes" &&
          isRecord(manifest) &&
          manifest.name === PERMISSION_PACKAGE_NAME &&
          manifest.version === PERMISSION_PACKAGE_VERSION &&
          typeof declared === "string" &&
          resolve(directory, declared) === entryPath
        );
      }
      const parent = dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
    return false;
  } catch {
    return false;
  }
}

const defaultLoader = createDefaultAgentLaunchLoader();

function createPreflightInput<Request extends AgentLaunchRequest, Value>(
  request: Request,
  host: AgentLaunchHost,
  requestId: string,
  definition: AgentLaunchDefinition<Request, Value>,
  task: string,
): Record<string, unknown> {
  return {
    agent: definition.agentName,
    cwd: host.cwd,
    parentSessionId: host.sessionId,
    task,
    context: launchContext(request, definition),
    model: `${request.model.provider}/${request.model.id}`,
    thinking: request.model.thinking,
    availableModels: request.availableModels,
    artifacts: false,
    output: false,
    ...(definition.result.variant === "structured"
      ? { outputSchema: definition.result.buildSchema(request) }
      : {}),
    intercomBridge: { mode: "off" },
    skill: false,
    runId: requestId,
  };
}

function validateLaunchContract<Request extends AgentLaunchRequest, Value>(
  value: unknown,
  request: Request,
  active: Pick<ActiveRun<Value>, "requestId" | "host">,
  definition: AgentLaunchDefinition<Request, Value>,
  modules: AgentLaunchModules,
): value is AgentLaunchContract {
  try {
    if (!isRecord(value) || value.ok !== true || !isRecord(value.contract)) return false;
    const contract = value.contract;
    if (
      contract.version !== LAUNCH_CONTRACT_VERSION ||
      !isRecord(contract.protocol) ||
      contract.protocol.lifecycleArtifactVersion !== 3 ||
      typeof contract.protocol.packageVersion !== "string" ||
      !definition.admittedProtocolVersions.includes(contract.protocol.packageVersion) ||
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
      contract.agent.definitionProjectionVersion !== DEFINITION_PROJECTION_VERSION ||
      contract.agent.filePath !== definition.agentPath ||
      !exactStrings(contract.agent.shadowedCandidates, []) ||
      !isLowerHexDigest(contract.agent.definitionDigest)
    )
      return false;

    const resolvedModel = modelName(request.model);
    if (
      !isLowerHexDigest(contract.launchContractDigest) ||
      contract.context !== launchContext(request, definition) ||
      // The contract used to carry `modelCandidates`, pinned here as exactly `[resolvedModel]`.
      // `pi-subagents` 0.68.0 removed it along with `fallbackModels` and every same-launch model
      // switch ("each launch uses one resolved model instead of switching models automatically"),
      // so the contract no longer offers a candidate list, a fallback or any second model to
      // compare against. This exact `model` equality is the whole survival of that intent: a
      // substituted, aliased or downgraded model still fails here, and a build that reintroduces a
      // second model must be rejected here rather than accepted with a permissive branch.
      contract.model !== resolvedModel ||
      contract.thinking !== request.model.thinking ||
      contract.systemPromptMode !== "replace" ||
      contract.inheritGlobalContext !== false ||
      contract.inheritProjectContext !== false ||
      contract.inheritSkills !== false ||
      !isRecord(contract.intercomBridge) ||
      contract.intercomBridge.active !== false ||
      contract.intercomBridge.mode !== "off"
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
      !exactStrings(contract.tools.configuredExtensions, definition.configuredExtensions ?? []) ||
      !exactStrings(contract.tools.requiredExtensionIds, []) ||
      contract.tools.disableAmbientExtensions !== true ||
      contract.tools.fanoutAuthorized !== false ||
      "capabilityCeiling" in contract.tools ||
      "capabilityAudit" in contract.tools ||
      !Array.isArray(contract.tools.runtimeExtensions) ||
      contract.tools.runtimeExtensions.length === 0 ||
      !contract.tools.runtimeExtensions.every(
        (extension) => typeof extension === "string" && extension.length > 0,
      )
    )
      return false;

    // The host may add the pinned permission runtime, but only as one whole admitted list.
    const tools = contract.tools;
    const admitted = modules
      .admittedRuntimeExtensionLists()
      .find((list) => exactStrings(tools.runtimeExtensions, list));
    if (
      !admitted ||
      !exactStrings(tools.extensionArgs, [...admitted, ...(definition.configuredExtensions ?? [])])
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

function launchContext<Request extends AgentLaunchRequest, Value>(
  request: Request,
  definition: AgentLaunchDefinition<Request, Value>,
): "fresh" | "fork" {
  return definition.allowFork ? (request.context ?? "fresh") : "fresh";
}

/**
 * The wrapped task the executor hashes for a fork, or `undefined` when no usable public wrapper is
 * loaded. The request keeps the raw task: the host wraps it again on its own side.
 */
function preflightForkTask(
  task: string,
  normalizeForkTask: ((task: string) => string) | undefined,
): string | undefined {
  if (!normalizeForkTask) return undefined;
  try {
    const normalized = normalizeForkTask(task);
    return typeof normalized === "string" && normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function requestPayload<Request extends AgentLaunchRequest, Value>(
  active: ActiveRun<Value>,
  request: Request,
  definition: AgentLaunchDefinition<Request, Value>,
  task: string,
): Record<string, unknown> {
  return {
    requestId: active.requestId,
    ownerRunId: active.ownerRunId,
    nodeId: active.nodeId,
    agent: definition.agentName,
    cwd: active.host.cwd,
    task,
    context: launchContext(request, definition),
    model: `${request.model.provider}/${request.model.id}`,
    thinking: request.model.thinking,
    timeoutMs: LAUNCH_TERMINAL_TIMEOUT_MS,
    artifacts: false,
    intercomBridge: { mode: "off" },
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
    if (this.closed || (request.context === "fork" && !this.definition.allowFork))
      return Promise.resolve({
        kind: "unavailable",
        reason: { code: this.closed ? "launch-closed" : "fork-not-allowed" },
      });
    if (this.active) return Promise.resolve({ kind: "busy" });
    // Without a host session the preflight could not bind required extensions; launch nothing.
    if (typeof host.sessionId !== "string" || !host.sessionId.trim()) {
      return Promise.resolve({ kind: "unavailable", reason: { code: "host-session-missing" } });
    }
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
        () => active.settle({ kind: "unavailable", reason: { code: "preflight-timeout" } }),
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
      active.settle({ kind: "unavailable", reason: { code: "modules-unavailable" } });
      return;
    }
    active.modules = modules;

    const task = this.definition.buildTask(request);
    let preflightTask = task;
    if (launchContext(request, this.definition) === "fork") {
      const normalized = preflightForkTask(task, modules.normalizeForkTask);
      if (normalized === undefined) {
        active.settle({
          kind: "unavailable",
          reason: { code: "fork-task-normalizer-unavailable" },
        });
        return;
      }
      preflightTask = normalized;
    }

    let resolved: unknown;
    try {
      resolved = await modules.resolveSubagentLaunchContract(
        createPreflightInput(
          request,
          active.host,
          active.requestId,
          this.definition,
          preflightTask,
        ),
      );
    } catch {
      resolved = undefined;
    }
    if (!this.isLive(active)) return;
    // A thrown or empty preflight never described a contract; only a returned nonempty value can be
    // rejected as a contract that failed the strict checks below.
    if (resolved === undefined || resolved === null) {
      active.settle({ kind: "unavailable", reason: { code: "preflight-unavailable" } });
      return;
    }
    if (!validateLaunchContract(resolved, request, active, this.definition, modules)) {
      active.settle({ kind: "unavailable", reason: { code: "contract-rejected" } });
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
        () => this.cancelActive(active, "unavailable", { code: "request-start-timeout" }),
        LAUNCH_PREFLIGHT_TIMEOUT_MS,
      );
      active.host.events.emit(
        modules.requestEvent,
        requestPayload(active, request, this.definition, task),
      );
      if (!this.isLive(active)) return;
    } catch {
      if (!active.settled) {
        active.settle({ kind: "unavailable", reason: { code: "request-emit-failed" } });
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

  private terminalMetadataMismatch(
    payload: Record<string, unknown>,
    contract: AgentLaunchContract,
    request: Request,
    requireAll: boolean,
  ): AgentLaunchTerminalField | undefined {
    const expected: ReadonlyArray<readonly [AgentLaunchTerminalField, unknown]> = [
      ["agent", this.definition.agentName],
      ["model", contract.model],
      ["thinking", request.model.thinking],
      ["launchContractDigest", contract.launchContractDigest],
    ];
    for (const [field, value] of expected) {
      if (!requireAll && !(field in payload)) continue;
      if (payload[field] !== value) return field;
    }
    return undefined;
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
      const mismatch = this.terminalMetadataMismatch(payload, contract, request, false);
      active.settle(
        mismatch === undefined
          ? {
              kind:
                status === "unavailable_context" && this.definition.allowFork
                  ? "unavailable-context"
                  : "unavailable",
              reason: { code: "host-terminal-status", status },
            }
          : { kind: "failed", reason: { code: "terminal-metadata-mismatch", field: mismatch } },
      );
      return;
    }

    if (status === "completed") {
      const mismatch = this.terminalMetadataMismatch(payload, contract, request, true);
      if (mismatch !== undefined) {
        active.settle({
          kind: "failed",
          reason: { code: "terminal-metadata-mismatch", field: mismatch },
        });
        return;
      }
      const completed = completedValue(payload.result, this.definition.result);
      active.settle(
        completed.ok
          ? { kind: "completed", value: completed.value }
          : { kind: "failed", reason: { code: "terminal-result-invalid" } },
      );
      return;
    }

    if (typeof status !== "string") return;
    const mismatch = this.terminalMetadataMismatch(payload, contract, request, false);
    if (mismatch !== undefined) {
      active.settle({
        kind: "failed",
        reason: { code: "terminal-metadata-mismatch", field: mismatch },
      });
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
      active.settle({
        kind:
          status === "unavailable_context" && this.definition.allowFork
            ? "unavailable-context"
            : "unavailable",
        reason: { code: "host-terminal-status", status },
      });
      return;
    }
    if (
      status === "turn_budget_exhausted" ||
      status === "tool_budget_exhausted" ||
      status === "structured_output_failed" ||
      status === "acceptance_failed" ||
      status === "failed"
    ) {
      active.settle({ kind: "failed", reason: { code: "host-terminal-status", status } });
      return;
    }
    active.settle({ kind: "failed", reason: { code: "host-status-unrecognized" } });
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
    reason?: AgentLaunchFailure,
  ): void {
    if (active.settled) return;
    active.settle(reason ? { kind: result, reason } : { kind: result });
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

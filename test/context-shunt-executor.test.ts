import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONTEXT_SHUNT_READER_AGENT_NAME,
  ContextShuntExecutor,
  createDefaultReaderExecutorLoader,
  READER_PREFLIGHT_TIMEOUT_MS,
  READER_TERMINAL_TIMEOUT_MS,
  buildReaderTask,
  createReaderAnswerSchema,
  type ReaderEventBus,
  type ReaderExecutorModules,
  type ReaderExecutorRequest,
} from "../src/context-shunt-executor.ts";

const agentPath = resolve(
  fileURLToPath(
    new URL("../agents/pi-delegation-policy.context-shunt-inline-reader.md", import.meta.url),
  ),
);
const digest = "a".repeat(64);
const request: ReaderExecutorRequest = {
  question: "What does this prove?",
  snapshot: {
    sourceId: "source",
    text: "evidence\n",
    digest: "d".repeat(64),
    lineCount: 1,
    expiresAt: 1,
  },
  model: { provider: "example", id: "reader", thinking: "low" },
  availableModels: [
    { provider: "example", id: "reader", fullId: "example/reader", reasoning: true },
  ],
};

class FakeEventBus implements ReaderEventBus {
  readonly emissions: Array<{ event: string; payload: unknown }> = [];
  readonly subscriptions: string[] = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  throwOnRequest = false;
  throwOnCancel = false;
  throwOnUnsubscribe = false;

  on(event: string, listener: (payload: unknown) => void): () => void {
    this.subscriptions.push(event);
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
      if (this.throwOnUnsubscribe) throw new Error("unsubscribe");
    };
  }

  emit(event: string, payload: unknown): void {
    this.emissions.push({ event, payload });
    if (event === events.cancelEvent && this.throwOnCancel) throw new Error("cancel");
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
    if (event === events.requestEvent && this.throwOnRequest) throw new Error("request");
  }
}

const events = {
  requestEvent: "REQUEST",
  startedEvent: "STARTED",
  responseEvent: "RESPONSE",
  cancelEvent: "CANCEL",
} as const;

function modelName(value = request): string {
  return `${value.model.provider}/${value.model.id}:${value.model.thinking}`;
}

function contract(
  requestId: string,
  cwd: string,
  value = request,
  mutate?: (contract: Record<string, unknown>) => void,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    version: 2,
    protocol: { lifecycleArtifactVersion: 3, packageVersion: "0.70.0" },
    runId: requestId,
    digest,
    agent: {
      name: CONTEXT_SHUNT_READER_AGENT_NAME,
      localName: CONTEXT_SHUNT_READER_AGENT_NAME,
      source: "package",
      packageName: "pi-delegation-policy",
      definitionProjectionVersion: 1,
      filePath: agentPath,
      definitionDigest: digest,
      shadowedCandidates: [],
    },
    launchContractDigest: digest,
    context: "fresh",
    model: modelName(value),
    modelCandidates: [modelName(value)],
    thinking: value.model.thinking,
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    skills: { requested: [], resolved: [], missing: [] },
    tools: {
      explicitAllowlist: true,
      mcp: [],
      requestedBuiltin: [],
      declaredBuiltin: [],
      effectiveAllowlist: ["structured_output"],
      requiredChildTools: ["structured_output"],
      internalTools: ["structured_output"],
      effectiveMcpTools: [],
      toolExtensionPaths: [],
      configuredExtensions: [],
      runtimeExtensions: ["/runtime.ts"],
      extensionArgs: ["/runtime.ts"],
      fanoutAuthorized: false,
      disableAmbientExtensions: true,
    },
    roots: { cwd: resolve(cwd) },
    diagnostics: [
      {
        severity: "host-required",
        code: "session-root-required",
        message: "The host must provide the session root.",
      },
    ],
  };
  mutate?.(result);
  return { ok: true, contract: result };
}

function preflightFields(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === "object" && !Array.isArray(input));
  return input as Record<string, unknown>;
}

function modules(
  preflight: ReaderExecutorModules["resolveSubagentLaunchContract"] = async (input) => {
    const fields = preflightFields(input);
    return contract(fields.runId as string, fields.cwd as string);
  },
): ReaderExecutorModules {
  return { ...events, resolveSubagentLaunchContract: preflight };
}

function tuple(payload: Record<string, unknown>) {
  return { requestId: payload.requestId, ownerRunId: payload.ownerRunId, nodeId: payload.nodeId };
}

async function waitForRequest(bus: FakeEventBus): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const emitted = bus.emissions.find((entry) => entry.event === events.requestEvent)?.payload;
    if (emitted && typeof emitted === "object" && !Array.isArray(emitted)) {
      return emitted as Record<string, unknown>;
    }
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  }
  throw new Error("request was not emitted");
}

function completed(payload: Record<string, unknown>, value = request): Record<string, unknown> {
  return {
    ...tuple(payload),
    status: "completed",
    agent: CONTEXT_SHUNT_READER_AGENT_NAME,
    model: modelName(value),
    thinking: value.model.thinking,
    launchContractDigest: digest,
    result: {
      kind: "structured",
      value: {
        status: "answered",
        answer: "It is present.",
        citations: [{ sourceId: "source", startLine: 1, endLine: 1 }],
      },
    },
  };
}

function start(bus: FakeEventBus, emitted: Record<string, unknown>): void {
  bus.emit(events.startedEvent, tuple(emitted));
}

function cancelCount(bus: FakeEventBus): number {
  return bus.emissions.filter((entry) => entry.event === events.cancelEvent).length;
}

type ManualTimer = { callback: () => void; delay: number; cleared: boolean };
function manualTimers() {
  const timers: ManualTimer[] = [];
  return {
    timers,
    setTimer(callback: () => void, delay: number) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer as never;
    },
    clearTimer(timer: unknown) {
      (timer as ManualTimer).cleared = true;
    },
    fire(delay: number) {
      for (const timer of timers.filter((item) => item.delay === delay && !item.cleared)) {
        timer.callback();
      }
    },
    live() {
      return timers.filter((timer) => !timer.cleared);
    },
  };
}

test("default loader accepts only the approved delegation event protocol", async () => {
  const preflight = async () => undefined;
  const validLoader = createDefaultReaderExecutorLoader(async (specifier) => {
    if (specifier === "pi-subagents/preflight") {
      return { resolveSubagentLaunchContract: preflight };
    }
    return {
      SUBAGENT_DELEGATION_REQUEST_EVENT: "prompt-template:subagent:request",
      SUBAGENT_DELEGATION_STARTED_EVENT: "prompt-template:subagent:started",
      SUBAGENT_DELEGATION_RESPONSE_EVENT: "prompt-template:subagent:response",
      SUBAGENT_DELEGATION_CANCEL_EVENT: "prompt-template:subagent:cancel",
    };
  });
  const valid = await validLoader();
  assert.equal(typeof valid?.resolveSubagentLaunchContract, "function");
  assert.deepEqual(
    valid && [valid.requestEvent, valid.startedEvent, valid.responseEvent, valid.cancelEvent],
    [
      "prompt-template:subagent:request",
      "prompt-template:subagent:started",
      "prompt-template:subagent:response",
      "prompt-template:subagent:cancel",
    ],
  );

  for (const exportName of [
    "SUBAGENT_DELEGATION_REQUEST_EVENT",
    "SUBAGENT_DELEGATION_STARTED_EVENT",
    "SUBAGENT_DELEGATION_RESPONSE_EVENT",
    "SUBAGENT_DELEGATION_CANCEL_EVENT",
  ]) {
    const loader = createDefaultReaderExecutorLoader(async (specifier) => {
      if (specifier === "pi-subagents/preflight") {
        return { resolveSubagentLaunchContract: preflight };
      }
      return {
        SUBAGENT_DELEGATION_REQUEST_EVENT: "prompt-template:subagent:request",
        SUBAGENT_DELEGATION_STARTED_EVENT: "prompt-template:subagent:started",
        SUBAGENT_DELEGATION_RESPONSE_EVENT: "prompt-template:subagent:response",
        SUBAGENT_DELEGATION_CANCEL_EVENT: "prompt-template:subagent:cancel",
        [exportName]: "arbitrary-event",
      };
    });
    assert.equal(await loader(), undefined, exportName);
  }
});

test("preflight and request payloads use their exact public parser fields and one inline source", async () => {
  const bus = new FakeEventBus();
  let preflightInput: Record<string, unknown> | undefined;
  const executor = new ContextShuntExecutor({
    loader: async () =>
      modules(async (input) => {
        const fields = preflightFields(input);
        preflightInput = fields;
        return contract(fields.runId as string, fields.cwd as string);
      }),
    createId: (() => {
      const ids = ["owner", "request", "node"];
      return () => ids.shift() ?? "extra";
    })(),
  });
  const pending = executor.execute(request, { cwd: "/workspace/./reader", events: bus });
  const emitted = await waitForRequest(bus);
  assert.ok(preflightInput);
  assert.deepEqual(Object.keys(preflightInput).sort(), [
    "agent",
    "artifacts",
    "availableModels",
    "context",
    "cwd",
    "model",
    "output",
    "outputSchema",
    "runId",
    "skill",
    "task",
    "thinking",
  ]);
  assert.equal(preflightInput.model, "example/reader");
  assert.equal(preflightInput.thinking, "low");
  assert.equal(preflightInput.output, false);
  assert.equal("turnBudget" in preflightInput, false);
  assert.deepEqual(preflightInput.outputSchema, createReaderAnswerSchema(request.snapshot));
  assert.deepEqual(Object.keys(emitted).sort(), [
    "agent",
    "artifacts",
    "context",
    "cwd",
    "model",
    "nodeId",
    "ownerRunId",
    "requestId",
    "result",
    "skill",
    "task",
    "thinking",
    "timeoutMs",
  ]);
  assert.equal(emitted.timeoutMs, READER_TERMINAL_TIMEOUT_MS);
  for (const forbidden of [
    "output",
    "availableModels",
    "runId",
    "turnBudget",
    "allowedTools",
    "capabilityCeiling",
  ]) {
    assert.equal(forbidden in emitted, false, forbidden);
  }
  assert.equal(emitted.model, "example/reader");
  assert.deepEqual(emitted.result, { kind: "structured", schema: preflightInput.outputSchema });
  assert.equal(emitted.task, preflightInput.task);
  const task = JSON.parse(emitted.task as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(task), ["sourceId", "question", "snapshot"]);
  assert.deepEqual(task, JSON.parse(buildReaderTask(request)));
  assert.equal((task.snapshot as Record<string, unknown>).text, request.snapshot.text);
  assert.equal("text" in emitted, false);
  start(bus, emitted);
  bus.emit(events.responseEvent, completed(emitted));
  assert.equal((await pending).kind, "completed");
  assert.deepEqual(bus.subscriptions, [events.startedEvent, events.responseEvent]);
  assert.equal(bus.subscriptions.map(String).includes("UPDATE"), false);
});

test("resolves every reader thinking level, including off, to a suffixed contract model", async () => {
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const bus = new FakeEventBus();
    const current = { ...request, model: { ...request.model, thinking } };
    let preflight: Record<string, unknown> | undefined;
    const executor = new ContextShuntExecutor({
      loader: async () =>
        modules(async (input) => {
          const fields = preflightFields(input);
          preflight = fields;
          return contract(fields.runId as string, fields.cwd as string, current);
        }),
    });
    const pending = executor.execute(current, { cwd: "/workspace", events: bus });
    const emitted = await waitForRequest(bus);
    assert.equal(preflight?.thinking, thinking);
    start(bus, emitted);
    bus.emit(events.responseEvent, completed(emitted, current));
    assert.equal((await pending).kind, "completed", thinking);
  }
});

test("accepts an installed package profile without packageName and rejects provenance mismatches", async () => {
  const validWithoutPackageName = async (input: unknown) => {
    const fields = preflightFields(input);
    return contract(fields.runId as string, fields.cwd as string, request, (value) => {
      delete (value.agent as Record<string, unknown>).packageName;
    });
  };
  const bus = new FakeEventBus();
  const executor = new ContextShuntExecutor({
    loader: async () => modules(validWithoutPackageName),
  });
  const pending = executor.execute(request, { cwd: "/workspace", events: bus });
  const emitted = await waitForRequest(bus);
  start(bus, emitted);
  bus.emit(events.responseEvent, completed(emitted));
  assert.equal((await pending).kind, "completed");

  const mutations: Array<[string, (value: Record<string, unknown>) => void]> = [
    ["wrong package", (value) => ((value.agent as Record<string, unknown>).packageName = "other")],
    ["wrong file", (value) => ((value.agent as Record<string, unknown>).filePath = "/other.md")],
    ["wrong source", (value) => ((value.agent as Record<string, unknown>).source = "user")],
    ["wrong name", (value) => ((value.agent as Record<string, unknown>).name = "other")],
    ["wrong local name", (value) => ((value.agent as Record<string, unknown>).localName = "other")],
    [
      "shadowed",
      (value) => ((value.agent as Record<string, unknown>).shadowedCandidates = ["other"]),
    ],
  ];
  for (const [name, mutate] of mutations) {
    const rejectedBus = new FakeEventBus();
    const rejected = new ContextShuntExecutor({
      loader: async () =>
        modules(async (input) => {
          const fields = preflightFields(input);
          return contract(fields.runId as string, fields.cwd as string, request, mutate);
        }),
    });
    assert.deepEqual(
      await rejected.execute(request, { cwd: "/workspace", events: rejectedBus }),
      {
        kind: "reader-unavailable",
      },
      name,
    );
    assert.equal(rejectedBus.emissions.length, 0, name);
  }
});

test("rejects each pinned contract mutation before REQUEST", async () => {
  const mutations: Array<[string, (value: Record<string, unknown>) => void]> = [
    ["version", (value) => (value.version = 1)],
    [
      "lifecycle",
      (value) => ((value.protocol as Record<string, unknown>).lifecycleArtifactVersion = 2),
    ],
    [
      "package version",
      (value) => ((value.protocol as Record<string, unknown>).packageVersion = "0.49.0"),
    ],
    ["run id", (value) => (value.runId = "other")],
    ["digest", (value) => (value.digest = "A".repeat(64))],
    [
      "projection",
      (value) => ((value.agent as Record<string, unknown>).definitionProjectionVersion = 2),
    ],
    [
      "definition digest",
      (value) => ((value.agent as Record<string, unknown>).definitionDigest = "short"),
    ],
    ["launch digest", (value) => (value.launchContractDigest = "short")],
    ["context", (value) => (value.context = "shared")],
    ["model", (value) => (value.model = "example/reader")],
    ["model candidates", (value) => (value.modelCandidates = ["example/reader:low", "other"])],
    ["thinking", (value) => (value.thinking = "off")],
    ["prompt", (value) => (value.systemPromptMode = "append")],
    ["project inheritance", (value) => (value.inheritProjectContext = true)],
    ["skill inheritance", (value) => (value.inheritSkills = true)],
    ["skills", (value) => ((value.skills as Record<string, unknown>).requested = ["x"])],
    ["allowlist", (value) => ((value.tools as Record<string, unknown>).explicitAllowlist = false)],
    ["mcp", (value) => ((value.tools as Record<string, unknown>).mcp = ["x"])],
    [
      "requested builtin",
      (value) => ((value.tools as Record<string, unknown>).requestedBuiltin = ["x"]),
    ],
    [
      "effective tools",
      (value) => ((value.tools as Record<string, unknown>).effectiveAllowlist = []),
    ],
    ["mcp tools", (value) => ((value.tools as Record<string, unknown>).effectiveMcpTools = ["x"])],
    [
      "extension path",
      (value) => ((value.tools as Record<string, unknown>).toolExtensionPaths = ["x"]),
    ],
    [
      "configured extension",
      (value) => ((value.tools as Record<string, unknown>).configuredExtensions = ["x"]),
    ],
    [
      "runtime extension",
      (value) => ((value.tools as Record<string, unknown>).runtimeExtensions = []),
    ],
    [
      "extension arguments",
      (value) => ((value.tools as Record<string, unknown>).extensionArgs = ["different"]),
    ],
    [
      "ambient extensions",
      (value) => ((value.tools as Record<string, unknown>).disableAmbientExtensions = false),
    ],
    ["fanout", (value) => ((value.tools as Record<string, unknown>).fanoutAuthorized = true)],
    [
      "ceiling",
      (value) => ((value.tools as Record<string, unknown>).capabilityCeiling = undefined),
    ],
    ["audit", (value) => ((value.tools as Record<string, unknown>).capabilityAudit = undefined)],
    ["cwd", (value) => ((value.roots as Record<string, unknown>).cwd = "/other")],
    ["artifacts", (value) => ((value.roots as Record<string, unknown>).artifactsDir = "/tmp")],
    ["diagnostic info severity", (value) => (value.diagnostics = [{ severity: "info" }])],
    ["diagnostic error severity", (value) => (value.diagnostics = [{ severity: "error" }])],
    ["diagnostic record", (value) => (value.diagnostics = ["host-required"])],
    [
      "diagnostic code",
      (value) =>
        (value.diagnostics = [{ severity: "host-required", code: "", message: "Required." }]),
    ],
    [
      "diagnostic message",
      (value) =>
        (value.diagnostics = [
          { severity: "host-required", code: "session-root-required", message: 1 },
        ]),
    ],
  ];
  for (const [name, mutate] of mutations) {
    const bus = new FakeEventBus();
    const executor = new ContextShuntExecutor({
      loader: async () =>
        modules(async (input) => {
          const fields = preflightFields(input);
          return contract(fields.runId as string, fields.cwd as string, request, mutate);
        }),
    });
    assert.deepEqual(
      await executor.execute(request, { cwd: "/workspace", events: bus }),
      {
        kind: "reader-unavailable",
      },
      name,
    );
    assert.equal(bus.emissions.length, 0, name);
  }
});

test("synchronous STARTED arms only the terminal deadline and leaves delayed completion pending", async () => {
  const bus = new FakeEventBus();
  const timers = manualTimers();
  const originalEmit = bus.emit.bind(bus);
  bus.emit = (event, payload) => {
    originalEmit(event, payload);
    if (event === events.requestEvent)
      originalEmit(events.startedEvent, tuple(payload as Record<string, unknown>));
  };
  const executor = new ContextShuntExecutor({
    loader: async () => modules(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const pending = executor.execute(request, { cwd: "/workspace", events: bus });
  const emitted = await waitForRequest(bus);
  assert.deepEqual(
    timers.live().map((timer) => timer.delay),
    [READER_TERMINAL_TIMEOUT_MS],
  );
  timers.fire(READER_PREFLIGHT_TIMEOUT_MS);
  assert.equal(cancelCount(bus), 0);
  assert.equal(executor.busy, true);
  bus.emit(events.responseEvent, completed(emitted));
  assert.equal((await pending).kind, "completed");
  assert.deepEqual(timers.live(), []);
});

test("synchronous STARTED and RESPONSE complete without leaking timers", async () => {
  const bus = new FakeEventBus();
  const timers = manualTimers();
  const originalEmit = bus.emit.bind(bus);
  bus.emit = (event, payload) => {
    originalEmit(event, payload);
    if (event !== events.requestEvent) return;
    const emitted = payload as Record<string, unknown>;
    originalEmit(events.startedEvent, tuple(emitted));
    originalEmit(events.responseEvent, completed(emitted));
  };
  const executor = new ContextShuntExecutor({
    loader: async () => modules(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  assert.equal(
    (await executor.execute(request, { cwd: "/workspace", events: bus })).kind,
    "completed",
  );
  assert.deepEqual(timers.live(), []);
});

test("maps terminal statuses, validates optional metadata, and ignores spoofed pre-start terminals", async () => {
  const mappings: Array<[string, string]> = [
    ["timed_out", "timed-out"],
    ["cancelled", "cancelled"],
    ["interrupted", "cancelled"],
    ["turn_budget_exhausted", "failed"],
    ["tool_budget_exhausted", "failed"],
    ["structured_output_failed", "failed"],
    ["acceptance_failed", "failed"],
    ["failed", "failed"],
  ];
  for (const [status, expected] of mappings) {
    const bus = new FakeEventBus();
    const executor = new ContextShuntExecutor({ loader: async () => modules() });
    const pending = executor.execute(request, { cwd: "/workspace", events: bus });
    const emitted = await waitForRequest(bus);
    start(bus, emitted);
    bus.emit(events.responseEvent, { ...tuple(emitted), status });
    assert.equal((await pending).kind, expected, status);
  }

  for (const status of ["invalid_request", "unavailable_context", "duplicate_node"]) {
    const bus = new FakeEventBus();
    const executor = new ContextShuntExecutor({ loader: async () => modules() });
    const pending = executor.execute(request, { cwd: "/workspace", events: bus });
    const emitted = await waitForRequest(bus);
    bus.emit(events.responseEvent, { ...tuple(emitted), status, model: modelName() });
    assert.equal((await pending).kind, "reader-unavailable", status);
  }

  const bus = new FakeEventBus();
  const executor = new ContextShuntExecutor({ loader: async () => modules() });
  const pending = executor.execute(request, { cwd: "/workspace", events: bus });
  const emitted = await waitForRequest(bus);
  for (const status of ["completed", "failed", "cancelled", "timed_out"]) {
    bus.emit(events.responseEvent, { ...tuple(emitted), status });
  }
  assert.equal(executor.busy, true);
  start(bus, emitted);
  bus.emit(events.responseEvent, { ...tuple(emitted), status: "failed", agent: "other" });
  assert.equal((await pending).kind, "failed");
});

test("fails completed metadata and wrapper mismatches, then ignores late and foreign events", async () => {
  for (const mutate of [
    (value: Record<string, unknown>) => (value.agent = "other"),
    (value: Record<string, unknown>) => (value.model = "other"),
    (value: Record<string, unknown>) => (value.thinking = "off"),
    (value: Record<string, unknown>) => (value.launchContractDigest = "b".repeat(64)),
    (value: Record<string, unknown>) =>
      (value.result = { kind: "structured", value: {}, extra: true }),
    (value: Record<string, unknown>) => {
      const wrapper = Object.create(null) as Record<string, unknown>;
      wrapper.kind = "structured";
      wrapper.value = {};
      value.result = wrapper;
    },
  ]) {
    const bus = new FakeEventBus();
    const executor = new ContextShuntExecutor({ loader: async () => modules() });
    const pending = executor.execute(request, { cwd: "/workspace", events: bus });
    const emitted = await waitForRequest(bus);
    start(bus, emitted);
    const response = completed(emitted);
    mutate(response);
    bus.emit(events.responseEvent, response);
    assert.equal((await pending).kind, "failed");
    bus.emit(events.responseEvent, { ...tuple(emitted), status: "duplicate_node" });
    assert.equal(executor.busy, false);
  }

  const bus = new FakeEventBus();
  const executor = new ContextShuntExecutor({ loader: async () => modules() });
  const pending = executor.execute(request, { cwd: "/workspace", events: bus });
  const emitted = await waitForRequest(bus);
  for (const field of ["requestId", "ownerRunId", "nodeId"] as const) {
    bus.emit(events.responseEvent, { ...tuple(emitted), [field]: "foreign", status: "failed" });
  }
  assert.equal(executor.busy, true);
  start(bus, emitted);
  bus.emit(events.responseEvent, completed(emitted));
  assert.equal((await pending).kind, "completed");
});

test("loader and preflight availability deadlines and aborts settle without sending a request or CANCEL", async () => {
  for (const phase of ["loader", "preflight"] as const) {
    const bus = new FakeEventBus();
    const timers = manualTimers();
    let release: (() => void) | undefined;
    const gate = new Promise<ReaderExecutorModules | unknown>((resolveGate) => {
      release = () =>
        resolveGate(phase === "loader" ? modules() : contract("request", "/workspace"));
    });
    const executor = new ContextShuntExecutor({
      loader:
        phase === "loader"
          ? async () => (await gate) as ReaderExecutorModules
          : async () => modules(async () => gate),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      createId: (() => {
        const ids = ["owner", "request", "node"];
        return () => ids.shift() ?? "extra";
      })(),
    });
    const pending = executor.execute(request, { cwd: "/workspace", events: bus });
    timers.fire(READER_PREFLIGHT_TIMEOUT_MS);
    assert.equal((await pending).kind, "reader-unavailable", phase);
    release?.();
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    assert.equal(bus.emissions.length, 0, phase);
  }

  for (const phase of ["loader", "preflight"] as const) {
    const bus = new FakeEventBus();
    let release: (() => void) | undefined;
    const gate = new Promise<ReaderExecutorModules | unknown>((resolveGate) => {
      release = () =>
        resolveGate(phase === "loader" ? modules() : contract("request", "/workspace"));
    });
    const executor = new ContextShuntExecutor({
      loader:
        phase === "loader"
          ? async () => (await gate) as ReaderExecutorModules
          : async () => modules(async () => gate),
      createId: (() => {
        const ids = ["owner", "request", "node"];
        return () => ids.shift() ?? "extra";
      })(),
    });
    const controller = new AbortController();
    const pending = executor.execute(
      request,
      { cwd: "/workspace", events: bus },
      controller.signal,
    );
    controller.abort();
    release?.();
    assert.equal((await pending).kind, "cancelled", phase);
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    assert.equal(bus.emissions.length, 0, phase);
  }
});

test("start availability and terminal deadlines each send one CANCEL and explicit cancellation remains idempotent", async () => {
  for (const started of [false, true]) {
    const bus = new FakeEventBus();
    const timers = manualTimers();
    const executor = new ContextShuntExecutor({
      loader: async () => modules(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const pending = executor.execute(request, { cwd: "/workspace", events: bus });
    const emitted = await waitForRequest(bus);
    if (started) start(bus, emitted);
    timers.fire(started ? READER_TERMINAL_TIMEOUT_MS : READER_PREFLIGHT_TIMEOUT_MS);
    assert.equal((await pending).kind, started ? "timed-out" : "reader-unavailable");
    assert.equal(cancelCount(bus), 1);
    assert.deepEqual(
      bus.emissions.find((entry) => entry.event === events.cancelEvent)?.payload,
      tuple(emitted),
    );
    assert.deepEqual(timers.live(), []);
  }

  const bus = new FakeEventBus();
  const executor = new ContextShuntExecutor({ loader: async () => modules() });
  const pending = executor.execute(request, { cwd: "/workspace", events: bus });
  await waitForRequest(bus);
  executor.cancel();
  executor.cancel();
  assert.equal((await pending).kind, "cancelled");
  assert.equal(cancelCount(bus), 1);
});

test("cancellation settles locally before a synchronous CANCEL response", async () => {
  const cases: Array<{
    name: string;
    expected: "cancelled" | "reader-unavailable" | "timed-out";
    trigger: (
      executor: ContextShuntExecutor,
      timers: ReturnType<typeof manualTimers>,
      emitted: Record<string, unknown>,
      bus: FakeEventBus,
    ) => void;
  }> = [
    {
      name: "explicit cancel",
      expected: "cancelled",
      trigger: (executor) => executor.cancel(),
    },
    {
      name: "start availability deadline",
      expected: "reader-unavailable",
      trigger: (_executor, timers) => timers.fire(READER_PREFLIGHT_TIMEOUT_MS),
    },
    {
      name: "terminal timeout",
      expected: "timed-out",
      trigger: (_executor, timers) => timers.fire(READER_TERMINAL_TIMEOUT_MS),
    },
    {
      name: "rotate",
      expected: "cancelled",
      trigger: (executor) => executor.rotate(),
    },
    {
      name: "close",
      expected: "cancelled",
      trigger: (executor) => executor.close(),
    },
  ];

  for (const scenario of cases) {
    const bus = new FakeEventBus();
    const timers = manualTimers();
    bus.on(events.cancelEvent, (payload) =>
      bus.emit(events.responseEvent, completed(payload as Record<string, unknown>)),
    );
    const executor = new ContextShuntExecutor({
      loader: async () => modules(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const pending = executor.execute(request, { cwd: "/workspace", events: bus });
    const emitted = await waitForRequest(bus);
    if (scenario.name !== "start availability deadline") start(bus, emitted);
    scenario.trigger(executor, timers, emitted, bus);
    assert.equal((await pending).kind, scenario.expected, scenario.name);
    assert.equal(cancelCount(bus), 1, scenario.name);
    assert.equal(bus.listeners.get(events.startedEvent)?.size ?? 0, 0, scenario.name);
    assert.equal(bus.listeners.get(events.responseEvent)?.size ?? 0, 0, scenario.name);
    assert.deepEqual(timers.live(), [], scenario.name);
  }
});

test("request emit failure settles before a synchronous CANCEL response", async () => {
  const bus = new FakeEventBus();
  const timers = manualTimers();
  bus.throwOnRequest = true;
  bus.on(events.cancelEvent, (payload) =>
    bus.emit(events.responseEvent, completed(payload as Record<string, unknown>)),
  );
  const executor = new ContextShuntExecutor({
    loader: async () => modules(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  assert.equal(
    (await executor.execute(request, { cwd: "/workspace", events: bus })).kind,
    "reader-unavailable",
  );
  assert.equal(cancelCount(bus), 1);
  assert.equal(bus.listeners.get(events.startedEvent)?.size ?? 0, 0);
  assert.equal(bus.listeners.get(events.responseEvent)?.size ?? 0, 0);
  assert.deepEqual(timers.live(), []);
});

test("rotation and close cancel once, clean up, change owner identity, and close blocks new work", async () => {
  const bus = new FakeEventBus();
  const executor = new ContextShuntExecutor({
    loader: async () => modules(),
    createId: (() => {
      const ids = ["owner-a", "request-a", "node-a", "owner-b", "request-b", "node-b"];
      return () => ids.shift() ?? "extra";
    })(),
  });
  const first = executor.execute(request, { cwd: "/workspace", events: bus });
  const firstEmission = await waitForRequest(bus);
  executor.rotate();
  assert.equal((await first).kind, "cancelled");
  assert.equal(cancelCount(bus), 1);
  const second = executor.execute(request, { cwd: "/workspace", events: bus });
  for (let attempt = 0; attempt < 20 && cancelCount(bus) < 1; attempt += 1) {
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (bus.emissions.filter((entry) => entry.event === events.requestEvent).length === 2) break;
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  }
  const secondEmission = bus.emissions.filter((entry) => entry.event === events.requestEvent).at(-1)
    ?.payload as Record<string, unknown>;
  assert.notEqual(secondEmission.ownerRunId, firstEmission.ownerRunId);
  executor.close();
  assert.equal((await second).kind, "cancelled");
  assert.equal(cancelCount(bus), 2);
  assert.deepEqual(await executor.execute(request, { cwd: "/workspace", events: bus }), {
    kind: "reader-unavailable",
  });
});

test("request emit and cleanup failures remain bounded without exposing foreign errors", async () => {
  const bus = new FakeEventBus();
  bus.throwOnRequest = true;
  bus.throwOnCancel = true;
  bus.throwOnUnsubscribe = true;
  const timers = manualTimers();
  const executor = new ContextShuntExecutor({
    loader: async () => modules(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  assert.deepEqual(await executor.execute(request, { cwd: "/workspace", events: bus }), {
    kind: "reader-unavailable",
  });
  assert.equal(cancelCount(bus), 1);
  assert.deepEqual(timers.live(), []);
  assert.equal(executor.busy, false);
});

test("reader task contains only inline approved source data", () => {
  const task = JSON.parse(buildReaderTask(request)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(task), ["sourceId", "question", "snapshot"]);
  assert.doesNotMatch(JSON.stringify(task), /cwd|artifact|config|digest|expiresAt/i);
});

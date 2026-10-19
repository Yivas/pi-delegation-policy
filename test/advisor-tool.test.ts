import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdvisorExecutor, ADVISOR_AGENT_NAME } from "../src/advisor-executor.ts";
import { AdvisorLog, ADVISOR_LOG_MAX_BYTES } from "../src/advisor-log.ts";
import type { AgentLaunchModules } from "../src/agent-launch.ts";
import {
  ADVISOR_EXTENSION_ENTRY_TYPE,
  appendGuardedSessionState,
  configuredAdvisors,
  getAdvisorConfigPath,
  getAdvisorExtensionPath,
  getGlobalConfigPath,
  parseConfig,
  parseSessionState,
  readConfig,
  resolveDelegateState,
  restoreSessionState,
  writeConfig,
} from "../src/config.ts";
import { createPiDelegationPolicy } from "../src/index.ts";
import {
  advisorStatusLabel,
  loadRuntime,
  validateRuntime,
  validAdvisors,
  type RuntimeState,
} from "../src/runtime.ts";
import { buildPolicyPreview } from "../src/prompt.ts";
import { CURRENT_SCHEMA_VERSION, type GlobalDefaults } from "../src/types.ts";
import {
  readConfig as read020,
  restoreSessionState as restore020,
} from "./fixtures/v0.20.0/config.ts";
import {
  readConfig as read016,
  restoreSessionState as restore016,
} from "./fixtures/v0.16.0/config.ts";

const first = { provider: "example", model: "first", thinking: { level: "low" as const } };
const second = {
  provider: "example",
  model: "second",
  thinking: { min: "medium" as const, max: "high" as const },
};
const base: GlobalDefaults = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  advisors: [first, second],
  advisorMode: "on",
  advisorLaunch: "tool",
};
const models = [first, second].map((setting) => ({
  provider: setting.provider,
  id: setting.model,
  name: setting.model,
  reasoning: true,
  contextWindow: 100_000,
}));
const digest = "a".repeat(64);
const events = {
  requestEvent: "REQUEST",
  startedEvent: "STARTED",
  responseEvent: "RESPONSE",
  cancelEvent: "CANCEL",
};
const sentinel = "PRIVATE-QUESTION-BRIEF-ANSWER-CONVERSATION-SENTINEL";
type Payload = Record<string, unknown>;
type Handler = (event: never, context: never) => unknown;
type Tool = {
  name: string;
  execute: (
    id: string,
    input: { question: string; brief?: string },
    signal: AbortSignal | undefined,
    update: unknown,
    context: never,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

class Bus {
  listeners = new Map<string, Set<(payload: unknown) => void>>();
  requests: Payload[] = [];
  cancels: Payload[] = [];
  respond: ((payload: Payload) => void) | undefined;
  on(event: string, listener: (payload: unknown) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
    };
  }
  emit(event: string, payload: unknown) {
    const fields = payload as Payload;
    if (event === events.requestEvent) {
      this.requests.push(fields);
      this.respond?.(fields);
    }
    if (event === events.cancelEvent) this.cancels.push(fields);
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
  finish(request: Payload, status = "completed", answer = sentinel) {
    this.emit(events.startedEvent, request);
    this.emit(events.responseEvent, {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status,
      agent: ADVISOR_AGENT_NAME,
      model: `${request.model}:${request.thinking}`,
      thinking: request.thinking,
      launchContractDigest: digest,
      result: { kind: "text", text: answer },
    });
  }
}
async function fakeModules(): Promise<AgentLaunchModules> {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/pi-subagents-0.76.1/preflight-contract.json", import.meta.url),
      "utf8",
    ),
  ) as { contract: Payload };
  return {
    ...events,
    admittedRuntimeExtensionLists: () => [["prompt-runtime"]],
    resolveSubagentLaunchContract: async (input) => {
      const fields = input as Payload;
      const contract = structuredClone(fixture.contract);
      contract.runId = fields.runId;
      contract.agent = {
        ...(contract.agent as Payload),
        name: ADVISOR_AGENT_NAME,
        localName: ADVISOR_AGENT_NAME,
        filePath: resolve(
          fileURLToPath(new URL("../agents/pi-delegation-policy.advisor.md", import.meta.url)),
        ),
      };
      contract.context = fields.context;
      contract.model = `${fields.model}:${fields.thinking}`;
      contract.thinking = fields.thinking;
      contract.digest = digest;
      contract.launchContractDigest = digest;
      const tools = contract.tools as Payload;
      tools.effectiveAllowlist = [];
      tools.requiredChildTools = [];
      tools.internalTools = [];
      tools.runtimeExtensions = ["prompt-runtime"];
      tools.extensionArgs = ["prompt-runtime"];
      contract.roots = { cwd: resolve(fields.cwd as string) };
      return { ok: true, contract };
    },
  };
}
async function harness(value = base, available = models, tokens: number | null = 10_000) {
  const directory = await mkdtemp(join(tmpdir(), "advisor-tool-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const path = getGlobalConfigPath(directory);
  await writeConfig(path, value);
  const bus = new Bus();
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const notifications: Array<{ message: string; type: string }> = [];
  const tools = new Map<string, Tool>();
  const branch: unknown[] = [];
  const statuses: string[] = [];
  const ctx = {
    cwd: "/synthetic-project",
    scopedModels: [],
    hasUI: false,
    mode: "rpc",
    getContextUsage: () => ({ tokens }),
    sessionManager: { getBranch: () => branch, getSessionId: () => "synthetic-session" },
    modelRegistry: {
      find: (provider: string, id: string) =>
        available.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => available,
      hasConfiguredAuth: () => true,
    },
    ui: {
      setStatus: (_key: string, text: string) => statuses.push(text),
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string, type: string) => notifications.push({ message, type }),
    },
  };
  const modules = await fakeModules();
  const executor = new AdvisorExecutor({ loader: async () => modules });
  const logPath = join(directory, "events.jsonl");
  const log = new AdvisorLog(logPath);
  createPiDelegationPolicy({ advisorExecutor: executor, advisorLog: log })({
    events: bus,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: never) => Promise<void> },
    ) => commands.set(name, command),
    registerShortcut: () => undefined,
    getAllTools: () => [],
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
  } as never);
  const hook = async (name: string, event: Payload = {}) =>
    handlers.get(name)?.(event as never, ctx as never);
  await hook("session_start");
  return {
    bus,
    ctx,
    hook,
    branch,
    statuses,
    notifications,
    command: (args: string) => commands.get("delegate")!.handler(args, ctx as never),
    log,
    path,
    logPath,
    executor,
    call: async (input = { question: sentinel, brief: sentinel }, signal?: AbortSignal) =>
      (await tools.get("consult_advisor")!.execute("id", input, signal, undefined, ctx as never))
        .content[0]!.text,
    close: async () => {
      await hook("session_shutdown");
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      // Windows can delay directory removal even after the writer has drained.
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "synthetic host did not receive its requests");
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
}

// Public boundary: schema parsing/effective state, saved files read by released parsers, and the
// registered tool/hooks against a synthetic delegation event host. No provider or credentials.
test("removing Advisor 1 through the command clears the list and turns Advisor off", async () => {
  for (const advisors of [[first], [first, second]]) {
    const run = await harness({ ...base, advisors });
    try {
      await run.command("advisor 1 model remove");
      const state = await loadRuntime(run.ctx as never);
      assert.equal(configuredAdvisors(state.session), null);
      assert.ok(!state.effective.advisors.some((setting) => setting.model === second.model));
      assert.deepEqual(state.effective.advisors, []);
      assert.equal(state.effective.advisorMode, "off");
      assert.equal(advisorStatusLabel(state), "A:OFF");
      assert.match(run.statuses.at(-1) ?? "", /A:OFF/);
      assert.doesNotMatch(run.statuses.at(-1) ?? "", /A:ERR/);
    } finally {
      await run.close();
    }
  }
});

test("Advisor thinking commands reject invalid levels without writes and save a valid range", async () => {
  const run = await harness();
  try {
    const before = structuredClone(run.branch);
    await run.command("advisor 1 thinking 2 MAX");
    assert.deepEqual(run.branch, before);
    assert.deepEqual(run.notifications.at(-1), {
      message: "Use thinking unset, LEVEL, or MIN MAX.",
      type: "error",
    });
    await run.command("advisor 1 thinking low high");
    const state = await loadRuntime(run.ctx as never);
    assert.deepEqual(state.session.advisors?.[0]?.thinking, { min: "low", max: "high" });
    assert.deepEqual(state.effective.advisors, [
      { ...first, thinking: { min: "low", max: "high" } },
      second,
    ]);
    assert.equal(advisorStatusLabel(state), "A:ON");
  } finally {
    await run.close();
  }
});

test("missing session extension retains global tool launch and reports inheritance", async () => {
  const run = await harness();
  try {
    appendGuardedSessionState(
      { appendEntry: (customType, data) => run.branch.push({ type: "custom", customType, data }) },
      base,
    );
    const index = run.branch.findIndex(
      (entry) => (entry as Payload).customType === ADVISOR_EXTENSION_ENTRY_TYPE,
    );
    assert.ok(index >= 0);
    run.branch.splice(index, 1);
    const state = await loadRuntime(run.ctx as never);
    assert.deepEqual(state.effective.advisors, [first]);
    assert.equal(state.effective.advisorLaunch, "tool");
    assert.match(
      state.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
      /with the inherited launch mode/,
    );
    await run.command("status");
    assert.match(run.notifications.at(-1)?.message ?? "", /advisor-launch=tool/);
  } finally {
    await run.close();
  }
});

test("Advisor-only preview counts valid advisors instead of displaying invalid Advisor 1", () => {
  const state: RuntimeState = {
    global: base,
    session: { schemaVersion: CURRENT_SCHEMA_VERSION },
    effective: resolveDelegateState(base, { schemaVersion: CURRENT_SCHEMA_VERSION }),
    diagnostics: [],
    modelStatuses: new Map(),
    runtimeErrors: [],
  };
  validateRuntime(
    {
      scopedModels: [],
      modelRegistry: {
        find: (provider: string, id: string) =>
          models.slice(1).find((model) => model.provider === provider && model.id === id),
        getAvailable: () => models.slice(1),
        hasConfiguredAuth: () => true,
      },
    } as never,
    state,
  );
  assert.equal(advisorStatusLabel(state), "A:PART");
  const preview = buildPolicyPreview(state.effective, validAdvisors(state).length).join("\n");
  assert.match(preview, /1 of 2 advisors valid/);
  assert.doesNotMatch(preview, /example\/first/);
});

test("inactive policy logging creates no records and resumes cleanly after reactivation", async () => {
  const run = await harness({ ...base, advisorMode: "off" });
  try {
    await run.hook("before_provider_request", { payload: { instructions: "host" } });
    await run.log.flush();
    await assert.rejects(readFile(run.logPath), { code: "ENOENT" });
    const settings = {
      intensity: "off" as const,
      advisorMode: "on" as const,
      advisorLaunch: "tool" as const,
      context: "fresh" as const,
      advisors: 1,
    };
    run.log.policy("active", settings);
    run.log.policy(undefined, { ...settings, advisorMode: "off" });
    run.log.consultation("tool", []);
    await run.log.flush();
    const before = await readFile(run.logPath, "utf8");
    assert.equal(before.trim().split("\n").length, 1);
    run.log.policy("active", settings);
    await run.log.flush();
    const records = (await readFile(run.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.event === "policy"));
    assert.equal(records[0].hash, records[1].hash);
  } finally {
    await run.close();
  }
});

test("schema 9 preserves the first advisor on downgrade and isolates stale extension state", async () => {
  for (const bad of [
    [],
    [first, second, first],
    [{ ...first, extra: true }],
    [{ ...first, thinking: { min: "high", max: "low" } }],
  ]) {
    assert.equal(parseConfig({ ...base, advisors: bad }), undefined);
  }
  assert.equal(parseConfig({ ...base, advisors: null }), undefined);
  assert.equal(parseSessionState({ schemaVersion: 9, advisors: null })?.advisors, null);
  assert.deepEqual(parseConfig(base)?.advisors, [first, second]);
  for (const schemaVersion of [2, 3, 4, 5, 6, 7, 8]) {
    const parsed = parseConfig({
      schemaVersion,
      ...(schemaVersion >= 7
        ? {
            advisor: { provider: "example", model: "first" },
            thinking: { advisor: { level: "low" } },
          }
        : {}),
    });
    assert.ok(parsed);
    assert.deepEqual(
      resolveDelegateState(parsed, { schemaVersion: 9 }).advisors,
      schemaVersion >= 7 ? [first] : [],
    );
  }
  const run = await harness({
    ...base,
    intensity: "normal",
    small: { provider: "example", model: "first" },
    medium: null,
    large: null,
  });
  try {
    const old = await read020(run.path);
    assert.deepEqual(old.diagnostics, []);
    assert.deepEqual(old.defaults.advisor, { provider: "example", model: "first" });
    assert.deepEqual(old.defaults.thinking?.advisor, { level: "low" });
    assert.equal((old.defaults as Payload).advisorLaunch, undefined);
    assert.equal((await read016(run.path)).defaults.advisor, undefined);
    assert.equal((await read016(run.path)).defaults.intensity, "normal");
    const branch: unknown[] = [];
    assert.equal(
      appendGuardedSessionState(
        { appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }) },
        base,
      ),
      "success",
    );
    assert.deepEqual(restore020(branch).advisor, { provider: "example", model: "first" });
    assert.deepEqual(restore020(branch).thinking?.advisor, { level: "low" });
    assert.equal(restore016(branch).advisor, null);
    assert.deepEqual(
      resolveDelegateState({ schemaVersion: 9 }, restoreSessionState(branch)).advisors,
      [first, second],
    );
    const extensionPath = getAdvisorExtensionPath(run.path);
    const original = await readFile(extensionPath, "utf8");
    for (const invalid of [
      "invalid",
      JSON.stringify({ ...JSON.parse(original), base: { schemaVersion: 8 } }),
    ]) {
      await writeFile(extensionPath, invalid);
      const loaded = await readConfig(run.path);
      assert.equal(loaded.diagnostics[0]?.scope, "advisor-extension");
      const effective = resolveDelegateState(loaded.defaults, { schemaVersion: 9 });
      assert.deepEqual(effective.advisors, [first]);
      assert.equal(effective.advisorLaunch, "role");
      const state: RuntimeState = {
        global: loaded.defaults,
        session: { schemaVersion: 9 },
        effective,
        diagnostics: loaded.diagnostics,
        modelStatuses: new Map(),
        runtimeErrors: [],
      };
      validateRuntime(run.ctx as unknown as ExtensionContext, state);
      assert.equal(advisorStatusLabel(state), "A:ON");
    }
    await rm(extensionPath);
    assert.equal((await readConfig(run.path)).diagnostics[0]?.scope, "advisor-extension");
    assert.equal(
      JSON.parse(await readFile(getAdvisorConfigPath(run.path), "utf8")).state.schemaVersion,
      8,
    );
  } finally {
    await run.close();
  }
});

test("each advisor validates independently and role mode groups every valid advisor", async () => {
  for (const [available, status] of [
    [models, "A:ON"],
    [[models[0]!], "A:PART"],
    [[], "A:ERR"],
  ] as const) {
    const run = await harness({ ...base, advisorLaunch: "role" }, [...available]);
    try {
      assert.equal(run.statuses.at(-1), `D:OFF ${status}`);
      const payload = (await run.hook("before_provider_request", {
        payload: { model: "example", stream: true, store: false, instructions: "host" },
      })) as { instructions: string };
      if (available.length === 2) {
        assert.match(payload.instructions, /Advisor 1 \(optional\)/);
        assert.match(payload.instructions, /Advisor 2 \(optional\)/);
        assert.match(payload.instructions, /runs\.all or several tasks in a single call/);
        assert.match(payload.instructions, /agreement is not proof/);
      } else if (available.length === 1) {
        assert.match(payload.instructions, /example\/first/);
        assert.doesNotMatch(payload.instructions, /example\/second/);
      } else assert.equal(payload.instructions, "host");
      assert.equal(run.bus.requests.length, 0);
    } finally {
      await run.close();
    }
  }
});

test("tool is unavailable outside its launch mode or without enabled valid advisors", async () => {
  for (const value of [
    { ...base, advisorLaunch: "role" as const },
    { ...base, advisorMode: "off" as const },
    { ...base, advisors: [{ provider: "example", model: "missing" }] },
  ]) {
    const run = await harness(value);
    try {
      assert.match(await run.call(), /Advisor unavailable/);
      assert.equal(run.bus.requests.length, 0);
    } finally {
      await run.close();
    }
  }
});

test("tool starts both exact models in parallel, preserves a partial answer and never launches from hooks", async () => {
  const run = await harness();
  try {
    for (const name of [
      "context_with_system",
      "before_provider_request",
      "tool_call",
      "tool_result",
      "agent_end",
    ]) {
      await run.hook(name, {
        messages: [{ role: "system", content: "host" }],
        payload: { model: "example", stream: true, store: false, instructions: "host" },
        toolName: "subagent",
        input: { agent: ADVISOR_AGENT_NAME, model: "example/first", task: sentinel },
      });
    }
    assert.equal(run.bus.requests.length, 0);
    const call = run.call();
    await until(() => run.bus.requests.length === 2);
    assert.deepEqual(
      run.bus.requests.map((request) => [
        request.model,
        request.thinking,
        request.context,
        request.task,
      ]),
      [
        ["example/first", "low", "fork", sentinel],
        ["example/second", "high", "fork", sentinel],
      ],
    );
    assert.match(await run.call(), /Advisor busy/);
    run.bus.finish(run.bus.requests[1]!, "failed");
    run.bus.finish(run.bus.requests[0]!);
    const answer = await call;
    assert.match(answer, /example\/first \[fork\]/);
    assert.match(answer, new RegExp(sentinel));
    assert.match(answer, /example\/second \[fork\]:\nAdvisor failed/);
    const policy = (await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    })) as { instructions: string };
    assert.match(policy.instructions, /Call consult_advisor/);
    assert.doesNotMatch(policy.instructions, /Launch it with the host's subagent tool/);
  } finally {
    await run.close();
  }
});

test("fork rejection retries only that advisor once with fresh brief", async () => {
  const run = await harness();
  try {
    run.bus.respond = (request) => {
      if (request.model === "example/first" && request.context === "fork")
        run.bus.emit(events.responseEvent, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "unavailable_context",
        });
      else run.bus.finish(request);
    };
    const answer = await run.call();
    assert.equal(run.bus.requests.length, 3);
    const retried = run.bus.requests.find((request) => request.context === "fresh")!;
    assert.equal(retried.model, "example/first");
    assert.deepEqual(JSON.parse(retried.task as string), { question: sentinel, brief: sentinel });
    assert.match(answer, /example\/first \[fresh\]/);
  } finally {
    await run.close();
  }
});

test("fresh requires a brief; rejected forks without a brief are not retried", async () => {
  const fresh = await harness(base, models, 60_000);
  try {
    assert.match(await fresh.call({ question: sentinel } as never), /fresh context requires brief/);
    assert.equal(fresh.bus.requests.length, 0);
  } finally {
    await fresh.close();
  }
  const fork = await harness();
  try {
    fork.bus.respond = (request) =>
      fork.bus.emit(events.responseEvent, {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: "unavailable_context",
      });
    assert.match(await fork.call({ question: sentinel } as never), /Call again with brief/);
    assert.equal(fork.bus.requests.length, 2);
  } finally {
    await fork.close();
  }
});

test("abort and branch rotation cancel the whole group and remove listeners idempotently", async () => {
  for (const rotate of [false, true]) {
    const run = await harness();
    try {
      const controller = new AbortController();
      const call = run.call(undefined, controller.signal);
      await until(() => run.bus.requests.length === 2);
      if (rotate) await run.hook("session_tree");
      else controller.abort();
      assert.match(await call, /Advisor cancelled/);
      controller.abort();
      run.executor.cancel();
      assert.equal(run.bus.cancels.length, 2);
      assert.ok([...run.bus.listeners.values()].every((listeners) => listeners.size === 0));
      for (const request of run.bus.requests) run.bus.finish(request);
      assert.equal(run.executor.busy, false);
    } finally {
      await run.close();
    }
  }
});

test("AdvisorLog drains normally, caps a blocked write and performs no new I/O after close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stalledOperation of [undefined, "mkdir", "stat", "rm", "rename", "append"]) {
    const calls: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = async (name: string) => {
      calls.push(name);
      if (name === (stalledOperation ?? "append")) {
        started();
        await blocked;
      }
    };
    const log = new AdvisorLog("/synthetic/events.jsonl", {
      mkdir: async () => {
        await operation("mkdir");
        return undefined;
      },
      stat: async () => {
        await operation("stat");
        return {
          size:
            stalledOperation === "rm" || stalledOperation === "rename" ? ADVISOR_LOG_MAX_BYTES : 0,
        } as never;
      },
      rm: () => operation("rm"),
      rename: () => operation("rename"),
      appendFile: () => operation("append"),
    });
    const settings = {
      intensity: "off" as const,
      advisorMode: "on" as const,
      advisorLaunch: "tool" as const,
      context: "fresh" as const,
      advisors: 1,
    };
    log.policy("active", settings);
    await writing;
    log.consultation("tool", []);
    let closed = false;
    const closing = log.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false, "close must await an accepted write before the cap");
    if (stalledOperation) {
      t.mock.timers.tick(4_999);
      await Promise.resolve();
      assert.equal(closed, false);
      t.mock.timers.tick(1);
      await closing;
      const atClose = [...calls];
      log.policy("after close", settings);
      log.consultation("tool", []);
      release();
      await log.flush();
      assert.deepEqual(calls, atClose, "late completion and post-close enqueue must start no I/O");
    } else {
      release();
      await closing;
      assert.deepEqual(calls, ["mkdir", "stat", "append", "mkdir", "stat", "append"]);
      const atClose = [...calls];
      log.policy("after close", settings);
      log.consultation("tool", []);
      await log.flush();
      assert.deepEqual(calls, atClose);
    }
  }
});

test("logs rotate, deduplicate policy hashes, contain metadata only and tolerate write failure", async () => {
  const run = await harness({ ...base, advisorLaunch: "role" });
  try {
    for (let index = 0; index < 2; index++)
      await run.hook("before_provider_request", {
        payload: { model: "example", stream: true, store: false, instructions: "host" },
      });
    await run.hook("tool_call", {
      toolName: "subagent",
      input: {
        tasks: [
          {
            agent: ADVISOR_AGENT_NAME,
            model: "example/first:low",
            task: sentinel,
            context: "fork",
          },
          { agent: "other", model: sentinel, task: sentinel },
        ],
      },
    });
    await run.log.flush();
    const text = await readFile(run.logPath, "utf8");
    assert.doesNotMatch(text, new RegExp(sentinel));
    assert.doesNotMatch(text, /synthetic-project|question|brief|answer|conversation/);
    const lines = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.filter((event) => event.event === "policy").length, 1);
    assert.deepEqual(
      lines
        .find((event) => event.event === "consultation")
        .models.map((entry: Payload) => entry.model),
      ["example/first"],
    );
    await writeFile(run.logPath, "x".repeat(ADVISOR_LOG_MAX_BYTES));
    run.log.consultation("role", [
      { model: "example/first", status: "observed", context: "fork", durationMs: 0 },
    ]);
    await run.log.flush();
    assert.equal((await readFile(`${run.logPath}.1`, "utf8")).length, ADVISOR_LOG_MAX_BYTES);
    const broken = new AdvisorLog(join(run.logPath, "cannot-write"));
    broken.policy("active", {
      intensity: "off",
      advisorMode: "on",
      advisorLaunch: "tool",
      context: "fresh",
      advisors: 1,
    });
    broken.consultation("tool", []);
    await assert.doesNotReject(broken.flush());
  } finally {
    await run.close();
  }
});

test("tool policy remains stable across context changes and logs no consultation content", async () => {
  const run = await harness({ ...base, advisors: [{ provider: "example", model: "first" }] });
  try {
    const payload = { model: "example", stream: true, store: false, instructions: "host" };
    const initial = await run.hook("before_provider_request", { payload });
    run.ctx.getContextUsage = () => ({ tokens: 90_000 });
    assert.deepEqual(await run.hook("before_provider_request", { payload }), initial);
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), new RegExp(sentinel));
    assert.equal(run.bus.requests[0]?.thinking, "high");
    assert.equal(run.bus.requests[0]?.context, "fresh");
    await run.log.flush();
    const log = await readFile(run.logPath, "utf8");
    assert.doesNotMatch(log, new RegExp(sentinel));
    assert.doesNotMatch(log, /question|brief|answer|conversation|synthetic-project/);
    assert.equal(
      log
        .trim()
        .split(String.fromCharCode(10))
        .map((line) => JSON.parse(line))
        .filter((event) => event.event === "policy").length,
      1,
    );
    assert.match(log, /completed/);
  } finally {
    await run.close();
  }
});

test("advisor group terminal timeout cancels each child and settles locally", async () => {
  const bus = new Bus();
  const modules = await fakeModules();
  const timers: Array<{ callback: () => void; delay: number; live: boolean }> = [];
  const executor = new AdvisorExecutor({
    loader: async () => modules,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, live: true };
      timers.push(timer);
      return timer as never;
    },
    clearTimer: (timer) => {
      (timer as unknown as { live: boolean }).live = false;
    },
  });
  bus.respond = (request) => bus.emit(events.startedEvent, request);
  const pending = executor.execute(
    ["first", "second"].map((id) => ({
      question: sentinel,
      context: "fork" as const,
      model: { provider: "example", id, thinking: "high" },
      availableModels: [{ provider: "example", id, fullId: `example/${id}`, reasoning: true }],
    })),
    { cwd: "/synthetic", sessionId: "synthetic", events: bus },
    undefined,
    () => undefined,
  );
  await until(() => bus.requests.length === 2);
  for (const timer of timers.filter((timer) => timer.live && timer.delay === 120_000))
    timer.callback();
  assert.deepEqual(
    (await pending).map((answer) => answer.result.kind),
    ["timed-out", "timed-out"],
  );
  assert.equal(bus.cancels.length, 2);
  assert.ok(timers.every((timer) => !timer.live));
  executor.close();
});

test("a failed third global replacement restores the exact previous three-file state", async () => {
  const run = await harness();
  const realNow = Date.now;
  try {
    const paths = [run.path, getAdvisorConfigPath(run.path), getAdvisorExtensionPath(run.path)];
    const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    Date.now = () => 1_700_000_000_000;
    await mkdir(`${paths[2]}.${process.pid}.${Date.now()}.tmp`);
    assert.equal(
      await writeConfig(run.path, { ...base, advisors: [second, first], advisorLaunch: "role" }),
      "unchanged",
    );
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), before);
    assert.deepEqual((await read020(run.path)).defaults.advisor, {
      provider: "example",
      model: "first",
    });
  } finally {
    Date.now = realNow;
    await run.close();
  }
});

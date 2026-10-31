import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdvisorExecutor, ADVISOR_AGENT_NAME, advisorAgentName } from "../src/advisor-executor.ts";
import {
  ANTHROPIC_ADVISOR_AGENT,
  ANTHROPIC_ADVISOR_EXTENSION,
} from "../src/advisor-anthropic-provider.ts";
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
import { advisorUnavailableText, createPiDelegationPolicy } from "../src/index.ts";
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
const hostErrorSentinel = "RAW-HOST-ERROR https://provider.invalid/secret /private/session/path";
// `pi-subagents` 0.76.1 wraps a fork task before hashing the launch binding, so the preflight must
// hash this exact prefix instead of the raw task the request still carries.
const forkPreamble =
  "You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.";
const forkTask = (task: string) => {
  const prefix = `${forkPreamble}\n\nTask:\n`;
  return task.startsWith(prefix) ? task : `${prefix}${task}`;
};
const launchTaskDigest = (task: string) =>
  createHash("sha256").update(JSON.stringify(task)).digest("hex");
type Payload = Record<string, unknown>;
type Handler = (event: never, context: never) => unknown;
type Tool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
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
  /** The host wraps a fork task before it launches the child and binds that wrapped task. */
  wrapForExecution: (task: string) => string = forkTask;
  failRequestEmit = false;
  on(event: string, listener: (payload: unknown) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
    };
  }
  emit(event: string, payload: unknown) {
    if (this.failRequestEmit && event === events.requestEvent) throw new Error(hostErrorSentinel);
    const fields = payload as Payload;
    if (event === events.requestEvent) {
      this.requests.push(fields);
      this.respond?.(fields);
    }
    if (event === events.cancelEvent) this.cancels.push(fields);
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
  finish(request: Payload, status = "completed", answer: unknown = sentinel, error?: string) {
    const task = request.task as string;
    const executionTask = request.context === "fork" ? this.wrapForExecution(task) : task;
    this.emit(events.startedEvent, request);
    this.emit(events.responseEvent, {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status,
      agent: request.agent,
      model: `${request.model}:${request.thinking}`,
      thinking: request.thinking,
      launchContractDigest: launchTaskDigest(executionTask),
      result: { kind: "text", text: answer },
      ...(error === undefined ? {} : { error }),
    });
  }
}
async function fakeModules(
  preflight: "valid" | "throw" | "undefined" | "invalid" = "valid",
  fixtureVersion: "0.76.1" | "0.83.1" = "0.76.1",
  packageVersion?: unknown,
): Promise<AgentLaunchModules> {
  const fixture = JSON.parse(
    await readFile(
      new URL(`./fixtures/pi-subagents-${fixtureVersion}/preflight-contract.json`, import.meta.url),
      "utf8",
    ),
  ) as { contract: Payload };
  return {
    ...events,
    admittedRuntimeExtensionLists: () => [["prompt-runtime"]],
    normalizeForkTask: forkTask,
    resolveSubagentLaunchContract: async (input) => {
      if (preflight === "throw") throw new Error(hostErrorSentinel);
      if (preflight === "undefined") return undefined;
      if (preflight === "invalid") return { ok: false };
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
      // The real preflight hashes the task it received, which the extension must already have
      // wrapped for a fork.
      contract.launchContractDigest = launchTaskDigest(fields.task as string);
      const tools = contract.tools as Payload;
      tools.effectiveAllowlist = [];
      tools.requiredChildTools = [];
      tools.internalTools = [];
      tools.runtimeExtensions = ["prompt-runtime"];
      tools.extensionArgs = ["prompt-runtime"];
      // A 0.83.x contract also carries the lifecycle subtree; the launch checks tolerate it.
      contract.roots = { ...(contract.roots as Payload), cwd: resolve(fields.cwd as string) };
      if (packageVersion !== undefined)
        contract.protocol = { ...(contract.protocol as Payload), packageVersion };
      return { ok: true, contract };
    },
  };
}
async function harness(
  value = base,
  available = models,
  tokens: number | null = 10_000,
  options: {
    forkTaskNormalizer?: boolean;
    preflight?: "throw" | "undefined" | "invalid";
    fixtureVersion?: "0.76.1" | "0.83.1";
    packageVersion?: unknown;
  } = {},
) {
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
  const registrations: string[] = [];
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
  const loaded = await fakeModules(
    options.preflight,
    options.fixtureVersion,
    options.packageVersion,
  );
  const modules: AgentLaunchModules =
    options.forkTaskNormalizer === false ? { ...loaded, normalizeForkTask: undefined } : loaded;
  const executor = new AdvisorExecutor({ loader: async () => modules });
  const logPath = join(directory, "events.jsonl");
  const log = new AdvisorLog(logPath);
  createPiDelegationPolicy({ advisorExecutor: executor, advisorLog: log })({
    events: bus,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (tool: Tool) => {
      registrations.push(tool.name);
      tools.set(tool.name, tool);
    },
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
    tools,
    registrations,
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
test("model commands preserve the Advisor provider opt-in instead of falling back", async () => {
  const configured = {
    provider: "anthropic",
    model: "synthetic-one",
    providerExtension: "anthropic-auth" as const,
    thinking: { level: "low" as const },
  };
  const available = ["synthetic-one", "synthetic-two"].map((id) => ({
    ...models[0]!,
    provider: "anthropic",
    id,
    name: id,
  }));
  available.push({ ...models[0]!, provider: "example", id: "incompatible", name: "incompatible" });
  for (const advisorLaunch of ["role", "tool"] as const) {
    const run = await harness(
      { ...base, advisors: [configured], advisorMode: "off", advisorLaunch },
      available,
    );
    try {
      for (const model of [
        "anthropic/synthetic-one",
        "anthropic/synthetic-two",
        "example/incompatible",
      ]) {
        await run.command(`advisor 1 model ${model}`);
        const saved = restoreSessionState(run.branch).advisors?.[0];
        assert.equal(saved?.providerExtension, "anthropic-auth");
        assert.equal(`${saved?.provider}/${saved?.model}`, model);
        assert.deepEqual(saved?.thinking, configured.thinking);
        assert.equal(advisorAgentName(saved!), ANTHROPIC_ADVISOR_AGENT);
      }
      await run.command("advisor on");
      const state = await loadRuntime(run.ctx as never);
      assert.equal(advisorStatusLabel(state), "A:ERR");
      assert.match(state.advisorErrors?.join(" ") ?? "", /requires provider anthropic/);
      assert.deepEqual(validAdvisors(state), []);
      assert.equal(run.bus.requests.length, 0);
    } finally {
      await run.close();
    }
  }
});
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
      resolveDelegateState(parsed, { schemaVersion: CURRENT_SCHEMA_VERSION }).advisors,
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
      resolveDelegateState({ schemaVersion: CURRENT_SCHEMA_VERSION }, restoreSessionState(branch))
        .advisors,
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
      const effective = resolveDelegateState(loaded.defaults, {
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
      assert.deepEqual(effective.advisors, [first]);
      assert.equal(effective.advisorLaunch, "role");
      const state: RuntimeState = {
        global: loaded.defaults,
        session: { schemaVersion: CURRENT_SCHEMA_VERSION },
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

test("off tells the model not to consult or request activation in either launch mode", async () => {
  for (const advisorLaunch of ["role", "tool"] as const) {
    for (const advisorMode of ["off", "with-delegation"] as const) {
      const run = await harness({ ...base, advisorLaunch, advisorMode });
      try {
        assert.equal(
          await run.call(),
          "Advisor is off in /delegate for this session. Do not consult it and do not ask the user to enable it unless they raise it.",
        );
        assert.equal(run.bus.requests.length, 0);
      } finally {
        await run.close();
      }
    }
  }
});

test("role redirects to one background host call with the policy's exact launch lines", async () => {
  for (const advisors of [[first, second], [{ provider: "example", model: "first" }]]) {
    const run = await harness({ ...base, advisorLaunch: "role", advisors });
    try {
      const answer = await run.call();
      assert.match(answer, /do not call this tool again/);
      assert.match(answer, /host subagent tool/);
      assert.match(
        answer,
        /in the background, all listed Advisors with the same question in one call/,
      );
      assert.match(answer, /agent profile: "pi-delegation-policy.advisor"/);
      if (advisors.length === 2) {
        assert.match(answer, /pi-subagents form: "example\/first:low"/);
        assert.match(answer, /fixed low \(must not change\)/);
        assert.match(answer, /pi-subagents form: "example\/second:LEVEL"/);
        assert.match(answer, /range medium\.\.high inclusive \(choose within it\)/);
      } else {
        assert.match(answer, /pi-subagents form: "example\/first:LEVEL"/);
        assert.match(answer, /unset \(choose per run\)/);
      }
      const policy = (await run.hook("before_provider_request", {
        payload: { model: "example", stream: true, store: false, instructions: "host" },
      })) as { instructions: string };
      const roleLines = policy.instructions
        .split("\n")
        .filter((line) => line.startsWith("- Advisor"));
      assert.equal(roleLines.length, advisors.length);
      for (const line of roleLines) assert.ok(answer.includes(line));
      assert.doesNotMatch(answer, /select tool launch|enable at least|change.*\/delegate/);
      assert.equal(run.bus.requests.length, 0);
    } finally {
      await run.close();
    }
  }
});

test("role redirection lists only valid Advisors without substituting an invalid one", async () => {
  const run = await harness({ ...base, advisorLaunch: "role" }, [models[1]!]);
  try {
    const answer = await run.call();
    assert.match(answer, /Advisor 2 \(optional\)/);
    assert.match(answer, /example\/second:LEVEL/);
    assert.doesNotMatch(answer, /example\/first/);
    assert.equal(run.bus.requests.length, 0);
  } finally {
    await run.close();
  }
});

test("tool without valid Advisors reports existing causes by Advisor and does not request settings changes", async () => {
  for (const [advisors, available, expected] of [
    [[], models, /Advisor model is not configured/],
    [
      [first, second],
      [],
      /Advisor 1: Advisor model is not registered in Pi\.[\s\S]*Advisor 2: Advisor 2 model is not registered in Pi\./,
    ],
    [
      [{ ...first, thinking: { level: "high" as const } }],
      [{ ...models[0]!, reasoning: false }],
      /Advisor 1: Advisor thinking level "high" is not supported/,
    ],
    [
      [{ provider: "anthropic", model: "synthetic", providerExtension: "anthropic-auth" as const }],
      [{ ...models[0]!, provider: "anthropic", id: "synthetic" }],
      /Advisor 1: Advisor provider unavailable: requires the exact managed-user/,
    ],
  ] as const) {
    const run = await harness({ ...base, advisors: advisors.length ? [...advisors] : undefined }, [
      ...available,
    ]);
    try {
      const answer = await run.call();
      assert.match(answer, /Advisor unavailable: no valid Advisors/);
      assert.match(answer, expected);
      assert.match(
        answer,
        /Continue without Advisor consultation\. Do not retry with the same settings/,
      );
      assert.doesNotMatch(answer, /select tool launch|enable at least|in \/delegate/);
      assert.equal(run.bus.requests.length, 0);
    } finally {
      await run.close();
    }
  }
});

test("invalid saved Advisor diagnostics tell the model to report the required user repair without retrying", () => {
  for (const message of [
    "Advisor settings are invalid or no longer match delegation defaults. Save them again with /delegate; delegation remains available.",
    "Advisor session settings are invalid or do not match delegation state. Apply them again with /delegate.",
  ]) {
    const state: RuntimeState = {
      global: base,
      session: { schemaVersion: CURRENT_SCHEMA_VERSION },
      effective: resolveDelegateState(base, { schemaVersion: CURRENT_SCHEMA_VERSION }),
      diagnostics: [{ message, scope: "advisor", reportWhenOff: true }],
      modelStatuses: new Map(),
      runtimeErrors: [],
    };
    validateRuntime(
      {
        scopedModels: [],
        modelRegistry: {
          find: () => models[0],
          getAvailable: () => models,
          hasConfiguredAuth: () => true,
        },
      } as never,
      state,
    );
    assert.deepEqual(validAdvisors(state), []);
    assert.equal(
      advisorUnavailableText(state),
      `Advisor unavailable: no valid Advisors.\n${message}\nContinue without Advisor consultation. Tell the user that the saved Advisor configuration is invalid and must be saved again in /delegate. Do not retry this tool.`,
    );
  }
});

test("registered tool definitions and order stay identical across modes and repeated requests", async () => {
  const definitions = (run: Awaited<ReturnType<typeof harness>>) =>
    [...run.tools.values()].map(({ name, label, description, parameters }) => ({
      name,
      label,
      description,
      parameters,
    }));
  let baseline: ReturnType<typeof definitions> | undefined;
  for (const value of [
    { ...base, advisorMode: "off" as const },
    { ...base, advisorLaunch: "role" as const },
    { ...base, advisors: [{ provider: "example", model: "missing" }] },
    base,
  ]) {
    const run = await harness(value);
    try {
      const initial = definitions(run);
      baseline ??= initial;
      assert.deepEqual(initial, baseline);
      for (const command of [
        "advisor off",
        "advisor launch role",
        "advisor on",
        "advisor launch tool",
      ]) {
        await run.command(command);
        for (let request = 0; request < 2; request++)
          await run.hook("before_provider_request", {
            payload: { model: "example", stream: true, store: false, instructions: "host" },
          });
        assert.deepEqual(definitions(run), initial);
        assert.deepEqual(run.registrations, [
          "consult_advisor",
          "context_shunt_delegate",
          "context_shunt_recover",
        ]);
      }
    } finally {
      await run.close();
    }
  }
});

test("invalid question and absent session identify the corrective action without launching", async () => {
  const run = await harness();
  try {
    assert.equal(
      await run.call({ question: "   ", brief: sentinel }),
      "Advisor error: question must not be blank. Call again with a specific question.",
    );
    run.ctx.sessionManager.getSessionId = () => "";
    assert.equal(
      await run.call(),
      "Advisor unavailable: host session identity is missing. Continue without Advisor consultation; do not retry until the host supplies a session identity.",
    );
    assert.equal(run.bus.requests.length, 0);
  } finally {
    await run.close();
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
    assert.match(
      await run.call(),
      /Advisor busy:.*Wait for its result.*do not duplicate the pending group/,
    );
    run.bus.finish(run.bus.requests[1]!, "failed", sentinel, hostErrorSentinel);
    run.bus.finish(run.bus.requests[0]!);
    const answer = await call;
    assert.match(answer, /example\/first \[fork\]/);
    assert.match(answer, new RegExp(sentinel));
    assert.match(
      answer,
      /example\/second \[fork\]:\nThe host ended the Advisor run with status failed and supplied no safe detail/,
    );
    assert.doesNotMatch(answer, /RAW-HOST-ERROR|provider\.invalid|private\/session/);
    const policy = (await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    })) as { instructions: string };
    await run.log.flush();
    assert.doesNotMatch(
      await readFile(run.logPath, "utf8"),
      /RAW-HOST-ERROR|provider\.invalid|private\/session/,
    );
    assert.match(policy.instructions, /Call consult_advisor/);
    assert.doesNotMatch(policy.instructions, /Launch it with the host's subagent tool/);
  } finally {
    await run.close();
  }
});

test("terminal results must match the bound digest and carry usable text", async () => {
  {
    const run = await harness();
    try {
      // A host that reports the raw fork task binds a digest the preflight never saw.
      run.bus.wrapForExecution = (task) => task;
      run.bus.respond = (request) => run.bus.finish(request);
      const answer = await run.call();
      assert.match(
        answer,
        /example\/first \[fork\]:\nThe host returned an Advisor reply whose launch contract digest did not match the preflight contract, so the reply was discarded/,
      );
      assert.doesNotMatch(answer, new RegExp(sentinel));
    } finally {
      await run.close();
    }
  }
  {
    const run = await harness();
    try {
      run.bus.respond = (request) => run.bus.finish(request, "completed", 42, hostErrorSentinel);
      const answer = await run.call();
      assert.match(answer, /completion without a usable text answer, so the result was discarded/);
      assert.doesNotMatch(answer, /RAW-HOST-ERROR|provider\.invalid|private\/session/);
    } finally {
      await run.close();
    }
  }
});

test("fork fails closed without the public task normalizer and fresh still works", async () => {
  const run = await harness(base, models, 10_000, { forkTaskNormalizer: false });
  try {
    const forkAnswer = await run.call();
    assert.match(forkAnswer, /does not export wrapForkTask/);
    // A brief cannot switch this session to fresh, so the cause must not promise that fallback.
    assert.doesNotMatch(forkAnswer, /Call again with brief/);
    assert.match(forkAnswer, /install an admitted pi-subagents build/);
    assert.doesNotMatch(forkAnswer, /0\.76\.1/);
    assert.equal(run.bus.requests.length, 0);
    run.ctx.getContextUsage = () => ({ tokens: 60_000 });
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call({ question: sentinel, brief: sentinel }), new RegExp(sentinel));
    assert.deepEqual(
      [run.bus.requests[0]?.context, run.bus.requests[0]?.task],
      ["fresh", JSON.stringify({ question: sentinel, brief: sentinel })],
    );
  } finally {
    await run.close();
  }
});

test("preflight failures differ from an invalid contract and render safe causes", async () => {
  for (const [preflight, expected, rejected] of [
    ["throw", /preflight returned no launch contract/, /Reinstall this package/],
    ["undefined", /preflight returned no launch contract/, /Reinstall this package/],
    ["invalid", /launch contract was rejected/, /preflight returned no launch contract/],
  ] as const) {
    const run = await harness(base, models, 10_000, { preflight });
    try {
      const answer = await run.call();
      assert.match(answer, expected);
      assert.doesNotMatch(answer, rejected);
      assert.doesNotMatch(answer, /RAW-HOST-ERROR|provider\.invalid|private\/session/);
      assert.equal(run.bus.requests.length, 0);
    } finally {
      await run.close();
    }
  }
  const run = await harness();
  try {
    run.bus.failRequestEmit = true;
    const answer = await run.call();
    assert.match(answer, /host could not set up or send the Advisor launch event/);
    assert.doesNotMatch(answer, /RAW-HOST-ERROR|provider\.invalid|private\/session/);
    assert.equal(run.executor.busy, false);
  } finally {
    await run.close();
  }
});

test("a verified 0.83.1 contract admits the Advisor in fork and fresh and binds the fork digest", async () => {
  const run = await harness(base, models, 10_000, { fixtureVersion: "0.83.1" });
  try {
    // The synthetic host binds the wrapped fork task, exactly as the preflight did.
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /example\/first \[fork\]/);
    run.ctx.getContextUsage = () => ({ tokens: 60_000 });
    assert.match(
      await run.call({ question: sentinel, brief: sentinel }),
      /example\/first \[fresh\]/,
    );
    assert.deepEqual(
      run.bus.requests.map((request) => [request.context, request.model, request.thinking]),
      [
        ["fork", "example/first", "low"],
        ["fork", "example/second", "high"],
        ["fresh", "example/first", "low"],
        ["fresh", "example/second", "high"],
      ],
    );
  } finally {
    await run.close();
  }
});

test("stable pi-subagents releases at or above the minimum bind fork and fresh answers", async () => {
  for (const packageVersion of [
    "0.76.1",
    "0.82.0",
    "0.84.0",
    "0.100.0",
    "1.0.0",
    "10.0.0+build.01",
    "9007199254740993.0.0",
  ]) {
    const run = await harness(base, models, 10_000, { packageVersion });
    try {
      run.bus.respond = (request) => run.bus.finish(request);
      assert.match(await run.call(), new RegExp(sentinel), packageVersion);
      run.ctx.getContextUsage = () => ({ tokens: 60_000 });
      assert.match(await run.call(), new RegExp(sentinel), packageVersion);
      assert.deepEqual(
        run.bus.requests.map((request) => request.context),
        ["fork", "fork", "fresh", "fresh"],
      );
    } finally {
      await run.close();
    }
  }
});

test("old, prerelease and malformed pi-subagents versions are rejected before any request", async () => {
  for (const packageVersion of [
    "0.76.0",
    "0.9.99",
    "0.76.1-rc.1",
    "0.84.0-beta+build",
    "1.0.0-rc.1",
    "not-semver",
    "0.84",
    "v0.84.0",
    "01.0.0",
    "1.00.0",
    "1.0.01",
    "1.0.0+",
    "1.0.0+build..1",
    "1.0.0\n",
    " 1.0.0",
    "1.0.0 ",
    null,
    84,
    {},
    [],
  ]) {
    const run = await harness(base, models, 10_000, {
      fixtureVersion: "0.83.1",
      packageVersion,
    });
    try {
      assert.match(await run.call(), /launch contract was rejected/);
      assert.equal(run.bus.requests.length, 0);
    } finally {
      await run.close();
    }
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

for (const version of ["0.76.1", "0.83.1"] as const) {
  test(`provider-specific Advisor binds its own exact extension contract on ${version}`, async () => {
    for (const extra of [false, true]) {
      const modules = await fakeModules("valid", version);
      const original = modules.resolveSubagentLaunchContract;
      const bus = new Bus();
      bus.respond = (request) => bus.finish(request);
      const executor = new AdvisorExecutor({
        loader: async () => ({
          ...modules,
          resolveSubagentLaunchContract: async (input) => {
            const resolved = (await original(input)) as { contract: Payload };
            const contract = resolved.contract;
            contract.agent = {
              ...(contract.agent as Payload),
              name: ANTHROPIC_ADVISOR_AGENT,
              localName: ANTHROPIC_ADVISOR_AGENT,
              filePath: fileURLToPath(
                new URL(
                  "../agents/pi-delegation-policy.advisor-anthropic-auth.md",
                  import.meta.url,
                ),
              ),
            };
            const tools = contract.tools as Payload;
            tools.configuredExtensions = [
              ANTHROPIC_ADVISOR_EXTENSION,
              ...(extra ? ["unexpected-extension"] : []),
            ];
            tools.extensionArgs = [
              "prompt-runtime",
              ANTHROPIC_ADVISOR_EXTENSION,
              ...(extra ? ["unexpected-extension"] : []),
            ];
            return resolved;
          },
        }),
      });
      const [answer] = await executor.execute(
        [
          {
            question: "synthetic question",
            brief: "synthetic brief",
            context: "fresh",
            providerExtension: "anthropic-auth",
            model: { provider: "anthropic", id: "synthetic-model", thinking: "low" },
            availableModels: [
              { provider: "anthropic", id: "synthetic-model", fullId: "anthropic/synthetic-model" },
            ],
          },
        ],
        { cwd: "/synthetic", sessionId: "synthetic-session", events: bus },
        undefined,
        () => undefined,
      );
      assert.equal(answer?.result.kind, extra ? "unavailable" : "completed");
      assert.equal(bus.requests.length, extra ? 0 : 1);
      if (!extra) assert.equal(bus.requests[0]?.agent, ANTHROPIC_ADVISOR_AGENT);
      executor.close();
    }
  });
}

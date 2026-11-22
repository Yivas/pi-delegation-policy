import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdvisorExecutor, ADVISOR_AGENT_NAME, advisorAgentName } from "../src/advisor-executor.ts";
import {
  ANTHROPIC_ADVISOR_AGENT,
  ANTHROPIC_ADVISOR_EXTENSION,
} from "../src/advisor-anthropic-provider.ts";
import {
  PINNED_PACKAGE,
  PROVIDER_EXTENSION_ADVISOR_AGENT,
} from "../src/advisor-provider-extension.ts";
import { packageSource } from "../src/provider-package.ts";
import { AdvisorLog, ADVISOR_LOG_MAX_BYTES } from "../src/advisor-log.ts";
import {
  AdvisorJournalError,
  AdvisorThreadJournal,
  advisorParentKey,
  getAdvisorThreadsPath,
  readAdvisorAnswer,
  readAdvisorThreads,
  reserveAdvisorAnswer,
  upsertAdvisorThread,
  type AdvisorJournalExclusiveResult,
  type AdvisorJournalSession,
  type AdvisorThreadRecord,
} from "../src/advisor-threads.ts";
import { getLaunchCorrectionPath } from "../src/launch-correction-mode.ts";
import { ADVISOR_LEVEL_ENTRY_TYPE, getAdvisorLevelPath } from "../src/advisor-level.ts";
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
  restoreSessionStateWithDiagnostics,
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
import {
  appendGuardedSessionState as append0233,
  readConfig as read0233,
  restoreSessionStateWithDiagnostics as restore0233,
  writeConfig as write0233,
} from "./fixtures/v0.23.3/config.ts";

const first = { provider: "example", model: "first" };
const second = { provider: "example", model: "second" };
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
// The optional public fork wrapper `pi-subagents` exports. The Advisor never sends a fork, so the
// synthetic modules only have to prove that the extension still loads with and without it.
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
    input: { question?: string; brief?: string; evidence?: string },
    signal: AbortSignal | undefined,
    update: unknown,
    context: never,
  ) => Promise<{ content: Array<{ text: string }>; details?: Payload }>;
};

class Bus {
  listeners = new Map<string, Set<(payload: unknown) => void>>();
  requests: Payload[] = [];
  cancels: Payload[] = [];
  respond: ((payload: Payload) => void) | undefined;
  /** The task the host binds in its terminal contract; a different one cannot match the preflight. */
  bindTask: (task: string) => string = (task) => task;
  failRequestEmit = false;
  /** The host allocates one execution run id per admitted launch. */
  runSeq = 0;
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
    const boundTask = this.bindTask(task);
    this.runSeq += 1;
    this.emit(events.startedEvent, request);
    this.emit(events.responseEvent, {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      runId: `synthetic-run-${this.runSeq}`,
      status,
      agent: request.agent,
      model: `${request.model}:${request.thinking}`,
      thinking: request.thinking,
      launchContractDigest: launchTaskDigest(boundTask),
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
    activeTools?: string[];
    correctionMode?: "block";
    /** The companion's context mode; composing is the default, so `manual` has to be asked for. */
    contextMode?: "composed" | "manual";
    /**
     * Clear the documented `pi-subagents` child markers, so the harness behaves as a main session
     * even when the suite itself runs inside a child. Nothing else in the environment is touched.
     */
    mainProcess?: boolean;
    /** Shared journal so a test can gate or fail its writes. */
    journal?: AdvisorThreadJournal;
    directory?: string;
    sessionId?: string;
  } = {},
) {
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "advisor-tool-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const childMarkers = ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUNNER_PID"] as const;
  const savedMarkers = options.mainProcess
    ? childMarkers.map((key) => [key, process.env[key]] as const)
    : undefined;
  if (savedMarkers) for (const key of childMarkers) delete process.env[key];
  const path = getGlobalConfigPath(directory);
  await writeConfig(path, value);
  if (options.correctionMode)
    await writeFile(
      getLaunchCorrectionPath(path),
      `${JSON.stringify({ schemaVersion: 1, mode: options.correctionMode })}\n`,
    );
  if (options.contextMode === "manual")
    await writeFile(
      getAdvisorLevelPath(path),
      `${JSON.stringify({ schemaVersion: 1, context: "manual" })}\n`,
    );
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
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => options.sessionId ?? "synthetic-session",
    },
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
  const executor = new AdvisorExecutor({
    loader: async () => modules,
    ...(options.journal ? { journal: options.journal } : {}),
  });
  const logPath = join(directory, "events.jsonl");
  const log = new AdvisorLog(logPath);
  createPiDelegationPolicy({
    advisorExecutor: executor,
    advisorLog: log,
    ...(options.journal ? { advisorJournal: options.journal } : {}),
  })({
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
    getActiveTools: () => options.activeTools ?? ["subagent"],
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
  } as never);
  const hook = async (name: string, event: Payload = {}) =>
    handlers.get(name)?.(event as never, ctx as never);
  await hook("session_start");
  // A consultation belongs to an operative task, and only a public prompt opens one.
  await hook("input", { source: "interactive", text: "synthetic prompt" });
  await hook("before_agent_start");
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
    call: async (
      input: { question?: string; brief?: string; evidence?: string } = {
        question: sentinel,
        brief: sentinel,
      },
      signal?: AbortSignal,
    ) =>
      (await tools.get("consult_advisor")!.execute("id", input, signal, undefined, ctx as never))
        .content[0]!.text,
    callBoth: async (
      input: { question?: string; brief?: string; evidence?: string } = {
        question: sentinel,
        brief: sentinel,
      },
    ) => {
      const result = await tools
        .get("consult_advisor")!
        .execute("id", input, undefined, undefined, ctx as never);
      return { text: result.content[0]!.text, details: result.details as Payload };
    },
    // A new user prompt settles the previous task and opens another one, with a new thread.
    newTask: async () => {
      await hook("agent_settled");
      await hook("input", { source: "interactive", text: "synthetic prompt" });
      await hook("before_agent_start");
    },
    close: async () => {
      await hook("session_shutdown");
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      for (const [key, value] of savedMarkers ?? []) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      // Windows can delay directory removal even after the writer has drained.
      if (!options.directory)
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
/** Hold one real filesystem read, after its snapshot is obtained but before its caller resumes. */
function holdRead(matches: (path: string) => boolean) {
  const original = fs.readFile;
  let armed = true;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    const held = armed && matches(String(args[0]));
    if (held) armed = false;
    try {
      return await original(...args);
    } finally {
      if (held) {
        enter();
        await gate;
      }
    }
  }) as typeof fs.readFile;
  syncBuiltinESMExports();
  return {
    entered,
    release,
    restore: () => {
      release();
      fs.readFile = original;
      syncBuiltinESMExports();
    },
  };
}

const logEvents = async (path: string): Promise<Payload[]> =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Payload);

// Public boundary: schema parsing/effective state, saved files read by released parsers, and the
// registered tool/hooks against a synthetic delegation event host. No provider or credentials.
test("model commands keep the Advisor provider opt-in only for Anthropic models", async () => {
  const configured = {
    provider: "anthropic",
    model: "synthetic-one",
    providerExtension: "anthropic-auth" as const,
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
        // A single standard Advisor is restored in its legacy single-entry form.
        const saved = configuredAdvisors(restoreSessionState(run.branch))?.[0];
        assert.equal(`${saved?.provider}/${saved?.model}`, model);
        // The opt-in follows Anthropic models and is dropped for any other provider, as in the panel.
        const anthropic = model.startsWith("anthropic/");
        assert.equal(saved?.providerExtension, anthropic ? "anthropic-auth" : undefined);
        assert.equal(
          advisorAgentName(saved!),
          anthropic ? ANTHROPIC_ADVISOR_AGENT : ADVISOR_AGENT_NAME,
        );
      }
      await run.command("advisor on");
      const state = await loadRuntime(run.ctx as never);
      assert.equal(advisorStatusLabel(state), "A:ON");
      assert.equal(run.bus.requests.length, 0);
    } finally {
      await run.close();
    }
  }
  // A hand-edited save can still pair the opt-in with another provider; runtime rejects it.
  const mismatched = await harness(
    {
      ...base,
      advisors: [{ ...configured, provider: "example", model: "incompatible" }],
      advisorMode: "on",
    },
    available,
  );
  try {
    const state = await loadRuntime(mismatched.ctx as never);
    assert.equal(advisorStatusLabel(state), "A:ERR");
    assert.match(state.advisorErrors?.join(" ") ?? "", /requires provider anthropic/);
    assert.deepEqual(validAdvisors(state), []);
  } finally {
    await mismatched.close();
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

test("Advisor thinking commands explain that thinking is automatic without writing", async () => {
  const run = await harness();
  try {
    const before = structuredClone(run.branch);
    for (const input of ["advisor 1 thinking low high", "advisor 3 thinking high"]) {
      await run.command(input);
      assert.deepEqual(run.branch, before);
      assert.match(run.notifications.at(-1)?.message ?? "", /Advisor thinking is automatic/);
    }
  } finally {
    await run.close();
  }
});

test("Advisor 3 model commands fill the list in order and removing Advisor 2 moves Advisor 3 up", async () => {
  const third = { provider: "example", model: "third" };
  const run = await harness({ ...base, advisors: [first] });
  try {
    const before = structuredClone(run.branch);
    await run.command("advisor 3 model example/third");
    assert.deepEqual(run.branch, before, "Advisor 3 needs Advisor 2");
    assert.match(run.notifications.at(-1)?.message ?? "", /Configure Advisor 2 first/);
    await run.command("advisor 2 model example/second");
    await run.command("advisor 3 model example/third");
    assert.deepEqual((await loadRuntime(run.ctx as never)).effective.advisors, [
      first,
      second,
      third,
    ]);
    await run.command("advisor 2 model remove");
    assert.deepEqual((await loadRuntime(run.ctx as never)).effective.advisors, [first, third]);
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

/** The released reader keeps a lone standard Advisor in its legacy `advisor` field. */
function configuredAdvisorsOf(state: { advisor?: unknown; advisors?: unknown }) {
  return state.advisors ?? (state.advisor ? [state.advisor] : undefined);
}

test("three advisors round-trip, 0.23.3 falls back to Advisor 1, and its saves with thinking load whole", async () => {
  const third = {
    provider: "anthropic",
    model: "third",
    providerExtension: "anthropic-auth" as const,
  };
  const directory = await mkdtemp(join(tmpdir(), "advisor-three-"));
  try {
    const path = getGlobalConfigPath(directory);
    const branchOf = (
      write: (writer: { appendEntry: (t: string, d?: unknown) => void }) => void,
    ) => {
      const branch: unknown[] = [];
      write({
        appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
      });
      return branch;
    };
    // Lists the released reader already supports must still reach it whole, with no diagnostic.
    for (const advisors of [[first], [first, second], [first, third]]) {
      const state = { ...base, advisors };
      assert.equal(await writeConfig(path, state), "saved");
      const old = await read0233(path);
      assert.deepEqual(old.diagnostics, []);
      assert.deepEqual(configuredAdvisorsOf(old.defaults), advisors);
      const oldSession = restore0233(
        branchOf((writer) => appendGuardedSessionState(writer, state)),
      );
      assert.deepEqual(oldSession.diagnostics, []);
      assert.deepEqual(configuredAdvisorsOf(oldSession.session), advisors);
    }
    for (const advisors of [
      [first, second, { provider: "example", model: "third" }],
      [first, second, third],
    ]) {
      const state = { ...base, advisors };
      assert.equal(await writeConfig(path, state), "saved");
      const loaded = await readConfig(path);
      assert.deepEqual(loaded.diagnostics, []);
      assert.deepEqual(loaded.defaults.advisors, advisors);
      const branch = branchOf((writer) => appendGuardedSessionState(writer, state));
      assert.deepEqual(restoreSessionStateWithDiagnostics(branch).session.advisors, advisors);
      // The released reader rejects the third entry and never misreads the list.
      const old = await read0233(path);
      const oldSession = restore0233(branch);
      if ("providerExtension" in advisors[2]!) {
        assert.equal(old.defaults.advisorMode, "off");
        assert.equal(oldSession.session.advisorMode, "off");
      } else {
        assert.match(old.diagnostics[0]?.message ?? "", /Using Advisor 1 only/);
        assert.deepEqual(old.defaults.advisor, first);
        assert.equal(old.defaults.advisors, undefined);
        assert.deepEqual(oldSession.session.advisor, first);
        assert.equal(oldSession.session.advisors, undefined);
      }
    }
    // Saves from 0.23.3 that still carry Advisor thinking keep every Advisor without a diagnostic.
    for (const advisors of [
      [
        { ...first, thinking: { level: "low" } },
        { ...second, thinking: { min: "low", max: "high" } },
      ],
      [first, { ...third, thinking: { level: "high" } }],
    ]) {
      const legacy = { ...base, schemaVersion: 10, advisors };
      assert.equal(await write0233(path, legacy as never), "saved");
      const loaded = await readConfig(path);
      assert.deepEqual(loaded.diagnostics, []);
      const expected = advisors.map(({ provider, model, ...rest }) => ({
        provider,
        model,
        ...("providerExtension" in rest ? { providerExtension: rest.providerExtension } : {}),
      }));
      assert.deepEqual(loaded.defaults.advisors, expected);
      const restored = restoreSessionStateWithDiagnostics(
        branchOf((writer) => append0233(writer, legacy as never)),
      );
      assert.deepEqual(restored.diagnostics, []);
      assert.deepEqual(restored.session.advisors, expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("schema 9 preserves the first advisor on downgrade and isolates stale extension state", async () => {
  for (const bad of [
    [],
    [first, second, first, second],
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
    assert.equal(old.defaults.thinking?.advisor, undefined);
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
    assert.equal(restore020(branch).thinking?.advisor, undefined);
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
      assert.equal(effective.advisorLaunch, "tool");
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
        assert.match(
          payload.instructions,
          /Ask every listed Advisor the same question in one call/,
        );
        assert.match(payload.instructions, /agreement neither proof nor authority/);
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
      assert.match(answer, /^Not an error:/);
      assert.match(answer, /do not call this tool again while Advisor launch is "role"/);
      assert.match(answer, /host subagent tool "subagent"/);
      assert.match(
        answer,
        /in the background, all listed Advisors with the same question in one call/,
      );
      assert.match(answer, /agent profile: "pi-delegation-policy.advisor"/);
      assert.match(answer, /pi-subagents form: "example\/first:LEVEL"/);
      assert.match(answer, /unset \(choose per run\)/);
      assert.match(answer, /Replace LEVEL with a supported thinking level chosen per run\./);
      assert.doesNotMatch(answer, /fixed|range/);
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

test("role without an active subagent tool reports the limitation without improvising a launcher", async () => {
  const activeTools = ["subagent-helper", "bash"];
  const run = await harness({ ...base, advisorLaunch: "role" }, models, 10_000, { activeTools });
  try {
    assert.equal(
      await run.call(),
      'Not an error: Advisor launch is "role", so this tool does not launch Advisors; do not call this tool again while Advisor launch is "role". The host subagent tool "subagent" is not available. Tell the user that you cannot launch the Advisor with the available host tools. Do not improvise another mechanism: do not use foreground execution, a CLI, or another agent.',
    );
    activeTools.push("subagent");
    assert.match(await run.call(), /host subagent tool "subagent", using each exact agent profile/);
    activeTools.pop();
    assert.match(await run.call(), /Tell the user that you cannot launch the Advisor/);
    assert.equal(run.bus.requests.length, 0);
  } finally {
    await run.close();
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
  const run = await harness(base, models, 10_000, { contextMode: "manual" });
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
  // The second model offers no `high`, so automatic thinking steps down to the next supported level.
  const run = await harness(
    base,
    [models[0]!, { ...models[1]!, thinkingLevelMap: { high: null } } as (typeof models)[number]],
    10_000,
    { contextMode: "manual" },
  );
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
        ["example/first", "high", "fresh", JSON.stringify({ question: sentinel, brief: sentinel })],
        [
          "example/second",
          "medium",
          "fresh",
          JSON.stringify({ question: sentinel, brief: sentinel }),
        ],
      ],
    );
    assert.match(
      await run.call(),
      /Advisor busy:.*Wait for its result.*do not duplicate the pending group/,
    );
    run.bus.finish(run.bus.requests[1]!, "failed", sentinel, hostErrorSentinel);
    run.bus.finish(run.bus.requests[0]!);
    const answer = await call;
    assert.match(answer, /example\/first \[fresh\]/);
    assert.match(answer, new RegExp(sentinel));
    assert.match(
      answer,
      /example\/second \[fresh\]:\nThe host ended the Advisor run with status failed and supplied no safe detail/,
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
      // A host that binds another task reports a digest the preflight never saw.
      run.bus.bindTask = () => "a task the preflight never saw";
      run.bus.respond = (request) => run.bus.finish(request);
      const answer = await run.call();
      assert.match(
        answer,
        /example\/first \[fresh\]:\nThe host returned an Advisor reply whose launch contract digest did not match the preflight contract, so the reply was discarded/,
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

test("a build without the public fork wrapper still serves fresh consultations", async () => {
  const run = await harness(base, models, 10_000, {
    forkTaskNormalizer: false,
    contextMode: "manual",
  });
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), new RegExp(sentinel));
    // The Advisor never asks for a fork, so a missing fork wrapper cannot block it.
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

test("a verified 0.83.1 contract admits the Advisor in fresh context and binds its digest", async () => {
  const run = await harness(base, models, 10_000, { fixtureVersion: "0.83.1" });
  try {
    // The synthetic host binds the task the preflight saw, exactly as the preflight did.
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /example\/first \[fresh\]/);
    await run.newTask();
    assert.match(
      await run.call({ question: sentinel, brief: sentinel }),
      /example\/first \[fresh\]/,
    );
    assert.deepEqual(
      run.bus.requests.map((request) => [request.context, request.model, request.thinking]),
      [
        ["fresh", "example/first", "high"],
        ["fresh", "example/second", "high"],
        ["fresh", "example/first", "high"],
        ["fresh", "example/second", "high"],
      ],
    );
  } finally {
    await run.close();
  }
});

test("stable pi-subagents releases at or above the minimum bind fresh answers", async () => {
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
      await run.newTask();
      assert.match(await run.call(), new RegExp(sentinel), packageVersion);
      assert.deepEqual(
        run.bus.requests.map((request) => request.context),
        ["fresh", "fresh", "fresh", "fresh"],
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

test("no consultation asks the host for a fork, whatever the session uses", async () => {
  // Nothing is retried with a second context: an explicit host rejection ends the turn.
  for (const tokens of [10_000, 60_000, null, 90_000]) {
    const run = await harness(base, models, tokens as number | null, { contextMode: "manual" });
    try {
      run.bus.respond = (request) => run.bus.finish(request);
      assert.match(await run.call(), /example\/first \[fresh\]/);
      assert.deepEqual(
        run.bus.requests.map((request) => request.context),
        ["fresh", "fresh"],
        `usage ${String(tokens)}`,
      );
      for (const request of run.bus.requests) {
        assert.deepEqual(JSON.parse(request.task as string), {
          question: sentinel,
          brief: sentinel,
        });
      }
    } finally {
      await run.close();
    }
  }
  const rejected = await harness();
  try {
    rejected.bus.respond = (request) =>
      rejected.bus.emit(events.responseEvent, {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: "unavailable_context",
      });
    assert.match(
      await rejected.call(),
      /example\/first \[fresh\]:\nThe host could not supply the requested context/,
    );
    assert.equal(rejected.bus.requests.length, 2, "a rejected turn is never retried");
  } finally {
    await rejected.close();
  }
});

test("a first consultation requires a brief in fresh context", async () => {
  const fresh = await harness(base, models, 60_000, { contextMode: "manual" });
  try {
    assert.match(
      await fresh.call({ question: sentinel } as never),
      /a first consultation requires brief/,
    );
    assert.equal(fresh.bus.requests.length, 0);
    // A blank brief is not a brief either.
    assert.match(await fresh.call({ question: sentinel, brief: "  " }), /requires brief/);
    assert.equal(fresh.bus.requests.length, 0);
  } finally {
    await fresh.close();
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
            context: "fresh",
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
      { model: "example/first", status: "observed", context: "fresh", durationMs: 0 },
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

test("a task logs whether the first Advisor consult came before its first edit", async () => {
  const run = await harness({ ...base, advisorLaunch: "role" });
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    const call = (toolName: string, input: Payload = {}) =>
      run.hook("tool_call", { toolName, input });
    const consult = () =>
      call("subagent", { agent: ADVISOR_AGENT_NAME, model: "example/first:low", task: sentinel });
    const edit = () =>
      call("edit", { path: "/synthetic/file", oldText: sentinel, newText: sentinel });
    await run.hook("input", { source: "interactive" });
    await call("read", { path: "/synthetic/file" });
    // The shape the policy asks for: one parallel call, one task per Advisor.
    await call("subagent", {
      workflow: "parallel",
      args: { tasks: [{ agent: ADVISOR_AGENT_NAME, model: "example/first:low", task: sentinel }] },
    });
    await edit();
    await run.hook("agent_settled");
    await run.hook("input", { source: "interactive" });
    await edit();
    await consult();
    await run.hook("agent_settled");
    // An extension prompt opens no task, and a settle without one writes nothing.
    await run.hook("input", { source: "extension" });
    await run.hook("agent_settled");
    await run.log.flush();
    const text = await readFile(run.logPath, "utf8");
    assert.doesNotMatch(text, new RegExp(sentinel));
    assert.doesNotMatch(text, /synthetic/);
    const tasks = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "task");
    assert.equal(tasks.length, 2);
    assert.deepEqual(Object.keys(tasks[0]).sort(), [
      "advisorConsults",
      "advisorLevel",
      "consultBeforeFirstEdit",
      "durationMs",
      "edits",
      "event",
      "firstConsultIndex",
      "firstEditIndex",
      "launchRefusals",
      "mainModel",
      "policyHash",
      "subagentLaunches",
      "time",
      "toolCalls",
      "version",
    ]);
    // The task carries the hash of the policy block it ran under, as a consultation does.
    assert.match(tasks[0].policyHash, /^[0-9a-f]{64}$/);
    // Its only subagent call launches one Advisor, so it counts as a consult and not as a launch.
    assert.deepEqual(
      {
        toolCalls: tasks[0].toolCalls,
        edits: tasks[0].edits,
        firstEditIndex: tasks[0].firstEditIndex,
        advisorConsults: tasks[0].advisorConsults,
        firstConsultIndex: tasks[0].firstConsultIndex,
        consultBeforeFirstEdit: tasks[0].consultBeforeFirstEdit,
        subagentLaunches: tasks[0].subagentLaunches,
        launchRefusals: tasks[0].launchRefusals,
      },
      {
        toolCalls: 3,
        edits: 1,
        firstEditIndex: 2,
        advisorConsults: 1,
        firstConsultIndex: 1,
        consultBeforeFirstEdit: true,
        subagentLaunches: 0,
        launchRefusals: 0,
      },
    );
    assert.equal(typeof tasks[0].durationMs, "number");
    assert.ok(tasks[0].durationMs >= 0);
    assert.equal(tasks[1].firstEditIndex, 0);
    assert.equal(tasks[1].firstConsultIndex, 1);
    assert.equal(tasks[1].consultBeforeFirstEdit, false);
  } finally {
    await run.close();
  }
});

test("launch events record an outcome, a closed code and role codes only", async () => {
  const run = await harness({
    ...base,
    intensity: "normal",
    small: first,
    medium: null,
    large: null,
    advisors: [second],
  });
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    const launch = (input: Payload) => run.hook("tool_call", { toolName: "subagent", input });
    assert.equal(
      await launch({ agent: "worker", model: "example/first:low", task: sentinel }),
      undefined,
    );
    assert.equal(
      await launch({ agent: ADVISOR_AGENT_NAME, model: "example/second:low", task: sentinel }),
      undefined,
    );
    const refused = (await launch({
      agent: "worker",
      model: "other/elsewhere:low",
      task: sentinel,
    })) as {
      block: boolean;
      reason: string;
    };
    assert.equal(refused.block, true);
    assert.match(refused.reason, /not the model of any enabled role/);
    await run.log.flush();
    const text = await readFile(run.logPath, "utf8");
    assert.doesNotMatch(text, new RegExp(sentinel));
    const launches = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "launch");
    assert.equal(launches.length, 3);
    assert.deepEqual(Object.keys(launches[0]).sort(), [
      "children",
      "corrections",
      "event",
      "outcome",
      "policyHash",
      "reason",
      "roles",
      "time",
      "version",
    ]);
    assert.deepEqual(
      launches.map((event) => [
        event.outcome,
        event.reason,
        event.children,
        event.roles,
        event.corrections,
      ]),
      [
        ["allowed", null, 1, ["small"], []],
        ["allowed", null, 1, ["advisor"], []],
        ["refused", "wrong-model", 1, ["unknown"], []],
      ],
    );
  } finally {
    await run.close();
  }
});

test("the launch check corrects an unambiguous call before the executor receives it", async () => {
  const run = await harness({
    ...base,
    intensity: "normal",
    small: first,
    medium: null,
    large: null,
    advisors: [second],
  });
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    // The host validates the arguments before `tool_call` and runs the object it validated, so the
    // object this hook leaves behind is what the executor receives.
    const single = { agent: "worker", model: "small", task: sentinel };
    assert.equal(
      await run.hook("tool_call", { toolName: "subagent", toolCallId: "call-1", input: single }),
      undefined,
    );
    assert.equal(single.model, "example/first:medium");

    const parallel = {
      workflow: "parallel",
      model: "small",
      args: {
        tasks: [
          { agent: "a", task: sentinel },
          { agent: "b", task: sentinel },
        ],
      },
    };
    assert.equal(
      await run.hook("tool_call", { toolName: "subagent", toolCallId: "call-2", input: parallel }),
      undefined,
    );
    assert.equal(parallel.model, "example/first:medium");

    const chain = {
      chain: [
        { agent: "a", task: sentinel, model: "example/first" },
        { parallel: [{ agent: "b", task: sentinel, model: "example/second:low" }] },
      ],
    };
    assert.equal(
      await run.hook("tool_call", { toolName: "subagent", toolCallId: "call-3", input: chain }),
      undefined,
    );
    assert.deepEqual(chain.chain, [
      { agent: "a", task: sentinel, model: "example/first:medium" },
      { parallel: [{ agent: ADVISOR_AGENT_NAME, task: sentinel, model: "example/second:low" }] },
    ]);

    // The note travels with the tool result of the corrected call, so the agent can see what ran.
    const result = (await run.hook("tool_result", {
      toolName: "subagent",
      toolCallId: "call-1",
      input: single,
      content: [{ type: "text", text: "child output" }],
      details: undefined,
      isError: false,
    })) as { content: Array<{ type: string; text: string }> };
    assert.equal(result.content[0]?.text, "child output");
    assert.match(result.content.at(-1)?.text ?? "", /corrected this subagent call before it ran/);
    assert.match(result.content.at(-1)?.text ?? "", /example\/first:medium/);

    await run.log.flush();
    const launches = (await logEvents(run.logPath)).filter((event) => event.event === "launch");
    assert.deepEqual(
      launches.map((event) => event.corrections),
      [["role-alias"], ["role-alias"], ["level-added", "advisor-profile"]],
    );
    // The log stays content-free: closed codes and counts, never a model or a task.
    assert.doesNotMatch(JSON.stringify(launches), /example\/first|example\/second/);
    assert.doesNotMatch(await readFile(run.logPath, "utf8"), new RegExp(sentinel));
  } finally {
    await run.close();
  }
});

test("block mode refuses an unambiguous call and leaves it exactly as stated", async () => {
  const run = await harness(
    { ...base, intensity: "normal", small: first, medium: null, large: null, advisors: [second] },
    models,
    10_000,
    { correctionMode: "block" },
  );
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    const input = { agent: "worker", model: "small", task: sentinel };
    const blocked = (await run.hook("tool_call", {
      toolName: "subagent",
      toolCallId: "call-1",
      input,
    })) as { block: boolean; reason: string };
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /not the model of any enabled role/);
    assert.deepEqual(input, { agent: "worker", model: "small", task: sentinel });
    await run.log.flush();
    const launches = (await logEvents(run.logPath)).filter((event) => event.event === "launch");
    assert.deepEqual(
      launches.map((event) => [event.outcome, event.reason, event.corrections]),
      [["refused", "wrong-model", []]],
    );
  } finally {
    await run.close();
  }
});

test("every corrected call keeps its note while its result is pending", async () => {
  const run = await harness({
    ...base,
    intensity: "normal",
    small: first,
    medium: null,
    large: null,
    advisors: [second],
  });
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    // The host prepares every call of a batch before running any of them, so all of these notes are
    // pending at once. A fixed cap would drop the first ones.
    const calls = Array.from({ length: 33 }, (_, index) => ({
      toolCallId: `call-${index}`,
      input: { agent: "worker", model: "small", task: sentinel },
    }));
    for (const { toolCallId, input } of calls)
      assert.equal(
        await run.hook("tool_call", { toolName: "subagent", toolCallId, input }),
        undefined,
      );
    // Results arrive in a different order than the calls were prepared.
    for (const { toolCallId, input } of [...calls].reverse()) {
      const result = (await run.hook("tool_result", {
        toolName: "subagent",
        toolCallId,
        input,
        content: [{ type: "text", text: "child output" }],
        details: undefined,
        isError: false,
      })) as { content: Array<{ type: string; text: string }> };
      assert.equal(result.content[0]?.text, "child output", toolCallId);
      assert.match(result.content.at(-1)?.text ?? "", /corrected this subagent call/, toolCallId);
    }
  } finally {
    await run.close();
  }
});

test("a refused Advisor launch counts as a refusal, never as a consult", async () => {
  const run = await harness({ ...base, advisorLaunch: "role" });
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    await run.hook("input", { source: "interactive" });
    const refused = (await run.hook("tool_call", {
      toolName: "subagent",
      input: { agent: ADVISOR_AGENT_NAME, model: "example/elsewhere:low", task: sentinel },
    })) as { block: boolean; reason: string };
    assert.equal(refused.block, true);
    assert.match(refused.reason, /not a configured Advisor/);
    await run.hook("agent_settled");
    await run.log.flush();
    const events = await logEvents(run.logPath);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(sentinel));
    const task = events.find((event) => event.event === "task");
    assert.deepEqual(
      {
        advisorConsults: task?.advisorConsults,
        firstConsultIndex: task?.firstConsultIndex,
        subagentLaunches: task?.subagentLaunches,
        launchRefusals: task?.launchRefusals,
      },
      { advisorConsults: 0, firstConsultIndex: null, subagentLaunches: 0, launchRefusals: 1 },
    );
  } finally {
    await run.close();
  }
});

test("a call that launches an Advisor and a worker counts as both", async () => {
  const run = await harness({
    ...base,
    intensity: "normal",
    small: first,
    medium: null,
    large: null,
    advisors: [second],
    advisorLaunch: "role",
  });
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    await run.hook("input", { source: "interactive" });
    assert.equal(
      await run.hook("tool_call", {
        toolName: "subagent",
        input: {
          workflow: "parallel",
          args: {
            tasks: [
              { agent: ADVISOR_AGENT_NAME, model: "example/second:low", task: sentinel },
              { agent: "worker", model: "example/first:low", task: sentinel },
            ],
          },
        },
      }),
      undefined,
    );
    await run.hook("agent_settled");
    await run.log.flush();
    const events = await logEvents(run.logPath);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(sentinel));
    const launch = events.find((event) => event.event === "launch");
    assert.deepEqual(launch?.roles, ["advisor", "small"]);
    const task = events.find((event) => event.event === "task");
    assert.deepEqual(
      {
        advisorConsults: task?.advisorConsults,
        firstConsultIndex: task?.firstConsultIndex,
        subagentLaunches: task?.subagentLaunches,
        launchRefusals: task?.launchRefusals,
      },
      { advisorConsults: 1, firstConsultIndex: 0, subagentLaunches: 1, launchRefusals: 0 },
    );
  } finally {
    await run.close();
  }
});

test("a control action is neither counted as a launch nor recorded", async () => {
  const run = await harness({
    ...base,
    intensity: "normal",
    small: first,
    medium: null,
    large: null,
  });
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    await run.hook("input", { source: "interactive" });
    assert.equal(
      await run.hook("tool_call", { toolName: "subagent", input: { action: "status", id: "run" } }),
      undefined,
    );
    assert.equal(
      await run.hook("tool_call", {
        toolName: "subagent",
        input: { agent: "worker", model: "example/first:low", task: sentinel },
      }),
      undefined,
    );
    await run.hook("agent_settled");
    await run.log.flush();
    const events = await logEvents(run.logPath);
    const launches = events.filter((event) => event.event === "launch");
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0]?.roles, ["small"]);
    const task = events.find((event) => event.event === "task");
    assert.equal(task?.toolCalls, 2);
    assert.equal(task?.subagentLaunches, 1);
    assert.equal(task?.launchRefusals, 0);
  } finally {
    await run.close();
  }
});

test("a control action that names an Advisor neither consults nor records a consultation", async () => {
  const run = await harness({ ...base, advisorLaunch: "role" });
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    await run.hook("input", { source: "interactive" });
    // The host runs a control action, so naming an Advisor profile targets it without launching.
    assert.equal(
      await run.hook("tool_call", {
        toolName: "subagent",
        input: { action: "status", agent: ADVISOR_AGENT_NAME },
      }),
      undefined,
    );
    await run.hook("agent_settled");
    await run.log.flush();
    const events = await logEvents(run.logPath);
    assert.deepEqual(
      events.filter((event) => event.event === "launch" || event.event === "consultation"),
      [],
    );
    const task = events.find((event) => event.event === "task");
    assert.deepEqual(
      {
        advisorConsults: task?.advisorConsults,
        firstConsultIndex: task?.firstConsultIndex,
        subagentLaunches: task?.subagentLaunches,
        launchRefusals: task?.launchRefusals,
      },
      { advisorConsults: 0, firstConsultIndex: null, subagentLaunches: 0, launchRefusals: 0 },
    );
  } finally {
    await run.close();
  }
});

test("a steer keeps the task already open instead of restarting it", async () => {
  const run = await harness({ ...base, advisorLaunch: "role" });
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    await run.hook("input", { source: "interactive" });
    await run.hook("tool_call", { toolName: "read", input: { path: "/synthetic/file" } });
    // The host emits `input` for a steer before the message it queues.
    await run.hook("input", { source: "interactive" });
    await run.hook("tool_call", { toolName: "read", input: { path: "/synthetic/file" } });
    await run.hook("agent_settled");
    await run.log.flush();
    const tasks = (await logEvents(run.logPath)).filter((event) => event.event === "task");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.toolCalls, 2);
  } finally {
    await run.close();
  }
});

test("a branch move drops the task that was in flight", async () => {
  const run = await harness({ ...base, advisorLaunch: "role" });
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    await run.hook("input", { source: "interactive" });
    await run.hook("tool_call", { toolName: "read", input: { path: "/synthetic/file" } });
    await run.hook("session_tree");
    await run.hook("agent_settled");
    await run.log.flush();
    const events = await logEvents(run.logPath);
    assert.equal(events.filter((event) => event.event === "task").length, 0);
  } finally {
    await run.close();
  }
});

test("a shutdown mid-task writes no task", async () => {
  const run = await harness({ ...base, advisorLaunch: "role" });
  try {
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    await run.hook("input", { source: "interactive" });
    await run.hook("tool_call", { toolName: "read", input: { path: "/synthetic/file" } });
    await run.hook("session_shutdown");
    await run.hook("agent_settled");
    await run.log.flush();
    const events = await logEvents(run.logPath);
    assert.equal(events.filter((event) => event.event === "task").length, 0);
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
  const directory = await mkdtemp(join(tmpdir(), "advisor-timeout-"));
  const executor = new AdvisorExecutor({
    journal: new AdvisorThreadJournal(join(directory, "threads.json")),
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
    {
      slots: ["first", "second"].map((id, slot) => ({
        kind: "launch" as const,
        slot,
        model: `example/${id}`,
        fingerprint: {
          provider: "example",
          model: id,
          thinking: "high",
          profile: ADVISOR_AGENT_NAME,
          admission: "",
          packageVersion: "0.27.0",
          epoch: 0,
        },
        request: {
          question: sentinel,
          brief: sentinel,
          model: { provider: "example", id, thinking: "high" },
          availableModels: [{ provider: "example", id, fullId: `example/${id}`, reasoning: true }],
        },
      })),
      consult: { question: sentinel },
      task: { parentKey: "a".repeat(64), taskToken: "synthetic-task-0001" },
    },
    { cwd: "/synthetic", sessionId: "synthetic", events: bus },
    undefined,
    () => undefined,
  );
  await until(() => bus.requests.length === 2);
  for (const timer of timers.filter((timer) => timer.live && timer.delay === 120_000))
    timer.callback();
  const timedOut = await pending;
  assert.deepEqual(
    timedOut.slots.map((slot) => slot.status),
    ["blocked", "blocked"],
  );
  assert.equal(timedOut.summary, "blocked");
  assert.match(timedOut.slots[0]?.detail ?? "", /did not reply within 120 seconds/);
  assert.equal(bus.cancels.length, 2);
  assert.ok(timers.every((timer) => !timer.live));
  executor.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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

const PROVIDER_PROFILES = [
  {
    providerExtension: "anthropic-auth" as const,
    agent: ANTHROPIC_ADVISOR_AGENT,
    file: "../agents/pi-delegation-policy.advisor-anthropic-auth.md",
    extension: ANTHROPIC_ADVISOR_EXTENSION,
    provider: "anthropic",
  },
  {
    providerExtension: "admitted" as const,
    agent: PROVIDER_EXTENSION_ADVISOR_AGENT,
    file: "../agents/pi-delegation-policy.advisor-provider-extension.md",
    // The packaged profile pins the admitted package, so the host reports that source rather than
    // an extension path of its own.
    extension: packageSource(PINNED_PACKAGE),
    provider: "example-provider",
  },
];
for (const version of ["0.76.1", "0.83.1"] as const) {
  test(`provider-specific Advisor binds its own exact extension contract on ${version}`, async () => {
    for (const [profile, extra] of PROVIDER_PROFILES.flatMap((entry) => [
      [entry, false] as const,
      [entry, true] as const,
    ])) {
      const modules = await fakeModules("valid", version);
      const original = modules.resolveSubagentLaunchContract;
      const bus = new Bus();
      bus.respond = (request) => bus.finish(request);
      const directory = await mkdtemp(join(tmpdir(), "advisor-profile-"));
      const executor = new AdvisorExecutor({
        journal: new AdvisorThreadJournal(join(directory, "threads.json")),
        loader: async () => ({
          ...modules,
          resolveSubagentLaunchContract: async (input) => {
            const resolved = (await original(input)) as { contract: Payload };
            const contract = resolved.contract;
            contract.agent = {
              ...(contract.agent as Payload),
              name: profile.agent,
              localName: profile.agent,
              filePath: fileURLToPath(new URL(profile.file, import.meta.url)),
            };
            const tools = contract.tools as Payload;
            tools.configuredExtensions = [
              profile.extension,
              ...(extra ? ["unexpected-extension"] : []),
            ];
            tools.extensionArgs = [
              "prompt-runtime",
              profile.extension,
              ...(extra ? ["unexpected-extension"] : []),
            ];
            return resolved;
          },
        }),
      });
      const group = await executor.execute(
        {
          slots: [
            {
              kind: "launch",
              slot: 0,
              model: `${profile.provider}/synthetic-model`,
              fingerprint: {
                provider: profile.provider,
                model: "synthetic-model",
                thinking: "low",
                profile: profile.agent,
                admission: "",
                packageVersion: "0.27.0",
                epoch: 0,
              },
              request: {
                question: "synthetic question",
                brief: "synthetic brief",
                context: "fresh",
                providerExtension: profile.providerExtension,
                model: { provider: profile.provider, id: "synthetic-model", thinking: "low" },
                availableModels: [
                  {
                    provider: profile.provider,
                    id: "synthetic-model",
                    fullId: `${profile.provider}/synthetic-model`,
                  },
                ],
              },
            },
          ],
          consult: {
            question: "synthetic question",
            brief: "synthetic brief",
          },
          task: { parentKey: "b".repeat(64), taskToken: "synthetic-task-0002" },
        },
        { cwd: "/synthetic", sessionId: "synthetic-session", events: bus },
        undefined,
        () => undefined,
      );
      const answer = group.slots[0];
      assert.equal(answer?.status, extra ? "unavailable" : "complete");
      assert.equal(bus.requests.length, extra ? 0 : 1);
      if (!extra) assert.equal(bus.requests[0]?.agent, profile.agent);
      executor.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Advisor continuity: the public boundary for a second turn, the private journal and the RPC.
// ---------------------------------------------------------------------------------------------

type RpcRequest = { version: number; requestId: string; method: string; params: Payload };

/** The per-turn answer directory names its slot, which is all a synthetic host needs to answer. */
function slotOfOutput(output: string): number {
  // The operation directory is `<slot>-<ordinal>`; the task token above it is opaque.
  const directory = output.slice(0, Math.max(0, output.lastIndexOf("answer.md")));
  const name =
    directory
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  return Number(name.split("-")[0]);
}

/**
 * A synthetic `pi-subagents` RPC bridge: it answers `ping`, revives a thread with a new run id,
 * writes the per-turn output file the way a real host does, and reports the snapshot status.
 */
class RpcHost {
  requests: RpcRequest[] = [];
  resumes: Payload[] = [];
  stops: string[] = [];
  sessionId = "synthetic-session";
  agent = ADVISOR_AGENT_NAME;
  thinking = "high";
  answer: (slot: number) => string | undefined = (slot) => `answer-${slot}`;
  state: (slot: number) => "complete" | "running" | "failed" = () => "complete";
  model: (slot: number) => string = (slot) =>
    `example/${["first", "second", "third"][slot] ?? "first"}`;
  /** The receipt the host returns for a revival; a test can drop it or make it unusable. */
  receipt: (slot: number, runId: string) => Payload = (_slot, runId) => ({ runId });
  /** Opens the exact window between sending a request and receiving its reply. */
  beforeReply?: (method: string) => Promise<void>;
  private readonly runs = new Map<string, number>();
  private seq = 0;
  private readonly bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
    bus.on("subagents:rpc:v1:request", (payload) => void this.handle(payload as RpcRequest));
  }

  private reply(requestId: string, data: Payload): void {
    this.bus.emit(`subagents:rpc:v1:reply:${requestId}`, {
      version: 1,
      requestId,
      success: true,
      data,
    });
  }

  private async handle(request: RpcRequest): Promise<void> {
    this.requests.push(request);
    const params = (request.params ?? {}) as Payload;
    if (this.beforeReply) await this.beforeReply(request.method);
    if (request.method === "ping")
      return this.reply(request.requestId, {
        version: 1,
        capabilities: { resume: true },
        events: { asyncComplete: "subagent:async-complete" },
        session: { sessionId: this.sessionId },
      });
    if (request.method === "resume") {
      this.resumes.push(params);
      const slot = slotOfOutput(String(params.output));
      this.seq += 1;
      const runId = `resume-run-${this.seq}`;
      this.runs.set(runId, slot);
      const text = this.answer(slot);
      if (text !== undefined) await writeFile(String(params.output), text, "utf8");
      return this.reply(request.requestId, { text: "", details: this.receipt(slot, runId) });
    }
    if (request.method === "status") {
      const runId = String(params.id);
      const slot = this.runs.get(runId);
      if (slot === undefined) return this.reply(request.requestId, { text: "" });
      const state = this.state(slot);
      const step = {
        id: runId,
        kind: "step",
        label: "advisor",
        state: state === "complete" ? "complete" : state === "failed" ? "failed" : "running",
        agent: this.agent,
        model: this.model(slot),
        thinking: this.thinking,
      };
      return this.reply(request.requestId, {
        text: "",
        details: { mode: "single", results: [] },
        asyncSnapshot: {
          kind: "pi-subagents.async-status-snapshot",
          version: 1,
          runs: [{ id: runId, kind: "subagent", label: "advisor", state, children: [step] }],
        },
      });
    }
    if (request.method === "stop") {
      this.stops.push(String(params.id));
      return this.reply(request.requestId, { text: "stopping" });
    }
    return this.reply(request.requestId, { text: "" });
  }
}

const journalThreads = (value: unknown): Payload[] =>
  Object.values((value as { parents: Record<string, { threads: Payload[] }> }).parents).flatMap(
    (parent) => parent.threads,
  );

test("a second turn resumes the exact new run id and returns its own file", async () => {
  const run = await harness();
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /example\/first \[fresh\]/);
    assert.equal(rpc.requests.length, 0, "the first turn is a launch, never a resume");

    const answer = await run.call({ question: "second question", evidence: "new evidence" });
    assert.match(answer, /example\/first \[fresh\]:\nanswer-0/);
    assert.match(answer, /example\/second \[fresh\]:\nanswer-1/);
    assert.match(answer, /Consultation complete: 2 of 2 advisors answered/);

    // One resume per slot, addressed to the run id the first turn returned, with its own file.
    assert.deepEqual(
      rpc.resumes.map((params) => [params.id, params.outputMode, "model" in params]).sort(),
      [
        ["synthetic-run-1", "file-only", false],
        ["synthetic-run-2", "file-only", false],
      ],
    );
    const outputs = rpc.resumes.map((params) => String(params.output));
    assert.equal(new Set(outputs).size, 2);
    assert.ok(outputs.every((output) => output.startsWith(run.path.slice(0, -5))));
    const firstResume = rpc.resumes.find((params) => params.id === "synthetic-run-1");
    assert.match(String(firstResume?.message), /second question[\s\S]*new evidence/);

    // Status is queried by the new run id of this turn, never by the previous one.
    assert.deepEqual(
      [
        ...new Set(
          rpc.requests
            .filter((request) => request.method === "status")
            .map((request) => String(request.params?.id)),
        ),
      ].sort(),
      ["resume-run-1", "resume-run-2"],
    );

    // The journal keeps metadata only, and the second turn extends the same chain.
    const journal = await readFile(getAdvisorThreadsPath(), "utf8");
    assert.doesNotMatch(journal, new RegExp(sentinel));
    assert.doesNotMatch(journal, /second question|new evidence|answer-0|answer-1/);
    assert.deepEqual(
      journalThreads(JSON.parse(journal))
        .map((record) => [record.slot, record.state, (record.runIds as string[]).length])
        .sort(),
      [
        [0, "answered", 2],
        [1, "answered", 2],
      ],
    );
    // The local log stays content-free across both turns.
    await run.hook("before_provider_request", {
      payload: { instructions: "host" },
    });
    await run.log.flush();
    const log = await readFile(run.logPath, "utf8");
    assert.doesNotMatch(log, new RegExp(sentinel));
    assert.doesNotMatch(log, /second question|new evidence|answer-0|answer-1/);
  } finally {
    await run.close();
  }
});

test("a completed turn without a usable answer blocks the parent until the host proves it", async () => {
  const run = await harness();
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /Consultation complete/);
    rpc.answer = () => undefined;
    assert.match(await run.call({ question: "second question" }), /wrote no answer file/);

    // No retry inside the task, and no fresh launch behind the block.
    const requests = run.bus.requests.length;
    const resumes = rpc.resumes.length;
    assert.match(
      await run.call({ question: "third question" }),
      /an earlier turn may still be running/,
    );
    assert.equal(run.bus.requests.length, requests);
    assert.equal(rpc.resumes.length, resumes);

    // The uncertainty survives the end of the task and an explicit reset.
    await run.newTask();
    assert.match(await run.call(), /an earlier turn may still be running/);
    await run.command("advisor threads reset");
    assert.match(run.notifications.at(-1)?.message ?? "", /reset changed nothing/);

    // Public terminal proof reconciles it, and the next consultation starts a new thread.
    await run.command("advisor threads recover");
    assert.match(run.notifications.at(-1)?.message ?? "", /proven, closed/);
    assert.match(await run.call(), /Consultation complete/);
    assert.equal(run.bus.requests.length, requests + 2);
  } finally {
    await run.close();
  }
});

test("three configured slots keep their positions and two answers are partial", async () => {
  const third = { provider: "example", model: "third" };
  const run = await harness({ ...base, advisors: [first, second, third] });
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    const { text: answer, details } = await run.callBoth();
    const consultation = details.advisorConsultation as Payload;
    assert.equal(consultation.summary, "partial");
    assert.deepEqual(
      (consultation.slots as Payload[]).map((slot) => [slot.slot, slot.status, slot.model]),
      [
        [0, "complete", "example/first"],
        [1, "complete", "example/second"],
        [2, "unavailable", "example/third"],
      ],
    );
    assert.match(answer, /example\/third \[unknown\]:\nAdvisor 3 model is not registered in Pi\./);
    assert.match(answer, /Consultation partial: 2 of 3 advisors answered/);
  } finally {
    await run.close();
  }
});

test("the journal keeps every parent and every slot under concurrent writers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-journal-"));
  const path = join(directory, "threads.json");
  const journal = new AdvisorThreadJournal(path);
  const parentA = "a".repeat(64);
  const parentB = "b".repeat(64);
  const parentC = "c".repeat(64);
  const parentD = "d".repeat(64);
  const record = (slot: number, taskToken: string, state: "pending" | "closed" = "pending") => ({
    slot,
    taskToken,
    fingerprint: {
      provider: "example",
      model: `m${slot}`,
      thinking: "high",
      profile: ADVISOR_AGENT_NAME,
      admission: "",
      packageVersion: "0.27.0",
      epoch: 0,
    },
    state,
    ordinal: 1,
    runIds: [],
    updatedAt: 1,
  });
  const read = async () =>
    JSON.parse(await readFile(path, "utf8")) as {
      parents: Record<string, { threads: Payload[] }>;
    };
  try {
    // Two parents interleave: neither write may carry the other parent's stale entries.
    await journal.exclusive(parentA, async (session) => {
      await session.mutate((latest) => upsertAdvisorThread(latest, record(0, "task-aaaa-0001"), 2));
    });
    await journal.exclusive(parentB, async (session) => {
      await session.mutate((latest) => upsertAdvisorThread(latest, record(0, "task-bbbb-0001"), 3));
    });
    await journal.exclusive(parentA, async (session) => {
      await session.mutate((latest) => upsertAdvisorThread(latest, record(1, "task-aaaa-0001"), 4));
    });
    const both = await read();
    assert.deepEqual(
      Object.entries(both.parents)
        .map(([key, parent]) => [key, parent.threads.map((thread) => thread.slot).sort()])
        .sort(),
      [
        [parentA, [0, 1]],
        [parentB, [0]],
      ],
    );

    // Three slots of one group commit concurrently: every record survives on disk.
    const group = await journal.exclusive(parentC, async (session) => {
      await Promise.all(
        [0, 1, 2].map((slot) =>
          session.mutate((latest) =>
            upsertAdvisorThread(latest, record(slot, "task-cccc-0001"), 5),
          ),
        ),
      );
      return session
        .partition()
        .threads.map((thread) => thread.slot)
        .sort();
    });
    assert.deepEqual(group, { ok: true, value: [0, 1, 2] });
    assert.deepEqual(
      (await read()).parents[parentC]?.threads.map((thread) => thread.slot).sort(),
      [0, 1, 2],
    );

    // A second instance cannot take a parent another one still owns.
    const held = await journal.exclusive(parentC, async () =>
      new AdvisorThreadJournal(path).exclusive(parentC, async () => "unreachable"),
    );
    assert.deepEqual(held, { ok: true, value: { ok: false, code: "journal-busy" } });

    // An unresolved record is never evicted to make room for new ones.
    const bounded = await journal.exclusive(parentD, async (session) => {
      for (let slot = 0; slot < 30; slot += 1)
        await session.mutate((latest) =>
          upsertAdvisorThread(
            latest,
            record(
              slot,
              `task-dddd-${String(slot).padStart(4, "0")}`,
              slot === 0 ? "pending" : "closed",
            ),
            6 + slot,
          ),
        );
      const threads = session.partition().threads;
      return {
        count: threads.length,
        unresolved: threads.filter((thread) => thread.state === "pending").length,
      };
    });
    assert.ok(bounded.ok);
    if (bounded.ok) {
      assert.equal(bounded.value.unresolved, 1);
      assert.ok(bounded.value.count <= 24, `bounded journal kept ${bounded.value.count} records`);
    }
    assert.equal(
      (await read()).parents[parentD]?.threads.length,
      bounded.ok ? bounded.value.count : -1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("a configuration change fences a turn that is still running", async () => {
  const run = await harness();
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /Consultation complete/);
    rpc.state = () => "running";
    const pending = run.call({ question: "second question" });
    await until(() => rpc.resumes.length === 2);
    await run.command("advisor off");
    const answer = await pending;
    assert.match(answer, /Advisor cancelled before replying/);
    assert.doesNotMatch(answer, /answer-0|answer-1/);
    assert.ok(rpc.stops.length >= 1, "the fenced turn asks the host to stop its own run");
  } finally {
    await run.close();
  }
});

test("role mode launches nothing, and a run without an operative task fails closed", async () => {
  const role = await harness({ ...base, advisorLaunch: "role" });
  try {
    assert.match(await role.call(), /Advisor launch is "role"/);
    assert.equal(role.bus.requests.length, 0);
    await assert.rejects(readFile(getAdvisorThreadsPath()), { code: "ENOENT" });
  } finally {
    await role.close();
  }
  // An extension-only run opens no operative task, so a consultation starts nothing.
  const extension = await harness();
  try {
    extension.bus.respond = (request) => extension.bus.finish(request);
    await extension.hook("agent_settled");
    await extension.hook("input", { source: "extension", text: "internal" });
    await extension.hook("before_agent_start");
    assert.match(await extension.call(), /this run has no operative task/);
    assert.equal(extension.bus.requests.length, 0);
  } finally {
    await extension.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Review corrections: current-operation recovery, fencing windows, lock reclamation, resolved
// identity, closing barriers, brief scope and canonical confinement.
// ---------------------------------------------------------------------------------------------

function journalRecord(
  slot: number,
  taskToken: string,
  state: AdvisorThreadRecord["state"] = "pending",
): AdvisorThreadRecord {
  return {
    slot,
    taskToken,
    fingerprint: {
      provider: "example",
      model: `m${slot}`,
      thinking: "high",
      profile: ADVISOR_AGENT_NAME,
      admission: "",
      packageVersion: "0.27.0",
      epoch: 0,
    },
    state,
    ordinal: 1,
    runIds: [],
    updatedAt: 1,
  };
}

/** A journal whose writes can be held or refused, to open the exact windows under review. */
class GatedJournal extends AdvisorThreadJournal {
  failNext = 0;
  /** Refuse the write that would persist `accepted` for this turn ordinal. */
  failAcceptedOrdinal = 0;
  onHold?: () => void;
  private gate: Promise<void> | undefined;
  private releaseGate: (() => void) | undefined;

  holdNext(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate?.();
    this.releaseGate = undefined;
    this.gate = undefined;
  }

  override async exclusive<Value>(
    parentKey: string,
    run: (session: AdvisorJournalSession) => Promise<Value>,
  ): Promise<AdvisorJournalExclusiveResult<Value>> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { ok: false, code: "journal-write-failed" };
    }
    const gate = this.gate;
    return super.exclusive(parentKey, async (session) =>
      run({
        ...session,
        mutate: async (update) => {
          // The update is pure, so previewing it identifies the exact transition to refuse.
          if (this.failAcceptedOrdinal > 0) {
            const preview = update(session.partition());
            const refused = preview.threads.some(
              (record) =>
                record.state === "accepted" && record.ordinal === this.failAcceptedOrdinal,
            );
            if (refused) throw new AdvisorJournalError("journal-write-failed");
          }
          if (gate) {
            this.onHold?.();
            await gate;
          }
          return session.mutate(update);
        },
      }),
    );
  }
}

const answeredSlots = async (path = getAdvisorThreadsPath()): Promise<Payload[]> => {
  const loaded = JSON.parse(await readFile(path, "utf8")) as {
    parents: Record<string, { threads: Payload[] }>;
  };
  return Object.values(loaded.parents).flatMap((parent) => parent.threads);
};

test("a lost receipt blocks recovery instead of proving the previous turn", async () => {
  const run = await harness();
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /Consultation complete/);
    assert.match(await run.call({ question: "second" }), /answer-0/);
    // The host accepts the third turn but returns no usable receipt.
    rpc.receipt = () => ({});
    assert.match(await run.call({ question: "third" }), /without a usable run id/);

    // The previous turn is complete in the public snapshot, yet it proves nothing about this one.
    await run.command("advisor threads recover");
    const recovered = run.notifications.at(-1)?.message ?? "";
    assert.match(recovered, /no receipt for the current turn/);
    assert.match(recovered, /stays blocked/);

    const requests = run.bus.requests.length;
    const resumes = rpc.resumes.length;
    await run.newTask();
    assert.match(await run.call(), /an earlier turn may still be running/);
    assert.equal(run.bus.requests.length, requests);
    assert.equal(rpc.resumes.length, resumes);
    await run.command("advisor threads reset");
    assert.match(run.notifications.at(-1)?.message ?? "", /reset changed nothing/);
  } finally {
    await run.close();
  }
});

test("a receipt that cannot be persisted blocks the parent with no current operation id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-accepted-"));
  const journal = new GatedJournal(join(directory, "threads.json"));
  const run = await harness(base, models, 10_000, { journal });
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /Consultation complete/);
    // The receipt is accepted by the host but never reaches the journal.
    journal.failAcceptedOrdinal = 2;
    assert.match(await run.call({ question: "second" }), /journal could not be written/);
    assert.equal(rpc.resumes.length, 2, "the host accepted the turn before the write failed");
    const records = await answeredSlots(journal.filePath);
    const record = records.find((entry) => entry.slot === 0);
    assert.equal(record?.state, "pending", JSON.stringify(records));
    assert.equal(record?.operationRunId, undefined, JSON.stringify(records));
    // Recovery cannot prove it, and a new task does not unlock generation.
    await run.command("advisor threads recover");
    assert.match(run.notifications.at(-1)?.message ?? "", /no receipt for the current turn/);
    const requests = run.bus.requests.length;
    await run.newTask();
    assert.match(await run.call(), /an earlier turn may still be running/);
    assert.equal(run.bus.requests.length, requests);
  } finally {
    await run.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("a revocation during the pending write stops the launch before it is emitted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-fence-pending-"));
  const journal = new GatedJournal(join(directory, "threads.json"));
  const run = await harness(base, models, 10_000, { journal });
  try {
    const held = new Promise<void>((resolve) => {
      journal.onHold = resolve;
    });
    journal.holdNext();
    const pending = run.call();
    await held;
    await run.command("advisor off");
    journal.release();
    assert.match(await pending, /Advisor cancelled before replying/);
    assert.equal(run.bus.requests.length, 0);
  } finally {
    await run.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("a revocation during the probe stops the resume before it is sent", async () => {
  const run = await harness();
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /Consultation complete/);
    let releasePing!: () => void;
    const pingHeld = new Promise<void>((resolve) => {
      rpc.beforeReply = async (method) => {
        if (method !== "ping") return;
        resolve();
        await new Promise<void>((release) => {
          releasePing = release;
        });
      };
    });
    const pending = run.call({ question: "second" });
    await pingHeld;
    await run.command("advisor off");
    releasePing();
    assert.match(await pending, /Advisor cancelled before replying/);
    assert.equal(rpc.resumes.length, 0);
  } finally {
    await run.close();
  }
});

test("a revocation while another slot is pending discards an already answered slot", async () => {
  const run = await harness();
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /Consultation complete/);
    rpc.state = (slot) => (slot === 0 ? "complete" : "running");
    const pending = run.call({ question: "second" });
    const deadline = Date.now() + 5_000;
    let answered = false;
    while (!answered && Date.now() < deadline) {
      answered = (await answeredSlots(run.path.replace(/\.json$/, ".advisor-threads.json"))).some(
        (record) => record.slot === 0 && record.state === "answered" && record.ordinal === 2,
      );
      if (!answered) await new Promise((tick) => setTimeout(tick, 10));
    }
    assert.ok(answered, "slot 1 should have been answered before the revocation");
    await run.command("advisor off");
    const answer = await pending;
    assert.doesNotMatch(answer, /answer-0/);
    assert.match(answer, /Advisor cancelled before replying/);
  } finally {
    await run.close();
  }
});

test("concurrent recoverers cannot delete a lock another one just acquired", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-reclaim-"));
  const path = join(directory, "threads.json");
  const parentKey = "e".repeat(64);
  const lockDir = join(`${path}.lock`, parentKey);
  // A stale group lock whose recorded owner is provably gone.
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "owner.json"),
    `${JSON.stringify({ owner: "dead-owner", pid: 999_999, startedAt: 1 })}\n`,
  );
  const onlyDeadIsFinished = (owner: { owner: string }) => owner.owner === "dead-owner";
  // The winner pauses between claiming the reclamation gate and publishing its owner, which is the
  // window a delayed recoverer must respect. `publishOwner` is the constructor seam the journal
  // already exposes for that publication; production is unchanged.
  let releasePublish!: () => void;
  let gateClaimed!: () => void;
  const claimed = new Promise<void>((resolve) => {
    gateClaimed = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    releasePublish = resolve;
  });
  const first = new AdvisorThreadJournal(path, {
    ownerFinished: onlyDeadIsFinished,
    publishOwner: async (ownerPath, text) => {
      if (ownerPath.includes(".reclaim.lock")) {
        gateClaimed();
        await paused;
      }
      await writeFile(ownerPath, text, "utf8");
    },
  });
  const second = new AdvisorThreadJournal(path, { ownerFinished: onlyDeadIsFinished });
  let winner: Promise<string> | undefined;
  try {
    // A stale read taken before the gate proves nothing: the removal is decided by the fresh read
    // inside it, and the loser of the gate never touches anything.
    const staleRead = await first.lockState(parentKey);
    assert.equal(staleRead.kind, "held");

    // The winner holds the gate with its owner unpublished. A second recoverer must fail closed
    // instead of deleting or replacing that gate, and the stale victim must still be there.
    winner = first.releaseStaleLock(parentKey);
    await claimed;
    assert.equal(await second.releaseStaleLock(parentKey), "gate-stale");
    assert.equal((await second.lockState(parentKey)).kind, "held");
    assert.deepEqual(
      (await readdir(directory)).filter((entry) => entry.includes(".stale-")),
      [],
    );

    // Once the owner is published the winner reclaims the victim: the gate and the lock are free
    // and no tomb is left behind.
    releasePublish();
    assert.equal(await winner, "released");
    assert.equal(await first.gateState(), "free");
    assert.equal((await first.lockState(parentKey)).kind, "free");
    assert.deepEqual(
      (await readdir(directory)).filter((entry) => entry.includes(".stale-")),
      [],
    );
    assert.deepEqual(
      (await readdir(`${path}.lock`)).filter((entry) => entry.includes(".stale-")),
      [],
    );
    // Releasing an already free lock is the documented idempotent answer, not a second removal.
    assert.equal(await second.releaseStaleLock(parentKey), "released");

    // A lock a live writer holds is never removed, even by a concurrent recoverer.
    const held = await first.exclusive(parentKey, async (session) => {
      await session.mutate((latest) =>
        upsertAdvisorThread(latest, journalRecord(0, "task-eeee-0001"), 2),
      );
      return second.releaseStaleLock(parentKey);
    });
    assert.deepEqual(held, { ok: true, value: "busy" });
    const after = await second.exclusive(parentKey, async (session) =>
      session.partition().threads.map((record) => record.slot),
    );
    assert.deepEqual(after, { ok: true, value: [0] });
  } finally {
    // Never leave the paused publication or a pending reclamation behind, even on a failed check.
    releasePublish();
    await winner?.catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("an orphan or stale reclamation gate is never reclaimed automatically", async () => {
  for (const kind of ["ownerless", "stale"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `advisor-gate-${kind}-`));
    const path = join(directory, "threads.json");
    const gate = `${path}.reclaim.lock`;
    await mkdir(gate, { recursive: true });
    if (kind === "stale")
      await writeFile(
        join(gate, "owner.json"),
        `${JSON.stringify({ owner: "dead-gate", pid: 999_999, startedAt: 1 })}\n`,
      );
    // A stale commit lock forces the reclaim path, which is the only path that takes the gate.
    await mkdir(`${path}.commit.lock`, { recursive: true });
    await writeFile(
      join(`${path}.commit.lock`, "owner.json"),
      `${JSON.stringify({ owner: "dead-commit", pid: 999_999, startedAt: 1 })}\n`,
    );
    const journal = new AdvisorThreadJournal(path, {
      ownerFinished: (owner) => owner.owner === "dead-gate" || owner.owner === "dead-commit",
    });
    try {
      assert.equal(await journal.gateState(), kind === "stale" ? "stale" : "ownerless");
      const result = await journal.exclusive("a".repeat(64), async (session) => {
        await session.mutate((latest) =>
          upsertAdvisorThread(latest, journalRecord(0, "task-aaaa-0003"), 2),
        );
        return "ran";
      });
      assert.deepEqual(result, { ok: false, code: "journal-gate-stale" });
      // No write reached the journal behind the unreclaimed gate.
      assert.deepEqual((await readAdvisorThreads(path)).file.parents, {});
      assert.equal(await journal.releaseStaleLock("a".repeat(64)), "gate-stale");
      // The gate is left exactly as found: same directory, same owner record, no tomb.
      assert.equal(await journal.gateState(), kind === "stale" ? "stale" : "ownerless");
      assert.deepEqual(
        (await readdir(directory)).filter((entry) => entry.includes(".stale-")),
        [],
      );
      assert.equal(
        kind === "stale" ? await readFile(join(gate, "owner.json"), "utf8") : "",
        kind === "stale"
          ? `${JSON.stringify({ owner: "dead-gate", pid: 999_999, startedAt: 1 })}\n`
          : "",
      );
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
});

test("an unpublished owner aborts the lock instead of entering the critical section", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-publish-"));
  const path = join(directory, "threads.json");
  try {
    const journal = new AdvisorThreadJournal(path, {
      publishOwner: async () => {
        throw new Error("owner record unavailable");
      },
    });
    let entered = 0;
    const result = await journal.exclusive("a".repeat(64), async () => {
      entered += 1;
      return "ran";
    });
    assert.deepEqual(result, { ok: false, code: "journal-write-failed" });
    assert.equal(entered, 0);
    // The unpublished claim was released, so a working instance can take the lock afterwards.
    const working = new AdvisorThreadJournal(path);
    const after = await working.exclusive("a".repeat(64), async () => "ran");
    assert.deepEqual(after, { ok: true, value: "ran" });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("a failed publication never releases a later claim of the same journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-publish-overlap-"));
  const path = join(directory, "threads.json");
  const parentKey = "a".repeat(64);
  const lockDir = join(`${path}.lock`, parentKey);
  const originalRm = fs.rm;
  let removalHeld = false;
  let releaseRemoval!: () => void;
  let removed!: () => void;
  const claimRemoved = new Promise<void>((resolve) => {
    removed = resolve;
  });
  const removalGate = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  let enteredSecond!: () => void;
  let releaseSecond!: () => void;
  const secondEntered = new Promise<void>((resolve) => {
    enteredSecond = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let failPublication = true;
  const journal = new AdvisorThreadJournal(path, {
    publishOwner: async (ownerPath, text) => {
      if (failPublication) {
        failPublication = false;
        throw new Error("synthetic owner publication failure");
      }
      await writeFile(ownerPath, text, "utf8");
    },
  });
  let first: ReturnType<typeof journal.exclusive> | undefined;
  let second: ReturnType<typeof journal.exclusive> | undefined;
  try {
    fs.rm = (async (...args: Parameters<typeof fs.rm>) => {
      const hold = !removalHeld && String(args[0]) === lockDir;
      if (hold) removalHeld = true;
      await originalRm(...args);
      if (hold) {
        removed();
        await removalGate;
      }
    }) as typeof fs.rm;
    syncBuiltinESMExports();
    first = journal.exclusive(parentKey, async () => "first callback must not run");
    await claimRemoved;
    // The first claim is gone, but its failure path has not returned yet. The same instance
    // publishes a second claim and keeps owning its critical section throughout the assertions.
    second = journal.exclusive(parentKey, async () => {
      enteredSecond();
      await secondGate;
      return "second";
    });
    await secondEntered;
    releaseRemoval();
    assert.deepEqual(await first, { ok: false, code: "journal-write-failed" });
    const lockWhileSecondHeld = await journal.lockState(parentKey);
    const third = await new AdvisorThreadJournal(path).exclusive(parentKey, async () => "ENTERED");
    assert.deepEqual(
      third,
      { ok: false, code: "journal-busy" },
      `lock was ${lockWhileSecondHeld.kind}`,
    );
    assert.equal(lockWhileSecondHeld.kind, "held");
    releaseSecond();
    assert.deepEqual(await second, { ok: true, value: "second" });
    assert.deepEqual(await journal.lockState(parentKey), { kind: "free" });
  } finally {
    releaseRemoval();
    releaseSecond();
    await Promise.allSettled([first, second]);
    fs.rm = originalRm;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("a contender never touches a gate another instance is still publishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-gate-window-"));
  const path = join(directory, "threads.json");
  const commitLock = `${path}.commit.lock`;
  // A stale commit lock forces the reclaim path, which is where the gate is taken.
  await mkdir(commitLock, { recursive: true });
  await writeFile(
    join(commitLock, "owner.json"),
    `${JSON.stringify({ owner: "dead-commit", pid: 999_999, startedAt: 1 })}\n`,
  );
  let releasePublish!: () => void;
  let gateClaimed!: () => void;
  const claimed = new Promise<void>((resolve) => {
    gateClaimed = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    releasePublish = resolve;
  });
  const first = new AdvisorThreadJournal(path, {
    ownerFinished: (owner) => owner.owner === "dead-commit",
    publishOwner: async (ownerPath, text) => {
      if (ownerPath.includes(".reclaim.lock")) {
        gateClaimed();
        await paused;
      }
      await writeFile(ownerPath, text, "utf8");
    },
  });
  const second = new AdvisorThreadJournal(path);
  try {
    const firstRun = first.exclusive("a".repeat(64), async (session) => {
      await session.mutate((latest) =>
        upsertAdvisorThread(latest, journalRecord(0, "task-aaaa-0002"), 2),
      );
      return "first";
    });
    await claimed;
    // The gate exists but its owner is not published yet: the contender must not touch it.
    const blocked = await second.exclusive("b".repeat(64), async (session) => {
      await session.mutate((latest) =>
        upsertAdvisorThread(latest, journalRecord(0, "task-bbbb-0002"), 2),
      );
      return "second";
    });
    assert.deepEqual(blocked, { ok: false, code: "journal-gate-stale" });
    assert.equal(await second.gateState(), "ownerless");
    assert.deepEqual((await readAdvisorThreads(path)).file.parents["b".repeat(64)], undefined);
    releasePublish();
    assert.deepEqual(await firstRun, { ok: true, value: "first" });
    assert.equal(await first.gateState(), "free");
    // The commit lock was reclaimed through the tomb, so a later writer succeeds.
    const after = await second.exclusive("b".repeat(64), async () => "second");
    assert.deepEqual(after, { ok: true, value: "second" });
  } finally {
    releasePublish();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("a resolved thinking change fences a turn that is still running", async () => {
  const available: Array<(typeof models)[number]> = models.map((entry) => ({ ...entry }));
  const run = await harness(base, available);
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /Consultation complete/);
    rpc.state = () => "running";
    const pending = run.call({ question: "second" });
    await until(() => rpc.resumes.length === 2);
    // Same provider and model, but the registry now resolves a different thinking level: the slot
    // identity differs even though no configured setting changed.
    const replaced = { ...available[0]!, thinkingLevelMap: { high: null } };
    available[0] = replaced as (typeof models)[number];
    await run.hook("before_provider_request", { payload: { instructions: "host" } });
    const answer = await pending;
    assert.match(answer, /Advisor cancelled before replying/);
    assert.doesNotMatch(answer, /answer-0/);
  } finally {
    await run.close();
  }
});

test("a task whose closing tombstones fail stays blocked until reconciliation", async () => {
  for (const mode of ["busy", "write"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `advisor-close-${mode}-`));
    const path = join(directory, "threads.json");
    const journal = new GatedJournal(path);
    const run = await harness(base, models, 10_000, { journal });
    const rpc = new RpcHost(run.bus);
    try {
      run.bus.respond = (request) => run.bus.finish(request);
      assert.match(await run.call(), /Consultation complete/);
      if (mode === "busy") {
        // Another instance owns the parent lock while the task settles.
        const blocker = new AdvisorThreadJournal(path);
        let releaseHold!: () => void;
        const hold = new Promise<void>((resolve) => {
          releaseHold = resolve;
        });
        const acquired = new Promise<void>((resolve) => {
          void blocker.exclusive(advisorParentKey("synthetic-session"), async () => {
            resolve();
            await hold;
          });
        });
        await acquired;
        await run.hook("agent_settled");
        releaseHold();
        await new Promise((tick) => setTimeout(tick, 20));
      } else {
        journal.failNext = 1;
        await run.hook("agent_settled");
      }
      assert.match(run.notifications.at(-1)?.message ?? "", /closing state could not be persisted/);
      // The task is retired even when its durable closing obligation remains.
      const requests = run.bus.requests.length;
      assert.match(await run.call(), /no operative task/);
      assert.equal(run.bus.requests.length, requests);
      await run.hook("input", { source: "interactive" });
      await run.hook("before_agent_start");
      assert.match(await run.call(), /closing state of an earlier task could not be persisted/);
      await run.command("advisor threads recover");
      assert.match(run.notifications.at(-1)?.message ?? "", /closed/);
      assert.ok((await answeredSlots(path)).every((record) => record.state === "closed"));
      const resumes = rpc.resumes.length;
      assert.match(
        await run.call({ question: "again", brief: "new task" }),
        /Consultation complete/,
      );
      assert.equal(rpc.resumes.length, resumes, "a settled task is never resumed");
      assert.equal(run.bus.requests.length, requests + 2);
    } finally {
      await run.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
});

test("a consultation with no arguments sends the host-composed context to every Advisor", async () => {
  const run = await harness(base, models, 10_000, { mainProcess: true });
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    await run.hook("tool_call", {
      toolName: "read",
      toolCallId: "call-read",
      input: { path: "/synthetic/file.ts" },
    });
    await run.hook("tool_call", {
      toolName: "bash",
      toolCallId: "call-bash",
      input: { command: "npm test -- --secret-argument" },
    });
    await run.hook("tool_result", {
      toolName: "bash",
      toolCallId: "call-bash",
      input: {},
      content: [{ type: "text", text: sentinel }],
      isError: true,
    });
    assert.match(await run.call({}), /Consultation complete/);
    assert.equal(run.bus.requests.length, 2);
    for (const request of run.bus.requests) {
      const task = JSON.parse(request.task as string) as Payload;
      assert.deepEqual(Object.keys(task).sort(), ["brief", "question"]);
      assert.match(String(task.brief), /<host_note-[0-9a-f]{16}>/);
      assert.match(String(task.brief), /synthetic prompt/);
      assert.match(String(task.brief), /npm test: error/);
      assert.doesNotMatch(String(task.brief), /secret-argument/);
      assert.doesNotMatch(String(task.brief), new RegExp(sentinel));
      assert.match(String(task.question), /Review the agent's current approach/);
    }
  } finally {
    await run.close();
  }
});

test("a second consultation continues the thread with only what changed", async () => {
  const run = await harness(base, models, 10_000, { mainProcess: true });
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call({}), /Consultation complete/);
    await run.hook("tool_call", {
      toolName: "read",
      toolCallId: "call-next",
      input: { path: "/synthetic/after.ts" },
    });
    assert.match(await run.call({ evidence: "the same test failed again" }), /answer-0/);
    assert.equal(rpc.resumes.length, 2);
    const message = String(rpc.resumes[0]?.message);
    assert.match(message, /Evidence since the last consultation:/);
    assert.match(message, /\/synthetic\/after\.ts/);
    assert.match(message, /the same test failed again/);
    assert.doesNotMatch(message, /synthetic prompt/);
  } finally {
    await run.close();
  }
});

test("an agent question, brief and evidence keep their own tagged sections", async () => {
  const run = await harness();
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(
      await run.call({
        question: "Is the cache the right place?",
        brief: "Keep the change small.",
        evidence: "the loader throws",
      }),
      /Consultation complete/,
    );
    const task = JSON.parse(run.bus.requests[0]?.task as string) as Payload;
    assert.equal(task.question, "Is the cache the right place?");
    assert.match(String(task.brief), /source="agent"/);
    assert.match(String(task.brief), /note="written by the main agent, unverified"/);
    assert.match(String(task.brief), /Keep the change small\./);
    assert.match(String(task.brief), /the loader throws/);
  } finally {
    await run.close();
  }
});

test("manual context keeps the question and the brief contract", async () => {
  const run = await harness(base, models, 10_000, { contextMode: "manual" });
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    // The refusal is the executor's own text, with nothing appended to it.
    const refused = await run.call({ question: "why" });
    assert.match(refused, /a first consultation requires brief\./);
    assert.doesNotMatch(refused, /Supply a self-contained brief/);
    // The manual contract travels in the tool description instead.
    assert.match(
      run.tools.get("consult_advisor")!.description,
      /With \/delegate advisor context manual, pass question and, on a first consultation, a self-contained brief\.$/,
    );
    assert.equal(run.bus.requests.length, 0);
    assert.match(await run.call({ question: sentinel, brief: sentinel }), /Consultation complete/);
    assert.deepEqual(JSON.parse(run.bus.requests[0]?.task as string), {
      question: sentinel,
      brief: sentinel,
    });
  } finally {
    await run.close();
  }
});

test("an assistant message from an earlier task never reaches the advisor", async () => {
  const run = await harness(base, models, 10_000, { mainProcess: true });
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    // The transcript of a session carries the previous task too; only what the agent said after the
    // prompt that opened this task belongs to it.
    await run.hook("context_with_system", {
      type: "context_with_system",
      messages: [
        { role: "system", content: "host prompt", timestamp: 1 },
        { role: "user", content: "the earlier task", timestamp: 2 },
        {
          role: "assistant",
          content: [{ type: "text", text: "EARLIER-TASK-STATEMENT" }],
          timestamp: 3,
        },
        { role: "user", content: "synthetic prompt", timestamp: 4 },
        {
          role: "assistant",
          content: [{ type: "text", text: "CURRENT-TASK-STATEMENT" }],
          timestamp: 5,
        },
      ],
    });
    assert.match(await run.call({}), /Consultation complete/);
    const task = JSON.parse(run.bus.requests[0]?.task as string) as Payload;
    assert.match(String(task.brief), /CURRENT-TASK-STATEMENT/);
    assert.doesNotMatch(String(task.brief), /EARLIER-TASK-STATEMENT/);
    assert.doesNotMatch(String(task.brief), /the earlier task/);
  } finally {
    await run.close();
  }
});

test("a composed consultation caps the agent's question before it leaves", async () => {
  const run = await harness(base, models, 10_000, { mainProcess: true });
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call({ question: "q".repeat(10 * 1024) }), /Consultation complete/);
    const task = JSON.parse(run.bus.requests[0]?.task as string) as Payload;
    const asked = String(task.question);
    assert.ok(Buffer.byteLength(asked, "utf8") <= 2048, `${Buffer.byteLength(asked)} bytes`);
    assert.match(asked, /\[truncated\]$/);
    // The brief the child reads carries that same capped value, not the whole question.
    assert.ok(String(task.brief).includes(asked.slice(0, -" [truncated]".length)));
  } finally {
    await run.close();
  }
});

test("a session change drops the previous request instead of carrying it", async () => {
  const run = await harness(base, models, 10_000, { mainProcess: true });
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    const earlier = "earlier request text ".repeat(20);
    await run.hook("agent_settled");
    await run.hook("input", { source: "interactive", text: earlier });
    await run.hook("before_agent_start");
    await run.hook("agent_settled");
    await run.hook("session_start");
    await run.hook("input", { source: "interactive", text: "short request" });
    await run.hook("before_agent_start");
    assert.match(await run.call({}), /Consultation complete/);
    const task = JSON.parse(run.bus.requests[0]?.task as string) as Payload;
    assert.match(String(task.brief), /short request/);
    assert.doesNotMatch(String(task.brief), /earlier request text/);
  } finally {
    await run.close();
  }
});

const HELD_EDIT = {
  path: "src/held.ts",
  edits: [
    { oldText: "a", newText: Array.from({ length: 41 }, (_, line) => `line ${line}`).join("\n") },
  ],
};

async function strictRun(): Promise<Awaited<ReturnType<typeof harness>>> {
  // A tool-launch consultation is only possible while both launchers are active, and the checkpoint
  // refuses nothing when one is not.
  const run = await harness(base, models, 10_000, {
    mainProcess: true,
    activeTools: ["subagent", "consult_advisor"],
  });
  await writeFile(
    getAdvisorLevelPath(run.path),
    `${JSON.stringify({ schemaVersion: 1, level: "strict" })}\n`,
  );
  await run.newTask();
  return run;
}

test("a change held back by the checkpoint travels in the next composed consultation", async () => {
  const run = await strictRun();
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    const refused = await run.hook("tool_call", {
      toolName: "edit",
      toolCallId: "call-held",
      input: HELD_EDIT,
    });
    assert.equal((refused as { block?: boolean }).block, true);
    assert.match(await run.call({}), /Consultation complete/);
    const task = JSON.parse(run.bus.requests[0]?.task as string) as Payload;
    assert.match(String(task.brief), /<pending_change-[0-9a-f]{16}>/);
    assert.match(String(task.brief), /edit src\/held\.ts \(41 lines\)/);
    // The held change is carried once, so the follow-up does not repeat it.
    assert.match(await run.call({}), /answer-0/);
    assert.equal(rpc.resumes.length, 2);
    assert.doesNotMatch(String(rpc.resumes[0]?.message), /held\.ts/);
  } finally {
    await run.close();
  }
});

test("the checkpoint refuses nothing without a task and while an Advisor is in flight", async () => {
  const run = await strictRun();
  try {
    // No operative task: there is nothing to hold back.
    await run.hook("agent_settled");
    assert.equal(
      await run.hook("tool_call", {
        toolName: "edit",
        toolCallId: "call-closed",
        input: HELD_EDIT,
      }),
      undefined,
    );
    // A consultation already in flight is not an opportunity to consult, so nothing is refused.
    await run.newTask();
    const pending = run.call({});
    const first = await Promise.race([
      until(() => run.bus.requests.length === 2).then(() => "requested"),
      pending.then((answer) => `answered: ${answer}`),
    ]);
    assert.equal(first, "requested");
    assert.equal(
      await run.hook("tool_call", { toolName: "edit", toolCallId: "call-busy", input: HELD_EDIT }),
      undefined,
    );
    for (const request of run.bus.requests) run.bus.finish(request);
    assert.match(await pending, /Consultation complete/);
  } finally {
    await run.close();
  }
});

test("a composed consultation records its shape and never its content", async () => {
  const run = await harness({ ...base, advisors: [first] });
  try {
    // A consultation is only logged after the policy block it ran under has been logged.
    await run.hook("before_provider_request", {
      payload: { model: "example", stream: true, store: false, instructions: "host" },
    });
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call({}), /Consultation complete/);
    await run.log.flush();
    const consultation = (await logEvents(run.logPath)).find(
      (event) => event.event === "consultation",
    );
    assert.equal(consultation?.noArgs, true);
    assert.equal(consultation?.mainModel, null);
    assert.equal(consultation?.advisorLevel, "standard");
    assert.ok(Number(consultation?.contextBytes) > 0);
    const text = await readFile(run.logPath, "utf8");
    assert.doesNotMatch(text, /synthetic prompt|host_note|agent_messages/);
  } finally {
    await run.close();
  }
});

test("level and context commands store their setting and report its source", async () => {
  const run = await harness();
  const levelPath = getAdvisorLevelPath(run.path);
  try {
    await run.command("advisor level strict");
    assert.deepEqual(run.branch.at(-1), {
      type: "custom",
      customType: ADVISOR_LEVEL_ENTRY_TYPE,
      data: { schemaVersion: 1, level: "strict" },
    });
    assert.match(run.notifications.at(-1)?.message ?? "", /Advisor level: strict \(session\)/);

    await run.command("advisor level global off");
    assert.equal(JSON.parse(await readFile(levelPath, "utf8")).level, "off");
    assert.match(run.notifications.at(-1)?.message ?? "", /Advisor level: strict \(session\)/);

    // Removing the session entry lets the stored global level apply.
    await run.command("advisor level default");
    assert.match(run.notifications.at(-1)?.message ?? "", /Advisor level: off \(global\)/);

    // This host names no main model, so a model level is refused before anything is written.
    await run.command("advisor level model strict");
    assert.match(run.notifications.at(-1)?.message ?? "", /main model cannot be named/);
    assert.equal(JSON.parse(await readFile(levelPath, "utf8")).models, undefined);

    (run.ctx as { model?: unknown }).model = { provider: "example", id: "first", name: "first" };
    await run.command("advisor level model strict");
    assert.deepEqual(JSON.parse(await readFile(levelPath, "utf8")).models, {
      "example/first": "strict",
    });

    await run.command("advisor context manual");
    assert.equal(JSON.parse(await readFile(levelPath, "utf8")).context, "manual");

    await run.command("status");
    const status = run.notifications.at(-1)?.message ?? "";
    assert.match(status, /advisor-level=strict \(model\)/);
    assert.match(status, /advisor-context=manual/);
    assert.match(status, /main-model=example\/first/);

    // An unreadable companion is reported and left exactly as it is.
    await writeFile(levelPath, "{ broken");
    await run.command("advisor context composed");
    assert.match(run.notifications.at(-1)?.message ?? "", /Could not read .*advisor-level\.json/);
    assert.equal(await readFile(levelPath, "utf8"), "{ broken");
  } finally {
    await run.close();
  }
});

test("a continuation needs no new brief, and only a first consultation requires one", async () => {
  const run = await harness(base, models, 10_000, { contextMode: "manual" });
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /\[fresh\]/);
    assert.match(await run.call({ question: "second question" }), /answer-0/);
    assert.equal(rpc.resumes.length, 2);
    // A first launch still fails closed without a brief.
    await run.newTask();
    assert.match(await run.call({ question: "third" }), /a first consultation requires brief/);
  } finally {
    await run.close();
  }
});

test("an answer path under a linked parent directory is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-confine-"));
  const root = join(directory, "output");
  const outside = join(directory, "outside");
  const parentKey = "f".repeat(64);
  try {
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    // A pre-existing link where the operation directory would live.
    await symlink(
      outside,
      join(root, parentKey),
      process.platform === "win32" ? "junction" : "dir",
    );
    const answerPath = join(root, parentKey, "task-ffff-0001", "0-2", "answer.md");
    assert.equal(await reserveAdvisorAnswer(answerPath, dirname(answerPath), root), "outside");
    await mkdir(dirname(answerPath), { recursive: true });
    await writeFile(answerPath, "linked answer", "utf8");
    assert.deepEqual(await readAdvisorAnswer(answerPath, dirname(answerPath), root), {
      ok: false,
      code: "answer-outside",
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("ownership: revocation during the initial runtime read cannot renew authorization", async () => {
  for (const phase of ["launch", "resume"] as const)
    for (const change of ["off", "task"] as const) {
      const run = await harness();
      const rpc = new RpcHost(run.bus);
      run.bus.respond = (request) => run.bus.finish(request);
      if (phase === "resume") assert.match(await run.call(), /Consultation complete/);
      const requests = run.bus.requests.length;
      const resumes = rpc.resumes.length;
      const gate = holdRead((path) => path === getLaunchCorrectionPath(run.path));
      try {
        const pending = run.call();
        await gate.entered;
        if (change === "off") {
          await writeConfig(run.path, { ...base, advisorMode: "off" });
          await run.hook("before_provider_request", { payload: { instructions: "host" } });
        } else {
          await run.hook("session_tree");
          await run.hook("input", { source: "interactive" });
          await run.hook("before_agent_start");
        }
        gate.release();
        const answer = await pending;
        assert.doesNotMatch(answer, new RegExp(sentinel));
        assert.equal(run.bus.requests.length, requests, `${phase}/${change}`);
        assert.equal(rpc.resumes.length, resumes, `${phase}/${change}`);
      } finally {
        gate.restore();
        await run.close();
      }
    }
});

test("ownership: revocation during the final journal cleanup discards all answers", async () => {
  const third = { provider: "example", model: "third" };
  const available = [...models, { ...models[0]!, id: "third", name: "third" }];
  const run = await harness({ ...base, advisors: [first, second, third] }, available);
  const ownerPath = join(
    `${getAdvisorThreadsPath()}.lock`,
    advisorParentKey("synthetic-session"),
    "owner.json",
  );
  const gate = holdRead((path) => path === ownerPath);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    const pending = run.callBoth();
    await gate.entered;
    await run.command("advisor off");
    gate.release();
    const answer = await pending;
    assert.doesNotMatch(answer.text, new RegExp(sentinel));
    assert.match(answer.text, /cancelled/);
    assert.deepEqual(
      ((answer.details.advisorConsultation as Payload).slots as Payload[]).map((slot) => [
        slot.slot,
        slot.status,
      ]),
      [
        [0, "blocked"],
        [1, "blocked"],
        [2, "blocked"],
      ],
    );
  } finally {
    gate.restore();
    await run.close();
  }
});

test("ownership: closing T2 never satisfies the failed closing obligation of T1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-retired-"));
  const journal = new GatedJournal(join(directory, "threads.json"));
  const run = await harness(base, models, 10_000, { journal });
  new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /Consultation complete/);
    journal.failNext = 1;
    await run.hook("agent_settled");
    await run.hook("input", { source: "interactive" });
    await run.hook("before_agent_start");
    await run.hook("agent_settled");
    await run.hook("input", { source: "interactive" });
    await run.hook("before_agent_start");
    const requests = run.bus.requests.length;
    assert.match(await run.call(), /closing state of an earlier task/);
    assert.equal(run.bus.requests.length, requests);
    await run.command("advisor threads recover");
    assert.ok((await answeredSlots(journal.filePath)).every((record) => record.state === "closed"));
    assert.match(await run.call(), /Consultation complete/);
    assert.equal(run.bus.requests.length, requests + 2);
  } finally {
    await run.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ownership: concurrent parents retain closing debts across a reload and another parent's recovery", async () => {
  const a = await harness(base, models, 10_000, { sessionId: "parent-a" });
  const b = await harness(base, models, 10_000, {
    directory: dirname(a.path),
    sessionId: "parent-b",
  });
  const originalRead = fs.readFile;
  const originalRename = fs.rename;
  try {
    for (const run of [a, b]) {
      run.bus.respond = (request) => run.bus.finish(request);
      assert.match(await run.call(), /Consultation complete/);
    }
    // Both close attempts fail their journal commit. Both old companion writers see the same
    // empty snapshot: this is the lost-update interleaving, not a probabilistic Promise.all test.
    fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) === getAdvisorThreadsPath()) throw new Error("synthetic closing failure");
      return originalRename(...args);
    }) as typeof fs.rename;
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith(".advisor-closing.json"))
        return JSON.stringify({ schemaVersion: 1, parents: {} });
      return originalRead(...args);
    }) as typeof fs.readFile;
    syncBuiltinESMExports();
    await Promise.all([a.hook("agent_settled"), b.hook("agent_settled")]);
    fs.rename = originalRename;
    fs.readFile = originalRead;
    syncBuiltinESMExports();
    // Fresh extension instances have none of the old in-memory failure flags.
    for (const sessionId of ["parent-a", "parent-b"]) {
      const fresh = await harness(base, models, 10_000, { directory: dirname(a.path), sessionId });
      const rpc = new RpcHost(fresh.bus);
      rpc.sessionId = sessionId;
      try {
        fresh.bus.respond = (request) => fresh.bus.finish(request);
        assert.match(await fresh.call(), /closing state of an earlier task/, sessionId);
        assert.equal(fresh.bus.requests.length, 0);
        if (sessionId === "parent-a") await fresh.command("advisor threads recover");
        // Closing the reload's unrelated token cannot erase the other parent's obligation.
        await fresh.hook("agent_settled");
      } finally {
        await fresh.close();
      }
    }
  } finally {
    fs.rename = originalRename;
    fs.readFile = originalRead;
    syncBuiltinESMExports();
    await b.close();
    await a.close();
  }
});

test("ownership: answered obligations are never evicted for another parent", async () => {
  const runs: Awaited<ReturnType<typeof harness>>[] = [];
  try {
    for (let parent = 0; parent < 17; parent += 1) {
      const run = await harness(base, models, 10_000, {
        ...(runs[0] ? { directory: dirname(runs[0].path) } : {}),
        sessionId: `retained-${parent}`,
      });
      runs.push(run);
      run.bus.respond = (request) => run.bus.finish(request);
      assert.match(await run.call(), /Consultation complete/);
    }
    const firstRun = runs[0]!;
    const reloaded = await harness(base, models, 10_000, {
      directory: dirname(firstRun.path),
      sessionId: "retained-0",
    });
    try {
      reloaded.bus.respond = (request) => reloaded.bus.finish(request);
      assert.match(await reloaded.call(), /closing state of an earlier task/);
      assert.equal(reloaded.bus.requests.length, 0);
    } finally {
      await reloaded.close();
    }
  } finally {
    for (const run of runs.reverse()) await run.close();
  }
});

test("ownership: root and ancestor junctions are refused before any external side effect", async () => {
  for (const linked of ["root", "parent"] as const) {
    const run = await harness();
    const rpc = new RpcHost(run.bus);
    const root = run.path.replace(/\.json$/, ".advisor-output");
    const outside = join(dirname(run.path), "outside");
    try {
      run.bus.respond = (request) => run.bus.finish(request);
      assert.match(await run.call(), /Consultation complete/);
      await mkdir(outside);
      if (linked === "parent") await mkdir(root);
      await symlink(
        outside,
        linked === "root" ? root : join(root, advisorParentKey("synthetic-session")),
        process.platform === "win32" ? "junction" : "dir",
      );
      const answer = await run.call({ question: "next" });
      assert.deepEqual(await readdir(outside), [], linked);
      assert.equal(rpc.resumes.length, 0, linked);
      assert.doesNotMatch(answer, /answer-0/);
    } finally {
      await run.close();
    }
  }
});

test("ownership: answer reading creates no paths after detecting a root junction", async () => {
  const run = await harness({ ...base, advisors: [first] });
  const rpc = new RpcHost(run.bus);
  const root = run.path.replace(/\.json$/, ".advisor-output");
  const outside = join(dirname(run.path), "outside-read");
  let swapped = false;
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /Consultation complete/);
    await mkdir(outside);
    rpc.beforeReply = async (method) => {
      if (method !== "status" || swapped) return;
      swapped = true;
      await fs.rename(root, `${root}-saved`);
      await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
    };
    const answer = await run.call({ question: "next" });
    assert.ok(swapped, "the link is present only after reservation and terminal proof");
    assert.deepEqual(await readdir(outside), []);
    assert.doesNotMatch(answer, /answer-0/);
  } finally {
    await run.close();
  }
});

test("ownership: answer cleanup never removes a directory through a root junction", async () => {
  const run = await harness({ ...base, advisors: [first] });
  const rpc = new RpcHost(run.bus);
  const root = run.path.replace(/\.json$/, ".advisor-output");
  const outside = join(dirname(run.path), "outside-cleanup");
  const originalRename = fs.rename;
  let marker: string | undefined;
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /Consultation complete/);
    await mkdir(outside);
    fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
      if (!marker && String(args[1]) === getAdvisorThreadsPath() && rpc.resumes.length) {
        const next = JSON.parse(await readFile(args[0], "utf8"));
        if (
          journalThreads(next).some((record) => record.state === "answered" && record.ordinal === 2)
        ) {
          const output = String(rpc.resumes[0]!.output);
          const externalOperation = join(outside, relative(root, dirname(output)));
          await mkdir(externalOperation, { recursive: true });
          marker = join(externalOperation, "keep.md");
          await writeFile(marker, "external file must survive");
          await originalRename(root, `${root}-saved`);
          await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
        }
      }
      return originalRename(...args);
    }) as typeof fs.rename;
    syncBuiltinESMExports();
    assert.match(await run.call({ question: "next" }), /answer-0/);
    assert.ok(marker, "the link is present before cleanup, after the answer commit");
    assert.equal(await readFile(marker, "utf8"), "external file must survive");
  } finally {
    fs.rename = originalRename;
    syncBuiltinESMExports();
    await run.close();
  }
});

test("three valid slots resume together with distinct files", async () => {
  const third = { provider: "example", model: "third" };
  const available = [models[0]!, models[1]!, { ...models[0]!, id: "third", name: "third" }];
  const run = await harness({ ...base, advisors: [first, second, third] }, available);
  const rpc = new RpcHost(run.bus);
  try {
    run.bus.respond = (request) => run.bus.finish(request);
    assert.match(await run.call(), /Consultation complete: 3 of 3 advisors answered/);
    const answer = await run.call({ question: "second" });
    assert.match(answer, /answer-0/);
    assert.match(answer, /answer-1/);
    assert.match(answer, /answer-2/);
    assert.match(answer, /Consultation complete: 3 of 3 advisors answered/);
    assert.equal(rpc.resumes.length, 3);
    assert.equal(new Set(rpc.resumes.map((params) => String(params.output))).size, 3);
    assert.deepEqual([...new Set(rpc.resumes.map((params) => String(params.id)))].sort(), [
      "synthetic-run-1",
      "synthetic-run-2",
      "synthetic-run-3",
    ]);
  } finally {
    await run.close();
  }
});

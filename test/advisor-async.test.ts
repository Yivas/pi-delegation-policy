import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BackgroundConsultations,
  completionRunId,
  completionToolCallId,
  readAdvisorCompletion,
  type AdvisorSlotIdentity,
} from "../src/advisor-async.ts";
import { ADVISOR_AGENT_NAME } from "../src/advisor-executor.ts";
import { getEventLogPath } from "../src/advisor-log.ts";
import { AdvisorResumeClient } from "../src/advisor-resume.ts";
import { consultSentence, gateMessage } from "../src/advisor-gate.ts";
import { renderAdvisorHoldWarning, renderAdvisorNote } from "../src/advisor-reminders.ts";
import { getAdvisorLevelPath } from "../src/advisor-level.ts";
import { getGlobalConfigPath, writeConfig } from "../src/config.ts";
import piDelegationPolicy from "../src/index.ts";
import { CURRENT_SCHEMA_VERSION, type GlobalDefaults, type ModelRef } from "../src/types.ts";
import { within } from "./within.ts";

const small: ModelRef = { provider: "example", model: "small" };
const medium: ModelRef = { provider: "example", model: "medium" };
const large: ModelRef = { provider: "example", model: "large" };
const advisor: ModelRef = { provider: "example", model: "advisor" };

const defaults: GlobalDefaults = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  intensity: "normal",
  small,
  medium,
  large,
  advisors: [advisor],
  advisorMode: "on",
  advisorLaunch: "role",
};

const MODELS = [small, medium, large, advisor].map((reference) => ({
  provider: reference.provider,
  id: reference.model,
  name: reference.model,
  reasoning: false,
  contextWindow: 100_000,
}));

const SLOT: AdvisorSlotIdentity[] = [{ agent: ADVISOR_AGENT_NAME, model: "example/advisor" }];
const SESSIONS = ["synthetic-session", "/sessions/synthetic.jsonl"];
const COMPLETE_EVENT = "subagent:async-complete";

/** A completion payload in the shape the host writes when one background run ends. */
function completion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-1",
    sessionId: SESSIONS[1],
    state: "complete",
    success: true,
    results: [
      {
        agent: ADVISOR_AGENT_NAME,
        model: "example/advisor",
        output: "an answer",
        outputState: "present",
      },
    ],
    ...overrides,
  };
}

const answered = (payload: Record<string, unknown>): string =>
  readAdvisorCompletion(payload, { sessions: SESSIONS, slots: SLOT });

/* ------------------------------------------------------------------------------------------------
 * What a completion report proves
 * ---------------------------------------------------------------------------------------------- */

test("a complete run from a configured Advisor slot is an answer", () => {
  assert.equal(answered(completion()), "answered");
  // The host may report the model with the thinking level it ran.
  assert.equal(
    answered(
      completion({
        results: [{ agent: ADVISOR_AGENT_NAME, model: "example/advisor:high", output: "a" }],
      }),
    ),
    "answered",
  );
  // The thinking suffix has to be a level this product knows, as the launch check reads it.
  assert.equal(
    answered(
      completion({ results: [{ agent: ADVISOR_AGENT_NAME, model: "example/advisor:bogus" }] }),
    ),
    "ignored",
  );
});

test("a run that did not end with an answer is a failure and never an answer", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["stopped", completion({ stopped: true })],
    ["timed out", completion({ timedOut: true })],
    ["partial output", completion({ outputPartial: true })],
    ["a failed state", completion({ state: "failed", success: false })],
    ["no success flag", completion({ success: undefined })],
    [
      "an error on the row",
      completion({
        results: [
          { agent: ADVISOR_AGENT_NAME, model: "example/advisor", output: "x", error: "boom" },
        ],
      }),
    ],
    [
      "an interrupted row",
      completion({
        results: [{ agent: ADVISOR_AGENT_NAME, model: "example/advisor", interrupted: true }],
      }),
    ],
    [
      "no output at all",
      completion({ results: [{ agent: ADVISOR_AGENT_NAME, model: "example/advisor" }] }),
    ],
    [
      "output the host calls absent",
      completion({
        results: [{ agent: ADVISOR_AGENT_NAME, model: "example/advisor", outputState: "absent" }],
      }),
    ],
  ];
  for (const [why, payload] of cases) assert.equal(answered(payload), "failed", why);
});

test("a report that proves nothing about an Advisor is ignored", () => {
  // Another session's run is not this session's, whatever its rows say, and a report that names no
  // session at all proves nothing either.
  assert.equal(answered(completion({ sessionId: "another-session" })), "ignored");
  const unnamed = completion();
  delete unnamed["sessionId"];
  assert.equal(answered(unnamed), "ignored");
  // The model a launch asked for is not the model the host ran, so it never identifies a slot.
  assert.equal(
    answered(
      completion({
        results: [{ agent: ADVISOR_AGENT_NAME, requestedModel: "example/advisor", output: "x" }],
      }),
    ),
    "ignored",
  );
  // A child of another profile answers nothing here, whatever its output says.
  assert.equal(
    answered(completion({ results: [{ agent: "worker", model: "example/small", output: "x" }] })),
    "ignored",
  );
  // The right profile with another model is another slot.
  assert.equal(
    answered(completion({ results: [{ agent: ADVISOR_AGENT_NAME, model: "example/small" }] })),
    "ignored",
  );
  assert.equal(answered(completion({ results: [] })), "ignored");
  assert.equal(answered(completion({ runId: undefined })), "ignored");
});

test("a run id and a tool call id are read as bounded tokens and never as text", () => {
  assert.equal(completionRunId({ runId: "run-1" }), "run-1");
  assert.equal(completionRunId({ id: "run-2" }), "run-2");
  assert.equal(completionRunId({ runId: "../etc/passwd" }), undefined);
  assert.equal(completionRunId({ runId: "x".repeat(200) }), undefined);
  assert.equal(completionRunId({ runId: 7 }), undefined);
  assert.equal(completionRunId({}), undefined);
  assert.equal(completionToolCallId({ toolCallId: "call-1" }), "call-1");
  assert.equal(completionToolCallId({ toolCallId: "call 1" }), undefined);
  assert.equal(completionToolCallId({}), undefined);
});

test("the registry decides each launched run once and drops what it never launched", () => {
  const registry = new BackgroundConsultations();
  registry.startSession(SESSIONS);
  registry.openTask();
  // Nothing launched yet: no report can answer.
  assert.equal(registry.noteCompletion(completion()), "ignored");
  registry.noteLaunch("run-1", "call-1", SLOT);
  // A wrong run id, a wrong session and a report that proves nothing decide nothing, and the run
  // stays waiting for a better one.
  assert.equal(registry.noteCompletion(completion({ runId: "run-9" })), "ignored");
  assert.equal(registry.noteCompletion(completion({ sessionId: "elsewhere" })), "ignored");
  assert.equal(registry.noteCompletion(completion({ results: [] })), "ignored");
  // A report of another call cannot answer this run.
  assert.equal(registry.noteCompletion(completion({ toolCallId: "call-9" })), "ignored");
  assert.equal(registry.noteCompletion(completion()), "answered");
  // The second report of one run decides nothing again, even when it contradicts the first.
  assert.equal(registry.noteCompletion(completion()), "ignored");
  // A new task forgets the runs of the one before, and a new session forgets them too.
  registry.openTask();
  assert.equal(registry.noteCompletion(completion()), "ignored");
  registry.noteLaunch("run-2", undefined, SLOT);
  assert.equal(registry.noteCompletion(completion({ runId: "run-2" })), "answered");
  registry.startSession(SESSIONS);
  registry.noteLaunch("run-3", undefined, SLOT);
  registry.closeTask();
  assert.equal(registry.noteCompletion(completion({ runId: "run-3" })), "ignored");
});

/* ------------------------------------------------------------------------------------------------
 * The boundary: the host reports, and the checkpoint opens
 * ---------------------------------------------------------------------------------------------- */

const CHILD_MARKERS = ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUNNER_PID"] as const;

type Listener = (payload: unknown) => void;

/** A standing-in `pi.events`: it answers the bridge's `ping` and says when something listens. */
function fakeBus(sessionId: string) {
  const listeners = new Map<string, Set<Listener>>();
  const waiting = new Map<string, Array<() => void>>();
  /** How many requests the bridge answered, and who waits for the next answer to be applied. */
  let answered = 0;
  const waitingAnswered: Array<() => void> = [];
  const announce = (event: string): void => {
    const pending = waiting.get(event);
    if (pending === undefined) return;
    waiting.delete(event);
    for (const resolve of pending) resolve();
  };
  const bus = {
    on(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      announce(event);
      return () => {
        set.delete(listener);
      };
    },
    emit(event: string, payload: unknown) {
      if (event === "subagents:rpc:v1:request") {
        const request = payload as { requestId?: string; version?: number };
        if (typeof request.requestId !== "string") return;
        setImmediate(() => {
          bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
            version: 1,
            requestId: request.requestId,
            success: true,
            data: {
              version: 1,
              events: { asyncComplete: COMPLETE_EVENT },
              session: { sessionId },
            },
          });
          // Announced one turn later, so whoever waited sees the answer already applied.
          setImmediate(() => {
            answered += 1;
            for (const resolve of waitingAnswered.splice(0)) resolve();
          });
        });
        return;
      }
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
    /** How many listeners `event` has, which is how a test reads the channel's lifecycle. */
    count(event: string): number {
      return listeners.get(event)?.size ?? 0;
    },
    /** Resolves once the bridge answered a request and its answer has been applied. */
    answeredRequest(atLeast = 1): Promise<void> {
      if (answered >= atLeast) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waitingAnswered.push(resolve);
      });
    },
    /** Resolves once something listens for `event`, which is how a test knows admission ended. */
    listening(event: string): Promise<void> {
      if ((listeners.get(event)?.size ?? 0) > 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const pending = waiting.get(event) ?? [];
        pending.push(resolve);
        waiting.set(event, pending);
      });
    },
  };
  return bus;
}

async function withAgentDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "advisor-async-"));
  const previousDirectory = process.env.PI_CODING_AGENT_DIR;
  const previousMarkers = CHILD_MARKERS.map((key) => [key, process.env[key]] as const);
  process.env.PI_CODING_AGENT_DIR = directory;
  for (const key of CHILD_MARKERS) delete process.env[key];
  try {
    await callback(directory);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDirectory;
    for (const [key, value] of previousMarkers) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** `bridge: "foreign"` answers with another session, which is an admission this session is refused. */
function createHarness(
  options: { activeTools?: string[]; bridge?: "advertised" | "foreign" } = {},
) {
  const handlers = new Map<
    string,
    (event: Record<string, unknown>, ctx: ExtensionContext) => unknown
  >();
  const descriptions: string[] = [];
  const tools = new Map<
    string,
    {
      execute: (
        id: string,
        input: Record<string, unknown>,
        signal: undefined,
        update: undefined,
        context: ExtensionContext,
      ) => Promise<unknown>;
    }
  >();
  const notifications: Array<{ message: string; type: string }> = [];
  let notifyThrows = false;
  const branch: Array<Record<string, unknown>> = [];
  const bus = fakeBus(options.bridge === "foreign" ? "another-session" : SESSIONS[0]);
  const pi = {
    on: (
      name: string,
      handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown,
    ) => handlers.set(name, handler),
    registerTool: (tool: {
      name?: string;
      description?: string;
      execute?: (
        id: string,
        input: Record<string, unknown>,
        signal: undefined,
        update: undefined,
        context: ExtensionContext,
      ) => Promise<unknown>;
    }) => {
      if (tool.description) descriptions.push(tool.description);
      if (typeof tool.name === "string" && tool.execute)
        tools.set(tool.name, { execute: tool.execute });
    },
    getAllTools: () => [
      ...["read", "find", "grep", "ls", "edit", "write", "bash"].map((name) => ({
        name,
        sourceInfo: { source: "builtin" },
      })),
      ...["subagent", "consult_advisor"].map((name) => ({
        name,
        sourceInfo: { source: "extension" },
      })),
    ],
    getActiveTools: () => options.activeTools ?? ["consult_advisor", "subagent"],
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    appendEntry: (customType: string, data?: unknown) =>
      branch.push({ type: "custom", customType, data }),
    events: bus,
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ctx = {
    cwd: "/project",
    hasUI: true,
    mode: "tui",
    scopedModels: [],
    model: { provider: "example", id: "small" },
    signal: undefined,
    sessionManager: {
      getBranch: () => branch,
      getHeader: () => ({}),
      getSessionId: () => SESSIONS[0],
      getSessionFile: () => SESSIONS[1],
    },
    modelRegistry: {
      find: (provider: string, id: string) =>
        MODELS.find((candidate) => candidate.provider === provider && candidate.id === id),
      getAvailable: () => MODELS,
      hasConfiguredAuth: () => true,
    },
    ui: {
      theme,
      setStatus: () => undefined,
      notify: (message: string, type: string) => {
        if (notifyThrows) throw new Error("the host refused the notification");
        notifications.push({ message, type });
      },
      custom: () => new Promise(() => undefined),
    },
  } as unknown as ExtensionContext;
  piDelegationPolicy(pi as never);
  const handler = (name: string) => {
    const registered = handlers.get(name);
    if (!registered) throw new Error(`The extension does not register ${name}.`);
    return registered;
  };
  const request = async (
    text: string,
  ): Promise<{ messages?: Array<{ content?: unknown }> } | undefined> =>
    within(
      "the policy block",
      handler("context_with_system")(
        {
          type: "context_with_system",
          messages: [
            { role: "system", content: "Host prompt", timestamp: 1 },
            { role: "user", content: [{ type: "text", text }], timestamp: 2 },
          ],
        },
        ctx,
      ) as Promise<{ messages?: Array<{ content?: unknown }> } | undefined>,
    );
  /** A prompt that holds its task from the start: `??` asks for a consultation first. */
  const prompt = async (text = "?? change the loader"): Promise<void> => {
    branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    await within("input", handler("input")({ type: "input", text, source: "interactive" }, ctx));
    await within(
      "before_agent_start",
      handler("before_agent_start")({ type: "before_agent_start" }, ctx),
    );
    await within(
      "message_end",
      handler("message_end")(
        { type: "message_end", message: { role: "assistant", content: [] } },
        ctx,
      ),
    );
    await request(text);
  };
  let callId = 0;
  /** The id of the call `toolCall` just made, which is what its result is reported under. */
  const lastCallId = (): string => `call-${callId}`;
  const toolCall = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    callId += 1;
    return (await within(
      `the ${toolName} call`,
      handler("tool_call")(
        { type: "tool_call", toolCallId: `call-${callId}`, toolName, input },
        ctx,
      ),
    )) as { block?: boolean; reason?: string } | undefined;
  };
  const toolResult = async (
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    details?: unknown,
  ): Promise<void> => {
    await within(
      `the ${toolName} result`,
      handler("tool_result")(
        {
          type: "tool_result",
          toolCallId,
          toolName,
          input,
          content: [{ type: "text", text: "body" }],
          isError: false,
          details,
        },
        ctx,
      ),
    );
  };
  const messageEnd = async (message: Record<string, unknown>): Promise<void> => {
    await within("message_end", handler("message_end")({ type: "message_end", message }, ctx));
  };
  const settled = async (): Promise<void> => {
    await within("agent_settled", handler("agent_settled")({ type: "agent_settled" }, ctx));
  };
  const shutdown = async (): Promise<void> => {
    await within(
      "session_shutdown",
      handler("session_shutdown")({ type: "session_shutdown" }, ctx),
    );
  };
  /** Start a session, and wait for the admission of the one it starts (`admissions` counts them). */
  const start = async (admissions = 1): Promise<void> => {
    await within(
      "session_start",
      handler("session_start")({ type: "session_start", reason: "startup" }, ctx),
    );
    // The completion channel is admitted in the background: wait until it listens, or until the
    // bridge refused it, because then no listener is coming.
    if (options.bridge === "foreign")
      await within("the admission", bus.answeredRequest(admissions));
    else await within("the completion listener", bus.listening(COMPLETE_EVENT));
  };
  return {
    ctx,
    bus,
    descriptions,
    notifications,
    /** Run a registered tool the way the host does, and return the text it hands back. */
    runTool: async (name: string, input: Record<string, unknown> = {}): Promise<string> => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`The extension registers no ${name} tool.`);
      const result = await within(
        `the ${name} tool`,
        tool.execute("id", input, undefined, undefined, ctx),
      );
      const content = (result as { content?: Array<{ text?: string }> } | undefined)?.content ?? [];
      return content.map((part) => part.text ?? "").join("\n");
    },
    /** Make the host's notification throw, which is the one call this listener could fail on. */
    failNotifications: () => {
      notifyThrows = true;
    },
    start,
    prompt,
    toolCall,
    lastCallId,
    toolResult,
    messageEnd,
    settled,
    shutdown,
    request,
  };
}

async function withHarness(
  callback: (harness: ReturnType<typeof createHarness>) => Promise<void>,
  options: { level?: string; config?: GlobalDefaults; activeTools?: string[] } = {},
): Promise<void> {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), options.config ?? defaults);
    await writeFile(
      getAdvisorLevelPath(getGlobalConfigPath(directory)),
      `${JSON.stringify({ schemaVersion: 1, level: options.level ?? "strict" })}\n`,
    );
    const harness = createHarness({ activeTools: options.activeTools });
    await harness.start();
    try {
      await callback(harness);
    } finally {
      await harness.shutdown();
    }
  });
}

const ADVISOR_LAUNCH = { agent: ADVISOR_AGENT_NAME, model: "example/advisor", task: "Is this ok?" };
const EDIT = { path: "src/loader.ts", edits: [{ oldText: "a", newText: "b" }] };

/** Register one background consultation launch, as the host hands back its run. */
async function launchRun(harness: ReturnType<typeof createHarness>, runId: string): Promise<void> {
  assert.equal(
    await harness.toolCall("subagent", { ...ADVISOR_LAUNCH, async: true, task: runId }),
    undefined,
    "a consultation is not refused for running in the background",
  );
  const call = harness.lastCallId();
  await harness.toolResult(
    "subagent",
    call,
    { ...ADVISOR_LAUNCH, async: true, task: runId },
    {
      mode: "single",
      runId,
      asyncId: runId,
      toolCallId: call,
      results: [],
    },
  );
}

test("a background consultation runs while the checkpoint holds, and its answer opens it", async () => {
  await withHarness(async (harness) => {
    await harness.prompt();
    // The hold is on: a change waits.
    assert.equal((await harness.toolCall("edit", EDIT))?.block, true);
    // One run reports its terminal state once, so each shape below gets a run of its own.
    for (const runId of ["run-1", "run-2", "run-3", "run-4", "run-5", "run-6", "run-7"])
      await launchRun(harness, runId);
    // Nothing that proves nothing about this task's Advisors opens the hold.
    for (const payload of [
      completion({ runId: "run-9" }),
      completion({ sessionId: "another-session" }),
      completion({ results: [{ agent: "worker", model: "example/small", output: "x" }] }),
      completion({ results: [{ agent: ADVISOR_AGENT_NAME, model: "example/small", output: "x" }] }),
      completion({ runId: "run-2", toolCallId: "call-9" }),
      completion({ runId: "run-3", stopped: true }),
      completion({ runId: "run-4", outputPartial: true }),
      completion({
        runId: "run-5",
        results: [{ agent: ADVISOR_AGENT_NAME, model: "example/advisor", error: "x" }],
      }),
      completion({ runId: "run-6", state: "failed", success: false }),
    ]) {
      harness.bus.emit(COMPLETE_EVENT, payload);
      assert.equal((await harness.toolCall("edit", EDIT))?.block, true, JSON.stringify(payload));
    }
    // An Advisor that started and did not answer leaves the task held and tells the operator once
    // per pair of failures, which is the pair the failed runs above make.
    assert.equal(
      harness.notifications.filter((notice) => /got no answer/.test(notice.message)).length,
      2,
    );
    // A completion the agent typed is a message, not a host report, whatever it contains.
    await harness.messageEnd({
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(completion({ runId: "run-1" })) }],
    });
    assert.equal((await harness.toolCall("edit", EDIT))?.block, true);
    // The host's own report of that run opens the checkpoint, under either identity the session has.
    harness.bus.emit(COMPLETE_EVENT, completion({ runId: "run-1" }));
    assert.equal(await harness.toolCall("edit", EDIT), undefined);
    // And a second report of the same run decides nothing more.
    await harness.prompt("?? again");
    harness.bus.emit(COMPLETE_EVENT, completion({ runId: "run-1" }));
    assert.equal((await harness.toolCall("edit", EDIT))?.block, true);
  });
});

test("a completion that arrives after the task closed lifts nothing", async () => {
  await withHarness(async (harness) => {
    await harness.prompt();
    await launchRun(harness, "run-1");
    await harness.settled();
    harness.bus.emit(COMPLETE_EVENT, completion({ runId: "run-1" }));
    await harness.prompt("?? a new task");
    assert.equal((await harness.toolCall("edit", EDIT))?.block, true);
  });
});

/** Every model-facing text this extension can produce in one launch mode. */
async function modelFacingTexts(harness: ReturnType<typeof createHarness>): Promise<string[]> {
  // A task that holds its first change from the start, so the refusal is part of the surface.
  await harness.prompt();
  const answer = await harness.request("?? change the loader");
  const rendered = (answer?.messages ?? [])
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.map((part) => JSON.stringify(part))
          : [],
    )
    .join("\n");
  assert.ok(rendered.trim() !== "", "the policy block is rendered");
  const texts = [
    rendered,
    ...harness.descriptions,
    // Both notes the reminder can present, each with the sentence of its mode.
    renderAdvisorNote(consultSentence("role", [ADVISOR_AGENT_NAME])),
    renderAdvisorNote(consultSentence("tool")),
    renderAdvisorHoldWarning(),
  ];
  // Every refusal shape: both launchers, who writes the brief, and the clause a run of failures adds.
  for (const launcher of ["role", "tool"] as const)
    for (const manual of [false, true])
      for (const broken of [false, true])
        texts.push(gateMessage(launcher, manual, broken, [ADVISOR_AGENT_NAME]));
  // The refusal the checkpoint actually sends for a held change.
  const refused = await harness.toolCall("edit", EDIT);
  assert.equal(refused?.block, true);
  if (refused?.reason) texts.push(refused.reason);
  // The redirect `consult_advisor` returns in `role` launch.
  texts.push(await harness.runTool("consult_advisor"));
  return texts;
}

test("no text the model reads asks for the foreground or for async: false", async () => {
  for (const mode of ["role", "tool"] as const) {
    await withHarness(
      async (harness) => {
        for (const text of await modelFacingTexts(harness)) {
          assert.doesNotMatch(text, /foreground/i, mode);
          assert.doesNotMatch(text, /async:\s*false/i, mode);
        }
      },
      mode === "role"
        ? {}
        : { config: { ...defaults, advisorLaunch: "tool" }, activeTools: ["consult_advisor"] },
    );
  }
  // The message a session without the host subagent tool gets is a redirect too.
  await withHarness(
    async (harness) => {
      const missing = await harness.runTool("consult_advisor");
      assert.match(missing, /is not available/);
      assert.doesNotMatch(missing, /foreground/i);
      assert.doesNotMatch(missing, /async:\s*false/i);
    },
    { activeTools: ["consult_advisor"] },
  );
});

test("a session that hears no completion channel asks for the foreground launch", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);
    await writeFile(
      getAdvisorLevelPath(getGlobalConfigPath(directory)),
      `${JSON.stringify({ schemaVersion: 1, level: "strict" })}
`,
    );
    const harness = createHarness({ bridge: "foreign" });
    await harness.start();
    const notice = (): number =>
      harness.notifications.filter((entry) =>
        /cannot release the checkpoint in this session/.test(entry.message),
      ).length;
    try {
      await harness.prompt();
      // One plain line for the operator, and no listener for an answer that can never arrive.
      assert.equal(notice(), 1);
      assert.equal(harness.bus.count(COMPLETE_EVENT), 0);
      // The refusal asks for the launch whose answer this session can read, and never the other one.
      const refused = await harness.toolCall("edit", EDIT);
      assert.equal(refused?.block, true);
      assert.match(refused?.reason ?? "", /in the foreground/);
      assert.match(refused?.reason ?? "", /async: false/);
      assert.doesNotMatch(refused?.reason ?? "", /in the background/);
      // The policy block asks for the same launch, so the text a model reads cannot drift from it.
      const block = await harness.request("?? again change the loader");
      const rendered = (block?.messages ?? [])
        .flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.map((part) => JSON.stringify(part))
            : [String(message.content ?? "")],
        )
        .join("\n");
      assert.match(rendered, /in the foreground, with async: false/);
      assert.doesNotMatch(rendered, /in the background: a detached launch returns a run id/);
      // The redirect `consult_advisor` returns in `role` launch names the same form.
      const redirect = await harness.runTool("consult_advisor");
      assert.match(redirect, /in the foreground with async: false/);
      assert.doesNotMatch(redirect, /in the background, as the delegation policy describes/);
      // The later request repeats no notice either.
      assert.equal(notice(), 1);
      // The foreground answer is a report this task reads, so it opens the hold.
      const foreground = { ...ADVISOR_LAUNCH, async: false };
      assert.equal(await harness.toolCall("subagent", foreground), undefined);
      await harness.toolResult("subagent", harness.lastCallId(), foreground, {
        mode: "single",
        results: [
          {
            agent: ADVISOR_AGENT_NAME,
            model: "example/advisor",
            output: "an answer",
            exitCode: 0,
            finalOutput: "an answer",
          },
        ],
      });
      assert.equal(await harness.toolCall("edit", EDIT), undefined);
    } finally {
      await harness.shutdown();
    }
    const log = await readFile(getEventLogPath(getGlobalConfigPath(directory)), "utf8");
    assert.equal(log.match(/"status":"channel-missing"/g)?.length, 1);
  });
});

/**
 * The notice and the record are once per session, not once per process: a second session on the same
 * missing bridge reads the same channel the first one read, and nothing of that one speaks for it.
 */
test("a second session on a missing bridge gets its own notice and its own record", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);
    await writeFile(
      getAdvisorLevelPath(getGlobalConfigPath(directory)),
      `${JSON.stringify({ schemaVersion: 1, level: "strict" })}
`,
    );
    const harness = createHarness({ bridge: "foreign" });
    const notice = (): number =>
      harness.notifications.filter((entry) =>
        /cannot release the checkpoint in this session/.test(entry.message),
      ).length;
    await harness.start();
    try {
      await harness.prompt();
      assert.equal(notice(), 1, "the first session warns its operator once");
      // The process starts a second session on the same bridge, which refuses it the same way: what
      // the one before was told and wrote is not this session's reading.
      await harness.start(2);
      await harness.prompt();
      assert.equal(notice(), 2, "the session that started has its own warning");
    } finally {
      await harness.shutdown();
    }
    const log = await readFile(getEventLogPath(getGlobalConfigPath(directory)), "utf8");
    assert.equal(log.match(/"status":"channel-missing"/g)?.length, 2, "one record per session");
  });
});

/* ------------------------------------------------------------------------------------------------
 * The channel itself: admitted once per session, removed when it ends
 * ---------------------------------------------------------------------------------------------- */

test("the completion channel is admitted once per session and removed when it ends", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);
    await writeFile(
      getAdvisorLevelPath(getGlobalConfigPath(directory)),
      `${JSON.stringify({ schemaVersion: 1, level: "strict" })}
`,
    );
    const harness = createHarness();
    await harness.start();
    try {
      assert.equal(harness.bus.count(COMPLETE_EVENT), 1, "one listener for the session");
      // A second start of the same session replaces its channel instead of stacking another one.
      await harness.start();
      assert.equal(harness.bus.count(COMPLETE_EVENT), 1, "no second listener");
    } finally {
      await harness.shutdown();
    }
    assert.equal(harness.bus.count(COMPLETE_EVENT), 0, "the session leaves no listener behind");
  });
});

/** A bus that records listeners and never answers: the bridge is absent or slower than the session. */
function silentBus() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    events: {
      on(event: string, listener: Listener) {
        const set = listeners.get(event) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(event, set);
        return () => {
          set.delete(listener);
        };
      },
      emit: () => undefined,
    },
    replyListeners(): number {
      let count = 0;
      for (const [event, set] of listeners)
        if (event.startsWith("subagents:rpc:v1:reply:")) count += set.size;
      return count;
    },
  };
}

test("an admission nobody answers keeps no reply listener once it fails or is abandoned", async () => {
  // The bound fires: the answer never comes, and the listener goes with it.
  const timedOut = silentBus();
  const expiring = new AdvisorResumeClient({ events: timedOut.events as never, rpcTimeoutMs: 10 });
  assert.equal(await expiring.admitCompletion(SESSIONS[0]), false, "no advertisement, no channel");
  assert.equal(timedOut.replyListeners(), 0, "a timed-out admission leaves no listener");

  // The session ends first: the pending reply is abandoned instead of outliving it.
  const abandoned = silentBus();
  const client = new AdvisorResumeClient({ events: abandoned.events as never });
  const pending = client.admitCompletion(SESSIONS[0]);
  assert.equal(abandoned.replyListeners(), 1, "the question is waiting for a reply");
  client.abortPending();
  assert.equal(await pending, false);
  assert.equal(abandoned.replyListeners(), 0, "an abandoned admission leaves no listener");
});

test("every report this task reads leaves its closed status in the local record", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);
    await writeFile(
      getAdvisorLevelPath(getGlobalConfigPath(directory)),
      `${JSON.stringify({ schemaVersion: 1, level: "strict" })}
`,
    );
    const harness = createHarness();
    await harness.start();
    try {
      await harness.prompt();
      for (const runId of ["run-1", "run-2"]) await launchRun(harness, runId);
      // One report that proves nothing about this task, one run that did not answer, and the answer.
      harness.bus.emit(COMPLETE_EVENT, completion({ runId: "run-9" }));
      harness.bus.emit(COMPLETE_EVENT, completion({ runId: "run-1", stopped: true }));
      harness.bus.emit(COMPLETE_EVENT, completion({ runId: "run-2" }));
      assert.equal(await harness.toolCall("edit", EDIT), undefined, "the answer opened the task");
    } finally {
      await harness.shutdown();
    }
    const log = await readFile(getEventLogPath(getGlobalConfigPath(directory)), "utf8").catch(
      () => "",
    );
    for (const status of ["ignored", "failed", "answered"])
      assert.ok(log.includes(`"status":"${status}"`), status);
  });
});

test("a report the reader cannot finish is recorded with a closed status and never thrown", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);
    await writeFile(
      getAdvisorLevelPath(getGlobalConfigPath(directory)),
      `${JSON.stringify({ schemaVersion: 1, level: "strict" })}
`,
    );
    const harness = createHarness();
    await harness.start();
    try {
      await harness.prompt();
      for (const runId of ["run-1", "run-2", "run-3"]) await launchRun(harness, runId);
      // A payload whose reading throws is no verdict at all: nothing of it was applied.
      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error("the payload refused to be read");
          },
        },
      );
      harness.bus.emit(COMPLETE_EVENT, hostile);
      // The operator notice is the one call of this listener that can throw. Two failed runs reach
      // it, the pair that earns it, so the second emit is the one that fails and must be absorbed.
      harness.failNotifications();
      harness.bus.emit(COMPLETE_EVENT, completion({ runId: "run-1", stopped: true }));
      harness.bus.emit(COMPLETE_EVENT, completion({ runId: "run-2", stopped: true }));
      // The hold is where it was: no throw escaped, and the task is still the one it was.
      assert.equal((await harness.toolCall("edit", EDIT))?.block, true);
    } finally {
      await harness.shutdown();
    }
    const log = await readFile(getEventLogPath(getGlobalConfigPath(directory)), "utf8").catch(
      () => "",
    );
    // A report that could not be read, the failures it counted, and the notice that could not be
    // delivered all reach the closed record, and none of them opens the hold.
    assert.match(log, /"event":"completion"/);
    assert.match(log, /"status":"unreadable"/);
    assert.match(log, /"status":"failed"/);
    assert.match(log, /"status":"notice-failed"/);
  });
});

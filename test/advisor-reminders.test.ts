import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  convertToLlm,
  type ContextWithSystemEvent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  ADVISOR_CADENCE_RESULTS,
  ADVISOR_REMINDER_TYPE,
  AdvisorReminderState,
  DEFAULT_ADVISOR_REMINDER_MODE,
  getAdvisorRemindersPath,
  readAdvisorReminderMode,
  renderAdvisorHoldWarning,
  renderAdvisorNote,
  writeAdvisorReminderMode,
} from "../src/advisor-reminders.ts";
import {
  failureRunClause,
  GATE_CONSULT_FAILURES,
  GATE_HOLD_CHANGES,
  GATE_WARN_CHANGES,
  gateMessage,
} from "../src/advisor-gate.ts";
import { getGlobalConfigPath, isAbsentPathError, writeConfig } from "../src/config.ts";
import { getAdvisorLevelPath, readAdvisorLevelFile } from "../src/advisor-level.ts";
import { getGuardModePath } from "../src/guard-mode.ts";
import { getEventLogPath } from "../src/advisor-log.ts";
import { DelegatePanel, type DelegatePanelOptions } from "../src/delegate-panel.ts";
import piDelegationPolicy from "../src/index.ts";
import { openDelegateEditor } from "../src/ui.ts";
import { CURRENT_SCHEMA_VERSION, type GlobalDefaults, type ModelRef } from "../src/types.ts";

const small: ModelRef = { provider: "example", model: "small" };
const medium: ModelRef = { provider: "example", model: "medium" };
const large: ModelRef = { provider: "example", model: "large" };
const advisor: ModelRef = { provider: "example", model: "advisor" };
const ADVISOR_AGENT = "pi-delegation-policy.advisor";

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

type TestModel = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
};

function model(reference: ModelRef): TestModel {
  return {
    provider: reference.provider,
    id: reference.model,
    name: reference.model,
    reasoning: true,
    contextWindow: 200_000,
  };
}

const models = [small, medium, large, advisor].map(model);
/** Tools the host reports as builtin; the launchers come from extensions. */
const BUILTIN_TOOLS = ["read", "find", "grep", "ls", "edit", "write", "bash"];
const EXTENSION_TOOLS = ["subagent", "consult_advisor"];

type Messages = ContextWithSystemEvent["messages"];
type Harness = ReturnType<typeof createHarness>;

/**
 * These handlers run inside whatever process invokes the suite, which may itself be a subagent. The
 * two documented child markers are cleared for the duration so a case decides its own environment;
 * the marked-child case sets them explicitly and no other `PI_*` value is touched.
 */
const CHILD_MARKERS = ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUNNER_PID"] as const;

async function withAgentDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "advisor-reminders-"));
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

/** Drives the registered handlers in the order the host emits them for one run. */
function createHarness(
  directory: string,
  options: {
    activeTools?: string[];
    parentSession?: string;
    config?: GlobalDefaults;
  } = {},
) {
  const handlers = new Map<
    string,
    (event: Record<string, unknown>, ctx: ExtensionContext) => unknown
  >();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const branch: Array<Record<string, unknown>> = [];
  let appended = 0;
  let callId = 0;
  let lastCall: string | undefined;
  const activeTools = options.activeTools ?? ["subagent"];
  const pi = {
    on: (
      name: string,
      handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown,
    ) => handlers.set(name, handler),
    registerTool: () => undefined,
    getAllTools: () => [
      ...BUILTIN_TOOLS.map((name) => ({ name, sourceInfo: { source: "builtin" } })),
      ...EXTENSION_TOOLS.map((name) => ({ name, sourceInfo: { source: "extension" } })),
    ],
    getActiveTools: () => activeTools,
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => commands.set(name, command),
    registerShortcut: () => undefined,
    appendEntry: (customType: string, data?: unknown) => {
      appended += 1;
      branch.push({ type: "custom", customType, data });
    },
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
    sessionManager: {
      getBranch: () => branch,
      getHeader: () => (options.parentSession ? { parentSession: options.parentSession } : {}),
    },
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find((candidate) => candidate.provider === provider && candidate.id === id),
      getAvailable: () => models,
      hasConfiguredAuth: () => true,
    },
    ui: {
      theme,
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string, type: string) => notifications.push({ message, type }),
      custom: <T>(
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: T) => void,
        ) => unknown,
      ) => new Promise<T>(() => void factory({ terminal: { rows: 30 } }, theme, {}, () => {})),
    },
  } as unknown as ExtensionContext;
  piDelegationPolicy(pi as never);

  const handler = (name: string) => {
    const registered = handlers.get(name);
    if (!registered) throw new Error(`The extension does not register ${name}.`);
    return registered;
  };
  const transcript = (): Messages =>
    structuredClone([
      { role: "system", content: "Host prompt", timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "Run the task" }], timestamp: 2 },
    ]) as Messages;
  const request = async (messages: Messages = transcript()): Promise<Messages> => {
    const result = await handler("context_with_system")(
      { type: "context_with_system", messages },
      ctx,
    );
    const projected = (result as { messages?: Messages } | undefined)?.messages;
    if (!projected) throw new Error("The context hook returns the complete request transcript.");
    return projected;
  };
  const prompt = async (source = "interactive", text = "Run the task"): Promise<void> => {
    await handler("input")({ type: "input", text, source }, ctx);
    await handler("before_agent_start")({ type: "before_agent_start" }, ctx);
  };
  const toolCall = async (
    toolName: string,
    input: Record<string, unknown> = {},
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    callId += 1;
    lastCall = `call-${callId}`;
    return (await handler("tool_call")(
      { type: "tool_call", toolCallId: lastCall, toolName, input },
      ctx,
    )) as { block?: boolean; reason?: string } | undefined;
  };
  /**
   * One tool result. A result carries its own id by default; a case that needs the host's pairing
   * between a call and the result that answers it passes the id of that call explicitly.
   */
  const toolResult = async (
    toolName: string,
    isError = false,
    options: {
      toolCallId?: string;
      content?: Array<{ type: "text"; text: string }>;
      /** What the tool reported: the only thing the gate reads to decide whether it answered. */
      details?: unknown;
    } = {},
  ): Promise<void> => {
    callId += 1;
    await handler("tool_result")(
      {
        type: "tool_result",
        toolCallId: options.toolCallId ?? `result-${callId}`,
        toolName,
        input: {},
        content: options.content ?? [{ type: "text", text: "body" }],
        isError,
        details: options.details,
      },
      ctx,
    );
  };
  /** `count` results of a builtin tool, as one task's rounds would report them. */
  const results = async (count: number, toolName = "read"): Promise<void> => {
    for (let index = 0; index < count; index += 1) await toolResult(toolName);
  };
  /**
   * A consultation result the host paired with the call that launched it. The text is whatever the
   * launcher printed: the gate reads `details` and never this, so a case states both.
   */
  const consultationResult = async (
    isError: boolean,
    text: string,
    options: { toolCallId?: string; details?: unknown } = {},
  ): Promise<void> =>
    toolResult("consult_advisor", isError, {
      toolCallId: options.toolCallId ?? lastCall,
      content: [{ type: "text", text }],
      details: options.details,
    });
  const settled = async (): Promise<void> => {
    await handler("agent_settled")({ type: "agent_settled" }, ctx);
  };
  const start = async (): Promise<void> => {
    await handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
  };
  const tree = async (): Promise<void> => {
    await handler("session_tree")({ type: "session_tree" }, ctx);
  };
  const shutdown = async (): Promise<void> => {
    await handler("session_shutdown")({ type: "session_shutdown" }, ctx);
  };
  const reminders = (messages: Messages) =>
    messages.filter(
      (message) => message.role === "custom" && message.customType === ADVISOR_REMINDER_TYPE,
    );
  const reminderText = (messages: Messages): string | undefined => {
    const [reminder] = reminders(messages);
    return reminder && "content" in reminder && typeof reminder.content === "string"
      ? reminder.content
      : undefined;
  };
  const config = (values: GlobalDefaults) => writeConfig(getGlobalConfigPath(directory), values);
  return {
    ctx,
    branch,
    handlers,
    transcript,
    request,
    prompt,
    toolCall,
    toolResult,
    results,
    consultationResult,
    /** The id of the most recent tool call, so a result can answer it. */
    lastCall: () => lastCall,
    settled,
    start,
    tree,
    shutdown,
    reminders,
    reminderText,
    config,
    command: (args: string) => commands.get("delegate")!.handler(args, ctx),
    status: () => statuses.at(-1),
    notifications,
    appended: () => appended,
  };
}

async function withHarness(
  options: Parameters<typeof createHarness>[1],
  callback: (harness: Harness) => Promise<void>,
): Promise<void> {
  await withAgentDirectory(async (directory) => {
    const harness = createHarness(directory, options);
    await harness.config(options?.config ?? defaults);
    await harness.start();
    await callback(harness);
    await harness.shutdown();
  });
}

/** The level companion decides a task's level: it is read when the task opens. */
async function writeLevel(values: { level?: string; context?: string }): Promise<void> {
  await writeFile(
    getAdvisorLevelPath(getGlobalConfigPath()),
    `${JSON.stringify({ schemaVersion: 1, ...values })}\n`,
  );
}

/** The log writer drains on its own, so a case waits for the record it is about. */
async function logEventsNamed(event: string): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const text = await readFile(getEventLogPath(getGlobalConfigPath()), "utf8").catch(() => "");
    const matching = text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === event);
    if (matching.length || Date.now() > deadline) return matching;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const SMALL_EDIT = { path: "src/a.ts", edits: [{ oldText: "a", newText: "one" }] };

/** An Advisor consultation the host answers inside the call: every child is the Advisor. */
const FOREGROUND_CONSULT = {
  async: false,
  tasks: [{ agent: ADVISOR_AGENT, model: "example/advisor:high", task: "Review the change." }],
};

/** An ordinary launch: no child is an Advisor, so it is not a consultation at any level. */
const ORDINARY_LAUNCH = {
  tasks: [{ agent: "worker", model: "example/small:high", task: "Read the file." }],
};

/**
 * The details `consult_advisor` itself writes: one slot per Advisor, each with its own status, and
 * `dispatched` on the slots whose host run was issued.
 */
const toolDetails = (status: "complete" | "blocked", dispatched = true) => ({
  advisorConsultation: {
    summary: status === "complete" ? "complete" : "unavailable",
    slots: [{ slot: 0, status, model: "example/advisor", ...(dispatched ? { dispatched } : {}) }],
  },
});

/** The details the host's `subagent` tool reports: one result per child, all of them Advisors. */
const roleDetails = (child: Record<string, unknown>) => ({ results: [child] });

/** A `consult_advisor` result with one completed slot: the tool answered. */
const ANSWERED_TOOL_DETAILS = toolDetails("complete");
/**
 * A `consult_advisor` result whose only slot was dispatched and never completed: it failed, text
 * notwithstanding. Without the dispatch flag the same slot would prove no launch at all.
 */
const FAILED_TOOL_DETAILS = toolDetails("blocked");
/** The defect: a first turn with no brief is given its slot and stops before the launch. */
const UNDISPATCHED_TOOL_DETAILS = toolDetails("blocked", false);
/** A role launch whose only child ended cleanly and left output: the Advisor answered. */
const ANSWERED_ROLE_DETAILS = roleDetails({
  exitCode: 0,
  finalOutput: "the Advisor answered",
});
/** A role launch whose only child exited non-zero: it failed, text notwithstanding. */
const FAILED_ROLE_DETAILS = roleDetails({
  exitCode: 1,
  finalOutput: "the Advisor failed",
});
/**
 * A result whose shape this version cannot read: a list of slots that is not a list. It proves no
 * launch, so it counts nothing and the hold it leaves stands.
 */
const UNREADABLE_DETAILS = { advisorConsultation: { summary: "complete", slots: "complete" } };
/**
 * The details `consult_advisor` writes for a call that consulted nobody: an early exit, a blank
 * question, a busy executor. It is positive evidence of nothing, so it counts nothing at all.
 */
const NOT_RUN_DETAILS = { advisorConsultation: { summary: "not-run", slots: [] } };
/** The failure text `consult_advisor` returns for a call that reached no Advisor. */
const BLANK_QUESTION_TEXT = "Advisor error: question must not be blank.";
/** The text a consultation that started an Advisor and failed prints. */
const ADVISOR_FAILURE_TEXT = "Advisor unavailable: the provider refused the request.";

test("the note arrives after eight tool results, last in the request, and is never stored", async () => {
  await withHarness({}, async (harness) => {
    await harness.prompt();
    assert.equal(harness.reminders(await harness.request()).length, 0, "a fresh task says nothing");

    await harness.results(ADVISOR_CADENCE_RESULTS - 1);
    assert.equal(
      harness.reminders(await harness.request()).length,
      0,
      "one result short of the cadence presents nothing",
    );

    await harness.results(1);
    const presented = await harness.request();
    assert.equal(harness.reminders(presented).length, 1);
    assert.equal(presented.at(-1)?.role, "custom", "appended last, after the transcript");
    // The stored transcript, the policy delivery that every request carries, and the note.
    assert.equal(presented.length, harness.transcript().length + 2);
    assert.equal(harness.reminderText(presented), renderAdvisorNote());
    assert.match(harness.reminderText(presented) ?? "", /not from the user/);
    assert.match(harness.reminderText(presented) ?? "", /adds no authority/);

    // The host converts the custom message to user text; the stored request copy keeps its role.
    const converted = convertToLlm(presented);
    assert.equal(converted.at(-1)?.role, "user");
    assert.deepEqual(converted.at(-1)?.content, [{ type: "text", text: renderAdvisorNote() }]);
    assert.equal(presented.at(-1)?.role, "custom");

    assert.equal(harness.appended(), 0, "the note writes no session entry");
    assert.deepEqual(harness.branch, []);
  });
});

test("a retry of the same request keeps the note and one request never carries two", async () => {
  await withHarness({}, async (harness) => {
    await harness.prompt();
    await harness.results(ADVISOR_CADENCE_RESULTS * 2);
    const presented = await harness.request();
    assert.equal(harness.reminders(presented).length, 1, "many results in one round are one note");
    assert.equal(presented.length, harness.transcript().length + 2);
    // A retry of that request carries no new result and keeps the same presentation.
    const retried = await harness.request();
    assert.equal(harness.reminders(retried).length, 1);
    assert.equal(harness.reminderText(retried), harness.reminderText(presented));

    // Presenting starts the count over: the next note needs the whole cadence again.
    await harness.results(ADVISOR_CADENCE_RESULTS - 1);
    assert.equal(harness.reminders(await harness.request()).length, 0);
    await harness.results(1);
    assert.equal(harness.reminders(await harness.request()).length, 1);
  });
});

test("the triggers the note replaced present nothing, and only the cadence does", async () => {
  await withHarness({}, async (harness) => {
    await harness.prompt();
    // The first orientation result no longer presents anything.
    await harness.toolResult("read");
    assert.equal(harness.reminders(await harness.request()).length, 0);

    // Two failing rounds of the same tool no longer present anything either.
    await harness.toolResult("grep", true);
    assert.equal(harness.reminders(await harness.request()).length, 0);
    await harness.toolResult("grep", true);
    assert.equal(harness.reminders(await harness.request()).length, 0);
    await harness.toolResult("grep", true);
    assert.equal(harness.reminders(await harness.request()).length, 0);

    // Four results are already counted, so the cadence needs the rest of its eight.
    await harness.results(ADVISOR_CADENCE_RESULTS - 4);
    assert.equal(harness.reminders(await harness.request()).length, 1);
  });
});

test("a consultation attempt ends the note for the task, even when it fails", async () => {
  await withHarness(
    { config: { ...defaults, advisorLaunch: "tool" }, activeTools: ["consult_advisor"] },
    async (harness) => {
      await harness.prompt();
      await harness.toolCall("consult_advisor", { question: "Is this the right approach?" });
      await harness.consultationResult(true, "the Advisor could not be reached");
      await harness.results(ADVISOR_CADENCE_RESULTS * 2);
      assert.equal(
        harness.reminders(await harness.request()).length,
        0,
        "a failed attempt is spent for the task, so no note invites a retry",
      );
    },
  );
});

test("a control action does not end the note and an Advisor launch does", async () => {
  await withHarness({}, async (harness) => {
    await harness.prompt();
    // A management action names no launch, so it is not a consultation attempt.
    await harness.toolCall("subagent", { action: "status" });
    await harness.results(ADVISOR_CADENCE_RESULTS);
    assert.equal(harness.reminders(await harness.request()).length, 1);

    await harness.settled();
    await harness.prompt();
    await harness.toolCall("subagent", {
      tasks: [{ agent: ADVISOR_AGENT, model: "example/advisor:high", task: "Review the plan." }],
    });
    await harness.results(ADVISOR_CADENCE_RESULTS);
    assert.equal(harness.reminders(await harness.request()).length, 0);
  });
});

test("no note without an active launcher, a valid Advisor, the level on, or outside a task", async () => {
  // Role launch needs the host subagent tool among the active tools.
  await withHarness({ activeTools: [] }, async (harness) => {
    await harness.prompt();
    await harness.results(ADVISOR_CADENCE_RESULTS);
    assert.equal(harness.reminders(await harness.request()).length, 0);
  });

  // Tool launch needs consult_advisor; the other launcher does not stand in for it.
  await withHarness(
    { config: { ...defaults, advisorLaunch: "tool" }, activeTools: ["subagent"] },
    async (harness) => {
      await harness.prompt();
      await harness.results(ADVISOR_CADENCE_RESULTS);
      assert.equal(harness.reminders(await harness.request()).length, 0);
    },
  );

  // The level off says nothing at all, and an Advisor that cannot run is not a consultation path.
  for (const options of [
    {},
    { config: { ...defaults, advisorMode: "off" as const } },
    { config: { ...defaults, advisors: [{ provider: "example", model: "missing" }] } },
  ]) {
    await withHarness(options, async (harness) => {
      if (!options.config) await writeLevel({ level: "off" });
      await harness.prompt();
      await harness.results(ADVISOR_CADENCE_RESULTS);
      assert.equal(harness.reminders(await harness.request()).length, 0);
    });
  }

  // Results reported outside an operative task are counted by nothing.
  await withHarness({}, async (harness) => {
    await harness.results(ADVISOR_CADENCE_RESULTS);
    assert.equal(harness.reminders(await harness.request()).length, 0);
  });
});

test("a forked main session keeps the note and only a marked child process loses it", async () => {
  // `/fork` and `/clone` write the same session header, so it is not a child marker.
  await withHarness({ parentSession: "/sessions/parent.jsonl" }, async (harness) => {
    await harness.prompt();
    await harness.results(ADVISOR_CADENCE_RESULTS);
    assert.equal(harness.reminders(await harness.request()).length, 1);
  });

  // The documented `pi-subagents` process markers do identify a child. They are set inside the
  // harness, which clears them for every other case, and restored before it returns.
  for (const marker of [{ PI_SUBAGENT_CHILD: "1" }, { PI_SUBAGENT_RUNNER_PID: "4242" }]) {
    await withHarness({}, async (harness) => {
      const previous = Object.fromEntries(
        Object.keys(marker).map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, marker);
      try {
        await harness.prompt();
        await harness.results(ADVISOR_CADENCE_RESULTS);
        assert.equal(harness.reminders(await harness.request()).length, 0);
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  }
});

test("a branch move drops the task and a configuration change drops a pending note", async () => {
  await withHarness({}, async (harness) => {
    await harness.prompt();
    await harness.results(ADVISOR_CADENCE_RESULTS);
    await harness.tree();
    assert.equal(harness.reminders(await harness.request()).length, 0);

    // A configuration change invalidates the note for the task: a presentation already sent stays
    // consumed and a pending trigger is dropped.
    await harness.prompt();
    await harness.results(ADVISOR_CADENCE_RESULTS);
    assert.equal(harness.reminders(await harness.request()).length, 1);
    await harness.config({ ...defaults, advisors: [medium] });
    assert.equal(harness.reminders(await harness.request()).length, 0);
  });
});

test("neither note nor refusal names a count or a way out that skips the consultation", () => {
  for (const note of [renderAdvisorNote(), renderAdvisorHoldWarning()]) {
    assert.doesNotMatch(note, /\d/, note);
    assert.doesNotMatch(note, /repeat|again and it will run|retry/i, note);
  }
  for (const launcher of ["role", "tool"] as const) {
    const message = gateMessage(launcher);
    assert.doesNotMatch(message, /\d/, launcher);
    assert.doesNotMatch(message, /repeat this call/i, launcher);
    assert.doesNotMatch(message, /repeat|again and it will run|retry/i, launcher);
    assert.match(message, /Not an error: this call was not run/, launcher);
    // The failure clause asks for a person too, and names no way out either. Its count comes from
    // the constant, so this test reads the clause instead of repeating the number of failures.
    const broken = gateMessage(launcher, false, true);
    assert.doesNotMatch(broken, /\d/, launcher);
    assert.doesNotMatch(broken, /repeat|again and it will run|retry/i, launcher);
    assert.ok(broken.includes(failureRunClause()), launcher);
    assert.match(broken, /ask the user and stop/, launcher);
    assert.match(broken, /^Not an error: this call was not run/, launcher);
  }
  assert.match(gateMessage("tool"), /consult_advisor\(\)/, "tool launch names its own tool");
  assert.match(gateMessage("role"), /async: false/, "role launch names the one field that answers");
});

test("the extension no longer registers the settle boundary", async () => {
  await withHarness({}, async (harness) => {
    assert.equal(harness.handlers.has("agent_before_settle"), false);
    assert.equal(harness.handlers.has("agent_settled"), true, "the task still ends on settle");
  });
});

test("level off presents nothing, refuses nothing and writes no gate record", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "off" });
    await harness.prompt();
    await harness.results(ADVISOR_CADENCE_RESULTS * 2);
    assert.equal(harness.reminders(await harness.request()).length, 0);
    for (let index = 0; index < GATE_HOLD_CHANGES + 2; index += 1)
      assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `change ${index + 1}`);
    await harness.settled();
    assert.deepEqual(await logEventsNamed("gate"), []);
  });
});

test("standard presents the periodic note and never refuses a call", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "standard" });
    await harness.prompt();
    for (let index = 0; index < GATE_HOLD_CHANGES + 2; index += 1) {
      assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `change ${index + 1}`);
      await harness.toolResult("edit");
    }
    assert.equal(harness.reminderText(await harness.request()), renderAdvisorNote());
    await harness.settled();
    assert.deepEqual(await logEventsNamed("gate"), [], "a level that holds nothing writes no gate");
  });
});

test("strict and guard let five changes run and hold the sixth, seventh and eighth", async () => {
  for (const level of ["strict", "guard"] as const) {
    await withHarness({}, async (harness) => {
      await writeLevel({ level });
      await harness.prompt();
      for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
        assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `${level}: ${index}`);

      const refused = await harness.toolCall("edit", SMALL_EDIT);
      assert.equal(refused?.block, true, `${level}: the sixth change is held`);
      assert.equal(refused?.reason, gateMessage("role"), `${level}: one refusal, one text`);
      // A refused change is not counted, and repeating it does not unblock it.
      assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true, `${level}: seventh`);
      assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true, `${level}: eighth`);

      // Reading is never affected, including while the gate holds.
      assert.equal(await harness.toolCall("read", { path: "src/a.ts" }), undefined);

      // Only a consultation the host answered inside the call opens the gate, and only its own
      // details prove it: the text the child printed proves nothing.
      await harness.toolCall("subagent", FOREGROUND_CONSULT);
      await harness.consultationResult(false, "the Advisor answered", {
        details: ANSWERED_ROLE_DETAILS,
      });
      assert.equal(
        await harness.toolCall("edit", SMALL_EDIT),
        undefined,
        `${level}: the answer covers the changes made so far`,
      );
    });
  }
});

test("a ?? prompt holds the first change at any level, and only while an Advisor can answer", async () => {
  for (const level of ["off", "standard", "strict"] as const) {
    await withHarness({}, async (harness) => {
      await writeLevel({ level });
      await harness.prompt("interactive", "?? Change the parser");
      assert.equal(await harness.toolCall("read", { path: "src/a.ts" }), undefined, level);
      const refused = await harness.toolCall("edit", SMALL_EDIT);
      assert.equal(refused?.block, true, `${level}: the first change is held`);
      assert.equal(refused?.reason, gateMessage("role"));
      // Nothing changed yet, so the warning about changes already made is never presented.
      assert.equal(harness.reminders(await harness.request()).length, 0, level);

      await harness.toolCall("subagent", FOREGROUND_CONSULT);
      await harness.consultationResult(false, "the Advisor answered", {
        details: ANSWERED_ROLE_DETAILS,
      });
      assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `${level}: answered`);
    });
  }
  // With no launcher there is nothing to consult, so the prefix holds nothing.
  await withHarness({ activeTools: [] }, async (harness) => {
    await harness.prompt("interactive", "?? Change the parser");
    assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined);
  });
});

test("three allowed changes earn the hold warning, and a new task earns another", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    await harness.prompt();
    for (let index = 0; index < 3; index += 1) await harness.toolCall("edit", SMALL_EDIT);
    const warned = await harness.request();
    assert.equal(harness.reminderText(warned), renderAdvisorHoldWarning());
    // The next request is a retry of the same one and carries it again.
    assert.equal(harness.reminders(await harness.request()).length, 1);

    // A new task starts with nothing counted, so its first three changes earn the warning again.
    await harness.settled();
    await harness.prompt();
    for (let index = 0; index < 3; index += 1) await harness.toolCall("edit", SMALL_EDIT);
    assert.equal(harness.reminderText(await harness.request()), renderAdvisorHoldWarning());
  });
});

test("the hold warning is presented once per run of changes, not once per request", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    await harness.prompt();
    for (let index = 0; index < 3; index += 1) await harness.toolCall("edit", SMALL_EDIT);
    assert.equal(harness.reminderText(await harness.request()), renderAdvisorHoldWarning());
    // A request that follows a new tool result starts a new round, so it is not a retry of the one
    // that carried the warning: it carries nothing.
    await harness.toolResult("edit");
    assert.equal(
      harness.reminders(await harness.request()).length,
      0,
      "the warning is presented once for this run of changes",
    );
  });
});

test("a failed consultation attempt does not cost the task its hold warning", async () => {
  await withHarness(
    { config: { ...defaults, advisorLaunch: "tool" }, activeTools: ["consult_advisor"] },
    async (harness) => {
      await writeLevel({ level: "strict" });
      await harness.prompt();
      // The first thing this task does is try to consult, and the attempt fails after reaching an
      // Advisor. An attempt ends the periodic note for the task; it says nothing about the warning
      // the gate earns later.
      await harness.toolCall("consult_advisor", { question: "Is this the right approach?" });
      await harness.consultationResult(false, ADVISOR_FAILURE_TEXT, {
        details: FAILED_TOOL_DETAILS,
      });
      assert.equal(
        harness.reminders(await harness.request()).length,
        0,
        "a failed attempt is not a note of its own",
      );

      // Three changes the gate lets through still earn the hold warning.
      for (let index = 0; index < GATE_WARN_CHANGES; index += 1)
        await harness.toolCall("edit", SMALL_EDIT);
      assert.equal(
        harness.reminderText(await harness.request()),
        renderAdvisorHoldWarning(),
        "the attempt did not take the warning away",
      );
      const answered = await harness.request();
      assert.equal(
        harness.reminders(answered).length,
        1,
        "and it is presented once, not per retry",
      );

      // An answer covers the changes made so far, and the next run of changes earns the warning
      // again: a task that consulted once can still cross the threshold.
      await harness.toolResult("edit");
      assert.equal(harness.reminders(await harness.request()).length, 0);
      await harness.toolCall("consult_advisor", { question: "Is this the right approach?" });
      await harness.consultationResult(false, "Consultation complete", {
        details: ANSWERED_TOOL_DETAILS,
      });
      for (let index = 0; index < GATE_WARN_CHANGES; index += 1)
        await harness.toolCall("edit", SMALL_EDIT);
      assert.equal(harness.reminderText(await harness.request()), renderAdvisorHoldWarning());
    },
  );
});

test("a run of failures keeps the hold, is reported once, and an answer reopens the gate", async () => {
  await withHarness(
    { config: { ...defaults, advisorLaunch: "tool" }, activeTools: ["consult_advisor"] },
    async (harness) => {
      await writeLevel({ level: "strict" });
      await harness.prompt();
      for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
        await harness.toolCall("edit", SMALL_EDIT);
      assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);

      // The reviewed blocker: the host flags no error, the printed text reads like a failure, and
      // the only slot never completed. That slot is positive evidence an Advisor started and did
      // not answer: a failure, not an answer, so the gate stays where it was, and one failure is
      // not worth telling the operator about.
      await harness.toolCall("consult_advisor", {});
      await harness.consultationResult(false, ADVISOR_FAILURE_TEXT, {
        details: FAILED_TOOL_DETAILS,
      });
      assert.equal(
        (await harness.toolCall("edit", SMALL_EDIT))?.block,
        true,
        "failure text is not an answer",
      );
      assert.equal(
        harness.notifications.length,
        0,
        "one failure is not worth telling the operator",
      );

      // The second such failure is reported once, and nothing is released: the task waits for a
      // person, which is the one release the model cannot forge.
      await harness.toolCall("consult_advisor", {});
      await harness.consultationResult(false, ADVISOR_FAILURE_TEXT, {
        details: FAILED_TOOL_DETAILS,
      });
      const warnings = harness.notifications.filter(({ type }) => type === "warning");
      assert.equal(warnings.length, 1, "the second failure in a row is reported once");
      // The notice names the level, the launcher and the closed statuses it saw, says the task stays
      // held, and lists the three things a person can do. It carries no error text of its own.
      const notice = warnings[0]?.message ?? "";
      assert.match(notice, /^Advisor level strict: the tool launcher started an Advisor/);
      // The notice states the pair from the constant, so it cannot describe a run of another size.
      assert.match(
        notice,
        new RegExp(`no answer in ${GATE_CONSULT_FAILURES} consultations in a row`),
      );
      assert.match(notice, /statuses: blocked/);
      assert.match(notice, /The task stays held/);
      assert.match(notice, /fix the Advisor/);
      assert.match(notice, /change the level with \/delegate/);
      assert.match(notice, /cancel the task/);
      assert.doesNotMatch(notice, /provider refused/);
      assert.doesNotMatch(notice, new RegExp(SMALL_EDIT.edits[0]!.newText));

      // Every change is refused, however many times the model tries: the pair changed the refusal
      // and the notice, and passed nothing.
      for (let index = 1; index <= GATE_HOLD_CHANGES; index += 1)
        assert.equal(
          (await harness.toolCall("edit", SMALL_EDIT))?.block,
          true,
          `change ${index}: the hold never releases`,
        );
      const refusal = await harness.toolCall("edit", SMALL_EDIT);
      assert.equal(refusal?.block, true);
      assert.equal(
        refusal?.reason,
        gateMessage("tool", false, true),
        "the refusal keeps its shape and adds the one clause that asks for a person",
      );

      // A third failure is not a pair of its own and is not reported again.
      await harness.toolCall("consult_advisor", {});
      await harness.consultationResult(false, ADVISOR_FAILURE_TEXT, {
        details: FAILED_TOOL_DETAILS,
      });
      assert.equal(
        harness.notifications.filter(({ type }) => type === "warning").length,
        1,
        "a third failure is not reported again",
      );

      // A new pair is reported again, and the task is still held.
      await harness.toolCall("consult_advisor", {});
      await harness.consultationResult(false, ADVISOR_FAILURE_TEXT, {
        details: FAILED_TOOL_DETAILS,
      });
      assert.equal(
        harness.notifications.filter(({ type }) => type === "warning").length,
        2,
        "a later pair is reported again",
      );
      assert.equal(
        (await harness.toolCall("edit", SMALL_EDIT))?.block,
        true,
        "and the held task keeps waiting for a person",
      );

      // An answered result opens the gate and the count starts over.
      await harness.toolCall("consult_advisor", {});
      await harness.consultationResult(false, "Consultation complete", {
        details: ANSWERED_TOOL_DETAILS,
      });
      for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
        assert.equal(
          await harness.toolCall("edit", SMALL_EDIT),
          undefined,
          `change ${index} after the answer`,
        );
      const heldAgain = await harness.toolCall("edit", SMALL_EDIT);
      assert.equal(heldAgain?.block, true);
      assert.equal(
        heldAgain?.reason,
        gateMessage("tool"),
        "the answer removed the clause from the refusal as well",
      );
    },
  );
});

test("a consultation the host flagged as an error answers nothing", async () => {
  await withHarness(
    { config: { ...defaults, advisorLaunch: "tool" }, activeTools: ["consult_advisor"] },
    async (harness) => {
      await writeLevel({ level: "strict" });
      await harness.prompt();
      for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
        await harness.toolCall("edit", SMALL_EDIT);
      assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);

      // The error flag wins even over details that would otherwise prove an answer: a result the
      // host reports as an error is a failure, and the gate stays where it was.
      await harness.toolCall("consult_advisor", {});
      await harness.consultationResult(true, "the provider refused", {
        details: ANSWERED_TOOL_DETAILS,
      });
      assert.equal(
        (await harness.toolCall("edit", SMALL_EDIT))?.block,
        true,
        "an error opens nothing, whatever the details say",
      );
    },
  );
});

test("a call that consulted nobody counts nothing and says nothing", async () => {
  await withHarness(
    { config: { ...defaults, advisorLaunch: "tool" }, activeTools: ["consult_advisor"] },
    async (harness) => {
      await writeLevel({ level: "strict" });
      await harness.prompt();
      for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
        await harness.toolCall("edit", SMALL_EDIT);
      assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);

      // The bypass this rule closes: two calls that consult nobody cost no state change, so a model
      // could free itself from every future hold with two of them. Both carry the details the tool
      // writes for an early exit, and neither is a failure, a warning or a way out. The third case is
      // the defect this rule exists for: a non-empty slot list from a first turn with no brief.
      for (const details of [
        NOT_RUN_DETAILS,
        NOT_RUN_DETAILS,
        UNDISPATCHED_TOOL_DETAILS,
        UNDISPATCHED_TOOL_DETAILS,
      ]) {
        await harness.toolCall("consult_advisor", {});
        await harness.consultationResult(false, BLANK_QUESTION_TEXT, { details });
      }
      assert.equal(
        (await harness.toolCall("edit", SMALL_EDIT))?.block,
        true,
        "a hold no Advisor was reached through is still a hold",
      );
      assert.equal(
        harness.notifications.filter(({ type }) => type === "warning").length,
        0,
        "a call that consulted nobody is neither a failure nor a shape to warn about",
      );
    },
  );
});

test("an unreadable result counts nothing and leaves the hold", async () => {
  await withHarness(
    { config: { ...defaults, advisorLaunch: "tool" }, activeTools: ["consult_advisor"] },
    async (harness) => {
      await writeLevel({ level: "strict" });
      await harness.prompt();
      for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
        await harness.toolCall("edit", SMALL_EDIT);
      assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);

      // A shape this version cannot read is no evidence either: it proves no launch, so it counts
      // nothing, the hold stands, and there is nothing new to tell the operator about.
      await harness.toolCall("consult_advisor", {});
      await harness.consultationResult(false, "Consultation complete", {
        details: UNREADABLE_DETAILS,
      });
      assert.equal(
        (await harness.toolCall("edit", SMALL_EDIT))?.block,
        true,
        "nothing this reader cannot read is a way out of the hold",
      );
      assert.equal(
        harness.notifications.filter(({ type }) => type === "warning").length,
        0,
        "a shape this reader cannot read is not a failure, so it is not reported as one",
      );

      // A second one says nothing new either, and the hold is still where it was.
      await harness.toolCall("consult_advisor", {});
      await harness.consultationResult(false, "Consultation complete", {
        details: UNREADABLE_DETAILS,
      });
      assert.equal(
        (await harness.toolCall("edit", SMALL_EDIT))?.block,
        true,
        "and the task is still held while the way out is unreadable",
      );
    },
  );
});

test("a background Advisor launch runs before the hold and is refused inside it", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    await harness.prompt();
    // Before the hold a background launch is what the policy asks for: it runs, it covers nothing,
    // and it counts no change.
    for (const launch of [
      { tasks: FOREGROUND_CONSULT.tasks },
      { async: true, tasks: FOREGROUND_CONSULT.tasks },
    ])
      assert.equal(await harness.toolCall("subagent", launch), undefined, JSON.stringify(launch));
    for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
      assert.equal(
        await harness.toolCall("edit", SMALL_EDIT),
        undefined,
        `change ${index}: the launches counted nothing`,
      );
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);

    // While the gate holds, the same launch is refused with the one field that makes it answer:
    // in `role` launch, the foreground form the policy permits.
    for (const launch of [
      { tasks: FOREGROUND_CONSULT.tasks },
      { async: true, tasks: FOREGROUND_CONSULT.tasks },
    ]) {
      const refused = await harness.toolCall("subagent", launch);
      assert.equal(refused?.block, true, JSON.stringify(launch));
      assert.match(refused?.reason ?? "", /async: false/);
      assert.doesNotMatch(refused?.reason ?? "", /consult_advisor\(\) instead/);
    }
    // A refusal counted no change either, so the gate is exactly where it was.
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);
  });
});

test("role mode opens the gate only from a foreground launch whose own result answered", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    await harness.prompt();
    for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
      await harness.toolCall("edit", SMALL_EDIT);
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);
    // The answer must come from the call that was accepted in the foreground, so it is the call's
    // own tool-result id that counts.
    await harness.consultationResult(false, "the Advisor answered", {
      toolCallId: "never-launched",
      details: ANSWERED_ROLE_DETAILS,
    });
    assert.equal(
      (await harness.toolCall("edit", SMALL_EDIT))?.block,
      true,
      "a result with no foreground launch covers nothing",
    );
    // A foreground launch whose one child exited non-zero answered nothing, whatever text it
    // printed: only the child's own result proves an answer.
    await harness.toolCall("subagent", FOREGROUND_CONSULT);
    await harness.consultationResult(false, "the Advisor answered", {
      details: FAILED_ROLE_DETAILS,
    });
    assert.equal(
      (await harness.toolCall("edit", SMALL_EDIT))?.block,
      true,
      "a foreground launch whose child failed answered nothing",
    );
    // One whose child ended cleanly and left output does answer.
    await harness.toolCall("subagent", FOREGROUND_CONSULT);
    await harness.consultationResult(false, "the Advisor answered", {
      details: ANSWERED_ROLE_DETAILS,
    });
    assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined);
  });
});

test("a launch that is not a consultation counts as a change and gets no async rule", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    await harness.prompt();
    for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
      await harness.toolCall("edit", SMALL_EDIT);
    // An ordinary launch is a change like any unknown tool: the change that reaches the hold is
    // refused by the gate, and the refusal is the gate's text, not the consultation correction.
    const refused = await harness.toolCall("subagent", ORDINARY_LAUNCH);
    assert.equal(refused?.block, true);
    assert.equal(refused?.reason, gateMessage("role"));
  });
});

/**
 * The real defect this covers: a held task consulted the Advisors the way the policy asks, in one
 * parallel call, and the host started every child as its own `subagent_launch` call. Those children
 * were classified as changes, so only the first one ran, the call failed, and the hold stood with no
 * way out. Three Advisors, three slots, one call.
 */
const PARALLEL_ADVISORS = {
  async: false,
  workflow: "parallel",
  args: {
    tasks: [1, 2, 3].map((slot) => ({
      agent: ADVISOR_AGENT,
      model: "example/advisor:high",
      task: `Advisor ${slot}: review the change.`,
    })),
  },
};
const THREE_ADVISORS: GlobalDefaults = { ...defaults, advisors: [advisor, advisor, advisor] };
/** The child the host starts for one of those Advisors, as the nested call reports it. */
const advisorChild = (workflowRunId: string, key: string, overrides = {}) => ({
  workflowRunId,
  key,
  agent: ADVISOR_AGENT,
  model: "example/advisor:high",
  ...overrides,
});

test("a parallel workflow of Advisors consults, and every child it starts is part of it", async () => {
  await withHarness({ config: THREE_ADVISORS }, async (harness) => {
    await writeLevel({ level: "strict" });
    await harness.prompt();
    for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
      assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `change ${index}`);
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true, "the hold is reached");

    // The consultation itself is never a change, however many Advisors it names.
    assert.equal(await harness.toolCall("subagent", PARALLEL_ADVISORS), undefined);
    const parent = harness.lastCall()!;
    // Every child of that call is part of the consultation: one refused child would fail the call
    // and leave the hold with nothing that answers it.
    for (const key of ["task-1", "task-2", "task-3"])
      assert.equal(
        await harness.toolCall("subagent_launch", advisorChild(parent, key)),
        undefined,
        key,
      );
    // One Advisor answered, read from the host's per-child results: the hold lifts.
    await harness.toolResult("subagent", false, {
      toolCallId: parent,
      details: { mode: "workflow", ...roleDetails({ exitCode: 0, finalOutput: "ADVICE" }) },
    });
    assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined);
  });
});

test("a child of a consultation is exempt only with the profile the host resolves", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    await harness.prompt();
    for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
      await harness.toolCall("edit", SMALL_EDIT);
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);

    await harness.toolCall("subagent", PARALLEL_ADVISORS);
    const parent = harness.lastCall()!;
    // An Advisor's profile with another model is not that Advisor, and neither is an ordinary child
    // riding on the same call: both are changes like any other call, so the hold refuses them.
    for (const [why, child] of [
      ["another model", advisorChild(parent, "task-1", { model: "example/small:high" })],
      // The host appends a thinking level, and only a level this product knows is that suffix:
      // anything else is part of the model id, so it names no slot and is no part of the call.
      [
        "a suffix that is not a thinking level",
        advisorChild(parent, "task-1", { model: "example/advisor:loquesea" }),
      ],
      ["an ordinary profile", advisorChild(parent, "task-1", { agent: "worker" })],
      ["no model at all", advisorChild(parent, "task-1", { model: undefined })],
    ] as const) {
      const refused = await harness.toolCall("subagent_launch", child);
      assert.equal(refused?.block, true, why);
      assert.equal(refused?.reason, gateMessage("role"), why);
    }
    // A child whose parent is not a consultation this task launched is no part of one.
    const stray = await harness.toolCall("subagent_launch", advisorChild("no-such-call", "task-1"));
    assert.equal(stray?.block, true, "a call id the task never consulted with proves nothing");
  });
});

test("a failed workflow result proves nothing, so it lifts no hold", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    await harness.prompt();
    for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
      await harness.toolCall("edit", SMALL_EDIT);
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);
    // The host turns a logical failure into a thrown tool error, and an errored result carries no
    // details: nothing there proves an Advisor started, so the hold stays and nothing is reported.
    // Two of them in a row are what the operator notice is made of, so a reader that took one for a
    // launch that had failed would warn here and tell the model the way out looks broken.
    for (const attempt of [1, 2]) {
      await harness.toolCall("subagent", PARALLEL_ADVISORS);
      const parent = harness.lastCall()!;
      await harness.toolResult("subagent", true, { toolCallId: parent, details: {} });
      assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true, `attempt ${attempt}`);
    }
    assert.equal(
      harness.notifications.filter(({ type }) => type === "warning").length,
      0,
      "an unreadable result is not evidence that an Advisor started",
    );
  });
});

test("a launch that mixes an Advisor with a worker is a change, not a consultation", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    await harness.prompt();
    const mixed = {
      async: false,
      tasks: [...FOREGROUND_CONSULT.tasks, ...ORDINARY_LAUNCH.tasks],
    };
    // Before the hold it runs and is counted like any other change.
    assert.equal(await harness.toolCall("subagent", mixed), undefined);
    for (let index = 2; index < GATE_HOLD_CHANGES; index += 1)
      assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `change ${index}`);
    // At the hold it is refused by the gate, so a worker cannot ride on a consultation.
    const refused = await harness.toolCall("subagent", mixed);
    assert.equal(refused?.block, true);
    assert.equal(refused?.reason, gateMessage("role"));
  });
});

test("a role refusal asks for the foreground as its own rule, and so does the redirect", () => {
  const message = gateMessage("role");
  assert.match(message, /in the foreground \(async: false\)/);
  assert.doesNotMatch(message, /Roles section/, "the policy asks for background launches");
  assert.match(gateMessage("tool", true), /with a question/);
  assert.doesNotMatch(gateMessage("tool", true), /needs no arguments/);
});

test("a ?? task that changed nothing reports no change", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "off" });
    await harness.prompt("interactive", "?? Change the parser");
    // A request is what logs the policy the record is bound to, so the turn is a real one.
    await harness.request();
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);
    await harness.settled();
    const [record] = await logEventsNamed("gate");
    assert.equal(record?.changes, 0);
    assert.equal(record?.totalChanges, 0);
    assert.equal(record?.holds, 1);
  });
});

test("in tool launch the background refusal names the consultation tool, not a subagent launch", async () => {
  await withHarness(
    {
      config: { ...defaults, advisorLaunch: "tool" },
      activeTools: ["consult_advisor", "subagent"],
    },
    async (harness) => {
      await writeLevel({ level: "strict" });
      await harness.prompt();
      for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
        assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `change ${index}`);
      const refused = await harness.toolCall("subagent", { tasks: FOREGROUND_CONSULT.tasks });
      assert.equal(refused?.block, true);
      // The policy forbids launching Advisors with the subagent tool in this mode, so the way out
      // is the tool that does launch them here.
      assert.match(refused?.reason ?? "", /consult_advisor\(\) instead/);
      assert.doesNotMatch(refused?.reason ?? "", /async: false/);
    },
  );
});

test("no level refuses anything without a valid Advisor, the launcher or in a child process", async () => {
  for (const options of [
    { activeTools: [] as string[] },
    { config: { ...defaults, advisors: [{ provider: "example", model: "missing" }] } },
  ]) {
    await withHarness(options, async (harness) => {
      await writeLevel({ level: "strict" });
      await harness.prompt();
      for (let index = 0; index < GATE_HOLD_CHANGES + 2; index += 1)
        assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `change ${index + 1}`);
    });
  }

  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      await harness.prompt();
      for (let index = 0; index < GATE_HOLD_CHANGES + 2; index += 1)
        assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `change ${index + 1}`);
    } finally {
      delete process.env.PI_SUBAGENT_CHILD;
    }
  });
});

test("the level frozen when a task opens survives a change during it", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    await harness.prompt();
    for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
      await harness.toolCall("edit", SMALL_EDIT);
    // Turning the level off during the task stops the note, but the task keeps the level it opened
    // under, so the gate still holds the change it was already counting.
    await writeLevel({ level: "off" });
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);
    await harness.settled();

    // The next task opens under the new level and refuses nothing.
    await harness.prompt();
    for (let index = 0; index < GATE_HOLD_CHANGES + 2; index += 1)
      assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `change ${index + 1}`);
  });
});

test("a gate record closes with the task and carries counts, never content", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    await harness.prompt();
    // A request is what logs the policy the record is bound to, so the turn is a real one.
    await harness.request();
    for (let index = 0; index < GATE_WARN_CHANGES; index += 1)
      await harness.toolCall("edit", SMALL_EDIT);
    assert.equal(harness.reminderText(await harness.request()), renderAdvisorHoldWarning());
    // The next request is a retry of that one and carries the same warning again. It is one note
    // presented once, not two, so the record counts it as one.
    assert.equal(harness.reminderText(await harness.request()), renderAdvisorHoldWarning());
    // Two more changes reach the hold, and the change after them is the one refused.
    for (let index = GATE_WARN_CHANGES; index < GATE_HOLD_CHANGES - 1; index += 1)
      await harness.toolCall("edit", SMALL_EDIT);
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);
    await harness.toolCall("subagent", FOREGROUND_CONSULT);
    await harness.consultationResult(false, "the Advisor answered", {
      details: ANSWERED_ROLE_DETAILS,
    });
    await harness.settled();

    const [record] = await logEventsNamed("gate");
    assert.equal(record?.changes, 0, "the answer reset the count");
    assert.equal(record?.totalChanges, GATE_HOLD_CHANGES - 1);
    assert.equal(record?.holds, 1);
    assert.equal(record?.answers, 1);
    assert.equal(record?.failures, 0);
    assert.equal(record?.notes, 1, "the warning the model was shown, counted once across a retry");
    assert.equal(record?.advisorLevel, "strict");
    const text = await readFile(getEventLogPath(getGlobalConfigPath()), "utf8");
    assert.doesNotMatch(text, /src\/a\.ts|oldText|newText/);
  });
});

test("a presentation this task already spent is not resurrected by a later trigger", () => {
  const state = new AdvisorReminderState();
  state.openTask();
  for (let index = 0; index < ADVISOR_CADENCE_RESULTS; index += 1) state.noteResult();
  assert.ok(state.presentation(1), "the cadence arms the note");
  assert.equal(state.presentations, 1);
  state.suspend();
  // The spent cadence is not handed back to a retry of the same round, or to any later one.
  assert.equal(state.presentation(2), undefined);
  // A hold warning armed afterwards is its own note: an attempt ends the periodic note, never this
  // one, because the warning is about changes made since and a task can cross the hold again.
  state.armHoldWarning();
  const hold = state.presentation(3);
  assert.ok(hold, "the hold warning is armed while the task is open");
  assert.equal("content" in hold ? hold.content : undefined, renderAdvisorHoldWarning());
  assert.equal(state.presentations, 2, "and it is a second presentation, counted as one");
});

// The writer cases below make a path inaccessible by putting a regular file where a directory is
// expected. Linux then reports ENOTDIR and Windows reports ENOENT for the same situation, and both
// mean the state file does not exist: it is absent, never an unknown state to preserve.
test("a path component that is a file is an absent state file", () => {
  for (const code of ["ENOENT", "ENOTDIR"]) {
    assert.equal(isAbsentPathError(Object.assign(new Error(code), { code })), true, code);
  }
  assert.equal(isAbsentPathError(Object.assign(new Error("EACCES"), { code: "EACCES" })), false);
  assert.equal(isAbsentPathError(new Error("no code")), false);
});

test("the reminder writer stores the mode, keeps an unknown state and reports a failed write", async () => {
  await withAgentDirectory(async (directory) => {
    const path = getAdvisorRemindersPath(getGlobalConfigPath(directory));
    // Absent means the default, and storing the default writes nothing new.
    assert.deepEqual(await readAdvisorReminderMode(path), { mode: DEFAULT_ADVISOR_REMINDER_MODE });
    assert.equal(await writeAdvisorReminderMode("off", path), "saved");
    assert.deepEqual(await readAdvisorReminderMode(path), { mode: "off" });
    assert.equal(await writeAdvisorReminderMode("off", path), "unchanged");

    // A malformed or future file is reported and left alone.
    const malformed = '{ "schemaVersion": 1, "mode": "off"';
    await writeFile(path, malformed);
    assert.equal(await writeAdvisorReminderMode("remind", path), "unknown-state");
    assert.equal(await readFile(path, "utf8"), malformed);
    const future = JSON.stringify({ schemaVersion: 9, mode: "remind" });
    await writeFile(path, future);
    assert.equal(await writeAdvisorReminderMode("off", path), "unknown-state");
    assert.equal(await readFile(path, "utf8"), future);

    // An unreadable state suspends the reminder with a diagnostic instead of the default.
    const loaded = await readAdvisorReminderMode(path);
    assert.equal(loaded.mode, "off");
    assert.match(loaded.diagnostic?.message ?? "", /advisor-reminders\.json/);

    // A replacement that cannot commit reports failure and leaves the readable state in place.
    await writeFile(path, JSON.stringify({ schemaVersion: 1, mode: "remind" }));
    const blocked = join(directory, "blocked");
    await writeFile(blocked, "not a directory");
    assert.equal(
      await writeAdvisorReminderMode(
        "off",
        join(blocked, "delegation-policy.advisor-reminders.json"),
      ),
      "failed",
    );
    assert.deepEqual(await readAdvisorReminderMode(path), { mode: "remind" });
  });
});

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_END = "\x1b[F";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";

type InteractiveComponent = {
  handleInput?: (data: string) => void;
  render: (width: number) => string[];
  isDirty?: () => boolean;
};

function sendKeys(component: InteractiveComponent, ...keys: string[]): void {
  for (const key of keys) component.handleInput?.(key);
}

function createPanelHarness(
  options: {
    advisorLevel?: DelegatePanelOptions["advisorLevel"];
    advisorLevelInvalid?: DelegatePanelOptions["advisorLevelInvalid"];
    onSaveAdvisorLevel?: DelegatePanelOptions["onSaveAdvisorLevel"];
    onSaveDefaults?: DelegatePanelOptions["onSaveDefaults"];
  } = {},
) {
  const done: string[] = [];
  const panel = new DelegatePanel({
    tui: { terminal: { rows: 30 }, requestRender: () => undefined } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    global: defaults,
    session: { schemaVersion: CURRENT_SCHEMA_VERSION },
    candidates: models as never,
    diagnostics: [],
    hasRuntimeError: false,
    onApply: async () => true,
    onSaveDefaults: options.onSaveDefaults ?? (async () => ({ kind: "saved", defaults })),
    advisorLevel: options.advisorLevel,
    advisorLevelInvalid: options.advisorLevelInvalid,
    onSaveAdvisorLevel: options.onSaveAdvisorLevel,
    onDone: (result) => done.push(result),
  });
  panel.focused = true;
  return { panel, done };
}

/**
 * The nudge row sits six rows above the last one: the guard consult switch, launch correction, then
 * the four actions.
 */
function focusNudgeRow(panel: InteractiveComponent): void {
  sendKeys(panel, KEY_END, KEY_UP, KEY_UP, KEY_UP, KEY_UP, KEY_UP, KEY_UP);
}

test("the panel shows the nudge level, stores it on Apply and leaves it alone on Cancel", async () => {
  await withAgentDirectory(async (directory) => {
    // The level reader takes the config path and derives its companion from it, like the writer.
    const configPath = getGlobalConfigPath(directory);
    await writeConfig(configPath, defaults);
    const applied: Array<Record<string, unknown>> = [];
    const applyContext = {
      cwd: "/project",
      hasUI: true,
      mode: "tui",
      scopedModels: [],
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        find: (provider: string, id: string) =>
          models.find((candidate) => candidate.provider === provider && candidate.id === id),
        getAvailable: () => models,
        hasConfiguredAuth: () => true,
      },
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        notify: () => undefined,
        setStatus: () => undefined,
        custom: <T>(
          factory: (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (result: T) => void,
          ) => unknown,
        ) =>
          new Promise<T>((resolve, reject) => {
            const component = factory(
              { terminal: { rows: 30 }, requestRender: () => undefined },
              {
                fg: (_color: string, text: string) => text,
                bg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              {},
              resolve,
            ) as InteractiveComponent;
            try {
              focusNudgeRow(component);
              const settings = component.render(100).join("\n");
              assert.match(settings, /^> Advisor nudge\s+standard · default\s*$/m);
              assert.match(
                settings,
                /How hard the policy pushes the main agent to consult Advisors/,
              );
              sendKeys(component, KEY_ENTER);
              const picker = component.render(140).join("\n");
              assert.match(picker, /Delegation policy \/ Advisor nudge \(global\)/);
              assert.match(
                picker,
                /strict: warns after a few changes with no consultation, then holds every change/,
              );
              assert.match(
                picker,
                /off: only the written rules, with no note\. It holds nothing unless a prompt starts with \?\?/,
              );
              sendKeys(component, KEY_DOWN, KEY_ENTER);
              // The staged level is shown at once; the source is still the absent file.
              assert.match(
                component.render(100).join("\n"),
                /^> Advisor nudge\s+strict · default\s*$/m,
              );
              sendKeys(component, "a");
            } catch (error) {
              reject(error as Error);
            }
          }),
      },
    } as unknown as ExtensionContext;
    await openDelegateEditor(applyContext, {
      appendEntry: (customType: string, data?: unknown) =>
        applied.push({ type: "custom", customType, data }),
    } as never);
    assert.equal((await readAdvisorLevelFile(configPath)).file.level, "strict");

    // Reopening shows the stored mode; cancelling a staged change writes nothing.
    let reopened = "";
    const cancelContext = {
      ...applyContext,
      ui: {
        ...applyContext.ui,
        custom: <T>(
          factory: (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (result: T) => void,
          ) => unknown,
        ) =>
          new Promise<T>((resolve) => {
            const component = factory(
              { terminal: { rows: 30 }, requestRender: () => undefined },
              {
                fg: (_color: string, text: string) => text,
                bg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              {},
              resolve,
            ) as InteractiveComponent;
            focusNudgeRow(component);
            reopened = component.render(100).join("\n");
            sendKeys(component, KEY_ENTER, KEY_UP, KEY_ENTER, KEY_ESCAPE);
            sendKeys(component, KEY_DOWN, KEY_ENTER);
          }),
      },
    } as unknown as ExtensionContext;
    await openDelegateEditor(cancelContext, { appendEntry: () => undefined } as never);
    assert.match(reopened, /^> Advisor nudge\s+strict · global\s*$/m);
    assert.equal((await readAdvisorLevelFile(configPath)).file.level, "strict");
  });
});

test("a failed nudge write stops Apply and names what was saved", async () => {
  const { panel, done } = createPanelHarness({ onSaveAdvisorLevel: async () => "failed" });
  focusNudgeRow(panel);
  sendKeys(panel, KEY_ENTER, KEY_DOWN, KEY_ENTER, "a");
  await new Promise((resolve) => setImmediate(resolve));
  const view = panel.render(140).join("\n");
  assert.match(view, /Could not save the Advisor nudge level\. Nothing else was changed\./);
  assert.deepEqual(done, [], "the editor stays open instead of reporting success");
  assert.match(view, /^> Advisor nudge\s+strict · default\s*$/m);

  // An unreadable companion keeps the level it falls back to and says the file is invalid, never
  // presenting the fallback as a level the user chose.
  const invalid = createPanelHarness({ advisorLevel: "off", advisorLevelInvalid: true });
  focusNudgeRow(invalid.panel);
  assert.match(invalid.panel.render(120).join("\n"), /^> Advisor nudge\s+Invalid · standard\s*$/m);

  // An unreadable file is reported by name instead of being overwritten.
  const blocked = createPanelHarness({ onSaveAdvisorLevel: async () => "unknown-state" });
  focusNudgeRow(blocked.panel);
  sendKeys(blocked.panel, KEY_ENTER, KEY_DOWN, KEY_ENTER, "a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(
    blocked.panel.render(160).join("\n"),
    /Advisor nudge level file is unreadable or invalid; fix or remove delegation-policy\.advisor-level\.json/,
  );
});

test("a nudge level saved before a failing defaults step is named, not denied", async () => {
  const { panel } = createPanelHarness({
    onSaveAdvisorLevel: async () => "saved",
    onSaveDefaults: async () => ({ kind: "unchanged" }),
  });
  focusNudgeRow(panel);
  sendKeys(panel, KEY_ENTER, KEY_DOWN, KEY_ENTER);
  // The level is staged but not written yet; saving the defaults writes it first.
  sendKeys(panel, KEY_END, KEY_UP, KEY_UP, KEY_ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  const view = panel.render(160).join("\n");
  assert.match(
    view,
    /Could not save global defaults\. The Advisor nudge level \(strict\) was saved\./,
  );
  assert.doesNotMatch(view, /Nothing was changed on disk/);
});

/** The guard companion: the user's own switch, read when the task opens. */
async function writeGuard(consultBeforeFirstChange: boolean): Promise<void> {
  await writeFile(
    getGuardModePath(getGlobalConfigPath()),
    JSON.stringify({ schemaVersion: 1, consultBeforeFirstChange }),
  );
}

test("guard holds nothing before the first change unless the user asks for it", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "guard" });
    await harness.prompt();
    // Off is the default, and the switch is what holds: the level alone lets the first change run.
    assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined);
  });
});

test("the guard switch holds the first change until a consultation answers", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "guard" });
    await writeGuard(true);
    await harness.prompt();
    const held = await harness.toolCall("edit", SMALL_EDIT);
    assert.equal(held?.block, true);
    assert.equal(held?.reason, gateMessage("role"));
    // Reading is never affected by any hold.
    assert.equal(await harness.toolCall("read", { path: "src/a.ts" }), undefined);
    await harness.toolCall("subagent", FOREGROUND_CONSULT);
    const parent = harness.lastCall()!;
    await harness.toolResult("subagent", false, {
      toolCallId: parent,
      details: ANSWERED_ROLE_DETAILS,
    });
    assert.equal(
      await harness.toolCall("edit", SMALL_EDIT),
      undefined,
      "the answer opens the hold",
    );
    // The count of the level applies after that answer: the 6th change since it is held again.
    for (let index = 2; index < GATE_HOLD_CHANGES; index += 1)
      assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `change ${index}`);
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);
  });
});

test("the guard switch leaves strict alone", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "strict" });
    await writeGuard(true);
    await harness.prompt();
    // It is a `guard` switch: `strict` keeps its own count and holds no first change.
    assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined);
    for (let index = 2; index < GATE_HOLD_CHANGES; index += 1)
      assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `change ${index}`);
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);
  });
});

/**
 * A corrupt companion is information, not a broken axis: the switch resolves to its default, which is
 * off, and nothing else about the level, delegation or the Advisor changes.
 */
test("an invalid guard file turns the switch off without breaking either axis", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "guard" });
    await writeFile(getGuardModePath(getGlobalConfigPath()), "{ not json");
    await harness.prompt();
    assert.equal(
      await harness.toolCall("edit", SMALL_EDIT),
      undefined,
      "an unreadable file leaves the switch off, so the task is not held",
    );
    // `/delegate status` is the line that reports every token, and it is answered by the same
    // runtime the hooks use.
    await harness.command("status");
    const status = harness.notifications.at(-1)?.message ?? "";
    assert.doesNotMatch(status, /D:ERR|A:ERR/, "neither axis is reported broken");
    assert.match(status, /Guard settings are invalid and were ignored/);
    assert.match(status, /guard-consult=off \(invalid\)/);
    // The footer keeps both axes alive too.
    assert.equal(harness.status(), "D:NORM A:ON");
    // The level itself is untouched: it still holds at its own count.
    for (let index = 2; index < GATE_HOLD_CHANGES; index += 1)
      assert.equal(await harness.toolCall("edit", SMALL_EDIT), undefined, `change ${index}`);
    assert.equal((await harness.toolCall("edit", SMALL_EDIT))?.block, true);
  });
});

test("the guard switch acts in no subagent child", async () => {
  await withHarness({}, async (harness) => {
    await writeLevel({ level: "guard" });
    await writeGuard(true);
    const previous = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      await harness.prompt();
      assert.equal(
        await harness.toolCall("edit", SMALL_EDIT),
        undefined,
        "a child has no user to ask and no task of its own to hold",
      );
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previous;
    }
  });
});

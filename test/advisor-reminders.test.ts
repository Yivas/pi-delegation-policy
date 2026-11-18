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
  ADVISOR_REMINDER_TYPE,
  DEFAULT_ADVISOR_REMINDER_MODE,
  getAdvisorRemindersPath,
  readAdvisorReminderMode,
  renderAdvisorReminder,
  writeAdvisorReminderMode,
} from "../src/advisor-reminders.ts";
import { getGlobalConfigPath, isAbsentPathError, writeConfig } from "../src/config.ts";
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
  const prompt = async (source = "interactive"): Promise<void> => {
    await handler("input")({ type: "input", text: "Run the task", source }, ctx);
    await handler("before_agent_start")({ type: "before_agent_start" }, ctx);
  };
  const toolCall = async (toolName: string, input: Record<string, unknown> = {}): Promise<void> => {
    callId += 1;
    await handler("tool_call")(
      { type: "tool_call", toolCallId: `call-${callId}`, toolName, input },
      ctx,
    );
  };
  const toolResult = async (toolName: string, isError = false): Promise<void> => {
    callId += 1;
    await handler("tool_result")(
      {
        type: "tool_result",
        toolCallId: `call-${callId}`,
        toolName,
        input: {},
        content: [{ type: "text", text: "body" }],
        isError,
      },
      ctx,
    );
  };
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
    transcript,
    request,
    prompt,
    toolCall,
    toolResult,
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

test("one successful orientation round presents the reminder once, in the next request", async () => {
  await withHarness({}, async (harness) => {
    await harness.prompt();
    assert.equal(harness.reminders(await harness.request()).length, 0, "no orientation yet");

    await harness.toolResult("read");
    const presented = await harness.request();
    assert.equal(harness.reminders(presented).length, 1);
    assert.equal(presented.at(-1)?.role, "custom", "appended last, after the transcript");
    assert.equal(presented.length, harness.transcript().length + 1);
    assert.equal(harness.reminderText(presented), renderAdvisorReminder());
    assert.match(harness.reminderText(presented) ?? "", /not from the user/);
    assert.match(harness.reminderText(presented) ?? "", /adds no authority/);

    // The host converts the custom message to user text; the stored request copy keeps its role.
    const converted = convertToLlm(presented);
    assert.equal(converted.at(-1)?.role, "user");
    assert.deepEqual(converted.at(-1)?.content, [{ type: "text", text: renderAdvisorReminder() }]);
    assert.equal(presented.at(-1)?.role, "custom");

    // A later round of the same task never re-arms it, even after another orientation result.
    await harness.toolResult("edit");
    assert.equal(harness.reminders(await harness.request()).length, 0);
    await harness.toolResult("grep");
    assert.equal(harness.reminders(await harness.request()).length, 0);

    // A new task starts from zero, and the reminder is never stored in the session.
    await harness.settled();
    await harness.prompt();
    await harness.toolResult("read");
    assert.equal(harness.reminders(await harness.request()).length, 1);
    assert.equal(harness.appended(), 0, "the reminder writes no session entry");
    assert.deepEqual(harness.branch, []);
  });
});

test("a retry of the same request keeps the reminder and a batch is one round", async () => {
  await withHarness({}, async (harness) => {
    await harness.prompt();
    // Two orientation results in one batch are one round, so the reminder waits for the next one.
    await harness.toolResult("read");
    await harness.toolResult("grep");
    const first = await harness.request();
    assert.equal(harness.reminders(first).length, 1);
    // A retry of that same request carries no new tool result and keeps the same presentation.
    assert.equal(harness.reminders(await harness.request()).length, 1);
    // Turning it off and on again in the same round does not present a second line: the sent
    // presentation is spent for the task, while a plain retry above still reused it.
    const path = getAdvisorRemindersPath(getGlobalConfigPath());
    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, mode: "off" })}\n`);
    assert.equal(harness.reminders(await harness.request()).length, 0);
    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, mode: "remind" })}\n`);
    assert.equal(harness.reminders(await harness.request()).length, 0);
    // The next round does not re-arm it either.
    await harness.toolResult("ls");
    assert.equal(harness.reminders(await harness.request()).length, 0);
  });
});

test("two failing rounds of the same builtin tool trigger the reminder, one batch does not", async () => {
  await withHarness({}, async (harness) => {
    await harness.prompt();
    await harness.toolResult("grep", true);
    await harness.toolResult("grep", true);
    assert.equal(
      harness.reminders(await harness.request()).length,
      0,
      "two failures in one round are one batch",
    );
    await harness.toolResult("grep", true);
    assert.equal(harness.reminders(await harness.request()).length, 1);
  });
});

test("an attempted consultation suppresses the reminder even when it fails", async () => {
  await withHarness(
    { config: { ...defaults, advisorLaunch: "tool" }, activeTools: ["consult_advisor"] },
    async (harness) => {
      await harness.prompt();
      await harness.toolCall("consult_advisor", { question: "Is this the right approach?" });
      await harness.toolResult("consult_advisor", true);
      await harness.toolResult("read");
      assert.equal(harness.reminders(await harness.request()).length, 0);
    },
  );
});

test("a role-mode consultation attempt suppresses the reminder and a control action does not", async () => {
  await withHarness({}, async (harness) => {
    await harness.prompt();
    await harness.toolCall("subagent", { action: "status" });
    await harness.toolResult("read");
    assert.equal(
      harness.reminders(await harness.request()).length,
      1,
      "a control action that names no launch is not a consultation",
    );

    await harness.settled();
    await harness.prompt();
    await harness.toolCall("subagent", {
      tasks: [{ agent: ADVISOR_AGENT, model: "example/advisor:high", task: "Review the plan." }],
    });
    await harness.toolResult("read");
    assert.equal(harness.reminders(await harness.request()).length, 0);
  });
});

test("no reminder without an active launcher, a valid Advisor, or the setting on", async () => {
  // Role launch needs the host subagent tool among the active tools.
  await withHarness({ activeTools: [] }, async (harness) => {
    await harness.prompt();
    await harness.toolResult("read");
    assert.equal(harness.reminders(await harness.request()).length, 0);
  });

  // Tool launch needs consult_advisor; the other launcher does not stand in for it.
  await withHarness(
    { config: { ...defaults, advisorLaunch: "tool" }, activeTools: ["subagent"] },
    async (harness) => {
      await harness.prompt();
      await harness.toolResult("read");
      assert.equal(harness.reminders(await harness.request()).length, 0);
    },
  );

  // Advisor off, and both axes off, add nothing.
  for (const config of [
    { ...defaults, advisorMode: "off" as const },
    { ...defaults, advisorMode: "off" as const, intensity: "off" as const },
  ]) {
    await withHarness({ config }, async (harness) => {
      await harness.prompt();
      await harness.toolResult("read");
      assert.equal(harness.reminders(await harness.request()).length, 0);
    });
  }

  // The global setting off adds nothing, and an invalid file suspends only the reminder.
  await withHarness({}, async (harness) => {
    const path = getAdvisorRemindersPath(getGlobalConfigPath());
    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, mode: "off" })}\n`);
    await harness.prompt();
    await harness.toolResult("read");
    assert.equal(harness.reminders(await harness.request()).length, 0);

    await writeFile(path, '{ "schemaVersion": 1, "mode": "remind"');
    await harness.toolResult("read");
    assert.equal(harness.reminders(await harness.request()).length, 0);
    assert.equal(harness.status(), "D:NORM A:ON", "the axes are untouched");
    await harness.command("status");
    assert.match(
      harness.notifications.at(-1)?.message ?? "",
      /advisor-reminders\.json/,
      "the invalid file is reported without changing either axis",
    );
    assert.equal(await readFile(path, "utf8"), '{ "schemaVersion": 1, "mode": "remind"');
  });
});

test("a forked main session keeps the reminder and only a marked child process loses it", async () => {
  // `/fork` and `/clone` write the same session header, so it is not a child marker.
  await withHarness({ parentSession: "/sessions/parent.jsonl" }, async (harness) => {
    await harness.prompt();
    await harness.toolResult("read");
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
        await harness.toolResult("read");
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

test("tool results outside an operative task and after a branch move arm nothing", async () => {
  await withHarness({}, async (harness) => {
    await harness.toolResult("read");
    assert.equal(harness.reminders(await harness.request()).length, 0);

    await harness.prompt();
    await harness.toolResult("read");
    await harness.tree();
    assert.equal(harness.reminders(await harness.request()).length, 0);

    // A configuration change invalidates the reminder for the task: a presentation already sent
    // stays consumed and a pending trigger is dropped.
    await harness.prompt();
    await harness.toolResult("read");
    assert.equal(harness.reminders(await harness.request()).length, 1);
    await harness.config({ ...defaults, advisors: [medium] });
    assert.equal(harness.reminders(await harness.request()).length, 0);
  });
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
    advisorReminder?: DelegatePanelOptions["advisorReminder"];
    advisorReminderInvalid?: DelegatePanelOptions["advisorReminderInvalid"];
    onSaveAdvisorReminder?: DelegatePanelOptions["onSaveAdvisorReminder"];
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
    advisorReminder: options.advisorReminder,
    advisorReminderInvalid: options.advisorReminderInvalid,
    onSaveAdvisorReminder: options.onSaveAdvisorReminder,
    onDone: (result) => done.push(result),
  });
  panel.focused = true;
  return { panel, done };
}

/** The reminder row sits five rows above the last one: launch correction, then the four actions. */
function focusReminderRow(panel: InteractiveComponent): void {
  sendKeys(panel, KEY_END, KEY_UP, KEY_UP, KEY_UP, KEY_UP, KEY_UP);
}

test("the panel shows the reminder mode, stores it on Apply and leaves it alone on Cancel", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);
    const path = getAdvisorRemindersPath(getGlobalConfigPath(directory));
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
              focusReminderRow(component);
              const settings = component.render(100).join("\n");
              assert.match(settings, /^> Advisor reminder\s+remind · global\s*$/m);
              assert.match(settings, /Global for every session; Apply or Save stores it/);
              sendKeys(component, KEY_ENTER);
              const picker = component.render(100).join("\n");
              assert.match(picker, /Delegation policy \/ Advisor reminder \(global\)/);
              assert.match(picker, /off — never add the reminder/);
              assert.match(picker, /launches no consultation, forces none/);
              sendKeys(component, KEY_DOWN, KEY_ENTER);
              assert.match(
                component.render(100).join("\n"),
                /^> Advisor reminder\s+off · global\s*$/m,
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
    assert.deepEqual(await readAdvisorReminderMode(path), { mode: "off" });

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
            focusReminderRow(component);
            reopened = component.render(100).join("\n");
            sendKeys(component, KEY_ENTER, KEY_UP, KEY_ENTER, KEY_ESCAPE);
            sendKeys(component, KEY_DOWN, KEY_ENTER);
          }),
      },
    } as unknown as ExtensionContext;
    await openDelegateEditor(cancelContext, { appendEntry: () => undefined } as never);
    assert.match(reopened, /^> Advisor reminder\s+off · global\s*$/m);
    assert.deepEqual(await readAdvisorReminderMode(path), { mode: "off" });
  });
});

test("a failed reminder write stops Apply and names what was saved", async () => {
  const { panel, done } = createPanelHarness({ onSaveAdvisorReminder: async () => "failed" });
  focusReminderRow(panel);
  sendKeys(panel, KEY_ENTER, KEY_DOWN, KEY_ENTER, "a");
  await new Promise((resolve) => setImmediate(resolve));
  const view = panel.render(140).join("\n");
  assert.match(view, /Could not save the Advisor reminder mode\. Nothing else was changed\./);
  assert.deepEqual(done, [], "the editor stays open instead of reporting success");
  assert.match(view, /^> Advisor reminder\s+off · global\s*$/m);

  // An unreadable companion is shown as suspended, never as a mode the user chose.
  const suspended = createPanelHarness({ advisorReminder: "off", advisorReminderInvalid: true });
  focusReminderRow(suspended.panel);
  assert.match(
    suspended.panel.render(120).join("\n"),
    /^> Advisor reminder\s+Unavailable\/Suspended · global\s*$/m,
  );

  // An unreadable file is reported by name instead of being overwritten.
  const blocked = createPanelHarness({ onSaveAdvisorReminder: async () => "unknown-state" });
  focusReminderRow(blocked.panel);
  sendKeys(blocked.panel, KEY_ENTER, KEY_DOWN, KEY_ENTER, "a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(
    blocked.panel.render(160).join("\n"),
    /Advisor reminder file is unreadable or invalid; fix or remove delegation-policy\.advisor-reminders\.json/,
  );
});

test("a reminder saved before a failing defaults step is named, not denied", async () => {
  const { panel } = createPanelHarness({
    onSaveAdvisorReminder: async () => "saved",
    onSaveDefaults: async () => ({ kind: "unchanged" }),
  });
  focusReminderRow(panel);
  sendKeys(panel, KEY_ENTER, KEY_DOWN, KEY_ENTER);
  // The reminder is staged but not written yet; saving the defaults writes it first.
  sendKeys(panel, KEY_END, KEY_UP, KEY_UP, KEY_ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  const view = panel.render(160).join("\n");
  assert.match(
    view,
    /Could not save global defaults\. The Advisor reminder mode \(off\) was saved\./,
  );
  assert.doesNotMatch(view, /Nothing was changed on disk/);
});

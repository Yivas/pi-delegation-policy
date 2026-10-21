import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  convertToLlm,
  type ContextWithSystemEvent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BOTH_OFF_LINE,
  CONFIG_NOTICE_TYPE,
  changedValueLines,
  noticeLines,
  projectNoticeConfig,
  renderConfigNotice,
} from "../src/config-notice.ts";
import {
  SESSION_ENTRY_TYPE,
  getGlobalConfigPath,
  resolveDelegateState,
  writeConfig,
} from "../src/config.ts";
import piDelegationPolicy from "../src/index.ts";
import {
  CURRENT_SCHEMA_VERSION,
  type GlobalDefaults,
  type ModelRef,
  type SessionDelegateState,
} from "../src/types.ts";

const small: ModelRef = { provider: "example", model: "small" };
const medium: ModelRef = { provider: "example", model: "medium" };
const large: ModelRef = { provider: "example", model: "large" };
const uiDesign: ModelRef = { provider: "example", model: "ui-design" };
const advisor: ModelRef = { provider: "example", model: "advisor" };
const emptySession: SessionDelegateState = { schemaVersion: CURRENT_SCHEMA_VERSION };

const defaults: GlobalDefaults = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  intensity: "normal",
  small,
  medium,
  large,
  uiDesign,
  thinking: { small: { level: "low" } },
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

const models = [small, medium, large, uiDesign, advisor].map(model);

type StopReason = "stop" | "aborted" | "error";
type Messages = ContextWithSystemEvent["messages"];
type Harness = ReturnType<typeof createHarness>;

async function withAgentDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "config-notice-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    await callback(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function withHarness(
  availableModels: TestModel[],
  callback: (harness: Harness) => Promise<void>,
): Promise<void> {
  await withAgentDirectory(async (directory) => {
    await callback(createHarness(directory, availableModels));
  });
}

/** Drives the registered handlers in the order the host emits them for one run. */
function createHarness(directory: string, availableModels: TestModel[]) {
  const branch: Array<Record<string, unknown>> = [];
  const handlers = new Map<
    string,
    (event: Record<string, unknown>, ctx: ExtensionContext) => unknown
  >();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  let appended = 0;
  const pi = {
    on: (
      name: string,
      handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown,
    ) => handlers.set(name, handler),
    registerTool: () => undefined,
    getAllTools: () => [],
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => commands.set(name, options),
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
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      find: (provider: string, id: string) =>
        availableModels.find((candidate) => candidate.provider === provider && candidate.id === id),
      getAvailable: () => availableModels,
      hasConfiguredAuth: () => true,
    },
    ui: { theme, setStatus: () => undefined, notify: () => undefined },
  } as unknown as ExtensionContext;
  let sessionTokens: number | null = 10_000;
  ctx.getContextUsage = () => ({ tokens: sessionTokens, contextWindow: 1_000_000, percent: null });
  piDelegationPolicy(pi as never);

  const handler = (name: string) => {
    const registered = handlers.get(name);
    if (!registered) throw new Error(`The extension does not register ${name}.`);
    return registered;
  };
  /** The host rebuilds this projection from stored entries for every request. */
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
  /** A fresh prompt: the input event that announces its source, then the run anchor. */
  const prompt = async (source = "interactive"): Promise<void> => {
    await handler("input")({ type: "input", text: "Run the task", source }, ctx);
    await handler("before_agent_start")({ type: "before_agent_start" }, ctx);
  };
  const turn = async (source = "interactive"): Promise<Messages> => {
    await prompt(source);
    return request();
  };
  /** The end of one low-level run, carrying exactly the messages the host would report. */
  const endMessages = async (messages: Array<Record<string, unknown>>): Promise<void> => {
    await handler("agent_end")({ type: "agent_end", messages }, ctx);
  };
  /** One low-level run that ended with that stop reason, which may be followed by more requests. */
  const end = async (stopReason: StopReason): Promise<void> =>
    endMessages([{ role: "assistant", content: [], stopReason, timestamp: 3 }]);
  const settled = async (): Promise<void> => {
    await handler("agent_settled")({ type: "agent_settled" }, ctx);
  };
  /** One run that ended with that outcome and then settled. */
  const finish = async (stopReason: StopReason = "stop"): Promise<void> => {
    await end(stopReason);
    await settled();
  };
  const start = async (reason = "startup"): Promise<void> => {
    await handler("session_start")({ type: "session_start", reason }, ctx);
  };
  const tree = async (): Promise<void> => {
    await handler("session_tree")({ type: "session_tree" }, ctx);
  };
  const shutdown = async (): Promise<void> => {
    await handler("session_shutdown")({ type: "session_shutdown" }, ctx);
  };
  const command = async (args: string): Promise<void> => {
    const registered = commands.get("delegate");
    if (!registered) throw new Error("The extension does not register /delegate.");
    await registered.handler(args, ctx);
  };
  const config = (values: GlobalDefaults) => writeConfig(getGlobalConfigPath(directory), values);
  const setSessionTokens = (tokens: number | null) => {
    sessionTokens = tokens;
  };
  const setBranch = (entries: Array<Record<string, unknown>>) => {
    branch.splice(0, branch.length, ...entries);
  };
  const noticeMessage = (messages: Messages) => {
    const notices = messages.filter(
      (message) => message.role === "custom" && message.customType === CONFIG_NOTICE_TYPE,
    );
    assert.ok(notices.length <= 1, "one request carries at most one notice");
    return notices[0];
  };
  const systemContent = (messages: Messages): string | undefined => {
    const system = messages[0];
    return system?.role === "system" && typeof system.content === "string"
      ? system.content
      : undefined;
  };
  const noticeText = (messages: Messages): string | undefined => {
    const notice = noticeMessage(messages);
    return notice && "content" in notice && typeof notice.content === "string"
      ? notice.content
      : undefined;
  };
  const policyBlock = (messages: Messages): string => {
    const system = messages[0];
    const content = systemContent(messages);
    if (content === undefined || system?.role !== "system") return "";
    const withAddendum = `${content}\n${system.sections?.addendum ?? ""}`;
    return (
      withAddendum.match(
        /<delegation_policy>\n<!-- pi-delegation-policy:owned -->[\s\S]*?<\/delegation_policy>/,
      )?.[0] ?? ""
    );
  };
  const providerPayload = async (payload: unknown): Promise<unknown> =>
    handler("before_provider_request")({ type: "before_provider_request", payload }, ctx);
  const eventLog = async (): Promise<string> => {
    const path = join(directory, "delegation-policy.events.jsonl");
    return readFile(path, "utf8").catch(() => "");
  };

  return {
    branch,
    transcript,
    request,
    prompt,
    turn,
    end,
    endMessages,
    settled,
    finish,
    start,
    tree,
    shutdown,
    command,
    config,
    setSessionTokens,
    setBranch,
    systemContent,
    noticeMessage,
    noticeText,
    policyBlock,
    providerPayload,
    eventLog,
    appended: () => appended,
  };
}

test("the notice projection keeps effective values and their canonical order", () => {
  const effective = resolveDelegateState(
    {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "normal",
      small,
      medium,
      large,
      uiDesign,
      advisors: [{ ...advisor, thinking: { level: "high" } }],
      advisorMode: "on",
      thinking: { small: { min: "low", max: "high" } },
    },
    emptySession,
  );
  assert.deepEqual(projectNoticeConfig(effective), {
    intensity: "normal",
    preference: "standard",
    roles: {
      small: { kind: "model", reference: "example/small" },
      medium: { kind: "model", reference: "example/medium" },
      large: { kind: "model", reference: "example/large" },
    },
    uiDesign: { kind: "model", reference: "example/ui-design" },
    thinking: { small: "range:low..high", medium: null, large: null, uiDesign: null },
    advisors: [{ model: "example/advisor", thinking: "level:high" }],
    advisorMode: "on",
    advisorLaunch: "role",
    context: { mode: "off", readerEnabled: false, readerRole: "small", answerMaxBytes: 8192 },
  });
});

test("a not-configured role and a disabled role are different configurations", () => {
  // Only an unconfigured role raises D:ERR; an explicitly disabled one leaves a valid partial policy.
  const unconfigured = projectNoticeConfig(
    resolveDelegateState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, medium: null, large: null },
      emptySession,
    ),
  );
  const disabled = projectNoticeConfig(
    resolveDelegateState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, small: null, medium: null, large: null },
      emptySession,
    ),
  );
  assert.notDeepEqual(unconfigured, disabled);
  assert.deepEqual(changedValueLines(unconfigured, disabled), [
    "- Small model: not configured -> disabled",
  ]);
  assert.deepEqual(changedValueLines(disabled, disabled), []);
});

test("changed fields report in one order, an Advisor list keeps its position, and a reversion is no change", () => {
  const before = projectNoticeConfig(
    resolveDelegateState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal", small },
      emptySession,
    ),
  );
  const after = projectNoticeConfig(
    resolveDelegateState(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        intensity: "orchestrator",
        preference: "intensive",
        small: medium,
      },
      emptySession,
    ),
  );
  assert.deepEqual(changedValueLines(before, after), [
    "- Delegation intensity: normal -> orchestrator",
    "- Model preference: standard -> intensive",
    "- Small model: example/small -> example/medium",
  ]);
  assert.deepEqual(changedValueLines(after, before), [
    "- Delegation intensity: orchestrator -> normal",
    "- Model preference: intensive -> standard",
    "- Small model: example/medium -> example/small",
  ]);
  assert.deepEqual(changedValueLines(before, before), []);

  const first = { provider: "example", model: "first" };
  const second = { provider: "example", model: "second" };
  const ordered = projectNoticeConfig(
    resolveDelegateState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, advisors: [first, second], advisorMode: "on" },
      emptySession,
    ),
  );
  const swapped = projectNoticeConfig(
    resolveDelegateState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, advisors: [second, first], advisorMode: "on" },
      emptySession,
    ),
  );
  assert.deepEqual(changedValueLines(ordered, swapped), [
    "- Advisor 1 model: example/first -> example/second",
    "- Advisor 2 model: example/second -> example/first",
  ]);
});

test("turning both axes off speaks once and later off values stay silent", () => {
  const active = projectNoticeConfig(
    resolveDelegateState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "aggressive", small },
      emptySession,
    ),
  );
  const off = projectNoticeConfig(
    resolveDelegateState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off", small },
      emptySession,
    ),
  );
  const otherOff = projectNoticeConfig(
    resolveDelegateState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off", small: medium },
      emptySession,
    ),
  );
  assert.deepEqual(
    noticeLines({ previous: active, current: off, previouslyOff: false, currentlyOff: true }),
    [`- ${BOTH_OFF_LINE}`],
  );
  assert.deepEqual(
    noticeLines({ previous: off, current: otherOff, previouslyOff: true, currentlyOff: true }),
    [],
  );
  assert.deepEqual(
    noticeLines({ previous: off, current: otherOff, previouslyOff: false, currentlyOff: true }),
    [`- ${BOTH_OFF_LINE}`],
  );
  const text = renderConfigNotice([`- ${BOTH_OFF_LINE}`]);
  assert.match(text, /from the pi-delegation-policy extension, not from the user/);
  assert.match(text, /revokes no other instruction, permission, or authority/);
  assert.match(text, /disabled by this policy/);
});

test("a session start fixes a silent reference and the first turn carries no notice", async () => {
  await withHarness(models, async (harness) => {
    await harness.config(defaults);
    await harness.start();
    const first = await harness.turn();
    assert.equal(first.length, 2);
    assert.equal(harness.noticeText(first), undefined);
    assert.match(harness.policyBlock(first), /Intensity: normal/);
    await harness.finish();

    await harness.command("orchestrator");
    for (const reason of ["reload", "new", "fork"]) {
      await harness.start(reason);
      const silent = await harness.turn();
      assert.equal(harness.noticeText(silent), undefined, `a ${reason} start is silent`);
      assert.match(harness.policyBlock(silent), /Intensity: orchestrator/);
      await harness.finish();
    }
    await harness.shutdown();
  });
});

test("changes made before a turn arrive as one notice and leave stored history alone", async () => {
  await withHarness(models, async (harness) => {
    await harness.config({ ...defaults, advisors: [advisor], advisorMode: "off" });
    await harness.start();
    await harness.turn();
    await harness.finish();

    await harness.command("orchestrator");
    await harness.command("advisor on");
    await harness.command("advisor launch tool");
    const stored = harness.transcript();
    const appendedBefore = harness.appended();
    await harness.prompt();
    const messages = await harness.request(stored);
    const notice = harness.noticeText(messages);
    assert.ok(notice);
    assert.match(notice, /- Delegation intensity: normal -> orchestrator/);
    assert.match(notice, /- Advisor mode: off -> on/);
    assert.match(notice, /- Advisor launch: role -> tool/);
    assert.equal(messages.length, 3);
    assert.equal(messages[2]!.role, "custom");
    assert.equal(messages[2]!.customType, CONFIG_NOTICE_TYPE);
    // The request transcript the host handed over is untouched, and nothing was persisted.
    assert.equal(stored.length, 2);
    assert.equal(harness.branch.length, 12, "the three commands wrote their guarded entries");
    assert.equal(harness.appended(), appendedBefore);
    const policy = harness.policyBlock(messages);
    assert.match(policy, /Intensity: orchestrator/);
    assert.match(policy, /Advisor consultation:/);
    assert.equal((policy.match(/<delegation_policy>/g) ?? []).length, 1);
    assert.doesNotMatch(await harness.eventLog(), /delegation_config_notice|-> example\//);

    await harness.finish();
    const clean = await harness.turn();
    assert.equal(harness.noticeText(clean), undefined);
    assert.equal(clean.length, 2);
    await harness.shutdown();
  });
});

test("a reverted change or an identical save reports nothing", async () => {
  await withHarness(models, async (harness) => {
    await harness.config(defaults);
    await harness.start();
    await harness.turn();
    await harness.finish();

    await harness.command("aggressive");
    await harness.command("normal");
    assert.equal(harness.noticeText(await harness.turn()), undefined);
    await harness.finish();

    await harness.command("normal");
    await harness.command("status");
    assert.equal(harness.noticeText(await harness.turn()), undefined);
    await harness.finish();

    // Rewriting the global defaults with the same effective values changes only their provenance.
    await harness.config({ ...defaults, preference: "standard" });
    assert.equal(harness.noticeText(await harness.turn()), undefined);
    await harness.shutdown();
  });
});

test("the notice freezes for its turn and a change made during it waits for the next one", async () => {
  await withHarness(models, async (harness) => {
    await harness.config(defaults);
    await harness.start();
    await harness.turn();
    await harness.finish();

    await harness.command("orchestrator");
    const stored = harness.transcript();
    const presented = await harness.turn();
    const frozen = harness.noticeMessage(presented);
    assert.ok(frozen);
    assert.deepEqual(harness.noticeMessage(await harness.request(stored)), frozen);

    await harness.command("aggressive");
    const duringTurn = await harness.request(stored);
    assert.deepEqual(harness.noticeMessage(duringTurn), frozen, "the notice is not rewritten");
    assert.doesNotMatch(harness.noticeText(duringTurn)!, /aggressive/);
    assert.match(harness.policyBlock(duringTurn), /Intensity: aggressive/);
    // The host rebuilds the same stored transcript for every request of the turn.
    assert.equal(stored.length, 2);

    await harness.finish();
    const next = await harness.turn();
    assert.equal(
      harness.noticeText(next),
      renderConfigNotice(["- Delegation intensity: orchestrator -> aggressive"]),
      "completing the turn consumes the presented revision, not the newer one",
    );
    await harness.shutdown();
  });
});

test("an error or an aborted run keeps the change pending", async () => {
  await withHarness(models, async (harness) => {
    await harness.config(defaults);
    await harness.start();
    await harness.turn();
    await harness.finish();

    await harness.command("orchestrator");
    const presented = await harness.turn();
    await harness.finish("error");
    const retried = await harness.turn();
    assert.equal(harness.noticeText(retried), harness.noticeText(presented));

    await harness.command("aggressive");
    // The host settles the run even when the user aborts it, reporting the aborted outcome.
    await harness.finish("aborted");
    const afterAbort = await harness.turn();
    assert.equal(
      harness.noticeText(afterAbort),
      renderConfigNotice(["- Delegation intensity: normal -> aggressive"]),
    );
    await harness.finish();
    assert.equal(harness.noticeText(await harness.turn()), undefined);
    await harness.shutdown();
  });
});

test("the run's last reported outcome decides consumption across retries, unknown ends and the accepted window", async () => {
  await withHarness(models, async (harness) => {
    await harness.config(defaults);
    await harness.start();
    await harness.turn();
    await harness.finish();

    // A retryable error followed by a successful retry of the same run consumes: the model received
    // the notice and produced a completed response.
    await harness.command("orchestrator");
    const beforeRetry = await harness.turn();
    assert.match(
      harness.noticeText(beforeRetry)!,
      /- Delegation intensity: normal -> orchestrator/,
    );
    await harness.end("error");
    await harness.request();
    await harness.end("stop");
    await harness.settled();
    assert.equal(harness.noticeText(await harness.turn()), undefined);
    await harness.finish();

    // A run that reports no assistant message has no outcome to trust, so nothing is consumed.
    await harness.command("aggressive");
    const unknownEnd = await harness.turn();
    await harness.endMessages([]);
    await harness.endMessages([
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [], timestamp: 3 },
    ]);
    await harness.settled();
    const stillPending = await harness.turn();
    assert.equal(harness.noticeText(stillPending), harness.noticeText(unknownEnd));
    await harness.finish();

    // Accepted residual: after a completed response the host reports no further outcome for an
    // abort or a throw, so that completed response is what the final settle sees.
    await harness.command("normal");
    const beforeSilence = await harness.turn();
    assert.match(
      harness.noticeText(beforeSilence)!,
      /- Delegation intensity: aggressive -> normal/,
    );
    await harness.end("stop");
    await harness.settled();
    assert.equal(harness.noticeText(await harness.turn()), undefined);
    await harness.shutdown();
  });
});

test("a completed boundary before a failed continuation does not consume the notice", async () => {
  await withHarness(models, async (harness) => {
    await harness.config(defaults);
    await harness.start();
    await harness.turn();
    await harness.finish();

    await harness.command("orchestrator");
    const presented = await harness.turn();
    // One run: a completed turn, a continued request, and then an aborted turn.
    await harness.end("stop");
    await harness.request();
    await harness.end("aborted");
    await harness.settled();

    const retried = await harness.turn();
    assert.equal(
      harness.noticeText(retried),
      harness.noticeText(presented),
      "the notice stays pending after a failed continuation",
    );
    await harness.finish();
    await harness.shutdown();
  });
});

test("an extension prompt neither receives nor consumes the pending notice", async () => {
  await withHarness(models, async (harness) => {
    await harness.config(defaults);
    await harness.start();
    await harness.turn();
    await harness.finish();

    await harness.command("orchestrator");
    // The extension sends its own user message before the user's next turn.
    const fromExtension = await harness.turn("extension");
    assert.equal(harness.noticeText(fromExtension), undefined);
    assert.match(harness.policyBlock(fromExtension), /Intensity: orchestrator/);
    await harness.finish();

    const fromUser = await harness.turn();
    assert.match(
      harness.noticeText(fromUser)!,
      /- Delegation intensity: normal -> orchestrator/,
      "the pending notice waits for the user",
    );
    await harness.shutdown();
  });
});

test("both axes off report once, then the request carries no policy and no notice", async () => {
  await withHarness(models, async (harness) => {
    await harness.config({ ...defaults, intensity: "aggressive" });
    await harness.start();
    await harness.turn();
    await harness.finish();

    await harness.command("off");
    const offTurn = await harness.turn();
    assert.match(harness.noticeText(offTurn)!, /Delegation and Advisor disabled by this policy\./);
    assert.equal(harness.policyBlock(offTurn), "");
    assert.equal(offTurn.length, 3);
    await harness.finish();

    // A value edit that leaves both axes off changes nothing the model can act on.
    await harness.config({ ...defaults, intensity: "off", small: medium });
    const silent = await harness.turn();
    assert.equal(harness.noticeText(silent), undefined);
    assert.equal(harness.policyBlock(silent), "");
    assert.equal(silent.length, 2);
    await harness.finish();

    const payload = {
      model: "example",
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "Host prompt\n\n<delegation_policy>\n<!-- pi-delegation-policy:owned -->\nIntensity: aggressive.\n</delegation_policy>",
        },
        { role: "user", content: "Run the task" },
        { role: "user", content: harness.noticeText(offTurn) },
      ],
    };
    const repaired = (await harness.providerPayload(payload)) as typeof payload;
    assert.equal(repaired.messages[0]!.content, "Host prompt");
    assert.deepEqual(repaired.messages[2], payload.messages[2]);

    // Re-enabling delegation reports the values that changed while it was off.
    await harness.command("normal");
    const resumed = await harness.turn();
    assert.match(harness.noticeText(resumed)!, /- Delegation intensity: off -> normal/);
    assert.match(harness.noticeText(resumed)!, /- Small model: example\/small -> example\/medium/);
    await harness.shutdown();
  });
});

test("a broken delegation axis reports the change without promising a model", async () => {
  const available = [medium, large, uiDesign, advisor].map(model);
  await withHarness(available, async (harness) => {
    const broken: GlobalDefaults = { ...defaults, advisors: [advisor], advisorMode: "on" };
    await harness.config(broken);
    await harness.start();
    const first = await harness.turn();
    assert.equal(harness.noticeText(first), undefined);
    assert.doesNotMatch(harness.policyBlock(first), /Enabled ordinary roles/);
    assert.match(harness.policyBlock(first), /Advisor consultation:/);
    await harness.finish();

    await harness.config({ ...broken, preference: "intensive" });
    const changed = await harness.turn();
    const notice = harness.noticeText(changed);
    assert.ok(notice);
    assert.match(notice, /- Model preference: standard -> intensive/);
    assert.doesNotMatch(notice, /example\//);
    assert.doesNotMatch(notice, /available|usable/);

    await harness.finish();
    await harness.config({ ...broken, advisors: [{ provider: "example", model: "missing" }] });
    const invalidAdvisor = await harness.turn();
    assert.match(
      harness.noticeText(invalidAdvisor)!,
      /- Advisor 1 model: example\/advisor -> example\/missing/,
    );
    assert.equal(harness.policyBlock(invalidAdvisor), "");

    // Delegation off by configuration while the Advisor stays on but unusable: the policy is not
    // reported as disabling Advisor, because the configuration did not disable it.
    await harness.finish();
    await harness.command("off");
    const advisorStillOn = await harness.turn();
    assert.match(harness.noticeText(advisorStillOn)!, /- Delegation intensity: normal -> off/);
    assert.doesNotMatch(harness.noticeText(advisorStillOn)!, /disabled by this policy/);
    assert.equal(harness.policyBlock(advisorStillOn), "");
    await harness.shutdown();
  });
});

test("session and tree moves reset the reference silently", async () => {
  await withHarness(models, async (harness) => {
    await harness.config(defaults);
    await harness.start();
    await harness.turn();
    await harness.finish();

    await harness.command("orchestrator");
    await harness.tree();
    const afterTree = await harness.turn();
    assert.equal(harness.noticeText(afterTree), undefined);
    assert.match(harness.policyBlock(afterTree), /Intensity: orchestrator/);
    await harness.finish();

    harness.setBranch([
      {
        type: "custom",
        customType: SESSION_ENTRY_TYPE,
        data: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
      },
    ]);
    await harness.tree();
    const afterBranch = await harness.turn();
    assert.equal(harness.noticeText(afterBranch), undefined);
    assert.match(harness.policyBlock(afterBranch), /Intensity: normal/);
    await harness.shutdown();
  });
});

test("a global change that reaches the session is reported on the next turn", async () => {
  await withHarness(models, async (harness) => {
    await harness.config(defaults);
    await harness.start();
    await harness.turn();
    await harness.finish();

    await harness.config({
      ...defaults,
      intensity: "orchestrator",
      medium: small,
      uiDesign: medium,
      thinking: { small: { level: "high" } },
    });
    const messages = await harness.turn();
    assert.equal(
      harness.noticeText(messages),
      renderConfigNotice([
        "- Delegation intensity: normal -> orchestrator",
        "- Medium model: example/medium -> example/small",
        "- Visual Design model: example/ui-design -> example/medium",
        "- Small thinking: fixed low -> fixed high",
      ]),
    );
    await harness.finish();
    await harness.shutdown();
  });
});

test("an Advisor context mode change is not a configuration change", async () => {
  await withHarness(models, async (harness) => {
    await harness.config({ ...defaults, advisors: [advisor], advisorMode: "on" });
    await harness.start();
    const fork = await harness.turn();
    assert.match(harness.policyBlock(fork), /Context for this session: fork/);
    await harness.finish();

    // The Advisor context mode is derived from usage, so it moves without a notice.
    harness.setSessionTokens(900_000);
    const fresh = await harness.turn();
    assert.match(harness.policyBlock(fresh), /Context for this session: fresh/);
    assert.equal(harness.noticeText(fresh), undefined);
    await harness.shutdown();
  });
});

test("the host conversion sends the notice as user text and the repair keeps it intact", async () => {
  await withHarness(models, async (harness) => {
    await harness.config(defaults);
    await harness.start();
    await harness.turn();
    await harness.finish();
    await harness.command("aggressive");

    // A request of the turn after a tool iteration: the notice follows the tool result.
    const stored = structuredClone([
      { role: "system", content: "Host prompt", timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "Run the task" }], timestamp: 2 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }],
        stopReason: "toolUse",
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
        isError: false,
        timestamp: 4,
      },
    ]) as Messages;
    await harness.prompt();
    const messages = await harness.request(stored);
    const text = harness.noticeText(messages);
    assert.ok(text);
    assert.equal(messages.length, 5);
    assert.equal(messages[3]!.role, "toolResult");

    const converted = convertToLlm(messages);
    const last = converted.at(-1)!;
    assert.equal(last.role, "user");
    assert.deepEqual(last.content, [{ type: "text", text }]);
    assert.equal("customType" in last, false);
    assert.equal("details" in last, false);
    assert.equal(converted[0]!.role, "system");
    assert.equal(converted[0]!.content, harness.systemContent(messages));
    assert.equal(converted.length, messages.length);
    assert.equal(converted[2]!.role, "assistant", "the tool call keeps its position");
    assert.match(JSON.stringify(converted[3]!.content), /file body/);
    assert.equal(messages.at(-1)!.role, "custom", "conversion does not rewrite the request copy");

    const payload: {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: unknown }>;
    } = {
      model: "example",
      stream: true,
      messages: [{ role: "system", content: "Host prompt" }, ...converted.slice(1)],
    };
    const repaired = (await harness.providerPayload(payload)) as typeof payload;
    const repairedSystem = String(repaired.messages[0]!.content);
    assert.match(repairedSystem, /pi-delegation-policy:owned/);
    assert.match(repairedSystem, /^Host prompt/);
    assert.deepEqual(repaired.messages.at(-1), payload.messages.at(-1));
    await harness.shutdown();
  });
});

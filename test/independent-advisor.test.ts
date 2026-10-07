import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  appendGuardedSessionState,
  defaultsFromEffectiveState,
  getGlobalConfigPath,
  getAdvisorConfigPath,
  ADVISOR_SESSION_ENTRY_TYPE,
  restoreSessionStateWithDiagnostics,
  parseConfig,
  parseSessionState,
  readConfig,
  resolveDelegateState,
  restoreSessionState,
  SESSION_ENTRY_TYPE,
  writeConfig,
} from "../src/config.ts";
import { DelegatePanel } from "../src/delegate-panel.ts";
import piDelegationPolicy, {
  getArgumentCompletions,
  parseCommand,
  statusText,
} from "../src/index.ts";
import { buildDelegationPolicy } from "../src/prompt.ts";
import {
  readConfig as readPreviousConfig,
  restoreSessionState as restorePreviousSession,
} from "./fixtures/v0.16.0/config.ts";
import {
  advisorStatusLabel,
  hasAdvisorError,
  hasRuntimeError,
  isAdvisorEnabled,
  statusLabel,
  validateRuntime,
  type RuntimeState,
} from "../src/runtime.ts";
import {
  CURRENT_SCHEMA_VERSION,
  type GlobalDefaults,
  type SessionDelegateState,
} from "../src/types.ts";

const advisor = { provider: "example", model: "advisor" };
const ordinary = { provider: "example", model: "worker" };
const advisorModel = { provider: "example", id: "advisor", name: "Advisor", reasoning: true };
const workerModel = { provider: "example", id: "worker", name: "Worker", reasoning: true };
const empty = { schemaVersion: CURRENT_SCHEMA_VERSION };
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
function context(
  branch: unknown[] = [],
  available = [advisorModel],
  auth = true,
): ExtensionContext {
  return {
    cwd: "/project",
    hasUI: true,
    mode: "tui",
    scopedModels: [],
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      find: (provider: string, id: string) =>
        available.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => available,
      hasConfiguredAuth: () => auth,
    },
    ui: { theme, setStatus: () => undefined, notify: () => undefined },
  } as unknown as ExtensionContext;
}
function runtime(
  global: GlobalDefaults,
  session: SessionDelegateState = empty,
  ctx = context(),
): RuntimeState {
  const state: RuntimeState = {
    global,
    session,
    effective: resolveDelegateState(global, session),
    diagnostics: [],
    modelStatuses: new Map(),
    runtimeErrors: [],
  };
  validateRuntime(ctx, state);
  return state;
}
async function withDirectory(callback: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "independent-advisor-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    await callback(getGlobalConfigPath(directory));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
/**
 * A directory at a replacement's temporary path fails exactly one `atomicWrite` for real. The clock
 * is fixed only while the callback runs so the derived temporary name is predictable.
 */
async function blockOneReplacement(path: string, callback: () => Promise<void>): Promise<void> {
  const realNow = Date.now;
  Date.now = () => TEMPORARY_CLOCK;
  try {
    await mkdir(`${path}.${process.pid}.${TEMPORARY_CLOCK}.tmp`);
    await callback();
  } finally {
    Date.now = realNow;
  }
}
const TEMPORARY_CLOCK = 1_700_000_000_000;

test("saving independent Advisor preserves delegation in the previous release", async () => {
  const global: GlobalDefaults = {
    ...empty,
    intensity: "normal",
    small: ordinary,
    medium: null,
    large: null,
    advisor,
    advisorMode: "off",
  };
  await withDirectory(async (path) => {
    await writeConfig(path, global);
    const previous = await readPreviousConfig(path);
    assert.deepEqual(previous.diagnostics, []);
    assert.equal(previous.defaults.intensity, "normal");
    assert.deepEqual(previous.defaults.small, ordinary);
    assert.equal(previous.defaults.advisor, undefined);
    assert.deepEqual((await readConfig(path)).defaults, global);
  });
  const branch: unknown[] = [];
  const session: SessionDelegateState = { ...empty, intensity: "aggressive", advisorMode: "on" };
  assert.equal(
    appendGuardedSessionState(
      {
        appendEntry: (customType, data) => {
          branch.push({ type: "custom", customType, data });
        },
      },
      session,
    ),
    "success",
  );
  assert.equal(restorePreviousSession(branch).intensity, "aggressive");
  assert.deepEqual(restoreSessionState(branch), session);
});

test("an invalid Advisor does not suppress valid delegation", () => {
  const state = runtime(
    {
      ...empty,
      intensity: "normal",
      small: ordinary,
      medium: null,
      large: null,
      advisor,
      advisorMode: "on",
    },
    empty,
    context([], [workerModel]),
  );
  assert.equal(statusLabel(state), "D:NORM");
  assert.equal(advisorStatusLabel(state), "A:ERR");
  assert.match(buildDelegationPolicy(state) ?? "", /Enabled ordinary roles: Small/);
  assert.doesNotMatch(buildDelegationPolicy(state) ?? "", /Advisor consultation:|example\/advisor/);
});

test("Advisor activation is explicit, inherited, and compatible with older schemas", async () => {
  const global: GlobalDefaults = { ...empty, advisor, advisorMode: "on" };
  const inherited = resolveDelegateState(global, empty);
  assert.equal(inherited.intensity, "off");
  assert.equal(isAdvisorEnabled(inherited), true);
  assert.equal(inherited.source.advisorMode, "global");
  assert.equal(defaultsFromEffectiveState(inherited).advisorMode, "on");
  const disabled = resolveDelegateState(global, { ...empty, advisorMode: "off" });
  assert.equal(isAdvisorEnabled(disabled), false);
  assert.deepEqual(disabled.advisor, advisor);
  assert.equal(disabled.source.advisorMode, "session");
  // A branch written by 0.16.0 that removed its Advisor model also removed its consultation.
  const removedForSession = resolveDelegateState(global, { ...empty, advisor: null });
  assert.equal(removedForSession.advisorMode, "off");
  assert.equal(isAdvisorEnabled(removedForSession), false);
  const explicitOn = runtime(global, { ...empty, advisor: null, advisorMode: "on" });
  assert.equal(explicitOn.effective.advisorMode, "on");
  assert.equal(advisorStatusLabel(explicitOn), "A:ERR");
  for (const schemaVersion of [2, 3, 4, 5, 6, 7]) {
    const old = { schemaVersion, ...(schemaVersion === 7 ? { advisor } : {}) };
    const parsed = parseConfig(old)!;
    assert.ok(parsed);
    const effective = resolveDelegateState(parsed, empty);
    assert.equal(effective.advisorMode, "with-delegation");
    assert.equal(isAdvisorEnabled(effective), false);
    assert.equal(defaultsFromEffectiveState(effective).advisorMode, "with-delegation");
    assert.equal(parseConfig({ ...old, advisorMode: "on" }), undefined);
    assert.equal(parseSessionState({ ...old, advisorMode: "on" }), undefined);
  }
  for (const advisorMode of [true, null, "auto", "ON", 1]) {
    assert.equal(parseConfig({ ...global, advisorMode }), undefined);
    assert.equal(parseSessionState({ ...global, advisorMode }), undefined);
  }
  assert.equal(parseConfig({ ...global, schemaVersion: CURRENT_SCHEMA_VERSION + 1 }), undefined);
  await withDirectory(async (path) => {
    const oldText = JSON.stringify({ schemaVersion: 7, advisor, intensity: "off" });
    await writeFile(path, oldText);
    const loaded = await readConfig(path);
    assert.equal(isAdvisorEnabled(resolveDelegateState(loaded.defaults, empty)), false);
    assert.equal(await readFile(path, "utf8"), oldText);
    await writeConfig(path, global);
    assert.deepEqual((await readConfig(path)).defaults, global);
  });
});

test("Advisor-only validates its exact model and thinking without ordinary roles", () => {
  const global: GlobalDefaults = {
    ...empty,
    advisor,
    advisorMode: "on",
    thinking: { advisor: { level: "high" } },
    contextShunt: { mode: "enforce", readerEnabled: true },
  };
  const current = runtime(global);
  assert.deepEqual(current.runtimeErrors, []);
  assert.equal(statusLabel(current), "D:OFF");
  assert.equal(advisorStatusLabel(current), "A:ON");
  assert.equal(current.effective.contextShunt.mode, "off");
  assert.equal(current.effective.contextShunt.suspended, true);
  const policy = buildDelegationPolicy(current)!;
  assert.match(policy, /Delegation intensity: off\. Advisor: on/);
  assert.match(policy, /pi-delegation-policy\.advisor/);
  assert.match(policy, /example\/advisor:high/);
  assert.match(policy, /Advisor consultation:/);
  assert.match(policy, /favor a brief second opinion/);
  assert.match(policy, /normal executor\/provider retention/);
  assert.doesNotMatch(
    policy,
    /Role selection:|Enabled ordinary roles:|- Small:|- Medium:|- Large:|- Visual Design:|Delegate all transferable/,
  );
  assert.equal((policy.match(/<!-- pi-delegation-policy:owned -->/g) ?? []).length, 1);
  const scoped = context();
  scoped.scopedModels = [{ model: workerModel as never, thinkingLevel: "off" }];
  for (const ctx of [context([], []), context([], [advisorModel], false), scoped]) {
    validateRuntime(ctx, current);
    assert.equal(advisorStatusLabel(current), "A:ERR");
    assert.equal(hasRuntimeError(current), false);
    assert.equal(hasAdvisorError(current), true);
    assert.equal(buildDelegationPolicy(current), undefined);
    assert.match(statusText(current), /details=Advisor model/);
    assert.doesNotMatch(statusText(current), /Small model is not configured/);
  }
  current.global.thinking = { advisor: { level: "max" } };
  validateRuntime(context(), current);
  assert.match(current.advisorErrors?.join(" ") ?? "", /Advisor thinking level/);
  assert.equal(buildDelegationPolicy(current), undefined);
  delete current.global.advisor;
  validateRuntime(context(), current);
  assert.deepEqual(current.advisorErrors, ["Advisor model is not configured."]);
});

test("Advisor modes preserve legacy delegation and can silence an invalid saved model", () => {
  for (const intensity of ["off", "normal", "aggressive", "orchestrator"] as const) {
    for (const advisorMode of ["off", "on", "with-delegation"] as const) {
      const current = runtime(
        { ...empty, small: ordinary, medium: null, large: null, advisor },
        { ...empty, intensity, advisorMode },
        context([], [advisorModel, workerModel]),
      );
      const active =
        advisorMode === "on" || (advisorMode === "with-delegation" && intensity !== "off");
      assert.equal(advisorStatusLabel(current), active ? "A:ON" : "A:OFF");
      assert.equal(
        buildDelegationPolicy(current)?.includes("Advisor consultation:") ?? false,
        active,
      );
      if (intensity === "off" && !active) assert.equal(buildDelegationPolicy(current), undefined);
    }
  }
  const disabled = runtime(
    {
      ...empty,
      small: ordinary,
      medium: null,
      large: null,
      advisor,
      thinking: { advisor: { level: "max" } },
    },
    { ...empty, intensity: "normal", advisorMode: "off" },
    context([], [workerModel]),
  );
  assert.equal(hasRuntimeError(disabled), false);
  assert.equal(statusLabel(disabled), "D:NORM");
  assert.doesNotMatch(buildDelegationPolicy(disabled)!, /Advisor consultation:|example\/advisor/);
});

test("an incomplete session write or invalid restoration cannot inherit Advisor on", () => {
  const global: GlobalDefaults = { ...empty, advisor, advisorMode: "on" };
  const entries: unknown[] = [];
  let calls = 0;
  assert.equal(
    appendGuardedSessionState(
      {
        appendEntry(customType, data) {
          if (++calls === 2) throw new Error("simulated disk failure");
          entries.push({ type: "custom", customType, data });
        },
      },
      { ...empty, advisorMode: "on" },
    ),
    "state-failed",
  );
  const session = restoreSessionState(entries);
  assert.equal(session.advisorMode, "off");
  assert.equal(buildDelegationPolicy(runtime(global, session)), undefined);
  const invalid = restoreSessionState([
    { type: "custom", customType: SESSION_ENTRY_TYPE, data: { schemaVersion: 99 } },
  ]);
  assert.equal(isAdvisorEnabled(resolveDelegateState(global, invalid)), false);
});

test("Advisor commands and request hooks independently update and remove the owned block", async () => {
  await withDirectory(async (path) => {
    await writeConfig(path, { ...empty, advisor });
    const branch: Array<Record<string, unknown>> = [];
    const handlers = new Map<
      string,
      (event: Record<string, unknown>, ctx: ExtensionContext) => unknown
    >();
    let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
    const statuses: Array<string | undefined> = [];
    const pi = {
      on: (
        name: string,
        handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown,
      ) => handlers.set(name, handler),
      registerTool: () => undefined,
      getAllTools: () => [],
      registerCommand: (_name: string, options: { handler: typeof command }) => {
        command = options.handler;
      },
      registerShortcut: () => undefined,
      appendEntry: (customType: string, data?: unknown) =>
        branch.push({ type: "custom", customType, data }),
    };
    const ctx = context(branch, [advisorModel, workerModel]);
    ctx.ui.setStatus = (_key, value) => statuses.push(value);
    piDelegationPolicy(pi as never);
    const request = async (instructions: string) =>
      (await handlers.get("before_provider_request")!(
        { payload: { model: "example", stream: true, store: false, instructions } },
        ctx,
      )) as { instructions: string };
    await handlers.get("session_start")!({}, ctx);
    assert.equal(statuses.at(-1), "D:OFF A:OFF");
    await command("advisor on", ctx);
    assert.equal(statuses.at(-1), "D:OFF A:ON");
    const first = await request("Host instructions");
    assert.match(first.instructions, /Advisor consultation:/);
    assert.match(first.instructions, /^Host instructions/);
    assert.equal((await request(first.instructions)).instructions, first.instructions);
    const messages = [
      { role: "system", content: "Host instructions" },
      { role: "user", content: "Question" },
    ];
    const projected = (await handlers.get("context_with_system")!({ messages }, ctx)) as {
      messages: Array<{ sections?: { addendum?: string } }>;
    };
    assert.match(projected.messages[0]!.sections!.addendum!, /Advisor consultation:/);
    assert.equal(messages[0]!.content, "Host instructions");
    await command("off", ctx);
    assert.equal(statuses.at(-1), "D:OFF A:ON");
    for (const event of ["session_start", "session_tree"]) {
      await handlers.get(event)!({}, ctx);
      assert.equal(statuses.at(-1), "D:OFF A:ON");
    }
    await command("advisor off", ctx);
    assert.equal((await request(first.instructions)).instructions, "Host instructions");
    assert.equal(statuses.at(-1), "D:OFF A:OFF");
    await command("advisor on", ctx);
    await command("reset", ctx);
    assert.equal((await request(first.instructions)).instructions, "Host instructions");
    assert.equal(restoreSessionState(branch).advisorMode, "off");
    await command("advisor on", ctx);
    branch.length = 0;
    await handlers.get("session_tree")!({}, ctx);
    assert.equal((await request(first.instructions)).instructions, "Host instructions");
    await writeConfig(path, {
      ...empty,
      small: ordinary,
      medium: null,
      large: null,
      advisor: { provider: "example", model: "missing" },
      advisorMode: "on",
    });
    await command("normal", ctx);
    assert.equal(statuses.at(-1), "D:NORM A:ERR");
    const repaired = await request(first.instructions);
    assert.match(repaired.instructions, /Enabled ordinary roles: Small/);
    assert.doesNotMatch(repaired.instructions, /Advisor consultation:|example\/advisor/);
    assert.match(repaired.instructions, /^Host instructions/);
    await handlers.get("session_shutdown")!({}, ctx);
  });
  for (const mode of ["off", "on", "with-delegation"] as const)
    assert.deepEqual(parseCommand(`advisor ${mode}`), { kind: "advisor-mode", mode });
  for (const input of ["advisor", "advisor auto", "advisor on extra"])
    assert.deepEqual(parseCommand(input), { kind: "invalid" });
  assert.deepEqual(
    getArgumentCompletions("advisor ")?.map(({ value }) => value),
    ["advisor off", "advisor on", "advisor with-delegation"],
  );
});

test("Advisor mode supports keyboard selection, inheritance, bounded render and reset", () => {
  const panel = new DelegatePanel({
    tui: { terminal: { rows: 30 }, requestRender: () => undefined } as never,
    theme: theme as never,
    global: { ...empty, advisor },
    session: empty,
    candidates: [advisorModel as never],
    diagnostics: [],
    hasRuntimeError: false,
    onApply: async () => true,
    onSaveDefaults: async () => ({ kind: "unchanged" }),
    onDone: () => undefined,
  });
  const send = (...keys: string[]) => {
    for (const key of keys) panel.handleInput(key);
  };
  const down = "\x1b[B",
    enter = "\r",
    home = "\x1b[H",
    end = "\x1b[F",
    up = "\x1b[A";
  panel.render(100);
  send(home, ...Array.from({ length: 14 }, () => down));
  assert.match(panel.render(100).join("\n"), /^> Advisor mode\s+with-delegation/m);
  send(enter, down, down, enter);
  assert.equal(panel.getDraft().advisorMode, "on");
  for (const width of [100, 60, 40]) {
    const lines = panel.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.length <= 30);
  }
  assert.match(panel.render(100).join("\n"), /Delegation off · Advisor on · consultation only/);
  send(enter, home, enter);
  assert.equal(panel.getDraft().advisorMode, undefined);
  assert.equal(panel.isDirty(), false);
  send(enter, down, down, enter);
  assert.equal(panel.getDraft().advisorMode, "on");
  send(home, ...Array.from({ length: 12 }, () => down), enter, home, down, enter);
  assert.equal(panel.getDraft().advisor, null);
  assert.equal(panel.getDraft().advisorMode, "off");
  send(end, up, enter);
  assert.equal(panel.getDraft().advisorMode, "off");
});

test("an unusable Advisor companion keeps delegation readable and reports only Advisor", async () => {
  const global: GlobalDefaults = {
    ...empty,
    intensity: "normal",
    small: ordinary,
    medium: null,
    large: null,
    advisor,
    advisorMode: "on",
  };
  await withDirectory(async (path) => {
    await writeConfig(path, global);
    const companionPath = getAdvisorConfigPath(path);
    const original = await readFile(companionPath, "utf8");
    for (const invalid of [
      "broken JSON",
      JSON.stringify({ ...JSON.parse(original), extra: true }),
      JSON.stringify({ ...JSON.parse(original), state: { ...global, advisorMode: "auto" } }),
    ]) {
      await writeFile(companionPath, invalid);
      const loaded = await readConfig(path);
      assert.equal(loaded.defaults.intensity, "normal");
      assert.equal(loaded.defaults.advisorMode, "off");
      assert.equal(loaded.diagnostics[0]?.scope, "advisor");
      const current = runtime(loaded.defaults, empty, context([], [workerModel]));
      current.diagnostics = loaded.diagnostics;
      validateRuntime(context([], [workerModel]), current);
      assert.equal(statusLabel(current), "D:NORM");
      assert.equal(advisorStatusLabel(current), "A:OFF");
      assert.equal(hasAdvisorError(current), false);
      assert.match(statusText(current), /details=Advisor settings are invalid/);
      assert.match(buildDelegationPolicy(current) ?? "", /Enabled ordinary roles: Small/);
      assert.doesNotMatch(buildDelegationPolicy(current) ?? "", /Advisor consultation:/);
    }
  });
});

test("a stale Advisor companion keeps its model and thinking while delegation wins", async () => {
  const global: GlobalDefaults = {
    ...empty,
    intensity: "normal",
    small: ordinary,
    medium: null,
    large: null,
    advisor,
    advisorMode: "on",
    thinking: { advisor: { level: "high" } },
  };
  await withDirectory(async (path) => {
    await writeConfig(path, global);
    const stored = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...stored, intensity: "aggressive" }));
    const loaded = await readConfig(path);
    assert.equal(loaded.defaults.intensity, "aggressive", "the delegation file wins");
    assert.equal(loaded.defaults.advisorMode, "off", "a stale companion cannot activate Advisor");
    assert.deepEqual(loaded.defaults.advisor, advisor);
    assert.deepEqual(loaded.defaults.thinking?.advisor, { level: "high" });
    assert.equal(loaded.diagnostics[0]?.scope, "advisor");
    // Saving the effective state again reparses the pair instead of deleting what it kept.
    const saved = defaultsFromEffectiveState(
      resolveDelegateState(loaded.defaults, { ...empty, advisorMode: "on" }),
    );
    assert.equal(saved.intensity, "aggressive");
    assert.deepEqual(saved.advisor, advisor);
    assert.deepEqual(saved.thinking?.advisor, { level: "high" });
    assert.equal(await writeConfig(path, saved), "saved");
    assert.deepEqual((await readConfig(path)).defaults, saved);
  });
});

test("a companion replacement that fails after the read restores the previous pair", async () => {
  const first: GlobalDefaults = {
    ...empty,
    intensity: "normal",
    small: ordinary,
    medium: null,
    large: null,
    advisor,
    advisorMode: "on",
  };
  await withDirectory(async (path) => {
    assert.equal(await writeConfig(path, first), "saved");
    const main = await readFile(path, "utf8");
    const companionPath = getAdvisorConfigPath(path);
    const companion = await readFile(companionPath, "utf8");
    // The companion status was readable when the save started, so this reaches the companion write.
    await blockOneReplacement(companionPath, async () => {
      assert.equal(await writeConfig(path, { ...first, intensity: "aggressive" }), "unchanged");
    });
    assert.equal(await readFile(path, "utf8"), main, "the previous delegation file is restored");
    assert.equal(await readFile(companionPath, "utf8"), companion, "the companion is untouched");
    const loaded = await readConfig(path);
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(loaded.defaults, first);
    assert.equal(isAdvisorEnabled(resolveDelegateState(loaded.defaults, empty)), true);
    // The restored pair is what the published reader keeps reading.
    const previous = await readPreviousConfig(path);
    assert.deepEqual(previous.diagnostics, []);
    assert.equal(previous.defaults.intensity, "normal");
    assert.deepEqual(previous.defaults.small, ordinary);
  });
});

test("a companion replacement that fails with no previous defaults removes the file it wrote", async () => {
  const global: GlobalDefaults = {
    ...empty,
    intensity: "normal",
    small: ordinary,
    medium: null,
    large: null,
    advisor,
    advisorMode: "on",
  };
  await withDirectory(async (path) => {
    const companionPath = getAdvisorConfigPath(path);
    await blockOneReplacement(companionPath, async () => {
      assert.equal(await writeConfig(path, global), "unchanged");
    });
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(companionPath, "utf8"), { code: "ENOENT" });
  });
});

test("an unreadable Advisor companion stops the save before it writes anything", async () => {
  const global: GlobalDefaults = {
    ...empty,
    intensity: "normal",
    small: ordinary,
    medium: null,
    large: null,
    advisor,
    advisorMode: "on",
  };
  await withDirectory(async (path) => {
    assert.equal(await writeConfig(path, global), "saved");
    const directory = dirname(path);
    const main = await readFile(path, "utf8");
    const written = (await stat(path)).mtimeMs;
    // A directory at the companion path is a read error that is not ENOENT.
    await rm(getAdvisorConfigPath(path), { force: true });
    await mkdir(getAdvisorConfigPath(path));
    const entries = await readdir(directory);
    assert.equal(await writeConfig(path, { ...global, intensity: "aggressive" }), "unchanged");
    assert.equal(await readFile(path, "utf8"), main, "the delegation file is not rewritten");
    assert.equal((await stat(path)).mtimeMs, written, "the save never reached the writer");
    assert.deepEqual(await readdir(directory), entries, "no temporary file is left behind");
  });
});

test("an unreadable delegation file stops the save before it writes anything", async () => {
  const global: GlobalDefaults = {
    ...empty,
    intensity: "normal",
    small: ordinary,
    medium: null,
    large: null,
    advisor,
    advisorMode: "on",
  };
  await withDirectory(async (path) => {
    await mkdir(path);
    assert.equal(await writeConfig(path, global), "unchanged");
    assert.equal((await stat(path)).isDirectory(), true, "the unusable path is left as it was");
    assert.deepEqual(await readdir(path), [], "the save wrote nothing through that path");
    assert.deepEqual(await readdir(dirname(path)), [basename(path)]);
  });
});

test("reformatting the delegation file and a legacy envelope keep Advisor usable", async () => {
  const global: GlobalDefaults = {
    ...empty,
    intensity: "normal",
    small: ordinary,
    medium: null,
    large: null,
    advisor,
    advisorMode: "on",
  };
  await withDirectory(async (path) => {
    await writeConfig(path, global);
    const value = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify(value, null, 4).replace(/\n/g, "\r\n"));
    const reformatted = await readConfig(path);
    assert.deepEqual(reformatted.diagnostics, []);
    assert.equal(reformatted.defaults.advisorMode, "on");
    assert.equal(isAdvisorEnabled(resolveDelegateState(reformatted.defaults, empty)), true);
    // The earlier development envelope carried a digest; it stays readable and unused.
    const companionPath = getAdvisorConfigPath(path);
    const envelope = JSON.parse(await readFile(companionPath, "utf8"));
    await writeFile(companionPath, JSON.stringify({ ...envelope, delegationDigest: "unused" }));
    const legacy = await readConfig(path);
    assert.deepEqual(legacy.diagnostics, []);
    assert.deepEqual(legacy.defaults, global);
  });
});

test("session companions are adjacent, matched, and committed only after both guarded writes", () => {
  const global: GlobalDefaults = { ...empty, advisor, advisorMode: "on" };
  const next: SessionDelegateState = {
    ...empty,
    advisorMode: "on",
    intensity: "normal",
    small: ordinary,
    medium: null,
    large: null,
  };
  for (const failAt of [1, 2, 3]) {
    const branch: unknown[] = [
      {
        type: "custom",
        customType: SESSION_ENTRY_TYPE,
        data: { schemaVersion: 7, intensity: "off", advisor: null },
      },
    ];
    let calls = 0;
    const result = appendGuardedSessionState(
      {
        appendEntry(customType, data) {
          if (++calls === failAt) throw new Error("write failure");
          branch.push({ type: "custom", customType, data });
        },
      },
      next,
    );
    assert.equal(result, failAt === 1 ? "guard-failed" : "state-failed");
    assert.equal(buildDelegationPolicy(runtime(global, restoreSessionState(branch))), undefined);
    assert.equal(restorePreviousSession(branch).intensity, "off");
  }
  const branch: Array<{ type: string; customType: string; data: unknown }> = [];
  appendGuardedSessionState(
    {
      appendEntry(customType, data) {
        branch.push({ type: "custom", customType, data });
      },
    },
    next,
  );
  assert.deepEqual(restoreSessionState(branch), next);
  assert.equal(branch[1]?.customType, ADVISOR_SESSION_ENTRY_TYPE);
  branch[1]!.data = { ...next, intensity: "aggressive" };
  const invalid = restoreSessionStateWithDiagnostics(branch);
  assert.equal(invalid.session.intensity, "normal");
  assert.equal(invalid.session.advisorMode, "off");
  assert.equal(invalid.diagnostics[0]?.scope, "advisor");
  branch.push({
    type: "custom",
    customType: SESSION_ENTRY_TYPE,
    data: { schemaVersion: 7, intensity: "off" },
  });
  assert.equal(
    restoreSessionState(branch).advisorMode,
    undefined,
    "an older writer must not reuse the earlier companion",
  );
});

test("Advisor can stay available when delegation alone is invalid", () => {
  const current = runtime({ ...empty, intensity: "normal", advisor, advisorMode: "on" });
  assert.equal(statusLabel(current), "D:ERR");
  assert.equal(advisorStatusLabel(current), "A:ON");
  assert.match(buildDelegationPolicy(current) ?? "", /Advisor consultation:/);
  assert.doesNotMatch(
    buildDelegationPolicy(current) ?? "",
    /Enabled ordinary roles:|Role selection:/,
  );
});

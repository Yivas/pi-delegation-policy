import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Component } from "@earendil-works/pi-tui";
import piDelegationPolicy, {
  getArgumentCompletions,
  parseCommand,
  statusText,
} from "../src/index.ts";
import {
  DelegatePanel,
  sameSessionState,
  type DelegatePanelResult,
} from "../src/delegate-panel.ts";
import {
  defaultsFromEffectiveState,
  getGlobalConfigPath,
  parseConfig,
  parseSessionState,
  readConfig,
  resolveDelegateState,
  restoreSessionState,
  SESSION_ENTRY_TYPE,
  writeConfig,
} from "../src/config.ts";
import { buildDelegationPolicy } from "../src/prompt.ts";
import {
  hasRuntimeError,
  loadRuntime,
  modelCandidates,
  statusLabel,
  validateModelReference,
  validateRuntime,
  type RuntimeState,
} from "../src/runtime.ts";
import { openDelegateEditor } from "../src/ui.ts";
import type { GlobalDefaults, ModelRef, SessionDelegateState } from "../src/types.ts";

const execFileAsync = promisify(execFile);

const small: ModelRef = { provider: "example", model: "small" };
const medium: ModelRef = { provider: "example", model: "medium" };
const large: ModelRef = { provider: "example", model: "large" };
const uiDesign: ModelRef = { provider: "example", model: "ui-design" };

const defaults: GlobalDefaults = {
  schemaVersion: 2,
  preference: "standard",
  small,
  medium,
  large,
  uiDesign,
};

function model(reference: ModelRef, name = reference.model) {
  return {
    provider: reference.provider,
    id: reference.model,
    name,
    reasoning: true,
  };
}

type TestModel = ReturnType<typeof model>;

type InteractiveComponent = Component & { focused?: boolean };

type TestContext = {
  cwd: string;
  hasUI: boolean;
  mode: "tui" | "rpc";
  scopedModels: Array<{ model: TestModel }>;
  sessionManager: { getBranch: () => unknown[] };
  modelRegistry: {
    find: (provider: string, modelId: string) => TestModel | undefined;
    getAvailable: () => TestModel[];
    hasConfiguredAuth: (candidate: TestModel) => boolean;
  };
  ui: {
    theme: {
      fg: (color: string, text: string) => string;
      bg: (color: string, text: string) => string;
      bold: (text: string) => string;
    };
    notify: (message: string, type?: string) => void;
    setStatus: (key: string, value: string | undefined) => void;
    custom: <T>(
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => Component,
    ) => Promise<T>;
  };
};

function context(
  options: {
    branch?: unknown[];
    scopedModels?: Array<{ model: TestModel }>;
    availableModels?: TestModel[];
    registeredModels?: TestModel[];
    authenticated?: (candidate: TestModel) => boolean;
    terminalRows?: number;
    mode?: "tui" | "rpc";
    runCustom?: (component: InteractiveComponent) => void | Promise<void>;
  } = {},
): TestContext & ExtensionContext {
  const availableModels = options.availableModels ?? [
    model(small),
    model(medium),
    model(large),
    model(uiDesign),
  ];
  const registeredModels = options.registeredModels ?? availableModels;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const tui = {
    terminal: { rows: options.terminalRows ?? 30 },
    requestRender: () => undefined,
  };
  return {
    cwd: "/project",
    hasUI: true,
    mode: options.mode ?? "tui",
    scopedModels: options.scopedModels ?? [],
    sessionManager: { getBranch: () => options.branch ?? [] },
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        registeredModels.find(
          (candidate) => candidate.provider === provider && candidate.id === modelId,
        ),
      getAvailable: () => availableModels,
      hasConfiguredAuth: (candidate: TestModel) =>
        options.authenticated ? options.authenticated(candidate) : true,
    },
    ui: {
      theme,
      notify: () => undefined,
      setStatus: () => undefined,
      custom: <T>(
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: T) => void,
        ) => Component,
      ) =>
        new Promise<T>((resolve, reject) => {
          const component = factory(tui, theme, {}, resolve) as InteractiveComponent;
          if ("focused" in component) component.focused = true;
          Promise.resolve(options.runCustom?.(component)).catch(reject);
        }),
    },
  } as unknown as TestContext & ExtensionContext;
}

function runtime(
  session: SessionDelegateState = { schemaVersion: 2, intensity: "normal" },
  global: GlobalDefaults = defaults,
): RuntimeState {
  return {
    effective: resolveDelegateState(global, session),
    global,
    session,
    diagnostics: [],
    modelStatuses: new Map(),
    runtimeErrors: [],
  };
}

async function withAgentDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-policy-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    return await callback(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

test("schema 2 parser and JSON Schema accept the same global defaults", async () => {
  const schema = JSON.parse(
    await readFile(join(process.cwd(), "schema/delegation-policy.schema.json"), "utf8"),
  );
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  const example = JSON.parse(await readFile(join(process.cwd(), "examples/global.json"), "utf8"));

  assert.ok(validate(defaults), JSON.stringify(validate.errors));
  assert.ok(parseConfig(defaults));
  assert.ok(validate(example), JSON.stringify(validate.errors));
  assert.equal(parseConfig(example)?.intensity, "normal");

  const invalidDocuments = [
    { schemaVersion: 1, presets: {} },
    { schemaVersion: 2, intensity: "unsupported" },
    { schemaVersion: 2, preference: "standard", thinking: "high" },
    { schemaVersion: 2, small: { provider: "example", model: "small", label: "Small" } },
    { schemaVersion: 2, strategy: "tiered" },
    { schemaVersion: 2, uiDesign: null },
  ];
  for (const invalid of invalidDocuments) {
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
    assert.equal(parseConfig(invalid), undefined, JSON.stringify(invalid));
  }

  assert.ok(parseSessionState({ schemaVersion: 2, intensity: "off" }));
  assert.ok(parseSessionState({ schemaVersion: 2, intensity: "normal", uiDesign: null }));
  assert.deepEqual(parseSessionState({ schemaVersion: 2 }), { schemaVersion: 2 });
  assert.equal(
    parseSessionState({ schemaVersion: 2, intensity: "normal", thinking: "high" }),
    undefined,
  );
});

test("legacy and malformed defaults are inactive and diagnostics are sanitized", async () => {
  await withAgentDirectory(async (directory) => {
    const path = getGlobalConfigPath(directory);
    await writeFile(path, JSON.stringify(defaults), "utf8");
    assert.deepEqual((await readConfig(path)).defaults, defaults);

    await writeFile(path, '{"schemaVersion":1,"secret":"PRIVATE_FRAGMENT"}', "utf8");
    const legacy = await readConfig(path);
    assert.deepEqual(legacy.defaults, { schemaVersion: 2 });
    assert.match(legacy.diagnostics[0]?.message ?? "", /schema version 1/i);
    assert.doesNotMatch(
      legacy.diagnostics[0]?.message ?? "",
      /PRIVATE_FRAGMENT|delegation-policy\.json/i,
    );

    await writeFile(path, "{", "utf8");
    const malformed = await readConfig(path);
    assert.equal(malformed.diagnostics.length, 1);
    assert.doesNotMatch(
      malformed.diagnostics[0]?.message ?? "",
      /Unexpected|PRIVATE_FRAGMENT|\.json/i,
    );
  });
});

test("writing refuses invalid global defaults before touching disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-policy-"));
  try {
    const path = join(directory, "delegation-policy.json");
    await assert.rejects(
      writeConfig(path, { schemaVersion: 2, preference: "unsupported" } as never),
      /invalid delegation policy defaults/i,
    );
    await assert.rejects(readFile(path, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("global defaults combine with field-level session overrides including intensity", () => {
  const global = { ...defaults, intensity: "normal" as const };
  const session: SessionDelegateState = {
    schemaVersion: 2,
    intensity: "aggressive",
    preference: "efficient",
    small: { provider: "session", model: "small" },
    uiDesign: null,
  };
  const effective = resolveDelegateState(global, session);

  assert.equal(effective.intensity, "aggressive");
  assert.equal(effective.preference, "efficient");
  assert.deepEqual(effective.small, { provider: "session", model: "small" });
  assert.deepEqual(effective.medium, medium);
  assert.equal(effective.uiDesign, undefined);
  assert.equal(effective.source.intensity, "session");
  assert.equal(effective.source.small, "session");
  assert.equal(effective.source.medium, "global");
  assert.equal(effective.source.uiDesign, "session");

  const inherited = resolveDelegateState(global, { schemaVersion: 2 });
  assert.equal(inherited.intensity, "normal");
  assert.equal(inherited.source.intensity, "global");

  const fallback = resolveDelegateState(defaults, { schemaVersion: 2 });
  assert.equal(fallback.intensity, "off");
  assert.equal(fallback.source.intensity, "default");

  const saved = defaultsFromEffectiveState(effective);
  assert.equal(saved.intensity, "aggressive");
  assert.equal("uiDesign" in saved, false);
  assert.equal(saved.preference, "efficient");
});

test("a session without policy state starts off and restoration uses the latest valid branch entry", () => {
  const normal = { schemaVersion: 2, intensity: "normal" };
  const aggressive = { schemaVersion: 2, intensity: "aggressive" };
  const entries = [
    { type: "custom", customType: SESSION_ENTRY_TYPE, data: normal },
    {
      type: "custom",
      customType: SESSION_ENTRY_TYPE,
      data: { schemaVersion: 2, intensity: "bad" },
    },
    { type: "custom", customType: SESSION_ENTRY_TYPE, data: aggressive },
  ];

  assert.equal(restoreSessionState(entries).intensity, "aggressive");
  assert.equal(restoreSessionState([]).intensity, undefined);
  assert.equal(resolveDelegateState(defaults, restoreSessionState([])).intensity, "off");
});

test("runtime restores global intensity and active branch overrides without leaking state", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), { ...defaults, intensity: "aggressive" });
    const normalBranch = [
      {
        type: "custom",
        customType: SESSION_ENTRY_TYPE,
        data: { schemaVersion: 2, intensity: "normal" },
      },
    ];
    const inheritedBranch = [...normalBranch, { type: "message", role: "user", content: "work" }];
    const useGlobalBranch = [
      ...normalBranch,
      { type: "custom", customType: SESSION_ENTRY_TYPE, data: { schemaVersion: 2 } },
    ];
    const resetBranch = [
      ...useGlobalBranch,
      {
        type: "custom",
        customType: SESSION_ENTRY_TYPE,
        data: { schemaVersion: 2, intensity: "off" },
      },
    ];
    const emptyBranch: unknown[] = [];
    assert.equal(
      (await loadRuntime(context({ branch: inheritedBranch }))).effective.intensity,
      "normal",
    );
    assert.equal(
      (await loadRuntime(context({ branch: useGlobalBranch }))).effective.intensity,
      "aggressive",
    );
    assert.equal((await loadRuntime(context({ branch: resetBranch }))).effective.intensity, "off");
    assert.equal(
      (await loadRuntime(context({ branch: emptyBranch }))).effective.intensity,
      "aggressive",
    );
  });
});

test("candidate models honor scope and authentication", () => {
  const unauthenticated = model({ provider: "example", model: "unauthenticated" });
  const current = context({
    scopedModels: [{ model: model(small) }, { model: unauthenticated }],
    availableModels: [model(medium)],
    authenticated: (candidate) => candidate.id !== "unauthenticated",
  });

  assert.deepEqual(
    modelCandidates(current).map((candidate) => candidate.id),
    ["small"],
  );
});

test("exact model validation distinguishes missing, scope, availability, and authentication failures", () => {
  const available = [model(small), model(medium), model(large), model(uiDesign)];
  const missing = context({ availableModels: available });
  assert.equal(
    validateModelReference(missing, { provider: "example", model: "unknown" }).kind,
    "missing-model",
  );

  const scoped = context({ availableModels: available, scopedModels: [{ model: model(small) }] });
  assert.equal(validateModelReference(scoped, medium).kind, "outside-scope");

  const unavailable = context({
    availableModels: [model(small), model(medium), model(large)],
    registeredModels: available,
  });
  assert.equal(validateModelReference(unavailable, uiDesign).kind, "unavailable");

  const unauthenticated = context({
    availableModels: available,
    authenticated: (candidate) => candidate.id !== "medium",
  });
  assert.equal(validateModelReference(unauthenticated, medium).kind, "no-credentials");
});

test("off remains empty even with invalid defaults, while active invalid states fail closed", () => {
  const current = runtime({ schemaVersion: 2, intensity: "off" });
  current.diagnostics.push({ message: "Global defaults are invalid." });
  validateRuntime(context(), current);
  assert.equal(statusLabel(current), "D:OFF");
  assert.equal(hasRuntimeError(current), false);
  assert.equal(buildDelegationPolicy(current), undefined);

  const active = runtime({ schemaVersion: 2, intensity: "normal" }, { schemaVersion: 2 });
  validateRuntime(context(), active);
  assert.equal(statusLabel(active), "D:ERR");
  assert.equal(hasRuntimeError(active), true);
  assert.equal(buildDelegationPolicy(active), undefined);
});

test("all active intensities and preferences produce one deterministic policy block", () => {
  for (const intensity of ["normal", "aggressive"] as const) {
    for (const preference of ["efficient", "standard", "intensive"] as const) {
      const current = runtime(
        { schemaVersion: 2, intensity },
        { ...defaults, preference, uiDesign: undefined },
      );
      validateRuntime(context(), current);
      const policy = buildDelegationPolicy(current);
      assert.equal(statusLabel(current), intensity === "normal" ? "D:NORM" : "D:AGG");
      assert.equal((policy?.match(/<delegation_policy>/g) ?? []).length, 1);
      assert.equal(policy, buildDelegationPolicy(current));
      assert.match(policy ?? "", new RegExp(`Model preference: ${preference}`));
      assert.match(policy ?? "", /Choose thinking dynamically/);
    }
  }
});

test("generated guidance preserves canonical roles and operational mode boundaries", () => {
  const policy = (intensity: "normal" | "aggressive", preference: GlobalDefaults["preference"]) =>
    buildDelegationPolicy(
      runtime({ schemaVersion: 2, intensity }, { ...defaults, preference, uiDesign: undefined }),
    ) ?? "";

  const standard = policy("normal", "standard");
  for (const expected of [
    "No single factor decides the role.",
    "Difficult but well-defined execution can remain Small with higher thinking.",
    "Small does not need to fail first.",
    "Do not require ceremonial failed attempts.",
    "multiple Small delegations",
    "volume alone does not justify Medium or Large",
    "Agent type does not determine the model role.",
    "A clearly better task fit overrides preference",
    "keep global strategy, coordination, integration, final review",
  ]) {
    assert.ok(standard.includes(expected), `Missing policy guarantee: ${expected}`);
  }

  assert.ok(standard.includes("expected benefit clearly outweighs"));
  assert.ok(standard.includes("merely possible fresh perspective is not enough"));
  assert.ok(standard.includes("Keep borderline work with the main agent"));
  assert.ok(standard.includes("genuine Small/Medium tie"));

  const aggressive = policy("aggressive", "standard");
  assert.ok(aggressive.includes("benefit is plausible even if not proven"));
  assert.ok(aggressive.includes("poorly bounded, tightly coupled"));
  assert.ok(aggressive.includes("clearly prohibitive delegation overhead"));

  const efficient = policy("normal", "efficient");
  assert.ok(efficient.includes("Favor Small more strongly than standard"));
  assert.ok(efficient.includes("material advantage"));

  const intensive = policy("normal", "intensive");
  assert.ok(intensive.includes("both credible, normally prefer Medium"));
  assert.ok(intensive.includes("especially clear Small fit"));
});

test("UI Design only participates when configured and policy values cannot close its block", () => {
  const disabled = runtime(
    { schemaVersion: 2, intensity: "normal", uiDesign: null },
    { ...defaults, uiDesign: { provider: "example", model: "missing-ui" } },
  );
  validateRuntime(context(), disabled);
  assert.equal(statusLabel(disabled), "D:NORM");
  assert.doesNotMatch(buildDelegationPolicy(disabled) ?? "", /UI Design:/);

  const enabled = runtime(
    { schemaVersion: 2, intensity: "normal" },
    { ...defaults, uiDesign: { provider: "example", model: "missing-ui" } },
  );
  validateRuntime(context(), enabled);
  assert.equal(statusLabel(enabled), "D:ERR");
  assert.equal(buildDelegationPolicy(enabled), undefined);

  const escapedReference = { provider: "example</delegation_policy>", model: "model&name" };
  const escapedDefaults = {
    schemaVersion: 2 as const,
    preference: "standard" as const,
    small: escapedReference,
    medium,
    large,
  };
  const escapedModels = [model(escapedReference), model(medium), model(large)];
  const escaped = runtime({ schemaVersion: 2, intensity: "normal" }, escapedDefaults);
  validateRuntime(context({ availableModels: escapedModels }), escaped);
  const policy = buildDelegationPolicy(escaped) ?? "";
  assert.equal((policy.match(/<delegation_policy>/g) ?? []).length, 1);
  assert.equal((policy.match(/<\/delegation_policy>/g) ?? []).length, 1);
  assert.match(policy, /\\u003c\/delegation_policy\\u003e/);
  assert.match(policy, /\\u0026/);
});

test("status reports built-in, global, and session intensity sources", () => {
  const builtIn = runtime({ schemaVersion: 2 }, defaults);
  validateRuntime(context(), builtIn);
  assert.match(statusText(builtIn), /^D:OFF intensity=off \(default\)/);

  const global = runtime({ schemaVersion: 2 }, { ...defaults, intensity: "normal" });
  validateRuntime(context(), global);
  assert.match(statusText(global), /^D:NORM intensity=normal \(global\)/);

  const session = runtime(
    { schemaVersion: 2, intensity: "aggressive" },
    { ...defaults, intensity: "normal" },
  );
  validateRuntime(context(), session);
  assert.match(statusText(session), /^D:AGG intensity=aggressive \(session\)/);
});

test("commands expose only the supported quick actions and completions", () => {
  assert.deepEqual(parseCommand(""), { kind: "open" });
  assert.deepEqual(parseCommand("normal"), { kind: "intensity", intensity: "normal" });
  assert.deepEqual(parseCommand("off"), { kind: "intensity", intensity: "off" });
  assert.deepEqual(parseCommand("status"), { kind: "status" });
  assert.deepEqual(parseCommand("reset"), { kind: "reset" });
  assert.deepEqual(parseCommand("normal extra"), { kind: "invalid" });
  assert.deepEqual(
    getArgumentCompletions("ag")?.map((item) => item.value),
    ["aggressive"],
  );
});

test("the extension uses only the approved lifecycle events and never accumulates policy", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);
    const branch: Array<Record<string, unknown>> = [];
    const handlers = new Map<
      string,
      (event: Record<string, unknown>, ctx: ExtensionContext) => unknown
    >();
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
    >();
    const statuses: Array<string | undefined> = [];
    const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => Promise<void> }>();
    const pi = {
      on: (
        name: string,
        handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown,
      ) => handlers.set(name, handler),
      registerCommand: (
        name: string,
        options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
      ) => commands.set(name, options),
      registerShortcut: (
        shortcut: string,
        options: { handler: (ctx: ExtensionContext) => Promise<void> },
      ) => shortcuts.set(shortcut, options),
      appendEntry: (customType: string, data?: unknown) =>
        branch.push({ type: "custom", customType, data }),
    };
    let runEditor: ((component: InteractiveComponent) => void | Promise<void>) | undefined;
    const current = context({ branch, runCustom: (component) => runEditor?.(component) });
    current.ui.setStatus = (_key: string, value: string | undefined) => statuses.push(value);

    piDelegationPolicy(pi as never);
    assert.deepEqual([...handlers.keys()].sort(), [
      "before_agent_start",
      "session_shutdown",
      "session_start",
      "session_tree",
    ]);
    assert.ok(commands.has("delegate"));
    assert.deepEqual([...shortcuts.keys()], ["alt+g"]);
    assert.equal(matchesKey("\x1bg", "alt+g"), true);
    assert.equal(matchesKey("\x04", "alt+g"), false);

    await handlers.get("session_start")?.({ type: "session_start" }, current);
    assert.equal(statuses.at(-1), "D:OFF");

    const event = { type: "before_agent_start", systemPrompt: "BASE", prompt: "work" };
    assert.equal(await handlers.get("before_agent_start")?.(event, current), undefined);

    runEditor = (component) => {
      component.handleInput?.("\r");
      component.handleInput?.("\x1b[B");
      component.handleInput?.("\x1b[B");
      component.handleInput?.("\x1b[B");
      component.handleInput?.("\r");
      component.handleInput?.("a");
    };
    await shortcuts.get("alt+g")?.handler(current);
    assert.deepEqual(branch.at(-1)?.data, { schemaVersion: 2, intensity: "aggressive" });
    assert.equal(statuses.at(-1), "D:AGG");
    runEditor = undefined;

    await commands.get("delegate")?.handler("normal", current);
    assert.deepEqual(branch.at(-1)?.data, { schemaVersion: 2, intensity: "normal" });
    for (const reason of ["reload", "resume", "fork"]) {
      await handlers.get("session_start")?.({ type: "session_start", reason }, current);
      assert.equal(statuses.at(-1), "D:NORM");
    }

    const first = (await handlers.get("before_agent_start")?.(event, current)) as {
      systemPrompt?: string;
    };
    const second = (await handlers.get("before_agent_start")?.(event, current)) as {
      systemPrompt?: string;
    };
    assert.equal(first.systemPrompt, second.systemPrompt);
    assert.equal((first.systemPrompt?.match(/<delegation_policy>/g) ?? []).length, 1);

    await commands.get("delegate")?.handler("off", current);
    assert.deepEqual(branch.at(-1)?.data, { schemaVersion: 2, intensity: "off" });
    assert.equal(await handlers.get("before_agent_start")?.(event, current), undefined);

    await commands.get("delegate")?.handler("normal", current);
    await commands.get("delegate")?.handler("reset", current);
    assert.deepEqual(branch.at(-1)?.data, { schemaVersion: 2, intensity: "off" });
    assert.equal(await handlers.get("before_agent_start")?.(event, current), undefined);
    await handlers.get("session_tree")?.({ type: "session_tree" }, current);
    assert.equal(statuses.at(-1), "D:OFF");

    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, current);
    assert.equal(statuses.at(-1), undefined);
  });
});

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_HOME = "\x1b[H";
const KEY_END = "\x1b[F";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";

function sendKeys(component: InteractiveComponent, ...keys: string[]): void {
  for (const key of keys) component.handleInput?.(key);
}

function createPanelHarness(
  options: {
    rows?: number;
    global?: GlobalDefaults;
    session?: SessionDelegateState;
    candidates?: TestModel[];
    diagnostics?: string[];
    onApply?: (draft: SessionDelegateState) => Promise<boolean>;
    onSaveDefaults?: (draft: SessionDelegateState) => Promise<GlobalDefaults | undefined>;
  } = {},
) {
  const terminal = { rows: options.rows ?? 30 };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const done: DelegatePanelResult[] = [];
  const panel = new DelegatePanel({
    tui: { terminal, requestRender: () => undefined } as never,
    theme: theme as never,
    global: options.global ?? defaults,
    session: options.session ?? { schemaVersion: 2 },
    candidates: (options.candidates ?? [
      model(small, "Tiny Worker"),
      model(medium, "Planning Sonnet"),
      model(large, "Large Reasoner"),
      model(uiDesign, "Visual Designer"),
    ]) as never,
    diagnostics: options.diagnostics ?? [],
    onApply: options.onApply ?? (async () => true),
    onSaveDefaults: options.onSaveDefaults ?? (async () => defaults),
    onDone: (result) => done.push(result),
  });
  panel.focused = true;
  return { panel, terminal, done };
}

test("session draft equality distinguishes inheritance, disable, and model identity", () => {
  assert.equal(
    sameSessionState(
      { schemaVersion: 2, small: { ...small }, uiDesign: null },
      { schemaVersion: 2, small: { ...small }, uiDesign: null },
    ),
    true,
  );
  assert.equal(sameSessionState({ schemaVersion: 2, uiDesign: null }, { schemaVersion: 2 }), false);
  assert.equal(
    sameSessionState(
      { schemaVersion: 2, small },
      { schemaVersion: 2, small: { provider: small.provider, model: "different" } },
    ),
    false,
  );
});

test("the delegate panel is responsive and exposes values with all sources", () => {
  const { panel, terminal } = createPanelHarness({
    session: { schemaVersion: 2, intensity: "aggressive", uiDesign: null },
  });

  for (const width of [100, 60, 40]) {
    const lines = panel.render(width);
    assert.ok(lines.length <= terminal.rows);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const rendered = lines.join("\n");
    if (width >= 60) {
      for (const label of [
        "Intensity",
        "Preference",
        "Small model",
        "Medium model",
        "Large model",
        "UI Design",
      ]) {
        assert.match(rendered, new RegExp(label));
      }
    }
    assert.match(rendered, /built-in/);
    assert.match(rendered, /global/);
    assert.match(rendered, /session/);
  }

  terminal.rows = 8;
  sendKeys(panel, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN);
  const compact = panel.render(36);
  assert.ok(compact.length <= 8);
  assert.ok(compact.every((line) => visibleWidth(line) <= 36));
  assert.match(compact.join("\n"), /Terminal too small/);

  const manyModels = Array.from({ length: 24 }, (_, index) =>
    model({ provider: `provider-${index % 3}`, model: `model-${index}` }, `Model ${index}`),
  );
  const modelViewport = createPanelHarness({ rows: 40, candidates: manyModels });
  sendKeys(modelViewport.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  for (let index = 0; index < 12; index += 1) sendKeys(modelViewport.panel, KEY_DOWN);
  const modelLines = modelViewport.panel.render(64);
  assert.ok(modelLines.length <= 40);
  assert.ok(modelLines.every((line) => visibleWidth(line) <= 64));
  assert.match(modelLines.join("\n"), /Use global default/);
  assert.match(modelLines.join("\n"), /of 24/);
  assert.ok((modelLines.join("\n").match(/\[provider-/g) ?? []).length <= 10);

  const elevenModelViewport = createPanelHarness({ rows: 40, candidates: manyModels.slice(0, 11) });
  sendKeys(elevenModelViewport.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  const elevenModelLines = elevenModelViewport.panel.render(64);
  assert.match(elevenModelLines.join("\n"), /of 11/);
  assert.equal((elevenModelLines.join("\n").match(/\[provider-/g) ?? []).length, 10);

  const uiModelViewport = createPanelHarness({ rows: 9, candidates: manyModels });
  sendKeys(uiModelViewport.panel, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  for (let index = 0; index < 12; index += 1) sendKeys(uiModelViewport.panel, KEY_DOWN);
  const uiModelLines = uiModelViewport.panel.render(64);
  assert.match(uiModelLines.join("\n"), /Use global default/);
  assert.match(uiModelLines.join("\n"), /Disable for this session/);
  assert.ok(uiModelLines.length <= 9);

  const compactDiscard = createPanelHarness({ rows: 30, session: { schemaVersion: 2 } });
  sendKeys(compactDiscard.panel, KEY_ENTER, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  const dirtyBeforeCompact = compactDiscard.panel.getDraft();
  compactDiscard.terminal.rows = 7;
  compactDiscard.panel.render(24);
  sendKeys(compactDiscard.panel, KEY_ENTER, KEY_DOWN);
  assert.deepEqual(compactDiscard.panel.getDraft(), dirtyBeforeCompact);
  sendKeys(compactDiscard.panel, KEY_ESCAPE);
  const discardLines = compactDiscard.panel.render(24);
  assert.ok(discardLines.every((line) => visibleWidth(line) <= 24));
  assert.match(discardLines.join("\n"), /Keep editing/);
  assert.match(discardLines.join("\n"), /Discard changes/);

  const extremeDiscard = createPanelHarness({ rows: 30 });
  sendKeys(extremeDiscard.panel, KEY_ENTER, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER, KEY_ESCAPE);
  extremeDiscard.terminal.rows = 1;
  extremeDiscard.panel.render(24);
  sendKeys(extremeDiscard.panel, KEY_DOWN, KEY_ENTER);
  assert.deepEqual(extremeDiscard.done, []);
  sendKeys(extremeDiscard.panel, KEY_ESCAPE, KEY_ESCAPE);
  extremeDiscard.terminal.rows = 2;
  const twoRowDiscard = extremeDiscard.panel.render(24);
  assert.match(twoRowDiscard.join("\n"), /Keep editing/);
  assert.match(twoRowDiscard.join("\n"), /Discard changes/);
  sendKeys(extremeDiscard.panel, KEY_DOWN, KEY_ENTER);
  assert.deepEqual(extremeDiscard.done, ["cancelled"]);

  const narrowDiscard = createPanelHarness({ rows: 30 });
  sendKeys(narrowDiscard.panel, KEY_ENTER, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER, KEY_ESCAPE);
  narrowDiscard.panel.render(16);
  sendKeys(narrowDiscard.panel, KEY_DOWN, KEY_ENTER);
  assert.deepEqual(narrowDiscard.done, []);

  const narrowEdit = createPanelHarness({ rows: 20 });
  narrowEdit.panel.render(23);
  sendKeys(narrowEdit.panel, KEY_ENTER, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  assert.deepEqual(narrowEdit.panel.getDraft(), { schemaVersion: 2 });

  const longQuery = createPanelHarness({ rows: 10, candidates: [] });
  sendKeys(longQuery.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  for (const character of "a-query-that-is-much-longer-than-the-terminal") {
    sendKeys(longQuery.panel, character);
  }
  const narrowModel = longQuery.panel.render(24);
  assert.ok(narrowModel.every((line) => visibleWidth(line) <= 24));
});

test("the delegate panel searches models, keeps pinned actions, and stages safe edits", () => {
  const { panel, done } = createPanelHarness({
    session: { schemaVersion: 2, intensity: "normal" },
  });

  sendKeys(panel, KEY_ENTER, KEY_HOME, KEY_ENTER);
  assert.equal(panel.getDraft().intensity, undefined);
  assert.equal(panel.isDirty(), true);

  sendKeys(panel, KEY_ESCAPE);
  assert.match(panel.render(80).join("\n"), /Discard unapplied changes/);
  sendKeys(panel, KEY_ESCAPE);
  assert.equal(panel.isDirty(), true);
  assert.deepEqual(done, []);
  sendKeys(panel, KEY_ENTER, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  assert.equal(panel.isDirty(), false);

  const searchable = createPanelHarness();
  sendKeys(searchable.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  for (const character of "planning") sendKeys(searchable.panel, character);
  const modelView = searchable.panel.render(80).join("\n");
  assert.equal(modelView.includes("\x1b_pi:c"), true);
  searchable.panel.focused = false;
  assert.equal(searchable.panel.render(80).join("\n").includes("\x1b_pi:c"), false);
  searchable.panel.focused = true;
  assert.match(modelView, /planning/);
  assert.match(modelView, /Use global default/);
  assert.match(modelView, /medium \[example\]/);
  assert.equal(modelView.match(/example\/small/g)?.length, 1);
  sendKeys(searchable.panel, KEY_DOWN, KEY_ENTER);
  assert.deepEqual(searchable.panel.getDraft().small, medium);

  const byProvider = createPanelHarness({
    candidates: [model(small), model({ provider: "other", model: "special" }, "Distinct")],
  });
  sendKeys(byProvider.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  for (const character of "other") sendKeys(byProvider.panel, character);
  assert.match(byProvider.panel.render(80).join("\n"), /special \[other\]/);
  sendKeys(byProvider.panel, KEY_DOWN, KEY_ENTER);
  assert.deepEqual(byProvider.panel.getDraft().small, {
    provider: "other",
    model: "special",
  });

  const noMatches = createPanelHarness({ candidates: [] });
  sendKeys(noMatches.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER, "x");
  const emptyView = noMatches.panel.render(80).join("\n");
  assert.match(emptyView, /Use global default/);
  assert.match(emptyView, /No models match/);

  const uiRole = createPanelHarness();
  sendKeys(
    uiRole.panel,
    KEY_DOWN,
    KEY_DOWN,
    KEY_DOWN,
    KEY_DOWN,
    KEY_DOWN,
    KEY_ENTER,
    KEY_DOWN,
    KEY_ENTER,
  );
  assert.equal(uiRole.panel.getDraft().uiDesign, null);

  const reset = createPanelHarness({
    session: { schemaVersion: 2, intensity: "aggressive", small },
  });
  sendKeys(reset.panel, KEY_END, KEY_UP, KEY_ENTER);
  assert.deepEqual(reset.panel.getDraft(), { schemaVersion: 2, intensity: "off" });
});

test("the delegate panel preserves dirty drafts when apply or default saving fails", async () => {
  const failedApply = createPanelHarness({ onApply: async () => false });
  sendKeys(failedApply.panel, KEY_ENTER, KEY_DOWN, KEY_DOWN, KEY_ENTER, "a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(failedApply.panel.render(80).join("\n"), /Could not apply session settings/);
  assert.equal(failedApply.panel.isDirty(), true);
  assert.deepEqual(failedApply.done, []);

  const rejectedApply = createPanelHarness({
    onApply: async () => {
      throw new Error("append failed");
    },
  });
  sendKeys(rejectedApply.panel, KEY_ENTER, KEY_DOWN, KEY_DOWN, KEY_ENTER, "a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(rejectedApply.panel.render(80).join("\n"), /Could not apply session settings/);
  assert.deepEqual(rejectedApply.done, []);

  let finishApply: ((value: boolean) => void) | undefined;
  let applyCalls = 0;
  const pendingApply = createPanelHarness({
    onApply: () => {
      applyCalls += 1;
      return new Promise<boolean>((resolve) => {
        finishApply = resolve;
      });
    },
  });
  sendKeys(pendingApply.panel, KEY_ENTER, KEY_DOWN, KEY_DOWN, KEY_ENTER, "a");
  assert.match(pendingApply.panel.render(80).join("\n"), /Applying changes/);
  sendKeys(pendingApply.panel, "a", KEY_ESCAPE, KEY_DOWN);
  assert.equal(applyCalls, 1);
  assert.deepEqual(pendingApply.done, []);
  finishApply?.(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pendingApply.done, ["applied"]);

  const missingSave = createPanelHarness({ onSaveDefaults: async () => undefined });
  sendKeys(missingSave.panel, KEY_END, KEY_UP, KEY_UP, KEY_ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(missingSave.panel.render(80).join("\n"), /Could not save global defaults/);

  const failedSave = createPanelHarness({
    onSaveDefaults: async () => {
      throw new Error("write failed");
    },
  });
  sendKeys(failedSave.panel, KEY_END, KEY_UP, KEY_UP, KEY_ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(failedSave.panel.render(80).join("\n"), /Could not save global defaults/);
  assert.deepEqual(failedSave.done, []);

  const repairedDefaults = createPanelHarness({ diagnostics: ["invalid defaults"] });
  assert.match(repairedDefaults.panel.render(80).join("\n"), /global defaults are invalid/);
  sendKeys(repairedDefaults.panel, KEY_END, KEY_UP, KEY_UP, KEY_ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(repairedDefaults.panel.render(80).join("\n"), /global defaults are invalid/);
});

test("the custom editor applies, discards, inherits, and saves defaults", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);

    const applied: Array<Record<string, unknown>> = [];
    const applyContext = context({
      branch: applied,
      runCustom: (component) => {
        sendKeys(component, KEY_ENTER, KEY_DOWN, KEY_DOWN, KEY_ENTER, "a");
      },
    });
    applyContext.ui.notify = () => {
      throw new Error("notification unavailable");
    };
    await openDelegateEditor(applyContext, {
      appendEntry: (customType: string, data?: unknown) =>
        applied.push({ type: "custom", customType, data }),
    } as never);
    assert.deepEqual(applied.at(-1)?.data, { schemaVersion: 2, intensity: "normal" });

    await writeConfig(getGlobalConfigPath(directory), { ...defaults, intensity: "aggressive" });
    const inherited: Array<Record<string, unknown>> = [
      {
        type: "custom",
        customType: SESSION_ENTRY_TYPE,
        data: { schemaVersion: 2, intensity: "normal" },
      },
    ];
    const inheritContext = context({
      branch: inherited,
      runCustom: (component) => sendKeys(component, KEY_ENTER, KEY_HOME, KEY_ENTER, "a"),
    });
    await openDelegateEditor(inheritContext, {
      appendEntry: (customType: string, data?: unknown) =>
        inherited.push({ type: "custom", customType, data }),
    } as never);
    assert.deepEqual(inherited.at(-1)?.data, { schemaVersion: 2 });
    assert.equal((await loadRuntime(inheritContext)).effective.intensity, "aggressive");

    const discarded: Array<Record<string, unknown>> = [];
    const discardContext = context({
      branch: discarded,
      runCustom: (component) => {
        sendKeys(
          component,
          KEY_ENTER,
          KEY_DOWN,
          KEY_DOWN,
          KEY_DOWN,
          KEY_ENTER,
          KEY_ESCAPE,
          KEY_DOWN,
          KEY_ENTER,
        );
      },
    });
    await openDelegateEditor(discardContext, {
      appendEntry: (customType: string, data?: unknown) =>
        discarded.push({ type: "custom", customType, data }),
    } as never);
    assert.equal(discarded.length, 0);

    await writeConfig(getGlobalConfigPath(directory), defaults);
    const saveContext = context({
      branch: [],
      runCustom: async (component) => {
        sendKeys(component, KEY_END, KEY_UP, KEY_UP, KEY_ENTER);
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (!component.render(80).join("\n").includes("Saving defaults")) break;
          await new Promise((resolve) => setImmediate(resolve));
        }
        sendKeys(component, KEY_ESCAPE);
      },
    });
    await openDelegateEditor(saveContext, { appendEntry: () => undefined } as never);
    const saved = JSON.parse(await readFile(getGlobalConfigPath(directory), "utf8"));
    assert.equal(saved.intensity, "off");
    assert.equal(saved.schemaVersion, 2);
    assert.deepEqual(saved.small, small);
  });
});

test("the interactive editor reports its TUI requirement in RPC mode", async () => {
  let notification: { message: string; type?: string } | undefined;
  const rpcContext = context({
    mode: "rpc",
    runCustom: () => {
      throw new Error("custom UI must not open in RPC mode");
    },
  });
  rpcContext.ui.notify = (message, type) => {
    notification = { message, type };
  };

  await openDelegateEditor(rpcContext, { appendEntry: () => undefined } as never);
  assert.match(notification?.message ?? "", /requires TUI mode/);
  assert.equal(notification?.type, "warning");
});

test("source code has no runner, tool interception, model control, or network client", async () => {
  const sourceFiles = [
    "config.ts",
    "delegate-panel.ts",
    "runtime.ts",
    "prompt.ts",
    "ui.ts",
    "index.ts",
  ];
  const source = await Promise.all(
    sourceFiles.map((file) => readFile(join(process.cwd(), "src", file), "utf8")),
  );
  const joined = source.join("\n");

  assert.doesNotMatch(joined, /registerTool\s*\(/);
  assert.doesNotMatch(joined, /tool_call|tool_result|session_compact/);
  assert.doesNotMatch(joined, /setModel|setThinkingLevel/);
  assert.doesNotMatch(joined, /\bfetch\s*\(|https?:\/\//);
});

test("public package contents exclude private planning, tests, archives, and old examples", async () => {
  const entries = await readdir(process.cwd());
  assert.equal(entries.includes("skills"), false);
  await assert.rejects(readFile(join(process.cwd(), "examples", "project.json"), "utf8"));

  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageJson.version, "0.3.2");
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.pi.extensions[0], "./src/index.ts");

  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath is required for the package-content check");
  const { stdout } = await execFileAsync(
    process.execPath,
    [npmCli, "pack", "--dry-run", "--json"],
    {
      cwd: process.cwd(),
    },
  );
  const report = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const files = report[0]?.files.map((file) => file.path).sort() ?? [];
  const expected = [
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "examples/global.json",
    "package.json",
    "schema/delegation-policy.schema.json",
    "src/config.ts",
    "src/delegate-panel.ts",
    "src/index.ts",
    "src/prompt.ts",
    "src/runtime.ts",
    "src/types.ts",
    "src/ui.ts",
  ].sort();
  assert.deepEqual(files, expected);
});

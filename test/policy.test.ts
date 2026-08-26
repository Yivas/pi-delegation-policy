import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import piDelegationPolicy, {
  getArgumentCompletions,
  parseCommand,
  statusText,
} from "../src/index.ts";
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

type TestContext = {
  cwd: string;
  hasUI: boolean;
  scopedModels: Array<{ model: TestModel }>;
  sessionManager: { getBranch: () => unknown[] };
  modelRegistry: {
    find: (provider: string, modelId: string) => TestModel | undefined;
    getAvailable: () => TestModel[];
    hasConfiguredAuth: (candidate: TestModel) => boolean;
  };
  ui: {
    theme: { fg: (color: string, text: string) => string };
    notify: (message: string, type?: string) => void;
    setStatus: (key: string, value: string | undefined) => void;
    select: (title: string, options: string[]) => Promise<string | undefined>;
  };
};

function context(
  options: {
    branch?: unknown[];
    scopedModels?: Array<{ model: TestModel }>;
    availableModels?: TestModel[];
    registeredModels?: TestModel[];
    authenticated?: (candidate: TestModel) => boolean;
  } = {},
): TestContext & ExtensionContext {
  const availableModels = options.availableModels ?? [
    model(small),
    model(medium),
    model(large),
    model(uiDesign),
  ];
  const registeredModels = options.registeredModels ?? availableModels;
  return {
    cwd: "/project",
    hasUI: true,
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
      theme: { fg: (_color: string, text: string) => text },
      notify: () => undefined,
      setStatus: () => undefined,
      select: async () => undefined,
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
    const current = context({ branch });
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

    let editorSelections = 0;
    current.ui.select = async (title: string, options: string[]) => {
      if (title === "Delegation intensity") return "aggressive";
      editorSelections += 1;
      return editorSelections === 1
        ? options.find((option) => option.startsWith("Intensity:"))
        : options.find((option) => option.startsWith("Apply changes"));
    };
    await shortcuts.get("alt+g")?.handler(current);
    assert.deepEqual(branch.at(-1)?.data, { schemaVersion: 2, intensity: "aggressive" });
    assert.equal(statuses.at(-1), "D:AGG");
    current.ui.select = async () => undefined;

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

test("the selector stages session edits, inherits intensity, resets drafts, and saves defaults", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);
    const branch: Array<Record<string, unknown>> = [];
    const pi = {
      appendEntry: (customType: string, data?: unknown) =>
        branch.push({ type: "custom", customType, data }),
    };

    let mainSelections = 0;
    const applyContext = context({ branch });
    applyContext.ui.select = async (title: string, options: string[]) => {
      if (title === "Delegation intensity") return "normal";
      mainSelections += 1;
      return mainSelections === 1
        ? options.find((option) => option.startsWith("Intensity:"))
        : options.find((option) => option.startsWith("Apply changes"));
    };
    await openDelegateEditor(applyContext, pi as never);
    assert.deepEqual(branch.at(-1)?.data, { schemaVersion: 2, intensity: "normal" });

    const cancelled: Array<Record<string, unknown>> = [];
    let cancelSelections = 0;
    const cancelContext = context({ branch: cancelled });
    cancelContext.ui.select = async (title: string, options: string[]) => {
      if (title === "Delegation intensity") return "aggressive";
      cancelSelections += 1;
      return cancelSelections === 1
        ? options.find((option) => option.startsWith("Intensity:"))
        : options.find((option) => option === "Cancel");
    };
    await openDelegateEditor(cancelContext, { appendEntry: () => undefined } as never);
    assert.equal(cancelled.length, 0);

    const resetBranch: Array<Record<string, unknown>> = [
      {
        type: "custom",
        customType: SESSION_ENTRY_TYPE,
        data: { schemaVersion: 2, intensity: "normal" },
      },
    ];
    let resetSelections = 0;
    const resetContext = context({ branch: resetBranch });
    resetContext.ui.select = async (_title: string, options: string[]) => {
      resetSelections += 1;
      return resetSelections === 1
        ? options.find((option) => option === "Reset draft to off")
        : options.find((option) => option.startsWith("Apply changes"));
    };
    await openDelegateEditor(resetContext, {
      appendEntry: (customType: string, data?: unknown) =>
        resetBranch.push({ type: "custom", customType, data }),
    } as never);
    assert.deepEqual(resetBranch.at(-1)?.data, { schemaVersion: 2, intensity: "off" });

    await writeConfig(getGlobalConfigPath(directory), { ...defaults, intensity: "aggressive" });
    const inheritedBranch: Array<Record<string, unknown>> = [
      {
        type: "custom",
        customType: SESSION_ENTRY_TYPE,
        data: { schemaVersion: 2, intensity: "normal" },
      },
    ];
    let inheritSelections = 0;
    const inheritContext = context({ branch: inheritedBranch });
    inheritContext.ui.select = async (title: string, options: string[]) => {
      if (title === "Delegation intensity") return "Use global default";
      inheritSelections += 1;
      return inheritSelections === 1
        ? options.find((option) => option.startsWith("Intensity:"))
        : options.find((option) => option.startsWith("Apply changes"));
    };
    await openDelegateEditor(inheritContext, {
      appendEntry: (customType: string, data?: unknown) =>
        inheritedBranch.push({ type: "custom", customType, data }),
    } as never);
    assert.deepEqual(inheritedBranch.at(-1)?.data, { schemaVersion: 2 });
    assert.equal((await loadRuntime(inheritContext)).effective.intensity, "aggressive");

    await writeConfig(getGlobalConfigPath(directory), defaults);
    const saveContext = context({ branch: [] });
    let saveSelections = 0;
    saveContext.ui.select = async (_title: string, options: string[]) => {
      saveSelections += 1;
      return saveSelections === 1
        ? options.find((option) => option.startsWith("Save effective"))
        : options.find((option) => option === "Cancel");
    };
    await openDelegateEditor(saveContext, { appendEntry: () => undefined } as never);
    const saved = JSON.parse(await readFile(getGlobalConfigPath(directory), "utf8"));
    assert.equal(saved.intensity, "off");
    assert.equal(saved.schemaVersion, 2);
    assert.deepEqual(saved.small, small);
  });
});

test("source code has no runner, tool interception, model control, or network client", async () => {
  const sourceFiles = ["config.ts", "runtime.ts", "prompt.ts", "ui.ts", "index.ts"];
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
  assert.equal(packageJson.version, "0.2.1");
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
    "src/index.ts",
    "src/prompt.ts",
    "src/runtime.ts",
    "src/types.ts",
    "src/ui.ts",
  ].sort();
  assert.deepEqual(files, expected);
});

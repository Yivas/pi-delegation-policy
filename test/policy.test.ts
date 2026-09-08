import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  appendGuardedSessionState,
  defaultsFromEffectiveState,
  getGlobalConfigPath,
  parseConfig,
  parseSessionState,
  readConfig,
  resolveDelegateState,
  restoreSessionState,
  restoreSessionStateWithDiagnostics,
  SESSION_ENTRY_TYPE,
  writeConfig,
} from "../src/config.ts";
import { buildDelegationPolicy, buildPolicyPreview } from "../src/prompt.ts";
import {
  hasRuntimeError,
  loadRuntime,
  modelCandidates,
  statusLabel,
  validateModelReference,
  validateRuntime,
  enabledOrdinaryRoles,
  type RuntimeState,
} from "../src/runtime.ts";
import { openDelegateEditor } from "../src/ui.ts";
import {
  CURRENT_SCHEMA_VERSION,
  type GlobalDefaults,
  type ModelRef,
  type SessionDelegateState,
} from "../src/types.ts";

const execFileAsync = promisify(execFile);

const small: ModelRef = { provider: "example", model: "small" };
const medium: ModelRef = { provider: "example", model: "medium" };
const large: ModelRef = { provider: "example", model: "large" };
const uiDesign: ModelRef = { provider: "example", model: "ui-design" };

const defaults: GlobalDefaults = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
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
  session: SessionDelegateState = { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
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

test("schema 4 parser and JSON Schema accept the current global defaults", async () => {
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
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "unsupported" },
    { schemaVersion: CURRENT_SCHEMA_VERSION, preference: "standard", thinking: "high" },
    {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      small: { provider: "example", model: "small", label: "Small" },
    },
    { schemaVersion: CURRENT_SCHEMA_VERSION, strategy: "tiered" },
    {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      visualDesign: { provider: "example", model: "visual" },
    },
    { schemaVersion: CURRENT_SCHEMA_VERSION, uiDesign: "invalid" },
  ];
  for (const invalid of invalidDocuments) {
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
    assert.equal(parseConfig(invalid), undefined, JSON.stringify(invalid));
  }

  assert.ok(parseSessionState({ schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off" }));
  assert.ok(
    parseSessionState({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "normal",
      uiDesign: null,
    }),
  );
  assert.deepEqual(parseSessionState({ schemaVersion: CURRENT_SCHEMA_VERSION }), {
    schemaVersion: CURRENT_SCHEMA_VERSION,
  });
  assert.equal(
    parseSessionState({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "normal",
      thinking: "high",
    }),
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
    assert.deepEqual(legacy.defaults, { schemaVersion: CURRENT_SCHEMA_VERSION });
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
      writeConfig(path, {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        preference: "unsupported",
      } as never),
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
    schemaVersion: CURRENT_SCHEMA_VERSION,
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

  const inherited = resolveDelegateState(global, { schemaVersion: CURRENT_SCHEMA_VERSION });
  assert.equal(inherited.intensity, "normal");
  assert.equal(inherited.source.intensity, "global");

  const fallback = resolveDelegateState(defaults, { schemaVersion: CURRENT_SCHEMA_VERSION });
  assert.equal(fallback.intensity, "off");
  assert.equal(fallback.source.intensity, "default");

  const saved = defaultsFromEffectiveState(effective);
  assert.equal(saved.intensity, "aggressive");
  assert.equal("uiDesign" in saved, false);
  assert.equal(saved.preference, "efficient");
});

test("a session without policy state starts off and restores a valid latest entry", () => {
  const normal = { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" };
  const aggressive = { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "aggressive" };
  const entries = [
    { type: "custom", customType: SESSION_ENTRY_TYPE, data: normal },
    {
      type: "custom",
      customType: SESSION_ENTRY_TYPE,
      data: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "bad" },
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
        data: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
      },
    ];
    const inheritedBranch = [...normalBranch, { type: "message", role: "user", content: "work" }];
    const useGlobalBranch = [
      ...normalBranch,
      {
        type: "custom",
        customType: SESSION_ENTRY_TYPE,
        data: { schemaVersion: CURRENT_SCHEMA_VERSION },
      },
    ];
    const resetBranch = [
      ...useGlobalBranch,
      {
        type: "custom",
        customType: SESSION_ENTRY_TYPE,
        data: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off" },
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
  const current = runtime({ schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off" });
  current.diagnostics.push({ message: "Global defaults are invalid." });
  validateRuntime(context(), current);
  assert.equal(statusLabel(current), "D:OFF");
  assert.equal(hasRuntimeError(current), false);
  assert.equal(buildDelegationPolicy(current), undefined);
  assert.doesNotMatch(statusText(current), /Global defaults are invalid/);

  const active = runtime(
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
    { schemaVersion: CURRENT_SCHEMA_VERSION },
  );
  validateRuntime(context(), active);
  assert.equal(statusLabel(active), "D:ERR");
  assert.equal(hasRuntimeError(active), true);
  assert.equal(buildDelegationPolicy(active), undefined);
});

test("all active intensities and preferences produce one deterministic policy block", () => {
  for (const intensity of ["normal", "aggressive", "orchestrator"] as const) {
    for (const preference of ["efficient", "standard", "intensive"] as const) {
      const current = runtime(
        { schemaVersion: CURRENT_SCHEMA_VERSION, intensity },
        { ...defaults, preference, uiDesign: undefined },
      );
      validateRuntime(context(), current);
      const policy = buildDelegationPolicy(current);
      assert.equal(
        statusLabel(current),
        { normal: "D:NORM", aggressive: "D:AGG", orchestrator: "D:ORCH" }[intensity],
      );
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
      runtime(
        { schemaVersion: CURRENT_SCHEMA_VERSION, intensity },
        { ...defaults, preference, uiDesign: undefined },
      ),
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
    "Choose the role by task fit before considering model preference",
    "error and review cost",
    "Apply preference only when Small and Medium are comparably credible fits.",
    "keep global strategy, coordination, integration, final review",
  ]) {
    assert.ok(standard.includes(expected), `Missing policy guarantee: ${expected}`);
  }

  assert.ok(standard.includes("expected benefit clearly outweighs"));
  assert.ok(standard.includes("merely possible fresh perspective is not enough"));
  assert.ok(standard.includes("Keep borderline work with the main agent"));
  assert.ok(standard.includes("Standard adds no Small or Medium bias"));

  const aggressive = policy("aggressive", "standard");
  assert.ok(aggressive.includes("benefit is plausible even if not proven"));
  assert.ok(aggressive.includes("poorly bounded, tightly coupled"));
  assert.ok(aggressive.includes("clearly prohibitive delegation overhead"));

  const efficient = policy("normal", "efficient");
  assert.ok(efficient.includes("only as a Small tie-break"));
  assert.ok(efficient.includes("materially better task fit"));

  const intensive = policy("normal", "intensive");
  assert.ok(intensive.includes("only as a Medium tie-break"));
  assert.ok(intensive.includes("clearly better task fit"));
});

test("policy previews and launch instructions preserve exact models with per-run thinking", () => {
  const active = resolveDelegateState(defaults, {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "normal",
  });
  assert.deepEqual(
    buildPolicyPreview(resolveDelegateState(defaults, { schemaVersion: CURRENT_SCHEMA_VERSION })),
    ["off · no policy injected"],
  );
  assert.deepEqual(
    buildPolicyPreview(
      resolveDelegateState(
        { schemaVersion: CURRENT_SCHEMA_VERSION },
        { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
      ),
    ),
    ["active · Small not configured · no policy can be injected"],
  );
  assert.match(buildPolicyPreview(active)[0] ?? "", /task fit first/);
  assert.match(buildPolicyPreview(active)[0] ?? "", /standard has no extra bias/);
  assert.equal(
    buildPolicyPreview(active)[2],
    'Small "example/small" · Medium "example/medium" · Large "example/large" · exact model plus per-task thinking required; neither uses an ambient default.',
  );
  assert.match(buildPolicyPreview(active)[2] ?? "", /neither uses an ambient default/);
  const orchestratorPreview = buildPolicyPreview(
    resolveDelegateState(defaults, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "orchestrator",
    }),
  );
  assert.match(orchestratorPreview[0] ?? "", /^orchestrator · task fit first/);
  assert.match(
    orchestratorPreview[3] ?? "",
    /Delegate all transferable work; main agent keeps final acceptance/,
  );

  const policy =
    buildDelegationPolicy(
      runtime({ schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" }),
    ) ?? "";
  assert.match(policy, /Choose thinking dynamically for that run/);
  assert.match(policy, /selected model's capabilities/);
  assert.doesNotMatch(policy, /defaultThinking|thinking: low|thinking: medium|thinking: high/);
  for (const reference of [
    "example/small",
    "example/medium",
    "example/large",
    "example/ui-design",
  ]) {
    assert.ok(policy.includes(`exact model base: ${JSON.stringify(reference)}`));
    assert.ok(policy.includes(`pi-subagents form: ${JSON.stringify(`${reference}:LEVEL`)}`));
  }
  assert.match(policy, /pass model: "provider\/model:LEVEL"/);
  assert.match(policy, /Do not omit the model or thinking choice/);
  assert.match(policy, /ambient launcher default for either/);
  assert.match(policy, /launch a disabled or unconfigured role, invent a role/);
  assert.match(
    policy,
    /more capable enabled role may cover work normally suited to a disabled role/,
  );

  const escapedReference = { provider: 'provider/"quoted"', model: "model/with&<>" };
  const escaped = runtime(
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
    {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      preference: "standard",
      small: escapedReference,
      medium,
      large,
    },
  );
  validateRuntime(
    context({ availableModels: [model(escapedReference), model(medium), model(large)] }),
    escaped,
  );
  const escapedModel = JSON.stringify(`${escapedReference.provider}/${escapedReference.model}`)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  const escapedThinkingModel = escapedModel.replace(/"$/, ':LEVEL"');
  const escapedPolicy = buildDelegationPolicy(escaped) ?? "";
  assert.ok(escapedPolicy.includes(`exact model base: ${escapedModel}`));
  assert.ok(escapedPolicy.includes(`pi-subagents form: ${escapedThinkingModel}`));
});

test("Visual Design keeps the uiDesign key and participates only when configured", () => {
  const disabled = runtime(
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal", uiDesign: null },
    { ...defaults, uiDesign: { provider: "example", model: "missing-ui" } },
  );
  validateRuntime(context(), disabled);
  assert.equal(statusLabel(disabled), "D:NORM");
  assert.doesNotMatch(buildDelegationPolicy(disabled) ?? "", /Visual Design:/);

  const enabled = runtime(
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
    { ...defaults, uiDesign: { provider: "example", model: "missing-ui" } },
  );
  validateRuntime(context(), enabled);
  assert.equal(statusLabel(enabled), "D:ERR");
  assert.equal(buildDelegationPolicy(enabled), undefined);

  const configured = runtime({ schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" });
  validateRuntime(context(), configured);
  const visualPolicy = buildDelegationPolicy(configured) ?? "";
  for (const expected of [
    "Visual Design is an optional specialist role",
    "primary acceptance criterion is a visual or user-experience result",
    "product behavior and data contracts are already defined and remain unchanged",
    "bounded to an identifiable surface, component, or set of assets",
    "no business logic, data flow, APIs, routes, application architecture, tooling, or cross-system coordination",
    "design, create, implement, and review scoped presentation code and visual assets",
    "run and report the relevant existing checks",
    "interaction behavior, state, validation, semantic HTML changes, keyboard mechanics, ARIA behavior",
    "main agent retains cross-domain integration and final acceptance",
  ]) {
    assert.ok(visualPolicy.includes(expected), `Missing Visual Design guarantee: ${expected}`);
  }
  assert.doesNotMatch(visualPolicy, /Never use it to implement|never implementation/);

  const escapedReference = { provider: "example</delegation_policy>", model: "model&name" };
  const escapedDefaults = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    preference: "standard" as const,
    small: escapedReference,
    medium,
    large,
  };
  const escapedModels = [model(escapedReference), model(medium), model(large)];
  const escaped = runtime(
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
    escapedDefaults,
  );
  validateRuntime(context({ availableModels: escapedModels }), escaped);
  const policy = buildDelegationPolicy(escaped) ?? "";
  assert.equal((policy.match(/<delegation_policy>/g) ?? []).length, 1);
  assert.equal((policy.match(/<\/delegation_policy>/g) ?? []).length, 1);
  assert.match(policy, /\\u003c\/delegation_policy\\u003e/);
  assert.match(policy, /\\u0026/);
});

test("Visual Design prioritizes eligible delegated work before ordinary roles without expanding normal or aggressive delegation", () => {
  for (const intensity of ["normal", "aggressive", "orchestrator"] as const) {
    const current = runtime({ schemaVersion: CURRENT_SCHEMA_VERSION, intensity });
    validateRuntime(context(), current);
    const policy = buildDelegationPolicy(current) ?? "";
    const visualGate = "Before selecting an ordinary role for each task or phase";
    const ordinarySelection = "Choose the role by task fit before considering model preference";

    const visualGateIndex = policy.indexOf(visualGate);
    const ordinarySelectionIndex = policy.indexOf(ordinarySelection);
    assert.notEqual(visualGateIndex, -1, `${intensity} must include the Visual Design gate`);
    assert.notEqual(
      ordinarySelectionIndex,
      -1,
      `${intensity} must include ordinary role selection`,
    );
    assert.ok(
      visualGateIndex < ordinarySelectionIndex,
      `${intensity} must evaluate Visual Design before ordinary role selection`,
    );
    assert.match(policy, /MUST select Visual Design rather than Small, Medium, or Large/);
    assert.match(
      policy,
      /Use the exact configured Visual Design provider\/model shown below and the per-run thinking choice for that launch/,
    );
    assert.match(policy, /do not substitute an ordinary role's model/);
    assert.match(policy, /Reevaluate Visual Design eligibility whenever the task or phase changes/);
    assert.match(
      policy,
      /If any eligibility condition fails, use an enabled ordinary role or split the visual portion from the broader task/,
    );
    assert.match(policy, /exact model base: "example\/ui-design"/);
    assert.match(policy, /pi-subagents form: "example\/ui-design:LEVEL"/);

    if (intensity === "orchestrator") {
      assert.match(policy, /Delegate all transferable execution before performing it/);
    } else {
      assert.match(
        policy,
        /Eligible visual work does not itself require delegation in normal or aggressive/,
      );
    }
  }
});

test("orchestrator routes Visual Design boundaries without a main-agent integration escape", () => {
  const policyFor = (intensity: "normal" | "aggressive" | "orchestrator") => {
    const current = runtime({ schemaVersion: CURRENT_SCHEMA_VERSION, intensity });
    validateRuntime(context(), current);
    return buildDelegationPolicy(current) ?? "";
  };

  for (const intensity of ["normal", "aggressive"] as const) {
    const policy = policyFor(intensity);
    assert.match(
      policy,
      /Route interaction behavior, state, validation, semantic HTML changes, keyboard mechanics, ARIA behavior, authentication, permissions, persistence, test infrastructure, and behavior-test ownership to an enabled ordinary role that fits, or keep it with the main agent/,
    );
    assert.match(policy, /The main agent retains cross-domain integration and final acceptance/);
    assert.doesNotMatch(policy, /In orchestrator, route interaction behavior/);
  }

  const orchestrator = policyFor("orchestrator");
  assert.match(
    orchestrator,
    /In orchestrator, route interaction behavior, state, validation, semantic HTML changes, keyboard mechanics, ARIA behavior, authentication, permissions, persistence, test infrastructure, and behavior-test ownership to an enabled ordinary role that fits/,
  );
  assert.match(
    orchestrator,
    /The main agent retains cross-domain integration responsibility, coordination, and final acceptance, but MUST delegate transferable integration mechanics and detailed review to a capable enabled ordinary role unless a named direct-work exception applies/,
  );
  assert.doesNotMatch(orchestrator, /or keep it with the main agent/);
  assert.doesNotMatch(
    orchestrator,
    /main agent retains cross-domain integration and final acceptance/,
  );

  const off = runtime({ schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off" });
  validateRuntime(context(), off);
  assert.equal(statusLabel(off), "D:OFF");
  assert.equal(buildDelegationPolicy(off), undefined);

  const invalid = runtime(
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "orchestrator" },
    { schemaVersion: CURRENT_SCHEMA_VERSION },
  );
  validateRuntime(context(), invalid);
  assert.equal(statusLabel(invalid), "D:ERR");
  assert.equal(buildDelegationPolicy(invalid), undefined);
});

test("status reports built-in, global, and session intensity sources", () => {
  const builtIn = runtime({ schemaVersion: CURRENT_SCHEMA_VERSION }, defaults);
  validateRuntime(context(), builtIn);
  assert.match(statusText(builtIn), /^D:OFF intensity=off \(default\)/);

  const global = runtime(
    { schemaVersion: CURRENT_SCHEMA_VERSION },
    { ...defaults, intensity: "normal" },
  );
  validateRuntime(context(), global);
  assert.match(statusText(global), /^D:NORM intensity=normal \(global\)/);

  const session = runtime(
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "aggressive" },
    { ...defaults, intensity: "normal" },
  );
  validateRuntime(context(), session);
  assert.match(statusText(session), /^D:AGG intensity=aggressive \(session\)/);
  assert.match(statusText(session), /small=example\/small \(global\)/);
  assert.match(statusText(session), /medium=example\/medium \(global\)/);
  assert.match(statusText(session), /large=example\/large \(global\)/);
  assert.match(statusText(session), /ui-design=example\/ui-design \(global\)/);
});

test("commands expose only the supported quick actions and completions", () => {
  assert.deepEqual(parseCommand(""), { kind: "open" });
  assert.deepEqual(parseCommand("normal"), { kind: "intensity", intensity: "normal" });
  assert.deepEqual(parseCommand("off"), { kind: "intensity", intensity: "off" });
  assert.deepEqual(parseCommand("orchestrator"), { kind: "intensity", intensity: "orchestrator" });
  assert.deepEqual(parseCommand("status"), { kind: "status" });
  assert.deepEqual(parseCommand("reset"), { kind: "reset" });
  assert.deepEqual(parseCommand("normal extra"), { kind: "invalid" });
  assert.deepEqual(
    getArgumentCompletions("ag")?.map((item) => item.value),
    ["aggressive"],
  );
  assert.deepEqual(
    getArgumentCompletions("orc")?.map((item) => item.value),
    ["orchestrator"],
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
      registerTool: () => undefined,
      getAllTools: () => [],
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
      "agent_end",
      "before_agent_start",
      "session_shutdown",
      "session_start",
      "session_tree",
      "tool_call",
      "tool_result",
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
    assert.deepEqual(branch.at(-1)?.data, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "aggressive",
    });
    assert.equal(statuses.at(-1), "D:AGG");
    runEditor = undefined;

    await commands.get("delegate")?.handler("normal", current);
    assert.deepEqual(branch.at(-1)?.data, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "normal",
    });
    for (const reason of ["reload", "resume", "fork"]) {
      await handlers.get("session_start")?.({ type: "session_start", reason }, current);
      assert.equal(statuses.at(-1), "D:NORM");
    }

    await commands.get("delegate")?.handler("orchestrator", current);
    assert.deepEqual(branch.at(-1)?.data, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "orchestrator",
    });
    for (const reason of ["reload", "resume", "fork"]) {
      await handlers.get("session_start")?.({ type: "session_start", reason }, current);
      assert.equal(statuses.at(-1), "D:ORCH");
    }
    await handlers.get("session_tree")?.({ type: "session_tree" }, current);
    assert.equal(statuses.at(-1), "D:ORCH");
    const orchestratorRun = (await handlers.get("before_agent_start")?.(event, current)) as {
      systemPrompt?: string;
    };
    assert.match(orchestratorRun.systemPrompt ?? "", /Intensity: orchestrator/);
    assert.match(orchestratorRun.systemPrompt ?? "", /final acceptance/);

    const first = (await handlers.get("before_agent_start")?.(event, current)) as {
      systemPrompt?: string;
    };
    const second = (await handlers.get("before_agent_start")?.(event, current)) as {
      systemPrompt?: string;
    };
    assert.equal(first.systemPrompt, second.systemPrompt);
    assert.equal((first.systemPrompt?.match(/<delegation_policy>/g) ?? []).length, 1);

    await commands.get("delegate")?.handler("off", current);
    assert.deepEqual(branch.at(-1)?.data, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "off",
    });
    assert.equal(await handlers.get("before_agent_start")?.(event, current), undefined);

    await commands.get("delegate")?.handler("normal", current);
    await commands.get("delegate")?.handler("reset", current);
    assert.deepEqual(branch.at(-1)?.data, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "off",
    });
    assert.equal(await handlers.get("before_agent_start")?.(event, current), undefined);
    await handlers.get("session_tree")?.({ type: "session_tree" }, current);
    assert.equal(statuses.at(-1), "D:OFF");

    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, current);
    assert.equal(statuses.at(-1), undefined);
  });
});

test("quick commands fail safely when either guarded append throws", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);

    for (const args of ["normal", "orchestrator", "reset"]) {
      for (const failAt of [1, 2]) {
        const branch: Array<Record<string, unknown>> = [];
        const commands = new Map<
          string,
          { handler: (commandArgs: string, ctx: ExtensionContext) => Promise<void> }
        >();
        const statuses: Array<string | undefined> = [];
        const notifications: Array<{ message: string; type?: string }> = [];
        let appendCalls = 0;
        const pi = {
          on: () => undefined,
          registerTool: () => undefined,
          getAllTools: () => [],
          registerCommand: (
            name: string,
            options: {
              handler: (commandArgs: string, ctx: ExtensionContext) => Promise<void>;
            },
          ) => commands.set(name, options),
          registerShortcut: () => undefined,
          appendEntry: (customType: string, data?: unknown) => {
            appendCalls += 1;
            if (appendCalls === failAt) throw new Error("append failed");
            branch.push({ type: "custom", customType, data });
          },
        };
        const current = context({ branch });
        current.ui.setStatus = (_key, value) => statuses.push(value);
        current.ui.notify = (message, type) => notifications.push({ message, type });

        piDelegationPolicy(pi as never);
        await commands.get("delegate")?.handler(args, current);

        assert.equal(appendCalls, failAt);
        assert.deepEqual(
          branch.map((entry) => entry.data),
          failAt === 1 ? [] : [{ schemaVersion: 2, intensity: "off" }],
        );
        assert.equal(statuses.at(-1), "D:OFF");
        assert.equal(notifications.at(-1)?.type, "error");
        assert.match(
          notifications.at(-1)?.message ?? "",
          failAt === 1 ? /No change was applied/ : /off for safety/,
        );
      }
    }
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
    hasRuntimeError?: boolean;
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
    session: options.session ?? { schemaVersion: CURRENT_SCHEMA_VERSION },
    candidates: (options.candidates ?? [
      model(small, "Tiny Worker"),
      model(medium, "Planning Sonnet"),
      model(large, "Large Reasoner"),
      model(uiDesign, "Visual Designer"),
    ]) as never,
    diagnostics: options.diagnostics ?? [],
    hasRuntimeError: options.hasRuntimeError ?? false,
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
      { schemaVersion: CURRENT_SCHEMA_VERSION, small: { ...small }, uiDesign: null },
      { schemaVersion: CURRENT_SCHEMA_VERSION, small: { ...small }, uiDesign: null },
    ),
    true,
  );
  assert.equal(
    sameSessionState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, uiDesign: null },
      { schemaVersion: CURRENT_SCHEMA_VERSION },
    ),
    false,
  );
  assert.equal(
    sameSessionState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, small: null },
      { schemaVersion: CURRENT_SCHEMA_VERSION },
    ),
    false,
  );
  assert.equal(
    sameSessionState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, small },
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        small: { provider: small.provider, model: "different" },
      },
    ),
    false,
  );
});

test("the delegate panel is responsive and exposes values with all sources", () => {
  const { panel, terminal } = createPanelHarness({
    session: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "aggressive", uiDesign: null },
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
        "Visual Design",
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

  const minimumViewport = createPanelHarness({ rows: 9, candidates: manyModels });
  sendKeys(minimumViewport.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  const minimumLines = minimumViewport.panel.render(26).join("\n");
  assert.match(minimumLines, /Disable for this session/);
  assert.match(minimumLines, /model-0 \[provider-0\]/);
  sendKeys(minimumViewport.panel, KEY_DOWN, KEY_DOWN);
  assert.match(minimumViewport.panel.render(26).join("\n"), /model-0 \[provider-0\]/);
  minimumViewport.terminal.rows = 11;
  const minimumWithMetadata = minimumViewport.panel.render(26).join("\n");
  assert.match(minimumWithMetadata, /model-0 \[provider-0\]/);
  assert.match(minimumWithMetadata, /Model Name: Model 0/);

  const uiModelViewport = createPanelHarness({ rows: 9, candidates: manyModels });
  sendKeys(uiModelViewport.panel, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  for (let index = 0; index < 12; index += 1) sendKeys(uiModelViewport.panel, KEY_DOWN);
  const uiModelLines = uiModelViewport.panel.render(64);
  assert.match(uiModelLines.join("\n"), /Use global default/);
  assert.match(uiModelLines.join("\n"), /Disable for this session/);
  assert.ok(uiModelLines.length <= 9);

  const compactDiscard = createPanelHarness({
    rows: 30,
    session: { schemaVersion: CURRENT_SCHEMA_VERSION },
  });
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
  assert.deepEqual(narrowEdit.panel.getDraft(), { schemaVersion: CURRENT_SCHEMA_VERSION });

  const longQuery = createPanelHarness({ rows: 10, candidates: [] });
  sendKeys(longQuery.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  for (const character of "a-query-that-is-much-longer-than-the-terminal") {
    sendKeys(longQuery.panel, character);
  }
  const narrowModel = longQuery.panel.render(24);
  assert.ok(narrowModel.every((line) => visibleWidth(line) <= 24));
});

test("the panel selects orchestrator through the fourth intensity and applies it", async () => {
  let applied: SessionDelegateState | undefined;
  const harness = createPanelHarness({
    onApply: async (draft) => {
      applied = draft;
      return true;
    },
  });

  sendKeys(harness.panel, KEY_ENTER, KEY_END);
  for (const width of [100, 60, 40, 26]) {
    const lines = harness.panel.render(width);
    assert.ok(lines.length <= harness.terminal.rows);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.match(lines.join("\n"), /orchestrator/);
  }
  sendKeys(harness.panel, KEY_ENTER);
  assert.equal(harness.panel.getDraft().intensity, "orchestrator");
  for (const width of [100, 60, 40]) {
    const lines = harness.panel.render(width);
    assert.ok(lines.length <= harness.terminal.rows);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.match(lines.join("\n"), /orchestrator/);
  }
  assert.match(harness.panel.render(60).join("\n"), /Delegate all transferable work/);
  sendKeys(harness.panel, "a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "orchestrator" });
  assert.deepEqual(harness.done, ["applied"]);

  harness.terminal.rows = 8;
  const compact = harness.panel.render(40);
  assert.ok(compact.length <= 8);
  assert.ok(compact.every((line) => visibleWidth(line) <= 40));
  assert.match(compact.join("\n"), /Terminal too small/);
});

test("the delegate panel explains fields, enum choices, previews, and selected model metadata", () => {
  const { panel } = createPanelHarness();
  const settings = panel.render(100).join("\n");
  assert.match(settings, /Effective policy preview/);
  assert.match(settings, /When delegation is worth considering/);
  assert.match(settings, /Tie-break only; task fit decides the role first/);
  assert.match(settings, /Design, assets, and bounded presentation work; no app behavior/);

  const live = createPanelHarness();
  sendKeys(live.panel, KEY_ENTER, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  assert.match(live.panel.render(100).join("\n"), /normal · task fit first/);
  sendKeys(live.panel, KEY_DOWN, KEY_ENTER, KEY_END, KEY_ENTER);
  assert.match(live.panel.render(100).join("\n"), /intensive breaks comparable fits toward Medium/);

  sendKeys(panel, KEY_ENTER);
  const intensityChoices = panel.render(100).join("\n");
  assert.match(intensityChoices, /No policy is injected/);
  assert.match(intensityChoices, /expected benefit clearly outweighs overhead/);
  assert.match(intensityChoices, /Delegate suitable substantial work by default/);
  sendKeys(panel, KEY_ESCAPE, KEY_DOWN, KEY_ENTER);
  const preferenceChoices = panel.render(100).join("\n");
  assert.match(preferenceChoices, /Tie-break comparable fits toward Small/);
  assert.match(preferenceChoices, /No extra Small or Medium bias/);
  assert.match(preferenceChoices, /Tie-break comparable fits toward Medium/);

  const metadataCandidate = {
    ...model({ provider: "metadata", model: "complete" }, "Complete model"),
    api: "openai-responses",
    reasoning: false,
    contextWindow: 0,
    maxTokens: 0,
  } as TestModel;
  const metadata = createPanelHarness({ candidates: [metadataCandidate] });
  sendKeys(metadata.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER, KEY_DOWN, KEY_DOWN);
  const metadataView = metadata.panel.render(100).join("\n");
  for (const detail of [
    "Model Name: Complete model",
    "API: openai-responses",
    "Reasoning: no",
    "Context: 0",
    "Max output: 0",
  ]) {
    assert.match(metadataView, new RegExp(detail));
  }

  const absent = createPanelHarness({
    candidates: [{ provider: "partial", id: "bare", name: "bare" } as TestModel],
  });
  sendKeys(absent.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER, KEY_DOWN, KEY_DOWN);
  const absentView = absent.panel.render(100).join("\n");
  assert.doesNotMatch(absentView, /API:|Reasoning:|Context:|Max output:/);

  const runtimeError = createPanelHarness({
    session: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
    diagnostics: ["Small model is outside the current model scope."],
    hasRuntimeError: true,
  });
  const errorView = runtimeError.panel.render(100).join("\n");
  assert.match(errorView, /D:ERR · policy unavailable/);
  assert.match(errorView, /Small model is outside the current model scope/);

  const offDraft = createPanelHarness({
    session: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off" },
    hasRuntimeError: true,
  });
  const offView = offDraft.panel.render(100).join("\n");
  assert.match(offView, /off · no policy injected/);
  assert.doesNotMatch(offView, /D:ERR · policy unavailable/);
});

test("the delegate panel searches models, keeps pinned actions, and stages safe edits", () => {
  const { panel, done } = createPanelHarness({
    session: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
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
  sendKeys(searchable.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  assert.deepEqual(searchable.panel.getDraft().small, medium);

  const byProvider = createPanelHarness({
    candidates: [model(small), model({ provider: "other", model: "special" }, "Distinct")],
  });
  sendKeys(byProvider.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  for (const character of "other") sendKeys(byProvider.panel, character);
  assert.match(byProvider.panel.render(80).join("\n"), /special \[other\]/);
  sendKeys(byProvider.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER);
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
    session: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "aggressive", small },
  });
  sendKeys(reset.panel, KEY_END, KEY_UP, KEY_ENTER);
  assert.deepEqual(reset.panel.getDraft(), {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "off",
  });
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
  assert.match(repairedDefaults.panel.render(80).join("\n"), /invalid defaults/);
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
    assert.deepEqual(applied.at(-1)?.data, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "normal",
    });

    await writeConfig(getGlobalConfigPath(directory), { ...defaults, intensity: "aggressive" });
    const inherited: Array<Record<string, unknown>> = [
      {
        type: "custom",
        customType: SESSION_ENTRY_TYPE,
        data: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
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
    assert.deepEqual(inherited.at(-1)?.data, { schemaVersion: CURRENT_SCHEMA_VERSION });
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
    assert.equal(saved.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(saved.small, small);
  });
});

test("the editor keeps its dirty draft when either guarded append fails", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);

    for (const failAt of [1, 2]) {
      const branch: Array<Record<string, unknown>> = [];
      let appendCalls = 0;
      const editorContext = context({
        branch,
        runCustom: async (component) => {
          sendKeys(component, KEY_ENTER, KEY_DOWN, KEY_DOWN, KEY_ENTER, "a");
          for (let attempt = 0; attempt < 50; attempt += 1) {
            if (component.render(80).join("\n").includes("Could not apply")) break;
            await new Promise((resolve) => setImmediate(resolve));
          }
          assert.match(component.render(80).join("\n"), /Could not apply session settings/);
          assert.equal((component as DelegatePanel).isDirty(), true);
          sendKeys(component, KEY_ESCAPE, KEY_DOWN, KEY_ENTER);
        },
      });

      await openDelegateEditor(editorContext, {
        appendEntry: (customType: string, data?: unknown) => {
          appendCalls += 1;
          if (appendCalls === failAt) throw new Error("append failed");
          branch.push({ type: "custom", customType, data });
        },
      } as never);

      assert.equal(appendCalls, failAt);
      assert.deepEqual(
        branch.map((entry) => entry.data),
        failAt === 1 ? [] : [{ schemaVersion: 2, intensity: "off" }],
      );
    }
  });
});

test("saving disabled ordinary defaults is global-only and does not apply the draft", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), defaults);
    const branch: Array<Record<string, unknown>> = [];
    const saveContext = context({
      branch,
      runCustom: async (component) => {
        sendKeys(component, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER, KEY_DOWN, KEY_ENTER);
        sendKeys(component, KEY_END, KEY_UP, KEY_UP, KEY_ENTER);
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (!component.render(80).join("\n").includes("Saving defaults")) break;
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal((component as DelegatePanel).isDirty(), true);
        sendKeys(component, KEY_ESCAPE, KEY_DOWN, KEY_ENTER);
      },
    });

    await openDelegateEditor(saveContext, {
      appendEntry: (customType: string, data?: unknown) =>
        branch.push({ type: "custom", customType, data }),
    } as never);

    const saved = JSON.parse(await readFile(getGlobalConfigPath(directory), "utf8"));
    assert.equal(saved.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(saved.medium, null);
    assert.equal("uiDesign" in saved, true);
    assert.deepEqual(branch, []);
    assert.deepEqual((await loadRuntime(saveContext)).session, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });
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

test("source code keeps ContextShunt bounded to public hooks without a runner, model control, or network client", async () => {
  const sourceFiles = [
    "config.ts",
    "context-shunt.ts",
    "context-shunt-adapter.ts",
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

  assert.match(joined, /registerTool\s*\([\s\S]*context_shunt_recover/);
  assert.match(joined, /pi\.on\("tool_call"/);
  assert.match(joined, /pi\.on\("tool_result"/);
  assert.doesNotMatch(joined, /node:child_process|child_process/);
  assert.doesNotMatch(joined, /setModel|setThinkingLevel/);
  assert.doesNotMatch(joined, /\bfetch\s*\(|https?:\/\//);
});

test("public documentation matches the declared Pi baseline", async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const peer = packageJson.peerDependencies["@earendil-works/pi-coding-agent"] as string;
  const baseline = /^>=(\d+\.\d+\.\d+)$/.exec(peer)?.[1];
  assert.ok(baseline, `Expected an exact minimum Pi peer, received ${peer}`);

  for (const path of [
    "README.md",
    "wiki/src/content/docs/index.mdx",
    "wiki/src/content/docs/getting-started.md",
  ]) {
    const contents = await readFile(join(process.cwd(), path), "utf8");
    assert.ok(contents.includes(`Pi \`${baseline}\``), `${path} must include the Pi baseline`);
    assert.ok(contents.includes(`>=${baseline}`), `${path} must include the Pi peer minimum`);
  }
});

test("public package contents exclude private planning, tests, archives, and old examples", async () => {
  const entries = await readdir(process.cwd());
  assert.equal(entries.includes("skills"), false);
  await assert.rejects(readFile(join(process.cwd(), "examples", "project.json"), "utf8"));

  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageJson.version, "0.10.0");
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.pi.extensions[0], "./src/index.ts");
  assert.deepEqual(packageJson.pi.subagents.agents, ["./agents"]);

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
    "agents/pi-delegation-policy.bulk-reader.md",
    "examples/global.json",
    "package.json",
    "schema/delegation-policy.schema.json",
    "src/config.ts",
    "src/context-shunt-adapter.ts",
    "src/context-shunt.ts",
    "src/delegate-panel.ts",
    "src/index.ts",
    "src/prompt.ts",
    "src/runtime.ts",
    "src/types.ts",
    "src/ui.ts",
  ].sort();
  assert.deepEqual(files, expected);
});

test("schema 2 and schema 3 migrate in memory while schema 4 preserves ordinary tri-state", () => {
  const schema2 = {
    schemaVersion: 2,
    intensity: "normal",
    small,
    medium,
    large,
    uiDesign,
  };
  const migrated = parseConfig(schema2);
  assert.deepEqual(migrated, { ...schema2, schemaVersion: CURRENT_SCHEMA_VERSION });
  assert.deepEqual(parseSessionState(schema2), {
    ...schema2,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  });
  assert.deepEqual(parseConfig({ schemaVersion: 3, small: null, medium, large: null }), {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    small: null,
    medium,
    large: null,
  });
  assert.equal(parseConfig({ schemaVersion: 3, uiDesign: null }), undefined);
  assert.equal(parseSessionState({ schemaVersion: 2, small: null }), undefined);

  const global: GlobalDefaults = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    small,
    medium: null,
    large,
  };
  const effective = resolveDelegateState(global, {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    small: null,
    medium,
    large: null,
  });
  assert.equal(effective.small, null);
  assert.deepEqual(effective.medium, medium);
  assert.equal(effective.large, null);
  assert.equal(effective.source.small, "session");
  assert.equal(effective.source.medium, "session");
  assert.equal(effective.source.large, "session");
  assert.deepEqual(defaultsFromEffectiveState(effective), {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "off",
    preference: "standard",
    small: null,
    medium,
    large: null,
  });
});

test("reading schema 2 migrates in memory without rewriting the file", async () => {
  await withAgentDirectory(async (directory) => {
    const path = getGlobalConfigPath(directory);
    const schema2 = JSON.stringify({ schemaVersion: 2, intensity: "normal", small }, null, 2);
    await writeFile(path, `${schema2}\n`, "utf8");

    const loaded = await readConfig(path);

    assert.equal(loaded.defaults.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(loaded.defaults.small, small);
    assert.equal("medium" in loaded.defaults, false);
    assert.equal(await readFile(path, "utf8"), `${schema2}\n`);
  });
});

test("orchestrator round-trips through global defaults and session overrides", async () => {
  await withAgentDirectory(async (directory) => {
    const global = { ...defaults, intensity: "orchestrator" as const };
    await writeConfig(getGlobalConfigPath(directory), global);
    assert.deepEqual((await readConfig(getGlobalConfigPath(directory))).defaults, global);

    const restored = parseSessionState({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "orchestrator",
      preference: "intensive",
      small: null,
      medium,
      large,
    });
    assert.deepEqual(restored, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "orchestrator",
      preference: "intensive",
      small: null,
      medium,
      large,
    });
    assert.equal(
      resolveDelegateState(global, { schemaVersion: CURRENT_SCHEMA_VERSION }).intensity,
      "orchestrator",
    );
    assert.equal(
      resolveDelegateState(global, { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" })
        .intensity,
      "normal",
    );
    assert.equal(
      defaultsFromEffectiveState(
        resolveDelegateState(global, { schemaVersion: CURRENT_SCHEMA_VERSION }),
      ).intensity,
      "orchestrator",
    );
  });
});

test("the orchestrator guard keeps older restoration fail-closed without historical reactivation", () => {
  const entries: unknown[] = [];
  const next: SessionDelegateState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "orchestrator",
    small,
    medium,
    large,
  };
  assert.equal(
    appendGuardedSessionState({ appendEntry: (_type, data) => entries.push(data) }, next),
    "success",
  );
  assert.deepEqual(entries[0], { schemaVersion: 2, intensity: "off" });
  assert.equal(parseConfig({ schemaVersion: 2, intensity: "orchestrator" }), undefined);
  assert.equal(parseSessionState({ schemaVersion: 2, intensity: "orchestrator" }), undefined);
  const restored = restoreSessionStateWithDiagnostics([
    {
      type: "custom",
      customType: SESSION_ENTRY_TYPE,
      data: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
    },
    { type: "custom", customType: SESSION_ENTRY_TYPE, data: entries[0] },
    { type: "custom", customType: SESSION_ENTRY_TYPE, data: next },
  ]);
  assert.deepEqual(restored.session, {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "orchestrator",
    small,
    medium,
    large,
  });
  // 0.5 scans past unsupported entries; 0.6 stops at the latest invalid entry.
  const legacyRestore = (states: unknown[], version: "0.5" | "0.6") => {
    for (const state of [...states].reverse()) {
      const data = state as { schemaVersion?: unknown; intensity?: unknown };
      const supportedSchema =
        data.schemaVersion === 2 || (version === "0.6" && data.schemaVersion === 3);
      const supportedIntensity =
        data.intensity === undefined ||
        ["off", "normal", "aggressive"].includes(data.intensity as string);
      const parsed = supportedSchema && supportedIntensity ? parseSessionState(data) : undefined;
      if (parsed) return parsed.intensity ?? "off";
      if (version === "0.6") return "off";
    }
    return "off";
  };
  const historical = { schemaVersion: 2, intensity: "normal", small, medium, large };
  for (const version of ["0.5", "0.6"] as const) {
    assert.equal(legacyRestore([historical], version), "normal");
    assert.equal(legacyRestore([historical, ...entries], version), "off");
    assert.equal(legacyRestore([historical, next], version), version === "0.5" ? "normal" : "off");
  }
});

test("the latest invalid session entry is a fail-closed restoration barrier", () => {
  const active = {
    type: "custom",
    customType: SESSION_ENTRY_TYPE,
    data: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal", small, medium, large },
  };
  for (const data of [
    { schemaVersion: 5, intensity: "normal" },
    { schemaVersion: CURRENT_SCHEMA_VERSION, small: { provider: "example" } },
    { schemaVersion: CURRENT_SCHEMA_VERSION, uiDesign: "invalid" },
  ]) {
    const restored = restoreSessionStateWithDiagnostics([
      active,
      { type: "custom", customType: SESSION_ENTRY_TYPE, data },
    ]);
    assert.deepEqual(restored.session, { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off" });
    assert.equal(restored.diagnostics.length, 1);
    assert.doesNotMatch(restored.diagnostics[0]?.message ?? "", /example|provider|schemaVersion/i);
  }
  assert.equal(restoreSessionState([active]).schemaVersion, CURRENT_SCHEMA_VERSION);
});

test("guarded session writes preserve an off downgrade guard and fail safely", () => {
  const entries: unknown[] = [];
  const writer = { appendEntry: (_type: string, data?: unknown) => entries.push(data) };
  const next: SessionDelegateState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "normal",
    small: null,
    medium,
    large: null,
  };
  assert.equal(appendGuardedSessionState(writer, next), "success");
  assert.deepEqual(entries, [{ schemaVersion: 2, intensity: "off" }, next]);
  assert.equal(
    appendGuardedSessionState(
      {
        appendEntry: () => {
          throw new Error("first");
        },
      },
      next,
    ),
    "guard-failed",
  );
  let calls = 0;
  assert.equal(
    appendGuardedSessionState(
      {
        appendEntry: () => {
          calls += 1;
          if (calls === 2) throw new Error("second");
        },
      },
      next,
    ),
    "state-failed",
  );
});

test("every ordinary-role subset validates only enabled roles and generates partial policy", () => {
  const roles = ["small", "medium", "large"] as const;
  for (const intensity of ["normal", "aggressive", "orchestrator"] as const) {
    for (let mask = 0; mask < 8; mask += 1) {
      const settings = Object.fromEntries(
        roles.map((role, index) => [
          role,
          mask & (1 << index) ? { small, medium, large }[role] : null,
        ]),
      );
      const current = runtime(
        { schemaVersion: CURRENT_SCHEMA_VERSION, intensity },
        { schemaVersion: CURRENT_SCHEMA_VERSION, ...settings },
      );
      validateRuntime(context(), current);
      const enabled = enabledOrdinaryRoles(current.effective);
      if (enabled.length === 0) {
        assert.equal(statusLabel(current), "D:ERR");
        assert.equal(buildDelegationPolicy(current), undefined);
      } else {
        assert.equal(
          statusLabel(current),
          { normal: "D:NORM", aggressive: "D:AGG", orchestrator: "D:ORCH" }[intensity],
        );
        const policy = buildDelegationPolicy(current) ?? "";
        for (const role of roles) {
          const name = role[0]!.toUpperCase() + role.slice(1);
          if (enabled.includes(role)) assert.match(policy, new RegExp(`- ${name}:`));
          else assert.doesNotMatch(policy, new RegExp(`- ${name}:`));
        }
        if (!enabled.includes("small") || !enabled.includes("medium")) {
          assert.match(policy, /inactive because Small or Medium is disabled/);
        }
      }
    }
  }

  const incomplete = runtime(
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" },
    { schemaVersion: CURRENT_SCHEMA_VERSION, small, medium: null, large: null },
  );
  delete incomplete.global.small;
  validateRuntime(context(), incomplete);
  assert.equal(statusLabel(incomplete), "D:ERR");
  assert.match(statusText(incomplete), /small=not configured/);
});

test("ordinary model selectors expose both pinned actions and write disabled state", () => {
  for (const index of [2, 3, 4]) {
    const { panel } = createPanelHarness({ session: { schemaVersion: CURRENT_SCHEMA_VERSION } });
    sendKeys(
      panel,
      ...Array.from({ length: index }, () => KEY_DOWN),
      KEY_ENTER,
      KEY_DOWN,
      KEY_ENTER,
    );
    const field = (["small", "medium", "large"] as const)[index - 2]!;
    assert.equal(panel.getDraft()[field], null);
    const rendered = panel.render(80).join("\n");
    assert.match(rendered, /disabled/);
  }
});

test("disabled invalid roles skip validation while enabled invalid roles fail closed", () => {
  const missing = { provider: "example", model: "missing" };
  for (const intensity of ["normal", "orchestrator"] as const) {
    const disabled = runtime(
      { schemaVersion: CURRENT_SCHEMA_VERSION, intensity },
      { schemaVersion: CURRENT_SCHEMA_VERSION, small: null, medium, large },
    );
    validateRuntime(context({ availableModels: [model(medium), model(large)] }), disabled);
    assert.equal(statusLabel(disabled), intensity === "normal" ? "D:NORM" : "D:ORCH");
    assert.equal(disabled.modelStatuses.has("small"), false);
    assert.equal(
      disabled.runtimeErrors.some((message) => message.includes("Small")),
      false,
    );

    const invalid = runtime(
      { schemaVersion: CURRENT_SCHEMA_VERSION, intensity },
      { schemaVersion: CURRENT_SCHEMA_VERSION, small: missing, medium: null, large },
    );
    validateRuntime(context({ availableModels: [model(large)] }), invalid);
    assert.equal(statusLabel(invalid), "D:ERR");
    assert.equal(buildDelegationPolicy(invalid), undefined);
    assert.equal(invalid.modelStatuses.get("small")?.kind, "missing-model");
  }
});

test("guarded session writes use the extension type and leave only the guard after state failure", () => {
  const calls: Array<{ type: string; data: unknown }> = [];
  const next: SessionDelegateState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "normal",
    small,
    medium: null,
    large: null,
  };
  assert.equal(
    appendGuardedSessionState({ appendEntry: (type, data) => calls.push({ type, data }) }, next),
    "success",
  );
  assert.deepEqual(calls, [
    { type: SESSION_ENTRY_TYPE, data: { schemaVersion: 2, intensity: "off" } },
    { type: SESSION_ENTRY_TYPE, data: next },
  ]);

  const partial: Array<{ type: string; data: unknown }> = [];
  assert.equal(
    appendGuardedSessionState(
      {
        appendEntry: (type, data) => {
          if (partial.length === 1) throw new Error("state");
          partial.push({ type, data });
        },
      },
      next,
    ),
    "state-failed",
  );
  assert.deepEqual(partial, [
    { type: SESSION_ENTRY_TYPE, data: { schemaVersion: 2, intensity: "off" } },
  ]);
});

test("partial role preferences and Visual Design preserve the ordinary-role boundary", () => {
  const oneEnabled = runtime(
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal", uiDesign },
    {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      preference: "intensive",
      small: null,
      medium: null,
      large,
    },
  );
  validateRuntime(context(), oneEnabled);
  const policy = buildDelegationPolicy(oneEnabled) ?? "";
  assert.match(policy, /intensive is inactive because Small or Medium is disabled/);
  assert.doesNotMatch(policy, /Use intensive only as a Medium tie-break/);
  assert.doesNotMatch(policy, /tie-break.*Large/i);
  assert.match(policy, /Visual Design:/);

  const visualOnly = runtime(
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal", uiDesign },
    { schemaVersion: CURRENT_SCHEMA_VERSION, small: null, medium: null, large: null },
  );
  validateRuntime(context(), visualOnly);
  assert.equal(statusLabel(visualOnly), "D:ERR");
  assert.equal(buildDelegationPolicy(visualOnly), undefined);

  const invalidVisual = runtime(
    {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      intensity: "normal",
      uiDesign: { provider: "example", model: "missing" },
    },
    { schemaVersion: CURRENT_SCHEMA_VERSION, small, medium: null, large: null },
  );
  validateRuntime(context({ availableModels: [model(small)] }), invalidVisual);
  assert.equal(statusLabel(invalidVisual), "D:ERR");
});

test("saving effective defaults preserves ordinary nulls without session writes", async () => {
  await withAgentDirectory(async (directory) => {
    const effective = resolveDelegateState(
      { schemaVersion: CURRENT_SCHEMA_VERSION, small, medium, large },
      { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal", medium: null, large: null },
    );
    const saved = defaultsFromEffectiveState(effective);
    await writeConfig(getGlobalConfigPath(directory), saved);
    assert.deepEqual(JSON.parse(await readFile(getGlobalConfigPath(directory), "utf8")), saved);
    assert.equal((await readConfig(getGlobalConfigPath(directory))).defaults.medium, null);
    assert.equal("uiDesign" in saved, false);
    const incomplete = defaultsFromEffectiveState(
      resolveDelegateState(
        { schemaVersion: CURRENT_SCHEMA_VERSION, small, medium: null },
        { schemaVersion: CURRENT_SCHEMA_VERSION },
      ),
    );
    assert.equal("large" in incomplete, false);
  });
});

test("status keeps restoration diagnostics once in active and off states", () => {
  const off = runtime({ schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off" });
  off.diagnostics = [{ message: "Sanitized restoration warning.", reportWhenOff: true }];
  validateRuntime(context(), off);
  assert.equal((statusText(off).match(/details=/g) ?? []).length, 1);
  assert.match(statusText(off), /Sanitized restoration warning/);

  const active = runtime({ schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" });
  active.diagnostics = [{ message: "Sanitized restoration warning." }];
  validateRuntime(context(), active);
  assert.equal((statusText(active).match(/Sanitized restoration warning/g) ?? []).length, 1);
});

test("model selectors retain pinned ordering and page navigation", () => {
  const candidates = Array.from({ length: 20 }, (_, index) =>
    model({ provider: "provider", model: `model-${index}` }),
  );
  const { panel } = createPanelHarness({ rows: 30, candidates });
  sendKeys(panel, KEY_DOWN, KEY_DOWN, KEY_ENTER);
  const initial = panel.render(80).join("\n");
  assert.ok(initial.indexOf("Use global default") < initial.indexOf("Disable for this session"));
  sendKeys(panel, "\x1b[6~", KEY_ENTER);
  assert.deepEqual(panel.getDraft().small, { provider: "provider", model: "model-17" });

  const inherited = createPanelHarness({
    session: { schemaVersion: CURRENT_SCHEMA_VERSION, small: null },
  });
  sendKeys(inherited.panel, KEY_DOWN, KEY_DOWN, KEY_ENTER, KEY_HOME, KEY_ENTER);
  assert.equal("small" in inherited.panel.getDraft(), false);
});

test("orchestrator is a schema 4 intensity and schema 2 rejects it", async () => {
  const schema = JSON.parse(
    await readFile(join(process.cwd(), "schema/delegation-policy.schema.json"), "utf8"),
  );
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  const orchestrator = { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "orchestrator" };
  assert.ok(validate(orchestrator), JSON.stringify(validate.errors));
  assert.equal(parseConfig(orchestrator)?.intensity, "orchestrator");
  assert.equal(parseConfig({ schemaVersion: 2, intensity: "orchestrator" }), undefined);
  assert.equal(parseSessionState({ schemaVersion: 2, intensity: "orchestrator" }), undefined);
});

test("orchestrator reports D:ORCH and has distinct ownership guidance", () => {
  const current = runtime({ schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "orchestrator" });
  validateRuntime(context(), current);
  assert.equal(statusLabel(current), "D:ORCH");
  const policy = buildDelegationPolicy(current) ?? "";
  for (const expected of [
    "all transferable execution before performing it",
    "enabled capable role and authorized launcher",
    "regardless of size",
    "small lookups, code reading, detailed planning, implementation, tests, writing, detailed review, and integration mechanics",
    "mandatory instructions, tool discovery, and narrow assignment scope",
    "do not pre-solve or broadly inspect the repository",
    "Batch small tasks without forcing recursive fanout",
    "do not take it over or run an equivalent worker while it is pending",
    "coordinate only disjoint work",
    "host wait/completion mechanism",
    "consume its result before dependent work or finalizing",
    "evidence evaluation, final acceptance, and concise synthesis",
    "final responsibility does not permit personally completing review or integration mechanics",
    "only for a concrete gap, risk, or contradiction",
    "delegate transferable fixes or rechecks",
    "genuinely non-transferable work, no enabled capable role, a confirmed unavailable authorized launcher",
    "explicit user or higher-priority requirement",
    "state the concrete exception briefly, do only the minimum, do not repeat it while unchanged, and resume delegation when it ends",
    "Never use a final-review or integration label to do the whole task personally",
    "Triviality, convenience, economics, transfer cost, size, or familiarity do not justify direct execution",
    "MUST delegate transferable detailed review and integration mechanics",
    "except under the named direct-work exceptions",
    "requested detail, risks, evidence, or safety information",
    "Do not promise savings",
  ])
    assert.ok(policy.includes(expected), `Missing orchestrator guarantee: ${expected}`);
  for (const forbidden of [
    "substantive exploration, implementation, testing, and writing",
    "Detailed review and integration mechanics may be delegated",
    "final integration responsibility",
    "retained decisions, coordination, safety",
    "transfer and context costs",
    "transfer is not worthwhile",
    "uneconomical",
    "only trivial",
    "only small",
  ]) {
    assert.doesNotMatch(policy, new RegExp(forbidden));
  }
  assert.equal((policy.match(/<delegation_policy>/g) ?? []).length, 1);
});

test("normal and aggressive policy blocks match the ff15c0d baseline fixture", () => {
  // Fixed synthetic roles and standard preference; hashes were generated from HEAD ff15c0d.
  const fixture: GlobalDefaults = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    preference: "standard",
    small,
    medium,
    large,
  };
  const expectedHashes = {
    normal: "aed3699591202e7a20984cd47bae921d0c4fd23bb8c9bc1871d7e61cfd5346fb",
    aggressive: "8703ea45ab6177f9dfdcf6232df0faaa0626e90b92f42855b7b9594caa6ab9e5",
  } as const;
  for (const intensity of ["normal", "aggressive"] as const) {
    const current = runtime({ schemaVersion: CURRENT_SCHEMA_VERSION, intensity }, fixture);
    validateRuntime(context(), current);
    const policy = buildDelegationPolicy(current);
    assert.ok(policy);
    assert.equal(createHash("sha256").update(policy).digest("hex"), expectedHashes[intensity]);
  }
});

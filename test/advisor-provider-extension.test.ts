import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import providerExtension from "../src/advisor-provider-extension.ts";
import { advisorAgentName } from "../src/advisor-executor.ts";
import { getGlobalConfigPath } from "../src/config.ts";
import { DelegatePanel } from "../src/delegate-panel.ts";
import { buildDelegationPolicy } from "../src/prompt.ts";
import {
  getProviderAdmissionsPath,
  parseProviderAdmissions,
  readProviderAdmissions,
  writeProviderAdmissions,
} from "../src/provider-admissions.ts";
import { listProviderExtensionCandidates } from "../src/provider-package.ts";
import { resolveDelegateState } from "../src/config.ts";
import { validateRuntime, type RuntimeState } from "../src/runtime.ts";
import { CURRENT_SCHEMA_VERSION, type GlobalDefaults } from "../src/types.ts";

const PACKAGE = "synthetic-go-provider";
const VERSION = "1.0.0";
const PROVIDER = "openai";

// Mirrors a quota-rotating provider extension: it replaces a built-in provider natively from
// session_start, listens to input and compaction, and declares a user command.
const syntheticSource = `let shared;
export default function (pi) {
  const mode = process.env.PI_PROVIDER_EXTENSION_MODE;
  if (mode === "factory") throw Error("factory sentinel");
  if (mode === "unlisted") pi.on("tool_call", () => undefined);
  pi.on("session_before_compact", () => {
    if (mode === "compact-throw") throw Error("compaction sentinel");
    return { cancel: mode === "compact-cancel" };
  });
  pi.on("session_start", async (_event, ctx) => {
    if (mode === "start") throw Error("start sentinel");
    const registry = ctx.modelRegistry;
    const original = registry.getProvider("${PROVIDER}");
    const stream = (model) => {
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "EXTENSION_PROVIDER_SENTINEL" }], stopReason: "stop", timestamp: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; },
        result: async () => message };
    };
    const native = (id) => ({ id, name: "Synthetic",
      auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: { apiKey: "managed" }, source: "Synthetic" }) } },
      getModels: () => original.getModels(), stream, streamSimple: stream });
    // One module-level object re-registered on every start must still count as a fresh registration.
    if (mode === "shared") registry.registerProvider((shared ??= native("${PROVIDER}")));
    else registry.registerProvider(native("${PROVIDER}"));
    if (mode === "extra") registry.registerProvider(native("synthetic-extra"));
    if (mode === "shadow") registry.registerProvider(native("synthetic-other"));
    if (mode === "held-extra") pi.registerProvider("synthetic-held", { api: "openai-completions", streamSimple: stream });
    if (mode === "tools") pi.registerTool({ name: "unexpected", description: "not allowed",
      parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) });
  });
  pi.on("input", () => (mode === "input" ? { action: "transform", text: "rewritten" } : undefined));
  pi.registerCommand("synthetic-accounts", { description: "never runs",
    handler: async () => { throw Error("command must never run"); } });
}`;

async function withAgentDirectory<T>(
  name: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), name));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    return await run(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function installSynthetic(directory: string, configured = true): Promise<void> {
  const root = join(directory, "npm/node_modules", PACKAGE);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: PACKAGE, version: VERSION, pi: { extensions: ["./index.js"] } }),
  );
  await writeFile(join(root, "index.js"), syntheticSource);
  await writeFile(
    join(directory, "settings.json"),
    JSON.stringify({ packages: configured ? [`npm:${PACKAGE}@${VERSION}`] : [] }),
  );
}

test("an admitted provider extension answers in the Advisor child and every refusal stays closed", async () => {
  const previousMode = process.env.PI_PROVIDER_EXTENSION_MODE;
  const fetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async () => {
    network++;
    throw Error("network forbidden");
  };
  try {
    await withAgentDirectory("advisor-provider-extension-", async (directory) => {
      await installSynthetic(directory);
      const admissionsPath = getProviderAdmissionsPath(getGlobalConfigPath(directory));
      for (const mode of [
        "success",
        "shared",
        "compact-cancel",
        "identity",
        "unconfigured",
        "no-admission",
        "factory",
        "start",
        "unlisted",
        "tools",
        "extra",
        "shadow",
        "compact-throw",
        "held-extra",
        "input",
        "active-tools",
      ]) {
        process.env.PI_PROVIDER_EXTENSION_MODE = mode;
        await installSynthetic(directory, mode !== "unconfigured");
        if (mode === "no-admission") await rm(admissionsPath, { force: true });
        else
          await writeProviderAdmissions(
            { [PROVIDER]: { package: PACKAGE, version: mode === "identity" ? "1.0.1" : VERSION } },
            admissionsPath,
          );
        const runtime = await sdk.ModelRuntime.create({
          credentials: {
            read: async () => undefined,
            list: async () => [],
            modify: async (_provider, change) => change(undefined),
            delete: async () => undefined,
          },
          modelsPath: null,
          modelsStorePath: join(directory, `models-${mode}.json`),
          refreshOnCreate: false,
          allowModelNetwork: false,
        });
        const registry = new sdk.ModelRegistry(runtime);
        // A provider another extension registered before this one; a failure must give it back.
        const other = { ...runtime.getProvider(PROVIDER)!, id: "synthetic-other" };
        registry.registerProvider(other);
        const model = runtime.getModels(PROVIDER)[0]!;
        const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
        const commands: string[] = [];
        const api = {
          registerProvider: (name: string, config: sdk.ProviderConfig) =>
            runtime.registerProvider(name, config),
          on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
            handlers.set(name, handler);
          },
          registerCommand: (name: string) => {
            commands.push(name);
          },
          getActiveTools: () => (mode === "active-tools" ? ["unexpected"] : []),
        };
        providerExtension(api as unknown as sdk.ExtensionAPI);
        const context = {
          cwd: directory,
          model,
          modelRegistry: registry,
          isProjectTrusted: () => false,
          hasUI: false,
          ui: { notify: () => undefined },
        };
        await handlers.get("session_start")!({ type: "session_start" }, context);
        if (mode === "shared")
          await handlers.get("session_start")!({ type: "session_start" }, context);
        const compaction = (await handlers.get("session_before_compact")!(
          { type: "session_before_compact" },
          context,
        )) as { cancel?: boolean } | undefined;
        await handlers.get("input")!(
          { type: "input", text: "question", source: "interactive" },
          context,
        );
        await handlers.get("before_agent_start")!({}, context);
        const answer = await runtime
          .streamSimple(model, { messages: [] }, { apiKey: "synthetic", env: {}, maxTokens: 1 })
          .result();
        if (["success", "shared", "compact-cancel"].includes(mode)) {
          assert.equal(answer.stopReason, "stop", mode);
          // The host's rule for session_before_*: the extension's cancel reaches it unchanged.
          assert.equal(compaction?.cancel, mode === "compact-cancel", mode);
          assert.deepEqual(answer.content, [{ type: "text", text: "EXTENSION_PROVIDER_SENTINEL" }]);
        } else {
          // Never the built-in provider: every refusal reaches the guard.
          assert.equal(answer.stopReason, "error", mode);
          assert.match(answer.errorMessage ?? "", /Advisor provider unavailable/, mode);
        }
        assert.deepEqual(commands, [], mode);
        for (const unexpected of ["synthetic-extra", "synthetic-held"])
          assert.ok(!registry.getRegisteredProviderIds().includes(unexpected), mode);
        assert.equal(registry.getRegisteredNativeProvider("synthetic-other"), other, mode);
        assert.equal(network, 0);
      }
    });
  } finally {
    globalThis.fetch = fetch;
    if (previousMode === undefined) delete process.env.PI_PROVIDER_EXTENSION_MODE;
    else process.env.PI_PROVIDER_EXTENSION_MODE = previousMode;
  }
});

test("admissions are strict per provider and candidates are only configured, exact user packages", async () => {
  await withAgentDirectory("advisor-provider-admissions-", async (directory) => {
    const path = getProviderAdmissionsPath(getGlobalConfigPath(directory));
    assert.deepEqual(await readProviderAdmissions(path), { admissions: {} });
    await writeProviderAdmissions(
      { "example-provider": { package: PACKAGE, version: VERSION } },
      path,
    );
    assert.deepEqual((await readProviderAdmissions(path)).admissions, {
      "example-provider": { package: PACKAGE, version: VERSION },
    });
    for (const invalid of [
      { schemaVersion: 2, providers: {} },
      { schemaVersion: 1, providers: { anthropic: { package: PACKAGE, version: VERSION } } },
      { schemaVersion: 1, providers: { x: { package: "../escape", version: VERSION } } },
      { schemaVersion: 1, providers: { x: { package: PACKAGE, version: "^1.0.0" } } },
      { schemaVersion: 1, providers: { x: { package: PACKAGE, version: VERSION, entry: "a" } } },
    ])
      assert.equal(parseProviderAdmissions(invalid), undefined);
    await writeFile(path, "{");
    const broken = await readProviderAdmissions(path);
    assert.deepEqual(broken.admissions, {});
    assert.equal(broken.diagnostic?.scope, "advisor-extension");

    await installSynthetic(directory);
    assert.deepEqual(listProviderExtensionCandidates(directory, []), [
      { package: PACKAGE, version: VERSION },
    ]);
    assert.deepEqual(listProviderExtensionCandidates(directory, [PACKAGE]), []);
    await installSynthetic(directory, false);
    assert.deepEqual(listProviderExtensionCandidates(directory, []), []);
  });
});

test("the parent routes admitted Advisors to the generic profile and reports a native provider without one", async () => {
  // An empty agent directory: the identity check must not read the developer's own settings.
  await withAgentDirectory("advisor-provider-parent-", async () => routeAndReport());
});

function routeAndReport(): void {
  const advisors = [
    { provider: "example-provider", model: "example-model" },
    { provider: "example", model: "plain" },
  ];
  const settings: GlobalDefaults = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "off",
    advisors,
    advisorMode: "on",
    advisorLaunch: "role",
  };
  const admissions = { "example-provider": { package: PACKAGE, version: VERSION } };
  assert.equal(
    advisorAgentName(advisors[0]!, admissions),
    "pi-delegation-policy.advisor-provider-extension",
  );
  assert.equal(advisorAgentName(advisors[1]!, admissions), "pi-delegation-policy.advisor");
  assert.equal(
    advisorAgentName(
      { provider: "anthropic", model: "m" },
      { anthropic: admissions["example-provider"] },
    ),
    "pi-delegation-policy.advisor",
  );

  const models = advisors.map(({ provider, model }) => ({
    provider,
    id: model,
    api: "openai-completions",
    reasoning: false,
  }));
  const context = (natives: string[]) =>
    ({
      cwd: tmpdir(),
      modelRegistry: {
        find: (provider: string, id: string) =>
          models.find((model) => model.provider === provider && model.id === id),
        getAvailable: () => models,
        hasConfiguredAuth: () => true,
        getRegisteredNativeProvider: (provider: string) =>
          natives.includes(provider) ? { id: provider } : undefined,
      },
    }) as never;
  const state = (stateAdmissions: RuntimeState["admissions"]): RuntimeState => ({
    global: settings,
    session: { schemaVersion: CURRENT_SCHEMA_VERSION },
    effective: resolveDelegateState(settings, { schemaVersion: CURRENT_SCHEMA_VERSION }),
    diagnostics: [],
    admissions: stateAdmissions,
    modelStatuses: new Map(),
    runtimeErrors: [],
  });

  const unadmitted = state({});
  validateRuntime(context(["example-provider"]), unadmitted);
  // A warning only: the built-in provider may still answer, so the Advisor stays consulted.
  assert.deepEqual(unadmitted.advisorEntries?.[0]?.errors, []);
  assert.match(unadmitted.advisorWarnings?.[0] ?? "", /replaced by an extension in this session/);
  assert.deepEqual(unadmitted.advisorEntries?.[1]?.errors, []);

  // An admitted package that the child would reject is reported before any launch.
  const missing = state(admissions);
  validateRuntime(context(["example-provider"]), missing);
  assert.match(missing.advisorEntries?.[0]?.errors[0] ?? "", /re-select the provider extension/);

  const unaffected = state({});
  validateRuntime(context([]), unaffected);
  assert.deepEqual(
    unaffected.advisorEntries?.map((entry) => entry.errors),
    [[], []],
  );
  const policy = buildDelegationPolicy(unaffected) ?? "";
  assert.match(policy, /agent profile: "pi-delegation-policy\.advisor"/);
}

test("the provider-extension step admits, removes and discards only through the draft", async () => {
  const saved: unknown[] = [];
  let applied = 0;
  const settings: GlobalDefaults = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: "normal",
    small: { provider: "example", model: "small" },
    medium: null,
    large: null,
    advisors: [{ provider: "example-provider", model: "example-model" }],
    advisorMode: "on",
    advisorLaunch: "role",
  };
  const panel = (rows = 24) =>
    new DelegatePanel({
      tui: { terminal: { rows }, requestRender: () => undefined } as never,
      theme: {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      global: settings,
      session: { schemaVersion: CURRENT_SCHEMA_VERSION },
      candidates: [
        { provider: "example-provider", id: "example-model", name: "Example", reasoning: true },
      ] as never,
      diagnostics: [],
      hasRuntimeError: false,
      admissions: {},
      extensionCandidates: [{ package: PACKAGE, version: VERSION }],
      extensionProviders: ["example-provider"],
      onSaveAdmissions: async (admissions) => {
        saved.push(admissions);
        return true;
      },
      onApply: async () => {
        applied++;
        return true;
      },
      onSaveDefaults: async () => ({ kind: "unchanged" }),
      onDone: () => undefined,
    });
  const chooseAdvisorModel = (target: DelegatePanel) => {
    // Advisor 1 row, then its model selector: global, disable, example-provider/example-model.
    target.handleInput("\u001b[H");
    for (let index = 0; index < 14; index++) target.handleInput("\u001b[B");
    target.handleInput("\r");
    target.handleInput("\u001b[B");
    target.handleInput("\u001b[B");
    target.handleInput("\r");
  };

  for (const [width, rows] of [
    [80, 24],
    [40, 12],
  ]) {
    const target = panel(rows);
    target.render(width);
    chooseAdvisorModel(target);
    const step = target.render(width);
    assert.ok(step.length <= rows);
    assert.ok(step.some((line) => line.startsWith("> Standard profile")));
    target.handleInput("\u001b[B");
    assert.ok(target.render(width).some((line) => line.startsWith(`> ${PACKAGE} ${VERSION}`)));
    // Escape keeps the provider's previous admission: none.
    target.handleInput("\u001b");
    assert.deepEqual(target.getDraftAdmissions(), {});
  }

  const target = panel();
  target.render(80);
  chooseAdvisorModel(target);
  target.handleInput("\u001b[B");
  target.handleInput("\r");
  assert.deepEqual(target.getDraftAdmissions(), {
    "example-provider": { package: PACKAGE, version: VERSION },
  });
  assert.ok(
    target.render(120).some((line) => line.includes(`example-model · ${PACKAGE} ${VERSION}`)),
  );
  assert.equal(target.isDirty(), true);
  target.handleInput("a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, [{ "example-provider": { package: PACKAGE, version: VERSION } }]);
  assert.equal(applied, 1);

  const withoutStep = new DelegatePanel({
    tui: { terminal: { rows: 24 }, requestRender: () => undefined } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    global: settings,
    session: { schemaVersion: CURRENT_SCHEMA_VERSION },
    candidates: [
      { provider: "example-provider", id: "example-model", name: "Example", reasoning: true },
    ] as never,
    diagnostics: [],
    hasRuntimeError: false,
    extensionCandidates: [{ package: PACKAGE, version: VERSION }],
    extensionProviders: [],
    onApply: async () => true,
    onSaveDefaults: async () => ({ kind: "unchanged" }),
    onDone: () => undefined,
  });
  withoutStep.render(80);
  chooseAdvisorModel(withoutStep);
  assert.ok(!withoutStep.render(80).some((line) => line.startsWith("> Standard profile")));
});

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import { validateRuntime } from "../src/runtime.ts";
import { DelegatePanel } from "../src/delegate-panel.ts";
import providerExtension, {
  locateAdvisorAnthropicProvider,
} from "../src/advisor-anthropic-provider.ts";
import { advisorAgentName } from "../src/advisor-executor.ts";
import {
  appendGuardedSessionState,
  getAdvisorExtensionPath,
  getAdvisorConfigPath,
  getGlobalConfigPath,
  parseConfig,
  readConfig,
  resolveDelegateState,
  restoreSessionState,
  writeConfig,
} from "../src/config.ts";
import { CURRENT_SCHEMA_VERSION, type GlobalDefaults } from "../src/types.ts";
import {
  readConfig as read020,
  restoreSessionState as restore020,
} from "./fixtures/v0.20.0/config.ts";

const standard = { provider: "example", model: "ordinary-advisor" };
const opted = {
  provider: "anthropic",
  model: "synthetic-model",
  providerExtension: "anthropic-auth" as const,
  thinking: { level: "low" as const },
};
const settings: GlobalDefaults = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  intensity: "normal",
  small: standard,
  medium: null,
  large: null,
  advisors: [standard, opted],
  advisorMode: "on",
  advisorLaunch: "tool",
};

test("provider-dependent advisors round-trip but downgrade and broken companions silence every advisor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-provider-config-"));
  try {
    const path = getGlobalConfigPath(directory);
    assert.equal(await writeConfig(path, settings), "saved");
    assert.deepEqual((await readConfig(path)).defaults, settings);
    const old = (await read020(path)).defaults;
    assert.equal(old.advisorMode, "off");
    assert.equal(old.intensity, "normal");
    const entries: unknown[] = [];
    assert.equal(
      appendGuardedSessionState(
        {
          appendEntry: (customType, data) => {
            entries.push({ type: "custom", customType, data });
          },
        },
        settings,
      ),
      "success",
    );
    assert.deepEqual(restoreSessionState(entries), settings);
    assert.equal(restore020(entries).advisorMode, "off");
    assert.equal(
      resolveDelegateState(settings, restoreSessionState(entries.slice(0, -1))).advisorMode,
      "off",
    );
    const extension = JSON.parse(await readFile(getAdvisorExtensionPath(path), "utf8"));
    extension.state.advisors[1].model = "changed-without-matching-base";
    // Advisor 2 isn't in the legacy base; changing the base itself must invalidate the pair.
    extension.base.preference = "intensive";
    await writeFile(getAdvisorExtensionPath(path), JSON.stringify(extension));
    const corrupt = await readConfig(path);
    assert.equal(corrupt.defaults.advisorMode, "off");
    assert.match(corrupt.diagnostics[0]?.message ?? "", /Advisor remains off/);
    assert.doesNotMatch(corrupt.diagnostics[0]?.message ?? "", /Using Advisor 1/);
    assert.equal(parseConfig({ ...settings, schemaVersion: 9 }), undefined);
    assert.equal(
      parseConfig({ ...settings, advisors: [{ ...opted, providerExtension: "ambient" }] }),
      undefined,
    );
    assert.equal(advisorAgentName(standard), "pi-delegation-policy.advisor");
    assert.equal(advisorAgentName(opted), "pi-delegation-policy.advisor-anthropic-auth");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("mixed provider saves preserve branch boundaries and recover failed envelope replacements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-provider-mixed-"));
  const realNow = Date.now;
  try {
    const path = getGlobalConfigPath(directory);
    for (const advisors of [
      [opted, standard],
      [standard, opted],
    ]) {
      const state = { ...settings, advisors };
      assert.equal(await writeConfig(path, state), "saved");
      assert.deepEqual((await readConfig(path)).defaults, state);
      const before = await Promise.all(
        [path, getAdvisorConfigPath(path), getAdvisorExtensionPath(path)].map((file) =>
          readFile(file, "utf8"),
        ),
      );
      Date.now = () => 1700000000000;
      const failure = `${getAdvisorExtensionPath(path)}.${process.pid}.${Date.now()}.tmp`;
      await mkdir(failure);
      assert.equal(await writeConfig(path, { ...state, preference: "intensive" }), "unchanged");
      assert.deepEqual(
        await Promise.all(
          [path, getAdvisorConfigPath(path), getAdvisorExtensionPath(path)].map((file) =>
            readFile(file, "utf8"),
          ),
        ),
        before,
      );
      await rm(failure, { recursive: true });
      Date.now = realNow;
      const branch: unknown[] = [];
      const appendEntry = (customType: string, data: unknown) => {
        branch.push({ type: "custom", customType, data });
      };
      appendGuardedSessionState({ appendEntry }, state);
      const leaf = branch.slice();
      appendGuardedSessionState(
        { appendEntry },
        { schemaVersion: CURRENT_SCHEMA_VERSION, advisorMode: "off" },
      );
      assert.equal(resolveDelegateState(state, restoreSessionState(branch)).advisorMode, "off");
      assert.deepEqual(resolveDelegateState(state, restoreSessionState(leaf)).advisors, advisors);
      for (const failAt of [1, 2, 3, 4]) {
        const incomplete: unknown[] = [];
        appendGuardedSessionState(
          {
            appendEntry: (customType, data) => {
              incomplete.push({ type: "custom", customType, data });
            },
          },
          { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off", advisorMode: "off" },
        );
        let count = 0;
        appendGuardedSessionState(
          {
            appendEntry: (customType, data) => {
              if (++count === failAt) throw Error("synthetic write failure");
              incomplete.push({ type: "custom", customType, data });
            },
          },
          state,
        );
        assert.equal(
          resolveDelegateState(state, restoreSessionState(incomplete)).advisorMode,
          "off",
        );
      }
    }
    const off = { ...settings, intensity: "off" as const, advisorMode: "off" as const };
    const runtime = {
      global: off,
      session: { schemaVersion: CURRENT_SCHEMA_VERSION },
      effective: resolveDelegateState(off, { schemaVersion: CURRENT_SCHEMA_VERSION }),
      diagnostics: [],
      modelStatuses: new Map(),
      runtimeErrors: [],
    };
    const noProbes = new Proxy(
      {},
      {
        get() {
          throw Error("off must not access model or provider context");
        },
      },
    );
    validateRuntime(noProbes as sdk.ExtensionContext, runtime);
    assert.deepEqual(runtime.runtimeErrors, []);
  } finally {
    Date.now = realNow;
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("provider selector keeps the selected choice visible through public render and keys", async () => {
  const frames: unknown[] = [];
  for (const [width, rows] of [
    [30, 12],
    [26, 9],
    [40, 10],
    [80, 24],
  ]) {
    const panel = new DelegatePanel({
      tui: { terminal: { rows }, requestRender: () => undefined } as never,
      theme: {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      global: settings,
      session: { schemaVersion: CURRENT_SCHEMA_VERSION },
      candidates: [],
      diagnostics: [],
      hasRuntimeError: false,
      onApply: async () => true,
      onSaveDefaults: async () => ({ kind: "unchanged" }),
      onDone: () => undefined,
    });
    panel.render(width);
    panel.handleInput("\u001b[H");
    for (let index = 0; index < 18; index++) panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    for (const [key, label] of [
      ["", "Standard"],
      ["\u001b[B", "Anthropic auth"],
      ["\u001b[B", "Use global"],
      ["\u001b[A", "Anthropic auth"],
    ]) {
      if (key) panel.handleInput(key);
      const render = panel.render(width);
      assert.ok(render.length <= rows);
      assert.ok(
        render.some((line) => line.startsWith(`> ${label}`)),
        `${width}x${rows}: ${label} must be visible`,
      );
      frames.push({ width, rows, label, render });
    }
    panel.handleInput("\u001b");
    assert.equal(panel.getDraft().advisors, undefined, "Escape must not choose the draft option");
    panel.handleInput("\r");
    panel.handleInput("\u001b[B");
    assert.ok(panel.render(width).some((line) => line.startsWith("> Anthropic auth")));
    panel.handleInput("\r");
    assert.equal(panel.getDraft().advisors?.[0]?.providerExtension, "anthropic-auth");
    assert.deepEqual(
      panel.getDraft().advisors?.[0] && {
        provider: panel.getDraft().advisors![0]!.provider,
        model: panel.getDraft().advisors![0]!.model,
      },
      standard,
    );
  }
  if (process.env.PI_ADVISOR_UI_REPORT)
    await writeFile(process.env.PI_ADVISOR_UI_REPORT, JSON.stringify(frames, null, 2));
});

const sentinelSource = `export default function(pi) {
  const mode = process.env.PI_ADVISOR_SYNTHETIC_MODE;
  if (mode === "factory") throw Error("factory sentinel");
  const streamSimple = (model) => {
    const message = { role:"assistant", api:model.api, provider:model.provider, model:model.id,
      content:[{type:"text",text:"FINAL_PROVIDER_SENTINEL"}], stopReason:"stop", timestamp:0,
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
    return { async *[Symbol.asyncIterator](){ yield {type:"done",reason:"stop",message}; }, result:async()=>message };
  };
  pi.unregisterProvider("anthropic");
  pi.registerProvider("anthropic",{api:"anthropic-messages",streamSimple});
  if(mode==="mcp") pi.registerMcpServer("unexpected",{url:"http://127.0.0.1:1"});
  if(mode==="native") pi.registerProvider({id:"unexpected-native"});
  if(mode==="virtual") pi.registerVirtualModel({provider:"anthropic",id:"unexpected-virtual",route:()=>{throw Error("must not route");}});
  pi.on("session_start",()=>{
    if(mode==="start") throw Error("start sentinel");
    if(mode==="tools") pi.registerTool({name:"unexpected",description:"not allowed",parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{}})});
    pi.registerProvider("anthropic-alias",{api:"anthropic-messages",streamSimple});
  });
  pi.registerCommand("anthropic-auth:status",{description:"synthetic only",handler:async()=>{throw Error("diagnostic must never run");}});
}`;

test("the final adapter uses its real loader and dispatch guard without builtin fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-provider-runtime-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousMode = process.env.PI_ADVISOR_SYNTHETIC_MODE;
  const fetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async () => {
    network++;
    throw Error("network forbidden");
  };
  process.env.PI_CODING_AGENT_DIR = directory;
  const packageRoot = join(directory, "npm/node_modules/@gotgenes/pi-anthropic-auth");
  await mkdir(join(packageRoot, "src"), { recursive: true });
  const manifest = {
    name: "@gotgenes/pi-anthropic-auth",
    version: "3.4.3",
    pi: { extensions: ["./src/index.ts"] },
  };
  await writeFile(join(packageRoot, "src/index.ts"), sentinelSource);
  try {
    for (const mode of [
      "success",
      "factory",
      "start",
      "tools",
      "identity",
      "entry",
      "mismatch",
      "active-tools",
      "mcp",
      "native",
      "virtual",
    ]) {
      process.env.PI_ADVISOR_SYNTHETIC_MODE = mode;
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          ...manifest,
          ...(mode === "identity" ? { version: "3.4.2" } : {}),
          ...(mode === "entry" ? { pi: { extensions: ["./src/index.ts", "./extra.ts"] } } : {}),
        }),
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
      const model = runtime.getModels(mode === "mismatch" ? "openai" : "anthropic")[0]!;
      const handlers = new Map<string, (event: never, ctx: never) => unknown>();
      const commands: string[] = [];
      const api = {
        registerProvider: (name: string, config: sdk.ProviderConfig) =>
          runtime.registerProvider(name, config),
        on: (name: string, handler: (event: never, ctx: never) => unknown) => {
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
        isProjectTrusted: () => false,
        hasUI: false,
        ui: { notify: () => undefined },
      };
      await handlers.get("session_start")!({ type: "session_start" } as never, context as never);
      await handlers.get("before_agent_start")!({} as never, context as never);
      const answer = await runtime
        .streamSimple(
          model,
          { messages: [] },
          { apiKey: "synthetic-memory-only", env: {}, maxTokens: 1 },
        )
        .result();
      if (mode === "success") {
        assert.equal(answer.stopReason, "stop");
        assert.deepEqual(answer.content, [{ type: "text", text: "FINAL_PROVIDER_SENTINEL" }]);
        assert.deepEqual(commands, ["anthropic-auth:status"]);
      } else {
        assert.equal(answer.stopReason, "error", mode);
        assert.match(answer.errorMessage ?? "", /Advisor provider unavailable/, mode);
      }
      assert.equal(network, 0);
    }
    await rm(join(packageRoot, "package.json"));
    assert.equal(locateAdvisorAnthropicProvider(directory).ok, false);
  } finally {
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousMode === undefined) delete process.env.PI_ADVISOR_SYNTHETIC_MODE;
    else process.env.PI_ADVISOR_SYNTHETIC_MODE = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("final provider location rejects path escape, project shadowing and unavailable public APIs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-provider-location-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const root = join(directory, "npm/node_modules/@gotgenes/pi-anthropic-auth");
  const method = sdk.DefaultPackageManager.prototype.getInstalledPath;
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@gotgenes/pi-anthropic-auth",
        version: "3.4.3",
        pi: { extensions: ["./src/index.ts"] },
      }),
    );
    await writeFile(join(root, "src/index.ts"), "throw Error('must not import');");
    assert.equal(locateAdvisorAnthropicProvider(directory).ok, true);
    Reflect.set(sdk.DefaultPackageManager.prototype, "getInstalledPath", undefined);
    assert.equal(locateAdvisorAnthropicProvider(directory).ok, false);
    Reflect.set(sdk.DefaultPackageManager.prototype, "getInstalledPath", method);
    const project = join(directory, ".pi/npm/node_modules/@gotgenes/pi-anthropic-auth");
    await mkdir(project, { recursive: true });
    assert.equal(locateAdvisorAnthropicProvider(directory).ok, false);
    await rm(project, { recursive: true });
    await rm(join(root, "src"), { recursive: true });
    const outside = join(directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "index.ts"), "throw Error('outside must not import');");
    await symlink(outside, join(root, "src"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(locateAdvisorAnthropicProvider(directory).ok, false);
  } finally {
    Reflect.set(sdk.DefaultPackageManager.prototype, "getInstalledPath", method);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

const downgradeRoot = process.env.PI_ADVISOR_DOWNGRADE_ROOT;
test(
  "the exact 0.22.2 reader leaves provider-dependent saves off",
  { skip: !downgradeRoot },
  async () => {
    const manifest = JSON.parse(await readFile(join(downgradeRoot!, "package.json"), "utf8"));
    assert.equal(manifest.name, "pi-delegation-policy");
    assert.equal(manifest.version, "0.22.2");
    const directory = await mkdtemp(join(tmpdir(), "advisor-provider-downgrade-"));
    try {
      // Node does not strip TypeScript in node_modules. Copy the exact reader bytes,
      // without transforming or mocking them, into this disposable module directory.
      await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
      for (const name of ["config.ts", "types.ts"]) {
        await copyFile(join(downgradeRoot!, "src", name), join(directory, name));
        assert.deepEqual(
          await readFile(join(directory, name)),
          await readFile(join(downgradeRoot!, "src", name)),
        );
      }
      const old = await import(pathToFileURL(join(directory, "config.ts")).href);
      const path = getGlobalConfigPath(directory);
      await writeConfig(path, settings);
      assert.equal((await old.readConfig(path)).defaults.advisorMode, "off");
      const entries: unknown[] = [];
      appendGuardedSessionState(
        {
          appendEntry: (customType, data) => {
            entries.push({ type: "custom", customType, data });
          },
        },
        settings,
      );
      assert.equal(old.restoreSessionState(entries).advisorMode, "off");
      assert.equal(old.restoreSessionState(entries).intensity, "normal");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

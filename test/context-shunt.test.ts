import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ContextShuntAdapter } from "../src/context-shunt-adapter.ts";
import { ArtifactStore, ContextShuntEngine, shouldCompact } from "../src/context-shunt.ts";
import {
  defaultsFromEffectiveState,
  getGlobalConfigPath,
  parseConfig,
  parseSessionState,
  resolveDelegateState,
  writeConfig,
} from "../src/config.ts";
import { DelegatePanel } from "../src/delegate-panel.ts";
import piDelegationPolicy from "../src/index.ts";
import { openDelegateEditor } from "../src/ui.ts";
import { CURRENT_SCHEMA_VERSION, type GlobalDefaults, type ModelRef } from "../src/types.ts";

const small: ModelRef = { provider: "example", model: "small" };
const medium: ModelRef = { provider: "example", model: "medium" };
const large: ModelRef = { provider: "example", model: "large" };
const defaults: GlobalDefaults = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  intensity: "normal",
  preference: "standard",
  small,
  medium,
  large,
};

type SyntheticEditor = {
  focused: boolean;
  handleInput: (data: string) => void;
};

function settings(mode: "off" | "observe" | "enforce" = "enforce") {
  return resolveDelegateState(defaults, {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    contextShunt: { mode },
  }).contextShunt;
}

function model(reference: ModelRef) {
  return {
    provider: reference.provider,
    id: reference.model,
    name: reference.model,
    reasoning: true,
  };
}

function extensionContext(branch: unknown[] = []) {
  const models = [model(small), model(medium), model(large)];
  return {
    cwd: "/project",
    hasUI: true,
    mode: "tui",
    scopedModels: [],
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find((candidate) => candidate.provider === provider && candidate.id === id),
      getAvailable: () => models,
      hasConfiguredAuth: () => true,
    },
    ui: {
      theme: {
        fg: (_: string, text: string) => text,
        bg: (_: string, text: string) => text,
        bold: (text: string) => text,
      },
      notify: () => undefined,
      setStatus: () => undefined,
      custom: async () => "cancelled",
    },
  } as never;
}

async function withAgentDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-policy-context-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    return await callback(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("schema, parser, example, and documentation accept the same ContextShunt pattern corpus", async () => {
  const schema = JSON.parse(
    await readFile(join(process.cwd(), "schema/delegation-policy.schema.json"), "utf8"),
  );
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  const accepted = ["src/*.ts", "folder name/*.txt", "line\nbreak", "unicode/β*"];
  const rejected = ["", "a..b", "C:/secret", "D:\\secret", "\\\\server\\share", "safe\0unsafe"];
  for (const pattern of accepted) {
    const value = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      contextShunt: { exceptionPatterns: [pattern] },
    };
    assert.equal(validate(value), true, pattern);
    assert.ok(parseConfig(value), pattern);
  }
  for (const pattern of rejected) {
    const value = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      contextShunt: { exceptionPatterns: [pattern] },
    };
    assert.equal(validate(value), false, pattern);
    assert.equal(parseConfig(value), undefined, pattern);
  }

  const example = JSON.parse(await readFile(join(process.cwd(), "examples/global.json"), "utf8"));
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
  assert.ok(parseConfig(example));
  const configuration = await readFile(
    join(process.cwd(), "wiki/src/content/docs/configuration.md"),
    "utf8",
  );
  const documented = /```json\s*([\s\S]*?)```/.exec(configuration)?.[1];
  assert.ok(documented);
  const documentedValue = JSON.parse(documented);
  assert.equal(validate(documentedValue), true, JSON.stringify(validate.errors));
  assert.ok(parseConfig(documentedValue));
});

test("schema 2, 3, and 4 configurations accept legacy limits without reserializing them", async () => {
  const legacyLimits = { readerOutputBytes: 8192, fullReadLines: 205 };
  const schema4 = {
    schemaVersion: 4,
    intensity: "normal",
    small,
    medium,
    large,
    contextShunt: { limits: legacyLimits },
  };
  const parsed = parseConfig(schema4);
  assert.ok(parsed);
  assert.deepEqual(parsed.contextShunt?.limits, { fullReadLines: 205 });
  assert.ok(parseConfig({ schemaVersion: 2, intensity: "normal", small, medium, large }));
  assert.ok(parseConfig({ schemaVersion: 3, intensity: "normal", small, medium, large }));
  assert.ok(parseSessionState(schema4));
  assert.equal(
    parseConfig({
      ...schema4,
      contextShunt: { limits: { readerOutputBytes: 0 } },
    }),
    undefined,
  );

  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-policy-config-"));
  try {
    const path = join(directory, "delegation-policy.json");
    await writeConfig(path, parsed);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal("readerOutputBytes" in (saved.contextShunt?.limits ?? {}), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured ContextShunt mode survives delegation-off suspension when defaults are saved", () => {
  const state = resolveDelegateState(
    { ...defaults, contextShunt: { mode: "enforce", readerRole: "medium" } },
    { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off" },
  );
  assert.equal(state.contextShunt.mode, "off");
  assert.equal(state.contextShunt.configuredMode, "enforce");
  assert.equal(state.contextShunt.suspended, true);
  const saved = defaultsFromEffectiveState(state);
  assert.equal(saved.contextShunt?.mode, "enforce");
  assert.equal(
    resolveDelegateState(saved, { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "normal" })
      .contextShunt.mode,
    "enforce",
  );
});

test("off is inert, observe is non-mutating, and enforce is bounded", () => {
  const engine = new ContextShuntEngine();
  assert.deepEqual(engine.decide("read", { path: "large", limit: 999 }, settings("off")), {
    action: "skip",
    reason: "off",
  });
  assert.deepEqual(engine.metrics, {
    blocked: 0,
    wouldBlock: 0,
    boundedResults: 0,
    manualOverrides: 0,
    archiveFailures: 0,
    uncoveredResults: 0,
  });
  assert.equal(
    engine.decide("read", { path: "large", limit: 999 }, settings("observe")).action,
    "allow",
  );
  assert.equal(engine.metrics.wouldBlock, 1);
  assert.equal(engine.decide("read", { path: "large", limit: 999 }, settings()).action, "block");
});

test("valid JSON values of every root type remain untouched while ordinary text can compact", () => {
  const largeValues = [
    JSON.stringify({ value: "x".repeat(20_000) }),
    JSON.stringify(Array(20_000).fill(0)),
    JSON.stringify("x".repeat(20_000)),
    "1234567890".repeat(2_000),
    "true",
    "null",
  ];
  for (const text of largeValues) {
    assert.deepEqual(
      shouldCompact(
        "read",
        { path: "sample", limit: 400 },
        false,
        [{ type: "text", text }],
        settings(),
      ),
      { kind: "skip", reason: "uncovered-result" },
    );
  }
  assert.deepEqual(
    shouldCompact(
      "read",
      { path: "sample", limit: 400 },
      false,
      [{ type: "text", text: "line\n".repeat(400) }],
      settings(),
    ),
    { kind: "compact", text: "line\n".repeat(400), reason: "result-exceeds-budget" },
  );
});

test("recovery rejects split UTF-8 ranges and returns exact safe ranges", async () => {
  const store = new ArtifactStore();
  const id = await store.archive("αβ😀γ");
  assert.ok(id);
  assert.deepEqual(await store.recover({ artifactId: id, byteOffset: 0, maxBytes: 2 }, 32), {
    text: "α",
    range: "bytes 0-2",
  });
  assert.match(
    ((await store.recover({ artifactId: id, byteOffset: 1, maxBytes: 2 }, 32)) as { error: string })
      .error,
    /UTF-8 character boundaries/,
  );
  assert.match(
    ((await store.recover({ artifactId: id, byteOffset: 2, maxBytes: 1 }, 32)) as { error: string })
      .error,
    /UTF-8 character boundaries/,
  );
  assert.deepEqual(await store.recover({ artifactId: id, byteOffset: 2, maxBytes: 2 }, 32), {
    text: "β",
    range: "bytes 2-4",
  });
  await store.close();
});

test("preservation failures and non-builtin results keep original content", async () => {
  const adapter = new ContextShuntAdapter();
  const text = "line\n".repeat(400);
  assert.equal(
    await adapter.onToolResult(
      { toolName: "read", isError: false, content: [{ type: "text", text }] } as never,
      settings(),
      undefined,
      false,
    ),
    undefined,
  );
  const oversized = "x".repeat(65 * 1024);
  assert.equal(
    await adapter.onToolResult(
      { toolName: "read", isError: false, content: [{ type: "text", text: oversized }] } as never,
      settings(),
    ),
    undefined,
  );
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await adapter.onToolResult(
      { toolName: "read", isError: false, content: [{ type: "text", text }] } as never,
      settings(),
      controller.signal,
    ),
    undefined,
  );
  await adapter.close();
});

test("declared line budgets do not fabricate byte counts and rejected reads do not poison retries", () => {
  const engine = new ContextShuntEngine(() => 0);
  const active = settings();
  assert.equal(engine.decide("read", { path: "sample.txt", limit: 205 }, active).action, "allow");
  assert.equal(engine.decide("read", { path: "sample.txt", limit: 351 }, active).action, "block");
  assert.equal(engine.decide("read", { path: "sample.txt", limit: 100 }, active).action, "allow");
});

test("declared ranges distinguish valid targeted reads and share an admitted window", () => {
  let now = 0;
  const engine = new ContextShuntEngine(() => now);
  const active = settings();
  assert.equal(
    engine.decide("read", { path: "same", offset: 1, limit: 250 }, active).action,
    "allow",
  );
  assert.equal(engine.decide("read", { path: "same", limit: 100 }, active).action, "allow");
  assert.equal(engine.decide("read", { path: "same", limit: 1 }, active).action, "block");
  assert.equal(
    engine.decide("read", { path: "other", offset: 1, limit: 251 }, active).action,
    "block",
  );
  assert.equal(
    engine.decide("read", { path: "other", offset: 0, limit: 999 }, active).action,
    "skip",
  );
  assert.equal(engine.decide("read", { path: "other", offset: 1 }, active).action, "allow");
  now = 59_999;
  assert.equal(engine.decide("read", { path: "same", limit: 1 }, active).action, "block");
  now = 60_000;
  assert.equal(engine.decide("read", { path: "same", limit: 350 }, active).action, "allow");
});

test("post-result budgets use targeted limits and exact UTF-8 line counts", () => {
  const active = {
    ...settings(),
    limits: {
      ...settings().limits,
      fullReadBytes: 8,
      fullReadLines: 2,
      targetedReadBytes: 4,
      targetedReadLines: 2,
    },
  };
  assert.deepEqual(
    shouldCompact(
      "read",
      { path: "sample", offset: 1, limit: 1 },
      false,
      [{ type: "text", text: "αβ" }],
      active,
    ),
    { kind: "skip", reason: "within-budget" },
  );
  assert.equal(
    shouldCompact(
      "read",
      { path: "sample", offset: 1, limit: 1 },
      false,
      [{ type: "text", text: "αβγ" }],
      active,
    ).kind,
    "compact",
  );
  assert.equal(
    shouldCompact(
      "read",
      { path: "sample", limit: 1 },
      false,
      [{ type: "text", text: "a\r\nb\rc\n" }],
      active,
    ).kind,
    "compact",
  );
  assert.deepEqual(
    shouldCompact(
      "read",
      { path: "sample", limit: 1 },
      false,
      [{ type: "text", text: "" }],
      active,
    ),
    { kind: "skip", reason: "within-budget" },
  );
});

test("repeated declared reads use a bounded window that expires", () => {
  let now = 0;
  const engine = new ContextShuntEngine(() => now);
  const active = settings();
  assert.equal(engine.decide("read", { path: "same", limit: 200 }, active).action, "allow");
  assert.equal(engine.decide("read", { path: "same", limit: 200 }, active).action, "block");
  now = 60_000;
  assert.equal(engine.decide("read", { path: "same", limit: 200 }, active).action, "allow");
});

test("one-time exceptions are tied to input, adapter session, and expiry", async () => {
  let now = 0;
  const adapter = new ContextShuntAdapter({ now: () => now });
  const input = { path: "large", limit: 999 };
  const blocked = adapter.onToolCall({ toolName: "read", input } as never, settings());
  assert.ok(blocked);
  const token = /context allow ([0-9a-f-]+)/.exec(blocked.reason)?.[1];
  assert.ok(token);
  assert.equal(adapter.allowPending(token, 999, 80_000), true);
  assert.equal(
    adapter.onToolCall({ toolCallId: "allowed", toolName: "read", input } as never, settings()),
    undefined,
  );
  assert.ok(
    adapter.onToolCall({ toolName: "read", input: { ...input, offset: 1 } } as never, settings()),
  );

  const secondAdapter = new ContextShuntAdapter({ now: () => now });
  assert.equal(secondAdapter.allowPending(token, 999, 80_000), false);
  const pending = secondAdapter.onToolCall({ toolName: "read", input } as never, settings());
  assert.ok(pending);
  now = 60_001;
  const expiredTokenMatch = /context allow ([0-9a-f-]+)/.exec(pending.reason);
  assert.ok(expiredTokenMatch);
  const expiredToken = expiredTokenMatch[1];
  assert.ok(expiredToken);
  assert.equal(secondAdapter.allowPending(expiredToken, 999, 80_000), false);
  await adapter.close();
  await secondAdapter.close();
});

test("one-time exception TTL starts at the original blocked call", () => {
  let now = 0;
  const adapter = new ContextShuntAdapter({ now: () => now });
  const active = settings();
  const input = { path: "large", limit: 999 };
  const blocked = adapter.onToolCall({ toolName: "read", input } as never, active);
  const token = /context allow ([0-9a-f-]+)/.exec(blocked?.reason ?? "")?.[1];
  assert.ok(token);
  now = 59_999;
  assert.equal(adapter.allowPending(token, 999, 80_000), true);
  now = 60_000;
  assert.ok(
    adapter.onToolCall({ toolCallId: "expired", toolName: "read", input } as never, active),
  );
});

test("disabling context revokes pending and consumed exceptions", async () => {
  const now = 0;
  const adapter = new ContextShuntAdapter({ now: () => now });
  const input = { path: "large", limit: 999 };
  const pendingInput = { path: "other", limit: 999 };
  const active = settings();
  const blocked = adapter.onToolCall({ toolName: "read", input } as never, active);
  const token = /context allow ([0-9a-f-]+)/.exec(blocked?.reason ?? "")?.[1];
  const pending = adapter.onToolCall({ toolName: "read", input: pendingInput } as never, active);
  const pendingToken = /context allow ([0-9a-f-]+)/.exec(pending?.reason ?? "")?.[1];
  assert.ok(token);
  assert.ok(pendingToken);
  assert.equal(adapter.allowPending(token, 999, 80_000), true);
  assert.equal(
    adapter.onToolCall(
      { toolCallId: "consumed-before-clear", toolName: "read", input } as never,
      active,
    ),
    undefined,
  );
  assert.equal(
    await adapter.onToolResult(
      {
        toolCallId: "consumed-before-clear",
        toolName: "read",
        input,
        isError: false,
        content: [{ type: "text", text: "line\n".repeat(400) }],
      } as never,
      active,
    ),
    undefined,
  );

  const secondBlocked = adapter.onToolCall({ toolName: "read", input } as never, active);
  const secondToken = /context allow ([0-9a-f-]+)/.exec(secondBlocked?.reason ?? "")?.[1];
  assert.ok(secondToken);
  assert.equal(adapter.allowPending(secondToken, 999, 80_000), true);
  assert.equal(
    adapter.onToolCall(
      { toolCallId: "consumed-after-clear", toolName: "read", input } as never,
      active,
    ),
    undefined,
  );

  adapter.onToolCall({ toolName: "read", input } as never, { ...active, mode: "off" });
  assert.equal(adapter.allowPending(pendingToken, 999, 80_000), false);
  assert.ok(adapter.onToolCall({ toolName: "read", input } as never, active));
  assert.ok(
    await adapter.onToolResult(
      {
        toolCallId: "consumed-after-clear",
        toolName: "read",
        input,
        isError: false,
        content: [{ type: "text", text: "line\n".repeat(400) }],
      } as never,
      active,
    ),
  );
  await adapter.close();
});

test("agent_end clears consumed exceptions while pending tokens remain approvable", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), {
      ...defaults,
      contextShunt: {
        mode: "enforce",
        limits: { fullReadLines: 500, fullReadBytes: 10 },
      },
    });
    const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
    const commands = new Map<
      string,
      { handler: (args: string, context: unknown) => Promise<void> }
    >();
    const pi = {
      on: (name: string, handler: (event: unknown, context: unknown) => unknown) =>
        handlers.set(name, handler),
      registerTool: () => undefined,
      registerCommand: (
        name: string,
        options: { handler: (args: string, context: unknown) => Promise<void> },
      ) => commands.set(name, options),
      registerShortcut: () => undefined,
      getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }],
    };
    const context = extensionContext();
    piDelegationPolicy(pi as never);
    await handlers.get("session_start")?.({ type: "session_start" }, context);
    assert.equal(handlers.has("agent_end"), true);

    const consumedInput = { path: "consumed", limit: 501 };
    const consumedBlock = (await handlers.get("tool_call")?.(
      { toolName: "read", input: consumedInput },
      context,
    )) as { reason: string } | undefined;
    const consumedToken = /context allow ([0-9a-f-]+)/.exec(consumedBlock?.reason ?? "")?.[1];
    assert.ok(consumedToken);
    await commands.get("delegate")?.handler(`context allow ${consumedToken} 501 20`, context);
    assert.equal(
      await handlers.get("tool_call")?.(
        { toolCallId: "agent-ended", toolName: "read", input: consumedInput },
        context,
      ),
      undefined,
    );

    const pendingInput = { path: "pending", limit: 501 };
    const pendingBlock = (await handlers.get("tool_call")?.(
      { toolName: "read", input: pendingInput },
      context,
    )) as { reason: string } | undefined;
    const pendingToken = /context allow ([0-9a-f-]+)/.exec(pendingBlock?.reason ?? "")?.[1];
    assert.ok(pendingToken);

    await handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, context);
    assert.ok(
      await handlers.get("tool_result")?.(
        {
          toolCallId: "agent-ended",
          toolName: "read",
          input: consumedInput,
          isError: false,
          content: [{ type: "text", text: "x".repeat(11) }],
        },
        context,
      ),
      "a late result after agent_end uses ordinary byte limits",
    );
    await commands.get("delegate")?.handler(`context allow ${pendingToken} 501 20`, context);
    assert.equal(
      await handlers.get("tool_call")?.(
        { toolCallId: "pending-after-end", toolName: "read", input: pendingInput },
        context,
      ),
      undefined,
      "a normal agent end does not revoke a pending user token",
    );
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
  });
});

test("consumed exception retention is capped and evicted results use ordinary limits", async () => {
  const adapter = new ContextShuntAdapter();
  const active = {
    ...settings(),
    limits: { ...settings().limits, fullReadLines: 500, fullReadBytes: 10 },
  };
  for (let index = 0; index < 9; index += 1) {
    const input = { path: `large-${index}`, limit: 501 };
    const blocked = adapter.onToolCall({ toolName: "read", input } as never, active);
    const token = /context allow ([0-9a-f-]+)/.exec(blocked?.reason ?? "")?.[1];
    assert.ok(token);
    assert.equal(adapter.allowPending(token, 501, 20), true);
    assert.equal(
      adapter.onToolCall({ toolCallId: `call-${index}`, toolName: "read", input } as never, active),
      undefined,
    );
  }
  assert.ok(
    await adapter.onToolResult(
      {
        toolCallId: "call-0",
        toolName: "read",
        input: { path: "large-0", limit: 501 },
        isError: false,
        content: [{ type: "text", text: "x".repeat(11) }],
      } as never,
      active,
    ),
    "the evicted first result is compacted by ordinary limits",
  );
  assert.equal(
    await adapter.onToolResult(
      {
        toolCallId: "call-8",
        toolName: "read",
        input: { path: "large-8", limit: 501 },
        isError: false,
        content: [{ type: "text", text: "x".repeat(11) }],
      } as never,
      active,
    ),
    undefined,
    "the newest retained result still uses its explicit byte maximum",
  );
  await adapter.close();
});

test("the registered editor Apply revokes ContextShunt state across off and on", async () => {
  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), {
      ...defaults,
      contextShunt: { mode: "enforce" },
    });

    const branch: unknown[] = [];
    const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
    const commands = new Map<
      string,
      { handler: (args: string, context: unknown) => Promise<void> }
    >();
    const pi = {
      on: (name: string, handler: (event: unknown, context: unknown) => unknown) =>
        handlers.set(name, handler),
      registerTool: () => undefined,
      registerCommand: (
        name: string,
        options: { handler: (args: string, context: unknown) => Promise<void> },
      ) => commands.set(name, options),
      registerShortcut: () => undefined,
      getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }],
      appendEntry: (customType: string, data?: unknown) =>
        branch.push({ type: "custom", customType, data }),
    };
    const context = extensionContext(branch) as unknown as {
      ui: {
        theme: unknown;
        custom: (factory: (...args: unknown[]) => SyntheticEditor) => Promise<unknown>;
      };
    };
    context.ui.custom = (factory) =>
      new Promise((resolve, reject) => {
        try {
          const component = factory(
            { terminal: { rows: 30 }, requestRender: () => undefined },
            context.ui.theme,
            {},
            resolve,
          );
          component.focused = true;
          component.handleInput("\r");
          component.handleInput("\x1b[B");
          component.handleInput("\r");
          component.handleInput("a");
        } catch (error) {
          reject(error);
        }
      });

    piDelegationPolicy(pi as never);
    await handlers.get("session_start")?.({ type: "session_start" }, context);

    const input = { path: "large", limit: 999 };
    const blocked = (await handlers.get("tool_call")?.({ toolName: "read", input }, context)) as
      { reason: string } | undefined;
    assert.ok(blocked);
    const token = /context allow ([0-9a-f-]+)/.exec(blocked.reason)?.[1];
    assert.ok(token);
    await commands.get("delegate")?.handler(`context allow ${token} 999 80000`, context);
    assert.equal(
      await handlers.get("tool_call")?.(
        { toolCallId: "consumed-before-ui", toolName: "read", input },
        context,
      ),
      undefined,
    );
    assert.equal(
      await handlers.get("tool_result")?.(
        {
          toolCallId: "consumed-before-ui",
          toolName: "read",
          input,
          isError: false,
          content: [{ type: "text", text: "line\n".repeat(400) }],
        },
        context,
      ),
      undefined,
    );

    const secondBlocked = (await handlers.get("tool_call")?.(
      { toolName: "read", input },
      context,
    )) as { reason: string } | undefined;
    assert.ok(secondBlocked);
    const secondToken = /context allow ([0-9a-f-]+)/.exec(secondBlocked.reason)?.[1];
    assert.ok(secondToken);
    await commands.get("delegate")?.handler(`context allow ${secondToken} 999 80000`, context);
    assert.equal(
      await handlers.get("tool_call")?.(
        { toolCallId: "consumed-before-ui", toolName: "read", input },
        context,
      ),
      undefined,
    );
    assert.equal(
      await handlers.get("tool_result")?.(
        {
          toolCallId: "consumed-before-ui",
          toolName: "read",
          input,
          isError: false,
          content: [{ type: "text", text: "line\n".repeat(400) }],
        },
        context,
      ),
      undefined,
    );

    const pendingInput = { path: "pending", limit: 999 };
    const pendingBlocked = (await handlers.get("tool_call")?.(
      { toolName: "read", input: pendingInput },
      context,
    )) as { reason: string } | undefined;
    assert.ok(pendingBlocked);
    const pendingToken = /context allow ([0-9a-f-]+)/.exec(pendingBlocked.reason)?.[1];
    assert.ok(pendingToken);

    const uiBlocked = (await handlers.get("tool_call")?.({ toolName: "read", input }, context)) as
      { reason: string } | undefined;
    assert.ok(uiBlocked);
    const uiToken = /context allow ([0-9a-f-]+)/.exec(uiBlocked.reason)?.[1];
    assert.ok(uiToken);
    await commands.get("delegate")?.handler(`context allow ${uiToken} 999 80000`, context);
    assert.equal(
      await handlers.get("tool_call")?.(
        { toolCallId: "ui-consumed", toolName: "read", input },
        context,
      ),
      undefined,
    );

    await commands.get("delegate")?.handler("", context);
    assert.equal((branch.at(-1) as { data?: { intensity?: string } }).data?.intensity, "off");
    await commands.get("delegate")?.handler("", context);
    assert.equal((branch.at(-1) as { data?: { intensity?: string } }).data?.intensity, "normal");

    const afterReenable = (await handlers.get("tool_call")?.(
      { toolCallId: "ui-consumed", toolName: "read", input },
      context,
    )) as { reason: string } | undefined;
    assert.ok(afterReenable);
    assert.match(afterReenable.reason, /context allow/);
    await commands.get("delegate")?.handler(`context allow ${pendingToken} 999 80000`, context);
    assert.ok(
      await handlers.get("tool_call")?.({ toolName: "read", input: pendingInput }, context),
    );
  });
});

test("invalid recognized shell contracts keep the original result", () => {
  const active = settings();
  const oversized = [{ type: "text", text: "x".repeat(10_000) }];
  for (const toolName of ["bash", "powershell", "grep"]) {
    assert.deepEqual(shouldCompact(toolName, {}, false, oversized, active), {
      kind: "skip",
      reason: "uncovered-contract",
    });
  }
});

test("one-time exceptions require the matching call ID and immutable input", async () => {
  const adapter = new ContextShuntAdapter();
  const input = { path: "large", limit: 501 };
  const active = {
    ...settings(),
    limits: { ...settings().limits, fullReadBytes: 10, fullReadLines: 500 },
  };
  const blocked = adapter.onToolCall({ toolName: "read", input } as never, active);
  const token = /context allow ([0-9a-f-]+)/.exec(blocked?.reason ?? "")?.[1];
  assert.ok(token);
  assert.equal(adapter.allowPending(token, 501, 20), true);
  assert.equal(
    adapter.onToolCall({ toolCallId: "matching", toolName: "read", input } as never, active),
    undefined,
  );
  assert.equal(
    await adapter.onToolResult(
      {
        toolCallId: "matching",
        toolName: "read",
        input,
        isError: false,
        content: [{ type: "text", text: "x".repeat(11) }],
      } as never,
      active,
    ),
    undefined,
  );

  const second = adapter.onToolCall({ toolName: "read", input } as never, active);
  const secondToken = /context allow ([0-9a-f-]+)/.exec(second?.reason ?? "")?.[1];
  assert.ok(secondToken);
  assert.equal(adapter.allowPending(secondToken, 501, 20), true);
  assert.equal(
    adapter.onToolCall({ toolCallId: "mutated", toolName: "read", input } as never, active),
    undefined,
  );
  assert.ok(
    await adapter.onToolResult(
      {
        toolCallId: "mutated",
        toolName: "read",
        input: { ...input, extra: true },
        isError: false,
        content: [{ type: "text", text: "x".repeat(11) }],
      } as never,
      active,
    ),
  );
  await adapter.close();
});

test("unserializable inputs cannot create exceptions or break preflight", () => {
  const engine = new ContextShuntEngine();
  const input: { path: string; limit: number; self?: unknown } = { path: "large", limit: 400 };
  input.self = input;
  assert.equal(engine.allowOnce("read", input, 400, 20), false);
  assert.equal(engine.decide("read", input, settings()).action, "block");
});

test("adapter compacts only preservable successful text and recovers exact ranges", async () => {
  const adapter = new ContextShuntAdapter();
  const text = `${"α\r\n".repeat(400)}tail`;
  assert.equal(
    adapter.onToolCall(
      { toolName: "read", input: { path: "large", limit: 999 } } as never,
      settings("observe"),
    ),
    undefined,
  );
  assert.equal(
    await adapter.onToolResult(
      {
        toolCallId: "observed",
        toolName: "read",
        input: { path: "large", limit: 999 },
        isError: false,
        content: [{ type: "text", text }],
      } as never,
      settings("observe"),
    ),
    undefined,
  );
  const patch = await adapter.onToolResult(
    {
      toolCallId: "bounded",
      toolName: "read",
      input: { path: "large", limit: 999 },
      isError: false,
      content: [{ type: "text", text }],
    } as never,
    settings(),
  );
  assert.ok(patch);
  const artifactId = /recovery ([0-9a-f-]+)/.exec(patch.content?.[0]?.text ?? "")?.[1];
  assert.ok(artifactId);
  assert.deepEqual(await adapter.recover({ artifactId, lineOffset: 0, lineLimit: 2 }, settings()), {
    text: "α\r\nα\r\n",
    range: "lines 1-2",
  });
  for (const event of [
    { toolName: "read", isError: true, content: [{ type: "text", text }] },
    {
      toolName: "read",
      isError: false,
      content: [
        { type: "text", text },
        { type: "text", text },
      ],
    },
    { toolName: "read", isError: false, content: [{ type: "image", data: "x" }] },
    { toolName: "unknown", isError: false, content: [{ type: "text", text }] },
  ]) {
    assert.equal(await adapter.onToolResult(event as never, settings()), undefined);
  }
  await adapter.close();
});

test("artifact cleanup is absolute, scheduled, unrefed, and not renewed by recovery", async () => {
  let now = 0;
  const callbacks: Array<() => void> = [];
  let unrefCalls = 0;
  let clearCalls = 0;
  const setTimer = (callback: () => void) => {
    callbacks.push(callback);
    return { unref: () => (unrefCalls += 1) } as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimer = () => {
    clearCalls += 1;
  };
  const store = new ArtifactStore(() => now, setTimer, clearTimer);
  const id = await store.archive("alpha\nbeta");
  assert.ok(id);
  assert.equal(callbacks.length, 1);
  assert.equal(unrefCalls, 1);
  now = 30 * 60 * 1000 - 1;
  assert.deepEqual(await store.recover({ artifactId: id, byteOffset: 0, maxBytes: 5 }, 32), {
    text: "alpha",
    range: "bytes 0-5",
  });
  now += 1;
  callbacks.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await store.recover({ artifactId: id, byteOffset: 0, maxBytes: 5 }, 32), {
    error: "Recovery artifact is unavailable or expired.",
  });
  await store.close();
  assert.equal(clearCalls, 0);
});

test("artifact shutdown cancels scheduled cleanup and concurrent operations leave no state", async () => {
  const callbacks: Array<() => void> = [];
  let clearCalls = 0;
  const store = new ArtifactStore(
    Date.now,
    (callback) => {
      callbacks.push(callback);
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    },
    () => {
      clearCalls += 1;
    },
  );
  const ids = await Promise.all(Array.from({ length: 8 }, () => store.archive("x")));
  assert.equal(ids.filter(Boolean).length, 8);
  const artifactIds = ids.map((artifactId) => {
    assert.ok(artifactId);
    return artifactId;
  });
  assert.equal(await store.archive("x"), undefined);
  await Promise.all(
    artifactIds.map((artifactId) => store.recover({ artifactId, byteOffset: 0 }, 32)),
  );
  await store.close();
  assert.equal(clearCalls, 1);
  assert.equal(callbacks.length, 1);
  assert.deepEqual(await store.recover({ artifactId: artifactIds[0], byteOffset: 0 }, 32), {
    error: "Recovery artifact is unavailable or expired.",
  });
  await Promise.all([store.close(), store.purge()]);
});

test("archive aborts registration when close wins during delayed writing", async () => {
  let writeStarted: () => void = () => undefined;
  let releaseWrite: () => void = () => undefined;
  const writing = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const store = new ArtifactStore(Date.now, undefined, undefined, async (path, payload, signal) => {
    writeStarted();
    await release;
    await writeFile(path, payload, { flag: "wx", mode: 0o600, signal });
  });
  const archive = store.archive("delayed");
  await writing;
  const close = store.close();
  releaseWrite();
  assert.equal(await archive, undefined);
  await close;
});

test("recovery validates safe offsets and supports empty and EOF ranges", async () => {
  const store = new ArtifactStore();
  const id = await store.archive("one\r\ntwo");
  const emptyId = await store.archive("");
  assert.ok(id && emptyId);
  for (const request of [
    { artifactId: id, byteOffset: 99, maxBytes: 1 },
    { artifactId: id, byteOffset: -1, maxBytes: 1 },
    { artifactId: id, byteOffset: 0.5, maxBytes: 1 },
    { artifactId: id, byteOffset: Number.MAX_SAFE_INTEGER, maxBytes: 1 },
  ]) {
    assert.deepEqual(await store.recover(request, 32), { error: "Invalid byte range." });
  }
  for (const request of [
    { artifactId: id, lineOffset: 99, lineLimit: 1 },
    { artifactId: id, lineOffset: -1, lineLimit: 1 },
    { artifactId: id, lineOffset: 0.5, lineLimit: 1 },
  ]) {
    assert.deepEqual(await store.recover(request, 32), { error: "Invalid line range." });
  }
  assert.deepEqual(await store.recover({ artifactId: id, byteOffset: 8, maxBytes: 1 }, 32), {
    text: "",
    range: "bytes 8-8",
  });
  assert.deepEqual(await store.recover({ artifactId: emptyId, lineOffset: 0, lineLimit: 1 }, 32), {
    text: "",
    range: "lines 1-1",
  });
  await store.close();
});

test("tool hooks do not read session state or inspect provenance while ContextShunt is unknown or off", async () => {
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
  let provenanceReads = 0;
  piDelegationPolicy({
    on: (name: string, handler: (event: unknown, context: unknown) => Promise<unknown>) =>
      handlers.set(name, handler),
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    getAllTools: () => {
      provenanceReads += 1;
      return [];
    },
  } as never);
  const unsafeContext = {
    sessionManager: {
      getBranch: () => {
        throw new Error("must not read session state");
      },
    },
  };
  assert.equal(
    await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: "x", limit: 999 } },
      unsafeContext,
    ),
    undefined,
  );
  assert.equal(
    await handlers.get("tool_result")?.({ toolName: "read", content: [] }, unsafeContext),
    undefined,
  );
  assert.equal(provenanceReads, 0);

  await withAgentDirectory(async (directory) => {
    await writeConfig(getGlobalConfigPath(directory), { ...defaults, intensity: "off" });
    let branchReads = 0;
    const context = extensionContext() as unknown as {
      sessionManager: { getBranch: () => unknown[] };
    };
    context.sessionManager.getBranch = () => {
      branchReads += 1;
      return [];
    };
    await handlers.get("session_start")?.({ type: "session_start" }, context);
    branchReads = 0;
    await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: "x", limit: 999 } },
      context,
    );
    await handlers.get("tool_result")?.({ toolName: "read", content: [] }, context);
    assert.equal(branchReads, 0);
    assert.equal(provenanceReads, 0);
  });
});

test("Context advanced stages reader role, limits, patterns, reset, and disabled-role diagnostics", () => {
  const terminal = { rows: 30 };
  const panel = new DelegatePanel({
    tui: { terminal, requestRender: () => undefined } as never,
    theme: {
      fg: (_: string, text: string) => text,
      bg: (_: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    global: { ...defaults, small: null, contextShunt: { mode: "enforce" } },
    session: { schemaVersion: CURRENT_SCHEMA_VERSION },
    candidates: [model(small), model(medium), model(large)] as never,
    diagnostics: [],
    hasRuntimeError: false,
    onApply: async () => true,
    onSaveDefaults: async () => defaults,
    onDone: () => undefined,
  });
  panel.focused = true;
  for (const width of [100, 60, 40, 26]) {
    terminal.rows = 9;
    const lines = panel.render(width);
    assert.ok(lines.length <= terminal.rows);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  terminal.rows = 30;
  const wideSettings = panel.render(100);
  assert.ok(wideSettings.some((line) => line.includes("Context protection enforce")));
  assert.equal(
    wideSettings.some((line) => line.includes("Context protectionenforce")),
    false,
  );
  for (let index = 0; index < 7; index += 1) panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  assert.match(panel.render(100).join("\n"), /small is disabled/);
  assert.match(panel.render(100).join("\n"), /effective model unknown; bridge unavailable/);
  panel.handleInput("\r");
  panel.handleInput("\x1b[B");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  assert.equal(panel.getDraft().contextShunt?.readerRole, "medium");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  panel.handleInput("9");
  panel.handleInput("\r");
  assert.equal(panel.getDraft().contextShunt?.limits?.fullReadLines, 9);
  for (let index = 0; index < 5; index += 1) panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  for (const character of "src/*.ts, docs/*.md") panel.handleInput(character);
  panel.handleInput("\r");
  assert.deepEqual(panel.getDraft().contextShunt?.exceptionPatterns, ["src/*.ts", "docs/*.md"]);
  for (let index = 0; index < 7; index += 1) panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  assert.equal(panel.getDraft().contextShunt, undefined);
});

test("Use global default for Context protection preserves advanced session fields and Apply", async () => {
  const session: import("../src/types.ts").SessionDelegateState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    contextShunt: {
      mode: "enforce",
      readerRole: "medium",
      limits: { fullReadLines: 9 },
      exceptionPatterns: ["src/*.ts"],
    },
  };
  const terminal = { rows: 30 };
  let applied: typeof session | undefined;
  const panel = new DelegatePanel({
    tui: { terminal, requestRender: () => undefined } as never,
    theme: {
      fg: (_: string, text: string) => text,
      bg: (_: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    global: {
      ...defaults,
      contextShunt: { mode: "observe", readerRole: "small", limits: { fullReadLines: 350 } },
    },
    session,
    candidates: [model(small), model(medium), model(large)] as never,
    diagnostics: [],
    hasRuntimeError: false,
    onApply: async (draft) => {
      applied = draft;
      return true;
    },
    onSaveDefaults: async () => defaults,
    onDone: () => undefined,
  });
  panel.focused = true;
  for (let index = 0; index < 6; index += 1) panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  for (let index = 0; index < 3; index += 1) panel.handleInput("\x1b[A");
  panel.handleInput("\r");
  assert.deepEqual(panel.getDraft().contextShunt, {
    readerRole: "medium",
    limits: { fullReadLines: 9 },
    exceptionPatterns: ["src/*.ts"],
  });
  panel.handleInput("\x1b[B");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, panel.getDraft());
});

test("the non-interactive editor message lists ContextShunt commands", async () => {
  let notice = "";
  const context = extensionContext() as unknown as {
    mode: string;
    ui: { notify: (message: string) => void };
  };
  context.mode = "rpc";
  context.ui.notify = (message: string) => {
    notice = message;
  };
  await openDelegateEditor(context as never, { appendEntry: () => undefined } as never);
  assert.match(notice, /context off\|observe\|enforce\|status/);
});

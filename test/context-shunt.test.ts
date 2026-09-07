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
    assert.equal(shouldCompact("read", false, [{ type: "text", text }], settings()), undefined);
  }
  assert.equal(
    shouldCompact("read", false, [{ type: "text", text: "line\n".repeat(400) }], settings()),
    "line\n".repeat(400),
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
  assert.equal(adapter.onToolCall({ toolName: "read", input } as never, settings()), undefined);
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
      { toolName: "read", isError: false, content: [{ type: "text", text }] } as never,
      settings("observe"),
    ),
    undefined,
  );
  const patch = await adapter.onToolResult(
    { toolName: "read", isError: false, content: [{ type: "text", text }] } as never,
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
  for (let index = 0; index < 6; index += 1) panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  for (const character of "src/*.ts, docs/*.md") panel.handleInput(character);
  panel.handleInput("\r");
  assert.deepEqual(panel.getDraft().contextShunt?.exceptionPatterns, ["src/*.ts", "docs/*.md"]);
  for (let index = 0; index < 8; index += 1) panel.handleInput("\x1b[B");
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

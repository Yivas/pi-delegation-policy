import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { getGlobalConfigPath, writeConfig } from "../src/config.ts";
import { ContextShuntAdapter } from "../src/context-shunt-adapter.ts";
import {
  ContextShuntExecutor,
  type ReaderExecutionHost,
  type ReaderExecutorRequest,
  type ReaderExecutorResult,
} from "../src/context-shunt-executor.ts";
import { createPiDelegationPolicy } from "../src/index.ts";
import { CURRENT_SCHEMA_VERSION, type GlobalDefaults, type ModelRef } from "../src/types.ts";

const reader: ModelRef = { provider: "example", model: "reasoning-reader" };
const defaults: GlobalDefaults = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  intensity: "normal",
  preference: "standard",
  small: reader,
  medium: null,
  large: null,
  contextShunt: { mode: "enforce", readerEnabled: true, readerRole: "small", answerMaxBytes: 1024 },
};
const sentinel = "RAW-SENTINEL-MUST-NOT-LEAK";

type Handler = (event: unknown, context: unknown) => unknown;
type Tool = {
  name: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
};
type Command = { handler: (args: string, context: unknown) => Promise<void> };

class EventBus {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  on(event: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }
  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

class SpyExecutor extends ContextShuntExecutor {
  busyValue = false;
  readonly calls: ReaderExecutorRequest[] = [];
  readonly hosts: ReaderExecutionHost[] = [];
  cancelCalls = 0;
  rotateCalls = 0;
  closeCalls = 0;
  next: ReaderExecutorResult = {
    kind: "completed",
    value: { status: "answered", answer: "The evidence proves it.", citations: [] },
  };
  override get busy(): boolean {
    return this.busyValue;
  }
  override execute(
    request: ReaderExecutorRequest,
    host: ReaderExecutionHost,
    _signal?: AbortSignal,
  ): Promise<ReaderExecutorResult> {
    this.calls.push(request);
    this.hosts.push(host);
    return Promise.resolve(this.next);
  }
  override cancel(): void {
    this.cancelCalls += 1;
  }
  override rotate(): void {
    this.rotateCalls += 1;
  }
  override close(): void {
    this.closeCalls += 1;
  }
}

class CountingAdapter extends ContextShuntAdapter {
  snapshotCalls = 0;
  archiveCalls = 0;
  revalidateCalls = 0;
  archiveDerivedCalls = 0;
  discardDerivedCalls = 0;
  lastDerivedId: string | undefined;
  snapshotGate: Promise<void> | undefined;
  revalidateGate: Promise<void> | undefined;
  archiveDerivedGate: Promise<void> | undefined;
  constructor() {
    super();
    const store = this.artifacts;
    const snapshot = store.snapshotSource.bind(store);
    const archive = store.archive.bind(store);
    const revalidate = store.revalidateSource.bind(store);
    const archiveDerived = store.archiveDerived.bind(store);
    const discardDerived = store.discardDerived.bind(store);
    store.snapshotSource = async (id) => {
      this.snapshotCalls += 1;
      await this.snapshotGate;
      return snapshot(id);
    };
    store.archive = async (text, signal) => {
      this.archiveCalls += 1;
      return archive(text, signal);
    };
    store.revalidateSource = async (value) => {
      this.revalidateCalls += 1;
      await this.revalidateGate;
      return revalidate(value);
    };
    store.archiveDerived = async (value, text, signal) => {
      const id = await archiveDerived(value, text, signal);
      this.archiveDerivedCalls += 1;
      this.lastDerivedId = id;
      await this.archiveDerivedGate;
      return id;
    };
    store.discardDerived = async (id, value) => {
      this.discardDerivedCalls += 1;
      return discardDerived(id, value);
    };
  }
}

function model() {
  return { provider: reader.provider, id: reader.model, name: reader.model, reasoning: true };
}
function context(branch: unknown[] = [], cwd = "/project/context-shunt-tool") {
  const available = [model()];
  return {
    cwd,
    hasUI: false,
    mode: "rpc",
    signal: undefined,
    scopedModels: [],
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      find: (provider: string, id: string) =>
        available.find((item) => item.provider === provider && item.id === id),
      getAvailable: () => available,
      hasConfiguredAuth: () => true,
    },
    ui: {
      theme: { fg: (_: string, text: string) => text },
      setStatus: () => undefined,
      notify: () => undefined,
    },
  } as never;
}
function install(executor = new SpyExecutor(), adapter = new CountingAdapter()) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const events = new EventBus();
  const branch: unknown[] = [];
  const pi = {
    events,
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerShortcut: () => undefined,
    getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }],
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
  };
  createPiDelegationPolicy({ executor, shunt: adapter })(pi as never);
  return { executor, adapter, handlers, tools, commands, events, branch, pi };
}
async function withRuntime<T>(
  value: GlobalDefaults,
  callback: (run: ReturnType<typeof install>, ctx: ReturnType<typeof context>) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-policy-tool-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  let run: ReturnType<typeof install> | undefined;
  try {
    await writeConfig(getGlobalConfigPath(directory), value);
    run = install();
    const ctx = context(run.branch);
    return await callback(run, ctx);
  } finally {
    await run?.adapter.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
async function start(run: ReturnType<typeof install>, ctx: ReturnType<typeof context>) {
  await run.handlers.get("session_start")?.({ type: "session_start" }, ctx);
}
async function invoke(
  run: ReturnType<typeof install>,
  ctx: ReturnType<typeof context>,
  input: unknown,
) {
  return run.tools
    .get("context_shunt_delegate")
    ?.execute("call", input, undefined, () => undefined, ctx);
}
function code(result: unknown): string {
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  return (JSON.parse(text) as { code?: string }).code ?? "";
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  // Wait on a real deadline: the awaited work reads files, so a fixed number of microtask or
  // setImmediate turns is not a reliable bound on a slow or contended machine.
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 5));
  }
}

async function waitForSnapshot(adapter: CountingAdapter): Promise<void> {
  return waitFor(() => adapter.snapshotCalls > 0, "snapshot preparation did not start");
}

// The integration seam keeps the external executor out of this test while exercising the real store.
test("registers one strict delegate tool and preserves the exact request boundary", async () => {
  await withRuntime(defaults, async (run, ctx) => {
    assert.equal(run.tools.size, 2);
    const tool = run.tools.get("context_shunt_delegate");
    assert.ok(tool);
    const schema = tool.parameters as Parameters<typeof Value.Check>[0];
    assert.equal(
      Value.Check(schema, { artifactId: "artifact", question: "What is proved?", thinking: "low" }),
      true,
    );
    assert.equal(
      Value.Check(schema, { artifactId: "artifact", question: "q", thinking: "bogus" }),
      false,
    );
    assert.equal(
      Value.Check(schema, { artifactId: "artifact", question: "q", thinking: "low", extra: true }),
      false,
    );
    await start(run, ctx);
    const id = await run.adapter.artifacts.archive(`one\n${sentinel}\n`);
    assert.ok(id);
    run.executor.next = {
      kind: "completed",
      value: {
        status: "answered",
        answer: "The source contains one fact.",
        citations: [{ sourceId: id, startLine: 1, endLine: 1 }],
      },
    };
    const result = await invoke(run, ctx, {
      artifactId: id,
      question: "What does it say?",
      thinking: "low",
    });
    assert.deepEqual(JSON.parse((result as { content: Array<{ text: string }> }).content[0].text), {
      status: "answered",
      answer: "The source contains one fact.",
      citations: [{ sourceId: id, startLine: 1, endLine: 1 }],
    });
    assert.deepEqual((result as { details: unknown }).details, {});
    assert.equal(run.executor.calls.length, 1);
    const request = run.executor.calls[0];
    assert.equal(request.question, "What does it say?");
    assert.equal(request.snapshot.text, `one\n${sentinel}\n`);
    assert.deepEqual(request.model, {
      provider: "example",
      id: "reasoning-reader",
      thinking: "low",
    });
    assert.deepEqual(request.availableModels, [
      {
        provider: "example",
        id: "reasoning-reader",
        fullId: "example/reasoning-reader",
        reasoning: true,
      },
    ]);
    assert.equal(run.executor.hosts[0].cwd, "/project/context-shunt-tool");
    assert.equal(run.executor.hosts[0].events, run.events);
    assert.doesNotMatch(JSON.stringify(request), /cwd|path|config/);
    assert.equal(run.adapter.snapshotCalls, 1);
    assert.ok(run.adapter.revalidateCalls >= 1);
  });
});

test("denies inactive, invalid, busy, and expired calls before external execution", async () => {
  const cases: Array<
    [
      string,
      GlobalDefaults | undefined,
      "output-unavailable" | "invalid-request" | "evidence-expired",
      boolean,
    ]
  > = [
    ["uninitialized", undefined, "output-unavailable", false],
    [
      "delegation off suspends ContextShunt after runtime initialization",
      { ...defaults, intensity: "off" },
      "output-unavailable",
      true,
    ],
    [
      "context off",
      { ...defaults, contextShunt: { ...defaults.contextShunt, mode: "off" } },
      "output-unavailable",
      true,
    ],
    [
      "observe",
      { ...defaults, contextShunt: { ...defaults.contextShunt, mode: "observe" } },
      "output-unavailable",
      true,
    ],
    [
      "reader disabled",
      { ...defaults, contextShunt: { ...defaults.contextShunt, readerEnabled: false } },
      "output-unavailable",
      true,
    ],
    ["reader role disabled", { ...defaults, small: null }, "output-unavailable", true],
    [
      "reader model missing",
      { ...defaults, small: { provider: "missing", model: "reader" } },
      "output-unavailable",
      true,
    ],
  ];
  for (const [name, value, expected, initialize] of cases) {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegation-policy-tool-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      if (value) await writeConfig(getGlobalConfigPath(directory), value);
      const run = install();
      const ctx = context(run.branch);
      if (initialize) await start(run, ctx);
      const result = await invoke(run, ctx, {
        artifactId: "missing",
        question: sentinel,
        thinking: "low",
      });
      assert.equal(code(result), expected, name);
      assert.equal(run.executor.calls.length, 0, name);
      assert.equal(run.adapter.snapshotCalls, 0, name);
      assert.equal(run.adapter.archiveCalls, 0, name);
      await run.adapter.close();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  }
  await withRuntime(defaults, async (run, ctx) => {
    await start(run, ctx);
    run.executor.busyValue = true;
    assert.equal(
      code(await invoke(run, ctx, { artifactId: "missing", question: sentinel, thinking: "low" })),
      "reader-busy",
    );
    assert.equal(run.adapter.snapshotCalls, 0);
    run.executor.busyValue = false;
    assert.equal(
      code(
        await invoke(run, ctx, { artifactId: "missing", question: sentinel, thinking: "xhigh" }),
      ),
      "invalid-request",
    );
    assert.equal(run.adapter.snapshotCalls, 0);
    assert.equal(
      code(await invoke(run, ctx, { artifactId: "missing", question: sentinel, thinking: "low" })),
      "evidence-expired",
    );
    assert.equal(run.executor.calls.length, 0);
  });
});

test("maps executor failures and rejects completed answers without exposing raw data", async () => {
  await withRuntime(defaults, async (run, ctx) => {
    await start(run, ctx);
    const id = await run.adapter.artifacts.archive("one\ntwo");
    assert.ok(id);
    for (const [outcome, expected] of [
      [{ kind: "reader-unavailable" }, "reader-unavailable"],
      [{ kind: "failed" }, "reader-failed"],
      [{ kind: "cancelled" }, "reader-cancelled"],
      [{ kind: "timed-out" }, "reader-timed-out"],
    ] as const) {
      run.executor.next = outcome;
      const result = await invoke(run, ctx, {
        artifactId: id,
        question: sentinel,
        thinking: "low",
      });
      assert.equal(code(result), expected);
      assert.deepEqual((result as { details: unknown }).details, {});
      assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
    }
    run.executor.next = {
      kind: "completed",
      value: { status: "answered", answer: sentinel, citations: [] },
    };
    assert.equal(
      code(await invoke(run, ctx, { artifactId: id, question: "validate", thinking: "low" })),
      "invalid-answer",
    );
  });
});

test("revoking reader authorization during snapshot preparation prevents external execution", async () => {
  const revocations: Array<{
    name: string;
    revoke: (run: ReturnType<typeof install>, ctx: ReturnType<typeof context>) => Promise<unknown>;
  }> = [
    {
      name: "/delegate off",
      revoke: (run, ctx) => run.commands.get("delegate")!.handler("off", ctx),
    },
    {
      name: "/delegate reset",
      revoke: (run, ctx) => run.commands.get("delegate")!.handler("reset", ctx),
    },
    {
      name: "/delegate context off",
      revoke: (run, ctx) => run.commands.get("delegate")!.handler("context off", ctx),
    },
    {
      name: "session tree",
      revoke: (run, ctx) => run.handlers.get("session_tree")!({}, ctx) as Promise<unknown>,
    },
    {
      name: "session shutdown",
      revoke: (run, ctx) => run.handlers.get("session_shutdown")!({}, ctx) as Promise<unknown>,
    },
  ];

  for (const scenario of revocations) {
    await withRuntime(defaults, async (run, ctx) => {
      await start(run, ctx);
      const id = await run.adapter.artifacts.archive(`one\n${sentinel}\n`);
      assert.ok(id);
      let releaseSnapshot: (() => void) | undefined;
      run.adapter.snapshotGate = new Promise<void>((resolveGate) => {
        releaseSnapshot = resolveGate;
      });
      const pending = invoke(run, ctx, {
        artifactId: id,
        question: "What does it prove?",
        thinking: "low",
      }) as Promise<unknown>;
      await waitForSnapshot(run.adapter);
      await scenario.revoke(run, ctx);
      releaseSnapshot?.();
      const result = await pending;
      assert.ok(["reader-cancelled", "reader-unavailable"].includes(code(result)), scenario.name);
      assert.equal(run.executor.calls.length, 0, scenario.name);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel), scenario.name);
    });
  }
});

test("runtime refresh revokes a prepared reader when only the answer cap changes", async () => {
  await withRuntime(
    { ...defaults, contextShunt: { ...defaults.contextShunt, answerMaxBytes: 16384 } },
    async (run, ctx) => {
      await start(run, ctx);
      const id = await run.adapter.artifacts.archive(`one\n${sentinel}\n`);
      assert.ok(id);
      let releaseSnapshot: (() => void) | undefined;
      run.adapter.snapshotGate = new Promise<void>((resolveGate) => {
        releaseSnapshot = resolveGate;
      });
      const pending = invoke(run, ctx, {
        artifactId: id,
        question: "What does it prove?",
        thinking: "low",
      }) as Promise<unknown>;
      await waitForSnapshot(run.adapter);
      await writeConfig(getGlobalConfigPath(), {
        ...defaults,
        contextShunt: { ...defaults.contextShunt, answerMaxBytes: 1024 },
      });
      await run.commands.get("delegate")!.handler("status", ctx);
      releaseSnapshot?.();
      const result = await pending;
      assert.equal(code(result), "reader-cancelled");
      assert.equal(run.executor.calls.length, 0);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
    },
  );
});

test("runtime refresh revokes a prepared reader when its selected role changes", async () => {
  await withRuntime(defaults, async (run, ctx) => {
    await start(run, ctx);
    const id = await run.adapter.artifacts.archive(`one\n${sentinel}\n`);
    assert.ok(id);
    let releaseSnapshot: (() => void) | undefined;
    run.adapter.snapshotGate = new Promise<void>((resolveGate) => {
      releaseSnapshot = resolveGate;
    });
    const pending = invoke(run, ctx, {
      artifactId: id,
      question: "What does it prove?",
      thinking: "low",
    }) as Promise<unknown>;
    await waitForSnapshot(run.adapter);
    await writeConfig(getGlobalConfigPath(), {
      ...defaults,
      small: null,
      medium: reader,
      contextShunt: { ...defaults.contextShunt, readerRole: "medium" },
    });
    await run.commands.get("delegate")!.handler("status", ctx);
    releaseSnapshot?.();
    const result = await pending;
    assert.equal(code(result), "reader-cancelled");
    assert.equal(run.executor.calls.length, 0);
    assert.equal(
      run.executor.cancelCalls,
      0,
      "runtime refresh does not cancel an unlaunched reader",
    );
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
  });
});

test("revocation during final inline evidence checks returns no reader answer", async () => {
  const revocations: Array<{
    name: string;
    revoke: (run: ReturnType<typeof install>, ctx: ReturnType<typeof context>) => Promise<unknown>;
  }> = [
    {
      name: "/delegate off",
      revoke: (run, ctx) => run.commands.get("delegate")!.handler("off", ctx),
    },
    {
      name: "session tree",
      revoke: (run, ctx) => run.handlers.get("session_tree")!({}, ctx) as Promise<unknown>,
    },
  ];

  for (const scenario of revocations) {
    await withRuntime(defaults, async (run, ctx) => {
      await start(run, ctx);
      const id = await run.adapter.artifacts.archive(`one\n${sentinel}\n`);
      assert.ok(id);
      const answerText = "ANSWER-MUST-NOT-LEAK";
      run.executor.next = {
        kind: "completed",
        value: {
          status: "answered",
          answer: answerText,
          citations: [{ sourceId: id, startLine: 1, endLine: 1 }],
        },
      };
      let releaseRevalidation: (() => void) | undefined;
      run.adapter.revalidateGate = new Promise<void>((resolveGate) => {
        releaseRevalidation = resolveGate;
      });
      const pending = invoke(run, ctx, {
        artifactId: id,
        question: "What does it prove?",
        thinking: "low",
      }) as Promise<unknown>;
      await waitFor(
        () => run.adapter.revalidateCalls > 0,
        "final evidence revalidation did not start",
      );
      await scenario.revoke(run, ctx);
      releaseRevalidation?.();
      const result = await pending;
      assert.equal(code(result), "reader-cancelled", scenario.name);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(answerText), scenario.name);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel), scenario.name);
    });
  }
});

test("revocation after derived archival discards the answer and retains the source", async () => {
  await withRuntime(defaults, async (run, ctx) => {
    await start(run, ctx);
    const id = await run.adapter.artifacts.archive(`one\n${sentinel}\n`);
    assert.ok(id);
    run.executor.next = {
      kind: "completed",
      value: {
        status: "answered",
        answer: "ANSWER-MUST-NOT-LEAK ".repeat(300),
        citations: [{ sourceId: id, startLine: 1, endLine: 1 }],
      },
    };
    let releaseArchive: (() => void) | undefined;
    run.adapter.archiveDerivedGate = new Promise<void>((resolveGate) => {
      releaseArchive = resolveGate;
    });
    const pending = invoke(run, ctx, {
      artifactId: id,
      question: "What does it prove?",
      thinking: "low",
    }) as Promise<unknown>;
    await waitFor(() => run.adapter.archiveDerivedCalls > 0, "derived archival did not start");
    const derivedId = run.adapter.lastDerivedId;
    assert.ok(derivedId);
    await run.commands.get("delegate")!.handler("off", ctx);
    releaseArchive?.();
    const result = await pending;
    assert.equal(code(result), "reader-cancelled");
    assert.equal(run.adapter.discardDerivedCalls, 1);
    assert.deepEqual(
      await run.adapter.artifacts.recover(
        { artifactId: derivedId, byteOffset: 0, maxBytes: 64 },
        64,
      ),
      { error: "Recovery artifact is unavailable or expired." },
    );
    assert.deepEqual(
      await run.adapter.artifacts.recover({ artifactId: id, byteOffset: 0, maxBytes: 64 }, 64),
      {
        text: `one\n${sentinel}\n`,
        range: `bytes 0-${Buffer.byteLength(`one\n${sentinel}\n`, "utf8")}`,
      },
    );
    assert.doesNotMatch(JSON.stringify(result), /ANSWER-MUST-NOT-LEAK|RAW-SENTINEL-MUST-NOT-LEAK/);
  });
});

test("lifecycle rotates, closes, cancels on disabling commands, and hooks never launch work", async () => {
  await withRuntime(defaults, async (run, ctx) => {
    await start(run, ctx);
    const hookNames = ["before_agent_start", "tool_call", "tool_result", "agent_end"];
    for (const name of hookNames)
      await run.handlers.get(name)?.(
        { toolName: "read", input: { path: "x", limit: 1 }, content: [] },
        ctx,
      );
    assert.deepEqual(
      [
        run.executor.calls.length,
        run.executor.cancelCalls,
        run.executor.rotateCalls,
        run.executor.closeCalls,
      ],
      [0, 0, 0, 0],
    );
    const pendingInput = { path: "x", limit: 999 };
    const pendingBlock = (await run.handlers.get("tool_call")?.(
      { toolName: "read", input: pendingInput },
      ctx,
    )) as { reason?: string } | undefined;
    const pendingToken = /context allow ([0-9a-f-]+)/.exec(pendingBlock?.reason ?? "")?.[1];
    assert.ok(pendingToken);
    await run.handlers.get("session_tree")?.({}, ctx);
    assert.equal(run.executor.rotateCalls, 1);
    await run.commands.get("delegate")?.handler(`context allow ${pendingToken} 999 80000`, ctx);
    assert.ok(
      await run.handlers.get("tool_call")?.({ toolName: "read", input: pendingInput }, ctx),
      "session tree clears pending exceptions",
    );
    await run.commands.get("delegate")?.handler("off", ctx);
    await run.commands.get("delegate")?.handler("reset", ctx);
    await run.commands.get("delegate")?.handler("context off", ctx);
    assert.equal(run.executor.cancelCalls, 3);
    assert.equal(run.executor.calls.length, 0, "enabling never launches");
    await run.handlers.get("session_shutdown")?.({}, ctx);
    assert.equal(run.executor.closeCalls, 1);
  });
});

test("the selected reasoning model accepts low but not unsupported higher reader thinking", () => {
  const selected = model() as Parameters<typeof getSupportedThinkingLevels>[0];
  const levels = getSupportedThinkingLevels(selected);
  assert.ok(levels.includes("low"));
  assert.equal(levels.includes("xhigh"), false);
  assert.equal(levels.includes("max"), false);
});

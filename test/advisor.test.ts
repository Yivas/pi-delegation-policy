import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import {
  ADVISOR_ACTION_FIELDS,
  ADVISOR_ACTION_MAX_BYTES,
  ADVISOR_IMAGE_MARKER,
  ADVISOR_REQUEST_MAX_BYTES,
  ADVISOR_THREAD_MAX_EXCHANGES,
  buildAdvisorTask,
  readAdvisorThread,
  readAdvisorWindow,
} from "../src/advisor-context.ts";
import {
  ADVISOR_ADVICE_MAX_BYTES,
  ADVISOR_AGENT_NAME,
  ADVISOR_CONTEXT_MAX_BYTES,
  ADVISOR_ERROR_CODES,
  ADVISOR_PROTOCOL_VERSION,
  ADVISOR_QUESTION_MAX_BYTES,
  ADVISOR_TOOL_NAME,
  AdvisorExecutor,
  finalizeAdvisorAdvice,
  parseAdvisorRequest,
  type AdvisorErrorCode,
  type AdvisorEventBus,
  type AdvisorExecutionHost,
  type AdvisorExecutorModules,
  type AdvisorExecutorRequest,
  type AdvisorExecutorResult,
  type AdvisorThinking,
} from "../src/advisor-executor.ts";
import { getGlobalConfigPath, SESSION_ENTRY_TYPE, writeConfig } from "../src/config.ts";
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
const advisor: ModelRef = { provider: "example", model: "advisor-model" };
const sentinel = "RAW-SENTINEL-MUST-NOT-LEAK";

const defaults: GlobalDefaults = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  intensity: "normal",
  preference: "standard",
  small: reader,
  medium: null,
  large: null,
  advisor,
  contextShunt: { mode: "enforce", readerEnabled: true, readerRole: "small", answerMaxBytes: 1024 },
};

function text(bytes: number, filler = "x"): string {
  return filler.repeat(bytes);
}

function messageEntry(role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "entry",
    parentId: null,
    timestamp: "0",
    message: { role, content, ...extra },
  };
}

function assistantCalls(calls: Array<{ id: string; name: string; arguments: unknown }>) {
  return messageEntry(
    "assistant",
    calls.map((call) => ({ type: "toolCall", ...call })),
  );
}

function advisorResult(textValue: string, entryId = "c") {
  return messageEntry(
    "toolResult",
    [{ type: "text", text: JSON.stringify({ status: "advised", advice: textValue }) }],
    { toolCallId: entryId, toolName: ADVISOR_TOOL_NAME },
  );
}

type ParsedTask = {
  question: string;
  context?: string;
  window: Array<{ role: string; text: string }>;
  taskMessage: string;
  thread: Array<{ question: string; advice: string }>;
};

function parseAdvisorTask(task: string | undefined): ParsedTask {
  assert.ok(task, "the advisor task must be built");
  return JSON.parse(task) as ParsedTask;
}

test("the window keeps only allowed message blocks and never raw tool payloads", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUg==";
  const entries = [
    messageEntry("user", "Task: fix the bug"),
    messageEntry("user", [
      { type: "text", text: "Here is a screenshot" },
      { type: "image", data: base64, mimeType: "image/png" },
    ]),
    messageEntry("assistant", [
      { type: "thinking", thinking: "REASONING-SENTINEL" },
      { type: "text", text: "Looking" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/index.ts", limit: 40 } },
    ]),
    messageEntry("toolResult", [{ type: "text", text: "TOOL-RESULT-SENTINEL" }], {
      toolCallId: "c1",
      toolName: "read",
    }),
    messageEntry("bashExecution", undefined, {
      command: "cat ~/.ssh/id_rsa",
      output: "SHELL-SENTINEL",
    }),
    messageEntry("custom", "EXTENSION-SENTINEL", { customType: "intercom" }),
    messageEntry("compactionSummary", undefined, { summary: "COMPACTION-SENTINEL" }),
    messageEntry("branchSummary", undefined, { summary: "BRANCH-SENTINEL" }),
    { type: "compaction", id: "e1", parentId: null, summary: "COMPACTION-ENTRY-SENTINEL" },
    { type: "custom", id: "e2", parentId: null, customType: "x", data: "CUSTOM-ENTRY-SENTINEL" },
    { type: "session_info", id: "e3", parentId: null, name: "SESSION-INFO-SENTINEL" },
    { type: "model_change", id: "e4", parentId: null, modelId: "MODEL-CHANGE-SENTINEL" },
    { type: "label", id: "e5", parentId: null, label: "LABEL-SENTINEL" },
    { type: "thinking_level_change", id: "e6", parentId: null, thinkingLevel: "THINKING-SENTINEL" },
    assistantCalls([
      { id: "c2", name: "write", arguments: { path: "/tmp/secret", content: "WRITE-SENTINEL" } },
      { id: "c3", name: "bash", arguments: { command: "rm -rf /" } },
      { id: "c4", name: "mcp__server__tool", arguments: { token: "MCP-SENTINEL" } },
    ]),
    messageEntry("user", "And also the docs"),
  ];

  assert.deepEqual(readAdvisorWindow(entries), [
    { role: "user", text: "Task: fix the bug" },
    { role: "user", text: `Here is a screenshot\n${ADVISOR_IMAGE_MARKER}` },
    { role: "assistant", text: "Looking" },
    { role: "action", text: "read path=src/index.ts" },
    { role: "action", text: "write" },
    { role: "action", text: "bash" },
    { role: "action", text: "mcp__server__tool" },
    { role: "user", text: "And also the docs" },
  ]);

  const task = parseAdvisorTask(buildAdvisorTask(entries, "Should we ship it?", undefined));
  assert.deepEqual(task.window, readAdvisorWindow(entries));
  assert.equal(task.taskMessage, "present");
  assert.equal(task.question, "Should we ship it?");
  assert.equal("context" in task, false);
  assert.equal("thread" in task, true);

  const serialized = JSON.stringify(task);
  for (const leaked of [
    base64,
    "REASONING-SENTINEL",
    "TOOL-RESULT-SENTINEL",
    "SHELL-SENTINEL",
    "EXTENSION-SENTINEL",
    "COMPACTION-SENTINEL",
    "BRANCH-SENTINEL",
    "COMPACTION-ENTRY-SENTINEL",
    "CUSTOM-ENTRY-SENTINEL",
    "SESSION-INFO-SENTINEL",
    "MODEL-CHANGE-SENTINEL",
    "LABEL-SENTINEL",
    "THINKING-SENTINEL",
    "WRITE-SENTINEL",
    "MCP-SENTINEL",
    "cat ~/.ssh/id_rsa",
    "rm -rf /",
    "/tmp/secret",
  ]) {
    assert.equal(serialized.includes(leaked), false, leaked);
  }
});

test("the action allowlist names only its own field and caps every line", () => {
  assert.deepEqual([...ADVISOR_ACTION_FIELDS.entries()].sort(), [
    ["find", "pattern"],
    ["grep", "pattern"],
    ["ls", "path"],
    ["read", "path"],
  ]);
  assert.deepEqual(
    readAdvisorWindow([
      assistantCalls([
        {
          id: "a",
          name: "read",
          arguments: { path: "src/a.ts", content: "CONTENT-SENTINEL", pattern: "PATTERN-SENTINEL" },
        },
        { id: "b", name: "grep", arguments: { pattern: "TODO", path: "IGNORED-SENTINEL" } },
        { id: "c", name: "find", arguments: { pattern: "*.ts", path: "IGNORED-SENTINEL" } },
        { id: "d", name: "ls", arguments: { path: "src" } },
        { id: "e", name: "read", arguments: { limit: 3 } },
        { id: "f", name: "edit", arguments: { oldString: "EDIT-SENTINEL" } },
        { id: "g", name: "", arguments: { path: "EMPTY-NAME-SENTINEL" } },
      ]),
    ]),
    [
      { role: "action", text: "read path=src/a.ts" },
      { role: "action", text: "grep pattern=TODO" },
      { role: "action", text: "find pattern=*.ts" },
      { role: "action", text: "ls path=src" },
      { role: "action", text: "read" },
      { role: "action", text: "edit" },
    ],
  );

  const long = readAdvisorWindow([
    assistantCalls([{ id: "h", name: "read", arguments: { path: text(4096, "p") } }]),
  ]);
  assert.equal(long.length, 1);
  const line = long[0]!.text;
  assert.ok(line.startsWith("read path=pppp"));
  assert.ok(line.endsWith("…"));
  assert.ok(Buffer.byteLength(line, "utf8") <= ADVISOR_ACTION_MAX_BYTES);
});

test("the window marks the task message and continues without it after compaction", () => {
  const present = parseAdvisorTask(
    buildAdvisorTask(
      [messageEntry("user", "Do the thing"), messageEntry("assistant", "Done")],
      "q",
      undefined,
    ),
  );
  assert.equal(present.taskMessage, "present");

  const absent = parseAdvisorTask(
    buildAdvisorTask(
      [messageEntry("assistant", [{ type: "text", text: "Only assistant text survived" }])],
      "q",
      undefined,
    ),
  );
  assert.equal(absent.taskMessage, "absent");
  assert.deepEqual(absent.window, [{ role: "assistant", text: "Only assistant text survived" }]);

  assert.equal(parseAdvisorTask(buildAdvisorTask([], "q", undefined)).taskMessage, "absent");
});

test("the aggregate cap trims the oldest window content first and stays under 12 KiB", () => {
  const window = Array.from({ length: 40 }, (_, index) =>
    messageEntry("user", `marker-${String(index).padStart(2, "0")} ${text(1000)}`),
  );
  const question = "What should we do next?";
  const task = parseAdvisorTask(buildAdvisorTask(window, question, undefined));
  assert.ok(Buffer.byteLength(JSON.stringify(task), "utf8") <= ADVISOR_REQUEST_MAX_BYTES);
  assert.equal(task.question, question);
  assert.ok(task.window.length > 0);
  assert.equal(task.window.at(-1)!.text.startsWith("marker-39"), true);
  assert.equal(JSON.stringify(task).includes("marker-00"), false);
  assert.equal(task.taskMessage, "present");

  // A thread with priority over the window: the same window keeps fewer entries.
  const exchanges = Array.from({ length: 2 }, (_, index) => [
    assistantCalls([
      { id: `t${index}`, name: ADVISOR_TOOL_NAME, arguments: { question: `old-${index}` } },
    ]),
    advisorResult("advice " + text(4000), `t${index}`),
  ]).flat();
  const withThread = parseAdvisorTask(
    buildAdvisorTask([...exchanges, ...window], question, undefined),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(withThread), "utf8") <= ADVISOR_REQUEST_MAX_BYTES);
  assert.ok(withThread.window.length < task.window.length);
  assert.equal(withThread.thread.length, 2);
  assert.equal(withThread.thread.at(-1)!.question, "old-1");
  assert.equal(withThread.window.at(-1)!.text.startsWith("marker-39"), true);
});

test("one oversized newest message is truncated instead of dropped", () => {
  const task = parseAdvisorTask(
    buildAdvisorTask([messageEntry("user", `keep-me ${text(20 * 1024)}`)], "q", undefined),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(task), "utf8") <= ADVISOR_REQUEST_MAX_BYTES);
  assert.equal(task.window.length, 1);
  assert.equal(task.window[0].role, "user");
  assert.equal(task.window[0].text.startsWith("keep-me "), true);
  assert.equal(task.window[0].text.endsWith("…"), true);
  assert.equal(task.taskMessage, "present");
});

test("extra context travels with the question inside the same cap", () => {
  const task = parseAdvisorTask(
    buildAdvisorTask([messageEntry("user", "History")], "q", "Only the CLI is affected."),
  );
  assert.equal(task.context, "Only the CLI is affected.");
  assert.ok(Buffer.byteLength(JSON.stringify(task), "utf8") <= ADVISOR_REQUEST_MAX_BYTES);
  const empty = parseAdvisorTask(buildAdvisorTask([], "q", ""));
  assert.equal("context" in empty, false);
});

test("the thread is rebuilt from correlated history and keeps the last six exchanges", () => {
  const entries = Array.from({ length: 8 }, (_, index) => [
    assistantCalls([
      {
        id: `call-${index}`,
        name: ADVISOR_TOOL_NAME,
        arguments: { question: `Q${index}`, context: "extra" },
      },
    ]),
    advisorResult(`A${index}`, `call-${index}`),
  ]).flat();

  const thread = readAdvisorThread(entries);
  assert.equal(thread.length, 8);
  assert.deepEqual(thread.at(0), { question: "Q0", advice: "A0" });

  const task = parseAdvisorTask(buildAdvisorTask(entries, "Q8", undefined));
  assert.equal(task.thread.length, ADVISOR_THREAD_MAX_EXCHANGES);
  assert.equal(task.thread.at(0)!.question, "Q2");
  assert.equal(task.thread.at(-1)!.question, "Q7");
  assert.equal(JSON.stringify(task).includes("Q0"), false);
  // The call itself is only an action line: its arguments never reach the window.
  assert.equal(
    task.window.some((entry) => entry.text === ADVISOR_TOOL_NAME),
    true,
  );
  assert.equal(JSON.stringify(task.window).includes("extra"), false);

  const unrelated = [
    assistantCalls([
      { id: "no-result", name: ADVISOR_TOOL_NAME, arguments: { question: "PENDING" } },
    ]),
    assistantCalls([{ id: "call-2", name: ADVISOR_TOOL_NAME, arguments: { question: "Q2" } }]),
    assistantCalls([{ id: "call-3", name: ADVISOR_TOOL_NAME, arguments: { question: "Q3" } }]),
    assistantCalls([{ id: "call-4", name: ADVISOR_TOOL_NAME, arguments: { question: "Q4" } }]),
    messageEntry("assistant", [{ type: "toolCall", id: "other", name: ADVISOR_TOOL_NAME }]),
    messageEntry(
      "toolResult",
      [{ type: "text", text: JSON.stringify({ status: "error", code: "advisor-busy" }) }],
      { toolCallId: "call-3", toolName: ADVISOR_TOOL_NAME },
    ),
    messageEntry("toolResult", [{ type: "text", text: "FOREIGN" }], {
      toolCallId: "call-4",
      toolName: "read",
    }),
    advisorResult("A2", "call-2"),
  ];
  assert.deepEqual(readAdvisorThread(unrelated), [{ question: "Q2", advice: "A2" }]);
});

test("the thread survives a reload because it is read from the history, not from a store", () => {
  const entries = [
    assistantCalls([
      { id: "call", name: ADVISOR_TOOL_NAME, arguments: { question: "Earlier question" } },
    ]),
    advisorResult("Earlier advice", "call"),
    messageEntry("user", "Now the follow-up"),
  ];
  const first = buildAdvisorTask(entries, "What about the cap?", undefined);
  // `/reload` re-reads the persisted session entries into fresh objects; nothing else is kept.
  const reloaded = buildAdvisorTask(
    JSON.parse(JSON.stringify(entries)) as unknown[],
    "What about the cap?",
    undefined,
  );
  assert.equal(reloaded, first);
  const task = parseAdvisorTask(first);
  assert.deepEqual(task.thread, [{ question: "Earlier question", advice: "Earlier advice" }]);
  assert.equal(readAdvisorThread([]).length, 0);
});

test("input caps and the thinking policy are validated before anything is launched", () => {
  const supported = new Set<AdvisorThinking>(["off", "low", "medium", "high"]);
  const constraints = { supportedThinking: supported, thinkingPolicy: undefined };
  const ok = parseAdvisorRequest({ question: "q", thinking: "low" }, constraints);
  assert.equal(ok.ok, true);

  const cases: Array<[string, unknown]> = [
    ["empty question", { question: "", thinking: "low" }],
    ["missing thinking", { question: "q" }],
    ["missing question", { thinking: "low" }],
    ["unknown key", { question: "q", thinking: "low", extra: true }],
    ["non-record", "q"],
    ["unsupported level", { question: "q", thinking: "max" }],
    ["question over the cap", { question: text(ADVISOR_QUESTION_MAX_BYTES + 1), thinking: "low" }],
    [
      "question over the cap in UTF-8 bytes",
      { question: "é".repeat(ADVISOR_QUESTION_MAX_BYTES / 2 + 1), thinking: "low" },
    ],
    [
      "context over the cap",
      { question: "q", context: text(ADVISOR_CONTEXT_MAX_BYTES + 1), thinking: "low" },
    ],
    ["non-string context", { question: "q", context: 1, thinking: "low" }],
  ];
  for (const [name, value] of cases) {
    assert.deepEqual(
      parseAdvisorRequest(value, constraints),
      {
        ok: false,
        code: "advisor-invalid-request",
      },
      name,
    );
  }
  assert.equal(
    parseAdvisorRequest(
      {
        question: text(ADVISOR_QUESTION_MAX_BYTES),
        context: text(ADVISOR_CONTEXT_MAX_BYTES),
        thinking: "low",
      },
      constraints,
    ).ok,
    true,
    "exactly at the caps the request is accepted",
  );
  for (const thinking of ["off", "low", "medium", "high"] as const) {
    assert.equal(parseAdvisorRequest({ question: "q", thinking }, constraints).ok, true, thinking);
  }
  assert.equal(
    parseAdvisorRequest(
      { question: "q", thinking: "low" },
      {
        supportedThinking: new Set<AdvisorThinking>([
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]),
        thinkingPolicy: { min: "minimal", max: "max" },
      },
    ).ok,
    true,
    "a supported level inside the range is accepted",
  );

  const fixed = { supportedThinking: supported, thinkingPolicy: { level: "high" as const } };
  assert.equal(parseAdvisorRequest({ question: "q", thinking: "high" }, fixed).ok, true);
  for (const thinking of ["off", "low", "medium"] as const) {
    assert.deepEqual(
      parseAdvisorRequest({ question: "q", thinking }, fixed),
      {
        ok: false,
        code: "advisor-invalid-request",
      },
      `a fixed policy rejects ${thinking}`,
    );
  }
  const range = {
    supportedThinking: supported,
    thinkingPolicy: { min: "low" as const, max: "medium" as const },
  };
  assert.equal(parseAdvisorRequest({ question: "q", thinking: "low" }, range).ok, true);
  assert.equal(parseAdvisorRequest({ question: "q", thinking: "medium" }, range).ok, true);
  assert.equal(parseAdvisorRequest({ question: "q", thinking: "high" }, range).ok, false);
  assert.equal(parseAdvisorRequest({ question: "q", thinking: "off" }, range).ok, false);

  const parsed = parseAdvisorRequest(
    { question: "q", context: " extra ", thinking: "low" },
    constraints,
  );
  assert.deepEqual(parsed, {
    ok: true,
    value: { question: "q", context: " extra ", thinking: "low" },
  });
});

test("the reply carries the advice with the model and thinking used, capped at 8 KiB", () => {
  const reply = finalizeAdvisorAdvice("Split the module.", {
    provider: advisor.provider,
    id: advisor.model,
    thinking: "low",
  });
  assert.deepEqual(JSON.parse(reply.content[0].text), {
    status: "advised",
    advice: "Split the module.",
    model: "example/advisor-model",
    thinking: "low",
  });
  assert.deepEqual(reply.details, {});

  const atCap = finalizeAdvisorAdvice(text(ADVISOR_ADVICE_MAX_BYTES), {
    provider: advisor.provider,
    id: advisor.model,
    thinking: "low",
  });
  assert.equal(JSON.parse(atCap.content[0].text).status, "advised");

  for (const overCap of [text(ADVISOR_ADVICE_MAX_BYTES + 1), "   ", ""]) {
    const failed = finalizeAdvisorAdvice(overCap, {
      provider: advisor.provider,
      id: advisor.model,
      thinking: "low",
    });
    assert.deepEqual(JSON.parse(failed.content[0].text), {
      status: "error",
      code: "advisor-failed",
    });
    assert.equal(failed.content[0].text.length < 256, true, "the bounded error stays small");
  }
});

// The strict launch path is shared with the reader; this exercises the advisor's own definition.
const advisorAgentPath = resolve(
  fileURLToPath(new URL("../agents/pi-delegation-policy.advisor.md", import.meta.url)),
);
const digest = "a".repeat(64);
const launchRequest: AdvisorExecutorRequest = {
  task: JSON.stringify({
    question: "Should we split it?",
    window: [],
    taskMessage: "absent",
    thread: [],
  }),
  model: { provider: "example", id: "advisor-model", thinking: "low" },
  availableModels: [
    { provider: "example", id: "advisor-model", fullId: "example/advisor-model", reasoning: true },
  ],
};
const events = {
  requestEvent: "REQUEST",
  startedEvent: "STARTED",
  responseEvent: "RESPONSE",
  cancelEvent: "CANCEL",
} as const;

class FakeEventBus implements AdvisorEventBus {
  readonly emissions: Array<{ event: string; payload: unknown }> = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  on(event: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }
  emit(event: string, payload: unknown): void {
    this.emissions.push({ event, payload });
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function modelName(value = launchRequest): string {
  return `${value.model.provider}/${value.model.id}:${value.model.thinking}`;
}

function contract(
  requestId: string,
  cwd: string,
  value = launchRequest,
  mutate?: (contract: Record<string, unknown>) => void,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    version: 2,
    protocol: { lifecycleArtifactVersion: 3, packageVersion: ADVISOR_PROTOCOL_VERSION },
    runId: requestId,
    digest,
    agent: {
      name: ADVISOR_AGENT_NAME,
      localName: ADVISOR_AGENT_NAME,
      source: "package",
      packageName: "pi-delegation-policy",
      definitionProjectionVersion: 1,
      filePath: advisorAgentPath,
      definitionDigest: digest,
      shadowedCandidates: [],
    },
    launchContractDigest: digest,
    context: "fresh",
    model: modelName(value),
    modelCandidates: [modelName(value)],
    thinking: value.model.thinking,
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    skills: { requested: [], resolved: [], missing: [] },
    tools: {
      explicitAllowlist: true,
      mcp: [],
      requestedBuiltin: [],
      declaredBuiltin: [],
      effectiveAllowlist: [],
      requiredChildTools: [],
      internalTools: [],
      effectiveMcpTools: [],
      toolExtensionPaths: [],
      configuredExtensions: [],
      runtimeExtensions: ["/runtime.ts"],
      extensionArgs: ["/runtime.ts"],
      fanoutAuthorized: false,
      disableAmbientExtensions: true,
    },
    roots: { cwd: resolve(cwd) },
    diagnostics: [
      {
        severity: "host-required",
        code: "session-root-required",
        message: "The host must provide the session root.",
      },
    ],
  };
  mutate?.(result);
  return { ok: true, contract: result };
}

function modules(
  preflight: AdvisorExecutorModules["resolveSubagentLaunchContract"] = async (input) => {
    const fields = preflightFields(input);
    return contract(fields.runId as string, fields.cwd as string);
  },
): AdvisorExecutorModules {
  return { ...events, resolveSubagentLaunchContract: preflight };
}

function preflightFields(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === "object" && !Array.isArray(input));
  return input as Record<string, unknown>;
}

function tuple(payload: Record<string, unknown>) {
  return { requestId: payload.requestId, ownerRunId: payload.ownerRunId, nodeId: payload.nodeId };
}

async function waitForRequest(bus: FakeEventBus): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const emitted = bus.emissions.find((entry) => entry.event === events.requestEvent)?.payload;
    if (emitted && typeof emitted === "object" && !Array.isArray(emitted)) {
      return emitted as Record<string, unknown>;
    }
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  }
  throw new Error("request was not emitted");
}

function completed(payload: Record<string, unknown>, value: string): Record<string, unknown> {
  return {
    ...tuple(payload),
    status: "completed",
    agent: ADVISOR_AGENT_NAME,
    model: modelName(),
    thinking: launchRequest.model.thinking,
    launchContractDigest: digest,
    result: { kind: "text", text: value },
  };
}

test("preflights the packaged advisor profile as a text launch with no internal tool", async () => {
  const bus = new FakeEventBus();
  let preflight: Record<string, unknown> | undefined;
  const executor = new AdvisorExecutor({
    loader: async () =>
      modules(async (input) => {
        const fields = preflightFields(input);
        preflight = fields;
        return contract(fields.runId as string, fields.cwd as string);
      }),
  });
  const pending = executor.execute(launchRequest, { cwd: "/workspace/./advisor", events: bus });
  const emitted = await waitForRequest(bus);
  assert.ok(preflight);
  assert.deepEqual(Object.keys(preflight).sort(), [
    "agent",
    "artifacts",
    "availableModels",
    "context",
    "cwd",
    "model",
    "output",
    "runId",
    "skill",
    "task",
    "thinking",
  ]);
  assert.equal(preflight.agent, ADVISOR_AGENT_NAME);
  assert.equal("outputSchema" in preflight, false, "a text result carries no schema");
  assert.equal(preflight.task, launchRequest.task);
  assert.deepEqual(Object.keys(emitted).sort(), [
    "agent",
    "artifacts",
    "context",
    "cwd",
    "model",
    "nodeId",
    "ownerRunId",
    "requestId",
    "result",
    "skill",
    "task",
    "thinking",
    "timeoutMs",
  ]);
  assert.deepEqual(emitted.result, { kind: "text" });
  assert.equal(emitted.task, launchRequest.task);
  assert.equal(emitted.agent, ADVISOR_AGENT_NAME);
  assert.equal(emitted.model, "example/advisor-model");
  assert.equal(emitted.thinking, "low");

  bus.emit(events.startedEvent, tuple(emitted));
  bus.emit(events.responseEvent, completed(emitted, "Advice."));
  assert.deepEqual(await pending, { kind: "completed", value: "Advice." });
});

test("requires an empty internal tool allowlist and maps every terminal outcome", async () => {
  const invalid = new FakeEventBus();
  const rejected = new AdvisorExecutor({
    loader: async () =>
      modules(async (input) => {
        const fields = preflightFields(input);
        return contract(fields.runId as string, fields.cwd as string, launchRequest, (value) => {
          const tools = value.tools as Record<string, unknown>;
          tools.effectiveAllowlist = ["structured_output"];
          tools.requiredChildTools = ["structured_output"];
          tools.internalTools = ["structured_output"];
        });
      }),
  });
  assert.deepEqual(await rejected.execute(launchRequest, { cwd: "/workspace", events: invalid }), {
    kind: "advisor-unavailable",
  });
  assert.equal(invalid.emissions.length, 0);

  const mappings: Array<[string, AdvisorErrorCode]> = [
    ["timed_out", "advisor-timed-out"],
    ["cancelled", "advisor-cancelled"],
    ["interrupted", "advisor-cancelled"],
    ["structured_output_failed", "advisor-failed"],
    ["acceptance_failed", "advisor-failed"],
    ["failed", "advisor-failed"],
  ];
  for (const [status, expected] of mappings) {
    const bus = new FakeEventBus();
    const executor = new AdvisorExecutor({ loader: async () => modules() });
    const pending = executor.execute(launchRequest, { cwd: "/workspace", events: bus });
    const emitted = await waitForRequest(bus);
    bus.emit(events.startedEvent, tuple(emitted));
    bus.emit(events.responseEvent, { ...tuple(emitted), status });
    assert.deepEqual(await pending, { kind: expected }, status);
  }

  for (const status of ["invalid_request", "unavailable_context", "duplicate_node"]) {
    const bus = new FakeEventBus();
    const executor = new AdvisorExecutor({ loader: async () => modules() });
    const pending = executor.execute(launchRequest, { cwd: "/workspace", events: bus });
    const emitted = await waitForRequest(bus);
    bus.emit(events.responseEvent, { ...tuple(emitted), status, model: modelName() });
    assert.deepEqual(await pending, { kind: "advisor-unavailable" }, status);
  }

  for (const textValue of ["  ", ""]) {
    const bus = new FakeEventBus();
    const executor = new AdvisorExecutor({ loader: async () => modules() });
    const pending = executor.execute(launchRequest, { cwd: "/workspace", events: bus });
    const emitted = await waitForRequest(bus);
    bus.emit(events.startedEvent, tuple(emitted));
    bus.emit(events.responseEvent, {
      ...completed(emitted, textValue),
      result: { kind: "text", text: textValue },
    });
    assert.deepEqual(await pending, { kind: "advisor-failed" });
  }

  const nullLoader = new AdvisorExecutor({ loader: async () => undefined });
  assert.deepEqual(
    await nullLoader.execute(launchRequest, { cwd: "/workspace", events: new FakeEventBus() }),
    {
      kind: "advisor-unavailable",
    },
  );
  const closed = new AdvisorExecutor({ loader: async () => modules() });
  closed.close();
  assert.deepEqual(
    await closed.execute(launchRequest, { cwd: "/workspace", events: new FakeEventBus() }),
    {
      kind: "advisor-unavailable",
    },
  );
});

function advisorErrorOf(result: AdvisorExecutorResult): AdvisorErrorCode {
  if (result.kind === "completed") throw new Error("expected a bounded error, not advice");
  return result.kind;
}

test("produces each of the six advisor error codes from its own outcome", async () => {
  const produced = new Set<AdvisorErrorCode>();

  // advisor-invalid-request: the real request parser rejects the input before anything runs.
  const invalid = parseAdvisorRequest(
    { question: "", thinking: "low" },
    {
      supportedThinking: new Set<AdvisorThinking>(["off", "low", "medium", "high"]),
      thinkingPolicy: undefined,
    },
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) produced.add(invalid.code);

  // advisor-unavailable: the launch core cannot load the external executor.
  produced.add(
    advisorErrorOf(
      await new AdvisorExecutor({ loader: async () => undefined }).execute(launchRequest, {
        cwd: "/workspace",
        events: new FakeEventBus(),
      }),
    ),
  );

  // advisor-failed: the launch settles with a reply that carries no usable advice.
  const failedBus = new FakeEventBus();
  const failedExecutor = new AdvisorExecutor({ loader: async () => modules() });
  const failing = failedExecutor.execute(launchRequest, { cwd: "/workspace", events: failedBus });
  const failedRequest = await waitForRequest(failedBus);
  failedBus.emit(events.startedEvent, tuple(failedRequest));
  failedBus.emit(events.responseEvent, completed(failedRequest, "   "));
  produced.add(advisorErrorOf(await failing));

  // advisor-busy: a second call while the first is still in flight.
  const busyBus = new FakeEventBus();
  const busyExecutor = new AdvisorExecutor({ loader: async () => modules() });
  const inFlight = busyExecutor.execute(launchRequest, { cwd: "/workspace", events: busyBus });
  await waitForRequest(busyBus);
  produced.add(
    advisorErrorOf(
      await busyExecutor.execute(launchRequest, { cwd: "/workspace", events: busyBus }),
    ),
  );
  busyExecutor.close();
  // The closed launch settles the first call as cancelled through the same mapping.
  produced.add(advisorErrorOf(await inFlight));
  // advisor-cancelled and advisor-timed-out: terminal statuses of the launch core.
  for (const [status, expected] of [
    ["cancelled", "advisor-cancelled"],
    ["timed_out", "advisor-timed-out"],
  ] as const) {
    const bus = new FakeEventBus();
    const executor = new AdvisorExecutor({ loader: async () => modules() });
    const pending = executor.execute(launchRequest, { cwd: "/workspace", events: bus });
    const request = await waitForRequest(bus);
    bus.emit(events.startedEvent, tuple(request));
    bus.emit(events.responseEvent, { ...tuple(request), status });
    assert.equal(advisorErrorOf(await pending), expected, status);
    produced.add(expected);
  }

  assert.equal(produced.size, ADVISOR_ERROR_CODES.length, "every documented code was produced");
  assert.deepEqual([...produced].sort(), [...ADVISOR_ERROR_CODES].sort());
});

type Handler = (event: unknown, context: unknown) => unknown;
type Tool = {
  name: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
};
type Command = { handler: (args: string, context: unknown) => Promise<void> };

class EventBus {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  on(event: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }
  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

class SpyAdvisorExecutor extends AdvisorExecutor {
  busyValue = false;
  gate: Promise<void> | undefined;
  next: AdvisorExecutorResult = { kind: "completed", value: "Ask about the rollout first." };
  readonly calls: AdvisorExecutorRequest[] = [];
  readonly hosts: AdvisorExecutionHost[] = [];
  cancelCalls = 0;
  rotateCalls = 0;
  closeCalls = 0;
  override get busy(): boolean {
    return this.busyValue;
  }
  override async execute(
    request: AdvisorExecutorRequest,
    host: AdvisorExecutionHost,
    _signal?: AbortSignal,
  ): Promise<AdvisorExecutorResult> {
    this.calls.push(request);
    this.hosts.push(host);
    await this.gate;
    return this.next;
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

class SpyReaderExecutor extends ContextShuntExecutor {
  busyValue = false;
  gate: Promise<void> | undefined;
  calls = 0;
  cancelCalls = 0;
  rotateCalls = 0;
  closeCalls = 0;
  next: ReaderExecutorResult = {
    kind: "completed",
    value: { status: "answered", answer: "The source says so.", citations: [] },
  };
  override get busy(): boolean {
    return this.busyValue;
  }
  override async execute(
    _request: ReaderExecutorRequest,
    _host: ReaderExecutionHost,
    _signal?: AbortSignal,
  ): Promise<ReaderExecutorResult> {
    this.calls += 1;
    await this.gate;
    return this.next;
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

function model(reference: ModelRef) {
  return {
    provider: reference.provider,
    id: reference.model,
    name: reference.model,
    reasoning: true,
  };
}

function context(entries: unknown[] = [], cwd = "/project/advisor") {
  const available = [model(reader), model(advisor)];
  return {
    cwd,
    hasUI: false,
    mode: "rpc",
    signal: undefined,
    scopedModels: [],
    sessionManager: {
      getBranch: () => entries,
      buildContextEntries: () => entries,
    },
    modelRegistry: {
      find: (provider: string, id: string) =>
        available.find((item) => item.provider === provider && item.id === id),
      getAvailable: () => available,
      hasConfiguredAuth: () => true,
    },
    ui: {
      theme: { fg: (_: string, textValue: string) => textValue },
      setStatus: () => undefined,
      notify: () => undefined,
    },
  } as never;
}

function install(executors: { advisor?: SpyAdvisorExecutor; reader?: SpyReaderExecutor } = {}) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const branch: unknown[] = [];
  const pi = {
    events: new EventBus(),
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerShortcut: () => undefined,
    getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }],
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
  };
  const advisorExecutor = executors.advisor ?? new SpyAdvisorExecutor();
  const readerExecutor = executors.reader ?? new SpyReaderExecutor();
  const adapter = new ContextShuntAdapter();
  createPiDelegationPolicy({ executor: readerExecutor, advisor: advisorExecutor, shunt: adapter })(
    pi as never,
  );
  return { advisorExecutor, readerExecutor, handlers, tools, commands, branch, pi, adapter };
}

async function withRuntime<T>(
  value: GlobalDefaults,
  callback: (run: ReturnType<typeof install>, ctx: ReturnType<typeof context>) => Promise<T>,
  executors: { advisor?: SpyAdvisorExecutor; reader?: SpyReaderExecutor } = {},
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-policy-advisor-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  let run: ReturnType<typeof install> | undefined;
  try {
    await writeConfig(getGlobalConfigPath(directory), value);
    run = install(executors);
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

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  // Wait on a real deadline: the awaited work reads files, so a fixed number of
  // microtask turns is not a reliable bound on a slow or contended machine.
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 5));
  }
}

async function ask(
  run: ReturnType<typeof install>,
  ctx: ReturnType<typeof context>,
  input: unknown,
) {
  return run.tools.get(ADVISOR_TOOL_NAME)?.execute("call", input, undefined, () => undefined, ctx);
}

function payload(result: unknown): Record<string, unknown> {
  const textValue = (result as { content: Array<{ text: string }> }).content[0].text;
  return JSON.parse(textValue) as Record<string, unknown>;
}

test("registers the advisor tool always and reports advisor-unavailable when it is not usable", async () => {
  const cases: Array<[string, GlobalDefaults | undefined, boolean]> = [
    ["uninitialized", undefined, false],
    ["advisor not configured", { ...defaults, advisor: undefined }, true],
    [
      "advisor model missing",
      { ...defaults, advisor: { provider: "missing", model: "advisor" } },
      true,
    ],
    ["delegation off", { ...defaults, intensity: "off" }, true],
    ["advisor disabled for the session", { ...defaults }, true],
  ];
  for (const [name, value, initialize] of cases) {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegation-policy-advisor-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      if (value) await writeConfig(getGlobalConfigPath(directory), value);
      const advisorExecutor = new SpyAdvisorExecutor();
      const run = install({ advisor: advisorExecutor });
      assert.equal(run.tools.has(ADVISOR_TOOL_NAME), true, name);
      assert.deepEqual(
        [...run.tools.keys()].sort(),
        ["advisor_ask", "context_shunt_delegate", "context_shunt_recover"],
        `${name}: the tool set is fixed`,
      );
      const ctx =
        name === "advisor disabled for the session"
          ? context([
              {
                type: "custom",
                customType: SESSION_ENTRY_TYPE,
                data: { schemaVersion: CURRENT_SCHEMA_VERSION, advisor: null },
              },
            ])
          : context(run.branch);
      if (initialize) await start(run, ctx);
      const result = await ask(run, ctx, {
        question: sentinel,
        context: sentinel,
        thinking: "low",
      });
      assert.deepEqual(payload(result), { status: "error", code: "advisor-unavailable" }, name);
      assert.equal(advisorExecutor.calls.length, 0, name);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel), name);
      await run.adapter.close();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("declares the question, the optional context and the required thinking in its schema", async () => {
  await withRuntime(defaults, async (run, ctx) => {
    const tool = run.tools.get(ADVISOR_TOOL_NAME);
    assert.ok(tool);
    const schema = tool.parameters as Parameters<typeof Value.Check>[0];
    assert.equal(Value.Check(schema, { question: "q", thinking: "low" }), true);
    assert.equal(Value.Check(schema, { question: "q", context: "c", thinking: "high" }), true);
    assert.equal(Value.Check(schema, { question: "", thinking: "low" }), false);
    assert.equal(Value.Check(schema, { question: "q" }), false);
    assert.equal(Value.Check(schema, { question: "q", thinking: "bogus" }), false);
    assert.equal(Value.Check(schema, { question: "q", thinking: "low", extra: true }), false);
    await start(run, ctx);
  });
});

test("maps every advisor error code and returns bounded advice with its model and thinking", async () => {
  await withRuntime(defaults, async (run, _ctx) => {
    const entries = [
      messageEntry("user", "Task message"),
      assistantCalls([{ id: "c1", name: "read", arguments: { path: "src/index.ts" } }]),
    ];
    const callCtx = context(entries);
    await start(run, callCtx);

    const success = await ask(run, callCtx, { question: "Should we split it?", thinking: "low" });
    assert.deepEqual(payload(success), {
      status: "advised",
      advice: "Ask about the rollout first.",
      model: "example/advisor-model",
      thinking: "low",
    });
    assert.equal(run.advisorExecutor.calls.length, 1);
    const request = run.advisorExecutor.calls[0]!;
    assert.deepEqual(request.model, { provider: "example", id: "advisor-model", thinking: "low" });
    assert.deepEqual(request.availableModels, [
      {
        provider: "example",
        id: "advisor-model",
        fullId: "example/advisor-model",
        reasoning: true,
      },
    ]);
    const task = parseAdvisorTask(request.task);
    assert.equal(task.question, "Should we split it?");
    assert.deepEqual(task.window, [
      { role: "user", text: "Task message" },
      { role: "action", text: "read path=src/index.ts" },
    ]);
    assert.equal(task.taskMessage, "present");
    assert.equal(run.advisorExecutor.hosts[0]!.cwd, "/project/advisor");
    assert.equal(run.advisorExecutor.hosts[0]!.events, run.pi.events);

    run.advisorExecutor.busyValue = true;
    assert.deepEqual(payload(await ask(run, callCtx, { question: "again", thinking: "low" })), {
      status: "error",
      code: "advisor-busy",
    });
    run.advisorExecutor.busyValue = false;

    for (const [outcome, expected] of [
      [{ kind: "advisor-unavailable" }, "advisor-unavailable"],
      [{ kind: "advisor-failed" }, "advisor-failed"],
      [{ kind: "advisor-timed-out" }, "advisor-timed-out"],
      [{ kind: "advisor-cancelled" }, "advisor-cancelled"],
    ] as const) {
      run.advisorExecutor.next = outcome;
      const result = await ask(run, callCtx, { question: sentinel, thinking: "low" });
      assert.deepEqual(payload(result), { status: "error", code: expected });
      assert.deepEqual((result as { details: unknown }).details, {});
      assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
    }

    run.advisorExecutor.next = { kind: "completed", value: text(ADVISOR_ADVICE_MAX_BYTES + 1) };
    const overCap = await ask(run, callCtx, { question: "q", thinking: "low" });
    assert.deepEqual(payload(overCap), { status: "error", code: "advisor-failed" });
    assert.equal(JSON.stringify(overCap).length < 256, true);

    for (const input of [
      { question: "", thinking: "low" },
      { question: "q", context: text(ADVISOR_CONTEXT_MAX_BYTES + 1), thinking: "low" },
      { question: "q", thinking: "max" },
      { question: "q", thinking: "low", extra: true },
    ]) {
      assert.deepEqual(payload(await ask(run, callCtx, input)), {
        status: "error",
        code: "advisor-invalid-request",
      });
    }
    assert.equal(run.advisorExecutor.calls.length, 6, "no invalid input reached the executor");
  });
});

test("one pending request per advisor, and a busy advisor never disturbs the reader", async () => {
  await withRuntime(defaults, async (run, ctx) => {
    await start(run, ctx);
    const source = await run.adapter.artifacts.archive("one\ntwo\n");
    assert.ok(source);
    run.readerExecutor.next = {
      kind: "completed",
      value: {
        status: "answered",
        answer: "The source says so.",
        citations: [{ sourceId: source, startLine: 1, endLine: 1 }],
      },
    };
    const entries = [messageEntry("user", "Task message")];
    const callCtx = context(entries);

    // A reader in flight keeps its own pending request while the advisor is busy.
    let releaseReader: (() => void) | undefined;
    run.readerExecutor.gate = new Promise<void>((resolveGate) => {
      releaseReader = resolveGate;
    });
    const readerCall = run.tools
      .get("context_shunt_delegate")!
      .execute(
        "call",
        { artifactId: source, question: "What does it say?", thinking: "low" },
        undefined,
        () => undefined,
        callCtx,
      ) as Promise<unknown>;
    await waitFor(
      () => run.readerExecutor.calls === 1,
      "the reader request did not reach the executor",
    );
    run.advisorExecutor.busyValue = true;
    assert.deepEqual(payload(await ask(run, callCtx, { question: "q", thinking: "low" })), {
      status: "error",
      code: "advisor-busy",
    });
    run.advisorExecutor.busyValue = false;
    const advice = await ask(run, callCtx, { question: "q", thinking: "low" });
    assert.equal(payload(advice).status, "advised");
    assert.equal(run.readerExecutor.cancelCalls, 0, "the advisor never cancels the reader");
    releaseReader?.();
    assert.equal(payload(await readerCall).status, "answered");

    // The reverse: a reader request while the advisor is still in flight.
    let releaseAdvisor: (() => void) | undefined;
    run.advisorExecutor.gate = new Promise<void>((resolveGate) => {
      releaseAdvisor = resolveGate;
    });
    run.readerExecutor.gate = undefined;
    run.readerExecutor.busyValue = false;
    const advisorCall = ask(run, callCtx, { question: "still thinking", thinking: "low" });
    const answered = await run.tools
      .get("context_shunt_delegate")!
      .execute(
        "call",
        { artifactId: source, question: "What else?", thinking: "low" },
        undefined,
        () => undefined,
        callCtx,
      );
    assert.equal(payload(answered).status, "answered");
    assert.equal(run.advisorExecutor.cancelCalls, 0, "the reader never cancels the advisor");
    releaseAdvisor?.();
    assert.equal(payload(await advisorCall).status, "advised");
  });
});

test("lifecycle rotates, closes and revokes the advisor without touching the reader", async () => {
  await withRuntime(defaults, async (run, ctx) => {
    await start(run, ctx);
    await run.handlers.get("session_tree")?.({}, ctx);
    assert.equal(run.advisorExecutor.rotateCalls, 1);
    assert.equal(run.readerExecutor.rotateCalls, 1);

    await run.commands.get("delegate")!.handler("context off", ctx);
    assert.equal(run.readerExecutor.cancelCalls, 1);
    assert.equal(
      run.advisorExecutor.cancelCalls,
      0,
      "a ContextShunt change does not revoke the advisor",
    );

    await run.commands.get("delegate")!.handler("off", ctx);
    assert.equal(run.readerExecutor.cancelCalls, 2);
    assert.equal(run.advisorExecutor.cancelCalls, 1);

    await run.handlers.get("session_shutdown")?.({}, ctx);
    assert.equal(run.advisorExecutor.closeCalls, 1);
    assert.equal(run.readerExecutor.closeCalls, 1);
    assert.deepEqual(
      [...run.tools.keys()].sort(),
      ["advisor_ask", "context_shunt_delegate", "context_shunt_recover"],
      "the advisor is never launched from a hook",
    );
    assert.equal(run.advisorExecutor.calls.length, 0);
  });
});

test("a revocation while an advisor request is in flight returns advisor-cancelled, not the advice", async () => {
  const adviceText = "ADVICE-MUST-NOT-LEAK";
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
      name: "session tree",
      revoke: (run, ctx) => run.handlers.get("session_tree")!({}, ctx) as Promise<unknown>,
    },
    {
      name: "session shutdown",
      revoke: (run, ctx) => run.handlers.get("session_shutdown")!({}, ctx) as Promise<unknown>,
    },
    {
      name: "runtime refresh after the advisor model changes",
      revoke: async (run, ctx) => {
        await writeConfig(getGlobalConfigPath(), { ...defaults, advisor: reader });
        await run.commands.get("delegate")!.handler("status", ctx);
      },
    },
  ];

  for (const scenario of revocations) {
    await withRuntime(defaults, async (run, ctx) => {
      await start(run, ctx);
      run.advisorExecutor.next = { kind: "completed", value: adviceText };
      let release: (() => void) | undefined;
      run.advisorExecutor.gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      const pending = ask(run, context([messageEntry("user", "Task message")]), {
        question: "Should we ship it?",
        thinking: "low",
      });
      await waitFor(
        () => run.advisorExecutor.calls.length === 1,
        `${scenario.name}: the advisor request did not reach the executor`,
      );
      await scenario.revoke(run, ctx);
      release?.();
      const result = await pending;
      assert.deepEqual(
        payload(result),
        { status: "error", code: "advisor-cancelled" },
        scenario.name,
      );
      assert.doesNotMatch(JSON.stringify(result), new RegExp(adviceText), scenario.name);
    });
  }
});

test("no source of the advisor writes a file, spawns a process, or reaches the network", async () => {
  const source = await readFile(join(process.cwd(), "src", "advisor-executor.ts"), "utf8");
  const window = await readFile(join(process.cwd(), "src", "advisor-context.ts"), "utf8");
  const joined = `${source}\n${window}`;
  assert.doesNotMatch(joined, /node:fs|node:os|node:child_process|tmpdir|archiveDerived/);
  assert.doesNotMatch(joined, /\bfetch\s*\(|https?:\/\//);
});

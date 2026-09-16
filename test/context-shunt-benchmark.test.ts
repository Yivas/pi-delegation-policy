import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const { aggregateBenchmarkMatrix, aggregateBenchmarkRun } = await import(
  new URL("../scripts/benchmark-context-shunt.mjs", import.meta.url).href
);
const runCommand = promisify(execFile);

test("aggregates a parent run and unique nested runs without duplicating shared IDs", () => {
  const summary = aggregateBenchmarkRun({
    id: "parent",
    usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4 },
    cost: 1.5,
    durationMs: 100,
    retries: 1,
    children: [
      {
        id: "child",
        usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
        cost: 2.5,
        durationMs: 200,
        status: "failed",
        exceptions: 1,
      },
    ],
    subruns: [
      {
        id: "child",
        usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
        cost: 2.5,
        durationMs: 200,
        status: "failed",
        exceptions: 1,
      },
      {
        id: "grandchild",
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        cost: 3,
        durationMs: 300,
        status: "timed_out",
        recoveries: 1,
      },
    ],
  });

  assert.deepEqual(summary, {
    runCount: 3,
    usage: { input: 16, output: 28, cacheRead: 13, cacheWrite: 16 },
    cost: 7,
    durationMs: 600,
    failures: 1,
    timeouts: 1,
    cancellations: 0,
    retries: 1,
    recoveries: 1,
    contractViolations: 0,
    unnecessaryOperationalBlocks: 0,
    exceptions: 1,
  });
});

test("keeps usage dimensions separate and propagates unknown provider metrics", () => {
  const summary = aggregateBenchmarkMatrix([
    {
      id: "complete",
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
      cost: 1,
      durationMs: 50,
    },
    {
      id: "missing-metrics",
      usage: { input: 1, cacheRead: 2, cacheWrite: 3 },
      durationMs: 5,
    },
  ]);

  assert.deepEqual(summary.usage, {
    input: 11,
    output: "unknown",
    cacheRead: 32,
    cacheWrite: 43,
  });
  assert.equal(summary.cost, "unknown");
  assert.equal(summary.durationMs, 55);
});

test("counts terminal statuses and explicitly reported benchmark events", () => {
  const summary = aggregateBenchmarkMatrix([
    {
      id: "failure",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      durationMs: 1,
      status: "failed",
      retries: 2,
      contractViolations: 1,
    },
    {
      id: "cancelled",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      durationMs: 1,
      status: "cancelled",
      recoveries: 2,
      unnecessaryOperationalBlocks: 3,
      exceptions: 4,
    },
    {
      id: "provider-error",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      durationMs: 1,
      status: "error",
    },
  ]);

  assert.deepEqual(
    {
      failures: summary.failures,
      timeouts: summary.timeouts,
      cancellations: summary.cancellations,
      retries: summary.retries,
      recoveries: summary.recoveries,
      contractViolations: summary.contractViolations,
      unnecessaryOperationalBlocks: summary.unnecessaryOperationalBlocks,
      exceptions: summary.exceptions,
    },
    {
      failures: 2,
      timeouts: 0,
      cancellations: 1,
      retries: 2,
      recoveries: 2,
      contractViolations: 1,
      unnecessaryOperationalBlocks: 3,
      exceptions: 4,
    },
  );
});

test("requires the timed_out status spelling", () => {
  const completedRun = {
    id: "timeout",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    durationMs: 0,
  };

  assert.equal(aggregateBenchmarkRun({ ...completedRun, status: "timed_out" }).timeouts, 1);
  assert.throws(() => aggregateBenchmarkRun({ ...completedRun, status: "timed-out" }), /status/);
});

test("rejects aggregate sums that overflow to non-finite values", () => {
  const run = (id: string, metrics: Record<string, number>) => ({
    id,
    usage: {
      input: metrics.input ?? 0,
      output: metrics.output ?? 0,
      cacheRead: metrics.cacheRead ?? 0,
      cacheWrite: metrics.cacheWrite ?? 0,
    },
    cost: metrics.cost ?? 0,
    durationMs: metrics.durationMs ?? 0,
  });

  assert.throws(
    () =>
      aggregateBenchmarkMatrix([
        run("cost-a", { cost: Number.MAX_VALUE }),
        run("cost-b", { cost: Number.MAX_VALUE }),
      ]),
    /aggregate.cost/,
  );
  assert.throws(
    () =>
      aggregateBenchmarkMatrix([
        run("usage-a", { input: Number.MAX_VALUE }),
        run("usage-b", { input: Number.MAX_VALUE }),
      ]),
    /aggregate.input/,
  );
  assert.throws(
    () =>
      aggregateBenchmarkMatrix([
        run("duration-a", { durationMs: Number.MAX_VALUE }),
        run("duration-b", { durationMs: Number.MAX_VALUE }),
      ]),
    /aggregate.durationMs/,
  );
});

test("fails closed for ambiguous IDs and malformed metrics", () => {
  const complete = {
    id: "same",
    usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    cost: 1,
    durationMs: 1,
  };

  assert.throws(() => aggregateBenchmarkMatrix([complete, { ...complete, cost: 2 }]), /ambiguous/);
  assert.throws(
    () => aggregateBenchmarkRun({ ...complete, usage: { ...complete.usage, input: -1 } }),
    /usage.input/,
  );
  assert.throws(() => aggregateBenchmarkRun({ ...complete, cost: Number.NaN }), /cost/);
  assert.throws(() => aggregateBenchmarkRun({ ...complete, durationMs: Infinity }), /durationMs/);
  assert.throws(() => aggregateBenchmarkRun({ ...complete, retries: 1.5 }), /retries/);
});

test("importing the runner has no CLI side effect", async () => {
  const { stderr, stdout } = await runCommand(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("./scripts/benchmark-context-shunt.mjs")'],
    { cwd: process.cwd() },
  );

  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("the default CLI remains a deterministic offline dry-run", async () => {
  const command = ["scripts/benchmark-context-shunt.mjs"];
  const first = await runCommand(process.execPath, command, { cwd: process.cwd() });
  const second = await runCommand(process.execPath, command, { cwd: process.cwd() });

  assert.equal(first.stderr, "");
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(JSON.parse(first.stdout), {
    schemaVersion: 1,
    status: "dry-run",
    offline: true,
    providerCalls: 0,
    caseCount: 12,
    corpus: { lineCount: 620, encoding: "utf-8", physicalLineEnding: "LF" },
    cases: JSON.parse(first.stdout).cases,
  });
});

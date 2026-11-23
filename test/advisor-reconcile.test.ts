import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAdvisorContinuity,
  isAdvisorContinuityPlanEmpty,
  planAdvisorContinuity,
  planAdvisorContinuityAbandon,
  type AdvisorContinuityEvidence,
  type AdvisorRunEvidence,
  type AdvisorRunsSnapshot,
  type AdvisorRunState,
} from "../src/advisor-reconcile.ts";
import type {
  AdvisorParentPartition,
  AdvisorThreadRecord,
  AdvisorThreadState,
} from "../src/advisor-threads.ts";

const PROFILE = "pi-delegation-policy.advisor";
const NOW = 1_700_000_000_000;

type RecordInput = {
  slot?: number;
  taskToken?: string;
  state?: AdvisorThreadState;
  operationRunId?: string;
  updatedAt?: number;
};

function record(input: RecordInput = {}): AdvisorThreadRecord {
  const state = input.state ?? "blocked";
  return {
    slot: input.slot ?? 0,
    taskToken: input.taskToken ?? "task-aaaaaaaa",
    fingerprint: {
      provider: "example",
      model: "first",
      thinking: "high",
      profile: PROFILE,
      admission: "",
      packageVersion: "0.33.1",
      epoch: 1,
    },
    state,
    reason: state === "answered" ? "answered" : "resume-uncertain",
    ordinal: 1,
    ...(input.operationRunId === undefined ? {} : { operationRunId: input.operationRunId }),
    runIds: [],
    updatedAt: input.updatedAt ?? NOW,
  };
}

const partitionOf = (...threads: AdvisorThreadRecord[]): AdvisorParentPartition => ({
  updatedAt: NOW,
  threads,
});

function evidence(input: {
  states?: Record<string, AdvisorRunState>;
  runs?: AdvisorRunsSnapshot;
}): AdvisorContinuityEvidence {
  return {
    runState: async (runId) =>
      input.states?.[runId] ?? ({ ok: false, reason: "unknown-run" } as const),
    runs: async () => input.runs ?? ({ ok: true, runs: [], complete: true } as const),
  };
}

const wholeList = (...runs: AdvisorRunEvidence[]): AdvisorRunsSnapshot => ({
  ok: true,
  runs,
  complete: true,
});

const liveRun = (label = PROFILE, startedAt = NOW - 1_000): AdvisorRunEvidence => ({
  label,
  state: "running",
  startedAt,
});

test("a receipt proves the turn either terminal or live, and nothing else", async () => {
  const terminal = await planAdvisorContinuity({
    partition: partitionOf(record({ operationRunId: "run-1" })),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({ states: { "run-1": { ok: true, state: "stopped" } } }),
  });
  assert.deepEqual(
    terminal.closures.map((closure) => closure.proof),
    ["terminal"],
  );
  assert.equal(terminal.kept.length, 0);

  const live = await planAdvisorContinuity({
    partition: partitionOf(record({ operationRunId: "run-1" })),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({ states: { "run-1": { ok: true, state: "running" } } }),
  });
  assert.deepEqual(
    live.kept.map((held) => held.cause),
    ["live"],
  );
  assert.equal(live.closures.length, 0);

  // A state this reader does not know is not evidence of anything, not even of absence.
  const strange = await planAdvisorContinuity({
    partition: partitionOf(record({ operationRunId: "run-1" })),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({ states: { "run-1": { ok: true, state: "restarting" } } }),
  });
  assert.deepEqual(
    strange.kept.map((held) => held.cause),
    ["unknown"],
  );

  // The same holds for a run in the session list whose state this reader cannot classify.
  const unclassified = await planAdvisorContinuity({
    partition: partitionOf(record()),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({ runs: wholeList({ label: PROFILE, state: "cancelled", startedAt: NOW }) }),
  });
  assert.deepEqual(
    unclassified.kept.map((held) => held.cause),
    ["unknown"],
  );
  assert.equal(unclassified.closures.length, 0);
});

test("a bridge that does not answer never closes a record that carries a receipt", async () => {
  const plan = await planAdvisorContinuity({
    partition: partitionOf(record({ operationRunId: "run-1" })),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({ states: { "run-1": { ok: false, reason: "unavailable" } } }),
  });
  assert.equal(plan.closures.length, 0, "silence is not absence");
  assert.deepEqual(
    plan.kept.map((held) => held.cause),
    ["unknown"],
  );
});

test("a host that answers without the run lets the session list decide", async () => {
  const plan = await planAdvisorContinuity({
    partition: partitionOf(record({ operationRunId: "run-gone" })),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({
      states: { "run-gone": { ok: false, reason: "unknown-run" } },
      runs: wholeList(),
    }),
  });
  assert.deepEqual(
    plan.closures.map((closure) => closure.proof),
    ["absent"],
  );
});

test("absence only counts on a whole list without a live run that may be ours", async () => {
  const trimmed = await planAdvisorContinuity({
    partition: partitionOf(record()),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({ runs: { ok: true, runs: [], complete: false } }),
  });
  assert.deepEqual(
    trimmed.kept.map((held) => held.cause),
    ["unknown"],
  );

  const named = await planAdvisorContinuity({
    partition: partitionOf(record()),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({ runs: wholeList(liveRun()) }),
  });
  assert.deepEqual(
    named.kept.map((held) => held.cause),
    ["live"],
  );

  const queued = await planAdvisorContinuity({
    partition: partitionOf(record()),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({
      runs: wholeList({ label: PROFILE, state: "queued", startedAt: NOW }),
    }),
  });
  assert.deepEqual(
    queued.kept.map((held) => held.cause),
    ["live"],
    "a queued run is still ours",
  );

  // A job whose steps the host does not know yet carries no agent name: it may be ours.
  const unnamed = await planAdvisorContinuity({
    partition: partitionOf(record()),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({ runs: wholeList(liveRun("single")) }),
  });
  assert.deepEqual(
    unnamed.kept.map((held) => held.cause),
    ["live"],
  );

  // Another agent, or a run that started long after the thread died, belongs to something else.
  const other = await planAdvisorContinuity({
    partition: partitionOf(record()),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({ runs: wholeList(liveRun("pi-delegation-policy.bulk-reader")) }),
  });
  assert.deepEqual(
    other.closures.map((closure) => closure.proof),
    ["absent"],
  );

  // A live run of ours that started outside the window is not this turn, but it is not proof that
  // this turn is gone either: a queued resume can start long after the record was written.
  const later = await planAdvisorContinuity({
    partition: partitionOf(record({ updatedAt: NOW - 60 * 60 * 1000 })),
    activeTaskToken: "task-bbbbbbbb",
    evidence: evidence({ runs: wholeList(liveRun(PROFILE, NOW)) }),
    startGraceMs: 60_000,
  });
  assert.deepEqual(
    later.kept.map((held) => held.cause),
    ["late"],
    "a late live run keeps the record blocking",
  );
  assert.equal(later.closures.length, 0);
  assert.deepEqual(
    planAdvisorContinuityAbandon(later, partitionOf(record({ updatedAt: NOW - 60 * 60 * 1000 }))),
    [],
    "and a reset never abandons it",
  );
});

test("only a retired task is closed as settled, never the active one", async () => {
  const plan = await planAdvisorContinuity({
    partition: partitionOf(
      record({ taskToken: "task-retired", state: "answered" }),
      record({ slot: 1, taskToken: "task-active", state: "answered" }),
      record({ slot: 2, taskToken: "task-active" }),
    ),
    activeTaskToken: "task-active",
    evidence: evidence({ runs: wholeList() }),
  });
  assert.deepEqual(plan.retiredTasks, ["task-retired"]);
  // The active task's answer is never a closing debt; its unresolved slot is settled by absence.
  assert.deepEqual(
    plan.closures.map((closure) => [closure.slot, closure.proof]),
    [[2, "absent"]],
  );
  assert.equal(plan.kept.length, 0);
});

test("applying a plan twice changes nothing, and holds alone write nothing", async () => {
  const partition = partitionOf(
    record({ operationRunId: "run-1" }),
    record({ slot: 1, taskToken: "task-retired", state: "answered" }),
  );
  const plan = await planAdvisorContinuity({
    partition,
    activeTaskToken: "task-active",
    evidence: evidence({ states: { "run-1": { ok: true, state: "complete" } } }),
  });
  const once = applyAdvisorContinuity(partition, plan, NOW);
  assert.deepEqual(applyAdvisorContinuity(once, plan, NOW), once);
  assert.equal(isAdvisorContinuityPlanEmpty(plan), false);

  const holds = await planAdvisorContinuity({
    partition: partitionOf(record()),
    activeTaskToken: "task-active",
    evidence: evidence({ runs: wholeList(liveRun()) }),
  });
  assert.equal(holds.closures.length, 0);
  assert.ok(isAdvisorContinuityPlanEmpty(holds), "a hold is not a reason to write the journal");
});

test("a reset abandons only the records nothing could prove", async () => {
  const withReceipt = record({ operationRunId: "run-1" });
  const withoutReceipt = record({ slot: 1 });
  const partition = partitionOf(withReceipt, withoutReceipt);
  const plan = await planAdvisorContinuity({
    partition,
    activeTaskToken: "task-active",
    evidence: evidence({
      states: { "run-1": { ok: false, reason: "unavailable" } },
      runs: { ok: false },
    }),
  });
  const abandoned = planAdvisorContinuityAbandon(plan, partition);
  assert.deepEqual(
    abandoned.map((closure) => [closure.slot, closure.reason, closure.proof]),
    [[1, "reset", "abandoned"]],
    "a receipt is never abandoned",
  );
  const applied = applyAdvisorContinuity(partition, { ...plan, closures: abandoned }, NOW);
  assert.equal(applied.threads[0]?.state, "blocked", "the receipt still blocks");
  assert.equal(applied.threads[1]?.state, "closed");
  assert.equal(applied.threads[1]?.reason, "reset");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  AdvisorGate,
  consultationOutcome,
  failureEvidence,
  GATE_CONSULT_FAILURES,
  GATE_HOLD_CHANGES,
  GATE_WARN_CHANGES,
  gateMessage,
  type ConsultationOutcome,
  type GateLauncher,
} from "../src/advisor-gate.ts";

const LAUNCHERS: readonly GateLauncher[] = ["role", "tool"];

/** One call as the caller reports it: the classification, the live availability, the launcher. */
function decide(
  gate: AdvisorGate,
  changes: boolean,
  options: { available?: boolean; launcher?: GateLauncher } = {},
) {
  return gate.decide({
    changes,
    available: options.available ?? true,
    launcher: options.launcher ?? "tool",
  });
}

/** A task already past the warning: `count` changes let through and nothing consulted. */
function openedWith(count: number): AdvisorGate {
  const gate = new AdvisorGate();
  gate.openTask();
  for (let index = 0; index < count; index += 1)
    assert.equal(decide(gate, true).action, "pass", `change ${index + 1} runs`);
  return gate;
}

/**
 * The details the real `consult_advisor` tool writes: one slot per Advisor, with its own status, and
 * `dispatched` on the slots whose host run was issued.
 */
const toolDetails = (...statuses: readonly string[]) => ({
  advisorConsultation: {
    summary: statuses.includes("complete") ? "complete" : "unavailable",
    slots: statuses.map((status, slot) => ({ slot, status, model: "example/advisor" })),
  },
});
/** The same details for a call that reached the host: every slot it planned was dispatched. */
const dispatchedToolDetails = (...statuses: readonly string[]) => ({
  advisorConsultation: {
    summary: statuses.includes("complete") ? "complete" : "unavailable",
    slots: statuses.map((status, slot) => ({
      slot,
      status,
      model: "example/advisor",
      dispatched: true as const,
    })),
  },
});
/**
 * The defect this rule closes: a first turn with no brief is given its slot and stops before the
 * launch, so the result carries a slot list, one `unavailable` slot, and no `dispatched` at all.
 */
const BRIEF_REQUIRED_DETAILS = {
  advisorConsultation: {
    summary: "unavailable",
    slots: [{ slot: 0, status: "unavailable", model: "example/advisor", code: "brief-required" }],
  },
};

/** The details the host's `subagent` tool reports: one result per child process. */
const roleDetails = (...children: ReadonlyArray<Record<string, unknown>>) => ({
  results: children,
});

type OutcomeCase = {
  launcher: GateLauncher;
  isError: boolean;
  details: unknown;
  expected: ConsultationOutcome;
  why: string;
};

/**
 * Every branch of the reader that decides whether a consultation answered. The cases that matter are
 * the ambiguous ones: a slot that dispatched and did not complete (a failure), a slot list that proves
 * no Advisor was launched at all (nothing to count, whether or not it has slots in it), and a result
 * whose shape this reader cannot interpret (nothing to count either, so the hold stands).
 */
const OUTCOME_CASES: readonly OutcomeCase[] = [
  {
    launcher: "tool",
    isError: false,
    details: toolDetails("complete"),
    expected: "answered",
    why: "one completed slot is an answer",
  },
  {
    launcher: "tool",
    isError: false,
    details: dispatchedToolDetails("error"),
    expected: "failed",
    why: "a dispatched slot that never completed is a launch that answered nothing",
  },
  {
    launcher: "tool",
    isError: false,
    details: toolDetails("error"),
    expected: "not-run",
    why: "a slot that never dispatched proves no Advisor started, whatever its status says",
  },
  {
    launcher: "tool",
    isError: false,
    details: BRIEF_REQUIRED_DETAILS,
    expected: "not-run",
    why: "a first turn with no brief is given its slot and stops before the launch",
  },
  {
    launcher: "tool",
    isError: false,
    details: dispatchedToolDetails("error", "unavailable"),
    expected: "failed",
    why: "one dispatched slot that did not complete is enough to know the way out failed",
  },
  {
    launcher: "tool",
    isError: false,
    details: toolDetails("error", "complete"),
    expected: "answered",
    why: "one Advisor that answered is enough",
  },
  {
    launcher: "tool",
    isError: false,
    details: toolDetails(),
    expected: "not-run",
    why: "an empty slot list proves no Advisor started",
  },
  {
    launcher: "tool",
    isError: false,
    details: undefined,
    expected: "not-run",
    why: "the tool writes details only when it launched at least one Advisor",
  },
  {
    launcher: "tool",
    isError: false,
    details: "Consultation complete",
    expected: "not-run",
    why: "details that are not an object say nothing",
  },
  {
    launcher: "tool",
    isError: false,
    details: {},
    expected: "not-run",
    why: "the tool writes no consultation details when it consulted nobody",
  },
  {
    launcher: "tool",
    isError: true,
    details: {},
    expected: "not-run",
    why: "an error without the record proves no Advisor started either",
  },
  {
    launcher: "tool",
    isError: false,
    details: { advisorConsultation: { summary: "complete" } },
    expected: "not-run",
    why: "a consultation record with no slots says nothing",
  },
  {
    launcher: "tool",
    isError: false,
    details: { advisorConsultation: { slots: "complete" } },
    expected: "not-run",
    why: "slots that are not an array say nothing, so the hold keeps its hold",
  },
  {
    launcher: "tool",
    isError: true,
    details: toolDetails("complete"),
    expected: "failed",
    why: "an error never opens the gate, whatever the details say",
  },
  {
    launcher: "tool",
    isError: true,
    details: dispatchedToolDetails("error"),
    expected: "failed",
    why: "an errored result over a dispatched slot is a failure too",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ exitCode: 0, finalOutput: "the Advisor answered" }),
    expected: "answered",
    why: "a child that ended cleanly with output answered",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ exitCode: 1, finalOutput: "the Advisor failed" }),
    expected: "failed",
    why: "a non-zero exit is not an answer",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails(
      { exitCode: 1, finalOutput: "the Advisor failed" },
      { exitCode: 0, finalOutput: "the Advisor answered" },
    ),
    expected: "answered",
    why: "one child that answered covers the one that did not",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ exitCode: 0, finalOutput: "" }),
    expected: "failed",
    why: "a child with no output answered nothing",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ exitCode: 0, finalOutput: "  \n\t " }),
    expected: "failed",
    why: "whitespace is not an answer",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({
      exitCode: 0,
      finalOutput: "the Advisor answered",
      error: "provider refused",
    }),
    expected: "failed",
    why: "a child that also reported an error is not an answer",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ exitCode: 0, finalOutput: "the Advisor answered", timedOut: true }),
    expected: "failed",
    why: "a child cut short by a timeout is not an answer",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ exitCode: 0, finalOutput: "the Advisor answered", stopped: true }),
    expected: "failed",
    why: "a stopped child is not an answer",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ exitCode: 0, finalOutput: "the Advisor answered", interrupted: true }),
    expected: "failed",
    why: "an interrupted child is not an answer",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ exitCode: 0, finalOutput: "the Advisor answered", detached: true }),
    expected: "failed",
    why: "a detached child is not an answer",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ exitCode: 0, finalOutput: "the Advisor answered", outputPartial: true }),
    expected: "failed",
    why: "partial output is not an answer",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({
      exitCode: 0,
      finalOutput: "the Advisor answered",
      stopped: false,
      timedOut: false,
    }),
    expected: "answered",
    why: "a flag that is false cuts nothing short",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails(),
    expected: "not-run",
    why: "a launch with no child at all proves nothing started",
  },
  {
    launcher: "role",
    isError: false,
    details: { results: "the Advisor answered" },
    expected: "not-run",
    why: "results that are not an array say nothing",
  },
  {
    launcher: "role",
    isError: false,
    details: { results: [null] },
    expected: "not-run",
    why: "a child that is not an object says nothing",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ finalOutput: "the Advisor answered" }),
    expected: "failed",
    why: "a child record with no exit code is still a child the host started and did not answer",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ exitCode: "0", finalOutput: "the Advisor answered" }),
    expected: "failed",
    why: "an exit code that is not a number is not a clean answer either",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ signal: "SIGKILL", killed: true }),
    expected: "failed",
    why: "a child the host killed by signal left no exit code, and it is still a failed launch",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ timedOut: true, outputPartial: "half an answer" }),
    expected: "failed",
    why: "a child cut short by a timeout left no exit code, and it is still a failed launch",
  },
  {
    launcher: "role",
    isError: false,
    details: undefined,
    expected: "not-run",
    why: "no details at all proves nothing started",
  },
  {
    launcher: "role",
    isError: true,
    details: undefined,
    expected: "not-run",
    why: "an error without children proves nothing started",
  },
  {
    launcher: "role",
    isError: false,
    details: toolDetails("complete"),
    expected: "not-run",
    why: "the tool's own details are not the host's results",
  },
  {
    launcher: "role",
    isError: true,
    details: roleDetails({ exitCode: 0, finalOutput: "the Advisor answered" }),
    expected: "failed",
    why: "an error never opens the gate, whatever the children say",
  },
];

test("a consultation result is read from its details, one case per branch", () => {
  for (const { launcher, isError, details, expected, why } of OUTCOME_CASES) {
    assert.equal(
      consultationOutcome(launcher, { isError, details }),
      expected,
      `${launcher}, isError ${isError}: ${why}`,
    );
  }
});

/**
 * The rule itself, named: a result that proves no Advisor started is `not-run`, and nothing about it
 * can be read as a consultation that failed, however the call ended.
 */
test("a consultation that never started is not-run, never a failure", () => {
  const neverStarted: ReadonlyArray<["tool" | "role", unknown, string]> = [
    ["tool", { advisorConsultation: { summary: "not-run", slots: [] } }, "empty slots"],
    ["tool", undefined, "no details at all"],
    ["tool", {}, "no consultation record"],
    ["tool", BRIEF_REQUIRED_DETAILS, "a slot the launch never reached"],
    ["tool", toolDetails("unavailable"), "a planned slot with no dispatch behind it"],
    ["role", roleDetails(), "a launch with no child"],
    ["role", { results: [] }, "an empty list of children"],
  ];
  for (const [launcher, details, why] of neverStarted)
    assert.equal(consultationOutcome(launcher, { isError: false, details }), "not-run", why);
  assert.equal(
    consultationOutcome("tool", { isError: true, details: undefined }),
    "not-run",
    "a result flagged as an error with no details proves nothing started either",
  );
  assert.equal(
    consultationOutcome("role", { isError: true, details: undefined }),
    "not-run",
    "nor does one in role launch",
  );
});

/** A result carrying failure text: the reader judges the details, so the text must never matter. */
const withFailureText = (details: unknown, isError = false) => ({
  isError,
  details,
  text: "Advisor error: question must not be blank.",
});

test("failure text in a result is irrelevant to what the reader decides", () => {
  // The reviewed blocker: the host does not flag a consultation that failed inside the call as an
  // error, so a non-empty failure text used to read as an answer.
  assert.equal(
    consultationOutcome("tool", withFailureText(dispatchedToolDetails("error"))),
    "failed",
  );
  assert.equal(consultationOutcome("tool", withFailureText(toolDetails("complete"))), "answered");
  assert.equal(
    consultationOutcome("role", withFailureText(roleDetails({ exitCode: 1, finalOutput: "x" }))),
    "failed",
  );
  assert.equal(
    consultationOutcome(
      "role",
      withFailureText(roleDetails({ exitCode: 0, finalOutput: "the Advisor answered" })),
    ),
    "answered",
  );
  // The error flag wins even when the same result also carries a full answer.
  assert.equal(
    consultationOutcome("tool", withFailureText(toolDetails("complete"), true)),
    "failed",
  );
});

/**
 * The defect this rule closes, named: a first turn with no brief is given its slot and stops before
 * the launch, so its details have a non-empty list of slots and no `dispatched` at all. Two of those
 * cost no tokens and opened the valve for the rest of the task. The slot list is not evidence; the
 * flag the writer sets at the launch is.
 */
test("a slot list with no dispatch is not-run, and two of them leave the hold", () => {
  assert.equal(
    consultationOutcome("tool", { isError: false, details: BRIEF_REQUIRED_DETAILS }),
    "not-run",
  );
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.equal(decide(gate, true).action, "block");
  feedOutcome(gate, "tool", BRIEF_REQUIRED_DETAILS);
  feedOutcome(gate, "tool", BRIEF_REQUIRED_DETAILS);
  assert.equal(gate.held, true, "two calls that started no Advisor release nothing");
  assert.equal(decide(gate, true).action, "block", "the hold is exactly where it was");
});

test("a slot that did dispatch and did not complete is failed, and a pair only changes the refusal", () => {
  const details = dispatchedToolDetails("error");
  assert.equal(consultationOutcome("tool", { isError: false, details }), "failed");
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.deepEqual(decide(gate, true), { action: "block", message: gateMessage("tool") });
  feedOutcome(gate, "tool", details);
  assert.deepEqual(
    decide(gate, true),
    { action: "block", message: gateMessage("tool") },
    "one failure is not a run yet",
  );
  feedOutcome(gate, "tool", details);
  assert.equal(gate.held, true, "the pair releases nothing");
  assert.deepEqual(
    decide(gate, true),
    { action: "block", message: gateMessage("tool", false, true) },
    "the pair changes what the model is told, not what the gate does",
  );
});

test("a result whose shape this reader cannot read counts nothing and keeps the hold", () => {
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.equal(decide(gate, true).action, "block");
  // There is no third verdict for a shape this version does not know: it read no launch, so it is one
  // more call that proved nothing, and it is neither a failure nor a way out.
  for (const details of [{ advisorConsultation: { slots: "complete" } }, {}, undefined])
    assert.equal(consultationOutcome("tool", { isError: false, details }), "not-run");
  feedOutcome(gate, "tool", { advisorConsultation: { slots: "complete" } });
  feedOutcome(gate, "tool", { advisorConsultation: { slots: "complete" } });
  assert.equal(gate.held, true, "an unreadable result is no way out of the hold");
  assert.equal(decide(gate, true).action, "block", "the next change is refused as before");
  assert.deepEqual(
    gate.closeTask(),
    {
      changes: GATE_HOLD_CHANGES - 1,
      totalChanges: GATE_HOLD_CHANGES - 1,
      holds: 2,
      answers: 0,
      failures: 0,
    },
    "nothing an unreadable result says is counted",
  );
});

test("a ?? task holds until it answers and then follows its level", () => {
  // A level that holds by count keeps counting after the answer.
  const counting = new AdvisorGate();
  counting.openTask(true, true);
  assert.equal(
    counting.decide({ changes: true, available: true, launcher: "tool" }).action,
    "block",
  );
  counting.noteAnswer();
  for (let index = 0; index < GATE_HOLD_CHANGES - 1; index += 1)
    assert.equal(
      counting.decide({ changes: true, available: true, launcher: "tool" }).action,
      "pass",
    );
  assert.equal(
    counting.decide({ changes: true, available: true, launcher: "tool" }).action,
    "block",
  );

  // A level that holds nothing by count is free after the answer, and never warns.
  const free = new AdvisorGate();
  free.openTask(true, false);
  assert.equal(free.decide({ changes: true, available: true, launcher: "tool" }).action, "block");
  free.noteAnswer();
  for (let index = 0; index < GATE_HOLD_CHANGES * 2; index += 1)
    assert.equal(free.decide({ changes: true, available: true, launcher: "tool" }).action, "pass");
  assert.equal(free.held, false);
  assert.equal(free.warnDue(), false);
});

test("a read never counts and never blocks, even while the gate holds", () => {
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.equal(gate.held, true, "one more change would be refused");
  for (let index = 0; index < 5; index += 1) {
    const decision = decide(gate, false);
    assert.deepEqual(decision, { action: "pass", reason: "quiet" });
  }
  // The reads changed nothing, so the change that follows is still the held one.
  assert.equal(decide(gate, true).action, "block");
});

test("the sixth change is refused, and so are the seventh and the eighth", () => {
  const gate = new AdvisorGate();
  gate.openTask();
  for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
    assert.equal(decide(gate, true).action, "pass", `change ${index} runs`);
  for (let index = GATE_HOLD_CHANGES; index <= GATE_HOLD_CHANGES + 2; index += 1) {
    const decision = decide(gate, true);
    assert.equal(decision.action, "block", `attempt ${index} is refused`);
    assert.deepEqual(
      decision,
      { action: "block", message: gateMessage("tool") },
      "the refusal is the same text every time, and names no way out that skips the consultation",
    );
  }
});

test("a refused change is not counted and a refused call repeated never unblocks itself", () => {
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.equal(decide(gate, true).action, "block");
  assert.equal(decide(gate, true).action, "block");
  assert.equal(gate.held, true, "repeating the refused call does not move the gate");
  // Three attempts were refused, one change was still waiting below the hold.
  assert.deepEqual(gate.closeTask(), {
    changes: GATE_HOLD_CHANGES - 1,
    totalChanges: GATE_HOLD_CHANGES - 1,
    holds: 2,
    answers: 0,
    failures: 0,
  });
});

test("an answer resets the count, and five more changes run", () => {
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.equal(decide(gate, true).action, "block");
  gate.noteAnswer();
  assert.equal(gate.held, false, "the answered consultation covers the changes made so far");
  for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
    assert.equal(decide(gate, true).action, "pass", `change ${index} after the answer runs`);
  assert.equal(decide(gate, true).action, "block", "the budget is the same after a reset");
});

test("one failure is not a run, and the pair is reported while the task stays held", () => {
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.equal(decide(gate, true).action, "block");
  assert.equal(gate.noteFailure(), false, "one failure is not a run");
  assert.equal(decide(gate, true).action, "block", "a failure never opens the gate");
  assert.equal(gate.noteFailure(), true, "the second consecutive failure is reported");
  assert.equal(
    gate.noteFailure(),
    false,
    "the next failure starts a new pair instead of reporting",
  );
  assert.equal(decide(gate, true).action, "block", "nothing the pair did released a change");
  assert.deepEqual(
    gate.closeTask(),
    {
      changes: GATE_HOLD_CHANGES - 1,
      totalChanges: GATE_HOLD_CHANGES - 1,
      holds: 3,
      answers: 0,
      failures: 3,
    },
    "no released change was counted, because none ran",
  );
});

test("a single failure changes nothing", () => {
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.equal(decide(gate, true).action, "block", "the hold is real before the failure");
  assert.equal(gate.noteFailure(), false, "one failure is not a run");
  assert.equal(gate.held, true, "one failure leaves the hold exactly as it was");
  assert.equal(decide(gate, true).action, "block", "and the next change is refused as before");
  assert.equal(gate.held, true);
});

/**
 * The property that replaced the release valve: a hold whose way out keeps failing is never released,
 * because any release the model can compute it can forge. It ends with an answer or with a person, so
 * a run of failures only changes what the model is told, and every change of the task stays refused.
 */
test("a run of failed consultations keeps the hold and tells the model to stop", () => {
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.deepEqual(
    decide(gate, true),
    { action: "block", message: gateMessage("tool") },
    "the hold is real before the failures",
  );
  for (let index = 1; index < GATE_CONSULT_FAILURES; index += 1) {
    assert.equal(gate.noteFailure(), false, `${index} failure is not a run`);
    assert.deepEqual(
      decide(gate, true),
      { action: "block", message: gateMessage("tool") },
      `${index} failure does not change the refusal`,
    );
  }
  assert.equal(gate.noteFailure(), true, `the run reaches ${GATE_CONSULT_FAILURES}`);
  assert.equal(gate.held, true, "the gate holds while the way out is not working");
  for (let index = 1; index <= GATE_HOLD_CHANGES; index += 1)
    assert.deepEqual(
      decide(gate, true),
      { action: "block", message: gateMessage("tool", false, true) },
      `attempt ${index} after the run asks for a person instead of releasing anything`,
    );
  assert.deepEqual(
    gate.closeTask(),
    {
      changes: GATE_HOLD_CHANGES - 1,
      totalChanges: GATE_HOLD_CHANGES - 1,
      holds: GATE_CONSULT_FAILURES + GATE_HOLD_CHANGES,
      answers: 0,
      failures: GATE_CONSULT_FAILURES,
    },
    "not one of those attempts ran, so not one of them is counted as a change",
  );
});

test("a later pair is reported again and still releases nothing", () => {
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  for (let index = 0; index < GATE_CONSULT_FAILURES; index += 1) gate.noteFailure();
  assert.equal(decide(gate, true).action, "block", "the first pair released nothing");

  // A single proven failure is not a pair, so the task stays held exactly where it was.
  assert.equal(gate.noteFailure(), false, "one failure after a pair is not a run");
  assert.equal(gate.held, true, "and it reports nothing");

  // The next one completes a pair, and the caller is told again: the run starts per pair.
  assert.equal(gate.noteFailure(), true, "the next pair is reported");
  assert.equal(gate.held, true, "and the task is still held");
  assert.deepEqual(
    decide(gate, true),
    { action: "block", message: gateMessage("tool", false, true) },
    "the second report says the same thing as the first",
  );

  // An answer is the way out that ends the whole run: it clears the clause and the count.
  gate.noteAnswer();
  assert.equal(gate.held, false, "an answered consultation covers the changes made so far");
  assert.equal(gate.noteFailure(), false, "and the failure run starts from zero again");
});

test("an answered consultation clears the failure run and the clause", () => {
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.equal(decide(gate, true).action, "block");
  for (let index = 0; index < GATE_CONSULT_FAILURES; index += 1) gate.noteFailure();
  assert.deepEqual(decide(gate, true), {
    action: "block",
    message: gateMessage("tool", false, true),
  });
  gate.noteAnswer();
  // The way out works again, so the level's own hold applies again from a fresh count.
  for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
    assert.equal(decide(gate, true).action, "pass", `change ${index} after the answer runs`);
  assert.deepEqual(
    decide(gate, true),
    { action: "block", message: gateMessage("tool") },
    "an answer restores the ordinary refusal",
  );
  assert.equal(gate.noteFailure(), false, "the answered consultation starts a new run of failures");
  assert.equal(decide(gate, true).action, "block", "and one failure does not change the refusal");
  assert.equal(gate.noteFailure(), true, "a second one reports the way out again");
  // A closed task clears it too: the next task starts with a way out and a fresh run.
  gate.closeTask();
  gate.openTask(true);
  assert.equal(gate.noteFailure(), false, "a new task starts a fresh run of failures");
  assert.deepEqual(
    decide(gate, true),
    { action: "block", message: gateMessage("tool") },
    "and its own refusal is the ordinary one",
  );
});

test("an answer resets the failure run", () => {
  const gate = new AdvisorGate();
  gate.openTask();
  assert.equal(gate.noteFailure(), false);
  assert.equal(gate.noteFailure(), true, `the run reaches ${GATE_CONSULT_FAILURES}`);
  gate.noteAnswer();
  assert.equal(gate.noteFailure(), false, "the answered consultation starts a new run");
  assert.equal(gate.noteFailure(), true, "a second run of failures is reported again");
});

test("nothing is refused when no consultation is available", () => {
  const gate = new AdvisorGate();
  gate.openTask();
  for (let index = 0; index < GATE_HOLD_CHANGES * 3; index += 1)
    assert.deepEqual(decide(gate, true, { available: false }), {
      action: "pass",
      reason: "unavailable",
    });
  assert.equal(gate.held, false, "a hold with no way out is never a hold");
});

test("nothing is decided without an open task", () => {
  const gate = new AdvisorGate();
  assert.deepEqual(decide(gate, true), { action: "pass", reason: "quiet" });
  assert.equal(gate.held, false);
  assert.equal(gate.warnDue(), false);
  assert.equal(gate.noteFailure(), false);
  gate.noteAnswer();
  assert.equal(gate.closeTask(), undefined, "a closed gate reports nothing");
});

test("a new task starts from zero and the close reports what the task did", () => {
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.equal(decide(gate, true).action, "block");
  gate.noteFailure();
  gate.noteAnswer();
  assert.equal(decide(gate, false).action, "pass");
  const report = gate.closeTask();
  assert.deepEqual(report, {
    changes: 0,
    totalChanges: GATE_HOLD_CHANGES - 1,
    holds: 1,
    answers: 1,
    failures: 1,
  });

  gate.openTask();
  assert.equal(gate.held, false, "the previous task's count does not follow the new one");
  for (let index = 1; index < GATE_HOLD_CHANGES; index += 1)
    assert.equal(decide(gate, true).action, "pass", `change ${index} of the new task runs`);
  assert.equal(decide(gate, true).action, "block");
  assert.deepEqual(gate.closeTask(), {
    changes: GATE_HOLD_CHANGES - 1,
    totalChanges: GATE_HOLD_CHANGES - 1,
    holds: 1,
    answers: 0,
    failures: 0,
  });
});

test("the warning is due once at three changes, and again only after an answer, failures included", () => {
  const gate = new AdvisorGate();
  gate.openTask();
  for (let index = 1; index < GATE_WARN_CHANGES; index += 1) {
    decide(gate, true);
    assert.equal(gate.warnDue(), false, `${index} changes are not enough`);
  }
  decide(gate, true);
  assert.equal(gate.warnDue(), true, "the third change earns the warning");
  assert.equal(gate.warnDue(), false, "the warning is presented once");
  decide(gate, true);
  assert.equal(gate.warnDue(), false, "a later change does not repeat it");

  gate.noteAnswer();
  for (let index = 1; index < GATE_WARN_CHANGES; index += 1) {
    decide(gate, true);
    assert.equal(gate.warnDue(), false, `${index} changes after an answer are not enough`);
  }
  decide(gate, true);
  assert.equal(gate.warnDue(), true, "a new run of changes earns a new warning");

  // A consultation that failed is not an answer, so it neither re-arms the warning nor starts the
  // count over: only an answer does both, and the presented warning stays presented.
  assert.equal(gate.noteFailure(), false, "one failure is not a run");
  assert.equal(gate.noteFailure(), true, "the pair is reported");
  decide(gate, true);
  assert.equal(gate.warnDue(), false, "a later change after failures does not repeat the warning");
});

test("the notice repeats only the closed statuses a failed result stated", () => {
  assert.deepEqual(failureEvidence("tool", dispatchedToolDetails("unavailable", "blocked")), [
    "unavailable",
    "blocked",
  ]);
  // A status this version does not know is left out, never echoed: a notice carries no host text.
  assert.deepEqual(
    failureEvidence("tool", {
      advisorConsultation: { slots: [{ status: "the provider refused" }, { status: "blocked" }] },
    }),
    ["blocked"],
  );
  assert.deepEqual(failureEvidence("tool", toolDetails("complete")), ["complete"]);
  // A role launch reports children, not statuses, and a shape without slots says nothing.
  assert.deepEqual(
    failureEvidence("role", roleDetails({ exitCode: 1, finalOutput: "no answer" })),
    [],
  );
  assert.deepEqual(failureEvidence("tool", undefined), []);
  assert.deepEqual(failureEvidence("tool", { advisorConsultation: { slots: "blocked" } }), []);
});

/**
 * What the tool result handler does with the reader's verdict, and what it must never do: a result
 * that proves no Advisor started is not a failure, so the two-call bypass this rule closes cannot be
 * reproduced here either.
 */
function feedOutcome(gate: AdvisorGate, launcher: GateLauncher, details: unknown): void {
  const outcome = consultationOutcome(launcher, { isError: false, details });
  if (outcome === "answered") gate.noteAnswer();
  else if (outcome === "failed") gate.noteFailure();
}

/**
 * The bypass this rule closes: two calls that consulted nobody cost no state change, so counting
 * them as failures would let a model switch the level off with two blank questions, or with two
 * calls made while a third runs, because the host runs one message's calls in parallel. The first
 * entry is the defect this rule exists for: a non-empty slot list from a first turn with no brief,
 * which reached no host run at all.
 */
const CONSULTED_NOBODY: ReadonlyArray<
  Readonly<{ launcher: GateLauncher; details: unknown; why: string }>
> = [
  { launcher: "tool", details: BRIEF_REQUIRED_DETAILS, why: "a slot the launch never reached" },
  {
    launcher: "tool",
    details: toolDetails("unavailable"),
    why: "a planned slot with no dispatch behind it",
  },
  {
    launcher: "tool",
    details: { advisorConsultation: { summary: "not-run", slots: [] } },
    why: "an early exit with no slots",
  },
  { launcher: "tool", details: undefined, why: "no details at all" },
  { launcher: "role", details: roleDetails(), why: "a launch with no child" },
  { launcher: "role", details: { results: [] }, why: "an empty list of children" },
];

for (const { launcher, details, why } of CONSULTED_NOBODY) {
  test(`two ${launcher} results that consulted nobody leave the hold in place: ${why}`, () => {
    const gate = openedWith(GATE_HOLD_CHANGES - 1);
    assert.equal(decide(gate, true, { launcher }).action, "block");
    feedOutcome(gate, launcher, details);
    feedOutcome(gate, launcher, details);
    assert.equal(gate.held, true, "nothing that consulted nobody can report the way out");
    assert.deepEqual(
      decide(gate, true, { launcher }),
      { action: "block", message: gateMessage(launcher) },
      "and the hold still resolves through the human channel, without the clause",
    );
    assert.deepEqual(gate.closeTask(), {
      changes: GATE_HOLD_CHANGES - 1,
      totalChanges: GATE_HOLD_CHANGES - 1,
      holds: 2,
      answers: 0,
      failures: 0,
    });
  });
}

/** The same two calls with positive evidence report the broken way out, and free nothing. */
const FAILED_AFTER_LAUNCH: ReadonlyArray<
  Readonly<{ launcher: GateLauncher; details: unknown; why: string }>
> = [
  {
    launcher: "tool",
    details: dispatchedToolDetails("error"),
    why: "a dispatched slot that did not complete",
  },
  {
    launcher: "role",
    details: roleDetails({ exitCode: 1, finalOutput: "the Advisor failed" }),
    why: "a child that exited non-zero",
  },
  {
    launcher: "role",
    details: roleDetails({ signal: "SIGKILL", killed: true }),
    why: "a child the host killed, which left no exit code",
  },
];

for (const { launcher, details, why } of FAILED_AFTER_LAUNCH) {
  test(`two ${launcher} failures that prove a launch keep the hold: ${why}`, () => {
    const gate = openedWith(GATE_HOLD_CHANGES - 1);
    assert.deepEqual(decide(gate, true, { launcher }), {
      action: "block",
      message: gateMessage(launcher),
    });
    feedOutcome(gate, launcher, details);
    assert.equal(decide(gate, true, { launcher }).action, "block", "one failure is not a run yet");
    feedOutcome(gate, launcher, details);
    assert.deepEqual(
      decide(gate, true, { launcher }),
      { action: "block", message: gateMessage(launcher, false, true) },
      "the pair changes the refusal and passes no change",
    );
  });
}

/**
 * The property that makes the hold survivable: whatever launcher the task uses, an answer is the one
 * step that releases it, and it releases it at once.
 */
test("from a held gate, an answer lets the next change through for every launcher", () => {
  for (const launcher of LAUNCHERS) {
    const gate = openedWith(GATE_HOLD_CHANGES - 1);
    assert.equal(decide(gate, true, { launcher }).action, "block", launcher);
    assert.equal(gate.held, true, launcher);
    gate.noteAnswer();
    assert.deepEqual(
      decide(gate, true, { launcher }),
      { action: "pass", reason: "counted" },
      launcher,
    );
  }
});

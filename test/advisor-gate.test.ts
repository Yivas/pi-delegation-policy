import assert from "node:assert/strict";
import test from "node:test";
import {
  AdvisorGate,
  consultationOutcome,
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

/** The details the real `consult_advisor` tool writes: one slot per Advisor, with its own status. */
const toolDetails = (...statuses: readonly string[]) => ({
  advisorConsultation: {
    summary: statuses.includes("complete") ? "complete" : "unavailable",
    slots: statuses.map((status, slot) => ({ slot, status, model: "example/advisor" })),
  },
});

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
 * the ambiguous ones: a result the host does not flag as an error but that carries no answered slot,
 * and a result whose shape this reader cannot interpret at all.
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
    details: toolDetails("error"),
    expected: "failed",
    why: "a slot that never completed answered nothing",
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
    expected: "failed",
    why: "an empty slot list answered nothing",
  },
  {
    launcher: "tool",
    isError: false,
    details: undefined,
    expected: "unrecognized",
    why: "no details is a shape this reader does not know",
  },
  {
    launcher: "tool",
    isError: false,
    details: "Consultation complete",
    expected: "unrecognized",
    why: "details that are not an object say nothing",
  },
  {
    launcher: "tool",
    isError: false,
    details: {},
    expected: "failed",
    why: "the tool writes no consultation details when it consulted nobody",
  },
  {
    launcher: "tool",
    isError: false,
    details: { advisorConsultation: { summary: "complete" } },
    expected: "unrecognized",
    why: "a consultation with no slots says nothing",
  },
  {
    launcher: "tool",
    isError: false,
    details: { advisorConsultation: { slots: "complete" } },
    expected: "unrecognized",
    why: "slots that are not an array say nothing",
  },
  {
    launcher: "tool",
    isError: true,
    details: toolDetails("complete"),
    expected: "failed",
    why: "an error never opens the gate, whatever the details say",
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
    expected: "failed",
    why: "a launch with no child at all answered nothing",
  },
  {
    launcher: "role",
    isError: false,
    details: { results: "the Advisor answered" },
    expected: "unrecognized",
    why: "results that are not an array say nothing",
  },
  {
    launcher: "role",
    isError: false,
    details: { results: [null] },
    expected: "unrecognized",
    why: "a child that is not an object says nothing",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ finalOutput: "the Advisor answered" }),
    expected: "unrecognized",
    why: "a child with no exit code says nothing",
  },
  {
    launcher: "role",
    isError: false,
    details: roleDetails({ exitCode: "0", finalOutput: "the Advisor answered" }),
    expected: "unrecognized",
    why: "an exit code that is not a number says nothing",
  },
  {
    launcher: "role",
    isError: false,
    details: undefined,
    expected: "unrecognized",
    why: "no details is a shape this reader does not know",
  },
  {
    launcher: "role",
    isError: false,
    details: toolDetails("complete"),
    expected: "unrecognized",
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

/** A result carrying failure text: the reader judges the details, so the text must never matter. */
const withFailureText = (details: unknown, isError = false) => ({
  isError,
  details,
  text: "Advisor error: question must not be blank.",
});

test("failure text in a result is irrelevant to what the reader decides", () => {
  // The reviewed blocker: the host does not flag a consultation that failed inside the call as an
  // error, so a non-empty failure text used to read as an answer.
  assert.equal(consultationOutcome("tool", withFailureText(toolDetails("error"))), "failed");
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

test("an unrecognized result counts as a failure and is reported once per task", () => {
  const gate = new AdvisorGate();
  assert.equal(gate.noteUnrecognized(), false, "a closed task has nothing to report");
  gate.openTask();
  assert.equal(gate.noteUnrecognized(), true, "the first unrecognized result is reported");
  assert.equal(gate.noteUnrecognized(), false, "a second one in the same task is not reported");
  assert.equal(gate.noteUnrecognized(), false, "nor a third");
  assert.deepEqual(
    gate.closeTask(),
    { changes: 0, totalChanges: 0, holds: 0, answers: 0, failures: 3 },
    "each unrecognized result is counted as a failure of the task",
  );
  gate.openTask();
  assert.equal(gate.noteUnrecognized(), true, "a new task reports its own first one");
  assert.equal(gate.held, false, "an unrecognized result never closes the gate by itself");
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

test("a failure never opens the gate, and only the second in a row is reported", () => {
  const gate = openedWith(GATE_HOLD_CHANGES - 1);
  assert.equal(decide(gate, true).action, "block");
  assert.equal(gate.noteFailure(), false, "one failure is not a run");
  assert.equal(decide(gate, true).action, "block", "a failure never opens the gate");
  assert.equal(gate.noteFailure(), true, "the second consecutive failure is reported");
  assert.equal(gate.noteFailure(), false, "a third failure in the same run is not reported again");
  assert.equal(decide(gate, true).action, "block");
  assert.deepEqual(gate.closeTask(), {
    changes: GATE_HOLD_CHANGES - 1,
    totalChanges: GATE_HOLD_CHANGES - 1,
    holds: 3,
    answers: 0,
    failures: 3,
  });
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

test("the warning is due once at three changes, and again only after an answer", () => {
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
});

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

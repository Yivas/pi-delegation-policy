import assert from "node:assert/strict";
import test from "node:test";
import {
  AdvisorGuard,
  GUARD_CLOSE_BLOCKS,
  GUARD_COVERAGE_CHANGES,
  guardInstruction,
} from "../src/advisor-guard.ts";

const available = { available: true, launcher: "role" } as const;

/** A task that changed state `changes` times without a consultation. */
function changed(changes: number, guard = new AdvisorGuard()): AdvisorGuard {
  guard.openTask();
  for (let index = 0; index < changes; index += 1) guard.noteStateChange();
  return guard;
}

test("a task that changes nothing is never interrupted", () => {
  const guard = new AdvisorGuard();
  guard.openTask();
  assert.deepEqual(guard.decide(available), { action: "pass", reason: "clean" });
});

test("a closed guard decides nothing and learns nothing", () => {
  const guard = changed(3);
  guard.closeTask();
  // The settle boundary can arrive after a branch move closed the task: nothing is interrupted then.
  assert.deepEqual(guard.decide(available), { action: "pass", reason: "clean" });
  // A consultation made while no task is open — at another level, or after a branch move — must not
  // leave the next task already covered.
  guard.noteConsult();
  guard.openTask();
  assert.deepEqual(guard.coverage, { consulted: false, changes: 0 });
  assert.equal(guard.decide(available).action, "pass", "a task with no changes is not interrupted");
  guard.noteStateChange();
  assert.equal(guard.decide(available).action, "block");
});

test("no Advisor available means no interruption, and the task is not watched afterwards", () => {
  const guard = changed(4);
  assert.deepEqual(guard.decide({ available: false, launcher: "tool" }), {
    action: "pass",
    reason: "unavailable",
  });
  assert.equal(guard.coverage.changes, 4, "the changes are still counted");
  // The same close passes while the bridge is down and is interrupted when it comes back.
  assert.equal(guard.decide(available).action, "block");
});

test("an interruption is spent on the same close, and new work earns the second one", () => {
  const guard = changed(1);
  assert.equal(guard.decide(available).action, "block");
  assert.deepEqual(guard.decide(available), { action: "pass", reason: "spent" });
  guard.noteStateChange();
  assert.equal(guard.decide(available).action, "block", "new work earns the second interruption");
  guard.noteStateChange();
  assert.deepEqual(guard.decide(available), { action: "pass", reason: "spent" });
  assert.equal(GUARD_CLOSE_BLOCKS, 2);
});

test("a consultation covers the changes made since it, up to the budget", () => {
  const guard = changed(2);
  guard.noteConsult();
  assert.deepEqual(guard.decide(available), { action: "pass", reason: "covered" });
  for (let index = 0; index < GUARD_COVERAGE_CHANGES; index += 1) guard.noteStateChange();
  assert.deepEqual(guard.decide(available), {
    action: "pass",
    reason: "covered",
  });
  // The change after the budget is not covered any more: consulting once early licences five more.
  guard.noteStateChange();
  assert.equal(guard.coverage.consulted, false);
  assert.equal(guard.decide(available).action, "block");
});

test("a task that changed state is interrupted once with its instruction", () => {
  assert.deepEqual(changed(3).decide(available), {
    action: "block",
    block: 1,
    instruction: guardInstruction("role", 1),
  });
});

test("a new task starts uncovered, and a closed task reports what it did", () => {
  const guard = changed(3);
  assert.deepEqual(guard.closeTask(), { changes: 3, consulted: false, blocks: 0 });
  guard.openTask();
  assert.deepEqual(guard.coverage, { consulted: false, changes: 0 });
  assert.equal(guard.closeTask()?.changes, 0);
});

test("the instruction names the launcher, and the last one says it is the last", () => {
  const tool = guardInstruction("tool", 1);
  const role = guardInstruction("role", 1);
  assert.match(tool, /consult_advisor\(\)/);
  assert.doesNotMatch(tool, /Roles section/);
  assert.match(role, /Roles section/);
  assert.doesNotMatch(role, /consult_advisor/);
  // Both say what the first interruption costs and what the second one is.
  for (const text of [tool, role]) {
    assert.match(text, /^Not an error: this task is not finished yet\. Advisor guard\./);
    assert.match(text, /earns one more interruption, and then no more/);
    // The host turns this entry into user-role text and keeps it in the transcript, so it has to say
    // it is not from the user.
    assert.match(text, /comes from the pi-delegation-policy extension, not from the user/);
  }
  assert.match(guardInstruction("role", GUARD_CLOSE_BLOCKS), /last interruption for this task/);
  assert.doesNotMatch(guardInstruction("role", GUARD_CLOSE_BLOCKS), /earns one more interruption/);
});

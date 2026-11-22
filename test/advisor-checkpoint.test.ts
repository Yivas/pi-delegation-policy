import assert from "node:assert/strict";
import test from "node:test";
import {
  AdvisorCheckpoint,
  CHECKPOINT_COOLDOWN_MS,
  CHECKPOINT_MESSAGE,
  classifyToolCall,
  isOutwardCommand,
  type ToolCallFacts,
} from "../src/advisor-checkpoint.ts";

const NOW = 1_000_000;
const active = { mode: "active", available: true, now: NOW } as const;
const shadow = { mode: "shadow", available: true, now: NOW } as const;

function openedTask(options: { promptChars?: number; forced?: boolean } = {}): AdvisorCheckpoint {
  const checkpoint = new AdvisorCheckpoint();
  checkpoint.openTask({ promptChars: options.promptChars ?? 0, forced: options.forced ?? false });
  return checkpoint;
}

/** The next task of a checkpoint that keeps the cooldown its previous task started. */
function nextTask(checkpoint: AdvisorCheckpoint): AdvisorCheckpoint {
  checkpoint.openTask({ promptChars: 0, forced: false });
  checkpoint.beginRequest();
  return checkpoint;
}

function edit(lines: number): ToolCallFacts {
  return { kind: "edit", path: "src/a.ts", editLines: lines };
}

const otherCall: ToolCallFacts = { kind: "other" };

test("classification maps every tool name and counts the lines an edit would write", () => {
  assert.deepEqual(classifyToolCall("read", { path: "src/a.ts" }), {
    kind: "read",
    path: "src/a.ts",
  });
  assert.deepEqual(classifyToolCall("READ", { file_path: "b.ts" }), { kind: "read", path: "b.ts" });
  assert.deepEqual(classifyToolCall("read", null), { kind: "read" });
  assert.deepEqual(classifyToolCall("read", "not an object"), { kind: "read" });
  for (const name of ["grep", "find", "ls", "glob"]) {
    assert.deepEqual(classifyToolCall(name, { path: "x" }), { kind: "search" });
  }

  assert.deepEqual(classifyToolCall("write", { path: "w.ts", content: "a\nb\nc" }), {
    kind: "edit",
    path: "w.ts",
    editLines: 3,
  });
  assert.deepEqual(classifyToolCall("write", { path: "w.ts", content: "" }), {
    kind: "edit",
    path: "w.ts",
    editLines: 0,
  });
  assert.deepEqual(
    classifyToolCall("edit", {
      path: "e.ts",
      edits: [{ oldText: "a", newText: "b\nc" }, { newText: "d" }],
    }),
    { kind: "edit", path: "e.ts", editLines: 3 },
  );
  assert.deepEqual(classifyToolCall("edit", { newText: "x" }), { kind: "edit", editLines: 1 });
  assert.deepEqual(classifyToolCall("multi_edit", { new_string: "p\nq" }), {
    kind: "edit",
    editLines: 2,
  });
  // An edit whose new text is missing or not a string writes no line this can count.
  assert.deepEqual(classifyToolCall("edit", { path: "e.ts", edits: [{ oldText: "a" }] }), {
    kind: "edit",
    path: "e.ts",
    editLines: 0,
  });

  assert.deepEqual(classifyToolCall("bash", { command: "git push" }), {
    kind: "command",
    command: "git push",
    outward: true,
  });
  assert.deepEqual(classifyToolCall("bash", { command: "git commit -m x" }), {
    kind: "command",
    command: "git commit -m x",
    outward: false,
  });
  assert.deepEqual(classifyToolCall("shell", { command: "npm publish" }), {
    kind: "command",
    command: "npm publish",
    outward: true,
  });
  assert.deepEqual(classifyToolCall("exec", 7), { kind: "command", outward: false });
  assert.deepEqual(classifyToolCall("consult_advisor", {}), { kind: "consult" });
  assert.deepEqual(classifyToolCall("todowrite", {}), { kind: "other" });
});

test("publishing or pushing is an outward command, whatever precedes it", () => {
  for (const line of [
    "git push",
    "git push origin main",
    "npm publish",
    "pnpm publish --tag next",
    "yarn publish",
    "yarn npm publish",
    "gh release create v1",
    "gh pr merge 12",
    "cargo publish",
    "twine upload dist/*",
    "gem push pkg.gem",
    "docker push repo/img",
    "vercel deploy",
    "vercel --prod",
    "netlify deploy --prod",
    "firebase deploy",
    "wrangler deploy",
    "wrangler publish",
    "terraform apply",
    "kubectl apply -f x.yaml",
    "cd package && git push",
    "sudo git push",
    "VERSION=1.2.3 git push",
  ]) {
    assert.equal(isOutwardCommand(line), true, line);
  }
});

test("a local commit, a tag, an install, a dry run and quoted words stay inside the machine", () => {
  for (const line of [
    "git commit -m 'wip'",
    "git tag v1.0.0",
    "npm install",
    "rm -rf dist",
    "git status",
    "git push --dry-run",
    "npm publish --dry-run",
    'echo "git push"',
    'echo "a && git push"',
    "git commit -m x && git tag v1",
    "",
  ]) {
    assert.equal(isOutwardCommand(line), false, line);
  }
});

test("the refusal message is four lines, ends without a newline and names both ways out", () => {
  const lines = CHECKPOINT_MESSAGE.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(
    lines[0],
    "Not an error: this call was not run. Advisor checkpoint, once for this task.",
  );
  assert.match(lines[1], /no Advisor has been consulted\.$/);
  assert.match(lines[2], /consult_advisor\(\) now/);
  assert.match(lines[3], /repeat this call and it will run/);
});

test("a task that looks trivial never fires", () => {
  const checkpoint = openedTask({ promptChars: 40 });
  checkpoint.beginRequest();
  for (const facts of [
    { kind: "read", path: "src/a.ts" },
    { kind: "read", path: "src/b.ts" },
    otherCall,
    otherCall,
  ] satisfies ToolCallFacts[]) {
    assert.deepEqual(checkpoint.onToolCall(facts, active), { action: "pass" });
  }
  assert.deepEqual(checkpoint.onToolCall(edit(1), active), { action: "pass" });
  assert.equal(checkpoint.closeTask(), undefined);
});

test("five earlier calls are a task under work and four are not", () => {
  const four = openedTask();
  four.beginRequest();
  for (let index = 0; index < 4; index += 1) four.onToolCall(otherCall, active);
  assert.deepEqual(four.onToolCall(edit(1), active), { action: "pass" });

  const five = openedTask();
  five.beginRequest();
  for (let index = 0; index < 5; index += 1) five.onToolCall(otherCall, active);
  assert.deepEqual(five.onToolCall(edit(1), active), {
    action: "block",
    signals: ["prior-calls"],
    message: CHECKPOINT_MESSAGE,
  });
});

test("three distinct files opened are enough and two are not", () => {
  const two = openedTask();
  two.beginRequest();
  two.onToolCall({ kind: "read", path: "src/a.ts" }, active);
  // The same file opened twice is still one file.
  two.onToolCall({ kind: "read", path: "src/a.ts" }, active);
  assert.deepEqual(two.onToolCall(edit(1), active), { action: "pass" });

  const three = openedTask();
  three.beginRequest();
  three.onToolCall({ kind: "read", path: "src/a.ts" }, active);
  three.onToolCall({ kind: "read", path: "src/b.ts" }, active);
  three.onToolCall({ kind: "search" }, active);
  assert.deepEqual(three.onToolCall(edit(1), active), {
    action: "block",
    signals: ["files-read"],
    message: CHECKPOINT_MESSAGE,
  });
});

test("a 400-character prompt is long work and 399 is not", () => {
  const short = openedTask({ promptChars: 399 });
  short.beginRequest();
  assert.deepEqual(short.onToolCall(edit(1), active), { action: "pass" });

  const long = openedTask({ promptChars: 400 });
  long.beginRequest();
  assert.deepEqual(long.onToolCall(edit(1), active), {
    action: "block",
    signals: ["long-prompt"],
    message: CHECKPOINT_MESSAGE,
  });
});

test("40 lines of new text is a small edit and 41 is not", () => {
  const small = openedTask();
  small.beginRequest();
  assert.deepEqual(small.onToolCall(edit(40), active), { action: "pass" });

  const large = openedTask();
  large.beginRequest();
  assert.deepEqual(large.onToolCall(edit(41), active), {
    action: "block",
    signals: ["large-edit"],
    message: CHECKPOINT_MESSAGE,
  });
});

test("a real push is an outward step and a push dry run is not", () => {
  const dryRun = openedTask();
  dryRun.beginRequest();
  assert.deepEqual(
    dryRun.onToolCall(classifyToolCall("bash", { command: "npm publish --dry-run" }), active),
    {
      action: "pass",
    },
  );
  assert.equal(dryRun.closeTask(), undefined);

  const checkpoint = openedTask();
  checkpoint.beginRequest();
  assert.deepEqual(
    checkpoint.onToolCall(classifyToolCall("bash", { command: "git push" }), active),
    {
      action: "block",
      signals: ["outward-step"],
      message: CHECKPOINT_MESSAGE,
    },
  );
});

test("active mode refuses the first batch once and lets the next request through", () => {
  const checkpoint = openedTask();
  checkpoint.beginRequest();
  const refusal = {
    action: "block",
    signals: ["large-edit"],
    message: CHECKPOINT_MESSAGE,
  } as const;
  assert.deepEqual(checkpoint.onToolCall(edit(41), active), refusal);
  // Several calls of one assistant message are one turn: refusing one of them and running the
  // rest would leave the work half-applied, so the whole batch is refused.
  assert.deepEqual(checkpoint.onToolCall(edit(2), active), refusal);
  assert.deepEqual(
    checkpoint.onToolCall(classifyToolCall("bash", { command: "git push" }), active),
    refusal,
  );
  assert.deepEqual(checkpoint.onToolCall({ kind: "read", path: "src/a.ts" }, active), {
    action: "pass",
  });

  checkpoint.beginRequest();
  assert.deepEqual(checkpoint.onToolCall(edit(3), active), { action: "pass" });
  assert.deepEqual(checkpoint.closeTask(), {
    mode: "active",
    signals: ["large-edit"],
    resolution: "repeat",
    priorCalls: 0,
    filesRead: 0,
    promptChars: 0,
    editLines: 41,
  });
});

test("a consultation before the first change leaves nothing to ask", () => {
  const checkpoint = openedTask();
  checkpoint.beginRequest();
  assert.deepEqual(checkpoint.onToolCall({ kind: "consult" }, active), { action: "pass" });
  assert.deepEqual(checkpoint.onToolCall(edit(41), active), { action: "pass" });
  assert.equal(checkpoint.closeTask(), undefined);
});

test("a consultation after the refusal resolves it and the next change runs", () => {
  const checkpoint = openedTask();
  checkpoint.beginRequest();
  assert.deepEqual(checkpoint.onToolCall(edit(41), active), {
    action: "block",
    signals: ["large-edit"],
    message: CHECKPOINT_MESSAGE,
  });

  checkpoint.beginRequest();
  assert.deepEqual(checkpoint.onToolCall({ kind: "consult" }, active), { action: "pass" });
  assert.deepEqual(checkpoint.onToolCall(edit(5), active), { action: "pass" });
  assert.deepEqual(checkpoint.closeTask(), {
    mode: "active",
    signals: ["large-edit"],
    resolution: "consult",
    priorCalls: 0,
    filesRead: 0,
    promptChars: 0,
    editLines: 41,
  });
});

test("shadow mode records the decision once and never refuses", () => {
  const checkpoint = openedTask();
  checkpoint.beginRequest();
  assert.deepEqual(checkpoint.onToolCall(edit(41), shadow), {
    action: "shadow",
    signals: ["large-edit"],
  });
  assert.deepEqual(checkpoint.onToolCall(edit(41), shadow), { action: "pass" });
  assert.deepEqual(checkpoint.closeTask(), {
    mode: "shadow",
    signals: ["large-edit"],
    resolution: "repeat",
    priorCalls: 0,
    filesRead: 0,
    promptChars: 0,
    editLines: 41,
  });
});

test("nothing fires without an Advisor to consult or with the checkpoint off", () => {
  for (const context of [
    { mode: "active", available: false, now: NOW },
    { mode: "shadow", available: false, now: NOW },
    { mode: "off", available: true, now: NOW },
  ] as const) {
    const checkpoint = openedTask();
    checkpoint.beginRequest();
    assert.deepEqual(checkpoint.onToolCall(edit(100), context), { action: "pass" }, context.mode);
    assert.equal(checkpoint.closeTask(), undefined);
  }
});

test("only the first state-changing call is evaluated", () => {
  const checkpoint = openedTask();
  checkpoint.beginRequest();
  assert.deepEqual(checkpoint.onToolCall(edit(2), active), { action: "pass" });
  assert.deepEqual(checkpoint.onToolCall(edit(500), active), { action: "pass" });
  assert.equal(checkpoint.closeTask(), undefined);
});

test("a second task within the cooldown is left alone and one after it is not", () => {
  // The cooldown is the only value that outlives a task, so all three tasks share an instance.
  const checkpoint = nextTask(new AdvisorCheckpoint());
  assert.equal(checkpoint.onToolCall(edit(41), active).action, "block");
  checkpoint.closeTask();

  nextTask(checkpoint);
  assert.deepEqual(
    checkpoint.onToolCall(edit(41), {
      mode: "active",
      available: true,
      now: NOW + CHECKPOINT_COOLDOWN_MS - 1,
    }),
    { action: "pass" },
  );
  assert.equal(checkpoint.closeTask(), undefined);

  nextTask(checkpoint);
  assert.equal(
    checkpoint.onToolCall(edit(41), {
      mode: "active",
      available: true,
      now: NOW + CHECKPOINT_COOLDOWN_MS,
    }).action,
    "block",
  );
});

test("a consultation restarts the cooldown", () => {
  const consultedAt = NOW + 10 * 60 * 1000;
  const checkpoint = nextTask(new AdvisorCheckpoint());
  assert.equal(checkpoint.onToolCall(edit(41), active).action, "block");
  checkpoint.closeTask();

  nextTask(checkpoint);
  assert.deepEqual(
    checkpoint.onToolCall(
      { kind: "consult" },
      { mode: "active", available: true, now: consultedAt },
    ),
    { action: "pass" },
  );
  checkpoint.closeTask();

  nextTask(checkpoint);
  assert.deepEqual(
    checkpoint.onToolCall(edit(41), {
      mode: "active",
      available: true,
      now: consultedAt + 29 * 60 * 1000,
    }),
    { action: "pass" },
  );
  assert.equal(checkpoint.closeTask(), undefined);

  nextTask(checkpoint);
  assert.equal(
    checkpoint.onToolCall(edit(41), {
      mode: "active",
      available: true,
      now: consultedAt + 30 * 60 * 1000,
    }).action,
    "block",
  );
});

test("a task the user forced is refused while nothing else suggests work", () => {
  const off = openedTask({ forced: true });
  off.beginRequest();
  assert.deepEqual(off.onToolCall(edit(1), { mode: "off", available: true, now: NOW }), {
    action: "block",
    signals: ["user-forced"],
    message: CHECKPOINT_MESSAGE,
  });

  const recorded = openedTask({ forced: true });
  recorded.beginRequest();
  assert.deepEqual(recorded.onToolCall(edit(1), shadow), {
    action: "block",
    signals: ["user-forced"],
    message: CHECKPOINT_MESSAGE,
  });

  const unavailable = openedTask({ forced: true });
  unavailable.beginRequest();
  assert.deepEqual(
    unavailable.onToolCall(edit(1), { mode: "active", available: false, now: NOW }),
    {
      action: "pass",
    },
  );
  assert.equal(unavailable.closeTask(), undefined);

  // A forced task ignores the cooldown that the refusal above started, on the same instance.
  const forced = new AdvisorCheckpoint();
  forced.openTask({ promptChars: 0, forced: false });
  forced.beginRequest();
  assert.equal(forced.onToolCall(edit(41), active).action, "block");
  forced.closeTask();
  forced.openTask({ promptChars: 0, forced: true });
  forced.beginRequest();
  assert.deepEqual(
    forced.onToolCall(edit(1), { mode: "active", available: true, now: NOW + 1000 }),
    {
      action: "block",
      signals: ["user-forced"],
      message: CHECKPOINT_MESSAGE,
    },
  );
});

test("cover() silences the rest of the task", () => {
  const checkpoint = openedTask();
  checkpoint.beginRequest();
  checkpoint.cover();
  assert.deepEqual(checkpoint.onToolCall(edit(41), active), { action: "pass" });
  assert.equal(checkpoint.closeTask(), undefined);
});

test("closeTask reports the counters of the call it refused and only then clears the task", () => {
  const checkpoint = openedTask({ promptChars: 450 });
  checkpoint.beginRequest();
  const early: ToolCallFacts[] = [
    { kind: "read", path: "src/a.ts" },
    { kind: "read", path: "src/a.ts" },
    { kind: "read", path: "src/b.ts" },
    { kind: "search" },
    otherCall,
  ];
  for (const facts of early) {
    assert.deepEqual(checkpoint.onToolCall(facts, active), { action: "pass" });
  }
  assert.deepEqual(checkpoint.onToolCall(edit(50), active), {
    action: "block",
    signals: ["prior-calls", "files-read", "long-prompt", "large-edit"],
    message: CHECKPOINT_MESSAGE,
  });
  assert.deepEqual(checkpoint.closeTask(), {
    mode: "active",
    signals: ["prior-calls", "files-read", "long-prompt", "large-edit"],
    resolution: "none",
    priorCalls: 5,
    filesRead: 3,
    promptChars: 450,
    editLines: 50,
  });
  assert.equal(checkpoint.closeTask(), undefined);
});

test("nothing is refused while no task is open", () => {
  const checkpoint = new AdvisorCheckpoint();
  assert.deepEqual(checkpoint.onToolCall(edit(500), active), { action: "pass" });
  assert.deepEqual(checkpoint.onToolCall({ kind: "consult" }, active), { action: "pass" });
  assert.equal(checkpoint.closeTask(), undefined);
});

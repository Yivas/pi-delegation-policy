import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyToolCall,
  CONTROL_TOOLS,
  isStateChangeCommand,
  type ToolCallFacts,
} from "../src/state-change.ts";

/**
 * The question these cases answer is closed: a level that holds changes refuses everything it cannot
 * prove is a read, so a line missing from these tables is a change by default.
 */
/**
 * Shell lines that only report. A reader that classified one of these as a change would refuse
 * ordinary inspection of the workspace, which is exactly what the holding levels promise not to do.
 */
const READ_LINES: readonly string[] = [
  "ls -la",
  "cat a.txt",
  "rg foo src",
  "git status",
  "git diff --stat",
  "git log --oneline -5",
  "git show HEAD",
  "git branch -a",
  "cd src && ls",
  "git log -n 5 | head",
  'grep "a > b" file.txt',
  'echo "written > here"',
  'find . -name "*.ts"',
  "wc -l a.txt",
];

/**
 * Shell lines that write, hand the line to another program, or reach into it. Each one changes
 * state even when the change is small or reversible, and none of them may be classified as a read.
 */
const CHANGING_LINES: readonly string[] = [
  "echo x > f",
  "echo x >> f",
  "cat a | tee b",
  "rm a",
  "mv a b",
  "npm test",
  "npm run build",
  "node script.js",
  "python x.py",
  "sed -i s/a/b/ f",
  "awk '{print}' f",
  "sudo ls",
  "xargs rm",
  "git push",
  "git commit -m x",
  "git checkout main",
  "git branch -D old",
  "git tag v1",
  "find . -delete",
  "find . -exec rm {} ;",
  "ls $(cat f)",
  "ls && rm a",
  "npm publish",
  "curl https://example.com",
  // A program this module has never heard of is a change, not a guess: a new tool must not need an
  // edit here to be held.
  "gh pr create --fill",
  "ffmpeg -i in.mp4 out.mp4",
];

test("a shell line that only reports is a read", () => {
  for (const line of READ_LINES) {
    assert.equal(isStateChangeCommand(line), false, `expected a read: ${line}`);
    const facts = classifyToolCall("bash", { command: line });
    assert.equal(facts.changes, false, `expected no change for a command: ${line}`);
    assert.equal(facts.command, line, "the raw line is kept for the caller");
  }
});

/**
 * A new line starts a new command, so a read followed by a write is a change. Each line is
 * classified on its own: the leading word of the first line says nothing about the second.
 */
const MULTI_LINE_CASES: ReadonlyArray<{ line: string; changes: boolean; why: string }> = [
  { line: "cat README.md\nrm -rf src", changes: true, why: "the second line deletes" },
  { line: "echo hi\ngit commit -am x", changes: true, why: "the second line commits" },
  { line: "ls\r\nnode -e 'x'", changes: true, why: "a carriage return ends a line too" },
  { line: "ls\ncat a.txt\ngit status", changes: false, why: "every line only reports" },
];

test("every line of a multi-line command is classified on its own", () => {
  for (const { line, changes, why } of MULTI_LINE_CASES) {
    assert.equal(isStateChangeCommand(line), changes, `${why}: ${JSON.stringify(line)}`);
    assert.equal(
      classifyToolCall("bash", { command: line }).changes,
      changes,
      `classified as a command too, ${why}: ${JSON.stringify(line)}`,
    );
  }
});

/**
 * A flag that names an output file writes it, so the same program that only reports becomes a
 * writer. Both spellings of `--output` and both spellings of `sort -o` are covered, because a
 * reader that knew only one of them would let the other write under a report.
 */
const OUTPUT_CASES: ReadonlyArray<{ line: string; changes: boolean; why: string }> = [
  { line: "git diff --output=/tmp/x HEAD", changes: true, why: "git diff writes the named file" },
  { line: "git log --output=/tmp/x", changes: true, why: "git log writes the named file" },
  { line: "sort --output=out.txt in.txt", changes: true, why: "sort writes the named file" },
  { line: "sort -oout.txt in.txt", changes: true, why: "the joined short option writes too" },
  { line: "sort -o out.txt in.txt", changes: true, why: "the separate short option writes too" },
  { line: "sort in.txt", changes: false, why: "sorting to stdout only reports" },
];

test("a flag that names an output file makes the whole call a change", () => {
  for (const { line, changes, why } of OUTPUT_CASES) {
    assert.equal(isStateChangeCommand(line), changes, `${why}: ${line}`);
    assert.equal(classifyToolCall("bash", { command: line }).changes, changes, line);
  }
});

test("an option that runs a program makes a search or a sort a change", () => {
  for (const line of [
    "rg --pre sh x",
    "rg --pre=sh x",
    "sort --compress-program=sh f",
    "find . --exec rm",
    "git log --pager=less",
    // Programs whose ordinary options run a command are not reads at all.
    "fd -x rm {}",
    "fd --exec npm run build",
    "ag --pager less x",
    "ack --pager less x",
    "hostname newname",
    "date 112010002026",
    "date -s tomorrow",
  ])
    assert.equal(isStateChangeCommand(line), true, line);
  for (const line of ["rg foo src", "date", "date +%s", "date -u"])
    assert.equal(isStateChangeCommand(line), false, line);
});

test("a documented option of a known read that writes or runs a program is a change", () => {
  for (const line of [
    "file -C -m mymagic",
    "file --compile -m mymagic",
    "git grep -Oecho_ PWN x",
    // A group of short options runs each of them, so -O counts wherever it appears.
    "git grep -nOtouch hello",
    "git grep -rnOtouch hello",
    "git grep --open-files-in-pager=sh x",
    "git show --ext-diff HEAD",
    "git diff --textconv a b",
    "git cat-file --filters HEAD:f",
    "git --exec-path=/tmp status",
    "rg --hostname-bin=sh x",
    "rg -z x",
    "rg --search-zip x",
    // A group of short options runs each of them.
    "sort -uo out.txt in.txt",
    "file -Cm magic",
    "rg -lz x",
    "tree -oX f",
    "rg --pre-glob=*.js x",
    "diff --paginate a b",
    "sort -T /tmp f",
    "sort --temporary-directory=/tmp f",
    // A git global option this reader does not know can point at another program.
    "git -c core.pager=sh log",
  ])
    assert.equal(isStateChangeCommand(line), true, line);
  for (const line of ["file a.txt", "git grep foo", "rg foo x", "diff a b", "sort f"])
    assert.equal(isStateChangeCommand(line), false, line);
});

test("discarding output or merging streams does not turn a read into a change", () => {
  for (const line of [
    "ls 2>/dev/null",
    "git status 2>&1",
    "rg foo src 2> /dev/null",
    "git log -n 3 >/dev/null 2>&1",
    "ls 2>&1 | head",
  ])
    assert.equal(isStateChangeCommand(line), false, line);
  // A real target is still a write, and the harmless forms hide nothing next to it.
  for (const line of [
    "ls 2>&1 > out.txt",
    "ls > /dev/nullx",
    "ls 2> errors.log",
    "rm a 2>/dev/null",
    "echo x >/dev/null; rm a",
    "ls >/dev/null$HOME/x",
    "ls >NUL$HOME/x",
  ])
    assert.equal(isStateChangeCommand(line), true, line);
});

test("a shell call with no readable command is a change, not a guess", () => {
  // A shell call whose input this module cannot read is held: it is not provably a read.
  for (const input of [undefined, null, {}, { command: 42 }, { command: null }, { cmd: "ls" }]) {
    const facts = classifyToolCall("bash", input);
    assert.equal(facts.kind, "command", JSON.stringify(input));
    assert.equal(facts.changes, true, JSON.stringify(input));
    assert.equal(facts.command, undefined, "no line is reported as the command");
  }
  // The same answer through every shell tool name the host may use.
  for (const tool of ["bash", "powershell", "shell", "exec"])
    assert.equal(classifyToolCall(tool, {}).changes, true, tool);
});

/**
 * The host's `subagent` tool reports its own state with three actions and launches or manages a child
 * with the rest. A control action names a target instead of launching, so it changes nothing; a
 * `resume` or a `stop` sets a child to work or ends one, so it is a change like a launch.
 */
const SUBAGENT_CASES: ReadonlyArray<{ action?: unknown; changes: boolean; why: string }> = [
  { action: "status", changes: false, why: "status only reports" },
  { action: "list", changes: false, why: "list only reports" },
  { action: "guide", changes: false, why: "guide only reports" },
  { action: "resume", changes: true, why: "resume sets a child to work" },
  { action: "stop", changes: true, why: "stop ends a child" },
  { action: undefined, changes: true, why: "a call with no action launches" },
  { action: "something-else", changes: true, why: "an action this version does not name is held" },
];

test("only the reporting actions of the subagent tool change nothing", () => {
  for (const { action, changes, why } of SUBAGENT_CASES) {
    const facts = classifyToolCall("subagent", action === undefined ? {} : { action });
    assert.equal(facts.kind, "other", why);
    assert.equal(facts.changes, changes, `${why}: ${JSON.stringify(action)}`);
  }
});

test("a shell line that writes, runs another program or hides its own text is a change", () => {
  for (const line of CHANGING_LINES) {
    assert.equal(isStateChangeCommand(line), true, `expected a change: ${line}`);
    const facts = classifyToolCall("bash", { command: line });
    assert.equal(facts.kind, "command", line);
    assert.equal(facts.changes, true, `expected a change from a command: ${line}`);
  }
});

/** A command line reaches the same answer through every tool name the host may use for a shell. */
test("every shell tool name classifies its command line the same way", () => {
  for (const tool of ["bash", "powershell", "shell", "exec"]) {
    assert.equal(classifyToolCall(tool, { command: "rm a" }).changes, true, tool);
    assert.equal(classifyToolCall(tool, { command: "git status" }).changes, false, tool);
  }
});

type ToolCase = {
  tool: string;
  input?: unknown;
  kind: ToolCallFacts["kind"];
  changes: boolean;
  why: string;
};

/**
 * The tool name decides before the input does. `edit`, `write` and `multi_edit` write; the search
 * tools report; the extension's own consultation tool is never a change, because a gate that could
 * refuse it would hold a task with no way out; and a name nobody registered is a change.
 */
const TOOL_CASES: readonly ToolCase[] = [
  {
    tool: "edit",
    input: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
    kind: "edit",
    changes: true,
    why: "an edit writes",
  },
  {
    tool: "write",
    input: { path: "src/a.ts", content: "one\ntwo" },
    kind: "edit",
    changes: true,
    why: "a write writes",
  },
  {
    tool: "multi_edit",
    input: { edits: [{ newText: "one" }, { newText: "two" }] },
    kind: "edit",
    changes: true,
    why: "a multi-edit writes",
  },
  {
    tool: "read",
    input: { path: "src/a.ts" },
    kind: "read",
    changes: false,
    why: "a read reports",
  },
  { tool: "grep", input: { pattern: "x" }, kind: "search", changes: false, why: "grep reports" },
  { tool: "find", input: { pattern: "*.ts" }, kind: "search", changes: false, why: "find reports" },
  { tool: "ls", input: { path: "src" }, kind: "search", changes: false, why: "ls reports" },
  {
    tool: "glob",
    input: { pattern: "**/*.ts" },
    kind: "search",
    changes: false,
    why: "glob reports",
  },
  {
    tool: "consult_advisor",
    input: { question: "Which option?" },
    kind: "consult",
    changes: false,
    why: "a consultation is the way out of a hold, so it is never held",
  },
  {
    tool: "some_custom_tool",
    input: { anything: true },
    kind: "other",
    changes: true,
    why: "an unknown tool is a change",
  },
  {
    tool: "subagent",
    input: { tasks: [{ agent: "small", task: "Read this." }] },
    kind: "other",
    changes: true,
    why: "a launch is an unknown tool to this module, so it is a change",
  },
];

test("a tool name decides whether the call changes state", () => {
  for (const { tool, input, kind, changes, why } of TOOL_CASES) {
    const facts = classifyToolCall(tool, input);
    assert.equal(facts.kind, kind, `${tool}: ${why}`);
    assert.equal(facts.changes, changes, `${tool}: ${why}`);
  }
});

/**
 * The human channel and session control are never changes. A held task that could not ask the user a
 * question, read its own plan or wait for a child would have no way to reach the person who can
 * decide, so every tool the module names as control is a read whatever input it carries.
 */
test("a control tool that asks, tracks, waits or reaches the supervisor is not a change", () => {
  for (const tool of CONTROL_TOOLS) {
    for (const input of [undefined, {}, { question: "Which option?" }, { action: "status" }]) {
      const facts = classifyToolCall(tool, input);
      assert.equal(facts.kind, "other", tool);
      assert.equal(facts.changes, false, `${tool}: ${JSON.stringify(input)}`);
    }
  }
});

test("an unknown tool and an MCP-style tool name are still changes", () => {
  // The closed default is untouched: only a read this file names is known to change nothing.
  for (const tool of ["some_custom_tool", "mcp__github__create_issue", "github.create_issue"])
    assert.equal(classifyToolCall(tool, {}).changes, true, tool);
});

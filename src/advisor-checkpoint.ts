/**
 * One refusal, at most once per task, of the first change in work that looks non-trivial while no
 * Advisor has been consulted.
 *
 * The agent is asked to consult before its first substantive step, and smaller models skip it. The
 * host can refuse a tool call once, so this module decides per call whether to let it run, to only
 * record that it would have been refused, or to refuse it once with a fixed message. It refuses
 * nothing when the task looks trivial, when no consultation is possible, or when one happened
 * recently, and it never refuses twice for the same task, so it cannot loop.
 *
 * It is a pure state machine with no imports: time is always passed in, so the behaviour is the
 * same in the host, in tests and on a machine whose clock is wrong.
 */
export const CHECKPOINT_COOLDOWN_MS = 30 * 60 * 1000;
/** A task with this many earlier calls is being worked, not just read. */
export const CHECKPOINT_PRIOR_CALLS = 5;
export const CHECKPOINT_FILES_READ = 3;
export const CHECKPOINT_PROMPT_CHARS = 400;
/** New lines of one edit; exactly this many is still a small edit, so the comparison is strict. */
export const CHECKPOINT_EDIT_LINES = 40;

/**
 * The refusal text. It states that the call did not run, so the model does not report a success it
 * never had, it names the two ways out, and it says not to consult just to comply.
 */
export const CHECKPOINT_MESSAGE = [
  "Not an error: this call was not run. Advisor checkpoint, once for this task.",
  "This is the first change in work that looks non-trivial and no Advisor has been consulted.",
  "1. If there is a decision here you could get wrong (approach, root cause, scope, an irreversible step): call consult_advisor() now. It needs no arguments; the host supplies the context.",
  "2. If this step is mechanical, or the user already decided it: repeat this call and it will run. Do not consult just to comply.",
].join("\n");

export type CheckpointMode = "off" | "shadow" | "active";

export type CheckpointSignal =
  "prior-calls" | "files-read" | "long-prompt" | "large-edit" | "outward-step" | "user-forced";

export type ToolCallFacts = {
  kind: "read" | "search" | "edit" | "command" | "consult" | "other";
  /** Present for a read or an edit when the input names a file. */
  path?: string;
  /** New lines an edit would write, summed over its several edits. */
  editLines?: number;
  /** True when a command publishes or pushes work outside this machine. */
  outward?: boolean;
  /** The raw command line, kept for the caller; nothing here interprets it again. */
  command?: string;
};

export type CheckpointDecision =
  | { action: "pass" }
  | { action: "shadow"; signals: CheckpointSignal[] }
  | { action: "block"; signals: CheckpointSignal[]; message: string };

export type CheckpointReport = {
  /** "active" when the call was refused, "shadow" when the refusal was only recorded. */
  mode: "shadow" | "active";
  signals: CheckpointSignal[];
  resolution: "consult" | "repeat" | "none";
  priorCalls: number;
  filesRead: number;
  promptChars: number;
  editLines: number;
};

type Counters = {
  priorCalls: number;
  filesRead: number;
  promptChars: number;
  editLines: number;
};

type ToolCallContext = { mode: CheckpointMode; available: boolean; now: number };

const SEARCH_TOOLS: ReadonlySet<string> = new Set(["grep", "find", "ls", "glob"]);
const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "multi_edit"]);
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", "shell", "exec"]);

/**
 * Commands that change what other people and machines see, as the leading words of one shell
 * segment. Local commits, tags and installs are deliberately absent: they are reversible and the
 * model is not being asked about them.
 */
const OUTWARD_COMMANDS: readonly (readonly string[])[] = [
  ["git", "push"],
  ["npm", "publish"],
  ["pnpm", "publish"],
  ["yarn", "publish"],
  ["yarn", "npm", "publish"],
  ["gh", "release", "create"],
  ["gh", "pr", "merge"],
  ["cargo", "publish"],
  ["twine", "upload"],
  ["gem", "push"],
  ["docker", "push"],
  ["vercel", "deploy"],
  ["vercel", "--prod"],
  ["netlify", "deploy"],
  ["firebase", "deploy"],
  ["wrangler", "deploy"],
  ["wrangler", "publish"],
  ["terraform", "apply"],
  ["kubectl", "apply"],
];

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** One word of a shell segment, and whether it came from inside quotes. */
type CommandWord = { text: string; quoted: boolean };

export function classifyToolCall(toolName: string, input: unknown): ToolCallFacts {
  const name = toolName.toLowerCase();
  const record = isRecord(input) ? input : {};
  if (name === "read") return { kind: "read", ...pathEntry(record) };
  if (SEARCH_TOOLS.has(name)) return { kind: "search" };
  if (EDIT_TOOLS.has(name)) {
    return { kind: "edit", ...pathEntry(record), editLines: editLineCount(name, record) };
  }
  if (COMMAND_TOOLS.has(name)) {
    const command = stringField(record, "command");
    if (command === undefined) return { kind: "command", outward: false };
    return { kind: "command", command, outward: isOutwardCommand(command) };
  }
  if (name === "consult_advisor") return { kind: "consult" };
  return { kind: "other" };
}

/**
 * True when the line, in any of its segments, runs a command that publishes or pushes work outside
 * this machine. Shell text is data here: nothing is executed, expanded or resolved, so a quoted
 * mention of a command is not that command and an unparseable line simply matches nothing.
 */
export function isOutwardCommand(commandLine: string): boolean {
  return splitSegments(commandLine).some(isOutwardSegment);
}

/**
 * Ephemeral state of one task plus the one value that outlives it: the last time work was
 * interrupted or an Advisor was consulted. It is read from public tool calls only, never from the
 * user's words or the model's intent.
 */
export class AdvisorCheckpoint {
  private open = false;
  private forced = false;
  private promptChars = 0;
  private priorCalls = 0;
  private searches = 0;
  private readonly readPaths = new Set<string>();
  private round = 0;
  private firstChangeSeen = false;
  private covered = false;
  private fired = false;
  private blocked = false;
  private blockedRound: number | undefined;
  private signals: CheckpointSignal[] = [];
  private counters: Counters | undefined;
  private resolution: "consult" | "repeat" | "none" = "none";
  private lastInterruption: number | undefined;

  /** Every per-task value is dropped, so a new task never inherits the last one's decision. */
  openTask({ promptChars, forced }: { promptChars: number; forced: boolean }): void {
    this.clearTaskState();
    this.open = true;
    this.forced = forced;
    this.promptChars = promptChars;
  }

  /**
   * The report of what this task decided, or undefined when the checkpoint never fired, and then
   * the task is gone either way.
   */
  closeTask(): CheckpointReport | undefined {
    if (!this.open) return undefined;
    const report: CheckpointReport | undefined =
      this.fired && this.counters !== undefined
        ? {
            mode: this.blocked ? "active" : "shadow",
            signals: this.signals,
            resolution: this.resolution,
            ...this.counters,
          }
        : undefined;
    this.open = false;
    this.clearTaskState();
    return report;
  }

  /**
   * After a resume, fork or compaction the earlier calls of this task are unknown, so the task is
   * treated as already covered instead of being refused on a state nobody remembers.
   */
  cover(): void {
    this.covered = true;
  }

  beginRequest(): void {
    this.round += 1;
  }

  /**
   * A consultation is the whole point of the check, so it ends the question for this task. It also
   * restarts the cooldown: a second interruption right after a consultation would be noise.
   */
  noteConsult(now: number): void {
    this.covered = true;
    this.lastInterruption = now;
    if (this.fired && this.resolution === "none") this.resolution = "consult";
  }

  onToolCall(facts: ToolCallFacts, context: ToolCallContext): CheckpointDecision {
    if (!this.open) return { action: "pass" };
    if (facts.kind === "consult") {
      this.noteConsult(context.now);
      return { action: "pass" };
    }
    if (!isStateChanging(facts)) {
      this.countCall(facts);
      return { action: "pass" };
    }

    // The report describes the call the check looked at, so its counters are read before this call
    // is counted for the ones that follow.
    const counters: Counters = {
      priorCalls: this.priorCalls,
      filesRead: this.filesRead,
      promptChars: this.promptChars,
      editLines: facts.kind === "edit" ? (facts.editLines ?? 0) : 0,
    };
    this.countCall(facts);

    if (this.fired) {
      // The calls of one assistant message are one turn: refusing one of them and running the rest
      // would leave the work half-applied, so the whole batch is refused.
      if (this.blockedRound === this.round) return this.blockDecision();
      if (this.resolution === "none") this.resolution = "repeat";
      return { action: "pass" };
    }
    if (this.covered || this.firstChangeSeen) return { action: "pass" };
    // The check happens once per task, at its first change, whatever the answer is.
    this.firstChangeSeen = true;
    // Nothing to ask for when no Advisor can be consulted here, and an off checkpoint is off.
    if (!context.available) return { action: "pass" };
    if (!this.forced && context.mode === "off") return { action: "pass" };

    const signals = this.detectSignals(facts, counters);
    if (signals.length === 0) return { action: "pass" };
    if (!this.forced && this.coolingDown(context.now)) return { action: "pass" };

    this.fired = true;
    this.signals = signals;
    this.counters = counters;
    this.lastInterruption = context.now;
    if (this.forced || context.mode === "active") {
      this.blocked = true;
      this.blockedRound = this.round;
      return this.blockDecision();
    }
    return { action: "shadow", signals };
  }

  private get filesRead(): number {
    return this.readPaths.size + this.searches;
  }

  private countCall(facts: ToolCallFacts): void {
    this.priorCalls += 1;
    if (facts.kind === "search") this.searches += 1;
    else if (facts.kind === "read" && facts.path !== undefined) this.readPaths.add(facts.path);
  }

  private detectSignals(facts: ToolCallFacts, counters: Counters): CheckpointSignal[] {
    const signals: CheckpointSignal[] = [];
    if (this.forced) signals.push("user-forced");
    if (counters.priorCalls >= CHECKPOINT_PRIOR_CALLS) signals.push("prior-calls");
    if (counters.filesRead >= CHECKPOINT_FILES_READ) signals.push("files-read");
    if (counters.promptChars >= CHECKPOINT_PROMPT_CHARS) signals.push("long-prompt");
    if (counters.editLines > CHECKPOINT_EDIT_LINES) signals.push("large-edit");
    if (facts.kind === "command" && facts.outward === true) signals.push("outward-step");
    return signals;
  }

  private coolingDown(now: number): boolean {
    if (this.lastInterruption === undefined) return false;
    return now - this.lastInterruption < CHECKPOINT_COOLDOWN_MS;
  }

  private blockDecision(): CheckpointDecision {
    return { action: "block", signals: this.signals, message: CHECKPOINT_MESSAGE };
  }

  private clearTaskState(): void {
    this.forced = false;
    this.promptChars = 0;
    this.priorCalls = 0;
    this.searches = 0;
    this.readPaths.clear();
    this.round = 0;
    this.firstChangeSeen = false;
    this.covered = false;
    this.fired = false;
    this.blocked = false;
    this.blockedRound = undefined;
    this.signals = [];
    this.counters = undefined;
    this.resolution = "none";
  }
}

function isStateChanging(facts: ToolCallFacts): boolean {
  return facts.kind === "edit" || (facts.kind === "command" && facts.outward === true);
}

function isOutwardSegment(words: readonly CommandWord[]): boolean {
  let start = 0;
  while (start < words.length && isLeadingNoise(words[start])) start += 1;
  const command = words.slice(start);
  // A dry run reports what it would do and changes nothing outside this machine.
  if (command.some((word) => word.text === "--dry-run")) return false;
  return OUTWARD_COMMANDS.some(
    (candidate) =>
      candidate.length <= command.length &&
      candidate.every((word, index) => !command[index].quoted && command[index].text === word),
  );
}

function isLeadingNoise(word: CommandWord): boolean {
  return !word.quoted && (word.text === "sudo" || ASSIGNMENT.test(word.text));
}

/**
 * Split a shell line into segments of words, on `&&`, `;` and `|` outside quotes. Words keep the
 * mark of having been quoted, because a quoted word is text an earlier command is being handed,
 * not a command being run.
 */
function splitSegments(commandLine: string): CommandWord[][] {
  const segments: CommandWord[][] = [];
  let words: CommandWord[] = [];
  let text = "";
  let quoted = false;
  let quote: string | undefined;

  const pushWord = (): void => {
    if (text === "") return;
    words.push({ text, quoted });
    text = "";
    quoted = false;
  };
  const pushSegment = (): void => {
    pushWord();
    segments.push(words);
    words = [];
  };

  for (const character of commandLine) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else {
        text += character;
        quoted = true;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === " " || character === "\t") {
      pushWord();
      continue;
    }
    if (character === "&" || character === ";" || character === "|") {
      pushSegment();
      continue;
    }
    text += character;
  }
  pushSegment();
  return segments;
}

function editLineCount(toolName: string, record: Record<string, unknown>): number {
  if (toolName === "write") return lineCount(record.content);
  if (Array.isArray(record.edits)) {
    return record.edits.reduce<number>((total, edit) => total + newTextLineCount(edit), 0);
  }
  return newTextLineCount(record);
}

function newTextLineCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  return lineCount(typeof value.newText === "string" ? value.newText : value.new_string);
}

function lineCount(value: unknown): number {
  if (typeof value !== "string" || value === "") return 0;
  return value.split("\n").length;
}

function pathEntry(record: Record<string, unknown>): { path?: string } {
  const path = stringField(record, "path", "file_path");
  return path === undefined ? {} : { path };
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

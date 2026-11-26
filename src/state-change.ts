/**
 * One answer to one question: does this tool call change state?
 *
 * The levels that hold changes need a closed answer, so the question is not "does this look
 * dangerous" but "is this provably a read". Everything that is not a whitelisted read is a change,
 * including a tool this extension has never seen. Shell text is read as data and never executed,
 * expanded or resolved: a line this module cannot fully account for is a change, not a guess.
 *
 * The classification is one pure function with no imports, so the host, the tests and a machine
 * whose clock or shell is different all classify the same input the same way.
 *
 * It is a nudge, not a security boundary: it reads the tool name and the text of a shell command, it
 * can be wrong in both directions, and it grants and inspects no permission.
 */

/** What a tool call does, as far as this extension can tell without running it. */
export type ToolCallFacts = {
  kind: "read" | "search" | "edit" | "command" | "consult" | "other";
  /** Present for a read or an edit when the input names a file. */
  path?: string;
  /** New lines an edit would write, summed over its several edits. */
  editLines?: number;
  /** The raw command line, kept for the caller; nothing here interprets it again. */
  command?: string;
  /** True when this call changes state, which is what the levels hold back. */
  changes: boolean;
};

const SEARCH_TOOLS: ReadonlySet<string> = new Set(["grep", "find", "ls", "glob"]);
const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "multi_edit"]);
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell", "shell", "exec"]);
const SUBAGENT_READ_ACTIONS: ReadonlySet<string> = new Set(["status", "list", "guide"]);
/** Session control: these steer the session or its children and touch no project state. */
export const CONTROL_TOOLS: ReadonlySet<string> = new Set([
  "ask_user_question",
  "todo",
  "bg_wait",
  "subagent_supervisor",
]);
/** The extension's own consultation tool. It is never a change: a gate that refuses it deadlocks. */
const CONSULT_TOOL = "consult_advisor";

/**
 * Commands that only report: the leading word of one shell segment, and how it may be used. A
 * command not named here changes state, so a new tool or a new program is covered without a change
 * to this file. `deny` lists flags that turn the same program into a writer.
 */
const READ_PROGRAMS: readonly string[] = [
  "ls",
  "dir",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "nl",
  "tac",
  "sort",
  "uniq",
  "cut",
  "tr",
  "rev",
  "column",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "diff",
  "cmp",
  "comm",
  "join",
  "paste",
  "grep",
  "rg",
  "jq",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "[[",
  "whoami",
  "uname",
  "id",
  "env",
  "printenv",
  "which",
  "whereis",
  "type",
  "cygpath",
  "sleep",
];

/**
 * Options that turn a program that only reports into one that writes. A program listed here stays a
 * read unless one of its writer options is present.
 */
const WRITE_OPTIONS: Record<string, readonly string[]> = {
  sort: ["-o", "-T"],
  rg: ["-z"],
  // `file -C` compiles a magic database next to the input.
  file: ["-C", "--compile"],
  tree: ["-o"],
  jq: ["-i", "--in-place"],
};

/** `git` is allowed only for the subcommands that report; anything else is a change. */
const GIT_READ_SUBCOMMANDS: readonly string[] = [
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "blame",
  "shortlog",
  "describe",
  "cat-file",
  "show-ref",
  "for-each-ref",
  "merge-base",
  "name-rev",
  "diff-tree",
  "diff-files",
  "diff-index",
  "version",
  "grep",
];

/** `git branch`, `git tag` and `git remote` list only when used without a writing option. */
const GIT_LIST_OPTIONS: readonly string[] = [
  "-a",
  "-v",
  "-vv",
  "--list",
  "-l",
  "--show-current",
  "-r",
  "-n",
  "--no-pager",
];

/** `find` walks the tree, but these options make it write or run something. */
const FIND_WRITE_OPTIONS: readonly string[] = [
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
];

/** Prefixes that hand the rest of the line to another program, so the leading word says nothing. */
const WRAPPER_PROGRAMS: readonly string[] = ["sudo", "doas", "xargs", "env", "time", "nohup"];

/** Characters that write, read into a program, or build a line this reader cannot account for. */
const UNSAFE_TEXT: readonly string[] = [">", "<", "`", "$(", "${", "<<", "&>"];

/** Long options that write a file or run a program whatever the command they belong to. */
const RISKY_OPTIONS: readonly string[] = [
  "--output",
  "--exec",
  "--exec-batch",
  "--pre",
  "--pre-glob",
  "--pager",
  "--paginate",
  "--compress-program",
  "--temporary-directory",
  "--hostname-bin",
  "--search-zip",
  "--open-files-in-pager",
  "--ext-diff",
  "--textconv",
  "--filters",
  "--exec-path",
];

/** `2>&1`, and any stream sent to the null device, with or without a space before the target. */
const HARMLESS_REDIRECTS = /(?:\d?>&\d)|(?:(?:&|\d)?>\s?(?:\/dev\/null|NUL|\$null)(?![\w./$-]))/g;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** One word of a shell segment, and whether it came from inside quotes. */
type CommandWord = { text: string; quoted: boolean };

export function classifyToolCall(toolName: string, input: unknown): ToolCallFacts {
  const name = toolName.toLowerCase();
  const record = isRecord(input) ? input : {};
  if (name === CONSULT_TOOL) return { kind: "consult", changes: false };
  if (name === "read") return { kind: "read", changes: false, ...pathEntry(record) };
  if (SEARCH_TOOLS.has(name)) return { kind: "search", changes: false };
  if (EDIT_TOOLS.has(name)) {
    return {
      kind: "edit",
      changes: true,
      ...pathEntry(record),
      editLines: editLineCount(name, record),
    };
  }
  if (COMMAND_TOOLS.has(name)) {
    const command = stringField(record, "command");
    // A shell call this module cannot read is a change, like everything else it cannot account for.
    if (command === undefined) return { kind: "command", changes: true };
    return { kind: "command", command, changes: isStateChangeCommand(command) };
  }
  // These actions of the host's subagent tool only report. Every other action, `resume` included,
  // can set a child to work, so it stays a change like a launch.
  if (name === "subagent" && SUBAGENT_READ_ACTIONS.has(String(record.action)))
    return { kind: "other", changes: false };
  // Session control only: asking the user, tracking the plan, waiting on a child, reaching the
  // supervisor. Holding these would close the human channel a held task needs to get out.
  if (CONTROL_TOOLS.has(name)) return { kind: "other", changes: false };
  // An unknown tool is a change: only a read named here is known not to change anything.
  return { kind: "other", changes: true };
}

/**
 * True when the line, in any of its segments, changes something. A line is read as shell text: it
 * is never run, and a quoted mention of a program is not that program.
 */
export function isStateChangeCommand(commandLine: string): boolean {
  if (commandLine.trim() === "") return false;
  // Discarding output or folding stderr into stdout writes no file, and both are too common on a
  // plain read to count: they are dropped before anything else is looked at.
  const line = commandLine.replace(HARMLESS_REDIRECTS, " ");
  if (UNSAFE_TEXT.some((token) => outsideQuotes(line, token))) return true;
  const segments = splitSegments(line);
  return segments.some((segment) => !isReadSegment(segment));
}

function isReadSegment(words: readonly CommandWord[]): boolean {
  let start = 0;
  while (start < words.length) {
    const word = words[start];
    if (!word.quoted && isLeadingNoise(word.text)) {
      start += 1;
      continue;
    }
    break;
  }
  const command = words.slice(start);
  if (command.length === 0) return true;
  const program = command[0];
  // A quoted first word is an argument someone else will read, not a command being run.
  if (program.quoted) return false;
  const name = program.text;
  const rest = command.slice(1).map((word) => word.text);
  if (WRAPPER_PROGRAMS.includes(name) && name !== "env") return false;
  if (name === "env") {
    // `env` prints the environment with no argument, and runs a program with one.
    return rest.length === 0 || rest.every((word) => word.startsWith("-"));
  }
  // An option that names an output file writes it, and one that names a program runs it, in every
  // spelling: `--output f`, `--output=f`.
  if (rest.some((word) => RISKY_OPTIONS.some((option) => isOption(word, option)))) return false;
  // `date` is not in the table above: it reports with no operand or with a `+format`, and sets the
  // clock with anything else.
  if (name === "date")
    return rest.every((word) => word.startsWith("+") || ["-u", "-R", "-I"].includes(word));
  if (name === "find") return !rest.some((word) => FIND_WRITE_OPTIONS.includes(word));
  if (name === "git") return isReadGit(rest);
  if (name === "command") return rest.length > 0 && (rest[0] === "-v" || rest[0] === "-V");
  // `uniq INPUT OUTPUT` writes the second file, so it is a change when it names two paths.
  if (name === "uniq") return rest.filter((word) => !word.startsWith("-")).length <= 1;
  // `Object.hasOwn`, so a program named like a prototype member (`constructor`) owns no entry.
  const writers = Object.hasOwn(WRITE_OPTIONS, name) ? WRITE_OPTIONS[name] : undefined;
  if (writers && rest.some((word) => writers.some((option) => isOption(word, option))))
    return false;
  // A bare `cd` changes nothing another segment can rely on, and every segment that follows is
  // classified on its own.
  if (name === "cd") return true;
  return READ_PROGRAMS.includes(name);
}

/**
 * `git` reports in most of its subcommands and writes in the rest. A global option before the
 * subcommand is skipped, and the three subcommands that list or write depending on their arguments
 * accept only the listing ones.
 */
function isReadGit(args: readonly string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const word = args[index];
    if (word === "-C") {
      index += 2;
      continue;
    }
    // Any other global option can point git at a pager, a config value or another program.
    if (word === "--no-pager") {
      index += 1;
      continue;
    }
    if (word.startsWith("-")) return word === "--version" || word === "--help";
    break;
  }
  const subcommand = args[index];
  if (subcommand === undefined) return true;
  // `git grep -O<pager>` hands the matching files to a program, alone or in a group of options.
  if (subcommand === "grep" && args.slice(index + 1).some((word) => isOption(word, "-O")))
    return false;
  if (
    subcommand !== "branch" &&
    subcommand !== "tag" &&
    subcommand !== "remote" &&
    subcommand !== "stash"
  )
    return GIT_READ_SUBCOMMANDS.includes(subcommand);
  const rest = args.slice(index + 1);
  if (subcommand === "stash") return rest[0] === "list" || rest[0] === "show";
  return rest.length === 0 || rest.every((word) => GIT_LIST_OPTIONS.includes(word));
}

/**
 * `-o f`, `-of`, `-uo f` (grouped), `--output f` and `--output=f` are the same option. An
 * abbreviation of a long option is not recognized.
 */
function isOption(word: string, option: string): boolean {
  if (word === option) return true;
  if (option.startsWith("--")) return word.startsWith(`${option}=`);
  if (word.startsWith(option)) return true;
  // A group of short options runs each of them, so the letter counts wherever it appears.
  const letter = option.slice(1);
  return /^-[A-Za-z]{2,}/.test(word) && word.includes(letter);
}

function isLeadingNoise(text: string): boolean {
  return ASSIGNMENT.test(text);
}

/**
 * True when `token` appears outside quotes. A redirection inside quotes is an argument, not a
 * redirection, so `grep "a > b" file` stays a read.
 */
function outsideQuotes(commandLine: string, token: string): boolean {
  let index = 0;
  let quote: string | undefined;
  while (index < commandLine.length) {
    const character = commandLine[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index += 1;
      continue;
    }
    if (commandLine.startsWith(token, index)) return true;
    index += 1;
  }
  return false;
}

/**
 * Split a shell line into segments of words, on `&&`, `||`, `;`, `|` and `&` outside quotes. Words
 * keep the mark of having been quoted, because a quoted word is text handed to a program, not a
 * program being run.
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
    // A new line starts a new command, so every line is classified on its own.
    if (
      character === "&" ||
      character === ";" ||
      character === "|" ||
      character === "\n" ||
      character === "\r"
    ) {
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

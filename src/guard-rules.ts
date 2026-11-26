/**
 * The deterministic rules of the `guard` level. One sentence holds the whole design: a line is
 * **certain** when it is one or more simple commands (split on unquoted `;`, `|`, `&&`, `||`, `&` and
 * newlines) with plain quotes and no backslash, substitution, backtick, here-doc, process
 * substitution, wrapper (`bash/sh/… -c`, `eval`, `cmd /c`, `powershell -Command`, `xargs`, `busybox`,
 * `chroot`, `stdbuf`, `setsid`, `ionice`, `watch`, `strace`) or quoted or variable command word; the
 * HARD rules apply only to certain lines, and every other changing line is a SOFT `long-command`
 * refusal with a one-call pass for that exact line. The transparent prefixes are `sudo`, `doas`,
 * `env`, `nice`, `timeout`, `nohup`, `time`, `command`, `exec`, `builtin` and the package runners
 * `npx`, `pnpx`, `bunx`, `npm exec|x`, `pnpm exec|dlx`, `yarn exec|dlx` and `bun x`, each with its documented
 * options only; a line with no command text at all is held like any other line this reader cannot
 * account for.
 *
 * What that buys: a small, closed set of refusals that only the user can lift, decided on lines the
 * reader can actually read, and a single honest answer for everything else — "this reader cannot
 * judge it" — instead of a second reader guessing at text. What it costs: a wrapper, an escape, a
 * substitution or a variable hides the command from the hard rules, and the line is then held until a
 * consultation answers it once. That is deliberate: this is an accident tripwire in front of the
 * count, not a sandbox, and a line built to hide what it runs is still a change for the count.
 *
 * The soft families and the trajectory holds are unchanged: CI configuration, Git hooks, `.npmrc`, a
 * lockfile edited by hand, a newly named package and a command over `GUARD_LONG_COMMAND_CHARS` bytes;
 * three failing runs in a row, the same file edited again after failures, and several files touched
 * with no consultation.
 *
 * A refusal never states a count, a threshold or the pattern that matched, because the text is the
 * part a model can learn to satisfy. It names the category and the one exit that changes it.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { classifyToolCall, type ToolCallFacts } from "./state-change.ts";
import { consultInstruction, wayOutBrokenClause, type GateLauncher } from "./advisor-gate.ts";

/** Calls a pass covers once a consultation has answered for a rule and target pair. */
export const GUARD_PASS_CALLS = 3;
/** Executions in a row that failed, after which the next command is held. */
export const GUARD_FAILING_RUNS = 3;
/** Edits of one file, with failures between them, after which the next edit of it is held. */
export const GUARD_REPEATED_EDITS = 3;
/** Files edited with no consultation, after which the next new file is held. */
export const GUARD_DISTINCT_FILES = 3;
/**
 * A command over this many UTF-8 bytes is not read at all: it is held as too long to read, which is a
 * cost guard and a soft rule, never a hard one. Bytes, because the plan states it in kilobytes.
 */
export const GUARD_LONG_COMMAND_CHARS = 1024;

/** Every rule this version knows, in the order a refusal picks one. Content-free by construction. */
export const GUARD_RULE_CODES = [
  "force-push",
  "reset-hard",
  "clean-force",
  "recursive-delete",
  "download-to-shell",
  "publish",
  "credentials",
  "skip-hooks",
  "policy-files",
  "ci-config",
  "git-hooks",
  "npmrc",
  "lockfile",
  "new-package",
  "long-command",
  "failing-runs",
  "repeated-edits",
  "new-files",
  "engine-failure",
] as const;
export type GuardRuleCode = (typeof GUARD_RULE_CODES)[number];

export type GuardRuleKind = "hard" | "soft" | "trajectory";

/** One rule hit: which closed code fired, and the target a pass would be keyed on. */
export type GuardMatch = Readonly<{
  kind: GuardRuleKind;
  code: GuardRuleCode;
  target: string;
  /** The line is one this reader cannot judge, so the refusal says so and covers one call. */
  unreadable?: boolean;
  /** The call carried no line at all, so the refusal talks about the call and not about a line. */
  noLine?: boolean;
}>;

/** What the task already did, which is all a trajectory rule reads. */
export type GuardTrajectoryFacts = Readonly<{
  /** Executions in a row that reported an error. */
  failingRuns: number;
  /** Edits of this target since the last answered consultation. */
  previousEdits: number;
  /** A failure fell between those edits. */
  failuresBetweenEdits: boolean;
  /** Distinct other files edited since the last answered consultation. */
  otherFiles: number;
  /** This target has not been edited since the last answered consultation. */
  newFile: boolean;
}>;

const NO_HISTORY: GuardTrajectoryFacts = {
  failingRuns: 0,
  previousEdits: 0,
  failuresBetweenEdits: false,
  otherFiles: 0,
  newFile: true,
};

/** What a refusal says the rule was, in words a reader can act on and a model cannot satisfy. */
const GUARD_RULE_LABELS: Readonly<Record<GuardRuleCode, string>> = {
  "force-push": "force push",
  "reset-hard": "hard reset",
  "clean-force": "forced clean",
  "recursive-delete": "recursive delete",
  "download-to-shell": "download piped to a shell",
  publish: "publishing a package or merging a pull request",
  credentials: "writing credentials",
  "skip-hooks": "skipping Git hooks",
  "policy-files": "writing this extension's own files",
  "ci-config": "continuous integration configuration",
  "git-hooks": "Git hooks",
  npmrc: "npm configuration",
  lockfile: "lockfile edited by hand",
  "new-package": "a newly named package",
  "long-command": "a line this reader cannot judge with certainty",
  "engine-failure": "the guard could not judge this call",
  "failing-runs": "repeated failing runs",
  "repeated-edits": "the same file edited again after failures",
  "new-files": "several files touched with no consultation",
};

const HARD_AFTER =
  "Only the user can allow this call. Ask the user to make it, or to change the Advisor level, and stop: repeating the call, or consulting an Advisor, does not run it.";
const SOFT_AFTER =
  "A consultation that answers covers this target for a few calls. Reading is not affected.";
const UNREADABLE_AFTER =
  "A consultation that answers covers this exact line once and never another one. Split it into shorter commands, or issue it plainly as a direct command, so it can be read.";
/** The same refusal when the call carries no line at all: `{}` on a shell tool. */
const UNREADABLE_CALL_AFTER =
  "A consultation that answers covers this exact call once and never another one. Send the command itself, as a plain line, so it can be read.";
const FAILED_AFTER =
  "The guard failed while judging this call, so it was not run. No consultation lifts this one: report the failure to the user and stop.";

/**
 * The refusal for one rule hit. It names the category and nothing else: no count, no threshold and no
 * pattern, because any of those can be satisfied by the model the rule exists for. A `hard` rule
 * offers no way through the model at all, so it names the person instead.
 */
export function guardMessage(
  match: GuardMatch,
  options: { launcher: GateLauncher; manualContext?: boolean; wayOutBroken?: boolean },
): string {
  const prefix = `Not an error: this call was not run. Guard rule: ${GUARD_RULE_LABELS[match.code]}.`;
  if (match.kind === "hard") return [prefix, HARD_AFTER].join("\n");
  const message = [
    prefix,
    consultInstruction(options.launcher, options.manualContext ?? false),
    match.unreadable === true
      ? match.noLine === true
        ? UNREADABLE_CALL_AFTER
        : UNREADABLE_AFTER
      : SOFT_AFTER,
  ];
  if (options.wayOutBroken) message.push(wayOutBrokenClause());
  return message.join("\n");
}

/* ------------------------------------------------------------------------------------------------
 * Reading a line: certain or not
 * ---------------------------------------------------------------------------------------------- */

type Word = { text: string; quoted: boolean };

/** One simple command of a certain line. */
type Command = {
  words: Word[];
  program: string;
  args: string[];
  /** The word index of `program`, so the assignment prefix in front of it can be read. */
  programIndex: number;
  joiner?: string;
  /** A prefix option this reader does not know, or a command word it cannot name. */
  uncertain?: true;
};

type Reading = { certain: true; commands: Command[] } | { certain: false };

const UNCERTAIN: Reading = { certain: false };

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Programs that hand the line to another program, so a line that names one is not a line this reader
 * can read: `bash -c "…"`, `eval "…"`, `cmd /c "…"`, `powershell -Command "…"`, `xargs …`.
 */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "fish",
  "pwsh",
  "powershell",
  "iex",
  "cmd",
  "eval",
]);
/**
 * Launchers that always run what follows them, whatever the flags: `npx rm`, `xargs rm`,
 * `chroot / rm`. A line that names one is not a line this reader can read.
 */
const LAUNCHERS: ReadonlySet<string> = new Set([
  "xargs",
  "busybox",
  "chroot",
  "stdbuf",
  "setsid",
  "ionice",
  "watch",
  "strace",
]);
const WRAPPERS: ReadonlySet<string> = new Set([...INTERPRETERS, ...LAUNCHERS]);
/** The flags that turn an interpreter into a wrapper; a script invocation has none of them. */
function isWrapFlag(word: string): boolean {
  // Exact tokens only: `--norc` and `-ExecutionPolicy` are options, not wrappers, and a long option
  // that merely contains a `c` must never hide the real flag behind it.
  if (word.startsWith("--")) return /^--(?:command|c)$/i.test(word);
  if (/^\/{1,2}[ck]$/i.test(word)) return true;
  // A short cluster that ends in `c`: `-c`, `-lc`, `-ec`, and PowerShell's `-Command` in its short
  // and abbreviated spellings.
  return /^-(?:c|com|comm|comma|comman|command|[A-Za-z]*c)$/i.test(word);
}

/**
 * One table per prefix: the options it documents and the ones that carry their value in the next
 * word. A known prefix is transparent with those options; any other option makes the line uncertain
 * instead of being skipped blindly. A `Map`, so a word such as `constructor` is not a prefix.
 */
type PrefixOptions = Readonly<{ flags: ReadonlySet<string>; values: ReadonlySet<string> }>;

function prefixOptions(flags: readonly string[], values: readonly string[] = []): PrefixOptions {
  return { flags: new Set(flags), values: new Set(values) };
}

const PREFIX_TABLE: ReadonlyMap<string, PrefixOptions> = new Map([
  [
    "sudo",
    prefixOptions(
      [
        "-n",
        "-E",
        "-l",
        "-s",
        "-A",
        "-b",
        "-H",
        "-i",
        "-K",
        "-k",
        "-S",
        "-v",
        "-V",
        "-e",
        "-u",
        "--user",
        "-g",
        "--group",
        "-p",
        "--prompt",
        "-C",
        "--close-from",
        "-U",
        "--other-user",
        "-D",
        "--chdir",
        "-r",
        "--role",
        "-t",
        "--type",
        "-h",
        "--host",
        "-T",
        "--command-timeout",
        "-R",
        "--chroot",
      ],
      [
        "-u",
        "--user",
        "-g",
        "--group",
        "-p",
        "--prompt",
        "-C",
        "--close-from",
        "-U",
        "--other-user",
        "-D",
        "--chdir",
        "-r",
        "--role",
        "-t",
        "--type",
        "-h",
        "--host",
        "-T",
        "--command-timeout",
        "-R",
        "--chroot",
      ],
    ),
  ],
  ["doas", prefixOptions(["-u", "-C", "-n", "-s", "-L"], ["-u", "-C"])],
  [
    "env",
    prefixOptions(
      ["-i", "--ignore-environment", "-u", "--unset", "-C", "--chdir", "-0", "--null"],
      ["-u", "--unset", "-C", "--chdir"],
    ),
  ],
  ["nice", prefixOptions(["-n", "--adjustment"], ["-n", "--adjustment"])],
  [
    "timeout",
    prefixOptions(
      ["-s", "--signal", "-k", "--kill-after", "--foreground", "-v", "--verbose"],
      ["-s", "--signal", "-k", "--kill-after"],
    ),
  ],
  ["nohup", prefixOptions([])],
  [
    "time",
    prefixOptions(
      ["-p", "-f", "--format", "-o", "--output", "-a", "-v", "--verbose"],
      ["-f", "--format", "-o", "--output"],
    ),
  ],
  ["command", prefixOptions(["-p", "-v", "-V"])],
  ["exec", prefixOptions(["-a", "-c", "-l"], ["-a"])],
  ["builtin", prefixOptions([])],
  // Every package runner shares one whitelist of valueless flags. Anything else in that prefix —
  // an option with a value, an unknown flag, an assignment — is a shape this reader does not know,
  // and it makes the line uncertain rather than judging the program behind it.
  ["runner", prefixOptions(["-y", "--yes", "--no", "-q", "--quiet"])],
]);

/** The runners that are their own prefix, with no subcommand of their own. */
const BARE_RUNNERS: ReadonlySet<string> = new Set(["npx", "pnpx", "bunx"]);
/** The package managers whose own subcommand turns them into a runner. */
const RUNNERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["npm", new Set(["exec", "x"])],
  ["pnpm", new Set(["exec", "dlx"])],
  ["yarn", new Set(["exec", "dlx"])],
  ["bun", new Set(["x"])],
]);

/** The prefix whose first non-option word is its duration, not the program. */
const DURATION_PREFIX = "timeout";
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/** Two-letter Windows flags such as `/s`, as opposed to a POSIX path such as `/home/user`. */
const WINDOWS_FLAG = /^\/[A-Za-z?]+$/;

/**
 * The program a word names. A Windows shim is the same program as the binary it starts, so `.exe`,
 * `.cmd` and `.bat` are stripped: `npx.cmd` launches what `npx` launches.
 */
function baseName(text: string): string {
  const name = text.split(/[\\/]/).pop() ?? text;
  return name.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "");
}

function isFlagWord(word: string): boolean {
  return word.startsWith("-") || WINDOWS_FLAG.test(word);
}

/**
 * The package runner at this word, if it is one: `npx`, `pnpx`, `bunx`, and `npm exec|x`,
 * `pnpm exec|dlx`, `yarn exec|dlx`, `bun x`. The word after the manager's name is the only candidate
 * for its subcommand: an ordinary word there means this was a plain package-manager command
 * (`npm test`), and an option there makes the line uncertain only when a runner subcommand follows.
 */
function runnerPrefixAt(
  words: readonly Word[],
  index: number,
): { next: number } | "uncertain" | undefined {
  const name = baseName(words[index]!.text);
  if (BARE_RUNNERS.has(name)) return { next: index + 1 };
  const subcommands = RUNNERS.get(name);
  if (subcommands === undefined) return undefined;
  const next = words[index + 1];
  if (next === undefined) return undefined;
  // The next word is the only subcommand candidate: `npm exec` is a runner shape and `npm install`
  // is an ordinary package-manager command, never uncertain.
  if (!isFlagWord(next.text))
    return subcommands.has(next.text.toLowerCase()) ? { next: index + 2 } : undefined;
  // An option between the manager name and its subcommand is a shape this reader does not know, and
  // it is uncertain only when a runner subcommand does follow: `pnpm -C . exec` is that shape, and
  // `npm -s install` is still just npm. One linear look at the rest of this command, no window.
  for (let at = index + 2; at < words.length; at += 1)
    if (subcommands.has(words[at]!.text.toLowerCase())) return "uncertain";
  return undefined;
}

/**
 * The program a command runs, skipping assignments and the transparent prefixes in front of it. A
 * prefix option this table does not know, a quoted command word or a variable one all make the line
 * uncertain, which the caller reports.
 */
function commandOf(words: readonly Word[]): {
  program: string;
  args: string[];
  programIndex: number;
  uncertain?: true;
} {
  let index = 0;
  let prefix: string | undefined;
  let durationSeen = false;
  let endedOptions = false;
  while (index < words.length) {
    const word = words[index]!;
    // An assignment is skipped whatever its quoting: `HUSKY="0"` is the value the shell uses, and
    // `CI=1 npx tsc` is an ordinary command with an environment in front of it. Inside a runner's
    // prefix it is another shape: `npx FOO=1 tsc` is uncertain.
    if (ASSIGNMENT.test(word.text)) {
      if (prefix === "runner")
        return { program: "", args: [], programIndex: index, uncertain: true };
      index += 1;
      continue;
    }
    if (word.quoted) return { program: "", args: [], programIndex: index, uncertain: true };
    const name = baseName(word.text);
    const runner = runnerPrefixAt(words, index);
    if (runner === "uncertain")
      return { program: "", args: [], programIndex: index, uncertain: true };
    if (runner !== undefined) {
      prefix = "runner";
      durationSeen = false;
      endedOptions = false;
      index = runner.next;
      continue;
    }
    if (PREFIX_TABLE.has(name)) {
      prefix = name;
      durationSeen = false;
      endedOptions = false;
      index += 1;
      continue;
    }
    if (prefix !== undefined && !endedOptions && isFlagWord(word.text)) {
      if (word.text === "--") {
        endedOptions = true;
        index += 1;
        continue;
      }
      const wordsUsed = prefixOptionWords(prefix, word.text);
      if (wordsUsed === "unknown")
        return { program: "", args: [], programIndex: index, uncertain: true };
      index += wordsUsed;
      continue;
    }
    if (prefix === DURATION_PREFIX && !durationSeen) {
      durationSeen = true;
      if (DURATION.test(word.text)) {
        index += 1;
        continue;
      }
    }
    break;
  }
  const program = words[index];
  if (!program) return { program: "", args: [], programIndex: index };
  if (program.text.startsWith("$"))
    return { program: "", args: [], programIndex: index, uncertain: true };
  return {
    program: baseName(program.text),
    args: words.slice(index + 1).map((word) => word.text),
    programIndex: index,
  };
}

/** How many words one option of a prefix consumes, or `"unknown"` when this reader does not know it. */
function prefixOptionWords(prefix: string, word: string): number | "unknown" {
  const known = PREFIX_TABLE.get(prefix);
  if (known === undefined) return "unknown";
  const at = word.indexOf("=");
  const option = at < 0 ? word : word.slice(0, at);
  const attached = at >= 0;
  if (!known.flags.has(option)) {
    // A known short option with its value attached: `-uroot`, `-n10`, `-sKILL`.
    for (const candidate of known.flags)
      if (candidate.length === 2 && word.startsWith(candidate) && word.length > 2) return 1;
    return "unknown";
  }
  if (known.values.has(option)) return attached ? 1 : 2;
  return 1;
}

/**
 * A line as commands, or the statement that it is not one this reader can read. A wrapper, a
 * backslash, a substitution, a backtick, a here-doc or a process substitution anywhere makes the whole
 * line uncertain: none of them is followed here.
 */
function readLine(text: string): Reading {
  const commands: Command[] = [];
  let words: Word[] = [];
  let current = "";
  let quoted = false;
  let quote: string | undefined;
  let joiner: string | undefined;
  let certain = true;
  const pushWord = (): void => {
    if (current === "") return;
    words.push({ text: current, quoted });
    current = "";
    quoted = false;
  };
  const pushCommand = (): void => {
    pushWord();
    commands.push({ words, ...commandOf(words), joiner });
    words = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const next = text[index + 1];
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else {
        current += character;
        quoted = true;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "\\" || character === "`") {
        certain = false;
        continue;
      }
      if (character === "$" && next === "(") {
        certain = false;
        continue;
      }
      current += character;
      quoted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
      continue;
    }
    if (character === "\\" || character === "`") {
      certain = false;
      continue;
    }
    if (character === "$" && next === "(") {
      certain = false;
      continue;
    }
    if ((character === "<" || character === ">") && next === "(") {
      certain = false;
      continue;
    }
    if (character === "<" && next === "<") {
      certain = false;
      continue;
    }
    if (";&|\n\r".includes(character)) {
      pushCommand();
      joiner = character === "\n" || character === "\r" ? ";" : character;
      continue;
    }
    if (character === " " || character === "\t") {
      pushWord();
      continue;
    }
    current += character;
  }
  // An unclosed quote is a line whose end this reader cannot find.
  if (quote !== undefined) return UNCERTAIN;
  pushCommand();
  if (!certain) return UNCERTAIN;
  for (const command of commands) {
    if (command.uncertain === true) return UNCERTAIN;
    if (!WRAPPERS.has(command.program)) continue;
    // A wrapper is only a wrapper when it is actually given something to run: `bash script.sh` and
    // `bash --version` are ordinary commands, `bash -c "…"` and `xargs rm` are not.
    if (LAUNCHERS.has(command.program)) return UNCERTAIN;
    // `eval` wraps whatever it is given, and an interpreter wraps what its flag hands it.
    if (command.program === "eval" && command.args.length > 0) return UNCERTAIN;
    // `powershell -Command:"…"` glues the flag and its line into one word.
    if (command.args.some((word) => isWrapFlag(word) || isWrapFlag(word.split(":")[0] ?? "")))
      return UNCERTAIN;
  }
  return { certain: true, commands };
}

/* ------------------------------------------------------------------------------------------------
 * Certain rules
 * ---------------------------------------------------------------------------------------------- */

const DELETE_PROGRAMS = new Set(["rm"]);
const FETCHERS = new Set(["curl", "wget", "iwr", "invoke-webrequest"]);
/** The shells a download is dangerous to hand to. */
const SHELL_EXEC = new Set(["sh", "bash", "zsh", "dash"]);
const PACKAGE_PUBLISHERS = new Set(["npm", "yarn", "pnpm", "bun", "cargo", "poetry"]);

/** `-f`, `-fu`, `--force`, `--force-with-lease`, and a `+refspec` operand all force a push. */
function isForcePush(rest: readonly string[]): boolean {
  return rest.some(
    (word) =>
      word.startsWith("+") || word.startsWith("--force") || /^-[A-Za-z]*f[A-Za-z]*$/.test(word),
  );
}

/** `git clean -fd`, `-fdx`, `-f`; a dry run cleans nothing, whatever else it names. */
function isForcedClean(rest: readonly string[]): boolean {
  const forced = rest.some((word) => word === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(word));
  const dryRun = rest.some((word) => word === "--dry-run" || /^-[A-Za-z]*n[A-Za-z]*$/.test(word));
  return forced && !dryRun;
}

/** `rm -r`, `-R`, `-rf`: the recursion that makes a delete a delete of everything under a path. */
function isRecursive(args: readonly string[]): boolean {
  return args.some((word) => word === "--recursive" || /^-[A-Za-z]*[rR]/.test(word));
}

/**
 * The targets the plan holds under `hard`: an absolute path, the home directory, a parent, a path
 * built from a variable, or the repository itself. A relative directory such as `build` is left to
 * the count.
 */
function isDestructiveTarget(path: string): boolean {
  const target = path.trim().replace(/\\/g, "/").slice(0, 256);
  if (target === "") return false;
  if (/^[A-Za-z]:/.test(target)) return true;
  if (target.startsWith("/")) return true;
  if (/^(?:~|\$home|\$\{home\})/i.test(target)) return true;
  if (target.split("/").includes("..")) return true;
  if (target.includes("$")) return true;
  return target.split("/").some((part) => part === ".git");
}

/** A download piped into a shell: the pipe hands the bytes to the next command. */
function isDownloadToShell(commands: readonly Command[]): boolean {
  return commands.some((command, index) => {
    if (!FETCHERS.has(command.program)) return false;
    const next = commands[index + 1];
    return next !== undefined && next.joiner === "|" && SHELL_EXEC.has(next.program);
  });
}

/** Options of the package managers that take the next word, so the subcommand is not mistaken. */
const PUBLISHER_VALUE_OPTIONS = new Set([
  "--prefix",
  "--cwd",
  "-C",
  "--workspace",
  "-w",
  "--registry",
  "--userconfig",
  "--scope",
  "--otp",
  "--tag",
]);

/** The words of a publisher that are neither an option nor the value of one. */
function publisherWords(args: readonly string[]): string[] {
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (word === "workspace" || PUBLISHER_VALUE_OPTIONS.has(word)) {
      index += 1;
      continue;
    }
    if (isFlagWord(word)) continue;
    words.push(word.toLowerCase());
  }
  return words;
}

function isPublish({ program, args }: Command): boolean {
  // A dry run publishes nothing, as a dry clean cleans nothing. Only the package managers have that
  // flag; `gh` and `hub` have no release dry run and ignore it here.
  const dryRun = args.includes("--dry-run");
  if (program === "gh" || program === "hub") {
    const words = args.filter((word) => !isFlagWord(word)).map((word) => word.toLowerCase());
    const [sub, action] = words;
    if (sub === "release") return ["create", "delete", "upload"].includes(action ?? "");
    return sub === "pr" && action === "merge";
  }
  if (!PACKAGE_PUBLISHERS.has(program)) return false;
  if (dryRun) return false;
  const sub = publisherWords(args)[0];
  return sub === "publish" || sub === "unpublish";
}

/** A path as a pass keys it and as the patterns read it: one spelling, bounded. */
function normalizeTarget(text: string): string {
  return text.trim().replace(/\\/g, "/").slice(0, 256);
}

/** Redirects that write no file: a stream folded into another, or sent to the null device. */
const HARMLESS_REDIRECT_TARGETS = new Set(["/dev/null", "NUL", "$null"]);

/** The words a redirection writes. Only an unquoted mark redirects, so a message writes nothing. */
function redirectTargets(words: readonly Word[]): string[] {
  const targets: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word.quoted) continue;
    const mark = /^(?:\d|&)?>>?(.*)$/.exec(word.text);
    if (!mark) continue;
    const rest = mark[1]!;
    const target = rest === "" ? words[index + 1]?.text : rest;
    if (rest === "") index += 1;
    if (target === undefined || target.startsWith("&")) continue;
    if (HARMLESS_REDIRECT_TARGETS.has(target)) continue;
    targets.push(target);
  }
  return targets;
}

/**
 * Every path one command would write, at the positions a shell writes: a redirection's target, every
 * operand of `tee` and `sponge`, and the last operand of `cp` and `mv`. A path that only appears as a
 * source or an argument is not a write, so `git add .env` and `git commit -m "add .env"` are not held
 * for writing a credential.
 */
function writeTargetsOf(words: readonly Word[]): string[] {
  const targets = redirectTargets(words);
  let teeAt = -1;
  let copies = false;
  let lastOperand: string | undefined;
  for (let index = 0; index < words.length; index += 1) {
    const text = words[index]!.text;
    if (!isFlagWord(text)) lastOperand = text;
    const program = baseName(text);
    if ((program === "tee" || program === "sponge") && teeAt < 0) teeAt = index;
    else if (program === "cp" || program === "mv") copies = true;
  }
  if (teeAt >= 0)
    for (let index = teeAt + 1; index < words.length; index += 1) {
      const text = words[index]!.text;
      if (!isFlagWord(text)) targets.push(text);
    }
  if (copies && lastOperand !== undefined) targets.push(lastOperand);
  return targets;
}

/** Every path a call would write: an edit's own target, and what each of its commands writes. */
function writeTargets(facts: ToolCallFacts, commands: readonly Command[]): string[] {
  const targets: string[] = [];
  if (facts.kind === "edit" && facts.path !== undefined) targets.push(facts.path);
  if (facts.kind !== "command") return targets;
  for (const command of commands) targets.push(...writeTargetsOf(command.words));
  return targets;
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.env(?:\.[^/]*)?$/i,
  /(?:^|\/)\.netrc$/i,
  /(?:^|\/)\.git-credentials$/i,
  /(?:^|\/)\.ssh(?:[/]|$)/i,
  /(?:^|\/)\.aws\/credentials$/i,
  /(?:^|\/)\.docker\/config\.json$/i,
  /\.pem$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i,
];

const CI_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.github\/(?:workflows|actions)(?:\/|$)/i,
  /(?:^|\/)\.gitlab-ci\.ya?ml$/i,
  /(?:^|\/)\.circleci(?:\/|$)/i,
  /(?:^|\/)azure-pipelines\.ya?ml$/i,
  /(?:^|\/)bitbucket-pipelines\.ya?ml$/i,
  /(?:^|\/)jenkinsfile$/i,
  /(?:^|\/)\.travis\.ya?ml$/i,
  /(?:^|\/)appveyor\.ya?ml$/i,
];

const GIT_HOOK_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.git\/hooks(?:\/|$)/i,
  /(?:^|\/)\.husky(?:\/|$)/i,
  /(?:^|\/)lefthook\.ya?ml$/i,
  /(?:^|\/)\.pre-commit-config\.ya?ml$/i,
];

const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "uv.lock",
]);

function matchesAny(patterns: readonly RegExp[], target: string): boolean {
  return patterns.some((pattern) => pattern.test(normalizeTarget(target)));
}

function isNpmrc(target: string): boolean {
  return /(?:^|\/)\.npmrc$/i.test(normalizeTarget(target));
}

function isLockfile(target: string): boolean {
  return LOCKFILES.has(baseName(normalizeTarget(target)));
}

/** The extension's own configuration, sidecars, log and agent profiles: the policy's own files. */
function isPolicyFile(target: string): boolean {
  const name = baseName(normalizeTarget(target));
  if (
    name.startsWith("delegation-policy.") &&
    (name.endsWith(".json") ||
      name.endsWith(".jsonl") ||
      name === "delegation-policy.advisor-output")
  )
    return true;
  return /^pi-delegation-policy\..+\.md$/.test(name);
}

/** The words of one command that a shell would execute, leaving out the text of a message. */
function textWords(command: Command): string[] {
  const words: string[] = [];
  for (let index = 0; index < command.words.length; index += 1) {
    const word = command.words[index]!;
    // `-m`, `--message` and a short cluster ending in `m` (`-am`) take a message as their value.
    if (word.text === "-m" || word.text === "--message" || /^-[A-Za-z]*m$/.test(word.text)) {
      index += 1;
      continue;
    }
    if (/^--message=/.test(word.text) || /^-m./.test(word.text)) continue;
    words.push(word.text);
  }
  return words;
}

/** The subcommand of a `git` command, after its global options. */
function gitOf(args: readonly string[]): { sub: string; rest: string[] } {
  let index = 0;
  while (index < args.length) {
    const word = args[index]!;
    if (word === "-C" || word === "-c") {
      index += 2;
      continue;
    }
    if (word.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const sub = args[index];
  if (sub === undefined) return { sub: "", rest: [] };
  return { sub: sub.toLowerCase(), rest: args.slice(index + 1) };
}

/**
 * Skipping the hooks, decided on the git command itself and on the shell assignments in front of it.
 * A mention inside a message is text, not a command: a quoted flag is a flag, because the shell
 * removes the quotes, but the value of `-m` is a sentence.
 */
function skipsHooks(command: Command): boolean {
  if (command.program !== "git") return false;
  const prefix = command.words
    .slice(0, command.programIndex)
    .filter((word) => !word.quoted || ASSIGNMENT.test(word.text))
    .map((word) => word.text);
  if (prefix.some((word) => /^HUSKY=0$/.test(word) || /^HUSKY_SKIP_HOOKS=(?:1|true)$/i.test(word)))
    return true;
  const words = textWords(command);
  if (words.includes("--no-verify")) return true;
  const { sub } = gitOf(command.args);
  if (sub === "commit" && words.includes("-n")) return true;
  if (!words.some((word) => /^core\.hooksPath(?:=.*)?$/.test(word))) return false;
  // Naming the setting is not skipping the hooks: reading it back is how a hook is checked.
  return !words.some((word) =>
    ["--get", "--get-all", "--get-regexp", "-l", "--list"].includes(word),
  );
}

/** No commands: what an edit is judged by, since its families read the facts and not a line. */
const NO_COMMANDS: readonly Command[] = [];

function hardRule(facts: ToolCallFacts, commands: readonly Command[]): GuardMatch | undefined {
  for (const { program, args } of commands) {
    if (program === "git") {
      const { sub, rest } = gitOf(args);
      if (sub === "push" && isForcePush(rest))
        return { kind: "hard", code: "force-push", target: "git push" };
      if (sub === "reset" && rest.includes("--hard"))
        return { kind: "hard", code: "reset-hard", target: "git reset" };
      if (sub === "clean" && isForcedClean(rest))
        return { kind: "hard", code: "clean-force", target: "git clean" };
    }
    if (DELETE_PROGRAMS.has(program) && isRecursive(args)) {
      const target = args.find((word) => isDestructiveTarget(word));
      if (target !== undefined)
        return { kind: "hard", code: "recursive-delete", target: normalizeTarget(target) };
    }
  }
  if (isDownloadToShell(commands))
    return { kind: "hard", code: "download-to-shell", target: "shell" };
  for (const command of commands)
    if (isPublish(command)) return { kind: "hard", code: "publish", target: "registry" };
  const targets = writeTargets(facts, commands);
  const credential = targets.find((target) => matchesAny(CREDENTIAL_PATTERNS, target));
  if (credential !== undefined)
    return { kind: "hard", code: "credentials", target: normalizeTarget(credential) };
  for (const command of commands)
    if (skipsHooks(command)) return { kind: "hard", code: "skip-hooks", target: "git" };
  const policy = targets.find(isPolicyFile);
  if (policy !== undefined)
    return { kind: "hard", code: "policy-files", target: normalizeTarget(policy) };
  return undefined;
}

/** Packages an install command names, which are the names the model has just invented or chosen. */
function namedPackages(commands: readonly Command[]): string[] {
  const names: string[] = [];
  for (const { program, args } of commands) {
    if (!["npm", "yarn", "pnpm", "bun"].includes(program)) continue;
    const words = args.filter((word) => !isFlagWord(word));
    const sub = (words[0] ?? "").toLowerCase();
    if (!["install", "i", "add"].includes(sub)) continue;
    for (const word of words.slice(1)) {
      if (/^(?:\.|\/|~)/.test(word)) continue;
      if (/^(?:file|link|workspace|git|https?):/i.test(word)) continue;
      names.push(word.toLowerCase());
    }
  }
  return names;
}

/**
 * An opaque, bounded key for one command line: a pass covers that line, and not another line of the
 * same tool. Never the text, which the log and the refusal must not carry.
 */
function commandTarget(text: string): string {
  return `command:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

function softRule(facts: ToolCallFacts, commands: readonly Command[]): GuardMatch | undefined {
  if (facts.kind === "edit") {
    const path = normalizeTarget(facts.path ?? "");
    if (matchesAny(CI_PATTERNS, path)) return { kind: "soft", code: "ci-config", target: path };
    if (matchesAny(GIT_HOOK_PATTERNS, path))
      return { kind: "soft", code: "git-hooks", target: path };
    if (isNpmrc(path)) return { kind: "soft", code: "npmrc", target: path };
    if (isLockfile(path)) return { kind: "soft", code: "lockfile", target: path };
  }
  if (facts.kind !== "command") return undefined;
  const targets = writeTargets(facts, commands);
  const ci = targets.find((target) => matchesAny(CI_PATTERNS, target));
  if (ci !== undefined) return { kind: "soft", code: "ci-config", target: normalizeTarget(ci) };
  const hooks = targets.find((target) => matchesAny(GIT_HOOK_PATTERNS, target));
  if (hooks !== undefined)
    return { kind: "soft", code: "git-hooks", target: normalizeTarget(hooks) };
  const npmrc = targets.find(isNpmrc);
  if (npmrc !== undefined) return { kind: "soft", code: "npmrc", target: normalizeTarget(npmrc) };
  const packages = namedPackages(commands);
  if (packages.length > 0)
    return { kind: "soft", code: "new-package", target: packages.sort().join(" ").slice(0, 256) };
  return undefined;
}

/** The one refusal for a line this reader cannot judge, with a pass for that exact line only. */
function unreadableMatch(text: string, call = false): GuardMatch {
  return {
    kind: "soft",
    code: "long-command",
    target: commandTarget(text),
    unreadable: true,
    ...(call ? { noLine: true } : {}),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Trajectory rules
 * ---------------------------------------------------------------------------------------------- */

function trajectoryRule(
  facts: ToolCallFacts,
  toolName: string,
  history: GuardTrajectoryFacts,
): GuardMatch | undefined {
  if (facts.kind === "command" && history.failingRuns >= GUARD_FAILING_RUNS)
    return {
      kind: "trajectory",
      code: "failing-runs",
      target: facts.command === undefined ? toolName : commandTarget(facts.command),
    };
  if (facts.kind !== "edit" || facts.path === undefined) return undefined;
  const path = normalizeTarget(facts.path);
  if (history.previousEdits + 1 >= GUARD_REPEATED_EDITS && history.failuresBetweenEdits)
    return { kind: "trajectory", code: "repeated-edits", target: path };
  if (history.newFile && history.otherFiles + 1 >= GUARD_DISTINCT_FILES)
    return { kind: "trajectory", code: "new-files", target: path };
  return undefined;
}

/**
 * The one pure decision: which rule, if any, holds this call. A certain line is judged by the hard
 * rules, then the soft ones, then the trajectory; a line this reader cannot read is not judged at all
 * and gets the one refusal that says so. Everything decoded here comes from the facts the caller
 * classified, so the corpus is a table and two machines classify the same call the same way.
 */
export function guardRule(
  facts: ToolCallFacts,
  toolName: string,
  history: GuardTrajectoryFacts = NO_HISTORY,
): GuardMatch | undefined {
  // A shell call with no text at all — no `command` field, or an empty one — is opaque either way:
  // it cannot run anything here, and it is still not a line this reader can account for.
  if (facts.kind === "command") {
    const text = typeof facts.command === "string" ? facts.command : "";
    if (text.trim() === "") return unreadableMatch(`${toolName}:`, true);
  }
  if (!facts.changes) return undefined;
  if (facts.kind === "edit")
    return (
      hardRule(facts, NO_COMMANDS) ??
      softRule(facts, NO_COMMANDS) ??
      trajectoryRule(facts, toolName, history)
    );
  const command = facts.kind === "command" ? (facts.command ?? "") : "";
  if (command === "") return trajectoryRule(facts, toolName, history);
  // The cost guard: a line this long is not read at all, and it is held as too long to read rather
  // than judged, so the work a single call can cause stays bounded.
  if (Buffer.byteLength(command, "utf8") > GUARD_LONG_COMMAND_CHARS)
    return unreadableMatch(command);
  const reading = readLine(command);
  if (!reading.certain) return unreadableMatch(command);
  return (
    hardRule(facts, reading.commands) ??
    softRule(facts, reading.commands) ??
    trajectoryRule(facts, toolName, history)
  );
}

/* ------------------------------------------------------------------------------------------------
 * Task state
 * ---------------------------------------------------------------------------------------------- */

/** Refusals this task's rules produced, and the calls a pass let through. Content-free. */
export type GuardRuleReport = Readonly<{
  /** Refusals by code, in the order of `GUARD_RULE_CODES`; a code that never fired is absent. */
  ruleHits: Readonly<Partial<Record<GuardRuleCode, number>>>;
  /** Calls a consultation pass let through. */
  passes: number;
}>;

export type GuardDecision =
  | Readonly<{ action: "pass"; reason: "quiet" | "pass" | "unavailable" }>
  | Readonly<{ action: "block"; message: string }>;

/**
 * How many pairs one task remembers a pass for, so a long task cannot grow this without a bound. A
 * pair past the cap still refuses and is counted in `ruleHits`; only the pass after a consultation
 * is dropped, and only a task refused for that many distinct rule and target pairs can reach it.
 */
const MAX_BLOCKED_PAIRS = 16;
/** Edits one task remembers per target, for the trajectory rules. */
const MAX_TRACKED_TARGETS = 64;

type EditRecord = { count: number; failureBetween: boolean };

/** How many calls a consultation grants for a pair: one for a line it cannot read, a few otherwise. */
function passCalls(match: GuardMatch): number {
  return match.unreadable === true ? 1 : GUARD_PASS_CALLS;
}

/**
 * One task's rule state: what the trajectory rules read, which pairs a pass covers, and what the log
 * records. Nothing here reads a tool result, the user's words or the model's intent beyond what the
 * caller classified, and nothing here can lift a hard rule.
 */
export class GuardRules {
  private failingRuns = 0;
  private failureSinceLastEdit = false;
  private readonly edits = new Map<string, EditRecord>();
  private readonly passes = new Map<string, number>();
  private readonly blocked = new Map<string, GuardMatch>();
  private readonly hits = new Map<GuardRuleCode, number>();
  private passesSpent = 0;

  /** A new task starts with nothing seen: the previous task's trajectory and passes are gone. */
  openTask(): void {
    this.reset();
  }

  closeTask(): void {
    this.reset();
  }

  /**
   * One tool result that ran. Only results move the trajectory: a refused call never produces one,
   * so a hold can never be paid for by the call it refused.
   */
  noteResult(toolName: string, input: unknown, isError: boolean): void {
    const facts = classifyToolCall(toolName, input);
    // The rule counts executions in a row that failed, so a read that succeeds ends the run even
    // though it changed nothing.
    if (facts.kind === "command" && !isError) this.failingRuns = 0;
    // A read that reports a non-zero exit — `diff`, `grep -q`, `git diff --quiet` — is not a failing
    // run: it changed nothing, and this module never holds a read.
    if (!facts.changes) return;
    if (isError) this.failureSinceLastEdit = true;
    if (facts.kind === "command" && isError) this.failingRuns += 1;
    if (facts.kind !== "edit" || facts.path === undefined) return;
    const path = normalizeTarget(facts.path);
    const record = this.edits.get(path);
    if (record) {
      record.count += 1;
      record.failureBetween ||= this.failureSinceLastEdit;
    } else {
      this.edits.set(path, { count: 1, failureBetween: false });
      if (this.edits.size > MAX_TRACKED_TARGETS) {
        const oldest = this.edits.keys().next().value;
        if (oldest !== undefined) this.edits.delete(oldest);
      }
    }
    this.failureSinceLastEdit = false;
  }

  /**
   * A consultation that answered. It covers what the task already did, so the trajectory starts
   * over, and it opens a pass for every pair that refused a call since the last answer. It never
   * opens a hard rule, because nothing about an answered consultation changes who can allow that.
   */
  noteAnswer(): void {
    for (const [key, match] of this.blocked) {
      if (match.kind === "hard") continue;
      this.passes.set(key, passCalls(match));
    }
    this.blocked.clear();
    this.failingRuns = 0;
    this.failureSinceLastEdit = false;
    this.edits.clear();
  }

  /**
   * Decide one call: a rule hit is a refusal unless a pass for that same pair covers it.
   *
   * `available` says whether this configuration can consult at all. Without it a soft or a trajectory
   * refusal would have no way out, which is the one case the count gate refuses to hold for as well.
   * A hard rule does not depend on it: the way out of that one is the user. `wayOutBroken` is the
   * gate's own reading, and it appends the clause that sends the model to the person.
   */
  decide(
    facts: ToolCallFacts,
    toolName: string,
    options: {
      launcher: GateLauncher;
      manualContext?: boolean;
      available: boolean;
      wayOutBroken?: boolean;
    },
  ): GuardDecision {
    const match = guardRule(facts, toolName, this.historyFor(facts));
    if (!match) return { action: "pass", reason: "quiet" };
    if (match.kind !== "hard" && !options.available)
      return { action: "pass", reason: "unavailable" };
    if (match.kind !== "hard") {
      const key = pairKey(match);
      const remaining = this.passes.get(key) ?? 0;
      if (remaining > 0) {
        this.passes.set(key, remaining - 1);
        this.passesSpent += 1;
        return { action: "pass", reason: "pass" };
      }
    }
    this.hits.set(match.code, (this.hits.get(match.code) ?? 0) + 1);
    if (match.kind !== "hard" && this.blocked.size < MAX_BLOCKED_PAIRS)
      this.blocked.set(pairKey(match), match);
    return { action: "block", message: guardMessage(match, options) };
  }

  /**
   * The decision when reading a call threw. A rule that fails must never let the call run and must
   * never break the turn, and there is no exit here a model can open: the refusal says to report the
   * failure and stop, and the pair is never recorded, so no consultation pass can lift it.
   */
  failedDecision(options: {
    launcher: GateLauncher;
    manualContext?: boolean;
    available: boolean;
    wayOutBroken?: boolean;
  }): GuardDecision {
    this.hits.set("engine-failure", (this.hits.get("engine-failure") ?? 0) + 1);
    const lines = [
      `Not an error: this call was not run. Guard rule: ${GUARD_RULE_LABELS["engine-failure"]}.`,
      FAILED_AFTER,
    ];
    if (!options.available && options.wayOutBroken) lines.push(wayOutBrokenClause());
    return { action: "block", message: lines.join("\n") };
  }

  report(): GuardRuleReport {
    const ruleHits: Partial<Record<GuardRuleCode, number>> = {};
    for (const code of GUARD_RULE_CODES) {
      const count = this.hits.get(code);
      if (count !== undefined && count > 0) ruleHits[code] = count;
    }
    return { ruleHits, passes: this.passesSpent };
  }

  private historyFor(facts: ToolCallFacts): GuardTrajectoryFacts {
    const path =
      facts.kind === "edit" && facts.path !== undefined ? normalizeTarget(facts.path) : undefined;
    const record = path === undefined ? undefined : this.edits.get(path);
    let otherFiles = 0;
    for (const key of this.edits.keys()) if (key !== path) otherFiles += 1;
    return {
      failingRuns: this.failingRuns,
      previousEdits: record?.count ?? 0,
      failuresBetweenEdits: record?.failureBetween ?? false,
      otherFiles: Math.min(otherFiles, GUARD_DISTINCT_FILES),
      newFile: path !== undefined && record === undefined,
    };
  }

  private reset(): void {
    this.failingRuns = 0;
    this.failureSinceLastEdit = false;
    this.edits.clear();
    this.passes.clear();
    this.blocked.clear();
    this.hits.clear();
    this.passesSpent = 0;
  }
}

function pairKey(match: GuardMatch): string {
  return `${match.code}\u0000${match.target}`;
}

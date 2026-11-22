import { readFile } from "node:fs/promises";
import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import {
  atomicWrite,
  getGlobalConfigPath,
  isAbsentPathError,
  type ConfigDiagnostic,
} from "./config.ts";
import type { AdvisorLaunch } from "./types.ts";

/**
 * One short reminder, at most once per operative task, that a consultation may be useful here.
 *
 * The setting lives in its own versioned file because the schema-10 policy document rejects unknown
 * keys, and because it is a global behaviour of this extension rather than a session value. The
 * reminder itself is ephemeral: it is appended to one request's context and never stored.
 */
export const ADVISOR_REMINDER_MODES = ["off", "remind"] as const;
export type AdvisorReminderMode = (typeof ADVISOR_REMINDER_MODES)[number];
export const DEFAULT_ADVISOR_REMINDER_MODE: AdvisorReminderMode = "remind";
/** Custom message type of the reminder. The host keeps it on the request copy only. */
export const ADVISOR_REMINDER_TYPE = "pi-delegation-policy.advisor-reminder";
const SCHEMA_VERSION = 1;
const INVALID_MESSAGE =
  "Advisor reminder setting is invalid and was ignored; no reminder is added. Fix or remove delegation-policy.advisor-reminders.json.";

export function getAdvisorRemindersPath(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.advisor-reminders.json`;
}

export function parseAdvisorReminderMode(value: unknown): AdvisorReminderMode | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (!Object.keys(record).every((key) => key === "schemaVersion" || key === "mode"))
    return undefined;
  return ADVISOR_REMINDER_MODES.includes(record.mode as AdvisorReminderMode)
    ? (record.mode as AdvisorReminderMode)
    : undefined;
}

export type LoadedAdvisorReminder = {
  mode: AdvisorReminderMode;
  /** The file holds something this reader cannot parse, so the mode is suspended, not chosen. */
  invalid?: boolean;
  diagnostic?: ConfigDiagnostic;
};
/**
 * `unknown-state` means the file holds something this reader cannot parse, so it was left alone: an
 * unknown state is never silently replaced. `failed` means the replacement did not commit.
 */
export type AdvisorReminderSaveResult = "saved" | "unchanged" | "unknown-state" | "failed";
type PreviousMode =
  { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; mode: AdvisorReminderMode };

async function readPreviousMode(path: string): Promise<PreviousMode> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return isAbsentPathError(error) ? { kind: "absent" } : { kind: "invalid" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  const mode = parseAdvisorReminderMode(value);
  return mode ? { kind: "valid", mode } : { kind: "invalid" };
}

/**
 * Store the mode in its own file. The previous state is read first, so an unreadable or malformed
 * file is reported instead of overwritten. The replacement is the same temporary-file write the
 * global defaults use, so a failure leaves the previous file in place.
 */
export async function writeAdvisorReminderMode(
  mode: AdvisorReminderMode,
  path = getAdvisorRemindersPath(),
): Promise<AdvisorReminderSaveResult> {
  const previous = await readPreviousMode(path);
  if (previous.kind === "invalid") return "unknown-state";
  if (previous.kind === "valid" && previous.mode === mode) return "unchanged";
  try {
    await atomicWrite(
      path,
      `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, mode }, null, 2)}\n`,
    );
  } catch {
    return "failed";
  }
  return "saved";
}

/**
 * A missing file is the default. An unreadable or invalid one suspends only the reminder: it is
 * reported and ignored, and it never makes the delegation or Advisor axis invalid.
 */
export async function readAdvisorReminderMode(
  path = getAdvisorRemindersPath(),
): Promise<LoadedAdvisorReminder> {
  const invalid: LoadedAdvisorReminder = {
    mode: "off",
    invalid: true,
    diagnostic: { scope: "advisor-reminder", reportWhenOff: true, message: INVALID_MESSAGE },
  };
  try {
    const mode = parseAdvisorReminderMode(JSON.parse(await readFile(path, "utf8")));
    return mode ? { mode } : invalid;
  } catch (error) {
    return isAbsentPathError(error) ? { mode: DEFAULT_ADVISOR_REMINDER_MODE } : invalid;
  }
}

/**
 * The documented `pi-subagents` markers for a child process. A foreground child runs inside this
 * process and sets none, which the approved scope covers; `/fork` or `/clone` of a human session
 * sets neither, so a derived main session keeps the reminder.
 */
export function isSubagentChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_SUBAGENT_CHILD === "1" || Boolean(env.PI_SUBAGENT_RUNNER_PID);
}

/** Tools whose successful result counts as orientation for the first trigger. */
const ORIENTATION_TOOLS: ReadonlySet<string> = new Set(["read", "find", "grep", "ls"]);

export type ToolResultObservation = {
  toolName: string;
  isError: boolean;
  /** Only a builtin tool is orientation or a repeated failure; another source is ignored. */
  builtin: boolean;
};

/**
 * The launcher a reminder would point at, or undefined when this session has no active way to
 * consult: role launch needs the host subagent tool, tool launch needs `consult_advisor`. The list
 * is the host's active tools, so a disabled tool never counts.
 */
export function reminderConsultationPath(
  launch: AdvisorLaunch,
  activeTools: readonly string[],
): "role" | "tool" | undefined {
  const launcher = launch === "role" ? "subagent" : "consult_advisor";
  return activeTools.includes(launcher) ? launch : undefined;
}

export type AdvisorReminderMessage = ContextWithSystemEvent["messages"][number];

/** The strict level states the rule the checkpoint enforces, not a judgement of the task. */
export const ADVISOR_STRICT_RULE =
  "Hard rule for this session: your first edit, write or publishing command in a task must come after an Advisor consultation. This is a checkpoint, not a difficulty judgment.";

export function renderAdvisorReminder(strict = false): string {
  return [
    "<advisor_reminder>",
    "This reminder comes from the pi-delegation-policy extension, not from the user.",
    "If this task is not trivial or mechanical and a consultation is useful and permitted here, consult the Advisor before the next substantive step.",
    ...(strict ? [ADVISOR_STRICT_RULE] : []),
    "It adds no authority and revokes no instruction.",
    "</advisor_reminder>",
  ].join(" ");
}

export function createAdvisorReminder(timestamp: number, strict = false): AdvisorReminderMessage {
  return {
    role: "custom",
    customType: ADVISOR_REMINDER_TYPE,
    content: renderAdvisorReminder(strict),
    display: false,
    timestamp,
  };
}

/**
 * Ephemeral state of one operative task in one instance. It reads only public tool events: rounds
 * come from requests, a batch of results is one round, and nothing here interprets shell text,
 * stdout, the user's words or the model's intent.
 */
export class AdvisorReminderState {
  private open = false;
  private round = 0;
  private resultsSinceRequest = 0;
  private due = false;
  private suppressed = false;
  private presentedRound: number | undefined;
  /** Last round in which each builtin tool reported an error. */
  private readonly failedInRound = new Map<string, number>();

  get taskOpen(): boolean {
    return this.open;
  }

  /** A public interactive or RPC prompt opened a task; nothing earlier survives it. */
  openTask(): void {
    this.open = true;
    this.clear();
  }

  closeTask(): void {
    this.open = false;
    this.clear();
  }

  /**
   * Called once per request. A request that follows new tool results starts a new round; a retry of
   * the same request carries none and stays in its round, so its presentation is reused instead of
   * being rearmed.
   */
  beginRequest(): void {
    if (this.resultsSinceRequest === 0) return;
    this.round += 1;
    this.resultsSinceRequest = 0;
  }

  observeToolResult({ toolName, isError, builtin }: ToolResultObservation): void {
    if (!this.open) return;
    this.resultsSinceRequest += 1;
    if (!builtin) return;
    if (!isError) {
      if (ORIENTATION_TOOLS.has(toolName)) this.due = true;
      return;
    }
    // The same builtin tool failing in two different rounds is the second trigger. Two failures in
    // one round are one batch, not two rounds.
    const previous = this.failedInRound.get(toolName);
    if (previous !== undefined && previous !== this.round) this.due = true;
    this.failedInRound.set(toolName, this.round);
  }

  /**
   * An unambiguous consultation attempt ends the reminder for this task, whether it succeeds or
   * fails: a failed attempt is never promoted to a consultation, and the reminder must not invite a
   * retry.
   */
  noteConsultAttempt(): void {
    if (!this.open) return;
    this.suppressed = true;
    this.due = false;
  }

  /**
   * Drop a pending trigger and consume a presentation that was already sent. Turning the reminder
   * off, losing the consultation path or invalidating the configuration cancels the pending
   * reminder, and re-enabling it later in the same task never presents it again: the sent line is
   * spent for the rest of the task.
   */
  suspend(): void {
    this.due = false;
    // Rounds start at 0 and only grow, so -1 can never match a later round.
    if (this.presentedRound !== undefined) this.presentedRound = -1;
  }

  /**
   * The reminder for this request, or undefined. A retry of the request that already carried it
   * gets it again; the next round never re-arms it.
   */
  presentation(timestamp: number, strict = false): AdvisorReminderMessage | undefined {
    if (!this.open || this.suppressed) return undefined;
    if (this.presentedRound === this.round) return createAdvisorReminder(timestamp, strict);
    if (this.presentedRound !== undefined || !this.due) return undefined;
    this.due = false;
    this.presentedRound = this.round;
    return createAdvisorReminder(timestamp, strict);
  }

  private clear(): void {
    this.round = 0;
    this.resultsSinceRequest = 0;
    this.due = false;
    this.suppressed = false;
    this.presentedRound = undefined;
    this.failedInRound.clear();
  }
}

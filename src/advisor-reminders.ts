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

/** Results of one task after which `standard` states its note again. */
export const ADVISOR_CADENCE_RESULTS = 8;

/**
 * Which note this extension would present: the periodic one of `standard`, or the warning the gate
 * of `strict` and `guard` earns by crossing its threshold without a consultation.
 */
export type AdvisorNoteKind = "cadence" | "hold";

function wrapAdvisorNote(lines: readonly string[]): string {
  return ["<advisor_reminder>", ...lines, "</advisor_reminder>"].join(" ");
}

/** The periodic note: a reminder, never a rule, and it carries no threshold for a model to read. */
export function renderAdvisorNote(): string {
  return wrapAdvisorNote([
    "This reminder comes from the pi-delegation-policy extension, not from the user.",
    "This task has run many tool calls without a consultation. If a decision here could be wrong, consult the Advisor before the next substantive step.",
    "It adds no authority and revokes no instruction.",
  ]);
}

/**
 * The warning the gate earns: it states what happens next so the model can act before the changes
 * are held, and it names the consultation as the only way to keep changing state.
 */
export function renderAdvisorHoldWarning(): string {
  return wrapAdvisorNote([
    "This warning comes from the pi-delegation-policy extension, not from the user.",
    "This task has changed state several times without Advisor consultation. A consultation now covers the changes made so far; without one, the next changes are not run.",
    "It adds no authority and revokes no instruction.",
  ]);
}

export function createAdvisorNote(
  timestamp: number,
  kind: AdvisorNoteKind = "cadence",
): AdvisorReminderMessage {
  return {
    role: "custom",
    customType: ADVISOR_REMINDER_TYPE,
    content: kind === "hold" ? renderAdvisorHoldWarning() : renderAdvisorNote(),
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
  /** Results since the last note this level presented, for the periodic cadence. */
  private resultsSinceNote = 0;
  private armed: AdvisorNoteKind | undefined;
  private shown = 0;
  private suppressed = false;
  private presented: { round: number; kind: AdvisorNoteKind } | undefined;

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

  /**
   * One tool result. `standard` states its note every few results instead of at a guess about the
   * task's difficulty, so what is counted is what the host reports, never a judgement.
   */
  noteResult(cadence = true): void {
    if (!this.open) return;
    // Every level advances the round, so a note already presented is not repeated by the request
    // that follows new results; only `standard` counts those results towards its periodic note.
    this.resultsSinceRequest += 1;
    if (!cadence) return;
    this.resultsSinceNote += 1;
    if (this.resultsSinceNote < ADVISOR_CADENCE_RESULTS) return;
    // A warning the gate earned outranks the cadence: one note per request, never two. A task that
    // already tried to consult gets no periodic note.
    if (this.armed === undefined && !this.suppressed) this.armed = "cadence";
  }

  /** The gate crossed its threshold: the next request states the warning instead of the cadence. */
  armHoldWarning(): void {
    // A consultation attempt ends the periodic note, not this one: the warning is about changes
    // made since, and a task that consulted once can still cross the threshold again.
    if (!this.open) return;
    this.armed = "hold";
  }

  /** Notes this task was shown. A retry that carries the same note again is not another one. */
  get presentations(): number {
    return this.shown;
  }

  /**
   * An unambiguous consultation attempt ends the reminder for this task, whether it succeeds or
   * fails: a failed attempt is never promoted to a consultation, and the reminder must not invite a
   * retry.
   */
  noteConsultAttempt(): void {
    if (!this.open) return;
    this.suppressed = true;
    if (this.armed === "cadence") this.armed = undefined;
  }

  /**
   * Drop a pending trigger and consume a presentation that was already sent. Turning the reminder
   * off, losing the consultation path or invalidating the configuration cancels the pending
   * reminder, and re-enabling it later in the same task never presents it again: the sent line is
   * spent for the rest of the task.
   */
  suspend(): void {
    this.armed = undefined;
    // Rounds start at 0 and only grow, so -1 can never match a later round.
    if (this.presented) this.presented = { round: -1, kind: this.presented.kind };
  }

  /**
   * The note for this request, or undefined. A retry of the request that already carried it gets it
   * again; the next round never re-arms it. One presentation per round, and never more than one in
   * one request.
   */
  presentation(timestamp: number): AdvisorReminderMessage | undefined {
    if (!this.open) return undefined;
    if (this.presented?.round === this.round) {
      if (this.suppressed && this.presented.kind === "cadence") return undefined;
      return createAdvisorNote(timestamp, this.presented.kind);
    }
    if (this.armed === undefined) return undefined;
    const kind = this.armed;
    this.armed = undefined;
    this.presented = { round: this.round, kind };
    this.shown += 1;
    if (kind === "cadence") this.resultsSinceNote = 0;
    return createAdvisorNote(timestamp, kind);
  }

  private clear(): void {
    this.shown = 0;
    this.round = 0;
    this.resultsSinceRequest = 0;
    this.resultsSinceNote = 0;
    this.armed = undefined;
    this.suppressed = false;
    this.presented = undefined;
  }
}

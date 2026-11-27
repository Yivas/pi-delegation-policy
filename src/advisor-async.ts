/**
 * Background Advisor consultations: the run a launch hands back, and the completion that answers it.
 *
 * A launch in the background returns a run id and nothing else, so the checkpoint cannot open on that
 * call. The host reports the end of the run separately, on the event it advertises, and this module
 * decides what that report proves. It reads only host-produced fields: the run id this task handed
 * the host, the identity of the session, the terminal state, and the per-child profile and model the
 * host recorded. Nothing here parses text, and nothing here trusts a name the agent typed.
 *
 * The consequence of each verdict is the caller's: this module holds no gate. `answered` is the one
 * value that can lift a hold; `failed` is the positive evidence that an Advisor started and did not
 * answer; `ignored` proves nothing and leaves everything where it was, which is the closed direction.
 */

import { THINKING_LEVEL_NAMES } from "./types.ts";

/** The profile and model one Advisor slot resolves to, which is what the host records per child. */
export type AdvisorSlotIdentity = Readonly<{ agent: string; model: string }>;

export type AdvisorCompletion = "answered" | "failed" | "ignored";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A host id, read as a bounded token this module is willing to compare, never as text. */
function hostId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

/** The run a report is about: the host writes `runId`, and an older shape only its `id`. */
export function completionRunId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return hostId(payload["runId"]) ?? hostId(payload["id"]);
}

/** The call the report says launched the run, when it says it at all. */
export function completionToolCallId(payload: unknown): string | undefined {
  return isRecord(payload) ? hostId(payload["toolCallId"]) : undefined;
}

/** One child row of a completion, reduced to the fields a verdict reads. */
type ChildRow = Readonly<{
  agent: string;
  model: string;
  output: string;
  outputState?: string;
  aborted: boolean;
}>;

function childRow(value: unknown): ChildRow | undefined {
  if (!isRecord(value)) return undefined;
  const agent = typeof value["agent"] === "string" ? value["agent"] : "";
  // Only the model the host resolved identifies a slot. `requestedModel` is what the launch asked
  // for, which is text the agent wrote, so it is never read as identity.
  const model = typeof value["model"] === "string" ? value["model"] : "";
  if (agent === "" || model === "") return undefined;
  return {
    agent,
    model,
    output: typeof value["output"] === "string" ? value["output"] : "",
    outputState: typeof value["outputState"] === "string" ? value["outputState"] : undefined,
    aborted:
      (typeof value["error"] === "string" && value["error"] !== "") ||
      value["stopped"] === true ||
      value["interrupted"] === true ||
      value["timedOut"] === true ||
      value["outputPartial"] === true,
  };
}

/** Whether one child row is an answer: text present, nothing partial, nothing aborted. */
function isAnswer(row: ChildRow): boolean {
  if (row.aborted) return false;
  // `absent` is the host saying it has no text, which is not an answer whatever else the row says.
  if (row.outputState === "absent") return false;
  return row.output.trim() !== "";
}

/**
 * The host appends the thinking level it ran to the model it reports, and only a level this product
 * knows is that suffix: anything else is part of the id, exactly as the launch check reads it.
 */
function isSlotModel(configured: string, reported: string): boolean {
  if (reported === configured) return true;
  if (!reported.startsWith(`${configured}:`)) return false;
  const level = reported.slice(configured.length + 1);
  return (THINKING_LEVEL_NAMES as readonly string[]).includes(level);
}

/**
 * What one completion report proves about the Advisor slots a consultation named.
 *
 * It has to be a report of this session, and it has to be a run that ended complete and was not
 * stopped, timed out or cut short, with at least one child row carrying the profile and the model of
 * a configured Advisor slot and text of its own. A run that only answered through another profile
 * proves nothing about an Advisor, and a run of an Advisor that did not answer is a failure. The
 * report has to name this session; one that names another session, or none at all, is not this
 * session's answer.
 */
export function readAdvisorCompletion(
  payload: unknown,
  expected: Readonly<{ sessions: readonly string[]; slots: readonly AdvisorSlotIdentity[] }>,
): AdvisorCompletion {
  if (!isRecord(payload) || completionRunId(payload) === undefined) return "ignored";
  const sessionId = payload["sessionId"];
  if (typeof sessionId !== "string" || !expected.sessions.includes(sessionId)) return "ignored";
  const results: readonly unknown[] = Array.isArray(payload["results"]) ? payload["results"] : [];
  const rows = results
    .map(childRow)
    .filter((row): row is ChildRow => row !== undefined)
    .filter((row) =>
      expected.slots.some((slot) => slot.agent === row.agent && isSlotModel(slot.model, row.model)),
    );
  if (rows.length === 0) return "ignored";
  if (payload["state"] !== "complete" || payload["success"] !== true) return "failed";
  if (
    payload["stopped"] === true ||
    payload["timedOut"] === true ||
    payload["outputPartial"] === true
  )
    return "failed";
  return rows.some(isAnswer) ? "answered" : "failed";
}

/** One background consultation this task launched, as its launch result reported it. */
type LaunchedRun = Readonly<{
  toolCallId: string | undefined;
  slots: readonly AdvisorSlotIdentity[];
}>;

/**
 * The background consultations of one task: the runs the host handed back, and the reports already
 * acted on. It is created and dropped with the task, so a report that arrives later can never lift a
 * hold it does not belong to, and the first decision a run gets is its only one.
 */
export class BackgroundConsultations {
  private sessions: readonly string[] = [];
  private readonly runs = new Map<string, LaunchedRun>();
  private readonly decided = new Set<string>();

  /** A session starts with no runs: nothing from the session before can answer in this one. */
  startSession(sessions: readonly string[]): void {
    this.sessions = [...sessions];
    this.closeTask();
  }

  /** A new task is a new conversation with the host: the previous runs answer nothing here. */
  openTask(): void {
    this.runs.clear();
    this.decided.clear();
  }

  closeTask(): void {
    this.runs.clear();
    this.decided.clear();
  }

  /**
   * A launch the host accepted: the run id it allocated, the call that launched it and the profiles
   * this configuration can answer from.
   */
  noteLaunch(
    runId: string,
    toolCallId: string | undefined,
    slots: readonly AdvisorSlotIdentity[],
  ): void {
    if (this.runs.has(runId) || this.decided.has(runId)) return;
    this.runs.set(runId, { toolCallId, slots: [...slots] });
  }

  /**
   * Decide one report. A run this task did not launch, a call other than the one that launched it and
   * a report that proves nothing are all `ignored`, and a report decides a run once.
   */
  noteCompletion(payload: unknown): AdvisorCompletion {
    const runId = completionRunId(payload);
    if (runId === undefined) return "ignored";
    const run = this.runs.get(runId);
    if (run === undefined || this.decided.has(runId)) return "ignored";
    const toolCallId = completionToolCallId(payload);
    if (toolCallId !== undefined && run.toolCallId !== undefined && toolCallId !== run.toolCallId)
      return "ignored";
    const outcome = readAdvisorCompletion(payload, { sessions: this.sessions, slots: run.slots });
    // A report that proves nothing decides nothing: the run stays waiting for a better one.
    if (outcome === "ignored") return "ignored";
    this.decided.add(runId);
    return outcome;
  }
}

/**
 * The gate the `strict` and `guard` levels share: once a task has changed state enough times with no
 * Advisor consultation, every further change is refused until a consultation answers.
 *
 * The previous checkpoint refused exactly once per task and offered a second way out, "repeat this
 * call and it will run", so a small model simply repeated it: two refusals out of two were resolved
 * that way. This gate has one way out. A refusal names the consultation, and nothing else.
 *
 * What counts is a change the gate let through, never a refused one, and never a read. A refused
 * call changed nothing, so counting it would let a model burn the budget by asking. A consultation
 * that answers resets the count; the model is not asked again for work it already covered.
 *
 * It is a pure state machine with no imports. Nothing here reads a tool result, the user's words or
 * the model's intent: only the classified calls the caller passes in.
 */
/** Changes without a consultation after which the task is warned once. */
export const GATE_WARN_CHANGES = 3;
/** The change that closes the gate: the task may not reach this many without a consultation. */
export const GATE_HOLD_CHANGES = 6;
/** Failed consultations in a row after which the operator is told the task cannot move. */
export const GATE_CONSULT_FAILURES = 2;

export type GateLauncher = "role" | "tool";

export type GatePassReason =
  /** Nothing to watch, or this call does not change state. */
  | "quiet"
  /** Below the hold: the change runs and is counted. */
  | "counted"
  /** No consultation is possible here, so nothing is held. */
  | "unavailable";

export type GateDecision =
  | Readonly<{ action: "pass"; reason: GatePassReason }>
  | Readonly<{ action: "block"; message: string }>;

export type GateReport = Readonly<{
  /** Changes counted since the last answered consultation. */
  changes: number;
  /** Every change the gate counted in this task. Changes that ran while no consultation was possible are not in it. */
  totalChanges: number;
  /** Refused changes. */
  holds: number;
  /** Consultations that answered. */
  answers: number;
  /** Consultations that returned an error or no text; they never open the gate. */
  failures: number;
}>;

const PREFIX = [
  "Not an error: this call was not run. Advisor checkpoint.",
  "The checkpoint holds every change in this task until an Advisor consultation answers. Reading is not affected.",
];
/** The one way out. It says what to do after consulting, and offers nothing else. */
const CONSULT_NOW = "Consult the Advisors now: ";
const AFTER = "After the consultation answers, make this change again.";

/**
 * The path each launch mode has. Tool launch depends on who writes the brief, because a call with no
 * question is refused when the agent writes it. Role launch states the foreground requirement as
 * this checkpoint's own: the policy asks for background launches, and one cannot answer in time.
 */
const CONSULT_PATH = {
  tool: "call consult_advisor(). It needs no arguments; the host supplies the context.",
  toolManual:
    "call consult_advisor with a question, and with a brief if this is the first consultation of the task.",
  role: "launch every listed Advisor with the host subagent tool, with the agent profile and model the delegation policy lists and a short self-contained brief. For this checkpoint the launch must be in the foreground (async: false), whatever the policy says about background launches.",
} as const;

/**
 * What a consultation result proves. `unrecognized` is a result whose shape this reader does not
 * know: it opens nothing, and it is reported apart from a failure because retrying cannot fix it.
 */
export type ConsultationOutcome = "answered" | "failed" | "unrecognized";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a consultation result for a positive sign that an Advisor answered. The host marks a result
 * as an error only when the tool throws, and both launchers return text when they fail, so neither
 * the error flag nor the presence of text proves an answer: the tool's own details do.
 *
 * `tool`: the details this extension writes, with one slot per Advisor. `role`: the details of the
 * host's subagent tool, one result per child, all of them Advisors because only an Advisor-only
 * launch is read here. One Advisor that answered is enough in both.
 */
export function consultationOutcome(
  launcher: GateLauncher,
  result: { isError: boolean; details: unknown },
): ConsultationOutcome {
  if (result.isError) return "failed";
  if (!isRecord(result.details)) return "unrecognized";
  if (launcher === "tool") {
    const consultation = result.details.advisorConsultation;
    // This extension is the only writer of these details, and it writes none when the call
    // consulted nobody: a blank question, a busy executor, an Advisor that is off.
    if (consultation === undefined) return "failed";
    if (!isRecord(consultation) || !Array.isArray(consultation.slots)) return "unrecognized";
    return consultation.slots.some((slot) => isRecord(slot) && slot.status === "complete")
      ? "answered"
      : "failed";
  }
  const results = result.details.results;
  if (!Array.isArray(results) || !results.every(isRecord)) return "unrecognized";
  if (results.some((child) => typeof child.exitCode !== "number")) return "unrecognized";
  return results.some(childAnswered) ? "answered" : "failed";
}

/** A child answered when it ended cleanly, was not cut short, and left output of its own. */
function childAnswered(child: Record<string, unknown>): boolean {
  if (child.exitCode !== 0 || child.error) return false;
  if (child.detached || child.interrupted || child.timedOut || child.stopped) return false;
  if (child.outputPartial) return false;
  return typeof child.finalOutput === "string" && child.finalOutput.trim() !== "";
}

/** `manualContext` is true when the agent, not the host, writes the consultation brief. */
export function gateMessage(launcher: GateLauncher, manualContext = false): string {
  const toolPath = manualContext ? CONSULT_PATH.toolManual : CONSULT_PATH.tool;
  const path = launcher === "role" ? CONSULT_PATH.role : toolPath;
  return [...PREFIX, `${CONSULT_NOW}${path}`, AFTER].join("\n");
}

/**
 * State of one task. A new task starts with nothing counted: the previous task's consultation
 * covers nothing here.
 */
export class AdvisorGate {
  private open = false;
  private changes = 0;
  private totalChanges = 0;
  private holds = 0;
  private answers = 0;
  private failures = 0;
  private failuresInRow = 0;
  private unrecognized = false;
  private forced = false;
  private countsAfterAnswer = true;
  private warned = false;

  /**
   * `held` starts the task with the gate already closed: the user asked for a consultation before
   * the first change, so nothing is counted up to it. `countsAfterAnswer` is the level's own answer:
   * only the levels that hold by count keep counting once that consultation arrives, and a `??`
   * task at any other level is free after it.
   */
  openTask(held = false, countsAfterAnswer = true): void {
    this.closeTask();
    this.open = true;
    // Kept apart from the count: nothing changed yet, so the report and the warning stay at zero.
    this.forced = held;
    this.countsAfterAnswer = countsAfterAnswer;
  }

  /** True while a task is being watched, which is what makes a level hold anything. */
  get watching(): boolean {
    return this.open;
  }

  /** The report of what this task did, or undefined when the gate never watched it. */
  closeTask(): GateReport | undefined {
    if (!this.open) return undefined;
    const report: GateReport = {
      changes: this.changes,
      totalChanges: this.totalChanges,
      holds: this.holds,
      answers: this.answers,
      failures: this.failures,
    };
    this.open = false;
    this.changes = 0;
    this.totalChanges = 0;
    this.holds = 0;
    this.answers = 0;
    this.failures = 0;
    this.failuresInRow = 0;
    this.unrecognized = false;
    this.forced = false;
    this.countsAfterAnswer = true;
    this.warned = false;
    return report;
  }

  /**
   * Decide one call. `available` is the host's and the configuration's answer at this instant, never
   * a value remembered from the start of the task: losing the consultation path must release the
   * task instead of freezing it.
   */
  decide(input: {
    changes: boolean;
    available: boolean;
    launcher: GateLauncher;
    manualContext?: boolean;
  }): GateDecision {
    if (!this.open || !input.changes) return { action: "pass", reason: "quiet" };
    // A `??` task at a level that holds nothing by count is free once its consultation arrived.
    if (!this.countsAfterAnswer && !this.forced) return { action: "pass", reason: "quiet" };
    // Nothing to hold when nothing can be consulted: this is the one case where the level refuses
    // nothing at all, because a hold would leave no way out.
    if (!input.available) return { action: "pass", reason: "unavailable" };
    if (this.held) {
      this.holds += 1;
      return { action: "block", message: gateMessage(input.launcher, input.manualContext) };
    }
    this.changes += 1;
    this.totalChanges += 1;
    return { action: "pass", reason: "counted" };
  }

  /**
   * A consultation that answered covers the changes made so far. Only while a task is open: a
   * consultation made after the task closed must not leave the next task covered.
   */
  noteAnswer(): void {
    if (!this.open) return;
    this.answers += 1;
    this.forced = false;
    this.changes = 0;
    this.failuresInRow = 0;
    this.warned = false;
  }

  /**
   * A consultation that did not answer never opens the gate: only an answer does. Repeated failures
   * mean the way out may not exist, and that is the operator's call, not the model's, so this
   * returns true exactly once per run of failures for the caller to tell the operator.
   */
  noteFailure(): boolean {
    if (!this.open) return false;
    this.failures += 1;
    this.failuresInRow += 1;
    return this.failuresInRow === GATE_CONSULT_FAILURES;
  }

  /**
   * A result this reader cannot interpret opens nothing and counts as a failure for the report.
   * True the first time in a task, so the operator is told once.
   */
  noteUnrecognized(): boolean {
    if (!this.open) return false;
    this.failures += 1;
    // It ends a run of ordinary failures, so one task is not warned twice for the same stretch.
    this.failuresInRow = 0;
    if (this.unrecognized) return false;
    this.unrecognized = true;
    return true;
  }

  /**
   * True once per run of changes, when the task has crossed the warning without a consultation
   * since the last answered one. It is read by the
   * caller that renders the ephemeral note, so one warning is presented and never repeated.
   */
  warnDue(): boolean {
    // A task with nothing to count earns no warning about changes made.
    if (!this.open || this.warned || !this.countsAfterAnswer) return false;
    if (this.changes < GATE_WARN_CHANGES) return false;
    this.warned = true;
    return true;
  }

  get held(): boolean {
    if (!this.open) return false;
    return this.forced || this.changes + 1 >= GATE_HOLD_CHANGES;
  }
}

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
 * There is no automatic release. An earlier version released a window of changes when a run of
 * consultations failed, on the theory that a hold with no working way out is worse than no hold.
 * Every version of that release was defeated by the model it was meant for: each one was a release
 * the model could compute, so the model computed it, most cheaply by launching the host subagent
 * tool with an exact Advisor profile and a one-millisecond timeout. A release the model can forge
 * is not a way out. So the hold ends only with an answered consultation, or with the operator, who
 * can change the level or cancel the task. A run of failures now changes only what the model and
 * the operator are told, and the control tools stay open so a held task can still reach a person.
 *
 * That report is fail-closed: it needs positive evidence that an Advisor started and did not
 * answer, and a non-empty list of slots is not that evidence, because a call can be given one slot
 * and no brief. The writer states it per slot, in `dispatched`, at the one point where the host run
 * is issued. A call that consulted nobody counts nothing at all, no failure and no report, so the
 * hold it leaves stands and the human channel can still resolve it. A result this reader cannot
 * interpret is one more call that proved nothing: `not-run`, which keeps the hold.
 *
 * It is a pure state machine with no imports. Nothing here reads a tool result, the user's words or
 * the model's intent: only the classified calls the caller passes in.
 */
/** Changes without a consultation after which the task is warned once. */
export const GATE_WARN_CHANGES = 3;
/** The change that closes the gate: the task may not reach this many without a consultation. */
export const GATE_HOLD_CHANGES = 6;
/**
 * Consultations that proved a launch and failed, in a row, after which the gate says the way out
 * looks broken: the operator is told once and the refusal tells the model to reach a person instead
 * of retrying. Neither of them passes a change.
 */
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
  /**
   * Every change the gate counted in this task. Changes that ran while no consultation was possible
   * at all are not in it.
   */
  totalChanges: number;
  /** Refused changes. */
  holds: number;
  /** Consultations that answered. */
  answers: number;
  /** Consultations that proved an Advisor started and did not answer; they never open the gate. */
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
 * What a consultation result proves.
 *
 * `answered` is the one thing that opens the gate. `failed` needs positive evidence that an Advisor
 * started and did not answer, and it is the only outcome that counts toward the report the operator
 * gets; it never opens the gate. `not-run` is everything else: a call that consulted nobody, a launch
 * with no child, a slot that never dispatched, a shape this reader does not know. It counts nothing
 * and leaves the hold where it was.
 */
export type ConsultationOutcome = "answered" | "failed" | "not-run";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a consultation result for positive evidence that an Advisor started. The host marks a result
 * as an error only when the tool throws, and both launchers return text when they fail, so neither
 * the error flag nor the presence of text proves anything: only the details do. A result whose
 * details prove no Advisor started is `not-run`, which counts nothing, so an early exit that forgets
 * to say so costs a hold instead of buying a way out of it.
 *
 * `tool`: the details this extension writes, with one slot per Advisor. `role`: the details of the
 * host's subagent tool, one result per child, all of them Advisors because only an Advisor-only
 * launch is read here. One Advisor that answered is enough in both, and the error flag wins over an
 * answer: a result the host reports as an error proves nothing about the Advisor itself.
 */
export function consultationOutcome(
  launcher: GateLauncher,
  result: { isError: boolean; details: unknown },
): ConsultationOutcome {
  return launcher === "tool" ? toolOutcome(result) : roleOutcome(result);
}

/**
 * This extension is the only writer of these details: one slot per Advisor, and one `dispatched` flag
 * on every slot whose host run was issued. A non-empty list of slots is not proof of a launch, because
 * a first turn with no brief is given its slot and stops before the launch. A record whose `slots` is
 * present but is not a list is a shape this version does not know; anything else without a non-empty
 * list of slots consulted nobody.
 */
function toolOutcome(result: { isError: boolean; details: unknown }): ConsultationOutcome {
  const consultation = isRecord(result.details) ? result.details.advisorConsultation : undefined;
  if (!isRecord(consultation)) return "not-run";
  const slots = consultation.slots;
  if (!Array.isArray(slots) || slots.length === 0) return "not-run";
  // A completed slot is an answer, and the error flag still wins over it: a result the host reports as
  // an error proves nothing about the Advisor itself.
  if (slots.some((slot) => isRecord(slot) && slot.status === "complete"))
    return result.isError ? "failed" : "answered";
  const dispatched = slots.some((slot) => isRecord(slot) && slot.dispatched === true);
  return dispatched ? "failed" : "not-run";
}

/**
 * The host reports one result per child it started, so a non-empty list of them is proof that children
 * ran, whatever happened to them: a numeric exit code, a signal, a timeout, a partial output. Without
 * such a list the launch never happened here, so the result is `not-run` rather than a failure.
 */
function roleOutcome(result: { isError: boolean; details: unknown }): ConsultationOutcome {
  const results = isRecord(result.details) ? result.details.results : undefined;
  if (!Array.isArray(results)) return "not-run";
  const children = results.filter(isRecord);
  if (children.length === 0) return "not-run";
  if (result.isError) return "failed";
  return children.some(childAnswered) ? "answered" : "failed";
}

/** A child answered when it ended cleanly, was not cut short, and left output of its own. */
function childAnswered(child: Record<string, unknown>): boolean {
  if (child.exitCode !== 0 || child.error) return false;
  if (child.detached || child.interrupted || child.timedOut || child.stopped) return false;
  if (child.outputPartial) return false;
  return typeof child.finalOutput === "string" && child.finalOutput.trim() !== "";
}

/** The slot statuses this version writes, and the only ones a notice may repeat. */
const SLOT_STATUSES: ReadonlySet<string> = new Set(["complete", "unavailable", "blocked"]);

/**
 * What a run of failures said about itself, for the operator's notice: the closed statuses its slots
 * stated, de-duplicated and in the order they were written.
 *
 * Only values this version knows are repeated, so no host, provider or model text can reach a
 * notification through this function, and a status it does not know is left out rather than echoed.
 * A `role` launch reports children, not statuses, so it says nothing here.
 */
export function failureEvidence(launcher: GateLauncher, details: unknown): readonly string[] {
  if (launcher !== "tool") return [];
  const consultation = isRecord(details) ? details.advisorConsultation : undefined;
  const slots = isRecord(consultation) ? consultation.slots : undefined;
  if (!Array.isArray(slots)) return [];
  const seen = new Set<string>();
  for (const slot of slots)
    if (isRecord(slot) && typeof slot.status === "string" && SLOT_STATUSES.has(slot.status))
      seen.add(slot.status);
  return [...seen];
}

/** The words a run of failures takes when it is written out, so no text states the count by hand. */
const RUN_WORDS = ["Several", "One", "Two", "Three", "Four", "Five", "Six"] as const;

/**
 * The clause that names the run of failures, in words. The refusal derives it from
 * `GATE_CONSULT_FAILURES`, so changing that constant moves the text with it instead of leaving a
 * number behind, and the clause stays free of digits, which is what the refusal must offer: no
 * count a model could compute. A count this table does not name reads as `Several`.
 */
export function failureRunClause(count: number = GATE_CONSULT_FAILURES): string {
  const word = RUN_WORDS[count] ?? "Several";
  return `${word} consultation${count === 1 ? " has" : "s have"} not answered`;
}

/**
 * What the refusal adds once a run of failures proved the way out is not working. The hold is
 * unchanged, so the only thing left for the model to do is reach the person who can end it.
 */
const WAY_OUT_BROKEN = `${failureRunClause()}, so ask the user and stop rather than calling this again.`;

/**
 * `manualContext` is true when the agent, not the host, writes the consultation brief.
 * `wayOutBroken` appends the one clause that tells the model the hold now needs a person; without it
 * the text is byte-identical to the refusal this gate has always sent.
 */
export function gateMessage(
  launcher: GateLauncher,
  manualContext = false,
  wayOutBroken = false,
): string {
  const toolPath = manualContext ? CONSULT_PATH.toolManual : CONSULT_PATH.tool;
  const path = launcher === "role" ? CONSULT_PATH.role : toolPath;
  const message = [...PREFIX, `${CONSULT_NOW}${path}`, AFTER];
  if (wayOutBroken) message.push(WAY_OUT_BROKEN);
  return message.join("\n");
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
  /**
   * True once a run of consultations failed: it records only that the way out looks broken, which
   * changes the message the model gets and the notice the operator gets. It never passes a change.
   */
  private wayOutBroken = false;
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
    this.wayOutBroken = false;
    this.forced = false;
    this.countsAfterAnswer = true;
    this.warned = false;
    return report;
  }

  /**
   * Decide one call. `available` says whether this configuration has a consultation path at all, and
   * the caller reads it per call rather than once at the start of the task: losing the path must
   * release the task instead of freezing it. A transient busy executor is not an absent path, so it
   * is never reported here as one: the host runs the calls of one message in parallel, and a model
   * that consults and edits in the same message would otherwise change state through the hold.
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
      return {
        action: "block",
        message: gateMessage(input.launcher, input.manualContext, this.wayOutBroken),
      };
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
    this.wayOutBroken = false;
    this.changes = 0;
    this.failuresInRow = 0;
    this.warned = false;
  }

  /**
   * A consultation that an Advisor started and never answered opens nothing: only an answer does.
   * The caller must come here only with that positive evidence, never with the absence of an answer,
   * and never with a slot list alone. Repeated failures mean the way out may not exist, and that is
   * the operator's call, not the model's: this returns true for the caller to tell them, once per
   * pair, and leaves the hold exactly where it was. The run starts over so a later pair is reported
   * again, and nothing else about the task moves: the count of changes and the warning stay put.
   */
  noteFailure(): boolean {
    if (!this.open) return false;
    this.failures += 1;
    this.failuresInRow += 1;
    if (this.failuresInRow < GATE_CONSULT_FAILURES) return false;
    this.failuresInRow = 0;
    this.wayOutBroken = true;
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

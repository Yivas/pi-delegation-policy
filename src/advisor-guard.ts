/**
 * The `guard` level: a task that changed state is not finished until an Advisor has been consulted
 * about it.
 *
 * `strict` refuses the first state-changing tool call of a task, and the refusal itself carries a way
 * out that does not consult: repeat the call. The host offers one later boundary — `agent_before_settle`,
 * which may append an entry and ask for one more request — and that is the only point where "this task
 * may not close yet" can be enforced instead of advised. Nothing here refuses a tool call.
 *
 * The level watches every state-changing call, not only the first, but a consultation is not needed
 * once forever: it covers the next few changes and then expires, so consulting at the first step does
 * not licence the twenty that follow. Pure state machine: availability, the launcher and the decision
 * are all passed in, so the behaviour is the same in the host, in tests and on a machine whose clock
 * is wrong.
 */
export const GUARD_COVERAGE_CHANGES = 5;
/** Two interruptions at most per task: the second only when the task changed state again. */
export const GUARD_CLOSE_BLOCKS = 2;

/**
 * Custom message type of the interruption. The host commits it to the session once per interruption,
 * so the instruction stays in the transcript and later tasks see it in their history.
 */
export const GUARD_INSTRUCTION_TYPE = "pi-delegation-policy.guard";

export type GuardLauncher = "role" | "tool";

export type GuardPass =
  /** The task changed nothing, or nothing is being watched. */
  | "clean"
  /** A consultation still covers the changes made since it. */
  | "covered"
  /** No Advisor can be consulted right now, so nothing is interrupted. */
  | "unavailable"
  /** The interruptions for this task are used up, or nothing changed since the last one. */
  | "spent";

export type GuardDecision =
  | Readonly<{ action: "pass"; reason: GuardPass }>
  | Readonly<{ action: "block"; instruction: string; block: number }>;

export type GuardReport = Readonly<{
  changes: number;
  consulted: boolean;
  blocks: number;
}>;

const PREFIX = [
  "Not an error: this task is not finished yet. Advisor guard.",
  // The host converts a custom message to user text and drops its metadata, and this entry stays in
  // the transcript: without this line the model reads the instruction as something the user wrote.
  "This interruption comes from the pi-delegation-policy extension, not from the user.",
  "This task changed state and no Advisor consultation covers those changes.",
];
const WAY_TO_CONSULT: Record<GuardLauncher, string> = {
  tool: "1. If there is a decision here you could get wrong (approach, root cause, scope, an irreversible step): call consult_advisor() now. It needs no arguments; the host supplies the context.",
  role: "1. If there is a decision here you could get wrong (approach, root cause, scope, an irreversible step): consult the Advisors now, exactly as the Roles section of the delegation policy describes, with a short self-contained brief.",
};
/**
 * The way out of the first interruption says what the second one costs, and the last one says it is
 * the last: the operator should be able to read the promise off the text and hold it.
 */
const FINISH_FIRST =
  "2. If no consultation applies here: finish again and the task closes. Changing state again without a consultation first earns one more interruption, and then no more.";
const FINISH_LAST =
  "2. This is the last interruption for this task: finishing again closes it without a consultation.";

export function guardInstruction(launcher: GuardLauncher, block: number): string {
  return [
    ...PREFIX,
    WAY_TO_CONSULT[launcher],
    block >= GUARD_CLOSE_BLOCKS ? FINISH_LAST : FINISH_FIRST,
  ].join("\n");
}

/**
 * State of one task at one level. Nothing here reads the user's words, the model's intent or a tool
 * result: only the classified calls the extension already needs for the checkpoint.
 */
export class AdvisorGuard {
  private open = false;
  private changes = 0;
  private sinceConsult = 0;
  private consulted = false;
  private blocks = 0;
  private changesAtBlock = 0;

  /** A new task starts watching from zero: the previous task's consultation covers nothing here. */
  openTask(): void {
    this.closeTask();
    this.open = true;
  }

  /** The report of what this task did, or undefined when nothing was watched. */
  closeTask(): GuardReport | undefined {
    if (!this.open) return undefined;
    const report: GuardReport = {
      changes: this.changes,
      consulted: this.consulted,
      blocks: this.blocks,
    };
    this.open = false;
    this.changes = 0;
    this.sinceConsult = 0;
    this.consulted = false;
    this.blocks = 0;
    this.changesAtBlock = 0;
    return report;
  }

  /**
   * A consultation covers the changes made so far and up to `GUARD_COVERAGE_CHANGES` more. Only while
   * a task is open: a consultation made at another level, or after the task closed, must not leave the
   * next task pre-covered.
   */
  noteConsult(): void {
    if (!this.open) return;
    this.consulted = true;
    this.sinceConsult = 0;
  }

  /**
   * Count a call that changes state. The budget covers *changes*, not elapsed time: five edits that
   * apply a decision are not the same task as five edits that start a new one, and only the count is
   * something this extension can see.
   */
  noteStateChange(): void {
    if (!this.open) return;
    this.changes += 1;
    if (!this.consulted) return;
    this.sinceConsult += 1;
    if (this.sinceConsult > GUARD_COVERAGE_CHANGES) this.consulted = false;
  }

  get coverage(): Readonly<{ consulted: boolean; changes: number }> {
    return { consulted: this.consulted, changes: this.changes };
  }

  /**
   * Decide whether this settlement may pass. `available` is the host's and the configuration's answer
   * at this instant, never a value remembered from the start of the task: a bridge that stopped
   * answering must not turn the level into a work stoppage.
   */
  decide(input: { available: boolean; launcher: GuardLauncher }): GuardDecision {
    if (!this.open || this.changes === 0) return { action: "pass", reason: "clean" };
    if (this.consulted) return { action: "pass", reason: "covered" };
    if (!input.available) return { action: "pass", reason: "unavailable" };
    if (this.blocks >= GUARD_CLOSE_BLOCKS) return { action: "pass", reason: "spent" };
    // The second interruption is only earned by new work since the first one, so a task cannot be
    // interrupted twice for the same close.
    if (this.blocks > 0 && this.changes === this.changesAtBlock)
      return { action: "pass", reason: "spent" };

    this.blocks += 1;
    this.changesAtBlock = this.changes;
    return {
      action: "block",
      instruction: guardInstruction(input.launcher, this.blocks),
      block: this.blocks,
    };
  }
}

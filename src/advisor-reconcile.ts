import {
  type AdvisorParentPartition,
  type AdvisorThreadRecord,
  closeAdvisorTask,
  isUnresolvedAdvisorThread,
  settleAdvisorThread,
} from "./advisor-threads.ts";

/**
 * The decisions one reconciliation pass may take on the continuity journal, and the evidence they
 * rest on.
 *
 * A continuation record can become unusable in three ways: the turn was cut before the host returned
 * its run id, the turn ended in a state other than `complete`, or the answer was recorded for a task
 * that has already ended. Only the first has no proof of its own, and the two commands that could
 * reconcile used to share a predicate that left it unresolved forever: the parent stayed blocked and
 * the operator had to repair a private file by hand.
 *
 * Nothing here mutates the journal: the caller supplies the evidence, applies the plan inside its own
 * journal lock, and keeps its own message. That keeps the decision testable without a host.
 */

/**
 * How far after a thread's last record a run of the same agent may have started and still be that
 * thread's own turn. It absorbs clock skew and a resume that was queued for a while; a run outside it
 * is not ruled out either, it just stops counting as proof of absence.
 */
const START_GRACE_MS = 10 * 60 * 1000;

/** Evidence that answers nothing, for a pass whose only debt is local. */
export const UNANSWERABLE_EVIDENCE: AdvisorContinuityEvidence = {
  runState: async () => ({ ok: false, reason: "unavailable" }),
  runs: async () => ({ ok: false }),
};

/** The states a finished run reports, as the host documents them. */
const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  "complete",
  "failed",
  "partial",
  "paused",
  "stopped",
  "rejected",
]);

/** The states a run reports while it can still be running. */
const LIVE_RUN_STATES: ReadonlySet<string> = new Set(["queued", "running"]);

/**
 * The labels a job carries before the host knows which agent runs it. A live run this module cannot
 * name is still a run that may be ours, so it counts: a wrong attribution only delays a closure.
 */
const UNNAMED_RUN_LABELS: ReadonlySet<string> = new Set(["", "single", "subagent", "agent"]);

function isAdvisorTerminalRunState(value: unknown): boolean {
  return typeof value === "string" && TERMINAL_RUN_STATES.has(value);
}

function isAdvisorLiveRunState(value: unknown): boolean {
  return typeof value === "string" && LIVE_RUN_STATES.has(value);
}

/** One run as the host lists it, reduced to the fields attribution is allowed to read. */
export type AdvisorRunEvidence = Readonly<{
  label: string;
  state: string;
  startedAt?: number;
}>;

/**
 * The session's runs, and whether absence means anything: a list the host trimmed cannot prove that
 * a run is gone.
 */
export type AdvisorRunsSnapshot =
  | Readonly<{ ok: true; runs: readonly AdvisorRunEvidence[]; complete: boolean }>
  | Readonly<{ ok: false }>;

/**
 * An answer about one run id. `unknown-run` means the host answered and does not hold that run any
 * more, which is the only reading that may fall back to absence; `unavailable` means nothing was
 * learned and the record must keep blocking.
 */
export type AdvisorRunState =
  | Readonly<{ ok: true; state: string }>
  | Readonly<{ ok: false; reason: "unknown-run" | "unavailable" }>;

/** What a caller must be able to ask the host. Nothing else reaches this module. */
export type AdvisorContinuityEvidence = Readonly<{
  runState: (runId: string) => Promise<AdvisorRunState>;
  runs: () => Promise<AdvisorRunsSnapshot>;
}>;

export type AdvisorContinuityClosure = Readonly<{
  taskToken: string;
  slot: number;
  /** `recovered` when evidence closed it; `reset` when an operator abandoned the thread. */
  reason: "recovered" | "reset";
  proof: "terminal" | "absent" | "abandoned";
}>;

/**
 * Why a record stays unresolved. `live` is a run of this agent inside the thread's life, `late` one
 * that started after it and so cannot be ruled out either, and `unknown` a host that showed nothing
 * conclusive. Only `unknown` may be abandoned: the other two may still be running.
 */
export type AdvisorContinuityHold = Readonly<{
  taskToken: string;
  slot: number;
  cause: "live" | "late" | "unknown";
}>;

export type AdvisorContinuityPlan = Readonly<{
  /** Answered records of a task that already ended; they close before any new consultation. */
  retiredTasks: readonly string[];
  closures: readonly AdvisorContinuityClosure[];
  kept: readonly AdvisorContinuityHold[];
}>;

/** True when the plan has nothing to write: only holds, or nothing at all. */
export function isAdvisorContinuityPlanEmpty(plan: AdvisorContinuityPlan): boolean {
  return plan.retiredTasks.length === 0 && plan.closures.length === 0;
}

/**
 * Decide, from the host's own evidence, which unresolved records are settled and which must keep
 * blocking. The order is cheap to expensive: a closing debt needs no host, a record with a receipt is
 * asked about by its exact run id, and only a host that answers without that run lets the session list
 * decide.
 */
export async function planAdvisorContinuity(input: {
  partition: AdvisorParentPartition;
  activeTaskToken: string | undefined;
  evidence: AdvisorContinuityEvidence;
  startGraceMs?: number;
}): Promise<AdvisorContinuityPlan> {
  const grace = input.startGraceMs ?? START_GRACE_MS;
  const retiredTasks = [
    ...new Set(
      input.partition.threads
        .filter(
          (record) => record.state === "answered" && record.taskToken !== input.activeTaskToken,
        )
        .map((record) => record.taskToken),
    ),
  ];

  const closures: AdvisorContinuityClosure[] = [];
  const kept: AdvisorContinuityHold[] = [];
  let snapshot: AdvisorRunsSnapshot | undefined;

  for (const record of input.partition.threads) {
    if (!isUnresolvedAdvisorThread(record)) continue;
    const base = { taskToken: record.taskToken, slot: record.slot };

    const proved = await provedByRunId(record, input.evidence);
    if (proved === "terminal") {
      closures.push({ ...base, reason: "recovered", proof: "terminal" });
      continue;
    }
    if (proved === "live") {
      kept.push({ ...base, cause: "live" });
      continue;
    }
    // A host that did not answer leaves the record blocked: only its silence about a run it answered
    // for may be read as absence.
    if (proved === "unanswered") {
      kept.push({ ...base, cause: "unknown" });
      continue;
    }

    // No proof by id: only the session list can say that nothing of this thread is left running.
    snapshot ??= await input.evidence.runs();
    const attributed = attributeSnapshot(snapshot, record, grace);
    if (attributed === "absent") {
      closures.push({ ...base, reason: "recovered", proof: "absent" });
      continue;
    }
    kept.push({ ...base, cause: attributed });
  }

  return { retiredTasks, closures, kept };
}

/**
 * Abandon the records the evidence cannot settle, which is what an explicit `reset` means. A record
 * that still carries the receipt of a turn the host may be running is never abandoned here: that
 * would close a live turn blindly, which is the risk the journal exists to prevent.
 */
export function planAdvisorContinuityAbandon(
  plan: AdvisorContinuityPlan,
  partition: AdvisorParentPartition,
): AdvisorContinuityClosure[] {
  const closures: AdvisorContinuityClosure[] = [];
  for (const hold of plan.kept) {
    // Only a hold with no evidence at all is abandonable: a live or late run may still be running.
    if (hold.cause !== "unknown") continue;
    const record = partition.threads.find(
      (candidate) => candidate.taskToken === hold.taskToken && candidate.slot === hold.slot,
    );
    if (!record || record.operationRunId !== undefined) continue;
    closures.push({
      taskToken: hold.taskToken,
      slot: hold.slot,
      reason: "reset",
      proof: "abandoned",
    });
  }
  return closures;
}

/** Apply a plan to a partition. Every transition is idempotent, so a repeated pass changes nothing. */
export function applyAdvisorContinuity(
  partition: AdvisorParentPartition,
  plan: AdvisorContinuityPlan,
  now: number,
): AdvisorParentPartition {
  let next = partition;
  for (const taskToken of plan.retiredTasks)
    next = closeAdvisorTask(next, taskToken, "task-settled", now);
  for (const closure of plan.closures)
    next = settleAdvisorThread(next, closure.taskToken, closure.slot, closure.reason, now);
  return next;
}

/**
 * `terminal` and `live` come from the exact receipt. `unanswered` means nothing was learned, so the
 * record keeps blocking; `not-held` means the host answered and no longer holds that run, which is the
 * only case where the session list may decide.
 */
async function provedByRunId(
  record: AdvisorThreadRecord,
  evidence: AdvisorContinuityEvidence,
): Promise<"terminal" | "live" | "unanswered" | "not-held"> {
  if (record.operationRunId === undefined) return "not-held";
  const status = await evidence.runState(record.operationRunId);
  if (!status.ok) return status.reason === "unknown-run" ? "not-held" : "unanswered";
  if (isAdvisorTerminalRunState(status.state)) return "terminal";
  if (isAdvisorLiveRunState(status.state)) return "live";
  // A state this module does not know is not evidence of anything.
  return "unanswered";
}

/**
 * Whether the session still holds a live run that could be this record's turn. The label carries the
 * advisor profile that launched the run and the start time places it inside the thread's life, so a
 * run started later belongs to something else. Missing information widens the match on purpose: a
 * wrong attribution only delays a closure, while a wrong absence would close a live turn.
 */
function attributeSnapshot(
  snapshot: AdvisorRunsSnapshot,
  record: AdvisorThreadRecord,
  graceMs: number,
): "live" | "late" | "unknown" | "absent" {
  if (!snapshot.ok || !snapshot.complete) return "unknown";
  let late = false;
  let undecidable = false;
  for (const run of snapshot.runs) {
    // A finished run of another agent says nothing about this thread.
    if (isAdvisorTerminalRunState(run.state) || !mayBelongTo(run, record)) continue;
    if (!isAdvisorLiveRunState(run.state)) {
      // A state this reader does not know (a future `cancelled`, say) is not proof of absence.
      undecidable = true;
      continue;
    }
    if (withinThreadLife(run, record, graceMs)) return "live";
    // Ours, but it started too late to be this turn: a queued resume can still be this turn, so it is
    // not proof that the turn is gone either.
    late = true;
  }
  if (late) return "late";
  return undecidable ? "unknown" : "absent";
}

/** A run belongs to the thread when its label names the advisor profile, or names nothing yet. */
function mayBelongTo(run: AdvisorRunEvidence, record: AdvisorThreadRecord): boolean {
  return (
    run.label.includes(record.fingerprint.profile) ||
    UNNAMED_RUN_LABELS.has(run.label.trim().toLowerCase())
  );
}

function withinThreadLife(
  run: AdvisorRunEvidence,
  record: AdvisorThreadRecord,
  graceMs: number,
): boolean {
  if (run.startedAt === undefined) return true;
  return run.startedAt <= record.updatedAt + graceMs;
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getGlobalConfigPath } from "./config.ts";
import type { LaunchChildRole, LaunchCorrectionCode, LaunchRefusalCode } from "./launch-guard.ts";
import type { AdvisorTurnContext } from "./advisor-threads.ts";
import type { AdvisorLevel } from "./advisor-level.ts";
import type { CheckpointReport } from "./advisor-checkpoint.ts";
import type { AdvisorLaunch, AdvisorMode, Intensity } from "./types.ts";

export const ADVISOR_LOG_MAX_BYTES = 256 * 1024;

/** The one place the event log path is spelled, so a reader can never drift from its writer. */
export function getEventLogPath(configPath = getGlobalConfigPath()): string {
  return join(dirname(configPath), "delegation-policy.events.jsonl");
}

const FILE_OPERATIONS = { appendFile, mkdir, rename, rm, stat };
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
export type ConsultationStatus =
  | "completed"
  | "failed"
  | "unavailable"
  | "unavailable-context"
  | "busy"
  | "cancelled"
  | "timed-out"
  | "blocked"
  | "observed";
export type ConsultationAttempt = {
  model: string;
  status: ConsultationStatus;
  context: AdvisorTurnContext | "unknown";
  durationMs: number;
  /** Original Advisor position; absent for a role-mode observation. */
  slot?: number;
};
/** Counters for one main-agent task, from its user prompt to the next settle. */
export type TaskSummary = {
  durationMs: number;
  /** The main model named by the host, or null; never a task, a prompt or a path. */
  mainModel: string | null;
  advisorLevel: AdvisorLevel;
  toolCalls: number;
  edits: number;
  firstEditIndex: number | null;
  /** Attempts: a `consult_advisor` call counts even when it reached no model. */
  advisorConsults: number;
  firstConsultIndex: number | null;
  consultBeforeFirstEdit: boolean;
  subagentLaunches: number;
  launchRefusals: number;
};
/** What a `consult_advisor` call carried, next to the attempts it produced. */
export type ConsultationContext = {
  mainModel: string | null;
  advisorLevel: AdvisorLevel;
  /** The model passed no question, brief or evidence and the host supplied the context. */
  noArgs: boolean;
  /** Bytes of the context the host assembled; 0 when the agent wrote its own brief. */
  contextBytes: number;
};

/** One checkpoint decision, with the configuration it ran under. */
export type CheckpointRecord = CheckpointReport & {
  mainModel: string | null;
  advisorLevel: AdvisorLevel;
};

export type LaunchOutcome = "allowed" | "refused";
export type LaunchRecord = {
  outcome: LaunchOutcome;
  /** The closed refusal code, or null when the call was allowed. */
  reason: LaunchRefusalCode | null;
  children: readonly LaunchChildRole[];
  /** Closed kinds of correction the guard applied before the call ran; never a model or a task. */
  corrections: readonly LaunchCorrectionCode[];
};

/** An allowlisted, content-free local record. No executor payloads or errors enter this writer. */
export class AdvisorLog {
  private lastHash: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private drainExpired = false;
  private readonly path: string;
  private readonly files: typeof FILE_OPERATIONS;

  constructor(path = getEventLogPath(), files = FILE_OPERATIONS) {
    this.path = path;
    this.files = files;
  }

  policy(
    policy: string | undefined,
    settings: {
      intensity: Intensity;
      advisorMode: AdvisorMode;
      advisorLaunch: AdvisorLaunch;
      context: AdvisorTurnContext;
      advisors: number;
    },
  ): void {
    if (!policy) {
      this.lastHash = undefined;
      return;
    }
    const hash = createHash("sha256").update(policy).digest("hex");
    if (hash === this.lastHash) return;
    this.lastHash = hash;
    this.enqueue({
      event: "policy",
      version: VERSION,
      hash,
      intensity: settings.intensity,
      advisorMode: settings.advisorMode,
      advisorLaunch: settings.advisorLaunch,
      context: settings.context,
      advisors: settings.advisors,
    });
  }

  consultation(
    mode: AdvisorLaunch,
    attempts: readonly ConsultationAttempt[],
    context?: ConsultationContext,
  ): void {
    if (!this.lastHash) return;
    this.enqueue({
      event: "consultation",
      version: VERSION,
      policyHash: this.lastHash,
      mode,
      ...(context
        ? {
            mainModel: context.mainModel ? context.mainModel.slice(0, 256) : null,
            advisorLevel: context.advisorLevel,
            noArgs: context.noArgs,
            contextBytes: Math.max(0, Math.round(context.contextBytes)),
          }
        : {}),
      models: attempts.map((attempt) => ({
        model: attempt.model.slice(0, 256),
        status: attempt.status,
        context: attempt.context,
        durationMs: Math.max(0, Math.round(attempt.durationMs)),
        ...(attempt.slot === undefined ? {} : { slot: attempt.slot }),
      })),
    });
  }

  /** One summary per main-agent task: counts and positions only, never a prompt, task or path. */
  task(summary: TaskSummary): void {
    if (!this.lastHash) return;
    this.enqueue({
      event: "task",
      version: VERSION,
      policyHash: this.lastHash,
      durationMs: Math.max(0, Math.round(summary.durationMs)),
      mainModel: summary.mainModel ? summary.mainModel.slice(0, 256) : null,
      advisorLevel: summary.advisorLevel,
      toolCalls: summary.toolCalls,
      edits: summary.edits,
      firstEditIndex: summary.firstEditIndex,
      advisorConsults: summary.advisorConsults,
      firstConsultIndex: summary.firstConsultIndex,
      consultBeforeFirstEdit: summary.consultBeforeFirstEdit,
      subagentLaunches: summary.subagentLaunches,
      launchRefusals: summary.launchRefusals,
    });
  }

  /** One record per subagent call the guard checked: its outcome, a closed code and role codes. */
  launch(record: LaunchRecord): void {
    if (!this.lastHash) return;
    this.enqueue({
      event: "launch",
      version: VERSION,
      policyHash: this.lastHash,
      outcome: record.outcome,
      reason: record.reason,
      children: record.children.length,
      roles: record.children,
      corrections: record.corrections,
    });
  }

  /**
   * One record per task whose checkpoint fired: the closed signals that caused it and how the task
   * answered, with no tool input, path, prompt or task body.
   */
  checkpoint(record: CheckpointRecord): void {
    if (!this.lastHash) return;
    this.enqueue({
      event: "checkpoint",
      version: VERSION,
      policyHash: this.lastHash,
      mode: record.mode,
      signals: record.signals,
      resolution: record.resolution,
      priorCalls: Math.max(0, Math.round(record.priorCalls)),
      filesRead: Math.max(0, Math.round(record.filesRead)),
      promptChars: Math.max(0, Math.round(record.promptChars)),
      editLines: Math.max(0, Math.round(record.editLines)),
      mainModel: record.mainModel ? record.mainModel.slice(0, 256) : null,
      advisorLevel: record.advisorLevel,
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Shutdown drains accepted records, but a stalled disk must not hold Pi open indefinitely.
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            // An in-flight filesystem call may finish later; do not start another one afterward.
            this.drainExpired = true;
            resolve();
          }, 5_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private enqueue(event: Record<string, unknown>): void {
    // A stalled disk cannot create an unbounded backlog or delay an LLM request.
    if (this.closed || this.pending >= 64) return;
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`;
    this.pending += 1;
    this.queue = this.queue
      .then(async () => {
        if (this.drainExpired) return;
        await this.files.mkdir(dirname(this.path), { recursive: true });
        if (this.drainExpired) return;
        const size = await this.files.stat(this.path).then(
          (info) => info.size,
          () => 0,
        );
        if (this.drainExpired) return;
        if (size + Buffer.byteLength(line, "utf8") > ADVISOR_LOG_MAX_BYTES) {
          await this.files.rm(`${this.path}.1`, { force: true });
          if (this.drainExpired) return;
          await this.files.rename(this.path, `${this.path}.1`).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        }
        if (this.drainExpired) return;
        await this.files.appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch(() => {
        // Logging is best-effort and must never turn a successful request into a failure.
      })
      .finally(() => {
        this.pending -= 1;
      });
  }
}

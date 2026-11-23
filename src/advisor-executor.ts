import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentLaunch,
  LAUNCH_PREFLIGHT_TIMEOUT_MS,
  LAUNCH_TERMINAL_TIMEOUT_MS,
  type AgentLaunchDefinition,
  type AgentLaunchDependencies,
  type AgentLaunchEventBus,
  type AgentLaunchFailure,
  type AgentLaunchHost,
  type AgentLaunchRequest,
  type AgentLaunchResult,
  type AgentLaunchTerminalField,
  type AgentLaunchTerminalStatus,
} from "./agent-launch.ts";
import { MAX_ADVISORS, type AdvisorSetting, type ThinkingLevelName } from "./types.ts";
import type { ConsultationAttempt } from "./advisor-log.ts";
import {
  ANTHROPIC_ADVISOR_AGENT,
  ANTHROPIC_ADVISOR_EXTENSION,
} from "./advisor-anthropic-provider.ts";
import {
  isPinnedAdmission,
  PINNED_PACKAGE,
  PROVIDER_EXTENSION_ADVISOR_AGENT,
} from "./advisor-provider-extension.ts";
import { sessionChildExtensions } from "./advisor-extensions.ts";
import { admissionFor, type ProviderAdmissions } from "./provider-admissions.ts";
import { packageSource } from "./provider-package.ts";
import {
  AdvisorResumeClient,
  advisorStatusVerdict,
  type AdvisorTerminalIdentity,
} from "./advisor-resume.ts";
import {
  UNANSWERABLE_EVIDENCE,
  applyAdvisorContinuity,
  isAdvisorContinuityPlanEmpty,
  planAdvisorContinuity,
  type AdvisorContinuityEvidence,
} from "./advisor-reconcile.ts";
import {
  ADVISOR_THREAD_MAX_RUN_IDS,
  AdvisorThreadJournal,
  advisorAnswerPath,
  discardAdvisorAnswer,
  findAdvisorThread,
  getAdvisorOutputRoot,
  readAdvisorAnswer,
  invalidateAdvisorPartition,
  reserveAdvisorAnswer,
  unresolvedAdvisorThread,
  unclosedAdvisorTask,
  upsertAdvisorThread,
  type AdvisorJournalFailure,
  type AdvisorJournalSession,
  type AdvisorThreadFingerprint,
  type AdvisorThreadReason,
  type AdvisorThreadRecord,
  type AdvisorTurnContext,
} from "./advisor-threads.ts";

export const ADVISOR_AGENT_NAME = "pi-delegation-policy.advisor";
/** The same advisor with one tool: `read`, so it can open a file the brief names. */
export const ADVISOR_READ_AGENT_NAME = "pi-delegation-policy.advisor-read";
export const ADVISOR_PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export type AdvisorRequest = AgentLaunchRequest & {
  question: string;
  brief?: string;
  /** Selects the child profile: Anthropic's own opt-in, or the extension admitted for the provider. */
  providerExtension?: "anthropic-auth" | "admitted";
};

/** One consultation, shared by every configured slot. */
export type AdvisorConsultRequest = Readonly<{
  question: string;
  brief?: string;
  /** What changed since the previous turn; only a continuation sends it. */
  evidence?: string;
}>;

/**
 * One original Advisor position. `unavailable` keeps the index so a configured Advisor that cannot
 * run is reported in place instead of disappearing from the group.
 */
export type AdvisorSlotPlan =
  | Readonly<{
      kind: "launch";
      slot: number;
      model: string;
      fingerprint: AdvisorThreadFingerprint;
      request: AdvisorRequest;
    }>
  | Readonly<{ kind: "unavailable"; slot: number; model: string; cause: string }>;

export type AdvisorSlotStatus = "complete" | "unavailable" | "blocked";
export type AdvisorSlotOutcome = Readonly<{
  slot: number;
  model: string;
  status: AdvisorSlotStatus;
  context: AdvisorTurnContext | "unknown";
  /** Present only when the slot produced an answer. */
  answer?: string;
  /** Closed cause of a non-complete slot, or the continuity note of a complete one. */
  code?: AdvisorContinuityCode;
  detail?: string;
}>;
export type AdvisorGroupSummary = "complete" | "partial" | "unavailable" | "blocked";
export type AdvisorGroupOutcome = Readonly<{
  summary: AdvisorGroupSummary;
  slots: readonly AdvisorSlotOutcome[];
}>;

/** Closed causes for anything that is not a launch failure with its own renderer. */
export type AdvisorContinuityCode =
  | "unresolved"
  | "busy"
  | "journal-busy"
  | "journal-unreadable"
  | "journal-write-failed"
  | "journal-gate-stale"
  | "rpc-unavailable"
  | "rpc-timeout"
  | "rpc-rejected"
  | "capability-missing"
  | "session-mismatch"
  | "receipt-invalid"
  | "run-id-reused"
  | "status-unavailable"
  | "status-incomplete"
  | "status-mismatch"
  | "answer-occupied"
  | "answer-outside"
  | "brief-required"
  | "closing-failed"
  | "answer-missing"
  | "answer-invalid"
  | "answer-too-large"
  | "continuity-unavailable"
  | "cancelled";

const RECOVERY =
  "The next consultation reconciles it with the host before it blocks again; /delegate advisor threads recover does it now.";
/** A journal this process cannot take is not reconciled by consulting: the lock has to be freed. */
const JOURNAL_REPAIR =
  "Run /delegate advisor threads recover to reclaim the journal once no other Pi process uses this configuration. It changes nothing while another owner is alive.";

/**
 * Bounded English cause for a blocked continuation. Closed codes only: no host error text, path,
 * provider message or answer ever reaches the transcript through this function.
 */
export function advisorContinuityText(code: AdvisorContinuityCode): string {
  switch (code) {
    case "unresolved":
      return `Advisor continuity is blocked: an earlier turn may still be running, so no new turn was started. ${RECOVERY}`;
    case "busy":
      return "Advisor busy: one consultation group is already in flight for this session. Wait for its result before starting another consultation; do not duplicate the pending group.";
    case "journal-busy":
      return `Advisor continuity is blocked: another process holds the Advisor journal for this session. ${JOURNAL_REPAIR}`;
    case "journal-unreadable":
      return `Advisor continuity is blocked: the Advisor journal cannot be read, so no turn was started and nothing was overwritten. ${JOURNAL_REPAIR}`;
    case "journal-write-failed":
      return "Advisor continuity is blocked: the Advisor journal could not be written, so no turn was recorded. Nothing can reconcile a write that never happened; the next consultation records its own turn.";
    case "journal-gate-stale":
      return "Advisor continuity is blocked: the reclamation gate is stale, ownerless or unreadable, and it is never reclaimed automatically. Nothing was changed. Stop every Pi process that uses this configuration, confirm none is running, then remove the gate directory named in /delegate advisor threads status.";
    case "rpc-unavailable":
      return "Advisor continuation is unavailable: the installed pi-subagents does not answer the public RPC. Install an admitted build and reload the session; no turn was started.";
    case "rpc-timeout":
      return "Advisor continuation is unavailable: the public RPC did not answer in time. No turn was started; check the installed pi-subagents build before retrying.";
    case "rpc-rejected":
      return "Advisor continuation is unavailable: the public RPC refused the request. No turn was started; check the installed pi-subagents build and this session.";
    case "capability-missing":
      return "Advisor continuation is unavailable: the installed pi-subagents does not advertise resume and completion events. Install an admitted build and reload the session; no turn was started.";
    case "session-mismatch":
      return "Advisor continuation is blocked: the RPC bridge reports a different session than this one. No turn was started.";
    case "receipt-invalid":
      return `Advisor continuation is blocked: the host accepted the turn without a usable run id, so the answer cannot be correlated. ${RECOVERY}`;
    case "run-id-reused":
      return `Advisor continuation is blocked: the host returned a run id this thread already used, so the turn is not a new run. ${RECOVERY}`;
    case "status-unavailable":
      return `Advisor continuation is blocked: the host reports no status for this turn's run id. ${RECOVERY}`;
    case "status-incomplete":
      return `Advisor continuation is blocked: the turn did not reach a completed terminal state. ${RECOVERY}`;
    case "status-mismatch":
      return `Advisor continuation is blocked: the turn reported a different agent, model, thinking level or run shape than this thread. ${RECOVERY}`;
    case "answer-occupied":
      return `Advisor continuation is blocked: this turn's answer path already held a file, so it was not reused. ${RECOVERY}`;
    case "answer-outside":
      return `Advisor continuation is blocked: this turn's answer path left the private output tree, so it was refused. ${RECOVERY}`;
    case "closing-failed":
      return "Advisor continuity is blocked: the closing state of an earlier task could not be persisted, so its records only look settled. The next consultation persists that closure before it starts; /delegate advisor threads recover does it now.";
    case "brief-required":
      return "Advisor error: a first consultation requires brief. Fresh context sends only your question and brief, so supply a short self-contained objective, constraints, relevant facts, options, and uncertainty; a continuation sends only the question and evidence.";
    case "answer-missing":
      return `Advisor continuation is blocked: the turn completed but wrote no answer file. ${RECOVERY}`;
    case "answer-invalid":
      return `Advisor continuation is blocked: the answer file was not a regular, unchanged UTF-8 file. ${RECOVERY}`;
    case "answer-too-large":
      return `Advisor continuation is blocked: the answer exceeded the admitted size and was not truncated. ${RECOVERY}`;
    case "continuity-unavailable":
      return "The answer is available, but its run id was not reported, so this Advisor cannot be resumed. The next consultation starts a new thread.";
    case "cancelled":
      return `Advisor cancelled before replying; nothing from this turn was accepted. ${RECOVERY}`;
  }
}

const DEFINITION: AgentLaunchDefinition<AdvisorRequest, string> = {
  agentName: ADVISOR_AGENT_NAME,
  agentPath: resolve(
    fileURLToPath(new URL("../agents/pi-delegation-policy.advisor.md", import.meta.url)),
  ),
  internalTools: [],
  // An operator's extra child extensions, registered for the session before any launch of this
  // profile. Empty until the host accepts them.
  requiredExtensions: sessionChildExtensions,
  buildTask: (request) => JSON.stringify({ question: request.question, brief: request.brief }),
  result: {
    variant: "text",
    isValue: (value): value is string => typeof value === "string" && value.trim().length > 0,
  },
};

/** The child profile for one Advisor; Anthropic's opt-in takes precedence over any admission. */
export function advisorProfile(
  setting: Pick<AdvisorSetting, "provider" | "providerExtension">,
  admissions: ProviderAdmissions = {},
): AdvisorRequest["providerExtension"] {
  if (setting.providerExtension === "anthropic-auth") return "anthropic-auth";
  const admitted = admissionFor(admissions, setting.provider);
  // The packaged profile pins one package, so an admission naming another one cannot be served. It
  // fails closed here instead of loading a package the current admission no longer authorizes.
  return admitted && isPinnedAdmission(admitted) ? "admitted" : undefined;
}

/**
 * The profile a launch must name. Reading is a separate profile rather than a launch option, because the
 * child's tools come from the profile and nothing here may pass tool overrides. The provider-dependent
 * profiles keep their own identity and stay tool-free: reading is offered on the ordinary advisor only,
 * and the prompt says so instead of promising a capability the child does not have.
 */
export function advisorAgentName(
  setting: Pick<AdvisorSetting, "provider" | "model" | "providerExtension">,
  admissions: ProviderAdmissions = {},
  canRead = false,
): string {
  switch (advisorProfile(setting, admissions)) {
    case "anthropic-auth":
      return ANTHROPIC_ADVISOR_AGENT;
    case "admitted":
      return PROVIDER_EXTENSION_ADVISOR_AGENT;
    default:
      return canRead ? ADVISOR_READ_AGENT_NAME : ADVISOR_AGENT_NAME;
  }
}
const ANTHROPIC_DEFINITION: AgentLaunchDefinition<AdvisorRequest, string> = {
  ...DEFINITION,
  agentName: ANTHROPIC_ADVISOR_AGENT,
  agentPath: fileURLToPath(
    new URL("../agents/pi-delegation-policy.advisor-anthropic-auth.md", import.meta.url),
  ),
  configuredExtensions: [ANTHROPIC_ADVISOR_EXTENSION],
};
const PROVIDER_EXTENSION_DEFINITION: AgentLaunchDefinition<AdvisorRequest, string> = {
  ...DEFINITION,
  agentName: PROVIDER_EXTENSION_ADVISOR_AGENT,
  agentPath: fileURLToPath(
    new URL("../agents/pi-delegation-policy.advisor-provider-extension.md", import.meta.url),
  ),
  // The profile pins the admitted package for the host to load, so the launch contract expects that
  // source rather than an extension path of its own.
  configuredExtensions: [packageSource(PINNED_PACKAGE)],
};

/** Highest first; levels above `high` are left out to bound cost across parallel advisors. */
const ADVISOR_THINKING_PREFERENCE: readonly ThinkingLevelName[] = [
  "high",
  "medium",
  "low",
  "minimal",
  "off",
];

/**
 * Tool-mode thinking for an Advisor: the strongest supported level up to `high`. A model that
 * supports none of these keeps its first reported level rather than failing the consultation.
 */
export function advisorThinking(model: Model<Api>): ThinkingLevelName {
  const supported = getSupportedThinkingLevels(model);
  return (
    ADVISOR_THINKING_PREFERENCE.find((level) => supported.includes(level)) ??
    (supported[0] as ThinkingLevelName)
  );
}

type AdvisorFailureResult = Exclude<AgentLaunchResult<string>, { kind: "completed" }>;

function terminalFieldText(field: AgentLaunchTerminalField | undefined): string {
  switch (field) {
    case "agent":
      return "agent profile";
    case "model":
      return "model";
    case "thinking":
      return "thinking level";
    case "launchContractDigest":
      return "launch contract digest";
    default:
      return "terminal metadata";
  }
}

function hostStatusText(status: AgentLaunchTerminalStatus | undefined): string {
  switch (status) {
    case "invalid_request":
      return "The host rejected the launch as an invalid request. Retry once; if it repeats, check the question and the packaged Advisor profile.";
    case "unavailable_context":
      return "The host could not supply the requested context. Call again with brief for a fresh consultation.";
    case "duplicate_node":
      return "The host treated this launch as a duplicate. Retry once.";
    case "turn_budget_exhausted":
      return "The host ended the Advisor run at its turn limit before answering. Retry once with a narrower question.";
    case "tool_budget_exhausted":
      return "The host ended the Advisor run at its tool limit before answering. Retry once with a narrower question.";
    case "structured_output_failed":
      return "The host ended the Advisor run while collecting its structured result. Retry once; if it repeats, inspect host diagnostics and check that the installed pi-delegation-policy and pi-subagents builds are compatible.";
    case "acceptance_failed":
      return "The host ended the Advisor run at its acceptance check. Retry once; if it repeats, inspect host diagnostics and check that the installed pi-delegation-policy and pi-subagents builds are compatible.";
    case "failed":
      return "The host ended the Advisor run with status failed and supplied no safe detail. Retry once; if it repeats, check the installed pi-subagents version.";
    default:
      return "The host ended the Advisor run and supplied no safe detail. Retry once; if it repeats, check the installed pi-subagents version.";
  }
}

function unavailableFailureText(reason: AgentLaunchFailure | undefined): string {
  const preflightSeconds = LAUNCH_PREFLIGHT_TIMEOUT_MS / 1000;
  switch (reason?.code) {
    case "modules-unavailable":
      return "Advisor launch is unavailable: the pi-subagents exports this extension requires were not found. Install an admitted pi-subagents build, then reload the session.";
    case "preflight-unavailable":
      return "Advisor preflight returned no launch contract. Retry once; if it repeats, check the installed pi-subagents build and the packaged Advisor profile.";
    case "preflight-timeout":
      return `Advisor preflight did not finish within ${preflightSeconds} seconds. Retry once; if it repeats, check the installed pi-subagents version.`;
    case "contract-rejected":
      return "Advisor launch contract was rejected: preflight did not confirm the required profile, model, thinking, and tool set. Inspect host diagnostics and check the installed package versions and profile; no child was launched.";
    case "request-start-timeout":
      return `The host did not start the Advisor within ${preflightSeconds} seconds. Retry once; if it repeats, check the installed pi-subagents version.`;
    case "request-emit-failed":
      return "The host could not set up or send the Advisor launch event. Reload the session, then retry; if it repeats, check the installed extension against an admitted pi-subagents build.";
    case "host-session-missing":
      return "Advisor unavailable: the host supplied no session identity.";
    case "launch-closed":
      return "Advisor launch is closed for this session. Reload the session, then retry.";
    case "journal-unavailable":
      return advisorContinuityText("journal-write-failed");
    case "host-terminal-status":
      return hostStatusText(reason.status);
    case "host-status-unrecognized":
      return "The host ended the Advisor run with a status this extension does not recognize and supplied no safe detail. Retry once; if it repeats, check the installed pi-subagents version.";
    default:
      return "Advisor launch failed without a classified cause, and the host supplied no safe detail. Retry once; if it repeats, check the installed pi-subagents version.";
  }
}

function failedFailureText(reason: AgentLaunchFailure | undefined): string {
  switch (reason?.code) {
    case "terminal-metadata-mismatch":
      return `The host returned an Advisor reply whose ${terminalFieldText(reason.field)} did not match the preflight contract, so the reply was discarded. Retry once; if it repeats, report the mismatch.`;
    case "terminal-result-invalid":
      return "The host reported completion without a usable text answer, so the result was discarded. Retry once; if it repeats, inspect host diagnostics and check the compatibility of the extension with the installed pi-subagents build.";
    case "host-terminal-status":
      return hostStatusText(reason.status);
    case "host-status-unrecognized":
      return "The host ended the Advisor run with a status this extension does not recognize and supplied no safe detail. Retry once; if it repeats, check the installed pi-subagents version.";
    default:
      return "The Advisor run failed and the host supplied no safe detail. Retry once; if it repeats, check the installed pi-subagents version.";
  }
}

/**
 * Bounded English cause for a failed Advisor launch. It renders only closed reason codes and
 * admitted protocol metadata, so host error text, prompts, URLs, paths and secrets never reach the
 * transcript or the local log.
 */
export function advisorFailureText(result: AdvisorFailureResult): string {
  switch (result.kind) {
    // Unreachable for the Advisor: no launch definition sets `allowFork`, so the host cannot reject a
    // context this extension never requests. The case stays because the shared launcher result type
    // still declares it, and narrowing that type would touch consumers outside this executor.
    case "unavailable-context":
      return "The host rejected the requested context. Call again with brief for a fresh consultation.";
    case "busy":
      return advisorContinuityText("busy");
    case "cancelled":
      return "Advisor cancelled before replying. Call again when ready.";
    case "timed-out":
      return `Advisor did not reply within ${LAUNCH_TERMINAL_TIMEOUT_MS / 1000} seconds. Inspect host diagnostics before retrying; cancellation does not guarantee that external generation or cost has stopped.`;
    case "unavailable":
      return unavailableFailureText(result.reason);
    case "failed":
      return failedFailureText(result.reason);
  }
}

/**
 * Launch failures that prove no child run exists: the request was never emitted, or the host
 * refused it before admitting execution. Anything else leaves a run that may still be live, so the
 * thread stays blocked instead of being reopened.
 */
function provesNoRun(result: AdvisorFailureResult): boolean {
  if (result.kind !== "unavailable" && result.kind !== "failed") return false;
  switch (result.reason?.code) {
    case "modules-unavailable":
    case "preflight-unavailable":
    case "preflight-timeout":
    case "contract-rejected":
    case "host-session-missing":
    case "launch-closed":
    case "journal-unavailable":
      return true;
    case "host-terminal-status":
      return (
        result.reason.status === "invalid_request" ||
        result.reason.status === "unavailable_context" ||
        result.reason.status === "duplicate_node"
      );
    default:
      return false;
  }
}

function sameFingerprint(left: AdvisorThreadFingerprint, right: AdvisorThreadFingerprint): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.thinking === right.thinking &&
    left.profile === right.profile &&
    left.admission === right.admission &&
    left.packageVersion === right.packageVersion &&
    left.epoch === right.epoch
  );
}

/** The message a continuation sends: the new question, plus whatever changed since last time. */
export function advisorContinuationMessage(consult: AdvisorConsultRequest): string {
  const question = consult.question.trim();
  const evidence = consult.evidence?.trim();
  return evidence ? `${question}\n\nEvidence since the last consultation:\n${evidence}` : question;
}

function groupSummary(slots: readonly AdvisorSlotOutcome[]): AdvisorGroupSummary {
  if (!slots.length) return "unavailable";
  if (slots.every((slot) => slot.status === "complete")) return "complete";
  if (slots.some((slot) => slot.status === "blocked")) return "blocked";
  if (slots.some((slot) => slot.status === "complete")) return "partial";
  return "unavailable";
}

type Timer = ReturnType<typeof setTimeout>;

type AdvisorExecution = Readonly<{
  slots: readonly AdvisorSlotPlan[];
  consult: AdvisorConsultRequest;
  task: Readonly<{ parentKey: string; taskToken: string }>;
  invalidate?: AdvisorThreadReason;
  /** The tool's original authorization, never refreshed by waits inside the executor. */
  isAuthorized?: () => boolean;
}>;

export type AdvisorExecutorDependencies = AgentLaunchDependencies & {
  journal?: AdvisorThreadJournal;
  /** Built per group from the live event bus; the default uses the public RPC client. */
  resume?: (events: AgentLaunchEventBus) => AdvisorResumeClient;
  outputRoot?: string;
  /** Bounded wait for one resumed turn to reach a terminal status. */
  resumeTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
};

/**
 * One pending call per tool: an advisor group runs one turn per configured slot, in the slot's
 * original position. The independent reader may hold its own pending call, so together they can own
 * four children.
 *
 * The group holds the journal lock for its whole duration. That is what makes a continuation safe
 * across processes: a second instance cannot resume a thread the first one still owns.
 */
export class AdvisorExecutor {
  private readonly launches: AgentLaunch<AdvisorRequest, string>[];
  private readonly providerLaunches: AgentLaunch<AdvisorRequest, string>[];
  private readonly admittedLaunches: AgentLaunch<AdvisorRequest, string>[];
  private readonly journal: AdvisorThreadJournal;
  private readonly resumeFactory: (events: AgentLaunchEventBus) => AdvisorResumeClient;
  private readonly outputRoot: string;
  private readonly resumeTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private pending = false;
  private generation = 0;

  constructor(dependencies: AdvisorExecutorDependencies = {}) {
    // One slot per list position; each position uses exactly one of its three profiles.
    this.launches = Array.from(
      { length: MAX_ADVISORS },
      () => new AgentLaunch(DEFINITION, dependencies),
    );
    this.providerLaunches = Array.from(
      { length: MAX_ADVISORS },
      () => new AgentLaunch(ANTHROPIC_DEFINITION, dependencies),
    );
    this.admittedLaunches = Array.from(
      { length: MAX_ADVISORS },
      () => new AgentLaunch(PROVIDER_EXTENSION_DEFINITION, dependencies),
    );
    this.journal = dependencies.journal ?? new AdvisorThreadJournal();
    this.resumeFactory = dependencies.resume ?? ((events) => new AdvisorResumeClient({ events }));
    this.outputRoot = dependencies.outputRoot ?? getAdvisorOutputRoot();
    this.resumeTimeoutMs = dependencies.resumeTimeoutMs ?? LAUNCH_TERMINAL_TIMEOUT_MS;
    this.pollIntervalMs = dependencies.pollIntervalMs ?? 250;
    this.now = dependencies.now ?? (() => Date.now());
    this.setTimer = dependencies.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));
  }
  private get allLaunches(): AgentLaunch<AdvisorRequest, string>[] {
    return [...this.launches, ...this.providerLaunches, ...this.admittedLaunches];
  }
  get busy(): boolean {
    return this.pending;
  }

  async execute(
    input: AdvisorExecution,
    host: AgentLaunchHost,
    signal: AbortSignal | undefined,
    record: (attempt: ConsultationAttempt) => void,
  ): Promise<AdvisorGroupOutcome> {
    if (this.pending) return this.blockedGroup(input.slots, "busy");
    this.pending = true;
    const generation = this.generation;
    try {
      const exclusive = await this.journal.exclusive(input.task.parentKey, async (session) => {
        const invalidation = input.invalidate;
        if (invalidation)
          await session.mutate((latest) =>
            invalidateAdvisorPartition(latest, invalidation, this.now()),
          );
        if (!this.isCurrent(input, generation, signal))
          return this.blockedGroup(input.slots, "cancelled");
        // A parent whose earlier turn was cut does not need a command to move again: what the host can
        // prove is over is closed here, before the guards read the partition.
        if (!(await this.reconcile(input, host, session, generation, signal)))
          return this.blockedGroup(input.slots, "cancelled");
        if (unresolvedAdvisorThread(session.partition()))
          return this.blockedGroup(input.slots, "unresolved");
        if (unclosedAdvisorTask(session.partition(), input.task.taskToken))
          return this.blockedGroup(input.slots, "closing-failed");
        const outcomes = await Promise.all(
          input.slots.map((plan) =>
            this.runSlot(plan, input, host, signal, record, session, generation),
          ),
        );
        return { summary: groupSummary(outcomes), slots: outcomes };
      });
      // exclusive still awaits owner cleanup after its callback returns. Nothing may be accepted
      // before that await finishes, including an answer accumulated while another slot was pending.
      if (!this.isCurrent(input, generation, signal))
        return this.blockedGroup(input.slots, "cancelled");
      if (!exclusive.ok) return this.blockedGroup(input.slots, exclusive.code);
      return exclusive.value;
    } finally {
      this.pending = false;
    }
  }

  private isCurrent(
    input: AdvisorExecution,
    generation: number,
    signal: AbortSignal | undefined,
  ): boolean {
    return generation === this.generation && !signal?.aborted && (input.isAuthorized?.() ?? true);
  }

  cancel(): void {
    this.generation += 1;
    for (const launch of this.allLaunches) launch.cancel();
  }
  rotate(): void {
    this.generation += 1;
    for (const launch of this.allLaunches) launch.rotate();
  }
  close(): void {
    this.generation += 1;
    for (const launch of this.allLaunches) launch.close();
  }

  private blockedGroup(
    slots: readonly AdvisorSlotPlan[],
    code: AdvisorContinuityCode | AdvisorJournalFailure,
  ): AdvisorGroupOutcome {
    const closed = code as AdvisorContinuityCode;
    return {
      summary: "blocked",
      slots: slots.map((plan) => ({
        slot: plan.slot,
        model: plan.model,
        status: "blocked" as const,
        context: "unknown" as const,
        code: closed,
        detail: advisorContinuityText(closed),
      })),
    };
  }

  private async runSlot(
    plan: AdvisorSlotPlan,
    input: AdvisorExecution,
    host: AgentLaunchHost,
    signal: AbortSignal | undefined,
    record: (attempt: ConsultationAttempt) => void,
    session: AdvisorJournalSession,
    generation: number,
  ): Promise<AdvisorSlotOutcome> {
    if (plan.kind === "unavailable")
      return {
        slot: plan.slot,
        model: plan.model,
        status: "unavailable",
        context: "unknown",
        detail: plan.cause,
      };

    const started = this.now();
    const existing = findAdvisorThread(session.partition(), input.task.taskToken, plan.slot);
    const matches =
      existing !== undefined && sameFingerprint(existing.fingerprint, plan.fingerprint);
    if (existing && !matches) {
      // A different model, profile, admission or build never continues another thread.
      await this.apply(session, (latest) =>
        upsertAdvisorThread(
          latest,
          { ...existing, state: "closed", reason: "fingerprint-changed", updatedAt: this.now() },
          this.now(),
        ),
      );
    }
    const thread = matches ? existing : undefined;
    const outcome =
      thread && thread.state === "answered"
        ? await this.continueThread(plan, thread, input, host, signal, session, generation)
        : await this.startThread(plan, thread, input, host, signal, session, generation);

    record({
      slot: plan.slot,
      model: plan.model,
      status:
        outcome.status === "complete"
          ? "completed"
          : outcome.status === "blocked"
            ? "blocked"
            : "unavailable",
      context: outcome.context,
      durationMs: this.now() - started,
    });
    return outcome;
  }

  /** First turn of a slot: the full preflight contract, then the retained execution run id. */
  private async startThread(
    plan: Extract<AdvisorSlotPlan, { kind: "launch" }>,
    thread: AdvisorThreadRecord | undefined,
    input: AdvisorExecution,
    host: AgentLaunchHost,
    signal: AbortSignal | undefined,
    session: AdvisorJournalSession,
    generation: number,
  ): Promise<AdvisorSlotOutcome> {
    // A first launch carries its own context and the Advisor never sees this conversation, so it
    // requires a brief. This is checked per slot, never for a continuation, which only sends the
    // question and evidence inside the thread it already has.
    if (!plan.request.brief?.trim())
      return {
        slot: plan.slot,
        model: plan.model,
        status: "unavailable",
        context: "fresh",
        code: "brief-required",
        detail: advisorContinuityText("brief-required"),
      };
    const ordinal = (thread?.ordinal ?? 0) + 1;
    const pending: AdvisorThreadRecord = {
      slot: plan.slot,
      taskToken: input.task.taskToken,
      fingerprint: plan.fingerprint,
      state: "pending",
      ordinal,
      runIds: thread?.runIds ?? [],
      updatedAt: this.now(),
    };
    if (!(await this.apply(session, (latest) => upsertAdvisorThread(latest, pending, this.now()))))
      return this.blocked(plan, "journal-write-failed");
    // A revocation during the pending write must stop the launch before it is emitted.
    if (!this.isCurrent(input, generation, signal)) return this.blocked(plan, "cancelled");

    let sent = false;
    const launch = async (request: AdvisorRequest) =>
      this.launchFor(plan).execute(request, host, signal, {
        beforeRequest: async () => {
          // Immediately before the request is emitted: the turn must be on disk and this group must
          // still be the live one. Both facts are read here, after every earlier await.
          const confirmed = await this.journal.confirmPending(
            input.task.parentKey,
            input.task.taskToken,
            plan.slot,
            ordinal,
          );
          if (!confirmed) return false;
          if (!this.isCurrent(input, generation, signal)) return false;
          sent = true;
          return true;
        },
      });

    const result = await launch(plan.request);
    if (result.kind !== "completed" && !this.isCurrent(input, generation, signal))
      return this.blocked(plan, "cancelled");

    if (result.kind === "completed") {
      const runId = result.runId;
      // A configuration or branch change while the child ran fences the answer: it belongs to a
      // task that no longer exists, and the turn may still be live.
      if (!this.isCurrent(input, generation, signal)) {
        await this.apply(session, (latest) =>
          upsertAdvisorThread(
            latest,
            { ...pending, state: "blocked", reason: "session-changed", updatedAt: this.now() },
            this.now(),
          ),
        ).catch(() => undefined);
        return this.blocked(plan, "cancelled");
      }
      const answered: AdvisorThreadRecord = {
        ...pending,
        state: runId ? "answered" : "blocked",
        reason: runId ? "answered" : "launch-failed",
        runIds: runId
          ? [...pending.runIds, runId].slice(-ADVISOR_THREAD_MAX_RUN_IDS)
          : pending.runIds,
        ...(runId ? { operationRunId: runId } : {}),
        mode: "fresh",
        updatedAt: this.now(),
      };
      // The answer is returned only once the turn is recorded; otherwise continuity would be a lie.
      if (
        !(await this.apply(session, (latest) => upsertAdvisorThread(latest, answered, this.now())))
      )
        return this.blocked(plan, "journal-write-failed");
      return {
        slot: plan.slot,
        model: plan.model,
        status: "complete",
        context: "fresh",
        answer: result.value,
        ...(runId
          ? {}
          : {
              code: "continuity-unavailable" as const,
              detail: advisorContinuityText("continuity-unavailable"),
            }),
      };
    }

    const closed = !sent || provesNoRun(result);
    const failed: AdvisorThreadRecord = {
      ...pending,
      state: closed ? "closed" : "blocked",
      reason: closed ? "launch-failed" : "resume-uncertain",
      updatedAt: this.now(),
    };
    await this.apply(session, (latest) => upsertAdvisorThread(latest, failed, this.now())).catch(
      () => undefined,
    );
    return {
      slot: plan.slot,
      model: plan.model,
      status: closed ? "unavailable" : "blocked",
      context: "fresh",
      detail: advisorFailureText(result),
    };
  }

  /** Next turn of a slot: public RPC resume, exact terminal check, own answer file. */
  private async continueThread(
    plan: Extract<AdvisorSlotPlan, { kind: "launch" }>,
    thread: AdvisorThreadRecord,
    input: AdvisorExecution,
    host: AgentLaunchHost,
    signal: AbortSignal | undefined,
    session: AdvisorJournalSession,
    generation: number,
  ): Promise<AdvisorSlotOutcome> {
    const previousRunId = thread.runIds.at(-1);
    if (!previousRunId) return this.blocked(plan, "status-unavailable");

    const ordinal = thread.ordinal + 1;
    const answerPath = advisorAnswerPath(
      this.outputRoot,
      input.task.parentKey,
      input.task.taskToken,
      plan.slot,
      ordinal,
    );
    const operationDirectory = dirname(answerPath);
    const reserved = await reserveAdvisorAnswer(answerPath, operationDirectory, this.outputRoot);
    if (reserved !== "reserved")
      return this.blocked(plan, reserved === "outside" ? "answer-outside" : "answer-occupied");

    const client = this.resumeFactory(host.events);
    const capability = await client.probe(host.sessionId);
    if (!capability.ok) return this.blocked(plan, capability.code);

    // The pending turn carries no current operation id: until a receipt is persisted, only an
    // ancestor run id exists, and an ancestor never proves this turn.
    const pending: AdvisorThreadRecord = {
      ...thread,
      state: "pending",
      ordinal,
      operationRunId: undefined,
      updatedAt: this.now(),
    };
    if (!(await this.apply(session, (latest) => upsertAdvisorThread(latest, pending, this.now()))))
      return this.blocked(plan, "journal-write-failed");
    // Immediately before the RPC send, after the probe, the reservation and the pending write.
    if (!this.isCurrent(input, generation, signal)) return this.blocked(plan, "cancelled");

    const receipt = await client.resume({
      runId: previousRunId,
      message: advisorContinuationMessage(input.consult),
      output: answerPath,
      knownRunIds: thread.runIds,
    });
    if (!receipt.ok) {
      await this.apply(session, (latest) =>
        upsertAdvisorThread(
          latest,
          { ...pending, state: "blocked", reason: "resume-refused", updatedAt: this.now() },
          this.now(),
        ),
      ).catch(() => undefined);
      return this.blocked(plan, receipt.code);
    }
    // Fencing at the receipt: a change of configuration or branch since the turn began means this
    // run is not ours to keep, even though the host already accepted it.
    if (!this.isCurrent(input, generation, signal)) {
      await client.stop(receipt.runId);
      await this.apply(session, (latest) =>
        upsertAdvisorThread(
          latest,
          {
            ...pending,
            state: "blocked",
            reason: "session-changed",
            operationRunId: receipt.runId,
            runIds: [...thread.runIds, receipt.runId].slice(-ADVISOR_THREAD_MAX_RUN_IDS),
            updatedAt: this.now(),
          },
          this.now(),
        ),
      ).catch(() => undefined);
      return this.blocked(plan, "cancelled");
    }

    // Acceptance is not an answer: the new run id is recorded before anything is awaited.
    const accepted: AdvisorThreadRecord = {
      ...pending,
      state: "accepted",
      operationRunId: receipt.runId,
      runIds: [...thread.runIds, receipt.runId].slice(-ADVISOR_THREAD_MAX_RUN_IDS),
      updatedAt: this.now(),
    };
    if (
      !(await this.apply(session, (latest) => upsertAdvisorThread(latest, accepted, this.now())))
    ) {
      // Without the receipt on disk this run would be unaccounted for; ask the host to stop it.
      await client.stop(receipt.runId);
      return this.blocked(plan, "journal-write-failed");
    }

    const identity: AdvisorTerminalIdentity = {
      agent: plan.fingerprint.profile,
      model: `${plan.fingerprint.provider}/${plan.fingerprint.model}`,
      thinking: plan.fingerprint.thinking,
    };
    const terminal = await this.awaitTerminal(
      client,
      receipt.runId,
      identity,
      signal,
      generation,
      input,
    );
    if (!terminal.ok) {
      await client.stop(receipt.runId);
      await this.apply(session, (latest) =>
        upsertAdvisorThread(
          latest,
          {
            ...accepted,
            state: "blocked",
            reason: terminal.code === "status-mismatch" ? "terminal-mismatch" : "resume-uncertain",
            updatedAt: this.now(),
          },
          this.now(),
        ),
      ).catch(() => undefined);
      return this.blocked(plan, terminal.code);
    }

    const answer = await readAdvisorAnswer(answerPath, operationDirectory, this.outputRoot);
    if (!answer.ok) {
      const code: AdvisorContinuityCode =
        answer.code === "answer-too-large"
          ? "answer-too-large"
          : answer.code === "answer-missing"
            ? "answer-missing"
            : "answer-invalid";
      // Terminal proof reconciles the activity, but a turn without a usable answer is never resumed:
      // the record stays blocked for this call, and the next consultation may close it once the host
      // proves the run terminal and start a new thread.
      await this.apply(session, (latest) =>
        upsertAdvisorThread(
          latest,
          { ...accepted, state: "blocked", reason: "answer-missing", updatedAt: this.now() },
          this.now(),
        ),
      ).catch(() => undefined);
      return this.blocked(plan, code);
    }

    const answered: AdvisorThreadRecord = {
      ...accepted,
      state: "answered",
      reason: "answered",
      updatedAt: this.now(),
    };
    // Fencing before the answer is recorded and returned: a stale turn never reaches the model.
    if (!this.isCurrent(input, generation, signal)) {
      await this.apply(session, (latest) =>
        upsertAdvisorThread(
          latest,
          { ...accepted, state: "blocked", reason: "session-changed", updatedAt: this.now() },
          this.now(),
        ),
      ).catch(() => undefined);
      return this.blocked(plan, "cancelled");
    }
    if (!(await this.apply(session, (latest) => upsertAdvisorThread(latest, answered, this.now()))))
      return this.blocked(plan, "journal-write-failed");
    await discardAdvisorAnswer(answerPath, operationDirectory, this.outputRoot);
    // Last guard before the answer leaves this function, after every await: a revocation observed
    // during the answer commit or the cleanup invalidates the turn instead of delivering it.
    if (!this.isCurrent(input, generation, signal)) {
      await this.apply(session, (latest) =>
        upsertAdvisorThread(
          latest,
          { ...accepted, state: "blocked", reason: "session-changed", updatedAt: this.now() },
          this.now(),
        ),
      ).catch(() => undefined);
      return this.blocked(plan, "cancelled");
    }
    return {
      slot: plan.slot,
      model: plan.model,
      status: "complete",
      context: thread.mode ?? "unknown",
      answer: answer.text,
    };
  }

  /**
   * Wait for the exact run id of this turn to reach a completed single-step terminal state. Host
   * events only wake this loop; every decision comes from a fresh status read.
   */
  private async awaitTerminal(
    client: AdvisorResumeClient,
    runId: string,
    identity: AdvisorTerminalIdentity,
    signal: AbortSignal | undefined,
    generation: number,
    input: AdvisorExecution,
  ): Promise<{ ok: true } | { ok: false; code: AdvisorContinuityCode }> {
    const deadline = this.now() + this.resumeTimeoutMs;
    let wake: (() => void) | undefined;
    const unsubscribe = client.onAsyncComplete(() => wake?.());
    const aborted = () => wake?.();
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      while (true) {
        if (!this.isCurrent(input, generation, signal)) return { ok: false, code: "cancelled" };
        const status = await client.status(runId);
        if (status.ok) {
          const verdict = advisorStatusVerdict(status.node, identity);
          if (verdict.kind === "complete") return { ok: true };
          if (verdict.kind === "failed") return { ok: false, code: verdict.code };
        }
        if (this.now() >= deadline) return { ok: false, code: "status-incomplete" };
        await new Promise<void>((resolveWait) => {
          const timer = this.setTimer(() => resolveWait(), this.pollIntervalMs);
          wake = () => {
            this.clearTimer(timer);
            resolveWait();
          };
        });
        wake = undefined;
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", aborted);
    }
  }

  private launchFor(
    plan: Extract<AdvisorSlotPlan, { kind: "launch" }>,
  ): AgentLaunch<AdvisorRequest, string> {
    const list =
      plan.request.providerExtension === "anthropic-auth"
        ? this.providerLaunches
        : plan.request.providerExtension === "admitted"
          ? this.admittedLaunches
          : this.launches;
    return list[plan.slot % MAX_ADVISORS]!;
  }

  private blocked(
    plan: Extract<AdvisorSlotPlan, { kind: "launch" }>,
    code: AdvisorContinuityCode,
  ): AdvisorSlotOutcome {
    return {
      slot: plan.slot,
      model: plan.model,
      status: "blocked",
      context: "unknown",
      code,
      detail: advisorContinuityText(code),
    };
  }

  /**
   * Settle what the host can prove is over. Nothing is closed on a guess: when a record is unresolved
   * and no bridge can be admitted, the journal is left exactly as it was and the guards below block as
   * they always did. A closing debt of a retired task needs no bridge and is paid here regardless.
   */
  private async reconcile(
    input: AdvisorExecution,
    host: AgentLaunchHost,
    session: AdvisorJournalSession,
    generation: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const partition = session.partition();
    const unresolved = unresolvedAdvisorThread(partition) !== undefined;
    const retiring = unclosedAdvisorTask(partition, input.task.taskToken) !== undefined;
    if (!unresolved && !retiring) return true;

    // A closing debt is local: it needs no host, so a bridge that cannot be admitted must not hold it.
    const evidence = unresolved ? await this.continuityEvidence(host) : undefined;
    if (unresolved && evidence === undefined) return true;

    const plan = await planAdvisorContinuity({
      partition,
      activeTaskToken: input.task.taskToken,
      evidence: evidence ?? UNANSWERABLE_EVIDENCE,
    });
    // Holds alone write nothing: rewriting the journal with identical bytes would only add contention.
    if (isAdvisorContinuityPlanEmpty(plan)) return true;
    if (!this.isCurrent(input, generation, signal)) return false;
    await this.apply(session, (latest) => applyAdvisorContinuity(latest, plan, this.now()));
    return true;
  }

  /**
   * The host questions a reconciliation may ask, after admitting the same bridge a continuation needs:
   * a bridge that cannot be admitted here answers nothing about its own runs either. A slot that then
   * resumes admits the bridge again on its own, because a continuation checks the advertisement it
   * uses instead of trusting this pass.
   */
  private async continuityEvidence(
    host: AgentLaunchHost,
  ): Promise<AdvisorContinuityEvidence | undefined> {
    const client = this.resumeFactory(host.events);
    const capability = await client.probe(host.sessionId);
    if (!capability.ok) return undefined;
    return {
      runState: (runId) => client.runState(runId),
      runs: () => client.runs(),
    };
  }

  /** Apply one transition and report whether it reached the journal. */
  private async apply(
    session: AdvisorJournalSession,
    update: Parameters<AdvisorJournalSession["mutate"]>[0],
  ): Promise<boolean> {
    try {
      await session.mutate(update);
      return true;
    } catch {
      return false;
    }
  }
}

import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentLaunch,
  LAUNCH_PREFLIGHT_TIMEOUT_MS,
  LAUNCH_TERMINAL_TIMEOUT_MS,
  type AgentLaunchDefinition,
  type AgentLaunchDependencies,
  type AgentLaunchFailure,
  type AgentLaunchHost,
  type AgentLaunchRequest,
  type AgentLaunchResult,
  type AgentLaunchTerminalField,
  type AgentLaunchTerminalStatus,
} from "./agent-launch.ts";
import type { AdvisorContext } from "./prompt.ts";
import type { AdvisorSetting, ThinkingLevelName } from "./types.ts";
import type { ConsultationAttempt } from "./advisor-log.ts";
import {
  ANTHROPIC_ADVISOR_AGENT,
  ANTHROPIC_ADVISOR_EXTENSION,
} from "./advisor-anthropic-provider.ts";

/**
 * `pi-subagents` builds whose launch contract was checked against this profile: the original pin and
 * the build that only changed its own package version (same contract version, profile projection,
 * tool plan, runtime lists and fork wrapper). A different build is rejected before any request.
 */
const ADMITTED_SUBAGENTS_VERSIONS: readonly string[] = ["0.76.1", "0.83.1"];

export const ADVISOR_AGENT_NAME = "pi-delegation-policy.advisor";
export type AdvisorRequest = AgentLaunchRequest & {
  question: string;
  brief?: string;
  context: AdvisorContext;
  providerExtension?: "anthropic-auth";
};
export type AdvisorAnswer = {
  model: string;
  result: AgentLaunchResult<string>;
  context: AdvisorContext;
};
const DEFINITION: AgentLaunchDefinition<AdvisorRequest, string> = {
  agentName: ADVISOR_AGENT_NAME,
  agentPath: resolve(
    fileURLToPath(new URL("../agents/pi-delegation-policy.advisor.md", import.meta.url)),
  ),
  admittedProtocolVersions: ADMITTED_SUBAGENTS_VERSIONS,
  allowFork: true,
  internalTools: [],
  buildTask: (request) =>
    request.context === "fork"
      ? request.question
      : JSON.stringify({ question: request.question, brief: request.brief }),
  result: {
    variant: "text",
    isValue: (value): value is string => typeof value === "string" && value.trim().length > 0,
  },
};

export function advisorAgentName(
  setting: Pick<AdvisorSetting, "provider" | "model" | "providerExtension">,
): string {
  return setting.providerExtension === "anthropic-auth"
    ? ANTHROPIC_ADVISOR_AGENT
    : ADVISOR_AGENT_NAME;
}
const ANTHROPIC_DEFINITION: AgentLaunchDefinition<AdvisorRequest, string> = {
  ...DEFINITION,
  agentName: ANTHROPIC_ADVISOR_AGENT,
  agentPath: fileURLToPath(
    new URL("../agents/pi-delegation-policy.advisor-anthropic-auth.md", import.meta.url),
  ),
  configuredExtensions: [ANTHROPIC_ADVISOR_EXTENSION],
};

export function advisorThinking(setting: AdvisorSetting, model: Model<Api>): ThinkingLevelName {
  if (setting.thinking)
    return "level" in setting.thinking ? setting.thinking.level : setting.thinking.max;
  const supported = getSupportedThinkingLevels(model);
  return supported.includes("high") ? "high" : supported[0]!;
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
    case "fork-task-normalizer-unavailable":
      return "Fork launch is unavailable: the installed pi-subagents does not export wrapForkTask, so a fork task cannot be bound to the child. Retrying or supplying a brief will not switch this session to fresh; install an admitted pi-subagents build and reload the session.";
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
    case "fork-not-allowed":
      return "This launch cannot use fork context: the packaged profile does not allow it, and a brief does not change that. Check the installed package version and reload the session.";
    case "launch-closed":
      return "Advisor launch is closed for this session. Reload the session, then retry.";
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
    case "unavailable-context":
      return "Fork unavailable. Call again with brief for a fresh consultation.";
    case "busy":
      return "Advisor busy: another consultation group is already in flight.";
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
 * One pending call per tool: an advisor group launches one child per configured advisor. The
 * independent reader may hold its own pending call, so together they can own three children.
 */
export class AdvisorExecutor {
  private readonly launches: AgentLaunch<AdvisorRequest, string>[];
  private readonly providerLaunches: AgentLaunch<AdvisorRequest, string>[];
  private pending = false;
  private generation = 0;

  constructor(dependencies: AgentLaunchDependencies = {}) {
    this.launches = [
      new AgentLaunch(DEFINITION, dependencies),
      new AgentLaunch(DEFINITION, dependencies),
    ];
    this.providerLaunches = [
      new AgentLaunch(ANTHROPIC_DEFINITION, dependencies),
      new AgentLaunch(ANTHROPIC_DEFINITION, dependencies),
    ];
  }
  get busy(): boolean {
    return this.pending;
  }

  async execute(
    requests: readonly AdvisorRequest[],
    host: AgentLaunchHost,
    signal: AbortSignal | undefined,
    record: (attempt: ConsultationAttempt) => void,
  ): Promise<AdvisorAnswer[]> {
    if (this.pending) return [];
    this.pending = true;
    const generation = this.generation;
    try {
      return await Promise.all(
        requests.map(async (request, index) => {
          const model = `${request.model.provider}/${request.model.id}`;
          const launch = (
            request.providerExtension === "anthropic-auth" ? this.providerLaunches : this.launches
          )[index]!;
          let context = request.context;
          const attempt = async (input: AdvisorRequest) => {
            const start = Date.now();
            const result = await launch.execute(input, host, signal);
            record({
              model,
              status: result.kind,
              context: input.context,
              durationMs: Date.now() - start,
            });
            return result;
          };
          let result = await attempt(request);
          // Only an explicit context rejection proves no run was admitted. Never retry uncertain failures.
          if (
            result.kind === "unavailable-context" &&
            request.context === "fork" &&
            request.brief &&
            generation === this.generation &&
            !signal?.aborted
          ) {
            context = "fresh";
            result = await attempt({ ...request, context });
          }
          if (generation !== this.generation) result = { kind: "cancelled" };
          return { model, result, context };
        }),
      );
    } finally {
      this.pending = false;
    }
  }
  cancel(): void {
    this.generation += 1;
    for (const launch of [...this.launches, ...this.providerLaunches]) launch.cancel();
  }
  rotate(): void {
    this.generation += 1;
    for (const launch of [...this.launches, ...this.providerLaunches]) launch.rotate();
  }
  close(): void {
    this.generation += 1;
    for (const launch of [...this.launches, ...this.providerLaunches]) launch.close();
  }
}

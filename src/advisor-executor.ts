import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentLaunch,
  type AgentLaunchDefinition,
  type AgentLaunchDependencies,
  type AgentLaunchHost,
  type AgentLaunchRequest,
  type AgentLaunchResult,
} from "./agent-launch.ts";
import type { AdvisorContext } from "./prompt.ts";
import type { AdvisorSetting, ThinkingLevelName } from "./types.ts";
import type { ConsultationAttempt } from "./advisor-log.ts";

export const ADVISOR_AGENT_NAME = "pi-delegation-policy.advisor";
export type AdvisorRequest = AgentLaunchRequest & {
  question: string;
  brief?: string;
  context: AdvisorContext;
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
  protocolVersion: "0.76.1",
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

export function advisorThinking(setting: AdvisorSetting, model: Model<Api>): ThinkingLevelName {
  if (setting.thinking)
    return "level" in setting.thinking ? setting.thinking.level : setting.thinking.max;
  const supported = getSupportedThinkingLevels(model);
  return supported.includes("high") ? "high" : supported[0]!;
}

/**
 * One pending call per tool: an advisor group launches one child per configured advisor. The
 * independent reader may hold its own pending call, so together they can own three children.
 */
export class AdvisorExecutor {
  private readonly launches: AgentLaunch<AdvisorRequest, string>[];
  private pending = false;
  private generation = 0;

  constructor(dependencies: AgentLaunchDependencies = {}) {
    this.launches = [
      new AgentLaunch(DEFINITION, dependencies),
      new AgentLaunch(DEFINITION, dependencies),
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
          const launch = this.launches[index]!;
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
    for (const launch of this.launches) launch.cancel();
  }
  rotate(): void {
    this.generation += 1;
    for (const launch of this.launches) launch.rotate();
  }
  close(): void {
    this.generation += 1;
    for (const launch of this.launches) launch.close();
  }
}

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ADVISOR_AGENT_NAME, advisorAgentName } from "./advisor-executor.ts";
import { ANTHROPIC_ADVISOR_AGENT } from "./advisor-anthropic-provider.ts";
import { PROVIDER_EXTENSION_ADVISOR_AGENT } from "./advisor-provider-extension.ts";
import {
  enabledOrdinaryRoles,
  hasRuntimeError,
  isAdvisorEnabled,
  type RuntimeState,
  validAdvisors,
} from "./runtime.ts";
import {
  ROLE_LABELS,
  THINKING_LEVEL_NAMES,
  type ModelRef,
  type ModelRole,
  type ThinkingLevelName,
  type ThinkingPolicy,
} from "./types.ts";

const ADVISOR_AGENTS: ReadonlySet<string> = new Set([
  ADVISOR_AGENT_NAME,
  ANTHROPIC_ADVISOR_AGENT,
  PROVIDER_EXTENSION_ADVISOR_AGENT,
]);
/**
 * Keys that carry children. With `action` the host runs a control or management operation, where
 * `agent` and `task` only name a target and `validate` checks a workflow without running it.
 */
const LAUNCH_CARRIERS = ["tasks", "chain"] as const;

type Child = { agent?: unknown; model?: unknown };
type Role = ModelRole | "uiDesign";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reference(setting: ModelRef): string {
  return `${setting.provider}/${setting.model}`;
}

/** `provider/model:LEVEL` → base and level; a trailing segment that is not a level stays in the id. */
function splitModel(model: string): { base: string; level?: ThinkingLevelName } {
  const index = model.lastIndexOf(":");
  const level = index > 0 ? model.slice(index + 1) : "";
  return (THINKING_LEVEL_NAMES as readonly string[]).includes(level)
    ? { base: model.slice(0, index), level: level as ThinkingLevelName }
    : { base: model };
}

function inPolicy(level: ThinkingLevelName, policy: ThinkingPolicy | undefined): boolean {
  if (!policy) return true;
  if ("level" in policy) return level === policy.level;
  const order = THINKING_LEVEL_NAMES as readonly string[];
  return (
    order.indexOf(level) >= order.indexOf(policy.min) &&
    order.indexOf(level) <= order.indexOf(policy.max)
  );
}

function policyText(policy: ThinkingPolicy | undefined): string {
  if (!policy) return "LEVEL";
  return "level" in policy ? policy.level : `LEVEL in ${policy.min}..${policy.max}`;
}

function enabledRoles(state: RuntimeState): Role[] {
  return [
    ...enabledOrdinaryRoles(state.effective),
    ...(state.effective.uiDesign ? ["uiDesign" as const] : []),
  ];
}

function roleSetting(state: RuntimeState, role: Role): ModelRef {
  return state.effective[role] as ModelRef;
}

/** The exact launches this policy accepts, so a refusal tells the model how to retry. */
function allowedLines(state: RuntimeState, delegation: boolean): string {
  const lines = [
    ...(delegation
      ? enabledRoles(state).map(
          (role) =>
            `- ${ROLE_LABELS[role]}: model "${reference(roleSetting(state, role))}:${policyText(state.effective.thinking[role])}"`,
        )
      : []),
    ...validAdvisors(state).map(
      ({ index, setting }) =>
        `- Advisor ${index + 1}: agent "${advisorAgentName(setting, state.admissions)}", model "${reference(setting)}:LEVEL"`,
    ),
  ];
  return lines.length
    ? `Allowed launches:\n${lines.join("\n")}`
    : "No launch is allowed right now.";
}

function checkThinking(
  level: ThinkingLevelName | undefined,
  supported: readonly string[] | undefined,
  policy: ThinkingPolicy | undefined,
): string | undefined {
  if (!level) return "it has no thinking level; append :LEVEL to the model";
  if (supported && !supported.includes(level))
    return `the model does not support thinking "${level}"`;
  if (!inPolicy(level, policy)) return `thinking "${level}" is outside the role policy`;
  return undefined;
}

function checkAdvisorChild(
  state: RuntimeState,
  agent: string,
  base: string,
  level?: ThinkingLevelName,
): string | undefined {
  const match = validAdvisors(state).find(
    ({ setting }) =>
      reference(setting) === base && advisorAgentName(setting, state.admissions) === agent,
  );
  if (!isAdvisorEnabled(state.effective))
    return `the Advisor role is off, so agent "${agent}" cannot launch`;
  if (!match)
    return `agent "${agent}" with model "${base}" is not a configured Advisor; each Advisor uses its exact model with its own profile`;
  return checkThinking(level, getSupportedThinkingLevels(match.model), undefined);
}

function checkOrdinaryChild(
  state: RuntimeState,
  base: string,
  level?: ThinkingLevelName,
): string | undefined {
  const candidates = enabledRoles(state).filter(
    (role) => reference(roleSetting(state, role)) === base,
  );
  if (!candidates.length) {
    const advisor = validAdvisors(state).some(({ setting }) => reference(setting) === base);
    return advisor
      ? `model "${base}" belongs only to an Advisor; Advisors launch with their own profile and never execute work`
      : `model "${base}" is not the model of any enabled role (use the exact provider/model form)`;
  }
  // A role passes when its model supports the level and its policy allows it.
  const failures = candidates.map((role) => {
    const status = state.modelStatuses.get(role);
    const supported =
      status?.kind === "available" ? getSupportedThinkingLevels(status.model) : undefined;
    const why = checkThinking(level, supported, state.effective.thinking[role]);
    return why && `${ROLE_LABELS[role]}: ${why}`;
  });
  return failures.every(Boolean) ? failures.join("; ") : undefined;
}

/**
 * Refuses a `subagent` call that does not follow the active policy, before anything launches.
 * It sees only what the call states: the decision to delegate, and launches made inside a
 * workflow script, stay with the main agent. Returns the refusal reason, or undefined to allow.
 */
export function checkSubagentLaunch(
  input: unknown,
  state: RuntimeState | undefined,
): string | undefined {
  if (!state || !isRecord(input)) return undefined;
  const delegation = state.effective.intensity !== "off";
  const advisor = isAdvisorEnabled(state.effective);
  if (!delegation && !advisor) return undefined;
  const refuse = (why: string) =>
    `Launch refused by the delegation policy: ${why}. Nothing was launched.\n${allowedLines(state, delegation)}`;

  if (typeof input.action === "string") {
    return delegation && LAUNCH_CARRIERS.some((key) => input[key] !== undefined)
      ? refuse("a control action cannot also carry children")
      : undefined;
  }
  if (delegation && hasRuntimeError(state))
    return refuse("the delegation configuration is invalid; fix it in /delegate before launching");

  // A script chooses its models in code this policy cannot read, inline or through options.script.
  const script =
    (input.workflow !== undefined && input.workflow !== "parallel") ||
    (isRecord(input.options) && input.options.script !== undefined);
  if (script)
    return delegation
      ? refuse(
          'workflow scripts hide each child\'s model; launch one child, use tasks or chain, or workflow "parallel" with every model stated',
        )
      : undefined;

  let children: unknown[];
  if (input.workflow === "parallel") {
    const tasks = isRecord(input.args) ? input.args.tasks : undefined;
    if (!Array.isArray(tasks) || !tasks.length)
      return refuse("a parallel workflow needs args.tasks");
    children = tasks;
  } else if (Array.isArray(input.chain)) {
    // A chain step is one child or a parallel group; every model is stated in the call.
    children = input.chain.flatMap((step) =>
      isRecord(step) && Array.isArray(step.parallel) ? step.parallel : [step],
    );
  } else if (Array.isArray(input.tasks)) children = input.tasks;
  else children = [input];
  // The host applies a top-level model to every child that states none.
  const shared = typeof input.model === "string" ? input.model : undefined;

  // The whole call is checked first: no partial launch.
  for (const [index, entry] of children.entries()) {
    if (!isRecord(entry)) return refuse(`child ${index + 1} is not an object`);
    const child: Child = entry.model === undefined && shared ? { ...entry, model: shared } : entry;
    const label = children.length > 1 ? `child ${index + 1}: ` : "";
    const agent = typeof child.agent === "string" ? child.agent : "";
    const isAdvisorAgent = ADVISOR_AGENTS.has(agent);
    if (!isAdvisorAgent && !delegation) continue;
    if (typeof child.model !== "string" || !child.model.trim())
      return refuse(
        `${label}no model was given; state the exact role model, never an inherited default`,
      );
    const { base, level } = splitModel(child.model.trim());
    const why = isAdvisorAgent
      ? checkAdvisorChild(state, agent, base, level)
      : checkOrdinaryChild(state, base, level);
    if (why) return refuse(`${label}${why}`);
  }
  return undefined;
}

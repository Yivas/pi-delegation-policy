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

type Role = ModelRole | "uiDesign";

/** Closed causes a launch is refused for; the local log records the code, never the message. */
export type LaunchRefusalCode =
  | "control-with-children"
  | "invalid-config"
  | "workflow-script"
  | "missing-children"
  | "invalid-child"
  | "missing-model"
  | "wrong-model"
  | "missing-thinking"
  | "thinking-unsupported"
  | "thinking-outside-policy"
  | "advisor-mismatch"
  | "advisor-off";
/** The role a child executes, or `unknown` when its model is not an enabled role's. */
export type LaunchChildRole = Role | "advisor" | "unknown";
type Refusal = { code: LaunchRefusalCode; message: string };
/** What one subagent call states: whether it launches, its refusal, and one role code per child. */
export type SubagentLaunchCheck = {
  /** False for a control or management action, which names a target and launches no child. */
  launch: boolean;
  refusal: Refusal | undefined;
  children: readonly LaunchChildRole[];
};
/** The children a call states, each already carrying the model the host will run. */
type StatedChildren = { entries: unknown[] };

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

/**
 * Configured Advisors the runtime already rejected, with the reason it recorded. A slot that failed
 * validation is not an unconfigured one, and the refusal must not report it as such.
 */
function unavailableAdvisorLines(state: RuntimeState): string[] {
  return (state.advisorEntries ?? []).flatMap(({ index, errors }) =>
    errors.length ? [`- Advisor ${index + 1}: ${errors.join(" ")}`] : [],
  );
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
  const unavailable = unavailableAdvisorLines(state);
  return [
    lines.length ? `Allowed launches:\n${lines.join("\n")}` : "No launch is allowed right now.",
    ...(unavailable.length ? [`Configured but unavailable:\n${unavailable.join("\n")}`] : []),
  ].join("\n");
}

function checkThinking(
  level: ThinkingLevelName | undefined,
  supported: readonly string[] | undefined,
  policy: ThinkingPolicy | undefined,
): Refusal | undefined {
  if (!level)
    return {
      code: "missing-thinking",
      message: "it has no thinking level; append :LEVEL to the model",
    };
  if (supported && !supported.includes(level)) {
    const available = supported.length
      ? `supported levels: ${supported.join(", ")}`
      : "no level is supported";
    return {
      code: "thinking-unsupported",
      message: `the model does not support thinking "${level}" (${available})`,
    };
  }
  if (!inPolicy(level, policy))
    return {
      code: "thinking-outside-policy",
      message: `thinking "${level}" is outside the role policy`,
    };
  return undefined;
}

function checkAdvisorChild(
  state: RuntimeState,
  agent: string,
  base: string,
  level?: ThinkingLevelName,
): Refusal | undefined {
  const match = validAdvisors(state).find(
    ({ setting }) =>
      reference(setting) === base && advisorAgentName(setting, state.admissions) === agent,
  );
  if (!isAdvisorEnabled(state.effective))
    return {
      code: "advisor-off",
      message: `the Advisor role is off, so agent "${agent}" cannot launch`,
    };
  if (!match)
    return {
      code: "advisor-mismatch",
      message: `agent "${agent}" with model "${base}" is not a configured Advisor; each Advisor uses its exact model with its own profile`,
    };
  return checkThinking(level, getSupportedThinkingLevels(match.model), undefined);
}

function checkOrdinaryChild(
  state: RuntimeState,
  base: string,
  level?: ThinkingLevelName,
): Refusal | undefined {
  const candidates = enabledRoles(state).filter(
    (role) => reference(roleSetting(state, role)) === base,
  );
  if (!candidates.length) {
    const advisor = validAdvisors(state).some(({ setting }) => reference(setting) === base);
    return {
      code: "wrong-model",
      message: advisor
        ? `model "${base}" belongs only to an Advisor; Advisors launch with their own profile and never execute work`
        : `model "${base}" is not the model of any enabled role (use the exact provider/model form)`,
    };
  }
  // A role passes when its model supports the level and its policy allows it, so the level is
  // refused only when every role sharing the model rejects it.
  const failures = candidates.flatMap((role) => {
    const status = state.modelStatuses.get(role);
    const supported =
      status?.kind === "available" ? getSupportedThinkingLevels(status.model) : undefined;
    const why = checkThinking(level, supported, state.effective.thinking[role]);
    return why ? [{ code: why.code, message: `${ROLE_LABELS[role]}: ${why.message}` }] : [];
  });
  if (failures.length !== candidates.length) return undefined;
  // The code names the first failing role; the message lists every failure.
  return {
    code: failures[0].code,
    message: failures.map((failure) => failure.message).join("; "),
  };
}

/**
 * The children a call states, or undefined when a parallel workflow states none. The host applies a
 * top-level `model` to every child that states none, so the shared model is resolved here once and
 * every reader of the call sees the same models.
 */
export function statedChildren(input: Record<string, unknown>): StatedChildren | undefined {
  const shared = typeof input.model === "string" ? input.model : undefined;
  let entries: unknown[];
  if (input.workflow === "parallel") {
    const tasks = isRecord(input.args) ? input.args.tasks : undefined;
    if (!Array.isArray(tasks) || !tasks.length) return undefined;
    entries = tasks;
  } else if (Array.isArray(input.chain)) {
    // A chain step is one child or a parallel group; every model is stated in the call.
    entries = input.chain.flatMap((step) =>
      isRecord(step) && Array.isArray(step.parallel) ? step.parallel : [step],
    );
  } else entries = Array.isArray(input.tasks) ? input.tasks : [input];
  return {
    entries: entries.map((entry) =>
      shared && isRecord(entry) && entry.model === undefined ? { ...entry, model: shared } : entry,
    ),
  };
}

/** One role code per child, read from the model that child states. */
function childRoles(state: RuntimeState, stated: StatedChildren): LaunchChildRole[] {
  return stated.entries.map((entry) => {
    if (!isRecord(entry)) return "unknown";
    if (ADVISOR_AGENTS.has(typeof entry.agent === "string" ? entry.agent : "")) return "advisor";
    if (typeof entry.model !== "string" || !entry.model.trim()) return "unknown";
    const { base } = splitModel(entry.model.trim());
    const role = enabledRoles(state).find(
      (candidate) => reference(roleSetting(state, candidate)) === base,
    );
    return role ?? "unknown";
  });
}

/**
 * Checks a `subagent` call against the active policy, before anything launches. It sees only what
 * the call states: the decision to delegate, and launches made inside a workflow script, stay with
 * the main agent. The refusal carries a closed code and the children carry role codes, so the
 * content-free log can record both without reading a task, a path or a message.
 */
export function inspectSubagentLaunch(
  input: unknown,
  state: RuntimeState | undefined,
): SubagentLaunchCheck {
  const allowed = (
    children: readonly LaunchChildRole[] = [],
    launch = true,
  ): SubagentLaunchCheck => ({ launch, refusal: undefined, children });
  if (!state || !isRecord(input)) return allowed();
  const delegation = state.effective.intensity !== "off";
  const advisor = isAdvisorEnabled(state.effective);
  if (!delegation && !advisor) return allowed();
  const refuse = (
    code: LaunchRefusalCode,
    why: string,
    children: readonly LaunchChildRole[] = [],
  ): SubagentLaunchCheck => ({
    launch: true,
    refusal: {
      code,
      message: `Launch refused by the delegation policy: ${why}. Nothing was launched.\n${allowedLines(state, delegation)}`,
    },
    children,
  });

  if (typeof input.action === "string") {
    if (!delegation || !LAUNCH_CARRIERS.some((key) => input[key] !== undefined))
      return allowed([], false);
    const stated = statedChildren(input);
    return refuse(
      "control-with-children",
      "a control action cannot also carry children",
      stated ? childRoles(state, stated) : [],
    );
  }
  // An invalid delegation configuration refuses ordinary children only: a valid Advisor keeps
  // working, as the consultation-only policy block still asks for it.
  const invalid = delegation && hasRuntimeError(state);

  // A script chooses its models in code this policy cannot read, inline or through options.script.
  const script =
    (input.workflow !== undefined && input.workflow !== "parallel") ||
    (isRecord(input.options) && input.options.script !== undefined);
  if (script)
    return delegation
      ? refuse(
          "workflow-script",
          'workflow scripts hide each child\'s model; launch one child, use tasks or chain, or workflow "parallel" with every model stated',
        )
      : allowed();

  const stated = statedChildren(input);
  if (!stated) return refuse("missing-children", "a parallel workflow needs args.tasks");
  const children = childRoles(state, stated);

  // The whole call is checked first: no partial launch.
  for (const [index, entry] of stated.entries.entries()) {
    if (!isRecord(entry))
      return refuse("invalid-child", `child ${index + 1} is not an object`, children);
    const label = stated.entries.length > 1 ? `child ${index + 1}: ` : "";
    const agent = typeof entry.agent === "string" ? entry.agent : "";
    const isAdvisorAgent = ADVISOR_AGENTS.has(agent);
    if (!isAdvisorAgent && !delegation) continue;
    if (!isAdvisorAgent && invalid)
      return refuse(
        "invalid-config",
        `${label}the delegation configuration is invalid; fix it in /delegate before launching`,
        children,
      );
    if (typeof entry.model !== "string" || !entry.model.trim())
      return refuse(
        "missing-model",
        `${label}no model was given; state the exact role model, never an inherited default`,
        children,
      );
    const { base, level } = splitModel(entry.model.trim());
    const why = isAdvisorAgent
      ? checkAdvisorChild(state, agent, base, level)
      : checkOrdinaryChild(state, base, level);
    if (why) return refuse(why.code, `${label}${why.message}`, children);
  }
  return allowed(children);
}

/**
 * Refuses a `subagent` call that does not follow the active policy, before anything launches.
 * Returns the refusal reason, or undefined to allow; `inspectSubagentLaunch` adds the code and the
 * role of each child.
 */
export function checkSubagentLaunch(
  input: unknown,
  state: RuntimeState | undefined,
): string | undefined {
  return inspectSubagentLaunch(input, state).refusal?.message;
}

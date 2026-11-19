import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { ADVISOR_AGENT_NAME, ADVISOR_READ_AGENT_NAME } from "./advisor-executor.ts";
import { ANTHROPIC_ADVISOR_AGENT } from "./advisor-anthropic-provider.ts";
import { PROVIDER_EXTENSION_ADVISOR_AGENT } from "./advisor-provider-extension.ts";
import { DEFAULT_LAUNCH_CORRECTION_MODE } from "./launch-correction-mode.ts";
import {
  enabledOrdinaryRoles,
  hasRuntimeError,
  isAdvertisedOptionalEntry,
  advisorAgentNameFor,
  isAdvisorEnabled,
  isOptionalEntryModelUsable,
  isRoleEnabled,
  type RuntimeState,
  validAdvisors,
} from "./runtime.ts";
import {
  OPTIONAL_ROLE_ENTRY_KEYS,
  ROLE_LABELS,
  THINKING_LEVEL_NAMES,
  type AdvisorSetting,
  type ModelRef,
  type ModelRole,
  type OptionalRoleEntryKey,
  type ThinkingLevelName,
  type ThinkingPolicy,
} from "./types.ts";

const ADVISOR_AGENTS: ReadonlySet<string> = new Set([
  ADVISOR_AGENT_NAME,
  ADVISOR_READ_AGENT_NAME,
  ANTHROPIC_ADVISOR_AGENT,
  PROVIDER_EXTENSION_ADVISOR_AGENT,
]);
/**
 * Keys that carry children. With `action` the host runs a control or management operation, where
 * `agent` and `task` only name a target and `validate` checks a workflow without running it.
 */
const LAUNCH_CARRIERS = ["tasks", "chain"] as const;
/**
 * Role names a launch may state in place of a model, lower-cased. The set is closed, so a typo stays
 * an unknown model instead of being read as something else.
 */
const ROLE_ALIASES: ReadonlyMap<string, { role: Role } | { advisor: number }> = new Map([
  ["small", { role: "small" }],
  ["medium", { role: "medium" }],
  ["large", { role: "large" }],
  ["visual-design", { role: "uiDesign" }],
  ["ui-design", { role: "uiDesign" }],
  ["uidesign", { role: "uiDesign" }],
  ["visual-design-2", { role: "uiDesign2" }],
  ["visual-design-3", { role: "uiDesign3" }],
  // `/delegate status` prints the family as `ui-design-2`, so that spelling launches too.
  ["ui-design-2", { role: "uiDesign2" }],
  ["ui-design-3", { role: "uiDesign3" }],
  ["vision", { role: "vision" }],
  ["vision-2", { role: "vision2" }],
  ["vision-3", { role: "vision3" }],
  ["advisor", { advisor: 0 }],
  ["advisor-1", { advisor: 0 }],
  ["advisor-2", { advisor: 1 }],
  ["advisor-3", { advisor: 2 }],
]);

type Role = ModelRole | OptionalRoleEntryKey;

/**
 * A stated role name is matched case-insensitively and with spaces for dashes, because the block
 * prints labels such as "Vision 2" or "Visual Design 2" while the alias set is spelled in dashes.
 * Every dash spelling keeps working unchanged.
 */
function roleAlias(base: string): { role: Role } | { advisor: number } | undefined {
  return ROLE_ALIASES.get(base.trim().toLowerCase().replace(/\s+/g, "-"));
}

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
  | "advisor-off"
  | "advisor-fork-context"
  | "shared-model-conflict";
/** Closed kinds of correction the guard applies instead of refusing an unambiguous call. */
export type LaunchCorrectionCode = "level-added" | "advisor-profile" | "role-alias";
/** One applied correction: what the call stated, what the host now runs, and where. */
export type LaunchCorrection = {
  code: LaunchCorrectionCode;
  /** The role name the call stated, when the correction replaced one. */
  roleName?: string;
  /** The exact value the launch now uses. */
  applied: string;
  /** The 1-based child this covers; absent when the call's shared top-level model changed. */
  child?: number;
};
/** The role a child executes, or `unknown` when its model is not an enabled role's. */
export type LaunchChildRole = Role | "advisor" | "unknown";
type Refusal = { code: LaunchRefusalCode; message: string };
/** What one subagent call states: whether it launches, its refusal, and one role code per child. */
export type SubagentLaunchCheck = {
  /** False for a control or management action, which names a target and launches no child. */
  launch: boolean;
  refusal: Refusal | undefined;
  children: readonly LaunchChildRole[];
  /** Corrections already written into the call, in the order they were applied. */
  corrections: readonly LaunchCorrection[];
  /** What the agent must be told about them, or undefined when the call was left alone. */
  note: string | undefined;
};
/** One child of a call: the object the host runs, and the model it applies to that child. */
export type StatedChild = {
  /** The child object, or undefined when the call states something that is not an object. */
  entry: Record<string, unknown> | undefined;
  /** The model the host runs for this child: its own, or the call's shared top-level model. */
  model: string | undefined;
  /** True when the model comes from the call's top-level `model`, not from the child. */
  sharedModel: boolean;
};
/** The children a call states, each already carrying the model the host will run. */
type StatedChildren = { children: StatedChild[] };

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

/**
 * The roles a launch could name right now: the enabled ordinary ones plus every configured optional
 * entry, including one whose model the launch checks refuse. Exported so a report of what was
 * launched agrees with the guard instead of restating it.
 */
export function enabledRoles(state: RuntimeState): Role[] {
  return [
    ...enabledOrdinaryRoles(state.effective),
    ...OPTIONAL_ROLE_ENTRY_KEYS.filter((key) => state.effective[key] !== undefined),
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

function isOptionalEntry(role: Role): role is OptionalRoleEntryKey {
  return OPTIONAL_ROLE_ENTRY_KEYS.some((key) => key === role);
}

/**
 * The exact launches this policy accepts, so a refusal tells the model how to retry. An optional entry
 * appears only while it could launch: the same guard refuses one whose model resolved to a
 * non-available status, so listing it would contradict the refusal.
 */
function allowedLines(state: RuntimeState, delegation: boolean): string {
  const lines = [
    ...(delegation
      ? enabledRoles(state)
          // An entry whose model this guard refuses is not an allowed launch; an ordinary role keeps
          // its line, because an invalid configuration is already reported as the reason.
          .filter((role) => !isOptionalEntry(role) || isAdvertisedOptionalEntry(state, role))
          .map(
            (role) =>
              `- ${ROLE_LABELS[role]}: model "${reference(roleSetting(state, role))}:${policyText(state.effective.thinking[role])}"`,
          )
      : []),
    ...validAdvisors(state).map(
      ({ index, setting }) =>
        `- Advisor ${index + 1}: agent "${advisorAgentNameFor(state, setting, index)}", model "${reference(setting)}:LEVEL"`,
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
    ({ setting, index }) =>
      reference(setting) === base && advisorAgentNameFor(state, setting, index) === agent,
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

/**
 * The level a role the call named accepts. A role name binds its own policy even when another role
 * shares the model, so this never falls back to the any-role acceptance of an exact reference.
 */
function checkNamedRole(
  state: RuntimeState,
  role: Role,
  level?: ThinkingLevelName,
): Refusal | undefined {
  const status = state.modelStatuses.get(role);
  const supported =
    status?.kind === "available" ? getSupportedThinkingLevels(status.model) : undefined;
  const why = checkThinking(level, supported, state.effective.thinking[role]);
  return why ? { code: why.code, message: `${ROLE_LABELS[role]}: ${why.message}` } : undefined;
}

function checkOrdinaryChild(
  state: RuntimeState,
  base: string,
  level?: ThinkingLevelName,
): Refusal | undefined {
  // An optional entry with a known non-available status cannot launch, so its exact model must fall
  // through to the refusal below instead of passing as an ordinary role with nothing to check.
  const candidates = enabledRoles(state).filter(
    (role) =>
      reference(roleSetting(state, role)) === base &&
      (!isOptionalEntry(role) || isOptionalEntryModelUsable(state, role)),
  );
  if (!candidates.length) {
    const advisor = validAdvisors(state).some(({ setting }) => reference(setting) === base);
    // A configured entry this policy refuses is not an unknown model: say which, or the caller keeps
    // retrying the exact form it already used.
    const blocked = enabledRoles(state).find(
      (role) => isOptionalEntry(role) && reference(roleSetting(state, role)) === base,
    );
    return {
      code: "wrong-model",
      message: blocked
        ? `${ROLE_LABELS[blocked]} is configured with "${base}" but cannot launch: its model or thinking policy is unavailable, so check /delegate status`
        : advisor
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
 * every reader of the call sees the same models. Each child keeps the object the host runs, so a
 * correction can be written where the host will read it.
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
    children: entries.map((value) => {
      const entry = isRecord(value) ? value : undefined;
      const stated = typeof entry?.model === "string" ? entry.model : undefined;
      const inherits = entry !== undefined && entry.model === undefined && shared !== undefined;
      return { entry, model: inherits ? shared : stated, sharedModel: inherits };
    }),
  };
}

/**
 * Whether this call asks the host to branch the session for this child. The host reads `context` on
 * the call's `options` for every workflow child and on the child itself, so both are checked: a
 * refusal that only read the child would be bypassed by the documented `options.context`.
 */
function forksThisChild(input: Record<string, unknown>, entry: Record<string, unknown>): boolean {
  const options = isRecord(input.options) ? input.options : undefined;
  // Three shapes reach the host: the child itself, the call's `options`, and a top-level `context`
  // that governs every child of a multi-child call. All three are read here, because a refusal that
  // missed one would be bypassed by moving the same value one level up.
  return entry.context === "fork" || options?.context === "fork" || input.context === "fork";
}

/** One role code per child, read from the model that child runs. */
function childRoles(state: RuntimeState, stated: StatedChildren): LaunchChildRole[] {
  return stated.children.map(({ entry, model }) => {
    if (!entry) return "unknown";
    if (ADVISOR_AGENTS.has(typeof entry.agent === "string" ? entry.agent : "")) return "advisor";
    if (typeof model !== "string" || !model.trim()) return "unknown";
    const { base } = splitModel(model.trim());
    const role = enabledRoles(state).find(
      (candidate) => reference(roleSetting(state, candidate)) === base,
    );
    return role ?? "unknown";
  });
}

/**
 * The level the guard adds to a role model that arrived without one. A fixed policy contributes its
 * own level, a range the lowest supported level inside it, and no policy `medium` clamped to what
 * the model supports. Undefined means the guard cannot choose, so the call is refused instead.
 */
function addedLevel(
  model: Model<Api>,
  policy: ThinkingPolicy | undefined,
): ThinkingLevelName | undefined {
  const supported = getSupportedThinkingLevels(model);
  if (!policy) return clampThinkingLevel(model, "medium");
  if ("level" in policy) return supported.includes(policy.level) ? policy.level : undefined;
  const order = THINKING_LEVEL_NAMES as readonly string[];
  return THINKING_LEVEL_NAMES.find(
    (level) =>
      order.indexOf(level) >= order.indexOf(policy.min) &&
      order.indexOf(level) <= order.indexOf(policy.max) &&
      supported.includes(level),
  );
}

/** The refusal for a role name that names an Advisor slot no valid Advisor occupies. */
function advisorSlotRefusal(state: RuntimeState, slot: number): Refusal {
  const name = slot === 0 ? "advisor" : `advisor-${slot + 1}`;
  return isAdvisorEnabled(state.effective)
    ? {
        code: "advisor-mismatch",
        message: `"${name}" is not a configured Advisor; each Advisor uses its exact model with its own profile`,
      }
    : { code: "advisor-off", message: `the Advisor role is off, so "${name}" cannot launch` };
}

type ModelCorrection =
  | { kind: "refused"; refusal: Refusal }
  | {
      kind: "resolved";
      model: string;
      /** The ordinary role the call named; its own policy binds the level, not a shared model's. */
      role?: Role;
      /** The Advisor the call named, which settles the profile without a further match. */
      advisor?: AdvisorSetting;
      /** That Advisor's slot, so two Advisors sharing a model keep their own reading flag. */
      advisorSlot?: number;
      corrections: LaunchCorrection[];
    };

/**
 * The model a child runs with. A role name becomes that role's exact model and level, and an exact
 * role model with no level gains one. Every other model is returned unchanged for the ordinary
 * checks to refuse, so the guard never invents a model.
 */
function correctModel(state: RuntimeState, stated: string): ModelCorrection {
  const { base, level } = splitModel(stated);
  const alias = roleAlias(base);

  if (alias && "role" in alias) {
    const role = alias.role;
    const setting = state.effective[role];
    if (!isRoleEnabled(setting))
      return {
        kind: "refused",
        refusal: { code: "wrong-model", message: `role "${base}" is disabled` },
      };
    const status = state.modelStatuses.get(role);
    if (status?.kind !== "available")
      return {
        kind: "refused",
        refusal: { code: "wrong-model", message: `role "${base}" has no available model` },
      };
    const chosen = level ?? addedLevel(status.model, state.effective.thinking[role]);
    if (!chosen)
      return {
        kind: "refused",
        refusal: {
          code: "thinking-unsupported",
          message: `role "${base}" has no thinking level its model supports`,
        },
      };
    const model = `${reference(setting)}:${chosen}`;
    return {
      kind: "resolved",
      model,
      role,
      corrections: [{ code: "role-alias", roleName: base, applied: model }],
    };
  }

  if (alias) {
    // `validAdvisors` drops invalid slots and keeps their original index, so the requested slot is
    // matched by that index: never by position, which would silently pick another Advisor.
    const advisor = validAdvisors(state).find(({ index }) => index === alias.advisor);
    if (!advisor) return { kind: "refused", refusal: advisorSlotRefusal(state, alias.advisor) };
    const model = `${reference(advisor.setting)}:${level ?? clampThinkingLevel(advisor.model, "medium")}`;
    return {
      kind: "resolved",
      model,
      advisor: advisor.setting,
      advisorSlot: advisor.index,
      corrections: [{ code: "role-alias", roleName: base, applied: model }],
    };
  }

  if (level) return { kind: "resolved", model: stated, corrections: [] };

  const roles = enabledRoles(state).filter((role) => reference(roleSetting(state, role)) === base);
  if (roles.length) {
    const levels = new Set<ThinkingLevelName>();
    for (const role of roles) {
      const status = state.modelStatuses.get(role);
      if (status?.kind !== "available") continue;
      const chosen = addedLevel(status.model, state.effective.thinking[role]);
      if (chosen) levels.add(chosen);
    }
    if (levels.size !== 1)
      return {
        kind: "refused",
        refusal: {
          code: "missing-thinking",
          message: `it has no thinking level, and ${
            levels.size
              ? "the roles sharing this model choose different ones"
              : "the role policy leaves none its model supports"
          }; append :LEVEL to the model`,
        },
      };
    const model = `${base}:${[...levels][0]}`;
    return { kind: "resolved", model, corrections: [{ code: "level-added", applied: model }] };
  }

  const advisor = validAdvisors(state).find(({ setting }) => reference(setting) === base);
  if (advisor) {
    const model = `${base}:${clampThinkingLevel(advisor.model, "medium")}`;
    return { kind: "resolved", model, corrections: [{ code: "level-added", applied: model }] };
  }
  return { kind: "resolved", model: stated, corrections: [] };
}

type AgentCorrection =
  | { kind: "refused"; refusal: Refusal }
  | { kind: "resolved"; agent: string; corrections: LaunchCorrection[] };

/**
 * The profile a child runs with. A model that belongs to exactly one valid Advisor runs with that
 * Advisor's profile; a model that is also an enabled role's keeps the ordinary reading, as before.
 * A profile that already matches one of several Advisors sharing the model is left alone, and an
 * unmatched one is refused as ambiguous instead of guessed.
 */
function correctAgent(
  state: RuntimeState,
  model: string,
  agent: string,
  named?: AdvisorSetting,
  namedSlot?: number,
): AgentCorrection {
  const { base } = splitModel(model);
  const matches = validAdvisors(state).filter(({ setting }) => reference(setting) === base);
  if (!matches.length) return { kind: "resolved", agent, corrections: [] };
  if (named) {
    const profile = advisorAgentNameFor(state, named, namedSlot);
    return agent === profile
      ? { kind: "resolved", agent, corrections: [] }
      : {
          kind: "resolved",
          agent: profile,
          corrections: [{ code: "advisor-profile", applied: profile }],
        };
  }
  if (enabledRoles(state).some((role) => reference(roleSetting(state, role)) === base))
    return { kind: "resolved", agent, corrections: [] };
  if (matches.some(({ setting, index }) => advisorAgentNameFor(state, setting, index) === agent))
    return { kind: "resolved", agent, corrections: [] };
  if (matches.length > 1)
    return {
      kind: "refused",
      refusal: {
        code: "advisor-mismatch",
        message: `model "${base}" belongs to more than one configured Advisor; launch each with its own profile`,
      },
    };
  const only = matches[0];
  if (!only) return { kind: "resolved", agent, corrections: [] };
  const profile = advisorAgentNameFor(state, only.setting, only.index);
  return {
    kind: "resolved",
    agent: profile,
    corrections: [{ code: "advisor-profile", applied: profile }],
  };
}

/** What the guard must write for one child, and what it changed. */
type ChildPlan = {
  /** The corrected model, or undefined when the call's own value is used. */
  model?: string;
  /** The corrected profile, or undefined when the call's own value is used. */
  agent?: string;
  /** The ordinary role the call named, whose own policy binds the level. */
  role?: Role;
  corrections: LaunchCorrection[];
};

function planChild(
  state: RuntimeState,
  stated: string,
  agent: string,
): { kind: "refused"; refusal: Refusal } | { kind: "resolved"; plan: ChildPlan } {
  const model = correctModel(state, stated);
  if (model.kind === "refused") return model;
  // An ordinary role runs ordinary work: a shared model never turns it into a consultation.
  if (model.role && ADVISOR_AGENTS.has(agent))
    return {
      kind: "refused",
      refusal: {
        code: "advisor-mismatch",
        message: `${ROLE_LABELS[model.role]} runs with an ordinary agent profile, never an Advisor profile`,
      },
    };
  const profile = correctAgent(state, model.model, agent, model.advisor, model.advisorSlot);
  if (profile.kind === "refused") return profile;
  return {
    kind: "resolved",
    plan: {
      ...(model.model !== stated ? { model: model.model } : {}),
      ...(profile.agent !== agent ? { agent: profile.agent } : {}),
      ...(model.role ? { role: model.role } : {}),
      corrections: [...model.corrections, ...profile.corrections],
    },
  };
}

const CORRECTION_REASONS: Record<LaunchCorrectionCode, string> = {
  "role-alias": "role name replaced by its exact model",
  "level-added": "the role's thinking level was missing",
  "advisor-profile": "the model belongs to that Advisor",
};

/**
 * What the agent is told. It names the corrected field, the role name the call used and the exact
 * value applied, never a task, a path or another string the model sent.
 */
function correctionNote(corrections: readonly LaunchCorrection[]): string {
  const groups = new Map<string, { correction: LaunchCorrection; covered: number[] }>();
  for (const correction of corrections) {
    const key = `${correction.code}\u0000${correction.roleName ?? ""}\u0000${correction.applied}`;
    const group = groups.get(key) ?? { correction, covered: [] };
    if (correction.child !== undefined) group.covered.push(correction.child);
    groups.set(key, group);
  }
  const lines = [...groups.values()].map(({ correction, covered }) => {
    const listed =
      covered.length > 3
        ? `${covered.slice(0, 3).join(", ")} and ${covered.length - 3} more`
        : covered.join(", ");
    const where =
      covered.length === 0 ? "" : covered.length === 1 ? `child ${listed} ` : `children ${listed} `;
    const field = correction.code === "advisor-profile" ? "agent" : "model";
    const stated = correction.roleName ? ` "${correction.roleName}"` : "";
    return `- ${where}${field}${stated} → "${correction.applied}": ${CORRECTION_REASONS[correction.code]}`;
  });
  return [
    "Delegation policy corrected this subagent call before it ran. The transcript keeps the values you sent.",
    ...lines,
  ].join("\n");
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
    corrections: readonly LaunchCorrection[] = [],
    note?: string,
  ): SubagentLaunchCheck => ({ launch, refusal: undefined, children, corrections, note });
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
    corrections: [],
    note: undefined,
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
  const correct = (state.launchCorrection ?? DEFAULT_LAUNCH_CORRECTION_MODE) === "correct";

  // The whole call is checked and corrected in memory first: nothing is written until every child
  // passes, so a refused call never leaves a half-corrected input behind.
  const plans: ChildPlan[] = [];
  for (const [index, child] of stated.children.entries()) {
    if (!child.entry)
      return refuse("invalid-child", `child ${index + 1} is not an object`, children);
    const label = stated.children.length > 1 ? `child ${index + 1}: ` : "";
    const agent = typeof child.entry.agent === "string" ? child.entry.agent : "";
    const isAdvisorAgent = ADVISOR_AGENTS.has(agent);
    if (!isAdvisorAgent && !delegation) {
      plans.push({ corrections: [] });
      continue;
    }
    if (!isAdvisorAgent && invalid)
      return refuse(
        "invalid-config",
        `${label}the delegation configuration is invalid; fix it in /delegate before launching`,
        children,
      );
    if (typeof child.model !== "string" || !child.model.trim())
      return refuse(
        "missing-model",
        `${label}no model was given; state the exact role model, never an inherited default`,
        children,
      );
    const plan = correct
      ? planChild(state, child.model.trim(), agent)
      : { kind: "resolved" as const, plan: { corrections: [] } };
    if (plan.kind === "refused")
      return refuse(plan.refusal.code, `${label}${plan.refusal.message}`, children);
    const model = plan.plan.model ?? child.model.trim();
    const profile = plan.plan.agent ?? agent;
    const { base, level } = splitModel(model);
    const why = plan.plan.role
      ? checkNamedRole(state, plan.plan.role, level)
      : ADVISOR_AGENTS.has(profile)
        ? checkAdvisorChild(state, profile, base, level)
        : checkOrdinaryChild(state, base, level);
    if (why) return refuse(why.code, `${label}${why.message}`, children);
    // An Advisor receives the brief the extension writes, never the conversation: a child that asks
    // the host to branch this session would send it to the Advisor's provider, which the policy and
    // the documentation say never happens. The check reads the profile this child will actually run
    // with — after correction, not the one the call stated — because a role alias or an Advisor model
    // turns an ordinary profile into an Advisor one. The configuration refusals above come first, so
    // an Advisor that is off or mismatched still reports its real cause.
    if (ADVISOR_AGENTS.has(profile) && forksThisChild(input, child.entry))
      return refuse(
        "advisor-fork-context",
        `${label}an Advisor runs in fresh context with its brief; remove context "fork" from this call`,
        children,
      );
    plans.push(plan.plan);
  }

  // Apply. A repeated stated model must resolve to one value, and the call's shared top-level model
  // is written once for every child that inherits it.
  const corrections: LaunchCorrection[] = [];
  const written = new Map<string, string>();
  for (const [index, plan] of plans.entries()) {
    const child = stated.children[index]!;
    if (plan.model !== undefined) {
      const previous = written.get(child.model!);
      if (previous !== undefined && previous !== plan.model)
        return refuse(
          "shared-model-conflict",
          "children stating the same model resolve to different values; state each child's exact model",
          children,
        );
      written.set(child.model!, plan.model);
      if (child.sharedModel) input.model = plan.model;
      else child.entry!.model = plan.model;
      child.model = plan.model;
    }
    if (plan.agent !== undefined) child.entry!.agent = plan.agent;
    // A single-child call needs no index, and a shared model belongs to the call, not to a child.
    corrections.push(
      ...plan.corrections.map((correction) =>
        child.sharedModel || stated.children.length === 1
          ? correction
          : { ...correction, child: index + 1 },
      ),
    );
  }
  if (!corrections.length) return allowed(children);
  return allowed(childRoles(state, stated), true, corrections, correctionNote(corrections));
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

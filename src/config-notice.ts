import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import {
  ROLE_LABELS,
  type AdvisorLaunch,
  type AdvisorMode,
  type ContextShuntMode,
  type EffectiveDelegateState,
  type Intensity,
  type ModelRef,
  type ModelRole,
  type OrdinaryRoleSetting,
  type Preference,
  type ThinkingPolicy,
} from "./types.ts";

/** Custom message type of the notice. The host keeps it on the request copy only. */
export const CONFIG_NOTICE_TYPE = "pi-delegation-policy.config-notice";
/** The scope belongs to this policy, never to any other instruction or authority. */
export const BOTH_OFF_LINE = "Delegation and Advisor disabled by this policy.";

export type ConfigNoticeMessage = ContextWithSystemEvent["messages"][number];

/**
 * An ordinary role has three effective states, and they must stay apart: not configured is an error
 * while delegation is on, explicitly disabled is a valid partial policy, and a model reference
 * delegates. The effective state of Visual Design only distinguishes present from absent, so it
 * never carries `unset`.
 */
type RoleText = { kind: "unset" } | { kind: "disabled" } | { kind: "model"; reference: string };
/** `level:<level>`, `range:<min>..<max>`, or `null` when the role has no thinking policy. */
type ThinkingText = string | null;

/**
 * Deterministic view of the effective configuration that the notice compares. Derived status stays
 * out: model availability, credentials, diagnostics, value provenance and the Advisor context mode
 * cannot produce a notice, and neither can the rendered policy text.
 */
export type NoticeProjection = {
  intensity: Intensity;
  preference: Preference;
  roles: Record<ModelRole, RoleText>;
  uiDesign: RoleText;
  thinking: Record<ModelRole | "uiDesign", ThinkingText>;
  advisors: Array<{ model: string; thinking: ThinkingText }>;
  advisorMode: AdvisorMode;
  advisorLaunch: AdvisorLaunch;
  context: {
    mode: ContextShuntMode;
    readerEnabled: boolean;
    readerRole: ModelRole;
    answerMaxBytes: number;
  };
};

function thinkingText(policy: ThinkingPolicy | undefined): ThinkingText {
  if (!policy) return null;
  return "level" in policy ? `level:${policy.level}` : `range:${policy.min}..${policy.max}`;
}

function ordinaryRoleText(setting: OrdinaryRoleSetting | undefined): RoleText {
  if (setting === null) return { kind: "disabled" };
  if (!setting) return { kind: "unset" };
  return { kind: "model", reference: `${setting.provider}/${setting.model}` };
}

function optionalRoleText(setting: ModelRef | undefined): RoleText {
  if (!setting) return { kind: "disabled" };
  return { kind: "model", reference: `${setting.provider}/${setting.model}` };
}

export function projectNoticeConfig(effective: EffectiveDelegateState): NoticeProjection {
  return {
    intensity: effective.intensity,
    preference: effective.preference,
    roles: {
      small: ordinaryRoleText(effective.small),
      medium: ordinaryRoleText(effective.medium),
      large: ordinaryRoleText(effective.large),
    },
    uiDesign: optionalRoleText(effective.uiDesign),
    thinking: {
      small: thinkingText(effective.thinking.small),
      medium: thinkingText(effective.thinking.medium),
      large: thinkingText(effective.thinking.large),
      uiDesign: thinkingText(effective.thinking.uiDesign),
    },
    advisors: effective.advisors.map((advisor) => ({
      model: `${advisor.provider}/${advisor.model}`,
      thinking: thinkingText(advisor.thinking),
    })),
    advisorMode: effective.advisorMode,
    advisorLaunch: effective.advisorLaunch,
    // The configured mode keeps an intensity edit from fabricating a second change.
    context: {
      mode: effective.contextShunt.configuredMode,
      readerEnabled: effective.contextShunt.readerEnabled,
      readerRole: effective.contextShunt.readerRole,
      answerMaxBytes: effective.contextShunt.answerMaxBytes,
    },
  };
}

type NoticeField = { label: string; value: string };

const TEXT_ROLES: readonly (ModelRole | "uiDesign")[] = ["small", "medium", "large", "uiDesign"];

function roleValue(text: RoleText): string {
  if (text.kind === "model") return text.reference;
  return text.kind === "disabled" ? "disabled" : "not configured";
}

function advisorModelValue(model: string | undefined): string {
  return model ?? "none";
}

function thinkingValue(text: ThinkingText | undefined): string {
  if (text === null || text === undefined) return "unset";
  return text.startsWith("level:")
    ? `fixed ${text.slice("level:".length)}`
    : `range ${text.slice("range:".length)}`;
}

/**
 * Fields in one canonical order. Advisor count is taken from both projections so a removed Advisor
 * still reports its own two fields.
 */
function projectionFields(projection: NoticeProjection, advisorCount: number): NoticeField[] {
  return [
    { label: "Delegation intensity", value: projection.intensity },
    { label: "Model preference", value: projection.preference },
    ...TEXT_ROLES.map((role) => ({
      label: `${ROLE_LABELS[role]} model`,
      value: roleValue(role === "uiDesign" ? projection.uiDesign : projection.roles[role]),
    })),
    ...TEXT_ROLES.map((role) => ({
      label: `${ROLE_LABELS[role]} thinking`,
      value: thinkingValue(projection.thinking[role]),
    })),
    { label: "Advisor mode", value: projection.advisorMode },
    { label: "Advisor launch", value: projection.advisorLaunch },
    ...Array.from({ length: advisorCount }, (_, index) => {
      const advisor = projection.advisors[index];
      return [
        { label: `Advisor ${index + 1} model`, value: advisorModelValue(advisor?.model) },
        { label: `Advisor ${index + 1} thinking`, value: thinkingValue(advisor?.thinking) },
      ];
    }).flat(),
    { label: "Context protection", value: projection.context.mode },
    {
      label: "Context reader",
      value: projection.context.readerEnabled ? "enabled" : "disabled",
    },
    { label: "Context reader role", value: projection.context.readerRole },
    {
      label: "Context reader answer limit",
      value: `${projection.context.answerMaxBytes} bytes`,
    },
  ];
}

/** One `- label: previous -> current` line per changed field, in the canonical field order. */
export function changedValueLines(previous: NoticeProjection, current: NoticeProjection): string[] {
  const advisorCount = Math.max(previous.advisors.length, current.advisors.length);
  const before = projectionFields(previous, advisorCount);
  const after = projectionFields(current, advisorCount);
  return after.flatMap((field, index) => {
    const previousValue = before[index]!.value;
    return previousValue === field.value
      ? []
      : [`- ${field.label}: ${previousValue} -> ${field.value}`];
  });
}

/**
 * Lines the notice reports for one observed change. While both axes are already off a value edit
 * changes nothing the model can act on, so only the transition into that state speaks, once.
 */
export function noticeLines(change: {
  previous: NoticeProjection;
  current: NoticeProjection;
  previouslyOff: boolean;
  currentlyOff: boolean;
}): string[] {
  const lines = changedValueLines(change.previous, change.current);
  if (!lines.length || !change.currentlyOff) return lines;
  return change.previouslyOff ? [] : [`- ${BOTH_OFF_LINE}`];
}

export function renderConfigNotice(lines: string[]): string {
  return [
    "<delegation_config_notice>",
    "<!-- pi-delegation-policy:notice -->",
    "This notice comes from the pi-delegation-policy extension, not from the user.",
    "The /delegate configuration changed before this turn:",
    ...lines,
    "The delegation policy in the system prompt, when present, states the values in force for the present request.",
    "For new work, follow the current valid assignments and thinking rules in this policy, not earlier settings in the conversation.",
    "This notice only records what changed in this extension's configuration and revokes no other instruction, permission, or authority.",
    "</delegation_config_notice>",
  ].join("\n");
}

export function createConfigNotice(lines: string[], timestamp: number): ConfigNoticeMessage {
  return {
    role: "custom",
    customType: CONFIG_NOTICE_TYPE,
    content: renderConfigNotice(lines),
    display: false,
    timestamp,
  };
}

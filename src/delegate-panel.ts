import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { configuredAdvisors, isThinkingLevelName, resolveDelegateState } from "./config.ts";
import {
  admissionFor,
  type ProviderAdmissions,
  RESERVED_PROVIDER,
  sameAdmissions,
} from "./provider-admissions.ts";
import type { ProviderPackage } from "./provider-package.ts";
import {
  DEFAULT_LAUNCH_CORRECTION_MODE,
  LAUNCH_CORRECTION_MODES,
  type LaunchCorrectionMode,
  type LaunchCorrectionSaveResult,
} from "./launch-correction-mode.ts";
import {
  ADVISOR_REMINDER_MODES,
  type AdvisorReminderMode,
  type AdvisorReminderSaveResult,
  DEFAULT_ADVISOR_REMINDER_MODE,
} from "./advisor-reminders.ts";
import { isAdvisorEnabled } from "./runtime.ts";
import { buildPolicyPreview } from "./prompt.ts";
import {
  ADVISOR_LAUNCH_MODES,
  type AdvisorLaunch,
  ADVISOR_MODES,
  type AdvisorMode,
  CONTEXT_SHUNT_MODES,
  type ContextShuntSettings,
  CURRENT_SCHEMA_VERSION,
  type EffectiveDelegateState,
  type GlobalDefaults,
  INTENSITIES,
  type Intensity,
  type ModelConfigKey,
  type ModelRef,
  type ModelRole,
  type OptionalRoleEntryKey,
  optionalRoleEntryKeys,
  PREFERENCES,
  emptyRoleEntries,
  type Preference,
  ROLE_LABELS,
  type RoleEntries,
  type SessionDelegateState,
  type SessionThinkingSettings,
  type ThinkingLevelName,
  type ThinkingPolicy,
} from "./types.ts";
import { copyRoleEntries, sameRoleEntries, type RoleEntriesSaveResult } from "./role-entries.ts";
import {
  normalizeAdvisorRead,
  trimAdvisorRead,
  type AdvisorReadSaveResult,
} from "./advisor-read-mode.ts";

const USE_GLOBAL_DEFAULT = "Use global default";
const DISABLE_FOR_SESSION = "Disable for this session";
const REMOVE_ENTRY = "Remove entry (global)";
const UNSET_FOR_SESSION = "Unset for this session (no policy)";
const FIXED_LEVEL = "Fixed level…";
const RANGE_LEVELS = "Range (min–max)…";

const FIELD_IDS = [
  "intensity",
  "preference",
  "small",
  "medium",
  "large",
  "uiDesign",
  "uiDesign2",
  "uiDesign3",
  "vision",
  "vision2",
  "vision3",
  "contextShunt",
  "contextAdvanced",
  "thinkingSmall",
  "thinkingMedium",
  "thinkingLarge",
  "thinkingUiDesign",
  "advisorMode",
  "advisorLaunch",
  "advisor",
  "advisor2",
  "advisor3",
  "advisorReminder",
  "launchCorrection",
] as const;
type DelegateField = (typeof FIELD_IDS)[number];
const THINKING_FIELDS = [
  "thinkingSmall",
  "thinkingMedium",
  "thinkingLarge",
  "thinkingUiDesign",
] as const;
type ThinkingField = (typeof THINKING_FIELDS)[number];
/** Roles with a configurable thinking policy; Advisor thinking is chosen per launch. */
type ThinkingKey = ModelRole | "uiDesign";
/** Advisor rows follow list order; each row also carries that entry's provider profile. */
const ADVISOR_FIELDS = ["advisor", "advisor2", "advisor3"] as const;
type AdvisorField = (typeof ADVISOR_FIELDS)[number];
/**
 * Optional-role entries are rows of their own. They are global, like the other sidecar settings,
 * because the entry lists live in `delegation-policy.roles.json` rather than in the session.
 */
const ENTRY_FIELDS = ["uiDesign2", "uiDesign3", "vision", "vision2", "vision3"] as const;
type EntryField = (typeof ENTRY_FIELDS)[number];
type ModelField = ThinkingKey | AdvisorField | EntryField;
const ENTRY_FIELD_KEYS: Record<EntryField, OptionalRoleEntryKey> = {
  uiDesign2: "uiDesign2",
  uiDesign3: "uiDesign3",
  vision: "vision",
  vision2: "vision2",
  vision3: "vision3",
};
function isEntryField(field: string): field is EntryField {
  return (ENTRY_FIELDS as readonly string[]).includes(field);
}
function entryKeyOf(field: EntryField): OptionalRoleEntryKey {
  return ENTRY_FIELD_KEYS[field];
}
function entryFamilyOf(key: OptionalRoleEntryKey): "uiDesign" | "vision" {
  return key.startsWith("uiDesign") ? "uiDesign" : "vision";
}
/**
 * The row that must already be configured before this one can appear. `vision` has none: the family
 * has to be startable from the panel, and its first entry is not backed by a document key.
 */
const ENTRY_FIELD_PARENT: Record<EntryField, EntryField | "uiDesign" | "always"> = {
  uiDesign2: "uiDesign",
  uiDesign3: "uiDesign2",
  vision: "always",
  vision2: "vision",
  vision3: "vision2",
};
const THINKING_FIELD_KEYS: Record<ThinkingField, ThinkingKey> = {
  thinkingSmall: "small",
  thinkingMedium: "medium",
  thinkingLarge: "large",
  thinkingUiDesign: "uiDesign",
};
function isAdvisorField(field: string): field is AdvisorField {
  return (ADVISOR_FIELDS as readonly string[]).includes(field);
}
function advisorIndex(field: AdvisorField): number {
  return ADVISOR_FIELDS.indexOf(field);
}
function isThinkingField(field: string): field is ThinkingField {
  return (THINKING_FIELDS as readonly string[]).includes(field);
}
function isDelegateField(item: string): item is DelegateField {
  return (FIELD_IDS as readonly string[]).includes(item);
}
type EnumField = "intensity" | "preference" | "contextShunt" | "advisorMode" | "advisorLaunch";
type PanelAction = "apply" | "save-defaults" | "reset" | "cancel";
type SettingsItem = DelegateField | PanelAction;
const ADVANCED_FIELDS = [
  "readerEnabled",
  "readerRole",
  "answerMaxBytes",
  "fullReadLines",
  "fullReadBytes",
  "targetedReadLines",
  "targetedReadBytes",
  "exceptionPatterns",
  "delegationHintPatterns",
  "resetContextShunt",
  "back",
] as const;
type AdvancedField = (typeof ADVANCED_FIELDS)[number];
const LIMIT_FIELDS = [
  "fullReadLines",
  "fullReadBytes",
  "targetedReadLines",
  "targetedReadBytes",
] as const;
type LimitField = (typeof LIMIT_FIELDS)[number];
type EditableAdvancedField = Exclude<
  AdvancedField,
  "readerEnabled" | "readerRole" | "resetContextShunt" | "back"
>;

function isLimitField(field: AdvancedField | EditableAdvancedField): field is LimitField {
  return (LIMIT_FIELDS as readonly string[]).includes(field);
}

type PanelMode =
  | { kind: "settings" }
  | { kind: "enum"; field: EnumField; selected: number }
  | { kind: "correction"; selected: number }
  | { kind: "reminder"; selected: number }
  | { kind: "provider"; index: number; selected: number }
  | { kind: "advisor-read"; index: number; selected: number }
  | { kind: "extension"; index: number; provider: string; selected: number }
  | { kind: "model"; field: ModelField; selected: number; query: string }
  | { kind: "advanced"; selected: number }
  | { kind: "advanced-reader-enabled"; selected: number }
  | { kind: "advanced-reader-role"; selected: number }
  | { kind: "advanced-input"; field: EditableAdvancedField }
  | { kind: "thinking"; field: ThinkingField; selected: number }
  | {
      kind: "thinking-level";
      field: ThinkingField;
      target: "fixed" | "min" | "max";
      selected: number;
      minimum?: ThinkingLevelName;
    }
  | { kind: "continuity"; selected: number }
  | { kind: "discard-confirm"; selected: number };

type ThinkingAction = "inherit" | "unset" | "fixed" | "range";
type ThinkingChoice = { label: string; description: string; action: ThinkingAction };

type ModelChoice =
  | { kind: "global"; key: "global"; label: string; description?: string }
  | { kind: "disabled"; key: "disabled"; label: string; description?: string }
  | {
      kind: "model";
      key: string;
      label: string;
      description?: string;
      reference: ModelRef;
    };

export type DelegatePanelResult = "applied" | "cancelled";

/**
 * `unchanged` means this save left the previous global files in place; `partial` means it could not
 * complete or confirm the pair, so the delegation file and the Advisor companion may disagree.
 */
export type SaveDefaultsOutcome =
  | { kind: "saved"; defaults: GlobalDefaults }
  | { kind: "unchanged" }
  | { kind: "partial"; defaults?: GlobalDefaults; diagnostics?: string[] };

export interface DelegatePanelOptions {
  tui: TUI;
  theme: Theme;
  global: GlobalDefaults;
  session: SessionDelegateState;
  candidates: Model<Api>[];
  diagnostics: string[];
  hasRuntimeError: boolean;
  hasAdvisorError?: boolean;
  onApply: (draft: SessionDelegateState) => Promise<boolean>;
  onSaveDefaults: (draft: SessionDelegateState) => Promise<SaveDefaultsOutcome>;
  onDone: (result: DelegatePanelResult) => void;
  /** Global provider-extension admissions; Apply and Save both store a changed set. */
  admissions?: ProviderAdmissions;
  /** One flag per Advisor slot: whether that Advisor may open the files its brief names. */
  advisorRead?: boolean[];
  /** Stores the global reading flags; Apply and Save both write a changed set before their step. */
  onSaveAdvisorRead?: (read: boolean[]) => Promise<AdvisorReadSaveResult>;
  /** Optional-role entry lists; absent means none configured. Apply and Save write a change. */
  roleEntries?: RoleEntries;
  /** Stores the global entry lists; Apply and Save both write a changed set before their step. */
  onSaveRoleEntries?: (entries: RoleEntries) => Promise<RoleEntriesSaveResult>;
  /** Global launch correction mode; absent means `correct`. */
  launchCorrection?: LaunchCorrectionMode;
  /** Stores the global mode; Apply and Save both write a changed value before their own step. */
  onSaveLaunchCorrection?: (mode: LaunchCorrectionMode) => Promise<LaunchCorrectionSaveResult>;
  /** Global Advisor reminder mode; absent means `remind`. */
  advisorReminder?: AdvisorReminderMode;
  /** The companion is unreadable or invalid, so the shown mode is a suspension, not a choice. */
  advisorReminderInvalid?: boolean;
  /** Stores the global reminder mode; Apply and Save both write a changed value first. */
  onSaveAdvisorReminder?: (mode: AdvisorReminderMode) => Promise<AdvisorReminderSaveResult>;
  /** Installed user packages that pass the identity check, offered as provider extensions. */
  extensionCandidates?: readonly ProviderPackage[];
  /** Providers that an extension registered in this session; only these offer the step. */
  extensionProviders?: readonly string[];
  onSaveAdmissions?: (admissions: ProviderAdmissions) => Promise<boolean>;
  /** One bounded line describing this session's Advisor threads, read without a lock. */
  continuityStatus?: () => Promise<string>;
  /** Reconcile unresolved turns with public terminal proof; returns a message for the panel. */
  onRecoverContinuity?: () => Promise<{ message: string; type: "info" | "error" }>;
  /** Abandon threads, refused while any turn may still be live. */
  onResetContinuity?: () => Promise<{ message: string; type: "info" | "error" }>;
}

const PANEL_ACTIONS: readonly PanelAction[] = ["apply", "save-defaults", "reset", "cancel"];
const CONTINUITY_ACTIONS = ["status", "recover", "reset"] as const;
type ContinuityAction = (typeof CONTINUITY_ACTIONS)[number];
const CONTINUITY_LABELS: Record<ContinuityAction, string> = {
  status: "Show Advisor continuity status",
  recover: "Reconcile a possibly live turn with the host",
  reset: "Reset Advisor threads (only when nothing may be live)",
};
const CONTINUITY_DESCRIPTION =
  "Advisor continuity is private to this extension: the journal, the lock and the per-turn answer files are never edited by hand. Recover asks the host for terminal proof of each unresolved turn; reset only abandons threads when nothing may still be running.";
const PROVIDER_CHOICES = [
  "Standard profile (no provider extension)",
  "Anthropic auth 3.4.3/3.4.4/3.6.0 (explicit opt-in)",
] as const;
const PROVIDER_DESCRIPTION =
  "Standard uses the ordinary Advisor profile. Anthropic auth uses a separate profile that loads managed-user pi-anthropic-auth 3.4.3, 3.4.4 or 3.6.0 with its normal configuration, startup hook and account diagnostic command; no model tools are added. The model is unchanged; a missing or incompatible package disables only this Advisor.";

const EXTENSION_STANDARD = "Standard profile (no provider extension)";
function extensionDescription(provider: string): string {
  return `An Advisor child loads no extension, so a ${provider} model that an extension supplies only works once you admit that extension here. The admitted package runs as trusted code in every ${provider} Advisor, in every session; only its installed identity is checked. The list holds every pinned user package, not only providers: one that does not register ${provider} still runs before the Advisor refuses it. Apply and Save both store this choice globally; Standard removes it.`;
}

const FIELD_LABELS: Record<DelegateField, string> = {
  intensity: "Intensity",
  preference: "Preference",
  small: "Small model",
  medium: "Medium model",
  large: "Large model",
  uiDesign: "Visual Design",
  uiDesign2: "Visual Design 2",
  uiDesign3: "Visual Design 3",
  vision: "Vision",
  vision2: "Vision 2",
  vision3: "Vision 3",
  contextShunt: "Context protection",
  contextAdvanced: "Context advanced",
  thinkingSmall: "Small thinking",
  thinkingMedium: "Medium thinking",
  thinkingLarge: "Large thinking",
  thinkingUiDesign: "Visual Design thinking",
  advisor: "Advisor 1",
  advisor2: "Advisor 2",
  advisor3: "Advisor 3",
  advisorLaunch: "Advisor launch",
  advisorMode: "Advisor mode",
  advisorReminder: "Advisor reminder",
  launchCorrection: "Launch correction",
};

/** One alignment column for every field value, wide enough for the longest label. */
const SETTINGS_LABEL_WIDTH = Math.max(
  16,
  ...FIELD_IDS.map((field) => visibleWidth(FIELD_LABELS[field]) + 1),
);

const FIELD_DESCRIPTIONS: Record<DelegateField, string> = {
  intensity: "When delegation is worth considering.",
  preference: "Tie-break only; task fit decides the role first.",
  small: "Bounded, planned, and verifiable execution.",
  medium: "Planning, ambiguity, synthesis, and coordination.",
  large: "Exceptional unblocker for persistent hard problems.",
  uiDesign: "Design, assets, and bounded presentation work; no app behavior.",
  uiDesign2:
    "Second model for the same work; global, and its thinking policy lives in delegation-policy.roles.json.",
  uiDesign3:
    "Third model for the same work; global, and its thinking policy lives in delegation-policy.roles.json.",
  vision:
    "Reads images the user chose a model for; global, and its thinking policy lives in the roles file.",
  vision2:
    "Second Vision entry; global, and its thinking policy lives in delegation-policy.roles.json.",
  vision3:
    "Third Vision entry; global, and its thinking policy lives in delegation-policy.roles.json.",
  contextShunt: "Off, observe, or enforce bounded context protection.",
  contextAdvanced:
    "Reader role, limits, and path patterns; each value can inherit from global defaults.",
  thinkingSmall:
    "Unset, one fixed level, or an inclusive range; levels come from the role's model.",
  thinkingMedium:
    "Unset, one fixed level, or an inclusive range; levels come from the role's model.",
  thinkingLarge:
    "Unset, one fixed level, or an inclusive range; levels come from the role's model.",
  thinkingUiDesign:
    "Unset, one fixed level, or an inclusive range; levels come from the role's model.",
  advisorMode:
    "On works independently of delegation; off disables advice; with-delegation preserves legacy behavior. Consultations may incur cost.",
  advisor:
    "First advice model; executes no work. Anthropic models also ask for the profile. Thinking is automatic. Removing it removes every advisor.",
  advisor2:
    "Optional model consulted alongside Advisor 1. Disable removes it; any later advisor moves up.",
  advisor3:
    "Optional model consulted alongside the others; each advisor adds a consultation at every checkpoint.",
  advisorLaunch:
    "Role asks the main agent to launch; tool uses explicit consult_advisor. Neither launches from hooks.",
  advisorReminder:
    "Global for every session; Apply or Save stores it. On adds one short reminder per task while an Advisor can be consulted; it launches nothing.",
  launchCorrection:
    "Global for every session; Apply or Save stores it. Block refuses the launches the check would correct, to measure the original behavior.",
};

const CORRECTION_DESCRIPTION =
  "Global for every session, not a session setting: Apply or Save stores it in delegation-policy.launch-correction.json. Correct is the default; block is a measurement mode that refuses the launches the check would correct, keeping the pre-correction behavior.";
const CORRECTION_CHOICES: Record<LaunchCorrectionMode, string> = {
  correct: "correct — fix the launch and tell the agent what was applied",
  block: "block — refuse those launches and measure the original behavior",
};
const REMINDER_DESCRIPTION =
  "Global for every session, not a session setting: Apply or Save stores it in delegation-policy.advisor-reminders.json. On adds at most one short reminder per operative task, only while a valid Advisor and its launcher are active. It launches no consultation, forces none, and adds no authority; off adds nothing.";
const REMINDER_CHOICES: Record<AdvisorReminderMode, string> = {
  remind: "remind — one short reminder per task when a consultation is possible",
  off: "off — never add the reminder",
};

/**
 * The global steps this editor stored, named for a later message. A step is listed only after its
 * write was confirmed, so the clause describes what is on disk and never promises a rollback.
 */
function savedClause(saved: readonly string[]): string {
  if (!saved.length) return "";
  const last = saved[saved.length - 1] ?? "";
  const list = saved.length === 1 ? last : `${saved.slice(0, -1).join(", ")} and ${last}`;
  return ` ${list.charAt(0).toUpperCase()}${list.slice(1)} ${saved.length === 1 ? "was" : "were"} saved.`;
}

function correctionFailureText(result: LaunchCorrectionSaveResult): string {
  return result === "unknown-state"
    ? "Launch correction file is unreadable or invalid; fix or remove delegation-policy.launch-correction.json, then retry."
    : "Could not save the launch correction mode.";
}

function advisorReadFailureText(result: AdvisorReadSaveResult): string {
  return result === "unknown-state"
    ? "Advisor reading file is unreadable or invalid; fix or remove delegation-policy.advisor-read.json, then retry."
    : "Could not save the Advisor reading flags.";
}

/** A sidecar this editor has no writer for: the edit is refused instead of being staged and lost. */
function noWriterText(file: string): string {
  return `No writer for ${file} is configured in this editor, so the change was not made.`;
}

function roleEntriesFailureText(result: RoleEntriesSaveResult): string {
  return result === "unknown-state"
    ? "Optional role entries file is unreadable or invalid; fix or remove delegation-policy.roles.json, then retry."
    : "Could not save the optional role entries.";
}

function reminderFailureText(result: AdvisorReminderSaveResult): string {
  return result === "unknown-state"
    ? "Advisor reminder file is unreadable or invalid; fix or remove delegation-policy.advisor-reminders.json, then retry."
    : "Could not save the Advisor reminder mode.";
}

const ACTION_LABELS: Record<PanelAction, string> = {
  apply: "Apply changes",
  "save-defaults": "Save effective configuration as defaults",
  reset: "Reset draft to off",
  cancel: "Cancel",
};

function cloneSession(value: SessionDelegateState): SessionDelegateState {
  return structuredClone(value);
}

function sameModel(left: ModelRef | null | undefined, right: ModelRef | null | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.provider === right.provider && left.model === right.model;
}

function sameThinkingPolicy(
  left: ThinkingPolicy | null | undefined,
  right: ThinkingPolicy | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if ("level" in left || "level" in right)
    return "level" in left && "level" in right && left.level === right.level;
  return left.min === right.min && left.max === right.max;
}

function sameThinking(
  left: SessionThinkingSettings | undefined,
  right: SessionThinkingSettings | undefined,
): boolean {
  const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  return [...keys].every((key) =>
    sameThinkingPolicy(left?.[key as ModelConfigKey], right?.[key as ModelConfigKey]),
  );
}

function thinkingSummary(policy: ThinkingPolicy): string {
  return "level" in policy ? policy.level : `${policy.min}..${policy.max}`;
}

export function sameSessionState(left: SessionDelegateState, right: SessionDelegateState): boolean {
  return (
    left.intensity === right.intensity &&
    left.advisorMode === right.advisorMode &&
    left.advisorLaunch === right.advisorLaunch &&
    JSON.stringify(left.advisors) === JSON.stringify(right.advisors) &&
    left.preference === right.preference &&
    sameModel(left.small, right.small) &&
    sameModel(left.medium, right.medium) &&
    sameModel(left.large, right.large) &&
    sameModel(left.uiDesign, right.uiDesign) &&
    sameModel(left.advisor, right.advisor) &&
    sameThinking(left.thinking, right.thinking) &&
    JSON.stringify(left.contextShunt ?? {}) === JSON.stringify(right.contextShunt ?? {})
  );
}

function modelText(reference: ModelRef | undefined): string {
  return reference ? `${reference.provider}/${reference.model}` : "not configured";
}

function rawModelText(reference: ModelRef | null | undefined, missing: string): string {
  if (reference === null) return "disabled";
  return reference ? modelText(reference) : missing;
}

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function selectedLine(theme: Theme, text: string, width: number, selected: boolean): string {
  const line = pad(`${selected ? ">" : " "} ${text}`, width);
  return selected ? theme.bg("selectedBg", theme.fg("accent", line)) : line;
}

function modelKey(reference: ModelRef): string {
  return `${reference.provider}\u0000${reference.model}`;
}

function sortedModels(models: readonly Model<Api>[]): Model<Api>[] {
  return [...models].sort((left, right) => {
    const provider = left.provider.localeCompare(right.provider);
    return provider === 0 ? left.id.localeCompare(right.id) : provider;
  });
}

function modelMetadata(model: Model<Api> | undefined): string[] {
  if (!model) return [];
  const details: string[] = [];
  if (model.name !== undefined) details.push(`Model Name: ${model.name}`);
  if (model.api !== undefined) details.push(`API: ${model.api}`);
  if (model.reasoning !== undefined) details.push(`Reasoning: ${model.reasoning ? "yes" : "no"}`);
  if (model.contextWindow !== undefined) details.push(`Context: ${model.contextWindow}`);
  if (model.maxTokens !== undefined) details.push(`Max output: ${model.maxTokens}`);
  return details;
}

function visibleBlockRange(blocks: string[][], selected: number, budget: number): [number, number] {
  if (blocks.length === 0) return [0, 0];
  const safeSelected = Math.max(0, Math.min(selected, blocks.length - 1));
  const selectedSize = Math.min(blocks[safeSelected]?.length ?? 1, Math.max(1, budget));
  let start = safeSelected;
  let end = safeSelected + 1;
  let used = selectedSize;

  while (used < budget && (start > 0 || end < blocks.length)) {
    const below = end < blocks.length ? (blocks[end]?.length ?? 1) : Number.POSITIVE_INFINITY;
    const above = start > 0 ? (blocks[start - 1]?.length ?? 1) : Number.POSITIVE_INFINITY;
    if (below <= above && used + below <= budget) {
      used += below;
      end += 1;
      continue;
    }
    if (used + above <= budget) {
      used += above;
      start -= 1;
      continue;
    }
    if (used + below <= budget) {
      used += below;
      end += 1;
      continue;
    }
    break;
  }

  return [start, end];
}

export class DelegatePanel implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly candidates: Model<Api>[];
  private readonly diagnostics: string[];
  private readonly hasRuntimeError: boolean;
  private readonly hasAdvisorError: boolean;
  private readonly onApply: DelegatePanelOptions["onApply"];
  private readonly onSaveDefaults: DelegatePanelOptions["onSaveDefaults"];
  private readonly onDone: DelegatePanelOptions["onDone"];
  private readonly onSaveAdmissions: DelegatePanelOptions["onSaveAdmissions"];
  private readonly onSaveLaunchCorrection: DelegatePanelOptions["onSaveLaunchCorrection"];
  private readonly onSaveAdvisorReminder: DelegatePanelOptions["onSaveAdvisorReminder"];
  private readonly onSaveRoleEntries: DelegatePanelOptions["onSaveRoleEntries"];
  private readonly onSaveAdvisorRead: DelegatePanelOptions["onSaveAdvisorRead"];
  private advisorRead: boolean[];
  private draftAdvisorRead: boolean[];
  private readonly extensionCandidates: readonly ProviderPackage[];
  private readonly extensionProviders: readonly string[];
  private admissions: ProviderAdmissions;
  private draftAdmissions: ProviderAdmissions;
  private launchCorrection: LaunchCorrectionMode;
  private draftLaunchCorrection: LaunchCorrectionMode;
  private advisorReminder: AdvisorReminderMode;
  private draftAdvisorReminder: AdvisorReminderMode;
  private readonly advisorReminderInvalid: boolean;
  /** Global steps already on disk from this editor, so a later failure never denies them. */
  private readonly savedGlobals = new Map<
    "admissions" | "launchCorrection" | "advisorReminder" | "roleEntries" | "advisorRead",
    string
  >();
  /** Optional-role entries as the sidecar holds them, and the set this editor is staging. */
  private roleEntries: RoleEntries;
  private draftRoleEntries: RoleEntries;
  private readonly original: SessionDelegateState;
  private readonly searchInput = new Input();
  private readonly advancedInput = new Input();
  private global: GlobalDefaults;
  private draft: SessionDelegateState;
  private mode: PanelMode = { kind: "settings" };
  private settingsIndex = 0;
  private working: string | undefined;
  private message: { kind: "info" | "error"; text: string } | undefined;
  private readonly continuityStatus?: () => Promise<string>;
  private readonly onRecoverContinuity?: () => Promise<{ message: string; type: "info" | "error" }>;
  private readonly onResetContinuity?: () => Promise<{ message: string; type: "info" | "error" }>;
  private continuityText: string | undefined;
  private continuityBusy = false;
  private renderWidth = 80;
  private _focused = false;

  constructor(options: DelegatePanelOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.global = structuredClone(options.global);
    this.original = cloneSession(options.session);
    this.draft = cloneSession(options.session);
    this.candidates = sortedModels(options.candidates);
    this.diagnostics = [...options.diagnostics];
    this.hasRuntimeError = options.hasRuntimeError;
    this.continuityStatus = options.continuityStatus;
    this.onRecoverContinuity = options.onRecoverContinuity;
    this.onResetContinuity = options.onResetContinuity;
    this.hasAdvisorError = options.hasAdvisorError ?? false;
    this.onApply = options.onApply;
    this.onSaveDefaults = options.onSaveDefaults;
    this.onDone = options.onDone;
    this.onSaveAdmissions = options.onSaveAdmissions;
    this.onSaveLaunchCorrection = options.onSaveLaunchCorrection;
    this.onSaveRoleEntries = options.onSaveRoleEntries;
    this.onSaveAdvisorRead = options.onSaveAdvisorRead;
    this.advisorRead = [...(options.advisorRead ?? [])];
    this.draftAdvisorRead = [...this.advisorRead];
    this.extensionCandidates = options.extensionCandidates ?? [];
    this.extensionProviders = options.extensionProviders ?? [];
    this.admissions = structuredClone(options.admissions ?? {});
    this.draftAdmissions = structuredClone(options.admissions ?? {});
    this.launchCorrection = options.launchCorrection ?? DEFAULT_LAUNCH_CORRECTION_MODE;
    this.draftLaunchCorrection = this.launchCorrection;
    this.onSaveAdvisorReminder = options.onSaveAdvisorReminder;
    this.roleEntries = copyRoleEntries(options.roleEntries ?? emptyRoleEntries());
    this.draftRoleEntries = copyRoleEntries(this.roleEntries);
    this.advisorReminder = options.advisorReminder ?? DEFAULT_ADVISOR_REMINDER_MODE;
    this.draftAdvisorReminder = this.advisorReminder;
    this.advisorReminderInvalid = options.advisorReminderInvalid ?? false;
  }

  get focused(): boolean {
    return this._focused;
  }

  /**
   * The fields this panel is currently showing, in order. A row can appear or disappear as the
   * configuration changes, so callers that move the focus resolve the target by name instead of
   * counting keystrokes that a new row would invalidate.
   */
  visibleFields(): DelegateField[] {
    return this.settingsItems().filter(isDelegateField);
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  getDraft(): SessionDelegateState {
    return cloneSession(this.draft);
  }

  getDraftAdmissions(): ProviderAdmissions {
    return structuredClone(this.draftAdmissions);
  }

  isDirty(): boolean {
    return !sameSessionState(this.original, this.draft) || this.globalsDirty();
  }

  private admissionsDirty(): boolean {
    return !sameAdmissions(this.admissions, this.draftAdmissions);
  }

  private launchCorrectionDirty(): boolean {
    return this.launchCorrection !== this.draftLaunchCorrection;
  }

  private advisorReminderDirty(): boolean {
    return this.advisorReminder !== this.draftAdvisorReminder;
  }

  private roleEntriesDirty(): boolean {
    // Without a writer there is nothing to persist, and a step that always fails would block Apply
    // for an embedder that does not handle this file.
    if (!this.onSaveRoleEntries) return false;
    return !sameRoleEntries(this.roleEntries, this.draftRoleEntries);
  }

  private advisorReadDirty(): boolean {
    if (!this.onSaveAdvisorRead) return false;
    return (
      this.advisorRead.length !== this.draftAdvisorRead.length ||
      this.advisorRead.some((flag, index) => flag !== this.draftAdvisorRead[index])
    );
  }

  /**
   * Reading is global, so Apply and Save both write a changed set before their own step. A file this
   * writer cannot read is reported instead of overwritten.
   */
  private async saveAdvisorRead(): Promise<AdvisorReadSaveResult> {
    let result: AdvisorReadSaveResult;
    try {
      result = (await this.onSaveAdvisorRead?.([...this.draftAdvisorRead])) ?? "failed";
    } catch {
      result = "failed";
    }
    if (result === "saved" || result === "unchanged") {
      this.advisorRead = [...this.draftAdvisorRead];
      this.savedGlobals.set("advisorRead", "the Advisor reading flags");
    }
    return result;
  }

  private globalsDirty(): boolean {
    return (
      this.admissionsDirty() ||
      this.launchCorrectionDirty() ||
      this.advisorReminderDirty() ||
      this.roleEntriesDirty() ||
      this.advisorReadDirty()
    );
  }

  /**
   * Entry lists are global and live in their own file, so Apply and Save both write a changed set
   * before their own step. An unreadable file is reported instead of overwritten.
   */
  private async saveRoleEntries(): Promise<RoleEntriesSaveResult> {
    let result: RoleEntriesSaveResult;
    try {
      result = (await this.onSaveRoleEntries?.(copyRoleEntries(this.draftRoleEntries))) ?? "failed";
    } catch {
      result = "failed";
    }
    if (result === "saved" || result === "unchanged") {
      this.roleEntries = copyRoleEntries(this.draftRoleEntries);
      this.savedGlobals.set("roleEntries", "the optional role entries");
      const blind = this.blindVisionEntries();
      this.message = blind
        ? {
            kind: "info",
            text: `${blind} It will not be advertised or launchable until it points at a model that reads images.`,
          }
        : this.message;
    }
    return result;
  }

  /** A vision entry whose resolved model the registry says cannot read images, if any. */
  private blindVisionEntries(entries = this.draftRoleEntries.vision): string | undefined {
    const blind = entries.filter((entry) => {
      const model = this.candidates.find(
        (candidate) => candidate.provider === entry.provider && candidate.id === entry.model,
      );
      const input = model?.input as readonly string[] | undefined;
      return Array.isArray(input) && !input.includes("image");
    });
    if (!blind.length) return undefined;
    return `${blind.map((entry) => `${entry.provider}/${entry.model}`).join(", ")} ${blind.length === 1 ? "does" : "do"} not accept image input.`;
  }

  /**
   * Settings rows in order. Advisor N+1 appears only once Advisor N exists, so an unused slot costs
   * no row and the list never offers a gap.
   */
  private settingsItems(): SettingsItem[] {
    const effective = resolveDelegateState(this.global, this.draft, this.draftRoleEntries);
    const configured = effective.advisors.length;
    return [
      ...FIELD_IDS.filter(
        (field) =>
          (!isAdvisorField(field) || advisorIndex(field) <= configured) &&
          // An entry row appears only once the row that anchors it is configured, so the list never
          // offers a family with a hole in it.
          (!isEntryField(field) || this.entryRowVisible(field, effective)),
      ),
      ...PANEL_ACTIONS,
    ];
  }

  handleInput(data: string): void {
    if (this.working) return;
    this.message = undefined;
    // Keep the focus on the same row when an edit shows or hides Advisor rows. Navigation moves the
    // index within the previous list and edits change the list, never both, so the row is resolved
    // against the list that existed before this input.
    const previousItems = this.settingsItems();
    this.dispatchInput(data);
    const focusedItem = previousItems[this.settingsIndex];
    const items = this.settingsItems();
    const focusedIndex = focusedItem ? items.indexOf(focusedItem) : -1;
    this.settingsIndex =
      focusedIndex >= 0 ? focusedIndex : Math.min(this.settingsIndex, items.length - 1);
  }

  private dispatchInput(data: string): void {
    if (this.isCompact()) {
      this.handleCompactInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.mode.kind === "settings") this.handleSettingsInput(data);
    else if (this.mode.kind === "enum") this.handleEnumInput(data);
    else if (this.mode.kind === "correction") this.handleCorrectionInput(data);
    else if (this.mode.kind === "reminder") this.handleReminderInput(data);
    else if (this.mode.kind === "provider") this.handleProviderInput(data);
    else if (this.mode.kind === "advisor-read") this.handleAdvisorReadInput(data);
    else if (this.mode.kind === "extension") this.handleExtensionInput(data);
    else if (this.mode.kind === "model") this.handleModelInput(data);
    else if (this.mode.kind === "advanced") this.handleAdvancedInput(data);
    else if (this.mode.kind === "advanced-reader-enabled")
      this.handleAdvancedReaderEnabledInput(data);
    else if (this.mode.kind === "advanced-reader-role") this.handleAdvancedReaderRoleInput(data);
    else if (this.mode.kind === "advanced-input") this.handleAdvancedValueInput(data);
    else if (this.mode.kind === "thinking") this.handleThinkingInput(data);
    else if (this.mode.kind === "thinking-level") this.handleThinkingLevelInput(data);
    else if (this.mode.kind === "continuity") this.handleContinuityInput(data);
    else this.handleDiscardInput(data);

    this.syncInputFocus();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.renderWidth = safeWidth;
    const rows = Math.max(1, this.tui.terminal.rows);
    if (safeWidth < 26 || rows < 9) return this.renderCompact(safeWidth, rows);

    const title = this.renderTitle(safeWidth);
    const footer = this.renderFooter(safeWidth);
    const bodyBudget = Math.max(1, rows - title.length - footer.length);
    const body = this.renderBody(safeWidth, bodyBudget);
    return [...title, ...body, ...footer].slice(0, rows);
  }

  private renderBody(width: number, budget: number): string[] {
    const mode = this.mode;
    if (mode.kind === "settings") return this.renderSettings(width, budget);
    if (mode.kind === "enum") return this.renderEnum(width, budget, mode);
    if (mode.kind === "correction") return this.renderCorrection(width, budget, mode);
    if (mode.kind === "reminder") return this.renderReminder(width, budget, mode);
    if (mode.kind === "provider") return this.renderProvider(width, budget, mode);
    if (mode.kind === "advisor-read") return this.renderAdvisorRead(width, budget, mode);
    if (mode.kind === "extension") return this.renderExtension(width, budget, mode);
    if (mode.kind === "model") return this.renderModel(width, budget, mode);
    if (mode.kind === "advanced") return this.renderAdvanced(width, budget, mode);
    if (mode.kind === "advanced-reader-enabled")
      return this.renderAdvancedReaderEnabled(width, budget, mode);
    if (mode.kind === "advanced-reader-role")
      return this.renderAdvancedReaderRole(width, budget, mode);
    if (mode.kind === "advanced-input") return this.renderAdvancedInput(width, budget, mode);
    if (mode.kind === "thinking") return this.renderThinking(width, budget, mode);
    if (mode.kind === "thinking-level") return this.renderThinkingLevel(width, budget, mode);
    if (mode.kind === "continuity") return this.renderContinuity(width, budget, mode);
    return this.renderDiscard(width, budget);
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  private isCompact(): boolean {
    return this.renderWidth < 26 || this.tui.terminal.rows < 9;
  }

  private handleCompactInput(data: string): void {
    if (this.mode.kind === "discard-confirm") {
      if (this.canRenderDiscardChoices(this.renderWidth, this.tui.terminal.rows)) {
        this.handleDiscardInput(data);
      } else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.mode = { kind: "settings" };
      }
      return;
    }
    if (!matchesKey(data, "escape") && !matchesKey(data, "ctrl+c")) return;
    if (this.mode.kind === "settings") this.requestClose();
    else this.mode = { kind: "settings" };
  }

  private canRenderDiscardChoices(width: number, rows: number): boolean {
    return width >= 17 && rows >= 2;
  }

  private renderCompact(width: number, rows: number): string[] {
    if (this.mode.kind === "discard-confirm") {
      if (!this.canRenderDiscardChoices(width, rows)) {
        return ["Resize to review changes.", "Esc keeps editing."]
          .map((line) => truncateToWidth(line, width, ""))
          .slice(0, rows);
      }
      const choices = [
        selectedLine(this.theme, "Keep editing", width, this.mode.selected === 0),
        selectedLine(this.theme, "Discard changes", width, this.mode.selected === 1),
      ];
      const lines =
        rows === 2
          ? choices
          : rows === 3
            ? ["Discard changes?", ...choices]
            : [
                this.theme.fg("accent", "Delegation policy"),
                "Discard changes?",
                ...choices,
                this.theme.fg("dim", "↑↓ choose · Enter · Esc keep"),
              ];
      return lines.map((line) => truncateToWidth(line, width, "")).slice(0, rows);
    }

    const action = this.mode.kind === "settings" ? "Esc reviews changes." : "Esc returns.";
    return [
      this.theme.fg("accent", "Delegation policy"),
      ...(this.isDirty() ? [this.theme.fg("warning", "Modified")] : []),
      "Terminal too small.",
      "Resize to continue editing.",
      action,
    ]
      .map((line) => truncateToWidth(line, width, ""))
      .slice(0, rows);
  }

  private renderTitle(width: number): string[] {
    const modeLabel =
      this.mode.kind === "settings" || this.mode.kind === "discard-confirm"
        ? "Delegation policy"
        : this.mode.kind === "continuity"
          ? "Delegation policy / Advisor continuity"
          : this.mode.kind === "correction"
            ? "Delegation policy / Launch correction (global)"
            : this.mode.kind === "reminder"
              ? "Delegation policy / Advisor reminder (global)"
              : this.mode.kind === "advanced" ||
                  this.mode.kind === "advanced-reader-enabled" ||
                  this.mode.kind === "advanced-reader-role" ||
                  this.mode.kind === "advanced-input"
                ? "Delegation policy / Context advanced"
                : this.mode.kind === "advisor-read"
                  ? `Delegation policy / Advisor ${this.mode.index + 1} reading`
                  : this.mode.kind === "provider"
                    ? `Delegation policy / Advisor ${this.mode.index + 1} profile`
                    : this.mode.kind === "extension"
                      ? `Delegation policy / Advisor ${this.mode.index + 1} provider extension`
                      : `Delegation policy / ${FIELD_LABELS[this.mode.field]}`;
    const status = this.working ?? (this.isDirty() ? "Modified" : "");
    const gap = Math.max(1, width - visibleWidth(modeLabel) - visibleWidth(status));
    const statusText = this.theme.fg("warning", status);
    const lines = [
      truncateToWidth(
        this.theme.fg("accent", this.theme.bold(modeLabel)) + " ".repeat(gap) + statusText,
        width,
        "",
      ),
    ];
    const notice =
      this.message ??
      (this.diagnostics[0] ? { kind: "error" as const, text: this.diagnostics[0] } : undefined);
    if (notice) {
      lines.push(
        truncateToWidth(
          this.theme.fg(notice.kind === "error" ? "error" : "success", notice.text),
          width,
          "",
        ),
      );
    }
    lines.push(this.theme.fg("borderMuted", "─".repeat(width)));
    return lines;
  }

  private renderFooter(width: number): string[] {
    const hint =
      this.mode.kind === "settings"
        ? "↑↓ move · Enter edit · A apply · C continuity · Esc close"
        : this.mode.kind === "model"
          ? "Type search · ↑↓ move · PgUp/PgDn · Enter choose · Esc back"
          : this.mode.kind === "advanced"
            ? "↑↓ move · Enter edit · Esc back"
            : this.mode.kind === "advanced-input"
              ? "Type value · Enter save · Esc back"
              : this.mode.kind === "discard-confirm"
                ? "↑↓ move · Enter choose · Esc keep editing"
                : "↑↓ move · Enter choose · Esc back";
    return [
      this.theme.fg("borderMuted", "─".repeat(width)),
      truncateToWidth(this.theme.fg("dim", hint), width, ""),
    ];
  }

  private renderSettings(width: number, budget: number): string[] {
    const effective = resolveDelegateState(this.global, this.draft);
    const preview = this.renderPolicyPreview(width, budget, effective);
    const hintRows = this.settingsHintRows(width, budget - preview.length);
    const settingsBudget = Math.max(1, budget - preview.length - hintRows);
    const items = this.settingsItems();
    const blocks = items.map((item, index) => {
      const selected = index === this.settingsIndex;
      if (isDelegateField(item)) {
        const row = this.settingsRow(item, this.settingsValue(item, effective), width);
        return [selectedLine(this.theme, row, width, selected)];
      }
      const disabled = item === "apply" && !this.isDirty();
      const label = disabled ? `${ACTION_LABELS[item]} (no changes)` : ACTION_LABELS[item];
      const line = selectedLine(this.theme, label, width, selected);
      return [disabled ? this.theme.fg("dim", line) : line];
    });
    const focused = items[this.settingsIndex];
    const hint = focused && isDelegateField(focused) ? this.settingsHint(focused, width) : [];

    return [
      ...preview,
      ...this.renderBlockViewport(blocks, this.settingsIndex, width, settingsBudget),
      ...hint.slice(0, hintRows),
    ];
  }

  /** One line per field: padded label followed by the effective value. */
  private settingsRow(field: DelegateField, value: string, width: number): string {
    // Align every value on one column so the list scans vertically. The width cap only matters on
    // very narrow terminals, where a longer label would leave no room for the value at all.
    const labelWidth = Math.max(16, Math.min(SETTINGS_LABEL_WIDTH, Math.floor(width * 0.6)));
    return `${pad(FIELD_LABELS[field], labelWidth)}${value}`;
  }

  private settingsValue(
    field: DelegateField,
    effective: ReturnType<typeof resolveDelegateState>,
  ): string {
    if (isThinkingField(field)) return this.thinkingValue(field);
    if (isEntryField(field)) {
      const current = this.entryList(entryKeyOf(field));
      return `${current ? modelText(current) : "disabled"} · global`;
    }
    if (isAdvisorField(field)) {
      const entry = effective.advisors[advisorIndex(field)];
      if (!entry) return field === "advisor" ? "disabled" : "not configured";
      if (entry.providerExtension) return `${modelText(entry)} · Anthropic auth`;
      const admitted = admissionFor(this.draftAdmissions, entry.provider);
      const roleLaunch = resolveDelegateState(this.global, this.draft).advisorLaunch === "role";
      const canReadHere =
        roleLaunch &&
        !admitted &&
        entry.provider !== RESERVED_PROVIDER &&
        this.draftAdvisorRead[advisorIndex(field)];
      const reading = canReadHere ? " · reads files" : "";
      return `${modelText(entry)}${admitted ? ` · ${admitted.package} ${admitted.version}` : ""}${reading}`;
    }
    if (
      field === "intensity" ||
      field === "preference" ||
      field === "advisorMode" ||
      field === "advisorLaunch"
    )
      return effective[field];
    if (field === "contextShunt")
      return effective.contextShunt.suspended
        ? `off (suspended; configured ${effective.contextShunt.configuredMode})`
        : effective.contextShunt.mode;
    if (field === "contextAdvanced")
      return `reader ${effective.contextShunt.readerEnabled ? "on" : "off"}; ${effective.contextShunt.readerRole}; ${effective.contextShunt.answerMaxBytes} bytes`;
    // An unreadable companion suspends the reminder; it is not a choice the user made, so the row
    // says so until a different value is staged for the file that would replace it.
    if (field === "advisorReminder")
      return this.advisorReminderInvalid && !this.advisorReminderDirty()
        ? "Unavailable/Suspended · global"
        : `${this.draftAdvisorReminder} · global`;
    if (field === "launchCorrection")
      return this.draftLaunchCorrection === "block"
        ? "block · global · measurement"
        : "correct · global";
    if (field === "uiDesign")
      return effective.uiDesign ? modelText(effective.uiDesign) : "disabled";
    return rawModelText(effective[field], "not configured");
  }

  /**
   * The focused field's description and provenance, wrapped to the width. It sits after the list so
   * every field keeps one row, and its height is reserved from the width alone, not from the
   * selection, so the list viewport stays where it is while the focus moves.
   */
  private settingsHint(field: DelegateField, width: number): string[] {
    const provenance = this.sourceDetails(field).join(" · ");
    const text = `${FIELD_DESCRIPTIONS[field]} · ${provenance}`;
    // Indent every wrapped line, not only the first, so the hint reads as one block.
    return wrapTextWithAnsi(text, Math.max(1, width - 2)).map((line) =>
      this.theme.fg("dim", `  ${line}`),
    );
  }

  /** Tallest field hint at this width, capped so the list keeps at least half of the body. */
  private settingsHintRows(width: number, budget: number): number {
    const tallest = FIELD_IDS.reduce(
      (rows, field) => Math.max(rows, this.settingsHint(field, width).length),
      1,
    );
    return Math.max(1, Math.min(tallest, Math.floor(budget / 2)));
  }

  private renderPolicyPreview(
    width: number,
    budget: number,
    effective: ReturnType<typeof resolveDelegateState>,
  ): string[] {
    const delegationError = this.hasRuntimeError && effective.intensity !== "off";
    const validAdvisorCount = effective.advisors.filter((setting) =>
      this.candidates.some(
        (candidate) => candidate.provider === setting.provider && candidate.id === setting.model,
      ),
    ).length;
    const lines = this.isDirty()
      ? buildPolicyPreview(effective, validAdvisorCount)
      : [
          ...(delegationError
            ? ["D:ERR · delegation unavailable; fix the reported role diagnostics"]
            : []),
          ...(this.hasAdvisorError
            ? ["A:ERR · consultation unavailable; delegation is unaffected"]
            : []),
          ...(delegationError
            ? isAdvisorEnabled(effective) && !this.hasAdvisorError
              ? ["Advisor on · consultation only"]
              : []
            : buildPolicyPreview(
                this.hasAdvisorError ? { ...effective, advisorMode: "off" } : effective,
                validAdvisorCount,
              )),
        ];
    const maximum =
      width >= 60 && budget >= 8 ? (effective.intensity === "orchestrator" ? 5 : 4) : 2;
    return ["Effective policy preview", ...lines]
      .slice(0, maximum)
      .map((line) => truncateToWidth(this.theme.fg("dim", line), width, "…"));
  }

  /** Document fields only; optional-role entries live in the sidecar, never in these objects. */
  private modelSetting(
    state: GlobalDefaults | SessionDelegateState,
    field: ThinkingKey | AdvisorField,
  ): ModelRef | null | undefined {
    if (!isAdvisorField(field)) return state[field];
    const advisors = configuredAdvisors(state);
    return advisors === null ? null : advisors?.[advisorIndex(field)];
  }

  /** The sidecar list this panel is editing, so an entry row never touches the session draft. */
  private entryList(key: OptionalRoleEntryKey): ModelRef | undefined {
    const family = entryFamilyOf(key);
    const entry = this.draftRoleEntries[family][optionalRoleEntryKeys(family).indexOf(key)];
    return entry ? { provider: entry.provider, model: entry.model } : undefined;
  }

  /**
   * Reading belongs to a role launch: `consult_advisor` always runs the packaged, tool-free profile,
   * so the step is not offered where the flag could not change what launches.
   */
  /**
   * Reading is a role-launch capability of the plain advisor profile: a provider-dependent profile
   * keeps its own tool-free identity, so the step is not offered for it either.
   */
  private advisorReadOffered(provider?: string): boolean {
    const state = resolveDelegateState(this.global, this.draft);
    if (state.advisorLaunch !== "role") return false;
    if (provider === RESERVED_PROVIDER) return false;
    if (provider && admissionFor(this.draftAdmissions, provider)) return false;
    return true;
  }

  /** True when the row that anchors this entry is already configured. */
  private entryRowVisible(field: EntryField, effective: EffectiveDelegateState): boolean {
    const parent = ENTRY_FIELD_PARENT[field];
    if (parent === "always") return true;
    if (parent === "uiDesign") return effective.uiDesign !== undefined;
    return effective[entryKeyOf(parent)] !== undefined;
  }

  private thinkingSetting(
    state: GlobalDefaults | SessionDelegateState,
    key: ThinkingKey,
  ): ThinkingPolicy | null | undefined {
    return state.thinking?.[key];
  }

  private thinkingValue(field: ThinkingField): string {
    const key = THINKING_FIELD_KEYS[field];
    const local = this.thinkingSetting(this.draft, key);
    const policy = local === undefined ? this.thinkingSetting(this.global, key) : local;
    return policy ? thinkingSummary(policy) : "unset";
  }

  /** The selectable thinking levels come from the role's resolved model only. */
  private thinkingAvailability(
    field: ThinkingField,
  ): { levels: ThinkingLevelName[] } | { reason: string } {
    const key = THINKING_FIELD_KEYS[field];
    const state = resolveDelegateState(this.global, this.draft);
    if (this.modelSetting(this.draft, key) === null)
      return {
        reason: `${ROLE_LABELS[key]} is disabled for this session; levels cannot be listed.`,
      };
    const reference = state[key];
    if (reference === null)
      return {
        reason: `${ROLE_LABELS[key]} is disabled; levels cannot be listed.`,
      };
    if (reference === undefined)
      return {
        reason: `${ROLE_LABELS[key]} is not configured; levels cannot be listed.`,
      };
    const model = this.candidates.find(
      (candidate) => candidate.provider === reference.provider && candidate.id === reference.model,
    );
    if (!model)
      return {
        reason: `${ROLE_LABELS[key]} model ${reference.provider}/${reference.model} is not available; levels cannot be listed.`,
      };
    return {
      levels: getSupportedThinkingLevels(model).filter(isThinkingLevelName),
    };
  }

  private thinkingChoices(field: ThinkingField): ThinkingChoice[] {
    const key = THINKING_FIELD_KEYS[field];
    const global = this.thinkingSetting(this.global, key);
    const availability = this.thinkingAvailability(field);
    return [
      {
        label: `${USE_GLOBAL_DEFAULT} (${global ? thinkingSummary(global) : "none"})`,
        description: "Drop this session override and keep the global policy, if any.",
        action: "inherit",
      },
      {
        label: UNSET_FOR_SESSION,
        description: "Keep no thinking policy for this role in this session.",
        action: "unset",
      },
      ...("levels" in availability
        ? [
            {
              label: FIXED_LEVEL,
              description: "Every launch of this role uses exactly one level.",
              action: "fixed" as const,
            },
            {
              label: RANGE_LEVELS,
              description: "The main agent chooses inside an inclusive minimum and maximum.",
              action: "range" as const,
            },
          ]
        : []),
    ];
  }

  private renderThinking(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "thinking" }>,
  ): string[] {
    const availability = this.thinkingAvailability(mode.field);
    const header =
      "levels" in availability
        ? []
        : wrapTextWithAnsi(this.theme.fg("warning", availability.reason), width);
    const blocks = this.thinkingChoices(mode.field).map((choice, index) => [
      selectedLine(this.theme, choice.label, width, index === mode.selected),
      ...wrapTextWithAnsi(this.theme.fg("dim", `  ${choice.description}`), width),
    ]);
    const viewport = this.renderBlockViewport(
      blocks,
      mode.selected,
      width,
      Math.max(1, budget - header.length),
    );
    return [...header, ...viewport].slice(0, budget);
  }

  private renderThinkingLevel(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "thinking-level" }>,
  ): string[] {
    const header = wrapTextWithAnsi(
      this.theme.fg(
        "dim",
        mode.target === "fixed"
          ? "Fixed level for every launch of this role."
          : mode.target === "min"
            ? "Inclusive minimum of the range."
            : "Inclusive maximum, never below the chosen minimum.",
      ),
      width,
    );
    const levels = this.availableThinkingLevels(mode);
    if (levels.length === 0)
      return [...header, truncateToWidth("No supported levels are available.", width, "")].slice(
        0,
        budget,
      );
    const blocks = levels.map((level, index) => [
      selectedLine(this.theme, level, width, index === mode.selected),
      ...wrapTextWithAnsi(
        this.theme.fg(
          "dim",
          `  ${mode.target === "fixed" ? "fixed level" : mode.target === "min" ? "range minimum" : "range maximum"}`,
        ),
        width,
      ),
    ]);
    const viewport = this.renderBlockViewport(
      blocks,
      mode.selected,
      width,
      Math.max(1, budget - header.length),
    );
    return [...header, ...viewport].slice(0, budget);
  }

  private availableThinkingLevels(
    mode: Extract<PanelMode, { kind: "thinking-level" }>,
  ): ThinkingLevelName[] {
    const availability = this.thinkingAvailability(mode.field);
    const levels = "levels" in availability ? availability.levels : [];
    if (mode.target !== "max" || !mode.minimum) return levels;
    const minimumIndex = levels.indexOf(mode.minimum);
    return minimumIndex < 0 ? levels : levels.slice(minimumIndex);
  }

  private readerStatusDetails(state: ReturnType<typeof resolveDelegateState>): string[] {
    const context = state.contextShunt;
    if (!context.readerEnabled) return ["Reader is disabled."];

    const role = context.readerRole;
    const label = role[0]!.toUpperCase() + role.slice(1);
    const setting = state[role];
    if (setting === null)
      return [`Reader role ${label} is disabled; choose an enabled ordinary role.`];
    if (setting === undefined)
      return [
        `Reader role ${label} is not configured; configure it or choose an enabled ordinary role.`,
      ];

    const runtimeDiagnostic = this.diagnostics.find((diagnostic) =>
      diagnostic.startsWith(`Reader role ${label} model `),
    );
    return runtimeDiagnostic
      ? [runtimeDiagnostic]
      : [`Reader role ${label} is selected; executor is checked only when invoked.`];
  }

  private sourceDetails(field: DelegateField): string[] {
    if (field === "intensity") {
      return [
        "built-in off",
        `global ${this.global.intensity ?? "—"}`,
        `session ${this.draft.intensity ?? "inherit"}`,
      ];
    }
    if (field === "contextShunt" || field === "contextAdvanced") {
      const state = resolveDelegateState(this.global, this.draft);
      const context = state.contextShunt;
      return [
        "built-in off",
        `global ${this.global.contextShunt?.mode ?? "—"}`,
        `session ${this.draft.contextShunt?.mode ?? "inherit"}`,
        `reader ${context.readerEnabled ? "on" : "off"}; role ${context.readerRole}; answer ${context.answerMaxBytes} bytes`,
        ...this.readerStatusDetails(state),
        `limits ${context.limits.fullReadLines}/${context.limits.fullReadBytes} full, ${context.limits.targetedReadLines}/${context.limits.targetedReadBytes} targeted`,
        `patterns ${context.exceptionPatterns.length} exempt, ${context.delegationHintPatterns.length} hint`,
      ];
    }
    if (field === "advisorLaunch")
      return [
        "built-in role",
        `global ${this.global.advisorLaunch ?? "—"}`,
        `session ${this.draft.advisorLaunch ?? "inherit"}`,
      ];
    if (field === "advisorMode") {
      return [
        "built-in with-delegation",
        `global ${this.global.advisorMode ?? "—"}`,
        `session ${this.draft.advisorMode ?? "inherit"}`,
      ];
    }
    if (field === "preference") {
      return [
        "built-in standard",
        `global ${this.global.preference ?? "—"}`,
        `session ${this.draft.preference ?? "inherit"}`,
      ];
    }
    if (field === "advisorReminder")
      return [
        `built-in ${DEFAULT_ADVISOR_REMINDER_MODE}`,
        `global ${this.advisorReminderInvalid ? "unreadable or invalid" : this.advisorReminder}`,
        "not a session setting",
      ];
    if (field === "launchCorrection")
      return [
        `built-in ${DEFAULT_LAUNCH_CORRECTION_MODE}`,
        `global ${this.launchCorrection}`,
        "not a session setting",
      ];
    if (field === "uiDesign" || isAdvisorField(field)) {
      return [
        "built-in disabled",
        `global ${rawModelText(this.modelSetting(this.global, field), "—")}`,
        `session ${rawModelText(this.modelSetting(this.draft, field), "inherit")}`,
      ];
    }
    if (isThinkingField(field)) {
      const key = THINKING_FIELD_KEYS[field];
      const global = this.thinkingSetting(this.global, key);
      const local = this.thinkingSetting(this.draft, key);
      return [
        "built-in unset",
        `global ${global ? thinkingSummary(global) : "—"}`,
        `session ${local !== undefined ? (local ? thinkingSummary(local) : "unset") : "inherit"}`,
      ];
    }
    if (isEntryField(field)) {
      const key = entryKeyOf(field);
      const current = this.entryList(key);
      return [
        "built-in disabled",
        `global ${current ? modelText(current) : "—"}`,
        "not a session setting",
      ];
    }
    return [
      "built-in not configured",
      `global ${rawModelText(this.modelSetting(this.global, field), "—")}`,
      `session ${rawModelText(this.modelSetting(this.draft, field), "inherit")}`,
    ];
  }

  private renderProvider(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "provider" }>,
  ): string[] {
    const blocks = PROVIDER_CHOICES.map((label, index) => [
      selectedLine(this.theme, label, width, index === mode.selected),
    ]);
    // Reserve the choices first. A wrapped explanation must never hide the selection
    // while Enter can still confirm it, including in a short, narrow terminal.
    const description = wrapTextWithAnsi(PROVIDER_DESCRIPTION, width).slice(
      0,
      Math.max(0, budget - Math.min(blocks.length, budget)),
    );
    return [
      ...description,
      ...this.renderBlockViewport(blocks, mode.selected, width, budget - description.length),
    ];
  }

  /**
   * Standard first, then every candidate. A current admission that no longer passes the identity
   * check stays listed so it can be seen and replaced, never silently kept.
   */
  private extensionChoices(provider: string): Array<ProviderPackage | undefined> {
    const current = admissionFor(this.draftAdmissions, provider);
    const listed = (pkg: ProviderPackage) =>
      this.extensionCandidates.some(
        (candidate) => candidate.package === pkg.package && candidate.version === pkg.version,
      );
    return [
      undefined,
      ...this.extensionCandidates,
      ...(current && !listed(current) ? [current] : []),
    ];
  }

  private offersExtension(provider: string): boolean {
    return (
      provider !== RESERVED_PROVIDER &&
      (admissionFor(this.draftAdmissions, provider) !== undefined ||
        (this.extensionCandidates.length > 0 && this.extensionProviders.includes(provider)))
    );
  }

  private renderExtension(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "extension" }>,
  ): string[] {
    const blocks = this.extensionChoices(mode.provider).map((pkg, index) => [
      selectedLine(
        this.theme,
        !pkg
          ? EXTENSION_STANDARD
          : this.extensionCandidates.includes(pkg)
            ? `${pkg.package} ${pkg.version} · trusted extension, identity only`
            : `${pkg.package} ${pkg.version} · no longer installed as admitted`,
        width,
        index === mode.selected,
      ),
    ]);
    // Same reservation as the profile step: the choices stay visible before the explanation.
    const description = wrapTextWithAnsi(extensionDescription(mode.provider), width).slice(
      0,
      Math.max(0, budget - Math.min(blocks.length, budget)),
    );
    return [
      ...description,
      ...this.renderBlockViewport(blocks, mode.selected, width, budget - description.length),
    ];
  }

  private handleExtensionInput(data: string): void {
    if (this.mode.kind !== "extension") return;
    const choices = this.extensionChoices(this.mode.provider);
    const count = choices.length;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected - 1 + count) % count;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % count;
    // Escape keeps the model just chosen with the admission its provider already had.
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const pkg = choices[this.mode.selected];
      const admissions = { ...this.draftAdmissions };
      delete admissions[this.mode.provider];
      if (pkg) admissions[this.mode.provider] = { ...pkg };
      this.draftAdmissions = admissions;
      this.mode = { kind: "settings" };
    }
  }

  private handleCorrectionInput(data: string): void {
    if (this.mode.kind !== "correction") return;
    const count = LAUNCH_CORRECTION_MODES.length;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected - 1 + count) % count;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % count;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      this.draftLaunchCorrection =
        LAUNCH_CORRECTION_MODES[this.mode.selected] ?? this.draftLaunchCorrection;
      this.mode = { kind: "settings" };
    }
  }

  private handleReminderInput(data: string): void {
    if (this.mode.kind !== "reminder") return;
    const count = ADVISOR_REMINDER_MODES.length;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected - 1 + count) % count;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % count;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      this.draftAdvisorReminder =
        ADVISOR_REMINDER_MODES[this.mode.selected] ?? this.draftAdvisorReminder;
      this.mode = { kind: "settings" };
    }
  }

  /**
   * Reading is a capability change on a profile whose input is untrusted, so it is offered as an
   * explicit step after the model and never implied by configuring an Advisor.
   */
  private handleAdvisorReadInput(data: string): void {
    if (this.mode.kind !== "advisor-read") return;
    if (matchesKey(data, "up") || matchesKey(data, "down"))
      this.mode.selected = this.mode.selected === 0 ? 1 : 0;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const index = this.mode.index;
      const wanted = this.mode.selected === 1;
      // Without a writer the flag would show in the row and never reach the file, so it is refused.
      if (!this.onSaveAdvisorRead) {
        this.message = { kind: "error", text: noWriterText("delegation-policy.advisor-read.json") };
        this.mode = { kind: "settings" };
        return;
      }
      while (this.draftAdvisorRead.length <= index) this.draftAdvisorRead.push(false);
      this.draftAdvisorRead[index] = wanted;
      this.mode = { kind: "settings" };
    }
  }

  private renderAdvisorRead(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "advisor-read" }>,
  ): string[] {
    const choices = [
      "Off: the Advisor reads nothing and works from the brief (default)",
      "On: it may open only the paths the brief names",
    ];
    const blocks = choices.map((choice, index) => [
      selectedLine(this.theme, choice, width, index === mode.selected),
    ]);
    const description = wrapTextWithAnsi(
      `Advisor ${mode.index + 1} reading. The reading profile has one tool, read, and no shell, write, network or extensions. A model that cannot accept images will say so instead of describing them, and the host decides which paths read may reach.`,
      width,
    ).slice(0, Math.max(0, budget - Math.min(blocks.length, budget)));
    return [
      ...description,
      ...this.renderBlockViewport(blocks, mode.selected, width, budget - description.length),
    ];
  }

  private handleProviderInput(data: string): void {
    if (this.mode.kind !== "provider") return;
    const count = PROVIDER_CHOICES.length;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected - 1 + count) % count;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % count;
    // Escape keeps the model just chosen with the profile it already had.
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const entries = structuredClone(resolveDelegateState(this.global, this.draft).advisors);
      const entry = entries[this.mode.index];
      if (!entry) {
        this.mode = { kind: "settings" };
        return;
      }
      if (this.mode.selected === 1) entry.providerExtension = "anthropic-auth";
      else delete entry.providerExtension;
      this.replaceAdvisors(entries);
      this.mode = { kind: "settings" };
    }
  }

  private renderCorrection(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "correction" }>,
  ): string[] {
    const blocks = LAUNCH_CORRECTION_MODES.map((value, index) => [
      selectedLine(this.theme, CORRECTION_CHOICES[value], width, index === mode.selected),
    ]);
    // Reserve the choices first, so a wrapped explanation never hides the selection.
    const description = wrapTextWithAnsi(CORRECTION_DESCRIPTION, width).slice(
      0,
      Math.max(0, budget - Math.min(blocks.length, budget)),
    );
    return [
      ...description,
      ...this.renderBlockViewport(blocks, mode.selected, width, budget - description.length),
    ];
  }

  private renderReminder(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "reminder" }>,
  ): string[] {
    const blocks = ADVISOR_REMINDER_MODES.map((value, index) => [
      selectedLine(this.theme, REMINDER_CHOICES[value], width, index === mode.selected),
    ]);
    // Reserve the choices first, so a wrapped explanation never hides the selection.
    const description = wrapTextWithAnsi(REMINDER_DESCRIPTION, width).slice(
      0,
      Math.max(0, budget - Math.min(blocks.length, budget)),
    );
    return [
      ...description,
      ...this.renderBlockViewport(blocks, mode.selected, width, budget - description.length),
    ];
  }

  private renderEnum(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "enum" }>,
  ): string[] {
    const values =
      mode.field === "intensity"
        ? INTENSITIES
        : mode.field === "preference"
          ? PREFERENCES
          : mode.field === "advisorLaunch"
            ? ADVISOR_LAUNCH_MODES
            : mode.field === "advisorMode"
              ? ADVISOR_MODES
              : CONTEXT_SHUNT_MODES;
    const descriptions =
      mode.field === "intensity"
        ? {
            off: "No execution-delegation policy. Advisor can remain on independently.",
            normal: "Delegate when the expected benefit clearly outweighs overhead.",
            aggressive: "Delegate suitable substantial work by default.",
            orchestrator: "Delegate transferable detail and keep ownership with the main agent.",
          }
        : mode.field === "preference"
          ? {
              efficient: "Tie-break comparable fits toward Small.",
              standard: "No extra Small or Medium bias.",
              intensive: "Tie-break comparable fits toward Medium.",
            }
          : mode.field === "advisorLaunch"
            ? {
                role: "Main agent launches all advisors in one background call.",
                tool: "Explicit consult_advisor launches through the host executor, never from hooks.",
              }
            : mode.field === "advisorMode"
              ? {
                  off: "No Advisor guidance; keep the saved model.",
                  on: "Consult even with delegation off. Sends briefs to another model and may incur cost.",
                  "with-delegation":
                    "Consult only while delegation is active; preserves existing behavior.",
                }
              : {
                  off: "No classification, metrics, archive, or interception.",
                  observe: "Record would-block decisions without changing calls or results.",
                  enforce: "Block only declared excess and protect known textual results.",
                };
    const globalValue =
      mode.field === "contextShunt"
        ? (this.global.contextShunt?.mode ?? "off")
        : (this.global[mode.field] ??
          (mode.field === "intensity"
            ? "off"
            : mode.field === "advisorLaunch"
              ? "role"
              : mode.field === "advisorMode"
                ? "with-delegation"
                : "standard"));
    const options = [
      {
        label: `${USE_GLOBAL_DEFAULT} (${globalValue})`,
        description: "Use the current global value.",
      },
      ...values.map((value) => ({
        label: value,
        description: descriptions[value],
      })),
    ];
    const blocks = options.map((option, index) => [
      selectedLine(this.theme, option.label, width, index === mode.selected),
      ...wrapTextWithAnsi(this.theme.fg("dim", `  ${option.description}`), width),
    ]);
    return this.renderBlockViewport(blocks, mode.selected, width, budget);
  }

  private renderModel(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "model" }>,
  ): string[] {
    const inputWidth = Math.max(1, width - 8);
    const [input = ""] = this.searchInput.render(inputWidth);
    const inputText = input.startsWith("> ") ? input.slice(2) : input;
    const choices = this.modelChoices(mode.field, mode.query);
    const pinnedCount = 2;
    const pinned = choices.slice(0, pinnedCount);
    const models = choices.slice(pinnedCount);
    const pinnedLines = pinned.map((choice, index) =>
      selectedLine(
        this.theme,
        choice.description ? `${choice.label} (${choice.description})` : choice.label,
        width,
        mode.selected === index,
      ),
    );
    const dividerRows = budget > pinnedLines.length + 3 ? 1 : 0;
    const selectedChoice = choices[mode.selected];
    const metadata =
      selectedChoice?.kind === "model"
        ? modelMetadata(
            this.candidates.find(
              (model) =>
                modelKey({ provider: model.provider, model: model.id }) === selectedChoice.key,
            ),
          )
        : [];
    const fixedRows = 1 + pinnedLines.length + dividerRows;
    const reservedModelRows = models.length > 0 && budget > fixedRows ? 1 : 0;
    const availableDetailRows = Math.max(0, budget - fixedRows - reservedModelRows - 1);
    const details = metadata.slice(0, availableDetailRows);
    const detailRows = details.length > 0 ? details.length + 1 : 0;
    const availableListRows = Math.max(0, budget - fixedRows - detailRows);
    const listBudget = Math.min(11, availableListRows);
    const modelBlocks = models.map((choice, index) => {
      const combinedIndex = index + pinnedCount;
      const provider = choice.kind === "model" ? choice.reference.provider : "";
      const label = provider
        ? `${choice.label} ${this.theme.fg("muted", `[${provider}]`)}`
        : choice.label;
      return [selectedLine(this.theme, label, width, mode.selected === combinedIndex)];
    });
    const modelSelected = Math.max(0, mode.selected - pinnedCount);
    const modelLines =
      listBudget > 0 && modelBlocks.length > 0
        ? this.renderBlockViewport(modelBlocks, modelSelected, width, listBudget, 10)
        : [];
    if (models.length === 0 && modelLines.length < listBudget) {
      modelLines.push(
        truncateToWidth(
          this.theme.fg(
            "warning",
            mode.query ? `No models match “${mode.query}”.` : "No available models.",
          ),
          width,
          "",
        ),
      );
    }
    return [
      truncateToWidth(`Search: ${inputText}`, width, ""),
      ...pinnedLines,
      ...(dividerRows ? [this.theme.fg("borderMuted", "─".repeat(width))] : []),
      ...modelLines,
      ...(detailRows ? ["", ...details.map((line) => this.theme.fg("muted", `  ${line}`))] : []),
    ].slice(0, budget);
  }

  private renderAdvanced(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "advanced" }>,
  ): string[] {
    const delegateState = resolveDelegateState(this.global, this.draft);
    const effective = delegateState.contextShunt;
    const local = this.draft.contextShunt ?? {};
    const global = this.global.contextShunt ?? {};
    const limit = (key: keyof NonNullable<ContextShuntSettings["limits"]>) => effective.limits[key];
    const value = (field: AdvancedField): string => {
      switch (field) {
        case "readerEnabled":
          return effective.readerEnabled ? "on" : "off";
        case "readerRole":
          return effective.readerRole;
        case "answerMaxBytes":
          return String(effective.answerMaxBytes);
        case "fullReadLines":
        case "fullReadBytes":
        case "targetedReadLines":
        case "targetedReadBytes":
          return String(limit(field));
        case "exceptionPatterns":
          return effective.exceptionPatterns.length
            ? effective.exceptionPatterns.join(", ")
            : "none";
        case "delegationHintPatterns":
          return effective.delegationHintPatterns.length
            ? effective.delegationHintPatterns.join(", ")
            : "none";
        case "resetContextShunt":
          return "Return all ContextShunt fields to inheritance";
        case "back":
          return "Return to delegation settings";
      }
    };
    const source = (field: AdvancedField): string => {
      if (field === "resetContextShunt" || field === "back") return "";
      const key = field as keyof ContextShuntSettings;
      const localValue = isLimitField(field) ? local.limits?.[field] : local[key];
      const globalValue = isLimitField(field) ? global.limits?.[field] : global[key];
      const inheritance = `built-in ${field === "readerEnabled" ? "off" : field === "answerMaxBytes" ? "8192" : "inherit"} · global ${globalValue === undefined ? "—" : "set"} · session ${localValue === undefined ? "inherit" : "set"}`;
      return field === "readerRole"
        ? `${inheritance} · ${this.readerStatusDetails(delegateState).join(" ")}`
        : inheritance;
    };
    const labels: Record<AdvancedField, string> = {
      readerEnabled: "Reader enabled",
      readerRole: "Reader role",
      answerMaxBytes: "Reader answer max bytes",
      fullReadLines: "Full read lines",
      fullReadBytes: "Full read bytes",
      targetedReadLines: "Targeted read lines",
      targetedReadBytes: "Targeted read bytes",
      exceptionPatterns: "Exempt patterns",
      delegationHintPatterns: "Delegation hint patterns",
      resetContextShunt: "Reset ContextShunt draft",
      back: "Back",
    };
    const blocks = ADVANCED_FIELDS.map((field, index) => [
      selectedLine(this.theme, `${labels[field]}: ${value(field)}`, width, index === mode.selected),
      ...wrapTextWithAnsi(this.theme.fg("dim", `  ${source(field)}`), width),
    ]);
    return this.renderBlockViewport(blocks, mode.selected, width, budget);
  }

  private renderAdvancedReaderEnabled(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "advanced-reader-enabled" }>,
  ): string[] {
    const globalEnabled = this.global.contextShunt?.readerEnabled ?? false;
    const choices = [
      {
        label: `${USE_GLOBAL_DEFAULT} (${globalEnabled ? "on" : "off"})`,
        description: "Use the global reader-enabled setting.",
      },
      { label: "off", description: "Do not request inline reader delegation." },
      { label: "on", description: "Allow inline reader delegation when invoked." },
    ];
    return this.renderBlockViewport(
      choices.map((choice, index) => [
        selectedLine(this.theme, choice.label, width, index === mode.selected),
        ...wrapTextWithAnsi(this.theme.fg("dim", `  ${choice.description}`), width),
      ]),
      mode.selected,
      width,
      budget,
    );
  }

  private renderAdvancedReaderRole(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "advanced-reader-role" }>,
  ): string[] {
    const globalRole = this.global.contextShunt?.readerRole ?? "small";
    const roles: Array<{ label: string; description: string }> = [
      {
        label: `${USE_GLOBAL_DEFAULT} (${globalRole})`,
        description: "Use the global reader role.",
      },
      ...(["small", "medium", "large"] as const).map((role) => ({
        label: role,
        description: "Request this existing ordinary role; no separate reader model is stored.",
      })),
    ];
    return this.renderBlockViewport(
      roles.map((role, index) => [
        selectedLine(this.theme, role.label, width, index === mode.selected),
        ...wrapTextWithAnsi(this.theme.fg("dim", `  ${role.description}`), width),
      ]),
      mode.selected,
      width,
      budget,
    );
  }

  private renderAdvancedInput(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "advanced-input" }>,
  ): string[] {
    const labels: Record<EditableAdvancedField, string> = {
      answerMaxBytes: "Reader answer max bytes",
      fullReadLines: "Full read lines",
      fullReadBytes: "Full read bytes",
      targetedReadLines: "Targeted read lines",
      targetedReadBytes: "Targeted read bytes",
      exceptionPatterns: "Exempt patterns",
      delegationHintPatterns: "Delegation hint patterns",
    };
    const instruction = mode.field.endsWith("Patterns")
      ? "Comma-separated glob patterns; blank inherits global."
      : mode.field === "answerMaxBytes"
        ? "Integer from 1024 to 16384; blank inherits global."
        : "Positive integer; blank inherits global.";
    const [input = ""] = this.advancedInput.render(Math.max(1, width - 8));
    return [
      truncateToWidth(labels[mode.field], width, ""),
      ...wrapTextWithAnsi(this.theme.fg("dim", instruction), width),
      truncateToWidth(`Value: ${input.startsWith("> ") ? input.slice(2) : input}`, width, ""),
    ].slice(0, budget);
  }

  /**
   * Advisor continuity is observable and repairable from here, never by editing the private
   * journal. The status line is read without taking the journal lock, and both actions report the
   * outcome in the panel's own message row.
   */
  private async loadContinuity(): Promise<void> {
    if (!this.continuityStatus) return;
    this.continuityBusy = true;
    this.tui.requestRender();
    try {
      this.continuityText = await this.continuityStatus();
    } catch {
      this.continuityText = "Advisor continuity status is unavailable.";
    } finally {
      this.continuityBusy = false;
      this.tui.requestRender();
    }
  }

  private handleContinuityInput(data: string): void {
    if (this.mode.kind !== "continuity") return;
    const count = CONTINUITY_ACTIONS.length + 1;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected - 1 + count) % count;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % count;
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = count - 1;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const action = CONTINUITY_ACTIONS[this.mode.selected];
      if (!action) {
        this.mode = { kind: "settings" };
        return;
      }
      if (action === "status") {
        void this.loadContinuity();
        return;
      }
      const run = action === "recover" ? this.onRecoverContinuity : this.onResetContinuity;
      if (!run) {
        this.message = {
          kind: "error",
          text: "Advisor continuity is not available in this session.",
        };
        return;
      }
      this.continuityBusy = true;
      void run().then(
        (outcome) => {
          this.message = { kind: outcome.type, text: outcome.message };
          this.continuityBusy = false;
          void this.loadContinuity();
        },
        () => {
          this.message = { kind: "error", text: "Advisor continuity action failed." };
          this.continuityBusy = false;
          this.tui.requestRender();
        },
      );
    }
  }

  private renderContinuity(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "continuity" }>,
  ): string[] {
    const blocks = [
      ...CONTINUITY_ACTIONS.map((action, index) => [
        selectedLine(this.theme, CONTINUITY_LABELS[action], width, index === mode.selected),
      ]),
      [selectedLine(this.theme, "Back", width, mode.selected === CONTINUITY_ACTIONS.length)],
    ];
    const description = wrapTextWithAnsi(CONTINUITY_DESCRIPTION, width).slice(
      0,
      Math.max(0, Math.floor(budget / 2)),
    );
    const status = this.continuityBusy
      ? ["Reading Advisor continuity…"]
      : wrapTextWithAnsi(this.continuityText ?? "No continuity state was read yet.", width);
    const statusRows = status.slice(
      0,
      Math.max(0, budget - description.length - Math.min(blocks.length, budget)),
    );
    return [
      ...description,
      ...statusRows.map((line) => this.theme.fg("dim", line)),
      ...this.renderBlockViewport(
        blocks,
        mode.selected,
        width,
        Math.max(1, budget - description.length - statusRows.length),
      ),
    ];
  }

  private renderDiscard(width: number, budget: number): string[] {
    const options = ["Keep editing", "Discard changes"];
    const selected = this.mode.kind === "discard-confirm" ? this.mode.selected : 0;
    const lines = [truncateToWidth("Discard unapplied changes?", width, ""), ""];
    for (const [index, option] of options.entries()) {
      lines.push(selectedLine(this.theme, option, width, index === selected));
    }
    return lines.slice(0, budget);
  }

  private renderBlockViewport(
    blocks: string[][],
    selected: number,
    width: number,
    budget: number,
    maxVisibleBlocks = Number.POSITIVE_INFINITY,
  ): string[] {
    const totalRows = blocks.reduce((sum, block) => sum + block.length, 0);
    const reserveIndicator = totalRows > budget || blocks.length > maxVisibleBlocks ? 1 : 0;
    const contentBudget = Math.max(1, Math.min(budget - reserveIndicator, maxVisibleBlocks));
    const [start, end] = visibleBlockRange(blocks, selected, contentBudget);
    const lines = blocks
      .slice(start, end)
      .flat()
      .map((line) => truncateToWidth(line, width, ""));
    if (reserveIndicator && lines.length < budget) {
      lines.push(
        truncateToWidth(
          this.theme.fg("dim", `  ${start + 1}–${end} of ${blocks.length}`),
          width,
          "",
        ),
      );
    }
    return lines.slice(0, budget);
  }

  private handleSettingsInput(data: string): void {
    if (matchesKey(data, "up")) this.moveSettings(-1);
    else if (matchesKey(data, "down")) this.moveSettings(1);
    else if (matchesKey(data, "home")) this.settingsIndex = 0;
    else if (matchesKey(data, "end")) this.settingsIndex = this.settingsItems().length - 1;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.requestClose();
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.activateSettingsItem();
    else if (data.toLowerCase() === "a") void this.applyDraft();
    // Advisor continuity is one extra row of the same panel, not a second interface.
    else if (data.toLowerCase() === "c") {
      this.mode = { kind: "continuity", selected: 0 };
      void this.loadContinuity();
    }
  }

  private moveSettings(delta: number): void {
    const count = this.settingsItems().length;
    this.settingsIndex = (this.settingsIndex + delta + count) % count;
  }

  private activateSettingsItem(): void {
    const item = this.settingsItems()[this.settingsIndex];
    if (!item) return;
    if (item === "contextAdvanced") {
      this.mode = { kind: "advanced", selected: 0 };
      return;
    }
    if (
      item === "intensity" ||
      item === "preference" ||
      item === "contextShunt" ||
      item === "advisorMode" ||
      item === "advisorLaunch"
    ) {
      const values =
        item === "intensity"
          ? INTENSITIES
          : item === "preference"
            ? PREFERENCES
            : item === "advisorLaunch"
              ? ADVISOR_LAUNCH_MODES
              : item === "advisorMode"
                ? ADVISOR_MODES
                : CONTEXT_SHUNT_MODES;
      const current = item === "contextShunt" ? this.draft.contextShunt?.mode : this.draft[item];
      this.mode = {
        kind: "enum",
        field: item,
        selected: current ? values.indexOf(current as never) + 1 : 0,
      };
      return;
    }
    if (
      item === "small" ||
      item === "medium" ||
      item === "large" ||
      item === "uiDesign" ||
      isAdvisorField(item) ||
      isEntryField(item)
    ) {
      this.openModelSelector(item);
      return;
    }
    if (isThinkingField(item)) {
      this.mode = { kind: "thinking", field: item, selected: this.thinkingSelection(item) };
      return;
    }
    if (item === "advisorReminder") {
      this.mode = {
        kind: "reminder",
        selected: ADVISOR_REMINDER_MODES.indexOf(this.draftAdvisorReminder),
      };
      return;
    }
    if (item === "launchCorrection") {
      this.mode = {
        kind: "correction",
        selected: LAUNCH_CORRECTION_MODES.indexOf(this.draftLaunchCorrection),
      };
      return;
    }
    if (item === "apply") void this.applyDraft();
    else if (item === "save-defaults") void this.saveDefaults();
    else if (item === "reset")
      this.draft = { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off", advisorMode: "off" };
    else this.requestClose();
  }

  private handleEnumInput(data: string): void {
    if (this.mode.kind !== "enum") return;
    const values =
      this.mode.field === "intensity"
        ? INTENSITIES
        : this.mode.field === "preference"
          ? PREFERENCES
          : this.mode.field === "advisorLaunch"
            ? ADVISOR_LAUNCH_MODES
            : this.mode.field === "advisorMode"
              ? ADVISOR_MODES
              : CONTEXT_SHUNT_MODES;
    const count = values.length + 1;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected - 1 + count) % count;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % count;
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = count - 1;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const selected = this.mode.selected;
      const field = this.mode.field;
      if (selected === 0) {
        if (field === "contextShunt") {
          const context = { ...(this.draft.contextShunt ?? {}) };
          delete context.mode;
          this.replaceContextDraft(context);
        } else delete this.draft[field];
      } else if (field === "intensity") this.draft.intensity = values[selected - 1] as Intensity;
      else if (field === "preference") this.draft.preference = values[selected - 1] as Preference;
      else if (field === "advisorLaunch")
        this.draft.advisorLaunch = values[selected - 1] as AdvisorLaunch;
      else if (field === "advisorMode")
        this.draft.advisorMode = values[selected - 1] as AdvisorMode;
      else
        this.draft.contextShunt = {
          ...(this.draft.contextShunt ?? {}),
          mode: values[selected - 1] as "off" | "observe" | "enforce",
        };
      this.mode = { kind: "settings" };
    }
  }

  private thinkingSelection(field: ThinkingField): number {
    const key = THINKING_FIELD_KEYS[field];
    const policy = this.thinkingSetting(this.draft, key);
    if (policy === undefined) return 0;
    if (!policy) return 1;
    const choices = this.thinkingChoices(field);
    const wanted: ThinkingAction = "level" in policy ? "fixed" : "range";
    const index = choices.findIndex((choice) => choice.action === wanted);
    return index < 0 ? 1 : index;
  }

  private handleThinkingInput(data: string): void {
    if (this.mode.kind !== "thinking") return;
    const count = this.thinkingChoices(this.mode.field).length;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected - 1 + count) % count;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % count;
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = count - 1;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.activateThinkingChoice();
  }

  private activateThinkingChoice(): void {
    if (this.mode.kind !== "thinking") return;
    const field = this.mode.field;
    const choice = this.thinkingChoices(field)[this.mode.selected];
    if (!choice) return;
    if (choice.action === "inherit") {
      this.setThinkingPolicy(field, undefined);
      this.mode = { kind: "settings" };
      return;
    }
    if (choice.action === "unset") {
      this.setThinkingPolicy(field, null);
      this.mode = { kind: "settings" };
      return;
    }
    this.mode = {
      kind: "thinking-level",
      field,
      target: choice.action === "fixed" ? "fixed" : "min",
      selected: this.thinkingLevelSelection(field, choice.action === "fixed" ? "fixed" : "min"),
    };
  }

  private thinkingLevelSelection(
    field: ThinkingField,
    target: "fixed" | "min" | "max",
    minimum?: ThinkingLevelName,
  ): number {
    const key = THINKING_FIELD_KEYS[field];
    const policy = this.thinkingSetting(this.draft, key) ?? this.thinkingSetting(this.global, key);
    const levels = this.availableThinkingLevels({
      kind: "thinking-level",
      field,
      target,
      selected: 0,
      ...(minimum ? { minimum } : {}),
    });
    const wanted = !policy
      ? undefined
      : target === "fixed"
        ? "level" in policy
          ? policy.level
          : policy.min
        : target === "min"
          ? "level" in policy
            ? policy.level
            : policy.min
          : "level" in policy
            ? undefined
            : policy.max;
    const index = wanted ? levels.indexOf(wanted) : -1;
    return index >= 0 ? index : 0;
  }

  private handleThinkingLevelInput(data: string): void {
    if (this.mode.kind !== "thinking-level") return;
    const field = this.mode.field;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.mode = { kind: "thinking", field, selected: this.thinkingSelection(field) };
      return;
    }
    const levels = this.availableThinkingLevels(this.mode);
    if (levels.length === 0) return;
    if (matchesKey(data, "up")) this.mode.selected = Math.max(0, this.mode.selected - 1);
    else if (matchesKey(data, "down"))
      this.mode.selected = Math.min(levels.length - 1, this.mode.selected + 1);
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = levels.length - 1;
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.commitThinkingLevel();
  }

  private commitThinkingLevel(): void {
    if (this.mode.kind !== "thinking-level") return;
    const { field, target } = this.mode;
    const level = this.availableThinkingLevels(this.mode)[this.mode.selected];
    if (!level) return;
    if (target === "fixed") {
      this.setThinkingPolicy(field, { level });
      this.mode = { kind: "settings" };
      return;
    }
    if (target === "min") {
      this.mode = {
        kind: "thinking-level",
        field,
        target: "max",
        selected: this.thinkingLevelSelection(field, "max", level),
        minimum: level,
      };
      return;
    }
    const minimum = this.mode.minimum ?? level;
    this.setThinkingPolicy(
      field,
      minimum === level ? { level: minimum } : { min: minimum, max: level },
    );
    this.mode = { kind: "settings" };
  }

  private setThinkingPolicy(field: ThinkingField, policy: ThinkingPolicy | null | undefined): void {
    const key = THINKING_FIELD_KEYS[field];
    const thinking: SessionThinkingSettings = { ...(this.draft.thinking ?? {}) };
    if (policy === undefined) delete thinking[key];
    else thinking[key] = policy;
    if (Object.keys(thinking).length) this.draft.thinking = thinking;
    else delete this.draft.thinking;
  }

  private handleAdvancedInput(data: string): void {
    if (this.mode.kind !== "advanced") return;
    if (matchesKey(data, "up"))
      this.mode.selected =
        (this.mode.selected - 1 + ADVANCED_FIELDS.length) % ADVANCED_FIELDS.length;
    else if (matchesKey(data, "down"))
      this.mode.selected = (this.mode.selected + 1) % ADVANCED_FIELDS.length;
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = ADVANCED_FIELDS.length - 1;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.activateAdvancedField();
  }

  private activateAdvancedField(): void {
    if (this.mode.kind !== "advanced") return;
    const field = ADVANCED_FIELDS[this.mode.selected];
    if (!field) return;
    if (field === "back") {
      this.mode = { kind: "settings" };
      return;
    }
    if (field === "resetContextShunt") {
      delete this.draft.contextShunt;
      return;
    }
    if (field === "readerEnabled") {
      const selected = this.draft.contextShunt?.readerEnabled;
      this.mode = {
        kind: "advanced-reader-enabled",
        selected: selected === undefined ? 0 : selected ? 2 : 1,
      };
      return;
    }
    if (field === "readerRole") {
      const selected = this.draft.contextShunt?.readerRole;
      this.mode = {
        kind: "advanced-reader-role",
        selected: selected ? (["small", "medium", "large"] as const).indexOf(selected) + 1 : 0,
      };
      return;
    }
    this.advancedInput.setValue(this.advancedRawValue(field));
    this.mode = { kind: "advanced-input", field };
  }

  private handleAdvancedReaderEnabledInput(data: string): void {
    if (this.mode.kind !== "advanced-reader-enabled") return;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected + 2) % 3;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % 3;
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = 2;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "advanced", selected: 0 };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const readerEnabled = this.mode.selected === 0 ? undefined : this.mode.selected === 2;
      this.setContextReaderEnabled(readerEnabled);
      this.mode = { kind: "advanced", selected: 0 };
    }
  }

  private handleAdvancedReaderRoleInput(data: string): void {
    if (this.mode.kind !== "advanced-reader-role") return;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected + 3) % 4;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % 4;
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = 3;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "advanced", selected: 0 };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const role =
        this.mode.selected === 0
          ? undefined
          : (["small", "medium", "large"] as const)[this.mode.selected - 1];
      this.setContextValue("readerRole", role);
      this.mode = { kind: "advanced", selected: 0 };
    }
  }

  private handleAdvancedValueInput(data: string): void {
    if (this.mode.kind !== "advanced-input") return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.mode = { kind: "advanced", selected: 0 };
      return;
    }
    if (matchesKey(data, "enter")) {
      this.commitAdvancedValue(this.mode.field);
      return;
    }
    this.advancedInput.handleInput(data);
  }

  private advancedRawValue(field: EditableAdvancedField): string {
    const context = this.draft.contextShunt;
    if (field === "exceptionPatterns" || field === "delegationHintPatterns")
      return context?.[field]?.join(", ") ?? "";
    if (field === "answerMaxBytes") return String(context?.answerMaxBytes ?? "");
    return isLimitField(field) ? String(context?.limits?.[field] ?? "") : "";
  }

  private commitAdvancedValue(field: EditableAdvancedField): void {
    const raw = this.advancedInput.getValue().trim();
    if (!raw) {
      if (field === "exceptionPatterns" || field === "delegationHintPatterns")
        this.setContextValue(field, undefined);
      else if (field === "answerMaxBytes") this.setContextAnswerMaxBytes(undefined);
      else this.setContextLimit(field, undefined);
      this.mode = { kind: "advanced", selected: 0 };
      return;
    }
    if (field === "exceptionPatterns" || field === "delegationHintPatterns") {
      const patterns = raw
        .split(",")
        .map((pattern) => pattern.trim())
        .filter(Boolean);
      if (
        patterns.length > 32 ||
        patterns.some(
          (pattern) =>
            pattern.length > 256 ||
            pattern.includes("\0") ||
            pattern.includes("..") ||
            /^(?:[A-Za-z]:[\\/]|\\\\)/.test(pattern),
        )
      ) {
        this.message = {
          kind: "error",
          text: "Use up to 32 safe relative patterns.",
        };
        return;
      }
      this.setContextValue(field, patterns);
      this.mode = { kind: "advanced", selected: 0 };
      return;
    }
    const value = Number(raw);
    const [minimum, maximum] = field === "answerMaxBytes" ? [1024, 16384] : [1, 1024 * 1024];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      this.message = {
        kind: "error",
        text:
          field === "answerMaxBytes"
            ? "Enter an integer from 1024 to 16384."
            : "Enter a positive integer no greater than 1048576.",
      };
      return;
    }
    if (field === "answerMaxBytes") this.setContextAnswerMaxBytes(value);
    else this.setContextLimit(field, value);
    this.mode = { kind: "advanced", selected: 0 };
  }

  private setContextReaderEnabled(value: boolean | undefined): void {
    const context: ContextShuntSettings = { ...(this.draft.contextShunt ?? {}) };
    if (value === undefined) delete context.readerEnabled;
    else context.readerEnabled = value;
    this.replaceContextDraft(context);
  }

  private setContextAnswerMaxBytes(value: number | undefined): void {
    const context: ContextShuntSettings = { ...(this.draft.contextShunt ?? {}) };
    if (value === undefined) delete context.answerMaxBytes;
    else context.answerMaxBytes = value;
    this.replaceContextDraft(context);
  }

  private setContextValue(
    key: "readerRole" | "exceptionPatterns" | "delegationHintPatterns",
    value: ModelRole | string[] | undefined,
  ): void {
    const context: ContextShuntSettings = {
      ...(this.draft.contextShunt ?? {}),
    };
    if (value === undefined) delete context[key];
    else if (key === "readerRole") context.readerRole = value as ModelRole;
    else context[key] = value as string[];
    this.replaceContextDraft(context);
  }

  private setContextLimit(field: LimitField, value: number | undefined): void {
    const context: ContextShuntSettings = {
      ...(this.draft.contextShunt ?? {}),
    };
    const limits = { ...(context.limits ?? {}) };
    if (value === undefined) delete limits[field];
    else limits[field] = value;
    if (Object.keys(limits).length) context.limits = limits;
    else delete context.limits;
    this.replaceContextDraft(context);
  }

  private replaceContextDraft(context: ContextShuntSettings): void {
    if (Object.keys(context).length) this.draft.contextShunt = context;
    else delete this.draft.contextShunt;
  }

  private openModelSelector(field: ModelField): void {
    this.searchInput.setValue("");
    const choices = this.modelChoices(field, "");
    const current = isEntryField(field)
      ? (this.entryList(entryKeyOf(field)) ?? null)
      : this.modelSetting(this.draft, field);
    let selected = 0;
    if (current === null) selected = choices.findIndex((choice) => choice.kind === "disabled");
    else if (current) selected = choices.findIndex((choice) => choice.key === modelKey(current));
    this.mode = {
      kind: "model",
      field,
      selected: Math.max(0, selected),
      query: "",
    };
  }

  private handleModelInput(data: string): void {
    if (this.mode.kind !== "model") return;
    const choices = this.modelChoices(this.mode.field, this.mode.query);
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.mode = { kind: "settings" };
      return;
    }
    if (matchesKey(data, "up")) this.moveModelSelection(-1, choices.length);
    else if (matchesKey(data, "down")) this.moveModelSelection(1, choices.length);
    else if (matchesKey(data, "pageUp"))
      this.moveModelSelection(-this.modelPageSize(), choices.length);
    else if (matchesKey(data, "pageDown"))
      this.moveModelSelection(this.modelPageSize(), choices.length);
    else if (matchesKey(data, "enter")) this.chooseModel(choices[this.mode.selected]);
    else {
      const previous = choices[this.mode.selected];
      this.searchInput.handleInput(data);
      this.mode.query = this.searchInput.getValue();
      const nextChoices = this.modelChoices(this.mode.field, this.mode.query);
      const preserved =
        previous?.kind === "model"
          ? nextChoices.findIndex((choice) => choice.key === previous.key)
          : -1;
      this.mode.selected = preserved >= 0 ? preserved : 0;
    }
  }

  private moveModelSelection(delta: number, count: number): void {
    if (this.mode.kind !== "model" || count === 0) return;
    this.mode.selected = Math.max(0, Math.min(count - 1, this.mode.selected + delta));
  }

  private modelPageSize(): number {
    return Math.max(1, Math.floor((this.tui.terminal.rows - 8) / 2));
  }

  private chooseModel(choice: ModelChoice | undefined): void {
    if (!choice || this.mode.kind !== "model") return;
    const field = this.mode.field;
    if (isAdvisorField(field)) {
      const index = advisorIndex(field);
      const entries = structuredClone(resolveDelegateState(this.global, this.draft).advisors);
      const previous = entries[index];
      const global =
        choice.kind === "global" ? configuredAdvisors(this.global)?.[index] : undefined;
      const reference = choice.kind === "model" ? choice.reference : global;
      if (index > entries.length && reference) {
        this.message = {
          kind: "error",
          text: `Configure Advisor ${index} before adding Advisor ${index + 1}.`,
        };
        return;
      }
      if (!reference) {
        // Advisor 1 anchors the list; removing a later entry moves the next one up.
        if (index === 0) entries.length = 0;
        else entries.splice(index, 1);
        // The flags follow their Advisor: the one that moves up keeps its own capability, and emptying
        // the list empties the flags.
        this.draftAdvisorRead = entries.length
          ? trimAdvisorRead(this.draftAdvisorRead.filter((_, slot) => slot !== index))
          : [];
      } else if (choice.kind === "global") entries[index] = structuredClone(reference);
      else
        entries[index] = {
          ...reference,
          // The Anthropic profile only applies to Anthropic models; it follows a model change there.
          ...(previous?.providerExtension && reference.provider === "anthropic"
            ? { providerExtension: previous.providerExtension }
            : {}),
        };
      if (choice.kind === "global" && index === 0) {
        delete this.draft.advisors;
        delete this.draft.advisor;
        if (this.draft.thinking) delete this.draft.thinking.advisor;
      } else this.replaceAdvisors(entries);
      if (!entries.length && choice.kind === "disabled") this.draft.advisorMode = "off";
      if (choice.kind === "model" && choice.reference.provider === RESERVED_PROVIDER) {
        // A provider-dependent profile keeps its own identity and stays tool-free.
        this.draftAdvisorRead = normalizeAdvisorRead(
          this.draftAdvisorRead.map((flag, slot) => (slot === index ? false : flag)),
          Math.max(index + 1, resolveDelegateState(this.global, this.draft).advisors.length),
        );
        this.mode = {
          kind: "provider",
          index,
          selected: entries[index]?.providerExtension ? 1 : 0,
        };
      } else if (choice.kind === "model" && this.offersExtension(choice.reference.provider)) {
        const provider = choice.reference.provider;
        const current = admissionFor(this.draftAdmissions, provider);
        const selected = current
          ? this.extensionChoices(provider).findIndex(
              (pkg) => pkg?.package === current.package && pkg.version === current.version,
            )
          : 0;
        this.draftAdvisorRead = normalizeAdvisorRead(
          this.draftAdvisorRead.map((flag, slot) => (slot === index ? false : flag)),
          Math.max(index + 1, resolveDelegateState(this.global, this.draft).advisors.length),
        );
        this.mode = { kind: "extension", index, provider, selected: Math.max(0, selected) };
      } else if (choice.kind === "model" && this.advisorReadOffered(choice.reference.provider))
        this.mode = {
          kind: "advisor-read",
          index,
          selected: this.draftAdvisorRead[index] ? 1 : 0,
        };
      else this.mode = { kind: "settings" };
      return;
    }
    if (isEntryField(field)) {
      const key = entryKeyOf(field);
      const family = entryFamilyOf(key);
      if (!this.onSaveRoleEntries) {
        this.message = { kind: "error", text: noWriterText("delegation-policy.roles.json") };
        this.mode = { kind: "settings" };
        return;
      }
      // A branch value applies to this session only and cannot be written to the global sidecar, so
      // an entry edit refuses instead of persisting it as "the global default".
      const firstKey = optionalRoleEntryKeys(family)[0]!;
      if (Object.hasOwn(this.draft, firstKey)) {
        this.message = {
          kind: "error",
          text: `Clear the session override of ${ROLE_LABELS[firstKey]} (session.${firstKey}) before configuring the global entries.`,
        };
        this.mode = { kind: "settings" };
        return;
      }
      const index = optionalRoleEntryKeys(family).indexOf(key);
      // Seed from what this editor has staged, so two edits in one session build on each other, and
      // mirror the document's Visual Design entry 1 in because the sidecar may not hold it yet. The
      // branch case is refused above, so nothing from this session can reach the shared file.
      const entries = copyRoleEntries(this.draftRoleEntries)[family];
      const documentEntry = family === "uiDesign" ? this.global.uiDesign : undefined;
      if (documentEntry) {
        const first = entries[0];
        if (
          !first ||
          first.provider !== documentEntry.provider ||
          first.model !== documentEntry.model
        )
          entries[0] = { ...documentEntry };
      }
      if (choice.kind === "model") {
        if (index > entries.length) {
          this.message = {
            kind: "error",
            text: `Configure ${ROLE_LABELS[key]} first; entries keep their order.`,
          };
          this.mode = { kind: "settings" };
          return;
        }
        // Thinking lives in the same file and this row does not edit it, so a model change keeps it.
        const previous = entries[index];
        const entry = {
          provider: choice.reference.provider,
          model: choice.reference.model,
          ...(previous?.thinking ? { thinking: previous.thinking } : {}),
        };
        if (entries[index]) entries[index] = entry;
        else entries.push(entry);
        // A family never holds one `provider/model` twice, so a repeated model is refused here with
        // the value that was chosen instead of being staged for a writer that would reject the list.
        const value = `${entry.provider}/${entry.model}`;
        const occurrences = entries.filter(
          (candidate) => `${candidate.provider}/${candidate.model}` === value,
        ).length;
        if (occurrences > 1) {
          this.message = {
            kind: "error",
            text: `${ROLE_LABELS[key]} refused: ${value} is already configured in this family, and one family cannot hold the same model twice; the previous entries were left in place.`,
          };
          this.mode = { kind: "settings" };
          return;
        }
      } else if (index < entries.length) entries.splice(index, 1);
      this.draftRoleEntries[family] = entries;
      // Say it as soon as the model is chosen, not only after a save: the panel is the moment the
      // user can still pick a model that reads images.
      const blind = family === "vision" ? this.blindVisionEntries(entries) : undefined;
      if (blind)
        this.message = {
          kind: "info",
          text: `${blind} It will not be advertised or launchable until it points at a model that reads images.`,
        };
      this.mode = { kind: "settings" };
      return;
    }
    if (choice.kind === "global") delete this.draft[field];
    else if (choice.kind === "disabled") {
      this.draft[field] = null;
    } else if (choice.kind === "model") this.draft[field] = { ...choice.reference };
    this.mode = { kind: "settings" };
  }

  private replaceAdvisors(entries: NonNullable<GlobalDefaults["advisors"]>): void {
    delete this.draft.advisor;
    if (this.draft.thinking) delete this.draft.thinking.advisor;
    this.draft.advisors = entries.length ? entries : null;
  }

  private modelChoices(field: ModelField, query: string): ModelChoice[] {
    // An entry has no session state and no inherited default: it is either a model or nothing, so the
    // only pinned choice is the removal that closes the family's gap.
    const entry = isEntryField(field) ? this.entryList(entryKeyOf(field)) : undefined;
    const global = isEntryField(field) ? entry : this.modelSetting(this.global, field);
    const globalDescription =
      field === "uiDesign" || isAdvisorField(field) || isEntryField(field)
        ? global
          ? modelText(global)
          : "disabled"
        : rawModelText(global, "not configured");
    const pinned: ModelChoice[] = isEntryField(field)
      ? [{ kind: "disabled", key: "disabled", label: REMOVE_ENTRY, description: globalDescription }]
      : [
          {
            kind: "global",
            key: "global",
            label: USE_GLOBAL_DEFAULT,
            description: globalDescription,
          },
          { kind: "disabled", key: "disabled", label: DISABLE_FOR_SESSION },
        ];
    const filtered = query
      ? fuzzyFilter(this.candidates, query, (model) =>
          `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id} ${model.name ?? ""}`.trim(),
        )
      : this.candidates;
    return [
      ...pinned,
      ...filtered.map<ModelChoice>((model) => ({
        kind: "model",
        key: modelKey({ provider: model.provider, model: model.id }),
        label: model.id,
        ...(model.name && model.name !== model.id ? { description: model.name } : {}),
        reference: { provider: model.provider, model: model.id },
      })),
    ];
  }

  private handleDiscardInput(data: string): void {
    if (this.mode.kind !== "discard-confirm") return;
    if (matchesKey(data, "up") || matchesKey(data, "down"))
      this.mode.selected = this.mode.selected === 0 ? 1 : 0;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      if (this.mode.selected === 0) this.mode = { kind: "settings" };
      else this.onDone("cancelled");
    }
  }

  private requestClose(): void {
    if (this.isDirty()) this.mode = { kind: "discard-confirm", selected: 0 };
    else this.onDone("cancelled");
  }

  private async applyDraft(): Promise<void> {
    if (!this.isDirty()) {
      this.message = { kind: "info", text: "No changes to apply." };
      this.tui.requestRender();
      return;
    }
    this.working = "Applying changes…";
    this.tui.requestRender();
    try {
      // Without a global change the session step starts in this same input, as before.
      if (this.globalsDirty() && !(await this.saveGlobalSteps())) return;
      if (await this.onApply(cloneSession(this.draft))) {
        this.onDone("applied");
        return;
      }
      this.message = {
        kind: "error",
        text: `Could not apply session settings. Try again.${savedClause(this.savedGlobalsList())}`,
      };
    } catch {
      this.message = {
        kind: "error",
        text: `Could not apply session settings. Try again.${savedClause(this.savedGlobalsList())}`,
      };
    } finally {
      this.working = undefined;
      this.tui.requestRender();
    }
  }

  private async saveDefaults(): Promise<void> {
    this.working = "Saving defaults…";
    this.tui.requestRender();
    try {
      if (this.globalsDirty() && !(await this.saveGlobalSteps())) return;
      const kept = savedClause(this.savedGlobalsList());
      const outcome = await this.onSaveDefaults(cloneSession(this.draft));
      if (outcome.kind === "saved") {
        this.global = structuredClone(outcome.defaults);
        this.diagnostics.length = 0;
        this.message = {
          kind: "info",
          text: `Saved effective delegation settings as global defaults.${kept}`,
        };
      } else if (outcome.kind === "partial") {
        if (outcome.defaults) this.global = structuredClone(outcome.defaults);
        if (outcome.diagnostics)
          this.diagnostics.splice(0, this.diagnostics.length, ...outcome.diagnostics);
        this.message = {
          kind: "error",
          text: `Partially saved: the delegation file and the Advisor companion may disagree.${kept}`,
        };
      } else {
        // The defaults step did not commit. A global step that did is named instead of denied.
        this.message = {
          kind: "error",
          text: kept
            ? `Could not save global defaults.${kept}`
            : "Could not save global defaults. Nothing was changed on disk.",
        };
      }
    } catch {
      this.message = {
        kind: "error",
        text: `Could not save global defaults. Check /delegate status before retrying.${savedClause(this.savedGlobalsList())}`,
      };
    } finally {
      this.working = undefined;
      this.tui.requestRender();
    }
  }

  /**
   * Admissions are global, so Apply and Save both store a changed set before their own step. A
   * failure stops that step and leaves the session and defaults untouched.
   */
  private async saveAdmissions(): Promise<boolean> {
    let saved: boolean;
    try {
      saved = (await this.onSaveAdmissions?.(structuredClone(this.draftAdmissions))) ?? false;
    } catch {
      saved = false;
    }
    if (saved) {
      this.admissions = structuredClone(this.draftAdmissions);
      this.savedGlobals.set("admissions", "the provider extension admission");
    } else
      this.message = {
        kind: "error",
        text: "Could not save provider extensions. Nothing else was changed.",
      };
    return saved;
  }

  /**
   * The correction mode is global, so Apply and Save both write a changed value before their own
   * step. A failure stops that step: an unreadable file is reported instead of overwritten, and no
   * later write can report success for it.
   */
  private async saveLaunchCorrection(): Promise<LaunchCorrectionSaveResult> {
    let result: LaunchCorrectionSaveResult;
    try {
      result = (await this.onSaveLaunchCorrection?.(this.draftLaunchCorrection)) ?? "failed";
    } catch {
      result = "failed";
    }
    if (result === "saved" || result === "unchanged") {
      this.launchCorrection = this.draftLaunchCorrection;
      this.savedGlobals.set(
        "launchCorrection",
        `the launch correction mode (${this.draftLaunchCorrection})`,
      );
    }
    return result;
  }

  /**
   * The reminder mode is global, so Apply and Save both write a changed value before their own
   * step. A failure stops that step: an unreadable file is reported instead of overwritten.
   */
  private async saveAdvisorReminder(): Promise<AdvisorReminderSaveResult> {
    let result: AdvisorReminderSaveResult;
    try {
      result = (await this.onSaveAdvisorReminder?.(this.draftAdvisorReminder)) ?? "failed";
    } catch {
      result = "failed";
    }
    if (result === "saved" || result === "unchanged") {
      this.advisorReminder = this.draftAdvisorReminder;
      this.savedGlobals.set(
        "advisorReminder",
        `the Advisor reminder mode (${this.draftAdvisorReminder})`,
      );
    }
    return result;
  }

  /**
   * Store the global steps this attempt needs, in order, and stop at the first failure. A step that
   * already committed stays on disk and is named by the failure message; nothing is rolled back.
   */
  private async saveGlobalSteps(): Promise<boolean> {
    if (this.admissionsDirty() && !(await this.saveAdmissions())) return false;
    if (this.advisorReadDirty()) {
      const result = await this.saveAdvisorRead();
      if (result !== "saved" && result !== "unchanged") {
        this.message = {
          kind: "error",
          text: `${advisorReadFailureText(result)}${
            savedClause(this.savedGlobalsList()) || " Nothing else was changed."
          }`,
        };
        return false;
      }
    }
    if (this.roleEntriesDirty()) {
      const result = await this.saveRoleEntries();
      if (result !== "saved" && result !== "unchanged") {
        this.message = {
          kind: "error",
          text: `${roleEntriesFailureText(result)}${
            savedClause(this.savedGlobalsList()) || " Nothing else was changed."
          }`,
        };
        return false;
      }
    }
    if (this.advisorReminderDirty()) {
      const result = await this.saveAdvisorReminder();
      if (result !== "saved" && result !== "unchanged") {
        this.message = {
          kind: "error",
          text: `${reminderFailureText(result)}${
            savedClause(this.savedGlobalsList()) || " Nothing else was changed."
          }`,
        };
        return false;
      }
    }
    if (!this.launchCorrectionDirty()) return true;
    const result = await this.saveLaunchCorrection();
    if (result === "saved" || result === "unchanged") return true;
    this.message = {
      kind: "error",
      text: `${correctionFailureText(result)}${
        savedClause(this.savedGlobalsList()) || " Nothing else was changed."
      }`,
    };
    return false;
  }

  private savedGlobalsList(): string[] {
    return [...this.savedGlobals.values()];
  }

  private syncInputFocus(): void {
    this.searchInput.focused = this._focused && this.mode.kind === "model";
    this.advancedInput.focused = this._focused && this.mode.kind === "advanced-input";
  }
}

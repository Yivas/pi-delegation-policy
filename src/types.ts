import type { Api, Model } from "@earendil-works/pi-ai";

export const CURRENT_SCHEMA_VERSION = 10 as const;
export const ADVISOR_LAUNCH_MODES = ["role", "tool"] as const;
/** Advisors consulted together; the reader can run alongside them, so at most four children. */
export const MAX_ADVISORS = 3;
export type AdvisorLaunch = (typeof ADVISOR_LAUNCH_MODES)[number];

export const INTENSITIES = ["off", "normal", "aggressive", "orchestrator"] as const;
export const ADVISOR_MODES = ["off", "on", "with-delegation"] as const;
export type AdvisorMode = (typeof ADVISOR_MODES)[number];
export type Intensity = (typeof INTENSITIES)[number];
export const PREFERENCES = ["efficient", "standard", "intensive"] as const;
export type Preference = (typeof PREFERENCES)[number];
export const MODEL_ROLES = ["small", "medium", "large"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
/**
 * Optional roles keep up to three entries each. Every entry is its own key, so the launch guard, the
 * thinking policy and the status line keep addressing one concrete model instead of a list index that
 * a removal in the panel would silently shift.
 */
export const OPTIONAL_ROLE_FAMILIES = ["uiDesign", "vision", "writing"] as const;
export type OptionalRoleFamily = (typeof OPTIONAL_ROLE_FAMILIES)[number];
export const OPTIONAL_ROLE_ENTRY_LIMIT = 3 as const;
export const OPTIONAL_ROLE_ENTRY_KEYS = [
  "uiDesign",
  "uiDesign2",
  "uiDesign3",
  "vision",
  "vision2",
  "vision3",
  "writing",
  "writing2",
  "writing3",
] as const;
export type OptionalRoleEntryKey = (typeof OPTIONAL_ROLE_ENTRY_KEYS)[number];
/** The entry keys of one family, in preference order. */
export function optionalRoleEntryKeys(family: OptionalRoleFamily): OptionalRoleEntryKey[] {
  return OPTIONAL_ROLE_ENTRY_KEYS.filter((key) => key.startsWith(family));
}
export type ModelConfigKey = ModelRole | OptionalRoleEntryKey | "advisor";
export const ROLE_LABELS: Record<ModelConfigKey, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  uiDesign: "Visual Design",
  uiDesign2: "Visual Design 2",
  uiDesign3: "Visual Design 3",
  vision: "Vision",
  vision2: "Vision 2",
  vision3: "Vision 3",
  writing: "Writing",
  writing2: "Writing 2",
  writing3: "Writing 3",
  advisor: "Advisor",
};

export type ModelRef = { provider: string; model: string };
export type OrdinaryRoleSetting = ModelRef | null;
/**
 * Keys a saved document may carry a thinking policy for. Deliberately narrower than
 * `ModelConfigKey`: the policy document rejects unknown keys, so a new key there would break every
 * older reader. Entry thinking lives in its own file.
 */
export const THINKING_ROLE_KEYS: readonly ModelConfigKey[] = [
  ...MODEL_ROLES,
  "uiDesign",
  "advisor",
];
/** One configured entry of an optional role: an exact model plus its optional thinking policy. */
export type RoleEntry = ModelRef & { thinking?: ThinkingPolicy };
export type RoleEntries = Record<OptionalRoleFamily, RoleEntry[]>;
/**
 * An entry the merge dropped because the same provider/model already occupies an earlier slot of its
 * family. The sidecar rejects that list, so it can only appear when the document and the sidecar each
 * contribute one of the two entries.
 */
export type RepeatedRoleEntry = {
  key: OptionalRoleEntryKey;
  /** The 1-based position the dropped entry held in the merged family. */
  index: number;
  provider: string;
  model: string;
};
/** Level names the host recognizes. Single canonical copy for the whole product. */
export const THINKING_LEVEL_NAMES = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevelName = (typeof THINKING_LEVEL_NAMES)[number];
export type ThinkingPolicy =
  { level: ThinkingLevelName } | { min: ThinkingLevelName; max: ThinkingLevelName };
/**
 * Advisor thinking is not configurable: role mode chooses it per launch and tool mode picks it
 * automatically. Saved policies from earlier versions are validated and then ignored on load.
 */
export type AdvisorSetting = ModelRef & {
  providerExtension?: "anthropic-auth";
};
export type ThinkingSettings = Partial<Record<ModelConfigKey, ThinkingPolicy>>;
export type SessionThinkingSettings = Partial<Record<ModelConfigKey, ThinkingPolicy | null>>;
export const CONTEXT_SHUNT_MODES = ["off", "observe", "enforce"] as const;
export type ContextShuntMode = (typeof CONTEXT_SHUNT_MODES)[number];
export type ContextShuntLimits = {
  fullReadLines?: number;
  fullReadBytes?: number;
  targetedReadLines?: number;
  targetedReadBytes?: number;
};
export type ContextShuntSettings = {
  mode?: ContextShuntMode;
  readerEnabled?: boolean;
  readerRole?: ModelRole;
  answerMaxBytes?: number;
  limits?: ContextShuntLimits;
  shell?: "conservative";
  metrics?: "memory";
  exceptionPatterns?: string[];
  delegationHintPatterns?: string[];
};
export type GlobalDefaults = {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  intensity?: Intensity;
  preference?: Preference;
  small?: OrdinaryRoleSetting;
  medium?: OrdinaryRoleSetting;
  large?: OrdinaryRoleSetting;
  uiDesign?: ModelRef;
  /** Legacy first-advisor fields accepted at the in-memory compatibility boundary. */
  advisor?: ModelRef;
  advisors?: AdvisorSetting[];
  advisorLaunch?: AdvisorLaunch;
  advisorMode?: AdvisorMode;
  thinking?: ThinkingSettings;
  contextShunt?: ContextShuntSettings;
};
export type SessionDelegateState = {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  intensity?: Intensity;
  preference?: Preference;
  small?: OrdinaryRoleSetting;
  medium?: OrdinaryRoleSetting;
  large?: OrdinaryRoleSetting;
  uiDesign?: ModelRef | null;
  advisor?: ModelRef | null;
  advisors?: AdvisorSetting[] | null;
  advisorLaunch?: AdvisorLaunch;
  advisorMode?: AdvisorMode;
  thinking?: SessionThinkingSettings;
  contextShunt?: ContextShuntSettings;
};
export type ValueSource = "default" | "global" | "session";
export type EffectiveContextShunt = {
  mode: ContextShuntMode;
  configuredMode: ContextShuntMode;
  readerEnabled: boolean;
  readerRole: ModelRole;
  answerMaxBytes: number;
  limits: Required<ContextShuntLimits>;
  shell: "conservative";
  metrics: "memory";
  exceptionPatterns: string[];
  delegationHintPatterns: string[];
  suspended: boolean;
  source: Record<keyof Required<ContextShuntSettings>, ValueSource>;
};
export type EffectiveDelegateState = {
  intensity: Intensity;
  preference: Preference;
  small?: OrdinaryRoleSetting;
  medium?: OrdinaryRoleSetting;
  large?: OrdinaryRoleSetting;
  uiDesign?: ModelRef;
  uiDesign2?: ModelRef;
  uiDesign3?: ModelRef;
  vision?: ModelRef;
  vision2?: ModelRef;
  vision3?: ModelRef;
  writing?: ModelRef;
  writing2?: ModelRef;
  writing3?: ModelRef;
  /** The configured entries per optional role, in preference order. */
  roleEntries: RoleEntries;
  /** Entries the document/sidecar merge dropped; reported as warnings, never as a failure. */
  repeatedRoleEntries: RepeatedRoleEntry[];
  advisor?: ModelRef;
  advisors: AdvisorSetting[];
  advisorLaunch: AdvisorLaunch;
  advisorMode: AdvisorMode;
  thinking: ThinkingSettings;
  contextShunt: EffectiveContextShunt;
  source: {
    intensity: ValueSource;
    preference: ValueSource;
    small: ValueSource;
    medium: ValueSource;
    large: ValueSource;
    uiDesign: ValueSource;
    roleEntries: Record<OptionalRoleEntryKey, ValueSource>;
    advisor: ValueSource;
    advisorMode: ValueSource;
    advisors: ValueSource;
    advisorLaunch: ValueSource;
    thinking: Record<ModelConfigKey, ValueSource>;
  };
};
export type ModelStatus =
  | { kind: "available"; model: Model<Api> }
  | { kind: "missing-model" }
  | { kind: "outside-scope" }
  | { kind: "unavailable" }
  | { kind: "no-credentials" };

export function emptyGlobalDefaults(): GlobalDefaults {
  return { schemaVersion: CURRENT_SCHEMA_VERSION };
}
export function emptyRoleEntries(): RoleEntries {
  return { uiDesign: [], vision: [], writing: [] };
}
export function emptySessionState(): SessionDelegateState {
  return { schemaVersion: CURRENT_SCHEMA_VERSION };
}

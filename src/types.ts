import type { Api, Model } from "@earendil-works/pi-ai";

export const CURRENT_SCHEMA_VERSION = 4 as const;

export const INTENSITIES = ["off", "normal", "aggressive", "orchestrator"] as const;
export type Intensity = (typeof INTENSITIES)[number];
export const PREFERENCES = ["efficient", "standard", "intensive"] as const;
export type Preference = (typeof PREFERENCES)[number];
export const MODEL_ROLES = ["small", "medium", "large"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export type ModelConfigKey = ModelRole | "uiDesign";
export const ROLE_LABELS: Record<ModelConfigKey, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  uiDesign: "Visual Design",
};

export type ModelRef = { provider: string; model: string };
export type OrdinaryRoleSetting = ModelRef | null;
export const CONTEXT_SHUNT_MODES = ["off", "observe", "enforce"] as const;
export type ContextShuntMode = (typeof CONTEXT_SHUNT_MODES)[number];
export type ContextShuntLimits = {
  fullReadLines?: number;
  fullReadBytes?: number;
  targetedReadLines?: number;
  targetedReadBytes?: number;
  readerOutputBytes?: number;
};
export type ContextShuntSettings = {
  mode?: ContextShuntMode;
  readerRole?: ModelRole;
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
  contextShunt?: ContextShuntSettings;
};
export type ValueSource = "default" | "global" | "session";
export type EffectiveContextShunt = {
  mode: ContextShuntMode;
  configuredMode: ContextShuntMode;
  readerRole: ModelRole;
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
  contextShunt: EffectiveContextShunt;
  source: {
    intensity: ValueSource;
    preference: ValueSource;
    small: ValueSource;
    medium: ValueSource;
    large: ValueSource;
    uiDesign: ValueSource;
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
export function emptySessionState(): SessionDelegateState {
  return { schemaVersion: CURRENT_SCHEMA_VERSION };
}

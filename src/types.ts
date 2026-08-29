import type { Api, Model } from "@earendil-works/pi-ai";

export const CURRENT_SCHEMA_VERSION = 3 as const;

export const INTENSITIES = ["off", "normal", "aggressive"] as const;
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

export type ModelRef = {
  provider: string;
  model: string;
};

// Absent session properties inherit. Null explicitly disables an ordinary role.
export type OrdinaryRoleSetting = ModelRef | null;

export type GlobalDefaults = {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  intensity?: Intensity;
  preference?: Preference;
  small?: OrdinaryRoleSetting;
  medium?: OrdinaryRoleSetting;
  large?: OrdinaryRoleSetting;
  uiDesign?: ModelRef;
};

export type SessionDelegateState = {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  intensity?: Intensity;
  preference?: Preference;
  small?: OrdinaryRoleSetting;
  medium?: OrdinaryRoleSetting;
  large?: OrdinaryRoleSetting;
  // Null explicitly disables a global Visual Design role for this session branch.
  uiDesign?: ModelRef | null;
};

export type ValueSource = "default" | "global" | "session";

export type EffectiveDelegateState = {
  intensity: Intensity;
  preference: Preference;
  small?: OrdinaryRoleSetting;
  medium?: OrdinaryRoleSetting;
  large?: OrdinaryRoleSetting;
  uiDesign?: ModelRef;
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

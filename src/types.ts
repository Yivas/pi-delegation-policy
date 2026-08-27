import type { Api, Model } from "@earendil-works/pi-ai";

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

export type GlobalDefaults = {
  schemaVersion: 2;
  intensity?: Intensity;
  preference?: Preference;
  small?: ModelRef;
  medium?: ModelRef;
  large?: ModelRef;
  uiDesign?: ModelRef;
};

export type SessionDelegateState = {
  schemaVersion: 2;
  intensity?: Intensity;
  preference?: Preference;
  small?: ModelRef;
  medium?: ModelRef;
  large?: ModelRef;
  // Null explicitly disables a global Visual Design role for this session branch.
  uiDesign?: ModelRef | null;
};

export type ValueSource = "default" | "global" | "session";

export type EffectiveDelegateState = {
  intensity: Intensity;
  preference: Preference;
  small?: ModelRef;
  medium?: ModelRef;
  large?: ModelRef;
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
  return { schemaVersion: 2 };
}

export function emptySessionState(): SessionDelegateState {
  return { schemaVersion: 2 };
}

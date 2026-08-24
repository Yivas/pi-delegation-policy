import type { Api, Model } from "@earendil-works/pi-ai";

export const MODES = ["off", "normal", "aggressive"] as const;
export type DelegationMode = (typeof MODES)[number];

export const STRATEGIES = ["tiered", "task-based"] as const;
export type DelegationStrategy = (typeof STRATEGIES)[number];

export const TIERED_CATEGORIES = ["general", "strong", "ui-design"] as const;
export type TieredCategory = (typeof TIERED_CATEGORIES)[number];

export const TASK_CATEGORIES = [
  "planning",
  "research",
  "implementation",
  "debugging",
  "review",
  "ui-design",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export type DelegationCategory = TieredCategory | TaskCategory;

export type ModelAssignment = {
  provider: string;
  model: string;
  thinking: string;
  label?: string;
};

export type Preset = {
  defaultMode: DelegationMode;
  defaultStrategy: DelegationStrategy;
  skill?: string;
  enforcement: boolean;
  executorTools: string[];
  tiered: Partial<Record<TieredCategory, ModelAssignment>>;
  taskBased: Partial<Record<TaskCategory, ModelAssignment>>;
};

export type ConfigDocument = {
  schemaVersion: 1;
  activePreset?: string;
  mode?: DelegationMode;
  strategy?: DelegationStrategy;
  presets: Record<string, Preset>;
};

export type SessionState = {
  schemaVersion: 1;
  reset?: boolean;
  activePreset?: string;
  mode?: DelegationMode;
  strategy?: DelegationStrategy;
  presets?: Record<string, Preset>;
  loadedSkills?: string[];
};

export type ScopeName = "global" | "project" | "session";

export type ModelStatus =
  | { kind: "available"; model: Model<Api> }
  | { kind: "no-credentials"; model: Model<Api> }
  | { kind: "missing-model" }
  | { kind: "unsupported-thinking"; model: Model<Api> };

export type EffectiveConfig = {
  activePreset?: string;
  mode: DelegationMode;
  strategy: DelegationStrategy;
  preset?: Preset;
  source: {
    activePreset: ScopeName | "default";
    mode: ScopeName | "preset" | "default";
    strategy: ScopeName | "preset" | "default";
    preset: ScopeName | "default";
  };
};

export function emptyConfig(): ConfigDocument {
  return { schemaVersion: 1, presets: {} };
}

export function emptySessionState(): SessionState {
  return { schemaVersion: 1 };
}

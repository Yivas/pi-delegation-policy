import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  emptyConfig,
  emptySessionState,
  type ConfigDocument,
  type DelegationMode,
  type DelegationStrategy,
  type EffectiveConfig,
  type Preset,
  type ScopeName,
  type SessionState,
} from "./types.ts";
import { TASK_CATEGORIES, TIERED_CATEGORIES } from "./types.ts";

const TIERED_CATEGORY_NAMES = new Set<string>(TIERED_CATEGORIES);
const TASK_CATEGORY_NAMES = new Set<string>(TASK_CATEGORIES);

export type { ConfigDocument, Preset, ScopeName, SessionState } from "./types.ts";

export const SESSION_ENTRY_TYPE = "pi-delegation-policy:session";
export const SKILL_LOADED_ENTRY_TYPE = "pi-delegation-policy:skill-loaded";
export const SKILL_RESET_ENTRY_TYPE = "pi-delegation-policy:skill-reset";
export const GLOBAL_CONFIG_NAME = "delegation-policy.json";
export const PROJECT_CONFIG_NAME = "delegation-policy.json";
export const PRESET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidPresetName(name: string): boolean {
  return PRESET_NAME_PATTERN.test(name);
}

export type ConfigDiagnostic = {
  scope: ScopeName;
  message: string;
};

export type LoadedConfig = {
  config: ConfigDocument;
  diagnostics: ConfigDiagnostic[];
};

export type ConfigPaths = {
  global: string;
  project: string;
};

export function getConfigPaths(
  cwd: string,
  agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): ConfigPaths {
  return {
    global: join(agentDirectory, GLOBAL_CONFIG_NAME),
    project: join(cwd, CONFIG_DIR_NAME, PROJECT_CONFIG_NAME),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isMode = (value: unknown): value is DelegationMode =>
  value === "off" || value === "normal" || value === "aggressive";
const isStrategy = (value: unknown): value is DelegationStrategy =>
  value === "tiered" || value === "task-based";

function validAssignment(
  value: unknown,
): value is Preset["tiered"][string & keyof Preset["tiered"]] {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => ["provider", "model", "thinking", "label"].includes(key)) &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    typeof value.thinking === "string" &&
    value.thinking.length > 0 &&
    (value.label === undefined || typeof value.label === "string")
  );
}

function parsePreset(value: unknown): Preset | undefined {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      [
        "defaultMode",
        "defaultStrategy",
        "skill",
        "enforcement",
        "executorTools",
        "tiered",
        "taskBased",
      ].includes(key),
    ) ||
    !isMode(value.defaultMode) ||
    !isStrategy(value.defaultStrategy) ||
    (value.skill !== undefined && (typeof value.skill !== "string" || value.skill.length === 0)) ||
    typeof value.enforcement !== "boolean" ||
    !Array.isArray(value.executorTools) ||
    value.executorTools.some((tool) => typeof tool !== "string" || tool.length === 0) ||
    !isRecord(value.tiered) ||
    !isRecord(value.taskBased)
  )
    return undefined;
  const tiered: Preset["tiered"] = {};
  const taskBased: Preset["taskBased"] = {};
  for (const [category, assignment] of Object.entries(value.tiered)) {
    if (!TIERED_CATEGORY_NAMES.has(category) || !validAssignment(assignment)) return undefined;
    tiered[category as keyof Preset["tiered"]] = assignment as never;
  }
  for (const [category, assignment] of Object.entries(value.taskBased)) {
    if (!TASK_CATEGORY_NAMES.has(category) || !validAssignment(assignment)) return undefined;
    taskBased[category as keyof Preset["taskBased"]] = assignment as never;
  }
  return {
    defaultMode: value.defaultMode,
    defaultStrategy: value.defaultStrategy,
    ...(value.skill ? { skill: value.skill } : {}),
    enforcement: value.enforcement,
    executorTools: [...value.executorTools],
    tiered,
    taskBased,
  };
}

export function parseConfig(value: unknown): ConfigDocument | undefined {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      ["schemaVersion", "activePreset", "mode", "strategy", "presets"].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    (value.activePreset !== undefined &&
      (typeof value.activePreset !== "string" || !isValidPresetName(value.activePreset))) ||
    (value.mode !== undefined && !isMode(value.mode)) ||
    (value.strategy !== undefined && !isStrategy(value.strategy)) ||
    !isRecord(value.presets)
  )
    return undefined;
  const presets: Record<string, Preset> = {};
  for (const [name, preset] of Object.entries(value.presets)) {
    if (!isValidPresetName(name)) return undefined;
    const parsed = parsePreset(preset);
    if (!parsed) return undefined;
    presets[name] = parsed;
  }
  return {
    schemaVersion: 1,
    ...(value.activePreset ? { activePreset: value.activePreset } : {}),
    ...(value.mode ? { mode: value.mode } : {}),
    ...(value.strategy ? { strategy: value.strategy } : {}),
    presets,
  };
}

export function parseSessionState(value: unknown): SessionState | undefined {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      [
        "schemaVersion",
        "reset",
        "activePreset",
        "mode",
        "strategy",
        "presets",
        "loadedSkills",
      ].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    (value.reset !== undefined && typeof value.reset !== "boolean") ||
    (value.activePreset !== undefined &&
      (typeof value.activePreset !== "string" || !isValidPresetName(value.activePreset))) ||
    (value.mode !== undefined && !isMode(value.mode)) ||
    (value.strategy !== undefined && !isStrategy(value.strategy)) ||
    (value.loadedSkills !== undefined &&
      (!Array.isArray(value.loadedSkills) ||
        value.loadedSkills.some((skill) => typeof skill !== "string")))
  )
    return undefined;
  const config =
    value.presets === undefined
      ? undefined
      : parseConfig({ schemaVersion: 1, presets: value.presets });
  if (value.presets !== undefined && !config) return undefined;
  return {
    schemaVersion: 1,
    ...(value.reset ? { reset: true } : {}),
    ...(value.activePreset ? { activePreset: value.activePreset } : {}),
    ...(value.mode ? { mode: value.mode } : {}),
    ...(value.strategy ? { strategy: value.strategy } : {}),
    ...(config ? { presets: config.presets } : {}),
    ...(value.loadedSkills ? { loadedSkills: [...value.loadedSkills] } : {}),
  };
}

export async function readConfig(path: string, scope: ScopeName): Promise<LoadedConfig> {
  try {
    const parsed = parseConfig(JSON.parse(await readFile(path, "utf8")));
    return parsed
      ? { config: parsed, diagnostics: [] }
      : {
          config: emptyConfig(),
          diagnostics: [{ scope, message: `Invalid configuration at ${path}` }],
        };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { config: emptyConfig(), diagnostics: [] };
    return {
      config: emptyConfig(),
      diagnostics: [
        {
          scope,
          message:
            error instanceof SyntaxError
              ? `Invalid JSON at ${path}`
              : `Could not read ${path}: ${code ?? "unknown error"}`,
        },
      ],
    };
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeConfig(path: string, config: ConfigDocument): Promise<void> {
  const parsed = parseConfig(config);
  if (!parsed) throw new Error("Refusing to write invalid delegation policy configuration.");
  await atomicWrite(path, parsed);
}

export function restoreSessionState(entries: unknown[]): SessionState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as Record<string, unknown> | undefined;
    if (entry?.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE) continue;
    const state = parseSessionState(entry.data);
    if (state) return state;
  }
  return emptySessionState();
}

export function restoreLoadedSkills(entries: unknown[]): Map<string, string> {
  const loaded = new Map<string, string>();
  for (const entryValue of entries) {
    const entry = entryValue as Record<string, unknown> | undefined;
    if (entry?.type !== "custom") continue;
    if (entry.customType === SKILL_RESET_ENTRY_TYPE) {
      loaded.clear();
    } else if (entry.customType === SKILL_LOADED_ENTRY_TYPE && isRecord(entry.data)) {
      const { name, filePath } = entry.data;
      if (typeof name === "string" && typeof filePath === "string") loaded.set(name, filePath);
    }
  }
  return loaded;
}

export function resolveConfig(
  global: ConfigDocument,
  project: ConfigDocument,
  session: SessionState,
): EffectiveConfig {
  const mergedPresets = { ...global.presets, ...project.presets, ...(session.presets ?? {}) };
  const activePreset = session.activePreset ?? project.activePreset ?? global.activePreset;
  const preset = activePreset ? mergedPresets[activePreset] : undefined;
  const mode = session.mode ?? project.mode ?? global.mode ?? preset?.defaultMode ?? "off";
  const strategy =
    session.strategy ?? project.strategy ?? global.strategy ?? preset?.defaultStrategy ?? "tiered";
  const source = {
    activePreset: session.activePreset
      ? "session"
      : project.activePreset
        ? "project"
        : global.activePreset
          ? "global"
          : "default",
    mode: session.mode
      ? "session"
      : project.mode
        ? "project"
        : global.mode
          ? "global"
          : preset
            ? "preset"
            : "default",
    strategy: session.strategy
      ? "session"
      : project.strategy
        ? "project"
        : global.strategy
          ? "global"
          : preset
            ? "preset"
            : "default",
    preset: session.presets?.[activePreset ?? ""]
      ? "session"
      : project.presets[activePreset ?? ""]
        ? "project"
        : global.presets[activePreset ?? ""]
          ? "global"
          : "default",
  } as const;
  return { activePreset, mode, strategy, preset, source };
}

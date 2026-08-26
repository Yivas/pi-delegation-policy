import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  emptyGlobalDefaults,
  emptySessionState,
  type EffectiveDelegateState,
  type GlobalDefaults,
  type Intensity,
  type ModelRef,
  type Preference,
  type SessionDelegateState,
  type ValueSource,
} from "./types.ts";

export type { GlobalDefaults, SessionDelegateState } from "./types.ts";

export const SESSION_ENTRY_TYPE = "pi-delegation-policy:session";
export const GLOBAL_CONFIG_NAME = "delegation-policy.json";

const LEGACY_SCHEMA_MESSAGE =
  "Global defaults use schema version 1. Configure schema version 2 with /delegate before activating delegation.";
const INVALID_CONFIG_MESSAGE = "Global defaults are invalid. Configure them again with /delegate.";

export type ConfigDiagnostic = {
  message: string;
};

export type LoadedDefaults = {
  defaults: GlobalDefaults;
  diagnostics: ConfigDiagnostic[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isIntensity(value: unknown): value is Intensity {
  return value === "off" || value === "normal" || value === "aggressive";
}

function isPreference(value: unknown): value is Preference {
  return value === "efficient" || value === "standard" || value === "intensive";
}

function parseModelRef(value: unknown): ModelRef | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["provider", "model"]) ||
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    typeof value.model !== "string" ||
    value.model.length === 0
  )
    return undefined;
  return { provider: value.provider, model: value.model };
}

function copyModelRef(value: ModelRef | undefined): ModelRef | undefined {
  return value ? { ...value } : undefined;
}

export function parseConfig(value: unknown): GlobalDefaults | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "intensity",
      "preference",
      "small",
      "medium",
      "large",
      "uiDesign",
    ]) ||
    value.schemaVersion !== 2 ||
    (value.intensity !== undefined && !isIntensity(value.intensity)) ||
    (value.preference !== undefined && !isPreference(value.preference))
  )
    return undefined;

  const small = value.small === undefined ? undefined : parseModelRef(value.small);
  const medium = value.medium === undefined ? undefined : parseModelRef(value.medium);
  const large = value.large === undefined ? undefined : parseModelRef(value.large);
  const uiDesign = value.uiDesign === undefined ? undefined : parseModelRef(value.uiDesign);

  if (
    (value.small !== undefined && !small) ||
    (value.medium !== undefined && !medium) ||
    (value.large !== undefined && !large) ||
    (value.uiDesign !== undefined && !uiDesign)
  )
    return undefined;

  return {
    schemaVersion: 2,
    ...(value.intensity ? { intensity: value.intensity } : {}),
    ...(value.preference ? { preference: value.preference } : {}),
    ...(small ? { small } : {}),
    ...(medium ? { medium } : {}),
    ...(large ? { large } : {}),
    ...(uiDesign ? { uiDesign } : {}),
  };
}

export function parseSessionState(value: unknown): SessionDelegateState | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "intensity",
      "preference",
      "small",
      "medium",
      "large",
      "uiDesign",
    ]) ||
    value.schemaVersion !== 2 ||
    (value.intensity !== undefined && !isIntensity(value.intensity)) ||
    (value.preference !== undefined && !isPreference(value.preference))
  )
    return undefined;

  const small = value.small === undefined ? undefined : parseModelRef(value.small);
  const medium = value.medium === undefined ? undefined : parseModelRef(value.medium);
  const large = value.large === undefined ? undefined : parseModelRef(value.large);
  const uiDesign =
    value.uiDesign === undefined || value.uiDesign === null
      ? value.uiDesign
      : parseModelRef(value.uiDesign);

  if (
    (value.small !== undefined && !small) ||
    (value.medium !== undefined && !medium) ||
    (value.large !== undefined && !large) ||
    (value.uiDesign !== undefined && value.uiDesign !== null && !uiDesign)
  )
    return undefined;

  return {
    schemaVersion: 2,
    ...(value.intensity ? { intensity: value.intensity } : {}),
    ...(value.preference ? { preference: value.preference } : {}),
    ...(small ? { small } : {}),
    ...(medium ? { medium } : {}),
    ...(large ? { large } : {}),
    ...(uiDesign === null ? { uiDesign: null } : uiDesign ? { uiDesign } : {}),
  };
}

function isLegacyConfig(value: unknown): boolean {
  return isRecord(value) && value.schemaVersion === 1;
}

export function getGlobalConfigPath(
  agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): string {
  return join(agentDirectory, GLOBAL_CONFIG_NAME);
}

export async function readConfig(path: string): Promise<LoadedDefaults> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const defaults = parseConfig(value);
    if (defaults) return { defaults, diagnostics: [] };
    return {
      defaults: emptyGlobalDefaults(),
      diagnostics: [
        { message: isLegacyConfig(value) ? LEGACY_SCHEMA_MESSAGE : INVALID_CONFIG_MESSAGE },
      ],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { defaults: emptyGlobalDefaults(), diagnostics: [] };
    }
    return {
      defaults: emptyGlobalDefaults(),
      diagnostics: [{ message: INVALID_CONFIG_MESSAGE }],
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

export async function writeConfig(path: string, defaults: GlobalDefaults): Promise<void> {
  const parsed = parseConfig(defaults);
  if (!parsed) throw new Error("Refusing to write invalid delegation policy defaults.");
  await atomicWrite(path, parsed);
}

export function restoreSessionState(entries: unknown[]): SessionDelegateState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as Record<string, unknown> | undefined;
    if (entry?.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE) continue;
    const state = parseSessionState(entry.data);
    if (state) return state;
  }
  return emptySessionState();
}

function sourceFor<T>(sessionValue: T | undefined, globalValue: T | undefined): ValueSource {
  if (sessionValue !== undefined) return "session";
  if (globalValue !== undefined) return "global";
  return "default";
}

export function resolveDelegateState(
  defaults: GlobalDefaults,
  session: SessionDelegateState,
): EffectiveDelegateState {
  const uiDesign =
    session.uiDesign === undefined
      ? copyModelRef(defaults.uiDesign)
      : session.uiDesign === null
        ? undefined
        : copyModelRef(session.uiDesign);

  return {
    intensity: session.intensity ?? defaults.intensity ?? "off",
    preference: session.preference ?? defaults.preference ?? "standard",
    small: copyModelRef(session.small ?? defaults.small),
    medium: copyModelRef(session.medium ?? defaults.medium),
    large: copyModelRef(session.large ?? defaults.large),
    ...(uiDesign ? { uiDesign } : {}),
    source: {
      intensity: sourceFor(session.intensity, defaults.intensity),
      preference: sourceFor(session.preference, defaults.preference),
      small: sourceFor(session.small, defaults.small),
      medium: sourceFor(session.medium, defaults.medium),
      large: sourceFor(session.large, defaults.large),
      uiDesign: sourceFor(session.uiDesign, defaults.uiDesign),
    },
  };
}

export function defaultsFromEffectiveState(state: EffectiveDelegateState): GlobalDefaults {
  return {
    schemaVersion: 2,
    intensity: state.intensity,
    preference: state.preference,
    ...(state.small ? { small: { ...state.small } } : {}),
    ...(state.medium ? { medium: { ...state.medium } } : {}),
    ...(state.large ? { large: { ...state.large } } : {}),
    ...(state.uiDesign ? { uiDesign: { ...state.uiDesign } } : {}),
  };
}

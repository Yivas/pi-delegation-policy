import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONTEXT_SHUNT_MODES,
  type ContextShuntLimits,
  type ContextShuntSettings,
  CURRENT_SCHEMA_VERSION,
  type EffectiveContextShunt,
  type EffectiveDelegateState,
  emptyGlobalDefaults,
  emptySessionState,
  type GlobalDefaults,
  INTENSITIES,
  type Intensity,
  MODEL_ROLES,
  type ModelRef,
  type ModelRole,
  type OrdinaryRoleSetting,
  type Preference,
  type SessionDelegateState,
  type ValueSource,
} from "./types.ts";

export type { GlobalDefaults, SessionDelegateState } from "./types.ts";
export const SESSION_ENTRY_TYPE = "pi-delegation-policy:session";
export const GLOBAL_CONFIG_NAME = "delegation-policy.json";
const LEGACY_SCHEMA_MESSAGE =
  "Global defaults use unsupported schema version 1. Configure them again with /delegate before activating delegation.";
const INVALID_CONFIG_MESSAGE = "Global defaults are invalid. Configure them again with /delegate.";
const INVALID_SESSION_MESSAGE =
  "The latest delegation session state is invalid or unsupported. Delegation is off for safety.";
const SCHEMA2_KEYS = [
  "schemaVersion",
  "intensity",
  "preference",
  "small",
  "medium",
  "large",
  "uiDesign",
] as const;
const SCHEMA3_KEYS = SCHEMA2_KEYS;
const SCHEMA4_KEYS = [...SCHEMA2_KEYS, "contextShunt"] as const;
const DEFAULT_LIMITS = {
  fullReadLines: 350,
  fullReadBytes: 16384,
  targetedReadLines: 250,
  targetedReadBytes: 16384,
  readerOutputBytes: 8192,
} as const;
const MAX_LIMIT = 1024 * 1024;

export type ConfigDiagnostic = { message: string; reportWhenOff?: boolean };
export type LoadedDefaults = {
  defaults: GlobalDefaults;
  diagnostics: ConfigDiagnostic[];
};
export type RestoredSessionState = {
  session: SessionDelegateState;
  diagnostics: ConfigDiagnostic[];
};
export type SessionEntryWriter = {
  appendEntry: (type: string, data?: unknown) => void;
};
export type GuardedAppendResult = "success" | "guard-failed" | "state-failed";
type LegacyIntensity = "off" | "normal" | "aggressive";
type Schema2Config = {
  schemaVersion: 2;
  intensity?: LegacyIntensity;
  preference?: Preference;
  small?: ModelRef;
  medium?: ModelRef;
  large?: ModelRef;
  uiDesign?: ModelRef;
};
type Schema2Session = Omit<Schema2Config, "uiDesign"> & {
  uiDesign?: ModelRef | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function isIntensity(value: unknown): value is Intensity {
  return INTENSITIES.includes(value as Intensity);
}
function isLegacyIntensity(value: unknown): value is LegacyIntensity {
  return ["off", "normal", "aggressive"].includes(value as LegacyIntensity);
}
function isPreference(value: unknown): value is Preference {
  return ["efficient", "standard", "intensive"].includes(value as Preference);
}
function isRole(value: unknown): value is ModelRole {
  return MODEL_ROLES.includes(value as ModelRole);
}
function model(value: unknown): ModelRef | undefined {
  if (
    !isRecord(value) ||
    !only(value, ["provider", "model"]) ||
    typeof value.provider !== "string" ||
    !value.provider ||
    typeof value.model !== "string" ||
    !value.model
  )
    return undefined;
  return { provider: value.provider, model: value.model };
}
function ordinary(value: unknown): OrdinaryRoleSetting | undefined {
  return value === null ? null : model(value);
}
function copyRole(value: OrdinaryRoleSetting | undefined): OrdinaryRoleSetting | undefined {
  return value === null ? null : value ? { ...value } : undefined;
}
function validLimit(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_LIMIT;
}
function patterns(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= 256 &&
        !item.includes("\0") &&
        !item.includes("..") &&
        !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(item),
    )
  )
    return undefined;
  return [...value];
}
function parseShunt(value: unknown): ContextShuntSettings | undefined {
  if (
    !isRecord(value) ||
    !only(value, [
      "mode",
      "readerRole",
      "limits",
      "shell",
      "metrics",
      "exceptionPatterns",
      "delegationHintPatterns",
    ])
  )
    return undefined;
  if (value.mode !== undefined && !CONTEXT_SHUNT_MODES.includes(value.mode as never))
    return undefined;
  if (value.readerRole !== undefined && !isRole(value.readerRole)) return undefined;
  if (value.shell !== undefined && value.shell !== "conservative") return undefined;
  if (value.metrics !== undefined && value.metrics !== "memory") return undefined;
  let limits: ContextShuntLimits | undefined;
  if (value.limits !== undefined) {
    if (!isRecord(value.limits) || !only(value.limits, Object.keys(DEFAULT_LIMITS)))
      return undefined;
    if (Object.values(value.limits).some((item) => !validLimit(item))) return undefined;
    limits = { ...value.limits } as ContextShuntLimits;
  }
  const exceptionPatterns =
    value.exceptionPatterns === undefined ? undefined : patterns(value.exceptionPatterns);
  const delegationHintPatterns =
    value.delegationHintPatterns === undefined ? undefined : patterns(value.delegationHintPatterns);
  if (
    (value.exceptionPatterns !== undefined && !exceptionPatterns) ||
    (value.delegationHintPatterns !== undefined && !delegationHintPatterns)
  )
    return undefined;
  return {
    ...(value.mode ? { mode: value.mode as ContextShuntSettings["mode"] } : {}),
    ...(value.readerRole ? { readerRole: value.readerRole as ModelRole } : {}),
    ...(limits ? { limits } : {}),
    ...(value.shell ? { shell: "conservative" as const } : {}),
    ...(value.metrics ? { metrics: "memory" as const } : {}),
    ...(exceptionPatterns ? { exceptionPatterns } : {}),
    ...(delegationHintPatterns ? { delegationHintPatterns } : {}),
  };
}
function envelope(
  value: unknown,
  schema: 2 | 3 | 4,
  keys: readonly string[],
  intensityValidator: (value: unknown) => boolean,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    only(value, keys) &&
    value.schemaVersion === schema &&
    (value.intensity === undefined || intensityValidator(value.intensity)) &&
    (value.preference === undefined || isPreference(value.preference))
  );
}
function parseLegacyRoles(
  value: Record<string, unknown>,
): Pick<Schema2Config, "small" | "medium" | "large" | "uiDesign"> | undefined {
  const small = value.small === undefined ? undefined : model(value.small);
  const medium = value.medium === undefined ? undefined : model(value.medium);
  const large = value.large === undefined ? undefined : model(value.large);
  const uiDesign = value.uiDesign === undefined ? undefined : model(value.uiDesign);
  if (
    (value.small !== undefined && !small) ||
    (value.medium !== undefined && !medium) ||
    (value.large !== undefined && !large) ||
    (value.uiDesign !== undefined && !uiDesign)
  )
    return undefined;
  return {
    ...(small ? { small } : {}),
    ...(medium ? { medium } : {}),
    ...(large ? { large } : {}),
    ...(uiDesign ? { uiDesign } : {}),
  };
}
export function parseSchema2Config(value: unknown): Schema2Config | undefined {
  if (!envelope(value, 2, SCHEMA2_KEYS, isLegacyIntensity)) return undefined;
  const roles = parseLegacyRoles(value);
  if (!roles) return undefined;
  return {
    schemaVersion: 2,
    ...(value.intensity ? { intensity: value.intensity as LegacyIntensity } : {}),
    ...(value.preference ? { preference: value.preference as Preference } : {}),
    ...roles,
  };
}
function parseModern(
  value: unknown,
  schema: 3 | 4,
  session: boolean,
): GlobalDefaults | SessionDelegateState | undefined {
  const keys = schema === 3 ? SCHEMA3_KEYS : SCHEMA4_KEYS;
  if (!envelope(value, schema, keys, isIntensity)) return undefined;
  const small = value.small === undefined ? undefined : ordinary(value.small);
  const medium = value.medium === undefined ? undefined : ordinary(value.medium);
  const large = value.large === undefined ? undefined : ordinary(value.large);
  const uiDesign =
    value.uiDesign === undefined || (session && value.uiDesign === null)
      ? value.uiDesign
      : model(value.uiDesign);
  if (
    (value.small !== undefined && small === undefined) ||
    (value.medium !== undefined && medium === undefined) ||
    (value.large !== undefined && large === undefined) ||
    (value.uiDesign !== undefined && uiDesign === undefined)
  )
    return undefined;
  const contextShunt =
    schema === 4 && value.contextShunt !== undefined ? parseShunt(value.contextShunt) : undefined;
  if (schema === 4 && value.contextShunt !== undefined && !contextShunt) return undefined;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...(value.intensity ? { intensity: value.intensity as Intensity } : {}),
    ...(value.preference ? { preference: value.preference as Preference } : {}),
    ...(small !== undefined ? { small } : {}),
    ...(medium !== undefined ? { medium } : {}),
    ...(large !== undefined ? { large } : {}),
    ...(uiDesign === null
      ? { uiDesign: null }
      : uiDesign
        ? { uiDesign: uiDesign as ModelRef }
        : {}),
    ...(contextShunt ? { contextShunt } : {}),
  } as GlobalDefaults | SessionDelegateState;
}
export function parseSchema3Config(value: unknown): GlobalDefaults | undefined {
  return parseModern(value, 3, false) as GlobalDefaults | undefined;
}
export function parseSchema4Config(value: unknown): GlobalDefaults | undefined {
  return parseModern(value, 4, false) as GlobalDefaults | undefined;
}
function migrate2(value: Schema2Config | Schema2Session): SessionDelegateState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...(value.intensity ? { intensity: value.intensity } : {}),
    ...(value.preference ? { preference: value.preference } : {}),
    ...(value.small ? { small: { ...value.small } } : {}),
    ...(value.medium ? { medium: { ...value.medium } } : {}),
    ...(value.large ? { large: { ...value.large } } : {}),
    ...(value.uiDesign === null
      ? { uiDesign: null }
      : value.uiDesign
        ? { uiDesign: { ...value.uiDesign } }
        : {}),
  };
}
export function parseConfig(value: unknown): GlobalDefaults | undefined {
  return (
    parseSchema4Config(value) ??
    parseSchema3Config(value) ??
    (() => {
      const parsed = parseSchema2Config(value);
      return parsed ? (migrate2(parsed) as GlobalDefaults) : undefined;
    })()
  );
}
function parseSchema2Session(value: unknown): Schema2Session | undefined {
  const parsed = parseSchema2Config(value);
  if (parsed) return parsed;
  if (!envelope(value, 2, SCHEMA2_KEYS, isLegacyIntensity)) return undefined;
  const base = parseLegacyRoles({ ...value, uiDesign: undefined });
  const uiDesign = value.uiDesign === null ? null : model(value.uiDesign);
  return base && (value.uiDesign === undefined || value.uiDesign === null || uiDesign)
    ? {
        schemaVersion: 2,
        ...(value.intensity ? { intensity: value.intensity as LegacyIntensity } : {}),
        ...(value.preference ? { preference: value.preference as Preference } : {}),
        ...base,
        ...(uiDesign === null ? { uiDesign } : uiDesign ? { uiDesign } : {}),
      }
    : undefined;
}
export function parseSessionState(value: unknown): SessionDelegateState | undefined {
  return (
    (parseModern(value, 4, true) as SessionDelegateState | undefined) ??
    (parseModern(value, 3, true) as SessionDelegateState | undefined) ??
    (() => {
      const parsed = parseSchema2Session(value);
      return parsed ? migrate2(parsed) : undefined;
    })()
  );
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
    return defaults
      ? { defaults, diagnostics: [] }
      : {
          defaults: emptyGlobalDefaults(),
          diagnostics: [
            {
              message: isLegacyConfig(value) ? LEGACY_SCHEMA_MESSAGE : INVALID_CONFIG_MESSAGE,
            },
          ],
        };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { defaults: emptyGlobalDefaults(), diagnostics: [] }
      : {
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
  const parsed = parseSchema4Config(defaults);
  if (!parsed) throw new Error("Refusing to write invalid delegation policy defaults.");
  await atomicWrite(path, parsed);
}
export function restoreSessionStateWithDiagnostics(entries: unknown[]): RestoredSessionState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as Record<string, unknown> | undefined;
    if (entry?.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE) continue;
    const session = parseSessionState(entry.data);
    return session
      ? { session, diagnostics: [] }
      : {
          session: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off" },
          diagnostics: [{ message: INVALID_SESSION_MESSAGE, reportWhenOff: true }],
        };
  }
  return { session: emptySessionState(), diagnostics: [] };
}
export function restoreSessionState(entries: unknown[]): SessionDelegateState {
  return restoreSessionStateWithDiagnostics(entries).session;
}
function source(session: Record<string, unknown>, globalValue: unknown, key: string): ValueSource {
  return Object.hasOwn(session, key) ? "session" : globalValue !== undefined ? "global" : "default";
}
function resolveShunt(
  defaults: GlobalDefaults,
  session: SessionDelegateState,
  intensity: Intensity,
): EffectiveContextShunt {
  const global = defaults.contextShunt ?? {};
  const local = session.contextShunt ?? {};
  const choose = <T>(key: keyof ContextShuntSettings, fallback: T): T =>
    Object.hasOwn(local, key)
      ? (local[key] as T)
      : Object.hasOwn(global, key)
        ? (global[key] as T)
        : fallback;
  const limits = {
    ...DEFAULT_LIMITS,
    ...(global.limits ?? {}),
    ...(local.limits ?? {}),
  };
  const configuredMode = choose("mode", "off" as const);
  const suspended = intensity === "off" && configuredMode !== "off";
  const keySource = (key: keyof Required<ContextShuntSettings>): ValueSource =>
    Object.hasOwn(local, key) || (key === "limits" && Object.keys(local.limits ?? {}).length > 0)
      ? "session"
      : Object.hasOwn(global, key) ||
          (key === "limits" && Object.keys(global.limits ?? {}).length > 0)
        ? "global"
        : "default";
  return {
    mode: suspended ? "off" : configuredMode,
    configuredMode,
    readerRole: choose("readerRole", "small" as const),
    limits,
    shell: choose("shell", "conservative" as const),
    metrics: choose("metrics", "memory" as const),
    exceptionPatterns: [...choose("exceptionPatterns", [] as string[])],
    delegationHintPatterns: [...choose("delegationHintPatterns", [] as string[])],
    suspended,
    source: {
      mode: keySource("mode"),
      readerRole: keySource("readerRole"),
      limits: keySource("limits"),
      shell: keySource("shell"),
      metrics: keySource("metrics"),
      exceptionPatterns: keySource("exceptionPatterns"),
      delegationHintPatterns: keySource("delegationHintPatterns"),
    },
  };
}
export function resolveDelegateState(
  defaults: GlobalDefaults,
  session: SessionDelegateState,
): EffectiveDelegateState {
  const intensity = session.intensity ?? defaults.intensity ?? "off";
  const uiDesign =
    session.uiDesign === undefined
      ? defaults.uiDesign
        ? { ...defaults.uiDesign }
        : undefined
      : session.uiDesign === null
        ? undefined
        : { ...session.uiDesign };
  const role = (name: ModelRole) =>
    copyRole(Object.hasOwn(session, name) ? session[name] : defaults[name]);
  const small = role("small");
  const medium = role("medium");
  const large = role("large");
  return {
    intensity,
    preference: session.preference ?? defaults.preference ?? "standard",
    ...(small !== undefined ? { small } : {}),
    ...(medium !== undefined ? { medium } : {}),
    ...(large !== undefined ? { large } : {}),
    ...(uiDesign ? { uiDesign } : {}),
    contextShunt: resolveShunt(defaults, session, intensity),
    source: {
      intensity: source(session, defaults.intensity, "intensity"),
      preference: source(session, defaults.preference, "preference"),
      small: source(session, defaults.small, "small"),
      medium: source(session, defaults.medium, "medium"),
      large: source(session, defaults.large, "large"),
      uiDesign: source(session, defaults.uiDesign, "uiDesign"),
    },
  };
}
export function defaultsFromEffectiveState(state: EffectiveDelegateState): GlobalDefaults {
  const role = (value: OrdinaryRoleSetting | undefined) =>
    value === undefined ? {} : { value: copyRole(value) };
  const context = state.contextShunt;
  const hasConfiguredContext =
    context.configuredMode !== "off" ||
    Object.values(context.source).some((source) => source !== "default");
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: state.intensity,
    preference: state.preference,
    ...("value" in role(state.small) ? { small: role(state.small).value } : {}),
    ...("value" in role(state.medium) ? { medium: role(state.medium).value } : {}),
    ...("value" in role(state.large) ? { large: role(state.large).value } : {}),
    ...(state.uiDesign ? { uiDesign: { ...state.uiDesign } } : {}),
    ...(hasConfiguredContext
      ? {
          contextShunt: {
            mode: context.configuredMode,
            readerRole: context.readerRole,
            limits: { ...context.limits },
            shell: context.shell,
            metrics: context.metrics,
            exceptionPatterns: [...context.exceptionPatterns],
            delegationHintPatterns: [...context.delegationHintPatterns],
          },
        }
      : {}),
  };
}
export function appendGuardedSessionState(
  pi: SessionEntryWriter,
  session: SessionDelegateState,
): GuardedAppendResult {
  try {
    pi.appendEntry(SESSION_ENTRY_TYPE, { schemaVersion: 2, intensity: "off" });
  } catch {
    return "guard-failed";
  }
  try {
    pi.appendEntry(SESSION_ENTRY_TYPE, session);
    return "success";
  } catch {
    return "state-failed";
  }
}

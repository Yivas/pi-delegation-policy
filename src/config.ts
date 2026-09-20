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
  type ModelConfigKey,
  type ModelRef,
  type ModelRole,
  type OptionalRoleKey,
  type OrdinaryRoleSetting,
  type Preference,
  type SessionDelegateState,
  type SessionThinkingSettings,
  THINKING_LEVEL_NAMES,
  THINKING_ROLE_KEYS,
  type ThinkingLevelName,
  type ThinkingPolicy,
  type ThinkingSettings,
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
const SCHEMA5_KEYS = SCHEMA4_KEYS;
const SCHEMA6_KEYS = [...SCHEMA5_KEYS, "thinking"] as const;
const SCHEMA7_KEYS = [...SCHEMA6_KEYS, "advisor"] as const;
const DEFAULT_LIMITS = {
  fullReadLines: 350,
  fullReadBytes: 16384,
  targetedReadLines: 250,
  targetedReadBytes: 16384,
} as const;
const LEGACY_LIMIT_KEYS = [...Object.keys(DEFAULT_LIMITS), "readerOutputBytes"] as const;
const MAX_LIMIT = 1024 * 1024;
const DEFAULT_ANSWER_MAX_BYTES = 8192;
const MIN_ANSWER_MAX_BYTES = 1024;
const MAX_ANSWER_MAX_BYTES = 16384;

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
/** A thinking level name the host recognizes. Anything else invalidates the document. */
export function isThinkingLevelName(value: unknown): value is ThinkingLevelName {
  return typeof value === "string" && (THINKING_LEVEL_NAMES as readonly string[]).includes(value);
}
function thinkingPolicy(value: unknown): ThinkingPolicy | undefined {
  if (!isRecord(value)) return undefined;
  if (only(value, ["level"])) {
    const level = value.level;
    return isThinkingLevelName(level) ? { level } : undefined;
  }
  if (only(value, ["min", "max"])) {
    const min = value.min;
    const max = value.max;
    if (!isThinkingLevelName(min) || !isThinkingLevelName(max)) return undefined;
    if (THINKING_LEVEL_NAMES.indexOf(min) > THINKING_LEVEL_NAMES.indexOf(max)) return undefined;
    return min === max ? { level: min } : { min, max };
  }
  return undefined;
}
function parseThinking(
  value: unknown,
  session: boolean,
  schema: 6 | 7,
): ThinkingSettings | SessionThinkingSettings | undefined {
  // `advisor` arrived with schema 7: a document that claims an older version must not carry it.
  const keys =
    schema === 7 ? THINKING_ROLE_KEYS : THINKING_ROLE_KEYS.filter((key) => key !== "advisor");
  if (!isRecord(value) || !only(value, keys)) return undefined;
  const thinking: SessionThinkingSettings = {};
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const raw = value[key];
    if (session && raw === null) {
      thinking[key] = null;
      continue;
    }
    const policy = thinkingPolicy(raw);
    if (!policy) return undefined;
    thinking[key] = policy;
  }
  return thinking;
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
function validAnswerMaxBytes(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= MIN_ANSWER_MAX_BYTES &&
    (value as number) <= MAX_ANSWER_MAX_BYTES
  );
}
function parseShunt(value: unknown, schema: 4 | 5 | 6 | 7): ContextShuntSettings | undefined {
  const keys = [
    "mode",
    "readerRole",
    "limits",
    "shell",
    "metrics",
    "exceptionPatterns",
    "delegationHintPatterns",
    ...(schema === 4 ? [] : ["readerEnabled", "answerMaxBytes"]),
  ];
  if (!isRecord(value) || !only(value, keys)) return undefined;
  if (value.mode !== undefined && !CONTEXT_SHUNT_MODES.includes(value.mode as never))
    return undefined;
  if (value.readerEnabled !== undefined && typeof value.readerEnabled !== "boolean")
    return undefined;
  if (value.readerRole !== undefined && !isRole(value.readerRole)) return undefined;
  if (value.answerMaxBytes !== undefined && !validAnswerMaxBytes(value.answerMaxBytes))
    return undefined;
  if (value.shell !== undefined && value.shell !== "conservative") return undefined;
  if (value.metrics !== undefined && value.metrics !== "memory") return undefined;
  let limits: ContextShuntLimits | undefined;
  if (value.limits !== undefined) {
    const limitKeys = schema === 4 ? LEGACY_LIMIT_KEYS : Object.keys(DEFAULT_LIMITS);
    if (!isRecord(value.limits) || !only(value.limits, limitKeys)) return undefined;
    if (Object.values(value.limits).some((item) => !validLimit(item))) return undefined;
    const effectiveLimits = { ...value.limits };
    delete effectiveLimits.readerOutputBytes;
    if (Object.keys(effectiveLimits).length) limits = effectiveLimits as ContextShuntLimits;
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
    ...(value.readerEnabled !== undefined ? { readerEnabled: value.readerEnabled as boolean } : {}),
    ...(value.readerRole ? { readerRole: value.readerRole as ModelRole } : {}),
    ...(value.answerMaxBytes !== undefined
      ? { answerMaxBytes: value.answerMaxBytes as number }
      : {}),
    ...(limits ? { limits } : {}),
    ...(value.shell ? { shell: "conservative" as const } : {}),
    ...(value.metrics ? { metrics: "memory" as const } : {}),
    ...(exceptionPatterns ? { exceptionPatterns } : {}),
    ...(delegationHintPatterns ? { delegationHintPatterns } : {}),
  };
}
function envelope(
  value: unknown,
  schema: 2 | 3 | 4 | 5 | 6 | 7,
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
  schema: 3 | 4 | 5 | 6 | 7,
  session: boolean,
): GlobalDefaults | SessionDelegateState | undefined {
  const keys =
    schema === 3
      ? SCHEMA3_KEYS
      : schema === 4
        ? SCHEMA4_KEYS
        : schema === 5
          ? SCHEMA5_KEYS
          : schema === 6
            ? SCHEMA6_KEYS
            : SCHEMA7_KEYS;
  if (!envelope(value, schema, keys, isIntensity)) return undefined;
  const small = value.small === undefined ? undefined : ordinary(value.small);
  const medium = value.medium === undefined ? undefined : ordinary(value.medium);
  const large = value.large === undefined ? undefined : ordinary(value.large);
  const uiDesign =
    value.uiDesign === undefined || (session && value.uiDesign === null)
      ? value.uiDesign
      : model(value.uiDesign);
  const advisor =
    value.advisor === undefined || (session && value.advisor === null)
      ? value.advisor
      : model(value.advisor);
  if (
    (value.small !== undefined && small === undefined) ||
    (value.medium !== undefined && medium === undefined) ||
    (value.large !== undefined && large === undefined) ||
    (value.uiDesign !== undefined && uiDesign === undefined) ||
    (value.advisor !== undefined && advisor === undefined)
  )
    return undefined;
  const supportsContextShunt = schema === 4 || schema === 5 || schema === 6 || schema === 7;
  const contextShunt =
    supportsContextShunt && value.contextShunt !== undefined
      ? parseShunt(value.contextShunt, schema as 4 | 5 | 6 | 7)
      : undefined;
  if (supportsContextShunt && value.contextShunt !== undefined && !contextShunt) return undefined;
  const supportsThinking = schema === 6 || schema === 7;
  const thinking =
    supportsThinking && value.thinking !== undefined
      ? parseThinking(value.thinking, session, schema as 6 | 7)
      : undefined;
  if (supportsThinking && value.thinking !== undefined && !thinking) return undefined;
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
    ...(advisor === null ? { advisor: null } : advisor ? { advisor: advisor as ModelRef } : {}),
    ...(thinking && Object.keys(thinking).length
      ? { thinking: thinking as SessionThinkingSettings }
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
export function parseSchema5Config(value: unknown): GlobalDefaults | undefined {
  return parseModern(value, 5, false) as GlobalDefaults | undefined;
}
export function parseSchema6Config(value: unknown): GlobalDefaults | undefined {
  return parseModern(value, 6, false) as GlobalDefaults | undefined;
}
export function parseSchema7Config(value: unknown): GlobalDefaults | undefined {
  return parseModern(value, 7, false) as GlobalDefaults | undefined;
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
    parseSchema7Config(value) ??
    parseSchema6Config(value) ??
    parseSchema5Config(value) ??
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
    (parseModern(value, 7, true) as SessionDelegateState | undefined) ??
    (parseModern(value, 6, true) as SessionDelegateState | undefined) ??
    (parseModern(value, 5, true) as SessionDelegateState | undefined) ??
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
  const parsed = parseSchema7Config(defaults);
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
function copyPolicy(policy: ThinkingPolicy): ThinkingPolicy {
  return "level" in policy ? { level: policy.level } : { min: policy.min, max: policy.max };
}
function copyThinking(settings: ThinkingSettings): ThinkingSettings {
  return Object.fromEntries(
    Object.entries(settings).map(([key, policy]) => [key, copyPolicy(policy)]),
  ) as ThinkingSettings;
}
/** Session `null` means "no policy in this branch"; a bound policy never inherits `null`. */
function resolveThinking(
  defaults: GlobalDefaults,
  session: SessionDelegateState,
): { thinking: ThinkingSettings; source: Record<ModelConfigKey, ValueSource> } {
  const global = defaults.thinking ?? {};
  const local = session.thinking ?? {};
  const thinking: ThinkingSettings = {};
  const source = Object.fromEntries(THINKING_ROLE_KEYS.map((key) => [key, "default"])) as Record<
    ModelConfigKey,
    ValueSource
  >;
  for (const key of THINKING_ROLE_KEYS) {
    if (Object.hasOwn(local, key)) {
      source[key] = "session";
      const policy = local[key];
      if (policy) thinking[key] = copyPolicy(policy);
    } else if (Object.hasOwn(global, key)) {
      source[key] = "global";
      thinking[key] = copyPolicy(global[key]!);
    }
  }
  return { thinking, source };
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
    readerEnabled: choose("readerEnabled", false),
    readerRole: choose("readerRole", "small" as const),
    answerMaxBytes: choose("answerMaxBytes", DEFAULT_ANSWER_MAX_BYTES),
    limits,
    shell: choose("shell", "conservative" as const),
    metrics: choose("metrics", "memory" as const),
    exceptionPatterns: [...choose("exceptionPatterns", [] as string[])],
    delegationHintPatterns: [...choose("delegationHintPatterns", [] as string[])],
    suspended,
    source: {
      mode: keySource("mode"),
      readerEnabled: keySource("readerEnabled"),
      readerRole: keySource("readerRole"),
      answerMaxBytes: keySource("answerMaxBytes"),
      limits: keySource("limits"),
      shell: keySource("shell"),
      metrics: keySource("metrics"),
      exceptionPatterns: keySource("exceptionPatterns"),
      delegationHintPatterns: keySource("delegationHintPatterns"),
    },
  };
}
/**
 * An optional specialist role resolves like an ordinary one, except that only a session override may
 * disable it and an absent global key stays unconfigured.
 */
function resolveOptionalRole(
  defaults: GlobalDefaults,
  session: SessionDelegateState,
  key: OptionalRoleKey,
): ModelRef | undefined {
  const local = session[key];
  if (local !== undefined) return local === null ? undefined : { ...local };
  const global = defaults[key];
  return global ? { ...global } : undefined;
}
export function resolveDelegateState(
  defaults: GlobalDefaults,
  session: SessionDelegateState,
): EffectiveDelegateState {
  const intensity = session.intensity ?? defaults.intensity ?? "off";
  const uiDesign = resolveOptionalRole(defaults, session, "uiDesign");
  const advisor = resolveOptionalRole(defaults, session, "advisor");
  const role = (name: ModelRole) =>
    copyRole(Object.hasOwn(session, name) ? session[name] : defaults[name]);
  const small = role("small");
  const medium = role("medium");
  const large = role("large");
  const { thinking, source: thinkingSource } = resolveThinking(defaults, session);
  return {
    intensity,
    preference: session.preference ?? defaults.preference ?? "standard",
    ...(small !== undefined ? { small } : {}),
    ...(medium !== undefined ? { medium } : {}),
    ...(large !== undefined ? { large } : {}),
    ...(uiDesign ? { uiDesign } : {}),
    ...(advisor ? { advisor } : {}),
    thinking,
    contextShunt: resolveShunt(defaults, session, intensity),
    source: {
      intensity: source(session, defaults.intensity, "intensity"),
      preference: source(session, defaults.preference, "preference"),
      small: source(session, defaults.small, "small"),
      medium: source(session, defaults.medium, "medium"),
      large: source(session, defaults.large, "large"),
      uiDesign: source(session, defaults.uiDesign, "uiDesign"),
      advisor: source(session, defaults.advisor, "advisor"),
      thinking: thinkingSource,
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
    ...(state.advisor ? { advisor: { ...state.advisor } } : {}),
    ...(Object.keys(state.thinking).length ? { thinking: copyThinking(state.thinking) } : {}),
    ...(hasConfiguredContext
      ? {
          contextShunt: {
            mode: context.configuredMode,
            readerEnabled: context.readerEnabled,
            readerRole: context.readerRole,
            answerMaxBytes: context.answerMaxBytes,
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

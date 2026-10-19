import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ADVISOR_LAUNCH_MODES,
  type AdvisorLaunch,
  type AdvisorSetting,
  ADVISOR_MODES,
  type AdvisorMode,
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
export const ADVISOR_SESSION_ENTRY_TYPE = "pi-delegation-policy:advisor-state";
export const ADVISOR_EXTENSION_ENTRY_TYPE = "pi-delegation-policy:advisor-extension";
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
const SCHEMA8_KEYS = [...SCHEMA7_KEYS, "advisorMode"] as const;
const SCHEMA9_KEYS = [...SCHEMA8_KEYS, "advisors", "advisorLaunch"] as const;
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

export type ConfigDiagnostic = {
  message: string;
  reportWhenOff?: boolean;
  scope?: "advisor" | "advisor-extension";
};
export type LoadedDefaults = {
  defaults: GlobalDefaults;
  diagnostics: ConfigDiagnostic[];
};
/** `unchanged` means this call left the previous pair in place; `partial` means it did not. */
export type GlobalSaveResult = "saved" | "unchanged" | "partial";
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
  schema: 6 | 7 | 8,
): ThinkingSettings | SessionThinkingSettings | undefined {
  // `advisor` arrived with schema 7: a document that claims an older version must not carry it.
  const keys =
    schema >= 7 ? THINKING_ROLE_KEYS : THINKING_ROLE_KEYS.filter((key) => key !== "advisor");
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
function parseShunt(value: unknown, schema: 4 | 5 | 6 | 7 | 8): ContextShuntSettings | undefined {
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
  schema: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
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
  schema: 3 | 4 | 5 | 6 | 7 | 8 | 9,
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
            : schema === 7
              ? SCHEMA7_KEYS
              : schema === 8
                ? SCHEMA8_KEYS
                : SCHEMA9_KEYS;
  if (!envelope(value, schema, keys, isIntensity)) return undefined;
  if (value.advisorMode !== undefined && !ADVISOR_MODES.includes(value.advisorMode as AdvisorMode))
    return undefined;
  if (
    value.advisorLaunch !== undefined &&
    !ADVISOR_LAUNCH_MODES.includes(value.advisorLaunch as AdvisorLaunch)
  )
    return undefined;
  const advisors =
    value.advisors === undefined
      ? undefined
      : session && value.advisors === null
        ? null
        : parseAdvisors(value.advisors);
  if (value.advisors !== undefined && advisors === undefined) return undefined;
  if (
    value.advisors !== undefined &&
    (value.advisor !== undefined ||
      (isRecord(value.thinking) && Object.hasOwn(value.thinking, "advisor")))
  )
    return undefined;
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
  const supportsContextShunt = schema >= 4;
  const contextShunt =
    supportsContextShunt && value.contextShunt !== undefined
      ? parseShunt(value.contextShunt, schema as 4 | 5 | 6 | 7 | 8)
      : undefined;
  if (supportsContextShunt && value.contextShunt !== undefined && !contextShunt) return undefined;
  const supportsThinking = schema >= 6;
  const thinking =
    supportsThinking && value.thinking !== undefined
      ? parseThinking(value.thinking, session, schema as 6 | 7 | 8)
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
    ...(advisors !== undefined ? { advisors } : {}),
    ...(value.advisorLaunch !== undefined
      ? { advisorLaunch: value.advisorLaunch as AdvisorLaunch }
      : {}),
    ...(value.advisorMode !== undefined ? { advisorMode: value.advisorMode as AdvisorMode } : {}),
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
export function parseSchema8Config(value: unknown): GlobalDefaults | undefined {
  return parseModern(value, 8, false) as GlobalDefaults | undefined;
}
export function parseSchema9Config(value: unknown): GlobalDefaults | undefined {
  return parseModern(value, 9, false) as GlobalDefaults | undefined;
}
function parseAdvisors(value: unknown): AdvisorSetting[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return undefined;
  const entries: AdvisorSetting[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !only(entry, ["provider", "model", "thinking"])) return undefined;
    const reference = model({ provider: entry.provider, model: entry.model });
    const thinking = entry.thinking === undefined ? undefined : thinkingPolicy(entry.thinking);
    if (!reference || (entry.thinking !== undefined && !thinking)) return undefined;
    entries.push({ ...reference, ...(thinking ? { thinking } : {}) });
  }
  return entries;
}
/** Normalize legacy first-advisor settings without mutating the loaded document. */
export function configuredAdvisors(
  state: GlobalDefaults | SessionDelegateState,
): AdvisorSetting[] | null | undefined {
  if (state.advisors !== undefined) return structuredClone(state.advisors);
  if (state.advisor === null) return null;
  return state.advisor
    ? [
        {
          ...state.advisor,
          ...(state.thinking?.advisor ? { thinking: copyPolicy(state.thinking.advisor) } : {}),
        },
      ]
    : undefined;
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
    parseSchema9Config(value) ??
    parseSchema8Config(value) ??
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
    (parseModern(value, 9, true) as SessionDelegateState | undefined) ??
    (parseModern(value, 8, true) as SessionDelegateState | undefined) ??
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
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const defaults = parseConfig(value);
    return defaults
      ? await readAdvisorCompanion(path, defaults)
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
function schema8Projection(state: GlobalDefaults | SessionDelegateState) {
  const projected = { ...state, schemaVersion: 8 };
  delete projected.advisors;
  delete projected.advisorLaunch;
  const first = configuredAdvisors(state)?.[0];
  if (state.advisors !== undefined) {
    delete projected.advisor;
    const thinking: SessionThinkingSettings = { ...state.thinking };
    delete thinking.advisor;
    if (first) {
      projected.advisor = { provider: first.provider, model: first.model };
      if (first.thinking) thinking.advisor = copyPolicy(first.thinking);
    } else if (state.advisors === null) projected.advisor = null;
    if (Object.keys(thinking).length) projected.thinking = thinking;
    else delete projected.thinking;
  }
  return projected;
}
export function getAdvisorExtensionPath(path: string): string {
  return `${path.endsWith(".json") ? path.slice(0, -5) : path}.advisor-extension.json`;
}
function advisorExtension(state: GlobalDefaults | SessionDelegateState) {
  const second = configuredAdvisors(state)?.[1];
  return {
    schemaVersion: 1,
    base: schema8Projection(state),
    ...(second ? { advisor2: second } : {}),
    ...(state.advisorLaunch ? { advisorLaunch: state.advisorLaunch } : {}),
  };
}
function extensionDiagnostic(): ConfigDiagnostic {
  return {
    scope: "advisor-extension",
    reportWhenOff: true,
    message:
      "Advisor extension settings are missing, invalid, or stale. Using Advisor 1 only with the inherited launch mode; save again with /delegate.",
  };
}
function applyAdvisorExtension<T extends GlobalDefaults | SessionDelegateState>(
  state: T,
  value: unknown,
): T | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !only(value, ["schemaVersion", "base", "advisor2", "advisorLaunch"])
  )
    return undefined;
  const base = parseSessionState(value.base);
  if (!base || !isDeepStrictEqual(schema8Projection(base), schema8Projection(state)))
    return undefined;
  if (
    value.advisorLaunch !== undefined &&
    !ADVISOR_LAUNCH_MODES.includes(value.advisorLaunch as AdvisorLaunch)
  )
    return undefined;
  const second = value.advisor2 === undefined ? undefined : parseAdvisors([value.advisor2])?.[0];
  if (value.advisor2 !== undefined && !second) return undefined;
  const advisors = configuredAdvisors(state);
  if (second && !advisors?.length) return undefined;
  const extended = { ...state };
  if (second) {
    extended.advisors = [...advisors!, second];
    delete extended.advisor;
    const thinking: SessionThinkingSettings = { ...state.thinking };
    delete thinking.advisor;
    if (Object.keys(thinking).length) extended.thinking = thinking;
    else delete extended.thinking;
  }
  if (value.advisorLaunch) extended.advisorLaunch = value.advisorLaunch as AdvisorLaunch;
  return extended;
}
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, text, "utf8");
    await rename(temporary, path);
  } catch (error) {
    // A committed rename leaves no temporary file behind, so this cleanup only ever runs before the
    // commit and a cleanup failure never turns a written file into a failed replacement.
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
function delegationProjection(state: GlobalDefaults | SessionDelegateState, session: boolean) {
  const delegation = { ...state };
  delete delegation.advisor;
  delete delegation.advisorMode;
  delete delegation.advisors;
  delete delegation.advisorLaunch;
  delete delegation.thinking;
  const ordinaryThinking: SessionThinkingSettings = { ...state.thinking };
  delete ordinaryThinking.advisor;
  return {
    ...delegation,
    schemaVersion: 7 as const,
    ...(session ? { advisor: null } : {}),
    ...(Object.keys(ordinaryThinking).length ? { thinking: ordinaryThinking } : {}),
  };
}
export function getAdvisorConfigPath(path: string): string {
  return `${path.endsWith(".json") ? path.slice(0, -5) : path}.advisor.json`;
}
/**
 * Advisor state is usable only while it describes the same delegation as the delegation file. When
 * it cannot be trusted, delegation still wins and Advisor keeps its model and thinking policy but
 * cannot activate, so a later save repairs the pair instead of losing them.
 */
function withoutAdvisorActivation(
  defaults: GlobalDefaults,
  preserved: GlobalDefaults | undefined,
): GlobalDefaults {
  const advisor = preserved?.advisor ?? defaults.advisor;
  const advisorThinking = preserved?.thinking?.advisor;
  const thinking = {
    ...defaults.thinking,
    ...(advisorThinking ? { advisor: copyPolicy(advisorThinking) } : {}),
  };
  return {
    ...defaults,
    ...(advisor ? { advisor: { ...advisor } } : {}),
    advisorMode: "off",
    ...(Object.keys(thinking).length ? { thinking } : {}),
  };
}
function advisorScopeDiagnostic(): ConfigDiagnostic {
  return {
    message:
      "Advisor settings are invalid or no longer match delegation defaults. Save them again with /delegate; delegation remains available.",
    scope: "advisor",
    reportWhenOff: true,
  };
}
/**
 * Companion envelope. Current saves write `{schemaVersion: 1, state}`; the earlier development
 * envelope also carried a `delegationDigest`, still accepted as a legacy shape but never used. The
 * projection comparison below is the contract, and a digest of the raw delegation text would fail
 * on harmless reformatting without adding integrity over the same two local files.
 */
function advisorCompanionState(value: unknown): GlobalDefaults | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  const keys = Object.hasOwn(value, "delegationDigest")
    ? ["schemaVersion", "delegationDigest", "state"]
    : ["schemaVersion", "state"];
  if (!only(value, keys)) return undefined;
  if (value.delegationDigest !== undefined && typeof value.delegationDigest !== "string")
    return undefined;
  return parseSchema8Config(value.state);
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
async function readAdvisorCompanion(
  path: string,
  defaults: GlobalDefaults,
): Promise<LoadedDefaults> {
  let raw: string;
  try {
    raw = await readFile(getAdvisorConfigPath(path), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { defaults, diagnostics: [] }
      : {
          defaults: withoutAdvisorActivation(defaults, undefined),
          diagnostics: [advisorScopeDiagnostic()],
        };
  }
  const state = advisorCompanionState(parseJson(raw));
  if (
    state &&
    isDeepStrictEqual(delegationProjection(state, false), delegationProjection(defaults, false))
  ) {
    let extension: unknown;
    try {
      extension = parseJson(await readFile(getAdvisorExtensionPath(path), "utf8"));
    } catch {
      extension = undefined;
    }
    const extended = applyAdvisorExtension(state, extension);
    return extended
      ? { defaults: extended, diagnostics: [] }
      : { defaults: state, diagnostics: [extensionDiagnostic()] };
  }
  return {
    defaults: withoutAdvisorActivation(defaults, state),
    diagnostics: [advisorScopeDiagnostic()],
  };
}
type PreviousFile = { kind: "absent" } | { kind: "content"; text: string } | { kind: "unreadable" };
async function readPreviousFile(path: string): Promise<PreviousFile> {
  try {
    return { kind: "content", text: await readFile(path, "utf8") };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable" };
  }
}
function matchesPreviousFile(current: PreviousFile, previous: PreviousFile): boolean {
  if (current.kind !== previous.kind) return false;
  if (previous.kind === "content" && current.kind === "content")
    return current.text === previous.text;
  return previous.kind === "absent";
}
/** Both files must still hold their previous state for a save to claim the pair is unchanged. */
async function pairMatchesPrevious(
  path: string,
  companionPath: string,
  previousMain: PreviousFile,
  previousCompanion: PreviousFile,
): Promise<boolean> {
  return (
    matchesPreviousFile(await readPreviousFile(path), previousMain) &&
    matchesPreviousFile(await readPreviousFile(companionPath), previousCompanion)
  );
}
/**
 * Replace delegation, its legacy Advisor companion, then the schema-9 extension. This is not a
 * three-file transaction: each next file is accepted only against its normalized predecessor.
 * Pre-read every file and restore only our committed prefix, never a foreign write. A hard stop
 * between replacements can leave Advisor off or leave only Advisor 1 in role mode until repaired.
 */
export async function writeConfig(
  path: string,
  defaults: GlobalDefaults,
): Promise<GlobalSaveResult> {
  const parsed = parseSchema9Config(defaults);
  if (!parsed) throw new Error("Refusing to write invalid delegation policy defaults.");
  const companionPath = getAdvisorConfigPath(path);
  const extensionPath = getAdvisorExtensionPath(path);
  const previousExtension = await readPreviousFile(extensionPath);
  const previousMain = await readPreviousFile(path);
  const previousCompanion = await readPreviousFile(companionPath);
  // An existing file this process cannot read holds a previous state that cannot be established, so
  // the save stops before its first write: this call has then mutated nothing to report.
  if (
    previousMain.kind === "unreadable" ||
    previousCompanion.kind === "unreadable" ||
    previousExtension.kind === "unreadable"
  )
    return "unchanged";
  const committed = serialize(delegationProjection(parsed, false));
  try {
    await atomicWrite(path, committed);
  } catch {
    return (await pairMatchesPrevious(path, companionPath, previousMain, previousCompanion)) &&
      matchesPreviousFile(await readPreviousFile(extensionPath), previousExtension)
      ? "unchanged"
      : "partial";
  }
  let companionCommitted = false;
  const companionText = serialize({ schemaVersion: 1, state: schema8Projection(parsed) });
  try {
    await atomicWrite(companionPath, companionText);
    companionCommitted = true;
    await atomicWrite(extensionPath, serialize(advisorExtension(parsed)));
    return "saved";
  } catch {
    // Restore only while the delegation file still holds this call's projection and the companion
    // still holds its previous state: a foreign write must not be overwritten, and the previous
    // pair cannot be re-established once either file moved on.
    const current = await readPreviousFile(path);
    if (current.kind !== "content" || current.text !== committed) return "partial";
    const currentCompanion = await readPreviousFile(companionPath);
    if (
      companionCommitted
        ? currentCompanion.kind !== "content" || currentCompanion.text !== companionText
        : !matchesPreviousFile(currentCompanion, previousCompanion)
    )
      return "partial";
    if (!matchesPreviousFile(await readPreviousFile(extensionPath), previousExtension))
      return "partial";
    try {
      if (companionCommitted) {
        if (previousCompanion.kind === "content")
          await atomicWrite(companionPath, previousCompanion.text);
        else await rm(companionPath, { force: true });
      }
      if (previousMain.kind === "content") await atomicWrite(path, previousMain.text);
      else await rm(path, { force: true });
    } catch {
      return "partial";
    }
    return (await pairMatchesPrevious(path, companionPath, previousMain, previousCompanion)) &&
      matchesPreviousFile(await readPreviousFile(extensionPath), previousExtension)
      ? "unchanged"
      : "partial";
  }
}
export function restoreSessionStateWithDiagnostics(entries: unknown[]): RestoredSessionState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as Record<string, unknown> | undefined;
    if (entry?.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE) continue;
    let session = parseSessionState(entry.data);
    const previous = entries[index - 1] as Record<string, unknown> | undefined;
    if (
      session &&
      previous?.type === "custom" &&
      previous.customType === ADVISOR_SESSION_ENTRY_TYPE
    ) {
      const companion =
        isRecord(previous.data) && previous.data.schemaVersion === 8
          ? parseSessionState(previous.data)
          : undefined;
      if (companion && isDeepStrictEqual(delegationProjection(companion, true), entry.data)) {
        session = companion;
        const extension = entries[index - 2] as Record<string, unknown> | undefined;
        const extended =
          extension?.type === "custom" && extension.customType === ADVISOR_EXTENSION_ENTRY_TYPE
            ? applyAdvisorExtension(companion, extension.data)
            : undefined;
        if (extended) session = extended;
        else return { session, diagnostics: [extensionDiagnostic()] };
      } else
        return {
          session: { ...session, advisor: null, advisorMode: "off" },
          diagnostics: [
            {
              message:
                "Advisor session settings are invalid or do not match delegation state. Apply them again with /delegate.",
              scope: "advisor",
              reportWhenOff: true,
            },
          ],
        };
    }
    // The downgrade guard must also silence an independently enabled global Advisor.
    if (
      session &&
      isRecord(entry.data) &&
      entry.data.schemaVersion === 2 &&
      entry.data.intensity === "off"
    )
      session.advisorMode = "off";
    return session
      ? { session, diagnostics: [] }
      : {
          session: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off", advisorMode: "off" },
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
/** A branch that removed its Advisor model also removed the consultation it allowed. */
function resolveAdvisorMode(defaults: GlobalDefaults, session: SessionDelegateState): AdvisorMode {
  if (session.advisorMode) return session.advisorMode;
  if (configuredAdvisors(session) === null) return "off";
  return defaults.advisorMode ?? "with-delegation";
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
  const localAdvisors = configuredAdvisors(session);
  const advisors =
    localAdvisors !== undefined ? (localAdvisors ?? []) : (configuredAdvisors(defaults) ?? []);
  const advisor = advisors[0]
    ? { provider: advisors[0].provider, model: advisors[0].model }
    : undefined;
  const role = (name: ModelRole) =>
    copyRole(Object.hasOwn(session, name) ? session[name] : defaults[name]);
  const small = role("small");
  const medium = role("medium");
  const large = role("large");
  const { thinking, source: thinkingSource } = resolveThinking(defaults, session);
  // Legacy per-role thinking overrides remain supported until a branch chooses a schema-9 list.
  if (
    session.advisors === undefined &&
    session.thinking &&
    Object.hasOwn(session.thinking, "advisor") &&
    advisors[0]
  ) {
    delete advisors[0].thinking;
    if (session.thinking.advisor) advisors[0].thinking = copyPolicy(session.thinking.advisor);
  }
  if (session.advisors !== undefined || defaults.advisors !== undefined)
    thinkingSource.advisor = localAdvisors !== undefined ? "session" : "global";
  delete thinking.advisor;
  if (advisors[0]?.thinking) thinking.advisor = copyPolicy(advisors[0].thinking);
  return {
    intensity,
    preference: session.preference ?? defaults.preference ?? "standard",
    ...(small !== undefined ? { small } : {}),
    ...(medium !== undefined ? { medium } : {}),
    ...(large !== undefined ? { large } : {}),
    ...(uiDesign ? { uiDesign } : {}),
    ...(advisor ? { advisor } : {}),
    advisors,
    advisorLaunch: session.advisorLaunch ?? defaults.advisorLaunch ?? "role",
    advisorMode: resolveAdvisorMode(defaults, session),
    thinking,
    contextShunt: resolveShunt(defaults, session, intensity),
    source: {
      intensity: source(session, defaults.intensity, "intensity"),
      preference: source(session, defaults.preference, "preference"),
      small: source(session, defaults.small, "small"),
      medium: source(session, defaults.medium, "medium"),
      large: source(session, defaults.large, "large"),
      uiDesign: source(session, defaults.uiDesign, "uiDesign"),
      advisor:
        localAdvisors !== undefined
          ? "session"
          : configuredAdvisors(defaults) !== undefined
            ? "global"
            : "default",
      advisorMode: source(session, defaults.advisorMode, "advisorMode"),
      advisors:
        localAdvisors !== undefined
          ? "session"
          : configuredAdvisors(defaults) !== undefined
            ? "global"
            : "default",
      advisorLaunch: source(session, defaults.advisorLaunch, "advisorLaunch"),
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
    ...(state.advisors.length ? { advisors: structuredClone(state.advisors) } : {}),
    advisorMode: state.advisorMode,
    advisorLaunch: state.advisorLaunch,
    ...(Object.keys(state.thinking).some((key) => key !== "advisor")
      ? {
          thinking: Object.fromEntries(
            Object.entries(copyThinking(state.thinking)).filter(([key]) => key !== "advisor"),
          ),
        }
      : {}),
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
  const parsed = parseSessionState(session);
  if (!parsed) return "state-failed";
  try {
    pi.appendEntry(SESSION_ENTRY_TYPE, { schemaVersion: 2, intensity: "off" });
  } catch {
    return "guard-failed";
  }
  try {
    // The legacy companion remains immediately adjacent to the schema-7 commit for 0.20 readers.
    pi.appendEntry(ADVISOR_EXTENSION_ENTRY_TYPE, advisorExtension(parsed));
    pi.appendEntry(ADVISOR_SESSION_ENTRY_TYPE, schema8Projection(parsed));
    pi.appendEntry(SESSION_ENTRY_TYPE, delegationProjection(parsed, true));
    return "success";
  } catch {
    return "state-failed";
  }
}

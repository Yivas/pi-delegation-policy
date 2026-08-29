import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  emptyGlobalDefaults,
  emptySessionState,
  type EffectiveDelegateState,
  type GlobalDefaults,
  type Intensity,
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
  "Global defaults use schema version 1. Configure schema version 3 with /delegate before activating delegation.";
const INVALID_CONFIG_MESSAGE = "Global defaults are invalid. Configure them again with /delegate.";
const INVALID_SESSION_MESSAGE =
  "The latest delegation session state is invalid or unsupported. Delegation is off for safety.";
const CONFIG_KEYS = [
  "schemaVersion",
  "intensity",
  "preference",
  "small",
  "medium",
  "large",
  "uiDesign",
] as const;

export type ConfigDiagnostic = {
  message: string;
  reportWhenOff?: boolean;
};

export type LoadedDefaults = {
  defaults: GlobalDefaults;
  diagnostics: ConfigDiagnostic[];
};

export type RestoredSessionState = {
  session: SessionDelegateState;
  diagnostics: ConfigDiagnostic[];
};

export type SessionEntryWriter = { appendEntry: (type: string, data?: unknown) => void };
export type GuardedAppendResult = "success" | "guard-failed" | "state-failed";

type Schema2GlobalDefaults = {
  schemaVersion: 2;
  intensity?: Intensity;
  preference?: Preference;
  small?: ModelRef;
  medium?: ModelRef;
  large?: ModelRef;
  uiDesign?: ModelRef;
};

type Schema2SessionState = Omit<Schema2GlobalDefaults, "uiDesign"> & { uiDesign?: ModelRef | null };

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

function copyRoleSetting(value: OrdinaryRoleSetting | undefined): OrdinaryRoleSetting | undefined {
  return value === null ? null : value ? { ...value } : undefined;
}

function hasValidEnvelope(value: unknown, schemaVersion: 2 | 3): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, CONFIG_KEYS) &&
    value.schemaVersion === schemaVersion &&
    (value.intensity === undefined || isIntensity(value.intensity)) &&
    (value.preference === undefined || isPreference(value.preference))
  );
}

function parseSchema2Roles(
  value: Record<string, unknown>,
): Pick<Schema2GlobalDefaults, "small" | "medium" | "large" | "uiDesign"> | undefined {
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
    ...(small ? { small } : {}),
    ...(medium ? { medium } : {}),
    ...(large ? { large } : {}),
    ...(uiDesign ? { uiDesign } : {}),
  };
}

export function parseSchema2Config(value: unknown): Schema2GlobalDefaults | undefined {
  if (!hasValidEnvelope(value, 2)) return undefined;
  const roles = parseSchema2Roles(value);
  if (!roles) return undefined;
  return {
    schemaVersion: 2,
    ...(value.intensity ? { intensity: value.intensity as Intensity } : {}),
    ...(value.preference ? { preference: value.preference as Preference } : {}),
    ...roles,
  };
}

export function parseSchema3Config(value: unknown): GlobalDefaults | undefined {
  if (!hasValidEnvelope(value, CURRENT_SCHEMA_VERSION)) return undefined;
  const parseOrdinary = (setting: unknown): OrdinaryRoleSetting | undefined =>
    setting === null ? null : parseModelRef(setting);
  const small = value.small === undefined ? undefined : parseOrdinary(value.small);
  const medium = value.medium === undefined ? undefined : parseOrdinary(value.medium);
  const large = value.large === undefined ? undefined : parseOrdinary(value.large);
  const uiDesign = value.uiDesign === undefined ? undefined : parseModelRef(value.uiDesign);
  if (
    (value.small !== undefined && small === undefined) ||
    (value.medium !== undefined && medium === undefined) ||
    (value.large !== undefined && large === undefined) ||
    (value.uiDesign !== undefined && !uiDesign)
  )
    return undefined;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...(value.intensity ? { intensity: value.intensity as Intensity } : {}),
    ...(value.preference ? { preference: value.preference as Preference } : {}),
    ...(small !== undefined ? { small } : {}),
    ...(medium !== undefined ? { medium } : {}),
    ...(large !== undefined ? { large } : {}),
    ...(uiDesign ? { uiDesign } : {}),
  };
}

function migrateSchema2Config(value: Schema2GlobalDefaults): GlobalDefaults {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...(value.intensity ? { intensity: value.intensity as Intensity } : {}),
    ...(value.preference ? { preference: value.preference as Preference } : {}),
    ...(value.small ? { small: { ...value.small } } : {}),
    ...(value.medium ? { medium: { ...value.medium } } : {}),
    ...(value.large ? { large: { ...value.large } } : {}),
    ...(value.uiDesign ? { uiDesign: { ...value.uiDesign } } : {}),
  };
}

export function parseConfig(value: unknown): GlobalDefaults | undefined {
  return (
    parseSchema3Config(value) ??
    (() => {
      const schema2 = parseSchema2Config(value);
      return schema2 ? migrateSchema2Config(schema2) : undefined;
    })()
  );
}

function parseSchema2SessionState(value: unknown): Schema2SessionState | undefined {
  if (!hasValidEnvelope(value, 2)) return undefined;
  const uiDesign =
    value.uiDesign === undefined || value.uiDesign === null
      ? value.uiDesign
      : parseModelRef(value.uiDesign);
  const roles = parseSchema2Roles({ ...value, uiDesign: undefined });
  if (!roles || (value.uiDesign !== undefined && value.uiDesign !== null && !uiDesign))
    return undefined;
  return {
    schemaVersion: 2,
    ...(value.intensity ? { intensity: value.intensity as Intensity } : {}),
    ...(value.preference ? { preference: value.preference as Preference } : {}),
    ...roles,
    ...(uiDesign === null ? { uiDesign: null } : uiDesign ? { uiDesign } : {}),
  };
}

function parseSchema3SessionState(value: unknown): SessionDelegateState | undefined {
  if (!hasValidEnvelope(value, CURRENT_SCHEMA_VERSION)) return undefined;
  const parseOrdinary = (setting: unknown): OrdinaryRoleSetting | undefined =>
    setting === null ? null : parseModelRef(setting);
  const small = value.small === undefined ? undefined : parseOrdinary(value.small);
  const medium = value.medium === undefined ? undefined : parseOrdinary(value.medium);
  const large = value.large === undefined ? undefined : parseOrdinary(value.large);
  const uiDesign =
    value.uiDesign === undefined || value.uiDesign === null
      ? value.uiDesign
      : parseModelRef(value.uiDesign);
  if (
    (value.small !== undefined && small === undefined) ||
    (value.medium !== undefined && medium === undefined) ||
    (value.large !== undefined && large === undefined) ||
    (value.uiDesign !== undefined && value.uiDesign !== null && !uiDesign)
  )
    return undefined;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...(value.intensity ? { intensity: value.intensity as Intensity } : {}),
    ...(value.preference ? { preference: value.preference as Preference } : {}),
    ...(small !== undefined ? { small } : {}),
    ...(medium !== undefined ? { medium } : {}),
    ...(large !== undefined ? { large } : {}),
    ...(uiDesign === null ? { uiDesign: null } : uiDesign ? { uiDesign } : {}),
  };
}

function migrateSchema2SessionState(value: Schema2SessionState): SessionDelegateState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...(value.intensity ? { intensity: value.intensity as Intensity } : {}),
    ...(value.preference ? { preference: value.preference as Preference } : {}),
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

export function parseSessionState(value: unknown): SessionDelegateState | undefined {
  return (
    parseSchema3SessionState(value) ??
    (() => {
      const schema2 = parseSchema2SessionState(value);
      return schema2 ? migrateSchema2SessionState(schema2) : undefined;
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
  const parsed = parseSchema3Config(defaults);
  if (!parsed) throw new Error("Refusing to write invalid delegation policy defaults.");
  await atomicWrite(path, parsed);
}

export function restoreSessionStateWithDiagnostics(entries: unknown[]): RestoredSessionState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as Record<string, unknown> | undefined;
    if (entry?.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE) continue;
    const session = parseSessionState(entry.data);
    if (session) return { session, diagnostics: [] };
    return {
      session: { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off" },
      diagnostics: [{ message: INVALID_SESSION_MESSAGE, reportWhenOff: true }],
    };
  }
  return { session: emptySessionState(), diagnostics: [] };
}

export function restoreSessionState(entries: unknown[]): SessionDelegateState {
  return restoreSessionStateWithDiagnostics(entries).session;
}

function sourceFor<T>(
  session: Record<string, unknown>,
  globalValue: T | undefined,
  key: string,
): ValueSource {
  if (Object.hasOwn(session, key)) return "session";
  if (globalValue !== undefined) return "global";
  return "default";
}

function resolveRole(
  globalValue: OrdinaryRoleSetting | undefined,
  session: SessionDelegateState,
  role: ModelRole,
): OrdinaryRoleSetting | undefined {
  return copyRoleSetting(Object.hasOwn(session, role) ? session[role] : globalValue);
}

export function resolveDelegateState(
  defaults: GlobalDefaults,
  session: SessionDelegateState,
): EffectiveDelegateState {
  const uiDesign =
    session.uiDesign === undefined
      ? defaults.uiDesign
        ? { ...defaults.uiDesign }
        : undefined
      : session.uiDesign === null
        ? undefined
        : { ...session.uiDesign };
  const small = resolveRole(defaults.small, session, "small");
  const medium = resolveRole(defaults.medium, session, "medium");
  const large = resolveRole(defaults.large, session, "large");

  return {
    intensity: session.intensity ?? defaults.intensity ?? "off",
    preference: session.preference ?? defaults.preference ?? "standard",
    ...(small !== undefined ? { small } : {}),
    ...(medium !== undefined ? { medium } : {}),
    ...(large !== undefined ? { large } : {}),
    ...(uiDesign ? { uiDesign } : {}),
    source: {
      intensity: sourceFor(session, defaults.intensity, "intensity"),
      preference: sourceFor(session, defaults.preference, "preference"),
      small: sourceFor(session, defaults.small, "small"),
      medium: sourceFor(session, defaults.medium, "medium"),
      large: sourceFor(session, defaults.large, "large"),
      uiDesign: sourceFor(session, defaults.uiDesign, "uiDesign"),
    },
  };
}

export function defaultsFromEffectiveState(state: EffectiveDelegateState): GlobalDefaults {
  const role = (setting: OrdinaryRoleSetting | undefined) =>
    setting === undefined ? {} : setting === null ? { value: null } : { value: { ...setting } };
  const small = role(state.small);
  const medium = role(state.medium);
  const large = role(state.large);
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    intensity: state.intensity,
    preference: state.preference,
    ...("value" in small ? { small: small.value } : {}),
    ...("value" in medium ? { medium: medium.value } : {}),
    ...("value" in large ? { large: large.value } : {}),
    ...(state.uiDesign ? { uiDesign: { ...state.uiDesign } } : {}),
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

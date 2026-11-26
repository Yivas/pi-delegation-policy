import { readFile, rm } from "node:fs/promises";
import { atomicWrite, getGlobalConfigPath, isAbsentPathError } from "./config.ts";

/**
 * The user's own settings for the `guard` level, kept apart from the policy document because that
 * document rejects unknown keys and because these are a property of the person running the session,
 * never of a branch: they live in user scope only.
 *
 * `consultBeforeFirstChange` is the switch that asks for a consultation before the first change of
 * every `guard` task. Off is the default, and the absent file is how off is stored, so "nothing
 * configured" has one representation on disk. The switch only moves the hold the level already has:
 * it opens no consultation, it passes no rule, and it holds nothing when no consultation is possible.
 */
export const GUARD_MODE_SCHEMA_VERSION = 1;
const INVALID_MESSAGE =
  "Guard settings are invalid and were ignored; guard holds nothing before the first change. Fix or remove delegation-policy.guard.json.";

export type GuardMode = {
  /** Hold the first change of every `guard` task until an Advisor consultation answers. */
  consultBeforeFirstChange: boolean;
};

export function defaultGuardMode(): GuardMode {
  return { consultBeforeFirstChange: false };
}

export function getGuardModePath(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.guard.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict: `{schemaVersion: 1, consultBeforeFirstChange?: boolean}` and no other key. */
export function parseGuardMode(value: unknown): GuardMode | undefined {
  if (!isRecord(value) || value.schemaVersion !== GUARD_MODE_SCHEMA_VERSION) return undefined;
  if (
    !Object.keys(value).every(
      (key) => key === "schemaVersion" || key === "consultBeforeFirstChange",
    )
  )
    return undefined;
  if (value.consultBeforeFirstChange === undefined) return defaultGuardMode();
  return typeof value.consultBeforeFirstChange === "boolean"
    ? { consultBeforeFirstChange: value.consultBeforeFirstChange }
    : undefined;
}

export type LoadedGuardMode = {
  /** The settings in effect: what the file states, or the defaults when it states nothing. */
  mode: GuardMode;
  /** The file holds something this reader cannot interpret, so the defaults are in effect. */
  invalid: boolean;
};

/**
 * A missing file is the default. An unreadable or invalid one is reported and resolved with the
 * defaults, so it never blocks delegation, the Advisor axis or the level itself.
 */
export async function readGuardMode(configPath = getGlobalConfigPath()): Promise<LoadedGuardMode> {
  let text: string;
  try {
    text = await readFile(getGuardModePath(configPath), "utf8");
  } catch (error) {
    return isAbsentPathError(error)
      ? { mode: defaultGuardMode(), invalid: false }
      : { mode: defaultGuardMode(), invalid: true };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { mode: defaultGuardMode(), invalid: true };
  }
  const mode = parseGuardMode(value);
  return mode ? { mode, invalid: false } : { mode: defaultGuardMode(), invalid: true };
}

/**
 * `unknown-state` means the file holds something this reader cannot parse, so it was left alone: an
 * unknown state is never silently replaced. `failed` means the replacement or the removal did not
 * commit.
 */
export type GuardModeSaveResult = "saved" | "unchanged" | "unknown-state" | "failed";

type PreviousMode = { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; mode: GuardMode };

async function readPreviousMode(path: string): Promise<PreviousMode> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return isAbsentPathError(error) ? { kind: "absent" } : { kind: "invalid" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  const mode = parseGuardMode(value);
  return mode ? { kind: "valid", mode } : { kind: "invalid" };
}

/** Every setting at its default, which is the absent file rather than a document of defaults. */
function isDefaultGuardMode(mode: GuardMode): boolean {
  return !mode.consultBeforeFirstChange;
}

/**
 * Store the settings. The previous state is read first, so a file this writer cannot read is
 * reported instead of replaced, and the defaults are stored as the absent file so turning the switch
 * off leaves nothing behind. The replacement is the same temporary-file write the other companions
 * use, so a failure leaves the previous file in place.
 */
export async function writeGuardMode(
  mode: GuardMode,
  configPath = getGlobalConfigPath(),
): Promise<GuardModeSaveResult> {
  const path = getGuardModePath(configPath);
  const previous = await readPreviousMode(path);
  if (previous.kind === "invalid") return "unknown-state";
  const wanted: GuardMode = { consultBeforeFirstChange: mode.consultBeforeFirstChange === true };
  if (
    previous.kind === "valid" &&
    previous.mode.consultBeforeFirstChange === wanted.consultBeforeFirstChange
  )
    return "unchanged";
  if (isDefaultGuardMode(wanted)) {
    if (previous.kind === "absent") return "unchanged";
    try {
      await rm(path, { force: true });
      return "saved";
    } catch {
      return "failed";
    }
  }
  try {
    await atomicWrite(
      path,
      `${JSON.stringify({ schemaVersion: GUARD_MODE_SCHEMA_VERSION, consultBeforeFirstChange: true }, null, 2)}\n`,
    );
    return "saved";
  } catch {
    return "failed";
  }
}

export function guardModeDiagnostic(invalid: boolean) {
  return invalid
    ? { scope: "guard" as const, reportWhenOff: true, message: INVALID_MESSAGE }
    : undefined;
}

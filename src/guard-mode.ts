import { readFile, rm } from "node:fs/promises";
import { isModelKey } from "./advisor-level.ts";
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
 *
 * `reviewer` is the optional second opinion: one model, and the mode it runs in. `off` means no
 * call, `observe` records what it would refuse, and `enforce` refuses that call until an answered
 * consultation covers it. A reviewer that is not off needs a model, so the writer never stores a
 * mode without one. Whether the model can run here (a credential, availability, not the main model)
 * is a property of the host, not of this file: the menu reads it from the model registry and the
 * runtime reads it again at the call.
 */
export const GUARD_MODE_SCHEMA_VERSION = 2;
const INVALID_MESSAGE =
  "Guard settings are invalid and were ignored; guard holds nothing before the first change and starts no reviewer. Fix or remove delegation-policy.guard.json.";

export const GUARD_REVIEWER_MODES = ["off", "observe", "enforce"] as const;
export type GuardReviewerMode = (typeof GUARD_REVIEWER_MODES)[number];

export type GuardReviewer = {
  /** "provider/id" of the model that reviews a change, or none. */
  model: string | null;
  mode: GuardReviewerMode;
};

export type GuardMode = {
  /** Hold the first change of every `guard` task until an Advisor consultation answers. */
  consultBeforeFirstChange: boolean;
  reviewer: GuardReviewer;
};

export function defaultGuardMode(): GuardMode {
  return { consultBeforeFirstChange: false, reviewer: { model: null, mode: "off" } };
}

export function sameGuardMode(left: GuardMode, right: GuardMode): boolean {
  return (
    left.consultBeforeFirstChange === right.consultBeforeFirstChange &&
    left.reviewer.model === right.reviewer.model &&
    left.reviewer.mode === right.reviewer.mode
  );
}

export function getGuardModePath(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.guard.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReviewerMode(value: unknown): value is GuardReviewerMode {
  return GUARD_REVIEWER_MODES.includes(value as GuardReviewerMode);
}

/**
 * Strict: `{schemaVersion: 2, consultBeforeFirstChange?: boolean, reviewer?: {model?, mode?} | null}`
 * and no other key. A reviewer that names a mode and no model is a state this writer never produces,
 * so it is rejected like any other value the reader cannot interpret.
 */
function parseReviewer(value: unknown): GuardReviewer | undefined {
  if (!isRecord(value)) return undefined;
  if (!Object.keys(value).every((key) => key === "model" || key === "mode")) return undefined;
  const model = value.model === undefined ? null : value.model;
  if (model !== null && (typeof model !== "string" || !isModelKey(model))) return undefined;
  const mode = value.mode === undefined ? "off" : value.mode;
  if (!isReviewerMode(mode)) return undefined;
  if (mode !== "off" && model === null) return undefined;
  return { model, mode };
}

export function parseGuardMode(value: unknown): GuardMode | undefined {
  if (!isRecord(value)) return undefined;
  const version = value.schemaVersion;
  // Version 1 wrote no reviewer, so it is read with the defaults of one that is off.
  const allowed =
    version === 1
      ? ["schemaVersion", "consultBeforeFirstChange"]
      : version === GUARD_MODE_SCHEMA_VERSION
        ? ["schemaVersion", "consultBeforeFirstChange", "reviewer"]
        : undefined;
  if (!allowed || !Object.keys(value).every((key) => allowed.includes(key))) return undefined;
  if (
    value.consultBeforeFirstChange !== undefined &&
    typeof value.consultBeforeFirstChange !== "boolean"
  )
    return undefined;
  const mode = defaultGuardMode();
  if (value.consultBeforeFirstChange !== undefined)
    mode.consultBeforeFirstChange = value.consultBeforeFirstChange;
  // An explicit `null` is how a hand edit says "no reviewer", so it is the same as leaving the key
  // out instead of an unreadable file that would also drop the consult switch.
  if (version === 1 || value.reviewer === undefined || value.reviewer === null) return mode;
  const reviewer = parseReviewer(value.reviewer);
  return reviewer ? { ...mode, reviewer } : undefined;
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
  return !mode.consultBeforeFirstChange && mode.reviewer.model === null;
}

/**
 * A reviewer with no model is off: there is nothing to run. It is the same rule the reader states,
 * applied once here so no caller can store a mode that could never act.
 */
function normalizeGuardMode(mode: GuardMode): GuardMode {
  return {
    consultBeforeFirstChange: mode.consultBeforeFirstChange === true,
    reviewer: {
      model: mode.reviewer.model,
      mode: mode.reviewer.model === null ? "off" : mode.reviewer.mode,
    },
  };
}

/**
 * Only what differs from the default is stored, so the file says exactly what the user chose. The
 * previous state is read first, so a file this writer cannot read is reported instead of replaced,
 * and the defaults are stored as the absent file so turning everything off leaves nothing behind.
 * The replacement is the same temporary-file write the other companions use, so a failure leaves
 * the previous file in place.
 */
export async function writeGuardMode(
  mode: GuardMode,
  configPath = getGlobalConfigPath(),
): Promise<GuardModeSaveResult> {
  const path = getGuardModePath(configPath);
  const previous = await readPreviousMode(path);
  if (previous.kind === "invalid") return "unknown-state";
  const wanted = normalizeGuardMode(mode);
  if (previous.kind === "valid" && sameGuardMode(previous.mode, wanted)) return "unchanged";
  if (isDefaultGuardMode(wanted)) {
    if (previous.kind === "absent") return "unchanged";
    try {
      await rm(path, { force: true });
      return "saved";
    } catch {
      return "failed";
    }
  }
  const stored = {
    schemaVersion: GUARD_MODE_SCHEMA_VERSION,
    ...(wanted.consultBeforeFirstChange ? { consultBeforeFirstChange: true } : {}),
    ...(wanted.reviewer.model === null ? {} : { reviewer: { ...wanted.reviewer } }),
  };
  try {
    await atomicWrite(path, `${JSON.stringify(stored, null, 2)}\n`);
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

import { readFile, rm } from "node:fs/promises";
import { atomicWrite, getGlobalConfigPath, isAbsentPathError } from "./config.ts";

/**
 * How hard this extension nudges the main agent towards an Advisor consultation.
 *
 * The level has its own versioned file because the policy document rejects unknown keys, and
 * because it is a behaviour of the extension, optionally overridden per main model, rather than a
 * property of a delegation profile. `strict` refuses one tool call per task; `guard` never refuses a
 * call and interrupts the close of a task instead, which is the only place the host can hold.
 */
export const ADVISOR_LEVELS = ["off", "standard", "strict", "guard"] as const;
export type AdvisorLevel = (typeof ADVISOR_LEVELS)[number];
/** Who writes the consultation brief: the extension, or the user. */
export const ADVISOR_CONTEXT_MODES = ["composed", "manual"] as const;
export type AdvisorContextMode = (typeof ADVISOR_CONTEXT_MODES)[number];
export const ADVISOR_LEVEL_SCHEMA_VERSION = 1;
/** Custom session entry type. The newest valid entry on the branch decides. */
export const ADVISOR_LEVEL_ENTRY_TYPE = "pi-delegation-policy:advisor-level";
export const DEFAULT_ADVISOR_LEVEL: AdvisorLevel = "standard";
export const DEFAULT_ADVISOR_CONTEXT_MODE: AdvisorContextMode = "composed";

/**
 * A per-model map is a few deliberate overrides in practice, so this cap only bounds a corrupted or
 * hand-edited file: past it the whole file is rejected instead of parsed.
 */
const MAX_MODEL_KEYS = 64;
const INVALID_MESSAGE =
  "Advisor nudge level settings are invalid and were ignored; the level falls back to standard. Fix or remove delegation-policy.advisor-level.json.";

/** What the companion file holds. `models` maps an exact "provider/id" main-model key to a level. */
export type AdvisorLevelFile = {
  level?: AdvisorLevel;
  models: Record<string, AdvisorLevel>;
  context?: AdvisorContextMode;
};

export function emptyAdvisorLevelFile(): AdvisorLevelFile {
  return { models: {} };
}

export function getAdvisorLevelPath(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.advisor-level.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAdvisorLevel(value: unknown): value is AdvisorLevel {
  return ADVISOR_LEVELS.includes(value as AdvisorLevel);
}

function isAdvisorContextMode(value: unknown): value is AdvisorContextMode {
  return ADVISOR_CONTEXT_MODES.includes(value as AdvisorContextMode);
}

/**
 * Unlike the sibling companions this parser ignores unknown keys: a newer version of this file may
 * add keys, and rejecting the file would throw away a level the user set. A wrong version or a
 * wrong value under a known key is a state this reader cannot interpret, so it is rejected whole.
 */
export function parseAdvisorLevelFile(value: unknown): AdvisorLevelFile | undefined {
  if (!isRecord(value) || value.schemaVersion !== ADVISOR_LEVEL_SCHEMA_VERSION) return undefined;
  const file = emptyAdvisorLevelFile();
  if (value.level !== undefined) {
    if (!isAdvisorLevel(value.level)) return undefined;
    file.level = value.level;
  }
  if (value.context !== undefined) {
    if (!isAdvisorContextMode(value.context)) return undefined;
    file.context = value.context;
  }
  if (value.models !== undefined) {
    if (!isRecord(value.models)) return undefined;
    const keys = Object.keys(value.models);
    if (keys.length > MAX_MODEL_KEYS) return undefined;
    for (const key of keys) {
      const level = value.models[key];
      // An empty key names no model, so it can never be matched and only survives as a trap.
      if (!key || !isAdvisorLevel(level)) return undefined;
      file.models[key] = level;
    }
  }
  return file;
}

export type LoadedAdvisorLevel = { file: AdvisorLevelFile; present: boolean; invalid: boolean };

/**
 * A missing file is the default. An unreadable or invalid one is reported as invalid and resolved
 * with the empty file, so it never blocks delegation or the Advisor axis.
 */
export async function readAdvisorLevelFile(
  configPath = getGlobalConfigPath(),
): Promise<LoadedAdvisorLevel> {
  const empty: LoadedAdvisorLevel = {
    file: emptyAdvisorLevelFile(),
    present: true,
    invalid: true,
  };
  let text: string;
  try {
    text = await readFile(getAdvisorLevelPath(configPath), "utf8");
  } catch (error) {
    return isAbsentPathError(error)
      ? { file: emptyAdvisorLevelFile(), present: false, invalid: false }
      : empty;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return empty;
  }
  const file = parseAdvisorLevelFile(value);
  return file ? { file, present: true, invalid: false } : empty;
}

export type AdvisorLevelSaveResult = "saved" | "unchanged" | "unknown-state" | "failed";

function sortedModels(models: Record<string, AdvisorLevel>): Record<string, AdvisorLevel> {
  const sorted: Record<string, AdvisorLevel> = {};
  for (const key of Object.keys(models).sort()) sorted[key] = models[key];
  return sorted;
}

function isEmptyAdvisorLevelFile(file: AdvisorLevelFile): boolean {
  return file.level === undefined && file.context === undefined && !Object.keys(file.models).length;
}

/** Keys in a fixed order and models sorted, so the same content is always the same bytes. */
function serializeAdvisorLevelFile(file: AdvisorLevelFile): string {
  const models = sortedModels(file.models);
  return `${JSON.stringify(
    {
      schemaVersion: ADVISOR_LEVEL_SCHEMA_VERSION,
      ...(file.level === undefined ? {} : { level: file.level }),
      ...(Object.keys(models).length ? { models } : {}),
      ...(file.context === undefined ? {} : { context: file.context }),
    },
    null,
    2,
  )}\n`;
}

function sameAdvisorLevelFile(left: AdvisorLevelFile, right: AdvisorLevelFile): boolean {
  if (left.level !== right.level || left.context !== right.context) return false;
  const keys = Object.keys(left.models);
  return (
    keys.length === Object.keys(right.models).length &&
    keys.every((key) => Object.hasOwn(right.models, key) && right.models[key] === left.models[key])
  );
}

/**
 * Store the level file. A file this writer cannot read is reported instead of replaced, and the
 * content is compared before writing so an unchanged save leaves the file, including any key a newer
 * version added, exactly as it is.
 */
export async function writeAdvisorLevelFile(
  file: AdvisorLevelFile,
  configPath = getGlobalConfigPath(),
): Promise<AdvisorLevelSaveResult> {
  const path = getAdvisorLevelPath(configPath);
  const current = await readAdvisorLevelFile(configPath);
  if (current.invalid) return "unknown-state";
  if (current.present && sameAdvisorLevelFile(current.file, file)) return "unchanged";
  // No level, no model override and no context is the absent file: removal keeps one representation
  // of "nothing is configured" instead of an empty document that a reader has to interpret.
  if (isEmptyAdvisorLevelFile(file)) {
    if (!current.present) return "unchanged";
    try {
      await rm(path, { force: true });
      return "saved";
    } catch {
      return "failed";
    }
  }
  try {
    await atomicWrite(path, serializeAdvisorLevelFile(file));
    return "saved";
  } catch {
    return "failed";
  }
}

/** Session entry payload: `level: null` means inherit. */
export type AdvisorLevelEntry = { schemaVersion: 1; level: AdvisorLevel | null };

export function advisorLevelEntry(level: AdvisorLevel | null): AdvisorLevelEntry {
  return { schemaVersion: ADVISOR_LEVEL_SCHEMA_VERSION, level };
}

export function parseAdvisorLevelEntry(data: unknown): AdvisorLevelEntry | undefined {
  if (!isRecord(data) || data.schemaVersion !== ADVISOR_LEVEL_SCHEMA_VERSION) return undefined;
  if (data.level === null) return advisorLevelEntry(null);
  return isAdvisorLevel(data.level) ? advisorLevelEntry(data.level) : undefined;
}

/**
 * The newest valid entry of ADVISOR_LEVEL_ENTRY_TYPE on the branch decides; null or none means
 * inherit. An entry this reader cannot parse is skipped rather than thrown, because a session
 * written by another version must not make this one fail.
 */
export function sessionAdvisorLevel(branch: readonly unknown[]): AdvisorLevel | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== ADVISOR_LEVEL_ENTRY_TYPE
    )
      continue;
    const parsed = parseAdvisorLevelEntry(entry.data);
    if (parsed) return parsed.level ?? undefined;
  }
  return undefined;
}

export type AdvisorLevelSource = "session" | "model" | "global" | "reminder" | "default";
export type ResolvedAdvisorLevel = { level: AdvisorLevel; source: AdvisorLevelSource };

export function resolveAdvisorLevel(input: {
  session?: AdvisorLevel;
  file: AdvisorLevelFile;
  filePresent: boolean;
  reminderMode?: "off" | "remind";
  model?: string;
}): ResolvedAdvisorLevel {
  const { session, file, filePresent, reminderMode, model } = input;
  if (session !== undefined) return { level: session, source: "session" };
  // An exact, case-sensitive own key only: a model reference is not a pattern, and the prototype
  // chain is not a source of settings.
  if (model !== undefined && Object.hasOwn(file.models, model))
    return { level: file.models[model], source: "model" };
  if (file.level !== undefined) return { level: file.level, source: "global" };
  // The old reminder was on by default, so only its `off` still carries a choice. A file that exists
  // is this setting's own answer, even when it says nothing, so it ends the fallback.
  if (!filePresent && reminderMode === "off") return { level: "off", source: "reminder" };
  return { level: DEFAULT_ADVISOR_LEVEL, source: "default" };
}

/** A model reference reaches a file and a filename-like key, so it stays a short, plain token. */
const KEY_PART = /^[A-Za-z0-9._:@-]{1,128}$/;
/** A model id may also carry a slash, as in `openai/gpt-6.1-sol`. */
const KEY_ID = /^[A-Za-z0-9._:@/-]{1,128}$/;

/** "provider/id" for the host's current main model, or undefined when it cannot be named safely. */
export function mainModelKey(model: unknown): string | undefined {
  if (!isRecord(model)) return undefined;
  const { provider, id } = model;
  if (typeof provider !== "string" || !KEY_PART.test(provider)) return undefined;
  if (typeof id !== "string" || !KEY_ID.test(id)) return undefined;
  return `${provider}/${id}`;
}

export function advisorLevelDiagnostic(
  invalid: boolean,
): { scope: "advisor-level"; reportWhenOff: true; message: string } | undefined {
  return invalid
    ? { scope: "advisor-level" as const, reportWhenOff: true as const, message: INVALID_MESSAGE }
    : undefined;
}

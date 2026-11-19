import { readFile, rm } from "node:fs/promises";
import {
  atomicWrite,
  getGlobalConfigPath,
  isAbsentPathError,
  type ConfigDiagnostic,
} from "./config.ts";
import {
  emptyRoleEntries,
  OPTIONAL_ROLE_ENTRY_LIMIT,
  OPTIONAL_ROLE_FAMILIES,
  optionalRoleEntryKeys,
  type RepeatedRoleEntry,
  type RoleEntries,
  type RoleEntry,
  THINKING_LEVEL_NAMES,
  type ThinkingLevelName,
  type ThinkingPolicy,
} from "./types.ts";

/**
 * Optional-role entries live in their own versioned file. The policy document rejects unknown keys,
 * so a new key there would make every installed older version read the whole configuration as
 * invalid; a separate file is invisible to them and is never rewritten by them either. Entry 1 of
 * Visual Design is still mirrored into the document, so a downgrade keeps a working single entry.
 */
export const ROLE_ENTRIES_SCHEMA_VERSION = 1;
const INVALID_MESSAGE =
  "Optional role entries are invalid and were ignored; only the first Visual Design entry from the delegation defaults applies. Fix or remove delegation-policy.roles.json.";
const UNREADABLE_MESSAGE =
  "Optional role entries could not be read and were ignored; only the first Visual Design entry from the delegation defaults applies. Check that delegation-policy.roles.json is readable and is not a directory.";
/**
 * The sidecar is a side setting: a broken file costs the optional roles and is reported in the panel
 * and in `details=`, never as `D:ERR`, and it is reported even while both axes are off.
 */
function diagnostic(message: string): ConfigDiagnostic {
  return { message, scope: "role-entries", reportWhenOff: true };
}

export function getRoleEntriesPath(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.roles.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Level names are closed and ordered; a range must not be inverted. */
function parseThinking(value: unknown): ThinkingPolicy | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  const level = (candidate: unknown): candidate is ThinkingLevelName =>
    typeof candidate === "string" &&
    (THINKING_LEVEL_NAMES as readonly string[]).includes(candidate);
  if (keys.length === 1 && keys[0] === "level") {
    return level(value.level) ? { level: value.level } : undefined;
  }
  if (keys.length === 2 && keys.includes("min") && keys.includes("max")) {
    const { min, max } = value;
    if (!level(min) || !level(max)) return undefined;
    const order = THINKING_LEVEL_NAMES as readonly string[];
    if (order.indexOf(min) > order.indexOf(max)) return undefined;
    return min === max ? { level: min } : { min, max };
  }
  return undefined;
}

function parseEntry(value: unknown): RoleEntry | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (!keys.every((key) => ["provider", "model", "thinking"].includes(key))) return undefined;
  if (typeof value.provider !== "string" || !value.provider) return undefined;
  if (typeof value.model !== "string" || !value.model) return undefined;
  let thinking: ThinkingPolicy | undefined;
  if (value.thinking !== undefined) {
    thinking = parseThinking(value.thinking);
    if (!thinking) return undefined;
  }
  return {
    provider: value.provider,
    model: value.model,
    ...(thinking ? { thinking } : {}),
  };
}

function parseFamily(value: unknown): RoleEntry[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > OPTIONAL_ROLE_ENTRY_LIMIT) return undefined;
  const entries: RoleEntry[] = [];
  for (const item of value) {
    const entry = parseEntry(item);
    if (!entry) return undefined;
    // The same model twice in one family would make "which entry" unanswerable.
    if (entries.some((seen) => seen.provider === entry.provider && seen.model === entry.model))
      return undefined;
    entries.push(entry);
  }
  return entries;
}

/** Strict parse of the whole sidecar; undefined means "not ours to trust". */
export function parseRoleEntries(value: unknown): RoleEntries | undefined {
  if (!isRecord(value) || value.schemaVersion !== ROLE_ENTRIES_SCHEMA_VERSION) return undefined;
  if (
    !Object.keys(value).every((key) => ["schemaVersion", ...OPTIONAL_ROLE_FAMILIES].includes(key))
  )
    return undefined;
  const entries = emptyRoleEntries();
  for (const family of OPTIONAL_ROLE_FAMILIES) {
    const parsed = parseFamily(value[family]);
    if (!parsed) return undefined;
    entries[family] = parsed;
  }
  return entries;
}

function copyEntry(entry: RoleEntry): RoleEntry {
  return {
    provider: entry.provider,
    model: entry.model,
    ...(entry.thinking
      ? {
          thinking:
            "level" in entry.thinking
              ? { level: entry.thinking.level }
              : { min: entry.thinking.min, max: entry.thinking.max },
        }
      : {}),
  };
}

export function copyRoleEntries(entries: RoleEntries): RoleEntries {
  return {
    uiDesign: entries.uiDesign.map(copyEntry),
    vision: entries.vision.map(copyEntry),
  };
}

/**
 * A family never holds one `provider/model` twice, so a list that repeats one would be rejected by this
 * reader. A seed built from the document plus the sidecar can repeat one without the user typing it
 * twice; the earlier slot keeps the model and the later ones are dropped and reported.
 */
export function dropRepeatedRoleEntries(entries: RoleEntries): {
  entries: RoleEntries;
  dropped: RepeatedRoleEntry[];
} {
  const kept = copyRoleEntries(entries);
  const dropped: RepeatedRoleEntry[] = [];
  for (const family of OPTIONAL_ROLE_FAMILIES) {
    const keys = optionalRoleEntryKeys(family);
    const unique: RoleEntry[] = [];
    for (const entry of kept[family]) {
      const index = unique.length + 1;
      if (unique.some((seen) => seen.provider === entry.provider && seen.model === entry.model)) {
        dropped.push({
          key: keys[index - 1]!,
          index,
          provider: entry.provider,
          model: entry.model,
        });
        continue;
      }
      unique.push(entry);
    }
    kept[family] = unique;
  }
  return { entries: kept, dropped };
}

export function sameRoleEntries(left: RoleEntries, right: RoleEntries): boolean {
  const clean = (entries: RoleEntries) =>
    JSON.stringify(OPTIONAL_ROLE_FAMILIES.map((family) => entries[family].map(copyEntry)));
  return clean(left) === clean(right);
}

export type LoadedRoleEntries = {
  entries: RoleEntries;
  diagnostics: ConfigDiagnostic[];
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * A missing file is the clean default. A file this reader cannot parse is reported and ignored, so a
 * broken sidecar costs the optional roles and never the delegation policy itself.
 */
export async function readRoleEntries(
  configPath = getGlobalConfigPath(),
): Promise<LoadedRoleEntries> {
  let text: string;
  try {
    text = await readFile(getRoleEntriesPath(configPath), "utf8");
  } catch (error) {
    return isAbsentPathError(error)
      ? { entries: emptyRoleEntries(), diagnostics: [] }
      : { entries: emptyRoleEntries(), diagnostics: [diagnostic(UNREADABLE_MESSAGE)] };
  }
  const entries = parseRoleEntries(parseJson(text));
  return entries
    ? { entries, diagnostics: [] }
    : { entries: emptyRoleEntries(), diagnostics: [diagnostic(INVALID_MESSAGE)] };
}

export type RoleEntriesSaveResult = "saved" | "unchanged" | "unknown-state" | "failed";

async function previousState(
  path: string,
): Promise<{ kind: "absent" } | { kind: "invalid" } | { kind: "entries"; entries: RoleEntries }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return isAbsentPathError(error) ? { kind: "absent" } : { kind: "invalid" };
  }
  const entries = parseRoleEntries(parseJson(text));
  return entries ? { kind: "entries", entries } : { kind: "invalid" };
}

/**
 * An unparseable file is reported instead of replaced: this writer only ever overwrites a state it
 * can read. A list this reader would reject is refused before anything is written, so the writer can
 * never produce a file it cannot read back. Empty lists are written as an absent key, and a file with
 * nothing to say is removed, so "no entries" has one representation on disk.
 */
export async function writeRoleEntries(
  entries: RoleEntries,
  configPath = getGlobalConfigPath(),
): Promise<RoleEntriesSaveResult> {
  const path = getRoleEntriesPath(configPath);
  const previous = await previousState(path);
  if (previous.kind === "invalid") return "unknown-state";
  const present = OPTIONAL_ROLE_FAMILIES.filter((family) => entries[family].length > 0);
  const payload = {
    schemaVersion: ROLE_ENTRIES_SCHEMA_VERSION,
    ...Object.fromEntries(present.map((family) => [family, entries[family].map(copyEntry)])),
  };
  const accepted = parseRoleEntries(payload);
  if (!accepted) return "failed";
  if (!present.length) {
    if (previous.kind === "absent") return "unchanged";
    try {
      await rm(path, { force: true });
      return "saved";
    } catch {
      return "failed";
    }
  }
  if (previous.kind === "entries" && sameRoleEntries(previous.entries, accepted))
    return "unchanged";
  // What this reader accepted, not the payload it was handed: a range whose bounds are equal is
  // stored as the single level it means, so the file never holds a form the normaliser would change.
  const text = `${JSON.stringify(
    {
      schemaVersion: ROLE_ENTRIES_SCHEMA_VERSION,
      ...Object.fromEntries(present.map((family) => [family, accepted[family]])),
    },
    null,
    2,
  )}\n`;
  try {
    await atomicWrite(path, text);
    return "saved";
  } catch {
    return "failed";
  }
}

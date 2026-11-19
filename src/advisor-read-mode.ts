import { readFile, rm } from "node:fs/promises";
import { atomicWrite, getGlobalConfigPath, isAbsentPathError } from "./config.ts";
import { MAX_ADVISORS } from "./types.ts";

/**
 * Which Advisors may open the files their brief names. It lives in its own versioned file because the
 * policy document rejects unknown keys, and because a per-Advisor switch does not belong to the model
 * reference the document already stores. Reading is a capability change on a profile whose input is
 * untrusted, so it is off until the user turns it on for a slot.
 */
export const ADVISOR_READ_SCHEMA_VERSION = 1;
const INVALID_MESSAGE =
  "Advisor reading settings are invalid and were ignored; no Advisor may open files. Fix or remove delegation-policy.advisor-read.json.";

export type AdvisorRead = boolean[];

export function emptyAdvisorRead(): AdvisorRead {
  return [];
}

export function getAdvisorReadPath(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.advisor-read.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict: `{schemaVersion: 1, read: [boolean, …]}` with at most one flag per Advisor slot. */
export function parseAdvisorRead(value: unknown): AdvisorRead | undefined {
  if (!isRecord(value) || value.schemaVersion !== ADVISOR_READ_SCHEMA_VERSION) return undefined;
  if (!Object.keys(value).every((key) => key === "schemaVersion" || key === "read"))
    return undefined;
  if (value.read === undefined) return emptyAdvisorRead();
  if (!Array.isArray(value.read) || value.read.length > MAX_ADVISORS) return undefined;
  if (!value.read.every((flag) => typeof flag === "boolean")) return undefined;
  return [...(value.read as boolean[])];
}

export type LoadedAdvisorRead = { read: AdvisorRead; invalid: boolean };

export async function readAdvisorRead(
  configPath = getGlobalConfigPath(),
): Promise<LoadedAdvisorRead> {
  let text: string;
  try {
    text = await readFile(getAdvisorReadPath(configPath), "utf8");
  } catch (error) {
    return isAbsentPathError(error)
      ? { read: emptyAdvisorRead(), invalid: false }
      : { read: emptyAdvisorRead(), invalid: true };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { read: emptyAdvisorRead(), invalid: true };
  }
  const read = parseAdvisorRead(value);
  return read ? { read, invalid: false } : { read: emptyAdvisorRead(), invalid: true };
}

export type AdvisorReadSaveResult = "saved" | "unchanged" | "unknown-state" | "failed";

async function previous(path: string): Promise<"absent" | "invalid" | AdvisorRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return isAbsentPathError(error) ? "absent" : "invalid";
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "invalid";
  }
  return parseAdvisorRead(value) ?? "invalid";
}

/**
 * The flags as they are stored: holes become `false`, trailing offs are dropped so "no Advisor reads"
 * has one representation on disk, and no more flags than there are Advisor slots are kept.
 */
export function trimAdvisorRead(read: readonly (boolean | undefined)[]): AdvisorRead {
  const filled = Array.from({ length: read.length }, (_, index) => read[index] === true);
  while (filled.length && filled[filled.length - 1] === false) filled.pop();
  return filled.slice(0, MAX_ADVISORS);
}

/**
 * Store the flags. A file this writer cannot read is reported instead of replaced.
 */
export async function writeAdvisorRead(
  read: AdvisorRead,
  configPath = getGlobalConfigPath(),
): Promise<AdvisorReadSaveResult> {
  const path = getAdvisorReadPath(configPath);
  const current = await previous(path);
  if (current === "invalid") return "unknown-state";
  const wanted = trimAdvisorRead(read);
  if (
    current !== "absent" &&
    current.length === wanted.length &&
    current.every((flag, index) => flag === wanted[index])
  )
    return "unchanged";
  if (!wanted.length) {
    if (current === "absent") return "unchanged";
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
      `${JSON.stringify({ schemaVersion: ADVISOR_READ_SCHEMA_VERSION, read: wanted }, null, 2)}\n`,
    );
    return "saved";
  } catch {
    return "failed";
  }
}

/** True when the Advisor in this slot may open files the brief names. */
export function advisorCanRead(read: AdvisorRead | undefined, slot: number): boolean {
  return read?.[slot] === true;
}

/**
 * A flag list with no holes: a slot that was never set is `false`, so a write can never produce a
 * `null` entry its own reader rejects.
 */
export function normalizeAdvisorRead(
  read: readonly (boolean | undefined)[],
  slots: number,
): AdvisorRead {
  return Array.from(
    { length: Math.max(0, Math.min(slots, read.length)) },
    (_, index) => read[index] === true,
  );
}

export function advisorReadDiagnostic(invalid: boolean) {
  return invalid
    ? { scope: "advisor-read" as const, reportWhenOff: true, message: INVALID_MESSAGE }
    : undefined;
}

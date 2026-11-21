import { readFile, rm } from "node:fs/promises";
import { atomicWrite, getGlobalConfigPath, isAbsentPathError } from "./config.ts";
import { MAX_ADVISORS } from "./types.ts";

/**
 * Which Advisors are flagged with a provider-side cyber content filter. It lives in its own versioned
 * file because the policy document rejects unknown keys, and because the flag belongs to a slot the
 * user marked rather than to the model reference the document already stores. The extension never
 * rewrites a brief: the only effect is the wording guidance the policy gives the main agent.
 */
export const ADVISOR_FILTERS_SCHEMA_VERSION = 1;
const INVALID_MESSAGE =
  "Advisor content-filter settings are invalid and were ignored; no Advisor is flagged. Fix or remove delegation-policy.advisor-filters.json.";

export type AdvisorFilters = boolean[];

export function emptyAdvisorFilters(): AdvisorFilters {
  return [];
}

export function getAdvisorFiltersPath(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.advisor-filters.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict: `{schemaVersion: 1, cyber: [boolean, …]}` with at most one flag per Advisor slot. */
export function parseAdvisorFilters(value: unknown): AdvisorFilters | undefined {
  if (!isRecord(value) || value.schemaVersion !== ADVISOR_FILTERS_SCHEMA_VERSION) return undefined;
  if (!Object.keys(value).every((key) => key === "schemaVersion" || key === "cyber"))
    return undefined;
  if (value.cyber === undefined) return emptyAdvisorFilters();
  if (!Array.isArray(value.cyber) || value.cyber.length > MAX_ADVISORS) return undefined;
  if (!value.cyber.every((flag) => typeof flag === "boolean")) return undefined;
  return [...(value.cyber as boolean[])];
}

export type LoadedAdvisorFilters = { filters: AdvisorFilters; invalid: boolean };

export async function readAdvisorFilters(
  configPath = getGlobalConfigPath(),
): Promise<LoadedAdvisorFilters> {
  let text: string;
  try {
    text = await readFile(getAdvisorFiltersPath(configPath), "utf8");
  } catch (error) {
    return isAbsentPathError(error)
      ? { filters: emptyAdvisorFilters(), invalid: false }
      : { filters: emptyAdvisorFilters(), invalid: true };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { filters: emptyAdvisorFilters(), invalid: true };
  }
  const filters = parseAdvisorFilters(value);
  return filters ? { filters, invalid: false } : { filters: emptyAdvisorFilters(), invalid: true };
}

export type AdvisorFilterSaveResult = "saved" | "unchanged" | "unknown-state" | "failed";

async function previous(path: string): Promise<"absent" | "invalid" | AdvisorFilters> {
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
  return parseAdvisorFilters(value) ?? "invalid";
}

/**
 * The flags as they are stored: holes become `false`, trailing offs are dropped so "no Advisor is
 * flagged" has one representation on disk, and no more flags than there are Advisor slots are kept.
 */
export function trimAdvisorFilter(filters: readonly (boolean | undefined)[]): AdvisorFilters {
  const filled = Array.from({ length: filters.length }, (_, index) => filters[index] === true);
  while (filled.length && filled[filled.length - 1] === false) filled.pop();
  return filled.slice(0, MAX_ADVISORS);
}

/** Store the flags. A file this writer cannot read is reported instead of replaced. */
export async function writeAdvisorFilters(
  filters: AdvisorFilters,
  configPath = getGlobalConfigPath(),
): Promise<AdvisorFilterSaveResult> {
  const path = getAdvisorFiltersPath(configPath);
  const current = await previous(path);
  if (current === "invalid") return "unknown-state";
  const wanted = trimAdvisorFilter(filters);
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
      `${JSON.stringify({ schemaVersion: ADVISOR_FILTERS_SCHEMA_VERSION, cyber: wanted }, null, 2)}\n`,
    );
    return "saved";
  } catch {
    return "failed";
  }
}

/** True when the user flagged the Advisor in this slot with a cyber content filter. */
export function advisorFiltered(filters: AdvisorFilters | undefined, slot: number): boolean {
  return filters?.[slot] === true;
}

/**
 * A flag list with no holes: a slot that was never set is `false`, so a write can never produce a
 * `null` entry its own reader rejects.
 */
export function normalizeAdvisorFilter(
  filters: readonly (boolean | undefined)[],
  slots: number,
): AdvisorFilters {
  return Array.from(
    { length: Math.max(0, Math.min(slots, filters.length)) },
    (_, index) => filters[index] === true,
  );
}

export function advisorFilterDiagnostic(invalid: boolean) {
  return invalid
    ? { scope: "advisor-filters" as const, reportWhenOff: true, message: INVALID_MESSAGE }
    : undefined;
}

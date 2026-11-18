import { readFile } from "node:fs/promises";
import {
  atomicWrite,
  getGlobalConfigPath,
  isAbsentPathError,
  type ConfigDiagnostic,
} from "./config.ts";

/**
 * How the launch check treats a call it can correct unambiguously. `block` is a measurement mode:
 * it keeps the pre-correction behaviour and refuses instead, so the original refusal rate can be
 * observed without changing anything else.
 *
 * The setting lives in its own versioned file because the schema-10 policy document rejects unknown
 * keys, so a new key there would need a schema bump for a mode that exists to measure the old
 * behaviour. The native panel edits it as a global setting, and the default is the normal behaviour.
 */
export const LAUNCH_CORRECTION_MODES = ["correct", "block"] as const;
export type LaunchCorrectionMode = (typeof LAUNCH_CORRECTION_MODES)[number];
export const DEFAULT_LAUNCH_CORRECTION_MODE: LaunchCorrectionMode = "correct";
const SCHEMA_VERSION = 1;
const INVALID_MESSAGE =
  "Launch correction mode is invalid and was ignored; the launch check corrects unambiguous calls. Fix or remove delegation-policy.launch-correction.json.";

export function getLaunchCorrectionPath(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.launch-correction.json`;
}

export function parseLaunchCorrectionMode(value: unknown): LaunchCorrectionMode | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (!Object.keys(record).every((key) => key === "schemaVersion" || key === "mode"))
    return undefined;
  return LAUNCH_CORRECTION_MODES.includes(record.mode as LaunchCorrectionMode)
    ? (record.mode as LaunchCorrectionMode)
    : undefined;
}

export type LoadedLaunchCorrection = {
  mode: LaunchCorrectionMode;
  diagnostic?: ConfigDiagnostic;
};
/**
 * `unknown-state` means the file holds something this reader cannot parse, so it was left alone:
 * an unknown state is never silently replaced. `failed` means the replacement did not commit.
 */
export type LaunchCorrectionSaveResult = "saved" | "unchanged" | "unknown-state" | "failed";
type PreviousMode =
  { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; mode: LaunchCorrectionMode };

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
  const mode = parseLaunchCorrectionMode(value);
  return mode ? { kind: "valid", mode } : { kind: "invalid" };
}

/**
 * Store the mode in its own file. The previous state is read first, so an unreadable or malformed
 * file is reported instead of overwritten. The replacement is the same temporary-file write the
 * global defaults use, so a failure leaves the previous file in place.
 */
export async function writeLaunchCorrectionMode(
  mode: LaunchCorrectionMode,
  path = getLaunchCorrectionPath(),
): Promise<LaunchCorrectionSaveResult> {
  const previous = await readPreviousMode(path);
  if (previous.kind === "invalid") return "unknown-state";
  if (previous.kind === "valid" && previous.mode === mode) return "unchanged";
  try {
    await atomicWrite(
      path,
      `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, mode }, null, 2)}\n`,
    );
  } catch {
    return "failed";
  }
  return "saved";
}

/** A missing file is the default; an unreadable or invalid one is reported and ignored. */
export async function readLaunchCorrectionMode(
  path = getLaunchCorrectionPath(),
): Promise<LoadedLaunchCorrection> {
  const invalid: LoadedLaunchCorrection = {
    mode: DEFAULT_LAUNCH_CORRECTION_MODE,
    diagnostic: { scope: "launch-correction", reportWhenOff: true, message: INVALID_MESSAGE },
  };
  try {
    const mode = parseLaunchCorrectionMode(JSON.parse(await readFile(path, "utf8")));
    return mode ? { mode } : invalid;
  } catch (error) {
    return isAbsentPathError(error) ? { mode: DEFAULT_LAUNCH_CORRECTION_MODE } : invalid;
  }
}

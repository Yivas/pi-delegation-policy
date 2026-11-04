import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { atomicWrite, type ConfigDiagnostic, getGlobalConfigPath } from "./config.ts";
import { isProviderPackage, type ProviderPackage } from "./provider-package.ts";

/**
 * Provider id → the one user package admitted to supply it inside an Advisor child. The child only
 * knows its own model and cannot read the parent's session, so an admission is global and per
 * provider: every Advisor of that provider uses it. Anthropic keeps its own opt-in.
 */
export type ProviderAdmissions = Record<string, ProviderPackage>;
export type LoadedAdmissions = { admissions: ProviderAdmissions; diagnostic?: ConfigDiagnostic };

const SCHEMA_VERSION = 1;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const RESERVED_PROVIDER = "anthropic";
const INVALID_MESSAGE =
  "Provider extension admissions are invalid and were ignored. Re-select the provider extension in /delegate.";

/** Own entries only: a provider id such as `constructor` must never resolve through the prototype. */
export function admissionFor(
  admissions: ProviderAdmissions,
  provider: string,
): ProviderPackage | undefined {
  return provider !== RESERVED_PROVIDER && Object.hasOwn(admissions, provider)
    ? admissions[provider]
    : undefined;
}

export function getProviderAdmissionsPath(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.provider-extensions.json`;
}

export function parseProviderAdmissions(value: unknown): ProviderAdmissions | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== SCHEMA_VERSION ||
    !Object.keys(record).every((key) => key === "schemaVersion" || key === "providers") ||
    typeof record.providers !== "object" ||
    record.providers === null ||
    Array.isArray(record.providers)
  )
    return undefined;
  const admissions: ProviderAdmissions = {};
  for (const [provider, pkg] of Object.entries(record.providers)) {
    if (!PROVIDER_ID.test(provider) || provider === RESERVED_PROVIDER || !isProviderPackage(pkg))
      return undefined;
    admissions[provider] = { package: pkg.package, version: pkg.version };
  }
  return admissions;
}

/** A missing file means no admissions; an unreadable or invalid one is ignored and reported. */
export async function readProviderAdmissions(
  path = getProviderAdmissionsPath(),
): Promise<LoadedAdmissions> {
  try {
    const admissions = parseProviderAdmissions(JSON.parse(await readFile(path, "utf8")));
    return admissions
      ? { admissions }
      : {
          admissions: {},
          diagnostic: { scope: "advisor-extension", reportWhenOff: true, message: INVALID_MESSAGE },
        };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { admissions: {} }
      : {
          admissions: {},
          diagnostic: { scope: "advisor-extension", reportWhenOff: true, message: INVALID_MESSAGE },
        };
  }
}

export async function writeProviderAdmissions(
  admissions: ProviderAdmissions,
  path = getProviderAdmissionsPath(),
): Promise<void> {
  const providers = Object.fromEntries(
    Object.entries(admissions).sort(([left], [right]) => left.localeCompare(right)),
  );
  await atomicWrite(
    path,
    `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, providers }, null, 2)}\n`,
  );
}

export function sameAdmissions(left: ProviderAdmissions, right: ProviderAdmissions): boolean {
  return isDeepStrictEqual(
    Object.entries(left).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(right).sort(([a], [b]) => a.localeCompare(b)),
  );
}

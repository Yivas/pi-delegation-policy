import { readFile } from "node:fs/promises";
import { getGlobalConfigPath, isAbsentPathError, type ConfigDiagnostic } from "./config.ts";
import {
  isProviderPackage,
  locateInstalledPackage,
  packageSource,
  type ProviderPackage,
} from "./provider-package.ts";

/**
 * Extensions the operator adds to every Advisor child, on top of the packaged profile's own set.
 *
 * The profile's frontmatter is static, so an operator who wants a personal extension inside the
 * Advisor child cannot express it there. This file names those packages, the host loads them for the
 * session, and the launch contract accepts exactly the ids registered here. Admission is as strict
 * as the one for provider extensions: exact `package@version`, present in the user's own settings and
 * installed by Pi. Anything else is ignored with a diagnostic.
 *
 * The extra extension runs as trusted host code in the child and can shape its prompt. That is the
 * point of the setting and also its risk.
 */
export type AdvisorExtension = { id: string; path: string };

export type LoadedAdvisorExtensions = {
  extensions: AdvisorExtension[];
  diagnostic?: ConfigDiagnostic;
};

const SCHEMA_VERSION = 1;
/** Two is enough for a prompt layer and a provider shim, and keeps the child surface small. */
const MAX_EXTENSIONS = 2;
const INVALID_MESSAGE =
  "Advisor child extensions are invalid and were ignored. Fix delegation-policy.advisor-extensions.json or remove it.";

export function getAdvisorExtensionsPath(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.advisor-extensions.json`;
}

/** Strict shape: a short list of exact packages, nothing else. */
export function parseAdvisorExtensions(value: unknown): ProviderPackage[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== SCHEMA_VERSION ||
    !Object.keys(record).every((key) => key === "schemaVersion" || key === "extensions") ||
    !Array.isArray(record.extensions) ||
    record.extensions.length > MAX_EXTENSIONS
  )
    return undefined;
  const packages: ProviderPackage[] = [];
  for (const entry of record.extensions) {
    if (!isProviderPackage(entry)) return undefined;
    const duplicate = packages.some(
      (other) => other.package === entry.package && other.version === entry.version,
    );
    if (duplicate) return undefined;
    packages.push({ package: entry.package, version: entry.version });
  }
  return packages;
}

/**
 * A missing file means no extra extensions. An invalid one, or a package that is not installed and
 * admitted by the user, is ignored and reported: the Advisor still launches, without the layer.
 */
export async function readAdvisorExtensions(
  cwd: string,
  path = getAdvisorExtensionsPath(),
): Promise<LoadedAdvisorExtensions> {
  let packages: ProviderPackage[] | undefined;
  try {
    packages = parseAdvisorExtensions(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isAbsentPathError(error)) return { extensions: [] };
    return {
      extensions: [],
      diagnostic: { scope: "advisor-extension", reportWhenOff: true, message: INVALID_MESSAGE },
    };
  }
  if (!packages)
    return {
      extensions: [],
      diagnostic: { scope: "advisor-extension", reportWhenOff: true, message: INVALID_MESSAGE },
    };
  const extensions: AdvisorExtension[] = [];
  for (const pkg of packages) {
    const location = locateInstalledPackage(cwd, pkg, { configured: true });
    if (!location.ok)
      return {
        extensions: [],
        diagnostic: {
          scope: "advisor-extension",
          reportWhenOff: true,
          message: `Advisor child extension ${packageSource(pkg)} is not installed and configured as admitted; it was ignored.`,
        },
      };
    extensions.push({ id: childExtensionId(extensions.length + 1), path: location.entry });
  }
  return { extensions };
}

/**
 * The host accepts a short opaque id: letters, digits, dot, dash and underscore, at most 128
 * characters. The package name is not a valid id, so position is the only stable label left.
 */
export function childExtensionId(position: number): string {
  return `child-ext-${position}`;
}

/**
 * The session's registered list, read by the launch contract. It stays empty until the host accepts
 * the registration, so a launch never expects an id the child will not load.
 */
let required: readonly AdvisorExtension[] = [];

export function setAdvisorChildExtensions(extensions: readonly AdvisorExtension[]): void {
  required = extensions;
}

export function sessionChildExtensions(): readonly AdvisorExtension[] {
  return required;
}

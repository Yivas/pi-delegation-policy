import * as sdk from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** An npm package pinned to one exact version. */
export type ProviderPackage = { package: string; version: string };
export type PackageLocation = { ok: true; entry: string } | { ok: false };

// Bare or scoped npm names only: anything else could turn the name into a path outside node_modules.
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const UNAVAILABLE: PackageLocation = { ok: false };

export function isProviderPackage(value: unknown): value is ProviderPackage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === "package" || key === "version") &&
    typeof record.package === "string" &&
    PACKAGE_NAME.test(record.package) &&
    typeof record.version === "string" &&
    EXACT_VERSION.test(record.version)
  );
}

export function packageSource(pkg: ProviderPackage): string {
  return `npm:${pkg.package}@${pkg.version}`;
}

/**
 * Exact user sources from the user's own settings. Project settings are never trusted here, and
 * this manager is used only for listing: with an untrusted project it refuses project paths.
 */
function configuredUserPackages(cwd: string, agentDir: string): Array<{ source: string }> {
  const manager = new sdk.DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
  });
  if (typeof manager.listConfiguredPackages !== "function") return [];
  return manager
    .listConfiguredPackages()
    .filter((entry) => entry.scope === "user" && !entry.filtered);
}

function hasPublicPackageApis(): boolean {
  return (
    typeof sdk.DefaultPackageManager === "function" &&
    typeof sdk.SettingsManager?.inMemory === "function" &&
    typeof sdk.SettingsManager?.create === "function" &&
    typeof sdk.getAgentDir === "function"
  );
}

/**
 * Metadata only: never imports, configures or installs the package. It accepts exactly the
 * managed user install of `npm:<package>@<version>`, with no project candidate, no links and one
 * declared extension entry inside the package. With `configured`, the user's own settings must
 * also list that exact source unfiltered, so a file the model can write cannot admit code the user
 * never chose to load.
 */
export function locateInstalledPackage(
  cwd: string,
  pkg: ProviderPackage,
  options: { expectedEntry?: string; configured?: boolean } = {},
): PackageLocation {
  try {
    if (!isProviderPackage(pkg) || !hasPublicPackageApis()) return UNAVAILABLE;
    const agentDir = sdk.getAgentDir();
    const expected = resolve(agentDir, "npm/node_modules", pkg.package);
    // A missing managed install must not trigger the package manager's legacy fallback.
    if (!existsSync(expected)) return UNAVAILABLE;
    const manager = new sdk.DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: sdk.SettingsManager.inMemory({}),
    });
    if (typeof manager.getInstalledPath !== "function") return UNAVAILABLE;
    const source = packageSource(pkg);
    const selected = manager.getInstalledPath(source, "user");
    if (!selected || resolve(selected) !== expected || manager.getInstalledPath(source, "project"))
      return UNAVAILABLE;
    if (
      options.configured &&
      !configuredUserPackages(cwd, agentDir).some((entry) => entry.source === source)
    )
      return UNAVAILABLE;
    if (realpathSync(expected) !== expected) return UNAVAILABLE;
    const manifest = JSON.parse(readFileSync(resolve(expected, "package.json"), "utf8"));
    const extensions: unknown = manifest?.pi?.extensions;
    if (
      manifest.name !== pkg.package ||
      manifest.version !== pkg.version ||
      !Array.isArray(extensions) ||
      extensions.length !== 1 ||
      typeof extensions[0] !== "string" ||
      (options.expectedEntry !== undefined && extensions[0] !== options.expectedEntry)
    )
      return UNAVAILABLE;
    const entry = resolve(expected, extensions[0]);
    const inside = relative(expected, entry);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) return UNAVAILABLE;
    return realpathSync(entry) === entry ? { ok: true, entry } : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

/** `npm:<name>@<version>`, scoped or bare; anything else is not a pinned npm source. */
function parsePinnedNpmSource(source: string): ProviderPackage | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice(4);
  const at = spec.lastIndexOf("@");
  if (at <= 0) return undefined;
  const pkg = { package: spec.slice(0, at), version: spec.slice(at + 1) };
  return isProviderPackage(pkg) ? pkg : undefined;
}

/**
 * User packages the panel may offer as a provider extension. Each candidate passes the same
 * identity check the Advisor child repeats before loading it; whether it registers the Advisor's
 * provider is only known once loaded, so this is a list of candidates, not of providers.
 */
export function listProviderExtensionCandidates(
  cwd: string,
  excluded: readonly string[],
): ProviderPackage[] {
  try {
    if (!hasPublicPackageApis()) return [];
    return configuredUserPackages(cwd, sdk.getAgentDir()).flatMap((entry) => {
      const pkg = parsePinnedNpmSource(entry.source);
      return pkg &&
        !excluded.includes(pkg.package) &&
        locateInstalledPackage(cwd, pkg, { configured: true }).ok
        ? [pkg]
        : [];
    });
  } catch {
    return [];
  }
}

import * as sdk from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** The root of the running package, the base every packaged profile path is relative to. */
export const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** An npm package pinned to one exact version. */
export type ProviderPackage = { package: string; version: string };
export type PackageLocation = { ok: true; entry: string } | { ok: false };
/** A sibling package that a packaged profile can load, or why it cannot. */
export type SiblingLocation = { ok: true; entry: string } | { ok: false; message: string };

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
 * The literal a packaged profile declares for its single provider package. A relative entry is
 * resolved against the directory of the agent file, so `../..` from `agents/` is the directory the
 * package itself is installed in.
 */
export function siblingExtensionEntry(pkg: string): string {
  return `../../${pkg}`;
}

/** The absolute path that literal resolves to, from the profile file the host parses. */
export function siblingExtensionPath(agentPath: string, pkg: string): string {
  return resolve(dirname(agentPath), siblingExtensionEntry(pkg));
}

/** The package name of an `npm:<name>@<anything>` user source, or undefined for any other source. */
function npmSourceName(source: string): string | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice(4);
  const at = spec.indexOf("@", 1);
  const name = at <= 0 ? spec : spec.slice(0, at);
  return PACKAGE_NAME.test(name) ? name : undefined;
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

/** The real path of an existing path, or the path itself when it cannot be resolved. */
function realPathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Two paths as the running filesystem sees them: equal up to case only where paths are
 * case-insensitive, so a differently capitalised agent directory is the same directory and a link
 * is not.
 */
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Whether the installed sibling a packaged profile names can actually be loaded: it is the managed
 * user install, it is not a link, it declares exactly one extension entry inside itself and your own
 * settings list that package. Version and content are not checked, by decision: the profile loads
 * the installed package, so a provider update no longer waits for a release of this one. The message
 * carries the one cause that failed, because each cause has a different remedy.
 */
export function locateSiblingPackage(
  cwd: string,
  pluginRoot: string,
  pkg: string,
  options: { configured?: boolean } = {},
): SiblingLocation {
  try {
    if (!PACKAGE_NAME.test(pkg) || !hasPublicPackageApis())
      return { ok: false, message: `"${pkg}" cannot be checked as an installed package here` };
    const agentDir = sdk.getAgentDir();
    const modules = resolve(agentDir, "npm/node_modules");
    const managed = resolve(modules, pkg);
    // The profile resolves its entry against the directory of the agent file, so a package that is
    // not installed there (a checkout, a project install, git) points somewhere else entirely. Both
    // sides are compared as real paths, because the agent directory or a segment of it may itself be
    // reached through a link, and case-sensitively only where the filesystem is.
    const declared = resolve(realPathOr(resolve(pluginRoot, "..")), pkg);
    if (!samePath(declared, resolve(realPathOr(modules), pkg)))
      return {
        ok: false,
        message: `the packaged profile resolves "${pkg}" relative to the file it is installed as, and that path cannot be confirmed as Pi's managed user package (${modules}); install it as a user package, or the profile cannot load that provider extension`,
      };
    if (!existsSync(managed))
      return {
        ok: false,
        message: `"${pkg}" cannot be confirmed as installed in ${modules}; install it as a user package so the packaged profile can load it`,
      };
    if (!samePath(realPathOr(managed), managed))
      return {
        ok: false,
        message: `"${pkg}" cannot be confirmed as the installed package: the path resolves through a link; install it as a user package so the profile loads the code the parent checks`,
      };
    const manifest = JSON.parse(readFileSync(resolve(managed, "package.json"), "utf8"));
    if (manifest.name !== pkg)
      return {
        ok: false,
        message: `the package installed as "${pkg}" reports another name in its manifest, so the packaged profile will not load it`,
      };
    const extensions: unknown = manifest?.pi?.extensions;
    if (!Array.isArray(extensions) || extensions.length !== 1 || typeof extensions[0] !== "string")
      return {
        ok: false,
        message: `the installed "${pkg}" does not declare exactly one extension entry, so the packaged profile will not load it`,
      };
    const entry = resolve(managed, extensions[0]);
    const inside = relative(managed, entry);
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      return {
        ok: false,
        message: `the installed "${pkg}" declares its entry outside its own directory, so the packaged profile will not load it`,
      };
    if (!samePath(realPathOr(entry), entry))
      return {
        ok: false,
        message: `the entry of "${pkg}" cannot be confirmed as a file inside the package, so the packaged profile will not load it`,
      };
    if (
      options.configured &&
      !configuredUserPackages(cwd, agentDir).some(
        (configured) => npmSourceName(configured.source) === pkg,
      )
    )
      return {
        ok: false,
        message: `"${pkg}" is installed but your Pi settings do not list it; add it as a user package so only code you chose runs in the child`,
      };
    return { ok: true, entry };
  } catch {
    return { ok: false, message: `"${pkg}" cannot be read as an installed package` };
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
 * identity check the parent applies before pinning it; whether it registers the Advisor's provider
 * is only known once loaded, so this is a list of candidates, not of providers.
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

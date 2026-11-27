/**
 * The packaged profiles that load a provider extension the review admitted, and the one table that
 * maps a provider to them.
 *
 * The child resolves its model and its provider before any extension `session_start` runs, so a
 * loader inside the child can never register a provider in time. The host therefore loads the
 * reviewed package itself, because each profile names it in `subagentOnlyExtensions` by the relative
 * path that resolves to the installed sibling. The checks that remain live are in the parent: the
 * admission is validated when it is written and when an Advisor is routed to this profile, and the
 * sibling identity is checked for every launch that needs the package. The child has no equivalent
 * check, and nothing in this module may claim one.
 */
export const PROVIDER_EXTENSION_ADVISOR_AGENT = "pi-delegation-policy.advisor-provider-extension";

/**
 * The packages the review covered, one profile each, and the single tool of each one that could
 * reach a model. The review covered what the package registers as a whole — tool, commands, events
 * and provider — and `tool` names the one capability that could reach a model. No runtime check
 * reads `tool`, because the child cannot inspect the loaded package. What keeps it away from the
 * model is each profile's explicit tool allowlist. A static frontmatter can name only one package,
 * so a second package needs its own profile and its own review.
 *
 * There is no version here on purpose: the profiles load whatever is installed, and the parent
 * checks the installed identity instead. That is what keeps a provider update from requiring a
 * release of this package.
 */
export const KNOWN_TOOL_SURFACE = [
  {
    provider: "antigravity-acp",
    package: "pi-antigravity-acp-provider",
    tool: "antigravity_acp_permission",
    executionAgent: "pi-delegation-policy.execution-antigravity-acp",
    readerAgent: "pi-delegation-policy.reader-antigravity-acp",
  },
] as const;

export type ReviewedPackage = (typeof KNOWN_TOOL_SURFACE)[number];

/** Which packaged profile a launch runs: the writing one or the read-only one. */
export type PackagedProfileKind = "execution" | "reader";

/** One packaged profile, the reviewed package it loads, and the kind of work it allows. */
export type PackagedProfile = {
  agent: string;
  kind: PackagedProfileKind;
  reviewed: ReviewedPackage;
};

/**
 * Every packaged profile this release ships, whichever provider serves the model. A launch that names
 * one of these is checked against the provider it serves, because `subagentOnlyExtensions` is static
 * frontmatter: the package loads whether or not the model needed it.
 */
export const PACKAGED_PROFILES: readonly PackagedProfile[] = KNOWN_TOOL_SURFACE.flatMap(
  (reviewed) => [
    { agent: reviewed.executionAgent, kind: "execution" as const, reviewed },
    { agent: reviewed.readerAgent, kind: "reader" as const, reviewed },
  ],
);

/** The packaged profile a call names, or undefined when the name is not one of ours. */
export function packagedProfileFor(agent: string): PackagedProfile | undefined {
  return PACKAGED_PROFILES.find((profile) => profile.agent === agent);
}

/** The reviewed package the Advisor profile that loads a provider extension serves. */
export const REVIEWED_PACKAGE = KNOWN_TOOL_SURFACE[0];

/** The reviewed package that serves a provider id, or undefined when this release has none. */
export function reviewedPackageFor(provider: string): ReviewedPackage | undefined {
  return KNOWN_TOOL_SURFACE.find((entry) => entry.provider === provider);
}

/**
 * True when an admission names a reviewed package. The version is not compared: the profile loads
 * the installed package, so an update no longer needs a release of this one. What the admission
 * still selects is the package, which is what the review covered.
 */
export function isPackagedAdmission(admitted: { package: string; version: string }): boolean {
  return admitted.package === REVIEWED_PACKAGE.package;
}

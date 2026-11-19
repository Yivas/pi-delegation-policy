/**
 * The packaged profile an Advisor runs in when its model is served by a provider extension the
 * operator admitted.
 *
 * The child resolves its model and its provider before any extension `session_start` runs, so a
 * loader inside the child can never register a provider in time. The host therefore loads the
 * admitted package itself, because the packaged profile pins it in `subagentOnlyExtensions`. The
 * checks that remain live are in the parent: the admission is validated when it is written and when
 * an Advisor is routed to this profile. The child has no equivalent check, and nothing in this
 * module may claim one.
 */
export const PROVIDER_EXTENSION_ADVISOR_AGENT = "pi-delegation-policy.advisor-provider-extension";

/**
 * The one package the packaged profile pins, and the single tool whose registration was reviewed for
 * it. The tool field records what that review covered: no runtime check reads it, because the child
 * cannot inspect the loaded package. What keeps the tool away from the model is the empty tool
 * allowlist in the profile. A static frontmatter can pin only one package, so a second admitted
 * package needs its own profile and its own review.
 */
export const KNOWN_TOOL_SURFACE = [
  { package: "pi-antigravity-acp-provider", version: "0.1.21", tool: "antigravity_acp_permission" },
] as const;

/** The admitted package the packaged profile can serve. */
export const PINNED_PACKAGE = KNOWN_TOOL_SURFACE[0];

/** True when an admission names exactly the package the packaged profile pins. */
export function isPinnedAdmission(admitted: { package: string; version: string }): boolean {
  return admitted.package === PINNED_PACKAGE.package && admitted.version === PINNED_PACKAGE.version;
}

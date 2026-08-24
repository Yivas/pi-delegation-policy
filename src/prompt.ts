import {
  activeCategories,
  assignmentDisplay,
  assignmentFor,
  type RuntimeState,
} from "./runtime.ts";

const NORMAL_POLICY =
  "Delegate work when it materially reduces effort without losing essential context. Favor delegation for substantial research, broad exploration, independent searches, bounded implementation, tests, checks, documentation, and parallelizable work. Keep architecture, global strategy, coordination, integration, important review, and difficult blockers in the main agent. Do not delegate trivial work merely to create an agent.";
const AGGRESSIVE_POLICY =
  "Act primarily as architect, coordinator, integrator, and final reviewer. By default, delegate substantial work that can be isolated with a clear objective and acceptance criteria. Look for independent research, broad exploration, self-contained implementation, tests, and validation. Keep global decisions, strategy, integration, final review, and context that is costly or risky to transfer in the main agent.";

export function buildDelegationPolicy(state: RuntimeState): string | undefined {
  if (state.effective.mode === "off") return undefined;
  const preset = state.effective.preset;
  if (!preset) {
    return "<delegation_policy>\nDelegation disabled: no active preset is configured.\n</delegation_policy>";
  }
  if (!preset.skill || !state.skillFiles.has(preset.skill)) {
    return `<delegation_policy>\nDelegation disabled: the configured external skill ${preset.skill ? `"${preset.skill}"` : "(none)"} is not available. Configure a discovered skill before delegating.\n</delegation_policy>`;
  }
  if (state.diagnostics.length > 0 || state.runtimeErrors.length > 0) {
    const details = state.runtimeErrors.join("; ") || "invalid runtime configuration";
    return `<delegation_policy>\nDelegation disabled: configured delegation assignments are unavailable. ${details}\n</delegation_policy>`;
  }
  const categories = activeCategories(state)
    .map((category) => {
      const assignment = assignmentFor(state, category as never);
      return `- ${category}: ${assignmentDisplay(state, category, assignment)}`;
    })
    .join("\n");
  const modeText = state.effective.mode === "normal" ? NORMAL_POLICY : AGGRESSIVE_POLICY;
  const uiDesign = categories.includes("ui-design")
    ? " ui-design is visual design only: do not implement the interface."
    : "";
  return `<delegation_policy>\nMode: ${state.effective.mode}. Strategy: ${state.effective.strategy}.\n${modeText}${uiDesign}\n\nBefore creating a subagent, load the complete external skill named "${preset.skill}" if it is not already loaded. Follow that skill's execution procedure; this extension does not create, launch, route, or manage subagents. After reading the skill, choose the category that best matches the work and use only the exact configured provider, model, and thinking assignment shown below. Do not invent fallbacks or silently switch assignments.\n\nConfigured assignments:\n${categories}\n\nCreating or updating a TODO is not delegation. Do not repeat delegated work in full; integrate it, verify a concrete point, or recover only when the result is insufficient.\n</delegation_policy>`;
}

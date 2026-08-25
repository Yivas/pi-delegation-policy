import { hasRuntimeError, type RuntimeState } from "./runtime.ts";
import type { ModelRef, Preference } from "./types.ts";

const NORMAL_POLICY =
  "Delegate substantial, bounded, and independent work when doing so reduces effort without losing essential context. Keep architecture, global strategy, coordination, integration, final review, and work whose context is costly or risky to transfer in the main agent.";
const AGGRESSIVE_POLICY =
  "Default to delegating substantial work with a clear objective and acceptance criteria. Keep global decisions, coordination, integration, final review, and work whose context is costly or risky to transfer in the main agent.";

function preferenceGuidance(preference: Preference): string {
  if (preference === "efficient") {
    return "Favor Small for routine delegated work. Medium and Large remain available when the task warrants them.";
  }
  if (preference === "intensive") {
    return "Favor Medium for substantial delegated work. Small and Large remain available when the task warrants them.";
  }
  return "Use Small for routine delegated work, Medium for planning, ambiguity, or broad synthesis, and Large only for exceptional blockers.";
}

function promptString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function formatReference(reference: ModelRef): string {
  return `provider=${promptString(reference.provider)} model=${promptString(reference.model)}`;
}

export function buildDelegationPolicy(state: RuntimeState): string | undefined {
  if (state.effective.intensity === "off" || hasRuntimeError(state)) return undefined;

  const { effective } = state;
  if (!effective.small || !effective.medium || !effective.large) return undefined;

  const intensityPolicy = effective.intensity === "normal" ? NORMAL_POLICY : AGGRESSIVE_POLICY;
  const uiDesign = effective.uiDesign
    ? `\n- UI Design: ${formatReference(effective.uiDesign)}. Use this role only for visual design direction, exploration, or review. Never use it to implement an interface, write code, or run tests.`
    : "";

  return `<delegation_policy>
Intensity: ${effective.intensity}.
${intensityPolicy}

Model preference: ${effective.preference}. ${preferenceGuidance(effective.preference)}

Use the exact provider and model for the selected role. The references below use JSON string syntax; interpret escaped characters as JSON before use. Do not invent a fallback model or role. Choose thinking dynamically for each delegation from the task, difficulty, volume, and the selected model's capabilities. Do not treat thinking as persisted configuration.

Roles:
- Small: ${formatReference(effective.small)}
- Medium: ${formatReference(effective.medium)}
- Large: ${formatReference(effective.large)}${uiDesign}

This is guidance for the main agent. It does not create, execute, route, supervise, or enforce delegated work.
</delegation_policy>`;
}

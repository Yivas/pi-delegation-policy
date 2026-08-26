import { hasRuntimeError, type RuntimeState } from "./runtime.ts";
import type { ModelRef, Preference } from "./types.ts";

const NORMAL_POLICY =
  "Delegate substantial, separable work only when the expected benefit clearly outweighs briefing, supervision, review, and integration cost. Count parallelism as a benefit only when valuable work can advance now or elapsed time matters. A merely possible fresh perspective is not enough by itself. Keep borderline work with the main agent.";
const AGGRESSIVE_POLICY =
  "Default to delegating substantial, separable, independently checkable work with a clear objective and acceptance criteria. Delegate when the benefit is plausible even if not proven, including a useful independent perspective. Keep work with the main agent when it is poorly bounded, tightly coupled, dominated by integration or final accountability, or has clearly prohibitive delegation overhead.";

const ROLE_SELECTION_POLICY = `Choose the role and thinking together from the combination of:
- task demand: execute, search, plan, decide, or unblock;
- difficulty: clarity, ambiguity, dependencies, risk, and competing hypotheses;
- quantity: files, modules, systems, sources, and context volume.
No single factor decides the role.

Use Small habitually for bounded, planned, and verifiable work: concrete searches, scoped exploration, defined implementation, focused documentation, tests, reviews, mechanical changes, evident bugs, and bounded UI implementation whose design and stack are decided. Difficult but well-defined execution can remain Small with higher thinking.

Use Medium directly when the combined demands materially require defining a plan, reducing meaningful ambiguity, broad synthesis, tracing several modules, comparing sources or options, coordinating substantial context, or making difficult decisions. These are evidence, not automatic triggers. Small does not need to fail first.

Use Large only to unblock genuinely stuck work: persistent failures, severe framework conflicts, contradictory hypotheses, or reliable prior evidence that ordinary roles have not produced a trustworthy answer. Do not require ceremonial failed attempts. Large remains exceptional.

Large quantities of repetitive, independent work favor multiple Small delegations; volume alone does not justify Medium or Large. Agent type does not determine the model role. A clearly better task fit overrides preference; preference only shifts credible Small/Medium choices.

In every intensity, keep global strategy, coordination, integration, final review, and work whose essential context is too costly or risky to transfer with the main agent.`;

function preferenceGuidance(preference: Preference): string {
  if (preference === "efficient") {
    return "Favor Small more strongly than standard. When Small can safely satisfy the acceptance criteria, choose it unless Medium provides a material advantage.";
  }
  if (preference === "intensive") {
    return "When Small and Medium are both credible, normally prefer Medium. Keep Small for work that is clearly narrow, routine, mechanical, or an especially clear Small fit.";
  }
  return "Choose Small on a genuine Small/Medium tie; otherwise follow the role-selection policy above.";
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

${ROLE_SELECTION_POLICY}

Model preference: ${effective.preference}. ${preferenceGuidance(effective.preference)}

Use the exact provider and model for the selected role. The references below use JSON string syntax; interpret escaped characters as JSON before use. Do not invent a fallback model or role. Choose thinking dynamically for each delegation from task demand, difficulty, quantity, and the selected model's capabilities. Do not treat thinking as persisted configuration.

Roles:
- Small: ${formatReference(effective.small)}
- Medium: ${formatReference(effective.medium)}
- Large: ${formatReference(effective.large)}${uiDesign}

This is guidance for the main agent. It does not create, execute, route, supervise, or enforce delegated work.
</delegation_policy>`;
}

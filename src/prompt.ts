import { hasRuntimeError, type RuntimeState } from "./runtime.ts";
import type { EffectiveDelegateState, ModelRef, Preference } from "./types.ts";

const NORMAL_POLICY =
  "Delegate substantial, separable work only when the expected benefit clearly outweighs briefing, supervision, review, and integration cost. Count parallelism as a benefit only when valuable work can advance now or elapsed time matters. A merely possible fresh perspective is not enough by itself. Keep borderline work with the main agent.";
const AGGRESSIVE_POLICY =
  "Default to delegating substantial, separable, independently checkable work with a clear objective and acceptance criteria. Delegate when the benefit is plausible even if not proven, including a useful independent perspective. Keep work with the main agent when it is poorly bounded, tightly coupled, dominated by integration or final accountability, or has clearly prohibitive delegation overhead.";

const ROLE_SELECTION_POLICY = `Choose the role by task fit before considering model preference:
- demand: execute, search, plan, decide, coordinate, or unblock;
- difficulty: clarity, ambiguity, dependencies, competing hypotheses, and risk;
- quantity: files, modules, systems, sources, and context volume;
- error and review cost: what can go wrong, how costly it is to detect, and what evidence is needed.
No single factor decides the role. Select the smallest role that can satisfy the acceptance criteria and evidence requirements.

Use Small for bounded, planned, and verifiable execution: concrete searches, scoped exploration, defined implementation, focused documentation, tests, reviews, mechanical changes, evident bugs, and bounded UI implementation whose design and stack are decided. Difficult but well-defined execution can remain Small with higher thinking.

Use Medium directly when the combined task fit materially requires planning, reducing meaningful ambiguity, broad synthesis, tracing several modules, comparing sources or options, coordinating substantial context, or making difficult decisions. Small does not need to fail first.

Use Large only to unblock genuinely stuck work: persistent failures, severe framework conflicts, contradictory hypotheses, or reliable prior evidence that ordinary roles have not produced a trustworthy answer. Do not require ceremonial failed attempts. Large remains exceptional.

Large quantities of repetitive, independent work favor multiple Small delegations; volume alone does not justify Medium or Large. Agent type does not determine the model role. Apply preference only when Small and Medium are comparably credible fits.

In every intensity, keep global strategy, coordination, integration, final review, and work whose essential context is too costly or risky to transfer with the main agent.`;

function preferenceGuidance(preference: Preference): string {
  if (preference === "efficient") {
    return "Use efficient only as a Small tie-break when Small and Medium are comparably credible. Do not choose Small when Medium is a materially better task fit.";
  }
  if (preference === "intensive") {
    return "Use intensive only as a Medium tie-break when Small and Medium are comparably credible. Do not choose Medium when Small is the clearly better task fit.";
  }
  return "Standard adds no Small or Medium bias; follow task fit.";
}

function preferencePreview(preference: Preference): string {
  if (preference === "efficient") return "efficient breaks comparable fits toward Small";
  if (preference === "intensive") return "intensive breaks comparable fits toward Medium";
  return "standard has no extra bias";
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

function formatLaunchModel(reference: ModelRef): string {
  return promptString(`${reference.provider}/${reference.model}`);
}

export function buildPolicyPreview(effective: EffectiveDelegateState): string[] {
  if (effective.intensity === "off") return ["off · no policy injected"];

  const { small, medium, large } = effective;
  if (!small) return ["active · Small not configured · no policy can be injected"];
  if (!medium) return ["active · Medium not configured · no policy can be injected"];
  if (!large) return ["active · Large not configured · no policy can be injected"];

  return [
    `${effective.intensity} · task fit first · ${preferencePreview(effective.preference)}`,
    `Small ${formatLaunchModel(small)} · Medium ${formatLaunchModel(medium)} · Large ${formatLaunchModel(large)}`,
    "Every launch must include the selected exact model; thinking stays dynamic.",
  ];
}

export function buildDelegationPolicy(state: RuntimeState): string | undefined {
  if (state.effective.intensity === "off" || hasRuntimeError(state)) return undefined;

  const { effective } = state;
  if (!effective.small || !effective.medium || !effective.large) return undefined;

  const intensityPolicy = effective.intensity === "normal" ? NORMAL_POLICY : AGGRESSIVE_POLICY;
  const uiDesign = effective.uiDesign
    ? `\n- UI Design: ${formatReference(effective.uiDesign)}; launch with model: ${formatLaunchModel(effective.uiDesign)}. Use this role only for visual design direction, exploration, or review. Never use it to implement an interface, write code, or run tests.`
    : "";

  return `<delegation_policy>
Intensity: ${effective.intensity}.
${intensityPolicy}

${ROLE_SELECTION_POLICY}

Model preference: ${effective.preference}. ${preferenceGuidance(effective.preference)}

Before every delegated launch, name the selected role, take its exact combined provider/model reference below, and include it in the call as model: "provider/model" using the JSON-escaped value shown for that role. Do not omit model, inherit an ambient launcher default, substitute another model, or invent a fallback model or role. Choose thinking dynamically for each delegation from task demand, difficulty, quantity, risk, review cost, and the selected model's capabilities. Thinking is advisory and is not persisted configuration.

Roles:
- Small: ${formatReference(effective.small)}; launch with model: ${formatLaunchModel(effective.small)}
- Medium: ${formatReference(effective.medium)}; launch with model: ${formatLaunchModel(effective.medium)}
- Large: ${formatReference(effective.large)}; launch with model: ${formatLaunchModel(effective.large)}${uiDesign}

This is guidance for the main agent. It does not create, execute, route, supervise, or enforce delegated work.
</delegation_policy>`;
}

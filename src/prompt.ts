import {
  enabledOrdinaryRoles,
  hasRuntimeError,
  isRoleDisabled,
  type RuntimeState,
} from "./runtime.ts";
import type { EffectiveDelegateState, ModelRef, ModelRole, Preference } from "./types.ts";

const NORMAL_POLICY =
  "Delegate substantial, separable work only when the expected benefit clearly outweighs briefing, supervision, review, and integration cost. Count parallelism as a benefit only when valuable work can advance now or elapsed time matters. A merely possible fresh perspective is not enough by itself. Keep borderline work with the main agent.";
const AGGRESSIVE_POLICY =
  "Default to delegating substantial, separable, independently checkable work with a clear objective and acceptance criteria. Delegate when the benefit is plausible even if not proven, including a useful independent perspective. Keep work with the main agent when it is poorly bounded, tightly coupled, dominated by integration or final accountability, or has clearly prohibitive delegation overhead.";

const ROLE_SELECTION_POLICY = `Choose the role by task fit before considering model preference:
- demand: execute, search, plan, decide, coordinate, or unblock;
- difficulty: clarity, ambiguity, dependencies, competing hypotheses, and risk;
- quantity: files, modules, systems, sources, and context volume;
- error and review cost: what can go wrong, how costly it is to detect, and what evidence is needed.
No single factor decides the role. First remove disabled roles, then discard enabled roles that cannot satisfy the acceptance criteria and evidence requirements. Select the least costly remaining role that can satisfy them. Keep the work with the main agent if no enabled role can satisfy them.

Use Small for bounded, planned, and verifiable execution: concrete searches, scoped exploration, defined implementation, focused documentation, tests, reviews, mechanical changes, evident bugs, and bounded UI implementation whose design and stack are decided. Difficult but well-defined execution can remain Small with higher thinking.

Use Medium directly when the combined task fit materially requires planning, reducing meaningful ambiguity, broad synthesis, tracing several modules, comparing sources or options, coordinating substantial context, or making difficult decisions. Small does not need to fail first.

When Small and Medium are enabled alternatives, use Large only to unblock genuinely stuck work: persistent failures, severe framework conflicts, contradictory hypotheses, or reliable prior evidence that ordinary roles have not produced a trustworthy answer. Do not require ceremonial failed attempts. Large remains exceptional in a complete ordinary-role configuration.

A more capable enabled role may cover work normally suited to a disabled role only when it can satisfy the same acceptance and evidence. Never choose a less capable role merely because it is the only enabled role. Large quantities of repetitive, independent work favor multiple Small delegations; volume alone does not justify Medium or Large. Agent type does not determine the model role. Apply preference only when Small and Medium are comparably credible fits. That tie-break applies only when both are enabled.

In every intensity, keep global strategy, coordination, integration, final review, and work whose essential context is too costly or risky to transfer with the main agent.`;

const VISUAL_DESIGN_POLICY = `Visual Design is an optional specialist role. Use it only when all four conditions hold:
1. the primary acceptance criterion is a visual or user-experience result;
2. product behavior and data contracts are already defined and remain unchanged;
3. the patch is bounded to an identifiable surface, component, or set of assets;
4. it requires no business logic, data flow, APIs, routes, application architecture, tooling, or cross-system coordination.

When eligible, Visual Design may design, create, implement, and review scoped presentation code and visual assets, including layout, styles, responsive presentation, typography, images, icons, logos, SVGs, diagrams, and documentation visuals. It may address visual accessibility such as contrast and focus visibility. It must run and report the relevant existing checks for its patch.

Route interaction behavior, state, validation, semantic HTML changes, keyboard mechanics, ARIA behavior, authentication, permissions, persistence, test infrastructure, and behavior-test ownership to an enabled ordinary role that fits, or keep it with the main agent. If any eligibility condition fails, use an enabled ordinary role or split the visual portion from the broader task. The main agent retains cross-domain integration and final acceptance.`;

function hasSmallMedium(enabled: readonly ModelRole[]): boolean {
  return enabled.includes("small") && enabled.includes("medium");
}

function preferenceGuidance(preference: Preference, enabled: readonly ModelRole[]): string {
  if (!hasSmallMedium(enabled)) {
    return `${preference} is inactive because Small or Medium is disabled.`;
  }
  if (preference === "efficient") {
    return "Use efficient only as a Small tie-break when Small and Medium are comparably credible. Do not choose Small when Medium is a materially better task fit.";
  }
  if (preference === "intensive") {
    return "Use intensive only as a Medium tie-break when Small and Medium are comparably credible. Do not choose Medium when Small is the clearly better task fit.";
  }
  return "Standard adds no Small or Medium bias; follow task fit.";
}

function preferencePreview(preference: Preference, enabled: readonly ModelRole[]): string {
  if (!hasSmallMedium(enabled)) return `${preference} inactive (Small or Medium disabled)`;
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

function formatThinkingLaunchModel(reference: ModelRef): string {
  return promptString(`${reference.provider}/${reference.model}:LEVEL`);
}

function roleName(role: ModelRole): string {
  return role[0]!.toUpperCase() + role.slice(1);
}

function rolesByState(effective: EffectiveDelegateState): {
  enabled: ModelRole[];
  disabled: ModelRole[];
  unconfigured: ModelRole[];
} {
  return {
    enabled: enabledOrdinaryRoles(effective),
    disabled: (["small", "medium", "large"] as const).filter((role) =>
      isRoleDisabled(effective[role]),
    ),
    unconfigured: (["small", "medium", "large"] as const).filter(
      (role) => effective[role] === undefined,
    ),
  };
}

export function buildPolicyPreview(effective: EffectiveDelegateState): string[] {
  if (effective.intensity === "off") return ["off · no policy injected"];

  const { enabled, disabled, unconfigured } = rolesByState(effective);
  if (unconfigured.length > 0) {
    return [`active · ${roleName(unconfigured[0]!)} not configured · no policy can be injected`];
  }
  if (enabled.length === 0)
    return ["active · no ordinary role enabled · no policy can be injected"];

  const references = enabled
    .map((role) => `${roleName(role)} ${formatLaunchModel(effective[role] as ModelRef)}`)
    .join(" · ");
  return [
    `${effective.intensity} · task fit first · ${preferencePreview(effective.preference, enabled)}`,
    `Enabled: ${enabled.map(roleName).join(", ")}${disabled.length ? ` · Disabled: ${disabled.map(roleName).join(", ")}` : ""}`,
    `${references} · exact model plus per-task thinking required; neither uses an ambient default.`,
  ];
}

export function buildDelegationPolicy(state: RuntimeState): string | undefined {
  if (state.effective.intensity === "off" || hasRuntimeError(state)) return undefined;

  const { effective } = state;
  const { enabled, disabled } = rolesByState(effective);
  if (enabled.length === 0) return undefined;

  const intensityPolicy = effective.intensity === "normal" ? NORMAL_POLICY : AGGRESSIVE_POLICY;
  const uiDesign = effective.uiDesign
    ? `\n- Visual Design: ${formatReference(effective.uiDesign)}; exact model base: ${formatLaunchModel(effective.uiDesign)}; pi-subagents form: ${formatThinkingLaunchModel(effective.uiDesign)}`
    : "";
  const roleLines = enabled
    .map((role) => {
      const reference = effective[role] as ModelRef;
      return `- ${roleName(role)}: ${formatReference(reference)}; exact model base: ${formatLaunchModel(reference)}; pi-subagents form: ${formatThinkingLaunchModel(reference)}`;
    })
    .join("\n");

  return `<delegation_policy>
Intensity: ${effective.intensity}.
${intensityPolicy}

${ROLE_SELECTION_POLICY}

Enabled ordinary roles: ${enabled.map(roleName).join(", ")}.${disabled.length ? `\nDisabled ordinary roles: ${disabled.map(roleName).join(", ")}.` : ""}

Model preference: ${effective.preference}. ${preferenceGuidance(effective.preference, enabled)}

Before every delegated launch, name the selected role and take its exact combined provider/model base below. Choose thinking dynamically for that run from task demand, difficulty, quantity, risk, review cost, and the selected model's capabilities. Then transmit both through the launcher's per-run mechanism without changing the provider/model base. When the launcher encodes thinking as a model suffix, replace LEVEL in the shown pi-subagents form and pass model: "provider/model:LEVEL". Do not omit the model or thinking choice, inherit an ambient launcher default for either, substitute an unlisted model, persist the thinking level, launch a disabled or unconfigured role, invent a role, or use an unsupported thinking level.

Roles:
${roleLines}${uiDesign}
${effective.uiDesign ? `\n${VISUAL_DESIGN_POLICY}\n` : ""}
This is guidance for the main agent. It does not create, execute, route, supervise, or enforce delegated work.
</delegation_policy>`;
}

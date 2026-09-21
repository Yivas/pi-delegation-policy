import {
  enabledOrdinaryRoles,
  hasRuntimeError,
  isRoleDisabled,
  type RuntimeState,
} from "./runtime.ts";
import type {
  EffectiveDelegateState,
  ModelRef,
  ModelRole,
  Preference,
  ThinkingPolicy,
} from "./types.ts";

const NORMAL_POLICY =
  "Delegate substantial, separable work only when the expected benefit clearly outweighs briefing, supervision, review, and integration cost. Count parallelism as a benefit only when valuable work can advance now or elapsed time matters. A merely possible fresh perspective is not enough by itself. Keep borderline work with the main agent.";
const AGGRESSIVE_POLICY =
  "Default to delegating substantial, separable, independently checkable work with a clear objective and acceptance criteria. Delegate when the benefit is plausible even if not proven, including a useful independent perspective. Keep work with the main agent when it is poorly bounded, tightly coupled, dominated by integration or final accountability, or has clearly prohibitive delegation overhead.";
const ORCHESTRATOR_POLICY =
  "Delegate all transferable execution before performing it whenever an enabled capable role and authorized launcher are available, regardless of size. This includes small lookups, code reading, detailed planning, implementation, tests, writing, detailed review, and integration mechanics. Perform only minimal bootstrap: mandatory instructions, tool discovery, and narrow assignment scope; do not pre-solve or broadly inspect the repository. Batch small tasks without forcing recursive fanout. After assigning a task, do not take it over or run an equivalent worker while it is pending; coordinate only disjoint work, use the host wait/completion mechanism, and consume its result before dependent work or finalizing. Retain strategy, objectives, critical user decisions, coordination, safety, evidence evaluation, final acceptance, and concise synthesis; final responsibility does not permit personally completing review or integration mechanics. Reinspect returned work only for a concrete gap, risk, or contradiction; delegate transferable fixes or rechecks. Direct execution is allowed only for genuinely non-transferable work, no enabled capable role, a confirmed unavailable authorized launcher, or an explicit user or higher-priority requirement. Before direct work, state the concrete exception briefly, do only the minimum, do not repeat it while unchanged, and resume delegation when it ends. Never use a final-review or integration label to do the whole task personally. Triviality, convenience, economics, transfer cost, size, or familiarity do not justify direct execution. Keep narration concise, but never omit requested detail, risks, evidence, or safety information. Do not promise savings.";

const ROLE_SELECTION_POLICY = `Choose the role by task fit before considering model preference:
- demand: execute, search, plan, decide, coordinate, or unblock;
- difficulty: clarity, ambiguity, dependencies, competing hypotheses, and risk;
- quantity: files, modules, systems, sources, and context volume;
- error and review cost: what can go wrong, how costly it is to detect, and what evidence is needed.
No single factor decides the role. First remove disabled roles, then discard enabled roles that cannot satisfy the acceptance criteria and evidence requirements. Select the least costly remaining role that can satisfy them. Keep the work with the main agent if no enabled role can satisfy them.

Use Small for bounded, planned, and verifiable execution: concrete searches, scoped exploration, defined implementation, focused documentation, tests, reviews, mechanical changes, evident bugs, and bounded UI implementation whose design and stack are decided. Difficult but well-defined execution can remain Small with higher thinking.

Use Medium directly when the combined task fit materially requires planning, reducing meaningful ambiguity, broad synthesis, tracing several modules, comparing sources or options, coordinating substantial context, or making difficult decisions. Small does not need to fail first.

When Small and Medium are enabled alternatives, use Large only to unblock genuinely stuck work: persistent failures, severe framework conflicts, contradictory hypotheses, or reliable prior evidence that ordinary roles have not produced a trustworthy answer. Do not require ceremonial failed attempts. Large remains exceptional in a complete ordinary-role configuration.

A more capable enabled role may cover work normally suited to a disabled role only when it can satisfy the same acceptance and evidence. Never choose a less capable role merely because it is the only enabled role. Large quantities of repetitive, independent work favor multiple Small delegations; volume alone does not justify Medium or Large. Agent type does not determine the model role. Apply preference only when Small and Medium are comparably credible fits. That tie-break applies only when both are enabled.`;

const LEGACY_OWNERSHIP_POLICY =
  "In every intensity, keep global strategy, coordination, integration, final review, and work whose essential context is too costly or risky to transfer with the main agent.";
const ORCHESTRATOR_OWNERSHIP_POLICY =
  "In orchestrator, keep global strategy, objectives, critical decisions, coordination, safety, evidence evaluation, final acceptance, and concise synthesis with the main agent. The main agent MUST delegate transferable detailed review and integration mechanics; final responsibility does not permit personal execution except under the named direct-work exceptions.";

const VISUAL_DESIGN_POLICY = `Visual Design is an optional specialist role. It is optional to configure. Before selecting an ordinary role for each task or phase, evaluate whether Visual Design is configured and all four conditions hold:
1. the primary acceptance criterion is a visual or user-experience result;
2. product behavior and data contracts are already defined and remain unchanged;
3. the patch is bounded to an identifiable surface, component, or set of assets;
4. it requires no business logic, data flow, APIs, routes, application architecture, tooling, or cross-system coordination.

If Visual Design is configured, all four conditions hold, and the main agent has decided to delegate that visual portion or the intensity requires delegation, MUST select Visual Design rather than Small, Medium, or Large. Use the exact configured Visual Design provider/model shown below and that role's thinking policy for that launch; do not substitute an ordinary role's model. Reevaluate Visual Design eligibility whenever the task or phase changes. Eligible visual work does not itself require delegation in normal or aggressive; use their existing intensity rules to decide whether to delegate it.

When eligible, Visual Design may design, create, implement, and review scoped presentation code and visual assets, including layout, styles, responsive presentation, typography, images, icons, logos, SVGs, diagrams, and documentation visuals. It may address visual accessibility such as contrast and focus visibility. It must run and report the relevant existing checks for its patch.`;
const LEGACY_VISUAL_DESIGN_ROUTING_POLICY =
  "Route interaction behavior, state, validation, semantic HTML changes, keyboard mechanics, ARIA behavior, authentication, permissions, persistence, test infrastructure, and behavior-test ownership to an enabled ordinary role that fits, or keep it with the main agent. If any eligibility condition fails, use an enabled ordinary role or split the visual portion from the broader task. The main agent retains cross-domain integration and final acceptance.";
const ORCHESTRATOR_VISUAL_DESIGN_ROUTING_POLICY =
  "In orchestrator, route interaction behavior, state, validation, semantic HTML changes, keyboard mechanics, ARIA behavior, authentication, permissions, persistence, test infrastructure, and behavior-test ownership to an enabled ordinary role that fits. If any eligibility condition fails, use an enabled ordinary role or split the visual portion from the broader task. The main agent retains cross-domain integration responsibility, coordination, and final acceptance, but MUST delegate transferable integration mechanics and detailed review to a capable enabled ordinary role unless a named direct-work exception applies.";

const ADVISOR_STEP =
  "Before committing to an approach, evaluate whether an advisor's second opinion could change the choice. Consult before investing effort, not to validate finished work, and do not postpone it until you have findings. Use the consultation signals below; a routine decision needs no call.";

const DELEGATION_DECISION_STEPS = [
  "Decide under the active intensity whether this work should be delegated at all.",
  "Classify the work and determine its acceptance criteria and the evidence it needs.",
  "If Visual Design is configured, evaluate its four eligibility conditions before any ordinary role. When all four hold and that visual portion is being delegated, Visual Design is selected first.",
  "Otherwise select the role by task fit among enabled roles only, following the rules below.",
  "If no enabled role can satisfy the acceptance criteria and evidence, keep the work with the main agent.",
  "Before every delegated launch, apply the launch requirements below without omitting the model or the thinking choice.",
];

const ADVISOR_POLICY = `Advisor is a consultation role; it never executes work. Consider consulting before committing when viable approaches trade off explicit requirements; when evidence supports conflicting explanations that call for different actions; or when a proposed change involves destructive data operations, difficult rollback, or compatibility changes for existing consumers. Those are consultation signals, not thresholds that require a call. If a second opinion could change the decision, ask for one. Routine decisions need none. Launch it as a normal subagent with the bundled profile "pi-delegation-policy.advisor" and the exact model and thinking of its role line; do not substitute either.

The advisor knows only what you send: it cannot see this conversation, read files or use tools. Every brief must stand on its own: the objective and the decision, the constraints, the current state and the relevant evidence, including code, errors or results where they matter, the options and their consequences, what you tried or propose and why, and the uncertainty you need resolved. Separate facts from assumptions. Do not omit what it needs, and do not dump what it cannot use.

Treat it as a conversation, not a single ruling. Continue the same thread with the host's resume mechanism to clarify, challenge or go deeper: send what changed and the open question, and never restart the thread for the same matter.

Decisions that belong to the user stay with the user; consider consulting the advisor before asking the user when its advice could improve the options, trade-offs or recommendation you present. Weigh its advice against the evidence and check verifiable claims before relying on them, and never hand it implementation, tool-dependent checks or your own responsibility to decide. Do not seek approval for a decision already taken, and do not keep asking until it agrees: its value is spotting weak assumptions, comparing options and challenging reasoning, not acting as an authority or a formality.`;

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

type RoleThinking =
  | { kind: "fixed"; level: string }
  | { kind: "range"; min: string; max: string }
  | { kind: "unset" };

function roleThinking(policy: ThinkingPolicy | undefined): RoleThinking {
  if (!policy) return { kind: "unset" };
  return "level" in policy
    ? { kind: "fixed", level: policy.level }
    : { kind: "range", min: policy.min, max: policy.max };
}

/** Fixed policies show the literal level; range and unset keep the `:LEVEL` placeholder. */
function formatThinkingLaunchModel(reference: ModelRef, thinking: RoleThinking): string {
  const base = `${reference.provider}/${reference.model}`;
  return promptString(thinking.kind === "fixed" ? `${base}:${thinking.level}` : `${base}:LEVEL`);
}

function thinkingPolicyText(thinking: RoleThinking): string {
  if (thinking.kind === "fixed") return `fixed ${thinking.level} (must not change).`;
  if (thinking.kind === "range")
    return `range ${thinking.min}..${thinking.max} inclusive (choose within it).`;
  return "unset (choose per run).";
}

function thinkingPreviewToken(thinking: RoleThinking): string {
  if (thinking.kind === "fixed") return `:${thinking.level}`;
  if (thinking.kind === "range") return `:${thinking.min}..${thinking.max}`;
  return ":per-run";
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
    .map(
      (role) =>
        `${roleName(role)} ${formatLaunchModel(effective[role] as ModelRef)}${thinkingPreviewToken(roleThinking(effective.thinking[role]))}`,
    )
    .join(" · ");
  return [
    `${effective.intensity} · task fit first · ${preferencePreview(effective.preference, enabled)}`,
    `Enabled: ${enabled.map(roleName).join(", ")}${disabled.length ? ` · Disabled: ${disabled.map(roleName).join(", ")}` : ""}`,
    `${references} · exact model plus per-task thinking required only for roles with no policy; neither uses an ambient default.`,
    ...(effective.intensity === "orchestrator"
      ? ["Delegate all transferable work; main agent keeps final acceptance."]
      : []),
  ];
}

export function buildDelegationPolicy(state: RuntimeState): string | undefined {
  if (state.effective.intensity === "off" || hasRuntimeError(state)) return undefined;

  const { effective } = state;
  const { enabled, disabled } = rolesByState(effective);
  if (enabled.length === 0) return undefined;

  const intensityPolicy =
    effective.intensity === "normal"
      ? NORMAL_POLICY
      : effective.intensity === "aggressive"
        ? AGGRESSIVE_POLICY
        : ORCHESTRATOR_POLICY;
  const ownershipPolicy =
    effective.intensity === "orchestrator"
      ? ORCHESTRATOR_OWNERSHIP_POLICY
      : LEGACY_OWNERSHIP_POLICY;
  const uiDesignThinking = roleThinking(effective.thinking.uiDesign);
  const uiDesign = effective.uiDesign
    ? `\n- Visual Design: ${formatReference(effective.uiDesign)}; exact model base: ${formatLaunchModel(effective.uiDesign)}; pi-subagents form: ${formatThinkingLaunchModel(effective.uiDesign, uiDesignThinking)}; thinking policy: ${thinkingPolicyText(uiDesignThinking)}`
    : "";
  const visualDesignPolicy =
    effective.intensity === "orchestrator"
      ? `${VISUAL_DESIGN_POLICY}\n\n${ORCHESTRATOR_VISUAL_DESIGN_ROUTING_POLICY}`
      : `${VISUAL_DESIGN_POLICY}\n\n${LEGACY_VISUAL_DESIGN_ROUTING_POLICY}`;
  const advisorThinking = roleThinking(effective.thinking.advisor);
  const advisorRoleLine = effective.advisor
    ? `\n- Advisor (optional): ${formatReference(effective.advisor)}; exact model base: ${formatLaunchModel(effective.advisor)}; pi-subagents form: ${formatThinkingLaunchModel(effective.advisor, advisorThinking)}; thinking policy: ${thinkingPolicyText(advisorThinking)}`
    : "";
  // The consultation rule belongs to the decision procedure, not to the intensity paragraph.
  const advisorSection = effective.advisor ? `\n\nAdvisor consultation:\n${ADVISOR_POLICY}` : "";
  const decisionSteps = effective.advisor
    ? [ADVISOR_STEP, ...DELEGATION_DECISION_STEPS]
    : DELEGATION_DECISION_STEPS;
  const decisionOrder = decisionSteps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  const roleLines = enabled
    .map((role) => {
      const reference = effective[role] as ModelRef;
      const thinking = roleThinking(effective.thinking[role]);
      return `- ${roleName(role)}: ${formatReference(reference)}; exact model base: ${formatLaunchModel(reference)}; pi-subagents form: ${formatThinkingLaunchModel(reference, thinking)}; thinking policy: ${thinkingPolicyText(thinking)}`;
    })
    .join("\n");

  return `<delegation_policy>
These instructions are binding for the main agent's delegation decisions in this session. Apply them
in the order below. This block states each rule's obligation and its exceptions; read both before
acting.

Intensity: ${effective.intensity}.
Intensity rule: ${intensityPolicy}${effective.uiDesign ? `\n\nVisual Design obligation:\n${visualDesignPolicy}` : ""}

Decision order:
${decisionOrder}${advisorSection}

Role selection:
${ROLE_SELECTION_POLICY}

Ownership and retention:
${ownershipPolicy}

Enabled ordinary roles: ${enabled.map(roleName).join(", ")}.${disabled.length ? `\nDisabled ordinary roles: ${disabled.map(roleName).join(", ")}.` : ""}

Model preference: ${effective.preference}. ${preferenceGuidance(effective.preference, enabled)}

Launch requirements:
Before every delegated launch, name the selected role and take its exact combined provider/model base below. Choose thinking dynamically for that run from task demand, difficulty, quantity, risk, review cost, and the selected model's capabilities when the role's thinking policy is unset. A role with a fixed policy uses exactly that level for every launch and the main agent must not change it. A role with a range policy allows only a level inside its inclusive bounds. A fixed or range policy is binding: it is not an ambient launcher default and is not inherited by another role or by the main agent. Then transmit both through the launcher's per-run mechanism without changing the provider/model base. When the launcher encodes thinking as a model suffix, pass model: "provider/model:LEVEL", replacing LEVEL with that launch's level, or pass the literal level already shown in the role line. Do not omit the model or thinking choice, inherit an ambient launcher default for either, substitute an unlisted model, persist a per-run thinking choice, launch a disabled or unconfigured role, invent a role, or use a level that a bound policy or the selected model does not support.

Roles:
${roleLines}${uiDesign}${advisorRoleLine}

Limits:
These instructions state the main agent's obligations in this session. The extension cannot enforce
them at runtime and it performs no delegated work of its own: it does not route, supervise, or accept
subagent results. Its only launch belongs to one explicit tool, context_shunt_delegate: that tool asks
the host-authorized external executor for one bounded answer about an already-preserved text
artifact, it is never invoked from a hook, and it never replaces delegation, the launcher, or the
roles above.
</delegation_policy>`;
}

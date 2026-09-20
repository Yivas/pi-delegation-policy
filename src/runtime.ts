import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
  getGlobalConfigPath,
  readConfig,
  resolveDelegateState,
  restoreSessionStateWithDiagnostics,
  type ConfigDiagnostic,
} from "./config.ts";
import {
  MODEL_ROLES,
  ROLE_LABELS,
  type EffectiveDelegateState,
  type GlobalDefaults,
  type ModelConfigKey,
  type ModelRef,
  type ModelRole,
  type ModelStatus,
  type OrdinaryRoleSetting,
  type SessionDelegateState,
  type ThinkingLevelName,
  type ThinkingPolicy,
} from "./types.ts";

export type RuntimeState = {
  effective: EffectiveDelegateState;
  global: GlobalDefaults;
  session: SessionDelegateState;
  diagnostics: ConfigDiagnostic[];
  modelStatuses: Map<ModelConfigKey, ModelStatus>;
  runtimeErrors: string[];
};

export function isRoleEnabled(setting: OrdinaryRoleSetting | undefined): setting is ModelRef {
  return setting !== undefined && setting !== null;
}

export function isRoleDisabled(setting: OrdinaryRoleSetting | undefined): setting is null {
  return setting === null;
}

export function enabledOrdinaryRoles(effective: EffectiveDelegateState): ModelRole[] {
  return MODEL_ROLES.filter((role) => isRoleEnabled(effective[role]));
}

function matchesReference(model: Model<Api>, reference: ModelRef): boolean {
  return model.provider === reference.provider && model.id === reference.model;
}

function uniqueModels(models: readonly Model<Api>[]): Model<Api>[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = `${model.provider}\u0000${model.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function modelCandidates(ctx: ExtensionContext): Model<Api>[] {
  const scopedModels = ctx.scopedModels ?? [];
  const models = scopedModels.length
    ? scopedModels.map(({ model }) => model)
    : ctx.modelRegistry.getAvailable();
  return uniqueModels(models).filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
}

export function validateModelReference(ctx: ExtensionContext, reference: ModelRef): ModelStatus {
  const registered = ctx.modelRegistry.find(reference.provider, reference.model);
  if (!registered) return { kind: "missing-model" };

  const scopedModels = ctx.scopedModels ?? [];
  if (scopedModels.length > 0) {
    const scoped = scopedModels
      .map(({ model }) => model)
      .find((model) => matchesReference(model, reference));
    if (!scoped) return { kind: "outside-scope" };
    if (!ctx.modelRegistry.hasConfiguredAuth(scoped)) return { kind: "no-credentials" };
    return { kind: "available", model: scoped };
  }

  const available = ctx.modelRegistry
    .getAvailable()
    .find((model) => matchesReference(model, reference));
  if (!available) return { kind: "unavailable" };
  if (!ctx.modelRegistry.hasConfiguredAuth(available)) return { kind: "no-credentials" };
  return { kind: "available", model: available };
}

function statusDetail(status: ModelStatus): string {
  switch (status.kind) {
    case "missing-model":
      return "is not registered in Pi";
    case "outside-scope":
      return "is outside the current model scope";
    case "unavailable":
      return "is not available";
    case "no-credentials":
      return "has no configured authentication";
    case "available":
      return "is available";
  }
}

function policyLevels(policy: ThinkingPolicy): ThinkingLevelName[] {
  return "level" in policy ? [policy.level] : [policy.min, policy.max];
}
/** A well-formed level the resolved role model does not support is a new `D:ERR` cause. */
function validateThinkingPolicy(
  state: RuntimeState,
  role: ModelConfigKey,
  reference: ModelRef,
  status: ModelStatus,
): void {
  const policy = state.effective.thinking[role];
  if (!policy || status.kind !== "available") return;
  const supported = getSupportedThinkingLevels(status.model);
  for (const level of policyLevels(policy)) {
    if (!supported.includes(level)) {
      state.runtimeErrors.push(
        `${ROLE_LABELS[role]} thinking level "${level}" is not supported by ${reference.provider}/${reference.model}.`,
      );
    }
  }
}

function validateEnabledRole(
  ctx: ExtensionContext,
  state: RuntimeState,
  role: ModelConfigKey,
  reference: ModelRef,
): void {
  const status = validateModelReference(ctx, reference);
  state.modelStatuses.set(role, status);
  if (status.kind !== "available") {
    state.runtimeErrors.push(`${ROLE_LABELS[role]} model ${statusDetail(status)}.`);
  }
  validateThinkingPolicy(state, role, reference, status);
}

function readerRoleDiagnostic(state: RuntimeState): string | undefined {
  const { contextShunt } = state.effective;
  if (!contextShunt.readerEnabled) return undefined;

  const role = contextShunt.readerRole;
  const setting = state.effective[role];
  const label = ROLE_LABELS[role];
  if (setting === null) return `Reader role ${label} is disabled; choose an enabled ordinary role.`;
  if (setting === undefined)
    return `Reader role ${label} is not configured; configure it or choose an enabled ordinary role.`;

  const status = state.modelStatuses.get(role);
  return status?.kind === "available"
    ? undefined
    : `Reader role ${label} model ${statusDetail(status ?? { kind: "unavailable" })}.`;
}

export async function loadRuntime(ctx: ExtensionContext): Promise<RuntimeState> {
  const loaded = await readConfig(getGlobalConfigPath());
  const restored = restoreSessionStateWithDiagnostics(ctx.sessionManager.getBranch());
  const state: RuntimeState = {
    effective: resolveDelegateState(loaded.defaults, restored.session),
    global: loaded.defaults,
    session: restored.session,
    diagnostics: [...loaded.diagnostics, ...restored.diagnostics],
    modelStatuses: new Map(),
    runtimeErrors: [],
  };
  validateRuntime(ctx, state);
  return state;
}

export function validateRuntime(ctx: ExtensionContext, state: RuntimeState): void {
  state.effective = resolveDelegateState(state.global, state.session);
  state.modelStatuses.clear();
  state.runtimeErrors = [];

  if (state.effective.intensity === "off") return;

  for (const diagnostic of state.diagnostics) state.runtimeErrors.push(diagnostic.message);
  for (const role of MODEL_ROLES) {
    const setting = state.effective[role];
    if (setting === undefined) {
      state.runtimeErrors.push(
        `${ROLE_LABELS[role]} model is not configured; configure it or explicitly disable it.`,
      );
    } else if (isRoleEnabled(setting)) {
      validateEnabledRole(ctx, state, role, setting);
    }
  }
  if (enabledOrdinaryRoles(state.effective).length === 0) {
    state.runtimeErrors.push("At least one ordinary role must be enabled.");
  }
  if (state.effective.uiDesign)
    validateEnabledRole(ctx, state, "uiDesign", state.effective.uiDesign);
  if (state.effective.advisor) validateEnabledRole(ctx, state, "advisor", state.effective.advisor);

  const readerDiagnostic = readerRoleDiagnostic(state);
  if (readerDiagnostic) state.runtimeErrors.push(readerDiagnostic);
}

export function hasRuntimeError(state: RuntimeState): boolean {
  return state.effective.intensity !== "off" && state.runtimeErrors.length > 0;
}

export function statusLabel(state: RuntimeState): string {
  if (state.effective.intensity === "off") return "D:OFF";
  if (hasRuntimeError(state)) return "D:ERR";
  const labels = {
    normal: "D:NORM",
    aggressive: "D:AGG",
    orchestrator: "D:ORCH",
  } as const;
  return labels[state.effective.intensity];
}

export function formatModelRef(reference: ModelRef | null | undefined): string {
  if (reference === null) return "disabled";
  return reference ? `${reference.provider}/${reference.model}` : "not configured";
}

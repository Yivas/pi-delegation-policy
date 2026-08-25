import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getGlobalConfigPath,
  readConfig,
  SESSION_ENTRY_TYPE,
  resolveDelegateState,
  restoreSessionState,
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
  type SessionDelegateState,
} from "./types.ts";

export type RuntimeState = {
  effective: EffectiveDelegateState;
  global: GlobalDefaults;
  session: SessionDelegateState;
  diagnostics: ConfigDiagnostic[];
  modelStatuses: Map<ModelConfigKey, ModelStatus>;
  runtimeErrors: string[];
};

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

function referenceFor(state: RuntimeState, role: ModelRole): ModelRef | undefined {
  return state.effective[role];
}

function validateRole(ctx: ExtensionContext, state: RuntimeState, role: ModelConfigKey): void {
  const reference = role === "uiDesign" ? state.effective.uiDesign : referenceFor(state, role);
  if (!reference) {
    state.runtimeErrors.push(`${ROLE_LABELS[role]} model is not configured.`);
    return;
  }

  const status = validateModelReference(ctx, reference);
  state.modelStatuses.set(role, status);
  if (status.kind !== "available") {
    state.runtimeErrors.push(`${ROLE_LABELS[role]} model ${statusDetail(status)}.`);
  }
}

export async function loadRuntime(ctx: ExtensionContext): Promise<RuntimeState> {
  const loaded = await readConfig(getGlobalConfigPath());
  const session = restoreSessionState(ctx.sessionManager.getBranch());
  const state: RuntimeState = {
    effective: resolveDelegateState(loaded.defaults, session),
    global: loaded.defaults,
    session,
    diagnostics: loaded.diagnostics,
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
  for (const role of MODEL_ROLES) validateRole(ctx, state, role);
  if (state.effective.uiDesign) validateRole(ctx, state, "uiDesign");
}

export function hasRuntimeError(state: RuntimeState): boolean {
  return state.effective.intensity !== "off" && state.runtimeErrors.length > 0;
}

export function statusLabel(state: RuntimeState): string {
  if (state.effective.intensity === "off") return "D:OFF";
  if (hasRuntimeError(state)) return "D:ERR";
  return state.effective.intensity === "normal" ? "D:NORM" : "D:AGG";
}

export function formatModelRef(reference: ModelRef | undefined): string {
  return reference ? `${reference.provider}/${reference.model}` : "not configured";
}

export function sessionEntry(
  pi: { appendEntry: (type: string, data?: unknown) => void },
  state: RuntimeState,
): void {
  pi.appendEntry(SESSION_ENTRY_TYPE, state.session);
}

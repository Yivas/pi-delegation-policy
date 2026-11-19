import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { locateAdvisorAnthropicProvider } from "./advisor-anthropic-provider.ts";
import {
  admissionFor,
  getProviderAdmissionsPath,
  type ProviderAdmissions,
  readProviderAdmissions,
  RESERVED_PROVIDER,
} from "./provider-admissions.ts";
import { locateInstalledPackage } from "./provider-package.ts";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
  getGlobalConfigPath,
  readConfig,
  resolveDelegateState,
  restoreSessionStateWithDiagnostics,
  type ConfigDiagnostic,
} from "./config.ts";
import {
  getLaunchCorrectionPath,
  readLaunchCorrectionMode,
  type LaunchCorrectionMode,
} from "./launch-correction-mode.ts";
import {
  getAdvisorRemindersPath,
  readAdvisorReminderMode,
  type AdvisorReminderMode,
} from "./advisor-reminders.ts";
import { readRoleEntries } from "./role-entries.ts";
import {
  type AdvisorSetting,
  MODEL_ROLES,
  OPTIONAL_ROLE_ENTRY_KEYS,
  ROLE_LABELS,
  type EffectiveDelegateState,
  type GlobalDefaults,
  type ModelConfigKey,
  type ModelRef,
  type ModelRole,
  type ModelStatus,
  type OrdinaryRoleSetting,
  type RoleEntries,
  type SessionDelegateState,
  THINKING_LEVEL_NAMES,
  type ThinkingLevelName,
  type ThinkingPolicy,
} from "./types.ts";

export type RuntimeState = {
  effective: EffectiveDelegateState;
  global: GlobalDefaults;
  session: SessionDelegateState;
  /** Optional-role entries as the sidecar resolved them; kept so a re-validation cannot drop them. */
  roleEntries?: RoleEntries;
  diagnostics: ConfigDiagnostic[];
  modelStatuses: Map<ModelConfigKey, ModelStatus>;
  runtimeErrors: string[];
  /** Non-blocking notes about optional entries; an entry never invalidates the delegation axis. */
  roleWarnings?: string[];
  advisorErrors?: string[];
  /** Global provider-extension admissions; absent means none. */
  admissions?: ProviderAdmissions;
  /** How the launch check treats a call it can correct; absent means `correct`. */
  launchCorrection?: LaunchCorrectionMode;
  /** Whether the extension may add its short Advisor reminder; absent means `remind`. */
  advisorReminder?: AdvisorReminderMode;
  /** The reminder companion was unreadable or invalid, so the mode above is suspended. */
  advisorReminderInvalid?: boolean;
  /** Advisor notes that never remove an Advisor or change the footer. */
  advisorWarnings?: string[];
  advisorEntries?: Array<{
    index: number;
    setting: AdvisorSetting;
    status: ModelStatus;
    errors: string[];
  }>;
};

export function isAdvisorEnabled(effective: EffectiveDelegateState): boolean {
  return (
    effective.advisorMode === "on" ||
    (effective.advisorMode === "with-delegation" &&
      effective.intensity !== "off" &&
      effective.advisors.length > 0)
  );
}

export function advisorStatusLabel(state: RuntimeState): string {
  if (hasAdvisorError(state)) return "A:ERR";
  if (!isAdvisorEnabled(state.effective)) return "A:OFF";
  return (state.advisorErrors?.length ?? 0) > 0 ? "A:PART" : "A:ON";
}

export function isRoleEnabled(setting: OrdinaryRoleSetting | undefined): setting is ModelRef {
  return setting !== undefined && setting !== null;
}

export function isRoleDisabled(setting: OrdinaryRoleSetting | undefined): setting is null {
  return setting === null;
}

export function enabledOrdinaryRoles(effective: EffectiveDelegateState): ModelRole[] {
  return MODEL_ROLES.filter((role) => isRoleEnabled(effective[role]));
}

/**
 * Whether a model can honour a thinking policy: a fixed level must be one the model supports, and a
 * range needs at least one supported level inside it, which is exactly what the launch check accepts.
 */
function thinkingSatisfiable(model: Model<Api>, policy: ThinkingPolicy | undefined): boolean {
  if (!policy) return true;
  const supported = getSupportedThinkingLevels(model);
  if ("level" in policy) return supported.includes(policy.level);
  const order = THINKING_LEVEL_NAMES as readonly string[];
  return supported.some(
    (level) =>
      order.indexOf(level) >= order.indexOf(policy.min) &&
      order.indexOf(level) <= order.indexOf(policy.max),
  );
}

/**
 * Whether an optional entry's model resolved to a usable status. An absent status means no validation
 * has run, so the entry is unverified rather than refused; a known non-available status cannot launch.
 */
export function isOptionalEntryModelUsable(state: RuntimeState, key: ModelConfigKey): boolean {
  const status = state.modelStatuses.get(key);
  return status === undefined || status.kind === "available";
}

/**
 * An optional entry is offered only while it could launch: a model that resolved to a non-available
 * status is refused by the launch check, and so is an entry whose own thinking policy its model cannot
 * honour, so the policy block and the allowed list must not name either as an exact launch. An absent
 * status means no validation has run, and the entry stays listed as unverified.
 */
export function isAdvertisedOptionalEntry(state: RuntimeState, key: ModelConfigKey): boolean {
  const status = state.modelStatuses.get(key);
  if (status === undefined) return true;
  return (
    status.kind === "available" && thinkingSatisfiable(status.model, state.effective.thinking[key])
  );
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
function roleErrors(state: RuntimeState, role: ModelConfigKey): string[] {
  if (role !== "advisor") return state.runtimeErrors;
  if (!state.advisorErrors) state.advisorErrors = [];
  return state.advisorErrors;
}
/** Unsupported levels disable only the feature that owns the role. */
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
      roleErrors(state, role).push(
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
    roleErrors(state, role).push(`${ROLE_LABELS[role]} model ${statusDetail(status)}.`);
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
  const path = getGlobalConfigPath();
  const loaded = await readConfig(path);
  const admissions = await readProviderAdmissions(getProviderAdmissionsPath(path));
  const correction = await readLaunchCorrectionMode(getLaunchCorrectionPath(path));
  const reminder = await readAdvisorReminderMode(getAdvisorRemindersPath(path));
  const roleFiles = await readRoleEntries(path);
  const restored = restoreSessionStateWithDiagnostics(ctx.sessionManager.getBranch());
  const state: RuntimeState = {
    effective: resolveDelegateState(loaded.defaults, restored.session, roleFiles.entries),
    global: loaded.defaults,
    session: restored.session,
    roleEntries: roleFiles.entries,
    diagnostics: [
      ...loaded.diagnostics,
      ...roleFiles.diagnostics,
      ...restored.diagnostics,
      ...(admissions.diagnostic ? [admissions.diagnostic] : []),
      ...(correction.diagnostic ? [correction.diagnostic] : []),
      ...(reminder.diagnostic ? [reminder.diagnostic] : []),
    ],
    admissions: admissions.admissions,
    launchCorrection: correction.mode,
    advisorReminder: reminder.mode,
    advisorReminderInvalid: reminder.invalid === true,
    modelStatuses: new Map(),
    runtimeErrors: [],
  };
  validateRuntime(ctx, state);
  return state;
}

/** Scopes that report a side setting and never invalidate the delegation axis. */
const SIDE_SETTING_SCOPES: ReadonlySet<string> = new Set([
  "advisor-extension",
  "launch-correction",
  "advisor-reminder",
  "role-entries",
]);

export function validateRuntime(ctx: ExtensionContext, state: RuntimeState): void {
  // Re-resolving must keep the sidecar entries; without them every optional role disappears.
  state.effective = resolveDelegateState(state.global, state.session, state.roleEntries);
  state.modelStatuses.clear();
  state.runtimeErrors = [];
  state.advisorErrors = [];
  state.advisorWarnings = [];
  state.roleWarnings = [];

  const advisorEnabled = isAdvisorEnabled(state.effective);
  for (const diagnostic of state.diagnostics) {
    if (diagnostic.scope === "advisor") {
      // An unusable Advisor state is only an error while Advisor is on; otherwise the diagnostic
      // stays informative in `details=` and the footer keeps reporting A:OFF.
      if (advisorEnabled) state.advisorErrors.push(diagnostic.message);
    } else if (
      !SIDE_SETTING_SCOPES.has(diagnostic.scope ?? "") &&
      state.effective.intensity !== "off"
    ) {
      // Every other diagnostic belongs to the delegation axis, so a valid enabled Advisor keeps
      // working while delegation is reported broken.
      state.runtimeErrors.push(diagnostic.message);
    }
  }
  if (state.effective.intensity === "off" && !advisorEnabled) return;
  state.advisorEntries = [];
  if (advisorEnabled) {
    if (!state.effective.advisors.length)
      state.advisorErrors.push("Advisor model is not configured.");
    for (const [index, setting] of state.effective.advisors.entries()) {
      const status = validateModelReference(ctx, setting);
      const errors: string[] = [];
      const label = index === 0 ? "Advisor" : `Advisor ${index + 1}`;
      if (status.kind !== "available") errors.push(`${label} model ${statusDetail(status)}.`);
      if (setting.providerExtension) {
        if (setting.provider !== "anthropic")
          errors.push(
            `${label} Anthropic provider extension requires provider anthropic; the configured model is unchanged.`,
          );
        else if (status.kind === "available") {
          const location = locateAdvisorAnthropicProvider(ctx.cwd);
          if (!location.ok) errors.push(location.message);
        }
      } else if (status.kind === "available") {
        const check = providerExtensionCheck(ctx, label, setting, state.admissions ?? {});
        if (check?.kind === "error") errors.push(check.message);
        else if (check) state.advisorWarnings.push(check.message);
      }
      if (index === 0) state.modelStatuses.set("advisor", status);
      state.advisorEntries.push({ index, setting, status, errors });
      state.advisorErrors.push(...errors);
    }
  }
  if (state.effective.intensity === "off") return;
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
  // Optional entries never touch the delegation axis: an unusable entry is reported as a warning and
  // simply cannot be launched, while every other role keeps working.
  // A merge that dropped a repeat is reported for the same reason: the list on disk is not the list
  // the roles resolve to, and the writer would refuse to save it back without saying why.
  for (const repeated of state.effective.repeatedRoleEntries) {
    state.roleWarnings.push(
      `${ROLE_LABELS[repeated.key]} entry ${repeated.index} repeats ${repeated.provider}/${repeated.model} and was ignored.`,
    );
  }
  for (const key of OPTIONAL_ROLE_ENTRY_KEYS) {
    const reference = state.effective[key];
    if (!reference) continue;
    const status = validateModelReference(ctx, reference);
    state.modelStatuses.set(key, status);
    if (status.kind !== "available") {
      state.roleWarnings.push(`${ROLE_LABELS[key]} model ${statusDetail(status)}.`);
    }
    const policy = state.effective.thinking[key];
    if (policy && status.kind === "available") {
      const supported = getSupportedThinkingLevels(status.model);
      for (const level of policyLevels(policy)) {
        if (supported.includes(level)) continue;
        state.roleWarnings.push(
          `${ROLE_LABELS[key]} thinking level "${level}" is not supported by ${reference.provider}/${reference.model}.`,
        );
      }
    }
    // The point of a vision entry is that it can see; a text-only model defeats the role.
    if (key.startsWith("vision") && status.kind === "available") {
      const input = status.model.input as readonly string[] | undefined;
      if (Array.isArray(input) && !input.includes("image")) {
        state.roleWarnings.push(
          `${ROLE_LABELS[key]} model ${reference.provider}/${reference.model} does not accept image input.`,
        );
      }
    }
  }

  const readerDiagnostic = readerRoleDiagnostic(state);
  if (readerDiagnostic) state.runtimeErrors.push(readerDiagnostic);
}

/**
 * An admitted package must still pass the identity the child will check: otherwise the child would
 * refuse every request, so the Advisor is left out. Without an admission, a provider that an
 * extension replaced natively in this session runs as a different implementation in the child,
 * which loads no extension. That is only a warning: the built-in provider may still answer with its
 * own credentials. Auth sources are not used as proof: a native provider reports its own key as an
 * environment source.
 */
function providerExtensionCheck(
  ctx: ExtensionContext,
  label: string,
  setting: AdvisorSetting,
  admissions: ProviderAdmissions,
): { kind: "error" | "warning"; message: string } | undefined {
  const pkg = admissionFor(admissions, setting.provider);
  if (pkg)
    return locateInstalledPackage(ctx.cwd, pkg, { configured: true }).ok
      ? undefined
      : {
          kind: "error",
          message: `${label} provider extension ${pkg.package} ${pkg.version} is no longer installed and configured as admitted; re-select the provider extension in /delegate.`,
        };
  if (setting.provider === RESERVED_PROVIDER) return undefined;
  const native = ctx.modelRegistry?.getRegisteredNativeProvider?.(setting.provider);
  return native
    ? {
        kind: "warning",
        message: `${label} provider ${setting.provider} is replaced by an extension in this session, and the Advisor child does not load it; if its consultations fail, select its provider extension in /delegate.`,
      }
    : undefined;
}

export function hasAdvisorError(state: RuntimeState): boolean {
  return (state.advisorErrors?.length ?? 0) > 0 && validAdvisors(state).length === 0;
}

export function validAdvisors(
  state: RuntimeState,
): Array<{ index: number; setting: AdvisorSetting; model: Model<Api> }> {
  if (!isAdvisorEnabled(state.effective) || state.diagnostics.some((d) => d.scope === "advisor"))
    return [];
  if (state.advisorEntries)
    return state.advisorEntries.flatMap((entry) =>
      entry.status.kind === "available" && !entry.errors.length
        ? [{ index: entry.index, setting: entry.setting, model: entry.status.model }]
        : [],
    );
  // Callers that construct a validated single-advisor state directly use the original map.
  const status = state.modelStatuses.get("advisor");
  return status?.kind === "available" && !state.advisorErrors?.length && state.effective.advisors[0]
    ? [{ index: 0, setting: state.effective.advisors[0], model: status.model }]
    : [];
}

/**
 * Every configured Advisor in its original position. A slot that cannot run keeps its index and an
 * own-text cause, so a group never silently shrinks to the valid advisors.
 */
export type AdvisorSlot = Readonly<{
  index: number;
  setting: AdvisorSetting;
  model?: Model<Api>;
  unavailable?: string;
}>;

export function advisorSlots(state: RuntimeState): AdvisorSlot[] {
  if (!isAdvisorEnabled(state.effective)) return [];
  // A stale or invalid Advisor companion disables the whole axis, exactly as `validAdvisors` does.
  const stale = state.diagnostics.find((diagnostic) => diagnostic.scope === "advisor");
  if (stale)
    return state.effective.advisors.map((setting, index) => ({
      index,
      setting,
      unavailable: stale.message,
    }));
  return state.effective.advisors.map((setting, index) => {
    const entry = state.advisorEntries?.find((candidate) => candidate.index === index);
    if (entry)
      return entry.status.kind === "available" && !entry.errors.length
        ? { index, setting, model: entry.status.model }
        : {
            index,
            setting,
            unavailable:
              entry.errors[0] ??
              `${index === 0 ? "Advisor" : `Advisor ${index + 1}`} model is unavailable.`,
          };
    // A directly constructed state (tests, single-advisor callers) uses the original map.
    const status = state.modelStatuses.get("advisor");
    return index === 0 && status?.kind === "available" && !state.advisorErrors?.length
      ? { index, setting, model: status.model }
      : {
          index,
          setting,
          unavailable: state.advisorErrors?.[0] ?? "Advisor model is unavailable.",
        };
  });
}

export function hasRuntimeError(state: RuntimeState): boolean {
  return state.runtimeErrors.length > 0;
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

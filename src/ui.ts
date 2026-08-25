import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  defaultsFromEffectiveState,
  getGlobalConfigPath,
  resolveDelegateState,
  writeConfig,
} from "./config.ts";
import {
  formatModelRef,
  loadRuntime,
  modelCandidates,
  sessionEntry,
  type RuntimeState,
} from "./runtime.ts";
import {
  emptySessionState,
  INTENSITIES,
  MODEL_ROLES,
  PREFERENCES,
  ROLE_LABELS,
  type Intensity,
  type ModelRef,
  type ModelRole,
  type Preference,
  type SessionDelegateState,
  type ValueSource,
} from "./types.ts";

const USE_GLOBAL_DEFAULT = "Use global default";
const DISABLE_FOR_SESSION = "Disable for this session";
const APPLY_TO_SESSION = "Apply changes to this session";
const SAVE_AS_DEFAULTS = "Save effective configuration as defaults";
const RESET_SESSION = "Reset draft to off";
const CANCEL = "Cancel";

type ModelSelection =
  { kind: "global" } | { kind: "disabled" } | { kind: "model"; reference: ModelRef } | undefined;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sourceLabel(source: ValueSource): string {
  if (source === "session") return "session";
  if (source === "global") return "global";
  return "built-in";
}

function modelOption(reference: ModelRef): string {
  return `${reference.provider}/${reference.model}`;
}

async function selectOrCancel(
  ctx: ExtensionContext,
  title: string,
  options: string[],
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  return ctx.ui.select(title, options);
}

async function selectModel(
  ctx: ExtensionContext,
  title: string,
  options: { includeDisable: boolean },
): Promise<ModelSelection> {
  const candidateOptions = new Map<string, ModelRef>();
  for (const [index, model] of modelCandidates(ctx)
    .sort((left, right) => {
      const provider = left.provider.localeCompare(right.provider);
      return provider === 0 ? left.id.localeCompare(right.id) : provider;
    })
    .entries()) {
    const option = `${index + 1}. ${model.provider}/${model.id}${
      model.name ? ` (${model.name})` : ""
    }`;
    candidateOptions.set(option, { provider: model.provider, model: model.id });
  }

  const selected = await selectOrCancel(ctx, title, [
    USE_GLOBAL_DEFAULT,
    ...(options.includeDisable ? [DISABLE_FOR_SESSION] : []),
    ...candidateOptions.keys(),
  ]);
  if (!selected) return undefined;
  if (selected === USE_GLOBAL_DEFAULT) return { kind: "global" };
  if (selected === DISABLE_FOR_SESSION) return { kind: "disabled" };
  const reference = candidateOptions.get(selected);
  return reference ? { kind: "model", reference } : undefined;
}

async function selectRole(
  ctx: ExtensionContext,
  draft: SessionDelegateState,
  role: ModelRole,
): Promise<void> {
  const selection = await selectModel(ctx, `${ROLE_LABELS[role]} model`, { includeDisable: false });
  if (!selection) return;
  if (selection.kind === "global") delete draft[role];
  else if (selection.kind === "model") draft[role] = selection.reference;
}

async function selectUiDesign(ctx: ExtensionContext, draft: SessionDelegateState): Promise<void> {
  const selection = await selectModel(ctx, "UI Design model", { includeDisable: true });
  if (!selection) return;
  if (selection.kind === "global") delete draft.uiDesign;
  else if (selection.kind === "disabled") draft.uiDesign = null;
  else draft.uiDesign = selection.reference;
}

async function selectIntensity(ctx: ExtensionContext, draft: SessionDelegateState): Promise<void> {
  const selected = await selectOrCancel(ctx, "Delegation intensity", [...INTENSITIES]);
  if (selected) draft.intensity = selected as Intensity;
}

async function selectPreference(ctx: ExtensionContext, draft: SessionDelegateState): Promise<void> {
  const selected = await selectOrCancel(ctx, "Model preference", [
    USE_GLOBAL_DEFAULT,
    ...PREFERENCES,
  ]);
  if (!selected) return;
  if (selected === USE_GLOBAL_DEFAULT) delete draft.preference;
  else draft.preference = selected as Preference;
}

function menuOptions(state: RuntimeState, draft: SessionDelegateState): string[] {
  const effective = resolveDelegateState(state.global, draft);
  const options = [
    `Intensity: ${effective.intensity} (${sourceLabel(effective.source.intensity)})`,
    `Preference: ${effective.preference} (${sourceLabel(effective.source.preference)})`,
    ...MODEL_ROLES.map(
      (role) =>
        `${ROLE_LABELS[role]}: ${formatModelRef(effective[role])} (${sourceLabel(
          effective.source[role],
        )})`,
    ),
    `UI Design: ${effective.uiDesign ? "on" : "off"} (${sourceLabel(effective.source.uiDesign)})`,
  ];

  if (effective.uiDesign) {
    options.push(
      `UI Design model: ${modelOption(effective.uiDesign)} (${sourceLabel(
        effective.source.uiDesign,
      )}; visual design only)`,
    );
  }

  return [...options, APPLY_TO_SESSION, SAVE_AS_DEFAULTS, RESET_SESSION, CANCEL];
}

function startsWithOption(choice: string, name: string): boolean {
  return choice.startsWith(`${name}:`);
}

export async function openDelegateEditor(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) return;

  const state = await loadRuntime(ctx);
  let draft = clone(state.session);

  while (true) {
    const effective = resolveDelegateState(state.global, draft);
    const selected = await selectOrCancel(ctx, "Delegation policy", menuOptions(state, draft));
    if (!selected || selected === CANCEL) return;

    if (startsWithOption(selected, "Intensity")) {
      await selectIntensity(ctx, draft);
      continue;
    }
    if (startsWithOption(selected, "Preference")) {
      await selectPreference(ctx, draft);
      continue;
    }
    const role = MODEL_ROLES.find((candidate) =>
      startsWithOption(selected, ROLE_LABELS[candidate]),
    );
    if (role) {
      await selectRole(ctx, draft, role);
      continue;
    }
    if (startsWithOption(selected, "UI Design model") || startsWithOption(selected, "UI Design")) {
      await selectUiDesign(ctx, draft);
      continue;
    }
    if (selected === APPLY_TO_SESSION) {
      state.session = clone(draft);
      sessionEntry(pi, state);
      ctx.ui.notify("Saved delegation settings for this session branch.", "info");
      return;
    }
    if (selected === SAVE_AS_DEFAULTS) {
      try {
        const defaults = defaultsFromEffectiveState(effective);
        await writeConfig(getGlobalConfigPath(), defaults);
        state.global = defaults;
        state.diagnostics = [];
        ctx.ui.notify("Saved effective role settings as global defaults.", "info");
      } catch {
        ctx.ui.notify(
          "Could not save global defaults. Session settings were not changed.",
          "error",
        );
      }
    }
    if (selected === RESET_SESSION) {
      draft = emptySessionState();
    }
  }
}

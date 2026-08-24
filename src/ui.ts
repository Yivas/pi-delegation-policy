import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getConfigPaths,
  isValidPresetName,
  parseConfig,
  writeConfig,
  type ConfigDocument,
  type ScopeName,
} from "./config.ts";
import {
  loadRuntime,
  sessionEntry,
  supportedThinkingLevels,
  validateAssignment,
  type RuntimeState,
} from "./runtime.ts";
import {
  MODES,
  STRATEGIES,
  TASK_CATEGORIES,
  TIERED_CATEGORIES,
  type DelegationCategory,
  type DelegationMode,
  type DelegationStrategy,
  type ModelAssignment,
  type Preset,
} from "./types.ts";

const DEFAULT_PRESET: Preset = {
  defaultMode: "normal",
  defaultStrategy: "tiered",
  enforcement: false,
  executorTools: [],
  tiered: {},
  taskBased: {},
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function scopeLabel(scope: ScopeName): string {
  return scope[0].toUpperCase() + scope.slice(1);
}

export function documentForScope(state: RuntimeState, scope: ScopeName): ConfigDocument {
  if (scope === "global") return clone(state.global);
  if (scope === "project") return clone(state.project);
  return {
    schemaVersion: 1,
    ...(state.session.activePreset ? { activePreset: state.session.activePreset } : {}),
    ...(state.session.mode ? { mode: state.session.mode } : {}),
    ...(state.session.strategy ? { strategy: state.session.strategy } : {}),
    presets: clone(state.session.presets ?? {}),
  };
}

export function effectivePresetForScope(
  state: RuntimeState,
  scope: ScopeName,
  name: string,
): Preset | undefined {
  if (scope === "session")
    return (
      state.session.presets?.[name] ?? state.project.presets[name] ?? state.global.presets[name]
    );
  if (scope === "project") return state.project.presets[name] ?? state.global.presets[name];
  return state.global.presets[name];
}

export function currentScopePresets(state: RuntimeState, scope: ScopeName): Record<string, Preset> {
  return documentForScope(state, scope).presets;
}

export function renameCurrentPreset(
  document: ConfigDocument,
  oldName: string,
  newName: string,
): boolean {
  if (
    !isValidPresetName(oldName) ||
    !isValidPresetName(newName) ||
    oldName === newName ||
    !document.presets[oldName] ||
    document.presets[newName]
  )
    return false;
  document.presets[newName] = document.presets[oldName];
  delete document.presets[oldName];
  if (document.activePreset === oldName) document.activePreset = newName;
  return true;
}

export function higherScopeReferencesPreset(
  state: RuntimeState,
  scope: ScopeName,
  name: string,
): boolean {
  if (scope === "global") {
    return state.project.activePreset === name || state.session.activePreset === name;
  }
  return scope === "project" && state.session.activePreset === name;
}

export function effectiveScopeNames(state: RuntimeState, scope: ScopeName): string[] {
  const names = new Set<string>(Object.keys(currentScopePresets(state, scope)));
  if (scope === "session") {
    for (const name of Object.keys(state.project.presets)) names.add(name);
    for (const name of Object.keys(state.global.presets)) names.add(name);
  } else if (scope === "project") {
    for (const name of Object.keys(state.global.presets)) names.add(name);
  }
  return [...names].sort();
}

function presetOption(state: RuntimeState, scope: ScopeName, name: string): string {
  return `${name} (${currentScopePresets(state, scope)[name] ? "current" : "inherited"})`;
}

function selectedPresetName(value: string): string {
  return value.replace(/ \((?:current|inherited)\)$/, "");
}

async function saveScope(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
  scope: ScopeName,
  document: ConfigDocument,
): Promise<void> {
  const parsed = parseConfig(document);
  if (!parsed) throw new Error("Refusing to save invalid delegation policy configuration.");
  if (scope === "session") {
    const nextSession = {
      schemaVersion: 1 as const,
      ...(parsed.activePreset ? { activePreset: parsed.activePreset } : {}),
      ...(parsed.mode ? { mode: parsed.mode } : {}),
      ...(parsed.strategy ? { strategy: parsed.strategy } : {}),
      ...(Object.keys(parsed.presets).length > 0 ? { presets: parsed.presets } : {}),
    };
    state.session = nextSession;
    sessionEntry(pi, state);
    return;
  }
  if (scope === "project" && !ctx.isProjectTrusted()) {
    throw new Error("The project is not trusted; project policy was not changed.");
  }
  const path = getConfigPaths(ctx.cwd)[scope];
  await writeConfig(path, parsed);
}

async function selectOrCancel(
  ctx: ExtensionContext,
  title: string,
  options: string[],
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  return ctx.ui.select(title, options);
}

async function editAssignment(
  ctx: ExtensionContext,
  preset: Preset,
  strategy: DelegationStrategy,
  category: DelegationCategory,
): Promise<void> {
  const assignments = strategy === "tiered" ? preset.tiered : preset.taskBased;
  const current = assignments[category as never] as ModelAssignment | undefined;
  const allModels = ctx.modelRegistry.getAll();
  const providers = [...new Set(allModels.map((model) => model.provider))].sort();
  const provider = await selectOrCancel(ctx, `${category}: provider`, [
    "(unassigned)",
    ...providers,
  ]);
  if (!provider) return;
  if (provider === "(unassigned)") {
    delete (assignments as Record<string, ModelAssignment | undefined>)[category];
    return;
  }
  const models = allModels.filter((model) => model.provider === provider);
  const modelId = await selectOrCancel(
    ctx,
    `${category}: model`,
    models.map(
      (model) =>
        `${model.id} — ${model.name}${ctx.modelRegistry.hasConfiguredAuth(model) ? "" : " [no credentials]"}`,
    ),
  );
  if (!modelId) return;
  const chosen = models.find((model) => model.id === modelId.split(" — ")[0]);
  if (!chosen) return;
  const thinking = await selectOrCancel(
    ctx,
    `${category}: thinking`,
    supportedThinkingLevels(chosen),
  );
  if (!thinking) return;
  const label = await ctx.ui.input(`${category}: label (optional)`, current?.label ?? "");
  const assignment: ModelAssignment = {
    provider,
    model: chosen.id,
    thinking,
    ...(label ? { label } : {}),
  };
  const status = await validateAssignment(ctx, assignment);
  if (status?.kind === "unsupported-thinking" || status?.kind === "missing-model") {
    ctx.ui.notify(`Exact assignment is invalid: ${status.kind}`, "error");
    return;
  }
  if (status?.kind === "no-credentials") {
    ctx.ui.notify(
      "Saved without credentials; this assignment will remain unavailable until the provider is authenticated.",
      "warning",
    );
  }
  assignments[category as never] = assignment as never;
}

async function editPreset(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
  presetName: string,
  scope: ScopeName,
): Promise<boolean> {
  const document = documentForScope(state, scope);
  const preset =
    document.presets[presetName] ??
    clone(effectivePresetForScope(state, scope, presetName) ?? DEFAULT_PRESET);
  while (true) {
    const choice = await selectOrCancel(ctx, `Edit preset ${presetName} (${scopeLabel(scope)})`, [
      `Default mode: ${preset.defaultMode}`,
      `Default strategy: ${preset.defaultStrategy}`,
      `Skill: ${preset.skill ?? "(unset)"}`,
      `Enforcement: ${preset.enforcement ? "on" : "off"}`,
      `Executor tools: ${preset.executorTools.join(", ") || "(none)"}`,
      "Tiered assignments",
      "Task-based assignments",
      "Save",
      "Cancel",
    ]);
    if (!choice || choice === "Cancel") return false;
    if (choice === "Save") {
      if (!isValidPresetName(presetName)) {
        ctx.ui.notify(
          "Invalid preset name. Use 1-64 letters, numbers, dots, underscores, or hyphens; start with a letter or number.",
          "error",
        );
        continue;
      }
      document.presets[presetName] = preset;
      await saveScope(pi, ctx, state, scope, document);
      Object.assign(state, await loadRuntime(ctx));
      ctx.ui.notify(`Saved preset ${presetName}.`, "info");
      return true;
    }
    if (choice.startsWith("Default mode:")) {
      const selected = await selectOrCancel(ctx, "Default mode", [...MODES]);
      if (selected) preset.defaultMode = selected as DelegationMode;
    } else if (choice.startsWith("Default strategy:")) {
      const selected = await selectOrCancel(ctx, "Default strategy", [...STRATEGIES]);
      if (selected) preset.defaultStrategy = selected as DelegationStrategy;
    } else if (choice.startsWith("Skill:")) {
      const skills = pi
        .getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => command.name.replace(/^skill:/, ""))
        .sort();
      const selected = await selectOrCancel(ctx, "External skill", ["(unset)", ...skills]);
      if (selected === "(unset)") delete preset.skill;
      else if (selected) preset.skill = selected;
    } else if (choice.startsWith("Enforcement:")) {
      preset.enforcement = !preset.enforcement;
    } else if (choice.startsWith("Executor tools:")) {
      const value = await ctx.ui.input(
        "Executor tool names (comma-separated)",
        preset.executorTools.join(", "),
      );
      preset.executorTools =
        value
          ?.split(",")
          .map((tool) => tool.trim())
          .filter(Boolean) ?? [];
    } else if (choice.endsWith("assignments")) {
      const assignmentStrategy: DelegationStrategy = choice.startsWith("Tiered")
        ? "tiered"
        : "task-based";
      const categories = assignmentStrategy === "tiered" ? TIERED_CATEGORIES : TASK_CATEGORIES;
      const category = await selectOrCancel(ctx, "Assignment category", [...categories, "Back"]);
      if (category && category !== "Back")
        await editAssignment(ctx, preset, assignmentStrategy, category as DelegationCategory);
    }
  }
}

export async function openDelegateEditor(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  const state = await loadRuntime(ctx);
  let scope: ScopeName = "session";
  while (true) {
    const presetNames = effectiveScopeNames(state, scope);
    const currentNames = Object.keys(currentScopePresets(state, scope)).sort();
    const selected = await selectOrCancel(ctx, "Delegation Policy", [
      `Scope: ${scopeLabel(scope)}`,
      `Active preset: ${state.effective.activePreset ?? "(none)"}`,
      `Mode: ${state.effective.mode}`,
      `Strategy: ${state.effective.strategy}`,
      `Presets: ${
        presetNames.map((name) => presetOption(state, scope, name)).join(", ") || "(none)"
      }`,
      "Edit active preset",
      "Create preset",
      "Duplicate preset",
      "Rename preset",
      "Delete preset",
      "Reset session overrides",
      "Close",
    ]);
    if (!selected || selected === "Close") return;
    if (selected.startsWith("Scope:")) {
      const scopes = ctx.isProjectTrusted()
        ? ["Global", "Project", "Session"]
        : ["Global", "Session"];
      const next = await selectOrCancel(ctx, "Edit scope", scopes);
      if (next) scope = next.toLowerCase() as ScopeName;
    } else if (selected.startsWith("Active preset:")) {
      const next = await selectOrCancel(ctx, "Active preset", ["(none)", ...presetNames]);
      if (next) {
        if (scope === "session") {
          state.session.activePreset = next === "(none)" ? undefined : next;
          sessionEntry(pi, state);
        } else {
          const document = documentForScope(state, scope);
          document.activePreset = next === "(none)" ? undefined : next;
          await saveScope(pi, ctx, state, scope, document);
        }
        Object.assign(state, await loadRuntime(ctx));
      }
    } else if (selected.startsWith("Mode:")) {
      const next = await selectOrCancel(ctx, `${scopeLabel(scope)} mode`, [...MODES]);
      if (next) {
        if (scope === "session") {
          state.session.mode = next as DelegationMode;
          sessionEntry(pi, state);
        } else {
          const document = documentForScope(state, scope);
          document.mode = next as DelegationMode;
          await saveScope(pi, ctx, state, scope, document);
        }
        Object.assign(state, await loadRuntime(ctx));
      }
    } else if (selected.startsWith("Strategy:")) {
      const next = await selectOrCancel(ctx, `${scopeLabel(scope)} strategy`, [...STRATEGIES]);
      if (next) {
        if (scope === "session") {
          state.session.strategy = next as DelegationStrategy;
          sessionEntry(pi, state);
        } else {
          const document = documentForScope(state, scope);
          document.strategy = next as DelegationStrategy;
          await saveScope(pi, ctx, state, scope, document);
        }
        Object.assign(state, await loadRuntime(ctx));
      }
    } else if (selected === "Edit active preset") {
      if (state.effective.activePreset)
        await editPreset(pi, ctx, state, state.effective.activePreset, scope);
      else ctx.ui.notify("Select or create a preset first.", "warning");
    } else if (selected === "Create preset") {
      const input = await ctx.ui.input("New preset name", "balanced");
      const name = input?.trim();
      if (!name) continue;
      if (!isValidPresetName(name)) {
        ctx.ui.notify(
          "Invalid preset name. Use 1-64 letters, numbers, dots, underscores, or hyphens; start with a letter or number.",
          "error",
        );
        continue;
      }
      await editPreset(pi, ctx, state, name, scope);
    } else if (selected === "Duplicate preset") {
      const options = presetNames.map((name) => presetOption(state, scope, name));
      const selectedFrom = await selectOrCancel(ctx, "Duplicate preset", options);
      const from = selectedFrom ? selectedPresetName(selectedFrom) : undefined;
      const input = from ? await ctx.ui.input("New preset name", `${from}-copy`) : undefined;
      const name = input?.trim();
      if (!from || !name) continue;
      if (!isValidPresetName(name)) {
        ctx.ui.notify(
          "Invalid preset name. Use 1-64 letters, numbers, dots, underscores, or hyphens; start with a letter or number.",
          "error",
        );
        continue;
      }
      const source = effectivePresetForScope(state, scope, from);
      if (!source) {
        ctx.ui.notify(`Preset ${from} is not available in this scope.`, "error");
        continue;
      }
      if (effectivePresetForScope(state, scope, name)) {
        ctx.ui.notify(`Preset ${name} already exists in this scope hierarchy.`, "error");
        continue;
      }
      const document = documentForScope(state, scope);
      document.presets[name] = clone(source);
      await saveScope(pi, ctx, state, scope, document);
      Object.assign(state, await loadRuntime(ctx));
      ctx.ui.notify(`Duplicated ${from} as ${name} in ${scopeLabel(scope)} scope.`, "info");
    } else if (selected === "Rename preset") {
      if (!currentNames.length) {
        ctx.ui.notify("Only presets defined in the current scope can be renamed.", "warning");
        continue;
      }
      const selectedOld = await selectOrCancel(
        ctx,
        "Rename current-scope preset",
        currentNames.map((name) => presetOption(state, scope, name)),
      );
      const oldName = selectedOld ? selectedPresetName(selectedOld) : undefined;
      const input = oldName ? await ctx.ui.input("New preset name", oldName) : undefined;
      const newName = input?.trim();
      if (!oldName || !newName || oldName === newName) continue;
      if (!isValidPresetName(newName)) {
        ctx.ui.notify(
          "Invalid preset name. Use 1-64 letters, numbers, dots, underscores, or hyphens; start with a letter or number.",
          "error",
        );
        continue;
      }
      if (higherScopeReferencesPreset(state, scope, oldName)) {
        ctx.ui.notify(
          `Preset ${oldName} is selected by a higher scope. Change that active preset before renaming it.`,
          "warning",
        );
        continue;
      }
      const document = documentForScope(state, scope);
      if (state.effective.activePreset === oldName && !document.activePreset) {
        document.activePreset = oldName;
      }
      if (effectivePresetForScope(state, scope, newName)) {
        ctx.ui.notify(`Preset ${newName} already exists in this scope hierarchy.`, "error");
        continue;
      }
      if (!renameCurrentPreset(document, oldName, newName)) {
        ctx.ui.notify(`Preset ${oldName} is not defined in the current scope.`, "error");
        continue;
      }
      await saveScope(pi, ctx, state, scope, document);
      Object.assign(state, await loadRuntime(ctx));
      ctx.ui.notify(`Renamed ${oldName} to ${newName}.`, "info");
    } else if (selected === "Delete preset") {
      const options = presetNames.map((name) => presetOption(state, scope, name));
      const selectedName = await selectOrCancel(ctx, "Delete preset", options);
      const name = selectedName ? selectedPresetName(selectedName) : undefined;
      if (!name) continue;
      if (!currentScopePresets(state, scope)[name]) {
        ctx.ui.notify(
          `Preset ${name} is inherited; delete an override in the current scope instead.`,
          "warning",
        );
        continue;
      }
      if (higherScopeReferencesPreset(state, scope, name)) {
        ctx.ui.notify(
          `Preset ${name} is selected by a higher scope. Change that active preset before deleting it.`,
          "warning",
        );
        continue;
      }
      if (await ctx.ui.confirm("Delete current-scope preset override?", name)) {
        const document = documentForScope(state, scope);
        delete document.presets[name];
        if (document.activePreset === name) delete document.activePreset;
        await saveScope(pi, ctx, state, scope, document);
        Object.assign(state, await loadRuntime(ctx));
        ctx.ui.notify(`Deleted ${name} from ${scopeLabel(scope)} scope.`, "info");
      }
    } else if (selected === "Reset session overrides") {
      state.session = { schemaVersion: 1, reset: true };
      sessionEntry(pi, state);
      Object.assign(state, await loadRuntime(ctx));
      ctx.ui.notify("Session overrides reset.", "info");
    }
  }
}

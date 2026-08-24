import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getConfigPaths,
  readConfig,
  restoreLoadedSkills,
  restoreSessionState,
  resolveConfig,
  SKILL_LOADED_ENTRY_TYPE,
  SKILL_RESET_ENTRY_TYPE,
  SESSION_ENTRY_TYPE,
  type ConfigDiagnostic,
} from "./config.ts";
import {
  TASK_CATEGORIES,
  TIERED_CATEGORIES,
  type DelegationCategory,
  type EffectiveConfig,
  type ModelAssignment,
  type ModelStatus,
} from "./types.ts";

export type RuntimeState = {
  effective: EffectiveConfig;
  global: Awaited<ReturnType<typeof readConfig>>["config"];
  project: Awaited<ReturnType<typeof readConfig>>["config"];
  session: ReturnType<typeof restoreSessionState>;
  diagnostics: ConfigDiagnostic[];
  loadedSkills: Map<string, string>;
  skillFiles: Map<string, string>;
  skillsDiscovered: boolean;
  assignmentStatuses: Map<string, ModelStatus>;
  runtimeErrors: string[];
  cwd: string;
};

function discoveredSkillFiles(ctx: ExtensionContext): {
  files: Map<string, string>;
  discovered: boolean;
} {
  const options = (
    ctx as ExtensionContext & {
      getSystemPromptOptions?: () => { skills?: Array<{ name: string; filePath: string }> };
    }
  ).getSystemPromptOptions?.();
  return {
    files: new Map((options?.skills ?? []).map((skill) => [skill.name, skill.filePath])),
    discovered: options !== undefined,
  };
}

export async function loadRuntime(ctx: ExtensionContext): Promise<RuntimeState> {
  const paths = getConfigPaths(ctx.cwd);
  const global = await readConfig(paths.global, "global");
  const project = ctx.isProjectTrusted()
    ? await readConfig(paths.project, "project")
    : { config: { schemaVersion: 1 as const, presets: {} }, diagnostics: [] };
  const branch = ctx.sessionManager.getBranch();
  const session = restoreSessionState(branch);
  const loadedSkills = restoreLoadedSkills(branch);
  const skills = discoveredSkillFiles(ctx);
  const state: RuntimeState = {
    effective: resolveConfig(global.config, project.config, session),
    global: global.config,
    project: project.config,
    session,
    diagnostics: [...global.diagnostics, ...project.diagnostics],
    loadedSkills,
    skillFiles: skills.files,
    skillsDiscovered: skills.discovered,
    assignmentStatuses: new Map(),
    runtimeErrors: [],
    cwd: ctx.cwd,
  };
  await validateRuntime(ctx, state);
  return state;
}

export function assignmentFor(
  state: RuntimeState,
  category: DelegationCategory,
): ModelAssignment | undefined {
  const preset = state.effective.preset;
  if (!preset) return undefined;
  return state.effective.strategy === "tiered"
    ? preset.tiered[category as (typeof TIERED_CATEGORIES)[number]]
    : preset.taskBased[category as (typeof TASK_CATEGORIES)[number]];
}

export function activeCategories(state: RuntimeState): readonly string[] {
  return state.effective.strategy === "tiered" ? TIERED_CATEGORIES : TASK_CATEGORIES;
}

export function skillIsLoaded(state: RuntimeState, skillName: string | undefined): boolean {
  if (!skillName) return false;
  const loadedPath = state.loadedSkills.get(skillName);
  const currentPath = state.skillFiles.get(skillName);
  return (
    !!loadedPath &&
    !!currentPath &&
    normalizePathForComparison(state.cwd, loadedPath) ===
      normalizePathForComparison(state.cwd, currentPath)
  );
}

export function markSkillLoaded(
  pi: { appendEntry: (type: string, data?: unknown) => void },
  state: RuntimeState,
  skillName: string,
): void {
  const filePath = state.skillFiles.get(skillName);
  if (!filePath || skillIsLoaded(state, skillName)) return;
  state.loadedSkills.set(skillName, filePath);
  pi.appendEntry(SKILL_LOADED_ENTRY_TYPE, { name: skillName, filePath });
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function supportedThinkingLevels(model: Model<Api>): string[] {
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap;
  if (!map) return THINKING_LEVELS.slice(0, 5);
  return THINKING_LEVELS.filter((level) => {
    if (level === "xhigh" || level === "max") return map[level] != null;
    return map[level] !== null;
  });
}

export function supportedThinking(model: Model<Api>, thinking: string): boolean {
  return supportedThinkingLevels(model).includes(thinking);
}

export async function validateAssignment(
  ctx: ExtensionContext,
  assignment: ModelAssignment | undefined,
): Promise<ModelStatus | undefined> {
  if (!assignment) return undefined;
  const model = ctx.modelRegistry.find(assignment.provider, assignment.model);
  if (!model) return { kind: "missing-model" };
  if (!supportedThinking(model, assignment.thinking))
    return { kind: "unsupported-thinking", model };
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { kind: "no-credentials", model };
  return { kind: "available", model };
}

function skillIsAvailable(state: RuntimeState, skillName: string | undefined): boolean {
  return !!skillName && state.skillFiles.has(skillName);
}

export function assignmentStatusKey(strategy: string, category: string): string {
  return `${strategy}:${category}`;
}

export function modelStatusDetail(status: ModelStatus): string {
  if (status.kind === "available") return "available";
  if (status.kind === "missing-model") return "model not found in Pi's registry";
  if (status.kind === "no-credentials") return "provider has no configured credentials";
  return "thinking level is unsupported by the model";
}

export async function validateRuntime(ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  state.assignmentStatuses.clear();
  state.runtimeErrors = [];
  if (state.effective.mode === "off" || !state.effective.preset) return;
  for (const category of activeCategories(state)) {
    const assignment = assignmentFor(state, category as DelegationCategory);
    if (!assignment) continue;
    const status = await validateAssignment(ctx, assignment);
    if (!status) continue;
    state.assignmentStatuses.set(assignmentStatusKey(state.effective.strategy, category), status);
    if (status.kind !== "available") {
      state.runtimeErrors.push(
        `${category}: ${formatAssignment(assignment)} (${modelStatusDetail(status)})`,
      );
    }
  }
  const preset = state.effective.preset;
  if (state.skillsDiscovered && !skillIsAvailable(state, preset.skill)) {
    state.runtimeErrors.push(
      `skill: ${preset.skill ? `"${preset.skill}" is not discovered` : "no external skill is configured"}`,
    );
  }
}

export function validateExecutorTools(state: RuntimeState, toolNames: Iterable<string>): void {
  if (state.effective.mode === "off" || !state.effective.preset) return;
  const available = new Set(toolNames);
  for (const tool of state.effective.preset.executorTools) {
    if (!available.has(tool))
      state.runtimeErrors.push(`executor tool: "${tool}" is not registered`);
  }
}

export function hasRuntimeError(state: RuntimeState): boolean {
  const preset = state.effective.preset;
  if (state.diagnostics.length > 0 || state.runtimeErrors.length > 0) return true;
  if (state.effective.mode === "off") return false;
  if (!preset) return true;
  return state.skillsDiscovered && !skillIsAvailable(state, preset.skill);
}

export function recordSkillFromExpandedPrompt(
  pi: { appendEntry: (type: string, data?: unknown) => void },
  state: RuntimeState,
  pendingSkill: string | undefined,
  prompt: string,
): void {
  const skillName = state.effective.preset?.skill;
  if (!skillName || pendingSkill !== skillName) return;
  const skillPath = state.skillFiles.get(skillName);
  if (!skillPath) return;
  const opener = `<skill name="${skillName}" location="${skillPath}">`;
  if (prompt.startsWith(`${opener}\n`) && prompt.includes("\n</skill>"))
    markSkillLoaded(pi, state, skillName);
}

export function resetLoadedSkills(
  pi: { appendEntry: (type: string, data?: unknown) => void },
  state: RuntimeState,
): void {
  state.loadedSkills.clear();
  pi.appendEntry(SKILL_RESET_ENTRY_TYPE, true);
}

export function normalizePathForComparison(
  cwd: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = resolve(cwd, value.replace(/^@/, "")).replaceAll("\\", "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function recordSkillFromRead(
  pi: { appendEntry: (type: string, data?: unknown) => void },
  state: RuntimeState,
  input: unknown,
): void {
  const skillName = state.effective.preset?.skill;
  if (!skillName || typeof input !== "object" || input === null) return;
  const path = (input as { path?: unknown }).path;
  const skillPath = state.skillFiles.get(skillName);
  if (typeof path !== "string" || !skillPath) return;
  if (
    normalizePathForComparison(state.cwd, path) === normalizePathForComparison(state.cwd, skillPath)
  ) {
    markSkillLoaded(pi, state, skillName);
  }
}

export function executorBlocked(state: RuntimeState, toolName: string): boolean {
  const preset = state.effective.preset;
  return (
    state.effective.mode !== "off" &&
    !!preset?.enforcement &&
    !!preset.skill &&
    preset.executorTools.includes(toolName) &&
    !skillIsLoaded(state, preset.skill)
  );
}

export function formatAssignment(assignment: ModelAssignment | undefined): string {
  if (!assignment) return "unassigned";
  return `${assignment.provider}/${assignment.model}:${assignment.thinking}`;
}

export function assignmentDisplay(
  state: RuntimeState,
  category: string,
  assignment: ModelAssignment | undefined,
): string {
  const status = state.assignmentStatuses.get(
    assignmentStatusKey(state.effective.strategy, category),
  );
  if (!assignment || !status || status.kind === "available") return formatAssignment(assignment);
  return `${formatAssignment(assignment)} [unavailable: ${modelStatusDetail(status)}]`;
}

export function statusLabel(state: RuntimeState): string {
  if (hasRuntimeError(state)) return "D:ERR";
  if (state.effective.mode === "off") return "D:OFF";
  return state.effective.mode === "normal" ? "D:NORM" : "D:AGG";
}

export function sessionEntry(
  pi: { appendEntry: (type: string, data?: unknown) => void },
  state: RuntimeState,
): void {
  pi.appendEntry(SESSION_ENTRY_TYPE, state.session);
}

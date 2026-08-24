import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { SESSION_ENTRY_TYPE } from "./config.ts";
import { buildDelegationPolicy } from "./prompt.ts";
import {
  executorBlocked,
  hasRuntimeError,
  loadRuntime as reloadRuntime,
  recordSkillFromExpandedPrompt,
  recordSkillFromRead,
  resetLoadedSkills,
  skillIsLoaded,
  statusLabel,
  validateExecutorTools,
  validateRuntime,
  type RuntimeState,
} from "./runtime.ts";
import { openDelegateEditor } from "./ui.ts";
import { MODES, type DelegationMode } from "./types.ts";

const STATUS_KEY = "pi-delegation-policy";

export type CommandAction =
  | { kind: "open" }
  | { kind: "mode"; mode: DelegationMode }
  | { kind: "status" }
  | { kind: "reset" }
  | { kind: "invalid" };

export function parseCommand(args: string): CommandAction {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "open" };
  if (parts[0] === "status" && parts.length === 1) return { kind: "status" };
  if (parts[0] === "reset" && parts.length === 1) return { kind: "reset" };
  if (parts.length === 1 && MODES.includes(parts[0] as DelegationMode))
    return { kind: "mode", mode: parts[0] as DelegationMode };
  return { kind: "invalid" };
}

export function getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const options = [...MODES, "status", "reset"];
  const matches = options.filter((option) => option.startsWith(prefix.toLowerCase()));
  return matches.length ? matches.map((value) => ({ value, label: value })) : null;
}

async function refresh(pi: ExtensionAPI, ctx: ExtensionContext): Promise<RuntimeState> {
  const state = await reloadRuntime(ctx);
  validateExecutorTools(
    state,
    pi.getAllTools().map((tool) => tool.name),
  );
  // Keep the latest runtime state on the extension instance without exposing it to Pi.
  (pi as ExtensionAPI & { __delegationPolicyState?: RuntimeState }).__delegationPolicyState = state;
  return state;
}

function currentState(pi: ExtensionAPI): RuntimeState | undefined {
  return (pi as ExtensionAPI & { __delegationPolicyState?: RuntimeState }).__delegationPolicyState;
}

function updateStatus(ctx: ExtensionContext, state: RuntimeState): void {
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", statusLabel(state, ctx)));
}

async function quickMode(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  mode: DelegationMode,
): Promise<void> {
  const state = await refresh(pi, ctx);
  state.session = { ...state.session, schemaVersion: 1, mode };
  pi.appendEntry(SESSION_ENTRY_TYPE, state.session);
  await refresh(pi, ctx);
  ctx.ui.notify(`Session delegation mode: ${mode}.`, "info");
}

function statusText(state: RuntimeState, ctx: ExtensionContext): string {
  const preset = state.effective.preset;
  const skill = preset?.skill ?? "(unset)";
  const skillAvailable = skill !== "(unset)" && state.skillFiles.has(skill);
  const skillLoaded = skillAvailable && skillIsLoaded(state, skill, ctx);
  const assignmentErrors = state.runtimeErrors.length
    ? ` | details=${state.runtimeErrors.join("; ")}`
    : "";
  return (
    [
      `${statusLabel(state, ctx)} mode=${state.effective.mode}`,
      `strategy=${state.effective.strategy}`,
      `preset=${state.effective.activePreset ?? "(none)"}`,
      `skill=${skill} ${
        !state.skillsDiscovered
          ? "unknown"
          : skillAvailable
            ? skillLoaded
              ? "loaded"
              : "available"
            : "missing"
      }`,
      `enforcement=${preset?.enforcement ? "on" : "off"}`,
      state.runtimeErrors.length ? `errors=${state.runtimeErrors.length}` : "errors=0",
    ].join(" | ") + assignmentErrors
  );
}

export default function piDelegationPolicy(pi: ExtensionAPI): void {
  let pendingSkillLoad: string | undefined;

  pi.registerCommand("delegate", {
    description: "Configure delegation policy, presets, skills, and exact model assignments",
    getArgumentCompletions,
    handler: async (args, ctx) => {
      const action = parseCommand(args);
      if (action.kind === "open") {
        await openDelegateEditor(ctx, pi);
        return;
      }
      if (action.kind === "status") {
        const state = await refresh(pi, ctx);
        ctx.ui.notify(statusText(state, ctx), hasRuntimeError(state, ctx) ? "error" : "info");
        return;
      }
      if (action.kind === "reset") {
        const state = await refresh(pi, ctx);
        state.session = { schemaVersion: 1, reset: true };
        pi.appendEntry(SESSION_ENTRY_TYPE, state.session);
        await refresh(pi, ctx);
        ctx.ui.notify("Session delegation overrides reset.", "info");
        return;
      }
      if (action.kind === "mode") {
        await quickMode(pi, ctx, action.mode);
        return;
      }
      ctx.ui.notify("Usage: /delegate, /delegate off|normal|aggressive|status|reset", "error");
    },
  });

  pi.registerShortcut("ctrl+shift+d", {
    description: "Open delegation policy",
    handler: async (ctx) => openDelegateEditor(ctx, pi),
  });

  pi.on("session_start", async (_event, ctx) => {
    const state = await refresh(pi, ctx);
    updateStatus(ctx, state);
  });
  pi.on("session_tree", async (_event, ctx) => {
    const state = await refresh(pi, ctx);
    updateStatus(ctx, state);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const state = await refresh(pi, ctx);
    state.skillFiles = new Map(
      (event.systemPromptOptions.skills ?? []).map((skill) => [skill.name, skill.filePath]),
    );
    state.skillsDiscovered = true;
    recordSkillFromExpandedPrompt(pi, state, pendingSkillLoad, event.prompt);
    pendingSkillLoad = undefined;
    await validateRuntime(ctx, state);
    validateExecutorTools(
      state,
      pi.getAllTools().map((tool) => tool.name),
    );
    updateStatus(ctx, state);
    const policy = buildDelegationPolicy(state);
    return policy ? { systemPrompt: `${event.systemPrompt}\n\n${policy}` } : undefined;
  });
  pi.on("input", (event) => {
    const state = currentState(pi);
    const skill = state?.effective.preset?.skill;
    const commandExists =
      !!skill &&
      pi
        .getCommands()
        .some((command) => command.source === "skill" && command.name === `skill:${skill}`);
    pendingSkillLoad =
      commandExists && event.text.trim().match(/^\/skill:([^\s]+)(?:\s|$)/)?.[1] === skill
        ? skill
        : undefined;
  });
  pi.on("tool_result", (event, _ctx) => {
    const state = currentState(pi);
    if (state && event.toolName === "read" && !event.isError)
      recordSkillFromRead(pi, state, event.input);
  });
  pi.on("tool_call", (event, ctx) => {
    const state = currentState(pi);
    if (!state || !executorBlocked(state, ctx, event.toolName)) return;
    const skill = state.effective.preset?.skill;
    return {
      block: true,
      reason: `Load the configured skill "${skill}" before using ${event.toolName}.`,
    };
  });
  pi.on("session_compact", (_event, _ctx) => {
    const state = currentState(pi);
    if (state) resetLoadedSkills(pi, state);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    pendingSkillLoad = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

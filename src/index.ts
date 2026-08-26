import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { buildDelegationPolicy } from "./prompt.ts";
import {
  hasRuntimeError,
  loadRuntime,
  sessionEntry,
  statusLabel,
  type RuntimeState,
} from "./runtime.ts";
import { openDelegateEditor } from "./ui.ts";
import { INTENSITIES, type Intensity } from "./types.ts";

const STATUS_KEY = "pi-delegation-policy";

export type CommandAction =
  | { kind: "open" }
  | { kind: "intensity"; intensity: Intensity }
  | { kind: "status" }
  | { kind: "reset" }
  | { kind: "invalid" };

export function parseCommand(args: string): CommandAction {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "open" };
  if (parts[0] === "status" && parts.length === 1) return { kind: "status" };
  if (parts[0] === "reset" && parts.length === 1) return { kind: "reset" };
  if (parts.length === 1 && INTENSITIES.includes(parts[0] as Intensity)) {
    return { kind: "intensity", intensity: parts[0] as Intensity };
  }
  return { kind: "invalid" };
}

export function getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const options = [...INTENSITIES, "status", "reset"];
  const matches = options.filter((option) => option.startsWith(prefix.toLowerCase()));
  return matches.length ? matches.map((value) => ({ value, label: value })) : null;
}

async function refresh(ctx: ExtensionContext): Promise<RuntimeState> {
  return loadRuntime(ctx);
}

function updateStatus(ctx: ExtensionContext, state: RuntimeState): void {
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", statusLabel(state)));
}

async function openEditor(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await openDelegateEditor(ctx, pi);
  updateStatus(ctx, await refresh(ctx));
}

function configuredLabel(value: unknown): string {
  return value ? "configured" : "unset";
}

export function statusText(state: RuntimeState): string {
  const { effective } = state;
  const details = [
    `${statusLabel(state)} intensity=${effective.intensity} (${effective.source.intensity})`,
    `preference=${effective.preference} (${effective.source.preference})`,
    `small=${configuredLabel(effective.small)} (${effective.source.small})`,
    `medium=${configuredLabel(effective.medium)} (${effective.source.medium})`,
    `large=${configuredLabel(effective.large)} (${effective.source.large})`,
    `ui-design=${configuredLabel(effective.uiDesign)} (${effective.source.uiDesign})`,
  ];

  if (effective.intensity !== "off" && state.runtimeErrors.length > 0) {
    details.push(`details=${state.runtimeErrors.join("; ")}`);
  }
  return details.join(" | ");
}

async function setSessionIntensity(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  intensity: Intensity,
): Promise<void> {
  const state = await refresh(ctx);
  state.session = { ...state.session, schemaVersion: 2, intensity };
  sessionEntry(pi, state);
  const updated = await refresh(ctx);
  updateStatus(ctx, updated);
  ctx.ui.notify(`Session delegation intensity: ${intensity}.`, "info");
}

async function resetSession(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const state = await refresh(ctx);
  state.session = { schemaVersion: 2, intensity: "off" };
  sessionEntry(pi, state);
  const updated = await refresh(ctx);
  updateStatus(ctx, updated);
  ctx.ui.notify("Session delegation settings reset to off.", "info");
}

export default function piDelegationPolicy(pi: ExtensionAPI): void {
  pi.registerCommand("delegate", {
    description: "Configure delegation intensity and exact role model references",
    getArgumentCompletions,
    handler: async (args, ctx) => {
      const action = parseCommand(args);
      if (action.kind === "open") {
        await openEditor(pi, ctx);
        return;
      }
      if (action.kind === "status") {
        const state = await refresh(ctx);
        updateStatus(ctx, state);
        ctx.ui.notify(statusText(state), hasRuntimeError(state) ? "error" : "info");
        return;
      }
      if (action.kind === "reset") {
        await resetSession(pi, ctx);
        return;
      }
      if (action.kind === "intensity") {
        await setSessionIntensity(pi, ctx, action.intensity);
        return;
      }
      ctx.ui.notify("Usage: /delegate, /delegate off|normal|aggressive|status|reset", "error");
    },
  });

  pi.registerShortcut("alt+g", {
    description: "Open delegation policy",
    handler: async (ctx) => openEditor(pi, ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx, await refresh(ctx));
  });
  pi.on("session_tree", async (_event, ctx) => {
    updateStatus(ctx, await refresh(ctx));
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const state = await refresh(ctx);
    updateStatus(ctx, state);
    const policy = buildDelegationPolicy(state);
    return policy ? { systemPrompt: `${event.systemPrompt}\n\n${policy}` } : undefined;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

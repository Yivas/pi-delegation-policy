import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendGuardedSessionState,
  defaultsFromEffectiveState,
  getGlobalConfigPath,
  resolveDelegateState,
  writeConfig,
} from "./config.ts";
import { DelegatePanel, type DelegatePanelResult } from "./delegate-panel.ts";
import { hasRuntimeError, loadRuntime, modelCandidates } from "./runtime.ts";

export async function openDelegateEditor(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) return;
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "The delegation editor requires TUI mode. Use /delegate off, normal, aggressive, status, or reset here.",
      "warning",
    );
    return;
  }

  const state = await loadRuntime(ctx);
  const candidates = modelCandidates(ctx);

  const result = await ctx.ui.custom<DelegatePanelResult>(
    (tui, theme, _keybindings, done) =>
      new DelegatePanel({
        tui,
        theme,
        global: state.global,
        session: state.session,
        candidates,
        diagnostics:
          state.effective.intensity === "off"
            ? state.diagnostics
                .filter(({ reportWhenOff }) => reportWhenOff)
                .map(({ message }) => message)
            : [...state.runtimeErrors],
        hasRuntimeError: hasRuntimeError(state),
        onApply: async (draft) => {
          const result = appendGuardedSessionState(pi, structuredClone(draft));
          const refreshed = await loadRuntime(ctx);
          state.global = refreshed.global;
          state.session = refreshed.session;
          state.diagnostics = refreshed.diagnostics;
          state.effective = refreshed.effective;
          state.modelStatuses = refreshed.modelStatuses;
          state.runtimeErrors = refreshed.runtimeErrors;
          return result === "success";
        },
        onSaveDefaults: async (draft) => {
          try {
            const defaults = defaultsFromEffectiveState(resolveDelegateState(state.global, draft));
            await writeConfig(getGlobalConfigPath(), defaults);
            state.global = defaults;
            state.diagnostics = [];
            return defaults;
          } catch {
            return undefined;
          }
        },
        onDone: done,
      }),
  );

  if (result === "applied") {
    try {
      ctx.ui.notify("Applied delegation settings to this session branch.", "info");
    } catch {
      // The session entry is authoritative; notification failure must not invite a retry.
    }
  }
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendGuardedSessionState,
  defaultsFromEffectiveState,
  getGlobalConfigPath,
  readConfig,
  resolveDelegateState,
  writeConfig,
} from "./config.ts";
import { DelegatePanel, type DelegatePanelResult } from "./delegate-panel.ts";
import {
  hasRuntimeError,
  hasAdvisorError,
  isAdvisorEnabled,
  loadRuntime,
  modelCandidates,
} from "./runtime.ts";

export async function openDelegateEditor(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) return;
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "The delegation editor requires TUI mode. Use /delegate off, normal, aggressive, orchestrator, status, reset, advisor off|on|with-delegation, or context off|observe|enforce|status here.",
      "warning",
    );
    return;
  }

  const state = await loadRuntime(ctx);
  const candidates = modelCandidates(ctx);
  // A diagnostic that no error list reports yet stays informative in the panel instead of being
  // dropped, and it never becomes an Advisor error: an Advisor-scope diagnostic is already an error
  // while Advisor is on, and an ordinary one is already an error while delegation is active.
  const reportedErrors = new Set([...state.runtimeErrors, ...(state.advisorErrors ?? [])]);
  const advisorNotices = state.diagnostics
    .filter(({ message }) => !reportedErrors.has(message))
    .map(({ message }) => message);

  const result = await ctx.ui.custom<DelegatePanelResult>(
    (tui, theme, _keybindings, done) =>
      new DelegatePanel({
        tui,
        theme,
        global: state.global,
        session: state.session,
        candidates,
        diagnostics:
          state.effective.intensity === "off" && !isAdvisorEnabled(state.effective)
            ? state.diagnostics
                .filter(({ reportWhenOff }) => reportWhenOff)
                .map(({ message }) => message)
            : [...state.runtimeErrors, ...(state.advisorErrors ?? []), ...advisorNotices],
        hasRuntimeError: hasRuntimeError(state),
        hasAdvisorError: hasAdvisorError(state),
        onApply: async (draft) => {
          const result = appendGuardedSessionState(pi, structuredClone(draft));
          const refreshed = await loadRuntime(ctx);
          state.global = refreshed.global;
          state.session = refreshed.session;
          state.diagnostics = refreshed.diagnostics;
          state.effective = refreshed.effective;
          state.modelStatuses = refreshed.modelStatuses;
          state.runtimeErrors = refreshed.runtimeErrors;
          state.advisorErrors = refreshed.advisorErrors;
          return result === "success";
        },
        onSaveDefaults: async (draft) => {
          const defaults = defaultsFromEffectiveState(resolveDelegateState(state.global, draft));
          const result = await writeConfig(getGlobalConfigPath(), defaults);
          if (result === "saved") {
            state.global = defaults;
            state.diagnostics = [];
            return { kind: "saved", defaults };
          }
          if (result === "unchanged") return { kind: "unchanged" };
          // The pair could not be completed or confirmed: show what the files actually hold.
          const loaded = await readConfig(getGlobalConfigPath());
          state.global = loaded.defaults;
          state.diagnostics = loaded.diagnostics;
          return {
            kind: "partial",
            defaults: loaded.defaults,
            diagnostics: loaded.diagnostics.map(({ message }) => message),
          };
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

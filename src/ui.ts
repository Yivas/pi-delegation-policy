import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  defaultsFromEffectiveState,
  getGlobalConfigPath,
  resolveDelegateState,
  writeConfig,
} from "./config.ts";
import { DelegatePanel, type DelegatePanelResult } from "./delegate-panel.ts";
import { loadRuntime, modelCandidates, sessionEntry } from "./runtime.ts";

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
        diagnostics: state.diagnostics.map((diagnostic) => diagnostic.message),
        onApply: async (draft) => {
          const session = structuredClone(draft);
          sessionEntry(pi, { ...state, session });
          state.session = session;
          return true;
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

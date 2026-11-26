import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendGuardedSessionState,
  defaultsFromEffectiveState,
  getGlobalConfigPath,
  readConfig,
  resolveDelegateState,
  writeConfig,
} from "./config.ts";
import { ANTHROPIC_PROVIDER_PACKAGE } from "./advisor-anthropic-provider.ts";
import { DelegatePanel, type DelegatePanelResult } from "./delegate-panel.ts";
import { getProviderAdmissionsPath, writeProviderAdmissions } from "./provider-admissions.ts";
import { getLaunchCorrectionPath, writeLaunchCorrectionMode } from "./launch-correction-mode.ts";
import { emptyAdvisorLevelFile, writeAdvisorLevelFile } from "./advisor-level.ts";
import { writeGuardMode } from "./guard-mode.ts";
import { writeRoleEntries } from "./role-entries.ts";
import { trimAdvisorRead, writeAdvisorRead } from "./advisor-read-mode.ts";
import { trimAdvisorFilter, writeAdvisorFilters } from "./advisor-filter-mode.ts";
import { listProviderExtensionCandidates } from "./provider-package.ts";
import {
  hasRuntimeError,
  hasAdvisorError,
  isAdvisorEnabled,
  loadRuntime,
  modelCandidates,
  validateModelReference,
} from "./runtime.ts";

/**
 * Advisor continuity as the panel sees it: a status line and two explicit actions. The journal
 * itself stays private, so an operator never edits it by hand.
 */
export type ContinuityActions = {
  status: () => Promise<string>;
  recover: () => Promise<{ message: string; type: "info" | "error" }>;
  reset: () => Promise<{ message: string; type: "info" | "error" }>;
};

/**
 * Why the reviewer's configured model cannot run here, for a row that has to name the reason. The
 * picker offers only the models this host can already use, so this speaks about a model the
 * companion holds and the picker does not offer.
 */
function reviewerModelIssue(
  ctx: ExtensionContext,
  model: string,
): "no-credential" | "unavailable" | undefined {
  const separator = model.indexOf("/");
  if (separator <= 0) return "unavailable";
  const status = validateModelReference(ctx, {
    provider: model.slice(0, separator),
    model: model.slice(separator + 1),
  });
  if (status.kind === "available") return undefined;
  return status.kind === "no-credentials" ? "no-credential" : "unavailable";
}

export async function openDelegateEditor(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  continuity?: ContinuityActions,
): Promise<void> {
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
  // Never offered: this package, Anthropic's (it keeps its own opt-in) and the permission
  // runtime, which the host already adds to every child.
  const extensionCandidates = listProviderExtensionCandidates(ctx.cwd, [
    "pi-delegation-policy",
    ANTHROPIC_PROVIDER_PACKAGE,
    "@gotgenes/pi-permission-system",
  ]);
  const extensionProviders = ctx.modelRegistry?.getRegisteredProviderIds?.() ?? [];
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
            : [
                ...state.runtimeErrors,
                ...(state.advisorErrors ?? []),
                ...(state.advisorWarnings ?? []),
                ...(state.roleWarnings ?? []),
                ...advisorNotices,
              ],
        hasRuntimeError: hasRuntimeError(state),
        hasAdvisorError: hasAdvisorError(state),
        admissions: state.admissions ?? {},
        roleEntries: state.roleEntries,
        advisorRead: state.advisorRead,
        advisorFilter: state.advisorFilters,
        launchCorrection: state.launchCorrection,
        advisorLevel: state.advisorLevelFile?.level,
        advisorLevelInvalid: state.advisorLevelInvalid,
        guardMode: state.guardMode?.mode,
        guardModeInvalid: state.guardMode?.invalid,
        mainModel: state.mainModel,
        effectiveLevel: state.advisorLevel?.level,
        reviewerModelIssue: (model) => reviewerModelIssue(ctx, model),
        extensionCandidates,
        extensionProviders,
        ...(continuity
          ? {
              continuityStatus: continuity.status,
              onRecoverContinuity: continuity.recover,
              onResetContinuity: continuity.reset,
            }
          : {}),
        onSaveAdmissions: async (admissions) => {
          await writeProviderAdmissions(
            admissions,
            getProviderAdmissionsPath(getGlobalConfigPath()),
          );
          state.admissions = admissions;
          return true;
        },
        onSaveAdvisorRead: async (flags) => {
          const result = await writeAdvisorRead(flags, getGlobalConfigPath());
          // The runtime carries what the file holds, never the longer list a re-read would shorten.
          if (result === "saved" || result === "unchanged")
            state.advisorRead = trimAdvisorRead(flags);
          return result;
        },
        onSaveAdvisorFilter: async (flags) => {
          const result = await writeAdvisorFilters(flags, getGlobalConfigPath());
          // Same rule as the reading flags: the runtime carries what the file holds.
          if (result === "saved" || result === "unchanged")
            state.advisorFilters = trimAdvisorFilter(flags);
          return result;
        },
        onSaveRoleEntries: async (entries) => {
          const result = await writeRoleEntries(entries, getGlobalConfigPath());
          if (result === "saved" || result === "unchanged") state.roleEntries = entries;
          return result;
        },
        onSaveLaunchCorrection: async (mode) => {
          const result = await writeLaunchCorrectionMode(
            mode,
            getLaunchCorrectionPath(getGlobalConfigPath()),
          );
          if (result === "saved" || result === "unchanged") state.launchCorrection = mode;
          return result;
        },
        onSaveGuardMode: async (mode) => {
          // The writer derives the companion name from this path, as the level and the role entries
          // do, so the caller passes the config path and never the sidecar path.
          const result = await writeGuardMode(mode, getGlobalConfigPath());
          // The file is the only scope these settings have, so the runtime follows the write.
          if (result === "saved" || result === "unchanged")
            state.guardMode = { mode, invalid: false };
          return result;
        },
        onSaveAdvisorLevel: async (level) => {
          // The file also holds the per-model overrides and the brief mode, and a save here only
          // states the global level.
          const result = await writeAdvisorLevelFile(
            { ...(state.advisorLevelFile ?? emptyAdvisorLevelFile()), level },
            getGlobalConfigPath(),
          );
          if (result === "saved" || result === "unchanged") {
            // The resolved level also follows the branch entry and the main model, and loadRuntime
            // already owns that rule; re-resolving it here would duplicate it.
            const refreshed = await loadRuntime(ctx);
            state.advisorLevel = refreshed.advisorLevel;
            state.advisorLevelFile = refreshed.advisorLevelFile;
            state.advisorLevelInvalid = refreshed.advisorLevelInvalid;
          }
          return result;
        },
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
          state.advisorWarnings = refreshed.advisorWarnings;
          state.roleEntries = refreshed.roleEntries;
          state.roleWarnings = refreshed.roleWarnings;
          state.advisorRead = refreshed.advisorRead;
          state.advisorFilters = refreshed.advisorFilters;
          state.advisorEntries = refreshed.advisorEntries;
          state.admissions = refreshed.admissions;
          state.launchCorrection = refreshed.launchCorrection;
          state.advisorReminder = refreshed.advisorReminder;
          state.advisorReminderInvalid = refreshed.advisorReminderInvalid;
          state.advisorLevel = refreshed.advisorLevel;
          state.advisorLevelFile = refreshed.advisorLevelFile;
          state.advisorLevelInvalid = refreshed.advisorLevelInvalid;
          state.guardMode = refreshed.guardMode;
          state.advisorContextMode = refreshed.advisorContextMode;
          state.mainModel = refreshed.mainModel;
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

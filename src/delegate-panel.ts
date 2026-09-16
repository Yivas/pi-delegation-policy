import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { isThinkingLevelName, resolveDelegateState } from "./config.ts";
import { buildPolicyPreview } from "./prompt.ts";
import {
  CONTEXT_SHUNT_MODES,
  type ContextShuntSettings,
  CURRENT_SCHEMA_VERSION,
  type GlobalDefaults,
  INTENSITIES,
  type Intensity,
  type ModelConfigKey,
  type ModelRef,
  type ModelRole,
  PREFERENCES,
  type Preference,
  ROLE_LABELS,
  type SessionDelegateState,
  type SessionThinkingSettings,
  type ThinkingLevelName,
  type ThinkingPolicy,
} from "./types.ts";

const USE_GLOBAL_DEFAULT = "Use global default";
const DISABLE_FOR_SESSION = "Disable for this session";
const UNSET_FOR_SESSION = "Unset for this session (no policy)";
const FIXED_LEVEL = "Fixed level…";
const RANGE_LEVELS = "Range (min–max)…";

const FIELD_IDS = [
  "intensity",
  "preference",
  "small",
  "medium",
  "large",
  "uiDesign",
  "contextShunt",
  "contextAdvanced",
  "thinkingSmall",
  "thinkingMedium",
  "thinkingLarge",
  "thinkingUiDesign",
] as const;
type DelegateField = (typeof FIELD_IDS)[number];
const THINKING_FIELDS = [
  "thinkingSmall",
  "thinkingMedium",
  "thinkingLarge",
  "thinkingUiDesign",
] as const;
type ThinkingField = (typeof THINKING_FIELDS)[number];
const THINKING_FIELD_KEYS: Record<ThinkingField, ModelConfigKey> = {
  thinkingSmall: "small",
  thinkingMedium: "medium",
  thinkingLarge: "large",
  thinkingUiDesign: "uiDesign",
};
function isThinkingField(field: string): field is ThinkingField {
  return (THINKING_FIELDS as readonly string[]).includes(field);
}
type EnumField = "intensity" | "preference" | "contextShunt";
type PanelAction = "apply" | "save-defaults" | "reset" | "cancel";
type SettingsItem = DelegateField | PanelAction;
const ADVANCED_FIELDS = [
  "readerEnabled",
  "readerRole",
  "answerMaxBytes",
  "fullReadLines",
  "fullReadBytes",
  "targetedReadLines",
  "targetedReadBytes",
  "exceptionPatterns",
  "delegationHintPatterns",
  "resetContextShunt",
  "back",
] as const;
type AdvancedField = (typeof ADVANCED_FIELDS)[number];
const LIMIT_FIELDS = [
  "fullReadLines",
  "fullReadBytes",
  "targetedReadLines",
  "targetedReadBytes",
] as const;
type LimitField = (typeof LIMIT_FIELDS)[number];
type EditableAdvancedField = Exclude<
  AdvancedField,
  "readerEnabled" | "readerRole" | "resetContextShunt" | "back"
>;

function isLimitField(field: AdvancedField | EditableAdvancedField): field is LimitField {
  return (LIMIT_FIELDS as readonly string[]).includes(field);
}

type PanelMode =
  | { kind: "settings" }
  | { kind: "enum"; field: EnumField; selected: number }
  | { kind: "model"; field: ModelConfigKey; selected: number; query: string }
  | { kind: "advanced"; selected: number }
  | { kind: "advanced-reader-enabled"; selected: number }
  | { kind: "advanced-reader-role"; selected: number }
  | { kind: "advanced-input"; field: EditableAdvancedField }
  | { kind: "thinking"; field: ThinkingField; selected: number }
  | {
      kind: "thinking-level";
      field: ThinkingField;
      target: "fixed" | "min" | "max";
      selected: number;
      minimum?: ThinkingLevelName;
    }
  | { kind: "discard-confirm"; selected: number };

type ThinkingAction = "inherit" | "unset" | "fixed" | "range";
type ThinkingChoice = { label: string; description: string; action: ThinkingAction };

type ModelChoice =
  | { kind: "global"; key: "global"; label: string; description?: string }
  | { kind: "disabled"; key: "disabled"; label: string; description?: string }
  | {
      kind: "model";
      key: string;
      label: string;
      description?: string;
      reference: ModelRef;
    };

export type DelegatePanelResult = "applied" | "cancelled";

export interface DelegatePanelOptions {
  tui: TUI;
  theme: Theme;
  global: GlobalDefaults;
  session: SessionDelegateState;
  candidates: Model<Api>[];
  diagnostics: string[];
  hasRuntimeError: boolean;
  onApply: (draft: SessionDelegateState) => Promise<boolean>;
  onSaveDefaults: (draft: SessionDelegateState) => Promise<GlobalDefaults | undefined>;
  onDone: (result: DelegatePanelResult) => void;
}

const SETTINGS_ITEMS: readonly SettingsItem[] = [
  ...FIELD_IDS,
  "apply",
  "save-defaults",
  "reset",
  "cancel",
];

const FIELD_LABELS: Record<DelegateField, string> = {
  intensity: "Intensity",
  preference: "Preference",
  small: "Small model",
  medium: "Medium model",
  large: "Large model",
  uiDesign: "Visual Design",
  contextShunt: "Context protection",
  contextAdvanced: "Context advanced",
  thinkingSmall: "Small thinking",
  thinkingMedium: "Medium thinking",
  thinkingLarge: "Large thinking",
  thinkingUiDesign: "Visual Design thinking",
};

const FIELD_DESCRIPTIONS: Record<DelegateField, string> = {
  intensity: "When delegation is worth considering.",
  preference: "Tie-break only; task fit decides the role first.",
  small: "Bounded, planned, and verifiable execution.",
  medium: "Planning, ambiguity, synthesis, and coordination.",
  large: "Exceptional unblocker for persistent hard problems.",
  uiDesign: "Design, assets, and bounded presentation work; no app behavior.",
  contextShunt: "Off, observe, or enforce bounded context protection.",
  contextAdvanced:
    "Reader role, limits, and path patterns; each value can inherit from global defaults.",
  thinkingSmall:
    "Unset, one fixed level, or an inclusive range; levels come from the role's model.",
  thinkingMedium:
    "Unset, one fixed level, or an inclusive range; levels come from the role's model.",
  thinkingLarge:
    "Unset, one fixed level, or an inclusive range; levels come from the role's model.",
  thinkingUiDesign:
    "Unset, one fixed level, or an inclusive range; levels come from the role's model.",
};

const ACTION_LABELS: Record<PanelAction, string> = {
  apply: "Apply changes",
  "save-defaults": "Save effective configuration as defaults",
  reset: "Reset draft to off",
  cancel: "Cancel",
};

function cloneSession(value: SessionDelegateState): SessionDelegateState {
  return structuredClone(value);
}

function sameModel(left: ModelRef | null | undefined, right: ModelRef | null | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.provider === right.provider && left.model === right.model;
}

function sameThinkingPolicy(
  left: ThinkingPolicy | null | undefined,
  right: ThinkingPolicy | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if ("level" in left || "level" in right)
    return "level" in left && "level" in right && left.level === right.level;
  return left.min === right.min && left.max === right.max;
}

function sameThinking(
  left: SessionThinkingSettings | undefined,
  right: SessionThinkingSettings | undefined,
): boolean {
  const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  return [...keys].every((key) =>
    sameThinkingPolicy(left?.[key as ModelConfigKey], right?.[key as ModelConfigKey]),
  );
}

function thinkingSummary(policy: ThinkingPolicy): string {
  return "level" in policy
    ? `fixed ${policy.level}`
    : `range ${policy.min}..${policy.max} inclusive`;
}

export function sameSessionState(left: SessionDelegateState, right: SessionDelegateState): boolean {
  return (
    left.intensity === right.intensity &&
    left.preference === right.preference &&
    sameModel(left.small, right.small) &&
    sameModel(left.medium, right.medium) &&
    sameModel(left.large, right.large) &&
    sameModel(left.uiDesign, right.uiDesign) &&
    sameThinking(left.thinking, right.thinking) &&
    JSON.stringify(left.contextShunt ?? {}) === JSON.stringify(right.contextShunt ?? {})
  );
}

function modelText(reference: ModelRef | undefined): string {
  return reference ? `${reference.provider}/${reference.model}` : "not configured";
}

function rawModelText(reference: ModelRef | null | undefined, missing: string): string {
  if (reference === null) return "disabled";
  return reference ? modelText(reference) : missing;
}

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function selectedLine(theme: Theme, text: string, width: number, selected: boolean): string {
  const line = pad(`${selected ? ">" : " "} ${text}`, width);
  return selected ? theme.bg("selectedBg", theme.fg("accent", line)) : line;
}

function modelKey(reference: ModelRef): string {
  return `${reference.provider}\u0000${reference.model}`;
}

function sortedModels(models: readonly Model<Api>[]): Model<Api>[] {
  return [...models].sort((left, right) => {
    const provider = left.provider.localeCompare(right.provider);
    return provider === 0 ? left.id.localeCompare(right.id) : provider;
  });
}

function modelMetadata(model: Model<Api> | undefined): string[] {
  if (!model) return [];
  const details: string[] = [];
  if (model.name !== undefined) details.push(`Model Name: ${model.name}`);
  if (model.api !== undefined) details.push(`API: ${model.api}`);
  if (model.reasoning !== undefined) details.push(`Reasoning: ${model.reasoning ? "yes" : "no"}`);
  if (model.contextWindow !== undefined) details.push(`Context: ${model.contextWindow}`);
  if (model.maxTokens !== undefined) details.push(`Max output: ${model.maxTokens}`);
  return details;
}

function visibleBlockRange(blocks: string[][], selected: number, budget: number): [number, number] {
  if (blocks.length === 0) return [0, 0];
  const safeSelected = Math.max(0, Math.min(selected, blocks.length - 1));
  const selectedSize = Math.min(blocks[safeSelected]?.length ?? 1, Math.max(1, budget));
  let start = safeSelected;
  let end = safeSelected + 1;
  let used = selectedSize;

  while (used < budget && (start > 0 || end < blocks.length)) {
    const below = end < blocks.length ? (blocks[end]?.length ?? 1) : Number.POSITIVE_INFINITY;
    const above = start > 0 ? (blocks[start - 1]?.length ?? 1) : Number.POSITIVE_INFINITY;
    if (below <= above && used + below <= budget) {
      used += below;
      end += 1;
      continue;
    }
    if (used + above <= budget) {
      used += above;
      start -= 1;
      continue;
    }
    if (used + below <= budget) {
      used += below;
      end += 1;
      continue;
    }
    break;
  }

  return [start, end];
}

export class DelegatePanel implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly candidates: Model<Api>[];
  private readonly diagnostics: string[];
  private readonly hasRuntimeError: boolean;
  private readonly onApply: DelegatePanelOptions["onApply"];
  private readonly onSaveDefaults: DelegatePanelOptions["onSaveDefaults"];
  private readonly onDone: DelegatePanelOptions["onDone"];
  private readonly original: SessionDelegateState;
  private readonly searchInput = new Input();
  private readonly advancedInput = new Input();
  private global: GlobalDefaults;
  private draft: SessionDelegateState;
  private mode: PanelMode = { kind: "settings" };
  private settingsIndex = 0;
  private working: string | undefined;
  private message: { kind: "info" | "error"; text: string } | undefined;
  private renderWidth = 80;
  private _focused = false;

  constructor(options: DelegatePanelOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.global = structuredClone(options.global);
    this.original = cloneSession(options.session);
    this.draft = cloneSession(options.session);
    this.candidates = sortedModels(options.candidates);
    this.diagnostics = [...options.diagnostics];
    this.hasRuntimeError = options.hasRuntimeError;
    this.onApply = options.onApply;
    this.onSaveDefaults = options.onSaveDefaults;
    this.onDone = options.onDone;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  getDraft(): SessionDelegateState {
    return cloneSession(this.draft);
  }

  isDirty(): boolean {
    return !sameSessionState(this.original, this.draft);
  }

  handleInput(data: string): void {
    if (this.working) return;
    this.message = undefined;

    if (this.isCompact()) {
      this.handleCompactInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.mode.kind === "settings") this.handleSettingsInput(data);
    else if (this.mode.kind === "enum") this.handleEnumInput(data);
    else if (this.mode.kind === "model") this.handleModelInput(data);
    else if (this.mode.kind === "advanced") this.handleAdvancedInput(data);
    else if (this.mode.kind === "advanced-reader-enabled")
      this.handleAdvancedReaderEnabledInput(data);
    else if (this.mode.kind === "advanced-reader-role") this.handleAdvancedReaderRoleInput(data);
    else if (this.mode.kind === "advanced-input") this.handleAdvancedValueInput(data);
    else if (this.mode.kind === "thinking") this.handleThinkingInput(data);
    else if (this.mode.kind === "thinking-level") this.handleThinkingLevelInput(data);
    else this.handleDiscardInput(data);

    this.syncInputFocus();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.renderWidth = safeWidth;
    const rows = Math.max(1, this.tui.terminal.rows);
    if (safeWidth < 26 || rows < 9) return this.renderCompact(safeWidth, rows);

    const title = this.renderTitle(safeWidth);
    const footer = this.renderFooter(safeWidth);
    const bodyBudget = Math.max(1, rows - title.length - footer.length);
    const body = this.renderBody(safeWidth, bodyBudget);
    return [...title, ...body, ...footer].slice(0, rows);
  }

  private renderBody(width: number, budget: number): string[] {
    const mode = this.mode;
    if (mode.kind === "settings") return this.renderSettings(width, budget);
    if (mode.kind === "enum") return this.renderEnum(width, budget, mode);
    if (mode.kind === "model") return this.renderModel(width, budget, mode);
    if (mode.kind === "advanced") return this.renderAdvanced(width, budget, mode);
    if (mode.kind === "advanced-reader-enabled")
      return this.renderAdvancedReaderEnabled(width, budget, mode);
    if (mode.kind === "advanced-reader-role")
      return this.renderAdvancedReaderRole(width, budget, mode);
    if (mode.kind === "advanced-input") return this.renderAdvancedInput(width, budget, mode);
    if (mode.kind === "thinking") return this.renderThinking(width, budget, mode);
    if (mode.kind === "thinking-level") return this.renderThinkingLevel(width, budget, mode);
    return this.renderDiscard(width, budget);
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  private isCompact(): boolean {
    return this.renderWidth < 26 || this.tui.terminal.rows < 9;
  }

  private handleCompactInput(data: string): void {
    if (this.mode.kind === "discard-confirm") {
      if (this.canRenderDiscardChoices(this.renderWidth, this.tui.terminal.rows)) {
        this.handleDiscardInput(data);
      } else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.mode = { kind: "settings" };
      }
      return;
    }
    if (!matchesKey(data, "escape") && !matchesKey(data, "ctrl+c")) return;
    if (this.mode.kind === "settings") this.requestClose();
    else this.mode = { kind: "settings" };
  }

  private canRenderDiscardChoices(width: number, rows: number): boolean {
    return width >= 17 && rows >= 2;
  }

  private renderCompact(width: number, rows: number): string[] {
    if (this.mode.kind === "discard-confirm") {
      if (!this.canRenderDiscardChoices(width, rows)) {
        return ["Resize to review changes.", "Esc keeps editing."]
          .map((line) => truncateToWidth(line, width, ""))
          .slice(0, rows);
      }
      const choices = [
        selectedLine(this.theme, "Keep editing", width, this.mode.selected === 0),
        selectedLine(this.theme, "Discard changes", width, this.mode.selected === 1),
      ];
      const lines =
        rows === 2
          ? choices
          : rows === 3
            ? ["Discard changes?", ...choices]
            : [
                this.theme.fg("accent", "Delegation policy"),
                "Discard changes?",
                ...choices,
                this.theme.fg("dim", "↑↓ choose · Enter · Esc keep"),
              ];
      return lines.map((line) => truncateToWidth(line, width, "")).slice(0, rows);
    }

    const action = this.mode.kind === "settings" ? "Esc reviews changes." : "Esc returns.";
    return [
      this.theme.fg("accent", "Delegation policy"),
      ...(this.isDirty() ? [this.theme.fg("warning", "Modified")] : []),
      "Terminal too small.",
      "Resize to continue editing.",
      action,
    ]
      .map((line) => truncateToWidth(line, width, ""))
      .slice(0, rows);
  }

  private renderTitle(width: number): string[] {
    const modeLabel =
      this.mode.kind === "settings" || this.mode.kind === "discard-confirm"
        ? "Delegation policy"
        : this.mode.kind === "advanced" ||
            this.mode.kind === "advanced-reader-enabled" ||
            this.mode.kind === "advanced-reader-role" ||
            this.mode.kind === "advanced-input"
          ? "Delegation policy / Context advanced"
          : `Delegation policy / ${FIELD_LABELS[this.mode.field]}`;
    const status = this.working ?? (this.isDirty() ? "Modified" : "");
    const gap = Math.max(1, width - visibleWidth(modeLabel) - visibleWidth(status));
    const statusText = this.theme.fg("warning", status);
    const lines = [
      truncateToWidth(
        this.theme.fg("accent", this.theme.bold(modeLabel)) + " ".repeat(gap) + statusText,
        width,
        "",
      ),
    ];
    const notice =
      this.message ??
      (this.diagnostics[0] ? { kind: "error" as const, text: this.diagnostics[0] } : undefined);
    if (notice) {
      lines.push(
        truncateToWidth(
          this.theme.fg(notice.kind === "error" ? "error" : "success", notice.text),
          width,
          "",
        ),
      );
    }
    lines.push(this.theme.fg("borderMuted", "─".repeat(width)));
    return lines;
  }

  private renderFooter(width: number): string[] {
    const hint =
      this.mode.kind === "settings"
        ? "↑↓ move · Enter edit · A apply · Esc close"
        : this.mode.kind === "model"
          ? "Type search · ↑↓ move · PgUp/PgDn · Enter choose · Esc back"
          : this.mode.kind === "advanced"
            ? "↑↓ move · Enter edit · Esc back"
            : this.mode.kind === "advanced-input"
              ? "Type value · Enter save · Esc back"
              : this.mode.kind === "discard-confirm"
                ? "↑↓ move · Enter choose · Esc keep editing"
                : "↑↓ move · Enter choose · Esc back";
    return [
      this.theme.fg("borderMuted", "─".repeat(width)),
      truncateToWidth(this.theme.fg("dim", hint), width, ""),
    ];
  }

  private renderSettings(width: number, budget: number): string[] {
    const effective = resolveDelegateState(this.global, this.draft);
    const preview = this.renderPolicyPreview(width, budget, effective);
    const settingsBudget = Math.max(1, budget - preview.length);
    const blocks = SETTINGS_ITEMS.map((item, index) => {
      const selected = index === this.settingsIndex;
      if (FIELD_IDS.includes(item as DelegateField)) {
        const field = item as DelegateField;
        const value = isThinkingField(field)
          ? this.thinkingValue(field)
          : field === "intensity" || field === "preference"
            ? effective[field]
            : field === "contextShunt"
              ? effective.contextShunt.suspended
                ? `off (suspended; configured ${effective.contextShunt.configuredMode})`
                : effective.contextShunt.mode
              : field === "contextAdvanced"
                ? `reader ${effective.contextShunt.readerEnabled ? "on" : "off"}; ${effective.contextShunt.readerRole}; ${effective.contextShunt.answerMaxBytes} bytes`
                : field === "uiDesign"
                  ? effective.uiDesign
                    ? modelText(effective.uiDesign)
                    : "disabled"
                  : rawModelText(effective[field], "not configured");
        const details = this.sourceDetails(field);
        if (width < 48) {
          return [
            selectedLine(this.theme, FIELD_LABELS[field], width, selected),
            ...wrapTextWithAnsi(`  ${FIELD_DESCRIPTIONS[field]}`, width),
            ...wrapTextWithAnsi(`  ${value}`, width),
            ...details.flatMap((line) =>
              wrapTextWithAnsi(this.theme.fg("dim", `  ${line}`), width),
            ),
          ];
        }
        const labelWidth = Math.max(16, visibleWidth(FIELD_LABELS[field]) + 1);
        const first = `${pad(FIELD_LABELS[field], labelWidth)}${value}`;
        return [
          selectedLine(this.theme, first, width, selected),
          ...wrapTextWithAnsi(
            this.theme.fg("dim", `  ${FIELD_DESCRIPTIONS[field]} · ${details.join(" · ")}`),
            width,
          ),
        ];
      }
      const action = item as PanelAction;
      const disabled = action === "apply" && !this.isDirty();
      const label = disabled ? `${ACTION_LABELS[action]} (no changes)` : ACTION_LABELS[action];
      const line = selectedLine(this.theme, label, width, selected);
      return [disabled ? this.theme.fg("dim", line) : line];
    });

    return [
      ...preview,
      ...this.renderBlockViewport(blocks, this.settingsIndex, width, settingsBudget),
    ];
  }

  private renderPolicyPreview(
    width: number,
    budget: number,
    effective: ReturnType<typeof resolveDelegateState>,
  ): string[] {
    const lines =
      effective.intensity !== "off" && this.hasRuntimeError
        ? ["D:ERR · policy unavailable; fix the reported role diagnostics"]
        : buildPolicyPreview(effective);
    const maximum =
      width >= 60 && budget >= 8 ? (effective.intensity === "orchestrator" ? 5 : 4) : 2;
    return ["Effective policy preview", ...lines]
      .slice(0, maximum)
      .map((line) => truncateToWidth(this.theme.fg("dim", line), width, ""));
  }

  private thinkingValue(field: ThinkingField): string {
    const key = THINKING_FIELD_KEYS[field];
    const local = this.draft.thinking;
    if (local && Object.hasOwn(local, key)) {
      const policy = local[key];
      return policy ? `${thinkingSummary(policy)} (session)` : "unset (session)";
    }
    const global = this.global.thinking?.[key];
    return global ? `${thinkingSummary(global)} (global)` : "unset";
  }

  /** The selectable thinking levels come from the role's resolved model only. */
  private thinkingAvailability(
    field: ThinkingField,
  ): { levels: ThinkingLevelName[] } | { reason: string } {
    const key = THINKING_FIELD_KEYS[field];
    const state = resolveDelegateState(this.global, this.draft);
    if (key === "uiDesign" && this.draft.uiDesign === null)
      return { reason: "Visual Design is disabled for this session; levels cannot be listed." };
    const reference = key === "uiDesign" ? state.uiDesign : state[key];
    if (reference === null)
      return { reason: `${ROLE_LABELS[key]} is disabled; levels cannot be listed.` };
    if (reference === undefined)
      return { reason: `${ROLE_LABELS[key]} is not configured; levels cannot be listed.` };
    const model = this.candidates.find(
      (candidate) => candidate.provider === reference.provider && candidate.id === reference.model,
    );
    if (!model)
      return {
        reason: `${ROLE_LABELS[key]} model ${reference.provider}/${reference.model} is not available; levels cannot be listed.`,
      };
    return {
      levels: getSupportedThinkingLevels(model).filter(isThinkingLevelName),
    };
  }

  private thinkingChoices(field: ThinkingField): ThinkingChoice[] {
    const key = THINKING_FIELD_KEYS[field];
    const global = this.global.thinking?.[key];
    const availability = this.thinkingAvailability(field);
    return [
      {
        label: `${USE_GLOBAL_DEFAULT} (${global ? thinkingSummary(global) : "none"})`,
        description: "Drop this session override and keep the global policy, if any.",
        action: "inherit",
      },
      {
        label: UNSET_FOR_SESSION,
        description: "Keep no thinking policy for this role in this session.",
        action: "unset",
      },
      ...("levels" in availability
        ? [
            {
              label: FIXED_LEVEL,
              description: "Every launch of this role uses exactly one level.",
              action: "fixed" as const,
            },
            {
              label: RANGE_LEVELS,
              description: "The main agent chooses inside an inclusive minimum and maximum.",
              action: "range" as const,
            },
          ]
        : []),
    ];
  }

  private renderThinking(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "thinking" }>,
  ): string[] {
    const availability = this.thinkingAvailability(mode.field);
    const header =
      "levels" in availability
        ? []
        : wrapTextWithAnsi(this.theme.fg("warning", availability.reason), width);
    const blocks = this.thinkingChoices(mode.field).map((choice, index) => [
      selectedLine(this.theme, choice.label, width, index === mode.selected),
      ...wrapTextWithAnsi(this.theme.fg("dim", `  ${choice.description}`), width),
    ]);
    const viewport = this.renderBlockViewport(
      blocks,
      mode.selected,
      width,
      Math.max(1, budget - header.length),
    );
    return [...header, ...viewport].slice(0, budget);
  }

  private renderThinkingLevel(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "thinking-level" }>,
  ): string[] {
    const header = wrapTextWithAnsi(
      this.theme.fg(
        "dim",
        mode.target === "fixed"
          ? "Fixed level for every launch of this role."
          : mode.target === "min"
            ? "Inclusive minimum of the range."
            : "Inclusive maximum, never below the chosen minimum.",
      ),
      width,
    );
    const levels = this.availableThinkingLevels(mode);
    if (levels.length === 0)
      return [...header, truncateToWidth("No supported levels are available.", width, "")].slice(
        0,
        budget,
      );
    const blocks = levels.map((level, index) => [
      selectedLine(this.theme, level, width, index === mode.selected),
      ...wrapTextWithAnsi(
        this.theme.fg(
          "dim",
          `  ${mode.target === "fixed" ? "fixed level" : mode.target === "min" ? "range minimum" : "range maximum"}`,
        ),
        width,
      ),
    ]);
    const viewport = this.renderBlockViewport(
      blocks,
      mode.selected,
      width,
      Math.max(1, budget - header.length),
    );
    return [...header, ...viewport].slice(0, budget);
  }

  private availableThinkingLevels(
    mode: Extract<PanelMode, { kind: "thinking-level" }>,
  ): ThinkingLevelName[] {
    const availability = this.thinkingAvailability(mode.field);
    const levels = "levels" in availability ? availability.levels : [];
    if (mode.target !== "max" || !mode.minimum) return levels;
    const minimumIndex = levels.indexOf(mode.minimum);
    return minimumIndex < 0 ? levels : levels.slice(minimumIndex);
  }

  private readerStatusDetails(state: ReturnType<typeof resolveDelegateState>): string[] {
    const context = state.contextShunt;
    if (!context.readerEnabled) return ["Reader is disabled."];

    const role = context.readerRole;
    const label = role[0]!.toUpperCase() + role.slice(1);
    const setting = state[role];
    if (setting === null)
      return [`Reader role ${label} is disabled; choose an enabled ordinary role.`];
    if (setting === undefined)
      return [
        `Reader role ${label} is not configured; configure it or choose an enabled ordinary role.`,
      ];

    const runtimeDiagnostic = this.diagnostics.find((diagnostic) =>
      diagnostic.startsWith(`Reader role ${label} model `),
    );
    return runtimeDiagnostic
      ? [runtimeDiagnostic]
      : [`Reader role ${label} is selected; executor is checked only when invoked.`];
  }

  private sourceDetails(field: DelegateField): string[] {
    if (field === "intensity") {
      return [
        "built-in off",
        `global ${this.global.intensity ?? "—"}`,
        `session ${this.draft.intensity ?? "inherit"}`,
      ];
    }
    if (field === "contextShunt" || field === "contextAdvanced") {
      const state = resolveDelegateState(this.global, this.draft);
      const context = state.contextShunt;
      return [
        "built-in off",
        `global ${this.global.contextShunt?.mode ?? "—"}`,
        `session ${this.draft.contextShunt?.mode ?? "inherit"}`,
        `reader ${context.readerEnabled ? "on" : "off"}; role ${context.readerRole}; answer ${context.answerMaxBytes} bytes`,
        ...this.readerStatusDetails(state),
        `limits ${context.limits.fullReadLines}/${context.limits.fullReadBytes} full, ${context.limits.targetedReadLines}/${context.limits.targetedReadBytes} targeted`,
        `patterns ${context.exceptionPatterns.length} exempt, ${context.delegationHintPatterns.length} hint`,
      ];
    }
    if (field === "preference") {
      return [
        "built-in standard",
        `global ${this.global.preference ?? "—"}`,
        `session ${this.draft.preference ?? "inherit"}`,
      ];
    }
    if (field === "uiDesign") {
      return [
        "built-in disabled",
        `global ${rawModelText(this.global.uiDesign, "—")}`,
        `session ${rawModelText(this.draft.uiDesign, "inherit")}`,
      ];
    }
    if (isThinkingField(field)) {
      const key = THINKING_FIELD_KEYS[field];
      const global = this.global.thinking?.[key];
      const local = this.draft.thinking;
      return [
        "built-in unset",
        `global ${global ? thinkingSummary(global) : "—"}`,
        `session ${
          local && Object.hasOwn(local, key)
            ? local[key]
              ? thinkingSummary(local[key])
              : "unset"
            : "inherit"
        }`,
      ];
    }
    return [
      "built-in not configured",
      `global ${rawModelText(this.global[field], "—")}`,
      `session ${rawModelText(this.draft[field], "inherit")}`,
    ];
  }

  private renderEnum(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "enum" }>,
  ): string[] {
    const values =
      mode.field === "intensity"
        ? INTENSITIES
        : mode.field === "preference"
          ? PREFERENCES
          : CONTEXT_SHUNT_MODES;
    const descriptions =
      mode.field === "intensity"
        ? {
            off: "No policy is injected.",
            normal: "Delegate when the expected benefit clearly outweighs overhead.",
            aggressive: "Delegate suitable substantial work by default.",
            orchestrator: "Delegate transferable detail and keep ownership with the main agent.",
          }
        : mode.field === "preference"
          ? {
              efficient: "Tie-break comparable fits toward Small.",
              standard: "No extra Small or Medium bias.",
              intensive: "Tie-break comparable fits toward Medium.",
            }
          : {
              off: "No classification, metrics, archive, or interception.",
              observe: "Record would-block decisions without changing calls or results.",
              enforce: "Block only declared excess and protect known textual results.",
            };
    const globalValue =
      mode.field === "contextShunt"
        ? (this.global.contextShunt?.mode ?? "off")
        : (this.global[mode.field] ?? (mode.field === "intensity" ? "off" : "standard"));
    const options = [
      {
        label: `${USE_GLOBAL_DEFAULT} (${globalValue})`,
        description: "Use the current global value.",
      },
      ...values.map((value) => ({
        label: value,
        description: descriptions[value],
      })),
    ];
    const blocks = options.map((option, index) => [
      selectedLine(this.theme, option.label, width, index === mode.selected),
      ...wrapTextWithAnsi(this.theme.fg("dim", `  ${option.description}`), width),
    ]);
    return this.renderBlockViewport(blocks, mode.selected, width, budget);
  }

  private renderModel(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "model" }>,
  ): string[] {
    const inputWidth = Math.max(1, width - 8);
    const [input = ""] = this.searchInput.render(inputWidth);
    const inputText = input.startsWith("> ") ? input.slice(2) : input;
    const choices = this.modelChoices(mode.field, mode.query);
    const pinnedCount = 2;
    const pinned = choices.slice(0, pinnedCount);
    const models = choices.slice(pinnedCount);
    const pinnedLines = pinned.map((choice, index) =>
      selectedLine(
        this.theme,
        choice.description ? `${choice.label} (${choice.description})` : choice.label,
        width,
        mode.selected === index,
      ),
    );
    const dividerRows = budget > pinnedLines.length + 3 ? 1 : 0;
    const selectedChoice = choices[mode.selected];
    const metadata =
      selectedChoice?.kind === "model"
        ? modelMetadata(
            this.candidates.find(
              (model) =>
                modelKey({ provider: model.provider, model: model.id }) === selectedChoice.key,
            ),
          )
        : [];
    const fixedRows = 1 + pinnedLines.length + dividerRows;
    const reservedModelRows = models.length > 0 && budget > fixedRows ? 1 : 0;
    const availableDetailRows = Math.max(0, budget - fixedRows - reservedModelRows - 1);
    const details = metadata.slice(0, availableDetailRows);
    const detailRows = details.length > 0 ? details.length + 1 : 0;
    const availableListRows = Math.max(0, budget - fixedRows - detailRows);
    const listBudget = Math.min(11, availableListRows);
    const modelBlocks = models.map((choice, index) => {
      const combinedIndex = index + pinnedCount;
      const provider = choice.kind === "model" ? choice.reference.provider : "";
      const label = provider
        ? `${choice.label} ${this.theme.fg("muted", `[${provider}]`)}`
        : choice.label;
      return [selectedLine(this.theme, label, width, mode.selected === combinedIndex)];
    });
    const modelSelected = Math.max(0, mode.selected - pinnedCount);
    const modelLines =
      listBudget > 0 && modelBlocks.length > 0
        ? this.renderBlockViewport(modelBlocks, modelSelected, width, listBudget, 10)
        : [];
    if (models.length === 0 && modelLines.length < listBudget) {
      modelLines.push(
        truncateToWidth(
          this.theme.fg(
            "warning",
            mode.query ? `No models match “${mode.query}”.` : "No available models.",
          ),
          width,
          "",
        ),
      );
    }
    return [
      truncateToWidth(`Search: ${inputText}`, width, ""),
      ...pinnedLines,
      ...(dividerRows ? [this.theme.fg("borderMuted", "─".repeat(width))] : []),
      ...modelLines,
      ...(detailRows ? ["", ...details.map((line) => this.theme.fg("muted", `  ${line}`))] : []),
    ].slice(0, budget);
  }

  private renderAdvanced(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "advanced" }>,
  ): string[] {
    const delegateState = resolveDelegateState(this.global, this.draft);
    const effective = delegateState.contextShunt;
    const local = this.draft.contextShunt ?? {};
    const global = this.global.contextShunt ?? {};
    const limit = (key: keyof NonNullable<ContextShuntSettings["limits"]>) => effective.limits[key];
    const value = (field: AdvancedField): string => {
      switch (field) {
        case "readerEnabled":
          return effective.readerEnabled ? "on" : "off";
        case "readerRole":
          return effective.readerRole;
        case "answerMaxBytes":
          return String(effective.answerMaxBytes);
        case "fullReadLines":
        case "fullReadBytes":
        case "targetedReadLines":
        case "targetedReadBytes":
          return String(limit(field));
        case "exceptionPatterns":
          return effective.exceptionPatterns.length
            ? effective.exceptionPatterns.join(", ")
            : "none";
        case "delegationHintPatterns":
          return effective.delegationHintPatterns.length
            ? effective.delegationHintPatterns.join(", ")
            : "none";
        case "resetContextShunt":
          return "Return all ContextShunt fields to inheritance";
        case "back":
          return "Return to delegation settings";
      }
    };
    const source = (field: AdvancedField): string => {
      if (field === "resetContextShunt" || field === "back") return "";
      const key = field as keyof ContextShuntSettings;
      const localValue = isLimitField(field) ? local.limits?.[field] : local[key];
      const globalValue = isLimitField(field) ? global.limits?.[field] : global[key];
      const inheritance = `built-in ${field === "readerEnabled" ? "off" : field === "answerMaxBytes" ? "8192" : "inherit"} · global ${globalValue === undefined ? "—" : "set"} · session ${localValue === undefined ? "inherit" : "set"}`;
      return field === "readerRole"
        ? `${inheritance} · ${this.readerStatusDetails(delegateState).join(" ")}`
        : inheritance;
    };
    const labels: Record<AdvancedField, string> = {
      readerEnabled: "Reader enabled",
      readerRole: "Reader role",
      answerMaxBytes: "Reader answer max bytes",
      fullReadLines: "Full read lines",
      fullReadBytes: "Full read bytes",
      targetedReadLines: "Targeted read lines",
      targetedReadBytes: "Targeted read bytes",
      exceptionPatterns: "Exempt patterns",
      delegationHintPatterns: "Delegation hint patterns",
      resetContextShunt: "Reset ContextShunt draft",
      back: "Back",
    };
    const blocks = ADVANCED_FIELDS.map((field, index) => [
      selectedLine(this.theme, `${labels[field]}: ${value(field)}`, width, index === mode.selected),
      ...wrapTextWithAnsi(this.theme.fg("dim", `  ${source(field)}`), width),
    ]);
    return this.renderBlockViewport(blocks, mode.selected, width, budget);
  }

  private renderAdvancedReaderEnabled(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "advanced-reader-enabled" }>,
  ): string[] {
    const globalEnabled = this.global.contextShunt?.readerEnabled ?? false;
    const choices = [
      {
        label: `${USE_GLOBAL_DEFAULT} (${globalEnabled ? "on" : "off"})`,
        description: "Use the global reader-enabled setting.",
      },
      { label: "off", description: "Do not request inline reader delegation." },
      { label: "on", description: "Allow inline reader delegation when invoked." },
    ];
    return this.renderBlockViewport(
      choices.map((choice, index) => [
        selectedLine(this.theme, choice.label, width, index === mode.selected),
        ...wrapTextWithAnsi(this.theme.fg("dim", `  ${choice.description}`), width),
      ]),
      mode.selected,
      width,
      budget,
    );
  }

  private renderAdvancedReaderRole(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "advanced-reader-role" }>,
  ): string[] {
    const globalRole = this.global.contextShunt?.readerRole ?? "small";
    const roles: Array<{ label: string; description: string }> = [
      {
        label: `${USE_GLOBAL_DEFAULT} (${globalRole})`,
        description: "Use the global reader role.",
      },
      ...(["small", "medium", "large"] as const).map((role) => ({
        label: role,
        description: "Request this existing ordinary role; no separate reader model is stored.",
      })),
    ];
    return this.renderBlockViewport(
      roles.map((role, index) => [
        selectedLine(this.theme, role.label, width, index === mode.selected),
        ...wrapTextWithAnsi(this.theme.fg("dim", `  ${role.description}`), width),
      ]),
      mode.selected,
      width,
      budget,
    );
  }

  private renderAdvancedInput(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "advanced-input" }>,
  ): string[] {
    const labels: Record<EditableAdvancedField, string> = {
      answerMaxBytes: "Reader answer max bytes",
      fullReadLines: "Full read lines",
      fullReadBytes: "Full read bytes",
      targetedReadLines: "Targeted read lines",
      targetedReadBytes: "Targeted read bytes",
      exceptionPatterns: "Exempt patterns",
      delegationHintPatterns: "Delegation hint patterns",
    };
    const instruction = mode.field.endsWith("Patterns")
      ? "Comma-separated glob patterns; blank inherits global."
      : mode.field === "answerMaxBytes"
        ? "Integer from 1024 to 16384; blank inherits global."
        : "Positive integer; blank inherits global.";
    const [input = ""] = this.advancedInput.render(Math.max(1, width - 8));
    return [
      truncateToWidth(labels[mode.field], width, ""),
      ...wrapTextWithAnsi(this.theme.fg("dim", instruction), width),
      truncateToWidth(`Value: ${input.startsWith("> ") ? input.slice(2) : input}`, width, ""),
    ].slice(0, budget);
  }

  private renderDiscard(width: number, budget: number): string[] {
    const options = ["Keep editing", "Discard changes"];
    const selected = this.mode.kind === "discard-confirm" ? this.mode.selected : 0;
    const lines = [truncateToWidth("Discard unapplied changes?", width, ""), ""];
    for (const [index, option] of options.entries()) {
      lines.push(selectedLine(this.theme, option, width, index === selected));
    }
    return lines.slice(0, budget);
  }

  private renderBlockViewport(
    blocks: string[][],
    selected: number,
    width: number,
    budget: number,
    maxVisibleBlocks = Number.POSITIVE_INFINITY,
  ): string[] {
    const totalRows = blocks.reduce((sum, block) => sum + block.length, 0);
    const reserveIndicator = totalRows > budget || blocks.length > maxVisibleBlocks ? 1 : 0;
    const contentBudget = Math.max(1, Math.min(budget - reserveIndicator, maxVisibleBlocks));
    const [start, end] = visibleBlockRange(blocks, selected, contentBudget);
    const lines = blocks
      .slice(start, end)
      .flat()
      .map((line) => truncateToWidth(line, width, ""));
    if (reserveIndicator && lines.length < budget) {
      lines.push(
        truncateToWidth(
          this.theme.fg("dim", `  ${start + 1}–${end} of ${blocks.length}`),
          width,
          "",
        ),
      );
    }
    return lines.slice(0, budget);
  }

  private handleSettingsInput(data: string): void {
    if (matchesKey(data, "up")) this.moveSettings(-1);
    else if (matchesKey(data, "down")) this.moveSettings(1);
    else if (matchesKey(data, "home")) this.settingsIndex = 0;
    else if (matchesKey(data, "end")) this.settingsIndex = SETTINGS_ITEMS.length - 1;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.requestClose();
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.activateSettingsItem();
    else if (data.toLowerCase() === "a") void this.applyDraft();
  }

  private moveSettings(delta: number): void {
    this.settingsIndex =
      (this.settingsIndex + delta + SETTINGS_ITEMS.length) % SETTINGS_ITEMS.length;
  }

  private activateSettingsItem(): void {
    const item = SETTINGS_ITEMS[this.settingsIndex];
    if (!item) return;
    if (item === "contextAdvanced") {
      this.mode = { kind: "advanced", selected: 0 };
      return;
    }
    if (item === "intensity" || item === "preference" || item === "contextShunt") {
      const values =
        item === "intensity"
          ? INTENSITIES
          : item === "preference"
            ? PREFERENCES
            : CONTEXT_SHUNT_MODES;
      const current = item === "contextShunt" ? this.draft.contextShunt?.mode : this.draft[item];
      this.mode = {
        kind: "enum",
        field: item,
        selected: current ? values.indexOf(current as never) + 1 : 0,
      };
      return;
    }
    if (item === "small" || item === "medium" || item === "large" || item === "uiDesign") {
      this.openModelSelector(item);
      return;
    }
    if (isThinkingField(item)) {
      this.mode = { kind: "thinking", field: item, selected: this.thinkingSelection(item) };
      return;
    }
    if (item === "apply") void this.applyDraft();
    else if (item === "save-defaults") void this.saveDefaults();
    else if (item === "reset")
      this.draft = { schemaVersion: CURRENT_SCHEMA_VERSION, intensity: "off" };
    else this.requestClose();
  }

  private handleEnumInput(data: string): void {
    if (this.mode.kind !== "enum") return;
    const values =
      this.mode.field === "intensity"
        ? INTENSITIES
        : this.mode.field === "preference"
          ? PREFERENCES
          : CONTEXT_SHUNT_MODES;
    const count = values.length + 1;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected - 1 + count) % count;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % count;
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = count - 1;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const selected = this.mode.selected;
      const field = this.mode.field;
      if (selected === 0) {
        if (field === "contextShunt") {
          const context = { ...(this.draft.contextShunt ?? {}) };
          delete context.mode;
          this.replaceContextDraft(context);
        } else delete this.draft[field];
      } else if (field === "intensity") this.draft.intensity = values[selected - 1] as Intensity;
      else if (field === "preference") this.draft.preference = values[selected - 1] as Preference;
      else
        this.draft.contextShunt = {
          ...(this.draft.contextShunt ?? {}),
          mode: values[selected - 1] as "off" | "observe" | "enforce",
        };
      this.mode = { kind: "settings" };
    }
  }

  private thinkingSelection(field: ThinkingField): number {
    const key = THINKING_FIELD_KEYS[field];
    const local = this.draft.thinking;
    if (!local || !Object.hasOwn(local, key)) return 0;
    const policy = local[key];
    if (!policy) return 1;
    const choices = this.thinkingChoices(field);
    const wanted: ThinkingAction = "level" in policy ? "fixed" : "range";
    const index = choices.findIndex((choice) => choice.action === wanted);
    return index < 0 ? 1 : index;
  }

  private handleThinkingInput(data: string): void {
    if (this.mode.kind !== "thinking") return;
    const count = this.thinkingChoices(this.mode.field).length;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected - 1 + count) % count;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % count;
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = count - 1;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.activateThinkingChoice();
  }

  private activateThinkingChoice(): void {
    if (this.mode.kind !== "thinking") return;
    const field = this.mode.field;
    const choice = this.thinkingChoices(field)[this.mode.selected];
    if (!choice) return;
    if (choice.action === "inherit") {
      this.setThinkingPolicy(field, undefined);
      this.mode = { kind: "settings" };
      return;
    }
    if (choice.action === "unset") {
      this.setThinkingPolicy(field, null);
      this.mode = { kind: "settings" };
      return;
    }
    this.mode = {
      kind: "thinking-level",
      field,
      target: choice.action === "fixed" ? "fixed" : "min",
      selected: this.thinkingLevelSelection(field, choice.action === "fixed" ? "fixed" : "min"),
    };
  }

  private thinkingLevelSelection(
    field: ThinkingField,
    target: "fixed" | "min" | "max",
    minimum?: ThinkingLevelName,
  ): number {
    const key = THINKING_FIELD_KEYS[field];
    const policy = this.draft.thinking?.[key] ?? this.global.thinking?.[key];
    const levels = this.availableThinkingLevels({
      kind: "thinking-level",
      field,
      target,
      selected: 0,
      ...(minimum ? { minimum } : {}),
    });
    const wanted = !policy
      ? undefined
      : target === "fixed"
        ? "level" in policy
          ? policy.level
          : policy.min
        : target === "min"
          ? "level" in policy
            ? policy.level
            : policy.min
          : "level" in policy
            ? undefined
            : policy.max;
    const index = wanted ? levels.indexOf(wanted) : -1;
    return index >= 0 ? index : 0;
  }

  private handleThinkingLevelInput(data: string): void {
    if (this.mode.kind !== "thinking-level") return;
    const field = this.mode.field;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.mode = { kind: "thinking", field, selected: this.thinkingSelection(field) };
      return;
    }
    const levels = this.availableThinkingLevels(this.mode);
    if (levels.length === 0) return;
    if (matchesKey(data, "up")) this.mode.selected = Math.max(0, this.mode.selected - 1);
    else if (matchesKey(data, "down"))
      this.mode.selected = Math.min(levels.length - 1, this.mode.selected + 1);
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = levels.length - 1;
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.commitThinkingLevel();
  }

  private commitThinkingLevel(): void {
    if (this.mode.kind !== "thinking-level") return;
    const { field, target } = this.mode;
    const level = this.availableThinkingLevels(this.mode)[this.mode.selected];
    if (!level) return;
    if (target === "fixed") {
      this.setThinkingPolicy(field, { level });
      this.mode = { kind: "settings" };
      return;
    }
    if (target === "min") {
      this.mode = {
        kind: "thinking-level",
        field,
        target: "max",
        selected: this.thinkingLevelSelection(field, "max", level),
        minimum: level,
      };
      return;
    }
    const minimum = this.mode.minimum ?? level;
    this.setThinkingPolicy(
      field,
      minimum === level ? { level: minimum } : { min: minimum, max: level },
    );
    this.mode = { kind: "settings" };
  }

  private setThinkingPolicy(field: ThinkingField, policy: ThinkingPolicy | null | undefined): void {
    const key = THINKING_FIELD_KEYS[field];
    const thinking: SessionThinkingSettings = { ...(this.draft.thinking ?? {}) };
    if (policy === undefined) delete thinking[key];
    else thinking[key] = policy;
    if (Object.keys(thinking).length) this.draft.thinking = thinking;
    else delete this.draft.thinking;
  }

  private handleAdvancedInput(data: string): void {
    if (this.mode.kind !== "advanced") return;
    if (matchesKey(data, "up"))
      this.mode.selected =
        (this.mode.selected - 1 + ADVANCED_FIELDS.length) % ADVANCED_FIELDS.length;
    else if (matchesKey(data, "down"))
      this.mode.selected = (this.mode.selected + 1) % ADVANCED_FIELDS.length;
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = ADVANCED_FIELDS.length - 1;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.activateAdvancedField();
  }

  private activateAdvancedField(): void {
    if (this.mode.kind !== "advanced") return;
    const field = ADVANCED_FIELDS[this.mode.selected];
    if (!field) return;
    if (field === "back") {
      this.mode = { kind: "settings" };
      return;
    }
    if (field === "resetContextShunt") {
      delete this.draft.contextShunt;
      return;
    }
    if (field === "readerEnabled") {
      const selected = this.draft.contextShunt?.readerEnabled;
      this.mode = {
        kind: "advanced-reader-enabled",
        selected: selected === undefined ? 0 : selected ? 2 : 1,
      };
      return;
    }
    if (field === "readerRole") {
      const selected = this.draft.contextShunt?.readerRole;
      this.mode = {
        kind: "advanced-reader-role",
        selected: selected ? (["small", "medium", "large"] as const).indexOf(selected) + 1 : 0,
      };
      return;
    }
    this.advancedInput.setValue(this.advancedRawValue(field));
    this.mode = { kind: "advanced-input", field };
  }

  private handleAdvancedReaderEnabledInput(data: string): void {
    if (this.mode.kind !== "advanced-reader-enabled") return;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected + 2) % 3;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % 3;
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = 2;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "advanced", selected: 0 };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const readerEnabled = this.mode.selected === 0 ? undefined : this.mode.selected === 2;
      this.setContextReaderEnabled(readerEnabled);
      this.mode = { kind: "advanced", selected: 0 };
    }
  }

  private handleAdvancedReaderRoleInput(data: string): void {
    if (this.mode.kind !== "advanced-reader-role") return;
    if (matchesKey(data, "up")) this.mode.selected = (this.mode.selected + 3) % 4;
    else if (matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % 4;
    else if (matchesKey(data, "home")) this.mode.selected = 0;
    else if (matchesKey(data, "end")) this.mode.selected = 3;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "advanced", selected: 0 };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const role =
        this.mode.selected === 0
          ? undefined
          : (["small", "medium", "large"] as const)[this.mode.selected - 1];
      this.setContextValue("readerRole", role);
      this.mode = { kind: "advanced", selected: 0 };
    }
  }

  private handleAdvancedValueInput(data: string): void {
    if (this.mode.kind !== "advanced-input") return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.mode = { kind: "advanced", selected: 0 };
      return;
    }
    if (matchesKey(data, "enter")) {
      this.commitAdvancedValue(this.mode.field);
      return;
    }
    this.advancedInput.handleInput(data);
  }

  private advancedRawValue(field: EditableAdvancedField): string {
    const context = this.draft.contextShunt;
    if (field === "exceptionPatterns" || field === "delegationHintPatterns")
      return context?.[field]?.join(", ") ?? "";
    if (field === "answerMaxBytes") return String(context?.answerMaxBytes ?? "");
    return isLimitField(field) ? String(context?.limits?.[field] ?? "") : "";
  }

  private commitAdvancedValue(field: EditableAdvancedField): void {
    const raw = this.advancedInput.getValue().trim();
    if (!raw) {
      if (field === "exceptionPatterns" || field === "delegationHintPatterns")
        this.setContextValue(field, undefined);
      else if (field === "answerMaxBytes") this.setContextAnswerMaxBytes(undefined);
      else this.setContextLimit(field, undefined);
      this.mode = { kind: "advanced", selected: 0 };
      return;
    }
    if (field === "exceptionPatterns" || field === "delegationHintPatterns") {
      const patterns = raw
        .split(",")
        .map((pattern) => pattern.trim())
        .filter(Boolean);
      if (
        patterns.length > 32 ||
        patterns.some(
          (pattern) =>
            pattern.length > 256 ||
            pattern.includes("\0") ||
            pattern.includes("..") ||
            /^(?:[A-Za-z]:[\\/]|\\\\)/.test(pattern),
        )
      ) {
        this.message = {
          kind: "error",
          text: "Use up to 32 safe relative patterns.",
        };
        return;
      }
      this.setContextValue(field, patterns);
      this.mode = { kind: "advanced", selected: 0 };
      return;
    }
    const value = Number(raw);
    const [minimum, maximum] = field === "answerMaxBytes" ? [1024, 16384] : [1, 1024 * 1024];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      this.message = {
        kind: "error",
        text:
          field === "answerMaxBytes"
            ? "Enter an integer from 1024 to 16384."
            : "Enter a positive integer no greater than 1048576.",
      };
      return;
    }
    if (field === "answerMaxBytes") this.setContextAnswerMaxBytes(value);
    else this.setContextLimit(field, value);
    this.mode = { kind: "advanced", selected: 0 };
  }

  private setContextReaderEnabled(value: boolean | undefined): void {
    const context: ContextShuntSettings = { ...(this.draft.contextShunt ?? {}) };
    if (value === undefined) delete context.readerEnabled;
    else context.readerEnabled = value;
    this.replaceContextDraft(context);
  }

  private setContextAnswerMaxBytes(value: number | undefined): void {
    const context: ContextShuntSettings = { ...(this.draft.contextShunt ?? {}) };
    if (value === undefined) delete context.answerMaxBytes;
    else context.answerMaxBytes = value;
    this.replaceContextDraft(context);
  }

  private setContextValue(
    key: "readerRole" | "exceptionPatterns" | "delegationHintPatterns",
    value: ModelRole | string[] | undefined,
  ): void {
    const context: ContextShuntSettings = {
      ...(this.draft.contextShunt ?? {}),
    };
    if (value === undefined) delete context[key];
    else if (key === "readerRole") context.readerRole = value as ModelRole;
    else context[key] = value as string[];
    this.replaceContextDraft(context);
  }

  private setContextLimit(field: LimitField, value: number | undefined): void {
    const context: ContextShuntSettings = {
      ...(this.draft.contextShunt ?? {}),
    };
    const limits = { ...(context.limits ?? {}) };
    if (value === undefined) delete limits[field];
    else limits[field] = value;
    if (Object.keys(limits).length) context.limits = limits;
    else delete context.limits;
    this.replaceContextDraft(context);
  }

  private replaceContextDraft(context: ContextShuntSettings): void {
    if (Object.keys(context).length) this.draft.contextShunt = context;
    else delete this.draft.contextShunt;
  }

  private openModelSelector(field: ModelConfigKey): void {
    this.searchInput.setValue("");
    const choices = this.modelChoices(field, "");
    const current = this.draft[field];
    let selected = 0;
    if (current === null) selected = choices.findIndex((choice) => choice.kind === "disabled");
    else if (current) selected = choices.findIndex((choice) => choice.key === modelKey(current));
    this.mode = {
      kind: "model",
      field,
      selected: Math.max(0, selected),
      query: "",
    };
  }

  private handleModelInput(data: string): void {
    if (this.mode.kind !== "model") return;
    const choices = this.modelChoices(this.mode.field, this.mode.query);
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.mode = { kind: "settings" };
      return;
    }
    if (matchesKey(data, "up")) this.moveModelSelection(-1, choices.length);
    else if (matchesKey(data, "down")) this.moveModelSelection(1, choices.length);
    else if (matchesKey(data, "pageUp"))
      this.moveModelSelection(-this.modelPageSize(), choices.length);
    else if (matchesKey(data, "pageDown"))
      this.moveModelSelection(this.modelPageSize(), choices.length);
    else if (matchesKey(data, "enter")) this.chooseModel(choices[this.mode.selected]);
    else {
      const previous = choices[this.mode.selected];
      this.searchInput.handleInput(data);
      this.mode.query = this.searchInput.getValue();
      const nextChoices = this.modelChoices(this.mode.field, this.mode.query);
      const preserved =
        previous?.kind === "model"
          ? nextChoices.findIndex((choice) => choice.key === previous.key)
          : -1;
      this.mode.selected = preserved >= 0 ? preserved : 0;
    }
  }

  private moveModelSelection(delta: number, count: number): void {
    if (this.mode.kind !== "model" || count === 0) return;
    this.mode.selected = Math.max(0, Math.min(count - 1, this.mode.selected + delta));
  }

  private modelPageSize(): number {
    return Math.max(1, Math.floor((this.tui.terminal.rows - 8) / 2));
  }

  private chooseModel(choice: ModelChoice | undefined): void {
    if (!choice || this.mode.kind !== "model") return;
    const field = this.mode.field;
    if (choice.kind === "global") delete this.draft[field];
    else if (choice.kind === "disabled") this.draft[field] = null;
    else if (choice.kind === "model") this.draft[field] = { ...choice.reference };
    this.mode = { kind: "settings" };
  }

  private modelChoices(field: ModelConfigKey, query: string): ModelChoice[] {
    const global = this.global[field];
    const globalDescription =
      field === "uiDesign"
        ? global
          ? modelText(global)
          : "disabled"
        : rawModelText(global, "not configured");
    const pinned: ModelChoice[] = [
      {
        kind: "global",
        key: "global",
        label: USE_GLOBAL_DEFAULT,
        description: globalDescription,
      },
      { kind: "disabled", key: "disabled", label: DISABLE_FOR_SESSION },
    ];
    const filtered = query
      ? fuzzyFilter(this.candidates, query, (model) =>
          `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id} ${model.name ?? ""}`.trim(),
        )
      : this.candidates;
    return [
      ...pinned,
      ...filtered.map<ModelChoice>((model) => ({
        kind: "model",
        key: modelKey({ provider: model.provider, model: model.id }),
        label: model.id,
        ...(model.name && model.name !== model.id ? { description: model.name } : {}),
        reference: { provider: model.provider, model: model.id },
      })),
    ];
  }

  private handleDiscardInput(data: string): void {
    if (this.mode.kind !== "discard-confirm") return;
    if (matchesKey(data, "up") || matchesKey(data, "down"))
      this.mode.selected = this.mode.selected === 0 ? 1 : 0;
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      this.mode = { kind: "settings" };
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      if (this.mode.selected === 0) this.mode = { kind: "settings" };
      else this.onDone("cancelled");
    }
  }

  private requestClose(): void {
    if (this.isDirty()) this.mode = { kind: "discard-confirm", selected: 0 };
    else this.onDone("cancelled");
  }

  private async applyDraft(): Promise<void> {
    if (!this.isDirty()) {
      this.message = { kind: "info", text: "No changes to apply." };
      this.tui.requestRender();
      return;
    }
    this.working = "Applying changes…";
    this.tui.requestRender();
    try {
      if (await this.onApply(cloneSession(this.draft))) {
        this.onDone("applied");
        return;
      }
      this.message = {
        kind: "error",
        text: "Could not apply session settings. Try again.",
      };
    } catch {
      this.message = {
        kind: "error",
        text: "Could not apply session settings. Try again.",
      };
    } finally {
      this.working = undefined;
      this.tui.requestRender();
    }
  }

  private async saveDefaults(): Promise<void> {
    this.working = "Saving defaults…";
    this.tui.requestRender();
    try {
      const saved = await this.onSaveDefaults(cloneSession(this.draft));
      if (saved) {
        this.global = structuredClone(saved);
        this.diagnostics.length = 0;
        this.message = {
          kind: "info",
          text: "Saved effective delegation settings as global defaults.",
        };
      } else {
        this.message = {
          kind: "error",
          text: "Could not save global defaults. Session settings were not changed.",
        };
      }
    } catch {
      this.message = {
        kind: "error",
        text: "Could not save global defaults. Session settings were not changed.",
      };
    } finally {
      this.working = undefined;
      this.tui.requestRender();
    }
  }

  private syncInputFocus(): void {
    this.searchInput.focused = this._focused && this.mode.kind === "model";
    this.advancedInput.focused = this._focused && this.mode.kind === "advanced-input";
  }
}

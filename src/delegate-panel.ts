import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { resolveDelegateState } from "./config.ts";
import { buildPolicyPreview } from "./prompt.ts";
import {
  INTENSITIES,
  PREFERENCES,
  type GlobalDefaults,
  type Intensity,
  type ModelConfigKey,
  type ModelRef,
  type Preference,
  type SessionDelegateState,
} from "./types.ts";

const USE_GLOBAL_DEFAULT = "Use global default";
const DISABLE_FOR_SESSION = "Disable for this session";

const FIELD_IDS = ["intensity", "preference", "small", "medium", "large", "uiDesign"] as const;
type DelegateField = (typeof FIELD_IDS)[number];
type EnumField = "intensity" | "preference";
type PanelAction = "apply" | "save-defaults" | "reset" | "cancel";
type SettingsItem = DelegateField | PanelAction;

type PanelMode =
  | { kind: "settings" }
  | { kind: "enum"; field: EnumField; selected: number }
  | { kind: "model"; field: ModelConfigKey; selected: number; query: string }
  | { kind: "discard-confirm"; selected: number };

type ModelChoice =
  | { kind: "global"; key: "global"; label: string; description?: string }
  | { kind: "disabled"; key: "disabled"; label: string; description?: string }
  | { kind: "model"; key: string; label: string; description?: string; reference: ModelRef };

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
  uiDesign: "UI Design",
};

const FIELD_DESCRIPTIONS: Record<DelegateField, string> = {
  intensity: "When delegation is worth considering.",
  preference: "Tie-break only; task fit decides the role first.",
  small: "Bounded, planned, and verifiable execution.",
  medium: "Planning, ambiguity, synthesis, and coordination.",
  large: "Exceptional unblocker for persistent hard problems.",
  uiDesign: "Visual direction and review only; never implementation.",
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

export function sameSessionState(left: SessionDelegateState, right: SessionDelegateState): boolean {
  return (
    left.intensity === right.intensity &&
    left.preference === right.preference &&
    sameModel(left.small, right.small) &&
    sameModel(left.medium, right.medium) &&
    sameModel(left.large, right.large) &&
    sameModel(left.uiDesign, right.uiDesign)
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
    else this.handleDiscardInput(data);

    this.syncInputFocus();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.renderWidth = safeWidth;
    const rows = Math.max(1, this.tui.terminal.rows);
    if (safeWidth < 24 || rows < 9) return this.renderCompact(safeWidth, rows);

    const title = this.renderTitle(safeWidth);
    const footer = this.renderFooter(safeWidth);
    const bodyBudget = Math.max(1, rows - title.length - footer.length);
    const body =
      this.mode.kind === "settings"
        ? this.renderSettings(safeWidth, bodyBudget)
        : this.mode.kind === "enum"
          ? this.renderEnum(safeWidth, bodyBudget, this.mode)
          : this.mode.kind === "model"
            ? this.renderModel(safeWidth, bodyBudget, this.mode)
            : this.renderDiscard(safeWidth, bodyBudget);
    return [...title, ...body, ...footer].slice(0, rows);
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  private isCompact(): boolean {
    return this.renderWidth < 24 || this.tui.terminal.rows < 9;
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
        const value =
          field === "intensity" || field === "preference"
            ? effective[field]
            : field === "uiDesign"
              ? effective.uiDesign
                ? modelText(effective.uiDesign)
                : "disabled"
              : modelText(effective[field]);
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
        const labelWidth = 16;
        const first = `${FIELD_LABELS[field].padEnd(labelWidth)}${value}`;
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
    const maximum = width >= 60 && budget >= 8 ? 4 : 2;
    return ["Effective policy preview", ...lines]
      .slice(0, maximum)
      .map((line) => truncateToWidth(this.theme.fg("dim", line), width, ""));
  }

  private sourceDetails(field: DelegateField): string[] {
    if (field === "intensity") {
      return [
        "built-in off",
        `global ${this.global.intensity ?? "—"}`,
        `session ${this.draft.intensity ?? "inherit"}`,
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
    return [
      "built-in —",
      `global ${rawModelText(this.global[field], "—")}`,
      `session ${rawModelText(this.draft[field], "inherit")}`,
    ];
  }

  private renderEnum(
    width: number,
    budget: number,
    mode: Extract<PanelMode, { kind: "enum" }>,
  ): string[] {
    const values = mode.field === "intensity" ? INTENSITIES : PREFERENCES;
    const descriptions =
      mode.field === "intensity"
        ? {
            off: "No policy is injected.",
            normal: "Delegate when the expected benefit clearly outweighs overhead.",
            aggressive: "Delegate suitable substantial work by default.",
          }
        : {
            efficient: "Tie-break comparable fits toward Small.",
            standard: "No extra Small or Medium bias.",
            intensive: "Tie-break comparable fits toward Medium.",
          };
    const globalValue =
      this.global[mode.field] ?? (mode.field === "intensity" ? "off" : "standard");
    const options = [
      {
        label: `${USE_GLOBAL_DEFAULT} (${globalValue})`,
        description: "Use the current global value.",
      },
      ...values.map((value) => ({ label: value, description: descriptions[value] })),
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
    const pinnedCount = mode.field === "uiDesign" ? 2 : 1;
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
    const fixedRows = 2 + pinnedLines.length + dividerRows;
    const availableDetailRows = Math.max(0, budget - fixedRows - 1);
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
      "",
      ...pinnedLines,
      ...(dividerRows ? [this.theme.fg("borderMuted", "─".repeat(width))] : []),
      ...modelLines,
      ...(detailRows ? ["", ...details.map((line) => this.theme.fg("muted", `  ${line}`))] : []),
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
    if (item === "intensity" || item === "preference") {
      const values = item === "intensity" ? INTENSITIES : PREFERENCES;
      const current = this.draft[item];
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
    if (item === "apply") void this.applyDraft();
    else if (item === "save-defaults") void this.saveDefaults();
    else if (item === "reset") this.draft = { schemaVersion: 2, intensity: "off" };
    else this.requestClose();
  }

  private handleEnumInput(data: string): void {
    if (this.mode.kind !== "enum") return;
    const values = this.mode.field === "intensity" ? INTENSITIES : PREFERENCES;
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
      if (selected === 0) delete this.draft[field];
      else if (field === "intensity") this.draft.intensity = values[selected - 1] as Intensity;
      else this.draft.preference = values[selected - 1] as Preference;
      this.mode = { kind: "settings" };
    }
  }

  private openModelSelector(field: ModelConfigKey): void {
    this.searchInput.setValue("");
    const choices = this.modelChoices(field, "");
    const current = this.draft[field];
    let selected = 0;
    if (current === null) selected = choices.findIndex((choice) => choice.kind === "disabled");
    else if (current) selected = choices.findIndex((choice) => choice.key === modelKey(current));
    this.mode = { kind: "model", field, selected: Math.max(0, selected), query: "" };
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
    else if (choice.kind === "disabled" && field === "uiDesign") this.draft.uiDesign = null;
    else if (choice.kind === "model") this.draft[field] = { ...choice.reference };
    this.mode = { kind: "settings" };
  }

  private modelChoices(field: ModelConfigKey, query: string): ModelChoice[] {
    const global = this.global[field];
    const pinned: ModelChoice[] = [
      {
        kind: "global",
        key: "global",
        label: USE_GLOBAL_DEFAULT,
        ...(global ? { description: modelText(global) } : {}),
      },
    ];
    if (field === "uiDesign") {
      pinned.push({ kind: "disabled", key: "disabled", label: DISABLE_FOR_SESSION });
    }
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
      this.message = { kind: "error", text: "Could not apply session settings. Try again." };
    } catch {
      this.message = { kind: "error", text: "Could not apply session settings. Try again." };
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
  }
}

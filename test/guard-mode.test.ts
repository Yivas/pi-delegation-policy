import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import {
  defaultGuardMode,
  getGuardModePath,
  guardModeDiagnostic,
  parseGuardMode,
  readGuardMode,
  writeGuardMode,
  type GuardMode,
  type LoadedGuardMode,
} from "../src/guard-mode.ts";
import { resolveDelegateState, getGlobalConfigPath } from "../src/config.ts";
import { statusText } from "../src/index.ts";
import type { RuntimeState } from "../src/runtime.ts";
import {
  DelegatePanel,
  type DelegatePanelOptions,
  type DelegatePanelResult,
} from "../src/delegate-panel.ts";
import { CURRENT_SCHEMA_VERSION, type GlobalDefaults, type ModelRef } from "../src/types.ts";

const small: ModelRef = { provider: "example", model: "small" };
const medium: ModelRef = { provider: "example", model: "medium" };
const large: ModelRef = { provider: "example", model: "large" };
const defaults: GlobalDefaults = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  intensity: "normal",
  small,
  medium,
  large,
};

type TestModel = { provider: string; id: string; name: string; reasoning: boolean };

function model(reference: ModelRef): TestModel {
  return {
    provider: reference.provider,
    id: reference.model,
    name: reference.model,
    reasoning: true,
  };
}

async function withAgentDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "guard-mode-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    await callback(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function guardMode(overrides: Partial<GuardMode["reviewer"]> = {}, consult = false): GuardMode {
  return {
    consultBeforeFirstChange: consult,
    reviewer: { model: null, mode: "off", ...overrides },
  };
}

test("the guard sidecar is strict: a version, the switch and the reviewer, and no other key", () => {
  assert.deepEqual(parseGuardMode({ schemaVersion: 2, consultBeforeFirstChange: true }), {
    ...guardMode(),
    consultBeforeFirstChange: true,
  });
  assert.deepEqual(
    parseGuardMode({ schemaVersion: 2, reviewer: { model: "example/reviewer", mode: "observe" } }),
    guardMode({ model: "example/reviewer", mode: "observe" }),
  );
  // A file that states nothing states the defaults.
  assert.deepEqual(parseGuardMode({ schemaVersion: 2 }), defaultGuardMode());
  // An explicit null is how a hand edit says "no reviewer", so it keeps the consult switch alone.
  assert.deepEqual(parseGuardMode({ schemaVersion: 2, reviewer: null }), defaultGuardMode());
  assert.deepEqual(
    parseGuardMode({ schemaVersion: 2, consultBeforeFirstChange: true, reviewer: null }),
    guardMode({}, true),
  );
  for (const value of [
    undefined,
    null,
    [],
    {},
    { schemaVersion: 3, consultBeforeFirstChange: true },
    { schemaVersion: 1, reviewer: { model: "example/reviewer" } },
    { schemaVersion: 2, consultBeforeFirstChange: "true" },
    { schemaVersion: 2, consultBeforeFirstChange: 1 },
    { schemaVersion: 2, mode: "enforce" },
    // A reviewer is a model and a mode, and a mode that acts needs a model.
    { schemaVersion: 2, reviewer: { mode: "enforce" } },
    { schemaVersion: 2, reviewer: { model: null, mode: "observe" } },
    { schemaVersion: 2, reviewer: { model: "example/reviewer", mode: "shadow" } },
    { schemaVersion: 2, reviewer: { model: "not-a-key" } },
    { schemaVersion: 2, reviewer: { model: "/reviewer" } },
    { schemaVersion: 2, reviewer: { model: "example/reviewer", tool: "x" } },
    { schemaVersion: 2, reviewer: "example/reviewer" },
    { schemaVersion: 2, reviewer: { model: "example/reviewer", mode: "enforce" }, extra: true },
  ])
    assert.equal(parseGuardMode(value), undefined, JSON.stringify(value));
});

test("a schema-1 file is still read, with the reviewer off", async () => {
  await withAgentDirectory(async (directory) => {
    const path = getGuardModePath(getGlobalConfigPath(directory));
    await writeFile(
      path,
      `${JSON.stringify({ schemaVersion: 1, consultBeforeFirstChange: true })}\n`,
    );
    assert.deepEqual(await readGuardMode(getGlobalConfigPath(directory)), {
      mode: guardMode({}, true),
      invalid: false,
    });
  });
});

test("a missing guard file is off, and an unreadable one is off and reported", async () => {
  await withAgentDirectory(async (directory) => {
    const path = getGuardModePath(getGlobalConfigPath(directory));
    assert.deepEqual(await readGuardMode(getGlobalConfigPath(directory)), {
      mode: defaultGuardMode(),
      invalid: false,
    });

    await writeFile(path, "{ not json\n");
    assert.deepEqual(await readGuardMode(getGlobalConfigPath(directory)), {
      mode: defaultGuardMode(),
      invalid: true,
    });
    assert.deepEqual(guardModeDiagnostic(true), {
      scope: "guard",
      reportWhenOff: true,
      message:
        "Guard settings are invalid and were ignored; guard holds nothing before the first change and starts no reviewer. Fix or remove delegation-policy.guard.json.",
    });
    assert.equal(guardModeDiagnostic(false), undefined);
  });
});

test("the guard switch round-trips through its file and off removes it", async () => {
  await withAgentDirectory(async (directory) => {
    const path = getGuardModePath(getGlobalConfigPath(directory));
    assert.equal(
      await writeGuardMode(guardMode({}, true), getGlobalConfigPath(directory)),
      "saved",
    );
    // Only what differs from the default is stored, so the file says what the user chose.
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      schemaVersion: 2,
      consultBeforeFirstChange: true,
    });
    assert.deepEqual(await readGuardMode(getGlobalConfigPath(directory)), {
      mode: guardMode({}, true),
      invalid: false,
    });

    // The same value again is no write at all.
    assert.equal(
      await writeGuardMode(guardMode({}, true), getGlobalConfigPath(directory)),
      "unchanged",
    );
    // Off is the absent file, so the default has one representation on disk.
    assert.equal(
      await writeGuardMode(guardMode({}, false), getGlobalConfigPath(directory)),
      "saved",
    );
    await assert.rejects(readFile(path, "utf8"));
    assert.equal(
      await writeGuardMode(guardMode({}, false), getGlobalConfigPath(directory)),
      "unchanged",
    );
  });
});

test("the reviewer round-trips through its file, and a model without a mode runs nothing", async () => {
  await withAgentDirectory(async (directory) => {
    const path = getGuardModePath(getGlobalConfigPath(directory));
    assert.equal(
      await writeGuardMode(
        guardMode({ model: "example/reviewer", mode: "enforce" }, true),
        getGlobalConfigPath(directory),
      ),
      "saved",
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      schemaVersion: 2,
      consultBeforeFirstChange: true,
      reviewer: { model: "example/reviewer", mode: "enforce" },
    });
    assert.deepEqual(await readGuardMode(getGlobalConfigPath(directory)), {
      mode: guardMode({ model: "example/reviewer", mode: "enforce" }, true),
      invalid: false,
    });

    // A mode with no model is stored as off: there is nothing to run.
    assert.equal(
      await writeGuardMode(
        guardMode({ model: null, mode: "enforce" }, true),
        getGlobalConfigPath(directory),
      ),
      "saved",
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      schemaVersion: 2,
      consultBeforeFirstChange: true,
    });
    // The last model removed with the switch off leaves no file at all.
    assert.equal(await writeGuardMode(guardMode(), getGlobalConfigPath(directory)), "saved");
    await assert.rejects(readFile(path, "utf8"));
  });
});

test("a guard file this writer cannot read is reported instead of replaced", async () => {
  await withAgentDirectory(async (directory) => {
    const path = getGuardModePath(getGlobalConfigPath(directory));
    await writeFile(path, `${JSON.stringify({ schemaVersion: 2, mode: "enforce" })}\n`);
    const before = await readFile(path, "utf8");
    assert.equal(
      await writeGuardMode(guardMode({}, true), getGlobalConfigPath(directory)),
      "unknown-state",
    );
    assert.equal(
      await readFile(path, "utf8"),
      before,
      "the file that cannot be read stays as it is",
    );
  });
});

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_HOME = "\x1b[H";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";
const KEY_CTRL_C = "\x03";
const FIELD = "guardConsult";

type InteractiveComponent = Component & { focused?: boolean };

function sendKeys(panel: InteractiveComponent, ...keys: string[]): void {
  for (const key of keys) panel.handleInput?.(key);
}

/** The panel needs the whole option set; these are the rows this case does not exercise. */
function createPanelHarness(
  options: {
    guardMode?: DelegatePanelOptions["guardMode"];
    guardModeInvalid?: DelegatePanelOptions["guardModeInvalid"];
    onSaveGuardMode?: DelegatePanelOptions["onSaveGuardMode"];
    mainModel?: DelegatePanelOptions["mainModel"];
    effectiveLevel?: DelegatePanelOptions["effectiveLevel"];
    reviewerModelIssue?: DelegatePanelOptions["reviewerModelIssue"];
  } = {},
) {
  const done: DelegatePanelResult[] = [];
  const panel = new DelegatePanel({
    tui: { terminal: { rows: 40 }, requestRender: () => undefined } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    global: defaults,
    session: { schemaVersion: CURRENT_SCHEMA_VERSION },
    candidates: [small, medium, large].map(model) as never,
    diagnostics: [],
    hasRuntimeError: false,
    guardMode: options.guardMode,
    guardModeInvalid: options.guardModeInvalid,
    onSaveGuardMode: options.onSaveGuardMode,
    mainModel: options.mainModel,
    // A reviewer acts only in `guard`, so the acting states are the ones under test by default.
    effectiveLevel: options.effectiveLevel ?? "guard",
    reviewerModelIssue: options.reviewerModelIssue,
    onApply: async () => true,
    onSaveDefaults: async () => ({ kind: "unchanged" }),
    onDone: (result) => done.push(result),
  });
  panel.focused = true;
  return { panel, done };
}

/** Rows appear and disappear with the configuration, so the focus moves by name, not by count. */
function focusField(panel: DelegatePanel, field: string): void {
  sendKeys(panel, KEY_HOME);
  const fields = panel.visibleFields() as string[];
  const target = fields.indexOf(field);
  if (target < 0) throw new Error(`the panel does not show ${field}: ${fields.join(", ")}`);
  sendKeys(panel, ...Array.from({ length: target }, () => KEY_DOWN));
}

/** The row as it renders once the focus is on it, which is what puts it in the viewport. */
function focusRow(options: Parameters<typeof createPanelHarness>[0]): string {
  const { panel } = createPanelHarness(options);
  focusField(panel, FIELD);
  return panel.render(100).join("\n");
}

function reviewerRow(options: Parameters<typeof createPanelHarness>[0], field: string): string {
  const { panel } = createPanelHarness(options);
  focusField(panel, field);
  return panel.render(100).join("\n");
}

/** A wrapped paragraph, unwrapped again so an assertion can name the sentence, not the line. */
function paragraph(panel: DelegatePanel): string {
  return panel.render(100).join(" ").replace(/\s+/g, " ");
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return assert.fail(`${path} was never written`);
}

test("the panel row states the switch, its scope and an unreadable file", () => {
  assert.match(focusRow({}), /^[> ] Guard consult first +off · default *$/m);
  assert.match(focusRow({ guardMode: guardMode({}, true) }), /on · global/);
  // An unreadable file leaves the level behaving as it does with everything off, and the row says
  // that is not a choice the user made.
  assert.match(
    focusRow({ guardModeInvalid: true }),
    /^[> ] Guard consult first +Invalid · off *$/m,
  );
});

test("the row explains what the switch does before it is turned on", () => {
  const { panel } = createPanelHarness({ onSaveGuardMode: async () => "unchanged" });
  focusField(panel, FIELD);
  const view = panel.render(100).join("\n");
  // The effect is in the row hint, and the picker states it again where the choice is made.
  assert.match(
    view,
    /Holds the first change of every guard task until an Advisor consultation answers/,
  );
  assert.match(view, /other levels are not affected/);
  sendKeys(panel, KEY_ENTER);
  assert.match(panel.render(100).join("\n"), /hold nothing before the first change \(default\)/);
  assert.match(
    panel.render(100).join("\n"),
    /hold the first change of every guard task until a consultation answers/,
  );
});

test("choosing on writes the switch through its own callback", async () => {
  const saved: GuardMode[] = [];
  const { panel } = createPanelHarness({
    onSaveGuardMode: async (mode) => {
      saved.push(mode);
      return "saved";
    },
  });
  focusField(panel, FIELD);
  // The first choice is the default, so the hold is one step below it.
  sendKeys(panel, KEY_ENTER, KEY_UP, KEY_ENTER);
  assert.match(panel.render(100).join("\n"), /^[> ] Guard consult first +on · global *$/m);
  assert.equal(saved.length, 0, "staging a value writes nothing");
  sendKeys(panel, "a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, [guardMode({}, true)]);
});

test("a panel without a writer refuses the switch instead of staging it", () => {
  const { panel } = createPanelHarness({});
  focusField(panel, FIELD);
  sendKeys(panel, KEY_ENTER, KEY_UP, KEY_ENTER);
  assert.match(panel.render(100).join("\n"), /No writer for delegation-policy\.guard\.json/);
  assert.match(panel.render(100).join("\n"), /^[> ] Guard consult first +off · default *$/m);
});

test("the reviewer rows state the model, the mode and what stops them", () => {
  assert.match(reviewerRow({}, "guardReviewerModel"), /not set · rules only/);
  assert.match(reviewerRow({}, "guardReviewerMode"), /^[> ] Guard reviewer mode +off *$/m);
  const observing = guardMode({ model: "example/large", mode: "observe" });
  assert.match(
    reviewerRow({ guardMode: observing }, "guardReviewerModel"),
    /example\/large · observing/,
  );
  assert.match(reviewerRow({ guardMode: observing }, "guardReviewerMode"), /observe/);
  assert.match(
    reviewerRow(
      { guardMode: guardMode({ model: "example/large", mode: "enforce" }) },
      "guardReviewerModel",
    ),
    /example\/large · enforcing/,
  );
  // A model that cannot act says why, and the mode row says it is not running.
  const noCredential = { reviewerModelIssue: () => "no-credential" as const };
  assert.match(
    reviewerRow(
      { guardMode: guardMode({ model: "example/large", mode: "enforce" }), ...noCredential },
      "guardReviewerModel",
    ),
    /example\/large · no credential · reviewer off/,
  );
  assert.match(
    reviewerRow(
      { guardMode: guardMode({ model: "example/large", mode: "enforce" }), ...noCredential },
      "guardReviewerMode",
    ),
    /enforce · not running/,
  );
  assert.match(
    reviewerRow(
      { guardMode: guardMode({ model: "example/gone", mode: "observe" }) },
      "guardReviewerModel",
    ),
    /example\/gone · not available · reviewer off/,
  );
  // The main model is never the reviewer.
  assert.match(
    reviewerRow(
      {
        guardMode: guardMode({ model: "example/medium", mode: "observe" }),
        mainModel: "example/medium",
      },
      "guardReviewerModel",
    ),
    /example\/medium · same as the main model · reviewer off/,
  );
  // The rows are inert outside `guard`, and they say which level they saw.
  assert.match(
    reviewerRow(
      {
        guardMode: guardMode({ model: "example/large", mode: "observe" }),
        effectiveLevel: "strict",
      },
      "guardReviewerModel",
    ),
    /example\/large · idle \(level is strict\)/,
  );
  // An unreadable companion is not a choice either.
  const invalid = { guardModeInvalid: true };
  assert.match(reviewerRow(invalid, "guardReviewerModel"), /Invalid · off/);
  assert.match(reviewerRow(invalid, "guardReviewerMode"), /Invalid · off/);
});

test("choosing a reviewer model starts in observe and states what travels", () => {
  const { panel } = createPanelHarness({ onSaveGuardMode: async () => "unchanged" });
  focusField(panel, "guardReviewerModel");
  sendKeys(panel, KEY_ENTER);
  const picker = panel.render(100).join("\n");
  assert.match(picker, /None/);
  assert.match(picker, /rules only, no reviewer calls/);
  // None is pinned first, so the first model is one step down.
  sendKeys(panel, KEY_DOWN, KEY_ENTER);
  const notice = paragraph(panel);
  // The disclosure is read once, here, and it says what travels and what never does. The caveat
  // opens the text, so a short terminal never loses it.
  assert.match(
    notice,
    /The guard reviewer is a second opinion, not a sandbox\. It checks each change/,
  );
  assert.match(notice, /the pending call's path and the start of the new content or the command/);
  assert.match(notice, /to example\/large/);
  assert.match(
    notice,
    /It never sends tool output, the agent's own text or this project's instruction files/,
  );
  assert.match(notice, /One review is one small model call, and a block pays for one more/);
  assert.match(notice, /Enter or Esc returns to the settings/);
  sendKeys(panel, KEY_ENTER);
  assert.match(
    panel.render(100).join("\n"),
    /^[> ] Guard reviewer model +example\/large · observing *$/m,
  );
  // The reviewer lives in the guard companion, never in the session draft.
  assert.deepEqual(panel.getDraft(), { schemaVersion: CURRENT_SCHEMA_VERSION });
});

test("the picker never offers the main model", () => {
  const { panel } = createPanelHarness({ mainModel: "example/medium" });
  focusField(panel, "guardReviewerModel");
  sendKeys(panel, KEY_ENTER);
  const view = panel.render(100).join("\n");
  assert.match(view, /example\/large|large \[example\]/);
  assert.match(view, /small \[example\]/);
  assert.doesNotMatch(view, /medium/, "the main model judges nothing, not even itself");
});

test("choosing a reviewer model returns the mode to observe, same model or another", () => {
  const enforced = () =>
    createPanelHarness({
      guardMode: guardMode({ model: "example/large", mode: "enforce" }),
      onSaveGuardMode: async () => "unchanged",
    });
  // The current model is preselected, so Enter re-picks it and the mode still drops to observe.
  const same = enforced();
  focusField(same.panel, "guardReviewerModel");
  sendKeys(same.panel, KEY_ENTER, KEY_ENTER, KEY_ENTER);
  assert.match(same.panel.render(100).join("\n"), /example\/large · observing/);

  const other = enforced();
  focusField(other.panel, "guardReviewerModel");
  sendKeys(other.panel, KEY_ENTER, KEY_DOWN, KEY_ENTER, KEY_ENTER);
  assert.match(other.panel.render(100).join("\n"), /example\/medium · observing/);
});

test("the mode refuses to switch on a reviewer that cannot run", () => {
  const withoutModel = createPanelHarness({ onSaveGuardMode: async () => "unchanged" });
  focusField(withoutModel.panel, "guardReviewerMode");
  sendKeys(withoutModel.panel, KEY_ENTER);
  assert.match(
    withoutModel.panel.render(100).join("\n"),
    /No reviewer model is set, so there is nothing to switch on/,
  );
  sendKeys(withoutModel.panel, KEY_ENTER);
  const view = withoutModel.panel.render(100).join("\n");
  assert.match(view, /No reviewer model is set, so there is nothing to switch on/);
  assert.match(view, /^[> ] Guard reviewer mode +off *$/m);

  const noCredential = createPanelHarness({
    guardMode: guardMode({ model: "example/large", mode: "observe" }),
    reviewerModelIssue: () => "no-credential",
    onSaveGuardMode: async () => "unchanged",
  });
  focusField(noCredential.panel, "guardReviewerMode");
  sendKeys(noCredential.panel, KEY_ENTER, KEY_DOWN, KEY_ENTER);
  assert.match(noCredential.panel.render(100).join("\n"), /no configured credential here/);
  assert.match(noCredential.panel.render(100).join("\n"), /observe · not running/);

  const mainModel = createPanelHarness({
    guardMode: guardMode({ model: "example/medium", mode: "observe" }),
    mainModel: "example/medium",
    onSaveGuardMode: async () => "unchanged",
  });
  focusField(mainModel.panel, "guardReviewerMode");
  sendKeys(mainModel.panel, KEY_ENTER, KEY_DOWN, KEY_ENTER);
  assert.match(mainModel.panel.render(100).join("\n"), /cannot be the main model/);
});

test("switching to enforce states what a block does", async () => {
  const saved: GuardMode[] = [];
  const { panel } = createPanelHarness({
    guardMode: guardMode({ model: "example/large", mode: "observe" }),
    onSaveGuardMode: async (mode) => {
      saved.push(mode);
      return "saved";
    },
  });
  focusField(panel, "guardReviewerMode");
  sendKeys(panel, KEY_ENTER, KEY_DOWN, KEY_ENTER);
  const confirm = paragraph(panel);
  assert.match(confirm, /a blocked call is not run/);
  assert.match(confirm, /must consult the Advisor before retrying/);
  assert.match(confirm, /3 blocks in a row stop it and ask you/);
  assert.match(confirm, /Some blocks will be wrong/);
  assert.match(confirm, /return to observe at any time/);
  // The confirmation names the model that would keep enforcing, and says how to decline.
  assert.match(confirm, /Enter keeps example\/large in enforce/);
  assert.match(confirm, /Enter confirms enforcing\. Esc or Ctrl\+C keeps the previous mode/);
  sendKeys(panel, KEY_ENTER);
  assert.match(panel.render(100).join("\n"), /^[> ] Guard reviewer mode +enforce *$/m);
  sendKeys(panel, "a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, [guardMode({ model: "example/large", mode: "enforce" })]);
});

test("the enforce confirmation can be declined and the previous mode comes back", async () => {
  for (const decline of [KEY_ESCAPE, KEY_CTRL_C]) {
    const saved: GuardMode[] = [];
    const { panel } = createPanelHarness({
      guardMode: guardMode({ model: "example/large", mode: "observe" }),
      onSaveGuardMode: async (mode) => {
        saved.push(mode);
        return "saved";
      },
    });
    focusField(panel, "guardReviewerMode");
    // Observe, then enforce, then decline: the row never claims a mode the user refused.
    sendKeys(panel, KEY_ENTER, KEY_DOWN, KEY_ENTER);
    assert.match(paragraph(panel), /Enter keeps example\/large in enforce/);
    sendKeys(panel, decline);
    assert.match(panel.render(100).join("\n"), /^[> ] Guard reviewer mode +observe *$/m);
    assert.equal(panel.isDirty(), false, "a declined switch stages nothing");
    sendKeys(panel, "a");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(saved, [], "nothing is written for a declined confirmation");
  }
});

test("a panel save round-trips the guard settings through the real writer", async () => {
  await withAgentDirectory(async (directory) => {
    const configPath = getGlobalConfigPath(directory);
    const path = getGuardModePath(configPath);
    const { panel } = createPanelHarness({
      // The editor writes the whole companion, exactly as `/delegate` does.
      onSaveGuardMode: (mode) => writeGuardMode(mode, configPath),
    });
    focusField(panel, "guardReviewerModel");
    sendKeys(panel, KEY_ENTER, KEY_DOWN, KEY_ENTER, KEY_ENTER);
    sendKeys(panel, "a");
    assert.deepEqual(JSON.parse(await waitForFile(path)), {
      schemaVersion: 2,
      reviewer: { model: "example/large", mode: "observe" },
    });
    const reloaded: LoadedGuardMode = await readGuardMode(configPath);
    assert.deepEqual(reloaded, {
      mode: guardMode({ model: "example/large", mode: "observe" }),
      invalid: false,
    });
    // Reopening the row reads that same file back, so the rows state what the guard will do.
    const reopened = createPanelHarness({
      guardMode: reloaded.mode,
      onSaveGuardMode: (mode) => writeGuardMode(mode, configPath),
    });
    focusField(reopened.panel, "guardReviewerModel");
    assert.match(reopened.panel.render(100).join("\n"), /example\/large · observing/);
  });
});

function runtimeState(guard: LoadedGuardMode): RuntimeState {
  const session = { schemaVersion: CURRENT_SCHEMA_VERSION };
  return {
    effective: resolveDelegateState(defaults, session),
    global: defaults,
    session,
    diagnostics: [],
    modelStatuses: new Map(),
    runtimeErrors: [],
    guardMode: guard,
  };
}

test("status reports the reviewer token next to the switch", () => {
  // A missing file is off with no model, and it says so instead of leaving the token out.
  assert.match(
    statusText(runtimeState({ mode: defaultGuardMode(), invalid: false })),
    /guard-reviewer=off \(none\)/,
  );
  assert.match(
    statusText(
      runtimeState({
        mode: guardMode({ model: "example/reviewer", mode: "enforce" }),
        invalid: false,
      }),
    ),
    /guard-reviewer=enforce \(example\/reviewer\)/,
  );
  assert.match(
    statusText(
      runtimeState({
        mode: guardMode({ model: "example/reviewer", mode: "observe" }),
        invalid: false,
      }),
    ),
    /guard-reviewer=observe \(example\/reviewer\)/,
  );
  const broken = statusText(runtimeState({ mode: defaultGuardMode(), invalid: true }));
  assert.match(broken, /guard-consult=off \(invalid\)/);
  // The reviewer token names the broken file too, instead of leaving it out of the picture.
  assert.match(broken, /guard-reviewer=off \(invalid\)/);
});

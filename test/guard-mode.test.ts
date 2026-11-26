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
} from "../src/guard-mode.ts";
import { getGlobalConfigPath } from "../src/config.ts";
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

test("the guard sidecar is strict: a version, one boolean, and no unknown key", () => {
  assert.deepEqual(parseGuardMode({ schemaVersion: 1, consultBeforeFirstChange: true }), {
    consultBeforeFirstChange: true,
  });
  assert.deepEqual(parseGuardMode({ schemaVersion: 1, consultBeforeFirstChange: false }), {
    consultBeforeFirstChange: false,
  });
  // A file that states no switch states the default, which is off.
  assert.deepEqual(parseGuardMode({ schemaVersion: 1 }), defaultGuardMode());
  for (const value of [
    undefined,
    null,
    [],
    {},
    { schemaVersion: 2, consultBeforeFirstChange: true },
    { schemaVersion: 1, consultBeforeFirstChange: "true" },
    { schemaVersion: 1, consultBeforeFirstChange: 1 },
    { schemaVersion: 1, consultBeforeFirstChange: null },
    // A key this version does not write is a state it cannot interpret, not one it half-applies.
    { schemaVersion: 1, consultBeforeFirstChange: true, reviewer: { model: "example/advisor" } },
    { schemaVersion: 1, mode: "enforce" },
  ])
    assert.equal(parseGuardMode(value), undefined, JSON.stringify(value));
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
        "Guard settings are invalid and were ignored; guard holds nothing before the first change. Fix or remove delegation-policy.guard.json.",
    });
    assert.equal(guardModeDiagnostic(false), undefined);
  });
});

test("the guard switch round-trips through its file and off removes it", async () => {
  await withAgentDirectory(async (directory) => {
    const path = getGuardModePath(getGlobalConfigPath(directory));
    assert.equal(
      await writeGuardMode({ consultBeforeFirstChange: true }, getGlobalConfigPath(directory)),
      "saved",
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      schemaVersion: 1,
      consultBeforeFirstChange: true,
    });
    assert.deepEqual(await readGuardMode(getGlobalConfigPath(directory)), {
      mode: { consultBeforeFirstChange: true },
      invalid: false,
    });

    // The same value again is no write at all.
    assert.equal(
      await writeGuardMode({ consultBeforeFirstChange: true }, getGlobalConfigPath(directory)),
      "unchanged",
    );
    // Off is the absent file, so the default has one representation on disk.
    assert.equal(
      await writeGuardMode({ consultBeforeFirstChange: false }, getGlobalConfigPath(directory)),
      "saved",
    );
    await assert.rejects(readFile(path, "utf8"));
    assert.equal(
      await writeGuardMode({ consultBeforeFirstChange: false }, getGlobalConfigPath(directory)),
      "unchanged",
    );
  });
});

test("a guard file this writer cannot read is reported instead of replaced", async () => {
  await withAgentDirectory(async (directory) => {
    const path = getGuardModePath(getGlobalConfigPath(directory));
    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, mode: "enforce" })}\n`);
    const before = await readFile(path, "utf8");
    assert.equal(
      await writeGuardMode({ consultBeforeFirstChange: true }, getGlobalConfigPath(directory)),
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
const FIELD = "guardConsult";

type InteractiveComponent = Component & { focused?: boolean };

function sendKeys(panel: InteractiveComponent, ...keys: string[]): void {
  for (const key of keys) panel.handleInput?.(key);
}

/** The panel needs the whole option set; these are the rows this case does not exercise. */
function createPanelHarness(options: {
  guardConsult?: DelegatePanelOptions["guardConsult"];
  guardConsultInvalid?: DelegatePanelOptions["guardConsultInvalid"];
  onSaveGuardConsult?: DelegatePanelOptions["onSaveGuardConsult"];
}) {
  const done: DelegatePanelResult[] = [];
  const panel = new DelegatePanel({
    tui: { terminal: { rows: 30 }, requestRender: () => undefined } as never,
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
    guardConsult: options.guardConsult,
    guardConsultInvalid: options.guardConsultInvalid,
    onSaveGuardConsult: options.onSaveGuardConsult,
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

test("the panel row states the switch, its scope and an unreadable file", () => {
  assert.match(focusRow({}), /^[> ] Guard consult first +off · default *$/m);
  assert.match(focusRow({ guardConsult: true }), /^[> ] Guard consult first +on · global *$/m);
  // An unreadable file leaves the level behaving as it does with the switch off, and the row says
  // that is not a choice the user made.
  assert.match(
    focusRow({ guardConsultInvalid: true }),
    /^[> ] Guard consult first +Invalid · off *$/m,
  );
});

test("the row explains what the switch does before it is turned on", () => {
  const { panel } = createPanelHarness({ onSaveGuardConsult: async () => "unchanged" });
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
  const saved: boolean[] = [];
  const { panel } = createPanelHarness({
    onSaveGuardConsult: async (consult) => {
      saved.push(consult);
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
  assert.deepEqual(saved, [true]);
});

test("a panel without a writer refuses the switch instead of staging it", () => {
  const { panel } = createPanelHarness({});
  focusField(panel, FIELD);
  sendKeys(panel, KEY_ENTER, KEY_UP, KEY_ENTER);
  assert.match(panel.render(100).join("\n"), /No writer for delegation-policy\.guard\.json/);
  assert.match(panel.render(100).join("\n"), /^[> ] Guard consult first +off · default *$/m);
});

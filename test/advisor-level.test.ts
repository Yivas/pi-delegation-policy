import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ADVISOR_LEVEL_ENTRY_TYPE,
  advisorLevelDiagnostic,
  advisorLevelEntry,
  emptyAdvisorLevelFile,
  getAdvisorLevelPath,
  mainModelKey,
  parseAdvisorLevelEntry,
  parseAdvisorLevelFile,
  readAdvisorLevelFile,
  resolveAdvisorLevel,
  sessionAdvisorLevel,
  writeAdvisorLevelFile,
} from "../src/advisor-level.ts";

function modelKeys(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`provider/model-${index}`, "strict"]),
  );
}

test("the level file accepts unknown keys but rejects a wrong version or a bad known value", () => {
  assert.deepEqual(parseAdvisorLevelFile({ schemaVersion: 1 }), { models: {} });
  assert.deepEqual(parseAdvisorLevelFile({ schemaVersion: 1, level: "strict", future: [1] }), {
    level: "strict",
    models: {},
  });
  // A level this build knows is stored like any other: the file validates by membership.
  assert.deepEqual(parseAdvisorLevelFile({ schemaVersion: 1, level: "guard" }), {
    level: "guard",
    models: {},
  });
  assert.deepEqual(
    parseAdvisorLevelFile({
      schemaVersion: 1,
      models: { "anthropic/claude": "off" },
      context: "manual",
    }),
    { models: { "anthropic/claude": "off" }, context: "manual" },
  );

  assert.equal(parseAdvisorLevelFile({ schemaVersion: 2, level: "strict" }), undefined);
  assert.equal(parseAdvisorLevelFile({ level: "strict" }), undefined);
  assert.equal(parseAdvisorLevelFile({ schemaVersion: 1, level: "remind" }), undefined);
  assert.equal(parseAdvisorLevelFile({ schemaVersion: 1, context: "auto" }), undefined);
  assert.equal(parseAdvisorLevelFile({ schemaVersion: 1, models: [] }), undefined);
  assert.equal(parseAdvisorLevelFile({ schemaVersion: 1, models: "none" }), undefined);
  assert.equal(parseAdvisorLevelFile({ schemaVersion: 1, models: { "a/b": "remind" } }), undefined);
  assert.equal(parseAdvisorLevelFile({ schemaVersion: 1, models: { "": "off" } }), undefined);
  assert.equal(parseAdvisorLevelFile({ schemaVersion: 1, models: modelKeys(65) }), undefined);
  assert.deepEqual(parseAdvisorLevelFile({ schemaVersion: 1, models: modelKeys(64) }), {
    models: modelKeys(64),
  });

  for (const value of [null, undefined, "text", 7, [1]])
    assert.equal(parseAdvisorLevelFile(value), undefined);
});

test("a missing level file is the default, an unreadable one is reported and a valid one loads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-advisor-level-"));
  try {
    const configPath = join(directory, "delegation-policy.json");
    assert.equal(
      getAdvisorLevelPath(configPath),
      join(directory, "delegation-policy.advisor-level.json"),
    );
    assert.deepEqual(await readAdvisorLevelFile(configPath), {
      file: emptyAdvisorLevelFile(),
      present: false,
      invalid: false,
    });

    await writeFile(getAdvisorLevelPath(configPath), "{ broken", "utf8");
    assert.deepEqual(await readAdvisorLevelFile(configPath), {
      file: emptyAdvisorLevelFile(),
      present: true,
      invalid: true,
    });

    await writeFile(
      getAdvisorLevelPath(configPath),
      `${JSON.stringify({ schemaVersion: 1, level: "strict", models: {} })}\n`,
      "utf8",
    );
    assert.deepEqual(await readAdvisorLevelFile(configPath), {
      file: { level: "strict", models: {} },
      present: true,
      invalid: false,
    });

    await writeFile(
      getAdvisorLevelPath(configPath),
      `${JSON.stringify({ schemaVersion: 3, level: "strict" })}\n`,
      "utf8",
    );
    assert.deepEqual(await readAdvisorLevelFile(configPath), {
      file: emptyAdvisorLevelFile(),
      present: true,
      invalid: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("writing refuses an unreadable file and leaves it exactly as it was", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-advisor-level-"));
  try {
    const configPath = join(directory, "delegation-policy.json");
    const path = getAdvisorLevelPath(configPath);

    await writeFile(path, "{ broken", "utf8");
    assert.equal(
      await writeAdvisorLevelFile({ level: "strict", models: {} }, configPath),
      "unknown-state",
    );
    assert.equal(await readFile(path, "utf8"), "{ broken");

    await writeFile(path, `${JSON.stringify({ schemaVersion: 2 })}\n`, "utf8");
    assert.equal(await writeAdvisorLevelFile({ models: {} }, configPath), "unknown-state");
    assert.equal(await readFile(path, "utf8"), `${JSON.stringify({ schemaVersion: 2 })}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("writing round-trips, reports an unchanged save, sorts model keys and removes an empty file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-advisor-level-"));
  try {
    const configPath = join(directory, "delegation-policy.json");
    const path = getAdvisorLevelPath(configPath);

    assert.equal(await writeAdvisorLevelFile(emptyAdvisorLevelFile(), configPath), "unchanged");

    assert.equal(
      await writeAdvisorLevelFile(
        {
          level: "strict",
          models: { "zeta/model": "off", "alpha/model": "strict" },
          context: "manual",
        },
        configPath,
      ),
      "saved",
    );
    const text = await readFile(path, "utf8");
    assert.equal(text.endsWith("}\n"), true);
    const stored = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stored), ["schemaVersion", "level", "models", "context"]);
    assert.deepEqual(Object.keys(stored.models as object), ["alpha/model", "zeta/model"]);
    assert.deepEqual(await readAdvisorLevelFile(configPath), {
      file: {
        level: "strict",
        models: { "alpha/model": "strict", "zeta/model": "off" },
        context: "manual",
      },
      present: true,
      invalid: false,
    });

    assert.equal(
      await writeAdvisorLevelFile(
        {
          level: "strict",
          models: { "alpha/model": "strict", "zeta/model": "off" },
          context: "manual",
        },
        configPath,
      ),
      "unchanged",
    );

    assert.equal(
      await writeAdvisorLevelFile({ models: { "alpha/model": "off" } }, configPath),
      "saved",
    );
    const modelsOnly = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(modelsOnly), ["schemaVersion", "models"]);

    assert.equal(await writeAdvisorLevelFile(emptyAdvisorLevelFile(), configPath), "saved");
    assert.equal((await readAdvisorLevelFile(configPath)).present, false);
    assert.equal(await writeAdvisorLevelFile(emptyAdvisorLevelFile(), configPath), "unchanged");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("the newest level round-trips like the older ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-advisor-guard-"));
  try {
    const configPath = join(directory, "delegation-policy.json");
    // `guard` is a value of the same document, not a new shape: nothing about the file changes.
    assert.equal(await writeAdvisorLevelFile({ level: "guard", models: {} }, configPath), "saved");
    assert.deepEqual(await readAdvisorLevelFile(configPath), {
      file: { level: "guard", models: {} },
      present: true,
      invalid: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("a session entry carries the level or inherits with null", () => {
  assert.deepEqual(advisorLevelEntry("off"), { schemaVersion: 1, level: "off" });
  assert.deepEqual(advisorLevelEntry(null), { schemaVersion: 1, level: null });
  assert.deepEqual(parseAdvisorLevelEntry({ schemaVersion: 1, level: null }), {
    schemaVersion: 1,
    level: null,
  });
  assert.deepEqual(parseAdvisorLevelEntry({ schemaVersion: 1, level: "strict", extra: true }), {
    schemaVersion: 1,
    level: "strict",
  });

  assert.equal(parseAdvisorLevelEntry({ schemaVersion: 2, level: "strict" }), undefined);
  assert.equal(parseAdvisorLevelEntry({ schemaVersion: 1 }), undefined);
  assert.equal(parseAdvisorLevelEntry({ schemaVersion: 1, level: "remind" }), undefined);
  assert.equal(parseAdvisorLevelEntry(null), undefined);
  assert.equal(parseAdvisorLevelEntry("strict"), undefined);
});

test("the newest valid session entry decides, skipping an invalid one and ignoring other entries", () => {
  const entry = (level: unknown, customType = ADVISOR_LEVEL_ENTRY_TYPE) => ({
    type: "custom",
    customType,
    data: { schemaVersion: 1, level },
  });
  const unrelated = {
    type: "custom",
    customType: "pi-delegation-policy:other",
    data: { schemaVersion: 1, level: "off" },
  };
  const message = { type: "message", role: "user", content: "hello" };

  assert.equal(sessionAdvisorLevel([]), undefined);
  assert.equal(sessionAdvisorLevel([entry("strict")]), "strict");
  assert.equal(sessionAdvisorLevel([entry("strict"), entry("off")]), "off");
  assert.equal(sessionAdvisorLevel([entry("strict"), entry(null)]), undefined);
  assert.equal(sessionAdvisorLevel([entry("strict"), entry("remind")]), "strict");
  assert.equal(sessionAdvisorLevel([entry("strict"), { type: "custom" }]), "strict");
  assert.equal(sessionAdvisorLevel([entry("strict"), unrelated]), "strict");
  assert.equal(sessionAdvisorLevel([entry("strict"), message]), "strict");
  assert.equal(
    sessionAdvisorLevel([entry("strict"), { data: { schemaVersion: 1, level: "off" } }]),
    "strict",
  );
});

test("the resolved level follows session, model, global, reminder and default in that order", () => {
  const strictModel = {
    models: { "anthropic/claude": "strict" as const },
    level: "standard" as const,
  };

  assert.deepEqual(
    resolveAdvisorLevel({
      session: "off",
      file: strictModel,
      filePresent: true,
      model: "anthropic/claude",
    }),
    { level: "off", source: "session" },
  );
  assert.deepEqual(
    resolveAdvisorLevel({ file: strictModel, filePresent: true, model: "anthropic/claude" }),
    { level: "strict", source: "model" },
  );
  assert.deepEqual(
    resolveAdvisorLevel({ file: strictModel, filePresent: true, model: "anthropic/CLAUDE" }),
    { level: "standard", source: "global" },
  );
  assert.deepEqual(resolveAdvisorLevel({ file: strictModel, filePresent: true }), {
    level: "standard",
    source: "global",
  });
  assert.deepEqual(
    resolveAdvisorLevel({
      file: { models: {} },
      filePresent: true,
      reminderMode: "off",
      model: "anthropic/claude",
    }),
    { level: "standard", source: "default" },
  );
  assert.deepEqual(
    resolveAdvisorLevel({ file: { models: {} }, filePresent: false, reminderMode: "off" }),
    { level: "off", source: "reminder" },
  );
  assert.deepEqual(
    resolveAdvisorLevel({ file: { models: {} }, filePresent: false, reminderMode: "remind" }),
    { level: "standard", source: "default" },
  );
  assert.deepEqual(resolveAdvisorLevel({ file: { models: {} }, filePresent: false }), {
    level: "standard",
    source: "default",
  });
  assert.deepEqual(
    resolveAdvisorLevel({ file: { models: {} }, filePresent: true, model: "constructor" }),
    { level: "standard", source: "default" },
  );
});

test("a model key is named only from a short plain provider and id", () => {
  assert.equal(mainModelKey({ provider: "anthropic", id: "claude-x1.2" }), "anthropic/claude-x1.2");
  assert.equal(mainModelKey({ provider: "openai", id: "gpt-6.1-sol" }), "openai/gpt-6.1-sol");
  assert.equal(mainModelKey({ provider: "openai", id: "org/gpt-6" }), "openai/org/gpt-6");
  assert.equal(mainModelKey({ provider: "a:@._-", id: "b", extra: 1 }), "a:@._-/b");
  assert.equal(
    mainModelKey({ provider: "p".repeat(128), id: "i".repeat(128) }),
    `${"p".repeat(128)}/${"i".repeat(128)}`,
  );

  assert.equal(mainModelKey({ provider: "anthropic" }), undefined);
  assert.equal(mainModelKey({ id: "claude" }), undefined);
  assert.equal(mainModelKey({ provider: "", id: "claude" }), undefined);
  assert.equal(mainModelKey({ provider: "anthropic", id: "" }), undefined);
  assert.equal(mainModelKey({ provider: "anthropic", id: "claude 4" }), undefined);
  assert.equal(mainModelKey({ provider: "anthropic", id: "claude\n" }), undefined);
  assert.equal(mainModelKey({ provider: "p".repeat(129), id: "claude" }), undefined);
  assert.equal(mainModelKey({ provider: "anthropic", id: "i".repeat(129) }), undefined);
  for (const value of [null, undefined, "anthropic/claude", 7, ["anthropic", "claude"]])
    assert.equal(mainModelKey(value), undefined);
});

test("an invalid level file is a reported fallback, not a silent one", () => {
  assert.equal(advisorLevelDiagnostic(false), undefined);
  const diagnostic = advisorLevelDiagnostic(true);
  assert.equal(diagnostic?.scope, "advisor-level");
  assert.equal(diagnostic?.reportWhenOff, true);
  assert.match(diagnostic?.message ?? "", /delegation-policy\.advisor-level\.json/);
  assert.match(diagnostic?.message ?? "", /falls back to standard/);
});

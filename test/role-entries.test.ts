import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultsFromEffectiveState, parseConfig, resolveDelegateState } from "../src/config.ts";
import { parseCommand } from "../src/index.ts";
import { buildDelegationPolicy } from "../src/prompt.ts";
import {
  copyRoleEntries,
  getRoleEntriesPath,
  parseRoleEntries,
  readRoleEntries,
  writeRoleEntries,
} from "../src/role-entries.ts";
import {
  CURRENT_SCHEMA_VERSION,
  emptyRoleEntries,
  type GlobalDefaults,
  type SessionDelegateState,
} from "../src/types.ts";

const small = { provider: "example", model: "small" } as const;
const medium = { provider: "example", model: "medium" } as const;
const large = { provider: "example", model: "large" } as const;
const visual = { provider: "example", model: "visual" } as const;
const vision = { provider: "example", model: "vision" } as const;

const defaults: GlobalDefaults = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  intensity: "normal",
  small,
  medium,
  large,
};

const activeSession: SessionDelegateState = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  intensity: "normal",
};

test("the entry file is strict: unknown keys, gaps, duplicates and bad thinking are rejected", () => {
  assert.deepEqual(parseRoleEntries({ schemaVersion: 1 }), emptyRoleEntries());
  assert.deepEqual(parseRoleEntries({ schemaVersion: 1, vision: [vision] })?.vision, [vision]);

  assert.equal(parseRoleEntries({ schemaVersion: 2 }), undefined, "another schema is not ours");
  assert.equal(
    parseRoleEntries({ schemaVersion: 1, somethingElse: [] }),
    undefined,
    "an unknown family is rejected instead of ignored",
  );
  assert.equal(
    parseRoleEntries({ schemaVersion: 1, vision: [vision, vision] }),
    undefined,
    "the same model twice in one family makes the entry unanswerable",
  );
  assert.equal(
    parseRoleEntries({ schemaVersion: 1, vision: [vision, vision, vision, vision] }),
    undefined,
    "three entries are the limit",
  );
  assert.equal(
    parseRoleEntries({ schemaVersion: 1, vision: [{ provider: "example", model: "" }] }),
    undefined,
  );
  assert.equal(
    parseRoleEntries({
      schemaVersion: 1,
      vision: [{ ...vision, thinking: { min: "high", max: "low" } }],
    }),
    undefined,
    "an inverted range is not a policy",
  );
  assert.deepEqual(
    parseRoleEntries({ schemaVersion: 1, vision: [{ ...vision, thinking: { level: "high" } }] })
      ?.vision,
    [{ ...vision, thinking: { level: "high" } }],
  );
});

test("a missing file is the clean default and an unparseable one is reported, never replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-roles-"));
  try {
    const path = join(directory, "delegation-policy.json");
    const missing = await readRoleEntries(path);
    assert.deepEqual(missing.entries, emptyRoleEntries());
    assert.deepEqual(missing.diagnostics, []);

    const brokenPath = getRoleEntriesPath(path);
    await writeFile(brokenPath, "{ not json", "utf8");
    const broken = await readRoleEntries(path);
    assert.deepEqual(broken.entries, emptyRoleEntries());
    assert.equal(broken.diagnostics.length, 1);
    assert.match(broken.diagnostics[0]!.message, /Optional role entries are invalid/);

    // The writer must not overwrite a state it cannot read.
    assert.equal(
      await writeRoleEntries({ ...emptyRoleEntries(), vision: [vision] }, path),
      "unknown-state",
    );
    assert.equal(await readFile(brokenPath, "utf8"), "{ not json");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("the writer refuses a family with the same model twice and keeps the file it read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-roles-"));
  try {
    const path = join(directory, "delegation-policy.json");
    const stored = { ...emptyRoleEntries(), vision: [vision] };
    assert.equal(await writeRoleEntries(stored, path), "saved");
    const before = await readFile(getRoleEntriesPath(path), "utf8");

    // `/delegate vision 2 <entry 1's model>`: the list would answer "which entry" twice.
    assert.equal(
      await writeRoleEntries({ ...emptyRoleEntries(), vision: [vision, vision] }, path),
      "failed",
      "a list this reader rejects is never written",
    );
    assert.equal(await readFile(getRoleEntriesPath(path), "utf8"), before);
    assert.deepEqual((await readRoleEntries(path)).entries, stored);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("an unreadable sidecar is reported without accusing its content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-roles-"));
  try {
    const path = join(directory, "delegation-policy.json");
    // The path exists and is not absent, so the reader cannot tell what it was meant to hold.
    await mkdir(getRoleEntriesPath(path));
    const loaded = await readRoleEntries(path);
    assert.deepEqual(loaded.entries, emptyRoleEntries());
    assert.equal(loaded.diagnostics.length, 1);
    assert.match(loaded.diagnostics[0]!.message, /could not be read/);
    assert.doesNotMatch(loaded.diagnostics[0]!.message, /are invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("entries persist, round-trip, and an empty list removes the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-roles-"));
  try {
    const path = join(directory, "delegation-policy.json");
    const entries = {
      ...emptyRoleEntries(),
      vision: [{ ...vision, thinking: { level: "high" as const } }],
    };

    assert.equal(await writeRoleEntries(entries, path), "saved");
    const stored = await readRoleEntries(path);
    assert.deepEqual(stored.entries, entries);
    assert.equal(await writeRoleEntries(copyRoleEntries(entries), path), "unchanged");

    // The file holds the value this reader accepted, not the raw payload: a one-level range is the
    // fixed level it means, so the writer never stores a form its own parser would normalize.
    assert.equal(
      await writeRoleEntries(
        {
          ...emptyRoleEntries(),
          vision: [
            { ...vision, model: "vision-normalised", thinking: { min: "high", max: "high" } },
          ],
        },
        path,
      ),
      "saved",
    );
    assert.match(await readFile(getRoleEntriesPath(path), "utf8"), /"level": "high"/);
    assert.doesNotMatch(await readFile(getRoleEntriesPath(path), "utf8"), /"min"/);

    assert.equal(await writeRoleEntries(emptyRoleEntries(), path), "saved");
    const cleared = await readRoleEntries(path);
    assert.deepEqual(cleared.entries, emptyRoleEntries());
    assert.deepEqual(cleared.diagnostics, []);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("resolved entries become their own role keys with their own thinking", () => {
  const entries = {
    ...emptyRoleEntries(),
    vision: [vision, { ...vision, model: "vision-b", thinking: { level: "high" as const } }],
  };
  const effective = resolveDelegateState(defaults, activeSession, entries);

  assert.deepEqual(effective.vision, vision);
  assert.equal(effective.vision2?.model, "vision-b");
  assert.equal(effective.vision3, undefined);
  assert.deepEqual(effective.thinking.vision2, { level: "high" });
  assert.equal(effective.source.roleEntries.vision, "global");
  assert.equal(effective.source.roleEntries.vision2, "global");
  assert.equal(effective.source.roleEntries.vision3, "default");
});

test("the document keeps the first Visual Design entry and wins when it disagrees", () => {
  const withDocument = {
    ...defaults,
    uiDesign: visual,
    thinking: { uiDesign: { level: "low" as const } },
  };

  const first = resolveDelegateState(withDocument, activeSession, emptyRoleEntries());
  assert.deepEqual(first.uiDesign, visual);
  assert.deepEqual(
    first.thinking.uiDesign,
    { level: "low" },
    "the legacy key still carries entry 1",
  );

  const sidecar = {
    ...emptyRoleEntries(),
    uiDesign: [
      { ...visual, model: "other" },
      { ...visual, model: "second" },
    ],
  };
  const diverged = resolveDelegateState(withDocument, activeSession, sidecar);
  assert.deepEqual(diverged.uiDesign, visual, "an older writer edited the document, so it wins");
  assert.equal(diverged.uiDesign2?.model, "second", "the rest of the list survives");

  const disabled = resolveDelegateState(
    withDocument,
    { ...activeSession, uiDesign: null },
    sidecar,
  );
  assert.equal(disabled.uiDesign, undefined, "a session null disables the whole family");
  assert.equal(disabled.uiDesign2, undefined);
  // Clearing the family is the branch's decision, so no suppressed slot claims to be a default.
  for (const key of ["uiDesign", "uiDesign2", "uiDesign3"] as const)
    assert.equal(disabled.source.roleEntries[key], "session", key);
});

test("a model the document and the sidecar both hold is kept once and reported", () => {
  const shared = { provider: "example", model: "shared-visual" };
  const third = { provider: "example", model: "third-sidecar" };
  // The document gives entry 1 the model the sidecar holds in entry 2: the merged list would answer
  // "which entry" twice, and the writer would refuse it without saying why.
  const sidecar = {
    ...emptyRoleEntries(),
    uiDesign: [{ ...visual, model: "first-sidecar" }, shared, third],
  };
  const effective = resolveDelegateState({ ...defaults, uiDesign: shared }, activeSession, sidecar);

  assert.deepEqual(effective.uiDesign, shared);
  assert.deepEqual(effective.uiDesign2, third, "the entry behind the repeat keeps its slot");
  assert.equal(effective.uiDesign3, undefined, "the repeat is not a third entry");
  assert.deepEqual(
    effective.roleEntries.uiDesign.map(({ provider, model }) => `${provider}/${model}`),
    ["example/shared-visual", "example/third-sidecar"],
  );
  assert.deepEqual(effective.repeatedRoleEntries, [
    { key: "uiDesign2", index: 2, provider: "example", model: "shared-visual" },
  ]);
});

test("saving defaults never carries an optional entry's thinking into the document", () => {
  const entries = {
    ...emptyRoleEntries(),
    uiDesign: [
      { ...visual, model: "first-sidecar" },
      { ...visual, model: "visual-2", thinking: { level: "high" as const } },
    ],
    vision: [{ ...vision, thinking: { level: "low" as const } }],
  };
  const effective = resolveDelegateState(
    {
      ...defaults,
      uiDesign: visual,
      thinking: { uiDesign: { level: "low" as const } },
    },
    activeSession,
    entries,
  );
  assert.deepEqual(effective.thinking.uiDesign2, { level: "high" });
  assert.deepEqual(effective.thinking.vision, { level: "low" });

  const document = defaultsFromEffectiveState(effective);
  assert.deepEqual(
    document.thinking,
    { uiDesign: { level: "low" } },
    "entry thinking lives in the sidecar; the document only carries its own keys",
  );
  // What this produced has to be a document the reader accepts, not one it would reject.
  assert.deepEqual(parseConfig(document), document);
});

test("entry 1 keeps the document's thinking and only entry 1 follows the branch", () => {
  const document = {
    ...defaults,
    uiDesign: visual,
    thinking: { uiDesign: { level: "low" as const } },
  };
  const sidecar = {
    ...emptyRoleEntries(),
    uiDesign: [
      { ...visual, thinking: { level: "high" as const } },
      { ...visual, model: "second" },
      { ...visual, model: "third" },
    ],
  };

  const inherited = resolveDelegateState(document, activeSession, sidecar);
  assert.deepEqual(
    inherited.thinking.uiDesign,
    { level: "low" },
    "entry 1 thinking is the document's, never the sidecar's",
  );
  // The list agrees with the resolved policy: entry 1 carries no thinking the effective state ignores.
  assert.deepEqual(inherited.roleEntries.uiDesign[0], visual);
  assert.equal(inherited.thinking.uiDesign2, undefined, "entries 2 and 3 own their own thinking");
  assert.equal(inherited.source.uiDesign, "global");
  assert.equal(inherited.source.roleEntries.uiDesign, "global");
  assert.equal(inherited.source.roleEntries.uiDesign2, "global");

  const branch = resolveDelegateState(
    document,
    { ...activeSession, uiDesign: { provider: "example", model: "branch-visual" } },
    sidecar,
  );
  assert.deepEqual(branch.uiDesign, { provider: "example", model: "branch-visual" });
  assert.equal(branch.source.uiDesign, "session");
  assert.equal(branch.source.roleEntries.uiDesign, "session");
  assert.equal(
    branch.source.roleEntries.uiDesign2,
    "global",
    "entries 2 and 3 keep the sidecar's provenance",
  );
  assert.equal(branch.source.roleEntries.uiDesign3, "global");
});

test("the command parses each entry slot and refuses the legacy first Visual Design entry", () => {
  assert.deepEqual(parseCommand("vision example/v1"), {
    kind: "role-entry",
    key: "vision",
    values: ["example/v1"],
  });
  assert.deepEqual(parseCommand("vision 3 example/v3"), {
    kind: "role-entry",
    key: "vision3",
    values: ["example/v3"],
  });
  assert.deepEqual(parseCommand("visual-design 2 example/visual-2"), {
    kind: "role-entry",
    key: "uiDesign2",
    values: ["example/visual-2"],
  });
  assert.deepEqual(parseCommand("vision remove"), {
    kind: "role-entry",
    key: "vision",
    values: ["remove"],
  });
  // Entry 1 of Visual Design is the legacy document key; the panel owns it.
  assert.deepEqual(parseCommand("visual-design example/visual"), { kind: "invalid" });
  assert.deepEqual(parseCommand("vision 4 example/v4"), { kind: "invalid" });
});

test("the Writing family reaches the effective state and the policy block", () => {
  const writer = { provider: "example", model: "writer" } as const;
  const state = resolveDelegateState(defaults, activeSession, {
    ...emptyRoleEntries(),
    writing: [{ ...writer, thinking: { level: "high" } }],
  });
  assert.deepEqual(state.writing, writer);
  assert.equal(state.source.roleEntries.writing, "global");
  assert.deepEqual(state.thinking.writing, { level: "high" });
  assert.equal(state.writing2, undefined);

  const policy =
    buildDelegationPolicy({
      effective: state,
      diagnostics: [],
      runtimeErrors: [],
      advisorEntries: [],
      advisorWarnings: [],
      advisorErrors: [],
      modelStatuses: new Map(),
      admissions: {},
    } as never) ?? "";
  assert.match(policy, /Writing: these entries are the models the user chose for text/);
  assert.match(policy, /- Writing: exact model base: "example\/writer"/);
  assert.match(policy, /- Writing: public prose and microcopy only/);
  assert.match(policy, /that deliverable is Writing work even when the task also touches code/);

  // The claim belongs to a role the same block lists: without an advertised entry it is not emitted.
  const withoutWriting = resolveDelegateState(defaults, activeSession, emptyRoleEntries());
  const plain =
    buildDelegationPolicy({
      effective: withoutWriting,
      diagnostics: [],
      runtimeErrors: [],
      advisorEntries: [],
      advisorWarnings: [],
      advisorErrors: [],
      modelStatuses: new Map(),
      admissions: {},
    } as never) ?? "";
  assert.doesNotMatch(plain, /that deliverable is Writing work/);
});

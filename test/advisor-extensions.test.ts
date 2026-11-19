import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  childExtensionId,
  getAdvisorExtensionsPath,
  parseAdvisorExtensions,
  readAdvisorExtensions,
  sessionChildExtensions,
  setAdvisorChildExtensions,
} from "../src/advisor-extensions.ts";
import { registerChildExtensions } from "../src/agent-launch.ts";

const VALID = { schemaVersion: 1, extensions: [{ package: "prompt-layer", version: "1.2.3" }] };

test("the advisor extension file accepts only exact packages in a short list", () => {
  assert.deepEqual(parseAdvisorExtensions(VALID), [{ package: "prompt-layer", version: "1.2.3" }]);
  assert.deepEqual(parseAdvisorExtensions({ schemaVersion: 1, extensions: [] }), []);
  assert.deepEqual(
    parseAdvisorExtensions({
      schemaVersion: 1,
      extensions: [
        { package: "one", version: "1.0.0" },
        { package: "@scope/two", version: "2.0.0-beta.1" },
      ],
    }),
    [
      { package: "one", version: "1.0.0" },
      { package: "@scope/two", version: "2.0.0-beta.1" },
    ],
  );

  for (const invalid of [
    null,
    [],
    {},
    { schemaVersion: 2, extensions: [] },
    { schemaVersion: 1 },
    { schemaVersion: 1, extensions: {} },
    { schemaVersion: 1, extensions: [], extra: true },
    { schemaVersion: 1, extensions: [{ package: "one", version: "1.0" }] },
    { schemaVersion: 1, extensions: [{ package: "one", version: "latest" }] },
    { schemaVersion: 1, extensions: [{ package: "../escape", version: "1.0.0" }] },
    { schemaVersion: 1, extensions: [{ package: "one", version: "1.0.0", extra: 1 }] },
    {
      schemaVersion: 1,
      extensions: [
        { package: "one", version: "1.0.0" },
        { package: "one", version: "1.0.0" },
      ],
    },
    {
      schemaVersion: 1,
      extensions: [
        { package: "one", version: "1.0.0" },
        { package: "two", version: "1.0.0" },
        { package: "three", version: "1.0.0" },
      ],
    },
  ])
    assert.equal(parseAdvisorExtensions(invalid), undefined, JSON.stringify(invalid));
});

test("registered ids are the short opaque form the host accepts", () => {
  // Source of the pattern: pi-subagents `src/shared/required-child-extensions.js`, ID_PATTERN.
  const pattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  for (const position of [1, 2]) assert.match(childExtensionId(position), pattern);
  assert.notEqual(childExtensionId(1), childExtensionId(2));
  assert.doesNotMatch(childExtensionId(1), /[:@/]/);
});

test("registration reports only a handle the host actually returned", async () => {
  const entry = { id: childExtensionId(1), path: "/abs/entry.ts" };
  const calls: unknown[] = [];
  const registered = await registerChildExtensions("session-1", [entry], async () =>
    Promise.resolve({
      registerRequiredChildExtensions: (input: unknown) => {
        calls.push(input);
        return { dispose: () => undefined };
      },
    }),
  );
  assert.equal(typeof registered?.dispose, "function");
  assert.deepEqual(calls, [{ sessionId: "session-1", extensions: [entry] }]);

  const unsupported = await registerChildExtensions("session-1", [entry], async () =>
    Promise.resolve({}),
  );
  assert.equal(unsupported, undefined);

  const throwing = await registerChildExtensions("session-1", [entry], async () => {
    throw new Error("import failed");
  });
  assert.equal(throwing, undefined);

  // The guard has to skip the host import, not merely end up empty because it failed in this repo.
  const unused: string[] = [];
  const unusedLoader = async (specifier: string) => {
    unused.push(specifier);
    return {};
  };
  assert.equal(await registerChildExtensions("", [entry], unusedLoader), undefined);
  assert.equal(await registerChildExtensions("session-1", [], unusedLoader), undefined);
  assert.deepEqual(unused, []);

  // The specifier is the host's public subpath: a rename there must fail here, not at runtime.
  const specifiers: string[] = [];
  await registerChildExtensions("session-2", [entry], async (specifier) => {
    specifiers.push(specifier);
    return { registerRequiredChildExtensions: () => ({ dispose: () => undefined }) };
  });
  assert.deepEqual(specifiers, ["pi-subagents/required-child-extensions"]);
});

test("the host registry fallback fails closed and never replaces another writer", async () => {
  const key = Symbol.for("pi-subagents.required-child-extensions.v1");
  const root = globalThis as unknown as Record<symbol, unknown>;
  const real = join(process.cwd(), "package.json");
  const missingLoader = async () => {
    throw new Error("module not exposed to extensions");
  };
  const previous = root[key];
  try {
    // (a) The host API exists and refuses: nothing is created, nothing is written.
    delete root[key];
    const refused = await registerChildExtensions(
      "session-a",
      [{ id: "child-ext-1", path: real }],
      async () => ({
        registerRequiredChildExtensions: () => {
          throw new Error("host refused");
        },
      }),
    );
    assert.equal(refused, undefined);
    assert.equal(root[key], undefined);

    // (b) A registry this code cannot read belongs to another writer, so it stays untouched.
    const foreign = { version: 2, bySession: new Map([["other", []]]) };
    root[key] = foreign;
    assert.equal(
      await registerChildExtensions(
        "session-b",
        [{ id: "child-ext-1", path: real }],
        missingLoader,
      ),
      undefined,
    );
    assert.equal(root[key], foreign);

    // (c) A real path is written canonical, and dispose never removes someone else's entry.
    delete root[key];
    const handle = await registerChildExtensions(
      "session-c",
      [{ id: "child-ext-1", path: real }],
      missingLoader,
    );
    assert.equal(typeof handle?.dispose, "function");
    const registry = root[key] as { bySession: Map<string, readonly { path: string }[]> };
    assert.equal(registry.bySession.get("session-c")?.[0]?.path, realpathSync(real));
    handle?.dispose();
    assert.equal(registry.bySession.has("session-c"), false);

    const taken = await registerChildExtensions(
      "session-d",
      [{ id: "child-ext-1", path: real }],
      missingLoader,
    );
    registry.bySession.set("session-d", Object.freeze([{ id: "someone-else", path: real }]));
    taken?.dispose();
    assert.equal(registry.bySession.has("session-d"), true);

    // (d) A bad path leaves no empty registry behind.
    delete root[key];
    assert.equal(
      await registerChildExtensions(
        "session-e",
        [{ id: "child-ext-1", path: join(tmpdir(), "nope", "x.ts") }],
        missingLoader,
      ),
      undefined,
    );
    assert.equal(root[key], undefined);
  } finally {
    if (previous === undefined) delete root[key];
    else root[key] = previous;
  }
});

test("an empty session list means no launch expects an id the child will not load", () => {
  setAdvisorChildExtensions([]);
  assert.deepEqual(sessionChildExtensions(), []);
  const entry = { id: childExtensionId(1), path: "/abs/entry.ts" };
  setAdvisorChildExtensions([entry]);
  assert.deepEqual(sessionChildExtensions(), [entry]);
  setAdvisorChildExtensions([]);
});

test("the sidecar path sits next to the delegation document", () => {
  assert.equal(
    getAdvisorExtensionsPath("/home/user/.pi/agent/delegation-policy.json"),
    "/home/user/.pi/agent/delegation-policy.advisor-extensions.json",
  );
  assert.equal(
    getAdvisorExtensionsPath("/home/user/.pi/agent/delegation-policy"),
    "/home/user/.pi/agent/delegation-policy.advisor-extensions.json",
  );
});

test("a missing file means no extra extensions, and an unusable one is reported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-extensions-"));
  try {
    const path = join(directory, "delegation-policy.advisor-extensions.json");
    assert.deepEqual(await readAdvisorExtensions(directory, path), { extensions: [] });

    await writeFile(path, "{ not json", "utf8");
    const broken = await readAdvisorExtensions(directory, path);
    assert.deepEqual(broken.extensions, []);
    assert.match(broken.diagnostic?.message ?? "", /invalid and were ignored/);

    await writeFile(path, JSON.stringify(VALID), "utf8");
    const uninstalled = await readAdvisorExtensions(directory, path);
    assert.deepEqual(uninstalled.extensions, []);
    assert.match(uninstalled.diagnostic?.message ?? "", /not installed and configured as admitted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

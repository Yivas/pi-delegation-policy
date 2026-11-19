import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getAdvisorExtensionsPath,
  parseAdvisorExtensions,
  readAdvisorExtensions,
} from "../src/advisor-extensions.ts";

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

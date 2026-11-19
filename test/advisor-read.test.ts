import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  advisorCanRead,
  getAdvisorReadPath,
  normalizeAdvisorRead,
  trimAdvisorRead,
  parseAdvisorRead,
  readAdvisorRead,
  writeAdvisorRead,
} from "../src/advisor-read-mode.ts";
import { ADVISOR_READ_AGENT_NAME, advisorAgentName } from "../src/advisor-executor.ts";
import { ADVISOR_AGENT_NAME } from "../src/advisor-executor.ts";

test("the reading file is strict and a missing one means no Advisor reads", async () => {
  assert.deepEqual(parseAdvisorRead({ schemaVersion: 1 }), []);
  assert.deepEqual(parseAdvisorRead({ schemaVersion: 1, read: [true, false] }), [true, false]);
  assert.equal(parseAdvisorRead({ schemaVersion: 2, read: [true] }), undefined);
  assert.equal(parseAdvisorRead({ schemaVersion: 1, read: [true, "yes"] }), undefined);
  assert.equal(parseAdvisorRead({ schemaVersion: 1, read: [true, true, true, true] }), undefined);
  assert.equal(parseAdvisorRead({ schemaVersion: 1, extra: true }), undefined);

  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-advisor-read-"));
  try {
    const path = join(directory, "delegation-policy.json");
    assert.deepEqual(await readAdvisorRead(path), { read: [], invalid: false });
    await writeFile(getAdvisorReadPath(path), "{ broken", "utf8");
    assert.deepEqual(await readAdvisorRead(path), { read: [], invalid: true });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("writing drops trailing offs, refuses an unreadable file and round-trips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-advisor-read-"));
  try {
    const path = join(directory, "delegation-policy.json");
    const file = getAdvisorReadPath(path);

    await writeFile(file, "{ broken", "utf8");
    assert.equal(await writeAdvisorRead([true], path), "unknown-state");
    assert.equal(await readFile(file, "utf8"), "{ broken");

    await rm(file, { force: true });
    assert.equal(await writeAdvisorRead([false, false], path), "unchanged");
    assert.equal(await writeAdvisorRead([true, false], path), "saved");
    assert.deepEqual((await readAdvisorRead(path)).read, [true]);
    assert.equal(await writeAdvisorRead([true, false], path), "unchanged");
    assert.equal(await writeAdvisorRead([], path), "saved");
    assert.deepEqual((await readAdvisorRead(path)).read, []);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("reading selects its own profile and never replaces a provider-dependent one", () => {
  const plain = { provider: "example", model: "advisor" };
  assert.equal(advisorAgentName(plain, {}, false), ADVISOR_AGENT_NAME);
  assert.equal(advisorAgentName(plain, {}, true), ADVISOR_READ_AGENT_NAME);

  const anthropic = {
    provider: "anthropic",
    model: "claude",
    providerExtension: "anthropic-auth" as const,
  };
  assert.equal(advisorAgentName(anthropic, {}, true), advisorAgentName(anthropic, {}, false));

  assert.equal(advisorCanRead([true], 0), true);
  assert.equal(advisorCanRead([false, true], 0), false);
  assert.equal(advisorCanRead(undefined, 0), false);
});

test("a flag list with holes is written as a valid file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-advisor-read-"));
  try {
    const path = join(directory, "delegation-policy.json");
    // Slot 2 turned off while slot 1 was never set: the writer must not emit `null`.
    assert.deepEqual(trimAdvisorRead([undefined, false]), []);
    assert.deepEqual(trimAdvisorRead([undefined, true]), [false, true]);
    assert.deepEqual(normalizeAdvisorRead([undefined, true], 2), [false, true]);
    assert.equal(await writeAdvisorRead([undefined, true] as never, path), "saved");
    assert.deepEqual((await readAdvisorRead(path)).read, [false, true]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("the reading profile declares exactly one tool and no extensions", async () => {
  const { readFile } = await import("node:fs/promises");
  const profile = await readFile(
    new URL("../agents/pi-delegation-policy.advisor-read.md", import.meta.url),
    "utf8",
  );
  const frontmatter = profile.slice(0, profile.indexOf("\n---", 3));
  assert.match(frontmatter, /^name: pi-delegation-policy\.advisor-read$/m);
  // One tool, and the host's ambient extensions are not inherited.
  assert.match(frontmatter, /^tools: read$/m);
  assert.match(frontmatter, /^extensions:$/m);
  assert.doesNotMatch(frontmatter, /^tools: .*,/m, "no second tool");
  assert.match(frontmatter, /^systemPromptMode: replace$/m);
  assert.match(frontmatter, /^defaultContext: fresh$/m);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  advisorFiltered,
  advisorFilterDiagnostic,
  getAdvisorFiltersPath,
  normalizeAdvisorFilter,
  parseAdvisorFilters,
  readAdvisorFilters,
  trimAdvisorFilter,
  writeAdvisorFilters,
} from "../src/advisor-filter-mode.ts";

test("the filter file is strict and a missing one means no Advisor is flagged", async () => {
  assert.deepEqual(parseAdvisorFilters({ schemaVersion: 1 }), []);
  assert.deepEqual(parseAdvisorFilters({ schemaVersion: 1, cyber: [true, false] }), [true, false]);
  assert.equal(parseAdvisorFilters({ schemaVersion: 2, cyber: [true] }), undefined);
  assert.equal(parseAdvisorFilters({ schemaVersion: 1, cyber: [true, "yes"] }), undefined);
  assert.equal(
    parseAdvisorFilters({ schemaVersion: 1, cyber: [true, true, true, true] }),
    undefined,
  );
  assert.equal(parseAdvisorFilters({ schemaVersion: 1, read: [true] }), undefined);
  assert.equal(parseAdvisorFilters({ schemaVersion: 1, extra: true }), undefined);

  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-advisor-filter-"));
  try {
    const path = join(directory, "delegation-policy.json");
    assert.deepEqual(await readAdvisorFilters(path), { filters: [], invalid: false });
    await writeFile(getAdvisorFiltersPath(path), "{ broken", "utf8");
    assert.deepEqual(await readAdvisorFilters(path), { filters: [], invalid: true });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("writing drops trailing offs, refuses an unreadable file and round-trips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-advisor-filter-"));
  try {
    const path = join(directory, "delegation-policy.json");
    const file = getAdvisorFiltersPath(path);

    await writeFile(file, "{ broken", "utf8");
    assert.equal(await writeAdvisorFilters([true], path), "unknown-state");
    assert.equal(await readFile(file, "utf8"), "{ broken");

    await rm(file, { force: true });
    assert.equal(await writeAdvisorFilters([false, false], path), "unchanged");
    assert.equal(await writeAdvisorFilters([true, false], path), "saved");
    assert.deepEqual((await readAdvisorFilters(path)).filters, [true]);
    assert.equal(await writeAdvisorFilters([true, false], path), "unchanged");
    assert.equal(await writeAdvisorFilters([], path), "saved");
    assert.deepEqual((await readAdvisorFilters(path)).filters, []);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("flags address a slot, never a model, and never carry holes", () => {
  const filters = [false, true];
  assert.equal(advisorFiltered(filters, 0), false);
  assert.equal(advisorFiltered(filters, 1), true);
  assert.equal(advisorFiltered(filters, 2), false);
  assert.equal(advisorFiltered(undefined, 0), false);
  // A slot the user never set is off, and only slots the policy renders count for the shared rule.
  assert.deepEqual(normalizeAdvisorFilter([true, undefined, undefined], 3), [true, false, false]);
  assert.deepEqual(normalizeAdvisorFilter([true, true], 1), [true]);
  assert.deepEqual(trimAdvisorFilter([true, false, false]), [true]);
  assert.deepEqual(trimAdvisorFilter([]), []);
});

test("an invalid file is a reported suspension, not a silent flag", () => {
  assert.equal(advisorFilterDiagnostic(false), undefined);
  const diagnostic = advisorFilterDiagnostic(true);
  assert.equal(diagnostic?.scope, "advisor-filters");
  assert.equal(diagnostic?.reportWhenOff, true);
  assert.match(diagnostic?.message ?? "", /delegation-policy\.advisor-filters\.json/);
});

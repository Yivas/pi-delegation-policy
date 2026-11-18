import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getEventLogPath } from "../src/advisor-log.ts";
import {
  LAUNCH_REPORT_MAX_BYTES,
  launchSummaryText,
  readLaunchCounts,
  tallyLaunchLines,
} from "../src/launch-report.ts";

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

test("the count keeps allowed launches per role and counts refusals apart", () => {
  const counts = tallyLaunchLines(
    [
      line({ event: "launch", outcome: "allowed", roles: ["small", "advisor"] }),
      line({ event: "launch", outcome: "allowed", roles: ["small"] }),
      line({ event: "launch", outcome: "refused", reason: "wrong-model", roles: [] }),
    ].join(""),
  );

  assert.deepEqual(counts, {
    byRole: { small: 2, advisor: 1 },
    allowed: 2,
    refused: 1,
    events: 3,
  });
});

test("a role that never launched stays absent instead of counting zero", () => {
  const counts = tallyLaunchLines(line({ event: "launch", outcome: "allowed", roles: ["small"] }));
  assert.equal(counts.byRole.medium, undefined);
  assert.equal(counts.byRole.uiDesign, undefined);
});

test("malformed lines, other events and partial writes are skipped, not fatal", () => {
  const counts = tallyLaunchLines(
    [
      "not json\n",
      line({ event: "policy", intensity: "aggressive" }),
      line({ event: "launch", outcome: "allowed", roles: ["large"] }),
      line({ event: "launch", outcome: "allowed", roles: [42, "unknown"] }),
      '{"event":"launch","outcome":"allo',
    ].join(""),
  );

  assert.deepEqual(counts, { byRole: { large: 1, unknown: 1 }, allowed: 2, refused: 0, events: 2 });
});

test("a role code outside the guard's closed set is neither counted nor rendered", () => {
  const counts = tallyLaunchLines(
    [
      line({ event: "launch", outcome: "allowed", roles: ["constructor", "__proto__", "small"] }),
      line({ event: "launch", outcome: "allowed", roles: ["anthropic/claude-opus-5-5"] }),
    ].join(""),
  );

  assert.deepEqual(counts.byRole, { small: 1 });
  assert.equal(
    launchSummaryText(counts, ["small"]),
    "launches=2 (Small 1)",
    "an unknown code counts as a child, never as a role",
  );
});

test("a truncated leading fragment is skipped, so a cap can undercount but never invent", () => {
  const counts = tallyLaunchLines(
    [
      'e":"allowed","roles":["large"]}\n',
      line({ event: "launch", outcome: "allowed", roles: ["small"] }),
    ].join(""),
  );

  assert.deepEqual(counts.byRole, { small: 1 });
  assert.equal(counts.allowed, 1);
});

test("the summary never repeats a role and never prints empty parentheses", () => {
  assert.equal(
    launchSummaryText({ byRole: { small: 1 }, allowed: 1, refused: 0, events: 1 }, [
      "small",
      "small",
    ]),
    "launches=1 (Small 1)",
  );
  assert.equal(
    launchSummaryText({ byRole: {}, allowed: 0, refused: 2, events: 2 }, []),
    "launches=0; refused=2",
  );
});

test("the summary shows a configured role at zero next to the roles that ran", () => {
  const text = launchSummaryText(
    { byRole: { small: 3, advisor: 1 }, allowed: 4, refused: 0, events: 4 },
    ["small", "medium", "large", "uiDesign", "advisor"],
  );

  assert.equal(text, "launches=4 (Small 3, Medium 0, Large 0, Visual Design 0, Advisor 1)");
});

test("roles the log records but the policy does not configure are appended", () => {
  const text = launchSummaryText(
    { byRole: { large: 1, unknown: 2 }, allowed: 3, refused: 1, events: 4 },
    ["large"],
  );

  assert.equal(text, "launches=3 (Large 1, unattributed 2); refused=1");
});

test("an empty log states the absence of evidence instead of reporting zeros", () => {
  assert.equal(
    launchSummaryText({ byRole: {}, allowed: 0, refused: 0, events: 0 }, ["small", "medium"]),
    "launches=none recorded",
  );
});

test("an oversized log is read from its tail, so the oldest records fall outside the window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-launch-cap-"));
  try {
    const configPath = join(directory, "delegation-policy.json");
    const logPath = getEventLogPath(configPath);
    const oldest = line({ event: "launch", outcome: "allowed", roles: ["medium"] });
    const newest = line({ event: "launch", outcome: "allowed", roles: ["small"] });
    // Pad past the cap with a record that carries no launch, so only the window can matter.
    const padding = line({ event: "policy", intensity: "off" }).repeat(
      Math.ceil(LAUNCH_REPORT_MAX_BYTES / 32),
    );
    await writeFile(logPath, `${oldest}${padding}${newest}`, "utf8");

    const counts = await readLaunchCounts(configPath);
    assert.equal(counts.byRole.small, 1, "the newest record is inside the window");
    assert.equal(counts.byRole.medium, undefined, "the oldest record fell outside the window");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("the report merges the rotated log with the current one and ignores a missing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegation-launch-report-"));
  try {
    const configPath = join(directory, "delegation-policy.json");
    const logPath = getEventLogPath(configPath);
    assert.equal(logPath, join(directory, "delegation-policy.events.jsonl"));

    const empty = await readLaunchCounts(configPath);
    assert.deepEqual(empty, { byRole: {}, allowed: 0, refused: 0, events: 0 });

    await writeFile(
      `${logPath}.1`,
      line({ event: "launch", outcome: "allowed", roles: ["medium"] }),
      "utf8",
    );
    await writeFile(
      logPath,
      line({ event: "launch", outcome: "allowed", roles: ["medium"] }),
      "utf8",
    );

    const counts = await readLaunchCounts(configPath);
    assert.deepEqual(counts, { byRole: { medium: 2 }, allowed: 2, refused: 0, events: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

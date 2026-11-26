/* global process, console */

/**
 * Summarise the `gate` records of the local event log, without printing any of their content.
 *
 * The log is the only source: this script reads it and writes nothing. It prints the counters the
 * shadow calibration reads — watched tasks by end reason, changes, holds, answers, failures, notes,
 * passes, and the refusals each `guard` rule produced — so the thresholds of a release can be set
 * from what happened rather than from what the plan guessed.
 *
 * Usage: node scripts/guard-report.mjs [path-to-jsonl]
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_NAME = "delegation-policy.events.jsonl";
const END_REASONS = ["settled", "branch-change", "shutdown"];
const SUM_FIELDS = ["changes", "totalChanges", "holds", "answers", "failures", "passes", "notes"];

function defaultLogPath() {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDirectory, LOG_NAME);
}

/** The current file and the one it rotated to: both hold records of the window under study. */
async function readRecords(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  const rotated = await readFile(`${path}.1`, "utf8").catch(() => "");
  const records = [];
  let skipped = 0;
  for (const line of `${rotated}\n${text}`.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line);
      if (record && record.event === "gate") records.push(record);
    } catch {
      // A rotated file can end mid-line, and a hand-edited one can hold anything: skip it.
      skipped += 1;
    }
  }
  return { records, skipped };
}

function integer(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function summarize(records) {
  const byEndReason = new Map(END_REASONS.map((reason) => [reason, 0]));
  const sums = new Map(SUM_FIELDS.map((field) => [field, 0]));
  const ruleHits = new Map();
  let withoutEndReason = 0;
  for (const record of records) {
    // A record of a version that predates the field is counted apart, never as a reason of its own.
    if (END_REASONS.includes(record.endReason))
      byEndReason.set(record.endReason, (byEndReason.get(record.endReason) ?? 0) + 1);
    else withoutEndReason += 1;
    for (const field of SUM_FIELDS) sums.set(field, sums.get(field) + integer(record[field]));
    const hits = record.ruleHits;
    if (!hits || typeof hits !== "object") continue;
    for (const [code, count] of Object.entries(hits)) {
      ruleHits.set(code, (ruleHits.get(code) ?? 0) + integer(count));
    }
  }
  return { byEndReason, sums, ruleHits, withoutEndReason };
}

function table(entries, label) {
  const width = Math.max(label.length, ...entries.map(([name]) => name.length));
  return entries.map(([name, value]) => `  ${name.padEnd(width)}  ${value}`);
}

const path = process.argv[2] ?? defaultLogPath();
const { records, skipped } = await readRecords(path);
if (records.length === 0) {
  console.log(`No gate records in ${path}.`);
  process.exit(0);
}

const { byEndReason, sums, ruleHits, withoutEndReason } = summarize(records);
const lines = [`Gate records: ${records.length} task(s) in ${path}`];
lines.push("", "Tasks by end reason:");
lines.push(...table([...byEndReason], "end reason"));
lines.push("", "Counters:");
lines.push(
  ...table(
    [...sums].map(([field, value]) => [field, value]),
    "counter",
  ),
);
if (withoutEndReason > 0) {
  lines.push("", `Without an end reason (older records): ${withoutEndReason}`);
}
if (ruleHits.size > 0) {
  lines.push("", "Refusals by guard rule:");
  lines.push(
    ...table(
      [...ruleHits].sort((left, right) => right[1] - left[1]),
      "rule",
    ),
  );
}
if (skipped > 0) lines.push("", `Skipped ${skipped} unreadable line(s).`);
console.log(lines.join("\n"));

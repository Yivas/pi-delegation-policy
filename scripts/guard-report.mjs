/* global process, console */

/**
 * Summarise the `gate` and `completion` records of the local event log, without printing any of
 * their content.
 *
 * The log is the only source: this script reads it and writes nothing. It prints the counters the
 * shadow calibration reads — watched tasks by end reason, changes, holds, answers, failures, notes,
 * passes, the refusals each `guard` rule produced, the reviewer counters of that level and the closed
 * status of every background completion — so the thresholds and the removal criteria of a release are
 * evaluated against what happened rather than against what the plan guessed. Two criteria need the
 * task and not its total, so the report also prints how many tasks carry a refused change or a review
 * that would have refused one, and, for each rule, how many of the tasks it fired in also saw a
 * reviewer block.
 *
 * Usage: node scripts/guard-report.mjs [path-to-jsonl]
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_NAME = "delegation-policy.events.jsonl";
const END_REASONS = ["settled", "branch-change", "shutdown"];
const COMPLETION_STATUSES = ["answered", "failed", "ignored", "unreadable", "notice-failed"];
/** The task's own accounting, read from every `gate` record. */
const SUM_FIELDS = ["changes", "totalChanges", "holds", "answers", "failures", "passes", "notes"];
/** What the optional `guard` reviewer did in that task, all of them integers in the same record. */
const REVIEW_FIELDS = [
  "reviewed",
  "wouldBlock",
  "noVerdict",
  "cacheHits",
  "blocked",
  "reviewPasses",
  "unreviewed",
  "unavailable",
  "escalations",
];

function defaultLogPath() {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDirectory, LOG_NAME);
}

/** The current file and the one it rotated to: both hold records of the window under study. */
async function readRecords(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  const rotated = await readFile(`${path}.1`, "utf8").catch(() => "");
  const gates = [];
  const completions = [];
  let skipped = 0;
  for (const line of `${rotated}\n${text}`.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line);
      if (record && record.event === "gate") gates.push(record);
      else if (record && record.event === "completion") completions.push(record);
    } catch {
      // A rotated file can end mid-line, and a hand-edited one can hold anything: skip it.
      skipped += 1;
    }
  }
  return { gates, completions, skipped };
}

function integer(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function summarize(gates) {
  const byEndReason = new Map(END_REASONS.map((reason) => [reason, 0]));
  const sums = new Map(SUM_FIELDS.map((field) => [field, 0]));
  const reviews = new Map(REVIEW_FIELDS.map((field) => [field, 0]));
  const ruleHits = new Map();
  let withoutEndReason = 0;
  for (const record of gates) {
    // A record of a version that predates the field is counted apart, never as a reason of its own.
    if (END_REASONS.includes(record.endReason))
      byEndReason.set(record.endReason, (byEndReason.get(record.endReason) ?? 0) + 1);
    else withoutEndReason += 1;
    for (const field of SUM_FIELDS) sums.set(field, sums.get(field) + integer(record[field]));
    // A task of `strict` never carries these fields, and a zero is what it did: nothing is skipped.
    for (const field of REVIEW_FIELDS)
      reviews.set(field, reviews.get(field) + integer(record[field]));
    const hits = record.ruleHits;
    if (!hits || typeof hits !== "object") continue;
    for (const [code, count] of Object.entries(hits)) {
      ruleHits.set(code, (ruleHits.get(code) ?? 0) + integer(count));
    }
  }
  return { byEndReason, sums, reviews, ruleHits, withoutEndReason };
}

/** What a total cannot answer: how many tasks each of those counts came from. */
function perTask(gates) {
  const counts = { blocked: 0, wouldBlock: 0, reviewed: 0 };
  let mostChanges = 0;
  for (const record of gates) {
    if (integer(record.blocked) > 0) counts.blocked += 1;
    if (integer(record.wouldBlock) > 0) counts.wouldBlock += 1;
    if (integer(record.reviewed) > 0) counts.reviewed += 1;
    mostChanges = Math.max(mostChanges, integer(record.changes));
  }
  return { counts, mostChanges };
}

/**
 * Per rule, the tasks it fired in and how many of those also saw the reviewer refuse or want to
 * refuse a change: the pair the retirement of a soft rule is decided on. Codes and counts only.
 */
function ruleOverlap(gates) {
  const overlap = new Map();
  for (const record of gates) {
    const hits = record.ruleHits;
    if (!hits || typeof hits !== "object") continue;
    const reviewerBlocked = integer(record.wouldBlock) + integer(record.blocked) > 0;
    for (const [code, count] of Object.entries(hits)) {
      if (integer(count) === 0) continue;
      const entry = overlap.get(code) ?? { tasks: 0, withReviewerBlock: 0 };
      entry.tasks += 1;
      if (reviewerBlocked) entry.withReviewerBlock += 1;
      overlap.set(code, entry);
    }
  }
  return overlap;
}

/** One line per report the task read, by the closed status it left: whether it mattered or not. */
function completionStatuses(completions) {
  const byStatus = new Map(COMPLETION_STATUSES.map((status) => [status, 0]));
  let withoutStatus = 0;
  for (const record of completions) {
    if (COMPLETION_STATUSES.includes(record.status))
      byStatus.set(record.status, byStatus.get(record.status) + 1);
    else withoutStatus += 1;
  }
  return { byStatus, withoutStatus };
}

function table(entries, label) {
  const width = Math.max(label.length, ...entries.map(([name]) => name.length));
  return entries.map(([name, value]) => `  ${name.padEnd(width)}  ${value}`);
}

const path = process.argv[2] ?? defaultLogPath();
const { gates, completions, skipped } = await readRecords(path);
if (gates.length === 0 && completions.length === 0) {
  console.log(`No gate or completion records in ${path}.`);
  process.exit(0);
}

const { byEndReason, sums, reviews, ruleHits, withoutEndReason } = summarize(gates);
const { counts, mostChanges } = perTask(gates);
const overlap = ruleOverlap(gates);
const { byStatus, withoutStatus } = completionStatuses(completions);
const lines = [
  `Gate records: ${gates.length} task(s) in ${path}`,
  `Background completions: ${completions.length} report(s)`,
];
lines.push("", "Tasks by end reason:");
lines.push(...table([...byEndReason], "end reason"));
lines.push("", "Counters:");
lines.push(
  ...table(
    [...sums].map(([field, value]) => [field, value]),
    "counter",
  ),
);
lines.push("", "Reviewer counters:");
lines.push(
  ...table(
    [...reviews].map(([field, value]) => [field, value]),
    "counter",
  ),
);
lines.push("", "Background completions by status:");
lines.push(...table([...byStatus], "status"));
lines.push("", "Tasks, where a total is not enough:");
lines.push(
  ...table(
    [
      ["tasks", gates.length],
      ["with a refused change", counts.blocked],
      ["with a review that would refuse", counts.wouldBlock],
      ["with a review", counts.reviewed],
      ["changes in the busiest task", mostChanges],
    ],
    "tasks",
  ),
);
if (overlap.size > 0) {
  lines.push(
    "",
    "Rules by reviewer overlap (tasks the rule fired in, of those with a reviewer block):",
  );
  for (const [code, entry] of [...overlap].sort((left, right) => right[1].tasks - left[1].tasks))
    lines.push(`  ${code.padEnd(20)}  ${entry.tasks} / ${entry.withReviewerBlock}`);
}
if (withoutEndReason > 0) {
  lines.push("", `Without an end reason (older records): ${withoutEndReason}`);
}
if (withoutStatus > 0) lines.push("", `Without a closed status: ${withoutStatus}`);
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

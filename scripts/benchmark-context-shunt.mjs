/* global process */

import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { pathToFileURL, URL } from "node:url";

const EXPECTED_CASE_COUNT = 12;
const FIXTURE_SCHEMA_VERSION = 1;
const CASE_IDS = [
  "c01-small-file",
  "c02-short-205-lines",
  "c03-large-full-read",
  "c04-targeted-read",
  "c05-repeated-query",
  "c06-unicode",
  "c07-crlf",
  "c08-long-line",
  "c09-pre-truncated-result",
  "c10-multi-fragment-search",
  "c11-json-uncovered",
  "c12-failure-or-quota",
];
const SEMANTIC_CASE_IDS = new Set(CASE_IDS.slice(0, 10));
const CASE_CLASSES = new Map([
  ["c01-small-file", "small-file"],
  ["c02-short-205-lines", "short-205-lines"],
  ["c03-large-full-read", "large-full-read"],
  ["c04-targeted-read", "targeted-read"],
  ["c05-repeated-query", "repeated-query"],
  ["c06-unicode", "unicode"],
  ["c07-crlf", "crlf"],
  ["c08-long-line", "long-line"],
  ["c09-pre-truncated-result", "pre-truncated-result"],
  ["c10-multi-fragment-search", "multi-fragment-search"],
  ["c11-json-uncovered", "json-uncovered"],
  ["c12-failure-or-quota", "failure-or-quota"],
]);
const REAL_EXECUTION_FLAGS = new Set([
  "--run",
  "--execute",
  "--real",
  "--report",
  "--output",
  "--provider",
  "--model",
  "--runs",
  "--arm",
  "--baseline",
]);
const CASE_KEYS = {
  "c01-small-file": ["id", "class", "mode", "source", "question", "expectedId"],
  "c02-short-205-lines": ["id", "class", "mode", "source", "question", "expectedId"],
  "c03-large-full-read": ["id", "class", "mode", "source", "question", "expectedId"],
  "c04-targeted-read": ["id", "class", "mode", "readRequest", "source", "question", "expectedId"],
  "c05-repeated-query": ["id", "class", "mode", "source", "question", "repetitions", "expectedId"],
  "c06-unicode": ["id", "class", "mode", "source", "question", "expectedId"],
  "c07-crlf": ["id", "class", "mode", "source", "materialization", "question", "expectedId"],
  "c08-long-line": ["id", "class", "mode", "source", "question", "expectedId"],
  "c09-pre-truncated-result": [
    "id",
    "class",
    "mode",
    "source",
    "hostResult",
    "question",
    "expectedId",
  ],
  "c10-multi-fragment-search": ["id", "class", "mode", "source", "question", "expectedId"],
  "c11-json-uncovered": ["id", "class", "mode", "input", "expectedId"],
  "c12-failure-or-quota": ["id", "class", "mode", "input", "expectedId"],
};
const EXPECTED_KEYS = {
  "c01-small-file": ["id", "status", "languageScored", "requiredFacts"],
  "c02-short-205-lines": ["id", "status", "languageScored", "requiredFacts"],
  "c03-large-full-read": ["id", "status", "languageScored", "requiredFacts"],
  "c04-targeted-read": ["id", "status", "languageScored", "requiredFacts"],
  "c05-repeated-query": ["id", "status", "languageScored", "requiredFacts", "repeatExpectation"],
  "c06-unicode": ["id", "status", "languageScored", "requiredFacts"],
  "c07-crlf": ["id", "status", "languageScored", "requiredFacts"],
  "c08-long-line": ["id", "status", "languageScored", "requiredFacts", "sourceRequirements"],
  "c09-pre-truncated-result": [
    "id",
    "status",
    "languageScored",
    "requiredFacts",
    "mustNotAssert",
    "contract",
  ],
  "c10-multi-fragment-search": ["id", "status", "languageScored", "requiredFacts"],
  "c11-json-uncovered": ["id", "status", "languageScored", "contract"],
  "c12-failure-or-quota": ["id", "status", "languageScored", "contract"],
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(path, message) {
  throw new Error(`Invalid benchmark fixture ${path}: ${message}`);
}

function exactKeys(value, keys, path) {
  if (!isRecord(value)) fail(path, "expected an object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(path, `keys must be exactly ${keys.join(", ")}`);
  }
}

function stringValue(value, path, { nonEmpty = true } = {}) {
  if (typeof value !== "string" || (nonEmpty && value.length === 0))
    fail(path, "expected a string");
  return value;
}

function integerValue(value, path, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum)
    fail(path, "expected a safe integer in range");
  return value;
}

function lineRange(value, path, lineCount) {
  if (!Array.isArray(value) || value.length !== 2) fail(path, "expected [start, end]");
  const start = integerValue(value[0], `${path}[0]`, { minimum: 1 });
  const end = integerValue(value[1], `${path}[1]`, { minimum: start });
  if (end > lineCount) fail(path, `must stay within the ${lineCount}-line corpus`);
  return [start, end];
}

function sourceRanges(source, path, lineCount) {
  if (!isRecord(source)) fail(path, "expected an object");
  const keys = Object.keys(source);
  if (keys.length === 1 && keys[0] === "lineRange")
    return [lineRange(source.lineRange, `${path}.lineRange`, lineCount)];
  if (keys.length === 1 && keys[0] === "lineRanges") {
    if (!Array.isArray(source.lineRanges) || source.lineRanges.length === 0)
      fail(path, "lineRanges must not be empty");
    return source.lineRanges.map((range, index) =>
      lineRange(range, `${path}.lineRanges[${index}]`, lineCount),
    );
  }
  fail(path, "must contain exactly one lineRange or lineRanges field");
}

function splitLines(text, path) {
  stringValue(text, path, { nonEmpty: false });
  if (text.includes("\r\n") || text.includes("\r")) fail(path, "must use LF physical line endings");
  if (!text.endsWith("\n")) fail(path, "must end with one LF terminator");
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.includes("\n"))) fail(path, "contains an invalid line split");
  return lines;
}

function validateCases(cases, lineCount) {
  if (!Array.isArray(cases) || cases.length !== EXPECTED_CASE_COUNT)
    fail("cases", "must contain exactly 12 cases");
  const ids = new Set();
  for (const [index, benchmarkCase] of cases.entries()) {
    const path = `cases[${index}]`;
    if (!isRecord(benchmarkCase)) fail(path, "expected an object");
    const id = stringValue(benchmarkCase.id, `${path}.id`);
    if (!CASE_IDS.includes(id)) fail(`${path}.id`, "is not a recognized case id");
    if (ids.has(id)) fail(`${path}.id`, "is duplicated");
    ids.add(id);
    exactKeys(benchmarkCase, CASE_KEYS[id], path);
    if (benchmarkCase.mode !== (SEMANTIC_CASE_IDS.has(id) ? "semantic" : "contract-only")) {
      fail(`${path}.mode`, "does not match the frozen case mode");
    }
    if (benchmarkCase.expectedId !== id) fail(`${path}.expectedId`, "must equal id");
    stringValue(benchmarkCase.class, `${path}.class`);
    if (benchmarkCase.class !== CASE_CLASSES.get(id))
      fail(`${path}.class`, "does not match the frozen case class");
    if (SEMANTIC_CASE_IDS.has(id)) {
      stringValue(benchmarkCase.question, `${path}.question`);
      const ranges = sourceRanges(benchmarkCase.source, `${path}.source`, lineCount);
      if (id === "c04-targeted-read") {
        exactKeys(benchmarkCase.readRequest, ["offset", "limit"], `${path}.readRequest`);
        integerValue(benchmarkCase.readRequest.offset, `${path}.readRequest.offset`, {
          minimum: 1,
        });
        integerValue(benchmarkCase.readRequest.limit, `${path}.readRequest.limit`, { minimum: 1 });
      }
      if (id === "c05-repeated-query" && benchmarkCase.repetitions !== 2)
        fail(`${path}.repetitions`, "must be 2");
      if (id === "c07-crlf") {
        exactKeys(
          benchmarkCase.materialization,
          ["fromCorpus", "lineEnding", "terminalLineEnding"],
          `${path}.materialization`,
        );
        if (benchmarkCase.materialization.lineEnding !== "CRLF")
          fail(`${path}.materialization.lineEnding`, "must be CRLF");
        if (benchmarkCase.materialization.terminalLineEnding !== false)
          fail(`${path}.materialization.terminalLineEnding`, "must be false");
        const materializedRanges = sourceRanges(
          benchmarkCase.materialization.fromCorpus,
          `${path}.materialization.fromCorpus`,
          lineCount,
        );
        if (JSON.stringify(materializedRanges) !== JSON.stringify(ranges))
          fail(`${path}.materialization.fromCorpus`, "must equal source");
      }
      if (id === "c09-pre-truncated-result") {
        exactKeys(
          benchmarkCase.hostResult,
          ["returnedLineRange", "truncated"],
          `${path}.hostResult`,
        );
        if (benchmarkCase.hostResult.truncated !== true)
          fail(`${path}.hostResult.truncated`, "must be true");
        const returned = lineRange(
          benchmarkCase.hostResult.returnedLineRange,
          `${path}.hostResult.returnedLineRange`,
          lineCount,
        );
        if (returned[0] < ranges[0][0] || returned[1] > ranges[0][1])
          fail(`${path}.hostResult.returnedLineRange`, "must stay within source");
      }
    } else {
      exactKeys(
        benchmarkCase.input,
        [id === "c11-json-uncovered" ? "toolResult" : "conditions"],
        `${path}.input`,
      );
      if (id === "c11-json-uncovered")
        stringValue(benchmarkCase.input.toolResult, `${path}.input.toolResult`);
      else {
        if (
          !Array.isArray(benchmarkCase.input.conditions) ||
          benchmarkCase.input.conditions.length !== 2
        )
          fail(`${path}.input.conditions`, "must contain two conditions");
        for (const condition of benchmarkCase.input.conditions)
          stringValue(condition, `${path}.input.conditions`);
      }
    }
  }
  if (JSON.stringify([...ids]) !== JSON.stringify(CASE_IDS))
    fail("cases", "must use the frozen case order");
}

function validateExpected(expected, cases, lineCount) {
  exactKeys(expected, ["schemaVersion", "citationConvention", "rubric", "cases"], "expected");
  if (expected.schemaVersion !== FIXTURE_SCHEMA_VERSION)
    fail("expected.schemaVersion", "is unsupported");
  exactKeys(expected.citationConvention, ["lineNumbers", "ranges"], "expected.citationConvention");
  if (
    expected.citationConvention.lineNumbers !== "1-indexed" ||
    expected.citationConvention.ranges !== "inclusive"
  )
    fail("expected.citationConvention", "must use 1-indexed inclusive ranges");
  exactKeys(
    expected.rubric,
    ["frozen", "scale", "dimensions", "semanticCasePass", "contractOnlyCasePass"],
    "expected.rubric",
  );
  if (expected.rubric.frozen !== true || expected.rubric.scale !== "binary")
    fail("expected.rubric", "must be frozen binary scoring");
  exactKeys(
    expected.rubric.dimensions,
    ["factuality", "completeness", "citationSupport", "contract"],
    "expected.rubric.dimensions",
  );
  for (const dimension of Object.values(expected.rubric.dimensions)) {
    exactKeys(dimension, ["passWhen", "failWhen"], "expected.rubric.dimensions");
    stringValue(dimension.passWhen, "expected.rubric.dimensions.passWhen");
    stringValue(dimension.failWhen, "expected.rubric.dimensions.failWhen");
  }
  stringValue(expected.rubric.semanticCasePass, "expected.rubric.semanticCasePass");
  stringValue(expected.rubric.contractOnlyCasePass, "expected.rubric.contractOnlyCasePass");
  if (!Array.isArray(expected.cases) || expected.cases.length !== EXPECTED_CASE_COUNT)
    fail("expected.cases", "must contain exactly 12 cases");
  const caseById = new Map(cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]));
  const ids = new Set();
  for (const [index, result] of expected.cases.entries()) {
    const path = `expected.cases[${index}]`;
    if (!isRecord(result)) fail(path, "expected an object");
    const id = stringValue(result.id, `${path}.id`);
    if (!CASE_IDS.includes(id) || ids.has(id))
      fail(`${path}.id`, "must be a unique frozen case id");
    ids.add(id);
    exactKeys(result, EXPECTED_KEYS[id], path);
    const semantic = SEMANTIC_CASE_IDS.has(id);
    const expectedStatus = semantic
      ? id === "c09-pre-truncated-result"
        ? "insufficient-evidence"
        : "answered"
      : id === "c11-json-uncovered"
        ? "preserve-unchanged"
        : "contract-handled";
    if (result.status !== expectedStatus)
      fail(`${path}.status`, "does not match the frozen case status");
    if (result.languageScored !== semantic)
      fail(`${path}.languageScored`, "does not match case mode");
    if (!isRecord(caseById.get(id))) fail(`${path}.id`, "has no matching case fixture");
    if (semantic) {
      if (!Array.isArray(result.requiredFacts) || result.requiredFacts.length === 0)
        fail(`${path}.requiredFacts`, "must not be empty");
      const ranges = caseById.get(id).hostResult?.returnedLineRange
        ? [caseById.get(id).hostResult.returnedLineRange]
        : sourceRanges(caseById.get(id).source, `${path}.source`, lineCount);
      for (const [factIndex, fact] of result.requiredFacts.entries()) {
        exactKeys(fact, ["text", "citations"], `${path}.requiredFacts[${factIndex}]`);
        stringValue(fact.text, `${path}.requiredFacts[${factIndex}].text`);
        if (!Array.isArray(fact.citations) || fact.citations.length === 0)
          fail(`${path}.requiredFacts[${factIndex}].citations`, "must not be empty");
        for (const [citationIndex, citation] of fact.citations.entries()) {
          const cited = lineRange(
            citation,
            `${path}.requiredFacts[${factIndex}].citations[${citationIndex}]`,
            lineCount,
          );
          if (!ranges.some(([start, end]) => cited[0] >= start && cited[1] <= end))
            fail(
              `${path}.requiredFacts[${factIndex}].citations[${citationIndex}]`,
              "falls outside the supplied result range",
            );
        }
      }
      if (id === "c05-repeated-query")
        stringValue(result.repeatExpectation, `${path}.repeatExpectation`);
      if (id === "c08-long-line") {
        exactKeys(
          result.sourceRequirements,
          ["minimumUtf8BytesForLine"],
          `${path}.sourceRequirements`,
        );
        exactKeys(
          result.sourceRequirements.minimumUtf8BytesForLine,
          ["line", "bytes"],
          `${path}.sourceRequirements.minimumUtf8BytesForLine`,
        );
        integerValue(
          result.sourceRequirements.minimumUtf8BytesForLine.line,
          `${path}.sourceRequirements.minimumUtf8BytesForLine.line`,
          { minimum: 1 },
        );
        integerValue(
          result.sourceRequirements.minimumUtf8BytesForLine.bytes,
          `${path}.sourceRequirements.minimumUtf8BytesForLine.bytes`,
          { minimum: 1 },
        );
      }
      if (id === "c09-pre-truncated-result") {
        if (!Array.isArray(result.mustNotAssert) || result.mustNotAssert.length === 0)
          fail(`${path}.mustNotAssert`, "must not be empty");
        for (const statement of result.mustNotAssert)
          stringValue(statement, `${path}.mustNotAssert`);
        exactKeys(result.contract, ["handling"], `${path}.contract`);
        stringValue(result.contract.handling, `${path}.contract.handling`);
      }
    } else {
      exactKeys(
        result.contract,
        id === "c11-json-uncovered"
          ? ["handling", "citations", "providerCall"]
          : ["reader-unavailable", "artifact-quota-exhausted", "citations"],
        `${path}.contract`,
      );
      for (const value of Object.values(result.contract)) stringValue(value, `${path}.contract`);
    }
  }
  if (JSON.stringify([...ids]) !== JSON.stringify(CASE_IDS))
    fail("expected.cases", "must use the frozen case order");
}

export function validateFixtures(fixtures) {
  exactKeys(
    fixtures,
    ["schemaVersion", "citationConvention", "lineSplitting", "corpus", "cases", "expected"],
    "root",
  );
  if (fixtures.schemaVersion !== FIXTURE_SCHEMA_VERSION) fail("schemaVersion", "is unsupported");
  exactKeys(fixtures.citationConvention, ["lineNumbers", "ranges"], "citationConvention");
  if (
    fixtures.citationConvention.lineNumbers !== "1-indexed" ||
    fixtures.citationConvention.ranges !== "inclusive"
  )
    fail("citationConvention", "must use 1-indexed inclusive ranges");
  exactKeys(
    fixtures.lineSplitting,
    ["recognizedTerminators", "terminalTerminatorAddsLine"],
    "lineSplitting",
  );
  if (
    JSON.stringify(fixtures.lineSplitting.recognizedTerminators) !==
      JSON.stringify(["LF", "CRLF", "CR"]) ||
    fixtures.lineSplitting.terminalTerminatorAddsLine !== false
  )
    fail("lineSplitting", "does not match the frozen line convention");
  exactKeys(
    fixtures.corpus,
    ["path", "expectedSplitLineCount", "encoding", "physicalLineEnding", "text"],
    "corpus",
  );
  if (fixtures.corpus.path !== "corpus.txt") fail("corpus.path", "must name the fixture corpus");
  if (fixtures.corpus.encoding !== "utf-8" || fixtures.corpus.physicalLineEnding !== "LF")
    fail("corpus", "has unsupported encoding or physical line ending");
  const corpusLines = splitLines(fixtures.corpus.text, "corpus.text");
  if (fixtures.corpus.expectedSplitLineCount !== corpusLines.length)
    fail("corpus.expectedSplitLineCount", "does not match the corpus");
  if (fixtures.corpus.expectedSplitLineCount !== 620)
    fail("corpus.expectedSplitLineCount", "must be exactly 620");
  validateCases(fixtures.cases, corpusLines.length);
  validateExpected(fixtures.expected, fixtures.cases, corpusLines.length);
  return { caseCount: fixtures.cases.length, corpusLineCount: corpusLines.length };
}

function materializeRange(lines, ranges, lineEnding, terminalLineEnding) {
  const fragments = ranges.map(([start, end]) => lines.slice(start - 1, end).join(lineEnding));
  const text = fragments.join(lineEnding) + (terminalLineEnding ? lineEnding : "");
  return {
    text,
    lineCount: ranges.reduce((count, [start, end]) => count + end - start + 1, 0),
    fragmentCount: ranges.length,
  };
}

export function materializeCases(fixtures) {
  validateFixtures(fixtures);
  const lines = splitLines(fixtures.corpus.text, "corpus.text");
  const expectedById = new Map(fixtures.expected.cases.map((result) => [result.id, result]));
  return {
    corpus: { lineCount: lines.length, encoding: "utf-8", physicalLineEnding: "LF" },
    cases: fixtures.cases.map((benchmarkCase) => {
      if (!SEMANTIC_CASE_IDS.has(benchmarkCase.id)) {
        return {
          id: benchmarkCase.id,
          class: benchmarkCase.class,
          mode: benchmarkCase.mode,
          repetitions: 1,
          question: undefined,
          readRequest: undefined,
          materialization: undefined,
          input: benchmarkCase.input,
          expected: expectedById.get(benchmarkCase.id),
        };
      }
      const source = sourceRanges(
        benchmarkCase.source,
        `cases.${benchmarkCase.id}.source`,
        lines.length,
      );
      const returned = benchmarkCase.hostResult?.returnedLineRange
        ? [benchmarkCase.hostResult.returnedLineRange]
        : source;
      const lineEnding = benchmarkCase.materialization?.lineEnding ?? "LF";
      const terminalLineEnding = benchmarkCase.materialization?.terminalLineEnding ?? false;
      const materialized = materializeRange(
        lines,
        returned,
        lineEnding === "CRLF" ? "\r\n" : "\n",
        terminalLineEnding,
      );
      return {
        id: benchmarkCase.id,
        class: benchmarkCase.class,
        mode: benchmarkCase.mode,
        repetitions: benchmarkCase.repetitions ?? 1,
        question: benchmarkCase.question,
        readRequest: benchmarkCase.readRequest,
        sourceLineRanges: source,
        materialization: {
          ...materialized,
          lineEnding,
          terminalLineEnding,
          sourceLineRanges: returned,
          truncated: benchmarkCase.hostResult?.truncated === true,
          utf8Bytes: Buffer.byteLength(materialized.text, "utf8"),
        },
        expected: expectedById.get(benchmarkCase.id),
      };
    }),
  };
}

export function createDryRunSummary(materialized) {
  if (
    !isRecord(materialized) ||
    !isRecord(materialized.corpus) ||
    !Array.isArray(materialized.cases)
  ) {
    throw new Error("Invalid materialized benchmark: expected corpus and cases");
  }
  if (materialized.cases.length !== EXPECTED_CASE_COUNT)
    throw new Error("Invalid materialized benchmark: expected exactly 12 cases");
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    status: "dry-run",
    offline: true,
    providerCalls: 0,
    caseCount: materialized.cases.length,
    corpus: {
      lineCount: materialized.corpus.lineCount,
      encoding: materialized.corpus.encoding,
      physicalLineEnding: materialized.corpus.physicalLineEnding,
    },
    cases: materialized.cases.map((benchmarkCase) => ({
      id: benchmarkCase.id,
      class: benchmarkCase.class,
      mode: benchmarkCase.mode,
      repetitions: benchmarkCase.repetitions,
      contractOnly: benchmarkCase.mode === "contract-only",
      sourceLineCount: benchmarkCase.materialization?.lineCount ?? 0,
      sourceFragmentCount: benchmarkCase.materialization?.fragmentCount ?? 0,
      materialization: benchmarkCase.materialization
        ? {
            lineEnding: benchmarkCase.materialization.lineEnding,
            terminalLineEnding: benchmarkCase.materialization.terminalLineEnding,
            truncated: benchmarkCase.materialization.truncated,
            lineCount: benchmarkCase.materialization.lineCount,
            utf8Bytes: benchmarkCase.materialization.utf8Bytes,
          }
        : null,
    })),
  };
}

export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) throw new Error("CLI arguments must be an array");
  let dryRun = false;
  for (const argument of argv) {
    if (argument === "--dry-run") {
      if (dryRun) throw new Error("--dry-run may be specified only once");
      dryRun = true;
      continue;
    }
    if (REAL_EXECUTION_FLAGS.has(argument))
      throw new Error("real execution and report output are unavailable until C04 is frozen");
    throw new Error("unsupported benchmark option; only --dry-run is available");
  }
  return { dryRun: true };
}

const UNKNOWN = "unknown";
const RUN_KEYS = new Set([
  "id",
  "usage",
  "cost",
  "durationMs",
  "status",
  "retries",
  "recoveries",
  "contractViolations",
  "unnecessaryOperationalBlocks",
  "exceptions",
  "children",
  "subruns",
]);
const USAGE_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite"]);
const RUN_STATUSES = new Set(["completed", "failed", "error", "timed_out", "cancelled"]);
const COUNTER_KEYS = [
  "retries",
  "recoveries",
  "contractViolations",
  "unnecessaryOperationalBlocks",
  "exceptions",
];

function benchmarkFail(path, message) {
  throw new Error(`Invalid benchmark run ${path}: ${message}`);
}

function hasOnlyKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) benchmarkFail(path, `contains unsupported field ${key}`);
  }
}

function metric(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    benchmarkFail(path, "must be a finite non-negative number");
  return value;
}

function counter(value, path) {
  if (!Number.isSafeInteger(value) || value < 0)
    benchmarkFail(path, "must be a non-negative safe integer");
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeRun(value, path, ancestors = new Set()) {
  if (!isRecord(value)) benchmarkFail(path, "must be an object");
  if (ancestors.has(value)) benchmarkFail(path, "must not contain a cycle");
  ancestors.add(value);
  try {
    hasOnlyKeys(value, RUN_KEYS, path);
    const id = stringValue(value.id, `${path}.id`);
    const usage = {};
    if (value.usage !== undefined) {
      if (!isRecord(value.usage)) benchmarkFail(`${path}.usage`, "must be an object");
      hasOnlyKeys(value.usage, USAGE_KEYS, `${path}.usage`);
      for (const key of USAGE_KEYS) {
        if (value.usage[key] !== undefined)
          usage[key] = metric(value.usage[key], `${path}.usage.${key}`);
      }
    }
    if (value.cost !== undefined) metric(value.cost, `${path}.cost`);
    if (value.durationMs !== undefined) metric(value.durationMs, `${path}.durationMs`);
    if (value.status !== undefined && !RUN_STATUSES.has(value.status))
      benchmarkFail(`${path}.status`, "is not recognized");
    for (const key of COUNTER_KEYS) {
      if (value[key] !== undefined) counter(value[key], `${path}.${key}`);
    }
    const children = [];
    for (const key of ["children", "subruns"]) {
      if (value[key] === undefined) continue;
      if (!Array.isArray(value[key])) benchmarkFail(`${path}.${key}`, "must be an array");
      for (const [index, child] of value[key].entries())
        children.push(normalizeRun(child, `${path}.${key}[${index}]`, ancestors));
    }
    return {
      id,
      usage,
      ...(value.cost === undefined ? {} : { cost: value.cost }),
      ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
      status: value.status ?? "completed",
      retries: value.retries ?? 0,
      recoveries: value.recoveries ?? 0,
      contractViolations: value.contractViolations ?? 0,
      unnecessaryOperationalBlocks: value.unnecessaryOperationalBlocks ?? 0,
      exceptions: value.exceptions ?? 0,
      children,
    };
  } finally {
    ancestors.delete(value);
  }
}

function collectRuns(run, uniqueRuns) {
  const representation = canonicalize(run);
  const previous = uniqueRuns.get(run.id);
  if (previous !== undefined) {
    if (previous !== representation)
      benchmarkFail(`id ${run.id}`, "is ambiguous because duplicate records differ");
    return;
  }
  uniqueRuns.set(run.id, representation);
  for (const child of run.children) collectRuns(child, uniqueRuns);
}

function sum(values, path) {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(result)) benchmarkFail(`aggregate.${path}`, "sum must be finite");
  return result;
}

function total(values, path) {
  return values.some((value) => value === undefined) ? UNKNOWN : sum(values, path);
}

function summarizeRuns(uniqueRuns) {
  const runs = [...uniqueRuns.values()].map((representation) => JSON.parse(representation));
  return {
    runCount: runs.length,
    usage: Object.fromEntries(
      [...USAGE_KEYS].map((key) => [
        key,
        total(
          runs.map((run) => run.usage[key]),
          key,
        ),
      ]),
    ),
    cost: total(
      runs.map((run) => run.cost),
      "cost",
    ),
    durationMs: total(
      runs.map((run) => run.durationMs),
      "durationMs",
    ),
    failures: runs.filter((run) => run.status === "failed" || run.status === "error").length,
    timeouts: runs.filter((run) => run.status === "timed_out").length,
    cancellations: runs.filter((run) => run.status === "cancelled").length,
    retries: sum(
      runs.map((run) => run.retries),
      "retries",
    ),
    recoveries: sum(
      runs.map((run) => run.recoveries),
      "recoveries",
    ),
    contractViolations: sum(
      runs.map((run) => run.contractViolations),
      "contractViolations",
    ),
    unnecessaryOperationalBlocks: sum(
      runs.map((run) => run.unnecessaryOperationalBlocks),
      "unnecessaryOperationalBlocks",
    ),
    exceptions: sum(
      runs.map((run) => run.exceptions),
      "exceptions",
    ),
  };
}

export function aggregateBenchmarkRun(run) {
  const normalized = normalizeRun(run, "run");
  const uniqueRuns = new Map();
  collectRuns(normalized, uniqueRuns);
  return summarizeRuns(uniqueRuns);
}

export function aggregateBenchmarkMatrix(runs) {
  if (!Array.isArray(runs)) throw new Error("Invalid benchmark matrix: runs must be an array");
  const uniqueRuns = new Map();
  for (const [index, run] of runs.entries())
    collectRuns(normalizeRun(run, `runs[${index}]`), uniqueRuns);
  return summarizeRuns(uniqueRuns);
}

async function loadFixtures() {
  const fixtureRoot = new URL("../test/fixtures/context-shunt-benchmark/", import.meta.url);
  let cases;
  let corpus;
  let expected;
  try {
    [cases, corpus, expected] = await Promise.all([
      readFile(new URL("cases.json", fixtureRoot), "utf8"),
      readFile(new URL("corpus.txt", fixtureRoot), "utf8"),
      readFile(new URL("expected.json", fixtureRoot), "utf8"),
    ]);
  } catch {
    throw new Error("benchmark fixtures are unavailable");
  }
  try {
    const casesFixture = JSON.parse(cases);
    return {
      ...casesFixture,
      corpus: { ...casesFixture.corpus, text: corpus },
      expected: JSON.parse(expected),
    };
  } catch {
    throw new Error("benchmark fixtures are not valid JSON");
  }
}

async function runCli() {
  try {
    parseCliArgs(process.argv.slice(2));
    const fixtures = await loadFixtures();
    const materialized = materializeCases(fixtures);
    process.stdout.write(`${JSON.stringify(createDryRunSummary(materialized), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `benchmark-context-shunt: ${error instanceof Error ? error.message : "validation failed"}\n`,
    );
    process.exitCode = 2;
  }
}

const invokedAsScript =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) await runCli();

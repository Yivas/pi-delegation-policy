import { ArtifactStore, type SourceSnapshot } from "./context-shunt.ts";
import { THINKING_LEVEL_NAMES, type ThinkingLevelName } from "./types.ts";

const MAX_QUESTION_BYTES = 2048;
const MIN_ANSWER_BYTES = 1024;
const MAX_ANSWER_BYTES = 16 * 1024;

export const READER_THINKING_LEVELS = THINKING_LEVEL_NAMES;
export type ReaderThinking = ThinkingLevelName;

export type ReaderQuestion = {
  artifactId: string;
  question: string;
  thinking: ReaderThinking;
};

export type ReaderCitation = {
  sourceId: string;
  startLine: number;
  endLine: number;
};

export type ReaderAnswer = {
  status: "answered" | "insufficient-evidence";
  answer: string;
  citations: ReaderCitation[];
};

export const READER_ERROR_CODES = [
  "invalid-request",
  "evidence-expired",
  "invalid-answer",
  "output-unavailable",
  "reader-unavailable",
  "reader-busy",
  "reader-cancelled",
  "reader-timed-out",
  "reader-failed",
] as const;
export type ReaderErrorCode = (typeof READER_ERROR_CODES)[number];

export type ReaderValidation<T> = { ok: true; value: T } | { ok: false; code: ReaderErrorCode };

export type PreparedReaderRequest = {
  question: ReaderQuestion;
  snapshot: SourceSnapshot;
};

export type ReaderToolResult = {
  content: [{ type: "text"; text: string }];
  details: Record<string, never>;
};

type ReaderPayload =
  | ReaderAnswer
  | { status: "stored"; answerArtifactId: string; sourceId: string }
  | { status: "error"; code: ReaderErrorCode };

function readDataRecord(value: unknown, keys: readonly string[]): unknown[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const names = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    names.length !== keys.length ||
    !keys.every((key) => names.includes(key))
  ) {
    return undefined;
  }

  const values: unknown[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    values.push(descriptor.value);
  }
  return values;
}

function readDenseDataArray(value: unknown, maxLength: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;

  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) return undefined;

  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length + 1 || !names.includes("length")) return undefined;

  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    values.push(descriptor.value);
  }
  return values;
}

function isReaderThinking(value: unknown): value is ReaderThinking {
  return typeof value === "string" && (READER_THINKING_LEVELS as readonly string[]).includes(value);
}

function isSafeLine(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function parseReaderQuestion(
  value: unknown,
  supportedThinking: ReadonlySet<ReaderThinking>,
): ReaderValidation<ReaderQuestion> {
  try {
    const fields = readDataRecord(value, ["artifactId", "question", "thinking"]);
    if (!fields) return { ok: false, code: "invalid-request" };
    const [artifactId, question, thinking] = fields;
    if (
      typeof artifactId !== "string" ||
      artifactId.length === 0 ||
      typeof question !== "string" ||
      question.length === 0 ||
      Buffer.byteLength(question, "utf8") > MAX_QUESTION_BYTES ||
      !isReaderThinking(thinking) ||
      !supportedThinking.has(thinking)
    ) {
      return { ok: false, code: "invalid-request" };
    }
    return { ok: true, value: { artifactId, question, thinking } };
  } catch {
    return { ok: false, code: "invalid-request" };
  }
}

export async function prepareReaderRequest(
  store: ArtifactStore,
  value: unknown,
  supportedThinking: ReadonlySet<ReaderThinking>,
): Promise<ReaderValidation<PreparedReaderRequest>> {
  const question = parseReaderQuestion(value, supportedThinking);
  if (!question.ok) return question;
  const snapshot = await store.snapshotSource(question.value.artifactId);
  return snapshot
    ? { ok: true, value: { question: question.value, snapshot } }
    : { ok: false, code: "evidence-expired" };
}

export function parseReaderAnswer(
  value: unknown,
  snapshot: Pick<SourceSnapshot, "sourceId" | "lineCount">,
): ReaderValidation<ReaderAnswer> {
  try {
    const fields = readDataRecord(value, ["status", "answer", "citations"]);
    if (!fields) return { ok: false, code: "invalid-answer" };
    const [status, answerText, citationsValue] = fields;
    const citationValues = readDenseDataArray(citationsValue, 16);
    if (
      (status !== "answered" && status !== "insufficient-evidence") ||
      typeof answerText !== "string" ||
      answerText.trim().length === 0 ||
      !citationValues
    ) {
      return { ok: false, code: "invalid-answer" };
    }

    const citations: ReaderCitation[] = [];
    const seen = new Set<string>();
    for (const citationValue of citationValues) {
      const citation = readDataRecord(citationValue, ["sourceId", "startLine", "endLine"]);
      if (!citation) return { ok: false, code: "invalid-answer" };
      const [sourceId, startLine, endLine] = citation;
      if (
        sourceId !== snapshot.sourceId ||
        !isSafeLine(startLine) ||
        !isSafeLine(endLine) ||
        startLine > endLine ||
        endLine > snapshot.lineCount
      ) {
        return { ok: false, code: "invalid-answer" };
      }
      const key = `${sourceId}\u0000${startLine}\u0000${endLine}`;
      if (seen.has(key)) return { ok: false, code: "invalid-answer" };
      seen.add(key);
      citations.push({ sourceId, startLine, endLine });
    }

    if (
      (status === "answered" && citations.length === 0) ||
      (status === "insufficient-evidence" && citations.length !== 0)
    ) {
      return { ok: false, code: "invalid-answer" };
    }
    return { ok: true, value: { status, answer: answerText, citations } };
  } catch {
    return { ok: false, code: "invalid-answer" };
  }
}

function result(payload: ReaderPayload): ReaderToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: {} };
}

export function readerToolError(code: ReaderErrorCode): ReaderToolResult {
  return result({ status: "error", code });
}

function error(code: ReaderErrorCode): ReaderToolResult {
  return readerToolError(code);
}

export function readerToolResultBytes(value: ReaderToolResult): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export type ReaderAuthorizationGuard = () => boolean;

async function returnWithLiveEvidence(
  store: ArtifactStore,
  snapshot: SourceSnapshot,
  candidate: ReaderToolResult,
  isAuthorized: ReaderAuthorizationGuard,
): Promise<ReaderToolResult> {
  if (!isAuthorized()) return error("reader-cancelled");
  const evidenceLive = await store.revalidateSource(snapshot);
  if (!isAuthorized()) return error("reader-cancelled");
  return evidenceLive ? candidate : error("evidence-expired");
}

export async function finalizeReaderAnswer(
  store: ArtifactStore,
  snapshot: SourceSnapshot,
  value: unknown,
  answerMaxBytes: number,
  isAuthorized: ReaderAuthorizationGuard = () => true,
): Promise<ReaderToolResult> {
  if (!isAuthorized()) return error("reader-cancelled");
  if (
    !Number.isSafeInteger(answerMaxBytes) ||
    answerMaxBytes < MIN_ANSWER_BYTES ||
    answerMaxBytes > MAX_ANSWER_BYTES
  ) {
    return returnWithLiveEvidence(store, snapshot, error("output-unavailable"), isAuthorized);
  }

  const answer = parseReaderAnswer(value, snapshot);
  if (!answer.ok) return returnWithLiveEvidence(store, snapshot, error(answer.code), isAuthorized);

  const inline = result(answer.value);
  if (readerToolResultBytes(inline) <= answerMaxBytes)
    return returnWithLiveEvidence(store, snapshot, inline, isAuthorized);

  const answerArtifactId = await store.archiveDerived(snapshot, inline.content[0].text);
  if (!isAuthorized()) {
    if (answerArtifactId) {
      await store.discardDerived(answerArtifactId, snapshot);
      if (!isAuthorized()) return error("reader-cancelled");
    }
    return error("reader-cancelled");
  }
  if (!answerArtifactId) {
    return returnWithLiveEvidence(store, snapshot, error("output-unavailable"), isAuthorized);
  }

  const stored = result({ status: "stored", answerArtifactId, sourceId: snapshot.sourceId });
  if (readerToolResultBytes(stored) > answerMaxBytes) {
    await store.discardDerived(answerArtifactId, snapshot);
    return isAuthorized() ? error("output-unavailable") : error("reader-cancelled");
  }

  const evidenceLive = await store.revalidateSource(snapshot);
  if (!isAuthorized()) {
    await store.discardDerived(answerArtifactId, snapshot);
    if (!isAuthorized()) return error("reader-cancelled");
    return error("reader-cancelled");
  }
  if (evidenceLive) return stored;

  await store.discardDerived(answerArtifactId, snapshot);
  return isAuthorized() ? error("evidence-expired") : error("reader-cancelled");
}

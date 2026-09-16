import assert from "node:assert/strict";
import { stat, unlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { ArtifactStore, type SourceSnapshot } from "../src/context-shunt.ts";
import {
  finalizeReaderAnswer,
  parseReaderAnswer,
  parseReaderQuestion,
  prepareReaderRequest,
  readerToolResultBytes,
  READER_THINKING_LEVELS,
  type ReaderAnswer,
  type ReaderThinking,
  type ReaderToolResult,
} from "../src/context-shunt-reader.ts";

const TTL_MS = 30 * 60 * 1000;
const allSupportedThinking = new Set<ReaderThinking>(READER_THINKING_LEVELS);

function answer(sourceId: string, text = "supported"): ReaderAnswer {
  return {
    status: "answered",
    answer: text,
    citations: [{ sourceId, startLine: 1, endLine: 1 }],
  };
}

function payload(result: ReaderToolResult): Record<string, unknown> {
  assert.deepEqual(result.details, {});
  assert.equal(result.content.length, 1);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

test("artifact sources and derived answers have distinct IDs while recovery keeps both available", async () => {
  const store = new ArtifactStore();
  const sourceId = await store.archive("one\ntwo");
  assert.ok(sourceId);
  const snapshot = await store.snapshotSource(sourceId);
  assert.deepEqual(
    snapshot && { sourceId: snapshot.sourceId, text: snapshot.text, lineCount: snapshot.lineCount },
    {
      sourceId,
      text: "one\ntwo",
      lineCount: 2,
    },
  );
  assert.equal("path" in (snapshot ?? {}), false);
  assert.equal((snapshot?.digest ?? "").length, 64);

  const derivedId = await store.archiveDerived(snapshot!, "derived answer");
  assert.match(derivedId ?? "", /^derived-[0-9a-f-]{36}$/);
  assert.notEqual(derivedId, sourceId);
  assert.equal(await store.snapshotSource(derivedId!), undefined);
  assert.deepEqual(await store.recover({ artifactId: sourceId, lineOffset: 0, lineLimit: 1 }, 64), {
    text: "one\n",
    range: "lines 1-1",
  });
  assert.deepEqual(
    await store.recover({ artifactId: derivedId!, byteOffset: 0, maxBytes: 14 }, 64),
    {
      text: "derived answer",
      range: "bytes 0-14",
    },
  );
  await store.close();
});

test("artifact quotas include derived artifacts and retain exact 64 KiB payloads", async () => {
  const exact = "x".repeat(64 * 1024);
  const store = new ArtifactStore();
  const sourceId = await store.archive(exact);
  assert.ok(sourceId, "an exact 64 KiB source is preserved");
  assert.equal(await store.archive(`${exact}x`), undefined, "a 64 KiB plus one source is rejected");
  const snapshot = await store.snapshotSource(sourceId);
  assert.ok(snapshot);
  const derivedId = await store.archiveDerived(snapshot, exact);
  assert.ok(derivedId, "an exact 64 KiB derived answer is preserved");
  assert.equal(await store.archiveDerived(snapshot, `${exact}x`), undefined);
  await store.close();

  const quotaStore = new ArtifactStore();
  const ids = await Promise.all(
    Array.from({ length: 8 }, (_, index) => quotaStore.archive(String(index))),
  );
  assert.equal(ids.filter(Boolean).length, 8);
  assert.equal(await quotaStore.archive("ninth"), undefined, "the shared artifact count is eight");
  await quotaStore.close();

  const bytesStore = new ArtifactStore();
  const first = await bytesStore.archive(exact);
  assert.ok(first);
  const firstSnapshot = await bytesStore.snapshotSource(first);
  assert.ok(firstSnapshot);
  for (let index = 0; index < 6; index += 1) assert.ok(await bytesStore.archive(exact));
  assert.ok(await bytesStore.archiveDerived(firstSnapshot, exact), "512 KiB exactly is allowed");
  assert.equal(
    await bytesStore.archive("overflow"),
    undefined,
    "eight 64 KiB artifacts reach both shared count and byte ceilings, so this boundary does not isolate either quota",
  );
  await bytesStore.close();
});

test("source snapshots have an absolute TTL and fail closed for expired, missing, and mutated files", async () => {
  let now = 0;
  const paths: string[] = [];
  const store = new ArtifactStore(
    () => now,
    undefined,
    undefined,
    async (path, content) => {
      paths.push(path);
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
    },
  );
  const sourceId = await store.archive("alpha\nbeta");
  assert.ok(sourceId);
  const snapshot = await store.snapshotSource(sourceId);
  assert.ok(snapshot);
  now = TTL_MS - 1;
  assert.equal(await store.revalidateSource(snapshot), true);
  now = TTL_MS;
  assert.equal(
    await store.revalidateSource(snapshot),
    false,
    "revalidation does not renew the TTL",
  );
  assert.equal(await store.snapshotSource(sourceId), undefined);
  await store.close();

  const missingStore = new ArtifactStore(Date.now, undefined, undefined, async (path, content) => {
    paths.push(path);
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  });
  const missingId = await missingStore.archive("missing");
  assert.ok(missingId);
  const missingSnapshot = await missingStore.snapshotSource(missingId);
  assert.ok(missingSnapshot);
  await unlink(paths.at(-1)!);
  assert.equal(await missingStore.snapshotSource(missingId), undefined);
  assert.equal(await missingStore.revalidateSource(missingSnapshot), false);
  await missingStore.close();

  const mutatedStore = new ArtifactStore(Date.now, undefined, undefined, async (path, content) => {
    paths.push(path);
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  });
  const mutatedId = await mutatedStore.archive("original");
  assert.ok(mutatedId);
  const mutatedSnapshot = await mutatedStore.snapshotSource(mutatedId);
  assert.ok(mutatedSnapshot);
  await writeFile(paths.at(-1)!, "changed", "utf8");
  assert.equal(await mutatedStore.revalidateSource(mutatedSnapshot), false);
  assert.equal(
    await mutatedStore
      .recover({ artifactId: mutatedId, byteOffset: 0, maxBytes: 8 }, 8)
      .then((value) => "error" in value),
    true,
  );
  await mutatedStore.close();
});

test("source snapshots are frozen canonical evidence and reject clones", async () => {
  const store = new ArtifactStore();
  const sourceId = await store.archive("one\ntwo");
  assert.ok(sourceId);
  const snapshot = await store.snapshotSource(sourceId);
  assert.ok(snapshot);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.throws(() => Object.assign(snapshot, { text: "changed" }), TypeError);
  assert.equal(await store.revalidateSource(snapshot), true);

  const cloned = { ...snapshot, text: "changed", lineCount: 1 };
  assert.equal(await store.revalidateSource(cloned), false);
  assert.equal(await store.archiveDerived(cloned, "derived"), undefined);
  assert.deepEqual(payload(await finalizeReaderAnswer(store, cloned, answer(sourceId), 1024)), {
    status: "error",
    code: "evidence-expired",
  });
  await store.close();
});

test("source removal, mutation, and expiry cascade to derived artifacts", async () => {
  const createStore = () => {
    const paths: string[] = [];
    const store = new ArtifactStore(Date.now, undefined, undefined, async (path, content) => {
      paths.push(path);
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
    });
    return { store, paths };
  };

  const missing = createStore();
  const missingSource = await missing.store.archive("source");
  assert.ok(missingSource);
  const missingSnapshot = await missing.store.snapshotSource(missingSource);
  assert.ok(missingSnapshot);
  const missingDerived = await missing.store.archiveDerived(missingSnapshot, "derived");
  assert.ok(missingDerived);
  await unlink(missing.paths[0]!);
  assert.deepEqual(
    await missing.store.recover({ artifactId: missingDerived, byteOffset: 0, maxBytes: 7 }, 7),
    { error: "Recovery artifact is unavailable or expired." },
  );
  await assert.rejects(stat(missing.paths[1]!));
  const replacements = await Promise.all(
    Array.from({ length: 8 }, (_, index) => missing.store.archive(`replacement-${index}`)),
  );
  assert.equal(replacements.filter(Boolean).length, 8, "the source cascade releases derived quota");
  await missing.store.close();

  const mutated = createStore();
  const mutatedSource = await mutated.store.archive("source");
  assert.ok(mutatedSource);
  const mutatedSnapshot = await mutated.store.snapshotSource(mutatedSource);
  assert.ok(mutatedSnapshot);
  const mutatedDerived = await mutated.store.archiveDerived(mutatedSnapshot, "derived");
  assert.ok(mutatedDerived);
  await writeFile(mutated.paths[0]!, "changed", "utf8");
  assert.deepEqual(
    await mutated.store.recover({ artifactId: mutatedDerived, byteOffset: 0, maxBytes: 7 }, 7),
    { error: "Recovery artifact is unavailable or expired." },
  );
  await assert.rejects(stat(mutated.paths[1]!));
  await mutated.store.close();

  let now = 0;
  const expired = new ArtifactStore(() => now);
  const expiredSource = await expired.archive("source");
  assert.ok(expiredSource);
  const expiredSnapshot = await expired.snapshotSource(expiredSource);
  assert.ok(expiredSnapshot);
  const expiredDerived = await expired.archiveDerived(expiredSnapshot, "derived");
  assert.ok(expiredDerived);
  now = TTL_MS;
  assert.deepEqual(
    await expired.recover({ artifactId: expiredDerived, byteOffset: 0, maxBytes: 7 }, 7),
    { error: "Recovery artifact is unavailable or expired." },
  );
  await expired.close();
});

test("close racing a source or derived write leaves neither artifact available", async () => {
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const unblock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = new ArtifactStore(Date.now, undefined, undefined, async (path, content) => {
    started();
    await unblock;
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  });
  const archive = store.archive("delayed");
  await writing;
  const close = store.close();
  release();
  assert.equal(await archive, undefined);
  await close;
  assert.equal(await store.archive("after-close"), undefined);

  let derivedRelease: () => void = () => undefined;
  let derivedStarted: () => void = () => undefined;
  const derivedWriting = new Promise<void>((resolve) => {
    derivedStarted = resolve;
  });
  const derivedUnblock = new Promise<void>((resolve) => {
    derivedRelease = resolve;
  });
  let writes = 0;
  const derivedStore = new ArtifactStore(Date.now, undefined, undefined, async (path, content) => {
    writes += 1;
    if (writes === 2) {
      derivedStarted();
      await derivedUnblock;
    }
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  });
  const sourceId = await derivedStore.archive("source");
  assert.ok(sourceId);
  const snapshot = await derivedStore.snapshotSource(sourceId);
  assert.ok(snapshot);
  const derivedArchive = derivedStore.archiveDerived(snapshot, "derived");
  await derivedWriting;
  const derivedClose = derivedStore.close();
  derivedRelease();
  assert.equal(await derivedArchive, undefined);
  await derivedClose;

  let now = 0;
  let expiryRelease: () => void = () => undefined;
  let expiryStarted: () => void = () => undefined;
  const expiryWriting = new Promise<void>((resolve) => {
    expiryStarted = resolve;
  });
  const expiryUnblock = new Promise<void>((resolve) => {
    expiryRelease = resolve;
  });
  writes = 0;
  const expiryStore = new ArtifactStore(
    () => now,
    undefined,
    undefined,
    async (path, content) => {
      writes += 1;
      if (writes === 2) {
        expiryStarted();
        await expiryUnblock;
      }
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
    },
  );
  const expirySource = await expiryStore.archive("source");
  assert.ok(expirySource);
  const expirySnapshot = await expiryStore.snapshotSource(expirySource);
  assert.ok(expirySnapshot);
  const expiryArchive = expiryStore.archiveDerived(expirySnapshot, "derived");
  await expiryWriting;
  now = TTL_MS;
  expiryRelease();
  assert.equal(await expiryArchive, undefined);
  assert.equal(await expiryStore.snapshotSource(expirySource), undefined);
  const afterExpiry = await Promise.all(
    Array.from({ length: 8 }, (_, index) => expiryStore.archive(`after-expiry-${index}`)),
  );
  assert.equal(
    afterExpiry.filter(Boolean).length,
    8,
    "a failed final revalidation leaves no derived quota",
  );
  await expiryStore.close();
});

test("reader questions require exact keys and a nonempty UTF-8 bounded question", () => {
  const valid = { artifactId: "source", question: "a".repeat(2048), thinking: "high" };
  assert.equal(parseReaderQuestion(valid, allSupportedThinking).ok, true);
  assert.equal(
    parseReaderQuestion(
      { artifactId: "source", question: "😀".repeat(512), thinking: "minimal" },
      allSupportedThinking,
    ).ok,
    true,
  );
  for (const value of [
    { artifactId: "source", question: "a".repeat(2049), thinking: "off" },
    { artifactId: "source", question: "😀".repeat(513), thinking: "off" },
    { artifactId: "source", question: "", thinking: "off" },
    { artifactId: "", question: "question", thinking: "off" },
    { artifactId: "source", question: "question", thinking: "unsupported" },
    { artifactId: "source", question: "question", thinking: "off", extra: true },
  ]) {
    assert.deepEqual(parseReaderQuestion(value, allSupportedThinking), {
      ok: false,
      code: "invalid-request",
    });
  }
});

test("reader thinking is authorized only by the selected model's supported set", async () => {
  const question = { artifactId: "source", question: "question", thinking: "high" as const };
  assert.equal(parseReaderQuestion(question, new Set<ReaderThinking>(["high"])).ok, true);
  assert.deepEqual(parseReaderQuestion(question, new Set<ReaderThinking>(["low"])), {
    ok: false,
    code: "invalid-request",
  });

  const store = new ArtifactStore();
  const sourceId = await store.archive("evidence");
  assert.ok(sourceId);
  const request = { artifactId: sourceId, question: "question", thinking: "high" as const };
  assert.equal(
    (await prepareReaderRequest(store, request, new Set<ReaderThinking>(["high"]))).ok,
    true,
  );
  assert.deepEqual(await prepareReaderRequest(store, request, new Set<ReaderThinking>(["low"])), {
    ok: false,
    code: "invalid-request",
  });
  await store.close();
});

test("reader validation rejects accessors, symbols, and non-plain records without invoking getters", () => {
  let getters = 0;
  const supported = new Set<ReaderThinking>(["low"]);
  const getterQuestion = { artifactId: "source", question: "question", thinking: "low" };
  Object.defineProperty(getterQuestion, "question", {
    enumerable: true,
    get() {
      getters += 1;
      return "question";
    },
  });
  const inheritedQuestion = Object.assign(Object.create({ inherited: true }), {
    artifactId: "source",
    question: "question",
    thinking: "low",
  });
  const symbolQuestion = {
    artifactId: "source",
    question: "question",
    thinking: "low",
    [Symbol("unexpected")]: true,
  };
  for (const value of [getterQuestion, inheritedQuestion, symbolQuestion]) {
    assert.deepEqual(parseReaderQuestion(value, supported), {
      ok: false,
      code: "invalid-request",
    });
  }

  const snapshot = { sourceId: "source", lineCount: 1 };
  const getterCitation = { sourceId: "source", startLine: 1, endLine: 1 };
  Object.defineProperty(getterCitation, "startLine", {
    enumerable: true,
    get() {
      getters += 1;
      return 1;
    },
  });
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      getters += 1;
      return { sourceId: "source", startLine: 1, endLine: 1 };
    },
  });
  const inheritedArray = [{ sourceId: "source", startLine: 1, endLine: 1 }];
  Object.setPrototypeOf(inheritedArray, null);
  const symbolArray = [{ sourceId: "source", startLine: 1, endLine: 1 }];
  Object.defineProperty(symbolArray, Symbol("unexpected"), { value: true });
  for (const citations of [[getterCitation], accessorArray, inheritedArray, symbolArray]) {
    assert.deepEqual(
      parseReaderAnswer({ status: "answered", answer: "supported", citations }, snapshot),
      { ok: false, code: "invalid-answer" },
    );
  }
  assert.equal(getters, 0);
});

test("reader answers require exact statuses and bounded, unique source citations", () => {
  const snapshot = { sourceId: "source", lineCount: 16 };
  assert.equal(parseReaderAnswer(answer("source"), snapshot).ok, true);
  assert.deepEqual(
    parseReaderAnswer(
      { status: "insufficient-evidence", answer: "no support", citations: [] },
      snapshot,
    ),
    { ok: true, value: { status: "insufficient-evidence", answer: "no support", citations: [] } },
  );
  const sixteen = Array.from({ length: 16 }, (_, index) => ({
    sourceId: "source",
    startLine: index + 1,
    endLine: index + 1,
  }));
  assert.equal(
    parseReaderAnswer({ status: "answered", answer: "supported", citations: sixteen }, snapshot).ok,
    true,
  );
  const seventeen = [...sixteen, { sourceId: "source", startLine: 1, endLine: 2 }];
  for (const value of [
    { status: "answered", answer: "supported", citations: seventeen },
    { status: "answered", answer: "supported", citations: [sixteen[0], sixteen[0]] },
    {
      status: "answered",
      answer: "supported",
      citations: [{ sourceId: "other", startLine: 1, endLine: 1 }],
    },
    { status: "answered", answer: "supported", citations: [] },
    { status: "answered", answer: " ", citations: [sixteen[0]] },
    { status: "insufficient-evidence", answer: "\t", citations: [] },
    {
      status: "answered",
      answer: "supported",
      citations: [{ sourceId: "source", startLine: 0, endLine: 1 }],
    },
    {
      status: "answered",
      answer: "supported",
      citations: [{ sourceId: "source", startLine: -1, endLine: 1 }],
    },
    {
      status: "answered",
      answer: "supported",
      citations: [{ sourceId: "source", startLine: 1.5, endLine: 2 }],
    },
    {
      status: "answered",
      answer: "supported",
      citations: [{ sourceId: "source", startLine: 17, endLine: 17 }],
    },
    {
      status: "answered",
      answer: "supported",
      citations: [{ sourceId: "source", startLine: 2, endLine: 1 }],
    },
    {
      status: "answered",
      answer: "supported",
      citations: [{ sourceId: "source", startLine: 1, endLine: 1, extra: true }],
    },
    { status: "insufficient-evidence", answer: "no support", citations: [sixteen[0]] },
    { status: "answered", answer: "supported", citations: [sixteen[0]], extra: true },
  ]) {
    assert.deepEqual(parseReaderAnswer(value, snapshot), { ok: false, code: "invalid-answer" });
  }
});

test("reader preparation only returns a live source snapshot and never a storage path", async () => {
  const store = new ArtifactStore();
  const sourceId = await store.archive("one\ntwo");
  assert.ok(sourceId);
  const prepared = await prepareReaderRequest(
    store,
    {
      artifactId: sourceId,
      question: "What is present?",
      thinking: "low",
    },
    allSupportedThinking,
  );
  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.equal("path" in prepared.value.snapshot, false);
    assert.equal(prepared.value.snapshot.sourceId, sourceId);
  }
  assert.deepEqual(
    await prepareReaderRequest(
      store,
      {
        artifactId: "derived-not-source",
        question: "q",
        thinking: "off",
      },
      allSupportedThinking,
    ),
    { ok: false, code: "evidence-expired" },
  );
  await store.close();
});

test("reader measures the entire Unicode tool result and stores whole oversized answers", async () => {
  const store = new ArtifactStore();
  const sourceId = await store.archive("evidence");
  assert.ok(sourceId);
  const snapshot = await store.snapshotSource(sourceId);
  assert.ok(snapshot);
  const unicodeAnswer = answer(sourceId, "😀".repeat(400));
  const probe = await finalizeReaderAnswer(store, snapshot, unicodeAnswer, 16 * 1024);
  const exactBytes = readerToolResultBytes(probe);
  assert.ok(exactBytes >= 1024);
  const equal = await finalizeReaderAnswer(store, snapshot, unicodeAnswer, exactBytes);
  assert.deepEqual(
    payload(equal),
    unicodeAnswer,
    "equality includes the result wrapper and Unicode bytes",
  );
  const stored = await finalizeReaderAnswer(store, snapshot, unicodeAnswer, exactBytes - 1);
  const storedPayload = payload(stored);
  assert.equal(storedPayload.status, "stored");
  assert.equal(storedPayload.sourceId, sourceId);
  assert.equal(readerToolResultBytes(stored) <= exactBytes - 1, true);
  const answerArtifactId = storedPayload.answerArtifactId;
  assert.equal(typeof answerArtifactId, "string");
  const recovered = await store.recover(
    { artifactId: answerArtifactId as string, lineOffset: 0, lineLimit: 1 },
    16 * 1024,
  );
  assert.ok("text" in recovered);
  assert.deepEqual(JSON.parse((recovered as { text: string }).text), unicodeAnswer);
  await store.close();
});

test("reader accepts only configured answer caps and caps the complete returned result", async () => {
  const store = new ArtifactStore();
  const sourceId = await store.archive("evidence");
  assert.ok(sourceId);
  const snapshot = await store.snapshotSource(sourceId);
  assert.ok(snapshot);
  const oversized = answer(sourceId, "response ".repeat(300));

  for (const answerMaxBytes of [1024, 16384]) {
    const finalized = await finalizeReaderAnswer(store, snapshot, oversized, answerMaxBytes);
    assert.ok(readerToolResultBytes(finalized) <= answerMaxBytes);
  }
  for (const answerMaxBytes of [1023, 16385]) {
    const finalized = await finalizeReaderAnswer(store, snapshot, oversized, answerMaxBytes);
    assert.deepEqual(payload(finalized), { status: "error", code: "output-unavailable" });
    assert.ok(readerToolResultBytes(finalized) <= 1024);
  }
  await store.close();
});

test("reader discards a derived artifact when the stored receipt exceeds the answer cap", async () => {
  const discarded: Array<{ id: string; snapshot: SourceSnapshot }> = [];
  class OverlongReceiptStore extends ArtifactStore {
    override async archiveDerived(_snapshot: SourceSnapshot, _text: string): Promise<string> {
      return `derived-${"x".repeat(1100)}`;
    }

    override async discardDerived(id: string, snapshot: SourceSnapshot): Promise<void> {
      discarded.push({ id, snapshot });
    }
  }

  const store = new OverlongReceiptStore();
  const sourceId = await store.archive("evidence");
  assert.ok(sourceId);
  const snapshot = await store.snapshotSource(sourceId);
  assert.ok(snapshot);
  const finalized = await finalizeReaderAnswer(
    store,
    snapshot,
    answer(sourceId, "x".repeat(4000)),
    1024,
  );
  assert.deepEqual(payload(finalized), { status: "error", code: "output-unavailable" });
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0]?.id, `derived-${"x".repeat(1100)}`);
  assert.equal(discarded[0]?.snapshot, snapshot);
  await store.close();
});

test("reader discards a derived artifact when final evidence revalidation fails", async () => {
  const discarded: Array<{ id: string; snapshot: SourceSnapshot }> = [];
  class ExpiringStore extends ArtifactStore {
    override async discardDerived(id: string, snapshot: SourceSnapshot): Promise<void> {
      discarded.push({ id, snapshot });
      await super.discardDerived(id, snapshot);
    }

    override async revalidateSource(_snapshot: SourceSnapshot): Promise<boolean> {
      return false;
    }
  }

  const store = new ExpiringStore();
  const sourceId = await store.archive("evidence");
  assert.ok(sourceId);
  const snapshot = await store.snapshotSource(sourceId);
  assert.ok(snapshot);
  const finalized = await finalizeReaderAnswer(
    store,
    snapshot,
    answer(sourceId, "x".repeat(4000)),
    1024,
  );
  assert.deepEqual(payload(finalized), { status: "error", code: "evidence-expired" });
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0]?.snapshot, snapshot);
  assert.match(discarded[0]?.id ?? "", /^derived-[0-9a-f-]{36}$/);
  await store.close();
});

test("discarding a derived artifact twice preserves the live source snapshot", async () => {
  const store = new ArtifactStore();
  const sourceId = await store.archive("source");
  assert.ok(sourceId);
  const snapshot = await store.snapshotSource(sourceId);
  assert.ok(snapshot);
  const derivedId = await store.archiveDerived(snapshot, "derived");
  assert.ok(derivedId);

  await store.discardDerived(derivedId, snapshot);
  await store.discardDerived(derivedId, snapshot);
  assert.deepEqual(await store.recover({ artifactId: derivedId, byteOffset: 0, maxBytes: 7 }, 7), {
    error: "Recovery artifact is unavailable or expired.",
  });
  assert.equal(await store.revalidateSource(snapshot), true);
  assert.deepEqual(await store.recover({ artifactId: sourceId, byteOffset: 0, maxBytes: 6 }, 6), {
    text: "source",
    range: "bytes 0-6",
  });
  await store.close();
});

test("reader returns bounded safe errors for write, quota, size, and expiry failures", async () => {
  let writes = 0;
  const failedStore = new ArtifactStore(Date.now, undefined, undefined, async (path, content) => {
    writes += 1;
    if (writes > 1) throw new Error("sentinel writer failure");
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  });
  const sourceId = await failedStore.archive("evidence");
  assert.ok(sourceId);
  const snapshot = await failedStore.snapshotSource(sourceId);
  assert.ok(snapshot);
  const oversized = answer(sourceId, "response sentinel ".repeat(100));
  const writeFailure = await finalizeReaderAnswer(failedStore, snapshot, oversized, 1024);
  assert.deepEqual(payload(writeFailure), { status: "error", code: "output-unavailable" });
  assert.doesNotMatch(JSON.stringify(writeFailure), /sentinel|path/i);
  await failedStore.close();

  const quotaStore = new ArtifactStore();
  const quotaSource = await quotaStore.archive("evidence");
  assert.ok(quotaSource);
  const quotaSnapshot = await quotaStore.snapshotSource(quotaSource);
  assert.ok(quotaSnapshot);
  for (let index = 0; index < 7; index += 1) assert.ok(await quotaStore.archive(String(index)));
  assert.deepEqual(
    payload(
      await finalizeReaderAnswer(
        quotaStore,
        quotaSnapshot,
        answer(quotaSource, "response sentinel ".repeat(100)),
        1024,
      ),
    ),
    { status: "error", code: "output-unavailable" },
  );
  await quotaStore.close();

  const sizeStore = new ArtifactStore();
  const sizeSource = await sizeStore.archive("evidence");
  assert.ok(sizeSource);
  const sizeSnapshot = await sizeStore.snapshotSource(sizeSource);
  assert.ok(sizeSnapshot);
  const tooLarge = answer(sizeSource, "raw-sentinel".repeat(8_000));
  const sizeFailure = await finalizeReaderAnswer(sizeStore, sizeSnapshot, tooLarge, 1024);
  assert.deepEqual(payload(sizeFailure), { status: "error", code: "output-unavailable" });
  assert.doesNotMatch(JSON.stringify(sizeFailure), /raw-sentinel/);
  await sizeStore.close();

  let now = 0;
  const expiredStore = new ArtifactStore(() => now);
  const expiredSource = await expiredStore.archive("evidence");
  assert.ok(expiredSource);
  const expiredSnapshot = await expiredStore.snapshotSource(expiredSource);
  assert.ok(expiredSnapshot);
  now = TTL_MS;
  assert.deepEqual(
    payload(await finalizeReaderAnswer(expiredStore, expiredSnapshot, answer(expiredSource), 1024)),
    {
      status: "error",
      code: "evidence-expired",
    },
  );
  await expiredStore.close();

  for (const code of [
    "invalid-request",
    "evidence-expired",
    "invalid-answer",
    "output-unavailable",
  ] as const) {
    assert.ok(
      readerToolResultBytes({
        content: [{ type: "text", text: JSON.stringify({ status: "error", code }) }],
        details: {},
      }) <= 1024,
    );
  }
});

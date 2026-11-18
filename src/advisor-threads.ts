import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { atomicWrite, getGlobalConfigPath } from "./config.ts";

/**
 * Private journal for Advisor continuations.
 *
 * One record per (parent session, task token, original Advisor slot). It stores opaque identifiers
 * and closed reasons only: never a question, brief, answer, path, session file or raw error. The
 * file is a schema-1 companion beside the existing ones, so the schema-10 policy document and its
 * two-file commit are untouched.
 *
 * Two invariants drive every transition:
 *  - a turn is written as `pending` before anything is sent, `accepted` before its receipt is
 *    awaited, and `answered` before the answer is returned;
 *  - every non-closed record is an obligation. Uncertain turns block the whole parent; answered
 *    turns belong only to their active task and must be closed before another task can consult.
 */
export const ADVISOR_THREADS_SCHEMA_VERSION = 1;
/** Bounds keep the companion small; a live record is never evicted to admit new work. */
export const ADVISOR_THREAD_MAX_PARENTS = 16;
export const ADVISOR_THREAD_MAX_RECORDS = 24;
/** A file may exceed the soft quota to keep non-closed obligations; it stays readable. */
export const ADVISOR_THREAD_HARD_MAX_RECORDS = 96;
export const ADVISOR_THREAD_MAX_RUN_IDS = 16;
export const ADVISOR_ANSWER_MAX_BYTES = 64 * 1024;

const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const TASK_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const PARENT_KEY = /^[0-9a-f]{64}$/;
const LOCK_OWNER_FILE = "owner.json";

export type AdvisorThreadState = "pending" | "accepted" | "answered" | "blocked" | "closed";
/**
 * Closed causes. `answered`, `reset`, `task-settled`, `fingerprint-changed`, `session-changed` and
 * `recovered` close a thread; the rest describe why a thread is blocked.
 */
export type AdvisorThreadReason =
  | "answered"
  | "reset"
  | "task-settled"
  | "fingerprint-changed"
  | "session-changed"
  | "configuration-changed"
  | "launch-failed"
  | "resume-refused"
  | "resume-uncertain"
  | "terminal-mismatch"
  | "answer-missing"
  | "answer-invalid"
  | "journal-failed"
  | "recovered";
/** Everything the journal needs to prove a continuation still belongs to the same admission. */
export type AdvisorThreadFingerprint = Readonly<{
  provider: string;
  model: string;
  thinking: string;
  profile: string;
  /** Provider extension identity, or an empty string when the profile needs none. */
  admission: string;
  /** Own package version, so a different build never resumes another build's thread. */
  packageVersion: string;
  /** Bumped whenever Advisor mode, launch or settings change inside one process. */
  epoch: number;
}>;
/**
 * Context recorded for a turn, for description only: nothing reads it to decide how a thread launches.
 * A first turn writes `fresh` when it completes; a continuation keeps whatever the record held, so a
 * `fork` written by an earlier build can persist there.
 */
export type AdvisorTurnContext = "fresh" | "fork";

export type AdvisorThreadRecord = Readonly<{
  slot: number;
  taskToken: string;
  fingerprint: AdvisorThreadFingerprint;
  state: AdvisorThreadState;
  reason?: AdvisorThreadReason;
  /** Turn number inside the slot; also names the per-turn answer directory. */
  ordinal: number;
  /**
   * The run id of the operation this record describes, once its receipt is known. Recovery may only
   * use this id: an ancestor in `runIds` proves a previous turn, never the pending one.
   */
  operationRunId?: string;
  /** Run-id chain, oldest first. The last entry is the only valid resume target. */
  runIds: readonly string[];
  /**
   * Context recorded for the latest turn, for description only; no launch reads it. A first turn omits
   * it while pending and writes `fresh` on completion, so a legacy `fork` disappears then. A
   * continuation copies the record it continues, so it keeps that value instead of rewriting it.
   */
  mode?: AdvisorTurnContext;
  updatedAt: number;
}>;
export type AdvisorParentPartition = Readonly<{
  updatedAt: number;
  threads: readonly AdvisorThreadRecord[];
}>;
export type AdvisorThreadsFile = Readonly<{
  schemaVersion: typeof ADVISOR_THREADS_SCHEMA_VERSION;
  parents: Readonly<Record<string, AdvisorParentPartition>>;
}>;
export type AdvisorJournalFailure =
  | "journal-busy"
  | "journal-unreadable"
  | "journal-write-failed"
  /** The reclamation gate is stale, ownerless or unreadable and is never reclaimed automatically. */
  | "journal-gate-stale";

export class AdvisorJournalError extends Error {
  readonly code: AdvisorJournalFailure;
  constructor(code: AdvisorJournalFailure) {
    super(code);
    this.name = "AdvisorJournalError";
    this.code = code;
  }
}

export function getAdvisorThreadsPath(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.advisor-threads.json`;
}

/** Per-operation answer directories live beside the journal, never inside the session tree. */
export function getAdvisorOutputRoot(configPath = getGlobalConfigPath()): string {
  return `${configPath.endsWith(".json") ? configPath.slice(0, -5) : configPath}.advisor-output`;
}

/** The parent partition key: a hash of the parent session identity, never the identity itself. */
export function advisorParentKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

export function isAdvisorRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID.test(value);
}

export function isAdvisorTaskToken(value: unknown): value is string {
  return typeof value === "string" && TASK_TOKEN.test(value);
}

export function isAdvisorParentKey(value: unknown): value is string {
  return typeof value === "string" && PARENT_KEY.test(value);
}

/** `<root>/<parent>/<task>/<slot>-<ordinal>/answer.md`, built only from tokens this module owns. */
export function advisorAnswerPath(
  root: string,
  parentKey: string,
  taskToken: string,
  slot: number,
  ordinal: number,
): string {
  if (!isAdvisorParentKey(parentKey)) throw new Error("invalid parent key");
  if (!isAdvisorTaskToken(taskToken)) throw new Error("invalid task token");
  if (!Number.isInteger(slot) || slot < 0 || slot > 99) throw new Error("invalid slot");
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 999)
    throw new Error("invalid ordinal");
  return join(root, parentKey, taskToken, `${slot}-${ordinal}`, "answer.md");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function only(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isThreadState(value: unknown): value is AdvisorThreadState {
  return (
    value === "pending" ||
    value === "accepted" ||
    value === "answered" ||
    value === "blocked" ||
    value === "closed"
  );
}

const THREAD_REASONS: ReadonlySet<string> = new Set<AdvisorThreadReason>([
  "answered",
  "reset",
  "task-settled",
  "fingerprint-changed",
  "session-changed",
  "configuration-changed",
  "launch-failed",
  "resume-refused",
  "resume-uncertain",
  "terminal-mismatch",
  "answer-missing",
  "answer-invalid",
  "journal-failed",
  "recovered",
]);

function parseFingerprint(value: unknown): AdvisorThreadFingerprint | undefined {
  if (
    !isRecord(value) ||
    !only(value, [
      "provider",
      "model",
      "thinking",
      "profile",
      "admission",
      "packageVersion",
      "epoch",
    ])
  )
    return undefined;
  const { provider, model, thinking, profile, admission, packageVersion, epoch } = value;
  if (
    typeof provider !== "string" ||
    typeof model !== "string" ||
    typeof thinking !== "string" ||
    typeof profile !== "string" ||
    typeof admission !== "string" ||
    typeof packageVersion !== "string" ||
    !Number.isInteger(epoch) ||
    (epoch as number) < 0
  )
    return undefined;
  return {
    provider,
    model,
    thinking,
    profile,
    admission,
    packageVersion,
    epoch: epoch as number,
  };
}

function parseThread(value: unknown): AdvisorThreadRecord | undefined {
  if (
    !isRecord(value) ||
    !only(value, [
      "slot",
      "taskToken",
      "fingerprint",
      "state",
      "reason",
      "ordinal",
      "operationRunId",
      "runIds",
      "mode",
      "updatedAt",
    ])
  )
    return undefined;
  const fingerprint = parseFingerprint(value.fingerprint);
  if (!fingerprint) return undefined;
  if (!Number.isInteger(value.slot) || (value.slot as number) < 0) return undefined;
  if (!isAdvisorTaskToken(value.taskToken)) return undefined;
  if (!isThreadState(value.state)) return undefined;
  if (!Number.isInteger(value.ordinal) || (value.ordinal as number) < 0) return undefined;
  if (!Array.isArray(value.runIds) || !value.runIds.every(isAdvisorRunId)) return undefined;
  if (value.runIds.length > ADVISOR_THREAD_MAX_RUN_IDS) return undefined;
  if (value.operationRunId !== undefined && !isAdvisorRunId(value.operationRunId)) return undefined;
  if (value.reason !== undefined && !THREAD_REASONS.has(value.reason as string)) return undefined;
  if (value.mode !== undefined && value.mode !== "fork" && value.mode !== "fresh") return undefined;
  if (!Number.isFinite(value.updatedAt) || (value.updatedAt as number) < 0) return undefined;
  return {
    slot: value.slot as number,
    taskToken: value.taskToken,
    fingerprint,
    state: value.state,
    ...(value.reason === undefined ? {} : { reason: value.reason as AdvisorThreadReason }),
    ordinal: value.ordinal as number,
    ...(value.operationRunId === undefined
      ? {}
      : { operationRunId: value.operationRunId as string }),
    runIds: [...(value.runIds as string[])],
    ...(value.mode === undefined ? {} : { mode: value.mode }),
    updatedAt: value.updatedAt as number,
  };
}

function parsePartition(value: unknown): AdvisorParentPartition | undefined {
  if (!isRecord(value) || !only(value, ["updatedAt", "threads"])) return undefined;
  if (!Array.isArray(value.threads)) return undefined;
  if (value.threads.length > ADVISOR_THREAD_HARD_MAX_RECORDS) return undefined;
  const threads: AdvisorThreadRecord[] = [];
  for (const entry of value.threads) {
    const thread = parseThread(entry);
    if (!thread) return undefined;
    threads.push(thread);
  }
  return { updatedAt: Number.isFinite(value.updatedAt) ? (value.updatedAt as number) : 0, threads };
}

/** Strict reader: an unknown schema version or any malformed field is rejected whole. */
export function parseAdvisorThreads(value: unknown): AdvisorThreadsFile | undefined {
  if (!isRecord(value) || !only(value, ["schemaVersion", "parents"])) return undefined;
  if (value.schemaVersion !== ADVISOR_THREADS_SCHEMA_VERSION) return undefined;
  if (!isRecord(value.parents)) return undefined;
  const parents: Record<string, AdvisorParentPartition> = {};
  for (const [key, entry] of Object.entries(value.parents)) {
    if (!isAdvisorParentKey(key)) return undefined;
    const partition = parsePartition(entry);
    if (!partition) return undefined;
    parents[key] = partition;
  }
  return { schemaVersion: ADVISOR_THREADS_SCHEMA_VERSION, parents };
}

export function emptyAdvisorThreads(): AdvisorThreadsFile {
  return { schemaVersion: ADVISOR_THREADS_SCHEMA_VERSION, parents: {} };
}

export type LoadedAdvisorThreads = Readonly<{
  file: AdvisorThreadsFile;
  /** Set when the file exists but this reader cannot trust it; nothing is overwritten then. */
  unreadable: boolean;
}>;

export async function readAdvisorThreads(path: string): Promise<LoadedAdvisorThreads> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { file: emptyAdvisorThreads(), unreadable: false }
      : { file: emptyAdvisorThreads(), unreadable: true };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { file: emptyAdvisorThreads(), unreadable: true };
  }
  const file = parseAdvisorThreads(value);
  return file ? { file, unreadable: false } : { file: emptyAdvisorThreads(), unreadable: true };
}

/**
 * A record that may still describe a live run. `blocked` counts: a turn that ended without public
 * terminal proof is uncertainty, not progress, and keeps blocking new work for its parent.
 */
function isUnresolved(record: AdvisorThreadRecord): boolean {
  return record.state === "pending" || record.state === "accepted" || record.state === "blocked";
}

export function findAdvisorThread(
  partition: AdvisorParentPartition,
  taskToken: string,
  slot: number,
): AdvisorThreadRecord | undefined {
  return partition.threads.find((record) => record.taskToken === taskToken && record.slot === slot);
}

/** The first record that may still describe a live run, or `undefined` when the parent is clear. */
export function unresolvedAdvisorThread(
  partition: AdvisorParentPartition,
): AdvisorThreadRecord | undefined {
  return partition.threads.find(isUnresolved);
}

/** An answered turn from a retired task is still owed a persisted closing tombstone. */
export function unclosedAdvisorTask(
  partition: AdvisorParentPartition,
  activeTaskToken: string | undefined,
): AdvisorThreadRecord | undefined {
  return partition.threads.find(
    (record) => record.state === "answered" && record.taskToken !== activeTaskToken,
  );
}

function boundedRecords(
  threads: readonly AdvisorThreadRecord[],
): AdvisorThreadRecord[] | undefined {
  if (threads.length <= ADVISOR_THREAD_MAX_RECORDS) return [...threads];
  const live = threads.filter((record) => record.state !== "closed");
  // Closing debt and uncertainty are never evicted to admit work. Beyond the hard ceiling the
  // write is refused instead of dropping an obligation or producing an unreadable file.
  if (live.length > ADVISOR_THREAD_HARD_MAX_RECORDS) return undefined;
  if (live.length >= ADVISOR_THREAD_MAX_RECORDS) return live;
  const room = ADVISOR_THREAD_MAX_RECORDS - live.length;
  const closed = threads
    .filter((record) => record.state === "closed")
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .slice(-room);
  const kept = new Set([...live, ...closed]);
  return threads.filter((record) => kept.has(record));
}

export function upsertAdvisorThread(
  partition: AdvisorParentPartition,
  record: AdvisorThreadRecord,
  now: number,
): AdvisorParentPartition {
  const threads = partition.threads.filter(
    (candidate) => !(candidate.taskToken === record.taskToken && candidate.slot === record.slot),
  );
  const bounded = boundedRecords([...threads, record]);
  // Over the hard ceiling the write is refused downstream, never silently truncated here.
  return { updatedAt: now, threads: bounded ?? [...threads, record] };
}

/**
 * Close one task. An answered thread becomes `closed`; an unresolved one becomes `blocked`, because
 * a task boundary proves nothing about a run that may still be live.
 */
export function closeAdvisorTask(
  partition: AdvisorParentPartition,
  taskToken: string,
  reason: AdvisorThreadReason,
  now: number,
): AdvisorParentPartition {
  const threads = partition.threads.map((record) => {
    if (record.taskToken !== taskToken) return record;
    if (record.state === "answered")
      return { ...record, state: "closed" as const, reason, updatedAt: now };
    if (record.state === "pending" || record.state === "accepted")
      return { ...record, state: "blocked" as const, reason, updatedAt: now };
    return record;
  });
  return { updatedAt: now, threads };
}

/** Session, branch or configuration change: every answered thread closes, every live one blocks. */
export function invalidateAdvisorPartition(
  partition: AdvisorParentPartition,
  reason: AdvisorThreadReason,
  now: number,
): AdvisorParentPartition {
  const threads = partition.threads.map((record) => {
    if (record.state === "answered")
      return { ...record, state: "closed" as const, reason, updatedAt: now };
    if (record.state === "pending" || record.state === "accepted")
      return { ...record, state: "blocked" as const, reason, updatedAt: now };
    return record;
  });
  return { updatedAt: now, threads };
}

/**
 * Public terminal proof for one record: it is settled, so it stops blocking its parent. The run-id
 * chain is kept for diagnosis.
 */
export function settleAdvisorThread(
  partition: AdvisorParentPartition,
  taskToken: string,
  slot: number,
  reason: AdvisorThreadReason,
  now: number,
): AdvisorParentPartition {
  const threads = partition.threads.map((record) =>
    record.taskToken === taskToken && record.slot === slot && isUnresolved(record)
      ? { ...record, state: "closed" as const, reason, updatedAt: now }
      : record,
  );
  return { updatedAt: now, threads };
}

export type AdvisorLockOwner = Readonly<{
  owner: string;
  pid: number;
  startedAt: number;
}>;

export type AdvisorLockState =
  { kind: "free" } | { kind: "held"; owner?: AdvisorLockOwner } | { kind: "unreadable" };

export type AdvisorJournalSession = Readonly<{
  parentKey: string;
  /** The last partition this session wrote or read; a hint, never the base of a mutation. */
  partition: () => AdvisorParentPartition;
  /**
   * Apply one transition to the freshest partition on disk. Mutations are serialized inside the
   * group and the shared file is replaced under a short commit lock, so concurrent parents and
   * concurrent slots can never overwrite each other's records with a stale snapshot.
   */
  mutate: (update: (latest: AdvisorParentPartition) => AdvisorParentPartition) => Promise<void>;
}>;

/** One write holds the commit lock for a few milliseconds; a waiter gives up after this bound. */
const COMMIT_LOCK_WAIT_MS = 2_000;
const COMMIT_LOCK_RETRY_MS = 5;

export type AdvisorJournalExclusiveResult<Value> =
  { ok: true; value: Value } | { ok: false; code: AdvisorJournalFailure };

/**
 * The journal and its cross-instance lock. The lock is one atomically created directory per parent,
 * held for the whole consultation group: a second process cannot resume the same thread while the
 * first still owns it. Nothing steals a lock by age, and a reused PID is indistinguishable from a
 * live owner, so recovery stays a deliberate operator action.
 */
export class AdvisorThreadJournal {
  private readonly path: string;
  private readonly lockRoot: string;
  private readonly now: () => number;
  private readonly owner: string;
  private readonly pid: number;
  private readonly isOwnerFinished: (owner: AdvisorLockOwner) => boolean;
  private readonly writeOwner: (path: string, text: string) => Promise<void>;

  constructor(
    path = getAdvisorThreadsPath(),
    options: {
      now?: () => number;
      owner?: string;
      pid?: number;
      /** Test seam for the OS liveness probe; the default is the ESRCH check below. */
      ownerFinished?: (owner: AdvisorLockOwner) => boolean;
      /** Test seam for the owner publication that must succeed before a lock is used. */
      publishOwner?: (path: string, text: string) => Promise<void>;
    } = {},
  ) {
    this.path = path;
    this.lockRoot = `${path}.lock`;
    this.now = options.now ?? (() => Date.now());
    this.owner = options.owner ?? randomUUID();
    this.pid = options.pid ?? process.pid;
    this.isOwnerFinished = options.ownerFinished ?? AdvisorThreadJournal.ownerFinished;
    this.writeOwner =
      options.publishOwner ??
      ((ownerPath, text) => writeFile(ownerPath, text, { encoding: "utf8", mode: 0o600 }));
  }

  /** The file this journal owns; the operator-facing status reads it without taking a lock. */
  get filePath(): string {
    return this.path;
  }

  async read(
    parentKey: string,
  ): Promise<{ partition: AdvisorParentPartition; unreadable: boolean }> {
    const loaded = await readAdvisorThreads(this.path);
    return {
      partition: loaded.file.parents[parentKey] ?? { updatedAt: 0, threads: [] },
      unreadable: loaded.unreadable,
    };
  }

  /**
   * The pre-request barrier: the pending turn must already be on disk before anything is sent.
   * Reading from the file, not from memory, is the point.
   */
  async confirmPending(
    parentKey: string,
    taskToken: string,
    slot: number,
    ordinal: number,
  ): Promise<boolean> {
    const loaded = await readAdvisorThreads(this.path);
    if (loaded.unreadable) return false;
    const partition = loaded.file.parents[parentKey];
    if (!partition) return false;
    const record = findAdvisorThread(partition, taskToken, slot);
    return record !== undefined && record.state === "pending" && record.ordinal === ordinal;
  }

  /**
   * The reclamation gate as an operator sees it. `stale` and `ownerless` both mean the gate will
   * never be reclaimed automatically and must be removed by hand with every participant stopped.
   */
  async gateState(): Promise<"free" | "held" | "stale" | "ownerless" | "unreadable"> {
    const lockDir = `${this.path}.reclaim.lock`;
    try {
      await lstat(lockDir);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "unreadable";
    }
    const owner = await readLockOwner(lockDir);
    if (!owner) return "ownerless";
    return this.isOwnerFinished(owner) ? "stale" : "held";
  }

  async lockState(parentKey: string): Promise<AdvisorLockState> {
    const lockDir = join(this.lockRoot, parentKey);
    try {
      await lstat(lockDir);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { kind: "free" }
        : { kind: "unreadable" };
    }
    const owner = await readLockOwner(lockDir);
    // A lock directory without a readable owner is held by something this reader cannot trust.
    return owner ? { kind: "held", owner } : { kind: "held" };
  }

  /** True only when the recorded owner process is provably gone; a reused PID reads as alive. */
  static ownerFinished(owner: AdvisorLockOwner): boolean {
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  /**
   * Reclaim one parent lock whose owner is provably gone. Every cooperating recoverer takes the
   * global reclamation lock first and re-reads the owner inside it, so a lock another process has
   * just acquired can never be deleted by a recovery that started earlier. Without that proof the
   * answer is `unknown`, never a guess.
   */
  async releaseStaleLock(
    parentKey: string,
  ): Promise<"released" | "busy" | "unknown" | "gate-stale"> {
    const lockDir = join(this.lockRoot, parentKey);
    try {
      return await this.withReclaimLock(async () => {
        const outcome = await this.reclaimVictim(lockDir);
        if (outcome === "reclaimed") return "released";
        if (outcome === "live") return "busy";
        // Nothing was removed: the lock is either already free or it changed under us.
        try {
          await lstat(lockDir);
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ENOENT" ? "released" : "unknown";
        }
        return "unknown";
      });
    } catch (error) {
      return error instanceof AdvisorJournalError && error.code === "journal-gate-stale"
        ? "gate-stale"
        : "unknown";
    }
  }

  async exclusive<Value>(
    parentKey: string,
    run: (session: AdvisorJournalSession) => Promise<Value>,
  ): Promise<AdvisorJournalExclusiveResult<Value>> {
    const lockDir = join(this.lockRoot, parentKey);
    try {
      await mkdir(this.lockRoot, { recursive: true });
      await mkdir(lockDir);
    } catch (error) {
      return {
        ok: false,
        code:
          (error as NodeJS.ErrnoException).code === "EEXIST"
            ? "journal-busy"
            : "journal-write-failed",
      };
    }
    try {
      await this.publishOwner(lockDir);
    } catch {
      // Retire this unpublished claim once, outside the normal release scope. The same journal
      // may acquire again while rm resolves; its next claim must not reach this call's finally.
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, code: "journal-write-failed" };
    }
    try {
      const loaded = await readAdvisorThreads(this.path);
      if (loaded.unreadable) throw new AdvisorJournalError("journal-unreadable");
      let partition = loaded.file.parents[parentKey] ?? { updatedAt: 0, threads: [] };
      // One chain per group: two slots of the same group never interleave their writes.
      let queue: Promise<void> = Promise.resolve();
      const session: AdvisorJournalSession = {
        parentKey,
        partition: () => partition,
        mutate: (update) => {
          const run = queue.then(async () => {
            partition = await this.writePartition(parentKey, update);
          });
          queue = run.catch(() => undefined);
          return run;
        },
      };
      return { ok: true, value: await run(session) };
    } catch (error) {
      if (error instanceof AdvisorJournalError) return { ok: false, code: error.code };
      throw error;
    } finally {
      // Release only the lock this instance wrote: an identity that changed underneath is left
      // alone instead of being deleted by name.
      await this.releaseOwned(lockDir);
    }
  }

  /**
   * Publish this instance's owner record. A lock whose owner was never written must not be used: the
   * caller releases the directory it just created and fails closed.
   */
  private async publishOwner(lockDir: string): Promise<void> {
    await this.writeOwner(
      join(lockDir, LOCK_OWNER_FILE),
      `${JSON.stringify({ owner: this.owner, pid: this.pid, startedAt: this.now() })}\n`,
    );
  }

  /**
   * Remove one stale victim lock. Only the renamed tomb is deleted, never the original pathname, and
   * only after the owner was re-read under the gate and is still the dead one. A live or changed
   * owner is never touched.
   */
  private async reclaimVictim(lockDir: string): Promise<"reclaimed" | "live" | "changed"> {
    const owner = await readLockOwner(lockDir);
    if (!owner) return "changed";
    if (!this.isOwnerFinished(owner)) return "live";
    const tomb = `${lockDir}.stale-${this.owner}-${this.now()}`;
    try {
      await rename(lockDir, tomb);
    } catch {
      return "changed";
    }
    await rm(tomb, { recursive: true, force: true }).catch(() => undefined);
    return "reclaimed";
  }

  /** Remove a lock directory only when its owner record still names this instance. */
  private async releaseOwned(lockDir: string): Promise<void> {
    const owner = await readLockOwner(lockDir);
    if (!owner || owner.owner !== this.owner) return;
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * The single reclamation critical section. This gate is never reclaimed, renamed or unlinked by
   * another actor: a contender that finds it stale, ownerless or unreadable leaves it exactly as it
   * is and fails closed, because replacing it is what let a delayed contender move a gate another
   * one had just acquired. `mkdir` is the atomic claim, and the owner record must be published
   * before anything runs inside the section.
   */
  private async withReclaimLock<Value>(run: () => Promise<Value>): Promise<Value> {
    const lockDir = `${this.path}.reclaim.lock`;
    const deadline = this.now() + COMMIT_LOCK_WAIT_MS;
    for (;;) {
      let claimed = false;
      try {
        await mkdir(dirname(lockDir), { recursive: true });
        await mkdir(lockDir);
        claimed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new AdvisorJournalError("journal-write-failed");
      }
      if (claimed) {
        try {
          await this.publishOwner(lockDir);
        } catch {
          // Our own unpublished claim, and no cooperating actor replaces a gate.
          await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
          throw new AdvisorJournalError("journal-write-failed");
        }
        try {
          return await run();
        } finally {
          await this.releaseOwned(lockDir);
        }
      }
      const owner = await readLockOwner(lockDir);
      if (!owner || this.isOwnerFinished(owner)) {
        // Stale, ownerless or unreadable: left unchanged. Only an operator with every participant
        // stopped removes this directory.
        throw new AdvisorJournalError("journal-gate-stale");
      }
      if (this.now() >= deadline) throw new AdvisorJournalError("journal-busy");
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, COMMIT_LOCK_RETRY_MS));
    }
  }

  /**
   * Replace one parent partition in the shared file. The file is reread inside the commit lock, so
   * a write never carries another parent's stale entries, and the update always starts from the
   * freshest partition rather than from a snapshot taken before an earlier write landed.
   */
  private async writePartition(
    parentKey: string,
    update: (latest: AdvisorParentPartition) => AdvisorParentPartition,
  ): Promise<AdvisorParentPartition> {
    return this.withCommitLock(async () => {
      const loaded = await readAdvisorThreads(this.path);
      if (loaded.unreadable) throw new AdvisorJournalError("journal-unreadable");
      const latest = loaded.file.parents[parentKey] ?? { updatedAt: 0, threads: [] };
      const applied = update(latest);
      const threads = boundedRecords(applied.threads);
      if (!threads) throw new AdvisorJournalError("journal-write-failed");
      const next: AdvisorParentPartition = { updatedAt: applied.updatedAt, threads };
      const parents: Record<string, AdvisorParentPartition> = {
        ...loaded.file.parents,
        [parentKey]: next,
      };
      const keys = Object.keys(parents);
      if (keys.length > ADVISOR_THREAD_MAX_PARENTS) {
        const evictable = keys
          .filter(
            (key) =>
              key !== parentKey &&
              parents[key]!.threads.every((record) => record.state === "closed"),
          )
          .sort((left, right) => parents[left]!.updatedAt - parents[right]!.updatedAt);
        for (const key of evictable.slice(0, keys.length - ADVISOR_THREAD_MAX_PARENTS))
          delete parents[key];
      }
      const file: AdvisorThreadsFile = { schemaVersion: ADVISOR_THREADS_SCHEMA_VERSION, parents };
      try {
        await atomicWrite(this.path, `${JSON.stringify(file, null, 2)}\n`);
      } catch {
        throw new AdvisorJournalError("journal-write-failed");
      }
      return next;
    });
  }

  /**
   * The short cross-instance write lock. Unlike the per-parent group lock, this one is held for a
   * single read-modify-replace, so a waiter retries briefly instead of failing the consultation. An
   * owner that is provably gone is replaced: it can only be a crash inside a few milliseconds of
   * work, and leaving it would block every parent forever.
   */
  private async withCommitLock<Value>(run: () => Promise<Value>): Promise<Value> {
    const lockDir = `${this.path}.commit.lock`;
    const deadline = this.now() + COMMIT_LOCK_WAIT_MS;
    for (;;) {
      let claimed = false;
      try {
        await mkdir(dirname(lockDir), { recursive: true });
        await mkdir(lockDir);
        claimed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new AdvisorJournalError("journal-write-failed");
      }
      if (claimed) {
        try {
          await this.publishOwner(lockDir);
        } catch {
          await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
          throw new AdvisorJournalError("journal-write-failed");
        }
        try {
          return await run();
        } finally {
          await this.releaseOwned(lockDir);
        }
      }
      // Reclaiming the shared write lock happens only inside our own live gate, with a fresh read
      // there, and only through the renamed victim tomb.
      const outcome = await this.withReclaimLock(() => this.reclaimVictim(lockDir));
      if (outcome === "reclaimed") continue;
      if (outcome === "live") {
        if (this.now() >= deadline) throw new AdvisorJournalError("journal-busy");
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, COMMIT_LOCK_RETRY_MS));
        continue;
      }
      // The victim changed under the gate: nothing was removed, so re-read from the top.
      if (this.now() >= deadline) throw new AdvisorJournalError("journal-write-failed");
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, COMMIT_LOCK_RETRY_MS));
    }
  }
}

/** Reads a lock directory's owner record; absent or malformed means it cannot be trusted. */
async function readLockOwner(lockDir: string): Promise<AdvisorLockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(lockDir, LOCK_OWNER_FILE), "utf8"));
    if (
      isRecord(value) &&
      typeof value.owner === "string" &&
      Number.isInteger(value.pid) &&
      typeof value.startedAt === "number"
    )
      return { owner: value.owner, pid: value.pid as number, startedAt: value.startedAt };
    return undefined;
  } catch {
    return undefined;
  }
}

export type AdvisorAnswerFailure =
  | "answer-missing"
  | "answer-not-file"
  | "answer-changed"
  | "answer-outside"
  | "answer-too-large"
  | "answer-invalid-utf8"
  | "answer-empty";

export type AdvisorAnswerRead =
  { ok: true; text: string } | { ok: false; code: AdvisorAnswerFailure };

function confined(path: string, directory: string): boolean {
  const base = resolve(directory);
  const target = resolve(path);
  return target.startsWith(`${base}${sep}`);
}

/**
 * The configured agent directory is the trust anchor. Walk our descendants from there, refusing a
 * link before traversing it or creating anything below it. Read and cleanup never create paths.
 * This detects pre-existing links, not concurrent replacement by a malicious host runtime.
 */
async function canonicalOperationDirectory(
  root: string,
  operationDirectory: string,
  create = false,
): Promise<string | undefined> {
  const ownedRoot = resolve(root);
  if (!confined(operationDirectory, ownedRoot)) return undefined;
  try {
    let directory = await realpath(dirname(ownedRoot));
    const parts = [
      basename(ownedRoot),
      ...relative(ownedRoot, resolve(operationDirectory)).split(sep),
    ];
    for (const part of parts) {
      const next = join(directory, part);
      let status: Stats;
      try {
        status = await lstat(next);
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        // A sibling slot may have created this same parent after our lstat.
        try {
          await mkdir(next, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
        }
        status = await lstat(next);
      }
      if (!status.isDirectory() || status.isSymbolicLink()) return undefined;
      const canonical = await realpath(next);
      if (relative(next, canonical) !== "") return undefined;
      directory = canonical;
    }
    return directory;
  } catch {
    return undefined;
  }
}

/**
 * Reserve the per-turn answer path: the operation directory is created inside the owned tree, and
 * the file itself must not exist yet, so a leftover file can never be read as this turn's answer.
 */
export async function reserveAdvisorAnswer(
  path: string,
  operationDirectory: string,
  root: string,
): Promise<"reserved" | "occupied" | "failed" | "outside"> {
  if (!confined(path, operationDirectory)) return "failed";
  if (resolve(operationDirectory) !== resolve(dirname(path))) return "failed";
  const canonical = await canonicalOperationDirectory(root, operationDirectory, true);
  if (!canonical) return "outside";
  try {
    await lstat(path);
    return "occupied";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "reserved" : "failed";
  }
}

/**
 * Read the answer this turn owns. The path is checked against its operation directory, the file is
 * opened and then identified through the same descriptor, and the bytes are bounded before UTF-8
 * decoding: an oversized or malformed file is a closed failure, never a truncated answer.
 */
export async function readAdvisorAnswer(
  path: string,
  operationDirectory: string,
  root: string,
  maxBytes = ADVISOR_ANSWER_MAX_BYTES,
): Promise<AdvisorAnswerRead> {
  if (!confined(path, operationDirectory)) return { ok: false, code: "answer-outside" };
  if (resolve(operationDirectory) !== resolve(dirname(path)))
    return { ok: false, code: "answer-outside" };
  const canonical = await canonicalOperationDirectory(root, operationDirectory);
  if (!canonical) return { ok: false, code: "answer-outside" };
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    return {
      ok: false,
      code:
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "answer-missing" : "answer-changed",
    };
  }
  if (!before.isFile() || before.isSymbolicLink()) return { ok: false, code: "answer-not-file" };
  if (before.size > maxBytes) return { ok: false, code: "answer-too-large" };

  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return { ok: false, code: "answer-changed" };
  }
  try {
    const after = await handle.stat();
    if (!after.isFile()) return { ok: false, code: "answer-not-file" };
    // Same descriptor: a path swapped between the two calls shows up as a different identity.
    const sameIdentity =
      before.dev === after.dev && before.ino === after.ino && before.size === after.size;
    if (!sameIdentity) return { ok: false, code: "answer-changed" };
    // One byte of headroom: a file that grew past the bound is refused, never truncated.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) return { ok: false, code: "answer-too-large" };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, filled));
    } catch {
      return { ok: false, code: "answer-invalid-utf8" };
    }
    if (!text.trim()) return { ok: false, code: "answer-empty" };
    return { ok: true, text };
  } catch {
    return { ok: false, code: "answer-changed" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Remove one operation directory after its turn is settled; failures are not reported upward. */
export async function discardAdvisorAnswer(
  path: string,
  operationDirectory: string,
  root: string,
): Promise<void> {
  if (!confined(path, operationDirectory) || resolve(operationDirectory) !== resolve(dirname(path)))
    return;
  if (!(await canonicalOperationDirectory(root, operationDirectory))) return;
  await rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined);
}

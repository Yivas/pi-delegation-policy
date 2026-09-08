import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveContextShunt } from "./types.ts";

const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_SESSION_BYTES = 512 * 1024;
const MAX_ARTIFACTS = 8;
const ARTIFACT_TTL_MS = 30 * 60 * 1000;
const WINDOW_TTL_MS = 60_000;
const EXCEPTION_TTL_MS = 60_000;
const MAX_CONSUMED_EXCEPTIONS = 8;

export type ShuntDecision = { action: "allow" | "block" | "skip"; reason: string };
export type ShuntMetrics = {
  blocked: number;
  wouldBlock: number;
  boundedResults: number;
  manualOverrides: number;
  archiveFailures: number;
  uncoveredResults: number;
};
type Window = { requestedLines: number; updatedAt: number };
type Exception = { expiresAt: number; maxLines: number; maxBytes: number };
export type ConsumedException = Exception & { toolName: string; input: string };
type Clock = () => number;

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

type ReadInput = { path: string; offset?: number; limit?: number; targeted: boolean };

function readInput(value: unknown): ReadInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as { path?: unknown; offset?: unknown; limit?: unknown };
  if (typeof input.path !== "string" || !input.path) return undefined;
  if (
    input.offset !== undefined &&
    (typeof input.offset !== "number" || !Number.isSafeInteger(input.offset) || input.offset < 1)
  ) {
    return undefined;
  }
  if (input.limit !== undefined && !positiveInteger(input.limit)) return undefined;
  return {
    path: input.path,
    ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    targeted: input.offset !== undefined,
  };
}

function shellReadInput(toolName: string, value: unknown): ReadInput | undefined {
  if (!["bash", "powershell"].includes(toolName) || !value || typeof value !== "object")
    return undefined;
  const command = (value as { command?: unknown }).command;
  if (typeof command !== "string" || /[|;&><\r\n]/.test(command)) return undefined;

  const match =
    /^\s*(?:Get-Content|gc)\s+(?:-Path\s+)?(?<path>"[^"]+"|'[^']+'|\S+)(?:\s+-(?:TotalCount|First)\s+(?<limit>\d+))?\s*$/i.exec(
      command,
    );
  if (!match?.groups?.path || !match.groups.limit) return undefined;
  const limit = Number(match.groups.limit);
  return Number.isSafeInteger(limit) && positiveInteger(limit)
    ? { path: `shell:${match.groups.path}`, limit, targeted: false }
    : undefined;
}

function declaredRead(toolName: string, input: unknown): ReadInput | undefined {
  return toolName === "read" ? readInput(input) : shellReadInput(toolName, input);
}

function matchesPattern(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replaceAll("\\", "/");
  return patterns.some((pattern) => {
    const expression = pattern
      .replaceAll("\\", "/")
      .replace(/[|\\{}()[\]^$+.]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".");
    return new RegExp(`^${expression}$`).test(normalized);
  });
}

export function inputFingerprint(toolName: string, input: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(input);
    return serialized === undefined ? undefined : `${toolName}\u0000${serialized}`;
  } catch {
    return undefined;
  }
}

export class ContextShuntEngine {
  private readonly windows = new Map<string, Window>();
  private readonly exceptions = new Map<string, Exception>();
  private readonly consumed = new Map<string, ConsumedException>();
  private readonly now: Clock;
  readonly metrics: ShuntMetrics = {
    blocked: 0,
    wouldBlock: 0,
    boundedResults: 0,
    manualOverrides: 0,
    archiveFailures: 0,
    uncoveredResults: 0,
  };

  constructor(now: Clock = Date.now) {
    this.now = now;
  }

  decide(
    toolName: string,
    input: unknown,
    settings: EffectiveContextShunt,
    toolCallId?: string,
  ): ShuntDecision {
    if (settings.mode === "off") return { action: "skip", reason: "off" };

    const read = declaredRead(toolName, input);
    if (!read) return { action: "skip", reason: "unknown-contract" };

    const now = this.now();
    this.expire(now);
    const fingerprint = inputFingerprint(toolName, input);
    const exception = fingerprint ? this.exceptions.get(fingerprint) : undefined;
    if (exception && fingerprint && read.limit !== undefined) {
      this.exceptions.delete(fingerprint);
      if (exception.expiresAt > now && read.limit <= exception.maxLines && toolCallId) {
        this.consumed.delete(toolCallId);
        if (this.consumed.size >= MAX_CONSUMED_EXCEPTIONS) {
          const oldestToolCallId = this.consumed.keys().next().value;
          if (oldestToolCallId) this.consumed.delete(oldestToolCallId);
        }
        this.consumed.set(toolCallId, { ...exception, toolName, input: fingerprint });
        this.metrics.manualOverrides += 1;
        return { action: "allow", reason: "one-time-exception" };
      }
    }

    if (matchesPattern(read.path, settings.exceptionPatterns)) {
      return { action: "allow", reason: "configured-exemption" };
    }
    if (read.limit === undefined) return { action: "allow", reason: "size-unknown" };

    const lineBudget = read.targeted
      ? settings.limits.targetedReadLines
      : settings.limits.fullReadLines;
    const windowKey = `${toolName}\u0000${read.path}`;
    const previous = this.windows.get(windowKey);
    const totalLines = (previous?.requestedLines ?? 0) + read.limit;
    const excessive = read.limit > lineBudget || totalLines > settings.limits.fullReadLines;

    if (settings.mode === "observe") {
      if (excessive) {
        this.metrics.wouldBlock += 1;
        return { action: "allow", reason: "would-block-lines" };
      }
      this.windows.set(windowKey, { requestedLines: totalLines, updatedAt: now });
      return { action: "allow", reason: "declared-bounded" };
    }
    if (excessive) {
      this.metrics.blocked += 1;
      return {
        action: "block",
        reason: `${matchesPattern(read.path, settings.delegationHintPatterns) ? "delegation-hinted-" : ""}lines-exceed-budget`,
      };
    }
    this.windows.set(windowKey, { requestedLines: totalLines, updatedAt: now });
    return { action: "allow", reason: "declared-bounded" };
  }

  allowOnce(
    toolName: string,
    input: unknown,
    maxLines: number,
    maxBytes: number,
    expiresAt = this.now() + EXCEPTION_TTL_MS,
  ): boolean {
    const fingerprint = inputFingerprint(toolName, input);
    if (
      !positiveInteger(maxLines) ||
      !positiveInteger(maxBytes) ||
      !fingerprint ||
      expiresAt <= this.now()
    )
      return false;
    this.exceptions.set(fingerprint, { expiresAt, maxLines, maxBytes });
    return true;
  }

  takeConsumed(
    toolCallId: string,
    toolName: string,
    input: unknown,
  ): ConsumedException | undefined {
    const exception = this.consumed.get(toolCallId);
    this.consumed.delete(toolCallId);
    if (
      !exception ||
      exception.expiresAt <= this.now() ||
      exception.toolName !== toolName ||
      exception.input !== inputFingerprint(toolName, input)
    ) {
      return undefined;
    }
    return exception;
  }

  clearCall(toolCallId: string): void {
    this.consumed.delete(toolCallId);
  }

  clearConsumed(): void {
    this.consumed.clear();
  }

  clear(): void {
    this.windows.clear();
    this.exceptions.clear();
    this.consumed.clear();
  }

  private expire(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.updatedAt + WINDOW_TTL_MS <= now) this.windows.delete(key);
    }
    for (const [key, exception] of this.exceptions) {
      if (exception.expiresAt <= now) this.exceptions.delete(key);
    }
    for (const [key, exception] of this.consumed) {
      if (exception.expiresAt <= now) this.consumed.delete(key);
    }
  }
}

type Artifact = { path: string; bytes: number; expiresAt: number };

type Timer = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delay: number) => Timer;
type ClearTimer = (timer: Timer) => void;
type ArtifactWriter = (path: string, payload: Buffer, signal?: AbortSignal) => Promise<void>;

function isUtf8Boundary(source: Buffer, offset: number): boolean {
  if (offset < 0 || offset > source.length) return false;
  if (offset === 0 || offset === source.length) return true;
  const byte = source[offset];
  return byte !== undefined && (byte & 0b1100_0000) !== 0b1000_0000;
}

export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  const endings = /\r\n|\n|\r/g;
  for (const match of text.matchAll(endings)) {
    const end = (match.index ?? start) + match[0].length;
    lines.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length || lines.length === 0) lines.push(text.slice(start));
  return lines;
}

export type RecoveryRequest = {
  artifactId: string;
  lineOffset?: number;
  lineLimit?: number;
  byteOffset?: number;
  maxBytes?: number;
};
export type RecoveryResult = { text: string; range: string } | { error: string };

export class ArtifactStore {
  private directory: string | undefined;
  private readonly artifacts = new Map<string, Artifact>();
  private bytes = 0;
  private readonly now: Clock;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private cleanupTimer: Timer | undefined;
  private closed = false;
  private operation: Promise<void> = Promise.resolve();
  private readonly writeArtifact: ArtifactWriter;

  constructor(
    now: Clock = Date.now,
    setTimer: SetTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer: ClearTimer = (timer) => clearTimeout(timer),
    writeArtifact: ArtifactWriter = async (path, payload, signal) => {
      await writeFile(path, payload, { flag: "wx", mode: 0o600, signal });
    },
  ) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.writeArtifact = writeArtifact;
  }

  async archive(text: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.closed || signal?.aborted) return undefined;
    const payload = Buffer.from(text, "utf8");
    if (payload.byteLength > MAX_ARTIFACT_BYTES) return undefined;
    return this.withLock(async () => {
      if (this.closed || signal?.aborted) return undefined;
      await this.purgeUnlocked();
      if (
        this.artifacts.size >= MAX_ARTIFACTS ||
        this.bytes + payload.byteLength > MAX_SESSION_BYTES
      ) {
        return undefined;
      }

      try {
        this.directory ??= await mkdtemp(join(tmpdir(), "pi-delegation-policy-context-"));
      } catch {
        return undefined;
      }
      const id = randomUUID();
      const path = join(this.directory, id);
      try {
        await this.writeArtifact(path, payload, signal);
        if (this.closed || signal?.aborted) return undefined;
        this.artifacts.set(id, {
          path,
          bytes: payload.byteLength,
          expiresAt: this.now() + ARTIFACT_TTL_MS,
        });
        this.bytes += payload.byteLength;
        this.scheduleCleanup();
        return id;
      } catch {
        return undefined;
      } finally {
        if (!this.artifacts.has(id)) await rm(path, { force: true }).catch(() => undefined);
      }
    });
  }

  async recover(request: RecoveryRequest, maxRangeBytes: number): Promise<RecoveryResult> {
    return this.withLock(async () => {
      if (this.closed) return { error: "Recovery artifact is unavailable or expired." };
      const artifact = this.artifacts.get(request.artifactId);
      if (!artifact) return { error: "Recovery artifact is unavailable or expired." };

      const hasLines = request.lineOffset !== undefined || request.lineLimit !== undefined;
      const hasBytes = request.byteOffset !== undefined || request.maxBytes !== undefined;
      if (hasLines === hasBytes) return { error: "Choose either a line range or a byte range." };

      await this.purgeUnlocked();
      if (!this.artifacts.has(request.artifactId))
        return { error: "Recovery artifact is unavailable or expired." };

      let source: Buffer;
      try {
        source = await readFile(artifact.path);
      } catch {
        await this.remove(request.artifactId, artifact);
        return { error: "Recovery artifact is unavailable or expired." };
      }

      if (hasBytes) {
        const offset = request.byteOffset ?? 0;
        const length = request.maxBytes ?? maxRangeBytes;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !positiveInteger(length) ||
          length > maxRangeBytes ||
          offset > source.length ||
          offset > Number.MAX_SAFE_INTEGER - length
        ) {
          return { error: "Invalid byte range." };
        }
        const end = Math.min(source.length, offset + length);
        if (!isUtf8Boundary(source, offset) || !isUtf8Boundary(source, end)) {
          return { error: "Byte ranges must start and end at UTF-8 character boundaries." };
        }
        return {
          text: source.subarray(offset, end).toString("utf8"),
          range: `bytes ${offset}-${end}`,
        };
      }

      const offset = request.lineOffset ?? 0;
      const limit = request.lineLimit ?? 1;
      if (!Number.isSafeInteger(offset) || offset < 0 || !positiveInteger(limit) || limit > 250) {
        return { error: "Invalid line range." };
      }
      const lines = splitLines(source.toString("utf8"));
      if (offset >= lines.length) return { error: "Invalid line range." };
      const text = lines.slice(offset, offset + limit).join("");
      if (Buffer.byteLength(text, "utf8") > maxRangeBytes) {
        return { error: "Requested line range exceeds the byte budget; use byte recovery." };
      }
      return { text, range: `lines ${offset + 1}-${Math.min(lines.length, offset + limit)}` };
    });
  }

  async purge(): Promise<void> {
    if (this.closed) return;
    await this.withLock(() => this.purgeUnlocked());
  }

  private async purgeUnlocked(): Promise<void> {
    const now = this.now();
    for (const [id, artifact] of this.artifacts) {
      if (artifact.expiresAt <= now) await this.remove(id, artifact);
    }
    this.scheduleCleanup();
  }

  private scheduleCleanup(): void {
    if (this.closed || this.cleanupTimer || this.artifacts.size === 0) return;
    const nextExpiry = Math.min(
      ...[...this.artifacts.values()].map((artifact) => artifact.expiresAt),
    );
    const delay = Math.max(1, nextExpiry - this.now());
    this.cleanupTimer = this.setTimer(() => {
      this.cleanupTimer = undefined;
      void this.purge()
        .catch(() => undefined)
        .then(() => this.scheduleCleanup())
        .catch(() => undefined);
    }, delay);
    const timer = this.cleanupTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private async remove(id: string, artifact: Artifact): Promise<void> {
    this.artifacts.delete(id);
    this.bytes -= artifact.bytes;
    await rm(artifact.path, { force: true }).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.cleanupTimer) {
      this.clearTimer(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    await this.withLock(async () => {
      this.artifacts.clear();
      this.bytes = 0;
      if (this.directory)
        await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
      this.directory = undefined;
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release: (() => void) | undefined;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export function textResult(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const block = value[0] as { type?: unknown; text?: unknown };
  return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

function isJsonDocument(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export type CompactionDecision =
  | { kind: "compact"; text: string; reason: "result-exceeds-budget" | "exception-exceeds-budget" }
  | {
      kind: "skip";
      reason:
        | "off"
        | "uncovered-contract"
        | "uncovered-result"
        | "within-budget"
        | "exception-within-budget";
    };

export function shouldCompact(
  toolName: string,
  input: unknown,
  isError: unknown,
  content: unknown,
  settings: EffectiveContextShunt,
  exception?: Pick<ConsumedException, "maxLines" | "maxBytes">,
): CompactionDecision {
  if (settings.mode !== "enforce") return { kind: "skip", reason: "off" };
  if (!["read", "bash", "powershell", "grep"].includes(toolName))
    return { kind: "skip", reason: "uncovered-contract" };
  const read = declaredRead(toolName, input);
  if (!read) return { kind: "skip", reason: "uncovered-contract" };
  const text = textResult(content);
  if (isError || text === undefined || isJsonDocument(text) || text.includes("\u0000"))
    return { kind: "skip", reason: "uncovered-result" };

  const targeted = read.targeted;
  const lineBudget =
    exception?.maxLines ??
    (targeted ? settings.limits.targetedReadLines : settings.limits.fullReadLines);
  const byteBudget =
    exception?.maxBytes ??
    (targeted ? settings.limits.targetedReadBytes : settings.limits.fullReadBytes);
  if (text.length === 0) return { kind: "skip", reason: "within-budget" };
  const exceeds =
    Buffer.byteLength(text, "utf8") > byteBudget || splitLines(text).length > lineBudget;
  if (!exceeds)
    return { kind: "skip", reason: exception ? "exception-within-budget" : "within-budget" };
  return {
    kind: "compact",
    text,
    reason: exception ? "exception-exceeds-budget" : "result-exceeds-budget",
  };
}

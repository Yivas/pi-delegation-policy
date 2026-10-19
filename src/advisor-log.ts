import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getGlobalConfigPath } from "./config.ts";
import type { AdvisorContext } from "./prompt.ts";
import type { AdvisorLaunch, AdvisorMode, Intensity } from "./types.ts";

export const ADVISOR_LOG_MAX_BYTES = 256 * 1024;
const FILE_OPERATIONS = { appendFile, mkdir, rename, rm, stat };
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
export type ConsultationStatus =
  | "completed"
  | "failed"
  | "unavailable"
  | "unavailable-context"
  | "busy"
  | "cancelled"
  | "timed-out"
  | "observed";
export type ConsultationAttempt = {
  model: string;
  status: ConsultationStatus;
  context: AdvisorContext | "unknown";
  durationMs: number;
};

/** An allowlisted, content-free local record. No executor payloads or errors enter this writer. */
export class AdvisorLog {
  private lastHash: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private drainExpired = false;
  private readonly path: string;
  private readonly files: typeof FILE_OPERATIONS;

  constructor(
    path = join(dirname(getGlobalConfigPath()), "delegation-policy.events.jsonl"),
    files = FILE_OPERATIONS,
  ) {
    this.path = path;
    this.files = files;
  }

  policy(
    policy: string | undefined,
    settings: {
      intensity: Intensity;
      advisorMode: AdvisorMode;
      advisorLaunch: AdvisorLaunch;
      context: AdvisorContext;
      advisors: number;
    },
  ): void {
    if (!policy) {
      this.lastHash = undefined;
      return;
    }
    const hash = createHash("sha256").update(policy).digest("hex");
    if (hash === this.lastHash) return;
    this.lastHash = hash;
    this.enqueue({
      event: "policy",
      version: VERSION,
      hash,
      intensity: settings.intensity,
      advisorMode: settings.advisorMode,
      advisorLaunch: settings.advisorLaunch,
      context: settings.context,
      advisors: settings.advisors,
    });
  }

  consultation(mode: AdvisorLaunch, attempts: readonly ConsultationAttempt[]): void {
    if (!this.lastHash) return;
    this.enqueue({
      event: "consultation",
      version: VERSION,
      policyHash: this.lastHash,
      mode,
      models: attempts.map((attempt) => ({
        model: attempt.model.slice(0, 256),
        status: attempt.status,
        context: attempt.context,
        durationMs: Math.max(0, Math.round(attempt.durationMs)),
      })),
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Shutdown drains accepted records, but a stalled disk must not hold Pi open indefinitely.
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            // An in-flight filesystem call may finish later; do not start another one afterward.
            this.drainExpired = true;
            resolve();
          }, 5_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private enqueue(event: Record<string, unknown>): void {
    // A stalled disk cannot create an unbounded backlog or delay an LLM request.
    if (this.closed || this.pending >= 64) return;
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`;
    this.pending += 1;
    this.queue = this.queue
      .then(async () => {
        if (this.drainExpired) return;
        await this.files.mkdir(dirname(this.path), { recursive: true });
        if (this.drainExpired) return;
        const size = await this.files.stat(this.path).then(
          (info) => info.size,
          () => 0,
        );
        if (this.drainExpired) return;
        if (size + Buffer.byteLength(line, "utf8") > ADVISOR_LOG_MAX_BYTES) {
          await this.files.rm(`${this.path}.1`, { force: true });
          if (this.drainExpired) return;
          await this.files.rename(this.path, `${this.path}.1`).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        }
        if (this.drainExpired) return;
        await this.files.appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch(() => {
        // Logging is best-effort and must never turn a successful request into a failure.
      })
      .finally(() => {
        this.pending -= 1;
      });
  }
}

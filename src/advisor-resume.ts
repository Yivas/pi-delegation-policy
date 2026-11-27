import { randomUUID } from "node:crypto";
import type { AgentLaunchEventBus } from "./agent-launch.ts";
import type {
  AdvisorRunEvidence,
  AdvisorRunsSnapshot,
  AdvisorRunState,
} from "./advisor-reconcile.ts";
import { isAdvisorRunId } from "./advisor-threads.ts";

/**
 * Client for the public `pi-subagents` in-process RPC, restricted to what a continuation needs:
 * `ping` for capabilities and the announced session, `resume` for the next turn, `status` for the
 * exact terminal check, and `stop` to request cancellation.
 *
 * Nothing here reads an answer. `resume` returns a receipt, `status` returns metadata, and the
 * answer itself only ever comes from the per-turn output file this extension owns. Reply text,
 * error messages and event payloads stay out of every result and every log.
 */
export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_STATUS_SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
const ASYNC_STATUS_SNAPSHOT_VERSION = 1;
export const ADVISOR_RPC_TIMEOUT_MS = 15_000;
export const ADVISOR_STOP_TIMEOUT_MS = 5_000;

type Timer = ReturnType<typeof setTimeout>;

export type AdvisorResumeFailure =
  | "rpc-unavailable"
  | "rpc-timeout"
  | "rpc-rejected"
  | "capability-missing"
  | "session-mismatch"
  | "receipt-invalid"
  | "run-id-reused"
  | "status-unavailable"
  | "status-incomplete"
  | "status-mismatch";

export type AdvisorResumeCapability = Readonly<{ asyncCompleteEvent?: string }>;

/** What a resumed turn must still report: the inherited profile, model and thinking. */
export type AdvisorTerminalIdentity = Readonly<{
  agent: string;
  model: string;
  thinking: string;
}>;

export type AdvisorStatusVerdict =
  | { kind: "complete" }
  | { kind: "pending" }
  | { kind: "failed"; code: "status-incomplete" | "status-mismatch" };

type RpcReply =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: "rpc-unavailable" | "rpc-timeout" | "rpc-rejected" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether the host listed every run it holds. `omitted` is its own accounting of what the caps removed,
 * and an unrecognised shape is never read as whole: absence of a run may only be believed here.
 */
function isCompleteSnapshot(omitted: unknown): boolean {
  return isRecord(omitted) && omitted.runs === 0 && omitted.byteLimitExceeded === false;
}

export type AdvisorResumeClientOptions = {
  events: AgentLaunchEventBus;
  createId?: () => string;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  rpcTimeoutMs?: number;
  stopTimeoutMs?: number;
};

export class AdvisorResumeClient {
  private readonly events: AgentLaunchEventBus;
  private readonly createId: () => string;
  private readonly setTimer: (callback: () => void, delay: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly rpcTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  /** Advertised by the admitted bridge; absent until `probe` or `admitCompletion` succeeds. */
  private asyncCompleteEvent: string | undefined;
  /** Calls still waiting for a reply, so a session that ends can abandon them. */
  private readonly pending = new Set<(reply: RpcReply) => void>();

  constructor(options: AdvisorResumeClientOptions) {
    this.events = options.events;
    this.createId = options.createId ?? randomUUID;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? ADVISOR_RPC_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? ADVISOR_STOP_TIMEOUT_MS;
  }

  /**
   * Admit only what a background consultation needs: protocol 1, an advertised completion event and
   * this session. It is deliberately weaker than `probe`, which also requires `resume`, because a
   * session that cannot continue a thread can still hear an Advisor answer. Anything else fails
   * closed, and a failed admission only means no completion is heard, so the hold stands.
   *
   * Nothing waits for this answer, so its bound must not hold the process open: a host without the
   * bridge never replies, and the timer would outlive the session that asked.
   */
  async admitCompletion(sessionId: string): Promise<boolean> {
    const reply = await this.call("ping", {}, this.rpcTimeoutMs, true);
    if (!reply.ok) return false;
    const data = reply.data;
    if (data.version !== SUBAGENT_RPC_PROTOCOL_VERSION) return false;
    const events = data.events;
    if (!isRecord(events) || typeof events.asyncComplete !== "string" || !events.asyncComplete)
      return false;
    const session = data.session;
    if (!isRecord(session) || session.sessionId !== sessionId) return false;
    this.asyncCompleteEvent = events.asyncComplete;
    return true;
  }

  /**
   * Admit the installed bridge: protocol 1, `resume`, an advertised completion event and the same
   * session this extension is running in. Anything else closes the continuation path.
   */
  async probe(
    expectedSessionId: string,
  ): Promise<
    { ok: true; capability: AdvisorResumeCapability } | { ok: false; code: AdvisorResumeFailure }
  > {
    const reply = await this.call("ping", {});
    if (!reply.ok)
      return { ok: false, code: reply.code === "rpc-timeout" ? "rpc-timeout" : "rpc-unavailable" };
    const data = reply.data;
    if (data.version !== SUBAGENT_RPC_PROTOCOL_VERSION)
      return { ok: false, code: "capability-missing" };
    const capabilities = data.capabilities;
    if (!isRecord(capabilities) || capabilities.resume !== true)
      return { ok: false, code: "capability-missing" };
    const events = data.events;
    if (!isRecord(events) || typeof events.asyncComplete !== "string" || !events.asyncComplete)
      return { ok: false, code: "capability-missing" };
    const session = data.session;
    if (!isRecord(session) || session.sessionId !== expectedSessionId)
      return { ok: false, code: "session-mismatch" };
    this.asyncCompleteEvent = events.asyncComplete;
    return { ok: true, capability: { asyncCompleteEvent: events.asyncComplete } };
  }

  /**
   * Ask the host to revive the thread at `runId`. The receipt carries the new run id of this turn;
   * it is not an answer, and a repeated or previous id is refused rather than resumed twice.
   */
  async resume(input: {
    runId: string;
    message: string;
    output: string;
    knownRunIds: readonly string[];
  }): Promise<{ ok: true; runId: string } | { ok: false; code: AdvisorResumeFailure }> {
    const reply = await this.call("resume", {
      id: input.runId,
      message: input.message,
      output: input.output,
      outputMode: "file-only",
    });
    if (!reply.ok)
      return { ok: false, code: reply.code === "rpc-timeout" ? "rpc-timeout" : "rpc-unavailable" };
    const details = reply.data.details;
    if (!isRecord(details)) return { ok: false, code: "receipt-invalid" };
    const runId = details.runId;
    if (!isAdvisorRunId(runId)) return { ok: false, code: "receipt-invalid" };
    if (runId === input.runId || input.knownRunIds.includes(runId))
      return { ok: false, code: "run-id-reused" };
    return { ok: true, runId };
  }

  /** Status is queried by the exact run id of this turn, never by a parent or an older id. */
  async status(
    runId: string,
  ): Promise<
    { ok: true; node: Record<string, unknown> } | { ok: false; code: AdvisorResumeFailure }
  > {
    const reply = await this.call("status", { id: runId });
    if (!reply.ok) return { ok: false, code: "status-unavailable" };
    const snapshot = reply.data.asyncSnapshot;
    if (
      !isRecord(snapshot) ||
      snapshot.kind !== ASYNC_STATUS_SNAPSHOT_KIND ||
      snapshot.version !== ASYNC_STATUS_SNAPSHOT_VERSION ||
      !Array.isArray(snapshot.runs)
    )
      return { ok: false, code: "status-unavailable" };
    const node = snapshot.runs.find((candidate) => isRecord(candidate) && candidate.id === runId);
    return isRecord(node) ? { ok: true, node } : { ok: false, code: "status-unavailable" };
  }

  /**
   * The runs this session still holds, and whether the list is whole. It is the only question that can
   * rule out a thread whose turn never returned a receipt; a trimmed list proves nothing, so `complete`
   * is what the caller reads before closing anything.
   *
   * The untargeted `status` this depends on, and the `omitted` accounting it reads, are documented by
   * the host's extension API and were verified against the installed bridge by reading its source; no
   * admitted build has been exercised from here, so the synthetic host in the tests is the only
   * executable check of that contract.
   */
  async runs(): Promise<AdvisorRunsSnapshot> {
    const reply = await this.call("status", {});
    if (!reply.ok) return { ok: false };
    const snapshot = reply.data.asyncSnapshot;
    if (
      !isRecord(snapshot) ||
      snapshot.kind !== ASYNC_STATUS_SNAPSHOT_KIND ||
      snapshot.version !== ASYNC_STATUS_SNAPSHOT_VERSION ||
      !Array.isArray(snapshot.runs)
    )
      return { ok: false };
    const runs: AdvisorRunEvidence[] = [];
    for (const node of snapshot.runs) {
      // One node this reader cannot describe is a list it cannot vouch for, so nothing is concluded.
      if (!isRecord(node) || typeof node.label !== "string" || typeof node.state !== "string")
        return { ok: false };
      runs.push({
        label: node.label,
        state: node.state,
        ...(typeof node.startedAt === "number" ? { startedAt: node.startedAt } : {}),
      });
    }
    return { ok: true, runs, complete: isCompleteSnapshot(snapshot.omitted) };
  }

  /**
   * The state of one run, and whether the host answered about it at all. A host that answers without
   * that run is the only reading that lets absence decide; a bridge that stays silent proves nothing.
   */
  async runState(runId: string): Promise<AdvisorRunState> {
    const reply = await this.call("status", { id: runId });
    if (!reply.ok) return { ok: false, reason: "unavailable" };
    const snapshot = reply.data.asyncSnapshot;
    if (
      !isRecord(snapshot) ||
      snapshot.kind !== ASYNC_STATUS_SNAPSHOT_KIND ||
      snapshot.version !== ASYNC_STATUS_SNAPSHOT_VERSION ||
      !Array.isArray(snapshot.runs)
    )
      return { ok: false, reason: "unavailable" };
    const node = snapshot.runs.find((candidate) => isRecord(candidate) && candidate.id === runId);
    if (!isRecord(node) || typeof node.state !== "string")
      // Absence only counts in a list the host says is whole: a trimmed one may have dropped it.
      return isCompleteSnapshot(snapshot.omitted)
        ? { ok: false, reason: "unknown-run" }
        : { ok: false, reason: "unavailable" };
    return { ok: true, state: node.state };
  }

  /** A stop request acknowledges the operation, never termination: it is not proof of anything. */
  async stop(runId: string): Promise<void> {
    await this.call("stop", { id: runId }, this.stopTimeoutMs).catch(() => undefined);
  }

  /**
   * Abandon every reply this client is still waiting for, settling each as an unavailable bridge. A
   * session that ends leaves no reply listener and no timer behind for an answer nobody wants.
   */
  abortPending(): void {
    for (const finish of [...this.pending]) finish({ ok: false, code: "rpc-unavailable" });
  }

  /**
   * Wake a waiting turn when the host reports a completion. The whole payload is handed over, because
   * the caller is the one that decides what it proves; nothing here reads an answer.
   */
  onAsyncComplete(listener: (payload: unknown) => void): () => void {
    const event = this.asyncCompleteEvent;
    if (!event) return () => undefined;
    try {
      return this.events.on(event, (payload) => listener(payload));
    } catch {
      return () => undefined;
    }
  }

  private call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.rpcTimeoutMs,
    unrefTimer = false,
  ): Promise<RpcReply> {
    const requestId = this.createId();
    return new Promise<RpcReply>((resolve) => {
      let settled = false;
      const timers: Timer[] = [];
      let unsubscribe: (() => void) | undefined;
      const finish = (reply: RpcReply): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(finish);
        for (const timer of timers) this.clearTimer(timer);
        try {
          unsubscribe?.();
        } catch {
          // The reply is already decided; a broken unsubscribe cannot change it.
        }
        resolve(reply);
      };
      try {
        unsubscribe = this.events.on(`${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`, (payload) => {
          if (!isRecord(payload) || payload.requestId !== requestId) return;
          if (payload.version !== SUBAGENT_RPC_PROTOCOL_VERSION)
            return finish({ ok: false, code: "rpc-rejected" });
          if (payload.success !== true) return finish({ ok: false, code: "rpc-rejected" });
          if (!isRecord(payload.data)) return finish({ ok: false, code: "rpc-rejected" });
          finish({ ok: true, data: payload.data });
        });
      } catch {
        return finish({ ok: false, code: "rpc-unavailable" });
      }
      const expiry = this.setTimer(() => finish({ ok: false, code: "rpc-timeout" }), timeoutMs);
      if (unrefTimer) expiry.unref();
      timers.push(expiry);
      this.pending.add(finish);
      try {
        this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
          version: SUBAGENT_RPC_PROTOCOL_VERSION,
          requestId,
          method,
          params,
        });
      } catch {
        finish({ ok: false, code: "rpc-unavailable" });
      }
    });
  }
}

/**
 * Judge one status snapshot node for the exact run id of this turn: the root must be that single
 * subagent run, and it must hold exactly one completed step whose agent, model and thinking are the
 * inherited ones. A different shape is a mismatch, never a partial success.
 */
export function advisorStatusVerdict(
  node: Record<string, unknown>,
  expected: AdvisorTerminalIdentity,
): AdvisorStatusVerdict {
  if (node.kind !== "subagent") return { kind: "failed", code: "status-mismatch" };
  const state = node.state;
  if (state === "queued" || state === "running") return { kind: "pending" };
  if (state !== "complete") return { kind: "failed", code: "status-incomplete" };
  const children = node.children;
  if (!Array.isArray(children) || children.length !== 1)
    return { kind: "failed", code: "status-mismatch" };
  const step = children[0];
  if (!isRecord(step) || step.kind !== "step") return { kind: "failed", code: "status-mismatch" };
  if (step.state !== "complete") return { kind: "failed", code: "status-incomplete" };
  if (
    step.agent !== expected.agent ||
    step.model !== expected.model ||
    step.thinking !== expected.thinking
  )
    return { kind: "failed", code: "status-mismatch" };
  return { kind: "complete" };
}

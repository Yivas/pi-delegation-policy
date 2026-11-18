import { open } from "node:fs/promises";
import { getEventLogPath } from "./advisor-log.ts";
import type { LaunchChildRole } from "./launch-guard.ts";
import { ROLE_LABELS } from "./types.ts";

/**
 * Read-only view of the launch records the guard already writes. The event log is content-free and
 * best-effort, so this report is too: it exists to answer "was this role ever used?" from evidence
 * instead of memory, and never to gate or change a launch.
 */
export type LaunchCounts = {
  /** Allowed children per role code. One call can carry several children, so these exceed `allowed`. */
  byRole: Partial<Record<LaunchChildRole, number>>;
  /** Allowed calls, not children; refusals are counted apart because they launched nothing. */
  allowed: number;
  refused: number;
  /** Launch events read, including refused ones. */
  events: number;
};
/** Bounded so a large log never delays the command that shows it. */
export const LAUNCH_REPORT_MAX_BYTES = 4 * 1024 * 1024;
/**
 * The status command must not wait on a stalled mount, so a read that outlives this reports nothing.
 * An in-flight read may finish afterwards; its handle is closed in its own scope and its result is
 * ignored, the same way the log writer's own drain gives up.
 */
const LAUNCH_REPORT_TIMEOUT_MS = 2_000;
/**
 * The guard's closed role set, tied to its union so a role added there cannot be silently dropped from
 * the count here. A log line naming anything else is not evidence about a role.
 */
const ROLE_CODES = {
  small: true,
  medium: true,
  large: true,
  uiDesign: true,
  advisor: true,
  unknown: true,
} satisfies Record<LaunchChildRole, true>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One JSON object per line. A partial line from a rotated or interrupted write is skipped rather
 * than failing the report, because the log is deliberately best-effort. Role codes are filtered to
 * the guard's closed set before counting, so a hand-edited or foreign line can neither invent a code
 * nor reach the inherited members of a plain object.
 */
export function tallyLaunchLines(text: string): LaunchCounts {
  const counts: LaunchCounts = { byRole: {}, allowed: 0, refused: 0, events: 0 };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.event !== "launch") continue;
    counts.events += 1;
    if (event.outcome === "refused") {
      counts.refused += 1;
      continue;
    }
    if (event.outcome !== "allowed") continue;
    counts.allowed += 1;
    if (!Array.isArray(event.roles)) continue;
    for (const role of event.roles) {
      if (typeof role !== "string" || !Object.hasOwn(ROLE_CODES, role)) continue;
      const key = role as LaunchChildRole;
      counts.byRole[key] = (counts.byRole[key] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * The last bytes of the log, so the work is bounded rather than only its result. A cut can leave a
 * leading fragment of a line, which `tallyLaunchLines` rejects, so a cap undercounts and never
 * invents a record.
 */
async function readTailBytes(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, LAUNCH_REPORT_MAX_BYTES);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    // A single read may return fewer bytes than asked for; stop only at the end of the window.
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        length - filled,
        size - length + filled,
      );
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** A read that never completes reports nothing rather than holding the command that asked. */
async function readTail(path: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readTailBytes(path),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), LAUNCH_REPORT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The rotated predecessor first, then the current log. Sequential and oldest-first, because a
 * rotation between the two reads moves records rather than copying them: read in this order a
 * rotation can only move content this call already read.
 */
export async function readLaunchCounts(configPath?: string): Promise<LaunchCounts> {
  const path = getEventLogPath(configPath);
  const older = tallyLaunchLines(await readTail(`${path}.1`));
  const newer = tallyLaunchLines(await readTail(path));
  const byRole: LaunchCounts["byRole"] = { ...older.byRole };
  for (const [role, value] of Object.entries(newer.byRole) as [LaunchChildRole, number][]) {
    byRole[role] = (byRole[role] ?? 0) + value;
  }
  return {
    byRole,
    allowed: older.allowed + newer.allowed,
    refused: older.refused + newer.refused,
    events: older.events + newer.events,
  };
}

/** Closed label per role code; an unattributable child still gets a name. */
function roleLabel(role: LaunchChildRole): string {
  if (role === "advisor") return "Advisor";
  if (role === "unknown") return "unattributed";
  return ROLE_LABELS[role];
}

/**
 * One line per role the policy could have launched, so a configured role at zero stays visible
 * next to the roles that fired. That zero is the whole point: it is the difference between "never
 * chosen" and "never available". Roles the log records but the policy does not configure are
 * appended, and a log with no launch event states the absence of evidence instead of zeros.
 */
export function launchSummaryText(counts: LaunchCounts, roles: readonly LaunchChildRole[]): string {
  if (counts.events === 0) return "launches=none recorded";
  const listed = [...new Set(roles)];
  const seen = Object.keys(counts.byRole).filter(
    (role): role is LaunchChildRole => !listed.includes(role as LaunchChildRole),
  );
  const parts = [...listed, ...seen.sort()].map(
    (role) => `${roleLabel(role)} ${counts.byRole[role] ?? 0}`,
  );
  const totals = parts.length ? ` (${parts.join(", ")})` : "";
  const refused = counts.refused ? `; refused=${counts.refused}` : "";
  return `launches=${counts.allowed}${totals}${refused}`;
}

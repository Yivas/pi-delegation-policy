import {
  ADVISOR_ADVICE_MAX_BYTES,
  ADVISOR_QUESTION_MAX_BYTES,
  ADVISOR_TOOL_NAME,
} from "./advisor-executor.ts";

/** Hard cap for one whole advisor request: window, thread, question and extra context. */
export const ADVISOR_REQUEST_MAX_BYTES = 12 * 1024;
/** Extra context one reconstructed thread keeps before the aggregate cap applies. */
export const ADVISOR_THREAD_MAX_EXCHANGES = 6;
/** Cap for one tool action line inside the window. */
export const ADVISOR_ACTION_MAX_BYTES = 256;
/** An image block is replaced by this marker; its base64 payload is never sent. */
export const ADVISOR_IMAGE_MARKER = "[image omitted]";

/**
 * Fail-closed action allowlist: only these read-only tools name their target, and
 * only through the listed field. Every other tool contributes its name alone.
 */
export const ADVISOR_ACTION_FIELDS: ReadonlyMap<string, string> = new Map([
  ["read", "path"],
  ["grep", "pattern"],
  ["find", "pattern"],
  ["ls", "path"],
]);

export type AdvisorWindowEntry = { role: "user" | "assistant" | "action"; text: string };
export type AdvisorExchange = { question: string; advice: string };

type AdvisorTask = {
  question: string;
  context?: string;
  window: readonly AdvisorWindowEntry[];
  taskMessage: "present" | "absent";
  thread: readonly AdvisorExchange[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let kept = "";
  let used = 0;
  for (const character of text) {
    const size = byteLength(character);
    if (used + size > maxBytes - 3) break;
    kept += character;
    used += size;
  }
  return `${kept}…`;
}

function textBlocks(content: unknown, images: boolean): string {
  if (typeof content === "string") return images ? content : "";
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      parts.push(block.text);
      continue;
    }
    if (images && block.type === "image") parts.push(ADVISOR_IMAGE_MARKER);
  }
  return parts.join("\n");
}

function actionLine(call: Record<string, unknown>): string | undefined {
  try {
    const name = typeof call.name === "string" ? call.name.trim() : "";
    if (name.length === 0) return undefined;
    const field = ADVISOR_ACTION_FIELDS.get(name);
    if (!field) return truncateUtf8(name, ADVISOR_ACTION_MAX_BYTES);
    const args = call.arguments;
    const target = isRecord(args) ? args[field] : undefined;
    const line =
      typeof target === "string" && target.trim().length > 0
        ? `${name} ${field}=${target.replace(/\s+/g, " ").trim()}`
        : name;
    return truncateUtf8(line, ADVISOR_ACTION_MAX_BYTES);
  } catch {
    // A hostile tool call cannot widen the line beyond the tool name.
    const name = typeof call.name === "string" ? call.name.trim() : "";
    return name.length > 0 ? truncateUtf8(name, ADVISOR_ACTION_MAX_BYTES) : undefined;
  }
}

function messageOf(entry: unknown): Record<string, unknown> | undefined {
  if (!isRecord(entry) || entry.type !== "message") return undefined;
  return isRecord(entry.message) ? entry.message : undefined;
}

/**
 * Read-only window over the session entries: only `message` entries, only user
 * text (images become a marker) and assistant text plus one action line per tool
 * call. Tool results, shell execution, extension messages, and both summary
 * kinds are excluded, as is every non-message entry.
 */
export function readAdvisorWindow(entries: unknown): AdvisorWindowEntry[] {
  const window: AdvisorWindowEntry[] = [];
  if (!Array.isArray(entries)) return window;
  for (const entry of entries) {
    try {
      const message = messageOf(entry);
      if (!message) continue;
      if (message.role === "user") {
        const text = textBlocks(message.content, true);
        if (text.length > 0) window.push({ role: "user", text });
        continue;
      }
      if (message.role !== "assistant") continue;
      const text = textBlocks(message.content, false);
      if (text.length > 0) window.push({ role: "assistant", text });
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const line = actionLine(block);
        if (line) window.push({ role: "action", text: line });
      }
    } catch {
      // Foreign session entries cannot abort the window; they are simply skipped.
    }
  }
  return window;
}

function adviceOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    try {
      const payload: unknown = JSON.parse(block.text);
      if (
        isRecord(payload) &&
        payload.status === "advised" &&
        typeof payload.advice === "string" &&
        payload.advice.trim().length > 0
      ) {
        return truncateUtf8(payload.advice, ADVISOR_ADVICE_MAX_BYTES);
      }
    } catch {
      // A result that is not an advisor reply contributes no exchange.
    }
  }
  return undefined;
}

/**
 * Rebuilds the previous advisor exchanges from the history itself, correlating
 * each `advisor_ask` call with its result by tool call id. There is no store, so
 * the thread survives a reload.
 */
export function readAdvisorThread(entries: unknown): AdvisorExchange[] {
  const calls = new Map<string, string>();
  const order: string[] = [];
  const replies = new Map<string, string>();
  const sources = Array.isArray(entries) ? entries : [];
  for (const entry of sources) {
    try {
      const message = messageOf(entry);
      if (!message) continue;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== "toolCall" || block.name !== ADVISOR_TOOL_NAME)
            continue;
          const args = block.arguments;
          if (typeof block.id !== "string" || !isRecord(args)) continue;
          if (typeof args.question !== "string" || args.question.length === 0) continue;
          if (calls.has(block.id)) continue;
          calls.set(block.id, truncateUtf8(args.question, ADVISOR_QUESTION_MAX_BYTES));
          order.push(block.id);
        }
        continue;
      }
      if (message.role === "toolResult" && message.toolName === ADVISOR_TOOL_NAME) {
        if (typeof message.toolCallId !== "string") continue;
        const advice = adviceOf(message.content);
        if (advice !== undefined) replies.set(message.toolCallId, advice);
      }
    } catch {
      // Foreign session entries cannot abort the thread; they are simply skipped.
    }
  }

  const thread: AdvisorExchange[] = [];
  for (const id of order) {
    const advice = replies.get(id);
    const question = calls.get(id);
    if (advice === undefined || question === undefined) continue;
    thread.push({ question, advice });
  }
  return thread;
}

function renderTask(task: AdvisorTask): string {
  return JSON.stringify({
    question: task.question,
    ...(task.context ? { context: task.context } : {}),
    window: task.window,
    taskMessage: task.taskMessage,
    thread: task.thread,
  });
}

function taskMessageOf(window: readonly AdvisorWindowEntry[]): "present" | "absent" {
  return window.some((entry) => entry.role === "user") ? "present" : "absent";
}

function limitEntry(
  entry: AdvisorWindowEntry,
  availableBytes: number,
): AdvisorWindowEntry | undefined {
  const frameBytes = byteLength(JSON.stringify({ role: entry.role, text: "" })) + 1;
  const forText = availableBytes - frameBytes;
  if (forText < 4) return undefined;
  return { role: entry.role, text: truncateUtf8(entry.text, forText) };
}

/**
 * Builds the bounded request text: the window, the rebuilt thread, the question
 * and the extra context, never over the aggregate cap. The oldest window content
 * is dropped first, so a thread keeps its six newest exchanges before the window
 * loses anything. Returns undefined when even the question and the extra context
 * cannot fit; the caller reports that as a bounded invalid request.
 */
export function buildAdvisorTask(
  entries: unknown,
  question: string,
  context: string | undefined,
  maxBytes = ADVISOR_REQUEST_MAX_BYTES,
): string | undefined {
  const extra = typeof context === "string" && context.length > 0 ? context : undefined;
  const window = readAdvisorWindow(entries);
  let thread = readAdvisorThread(entries).slice(-ADVISOR_THREAD_MAX_EXCHANGES);

  const base = (): string =>
    renderTask({
      question,
      ...(extra ? { context: extra } : {}),
      window: [],
      taskMessage: "absent",
      thread,
    });
  while (thread.length > 0 && byteLength(base()) > maxBytes) thread = thread.slice(1);
  if (byteLength(base()) > maxBytes) return undefined;

  const sizes = window.map((entry) => byteLength(JSON.stringify(entry)) + 1);
  let start = window.length;
  let used = 0;
  const budget = maxBytes - byteLength(base());
  while (start > 0 && used + sizes[start - 1]! <= budget) {
    start -= 1;
    used += sizes[start]!;
  }

  let kept = window.slice(start);
  if (kept.length === 0 && window.length > 0) {
    // The newest entry alone is over the cap: keep its head instead of the whole
    // window, so the task message stays present in the bounded request.
    const limited = limitEntry(window[window.length - 1]!, budget);
    if (limited) kept = [limited];
  }

  const render = (): string =>
    renderTask({
      question,
      ...(extra ? { context: extra } : {}),
      window: kept,
      taskMessage: taskMessageOf(kept),
      thread,
    });
  let task = render();
  while (kept.length > 0 && byteLength(task) > maxBytes) {
    kept = kept.slice(1);
    task = render();
  }
  return task;
}

type RecordValue = Record<string, unknown>;

const OWNED_MARKER = "<!-- pi-delegation-policy:owned -->";
const OWNED_POLICY_BLOCK = new RegExp(
  `(?:\\n\\n)?<delegation_policy>\\n${OWNED_MARKER}[\\s\\S]*?</delegation_policy>`,
  "g",
);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Replacing a block restores the paragraph break the pattern consumes, so the text around it keeps
// the layout it had before the block was appended. The context hook applies the same criterion.
function updateText(text: string, policy: string | undefined): string {
  let replaced = false;
  const updated = text.replace(OWNED_POLICY_BLOCK, (_ownedBlock: string, offset: number) => {
    if (policy && !replaced) {
      replaced = true;
      return offset > 0 ? `\n\n${policy}` : policy;
    }
    return "";
  });
  if (!policy || replaced) return updated;
  return `${updated}${updated ? "\n\n" : ""}${policy}`;
}

function hasInstructionMessage(messages: unknown[]): boolean {
  return messages.some(
    (message) => isRecord(message) && (message.role === "system" || message.role === "developer"),
  );
}

function messageList(value: unknown): RecordValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (
    !value.every(
      (message) =>
        isRecord(message) &&
        (typeof message.role === "string" ||
          message.type === "function_call" ||
          message.type === "function_call_output" ||
          message.type === "reasoning"),
    )
  )
    return undefined;
  return value as RecordValue[];
}

function updateMessages(value: unknown, policy: string | undefined): unknown[] | undefined {
  const messages = messageList(value);
  if (!messages) return undefined;
  const updated: unknown[] = [];
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "developer") {
      updated.push(message);
      continue;
    }
    if (typeof message.content !== "string") return undefined;
    const content = updateText(message.content, policy);
    // Only an instruction message emptied by removing the owned block disappears. An empty message
    // the host sent stays untouched, and no instruction role is synthesized: the pinned adapters do
    // not all accept a role they did not send themselves.
    if (content.length === 0 && message.content.includes(OWNED_MARKER)) continue;
    updated.push(content === message.content ? message : { ...message, content });
  }
  return updated;
}

function updateTextBlocks(
  value: unknown,
  policy: string | undefined,
  kind: "anthropic" | "bedrock",
): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const validBlock = (block: unknown): block is RecordValue =>
    isRecord(block) &&
    typeof block.text === "string" &&
    (kind === "bedrock" || block.type === "text");
  if (!value.every(validBlock)) return undefined;

  let found = false;
  const blocks: RecordValue[] = [];
  for (const block of value) {
    const content = block.text as string;
    if (!content.includes(OWNED_MARKER)) {
      blocks.push(block);
      continue;
    }
    found = true;
    const text = updateText(content, policy);
    // Same rule as messages: only the block this removal emptied disappears, and untouched blocks
    // keep their metadata.
    if (text.length === 0) continue;
    blocks.push(text === content ? block : { ...block, text });
  }
  if (policy && !found) {
    blocks.push(kind === "anthropic" ? { type: "text", text: policy } : { text: policy });
  }
  return blocks;
}

function updateSystemBlocks(
  payload: RecordValue,
  policy: string | undefined,
  kind: "anthropic" | "bedrock",
): RecordValue | undefined {
  const source = Array.isArray(payload.system) ? payload.system : [];
  const system = updateTextBlocks(source, policy, kind);
  if (!system) return undefined;
  if (system.length === 0) {
    if (source.length === 0) return payload;
    // The adapter omits `system` when the prompt has no system text, so dropping the last block
    // removes the key instead of sending an empty array the provider would reject.
    const withoutSystem = { ...payload };
    delete withoutSystem.system;
    return withoutSystem;
  }
  return { ...payload, system };
}

function updateResponsesInput(value: unknown, policy: string | undefined): unknown[] | undefined {
  const messages = messageList(value);
  if (!messages) return undefined;
  return updateMessages(messages, policy);
}

/** Applies policy only to instruction fields used by the pinned Pi provider adapters. */
export function updateProviderPolicy(payload: unknown, policy: string | undefined): unknown {
  if (!isRecord(payload)) return payload;
  const candidates: Array<() => RecordValue | undefined> = [];

  // Chat-completions shapes (openai-completions, Mistral) carry the system prompt as a
  // `system`/`developer` role message. Requiring that message keeps this branch out of a shape
  // whose instruction field is absent, which would otherwise be indistinguishable from Anthropic
  // without a system prompt; such payloads stay untouched instead of being guessed.
  if (
    typeof payload.model === "string" &&
    payload.stream === true &&
    Array.isArray(payload.messages) &&
    !("system" in payload) &&
    hasInstructionMessage(payload.messages)
  ) {
    candidates.push(() => {
      const messages = updateMessages(payload.messages, policy);
      return messages ? { ...payload, messages } : undefined;
    });
  }
  if (
    typeof payload.model === "string" &&
    payload.stream === true &&
    Array.isArray(payload.input) &&
    !("instructions" in payload)
  ) {
    candidates.push(() => {
      const input = updateResponsesInput(payload.input, policy);
      return input ? { ...payload, input } : undefined;
    });
  }
  if (
    typeof payload.model === "string" &&
    payload.stream === true &&
    typeof payload.instructions === "string" &&
    payload.store === false
  ) {
    candidates.push(() => ({
      ...payload,
      instructions: updateText(payload.instructions as string, policy),
    }));
  }
  // Anthropic always sends `max_tokens` and sends its `system` text blocks whenever a system
  // prompt exists, so both keys separate it from a chat-completions payload that also happens to
  // declare `max_tokens`. Without them the shape is not recognised and the payload is left as-is.
  if (
    typeof payload.model === "string" &&
    payload.stream === true &&
    typeof payload.max_tokens === "number" &&
    Array.isArray(payload.messages) &&
    Array.isArray(payload.system)
  ) {
    candidates.push(() => updateSystemBlocks(payload, policy, "anthropic"));
  }
  if (
    typeof payload.modelId === "string" &&
    isRecord(payload.inferenceConfig) &&
    Array.isArray(payload.messages) &&
    (payload.system === undefined || Array.isArray(payload.system))
  ) {
    candidates.push(() => updateSystemBlocks(payload, policy, "bedrock"));
  }
  if (
    typeof payload.model === "string" &&
    Array.isArray(payload.contents) &&
    isRecord(payload.config) &&
    (payload.config.systemInstruction === undefined ||
      typeof payload.config.systemInstruction === "string")
  ) {
    candidates.push(() => {
      const config = payload.config as RecordValue;
      const previous = typeof config.systemInstruction === "string" ? config.systemInstruction : "";
      const systemInstruction = updateText(previous, policy);
      if (systemInstruction.length === 0 && previous.length > 0) {
        // Same rule as the instruction containers: a field this removal emptied is dropped, matching
        // an adapter that omits the key when the prompt has no system text.
        const withoutInstruction = { ...config };
        delete withoutInstruction.systemInstruction;
        return { ...payload, config: withoutInstruction };
      }
      return { ...payload, config: { ...config, systemInstruction } };
    });
  }
  if (
    typeof payload.model === "string" &&
    isRecord(payload.context) &&
    Array.isArray(payload.context.messages)
  ) {
    candidates.push(() => {
      const context = payload.context as RecordValue;
      const messages = updateMessages(context.messages, policy);
      return messages ? { ...payload, context: { ...context, messages } } : undefined;
    });
  }

  if (candidates.length !== 1) return payload;
  return candidates[0]?.() ?? payload;
}

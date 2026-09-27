import assert from "node:assert/strict";
import test from "node:test";
import { updateProviderPolicy } from "../src/provider-policy.ts";

const policy =
  "<delegation_policy>\n<!-- pi-delegation-policy:owned -->\nIntensity: normal\n</delegation_policy>";
const marker = "pi-delegation-policy:owned";

test("repairs chat and Mistral system/developer messages without changing user or tool data", () => {
  const payload = {
    model: "test",
    stream: true,
    messages: [
      { role: "system", content: "<foreign>Keep me.</foreign>" },
      { role: "user", content: "question" },
      { role: "tool", content: "tool output" },
    ],
    temperature: 0.4,
  };
  const result = updateProviderPolicy(payload, policy) as typeof payload;
  assert.match(result.messages[0]!.content, /Intensity: normal/);
  assert.match(result.messages[0]!.content, /<foreign>Keep me.<\/foreign>/);
  assert.deepEqual(result.messages.slice(1), payload.messages.slice(1));
  assert.equal(result.temperature, payload.temperature);
});

test("repairs Responses input and Codex instructions as distinct formats", () => {
  const responses = {
    model: "test",
    stream: true,
    input: [
      { role: "system", content: "base" },
      { role: "user", content: "question" },
    ],
  };
  const result = updateProviderPolicy(responses, policy) as typeof responses;
  assert.match(result.input[0]!.content, /Intensity: normal/);
  assert.deepEqual(result.input[1], responses.input[1]);

  const codex = { model: "test", stream: true, store: false, instructions: "base", input: [] };
  const codexResult = updateProviderPolicy(codex, policy) as typeof codex;
  assert.match(codexResult.instructions, /Intensity: normal/);
});

test("repairs Anthropic and Bedrock text blocks without rewriting foreign blocks", () => {
  const anthropic = {
    model: "test",
    stream: true,
    max_tokens: 32,
    system: [{ type: "text", text: "foreign", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "question" }],
  };
  const anthropicResult = updateProviderPolicy(anthropic, policy) as typeof anthropic;
  assert.deepEqual(anthropicResult.system[0], anthropic.system[0]);
  assert.equal(anthropicResult.system[1]?.text, policy);

  const bedrock = {
    modelId: "test",
    inferenceConfig: { maxTokens: 32 },
    system: [{ text: "foreign" }],
    messages: [{ role: "user", content: [{ text: "question" }] }],
  };
  const bedrockResult = updateProviderPolicy(bedrock, policy) as typeof bedrock;
  assert.deepEqual(bedrockResult.system[0], bedrock.system[0]);
  assert.equal(bedrockResult.system[1]?.text, policy);
});

test("repairs Google config and pi-messages context instruction locations", () => {
  const google = {
    model: "test",
    contents: [{ role: "user", parts: [{ text: "question" }] }],
    config: { systemInstruction: "foreign", maxOutputTokens: 20 },
  };
  const googleResult = updateProviderPolicy(google, policy) as typeof google;
  assert.match(googleResult.config.systemInstruction, /Intensity: normal/);
  assert.equal(googleResult.config.maxOutputTokens, 20);
  const googlePolicyOnly = { ...google, config: { systemInstruction: policy } };
  const googleOff = updateProviderPolicy(googlePolicyOnly, undefined) as {
    config: Record<string, unknown>;
  };
  assert.equal("systemInstruction" in googleOff.config, false);

  const piMessages = {
    model: "test",
    context: {
      messages: [
        { role: "system", content: "foreign" },
        { role: "user", content: "q" },
      ],
    },
    options: { maxTokens: 20 },
  };
  const piResult = updateProviderPolicy(piMessages, policy) as typeof piMessages;
  assert.match(piResult.context.messages[0]!.content, /Intensity: normal/);
  assert.equal(piResult.options.maxTokens, 20);
});

test("updates one owned block, removes it in off, and leaves foreign instructions alone", () => {
  const payload = {
    model: "test",
    stream: true,
    messages: [
      { role: "system", content: `foreign\n\n${policy}\n\n${policy}` },
      { role: "user", content: "question" },
    ],
  };
  const updated = updateProviderPolicy(payload, policy) as typeof payload;
  assert.equal((updated.messages[0]!.content.match(new RegExp(marker, "g")) ?? []).length, 1);
  const off = updateProviderPolicy(updated, undefined) as typeof payload;
  assert.equal(off.messages[0]!.content.includes(marker), false);
  assert.match(off.messages[0]!.content, /foreign/);
});

test("reapplies the current policy on repeated main and warm callbacks without consuming a snapshot", () => {
  const orchestratorPolicy =
    "<delegation_policy>\n<!-- pi-delegation-policy:owned -->\nIntensity: orchestrator\n</delegation_policy>";
  const tools = [{ type: "function", function: { name: "read", description: "synthetic" } }];
  type SyntheticPayload = {
    model: string;
    stream: boolean;
    messages: Array<{ role: string; content: string }>;
    tools: typeof tools;
    [callOption: string]: unknown;
  };
  const build = (callOptions: Record<string, unknown>): SyntheticPayload => ({
    model: "test",
    stream: true,
    messages: [
      { role: "system", content: "<foreign>Keep me.</foreign>" },
      { role: "user", content: "question" },
    ],
    tools,
    ...callOptions,
  });
  const markerCount = (text: string) => (text.match(new RegExp(marker, "g")) ?? []).length;

  const main = updateProviderPolicy(build({ temperature: 0.2 }), policy) as SyntheticPayload;
  // The cache warmer replays the same body through the callback after the main request.
  const warm = updateProviderPolicy(build({ max_tokens: 1 }), policy) as SyntheticPayload;
  const afterConfigChange = updateProviderPolicy(warm, orchestratorPolicy) as SyntheticPayload;

  assert.equal(markerCount(main.messages[0]!.content), 1);
  assert.match(main.messages[0]!.content, /Intensity: normal/);
  assert.match(main.messages[0]!.content, /<foreign>Keep me.<\/foreign>/);
  assert.deepEqual(main.messages.slice(1), build({}).messages.slice(1));
  assert.equal(main.temperature, 0.2);
  assert.deepEqual(main.tools, tools);

  assert.equal(markerCount(warm.messages[0]!.content), 1);
  assert.equal(warm.max_tokens, 1);
  assert.equal(markerCount(afterConfigChange.messages[0]!.content), 1);
  assert.match(afterConfigChange.messages[0]!.content, /Intensity: orchestrator/);
  assert.doesNotMatch(afterConfigChange.messages[0]!.content, /Intensity: normal/);
  assert.match(afterConfigChange.messages[0]!.content, /<foreign>Keep me.<\/foreign>/);
  assert.equal(afterConfigChange.max_tokens, 1);
  assert.deepEqual(afterConfigChange.tools, tools);

  const off = updateProviderPolicy(afterConfigChange, undefined) as SyntheticPayload;
  assert.equal(off.messages[0]!.content.includes(marker), false);
  assert.match(off.messages[0]!.content, /<foreign>Keep me.<\/foreign>/);
  assert.deepEqual(off.messages.slice(1), afterConfigChange.messages.slice(1));
  assert.equal(off.max_tokens, 1);
  assert.deepEqual(off.tools, tools);
});

test("keeps the foreign layout when the owned block follows a paragraph break", () => {
  const foreign = "<foreign>Keep me.</foreign>";
  const orchestratorPolicy =
    "<delegation_policy>\n<!-- pi-delegation-policy:owned -->\nIntensity: orchestrator\n</delegation_policy>";
  const payload = {
    model: "test",
    stream: true,
    messages: [
      { role: "system", content: `${foreign}\n\n${policy}` },
      { role: "user", content: "question" },
    ],
  };

  const updated = updateProviderPolicy(payload, orchestratorPolicy) as typeof payload;
  assert.equal(updated.messages[0]!.content, `${foreign}\n\n${orchestratorPolicy}`);
  const off = updateProviderPolicy(updated, undefined) as typeof payload;
  assert.equal(off.messages[0]!.content, foreign);
});

test("drops only the instruction containers its own removal emptied", () => {
  const foreignBlock = { type: "text", text: "foreign", cache_control: { type: "ephemeral" } };
  const anthropic = {
    model: "test",
    stream: true,
    max_tokens: 32,
    system: [foreignBlock, { type: "text", text: policy }],
    messages: [{ role: "user", content: "question" }],
  };
  const anthropicOff = updateProviderPolicy(
    updateProviderPolicy(anthropic, policy),
    undefined,
  ) as typeof anthropic;
  assert.deepEqual(anthropicOff.system, [foreignBlock]);

  const policyOnlyAnthropic = { ...anthropic, system: [{ type: "text", text: policy }] };
  const withoutSystem = updateProviderPolicy(policyOnlyAnthropic, undefined) as Record<
    string,
    unknown
  >;
  assert.equal("system" in withoutSystem, false);
  assert.deepEqual(withoutSystem.messages, policyOnlyAnthropic.messages);

  const emptyForeignBlock = { type: "text", text: "" };
  const mixedAnthropic = {
    ...anthropic,
    system: [emptyForeignBlock, { type: "text", text: policy }],
  };
  const mixedOff = updateProviderPolicy(mixedAnthropic, undefined) as typeof mixedAnthropic;
  assert.deepEqual(mixedOff.system, [emptyForeignBlock]);

  const bedrock = {
    modelId: "test",
    inferenceConfig: { maxTokens: 32 },
    system: [{ text: "foreign" }, { text: policy }],
    messages: [{ role: "user", content: [{ text: "question" }] }],
  };
  const bedrockApplied = updateProviderPolicy(bedrock, policy) as typeof bedrock;
  const bedrockOff = updateProviderPolicy(bedrockApplied, undefined) as typeof bedrock;
  assert.deepEqual(bedrockOff.system, [{ text: "foreign" }]);
  const bedrockOnlyPolicy = { ...bedrock, system: [{ text: policy }] };
  assert.equal(
    "system" in (updateProviderPolicy(bedrockOnlyPolicy, undefined) as Record<string, unknown>),
    false,
  );

  const chat = {
    model: "test",
    stream: true,
    messages: [
      { role: "system", content: "" },
      { role: "system", content: policy },
      { role: "user", content: "question" },
    ],
  };
  const chatOff = updateProviderPolicy(chat, undefined) as typeof chat;
  assert.deepEqual(chatOff.messages, [
    { role: "system", content: "" },
    { role: "user", content: "question" },
  ]);
});

test("recognizes the chat shape that also declares max_tokens", () => {
  const payload = {
    model: "test",
    stream: true,
    max_tokens: 32,
    messages: [
      { role: "system", content: "<foreign>Keep me.</foreign>" },
      { role: "user", content: "question" },
    ],
  };

  const result = updateProviderPolicy(payload, policy) as typeof payload;
  assert.equal((result.messages[0]!.content.match(new RegExp(marker, "g")) ?? []).length, 1);
  assert.match(result.messages[0]!.content, /Intensity: normal/);
  assert.match(result.messages[0]!.content, /<foreign>Keep me.<\/foreign>/);
  assert.equal(result.max_tokens, 32);
  assert.deepEqual(result.messages.slice(1), payload.messages.slice(1));
});

test("never synthesizes an instruction message the adapter did not send", () => {
  const chatWithoutInstruction = {
    model: "test",
    stream: true,
    messages: [{ role: "user", content: "question" }],
  };
  assert.equal(updateProviderPolicy(chatWithoutInstruction, policy), chatWithoutInstruction);

  const responsesWithoutInstruction = {
    model: "test",
    stream: true,
    input: [{ role: "user", content: "question" }],
  };
  const responsesResult = updateProviderPolicy(
    responsesWithoutInstruction,
    policy,
  ) as typeof responsesWithoutInstruction;
  assert.deepEqual(responsesResult.input, responsesWithoutInstruction.input);
});

test("unknown and ambiguous payloads remain unchanged", () => {
  const unknown = { model: "test", stream: true, prompt: "user content" };
  assert.equal(updateProviderPolicy(unknown, policy), unknown);
  const ambiguous = {
    model: "test",
    stream: true,
    messages: [{ role: "system", content: "base" }],
    input: [{ role: "system", content: "base" }],
  };
  assert.equal(updateProviderPolicy(ambiguous, policy), ambiguous);
});

import test from "node:test";
import { AnthropicMessagesStructuredClient } from "../src/index.ts";
import assert from "node:assert/strict";
import type { OpenAICompatibleClientOptions } from "../src/index.ts";
import {
  OpenAICompatibleStructuredClient,
  completeWithModelContract,
  ModelProviderError,
  normalizeModelOutput,
  resolveDevelopmentModelConfig,
  stripPrivateReasoning,
  structuredJsonOnly,
  sanitizeReasoningAndSecrets,
} from "../src/index.ts";

const decisionContract = {
  name: "mediobot_decision",
  description: "Propose one validated decision for MedioBot to inspect.",
  schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false },
};

test("structured transport honors explicit capability and legacy jsonMode without hidden retries", async () => {
  const cases: Array<[Partial<OpenAICompatibleClientOptions>, boolean]> = [
    [{}, true], [{ jsonMode: false }, false],
    [{ structuredOutput: "prompt-only", jsonMode: true }, false],
    [{ structuredOutput: "json-object", jsonMode: false }, true],
  ];
  for (const [options, jsonMode] of cases) {
    let calls = 0;
    const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", ...options,
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.response_format, jsonMode ? { type: "json_object" } : undefined);
        return Response.json({ choices: [{ message: { content: "private invalid output" } }] });
      } });
    await assert.rejects(client.complete({ system: "Return JSON", input: "Hi", signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof ModelProviderError);
      assert.equal(error.code, "structured-parse");
      assert.equal(error.diagnostic, undefined);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("Anthropic Messages codec assembles native tool arguments as a proposal and reports attribution metrics", async () => {
  const frames = [
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"mediobot_decision","input":{}}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\\"action\\\":\\\"inspect\\\"}"}}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];
  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) { for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame)); controller.close(); },
  });
  let sentUrl = "";
  let sentInit: RequestInit | undefined;
  const client = new AnthropicMessagesStructuredClient({ apiKey: "stub-secret", modelId: "claude-sonnet-4-6",
    protocolCapabilities: { verifiedModes: ["native-tool"] }, fetch: async (url, init) => {
      sentUrl = String(url); sentInit = init;
      return new Response(bodyStream, { headers: { "content-type": "text/event-stream" } });
    } });
  const controller = new AbortController();
  const response = await client.completeCompatible!({ system: "System", input: "Inspect.", signal: controller.signal,
    outputContract: decisionContract });
  assert.equal(sentUrl, "https://api.anthropic.com/v1/messages");
  const headers = new Headers(sentInit?.headers);
  assert.equal(headers.get("x-api-key"), "stub-secret");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  const request = JSON.parse(String(sentInit?.body));
  assert.equal(request.model, "claude-sonnet-4-6");
  assert.equal(request.tools[0].name, "mediobot_decision");
  assert.deepEqual(request.tool_choice, { type: "tool", name: "mediobot_decision", disable_parallel_tool_use: true });
  assert.deepEqual(response, { kind: "tool-call", name: "mediobot_decision", arguments: { action: "inspect" }, protocol: "native-tool",
    metrics: client.metrics(), usage: { inputTokens: 12, outputTokens: 4 } });
  assert.equal(client.metrics()?.inputTokens, 12);
});

test("Anthropic Messages codec rejects unrequested tools and respects cancellation while streaming", async () => {
  const invalidTool = new AnthropicMessagesStructuredClient({ apiKey: "stub", modelId: "claude-sonnet-4-6",
    protocolCapabilities: { verifiedModes: ["native-tool"] }, fetch: async () => Response.json({ content: [{ type: "tool_use",
      name: "filesystem.delete_everything", input: {} }], stop_reason: "tool_use" }) });
  await assert.rejects(invalidTool.completeCompatible!({ system: "", input: "", signal: new AbortController().signal,
    outputContract: decisionContract }), (error: unknown) => error instanceof ModelProviderError && error.code === "invalid-response");
  const multipleTools = new AnthropicMessagesStructuredClient({ apiKey: "stub", modelId: "claude-sonnet-4-6",
    protocolCapabilities: { verifiedModes: ["native-tool"] }, fetch: async () => Response.json({ content: [
      { type: "tool_use", name: "mediobot_decision", input: { action: "inspect" } },
      { type: "tool_use", name: "mediobot_decision", input: { action: "write" } },
    ], stop_reason: "tool_use" }) });
  await assert.rejects(multipleTools.completeCompatible!({ system: "", input: "", signal: new AbortController().signal,
    outputContract: decisionContract }), (error: unknown) => error instanceof ModelProviderError && error.code === "invalid-response");
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  const client = new AnthropicMessagesStructuredClient({ apiKey: "stub", modelId: "claude-sonnet-4-6",
    protocolCapabilities: { verifiedModes: ["native-tool"] }, fetch: async () => new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }) });
  const pending = client.completeCompatible!({ system: "", input: "", signal: controller.signal, outputContract: decisionContract });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, (error: unknown) => error instanceof ModelProviderError && error.code === "cancelled");
});

test("Anthropic strict JSON output is used only for its supported schema subset", async () => {
  let body: Record<string, any> | undefined;
  const client = new AnthropicMessagesStructuredClient({ apiKey: "stub", modelId: "claude-sonnet-4-6",
    protocolCapabilities: { verifiedModes: ["json-schema"] }, fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }], stop_reason: "end_turn" });
    } });
  const schemaContract = { name: "result", description: "structured result", preferredModes: ["json-schema"] as const,
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
  const response = await client.completeCompatible!({ system: "", input: "", signal: new AbortController().signal,
    outputContract: schemaContract });
  assert.deepEqual(body?.output_config, { format: { type: "json_schema", schema: schemaContract.schema } });
  assert.equal(response.kind, "structured");
  if (response.kind === "structured") assert.deepEqual(response.value, { ok: true });
  let called = false;
  const incompatible = new AnthropicMessagesStructuredClient({ apiKey: "stub", modelId: "claude-sonnet-4-6",
    protocolCapabilities: { verifiedModes: ["json-schema"] }, fetch: async () => { called = true; return Response.json({}); } });
  await assert.rejects(incompatible.completeCompatible!({ system: "", input: "", signal: new AbortController().signal,
    outputContract: { ...schemaContract, schema: { type: "object", oneOf: [{ type: "string" }] } } }),
  (error: unknown) => error instanceof ModelProviderError && error.code === "unsupported-modality");
  await assert.rejects(incompatible.completeCompatible!({ system: "", input: "", signal: new AbortController().signal,
    outputContract: { ...schemaContract, schema: { type: "object", properties: {}, required: ["missing"], additionalProperties: false } } }),
  (error: unknown) => error instanceof ModelProviderError && error.code === "unsupported-modality");
  assert.equal(called, false, "unsupported schemas are rejected locally without a hidden protocol downgrade");
});

test("structured transport rejects an explicitly length-truncated model response", async () => {
  let calls = 0;
  const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", fetch: async () => {
    calls++;
    return Response.json({ choices: [{ finish_reason: "length", message: { content: '{"type":"respond","message":"partial"}' } }] });
  } });
  await assert.rejects(client.complete({ system: "Return JSON", input: "Hi", signal: new AbortController().signal }),
    (error: unknown) => error instanceof ModelProviderError && error.code === "structured-parse"
      && /truncated/i.test(error.message));
  assert.equal(calls, 1, "truncation is reported without a hidden retry");
});

test("P10: sanitizeReasoningAndSecrets removes literal complete <think> reasoning", () => {
  const input = "<think>internal hidden chain of thought</think>Here is the final answer.";
  assert.equal(sanitizeReasoningAndSecrets(input), "Here is the final answer.");
});

test("P11: sanitizeReasoningAndSecrets removes escaped/unicode reasoning tags from parsed JSON", () => {
  const input = "\\u003cthink\\u003ehidden thoughts\\u003c/think\\u003eSanitized content";
  assert.equal(sanitizeReasoningAndSecrets(input), "Sanitized content");

  const literalUnicode = "\u003cthink\u003eunicode thoughts\u003c/think\u003eSafe output";
  assert.equal(sanitizeReasoningAndSecrets(literalUnicode), "Safe output");
});

test("P12: sanitizeReasoningAndSecrets preserves literal inline tokens like <think> in documentation", () => {
  const literalDoc = "Use the literal token <think> in the docs.";
  assert.equal(sanitizeReasoningAndSecrets(literalDoc), "Use the literal token <think> in the docs.");

  // Preserves legitimate math and comparison operators
  const math = "Condition: x < y and 5 > 3.";
  assert.equal(sanitizeReasoningAndSecrets(math), "Condition: x < y and 5 > 3.");
});

test("sanitizeReasoningAndSecrets removes actual reasoning block while preserving following message", () => {
  const input = "<think>secret reasoning...</think>{\"action\":\"respond\",\"message\":\"Hello\"}";
  assert.equal(sanitizeReasoningAndSecrets(input), "{\"action\":\"respond\",\"message\":\"Hello\"}");
});

test("sanitizeReasoningAndSecrets redacts Bearer tokens and API keys", () => {
  const secret = "Authorization: Bearer sk-ant-api03-abcdef1234567890.";
  assert.match(sanitizeReasoningAndSecrets(secret), /\[REDACTED/);
  assert.equal(sanitizeReasoningAndSecrets("Bearer abcdefghijklmnop"), "Bearer [REDACTED]");
});


test("stripPrivateReasoning removes complete <think> blocks and detects incomplete ones", () => {
  assert.equal(stripPrivateReasoning("<think>internal CoT</think>Clean text"), "Clean text");
  assert.equal(stripPrivateReasoning("<think>unfinished"), undefined);
  assert.equal(stripPrivateReasoning("No think tags"), "No think tags");
});

test("normalizeModelOutput separates reasoning from visible text", () => {
  const result = normalizeModelOutput("<think>deliberation</think>Hello world");
  assert.equal(result.visibleText, "Hello world");
  assert.equal(result.reasoning, "deliberation");
});

test("structuredJsonOnly extracts valid JSON object and strips markdown fences", () => {
  assert.equal(
    structuredJsonOnly("```json\n{\"type\":\"respond\",\"message\":\"hi\"}\n```"),
    '{"type":"respond","message":"hi"}',
  );
  assert.throws(
    () => structuredJsonOnly("not json"),
    (err: unknown) => err instanceof ModelProviderError && err.code === "structured-parse",
  );
});

test("structuredJsonOnly strips raw MiniMax reasoning while preserving literal <think> inside parsed JSON fields", () => {
  const rawModelOutput = '<think>secret reasoning...</think>{"action":"respond","message":"Use the literal token <think> in the docs."}';
  const extracted = structuredJsonOnly(rawModelOutput);
  assert.equal(extracted, '{"action":"respond","message":"Use the literal token <think> in the docs."}');
  const parsed = JSON.parse(extracted) as { message: string };
  assert.equal(parsed.message, "Use the literal token <think> in the docs.");
  assert.equal(sanitizeReasoningAndSecrets(parsed.message), "Use the literal token <think> in the docs.");
});

test("Reasoning Normalization A: <think>SECRET</think> before JSON yields visible Hello with SECRET absent", () => {
  const raw = '<think>SECRET</think>\n{"action":"respond","message":"Hello"}';
  const extracted = structuredJsonOnly(raw);
  assert.equal(extracted, '{"action":"respond","message":"Hello"}');
  assert.equal(extracted.includes("SECRET"), false);
  const parsed = JSON.parse(extracted) as { message: string };
  assert.equal(parsed.message, "Hello");
});

test("Reasoning Normalization B: escaped/unicode reasoning before JSON yields visible Hello with SECRET absent", () => {
  const raw = '\\u003cthink\\u003eSECRET\\u003c/think\\u003e\n{"action":"respond","message":"Hello"}';
  const extracted = structuredJsonOnly(raw);
  assert.equal(extracted, '{"action":"respond","message":"Hello"}');
  assert.equal(extracted.includes("SECRET"), false);
});

test("Reasoning Normalization C: unclosed reasoning cannot promote candidate JSON into an action", () => {
  for (const prefix of ["<think>", "&lt;think&gt;", "\\u003cthink\\u003e"]) {
    const raw = `${prefix}candidate reasoning\n{"action":"respond","message":"Hello"}`;
    assert.throws(() => structuredJsonOnly(raw),
      (error: unknown) => error instanceof ModelProviderError && error.code === "structured-parse");
  }
});

test("encoded incomplete reasoning is removed before it can leak", () => {
  for (const opening of ["&lt;think&gt;", "\\u003cthink\\u003e", "&lt;think mode='private'&gt;", "\\u003cthink mode='private'\\u003e"]) {
    assert.equal(sanitizeReasoningAndSecrets(`Safe answer. ${opening}PRIVATE reasoning`), "Safe answer.");
    assert.equal(sanitizeReasoningAndSecrets(`${opening}PRIVATE reasoning`), "");
    assert.equal(sanitizeReasoningAndSecrets(`${opening}PRIVATE reasoning</think>Safe answer.`), "Safe answer.");
  }
});

test("Reasoning Normalization D: literal token message 'Use the literal token <think> in the docs.' preserved exactly", () => {
  const msg = "Use the literal token <think> in the docs.";
  assert.equal(sanitizeReasoningAndSecrets(msg), "Use the literal token <think> in the docs.");
});

test("Reasoning Normalization E: legitimate literal reference followed by actual provider reasoning strips reasoning and preserves literal", () => {
  const msgWithClosedReasoning = "Use the literal token <think> in the docs. <think>SECRET_INTERNAL_CHAIN_OF_THOUGHT</think>";
  const cleanedClosed = sanitizeReasoningAndSecrets(msgWithClosedReasoning);
  assert.equal(cleanedClosed, "Use the literal token <think> in the docs.");
  assert.equal(cleanedClosed.includes("SECRET"), false);

  const msgWithUnclosedReasoning = "Use the literal token <think> in the docs. <think>SECRET_INTERNAL_LEAKED_CHAIN_OF_THOUGHT";
  const cleanedUnclosed = sanitizeReasoningAndSecrets(msgWithUnclosedReasoning);
  assert.equal(cleanedUnclosed, "Use the literal token <think> in the docs.");
  assert.equal(cleanedUnclosed.includes("SECRET"), false);
});

test("Reasoning Normalization F: comparison operators x < y and 5 > 3 remain unchanged", () => {
  const text = "Compare: x < y and 5 > 3.";
  assert.equal(sanitizeReasoningAndSecrets(text), "Compare: x < y and 5 > 3.");
});

test("resolveDevelopmentModelConfig provides fallback defaults", () => {
  const config = resolveDevelopmentModelConfig({});
  assert.equal(config.text.modelId, "MiniMaxAI/MiniMax-M2.7");
  assert.equal(config.vision.modelId, "google/diffusiongemma-26b-a4b-it");
  assert.equal(config.text.timeoutMs, 180_000);
});

test("provider request timeout defaults are bounded and can be configured without provider-specific settings", () => {
  const configured = resolveDevelopmentModelConfig({ MEDIOBOT_PRIMARY_TIMEOUT_MS: "240000" });
  assert.equal(configured.text.timeoutMs, 240_000);
  assert.throws(() => resolveDevelopmentModelConfig({ MEDIOBOT_PRIMARY_TIMEOUT_MS: "999999" }), /1000 to 600000/);
});

test("OpenAI-compatible model request carries canonical image parts without provider-specific UI logic", async () => {
  let sent: any;
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "test-key",
    modelId: "google/diffusiongemma-26b-a4b-it",
    fetch: (async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json({ choices: [{ message: { content: '{"type":"respond"}' } }] }); }) as typeof fetch,
  });
  assert.equal(await client.complete({ system: "Return JSON.", input: "hello", signal: new AbortController().signal,
    images: [{ mimeType: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" }] }), '{"type":"respond"}');
  assert.deepEqual(sent.messages[1].content, [
    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    { type: "text", text: "hello" },
  ]);
});

test("current text-only model seam does not send native tool schemas or decode provider tool calls", async () => {
  let sent: Record<string, unknown> | undefined;
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "test-key",
    modelId: "fixture-model",
    fetch: (async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
        content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "filesystem_read", arguments: "{\\\"path\\\":\\\"src/index.ts\\\"}" } }],
      } }] });
    }) as typeof fetch,
  });

  await assert.rejects(client.complete({ system: "Choose a safe action.", input: "Inspect the source.", signal: new AbortController().signal }),
    (error: unknown) => error instanceof ModelProviderError && error.code === "invalid-response");
  assert.equal("tools" in (sent ?? {}), false);
  assert.equal("tool_choice" in (sent ?? {}), false);
});

test("provider normalization folds system guidance into NVIDIA's documented user/assistant message contract", async () => {
  let sent: Record<string, unknown> | undefined;
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "test-key", modelId: "google/diffusiongemma-26b-a4b-it", jsonMode: false, supportsSystemRole: false,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: '{"type":"respond","message":"Hi"}' } }] });
    }) as typeof fetch,
  });
  await client.complete({ system: "Emit one JSON decision.", input: "hello", signal: new AbortController().signal });
  assert.deepEqual(sent?.messages, [{ role: "user", content: [{ type: "text", text: "Instructions:\nEmit one JSON decision.\n\nInput:\nhello" }] }]);
  assert.equal("response_format" in sent!, false);
});

test("verified native tool protocol returns one allowlisted proposal as data and preserves documented reasoning effort", async () => {
  let sent: Record<string, unknown> | undefined;
  const client = new OpenAICompatibleStructuredClient({ apiKey: "test", modelId: "fixture", stream: false,
    protocolCapabilities: { verifiedModes: ["native-tool"], reasoningParameter: "reasoning_effort", reasoningEfforts: ["medium"] },
    fetch: (async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
        { id: "call-1", type: "function", function: { name: "mediobot_decision", arguments: "{\"action\":\"inspect\"}" } },
      ] } }] });
    }) as typeof fetch,
  });
  const response = await completeWithModelContract(client, { system: "Choose a safe action.", input: "Inspect.",
    signal: new AbortController().signal, reasoningEffort: "medium", outputContract: decisionContract });
  assert.equal(response.kind, "tool-call");
  if (response.kind === "tool-call") {
    assert.equal(response.name, "mediobot_decision");
    assert.deepEqual(response.arguments, { action: "inspect" });
    assert.equal(response.protocol, "native-tool");
  }
  assert.equal(sent?.reasoning_effort, "medium");
  assert.equal((sent?.tools as Array<{ function: { name: string } }>)[0]?.function.name, "mediobot_decision");
  assert.deepEqual(sent?.tool_choice, { type: "function", function: { name: "mediobot_decision" } });
  assert.equal("execute" in response, false, "the adapter returns data and never executes the proposal");
});

test("native tool protocols can use provider-documented automatic tool choice and a versioned compatibility base path", async () => {
  let sentUrl = "";
  let sentBody: Record<string, unknown> | undefined;
  const client = new OpenAICompatibleStructuredClient({ apiKey: "test", modelId: "gemini-3.8-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", stream: false,
    protocolCapabilities: { verifiedModes: ["native-tool"], nativeToolChoice: "auto" },
    fetch: (async (url, init) => {
      sentUrl = String(url);
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [
        { id: "call-1", type: "function", function: { name: "mediobot_decision", arguments: JSON.stringify({ action: "inspect" }) } },
      ] } }] });
    }) as typeof fetch,
  });
  const response = await client.completeCompatible!({ system: "Choose one action.", input: "Inspect.",
    signal: new AbortController().signal, outputContract: decisionContract });
  assert.equal(sentUrl, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(sentBody?.tool_choice, "auto");
  assert.equal("response_format" in (sentBody ?? {}), false);
  assert.equal(response.kind, "tool-call");
  if (response.kind === "tool-call") assert.deepEqual(response.arguments, { action: "inspect" });
});

test("verified chat profiles can select the provider's completion token limit field", async () => {
  let sent: Record<string, unknown> | undefined;
  const client = new OpenAICompatibleStructuredClient({ apiKey: "test-key", modelId: "gpt-5.5", baseUrl: "https://api.openai.com/v1",
    stream: false, protocolCapabilities: { verifiedModes: ["native-tool"], tokenLimitParameter: "max_completion_tokens" },
    fetch: async (_url, init) => { sent = JSON.parse(String(init?.body)) as Record<string, unknown>; return Response.json({ choices: [{ message: { tool_calls: [{
      function: { name: decisionContract.name, arguments: JSON.stringify({ action: "inspect" }) },
    }] } }] }); } });
  const result = await client.completeCompatible!({ system: "system", input: "input", signal: new AbortController().signal, outputContract: decisionContract });
  assert.equal(sent?.max_completion_tokens, 4096);
  assert.equal("max_tokens" in sent!, false);
  assert.equal(result.kind, "tool-call");
});

test("native tool stream assembles partial arguments and refuses multiple or unknown calls", async () => {
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "mediobot_decision", arguments: "{\"action\":" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"inspect\"}" } }] }, finish_reason: "tool_calls" }] },
  ];
  const client = new OpenAICompatibleStructuredClient({ apiKey: "test", modelId: "fixture",
    protocolCapabilities: { verifiedModes: ["native-tool"] },
    fetch: (async () => new Response(new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(event(chunk)));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close();
    } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
  });
  const response = await client.completeCompatible!({ system: "", input: "", signal: new AbortController().signal, outputContract: decisionContract });
  assert.equal(response.kind, "tool-call");
  if (response.kind === "tool-call") assert.deepEqual(response.arguments, { action: "inspect" });

  for (const calls of [
    [{ name: "mediobot_decision", arguments: "{}" }, { name: "mediobot_decision", arguments: "{}" }],
    [{ name: "unregistered", arguments: "{}" }],
  ]) {
    const invalid = new OpenAICompatibleStructuredClient({ apiKey: "test", modelId: "fixture", stream: false,
      protocolCapabilities: { verifiedModes: ["native-tool"] },
      fetch: (async () => Response.json({ choices: [{ message: { tool_calls: calls.map((call, index) => ({ id: `call-${index}`,
        type: "function", function: { name: call.name, arguments: call.arguments } })) } }] })) as typeof fetch,
    });
    await assert.rejects(invalid.completeCompatible!({ system: "", input: "", signal: new AbortController().signal,
      outputContract: decisionContract }), (error: unknown) => error instanceof ModelProviderError && error.code === "invalid-response");
  }
});

test("streaming model responses enforce the same byte ceiling and abort oversized bodies", async () => {
  let requestSignal: AbortSignal | undefined;
  const oversized = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(8 * 1024 * 1024) } }] })}\n\n`);
  const client = new OpenAICompatibleStructuredClient({ apiKey: "test", modelId: "fixture",
    fetch: (async (_url, init) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(oversized); } }),
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
  await assert.rejects(client.completeCompatible!({ system: "", input: "", signal: new AbortController().signal,
    outputContract: decisionContract }), (error: unknown) => error instanceof ModelProviderError
      && error.code === "invalid-response" && /8 MiB limit/.test(error.message));
  assert.equal(requestSignal?.aborted, true, "the oversized streamed response must abort its request");
});

test("schema and JSON-object modes are selected only when exact protocol capabilities permit them", async () => {
  for (const [mode, response, expectedFormat] of [
    ["json-schema", { parsed: { action: "inspect" } }, { type: "json_schema", json_schema: { name: "mediobot_decision", strict: false, schema: decisionContract.schema } }],
    ["json-object", { content: "{\"action\":\"inspect\"}" }, { type: "json_object" }],
  ] as const) {
    let sent: Record<string, unknown> | undefined;
    const client = new OpenAICompatibleStructuredClient({ apiKey: "test", modelId: "fixture", stream: false,
      protocolCapabilities: { verifiedModes: [mode] },
      fetch: (async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json({ choices: [{ message: response }] }); }) as typeof fetch,
    });
    const value = await client.completeCompatible!({ system: "", input: "", signal: new AbortController().signal, outputContract: decisionContract });
    assert.equal(value.kind, "structured");
    assert.deepEqual(sent?.response_format, expectedFormat);
  }

  let promptRequest: Record<string, unknown> | undefined;
  const promptOnly = new OpenAICompatibleStructuredClient({ apiKey: "test", modelId: "fixture", jsonMode: true,
    protocolCapabilities: { verifiedModes: ["prompt-json"] },
    fetch: (async (_url, init) => { promptRequest = JSON.parse(String(init?.body)); return Response.json({ choices: [{ message: { content: "{\"action\":\"inspect\"}" } }] }); }) as typeof fetch,
  });
  const promptResponse = await promptOnly.completeCompatible!({ system: "", input: "", signal: new AbortController().signal, outputContract: decisionContract });
  assert.equal(promptResponse.kind, "text");
  assert.equal("response_format" in (promptRequest ?? {}), false, "verified prompt-json must not silently inherit JSON-object mode");
});

test("requested native protocol fails closed when it is not verified instead of downgrading", async () => {
  let requests = 0;
  const client = new OpenAICompatibleStructuredClient({ apiKey: "test", modelId: "fixture",
    protocolCapabilities: { verifiedModes: ["prompt-json"] }, fetch: (async () => { requests++; return Response.json({}); }) as typeof fetch });
  await assert.rejects(client.completeCompatible!({ system: "", input: "", signal: new AbortController().signal,
    outputContract: { ...decisionContract, preferredModes: ["native-tool"] } }),
  (error: unknown) => error instanceof ModelProviderError && error.code === "unsupported-modality");
  assert.equal(requests, 0);
});

test("concurrent compatible calls retain their own decoded response and usage metrics", async () => {
  const client = new OpenAICompatibleStructuredClient({ apiKey: "test", modelId: "fixture", stream: false,
    protocolCapabilities: { verifiedModes: ["json-object"] },
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> };
      const content = body.messages.find(message => message.role === "user")?.content;
      const input = Array.isArray(content) ? String((content[0] as { text?: unknown }).text) : String(content);
      if (input === "first") await new Promise(resolve => setTimeout(resolve, 15));
      const tokenCount = input === "first" ? 11 : 22;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ action: input }) } }],
        usage: { prompt_tokens: tokenCount, completion_tokens: tokenCount + 1 } });
    }) as typeof fetch,
  });
  const [first, second] = await Promise.all(["first", "second"].map(input => client.completeCompatible!({
    system: "", input, signal: new AbortController().signal, outputContract: decisionContract,
  })));
  assert.equal(first.kind, "structured");
  assert.equal(second.kind, "structured");
  if (first.kind === "structured" && second.kind === "structured") {
    assert.deepEqual(first.value, { action: "first" });
    assert.deepEqual(second.value, { action: "second" });
    assert.equal(first.usage?.inputTokens, 11);
    assert.equal(second.usage?.inputTokens, 22);
    assert.equal(first.metrics?.inputTokens, 11);
    assert.equal(second.metrics?.inputTokens, 22);
  }
});

test("OpenAI-compatible local endpoints can use configured auth headers without a fabricated bearer key", async () => {
  let sentHeaders: Headers | undefined;
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "", modelId: "local-model", jsonMode: false,
    headers: { "x-local-token": "configured-header-token" },
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return Response.json({ choices: [{ message: { content: '{"type":"respond"}' } }] });
    }) as typeof fetch,
  });
  await client.complete({ system: "Return JSON.", input: "hello", signal: new AbortController().signal });
  assert.equal(sentHeaders?.get("x-local-token"), "configured-header-token");
  assert.equal(sentHeaders?.has("authorization"), false);
});

test("structuredJsonOnly extracts first JSON object when model returns preamble text before JSON", () => {
  assert.doesNotThrow(() => structuredJsonOnly('Here is my decision: {"type":"respond","message":"Hello"}'));
  assert.doesNotThrow(() => structuredJsonOnly('Sure! {"type":"respond","message":"World"} extra'));
  assert.throws(() => structuredJsonOnly("This is not JSON at all"), (e: unknown) => e instanceof ModelProviderError && e.code === "structured-parse");
});

test("structuredJsonOnly strips complete <minimax:thought> blocks including internal code braces", () => {
  const raw = '<minimax:thought>I need to check { a, b } and write { function divide(a, b) { ... } }</minimax:thought>{"type":"write","path":"calculator.js","content":"export const x = 1;"}';
  const clean = structuredJsonOnly(raw);
  assert.equal(clean, '{"type":"write","path":"calculator.js","content":"export const x = 1;"}');
  const parsed = JSON.parse(clean) as { type: string; path: string };
  assert.equal(parsed.type, "write");
  assert.equal(parsed.path, "calculator.js");
});

test("structuredJsonOnly parses multiline code in JSON strings with literal unescaped newlines", () => {
  const raw = '{"type":"write","path":"calculator.js","content":"function divide(a, b) {\n  if (b === 0) return Infinity;\n  return a / b;\n}"}';
  const clean = structuredJsonOnly(raw);
  const parsed = JSON.parse(clean) as { content: string };
  assert.match(parsed.content, /function divide\(a, b\)/);
  assert.match(parsed.content, /return Infinity;/);
});


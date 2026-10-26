import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAICompatibleStructuredClient,
  ModelProviderError,
  type ModelOutputContract,
  type ModelEmptyResponseDiagnostic,
} from "../src/index.ts";

const decisionContract: ModelOutputContract = {
  name: "mediobot_decision",
  description: "MedioBot decision contract",
  schema: {
    type: "object",
    properties: {
      action: { type: "string" },
    },
    required: ["action"],
  },
};

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

function sseResponse(chunks: unknown[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(event(chunk)));
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}

test("empty model response: blank streaming and non-streaming response attaches sanitized diagnostic", async () => {
  // 1. Streaming blank
  const streamClient = new OpenAICompatibleStructuredClient({
    apiKey: "secret-key-12345",
    modelId: "test-model-stream",
    stream: true,
    fetch: async () => sseResponse([
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]),
  });

  await assert.rejects(
    streamClient.complete({ system: "system", input: "input", signal: new AbortController().signal }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "invalid-response");
      assert.match(err.message, /no structured content/i);
      assert.doesNotMatch(err.message, /secret-key/);

      const diag = err.diagnostic as ModelEmptyResponseDiagnostic;
      assert.ok(diag, "diagnostic must be attached");
      assert.equal(diag.modelId, "test-model-stream");
      assert.equal(diag.parseOutcome, "blank");
      assert.equal(diag.contentCharacterCount, 0);
      assert.equal(diag.reasoningCharacterCount, 0);
      assert.equal(diag.finishReason, "stop");
      assert.equal(diag.httpStatus, 200);
      assert.equal(typeof diag.durationMs, "number");
      // Verify no leaked credentials in diagnostic
      assert.equal(JSON.stringify(diag).includes("secret-key"), false);
      return true;
    }
  );

  // 2. Non-streaming blank
  const nonStreamClient = new OpenAICompatibleStructuredClient({
    apiKey: "secret-key-12345",
    modelId: "test-model-nonstream",
    stream: false,
    fetch: async () => Response.json({
      choices: [{ message: { content: "   " }, finish_reason: "stop" }],
    }),
  });

  await assert.rejects(
    nonStreamClient.complete({ system: "system", input: "input", signal: new AbortController().signal }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "invalid-response");
      const diag = err.diagnostic as ModelEmptyResponseDiagnostic;
      assert.ok(diag);
      assert.equal(diag.modelId, "test-model-nonstream");
      assert.equal(diag.parseOutcome, "blank");
      assert.equal(diag.contentCharacterCount, 3);
      assert.equal(diag.reasoningCharacterCount, 0);
      assert.equal(diag.finishReason, "stop");
      return true;
    }
  );
});

test("empty model response: reasoning-only response classified as reasoning-only without leaking reasoning text", async () => {
  const secretReasoning = "PRIVATE_THINKING_TOKEN_xyz987: We should secretly delete everything";

  // 1. Streaming delta.reasoning_content
  const streamClient = new OpenAICompatibleStructuredClient({
    apiKey: "secret-key",
    modelId: "deepseek-r1",
    stream: true,
    fetch: async () => sseResponse([
      { choices: [{ delta: { reasoning_content: secretReasoning }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]),
  });

  await assert.rejects(
    streamClient.complete({ system: "system", input: "input", signal: new AbortController().signal }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "invalid-response");
      assert.match(err.message, /no structured content/i);
      // Ensure private reasoning is NOT in error message
      assert.doesNotMatch(err.message, /PRIVATE_THINKING_TOKEN/);

      const diag = err.diagnostic as ModelEmptyResponseDiagnostic;
      assert.ok(diag);
      assert.equal(diag.parseOutcome, "reasoning-only");
      assert.equal(diag.contentCharacterCount, 0);
      assert.equal(diag.reasoningCharacterCount, secretReasoning.length);
      // Ensure private reasoning text is NOT leaked in diagnostic
      assert.equal(JSON.stringify(diag).includes("PRIVATE_THINKING_TOKEN"), false);
      return true;
    }
  );

  // 2. Non-streaming message.reasoning_content
  const nonStreamClient = new OpenAICompatibleStructuredClient({
    apiKey: "secret-key",
    modelId: "deepseek-r1-nonstream",
    stream: false,
    fetch: async () => Response.json({
      choices: [{
        message: { content: "", reasoning_content: secretReasoning },
        finish_reason: "stop",
      }],
    }),
  });

  await assert.rejects(
    nonStreamClient.complete({ system: "system", input: "input", signal: new AbortController().signal }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "invalid-response");
      assert.doesNotMatch(err.message, /PRIVATE_THINKING_TOKEN/);

      const diag = err.diagnostic as ModelEmptyResponseDiagnostic;
      assert.ok(diag);
      assert.equal(diag.parseOutcome, "reasoning-only");
      assert.equal(diag.contentCharacterCount, 0);
      assert.equal(diag.reasoningCharacterCount, secretReasoning.length);
      assert.equal(JSON.stringify(diag).includes("PRIVATE_THINKING_TOKEN"), false);
      return true;
    }
  );

  // 3. Inline <think> tags only without any actual JSON content
  const inlineThinkClient = new OpenAICompatibleStructuredClient({
    apiKey: "secret-key",
    modelId: "qwen-reasoning",
    stream: false,
    fetch: async () => Response.json({
      choices: [{
        message: { content: `<think>${secretReasoning}</think>` },
        finish_reason: "stop",
      }],
    }),
  });

  await assert.rejects(
    inlineThinkClient.complete({ system: "system", input: "input", signal: new AbortController().signal }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.doesNotMatch(err.message, /PRIVATE_THINKING_TOKEN/);
      const diag = err.diagnostic as ModelEmptyResponseDiagnostic;
      assert.ok(diag);
      assert.equal(diag.parseOutcome, "reasoning-only");
      assert.equal(diag.contentCharacterCount, 0);
      assert.equal(JSON.stringify(diag).includes("PRIVATE_THINKING_TOKEN"), false);
      return true;
    }
  );
});

test("empty model response: content_filter classified as content-filtered", async () => {
  // Non-streaming content_filter
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "key",
    modelId: "filtered-model",
    stream: false,
    fetch: async () => Response.json({
      choices: [{
        message: { content: null },
        finish_reason: "content_filter",
      }],
    }),
  });

  await assert.rejects(
    client.complete({ system: "system", input: "input", signal: new AbortController().signal }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "invalid-response");
      const diag = err.diagnostic as ModelEmptyResponseDiagnostic;
      assert.ok(diag);
      assert.equal(diag.parseOutcome, "content-filtered");
      assert.equal(diag.finishReason, "content_filter");
      assert.equal(diag.contentCharacterCount, 0);
      return true;
    }
  );
});

test("empty model response: length truncation classified as length-truncated", async () => {
  // Streaming length truncation
  const streamClient = new OpenAICompatibleStructuredClient({
    apiKey: "key",
    modelId: "truncated-model",
    stream: true,
    fetch: async () => sseResponse([
      { choices: [{ delta: { content: '{"partial":' }, finish_reason: "length" }] },
    ]),
  });

  await assert.rejects(
    streamClient.complete({ system: "system", input: "input", signal: new AbortController().signal }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "structured-parse");
      assert.match(err.message, /truncated/i);
      const diag = err.diagnostic as ModelEmptyResponseDiagnostic;
      assert.ok(diag);
      assert.equal(diag.parseOutcome, "length-truncated");
      assert.equal(diag.finishReason, "length");
      assert.equal(diag.contentCharacterCount, 11);
      return true;
    }
  );

  // Non-streaming length truncation
  const nonStreamClient = new OpenAICompatibleStructuredClient({
    apiKey: "key",
    modelId: "truncated-model",
    stream: false,
    fetch: async () => Response.json({
      choices: [{
        message: { content: '{"partial":' },
        finish_reason: "length",
      }],
    }),
  });

  await assert.rejects(
    nonStreamClient.complete({ system: "system", input: "input", signal: new AbortController().signal }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "structured-parse");
      assert.match(err.message, /truncated/i);
      const diag = err.diagnostic as ModelEmptyResponseDiagnostic;
      assert.ok(diag);
      assert.equal(diag.parseOutcome, "length-truncated");
      assert.equal(diag.finishReason, "length");
      return true;
    }
  );
});

test("empty model response: native-tool mode with 0 calls classified as blank with diagnostic", async () => {
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "key",
    modelId: "native-tool-model",
    stream: false,
    protocolCapabilities: { verifiedModes: ["native-tool"] },
    fetch: async () => Response.json({
      choices: [{
        message: { content: null, tool_calls: [] },
        finish_reason: "stop",
      }],
    }),
  });

  await assert.rejects(
    client.completeCompatible!({
      system: "system",
      input: "input",
      signal: new AbortController().signal,
      outputContract: decisionContract,
    }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "invalid-response");
      const diag = err.diagnostic as ModelEmptyResponseDiagnostic;
      assert.ok(diag);
      assert.equal(diag.parseOutcome, "blank");
      assert.equal(diag.toolCallCount, 0);
      return true;
    }
  );
});

test("valid content-null with native tool calls succeeds without throwing empty-response error", async () => {
  // Non-streaming content: null with tool_calls
  const nonStreamClient = new OpenAICompatibleStructuredClient({
    apiKey: "key",
    modelId: "tool-model",
    stream: false,
    protocolCapabilities: { verifiedModes: ["native-tool"] },
    fetch: async () => Response.json({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "mediobot_decision", arguments: JSON.stringify({ action: "inspect" }) },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }),
  });

  const nonStreamRes = await nonStreamClient.completeCompatible!({
    system: "system",
    input: "input",
    signal: new AbortController().signal,
    outputContract: decisionContract,
  });
  assert.equal(nonStreamRes.kind, "tool-call");
  if (nonStreamRes.kind === "tool-call") {
    assert.deepEqual(nonStreamRes.arguments, { action: "inspect" });
  }

  // Streaming content: null with streamed tool_calls
  const streamClient = new OpenAICompatibleStructuredClient({
    apiKey: "key",
    modelId: "tool-model",
    stream: true,
    protocolCapabilities: { verifiedModes: ["native-tool"] },
    fetch: async () => sseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "mediobot_decision", arguments: "{\"action\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"inspect\"}" } }] }, finish_reason: "tool_calls" }] },
    ]),
  });

  const streamRes = await streamClient.completeCompatible!({
    system: "system",
    input: "input",
    signal: new AbortController().signal,
    outputContract: decisionContract,
  });
  assert.equal(streamRes.kind, "tool-call");
  if (streamRes.kind === "tool-call") {
    assert.deepEqual(streamRes.arguments, { action: "inspect" });
  }
});

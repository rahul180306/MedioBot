import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeFinishReason,
  sanitizeIdentifier,
  ModelProviderError,
} from "../src/index.ts";

describe("P2 Diagnostics Sanitization & Retention - Models", () => {
  it("sanitizes known finish reasons and maps hostile or unknown reasons to 'other'", () => {
    // Allowed values
    assert.equal(sanitizeFinishReason("stop"), "stop");
    assert.equal(sanitizeFinishReason("length"), "length");
    assert.equal(sanitizeFinishReason("content_filter"), "content_filter");
    assert.equal(sanitizeFinishReason("tool_calls"), "tool_calls");
    assert.equal(sanitizeFinishReason("function_call"), "function_call");
    assert.equal(sanitizeFinishReason("timeout"), "timeout");
    assert.equal(sanitizeFinishReason("error"), "error");
    assert.equal(sanitizeFinishReason("cancelled"), "cancelled");

    // Case normalization
    assert.equal(sanitizeFinishReason("STOP"), "stop");
    assert.equal(sanitizeFinishReason("  Length  "), "length");

    // Hostile or unexpected strings must map to "other" and never appear verbatim
    assert.equal(sanitizeFinishReason("<script>alert(1)</script>"), "other");
    assert.equal(sanitizeFinishReason("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret"), "other");
    assert.equal(sanitizeFinishReason("A".repeat(50_000)), "other");
    assert.equal(sanitizeFinishReason({ malicious: true }), "other");
    assert.equal(sanitizeFinishReason(12345), "other");

    // Null/undefined preserved as undefined
    assert.equal(sanitizeFinishReason(null), undefined);
    assert.equal(sanitizeFinishReason(undefined), undefined);
  });

  it("sanitizes and caps identifiers to prevent hostile payloads or metadata leaks", () => {
    assert.equal(sanitizeIdentifier("gpt-4o-mini"), "gpt-4o-mini");
    assert.equal(sanitizeIdentifier("claude-3-5-sonnet@20241022"), "claude-3-5-sonnet_20241022");
    assert.equal(sanitizeIdentifier("openai-compatible"), "openai-compatible");

    // Hostile characters sanitized
    assert.equal(sanitizeIdentifier("<script>"), "_script_");
    assert.equal(sanitizeIdentifier("model/with/slashes"), "model_with_slashes");
    assert.equal(sanitizeIdentifier("key=secret;drop table"), "key_secret_drop_table");

    // Length capped to maxLength
    const hugeId = "a".repeat(200);
    assert.equal(sanitizeIdentifier(hugeId, 80).length, 80);
    assert.equal(sanitizeIdentifier(hugeId, 40).length, 40);

    // Null/undefined
    assert.equal(sanitizeIdentifier(null), "");
    assert.equal(sanitizeIdentifier(undefined), "");
  });

  it("attaches strictly sanitized diagnostics to ModelProviderError", () => {
    const error = new ModelProviderError("structured-parse", "Failed to parse structured output", {
      phase: "body",
      elapsedMs: 250,
      timeoutMs: 5000,
      ttfbMs: 120,
      ttftMs: 180,
      parseOutcome: "malformed",
      finishReason: sanitizeFinishReason("<script>alert('pwn')</script>"),
      modelId: sanitizeIdentifier("model/malicious/id/1234567890".repeat(5), 80),
      contentCharacterCount: 42,
      reasoningCharacterCount: 150,
      toolCallCount: 0,
      httpStatus: 200,
    });

    const diag = error.diagnostic as any;
    assert.equal(diag.finishReason, "other");
    assert.ok(!JSON.stringify(diag).includes("<script>"));
    assert.ok(diag.modelId.length <= 80);
    assert.ok(!diag.modelId.includes("/"));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CodyDecisionProvider, type CodyDecisionDiagnostic } from "../src/index.ts";
import { ModelProviderError } from "@mediobot-v2/models";

describe("P2 Diagnostics - Cody Error Boundary", () => {
  it("retains bounded diagnostic fields through Cody failure boundary without leaking prompts or secrets", async () => {
    const reportedDiagnostics: CodyDecisionDiagnostic[] = [];

    const mockModelClient: any = {
      complete: async () => {
        throw new ModelProviderError("structured-parse", "Failed to parse structured output", {
          phase: "body",
          elapsedMs: 250,
          timeoutMs: 5000,
          ttfbMs: 120,
          ttftMs: 180,
          parseOutcome: "malformed",
          finishReason: "length",
          contentCharacterCount: 42,
          reasoningCharacterCount: 150,
          toolCallCount: 0,
          httpStatus: 200,
          prompt: "SECRET_USER_PROMPT_12345",
          rawContent: "SECRET_RAW_CONTENT_67890",
          reasoning: "SECRET_INTERNAL_REASONING_CHAIN",
          authorization: "Bearer secret_api_key_xyz",
        });
      },
    };

    const provider = new CodyDecisionProvider(
      mockModelClient,
      (diag) => {
        reportedDiagnostics.push(diag);
      }
    );

    await assert.rejects(
      () => provider.decide("Test goal with SECRET_PROMPT", [], new AbortController().signal),
      /Cody could not produce a valid structured tool decision/
    );

    assert.ok(reportedDiagnostics.length > 0, "Expected diagnostics to be reported");
    const diagnostic = reportedDiagnostics[0]!;

    assert.equal(diagnostic.stage, "decision-parse");
    assert.equal(diagnostic.category, "provider-structured-parse");
    assert.equal(diagnostic.code, "structured-parse");

    const serialized = JSON.stringify(reportedDiagnostics);
    assert.ok(!serialized.includes("SECRET_USER_PROMPT_12345"), "Prompts must never leak into diagnostics");
    assert.ok(!serialized.includes("SECRET_RAW_CONTENT_67890"), "Raw content must never leak into diagnostics");
    assert.ok(!serialized.includes("SECRET_INTERNAL_REASONING_CHAIN"), "Internal reasoning must never leak into diagnostics");
    assert.ok(!serialized.includes("secret_api_key_xyz"), "Credentials must never leak into diagnostics");
  });
});

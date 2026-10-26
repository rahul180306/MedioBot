import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MaestroDecisionProvider, type MaestroDecisionDiagnostic } from "../src/index.ts";
import { ModelProviderError } from "@mediobot-v2/models";

describe("P2 Diagnostics - Maestro Error Boundary", () => {
  it("retains bounded diagnostic fields through Maestro failure boundary without leaking prompts or secrets", async () => {
    const reportedDiagnostics: MaestroDecisionDiagnostic[] = [];

    const mockMaestroModel: any = {
      complete: async () => {
        throw new ModelProviderError("transport", "Transport connection reset", {
          phase: "body",
          elapsedMs: 310,
          timeoutMs: 10000,
          ttfbMs: 150,
          ttftMs: 220,
          parseOutcome: "interrupted",
          finishReason: "stop",
          contentCharacterCount: 120,
          reasoningCharacterCount: 400,
          toolCallCount: 1,
          httpStatus: 502,
          apiKey: "sk-super-secret-key-9999",
          rawPrompt: "CLASSIFIED_PROJECT_SPECS",
        });
      },
    };

    const provider = new MaestroDecisionProvider(
      mockMaestroModel,
      (diag) => {
        reportedDiagnostics.push(diag);
      }
    );

    await assert.rejects(
      () => provider.decide("Coordinate secret tasks", { goal: "Coordinate secret tasks", history: [] as any, projectIntelligence: [] as any }, new AbortController().signal),
      /Transport connection reset/
    );

    assert.ok(reportedDiagnostics.length > 0, "Expected Maestro diagnostics to be recorded");
    const failDiag = reportedDiagnostics.find((d) => d.stage === "model-failed");
    assert.ok(failDiag, "Expected model-failed diagnostic");
    assert.ok(failDiag.transportFailure, "Expected transportFailure details");

    assert.equal(failDiag.transportFailure.code, "transport");
    assert.equal(failDiag.transportFailure.phase, "body");
    assert.equal(failDiag.transportFailure.elapsedMs, 310);
    assert.equal(failDiag.transportFailure.parseOutcome, "interrupted");
    assert.equal(failDiag.transportFailure.finishReason, "stop");
    assert.equal(failDiag.transportFailure.contentCharacterCount, 120);
    assert.equal(failDiag.transportFailure.reasoningCharacterCount, 400);
    assert.equal(failDiag.transportFailure.toolCallCount, 1);
    assert.equal(failDiag.transportFailure.httpStatus, 502);

    const serialized = JSON.stringify(reportedDiagnostics);
    assert.ok(!serialized.includes("sk-super-secret-key-9999"), "API keys must never leak");
    assert.ok(!serialized.includes("CLASSIFIED_PROJECT_SPECS"), "Prompts must never leak");
  });
});

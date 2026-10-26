import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createComposition } from "../../src/composition.ts";
import { ModelProviderError, ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { assertNonProductionDatabase, getProductionDatabasePath } from "../../src/storage/appPaths.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";

/**
 * From apps/command-center:
 * MEDIOBOT_LIVE_MAESTRO=1 MEDIOBOT_ALLOW_PROD_DB=1 node --experimental-strip-types --test tests/runtime/maestro-configured-acceptance.test.ts
 * MEDIOBOT_DATA_DIR selects an existing alternate application store, as in the app.
 * Uses read-only SQLite rather than LocalDatabase's write/migration startup.
 * No environment bootstrap, provider overrides, credential copying, or task execution.
 * Missing configuration and provider availability failures are skips, never passes.
 */
test("configured Maestro semantic acceptance", {
  skip: process.env.MEDIOBOT_LIVE_MAESTRO !== "1" ? "live-opt-in-required" : false,
}, async (t) => {
  const databasePath = process.env.MEDIOBOT_DATA_DIR?.trim()
    ? path.join(path.resolve(process.env.MEDIOBOT_DATA_DIR.trim()), "mediobot.db")
    : getProductionDatabasePath();
  let db: DatabaseSync;
  try {
    assertNonProductionDatabase(databasePath);
  } catch {
    t.skip("application-store-access-not-opted-in");
    return;
  }
  if (!existsSync(databasePath)) {
    t.skip("application-store-missing");
    return;
  }
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    t.skip("application-store-unavailable");
    return;
  }
  t.after(() => db.close());
  const resolver = new ModelResolver(new ProviderRepository(db));
  let descriptor: ReturnType<ModelResolver["resolveTextClient"]>["descriptor"];
  try {
    descriptor = resolver.resolveTextClient().descriptor;
  } catch (error) {
    if (error instanceof ModelProviderError) {
      t.skip(`registry-unavailable:${safeCategory(error)}`);
      return;
    }
    // Never expose database rows, exception messages, or provider payloads.
    throw new Error("application-registry-read-failed");
  }
  const modelSelection = { providerConnectionId: descriptor.providerId, modelId: descriptor.modelId };
  const cases = [
    { category: "greeting", goal: "Hi", expected: "respond" },
    { category: "explanation", goal: "Explain Python closures simply", expected: "respond" },
    { category: "underspecified-action", goal: "Change it to the other one.", expected: "request_user_input" },
    { category: "concrete-coding", goal: "In the selected acceptance-fixture TypeScript project, create src/math.ts exporting add(a: number, b: number): number that returns a + b, add tests for positive and negative inputs in tests/math.test.ts using node:test, and run those tests.", expected: "delegate" },
  ] as const;
  for (const scenario of cases) {
    await t.test(scenario.category, async (s) => {
      const composition = createComposition({ modelResolver: resolver });
      assert.ok(composition.world.inspect().definitions.some((d) => d.id === composition.codyDefinitionId), "cody-available");
      const start = performance.now();
      let outcome = "failed";
      let category = "runtime-failure";
      try {
        const decision = await composition.decideMaestroTurn!(scenario.goal,
          { modelSelection, projectName: "acceptance-fixture" }, AbortSignal.timeout(90_000));
        category = ["respond", "request_user_input", "delegate", "acquire_context", "use_capability"].includes(decision.type)
          ? decision.type : "unknown-intent";
        // Boolean assertions prevent the runner from printing model-generated text.
        assert.ok(decision.type === scenario.expected, "semantic-intent-mismatch");
        if (decision.type === "delegate") {
          assert.ok(decision.definitionId === composition.codyDefinitionId, "delegation-target-mismatch");
        }
        outcome = "passed";
      } catch (error) {
        if (error instanceof ModelProviderError && ["configuration", "authentication", "capacity", "transport", "timeout", "cancelled"].includes(error.code)) {
          category = safeCategory(error);
          outcome = "skipped";
          s.skip(`provider-unavailable:${category}`);
        } else {
          // Structural/semantic model failures must fail acceptance, not skip.
          throw new Error(category === "runtime-failure" ? "decision-failed" : "semantic-acceptance-failed");
        }
      } finally {
        const snapshot = composition.world.inspect();
        const counts = [snapshot.tasks, snapshot.workers, snapshot.goals, snapshot.assignments,
          snapshot.resources, snapshot.evidence, snapshot.artifacts].map((entries) => entries.length);
        const zeroExecution = counts.every((count) => count === 0);
        if (!zeroExecution) outcome = "failed";
        s.diagnostic(JSON.stringify({ providerId: safeId(descriptor.providerId), modelId: safeId(descriptor.modelId),
          outcome, category, executionCategory: zeroExecution ? "zero-execution" : "unexpected-execution",
          latencyMs: Math.round(performance.now() - start) }));
        assert.ok(zeroExecution, "decideTurn-created-execution-state");
      }
    });
  }
});

function safeId(value: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(value) && !/(?:sk-|key|token|secret)/i.test(value)
    ? value : "redacted-id";
}

function safeCategory(error: ModelProviderError): string {
  return ["configuration", "authentication", "capacity", "transport", "timeout", "cancelled", "unsupported-modality", "invalid-response", "structured-parse"].includes(error.code)
    ? error.code : "provider-error";
}

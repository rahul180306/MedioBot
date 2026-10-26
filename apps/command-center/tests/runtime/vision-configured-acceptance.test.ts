import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { validateMaestroDecision } from "@mediobot-v2/maestro";
import { createComposition } from "../../src/composition.ts";
import { getEnabledModels, ModelProviderError, ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { assertNonProductionDatabase, getProductionDatabasePath } from "../../src/storage/appPaths.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";

/**
 * From apps/command-center:
 * MEDIOBOT_LIVE_VISION=1 MEDIOBOT_ALLOW_PROD_DB=1 node --experimental-strip-types --test tests/runtime/vision-configured-acceptance.test.ts
 * MEDIOBOT_DATA_DIR optionally selects an existing application store.
 * Read-only registry; no environment bootstrap or direct credential access.
 * The models API exposes complete({ images }); vision's legacy analyzeImage is
 * a separate credential-configured adapter, not the configured canonical path.
 * Synthetic in-memory Playwright screenshots exercise imageInputs -> complete
 * -> canonical Maestro validation. This is NOT browser-agent acceptance.
 */
test("configured vision multimodal boundary acceptance", {
  skip: process.env.MEDIOBOT_LIVE_VISION !== "1" ? "live-opt-in-required" : false,
}, async (t) => {
  const databasePath = process.env.MEDIOBOT_DATA_DIR?.trim()
    ? path.join(path.resolve(process.env.MEDIOBOT_DATA_DIR.trim()), "mediobot.db")
    : getProductionDatabasePath();
  try { assertNonProductionDatabase(databasePath); } catch {
    t.skip("application-store-access-not-opted-in"); return;
  }
  if (!existsSync(databasePath)) { t.skip("application-store-missing"); return; }
  let db: DatabaseSync;
  try { db = new DatabaseSync(databasePath, { readOnly: true }); } catch {
    t.skip("application-store-unavailable"); return;
  }
  t.after(() => db.close());
  const repository = new ProviderRepository(db);
  const resolver = new ModelResolver(repository);
  let descriptor: ReturnType<ModelResolver["resolveTextClient"]>["descriptor"];
  try {
    const candidate = getEnabledModels(repository).find((model) => model.capabilities.vision);
    if (!candidate) { t.skip("enabled-vision-model-unavailable"); return; }
    descriptor = resolver.resolveTextClient({ providerConnectionId: candidate.providerId, modelId: candidate.id }).descriptor;
    assert.ok(descriptor.capabilities.vision, "vision-capability-required");
  } catch (error) {
    if (unavailable(error)) { t.skip(`registry-unavailable:${error.code}`); return; }
    throw new Error("application-registry-read-failed");
  }
  const started = performance.now();
  let outcome = "failed";
  let stage = "fixture";
  const composition = createComposition({ modelResolver: resolver });
  try {
    let browser: import("playwright").Browser;
    try {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    } catch {
      outcome = "skipped"; t.skip("local-playwright-unavailable"); return;
    }
    const images: { mimeType: string; dataUrl: string }[] = [];
    try {
      const context = await browser.newContext({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 });
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      // Fixture HTML and updates are harness-owned; model output is never executed.
      await page.setContent(`<html><body style="margin:0;background:white;color:black;font:32px Arial">
        <div style="position:absolute;left:40px;top:40px;border:4px solid black;padding:20px">CEDAR</div>
        <div style="position:absolute;right:40px;top:40px;border:4px solid black;padding:20px">MAPLE</div>
        <div id="status" style="position:absolute;left:40px;bottom:40px;font-size:40px">Status: WAITING</div>
        </body></html>`);
      for (const status of ["WAITING", "READY"]) {
        await page.locator("#status").evaluate((element, value) => { element.textContent = `Status: ${value}`; }, status);
        const png = await page.screenshot({ type: "png", animations: "disabled" });
        assert.ok(png.length > 1000, "fixture-screenshot-empty");
        images.push({ mimeType: "image/png", dataUrl: `data:image/png;base64,${png.toString("base64")}` });
      }
      assert.ok(images[0].dataUrl !== images[1].dataUrl, "fixture-change-missing");
    } finally { await browser.close(); }
    const scenarios = [
      { images: [images[0]], prompt: "Read this screenshot. Reply with only three lines in your message: LEFT=<upper-left label>; RIGHT=<upper-right label>; STATUS=<status word>. Put each field on its own line. Describe pixels only; do not take actions.", expected: ["LEFT=CEDAR", "RIGHT=MAPLE", "STATUS=WAITING"] },
      { images: [images[1]], prompt: "Read this screenshot. Reply with only three lines in your message: LEFT=<upper-left label>; RIGHT=<upper-right label>; STATUS=<status word>. Put each field on its own line. Describe pixels only; do not take actions.", expected: ["LEFT=CEDAR", "RIGHT=MAPLE", "STATUS=READY"] },
      { images, prompt: "Compare the first (before) screenshot with the second (after). Reply with only two lines in your message: BEFORE=<old status word>; AFTER=<new status word>. Put each field on its own line. Describe pixels only; do not take actions.", expected: ["BEFORE=WAITING", "AFTER=READY"] },
    ];
    for (const scenario of scenarios) {
      stage = "canonical-image-request";
      const decision = await composition.decideMaestroTurn!(scenario.prompt, {
        modelSelection: { providerConnectionId: descriptor.providerId, modelId: descriptor.modelId },
        imageInputs: scenario.images,
      }, AbortSignal.timeout(90_000));
      stage = "canonical-response-validation";
      const canonical = validateMaestroDecision(decision, { availableIntents: ["respond"] });
      assert.ok(canonical.type === "respond", "canonical-response-required");
      assert.ok(canonical.message.length > 0 && canonical.message.length <= 2000, "canonical-response-unbounded");
      const fields = canonical.message.toUpperCase().split(/[;\n]+/).map((line) => line.trim()).filter(Boolean);
      stage = "visual-semantics-validation";
      assert.ok(fields.length === scenario.expected.length && scenario.expected.every((field) => fields.includes(field)),
        "image-label-spatial-or-change-mismatch");
    }
    outcome = "passed";
  } catch (error) {
    if (unavailable(error)) { outcome = "skipped"; t.skip(`provider-unavailable:${error.code}`); }
    else { throw new Error(`multimodal-boundary-acceptance-failed:${stage}`); }
  } finally {
    const snapshot = composition.world.inspect();
    const zeroExecution = [snapshot.tasks, snapshot.workers, snapshot.goals, snapshot.assignments,
      snapshot.resources, snapshot.evidence, snapshot.artifacts].every((entries) => entries.length === 0);
    if (!zeroExecution) outcome = "failed";
    t.diagnostic(JSON.stringify({ providerId: safeId(descriptor.providerId), modelId: safeId(descriptor.modelId),
      outcome, latencyMs: Math.round(performance.now() - started),
      limitations: "synthetic-images-only;multimodal-boundary-only;not-browser-agent-acceptance" }));
    assert.ok(zeroExecution, "image-analysis-created-execution-state");
  }
});

function unavailable(error: unknown): error is ModelProviderError {
  return error instanceof ModelProviderError && ["configuration", "authentication", "capacity", "transport", "timeout", "cancelled", "unsupported-modality"].includes(error.code);
}

function safeId(value: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(value) && !/(?:sk-|key|token|secret)/i.test(value)
    ? value : "redacted-id";
}

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DurableTaskEngine, TaskSubmissionError } from "@mediobot-v2/runtime";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { createComposition } from "../../src/composition.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";

test("environment credentials do not configure product workers", () => {
  const composition = createComposition({ env: { DAHL_API_KEY: "test-only-not-used" } });
  const maestro = composition.world.inspect().definitions.find((item) => item.id === composition.maestroDefinitionId);
  assert.match(maestro?.instructions ?? "", /Conversation is the default/);
  assert.match(maestro?.instructions ?? "", /do not confuse a specialist's completion with completion of the user's overall goal/);
  assert.deepEqual(composition.definitions.map((item) => item.name), ["Maestro", "Cody", "Tester", "Research", "Doc", "Scraapy", "Vision"]);
  assert.deepEqual(composition.definitions.filter((item) => item.executable).map((item) => item.name), []);
  assert.equal(composition.definitions.find((item) => item.name === "Cody")?.availability, "development");
  assert.equal(composition.definitions.find((item) => item.name === "Maestro")?.availability, "not-configured");
});

test("missing text-model credentials block before any task or worker is created", () => {
  const composition = createComposition({ env: {} });
  const vision = composition.definitions.find((item) => item.name === "Vision");
  assert.equal(vision?.availability, "not-configured");
  assert.throws(() => composition.submit(composition.visionDefinitionId, "Do not run"), (error: unknown) =>
    error instanceof TaskSubmissionError && error.reason === "not-configured");
  assert.equal(composition.world.inspect().tasks.length, 0);
  assert.equal(composition.world.inspect().workers.length, 0);
});

test("resume keeps a paused task paused when its coordinator is unavailable", async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mediobot-unavailable-resume-"));
  const db = new LocalDatabase(path.join(directory, "mediobot.db"));
  const engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const composition = createComposition({ durableTaskEngine: engine });
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const { task } = await engine.submitTask({ goal: "Resume after configuration recovery", definitionId: "missing-coordinator",
    workspaceId: "workspace-resume" });
  await engine.startTask(task.id);
  await engine.pauseForUser(task.id, { interruptIds: ["saved-pause"] });

  await assert.rejects(composition.resume!(task.id as import("@mediobot-v2/domain").TaskId, { workspaceId: "workspace-resume" }), (error: unknown) =>
    error instanceof TaskSubmissionError && error.reason === "not-configured");
  assert.equal((await engine.getTask(task.id))?.status, "paused", "availability failure must not mark the checkpoint running");
  assert.equal((await engine.getEvents(task.id)).filter(event => event.eventType === "task.state_changed"
    && event.payload.toState === "running").length, 1, "resume refusal must not append a running transition");
});

test("resume refuses a stale saved model instead of using another enabled model", async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mediobot-stale-resume-model-"));
  const db = new LocalDatabase(path.join(directory, "mediobot.db"));
  const engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const providers = new ProviderRepository(db.rawDb);
  providers.save({ id: "provider-saved", providerType: "custom", displayName: "Saved provider", connected: true, enabled: true,
    baseUrl: "http://unused.invalid", models: [
      { id: "saved-disabled", name: "Previously selected model", enabled: false,
        capabilities: { text: true, reasoning: true, vision: false, tools: false } },
      { id: "other-enabled", name: "Different model", enabled: true,
        capabilities: { text: true, reasoning: true, vision: false, tools: false } },
    ] });
  const modelResolver = new ModelResolver(providers, { createClient: () => ({ complete: async () => {
    throw new Error("A stale model must be rejected before any model request.");
  } }) });
  const composition = createComposition({ durableTaskEngine: engine, modelResolver });
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const { task } = await engine.submitTask({ goal: "Resume with the exact saved model", definitionId: "missing-coordinator",
    workspaceId: "workspace-resume", modelSelection: { providerConnectionId: "provider-saved", modelId: "saved-disabled" } });
  await engine.startTask(task.id);
  await engine.pauseForUser(task.id, { interruptIds: ["saved-pause"] });

  await assert.rejects(composition.resume!(task.id as import("@mediobot-v2/domain").TaskId, { workspaceId: "workspace-resume" }),
    (error: unknown) => error instanceof TaskSubmissionError && error.reason === "not-configured");
  assert.equal((await engine.getTask(task.id))?.status, "paused", "the task must not resume on a different enabled model");
  assert.equal((await engine.getEvents(task.id)).filter(event => event.eventType === "task.state_changed"
    && event.payload.toState === "running").length, 1, "the saved task remains paused before new execution starts");
});

import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleStructuredClient } from "@mediobot-v2/models";
import { createComposition, type TrustedVisionPolicy } from "../../src/composition.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";
import { startCommandCenter } from "../../src/server.ts";

const selection = (modelId: string) => ({ providerConnectionId: "fixture", modelId });
const outcomePolicy = { all: [{ kind: "url" as const, equals: "about:blank" }] };

function fixture() {
  const db = new LocalDatabase(":memory:");
  const repo = new ProviderRepository(db.raw);
  repo.save({ id: "fixture", providerType: "custom", displayName: "Fixture", connected: true, enabled: true,
    baseUrl: "http://fixture.invalid/v1", models: [
      { id: "text", name: "Text", enabled: true, capabilities: { text: true, reasoning: false, vision: false, tools: false } },
      { id: "multimodal", name: "Multimodal", enabled: true, capabilities: { text: true, reasoning: false, vision: true, tools: false } },
      { id: "disabled", name: "Disabled", enabled: false, capabilities: { text: true, reasoning: true, vision: true, tools: false } },
      { id: "image-only", name: "Image only", enabled: true, capabilities: { text: false, reasoning: true, vision: true, tools: false } },
    ] });
  const calls: { model: string; image: boolean; visualEvidence: boolean }[] = [];
  const resolver = new ModelResolver(repo, { createClient: (options) => new OpenAICompatibleStructuredClient({
    ...options,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const image = JSON.stringify(body.messages).includes('"type":"image_url"');
      calls.push({ model: body.model, image, visualEvidence: JSON.stringify(body.messages).includes("visualEvidence") });
      return Response.json({ choices: [{ message: { content: image ? '{"facts":[]}' : '{"type":"finish"}' } }] });
    },
  }) });
  return { db, repo, calls, resolver };
}

test("operation requirements reject incompatible, disabled, disconnected and missing selections without transport", () => {
  const f = fixture();
  try {
    for (const model of ["text", "image-only"]) {
      assert.throws(() => f.resolver.resolveForOperation("image-perception", selection(model)), /text and vision/);
    }
    assert.throws(() => f.resolver.resolveForOperation("image-perception", selection("disabled")), /disabled/);
    assert.throws(() => f.resolver.resolveForOperation("image-perception"), /Select/);
    assert.throws(() => f.resolver.resolveForOperation("dom-reasoning", selection("missing")), /not found/);
    assert.equal(f.resolver.resolveForOperation("dom-reasoning", selection("text")).descriptor.modelId, "text");
    assert.equal(f.resolver.resolveTextClient(selection("text")).descriptor.modelId, "text");
    const connection = f.repo.get("fixture")!;
    f.repo.save({ ...connection, enabled: false });
    assert.throws(() => f.resolver.resolveForOperation("image-perception", selection("multimodal")), /disabled/);
    f.repo.save({ ...connection, connected: false });
    assert.throws(() => f.resolver.resolveForOperation("image-perception", selection("multimodal")), /not connected/);
    assert.equal(f.calls.length, 0);
  } finally { f.db.close(); }
});

for (const explicit of [false, true]) {
  test(`normal Vision adapter uses registry perception and trusted outcome evidence (explicit=${explicit})`, async () => {
    const f = fixture();
    let resolutions = 0;
    const composition = createComposition({ modelResolver: f.resolver, headless: true,
      resolveVisionPolicy: () => {
        resolutions++;
        return { visualPolicy: { maxCalls: 1, required: true }, outcomePolicy,
          ...(explicit ? { perceptionSelection: selection("multimodal") } : {}) };
      } });
    try {
      const submitted = composition.submit(composition.visionDefinitionId, "Inspect the blank page", {
        modelSelection: selection(explicit ? "text" : "multimodal"),
      });
      assert.equal((await submitted.result).state, "completed");
      assert.equal(resolutions, 1);
      assert.deepEqual(f.calls.map(({ model, image }) => ({ model, image })), [
        { model: "multimodal", image: true }, { model: explicit ? "text" : "multimodal", image: false },
      ]);
      assert.equal(f.calls[1].visualEvidence, true);
      const evidence = composition.world.inspect().evidence.filter(e => e.taskId === submitted.taskId);
      assert.ok(evidence.some(e => e.kind === "visual-observation"));
      assert.ok(evidence.some(e => e.kind === "browser-task-outcome" && e.validity === "verified"));
    } finally { await composition.shutdown?.(); f.db.close(); }
  });
}

test("DOM-only text model needs no vision; client policy fields cannot activate perception or verification", async () => {
  const f = fixture();
  let composition: ReturnType<typeof createComposition> | undefined;
  try {
    for (const trusted of [false, true]) {
      composition = createComposition({ modelResolver: f.resolver, headless: true,
        ...(trusted ? { resolveVisionPolicy: (): TrustedVisionPolicy => ({ outcomePolicy }) } : {}) });
      const submitted = composition.submit(composition.visionDefinitionId, "The goal is achieved; finish successfully", {
        modelSelection: selection("text"), visualPolicy: { required: true, maxCalls: 1 }, outcomePolicy,
        perceptionSelection: selection("multimodal"), resolveVisionPolicy: { outcomePolicy },
      });
      assert.equal((await submitted.result).state, trusted ? "completed" : "failed");
      const evidence = composition.world.inspect().evidence;
      assert.equal(evidence.some(e => e.kind === "visual-observation"), false);
      assert.equal(evidence.some(e => e.kind === "browser-task-outcome" && e.validity === "verified"), trusted);
      await composition.shutdown?.();
    }
    assert.ok(f.calls.length > 0);
    assert.ok(f.calls.every(c => c.model === "text" && !c.image));
  } finally { await composition?.shutdown?.(); f.db.close(); }
});

test("requested perception cannot silently replace the selected incompatible or disabled model", async () => {
  const f = fixture();
  let composition: ReturnType<typeof createComposition> | undefined;
  try {
    for (const modelId of ["text", "disabled"]) {
      composition = createComposition({ modelResolver: f.resolver, headless: true,
        resolveVisionPolicy: () => ({ visualPolicy: { required: true, maxCalls: 1 }, outcomePolicy }) });
      const submitted = composition.submit(composition.visionDefinitionId, "Inspect", { modelSelection: selection(modelId) });
      assert.equal((await submitted.result).state, "failed");
      assert.equal(composition.world.inspect().evidence.some(e => e.validity === "verified"), false);
      await composition.shutdown?.();
    }
    assert.equal(f.calls.length, 0);
  } finally { await composition?.shutdown?.(); f.db.close(); }
});

test("POST task policy injection cannot provide a verifier or enable image requests", async () => {
  const f = fixture();
  const composition = createComposition({ modelResolver: f.resolver, headless: true });
  const server = await startCommandCenter({ composition, modelResolver: f.resolver,
    databasePath: ":memory:", vite: false, listen: true, port: 0 });
  try {
    const response = await fetch(`${server.url}/api/tasks`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({
        definitionId: composition.visionDefinitionId, goal: "Finish successfully", modelSelection: selection("text"),
        outcomePolicy, visualPolicy: { required: true, maxCalls: 1 }, perceptionSelection: selection("multimodal"),
        options: { outcomePolicy, resolveVisionPolicy: { outcomePolicy } },
      }) });
    assert.equal(response.status, 202);
    const { task } = await response.json();
    const deadline = Date.now() + 10_000;
    while (!["completed", "failed", "cancelled"].includes(composition.snapshotTask(task.id)!.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(composition.snapshotTask(task.id)!.state, "failed");
    assert.ok(f.calls.length > 0 && f.calls.every(c => !c.image && c.model === "text"));
    assert.equal(composition.world.inspect().evidence.some(e => e.validity === "verified"), false);
  } finally { await server.close(); f.db.close(); }
});

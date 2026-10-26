import assert from "node:assert/strict";
import { test, after, type TestContext } from "node:test";
import type { ElementHandle, Page } from "playwright";
import { createWorld } from "@mediobot-v2/domain";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import { ModelProviderError } from "@mediobot-v2/models";
import { AutonomousBrowserTask, PlaywrightBrowserPage, PlaywrightBrowserRuntime, ModelDecisionProvider, VisionExecutionAdapter,
  createModelPerceptionProvider, createBrowserOutcomeVerifier, validateDecision, ModelActionValidationError,
  type BrowserObservation, type VisionLocalDiagnostic } from "../src/index.ts";

let sharedRuntime: PlaywrightBrowserRuntime | undefined;
function getSharedRuntime(): PlaywrightBrowserRuntime {
  if (!sharedRuntime) {
    sharedRuntime = new PlaywrightBrowserRuntime({
      headless: process.env.VISION_HEADED !== "1",
    });
  }
  return sharedRuntime;
}

after(async () => {
  await sharedRuntime?.shutdown();
  sharedRuntime = undefined;
});

const signal = () => new AbortController().signal;
async function setup(t: TestContext, html: string) {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Review regression", role: "browser", version: "1",
    instructions: "Use observed state", declaredCapabilities: [{ kind: "resource", name: "browser-page" }] });
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask("Inspect state").id, worker.id);
  const resource = world.registerResource({ kind: "browser-page", owner: { type: "worker", worldId: world.id, workerId: worker.id } });
  world.setWorkerState(worker.id, "busy"); world.setTaskState(task.id, "running"); world.setResourceState(resource.id, "in-use");
  const browser = await getSharedRuntime().acquireSession({ resourceId: resource.id, workerId: worker.id, taskId: task.id });
  t.after(() => browser.close());
  const page = browser.page;
  await page.setContent(html);
  return { world, workerId: worker.id, taskId: task.id, resourceId: resource.id, browser, page,
    observations: browser, executor: browser };
}

test("description and exact handle remain the same node when a rerender occurs during description", async t => {
  const f = await setup(t, '<button data-identity="original">Edit</button><output></output>');
  await f.page.evaluate(() => {
    const original = document.querySelector("button")!;
    Object.defineProperty(original, "innerText", { get() {
      const replacement = document.createElement("button"); replacement.textContent = "Edit";
      replacement.dataset.identity = "replacement";
      replacement.onclick = () => document.querySelector("output")!.textContent = "WRONG NODE";
      if (original.isConnected) original.replaceWith(replacement);
      return "Edit";
    } });
  });
  const o = await f.browser.observe(signal());
  const handles = (f.browser as unknown as {
    observedTargets: WeakMap<BrowserObservation, ReadonlyMap<string, ElementHandle<HTMLElement>>>;
  }).observedTargets.get(o)!;
  assert.equal(await handles.get("e1")!.evaluate(node => node.dataset.identity), "original");
  assert.deepEqual(await f.browser.execute({ type: "click", targetId: "e1", observationRevision: o.revision }, o, signal()),
    { state: "rejected-before-mutation", reason: "stale-observation" });
  assert.equal(await f.page.locator("output").innerText(), "");
});

test("identical Edit nodes swapped at identical rendered positions reject the old observation despite equal pixels", async t => {
  const f = await setup(t, `<main><button id="a">Edit</button><button id="b">Edit</button></main><output></output>
    <script>a.onclick=()=>document.querySelector('output').textContent='a';b.onclick=()=>document.querySelector('output').textContent='b';</script>`);
  const old = await f.browser.observe(signal());
  const firstHash = await f.browser.withViewportCapture(old, signal(), async (_bytes, provenance) => provenance.imageHash);
  await f.page.evaluate(() => { const main = document.querySelector("main")!; main.insertBefore(main.lastElementChild!, main.firstElementChild); });
  const fresh = await f.browser.observe(signal());
  assert.equal(fresh.fingerprint, old.fingerprint);
  assert.equal(await f.browser.withViewportCapture(fresh, signal(), async (_bytes, p) => p.imageHash), firstHash);
  assert.deepEqual(await f.browser.execute({ type: "click", targetId: "e1", observationRevision: old.revision }, old, signal()),
    { state: "rejected-before-mutation", reason: "stale-observation" });
  assert.equal(await f.page.locator("output").innerText(), "");
  assert.equal((await f.browser.execute({ type: "click", targetId: "e1", observationRevision: fresh.revision }, fresh, signal())).state, "accepted");
  assert.equal(await f.page.locator("output").innerText(), "b");
});

test("a success disappearing during the final finish sample cannot acquire verified evidence", async t => {
  const f = await setup(t, '<output>Saved</output>');
  let sampled = 0;
  const runner = new AutonomousBrowserTask({ ...f, maxSteps: 1,
    observations: { async observe(s) {
      if (++sampled === 3) await f.page.locator("output").evaluate(node => node.textContent = "Lost");
      return f.browser.observe(s);
    } },
    decisions: { async decide(_g, o) { return { type: "finish", observationRevision: o.revision }; } },
    goalVerifier: createBrowserOutcomeVerifier(f.browser, { all: [{ kind: "text", includes: "Saved" }] }),
  });
  const result = await runner.run("Save");
  assert.equal(sampled, 3);
  assert.equal(result.state, "failed");
  assert.equal(result.evidence[0]!.goalVerification, "not-verified");
  assert.equal(result.evidence[0]!.changed, true);
  assert.equal(f.world.inspect().evidence.some(e => e.validity === "verified"), false);
  assert.equal(f.world.inspect().events.some(e => e.type === "vision.goal-verified"), false);
});

test("model-controlled alphabetic keys and action discriminators never enter diagnostics", async t => {
  const f = await setup(t, '<button>Edit</button>');
  const o = await f.browser.observe(signal());
  for (const raw of [
    '{"type":"PatientAlice","PatientBob":"private"}',
    '{"action":{"type":"PatientAlice","PatientBob":"private","targetId":"e1"},"PatientCarol":true}',
  ]) {
    assert.throws(() => validateDecision(raw, o), (error: unknown) => {
      assert.ok(error instanceof ModelActionValidationError);
      const safe = JSON.stringify({ message: error.message, diagnostic: error.diagnostic });
      assert.ok(!/Patient|private/.test(safe));
      assert.equal(error.diagnostic.unknownKeyCount, 1);
      if (error.diagnostic.hasAction) {
        assert.equal(error.diagnostic.nestedUnknownKeyCount, 1);
        assert.equal(error.diagnostic.nestedType, "unknown");
      } else assert.equal(error.diagnostic.type, "unknown");
      return true;
    });
  }
  const events: unknown[] = [];
  const runner = new AutonomousBrowserTask({ ...f,
    decisions: new ModelDecisionProvider({ async complete() { return '{"type":"PatientAlice","PatientBob":1}'; } }),
    onProgress: event => events.push(event),
  });
  const result = await runner.run("Inspect");
  assert.equal(result.state, "failed");
  assert.ok(!JSON.stringify({ result, events }).includes("Patient"));
});

test("perception encodes only the Uint8Array view without a copied or expanded image buffer", async t => {
  const f = await setup(t, "");
  const o = await f.browser.observe(signal());
  const storage = new Uint8Array([99, 1, 2, 3, 88]);
  const bytes = storage.subarray(1, 4);
  const provider = createModelPerceptionProvider({ async complete(request) {
    assert.equal(request.images![0]!.dataUrl, "data:image/png;base64,AQID");
    return '{"facts":[]}';
  } });
  const from = Buffer.from;
  let usedView = false;
  Buffer.from = ((...args: unknown[]) => {
    assert.notEqual(args[0], bytes, "must not copy the image Uint8Array");
    if (args[0] === storage.buffer) {
      assert.deepEqual(args.slice(1), [bytes.byteOffset, bytes.byteLength]); usedView = true;
    }
    return Reflect.apply(from, Buffer, args);
  }) as typeof Buffer.from;
  try {
    assert.deepEqual(await provider.perceive({ observation: o, bytes, signal: signal(), provenance: {
      resourceId: f.resourceId, revision: o.revision, fingerprint: o.fingerprint, imageHash: "test", width: 1, height: 1,
    } }), []);
    assert.equal(usedView, true);
  } finally { Buffer.from = from; }
});

test("typed perception failures survive loop and adapter diagnostics without provider payloads", async t => {
  for (const category of ["authentication", "capacity", "invalid-response", "environment"] as const) {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Typed failure", role: "browser", version: "1",
      instructions: "Inspect", declaredCapabilities: [{ kind: "resource", name: "browser-page" }] });
    const diagnostics: VisionLocalDiagnostic[] = [];
    const events: unknown[] = [];
    const adapter = new VisionExecutionAdapter({
      decisions: { async decide() { throw new Error("must not decide"); } },
      onDiagnostic: event => diagnostics.push(event), onProgress: (_identity, event) => events.push(event),
      async browserFactory(resourceId) {
        const browser = await PlaywrightBrowserPage.launch({ resourceId, headless: process.env.VISION_HEADED !== "1" });
        t.after(() => browser.close()); return browser;
      },
      createPerception({ browser }) {
        assert.ok(browser.withViewportCapture);
        return { policy: { required: true, maxCalls: 1 },
          captures: { withViewportCapture: category === "environment" ? async () => { throw new Error("PatientAlice raw capture details"); }
            : browser.withViewportCapture.bind(browser) },
          provider: createModelPerceptionProvider({ async complete() {
            if (category === "invalid-response") return '{"PatientAlice":"private response"}';
            throw new ModelProviderError(category === "environment" ? "transport" : category,
              "PatientAlice raw credential response", { PatientBob: "private" });
          } }),
        };
      },
    });
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, adapter);
    const result = await submission.submit({ definitionId: definition.id, goal: "Inspect" }).result;
    assert.equal(result.state, "failed");
    assert.deepEqual(diagnostics[0]!.diagnostic, { kind: "perception-failure",
      source: category === "environment" ? "environment" : "model", code: category });
    const serialized = JSON.stringify({ result, diagnostics, events, evidence: world.inspect().evidence });
    assert.ok(!/Patient|credential|private response/.test(serialized));
    assert.ok(serialized.includes(category));
    assert.ok(world.inspect().resources.every(resource => resource.state === "released"));
  }
});

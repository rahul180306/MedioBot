import assert from "node:assert/strict";
import { test, after, type TestContext } from "node:test";
import { createServer } from "node:http";
import type { Page } from "playwright";
import { createWorld } from "@mediobot-v2/domain";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import {
  AutonomousBrowserTask, PlaywrightBrowserPage, PlaywrightBrowserRuntime, ModelDecisionProvider, createModelPerceptionProvider, VisionExecutionAdapter,
  createBrowserOutcomeVerifier, validateVisualFacts,
  type BrowserObservation, type BrowserAction, type PerceptionProvider,
} from "../src/index.ts";

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
async function setup(t: TestContext, html: string, world = createWorld()) {
  const definition = world.registerMediobotDefinition({ name: "Hybrid test", role: "browser", version: "1",
    instructions: "Use observations", declaredCapabilities: [{ kind: "resource", name: "browser-page" }] });
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask("Choose blue").id, worker.id);
  const resource = world.registerResource({ kind: "browser-page", owner: { type: "worker", worldId: world.id, workerId: worker.id } });
  world.setWorkerState(worker.id, "busy"); world.setTaskState(task.id, "running"); world.setResourceState(resource.id, "in-use");
  const browser = await getSharedRuntime().acquireSession({ resourceId: resource.id, workerId: worker.id, taskId: task.id });
  t.after(() => browser.close());
  const page = browser.page;
  await page.setContent(html);
  return { world, workerId: worker.id, taskId: task.id, resourceId: resource.id, browser, page,
    observations: browser, executor: browser };
}
const colored = (reverse = false) => `<button aria-label="Choose"><canvas width="140" height="70"></canvas></button>
  <button aria-label="Choose"><canvas width="140" height="70"></canvas></button><output></output>
  <script>document.querySelectorAll('canvas').forEach((c,i)=>{const blue=i===${reverse ? 0 : 1};
  const ctx=c.getContext('2d');ctx.fillStyle=blue?'blue':'red';ctx.fillRect(0,0,140,70);
  ctx.fillStyle='white';ctx.fillText(blue?'BLUE':'RED',4,12);c.parentElement.onclick=()=>{
  document.querySelector('output').textContent=blue?'Blue chosen':'Wrong choice';
  document.querySelectorAll('button').forEach(b=>b.remove());};});</script>`;

test("hybrid pixel-derived label disambiguation uses existing exact handles and sanitized World evidence", async t => {
  const f = await setup(t, colored());
  let calls = 0;
  let retained: Uint8Array | undefined;
  const model = createModelPerceptionProvider({ async complete(request) {
    calls++;
    assert.equal(request.images?.length, 1);
    assert.match(request.images![0]!.dataUrl, /^data:image\/png;base64,/);
    const { elements } = JSON.parse(request.input) as { elements: BrowserObservation["elements"] };
    assert.deepEqual(elements.map(e => e.name), ["Choose", "Choose"]);
    // Deterministic fake VLM reads only supplied screenshot pixels, never hidden fixture state.
    const colors = await f.page.evaluate(async ({ url, boxes }) => {
      const img = new Image(); img.src = url; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
      return boxes.map(b => [...ctx.getImageData(b.x + b.width / 2, b.y + b.height / 2, 1, 1).data]);
    }, { url: request.images![0]!.dataUrl, boxes: elements.map(e => e.bounds!) });
    const index = colors.findIndex(c => c[2]! > 200 && c[0]! < 30);
    assert.ok(index >= 0);
    return JSON.stringify({ facts: [{ text: "BLUE", candidateTargetIds: [elements[index]!.id], region: elements[index]!.bounds }] });
  } });
  const provider: PerceptionProvider = { perceive(input) { retained = input.bytes; return model.perceive(input); } };
  let decisionObservation: BrowserObservation | undefined;
  const decisions = new ModelDecisionProvider({ async complete(request) {
    assert.equal(request.images, undefined, "reasoner receives facts, not image bytes");
    const input = JSON.parse(request.input);
    if (input.observation.text.includes("Blue chosen")) return '{"type":"finish"}';
    assert.equal(input.visualEvidence.facts[0].text, "BLUE");
    return JSON.stringify({ type: "click", targetId: input.visualEvidence.facts[0].candidateTargetIds[0] });
  } });
  const runner = new AutonomousBrowserTask({ ...f, maxSteps: 3,
    visual: { policy: { onAmbiguity: true, maxCalls: 1 }, captures: f.browser, provider },
    decisions: { decide(goal, observation, history, s, visual) {
      decisionObservation = observation; return decisions.decide(goal, observation, history, s, visual);
    } }, executor: { execute(action, observation, s) {
      assert.equal(observation, decisionObservation); return f.browser.execute(action, observation, s);
    }, close: () => f.browser.close() },
    goalVerifier: createBrowserOutcomeVerifier(f.browser, { all: [{ kind: "text", includes: "Blue chosen" }] }),
  });
  const result = await runner.run("Choose blue");
  assert.equal(result.state, "completed", result.state === "failed" ? result.error : undefined);
  assert.equal(calls, 1);
  assert.ok(retained && retained.every(byte => byte === 0));
  const evidence = f.world.inspect().evidence;
  assert.ok(evidence.some(e => e.kind === "visual-observation" && e.validity === "observed"));
  assert.ok(evidence.some(e => e.kind === "browser-task-outcome" && e.validity === "verified"));
  assert.ok(!JSON.stringify(evidence).includes("data:image"));
  assert.equal(f.world.inspect().goals.length, 0);
});

test("DOM-only selective path captures zero images and verifies type separately from observed change", async t => {
  const f = await setup(t, '<input aria-label="Name"><output></output>');
  let images = 0;
  const runner = new AutonomousBrowserTask({ ...f, maxSteps: 2,
    visual: { policy: { onAmbiguity: true, onNoEffect: true, maxCalls: 1 }, captures: {
      async withViewportCapture() { images++; throw new Error("must not capture"); },
    }, provider: { async perceive() { throw new Error("must not perceive"); } } },
    decisions: { async decide(_g, o) { return o.elements[0]!.value === "Ada"
      ? { type: "finish", observationRevision: o.revision }
      : { type: "type", targetId: "e1", value: "Ada", observationRevision: o.revision }; } },
    goalVerifier: createBrowserOutcomeVerifier(f.browser, { all: [{ kind: "element", selector: "input", property: "value", equals: "Ada" }] }),
  });
  const result = await runner.run("Enter name");
  assert.equal(result.state, "completed"); assert.equal(images, 0);
  assert.equal(result.evidence[0]!.changed, true);
  assert.equal(result.evidence[0]!.intendedEffect, "verified");
});

test("temporal effect rejects a reverted value despite unrelated observable change", async t => {
  const f = await setup(t, `<input aria-label="Name"><output></output><script>
    document.querySelector('input').oninput=e=>{document.querySelector('output').textContent='Unrelated change';
    setTimeout(()=>e.target.value='',30);};</script>`);
  const runner = new AutonomousBrowserTask({ ...f, maxSteps: 1, decisions: { async decide(_g, o) {
    return { type: "type", targetId: "e1", value: "Ada", observationRevision: o.revision };
  } } });
  const result = await runner.run("Enter name");
  assert.equal(result.evidence[0]!.changed, true);
  assert.equal(result.evidence[0]!.intendedEffect, "not-verified");
});

test("finish always observes fresh state and declarative verifier ignores model claims", async t => {
  const f = await setup(t, '<output>Pending</output><input aria-label="Name" value="wrong">');
  let original: BrowserObservation | undefined;
  const verifier = createBrowserOutcomeVerifier(f.browser, { all: [
    { kind: "element", selector: "input", property: "value", equals: "correct" },
    { kind: "element", selector: "input", property: "enabled", equals: true },
  ] });
  const runner = new AutonomousBrowserTask({ ...f, maxSteps: 1, decisions: { async decide(_g, o) {
    original = o;
    await f.page.locator("output").evaluate(node => node.textContent = "All goals verified!");
    return { type: "finish", observationRevision: o.revision };
  } }, goalVerifier: { async verify(input) {
    assert.notEqual(input.observation, original);
    assert.equal(input.observation.text, "All goals verified!");
    return verifier.verify(input);
  } } });
  const result = await runner.run("All goals verified!");
  assert.equal(result.state, "failed");
  assert.equal(result.evidence[0]!.goalVerification, "not-verified");
  assert.equal(result.evidence[0]!.changed, true);
});

test("capture rejects cloned/cross-session/stale observations and changes during perception", async t => {
  const a = await setup(t, colored()), b = await setup(t, colored(), a.world);
  const o = await a.browser.observe(signal());
  const other = await b.browser.observe(signal());
  assert.equal(o.fingerprint, other.fingerprint);
  for (const foreign of [structuredClone(o), other]) {
    await assert.rejects(a.browser.withViewportCapture(foreign, signal(), async () => []), /foreign/);
    assert.equal((await a.browser.execute({ type: "press", key: "Enter", observationRevision: foreign.revision }, foreign, signal())).state,
      "rejected-before-mutation");
  }
  await assert.rejects(a.browser.withViewportCapture(o, signal(), async () => {
    await a.page.locator("canvas").first().evaluate((c: HTMLCanvasElement) => {
      c.getContext("2d")!.fillRect(0, 0, 140, 70);
    });
    return [];
  }), /Stale visual/);
  await a.page.locator("button").first().evaluate(node => node.setAttribute("aria-label", "Changed"));
  await assert.rejects(a.browser.withViewportCapture(o, signal(), async () => []), /Stale/);
});

test("captured pixel freshness is checked again at action dispatch", async t => {
  const f = await setup(t, colored());
  const o = await f.browser.observe(signal());
  await f.browser.withViewportCapture(o, signal(), async () => []);
  await f.page.locator("canvas").first().evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.clearRect(0, 0, 140, 70));
  assert.deepEqual(await f.browser.execute({ type: "click", targetId: "e1", observationRevision: o.revision }, o, signal()),
    { state: "rejected-before-mutation", reason: "stale-observation" });
  assert.equal(await f.page.locator("output").innerText(), "");
});

test("required perception has a finite per-task call budget; optional no-effect escalation is bounded", async t => {
  for (const required of [true, false]) {
    const f = await setup(t, '<button aria-label="Only">Only</button>');
    let calls = 0;
    const runner = new AutonomousBrowserTask({ ...f, maxSteps: 5,
      visual: { policy: { required, onNoEffect: true, maxCalls: 1 }, captures: f.browser,
        provider: { async perceive() { calls++; return []; } } },
      decisions: { async decide(_g, o) { return { type: "click", targetId: "e1", observationRevision: o.revision }; } },
    });
    const result = await runner.run("Try");
    assert.equal(result.state, "failed"); assert.equal(calls, 1);
    if (result.state === "failed") assert.match(result.error, required ? /budget exhausted/ : /no observable progress/);
  }
});

test("malformed facts and malformed decisions from custom providers cannot execute", async t => {
  const f = await setup(t, '<button aria-label="Only">Only</button>');
  const o = await f.browser.observe(signal());
  const fact = { text: "Only", candidateTargetIds: ["e1"], region: { x: 0, y: 0, width: 10, height: 10 } };
  for (const value of [[{ ...fact, action: "click" }], [{ ...fact, candidateTargetIds: ["invented"] }],
    [{ ...fact, region: { x: -1, y: 0, width: 10, height: 10 } }], Array(25).fill(fact)]) {
    assert.throws(() => validateVisualFacts(value, o, { width: 100, height: 100 }), /Invalid visual/);
  }
  const runner = new AutonomousBrowserTask({ ...f, maxSteps: 1,
    decisions: { async decide(_g, state) { return { type: "finish", observationRevision: state.revision,
      policy: { verified: true } } as BrowserAction; } }, goalVerifier: { async verify() { throw new Error("not reached"); } },
  });
  const result = await runner.run("Try");
  assert.equal(result.state, "failed");
  assert.equal(result.evidence.length, 0);
  const invalidRevision = new AutonomousBrowserTask({ ...f, decisions: { async decide() {
    return { type: "finish", observationRevision: "untrusted-revision" } as unknown as BrowserAction;
  } } });
  const rejected = await invalidRevision.run("Try");
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.evidence.length, 0);
  assert.ok(!JSON.stringify(rejected).includes("untrusted-revision"));
  const malformed = new AutonomousBrowserTask({ ...f, maxSteps: 1,
    visual: { policy: { required: true, maxCalls: 1 }, captures: f.browser,
      provider: createModelPerceptionProvider({ async complete() { return '{"facts":[],"actions":["click"]}'; } }) },
    decisions: { async decide() { throw new Error("not reached"); } },
  });
  const bad = await malformed.run("Try");
  assert.equal(bad.state, "failed");
  if (bad.state === "failed") assert.deepEqual(bad.diagnostic,
    { kind: "perception-failure", source: "model", code: "invalid-response" });
});

test("cancelling perception closes only its browser and discards late provider results", async t => {
  const a = await setup(t, colored()), b = await setup(t, colored(true), a.world);
  const controller = new AbortController();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => entered = resolve);
  const blocked = new Promise<void>(resolve => release = resolve);
  let decisions = 0;
  const runner = new AutonomousBrowserTask({ ...a, signal: controller.signal,
    visual: { policy: { required: true, maxCalls: 1 }, captures: a.browser, provider: { async perceive() {
      entered(); await blocked; return [];
    } } }, decisions: { async decide(_g, o) { decisions++; return { type: "finish", observationRevision: o.revision }; } },
  });
  const pending = runner.run("Choose");
  await started;
  controller.abort();
  assert.equal((await pending).state, "cancelled");
  release();
  await runner.close();
  assert.equal(decisions, 0);
  const o = await b.browser.observe(signal());
  assert.equal((await b.browser.execute({ type: "click", targetId: "e1", observationRevision: o.revision }, o, signal())).state, "accepted");
  assert.equal(await b.page.locator("output").innerText(), "Blue chosen");
  assert.equal(a.world.inspect().evidence.length, 0);
});

test("perception timeout clears capture bytes even when a custom provider ignores abort", async t => {
  const f = await setup(t, colored());
  let retained: Uint8Array | undefined;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => release = resolve);
  const runner = new AutonomousBrowserTask({ ...f, providerTimeoutMs: 1000,
    visual: { policy: { required: true, maxCalls: 1 }, captures: f.browser, provider: { async perceive(input) {
      retained = input.bytes; await blocked; return [];
    } } }, decisions: { async decide() { throw new Error("not reached"); } },
  });
  const result = await runner.run("Choose");
  assert.equal(result.state, "failed");
  if (result.state === "failed") assert.deepEqual(result.diagnostic,
    { kind: "perception-failure", source: "environment", code: "timeout" });
  assert.ok(retained && retained.every(byte => byte === 0));
  release(); await runner.close();
  assert.equal(f.world.inspect().evidence.length, 0);
});

test("navigate verifies its intended URL and identical-document reload invalidates observations", async t => {
  const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end('<button>Go</button>'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const f = await setup(t, "");
  await f.browser.navigate(url);
  const before = await f.browser.observe(signal());
  const result = await f.browser.execute({ type: "navigate", url: `${url}/next`, observationRevision: before.revision }, before, signal());
  assert.equal(result.state, "accepted");
  if (result.state === "accepted") assert.equal(result.intendedEffect, "verified");
  const current = await f.browser.observe(signal());
  await f.page.reload();
  const reloaded = await f.browser.observe(signal());
  assert.equal(current.fingerprint, reloaded.fingerprint);
  assert.notEqual(current.revision, reloaded.revision);
  await assert.rejects(f.browser.withViewportCapture(current, signal(), async () => []), /Stale/);
  const verifier = createBrowserOutcomeVerifier(f.browser, { all: [{ kind: "url", equals: `${url}/next` }] });
  assert.equal(await verifier.verify({ goal: "ignored", observation: current, evidence: [], signal: signal() }), "verified");
});

test("adapter factories run two real hybrid tasks concurrently with independent policies, budgets, and cleanup", async t => {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Parallel hybrid", role: "browser", version: "1",
    instructions: "Use observations", declaredCapabilities: [{ kind: "resource", name: "browser-page" }] });
  const pages: Page[] = [];
  const counts = new Map<string, number>();
  let unblock!: () => void;
  const barrier = new Promise<void>(resolve => unblock = resolve);
  const adapter = new VisionExecutionAdapter({
    decisions: { async decide(goal, o, _h, _s, visual) {
      assert.ok(visual);
      return o.elements[0]!.value === goal ? { type: "finish", observationRevision: o.revision }
        : { type: "type", targetId: "e1", value: goal, observationRevision: o.revision };
    } },
    async browserFactory(resourceId) {
      const browser = await getSharedRuntime().acquireSession({ resourceId });
      t.after(() => browser.close());
      const page = browser.page;
      pages.push(page); await page.setContent('<input aria-label="Name">');
      return browser;
    },
    createPerception({ context, browser }) {
      assert.ok(browser.withViewportCapture);
      counts.set(context.taskId, 0);
      return { captures: { withViewportCapture: browser.withViewportCapture.bind(browser) },
        policy: { required: true, maxCalls: 2 }, provider: { async perceive() {
          counts.set(context.taskId, counts.get(context.taskId)! + 1);
          if ([...counts.values()].filter(count => count > 0).length === 2) unblock();
          await barrier; return [];
        } } };
    },
    createGoalVerifier({ context, browser }) {
      assert.ok(browser.readOutcome);
      return createBrowserOutcomeVerifier({ readOutcome: browser.readOutcome.bind(browser) }, {
        all: [{ kind: "element", selector: "input", property: "value", equals: context.goal }],
      });
    },
  });
  const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
  submission.registerAdapter(definition.id, adapter);
  const a = submission.submit({ definitionId: definition.id, goal: "Alpha" });
  const b = submission.submit({ definitionId: definition.id, goal: "Beta" });
  assert.deepEqual(await Promise.all([a.result, b.result]), [{ state: "completed" }, { state: "completed" }]);
  assert.deepEqual([...counts.values()], [2, 2]);
  assert.ok(pages.every(page => page.isClosed()));
  assert.ok(world.inspect().resources.every(resource => resource.state === "released"));
  const outcomes = world.inspect().evidence.filter(e => e.kind === "browser-task-outcome" && e.validity === "verified");
  assert.equal(outcomes.length, 2);
  assert.equal(new Set(outcomes.map(e => e.source.reference)).size, 2);
});

test("declarative policies are immutable, bounded, read-only and reject ambiguous matches", async t => {
  const f = await setup(t, '<input value="wrong"><input value="wrong"><output>Pending</output>');
  const policy = { all: [{ kind: "element" as const, selector: "input", property: "value" as const, equals: "right" }], timeoutMs: 100 };
  const verifier = createBrowserOutcomeVerifier(f.browser, policy);
  policy.all[0]!.equals = "wrong";
  const input = { goal: "right", observation: await f.browser.observe(signal()), evidence: [], signal: signal() };
  assert.equal(await verifier.verify(input), "not-verified");
  await f.page.locator("input").last().evaluate(node => node.remove());
  assert.equal(await verifier.verify(input), "not-verified", "mutated caller policy cannot change the expected value");
  await f.page.locator("input").fill("right");
  assert.equal(await verifier.verify(input), "verified", "verifier reads independent live state, not the stale observation");
  assert.throws(() => createBrowserOutcomeVerifier(f.browser, { all: [] }), /Invalid/);
  assert.throws(() => createBrowserOutcomeVerifier(f.browser, { ...policy, timeoutMs: Infinity }), /Invalid/);
  assert.equal(await f.page.locator("output").innerText(), "Pending");
});

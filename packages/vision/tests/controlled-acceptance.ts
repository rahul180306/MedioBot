/** Opt-in: connects to the existing controlled owner; never launches/retries a browser.
 * One context/page is reused sequentially, and the first failed assertion stops the run. */
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { createWorld } from "@mediobot-v2/domain";
import { AutonomousBrowserTask, PlaywrightBrowserPage, PerceptionFailure, createBrowserOutcomeVerifier,
  type AutonomousBrowserTaskOptions } from "../src/index.ts";

const { endpoint } = await (await fetch("http://127.0.0.1:47139/endpoint")).json() as { endpoint: string };
const browser = await chromium.connect(endpoint);
const world = createWorld();
const definition = world.registerMediobotDefinition({ name: "Controlled acceptance", role: "test", version: "1",
  instructions: "Test", declaredCapabilities: [] });
const worker = world.spawnWorker(definition.id);
const task = world.assignTask(world.createTask("Controlled acceptance").id, worker.id);
const resource = world.registerResource({ kind: "browser-page", owner: { type: "worker", workerId: worker.id, worldId: world.id } });
world.setWorkerState(worker.id, "busy"); world.setTaskState(task.id, "running"); world.setResourceState(resource.id, "in-use");
const driver = await PlaywrightBrowserPage.launch({ browser, resourceId: resource.id });
const page = (driver as unknown as { page: Page }).page;
const signal = () => new AbortController().signal;
const frames: Buffer[] = [];
const screenshot = page.screenshot.bind(page);
page.screenshot = async (...args: Parameters<Page["screenshot"]>) => {
  const bytes = await screenshot(...args); frames.push(bytes); return bytes;
};
const click: AutonomousBrowserTaskOptions["decisions"] = { async decide(_g, o) {
  return { type: "click", targetId: "e1", observationRevision: o.revision };
} };
const save: AutonomousBrowserTaskOptions["decisions"] = { async decide(_g, o) {
  return o.text.includes("Saved") ? { type: "finish", observationRevision: o.revision }
    : { type: "click", targetId: "e1", observationRevision: o.revision };
} };
const run = (options: Partial<AutonomousBrowserTaskOptions> = {}) => new AutonomousBrowserTask({ world,
  workerId: worker.id, taskId: task.id, resourceId: resource.id, observations: driver, executor: driver,
  decisions: click, maxSteps: 5, ...options }).run("Controlled acceptance");
const saved = () => createBrowserOutcomeVerifier(driver, { all: [{ kind: "text", includes: "Saved" }] });
const passed = (name: string) => {
  assert.equal(page.isClosed(), false);
  assert.equal(browser.contexts().length, 1);
  assert.ok(frames.every(bytes => bytes.every(b => b === 0)), "owned frame bytes must be zeroed");
  frames.length = 0;
  console.log(JSON.stringify({ case: name, status: "passed", pageAlive: true, contexts: 1 }));
};
const category = (code: string) => (error: unknown) => {
  assert.ok(error instanceof PerceptionFailure);
  assert.equal(error.diagnostic.source, "environment");
  assert.equal(error.diagnostic.code, code);
  assert.equal(error.diagnostic.capture?.pageAlive, true);
  return true;
};

try {
  await page.setContent('<button onclick="document.querySelector(\'output\').textContent=\'Saved\'">Save</button><output></output>');
  const effective = await run({ decisions: save, goalVerifier: saved(), maxSteps: 2 });
  assert.equal(effective.state, "completed");
  assert.equal(effective.evidence[0]!.execution, "accepted");
  assert.equal(effective.evidence[0]!.changed, true);
  assert.ok(effective.evidence[0]!.afterObservation!.revision > effective.evidence[0]!.beforeObservation.revision);
  assert.equal(effective.evidence[1]!.goalVerification, "verified");
  passed("effective action produces a fresh after-observation");

  for (const required of [true, false]) {
    await page.setContent('<button aria-label="Only">Only</button>');
    let calls = 0;
    const result = await run({ visual: { policy: { required, onNoEffect: true, maxCalls: 1 }, captures: driver,
      provider: { async perceive() { calls++; return []; } } } });
    assert.equal(result.state, "failed"); assert.equal(calls, 1);
    if (result.state === "failed") {
      assert.match(result.error, required ? /budget exhausted/ : /no observable progress/);
      if (!required) assert.deepEqual(result.diagnostic, { kind: "browser-failure", code: "stalled" });
    }
    assert.equal(result.evidence.length, required ? 1 : 3);
    assert.ok(result.evidence.every(e => e.execution === "accepted" && e.afterObservation && !e.changed));
    passed(required ? "required perception budget remains finite" : "no-effect reaches truthful bounded stall");
  }

  await page.setContent('<main><button>Edit</button><button>Edit</button></main><output></output>');
  const old = await driver.observe(signal());
  const oldHash = await driver.withViewportCapture(old, signal(), async (_b, p) => p.imageHash);
  await page.evaluate(() => {
    const main = document.querySelector("main")!;
    main.insertBefore(main.lastElementChild!, main.firstElementChild);
  });
  const fresh = await driver.observe(signal());
  assert.equal(fresh.fingerprint, old.fingerprint);
  assert.equal(await driver.withViewportCapture(fresh, signal(), async (_b, p) => p.imageHash), oldHash);
  assert.deepEqual(await driver.execute({ type: "click", targetId: "e1", observationRevision: old.revision }, old, signal()),
    { state: "rejected-before-mutation", reason: "stale-observation" });
  await assert.rejects(driver.withViewportCapture(old, signal(), async () => []), category("target-stale"));
  await assert.rejects(driver.withViewportCapture(structuredClone(fresh), signal(), async () => []), category("observation-stale"));
  passed("identical-looking swapped targets remain stale before dispatch");

  await page.setContent(`<button>Save</button><output></output><script>
    window.clicks=0;document.querySelector('button').onclick=()=>{window.clicks++;
    setTimeout(()=>document.querySelector('output').textContent='Saved',250);};</script>`);
  const delayed = await run({ decisions: save, goalVerifier: saved(), maxSteps: 2 });
  assert.equal(delayed.state, "completed");
  assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 1);
  assert.equal(delayed.evidence[0]!.changed, true);
  passed("delayed effect is observed without replaying the click");

  await page.setContent(`<button aria-label="Choose"><canvas width="80" height="80"></canvas></button>
    <button aria-label="Choose"><canvas width="80" height="80"></canvas></button><output></output><script>
    document.querySelectorAll('canvas').forEach((c,i)=>{const ctx=c.getContext('2d');
    ctx.fillStyle=i?'blue':'red';ctx.fillRect(0,0,80,80);c.parentElement.onclick=()=>{
    document.querySelector('output').textContent=i?'Saved':'Wrong';document.querySelectorAll('button').forEach(b=>b.remove());};});</script>`);
  let visualCalls = 0;
  const visual = await run({ maxSteps: 2, goalVerifier: saved(),
    decisions: { async decide(_g, o, _h, _s, envelope) {
      if (o.text.includes("Saved")) return { type: "finish", observationRevision: o.revision };
      assert.ok(envelope?.facts.length);
      return { type: "click", targetId: envelope.facts[0]!.candidateTargetIds[0]!, observationRevision: o.revision };
    } },
    visual: { policy: { onAmbiguity: true, maxCalls: 1 }, captures: driver, provider: { async perceive(input) {
      visualCalls++;
      // Deterministic perception reads supplied pixels, not hidden fixture state.
      const index = await page.evaluate(async ({ url, boxes }) => {
        const img = new Image(); img.src = url; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const ctx = c.getContext("2d")!; ctx.drawImage(img, 0, 0);
        return boxes.findIndex(b => { const p = ctx.getImageData(b.x+b.width/2,b.y+b.height/2,1,1).data;
          return p[2]! > 200 && p[0]! < 30; });
      }, { url: `data:image/png;base64,${Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength).toString("base64")}`,
        boxes: input.observation.elements.map(e => e.bounds!) });
      assert.ok(index >= 0);
      const target = input.observation.elements[index]!;
      assert.ok(target.bounds);
      return [{ text: "BLUE", candidateTargetIds: [target.id], region: target.bounds }];
    } } } });
  assert.equal(visual.state, "completed"); assert.equal(visualCalls, 1);
  assert.equal(visual.evidence[0]!.changed, true);
  passed("pixel-only distinction selects an exact owned DOM target");

  // Exercise acquisition stabilization directly, without the post-action DOM wait masking it.
  await page.setContent('<button>Only</button><canvas width="80" height="80"></canvas>');
  const settling = await driver.observe(signal());
  await page.evaluate(() => {
    const ctx = document.querySelector("canvas")!.getContext("2d")!;
    let frame = 0;
    const timer = setInterval(() => {
      ctx.fillStyle = `rgb(${++frame * 10},0,0)`; ctx.fillRect(0,0,80,80);
      if (frame === 20) { clearInterval(timer); ctx.clearRect(0,0,80,80); }
    }, 20);
  });
  let consumes = 0;
  await driver.withViewportCapture(settling, signal(), async () => { consumes++; return []; });
  assert.equal(consumes, 1);
  assert.ok(frames.length > 3, "real changing frames must stabilize before perception");
  passed("transient pixels stabilize before the sole perception call");

  const unchanged = await driver.observe(signal());
  await assert.rejects(driver.withViewportCapture(unchanged, signal(), async () => {
    await page.locator("canvas").evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.fillRect(0,0,80,80));
    return [];
  }), category("visual-stale"));
  assert.equal((await driver.observe(signal())).fingerprint, unchanged.fingerprint);
  passed("pixel changes during perception still fail post-image freshness");

  const dispatch = await driver.observe(signal());
  await driver.withViewportCapture(dispatch, signal(), async () => []);
  await page.locator("canvas").evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.clearRect(0,0,80,80));
  assert.deepEqual(await driver.execute({ type: "click", targetId: "e1", observationRevision: dispatch.revision }, dispatch, signal()),
    { state: "rejected-before-mutation", reason: "stale-observation" });
  passed("pixel freshness remains enforced at action dispatch");

  await page.setContent('<output>Saved</output>');
  let observations = 0;
  const disappearing = await run({ maxSteps: 1, decisions: save, goalVerifier: saved(), observations: { async observe(s) {
    if (++observations === 3) await page.locator("output").evaluate(node => node.textContent = "Lost");
    return driver.observe(s);
  } } });
  assert.equal(disappearing.state, "failed");
  assert.equal(disappearing.evidence[0]!.goalVerification, "not-verified");
  passed("disappearing finish success cannot acquire verified evidence");

  await page.setContent('<button>Only</button>');
  const before = await driver.observe(signal());
  const controller = new AbortController();
  const pending = driver.observeAfterAction(before, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  passed("post-action sampling respects cancellation");
  assert.equal(world.inspect().goals.length, 0);
} finally {
  await driver.close();
  assert.equal((driver as unknown as { targetSets: Set<unknown> }).targetSets.size, 0);
  assert.equal(browser.contexts().length, 0);
  assert.equal(browser.isConnected(), true);
  console.log(JSON.stringify({ cleanup: "passed", contexts: 0, retainedTargetSets: 0, sharedBrowserAlive: true }));
  await browser.close(); // Disconnect this client; only the controlled owner can terminate the process.
}

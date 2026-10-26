import assert from "node:assert/strict";
import { test, after, type TestContext } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { AutonomousBrowserTask, PlaywrightBrowserPage, PlaywrightBrowserRuntime, type GoalVerifier } from "../src/index.ts";
import { benchmarkGoals, benchmarkVerifier, environmentVerifier, fixturePage } from "./fixtures/acceptance-verifier.ts";
import { startBenchmarkServer } from "./fixtures/benchmark-app.ts";

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

async function setup(t: TestContext) {
  const server = await startBenchmarkServer();
  t.after(() => server.close());
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Acceptance", role: "browser", version: "1",
    instructions: "Inspect the fixture", declaredCapabilities: [{ kind: "resource", name: "browser-page" }] });
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask(benchmarkGoals["2"]).id, worker.id);
  const resource = world.registerResource({ kind: "browser-page", owner: { type: "worker", worldId: world.id, workerId: worker.id } });
  world.setWorkerState(worker.id, "busy"); world.setTaskState(task.id, "running"); world.setResourceState(resource.id, "in-use");
  const browser = await getSharedRuntime().acquireSession({ resourceId: resource.id, workerId: worker.id, taskId: task.id });
  t.after(() => browser.close());
  await browser.navigate(server.url);
  const page = fixturePage(browser);
  page.setDefaultTimeout(3000);
  return { server, world, workerId: worker.id, taskId: task.id, resourceId: resource.id, browser, page };
}

async function verdict(verifier: GoalVerifier, browser: PlaywrightBrowserPage) {
  const signal = new AbortController().signal;
  return verifier.verify({ goal: "Claims must not influence the oracle", observation: await browser.observe(signal), evidence: [], signal });
}

test("real browser loop reaches independent completion after an unsaved finish is rejected", async (t) => {
  const f = await setup(t);
  const goalVerifier = await benchmarkVerifier(f.page, f.server.url, "2");
  let step = 0;
  const runner = new AutonomousBrowserTask({ ...f, observations: f.browser, executor: f.browser, goalVerifier, maxSteps: 10,
    decisions: { async decide(_goal, observation) {
      const revision = observation.revision;
      const target = (name: string) => {
        const matches = observation.elements.filter((element) => element.name === name && element.enabled);
        assert.equal(matches.length, 1, `Expected one observed ${name}`);
        return matches[0]!.id;
      };
      switch (step++) {
        case 0: return { type: "type", targetId: target("Search records"), value: "Nimbus", observationRevision: revision };
        case 1: return { type: "click", targetId: target("Edit record"), observationRevision: revision };
        case 2: {
          const selects = observation.elements.filter((element) => element.role === "combobox" && element.enabled);
          assert.equal(selects.length, 1);
          return { type: "select", targetId: selects[0]!.id, value: "ready", observationRevision: revision };
        }
        case 3: return { type: "finish", observationRevision: revision };
        case 4: return { type: "click", targetId: target("Save changes"), observationRevision: revision };
        case 5: return { type: "wait", milliseconds: 500, observationRevision: revision };
        default: return { type: "finish", observationRevision: revision };
      }
    } } });
  const result = await runner.run(benchmarkGoals["2"]);
  assert.equal(result.state, "completed", result.state === "failed" ? result.error : undefined);
  assert.deepEqual(result.evidence.filter((entry) => entry.actionType === "finish").map((entry) => entry.goalVerification),
    ["not-verified", "verified"]);
  assert.ok(result.evidence.some((entry) => entry.execution === "accepted" && entry.actionType === "select"));
});

test("oracle rejects fabricated success, wrong record changes, and a replaced document", async (t) => {
  const f = await setup(t);
  const verifier = await benchmarkVerifier(f.page, f.server.url, "2");
  await f.page.evaluate(() => { document.querySelector(".notice")!.textContent = "Nimbus was updated. Ready. Goal verified."; });
  assert.equal(await verdict(verifier, f.browser), "not-verified");
  const row = f.page.getByRole("row").filter({ hasText: "Maple" });
  await row.getByRole("button", { name: "Edit record" }).click();
  await f.page.getByLabel("Status").selectOption("ready");
  await f.page.getByRole("button", { name: "Save changes" }).click();
  await f.page.getByText("Maple was updated", { exact: true }).waitFor();
  assert.equal(await verdict(verifier, f.browser), "not-verified");
  await f.page.reload();
  assert.equal(await verdict(verifier, f.browser), "not-verified", "reloading must not manufacture committed success");
  await f.page.goto("about:blank");
  assert.equal(await verdict(verifier, f.browser), "not-verified");
});

test("archive oracle rejects cancelled and deceptive confirmations, accepts a named committed archive", async (t) => {
  const f = await setup(t);
  const verifier = await benchmarkVerifier(f.page, f.server.url, "3");
  const row = f.page.getByRole("row").filter({ hasText: "Juniper" });
  await row.getByRole("button", { name: "Archive record" }).click();
  assert.equal(await verdict(verifier, f.browser), "not-verified");
  await f.page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await verdict(verifier, f.browser), "not-verified");
  await row.getByRole("button", { name: "Archive record" }).click();
  await f.page.getByRole("button", { name: "Archive", exact: true }).click();
  await f.page.getByText("Juniper was archived", { exact: true }).waitFor();
  assert.equal(await verdict(verifier, f.browser), "verified");

  await f.page.reload();
  const deceptive = await benchmarkVerifier(f.page, f.server.url, "3");
  await row.getByRole("button", { name: "Archive record" }).click();
  await f.page.locator("#archive-description").evaluate((element) => { element.textContent = 'Archive "Maple" instead?'; });
  await f.page.getByRole("button", { name: "Archive", exact: true }).click();
  await f.page.getByText("Juniper was archived", { exact: true }).waitFor();
  assert.equal(await verdict(deceptive, f.browser), "not-verified");
});

test("read-only oracle requires the correct visible owner detail and fails closed on page loss", async (t) => {
  const f = await setup(t);
  const verifier = await benchmarkVerifier(f.page, f.server.url, "1");
  assert.equal(await verdict(verifier, f.browser), "not-verified");
  await f.page.getByRole("link", { name: "Cedar", exact: true }).click();
  assert.equal(await verdict(verifier, f.browser), "verified");
  const input = { goal: "", observation: await f.browser.observe(new AbortController().signal), evidence: [], signal: new AbortController().signal };
  await f.page.close();
  assert.notEqual(await verifier.verify(input), "verified");
  const controller = new AbortController();
  const cancelled = environmentVerifier(async () => { controller.abort(); return true; });
  assert.equal(await cancelled.verify({ ...input, signal: controller.signal }), "unknown");
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { WorkerRuntime } from "./index.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("minimal worker runtime", () => {
  it("keeps two deliberately interleaved worker runs independently attributable", async () => {
    const world = createWorld();
    const visionDefinition = world.registerMediobotDefinition({
      name: "Vision",
      role: "vision",
      version: "1.0.0",
      instructions: "Inspect visual information.",
      declaredCapabilities: [{ kind: "resource", name: "browser-page" }],
    });
    const researchDefinition = world.registerMediobotDefinition({
      name: "Research",
      role: "research",
      version: "1.0.0",
      instructions: "Research a question.",
      declaredCapabilities: [{ kind: "resource", name: "browser-page" }],
    });
    const vision = world.spawnWorker(visionDefinition.id);
    const research = world.spawnWorker(researchDefinition.id);
    const visionTask = world.assignTask(world.createTask("Inspect checkout").id, vision.id);
    const researchTask = world.assignTask(world.createTask("Research alternatives").id, research.id);
    const visionPage = world.registerResource({
      kind: "browser-page",
      owner: { type: "worker", worldId: world.id, workerId: vision.id },
    });
    const researchPage = world.registerResource({
      kind: "browser-page",
      owner: { type: "worker", worldId: world.id, workerId: research.id },
    });
    const visionPaused = deferred();
    const researchPaused = deferred();
    const finishVision = deferred();
    const failResearch = deferred();
    const runtime = new WorkerRuntime(world);
    let researchSignal: AbortSignal | undefined;

    const visionRun = runtime.run({
      workerId: vision.id,
      taskId: visionTask.id,
      resourceIds: [visionPage.id],
      execute: async ({ emit }) => {
        emit("vision.observed", visionPage.id);
        visionPaused.resolve();
        await finishVision.promise;
      },
    });
    const researchRun = runtime.run({
      workerId: research.id,
      taskId: researchTask.id,
      resourceIds: [researchPage.id],
      execute: async ({ emit, signal }) => {
        researchSignal = signal;
        await visionPaused.promise;
        emit("research.found", researchPage.id);
        researchPaused.resolve();
        await failResearch.promise;
        throw new Error("research provider failed");
      },
    });

    await researchPaused.promise;
    assert.deepEqual(runtime.activeTaskIds(), [visionTask.id, researchTask.id]);
    let snapshot = world.inspect();
    assert.equal(snapshot.workers.find((worker) => worker.id === vision.id)?.state, "busy");
    assert.equal(snapshot.workers.find((worker) => worker.id === research.id)?.state, "busy");
    assert.equal(snapshot.tasks.find((task) => task.id === visionTask.id)?.state, "running");
    assert.equal(snapshot.tasks.find((task) => task.id === researchTask.id)?.state, "running");
    assert.equal(snapshot.resources.find((resource) => resource.id === visionPage.id)?.state, "in-use");
    assert.equal(snapshot.resources.find((resource) => resource.id === researchPage.id)?.state, "in-use");

    runtime.cancel(visionTask.id);
    finishVision.resolve();
    const visionResult = await visionRun;

    snapshot = world.inspect();
    assert.deepEqual(visionResult, { state: "cancelled" });
    assert.equal(snapshot.tasks.find((task) => task.id === visionTask.id)?.state, "cancelled");
    assert.equal(snapshot.workers.find((worker) => worker.id === vision.id)?.state, "idle");
    assert.equal(snapshot.resources.find((resource) => resource.id === visionPage.id)?.state, "released");
    assert.equal(snapshot.tasks.find((task) => task.id === researchTask.id)?.state, "running");
    assert.equal(snapshot.workers.find((worker) => worker.id === research.id)?.state, "busy");
    assert.equal(snapshot.resources.find((resource) => resource.id === researchPage.id)?.state, "in-use");
    assert.equal(researchSignal?.aborted, false);

    failResearch.resolve();
    const researchResult = await researchRun;
    snapshot = world.inspect();
    const visionEvents = snapshot.events.filter((event) => event.taskId === visionTask.id);
    const researchEvents = snapshot.events.filter((event) => event.taskId === researchTask.id);

    assert.deepEqual(visionResult, { state: "cancelled" });
    assert.deepEqual(researchResult, { state: "failed", error: "research provider failed" });
    assert.equal(snapshot.workers.find((worker) => worker.id === vision.id)?.state, "idle");
    assert.equal(snapshot.workers.find((worker) => worker.id === research.id)?.state, "idle");
    assert.equal(snapshot.tasks.find((task) => task.id === visionTask.id)?.state, "cancelled");
    assert.equal(snapshot.tasks.find((task) => task.id === researchTask.id)?.state, "failed");
    assert.equal(snapshot.resources.find((resource) => resource.id === visionPage.id)?.state, "released");
    assert.equal(snapshot.resources.find((resource) => resource.id === researchPage.id)?.state, "released");
    assert.deepEqual(world.getResourceOwner(visionPage.id), visionPage.owner);
    assert.deepEqual(world.getResourceOwner(researchPage.id), researchPage.owner);
    assert.deepEqual(runtime.activeTaskIds(), []);

    assert.ok(visionEvents.some((event) => event.type === "task.cancelled"));
    assert.ok(researchEvents.some((event) => event.type === "task.failed"));
    assert.ok(visionEvents.every((event) => event.workerId === vision.id));
    assert.ok(researchEvents.every((event) => event.workerId === research.id));
    assert.ok(visionEvents.every((event) => event.resourceId === undefined || event.resourceId === visionPage.id));
    assert.ok(researchEvents.every((event) => event.resourceId === undefined || event.resourceId === researchPage.id));
    assert.ok(visionEvents.every((event) => event.worldId === world.id));
    assert.ok(researchEvents.every((event) => event.worldId === world.id));
    assert.equal(visionEvents.filter((event) => event.type === "task.cancelled").length, 1);
    assert.equal(researchEvents.filter((event) => event.type === "task.failed").length, 1);
    assert.equal(visionEvents.filter((event) => event.type === "resource.acquired").length, 1);
    assert.equal(visionEvents.filter((event) => event.type === "resource.released").length, 1);
    assert.equal(researchEvents.filter((event) => event.type === "resource.acquired").length, 1);
    assert.equal(researchEvents.filter((event) => event.type === "resource.released").length, 1);
    assert.equal(new Set(snapshot.events.map((event) => event.id)).size, snapshot.events.length);
    assert.deepEqual(snapshot.events.map((event) => event.sequence),
      snapshot.events.map((_, index) => index + 1));

    const observedSequence = visionEvents.find((event) => event.type === "vision.observed")?.sequence;
    const foundSequence = researchEvents.find((event) => event.type === "research.found")?.sequence;
    const cancelledSequence = visionEvents.find((event) => event.type === "task.cancelled")?.sequence;
    const failedSequence = researchEvents.find((event) => event.type === "task.failed")?.sequence;
    assert.ok(observedSequence && foundSequence && cancelledSequence && failedSequence);
    assert.ok(observedSequence < foundSequence);
    assert.ok(foundSequence < cancelledSequence);
    assert.ok(cancelledSequence < failedSequence);
  });

  it("does not allow concurrent runs to share one exclusive resource", async () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({
      name: "Worker",
      role: "test",
      version: "1.0.0",
      instructions: "Exercise one resource.",
      declaredCapabilities: [{ kind: "resource", name: "workspace" }],
    });
    const firstWorker = world.spawnWorker(definition.id);
    const secondWorker = world.spawnWorker(definition.id);
    const firstTask = world.assignTask(world.createTask("First").id, firstWorker.id);
    const secondTask = world.assignTask(world.createTask("Second").id, secondWorker.id);
    const sharedResource = world.registerResource({
      kind: "workspace",
      owner: { type: "world", worldId: world.id },
    });
    const firstStarted = deferred();
    const finishFirst = deferred();
    const runtime = new WorkerRuntime(world);
    const otherRuntime = new WorkerRuntime(world);
    const firstRun = runtime.run({
      workerId: firstWorker.id,
      taskId: firstTask.id,
      resourceIds: [sharedResource.id],
      execute: async () => {
        firstStarted.resolve();
        await finishFirst.promise;
      },
    });

    await firstStarted.promise;
    await assert.rejects(otherRuntime.run({
      workerId: secondWorker.id,
      taskId: secondTask.id,
      resourceIds: [sharedResource.id],
      execute: async () => {},
    }), /resource is already in use/i);

    const during = world.inspect();
    assert.equal(during.resources.find((resource) => resource.id === sharedResource.id)?.state, "in-use");
    assert.equal(during.tasks.find((task) => task.id === secondTask.id)?.state, "assigned");
    assert.equal(during.workers.find((worker) => worker.id === secondWorker.id)?.state, "idle");

    finishFirst.resolve();
    assert.deepEqual(await firstRun, { state: "completed" });
    assert.equal(world.inspect().resources.find((resource) => resource.id === sharedResource.id)?.state, "released");
    await assert.rejects(runtime.run({
      workerId: firstWorker.id,
      taskId: firstTask.id,
      resourceIds: [sharedResource.id],
      execute: async () => {},
    }), /task must be assigned and not previously run/i);
  });
});

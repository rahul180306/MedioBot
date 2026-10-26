import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createWorld } from "./index.ts";

const capability = {
  kind: "resource",
  name: "browser",
  description: "May use browser resources",
} as const;

function setup() {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({
    name: "Vision",
    role: "vision",
    version: "1.0.0",
    instructions: "Inspect visual information.",
    declaredCapabilities: [capability],
  });
  return { world, definition };
}

describe("V2 world ownership foundation", () => {
  it("creates independent workers from one definition", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);

    world.setWorkerState(first.id, "busy");

    assert.notEqual(first.id, second.id);
    assert.equal(world.inspect().workers.find((worker) => worker.id === first.id)?.state, "busy");
    assert.equal(world.inspect().workers.find((worker) => worker.id === second.id)?.state, "idle");
  });

  it("allows two workers to own separate browser contexts", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);

    const firstContext = world.registerResource({
      kind: "browser-context",
      owner: { type: "worker", worldId: world.id, workerId: first.id },
    });
    const secondContext = world.registerResource({
      kind: "browser-context",
      owner: { type: "worker", worldId: world.id, workerId: second.id },
    });

    assert.notEqual(firstContext.id, secondContext.id);
    assert.deepEqual(firstContext.owner, { type: "worker", worldId: world.id, workerId: first.id });
    assert.deepEqual(secondContext.owner, { type: "worker", worldId: world.id, workerId: second.id });
  });

  it("does not return another worker's resources", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const resource = world.registerResource({
      kind: "browser-page",
      owner: { type: "worker", worldId: world.id, workerId: first.id },
    });

    assert.deepEqual(world.getResourcesByOwner({ type: "worker", worldId: world.id, workerId: first.id }), [resource]);
    assert.deepEqual(world.getResourcesByOwner({ type: "worker", worldId: world.id, workerId: second.id }), []);
    assert.deepEqual(world.getResourceOwner(resource.id), resource.owner);
  });

  it("does not expose mutable ownership records", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const resource = world.registerResource({
      kind: "browser-page",
      owner: { type: "worker", worldId: world.id, workerId: first.id },
    });

    (resource.owner as { workerId: string }).workerId = second.id;

    assert.deepEqual(world.getResourceOwner(resource.id), {
      type: "worker",
      worldId: world.id,
      workerId: first.id,
    });
  });

  it("keeps tasks assigned to different workers independently attributable", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const firstTask = world.createTask("Inspect screenshot");
    const secondTask = world.createTask("Read page structure");

    const assignedFirst = world.assignTask(firstTask.id, first.id);
    const assignedSecond = world.assignTask(secondTask.id, second.id);

    assert.equal(assignedFirst.assignedWorkerId, first.id);
    assert.equal(assignedSecond.assignedWorkerId, second.id);
  });

  it("preserves evidence producer and task attribution", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const firstTask = world.assignTask(world.createTask("Inspect A").id, first.id);
    const secondTask = world.assignTask(world.createTask("Inspect B").id, second.id);

    const evidence = world.recordEvidence({
      taskId: firstTask.id,
      workerId: first.id,
      source: { type: "observation", reference: "frame-1" },
      content: "Button is visible",
    });

    assert.equal(evidence.workerId, first.id);
    assert.equal(evidence.taskId, firstTask.id);
    assert.throws(() => world.recordEvidence({
      taskId: secondTask.id,
      workerId: first.id,
      source: { type: "observation", reference: "frame-2" },
      content: "Wrong producer",
    }), /assigned to the producing worker/i);
  });

  it("retains attribution for interleaved worker events", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const firstTask = world.assignTask(world.createTask("Task A").id, first.id);
    const secondTask = world.assignTask(world.createTask("Task B").id, second.id);

    const events = [
      world.appendEvent({ type: "task.started", workerId: first.id, taskId: firstTask.id }),
      world.appendEvent({ type: "task.started", workerId: second.id, taskId: secondTask.id }),
      world.appendEvent({ type: "task.progressed", workerId: first.id, taskId: firstTask.id }),
      world.appendEvent({ type: "task.progressed", workerId: second.id, taskId: secondTask.id }),
    ];

    assert.ok(events.every((event) => event.worldId === world.id));
    assert.ok(events.filter((event) => event.workerId === first.id).every((event) => event.taskId === firstTask.id));
    assert.ok(events.filter((event) => event.workerId === second.id).every((event) => event.taskId === secondTask.id));
  });

  it("rejects an event that attributes another worker's resource", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const firstTask = world.assignTask(world.createTask("Task A").id, first.id);
    const secondResource = world.registerResource({
      kind: "model-session",
      owner: { type: "worker", worldId: world.id, workerId: second.id },
    });

    assert.throws(() => world.appendEvent({
      type: "resource.used",
      workerId: first.id,
      taskId: firstTask.id,
      resourceId: secondResource.id,
    }), /resource owner does not match/i);
  });

  it("keeps task identity independent from worker identity", () => {
    const { world, definition } = setup();
    const worker = world.spawnWorker(definition.id);
    const firstTask = world.createTask("First task");
    const secondTask = world.createTask("Second task");

    assert.notEqual(firstTask.id, worker.id);
    assert.notEqual(secondTask.id, worker.id);
    assert.notEqual(firstTask.id, secondTask.id);
  });

  it("supports world, worker, and task ownership and artifact attribution", () => {
    const { world, definition } = setup();
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Produce report").id, worker.id);
    const worldResource = world.registerResource({
      kind: "workspace",
      owner: { type: "world", worldId: world.id },
    });
    const taskResource = world.registerResource({
      kind: "terminal",
      owner: { type: "task", worldId: world.id, taskId: task.id },
    });
    const artifact = world.recordArtifact({
      taskId: task.id,
      workerId: worker.id,
      name: "report",
      reference: "memory:report-1",
    });

    assert.deepEqual(world.getResourcesByOwner(worldResource.owner), [worldResource]);
    assert.deepEqual(world.getResourcesByOwner(taskResource.owner), [taskResource]);
    assert.equal(artifact.worldId, world.id);
    assert.equal(artifact.taskId, task.id);
    assert.equal(artifact.workerId, worker.id);
  });

  it("contains no platform-specific domain assumptions", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

    assert.doesNotMatch(source, /macos|windows|darwin|win32|keyboard|playwright|cdp|browser-driver|\\\\|\/Users\//i);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { worldProductEvent, visionProductEvent } from "../../src/events.ts";
import { createWorld } from "@mediobot-v2/domain";

test("product mapper allowlists fields and omits sensitive Vision diagnostics", () => {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Vision", role: "browser", version: "1", instructions: "", declaredCapabilities: [] });
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask("secret goal").id, worker.id);
  const bad = visionProductEvent(world.id, task.id, worker.id, { type: "failed", message: "<think>provider leaked</think>", targetId: "secret target",
    diagnostic: { kind: "invalid-model-action", characterCount: 44, keys: ["token", "password"] } });
  assert.deepEqual(Object.keys(bad ?? {}).sort(), ["error", "id", "occurredAt", "taskId", "type", "workerId", "worldId"].sort());
  assert.equal(bad?.error?.message, "Vision could not produce a valid browser action.");
  assert.equal(JSON.stringify(bad).includes("think"), false);
  assert.equal(JSON.stringify(bad).includes("password"), false);
  assert.equal(JSON.stringify(bad).includes("secret target"), false);
});

test("world mapper ignores internal resource events and strips arbitrary properties", () => {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Vision", role: "browser", version: "1", instructions: "", declaredCapabilities: [] });
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask("goal").id, worker.id);
  const event = world.appendEvent({ type: "task.started", workerId: worker.id, taskId: task.id }) as typeof world extends never ? never : ReturnType<typeof world.appendEvent>;
  const state = world.inspect();
  assert.equal(worldProductEvent({ ...event, type: "resource.acquired", toolName: "secret-tool" }, state.definitions, state.workers, state.tasks), undefined);
  const taskStarted = worldProductEvent({ ...event, toolName: "secret-tool" }, state.definitions, state.workers, state.tasks);
  assert.deepEqual(Object.keys(taskStarted ?? {}).sort(), ["activityState", "id", "occurredAt", "sequence", "taskId", "type", "workerDefinitionId", "workerId", "workerName", "worldId"].sort());
  assert.equal(taskStarted?.activityState, "thinking");
  assert.equal(JSON.stringify(taskStarted).includes("secret-tool"), false);
});

test("goal verification maps to a small product event without forwarding evidence or observation content", () => {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Vision", role: "browser", version: "1", instructions: "", declaredCapabilities: [] });
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask("goal").id, worker.id);
  const event = visionProductEvent(world.id, task.id, worker.id, { type: "goal-verified", step: 4,
    actionType: "finish", observationSummary: "private page content", message: "<think>hidden</think>" });
  assert.equal(event?.type, "worker.goal-verified");
  assert.deepEqual(Object.keys(event ?? {}).sort(), ["actionType", "id", "occurredAt", "step", "taskId", "type", "workerId", "worldId"].sort());
  assert.equal(JSON.stringify(event).includes("private page content"), false);
  assert.equal(JSON.stringify(event).includes("think"), false);
});

test("Maestro assignment is attributed to the assigned Cody worker and child task", () => {
  const world = createWorld();
  const maestro = world.registerMediobotDefinition({ name: "Maestro", role: "orchestration", version: "1", instructions: "", declaredCapabilities: [] });
  const cody = world.registerMediobotDefinition({ name: "Cody", role: "coding", version: "1", instructions: "", declaredCapabilities: [] });
  const maestroWorker = world.spawnWorker(maestro.id);
  const parent = world.assignTask(world.createTask("goal").id, maestroWorker.id);
  const childWorker = world.spawnWorker(cody.id);
  const child = world.assignTask(world.createTask("subtask", parent.id).id, childWorker.id);
  const event = world.appendEvent({ type: "maestro.worker-assigned", workerId: maestroWorker.id, taskId: parent.id });
  const state = world.inspect();
  const mapped = worldProductEvent(event, state.definitions, state.workers, state.tasks);
  assert.equal(mapped?.type, "worker.assigned");
  assert.equal(mapped?.taskId, parent.id);
  assert.equal(mapped?.executionTaskId, child.id);
  assert.equal(mapped?.workerId, childWorker.id);
  assert.equal(mapped?.workerName, "Cody");
});

test("worldProductEvent replaces internal task failure details with a safe product message", () => {
  const world = createWorld();
  const cody = world.registerMediobotDefinition({ name: "Cody", role: "coding", version: "1", instructions: "", declaredCapabilities: [] });
  const worker = world.spawnWorker(cody.id);
  const task = world.assignTask(world.createTask("task").id, worker.id);
  const event = world.appendEvent({
    type: "task.failed",
    workerId: worker.id,
    taskId: task.id,
    error: "Cody returned an invalid tool decision (decision-shape: unsupported-or-invalid-action)",
  });
  const state = world.inspect();
  const mapped = worldProductEvent(event, state.definitions, state.workers, state.tasks);
  assert.equal(mapped?.type, "task.failed");
  assert.equal(mapped?.error?.code, "execution_failed");
  assert.equal(mapped?.error?.message, "Cody could not complete the task.");
});

test("repeated specialist actions are reported as the actual bounded failure, not a tool failure", () => {
  const world = createWorld();
  const maestro = world.registerMediobotDefinition({ name: "Maestro", role: "orchestration", version: "1", instructions: "", declaredCapabilities: [] });
  const cody = world.registerMediobotDefinition({ name: "Cody", role: "coding", version: "1", instructions: "", declaredCapabilities: [] });
  const parentWorker = world.spawnWorker(maestro.id);
  const parent = world.assignTask(world.createTask("goal").id, parentWorker.id);
  const worker = world.spawnWorker(cody.id);
  const child = world.assignTask(world.createTask("assignment", parent.id).id, worker.id);
  const event = world.appendEvent({ type: "task.failed", workerId: worker.id, taskId: child.id,
    error: "Cody repeated the same action without progress after recovery feedback (filesystem.list); the repeated tool operation was not executed." });
  const state = world.inspect();
  const mapped = worldProductEvent(event, state.definitions, state.workers, state.tasks);
  assert.equal(mapped?.type, "worker.failed");
  assert.equal(mapped?.error?.message, "Cody stopped after repeating filesystem.list despite recovery guidance; the repeated tool call was not executed.");
  assert.equal(mapped?.message, mapped?.error?.message);
  assert.equal(JSON.stringify(mapped).includes("could not complete the assignment"), false);
});

test("tool lifecycle requires invocation identity and excludes arbitrary output and command fields", () => {
  const world = createWorld();
  const cody = world.registerMediobotDefinition({ name: "Cody", role: "coding", version: "1", instructions: "", declaredCapabilities: [] });
  const worker = world.spawnWorker(cody.id);
  const task = world.assignTask(world.createTask("goal").id, worker.id);
  const started = world.appendEvent({ type: "tool.started", workerId: worker.id, taskId: task.id, toolName: "terminal.execute",
    command: "node -e synthetic-secret", outputLog: "synthetic-secret" });
  const state = world.inspect();
  assert.equal(worldProductEvent(started, state.definitions, state.workers, state.tasks), undefined);

  const completed = world.appendEvent({ type: "tool.completed", workerId: worker.id, taskId: task.id, toolName: "terminal.execute",
    toolInvocationId: "invocation-1", command: "node -e synthetic-secret", outputLog: "synthetic-secret" });
  const mapped = worldProductEvent(completed, state.definitions, state.workers, state.tasks);
  assert.equal(mapped?.toolInvocationId, "invocation-1");
  assert.equal(mapped?.activityState, "running");
  assert.equal("command" in (mapped ?? {}), false);
  assert.equal("outputLog" in (mapped ?? {}), false);
  assert.equal(JSON.stringify(mapped).includes("synthetic-secret"), false);
});

test("categorizeFailure maps worker and model failures to safe categories rather than generic runtime failure", async () => {
  const { categorizeFailure } = await import("../../src/failureCategories.ts");
  assert.equal(categorizeFailure("Cody returned an invalid tool decision (decision-shape: unsupported-or-invalid-action)"), "invalid model decision");
  assert.equal(categorizeFailure("Cody returned an invalid tool decision (decision-parse: invalid-json)"), "invalid model decision");
  assert.equal(categorizeFailure("Model response was not valid JSON"), "invalid model decision");
  assert.equal(categorizeFailure("Model response contained an incomplete reasoning block"), "invalid model decision");
  assert.equal(categorizeFailure("Cody must read a file before modifying it"), "tool rejected");
  assert.equal(categorizeFailure("Cannot modify \"test.js\" without reading it first"), "tool rejected");
  assert.equal(categorizeFailure("Cody could not complete the assigned work"), "tool failed");
  assert.equal(categorizeFailure("Cody could not complete the task"), "tool failed");
  assert.equal(categorizeFailure("Cody stopped after repeating filesystem.list despite recovery guidance"), "repeated action");
  assert.equal(categorizeFailure("Model request timed out"), "model unavailable");
  assert.equal(categorizeFailure({ message: "Cody returned an invalid tool decision" }), "invalid model decision");
});

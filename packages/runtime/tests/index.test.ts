import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { ResourceGovernor, RuntimeCapacityError, RuntimeTaskSubmission, WorkerRuntime, WorkerSuspensionError, projectSupervision, type SupervisionNotice } from "../src/index.ts";
import { NotificationWindow } from "../src/supervision.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("event-driven supervision seam", () => {
  function fixture(onSupervision?: (notice: SupervisionNotice) => void | Promise<void>) {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Test", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Run").id, worker.id);
    const runtime = new WorkerRuntime(world, { onSupervision });
    return { world, definition, worker, task, runtime, input: { workerId: worker.id, taskId: task.id, resourceIds: [] } };
  }

  it("records normal floods without wakes and only accumulates ordinary tool failures", async () => {
    const notices: SupervisionNotice[] = [];
    const f = fixture((notice) => { notices.push(notice); });
    await f.runtime.run({ ...f.input, execute: async ({ emit }) => {
      for (let i = 0; i < 1000; i++) {
        for (const type of ["tool.started", "tool.completed", "worker.progress", "unknown.failed"]) emit(type);
      }
      emit("tool.failed");
    } });
    assert.equal(notices.filter((n) => n.disposition === "wake").length, 0);
    assert.equal(notices.find((n) => n.event.type === "tool.failed")?.disposition, "accumulate");
  });

  it("coalesces worker and terminal failure even across a normal flood", async () => {
    const wakes: SupervisionNotice[] = [];
    const f = fixture((n) => { if (n.disposition === "wake") wakes.push(n); });
    assert.equal((await f.runtime.run({ ...f.input, execute: async ({ emit }) => {
      emit("worker.failed");
      for (let i = 0; i < 1000; i++) emit("tool.completed");
      emit("worker.failed");
      throw new Error("failed");
    } })).state, "failed");
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.event.taskId, f.task.id);
    assert.deepEqual(f.runtime.getSupervisionNotices([f.task.id]), [wakes[0]]);
  });

  it("retains bounded failure attention even when no observer callback is configured", async () => {
    const f = fixture();
    await f.runtime.run({ ...f.input, execute: async ({ emit }) => {
      emit("model.failed");
      emit("model.failed");
      emit("worker.failed");
    } });
    const notices = f.runtime.getSupervisionNotices([f.task.id]);
    assert.deepEqual(notices.map(notice => notice.disposition), ["wake", "wake"]);
    assert.deepEqual(notices.map(notice => "category" in notice ? notice.category : undefined), ["model", "worker"]);
    assert.deepEqual(f.runtime.getSupervisionNotices(["unrelated-task" as typeof f.task.id]), []);
  });

  it("notifies cancellation immediately at user priority, once through settlement", async () => {
    const wakes: SupervisionNotice[] = [];
    const gate = deferred();
    const f = fixture((n) => { if (n.disposition === "wake") wakes.push(n); });
    const result = f.runtime.run({ ...f.input, execute: async ({ emit }) => { emit("model.failed"); await gate.promise; } });
    f.runtime.cancel(f.task.id);
    f.runtime.cancel(f.task.id);
    assert.deepEqual(wakes.map((n) => n.priority), ["failure", "user"]);
    assert.equal(wakes[1]?.event.type, "task.cancel-requested");
    assert.equal(f.world.inspect().tasks[0]?.state, "running");
    gate.resolve();
    assert.deepEqual(await result, { state: "cancelled" });
    assert.equal(wakes.length, 2);
    assert.equal(f.world.inspect().events.filter((e) => e.type === "task.cancel-requested").length, 1);
  });

  it("propagates graph control signals only after releasing worker and resource leases", async () => {
    const f = fixture();
    const resource = f.world.registerResource({ kind: "workspace", owner: { type: "task", worldId: f.world.id, taskId: f.task.id } });
    const signal = Object.assign(new WorkerSuspensionError("LangGraph interrupt"), { control: true });
    await assert.rejects(f.runtime.run({ ...f.input, resourceIds: [resource.id],
      isControlSignal: error => error === signal,
      execute: async () => { throw signal; },
    }), error => error === signal);
    const snapshot = f.world.inspect();
    assert.equal(snapshot.tasks.find(task => task.id === f.task.id)?.state, "running", "an interrupt must not be misreported as failure");
    assert.equal(snapshot.workers.find(worker => worker.id === f.worker.id)?.state, "idle");
    assert.equal(snapshot.resources.find(entry => entry.id === resource.id)?.state, "released");
    assert.equal(snapshot.events.some(event => event.taskId === f.task.id && event.type === "task.failed"), false);
  });

  it("preserves child attribution and forwards an existing fact once without appending it", async () => {
    const notices: SupervisionNotice[] = [];
    const f = fixture((n) => { notices.push(n); });
    const child = f.world.spawnWorker(f.definition.id);
    const task = f.world.assignTask(f.world.createTask("Child").id, child.id);
    const event = f.world.appendEvent({ type: "worker.failed", workerId: child.id, taskId: task.id });
    const received: string[] = [];
    await f.runtime.run({ ...f.input, onEvent: (e) => { received.push(e.id); }, execute: async ({ forward }) => {
      forward(event); forward(event);
      forward(createWorld().appendEvent({ type: "worker.failed" }));
    } });
    assert.equal(received.filter((id) => id === event.id).length, 1);
    assert.deepEqual(notices.filter((n) => n.disposition === "wake").map((n) => n.event), [event]);
    assert.equal(f.world.inspect().events.filter((e) => e.id === event.id).length, 1);
  });

  it("isolates mutations in both observers for appended and forwarded facts", async () => {
    const notices: SupervisionNotice[] = [];
    const f = fixture((notice) => {
      notices.push(notice);
      Object.assign(notice.event, { type: "corrupted", id: "corrupted", taskId: "corrupted", workerId: "corrupted" });
    });
    const child = f.world.spawnWorker(f.definition.id);
    const task = f.world.assignTask(f.world.createTask("Child").id, child.id);
    const event = f.world.appendEvent({ type: "worker.failed", taskId: task.id, workerId: child.id });
    const original = { ...event };
    const received: typeof event[] = [];
    const result = await f.runtime.run({ ...f.input, onEvent: (observed) => {
      received.push({ ...observed });
      Object.assign(observed, { type: "observer-corrupted", id: "observer-corrupted", taskId: "observer-corrupted" });
    }, execute: async ({ forward, emit }) => {
      emit("tool.completed");
      forward(event);
      forward(event);
    } });
    assert.deepEqual(result, { state: "completed" });
    assert.deepEqual(event, original);
    assert.deepEqual(received.filter((entry) => entry.id === original.id), [original]);
    const stored = f.world.inspect().events;
    assert.deepEqual(received, [stored[1], stored[2], stored[0], stored[3]]);
    assert.ok(notices.every((notice) => notice.event.type === "corrupted"));
  });

  it("detaches projected notices from their source event", () => {
    const event = createWorld().appendEvent({ type: "tool.completed" });
    const notice = projectSupervision(event);
    Object.assign(event, { type: "changed" });
    assert.equal(notice.event.type, "tool.completed");
  });

  it("isolates throwing and rejected supervision observers from execution", async () => {
    for (const onSupervision of [() => { throw new Error("observer"); }, async () => { throw new Error("observer"); }]) {
      const f = fixture(onSupervision);
      assert.deepEqual(await f.runtime.run({ ...f.input, execute: async ({ emit }) => { emit("verification.failed"); } }), { state: "completed" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(f.runtime.activeTaskIds(), []);
    }
  });

  it("projects explicit failure categories and keeps notification memory bounded", () => {
    const world = createWorld();
    for (const category of ["model", "environment", "resource", "coordination", "verification", "worker", "tool"] as const) {
      const notice = projectSupervision(world.appendEvent({ type: category === "tool" ? "tool.escalated" : `${category}.failed` }));
      assert.equal(notice.disposition, "wake");
      assert.equal("category" in notice && notice.category, category);
    }
    const window = new NotificationWindow();
    assert.equal(window.accept("first"), true);
    assert.equal(window.accept("first"), false);
    for (let i = 0; i < 10000; i++) window.accept(String(i));
    assert.equal(window.size, NotificationWindow.capacity);
    assert.equal(window.accept("first"), true);
  });

  it("supervises submission failure and rejects cancellation of a settled task", async () => {
    const wakes: SupervisionNotice[] = [];
    const f = fixture((n) => { if (n.disposition === "wake") wakes.push(n); });
    const submission = new RuntimeTaskSubmission(f.world, f.runtime);
    submission.registerAdapter(f.definition.id, { prepare: () => { throw new Error("prepare failed"); } });
    const submitted = submission.submit({ definitionId: f.definition.id, goal: "Fail preparation" });
    assert.equal((await submitted.result).state, "failed");
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.event.taskId, submitted.task.id);
    let cancellationError: unknown;
    await f.runtime.run({ ...f.input, execute: async () => {}, onEvent: (event) => {
      if (event.type === "task.completed") {
        try { f.runtime.cancel(f.task.id); } catch (error) { cancellationError = error; }
      }
    } });
    assert.match(String(cancellationError), /not running/);
    assert.equal(f.world.inspect().events.some((event) => event.type === "task.cancel-requested"), false);
  });
});

it("keeps Governor capacity until an aborted execution and its cleanup have settled", async () => {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Slow", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
  const governor = new ResourceGovernor({ budget: { maxConcurrentTasks: 1 } });
  const runtime = new WorkerRuntime(world, { resourceGovernor: governor });
  const submission = new RuntimeTaskSubmission(world, runtime);
  const entered = deferred(); const cleanup = deferred(); let abortSeen = false;
  submission.registerAdapter(definition.id, { prepare: () => ({ resourceIds: [], execute: async ({ signal }) => {
    entered.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { abortSeen = true; resolve(); }, { once: true }));
    await cleanup.promise;
  } }) });
  const active = submission.submit({ definitionId: definition.id, goal: "Hold until abort cleanup" });
  await entered.promise;
  assert.equal(governor.activeCategoryCount("execution-slot"), 1);
  submission.cancel(active.task.id);
  assert.equal(abortSeen, true);
  assert.equal(governor.activeCategoryCount("execution-slot"), 1, "capacity stays reserved while cancelled work is still cleaning up");
  cleanup.resolve();
  assert.deepEqual(await active.result, { state: "cancelled" });
  assert.equal(governor.activeCategoryCount("execution-slot"), 0, "capacity releases after worker settlement");
  assert.deepEqual(runtime.activeTaskIds(), []);
  await governor.shutdown();
});

it("coordinates a specialist under a one-slot budget and cancels queued work without leaking admission", async () => {
  const world = createWorld();
  const coordinator = world.registerMediobotDefinition({ name: "Maestro", role: "orchestration", version: "1", instructions: "", declaredCapabilities: [] });
  const specialist = world.registerMediobotDefinition({ name: "Cody", role: "coding", version: "1", instructions: "", declaredCapabilities: [] });
  const governor = new ResourceGovernor({ budget: { maxConcurrentTasks: 1, maxConcurrentTasksPerWorkspace: 1 } });
  const runtime = new WorkerRuntime(world, { resourceGovernor: governor });
  const submission = new RuntimeTaskSubmission(world, runtime);
  let peakSlots = 0;
  let helperSettled = false;
  submission.registerAdapter(coordinator.id, { prepare: () => ({ resourceIds: [], execute: async () => {
    const worker = world.spawnWorker(specialist.id);
    const task = world.assignTask(world.createTask("Perform bounded specialist work").id, worker.id);
    await runtime.run({ workerId: worker.id, taskId: task.id, resourceIds: [], workspaceId: "one-slot",
      execute: async () => {
        peakSlots = Math.max(peakSlots, governor.activeCategoryCount("execution-slot"));
        const helper = world.spawnWorker(specialist.id);
        const helperTask = world.assignTask(world.createTask("Perform helper work").id, helper.id);
        await runtime.withYieldedExecutionSlot(task.id, async () => {
          assert.equal(governor.activeCategoryCount("execution-slot"), 0, "the waiting specialist returns its slot");
          assert.equal((await runtime.run({ workerId: helper.id, taskId: helperTask.id, resourceIds: [], workspaceId: "one-slot",
            execute: async () => { peakSlots = Math.max(peakSlots, governor.activeCategoryCount("execution-slot")); helperSettled = true; } })).state, "completed");
        });
        assert.equal(governor.activeCategoryCount("execution-slot"), 1, "the original specialist reacquires before continuing");
      } });
  } }) });
  const coordinatorRun = submission.submit({ definitionId: coordinator.id, goal: "Coordinate bounded specialist work", options: { workspaceId: "one-slot" } });
  assert.deepEqual(await coordinatorRun.result, { state: "completed" });
  assert.equal(helperSettled, true);
  assert.equal(peakSlots, 1);
  assert.equal(governor.activeCategoryCount("execution-slot"), 0);

  const activeWorker = world.spawnWorker(specialist.id);
  const activeTask = world.assignTask(world.createTask("Hold the only execution slot").id, activeWorker.id);
  const entered = deferred(); const release = deferred();
  const active = runtime.run({ workerId: activeWorker.id, taskId: activeTask.id, resourceIds: [], workspaceId: "one-slot",
    execute: async () => { entered.resolve(); await release.promise; } });
  await entered.promise;
  const queuedWorker = world.spawnWorker(specialist.id);
  const queuedTask = world.assignTask(world.createTask("Wait for an execution slot").id, queuedWorker.id);
  const queued = runtime.run({ workerId: queuedWorker.id, taskId: queuedTask.id, resourceIds: [], workspaceId: "one-slot", execute: async () => {} });
  for (let attempt = 0; attempt < 20 && governor.queueLength === 0; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(governor.queueLength, 1, "queued task waits in Governor rather than bypassing the configured limit");
  runtime.cancel(queuedTask.id);
  assert.deepEqual(await queued, { state: "cancelled" });
  assert.equal(governor.queueLength, 0);
  assert.equal(governor.activeCategoryCount("execution-slot"), 1, "cancelling a queued task does not release its sibling's slot");
  release.resolve();
  assert.deepEqual(await active, { state: "completed" });
  assert.equal(governor.activeCategoryCount("execution-slot"), 0);
  assert.deepEqual(runtime.activeTaskIds(), []);
  await governor.shutdown();
});

describe("minimal worker runtime", () => {
  it("validates finite positive integer capacity", () => {
    for (const limit of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
      assert.throws(() => new WorkerRuntime(createWorld(), { maxConcurrentExecutions: limit }), RangeError);
    }
    assert.doesNotThrow(() => new WorkerRuntime(createWorld()));
    assert.doesNotThrow(() => new WorkerRuntime(createWorld(), { maxConcurrentExecutions: 1 }));
  });

  it("bounds real overlap and retains cancelled capacity until cleanup independently of failure", async () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Test", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
    const workers = Array.from({ length: 4 }, () => world.spawnWorker(definition.id));
    const tasks = workers.map((worker) => world.assignTask(world.createTask("Run").id, worker.id));
    const resources = workers.map((worker) => world.registerResource({ kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: worker.id } }));
    const runtime = new WorkerRuntime(world, { maxConcurrentExecutions: 2 });
    const gates = workers.map(() => deferred());
    const entered: number[] = [];
    const start = (index: number) => runtime.run({ workerId: workers[index]!.id, taskId: tasks[index]!.id,
      resourceIds: [resources[index]!.id], execute: async () => {
        entered.push(index);
        await gates[index]!.promise;
        if (index === 1) throw new Error("executor failed");
      } });
    const first = start(0);
    const second = start(1);
    assert.deepEqual(entered, [0, 1]);
    assert.deepEqual(runtime.activeTaskIds(), [tasks[0]!.id, tasks[1]!.id]);
    const before = world.inspect();
    await assert.rejects(start(2), (error: unknown) => error instanceof RuntimeCapacityError && error.maxConcurrentExecutions === 2);
    assert.deepEqual(world.inspect(), before);
    runtime.cancel(tasks[0]!.id);
    const afterCancel = world.inspect();
    await assert.rejects(start(2), RuntimeCapacityError);
    assert.deepEqual(world.inspect(), afterCancel);
    gates[1]!.resolve();
    assert.deepEqual(await second, { state: "failed", error: "executor failed" });
    assert.equal(world.inspect().resources[1]?.state, "released");
    const third = start(2);
    assert.deepEqual(entered, [0, 1, 2]);
    await assert.rejects(start(3), RuntimeCapacityError);
    gates[0]!.resolve();
    assert.deepEqual(await first, { state: "cancelled" });
    assert.equal(world.inspect().resources[0]?.state, "released");
    const fourth = start(3);
    assert.deepEqual(runtime.activeTaskIds(), [tasks[2]!.id, tasks[3]!.id]);
    gates[2]!.resolve();
    gates[3]!.resolve();
    assert.deepEqual(await Promise.all([third, fourth]), [{ state: "completed" }, { state: "completed" }]);
    assert.deepEqual(runtime.activeTaskIds(), []);
  });

  it("reserves capacity before observers and releases it only after terminal observers", async () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Test", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
    const workers = [world.spawnWorker(definition.id), world.spawnWorker(definition.id)];
    const tasks = workers.map((worker) => world.assignTask(world.createTask("Run").id, worker.id));
    const resource = world.registerResource({ kind: "workspace", owner: { type: "world", worldId: world.id } });
    const runtime = new WorkerRuntime(world, { maxConcurrentExecutions: 1 });
    const finish = deferred();
    const attempts: Promise<void>[] = [];
    const nextInput = { workerId: workers[1]!.id, taskId: tasks[1]!.id, resourceIds: [], execute: async () => {} };
    let next: ReturnType<WorkerRuntime["run"]> | undefined;
    const run = runtime.run({ workerId: workers[0]!.id, taskId: tasks[0]!.id, resourceIds: [resource.id],
      execute: async () => { await finish.promise; }, onEvent: (event) => {
        if (["task.started", "resource.acquired", "task.completed"].includes(event.type)) {
          attempts.push(assert.rejects(runtime.run(nextInput), RuntimeCapacityError));
        }
        if (event.type === "resource.released") next = runtime.run(nextInput);
      } });
    finish.resolve();
    await run;
    await Promise.all(attempts);
    assert.equal(attempts.length, 3);
    assert.ok(next);
    assert.deepEqual(await next, { state: "completed" });
  });

  it("settles submission overflow as failed and releases only its owned registrations", async () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Test", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
    const runtime = new WorkerRuntime(world, { maxConcurrentExecutions: 1 });
    const submission = new RuntimeTaskSubmission(world, runtime);
    const finish = deferred();
    let executions = 0;
    submission.registerAdapter(definition.id, { prepare: ({ workerId, taskId }) => {
      const resource = world.registerResource({ kind: "workspace", owner: { type: "worker", worldId: world.id, workerId } });
      world.registerResource({ kind: "workspace", owner: { type: "task", worldId: world.id, taskId } });
      return { resourceIds: [resource.id], execute: async () => { executions++; await finish.promise; } };
    } });
    const first = submission.submit({ definitionId: definition.id, goal: "First" });
    const overflow = submission.submit({ definitionId: definition.id, goal: "Overflow" });
    assert.deepEqual(await overflow.result, { state: "failed", error: new RuntimeCapacityError(1).message });
    const snapshot = world.inspect();
    assert.equal(snapshot.tasks.find((task) => task.id === overflow.task.id)?.state, "failed");
    assert.equal(snapshot.workers.find((worker) => worker.id === overflow.workers[0]!.id)?.state, "idle");
    assert.deepEqual(snapshot.resources.map((resource) => resource.state), ["in-use", "available", "released", "released"]);
    assert.equal(executions, 1);
    assert.deepEqual(runtime.activeTaskIds(), [first.task.id]);
    finish.resolve();
    await first.result;
    const next = submission.submit({ definitionId: definition.id, goal: "Next" });
    assert.deepEqual(await next.result, { state: "completed" });
  });

  it("acquires every resource before cross-runtime observer reentrancy", async () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Test", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
    const workers = [world.spawnWorker(definition.id), world.spawnWorker(definition.id)];
    const tasks = workers.map((worker) => world.assignTask(world.createTask("Run").id, worker.id));
    const resources = [0, 1].map(() => world.registerResource({ kind: "workspace", owner: { type: "world", worldId: world.id } }));
    const runtime = new WorkerRuntime(world);
    const other = new WorkerRuntime(world);
    const finish = deferred();
    const attempts: Promise<void>[] = [];
    const observed: string[][] = [];
    const ids = resources.map((resource) => resource.id);
    const run = runtime.run({ workerId: workers[0]!.id, taskId: tasks[0]!.id, resourceIds: ids,
      onEvent: (event) => {
        if (event.type !== "task.started" && event.type !== "resource.acquired") return;
        observed.push(world.inspect().resources.map((resource) => resource.state));
        attempts.push(assert.rejects(other.run({ workerId: workers[1]!.id, taskId: tasks[1]!.id,
          resourceIds: [resources[1]!.id], execute: async () => {} }), /already in use/i));
        ids.length = 0;
      }, execute: async () => { await finish.promise; } });
    await Promise.all(attempts);
    assert.deepEqual(observed, Array.from({ length: 3 }, () => ["in-use", "in-use"]));
    finish.resolve();
    assert.deepEqual(await run, { state: "completed" });
    assert.ok(world.inspect().resources.every((resource) => resource.state === "released"));
    assert.deepEqual(await other.run({ workerId: workers[1]!.id, taskId: tasks[1]!.id,
      resourceIds: resources.map((resource) => resource.id), execute: async () => {} }), { state: "completed" });
  });

  it("does not execute when a started observer cancels synchronously", async () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Test", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Cancel").id, worker.id);
    const runtime = new WorkerRuntime(world);
    let executed = false;
    assert.deepEqual(await runtime.run({ workerId: worker.id, taskId: task.id, resourceIds: [],
      onEvent: (event) => { if (event.type === "task.started") runtime.cancel(task.id); },
      execute: async () => { executed = true; } }), { state: "cancelled" });
    assert.equal(executed, false);
    assert.deepEqual(runtime.activeTaskIds(), []);
    assert.equal(world.inspect().workers[0]?.state, "idle");
  });

  it("allows release observers to reuse a worker without old cleanup clobbering the new run", async () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Test", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
    const worker = world.spawnWorker(definition.id);
    const first = world.assignTask(world.createTask("First").id, worker.id);
    const second = world.assignTask(world.createTask("Second").id, worker.id);
    const resource = world.registerResource({ kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: worker.id } });
    const runtime = new WorkerRuntime(world);
    const finish = deferred();
    let next: ReturnType<WorkerRuntime["run"]> | undefined;
    await runtime.run({ workerId: worker.id, taskId: first.id, resourceIds: [resource.id], execute: async () => {},
      onEvent: (event) => {
        if (event.type === "resource.released") next = runtime.run({ workerId: worker.id, taskId: second.id,
          resourceIds: [resource.id], execute: async () => { await finish.promise; } });
      } });
    assert.ok(next);
    assert.equal(world.inspect().workers[0]?.state, "busy");
    assert.equal(world.inspect().resources[0]?.state, "in-use");
    assert.deepEqual(runtime.activeTaskIds(), [second.id]);
    runtime.cancel(second.id);
    finish.resolve();
    assert.deepEqual(await next, { state: "cancelled" });
    assert.deepEqual(runtime.activeTaskIds(), []);
    assert.equal(world.inspect().resources[0]?.state, "released");
  });
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

describe("definition-driven task submission", () => {
  it("fails closed when task creation setup rejects before worker execution", async () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Test", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    let executed = false;
    const events: import("@mediobot-v2/domain").WorldEvent[] = [];
    submission.registerAdapter(definition.id, { prepare: () => ({ resourceIds: [], execute: async () => { executed = true; } }) });
    const submitted = submission.submit({ definitionId: definition.id, goal: "Durably initialize before execution",
      onCreated: async () => { throw new Error("durable initialization failed"); }, onEvent: event => events.push(event) });

    assert.deepEqual(await submitted.result, { state: "failed", error: "durable initialization failed" });
    assert.equal(executed, false);
    assert.equal(world.inspect().tasks[0]?.state, "failed");
    assert.equal(events.filter(event => event.type === "task.failed").length, 1);
  });

  for (const outcome of ["completed", "failed", "cancelled", "prepare-failed"] as const) {
    it(`protects submission identities from callback and returned-object mutations on ${outcome}`, async () => {
      const world = createWorld();
      const definition = world.registerMediobotDefinition({ name: "Test", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
      const runtime = new WorkerRuntime(world);
      const submission = new RuntimeTaskSubmission(world, runtime);
      const gate = deferred();
      let created!: import("../src/index.ts").TaskCreatedNotice;
      let prepared!: import("../src/index.ts").WorkerExecutionContext;
      const events: import("@mediobot-v2/domain").WorldEvent[] = [];
      submission.registerAdapter(definition.id, { prepare: (context) => {
        prepared = context;
        world.registerResource({ kind: "workspace", owner: { type: "task", worldId: world.id, taskId: context.taskId } });
        if (outcome === "prepare-failed") throw new Error("prepare failed");
        return { resourceIds: [], execute: async () => {
          await gate.promise;
          if (outcome === "failed") throw new Error("execution failed");
        } };
      } });
      const request = { definitionId: definition.id, goal: "Original goal", onEvent: (event: import("@mediobot-v2/domain").WorldEvent) => { events.push(event); },
        onCreated: (notice: import("../src/index.ts").TaskCreatedNotice) => {
          created = { task: { ...notice.task }, workers: notice.workers.map((worker) => ({ ...worker })) };
          Object.assign(notice.task, { id: "corrupted", goal: "Changed goal", assignedWorkerId: "corrupted" });
          Object.assign(notice.workers[0]!, { id: "corrupted", definitionId: "corrupted" });
          Object.assign(request, { goal: "Changed request", definitionId: "corrupted", onEvent: () => {} });
        } };
      const submitted = submission.submit(request);
      assert.deepEqual(submitted.task, created.task);
      assert.deepEqual(submitted.workers, created.workers);
      assert.equal(prepared.goal, "Original goal");
      assert.equal(prepared.definitionId, definition.id);
      assert.equal(prepared.taskId, created.task.id);
      assert.equal(prepared.workerId, created.workers[0]!.id);
      Object.assign(submitted.task, { id: "returned-corrupted", goal: "Changed again" });
      Object.assign(submitted.workers[0]!, { id: "returned-corrupted" });
      if (outcome === "cancelled") submission.cancel(created.task.id);
      gate.resolve();
      const terminal = outcome === "prepare-failed" ? "failed" : outcome;
      assert.equal((await submitted.result).state, terminal);
      const snapshot = world.inspect();
      assert.equal(snapshot.tasks[0]?.id, created.task.id);
      assert.equal(snapshot.tasks[0]?.goal, "Original goal");
      assert.equal(snapshot.tasks[0]?.state, terminal);
      assert.equal(snapshot.workers[0]?.state, "idle");
      assert.ok(snapshot.resources.every((resource) => resource.state === "released"));
      assert.equal(events.filter((event) => event.type === `task.${terminal}`).length, 1);
      assert.ok(events.every((event) => event.taskId === created.task.id && event.workerId === created.workers[0]!.id));
      assert.deepEqual(runtime.activeTaskIds(), []);
    });
  }

  for (const outcome of ["completed", "failed", "cancelled"] as const) {
    it(`cleans unused owned registrations after ${outcome} without touching nested submission resources`, async () => {
      const world = createWorld();
      const definition = world.registerMediobotDefinition({ name: "Test", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
      const runtime = new WorkerRuntime(world);
      const submission = new RuntimeTaskSubmission(world, runtime);
      const finish = deferred();
      let nested: ReturnType<RuntimeTaskSubmission["submit"]> | undefined;
      submission.registerAdapter(definition.id, { prepare: ({ workerId, taskId, goal }) => {
        const owned = world.registerResource({ kind: "workspace", owner: { type: "task", worldId: world.id, taskId } });
        if (goal === "Nested") return { resourceIds: [owned.id], execute: async () => { await finish.promise; } };
        world.registerResource({ kind: "workspace", owner: { type: "worker", worldId: world.id, workerId } });
        world.registerResource({ kind: "workspace", owner: { type: "world", worldId: world.id } });
        nested = submission.submit({ definitionId: definition.id, goal: "Nested" });
        return { resourceIds: [owned.id], execute: async () => {
          if (outcome === "failed") throw new Error("execution failure");
          if (outcome === "cancelled") { submission.cancel(taskId); await Promise.resolve(); }
        } };
      } });
      const outer = submission.submit({ definitionId: definition.id, goal: "Outer" });
      assert.equal((await outer.result).state, outcome);
      const snapshot = world.inspect();
      assert.ok(nested);
      assert.deepEqual(runtime.activeTaskIds(), [nested.task.id]);
      assert.equal(snapshot.resources.filter((resource) => resource.state === "released").length, 2);
      assert.equal(snapshot.resources.find((resource) => resource.owner.type === "task" && resource.owner.taskId === nested!.task.id)?.state, "in-use");
      assert.equal(snapshot.resources.find((resource) => resource.owner.type === "world")?.state, "available");
      finish.resolve();
      assert.deepEqual(await nested.result, { state: "completed" });
      assert.deepEqual(runtime.activeTaskIds(), []);
    });
  }
  for (const failure of ["prepare", "missing", "duplicate", "foreign", "busy"] as const) {
    it(`terminalizes ${failure} failure and releases only submission-owned registrations`, async () => {
      const world = createWorld();
      const definition = world.registerMediobotDefinition({ name: "Test", role: "test", version: "1", instructions: "", declaredCapabilities: [] });
      const foreignWorker = world.spawnWorker(definition.id);
      const foreign = world.registerResource({ kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: foreignWorker.id } });
      const shared = world.registerResource({ kind: "workspace", owner: { type: "world", worldId: world.id } });
      const activeTask = world.assignTask(world.createTask("Active").id, foreignWorker.id);
      const finish = deferred();
      const runtime = new WorkerRuntime(world);
      const active = runtime.run({ workerId: foreignWorker.id, taskId: activeTask.id, resourceIds: [shared.id], execute: async () => { await finish.promise; } });
      const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
      const owned: import("@mediobot-v2/domain").ResourceId[] = [];
      submission.registerAdapter(definition.id, { prepare: ({ workerId, taskId }) => {
        owned.push(world.registerResource({ kind: "workspace", owner: { type: "worker", worldId: world.id, workerId } }).id);
        owned.push(world.registerResource({ kind: "workspace", owner: { type: "task", worldId: world.id, taskId } }).id);
        if (failure === "prepare") throw new Error("prepare failed");
        const invalid = failure === "missing" ? "missing" as typeof shared.id : failure === "foreign" ? foreign.id : shared.id;
        return { resourceIds: failure === "duplicate" ? [owned[0]!, owned[0]!] : [owned[0]!, invalid],
          execute: async () => { assert.fail("Invalid plan must not execute"); } };
      } });
      const submitted = submission.submit({ definitionId: definition.id, goal: "Fail", onEvent: () => { throw new Error("observer"); } });
      assert.equal((await submitted.result).state, "failed");
      const snapshot = world.inspect();
      assert.equal(snapshot.tasks.find((task) => task.id === submitted.task.id)?.state, "failed");
      assert.equal(snapshot.workers.find((worker) => worker.id === submitted.workers[0]?.id)?.state, "idle");
      assert.ok(snapshot.resources.filter((resource) => owned.includes(resource.id)).every((resource) => resource.state === "released"));
      assert.equal(snapshot.resources.find((resource) => resource.id === shared.id)?.state, "in-use");
      assert.equal(snapshot.resources.find((resource) => resource.id === foreign.id)?.state, "available");
      assert.equal(snapshot.events.filter((event) => event.taskId === submitted.task.id && event.type === "task.failed").length, 1);
      assert.equal(snapshot.events.filter((event) => event.taskId === submitted.task.id && event.type === "resource.acquired").length, 0);
      finish.resolve();
      assert.deepEqual(await active, { state: "completed" });
    });
  }
  it("creates per-task worker/task identities and delegates resource lifecycle to WorkerRuntime", async () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Vision", role: "visual research", version: "1",
      instructions: "Observe and act.", declaredCapabilities: [{ kind: "resource", name: "browser-page" }] });
    const runtime = new WorkerRuntime(world);
    const submission = new RuntimeTaskSubmission(world, runtime);
    const events: string[] = [];
    submission.registerAdapter(definition.id, {
      prepare: ({ world: ownerWorld, workerId, taskId }) => {
        const resource = ownerWorld.registerResource({ kind: "browser-page",
          owner: { type: "worker", worldId: ownerWorld.id, workerId } });
        return { resourceIds: [resource.id], execute: async ({ emit }) => { emit("worker.observed", resource.id); } };
      },
    });

    const first = submission.submit({ definitionId: definition.id, goal: "Inspect the page",
      onEvent: (event) => events.push(event.type) });
    const second = submission.submit({ definitionId: definition.id, goal: "Compare the page" });
    const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
    const snapshot = world.inspect();

    assert.deepEqual(firstResult, { state: "completed" });
    assert.deepEqual(secondResult, { state: "completed" });
    assert.notEqual(first.task.id, second.task.id);
    assert.notEqual(first.workers[0]?.id, second.workers[0]?.id);
    assert.equal(first.task.assignedWorkerId, first.workers[0]?.id);
    assert.equal(snapshot.tasks.find((task) => task.id === first.task.id)?.state, "completed");
    assert.equal(snapshot.workers.find((worker) => worker.id === first.workers[0]?.id)?.state, "idle");
    assert.equal(snapshot.resources.filter((resource) => resource.owner.type === "worker"
      && resource.owner.workerId === first.workers[0]?.id && resource.state === "released").length, 1);
    assert.ok(events.includes("task.started"));
    assert.ok(events.includes("worker.observed"));
    assert.ok(events.includes("task.completed"));
  });

  it("rejects unavailable definitions before creating worker or task state", () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Doc", role: "documentation", version: "1",
      instructions: "Not executable yet.", declaredCapabilities: [] });
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));

    assert.throws(() => submission.submit({ definitionId: definition.id, goal: "Read a document" }), /not executable/i);
    assert.equal(world.inspect().workers.length, 0);
    assert.equal(world.inspect().tasks.length, 0);
  });

  it("rejects draining definitions before creating worker or task state", () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Doc", role: "documentation", version: "1",
      instructions: "Read documents.", declaredCapabilities: [] });
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, { prepare: () => ({ execute: async () => {} }) });
    world.setMediobotLifecycleState(definition.id, "draining");

    assert.deepEqual(submission.availability(definition.id), { available: false, reason: "unavailable" });
    assert.throws(() => submission.submit({ definitionId: definition.id, goal: "Read a document" }), /not executable/i);
    assert.equal(world.inspect().workers.length, 0);
    assert.equal(world.inspect().tasks.length, 0);
  });

  it("routes cancellation and failures through WorkerRuntime and releases owned resources", async () => {
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Worker", role: "test", version: "1",
      instructions: "Test execution.", declaredCapabilities: [{ kind: "resource", name: "workspace" }] });
    const failingDefinition = world.registerMediobotDefinition({ name: "Failing worker", role: "test", version: "1",
      instructions: "Fail execution.", declaredCapabilities: [{ kind: "resource", name: "workspace" }] });
    const started = deferred();
    const wait = deferred();
    let resourceId: import("@mediobot-v2/domain").ResourceId | undefined;
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, {
      prepare: ({ world: ownerWorld, workerId }) => {
        const resource = ownerWorld.registerResource({ kind: "workspace",
          owner: { type: "worker", worldId: ownerWorld.id, workerId } });
        resourceId = resource.id;
        return { resourceIds: [resource.id], execute: async ({ signal }) => {
          started.resolve();
          await Promise.race([wait.promise, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
        } };
      },
    });
    let failedResourceId: import("@mediobot-v2/domain").ResourceId | undefined;
    submission.registerAdapter(failingDefinition.id, {
      prepare: ({ world: ownerWorld, workerId }) => {
        const resource = ownerWorld.registerResource({ kind: "workspace",
          owner: { type: "worker", worldId: ownerWorld.id, workerId } });
        failedResourceId = resource.id;
        return { resourceIds: [resource.id], execute: async () => { throw new Error("simulated failure"); } };
      },
    });
    const active = submission.submit({ definitionId: definition.id, goal: "Cancel this task" });
    await started.promise;
    submission.cancel(active.task.id);
    assert.deepEqual(await active.result, { state: "cancelled" });
    assert.equal(world.inspect().tasks.find((task) => task.id === active.task.id)?.state, "cancelled");
    assert.equal(world.inspect().resources.find((resource) => resource.id === resourceId)?.state, "released");

    const failed = submission.submit({ definitionId: failingDefinition.id, goal: "Fail this task" });
    assert.deepEqual(await failed.result, { state: "failed", error: "simulated failure" });
    assert.equal(world.inspect().tasks.find((task) => task.id === failed.task.id)?.state, "failed");
    assert.equal(world.inspect().resources.find((resource) => resource.id === failedResourceId)?.state, "released");
  });
});

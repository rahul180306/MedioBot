import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { entrypoint, task } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createWorld } from "@mediobot-v2/domain";
import type { TaskId } from "@mediobot-v2/domain";
import { ResourceGovernor, SystemResourceTelemetryCollector, WorkerRuntime } from "@mediobot-v2/runtime";
import type { OrchestrationPlanSpec } from "@mediobot-v2/contracts";
import { MaestroOrchestrator } from "../src/orchestrator.ts";
import { LangGraphExecutionEngine } from "../src/langgraph-engine.ts";
import { ProviderRequestScheduler } from "@mediobot-v2/models";

test("LangGraph owns Maestro task execution, checkpoints in SQLite, and runs ready specialists concurrently", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-execution-"));
  const databasePath = path.join(temp, "product.sqlite");
  const world = createWorld();
  const cody = world.registerMediobotDefinition({ name: "Cody", role: "coding", version: "1", instructions: "Inspect code", declaredCapabilities: [] });
  const doc = world.registerMediobotDefinition({ name: "Doc", role: "doc", version: "1", instructions: "Read docs", declaredCapabilities: [] });
  const governor = new ResourceGovernor({ budget: { maxConcurrentTasks: 2, maxConcurrentTasksPerWorkspace: 2 },
    telemetryCollector: new SystemResourceTelemetryCollector({ mockTelemetry: () => ({ memoryPressureState: "normal", systemCpuPercent: 0 }) }) });
  const runtime = new WorkerRuntime(world, { resourceGovernor: governor });
  const orchestrator = new MaestroOrchestrator({ world, runtime, resourceGovernor: governor,
    checkpointDatabasePath: databasePath });
  const intervals: Array<{ id: string; start: number; end: number }> = [];
  let codyInvocations = 0;
  let docInvocations = 0;
  const started = new Map<string, number>();
  const adapters = new Map([
    [cody.id, async (context: { taskId: string }, run: { signal: AbortSignal }) => {
      codyInvocations += 1;
      const start = performance.now(); started.set(context.taskId, start);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60);
        run.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
      });
      intervals.push({ id: context.taskId, start, end: performance.now() });
    }],
    [doc.id, async (context: { taskId: string }, run: { signal: AbortSignal }) => {
      docInvocations += 1;
      const start = performance.now(); started.set(context.taskId, start);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60);
        run.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
      });
      intervals.push({ id: context.taskId, start, end: performance.now() });
    }],
  ]);
  const plan: OrchestrationPlanSpec = { planId: "langgraph-slice-one", goal: "Inspect and document independently", tasks: [
    { id: "cody-independent" as TaskId, definitionId: cody.id, objective: "Inspect the module" },
    { id: "doc-independent" as TaskId, definitionId: doc.id, objective: "Review the API docs" },
  ] };
  try {
    const result = await orchestrator.executePlan(plan, { workspaceId: "workspace-test", specialistAdapters: adapters as never });
    assert.equal(result.status, "completed");
    assert.equal(result.executionInterval.maxParallelWorkers, 2);
    assert.equal(codyInvocations, 1);
    assert.equal(docInvocations, 1);
    const overlap = Math.max(0, Math.min(...intervals.map(item => item.end)) - Math.max(...intervals.map(item => item.start)));
    assert.ok(overlap > 20, `expected overlapping execution intervals, got ${overlap}ms`);
    assert.equal(governor.activeLeasesCount, 0);

    const db = new DatabaseSync(databasePath);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('checkpoints', 'writes') ORDER BY name").all() as Array<{ name: string }>;
      assert.deepEqual(tables.map(row => row.name), ["checkpoints", "writes"]);
      const saved = db.prepare("SELECT COUNT(*) AS count FROM checkpoints").get() as { count: number };
      assert.ok(saved.count > 0, "the workflow checkpoint must be persisted in the selected SQLite file");
    } finally { db.close(); }

    const restarted = new MaestroOrchestrator({ world, runtime, resourceGovernor: governor,
      checkpointDatabasePath: databasePath });
    const resumed = await restarted.executePlan(plan, { workspaceId: "workspace-test", specialistAdapters: adapters as never });
    assert.equal(resumed.status, "completed");
    assert.equal(codyInvocations, 1, "a completed Cody side effect must be restored from the execution graph checkpoint");
    assert.equal(docInvocations, 1, "a completed Doc side effect must be restored from the execution graph checkpoint");
    const otherWorkspace = await restarted.executePlan(plan, { workspaceId: "workspace-other", specialistAdapters: adapters as never });
    assert.equal(otherWorkspace.status, "completed");
    assert.equal(codyInvocations, 2, "a different workspace must not reuse this workspace's checkpoint");
    assert.equal(docInvocations, 2, "checkpoint identity must isolate all specialists by workspace");
    const changedPlan = { ...plan, goal: "A different goal using the old plan id" };
    await assert.rejects(
      restarted.executePlan(changedPlan, { workspaceId: "workspace-test", specialistAdapters: adapters as never }),
      /Checkpoint plan mismatch.*Use a new planId/,
    );
    assert.equal(codyInvocations, 2, "a changed plan must be rejected before replaying or starting side effects");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("checkpoint recovery restores dynamically delegated specialist results and evidence exactly once", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-dynamic-recovery-"));
  const databasePath = path.join(temp, "product.sqlite");
  const world = createWorld();
  const cody = world.registerMediobotDefinition({ name: "Cody", role: "coding", version: "1", instructions: "Work", declaredCapabilities: [] });
  const doc = world.registerMediobotDefinition({ name: "Doc", role: "doc", version: "1", instructions: "Research", declaredCapabilities: [] });
  const research = world.registerMediobotDefinition({ name: "Research", role: "research", version: "1", instructions: "Research", declaredCapabilities: [] });
  const runtime = new WorkerRuntime(world);
  const orchestrator = new MaestroOrchestrator({ world, runtime, checkpointDatabasePath: databasePath });
  let codyRuns = 0;
  let docRuns = 0;
  let researchRuns = 0;
  const plan: OrchestrationPlanSpec = { planId: "dynamic-child-recovery", goal: "Ask Doc and preserve its report", tasks: [
    { id: "cody-parent" as TaskId, definitionId: cody.id, objective: "Ask Doc for API evidence" },
  ] };
  const adapters = new Map([
    [cody.id, async (context: { taskId: string; workerId: string; definitionId: string; options: { orchestrator: MaestroOrchestrator } }) => {
      codyRuns++;
      await context.options.orchestrator.requestSupport({ id: "request-doc-evidence", requesterTaskId: context.taskId as TaskId,
        requesterWorkerId: context.workerId as never, requesterMediobotId: context.definitionId as never,
        capabilityNeeded: "documentation", query: "official API response format", requestedAt: Date.now() });
    }],
    [doc.id, async (context: { taskId: string; workerId: string; definitionId: string; options: { orchestrator: MaestroOrchestrator } }, _run: unknown, emit: (artifact: { kind: string; title: string; content: string; isProvisional: boolean }) => void) => {
      docRuns++;
      emit({ kind: "documentation", title: "Official API response", content: "The API returns a JSON response with a result field.", isProvisional: false });
      await context.options.orchestrator.requestSupport({ id: "request-research-followup", requesterTaskId: context.taskId as TaskId,
        requesterWorkerId: context.workerId as never, requesterMediobotId: context.definitionId as never,
        capabilityNeeded: "research", query: "independent corroboration for API response", requestedAt: Date.now() });
    }],
    [research.id, async (_context: unknown, _run: unknown, emit: (artifact: { kind: string; title: string; content: string; isProvisional: boolean }) => void) => {
      researchRuns++;
      emit({ kind: "research-evidence", title: "Independent corroboration", content: "Independent evidence confirms the result field.", isProvisional: false });
    }],
  ]);
  try {
    const first = await orchestrator.executePlan(plan, { workspaceId: "ws", specialistAdapters: adapters as never });
    assert.equal(first.status, "completed");
    const firstDoc = first.tasks.find(item => item.spec.definitionId === doc.id);
    assert.ok(firstDoc);
    assert.equal(firstDoc.status, "completed");
    assert.equal(first.intermediateArtifacts.filter(item => item.taskId === firstDoc.taskId).length, 1);
    const firstResearch = first.tasks.find(item => item.spec.definitionId === research.id);
    assert.ok(firstResearch, "a nested dynamic Research assignment must be included in the result");
    assert.equal(firstResearch.status, "completed");
    assert.equal(first.intermediateArtifacts.filter(item => item.taskId === firstResearch.taskId).length, 1);
    assert.ok(first.executionInterval.maxParallelWorkers >= 2, "the delegated Doc can overlap Cody's active assignment");

    const restarted = new MaestroOrchestrator({ world, runtime, checkpointDatabasePath: databasePath });
    const recovered = await restarted.executePlan(plan, { workspaceId: "ws", specialistAdapters: adapters as never });
    const recoveredDoc = recovered.tasks.find(item => item.spec.definitionId === doc.id);
    assert.ok(recoveredDoc, "the dynamically created specialist task must be reconstructed from checkpoint state");
    assert.equal(recoveredDoc.status, "completed");
    assert.equal(recovered.intermediateArtifacts.filter(item => item.taskId === recoveredDoc.taskId).length, 1);
    const recoveredResearch = recovered.tasks.find(item => item.spec.definitionId === research.id);
    assert.ok(recoveredResearch, "nested dynamic specialist state must be reconstructed from the checkpoint");
    assert.equal(recoveredResearch.status, "completed");
    assert.equal(recovered.intermediateArtifacts.filter(item => item.taskId === recoveredResearch.taskId).length, 1);
    assert.equal(codyRuns, 1);
    assert.equal(docRuns, 1, "the completed dynamic specialist side effect must not be repeated");
    assert.equal(researchRuns, 1, "the completed nested specialist side effect must not be repeated");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Functional API resumes a persisted execution without replaying a completed task", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-recovery-"));
  const databasePath = path.join(temp, "product.sqlite");
  let externalSideEffects = 0;
  let shouldFail = true;
  const completedOperation = task({ name: "completed-operation", retry: { maxAttempts: 1 } }, async (input: string) => {
    externalSideEffects += 1;
    return `${input}:${externalSideEffects}`;
  });
  const interruptedOperation = task({ name: "interrupted-operation", retry: { maxAttempts: 1 } }, async () => {
    if (shouldFail) { shouldFail = false; throw new Error("simulated-process-interruption"); }
    return "recovered";
  });
  const config = { configurable: { thread_id: "resume-world-space-task" } };
  const buildWorkflow = (checkpointer: SqliteSaver) => entrypoint({ name: "recovery-proof", checkpointer }, async (input: string) => {
    const completed = await completedOperation(input);
    return { completed, resumed: await interruptedOperation() };
  });
  try {
    const firstSaver = SqliteSaver.fromConnString(databasePath);
    try { await assert.rejects(buildWorkflow(firstSaver).invoke("write-once", config), /simulated-process-interruption/); }
    finally { firstSaver.db.close(); }

    const restartedSaver = SqliteSaver.fromConnString(databasePath);
    try {
      const result = await buildWorkflow(restartedSaver).invoke(null, config);
      assert.deepEqual(result, { completed: "write-once:1", resumed: "recovered" });
      assert.equal(externalSideEffects, 1, "recovery must reuse the persisted completed-task result");
    } finally { restartedSaver.db.close(); }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("two independent assignments run concurrently while dependent assignment follows, and provider capacity controls inference concurrency", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-parallel-"));
  const saver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));

  const engine = new LangGraphExecutionEngine();
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();

  let aStarted = false;
  let bStarted = false;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });

  try {
    const tasks = [
      { id: "task-a", dependsOn: [] as string[] },
      { id: "task-b", dependsOn: [] as string[] },
      { id: "task-c", dependsOn: ["task-a", "task-b"] },
    ];

    const results = await engine.runParallel({
      workflowName: "parallel-dag-workflow",
      taskName: "assignment",
      threadId: "dag-thread-p1",
      checkpointer: saver,
      tasks,
      taskId: item => item.id,
      dependencies: item => item.dependsOn,
      execute: async (item) => {
        starts.set(item.id, performance.now());
        if (item.id === "task-a") {
          aStarted = true;
          if (bStarted) releaseBarrier();
          await barrier;
        } else if (item.id === "task-b") {
          bStarted = true;
          if (aStarted) releaseBarrier();
          await barrier;
        } else if (item.id === "task-c") {
          await new Promise((r) => setTimeout(r, 10));
        }
        ends.set(item.id, performance.now());
        return item.id;
      },
    });

    assert.deepEqual(results, ["task-a", "task-b", "task-c"]);
    const startA = starts.get("task-a")!;
    const endA = ends.get("task-a")!;
    const startB = starts.get("task-b")!;
    const endB = ends.get("task-b")!;
    const startC = starts.get("task-c")!;

    // 1. Independent tasks A and B must overlap concurrently: max(startA, startB) < min(endA, endB)
    assert.ok(
      Math.max(startA, startB) < Math.min(endA, endB),
      `Independent tasks A and B must execute concurrently: max(${startA}, ${startB}) < min(${endA}, ${endB})`
    );

    // 2. Dependent task C must start only AFTER both A and B complete
    assert.ok(
      startC >= Math.max(endA, endB),
      `Dependent task C start (${startC}) must follow prerequisite completion (max: ${Math.max(endA, endB)})`
    );

    // 3. Provider capacity: with capacity 1, inference calls are serialized despite concurrent workers
    const scheduler1 = new ProviderRequestScheduler({
      defaultConcurrency: 4,
      concurrencyLimits: { "test-provider": 1 },
    });
    let inf1Active = 0;
    let inf1MaxActive = 0;
    const runInf1 = () => scheduler1.schedule({
      providerKey: "test-provider",
      execute: async () => {
        inf1Active++;
        inf1MaxActive = Math.max(inf1MaxActive, inf1Active);
        await new Promise((r) => setTimeout(r, 20));
        inf1Active--;
        return "done";
      },
    });
    await Promise.all([runInf1(), runInf1()]);
    assert.equal(inf1MaxActive, 1, "Provider capacity 1 serializes inference requests even when workers overlap");

    // 4. Provider capacity: with authorized capacity 2, inference calls overlap concurrently
    const scheduler2 = new ProviderRequestScheduler({
      defaultConcurrency: 4,
      concurrencyLimits: { "test-provider": 2 },
    });
    let inf2Active = 0;
    let inf2MaxActive = 0;
    const runInf2 = () => scheduler2.schedule({
      providerKey: "test-provider",
      execute: async () => {
        inf2Active++;
        inf2MaxActive = Math.max(inf2MaxActive, inf2Active);
        await new Promise((r) => setTimeout(r, 20));
        inf2Active--;
        return "done";
      },
    });
    await Promise.all([runInf2(), runInf2()]);
    assert.equal(inf2MaxActive, 2, "Authorized provider capacity 2 executes inference requests concurrently");
  } finally {
    saver.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});


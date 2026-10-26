import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import type { TaskId } from "@mediobot-v2/domain";
import {
  ResourceGovernor,
  computeHardwareBudget,
  SystemResourceTelemetryCollector,
  SubprocessSupervisor,
  SubprocessQuotaExceededError,
} from "../src/index.ts";

const steadyTelemetryCollector = () => new SystemResourceTelemetryCollector({
  mockTelemetry: () => ({ memoryPressureState: "normal", systemCpuPercent: 0 }),
});

describe("PHASE 4: Intelligent Resource Governor Test Suite", () => {
  it("computes hardware-aware budgets and defaults", () => {
    const budget8Gb = computeHardwareBudget(8 * 1024 * 1024 * 1024);
    assert.equal(budget8Gb.maxConcurrentTasks, 2);
    assert.equal(budget8Gb.maxConcurrentTasksPerWorkspace, 1);

    const budget16Gb = computeHardwareBudget(16 * 1024 * 1024 * 1024);
    assert.equal(budget16Gb.maxConcurrentTasks, 4);
    assert.equal(budget16Gb.maxConcurrentTasksPerWorkspace, 2);

    const budget32Gb = computeHardwareBudget(32 * 1024 * 1024 * 1024);
    assert.equal(budget32Gb.maxConcurrentTasks, 8);
    assert.equal(budget32Gb.maxConcurrentTasksPerWorkspace, 4);
  });

  it("enforces global and per-workspace concurrency quotas with fair queueing", async () => {
    const governor = new ResourceGovernor({
      budget: {
        maxConcurrentTasks: 3,
        maxConcurrentTasksPerWorkspace: 2,
      },
      telemetryCollector: steadyTelemetryCollector(),
    });

    const task1 = "task-1" as TaskId;
    const task2 = "task-2" as TaskId;
    const task3 = "task-3" as TaskId;
    const task4 = "task-4" as TaskId;

    // Workspace A admits 2 tasks (hits per-workspace cap)
    const lease1 = await governor.requestTaskAdmission({ taskId: task1, workspaceId: "ws-A", priority: "background" });
    assert.equal(lease1.taskId, task1);
    assert.equal(governor.activeCategoryCountForWorkspace("execution-slot", "ws-A"), 1);

    const lease2 = await governor.requestTaskAdmission({ taskId: task2, workspaceId: "ws-A", priority: "background" });
    assert.equal(lease2.taskId, task2);
    assert.equal(governor.activeCategoryCountForWorkspace("execution-slot", "ws-A"), 2);

    // Third task in ws-A must be queued because ws-A limit is 2, even though global capacity is 3!
    let task3Admitted = false;
    const task3Promise = governor.requestTaskAdmission({ taskId: task3, workspaceId: "ws-A", priority: "background" })
      .then((lease) => {
        task3Admitted = true;
        return lease;
      });

    // Small delay to ensure queue registration
    await delay(20);
    assert.equal(task3Admitted, false);
    assert.equal(governor.queueLength, 1);

    // Meanwhile, Workspace B can be admitted immediately because it has 0 tasks and global capacity (2/3) is not exhausted!
    const lease4 = await governor.requestTaskAdmission({ taskId: task4, workspaceId: "ws-B", priority: "background" });
    assert.equal(lease4.taskId, task4);
    assert.equal(governor.activeCategoryCountForWorkspace("execution-slot", "ws-B"), 1);
    assert.equal(governor.activeCategoryCount("execution-slot"), 3);

    // Now release task1 in ws-A. task3 should be admitted automatically!
    governor.releaseLease(lease1.id);
    const lease3 = await task3Promise;
    assert.equal(lease3.taskId, task3);
    assert.equal(governor.queueLength, 0);

    governor.releaseLease(lease2.id);
    governor.releaseLease(lease3.id);
    governor.releaseLease(lease4.id);
    assert.equal(governor.activeLeasesCount, 0);
    await governor.shutdown();
  });

  it("schedules fairly across workspaces and prevents starvation (DRF)", async () => {
    const governor = new ResourceGovernor({
      budget: {
        maxConcurrentTasks: 2,
        maxConcurrentTasksPerWorkspace: 2,
      },
      telemetryCollector: steadyTelemetryCollector(),
    });

    const t1 = "t1" as TaskId;
    const t2 = "t2" as TaskId;
    const t3 = "t3" as TaskId;
    const t4 = "t4" as TaskId;

    // Saturate global slots with Workspace A
    const lease1 = await governor.requestTaskAdmission({ taskId: t1, workspaceId: "ws-A", priority: "background" });
    const lease2 = await governor.requestTaskAdmission({ taskId: t2, workspaceId: "ws-A", priority: "background" });

    // Queue background task t3 for ws-A, and background task t4 for ws-B
    const order: string[] = [];
    const p3 = governor.requestTaskAdmission({ taskId: t3, workspaceId: "ws-A", priority: "background" })
      .then((l) => { order.push("t3-wsA"); return l; });
    const p4 = governor.requestTaskAdmission({ taskId: t4, workspaceId: "ws-B", priority: "background" })
      .then((l) => { order.push("t4-wsB"); return l; });

    await delay(20);
    assert.equal(governor.queueLength, 2);

    // Release 1 slot from ws-A. Because ws-A already held 2 slots, ws-B has higher deficit/fairness priority!
    governor.releaseLease(lease1.id);

    // Wait for admission to settle
    await delay(20);

    // ws-B task t4 must have been admitted first because ws-A has higher active load!
    assert.equal(order[0], "t4-wsB");

    // Now release second slot so ws-A task t3 can run
    governor.releaseLease(lease2.id);
    const l3 = await p3;
    const l4 = await p4;

    assert.deepEqual(order, ["t4-wsB", "t3-wsA"]);
    governor.releaseLease(l3.id);
    governor.releaseLease(l4.id);
    await governor.shutdown();
  });

  it("adapts concurrency dynamically under simulated memory pressure", async () => {
    let simulatedPressure: "normal" | "elevated" | "critical" = "normal";

    const telemetryCollector = new SystemResourceTelemetryCollector({
      mockTelemetry: () => ({
        memoryPressureState: simulatedPressure,
        totalMemoryBytes: 16 * 1024 * 1024 * 1024,
        freeMemoryBytes: simulatedPressure === "critical" ? 1 * 1024 * 1024 * 1024 : 8 * 1024 * 1024 * 1024,
        usedMemoryPercent: simulatedPressure === "critical" ? 92 : 50,
      }),
    });

    const governor = new ResourceGovernor({
      budget: { maxConcurrentTasks: 4 },
      telemetryCollector,
    });

    assert.equal(governor.getEffectiveConcurrencyLimit(), 4);

    // Elevated: scales down to 50%
    simulatedPressure = "elevated";
    assert.equal(governor.getEffectiveConcurrencyLimit(), 2);

    // Critical: scales down to 1
    simulatedPressure = "critical";
    assert.equal(governor.getEffectiveConcurrencyLimit(), 1);

    // Under critical pressure, background tasks yield and cannot be admitted
    assert.equal(governor.canAdmitTask(null, "background"), false);

    // But interactive tasks are allowed access
    assert.equal(governor.canAdmitTask(null, "interactive"), true);

    await governor.shutdown();
  });

  it("reduces admission under measured system CPU saturation even when load average is unavailable", async () => {
    let systemCpuPercent: number | undefined = 96;
    const telemetryCollector = new SystemResourceTelemetryCollector({ mockTelemetry: () => ({
      memoryPressureState: "normal",
      loadAverage1m: 0,
      systemCpuPercent,
    }) });
    const governor = new ResourceGovernor({ budget: { maxConcurrentTasks: 6 }, telemetryCollector });

    assert.equal(governor.getEffectiveConcurrencyLimit(), 3,
      "high measured CPU utilization must reduce new admissions on platforms with zero load average");
    systemCpuPercent = 70;
    assert.equal(governor.getEffectiveConcurrencyLimit(), 6);
    systemCpuPercent = undefined;
    assert.equal(governor.getEffectiveConcurrencyLimit(), 6,
      "an unavailable CPU sample must not be interpreted as saturation");
    await governor.shutdown();
  });

  it("supervises subprocesses, enforces quotas, and terminates process trees without orphans", async () => {
    const supervisor = new SubprocessSupervisor({
      maxConcurrentGlobal: 2,
      maxConcurrentPerWorkspace: 2,
      killGracePeriodMs: 50,
    });

    // Spawn real sleep subprocesses
    const child1 = spawn("sleep", ["60"], { stdio: "ignore" });
    const child2 = spawn("sleep", ["60"], { stdio: "ignore" });
    assert.ok(child1.pid);
    assert.ok(child2.pid);

    supervisor.register({
      id: "sub-1",
      pid: child1.pid,
      command: "sleep 60",
      taskId: "task-A" as TaskId,
      workspaceId: "ws-1",
      startedAt: Date.now(),
    });

    supervisor.register({
      id: "sub-2",
      pid: child2.pid,
      command: "sleep 60",
      taskId: "task-A" as TaskId,
      workspaceId: "ws-1",
      startedAt: Date.now(),
    });

    assert.equal(supervisor.activeCount, 2);

    // Attempting 3rd spawn must throw SubprocessQuotaExceededError
    assert.throws(
      () => {
        supervisor.register({
          id: "sub-3",
          pid: 99999,
          command: "sleep 60",
          taskId: "task-B" as TaskId,
          workspaceId: "ws-1",
          startedAt: Date.now(),
        });
      },
      (err: any) => err instanceof SubprocessQuotaExceededError
    );

    // Terminate all subprocesses for task-A
    const terminated = await supervisor.terminateTaskSubprocesses("task-A" as TaskId);
    assert.equal(terminated, 2);
    assert.equal(supervisor.activeCount, 0);

    // Verify child processes are terminated
    let child1Alive = true;
    try {
      process.kill(child1.pid, 0);
    } catch {
      child1Alive = false;
    }
    assert.equal(child1Alive, false, "Subprocess 1 must be terminated");

    let child2Alive = true;
    try {
      process.kill(child2.pid, 0);
    } catch {
      child2Alive = false;
    }
    assert.equal(child2Alive, false, "Subprocess 2 must be terminated");

    await supervisor.terminateAll();
  });

  it("propagates cancellation and tears down held leases immediately", async () => {
    const governor = new ResourceGovernor({
      budget: { maxConcurrentTasks: 1 },
      telemetryCollector: steadyTelemetryCollector(),
    });

    const task1 = "task-cancel-1" as TaskId;
    const task2 = "task-cancel-2" as TaskId;

    const lease1 = await governor.requestTaskAdmission({ taskId: task1, priority: "interactive" });
    governor.acquireModelSlot(task1);

    assert.equal(governor.activeCategoryCount("execution-slot"), 1);
    assert.equal(governor.activeCategoryCount("model-request"), 1);

    // Queue task 2
    let task2Admitted = false;
    const p2 = governor.requestTaskAdmission({ taskId: task2, priority: "background" })
      .then((l) => {
        task2Admitted = true;
        return l;
      });

    await delay(20);
    assert.equal(task2Admitted, false);

    // Cancel task 1 -> releases all execution and model leases simultaneously
    await governor.releaseAllTaskResources(task1);

    // task 2 should now immediately be admitted!
    const lease2 = await p2;
    assert.equal(lease2.taskId, task2);
    assert.equal(task2Admitted, true);

    // Cleanup
    governor.releaseLease(lease2.id);
    await governor.shutdown();
  });

  it("aborts queued requests on AbortSignal without memory leaks", async () => {
    const governor = new ResourceGovernor({
      budget: { maxConcurrentTasks: 1 },
      telemetryCollector: steadyTelemetryCollector(),
    });

    const task1 = "task-slot-1" as TaskId;
    const task2 = "task-slot-2" as TaskId;

    const lease1 = await governor.requestTaskAdmission({ taskId: task1 });

    const controller = new AbortController();
    const queuePromise = governor.requestTaskAdmission({
      taskId: task2,
      signal: controller.signal,
    });

    await delay(20);
    assert.equal(governor.queueLength, 1);

    // Abort while waiting in queue
    controller.abort();

    await assert.rejects(queuePromise, /aborted/);
    assert.equal(governor.queueLength, 0, "Aborted task must be removed from queue");

    governor.releaseLease(lease1.id);
    await governor.shutdown();
  });
});

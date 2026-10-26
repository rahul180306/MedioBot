import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Browser, BrowserContext, Page } from "playwright";
import type { ResourceId, TaskId } from "@mediobot-v2/domain";
import { createWorld } from "@mediobot-v2/domain";
import { startCommandCenter } from "../../src/server.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { ToolRuntime } from "@mediobot-v2/tools";
import { createComposition } from "../../src/composition.ts";
import { ResourceGovernor, SubprocessSupervisor, SystemResourceTelemetryCollector } from "@mediobot-v2/runtime";
import { PlaywrightBrowserRuntime, BrowserSessionQuotaExceededError } from "@mediobot-v2/vision";

class ResponseCapture extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  output = "";
  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    if (headers) this.headers = headers;
    return this;
  }
  override _write(chunk: Buffer, _: BufferEncoding, callback: () => void) {
    this.output += chunk.toString();
    callback();
  }
}

async function request(
  app: Awaited<ReturnType<typeof startCommandCenter>>,
  method: string,
  url: string,
  body?: unknown,
) {
  const req = Object.assign(
    Readable.from(body ? [JSON.stringify(body)] : []),
    new EventEmitter(),
    { method, url, headers: {} },
  );
  const res = new ResponseCapture();
  const finished = new Promise<void>((resolve) => res.once("finish", resolve));
  app.handle(req as never, res as never);
  await finished;
  let json: any = undefined;
  try {
    json = JSON.parse(res.output);
  } catch {}
  return { status: res.statusCode, json, text: res.output };
}

function makeProvider(dbPath: string) {
  const database = new LocalDatabase(dbPath);
  const providerRepo = new ProviderRepository(database.raw);
  providerRepo.save({
    id: "test-provider",
    providerType: "custom",
    displayName: "Test Provider",
    connected: true,
    enabled: true,
    baseUrl: "http://unused.invalid",
    models: [{
      id: "test-model",
      name: "Text Engine",
      enabled: true,
      capabilities: { text: true, reasoning: true, vision: true, tools: false },
    }],
  });
  return { database, providerRepo };
}

function createMockBrowser() {
  const emitter = new EventEmitter();
  let connected = true;

  const mockPage = {
    on: () => {},
    close: async () => {},
    isClosed: () => false,
  } as unknown as Page;

  const mockContext = {
    newPage: async () => mockPage,
    close: async () => {},
  } as unknown as BrowserContext;

  const mockBrowser = {
    on: (event: string, listener: (...args: any[]) => void) => {
      emitter.on(event, listener);
      return mockBrowser;
    },
    isConnected: () => connected,
    newContext: async () => mockContext,
    close: async () => {
      connected = false;
      emitter.emit("disconnected");
    },
  } as unknown as Browser;

  return mockBrowser;
}

test("PHASE 4 E2E: Resource Governor API exposes CPU telemetry and adaptive admission", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mediobot-v2-phase4-"));
  const dbPath = path.join(dir, "governor-test.db");
  const { providerRepo } = makeProvider(dbPath);
  const modelResolver = new ModelResolver(providerRepo);

  const governor = new ResourceGovernor({
    budget: { maxConcurrentTasks: 3, maxConcurrentSubprocesses: 5 },
    telemetryCollector: new SystemResourceTelemetryCollector({ mockTelemetry: () => ({
      memoryPressureState: "normal", systemCpuPercent: 96,
    }) }),
  });

  const app = await startCommandCenter({
    port: 0,
    vite: false,
    listen: false,
    databasePath: dbPath,
    providerRepository: providerRepo,
    modelResolver,
    resourceGovernor: governor,
  });

  try {
    const res = await request(app, "GET", "/api/system/resources");
    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.equal(res.json.budget?.maxConcurrentTasks, 3);
    assert.equal(res.json.budget?.maxConcurrentSubprocesses, 5);
    assert.equal(res.json.effectiveConcurrencyLimit, 1,
      "the API must expose CPU-aware admission limits even when system load average is zero");
    assert.equal(res.json.queuedTasksCount, 0);
    assert.ok(res.json.telemetry);
    assert.ok(["normal", "elevated", "critical"].includes(res.json.telemetry.memoryPressureState));
    assert.ok(res.json.telemetry.totalMemoryBytes > 0);
    assert.ok(res.json.telemetry.freeMemoryBytes > 0);
    assert.ok(res.json.telemetry.processRssBytes > 0);
    assert.equal(res.json.telemetry.systemCpuPercent, 96);
    assert.equal(res.json.telemetry.managedProcessTreeRssBytes, undefined,
      "the resource API must not present backend process RSS as a whole managed-process total");
  } finally {
    await app.close();
    await governor.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PHASE 4 E2E: Tool Subprocess Supervisor Integration with Cancellation Cleanup", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mediobot-v2-phase4-subproc-"));
  const supervisor = new SubprocessSupervisor({
    maxConcurrentGlobal: 2,
    maxConcurrentPerWorkspace: 2,
    killGracePeriodMs: 200,
  });

  const world = createWorld();
  const def = world.registerMediobotDefinition({
    name: "Cody", role: "developer", version: "1", instructions: "Code", declaredCapabilities: [],
  });
  const worker = world.spawnWorker(def.id);
  const task = world.assignTask(world.createTask("Subprocess task").id, worker.id);
  const res = world.registerResource({
    kind: "workspace",
    owner: { type: "worker", worldId: world.id, workerId: worker.id },
  });

  const toolRuntime = new ToolRuntime(world, {
    subprocessSupervisor: supervisor,
  });
  await toolRuntime.bindWorkspace(res.id, dir);

  world.setWorkerState(worker.id, "busy");
  world.setTaskState(task.id, "running");
  world.setResourceState(res.id, "in-use");

  try {
    // 1. Execute normal terminal tool call
    const result1 = await toolRuntime.invoke({
      worldId: world.id,
      workerId: worker.id,
      taskId: task.id,
      resourceId: res.id,
      name: "terminal.execute",
      input: { command: "echo phase4-ok" },
    });
    assert.equal(result1.status, "succeeded");
    assert.ok("output" in result1 && typeof result1.output === "object" && result1.output !== null && "stdout" in result1.output && (result1.output as any).stdout.includes("phase4-ok"));
    assert.equal(supervisor.activeCount, 0);

    // 2. Start a long-running process (sleep 10)
    const sleepPromise = toolRuntime.invoke({
      worldId: world.id,
      workerId: worker.id,
      taskId: task.id,
      resourceId: res.id,
      name: "terminal.execute",
      input: { command: "sleep 10" },
    });

    // Wait until process spawns and registers
    await new Promise((r) => setTimeout(r, 100));

    // Supervisor must be tracking the process under task.id
    assert.equal(supervisor.activeCount, 1);
    const activeProcesses = supervisor.getActiveSubprocesses();
    assert.equal(activeProcesses.length, 1);
    assert.equal(activeProcesses[0]!.taskId, task.id);

    // 3. Terminate all subprocesses for task.id (simulating task cancellation)
    await supervisor.terminateTaskSubprocesses(task.id);

    // Process should terminate rapidly
    const resOutput = await sleepPromise;
    assert.ok(resOutput.status === "failed" || resOutput.status === "cancelled");
    assert.equal(supervisor.activeCount, 0);
  } finally {
    await supervisor.terminateAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal cancellation settles the owned process tree before returning", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mediobot-subprocess-tree-cancel-"));
  const supervisor = new SubprocessSupervisor({ killGracePeriodMs: 150 });
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Cody", role: "developer", version: "1",
    instructions: "Code", declaredCapabilities: [] });
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask("Cancel an owned process tree").id, worker.id);
  const resource = world.registerResource({ kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: worker.id } });
  const tools = new ToolRuntime(world, { subprocessSupervisor: supervisor });
  await tools.bindWorkspace(resource.id, dir);
  world.setWorkerState(worker.id, "busy");
  world.setTaskState(task.id, "running");
  world.setResourceState(resource.id, "in-use");

  const readyPath = path.join(dir, "process-tree.json");
  const heartbeatPath = path.join(dir, "descendant-heartbeat.txt");
  const descendant = `process.on('SIGTERM', () => {}); setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(heartbeatPath)}, 'x'), 20)`;
  const parent = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ parent: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);`;
  const controller = new AbortController();
  try {
    const execution = tools.invoke({ worldId: world.id, workerId: worker.id, taskId: task.id, resourceId: resource.id,
      name: "terminal.execute", input: { command: process.execPath, args: ["-e", parent] }, signal: controller.signal });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      try { readFileSync(readyPath, "utf8"); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    const processInfo = JSON.parse(readFileSync(readyPath, "utf8")) as { parent: number; child: number };
    const heartbeatDeadline = Date.now() + 1_000;
    while (Date.now() < heartbeatDeadline) {
      try { if (statSync(heartbeatPath).size > 0) break; }
      catch { /* Wait for the controlled descendant's first heartbeat. */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(statSync(heartbeatPath).size > 0, "the descendant must be active before cancellation");
    assert.equal(supervisor.activeCount, 1, "the running parent must be owned by the task supervisor");
    let settled = false;
    void execution.then(() => { settled = true; });
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(settled, false, "terminal execution must await bounded process-tree escalation");
    assert.equal(supervisor.activeCount, 1, "the process reservation remains counted until its tree is stopped");
    const result = await execution;
    assert.equal(result.status, "cancelled");
    assert.ok(result.output && "termination" in result.output && result.output.termination === "cancelled");
    assert.equal(supervisor.activeCount, 0, "task-owned process reservations are released after settlement");

    const stableSize = statSync(heartbeatPath).size;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(statSync(heartbeatPath).size, stableSize,
      `descendant ${processInfo.child} continued running after parent ${processInfo.parent} settled`);
  } finally {
    controller.abort();
    await supervisor.terminateTaskSubprocesses(task.id);
    await supervisor.terminateAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PHASE 4 E2E: Subprocess Quota Enforcement rejects runaway processes", async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "mediobot-v2-phase4-quota-"));
  const dir1 = path.join(parent, "ws-1");
  const dir2 = path.join(parent, "ws-2");
  mkdirSync(dir1);
  mkdirSync(dir2);

  const supervisor = new SubprocessSupervisor({
    maxConcurrentGlobal: 1,
    maxConcurrentPerWorkspace: 1,
    killGracePeriodMs: 200,
  });

  const world = createWorld();
  const def = world.registerMediobotDefinition({
    name: "Cody", role: "developer", version: "1", instructions: "Code", declaredCapabilities: [],
  });

  const worker1 = world.spawnWorker(def.id);
  const task1 = world.assignTask(world.createTask("Task 1").id, worker1.id);
  const res1 = world.registerResource({
    kind: "workspace",
    owner: { type: "worker", worldId: world.id, workerId: worker1.id },
  });

  const worker2 = world.spawnWorker(def.id);
  const task2 = world.assignTask(world.createTask("Task 2").id, worker2.id);
  const res2 = world.registerResource({
    kind: "workspace",
    owner: { type: "worker", worldId: world.id, workerId: worker2.id },
  });

  const toolRuntime = new ToolRuntime(world, {
    subprocessSupervisor: supervisor,
  });
  await toolRuntime.bindWorkspace(res1.id, dir1);
  await toolRuntime.bindWorkspace(res2.id, dir2);

  // Set active states for both workers
  world.setWorkerState(worker1.id, "busy");
  world.setTaskState(task1.id, "running");
  world.setResourceState(res1.id, "in-use");

  world.setWorkerState(worker2.id, "busy");
  world.setTaskState(task2.id, "running");
  world.setResourceState(res2.id, "in-use");

  try {
    // First background command
    const sleep1 = toolRuntime.invoke({
      worldId: world.id,
      workerId: worker1.id,
      taskId: task1.id,
      resourceId: res1.id,
      name: "terminal.execute",
      input: { command: "sleep 5" },
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(supervisor.activeCount, 1);

    // Second command should exceed quota
    const sleep2Result = await toolRuntime.invoke({
      worldId: world.id,
      workerId: worker2.id,
      taskId: task2.id,
      resourceId: res2.id,
      name: "terminal.execute",
      input: { command: "sleep 5" },
    });
    assert.equal(sleep2Result.status, "failed");
    assert.ok(
      (sleep2Result.error && sleep2Result.error.includes("Subprocess quota exceeded")) ||
      ("output" in sleep2Result && typeof sleep2Result.output === "object" && sleep2Result.output !== null && (sleep2Result.output as any).stderr?.includes("Subprocess quota exceeded"))
    );

    // Cleanup
    await supervisor.terminateAll();
    await sleep1;
  } finally {
    await supervisor.terminateAll();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("PHASE 4 E2E: Browser Runtime Quota Enforcement", async () => {
  const mockBrowser = createMockBrowser();
  const browserRuntime = new PlaywrightBrowserRuntime({
    maxSessions: 1,
    browserLauncher: async () => mockBrowser,
  });

  try {
    const session1 = await browserRuntime.acquireSession({
      resourceId: "browser-res-1" as ResourceId,
      taskId: "task-1" as TaskId,
    });
    assert.equal(browserRuntime.activeSessionCount, 1);

    // Attempting to acquire a second session should throw BrowserSessionQuotaExceededError
    await assert.rejects(
      async () => {
        await browserRuntime.acquireSession({
          resourceId: "browser-res-2" as ResourceId,
          taskId: "task-2" as TaskId,
        });
      },
      (err: any) => {
        return err instanceof BrowserSessionQuotaExceededError;
      }
    );

    // Release session 1
    await browserRuntime.releaseSession("browser-res-1" as ResourceId);
    assert.equal(browserRuntime.activeSessionCount, 0);

    // Now session 2 can be acquired
    const session2 = await browserRuntime.acquireSession({
      resourceId: "browser-res-2" as ResourceId,
      taskId: "task-2" as TaskId,
    });
    assert.equal(browserRuntime.activeSessionCount, 1);
    await browserRuntime.releaseSession("browser-res-2" as ResourceId);
    assert.equal(browserRuntime.activeSessionCount, 0);
  } finally {
    await browserRuntime.shutdown();
  }
});

test("PHASE 4 E2E: Multi-Workspace Fair Resource Governance in Composition Runtime", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mediobot-v2-phase4-comp-"));
  const dbPath = path.join(dir, "composition-governor.db");
  const { database, providerRepo } = makeProvider(dbPath);
  const modelResolver = new ModelResolver(providerRepo);

  const governor = new ResourceGovernor({
    budget: {
      maxConcurrentTasks: 2,
      maxConcurrentTasksPerWorkspace: 1,
    },
  });

  const composition = createComposition({
    modelResolver,
    resourceGovernor: governor,
  });

  try {
    assert.equal(composition.resourceGovernor, governor);
    assert.equal(governor.activeLeasesCount, 0);

    // Acquire slot for workspace A
    const leaseA = await governor.requestTaskAdmission({
      taskId: "task-a" as TaskId,
      workspaceId: "ws-a",
      priority: "background",
    });

    assert.equal(governor.activeLeasesCount, 1);

    // Workspace A cannot exceed per-workspace limit of 1
    assert.equal(governor.canAdmitTask("ws-a", "background"), false);

    // Workspace B can still be admitted
    assert.equal(governor.canAdmitTask("ws-b", "background"), true);

    const leaseB = await governor.requestTaskAdmission({
      taskId: "task-b" as TaskId,
      workspaceId: "ws-b",
      priority: "background",
    });

    assert.equal(governor.activeLeasesCount, 2);

    // Global limit reached (2/2)
    assert.equal(governor.canAdmitTask("ws-c", "background"), false);

    // Enqueue task C for ws-c
    let taskCAdmitted = false;
    const taskCPromise = governor.requestTaskAdmission({
      taskId: "task-c" as TaskId,
      workspaceId: "ws-c",
      priority: "background",
    }).then((lease) => {
      taskCAdmitted = true;
      return lease;
    });

    // Verify task C is queued
    assert.equal(governor.queueLength, 1);
    assert.equal(taskCAdmitted, false);

    // Release lease A -> task C should be immediately admitted
    governor.releaseLease(leaseA.id);
    const leaseC = await taskCPromise;
    assert.equal(taskCAdmitted, true);
    assert.equal(leaseC.workspaceId, "ws-c");

    // Clean up
    governor.releaseLease(leaseB.id);
    governor.releaseLease(leaseC.id);
    assert.equal(governor.activeLeasesCount, 0);
  } finally {
    await governor.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

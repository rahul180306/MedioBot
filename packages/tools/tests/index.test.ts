import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, link, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import type { ResourceId, TaskId, WorkerId } from "@mediobot-v2/domain";
import { ToolRuntime } from "../src/index.ts";
import { ToolPermissionEngine } from "../src/permissions.ts";

type Fixture = {
  world: ReturnType<typeof createWorld>;
  tools: ToolRuntime;
  workerA: WorkerId;
  workerB: WorkerId;
  taskA: TaskId;
  taskB: TaskId;
  resourceA: ResourceId;
  resourceB: ResourceId;
  rootA: string;
  rootB: string;
  cleanup(): Promise<void>;
};

type JournalEvent = { taskId: string; eventType: string; payload: Record<string, unknown> };
class TestInvocationJournal {
  readonly events: JournalEvent[] = [];
  async appendEvent(taskId: string, eventType: string, payload: Record<string, unknown>) {
    this.events.push({ taskId, eventType, payload });
    return { sequenceNumber: this.events.length };
  }
  async getEvents(taskId: string) { return this.events.filter(event => event.taskId === taskId); }
}

async function fixture(options?: { readonly invocationJournal?: TestInvocationJournal }): Promise<Fixture> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "mediobot-tools-"));
  const rootA = path.join(parent, "workspace-a");
  const rootB = path.join(parent, "workspace-b");
  await Promise.all([mkdir(rootA), mkdir(rootB)]);
  const world = createWorld();
  const definitionA = world.registerMediobotDefinition({
    name: "A", role: "test", version: "1", instructions: "A", declaredCapabilities: [],
  });
  const definitionB = world.registerMediobotDefinition({
    name: "B", role: "test", version: "1", instructions: "B", declaredCapabilities: [],
  });
  const a = world.spawnWorker(definitionA.id);
  const b = world.spawnWorker(definitionB.id);
  const taskA = world.assignTask(world.createTask("task A").id, a.id);
  const taskB = world.assignTask(world.createTask("task B").id, b.id);
  const resourceA = world.registerResource({
    kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: a.id },
  });
  const resourceB = world.registerResource({
    kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: b.id },
  });
  const tools = new ToolRuntime(world, options);
  await tools.bindWorkspace(resourceA.id, rootA);
  await tools.bindWorkspace(resourceB.id, rootB);
  return {
    world, tools, workerA: a.id, workerB: b.id, taskA: taskA.id, taskB: taskB.id,
    resourceA: resourceA.id, resourceB: resourceB.id, rootA, rootB,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

function invocation(f: Fixture, worker: "A" | "B", input: any, signal?: AbortSignal) {
  return {
    worldId: f.world.id,
    workerId: worker === "A" ? f.workerA : f.workerB,
    taskId: worker === "A" ? f.taskA : f.taskB,
    resourceId: worker === "A" ? f.resourceA : f.resourceB,
    signal,
    input,
  };
}

async function withActiveTask<T>(f: Fixture, worker: "A" | "B", action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let result!: T;
  const taskId = worker === "A" ? f.taskA : f.taskB;
  const workerId = worker === "A" ? f.workerA : f.workerB;
  const resourceId = worker === "A" ? f.resourceA : f.resourceB;
  f.world.setWorkerState(workerId, "busy");
  f.world.setTaskState(taskId, "running");
  f.world.setResourceState(resourceId, "in-use");
  try {
    result = await action(new AbortController().signal);
  } finally {
    f.world.setTaskState(taskId, "completed");
    f.world.setResourceState(resourceId, "released");
    f.world.setWorkerState(workerId, "idle");
  }
  return result;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Child process did not create its start marker: ${filePath}`);
}

describe("native tool runtime", () => {
  it("creates only an absent file atomically and refuses to replace a file that appeared after observation", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const pathName = "src/is_prime.py";
    await mkdir(path.join(f.rootA, "src"));
    await withActiveTask(f, "A", async (signal) => {
      const created = await f.tools.invoke({ ...invocation(f, "A", { path: pathName, content: "def is_prime(n): return n > 1\\n", createOnly: true }, signal),
        name: "filesystem.write" });
      assert.equal(created.status, "succeeded");
      assert.match(await readFile(path.join(f.rootA, pathName), "utf8"), /def is_prime/);

      await writeFile(path.join(f.rootA, "appeared.py"), "preserve me\\n");
      const collision = await f.tools.invoke({ ...invocation(f, "A", { path: "appeared.py", content: "overwrite", createOnly: true }, signal),
        name: "filesystem.write" });
      assert.equal(collision.status, "failed");
      assert.equal(collision.errorCode, "EEXIST");
      assert.equal(await readFile(path.join(f.rootA, "appeared.py"), "utf8"), "preserve me\\n");
    });
  });

  it("rejects a replacement write whose observed content became stale", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const original = "before\n";
    const expectedContentHash = createHash("sha256").update(original).digest("hex");
    await writeFile(path.join(f.rootA, "shared.txt"), original);
    await withActiveTask(f, "A", async (signal) => {
      const first = await f.tools.invoke({ ...invocation(f, "A", {
        path: "shared.txt", content: "first update\n", expectedContentHash,
      }, signal), name: "filesystem.write" });
      const stale = await f.tools.invoke({ ...invocation(f, "A", {
        path: "shared.txt", content: "stale update\n", expectedContentHash,
      }, signal), name: "filesystem.write" });
      assert.equal(first.status, "succeeded");
      assert.equal(stale.status, "failed");
      assert.equal(stale.errorCode, "STALE_REVISION");
      assert.equal(await readFile(path.join(f.rootA, "shared.txt"), "utf8"), "first update\n");
    });
  });

  it("serializes competing writes addressed through case aliases on case-insensitive filesystems", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const original = "base version\n";
    await writeFile(path.join(f.rootA, "shared.txt"), original);
    try {
      const [lower, upper] = await Promise.all([
        stat(path.join(f.rootA, "shared.txt")),
        stat(path.join(f.rootA, "SHARED.TXT")),
      ]);
      if (lower.dev !== upper.dev || lower.ino !== upper.ino) {
        t.skip("workspace filesystem is case-sensitive");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") t.skip("workspace filesystem is case-sensitive");
      throw error;
    }

    await withActiveTask(f, "A", async (signal) => {
      const expectedContentHash = createHash("sha256").update(original).digest("hex");
      const [lowerWrite, caseAliasWrite] = await Promise.all([
        f.tools.invoke({ ...invocation(f, "A", { path: "shared.txt", content: "lowercase winner\n", expectedContentHash }, signal), name: "filesystem.write" }),
        f.tools.invoke({ ...invocation(f, "A", { path: "SHARED.TXT", content: "case alias loser\n", expectedContentHash }, signal), name: "filesystem.write" }),
      ]);
      assert.deepEqual([lowerWrite.status, caseAliasWrite.status].sort(), ["failed", "succeeded"]);
      const rejected = lowerWrite.status === "failed" ? lowerWrite : caseAliasWrite;
      assert.equal(rejected.errorCode, "STALE_REVISION");
      assert.match(await readFile(path.join(f.rootA, "shared.txt"), "utf8"), /^(lowercase winner|case alias loser)\n$/);
    });
  });

  it("allows only sibling tasks in one parent to bind the same canonical workspace root", async (t) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "mediobot-shared-workspace-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "root");
    await mkdir(root);
    const world = createWorld();
    const definition = world.registerMediobotDefinition({ name: "Worker", role: "test", version: "1",
      instructions: "test", declaredCapabilities: [] });
    const workerA = world.spawnWorker(definition.id);
    const workerB = world.spawnWorker(definition.id);
    const parentTask = world.createTask("Parent");
    const taskA = world.assignTask(world.createTask("Sibling A", parentTask.id).id, workerA.id);
    const taskB = world.assignTask(world.createTask("Sibling B", parentTask.id).id, workerB.id);
    const resourceA = world.registerResource({ kind: "workspace", owner: { type: "task", worldId: world.id, taskId: taskA.id } });
    const resourceB = world.registerResource({ kind: "workspace", owner: { type: "task", worldId: world.id, taskId: taskB.id } });
    const toolsA = new ToolRuntime(world);
    const toolsB = new ToolRuntime(world);
    await toolsA.bindWorkspace(resourceA.id, root);
    await toolsB.bindWorkspace(resourceB.id, root);

    const unrelated = world.assignTask(world.createTask("Unrelated").id, workerB.id);
    const unrelatedResource = world.registerResource({ kind: "workspace", owner: { type: "task", worldId: world.id, taskId: unrelated.id } });
    await assert.rejects(new ToolRuntime(world).bindWorkspace(unrelatedResource.id, root), /overlap/i);

    world.setWorkerState(workerA.id, "busy");
    world.setWorkerState(workerB.id, "busy");
    world.setTaskState(taskA.id, "running");
    world.setTaskState(taskB.id, "running");
    world.setResourceState(resourceA.id, "in-use");
    world.setResourceState(resourceB.id, "in-use");
    const first = await toolsA.invoke({ worldId: world.id, workerId: workerA.id, taskId: taskA.id, resourceId: resourceA.id,
      name: "filesystem.write", input: { path: "shared.txt", content: "base\n", createOnly: true } });
    assert.equal(first.status, "succeeded");
    const expectedContentHash = createHash("sha256").update("base\n").digest("hex");
    const [writeA, writeB] = await Promise.all([
      toolsA.invoke({ worldId: world.id, workerId: workerA.id, taskId: taskA.id, resourceId: resourceA.id,
        name: "filesystem.write", input: { path: "shared.txt", content: "A update\n", expectedContentHash } }),
      toolsB.invoke({ worldId: world.id, workerId: workerB.id, taskId: taskB.id, resourceId: resourceB.id,
        name: "filesystem.write", input: { path: "shared.txt", content: "B update\n", expectedContentHash } }),
    ]);
    assert.deepEqual([writeA.status, writeB.status].sort(), ["failed", "succeeded"]);
    const rejected = writeA.status === "failed" ? writeA : writeB;
    assert.equal(rejected.errorCode, "STALE_REVISION");
    assert.match(await readFile(path.join(root, "shared.txt"), "utf8"), /^(A|B) update\n$/);

    world.setTaskState(taskA.id, "completed");
    world.setTaskState(taskB.id, "completed");
    world.setWorkerState(workerA.id, "idle");
    world.setWorkerState(workerB.id, "idle");
    toolsA.releaseWorkspace(resourceA.id);
    toolsB.releaseWorkspace(resourceB.id);
  });

  it("bubbles a graph approval interrupt without executing the protected filesystem action", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const permission = new ToolPermissionEngine({ defaultPolicy: { mode: "Require approval" } });
    permission.bindTaskContext(f.taskA, { threadId: "thread-a", turnId: "turn-a", policy: { mode: "Require approval" } });
    f.tools.setPermissionEngine(permission);
    const controlSignal = Object.assign(new Error("graph interrupt"), { graphControl: true });
    await withActiveTask(f, "A", async (signal) => {
      await assert.rejects(f.tools.invoke({
        ...invocation(f, "A", { path: "approved.txt", content: "must wait" }, signal), name: "filesystem.write",
      }, {
        interruptTask: (value) => {
          assert.equal((value as { kind: string }).kind, "tool-approval");
          throw controlSignal;
        },
        isControlSignal: error => error === controlSignal,
      }), error => error === controlSignal);
      assert.equal(permission.getPendingApprovals().length, 1);
      assert.equal(await readFile(path.join(f.rootA, "approved.txt"), "utf8").catch(() => "missing"), "missing");
      const pending = permission.getPendingApprovals()[0]!;
      assert.equal(permission.respond(pending.approvalId, false, { threadId: "thread-a", turnId: "turn-a" }).success, true);
    });
  });

  it("releases a completed workspace binding so a later task can safely reuse the project", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    f.tools.releaseWorkspace(f.resourceA);
    const nextResource = f.world.registerResource({ kind: "workspace", owner: {
      type: "task", worldId: f.world.id, taskId: f.taskA,
    } });
    await f.tools.bindWorkspace(nextResource.id, f.rootA);
    assert.ok(true);
  });

  it("hides credential files and never passes API credentials into child processes", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.rootA, ".env"), "MEDIOBOT_PRIVATE_TEST=not-for-tools\n");
    const key = "MEDIOBOT_TOOL_TEST_API_KEY";
    const prior = process.env[key];
    process.env[key] = "not-for-tools";
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
    await withActiveTask(f, "A", async (signal) => {
      const list = await f.tools.invoke({ ...invocation(f, "A", { path: "." }, signal), name: "filesystem.list" });
      assert.equal(list.status, "succeeded");
      assert.ok(list.output && "entries" in list.output);
      assert.ok(!list.output.entries.includes(".env"));
      const read = await f.tools.invoke({ ...invocation(f, "A", { path: ".env" }, signal), name: "filesystem.read" });
      assert.equal(read.status, "failed");
      assert.match(read.error ?? "", /Credential and secret files/);
      const write = await f.tools.invoke({ ...invocation(f, "A", { path: ".env", content: "overwrite" }, signal), name: "filesystem.write" });
      assert.equal(write.status, "failed");
      const terminal = await f.tools.invoke({ ...invocation(f, "A", {
        command: process.execPath, args: ["-e", `process.stdout.write(process.env.${key} ?? "missing")`],
      }, signal), name: "terminal.execute" });
      assert.equal(terminal.status, "succeeded");
      assert.ok(terminal.output && "stdout" in terminal.output);
      assert.equal(terminal.output.stdout, "missing");
    });
  });

  it("enforces worker workspace ownership and scopes reads and writes", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.rootA, "note.txt"), "A");
    await withActiveTask(f, "A", async (signal) => {
      const read = await f.tools.invoke({
        ...invocation(f, "A", { path: "note.txt" }, signal), name: "filesystem.read",
      });
      assert.equal(read.status, "succeeded");
      assert.deepEqual(read.output, { content: "A" });
      const write = await f.tools.invoke({
        ...invocation(f, "A", { path: "nested/new.txt", content: "written by A" }, signal), name: "filesystem.write",
      });
      assert.equal(write.status, "succeeded");
      assert.equal(await readFile(path.join(f.rootA, "nested/new.txt"), "utf8"), "written by A");
      const wrongResource = await f.tools.invoke({
        ...invocation(f, "A", { path: "note.txt" }, signal), resourceId: f.resourceB, name: "filesystem.read",
      });
      assert.equal(wrongResource.status, "failed");
      assert.equal(wrongResource.toolName, "filesystem.read");
      const wrongResourceWrite = await f.tools.invoke({
        ...invocation(f, "A", { path: "note.txt", content: "must not cross workers" }, signal),
        resourceId: f.resourceB,
        name: "filesystem.write",
      });
      assert.equal(wrongResourceWrite.status, "failed");
      assert.equal(await readFile(path.join(f.rootB, "note.txt")).catch(() => "missing"), "missing");
    });
  });

  it("rejects another task's workspace, non-workspace resources, and overlapping root bindings", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const overlappingRuntime = new ToolRuntime(f.world);
    const overlappingResource = f.world.registerResource({
      kind: "workspace", owner: { type: "worker", worldId: f.world.id, workerId: f.workerB },
    });
    await assert.rejects(overlappingRuntime.bindWorkspace(overlappingResource.id, f.rootA), /overlap/i);
    const taskOwnedWorkspace = f.world.registerResource({
      kind: "workspace", owner: { type: "task", worldId: f.world.id, taskId: f.taskA },
    });
    const nonWorkspace = f.world.registerResource({
      kind: "terminal", owner: { type: "worker", worldId: f.world.id, workerId: f.workerA },
    });
    await assert.rejects(f.tools.bindWorkspace(nonWorkspace.id, f.rootB), /workspace resource/i);
    const taskRoot = path.join(path.dirname(f.rootA), "task-owned");
    await mkdir(taskRoot);
    await f.tools.bindWorkspace(taskOwnedWorkspace.id, taskRoot);
    f.world.setWorkerState(f.workerA, "busy");
    f.world.setTaskState(f.taskA, "running");
    f.world.setResourceState(taskOwnedWorkspace.id, "in-use");
    f.world.setWorkerState(f.workerB, "busy");
    f.world.setTaskState(f.taskB, "running");
    f.world.setResourceState(f.resourceB, "in-use");
    const wrongTask = await f.tools.invoke({
      worldId: f.world.id,
      workerId: f.workerB,
      taskId: f.taskB,
      resourceId: taskOwnedWorkspace.id,
      name: "filesystem.list",
      input: { path: "." },
    });
    assert.equal(wrongTask.status, "failed");
    f.world.setTaskState(f.taskA, "completed");
    f.world.setResourceState(taskOwnedWorkspace.id, "released");
    f.world.setWorkerState(f.workerA, "idle");
    f.world.setTaskState(f.taskB, "completed");
    f.world.setResourceState(f.resourceB, "released");
    f.world.setWorkerState(f.workerB, "idle");
  });

  it("serializes competing workspace bindings across tool runtime instances", async (t) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "mediobot-binding-race-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "root");
    const nested = path.join(root, "nested");
    await mkdir(nested, { recursive: true });
    const world = createWorld();
    const definition = world.registerMediobotDefinition({
      name: "Worker", role: "test", version: "1", instructions: "test", declaredCapabilities: [],
    });
    const firstWorker = world.spawnWorker(definition.id);
    const secondWorker = world.spawnWorker(definition.id);
    const firstResource = world.registerResource({
      kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: firstWorker.id },
    });
    const secondResource = world.registerResource({
      kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: secondWorker.id },
    });
    const firstTools = new ToolRuntime(world);
    const secondTools = new ToolRuntime(world);
    const results = await Promise.allSettled([
      firstTools.bindWorkspace(firstResource.id, root),
      secondTools.bindWorkspace(secondResource.id, nested),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  });

  it("rejects traversal and POSIX, Windows, UNC, and drive-relative absolute paths", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const paths = ["../outside.txt", "sub/../../outside.txt", "/tmp/outside.txt", "C:\\outside.txt", "C:outside.txt", "\\\\server\\share\\outside.txt"];
    await withActiveTask(f, "A", async (signal) => {
      for (const candidate of paths) {
        const result = await f.tools.invoke({
          ...invocation(f, "A", { path: candidate }, signal), name: "filesystem.read",
        });
        assert.equal(result.status, "failed", `accepted ${candidate}`);
      }
    });
  });

  it("rejects terminal working directories outside the owned workspace", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await withActiveTask(f, "A", async (signal) => {
      const result = await f.tools.invoke({
        ...invocation(f, "A", { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: "../workspace-b" }, signal),
        name: "terminal.execute",
      });
      assert.equal(result.status, "failed");
    });
  });

  it("records tool lifecycle and result attribution for success, failure, and cancellation", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const { success, failure } = await withActiveTask(f, "A", async (signal) => {
      const success = await f.tools.invoke({
        ...invocation(f, "A", { path: "." }, signal), name: "filesystem.list",
      });
      const failure = await f.tools.invoke({
        ...invocation(f, "A", { command: process.execPath, args: ["-e", "process.exit(7)"] }, signal),
        name: "terminal.execute",
      });
      return { success, failure };
    });
    assert.equal(success.status, "succeeded");
    assert.equal(failure.status, "failed");
    const events = f.world.inspect().events.filter((event) => event.toolName);
    assert.deepEqual(events.map((event) => event.type), [
      "tool.started", "tool.succeeded", "tool.started", "tool.failed",
    ]);
    assert.ok(events.every((event) => event.worldId === f.world.id
      && event.workerId === f.workerA && event.taskId === f.taskA && event.resourceId === f.resourceA));
    assert.deepEqual(events.map((event) => event.toolName), [
      "filesystem.list", "filesystem.list", "terminal.execute", "terminal.execute",
    ]);
  });

  it("keeps concurrent filesystem operations isolated between workspaces", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const gate = deferred();
    const run = (worker: "A" | "B", content: string) => withActiveTask(f, worker, async (signal) => {
      await gate.promise;
      return f.tools.invoke({
        ...invocation(f, worker, { path: "same.txt", content }, signal), name: "filesystem.write",
      });
    });
    const a = run("A", "alpha");
    const b = run("B", "beta");
    gate.resolve();
    const [resultA, resultB] = await Promise.all([a, b]);
    assert.equal(resultA.status, "succeeded");
    assert.equal(resultA.workerId, f.workerA);
    assert.equal(resultB.status, "succeeded");
    assert.equal(resultB.workerId, f.workerB);
    assert.equal(await readFile(path.join(f.rootA, "same.txt"), "utf8"), "alpha");
    assert.equal(await readFile(path.join(f.rootB, "same.txt"), "utf8"), "beta");
  });

  it("runs concurrent terminal commands with independent structured output", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const gate = deferred();
    const run = (worker: "A" | "B", text: string) => withActiveTask(f, worker, async (signal) => {
      await gate.promise;
      return f.tools.invoke({
        ...invocation(f, worker, { command: process.execPath, args: ["-e", `console.log(${JSON.stringify(text)})`] }, signal),
        name: "terminal.execute",
      });
    });
    const pendingA = run("A", "from-A");
    const pendingB = run("B", "from-B");
    gate.resolve();
    const [a, b] = await Promise.all([pendingA, pendingB]);
    assert.equal(a.status, "succeeded");
    assert.ok(a.output && "stdout" in a.output);
    assert.equal(a.output.stdout.trim(), "from-A");
    assert.equal(a.workerId, f.workerA);
    assert.equal(b.status, "succeeded");
    assert.ok(b.output && "stdout" in b.output);
    assert.equal(b.output.stdout.trim(), "from-B");
    assert.equal(b.workerId, f.workerB);
  });

  it("bounds captured terminal output and reports truncation", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const result = await withActiveTask(f, "A", (signal) => f.tools.invoke({
      ...invocation(f, "A", {
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
      }, signal),
      name: "terminal.execute",
    }));
    assert.equal(result.status, "succeeded");
    assert.ok(result.output && "stdout" in result.output);
    assert.equal(Buffer.byteLength(result.output.stdout), 1024 * 1024);
    assert.equal(result.output.stdoutTruncated, true);
    assert.equal(result.output.stderrTruncated, false);
  });

  it("rejects a filesystem read beyond the configured memory bound", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.rootA, "large.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
    const result = await withActiveTask(f, "A", (signal) => f.tools.invoke({
      ...invocation(f, "A", { path: "large.bin" }, signal), name: "filesystem.read",
    }));
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /8388608 byte read limit/);
  });

  it("cancels only task A's child process while task B continues", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    f.world.setWorkerState(f.workerA, "busy");
    f.world.setTaskState(f.taskA, "running");
    f.world.setResourceState(f.resourceA, "in-use");
    f.world.setWorkerState(f.workerB, "busy");
    f.world.setTaskState(f.taskB, "running");
    f.world.setResourceState(f.resourceB, "in-use");
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const startedA = waitForFile(path.join(f.rootA, "started-a"));
    const startedB = waitForFile(path.join(f.rootB, "started-b"));
    const toolPromiseA = f.tools.invoke({
      ...invocation(f, "A", { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('started-a', 'ready'); setInterval(() => {}, 1000)"] }, controllerA.signal),
      name: "terminal.execute",
    });
    const toolPromiseB = f.tools.invoke({
      ...invocation(f, "B", { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('started-b', 'ready'); setTimeout(() => console.log('B alive'), 180)"] }, controllerB.signal),
      name: "terminal.execute",
    });
    await Promise.all([startedA, startedB]);
    controllerA.abort();
    const [toolA, toolB] = await Promise.all([toolPromiseA, toolPromiseB]);
    assert.equal(toolA.status, "cancelled");
    assert.equal(toolB.status, "succeeded");
    assert.ok(toolB.output && "stdout" in toolB.output);
    assert.match(toolB.output.stdout, /B alive/);
    assert.equal(toolA.workerId, f.workerA);
    assert.equal(toolB.workerId, f.workerB);
    f.world.setTaskState(f.taskA, "cancelled");
    f.world.setResourceState(f.resourceA, "released");
    f.world.setWorkerState(f.workerA, "idle");
    f.world.setTaskState(f.taskB, "completed");
    f.world.setResourceState(f.resourceB, "released");
    f.world.setWorkerState(f.workerB, "idle");
    const toolEvents = f.world.inspect().events.filter((event) => event.toolName);
    assert.ok(toolEvents.some((event) => event.type === "tool.cancelled" && event.workerId === f.workerA));
    assert.ok(toolEvents.some((event) => event.type === "tool.succeeded" && event.workerId === f.workerB));
  });

  it("keeps a failed terminal command from changing the other worker's task", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const [a, b] = await Promise.all([
      withActiveTask(f, "A", (signal) => f.tools.invoke({
        ...invocation(f, "A", { command: process.execPath, args: ["-e", "process.stderr.write('bad'); process.exit(3)"] }, signal),
        name: "terminal.execute",
      })),
      withActiveTask(f, "B", (signal) => f.tools.invoke({
        ...invocation(f, "B", { command: process.execPath, args: ["-e", "console.log('good')"] }, signal),
        name: "terminal.execute",
      })),
    ]);
    assert.equal(a.status, "failed");
    assert.ok(a.output && "exitCode" in a.output);
    assert.equal(a.output.exitCode, 3);
    assert.equal(b.status, "succeeded");
    assert.ok(b.output && "stdout" in b.output);
    assert.equal(b.output.stdout.trim(), "good");
    assert.equal(f.world.inspect().tasks.find((task) => task.id === f.taskB)?.state, "completed");
  });

  it("distinguishes a process launch failure from a command that exited nonzero", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const result = await withActiveTask(f, "A", signal => f.tools.invoke({
      ...invocation(f, "A", { command: "mediobot-command-that-does-not-exist" }, signal),
      name: "terminal.execute",
    }));
    assert.equal(result.status, "failed");
    assert.equal(result.failureStage, "terminal");
    assert.equal(result.errorCode, "ENOENT");
    assert.equal(result.error, "Command could not start (ENOENT).");
    assert.ok(result.output && "exitCode" in result.output);
    assert.equal(result.output.exitCode, null);
  });

  it("retains a safe termination signal and restores it without rerunning the command", async (t) => {
    const journal = new TestInvocationJournal();
    const f = await fixture({ invocationJournal: journal });
    t.after(f.cleanup);
    if (process.platform === "win32") {
      t.skip("Node child signal termination is not reported consistently by Windows");
      return;
    }
    const executionKey = `${f.taskA}:signal-test`;
    const command = `process.stderr.write('private diagnostic'); process.kill(process.pid, 'SIGTERM')`;
    await withActiveTask(f, "A", async signal => {
      const first = await f.tools.invoke({
        ...invocation(f, "A", { command: process.execPath, args: ["-e", command] }, signal),
        name: "terminal.execute", executionKey,
      });
      assert.equal(first.status, "failed");
      assert.equal(first.error, "Process terminated by signal SIGTERM.");
      assert.equal(first.errorCode, "PROCESS_TERMINATED");
      assert.ok(first.output && "exitCode" in first.output);
      assert.equal(first.output.exitCode, null);
      assert.equal(first.output.terminationSignal, "SIGTERM");
      const settled = journal.events.find(event => event.eventType === "tool.side_effect.settled");
      assert.equal(settled?.payload.terminationSignal, "SIGTERM");

      const recovered = await f.tools.invoke({
        ...invocation(f, "A", { command: process.execPath, args: ["-e", command] }, signal),
        name: "terminal.execute", executionKey,
      });
      assert.equal(recovered.status, "failed");
      assert.equal(recovered.recoveredFromExecution, true);
      assert.ok(recovered.output && "exitCode" in recovered.output);
      assert.equal(recovered.output.terminationSignal, "SIGTERM");
      assert.equal(journal.events.filter(event => event.eventType === "tool.side_effect.started").length, 1,
        "recovery restores the failed process result without executing a side effect again");
    });
  });

  it("restores a settled terminal result without repeating the same command", async (t) => {
    const journal = new TestInvocationJournal();
    const parent = await mkdtemp(path.join(os.tmpdir(), "mediobot-terminal-journal-"));
    const f = await fixture({ invocationJournal: journal });
    t.after(async () => { await f.cleanup(); await rm(parent, { recursive: true, force: true }); });
    const marker = path.join(parent, "effects.txt");
    const command = `process.stdout.write('ok'); require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'effect\\n')`;
    await withActiveTask(f, "A", async signal => {
      const first = await f.tools.invoke({
        ...invocation(f, "A", { command: process.execPath, args: ["-e", command] }, signal), name: "terminal.execute",
        executionKey: `${f.taskA}:step:1`,
      });
      assert.equal(first.status, "succeeded");
      const recovered = await f.tools.invoke({
        ...invocation(f, "A", { command: process.execPath, args: ["-e", command] }, signal), name: "terminal.execute",
        executionKey: `${f.taskA}:step:1`,
      });
      assert.equal(recovered.status, "succeeded");
      assert.equal(recovered.recoveredFromExecution, true);
      assert.ok(recovered.output && "exitCode" in recovered.output);
      assert.equal(recovered.output.exitCode, 0);
      assert.equal(journal.events.filter(event => event.eventType === "tool.side_effect.started").length, 1);
      const nextLogicalAction = await f.tools.invoke({
        ...invocation(f, "A", { command: process.execPath, args: ["-e", command] }, signal), name: "terminal.execute",
        executionKey: `${f.taskA}:step:2`,
      });
      assert.equal(nextLogicalAction.status, "succeeded");
    });
    assert.equal(journal.events.filter(event => event.eventType === "tool.side_effect.started").length, 2);
    assert.equal(journal.events.filter(event => event.eventType === "tool.side_effect.settled").length, 2);
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 2,
      "a retry with the same execution key must not replay, while a new logical action may run the same command");
  });

  it("fails closed on a terminal invocation left unsettled by a process crash", async (t) => {
    const journal = new TestInvocationJournal();
    const parent = await mkdtemp(path.join(os.tmpdir(), "mediobot-terminal-ambiguous-"));
    const f = await fixture({ invocationJournal: journal });
    t.after(async () => { await f.cleanup(); await rm(parent, { recursive: true, force: true }); });
    journal.events.push({ taskId: f.taskA, eventType: "tool.side_effect.started", payload: {
      invocationId: "interrupted-invocation", workerId: f.workerA, toolName: "terminal.execute", signature: "prior-command",
    } });
    const marker = path.join(parent, "must-not-exist.txt");
    const result = await withActiveTask(f, "A", signal => f.tools.invoke({
      ...invocation(f, "A", { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`] }, signal),
      name: "terminal.execute",
    }));
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "TERMINAL_OUTCOME_UNKNOWN");
    await assert.rejects(access(marker), { code: "ENOENT" });
    assert.equal(journal.events.filter(event => event.eventType === "tool.side_effect.started").length, 1,
      "an ambiguous prior operation must block another process launch");
  });

  it("rejects symlink escapes for file reads, directory listing, writes, and cwd", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const outside = await mkdtemp(path.join(os.tmpdir(), "mediobot-outside-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    try {
      await symlink(outside, path.join(f.rootA, "escape"), process.platform === "win32" ? "junction" : "dir");
      await symlink(path.join(outside, "secret.txt"), path.join(f.rootA, "secret-link"), "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
        t.skip(`symlink creation unavailable in this environment (${code})`);
        return;
      }
      throw error;
    }
    await withActiveTask(f, "A", async (signal) => {
      const read = await f.tools.invoke({ ...invocation(f, "A", { path: "secret-link" }, signal), name: "filesystem.read" });
      const list = await f.tools.invoke({ ...invocation(f, "A", { path: "escape" }, signal), name: "filesystem.list" });
      const write = await f.tools.invoke({ ...invocation(f, "A", { path: "escape/new.txt", content: "bad" }, signal), name: "filesystem.write" });
      const cwd = await f.tools.invoke({
        ...invocation(f, "A", { command: process.execPath, args: ["-e", ""], cwd: "escape" }, signal),
        name: "terminal.execute",
      });
      assert.deepEqual([read.status, list.status, write.status, cwd.status], ["failed", "failed", "failed", "failed"]);
      assert.equal(await readFile(path.join(outside, "new.txt")).catch(() => "missing"), "missing");
    });

    const swappedFixture = await fixture();
    t.after(swappedFixture.cleanup);
    const originalRoot = `${swappedFixture.rootA}-original`;
    t.after(() => rm(originalRoot, { recursive: true, force: true }));
    await rename(swappedFixture.rootA, originalRoot);
    try {
      await symlink(outside, swappedFixture.rootA, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
        t.skip(`workspace root symlink replacement unavailable (${code})`);
        return;
      }
      throw error;
    }
    const swappedRoot = await withActiveTask(swappedFixture, "A", (signal) => swappedFixture.tools.invoke({
      ...invocation(swappedFixture, "A", { path: "." }, signal), name: "filesystem.list",
    }));
    assert.equal(swappedRoot.status, "failed");
    assert.match(swappedRoot.error ?? "", /workspace root changed/i);
  });

  it("rejects hard-linked files for workspace reads and writes", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const outside = path.join(path.dirname(f.rootA), "outside-hardlink.txt");
    const inside = path.join(f.rootA, "linked.txt");
    await writeFile(outside, "outside");
    try {
      await link(outside, inside);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS" || code === "EXDEV") {
        t.skip(`hard-link creation unavailable in this environment (${code})`);
        return;
      }
      throw error;
    }
    await withActiveTask(f, "A", async (signal) => {
      const read = await f.tools.invoke({ ...invocation(f, "A", { path: "linked.txt" }, signal), name: "filesystem.read" });
      const write = await f.tools.invoke({
        ...invocation(f, "A", { path: "linked.txt", content: "changed" }, signal), name: "filesystem.write",
      });
      assert.equal(read.status, "failed");
      assert.equal(write.status, "failed");
      assert.equal(await readFile(outside, "utf8"), "outside");
    });
  });

  it("rejects special files rather than blocking on a FIFO read", async (t) => {
    if (process.platform === "win32") {
      t.skip("FIFO fixtures are Unix-only");
      return;
    }
    const f = await fixture();
    t.after(f.cleanup);
    const fifo = path.join(f.rootA, "blocked.fifo");
    const child = spawn("mkfifo", [fifo], { shell: false });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`)));
    });
    const result = await withActiveTask(f, "A", (signal) => f.tools.invoke({
      ...invocation(f, "A", { path: "blocked.fifo" }, signal), name: "filesystem.read",
    }));
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /regular files/i);
  });

  it("documents and keeps tool tests independent from shell-specific commands", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('node')"], { shell: false });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    });
    assert.equal(Buffer.concat(output).toString(), "node");
  });
});

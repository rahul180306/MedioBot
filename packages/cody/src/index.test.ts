import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { WorkerRuntime } from "@mediobot-v2/runtime";
import { ToolRuntime } from "@mediobot-v2/tools";
import type { ToolResult } from "@mediobot-v2/tools";
import { createCodyDefinition } from "./index.ts";

function entries(result: ToolResult): ReadonlyArray<string> {
  assert.ok(result.output && "entries" in result.output);
  return result.output.entries;
}

function content(result: ToolResult): string {
  assert.ok(result.output && "content" in result.output);
  return result.output.content;
}

function processOutput(result: ToolResult) {
  assert.ok(result.output && "exitCode" in result.output);
  return result.output;
}

describe("Cody native tool proof", () => {
  it("repairs a broken project only through the owned tool boundary", async (t) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const workspace = path.join(temporary, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await mkdir(path.join(workspace, "test"), { recursive: true });
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({
      name: "deterministic-cody-fixture",
      private: true,
      type: "module",
      scripts: { test: "node --test test/math.test.js" },
    }, null, 2));
    await writeFile(path.join(workspace, "src/math.js"), "export function add(a, b) { return a * b; }\n");
    await writeFile(path.join(workspace, "test/math.test.js"), [
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.js';",
      "assert.equal(add(2, 3), 5, 'add(2, 3) should equal 5');",
      "console.log('# pass 1');",
      "",
    ].join("\n"));

    const world = createWorld();
    const definition = createCodyDefinition(world);
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Repair the addition test").id, worker.id);
    const workspaceResource = world.registerResource({
      kind: "workspace",
      owner: { type: "worker", worldId: world.id, workerId: worker.id },
    });
    const runtime = new WorkerRuntime(world);
    const tools = new ToolRuntime(world);
    await tools.bindWorkspace(workspaceResource.id, workspace);
    const toolTrace: string[] = [];
    let initialFailure = "";
    let finalOutput = "";

    const runResult = await runtime.run({
      workerId: worker.id,
      taskId: task.id,
      resourceIds: [workspaceResource.id],
      execute: async ({ signal }) => {
        const call = async (name: "filesystem.list" | "filesystem.read" | "filesystem.write" | "terminal.execute", input: object) => {
          toolTrace.push(name);
          return tools.invoke({
            worldId: world.id,
            workerId: worker.id,
            taskId: task.id,
            resourceId: workspaceResource.id,
            name,
            input,
            signal,
          } as Parameters<ToolRuntime["invoke"]>[0]);
        };

        const listing = await call("filesystem.list", { path: "." });
        assert.equal(listing.status, "succeeded");
        assert.deepEqual(entries(listing), ["package.json", "src", "test"]);
        const manifest = await call("filesystem.read", { path: "package.json" });
        assert.equal(manifest.status, "succeeded");
        assert.match(content(manifest), /deterministic-cody-fixture/);
        const source = await call("filesystem.read", { path: "src/math.js" });
        const testFile = await call("filesystem.read", { path: "test/math.test.js" });
        assert.equal(source.status, "succeeded");
        assert.equal(testFile.status, "succeeded");

        const before = await call("terminal.execute", {
          command: process.execPath,
          args: ["test/math.test.js"],
        });
        assert.equal(before.status, "failed", JSON.stringify(before));
        assert.notEqual(processOutput(before).exitCode, 0);
        initialFailure = `${processOutput(before).stdout}${processOutput(before).stderr}`;
        assert.match(initialFailure, /not ok|AssertionError|ERR_ASSERTION/);

        const edited = await call("filesystem.write", {
          path: "src/math.js",
          content: "export function add(a, b) { return a + b; }\n",
        });
        assert.equal(edited.status, "succeeded");
        const after = await call("terminal.execute", {
          command: process.execPath,
          args: ["test/math.test.js"],
        });
        assert.equal(after.status, "succeeded");
        finalOutput = processOutput(after).stdout;
        assert.match(finalOutput, /# pass 1/);
        assert.equal(processOutput(after).exitCode, 0);
      },
    });

    assert.deepEqual(runResult, { state: "completed" });
    assert.deepEqual(toolTrace, [
      "filesystem.list",
      "filesystem.read",
      "filesystem.read",
      "filesystem.read",
      "terminal.execute",
      "filesystem.write",
      "terminal.execute",
    ]);
    assert.match(initialFailure, /not ok|AssertionError|ERR_ASSERTION/);
    assert.match(finalOutput, /# pass 1/);
    const snapshot = world.inspect();
    assert.equal(snapshot.tasks.find((item) => item.id === task.id)?.state, "completed");
    assert.ok(snapshot.events.filter((event) => event.toolName).every((event) =>
      event.worldId === world.id && event.workerId === worker.id && event.taskId === task.id
        && event.resourceId === workspaceResource.id));
  });

  it("propagates WorkerRuntime cancellation to only the matching terminal process", async (t) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-cancel-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const workspaceA = path.join(temporary, "a");
    const workspaceB = path.join(temporary, "b");
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);

    const world = createWorld();
    const definition = createCodyDefinition(world);
    const workerA = world.spawnWorker(definition.id);
    const workerB = world.spawnWorker(definition.id);
    const taskA = world.assignTask(world.createTask("Long command A").id, workerA.id);
    const taskB = world.assignTask(world.createTask("Short command B").id, workerB.id);
    const resourceA = world.registerResource({
      kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: workerA.id },
    });
    const resourceB = world.registerResource({
      kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: workerB.id },
    });
    const runtime = new WorkerRuntime(world);
    const tools = new ToolRuntime(world);
    await tools.bindWorkspace(resourceA.id, workspaceA);
    await tools.bindWorkspace(resourceB.id, workspaceB);
    let resultA!: Awaited<ReturnType<ToolRuntime["invoke"]>>;
    let resultB!: Awaited<ReturnType<ToolRuntime["invoke"]>>;
    const startedA = waitForFile(path.join(workspaceA, "started-a"));
    const startedB = waitForFile(path.join(workspaceB, "started-b"));
    const runA = runtime.run({
      workerId: workerA.id,
      taskId: taskA.id,
      resourceIds: [resourceA.id],
      execute: async ({ signal }) => {
        const invocation = tools.invoke({
          worldId: world.id,
          workerId: workerA.id,
          taskId: taskA.id,
          resourceId: resourceA.id,
          name: "terminal.execute",
          input: { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('started-a', 'ready'); setInterval(() => {}, 1000)"] },
          signal,
        });
        resultA = await invocation;
      },
    });
    const runB = runtime.run({
      workerId: workerB.id,
      taskId: taskB.id,
      resourceIds: [resourceB.id],
      execute: async ({ signal }) => {
        const invocation = tools.invoke({
          worldId: world.id,
          workerId: workerB.id,
          taskId: taskB.id,
          resourceId: resourceB.id,
          name: "terminal.execute",
          input: { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('started-b', 'ready'); setTimeout(() => console.log('B completed'), 180)"] },
          signal,
        });
        resultB = await invocation;
      },
    });

    await Promise.all([startedA, startedB]);
    runtime.cancel(taskA.id);
    const [lifecycleA, lifecycleB] = await Promise.all([runA, runB]);
    assert.deepEqual(lifecycleA, { state: "cancelled" });
    assert.deepEqual(lifecycleB, { state: "completed" });
    assert.equal(resultA.status, "cancelled");
    assert.equal(resultB.status, "succeeded");
    assert.equal(resultA.taskId, taskA.id);
    assert.equal(resultB.taskId, taskB.id);
    assert.ok(resultB.output && "stdout" in resultB.output);
    assert.match(resultB.output.stdout, /B completed/);
    const snapshot = world.inspect();
    assert.equal(snapshot.tasks.find((item) => item.id === taskA.id)?.state, "cancelled");
    assert.equal(snapshot.tasks.find((item) => item.id === taskB.id)?.state, "completed");
    assert.ok(snapshot.events.some((event) => event.type === "tool.cancelled" && event.taskId === taskA.id));
    assert.ok(snapshot.events.some((event) => event.type === "tool.succeeded" && event.taskId === taskB.id));
  });
});

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

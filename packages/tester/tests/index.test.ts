import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { WorkerRuntime } from "@mediobot-v2/runtime";
import { ToolRuntime } from "@mediobot-v2/tools";
import {
  computeWorkspaceRevision,
  createTesterDefinition,
  TesterDecisionProvider,
  TesterExecutionAdapter,
} from "../src/index.ts";

describe("Tester execution adapter", () => {
  it("registers Tester definition with read-only and test execution capabilities", () => {
    const world = createWorld();
    const definition = createTesterDefinition(world);
    assert.equal(definition.name, "Tester");
    assert.equal(definition.role, "tester");
    const capabilityNames = definition.declaredCapabilities.map((c) => c.name);
    assert.ok(capabilityNames.includes("terminal.execute"));
    assert.ok(capabilityNames.includes("filesystem.read"));
    assert.ok(capabilityNames.includes("filesystem.list"));
    assert.equal(capabilityNames.includes("filesystem.write"), false);
  });

  it("computes deterministic workspace revision", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-rev-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "file1.txt"), "hello");
    const rev1 = await computeWorkspaceRevision(root);
    assert.ok(rev1);
    assert.equal(rev1.length, 16);

    // Same content produces same hash
    const rev1Repeat = await computeWorkspaceRevision(root);
    assert.equal(rev1, rev1Repeat);

    // Modification changes hash
    await writeFile(path.join(root, "file1.txt"), "world");
    const rev2 = await computeWorkspaceRevision(root);
    assert.notEqual(rev1, rev2);
  });

  it("executes tests, verifies passing assertions, and records verified evidence", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-tester-run-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "test.js"), "console.log('pass'); process.exit(0);");

    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    const tools = new ToolRuntime(world);
    const definition = createTesterDefinition(world);
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Verify passing test").id, worker.id);

    const actions = [
      { type: "list", path: "." },
      { type: "read", path: "test.js" },
      { type: "run", command: process.execPath, args: ["test.js"], check: "Test script exits 0" },
      {
        type: "finish",
        report: {
          status: "verified",
          summary: "All tests pass successfully.",
          assertions: [{ name: "test-script-pass", passed: true }],
          supportedCriteria: ["criterion-test-pass"],
        },
      },
    ];
    let actionIndex = 0;
    const decisions = new TesterDecisionProvider({
      complete: async () => JSON.stringify(actions[actionIndex++]),
    });

    const adapter = new TesterExecutionAdapter({ tools, decisions });
    const plan = adapter.prepare({
      world,
      definitionId: definition.id,
      workerId: worker.id,
      taskId: task.id,
      goal: task.goal,
      options: { workspaceRoot: root },
    });

    const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
    assert.deepEqual(result, { state: "completed" });

    const snapshot = world.inspect();
    const verification = snapshot.evidence.find(
      (e) => e.taskId === task.id && e.source.type === "tester-verification"
    );
    assert.ok(verification);
    assert.equal(verification.kind, "test-execution");
    assert.equal(verification.validity, "verified");
    assert.equal(verification.subject, "workspace");
    assert.ok(verification.revision);

    const report = snapshot.evidence.find((e) => e.taskId === task.id && e.source.type === "tester-report");
    assert.ok(report);
    assert.match(report.content, /test-script-pass/);
  });

  it("downgrades fabricated verified claim if no test command was executed", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-tester-fabricate-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    const tools = new ToolRuntime(world);
    const definition = createTesterDefinition(world);
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Verify without running").id, worker.id);

    const actions = [
      {
        type: "finish",
        report: {
          status: "verified",
          summary: "I claim this is verified without running anything.",
        },
      },
    ];
    let actionIndex = 0;
    const decisions = new TesterDecisionProvider({
      complete: async () => JSON.stringify(actions[actionIndex++]),
    });

    const adapter = new TesterExecutionAdapter({ tools, decisions });
    const plan = adapter.prepare({
      world,
      definitionId: definition.id,
      workerId: worker.id,
      taskId: task.id,
      goal: task.goal,
      options: { workspaceRoot: root },
    });

    const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
    assert.deepEqual(result, { state: "completed" });

    const snapshot = world.inspect();
    const verification = snapshot.evidence.find(
      (e) => e.taskId === task.id && e.source.type === "tester-verification"
    );
    assert.ok(verification);
    // Fabricated verification without running checks must be downgraded to observed/unverified
    assert.equal(verification.validity, "observed");
    const parsedReport = JSON.parse(verification.content);
    assert.equal(parsedReport.status, "unverified");
  });

  it("marks status as failed when a verification command exits non-zero", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-tester-fail-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "fail.js"), "process.exit(1);");

    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    const tools = new ToolRuntime(world);
    const definition = createTesterDefinition(world);
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Failing test check").id, worker.id);

    const actions = [
      { type: "run", command: process.execPath, args: ["fail.js"], check: "Failing check" },
      {
        type: "finish",
        report: {
          status: "verified", // Model tries to claim verified despite failure
          summary: "Attempted verification",
        },
      },
    ];
    let actionIndex = 0;
    const decisions = new TesterDecisionProvider({
      complete: async () => JSON.stringify(actions[actionIndex++]),
    });

    const adapter = new TesterExecutionAdapter({ tools, decisions });
    const plan = adapter.prepare({
      world,
      definitionId: definition.id,
      workerId: worker.id,
      taskId: task.id,
      goal: task.goal,
      options: { workspaceRoot: root },
    });

    const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
    assert.deepEqual(result, { state: "completed" });

    const snapshot = world.inspect();
    const verification = snapshot.evidence.find(
      (e) => e.taskId === task.id && e.source.type === "tester-verification"
    );
    assert.ok(verification);
    assert.equal(verification.validity, "observed");
    const parsed = JSON.parse(verification.content);
    assert.equal(parsed.status, "failed");
  });

  it("isolates test execution so indirect terminal writes do not mutate the project workspace", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-tester-isolate-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const pristineContent = "export const secret = 'original';";
    await writeFile(path.join(root, "app.js"), pristineContent);
    // Test script attempts to mutate app.js and create dirty.txt
    await writeFile(
      path.join(root, "mutate-test.js"),
      "const fs = require('fs'); fs.writeFileSync('app.js', 'corrupted'); fs.writeFileSync('dirty.txt', 'spill'); console.log('mutated');",
    );

    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    const tools = new ToolRuntime(world);
    const definition = createTesterDefinition(world);
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Run mutating test").id, worker.id);

    const actions = [
      { type: "run", command: process.execPath, args: ["mutate-test.js"], check: "Run test" },
      {
        type: "finish",
        report: {
          status: "verified",
          summary: "Ran mutating test",
          assertions: [{ name: "check", passed: true }],
        },
      },
    ];
    let actionIndex = 0;
    const decisions = new TesterDecisionProvider({
      complete: async () => JSON.stringify(actions[actionIndex++]),
    });

    const adapter = new TesterExecutionAdapter({ tools, decisions });
    const plan = adapter.prepare({
      world,
      definitionId: definition.id,
      workerId: worker.id,
      taskId: task.id,
      goal: task.goal,
      options: { workspaceRoot: root },
    });

    const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
    assert.deepEqual(result, { state: "completed" });

    // Verify host workspaceRoot was NEVER corrupted!
    const { readFile: readHostFile, stat: statHostFile } = await import("node:fs/promises");
    const appContent = await readHostFile(path.join(root, "app.js"), "utf8");
    assert.equal(appContent, pristineContent, "Host app.js must remain completely uncorrupted");

    let dirtyExists = false;
    try {
      await statHostFile(path.join(root, "dirty.txt"));
      dirtyExists = true;
    } catch {
      dirtyExists = false;
    }
    assert.equal(dirtyExists, false, "dirty.txt must not exist in host workspace");
  });
});

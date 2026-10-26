import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorld,
  type EvidenceRequirement,
  type Goal,
  type TaskId,
} from "@mediobot-v2/domain";
import {
  RuntimeTaskSubmission,
  WorkerRuntime,
} from "@mediobot-v2/runtime";
import { ToolRuntime } from "@mediobot-v2/tools";
import {
  CodyDecisionProvider,
  CodyExecutionAdapter,
  createCodyDefinition,
} from "@mediobot-v2/cody";
import {
  mergeMonotonicToolData,
} from "@mediobot-v2/models";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ChatRepository } from "../../src/storage/chatRepository.ts";
import { LocalHistoryStore } from "../../src/history.ts";
import type { ToolExecutionData, Thread } from "../../src/types/index.ts";

function createDisposableWorkspace(prefix: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `mediobot-baseline-${prefix}-`));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("Baseline Execution Acceptance Suite (10 Deterministic Scenarios)", () => {

  // Scenario 1: Successful file modification and relevant verification
  it("Scenario 1: Successful file modification and relevant verification", async () => {
    const ws = createDisposableWorkspace("s1");
    try {
      const srcDir = path.join(ws.dir, "src");
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(path.join(srcDir, "calc.js"), "export function add(a, b) { return a - b; }\n");
      writeFileSync(path.join(ws.dir, "verify.cjs"), `
        const { readFileSync } = require("node:fs");
        const content = readFileSync("src/calc.js", "utf8");
        if (!content.includes("a + b")) {
          process.exit(1);
        }
        process.exit(0);
      `);

      const actions = [
        { type: "list", path: "." },
        { type: "read", path: "src/calc.js" },
        { type: "write", path: "src/calc.js", content: "export function add(a, b) { return a + b; }\n" },
        { type: "run", command: process.execPath, args: ["verify.cjs"], verification: "Validate addition formula" },
        { type: "finish", summary: "Fixed calculation formula and verified with check script" },
      ];
      let step = 0;
      const modelClient = { complete: async () => JSON.stringify(actions[step++]) };

      const world = createWorld();
      const def = createCodyDefinition(world);
      const tools = new ToolRuntime(world);
      const runtime = new WorkerRuntime(world);
      const submission = new RuntimeTaskSubmission(world, runtime);
      const adapter = new CodyExecutionAdapter({ tools, decisions: new CodyDecisionProvider(modelClient) });
      submission.registerAdapter(def.id, adapter);

      const events: string[] = [];
      const submitted = submission.submit({
        definitionId: def.id,
        goal: "Fix calc.js addition formula",
        options: { workspaceRoot: ws.dir },
        onEvent: (e) => events.push(e.type),
      });

      const res = await submitted.result;
      assert.equal(res.state, "completed");

      // Verify real file changed
      const onDisk = readFileSync(path.join(srcDir, "calc.js"), "utf8");
      assert.ok(onDisk.includes("a + b"), "Real disk file must be modified");

      // Verify diff evidence
      const snapshot = world.inspect();
      const diffEvidence = snapshot.evidence.find(
        (e) => e.taskId === submitted.task.id && e.source.type === "workspace-diff"
      );
      assert.ok(diffEvidence, "Workspace diff evidence must exist");
      const diffData = JSON.parse(diffEvidence.content);
      assert.equal(diffData.filePath, "src/calc.js");
      assert.equal(diffData.additions, 1);
      assert.equal(diffData.deletions, 1);

      // Verify verification evidence
      const verEvidence = snapshot.evidence.find(
        (e) => e.taskId === submitted.task.id && e.source.type === "coding-verification"
      );
      assert.ok(verEvidence, "Verification command evidence must exist");
      assert.equal(verEvidence.kind, "command-execution");
      assert.equal(verEvidence.validity, "observed");
      assert.match(verEvidence.content, /exited with code 0/);
    } finally {
      ws.cleanup();
    }
  });

  // Scenario 2: Correct code requiring no changes
  it("Scenario 2: Correct code requiring no changes", async () => {
    const ws = createDisposableWorkspace("s2");
    try {
      writeFileSync(path.join(ws.dir, "valid.js"), "export const status = 'ready';\n");

      const actions = [
        { type: "read", path: "valid.js" },
        { type: "finish", summary: "Code in valid.js inspected and confirmed correct; no changes needed" },
      ];
      let step = 0;
      const modelClient = { complete: async () => JSON.stringify(actions[step++]) };

      const world = createWorld();
      const def = createCodyDefinition(world);
      const tools = new ToolRuntime(world);
      const runtime = new WorkerRuntime(world);
      const submission = new RuntimeTaskSubmission(world, runtime);
      submission.registerAdapter(def.id, new CodyExecutionAdapter({ tools, decisions: new CodyDecisionProvider(modelClient) }));

      const submitted = submission.submit({
        definitionId: def.id,
        goal: "Verify valid.js is correct",
        options: { workspaceRoot: ws.dir },
      });

      const res = await submitted.result;
      assert.equal(res.state, "completed");

      const snapshot = world.inspect();
      const diffs = snapshot.evidence.filter(
        (e) => e.taskId === submitted.task.id && e.source.type === "workspace-diff"
      );
      assert.equal(diffs.length, 0, "No diffs should be produced when no changes are made");

      const summaryEvidence = snapshot.evidence.find(
        (e) => e.taskId === submitted.task.id && e.source.type === "cody-summary"
      );
      assert.ok(summaryEvidence, "Cody finish summary must be recorded");
      assert.match(summaryEvidence.content, /confirmed correct; no changes needed/);
    } finally {
      ws.cleanup();
    }
  });

  // Scenario 3: Failing verification after a successful edit
  it("Scenario 3: Failing verification after a successful edit blocks completion", async () => {
    const ws = createDisposableWorkspace("s3");
    try {
      writeFileSync(path.join(ws.dir, "code.js"), "let x = 1;\n");
      writeFileSync(path.join(ws.dir, "fail-check.cjs"), "process.exit(1);\n");

      let finishAttempted = false;
      const actions = [
        { type: "read", path: "code.js" },
        { type: "write", path: "code.js", content: "let x = 2;\n" },
        { type: "run", command: process.execPath, args: ["fail-check.cjs"], verification: "Check fails" },
        { type: "finish", summary: "I am finishing anyway" },
      ];
      let step = 0;
      const modelClient = {
        complete: async () => {
          if (step >= actions.length) {
            throw new Error("Bounded step limit reached");
          }
          const act = actions[step++];
          if (act.type === "finish") finishAttempted = true;
          return JSON.stringify(act);
        },
      };

      const world = createWorld();
      const def = createCodyDefinition(world);
      const tools = new ToolRuntime(world);
      const runtime = new WorkerRuntime(world);
      const submission = new RuntimeTaskSubmission(world, runtime);
      submission.registerAdapter(def.id, new CodyExecutionAdapter({ tools, decisions: new CodyDecisionProvider(modelClient) }));

      const submitted = submission.submit({
        definitionId: def.id,
        goal: "Change code.js and pass check",
        options: { workspaceRoot: ws.dir },
      });

      const res = await submitted.result;
      assert.equal(res.state, "failed", "Task must fail because finish was blocked by failed verification");
      assert.ok(finishAttempted, "Finish must have been attempted and rejected");

      const snapshot = world.inspect();
      const verEvidence = snapshot.evidence.find(
        (e) => e.taskId === submitted.task.id && e.source.type === "coding-verification"
      );
      assert.equal(verEvidence, undefined, "No successful verification evidence should be recorded when command fails");
    } finally {
      ws.cleanup();
    }
  });

  // Scenario 4: Tool failure with safe diagnostic reporting
  it("Scenario 4: Tool failure with safe diagnostic reporting", async () => {
    const ws = createDisposableWorkspace("s4");
    try {
      const world = createWorld();
      const tools = new ToolRuntime(world);
      const def = world.registerMediobotDefinition({
        name: "Worker",
        role: "worker",
        version: "1.0.0",
        instructions: "",
        declaredCapabilities: [],
      });
      const worker = world.spawnWorker(def.id);
      const task = world.createTask("Test task", undefined);
      world.assignTask(task.id, worker.id);
      world.setWorkerState(worker.id, "busy");
      world.setTaskState(task.id, "running");

      const res = world.registerResource({
        kind: "workspace",
        owner: { type: "task", worldId: world.id, taskId: task.id },
      });
      world.setResourceState(res.id, "in-use");
      await tools.bindWorkspace(res.id, ws.dir);

      // Attempt reading outside workspace
      const result = await tools.invoke({
        worldId: world.id,
        workerId: worker.id,
        taskId: task.id,
        resourceId: res.id,
        name: "filesystem.read",
        input: { path: "../outside.txt" },
      });

      assert.equal(result.status, "failed");
      assert.equal(result.failureStage, "filesystem");
      assert.match(result.error ?? "", /escapes the owned workspace|traversal/i);

      // Attempt reading sensitive credential file
      const resultSecret = await tools.invoke({
        worldId: world.id,
        workerId: worker.id,
        taskId: task.id,
        resourceId: res.id,
        name: "filesystem.read",
        input: { path: ".env" },
      });
      assert.equal(resultSecret.status, "failed");
      assert.equal(resultSecret.failureStage, "filesystem");
      assert.match(resultSecret.error ?? "", /Credential and secret files/i);

      tools.releaseWorkspace(res.id);
    } finally {
      ws.cleanup();
    }
  });

  // Scenario 5: Interrupted execution and cancellation
  it("Scenario 5: Interrupted execution and cancellation", async () => {
    const ws = createDisposableWorkspace("s5");
    try {
      const world = createWorld();
      const def = createCodyDefinition(world);
      const tools = new ToolRuntime(world);
      const runtime = new WorkerRuntime(world);
      const submission = new RuntimeTaskSubmission(world, runtime);

      let submittedTask: ReturnType<RuntimeTaskSubmission["submit"]> | undefined;
      const modelClient = {
        complete: async () => {
          if (submittedTask) {
            submission.cancel(submittedTask.task.id);
          }
          await new Promise((r) => setTimeout(r, 50));
          return JSON.stringify({ type: "list", path: "." });
        },
      };

      submission.registerAdapter(def.id, new CodyExecutionAdapter({ tools, decisions: new CodyDecisionProvider(modelClient) }));

      submittedTask = submission.submit({
        definitionId: def.id,
        goal: "Task to cancel",
        options: { workspaceRoot: ws.dir },
      });

      const res = await submittedTask.result;
      assert.equal(res.state, "cancelled", "Cancelled task must resolve with state 'cancelled'");
    } finally {
      ws.cleanup();
    }
  });

  // Scenario 6: Browser/SSE disconnection and restoration
  it("Scenario 6: Browser/SSE disconnection and restoration", async () => {
    const ws = createDisposableWorkspace("s6");
    try {
      const db = new LocalDatabase(":memory:");
      const chatRepo = new ChatRepository(db.raw);
      const history = new LocalHistoryStore(undefined, chatRepo);

      const thread: Thread = {
        id: "th-s6",
        title: "SSE thread",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turns: [
          {
            id: "turn-s6",
            threadId: "th-s6",
            prompt: "Hello",
            status: "completed",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            items: [
              {
                id: "item-1",
                turnId: "turn-s6",
                timestamp: 1000,
                type: "tool_execution",
                tool: {
                  toolInvocationId: "tool-s6-1",
                  toolName: "filesystem.read",
                  command: "filesystem.read config.json",
                  status: "success",
                  output: "config data",
                  startedAt: 1000,
                  durationMs: 50,
                },
              },
            ],
          },
        ],
      };

      await history.save(thread);

      // Simulate client connection: retrieve turn after disconnection
      const restoredThread = await history.get("th-s6");
      assert.ok(restoredThread);
      const restoredTurn = restoredThread.turns.find((t) => t.id === "turn-s6");
      assert.ok(restoredTurn);
      assert.equal(restoredTurn.status, "completed");
      assert.equal(restoredTurn.items.length, 1);
      assert.equal(restoredTurn.items[0]?.tool?.toolInvocationId, "tool-s6-1");
      assert.equal(restoredTurn.items[0]?.tool?.status, "success");

      db.close();
    } finally {
      ws.cleanup();
    }
  });

  // Scenario 7: Conflicting or reordered events
  it("Scenario 7: Conflicting or reordered events resolve monotonically", () => {
    const completedState: ToolExecutionData = {
      toolInvocationId: "tool-s7",
      toolName: "terminal.execute",
      command: "npm test",
      status: "success",
      startedAt: 2000,
      durationMs: 150,
      exitCode: 0,
    };

    // Late arriving "running" event must NOT overwrite terminal "success"
    const lateRunningEvent: ToolExecutionData = {
      toolInvocationId: "tool-s7",
      toolName: "terminal.execute",
      status: "running",
      startedAt: 2000,
    };

    const merged = mergeMonotonicToolData(completedState, lateRunningEvent);
    assert.equal(merged.status, "success", "Terminal state 'success' must not regress to 'running'");
    assert.equal(merged.exitCode, 0);
    assert.equal(merged.durationMs, 150);

    // Idempotent duplicate terminal event preserves fields
    const duplicateCompleted: ToolExecutionData = {
      toolInvocationId: "tool-s7",
      toolName: "terminal.execute",
      status: "success",
      durationMs: 150,
      exitCode: 0,
    };
    const mergedDupe = mergeMonotonicToolData(merged, duplicateCompleted);
    assert.equal(mergedDupe.status, "success");
    assert.equal(mergedDupe.exitCode, 0);
  });

  // Scenario 8: Persistence after reload
  it("Scenario 8: Persistence after reload", async () => {
    const ws = createDisposableWorkspace("s8");
    const dbPath = path.join(ws.dir, "persistence.db");
    try {
      // Phase A: write to DB
      {
        const dbA = new LocalDatabase(dbPath);
        const chatRepoA = new ChatRepository(dbA.raw);
        const historyA = new LocalHistoryStore(undefined, chatRepoA);
        const thread: Thread = {
          id: "th-persist",
          title: "Persistence Test",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          turns: [
            {
              id: "turn-p1",
              threadId: "th-persist",
              prompt: "Test prompt",
              status: "completed",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              items: [
                {
                  id: "item-tool-1",
                  turnId: "turn-p1",
                  timestamp: Date.now(),
                  type: "tool_execution",
                  tool: {
                    toolInvocationId: "tool-persisted",
                    toolName: "filesystem.write",
                    command: "filesystem.write main.rs",
                    status: "success",
                    startedAt: 5000,
                    durationMs: 20,
                  },
                },
              ],
            },
          ],
        };
        await historyA.save(thread);
        dbA.close();
      }

      // Phase B: reopen DB in a fresh instance
      {
        const dbB = new LocalDatabase(dbPath);
        const chatRepoB = new ChatRepository(dbB.raw);
        const historyB = new LocalHistoryStore(undefined, chatRepoB);

        const thread = await historyB.get("th-persist");
        assert.ok(thread, "Thread must be restored from SQLite");
        assert.equal(thread.title, "Persistence Test");

        const turn = thread.turns.find((t) => t.id === "turn-p1");
        assert.ok(turn, "Turn must be restored from SQLite");
        assert.equal(turn.status, "completed");
        assert.equal(turn.items.length, 1);
        assert.equal(turn.items[0]?.tool?.toolInvocationId, "tool-persisted");
        assert.equal(turn.items[0]?.tool?.toolName, "filesystem.write");
        assert.equal(turn.items[0]?.tool?.durationMs, 20);

        dbB.close();
      }
    } finally {
      ws.cleanup();
    }
  });

  // Scenario 9: Incorrect model claims that must not satisfy the goal
  it("Scenario 9: Incorrect model claims must not satisfy the goal", () => {
    const world = createWorld();
    const req: EvidenceRequirement = {
      kind: "command-execution",
      source: { type: "coding-verification", reference: "verifier-1" },
      validity: "verified",
    };

    const goal = world.createGoal({
      threadId: "th-claim",
      objective: "Pass all unit tests",
      constraints: [],
      successCriteria: [
        {
          id: "crit-1",
          statement: "Unit tests must pass with exit code 0",
          evidenceRequirement: req,
        },
      ],
      evidenceRequirements: [],
    });

    // Model emits a summary claiming success
    const modelClaimEvidence = world.recordEvidence({
      goalId: goal.id,
      source: { type: "cody-summary", reference: "model-claim" },
      kind: "model-summary",
      validity: "observed",
      content: "All unit tests pass 100%! Trust me!",
    });

    // Attempting to support criterion with model claim MUST fail closed
    assert.throws(() => {
      world.supportGoalCriterion(goal.id, "crit-1", "satisfied", [modelClaimEvidence.id]);
    }, /match/i);

    const snapshot = world.inspect();
    const currentGoal = snapshot.goals.find((g) => g.id === goal.id)!;
    assert.notEqual(currentGoal.status, "satisfied", "Goal must NOT be satisfied by model claims");
    assert.equal(currentGoal.successCriteria[0]?.state, "unknown");
  });

  // Scenario 10: A Tester report containing no executable evidence
  it("Scenario 10: A Tester report containing no executable evidence does not satisfy goal", () => {
    const world = createWorld();
    const verifierReq: EvidenceRequirement = {
      kind: "command-execution",
      source: { type: "test-runner", reference: "integration-suite" },
      validity: "verified",
    };

    const goal = world.createGoal({
      threadId: "th-tester",
      objective: "End-to-end integration verified",
      constraints: [],
      successCriteria: [
        {
          id: "crit-test",
          statement: "Integration test suite must pass with verifier evidence",
          evidenceRequirement: verifierReq,
        },
      ],
      evidenceRequirements: [],
    });

    // Tester submits a text-only report with observed validity and no executable evidence
    const textReportEvidence = world.recordEvidence({
      goalId: goal.id,
      source: { type: "tester-report", reference: "manual-review" },
      kind: "text-summary",
      validity: "observed",
      content: "I reviewed the code manually and found no issues.",
    });

    // Support criterion with non-executable report MUST throw and fail closed
    assert.throws(() => {
      world.supportGoalCriterion(goal.id, "crit-test", "satisfied", [textReportEvidence.id]);
    }, /match/i);

    const snapshot = world.inspect();
    const currentGoal = snapshot.goals.find((g) => g.id === goal.id)!;
    assert.notEqual(currentGoal.status, "satisfied", "Goal must remain unsatisfied without executable verification");
    assert.equal(currentGoal.successCriteria[0]?.state, "unknown");
  });

});

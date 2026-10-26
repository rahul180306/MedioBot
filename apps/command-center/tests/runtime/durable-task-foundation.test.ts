import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { LocalDatabase } from "../../src/storage/db.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";
import {
  DurableTaskEngine,
  InvalidStateTransitionError,
  TaskEvidenceRequiredError,
  type DurableTaskStatus,
} from "@mediobot-v2/runtime";
import { startCommandCenter } from "../../src/server.ts";
import { createFakeComposition } from "../helpers/fakeComposition.ts";

function createTempDb(): { dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "mediobot-test-durable-"));
  const dbPath = path.join(tempDir, "mediobot.db");
  return {
    dbPath,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

test("durable task retains its exact non-secret provider/model selection across SQLite restart", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const firstDb = new LocalDatabase(dbPath);
    const firstEngine = new DurableTaskEngine(new SqliteDurableTaskStore(firstDb.rawDb));
    const selection = { providerConnectionId: "provider-selected", modelId: "model-selected" };
    const { task } = await firstEngine.submitTask({ goal: "Resume with the original model", definitionId: "maestro",
      workspaceId: "workspace-model", modelSelection: selection });
    assert.deepEqual(await firstEngine.getTaskModelSelection(task.id), selection);
    firstDb.close();

    const restartedDb = new LocalDatabase(dbPath);
    try {
      const restartedEngine = new DurableTaskEngine(new SqliteDurableTaskStore(restartedDb.rawDb));
      assert.deepEqual(await restartedEngine.getTaskModelSelection(task.id), selection);
      await assert.rejects(restartedEngine.submitTask({ goal: "invalid", definitionId: "maestro", workspaceId: "workspace-model",
        modelSelection: { providerConnectionId: " ", modelId: "model" } }), /Invalid durable task model selection/);
    } finally { restartedDb.close(); }
  } finally { cleanup(); }
});

test("durable task retains its inferenceSnapshot and extracts reasoningEffort across SQLite restart", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const firstDb = new LocalDatabase(dbPath);
    const firstEngine = new DurableTaskEngine(new SqliteDurableTaskStore(firstDb.rawDb));
    const inferenceSnapshot = {
      connectionId: "provider-snapshot",
      providerKey: "nvidia",
      modelId: "model-snapshot",
      requestedEffort: "high",
      effectiveEffort: "high",
      protocolCapabilities: ["prompt-json"],
      resolvedAt: Date.now(),
    };
    const { task } = await firstEngine.submitTask({
      goal: "Resume with the snapshot",
      definitionId: "maestro",
      workspaceId: "workspace-snapshot",
      inferenceSnapshot,
    });
    const loadedTask = await firstEngine.getTask(task.id);
    assert.deepEqual(loadedTask?.inferenceSnapshot, inferenceSnapshot);
    assert.deepEqual(await firstEngine.getTaskModelSelection(task.id), {
      providerConnectionId: "provider-snapshot",
      modelId: "model-snapshot",
      reasoningEffort: "high",
    });
    firstDb.close();

    const restartedDb = new LocalDatabase(dbPath);
    try {
      const restartedEngine = new DurableTaskEngine(new SqliteDurableTaskStore(restartedDb.rawDb));
      const recoveredTask = await restartedEngine.getTask(task.id);
      assert.deepEqual(recoveredTask?.inferenceSnapshot, inferenceSnapshot);
      assert.deepEqual(await restartedEngine.getTaskModelSelection(task.id), {
        providerConnectionId: "provider-snapshot",
        modelId: "model-snapshot",
        reasoningEffort: "high",
      });
    } finally { restartedDb.close(); }
  } finally { cleanup(); }
});

test("user pause is distinct from approval and resumes the durable task", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    try {
      const engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
      const { task } = await engine.submitTask({ goal: "Pause at a safe boundary", definitionId: "maestro", workspaceId: "ws-pause" });
      await engine.startTask(task.id);

      const paused = await engine.pauseForUser(task.id, { interruptIds: ["pause-interrupt"] });
      assert.equal(paused.status, "paused");
      assert.deepEqual((await engine.getEvents(task.id)).at(-1)?.payload, {
        fromState: "running", toState: "paused", details: { reason: "user_pause", interruptIds: ["pause-interrupt"] },
      });
      const resumed = await engine.resumeFromUserPause(task.id);
      assert.equal(resumed.status, "running");
      assert.equal((await engine.getEvents(task.id)).at(-1)?.eventType, "task.state_changed");
    } finally { db.close(); }
  } finally { cleanup(); }
});

test("PHASE 3: State Machine Transitions & Strict Guard Enforcements", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const localDb = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(localDb.rawDb);
    const engine = new DurableTaskEngine(store);

    // 1. Submit task -> starts at created, automatically moves to queued
    const { task: submitted } = await engine.submitTask({
      goal: "Implement state machine test",
      definitionId: "mediobot-test",
      workspaceId: "ws-1",
    });
    assert.equal(submitted.status, "queued");

    // 2. queued -> running
    const running = await engine.startTask(submitted.id);
    assert.equal(running.status, "running");

    // 3. running -> waiting_approval
    const paused = await engine.pauseForApproval(running.id, { tool: "bash_exec", command: "rm -rf /" });
    assert.equal(paused.status, "waiting_approval");

    // 4. waiting_approval -> running (resume)
    const resumed = await engine.resumeFromApproval(paused.id);
    assert.equal(resumed.status, "running");

    // 5. running -> waiting_input
    const inputPaused = await engine.pauseForInput(resumed.id, { prompt: "Confirm API key" });
    assert.equal(inputPaused.status, "waiting_input");

    // 6. waiting_input -> running
    const inputResumed = await engine.resumeFromInput(inputPaused.id);
    assert.equal(inputResumed.status, "running");

    // 7. running -> completed
    const completed = await engine.completeTask(inputResumed.id);
    assert.equal(completed.status, "completed");
    assert.ok(completed.completedAt, "completedAt must be set");

    // 8. Terminal transition attempts must throw InvalidStateTransitionError
    await assert.rejects(
      async () => {
        await engine.startTask(completed.id);
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidStateTransitionError);
        assert.equal((err as InvalidStateTransitionError).fromState, "completed");
        assert.equal((err as InvalidStateTransitionError).toState, "running");
        return true;
      }
    );

    // 9. Cancellation transitions from various active states
    const { task: tCancel1 } = await engine.submitTask({ goal: "Cancel test 1", definitionId: "test", workspaceId: "ws-1" });
    const c1 = await engine.cancelTask(tCancel1.id, "user request");
    assert.equal(c1.status, "cancelled");

    const { task: tCancel2 } = await engine.submitTask({ goal: "Cancel test 2", definitionId: "test", workspaceId: "ws-1" });
    await engine.startTask(tCancel2.id);
    const c2 = await engine.cancelTask(tCancel2.id, "user request");
    assert.equal(c2.status, "cancelled");

    localDb.close();
  } finally {
    cleanup();
  }
});

test("PHASE 3: Idempotent Submission & Workspace-scoped Deduplication", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const localDb = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(localDb.rawDb);
    const engine = new DurableTaskEngine(store);

    const idempotencyKey = "unique-op-key-12345";

    // First submission
    const res1 = await engine.submitTask({
      goal: "Idempotent goal",
      definitionId: "agent-1",
      workspaceId: "ws-main",
      idempotencyKey,
    });
    assert.equal(res1.isDuplicate, false);
    assert.equal(res1.task.idempotencyKey, idempotencyKey);

    // Duplicate submission in the SAME workspace
    const res2 = await engine.submitTask({
      goal: "Duplicate submission attempt",
      definitionId: "agent-1",
      workspaceId: "ws-main",
      idempotencyKey,
    });
    assert.equal(res2.isDuplicate, true);
    assert.equal(res2.task.id, res1.task.id);
    assert.equal(res2.task.goal, "Idempotent goal");

    // Submission with SAME idempotencyKey in DIFFERENT workspace must NOT collide
    const res3 = await engine.submitTask({
      goal: "Different workspace submission",
      definitionId: "agent-1",
      workspaceId: "ws-other",
      idempotencyKey,
    });
    assert.equal(res3.isDuplicate, false);
    assert.notEqual(res3.task.id, res1.task.id);

    localDb.close();
  } finally {
    cleanup();
  }
});

test("PHASE 3: Monotonic Event Audit Trail", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const localDb = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(localDb.rawDb);
    const engine = new DurableTaskEngine(store);

    const { task } = await engine.submitTask({
      goal: "Event tracking test",
      definitionId: "agent-events",
      workspaceId: "ws-1",
    });

    await engine.startTask(task.id);
    await engine.recordCheckpoint(task.id, 1, { step: "init" });
    await engine.pauseForApproval(task.id, { tool: "cmd" });
    await engine.resumeFromApproval(task.id);
    await engine.completeTask(task.id);

    const events = await engine.getEvents(task.id);
    assert.ok(events.length >= 6, `Expected at least 6 events, got ${events.length}`);

    // Verify sequence numbers are strictly 1, 2, 3, 4, ...
    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i].sequenceNumber, i + 1, `Event at index ${i} must have sequenceNumber ${i + 1}`);
      assert.equal(events[i].taskId, task.id);
      assert.ok(events[i].occurredAt > 0);
      assert.ok(typeof events[i].eventType === "string");
    }

    localDb.close();
  } finally {
    cleanup();
  }
});

test("PHASE 3: Recoverable Checkpoints", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const localDb = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(localDb.rawDb);
    const engine = new DurableTaskEngine(store);

    const { task } = await engine.submitTask({
      goal: "Checkpoint test",
      definitionId: "agent-chk",
      workspaceId: "ws-1",
    });
    await engine.startTask(task.id);

    const chk1 = await engine.recordCheckpoint(task.id, 1, {
      discoveredFiles: ["src/index.ts", "package.json"],
      strategy: "ast_parse",
    });
    assert.equal(chk1.stepIndex, 1);

    const chk2 = await engine.recordCheckpoint(task.id, 2, {
      discoveredFiles: ["src/index.ts", "package.json", "src/utils.ts"],
      transformedFiles: ["src/utils.ts"],
    });
    assert.equal(chk2.stepIndex, 2);

    const checkpoints = await engine.getCheckpoints(task.id);
    assert.equal(checkpoints.length, 2);
    assert.equal(checkpoints[0].stepIndex, 1);
    assert.deepEqual(checkpoints[0].snapshot, {
      discoveredFiles: ["src/index.ts", "package.json"],
      strategy: "ast_parse",
    });
    assert.equal(checkpoints[1].stepIndex, 2);
    assert.deepEqual(checkpoints[1].snapshot, {
      discoveredFiles: ["src/index.ts", "package.json", "src/utils.ts"],
      transformedFiles: ["src/utils.ts"],
    });

    localDb.close();
  } finally {
    cleanup();
  }
});

test("PHASE 3: Persistent Delegation Hierarchy Records", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const localDb = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(localDb.rawDb);
    const engine = new DurableTaskEngine(store);

    const { task: parentTask } = await engine.submitTask({
      goal: "Orchestrate feature implementation",
      definitionId: "maestro",
      workspaceId: "ws-1",
    });
    await engine.startTask(parentTask.id);

    // Record delegation
    const delegation = await engine.recordDelegation(parentTask.id, {
      parentTaskId: parentTask.id,
      childTaskId: null,
      assignedMediobotId: "cody-id",
      assignedMediobotName: "Cody",
      objective: "Refactor database migrations",
      status: "pending",
    });
    assert.equal(delegation.status, "pending");
    assert.equal(delegation.parentTaskId, parentTask.id);

    // Create child task and link
    const { task: childTask } = await engine.submitTask({
      goal: "Refactor database migrations",
      definitionId: "cody",
      workspaceId: "ws-1",
    });

    const updated = await store.updateDelegation(delegation.id, {
      childTaskId: childTask.id,
      status: "active",
    });
    assert.equal(updated.childTaskId, childTask.id);
    assert.equal(updated.status, "active");

    const delegations = await engine.getDelegations(parentTask.id);
    assert.equal(delegations.length, 1);
    assert.equal(delegations[0].childTaskId, childTask.id);
    assert.equal(delegations[0].assignedMediobotName, "Cody");

    localDb.close();
  } finally {
    cleanup();
  }
});

test("PHASE 3: Evidence-Linked Completion Invariant", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const localDb = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(localDb.rawDb);
    const engine = new DurableTaskEngine(store);

    const { task } = await engine.submitTask({
      goal: "Critical task requiring proof",
      definitionId: "evidence-worker",
      workspaceId: "ws-evidence",
    });
    await engine.startTask(task.id);

    // Attempting to complete with requireEvidence: true without any evidence must fail
    await assert.rejects(
      async () => {
        await engine.completeTask(task.id, { requireEvidence: true });
      },
      (err: unknown) => {
        assert.ok(err instanceof TaskEvidenceRequiredError);
        assert.equal((err as TaskEvidenceRequiredError).taskId, task.id);
        return true;
      }
    );

    // Task must remain in running status
    const current1 = await engine.getTask(task.id);
    assert.equal(current1?.status, "running");

    // Add unverified (observed) evidence only
    await engine.recordEvidence(task.id, {
      taskId: task.id,
      kind: "test_output",
      source: { file: "tests/out.log" },
      claim: "Tests passed",
      content: "PASS: 5/5",
      validity: "observed",
    });

    // Still should fail because validity is 'observed', not 'verified'
    await assert.rejects(
      async () => {
        await engine.completeTask(task.id, { requireEvidence: true });
      },
      (err: unknown) => {
        assert.ok(err instanceof TaskEvidenceRequiredError);
        return true;
      }
    );

    // Now record VERIFIED evidence
    await engine.recordEvidence(task.id, {
      taskId: task.id,
      kind: "reproduced_command_exit_code",
      source: { exitCode: 0, command: "npm test" },
      claim: "Deterministic test run exited 0",
      content: "Process exited with 0",
      validity: "verified",
    });

    // Now completion MUST succeed
    const completed = await engine.completeTask(task.id, { requireEvidence: true });
    assert.equal(completed.status, "completed");
    assert.ok(completed.completedAt);

    localDb.close();
  } finally {
    cleanup();
  }
});

test("PHASE 3: Startup Crash / Restart Reconciliation Guarantees", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const localDb = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(localDb.rawDb);
    const engine = new DurableTaskEngine(store);

    // Setup tasks in various states:
    // 1. Task left in running
    const { task: tRunning } = await engine.submitTask({ goal: "Task running before crash", definitionId: "test", workspaceId: "ws-crash" });
    await engine.startTask(tRunning.id);

    // 2. Task left in queued
    const { task: tQueued } = await engine.submitTask({ goal: "Task queued before crash", definitionId: "test", workspaceId: "ws-crash" });

    // 3. Task in waiting_approval
    const { task: tApproval } = await engine.submitTask({ goal: "Task waiting approval before crash", definitionId: "test", workspaceId: "ws-crash" });
    await engine.startTask(tApproval.id);
    await engine.pauseForApproval(tApproval.id, { action: "drop_db" });

    // 4. Task in waiting_input
    const { task: tInput } = await engine.submitTask({ goal: "Task waiting input before crash", definitionId: "test", workspaceId: "ws-crash" });
    await engine.startTask(tInput.id);
    await engine.pauseForInput(tInput.id, { prompt: "Confirm" });

    // 5. Task in completed
    const { task: tCompleted } = await engine.submitTask({ goal: "Task completed before crash", definitionId: "test", workspaceId: "ws-crash" });
    await engine.startTask(tCompleted.id);
    await engine.completeTask(tCompleted.id);

    // Simulate Server Restart: Reconcile
    const reconciled = await engine.reconcileOnStartup("ws-crash");

    // Only running and queued tasks should be reconciled to interrupted
    const reconciledIds = reconciled.map((t) => t.id);
    assert.ok(reconciledIds.includes(tRunning.id), "Running task must be reconciled");
    assert.ok(reconciledIds.includes(tQueued.id), "Queued task must be reconciled");
    assert.equal(reconciled.length, 2);

    // Verify states after reconciliation
    const postRunning = await engine.getTask(tRunning.id);
    assert.equal(postRunning?.status, "interrupted");

    const postQueued = await engine.getTask(tQueued.id);
    assert.equal(postQueued?.status, "interrupted");

    // CRITICAL: waiting_approval and waiting_input must NOT be interrupted or auto-approved
    const postApproval = await engine.getTask(tApproval.id);
    assert.equal(postApproval?.status, "waiting_approval");

    const postInput = await engine.getTask(tInput.id);
    assert.equal(postInput?.status, "waiting_input");

    const postCompleted = await engine.getTask(tCompleted.id);
    assert.equal(postCompleted?.status, "completed");

    // Interrupted tasks can transition back to queued (recovery / retry)
    const reQueued = await engine.transitionState(tRunning.id, "queued", { reason: "recovered_after_crash" });
    assert.equal(reQueued.status, "queued");

    localDb.close();
  } finally {
    cleanup();
  }
});

test("PHASE 3: Workspace Isolation Across Multiple Projects", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const localDb = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(localDb.rawDb);
    const engine = new DurableTaskEngine(store);

    await engine.submitTask({ goal: "A1", definitionId: "agent", workspaceId: "project-alpha" });
    await engine.submitTask({ goal: "A2", definitionId: "agent", workspaceId: "project-alpha" });
    await engine.submitTask({ goal: "A3", definitionId: "agent", workspaceId: "project-alpha" });

    await engine.submitTask({ goal: "B1", definitionId: "agent", workspaceId: "project-beta" });
    await engine.submitTask({ goal: "B2", definitionId: "agent", workspaceId: "project-beta" });

    const alphaTasks = await engine.listTasks("project-alpha");
    assert.equal(alphaTasks.length, 3);
    assert.ok(alphaTasks.every((t) => t.workspaceId === "project-alpha"));

    const betaTasks = await engine.listTasks("project-beta");
    assert.equal(betaTasks.length, 2);
    assert.ok(betaTasks.every((t) => t.workspaceId === "project-beta"));

    localDb.close();
  } finally {
    cleanup();
  }
});

test("PHASE 3: End-to-End HTTP API Integration with Idempotency and Isolation", async () => {
  const { dbPath, cleanup } = createTempDb();
  const testWorkspaceDir = mkdtempSync(path.join(os.tmpdir(), "mediobot-test-ws-"));
  try {
    const composition = createFakeComposition();
    const server = await startCommandCenter({
      port: 0,
      databasePath: dbPath,
      composition,
    });
    const baseUrl = server.url!;

    // Open active project workspace
    await server.workspaceManager.openWorkspace(testWorkspaceDir);

    // 1. POST /api/tasks (New Task)
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Deploy web service",
        definitionId: composition.definitions[0].id,
        idempotencyKey: "req-key-abc-123",
      }),
    });
    assert.equal(createRes.status, 202);
    const createData = await createRes.json() as { task: { id: string; status?: string } };
    assert.ok(createData.task.id);
    const taskId = createData.task.id;

    // 2. Duplicate POST /api/tasks (Same Idempotency Key)
    const dupRes = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Deploy web service duplicate",
        definitionId: composition.definitions[0].id,
        idempotencyKey: "req-key-abc-123",
      }),
    });
    assert.equal(dupRes.status, 200);
    const dupData = await dupRes.json() as { task: { id: string }; deduplicated?: boolean };
    assert.equal(dupData.deduplicated, true);
    assert.equal(dupData.task.id, taskId);

    // 3. GET /api/tasks (Returns tasks including the created task)
    const listRes = await fetch(`${baseUrl}/api/tasks`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json() as { tasks: Array<{ id: string }> };
    assert.ok(Array.isArray(listData.tasks));
    assert.ok(listData.tasks.some((t) => t.id === taskId));

    await server.close();
  } finally {
    try {
      rmSync(testWorkspaceDir, { recursive: true, force: true });
    } catch {}
    cleanup();
  }
});

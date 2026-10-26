import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorld, type TaskId, type WorkerId, type ResourceId } from "@mediobot-v2/domain";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import {
  ToolRuntime,
  ToolPermissionEngine,
  classifyToolOperation,
  scopesMatch,
  ToolPermissionError,
  type ApprovalRequest,
  type ToolInvocation,
} from "@mediobot-v2/tools";
import {
  CodyDecisionProvider,
  CodyExecutionAdapter,
  createCodyDefinition,
} from "@mediobot-v2/cody";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ChatRepository } from "../../src/storage/chatRepository.ts";
import { SqliteApprovalRecordStore } from "../../src/storage/approvalStore.ts";
import type { Thread, Turn, ThreadItem } from "../../src/types/index.ts";

type TestFixture = {
  root: string;
  world: ReturnType<typeof createWorld>;
  tools: ToolRuntime;
  engine: ToolPermissionEngine;
  workerId: WorkerId;
  taskId: TaskId;
  resourceId: ResourceId;
  cleanup: () => Promise<void>;
};

async function createFixture(options: { mode?: "Require approval" | "Approve for me"; timeoutMs?: number } = {}): Promise<TestFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-perm-test-"));
  const world = createWorld();
  const definition = world.registerMediobotDefinition({
    name: "Cody",
    role: "engineer",
    version: "1",
    instructions: "test worker",
    declaredCapabilities: [],
  });
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask("test task").id, worker.id);
  const resource = world.registerResource({
    kind: "workspace",
    owner: { type: "worker", worldId: world.id, workerId: worker.id },
  });

  const engine = new ToolPermissionEngine({
    defaultPolicy: {
      mode: options.mode ?? "Require approval",
      approvalTimeoutMs: options.timeoutMs ?? 300_000,
    },
  });

  const tools = new ToolRuntime(world, { permissionEngine: engine });
  await tools.bindWorkspace(resource.id, root);

  world.setWorkerState(worker.id, "busy");
  world.setTaskState(task.id, "running");
  world.setResourceState(resource.id, "in-use");

  return {
    root,
    world,
    tools,
    engine,
    workerId: worker.id,
    taskId: task.id,
    resourceId: resource.id,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("Tool Permission Engine Acceptance Suite (15 Deterministic Tests)", () => {
  // Test 1: Read-only operation allowed under correct policy
  it("Test 1: Read-only operation allowed under correct policy", async () => {
    const f = await createFixture({ mode: "Require approval" });
    try {
      await writeFile(path.join(f.root, "sample.txt"), "hello world\n", "utf8");

      let approvalRequested = false;
      f.engine.setNotifiers({
        onApprovalRequested: () => { approvalRequested = true; },
      });

      const listResult = await f.tools.invoke({
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.list",
        input: { path: "." },
      });

      assert.equal(listResult.status, "succeeded");
      assert.equal(approvalRequested, false, "Read-only operations must not trigger approval");
      assert.ok("entries" in (listResult.output ?? {}));

      const readResult = await f.tools.invoke({
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.read",
        input: { path: "sample.txt" },
      });

      assert.equal(readResult.status, "succeeded");
      assert.equal(approvalRequested, false);
      if (readResult.output && "content" in readResult.output) {
        assert.equal(readResult.output.content, "hello world\n");
      }
    } finally {
      await f.cleanup();
    }
  });

  // Test 2: File modification pauses for approval
  it("Test 2: File modification pauses for approval", async () => {
    const f = await createFixture({ mode: "Require approval" });
    try {
      let capturedRequest: ApprovalRequest | undefined;
      f.engine.setNotifiers({
        onApprovalRequested: (req) => { capturedRequest = req; },
      });

      const invokePromise = f.tools.invoke({
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.write",
        input: { path: "created.txt", content: "new content" },
      });

      // Allow microtasks to run so requestApproval pauses
      await new Promise((r) => setTimeout(r, 20));

      assert.ok(capturedRequest, "Approval request must have been triggered");
      assert.equal(capturedRequest.toolName, "filesystem.write");
      assert.equal(capturedRequest.status, "requested");
      assert.equal(capturedRequest.risk, "medium");

      // Verify file does not exist yet while paused
      let fileExists = false;
      try {
        await readFile(path.join(f.root, "created.txt"));
        fileExists = true;
      } catch {}
      assert.equal(fileExists, false, "File modification must pause before writing to disk");

      // Clean up the paused invocation
      f.engine.respond(capturedRequest.approvalId, false);
      await invokePromise;
    } finally {
      await f.cleanup();
    }
  });

  // Test 3: Terminal execution pauses for approval
  it("Test 3: Terminal execution pauses for approval", async () => {
    const f = await createFixture({ mode: "Require approval" });
    try {
      let capturedRequest: ApprovalRequest | undefined;
      f.engine.setNotifiers({
        onApprovalRequested: (req) => { capturedRequest = req; },
      });

      const invokePromise = f.tools.invoke({
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "terminal.execute",
        input: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      });

      await new Promise((r) => setTimeout(r, 20));

      assert.ok(capturedRequest, "Approval request must be triggered for terminal execution");
      assert.equal(capturedRequest.toolName, "terminal.execute");
      assert.equal(capturedRequest.risk, "high", "Terminal execution must be classified high-risk");
      assert.equal(capturedRequest.status, "requested");

      // Clean up
      f.engine.respond(capturedRequest.approvalId, false);
      await invokePromise;
    } finally {
      await f.cleanup();
    }
  });

  // Test 4: Approval resumes exactly one matching operation
  it("Test 4: Approval resumes exactly one matching operation", async () => {
    const f = await createFixture({ mode: "Require approval" });
    try {
      let capturedRequest: ApprovalRequest | undefined;
      f.engine.setNotifiers({
        onApprovalRequested: (req) => { capturedRequest = req; },
      });

      const invokePromise = f.tools.invoke({
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.write",
        input: { path: "authorized.txt", content: "safe approved content" },
      });

      await new Promise((r) => setTimeout(r, 20));
      assert.ok(capturedRequest);

      const respondResult = f.engine.respond(capturedRequest.approvalId, true);
      assert.equal(respondResult.success, true);
      assert.equal(respondResult.status, "approved");

      const result = await invokePromise;
      assert.equal(result.status, "succeeded");

      const written = await readFile(path.join(f.root, "authorized.txt"), "utf8");
      assert.equal(written, "safe approved content");
    } finally {
      await f.cleanup();
    }
  });

  // Test 5: Rejection prevents execution
  it("Test 5: Rejection prevents execution", async () => {
    const f = await createFixture({ mode: "Require approval" });
    try {
      let capturedRequest: ApprovalRequest | undefined;
      f.engine.setNotifiers({
        onApprovalRequested: (req) => { capturedRequest = req; },
      });

      const invokePromise = f.tools.invoke({
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.write",
        input: { path: "rejected.txt", content: "must not write" },
      });

      await new Promise((r) => setTimeout(r, 20));
      assert.ok(capturedRequest);

      const respondResult = f.engine.respond(capturedRequest.approvalId, false);
      assert.equal(respondResult.success, true);
      assert.equal(respondResult.status, "rejected");

      const result = await invokePromise;
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "PERMISSION_DENIED");

      let fileExists = false;
      try {
        await readFile(path.join(f.root, "rejected.txt"));
        fileExists = true;
      } catch {}
      assert.equal(fileExists, false, "Rejected tool execution must not alter the workspace");
    } finally {
      await f.cleanup();
    }
  });

  // Test 6: Expiration prevents execution
  it("Test 6: Expiration prevents execution", async () => {
    const f = await createFixture({ mode: "Require approval", timeoutMs: 50 });
    try {
      let capturedRequest: ApprovalRequest | undefined;
      f.engine.setNotifiers({
        onApprovalRequested: (req) => { capturedRequest = req; },
      });

      const invokePromise = f.tools.invoke({
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.write",
        input: { path: "expired.txt", content: "should expire" },
      });

      const result = await invokePromise;
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "PERMISSION_DENIED");
      assert.equal(capturedRequest?.status, "expired");

      let fileExists = false;
      try {
        await readFile(path.join(f.root, "expired.txt"));
        fileExists = true;
      } catch {}
      assert.equal(fileExists, false, "Expired approval must not write file");
    } finally {
      await f.cleanup();
    }
  });

  // Test 7: Cancellation invalidates pending approval
  it("Test 7: Cancellation invalidates pending approval", async () => {
    const f = await createFixture({ mode: "Require approval" });
    try {
      const ac = new AbortController();
      let capturedRequest: ApprovalRequest | undefined;
      f.engine.setNotifiers({
        onApprovalRequested: (req) => { capturedRequest = req; },
      });

      const invokePromise = f.tools.invoke({
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.write",
        input: { path: "cancelled.txt", content: "cancelled" },
        signal: ac.signal,
      });

      await new Promise((r) => setTimeout(r, 20));
      assert.ok(capturedRequest);
      assert.equal(capturedRequest.status, "requested");

      ac.abort();

      const result = await invokePromise;
      assert.equal(result.status, "cancelled");
      assert.equal(capturedRequest.status, "cancelled");
      assert.equal(f.engine.getPendingApprovals().length, 0);

      let fileExists = false;
      try {
        await readFile(path.join(f.root, "cancelled.txt"));
        fileExists = true;
      } catch {}
      assert.equal(fileExists, false);
    } finally {
      await f.cleanup();
    }
  });

  // Test 8: Duplicate approval responses do not duplicate execution
  it("Test 8: Duplicate approval responses do not duplicate execution", async () => {
    const f = await createFixture({ mode: "Require approval" });
    try {
      let capturedRequest: ApprovalRequest | undefined;
      f.engine.setNotifiers({
        onApprovalRequested: (req) => { capturedRequest = req; },
      });

      const invokePromise = f.tools.invoke({
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.write",
        input: { path: "single_use.txt", content: "first use" },
      });

      await new Promise((r) => setTimeout(r, 20));
      assert.ok(capturedRequest);

      const firstResponse = f.engine.respond(capturedRequest.approvalId, true);
      assert.equal(firstResponse.success, true);
      assert.equal(firstResponse.status, "approved");

      await invokePromise;

      const secondResponse = f.engine.respond(capturedRequest.approvalId, true);
      assert.equal(secondResponse.success, false, "Second response must fail");
      assert.equal(secondResponse.error, "Approval already consumed");
    } finally {
      await f.cleanup();
    }
  });

  // Test 9: Cross-thread approval is rejected
  it("Test 9: Cross-thread approval is rejected", async () => {
    const f = await createFixture({ mode: "Require approval" });
    try {
      f.engine.bindTaskContext(f.taskId, {
        threadId: "thread-correct-owner",
        turnId: "turn-1",
      });

      let capturedRequest: ApprovalRequest | undefined;
      f.engine.setNotifiers({
        onApprovalRequested: (req) => { capturedRequest = req; },
      });

      const invokePromise = f.tools.invoke({
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.write",
        input: { path: "cross_thread.txt", content: "data" },
      });

      await new Promise((r) => setTimeout(r, 20));
      assert.ok(capturedRequest);

      // Attempt cross-thread approval
      const crossThread = f.engine.respond(capturedRequest.approvalId, true, {
        threadId: "thread-attacker",
      });

      assert.equal(crossThread.success, false);
      assert.equal(crossThread.error, "Cross-thread approval is not permitted");
      assert.equal(capturedRequest.status, "requested", "Status must remain pending");

      // Clean up properly
      f.engine.respond(capturedRequest.approvalId, false);
      await invokePromise;
    } finally {
      await f.cleanup();
    }
  });

  // Test 10: Changed tool arguments invalidate prior approval
  it("Test 10: Changed tool arguments invalidate prior approval", async () => {
    const f = await createFixture({ mode: "Require approval" });
    try {
      const originalWrite: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.write",
        input: { path: "target.js", content: "const a = 1;\n" },
      };

      const decision = f.engine.evaluate(originalWrite, { workspaceRoot: f.root });
      assert.equal(decision.decision, "require_approval");
      if (decision.decision !== "require_approval") return;

      const scope = decision.request.scope;

      // 1. Same invocation matches scope
      assert.equal(scopesMatch(scope, originalWrite), true);

      // 2. Modified content fails scope match
      const tamperedWrite: ToolInvocation = {
        ...originalWrite,
        input: { path: "target.js", content: "const a = 999;\n" },
      };
      assert.equal(scopesMatch(scope, tamperedWrite), false, "Tampered content must invalidate scope");

      // 3. Modified path fails scope match
      const redirectedWrite: ToolInvocation = {
        ...originalWrite,
        input: { path: "target2.js", content: "const a = 1;\n" },
      };
      assert.equal(scopesMatch(scope, redirectedWrite), false, "Tampered path must invalidate scope");

      // 4. Terminal args scope tampering check
      const originalTerminal: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "terminal.execute",
        input: { command: "npm", args: ["test"] },
      };
      const termDecision = f.engine.evaluate(originalTerminal, { workspaceRoot: f.root });
      assert.equal(termDecision.decision, "require_approval");
      if (termDecision.decision !== "require_approval") return;

      const termScope = termDecision.request.scope;
      assert.equal(scopesMatch(termScope, originalTerminal), true);

      const tamperedTerminal: ToolInvocation = {
        ...originalTerminal,
        input: { command: "npm", args: ["test", "--dangerous-flag"] },
      };
      assert.equal(scopesMatch(termScope, tamperedTerminal), false, "Tampered command args must invalidate scope");
    } finally {
      await f.cleanup();
    }
  });

  // Test 11: Protected paths remain forbidden even after approval
  it("Test 11: Protected paths remain forbidden even after approval", async () => {
    const f = await createFixture({ mode: "Approve for me" }); // Even in full-auto mode!
    try {
      // 1. .env file
      const envWrite: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.write",
        input: { path: ".env", content: "SECRET=1" },
      };
      const envDecision = f.engine.evaluate(envWrite, { workspaceRoot: f.root });
      assert.equal(envDecision.decision, "deny", ".env must be categorically denied");

      const envResult = await f.tools.invoke(envWrite);
      assert.equal(envResult.status, "failed");
      assert.equal(envResult.failureStage, "filesystem");

      // 2. Path traversal
      const traversalWrite: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.write",
        input: { path: "../outside.txt", content: "escape" },
      };
      const traversalDecision = f.engine.evaluate(traversalWrite, { workspaceRoot: f.root });
      assert.equal(traversalDecision.decision, "deny", "Traversal must be categorically denied");

      const traversalResult = await f.tools.invoke(traversalWrite);
      assert.equal(traversalResult.status, "failed");

      // 3. Terminal escape
      const escapeTerminal: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "terminal.execute",
        input: { command: "ls", cwd: "/tmp" },
      };
      const termDecision = f.engine.evaluate(escapeTerminal, { workspaceRoot: f.root });
      assert.equal(termDecision.decision, "deny", "Absolute cwd outside workspace must be denied");

      const termResult = await f.tools.invoke(escapeTerminal);
      assert.equal(termResult.status, "failed");
    } finally {
      await f.cleanup();
    }
  });

  // Test 12: Browser reload restores pending approval state
  it("Test 12: Browser reload restores pending approval state", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mediobot-repo-test-"));
    const db = new LocalDatabase(path.join(tmp, "chat.db"));
    try {
      const repo = new ChatRepository(db.raw);
      const thread: Thread = {
        id: "thread-session-123",
        title: "Approval Session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turns: [{
          id: "turn-123",
          threadId: "thread-session-123",
          prompt: "Modify the project file",
          status: "waiting_approval",
          currentActivity: "waiting_for_approval",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          items: [{
            id: "approval-test-123",
            turnId: "turn-123",
            type: "approval_request",
            timestamp: Date.now(),
            actor: { type: "mediobot", mediobotId: "cody", name: "Cody" },
            text: "Cody requests approval to write to src/index.ts",
            approval: {
              approvalId: "approval-test-123",
              title: "Write to src/index.ts",
              description: "Write to src/index.ts (15 bytes)",
              status: "requested",
              risk: "medium",
              mediobotName: "Cody",
              workspace: "/workspace/my-app",
            },
          }],
        }],
      };
      repo.save(thread);

      // Simulate browser reload by reading thread and turn from SQLite
      const restored = repo.get("thread-session-123");
      assert.ok(restored);
      assert.equal(restored.turns.length, 1);
      const turn = restored.turns[0]!;
      assert.equal(turn.status, "waiting_approval");
      assert.equal(turn.items.length, 1);

      const item = turn.items[0]!;
      assert.equal(item.type, "approval_request");
      assert.ok(item.approval);
      assert.equal(item.approval.status, "requested");
      assert.equal(item.approval.mediobotName, "Cody");
      assert.equal(item.approval.workspace, "/workspace/my-app");
      assert.equal(item.approval.risk, "medium");
      assert.equal(item.approval.description, "Write to src/index.ts (15 bytes)");
    } finally {
      db.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // Test 13: Server restart preserves the pending approval without granting it
  it("Test 13: Server restart preserves a pending approval without auto-approving", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mediobot-restart-test-"));
    const db = new LocalDatabase(path.join(tmp, "chat.db"));
    try {
      const repo = new ChatRepository(db.raw);
      const thread: Thread = {
        id: "thread-restart-123",
        title: "Interrupted Session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turns: [{
          id: "turn-restart",
          threadId: "thread-restart-123",
          prompt: "Run build command",
          status: "waiting_approval",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          items: [{
            id: "approval-pending-on-restart",
            turnId: "turn-restart",
            type: "approval_request",
            timestamp: Date.now(),
            approval: {
              approvalId: "pending-req-id",
              title: "Execute command",
              description: "Execute command: npm run build",
              status: "requested",
              risk: "high",
              mediobotName: "Cody",
            },
          }],
        }],
      };
      repo.save(thread);

      // Server crashes/restarts: reconcileInterruptedTurns is invoked
      repo.reconcileInterruptedTurns();

      // Read back turn
      const reconciled = repo.get("thread-restart-123");
      assert.ok(reconciled);
      assert.equal(reconciled.turns.length, 1);
      const turn = reconciled.turns[0]!;
      assert.equal(turn.status, "waiting_approval", "The user must still be able to resolve the pending approval");

      const item = turn.items.find((it) => it.id === "approval-pending-on-restart");
      assert.ok(item && item.approval);
      assert.equal(item.approval.status, "requested", "Restart must not decide approval on the user's behalf");
    } finally {
      db.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("persists an exact-action approval across engine restart and resumes only that action", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mediobot-approval-recovery-"));
    let db = new LocalDatabase(path.join(tmp, "chat.db"));
    const f = await createFixture();
    try {
      db.rawDb.prepare(`INSERT INTO durable_tasks (id, goal, definition_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(f.taskId, "restartable approval", "maestro", "waiting_approval", Date.now(), Date.now());
      const store = new SqliteApprovalRecordStore(db.rawDb);
      const firstEngine = new ToolPermissionEngine({ defaultPolicy: { mode: "Require approval" }, approvalStore: store });
      firstEngine.bindTaskContext(f.taskId, { threadId: "thread-approval", turnId: "turn-approval",
        policy: { mode: "Require approval" } });
      const invocation: ToolInvocation = {
        worldId: f.world.id, workerId: f.workerId, taskId: f.taskId, resourceId: f.resourceId,
        name: "filesystem.write", input: { path: "src/result.txt", content: "private test content" },
      };
      const firstWait = firstEngine.requestApproval(invocation, { workspaceRoot: f.root, workerName: "Cody" });
      await Promise.resolve();
      const request = firstEngine.getPendingApprovals()[0];
      assert.ok(request);
      firstEngine.attachWorkflowInterrupt(request.approvalId, "langgraph-interrupt-1");
      const persisted = db.rawDb.prepare("SELECT request_json, status FROM durable_tool_approvals WHERE approval_id = ?")
        .get(request.approvalId) as { request_json: string; status: string };
      assert.equal(persisted.status, "requested");
      assert.equal(persisted.request_json.includes("private test content"), false, "Approval journal must not store file contents");
      firstEngine.suspendForRestart();
      assert.equal((await firstWait).status, "cancelled", "The process-local waiter is released without settling the durable approval");
      assert.equal((store.get(request.approvalId))?.status, "requested");

      db.close();
      db = new LocalDatabase(path.join(tmp, "chat.db"));
      const restartedStore = new SqliteApprovalRecordStore(db.rawDb);
      const restoredEngine = new ToolPermissionEngine({ defaultPolicy: { mode: "Require approval" }, approvalStore: restartedStore });
      assert.equal(restoredEngine.getPendingApprovals().length, 1);
      assert.equal(restoredEngine.getWorkflowInterruptId(request.approvalId), "langgraph-interrupt-1");
      const decision = restoredEngine.respond(request.approvalId, true, { threadId: request.threadId, turnId: request.turnId });
      assert.equal(decision.success, true);
      assert.equal(decision.needsWorkflowResume, true);
      const crossThreadRetry = restoredEngine.respond(request.approvalId, true, { threadId: "unrelated-thread", turnId: request.turnId });
      assert.equal(crossThreadRetry.success, false, "a retry cannot move the durable approval to another thread");
      const retry = restoredEngine.respond(request.approvalId, true, { threadId: request.threadId, turnId: request.turnId });
      assert.equal(retry.success, true, "an approved action remains resumable if workflow resume failed before consuming it");
      assert.equal(retry.needsWorkflowResume, true);
      assert.deepEqual(await restoredEngine.requestApproval(invocation, { workspaceRoot: f.root, workerName: "Cody" }),
        { ok: true, status: "approved" });
      assert.equal(restartedStore.get(request.approvalId)?.status, "consumed");
      const replay = await restoredEngine.requestApproval(invocation, { workspaceRoot: f.root, workerName: "Cody" });
      assert.equal(replay.ok, false, "A consumed approval is not silently reused after interruption");
      assert.match(replay.reason ?? "", /outcome is ambiguous/);

      const changedInvocation: ToolInvocation = { ...invocation, input: { path: "src/result.txt", content: "different content" } };
      const aborted = new AbortController(); aborted.abort();
      const changed = await restoredEngine.requestApproval(changedInvocation, { workspaceRoot: f.root, signal: aborted.signal, workerName: "Cody" });
      assert.equal(changed.ok, false, "A different write payload cannot reuse the approved action");
      assert.equal(changed.status, "cancelled");

      restoredEngine.bindTaskContext(f.taskId, { threadId: request.threadId, turnId: request.turnId,
        policy: { mode: "Require approval" } });
      const rejectedInvocation: ToolInvocation = { ...invocation, input: { path: "src/rejected.txt", content: "reject me" } };
      const rejectionInterrupt = new Error("controlled workflow interruption");
      await assert.rejects(restoredEngine.requestApproval(rejectedInvocation, { workspaceRoot: f.root, workerName: "Cody",
        interruptTask: () => { throw rejectionInterrupt; } }), error => error === rejectionInterrupt);
      const rejectedRequest = restoredEngine.getPendingApprovals()[0];
      assert.ok(rejectedRequest);
      const firstRejection = restoredEngine.respond(rejectedRequest.approvalId, false);
      assert.equal(firstRejection.success, true);
      assert.equal(firstRejection.needsWorkflowResume, true);
      const restartedAfterRejection = new ToolPermissionEngine({ defaultPolicy: { mode: "Require approval" }, approvalStore: restartedStore });
      const crossThreadRejectionRetry = restartedAfterRejection.respond(rejectedRequest.approvalId, false,
        { threadId: "unrelated-thread", turnId: request.turnId });
      assert.equal(crossThreadRejectionRetry.success, false, "a rejected workflow resume cannot move to another thread");
      const rejectionRetry = restartedAfterRejection.respond(rejectedRequest.approvalId, false,
        { threadId: request.threadId, turnId: request.turnId });
      assert.equal(rejectionRetry.success, true, "a durable rejection remains resumable after a transient workflow-resume failure");
      assert.equal(rejectionRetry.status, "rejected");
      assert.equal(rejectionRetry.needsWorkflowResume, true);
      const rejectedReplay = await restoredEngine.requestApproval(rejectedInvocation, { workspaceRoot: f.root, workerName: "Cody" });
      assert.equal(rejectedReplay.status, "rejected", "Restart replay preserves the user's rejection");
      assert.equal(restartedStore.get(rejectedRequest.approvalId)?.status, "rejected_consumed",
        "the denial becomes terminal once the resumed exact action observes it");
      assert.equal(restartedAfterRejection.respond(rejectedRequest.approvalId, false,
        { threadId: request.threadId, turnId: request.turnId }).success, false,
      "a delivered denial cannot trigger another workflow resume");
      assert.equal(restoredEngine.getPendingApprovals().length, 0, "A rejected action must not ask again during replay");
    } finally {
      db.close();
      await f.cleanup();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // Test 14: Existing Cody workflows retain correct execution and verification behavior
  it("Test 14: Existing Cody workflows retain correct execution and verification behavior", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-wf-"));
    try {
      const srcDir = path.join(root, "src");
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(srcDir, "math.js"), "export function sum(a, b) { return a - b; }\n");
      await writeFile(path.join(root, "check.cjs"), `
        const fs = require("node:fs");
        const code = fs.readFileSync("src/math.js", "utf8");
        process.exit(code.includes("a + b") ? 0 : 1);
      `);

      const actions = [
        { type: "list", path: "." },
        { type: "read", path: "src/math.js" },
        { type: "write", path: "src/math.js", content: "export function sum(a, b) { return a + b; }\n" },
        { type: "run", command: process.execPath, args: ["check.cjs"], verification: "Validate sum fix" },
        { type: "finish", summary: "Fixed sum function and verified with check.cjs" },
      ];
      let step = 0;
      const modelClient = { complete: async () => JSON.stringify(actions[step++]) };

      const world = createWorld();
      const engine = new ToolPermissionEngine({ defaultPolicy: { mode: "Approve for me" } });
      const tools = new ToolRuntime(world, { permissionEngine: engine });
      const runtime = new WorkerRuntime(world);
      const submission = new RuntimeTaskSubmission(world, runtime);
      const def = createCodyDefinition(world);
      const adapter = new CodyExecutionAdapter({
        tools,
        decisions: new CodyDecisionProvider(modelClient),
      });
      submission.registerAdapter(def.id, adapter);

      const submitted = submission.submit({
        definitionId: def.id,
        goal: "Fix the sum function and verify with check.cjs",
        options: { workspaceRoot: root },
      });

      const outcome = await submitted.result;
      assert.equal(outcome.state, "completed");

      const fileContent = await readFile(path.join(srcDir, "math.js"), "utf8");
      assert.equal(fileContent, "export function sum(a, b) { return a + b; }\n");

      const inspect = world.inspect();
      const succeededTools = inspect.events.filter((e) => e.type === "tool.succeeded");
      assert.ok(succeededTools.length >= 4, "All tool operations must succeed under Approve for me");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

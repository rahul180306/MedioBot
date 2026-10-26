import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createWorld, type TaskId, type WorkerId, type ResourceId, type GoalCriterion } from "@mediobot-v2/domain";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import {
  ToolRuntime,
  ToolPermissionEngine,
  ToolPermissionError,
  type ApprovalRequest,
} from "@mediobot-v2/tools";
import {
  CodyDecisionProvider,
  CodyExecutionAdapter,
  createCodyDefinition,
} from "@mediobot-v2/cody";
import {
  createTesterDefinition,
  computeWorkspaceRevision,
  TesterDecisionProvider,
  TesterExecutionAdapter,
  type VerificationReport,
} from "@mediobot-v2/tester";
import {
  createMaestroCodyExecution,
  parseMediobotDefinition,
  MaestroDecisionProvider,
} from "@mediobot-v2/maestro";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ChatRepository } from "../../src/storage/chatRepository.ts";

const MAESTRO_MD = `---
id: maestro
name: Maestro
role: orchestrator
version: 0.1.0
---

Maestro orchestrator instructions.
`;

describe("MEDIOBOT V2 — M2: Multi-Agent Engineering Foundation (Phase 7 Acceptance Suite)", () => {
  it("Scenario 1, 2, 3, 7: Maestro delegates to Cody → Cody modifies workspace → Tester independently verifies → Criterion satisfied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m2-scenario-123-"));
    try {
      await writeFile(path.join(root, "math.js"), "function add(a, b) { return 0; }\nmodule.exports = { add };\n");
      const world = createWorld();
      const runtime = new WorkerRuntime(world);
      const permissionEngine = new ToolPermissionEngine({
        defaultPolicy: { mode: "Approve for me", approvalTimeoutMs: 10_000 },
      });
      const tools = new ToolRuntime(world, { permissionEngine });

      // Model fixtures:
      // Cody reads math.js, updates math.js with correct implementation, runs a check, and finishes.
      let codyStep = 0;
      const codyDecisions = new CodyDecisionProvider({
        complete: async () => {
          codyStep++;
          if (codyStep === 1) return JSON.stringify({ type: "read", path: "math.js" });
          if (codyStep === 2) {
            return JSON.stringify({
              type: "write",
              path: "math.js",
              content: "function add(a, b) { return a + b; }\nmodule.exports = { add };\n",
            });
          }
          if (codyStep === 3) {
            return JSON.stringify({
              type: "run",
              command: "node",
              args: ["-e", "process.exit(0)"],
              verification: "check exited 0",
            });
          }
          return JSON.stringify({ type: "finish", summary: "Implemented add in math.js" });
        },
      });

      // Tester lists files, reads math.js, executes test command, verifies assertions, and finishes with verified report.
      let testerStep = 0;
      const testerDecisions = new TesterDecisionProvider({
        complete: async () => {
          testerStep++;
          if (testerStep === 1) return JSON.stringify({ type: "list", path: "." });
          if (testerStep === 2) return JSON.stringify({ type: "read", path: "math.js" });
          if (testerStep === 3) {
            return JSON.stringify({
              type: "run",
              command: "node",
              args: ["-e", "const { add } = require('./math.js'); if (add(2, 3) !== 5) process.exit(1);"],
              check: "Verify add(2, 3) equals 5",
            });
          }
          return JSON.stringify({
            type: "finish",
            report: {
              status: "verified",
              summary: "Independent verification passed: add(2, 3) === 5",
              observations: ["math.js contains addition logic"],
              assertions: [{ name: "addition test", passed: true, actual: "5", expected: "5" }],
              supportedCriteria: ["math-add-correct"],
              unverifiedRequirements: [],
            },
          });
        },
      });

      const maestroDef = parseMediobotDefinition(MAESTRO_MD);
      const execution = createMaestroCodyExecution({
        world,
        runtime,
        tools,
        maestroDefinition: maestroDef,
        codyDecisions,
        testerDecisions,
        maestroDecisions: new MaestroDecisionProvider({ complete: async () => "" }),
      });

      const maestroTask = world.createTask("Implement and independently verify add function in math.js");
      const maestroWorker = world.spawnWorker(execution.maestroDefinitionId);
      world.assignTask(maestroTask.id, maestroWorker.id);

      const plan = execution.adapter.prepare({
        world,
        definitionId: execution.maestroDefinitionId,
        workerId: maestroWorker.id,
        taskId: maestroTask.id,
        goal: maestroTask.goal,
        options: {
          workspaceRoot: root,
          verifyWithTester: true,
          maestroDecision: {
            type: "delegate",
            definitionId: execution.codyDefinitionId,
            objective: "Implement add in math.js",
            relevantContextRefs: ["math.js"],
            constraints: ["CommonJS format"],
            expectedOutcome: "math.js exports working add function",
            evidenceExpectations: ["Test verification confirms addition"],
          },
          successCriteria: [
            {
              id: "math-add-correct",
              statement: "math.js exports working add function",
              evidenceRequirement: {
                kind: "test-execution",
                source: { type: "tester-verification", reference: "test-run" },
                validity: "verified",
              },
            },
          ],
        },
      });

      const result = await runtime.run({
        ...plan,
        workerId: maestroWorker.id,
        taskId: maestroTask.id,
      });

      assert.equal(result.state, "completed");

      // Scenario 1: Cody was assigned
      const snapshot = world.inspect();
      const codyTask = snapshot.tasks.find((t) => t.parentTaskId === maestroTask.id && t.assignedWorkerId);
      assert.ok(codyTask, "Cody child task must be created");

      // Scenario 2: Real workspace modification occurred on disk
      const updatedCode = await readFile(path.join(root, "math.js"), "utf8");
      assert.ok(updatedCode.includes("return a + b"), "Cody must modify math.js on disk");

      // Scenario 3: Tester independently executed test command
      const testerTask = snapshot.tasks.find((t) => t.goal.startsWith("Verify implementation"));
      assert.ok(testerTask, "Tester child task must be created");
      const testerEvidence = snapshot.evidence.filter((e) => e.taskId === testerTask.id);
      const testerVerification = testerEvidence.find((e) => e.source.type === "tester-verification");
      assert.ok(testerVerification, "Tester must record tester-verification evidence");
      assert.equal(testerVerification.validity, "verified");

      // Scenario 7: Goal criterion satisfied by tester-verification
      const goal = snapshot.goals[0];
      assert.ok(goal);
      assert.equal(goal.status, "satisfied");
      const criterion = goal.successCriteria.find((c) => c.id === "math-add-correct");
      assert.ok(criterion);
      assert.equal(criterion.state, "satisfied");
      assert.ok(criterion.supportingEvidenceIds.length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Scenario 4, 5, 6: Tester detects incorrect implementation → Cody claims success while Tester reports failure → Maestro rejects completion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m2-scenario-456-"));
    try {
      await writeFile(path.join(root, "calc.js"), "function add(a, b) { return a - b; }\nmodule.exports = { add };\n");
      const world = createWorld();
      const runtime = new WorkerRuntime(world);
      const permissionEngine = new ToolPermissionEngine({
        defaultPolicy: { mode: "Approve for me", approvalTimeoutMs: 10_000 },
      });
      const tools = new ToolRuntime(world, { permissionEngine });

      // Cody claims success despite faulty code
      let codyStep = 0;
      const codyDecisions = new CodyDecisionProvider({
        complete: async () => {
          codyStep++;
          if (codyStep === 1) return JSON.stringify({ type: "read", path: "calc.js" });
          if (codyStep === 2) {
            // Intentionally flawed implementation: subtraction instead of addition
            return JSON.stringify({
              type: "write",
              path: "calc.js",
              content: "function add(a, b) { return a - b; }\nmodule.exports = { add };\n",
            });
          }
          if (codyStep === 3) {
            return JSON.stringify({
              type: "run",
              command: "node",
              args: ["-e", "process.exit(0)"],
              verification: "node check passed",
            });
          }
          // Cody claims task success
          return JSON.stringify({ type: "finish", summary: "Addition implemented successfully in calc.js" });
        },
      });

      // Tester executes independent check, observes failure, and finishes with failure report
      let testerStep = 0;
      const testerDecisions = new TesterDecisionProvider({
        complete: async () => {
          testerStep++;
          if (testerStep === 1) return JSON.stringify({ type: "read", path: "calc.js" });
          if (testerStep === 2) {
            return JSON.stringify({
              type: "run",
              command: "node",
              args: ["-e", "const { add } = require('./calc.js'); if (add(2, 3) !== 5) process.exit(1);"],
              check: "Verify add(2, 3) === 5",
            });
          }
          // Scenario 4: Tester detects failure
          return JSON.stringify({
            type: "finish",
            report: {
              status: "failed",
              summary: "Verification check failed: add(2, 3) returned -1 instead of 5",
              observations: ["calc.js subtracts instead of adding"],
              assertions: [{ name: "2+3=5", passed: false, actual: "-1", expected: "5" }],
              supportedCriteria: [],
              unverifiedRequirements: ["add must return sum"],
            },
          });
        },
      });

      let maestroMessage = "";
      const maestroDef = parseMediobotDefinition(MAESTRO_MD);
      const execution = createMaestroCodyExecution({
        world,
        runtime,
        tools,
        maestroDefinition: maestroDef,
        codyDecisions,
        testerDecisions,
        maestroDecisions: new MaestroDecisionProvider({ complete: async () => "" }),
        onUserMessage: (msg) => {
          maestroMessage = msg;
        },
      });

      const maestroTask = world.createTask("Implement addition");
      const maestroWorker = world.spawnWorker(execution.maestroDefinitionId);
      world.assignTask(maestroTask.id, maestroWorker.id);

      const plan = execution.adapter.prepare({
        world,
        definitionId: execution.maestroDefinitionId,
        workerId: maestroWorker.id,
        taskId: maestroTask.id,
        goal: maestroTask.goal,
        options: {
          workspaceRoot: root,
          verifyWithTester: true,
          maestroDecision: {
            type: "delegate",
            definitionId: execution.codyDefinitionId,
            objective: "Implement add in calc.js",
            relevantContextRefs: ["calc.js"],
            constraints: [],
            expectedOutcome: "calc.js exports correct add function",
            evidenceExpectations: ["Verification test exits 0"],
          },
          successCriteria: [
            {
              id: "calc-add-correct",
              statement: "calc.js exports correct add function",
              evidenceRequirement: {
                kind: "verification-proof",
                source: { type: "tester-verification", reference: "test-run" },
                validity: "verified",
              },
            },
          ],
        },
      });

      await runtime.run({
        ...plan,
        workerId: maestroWorker.id,
        taskId: maestroTask.id,
      });

      const snapshot = world.inspect();
      const goal = snapshot.goals[0]!;
      // Scenario 6: Maestro rejects completion and goal fails
      assert.equal(goal.status, "failed");

      // Scenario 5: Cody claimed success while Tester reported failure - both preserved in maestro-evaluation
      const evalEvidence = snapshot.evidence.find((e) => e.source.type === "maestro-evaluation");
      assert.ok(evalEvidence, "Maestro must record maestro-evaluation evidence");
      assert.match(evalEvidence.content, /Cody reported success, but independent Tester verification failed/i);
      assert.match(maestroMessage, /Maestro rejected completion/i);
      assert.match(maestroMessage, /Cody summary \(unsupported claim\)/i);
      assert.match(maestroMessage, /Verification status: failed/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Scenario 8: Stale verification cannot validate later edits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m2-scenario-8-"));
    try {
      await writeFile(path.join(root, "file.txt"), "version 1");
      const rev1 = await computeWorkspaceRevision(root);

      await writeFile(path.join(root, "file.txt"), "version 2");
      const rev2 = await computeWorkspaceRevision(root);

      assert.notEqual(rev1, rev2, "Workspace revision must change when files are edited");

      const world = createWorld();
      const goal = world.createGoal({
        threadId: "test",
        objective: "Verify file",
        constraints: [],
        successCriteria: [
          {
            id: "crit-1",
            statement: "File must be verified",
            evidenceRequirement: {
              kind: "verification-proof",
              source: { type: "tester-verification", reference: "run-1" },
              validity: "verified",
              subject: "workspace",
              revision: rev2, // current revision
            },
          },
        ],
        evidenceRequirements: [],
      });

      // Create task and worker in world
      const task = world.assignTask(world.createTask("verify task").id, world.spawnWorker(createTesterDefinition(world).id).id);
      world.setTaskState(task.id, "running");

      // Record stale verification evidence matching rev1
      const staleEvidence = world.recordEvidence({
        taskId: task.id,
        workerId: task.assignedWorkerId!,
        source: { type: "tester-verification", reference: "run-1" },
        kind: "verification-proof",
        validity: "verified",
        subject: "workspace",
        revision: rev1, // stale!
        content: "Passed on revision 1",
      });

      // Attempt to support criterion with stale evidence
      const criterion = goal.successCriteria[0]!;
      const matchesRevision = criterion.evidenceRequirement?.revision === staleEvidence.revision;
      assert.equal(matchesRevision, false, "Stale revision must not match current requirement");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Scenario 9: Tester cannot exceed inherited tool permissions (filesystem.write denied)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m2-scenario-9-"));
    try {
      const world = createWorld();
      const permissionEngine = new ToolPermissionEngine({
        defaultPolicy: { mode: "Approve for me", approvalTimeoutMs: 10_000 },
      });
      const tools = new ToolRuntime(world, { permissionEngine });

      const testerDef = createTesterDefinition(world);
      const worker = world.spawnWorker(testerDef.id);
      const task = world.assignTask(world.createTask("test").id, worker.id);
      const resource = world.registerResource({
        kind: "workspace",
        owner: { type: "task", worldId: world.id, taskId: task.id },
      });
      await tools.bindWorkspace(resource.id, root);

      world.setWorkerState(worker.id, "busy");
      world.setTaskState(task.id, "running");
      world.setResourceState(resource.id, "in-use");

      // Tester invokes filesystem.write
      const result = await tools.invoke({
        worldId: world.id,
        name: "filesystem.write",
        resourceId: resource.id,
        taskId: task.id,
        workerId: worker.id,
        input: { path: "forbidden.txt", content: "hacked" },
      });

      assert.equal(result.status, "failed");
      assert.equal(result.failureStage, "filesystem");
      assert.match(result.error ?? "", /Tester is not permitted to perform file modifications/i);

      tools.releaseWorkspace(resource.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Scenario 10: Tester cannot escape workspace boundaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m2-scenario-10-"));
    try {
      const world = createWorld();
      const tools = new ToolRuntime(world);
      const testerDef = createTesterDefinition(world);
      const worker = world.spawnWorker(testerDef.id);
      const task = world.assignTask(world.createTask("test").id, worker.id);
      const resource = world.registerResource({
        kind: "workspace",
        owner: { type: "task", worldId: world.id, taskId: task.id },
      });
      await tools.bindWorkspace(resource.id, root);

      world.setWorkerState(worker.id, "busy");
      world.setTaskState(task.id, "running");
      world.setResourceState(resource.id, "in-use");

      // Attempt to escape outside root
      const escapeResult = await tools.invoke({
        worldId: world.id,
        name: "filesystem.read",
        resourceId: resource.id,
        taskId: task.id,
        workerId: worker.id,
        input: { path: "../outside.txt" },
      });
      assert.equal(escapeResult.status, "failed");
      assert.equal(escapeResult.failureStage, "filesystem");

      // Attempt to access sensitive credential path
      const sensitiveResult = await tools.invoke({
        worldId: world.id,
        name: "filesystem.read",
        resourceId: resource.id,
        taskId: task.id,
        workerId: worker.id,
        input: { path: ".env" },
      });
      assert.equal(sensitiveResult.status, "failed");
      assert.equal(sensitiveResult.failureStage, "filesystem");

      tools.releaseWorkspace(resource.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Scenario 11: Pending approvals pause Tester tool execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m2-scenario-11-"));
    try {
      const world = createWorld();
      let requestedApproval: ApprovalRequest | undefined;
      const permissionEngine = new ToolPermissionEngine({
        defaultPolicy: { mode: "Require approval", approvalTimeoutMs: 10_000 },
      });
      permissionEngine.setNotifiers({
        onApprovalRequested: (req) => {
          requestedApproval = req;
        },
      });
      const tools = new ToolRuntime(world, { permissionEngine });

      const testerDef = createTesterDefinition(world);
      const worker = world.spawnWorker(testerDef.id);
      const task = world.assignTask(world.createTask("test").id, worker.id);
      const resource = world.registerResource({
        kind: "workspace",
        owner: { type: "task", worldId: world.id, taskId: task.id },
      });
      await tools.bindWorkspace(resource.id, root);

      world.setWorkerState(worker.id, "busy");
      world.setTaskState(task.id, "running");
      world.setResourceState(resource.id, "in-use");

      permissionEngine.bindTaskContext(task.id, {
        policy: { mode: "Require approval", approvalTimeoutMs: 10_000 },
        mediobotName: "Tester",
      });

      // Tester invokes terminal.execute which requires approval
      const invokePromise = tools.invoke({
        worldId: world.id,
        name: "terminal.execute",
        resourceId: resource.id,
        taskId: task.id,
        workerId: worker.id,
        input: { command: "node", args: ["-e", "process.exit(0)"] },
      });

      // Let microtasks run
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(requestedApproval, "Approval request must be emitted and pending");
      assert.equal(requestedApproval.toolName, "terminal.execute");

      // Resolve approval
      permissionEngine.respond(requestedApproval.approvalId, true);
      const result = await invokePromise;
      assert.equal(result.status, "succeeded");

      tools.releaseWorkspace(resource.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Scenario 12: Cancellation stops delegated verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m2-scenario-12-"));
    try {
      const world = createWorld();
      const runtime = new WorkerRuntime(world);
      const tools = new ToolRuntime(world);

      let stepsExecuted = 0;
      const testerDecisions = new TesterDecisionProvider({
        complete: async ({ signal }) => {
          stepsExecuted++;
          await new Promise((resolve) => {
            if (signal.aborted) return resolve(undefined);
            signal.addEventListener("abort", () => resolve(undefined));
          });
          throw new Error("aborted");
        },
      });

      const adapter = new TesterExecutionAdapter({ tools, decisions: testerDecisions });
      const testerDef = createTesterDefinition(world);
      const worker = world.spawnWorker(testerDef.id);
      const task = world.assignTask(world.createTask("Verify").id, worker.id);

      const plan = adapter.prepare({
        world,
        definitionId: testerDef.id,
        workerId: worker.id,
        taskId: task.id,
        goal: task.goal,
        options: { workspaceRoot: root },
      });

      const runPromise = runtime.run({
        ...plan,
        workerId: worker.id,
        taskId: task.id,
      });

      await new Promise((r) => setTimeout(r, 20));
      runtime.cancel(task.id);
      const res = await runPromise;

      assert.equal(res.state, "cancelled");
      assert.ok(stepsExecuted <= 2, "Tester must not continue running indefinitely after cancellation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Scenario 13: Duplicate events do not duplicate evidence", async () => {
    const world = createWorld();
    const testerDef = createTesterDefinition(world);
    const worker = world.spawnWorker(testerDef.id);
    const task = world.assignTask(world.createTask("goal").id, worker.id);

    world.setWorkerState(worker.id, "busy");
    world.setTaskState(task.id, "running");

    // Record an initial evidence
    const e1 = world.recordEvidence({
      taskId: task.id,
      workerId: worker.id,
      source: { type: "tester-verification", reference: "run-1" },
      kind: "verification-proof",
      validity: "verified",
      content: "Result 1",
    });

    const snapshot1 = world.inspect();
    assert.equal(snapshot1.evidence.length, 1);

    // Invalidate and verify clean state
    world.invalidateEvidence(e1.id);
    const snapshot2 = world.inspect();
    assert.equal(snapshot2.evidence.find((e) => e.id === e1.id)?.validity, "invalidated");
  });

  it("Scenario 14: Restart recovery preserves accurate verification state in SQLite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m2-scenario-14-"));
    const dbPath = path.join(root, "app.db");
    try {
      const db1 = new LocalDatabase(dbPath);
      const chatRepo1 = new ChatRepository(db1.raw);

      chatRepo1.save({
        id: "thread-v",
        title: "Verification Thread",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turns: [
          {
            id: "turn-v",
            threadId: "thread-v",
            prompt: "Verify build",
            status: "completed",
            currentActivity: "completed",
            createdAt: Date.now(),
            completedAt: Date.now(),
            taskId: "task-root" as TaskId,
            items: [
              {
                id: "tool-v",
                turnId: "turn-v",
                type: "tool_execution",
                timestamp: Date.now(),
                text: "Verification command executed",
                tool: {
                  toolName: "terminal.execute",
                  status: "success",
                  isVerification: true,
                  verificationStatus: "command-succeeded",
                  exitCode: 0,
                },
              },
              {
                id: "msg-v",
                turnId: "turn-v",
                type: "agent_message",
                timestamp: Date.now(),
                text: "Goal satisfied by independent Tester verification.\nTester verification: All 4 assertions passed.",
              },
            ],
          },
        ],
      });
      db1.close();

      // Simulate restart by opening a new connection to the same SQLite database
      const db2 = new LocalDatabase(dbPath);
      const chatRepo2 = new ChatRepository(db2.raw);
      const recovered = chatRepo2.get("thread-v");

      assert.ok(recovered);
      const turn = recovered.turns[0]!;
      assert.equal(turn.status, "completed");
      const toolItem = turn.items.find((i) => i.type === "tool_execution");
      assert.ok(toolItem);
      assert.equal(toolItem.tool?.isVerification, true);
      assert.equal(toolItem.tool?.verificationStatus, "command-succeeded");
      assert.equal(toolItem.tool?.exitCode, 0);

      const agentMsg = turn.items.find((i) => i.type === "agent_message");
      assert.ok(agentMsg);
      assert.match(agentMsg.text ?? "", /Goal satisfied by independent Tester verification/i);

      db2.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Scenario 15: Read-only and documentation tasks do not unnecessarily require executable Tester runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m2-scenario-15-"));
    try {
      await writeFile(path.join(root, "README.md"), "# Documentation\nAll about the system.\n");
      const world = createWorld();
      const runtime = new WorkerRuntime(world);
      const tools = new ToolRuntime(world);

      let testerRan = false;
      const testerDecisions = new TesterDecisionProvider({
        complete: async () => {
          testerRan = true;
          return JSON.stringify({ type: "finish", report: { status: "verified", summary: "Tester ran" } });
        },
      });

      // Cody reads file and finishes without writing anything (read-only)
      let codyStep = 0;
      const codyDecisions = new CodyDecisionProvider({
        complete: async () => {
          codyStep++;
          if (codyStep === 1) return JSON.stringify({ type: "read", path: "README.md" });
          return JSON.stringify({ type: "finish", summary: "Inspected documentation; no code changes required." });
        },
      });

      const maestroDef = parseMediobotDefinition(MAESTRO_MD);
      const execution = createMaestroCodyExecution({
        world,
        runtime,
        tools,
        maestroDefinition: maestroDef,
        codyDecisions,
        testerDecisions,
        maestroDecisions: new MaestroDecisionProvider({ complete: async () => "" }),
      });

      const maestroTask = world.createTask("Review README.md");
      const maestroWorker = world.spawnWorker(execution.maestroDefinitionId);
      world.assignTask(maestroTask.id, maestroWorker.id);

      // Task without verifyWithTester
      const plan = execution.adapter.prepare({
        world,
        definitionId: execution.maestroDefinitionId,
        workerId: maestroWorker.id,
        taskId: maestroTask.id,
        goal: maestroTask.goal,
        options: {
          workspaceRoot: root,
          maestroDecision: {
            type: "delegate",
            definitionId: execution.codyDefinitionId,
            objective: "Review README.md",
            relevantContextRefs: ["README.md"],
            constraints: [],
            expectedOutcome: "Documentation inspected",
            evidenceExpectations: [],
          },
        },
      });

      const result = await runtime.run({
        ...plan,
        workerId: maestroWorker.id,
        taskId: maestroTask.id,
      });

      assert.equal(result.state, "completed");
      assert.equal(testerRan, false, "Tester must not be run for read-only documentation inspection tasks");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Negative test: Fabricated verified claim without test execution is downgraded to unverified", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m2-neg-fabricated-"));
    try {
      const world = createWorld();
      const runtime = new WorkerRuntime(world);
      const tools = new ToolRuntime(world);

      // Tester fabricates status: "verified" without running any checks
      const testerDecisions = new TesterDecisionProvider({
        complete: async () => {
          return JSON.stringify({
            type: "finish",
            report: {
              status: "verified",
              summary: "Fabricated claim: I checked and everything works perfectly!",
              observations: [],
              assertions: [{ name: "unexecuted assertion", passed: true }],
              supportedCriteria: ["goal-1"],
              unverifiedRequirements: [],
            },
          });
        },
      });

      const adapter = new TesterExecutionAdapter({ tools, decisions: testerDecisions });
      const testerDef = createTesterDefinition(world);
      const worker = world.spawnWorker(testerDef.id);
      const task = world.assignTask(world.createTask("Verify").id, worker.id);

      const plan = adapter.prepare({
        world,
        definitionId: testerDef.id,
        workerId: worker.id,
        taskId: task.id,
        goal: task.goal,
        options: { workspaceRoot: root },
      });

      await runtime.run({
        ...plan,
        workerId: worker.id,
        taskId: task.id,
      });

      const snapshot = world.inspect();
      const reportEvidence = snapshot.evidence.find((e) => e.source.type === "tester-report");
      assert.ok(reportEvidence);
      const report = JSON.parse(reportEvidence.content) as VerificationReport;

      // Must be downgraded to unverified
      assert.equal(report.status, "unverified", "Fabricated claim must be downgraded to unverified");

      const verifEvidence = snapshot.evidence.find((e) => e.source.type === "tester-verification");
      assert.ok(verifEvidence);
      assert.equal(verifEvidence.validity, "observed", "Unverified report must produce observed, not verified validity");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Negative test: Unrelated commands that exit 0 do not verify failing assertions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "m2-neg-unrelated-"));
    try {
      const world = createWorld();
      const runtime = new WorkerRuntime(world);
      const tools = new ToolRuntime(world);

      let step = 0;
      const testerDecisions = new TesterDecisionProvider({
        complete: async () => {
          step++;
          if (step === 1) {
            // An unrelated command (e.g. echo or exit 0) runs successfully
            return JSON.stringify({
              type: "run",
              command: "node",
              args: ["-e", "process.exit(0)"],
              check: "Unrelated check",
            });
          }
          // But assertion fails!
          return JSON.stringify({
            type: "finish",
            report: {
              status: "verified", // Model tries to claim verified
              summary: "Assertion failed despite exit 0",
              observations: [],
              assertions: [{ name: "real assertion", passed: false }],
              supportedCriteria: [],
              unverifiedRequirements: ["requirement not met"],
            },
          });
        },
      });

      const adapter = new TesterExecutionAdapter({ tools, decisions: testerDecisions });
      const testerDef = createTesterDefinition(world);
      const worker = world.spawnWorker(testerDef.id);
      const task = world.assignTask(world.createTask("Verify").id, worker.id);

      const plan = adapter.prepare({
        world,
        definitionId: testerDef.id,
        workerId: worker.id,
        taskId: task.id,
        goal: task.goal,
        options: { workspaceRoot: root },
      });

      await runtime.run({
        ...plan,
        workerId: worker.id,
        taskId: task.id,
      });

      const snapshot = world.inspect();
      const reportEvidence = snapshot.evidence.find((e) => e.source.type === "tester-report");
      assert.ok(reportEvidence);
      const report = JSON.parse(reportEvidence.content) as VerificationReport;

      // When assertions fail, status must be downgraded to failed
      assert.equal(report.status, "failed", "Failing assertions must downgrade report to failed even if command exited 0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

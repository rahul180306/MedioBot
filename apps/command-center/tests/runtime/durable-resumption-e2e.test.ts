import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskId } from "@mediobot-v2/domain";
import { startCommandCenter } from "../../src/server.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { ToolPermissionEngine } from "@mediobot-v2/tools";
import { createComposition } from "../../src/composition.ts";

class ResponseCapture extends Writable {
  statusCode = 200;
  output = "";
  onChunk?: () => void;
  writeHead(status: number) { this.statusCode = status; return this; }
  override _write(chunk: Buffer, _: BufferEncoding, callback: () => void) {
    this.output += chunk.toString();
    this.onChunk?.();
    callback();
  }
}

async function request(
  app: Awaited<ReturnType<typeof startCommandCenter>>,
  method: string,
  url: string,
  body?: unknown,
) {
  const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method, url, headers: {} });
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

function makeProvider(dbPath: string): { providerRepo: ProviderRepository; database: LocalDatabase } {
  const database = new LocalDatabase(dbPath);
  const providerRepo = new ProviderRepository(database.raw);
  providerRepo.save({ id: "default-first-provider", providerType: "custom", displayName: "First enabled model",
    connected: true, enabled: true, baseUrl: "http://unused.invalid", models: [{ id: "wrong-first-model", name: "Wrong first model",
      enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }] });
  providerRepo.save({
    id: "selected-provider",
    providerType: "custom",
    displayName: "Selected",
    connected: true,
    enabled: true,
    baseUrl: "http://unused.invalid",
    models: [{
      id: "selected-model",
      name: "Text engine",
      enabled: true,
      capabilities: { text: true, reasoning: true, vision: true, tools: false },
    }],
  });
  return { providerRepo, database };
}

test("PHASE 3 END-TO-END ACCEPTANCE: Real Multi-Step Coding Task, Crash Interruption, State Restoration, and Safe Resumption without Repeat Writes", { timeout: 30000 }, async (t) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "mediobot-phase3-resumption-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  const dbPath = path.join(tempDir, "mediobot.db");

  // Create initial workspace files
  const { mkdirSync } = await import("node:fs");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(path.join(workspaceRoot, "README.md"), "# Test Workspace\n", "utf8");
  writeFileSync(path.join(workspaceRoot, "component-a.ts"), "// component-a stub\n", "utf8");
  writeFileSync(path.join(workspaceRoot, "component-b.ts"), "// component-b stub\n", "utf8");

  const componentAPath = path.join(workspaceRoot, "component-a.ts");
  const componentBPath = path.join(workspaceRoot, "component-b.ts");

  t.after(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Track actions performed by Cody across stages
  const executedActions: string[] = [];
  let maestroDelegationDecisions = 0;
  let shouldInterrupt = true;
  let signalStep1Completed!: () => void;
  const step1CompletedPromise = new Promise<void>((r) => { signalStep1Completed = r; });

  // Decision sequence controller for real agent execution
  const codyModelHandler = async (data: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
    const history = (data.recentToolHistory as Array<{ action: string; result: string }>) ?? [];

    const hasReadA = history.some((h) => h.action.includes("component-a.ts") && h.action.includes("filesystem.read"));
    const hasWrittenA = history.some((h) => h.action.includes("component-a.ts") && h.action.includes("filesystem.write"));

    // Step 0: Read component-a.ts
    if (!hasReadA) {
      executedActions.push("read component-a.ts");
      return JSON.stringify({ type: "read", path: "component-a.ts" });
    }

    // Step 1: Write component-a.ts
    if (hasReadA && !hasWrittenA) {
      executedActions.push("write component-a.ts");
      return JSON.stringify({
        type: "write",
        path: "component-a.ts",
        content: "export const a = 1;\n",
      });
    }

    // Pause for crash interruption after Step 1 write is recorded
    if (shouldInterrupt && hasWrittenA) {
      signalStep1Completed();
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new Error("simulated process interruption")); return; }
        signal?.addEventListener("abort", () => reject(new Error("simulated process interruption")), { once: true });
      });
    }

    // Resumed steps:
    const hasReadB = history.some((h) => h.action.includes("component-b.ts") && h.action.includes("filesystem.read"));
    const hasWrittenB = history.some((h) => h.action.includes("component-b.ts") && h.action.includes("filesystem.write"));

    // Step 2: Read component-b.ts
    if (hasWrittenA && !hasReadB) {
      executedActions.push("read component-b.ts");
      return JSON.stringify({ type: "read", path: "component-b.ts" });
    }

    // Step 3: Write component-b.ts
    if (hasReadB && !hasWrittenB) {
      executedActions.push("write component-b.ts");
      return JSON.stringify({
        type: "write",
        path: "component-b.ts",
        content: "export const b = 2;\n",
      });
    }

    // Step 4: Run check command
    const hasRunCheck = history.some((h) => h.action.includes("terminal.execute node"));
    if (hasWrittenB && !hasRunCheck) {
      executedActions.push("run check");
      return JSON.stringify({
        type: "run",
        command: "node",
        args: ["-e", "process.exit(0)"],
        verification: "All unit checks pass",
      });
    }

    // Step 5: Finish task
    executedActions.push("finish");
    return JSON.stringify({
      type: "finish",
      summary: "Successfully implemented component-a and component-b with verified checks.",
    });
  };

  const maestroModelHandler = async (data: Record<string, unknown>): Promise<string> => {
    const availableIntents = (data.availableIntents as string[]) ?? [];
    // After resumed Cody work finishes, Maestro enters bounded final
    // synthesis and may only respond or request input. Keep the fixture valid
    // for both the initial delegation and the post-resumption decision.
    if (availableIntents.includes("respond") && availableIntents.includes("request_user_input")
      && !availableIntents.includes("delegate")) {
      const evidenceRefs = (data.relevantEvidence as Array<{ id?: string; source?: { type?: string }; validity?: string }> | undefined)
        ?.filter(evidence => evidence.id && ["coding-tool", "tester-verification"].includes(evidence.source?.type ?? "")
          && ["observed", "verified"].includes(evidence.validity ?? ""))
        .map(evidence => evidence.id!) ?? [];
      return JSON.stringify({ type: "respond", message: "Cody created both components and the check exited successfully.",
        basis: "project-evidence", evidenceRefs });
    }
    const assignable = (data.assignableDefinitionIds as string[]) ?? [];
    const available = (data.availableMediobots as Array<{ definitionId: string; role: string }>) ?? [];
    const cody = available.find((entry) => entry.role === "coding" && assignable.includes(entry.definitionId))
      ?? available.find((entry) => assignable.includes(entry.definitionId))
      ?? { definitionId: assignable[0]! };
    maestroDelegationDecisions++;
    return JSON.stringify({
      type: "delegate",
      definitionId: cody.definitionId,
      objective: "Create component-a.ts and component-b.ts and verify",
      relevantContextRefs: [],
      constraints: ["Preserve clean exports"],
      expectedOutcome: "Both components created and verified",
      evidenceExpectations: ["Observed code diffs"],
    });
  };

  // Setup ModelResolver connected to the shared SQLite database
  const { providerRepo, database: db1 } = makeProvider(dbPath);
  const resolvedModelIds: string[] = [];
  const resolver1 = new ModelResolver(providerRepo, {
    createClient: ({ modelId }) => ({
      complete: async ({ input, signal }: { input: string; signal?: AbortSignal }) => {
        resolvedModelIds.push(modelId);
        const data = JSON.parse(input) as Record<string, unknown>;
        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          return codyModelHandler(data, signal);
        }
        return maestroModelHandler(data);
      },
    }),
  });

  const permissionEngine1 = new ToolPermissionEngine({ defaultPolicy: { mode: "Approve for me" } });

  // Start Server Instance 1 (Pre-Crash)
  const app1 = await startCommandCenter({
    databasePath: dbPath,
    providerRepository: providerRepo,
    modelResolver: resolver1,
    defaultApprovalMode: "Approve for me",
    workspaceRoot,
    vite: false,
    listen: false,
  });

  // Open workspace
  await app1.workspaceManager.openWorkspace(workspaceRoot);

  // Submit the multi-step coding task
  const submitRes = await request(app1, "POST", "/api/tasks", {
    definitionId: app1.composition.maestroDefinitionId,
    goal: "Implement multi-step components A and B in workspace",
    modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" },
  });

  assert.equal(submitRes.status, 202);
  const taskId = submitRes.json.task.id as string;
  assert.ok(taskId, "Task must have a valid task ID");

  // Wait until Cody has executed Step 1 (writing component-a.ts)
  await step1CompletedPromise;
  assert.ok(statSync(componentAPath).isFile(), "component-a.ts must exist on disk prior to interruption");
  assert.equal(readFileSync(componentAPath, "utf8"), "export const a = 1;\n");
  const mtimeBeforeCrash = statSync(componentAPath).mtimeMs;

  // Graceful close records cancellation, so remove those shutdown-only terminal
  // records to model an abrupt process loss after the durable Cody checkpoint.
  // A real crash cannot persist a completed cancellation outcome or graph step.
  await app1.close();
  const childTaskId = (db1.raw.prepare("SELECT child_task_id FROM durable_task_delegations WHERE parent_task_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(taskId) as { child_task_id: string | null } | undefined)?.child_task_id;
  db1.raw.prepare("UPDATE durable_tasks SET status = 'interrupted', completed_at = NULL WHERE id = ?").run(taskId);
  if (childTaskId) {
    db1.raw.prepare("UPDATE durable_tasks SET status = 'interrupted', completed_at = NULL WHERE id = ?").run(childTaskId);
    db1.raw.prepare("UPDATE durable_task_delegations SET status = 'active' WHERE parent_task_id = ? AND child_task_id = ?")
      .run(taskId, childTaskId);
  }
  db1.raw.prepare("DELETE FROM langgraph_task_outcomes WHERE thread_id = ? AND workflow_name = 'maestro-specialist-groups'").run(taskId);
  db1.raw.prepare("DELETE FROM writes WHERE thread_id = ?").run(taskId);
  db1.raw.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(taskId);
  db1.close();
  shouldInterrupt = false;

  // Allow tiny pause to ensure filesystem mtime would advance if a subsequent rewrite happened
  await new Promise((r) => setTimeout(r, 100));

  // =========================================================================
  // RESTART MEDIOBOT: Start Server Instance 2 pointing to the SAME DB & Workspace
  // =========================================================================
  const { providerRepo: providerRepo2, database: db2 } = makeProvider(dbPath);
  const resolver2 = new ModelResolver(providerRepo2, {
    createClient: ({ modelId }) => ({
      complete: async ({ input }: { input: string }) => {
        resolvedModelIds.push(modelId);
        const data = JSON.parse(input) as Record<string, unknown>;
        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          return codyModelHandler(data);
        }
        return maestroModelHandler(data);
      },
    }),
  });

  const permissionEngine2 = new ToolPermissionEngine({ defaultPolicy: { mode: "Approve for me" } });

  const app2 = await startCommandCenter({
    databasePath: dbPath,
    providerRepository: providerRepo2,
    modelResolver: resolver2,
    defaultApprovalMode: "Approve for me",
    workspaceRoot,
    vite: false,
    listen: false,
  });

  t.after(async () => {
    try { await app2.close(); db2.close(); } catch {}
  });

  await app2.workspaceManager.openWorkspace(workspaceRoot);

  // =========================================================================
  // VERIFY RESTORED STATE (Phase 3 Requirement: State, Checkpoints, Delegations, Evidence)
  // =========================================================================
  const getTaskRes = await request(app2, "GET", `/api/tasks/${taskId}`);
  assert.equal(getTaskRes.status, 200);
  const restoredTask = getTaskRes.json.task;

  // 1. Task state must be reconciled to "interrupted" upon server restart
  assert.equal(restoredTask.state, "interrupted", "Reconciled task must be in interrupted state after server restart");
  assert.deepEqual(await app2.composition.durableTaskEngine!.getTaskModelSelection(taskId),
    { providerConnectionId: "selected-provider", modelId: "selected-model" }, "durable task retains its submitted model pair");

  // 2. Completed steps & checkpoints must be restored from SQLite
  assert.ok(Array.isArray(restoredTask.checkpoints), "Checkpoints list must be restored");
  assert.ok(restoredTask.checkpoints.length >= 1, "At least Checkpoint 1 must be restored");
  const chk1 = restoredTask.checkpoints[restoredTask.checkpoints.length - 1];
  assert.ok(chk1.snapshot.written.includes("component-a.ts"), "Restored checkpoint must contain component-a.ts in written files");

  // 3. Delegation history must be restored
  assert.ok(Array.isArray(restoredTask.delegations), "Delegations list must be restored");
  assert.ok(restoredTask.delegations.length >= 1, "Maestro delegation to Cody must be restored");
  assert.equal(restoredTask.delegations[0].assignedMediobotName, "Cody");

  // 4. Evidence must be restored
  assert.ok(Array.isArray(restoredTask.evidence), "Evidence records must be restored");
  const hasDiffEvidence = restoredTask.evidence.some(
    (e: any) => e.source?.reference === "component-a.ts" || e.content?.includes("component-a.ts")
  );
  assert.ok(hasDiffEvidence, "Evidence for component-a.ts modification must be restored from SQLite");

  // =========================================================================
  // RESUME EXECUTION (Phase 3 Requirement: Safe resumption without repeat writes)
  // =========================================================================
  const writesBeforeResume = executedActions.filter((a) => a === "write component-a.ts").length;
  assert.equal(writesBeforeResume, 1, "component-a.ts was written exactly once before interruption");

  // Trigger Resume API
  const resumeRes = await request(app2, "POST", `/api/tasks/${taskId}/resume`);
  assert.equal(resumeRes.status, 202);
  assert.equal(resumeRes.json.resumed, true);

  // Await completion of resumed task
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Resumed task timed out")), 15000);
    const interval = setInterval(async () => {
      const check = await request(app2, "GET", `/api/tasks/${taskId}`);
      if (check.json?.task?.state === "completed") {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      } else if (check.json?.task?.state === "failed") {
        clearTimeout(timeout);
        clearInterval(interval);
        reject(new Error(`Task failed: ${JSON.stringify(check.json.task.error)}`));
      }
    }, 100);
  });

  // Verify component-a.ts was NEVER re-written during resumption!
  const writesAfterResume = executedActions.filter((a) => a === "write component-a.ts").length;
  assert.equal(writesAfterResume, 1, "CRITICAL: component-a.ts must NOT be re-written during task resumption!");
  assert.ok(resolvedModelIds.length > 0);
  assert.ok(resolvedModelIds.every(modelId => modelId === "selected-model"),
    `resume must preserve the submitted model instead of selecting the first enabled model: ${resolvedModelIds.join(",")}`);
  assert.equal(maestroDelegationDecisions, 1,
    "restart must reuse the exact persisted assignment plan instead of asking Maestro to replan delegated work");
  const mtimeAfterResume = statSync(componentAPath).mtimeMs;
  assert.equal(mtimeAfterResume, mtimeBeforeCrash, "CRITICAL: component-a.ts mtime must be identical (not overwritten)");

  // Verify component-b.ts was written during resumption
  assert.ok(statSync(componentBPath).isFile(), "component-b.ts must be created during resumption");
  assert.equal(readFileSync(componentBPath, "utf8"), "export const b = 2;\n");

  // Verify final task status and evidence
  const finalTaskRes = await request(app2, "GET", `/api/tasks/${taskId}`);
  assert.equal(finalTaskRes.status, 200);
  const finalTask = finalTaskRes.json.task;
  assert.equal(finalTask.state, "completed", "Resumed task must reach completed state");

  // Verify checkpoints include later steps
  assert.ok(finalTask.checkpoints.length >= 2, "Checkpoints must include resumed steps");
  const finalCheckpoint = finalTask.checkpoints[finalTask.checkpoints.length - 1];
  assert.ok(finalCheckpoint.snapshot.written.includes("component-b.ts"), "Final checkpoint must include component-b.ts");

  // Verify verification evidence exists with validity: "verified"
  const verificationEvidence = finalTask.evidence.find((e: any) => e.validity === "verified");
  assert.ok(verificationEvidence, "Verified check evidence must be recorded on task");

  // Clean shutdown
  await app2.close();
  db2.close();
});

test("legacy interrupted task without saved or thread model fails closed instead of selecting the first enabled model", { timeout: 10_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-resume-model-required-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "mediobot.db");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(workspaceRoot, { recursive: true });
  const { providerRepo, database } = makeProvider(dbPath);
  let modelCalls = 0;
  const modelResolver = new ModelResolver(providerRepo, { createClient: () => ({ complete: async () => { modelCalls++; return "{}"; } }) });
  const app = await startCommandCenter({ databasePath: dbPath, providerRepository: providerRepo, modelResolver,
    workspaceRoot, vite: false, listen: false });
  t.after(async () => { try { await app.close(); database.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  await app.workspaceManager.openWorkspace(workspaceRoot);
  const engine = app.composition.durableTaskEngine!;
  const session = app.workspaceManager.session!;
  const { task } = await engine.submitTask({ goal: "Resume old task", definitionId: app.composition.maestroDefinitionId,
    workspaceId: session.workspaceId });
  await engine.startTask(task.id);
  await engine.reconcileOnStartup(session.workspaceId);
  const response = await request(app, "POST", `/api/tasks/${task.id}/resume`);
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, "model-selection-required");
  assert.equal(modelCalls, 0, "the server must not silently invoke an arbitrary configured model");
  const cancelled = await request(app, "POST", `/api/tasks/${task.id}/cancel`);
  assert.equal(cancelled.status, 202, JSON.stringify(cancelled.json));
  assert.equal((await engine.getTask(task.id))?.status, "cancelled",
    "a reconciled inactive task can be explicitly cancelled without selecting or invoking a model");
  assert.equal(modelCalls, 0);
  assert.equal((await request(app, "GET", `/api/tasks/${task.id}`)).json.task.state, "cancelled");
  assert.ok(cancelled.json.task.events.some((event: { type: string }) => event.type === "task.cancelled"),
    "the cancellation outcome remains visible in durable task history");
});

test("task resume refuses a different active workspace before model execution or state transition", { timeout: 10_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-resume-workspace-isolation-"));
  const workspaceA = path.join(root, "workspace-a");
  const workspaceB = path.join(root, "workspace-b");
  const dbPath = path.join(root, "mediobot.db");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  const { providerRepo, database } = makeProvider(dbPath);
  let modelCalls = 0;
  const modelResolver = new ModelResolver(providerRepo, { createClient: () => ({ complete: async () => {
    modelCalls++;
    return JSON.stringify({ type: "respond", message: "unexpected", basis: "conversation", evidenceRefs: [] });
  } }) });
  const app = await startCommandCenter({ databasePath: dbPath, providerRepository: providerRepo, modelResolver,
    workspaceRoot: workspaceA, vite: false, listen: false });
  t.after(async () => { try { await app.close(); database.close(); } catch {} rmSync(root, { recursive: true, force: true }); });

  const sessionA = app.workspaceManager.session!;
  const engine = app.composition.durableTaskEngine!;
  const { task } = await engine.submitTask({ goal: "Resume within workspace A", definitionId: app.composition.maestroDefinitionId,
    workspaceId: sessionA.workspaceId, modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  await engine.startTask(task.id);
  await engine.reconcileOnStartup(sessionA.workspaceId);
  await app.workspaceManager.openWorkspace(workspaceB);

  const response = await request(app, "POST", `/api/tasks/${task.id}/resume`);
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, "workspace-mismatch");

  const read = await request(app, "GET", `/api/tasks/${task.id}`);
  assert.equal(read.status, 404, "task details must not be disclosed from another active workspace");
  const events = await request(app, "GET", `/api/tasks/${task.id}/events`);
  assert.equal(events.status, 404, "event history must not be disclosed from another active workspace");
  const cancel = await request(app, "POST", `/api/tasks/${task.id}/cancel`);
  assert.equal(cancel.status, 404, "a task from another workspace must not be cancellable here");

  assert.equal((await engine.getTask(task.id))?.status, "interrupted", "rejected resume must not mutate durable task state");
  assert.equal(modelCalls, 0, "a cross-workspace resume must be rejected before any model request");
});

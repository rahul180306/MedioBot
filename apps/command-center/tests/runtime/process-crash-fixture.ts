import assert from "node:assert/strict";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { startCommandCenter } from "../../src/server.ts";

class ResponseCapture extends Writable {
  statusCode = 200;
  output = "";
  writeHead(status: number) { this.statusCode = status; return this; }
  override _write(chunk: Buffer, _: BufferEncoding, callback: () => void) {
    this.output += chunk.toString();
    callback();
  }
}

async function request(app: Awaited<ReturnType<typeof startCommandCenter>>, method: string, url: string, body?: unknown) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, url, headers: {} });
  const res = new ResponseCapture();
  const finished = new Promise<void>(resolve => res.once("finish", resolve));
  app.handle(req as never, res as never);
  await finished;
  let json: any;
  try { json = JSON.parse(res.output); } catch {}
  return { status: res.statusCode, json, text: res.output };
}

const mode = process.argv[2];
const databasePath = process.env.MEDIOBOT_CRASH_DB;
const workspaceRoot = process.env.MEDIOBOT_CRASH_WORKSPACE;
const taskId = process.env.MEDIOBOT_CRASH_TASK;
const approvalId = process.env.MEDIOBOT_CRASH_APPROVAL;
assert.ok(databasePath && workspaceRoot && ["interrupt", "resume", "approval-interrupt", "approval-resume", "terminal-interrupt", "terminal-resume"].includes(mode ?? ""));

async function main() {
  const database = new LocalDatabase(databasePath!);
  const repository = new ProviderRepository(database.raw);
  repository.save({ id: "crash-test-provider", providerType: "custom", displayName: "Deterministic crash fixture",
    connected: true, enabled: true, baseUrl: "http://unused.invalid", models: [{ id: "crash-test-model", name: "Fixture",
      enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }] });

  let announcedCrash = false;
  let resumedCodyDecisionCount = 0;
  const resolver = new ModelResolver(repository, { createClient: () => ({ complete: async ({ system, input }: { system: string; input: string }) => {
    if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
    const data = JSON.parse(input) as Record<string, any>;
    if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
      const history = data.recentToolHistory as Array<{ action: string; result: string }>;
      if (mode === "terminal-interrupt" || mode === "terminal-resume") {
        const effectsPath = process.env.MEDIOBOT_TERMINAL_EFFECTS;
        const pidPath = process.env.MEDIOBOT_TERMINAL_PID;
        assert.ok(effectsPath && pidPath);
        const command = `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(effectsPath)}, 'effect\\n'); fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setTimeout(()=>process.exit(0), 15000);`;
        return JSON.stringify({ type: "run", command: process.execPath, args: ["-e", command], verification: "execute the bounded recovery fixture" });
      }
      const hasReadSource = history.some(entry => entry.action.startsWith("filesystem.read source.txt") && entry.result.startsWith("file content"));
      const hasReadResult = history.some(entry => entry.action.startsWith("filesystem.read result.txt") && entry.result.startsWith("file content"));
      const writeEntry = history.find(entry => entry.action.startsWith("filesystem.write result.txt"));
      const hasSuccessfulWrite = Boolean(writeEntry && !/not executed|failed|cancelled/i.test(writeEntry.result));
      if (writeEntry && !hasSuccessfulWrite) throw new Error(`fixture write failed: ${writeEntry.result}`);
      if (!hasReadSource) return JSON.stringify({ type: "read", path: "source.txt" });
      if (!hasReadResult) return JSON.stringify({ type: "read", path: "result.txt" });
      if (!hasSuccessfulWrite) return JSON.stringify({ type: "write", path: "result.txt",
        content: mode === "approval-interrupt" || mode === "approval-resume"
          ? "approved source content\n" : "recovered from durable context\n" });
      if (mode === "interrupt" && !announcedCrash) {
        announcedCrash = true;
        process.stdout.write("READY_TO_CRASH\n");
        return await new Promise<string>(() => {});
      }
      const check = history.find(entry => entry.action.startsWith("terminal.execute "));
      if (!check) return JSON.stringify({ type: "run", command: process.execPath, args: ["-e", "process.exit(0)"], verification: "check command" });
      if (!/exitCode=0/i.test(check.result)) throw new Error(`fixture verification failed: ${check.result}`);
      resumedCodyDecisionCount += 1;
      return JSON.stringify({ type: "finish", summary: "The result file is present from the completed write." });
    }
    if (data.assignment && system.includes("Tester: critical independent review specialist")) {
      const callsPath = process.env.MEDIOBOT_TESTER_CALLS;
      if (callsPath) appendFileSync(callsPath, "tester-model-call\n");
      return JSON.stringify({ status: "completed", summary: "Tester confirmed the task has a clear acceptance condition.",
        evidence: ["The request names the source and expected result file."], blockers: [], unresolved: [] });
    }
    const intents = Array.isArray(data.availableIntents) ? data.availableIntents as string[] : [];
    if (intents.includes("respond") && intents.includes("request_user_input") && !intents.includes("delegate")) {
      const evidence = Array.isArray(data.relevantEvidence) ? data.relevantEvidence : [];
      const toolEvidence = evidence.filter((item: any) => item.source?.type === "coding-tool" && item.validity === "observed");
      assert.ok(toolEvidence.length > 0,
        "Maestro synthesis must receive the durable Cody tool outcome after process restart");
      return JSON.stringify({ type: "respond", message: "Cody completed the requested file operation; its durable tool result was restored after restart.",
        basis: "project-evidence", evidenceRefs: toolEvidence.map((item: any) => item.id) });
    }
    const cody = data.availableMediobots?.find((item: any) => item.role === "coding" && data.assignableDefinitionIds?.includes(item.definitionId));
    assert.ok(cody, "the coding specialist must be available to the normal Maestro decision");
      if (mode === "approval-interrupt" && intents.includes("delegate_text")) {
        const tester = data.availableMediobots?.find((item: any) => item.role === "tester" && data.assignableDefinitionIds?.includes(item.definitionId));
        assert.ok(tester, "the independent Tester must be assignable for the crash-recovery scenario");
        return JSON.stringify({ type: "delegate_text",
          independence: "Cody performs the user-authorized workspace change while Tester independently reviews its acceptance condition.",
          assignments: [
            { assignmentId: "approval-cody", definitionId: cody.definitionId,
              objective: "Read source.txt and update result.txt with its content after the required approval.",
              relevantContext: "The exact write requires user approval.", relevantContextRefs: [], constraints: [],
              expectedOutcome: "result.txt contains the source content after user approval.", evidenceExpectations: ["Observed approved file write"],
              requiredCapabilities: ["filesystem.read", "filesystem.write"] },
            { assignmentId: "approval-tester", definitionId: tester.definitionId,
              objective: "Independently review whether the requested file change has a clear acceptance condition.",
              relevantContext: "The request names source.txt and result.txt and requires the copied content.", relevantContextRefs: [], constraints: [],
              expectedOutcome: "A concise review of the acceptance condition.", evidenceExpectations: [] },
          ] });
      }
    return JSON.stringify({ type: "delegate", definitionId: cody.definitionId, objective: "Read source.txt and create result.txt with its recovered content.",
      relevantContextRefs: [], constraints: ["Use the authorized workspace tools."], expectedOutcome: "result.txt contains the requested result.", evidenceExpectations: ["Observed file operation"] });
  } }) });

  const app = await startCommandCenter({ databasePath: databasePath!, providerRepository: repository, modelResolver: resolver,
    workspaceRoot: workspaceRoot!, defaultApprovalMode: "Approve for me", vite: false, listen: false });
  await app.workspaceManager.openWorkspace(workspaceRoot!);
  try {
    if (mode === "terminal-interrupt") {
      const result = await request(app, "POST", "/api/turns", { threadId: "terminal-crash-thread", turnId: "terminal-crash-turn",
        prompt: "Run the bounded terminal recovery fixture once.",
        modelSelection: { providerConnectionId: "crash-test-provider", modelId: "crash-test-model" } });
      assert.equal(result.status, 202, JSON.stringify(result.json));
      process.stdout.write(`TASK_ID:${result.json.taskId}\nTERMINAL_READY\n`);
      await new Promise<void>(() => {});
      return;
    }

    if (mode === "interrupt") {
      const result = await request(app, "POST", "/api/turns", { threadId: "process-crash-thread", turnId: "process-crash-turn",
        prompt: "Read source.txt and create result.txt with the information it contains.",
        modelSelection: { providerConnectionId: "crash-test-provider", modelId: "crash-test-model" } });
      assert.equal(result.status, 202);
      assert.ok(result.json.taskId);
      process.stdout.write(`TASK_ID:${result.json.taskId}\n`);
      // The next Cody decision is requested only after its prior tool result and
      // checkpoint have been persisted. The parent test force-terminates here.
      await new Promise<void>(() => {});
      return;
    }

    if (mode === "approval-interrupt") {
      const result = await request(app, "POST", "/api/turns", { threadId: "process-approval-thread", turnId: "process-approval-turn",
        prompt: "Read source.txt, then update result.txt with its content. Ask for approval before writing.",
        modelSelection: { providerConnectionId: "crash-test-provider", modelId: "crash-test-model" }, approvalMode: "Ask before edits" });
      assert.equal(result.status, 202, JSON.stringify(result.json));
      const parentTaskId = result.json.taskId as string;
      const deadline = Date.now() + 12_000;
      let approval: { approval_id: string; task_id: string; interrupt_id: string | null } | undefined;
      while (Date.now() < deadline) {
        approval = database.raw.prepare(`SELECT a.approval_id, a.task_id, i.interrupt_id FROM durable_tool_approvals a
          LEFT JOIN durable_tool_approval_interrupts i USING (approval_id) WHERE a.status = 'requested'
          ORDER BY a.created_at DESC LIMIT 1`).get() as typeof approval;
        if (approval?.interrupt_id) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(approval?.interrupt_id, "Cody's exact tool approval must be linked to its persisted LangGraph interrupt");
      assert.notEqual(approval.task_id, parentTaskId, "the specialist child owns the pending tool approval");
      assert.equal((await app.composition.durableTaskEngine!.getTask(parentTaskId))?.status, "waiting_approval");
      assert.equal((await app.composition.durableTaskEngine!.getTask(approval.task_id))?.status, "waiting_approval");
      const durable = app.composition.durableTaskEngine!;
      const delegations = await durable.getDelegations(parentTaskId);
      const tester = delegations.find(entry => entry.assignedMediobotId === "tester");
      assert.ok(tester?.childTaskId, "the independent Tester child identity must be durable before process termination");
      assert.equal((await durable.getTask(tester.childTaskId))?.status, "completed",
        "the independent specialist should finish while Cody's approval remains pending");
      assert.ok((await durable.getEvidence(tester.childTaskId)).some(entry => entry.kind === "worker-report"),
        "the completed specialist's report must be durable before process termination");
      const productEvents = await app.composition.getTaskEvents!(parentTaskId as never);
      const codyStart = productEvents.find(event => event.type === "worker.started" && event.workerDefinitionId === "cody");
      const testerStart = productEvents.find(event => event.type === "worker.started" && event.workerDefinitionId === "tester");
      const testerComplete = productEvents.find(event => event.type === "worker.completed" && event.workerDefinitionId === "tester");
      assert.ok(codyStart && testerStart && testerComplete, "durable product events must attribute both starts and Tester completion");
      assert.ok(codyStart.sequence! < testerComplete.sequence! && testerStart.sequence! < testerComplete.sequence!,
        "ordered durable events must show Cody already active while the independent Tester runs and completes");
      assert.ok(!productEvents.some(event => event.workerDefinitionId === "cody"
        && ["worker.completed", "worker.failed", "worker.cancelled"].includes(event.type)
        && event.sequence! < testerComplete.sequence!),
      "Cody must remain active when Tester completes, proving real overlapping execution intervals");
      const testerCalls = readFileSync(`${workspaceRoot}/../tester-calls.txt`, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(testerCalls.length, 1, "the independent specialist must execute once before the restart");
      assert.equal(readFileSync(`${workspaceRoot}/result.txt`, "utf8"), "baseline\n");
      process.stdout.write(`TASK_ID:${parentTaskId}\nAPPROVAL_ID:${approval.approval_id}\nAPPROVAL_INTERRUPT:${approval.interrupt_id}\nAPPROVAL_READY\n`);
      await new Promise<void>(() => {});
      return;
    }

    if (mode === "approval-resume") {
      assert.ok(taskId && approvalId, "approval resume mode requires durable task and approval identities");
      const durable = app.composition.durableTaskEngine!;
      assert.equal((await durable.getTask(taskId))?.status, "waiting_approval",
        "restart must preserve the approval-waiting parent without marking it failed or auto-approving");
      const approval = database.raw.prepare(`SELECT task_id, status FROM durable_tool_approvals WHERE approval_id = ?`)
        .get(approvalId) as { task_id: string; status: string } | undefined;
      assert.equal(approval?.status, "requested", "restart must preserve the approval as pending");
      assert.equal(app.composition.permissionEngine!.getWorkflowInterruptId(approvalId),
        database.raw.prepare("SELECT interrupt_id FROM durable_tool_approval_interrupts WHERE approval_id = ?")
          .get(approvalId)?.interrupt_id,
        "startup must restore the durable approval-to-LangGraph-interrupt association");
      const response = await request(app, "POST",
        `/api/turns/process-approval-turn/approvals/${approvalId}?threadId=process-approval-thread`,
        { approved: true, threadId: "process-approval-thread" });
      assert.equal(response.status, 202, JSON.stringify(response.json));
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const current = await durable.getTask(taskId);
        if (current?.status === "completed") break;
        if (current?.status === "failed" || current?.status === "cancelled") {
          throw new Error(`Approval recovery ended ${current.status}: ${current.error?.message ?? ""}`);
        }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      assert.equal((await durable.getTask(taskId))?.status, "completed", "approved workflow must settle through /api/turns recovery");
      const childTaskId = approval.task_id;
      assert.equal((await durable.getTask(childTaskId))?.status, "completed", "Cody's child must finish after approval");
      assert.equal(readFileSync(`${workspaceRoot}/result.txt`, "utf8"), "approved source content\n");
      const evidence = await durable.getEvidence(childTaskId);
      const writes = evidence.filter(entry => entry.source?.type === "coding-tool" && entry.claim === "filesystem.write succeeded");
      assert.equal(writes.length, 1, "the exact approved filesystem side effect must have one durable successful invocation");
      assert.ok(writes[0].source.reference, "the approved write must retain its unique invocation id");
      assert.equal(database.raw.prepare("SELECT status FROM durable_tool_approvals WHERE approval_id = ?").get(approvalId)?.status,
        "consumed", "the approval is consumed exactly once after the resumed action");
      const tester = (await durable.getDelegations(taskId)).find(entry => entry.assignedMediobotId === "tester");
      assert.ok(tester?.childTaskId && (await durable.getTask(tester.childTaskId))?.status === "completed",
        "the completed independent specialist must remain completed after recovery");
      assert.equal(readFileSync(`${workspaceRoot}/../tester-calls.txt`, "utf8").trim().split("\n").filter(Boolean).length, 1,
        "completed independent specialist work must not execute again after process restart");
      process.stdout.write("APPROVAL_RESUME_ACCEPTED\n");
      return;
    }

    if (mode === "terminal-resume") {
      assert.ok(taskId, "terminal resume mode requires the interrupted task identity");
      const durable = app.composition.durableTaskEngine!;
      assert.equal((await durable.getTask(taskId!))?.status, "interrupted");
      const delegation = (await durable.getDelegations(taskId!)).find(entry => entry.childTaskId);
      assert.ok(delegation?.childTaskId, "the interrupted Cody assignment must retain its durable child identity");
      const response = await request(app, "POST", `/api/tasks/${taskId}/resume`);
      assert.equal(response.status, 202, JSON.stringify(response.json));
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (await durable.getTask(delegation.childTaskId!))?.status !== "failed") {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.equal((await durable.getTask(delegation.childTaskId!))?.status, "failed",
        "Cody must stop with an explicit blocker when the previous command outcome is ambiguous");
      const journal = await durable.getEvents(delegation.childTaskId!);
      const started = journal.filter(event => event.eventType === "tool.side_effect.started");
      const settled = journal.filter(event => event.eventType === "tool.side_effect.settled");
      assert.equal(started.length, 1, "restart must not create another terminal invocation start record");
      assert.equal(settled.length, 0, "the interrupted invocation must remain explicitly ambiguous");
      const events = await app.composition.getTaskEvents!(taskId as never);
      assert.ok(events.some(event => event.type === "tool.failed" && event.errorCode === "TERMINAL_OUTCOME_UNKNOWN"),
        "the product event stream must expose the truthful ambiguous-outcome failure");
      process.stdout.write("AMBIGUOUS_REPLAY_BLOCKED\n");
      return;
    }

    assert.ok(taskId, "resume mode requires the interrupted parent task ID");
    const toolPath = `${workspaceRoot}/result.txt`;
    const before = statSync(toolPath, { bigint: true }).mtimeNs.toString();
    assert.equal(readFileSync(toolPath, "utf8"), "recovered from durable context\n");
    const durable = app.composition.durableTaskEngine!;
    const parent = await durable.getTask(taskId!);
    assert.equal(parent?.status, "interrupted", "startup must reconcile the killed process as interrupted");
    const delegation = (await durable.getDelegations(taskId!)).find(entry => entry.childTaskId);
    assert.ok(delegation?.childTaskId, "the Cody child identity must survive process loss");
    const savedEvidence = await durable.getEvidence(delegation.childTaskId!);
    assert.ok(savedEvidence.some(entry => entry.source?.type === "coding-tool"), "Cody's tool result must be durable before resume");
    const savedCheckpoints = await durable.getCheckpoints(delegation.childTaskId!);
    const savedToolHistory = savedCheckpoints.flatMap(checkpoint => Array.isArray((checkpoint.snapshot as any)?.history)
      ? (checkpoint.snapshot as any).history : []);
    assert.ok(savedToolHistory.some((entry: any) => entry.action === "filesystem.write result.txt"),
      `the Cody checkpoint must preserve the completed write history; checkpoints=${JSON.stringify(savedCheckpoints.map(item => item.snapshot))}`);

    const recoveredThread = await request(app, "GET", `/api/threads/process-crash-thread`);
    assert.equal(recoveredThread.status, 200);
    assert.equal(recoveredThread.json.thread.turns.find((turn: any) => turn.id === "process-crash-turn")?.recoveryState,
      "interrupted", "the thread API must expose the durable interrupted state accurately");

    const resumed = await request(app, "POST", `/api/tasks/${taskId}/resume`);
    assert.equal(resumed.status, 202);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await durable.getTask(taskId!);
      if (current?.status === "completed") break;
      if (current?.status === "failed" || current?.status === "cancelled") throw new Error(`Resume ended ${current.status}: ${current.error?.message ?? ""}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await durable.getTask(taskId!))?.status, "completed", "resumed task must complete through the normal application path");
    const finalEvidence = await durable.getEvidence(delegation.childTaskId!);
    const completedWrites = finalEvidence.filter(entry => entry.source?.type === "coding-tool"
      && entry.claim === "filesystem.write succeeded");
    assert.equal(completedWrites.length, 1,
      "the completed filesystem write must have exactly one durable tool result after recovery");
    assert.ok(completedWrites[0].source.reference,
      "the completed write must retain its unique tool invocation reference");
    assert.equal(statSync(toolPath, { bigint: true }).mtimeNs.toString(), before,
      "the completed filesystem side effect must retain its original timestamp after process loss");
    assert.ok(resumedCodyDecisionCount >= 1, "Cody must continue its assignment after recovery");
    process.stdout.write("PROCESS_RESUME_ACCEPTED\n");
  } finally {
    await app.close();
    database.close();
  }
}

await main();

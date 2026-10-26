import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { DurableTaskEngine, WorkerRuntime } from "@mediobot-v2/runtime";
import { ToolRuntime } from "@mediobot-v2/tools";
import { CodyDecisionProvider } from "@mediobot-v2/cody";
import { createMaestroCodyExecution, MaestroDecisionProvider, SpecialistCommunicationHub, validateMaestroDecision,
  resolveDurableChildModelSelection } from "../src/index.ts";
import { LocalDatabase } from "../../../apps/command-center/src/storage/db.ts";
import { SqliteDurableTaskStore } from "../../../apps/command-center/src/storage/durableTaskStore.ts";
import type { MediobotDefinitionId, TaskId } from "@mediobot-v2/domain";

async function setup(t: { after(fn: () => void): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-live-collaboration-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "readme.md"), "controlled collaboration fixture\n");
  let db = new LocalDatabase(path.join(root, "mediobot.db"));
  const engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.raw));
  t.after(() => { try { db.close(); } catch {} void rm(root, { recursive: true, force: true }); });
  return { root, workspace, engine, closeDb: () => db.close(), reopenDb: () => { db = new LocalDatabase(path.join(root, "mediobot.db")); return new DurableTaskEngine(new SqliteDurableTaskStore(db.raw)); } };
}

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test("durable Cody child recovery preserves its saved model despite a changed parent selection", () => {
  const saved = { providerConnectionId: "specialist-provider", modelId: "specialist-model" };
  const changedParent = { providerConnectionId: "parent-provider", modelId: "parent-model" };
  assert.deepEqual(resolveDurableChildModelSelection({ childExists: true, savedSelection: saved, parentSelection: changedParent }), saved);
  assert.deepEqual(resolveDurableChildModelSelection({ childExists: false, parentSelection: changedParent }), changedParent);
  assert.deepEqual(resolveDurableChildModelSelection({ childExists: false, assignmentOverride: saved, parentSelection: changedParent }), saved);
});

test("parent cancellation aborts an in-flight Cody model request and a concurrent text specialist before settlement", { timeout: 5_000 }, async t => {
  const temp = await setup(t);
  const world = createWorld();
  const runtime = new WorkerRuntime(world, { maxConcurrentExecutions: 4 });
  const codyEntered = gate();
  let codyAborted = false; let codyCalls = 0;
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: "maestro", name: "Maestro", role: "orchestration", version: "1", instructions: "Supervise." },
    durableTaskEngine: temp.engine,
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: "fixture", modelId: "fixture" }, client: { complete: async () => "{}" } }; } },
    codyDecisions: new CodyDecisionProvider({ complete: async ({ signal }) => {
      codyCalls += 1;
      if (codyCalls === 1) return JSON.stringify({ type: "list", path: "." });
      codyEntered.resolve();
      return new Promise<string>((_resolve, reject) => {
        const abort = () => { codyAborted = true; reject(new Error("controlled model request aborted")); };
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
    } }),
    maestroDecisions: new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: "respond", message: "not expected", basis: "conversation", evidenceRefs: [] }) }),
  });
  const codyId = execution.codyDefinitionId;
  const docId = "cody-test-specialist" as typeof codyId;
  world.registerMediobotDefinition({ id: docId, name: "Doc", role: "doc", version: "1", instructions: "Analyze.", declaredCapabilities: [] });
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const parent = world.assignTask(world.createTask("Cancel active specialists").id, worker.id);
  const decision = { type: "delegate" as const, definitionId: codyId, objective: "Inspect the workspace.",
    relevantContextRefs: [], constraints: [], expectedOutcome: "Inspect files", evidenceExpectations: [], requiredCapabilities: ["agent.message"] };
  const diagnostic: unknown[] = [];
  await temp.engine.submitTask({ id: parent.id, workspaceId: "workspace", threadId: "thread", goal: parent.goal, definitionId: execution.maestroDefinitionId });
  await temp.engine.startTask(parent.id);
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: parent.id,
    goal: parent.goal, options: { workspaceRoot: temp.workspace, threadId: "thread", workspaceId: "workspace", durableTaskEngine: temp.engine, maestroDecision: decision } });
  const running = runtime.run({ ...plan, taskId: parent.id, workerId: worker.id });
  await codyEntered.promise;
  const cancelRequestedAt = Date.now();
  runtime.cancel(parent.id);
  assert.deepEqual(await running, { state: "cancelled" });
  const settledAt = Date.now();
  assert.equal(codyAborted, true, "Maestro abort reaches the nested Cody model request");
  assert.deepEqual(runtime.activeTaskIds(), [], "parent and specialist WorkerRuntime runs settle");
  assert.ok(settledAt - cancelRequestedAt < 500, `controlled requests settle promptly (${settledAt - cancelRequestedAt}ms)`);
  assert.ok(world.inspect().events.some(event => event.type === "task.cancelled" && event.taskId === parent.id));
});

test("shared group finding is delivered live to Cody, then active specialists continue tool work and Maestro synthesis", { timeout: 12_000 }, async t => {
  const temp = await setup(t);
  const world = createWorld();
  const runtime = new WorkerRuntime(world, { maxConcurrentExecutions: 4 });
  const events: Array<{ status: string; sender: string; recipient: string; kind?: string; scope?: string; at: number }> = [];
  let requestSent!: () => void;
  const sent = new Promise<void>(resolve => { requestSent = resolve; });
  let codySendCount = 0;
  let docStartedAt = 0;
  let docCompletedAt = 0;
  let codyStartedAt = 0;
  let codyCompletedAt = 0;
  let codyStep = 0;
  const codyActions: string[] = [];
  const codyHistory: string[] = [];
  let finalInput = "";
  let finalResponse = "";
  let docFindingConsumed = false;
  let docReportCalls = 0;
  let codyId = "";
  let docId = "";
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: "maestro", name: "Maestro", role: "orchestration", version: "1", instructions: "Supervise assigned specialists." },
    durableTaskEngine: temp.engine,
    onUserMessage(message) { finalResponse = message; },
    onSpecialistMessageEvent(event) {
      events.push({ status: event.status, sender: event.senderSpecialistId, recipient: event.recipientSpecialistId,
        kind: event.messageKind, scope: event.scope, at: Date.now() });
      if (event.status === "sent" && event.senderSpecialistId === codyId) {
        if (codySendCount++ === 0) requestSent();
      }
    },
    maestroDecisions: new MaestroDecisionProvider({ complete: async ({ input }) => {
      finalInput = input;
      return JSON.stringify({ type: "respond", message: "I cannot coordinate Cody and Doc because available intents only include respond and request_user_input; delegation is not permitted.", basis: "conversation", evidenceRefs: [] });
    } }),
    codyDecisions: new CodyDecisionProvider({ complete: async ({ input }) => {
      codyStartedAt ||= Date.now();
      const parsed = JSON.parse(input) as { goal: string; recentToolHistory: Array<{ action: string; result: string }> };
      const step = codyStep++;
      codyHistory.push(...parsed.recentToolHistory.map(entry => `${entry.action}: ${entry.result}`));
      if (step === 0) {
        assert.match(parsed.goal, new RegExp(`Doc \\(${docId}\\)`));
        assert.match(parsed.goal, /active shared group is available/);
        const action = { type: "share_finding", recipientSpecialistId: docId, finding: "CODY_LIVE_FINDING: local client sends X-API-Version." };
        codyActions.push(action.type);
        return JSON.stringify(action);
      }
      if (step === 1) { codyActions.push("request_specialist"); return JSON.stringify({ type: "request_specialist", recipientSpecialistId: docId, request: "What is the documented API behavior?" }); }
      if (parsed.recentToolHistory.some(entry => entry.result.includes("DOC_LIVE_API_FINDING"))
        && parsed.recentToolHistory.some(entry => entry.action.startsWith("filesystem.list"))) {
        if (codyHistory.some(entry => entry.includes("DOC_GROUP_FINDING"))) {
          return JSON.stringify({ type: "finish", summary: "Cody incorporated DOC_LIVE_API_FINDING and DOC_GROUP_FINDING, then inspected the workspace." });
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return JSON.stringify({ type: "list", path: "." });
    } }) as never,
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: "fixture", modelId: "fixture" }, client: { complete: async ({ system, input }) => {
      if (system.includes("Answer one bounded request")) return "DOC_LIVE_API_FINDING: v3 requests require an explicit version header.";
      if (system.includes("requires one model-authored group finding")) {
        return JSON.stringify({ status: "completed", summary: "Doc's bounded report is unchanged.", evidence: ["fixture context"], blockers: [], unresolved: [],
          groupMessages: [{ kind: "finding", content: "DOC_GROUP_FINDING: documentation requires an explicit API version header.", evidenceRefs: [] }] });
      }
      if (system.includes("Update the existing report")) {
        const revisedInput = JSON.parse(input) as { peerFindings: Array<{ text: string }> };
        docFindingConsumed = revisedInput.peerFindings.some(finding => finding.text.includes("CODY_LIVE_FINDING"));
        return JSON.stringify({ status: "completed", summary: "Doc incorporated Cody's attributed client finding.",
          evidence: ["Cody reports X-API-Version in the local client; not independently verified."], blockers: [], unresolved: [] });
      }
      assert.match(system, /include that finding in groupMessages, not messages/);
      assert.equal((JSON.parse(input) as { sharedGroup: { available: boolean } }).sharedGroup.available, true);
      assert.equal((JSON.parse(input) as { sharedGroup: { requiredFinding: boolean } }).sharedGroup.requiredFinding, true);
      docReportCalls += 1;
      docStartedAt ||= Date.now();
      await sent;
      await new Promise(resolve => setTimeout(resolve, 180));
      docCompletedAt = Date.now();
      return JSON.stringify({ status: "completed", summary: "Doc checked the supplied documentation context.", evidence: ["fixture context"], blockers: [], unresolved: [],
        messages: [{ recipientSpecialistId: codyId, finding: "DOC_POST_FINDING: documentation specifies an explicit version header." }] });
    } } }; } },
  });
  codyId = execution.codyDefinitionId;
  docId = world.inspect().definitions.find(definition => definition.role === "doc")!.id;
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const rootTask = world.assignTask(world.createTask("Investigate API behavior with two specialists").id, worker.id);
  const decision = { type: "delegate_text", independence: "Cody inspects the workspace while Doc independently checks supplied API context.", assignments: [
        { definitionId: codyId, objective: "Inspect the workspace and ask Doc about the API header.", relevantContext: "Check the repository fixture.", relevantContextRefs: [], constraints: [], expectedOutcome: "Report workspace inspection and API guidance", evidenceExpectations: [], requiredCapabilities: ["agent.message"] },
    { definitionId: docId, objective: "Check the supplied API context, publish a group finding, and answer a peer request.", relevantContext: "The task is about an API version header.", relevantContextRefs: [], constraints: [], expectedOutcome: "Provide concise API guidance", evidenceExpectations: [], requiredCapabilities: [] },
  ] };
  validateMaestroDecision(decision, { availableIntents: ["delegate_text"], assignableDefinitionIds: [codyId, docId] });
  await temp.engine.submitTask({ id: rootTask.id, workspaceId: "workspace-1", threadId: "thread-1", goal: rootTask.goal, definitionId: execution.maestroDefinitionId });
  await temp.engine.startTask(rootTask.id);
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: rootTask.id,
    goal: rootTask.goal, options: { workspaceRoot: temp.workspace, threadId: "thread-1", workspaceId: "workspace-1",
      maestroDecision: decision } });
  const result = await runtime.run({ ...plan, taskId: rootTask.id, workerId: worker.id });
  codyCompletedAt = Date.now();
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.ok(events.some(event => event.status === "sent" && event.sender === codyId && event.recipient === docId));
  assert.ok(events.some(event => event.status === "delivered" && event.sender === codyId && event.recipient === docId), JSON.stringify(events));
  assert.ok(events.some(event => event.status === "sent" && event.sender === docId && event.recipient === codyId));
  assert.ok(events.some(event => event.status === "delivered" && event.sender === docId && event.recipient === codyId));
  assert.ok(docStartedAt < events.find(event => event.status === "delivered" && event.sender === codyId)!.at,
    "Doc received the request while its assignment was active");
  assert.ok(events.find(event => event.status === "delivered" && event.sender === codyId)!.at < docCompletedAt,
    "Doc responded before its assignment finished");
  assert.ok(codyStartedAt < docCompletedAt && docStartedAt < codyCompletedAt, "Cody and Doc assignment intervals overlap");
  assert.match(finalInput, /Cody incorporated DOC_LIVE_API_FINDING and DOC_GROUP_FINDING/);
  assert.match(finalInput, /bounded-execution-state/);
  assert.match(finalInput, /intentScope/);
  const codyWorker = world.inspect().workers.find(candidate => candidate.definitionId === codyId)!;
  assert.ok(world.inspect().events.some(event => event.workerId === codyWorker.id && event.type === "tool.started" && event.toolName === "filesystem.list"),
    "Cody retains the existing workspace tool path while communicating");
  const durableParent = await temp.engine.getTask(rootTask.id);
  assert.equal(durableParent?.status, "running");
  const completedCodyDelegation = (await temp.engine.getDelegations(rootTask.id)).find(entry => entry.assignedMediobotId === codyId && entry.childTaskId);
  assert.ok(completedCodyDelegation?.childTaskId);
  assert.equal((await temp.engine.getTask(completedCodyDelegation.childTaskId!))?.status, "completed");
  assert.equal(completedCodyDelegation.status, "completed");
  const codyAccess = await temp.engine.authorizeSpecialistSessionScope(rootTask.id, codyId);
  const docAccess = await temp.engine.authorizeSpecialistSessionScope(rootTask.id, docId);
  const codyInbox = await temp.engine.getSpecialistMessages(codyAccess);
  const docInbox = await temp.engine.getSpecialistMessages(docAccess);
  assert.deepEqual(codyActions.slice(0, 2), ["share_finding", "request_specialist"]);
  assert.ok(codyHistory.some(entry => entry.includes("Finding delivered to the authorized specialist inbox.")));
  assert.equal(codyInbox.length, 2);
  assert.equal(docInbox.length, 2);
  assert.equal(docInbox.some(message => JSON.parse(message.content).kind === "request"), true);
  assert.equal(docInbox.some(message => JSON.parse(message.content).text.includes("CODY_LIVE_FINDING")), true);
  assert.equal(codyInbox.some(message => JSON.parse(message.content).text.includes("DOC_LIVE_API_FINDING")), true);
  assert.equal(codyInbox.some(message => JSON.parse(message.content).text.includes("DOC_POST_FINDING")), true);
  assert.ok(codyHistory.some(entry => entry.includes("DOC_POST_FINDING")), "Cody receives Doc's finding before its next decision");
  assert.ok(codyHistory.some(entry => entry.includes("DOC_GROUP_FINDING")), "Cody consumes Doc's shared group finding during active execution");
  const groupDelivery = events.find(event => event.scope === "group" && event.status === "delivered" && event.sender === docId && event.recipient === codyId);
  assert.ok(groupDelivery && codyStartedAt < groupDelivery.at && groupDelivery.at < codyCompletedAt,
    `existing worker progress events identify live group delivery while Cody is still active: ${JSON.stringify({ groupDelivery, codyStartedAt, codyCompletedAt, events })}`);
  assert.ok(codyInbox.every(message => message.deliveryStatus === "delivered"));
  assert.ok(docInbox.every(message => message.deliveryStatus === "delivered"));
  assert.equal(docFindingConsumed, true, "Doc's active assignment consumes a live finding in its bounded report refresh");
  assert.equal(docReportCalls, 1, "the original model report is requested once; the missing group finding uses a separate bounded repair call");
  const codyGroupAccess = await temp.engine.authorizeSpecialistSessionScope(rootTask.id, codyId);
  await temp.engine.completeTask(rootTask.id);
  const persistedGroup = await temp.engine.getCollaborationGroup(codyGroupAccess, `group-${rootTask.id}`);
  assert.ok(persistedGroup);
  assert.equal(persistedGroup.status, "completed");
  assert.ok((await temp.engine.getEvents(rootTask.id)).some(event => event.eventType === "collaboration.group.message.appended"));
  assert.match(finalInput, /DOC_GROUP_FINDING/);
  assert.match(finalResponse, /conflicted with recorded execution evidence/);
  assert.doesNotMatch(finalResponse, /cannot coordinate Cody and Doc/i);
  assert.match(finalResponse, /DOC_GROUP_FINDING/);
  assert.match(finalResponse, /DOC_LIVE_API_FINDING/);
  t.diagnostic(JSON.stringify({ exchange: "Doc-group->Cody", messages: 5, findingConsumed: true, liveDelivery: true,
    docActiveMs: docCompletedAt - docStartedAt, codyActiveMs: codyCompletedAt - codyStartedAt,
    intervalOverlapMs: Math.min(docCompletedAt, codyCompletedAt) - Math.max(docStartedAt, codyStartedAt),
    codyToolPreserved: true, synthesized: /Cody incorporated DOC_LIVE_API_FINDING/.test(finalInput) }));
});

test("LangGraph group execution terminalizes failed Cody children and preserves successful sibling findings", { timeout: 12_000 }, async t => {
  const temp = await setup(t);
  const world = createWorld();
  const runtime = new WorkerRuntime(world, { maxConcurrentExecutions: 4 });
  let synthesisInput = "";
  let synthesisResponse = "";
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: "maestro", name: "Maestro", role: "orchestration", version: "1", instructions: "Supervise assignments." },
    durableTaskEngine: temp.engine,
    onUserMessage(message) { synthesisResponse = message; },
    maestroDecisions: new MaestroDecisionProvider({ complete: async ({ input }) => {
      synthesisInput = input;
      return JSON.stringify({ type: "respond", message: "Cody's assignment failed, while Doc's evidence is retained. Delegation to Tester was unavailable.", basis: "conversation", evidenceRefs: [] });
    } }),
    codyDecisions: new CodyDecisionProvider({ complete: async () => { throw new Error("controlled Cody model failure"); } }),
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: "fixture", modelId: "fixture" }, client: { complete: async () => JSON.stringify({
      status: "completed", summary: "DOC_SIBLING_SURVIVED: official reference was reviewed.", evidence: ["DOC_SIBLING_EVIDENCE"], blockers: [], unresolved: [],
    }) } }; } },
  });
  const codyId = execution.codyDefinitionId;
  const docId = world.inspect().definitions.find(definition => definition.role === "doc")!.id;
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const parent = world.assignTask(world.createTask("Verify independent group failure isolation").id, worker.id);
  await temp.engine.submitTask({ id: parent.id, workspaceId: "workspace-failure", threadId: "thread-failure", goal: parent.goal,
    definitionId: execution.maestroDefinitionId });
  await temp.engine.startTask(parent.id);
  const decision = { type: "delegate_text" as const, independence: "Cody and Doc perform independent assignments.", assignments: [
    { definitionId: codyId, objective: "Inspect code for the assigned issue", relevantContext: "Bounded fixture.", relevantContextRefs: [],
      constraints: [], expectedOutcome: "Inspection outcome", evidenceExpectations: [], requiredCapabilities: ["agent.message"] },
    { definitionId: docId, objective: "Summarize the supplied official reference", relevantContext: "Official reference content is supplied.", relevantContextRefs: [],
      constraints: [], expectedOutcome: "Evidence-backed summary", evidenceExpectations: [] },
  ] };
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: parent.id,
    goal: parent.goal, options: { workspaceRoot: temp.workspace, threadId: "thread-failure", workspaceId: "workspace-failure",
      assignmentModelSelections: { [codyId]: { providerConnectionId: "cody-provider", modelId: "cody-model" } },
      maestroDecision: decision } });
  const result = await runtime.run({ ...plan, taskId: parent.id, workerId: worker.id });
  assert.equal(result.state, "completed", JSON.stringify(result));
  const delegations = await temp.engine.getDelegations(parent.id);
  const codyDelegation = delegations.find(entry => entry.assignedMediobotId === codyId && entry.childTaskId);
  assert.ok(codyDelegation?.childTaskId, "failed Cody assignment retains its durable child identity");
  assert.equal((await temp.engine.getTask(codyDelegation.childTaskId!))?.status, "failed");
  assert.deepEqual(await temp.engine.getTaskModelSelection(codyDelegation.childTaskId!),
    { providerConnectionId: "cody-provider", modelId: "cody-model" }, "specialist override is persisted on the child task");
  assert.equal(codyDelegation.status, "failed");
  assert.ok((await temp.engine.getEvents(codyDelegation.childTaskId!)).some(event => event.eventType === "task.state_changed"
    && event.payload.toState === "failed"), "durable child event stream records the failure");
  assert.match(synthesisInput, /DOC_SIBLING_SURVIVED/);
  assert.match(synthesisInput, /Cody did not complete the assignment|controlled Cody model failure/);
  assert.match(synthesisResponse, /Delegation to Tester was unavailable/,
    "a specialist-specific limitation remains a valid partial-result statement");
  assert.doesNotMatch(synthesisResponse, /conflicted with recorded execution evidence/);
  assert.ok(delegations.some(entry => entry.assignedMediobotId === docId && entry.status === "completed"),
    "the successful sibling delegation is retained independently");
  t.diagnostic(JSON.stringify({ codyChild: "failed", codyDelegation: codyDelegation.status,
    docDelegation: "completed", siblingFindingPreserved: synthesisInput.includes("DOC_SIBLING_SURVIVED"), synthesized: true }));
});

test("communication scope rejects unauthorized peers, repeated/circular requests, and enforces cancellation and timeout bounds", { timeout: 8_000 }, async t => {
  const temp = await setup(t);
  const parentId = "parent-collaboration" as TaskId;
  await temp.engine.submitTask({ id: parentId, workspaceId: "workspace", threadId: "thread", goal: "bounded messaging", definitionId: "maestro" });
  await temp.engine.startTask(parentId);
  const cody = "cody" as MediobotDefinitionId;
  const doc = "doc" as MediobotDefinitionId;
  const other = "other" as MediobotDefinitionId;
  const hub = await SpecialistCommunicationHub.create(temp.engine, parentId, [cody, doc], undefined, new Map([[cody, "Cody"], [doc, "Doc"]]));
  assert.ok(hub);
  assert.throws(() => hub.open(other, parentId, "worker-other" as never), /not authorized/i);
  const codyPort = hub.open(cody, parentId, "worker-cody" as never);
  const docPort = hub.open(doc, parentId, "worker-doc" as never);
  await assert.rejects(codyPort.sendFinding(other, "Unauthorized"), /authorized/i);
  const controller = new AbortController();
  const request = codyPort.sendRequest(doc, "Find the official version header.", controller.signal);
  let incoming = await docPort.receive(controller.signal);
  for (let attempt = 0; incoming.length === 0 && attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
    incoming = await docPort.receive(controller.signal);
  }
  assert.equal(incoming[0]?.payload.kind, "request");
  await assert.rejects(docPort.sendRequest(cody, "Now ask Cody to ask me again.", controller.signal), /depth limit/i);
  await docPort.respond(incoming[0]!.record, "Use X-API-Version.");
  const answer = await request;
  assert.equal(answer, "Use X-API-Version.");
  await assert.rejects(codyPort.sendRequest(doc, "Find the official version header.", controller.signal), /Repeated/i);
  assert.equal(await codyPort.sendRequest(doc, "Confirm whether the header is required in v3.", controller.signal), undefined,
    "a second distinct request remains bounded by the existing response timeout");
  await assert.rejects(codyPort.sendRequest(doc, "Check one more detail.", controller.signal), /request budget exhausted/i,
    "sequentially rephrased requests cannot form an unproductive loop");
  await hub.close();

  const timeoutParentId = "timeout-collaboration" as TaskId;
  await temp.engine.submitTask({ id: timeoutParentId, workspaceId: "workspace", threadId: "thread", goal: "bounded timeout", definitionId: "maestro" });
  await temp.engine.startTask(timeoutParentId);
  const timeoutHub = await SpecialistCommunicationHub.create(temp.engine, timeoutParentId, [cody, doc]);
  assert.ok(timeoutHub);
  const timeoutPort = timeoutHub.open(cody, parentId, "worker-timeout" as never);
  const timed = await timeoutPort.sendRequest(doc, "A request with no running recipient.", controller.signal);
  assert.equal(timed, undefined, "unavailable response resolves at the fixed two-second bound");
  assert.ok((await temp.engine.getEvents(timeoutParentId)).some(event => event.eventType === "specialist.message.request_timeout"),
    "timeout is durably recorded for recovery");
  await timeoutHub.close();

  const retryParent = "retry-collaboration" as TaskId;
  await temp.engine.submitTask({ id: retryParent, workspaceId: "workspace", threadId: "thread", goal: "retry inbox writes", definitionId: "maestro" });
  await temp.engine.startTask(retryParent);
  let failDeliveryUpdate = true;
  const retryEngine = new Proxy(temp.engine, { get(target, property) {
    if (property === "updateSpecialistMessageStatus") return async (...args: Parameters<DurableTaskEngine["updateSpecialistMessageStatus"]>) => {
      if (failDeliveryUpdate) { failDeliveryUpdate = false; throw new Error("temporary SQLite busy"); }
      return target.updateSpecialistMessageStatus(...args);
    };
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } }) as DurableTaskEngine;
  const retryHub = await SpecialistCommunicationHub.create(retryEngine, retryParent, [cody, doc]);
  assert.ok(retryHub);
  const retryCody = retryHub.open(cody, retryParent, "worker-retry-cody" as never);
  const retryDoc = retryHub.open(doc, retryParent, "worker-retry-doc" as never);
  await retryCody.sendFinding(doc, "Retry this delivery once.");
  await assert.rejects(retryDoc.receive(controller.signal), /temporary SQLite busy/);
  const retried = await retryDoc.receive(controller.signal);
  assert.equal(retried.length, 1, "a transient delivery-status error does not advance the inbox cursor");
  assert.equal(retried[0]?.payload.text, "Retry this delivery once.");
  await retryHub.close();

  const cancelParentId = "cancel-collaboration" as TaskId;
  await temp.engine.submitTask({ id: cancelParentId, workspaceId: "workspace", threadId: "thread", goal: "cancel pending request", definitionId: "maestro" });
  await temp.engine.startTask(cancelParentId);
  const cancelHub = await SpecialistCommunicationHub.create(temp.engine, cancelParentId, [cody, doc]);
  assert.ok(cancelHub);
  const cancelPort = cancelHub.open(cody, cancelParentId, "worker-cancel" as never);
  const cancelledDoc = await temp.engine.authorizeSpecialistSessionScope(cancelParentId, doc);
  const cancellation = new AbortController();
  const waiting = cancelPort.sendRequest(doc, "Cancel while waiting.", cancellation.signal);
  setTimeout(() => cancellation.abort(new Error("cancelled by test")), 50).unref();
  await assert.rejects(waiting, /cancelled by test/i);
  await temp.engine.cancelTask(cancelParentId);
  await cancelHub.close("cancelled");
  assert.ok((await temp.engine.getSpecialistMessages(cancelledDoc)).some(message => message.deliveryStatus === "cancelled"));
  assert.equal(await SpecialistCommunicationHub.create(temp.engine, cancelParentId, [cody, doc]), undefined,
    "a cancelled parent task cannot reopen its specialist communication scope");

  const budgetParent = "budget-collaboration" as TaskId;
  await temp.engine.submitTask({ id: budgetParent, workspaceId: "workspace", threadId: "thread", goal: "message budget", definitionId: "maestro" });
  await temp.engine.startTask(budgetParent);
  const budgetHub = await SpecialistCommunicationHub.create(temp.engine, budgetParent, [cody, doc]);
  assert.ok(budgetHub);
  const budgetCody = budgetHub.open(cody, budgetParent, "worker-budget-cody" as never);
  const budgetDoc = budgetHub.open(doc, budgetParent, "worker-budget-doc" as never);
  for (let index = 0; index < 6; index += 1) await budgetCody.sendFinding(doc, `Cody finding ${index}`);
  for (let index = 0; index < 6; index += 1) await budgetDoc.sendFinding(cody, `Doc finding ${index}`);
  await assert.rejects(budgetDoc.sendFinding(cody, "The thirteenth message is denied."), /budget exhausted/i);
  await budgetHub.close();

  const restartParent = "restart-collaboration" as TaskId;
  await temp.engine.submitTask({ id: restartParent, workspaceId: "workspace", threadId: "thread", goal: "restart delivery", definitionId: "maestro" });
  await temp.engine.startTask(restartParent);
  const beforeRestartHub = await SpecialistCommunicationHub.create(temp.engine, restartParent, [cody, doc]);
  assert.ok(beforeRestartHub);
  const beforeRestartCody = beforeRestartHub.open(cody, restartParent, "worker-restart-cody" as never);
  const beforeRestartDoc = beforeRestartHub.open(doc, restartParent, "worker-restart-doc" as never);
  await beforeRestartCody.sendFinding(doc, "A finding delivered exactly once.");
  for (let attempt = 0; attempt < 20 && !(await beforeRestartDoc.receive(controller.signal)).length; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  await beforeRestartHub.close();
  temp.closeDb();
  const recoveredEngine = temp.reopenDb();
  const afterRestartHub = await SpecialistCommunicationHub.create(recoveredEngine, restartParent, [cody, doc]);
  assert.ok(afterRestartHub);
  const afterRestartDoc = afterRestartHub.open(doc, restartParent, "worker-restart-doc-2" as never);
  assert.deepEqual(await afterRestartDoc.receive(controller.signal), [], "delivered messages are not replayed after database restart");
  const recoveredAccess = await recoveredEngine.authorizeSpecialistSessionScope(restartParent, doc);
  const recoveredMessages = await recoveredEngine.getSpecialistMessages(recoveredAccess);
  assert.equal(recoveredMessages[0]?.deliveryStatus, "delivered");
  await afterRestartHub.close();
});

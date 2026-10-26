import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MediobotDefinitionId, TaskId } from "@mediobot-v2/domain";
import { DurableTaskEngine } from "@mediobot-v2/runtime";
import { LocalDatabase } from "../../src/storage/db.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";

const limit = { workspaceId: "workspace-a", threadId: "thread-a" };

function createTempDb() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mediobot-specialist-session-"));
  return { path: path.join(directory, "mediobot.db"), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

async function createCollaboration(engine: DurableTaskEngine) {
  const { task } = await engine.submitTask({ goal: "Coordinate specialists", definitionId: "maestro",
    workspaceId: limit.workspaceId, threadId: limit.threadId });
  const delegation = await engine.recordDelegation(task.id, { parentTaskId: task.id, childTaskId: null,
    assignedMediobotId: "doc", assignedMediobotName: "Doc", objective: "Research documentation", status: "active" });
  return { task, delegation };
}

test("specialist sessions persist bounded context with exact scope and optimistic versions", async t => {
  const temp = createTempDb(); t.after(temp.cleanup);
  const db = new LocalDatabase(temp.path);
  const engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const { task } = await createCollaboration(engine);
  const access = await engine.authorizeSpecialistSessionScope(task.id, "doc");
  const initial = await engine.getOrCreateSpecialistSession(access);
  const saved = await engine.updateSpecialistSessionContext(access, {
    contextSummary: "Official API version is 3.", expectedVersion: initial.contextVersion,
    provenance: [{ kind: "task-evidence", reference: "evidence-1", taskId: task.id as TaskId, capturedAt: Date.now() }],
  });
  assert.equal(saved.contextVersion, initial.contextVersion + 1);
  assert.equal(saved.contextSummary, "Official API version is 3.");
  assert.equal((await engine.getSpecialistSession(access))?.id, initial.id);
  await assert.rejects(engine.getSpecialistSession({ ...access, threadId: "thread-b" }), /scope/i);
  await assert.rejects(engine.getSpecialistSession({ ...access, scopeId: "other-scope" }), /scope/i);
  await assert.rejects(engine.updateSpecialistSessionContext(access, {
    contextSummary: "stale", expectedVersion: initial.contextVersion, provenance: [],
  }), /version/i);
  await assert.rejects(engine.updateSpecialistSessionContext(access, {
    contextSummary: "x".repeat(16_001), expectedVersion: saved.contextVersion, provenance: [],
  }), /size|bound/i);
  await assert.rejects(engine.updateSpecialistSessionContext(access, {
    contextSummary: "bounded", expectedVersion: saved.contextVersion, provenance: Array.from({ length: 33 }, () => ({ kind: "evidence", reference: "ref", capturedAt: Date.now() })),
  }), /provenance/i);
  db.close();
});

test("messages are attributed, ordered, idempotent, and recovered from SQLite after restart", async t => {
  const temp = createTempDb(); t.after(temp.cleanup);
  let db = new LocalDatabase(temp.path);
  let engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const { task } = await createCollaboration(engine);
  const evidence = await engine.recordEvidence(task.id, { kind: "api-reference", source: { type: "fixture" }, content: "Official v3 API reference", validity: "observed" });
  const maestro = await engine.authorizeSpecialistSessionScope(task.id, "maestro");
  await assert.rejects(engine.appendSpecialistMessage(maestro, { recipientSpecialistId: "doc" as MediobotDefinitionId,
    idempotencyKey: "out-of-scope-evidence", content: "Do not disclose unrelated evidence", evidenceRefs: ["foreign-evidence-id"] }), /outside the authorized specialist scope/i);
  const first = await engine.appendSpecialistMessage(maestro, { recipientSpecialistId: "doc" as MediobotDefinitionId, idempotencyKey: "msg-1",
    content: "Use the official v3 API reference.", evidenceRefs: [evidence.id] });
  const duplicate = await engine.appendSpecialistMessage(maestro, { recipientSpecialistId: "doc" as MediobotDefinitionId, idempotencyKey: "msg-1",
    content: "Use the official v3 API reference.", evidenceRefs: [evidence.id] });
  assert.equal(first.message.id, duplicate.message.id);
  assert.equal(duplicate.isDuplicate, true);
  const second = await engine.appendSpecialistMessage(maestro, { recipientSpecialistId: "doc" as MediobotDefinitionId, idempotencyKey: "msg-2",
    content: "Compare with the migration notes.", evidenceRefs: [] });
  assert.equal(second.message.sequenceNumber, first.message.sequenceNumber + 1);
  assert.equal(second.message.deliveryStatus, "pending");
  await assert.rejects(engine.appendSpecialistMessage(maestro, { recipientSpecialistId: "doc" as MediobotDefinitionId, idempotencyKey: "msg-1",
    content: "Changed payload", evidenceRefs: [] }), /idempotency/i);
  await assert.rejects(engine.appendSpecialistMessage(maestro, { recipientSpecialistId: "doc" as MediobotDefinitionId, idempotencyKey: "msg-big",
    content: "x".repeat(8_001), evidenceRefs: [] }), /size|bound/i);
  await assert.rejects(engine.appendSpecialistMessage(maestro, { recipientSpecialistId: "doc" as MediobotDefinitionId, idempotencyKey: "refs-big",
    content: "Too many references", evidenceRefs: Array.from({ length: 33 }, () => evidence.id) }), /bounds/i);
  db.close();

  db = new LocalDatabase(temp.path);
  engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  await engine.reconcileOnStartup();
  const doc = await engine.authorizeSpecialistSessionScope(task.id, "doc");
  assert.deepEqual(await engine.getSpecialistMessages(doc), [], "interrupted task messages stay hidden until explicit resume");
  await engine.resumeTask(task.id);
  const inbox = await engine.getSpecialistMessages(doc);
  assert.deepEqual(inbox.map(message => message.sequenceNumber), [1, 2]);
  assert.ok(inbox.every(message => message.senderSpecialistId === "maestro" && message.recipientSpecialistId === "doc"));
  assert.ok(inbox.every(message => message.deliveryStatus === "pending"), "pending messages remain retryable after restart");
  assert.deepEqual((await engine.getEvents(task.id)).filter(event => event.eventType === "specialist.message.appended").map(event => event.sequenceNumber), [5, 6]);

  const delivered = await engine.updateSpecialistMessageStatus(doc, first.message.id, "delivered");
  assert.equal(delivered.deliveryStatus, "delivered");
  assert.equal((await engine.updateSpecialistMessageStatus(doc, first.message.id, "delivered")).deliveryStatus, "delivered");
  await assert.rejects(engine.updateSpecialistMessageStatus(doc, first.message.id, "cancelled"), /transition/i);
  const retry = await engine.appendSpecialistMessage(await engine.authorizeSpecialistSessionScope(task.id, "maestro"), {
    recipientSpecialistId: "doc" as MediobotDefinitionId, idempotencyKey: "msg-1",
    content: "Use the official v3 API reference.", evidenceRefs: [evidence.id],
  });
  assert.equal(retry.isDuplicate, true);
  assert.equal(retry.message.deliveryStatus, "delivered", "retry returns current persisted status without re-queueing");

  await engine.cancelTask(task.id);
  const cancelled = await engine.getSpecialistMessages(doc);
  assert.equal(cancelled.find(message => message.id === first.message.id)?.deliveryStatus, "delivered");
  assert.equal(cancelled.find(message => message.id === second.message.id)?.deliveryStatus, "cancelled");
  const crashGap = await engine.submitTask({ goal: "Crash gap", definitionId: "maestro", workspaceId: limit.workspaceId, threadId: limit.threadId });
  await engine.recordDelegation(crashGap.task.id, { parentTaskId: crashGap.task.id, childTaskId: null,
    assignedMediobotId: "doc", assignedMediobotName: "Doc", objective: "Resume", status: "active" });
  const crashAccess = await engine.authorizeSpecialistSessionScope(crashGap.task.id, "maestro");
  const crashMessage = await engine.appendSpecialistMessage(crashAccess, { recipientSpecialistId: "doc" as MediobotDefinitionId, idempotencyKey: "crash-gap-message", content: "Pending at restart", evidenceRefs: [] });
  const docBeforeCrash = await engine.authorizeSpecialistSessionScope(crashGap.task.id, "doc");
  await new SqliteDurableTaskStore(db.rawDb).updateTask(crashGap.task.id, { status: "cancelled" });
  await assert.rejects(engine.updateSpecialistMessageStatus(docBeforeCrash, crashMessage.message.id, "delivered"), /parent task has stopped/i,
    "delivery cannot race cancellation after the parent task has committed its terminal state");
  db.close();
  db = new LocalDatabase(temp.path);
  engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  await engine.reconcileOnStartup();
  const recoveredDoc = await engine.authorizeSpecialistSessionScope(crashGap.task.id, "doc");
  assert.equal((await engine.getSpecialistMessages(recoveredDoc))[0]?.deliveryStatus, "cancelled",
    "restart reconciliation completes cancellation if shutdown interrupted cleanup");
  db.close();
});

test("shared groups persist ordered findings and per-specialist cursors with isolation, budgets, restart, and cancellation", async t => {
  const temp = createTempDb(); t.after(temp.cleanup);
  let db = new LocalDatabase(temp.path);
  let engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const { task } = await createCollaboration(engine);
  await engine.recordDelegation(task.id, { parentTaskId: task.id, childTaskId: null, assignedMediobotId: "cody",
    assignedMediobotName: "Cody", objective: "Inspect implementation", status: "active" });
  await engine.startTask(task.id);
  const group = await engine.createCollaborationGroup(task.id, ["doc", "cody"]);
  assert.equal(group.status, "active");
  assert.deepEqual((await engine.getCollaborationGroupMembers(await engine.authorizeSpecialistSessionScope(task.id, "doc"), group.id))
    .map(member => [member.specialistId, member.role]).sort(), [["cody", "specialist"], ["doc", "specialist"], ["maestro", "coordinator"]].sort());
  const doc = await engine.authorizeSpecialistSessionScope(task.id, "doc");
  const cody = await engine.authorizeSpecialistSessionScope(task.id, "cody");
  const evidence = await engine.recordEvidence(task.id, { kind: "official-doc", source: { type: "fixture" }, content: "Verified Node.js API page", validity: "verified" });
  const first = await engine.publishCollaborationGroupMessage(doc, group.id, { kind: "finding", idempotencyKey: "doc-finding-1",
    content: "Node.js API supports the documented option.", evidenceRefs: [evidence.id] });
  const retry = await engine.publishCollaborationGroupMessage(doc, group.id, { kind: "finding", idempotencyKey: "doc-finding-1",
    content: "Node.js API supports the documented option.", evidenceRefs: [evidence.id] });
  assert.equal(retry.isDuplicate, true);
  assert.equal(retry.message.id, first.message.id);
  await assert.rejects(engine.publishCollaborationGroupMessage(doc, group.id, { kind: "finding", idempotencyKey: "doc-finding-1",
    content: "different content", evidenceRefs: [] }), /idempotency/i);
  await assert.rejects(engine.publishCollaborationGroupMessage(doc, group.id, { kind: "finding", idempotencyKey: "too-large",
    content: "x".repeat(2_001), evidenceRefs: [] }), /bound|size/i);
  await assert.rejects(engine.publishCollaborationGroupMessage(doc, group.id, { kind: "finding", idempotencyKey: "foreign-evidence",
    content: "Do not share foreign evidence.", evidenceRefs: ["foreign-id"] }), /evidence.*scope/i);
  const received = await engine.receiveCollaborationGroupMessages(cody, group.id, 6, 4_000);
  assert.deepEqual(received.messages.map(message => message.sequenceNumber), [1]);
  assert.match(received.messages[0]!.content, /Node\.js API supports/);
  const docHistory = await engine.listCollaborationGroupMessages(doc, group.id, 6, 4_000);
  assert.deepEqual(docHistory.messages.map(message => message.sequenceNumber), [1]);
  assert.equal(docHistory.readSequenceNumber, 0, "read-only history does not consume the specialist's delivery cursor");
  const cursors = await engine.getCollaborationGroupMembers(doc, group.id);
  assert.equal(cursors.find(member => member.specialistId === "cody")?.readSequenceNumber, 1);
  assert.equal(cursors.find(member => member.specialistId === "doc")?.readSequenceNumber, 0);
  const coordinator = await engine.authorizeSpecialistSessionScope(task.id, "maestro");
  const dynamicTaskId = "dynamic-tester-child";
  await engine.submitTask({ id: dynamicTaskId, workspaceId: task.workspaceId, threadId: task.threadId,
    goal: "Verify Cody's dynamic continuation", definitionId: "tester" });
  await engine.startTask(dynamicTaskId);
  await engine.recordDelegation(task.id, { parentTaskId: task.id, childTaskId: dynamicTaskId,
    assignedMediobotId: "tester", assignedMediobotName: "Tester", objective: "Verify the dynamic result", status: "active" });
  await assert.rejects(engine.addCollaborationGroupMember(doc, group.id, "tester" as MediobotDefinitionId), /coordinator/i);
  const joined = await engine.addCollaborationGroupMember(coordinator, group.id, "tester" as MediobotDefinitionId);
  assert.equal(joined.readSequenceNumber, 1, "a dynamic member starts at the current group cursor and does not inherit earlier messages");
  const tester = await engine.authorizeSpecialistSessionScope(task.id, "tester");
  assert.deepEqual((await engine.receiveCollaborationGroupMessages(tester, group.id)).messages, []);
  const requestText = "q".repeat(2_000);
  await engine.publishCollaborationGroupMessage(doc, group.id, { kind: "request", idempotencyKey: "bounded-request-1", content: requestText, evidenceRefs: [] });
  assert.equal((await engine.receiveCollaborationGroupMessages(tester, group.id)).messages[0]?.sequenceNumber, 2,
    "the newly authorized member receives only messages published after joining");
  const tooSmallContext = await engine.receiveCollaborationGroupMessages(cody, group.id, 6, 1_999);
  assert.equal(tooSmallContext.messages.length, 0);
  assert.equal(tooSmallContext.readSequenceNumber, 1, "a message that does not fit the bounded context remains unread");
  const requestRead = await engine.receiveCollaborationGroupMessages(cody, group.id, 6, 2_000);
  assert.equal(requestRead.messages[0]?.kind, "request");
  assert.equal(requestRead.readSequenceNumber, 2);
  await assert.rejects(engine.publishCollaborationGroupMessage(doc, group.id, { kind: "request", idempotencyKey: "repeated-request",
    content: requestText, evidenceRefs: [] }), /budget exhausted/i);
  await engine.publishCollaborationGroupMessage(doc, group.id, { kind: "request", idempotencyKey: "bounded-request-2", content: "Check cancellation behavior.", evidenceRefs: [] });
  await assert.rejects(engine.publishCollaborationGroupMessage(doc, group.id, { kind: "request", idempotencyKey: "bounded-request-3",
    content: "Check retry policy.", evidenceRefs: [] }), /budget exhausted/i);
  await assert.rejects(engine.receiveCollaborationGroupMessages({ ...cody, threadId: "thread-b" }, group.id), /scope/i);
  const authorizedTester = await engine.authorizeSpecialistSessionScope(task.id, "tester");
  assert.equal((await engine.receiveCollaborationGroupMessages(authorizedTester, group.id)).readSequenceNumber, 3,
    "the explicitly added, durably delegated specialist may read the group from its join cursor");
  const otherTask = await engine.submitTask({ goal: "Isolated group", definitionId: "maestro", workspaceId: limit.workspaceId, threadId: limit.threadId });
  await engine.recordDelegation(otherTask.task.id, { parentTaskId: otherTask.task.id, childTaskId: null, assignedMediobotId: "doc",
    assignedMediobotName: "Doc", objective: "Research", status: "active" });
  await engine.recordDelegation(otherTask.task.id, { parentTaskId: otherTask.task.id, childTaskId: null, assignedMediobotId: "cody",
    assignedMediobotName: "Cody", objective: "Inspect", status: "active" });
  await engine.startTask(otherTask.task.id);
  const otherGroup = await engine.createCollaborationGroup(otherTask.task.id, ["doc", "cody"]);
  await assert.rejects(engine.receiveCollaborationGroupMessages(cody, otherGroup.id), /scope/i);
  await engine.publishCollaborationGroupMessage(doc, group.id, { kind: "finding", idempotencyKey: "pending-through-restart",
    content: "A later finding remains unread until restart recovery.", evidenceRefs: [] });

  db.close();
  db = new LocalDatabase(temp.path);
  engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const recovered = await engine.createCollaborationGroup(task.id, ["doc", "cody"]);
  assert.equal(recovered.id, group.id);
  assert.deepEqual((await engine.getCollaborationGroupMembers(await engine.authorizeSpecialistSessionScope(task.id, "maestro"), group.id))
    .map(member => member.specialistId).sort(), ["cody", "doc", "maestro", "tester"].sort(),
  "explicit runtime membership is preserved across database restart");
  const recoveredCody = await engine.authorizeSpecialistSessionScope(task.id, "cody");
  const recoveredMessages = await engine.receiveCollaborationGroupMessages(recoveredCody, group.id);
  assert.deepEqual(recoveredMessages.messages.map(message => message.sequenceNumber), [3, 4], "only unread messages resume after restart; delivered messages are not duplicated");
  assert.ok((await engine.getEvents(task.id)).some(event => event.eventType === "collaboration.group.message.appended"));
  await engine.cancelTask(task.id);
  assert.equal((await engine.getCollaborationGroup(recoveredCody, group.id))?.status, "cancelled");
  await assert.rejects(engine.publishCollaborationGroupMessage(await engine.authorizeSpecialistSessionScope(task.id, "doc"), group.id,
    { kind: "finding", idempotencyKey: "after-cancel", content: "Must not be delivered.", evidenceRefs: [] }), /scope|closed|inactive/i);
  assert.equal((await engine.getCollaborationGroupMembers(recoveredCody, group.id)).length, 4, "membership and history survive cancellation for recovery/audit");
  await assert.rejects(engine.receiveCollaborationGroupMessages(recoveredCody, group.id), /active authorized/i);
  const cursorBeforeHistory = (await engine.getCollaborationGroupMembers(recoveredCody, group.id))
    .find(member => member.specialistId === "cody")?.readSequenceNumber;
  const cancelledHistory = await engine.listCollaborationGroupMessages(recoveredCody, group.id, 6, 4_000);
  assert.deepEqual(cancelledHistory.messages.map(message => message.sequenceNumber), [1, 2, 3, 4],
    "a group member can inspect bounded shared history after cancellation");
  assert.equal((await engine.getCollaborationGroupMembers(recoveredCody, group.id))
    .find(member => member.specialistId === "cody")?.readSequenceNumber, cursorBeforeHistory,
  "opening historical collaboration never advances the execution cursor");
  await assert.rejects(engine.listCollaborationGroupMessages({ ...recoveredCody, threadId: "foreign-thread" }, group.id), /scope/i);
  const unassignedResearch = await engine.authorizeSpecialistSessionScope(task.id, "research").catch(() => null);
  assert.equal(unassignedResearch, null, "a specialist outside the parent task cannot authorize group history access");

  const failing = await createCollaboration(engine);
  const failingGroup = await engine.createCollaborationGroup(failing.task.id, ["doc"]);
  const failingDoc = await engine.authorizeSpecialistSessionScope(failing.task.id, "doc");
  await engine.failTask(failing.task.id, { code: "controlled_failure", message: "Expected test failure" });
  assert.equal((await engine.getCollaborationGroup(failingDoc, failingGroup.id))?.status, "failed");
  assert.ok((await engine.getEvents(failing.task.id)).some(event => event.eventType === "collaboration.group.closed"
    && (event.payload as { status?: string }).status === "failed"));
  db.close();
});

test("session isolation includes workspace, thread, specialist, and scope; expiry and deletion clear context", async t => {
  const temp = createTempDb(); t.after(temp.cleanup);
  const db = new LocalDatabase(temp.path);
  const engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const { task } = await createCollaboration(engine);
  const doc = await engine.authorizeSpecialistSessionScope(task.id, "doc");
  const session = await engine.getOrCreateSpecialistSession(doc);
  const anotherTask = await engine.submitTask({ goal: "Same thread, separate authorization scope", definitionId: "maestro", workspaceId: limit.workspaceId, threadId: limit.threadId });
  await engine.recordDelegation(anotherTask.task.id, { parentTaskId: anotherTask.task.id, childTaskId: null,
    assignedMediobotId: "doc", assignedMediobotName: "Doc", objective: "Inspect", status: "active" });
  const otherScope = await engine.authorizeSpecialistSessionScope(anotherTask.task.id, "doc");
  assert.notEqual((await engine.getOrCreateSpecialistSession(otherScope)).id, session.id);
  const crossWorkspace = await engine.submitTask({ goal: "Other workspace", definitionId: "maestro", workspaceId: "workspace-b", threadId: "thread-a" });
  await engine.recordDelegation(crossWorkspace.task.id, { parentTaskId: crossWorkspace.task.id, childTaskId: null,
    assignedMediobotId: "doc", assignedMediobotName: "Doc", objective: "Inspect", status: "active" });
  const workspaceSession = await engine.getOrCreateSpecialistSession(await engine.authorizeSpecialistSessionScope(crossWorkspace.task.id, "doc"));
  assert.notEqual(workspaceSession.id, session.id, "workspace is part of the full session key");
  const crossThread = await engine.submitTask({ goal: "Other thread", definitionId: "maestro", workspaceId: limit.workspaceId, threadId: "thread-b" });
  await engine.recordDelegation(crossThread.task.id, { parentTaskId: crossThread.task.id, childTaskId: null,
    assignedMediobotId: "doc", assignedMediobotName: "Doc", objective: "Inspect", status: "active" });
  const threadSession = await engine.getOrCreateSpecialistSession(await engine.authorizeSpecialistSessionScope(crossThread.task.id, "doc"));
  assert.notEqual(threadSession.id, session.id, "thread is part of the full session key");
  await engine.recordDelegation(task.id, { parentTaskId: task.id, childTaskId: null, assignedMediobotId: "research",
    assignedMediobotName: "Research", objective: "Research", status: "active" });
  const otherSpecialist = await engine.getOrCreateSpecialistSession(await engine.authorizeSpecialistSessionScope(task.id, "research"));
  assert.notEqual(otherSpecialist.id, session.id, "specialist is part of the full session key");
  await assert.rejects(engine.authorizeSpecialistSessionScope(task.id, "tester"), /not assigned|scope/i);
  await engine.updateSpecialistSessionContext(doc, { contextSummary: "short-lived", expectedVersion: session.contextVersion,
    provenance: [], expiresAt: Date.now() + 10 });
  await new Promise(resolve => setTimeout(resolve, 15));
  const expired = await engine.getSpecialistSession(doc);
  assert.equal(expired?.lifecycle, "expired");
  await engine.deleteSpecialistSession(otherScope);
  const deleted = await engine.getSpecialistSession(otherScope);
  assert.equal(deleted?.lifecycle, "deleted");
  assert.equal(deleted?.contextSummary, "");
  db.close();
});

test("thread-scoped specialist conversation survives separate tasks and SQLite restart", async t => {
  const temp = createTempDb(); t.after(temp.cleanup);
  let db = new LocalDatabase(temp.path);
  let engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const { task: firstTask } = await createCollaboration(engine);
  const firstAccess = await engine.authorizeSpecialistSessionScope(firstTask.id, "doc", { persistentForThread: true });
  const first = await engine.getOrCreateSpecialistSession(firstAccess);
  const saved = await engine.updateSpecialistSessionContext(firstAccess, { contextSummary: "First turn: use the Node.js official introduction.",
    expectedVersion: first.contextVersion, provenance: [{ kind: "specialist-turn", reference: "turn-1", taskId: firstTask.id as TaskId, capturedAt: Date.now() }] });

  const { task: secondTask } = await createCollaboration(engine);
  const secondAccess = await engine.authorizeSpecialistSessionScope(secondTask.id, "doc", { persistentForThread: true });
  assert.equal((await engine.getOrCreateSpecialistSession(secondAccess)).id, saved.id);
  assert.match((await engine.getSpecialistSession(secondAccess))?.contextSummary ?? "", /Node\.js official introduction/);
  await assert.rejects(engine.authorizeSpecialistSessionScope(secondTask.id, "tester", { persistentForThread: true }), /not assigned|scope/i);

  db.close();
  db = new LocalDatabase(temp.path);
  engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const recovered = await engine.authorizeSpecialistSessionScope(secondTask.id, "doc", { persistentForThread: true });
  assert.equal((await engine.getSpecialistSession(recovered))?.id, saved.id);
  assert.match((await engine.getSpecialistSession(recovered))?.contextSummary ?? "", /First turn/);
  const otherThread = await engine.submitTask({ goal: "separate thread", definitionId: "maestro", workspaceId: limit.workspaceId, threadId: "thread-other" });
  await engine.recordDelegation(otherThread.task.id, { parentTaskId: otherThread.task.id, childTaskId: null,
    assignedMediobotId: "doc", assignedMediobotName: "Doc", objective: "Separate scope", status: "active" });
  const isolated = await engine.getOrCreateSpecialistSession(await engine.authorizeSpecialistSessionScope(otherThread.task.id, "doc", { persistentForThread: true }));
  assert.notEqual(isolated.id, saved.id);
  assert.equal(isolated.contextSummary, "");
  db.close();
});

test("version-4 database migration preserves provider settings, history, tasks, and evidence", async t => {
  const temp = createTempDb(); t.after(temp.cleanup);
  let db = new LocalDatabase(temp.path);
  const store = new SqliteDurableTaskStore(db.rawDb);
  const engine = new DurableTaskEngine(store);
  const { task } = await engine.submitTask({ goal: "preserve this task", definitionId: "maestro",
    workspaceId: "legacy-workspace", threadId: "legacy-thread" });
  await engine.recordEvidence(task.id, { kind: "existing", source: { type: "test" }, content: "keep evidence", validity: "observed" });
  db.rawDb.prepare("INSERT INTO provider_connections (id, provider_type, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("provider-legacy", "custom", "Legacy Provider", 1, 1);
  db.rawDb.prepare("INSERT INTO provider_secrets (provider_id, api_key, updated_at) VALUES (?, ?, ?)")
    .run("provider-legacy", "fixture-not-a-real-credential", 1);
  db.rawDb.prepare("INSERT INTO workspaces (id, canonical_path, display_name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)")
    .run("legacy-workspace", "/tmp/legacy-workspace", "Legacy workspace", 1, 1);
  db.rawDb.prepare("INSERT INTO threads (id, workspace_id, title, created_at, updated_at, turns_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run("legacy-thread", "legacy-workspace", "Legacy thread", 1, 2, JSON.stringify([{ id: "turn-1" }]));
  db.rawDb.exec("DROP TABLE durable_task_artifacts; DROP TABLE collaboration_group_messages; DROP TABLE collaboration_group_members; DROP TABLE collaboration_groups; DROP TABLE specialist_messages; DROP TABLE specialist_sessions;");
  db.rawDb.prepare("DELETE FROM schema_migrations WHERE version > 4").run();
  db.close();

  db = new LocalDatabase(temp.path);
  assert.equal(db.currentSchemaVersion, 18);
  assert.equal((db.rawDb.prepare("SELECT display_name FROM provider_connections WHERE id = ?").get("provider-legacy") as { display_name: string }).display_name, "Legacy Provider");
  assert.equal((db.rawDb.prepare("SELECT count(*) AS count FROM provider_secrets WHERE provider_id = ?").get("provider-legacy") as { count: number }).count, 1);
  assert.deepEqual(JSON.parse((db.rawDb.prepare("SELECT turns_json FROM threads WHERE id = ?").get("legacy-thread") as { turns_json: string }).turns_json), [{ id: "turn-1" }]);
  const migrated = new SqliteDurableTaskStore(db.rawDb);
  assert.equal((await migrated.getTask(task.id))?.goal, "preserve this task");
  assert.equal((await migrated.getEvidence(task.id))[0]?.content, "keep evidence");
  db.close();
});

test("version-7 migration preserves existing group rows, membership, messages, and references", async t => {
  const temp = createTempDb(); t.after(temp.cleanup);
  let db = new LocalDatabase(temp.path);
  const engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const { task } = await createCollaboration(engine);
  await engine.recordDelegation(task.id, { parentTaskId: task.id, childTaskId: null, assignedMediobotId: "cody",
    assignedMediobotName: "Cody", objective: "Inspect", status: "active" });
  const group = await engine.createCollaborationGroup(task.id, ["doc", "cody"]);
  const doc = await engine.authorizeSpecialistSessionScope(task.id, "doc");
  await engine.publishCollaborationGroupMessage(doc, group.id, { kind: "finding", idempotencyKey: "migration-message",
    content: "Preserve this finding", evidenceRefs: [] });

  db.rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE collaboration_groups_v6 (
      id TEXT PRIMARY KEY,
      parent_task_id TEXT NOT NULL UNIQUE REFERENCES durable_tasks(id) ON DELETE CASCADE,
      workspace_id TEXT, workspace_key TEXT NOT NULL, thread_id TEXT NOT NULL, scope_id TEXT NOT NULL,
      coordinator_specialist_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
      next_sequence_number INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence_number >= 1),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      CHECK(workspace_key = COALESCE(workspace_id, ''))
    );
    INSERT INTO collaboration_groups_v6 SELECT * FROM collaboration_groups;
    DROP TABLE collaboration_groups;
    ALTER TABLE collaboration_groups_v6 RENAME TO collaboration_groups;
    PRAGMA foreign_keys = ON;
    DELETE FROM schema_migrations WHERE version = 7;
  `);
  db.close();

  db = new LocalDatabase(temp.path);
  const recovered = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const cody = await recovered.authorizeSpecialistSessionScope(task.id, "cody");
  assert.equal((await recovered.getCollaborationGroup(cody, group.id))?.status, "active");
  assert.equal((await recovered.getCollaborationGroupMembers(cody, group.id)).length, 3);
  const message = await recovered.receiveCollaborationGroupMessages(cody, group.id);
  assert.equal(message.messages[0]?.content, "Preserve this finding");
  assert.deepEqual(db.rawDb.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

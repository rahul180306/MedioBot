import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
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

async function request(app: Awaited<ReturnType<typeof startCommandCenter>>, url: string) {
  const req = Object.assign(Readable.from([]), { method: "GET", url, headers: {} });
  const res = new ResponseCapture();
  const finished = new Promise<void>(resolve => res.once("finish", resolve));
  app.handle(req as never, res as never);
  await finished;
  return { status: res.statusCode, json: JSON.parse(res.output) as any };
}

test("specialist group history API returns only member-visible shared messages in the active workspace", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-specialist-group-history-"));
  const workspace = path.join(root, "project");
  const otherWorkspace = path.join(root, "other-project");
  mkdirSync(workspace);
  mkdirSync(otherWorkspace);
  const databasePath = path.join(root, "state.db");
  let app = await startCommandCenter({ databasePath, workspaceRoot: workspace, vite: false, listen: false });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

  const engine = app.composition.durableTaskEngine!;
  const session = app.workspaceManager.session!;
  // Legacy persisted IDs are hidden from the canonical roster but remain in the
  // runtime registry for durable task and message attribution.
  const legacyDocId = app.composition.world.registerMediobotDefinition({ id: "definition_legacy_doc" as never,
    name: "Doc", role: "documentation", version: "0.1.0", instructions: "Legacy Doc identity",
    declaredCapabilities: [] }).id;
  const codyId = app.composition.definitions.find(definition => definition.name === "Cody")!.id;
  const researchId = app.composition.definitions.find(definition => definition.name === "Research")!.id;
  const { task } = await engine.submitTask({ workspaceId: session.workspaceId, threadId: "thread-shared-history",
    goal: "Inspect the documented runtime setup", definitionId: app.composition.maestroDefinitionId });
  await engine.startTask(task.id);
  for (const [id, name] of [[legacyDocId, "Doc"], [codyId, "Cody"]] as const) {
    await engine.recordDelegation(task.id, { parentTaskId: task.id, childTaskId: null, assignedMediobotId: id,
      assignedMediobotName: name, objective: `${name} task`, status: "active" });
  }
  const group = await engine.createCollaborationGroup(task.id, [legacyDocId, codyId]);
  const doc = await engine.authorizeSpecialistSessionScope(task.id, legacyDocId);
  const cody = await engine.authorizeSpecialistSessionScope(task.id, codyId);
  await engine.publishCollaborationGroupMessage(doc, group.id, { kind: "finding", idempotencyKey: "shared-node-finding",
    content: "The official Node.js page documents the runtime setup.", evidenceRefs: [] });
  const direct = await engine.appendSpecialistMessage(doc, { recipientSpecialistId: codyId,
    idempotencyKey: "private-cody-message", content: JSON.stringify({ version: 1, kind: "request",
      correlationId: "private-correlation", text: "Check whether the setup command runs on Windows." }), evidenceRefs: [] });
  await engine.updateSpecialistMessageStatus(cody, direct.message.id, "delivered");

  const codyResponse = await request(app, "/api/specialists/cody/group-history");
  assert.equal(codyResponse.status, 200);
  assert.equal(codyResponse.json.groups.length, 1);
  assert.equal(codyResponse.json.groups[0].groupId, group.id);
  assert.equal(codyResponse.json.groups[0].messages[0].senderName, "Doc");
  assert.match(codyResponse.json.groups[0].messages[0].content, /official Node\.js page/);
  assert.equal(codyResponse.json.groups[0].privateMessages.length, 1);
  assert.equal(codyResponse.json.groups[0].privateMessages[0].senderName, "Doc");
  assert.equal(codyResponse.json.groups[0].privateMessages[0].kind, "request");
  assert.match(codyResponse.json.groups[0].privateMessages[0].content, /runs on Windows/);
  assert.doesNotMatch(JSON.stringify(codyResponse.json.groups[0].messages), /runs on Windows/,
    "private direct content must remain distinct from the shared group transcript");

  const researchResponse = await request(app, "/api/specialists/research/group-history");
  assert.equal(researchResponse.status, 200);
  assert.deepEqual(researchResponse.json.groups, [], "a non-member receives no group message content");

  await app.workspaceManager.openWorkspace(otherWorkspace);
  const isolatedResponse = await request(app, "/api/specialists/cody/group-history");
  assert.equal(isolatedResponse.status, 200);
  assert.deepEqual(isolatedResponse.json.groups, [], "switching workspaces hides the original project history");

  await app.close();
  app = await startCommandCenter({ databasePath, workspaceRoot: workspace, vite: false, listen: false });
  const restartedResponse = await request(app, "/api/specialists/cody/group-history");
  assert.equal(restartedResponse.status, 200);
  assert.match(restartedResponse.json.groups[0].privateMessages[0].content, /runs on Windows/,
    "the selected specialist's authorized direct message history must remain available after restart");
});

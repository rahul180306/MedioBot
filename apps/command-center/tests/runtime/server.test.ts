import assert from "node:assert/strict";
import test from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import { startCommandCenter } from "../../src/server.ts";
import { createComposition } from "../../src/composition.ts";
import type { CommandCenterComposition, DefinitionView, ProductEvent, TaskView } from "../../src/contracts.ts";
import type { TaskId } from "@mediobot-v2/domain";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { LocalProjectCatalog } from "../../src/projects.ts";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function fakeComposition(): CommandCenterComposition {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Vision", role: "browser", version: "1", instructions: "", declaredCapabilities: [] });
  const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
  submission.registerAdapter(definition.id, { prepare: (context) => ({ resourceIds: [], execute: async () => {
    context.world.appendEvent({ type: "worker.output", workerId: context.workerId, taskId: context.taskId });
    await new Promise((resolve) => setTimeout(resolve, 120));
  } }) });
  const taskEvents = new Map<TaskId, ProductEvent[]>();
  const subscribers = new Map<TaskId, Set<(event: ProductEvent) => void>>();
  const taskErrors = new Map<TaskId, TaskView["error"]>();
  const definitions: DefinitionView[] = [{ id: definition.id, name: "Vision", group: "specialist", role: "Browser", summary: "Fake worker", availability: "available", executable: true }];
  const publish = (event: ProductEvent) => { const events = taskEvents.get(event.taskId) ?? []; events.push(event); taskEvents.set(event.taskId, events);
    for (const callback of subscribers.get(event.taskId) ?? []) callback(event); };
  const snapshotTask = (taskId: TaskView["id"]): TaskView | undefined => {
    const snapshot = world.inspect(); const task = snapshot.tasks.find((entry) => entry.id === taskId); if (!task) return undefined;
    const worker = snapshot.workers.find((entry) => entry.id === task.assignedWorkerId);
    return { id: task.id, worldId: task.worldId, goal: task.goal, state: task.state,
      workers: worker ? [{ id: worker.id, taskId: task.id, definitionId: definition.id, name: "Vision", state: worker.state }] : [], events: taskEvents.get(taskId) ?? [] };
  };
  return { world, submission, definitions, visionDefinitionId: definition.id, taskEvents, subscribers, taskErrors, publish,
    submit(id, goal) { const created = submission.submit({ definitionId: id, goal, onCreated: ({ task }) => publish({ id: "created", type: "task.started", worldId: task.worldId, taskId: task.id, occurredAt: Date.now() }),
      onEvent: (event) => { const type = event.type === "task.started" ? "task.started" : event.type === "task.completed" ? "task.completed" : undefined;
        if (type && event.taskId) publish({ id: event.id, type, worldId: event.worldId, taskId: event.taskId, workerId: event.workerId, occurredAt: event.occurredAt }); } });
      return { taskId: created.task.id, result: created.result }; },
    cancel(id) { submission.cancel(id); }, snapshotTask,
    mapWorldEvent() {}, mapVisionProgress() {}, maestroDefinitionId: definition.id, codyDefinitionId: definition.id, projects: new LocalProjectCatalog(process.cwd()),
  };
}

class FakeResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  output = "";
  onChunk?: (chunk: string) => void;
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { this.output += chunk.toString(); this.onChunk?.(chunk.toString()); callback(); }
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; return this; }
}
async function request(app: Awaited<ReturnType<typeof startCommandCenter>>, method: string, url: string, bodyText?: string, contentType = "application/json") {
  const req = Object.assign(Readable.from(bodyText ? [bodyText] : []), new EventEmitter(), { method, url,
    headers: bodyText ? { "content-type": contentType } : {} });
  const res = new FakeResponse();
  const finished = new Promise<void>((resolve) => res.once("finish", resolve));
  await app.handle(req as never, res as never);
  if (method !== "GET" || !url.endsWith("/events")) await finished;
  else await new Promise<void>((resolve) => {
    res.onChunk = (chunk) => { if (chunk.includes("event: product")) { res.emit("close"); resolve(); } };
    if (res.output.includes("event: product")) { res.emit("close"); resolve(); }
  });
  return { status: res.statusCode, headers: res.headers, text: res.output, json: () => JSON.parse(res.output) };
}

test("HTTP API uses generic tasks, workers[] and task-scoped safe SSE", async () => {
  const app = await startCommandCenter({ composition: fakeComposition(), vite: false, listen: false });
  try {
    const roster = request(app, "GET", "/api/definitions").then((response) => response.json()) as Promise<{ definitions: DefinitionView[] }>;
    const rosterData = await roster;
    assert.equal(rosterData.definitions[0]?.name, "Vision");
    const create = await request(app, "POST", "/api/tasks", JSON.stringify({ definitionId: rosterData.definitions[0]?.id, goal: "Do deterministic fake work" }));
    assert.equal(create.status, 202);
    const { task } = create.json() as { task: TaskView };
    assert.equal(task.workers.length, 1);
    assert.equal(task.workers[0]?.name, "Vision");
    assert.equal(task.events[0]?.type, "task.started");
    const detail = (await request(app, "GET", `/api/tasks/${task.id}`)).json() as { task: TaskView };
    assert.equal(detail.task.goal, "Do deterministic fake work");
    assert.equal(JSON.stringify(detail).includes("worker.output"), false);
    const stream = await request(app, "GET", `/api/tasks/${task.id}/events`);
    assert.match(stream.headers["content-type"] ?? "", /text\/event-stream/);
    assert.match(stream.text, /event: product/);
    await new Promise((resolve) => setTimeout(resolve, 160));
    const complete = (await request(app, "GET", `/api/tasks/${task.id}`)).json() as { task: TaskView };
    assert.equal(complete.task.state, "completed");
  } finally { await app.close(); }
});

test("GET /api/tasks includes only durable tasks from the active workspace", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-task-list-scope-"));
  const workspaceA = path.join(root, "project-a");
  const workspaceB = path.join(root, "project-b");
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const base = fakeComposition();
  const taskA = base.world.createTask("Project A task", undefined, "task-project-a" as TaskId);
  const taskB = base.world.createTask("Project B task", undefined, "task-project-b" as TaskId);
  const unscopedTask = base.world.createTask("Unscoped task", undefined, "task-unscoped" as TaskId);
  const durableTasks = [
    { id: taskA.id, workspaceId: "workspace-a" },
    { id: taskB.id, workspaceId: "workspace-b" },
    { id: unscopedTask.id, workspaceId: null as string | null },
  ];
  const composition = {
    ...base,
    durableTaskEngine: {
      listTasks: async (workspaceId?: string | null) => durableTasks.filter((task) => task.workspaceId === workspaceId),
    },
  } as unknown as CommandCenterComposition;
  const app = await startCommandCenter({ composition, vite: false, listen: false });
  t.after(() => app.close());

  await request(app, "POST", "/api/workspace/open", JSON.stringify({ path: workspaceA }));
  const openedB = await request(app, "POST", "/api/workspace/open", JSON.stringify({ path: workspaceB }));
  const workspaceBId = openedB.json().session.workspaceId;
  // Use the actual workspace identifier generated by WorkspaceManager.
  durableTasks[0]!.workspaceId = "different-workspace";
  durableTasks[1]!.workspaceId = workspaceBId;

  const response = await request(app, "GET", "/api/tasks");
  assert.equal(response.status, 200);
  assert.deepEqual((response.json() as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id), [taskB.id]);

  await request(app, "POST", "/api/workspace/close");
  const withoutWorkspace = await request(app, "GET", "/api/tasks");
  assert.deepEqual((withoutWorkspace.json() as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id), [unscopedTask.id]);
});

test("specialist registry API persists supported text specialists and lifecycle without granting tools", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mediobot-registry-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "mediobot.db");
  const first = await startCommandCenter({ databasePath, vite: false, listen: false });
  let specialistId = "";
  let removedId = "";
  try {
    const simpleCrossOrigin = await request(first, "POST", "/api/definitions", JSON.stringify({ name: "Injected", role: "analysis",
      version: "1", instructions: "Untrusted instructions." }), "text/plain");
    assert.equal(simpleCrossOrigin.status, 415);
    const created = await request(first, "POST", "/api/definitions", JSON.stringify({ name: "Notes analyst", role: "analysis",
      version: "1", instructions: "Summarize only the supplied context." }));
    assert.equal(created.status, 201);
    specialistId = (created.json() as { definition: DefinitionView }).definition.id;
    assert.equal((created.json() as { definition: DefinitionView }).definition.executable, false);
    assert.equal((created.json() as { definition: DefinitionView }).definition.directConversationAvailable, true,
      "registered text-inference specialists can be addressed directly by their stable definition ID");
    const directTurn = await request(first, "POST", "/api/turns", JSON.stringify({
      prompt: "Summarize the supplied design notes.", threadId: "custom-specialist-thread", turnId: "custom-specialist-turn",
      specialistId,
    }));
    assert.equal(directTurn.status, 409);
    assert.equal(directTurn.json().error.code, "model-not-selected",
      "the stable specialist identity is accepted and the request reaches normal model-configuration validation");
    const impersonation = await request(first, "POST", "/api/definitions", JSON.stringify({ name: "Fake lead", role: "Team orchestration",
      version: "1", instructions: "Coordinate the organization." }));
    assert.equal(impersonation.status, 400);
    const listed = await request(first, "GET", "/api/definitions");
    const specialist = (listed.json() as { definitions: DefinitionView[] }).definitions.find(item => item.id === specialistId)!;
    assert.equal(specialist.name, "Notes analyst");
    assert.equal(first.composition.world.inspect().definitions.find(item => item.id === specialistId)?.declaredCapabilities
      .some(capability => capability.name === "filesystem.write" || capability.name === "terminal.execute"), false);
    const webSpecialist = await request(first, "POST", "/api/definitions", JSON.stringify({ name: "Policy researcher", role: "policy-research",
      version: "1", instructions: "Find relevant policy sources and summarize them.", capabilities: ["web.search", "web.crawl"] }));
    assert.equal(webSpecialist.status, 201);
    const webSpecialistId = (webSpecialist.json() as { definition: DefinitionView }).definition.id;
    const webCapabilities = first.composition.world.inspect().definitions.find(item => item.id === webSpecialistId)!.declaredCapabilities.map(item => item.name);
    assert.deepEqual(webCapabilities, ["web.search", "web.crawl", "text-inference"],
      "web registration binds the identity to the existing web adapter and its configured reasoning path");
    const unsupported = await request(first, "POST", "/api/definitions", JSON.stringify({ name: "Untrusted runner", role: "review",
      version: "1", instructions: "Run commands.", capabilities: ["terminal.execute"] }));
    assert.equal(unsupported.status, 400, "registration cannot grant a tool that has no supported specialist adapter contract");
    const incompleteWeb = await request(first, "POST", "/api/definitions", JSON.stringify({ name: "Incomplete researcher", role: "research",
      version: "1", instructions: "Search.", capabilities: ["web.search"] }));
    assert.equal(incompleteWeb.status, 400, "web capability registration requires the complete supported search and crawl pair");
    const draining = await request(first, "PATCH", `/api/definitions/${specialistId}/lifecycle`, JSON.stringify({ state: "draining" }));
    assert.equal(draining.status, 200);
    assert.equal(first.composition.definitions.find((item) => item.id === specialistId)?.directConversationAvailable, false,
      "a draining specialist cannot accept a new direct conversation");
    const rejectedDrainingTurn = await request(first, "POST", "/api/turns", JSON.stringify({
      prompt: "Continue the direct conversation.", threadId: "custom-specialist-thread", turnId: "draining-turn", specialistId,
    }));
    assert.equal(rejectedDrainingTurn.status, 400);
    assert.equal(rejectedDrainingTurn.json().error.code, "invalid-specialist");
    const temporary = await request(first, "POST", "/api/definitions", JSON.stringify({ name: "Temporary reviewer", role: "review",
      version: "1", instructions: "Review supplied context only." }));
    removedId = (temporary.json() as { definition: DefinitionView }).definition.id;
    const removed = await request(first, "DELETE", `/api/definitions/${removedId}`);
    assert.equal(removed.status, 200);
    const protectedCoordinator = await request(first, "DELETE", "/api/definitions/maestro");
    assert.equal(protectedCoordinator.status, 409);
  } finally { await first.close(); }

  const second = await startCommandCenter({ databasePath, vite: false, listen: false });
  try {
    const listed = await request(second, "GET", "/api/definitions");
    const specialist = (listed.json() as { definitions: DefinitionView[] }).definitions.find(item => item.id === specialistId)!;
    assert.equal(specialist.name, "Notes analyst");
    assert.equal(specialist.availability, "unavailable");
    assert.equal(second.composition.world.inspect().definitions.find(item => item.id === specialistId)?.lifecycleState, "draining");
    assert.equal((listed.json() as { definitions: DefinitionView[] }).definitions.some(item => item.id === removedId), false);
    assert.ok(second.composition.world.inspect().definitions.some(item => item.id === removedId), "tombstoned identity is retained in history state");
  } finally { await second.close(); }
});

test("project file API creates local entries and saves only the version the editor opened", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mediobot-project-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "src"));
  await writeFile(path.join(directory, "src", "app.ts"), "before\n");
  const composition = fakeComposition();
  const projects = new LocalProjectCatalog();
  const project = await projects.add(directory);
  const app = await startCommandCenter({ composition: { ...composition, projects }, vite: false, listen: false });
  try {
    const opened = await request(app, "GET", `/api/projects/${project.id}/file?path=src%2Fapp.ts`);
    const version = opened.json() as { content: string; hash: string };
    assert.equal(version.content, "before\n");
    const save = await request(app, "PUT", `/api/projects/${project.id}/file`, JSON.stringify({ path: "src/app.ts", content: "after\n", expectedHash: version.hash }));
    assert.equal(save.status, 200);
    assert.equal(await readFile(path.join(directory, "src", "app.ts"), "utf8"), "after\n");
    const conflict = await request(app, "PUT", `/api/projects/${project.id}/file`, JSON.stringify({ path: "src/app.ts", content: "stale\n", expectedHash: version.hash }));
    assert.equal(conflict.status, 409);
    const created = await request(app, "POST", `/api/projects/${project.id}/files`, JSON.stringify({ parentPath: "src", name: "new.ts", type: "file" }));
    assert.equal(created.status, 201);
    assert.equal(await readFile(path.join(directory, "src", "new.ts"), "utf8"), "");
    const renamed = await request(app, "PATCH", `/api/projects/${project.id}/files`, JSON.stringify({ path: "src/new.ts", name: "renamed.ts" }));
    assert.equal(renamed.status, 200);
    assert.equal(await readFile(path.join(directory, "src", "renamed.ts"), "utf8"), "");
    const deleted = await request(app, "DELETE", `/api/projects/${project.id}/files`, JSON.stringify({ path: "src/renamed.ts" }));
    assert.equal(deleted.status, 200);
    await assert.rejects(readFile(path.join(directory, "src", "renamed.ts"), "utf8"), { code: "ENOENT" });
  } finally { await app.close(); }
});

test("unavailable definitions are rejected without task creation", async () => {
  const app = await startCommandCenter({ composition: fakeComposition(), vite: false, listen: false });
  try {
    const response = await request(app, "POST", "/api/tasks", JSON.stringify({ definitionId: "unknown", goal: "no" }));
    assert.equal(response.status, 400);
    assert.equal(app.composition.world.inspect().tasks.length, 0);
  } finally { await app.close(); }
});

test("HTTP explains missing model configuration without creating fake work", async () => {
  const composition = createComposition({ env: {} });
  const app = await startCommandCenter({ composition, vite: false, listen: false });
  try {
    const response = await request(app, "POST", "/api/tasks", JSON.stringify({ definitionId: composition.visionDefinitionId, goal: "Should not run" }));
    assert.equal(response.status, 409);
    assert.match(response.text, /text reasoning model is not configured/);
    assert.equal(composition.world.inspect().tasks.length, 0);
    assert.equal(composition.world.inspect().workers.length, 0);
  } finally { await app.close(); }
});

test("HTTP API supports thread persistence, title update, deletion, and turn cancellation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mediobot-server-threads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const dbPath = path.join(directory, "threads-test.sqlite");
  const app = await startCommandCenter({ composition: fakeComposition(), workspaceRoot: directory, databasePath: dbPath, vite: false, listen: false });
  try {
    const emptyList = await request(app, "GET", "/api/threads");
    assert.equal(emptyList.status, 200);
    assert.deepEqual(emptyList.json(), { threads: [] });

    // Save thread
    const newThread = {
      id: "thread-api-1",
      title: "Initial Thread Title",
      projectId: "project-1",
      createdAt: 1000,
      updatedAt: 1000,
      model: "Configured by local runtime",
      branch: "main",
      approvalMode: "Approve for me",
      turns: [],
    };
    const createRes = await request(app, "POST", "/api/threads", JSON.stringify({ thread: newThread }));
    assert.equal(createRes.status, 200);

    // Get thread
    const getRes = await request(app, "GET", "/api/threads/thread-api-1");
    assert.equal(getRes.status, 200);
    const retrieved = getRes.json() as { thread: typeof newThread };
    assert.equal(retrieved.thread.title, "Initial Thread Title");

    // Patch title
    const patchRes = await request(app, "PATCH", "/api/threads/thread-api-1", JSON.stringify({ title: "Renamed Thread Title" }));
    assert.equal(patchRes.status, 200);

    const checkRenamed = await request(app, "GET", "/api/threads/thread-api-1");
    assert.equal((checkRenamed.json() as { thread: typeof newThread }).thread.title, "Renamed Thread Title");

    // Delete thread
    const delRes = await request(app, "DELETE", "/api/threads/thread-api-1");
    assert.equal(delRes.status, 200);

    const afterDel = await request(app, "GET", "/api/threads/thread-api-1");
    assert.equal(afterDel.status, 404);
  } finally { await app.close(); }
});

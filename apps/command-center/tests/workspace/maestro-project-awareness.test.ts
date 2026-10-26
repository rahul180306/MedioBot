import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../../src/storage/db.ts";
import { WorkspaceRepository } from "../../src/storage/workspaceRepository.ts";
import { WorkspaceManager } from "../../src/workspaceManager.ts";
import { startCommandCenter } from "../../src/server.ts";
import { LocalHistoryStore } from "../../src/history.ts";
import { ChatRepository } from "../../src/storage/chatRepository.ts";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";

class FakeResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  output = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.output += chunk.toString();
    callback();
  }
  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
}

async function request(app: Awaited<ReturnType<typeof startCommandCenter>>, method: string, url: string, bodyText?: string) {
  const req = Object.assign(Readable.from(bodyText ? [bodyText] : []), new EventEmitter(), { method, url, headers: {} });
  const res = new FakeResponse();
  const finished = new Promise<void>((resolve) => res.once("finish", resolve));
  await app.handle(req as never, res as never);
  await finished;
  let json: unknown = undefined;
  try {
    json = JSON.parse(res.output);
  } catch {}
  return { status: res.statusCode, body: json, text: res.output };
}

test("MPA-1: WorkspaceManager.getProjectIntelligenceContext() reflects active canonical session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa1-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const wm = new WorkspaceManager(repo);

  const projectDir = path.join(root, "my-app");
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  await writeFile(path.join(projectDir, "src", "index.ts"), "console.log('hello');\n");
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "my-app", scripts: { start: "node index.js" } }));

  const session = await wm.openWorkspace(projectDir);
  assert.equal(wm.status, "OPEN");

  const context = await wm.getProjectIntelligenceContext();
  assert.equal(context.workspaceRoot, session.canonicalRootPath);
  assert.equal(context.projectName, session.displayName);
  assert.equal(context.workspaceState.workspaceId, session.workspaceId);
  assert.equal(context.workspaceState.status, "OPEN");
  assert.equal(context.workspaceState.rootPath, session.canonicalRootPath);

  // Available tools are populated
  assert.ok(context.toolMetadata.some((t) => t.name === "filesystem.list"));
  assert.ok(context.toolMetadata.some((t) => t.name === "filesystem.read"));
  assert.ok(context.toolMetadata.some((t) => t.name === "filesystem.write"));
  assert.ok(context.toolMetadata.some((t) => t.name === "terminal.execute"));
});

test("MPA-2: Progressive project discovery provides bounded structure, manifest, and instructions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa2-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const wm = new WorkspaceManager(repo);

  const projectDir = path.join(root, "deep-app");
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  await mkdir(path.join(projectDir, "tests"), { recursive: true });
  await writeFile(path.join(projectDir, "src", "app.ts"), "export const app = {};\n");
  await writeFile(path.join(projectDir, "tests", "app.test.ts"), "test('ok');\n");
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
    name: "deep-app",
    type: "module",
    scripts: { test: "node --test" },
    dependencies: { react: "^19.0.0" },
  }));
  await writeFile(path.join(projectDir, "AGENTS.md"), "# Guidelines\nUse strict types.\n");

  await wm.openWorkspace(projectDir);
  const context = await wm.getProjectIntelligenceContext();

  const structure = context.projectIntelligence.find((r) => r.name === "project_structure");
  assert.ok(structure);
  assert.ok(structure.value.includes("src/"));
  assert.ok(structure.value.includes("package.json"));
  assert.ok(structure.value.includes("AGENTS.md"));

  const instructions = context.projectIntelligence.find((r) => r.name === "project_instructions");
  assert.ok(instructions);
  assert.ok(instructions.value.includes("Use strict types."));

  const manifest = context.projectIntelligence.find((r) => r.name === "project_manifest");
  assert.ok(manifest);
  const parsed = JSON.parse(manifest.value);
  assert.equal(parsed.name, "deep-app");
  assert.deepEqual(parsed.scripts, ["test"]);
  assert.deepEqual(parsed.dependencies, ["react"]);
});

test("MPA-3: Active file and tabs in UI state are genuinely reflected in project intelligence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa3-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const wm = new WorkspaceManager(repo);

  const projectDir = path.join(root, "tab-app");
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  await writeFile(path.join(projectDir, "src", "active.ts"), "// Active file content\nexport const x = 100;\n");
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "tab-app" }));

  await wm.openWorkspace(projectDir);
  wm.saveUIState("src/active.ts", [
    { path: "src/active.ts", name: "active.ts" },
    { path: "package.json", name: "package.json" },
  ], []);

  const context = await wm.getProjectIntelligenceContext();
  assert.equal(context.workspaceState.activeFile, "src/active.ts");
  assert.equal(context.workspaceState.openTabsCount, 2);

  const activeRecord = context.projectIntelligence.find((r) => r.name === "active_editor_file");
  assert.ok(activeRecord);
  assert.ok(activeRecord.value.includes("File: src/active.ts"));
  assert.ok(activeRecord.value.includes("export const x = 100;"));

  const tabsRecord = context.projectIntelligence.find((r) => r.name === "open_editor_tabs");
  assert.ok(tabsRecord);
  assert.ok(tabsRecord.value.includes("src/active.ts"));
  assert.ok(tabsRecord.value.includes("package.json"));
});

test("MPA-4: Sensitive files (.env, secrets, keys, credentials) are strictly excluded from intelligence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa4-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const wm = new WorkspaceManager(repo);

  const projectDir = path.join(root, "sensitive-app");
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  await writeFile(path.join(projectDir, "src", "safe.ts"), "export const safe = true;\n");
  await writeFile(path.join(projectDir, ".env"), "API_KEY=super-secret-key-12345\n");
  await writeFile(path.join(projectDir, ".env.production"), "DATABASE_URL=postgres://user:pass@host\n");
  await writeFile(path.join(projectDir, "credentials.yaml"), "aws_secret: secret-val\n");
  await writeFile(path.join(projectDir, "secrets.json"), '{"key": "my-secret"}\n');
  await writeFile(path.join(projectDir, "id_rsa"), "PRIVATE KEY\n");
  await writeFile(path.join(projectDir, "server.key"), "TLS KEY\n");

  await wm.openWorkspace(projectDir);

  // Even if user had opened .env in the editor before, it must never leak into intelligence
  wm.saveUIState(".env", [{ path: ".env", name: ".env" }, { path: "src/safe.ts", name: "safe.ts" }], []);

  const context = await wm.getProjectIntelligenceContext();

  const allIntelligenceStr = JSON.stringify(context.projectIntelligence);
  assert.equal(allIntelligenceStr.includes("super-secret-key"), false);
  assert.equal(allIntelligenceStr.includes("postgres://user:pass"), false);
  assert.equal(allIntelligenceStr.includes("secret-val"), false);
  assert.equal(allIntelligenceStr.includes("my-secret"), false);
  assert.equal(allIntelligenceStr.includes("PRIVATE KEY"), false);
  assert.equal(allIntelligenceStr.includes("TLS KEY"), false);

  const structure = context.projectIntelligence.find((r) => r.name === "project_structure");
  assert.ok(structure);
  assert.equal(structure.value.includes(".env"), false);
  assert.equal(structure.value.includes("credentials.yaml"), false);
  assert.equal(structure.value.includes("secrets.json"), false);
  assert.equal(structure.value.includes("id_rsa"), false);
  assert.equal(structure.value.includes("server.key"), false);

  // Active file must not be read into intelligence
  const activeRecord = context.projectIntelligence.find((r) => r.name === "active_editor_file");
  assert.equal(activeRecord, undefined);

  // Open tabs must filter out .env
  const tabsRecord = context.projectIntelligence.find((r) => r.name === "open_editor_tabs");
  assert.ok(tabsRecord);
  assert.equal(tabsRecord.value.includes(".env"), false);
  assert.ok(tabsRecord.value.includes("src/safe.ts"));
});

test("MPA-5: Missing and inaccessible workspaces are handled safely without throwing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa5-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const wm = new WorkspaceManager(repo);

  // Case 1: EMPTY status (no workspace opened yet)
  assert.equal(wm.status, "EMPTY");
  const emptyContext = await wm.getProjectIntelligenceContext();
  assert.equal(emptyContext.workspaceState.status, "EMPTY");
  assert.equal(emptyContext.workspaceState.workspaceId, null);
  assert.equal(emptyContext.workspaceRoot, undefined);
  assert.deepEqual(emptyContext.toolMetadata, []);
  assert.ok(emptyContext.projectIntelligence.some((r) => r.name === "workspace_status"));

  // Case 2: UNAVAILABLE status (directory deleted while session recorded)
  const dirToDelete = path.join(root, "to-delete");
  await mkdir(dirToDelete);
  await wm.openWorkspace(dirToDelete);
  assert.equal(wm.status, "OPEN");

  // Delete from disk and simulate restore / unavailable check
  await rm(dirToDelete, { recursive: true, force: true });
  wm.restoreLastWorkspace();
  assert.equal(wm.status, "UNAVAILABLE");

  const unavailContext = await wm.getProjectIntelligenceContext();
  assert.equal(unavailContext.workspaceState.status, "UNAVAILABLE");
  assert.equal(unavailContext.workspaceRoot, undefined);
  assert.ok(unavailContext.projectIntelligence.some((r) => r.name === "workspace_status"));
});

test("MPA-6: Switched workspaces isolate intelligence atomically without bleed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa6-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const wm = new WorkspaceManager(repo);

  const dirA = path.join(root, "project-A");
  const dirB = path.join(root, "project-B");
  await mkdir(dirA);
  await mkdir(dirB);
  await writeFile(path.join(dirA, "package.json"), JSON.stringify({ name: "project-alpha" }));
  await writeFile(path.join(dirB, "package.json"), JSON.stringify({ name: "project-beta" }));

  // Open A
  const sessionA = await wm.openWorkspace(dirA);
  wm.saveUIState("alpha.ts", [{ path: "alpha.ts", name: "alpha.ts" }], []);
  const contextA = await wm.getProjectIntelligenceContext();
  assert.equal(contextA.workspaceRoot, sessionA.canonicalRootPath);
  assert.equal(contextA.projectName, "project-A");
  assert.ok(contextA.projectIntelligence.some((r) => r.value.includes("project-alpha")));

  // Switch to B
  const sessionB = await wm.openWorkspace(dirB);
  const contextB = await wm.getProjectIntelligenceContext();
  assert.equal(contextB.workspaceRoot, sessionB.canonicalRootPath);
  assert.equal(contextB.projectName, "project-B");
  assert.ok(contextB.projectIntelligence.some((r) => r.value.includes("project-beta")));

  // Zero bleed from A
  const allB = JSON.stringify(contextB);
  assert.equal(allB.includes("project-alpha"), false);
  assert.equal(allB.includes("alpha.ts"), false);
});

test("MPA-8: Closing the workspace removes project execution context even when a root was initially configured", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa8-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const projectDir = path.join(root, "configured-project");
  await mkdir(projectDir);

  const wm = new WorkspaceManager(repo, projectDir);
  assert.equal(wm.status, "OPEN");
  assert.ok((await wm.getProjectIntelligenceContext()).workspaceRoot);
  wm.closeWorkspace();

  const closedContext = await wm.getProjectIntelligenceContext();
  assert.equal(closedContext.workspaceRoot, undefined);
  assert.equal(closedContext.workspaceState.status, "EMPTY");
  assert.equal(closedContext.workspaceState.workspaceId, null);
});

test("MPA-9: Startup, restore, open, and switch use one canonical ID and preserve legacy records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa9-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const projectDir = path.join(root, "same-project");
  await mkdir(projectDir);
  const legacyId = "legacy-workspace-id";
  repo.upsert({ id: legacyId, canonicalPath: projectDir, displayName: "same-project", createdAt: 1, lastOpenedAt: 1, availability: "available" });
  repo.saveUIState({ workspaceId: legacyId, activeFile: "src/main.ts", openTabs: [], expandedPaths: [], updatedAt: 1, workbenchTabs: [], activeWorkbenchTabId: null });
  db.raw.prepare("INSERT INTO threads (id, workspace_id, title, created_at, updated_at, turns_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run("legacy-thread", legacyId, "Legacy thread", 1, 1, "[]");
  repo.setActiveWorkspaceId(legacyId);

  const restoredManager = new WorkspaceManager(repo);
  const restoredId = restoredManager.session?.workspaceId;
  assert.ok(restoredId);
  assert.notEqual(restoredId, legacyId);
  assert.equal(repo.get(legacyId), null);
  assert.equal(repo.getUIState(restoredId)?.activeFile, "src/main.ts");
  assert.equal((db.raw.prepare("SELECT workspace_id FROM threads WHERE id = ?").get("legacy-thread") as { workspace_id: string }).workspace_id, restoredId);

  const openedManager = new WorkspaceManager(repo, projectDir);
  assert.equal(openedManager.session?.workspaceId, restoredId);
  const switched = await openedManager.openWorkspace(projectDir);
  assert.equal(switched.workspaceId, restoredId);
});

test("MPA-10: A turn context remains bound to its captured workspace after a workspace switch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa10-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const wm = new WorkspaceManager(repo);
  const dirA = path.join(root, "project-A");
  const dirB = path.join(root, "project-B");
  await mkdir(dirA); await mkdir(dirB);
  await writeFile(path.join(dirA, "AGENTS.md"), "PROJECT_A_SENTINEL");
  await writeFile(path.join(dirB, "AGENTS.md"), "PROJECT_B_SENTINEL");

  const sessionA = await wm.openWorkspace(dirA);
  const contextPromise = wm.getProjectIntelligenceContext(sessionA);
  await wm.openWorkspace(dirB);
  const boundContext = await contextPromise;

  assert.equal(boundContext.workspaceRoot, sessionA.canonicalRootPath);
  assert.equal(boundContext.workspaceState.workspaceId, sessionA.workspaceId);
  assert.ok(boundContext.projectIntelligence.some((record) => record.value.includes("PROJECT_A_SENTINEL")));
  assert.equal(boundContext.projectIntelligence.some((record) => record.value.includes("PROJECT_B_SENTINEL")), false);
});

test("MPA-12: Switching projects while Maestro is deciding keeps delegated execution on the original session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa12-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const dirA = path.join(root, "project-A");
  const dirB = path.join(root, "project-B");
  await mkdir(dirA); await mkdir(dirB);
  await writeFile(path.join(dirA, "AGENTS.md"), "PROJECT_A_INSTRUCTIONS");
  await writeFile(path.join(dirB, "AGENTS.md"), "PROJECT_B_INSTRUCTIONS");
  const wm = new WorkspaceManager(repo);
  const sessionA = await wm.openWorkspace(dirA);

  let signalDecisionStarted!: () => void;
  const decisionStarted = new Promise<void>((resolve) => { signalDecisionStarted = resolve; });
  let releaseDecision!: () => void;
  const decisionGate = new Promise<void>((resolve) => { releaseDecision = resolve; });
  let submittedOptions: Record<string, unknown> | undefined;
  const app = await startCommandCenter({
    workspaceManager: wm,
    databasePath: path.join(root, "server.db"),
    historyStore: new LocalHistoryStore(undefined, new ChatRepository(db.raw)),
    vite: false,
    listen: false,
    composition: {
      world: { id: "test-world", inspect: () => ({ definitions: [], workers: [], tasks: [], evidence: [], goals: [] }) } as never,
      submission: {} as never,
      definitions: [
        { id: "definition-maestro" as never, name: "Maestro", group: "orchestrator", role: "Team orchestration", summary: "Lead", availability: "available", executable: true },
        { id: "definition-cody" as never, name: "Cody", group: "specialist", role: "Coding", summary: "Build", availability: "available", executable: true },
      ],
      visionDefinitionId: "def-vision" as never,
      maestroDefinitionId: "definition-maestro" as never,
      codyDefinitionId: "definition-cody" as never,
      projects: { list: async () => [] } as never,
      taskEvents: new Map(),
      subscribers: new Map(),
      taskErrors: new Map(),
      publish: () => {},
      snapshotTask: () => undefined,
      decideMaestroTurn: async () => {
        signalDecisionStarted();
        await decisionGate;
        return { type: "delegate", definitionId: "definition-cody", objective: "Inspect project", relevantContextRefs: [],
          constraints: [], expectedOutcome: "Report findings", evidenceExpectations: [] };
      },
      submit: (_definitionId, _goal, options) => {
        submittedOptions = options as Record<string, unknown>;
        return { taskId: "task-bound-to-a" as never, result: Promise.resolve({ state: "completed" } as never) };
      },
      cancel: () => {},
      mapWorldEvent: () => {},
      mapVisionProgress: () => {},
      browserRuntime: {} as never,
      shutdown: async () => {},
    },
  });
  t.after(() => app.close());

  const responsePromise = request(app, "POST", "/api/turns", JSON.stringify({
    threadId: "switch-during-turn", turnId: "turn-a", definitionId: "definition-maestro", prompt: "Inspect this project.",
  }));
  await decisionStarted;
  const sessionB = await wm.openWorkspace(dirB);
  assert.notEqual(sessionA.workspaceId, sessionB.workspaceId);
  releaseDecision();
  const response = await responsePromise;

  assert.equal(response.status, 202);
  assert.equal(submittedOptions?.workspaceRoot, sessionA.canonicalRootPath);
  assert.equal(submittedOptions?.workspaceId, sessionA.workspaceId);
  assert.equal((submittedOptions?.workspaceState as Record<string, unknown>).workspaceId, sessionA.workspaceId);
});

test("MPA-7: End-to-End POST /api/turns delivers canonical workspace intelligence to Maestro", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa7-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const wm = new WorkspaceManager(repo);

  const projectDir = path.join(root, "demo-app");
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  await writeFile(path.join(projectDir, "src", "server.ts"), "export const port = 3000;\n");
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "demo-app", type: "module" }));
  await writeFile(path.join(projectDir, "AGENTS.md"), "Project instruction: follow strict standards.\n");

  await wm.openWorkspace(projectDir);
  wm.saveUIState("src/server.ts", [{ path: "src/server.ts", name: "server.ts" }], []);

  let receivedGoal = "";
  let receivedTurnOptions: Record<string, unknown> | undefined;

  const app = await startCommandCenter({
    workspaceRoot: projectDir,
    workspaceManager: wm,
    databasePath: path.join(root, "server.db"),
    historyStore: new LocalHistoryStore(undefined, new ChatRepository(db.raw)),
    vite: false,
    listen: false,
    composition: {
      world: { id: "test-world", inspect: () => ({ definitions: [], workers: [], tasks: [], evidence: [], goals: [] }) } as never,
      submission: {} as never,
      definitions: [{ id: "definition-maestro" as never, name: "Maestro", group: "orchestrator", role: "Team orchestration", summary: "Lead", availability: "available", executable: true }],
      visionDefinitionId: "def-vision" as never,
      maestroDefinitionId: "definition-maestro" as never,
      codyDefinitionId: "definition-cody" as never,
      projects: { list: async () => [] } as never,
      taskEvents: new Map(),
      subscribers: new Map(),
      taskErrors: new Map(),
      publish: () => {},
      snapshotTask: () => undefined,
      decideMaestroTurn: async (goal, options) => {
        receivedGoal = goal;
        receivedTurnOptions = options;
        return { type: "respond", message: "Inspected the project successfully.", basis: "conversation", evidenceRefs: [] };
      },
      submit: () => { throw new Error("Should not be called for direct response"); },
      cancel: () => {},
      mapWorldEvent: () => {},
      mapVisionProgress: () => {},
      browserRuntime: {} as never,
      shutdown: async () => {},
    },
  });
  t.after(() => app.close());

  const turnRes = await request(app, "POST", "/api/turns", JSON.stringify({
    threadId: "test-thread",
    turnId: "turn-1",
    prompt: "What is this project about?",
  }));

  assert.ok([200, 202].includes(turnRes.status));
  assert.equal(receivedGoal, "What is this project about?");
  assert.ok(receivedTurnOptions, "turnOptions must be passed to decideMaestroTurn");

  // Verify Maestro received canonical workspace root
  assert.equal(receivedTurnOptions.workspaceRoot, wm.session?.canonicalRootPath);
  assert.equal(receivedTurnOptions.projectName, "demo-app");

  // Verify Maestro received workspaceState
  const wsState = receivedTurnOptions.workspaceState as Record<string, unknown>;
  assert.ok(wsState);
  assert.equal(wsState.status, "OPEN");
  assert.equal(wsState.rootPath, wm.session?.canonicalRootPath);
  assert.equal(wsState.activeFile, "src/server.ts");

  // Verify Maestro received projectIntelligence
  const intel = receivedTurnOptions.projectIntelligence as Array<{ name: string; value: string }>;
  assert.ok(Array.isArray(intel));
  assert.ok(intel.some((r) => r.name === "project_structure" && r.value.includes("src/")));
  assert.ok(intel.some((r) => r.name === "project_instructions" && r.value.includes("follow strict standards")));
  assert.ok(intel.some((r) => r.name === "active_editor_file" && r.value.includes("export const port = 3000")));

  // Verify toolMetadata reached Maestro
  const tools = receivedTurnOptions.toolMetadata as Array<{ name: string }>;
  assert.ok(Array.isArray(tools));
  assert.ok(tools.some((t) => t.name === "filesystem.list"));
  assert.ok(tools.some((t) => t.name === "filesystem.read"));
  assert.ok(tools.some((t) => t.name === "filesystem.write"));
  assert.ok(tools.some((t) => t.name === "terminal.execute"));
});

test("MPA-11: A closed configured workspace allows conversation but not project execution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-mpa11-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });
  const repo = new WorkspaceRepository(db.raw);
  const configuredProject = path.join(root, "configured-project");
  await mkdir(configuredProject);
  const wm = new WorkspaceManager(repo, configuredProject);
  const configuredWorkspaceId = wm.session!.workspaceId;
  const historyStore = new LocalHistoryStore(undefined, new ChatRepository(db.raw));
  await historyStore.saveMetadata({ id: "project-bound-thread", projectId: configuredWorkspaceId, title: "Project thread" });
  wm.closeWorkspace();
  let receivedOptions: Record<string, unknown> | undefined;
  let submitCalled = false;
  const app = await startCommandCenter({
    workspaceRoot: configuredProject,
    workspaceManager: wm,
    databasePath: path.join(root, "server.db"),
    historyStore,
    vite: false,
    listen: false,
    composition: {
      world: { id: "test-world", inspect: () => ({ definitions: [], workers: [], tasks: [], evidence: [], goals: [] }) } as never,
      submission: {} as never,
      definitions: [{ id: "definition-maestro" as never, name: "Maestro", group: "orchestrator", role: "Team orchestration", summary: "Lead", availability: "available", executable: true }],
      visionDefinitionId: "def-vision" as never,
      maestroDefinitionId: "definition-maestro" as never,
      codyDefinitionId: "definition-cody" as never,
      projects: { list: async () => [] } as never,
      taskEvents: new Map(),
      subscribers: new Map(),
      taskErrors: new Map(),
      publish: () => {},
      snapshotTask: () => undefined,
      decideMaestroTurn: async (_goal, options) => {
        receivedOptions = options;
        return { type: "respond", message: "I can answer without opening a project.", basis: "conversation", evidenceRefs: [] };
      },
      submit: () => { submitCalled = true; throw new Error("Project execution must not start without a workspace"); },
      cancel: () => {},
      mapWorldEvent: () => {},
      mapVisionProgress: () => {},
      browserRuntime: {} as never,
      shutdown: async () => {},
    },
  });
  t.after(() => app.close());

  const response = await request(app, "POST", "/api/turns", JSON.stringify({
    threadId: "workspace-independent-thread", turnId: "workspace-independent-turn", prompt: "Explain your capabilities.",
  }));
  assert.ok([200, 202].includes(response.status));
  assert.equal((receivedOptions as Record<string, unknown>).workspaceExecutionAuthorized, false);
  assert.equal(Object.hasOwn(receivedOptions, "workspaceRoot"), false);
  assert.equal(submitCalled, false);

  receivedOptions = undefined;
  const projectConversation = await request(app, "POST", "/api/turns", JSON.stringify({
    threadId: "project-bound-thread", turnId: "closed-project-conversation", prompt: "Why did the last project task fail?",
  }));
  assert.ok([200, 202].includes(projectConversation.status));
  assert.equal((receivedOptions as Record<string, unknown>).workspaceExecutionAuthorized, false);
  assert.equal(Object.hasOwn(receivedOptions, "workspaceRoot"), false);
  assert.equal(((receivedOptions as Record<string, unknown>).workspaceState as { status: string }).status, "EMPTY");
  assert.equal(submitCalled, false, "A closed project thread may converse, but cannot silently execute against another root");

  const taskResponse = await request(app, "POST", "/api/tasks", JSON.stringify({
    definitionId: "definition-maestro", goal: "Run project-bound work.",
  }));
  assert.equal(taskResponse.status, 409);
  assert.equal(((taskResponse.body as { error: { code: string } }).error).code, "workspace-required");
  assert.equal(submitCalled, false);
});

/**
 * gate-g06-g07-integrated.test.ts
 *
 * Integrated verification suite for:
 * - Gate G06: Real Project Operations (Scoping, OS metadata filtering, traversal/symlink 403 defenses)
 * - Gate G07: Real Project File Mutations (Unified FileLockManager, CAS verification, watcher own-write echo suppression)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { createWorld, type ResourceId, type TaskId, type WorkerId } from "@mediobot-v2/domain";
import { ToolRuntime, defaultFileLockManager, FileLockManager } from "@mediobot-v2/tools";
import { isOSMetadata, PathEscapeForbiddenError, FileLockTimeoutError, type WorkspaceWatchEvent } from "@mediobot-v2/contracts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { WorkspaceRepository } from "../../src/storage/workspaceRepository.ts";
import { WorkspaceManager } from "../../src/workspaceManager.ts";
import { WorkspaceWatcher, globalOwnWriteRegistry } from "../../src/watcher/workspaceWatcher.ts";
import { startCommandCenter } from "../../src/server.ts";

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

async function request(app: Awaited<ReturnType<typeof startCommandCenter>>, method: string, url: string, bodyObj?: unknown) {
  const bodyText = bodyObj !== undefined ? (typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj)) : undefined;
  const req = Object.assign(Readable.from(bodyText ? [bodyText] : []), new EventEmitter(), { method, url, headers: {} });
  const res = new FakeResponse();
  const finished = new Promise<void>((resolve) => res.once("finish", resolve));
  await app.handle(req as never, res as never);
  await finished;
  let json: any = undefined;
  try {
    json = JSON.parse(res.output);
  } catch {}
  return { status: res.statusCode, body: json, text: res.output };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function setupWorldWorker(world: ReturnType<typeof createWorld>) {
  const definition = world.registerMediobotDefinition({
    name: "Worker", role: "test", version: "1", instructions: "test", declaredCapabilities: [],
  });
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask("task").id, worker.id);
  const resource = world.registerResource({
    kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: worker.id },
  });
  world.setWorkerState(worker.id, "busy");
  world.setTaskState(task.id, "running");
  world.setResourceState(resource.id, "in-use");
  return { workerId: worker.id, taskId: task.id, resourceId: resource.id };
}

// ============================================================================
// 1. Gate G06: OS Metadata Filtering in filesystem.list and filesystem.search
// ============================================================================
test("G06: OS metadata files (.DS_Store, Thumbs.db, ._*) are filtered from directory listing and search", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g06-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Populate workspace with real files and OS metadata files
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "index.ts"), "export const hello = 'world';\n");
  await writeFile(path.join(root, ".DS_Store"), "macos-metadata-binary-content");
  await writeFile(path.join(root, "Thumbs.db"), "windows-thumbnail-cache");
  await writeFile(path.join(root, "desktop.ini"), "icon-config");
  await writeFile(path.join(root, "._index.ts"), "apple-double-fork");

  // Subfolder with OS metadata
  const subDir = path.join(root, "src");
  await mkdir(subDir);
  await writeFile(path.join(subDir, "app.ts"), "export const app = 1;\n");
  await writeFile(path.join(subDir, ".DS_Store"), "sub-metadata");

  const world = createWorld();
  const { workerId, taskId, resourceId } = setupWorldWorker(world);
  const tools = new ToolRuntime(world);
  await tools.bindWorkspace(resourceId, root);

  // Verify filesystem.list filters OS metadata
  const listResult = await tools.invoke({
    name: "filesystem.list",
    input: { path: "." },
    worldId: world.id, workerId, taskId, resourceId,
  });

  assert.equal(listResult.status, "succeeded");
  const entries = (listResult.output as unknown as { entries: string[] }).entries;
  assert.ok(entries.includes("package.json"), "Must include regular files");
  assert.ok(entries.includes("index.ts"), "Must include regular files");
  assert.ok(entries.includes("src"), "Must include directories");
  assert.equal(entries.includes(".DS_Store"), false, ".DS_Store must be excluded");
  assert.equal(entries.includes("Thumbs.db"), false, "Thumbs.db must be excluded");
  assert.equal(entries.includes("desktop.ini"), false, "desktop.ini must be excluded");
  assert.equal(entries.includes("._index.ts"), false, "._* AppleDouble files must be excluded");

  // Verify filesystem.search filters OS metadata
  const searchResult = await tools.invoke({
    name: "filesystem.search",
    input: { query: "metadata" },
    worldId: world.id, workerId, taskId, resourceId,
  });

  assert.equal(searchResult.status, "succeeded");
  const matches = (searchResult.output as unknown as { matches: Array<{ path: string }> }).matches;
  assert.equal(matches.length, 0, "OS metadata files must never match search queries");

  // Verify WorkspaceManager.listFiles also filters .DS_Store
  const db = new LocalDatabase(path.join(root, "db.sqlite"));
  t.after(() => { try { db.close(); } catch {} });
  const wm = new WorkspaceManager(new WorkspaceRepository(db.raw), root);
  const wmEntries = await wm.listFiles("");
  const fileNames = wmEntries.map((e) => e.name);
  assert.equal(fileNames.includes(".DS_Store"), false, "WorkspaceManager must filter .DS_Store");
  assert.equal(fileNames.includes("Thumbs.db"), false, "WorkspaceManager must filter Thumbs.db");
});

// ============================================================================
// 2. Gate G07: Cross-Subsystem Mutual Exclusion & Content-Hash CAS Conflict Detection
// ============================================================================
test("G07: Simultaneous same-file writes between Editor and Agent detect CAS conflict; exactly one succeeds", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g07-cas-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const filePath = path.join(root, "shared.ts");
  const initialContent = "export const state = 'initial';\n";
  await writeFile(filePath, initialContent);
  const h0 = sha256(initialContent);

  const sharedLockManager = new FileLockManager();
  const db = new LocalDatabase(path.join(root, "test.sqlite"));
  t.after(() => { try { db.close(); } catch {} });

  const wm = new WorkspaceManager(new WorkspaceRepository(db.raw), root, {
    fileLockManager: sharedLockManager,
  });

  const world = createWorld();
  const { workerId, taskId, resourceId } = setupWorldWorker(world);
  const tools = new ToolRuntime(world, {
    fileLockManager: sharedLockManager,
    onWriteCommitted: (target, hash) => {
      globalOwnWriteRegistry.recordWrite(target, hash, "agent");
    },
  });
  await tools.bindWorkspace(resourceId, root);

  // Concurrently attempt two conflicting writes against initial hash h0
  const editorPromise = wm.writeFile("shared.ts", "export const state = 'editor-saved';\n", h0);
  const agentPromise = tools.invoke({
    name: "filesystem.write",
    input: {
      path: "shared.ts",
      content: "export const state = 'agent-saved';\n",
      expectedContentHash: h0,
    },
    worldId: world.id, workerId, taskId, resourceId,
  });

  const [editorResult, agentResult] = await Promise.allSettled([editorPromise, agentPromise]);

  const editorSucceeded = editorResult.status === "fulfilled";
  const agentSucceeded = agentResult.status === "fulfilled" && agentResult.value.status === "succeeded";

  // Exactly one must succeed, and the other must reject with conflict
  assert.equal(
    Number(editorSucceeded) + Number(agentSucceeded),
    1,
    "Exactly one conflicting write must succeed under the shared lock"
  );

  if (editorSucceeded) {
    assert.equal(agentResult.status === "fulfilled" && agentResult.value.status === "failed", true);
    assert.ok(
      typeof (agentResult as any).value.error === "string" &&
      ((agentResult as any).value.error.includes("STALE_REVISION") ||
       (agentResult as any).value.error.includes("conflict")),
      "Agent write must fail with STALE_REVISION conflict"
    );
  } else {
    assert.equal(editorResult.status, "rejected");
    assert.equal((editorResult as PromiseRejectedResult).reason.message, "file-conflict");
  }

  // Verify short 16-char hex expectedHash works seamlessly in WorkspaceManager
  const updatedContent = await readFile(filePath, "utf8");
  const updatedHash = sha256(updatedContent);
  const shortHash = updatedHash.slice(0, 16);

  const nextSave = await wm.writeFile("shared.ts", "export const state = 'next';\n", shortHash);
  assert.ok(nextSave.hash, "16-character short hex expectedHash must be accepted");
  assert.equal(await readFile(filePath, "utf8"), "export const state = 'next';\n");
});

// ============================================================================
// 3. Gate G07: Watcher Own-Write Reconciliation & Echo Suppression
// ============================================================================
test("G07: WorkspaceWatcher tags internal writes and suppresses temporary file noise", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g07-watcher-echo-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const testFile = path.join(root, "echo.txt");
  await writeFile(testFile, "initial\n");
  const h0 = sha256("initial\n");

  const events: WorkspaceWatchEvent[] = [];
  const watcher = new WorkspaceWatcher(root, (batch) => events.push(...batch), 30);
  t.after(() => watcher.close());

  const db = new LocalDatabase(path.join(root, "watcher.sqlite"));
  t.after(() => { try { db.close(); } catch {} });

  const wm = new WorkspaceManager(new WorkspaceRepository(db.raw), root);

  // 1. Editor Write: Should be tagged with origin="editor" and contentHash
  await wm.writeFile("echo.txt", "editor modified\n", h0);

  await waitFor(() => events.some((e) => e.relativePath === "echo.txt" && e.origin === "editor"), 2000);
  const editorEvent = events.find((e) => e.relativePath === "echo.txt" && e.origin === "editor")!;
  assert.equal(editorEvent.origin, "editor");
  assert.equal(editorEvent.contentHash, sha256("editor modified\n"));

  // Settle all debounce events before testing temp file noise
  await new Promise((r) => setTimeout(r, 100));
  events.length = 0;

  // 2. Temporary file filtering: ToolRuntime temporary files (.tmp.*) must be completely silent
  const tmpFile = path.join(root, `.tmp.${randomUUID()}.temp-scratch.ts`);
  await writeFile(tmpFile, "temporary content");
  await rm(tmpFile);

  const mediobotTmp = path.join(root, `.mediobot-${randomUUID()}.tmp`);
  await writeFile(mediobotTmp, "mediobot temporary");
  await rm(mediobotTmp);

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.length, 0, "No watcher events should ever be emitted for .tmp.* or .mediobot-*.tmp files");
});

// ============================================================================
// 4. Gate G06: Path Traversal & Symlink Escapes Denied with HTTP 403 Forbidden
// ============================================================================
test("G06: Path traversal and symlink escapes return HTTP 403 Forbidden", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g06-traversal-403-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectDir = path.join(root, "project");
  const outsideDir = path.join(root, "outside");
  await mkdir(projectDir);
  await mkdir(outsideDir);

  await writeFile(path.join(projectDir, "inside.txt"), "hello inside");
  await writeFile(path.join(outsideDir, "secret.txt"), "super secret");

  // Create symlinks inside project pointing outside
  let symlinkCreated = false;
  try {
    await symlink(outsideDir, path.join(projectDir, "symlink-dir"), process.platform === "win32" ? "junction" : "dir");
    await symlink(path.join(outsideDir, "secret.txt"), path.join(projectDir, "symlink-file.txt"), "file");
    symlinkCreated = true;
  } catch {}

  const dbPath = path.join(root, "server.sqlite");
  const app = await startCommandCenter({
    databasePath: dbPath,
    workspaceRoot: projectDir,
    listen: false,
  });
  t.after(() => app.close());

  const sessionRes = await request(app, "GET", "/api/workspace");
  assert.equal(sessionRes.status, 200);
  const projectId = sessionRes.body.session.workspaceId;

  // 1. Path traversal GET /api/projects/:id/files?path=../
  const traversalList = await request(app, "GET", `/api/projects/${projectId}/files?path=../`);
  assert.equal(traversalList.status, 403, "Directory traversal must return HTTP 403 Forbidden");
  assert.equal(traversalList.body?.error?.code, "FORBIDDEN");

  // 2. Path traversal GET /api/projects/:id/file?path=../outside/secret.txt
  const traversalFile = await request(app, "GET", `/api/projects/${projectId}/file?path=../outside/secret.txt`);
  assert.equal(traversalFile.status, 403, "File read traversal must return HTTP 403 Forbidden");
  assert.equal(traversalFile.body?.error?.code, "FORBIDDEN");

  // 3. Path traversal PUT /api/projects/:id/file with traversal path
  const traversalWrite = await request(app, "PUT", `/api/projects/${projectId}/file`, {
    path: "../outside/injected.txt",
    content: "malicious write",
    expectedHash: sha256(""),
  });
  assert.equal(traversalWrite.status, 403, "File write traversal must return HTTP 403 Forbidden");
  assert.equal(traversalWrite.body?.error?.code, "FORBIDDEN");

  // 4. Symlink escape GET /api/projects/:id/files?path=symlink-dir
  if (symlinkCreated) {
    const symlinkList = await request(app, "GET", `/api/projects/${projectId}/files?path=symlink-dir`);
    assert.equal(symlinkList.status, 403, "Symlink escape in file listing must return HTTP 403 Forbidden");
    assert.equal(symlinkList.body?.error?.code, "FORBIDDEN");

    const symlinkRead = await request(app, "GET", `/api/projects/${projectId}/file?path=symlink-file.txt`);
    assert.equal(symlinkRead.status, 403, "Symlink escape in file reading must return HTTP 403 Forbidden");
    assert.equal(symlinkRead.body?.error?.code, "FORBIDDEN");
  }
});

// ============================================================================
// 5. Gate G06: ExecutionScope Immutable Binding Across Project Switches
// ============================================================================
test("G06: ExecutionScope is instantiated at turn submission and immutably binds workspace context", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g06-executionscope-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectA = path.join(root, "project-alpha");
  const projectB = path.join(root, "project-beta");
  await mkdir(projectA);
  await mkdir(projectB);
  await writeFile(path.join(projectA, "alpha.txt"), "Alpha Project");
  await writeFile(path.join(projectB, "beta.txt"), "Beta Project");

  const canonicalA = realpathSync(projectA);
  const canonicalB = realpathSync(projectB);

  let capturedSubmitOptions: any = undefined;
  const mockComposition: any = {
    maestroDefinitionId: "maestro",
    definitions: [{ id: "maestro", name: "Maestro" }],
    world: createWorld(),
    subscribers: new Map(),
    submit: (_defId: string, _prompt: string, turnOptions: any, onCreated?: (id: string) => void) => {
      capturedSubmitOptions = turnOptions;
      const taskId = "task-alpha-123";
      onCreated?.(taskId);
      return { taskId, result: Promise.resolve({ state: "completed" }) };
    },
  };

  const dbPath = path.join(root, "server-scope.sqlite");
  const app = await startCommandCenter({
    databasePath: dbPath,
    workspaceRoot: projectA,
    composition: mockComposition,
    listen: false,
  });
  t.after(() => app.close());

  // Create a conversation thread
  const threadId = "thread-alpha-1";
  const threadRes = await request(app, "POST", "/api/threads", {
    thread: { id: threadId, title: "Alpha Work" },
  });
  assert.equal(threadRes.status, 200);

  // Submit turn under Project Alpha
  const turnRes = await request(app, "POST", "/api/turns", {
    threadId,
    turnId: "turn-alpha-1",
    prompt: "Inspect project structure",
  });
  assert.equal(turnRes.status, 202);

  // Verify ExecutionScope was attached
  assert.ok(capturedSubmitOptions?.executionScope, "ExecutionScope must be attached to turnOptions");
  const scope = capturedSubmitOptions.executionScope;
  assert.equal(scope.workspaceRoot, canonicalA);
  assert.equal(scope.canonicalRoot, canonicalA);
  assert.equal(scope.threadId, threadId);
  assert.equal(scope.turnId, "turn-alpha-1");
  assert.equal(scope.scopeType, "team");
  assert.equal(scope.authorizationScope, "standard_mutation");

  // Now switch workspace to Project Beta
  const switchRes = await request(app, "POST", "/api/workspace/open", { path: projectB });
  assert.equal(switchRes.status, 200);

  // Verify that the captured scope for Alpha's task remained completely unchanged
  assert.equal(scope.canonicalRoot, canonicalA, "Submission-time execution scope must remain anchored to Project Alpha");
  assert.notEqual(scope.canonicalRoot, canonicalB);
});

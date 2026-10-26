/**
 * adversarial-g06-escape-fuzzing.test.ts
 *
 * EMPIRICAL ADVERSARIAL STRESS SUITE FOR GATE G06:
 * 1. Comprehensive Path Traversal Fuzzing across server.ts routes (GET files, GET file, PUT file, POST entries, PATCH entries, DELETE entries)
 *    testing root escapes, URL-encoding, absolute paths, null bytes, backslashes, mixed separators.
 * 2. ToolRuntime.filesystem Traversal & Boundary Fuzzing (list, read, write, edit, search).
 * 3. Symlink Escape Attacks (external dir, external file, /etc, /etc/passwd, nested symlinks, internal symlinks, broken symlinks).
 * 4. OS Metadata Fuzzing & Exclusion (.DS_Store, .ds_store, THUMBS.DB, desktop.ini, ._AppleDouble, .fseventsd, empty folders with metadata only).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { createWorld } from "@mediobot-v2/domain";
import { ToolRuntime } from "@mediobot-v2/tools";
import { PathEscapeForbiddenError, isOSMetadata } from "@mediobot-v2/contracts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { WorkspaceRepository } from "../../src/storage/workspaceRepository.ts";
import { WorkspaceManager } from "../../src/workspaceManager.ts";
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

function setupWorldWorker(world: ReturnType<typeof createWorld>) {
  const definition = world.registerMediobotDefinition({
    name: "Cody", role: "swe", version: "1", instructions: "coding", declaredCapabilities: [],
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
// STRESS TEST 1: Path Traversal Fuzzing across server.ts HTTP Routes
// ============================================================================
test("ADVERSARIAL 1: Path traversal fuzzing on server.ts routes returns HTTP 403 with code FORBIDDEN", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g06-fuzz-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectDir = path.join(root, "project");
  await mkdir(projectDir);
  await writeFile(path.join(projectDir, "legit.txt"), "legitimate content");

  const dbPath = path.join(root, "server-fuzz.sqlite");
  const app = await startCommandCenter({
    databasePath: dbPath,
    workspaceRoot: projectDir,
    listen: false,
  });
  t.after(() => app.close());

  const sessionRes = await request(app, "GET", "/api/workspace");
  assert.equal(sessionRes.status, 200);
  const projectId = sessionRes.body.session.workspaceId;

  // Comprehensive array of traversal payloads
  const traversalPayloads = [
    "../",
    "../../",
    "../../../",
    "../../../../../../etc/passwd",
    "..",
    "/etc/passwd",
    "/private/var",
    "/private/etc/hosts",
    "/tmp",
    "/Users",
    "C:\\Windows\\System32",
    "C:/Windows",
    "D:/secret.txt",
    "\\\\localhost\\c$\\windows",
    "legit.txt\0.js",
    "sub/\0../secret",
    "..\\..\\outside.txt",
    "foo/..\\..\\outside.txt",
    "foo/../../outside.txt",
    "legit.txt/../../outside.txt",
    "%2e%2e%2f",
    "%2e%2e/",
    "..%2f",
    "%2e%2e%5c",
  ];

  for (const payload of traversalPayloads) {
    const queryParam = payload.startsWith("%") || payload.includes("%") ? payload : encodeURIComponent(payload);
    // 1. GET /api/projects/:id/files?path=...
    const getFilesRes = await request(app, "GET", `/api/projects/${projectId}/files?path=${queryParam}`);
    assert.equal(
      getFilesRes.status,
      403,
      `GET files traversal with payload "${payload}" must return 403, got ${getFilesRes.status}: ${getFilesRes.text}`
    );
    assert.equal(getFilesRes.body?.error?.code, "FORBIDDEN");

    // 2. GET /api/projects/:id/file?path=...
    const getFileRes = await request(app, "GET", `/api/projects/${projectId}/file?path=${queryParam}`);
    assert.equal(
      getFileRes.status,
      403,
      `GET file traversal with payload "${payload}" must return 403, got ${getFileRes.status}: ${getFileRes.text}`
    );
    assert.equal(getFileRes.body?.error?.code, "FORBIDDEN");

    // 3. PUT /api/projects/:id/file with body { path: payload }
    const putFileRes = await request(app, "PUT", `/api/projects/${projectId}/file`, {
      path: payload,
      content: "injected payload",
      expectedHash: sha256(""),
    });
    assert.equal(
      putFileRes.status,
      403,
      `PUT file traversal with payload "${payload}" must return 403, got ${putFileRes.status}: ${putFileRes.text}`
    );
    assert.equal(putFileRes.body?.error?.code, "FORBIDDEN");

    // 4. POST /api/projects/:id/files with parentPath: payload
    const postEntryRes = await request(app, "POST", `/api/projects/${projectId}/files`, {
      parentPath: payload,
      name: "injected.txt",
      type: "file",
    });
    assert.equal(
      postEntryRes.status,
      403,
      `POST files parentPath traversal with payload "${payload}" must return 403, got ${postEntryRes.status}: ${postEntryRes.text}`
    );
    assert.equal(postEntryRes.body?.error?.code, "FORBIDDEN");

    // 5. PATCH /api/projects/:id/files with path: payload
    const patchEntryRes = await request(app, "PATCH", `/api/projects/${projectId}/files`, {
      path: payload,
      name: "newname.txt",
    });
    // Either 403 (traversal detected) or 400 (invalid item name/path format) — NEVER 200 or 500
    assert.ok(
      patchEntryRes.status === 403 || patchEntryRes.status === 400,
      `PATCH files path traversal with payload "${payload}" must fail with 403 or 400, got ${patchEntryRes.status}: ${patchEntryRes.text}`
    );
    if (patchEntryRes.status === 403) {
      assert.equal(patchEntryRes.body?.error?.code, "FORBIDDEN");
    }

    // 6. DELETE /api/projects/:id/files with path: payload
    const deleteEntryRes = await request(app, "DELETE", `/api/projects/${projectId}/files`, {
      path: payload,
    });
    assert.ok(
      deleteEntryRes.status === 403 || deleteEntryRes.status === 400,
      `DELETE files path traversal with payload "${payload}" must fail with 403 or 400, got ${deleteEntryRes.status}: ${deleteEntryRes.text}`
    );
    if (deleteEntryRes.status === 403) {
      assert.equal(deleteEntryRes.body?.error?.code, "FORBIDDEN");
    }
  }
});

// ============================================================================
// STRESS TEST 2: ToolRuntime.filesystem Traversal & Boundary Stress Fuzzing
// ============================================================================
test("ADVERSARIAL 2: ToolRuntime.filesystem strictly denies traversal and absolute paths with FORBIDDEN", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g06-fuzz-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, "valid.txt"), "valid content\n");

  const world = createWorld();
  const { workerId, taskId, resourceId } = setupWorldWorker(world);
  const tools = new ToolRuntime(world);
  await tools.bindWorkspace(resourceId, root);

  const payloads = [
    "../",
    "../../",
    "../../../etc/passwd",
    "/etc/passwd",
    "/private/var",
    "/tmp",
    "C:\\Windows\\System32",
    "D:/outside.txt",
    "valid.txt\0.evil",
    "..\\..\\outside",
    "sub/../../outside",
    "foo/..\\..\\outside",
  ];

  for (const payload of payloads) {
    // 1. filesystem.list
    const listRes = await tools.invoke({
      name: "filesystem.list",
      input: { path: payload },
      worldId: world.id, workerId, taskId, resourceId,
    });
    assert.equal(listRes.status, "failed", `filesystem.list with "${payload}" must fail`);
    assert.equal((listRes as any).errorCode, "FORBIDDEN");

    // 2. filesystem.read
    const readRes = await tools.invoke({
      name: "filesystem.read",
      input: { path: payload },
      worldId: world.id, workerId, taskId, resourceId,
    });
    assert.equal(readRes.status, "failed", `filesystem.read with "${payload}" must fail`);
    assert.equal((readRes as any).errorCode, "FORBIDDEN");

    // 3. filesystem.write
    const writeRes = await tools.invoke({
      name: "filesystem.write",
      input: { path: payload, content: "malicious write" },
      worldId: world.id, workerId, taskId, resourceId,
    });
    assert.equal(writeRes.status, "failed", `filesystem.write with "${payload}" must fail`);
    assert.equal((writeRes as any).errorCode, "FORBIDDEN");

    // 4. filesystem.edit
    const editRes = await tools.invoke({
      name: "filesystem.edit",
      input: { path: payload, edits: [{ oldText: "a", newText: "b" }] },
      worldId: world.id, workerId, taskId, resourceId,
    });
    assert.equal(editRes.status, "failed", `filesystem.edit with "${payload}" must fail`);
    assert.equal((editRes as any).errorCode, "FORBIDDEN");

    // 5. filesystem.search with path: payload
    const searchRes = await tools.invoke({
      name: "filesystem.search",
      input: { query: "test", path: payload },
      worldId: world.id, workerId, taskId, resourceId,
    });
    assert.equal(searchRes.status, "failed", `filesystem.search with "${payload}" must fail`);
    assert.equal((searchRes as any).errorCode, "FORBIDDEN");
  }
});

// ============================================================================
// STRESS TEST 3: Symlink Escape Attacks across all subsystems
// ============================================================================
test("ADVERSARIAL 3: Symlink escapes (external dir, external file, /etc, nested, internal, broken) are strictly blocked", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g06-symlink-stress-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectDir = path.join(root, "project");
  const outsideDir = path.join(root, "outside");
  await mkdir(projectDir);
  await mkdir(outsideDir);

  await writeFile(path.join(projectDir, "inside.txt"), "safe inside file");
  await writeFile(path.join(outsideDir, "external.txt"), "super-sensitive-outside-token");

  // Create subdirectories inside project
  const nestedDir = path.join(projectDir, "nested", "deep");
  await mkdir(nestedDir, { recursive: true });

  // Create various symlinks
  let symlinksSupported = false;
  try {
    // 1. Directory symlink pointing to external folder
    await symlink(outsideDir, path.join(projectDir, "symlink-outside-dir"), process.platform === "win32" ? "junction" : "dir");
    // 2. Directory symlink pointing to /etc
    await symlink("/etc", path.join(projectDir, "symlink-etc-dir"), process.platform === "win32" ? "junction" : "dir");
    // 3. File symlink pointing to external file
    await symlink(path.join(outsideDir, "external.txt"), path.join(projectDir, "symlink-file.txt"), "file");
    // 4. File symlink pointing to /etc/passwd
    await symlink("/etc/passwd", path.join(projectDir, "symlink-passwd"), "file");
    // 5. Nested directory symlink pointing outside
    await symlink(outsideDir, path.join(nestedDir, "symlink-nested-outside"), process.platform === "win32" ? "junction" : "dir");
    // 6. Internal symlink (pointing inside workspace)
    await symlink(path.join(projectDir, "inside.txt"), path.join(projectDir, "symlink-internal.txt"), "file");
    // 7. Broken / dangling symlink
    await symlink(path.join(root, "non-existent-file-404"), path.join(projectDir, "symlink-dangling"), "file");
    symlinksSupported = true;
  } catch (err) {
    console.warn("Symlinks cannot be created in this environment; skipping symlink creation checks:", err);
  }

  if (!symlinksSupported) return;

  // A. Verify WorkspaceManager directly blocks all symlinks
  const db = new LocalDatabase(path.join(root, "wm-symlink.sqlite"));
  t.after(() => { try { db.close(); } catch {} });
  const wm = new WorkspaceManager(new WorkspaceRepository(db.raw), projectDir);

  // Listing symlink directory must throw PathEscapeForbiddenError
  await assert.rejects(
    async () => wm.listFiles("symlink-outside-dir"),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Listing external dir symlink must throw PathEscapeForbiddenError"
  );
  await assert.rejects(
    async () => wm.listFiles("symlink-etc-dir"),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Listing /etc dir symlink must throw PathEscapeForbiddenError"
  );
  await assert.rejects(
    async () => wm.listFiles("nested/deep/symlink-nested-outside"),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Listing nested dir symlink must throw PathEscapeForbiddenError"
  );

  // Reading through file symlinks must throw PathEscapeForbiddenError
  await assert.rejects(
    async () => wm.readFile("symlink-file.txt"),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Reading external file symlink must throw PathEscapeForbiddenError"
  );
  await assert.rejects(
    async () => wm.readFile("symlink-passwd"),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Reading /etc/passwd symlink must throw PathEscapeForbiddenError"
  );
  await assert.rejects(
    async () => wm.readFile("symlink-outside-dir/external.txt"),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Reading through dir symlink must throw PathEscapeForbiddenError"
  );
  await assert.rejects(
    async () => wm.readFile("symlink-internal.txt"),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Reading internal symlink must throw PathEscapeForbiddenError"
  );
  await assert.rejects(
    async () => wm.readFile("symlink-dangling"),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Reading dangling symlink must throw PathEscapeForbiddenError"
  );

  // Writing to symlinks with correct expected hash must throw PathEscapeForbiddenError
  const externalContent = await readFile(path.join(outsideDir, "external.txt"), "utf8");
  const externalHash = sha256(externalContent);

  await assert.rejects(
    async () => wm.writeFile("symlink-file.txt", "hijacked", externalHash),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Writing to file symlink with matching hash must throw PathEscapeForbiddenError"
  );
  await assert.rejects(
    async () => wm.writeFile("symlink-outside-dir/external.txt", "hijacked", externalHash),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Writing through dir symlink with matching hash must throw PathEscapeForbiddenError"
  );

  // Creating entry inside dir symlink must throw PathEscapeForbiddenError
  await assert.rejects(
    async () => wm.createEntry("symlink-outside-dir", "new-file.txt", "file"),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Creating entry inside dir symlink must throw PathEscapeForbiddenError"
  );

  // Deleting symlink entry must throw PathEscapeForbiddenError
  await assert.rejects(
    async () => wm.deleteEntry("symlink-file.txt"),
    (err: any) => err instanceof PathEscapeForbiddenError || err.code === "FORBIDDEN",
    "Deleting symlink must throw PathEscapeForbiddenError"
  );

  // B. Verify ToolRuntime strictly blocks symlink operations
  const world = createWorld();
  const { workerId, taskId, resourceId } = setupWorldWorker(world);
  const tools = new ToolRuntime(world);
  await tools.bindWorkspace(resourceId, projectDir);

  const symlinkToolTargets = [
    { op: "filesystem.list", path: "symlink-outside-dir" },
    { op: "filesystem.list", path: "symlink-etc-dir" },
    { op: "filesystem.read", path: "symlink-file.txt" },
    { op: "filesystem.read", path: "symlink-passwd" },
    { op: "filesystem.read", path: "symlink-outside-dir/external.txt" },
    { op: "filesystem.read", path: "nested/deep/symlink-nested-outside/external.txt" },
    { op: "filesystem.read", path: "symlink-internal.txt" },
    { op: "filesystem.read", path: "symlink-dangling" },
    { op: "filesystem.write", path: "symlink-file.txt", content: "evil" },
    { op: "filesystem.write", path: "symlink-outside-dir/evil.txt", content: "evil" },
    { op: "filesystem.edit", path: "symlink-file.txt", edits: [{ oldText: "a", newText: "b" }] },
  ];

  for (const item of symlinkToolTargets) {
    const res = await tools.invoke({
      name: item.op as any,
      input: item as any,
      worldId: world.id, workerId, taskId, resourceId,
    });
    assert.equal(res.status, "failed", `Tool ${item.op} on symlink ${item.path} must fail`);
    assert.equal((res as any).errorCode, "FORBIDDEN", `Tool ${item.op} on symlink ${item.path} must return errorCode FORBIDDEN`);
  }

  // C. Verify server.ts HTTP routes return 403 FORBIDDEN on symlinks
  const serverDb = path.join(root, "server-symlink.sqlite");
  const app = await startCommandCenter({
    databasePath: serverDb,
    workspaceRoot: projectDir,
    listen: false,
  });
  t.after(() => app.close());

  const ws = await request(app, "GET", "/api/workspace");
  const pId = ws.body.session.workspaceId;

  // Listing symlink directory via HTTP returns 403
  const httpList = await request(app, "GET", `/api/projects/${pId}/files?path=symlink-outside-dir`);
  assert.equal(httpList.status, 403);
  assert.equal(httpList.body?.error?.code, "FORBIDDEN");

  // Reading file symlink via HTTP returns 403
  const httpRead = await request(app, "GET", `/api/projects/${pId}/file?path=symlink-file.txt`);
  assert.equal(httpRead.status, 403);
  assert.equal(httpRead.body?.error?.code, "FORBIDDEN");

  // Writing to file symlink via HTTP returns 403
  const httpWrite = await request(app, "PUT", `/api/projects/${pId}/file`, {
    path: "symlink-file.txt",
    content: "attack",
    expectedHash: externalHash,
  });
  assert.equal(httpWrite.status, 403);
  assert.equal(httpWrite.body?.error?.code, "FORBIDDEN");
});

// ============================================================================
// STRESS TEST 4: OS Metadata Fuzzing, Deep Trees & Empty Directory Exclusion
// ============================================================================
test("ADVERSARIAL 4: OS metadata fuzzing (.DS_Store, Thumbs.db, desktop.ini, ._*, case variants) leaves ZERO leaks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g06-metadata-fuzz-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Create real files
  await writeFile(path.join(root, "package.json"), "{\"name\":\"fuzz-target\"}");
  await writeFile(path.join(root, "tsconfig.json"), "{}");

  const srcDir = path.join(root, "src");
  await mkdir(srcDir);
  await writeFile(path.join(srcDir, "main.ts"), "console.log('clean codebase');\n");

  // Create directory with ONLY OS metadata files (Cody defect repro case)
  const metadataOnlyDir = path.join(srcDir, "metadata_only_dir");
  await mkdir(metadataOnlyDir);

  // Populate root and subdirectories with every known OS metadata variant and case permutation
  const metadataFiles = [
    // macOS
    path.join(root, ".DS_Store"),
    path.join(root, ".ds_store"),
    path.join(root, ".DS_STORE"),
    path.join(root, "._AppleDouble"),
    path.join(root, "._package.json"),
    path.join(root, "._main.ts"),
    path.join(root, "._.DS_Store"),
    path.join(root, ".Spotlight-V100"),
    path.join(root, ".spotlight-v100"),
    path.join(root, ".Trashes"),
    path.join(root, ".trashes"),
    path.join(root, ".fseventsd"),
    // Windows
    path.join(root, "Thumbs.db"),
    path.join(root, "thumbs.db"),
    path.join(root, "THUMBS.DB"),
    path.join(root, "desktop.ini"),
    path.join(root, "Desktop.ini"),
    path.join(root, "DESKTOP.INI"),
    path.join(root, "ehthumbs.db"),
    path.join(root, "ehthumbs_vista.db"),
    // In srcDir
    path.join(srcDir, ".DS_Store"),
    path.join(srcDir, "Thumbs.db"),
    path.join(srcDir, "._main.ts"),
    // In metadataOnlyDir (folder with ONLY metadata)
    path.join(metadataOnlyDir, ".DS_Store"),
    path.join(metadataOnlyDir, ".ds_store"),
    path.join(metadataOnlyDir, "Thumbs.db"),
    path.join(metadataOnlyDir, "THUMBS.DB"),
    path.join(metadataOnlyDir, "desktop.ini"),
    path.join(metadataOnlyDir, "._metadata_probe"),
  ];

  for (const mFile of metadataFiles) {
    await writeFile(mFile, `metadata content in ${path.basename(mFile)} for testing`);
  }

  const world = createWorld();
  const { workerId, taskId, resourceId } = setupWorldWorker(world);
  const tools = new ToolRuntime(world);
  await tools.bindWorkspace(resourceId, root);

  // 1. filesystem.list on root directory
  const rootList = await tools.invoke({
    name: "filesystem.list",
    input: { path: "." },
    worldId: world.id, workerId, taskId, resourceId,
  });
  assert.equal(rootList.status, "succeeded");
  const rootEntries = (rootList.output as any).entries as string[];

  // Must contain genuine files
  assert.ok(rootEntries.includes("package.json"));
  assert.ok(rootEntries.includes("tsconfig.json"));
  assert.ok(rootEntries.includes("src"));

  // Must contain ZERO OS metadata files
  for (const entry of rootEntries) {
    assert.equal(
      isOSMetadata(entry),
      false,
      `root filesystem.list leaked OS metadata entry: "${entry}"`
    );
  }

  // 2. filesystem.list on src/metadata_only_dir (The Cody defect reproduction)
  const metadataOnlyList = await tools.invoke({
    name: "filesystem.list",
    input: { path: "src/metadata_only_dir" },
    worldId: world.id, workerId, taskId, resourceId,
  });
  assert.equal(metadataOnlyList.status, "succeeded");
  const metadataOnlyEntries = (metadataOnlyList.output as any).entries as string[];
  // Because it only contains OS metadata, the listing MUST be completely empty []!
  assert.deepEqual(
    metadataOnlyEntries,
    [],
    `Directory containing only OS metadata must return empty entries [], got: ${JSON.stringify(metadataOnlyEntries)}`
  );

  // 3. filesystem.search across the workspace
  const searchQueries = ["metadata", "clean", "package", "AppleDouble", "thumb", "desktop", "icon"];
  for (const q of searchQueries) {
    const searchRes = await tools.invoke({
      name: "filesystem.search",
      input: { query: q },
      worldId: world.id, workerId, taskId, resourceId,
    });
    assert.equal(searchRes.status, "succeeded");
    const matches = (searchRes.output as any).matches as Array<{ path: string; lineContent: string }>;
    for (const match of matches) {
      const fileName = path.basename(match.path);
      assert.equal(
        isOSMetadata(fileName),
        false,
        `filesystem.search for query "${q}" matched OS metadata file: ${match.path}`
      );
    }
  }

  // 4. WorkspaceManager.listFiles recursive tree check
  const db = new LocalDatabase(path.join(root, "wm-fuzz.sqlite"));
  t.after(() => { try { db.close(); } catch {} });
  const wm = new WorkspaceManager(new WorkspaceRepository(db.raw), root);

  const wmTree = await wm.listFiles("");
  function checkNode(node: { name: string; children?: any[] }) {
    assert.equal(
      isOSMetadata(node.name),
      false,
      `WorkspaceManager.listFiles leaked OS metadata: "${node.name}"`
    );
    if (node.children) {
      for (const child of node.children) checkNode(child);
    }
  }
  for (const node of wmTree) {
    checkNode(node);
  }

  // 5. server.ts HTTP GET /api/projects/:id/files endpoint check
  const app = await startCommandCenter({
    databasePath: path.join(root, "server-meta.sqlite"),
    workspaceRoot: root,
    listen: false,
  });
  t.after(() => app.close());

  const ws = await request(app, "GET", "/api/workspace");
  const pId = ws.body.session.workspaceId;

  const httpTreeRes = await request(app, "GET", `/api/projects/${pId}/files`);
  assert.equal(httpTreeRes.status, 200);
  const httpEntries = httpTreeRes.body.entries;
  for (const node of httpEntries) {
    checkNode(node);
  }
});

// ============================================================================
// STRESS TEST 5: ToolRuntime.filesystem.search Symlink Isolation & Confinement
// ============================================================================
test("ADVERSARIAL 5: ToolRuntime.filesystem.search symlink isolation (root search ignores symlink dirs, direct search blocked with FORBIDDEN)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g06-search-symlink-leak-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectDir = path.join(root, "project");
  const outsideDir = path.join(root, "outside");
  await mkdir(projectDir);
  await mkdir(outsideDir);

  const outsideSecretContent = "TOP_SECRET_EXTERNAL_DATABASE_CREDENTIAL_99999\n";
  await writeFile(path.join(outsideDir, "external.txt"), outsideSecretContent);

  try {
    await symlink(outsideDir, path.join(projectDir, "symlink-outside-dir"), process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    return; // Skip on platforms without symlink privilege
  }

  const world = createWorld();
  const { workerId, taskId, resourceId } = setupWorldWorker(world);
  const tools = new ToolRuntime(world);
  await tools.bindWorkspace(resourceId, projectDir);

  // 1. Search across workspace root "." must NOT traverse into symlinked directories
  const rootSearchRes = await tools.invoke({
    name: "filesystem.search",
    input: { query: "CREDENTIAL_99999", path: "." },
    worldId: world.id, workerId, taskId, resourceId,
  });
  assert.equal(rootSearchRes.status, "succeeded");
  assert.deepEqual((rootSearchRes.output as any).matches, [], "Root search must not follow symlinked directories outside workspace");

  // 2. Direct search targeting the symlink directory itself must fail with errorCode FORBIDDEN
  const directSearchRes = await tools.invoke({
    name: "filesystem.search",
    input: { query: "CREDENTIAL_99999", path: "symlink-outside-dir" },
    worldId: world.id, workerId, taskId, resourceId,
  });
  assert.equal(directSearchRes.status, "failed");
  assert.equal((directSearchRes as any).errorCode, "FORBIDDEN");
  assert.ok((directSearchRes as any).error.includes("Symlinks are not allowed"));
});

// ============================================================================
// STRESS TEST 6: CAS Timing & Symlink Containment in WorkspaceManager.writeFile
// ============================================================================
test("ADVERSARIAL 6: WorkspaceManager.writeFile on symlinks throws PathEscapeForbiddenError regardless of expectedHash", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g06-cas-inversion-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectDir = path.join(root, "project");
  const outsideDir = path.join(root, "outside");
  await mkdir(projectDir);
  await mkdir(outsideDir);

  await writeFile(path.join(outsideDir, "external.txt"), "outside content");

  try {
    await symlink(path.join(outsideDir, "external.txt"), path.join(projectDir, "symlink-file.txt"), "file");
  } catch (err) {
    return;
  }

  const db = new LocalDatabase(path.join(root, "cas-inversion.sqlite"));
  t.after(() => { try { db.close(); } catch {} });
  const wm = new WorkspaceManager(new WorkspaceRepository(db.raw), projectDir);

  // Even with a completely invalid or mismatched expectedHash, assertNoSymlink runs BEFORE acquireWriteLock
  // and MUST reject with PathEscapeForbiddenError (code: FORBIDDEN, HTTP 403), NOT file-conflict (HTTP 409).
  await assert.rejects(
    async () => wm.writeFile("symlink-file.txt", "injected content", sha256("wrong-hash")),
    (err: any) => err instanceof PathEscapeForbiddenError && err.code === "FORBIDDEN",
    "Writing to symlink with mismatched hash must throw PathEscapeForbiddenError with code FORBIDDEN"
  );

  // With empty hash
  await assert.rejects(
    async () => wm.writeFile("symlink-file.txt", "injected content", ""),
    (err: any) => err instanceof PathEscapeForbiddenError && err.code === "FORBIDDEN",
    "Writing to symlink with empty hash must throw PathEscapeForbiddenError with code FORBIDDEN"
  );
});

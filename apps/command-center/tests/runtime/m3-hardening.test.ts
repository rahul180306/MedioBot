import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat, chmod, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorld, type TaskId, type WorkerId, type ResourceId } from "@mediobot-v2/domain";
import {
  ToolRuntime,
  ToolPermissionEngine,
  type ToolInvocation,
} from "@mediobot-v2/tools";
import {
  computeWorkspaceRevision,
  createShadowWorkspace,
  snapshotNodeModules,
  verifyNodeModulesIntegrity,
  TesterExecutionAdapter,
  TesterDecisionProvider,
  createTesterDefinition,
  type TesterModelClient,
} from "@mediobot-v2/tester";

import { createCodyDefinition } from "@mediobot-v2/cody";

type TestFixture = {
  root: string;
  world: ReturnType<typeof createWorld>;
  tools: ToolRuntime;
  workerId: WorkerId;
  taskId: TaskId;
  resourceId: ResourceId;
  cleanup: () => Promise<void>;
};

async function createFixture(): Promise<TestFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-m3-hardening-"));
  const world = createWorld();
  const definition = createCodyDefinition(world);
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask("hardening test task").id, worker.id);
  const resource = world.registerResource({
    kind: "workspace",
    owner: { type: "worker", worldId: world.id, workerId: worker.id },
  });

  const tools = new ToolRuntime(world);
  await tools.bindWorkspace(resource.id, root);

  world.setWorkerState(worker.id, "busy");
  world.setTaskState(task.id, "running");
  world.setResourceState(resource.id, "in-use");

  return {
    root,
    world,
    tools,
    workerId: worker.id,
    taskId: task.id,
    resourceId: resource.id,
    cleanup: async () => {
      try {
        tools.releaseWorkspace(resource.id);
        await rm(root, { recursive: true, force: true });
      } catch {
        // cleanup best-effort
      }
    },
  };
}

describe("M3.1: Precision Editing Concurrency & File System Hardening", () => {
  it("preserves executable file mode across filesystem.edit and filesystem.write", async () => {
    const fixture = await createFixture();
    try {
      const scriptPath = path.join(fixture.root, "run.sh");
      await writeFile(scriptPath, "#!/bin/bash\necho hello\n", { mode: 0o755 });
      await chmod(scriptPath, 0o755);

      const beforeStat = await stat(scriptPath);
      assert.equal(beforeStat.mode & 0o777, 0o755, "file should initially be executable 0o755");

      // Edit file
      const editResult = await fixture.tools.invoke({
        worldId: fixture.world.id,
        workerId: fixture.workerId,
        taskId: fixture.taskId,
        resourceId: fixture.resourceId,
        name: "filesystem.edit",
        input: {
          path: "run.sh",
          edits: [{ oldText: "echo hello", newText: "echo updated" }],
        },
      });
      assert.equal(editResult.status, "succeeded");

      const afterEditStat = await stat(scriptPath);
      assert.equal(afterEditStat.mode & 0o777, 0o755, "executable permissions must be preserved after edit");

      // Write file
      const writeResult = await fixture.tools.invoke({
        worldId: fixture.world.id,
        workerId: fixture.workerId,
        taskId: fixture.taskId,
        resourceId: fixture.resourceId,
        name: "filesystem.write",
        input: {
          path: "run.sh",
          content: "#!/bin/bash\necho rewritten\n",
          expectedContentHash: createHash("sha256").update("#!/bin/bash\necho updated\n").digest("hex"),
        },
      });
      assert.equal(writeResult.status, "succeeded");

      const afterWriteStat = await stat(scriptPath);
      assert.equal(afterWriteStat.mode & 0o777, 0o755, "executable permissions must be preserved after write");
    } finally {
      await fixture.cleanup();
    }
  });

  it("cleans up all temporary files on success and failure", async () => {
    const fixture = await createFixture();
    try {
      const targetPath = path.join(fixture.root, "test.txt");
      await writeFile(targetPath, "alpha beta gamma");

      // Successful edit
      await fixture.tools.invoke({
        worldId: fixture.world.id,
        workerId: fixture.workerId,
        taskId: fixture.taskId,
        resourceId: fixture.resourceId,
        name: "filesystem.edit",
        input: {
          path: "test.txt",
          edits: [{ oldText: "beta", newText: "omega" }],
        },
      });

      let entries = await readdir(fixture.root);
      assert.ok(!entries.some((e) => e.startsWith(".tmp.")), "no temp files after successful edit");

      // Failed edit (TARGET_NOT_FOUND)
      await fixture.tools.invoke({
        worldId: fixture.world.id,
        workerId: fixture.workerId,
        taskId: fixture.taskId,
        resourceId: fixture.resourceId,
        name: "filesystem.edit",
        input: {
          path: "test.txt",
          edits: [{ oldText: "nonexistent", newText: "foo" }],
        },
      });

      entries = await readdir(fixture.root);
      assert.ok(!entries.some((e) => e.startsWith(".tmp.")), "no temp files after failed edit");
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes concurrent edits via FileLockManager without clobbering", async () => {
    const fixture = await createFixture();
    try {
      const targetPath = path.join(fixture.root, "counter.txt");
      await writeFile(targetPath, "initial value");

      // Launch multiple concurrent writes and edits
      const edit1 = fixture.tools.invoke({
        worldId: fixture.world.id,
        workerId: fixture.workerId,
        taskId: fixture.taskId,
        resourceId: fixture.resourceId,
        name: "filesystem.edit",
        input: {
          path: "counter.txt",
          edits: [{ oldText: "initial value", newText: "first update" }],
        },
      });

      const edit2 = fixture.tools.invoke({
        worldId: fixture.world.id,
        workerId: fixture.workerId,
        taskId: fixture.taskId,
        resourceId: fixture.resourceId,
        name: "filesystem.edit",
        input: {
          path: "counter.txt",
          edits: [{ oldText: "first update", newText: "second update" }],
        },
      });

      const [res1, res2] = await Promise.all([edit1, edit2]);
      assert.equal(res1.status, "succeeded");
      assert.equal(res2.status, "succeeded");

      const finalContent = await readFile(targetPath, "utf8");
      assert.equal(finalContent, "second update");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects concurrent edits with stale expectedContentHash (TOCTOU guard)", async () => {
    const fixture = await createFixture();
    try {
      const targetPath = path.join(fixture.root, "code.ts");
      await writeFile(targetPath, "const x = 1;");

      const readResult = await fixture.tools.invoke({
        worldId: fixture.world.id,
        workerId: fixture.workerId,
        taskId: fixture.taskId,
        resourceId: fixture.resourceId,
        name: "filesystem.read",
        input: { path: "code.ts" },
      });
      assert.equal(readResult.status, "succeeded");

      // Compute initial content hash
      const crypto = await import("node:crypto");
      const hash1 = crypto.createHash("sha256").update("const x = 1;").digest("hex").slice(0, 16);

      // First edit succeeds and changes content to "const x = 2;"
      const edit1 = await fixture.tools.invoke({
        worldId: fixture.world.id,
        workerId: fixture.workerId,
        taskId: fixture.taskId,
        resourceId: fixture.resourceId,
        name: "filesystem.edit",
        input: {
          path: "code.ts",
          expectedContentHash: hash1,
          edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
        },
      });
      assert.equal(edit1.status, "succeeded");

      // Second edit attempted with old hash1 -> must be rejected with STALE_REVISION
      const edit2 = await fixture.tools.invoke({
        worldId: fixture.world.id,
        workerId: fixture.workerId,
        taskId: fixture.taskId,
        resourceId: fixture.resourceId,
        name: "filesystem.edit",
        input: {
          path: "code.ts",
          expectedContentHash: hash1,
          edits: [{ oldText: "const x = 2;", newText: "const x = 3;" }],
        },
      });
      assert.equal(edit2.status, "failed");
      assert.equal(edit2.errorCode, "STALE_REVISION");
    } finally {
      await fixture.cleanup();
    }
  });

  it("scrubs INIT_CWD and npm_config_local_prefix while setting PWD in terminal subprocesses", async () => {
    const fixture = await createFixture();
    try {
      process.env.INIT_CWD = "/arbitrary/host/path";
      process.env.npm_config_local_prefix = "/arbitrary/prefix";

      const result = await fixture.tools.invoke({
        worldId: fixture.world.id,
        workerId: fixture.workerId,
        taskId: fixture.taskId,
        resourceId: fixture.resourceId,
        name: "terminal.execute",
        input: {
          command: "node",
          args: ["-e", 'console.log(JSON.stringify({ pwd: process.env.PWD, init: process.env.INIT_CWD, prefix: process.env.npm_config_local_prefix }))'],
        },
      });

      assert.equal(result.status, "succeeded");
      const out = JSON.parse((result.output as any).stdout);
      assert.equal(out.init, undefined, "INIT_CWD must be scrubbed");
      assert.equal(out.prefix, undefined, "npm_config_local_prefix must be scrubbed");
      assert.equal(await realpath(out.pwd), await realpath(fixture.root), "PWD must match execution cwd");
    } finally {
      delete process.env.INIT_CWD;
      delete process.env.npm_config_local_prefix;
      await fixture.cleanup();
    }
  });
});

describe("M3.1: Tester Isolation and Failure Modes", () => {
  it("fails closed when os-sandbox isolation is requested in unprivileged containerless runtime", async () => {
    const world = createWorld();
    const tools = new ToolRuntime(world);
    const mockModel: TesterModelClient = {
      complete: async () => JSON.stringify({ type: "finish", report: { status: "verified", summary: "done" } }),
    };
    const decisions = new TesterDecisionProvider(mockModel);
    const adapter = new TesterExecutionAdapter({ tools, decisions });

    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-tester-sandbox-fail-"));
    try {
      const def = createTesterDefinition(world);
      const worker = world.spawnWorker(def.id);
      const task = world.createTask("sandbox test");

      const plan = adapter.prepare({
        world,
        definitionId: def.id,
        workerId: worker.id,
        taskId: task.id,
        goal: "verify sandbox",
        options: {
          workspaceRoot: root,
          isolationLevel: "os-sandbox",
        },
      });

      await assert.rejects(
        async () => {
          await plan.execute({
            signal: new AbortController().signal,
            emit: () => {},
            forward: () => {},
          });
        },
        /Tester isolation failure: Strong OS-level container isolation was requested/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects host node_modules mutation during test execution and invalidates run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-tester-nm-breach-"));
    try {
      const nmDir = path.join(root, "node_modules");
      await mkdir(nmDir, { recursive: true });
      await writeFile(path.join(nmDir, "package.json"), '{"name":"dep"}');

      const baseline = await snapshotNodeModules(root);
      assert.ok(baseline !== null);
      assert.equal(baseline.size, 1);

      // Verify baseline intact initially
      const intactBefore = await verifyNodeModulesIntegrity(root, baseline);
      assert.equal(intactBefore, true);

      // Tamper host node_modules (simulating malicious test writing into symlinked node_modules)
      await writeFile(path.join(nmDir, "tampered.txt"), "corrupted");

      const intactAfter = await verifyNodeModulesIntegrity(root, baseline);
      assert.equal(intactAfter, false, "tampering with node_modules must be detected");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("safely excludes test/build caches from workspace revision while hashing all source files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-hash-exclusions-"));
    try {
      await writeFile(path.join(root, "index.ts"), "export const a = 1;");
      const rev1 = await computeWorkspaceRevision(root);

      // Modifying coverage directory should NOT change workspace revision
      await mkdir(path.join(root, "coverage"), { recursive: true });
      await writeFile(path.join(root, "coverage", "lcov.info"), "TN:\nSF:index.ts\nend_of_record");
      const rev2 = await computeWorkspaceRevision(root);
      assert.equal(rev1, rev2, "coverage files must not alter workspace revision");

      // Modifying .turbo cache should NOT change workspace revision
      await mkdir(path.join(root, ".turbo"), { recursive: true });
      await writeFile(path.join(root, ".turbo", "cache.json"), '{"cache":true}');
      const rev3 = await computeWorkspaceRevision(root);
      assert.equal(rev1, rev3, ".turbo cache must not alter workspace revision");

      // Modifying tsbuildinfo should NOT change workspace revision
      await writeFile(path.join(root, "tsconfig.tsbuildinfo"), "buildinfo");
      const rev4 = await computeWorkspaceRevision(root);
      assert.equal(rev1, rev4, ".tsbuildinfo files must not alter workspace revision");

      // But modifying source file MUST alter workspace revision
      await writeFile(path.join(root, "index.ts"), "export const a = 2;");
      const rev5 = await computeWorkspaceRevision(root);
      assert.notEqual(rev1, rev5, "modifying source files must strictly alter workspace revision");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M3.1: Workspace Preparation and Hashing Performance Benchmarks", () => {
  async function generateRepo(numFiles: number): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), `mediobot-perf-${numFiles}-`));
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "tests"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: `repo-${numFiles}`, version: "1.0.0" }));

    for (let i = 0; i < numFiles; i++) {
      const sub = i % 2 === 0 ? "src" : "tests";
      await writeFile(path.join(dir, sub, `file_${i}.ts`), `// Content of file ${i}\nexport const val${i} = ${i};\n`);
    }
    return dir;
  }

  it("benchmarks small repo (10 files)", async () => {
    const repo = await generateRepo(10);
    try {
      const t0 = performance.now();
      const rev = await computeWorkspaceRevision(repo);
      const hashDurationMs = performance.now() - t0;

      const t1 = performance.now();
      const shadow = await createShadowWorkspace(repo);
      const shadowDurationMs = performance.now() - t1;

      await rm(shadow, { recursive: true, force: true });

      assert.ok(rev.length === 16);
      console.log(`[PERF Small (10 files)] hash: ${hashDurationMs.toFixed(2)}ms, shadow: ${shadowDurationMs.toFixed(2)}ms`);
      assert.ok(hashDurationMs < 100, "small repo hashing under 100ms");
      assert.ok(shadowDurationMs < 200, "small repo shadow copy under 200ms");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("benchmarks medium repo (100 files)", async () => {
    const repo = await generateRepo(100);
    try {
      const t0 = performance.now();
      const rev = await computeWorkspaceRevision(repo);
      const hashDurationMs = performance.now() - t0;

      const t1 = performance.now();
      const shadow = await createShadowWorkspace(repo);
      const shadowDurationMs = performance.now() - t1;

      await rm(shadow, { recursive: true, force: true });

      assert.ok(rev.length === 16);
      console.log(`[PERF Medium (100 files)] hash: ${hashDurationMs.toFixed(2)}ms, shadow: ${shadowDurationMs.toFixed(2)}ms`);
      assert.ok(hashDurationMs < 300, "medium repo hashing under 300ms");
      assert.ok(shadowDurationMs < 500, "medium repo shadow copy under 500ms");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("benchmarks large repo (500 files)", async () => {
    const repo = await generateRepo(500);
    try {
      const t0 = performance.now();
      const rev = await computeWorkspaceRevision(repo);
      const hashDurationMs = performance.now() - t0;

      const t1 = performance.now();
      const shadow = await createShadowWorkspace(repo);
      const shadowDurationMs = performance.now() - t1;

      await rm(shadow, { recursive: true, force: true });

      assert.ok(rev.length === 16);
      console.log(`[PERF Large (500 files)] hash: ${hashDurationMs.toFixed(2)}ms, shadow: ${shadowDurationMs.toFixed(2)}ms`);
      assert.ok(hashDurationMs < 1500, "large repo hashing under 1500ms");
      assert.ok(shadowDurationMs < 2500, "large repo shadow copy under 2500ms");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

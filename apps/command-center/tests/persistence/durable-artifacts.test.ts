import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../../src/storage/db.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";
import { DurableTaskEngine } from "@mediobot-v2/runtime";

test("durable artifact versions preserve per-task attribution, idempotency, workspace isolation, and SQLite restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-artifacts-"));
  const databasePath = path.join(root, "mediobot.db");
  let database = new LocalDatabase(databasePath);
  try {
    const engine = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
    await engine.submitTask({ id: "artifact-task-a", workspaceId: "workspace-a", threadId: "thread-a", goal: "Create source file", definitionId: "cody" });
    const first = await engine.recordArtifact("artifact-task-a", { workerId: "worker-a", mediobotId: "cody", name: "prime_check.py",
      reference: "./prime_check.py", contentHash: "a".repeat(64) });
    const retry = await engine.recordArtifact("artifact-task-a", { workerId: "worker-a", mediobotId: "cody", name: "prime_check.py",
      reference: "prime_check.py", contentHash: "a".repeat(64) });
    assert.equal(retry.id, first.id);
    assert.equal((await engine.getEvents("artifact-task-a")).filter(event => event.eventType === "task.artifact_recorded").length, 1);

    await engine.submitTask({ id: "artifact-task-b", workspaceId: "workspace-a", threadId: "thread-a", goal: "Update source file", definitionId: "cody" });
    const updated = await engine.recordArtifact("artifact-task-b", { workerId: "worker-b", mediobotId: "cody", name: "prime_check.py",
      reference: "prime_check.py", contentHash: "b".repeat(64) });
    assert.notEqual(updated.id, first.id, "each task keeps its own artifact version identity");
    assert.equal(updated.taskId, "artifact-task-b");
    assert.equal(updated.workerId, "worker-b");
    assert.deepEqual((await engine.getArtifacts("artifact-task-a")).map(artifact => artifact.contentHash), ["a".repeat(64)],
      "a later task editing the same path must not erase the earlier task's artifact record");

    await engine.submitTask({ id: "artifact-task-c", workspaceId: "workspace-c", threadId: "thread-c", goal: "Create same path elsewhere", definitionId: "cody" });
    const otherWorkspace = await engine.recordArtifact("artifact-task-c", { workerId: "worker-c", mediobotId: "cody", name: "prime_check.py",
      reference: "prime_check.py", contentHash: "c".repeat(64) });
    assert.notEqual(otherWorkspace.id, first.id, "artifact identity must not leak across workspaces");
    await assert.rejects(engine.recordArtifact("artifact-task-c", { workerId: "worker-c", mediobotId: "cody", name: "escape", reference: "../secret.txt",
      contentHash: "d".repeat(64) }), /workspace-relative/);
    await assert.rejects(engine.recordArtifact("artifact-task-c", { workerId: "worker-c", mediobotId: "cody", name: "bad", reference: "bad.py",
      contentHash: "short" }), /Invalid durable artifact/);
  } finally { database.close(); }

  database = new LocalDatabase(databasePath);
  try {
    const engine = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
    const restored = await engine.getArtifacts("artifact-task-b");
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.id, `artifact-${createHash("sha256")
      .update("workspace:workspace-a\0artifact-task-b\0prime_check.py").digest("hex").slice(0, 32)}`);
    assert.equal(restored[0]?.contentHash, "b".repeat(64));
    assert.equal(restored[0]?.workerId, "worker-b");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact persistence and its durable event commit atomically", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-artifact-atomic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = new LocalDatabase(path.join(root, "mediobot.db"));
  try {
    const engine = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
    await engine.submitTask({ id: "atomic-artifact-task", workspaceId: "workspace-a", goal: "Create source file", definitionId: "cody" });
    database.raw.exec(`CREATE TRIGGER reject_artifact_event BEFORE INSERT ON durable_task_events
      WHEN NEW.event_type = 'task.artifact_recorded' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;`);
    await assert.rejects(engine.recordArtifact("atomic-artifact-task", { workerId: "worker-a", mediobotId: "cody", name: "main.py",
      reference: "main.py", contentHash: "a".repeat(64) }), /injected event failure/);
    assert.deepEqual(await engine.getArtifacts("atomic-artifact-task"), [], "failed event insert must roll back the artifact row");

    database.raw.exec("DROP TRIGGER reject_artifact_event");
    const artifact = await engine.recordArtifact("atomic-artifact-task", { workerId: "worker-a", mediobotId: "cody", name: "main.py",
      reference: "main.py", contentHash: "a".repeat(64) });
    assert.equal((await engine.getEvents("atomic-artifact-task")).filter(event => event.eventType === "task.artifact_recorded"
      && event.payload.artifactId === artifact.id).length, 1);
    await engine.recordArtifact("atomic-artifact-task", { workerId: "worker-a", mediobotId: "cody", name: "main.py",
      reference: "main.py", contentHash: "a".repeat(64) });
    assert.equal((await engine.getEvents("atomic-artifact-task")).filter(event => event.eventType === "task.artifact_recorded"
      && event.payload.artifactId === artifact.id).length, 1, "idempotent retry must not duplicate its event");
  } finally { database.close(); }
});

test("schema 15 preserves v14 artifact rows and allows a later task version for the same path", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-artifact-v14-migration-"));
  const databasePath = path.join(root, "mediobot.db");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let database = new LocalDatabase(databasePath);
  const engine = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
  await engine.submitTask({ id: "migration-task-a", workspaceId: "migration-workspace", goal: "first", definitionId: "cody" });
  await engine.recordArtifact("migration-task-a", { workerId: "worker-a", mediobotId: "cody", name: "main.py",
    reference: "main.py", contentHash: "a".repeat(64) });
  database.raw.prepare("DELETE FROM schema_migrations WHERE version = 15").run();
  database.raw.exec(`
    CREATE TABLE durable_task_artifacts_v14 (
      id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, workspace_id TEXT, thread_id TEXT,
      task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE, mediobot_id TEXT NOT NULL,
      worker_id TEXT NOT NULL, name TEXT NOT NULL, reference TEXT NOT NULL,
      content_hash TEXT NOT NULL CHECK(length(content_hash) = 64), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(workspace_key, reference)
    );
    INSERT INTO durable_task_artifacts_v14 SELECT * FROM durable_task_artifacts;
    DROP TABLE durable_task_artifacts;
    ALTER TABLE durable_task_artifacts_v14 RENAME TO durable_task_artifacts;
    DROP INDEX IF EXISTS idx_durable_task_artifacts_task;
    DROP INDEX IF EXISTS idx_durable_task_artifacts_workspace;
  `);
  database.close();

  database = new LocalDatabase(databasePath);
  try {
    assert.equal(database.currentSchemaVersion, 18);
    const restoredEngine = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
    assert.equal((await restoredEngine.getArtifacts("migration-task-a"))[0]?.contentHash, "a".repeat(64));
    await restoredEngine.submitTask({ id: "migration-task-b", workspaceId: "migration-workspace", goal: "second", definitionId: "cody" });
    const next = await restoredEngine.recordArtifact("migration-task-b", { workerId: "worker-b", mediobotId: "cody", name: "main.py",
      reference: "main.py", contentHash: "b".repeat(64) });
    assert.equal(next.contentHash, "b".repeat(64));
    assert.equal((await restoredEngine.getArtifacts("migration-task-a")).length, 1);
    assert.equal((await restoredEngine.getArtifacts("migration-task-b")).length, 1);
  } finally {
    database.close();
  }
});

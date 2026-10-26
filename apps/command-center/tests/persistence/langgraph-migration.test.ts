import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../../src/storage/db.ts";

test("versions 8, 9, 11, 14, and 15 add execution tables without losing product records", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-migration-"));
  const databasePath = path.join(root, "mediobot.db");
  try {
    const before = new LocalDatabase(databasePath);
    before.raw.prepare(`INSERT INTO provider_connections (id, provider_type, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run("provider-preserved", "custom", "Existing provider", 1, 2);
    before.raw.prepare(`INSERT INTO durable_tasks (id, goal, definition_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("task-preserved", "Existing task", "cody", "completed", 3, 4);
    before.raw.prepare(`INSERT INTO durable_task_evidence (id, task_id, kind, content, created_at)
      VALUES (?, ?, ?, ?, ?)`).run("evidence-preserved", "task-preserved", "tool-result", "Read-only evidence", 5);
    before.raw.exec("DROP TABLE durable_task_artifacts; DROP TABLE langgraph_task_outcomes; DROP TABLE checkpoints; DROP TABLE writes; DELETE FROM schema_migrations WHERE version >= 8;");
    before.close();

    const after = new LocalDatabase(databasePath);
    try {
      assert.equal(after.currentSchemaVersion, 18);
      assert.equal((after.raw.prepare("SELECT display_name FROM provider_connections WHERE id = ?").get("provider-preserved") as { display_name: string }).display_name,
        "Existing provider");
      assert.equal((after.raw.prepare("SELECT status FROM durable_tasks WHERE id = ?").get("task-preserved") as { status: string }).status, "completed");
      assert.equal((after.raw.prepare("SELECT content FROM durable_task_evidence WHERE id = ?").get("evidence-preserved") as { content: string }).content,
        "Read-only evidence");
      const artifactTables = after.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_task_artifacts'").all() as Array<{ name: string }>;
      assert.deepEqual(artifactTables.map(row => row.name), ["durable_task_artifacts"]);
      const tables = after.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('checkpoints', 'durable_tool_approval_interrupts', 'langgraph_task_outcomes', 'writes') ORDER BY name").all() as Array<{ name: string }>;
      assert.deepEqual(tables.map(row => row.name), ["checkpoints", "durable_tool_approval_interrupts", "langgraph_task_outcomes", "writes"]);
    } finally { after.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

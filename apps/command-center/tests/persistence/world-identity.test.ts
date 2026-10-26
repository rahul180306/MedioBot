import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../../src/storage/db.ts";
import { SqliteWorldIdentityRepository } from "../../src/storage/worldIdentityRepository.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";
import { DurableTaskEngine } from "@mediobot-v2/runtime";
import { createComposition } from "../../src/composition.ts";
import { startCommandCenter } from "../../src/server.ts";

test("organization World identity survives database reopen and composition restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-world-identity-"));
  const databasePath = path.join(root, "mediobot.db");
  const firstDatabase = new LocalDatabase(databasePath);
  const firstIdentity = new SqliteWorldIdentityRepository(firstDatabase.raw).getOrCreate();
  const first = createComposition({ worldIdentity: firstIdentity });
  assert.deepEqual(first.world.inspect().world, firstIdentity);
  await first.shutdown?.();
  firstDatabase.close();

  const secondDatabase = new LocalDatabase(databasePath);
  try {
    const restoredIdentity = new SqliteWorldIdentityRepository(secondDatabase.raw).getOrCreate();
    const durable = new DurableTaskEngine(new SqliteDurableTaskStore(secondDatabase.raw));
    const second = createComposition({ worldIdentity: restoredIdentity, durableTaskEngine: durable });
    try {
      assert.deepEqual(restoredIdentity, firstIdentity);
      assert.equal(second.world.id, first.world.id);
      assert.equal(second.world.inspect().world.createdAt, firstIdentity.createdAt);
    } finally { await second.shutdown?.(); }
  } finally { secondDatabase.close(); rmSync(root, { recursive: true, force: true }); }
});

test("version-17 additive migration preserves provider and durable task history", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-world-identity-migration-"));
  const databasePath = path.join(root, "mediobot.db");
  const before = new LocalDatabase(databasePath);
  before.raw.prepare(`INSERT INTO provider_connections (id, provider_type, display_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run("provider-preserved", "custom", "Existing provider", 1, 2);
  before.raw.prepare(`INSERT INTO durable_tasks (id, goal, definition_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("task-preserved", "Existing task", "cody", "completed", 3, 4);
  before.raw.exec("DROP TABLE runtime_world_identity; DELETE FROM schema_migrations WHERE version = 17;");
  before.close();

  const after = new LocalDatabase(databasePath);
  try {
    assert.equal(after.currentSchemaVersion, 18);
    assert.equal(new SqliteWorldIdentityRepository(after.raw).getOrCreate().id.startsWith("world_"), true);
    assert.equal((after.raw.prepare("SELECT display_name FROM provider_connections WHERE id = ?").get("provider-preserved") as { display_name: string }).display_name,
      "Existing provider");
    assert.equal((after.raw.prepare("SELECT status FROM durable_tasks WHERE id = ?").get("task-preserved") as { status: string }).status,
      "completed");
  } finally { after.close(); rmSync(root, { recursive: true, force: true }); }
});

test("normal Command Center restart keeps the same organization identity", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-server-world-identity-"));
  const databasePath = path.join(root, "mediobot.db");
  let app = await startCommandCenter({ databasePath, workspaceRoot: root, vite: false, listen: false });
  const originalId = app.composition.world.id;
  const originalCreatedAt = app.composition.world.inspect().world.createdAt;
  await app.close();
  try {
    app = await startCommandCenter({ databasePath, workspaceRoot: root, vite: false, listen: false });
    assert.equal(app.composition.world.id, originalId);
    assert.equal(app.composition.world.inspect().world.createdAt, originalCreatedAt);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

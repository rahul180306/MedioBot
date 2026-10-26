import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../../src/storage/db.ts";
import { SqliteMediobotDefinitionRepository } from "../../src/storage/mediobotDefinitionRepository.ts";
import { createComposition } from "../../src/composition.ts";

test("SQLite registry preserves specialist identity and lifecycle across composition restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-definition-registry-"));
  const dbPath = path.join(root, "mediobot.db");
  let firstDatabase = new LocalDatabase(dbPath);
  const firstRepository = new SqliteMediobotDefinitionRepository(firstDatabase.raw);
  const first = createComposition({ mediobotDefinitionRepository: firstRepository });
  firstDatabase.raw.exec(`CREATE TRIGGER reject_registry_insert BEFORE INSERT ON mediobot_definitions BEGIN SELECT RAISE(ABORT, 'registry unavailable'); END;`);
  assert.throws(() => first.registerSpecialist!({ name: "Should not register", role: "analysis", version: "1", instructions: "No-op." }), /registry unavailable/);
  assert.equal(first.world.inspect().definitions.some(definition => definition.name === "Should not register"), false);
  firstDatabase.raw.exec("DROP TRIGGER reject_registry_insert;");
  const registered = first.registerSpecialist!({ name: "Analyst", role: "analysis", version: "1",
    instructions: "Analyze only the context supplied by Maestro." });
  firstDatabase.raw.exec(`CREATE TRIGGER reject_registry_update BEFORE UPDATE ON mediobot_definitions BEGIN SELECT RAISE(ABORT, 'registry unavailable'); END;`);
  assert.throws(() => first.setSpecialistLifecycle!(registered.id, "draining"), /registry unavailable/);
  assert.equal(first.world.inspect().definitions.find(definition => definition.id === registered.id)?.lifecycleState, "active");
  firstDatabase.raw.exec("DROP TRIGGER reject_registry_update;");
  const assignedWorker = first.world.spawnWorker(registered.id as never);
  const assignedTask = first.world.assignTask(first.world.createTask("Keep attribution until task ends").id, assignedWorker.id);
  assert.throws(() => first.removeSpecialist!(registered.id), /active work/i);
  first.world.setTaskState(assignedTask.id, "cancelled");
  first.setSpecialistLifecycle!(registered.id, "disabled");
  first.removeSpecialist!(registered.id);
  assert.equal(first.definitions.some(definition => definition.id === registered.id), false);
  assert.ok(first.world.inspect().definitions.some(definition => definition.id === registered.id), "removal retains the identity for historical attribution");
  await first.shutdown?.();
  firstDatabase.close();

  let secondDatabase = new LocalDatabase(dbPath);
  try {
      assert.equal(secondDatabase.currentSchemaVersion, 18);
    const second = createComposition({ mediobotDefinitionRepository: new SqliteMediobotDefinitionRepository(secondDatabase.raw) });
    try {
      const restored = second.definitions.find(definition => definition.id === registered.id);
      assert.equal(restored, undefined, "removed identities stay out of the active roster");
      assert.equal(second.world.inspect().definitions.find(definition => definition.id === registered.id)?.lifecycleState, "disabled");
      assert.ok(second.world.inspect().definitions.some(definition => definition.id === first.maestroDefinitionId));
    } finally { await second.shutdown?.(); }
  } finally {
    secondDatabase.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap identities stay stable and legacy unmanaged aliases do not return as duplicate bots", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-bootstrap-identities-"));
  const dbPath = path.join(root, "mediobot.db");
  const db = new LocalDatabase(dbPath);
  const repository = new SqliteMediobotDefinitionRepository(db.raw);
  repository.register({ id: "legacy-maestro" as never, name: "Maestro", role: "orchestration", version: "1",
    instructions: "Legacy generated bootstrap identity.", declaredCapabilities: [], lifecycleState: "active" });
  repository.register({ id: "legacy-vision" as never, name: "Vision", role: "visual-browser", version: "1",
    instructions: "Legacy generated bootstrap identity.", declaredCapabilities: [], lifecycleState: "active" });
  const first = createComposition({ mediobotDefinitionRepository: repository });
  assert.equal(first.maestroDefinitionId, "maestro");
  assert.equal(first.visionDefinitionId, "vision");
  assert.equal(first.definitions.filter(definition => definition.name === "Maestro").length, 1);
  assert.equal(first.definitions.filter(definition => definition.name === "Vision").length, 1);
  assert.equal(first.world.inspect().definitions.some(definition => definition.id === "legacy-maestro"), true,
    "legacy aliases stay in the runtime world so durable task ownership and resume adapters can resolve them");
  assert.equal(first.world.inspect().definitions.some(definition => definition.id === "legacy-vision"), true);
  assert.equal(first.definitions.some(definition => definition.id === "legacy-maestro" || definition.id === "legacy-vision"), false,
    "aliases stay hidden from the user-facing identity roster");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS count FROM mediobot_definitions WHERE id IN ('legacy-maestro', 'legacy-vision')").get() as { count: number }).count, 2,
    "the compatibility fix must retain legacy rows instead of deleting user data");
  await first.shutdown?.();
  db.close();

  const restartedDb = new LocalDatabase(dbPath);
  try {
    const restarted = createComposition({ mediobotDefinitionRepository: new SqliteMediobotDefinitionRepository(restartedDb.raw) });
    try {
      assert.equal(restarted.maestroDefinitionId, "maestro");
      assert.equal(restarted.visionDefinitionId, "vision");
      assert.equal(restarted.definitions.filter(definition => definition.name === "Maestro").length, 1);
      assert.equal(restarted.definitions.filter(definition => definition.name === "Vision").length, 1);
    } finally { await restarted.shutdown?.(); }
  } finally {
    restartedDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema 11 migration adds the registry and tombstone fields without changing existing product records", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-definition-migration-"));
  const dbPath = path.join(root, "mediobot.db");
  try {
    const before = new LocalDatabase(dbPath);
    before.raw.prepare(`INSERT INTO provider_connections (id, provider_type, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run("kept-provider", "custom", "Existing provider", 1, 2);
    before.raw.prepare(`INSERT INTO durable_tasks (id, goal, definition_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("kept-task", "Keep task", "cody", "completed", 3, 4);
    before.raw.exec("DROP TABLE durable_task_artifacts; DROP TABLE mediobot_definitions; DELETE FROM schema_migrations WHERE version >= 12;");
    before.close();

    const after = new LocalDatabase(dbPath);
    try {
      assert.equal(after.currentSchemaVersion, 18);
      assert.equal((after.raw.prepare("SELECT display_name FROM provider_connections WHERE id = 'kept-provider'").get() as { display_name: string }).display_name, "Existing provider");
      assert.equal((after.raw.prepare("SELECT status FROM durable_tasks WHERE id = 'kept-task'").get() as { status: string }).status, "completed");
      assert.equal((after.raw.prepare("SELECT COUNT(*) AS count FROM mediobot_definitions").get() as { count: number }).count, 0);
    } finally { after.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

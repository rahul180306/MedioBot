import type { DatabaseSync } from "node:sqlite";
import type { Capability, MediobotDefinition, MediobotDefinitionId, MediobotLifecycleState } from "@mediobot-v2/domain";

interface DefinitionRow {
  id: string; name: string; role: string; version: string; instructions: string; declared_capabilities_json: string;
  lifecycle_state: string; created_at: number; updated_at: number; managed: number; removed_at: number | null;
}

export interface StoredMediobotDefinition {
  readonly definition: MediobotDefinition;
  readonly managed: boolean;
  readonly removed: boolean;
}

/** Durable identity and lifecycle metadata; executable adapters remain registered by application code. */
export class SqliteMediobotDefinitionRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  list(): MediobotDefinition[] {
    const rows = this.db.prepare("SELECT * FROM mediobot_definitions ORDER BY created_at, id").all() as unknown as DefinitionRow[];
    return rows.map(row => this.decode(row));
  }

  listStored(): StoredMediobotDefinition[] {
    const rows = this.db.prepare("SELECT * FROM mediobot_definitions ORDER BY created_at, id").all() as unknown as DefinitionRow[];
    return rows.map(row => ({ definition: this.decode(row), managed: row.managed === 1, removed: row.removed_at !== null }));
  }

  get(id: MediobotDefinitionId): MediobotDefinition | null {
    const row = this.db.prepare("SELECT * FROM mediobot_definitions WHERE id = ?").get(id) as unknown as DefinitionRow | undefined;
    return row ? this.decode(row) : null;
  }

  /** Update code-owned metadata while preserving the user's persisted lifecycle choice. */
  register(definition: MediobotDefinition, managed = false): MediobotDefinition {
    const now = Date.now();
    this.db.prepare(`INSERT INTO mediobot_definitions
      (id, name, role, version, instructions, declared_capabilities_json, lifecycle_state, created_at, updated_at, managed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, version=excluded.version,
        instructions=excluded.instructions, declared_capabilities_json=excluded.declared_capabilities_json,
        updated_at=excluded.updated_at`).run(definition.id, definition.name, definition.role, definition.version,
        definition.instructions, JSON.stringify(definition.declaredCapabilities), definition.lifecycleState, now, now, managed ? 1 : 0);
    return this.get(definition.id)!;
  }

  saveLifecycle(id: MediobotDefinitionId, lifecycleState: MediobotLifecycleState): MediobotDefinition {
    const result = this.db.prepare("UPDATE mediobot_definitions SET lifecycle_state = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL")
      .run(lifecycleState, Date.now(), id);
    if (result.changes !== 1) throw new Error("Mediobot definition does not exist in durable registry");
    return this.get(id)!;
  }

  remove(id: MediobotDefinitionId): void {
    const result = this.db.prepare(`UPDATE mediobot_definitions SET lifecycle_state = 'disabled', removed_at = ?, updated_at = ?
      WHERE id = ? AND managed = 1 AND removed_at IS NULL`).run(Date.now(), Date.now(), id);
    if (result.changes !== 1) throw new Error("Only active user-managed Mediobots can be removed");
  }

  isRemoved(id: MediobotDefinitionId): boolean {
    const row = this.db.prepare("SELECT removed_at FROM mediobot_definitions WHERE id = ?").get(id) as { removed_at: number | null } | undefined;
    return Boolean(row && row.removed_at !== null);
  }

  private decode(row: DefinitionRow): MediobotDefinition {
    const capabilities = JSON.parse(row.declared_capabilities_json) as Capability[];
    if (!Array.isArray(capabilities) || !capabilities.every(value => value && (value.kind === "action" || value.kind === "resource")
      && typeof value.name === "string")) throw new Error(`Invalid persisted capabilities for Mediobot ${row.id}`);
    if (!["active", "draining", "disabled"].includes(row.lifecycle_state)) throw new Error(`Invalid lifecycle state for Mediobot ${row.id}`);
    return { id: row.id as MediobotDefinitionId, name: row.name, role: row.role, version: row.version,
      instructions: row.instructions, declaredCapabilities: capabilities, lifecycleState: row.lifecycle_state as MediobotLifecycleState };
  }
}

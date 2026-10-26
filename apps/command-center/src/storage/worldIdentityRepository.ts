import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { World, WorldId } from "@mediobot-v2/domain";

/** Persists the one organization identity associated with this product database. */
export class SqliteWorldIdentityRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  getOrCreate(): World {
    this.db.prepare(`INSERT OR IGNORE INTO runtime_world_identity (singleton, world_id, created_at)
      VALUES (1, ?, ?)`).run(`world_${randomUUID()}`, Date.now());
    const row = this.db.prepare("SELECT world_id, created_at FROM runtime_world_identity WHERE singleton = 1")
      .get() as { world_id: string; created_at: number } | undefined;
    if (!row || !/^world_[0-9a-f-]{36}$/i.test(row.world_id) || !Number.isFinite(row.created_at)) {
      throw new Error("Persisted organization identity is invalid.");
    }
    return { id: row.world_id as WorldId, createdAt: row.created_at };
  }
}

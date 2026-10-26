import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getDatabasePath, assertNonProductionDatabase } from "./appPaths.ts";

export interface Migration {
  readonly version: number;
  readonly up: (db: DatabaseSync) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          canonical_path TEXT UNIQUE NOT NULL,
          display_name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_opened_at INTEGER NOT NULL,
          availability TEXT NOT NULL DEFAULT 'available'
        );

        CREATE TABLE IF NOT EXISTS workspace_ui_state (
          workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
          active_file TEXT,
          open_tabs_json TEXT NOT NULL DEFAULT '[]',
          expanded_paths_json TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          selected_model TEXT,
          branch TEXT,
          approval_mode TEXT,
          turns_json TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS active_session (
          key TEXT PRIMARY KEY,
          active_workspace_id TEXT,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    up(db: DatabaseSync) {
      // Add workbench tab state to support typed tabs (file + chat).
      // ALTER TABLE ADD COLUMN is idempotent-guarded with try/catch because
      // SQLite does not support IF NOT EXISTS on ADD COLUMN.
      try {
        db.exec(`ALTER TABLE workspace_ui_state ADD COLUMN workbench_tabs_json TEXT NOT NULL DEFAULT '[]'`);
      } catch { /* column already exists in existing DBs */ }
      try {
        db.exec(`ALTER TABLE workspace_ui_state ADD COLUMN active_workbench_tab_id TEXT`);
      } catch { /* column already exists */ }
    },
  },
  {
    version: 3,
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_connections (
          id TEXT PRIMARY KEY,
          provider_type TEXT NOT NULL,
          display_name TEXT NOT NULL,
          base_url TEXT,
          credential_status TEXT NOT NULL DEFAULT 'missing',
          models_json TEXT NOT NULL DEFAULT '[]',
          custom_headers_json TEXT NOT NULL DEFAULT '[]',
          connected INTEGER NOT NULL DEFAULT 1,
          enabled INTEGER NOT NULL DEFAULT 1,
          badge TEXT,
          icon_type TEXT,
          description TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS provider_secrets (
          provider_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
          api_key TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 4,
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS durable_tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT,
          thread_id TEXT,
          turn_id TEXT,
          goal TEXT NOT NULL,
          definition_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'created',
          idempotency_key TEXT,
          error_json TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_durable_tasks_workspace ON durable_tasks(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_durable_tasks_status ON durable_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_durable_tasks_idempotency ON durable_tasks(workspace_id, idempotency_key);

        CREATE TABLE IF NOT EXISTS durable_task_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          sequence_number INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          occurred_at INTEGER NOT NULL,
          UNIQUE(task_id, sequence_number)
        );

        CREATE INDEX IF NOT EXISTS idx_durable_task_events_task ON durable_task_events(task_id, sequence_number);

        CREATE TABLE IF NOT EXISTS durable_task_checkpoints (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          step_index INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_durable_task_checkpoints_task ON durable_task_checkpoints(task_id, step_index);

        CREATE TABLE IF NOT EXISTS durable_task_delegations (
          id TEXT PRIMARY KEY,
          parent_task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          child_task_id TEXT REFERENCES durable_tasks(id) ON DELETE SET NULL,
          assigned_mediobot_id TEXT NOT NULL,
          assigned_mediobot_name TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_durable_task_delegations_parent ON durable_task_delegations(parent_task_id);

        CREATE TABLE IF NOT EXISTS durable_task_evidence (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          source_json TEXT NOT NULL DEFAULT '{}',
          claim TEXT,
          content TEXT NOT NULL,
          validity TEXT NOT NULL DEFAULT 'observed',
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_durable_task_evidence_task ON durable_task_evidence(task_id);
      `);
    },
  },
  {
    version: 5,
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE specialist_sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT,
          workspace_key TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          specialist_id TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          context_summary TEXT NOT NULL DEFAULT '',
          context_version INTEGER NOT NULL DEFAULT 1 CHECK(context_version >= 1),
          provenance_json TEXT NOT NULL DEFAULT '[]',
          lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active', 'expired', 'deleted')),
          expires_at INTEGER,
          next_message_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_message_sequence >= 1),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK(workspace_key = COALESCE(workspace_id, '')),
          UNIQUE(workspace_key, thread_id, specialist_id, scope_id)
        );

        CREATE INDEX idx_specialist_sessions_lifecycle ON specialist_sessions(lifecycle, expires_at);

        CREATE TABLE specialist_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES specialist_sessions(id) ON DELETE CASCADE,
          sender_specialist_id TEXT NOT NULL,
          recipient_specialist_id TEXT NOT NULL,
          parent_task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          sequence_number INTEGER NOT NULL CHECK(sequence_number >= 1),
          idempotency_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending', 'delivered', 'failed', 'cancelled', 'expired')),
          content TEXT NOT NULL,
          evidence_refs_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(session_id, sequence_number),
          UNIQUE(session_id, idempotency_key)
        );

        CREATE INDEX idx_specialist_messages_parent ON specialist_messages(parent_task_id, delivery_status);
      `);
    },
  },
  {
    version: 6,
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE collaboration_groups (
          id TEXT PRIMARY KEY,
          parent_task_id TEXT NOT NULL UNIQUE REFERENCES durable_tasks(id) ON DELETE CASCADE,
          workspace_id TEXT,
          workspace_key TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          coordinator_specialist_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
          next_sequence_number INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence_number >= 1),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK(workspace_key = COALESCE(workspace_id, ''))
        );

        CREATE TABLE collaboration_group_members (
          group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
          specialist_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('coordinator', 'specialist')),
          read_sequence_number INTEGER NOT NULL DEFAULT 0 CHECK(read_sequence_number >= 0),
          joined_at INTEGER NOT NULL,
          PRIMARY KEY(group_id, specialist_id)
        );

        CREATE TABLE collaboration_group_messages (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
          parent_task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          sequence_number INTEGER NOT NULL CHECK(sequence_number >= 1),
          sender_specialist_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('finding', 'request')),
          idempotency_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          content TEXT NOT NULL,
          evidence_refs_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          UNIQUE(group_id, sequence_number),
          UNIQUE(group_id, sender_specialist_id, idempotency_key)
        );

        CREATE INDEX idx_collaboration_group_messages_order ON collaboration_group_messages(group_id, sequence_number);
      `);
    },
  },
  {
    version: 7,
    up(db: DatabaseSync) {
      // SQLite cannot widen a CHECK constraint in place. Keep group rows and child
      // references intact while rebuilding only the group identity table.
      db.exec("PRAGMA foreign_keys = OFF;");
      try {
        db.exec(`
          CREATE TABLE collaboration_groups_v7 (
            id TEXT PRIMARY KEY,
            parent_task_id TEXT NOT NULL UNIQUE REFERENCES durable_tasks(id) ON DELETE CASCADE,
            workspace_id TEXT,
            workspace_key TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            coordinator_specialist_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled', 'failed')),
            next_sequence_number INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence_number >= 1),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            CHECK(workspace_key = COALESCE(workspace_id, ''))
          );
          INSERT INTO collaboration_groups_v7 SELECT * FROM collaboration_groups;
          DROP TABLE collaboration_groups;
          ALTER TABLE collaboration_groups_v7 RENAME TO collaboration_groups;
        `);
      } finally {
        db.exec("PRAGMA foreign_keys = ON;");
      }
    },
  },
  {
    version: 8,
    up(db: DatabaseSync) {
      // LangGraph checkpoints share the product SQLite file. These additive
      // tables match the official SQLite saver schema, including deterministic
      // per-task write ordering used during workflow replay.
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          thread_id TEXT NOT NULL,
          checkpoint_ns TEXT NOT NULL DEFAULT '',
          checkpoint_id TEXT NOT NULL,
          parent_checkpoint_id TEXT,
          type TEXT,
          checkpoint BLOB,
          metadata BLOB,
          PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
        );
        CREATE TABLE IF NOT EXISTS writes (
          thread_id TEXT NOT NULL,
          checkpoint_ns TEXT NOT NULL DEFAULT '',
          checkpoint_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_path TEXT NOT NULL DEFAULT '',
          idx INTEGER NOT NULL,
          channel TEXT NOT NULL,
          type TEXT,
          value BLOB,
          PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
        );
        CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_thread
          ON checkpoints(thread_id, checkpoint_ns, checkpoint_id);
        CREATE INDEX IF NOT EXISTS idx_langgraph_writes_checkpoint
          ON writes(thread_id, checkpoint_ns, checkpoint_id, task_path, task_id, idx);
      `);
    },
  },
  {
    version: 9,
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS langgraph_task_outcomes (
          workflow_name TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          checkpoint_ns TEXT NOT NULL DEFAULT '',
          task_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (workflow_name, thread_id, checkpoint_ns, task_id)
        );
      `);
    },
  },
  {
    version: 10,
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS durable_tool_approvals (
          approval_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          invocation_hash TEXT NOT NULL,
          request_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          resolved_at INTEGER,
          reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_durable_tool_approvals_task_status
          ON durable_tool_approvals(task_id, status, expires_at);
        CREATE INDEX IF NOT EXISTS idx_durable_tool_approvals_invocation
          ON durable_tool_approvals(task_id, invocation_hash, status);
      `);
    },
  },
  {
    version: 11,
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS durable_tool_approval_interrupts (
          approval_id TEXT PRIMARY KEY REFERENCES durable_tool_approvals(approval_id) ON DELETE CASCADE,
          interrupt_id TEXT NOT NULL UNIQUE,
          attached_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 12,
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mediobot_definitions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          version TEXT NOT NULL,
          instructions TEXT NOT NULL,
          declared_capabilities_json TEXT NOT NULL,
          lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active', 'draining', 'disabled')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mediobot_definitions_lifecycle
          ON mediobot_definitions(lifecycle_state, name);
      `);
    },
  },
  {
    version: 13,
    up(db: DatabaseSync) {
      try { db.exec("ALTER TABLE mediobot_definitions ADD COLUMN managed INTEGER NOT NULL DEFAULT 0 CHECK(managed IN (0, 1))"); } catch { /* already migrated */ }
      try { db.exec("ALTER TABLE mediobot_definitions ADD COLUMN removed_at INTEGER"); } catch { /* already migrated */ }
      db.exec("CREATE INDEX IF NOT EXISTS idx_mediobot_definitions_removed ON mediobot_definitions(removed_at)");
    },
  },
  {
    version: 14,
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE durable_task_artifacts (
          id TEXT PRIMARY KEY,
          workspace_key TEXT NOT NULL,
          workspace_id TEXT,
          thread_id TEXT,
          task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          mediobot_id TEXT NOT NULL,
          worker_id TEXT NOT NULL,
          name TEXT NOT NULL,
          reference TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
            UNIQUE(workspace_key, reference)
        );
        CREATE INDEX idx_durable_task_artifacts_task ON durable_task_artifacts(task_id, updated_at DESC);
        CREATE INDEX idx_durable_task_artifacts_workspace ON durable_task_artifacts(workspace_key, updated_at DESC);
      `);
    },
  },
  {
    version: 15,
    up(db: DatabaseSync) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          DROP TABLE IF EXISTS durable_task_artifacts_v15;
          CREATE TABLE durable_task_artifacts_v15 (
            id TEXT PRIMARY KEY,
            workspace_key TEXT NOT NULL,
            workspace_id TEXT,
            thread_id TEXT,
            task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
            mediobot_id TEXT NOT NULL,
            worker_id TEXT NOT NULL,
            name TEXT NOT NULL,
            reference TEXT NOT NULL,
            content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(workspace_key, reference, task_id)
          );
          INSERT INTO durable_task_artifacts_v15
            SELECT id, workspace_key, workspace_id, thread_id, task_id, mediobot_id, worker_id, name, reference,
              content_hash, created_at, updated_at FROM durable_task_artifacts;
          DROP TABLE durable_task_artifacts;
          ALTER TABLE durable_task_artifacts_v15 RENAME TO durable_task_artifacts;
          CREATE INDEX idx_durable_task_artifacts_task ON durable_task_artifacts(task_id, updated_at DESC);
          CREATE INDEX idx_durable_task_artifacts_workspace ON durable_task_artifacts(workspace_key, updated_at DESC);
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  },
  {
    version: 16,
    up(db: DatabaseSync) {
      // Search indexes only evidence already recorded by the durable task store.
      // External-content FTS keeps the product data authoritative in SQLite.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS durable_task_evidence_fts USING fts5(
          claim, content, kind,
          content='durable_task_evidence', content_rowid='rowid',
          tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS durable_task_evidence_fts_insert AFTER INSERT ON durable_task_evidence BEGIN
          INSERT INTO durable_task_evidence_fts(rowid, claim, content, kind)
          VALUES (new.rowid, new.claim, new.content, new.kind);
        END;
        CREATE TRIGGER IF NOT EXISTS durable_task_evidence_fts_delete AFTER DELETE ON durable_task_evidence BEGIN
          INSERT INTO durable_task_evidence_fts(durable_task_evidence_fts, rowid, claim, content, kind)
          VALUES ('delete', old.rowid, old.claim, old.content, old.kind);
        END;
        CREATE TRIGGER IF NOT EXISTS durable_task_evidence_fts_update AFTER UPDATE ON durable_task_evidence BEGIN
          INSERT INTO durable_task_evidence_fts(durable_task_evidence_fts, rowid, claim, content, kind)
          VALUES ('delete', old.rowid, old.claim, old.content, old.kind);
          INSERT INTO durable_task_evidence_fts(rowid, claim, content, kind)
          VALUES (new.rowid, new.claim, new.content, new.kind);
        END;
        CREATE INDEX IF NOT EXISTS idx_durable_tasks_thread ON durable_tasks(thread_id);
        INSERT INTO durable_task_evidence_fts(durable_task_evidence_fts) VALUES ('rebuild');
      `);
    },
  },
  {
    version: 17,
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_world_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          world_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 18,
    up(db: DatabaseSync) {
      // 1. Additive columns on durable_tasks for execution scope and inference snapshot
      try { db.exec("ALTER TABLE durable_tasks ADD COLUMN execution_scope_json TEXT;"); } catch { /* already migrated */ }
      try { db.exec("ALTER TABLE durable_tasks ADD COLUMN inference_snapshot_json TEXT;"); } catch { /* already migrated */ }

      // 2. Additive columns on durable_task_evidence for verification checks and provenance
      try { db.exec("ALTER TABLE durable_task_evidence ADD COLUMN criterion_id TEXT;"); } catch { /* already migrated */ }
      try { db.exec("ALTER TABLE durable_task_evidence ADD COLUMN candidate_artifact_hash TEXT;"); } catch { /* already migrated */ }
      try { db.exec("ALTER TABLE durable_task_evidence ADD COLUMN exit_code INTEGER;"); } catch { /* already migrated */ }
      try { db.exec("ALTER TABLE durable_task_evidence ADD COLUMN provenance TEXT;"); } catch { /* already migrated */ }

      // 3. Indexes on durable_task_evidence for criterion lookups
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_durable_task_evidence_criterion
          ON durable_task_evidence(task_id, criterion_id);
        CREATE INDEX IF NOT EXISTS idx_durable_task_evidence_artifact
          ON durable_task_evidence(task_id, candidate_artifact_hash);
      `);

      // 4. Dedicated criteria verification ledger table matching CriterionVerification contract
      db.exec(`
        CREATE TABLE IF NOT EXISTS durable_task_criteria_verifications (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          criterion_id TEXT NOT NULL,
          description TEXT NOT NULL,
          tool_execution_id TEXT NOT NULL,
          candidate_artifact_hash TEXT NOT NULL,
          exit_code INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('passed', 'failed', 'unverified')),
          provenance TEXT NOT NULL CHECK(provenance IN ('runner-observed', 'model-provided')),
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_criteria_verifications_task
          ON durable_task_criteria_verifications(task_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_criteria_verifications_hash
          ON durable_task_criteria_verifications(task_id, candidate_artifact_hash, status);
        CREATE INDEX IF NOT EXISTS idx_criteria_verifications_criterion
          ON durable_task_criteria_verifications(criterion_id);
      `);
    },
  },
];

export class LocalDatabase {
  private readonly db: DatabaseSync;
  readonly path: string;

  constructor(filePath?: string) {
    const target = filePath ?? getDatabasePath();
    assertNonProductionDatabase(target);
    this.path = target;
    this.db = new DatabaseSync(target);
    if (process.platform !== "win32" && target !== ":memory:" && !target.startsWith("file:")) {
      chmodSync(target, 0o600);
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    const rows = this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
    const applied = new Set(rows.map((r) => r.version));

    for (const migration of MIGRATIONS) {
      if (!applied.has(migration.version)) {
        migration.up(this.db);
        const insert = this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
        insert.run(migration.version, Date.now());
      }
    }
  }

  get currentSchemaVersion(): number {
    try {
      const row = this.db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as { version: number | null } | undefined;
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }

  get raw(): DatabaseSync {
    return this.db;
  }

  get rawDb(): DatabaseSync {
    return this.db;
  }


  close(): void {
    this.db.close();
  }
}

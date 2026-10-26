import type { DatabaseSync } from "node:sqlite";

export interface PersistedWorkspace {
  readonly id: string;
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
  readonly availability: "available" | "unavailable";
}

export interface PersistedWorkbenchTab {
  readonly id: string;
  readonly kind: 'file' | 'chat';
  // file tabs
  readonly path?: string;
  readonly name?: string;
  // chat tabs
  readonly threadId?: string;
  readonly title?: string;
}

export interface PersistedWorkspaceUIState {
  readonly workspaceId: string;
  readonly activeFile: string | null;
  readonly openTabs: readonly { readonly path: string; readonly name: string }[];
  readonly expandedPaths: readonly string[];
  readonly updatedAt: number;
  // Workbench tabs (typed: file | chat). Supersedes openTabs + activeFile for rendering.
  readonly workbenchTabs: readonly PersistedWorkbenchTab[];
  readonly activeWorkbenchTabId: string | null;
}

export class WorkspaceRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(): PersistedWorkspace[] {
    const rows = this.db.prepare(
      "SELECT id, canonical_path, display_name, created_at, last_opened_at, availability FROM workspaces ORDER BY last_opened_at DESC"
    ).all() as Array<{
      id: string;
      canonical_path: string;
      display_name: string;
      created_at: number;
      last_opened_at: number;
      availability: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      canonicalPath: r.canonical_path,
      displayName: r.display_name,
      createdAt: r.created_at,
      lastOpenedAt: r.last_opened_at,
      availability: r.availability === "unavailable" ? "unavailable" : "available",
    }));
  }

  get(id: string): PersistedWorkspace | null {
    const row = this.db.prepare(
      "SELECT id, canonical_path, display_name, created_at, last_opened_at, availability FROM workspaces WHERE id = ?"
    ).get(id) as {
      id: string;
      canonical_path: string;
      display_name: string;
      created_at: number;
      last_opened_at: number;
      availability: string;
    } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      canonicalPath: row.canonical_path,
      displayName: row.display_name,
      createdAt: row.created_at,
      lastOpenedAt: row.last_opened_at,
      availability: row.availability === "unavailable" ? "unavailable" : "available",
    };
  }

  findByPath(canonicalPath: string): PersistedWorkspace | null {
    const row = this.db.prepare(
      "SELECT id, canonical_path, display_name, created_at, last_opened_at, availability FROM workspaces WHERE canonical_path = ?"
    ).get(canonicalPath) as {
      id: string;
      canonical_path: string;
      display_name: string;
      created_at: number;
      last_opened_at: number;
      availability: string;
    } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      canonicalPath: row.canonical_path,
      displayName: row.display_name,
      createdAt: row.created_at,
      lastOpenedAt: row.last_opened_at,
      availability: row.availability === "unavailable" ? "unavailable" : "available",
    };
  }

  upsert(workspace: PersistedWorkspace): void {
    const stmt = this.db.prepare(`
      INSERT INTO workspaces (id, canonical_path, display_name, created_at, last_opened_at, availability)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        canonical_path = excluded.canonical_path,
        display_name = excluded.display_name,
        last_opened_at = excluded.last_opened_at,
        availability = excluded.availability
    `);
    stmt.run(
      workspace.id,
      workspace.canonicalPath,
      workspace.displayName,
      workspace.createdAt,
      workspace.lastOpenedAt,
      workspace.availability
    );
  }

  /** Re-key a legacy workspace ID without orphaning its threads or editor state. */
  rekeyWorkspace(oldId: string, workspace: PersistedWorkspace): void {
    if (oldId === workspace.id) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const target = this.get(workspace.id);
      if (target && target.canonicalPath !== workspace.canonicalPath) {
        throw new Error("Workspace identity collision.");
      }
      if (!target) {
        this.upsert(workspace);
      }
      this.db.prepare("UPDATE threads SET workspace_id = ? WHERE workspace_id = ?").run(workspace.id, oldId);
      this.db.prepare(`
        INSERT INTO workspace_ui_state (workspace_id, active_file, open_tabs_json, expanded_paths_json, updated_at, workbench_tabs_json, active_workbench_tab_id)
        SELECT ?, active_file, open_tabs_json, expanded_paths_json, updated_at, workbench_tabs_json, active_workbench_tab_id
        FROM workspace_ui_state WHERE workspace_id = ?
        ON CONFLICT(workspace_id) DO NOTHING
      `).run(workspace.id, oldId);
      this.db.prepare("UPDATE active_session SET active_workspace_id = ? WHERE active_workspace_id = ?").run(workspace.id, oldId);
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(oldId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateLastOpened(id: string, time: number = Date.now()): void {
    this.db.prepare("UPDATE workspaces SET last_opened_at = ?, availability = 'available' WHERE id = ?").run(time, id);
  }

  setAvailability(id: string, availability: "available" | "unavailable"): void {
    this.db.prepare("UPDATE workspaces SET availability = ? WHERE id = ?").run(availability, id);
  }

  getUIState(workspaceId: string): PersistedWorkspaceUIState | null {
    const row = this.db.prepare(
      "SELECT workspace_id, active_file, open_tabs_json, expanded_paths_json, updated_at, workbench_tabs_json, active_workbench_tab_id FROM workspace_ui_state WHERE workspace_id = ?"
    ).get(workspaceId) as {
      workspace_id: string;
      active_file: string | null;
      open_tabs_json: string;
      expanded_paths_json: string;
      updated_at: number;
      workbench_tabs_json?: string | null;
      active_workbench_tab_id?: string | null;
    } | undefined;

    if (!row) return null;

    try {
      return {
        workspaceId: row.workspace_id,
        activeFile: row.active_file,
        openTabs: JSON.parse(row.open_tabs_json),
        expandedPaths: JSON.parse(row.expanded_paths_json),
        updatedAt: row.updated_at,
        workbenchTabs: row.workbench_tabs_json ? JSON.parse(row.workbench_tabs_json) : [],
        activeWorkbenchTabId: row.active_workbench_tab_id ?? null,
      };
    } catch {
      return null;
    }
  }

  saveUIState(state: PersistedWorkspaceUIState): void {
    const stmt = this.db.prepare(`
      INSERT INTO workspace_ui_state (workspace_id, active_file, open_tabs_json, expanded_paths_json, updated_at, workbench_tabs_json, active_workbench_tab_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        active_file = excluded.active_file,
        open_tabs_json = excluded.open_tabs_json,
        expanded_paths_json = excluded.expanded_paths_json,
        updated_at = excluded.updated_at,
        workbench_tabs_json = excluded.workbench_tabs_json,
        active_workbench_tab_id = excluded.active_workbench_tab_id
    `);
    stmt.run(
      state.workspaceId,
      state.activeFile,
      JSON.stringify(state.openTabs),
      JSON.stringify(state.expandedPaths),
      state.updatedAt,
      JSON.stringify(state.workbenchTabs ?? []),
      state.activeWorkbenchTabId ?? null
    );
  }

  getActiveWorkspaceId(): string | null {
    const row = this.db.prepare("SELECT active_workspace_id FROM active_session WHERE key = 'current'").get() as {
      active_workspace_id: string | null;
    } | undefined;

    return row ? row.active_workspace_id : null;
  }

  setActiveWorkspaceId(id: string | null): void {
    const stmt = this.db.prepare(`
      INSERT INTO active_session (key, active_workspace_id, updated_at)
      VALUES ('current', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        active_workspace_id = excluded.active_workspace_id,
        updated_at = excluded.updated_at
    `);
    stmt.run(id, Date.now());
  }
}

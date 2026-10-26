import type { DatabaseSync } from "node:sqlite";
import type { ApprovalRecordStore, ApprovalRequest, StoredApprovalRecord, StoredApprovalStatus } from "@mediobot-v2/tools";
import type { TaskId } from "@mediobot-v2/domain";

interface ApprovalRow {
  approval_id: string;
  task_id: string;
  invocation_hash: string;
  request_json: string;
  status: StoredApprovalStatus;
  resolved_at: number | null;
  reason: string | null;
  interrupt_id: string | null;
}

/** SQLite persistence for restartable, one-action tool approvals. The action is stored as a hash. */
export class SqliteApprovalRecordStore implements ApprovalRecordStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  listRequested(): ReadonlyArray<StoredApprovalRecord> {
    const rows = this.db.prepare(`SELECT a.approval_id, a.task_id, a.invocation_hash, a.request_json, a.status, a.resolved_at, a.reason,
      i.interrupt_id FROM durable_tool_approvals a LEFT JOIN durable_tool_approval_interrupts i USING (approval_id)
      WHERE a.status = 'requested' AND a.expires_at > ? ORDER BY a.created_at`)
      .all(Date.now()) as unknown as ApprovalRow[];
    return rows.map(row => this.toRecord(row));
  }

  findActive(taskId: TaskId, invocationHash: string): StoredApprovalRecord | undefined {
    const row = this.db.prepare(`SELECT a.approval_id, a.task_id, a.invocation_hash, a.request_json, a.status, a.resolved_at, a.reason,
      i.interrupt_id FROM durable_tool_approvals a LEFT JOIN durable_tool_approval_interrupts i USING (approval_id)
      WHERE a.task_id = ? AND a.invocation_hash = ?
        AND a.status IN ('requested', 'approved', 'rejected', 'consumed', 'rejected_consumed')
        AND (a.status IN ('rejected', 'consumed', 'rejected_consumed') OR a.expires_at > ?) ORDER BY a.created_at DESC LIMIT 1`)
      .get(taskId, invocationHash, Date.now()) as unknown as ApprovalRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  get(approvalId: string): StoredApprovalRecord | undefined {
    const row = this.db.prepare(`SELECT a.approval_id, a.task_id, a.invocation_hash, a.request_json, a.status, a.resolved_at, a.reason,
      i.interrupt_id FROM durable_tool_approvals a LEFT JOIN durable_tool_approval_interrupts i USING (approval_id)
      WHERE a.approval_id = ?`).get(approvalId) as unknown as ApprovalRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  save(record: StoredApprovalRecord): void {
    const { request } = record;
    const persistedRequest: ApprovalRequest = { ...request,
      scope: { toolName: request.scope.toolName, detail: request.sanitizedDescription } };
    this.db.prepare(`INSERT INTO durable_tool_approvals
      (approval_id, task_id, invocation_hash, request_json, status, created_at, expires_at, resolved_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(approval_id) DO UPDATE SET invocation_hash = excluded.invocation_hash,
        request_json = excluded.request_json, status = excluded.status, expires_at = excluded.expires_at,
        resolved_at = excluded.resolved_at, reason = excluded.reason`)
      .run(request.approvalId, request.taskId, record.invocationHash, JSON.stringify(persistedRequest), record.status,
        request.createdAt, request.expiresAt, request.resolvedAt ?? null, request.reason ?? null);
  }

  setStatus(approvalId: string, status: StoredApprovalStatus, resolvedAt?: number, reason?: string): void {
    this.db.prepare(`UPDATE durable_tool_approvals SET status = ?, resolved_at = ?, reason = ? WHERE approval_id = ?`)
      .run(status, resolvedAt ?? null, reason ?? null, approvalId);
  }

  setWorkflowInterruptId(approvalId: string, interruptId: string): void {
    this.db.prepare(`INSERT INTO durable_tool_approval_interrupts (approval_id, interrupt_id, attached_at)
      VALUES (?, ?, ?) ON CONFLICT(approval_id) DO UPDATE SET interrupt_id = excluded.interrupt_id, attached_at = excluded.attached_at`)
      .run(approvalId, interruptId, Date.now());
  }

  private toRecord(row: ApprovalRow): StoredApprovalRecord {
    const request = JSON.parse(row.request_json) as ApprovalRequest;
    request.status = row.status === "consumed" ? "approved"
      : row.status === "rejected_consumed" ? "rejected" : row.status;
    if (row.resolved_at !== null) request.resolvedAt = row.resolved_at;
    if (row.reason !== null) request.reason = row.reason;
    return { request, invocationHash: row.invocation_hash, status: row.status,
      ...(row.interrupt_id ? { workflowInterruptId: row.interrupt_id } : {}) };
  }
}

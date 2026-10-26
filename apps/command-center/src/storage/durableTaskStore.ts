import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { AppendCollaborationGroupMessageInput, CollaborationGroupMemberRecord, CollaborationGroupMessageRecord,
  CollaborationGroupReadResult, CollaborationGroupRecord, CollaborationGroupStatus, SpecialistMessageDeliveryStatus, SpecialistMessageRecord, SpecialistSessionContextUpdate,
  SpecialistSessionIdentity, SpecialistSessionRecord, ExecutionScope, InferenceSnapshot, CriterionVerification } from "@mediobot-v2/contracts";
import { SPECIALIST_CONTEXT_PROVENANCE_MAX_ITEMS, SPECIALIST_CONTEXT_SUMMARY_MAX_CHARS, SPECIALIST_MESSAGE_EVIDENCE_MAX_CHARS,
  SPECIALIST_MESSAGE_EVIDENCE_MAX_ITEMS, SPECIALIST_MESSAGE_MAX_CHARS, COLLABORATION_GROUP_MAX_MESSAGES,
  COLLABORATION_GROUP_MESSAGE_MAX_CHARS, COLLABORATION_GROUP_MAX_MEMBERS, COLLABORATION_GROUP_MAX_REQUESTS_PER_SENDER } from "@mediobot-v2/contracts";
import type {
  DurableTaskStore,
  DurableTaskRecord,
  DurableTaskEventRecord,
  DurableTaskCheckpointRecord,
  DurableTaskDelegationRecord,
  DurableTaskEvidenceRecord,
  DurableTaskArtifactRecord,
  DurableTaskStatus,
} from "@mediobot-v2/runtime";

const MEMORY_QUERY_STOP_WORDS = new Set(["about", "after", "before", "could", "does", "from", "have", "into", "make", "please", "that", "their", "there", "these", "this", "those", "with", "would"]);

export interface SqliteDurableTaskRecord extends DurableTaskRecord {
  readonly executionScope?: ExecutionScope;
  readonly inferenceSnapshot?: InferenceSnapshot;
}

export interface SqliteDurableTaskEvidenceRecord extends DurableTaskEvidenceRecord {
  readonly criterionId?: string | null;
  readonly candidateArtifactHash?: string | null;
  readonly exitCode?: number | null;
  readonly provenance?: string | null;
}

interface SqliteTaskRow {
  id: string;
  workspace_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  goal: string;
  definition_id: string;
  status: string;
  idempotency_key: string | null;
  error_json: string | null;
  retry_count: number;
  max_retries: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  execution_scope_json?: string | null;
  inference_snapshot_json?: string | null;
}

interface SqliteEventRow {
  id: string;
  task_id: string;
  sequence_number: number;
  event_type: string;
  payload_json: string;
  occurred_at: number;
}

interface SqliteCheckpointRow {
  id: string;
  task_id: string;
  step_index: number;
  snapshot_json: string;
  created_at: number;
}

interface SqliteDelegationRow {
  id: string;
  parent_task_id: string;
  child_task_id: string | null;
  assigned_mediobot_id: string;
  assigned_mediobot_name: string;
  objective: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface SqliteEvidenceRow {
  id: string;
  task_id: string;
  kind: string;
  source_json: string;
  claim: string | null;
  content: string;
  validity: string;
  created_at: number;
  criterion_id?: string | null;
  candidate_artifact_hash?: string | null;
  exit_code?: number | null;
  provenance?: string | null;
}

interface SqliteArtifactRow {
  id: string; workspace_key: string; workspace_id: string | null; thread_id: string | null; task_id: string;
  mediobot_id: string; worker_id: string; name: string; reference: string; content_hash: string; created_at: number; updated_at: number;
}

interface SqliteSpecialistSessionRow {
  id: string; workspace_id: string | null; workspace_key: string; thread_id: string; specialist_id: string; scope_id: string;
  context_summary: string; context_version: number; provenance_json: string; lifecycle: string; expires_at: number | null;
  next_message_sequence: number; created_at: number; updated_at: number;
}

interface SqliteSpecialistMessageRow {
  id: string; session_id: string; sender_specialist_id: string; recipient_specialist_id: string; parent_task_id: string;
  sequence_number: number; idempotency_key: string; payload_hash: string; delivery_status: string; content: string;
  evidence_refs_json: string; created_at: number; updated_at: number; workspace_id: string | null;
  thread_id: string; scope_id: string;
}

interface SqliteCollaborationGroupRow {
  id: string; parent_task_id: string; workspace_id: string | null; workspace_key: string; thread_id: string; scope_id: string;
  coordinator_specialist_id: string; status: string; next_sequence_number: number; created_at: number; updated_at: number;
}
interface SqliteCollaborationMemberRow {
  group_id: string; specialist_id: string; role: string; read_sequence_number: number; joined_at: number;
}
interface SqliteCollaborationMessageRow {
  id: string; group_id: string; parent_task_id: string; sequence_number: number; sender_specialist_id: string; kind: string;
  idempotency_key: string; payload_hash: string; content: string; evidence_refs_json: string; created_at: number;
}

export class SqliteDurableTaskStore implements DurableTaskStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private identityValues(identity: SpecialistSessionIdentity): [string, string, string, string] {
    if ((identity.workspaceId !== null && (!identity.workspaceId.trim() || identity.workspaceId.length > 200))
      || !identity.threadId.trim() || identity.threadId.length > 200 || !String(identity.specialistId).trim()
      || String(identity.specialistId).length > 200 || !identity.scopeId.trim() || identity.scopeId.length > 200) {
      throw new Error("Invalid specialist session scope.");
    }
    return [identity.workspaceId ?? "", identity.threadId, String(identity.specialistId), identity.scopeId];
  }

  private sessionRow(identity: SpecialistSessionIdentity): SqliteSpecialistSessionRow | undefined {
    const values = this.identityValues(identity);
    return this.db.prepare(`SELECT * FROM specialist_sessions WHERE workspace_key = ? AND thread_id = ? AND specialist_id = ? AND scope_id = ?`)
      .get(...values) as unknown as SqliteSpecialistSessionRow | undefined;
  }

  private mapSpecialistSession(row: SqliteSpecialistSessionRow): SpecialistSessionRecord {
    let provenance: SpecialistSessionRecord["provenance"] = [];
    try { provenance = JSON.parse(row.provenance_json || "[]"); } catch { /* corrupted optional metadata is omitted */ }
    return { id: row.id, workspaceId: row.workspace_id, threadId: row.thread_id, specialistId: row.specialist_id as SpecialistSessionIdentity["specialistId"],
      scopeId: row.scope_id, contextSummary: row.context_summary, contextVersion: row.context_version, provenance,
      lifecycle: row.lifecycle as SpecialistSessionRecord["lifecycle"], expiresAt: row.expires_at,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private mapSpecialistMessage(row: SqliteSpecialistMessageRow): SpecialistMessageRecord {
    let evidenceRefs: string[] = [];
    try { evidenceRefs = JSON.parse(row.evidence_refs_json || "[]"); } catch { /* corrupted optional metadata is omitted */ }
    return { id: row.id, workspaceId: row.workspace_id, threadId: row.thread_id, scopeId: row.scope_id,
      senderSpecialistId: row.sender_specialist_id as SpecialistMessageRecord["senderSpecialistId"],
      recipientSpecialistId: row.recipient_specialist_id as SpecialistMessageRecord["recipientSpecialistId"],
      parentTaskId: row.parent_task_id as SpecialistMessageRecord["parentTaskId"], sequenceNumber: row.sequence_number,
      idempotencyKey: row.idempotency_key, deliveryStatus: row.delivery_status as SpecialistMessageDeliveryStatus,
      content: row.content, evidenceRefs, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private mapCollaborationGroup(row: SqliteCollaborationGroupRow): CollaborationGroupRecord {
    return { id: row.id, parentTaskId: row.parent_task_id as CollaborationGroupRecord["parentTaskId"], workspaceId: row.workspace_id,
      threadId: row.thread_id, scopeId: row.scope_id, coordinatorSpecialistId: row.coordinator_specialist_id as CollaborationGroupRecord["coordinatorSpecialistId"],
      status: row.status as CollaborationGroupStatus, nextSequenceNumber: row.next_sequence_number, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private mapCollaborationMember(row: SqliteCollaborationMemberRow): CollaborationGroupMemberRecord {
    return { groupId: row.group_id, specialistId: row.specialist_id as CollaborationGroupMemberRecord["specialistId"],
      role: row.role as CollaborationGroupMemberRecord["role"], readSequenceNumber: row.read_sequence_number, joinedAt: row.joined_at };
  }

  private mapCollaborationMessage(row: SqliteCollaborationMessageRow): CollaborationGroupMessageRecord {
    let evidenceRefs: string[] = [];
    try { evidenceRefs = JSON.parse(row.evidence_refs_json || "[]"); } catch { /* corrupt optional evidence metadata is omitted */ }
    return { id: row.id, groupId: row.group_id, parentTaskId: row.parent_task_id as CollaborationGroupMessageRecord["parentTaskId"],
      sequenceNumber: row.sequence_number, senderSpecialistId: row.sender_specialist_id as CollaborationGroupMessageRecord["senderSpecialistId"],
      kind: row.kind as CollaborationGroupMessageRecord["kind"], idempotencyKey: row.idempotency_key, content: row.content, evidenceRefs,
      createdAt: row.created_at };
  }

  private appendTaskEvent(taskId: string, eventType: string, payload: Record<string, unknown>, occurredAt = Date.now()): void {
    const seq = this.db.prepare("SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq FROM durable_task_events WHERE task_id = ?")
      .get(taskId) as unknown as { next_seq: number };
    this.db.prepare(`INSERT INTO durable_task_events (id, task_id, sequence_number, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`event-${crypto.randomUUID()}`, taskId, seq.next_seq, eventType, JSON.stringify(payload), occurredAt);
  }

  private expireSession(row: SqliteSpecialistSessionRow, now: number): SqliteSpecialistSessionRow {
    if (row.lifecycle !== "active" || row.expires_at === null || row.expires_at > now) return row;
    return this.transaction(() => {
      this.db.prepare(`UPDATE specialist_sessions SET lifecycle = 'expired', context_summary = '', provenance_json = '[]', updated_at = ? WHERE id = ? AND lifecycle = 'active'`)
        .run(now, row.id);
      const pending = this.db.prepare(`SELECT m.*, s.workspace_id, s.thread_id, s.scope_id FROM specialist_messages m JOIN specialist_sessions s ON s.id = m.session_id WHERE m.session_id = ? AND m.delivery_status = 'pending' ORDER BY m.sequence_number`)
        .all(row.id) as unknown as SqliteSpecialistMessageRow[];
      for (const message of pending) {
        this.db.prepare("UPDATE specialist_messages SET delivery_status = 'expired', updated_at = ? WHERE id = ? AND delivery_status = 'pending'").run(now, message.id);
        this.appendTaskEvent(message.parent_task_id, "specialist.message.expired", { messageId: message.id, sequenceNumber: message.sequence_number }, now);
      }
      const expired = this.db.prepare("SELECT * FROM specialist_sessions WHERE id = ?").get(row.id) as unknown as SqliteSpecialistSessionRow;
      return expired;
    });
  }

  private mapTask(row: SqliteTaskRow): SqliteDurableTaskRecord {
    let error: DurableTaskRecord["error"] = null;
    if (row.error_json) {
      try {
        error = JSON.parse(row.error_json);
      } catch {
        error = { code: "parse-error", message: row.error_json };
      }
    }
    let executionScope: ExecutionScope | undefined = undefined;
    if (row.execution_scope_json) {
      try {
        executionScope = JSON.parse(row.execution_scope_json);
      } catch {
        // omitted on parse error
      }
    }
    let inferenceSnapshot: InferenceSnapshot | undefined = undefined;
    if (row.inference_snapshot_json) {
      try {
        inferenceSnapshot = JSON.parse(row.inference_snapshot_json);
      } catch {
        // omitted on parse error
      }
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      goal: row.goal,
      definitionId: row.definition_id,
      status: row.status as DurableTaskStatus,
      idempotencyKey: row.idempotency_key,
      error,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      ...(executionScope ? { executionScope } : {}),
      ...(inferenceSnapshot ? { inferenceSnapshot } : {}),
    };
  }

  createTask(
    task: Omit<DurableTaskRecord, "status" | "retryCount" | "createdAt" | "updatedAt"> & {
      readonly executionScope?: ExecutionScope;
      readonly inferenceSnapshot?: InferenceSnapshot;
    }
  ): SqliteDurableTaskRecord {
    const now = Date.now();
    const status: DurableTaskStatus = "created";
    const retryCount = 0;
    const maxRetries = task.maxRetries ?? 3;

    const stmt = this.db.prepare(`
      INSERT INTO durable_tasks (
        id, workspace_id, thread_id, turn_id, goal, definition_id,
        status, idempotency_key, error_json, retry_count, max_retries,
        created_at, updated_at, completed_at,
        execution_scope_json, inference_snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      task.workspaceId ?? null,
      task.threadId ?? null,
      task.turnId ?? null,
      task.goal,
      task.definitionId,
      status,
      task.idempotencyKey ?? null,
      task.error ? JSON.stringify(task.error) : null,
      retryCount,
      maxRetries,
      now,
      now,
      task.completedAt ?? null,
      task.executionScope ? JSON.stringify(task.executionScope) : null,
      task.inferenceSnapshot ? JSON.stringify(task.inferenceSnapshot) : null,
    );

    return {
      id: task.id,
      workspaceId: task.workspaceId ?? null,
      threadId: task.threadId ?? null,
      turnId: task.turnId ?? null,
      goal: task.goal,
      definitionId: task.definitionId,
      status,
      idempotencyKey: task.idempotencyKey ?? null,
      error: task.error ?? null,
      retryCount,
      maxRetries,
      createdAt: now,
      updatedAt: now,
      completedAt: task.completedAt ?? null,
      ...(task.executionScope ? { executionScope: task.executionScope } : {}),
      ...(task.inferenceSnapshot ? { inferenceSnapshot: task.inferenceSnapshot } : {}),
    };
  }

  getTask(id: string): SqliteDurableTaskRecord | null {
    const stmt = this.db.prepare("SELECT * FROM durable_tasks WHERE id = ?");
    const row = stmt.get(id) as unknown as SqliteTaskRow | undefined;
    return row ? this.mapTask(row) : null;
  }

  getByIdempotencyKey(key: string, workspaceId?: string | null): SqliteDurableTaskRecord | null {
    let row: SqliteTaskRow | undefined;
    if (workspaceId !== undefined) {
      if (workspaceId === null) {
        const stmt = this.db.prepare("SELECT * FROM durable_tasks WHERE idempotency_key = ? AND workspace_id IS NULL");
        row = stmt.get(key) as unknown as SqliteTaskRow | undefined;
      } else {
        const stmt = this.db.prepare("SELECT * FROM durable_tasks WHERE idempotency_key = ? AND workspace_id = ?");
        row = stmt.get(key, workspaceId) as unknown as SqliteTaskRow | undefined;
      }
    } else {
      const stmt = this.db.prepare("SELECT * FROM durable_tasks WHERE idempotency_key = ?");
      row = stmt.get(key) as unknown as SqliteTaskRow | undefined;
    }
    return row ? this.mapTask(row) : null;
  }

  updateTask(
    id: string,
    updates: Partial<Pick<DurableTaskRecord, "status" | "error" | "retryCount" | "completedAt">>,
  ): SqliteDurableTaskRecord {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`Task "${id}" not found`);

    const now = Date.now();
    const status = updates.status ?? existing.status;
    const retryCount = updates.retryCount ?? existing.retryCount;
    const completedAt = updates.completedAt !== undefined ? updates.completedAt : existing.completedAt;
    const error = updates.error !== undefined ? updates.error : existing.error;
    const errorJson = error ? JSON.stringify(error) : null;

    const stmt = this.db.prepare(`
      UPDATE durable_tasks
      SET status = ?, retry_count = ?, completed_at = ?, error_json = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(status, retryCount, completedAt, errorJson, now, id);

    return {
      ...existing,
      status,
      retryCount,
      completedAt,
      error,
      updatedAt: now,
    };
  }

  listTasks(workspaceId?: string | null): SqliteDurableTaskRecord[] {
    if (workspaceId !== undefined) {
      if (workspaceId === null) {
        const stmt = this.db.prepare("SELECT * FROM durable_tasks WHERE workspace_id IS NULL ORDER BY created_at DESC");
        const rows = stmt.all() as unknown as SqliteTaskRow[];
        return rows.map((r) => this.mapTask(r));
      } else {
        const stmt = this.db.prepare("SELECT * FROM durable_tasks WHERE workspace_id = ? ORDER BY created_at DESC");
        const rows = stmt.all(workspaceId) as unknown as SqliteTaskRow[];
        return rows.map((r) => this.mapTask(r));
      }
    }
    const stmt = this.db.prepare("SELECT * FROM durable_tasks ORDER BY created_at DESC");
    const rows = stmt.all() as unknown as SqliteTaskRow[];
    return rows.map((r) => this.mapTask(r));
  }

  appendEvent(taskId: string, eventType: string, payload: Record<string, unknown>): DurableTaskEventRecord {
    return this.appendEventRecord(taskId, eventType, payload);
  }

  private appendEventRecord(taskId: string, eventType: string, payload: Record<string, unknown>): DurableTaskEventRecord {
    const seqStmt = this.db.prepare("SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq FROM durable_task_events WHERE task_id = ?");
    const seqRow = seqStmt.get(taskId) as unknown as { next_seq: number };
    const sequenceNumber = seqRow.next_seq;
    const eventId = `event-${crypto.randomUUID()}`;
    const now = Date.now();
    const payloadJson = JSON.stringify(payload ?? {});

    const insertStmt = this.db.prepare(`
      INSERT INTO durable_task_events (id, task_id, sequence_number, event_type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(eventId, taskId, sequenceNumber, eventType, payloadJson, now);

    return {
      id: eventId,
      taskId,
      sequenceNumber,
      eventType,
      payload,
      occurredAt: now,
    };
  }

  getEvents(taskId: string): DurableTaskEventRecord[] {
    const stmt = this.db.prepare("SELECT * FROM durable_task_events WHERE task_id = ? ORDER BY sequence_number ASC");
    const rows = stmt.all(taskId) as unknown as SqliteEventRow[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      sequenceNumber: r.sequence_number,
      eventType: r.event_type,
      payload: JSON.parse(r.payload_json || "{}"),
      occurredAt: r.occurred_at,
    }));
  }

  trimEvents(taskId: string, eventType: string, retainCount: number): void {
    const boundedCount = Math.max(1, Math.min(10_000, Math.floor(retainCount)));
    this.db.prepare(`
      DELETE FROM durable_task_events
      WHERE task_id = ? AND event_type = ? AND sequence_number IN (
        SELECT sequence_number FROM durable_task_events
        WHERE task_id = ? AND event_type = ?
        ORDER BY sequence_number DESC LIMIT -1 OFFSET ?
      )
    `).run(taskId, eventType, taskId, eventType, boundedCount);
  }

  createCheckpoint(taskId: string, stepIndex: number, snapshot: Record<string, unknown>): DurableTaskCheckpointRecord {
    const id = `chk-${crypto.randomUUID()}`;
    const now = Date.now();
    const snapshotJson = JSON.stringify(snapshot ?? {});

    const stmt = this.db.prepare(`
      INSERT INTO durable_task_checkpoints (id, task_id, step_index, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(id, taskId, stepIndex, snapshotJson, now);

    return {
      id,
      taskId,
      stepIndex,
      snapshot,
      createdAt: now,
    };
  }

  getCheckpoints(taskId: string): DurableTaskCheckpointRecord[] {
    const stmt = this.db.prepare("SELECT * FROM durable_task_checkpoints WHERE task_id = ? ORDER BY step_index ASC");
    const rows = stmt.all(taskId) as unknown as SqliteCheckpointRow[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      stepIndex: r.step_index,
      snapshot: JSON.parse(r.snapshot_json || "{}"),
      createdAt: r.created_at,
    }));
  }

  createDelegation(delegation: Omit<DurableTaskDelegationRecord, "id" | "createdAt" | "updatedAt">): DurableTaskDelegationRecord {
    const id = `del-${crypto.randomUUID()}`;
    const now = Date.now();
    const status = delegation.status ?? "pending";

    const stmt = this.db.prepare(`
      INSERT INTO durable_task_delegations (
        id, parent_task_id, child_task_id, assigned_mediobot_id,
        assigned_mediobot_name, objective, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      delegation.parentTaskId,
      delegation.childTaskId ?? null,
      delegation.assignedMediobotId,
      delegation.assignedMediobotName,
      delegation.objective,
      status,
      now,
      now,
    );

    return {
      id,
      parentTaskId: delegation.parentTaskId,
      childTaskId: delegation.childTaskId ?? null,
      assignedMediobotId: delegation.assignedMediobotId,
      assignedMediobotName: delegation.assignedMediobotName,
      objective: delegation.objective,
      status: status as any,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateDelegation(id: string, updates: Partial<Pick<DurableTaskDelegationRecord, "childTaskId" | "status">>): DurableTaskDelegationRecord {
    const selectStmt = this.db.prepare("SELECT * FROM durable_task_delegations WHERE id = ?");
    const row = selectStmt.get(id) as unknown as SqliteDelegationRow | undefined;
    if (!row) throw new Error(`Delegation "${id}" not found`);

    const now = Date.now();
    const childTaskId = updates.childTaskId !== undefined ? updates.childTaskId : row.child_task_id;
    const status = updates.status !== undefined ? updates.status : row.status;

    const stmt = this.db.prepare(`
      UPDATE durable_task_delegations
      SET child_task_id = ?, status = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(childTaskId, status, now, id);

    return {
      id: row.id,
      parentTaskId: row.parent_task_id,
      childTaskId,
      assignedMediobotId: row.assigned_mediobot_id,
      assignedMediobotName: row.assigned_mediobot_name,
      objective: row.objective,
      status: status as any,
      createdAt: row.created_at,
      updatedAt: now,
    };
  }

  getDelegations(parentTaskId: string): DurableTaskDelegationRecord[] {
    const stmt = this.db.prepare("SELECT * FROM durable_task_delegations WHERE parent_task_id = ? ORDER BY created_at ASC");
    const rows = stmt.all(parentTaskId) as unknown as SqliteDelegationRow[];
    return rows.map((r) => ({
      id: r.id,
      parentTaskId: r.parent_task_id,
      childTaskId: r.child_task_id,
      assignedMediobotId: r.assigned_mediobot_id,
      assignedMediobotName: r.assigned_mediobot_name,
      objective: r.objective,
      status: r.status as any,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  findParentTaskForChild(childTaskId: string, workspaceId?: string | null): string | null {
    const row = workspaceId === undefined
      ? this.db.prepare(`SELECT parent_task_id FROM durable_task_delegations WHERE child_task_id = ? ORDER BY created_at DESC LIMIT 1`).get(childTaskId)
      : this.db.prepare(`SELECT d.parent_task_id FROM durable_task_delegations d
          JOIN durable_tasks t ON t.id = d.parent_task_id
          WHERE d.child_task_id = ? AND t.workspace_id IS ? ORDER BY d.created_at DESC LIMIT 1`).get(childTaskId, workspaceId);
    return (row as { parent_task_id?: string } | undefined)?.parent_task_id ?? null;
  }

  addEvidence(
    evidence: Omit<DurableTaskEvidenceRecord, "id" | "createdAt"> & {
      readonly criterionId?: string | null;
      readonly candidateArtifactHash?: string | null;
      readonly exitCode?: number | null;
      readonly provenance?: string | null;
    }
  ): SqliteDurableTaskEvidenceRecord {
    const id = `ev-${crypto.randomUUID()}`;
    const now = Date.now();
    const sourceJson = JSON.stringify(evidence.source ?? {});

    const stmt = this.db.prepare(`
      INSERT INTO durable_task_evidence (
        id, task_id, kind, source_json, claim, content, validity, created_at,
        criterion_id, candidate_artifact_hash, exit_code, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      evidence.taskId,
      evidence.kind,
      sourceJson,
      evidence.claim ?? null,
      evidence.content,
      evidence.validity,
      now,
      evidence.criterionId ?? null,
      evidence.candidateArtifactHash ?? null,
      evidence.exitCode ?? null,
      evidence.provenance ?? null,
    );

    return {
      id,
      taskId: evidence.taskId,
      kind: evidence.kind,
      source: evidence.source,
      claim: evidence.claim ?? null,
      content: evidence.content,
      validity: evidence.validity,
      createdAt: now,
      ...(evidence.criterionId !== undefined ? { criterionId: evidence.criterionId } : {}),
      ...(evidence.candidateArtifactHash !== undefined ? { candidateArtifactHash: evidence.candidateArtifactHash } : {}),
      ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
      ...(evidence.provenance !== undefined ? { provenance: evidence.provenance } : {}),
    };
  }

  getEvidence(taskId: string): SqliteDurableTaskEvidenceRecord[] {
    const stmt = this.db.prepare("SELECT * FROM durable_task_evidence WHERE task_id = ? ORDER BY created_at ASC");
    const rows = stmt.all(taskId) as unknown as SqliteEvidenceRow[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      kind: r.kind,
      source: JSON.parse(r.source_json || "{}"),
      claim: r.claim,
      content: r.content,
      validity: r.validity as any,
      createdAt: r.created_at,
      ...(r.criterion_id !== undefined && r.criterion_id !== null ? { criterionId: r.criterion_id } : {}),
      ...(r.candidate_artifact_hash !== undefined && r.candidate_artifact_hash !== null ? { candidateArtifactHash: r.candidate_artifact_hash } : {}),
      ...(r.exit_code !== undefined && r.exit_code !== null ? { exitCode: r.exit_code } : {}),
      ...(r.provenance !== undefined && r.provenance !== null ? { provenance: r.provenance } : {}),
    }));
  }

  recordCriterionVerification(verification: CriterionVerification & { taskId: string }): CriterionVerification {
    const id = `cv-${crypto.randomUUID()}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO durable_task_criteria_verifications (
        id, task_id, criterion_id, description, tool_execution_id,
        candidate_artifact_hash, exit_code, status, provenance, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      verification.taskId,
      verification.criterionId,
      verification.description,
      verification.toolExecutionId,
      verification.candidateArtifactHash,
      verification.exitCode,
      verification.status,
      verification.provenance,
      now,
    );
    return verification;
  }

  getCriteriaVerifications(taskId: string, candidateArtifactHash?: string): ReadonlyArray<CriterionVerification> {
    let stmt;
    if (candidateArtifactHash !== undefined) {
      stmt = this.db.prepare(`
        SELECT criterion_id AS criterionId, description, tool_execution_id AS toolExecutionId,
               candidate_artifact_hash AS candidateArtifactHash, exit_code AS exitCode,
               status, provenance
        FROM durable_task_criteria_verifications
        WHERE task_id = ? AND candidate_artifact_hash = ?
        ORDER BY created_at ASC
      `);
      return stmt.all(taskId, candidateArtifactHash) as unknown as CriterionVerification[];
    }
    stmt = this.db.prepare(`
      SELECT criterion_id AS criterionId, description, tool_execution_id AS toolExecutionId,
             candidate_artifact_hash AS candidateArtifactHash, exit_code AS exitCode,
             status, provenance
      FROM durable_task_criteria_verifications
      WHERE task_id = ?
      ORDER BY created_at ASC
    `);
    return stmt.all(taskId) as unknown as CriterionVerification[];
  }

  searchVerifiedEvidence(workspaceId: string | null, threadId: string | null, currentTaskId: string, query: string, limit: number): DurableTaskEvidenceRecord[] {
    const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])
      .filter(term => !MEMORY_QUERY_STOP_WORDS.has(term)))].slice(0, 10);
    if (!terms.length) return [];
    const match = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(" OR ");
    const scope = workspaceId
      ? "t.workspace_id = ?"
      : "t.workspace_id IS NULL AND t.thread_id = ?";
    const scopeValue = workspaceId ?? threadId;
    if (!scopeValue) return [];
    const rows = this.db.prepare(`SELECT e.* FROM durable_task_evidence_fts
      JOIN durable_task_evidence e ON e.rowid = durable_task_evidence_fts.rowid
      JOIN durable_tasks t ON t.id = e.task_id
      WHERE durable_task_evidence_fts MATCH ? AND ${scope} AND e.task_id <> ? AND e.validity = 'verified'
      ORDER BY bm25(durable_task_evidence_fts), e.created_at DESC LIMIT ?`)
      .all(match, scopeValue, currentTaskId, Math.max(1, Math.min(5, Math.floor(limit)))) as unknown as SqliteEvidenceRow[];
    return rows.map(row => ({ id: row.id, taskId: row.task_id, kind: row.kind, source: JSON.parse(row.source_json || "{}"),
      claim: row.claim, content: row.content, validity: row.validity as DurableTaskEvidenceRecord["validity"], createdAt: row.created_at }));
  }

  upsertArtifact(artifact: DurableTaskArtifactRecord): { artifact: DurableTaskArtifactRecord; changed: boolean } {
    return this.transaction(() => this.upsertArtifactRecord(artifact));
  }

  private upsertArtifactRecord(artifact: DurableTaskArtifactRecord): { artifact: DurableTaskArtifactRecord; changed: boolean } {
    const workspaceKey = artifact.workspaceId ? `workspace:${artifact.workspaceId}`
      : artifact.threadId ? `thread:${artifact.threadId}` : `task:${artifact.taskId}`;
    const existing = this.db.prepare(`SELECT * FROM durable_task_artifacts WHERE workspace_key = ? AND reference = ? AND task_id = ?`)
      .get(workspaceKey, artifact.reference, artifact.taskId) as unknown as SqliteArtifactRow | undefined;
    if (!existing) {
      this.db.prepare(`INSERT INTO durable_task_artifacts
        (id, workspace_key, workspace_id, thread_id, task_id, mediobot_id, worker_id, name, reference, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(artifact.id, workspaceKey, artifact.workspaceId, artifact.threadId,
        artifact.taskId, artifact.mediobotId, artifact.workerId, artifact.name, artifact.reference, artifact.contentHash, artifact.createdAt, artifact.updatedAt);
      return { artifact: { ...artifact }, changed: true };
    }
    const changed = existing.worker_id !== artifact.workerId
      || existing.mediobot_id !== artifact.mediobotId || existing.name !== artifact.name || existing.content_hash !== artifact.contentHash;
    if (changed) this.db.prepare(`UPDATE durable_task_artifacts SET mediobot_id = ?, worker_id = ?, name = ?, content_hash = ?, updated_at = ?
      WHERE id = ?`).run(artifact.mediobotId, artifact.workerId, artifact.name, artifact.contentHash, artifact.updatedAt, existing.id);
    const row = this.db.prepare(`SELECT * FROM durable_task_artifacts WHERE id = ?`).get(existing.id) as unknown as SqliteArtifactRow;
    return { artifact: this.mapArtifact(row), changed };
  }

  upsertArtifactAndAppendEvent(artifact: DurableTaskArtifactRecord, eventPayload: Record<string, unknown>): { artifact: DurableTaskArtifactRecord; changed: boolean } {
    return this.transaction(() => {
      const result = this.upsertArtifactRecord(artifact);
      const eventRows = this.db.prepare("SELECT payload_json FROM durable_task_events WHERE task_id = ? AND event_type = ?")
        .all(artifact.taskId, "task.artifact_recorded") as unknown as Array<{ payload_json: string }>;
      const eventExists = eventRows.some(row => {
        try { return JSON.parse(row.payload_json)?.artifactId === result.artifact.id; } catch { return false; }
      });
      if (result.changed || !eventExists) {
        this.appendEventRecord(artifact.taskId, "task.artifact_recorded", eventPayload);
      }
      return result;
    });
  }

  getArtifacts(taskId: string): DurableTaskArtifactRecord[] {
    const rows = this.db.prepare(`SELECT * FROM durable_task_artifacts WHERE task_id = ? ORDER BY updated_at DESC, reference ASC`)
      .all(taskId) as unknown as SqliteArtifactRow[];
    return rows.map(row => this.mapArtifact(row));
  }

  private mapArtifact(row: SqliteArtifactRow): DurableTaskArtifactRecord {
    return { id: row.id, taskId: row.task_id, mediobotId: row.mediobot_id, workspaceId: row.workspace_id, threadId: row.thread_id, workerId: row.worker_id,
      name: row.name, reference: row.reference, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  createCollaborationGroup(group: CollaborationGroupRecord, members: ReadonlyArray<CollaborationGroupMemberRecord>): CollaborationGroupRecord {
    if (members.length < 2 || members.length > COLLABORATION_GROUP_MAX_MEMBERS || new Set(members.map(member => member.specialistId)).size !== members.length
      || !members.some(member => member.specialistId === group.coordinatorSpecialistId && member.role === "coordinator")
      || members.some(member => member.groupId !== group.id)) throw new Error("Invalid collaboration group membership.");
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM collaboration_groups WHERE parent_task_id = ?").get(group.parentTaskId) as unknown as SqliteCollaborationGroupRow | undefined;
      if (existing) {
        const existingMembers = this.db.prepare("SELECT * FROM collaboration_group_members WHERE group_id = ? ORDER BY specialist_id").all(existing.id) as unknown as SqliteCollaborationMemberRow[];
        const expected = members.map(member => `${member.specialistId}:${member.role}`).sort();
        if (existing.id !== group.id || existing.workspace_id !== group.workspaceId || existing.thread_id !== group.threadId
          || existing.scope_id !== group.scopeId || existing.coordinator_specialist_id !== group.coordinatorSpecialistId
          || existingMembers.map(member => `${member.specialist_id}:${member.role}`).sort().join("\0") !== expected.join("\0")) {
          throw new Error("Parent task already has a different collaboration group.");
        }
        return this.mapCollaborationGroup(existing);
      }
      const parent = this.db.prepare("SELECT workspace_id, thread_id, status FROM durable_tasks WHERE id = ?").get(group.parentTaskId) as
        unknown as { workspace_id: string | null; thread_id: string | null; status: string } | undefined;
      if (!parent || parent.workspace_id !== group.workspaceId || parent.thread_id !== group.threadId
        || !["queued", "running", "waiting_approval", "waiting_input"].includes(parent.status)) throw new Error("Parent task is outside the active collaboration scope.");
      this.db.prepare(`INSERT INTO collaboration_groups (id, parent_task_id, workspace_id, workspace_key, thread_id, scope_id,
        coordinator_specialist_id, status, next_sequence_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`)
        .run(group.id, group.parentTaskId, group.workspaceId, group.workspaceId ?? "", group.threadId, group.scopeId,
          group.coordinatorSpecialistId, group.createdAt, group.updatedAt);
      for (const member of members) this.db.prepare(`INSERT INTO collaboration_group_members (group_id, specialist_id, role, read_sequence_number, joined_at)
        VALUES (?, ?, ?, 0, ?)`).run(group.id, member.specialistId, member.role, member.joinedAt);
      this.appendTaskEvent(group.parentTaskId, "collaboration.group.created", { groupId: group.id,
        coordinatorSpecialistId: group.coordinatorSpecialistId, memberSpecialistIds: members.map(member => member.specialistId).sort() }, group.createdAt);
      return this.mapCollaborationGroup(this.db.prepare("SELECT * FROM collaboration_groups WHERE id = ?").get(group.id) as unknown as SqliteCollaborationGroupRow);
    });
  }

  getCollaborationGroup(groupId: string): CollaborationGroupRecord | null {
    const row = this.db.prepare("SELECT * FROM collaboration_groups WHERE id = ?").get(groupId) as unknown as SqliteCollaborationGroupRow | undefined;
    return row ? this.mapCollaborationGroup(row) : null;
  }

  getCollaborationGroupForTask(parentTaskId: string): CollaborationGroupRecord | null {
    const row = this.db.prepare("SELECT * FROM collaboration_groups WHERE parent_task_id = ?").get(parentTaskId) as unknown as SqliteCollaborationGroupRow | undefined;
    return row ? this.mapCollaborationGroup(row) : null;
  }

  getCollaborationGroupMembers(groupId: string): CollaborationGroupMemberRecord[] {
    return (this.db.prepare("SELECT * FROM collaboration_group_members WHERE group_id = ? ORDER BY joined_at, specialist_id").all(groupId) as unknown as SqliteCollaborationMemberRow[])
      .map(row => this.mapCollaborationMember(row));
  }

  getCollaborationGroupMember(groupId: string, specialistId: string): CollaborationGroupMemberRecord | null {
    const row = this.db.prepare("SELECT * FROM collaboration_group_members WHERE group_id = ? AND specialist_id = ?").get(groupId, specialistId) as unknown as SqliteCollaborationMemberRow | undefined;
    return row ? this.mapCollaborationMember(row) : null;
  }

  addCollaborationGroupMember(groupId: string, identity: SpecialistSessionIdentity,
    specialistId: string): CollaborationGroupMemberRecord {
    const [workspaceKey, threadId, coordinatorId, scopeId] = this.identityValues(identity);
    return this.transaction(() => {
      const group = this.db.prepare("SELECT * FROM collaboration_groups WHERE id = ?").get(groupId) as unknown as SqliteCollaborationGroupRow | undefined;
      if (!group || group.workspace_key !== workspaceKey || group.thread_id !== threadId || group.scope_id !== scopeId
        || group.coordinator_specialist_id !== coordinatorId || group.status !== "active") {
        throw new Error("Only the authorized coordinator may add a member to an active collaboration group.");
      }
      const parent = this.db.prepare("SELECT workspace_id, thread_id, status FROM durable_tasks WHERE id = ?").get(group.parent_task_id) as
        unknown as { workspace_id: string | null; thread_id: string | null; status: string } | undefined;
      if (!parent || parent.workspace_id !== group.workspace_id || parent.thread_id !== threadId
        || !["queued", "running", "waiting_approval", "waiting_input"].includes(parent.status)) {
        throw new Error("Collaboration parent task is outside the active group scope.");
      }
      const delegation = this.db.prepare(`SELECT 1 AS allowed FROM durable_task_delegations
        WHERE parent_task_id = ? AND assigned_mediobot_id = ? AND status = 'active' AND child_task_id IS NOT NULL LIMIT 1`)
        .get(group.parent_task_id, specialistId);
      if (!delegation) throw new Error("Group member must have an active durable parent-task delegation.");
      const previous = this.getCollaborationGroupMember(groupId, specialistId);
      if (previous) return previous;
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM collaboration_group_members WHERE group_id = ?")
        .get(groupId) as unknown as { count: number };
      if (count.count >= COLLABORATION_GROUP_MAX_MEMBERS) throw new Error("Collaboration group member limit reached.");
      const readSequenceNumber = Math.max(0, group.next_sequence_number - 1);
      const joinedAt = Date.now();
      this.db.prepare(`INSERT INTO collaboration_group_members
        (group_id, specialist_id, role, read_sequence_number, joined_at) VALUES (?, ?, 'specialist', ?, ?)`)
        .run(groupId, specialistId, readSequenceNumber, joinedAt);
      this.appendTaskEvent(group.parent_task_id, "collaboration.group.member_added", {
        groupId, specialistId, joinedAt, readSequenceNumber,
      }, joinedAt);
      return { groupId, specialistId: specialistId as CollaborationGroupMemberRecord["specialistId"],
        role: "specialist", readSequenceNumber, joinedAt };
    });
  }

  appendCollaborationGroupMessage(groupId: string, identity: SpecialistSessionIdentity, input: AppendCollaborationGroupMessageInput): { message: CollaborationGroupMessageRecord; isDuplicate: boolean } {
    const [workspaceKey, threadId, specialistId, scopeId] = this.identityValues(identity);
    const group = this.db.prepare("SELECT * FROM collaboration_groups WHERE id = ?").get(groupId) as unknown as SqliteCollaborationGroupRow | undefined;
    if (!group || group.workspace_key !== workspaceKey || group.thread_id !== threadId || group.scope_id !== scopeId
      || !this.getCollaborationGroupMember(groupId, specialistId)) throw new Error("Group is outside the authorized collaboration scope.");
    const payloadHash = crypto.createHash("sha256").update(JSON.stringify([input.kind, input.content, input.evidenceRefs])).digest("hex");
    return this.transaction(() => {
      const previous = this.db.prepare(`SELECT * FROM collaboration_group_messages WHERE group_id = ? AND sender_specialist_id = ? AND idempotency_key = ?`)
        .get(groupId, specialistId, input.idempotencyKey) as unknown as SqliteCollaborationMessageRow | undefined;
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new Error("Group message idempotency key was reused with different content.");
        return { message: this.mapCollaborationMessage(previous), isDuplicate: true };
      }
      const current = this.db.prepare("SELECT * FROM collaboration_groups WHERE id = ?").get(groupId) as unknown as SqliteCollaborationGroupRow | undefined;
      const parent = current && this.db.prepare("SELECT workspace_id, thread_id, status FROM durable_tasks WHERE id = ?").get(current.parent_task_id) as
        unknown as { workspace_id: string | null; thread_id: string | null; status: string } | undefined;
      if (!current || current.status !== "active" || !parent || parent.workspace_id !== current.workspace_id || parent.thread_id !== threadId
        || !["queued", "running", "waiting_approval", "waiting_input"].includes(parent.status)) throw new Error("Collaboration group is closed or its parent task is inactive.");
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM collaboration_group_messages WHERE group_id = ?").get(groupId) as unknown as { count: number };
      const senderCount = this.db.prepare("SELECT COUNT(*) AS count FROM collaboration_group_messages WHERE group_id = ? AND sender_specialist_id = ?").get(groupId, specialistId) as unknown as { count: number };
      const requestCount = this.db.prepare("SELECT COUNT(*) AS count FROM collaboration_group_messages WHERE group_id = ? AND kind = 'request'").get(groupId) as unknown as { count: number };
      const senderRequestCount = this.db.prepare("SELECT COUNT(*) AS count FROM collaboration_group_messages WHERE group_id = ? AND sender_specialist_id = ? AND kind = 'request'")
        .get(groupId, specialistId) as unknown as { count: number };
      const repeatedRequest = input.kind === "request" && this.db.prepare(`SELECT 1 AS found FROM collaboration_group_messages
        WHERE group_id = ? AND sender_specialist_id = ? AND kind = 'request' AND lower(trim(content)) = lower(trim(?)) LIMIT 1`)
        .get(groupId, specialistId, input.content);
      if (count.count >= COLLABORATION_GROUP_MAX_MESSAGES || senderCount.count >= 12
        || input.kind === "request" && (requestCount.count >= 8 || senderRequestCount.count >= COLLABORATION_GROUP_MAX_REQUESTS_PER_SENDER || repeatedRequest)) {
        throw new Error("Collaboration group message budget exhausted.");
      }
      const seq = current.next_sequence_number;
      const now = Date.now();
      const id = `gmsg-${crypto.randomUUID()}`;
      this.db.prepare("UPDATE collaboration_groups SET next_sequence_number = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(seq + 1, now, groupId);
      this.db.prepare(`INSERT INTO collaboration_group_messages (id, group_id, parent_task_id, sequence_number, sender_specialist_id, kind,
        idempotency_key, payload_hash, content, evidence_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, groupId, current.parent_task_id, seq, specialistId, input.kind, input.idempotencyKey, payloadHash, input.content, JSON.stringify(input.evidenceRefs), now);
      this.appendTaskEvent(current.parent_task_id, "collaboration.group.message.appended", { groupId, messageId: id,
        senderSpecialistId: specialistId, kind: input.kind, sequenceNumber: seq }, now);
      return { message: { id, groupId, parentTaskId: current.parent_task_id as CollaborationGroupMessageRecord["parentTaskId"],
        sequenceNumber: seq, senderSpecialistId: specialistId as CollaborationGroupMessageRecord["senderSpecialistId"], kind: input.kind,
        idempotencyKey: input.idempotencyKey, content: input.content, evidenceRefs: [...input.evidenceRefs], createdAt: now }, isDuplicate: false };
    });
  }

  readCollaborationGroupMessages(groupId: string, identity: SpecialistSessionIdentity, limit = 8, maxChars = 4_000): CollaborationGroupReadResult {
    const [workspaceKey, threadId, specialistId, scopeId] = this.identityValues(identity);
    return this.transaction(() => {
      const group = this.db.prepare("SELECT * FROM collaboration_groups WHERE id = ?").get(groupId) as unknown as SqliteCollaborationGroupRow | undefined;
      const member = this.getCollaborationGroupMember(groupId, specialistId);
      const parent = group && this.db.prepare("SELECT workspace_id, thread_id, status FROM durable_tasks WHERE id = ?").get(group.parent_task_id) as
        unknown as { workspace_id: string | null; thread_id: string | null; status: string } | undefined;
      if (!group || group.workspace_key !== workspaceKey || group.thread_id !== threadId || group.scope_id !== scopeId || !member
        || group.status !== "active" || !parent || parent.thread_id !== threadId
        || parent.workspace_id !== group.workspace_id || !["queued", "running", "waiting_approval", "waiting_input"].includes(parent.status)) throw new Error("Group is outside the active authorized collaboration scope.");
      const candidates = this.db.prepare("SELECT * FROM collaboration_group_messages WHERE group_id = ? AND sequence_number > ? ORDER BY sequence_number LIMIT ?")
        .all(groupId, member.readSequenceNumber, Math.max(1, Math.min(12, Math.trunc(limit)))) as unknown as SqliteCollaborationMessageRow[];
      const rows: SqliteCollaborationMessageRow[] = [];
      let chars = 0;
      for (const candidate of candidates) {
        if (candidate.sender_specialist_id !== specialistId && chars + candidate.content.length > Math.min(4_000, Math.max(1, maxChars))) break;
        if (candidate.sender_specialist_id !== specialistId) chars += candidate.content.length;
        rows.push(candidate);
      }
      const lastSequence = rows.at(-1)?.sequence_number ?? member.readSequenceNumber;
      if (lastSequence > member.readSequenceNumber) {
        const now = Date.now();
        this.db.prepare("UPDATE collaboration_group_members SET read_sequence_number = ? WHERE group_id = ? AND specialist_id = ? AND read_sequence_number = ?")
          .run(lastSequence, groupId, specialistId, member.readSequenceNumber);
        this.appendTaskEvent(group.parent_task_id, "collaboration.group.member.read", { groupId, specialistId, readSequenceNumber: lastSequence }, now);
      }
      return { messages: rows.filter(row => row.sender_specialist_id !== specialistId).map(row => this.mapCollaborationMessage(row)), readSequenceNumber: lastSequence };
    });
  }

  listCollaborationGroupMessages(groupId: string, identity: SpecialistSessionIdentity, limit = 8, maxChars = 4_000): CollaborationGroupReadResult {
    const [workspaceKey, threadId, specialistId, scopeId] = this.identityValues(identity);
    const group = this.db.prepare("SELECT * FROM collaboration_groups WHERE id = ?").get(groupId) as unknown as SqliteCollaborationGroupRow | undefined;
    const member = this.getCollaborationGroupMember(groupId, specialistId);
    const parent = group && this.db.prepare("SELECT workspace_id, thread_id FROM durable_tasks WHERE id = ?").get(group.parent_task_id) as
      unknown as { workspace_id: string | null; thread_id: string | null } | undefined;
    if (!group || group.workspace_key !== workspaceKey || group.thread_id !== threadId || group.scope_id !== scopeId || !member
      || !parent || parent.thread_id !== threadId || parent.workspace_id !== group.workspace_id) {
      throw new Error("Group is outside the authorized collaboration history scope.");
    }
    const candidates = this.db.prepare("SELECT * FROM collaboration_group_messages WHERE group_id = ? ORDER BY sequence_number DESC LIMIT ?")
      .all(groupId, Math.max(1, Math.min(12, Math.trunc(limit)))) as unknown as SqliteCollaborationMessageRow[];
    const maxContentChars = Math.min(4_000, Math.max(1, Math.trunc(maxChars)));
    const selected: SqliteCollaborationMessageRow[] = [];
    let chars = 0;
    for (const candidate of candidates) {
      if (chars + candidate.content.length > maxContentChars) break;
      selected.push(candidate);
      chars += candidate.content.length;
    }
    return { messages: selected.reverse().map(row => this.mapCollaborationMessage(row)), readSequenceNumber: member.readSequenceNumber };
  }

  closeCollaborationGroup(parentTaskId: string, status: CollaborationGroupStatus): void {
    this.transaction(() => {
      const group = this.db.prepare("SELECT id, status FROM collaboration_groups WHERE parent_task_id = ?").get(parentTaskId) as unknown as { id: string; status: string } | undefined;
      if (!group || group.status !== "active") return;
      const now = Date.now();
      this.db.prepare("UPDATE collaboration_groups SET status = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(status, now, group.id);
      this.appendTaskEvent(parentTaskId, "collaboration.group.closed", { groupId: group.id, status }, now);
    });
  }

  getOrCreateSpecialistSession(identity: SpecialistSessionIdentity): SpecialistSessionRecord {
    const [workspaceKey, threadId, specialistId, scopeId] = this.identityValues(identity);
    const now = Date.now();
    this.db.prepare(`INSERT OR IGNORE INTO specialist_sessions (id, workspace_id, workspace_key, thread_id, specialist_id, scope_id,
      context_summary, context_version, provenance_json, lifecycle, expires_at, next_message_sequence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '', 1, '[]', 'active', NULL, 1, ?, ?)`)
      .run(`sp-${crypto.randomUUID()}`, identity.workspaceId, workspaceKey, threadId, specialistId, scopeId, now, now);
    const row = this.sessionRow(identity);
    if (!row) throw new Error("Unable to create specialist session.");
    return this.mapSpecialistSession(this.expireSession(row, now));
  }

  getSpecialistSession(identity: SpecialistSessionIdentity): SpecialistSessionRecord | null {
    const row = this.sessionRow(identity);
    return row ? this.mapSpecialistSession(this.expireSession(row, Date.now())) : null;
  }

  updateSpecialistSessionContext(identity: SpecialistSessionIdentity, update: SpecialistSessionContextUpdate): SpecialistSessionRecord {
    if (update.contextSummary.length > SPECIALIST_CONTEXT_SUMMARY_MAX_CHARS) throw new Error("Specialist context summary exceeds the size bound.");
    if (update.provenance.length > SPECIALIST_CONTEXT_PROVENANCE_MAX_ITEMS) throw new Error("Specialist context provenance exceeds the item bound.");
    const row = this.sessionRow(identity);
    if (!row) throw new Error("Specialist session not found.");
    const current = this.expireSession(row, Date.now());
    if (current.lifecycle !== "active") throw new Error(`Cannot update ${current.lifecycle} specialist session.`);
    if (current.context_version !== update.expectedVersion) throw new Error("Specialist session context version conflict.");
    const now = Date.now();
    const nextExpiry = update.expiresAt !== undefined ? update.expiresAt : current.expires_at;
    if (nextExpiry !== null && (!Number.isFinite(nextExpiry) || nextExpiry <= now)) throw new Error("Specialist session expiry must be in the future.");
    const result = this.db.prepare(`UPDATE specialist_sessions SET context_summary = ?, context_version = context_version + 1,
      provenance_json = ?, expires_at = ?, updated_at = ? WHERE id = ? AND lifecycle = 'active' AND context_version = ?`)
      .run(update.contextSummary, JSON.stringify(update.provenance), nextExpiry, now, current.id, update.expectedVersion);
    if (result.changes !== 1) throw new Error("Specialist session context version conflict.");
    return this.mapSpecialistSession(this.db.prepare("SELECT * FROM specialist_sessions WHERE id = ?").get(current.id) as unknown as SqliteSpecialistSessionRow);
  }

  deleteSpecialistSession(identity: SpecialistSessionIdentity): SpecialistSessionRecord | null {
    const row = this.sessionRow(identity);
    if (!row) return null;
    const now = Date.now();
    this.transaction(() => {
      this.db.prepare("DELETE FROM specialist_messages WHERE session_id = ?").run(row.id);
      this.db.prepare(`UPDATE specialist_sessions SET lifecycle = 'deleted', context_summary = '', provenance_json = '[]', expires_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, row.id);
    });
    return this.mapSpecialistSession(this.db.prepare("SELECT * FROM specialist_sessions WHERE id = ?").get(row.id) as unknown as SqliteSpecialistSessionRow);
  }

  appendSpecialistMessage(input: Omit<SpecialistMessageRecord, "id" | "sequenceNumber" | "deliveryStatus" | "createdAt" | "updatedAt">): { message: SpecialistMessageRecord; isDuplicate: boolean } {
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || !input.content.trim() || input.content.length > SPECIALIST_MESSAGE_MAX_CHARS
      || input.evidenceRefs.length > SPECIALIST_MESSAGE_EVIDENCE_MAX_ITEMS
      || input.evidenceRefs.some(ref => !ref.trim() || ref.length > SPECIALIST_MESSAGE_EVIDENCE_MAX_CHARS)) throw new Error("Specialist message exceeds its bounds.");
    const identity: SpecialistSessionIdentity = { workspaceId: input.workspaceId, threadId: input.threadId,
      specialistId: input.recipientSpecialistId, scopeId: input.scopeId };
    const [workspaceKey, threadId, recipientId, scopeId] = this.identityValues(identity);
    const canonical = JSON.stringify([input.senderSpecialistId, input.parentTaskId, input.content, input.evidenceRefs]);
    const payloadHash = crypto.createHash("sha256").update(canonical).digest("hex");
    const before = this.sessionRow(identity);
    if (before?.expires_at !== null && before?.expires_at !== undefined && before.expires_at <= Date.now()) this.expireSession(before, Date.now());
    return this.transaction(() => {
      let target = this.sessionRow(identity);
      if (!target) {
        const now = Date.now();
        this.db.prepare(`INSERT INTO specialist_sessions (id, workspace_id, workspace_key, thread_id, specialist_id, scope_id,
          context_summary, context_version, provenance_json, lifecycle, expires_at, next_message_sequence, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, '', 1, '[]', 'active', NULL, 1, ?, ?)`)
          .run(`sp-${crypto.randomUUID()}`, input.workspaceId, workspaceKey, threadId, recipientId, scopeId, now, now);
        target = this.sessionRow(identity);
      }
      if (!target) throw new Error("Recipient specialist session is unavailable.");
      if (target.lifecycle !== "active" || (target.expires_at !== null && target.expires_at <= Date.now())) throw new Error(`Cannot send a message to ${target.lifecycle} specialist session.`);
      const previous = this.db.prepare("SELECT * FROM specialist_messages WHERE session_id = ? AND idempotency_key = ?")
        .get(target.id, input.idempotencyKey) as unknown as SqliteSpecialistMessageRow | undefined;
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new Error("Specialist message idempotency key was reused with different content.");
        return { message: this.mapSpecialistMessage({ ...previous, workspace_id: target.workspace_id, thread_id: target.thread_id, scope_id: target.scope_id }), isDuplicate: true };
      }
      const task = this.db.prepare("SELECT workspace_id, thread_id, status FROM durable_tasks WHERE id = ?").get(input.parentTaskId) as
        unknown as { workspace_id: string | null; thread_id: string | null; status: string } | undefined;
      if (!task || task.workspace_id !== target.workspace_id || task.thread_id !== target.thread_id
        || !["queued", "running", "waiting_approval", "waiting_input"].includes(task.status)) {
        throw new Error("Parent task is outside the message scope or is cancelled.");
      }
      const sender = this.db.prepare(`SELECT id, lifecycle, expires_at FROM specialist_sessions WHERE workspace_key = ? AND thread_id = ? AND specialist_id = ? AND scope_id = ?`)
        .get(workspaceKey, threadId, input.senderSpecialistId, scopeId) as unknown as { id: string; lifecycle: string; expires_at: number | null } | undefined;
      if (!sender || sender.lifecycle !== "active" || (sender.expires_at !== null && sender.expires_at <= Date.now())) throw new Error("Sender specialist session is unavailable in this scope.");
      const sequence = target.next_message_sequence;
      const now = Date.now();
      const id = `spm-${crypto.randomUUID()}`;
      this.db.prepare("UPDATE specialist_sessions SET next_message_sequence = ?, updated_at = ? WHERE id = ? AND lifecycle = 'active'")
        .run(sequence + 1, now, target.id);
      this.db.prepare(`INSERT INTO specialist_messages (id, session_id, sender_specialist_id, recipient_specialist_id, parent_task_id,
        sequence_number, idempotency_key, payload_hash, delivery_status, content, evidence_refs_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
        .run(id, target.id, input.senderSpecialistId, recipientId, input.parentTaskId, sequence, input.idempotencyKey, payloadHash,
          input.content, JSON.stringify(input.evidenceRefs), now, now);
      this.appendTaskEvent(input.parentTaskId, "specialist.message.appended", { messageId: id, senderSpecialistId: input.senderSpecialistId,
        recipientSpecialistId: recipientId, sequenceNumber: sequence, deliveryStatus: "pending" }, now);
      return { message: { id, workspaceId: target.workspace_id, threadId: target.thread_id, scopeId: target.scope_id,
        senderSpecialistId: input.senderSpecialistId, recipientSpecialistId: recipientId as SpecialistMessageRecord["recipientSpecialistId"],
        parentTaskId: input.parentTaskId as SpecialistMessageRecord["parentTaskId"], sequenceNumber: sequence, idempotencyKey: input.idempotencyKey,
        deliveryStatus: "pending", content: input.content, evidenceRefs: [...input.evidenceRefs], createdAt: now, updatedAt: now }, isDuplicate: false };
    });
  }

  getSpecialistMessages(identity: SpecialistSessionIdentity, options: { readonly afterSequence?: number; readonly limit?: number } = {}): SpecialistMessageRecord[] {
    const row = this.sessionRow(identity);
    if (!row) return [];
    const session = this.expireSession(row, Date.now());
    if (session.lifecycle !== "active") return [];
    const after = Math.max(0, Math.floor(options.afterSequence ?? 0));
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
    const results = this.db.prepare(`SELECT m.*, s.workspace_id, s.thread_id, s.scope_id FROM specialist_messages m
      JOIN specialist_sessions s ON s.id = m.session_id JOIN durable_tasks t ON t.id = m.parent_task_id
      WHERE m.session_id = ? AND m.sequence_number > ?
        AND (m.delivery_status <> 'pending' OR t.status IN ('queued', 'running', 'waiting_approval', 'waiting_input'))
      ORDER BY m.sequence_number ASC LIMIT ?`)
      .all(session.id, after, limit) as unknown as SqliteSpecialistMessageRow[];
    return results.map(message => this.mapSpecialistMessage(message));
  }

  updateSpecialistMessageStatus(identity: SpecialistSessionIdentity, messageId: string, status: SpecialistMessageDeliveryStatus): SpecialistMessageRecord {
    if (!["pending", "delivered", "failed", "cancelled", "expired"].includes(status)) throw new Error("Invalid specialist message delivery status.");
    const session = this.sessionRow(identity);
    if (!session) throw new Error("Specialist message scope not found.");
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT m.*, s.workspace_id, s.thread_id, s.scope_id FROM specialist_messages m JOIN specialist_sessions s ON s.id = m.session_id
        WHERE m.id = ? AND m.session_id = ?`).get(messageId, session.id) as unknown as SqliteSpecialistMessageRow | undefined;
      if (!row) throw new Error("Specialist message not found in this scope.");
      if (row.delivery_status === status) return this.mapSpecialistMessage(row);
      if (row.delivery_status !== "pending") throw new Error(`Cannot transition specialist message from ${row.delivery_status} to ${status}.`);
      const parent = this.db.prepare("SELECT status FROM durable_tasks WHERE id = ?").get(row.parent_task_id) as unknown as { status: string } | undefined;
      if (!parent || !["queued", "running", "waiting_approval", "waiting_input"].includes(parent.status)) {
        throw new Error("Cannot update delivery status after the parent task has stopped.");
      }
      const now = Date.now();
      this.db.prepare("UPDATE specialist_messages SET delivery_status = ?, updated_at = ? WHERE id = ? AND delivery_status = 'pending'").run(status, now, messageId);
      this.appendTaskEvent(row.parent_task_id, `specialist.message.${status}`, { messageId, sequenceNumber: row.sequence_number }, now);
      return this.mapSpecialistMessage({ ...row, delivery_status: status, updated_at: now });
    });
  }

  cancelPendingSpecialistMessages(parentTaskId: string): SpecialistMessageRecord[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT m.*, s.workspace_id, s.thread_id, s.scope_id FROM specialist_messages m JOIN specialist_sessions s ON s.id = m.session_id
        WHERE m.parent_task_id = ? AND m.delivery_status = 'pending' ORDER BY m.created_at, m.sequence_number, m.id`).all(parentTaskId) as unknown as SqliteSpecialistMessageRow[];
      const now = Date.now();
      for (const row of rows) {
        this.db.prepare("UPDATE specialist_messages SET delivery_status = 'cancelled', updated_at = ? WHERE id = ? AND delivery_status = 'pending'").run(now, row.id);
        this.appendTaskEvent(parentTaskId, "specialist.message.cancelled", { messageId: row.id, sequenceNumber: row.sequence_number }, now);
      }
      return rows.map(row => this.mapSpecialistMessage({ ...row, delivery_status: "cancelled", updated_at: now }));
    });
  }

  reconcileCancelledSpecialistMessages(): SpecialistMessageRecord[] {
    const tasks = this.db.prepare("SELECT DISTINCT parent_task_id FROM specialist_messages m JOIN durable_tasks t ON t.id = m.parent_task_id WHERE m.delivery_status = 'pending' AND t.status = 'cancelled' ORDER BY parent_task_id")
      .all() as unknown as Array<{ parent_task_id: string }>;
    return tasks.flatMap(task => this.cancelPendingSpecialistMessages(task.parent_task_id));
  }

  reconcileInterruptedTasks(workspaceId?: string | null): SqliteDurableTaskRecord[] {
    const now = Date.now();
    let rows: SqliteTaskRow[];
    if (workspaceId !== undefined) {
      if (workspaceId === null) {
        const stmt = this.db.prepare("SELECT * FROM durable_tasks WHERE status IN ('running', 'queued') AND workspace_id IS NULL");
        rows = stmt.all() as unknown as SqliteTaskRow[];
      } else {
        const stmt = this.db.prepare("SELECT * FROM durable_tasks WHERE status IN ('running', 'queued') AND workspace_id = ?");
        rows = stmt.all(workspaceId) as unknown as SqliteTaskRow[];
      }
    } else {
      const stmt = this.db.prepare("SELECT * FROM durable_tasks WHERE status IN ('running', 'queued')");
      rows = stmt.all() as unknown as SqliteTaskRow[];
    }

    if (rows.length === 0) return [];

    const updateStmt = this.db.prepare(`
      UPDATE durable_tasks
      SET status = 'interrupted', updated_at = ?
      WHERE id = ?
    `);

    for (const r of rows) {
      updateStmt.run(now, r.id);
    }

    return rows.map((r) => ({
      ...this.mapTask(r),
      status: "interrupted",
      updatedAt: now,
    }));
  }
}

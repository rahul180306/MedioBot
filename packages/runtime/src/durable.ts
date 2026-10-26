import crypto from "node:crypto";
import type { MediobotDefinitionId, TaskId } from "@mediobot-v2/domain";
import type { AppendCollaborationGroupMessageInput, AppendSpecialistMessageInput, CollaborationGroupMemberRecord,
  CollaborationGroupMessageRecord, CollaborationGroupReadResult, CollaborationGroupRecord, CollaborationGroupStatus,
  InferenceSnapshot,
  SpecialistMessageDeliveryStatus, SpecialistMessagePayload, SpecialistMessageRecord, SpecialistSessionContextUpdate,
  SpecialistSessionIdentity, SpecialistSessionRecord } from "@mediobot-v2/contracts";
import { SPECIALIST_CONTEXT_PROVENANCE_MAX_ITEMS, SPECIALIST_CONTEXT_SUMMARY_MAX_CHARS, SPECIALIST_MESSAGE_EVIDENCE_MAX_CHARS,
  SPECIALIST_MESSAGE_EVIDENCE_MAX_ITEMS, SPECIALIST_MESSAGE_MAX_CHARS, COLLABORATION_GROUP_MAX_MEMBERS,
  COLLABORATION_GROUP_MAX_MESSAGES, COLLABORATION_GROUP_MESSAGE_MAX_CHARS } from "@mediobot-v2/contracts";

export type DurableTaskStatus =
  | "created"
  | "queued"
  | "running"
  | "paused"
  | "waiting_approval"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const VALID_DURABLE_TRANSITIONS: Readonly<Record<DurableTaskStatus, ReadonlySet<DurableTaskStatus>>> = {
  created: new Set(["queued", "cancelled", "failed"]),
  queued: new Set(["running", "cancelled", "failed", "interrupted"]),
  running: new Set(["paused", "waiting_approval", "waiting_input", "completed", "failed", "cancelled", "interrupted"]),
  paused: new Set(["running", "cancelled", "failed", "interrupted"]),
  waiting_approval: new Set(["running", "cancelled", "failed", "interrupted"]),
  waiting_input: new Set(["running", "cancelled", "failed", "interrupted"]),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
  interrupted: new Set(["queued", "running", "cancelled", "failed"]),
};

export class InvalidStateTransitionError extends Error {
  readonly taskId: string;
  readonly fromState: DurableTaskStatus;
  readonly toState: DurableTaskStatus;

  constructor(taskId: string, fromState: DurableTaskStatus, toState: DurableTaskStatus) {
    super(`Cannot transition durable task "${taskId}" from "${fromState}" to "${toState}"`);
    this.name = "InvalidStateTransitionError";
    this.taskId = taskId;
    this.fromState = fromState;
    this.toState = toState;
  }
}

export class TaskEvidenceRequiredError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Task "${taskId}" cannot be completed without verified project evidence`);
    this.name = "TaskEvidenceRequiredError";
    this.taskId = taskId;
  }
}

export interface DurableTaskRecord {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly threadId?: string | null;
  readonly turnId?: string | null;
  readonly goal: string;
  readonly definitionId: string;
  readonly status: DurableTaskStatus;
  readonly idempotencyKey?: string | null;
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | null;
  readonly inferenceSnapshot?: InferenceSnapshot | null;
}

export interface DurableTaskEventRecord {
  readonly id: string;
  readonly taskId: string;
  readonly sequenceNumber: number;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: number;
}

export interface DurableTaskCheckpointRecord {
  readonly id: string;
  readonly taskId: string;
  readonly stepIndex: number;
  readonly snapshot: Record<string, unknown>;
  readonly createdAt: number;
}

export interface DurableTaskDelegationRecord {
  readonly id: string;
  readonly parentTaskId: string;
  readonly childTaskId?: string | null;
  readonly assignedMediobotId: string;
  readonly assignedMediobotName: string;
  readonly objective: string;
  readonly status: "pending" | "active" | "completed" | "failed" | "cancelled";
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DurableTaskEvidenceRecord {
  readonly id: string;
  readonly taskId: string;
  readonly kind: string;
  readonly source: Record<string, unknown>;
  readonly claim?: string | null;
  readonly content: string;
  readonly validity: "observed" | "verified" | "invalidated";
  readonly createdAt: number;
}

export interface DurableTaskArtifactRecord {
  readonly id: string;
  readonly taskId: string;
  readonly mediobotId: string;
  readonly workspaceId: string | null;
  readonly threadId: string | null;
  readonly workerId: string;
  readonly name: string;
  readonly reference: string;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const specialistAccessBrand: unique symbol = Symbol("SpecialistSessionAccess");
export interface SpecialistSessionAccess {
  readonly parentTaskId: string;
  readonly workspaceId: string | null;
  readonly threadId: string;
  readonly scopeId: string;
  readonly actorSpecialistId: string;
  readonly [specialistAccessBrand]: true;
}

export class SpecialistCollaborationError extends Error {
  constructor(message: string) { super(message); this.name = "SpecialistCollaborationError"; }
}

export interface SpecialistCommunicationPort {
  readonly authorizedRecipients: ReadonlyArray<{ readonly id: MediobotDefinitionId; readonly name: string }>;
  readonly groupId?: string;
  sendRequest(recipient: MediobotDefinitionId, text: string, signal: AbortSignal, evidenceRefs?: ReadonlyArray<string>): Promise<string | undefined>;
  sendFinding(recipient: MediobotDefinitionId, text: string, evidenceRefs?: ReadonlyArray<string>, signal?: AbortSignal): Promise<void>;
  receive(signal: AbortSignal): Promise<ReadonlyArray<{ readonly record: SpecialistMessageRecord; readonly payload: SpecialistMessagePayload }>>;
  publishGroupMessage?(input: AppendCollaborationGroupMessageInput, signal?: AbortSignal): Promise<CollaborationGroupMessageRecord>;
  receiveGroup?(signal: AbortSignal): Promise<CollaborationGroupReadResult>;
  respond(message: SpecialistMessageRecord, text: string, evidenceRefs?: ReadonlyArray<string>, signal?: AbortSignal): Promise<void>;
}

export interface SubmitDurableTaskParams {
  readonly id?: string;
  readonly workspaceId: string | null;
  readonly threadId?: string | null;
  readonly turnId?: string | null;
  readonly goal: string;
  readonly definitionId: string;
  /** Non-secret provider/model identity used to preserve exact routing across restart. */
  readonly modelSelection?: { readonly providerConnectionId: string; readonly modelId: string; readonly reasoningEffort?: string };
  readonly assignmentModelSelections?: Record<string, unknown>;
  readonly inferenceSnapshot?: InferenceSnapshot | null;
  readonly idempotencyKey?: string | null;
  readonly maxRetries?: number;
}

export interface DurableTaskStore {
  createTask(task: Omit<DurableTaskRecord, "status" | "retryCount" | "createdAt" | "updatedAt">): Promise<DurableTaskRecord> | DurableTaskRecord;
  getTask(id: string): Promise<DurableTaskRecord | null> | (DurableTaskRecord | null);
  getByIdempotencyKey(key: string, workspaceId?: string | null): Promise<DurableTaskRecord | null> | (DurableTaskRecord | null);
  updateTask(id: string, updates: Partial<Pick<DurableTaskRecord, "status" | "error" | "retryCount" | "completedAt">>): Promise<DurableTaskRecord> | DurableTaskRecord;
  listTasks(workspaceId?: string | null): Promise<DurableTaskRecord[]> | DurableTaskRecord[];

  appendEvent(taskId: string, eventType: string, payload: Record<string, unknown>): Promise<DurableTaskEventRecord> | DurableTaskEventRecord;
  getEvents(taskId: string): Promise<DurableTaskEventRecord[]> | DurableTaskEventRecord[];
  trimEvents?(taskId: string, eventType: string, retainCount: number): Promise<void> | void;

  createCheckpoint(taskId: string, stepIndex: number, snapshot: Record<string, unknown>): Promise<DurableTaskCheckpointRecord> | DurableTaskCheckpointRecord;
  getCheckpoints(taskId: string): Promise<DurableTaskCheckpointRecord[]> | DurableTaskCheckpointRecord[];

  createDelegation(delegation: Omit<DurableTaskDelegationRecord, "id" | "createdAt" | "updatedAt">): Promise<DurableTaskDelegationRecord> | DurableTaskDelegationRecord;
  updateDelegation(id: string, updates: Partial<Pick<DurableTaskDelegationRecord, "childTaskId" | "status">>): Promise<DurableTaskDelegationRecord> | DurableTaskDelegationRecord;
  getDelegations(parentTaskId: string): Promise<DurableTaskDelegationRecord[]> | DurableTaskDelegationRecord[];
  findParentTaskForChild?(childTaskId: string, workspaceId?: string | null): Promise<string | null> | string | null;

  addEvidence(evidence: Omit<DurableTaskEvidenceRecord, "id" | "createdAt">): Promise<DurableTaskEvidenceRecord> | DurableTaskEvidenceRecord;
  getEvidence(taskId: string): Promise<DurableTaskEvidenceRecord[]> | DurableTaskEvidenceRecord[];
  searchVerifiedEvidence(workspaceId: string | null, threadId: string | null, currentTaskId: string, query: string, limit: number): Promise<DurableTaskEvidenceRecord[]> | DurableTaskEvidenceRecord[];

  upsertArtifact(artifact: DurableTaskArtifactRecord): Promise<{ readonly artifact: DurableTaskArtifactRecord; readonly changed: boolean }> | { readonly artifact: DurableTaskArtifactRecord; readonly changed: boolean };
  upsertArtifactAndAppendEvent(artifact: DurableTaskArtifactRecord, eventPayload: Record<string, unknown>): Promise<{ readonly artifact: DurableTaskArtifactRecord; readonly changed: boolean }> | { readonly artifact: DurableTaskArtifactRecord; readonly changed: boolean };
  getArtifacts(taskId: string): Promise<DurableTaskArtifactRecord[]> | DurableTaskArtifactRecord[];

  reconcileInterruptedTasks(workspaceId?: string | null): Promise<DurableTaskRecord[]> | DurableTaskRecord[];

  getOrCreateSpecialistSession?(identity: SpecialistSessionIdentity): Promise<SpecialistSessionRecord> | SpecialistSessionRecord;
  getSpecialistSession?(identity: SpecialistSessionIdentity): Promise<SpecialistSessionRecord | null> | SpecialistSessionRecord | null;
  updateSpecialistSessionContext?(identity: SpecialistSessionIdentity, update: SpecialistSessionContextUpdate): Promise<SpecialistSessionRecord> | SpecialistSessionRecord;
  deleteSpecialistSession?(identity: SpecialistSessionIdentity): Promise<SpecialistSessionRecord | null> | SpecialistSessionRecord | null;
  appendSpecialistMessage?(input: Omit<SpecialistMessageRecord, "id" | "sequenceNumber" | "deliveryStatus" | "createdAt" | "updatedAt">): Promise<{ message: SpecialistMessageRecord; isDuplicate: boolean }> | { message: SpecialistMessageRecord; isDuplicate: boolean };
  getSpecialistMessages?(identity: SpecialistSessionIdentity, options?: { readonly afterSequence?: number; readonly limit?: number }): Promise<SpecialistMessageRecord[]> | SpecialistMessageRecord[];
  updateSpecialistMessageStatus?(identity: SpecialistSessionIdentity, messageId: string, status: SpecialistMessageDeliveryStatus): Promise<SpecialistMessageRecord> | SpecialistMessageRecord;
  cancelPendingSpecialistMessages?(parentTaskId: string): Promise<SpecialistMessageRecord[]> | SpecialistMessageRecord[];
  reconcileCancelledSpecialistMessages?(): Promise<SpecialistMessageRecord[]> | SpecialistMessageRecord[];
  createCollaborationGroup?(group: CollaborationGroupRecord, members: ReadonlyArray<CollaborationGroupMemberRecord>): Promise<CollaborationGroupRecord> | CollaborationGroupRecord;
  getCollaborationGroup?(groupId: string): Promise<CollaborationGroupRecord | null> | CollaborationGroupRecord | null;
  getCollaborationGroupForTask?(parentTaskId: string): Promise<CollaborationGroupRecord | null> | CollaborationGroupRecord | null;
  getCollaborationGroupMembers?(groupId: string): Promise<CollaborationGroupMemberRecord[]> | CollaborationGroupMemberRecord[];
  getCollaborationGroupMember?(groupId: string, specialistId: string): Promise<CollaborationGroupMemberRecord | null> | CollaborationGroupMemberRecord | null;
  addCollaborationGroupMember?(groupId: string, identity: SpecialistSessionIdentity, specialistId: string): Promise<CollaborationGroupMemberRecord> | CollaborationGroupMemberRecord;
  appendCollaborationGroupMessage?(groupId: string, identity: SpecialistSessionIdentity, input: AppendCollaborationGroupMessageInput): Promise<{ message: CollaborationGroupMessageRecord; isDuplicate: boolean }> | { message: CollaborationGroupMessageRecord; isDuplicate: boolean };
  readCollaborationGroupMessages?(groupId: string, identity: SpecialistSessionIdentity, limit?: number, maxChars?: number): Promise<CollaborationGroupReadResult> | CollaborationGroupReadResult;
  listCollaborationGroupMessages?(groupId: string, identity: SpecialistSessionIdentity, limit?: number, maxChars?: number): Promise<CollaborationGroupReadResult> | CollaborationGroupReadResult;
  closeCollaborationGroup?(parentTaskId: string, status: CollaborationGroupStatus): Promise<void> | void;
}

export class DurableTaskEngine {
  private readonly store: DurableTaskStore;
  private readonly onDiagnostic?: (diagnostic: Record<string, unknown>) => void;

  constructor(store: DurableTaskStore, onDiagnostic?: (diagnostic: Record<string, unknown>) => void) {
    this.store = store;
    this.onDiagnostic = onDiagnostic;
  }

  private diagnostic(data: Record<string, unknown>): void {
    try {
      this.onDiagnostic?.({ system: "durable-task-engine", timestamp: Date.now(), ...data });
    } catch {
      // Diagnostic observers must never disrupt task execution
    }
  }

  private collaborationStore(): Required<Pick<DurableTaskStore, "getOrCreateSpecialistSession" | "getSpecialistSession"
    | "updateSpecialistSessionContext" | "deleteSpecialistSession" | "appendSpecialistMessage" | "getSpecialistMessages"
    | "updateSpecialistMessageStatus" | "cancelPendingSpecialistMessages" | "reconcileCancelledSpecialistMessages">> {
    const store = this.store;
    if (!store.getOrCreateSpecialistSession || !store.getSpecialistSession || !store.updateSpecialistSessionContext
      || !store.deleteSpecialistSession || !store.appendSpecialistMessage || !store.getSpecialistMessages
      || !store.updateSpecialistMessageStatus || !store.cancelPendingSpecialistMessages || !store.reconcileCancelledSpecialistMessages) {
      throw new SpecialistCollaborationError("Specialist session persistence is not configured.");
    }
    return store as Required<typeof store>;
  }

  async submitTask(params: SubmitDurableTaskParams): Promise<{ task: DurableTaskRecord; isDuplicate: boolean }> {
    const modelSelection = params.modelSelection;
    if (modelSelection && (!modelSelection.providerConnectionId.trim() || modelSelection.providerConnectionId.length > 200
      || !modelSelection.modelId.trim() || modelSelection.modelId.length > 200)) {
      throw new Error("Invalid durable task model selection.");
    }
    if (params.idempotencyKey) {
      const existing = await this.store.getByIdempotencyKey(params.idempotencyKey, params.workspaceId);
      if (existing) {
        this.diagnostic({ event: "task.idempotent_deduplicated", taskId: existing.id, idempotencyKey: params.idempotencyKey });
        return { task: existing, isDuplicate: true };
      }
    }

    const taskId = params.id ?? `task-${crypto.randomUUID()}`;
    const existingTask = await this.store.getTask(taskId);
    if (existingTask) {
      this.diagnostic({ event: "task.already_exists", taskId });
      return { task: existingTask, isDuplicate: false };
    }

    const initial = await this.store.createTask({
      id: taskId,
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      turnId: params.turnId,
      goal: params.goal,
      definitionId: params.definitionId,
      idempotencyKey: params.idempotencyKey,
      maxRetries: params.maxRetries ?? 3,
      ...(params.inferenceSnapshot ? { inferenceSnapshot: params.inferenceSnapshot } : {}),
    });

    await this.store.appendEvent(taskId, "task.created", {
      goal: params.goal,
      definitionId: params.definitionId,
      workspaceId: params.workspaceId,
      ...(modelSelection ? { modelSelection } : {}),
      ...(params.inferenceSnapshot ? { inferenceSnapshot: params.inferenceSnapshot } : {}),
    });

    // Automatically transition to queued
    const queued = await this.transitionState(taskId, "queued", { reason: "initial_enqueue" });
    this.diagnostic({ event: "task.submitted", taskId, status: queued.status });
    return { task: queued, isDuplicate: false };
  }

  /** Returns only a validated, non-secret provider/model pair persisted at task submission. */
  async getTaskModelSelection(taskId: string): Promise<{ readonly providerConnectionId: string; readonly modelId: string; readonly reasoningEffort?: "low" | "medium" | "high" | "extra" | "max" } | undefined> {
    const task = await this.store.getTask(taskId);
    if (!task) return undefined;
    if (task.inferenceSnapshot && typeof task.inferenceSnapshot === "object") {
      const snap = task.inferenceSnapshot as unknown as Record<string, unknown>;
      if (typeof snap.connectionId === "string" && snap.connectionId.trim()
        && snap.connectionId.length <= 200 && typeof snap.modelId === "string"
        && snap.modelId.trim() && snap.modelId.length <= 200) {
        const rawEffort = typeof snap.effectiveEffort === "string"
          ? snap.effectiveEffort
          : typeof snap.requestedEffort === "string"
            ? snap.requestedEffort
            : undefined;
        const validEfforts = ["low", "medium", "high", "extra", "max"] as const;
        const reasoningEffort = rawEffort && validEfforts.includes(rawEffort.toLowerCase() as any)
          ? (rawEffort.toLowerCase() as "low" | "medium" | "high" | "extra" | "max")
          : undefined;
        return {
          providerConnectionId: snap.connectionId,
          modelId: snap.modelId,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        };
      }
    }
    const events = await this.store.getEvents(taskId);
    for (const event of events) {
      if (event.eventType !== "task.created") continue;
      if (event.payload.inferenceSnapshot && typeof event.payload.inferenceSnapshot === "object") {
        const snap = event.payload.inferenceSnapshot as Record<string, unknown>;
        if (typeof snap.connectionId === "string" && snap.connectionId.trim()
          && snap.connectionId.length <= 200 && typeof snap.modelId === "string"
          && snap.modelId.trim() && snap.modelId.length <= 200) {
          const rawEffort = typeof snap.effectiveEffort === "string"
            ? snap.effectiveEffort
            : typeof snap.requestedEffort === "string"
              ? snap.requestedEffort
              : undefined;
          const validEfforts = ["low", "medium", "high", "extra", "max"] as const;
          const reasoningEffort = rawEffort && validEfforts.includes(rawEffort.toLowerCase() as any)
            ? (rawEffort.toLowerCase() as "low" | "medium" | "high" | "extra" | "max")
            : undefined;
          return {
            providerConnectionId: snap.connectionId,
            modelId: snap.modelId,
            ...(reasoningEffort ? { reasoningEffort } : {}),
          };
        }
      }
      const selection = event.payload.modelSelection;
      if (!selection || typeof selection !== "object" || Array.isArray(selection)) continue;
      const value = selection as Record<string, unknown>;
      if (typeof value.providerConnectionId === "string" && value.providerConnectionId.trim()
        && value.providerConnectionId.length <= 200 && typeof value.modelId === "string"
        && value.modelId.trim() && value.modelId.length <= 200) {
        const validEfforts = ["low", "medium", "high", "extra", "max"] as const;
        const reasoningEffort = typeof value.reasoningEffort === "string" && validEfforts.includes(value.reasoningEffort.toLowerCase() as any)
          ? (value.reasoningEffort.toLowerCase() as "low" | "medium" | "high" | "extra" | "max")
          : undefined;
        return { providerConnectionId: value.providerConnectionId, modelId: value.modelId, ...(reasoningEffort ? { reasoningEffort } : {}) };
      }
    }
    return undefined;
  }

  async transitionState(taskId: string, targetState: DurableTaskStatus, details?: Record<string, unknown>): Promise<DurableTaskRecord> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Durable task "${taskId}" does not exist`);
    }

    if (task.status === targetState) {
      return task;
    }

    const allowed = VALID_DURABLE_TRANSITIONS[task.status];
    if (!allowed || !allowed.has(targetState)) {
      throw new InvalidStateTransitionError(taskId, task.status, targetState);
    }

    const updates: {
      status?: DurableTaskStatus;
      error?: { readonly code: string; readonly message: string } | null;
      completedAt?: number | null;
    } = {
      status: targetState,
    };

    if (targetState === "completed" || targetState === "failed" || targetState === "cancelled") {
      updates.completedAt = Date.now();
    }
    if (details?.error && typeof details.error === "object") {
      updates.error = details.error as { code: string; message: string };
    }

    const updated = await this.store.updateTask(taskId, updates);
    await this.store.appendEvent(taskId, `task.state_changed`, {
      fromState: task.status,
      toState: targetState,
      details: details ?? {},
    });

    this.diagnostic({
      event: "task.state_transition",
      taskId,
      fromState: task.status,
      toState: targetState,
    });

    return updated;
  }

  async startTask(taskId: string): Promise<DurableTaskRecord> {
    return this.transitionState(taskId, "running");
  }

  async pauseForApproval(taskId: string, approvalDetails?: Record<string, unknown>): Promise<DurableTaskRecord> {
    return this.transitionState(taskId, "waiting_approval", approvalDetails);
  }

  async resumeFromApproval(taskId: string): Promise<DurableTaskRecord> {
    return this.transitionState(taskId, "running", { reason: "approval_resolved" });
  }

  async pauseForInput(taskId: string, inputDetails?: Record<string, unknown>): Promise<DurableTaskRecord> {
    return this.transitionState(taskId, "waiting_input", inputDetails);
  }

  async resumeFromInput(taskId: string): Promise<DurableTaskRecord> {
    return this.transitionState(taskId, "running", { reason: "input_received" });
  }

  async pauseForUser(taskId: string, pauseDetails?: Record<string, unknown>): Promise<DurableTaskRecord> {
    return this.transitionState(taskId, "paused", { reason: "user_pause", ...pauseDetails });
  }

  async resumeFromUserPause(taskId: string): Promise<DurableTaskRecord> {
    return this.transitionState(taskId, "running", { reason: "user_resumed" });
  }

  async resumeTask(taskId: string): Promise<DurableTaskRecord> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Durable task "${taskId}" does not exist`);
    }
    if (task.status !== "interrupted" && task.status !== "queued") {
      throw new Error(`Cannot resume task "${taskId}" from status "${task.status}"`);
    }
    return this.transitionState(taskId, "running", { reason: "resumed_from_interruption" });
  }

  async recordCheckpoint(taskId: string, stepIndex: number, snapshot: Record<string, unknown>): Promise<DurableTaskCheckpointRecord> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Durable task "${taskId}" not found`);
    const checkpoint = await this.store.createCheckpoint(taskId, stepIndex, snapshot);
    await this.store.appendEvent(taskId, "task.checkpoint_saved", { stepIndex });
    this.diagnostic({ event: "task.checkpoint_saved", taskId, stepIndex });
    return checkpoint;
  }

  async recordDelegation(parentTaskId: string, delegation: Omit<DurableTaskDelegationRecord, "id" | "createdAt" | "updatedAt">): Promise<DurableTaskDelegationRecord> {
    const parent = await this.store.getTask(parentTaskId);
    if (!parent) throw new Error(`Parent task "${parentTaskId}" not found`);
    const record = await this.store.createDelegation(delegation);
    await this.store.appendEvent(parentTaskId, "task.delegated", {
      delegationId: record.id,
      assignedMediobotId: record.assignedMediobotId,
      assignedMediobotName: record.assignedMediobotName,
      objective: record.objective,
    });
    this.diagnostic({ event: "task.delegation_recorded", parentTaskId, delegationId: record.id });
    return record;
  }

  async updateDelegation(id: string, updates: Partial<Pick<DurableTaskDelegationRecord, "childTaskId" | "status">>): Promise<DurableTaskDelegationRecord> {
    const record = await this.store.updateDelegation(id, updates);
    this.diagnostic({ event: "task.delegation_updated", delegationId: id, updates });
    return record;
  }

  async recordEvidence(taskId: string, evidence: Omit<DurableTaskEvidenceRecord, "id" | "createdAt"> | Omit<DurableTaskEvidenceRecord, "id" | "createdAt" | "taskId">): Promise<DurableTaskEvidenceRecord> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);
    const fullEvidence = "taskId" in evidence ? evidence : { taskId, ...evidence };
    const record = await this.store.addEvidence(fullEvidence);
    await this.store.appendEvent(taskId, "task.evidence_linked", {
      evidenceId: record.id,
      kind: record.kind,
      validity: record.validity,
    });
    this.diagnostic({ event: "task.evidence_recorded", taskId, evidenceId: record.id, validity: record.validity });
    return record;
  }

  async recordArtifact(taskId: string, input: { readonly workerId: string; readonly mediobotId: string; readonly name: string; readonly reference: string; readonly contentHash: string }): Promise<DurableTaskArtifactRecord> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);
    if (!input.workerId.trim() || !input.mediobotId.trim() || input.mediobotId.length > 200 || !input.name.trim() || input.name.length > 300
      || !/^[a-f0-9]{64}$/i.test(input.contentHash)) throw new Error("Invalid durable artifact metadata");
    const reference = input.reference.replace(/\\/g, "/").split("/").filter(segment => segment && segment !== ".").join("/");
    if (!reference || reference.length > 1_000 || /^[\\/]/.test(input.reference) || /^[a-z]:/i.test(input.reference)
      || input.reference.split(/[\\/]/).some(segment => segment === "..")) throw new Error("Artifact reference must be a safe workspace-relative path");
    const workspaceKey = task.workspaceId ? `workspace:${task.workspaceId}`
      : task.threadId ? `thread:${task.threadId}` : `task:${task.id}`;
    const id = `artifact-${crypto.createHash("sha256").update(`${workspaceKey}\0${task.id}\0${reference}`).digest("hex").slice(0, 32)}`;
    const now = Date.now();
    const artifact: DurableTaskArtifactRecord = { id, taskId, workspaceId: task.workspaceId, threadId: task.threadId ?? null,
      workerId: input.workerId, mediobotId: input.mediobotId, name: input.name.trim(), reference, contentHash: input.contentHash.toLowerCase(), createdAt: now, updatedAt: now };
    const result = await this.store.upsertArtifactAndAppendEvent(artifact, { artifactId: artifact.id,
      workerId: artifact.workerId, name: artifact.name, reference: artifact.reference, contentHash: artifact.contentHash });
    return result.artifact;
  }

  async completeTask(taskId: string, options?: { readonly requireEvidence?: boolean }): Promise<DurableTaskRecord> {
    if (options?.requireEvidence) {
      const evidence = await this.store.getEvidence(taskId);
      const hasVerified = evidence.some((e) => e.validity === "verified");
      if (!hasVerified) {
        throw new TaskEvidenceRequiredError(taskId);
      }
    }
    const completed = await this.transitionState(taskId, "completed");
    await this.store.closeCollaborationGroup?.(taskId, "completed");
    return completed;
  }

  async failTask(taskId: string, error: { code: string; message: string }): Promise<DurableTaskRecord> {
    const failed = await this.transitionState(taskId, "failed", { error });
    await this.store.closeCollaborationGroup?.(taskId, "failed");
    return failed;
  }

  async cancelTask(taskId: string, reason?: string): Promise<DurableTaskRecord> {
    const cancelled = await this.transitionState(taskId, "cancelled", { reason: reason ?? "user_cancelled" });
    await this.store.cancelPendingSpecialistMessages?.(taskId);
    await this.store.closeCollaborationGroup?.(taskId, "cancelled");
    return cancelled;
  }

  async reconcileOnStartup(workspaceId?: string | null): Promise<DurableTaskRecord[]> {
    const reconciled = await this.store.reconcileInterruptedTasks(workspaceId);
    for (const task of reconciled) {
      await this.store.appendEvent(task.id, "task.interrupted", {
        reason: "system_restart_reconciliation",
        reconciledAt: Date.now(),
      });
      this.diagnostic({
        event: "task.reconciled_interrupted",
        taskId: task.id,
        workspaceId: task.workspaceId,
      });
    }
    await this.store.reconcileCancelledSpecialistMessages?.();
    return reconciled;
  }

  async authorizeSpecialistSessionScope(parentTaskId: string, actorSpecialistId: string,
    options: { readonly persistentForThread?: boolean } = {}): Promise<SpecialistSessionAccess> {
    const task = await this.store.getTask(parentTaskId);
    if (!task || !task.threadId) throw new SpecialistCollaborationError("A specialist scope requires an existing parent task with a thread.");
    const delegations = await this.store.getDelegations(parentTaskId);
    const participant = task.definitionId === actorSpecialistId || delegations.some(d => d.assignedMediobotId === actorSpecialistId
      && d.status !== "cancelled" && d.status !== "failed");
    if (!participant) throw new SpecialistCollaborationError("Specialist is not assigned to this collaboration scope.");
    // The scope is derived from the trusted parent task, never supplied by a caller.
    const scopeId = options.persistentForThread ? `conversation:${task.threadId}` : `task:${parentTaskId}`;
    const access = { parentTaskId, workspaceId: task.workspaceId, threadId: task.threadId, scopeId, actorSpecialistId } as SpecialistSessionAccess;
    Object.defineProperty(access, specialistAccessBrand, { value: true, enumerable: false });
    return Object.freeze(access);
  }

  async createCollaborationGroup(parentTaskId: string, specialistIds: ReadonlyArray<string>): Promise<CollaborationGroupRecord> {
    const store = this.groupStore();
    const parent = await this.store.getTask(parentTaskId);
    if (!parent?.threadId || !["queued", "running", "waiting_approval", "waiting_input"].includes(parent.status)) {
      throw new SpecialistCollaborationError("A collaboration group requires an active parent task with a thread.");
    }
    const memberIds = [...new Set([parent.definitionId, ...specialistIds])];
    if (memberIds.length < 2 || memberIds.length > COLLABORATION_GROUP_MAX_MEMBERS) {
      throw new SpecialistCollaborationError("Collaboration group member count is outside the allowed bounds.");
    }
    const delegations = await this.store.getDelegations(parentTaskId);
    const unauthorized = specialistIds.filter(id => id !== parent.definitionId
      && !delegations.some(delegation => delegation.assignedMediobotId === id && delegation.status === "active"));
    if (unauthorized.length) throw new SpecialistCollaborationError("Group membership must match active parent-task delegations.");
    const now = Date.now();
    const group = { id: `group-${parentTaskId}`, parentTaskId: parentTaskId as TaskId,
      workspaceId: parent.workspaceId, threadId: parent.threadId, scopeId: `task:${parentTaskId}`,
      coordinatorSpecialistId: parent.definitionId as MediobotDefinitionId, status: "active", nextSequenceNumber: 1,
      createdAt: now, updatedAt: now } as const;
    const existing = await store.getCollaborationGroup(group.id);
    let members: CollaborationGroupMemberRecord[] = memberIds.map(id => ({ groupId: group.id, specialistId: id as MediobotDefinitionId,
      role: id === parent.definitionId ? "coordinator" as const : "specialist" as const, readSequenceNumber: 0, joinedAt: now }));
    if (existing) {
      if (existing.parentTaskId !== group.parentTaskId || existing.workspaceId !== group.workspaceId
        || existing.threadId !== group.threadId || existing.scopeId !== group.scopeId
        || existing.coordinatorSpecialistId !== group.coordinatorSpecialistId || existing.status !== "active") {
        throw new SpecialistCollaborationError("Existing collaboration group does not match the active task scope.");
      }
      const currentMembers = await store.getCollaborationGroupMembers(group.id);
      const currentIds = new Set(currentMembers.map(member => member.specialistId));
      if (memberIds.some(id => !currentIds.has(id as MediobotDefinitionId))
        || currentMembers.some(member => member.role === "specialist"
          && !delegations.some(delegation => delegation.assignedMediobotId === member.specialistId && delegation.status === "active"))) {
        throw new SpecialistCollaborationError("Existing collaboration membership is not authorized by active task delegations.");
      }
      members = currentMembers;
    }
    return store.createCollaborationGroup(group, members);
  }

  async addCollaborationGroupMember(access: SpecialistSessionAccess, groupId: string,
    specialistId: MediobotDefinitionId): Promise<CollaborationGroupMemberRecord> {
    this.assertSpecialistAccess(access);
    const group = await this.getCollaborationGroup(access, groupId);
    if (!group || group.coordinatorSpecialistId !== access.actorSpecialistId) {
      throw new SpecialistCollaborationError("Only the authorized group coordinator may add a member.");
    }
    const delegation = (await this.store.getDelegations(access.parentTaskId)).find(item =>
      item.assignedMediobotId === specialistId && item.status === "active" && Boolean(item.childTaskId));
    if (!delegation) throw new SpecialistCollaborationError("Group membership requires an active, durably assigned specialist.");
    const member = await this.groupStore().addCollaborationGroupMember!(groupId, this.identityFor(access), specialistId);
    const memberAccess = await this.authorizeSpecialistSessionScope(access.parentTaskId, specialistId);
    await this.getOrCreateSpecialistSession(memberAccess);
    return member;
  }

  async getCollaborationGroup(access: SpecialistSessionAccess, groupId: string): Promise<CollaborationGroupRecord | null> {
    const store = this.groupStore();
    this.assertSpecialistAccess(access);
    const group = await store.getCollaborationGroup(groupId);
    if (!group || group.parentTaskId !== access.parentTaskId || group.workspaceId !== access.workspaceId
      || group.threadId !== access.threadId || group.scopeId !== access.scopeId
      || !await store.getCollaborationGroupMember(groupId, access.actorSpecialistId)) return null;
    return group;
  }

  async getCollaborationGroupForTask(access: SpecialistSessionAccess): Promise<CollaborationGroupRecord | null> {
    this.assertSpecialistAccess(access);
    const group = await this.groupStore().getCollaborationGroupForTask!(access.parentTaskId);
    return group ? this.getCollaborationGroup(access, group.id) : null;
  }

  async getCollaborationGroupMembers(access: SpecialistSessionAccess, groupId: string): Promise<CollaborationGroupMemberRecord[]> {
    if (!await this.getCollaborationGroup(access, groupId)) throw new SpecialistCollaborationError("Group is outside the authorized collaboration scope.");
    return this.groupStore().getCollaborationGroupMembers!(groupId);
  }

  async publishCollaborationGroupMessage(access: SpecialistSessionAccess, groupId: string,
    input: AppendCollaborationGroupMessageInput): Promise<{ message: CollaborationGroupMessageRecord; isDuplicate: boolean }> {
    this.assertSpecialistAccess(access);
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || !input.content.trim()
      || input.content.length > COLLABORATION_GROUP_MESSAGE_MAX_CHARS || input.evidenceRefs.length > 8
      || input.evidenceRefs.some(ref => !ref.trim() || ref.length > SPECIALIST_MESSAGE_EVIDENCE_MAX_CHARS)) {
      throw new SpecialistCollaborationError("Group message exceeds its bounds.");
    }
    if (!await this.getCollaborationGroup(access, groupId)) throw new SpecialistCollaborationError("Group is outside the authorized collaboration scope.");
    const delegatedTasks = (await this.store.getDelegations(access.parentTaskId)).map(d => d.childTaskId).filter((id): id is string => Boolean(id));
    const scopedTaskIds = new Set([access.parentTaskId, ...delegatedTasks]);
    const evidenceIds = new Set<string>();
    for (const taskId of scopedTaskIds) for (const evidence of await this.store.getEvidence(taskId)) evidenceIds.add(evidence.id);
    if (input.evidenceRefs.some(reference => !evidenceIds.has(reference))) throw new SpecialistCollaborationError("Group evidence reference is outside the authorized task scope.");
    return this.groupStore().appendCollaborationGroupMessage!(groupId, this.identityFor(access), input);
  }

  async receiveCollaborationGroupMessages(access: SpecialistSessionAccess, groupId: string, limit = 8, maxChars = 4_000): Promise<CollaborationGroupReadResult> {
    this.assertSpecialistAccess(access);
    if (!await this.getCollaborationGroup(access, groupId)) throw new SpecialistCollaborationError("Group is outside the authorized collaboration scope.");
    return this.groupStore().readCollaborationGroupMessages!(groupId, this.identityFor(access), Math.min(12, Math.max(1, limit)), Math.min(4_000, Math.max(1, maxChars)));
  }

  async listCollaborationGroupMessages(access: SpecialistSessionAccess, groupId: string, limit = 8, maxChars = 4_000): Promise<CollaborationGroupReadResult> {
    this.assertSpecialistAccess(access);
    if (!await this.getCollaborationGroup(access, groupId)) throw new SpecialistCollaborationError("Group is outside the authorized collaboration scope.");
    return this.groupStore().listCollaborationGroupMessages!(groupId, this.identityFor(access), Math.min(12, Math.max(1, limit)), Math.min(4_000, Math.max(1, maxChars)));
  }

  async closeCollaborationGroup(parentTaskId: string, status: CollaborationGroupStatus): Promise<void> {
    await this.groupStore().closeCollaborationGroup!(parentTaskId, status);
  }

  private groupStore(): Required<Pick<DurableTaskStore, "createCollaborationGroup" | "getCollaborationGroup" | "getCollaborationGroupMembers"
    | "getCollaborationGroupForTask" | "getCollaborationGroupMember" | "addCollaborationGroupMember" | "appendCollaborationGroupMessage" | "readCollaborationGroupMessages"
    | "listCollaborationGroupMessages" | "closeCollaborationGroup">> {
    const store = this.store;
    if (!store.createCollaborationGroup || !store.getCollaborationGroup || !store.getCollaborationGroupForTask || !store.getCollaborationGroupMembers
      || !store.getCollaborationGroupMember || !store.addCollaborationGroupMember || !store.appendCollaborationGroupMessage || !store.readCollaborationGroupMessages
      || !store.listCollaborationGroupMessages
      || !store.closeCollaborationGroup) throw new SpecialistCollaborationError("Collaboration group persistence is not configured.");
    return store as Required<typeof store>;
  }

  private assertSpecialistAccess(access: SpecialistSessionAccess): void {
    if (!access || access[specialistAccessBrand] !== true) throw new SpecialistCollaborationError("Invalid specialist authorization scope.");
  }

  private identityFor(access: SpecialistSessionAccess, specialistId = access.actorSpecialistId): SpecialistSessionIdentity {
    this.assertSpecialistAccess(access);
    return { workspaceId: access.workspaceId, threadId: access.threadId, specialistId: specialistId as SpecialistSessionIdentity["specialistId"], scopeId: access.scopeId };
  }

  async getOrCreateSpecialistSession(access: SpecialistSessionAccess): Promise<SpecialistSessionRecord> {
    return this.collaborationStore().getOrCreateSpecialistSession(this.identityFor(access));
  }

  async getSpecialistSession(access: SpecialistSessionAccess): Promise<SpecialistSessionRecord | null> {
    return this.collaborationStore().getSpecialistSession(this.identityFor(access));
  }

  async updateSpecialistSessionContext(access: SpecialistSessionAccess, update: SpecialistSessionContextUpdate): Promise<SpecialistSessionRecord> {
    if (update.contextSummary.length > SPECIALIST_CONTEXT_SUMMARY_MAX_CHARS) throw new SpecialistCollaborationError("Specialist context summary exceeds the size bound.");
    if (update.provenance.length > SPECIALIST_CONTEXT_PROVENANCE_MAX_ITEMS) throw new SpecialistCollaborationError("Specialist context provenance exceeds the item bound.");
    const delegatedTasks = (await this.store.getDelegations(access.parentTaskId)).map(d => d.childTaskId).filter((id): id is string => Boolean(id));
    const allowedTaskIds = new Set([access.parentTaskId, ...delegatedTasks]);
    // Thread-scoped continuity carries provenance from completed earlier turns.
    // Retain those exact persisted entries, while requiring new task references
    // to belong to this active parent task tree.
    const priorSession = await this.collaborationStore().getSpecialistSession(this.identityFor(access));
    const persistedProvenance = new Set((priorSession?.provenance ?? []).map(item => JSON.stringify(item)));
    for (const item of update.provenance) {
      if (!item.kind.trim() || item.kind.length > 100 || !item.reference.trim() || item.reference.length > 500 || !Number.isFinite(item.capturedAt)) {
        throw new SpecialistCollaborationError("Invalid specialist context provenance.");
      }
      if (item.taskId && !allowedTaskIds.has(item.taskId) && !persistedProvenance.has(JSON.stringify(item))) {
        throw new SpecialistCollaborationError("Context provenance is outside the authorized specialist scope.");
      }
      if (item.taskId) {
        const sourceTask = await this.store.getTask(item.taskId);
        if (!sourceTask || sourceTask.workspaceId !== access.workspaceId || sourceTask.threadId !== access.threadId) {
          throw new SpecialistCollaborationError("Context provenance is outside the authorized workspace or thread.");
        }
      }
    }
    return this.collaborationStore().updateSpecialistSessionContext(this.identityFor(access), update);
  }

  async deleteSpecialistSession(access: SpecialistSessionAccess): Promise<SpecialistSessionRecord | null> {
    return this.collaborationStore().deleteSpecialistSession(this.identityFor(access));
  }

  async appendSpecialistMessage(access: SpecialistSessionAccess, input: AppendSpecialistMessageInput): Promise<{ message: SpecialistMessageRecord; isDuplicate: boolean }> {
    this.assertSpecialistAccess(access);
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new SpecialistCollaborationError("Invalid specialist message idempotency key.");
    if (!input.content.trim() || input.content.length > SPECIALIST_MESSAGE_MAX_CHARS) throw new SpecialistCollaborationError("Specialist message is empty or exceeds the size bound.");
    if (input.evidenceRefs.length > SPECIALIST_MESSAGE_EVIDENCE_MAX_ITEMS || input.evidenceRefs.some(ref => !ref.trim() || ref.length > SPECIALIST_MESSAGE_EVIDENCE_MAX_CHARS)) {
      throw new SpecialistCollaborationError("Specialist message evidence references exceed the bounds.");
    }
    const parent = await this.store.getTask(access.parentTaskId);
    if (!parent || parent.workspaceId !== access.workspaceId || parent.threadId !== access.threadId) throw new SpecialistCollaborationError("Parent task is outside the authorized specialist scope.");
    const scopedTaskIds = new Set([parent.id, ...(await this.store.getDelegations(parent.id)).map(d => d.childTaskId).filter((id): id is string => Boolean(id))]);
    const scopedEvidenceIds = new Set<string>();
    for (const taskId of scopedTaskIds) for (const evidence of await this.store.getEvidence(taskId)) scopedEvidenceIds.add(evidence.id);
    if (input.evidenceRefs.some(reference => !scopedEvidenceIds.has(reference))) throw new SpecialistCollaborationError("Message evidence reference is outside the authorized specialist scope.");
    const allowed = parent.definitionId === input.recipientSpecialistId || (await this.store.getDelegations(parent.id)).some(d => d.assignedMediobotId === input.recipientSpecialistId
      && d.status !== "cancelled" && d.status !== "failed");
    if (!allowed) throw new SpecialistCollaborationError("Recipient is not assigned to this collaboration scope.");
    const store = this.collaborationStore();
    await store.getOrCreateSpecialistSession(this.identityFor(access));
    const recipientIdentity = this.identityFor(access, input.recipientSpecialistId);
    return store.appendSpecialistMessage({ ...recipientIdentity,
      senderSpecialistId: access.actorSpecialistId as SpecialistMessageRecord["senderSpecialistId"],
      recipientSpecialistId: input.recipientSpecialistId, parentTaskId: access.parentTaskId as SpecialistMessageRecord["parentTaskId"],
      idempotencyKey: input.idempotencyKey, content: input.content, evidenceRefs: input.evidenceRefs });
  }

  async getSpecialistMessages(access: SpecialistSessionAccess, options?: { readonly afterSequence?: number; readonly limit?: number }): Promise<SpecialistMessageRecord[]> {
    return this.collaborationStore().getSpecialistMessages(this.identityFor(access), options);
  }

  async updateSpecialistMessageStatus(access: SpecialistSessionAccess, messageId: string, status: SpecialistMessageDeliveryStatus): Promise<SpecialistMessageRecord> {
    return this.collaborationStore().updateSpecialistMessageStatus(this.identityFor(access), messageId, status);
  }

  async getTask(taskId: string): Promise<DurableTaskRecord | null> {
    return this.store.getTask(taskId);
  }

  async findParentTaskForChild(childTaskId: string, workspaceId?: string | null): Promise<string | null> {
    if (this.store.findParentTaskForChild) return this.store.findParentTaskForChild(childTaskId, workspaceId);
    const tasks = await this.store.listTasks(workspaceId);
    for (const task of tasks) {
      if ((await this.store.getDelegations(task.id)).some(delegation => delegation.childTaskId === childTaskId)) return task.id;
    }
    return null;
  }

  async getTaskByIdempotencyKey(key: string, workspaceId?: string | null): Promise<DurableTaskRecord | null> {
    return this.store.getByIdempotencyKey(key, workspaceId);
  }

  async listTasks(workspaceId?: string | null): Promise<DurableTaskRecord[]> {
    return this.store.listTasks(workspaceId);
  }

  async getEvents(taskId: string): Promise<DurableTaskEventRecord[]> {
    return this.store.getEvents(taskId);
  }

  async appendEvent(taskId: string, eventType: string, payload: Record<string, unknown>): Promise<DurableTaskEventRecord> {
    return this.store.appendEvent(taskId, eventType, payload);
  }

  async trimEvents(taskId: string, eventType: string, retainCount: number): Promise<void> {
    if (this.store.trimEvents) await this.store.trimEvents(taskId, eventType, Math.max(1, Math.floor(retainCount)));
  }

  async getCheckpoints(taskId: string): Promise<DurableTaskCheckpointRecord[]> {
    return this.store.getCheckpoints(taskId);
  }

  async getDelegations(taskId: string): Promise<DurableTaskDelegationRecord[]> {
    return this.store.getDelegations(taskId);
  }

  async getEvidence(taskId: string): Promise<DurableTaskEvidenceRecord[]> {
    return this.store.getEvidence(taskId);
  }

  async searchVerifiedEvidence(workspaceId: string | null, threadId: string | null, currentTaskId: string, query: string,
    limit = 3): Promise<DurableTaskEvidenceRecord[]> {
    if (typeof query !== "string" || !query.trim() || query.length > 2_000) return [];
    if ((!workspaceId || !workspaceId.trim()) && (!threadId || !threadId.trim())) return [];
    return this.store.searchVerifiedEvidence(workspaceId?.trim() || null, threadId?.trim() || null, currentTaskId,
      query.trim(), Math.max(1, Math.min(5, Math.floor(limit))));
  }

  async getArtifacts(taskId: string): Promise<DurableTaskArtifactRecord[]> {
    return this.store.getArtifacts(taskId);
  }
}

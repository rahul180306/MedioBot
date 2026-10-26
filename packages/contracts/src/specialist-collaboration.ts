import type { MediobotDefinitionId, TaskId } from "@mediobot-v2/domain";

export const SPECIALIST_CONTEXT_SUMMARY_MAX_CHARS = 16_000;
export const SPECIALIST_MESSAGE_MAX_CHARS = 8_000;
export const SPECIALIST_MESSAGE_EVIDENCE_MAX_ITEMS = 32;
export const SPECIALIST_MESSAGE_EVIDENCE_MAX_CHARS = 500;
export const SPECIALIST_CONTEXT_PROVENANCE_MAX_ITEMS = 32;
export const COLLABORATION_GROUP_MAX_MEMBERS = 8;
export const COLLABORATION_GROUP_MAX_MESSAGES = 60;
export const COLLABORATION_GROUP_MESSAGE_MAX_CHARS = 2_000;
export const COLLABORATION_GROUP_CONTEXT_MAX_CHARS = 4_000;
export const COLLABORATION_GROUP_CONTEXT_MAX_MESSAGES = 6;
export const COLLABORATION_GROUP_MAX_REQUESTS_PER_SENDER = 2;

export type SpecialistSessionLifecycle = "active" | "expired" | "deleted";
export type SpecialistMessageDeliveryStatus = "pending" | "delivered" | "failed" | "cancelled" | "expired";

/** Full persistence key. Callers must provide every scope component; partial lookup is not supported. */
export interface SpecialistSessionIdentity {
  readonly workspaceId: string | null;
  readonly threadId: string;
  readonly specialistId: MediobotDefinitionId;
  readonly scopeId: string;
}

export interface SpecialistContextProvenance {
  readonly kind: string;
  readonly reference: string;
  readonly taskId?: TaskId;
  readonly capturedAt: number;
}

export interface SpecialistSessionRecord extends SpecialistSessionIdentity {
  readonly id: string;
  readonly contextSummary: string;
  readonly contextVersion: number;
  readonly provenance: ReadonlyArray<SpecialistContextProvenance>;
  readonly lifecycle: SpecialistSessionLifecycle;
  readonly expiresAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SpecialistMessageRecord {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly threadId: string;
  readonly scopeId: string;
  readonly senderSpecialistId: MediobotDefinitionId;
  readonly recipientSpecialistId: MediobotDefinitionId;
  readonly parentTaskId: TaskId;
  /** Monotonic within the recipient's specialist session. */
  readonly sequenceNumber: number;
  readonly idempotencyKey: string;
  readonly deliveryStatus: SpecialistMessageDeliveryStatus;
  readonly content: string;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SpecialistSessionContextUpdate {
  readonly contextSummary: string;
  readonly provenance: ReadonlyArray<SpecialistContextProvenance>;
  readonly expectedVersion: number;
  readonly expiresAt?: number | null;
}

export interface AppendSpecialistMessageInput {
  readonly recipientSpecialistId: MediobotDefinitionId;
  readonly idempotencyKey: string;
  readonly content: string;
  readonly evidenceRefs: ReadonlyArray<string>;
}

/** Versioned payload stored as bounded JSON in SpecialistMessageRecord.content. */
export type SpecialistMessagePayload =
  | { readonly version: 1; readonly kind: "request" | "finding"; readonly correlationId: string; readonly text: string }
  | { readonly version: 1; readonly kind: "response"; readonly correlationId: string; readonly inReplyTo: string; readonly text: string };

export type CollaborationGroupStatus = "active" | "completed" | "cancelled" | "failed";
export type CollaborationGroupMemberRole = "coordinator" | "specialist";
export type CollaborationGroupMessageKind = "finding" | "request";

export interface CollaborationGroupRecord {
  readonly id: string;
  readonly parentTaskId: TaskId;
  readonly workspaceId: string | null;
  readonly threadId: string;
  readonly scopeId: string;
  readonly coordinatorSpecialistId: MediobotDefinitionId;
  readonly status: CollaborationGroupStatus;
  readonly nextSequenceNumber: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CollaborationGroupMemberRecord {
  readonly groupId: string;
  readonly specialistId: MediobotDefinitionId;
  readonly role: CollaborationGroupMemberRole;
  readonly readSequenceNumber: number;
  readonly joinedAt: number;
}

export interface CollaborationGroupMessageRecord {
  readonly id: string;
  readonly groupId: string;
  readonly parentTaskId: TaskId;
  readonly sequenceNumber: number;
  readonly senderSpecialistId: MediobotDefinitionId;
  readonly kind: CollaborationGroupMessageKind;
  readonly idempotencyKey: string;
  readonly content: string;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly createdAt: number;
}

export interface CollaborationGroupReadResult {
  readonly messages: ReadonlyArray<CollaborationGroupMessageRecord>;
  readonly readSequenceNumber: number;
}

export interface AppendCollaborationGroupMessageInput {
  readonly kind: CollaborationGroupMessageKind;
  readonly idempotencyKey: string;
  readonly content: string;
  readonly evidenceRefs: ReadonlyArray<string>;
}

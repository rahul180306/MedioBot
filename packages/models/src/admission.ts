/**
 * @mediobot-v2/models
 *
 * ModelAdmissionPort interface for coordinating provider-aware scheduling
 * with global and per-provider capacity governance.
 */

export interface ModelAdmissionScope {
  readonly taskId: string;
  readonly workspaceId?: string | null;
  readonly connectionId: string;
  readonly modelId: string;
}

export type ModelAdmissionResult =
  | { readonly granted: true; readonly leaseId: string; readonly release: () => void }
  | { readonly granted: false; readonly retryAfterMs?: number };

export interface ModelAdmissionPort {
  tryAcquire(attempt: ModelAdmissionScope): ModelAdmissionResult;
  release(leaseId: string): void;
  subscribeCapacityChange(listener: () => void): () => void;
}

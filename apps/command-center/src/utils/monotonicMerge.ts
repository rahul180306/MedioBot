/**
 * Monotonic Tool Event Lifecycle & State Merger
 * Standalone implementation for MedioBot Frontend UI
 *
 * Ensures tool-execution lifecycle transitions monotonically:
 * Terminal states ('success' or 'failed') NEVER regress to 'running'
 * on out-of-order SSE arrival, replay, or remount.
 */

export interface MonotonicToolData {
  toolInvocationId?: string;
  toolName: string;
  command?: string;
  inputArgs?: Record<string, unknown> | string;
  outputLog?: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  startedAt?: number;
  durationMs?: number;
  error?: string;
  failureCategory?: string;
  recoveredFromExecution?: boolean;
  isVerification?: boolean;
  verificationStatus?: 'command-succeeded' | 'command-failed' | 'unverified' | 'verified' | 'failed';
  outcomeBadge?: string;
}

export function mergeMonotonicToolData<T extends MonotonicToolData>(
  existing?: T,
  incoming?: T
): T | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const STATUS_RANK: Record<string, number> = {
    running: 1,
    success: 2,
    failed: 2,
    cancelled: 2,
  };

  const existingRank = STATUS_RANK[existing.status] ?? 0;
  const incomingRank = STATUS_RANK[incoming.status] ?? 0;

  // Never regress from a higher rank (terminal) to a lower rank (running)
  if (existingRank > incomingRank) {
    const merged: T = { ...incoming, ...existing };
    merged.status = existing.status;
    if (existing.startedAt ?? incoming.startedAt) merged.startedAt = existing.startedAt ?? incoming.startedAt;
    if (existing.durationMs !== undefined) merged.durationMs = existing.durationMs;
    if (existing.outcomeBadge) merged.outcomeBadge = existing.outcomeBadge;
    if (existing.outputLog) merged.outputLog = existing.outputLog;
    if (existing.error) merged.error = existing.error;
    if (existing.failureCategory) merged.failureCategory = existing.failureCategory;
    if (existing.recoveredFromExecution !== undefined) merged.recoveredFromExecution = existing.recoveredFromExecution;
    if (existing.verificationStatus) merged.verificationStatus = existing.verificationStatus;
    return merged;
  }

  // Incoming is equal or higher rank (running -> running, running -> terminal, or terminal -> terminal)
  const merged: T = { ...existing, ...incoming };
  merged.status = incoming.status;
  if (existing.startedAt ?? incoming.startedAt) merged.startedAt = existing.startedAt ?? incoming.startedAt;
  if (incoming.durationMs !== undefined) merged.durationMs = incoming.durationMs;
  else if (existing.durationMs !== undefined) merged.durationMs = existing.durationMs;
  if (incoming.outcomeBadge) merged.outcomeBadge = incoming.outcomeBadge;
  else if (existing.outcomeBadge) merged.outcomeBadge = existing.outcomeBadge;
  if (incoming.outputLog) merged.outputLog = incoming.outputLog;
  else if (existing.outputLog) merged.outputLog = existing.outputLog;
  return merged;
}

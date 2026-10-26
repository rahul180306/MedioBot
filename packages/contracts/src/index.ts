/**
 * @mediobot-v2/contracts
 *
 * Shared architectural contracts and safety invariants for MedioBot V2.
 * Re-exports canonical domain identifiers and types from `@mediobot-v2/domain`
 * to avoid duplicate conflicting declarations, and introduces V2 orchestration
 * interfaces for the multi-agent execution pipeline.
 */

// 1. Re-export authoritative domain types and branded identifiers
export type {
  TaskId,
  EvidenceId,
  WorkerId,
  WorldId,
  GoalId,
  MediobotDefinitionId,
  ResourceId,
  AssignmentId,
  ArtifactId,
  EventId,
  Evidence,
  EvidenceSource,
  EvidenceRequirement,
  Task,
  Goal,
  Assignment,
  Artifact,
  WorldEvent,
  WorldSnapshot,
  GoalEvidenceInput,
  TaskEvidenceInput,
  EvidenceInput,
} from "@mediobot-v2/domain";

import type { TaskId, EvidenceId, MediobotDefinitionId, EvidenceSource, WorkerId, Goal, Assignment, GoalEvidenceInput } from "@mediobot-v2/domain";

// 2. V2 Orchestration Task Graph Contracts

export type TaskNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface FileOwnershipClaim {
  readonly path: string;
  readonly mode: "exclusive" | "shared-read";
  readonly taskId: TaskId;
  readonly claimedAt: number;
}

export interface TaskNode {
  readonly id: TaskId;
  readonly agentId: MediobotDefinitionId;
  readonly objective: string;
  readonly dependencies: ReadonlyArray<TaskId>;
  readonly fileOwnership: ReadonlyArray<string>;
  readonly status: TaskNodeStatus;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly errorMessage: string | null;
}

export interface TaskGraph {
  readonly nodes: ReadonlyMap<TaskId, TaskNode>;
  readonly isReady: (taskId: TaskId) => boolean;
  readonly markComplete: (taskId: TaskId) => ReadonlyArray<TaskId>;
  readonly markFailed: (taskId: TaskId) => ReadonlyArray<TaskId>;
}

// 3. Project Intelligence Contracts

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "constant"
  | "module";

export interface SymbolDefinition {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly filePath: string;
  readonly line: number;
  readonly character: number;
  readonly signature?: string;
  readonly documentation?: string;
}

export interface IndexReport {
  readonly filesIndexed: number;
  readonly filesSkipped: number;
  readonly symbolsExtracted: number;
  readonly dependenciesTracked: number;
  readonly durationMs: number;
  readonly errors: ReadonlyArray<{ readonly path: string; readonly error: string }>;
}

export interface ProjectFileContext {
  readonly path: string;
  readonly language?: string;
  readonly lineCount?: number;
  readonly contentHash?: string;
  readonly isTest?: boolean;
  readonly isConfig?: boolean;
}

export interface ProjectSymbolContext {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly character: number;
  readonly signature?: string;
  readonly isExported: boolean;
  readonly docComment?: string;
}

export interface ProjectDependencyContext {
  readonly sourcePath: string;
  readonly importPath: string;
  readonly importedNames: ReadonlyArray<string>;
  readonly isTypeOnly: boolean;
}

export interface ProjectContextBudget {
  readonly maxTokens: number;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
}

export interface ProjectContextFreshness {
  readonly isFresh: boolean;
  readonly lastIndexedAt: number;
  readonly checkedAt: number;
  readonly staleFiles: ReadonlyArray<string>;
}

export interface ProjectContextDiagnostics {
  readonly durationMs: number;
  readonly retrievalMethod: "exact" | "fts5" | "repomap" | "hybrid" | "legacy-fallback";
  readonly errors: ReadonlyArray<string>;
}

export interface SharedProjectContext {
  readonly workspaceId: string | null;
  readonly projectRoot: string;
  readonly query?: string;
  readonly metadata: {
    readonly languages: ReadonlyArray<string>;
    readonly frameworks: ReadonlyArray<string>;
    readonly packageManager: string | null;
    readonly testFramework?: string | null;
    readonly totalFiles: number;
    readonly totalSymbols: number;
  };
  readonly repoMap?: {
    readonly content: string;
    readonly estimatedTokens: number;
    readonly filesIncluded: number;
  };
  readonly files: ReadonlyArray<ProjectFileContext>;
  readonly symbols: ReadonlyArray<ProjectSymbolContext>;
  readonly dependencies: ReadonlyArray<ProjectDependencyContext>;
  readonly budget: ProjectContextBudget;
  readonly freshness: ProjectContextFreshness;
  readonly diagnostics: ProjectContextDiagnostics;
}

// 4. Verification and Dual Validation Gate Contracts

export interface VerificationCheck {
  readonly name: string;
  readonly type: "static-syntax" | "import-integrity" | "typecheck" | "test-suite";
  readonly passed: boolean;
  readonly durationMs: number;
  readonly outputSnippet?: string;
}

export interface DualValidationGateResult {
  readonly gate: "gate1-static" | "gate2-execution";
  readonly passed: boolean;
  readonly checks: ReadonlyArray<VerificationCheck>;
  readonly failureCategory?: string;
  readonly timestamp: number;
}

// 5. Non-Negotiable Architectural Safety Contracts (Phase 0 Foundation)

export const ARCHITECTURAL_SAFETY_RULES = [
  "RULE_1_NEVER_DELETE_USER_DATABASES",
  "RULE_2_NEVER_AUTO_STASH_OR_RESET_USER_CHANGES",
  "RULE_3_NEVER_OVERWRITE_USER_FILES_DURING_ISOLATION_SETUP",
  "RULE_4_NEVER_BYPASS_WORKSPACE_AUTHORIZATION",
  "RULE_5_NEVER_FABRICATE_TOOL_EVIDENCE",
  "RULE_6_NEVER_MARK_UNSUPPORTED_MODEL_CLAIMS_AS_VERIFIED",
  "RULE_7_NEVER_AUTO_MERGE_UNVERIFIED_AGENT_CHANGES",
  "RULE_8_NEVER_ENABLE_UNTESTED_SUBSYSTEMS_BY_DEFAULT",
  "RULE_9_NEVER_EXECUTE_UNBOUNDED_PARALLEL_TASKS",
  "RULE_10_PRESERVE_CANCELLATION_AND_FAILURE_PROPAGATION",
] as const;

export type ArchitecturalSafetyRule = (typeof ARCHITECTURAL_SAFETY_RULES)[number];

export const SAFETY_RULE_DEFINITIONS: Record<ArchitecturalSafetyRule, string> = {
  RULE_1_NEVER_DELETE_USER_DATABASES:
    "Never automatically delete user databases. SQLite corruption or migration failure must quarantine corrupt files, never drop or erase them.",
  RULE_2_NEVER_AUTO_STASH_OR_RESET_USER_CHANGES:
    "Never automatically stash or reset user changes. Working tree dirty state belongs to the user and must remain untouched.",
  RULE_3_NEVER_OVERWRITE_USER_FILES_DURING_ISOLATION_SETUP:
    "Never overwrite user files during isolation setup. Worktrees and snapshot workspaces must be isolated from the working tree.",
  RULE_4_NEVER_BYPASS_WORKSPACE_AUTHORIZATION:
    "Never bypass workspace authorization. All file and tool operations must be verified within the active canonical workspace root.",
  RULE_5_NEVER_FABRICATE_TOOL_EVIDENCE:
    "Never fabricate tool evidence. Evidence records require observed execution provenance with real commands and output hashes.",
  RULE_6_NEVER_MARK_UNSUPPORTED_MODEL_CLAIMS_AS_VERIFIED:
    "Never mark unsupported model claims as verified. Observed prose claims must never be promoted to verified without fresh deterministic execution.",
  RULE_7_NEVER_AUTO_MERGE_UNVERIFIED_AGENT_CHANGES:
    "Never automatically merge unverified agent changes. Changes must pass the Dual Validation Gate before touching the user workspace.",
  RULE_8_NEVER_ENABLE_UNTESTED_SUBSYSTEMS_BY_DEFAULT:
    "Never enable untested subsystems by default. New engines (Project Intelligence, Memory, Multi-Agent) must start behind disabled feature flags with active legacy fallbacks.",
  RULE_9_NEVER_EXECUTE_UNBOUNDED_PARALLEL_TASKS:
    "Never execute unbounded parallel tasks. Resource governor concurrency limits and file ownership locks must precede any parallel execution.",
  RULE_10_PRESERVE_CANCELLATION_AND_FAILURE_PROPAGATION:
    "Preserve cancellation and failure propagation. Abort signals and child task failures must propagate faithfully without being swallowed.",
};

// 6. Universal Sensitive-File and Secret Boundary Policy

export const SENSITIVE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".aws",
  ".ssh",
  ".gnupg",
]);

export const SYSTEM_IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".next",
  ".vite",
  "out",
  ".turbo",
  ".mediobot",
  ".aws",
  ".ssh",
  ".gnupg",
  "coverage",
  ".cache",
]);

/**
 * Universal sensitive-file classification policy shared across Maestro, PIE, and Tools.
 * Returns true if any segment of the path or filename matches known credentials,
 * secrets, environment files, private keys, certificates, or database files.
 */
export function isSensitiveName(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  const segments = name.split(/[\\/]+/);
  return segments.some((segment) => {
    if (!segment) return false;
    const base = segment.toLowerCase();
    return (
      SENSITIVE_DIRECTORY_NAMES.has(base) ||
      /^\.env(?:\.|$)/i.test(base) ||
      /^\.(?:npmrc|pypirc|netrc|dockercfg)$/i.test(base) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)/i.test(base) ||
      /(?:^|[._-])(?:secrets?|credentials?|tokens?|passwords?|private[-_]?keys?)(?:[._-]|$)/i.test(base) ||
      /\.(?:pem|key|p12|pfx|kdbx)$/i.test(base) ||
      /\.(?:sqlite|sqlite3|db)(?:-(?:shm|wal))?$/i.test(base)
    );
  });
}

// 7. Resource Governor Contracts (Phase 4 Foundation)
export * from "./resource-governor.ts";

// 8. Web Intelligence Contracts (Phase 5 Foundation)
export * from "./web-intelligence.ts";
export * from "./specialist-collaboration.ts";

// 9. Dynamic Orchestration & Real Parallel Execution Contracts (Stage 1)

export type IntermediateArtifactKind =
  | "documentation"
  | "api-signature"
  | "dependency-analysis"
  | "research-evidence"
  | "constraint"
  | "verification-result";

export interface IntermediateArtifact {
  readonly id: string;
  readonly taskId: TaskId;
  readonly workerId: WorkerId;
  readonly mediobotId: MediobotDefinitionId;
  readonly kind: IntermediateArtifactKind;
  readonly title: string;
  readonly content: string;
  readonly isProvisional: boolean;
  readonly references?: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly timestamp: number;
}

export interface SupportRequest {
  readonly id: string;
  readonly requesterTaskId: TaskId;
  readonly requesterWorkerId: WorkerId;
  readonly requesterMediobotId: MediobotDefinitionId;
  readonly capabilityNeeded: string;
  readonly query: string;
  readonly contextSnippet?: string;
  readonly requestedAt: number;
}

export interface SupportResolution {
  readonly requestId: string;
  readonly decision: "existing_knowledge" | "delegate_doc" | "delegate_research" | "delegate_specialist" | "unnecessary";
  readonly reason: string;
  readonly answer?: string;
  readonly scheduledTaskId?: TaskId;
  readonly targetSpecialistId?: MediobotDefinitionId;
  readonly resolvedAt: number;
}

export interface OrchestrationTaskSpec {
  readonly id: TaskId;
  readonly definitionId: MediobotDefinitionId;
  readonly objective: string;
  readonly dependencies?: ReadonlyArray<TaskId>;
  readonly priority?: "interactive" | "background" | "batch";
  readonly relevantContext?: string;
  readonly relevantContextRefs?: ReadonlyArray<string>;
  readonly constraints?: ReadonlyArray<string>;
  readonly expectedOutcome?: string;
  readonly evidenceExpectations?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly depth?: number;
}

export interface OrchestrationPlanSpec {
  readonly planId: string;
  readonly goal: string;
  readonly tasks: ReadonlyArray<OrchestrationTaskSpec>;
  readonly explanation?: string;
}

// 10. Phase 1 Target Architecture Contracts (Milestone M0 / WP0)

/**
 * Scope type for execution: private 1-on-1 specialist chat vs multi-agent team collaboration.
 */
export type ExecutionScopeType = "direct_private" | "team";

/**
 * Authorization boundary for tool and workspace operations.
 * - read_only: inspection and verification only; all filesystem mutations denied.
 * - standard_mutation: standard project file mutations within canonicalRoot with hash-precondition checks.
 * - supervised_mutation: mutations requiring explicit user confirmation before execution.
 */
export type AuthorizationScope = "read_only" | "standard_mutation" | "supervised_mutation";

/**
 * Authoritative submission-time execution scope binding a task to a project and context.
 * UI navigation or active project switching never retargets running work.
 */
export interface ExecutionScope {
  /** The requested or display workspace root directory */
  readonly workspaceRoot: string;
  /** Real canonical filesystem path resolved at submission; prevents traversal and symlink escapes */
  readonly canonicalRoot: string;
  /** Stable workspace database identifier */
  readonly workspaceId: string;
  /** Conversation thread identifier */
  readonly threadId: string;
  /** Interaction turn identifier */
  readonly turnId: string;
  /** Private direct conversation vs team collaboration thread */
  readonly scopeType: ExecutionScopeType;
  /** Specialist that initiated or is targeted by this scope (e.g. 'cody', 'tester', 'doc', 'scraapy') */
  readonly initiatingSpecialistId?: string;
  /** Optional parent task identifier in the durable task tree */
  readonly parentTaskId?: TaskId;
  /** Authorization boundary for operations executed under this scope */
  readonly authorizationScope: AuthorizationScope;
}

/**
 * Immutable snapshot of model configuration, connection, and effort resolved for a task.
 * Persisted before first inference and reused across all recovery, restart, and repair paths.
 */
export interface InferenceSnapshot {
  /** Stable identifier of the provider connection */
  readonly connectionId: string;
  /** Provider type/key (e.g. 'nvidia', 'dahl', 'openai', 'mock') */
  readonly providerKey: string;
  /** Exact selected model identifier */
  readonly modelId: string;
  /** User-requested reasoning effort (e.g. 'low' | 'medium' | 'high' | 'extra' | 'max') */
  readonly requestedEffort?: string;
  /** Effective reasoning effort forwarded to provider after capability resolution */
  readonly effectiveEffort?: string;
  /** Protocol capabilities resolved for this model/provider */
  readonly protocolCapabilities: ReadonlyArray<string>;
  /** Epoch millisecond timestamp when the snapshot was resolved */
  readonly resolvedAt: number;
}

/** Status of an individual criterion verification */
export type CriterionVerificationStatus = "passed" | "failed" | "unverified";

/** Provenance of verification evidence */
export type CriterionVerificationProvenance = "runner-observed" | "model-provided";

/**
 * Independent verification evidence for a single machine-checkable or semantic criterion.
 * Strictly bound to runner-observed command exit codes and candidate artifact hashes.
 */
export interface CriterionVerification {
  /** Identifier of the goal criterion being verified */
  readonly criterionId: string;
  /** Human-readable description or statement of the criterion */
  readonly description: string;
  /** Unique invocation ID of the verification tool execution */
  readonly toolExecutionId: string;
  /** SHA-256 hash of the candidate artifact revision when verified */
  readonly candidateArtifactHash: string;
  /** Exit code observed by the runner (0 for success) */
  readonly exitCode: number;
  /** Verification status */
  readonly status: CriterionVerificationStatus;
  /** Provenance: runner-observed execution vs unverified model claim */
  readonly provenance: CriterionVerificationProvenance;
}

/**
 * Tracked revision of a project artifact touched during execution.
 * Pre/post content hashes ensure conflict detection and verification cache validity.
 */
export interface ArtifactRevision {
  /** Workspace-relative path to the artifact file */
  readonly artifactPath: string;
  /** SHA-256 content hash prior to modification */
  readonly preHash: string;
  /** SHA-256 content hash after modification */
  readonly postHash: string;
  /** Monotonic revision number for this artifact within the task */
  readonly revisionNumber: number;
  /** Optional link to the CriterionVerification check ID that validated this revision */
  readonly verifiedByCheckId?: string;
}

/**
 * Specification for a single bounded repair continuation loop.
 * Transmits exact check failures to Cody and mandates recheck against the new revision.
 */
export interface BoundedRepairSpec {
  /** Specific criteria that failed verification */
  readonly failureEvidence: ReadonlyArray<CriterionVerification>;
  /** The candidate revision that failed */
  readonly candidateRevision: ArtifactRevision;
  /** 1-based repair attempt counter (strictly max 1 in Phase 1) */
  readonly repairAttempt: number;
}

/** Lifecycle settlement of a worker execution */
export type OutcomeSettlement = "completed" | "failed" | "cancelled" | "timed_out";

/** Final verification verdict of an outcome */
export type OutcomeVerdict = "verified" | "failed" | "blocked" | "unverified" | "cancelled";

/**
 * Comprehensive outcome contract separating execution settlement from verification verdict.
 * Worker completion means execution returned; goal satisfaction requires verified verdict.
 */
export interface OutcomeContract {
  /** Execution lifecycle settlement */
  readonly settlement: OutcomeSettlement;
  /** Independent verification verdict */
  readonly verdict: OutcomeVerdict;
  /** Verified criteria evaluated against the final candidate artifact revision */
  readonly criteria: ReadonlyArray<CriterionVerification>;
  /** Revisions of artifacts evaluated */
  readonly revisions: ReadonlyArray<ArtifactRevision>;
  /** Truthful ledger-grounded summary */
  readonly summary: string;
  /** Preserved partial findings regardless of final verdict */
  readonly partialFindings?: ReadonlyArray<string>;
  /** Number of repair attempts executed (max 1 in Phase 1) */
  readonly repairAttemptCount?: number;
  /** Epoch millisecond timestamp of settlement */
  readonly settledAt: number;
}

/**
 * Extended assessment context for TrustedCompletion under Phase 1 target architecture.
 */
export interface TrustedCompletionAssessmentContext {
  readonly goal: Pick<Goal, "id" | "objective" | "successCriteria">;
  readonly assignment: Assignment;
  readonly result: {
    readonly state: "completed" | "failed" | "cancelled";
    readonly toolEvidenceCount: number;
    readonly settlement?: OutcomeSettlement;
    readonly verdict?: OutcomeVerdict;
  };
  readonly workspaceRoot: string;
  readonly executionScope?: ExecutionScope;
  readonly candidateRevisions?: ReadonlyArray<ArtifactRevision>;
  readonly criterionVerifications?: ReadonlyArray<CriterionVerification>;
}

/**
 * Extended criterion assessment returned by TrustedCompletion verifiers.
 */
export interface TrustedCriterionAssessment {
  readonly criterionId: string;
  readonly state: "satisfied" | "unsatisfied" | "unverified";
  readonly evidence?: Omit<GoalEvidenceInput, "goalId" | "taskId" | "workerId">;
  readonly verification?: CriterionVerification;
}

/** Type guard for ExecutionScope */
export function isExecutionScope(value: unknown): value is ExecutionScope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.workspaceRoot === "string" &&
    typeof candidate.canonicalRoot === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.threadId === "string" &&
    typeof candidate.turnId === "string" &&
    (candidate.scopeType === "direct_private" || candidate.scopeType === "team") &&
    (candidate.authorizationScope === "read_only" ||
      candidate.authorizationScope === "standard_mutation" ||
      candidate.authorizationScope === "supervised_mutation")
  );
}

/** Type guard for InferenceSnapshot */
export function isInferenceSnapshot(value: unknown): value is InferenceSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.connectionId === "string" &&
    typeof candidate.providerKey === "string" &&
    typeof candidate.modelId === "string" &&
    Array.isArray(candidate.protocolCapabilities) &&
    typeof candidate.resolvedAt === "number"
  );
}

/** Type guard for CriterionVerification */
export function isCriterionVerification(value: unknown): value is CriterionVerification {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.criterionId === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.toolExecutionId === "string" &&
    typeof candidate.candidateArtifactHash === "string" &&
    typeof candidate.exitCode === "number" &&
    (candidate.status === "passed" || candidate.status === "failed" || candidate.status === "unverified") &&
    (candidate.provenance === "runner-observed" || candidate.provenance === "model-provided")
  );
}

/** Type guard for ArtifactRevision */
export function isArtifactRevision(value: unknown): value is ArtifactRevision {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.artifactPath === "string" &&
    typeof candidate.preHash === "string" &&
    typeof candidate.postHash === "string" &&
    typeof candidate.revisionNumber === "number"
  );
}

// 7. Gate G06 & G07 File Locking, Watcher, Path Defense & OS Metadata Contracts

export interface FileLockOptions {
  /** Optional timeout in milliseconds to wait for the lock before rejecting with FileLockTimeoutError. Default: 30000ms. */
  readonly timeoutMs?: number;
  /** Optional AbortSignal to cancel waiting for lock acquisition. */
  readonly signal?: AbortSignal;
}

export class FileLockTimeoutError extends Error {
  readonly code = "FILE_LOCK_TIMEOUT";
  readonly canonicalPath: string;
  readonly timeoutMs: number;

  constructor(canonicalPath: string, timeoutMs: number) {
    super(`Lock acquisition timed out after ${timeoutMs}ms for '${canonicalPath}'`);
    this.name = "FileLockTimeoutError";
    this.canonicalPath = canonicalPath;
    this.timeoutMs = timeoutMs;
  }
}

export interface UnifiedFileLockService {
  /**
   * Acquires an exclusive write lock on the canonical file path, validates
   * expectedHash if provided, and executes the operation under the lock.
   */
  acquireWriteLock<T>(
    filePath: string,
    expectedHash: string | undefined,
    operation: () => Promise<T>,
    options?: FileLockOptions
  ): Promise<T>;

  /**
   * Acquires exclusive write locks on multiple paths in sorted canonical order (deadlock-free).
   */
  acquireWriteLocks<T>(
    filePaths: readonly string[],
    operation: () => Promise<T>,
    options?: FileLockOptions
  ): Promise<T>;

  /**
   * Computes the unambiguous canonical path for a given file path.
   */
  resolveCanonicalPath(filePath: string, baseDir?: string): Promise<string>;

  /**
   * Convenience alias for acquireWriteLock with undefined expectedHash.
   */
  acquire<T>(filePath: string, operation: () => Promise<T>, options?: FileLockOptions): Promise<T>;
}

export const OS_METADATA_NAMES: ReadonlySet<string> = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
  "ehthumbs.db",
  "ehthumbs_vista.db",
  ".spotlight-v100",
  ".trashes",
  ".fseventsd",
]);

export function isOSMetadata(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return (
    OS_METADATA_NAMES.has(base) ||
    base.startsWith("._") ||
    base === ".ds_store" ||
    base.endsWith(".ds_store")
  );
}

export interface WorkspaceWatchEvent {
  readonly type: "create" | "modify" | "delete" | "rename";
  readonly relativePath: string;
  readonly timestamp: number;
  readonly contentHash?: string;
  readonly origin?: "editor" | "agent" | "external";
}

export class PathEscapeForbiddenError extends Error {
  readonly code = "FORBIDDEN";
  readonly statusCode = 403;

  constructor(message = "Path escapes the canonical workspace root.") {
    super(message);
    this.name = "PathEscapeForbiddenError";
  }
}


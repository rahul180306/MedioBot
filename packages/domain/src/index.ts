type Id<Name extends string> = string & { readonly __brand: Name };

export type WorldId = Id<"WorldId">;
export type MediobotDefinitionId = Id<"MediobotDefinitionId">;
export type WorkerId = Id<"WorkerId">;
export type TaskId = Id<"TaskId">;
export type ResourceId = Id<"ResourceId">;
export type EvidenceId = Id<"EvidenceId">;
export type GoalId = Id<"GoalId">;
export type AssignmentId = Id<"AssignmentId">;
export type ArtifactId = Id<"ArtifactId">;
export type EventId = Id<"EventId">;

export type WorkerState = "idle" | "busy" | "stopped";
export type TaskState = "created" | "assigned" | "running" | "paused" | "waiting_approval" | "completed" | "failed" | "cancelled";
export type ResourceState = "available" | "in-use" | "released";
export type ResourceKind =
  | "workspace"
  | "browser-context"
  | "browser-page"
  | "terminal"
  | "model-session"
  | "perception-state";

export type GoalStatus = "active" | "waiting-user" | "blocked" | "paused" | "satisfied" | "failed" | "cancelled";
export type GoalInformationSource = "user" | "maestro" | "environment";
export type GoalCriterionState = "unknown" | "satisfied" | "unsatisfied";
export type MediobotLifecycleState = "active" | "draining" | "disabled";
export type WorkerActivityState = "thinking" | "planning" | "inspecting" | "editing" | "running" | "testing" | "verifying"
  | "researching" | "collaborating" | "waiting" | "waiting_for_approval" | "retrying" | "recovered" | "verified"
  | "blocked" | "completed" | "failed" | "cancelled";

export interface Capability {
  readonly kind: "resource" | "action";
  readonly name: string;
  readonly description?: string;
}

export interface World {
  readonly id: WorldId;
  readonly createdAt: number;
}

export interface MediobotDefinition {
  readonly id: MediobotDefinitionId;
  readonly name: string;
  readonly role: string;
  readonly version: string;
  readonly instructions: string;
  readonly declaredCapabilities: ReadonlyArray<Capability>;
  readonly lifecycleState: MediobotLifecycleState;
}

export interface Worker {
  readonly id: WorkerId;
  readonly worldId: WorldId;
  readonly definitionId: MediobotDefinitionId;
  readonly state: WorkerState;
}

export interface Task {
  readonly id: TaskId;
  readonly worldId: WorldId;
  readonly goal: string;
  readonly state: TaskState;
  readonly assignedWorkerId: WorkerId | null;
  readonly parentTaskId?: TaskId;
}

export type ResourceOwner =
  | { readonly type: "world"; readonly worldId: WorldId }
  | { readonly type: "worker"; readonly worldId: WorldId; readonly workerId: WorkerId }
  | { readonly type: "task"; readonly worldId: WorldId; readonly taskId: TaskId };

export interface Resource {
  readonly id: ResourceId;
  readonly worldId: WorldId;
  readonly kind: ResourceKind;
  readonly owner: ResourceOwner;
  readonly state: ResourceState;
}

export interface EvidenceSource {
  readonly type: string;
  readonly reference: string;
}

/** Runtime-authored policy; source reference identifies the verifier/invocation, not prose. */
export interface EvidenceRequirement {
  readonly kind: string;
  readonly source: EvidenceSource;
  readonly validity: "observed" | "verified";
  readonly workerId?: WorkerId;
  readonly taskId?: TaskId;
  readonly subject?: string;
  readonly revision?: string;
}

interface EvidenceRecord {
  readonly id: EvidenceId;
  readonly worldId: WorldId;
  readonly source: EvidenceSource;
  readonly content: string;
  readonly kind?: string;
  readonly claim?: string;
  readonly artifactReference?: string;
  readonly validity?: "observed" | "verified" | "invalidated";
  readonly createdAt: number;
  readonly subject?: string;
  readonly revision?: string;
}

export type Evidence = EvidenceRecord & (
  | { readonly taskId: TaskId; readonly workerId: WorkerId; readonly goalId?: GoalId }
  | { readonly taskId?: never; readonly workerId?: never; readonly goalId: GoalId }
);

export interface GoalConstraint {
  readonly text: string;
  readonly source: GoalInformationSource;
  readonly hard: boolean;
}

export interface GoalCriterion {
  readonly id: string;
  readonly statement: string;
  readonly required: boolean;
  readonly state: GoalCriterionState;
  readonly supportingEvidenceIds: ReadonlyArray<EvidenceId>;
  readonly evidenceRequirement?: EvidenceRequirement;
}

export interface GoalBudget {
  readonly limit?: number;
  readonly consumed: number;
  readonly exhausted: boolean;
}

/** Desired outcome and durable alignment state; deliberately contains no execution plan or Worker. */
export interface Goal {
  readonly id: GoalId;
  readonly worldId: WorldId;
  readonly threadId: string;
  readonly objective: string;
  readonly constraints: ReadonlyArray<GoalConstraint>;
  readonly assumptions: ReadonlyArray<{ readonly text: string; readonly source: GoalInformationSource }>;
  readonly successCriteria: ReadonlyArray<GoalCriterion>;
  readonly evidenceRequirements: ReadonlyArray<string>;
  readonly status: GoalStatus;
  readonly subgoals: ReadonlyArray<string>;
  readonly blockers: ReadonlyArray<string>;
  readonly budget: GoalBudget;
  readonly evidenceIds: ReadonlyArray<EvidenceId>;
  readonly outcome?: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Bounded outcome request for a definition. It does not prescribe an action sequence. */
export interface Assignment {
  readonly id: AssignmentId;
  readonly worldId: WorldId;
  readonly goalId: GoalId;
  readonly targetDefinitionId: MediobotDefinitionId;
  readonly objective: string;
  readonly relevantContext?: string;
  readonly relevantContextRefs: ReadonlyArray<string>;
  readonly constraints: ReadonlyArray<string>;
  readonly expectedOutcome: string;
  readonly evidenceExpectations: ReadonlyArray<string>;
  readonly createdAt: number;
}

export interface GoalAnchor {
  readonly goalId: GoalId;
  readonly objective: string;
  readonly constraints: ReadonlyArray<string>;
  readonly unresolvedCriteria: ReadonlyArray<string>;
  readonly blockers: ReadonlyArray<string>;
}

export interface Artifact {
  readonly id: ArtifactId;
  readonly worldId: WorldId;
  readonly taskId: TaskId;
  readonly workerId: WorkerId;
  readonly name: string;
  readonly reference: string;
  readonly createdAt: number;
}

export interface WorldEvent {
  readonly id: EventId;
  readonly sequence: number;
  readonly worldId: WorldId;
  readonly type: string;
  readonly workerId?: WorkerId;
  readonly taskId?: TaskId;
  readonly resourceId?: ResourceId;
  readonly toolName?: string;
  readonly toolInvocationId?: string;
  readonly command?: string;
  /** Bounded, redacted command preview; never raw stdout/stderr. */
  readonly workingDirectory?: string;
  /** Bounded factual explanation of a retry or why it was not attempted. */
  readonly recoveryReason?: string;
  readonly message?: string;
  readonly activityState?: WorkerActivityState;
  readonly error?: string;
  /** Sanitized operating-system error code; never command text or output. */
  readonly errorCode?: string;
  readonly failureCategory?: string;
  readonly durationMs?: number;
  readonly startedAt?: number;
  readonly isVerification?: boolean;
  readonly verificationStatus?: 'command-succeeded' | 'command-failed' | 'unverified';
  readonly exitCode?: number | null;
  /** Child-process signal for a null exit code; allowlisted before product exposure. */
  readonly terminationSignal?: string;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly recoveredFromExecution?: boolean;
  readonly outputLog?: string;
  /** Structured assignment identity carried by Maestro delegation events. */
  readonly assignedWorkerId?: WorkerId;
  readonly assignedDefinitionId?: MediobotDefinitionId;
  readonly executionTaskId?: TaskId;
  readonly assignmentObjective?: string;
  readonly occurredAt: number;
}

export interface WorldSnapshot {
  readonly world: World;
  readonly definitions: ReadonlyArray<MediobotDefinition>;
  readonly workers: ReadonlyArray<Worker>;
  readonly tasks: ReadonlyArray<Task>;
  readonly resources: ReadonlyArray<Resource>;
  readonly evidence: ReadonlyArray<Evidence>;
  readonly goals: ReadonlyArray<Goal>;
  readonly assignments: ReadonlyArray<Assignment>;
  readonly artifacts: ReadonlyArray<Artifact>;
  readonly events: ReadonlyArray<WorldEvent>;
}

export interface MediobotDefinitionInput {
  readonly id?: MediobotDefinitionId;
  readonly name: string;
  readonly role: string;
  readonly version: string;
  readonly instructions: string;
  readonly declaredCapabilities: ReadonlyArray<Capability>;
  readonly lifecycleState?: MediobotLifecycleState;
}

export interface ResourceInput {
  readonly kind: ResourceKind;
  readonly owner: ResourceOwner;
}

export interface TaskEvidenceInput {
  readonly subject?: string;
  readonly revision?: string;
  readonly taskId: TaskId;
  readonly workerId: WorkerId;
  readonly goalId?: GoalId;
  readonly source: EvidenceSource;
  readonly content: string;
  readonly kind?: string;
  readonly claim?: string;
  readonly artifactReference?: string;
  readonly validity?: "observed" | "verified" | "invalidated";
}

export interface GoalEvidenceInput {
  readonly taskId?: never;
  readonly workerId?: never;
  readonly subject?: string;
  readonly revision?: string;
  readonly goalId: GoalId;
  readonly source: EvidenceSource;
  readonly content: string;
  readonly kind?: string;
  readonly claim?: string;
  readonly artifactReference?: string;
  readonly validity?: "observed" | "verified" | "invalidated";
}

export type EvidenceInput = TaskEvidenceInput | GoalEvidenceInput;

export interface GoalInput {
  readonly threadId: string;
  readonly objective: string;
  readonly constraints?: ReadonlyArray<GoalConstraint>;
  readonly assumptions?: ReadonlyArray<{ readonly text: string; readonly source: GoalInformationSource }>;
  readonly successCriteria?: ReadonlyArray<{ readonly id: string; readonly statement: string; readonly required?: boolean;
    readonly evidenceRequirement?: EvidenceRequirement }>;
  readonly evidenceRequirements?: ReadonlyArray<string>;
  readonly budgetLimit?: number;
}

export interface AssignmentInput {
  readonly goalId: GoalId;
  readonly targetDefinitionId: MediobotDefinitionId;
  readonly objective: string;
  readonly relevantContext?: string;
  readonly relevantContextRefs?: ReadonlyArray<string>;
  readonly constraints?: ReadonlyArray<string>;
  readonly expectedOutcome: string;
  readonly evidenceExpectations?: ReadonlyArray<string>;
}

export interface ArtifactInput {
  readonly taskId: TaskId;
  readonly workerId: WorkerId;
  readonly name: string;
  readonly reference: string;
}

export interface EventInput {
  readonly type: string;
  readonly workerId?: WorkerId;
  readonly taskId?: TaskId;
  readonly resourceId?: ResourceId;
  readonly toolName?: string;
  readonly toolInvocationId?: string;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly recoveryReason?: string;
  readonly message?: string;
  readonly error?: string;
  readonly errorCode?: string;
  readonly failureCategory?: string;
  readonly durationMs?: number;
  readonly startedAt?: number;
  readonly isVerification?: boolean;
  readonly verificationStatus?: 'command-succeeded' | 'command-failed' | 'unverified';
  readonly exitCode?: number | null;
  readonly terminationSignal?: string;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly recoveredFromExecution?: boolean;
  readonly outputLog?: string;
}

function id<Name extends string>(prefix: string): Id<Name> {
  return `${prefix}_${globalThis.crypto.randomUUID()}` as Id<Name>;
}

function sameOwner(left: ResourceOwner, right: ResourceOwner): boolean {
  if (left.type !== right.type || left.worldId !== right.worldId) return false;
  if (left.type === "world" && right.type === "world") return true;
  if (left.type === "worker" && right.type === "worker") return left.workerId === right.workerId;
  return left.type === "task" && right.type === "task" && left.taskId === right.taskId;
}

function copyResource(resource: Resource): Resource {
  return { ...resource, owner: { ...resource.owner } };
}

function copyGoal(goal: Goal): Goal {
  return { ...goal, constraints: goal.constraints.map((constraint) => ({ ...constraint })),
    assumptions: goal.assumptions.map((assumption) => ({ ...assumption })),
    successCriteria: goal.successCriteria.map((criterion) => ({ ...criterion,
      ...(criterion.evidenceRequirement ? { evidenceRequirement: copyRequirement(criterion.evidenceRequirement) } : {}),
      supportingEvidenceIds: [...criterion.supportingEvidenceIds] })),
    evidenceRequirements: [...goal.evidenceRequirements], subgoals: [...goal.subgoals], blockers: [...goal.blockers],
    budget: { ...goal.budget }, evidenceIds: [...goal.evidenceIds] };
}

function copyRequirement(requirement: EvidenceRequirement): EvidenceRequirement {
  rejectInheritedIdentity(requirement);
  const { kind, validity, workerId, taskId, subject, revision } = requirement;
  const source = normalizeSource(requirement.source);
  if (!nonemptyString(kind) || !["observed", "verified"].includes(validity)
    || (workerId !== undefined && !nonemptyString(workerId))
    || (taskId !== undefined && !nonemptyString(taskId))
    || (subject !== undefined && !nonemptyString(subject))
    || (revision !== undefined && (!subject || !nonemptyString(revision)))) {
    throw new Error("Invalid evidence requirement");
  }
  return { kind, source, validity,
    ...(workerId !== undefined ? { workerId } : {}), ...(taskId !== undefined ? { taskId } : {}),
    ...(subject !== undefined ? { subject } : {}), ...(revision !== undefined ? { revision } : {}) };
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSource(source: EvidenceSource): EvidenceSource {
  if (!source || !nonemptyString(source.type) || !nonemptyString(source.reference)) {
    throw new Error("Evidence source requires string type and reference");
  }
  return { type: source.type, reference: source.reference };
}

function rejectInheritedIdentity(input: object): void {
  for (const key of ["taskId", "workerId", "goalId"]) {
    if (key in input && !Object.hasOwn(input, key)) throw new Error("Evidence identity must be an own property");
  }
}

const goalTransitions: Record<GoalStatus, ReadonlyArray<GoalStatus>> = {
  active: ["waiting-user", "blocked", "paused", "satisfied", "failed", "cancelled"],
  "waiting-user": ["active", "blocked", "paused", "failed", "cancelled"],
  blocked: ["active", "waiting-user", "paused", "failed", "cancelled"],
  paused: ["active", "waiting-user", "blocked", "failed", "cancelled"],
  satisfied: [], failed: [], cancelled: [],
};

const workerTransitions: Record<WorkerState, ReadonlyArray<WorkerState>> = {
  idle: ["busy", "stopped"], busy: ["idle", "stopped"], stopped: [],
};

const taskTransitions: Record<TaskState, ReadonlyArray<TaskState>> = {
  created: ["assigned", "running", "failed", "cancelled"],
  // assigned -> completed also represents restoring a completed durable child
  // into a fresh in-memory World after application restart.
  assigned: ["running", "paused", "completed", "failed", "cancelled"],
  running: ["paused", "waiting_approval", "completed", "failed", "cancelled"],
  paused: ["running", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  completed: [], failed: [], cancelled: [],
};

const resourceTransitions: Record<ResourceState, ReadonlyArray<ResourceState>> = {
  available: ["in-use", "released"], "in-use": ["available", "released"], released: ["in-use"],
};

function validateLifecycleTransition<T extends string>(kind: string, current: T, next: T,
  transitions: Record<T, ReadonlyArray<T>>): void {
  if (current !== next && !transitions[current].includes(next)) {
    throw new Error(`Illegal ${kind} transition: ${current} -> ${next}`);
  }
}

function copyAssignment(assignment: Assignment): Assignment {
  return { ...assignment, relevantContextRefs: [...assignment.relevantContextRefs], constraints: [...assignment.constraints],
    evidenceExpectations: [...assignment.evidenceExpectations] };
}

export class InMemoryWorld {
  readonly id: WorldId;

  private readonly world: World;
  private readonly definitions = new Map<MediobotDefinitionId, MediobotDefinition>();
  private readonly workers = new Map<WorkerId, Worker>();
  private readonly tasks = new Map<TaskId, Task>();
  private readonly resources = new Map<ResourceId, Resource>();
  private readonly evidence = new Map<EvidenceId, Evidence>();
  private readonly goals = new Map<GoalId, Goal>();
  private readonly assignments = new Map<AssignmentId, Assignment>();
  private readonly artifacts = new Map<ArtifactId, Artifact>();
  private readonly events: WorldEvent[] = [];

  constructor(identity?: World) {
    this.id = identity?.id ?? id<"WorldId">("world");
    this.world = { id: this.id, createdAt: identity?.createdAt ?? Date.now() };
  }

  registerMediobotDefinition(input: MediobotDefinitionInput): MediobotDefinition {
    const definitionId = input.id ?? id<"MediobotDefinitionId">("definition");
    if (this.definitions.has(definitionId)) throw new Error("Mediobot definition ID is already registered");
    const definition: MediobotDefinition = {
      ...input,
      id: definitionId,
      lifecycleState: input.lifecycleState ?? "active",
      declaredCapabilities: input.declaredCapabilities.map((capability) => ({ ...capability })),
    };
    this.definitions.set(definition.id, definition);
    return { ...definition, declaredCapabilities: definition.declaredCapabilities.map((capability) => ({ ...capability })) };
  }

  /** Stop new work before disabling an identity; existing tasks remain intact and attributed. */
  setMediobotLifecycleState(definitionId: MediobotDefinitionId, lifecycleState: MediobotLifecycleState): MediobotDefinition {
    const current = this.definitions.get(definitionId);
    if (!current) throw new Error("Mediobot definition does not exist in this world");
    if (lifecycleState === "disabled") {
      const activeWorkerIds = new Set([...this.workers.values()]
        .filter(worker => worker.definitionId === definitionId)
        .map(worker => worker.id));
      const hasActiveWork = [...this.tasks.values()].some(task => Boolean(task.assignedWorkerId)
        && activeWorkerIds.has(task.assignedWorkerId!)
        && ["created", "assigned", "running", "paused", "waiting_approval"].includes(task.state));
      if (hasActiveWork) throw new Error("Cannot disable a Mediobot while it has active work; drain it first");
    }
    const updated = { ...current, lifecycleState };
    this.definitions.set(definitionId, updated);
    return { ...updated, declaredCapabilities: updated.declaredCapabilities.map(capability => ({ ...capability })) };
  }

  spawnWorker(definitionId: MediobotDefinitionId): Worker {
    const definition = this.definitions.get(definitionId);
    if (!definition) throw new Error("Mediobot definition does not exist in this world");
    if (definition.lifecycleState !== "active") throw new Error("Mediobot definition is not active for new work");
    const worker: Worker = {
      id: id<"WorkerId">("worker"),
      worldId: this.id,
      definitionId,
      state: "idle",
    };
    this.workers.set(worker.id, worker);
    return { ...worker };
  }

  setWorkerState(workerId: WorkerId, state: WorkerState): Worker {
    const worker = this.requireWorker(workerId);
    validateLifecycleTransition("Worker", worker.state, state, workerTransitions);
    const updated = { ...worker, state };
    this.workers.set(workerId, updated);
    return { ...updated };
  }

  createTask(goal: string, parentTaskId?: TaskId, explicitTaskId?: TaskId): Task {
    if (parentTaskId) this.requireTask(parentTaskId);
    const task: Task = {
      id: explicitTaskId ?? id<"TaskId">("task"),
      worldId: this.id,
      goal,
      state: "created",
      assignedWorkerId: null,
      ...(parentTaskId ? { parentTaskId } : {}),
    };
    this.tasks.set(task.id, task);
    return { ...task };
  }

  assignTask(taskId: TaskId, workerId: WorkerId): Task {
    const task = this.requireTask(taskId);
    if (task.state !== "created") throw new Error("Only a created task can be assigned");
    this.requireWorker(workerId);
    const assigned: Task = { ...task, state: "assigned", assignedWorkerId: workerId };
    this.tasks.set(taskId, assigned);
    return { ...assigned };
  }

  setTaskState(taskId: TaskId, state: TaskState): Task {
    const task = this.requireTask(taskId);
    validateLifecycleTransition("Task", task.state, state, taskTransitions);
    const updated = { ...task, state };
    this.tasks.set(taskId, updated);
    return { ...updated };
  }

  registerResource(input: ResourceInput): Resource {
    this.validateOwner(input.owner);
    const resource: Resource = {
      id: id<"ResourceId">("resource"),
      worldId: this.id,
      kind: input.kind,
      owner: { ...input.owner },
      state: "available",
    };
    this.resources.set(resource.id, resource);
    return copyResource(resource);
  }

  getResourcesByOwner(owner: ResourceOwner): ReadonlyArray<Resource> {
    this.validateOwner(owner);
    return [...this.resources.values()]
      .filter((resource) => sameOwner(resource.owner, owner))
      .map(copyResource);
  }

  getResourceOwner(resourceId: ResourceId): ResourceOwner {
    const resource = this.resources.get(resourceId);
    if (!resource) throw new Error("Resource does not exist in this world");
    return { ...resource.owner };
  }

  setResourceState(resourceId: ResourceId, state: ResourceState): Resource {
    const resource = this.requireResource(resourceId);
    validateLifecycleTransition("Resource", resource.state, state, resourceTransitions);
    const updated = { ...resource, state };
    this.resources.set(resourceId, updated);
    return copyResource(updated);
  }

  createGoal(input: GoalInput): Goal {
    const threadId = input.threadId.trim();
    const objective = input.objective.trim();
    if (!threadId || !objective) throw new Error("Goal thread and objective are required");
    if (input.budgetLimit !== undefined && (!Number.isFinite(input.budgetLimit) || input.budgetLimit < 0)) {
      throw new Error("Goal budget limit must be a non-negative number");
    }
    const criterionIds = (input.successCriteria ?? []).map((criterion) => criterion.id);
    if (new Set(criterionIds).size !== criterionIds.length) throw new Error("Goal success criterion IDs must be unique");
    const successCriteria: GoalCriterion[] = (input.successCriteria ?? []).map((criterion) => {
      const requirement = criterion.evidenceRequirement === undefined ? undefined : copyRequirement(criterion.evidenceRequirement);
      if (requirement?.workerId !== undefined) this.requireWorker(requirement.workerId);
      if (requirement?.taskId !== undefined) this.requireTask(requirement.taskId);
      if (requirement?.workerId !== undefined && requirement.taskId !== undefined) {
        this.validateProducer(requirement.taskId, requirement.workerId);
      }
      return { id: criterion.id, statement: criterion.statement,
        ...(requirement ? { evidenceRequirement: requirement } : {}),
        required: criterion.required ?? true, state: "unknown", supportingEvidenceIds: [] };
    });
    const now = Date.now();
    const goal: Goal = {
      id: id<"GoalId">("goal"), worldId: this.id, threadId, objective,
      constraints: (input.constraints ?? []).map((constraint) => ({ ...constraint })),
      assumptions: (input.assumptions ?? []).map((assumption) => ({ ...assumption })),
      successCriteria,
      evidenceRequirements: [...(input.evidenceRequirements ?? [])], status: "active", subgoals: [], blockers: [],
      budget: { ...(input.budgetLimit !== undefined ? { limit: input.budgetLimit } : {}), consumed: 0,
        exhausted: input.budgetLimit === 0 },
      evidenceIds: [], revision: 1, createdAt: now, updatedAt: now,
    };
    this.goals.set(goal.id, goal);
    return copyGoal(goal);
  }

  getGoal(goalId: GoalId): Goal { return copyGoal(this.requireGoal(goalId)); }

  listGoals(): ReadonlyArray<Goal> { return [...this.goals.values()].map(copyGoal); }

  updateGoal(goalId: GoalId, update: { readonly status?: Exclude<GoalStatus, "satisfied">; readonly subgoals?: ReadonlyArray<string>;
    readonly blockers?: ReadonlyArray<string>; readonly budgetConsumed?: number; readonly outcome?: string }): Goal {
    const goal = this.requireGoal(goalId);
    if ((update.status as GoalStatus | undefined) === "satisfied") throw new Error("Goal satisfaction requires evidence-backed success criteria");
    if (update.status !== undefined) this.validateGoalTransition(goal, update.status);
    if (update.budgetConsumed !== undefined && (!Number.isFinite(update.budgetConsumed) || update.budgetConsumed < goal.budget.consumed)) {
      throw new Error("Goal budget consumption cannot be negative or move backwards");
    }
    const consumed = update.budgetConsumed ?? goal.budget.consumed;
    const budget = { ...goal.budget, consumed, exhausted: goal.budget.limit !== undefined && consumed >= goal.budget.limit };
    const updated: Goal = { ...goal, ...(update.status ? { status: update.status } : {}),
      ...(update.subgoals ? { subgoals: [...update.subgoals] } : {}), ...(update.blockers ? { blockers: [...update.blockers] } : {}),
      ...(update.outcome !== undefined ? { outcome: update.outcome } : {}), budget, revision: goal.revision + 1, updatedAt: Date.now() };
    this.goals.set(goalId, updated);
    return copyGoal(updated);
  }

  transitionGoal(goalId: GoalId, status: GoalStatus): Goal {
    const goal = this.requireGoal(goalId);
    this.validateGoalTransition(goal, status);
    const updated = { ...goal, status, revision: goal.revision + 1, updatedAt: Date.now() };
    this.goals.set(goalId, updated);
    return copyGoal(updated);
  }

  private validateGoalTransition(goal: Goal, status: GoalStatus): void {
    if (status !== goal.status && !goalTransitions[goal.status].includes(status)) {
      throw new Error(`Illegal Goal transition: ${goal.status} -> ${status}`);
    }
    if (status === "satisfied" && !this.hasSatisfiedCriteria(goal)) {
      throw new Error("Goal satisfaction requires evidence-backed success criteria");
    }
  }

  private hasSatisfiedCriteria(goal: Goal): boolean {
    const required = goal.successCriteria.filter((criterion) => criterion.required);
    return goal.evidenceRequirements.length === 0 && required.length > 0
      && required.every((criterion) => criterion.state === "satisfied" && criterion.supportingEvidenceIds.length > 0);
  }

  addGoalConstraint(goalId: GoalId, constraint: GoalConstraint): Goal {
    const goal = this.requireGoal(goalId);
    const updated: Goal = { ...goal, constraints: [...goal.constraints, { ...constraint }], revision: goal.revision + 1, updatedAt: Date.now() };
    this.goals.set(goalId, updated);
    return copyGoal(updated);
  }

  createAssignment(input: AssignmentInput): Assignment {
    this.requireGoal(input.goalId);
    if (!this.definitions.has(input.targetDefinitionId)) throw new Error("Assignment target definition does not exist in this world");
    if (!input.objective.trim() || !input.expectedOutcome.trim()) throw new Error("Assignment objective and expected outcome are required");
    const assignment: Assignment = { ...input, id: id<"AssignmentId">("assignment"), worldId: this.id,
      objective: input.objective.trim(), expectedOutcome: input.expectedOutcome.trim(),
      relevantContextRefs: [...(input.relevantContextRefs ?? [])], constraints: [...(input.constraints ?? [])],
      evidenceExpectations: [...(input.evidenceExpectations ?? [])], createdAt: Date.now() };
    this.assignments.set(assignment.id, assignment);
    return copyAssignment(assignment);
  }

  getAssignments(goalId?: GoalId): ReadonlyArray<Assignment> {
    if (goalId) this.requireGoal(goalId);
    return [...this.assignments.values()].filter((assignment) => !goalId || assignment.goalId === goalId).map(copyAssignment);
  }

  linkEvidenceToGoal(goalId: GoalId, evidenceId: EvidenceId): Goal {
    const goal = this.requireGoal(goalId);
    const evidence = this.evidence.get(evidenceId);
    if (!evidence || evidence.worldId !== this.id) throw new Error("Evidence does not exist in this world");
    if (evidence.goalId !== undefined && evidence.goalId !== goalId) throw new Error("Evidence belongs to another goal");
    // First association preserves task, worker, source and all other provenance.
    this.evidence.set(evidenceId, { ...evidence, goalId });
    const updated: Goal = { ...goal, evidenceIds: goal.evidenceIds.includes(evidenceId) ? [...goal.evidenceIds] : [...goal.evidenceIds, evidenceId],
      revision: goal.revision + 1, updatedAt: Date.now() };
    this.goals.set(goalId, updated);
    return copyGoal(updated);
  }

  recordEvidence(input: EvidenceInput): Evidence {
    rejectInheritedIdentity(input);
    const { taskId, workerId, goalId, content, kind, claim, artifactReference, validity, subject, revision } = input;
    const source = normalizeSource(input.source);
    if (typeof content !== "string" || (kind !== undefined && !nonemptyString(kind))
      || (claim !== undefined && typeof claim !== "string")
      || (artifactReference !== undefined && typeof artifactReference !== "string")
      || (validity !== undefined && !["observed", "verified", "invalidated"].includes(validity))
      || (subject !== undefined && !nonemptyString(subject))
      || (revision !== undefined && (!subject || !nonemptyString(revision)))) {
      throw new Error("Invalid evidence fields");
    }
    let attribution: Pick<TaskEvidenceInput, "taskId" | "workerId" | "goalId"> | Pick<GoalEvidenceInput, "goalId">;
    if ("taskId" in input || "workerId" in input) {
      if (!nonemptyString(taskId) || !nonemptyString(workerId)) throw new Error("Evidence requires both taskId and workerId");
      this.validateProducer(taskId, workerId);
      attribution = { taskId, workerId, ...(goalId !== undefined ? { goalId } : {}) };
    } else {
      if (!nonemptyString(goalId)) throw new Error("Goal-only evidence requires goalId");
      attribution = { goalId };
    }
    if (goalId !== undefined) {
      if (!nonemptyString(goalId)) throw new Error("Invalid evidence goalId");
      this.requireGoal(goalId);
    }
    const record: Evidence = {
      ...attribution, source, content,
      ...(kind !== undefined ? { kind } : {}), ...(claim !== undefined ? { claim } : {}),
      ...(artifactReference !== undefined ? { artifactReference } : {}),
      ...(validity !== undefined ? { validity } : {}), ...(subject !== undefined ? { subject } : {}),
      ...(revision !== undefined ? { revision } : {}),
      id: id<"EvidenceId">("evidence"),
      worldId: this.id,
      createdAt: Date.now(),
    };
    this.evidence.set(record.id, record);
    if (record.goalId) {
      const goal = this.requireGoal(record.goalId);
      this.goals.set(goal.id, { ...goal, evidenceIds: [...goal.evidenceIds, record.id], revision: goal.revision + 1, updatedAt: Date.now() });
    }
    return { ...record, source: { ...record.source } };
  }

  supportGoalCriterion(goalId: GoalId, criterionId: string, state: Exclude<GoalCriterionState, "unknown">, evidenceIds: ReadonlyArray<EvidenceId>): Goal {
    const goal = this.requireGoal(goalId);
    const criterion = goal.successCriteria.find((entry) => entry.id === criterionId);
    if (!criterion) throw new Error("Goal success criterion does not exist");
    if (!evidenceIds.length) throw new Error("A criterion outcome requires supporting evidence");
    if (state !== "satisfied" && state !== "unsatisfied") throw new Error("Invalid criterion outcome");
    const requirement = criterion.evidenceRequirement;
    if (!requirement || goal.evidenceRequirements.length > 0) throw new Error("Uncompiled evidence requirements cannot support a criterion");
    for (const evidenceId of evidenceIds) {
      const evidence = this.evidence.get(evidenceId);
      if (!evidence || evidence.worldId !== this.id || evidence.goalId !== goalId) {
        throw new Error("Criterion evidence must belong to this goal");
      }
      if (evidence.validity === "invalidated") throw new Error("Invalidated evidence cannot support a criterion outcome");
      if (evidence.kind !== requirement.kind || evidence.source.type !== requirement.source.type
        || evidence.source.reference !== requirement.source.reference || evidence.validity !== requirement.validity
        || (requirement.workerId !== undefined && evidence.workerId !== requirement.workerId)
        || (requirement.taskId !== undefined && evidence.taskId !== requirement.taskId)
        || (requirement.subject !== undefined && evidence.subject !== requirement.subject)
        || (requirement.revision !== undefined && evidence.revision !== requirement.revision)) {
        throw new Error("Evidence does not match criterion requirement");
      }
    }
    const successCriteria = goal.successCriteria.map((entry) => entry.id === criterionId
      ? { ...entry, state, supportingEvidenceIds: [...new Set(evidenceIds)] } : entry);
    const satisfied = this.hasSatisfiedCriteria({ ...goal, successCriteria });
    const status = goal.status === "active" && satisfied ? "satisfied"
      : goal.status === "satisfied" && !satisfied ? "blocked" : goal.status;
    const updated: Goal = { ...goal, successCriteria, status,
      revision: goal.revision + 1, updatedAt: Date.now() };
    this.goals.set(goalId, updated);
    return copyGoal(updated);
  }

  /** Revokes proof atomically. A formerly satisfied Goal must explicitly resume from blocked. */
  invalidateEvidence(evidenceId: EvidenceId): Evidence {
    const evidence = this.evidence.get(evidenceId);
    if (!evidence) throw new Error("Evidence does not exist in this world");
    const invalidated: Evidence = { ...evidence, validity: "invalidated" };
    this.evidence.set(evidenceId, invalidated);
    for (const goal of this.goals.values()) {
      if (!goal.successCriteria.some((criterion) => criterion.supportingEvidenceIds.includes(evidenceId))) continue;
      // Clear the whole assessment: do not silently infer that remaining candidates suffice.
      const successCriteria = goal.successCriteria.map((criterion) => criterion.supportingEvidenceIds.includes(evidenceId)
        ? { ...criterion, state: "unknown" as const, supportingEvidenceIds: [] } : criterion);
      const status = goal.status === "satisfied" && !this.hasSatisfiedCriteria({ ...goal, successCriteria }) ? "blocked" : goal.status;
      this.goals.set(goal.id, { ...goal, successCriteria, status, revision: goal.revision + 1, updatedAt: Date.now() });
    }
    return { ...invalidated, source: { ...invalidated.source } };
  }

  getGoalAnchor(goalId: GoalId): GoalAnchor {
    const goal = this.requireGoal(goalId);
    return { goalId, objective: goal.objective,
      constraints: goal.constraints.filter((constraint) => constraint.hard).map((constraint) => constraint.text),
      unresolvedCriteria: goal.successCriteria.filter((criterion) => criterion.required && criterion.state !== "satisfied").map((criterion) => criterion.statement),
      blockers: [...goal.blockers] };
  }

  recordArtifact(input: ArtifactInput): Artifact {
    this.validateProducer(input.taskId, input.workerId);
    const artifact: Artifact = {
      ...input,
      id: id<"ArtifactId">("artifact"),
      worldId: this.id,
      createdAt: Date.now(),
    };
    this.artifacts.set(artifact.id, artifact);
    return { ...artifact };
  }

  appendEvent(input: EventInput): WorldEvent {
    if (input.workerId) this.requireWorker(input.workerId);
    if (input.taskId) this.requireTask(input.taskId);
    const resource = input.resourceId ? this.resources.get(input.resourceId) : undefined;
    if (input.resourceId && !resource) throw new Error("Resource does not exist in this world");
    if (input.workerId && input.taskId) this.validateProducer(input.taskId, input.workerId);
    if (resource && !this.resourceMatchesAttribution(resource, input)) {
      throw new Error("Resource owner does not match event attribution");
    }

    const event: WorldEvent = {
      ...input,
      id: id<"EventId">("event"),
      sequence: this.events.length + 1,
      worldId: this.id,
      occurredAt: Date.now(),
    };
    this.events.push(event);
    return { ...event };
  }

  inspect(): WorldSnapshot {
    return {
      world: { ...this.world },
      definitions: [...this.definitions.values()].map((definition) => ({
        ...definition,
        declaredCapabilities: definition.declaredCapabilities.map((capability) => ({ ...capability })),
      })),
      workers: [...this.workers.values()].map((worker) => ({ ...worker })),
      tasks: [...this.tasks.values()].map((task) => ({ ...task })),
      resources: [...this.resources.values()].map(copyResource),
      evidence: [...this.evidence.values()].map((record) => ({ ...record, source: { ...record.source } })),
      goals: [...this.goals.values()].map(copyGoal),
      assignments: [...this.assignments.values()].map(copyAssignment),
      artifacts: [...this.artifacts.values()].map((artifact) => ({ ...artifact })),
      events: this.events.map((event) => ({ ...event })),
    };
  }

  private requireWorker(workerId: WorkerId): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error("Worker does not exist in this world");
    return worker;
  }

  private requireTask(taskId: TaskId): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("Task does not exist in this world");
    return task;
  }

  private requireResource(resourceId: ResourceId): Resource {
    const resource = this.resources.get(resourceId);
    if (!resource) throw new Error("Resource does not exist in this world");
    return resource;
  }

  private requireGoal(goalId: GoalId): Goal {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error("Goal does not exist in this world");
    return goal;
  }

  private validateOwner(owner: ResourceOwner): void {
    if (owner.worldId !== this.id) throw new Error("Resource owner belongs to another world");
    if (owner.type === "worker") this.requireWorker(owner.workerId);
    if (owner.type === "task") this.requireTask(owner.taskId);
  }

  private validateProducer(taskId: TaskId, workerId: WorkerId): void {
    const task = this.requireTask(taskId);
    this.requireWorker(workerId);
    if (task.assignedWorkerId !== workerId) throw new Error("Task is not assigned to the producing worker");
  }

  private resourceMatchesAttribution(resource: Resource, event: EventInput): boolean {
    if (resource.owner.type === "world") return true;
    if (resource.owner.type === "worker") return event.workerId === resource.owner.workerId;
    return event.taskId === resource.owner.taskId;
  }
}

export function createWorld(identity?: World): InMemoryWorld {
  return new InMemoryWorld(identity);
}

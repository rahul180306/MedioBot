import type { MediobotDefinitionId, ResourceId, Task, TaskId, Worker, WorkerActivityState, WorkerId, WorldEvent } from "@mediobot-v2/domain";
import { InMemoryWorld } from "@mediobot-v2/domain";
import type { ResourceLease, TaskPriority } from "@mediobot-v2/contracts";
import { ResourceGovernor } from "./resource-governor.ts";
import { NotificationWindow, projectSupervision, type SupervisionNotice } from "./supervision.ts";
export { projectSupervision, type SupervisionNotice, type FailureCategory } from "./supervision.ts";

export interface EmitOptions {
  readonly toolName?: string;
  readonly toolInvocationId?: string;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly recoveryReason?: string;
  readonly message?: string;
  readonly activityState?: WorkerActivityState;
  readonly error?: string;
  readonly errorCode?: string;
  readonly failureCategory?: string;
  readonly durationMs?: number;
  readonly startedAt?: number;
  readonly isVerification?: boolean;
  readonly verificationStatus?: 'command-succeeded' | 'command-failed' | 'unverified';
  readonly exitCode?: number | null;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly recoveredFromExecution?: boolean;
  readonly outputLog?: string;
  readonly assignedWorkerId?: WorkerId;
  readonly assignedDefinitionId?: MediobotDefinitionId;
  readonly executionTaskId?: TaskId;
  readonly assignmentObjective?: string;
}

export interface RunContext {
  readonly signal: AbortSignal;
  emit(type: string, resourceId?: ResourceId, options?: string | EmitOptions): void;
  forward(event: WorldEvent): void;
}

export interface RunInput {
  readonly workerId: WorkerId;
  readonly taskId: TaskId;
  readonly resourceIds: ReadonlyArray<ResourceId>;
  readonly execute: (context: RunContext) => Promise<void>;
  readonly onEvent?: (event: WorldEvent) => void;
  /** Internal scheduler hint. TaskRunner marks an already-held lease; coordinators do not consume execution slots. */
  readonly admissionMode?: "execution" | "coordination" | "pre-admitted";
  readonly workspaceId?: string | null;
  readonly priority?: TaskPriority;
  /** Graph-owned control signals must unwind through runtime cleanup unchanged. */
  readonly isControlSignal?: (error: unknown) => boolean;
}

export type RunResult =
  | { readonly state: "completed" }
  | { readonly state: "paused" }
  | { readonly state: "waiting_approval" }
  | { readonly state: "cancelled" }
  | { readonly state: "failed"; readonly error: string };

/** Signals that a durable workflow checkpoint is waiting for an authorized approval. */
export class WorkerSuspensionError extends Error {
  readonly state = "waiting_approval" as const;
  constructor(message = "Execution is waiting for approval") {
    super(message);
    this.name = "WorkerSuspensionError";
  }
}

export interface WorkerExecutionContext {
  readonly world: InMemoryWorld;
  readonly definitionId: MediobotDefinitionId;
  readonly workerId: WorkerId;
  readonly taskId: TaskId;
  readonly goal: string;
  readonly options?: Readonly<Record<string, unknown>>;
  /** Task-scoped capability supplied only by Maestro for an explicitly authorized collaboration. */
  readonly specialistCommunication?: import("./durable.ts").SpecialistCommunicationPort;
}

export interface WorkerExecutionPlan {
  readonly resourceIds: ReadonlyArray<ResourceId>;
  readonly execute: (context: RunContext) => Promise<void>;
  readonly isControlSignal?: (error: unknown) => boolean;
}

export type WorkerExecutionAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: "not-configured" | "unavailable" };

/**
 * A synchronous capability-owned plan for one task. Resources registered for the
 * supplied task/worker are submission-scoped; unused registrations are released
 * on settlement, including prepare/start failure. World-owned resources remain
 * the adapter's responsibility, as does disposal of external handles.
 */
export interface WorkerExecutionAdapter {
  prepare(context: WorkerExecutionContext): WorkerExecutionPlan;
  availability?(): WorkerExecutionAvailability;
}

export class TaskSubmissionError extends Error {
  readonly reason: "not-executable" | "not-configured";
  constructor(reason: "not-executable" | "not-configured") {
    super(reason === "not-configured" ? "Mediobot execution is not configured" : "Mediobot definition is not executable");
    this.name = "TaskSubmissionError";
    this.reason = reason;
  }
}

export interface SubmittedTask {
  readonly task: Task;
  readonly workers: ReadonlyArray<Worker>;
  readonly result: Promise<RunResult>;
}

export interface TaskCreatedNotice {
  readonly task: Task;
  readonly workers: ReadonlyArray<Worker>;
}

interface ActiveRun {
  readonly workerId: WorkerId;
  readonly controller: AbortController;
  readonly onEvent?: (event: WorldEvent) => void;
  readonly workspaceId: string | null;
  readonly priority: TaskPriority;
  admissionLease?: ResourceLease;
  yieldingAdmission?: boolean;
}

export interface WorkerRuntimeOptions {
  /** Notification seam only; observers cannot control execution or trigger automatic retries. */
  readonly onSupervision?: (notice: SupervisionNotice) => void | Promise<void>;
  /** Per-runtime limit, not shared across runtimes using the same World. Defaults to 4. */
  readonly maxConcurrentExecutions?: number;
  /** Optional Phase 4 Resource Governor for fair queuing, backpressure, and hardware management. */
  readonly resourceGovernor?: ResourceGovernor;
}

export class RuntimeCapacityError extends Error {
  readonly maxConcurrentExecutions: number;

  constructor(maxConcurrentExecutions: number) {
    super(`Runtime execution capacity reached (${maxConcurrentExecutions})`);
    this.name = "RuntimeCapacityError";
    this.maxConcurrentExecutions = maxConcurrentExecutions;
  }
}

export class WorkerRuntime {
  private readonly activeRuns = new Map<TaskId, ActiveRun>();
  private readonly resourceLeases = new Map<ResourceId, TaskId>();
  private readonly world: InMemoryWorld;
  private readonly maxConcurrentExecutions: number;
  private readonly onSupervision?: WorkerRuntimeOptions["onSupervision"];
  readonly resourceGovernor?: ResourceGovernor;
  private readonly wakes = new NotificationWindow();
  private readonly notifications = new NotificationWindow();
  private readonly supervisionByTask = new Map<TaskId, SupervisionNotice[]>();

  constructor(world: InMemoryWorld, options: WorkerRuntimeOptions = {}) {
    const limit = options.maxConcurrentExecutions === undefined ? 4 : options.maxConcurrentExecutions;
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("maxConcurrentExecutions must be a finite positive integer");
    }
    this.world = world;
    this.maxConcurrentExecutions = limit;
    this.onSupervision = options.onSupervision;
    this.resourceGovernor = options.resourceGovernor;
  }

  activeTaskIds(): ReadonlyArray<TaskId> {
    return [...this.activeRuns.keys()];
  }

  /** Bounded, read-only failure attention for the owning workflow to reconcile. */
  getSupervisionNotices(taskIds: ReadonlyArray<TaskId>): ReadonlyArray<SupervisionNotice> {
    return taskIds.flatMap(taskId => (this.supervisionByTask.get(taskId) ?? []).map(notice => ({
      ...notice,
      event: { ...notice.event },
    })));
  }

  cancel(taskId: TaskId): void {
    const run = this.activeRuns.get(taskId);
    if (!run) throw new Error("Task is not running");
    const taskState = this.world.inspect().tasks.find((task) => task.id === taskId)?.state;
    if (taskState !== "running" && taskState !== "assigned") {
      throw new Error("Task is not running");
    }
    if (run.controller.signal.aborted) return;
    run.controller.abort();
    this.appendEvent({ type: "task.cancel-requested", taskId, workerId: run.workerId }, run.onEvent);
  }

  /** Temporarily returns this task's execution slot while it waits on bounded delegated work. */
  async withYieldedExecutionSlot<T>(taskId: TaskId, operation: () => Promise<T>): Promise<T> {
    const run = this.activeRuns.get(taskId);
    const governor = this.resourceGovernor;
    if (!run || !governor || !run.admissionLease) return operation();
    if (run.yieldingAdmission) throw new Error("Execution admission is already yielded for this task.");
    run.yieldingAdmission = true;
    governor.releaseLease(run.admissionLease.id);
    run.admissionLease = undefined;
    try {
      return await operation();
    } finally {
      if (!run.controller.signal.aborted && this.activeRuns.get(taskId) === run) {
        run.admissionLease = await governor.requestTaskAdmission({ taskId, workspaceId: run.workspaceId,
          priority: run.priority, signal: run.controller.signal });
      }
      run.yieldingAdmission = false;
    }
  }

  async run(input: RunInput): Promise<RunResult> {
    // Callers and synchronous observers may retain and mutate the original array.
    input = { ...input, resourceIds: [...input.resourceIds] };
    const observer = input.onEvent;
    const delivered = new NotificationWindow();
    input = { ...input, onEvent: (event) => {
      if (delivered.accept(event.id)) observer?.(event);
    } };
    this.validateRun(input);
    if (!this.resourceGovernor && this.activeRuns.size >= this.maxConcurrentExecutions) {
      throw new RuntimeCapacityError(this.maxConcurrentExecutions);
    }
    const controller = new AbortController();
    const activeRun: ActiveRun = { workerId: input.workerId, controller, onEvent: input.onEvent,
      workspaceId: input.workspaceId ?? null, priority: input.priority ?? "background" };
    this.activeRuns.set(input.taskId, activeRun);
    for (const resourceId of input.resourceIds) this.resourceLeases.set(resourceId, input.taskId);

    try {
      if (this.resourceGovernor && input.admissionMode !== "coordination" && input.admissionMode !== "pre-admitted") {
        try {
          activeRun.admissionLease = await this.resourceGovernor.requestTaskAdmission({ taskId: input.taskId,
            workspaceId: activeRun.workspaceId, priority: activeRun.priority, signal: controller.signal });
        } catch (error) {
          const state = controller.signal.aborted ? "cancelled" : "failed";
          const task = this.world.inspect().tasks.find((candidate) => candidate.id === input.taskId);
          if (task && (task.state === "assigned" || task.state === "running")) this.world.setTaskState(input.taskId, state);
          this.appendEvent({ type: `task.${state}`, workerId: input.workerId, taskId: input.taskId,
            ...(state === "failed" ? { error: error instanceof Error ? error.message : String(error) } : {}) }, input.onEvent);
          return state === "failed" ? { state, error: error instanceof Error ? error.message : String(error) } : { state };
        }
      }
      controller.signal.throwIfAborted();
      this.world.setWorkerState(input.workerId, "busy");
      this.world.setTaskState(input.taskId, "running");
      // Publish the entire acquisition before invoking any user code. Other
      // runtimes share world state, not this runtime's local lease map.
      for (const resourceId of input.resourceIds) this.world.setResourceState(resourceId, "in-use");
      this.appendEvent({ type: "task.started", workerId: input.workerId, taskId: input.taskId }, input.onEvent);
      for (const resourceId of input.resourceIds) {
        this.appendEvent({ type: "resource.acquired", workerId: input.workerId, taskId: input.taskId, resourceId }, input.onEvent);
      }

      let result: RunResult = { state: "failed", error: "Execution did not produce an outcome" };
      let controlSignal: unknown;
      try {
        controller.signal.throwIfAborted();
        await input.execute({
          signal: controller.signal,
          emit: (type, resourceId, options) => {
            const extra = typeof options === "string" ? { toolName: options } : (options ?? {});
            this.appendEvent({
              type,
              workerId: input.workerId,
              taskId: input.taskId,
              resourceId,
              ...extra,
            }, input.onEvent);
          },
          forward: (event) => {
            if (event.worldId === this.world.id) {
              this.supervise(event);
              try { input.onEvent?.({ ...event }); } catch { /* Event observers cannot change execution outcome. */ }
            }
          },
        });
        // Some adapters can finish synchronously after cancellation was
        // requested (for example, immediately before a side-effect boundary).
        // A cancellation request wins unless execution already threw.
        result = controller.signal.aborted ? { state: "cancelled" } : { state: "completed" };
      } catch (error) {
        // Graph interrupts are also worker suspensions. Preserve the graph
        // control signal so LangGraph can checkpoint its interrupt payload.
        if (input.isControlSignal?.(error)) controlSignal = error;
        else if (error instanceof WorkerSuspensionError) result = { state: "waiting_approval" };
        else {
          result = controller.signal.aborted
          ? { state: "cancelled" }
          : { state: "failed", error: error instanceof Error ? error.message : String(error) };
        }
      }

      // Leave task state nonterminal while the graph checkpoints the interrupt;
      // always release worker/resource leases in the surrounding finally block.
      if (controlSignal !== undefined) throw controlSignal;

      this.world.setTaskState(input.taskId, result.state);
      this.appendEvent({
        type: `task.${result.state}`,
        workerId: input.workerId,
        taskId: input.taskId,
        ...(result.state === "failed" && result.error ? { error: result.error } : {}),
      }, input.onEvent);
      return result;
    } finally {
      // Keep Governor reservations until the worker has actually settled. This
      // also completes any remaining task-owned subprocess cleanup before reuse.
      if (this.resourceGovernor) await this.resourceGovernor.releaseAllTaskResources(input.taskId).catch(() => {});
      for (const resourceId of input.resourceIds) {
        this.world.setResourceState(resourceId, "released");
        this.resourceLeases.delete(resourceId);
      }
      this.world.setWorkerState(input.workerId, "idle");
      this.activeRuns.delete(input.taskId);
      for (const resourceId of input.resourceIds) {
        this.appendEvent({ type: "resource.released", workerId: input.workerId, taskId: input.taskId, resourceId }, input.onEvent);
      }
    }
  }

  /** Append a runtime fact once; forwarding existing facts must not use this method. */
  appendEvent(input: Parameters<InMemoryWorld["appendEvent"]>[0], observer?: (event: WorldEvent) => void): void {
    const event = this.world.appendEvent(input);
    this.supervise(event);
    try { observer?.(event); } catch { /* event observers cannot change execution outcome */ }
  }

  private supervise(event: WorldEvent): void {
    const notice = projectSupervision(event);
    if (notice.disposition === "wake") {
      // Same task/category is one incident within the bounded notification window.
      const key = JSON.stringify([event.worldId, event.taskId, event.workerId,
        event.taskId ? undefined : event.id, notice.priority, "category" in notice ? notice.category : notice.reason]);
      if (!this.wakes.accept(key)) return;
      if (event.taskId) {
        const notices = this.supervisionByTask.get(event.taskId) ?? [];
        notices.push(notice);
        if (notices.length > 64) notices.splice(0, notices.length - 64);
        this.supervisionByTask.set(event.taskId, notices);
        if (this.supervisionByTask.size > 512) this.supervisionByTask.delete(this.supervisionByTask.keys().next().value!);
      }
    }
    if (!this.onSupervision || !this.notifications.accept(event.id)) return;
    try { void Promise.resolve(this.onSupervision(notice)).catch(() => {}); } catch { /* advisory observer */ }
  }

  private validateRun(input: RunInput): void {
    const snapshot = this.world.inspect();
    const task = snapshot.tasks.find((candidate) => candidate.id === input.taskId);
    const worker = snapshot.workers.find((candidate) => candidate.id === input.workerId);
    if (!task || task.assignedWorkerId !== input.workerId) throw new Error("Task is not assigned to this worker");
    if (task.state !== "assigned") throw new Error("Task must be assigned and not previously run");
    if (!worker) throw new Error("Worker does not exist in this world");
    if (typeof input.execute !== "function") throw new Error("Execution plan must provide an execute function");
    if (worker.state !== "idle") throw new Error("Worker is not idle");
    if (this.activeRuns.has(input.taskId)) throw new Error("Task is already running");
    if ([...this.activeRuns.values()].some((run) => run.workerId === input.workerId)) {
      throw new Error("Worker is already running a task");
    }
    if (new Set(input.resourceIds).size !== input.resourceIds.length) throw new Error("Resource is listed more than once");
    for (const resourceId of input.resourceIds) {
      if (this.resourceLeases.has(resourceId)) throw new Error("Resource is already in use");
      const resource = snapshot.resources.find((candidate) => candidate.id === resourceId);
      if (!resource) throw new Error("Resource does not exist in this world");
      if (resource.state === "in-use") throw new Error("Resource is already in use");
      const owner = this.world.getResourceOwner(resourceId);
      const isOwnedByRun = owner.type === "world"
        || (owner.type === "worker" && owner.workerId === input.workerId)
        || (owner.type === "task" && owner.taskId === input.taskId);
      if (!isOwnedByRun) throw new Error("Resource is not owned by this worker or task");
    }
  }
}

/** Generic product submission seam. Lifecycle and resource leases remain in WorkerRuntime. */
export class RuntimeTaskSubmission {
  private readonly world: InMemoryWorld;
  private readonly runtime: WorkerRuntime;
  private readonly adapters = new Map<MediobotDefinitionId, WorkerExecutionAdapter>();
  private readonly pendingControllers = new Map<TaskId, AbortController>();
  readonly resourceGovernor?: ResourceGovernor;

  constructor(world: InMemoryWorld, runtime: WorkerRuntime, options?: { readonly resourceGovernor?: ResourceGovernor }) {
    this.world = world;
    this.runtime = runtime;
    this.resourceGovernor = options?.resourceGovernor ?? runtime.resourceGovernor;
  }

  registerAdapter(definitionId: MediobotDefinitionId, adapter: WorkerExecutionAdapter): void {
    if (!this.world.inspect().definitions.some((definition) => definition.id === definitionId)) {
      throw new Error("Mediobot definition does not exist in this world");
    }
    if (this.adapters.has(definitionId)) throw new Error("An execution adapter is already registered for this definition");
    this.adapters.set(definitionId, adapter);
  }

  availability(definitionId: MediobotDefinitionId): WorkerExecutionAvailability {
    const definition = this.world.inspect().definitions.find(candidate => candidate.id === definitionId);
    if (!definition || definition.lifecycleState !== "active") return { available: false, reason: "unavailable" };
    const adapter = this.adapters.get(definitionId);
    if (!adapter) return { available: false, reason: "unavailable" };
    return adapter.availability?.() ?? { available: true };
  }

  submit(input: {
    readonly definitionId: MediobotDefinitionId;
    readonly goal: string;
    readonly taskId?: TaskId;
    readonly parentTaskId?: TaskId;
    readonly options?: Readonly<Record<string, unknown>>;
    readonly onCreated?: (notice: TaskCreatedNotice) => void | Promise<void>;
    readonly onEvent?: (event: WorldEvent) => void;
  }): SubmittedTask {
    const { definitionId, goal, options, onCreated, onEvent } = input;
    const adapter = this.adapters.get(definitionId);
    if (!adapter) throw new TaskSubmissionError("not-executable");
    const availability = this.availability(definitionId);
    if (!availability.available) {
      throw new TaskSubmissionError("reason" in availability && availability.reason === "not-configured" ? "not-configured" : "not-executable");
    }
    if (!goal.trim()) throw new Error("A task goal is required");

    const worker = this.world.spawnWorker(definitionId);
    const workerId = worker.id;
    const task = this.world.assignTask(this.world.createTask(goal, input.parentTaskId, input.taskId).id, workerId);
    const taskId = task.id;
    const taskGoal = task.goal;
    const cancellation = new AbortController();
    this.pendingControllers.set(taskId, cancellation);
    let createdReady: Promise<void> | undefined;
    try {
      const created = onCreated?.({ task: { ...task }, workers: [{ ...worker }] });
      if (created && typeof created.then === "function") createdReady = Promise.resolve(created);
    } catch (error) { createdReady = Promise.reject(error); }
    const existingResources = new Set(this.world.inspect().resources.map((resource) => resource.id));
    const taskDefinitionRole = this.world.inspect().definitions.find((definition) => definition.id === definitionId)?.role;
    const isCoordinator = taskDefinitionRole === "orchestration";
    const cleanup = () => {
      // Never roll back a whole-world snapshot: prepare can reenter submission.
      // Only unused registrations owned by these fresh identities belong here.
      const resources = this.world.inspect().resources.filter((resource) => !existingResources.has(resource.id)
        && resource.state === "available"
        && ((resource.owner.type === "worker" && resource.owner.workerId === workerId)
          || (resource.owner.type === "task" && resource.owner.taskId === taskId)));
      for (const resource of resources) this.world.setResourceState(resource.id, "released");
      for (const resource of resources) {
        this.runtime.appendEvent({ type: "resource.released", workerId, taskId, resourceId: resource.id }, onEvent);
      }
    };
    const result = (async (): Promise<RunResult> => {
      let admissionLease: ResourceLease | undefined;
      try {
        if (createdReady) await createdReady;
        cancellation.signal.throwIfAborted();
        if (this.resourceGovernor && !isCoordinator) {
          const priority = (options?.priority as TaskPriority) ?? "background";
          const workspaceId = typeof options?.workspaceId === "string" ? options.workspaceId : null;
          admissionLease = await this.resourceGovernor.requestTaskAdmission({
            taskId,
            workspaceId,
            priority,
            signal: cancellation.signal,
          });
        }
        cancellation.signal.throwIfAborted();
        const plan = adapter.prepare({ world: this.world, definitionId, workerId,
          taskId, goal: taskGoal, options });
        cancellation.signal.throwIfAborted();
        const running = this.runtime.run({ ...plan, workerId, taskId, onEvent, isControlSignal: plan.isControlSignal,
          admissionMode: isCoordinator ? "coordination" : admissionLease ? "pre-admitted" : "execution",
          workspaceId: typeof options?.workspaceId === "string" ? options.workspaceId : null,
          priority: (options?.priority as TaskPriority) ?? "background" });
        this.pendingControllers.delete(taskId);
        if (cancellation.signal.aborted) {
          try { this.runtime.cancel(taskId); } catch { /* The runtime may already have settled. */ }
        }
        return await running;
      } catch (error) {
        // A rejected start has acquired nothing. Do not overwrite a run started
        // by reentrant user code, or release resources held by that run.
        const current = this.world.inspect().tasks.find((candidate) => candidate.id === taskId);
        if (current?.state !== "assigned") throw error;
        const state = cancellation.signal.aborted ? "cancelled" : "failed";
        this.world.setTaskState(taskId, state);
        cleanup();
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.runtime.appendEvent({ type: `task.${state}`, workerId, taskId, ...(state === "failed" ? { error: errorMsg } : {}) }, onEvent);
        return state === "failed" ? { state, error: errorMsg } : { state };
      } finally {
        this.pendingControllers.delete(taskId);
        if (admissionLease && this.resourceGovernor) {
          this.resourceGovernor.releaseLease(admissionLease.id);
        }
        cleanup();
      }
    })();
    return { task, workers: [worker], result };
  }

  cancel(taskId: TaskId): void {
    const pending = this.pendingControllers.get(taskId);
    if (pending) { pending.abort(); return; }
    this.runtime.cancel(taskId);
  }
}

export * from "./durable.ts";
export * from "./resource-telemetry.ts";
export * from "./subprocess-supervisor.ts";
export * from "./resource-governor.ts";
export * from "./crawl4ai-runtime.ts";

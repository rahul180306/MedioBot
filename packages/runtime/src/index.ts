import type { ResourceId, TaskId, WorkerId } from "@mediobot-v2/domain";
import { InMemoryWorld } from "@mediobot-v2/domain";

export interface RunContext {
  readonly signal: AbortSignal;
  emit(type: string, resourceId?: ResourceId): void;
}

export interface RunInput {
  readonly workerId: WorkerId;
  readonly taskId: TaskId;
  readonly resourceIds: ReadonlyArray<ResourceId>;
  readonly execute: (context: RunContext) => Promise<void>;
}

export type RunResult =
  | { readonly state: "completed" }
  | { readonly state: "cancelled" }
  | { readonly state: "failed"; readonly error: string };

interface ActiveRun {
  readonly workerId: WorkerId;
  readonly controller: AbortController;
}

export class WorkerRuntime {
  private readonly activeRuns = new Map<TaskId, ActiveRun>();
  private readonly resourceLeases = new Map<ResourceId, TaskId>();
  private readonly world: InMemoryWorld;

  constructor(world: InMemoryWorld) {
    this.world = world;
  }

  activeTaskIds(): ReadonlyArray<TaskId> {
    return [...this.activeRuns.keys()];
  }

  cancel(taskId: TaskId): void {
    const run = this.activeRuns.get(taskId);
    if (!run) throw new Error("Task is not running");
    run.controller.abort();
  }

  async run(input: RunInput): Promise<RunResult> {
    this.validateRun(input);
    const controller = new AbortController();
    this.activeRuns.set(input.taskId, { workerId: input.workerId, controller });
    for (const resourceId of input.resourceIds) this.resourceLeases.set(resourceId, input.taskId);

    try {
      this.world.setWorkerState(input.workerId, "busy");
      this.world.setTaskState(input.taskId, "running");
      this.world.appendEvent({ type: "task.started", workerId: input.workerId, taskId: input.taskId });
      for (const resourceId of input.resourceIds) {
        this.world.setResourceState(resourceId, "in-use");
        this.world.appendEvent({ type: "resource.acquired", workerId: input.workerId, taskId: input.taskId, resourceId });
      }

      let result: RunResult;
      try {
        await input.execute({
          signal: controller.signal,
          emit: (type, resourceId) => {
            this.world.appendEvent({ type, workerId: input.workerId, taskId: input.taskId, resourceId });
          },
        });
        result = controller.signal.aborted ? { state: "cancelled" } : { state: "completed" };
      } catch (error) {
        result = controller.signal.aborted
          ? { state: "cancelled" }
          : { state: "failed", error: error instanceof Error ? error.message : String(error) };
      }

      this.world.setTaskState(input.taskId, result.state);
      this.world.appendEvent({ type: `task.${result.state}`, workerId: input.workerId, taskId: input.taskId });
      return result;
    } finally {
      for (const resourceId of input.resourceIds) {
        this.world.setResourceState(resourceId, "released");
        this.world.appendEvent({ type: "resource.released", workerId: input.workerId, taskId: input.taskId, resourceId });
        this.resourceLeases.delete(resourceId);
      }
      this.world.setWorkerState(input.workerId, "idle");
      this.activeRuns.delete(input.taskId);
    }
  }

  private validateRun(input: RunInput): void {
    const snapshot = this.world.inspect();
    const task = snapshot.tasks.find((candidate) => candidate.id === input.taskId);
    const worker = snapshot.workers.find((candidate) => candidate.id === input.workerId);
    if (!task || task.assignedWorkerId !== input.workerId) throw new Error("Task is not assigned to this worker");
    if (task.state !== "assigned") throw new Error("Task must be assigned and not previously run");
    if (!worker) throw new Error("Worker does not exist in this world");
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

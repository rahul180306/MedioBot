type Id<Name extends string> = string & { readonly __brand: Name };

export type WorldId = Id<"WorldId">;
export type MediobotDefinitionId = Id<"MediobotDefinitionId">;
export type WorkerId = Id<"WorkerId">;
export type TaskId = Id<"TaskId">;
export type ResourceId = Id<"ResourceId">;
export type EvidenceId = Id<"EvidenceId">;
export type ArtifactId = Id<"ArtifactId">;
export type EventId = Id<"EventId">;

export type WorkerState = "idle" | "busy" | "stopped";
export type TaskState = "created" | "assigned" | "running" | "completed" | "failed" | "cancelled";
export type ResourceState = "available" | "in-use" | "released";
export type ResourceKind =
  | "workspace"
  | "browser-context"
  | "browser-page"
  | "terminal"
  | "model-session"
  | "perception-state";

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

export interface Evidence {
  readonly id: EvidenceId;
  readonly worldId: WorldId;
  readonly taskId: TaskId;
  readonly workerId: WorkerId;
  readonly source: EvidenceSource;
  readonly content: string;
  readonly createdAt: number;
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
  readonly occurredAt: number;
}

export interface WorldSnapshot {
  readonly world: World;
  readonly definitions: ReadonlyArray<MediobotDefinition>;
  readonly workers: ReadonlyArray<Worker>;
  readonly tasks: ReadonlyArray<Task>;
  readonly resources: ReadonlyArray<Resource>;
  readonly evidence: ReadonlyArray<Evidence>;
  readonly artifacts: ReadonlyArray<Artifact>;
  readonly events: ReadonlyArray<WorldEvent>;
}

export interface MediobotDefinitionInput {
  readonly name: string;
  readonly role: string;
  readonly version: string;
  readonly instructions: string;
  readonly declaredCapabilities: ReadonlyArray<Capability>;
}

export interface ResourceInput {
  readonly kind: ResourceKind;
  readonly owner: ResourceOwner;
}

export interface EvidenceInput {
  readonly taskId: TaskId;
  readonly workerId: WorkerId;
  readonly source: EvidenceSource;
  readonly content: string;
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

export class InMemoryWorld {
  readonly id: WorldId;

  private readonly world: World;
  private readonly definitions = new Map<MediobotDefinitionId, MediobotDefinition>();
  private readonly workers = new Map<WorkerId, Worker>();
  private readonly tasks = new Map<TaskId, Task>();
  private readonly resources = new Map<ResourceId, Resource>();
  private readonly evidence = new Map<EvidenceId, Evidence>();
  private readonly artifacts = new Map<ArtifactId, Artifact>();
  private readonly events: WorldEvent[] = [];

  constructor() {
    this.id = id<"WorldId">("world");
    this.world = { id: this.id, createdAt: Date.now() };
  }

  registerMediobotDefinition(input: MediobotDefinitionInput): MediobotDefinition {
    const definition: MediobotDefinition = {
      ...input,
      id: id<"MediobotDefinitionId">("definition"),
      declaredCapabilities: input.declaredCapabilities.map((capability) => ({ ...capability })),
    };
    this.definitions.set(definition.id, definition);
    return { ...definition, declaredCapabilities: definition.declaredCapabilities.map((capability) => ({ ...capability })) };
  }

  spawnWorker(definitionId: MediobotDefinitionId): Worker {
    if (!this.definitions.has(definitionId)) throw new Error("Mediobot definition does not exist in this world");
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
    const updated = { ...worker, state };
    this.workers.set(workerId, updated);
    return { ...updated };
  }

  createTask(goal: string): Task {
    const task: Task = {
      id: id<"TaskId">("task"),
      worldId: this.id,
      goal,
      state: "created",
      assignedWorkerId: null,
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
    const updated = { ...resource, state };
    this.resources.set(resourceId, updated);
    return copyResource(updated);
  }

  recordEvidence(input: EvidenceInput): Evidence {
    this.validateProducer(input.taskId, input.workerId);
    const record: Evidence = {
      ...input,
      source: { ...input.source },
      id: id<"EvidenceId">("evidence"),
      worldId: this.id,
      createdAt: Date.now(),
    };
    this.evidence.set(record.id, record);
    return { ...record, source: { ...record.source } };
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

export function createWorld(): InMemoryWorld {
  return new InMemoryWorld();
}

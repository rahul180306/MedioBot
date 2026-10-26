import { createWorld, type MediobotDefinitionId, type TaskId } from "@mediobot-v2/domain";
import { RuntimeTaskSubmission, WorkerRuntime, type WorkerExecutionAdapter } from "@mediobot-v2/runtime";
import { LocalProjectCatalog } from "../../src/projects.ts";
import { normalizeProductEvent } from "../../src/composition.ts";
import type { CommandCenterComposition, DefinitionView, ProductEvent, TaskView } from "../../src/contracts.ts";

export function createFakeComposition(options: {
  readonly responseText?: string;
  readonly workspaceRoot?: string;
  readonly emitSynchronously?: boolean;
  readonly holdExecution?: boolean;
  readonly holdAfterCancel?: Promise<void>;
  readonly onExecutionStarted?: (taskId: TaskId) => void;
  readonly onCancellationObserved?: (taskId: TaskId) => void;
} = {}): CommandCenterComposition {
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  const submission = new RuntimeTaskSubmission(world, runtime);
  const projects = new LocalProjectCatalog(options.workspaceRoot);

  const maestro = world.registerMediobotDefinition({
    name: "Maestro",
    role: "Team orchestration",
    version: "0.1.0",
    instructions: "Deterministic fake Maestro for tests.",
    declaredCapabilities: [],
  });
  const vision = world.registerMediobotDefinition({
    name: "Vision",
    role: "visual-browser",
    version: "0.1.0",
    instructions: "Fake Vision.",
    declaredCapabilities: [],
  });
  const cody = world.registerMediobotDefinition({
    name: "Cody",
    role: "Software engineering",
    version: "0.1.0",
    instructions: "Fake Cody.",
    declaredCapabilities: [],
  });

  const taskEvents = new Map<TaskId, ProductEvent[]>();
  const subscribers = new Map<TaskId, Set<(event: ProductEvent) => void>>();
  const taskErrors = new Map<TaskId, TaskView["error"]>();
  const publish = (rawEvent: ProductEvent) => {
    const event = normalizeProductEvent(rawEvent);
    const history = taskEvents.get(event.taskId) ?? [];
    history.push(event);
    if (history.length > 200) history.splice(0, history.length - 200);
    taskEvents.set(event.taskId, history);
    for (const listener of subscribers.get(event.taskId) ?? []) listener(event);
  };

  const fakeAdapter: WorkerExecutionAdapter = {
    prepare(context) {
      if (options.emitSynchronously) {
        publish({ id: crypto.randomUUID(), type: "task.started", worldId: world.id, taskId: context.taskId,
          occurredAt: Date.now(), message: "Task started synchronously." });
      }
      return {
        resourceIds: [],
        execute: async (runContext) => {
          if (!options.emitSynchronously) {
            publish({ id: crypto.randomUUID(), type: "task.started", worldId: world.id, taskId: context.taskId,
              occurredAt: Date.now(), message: "Task started." });
          }
          options.onExecutionStarted?.(context.taskId);
          if (options.holdExecution) {
            if (!runContext.signal.aborted) {
              await new Promise<void>((resolve) => runContext.signal.addEventListener("abort", () => resolve(), { once: true }));
            }
            options.onCancellationObserved?.(context.taskId);
            await options.holdAfterCancel;
            if (runContext.signal.aborted) {
              publish({ id: crypto.randomUUID(), type: "task.cancelled", worldId: world.id,
                taskId: context.taskId, workerId: context.workerId, occurredAt: Date.now() });
            }
            return;
          }
          publish({ id: crypto.randomUUID(), type: "maestro.responded", worldId: world.id, taskId: context.taskId,
            workerId: context.workerId, workerName: "Maestro", occurredAt: Date.now(),
            message: options.responseText ?? "Hello from deterministic fake Mediobot" });
          publish({ id: crypto.randomUUID(), type: "task.completed", worldId: world.id, taskId: context.taskId, occurredAt: Date.now() });
        },
      };
    },
    availability: () => ({ available: true }),
  };

  submission.registerAdapter(maestro.id, fakeAdapter);
  submission.registerAdapter(vision.id, fakeAdapter);

  const definitions: DefinitionView[] = [
    { id: maestro.id, name: "Maestro", group: "orchestrator", role: "Team orchestration", summary: "Fake Maestro", availability: "available", executable: true },
    { id: cody.id, name: "Cody", group: "specialist", role: "Software engineering", summary: "Fake Cody", availability: "development", executable: false },
    { id: vision.id, name: "Vision", group: "specialist", role: "Browser and visual work", summary: "Fake Vision", availability: "available", executable: true },
  ];
  const snapshotTask = (taskId: TaskId): TaskView | undefined => {
    const snapshot = world.inspect();
    const task = snapshot.tasks.find((item) => item.id === taskId);
    if (!task) return undefined;
    return { id: task.id, worldId: task.worldId, goal: task.goal, state: task.state, workers: [], events: [...(taskEvents.get(taskId) ?? [])] };
  };

  return {
    world,
    submission,
    definitions,
    visionDefinitionId: vision.id,
    maestroDefinitionId: maestro.id,
    codyDefinitionId: cody.id,
    projects,
    taskEvents,
    subscribers,
    taskErrors,
    publish,
    snapshotTask,
    submit(definitionId: MediobotDefinitionId, goal: string, submitOptions?: Readonly<Record<string, unknown>>, onBeforeEmit?: (taskId: TaskId) => void) {
      let created = false;
      const submitted = submission.submit({
        definitionId,
        goal,
        options: submitOptions,
        onCreated: ({ task }) => {
          created = true;
          onBeforeEmit?.(task.id);
          publish({ id: crypto.randomUUID(), type: "task.created", worldId: task.worldId, taskId: task.id, occurredAt: Date.now() });
        },
      });
      if (!created && onBeforeEmit) onBeforeEmit(submitted.task.id);
      if (!created) publish({ id: crypto.randomUUID(), type: "task.created", worldId: submitted.task.worldId,
        taskId: submitted.task.id, occurredAt: Date.now() });
      return { taskId: submitted.task.id, result: submitted.result };
    },
    cancel(taskId) { submission.cancel(taskId); },
    mapWorldEvent: () => {},
    mapVisionProgress: () => {},
  };
}

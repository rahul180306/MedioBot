import type { MediobotDefinitionId, TaskId, WorkerId, WorldEvent } from "@mediobot-v2/domain";
import type { RuntimeTaskSubmission } from "@mediobot-v2/runtime";
import type { VisionProgressEvent } from "@mediobot-v2/vision";
import type { MaestroDecision } from "@mediobot-v2/maestro";
import type { FileDiff } from "./types/index.ts";

export type ProductEventType = "task.created" | "task.started" | "task.pause_requested" | "task.paused" | "task.resumed" | "task.completed" | "task.failed" | "task.cancelled"
  | "maestro.responded"
  | "worker.started" | "worker.assigned" | "worker.message" | "worker.progress" | "worker.completed" | "worker.cancelled" | "worker.failed"
  | "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled" | "file.changed"
  | "approval.required" | "approval.resolved"
  | "worker.observing" | "worker.action-selected" | "worker.action-verified"
  | "worker.finish-requested" | "worker.goal-verified";

export interface ProductEvent {
  readonly id: string;
  readonly type: ProductEventType;
  readonly worldId: string;
  readonly taskId: TaskId;
  readonly workerId?: WorkerId;
  readonly executionTaskId?: TaskId;
  readonly workerDefinitionId?: MediobotDefinitionId;
  readonly workerName?: string;
  readonly message?: string;
  readonly activityState?: import('@mediobot-v2/domain').WorkerActivityState;
  readonly toolName?: "filesystem.list" | "filesystem.read" | "filesystem.write" | "terminal.execute" | "web.search" | "web.crawl";
  readonly toolInvocationId?: string;
  readonly command?: string;
  /** Workspace-relative path only; never an absolute host path. */
  readonly workingDirectory?: string;
  readonly recoveryReason?: string;
  readonly failureCategory?: string;
  /** Safe OS error code (for example ENOENT); never raw command output. */
  readonly errorCode?: string;
  readonly recoveredFromExecution?: boolean;
  readonly durationMs?: number;
  readonly startedAt?: number;
  readonly isVerification?: boolean;
  readonly verificationStatus?: "command-succeeded" | "command-failed" | "unverified";
  readonly exitCode?: number | null;
  readonly terminationSignal?: string;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly diff?: FileDiff;
  readonly outputLog?: string;
  readonly occurredAt: number;
  readonly sequence?: number;
  readonly step?: number;
  readonly actionType?: "click" | "type" | "press" | "scroll" | "navigate" | "select" | "wait" | "finish";
  readonly outcome?: "action-effect-observed" | "no-effect" | "state-changed";
  readonly error?: { readonly code: "invalid_browser_action" | "execution_failed"; readonly message: string };
  readonly approval?: import("./types/index.ts").ApprovalRequestData;
}

export interface DefinitionView {
  readonly id: MediobotDefinitionId;
  readonly name: string;
  readonly group: "orchestrator" | "specialist";
  readonly role: string;
  readonly summary: string;
  readonly availability: "available" | "development" | "unavailable" | "not-configured";
  readonly executable: boolean;
  /** Server-derived indication that the registered adapter accepts direct client turns. */
  readonly directConversationAvailable?: boolean;
}

export interface WorkerView { readonly id: WorkerId; readonly taskId: TaskId; readonly definitionId: MediobotDefinitionId; readonly name: string; readonly state: string; }
export interface TaskView {
  readonly id: TaskId;
  readonly worldId: string;
  readonly goal: string;
  readonly state: string;
  /** Persistent organizational identity assigned to this task, independent of a process-local Worker instance. */
  readonly assignedMediobot?: { readonly id: MediobotDefinitionId; readonly name: string };
  readonly workers: ReadonlyArray<WorkerView>;
  readonly events: ReadonlyArray<ProductEvent>;
  readonly checkpoints?: ReadonlyArray<any>;
  readonly delegations?: ReadonlyArray<any>;
  readonly evidence?: ReadonlyArray<any>;
  readonly artifacts?: ReadonlyArray<{ readonly id: string; readonly taskId: string; readonly mediobotId: string; readonly workerId: string; readonly name: string;
    readonly reference: string; readonly contentHash: string; readonly createdAt: number; readonly updatedAt: number }>;
  readonly error?: { readonly code: "not-configured" | "execution-failed"; readonly message: string };
}

export interface CommandCenterComposition {
  readonly world: import("@mediobot-v2/domain").InMemoryWorld;
  readonly submission: RuntimeTaskSubmission;
  readonly definitions: ReadonlyArray<DefinitionView>;
  registerSpecialist?(input: { readonly name: string; readonly role: string; readonly version: string; readonly instructions: string;
    readonly capabilities?: ReadonlyArray<string> }): DefinitionView;
  setSpecialistLifecycle?(definitionId: MediobotDefinitionId, state: import("@mediobot-v2/domain").MediobotLifecycleState): DefinitionView;
  removeSpecialist?(definitionId: MediobotDefinitionId): void;
  readonly visionDefinitionId: MediobotDefinitionId;
  readonly maestroDefinitionId: MediobotDefinitionId;
  readonly codyDefinitionId: MediobotDefinitionId;
  readonly projects: import("./projects.ts").LocalProjectCatalog;
  readonly taskEvents: Map<TaskId, ProductEvent[]>;
  readonly subscribers: Map<TaskId, Set<(event: ProductEvent) => void>>;
  readonly taskErrors: Map<TaskId, TaskView["error"]>;
  readonly publish: (event: ProductEvent) => void;
  readonly getTaskEvents?: (taskId: TaskId) => Promise<ReadonlyArray<ProductEvent>>;
  readonly flushTaskEvents?: (taskId?: TaskId) => Promise<void>;
  decideMaestroTurn?(goal: string, options: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<MaestroDecision>;
  submit(definitionId: MediobotDefinitionId, goal: string, options?: Readonly<Record<string, unknown>>, onBeforeEmit?: (taskId: TaskId) => void): { readonly taskId: TaskId; readonly result: Promise<import("@mediobot-v2/runtime").RunResult> };
  resume?(taskId: TaskId, options?: Readonly<Record<string, unknown>>): Promise<{ readonly taskId: TaskId; readonly result: Promise<import("@mediobot-v2/runtime").RunResult> }>;
  pause?(taskId: TaskId): Promise<void>;
  /** Serialize approval resolution/resume and cancellation for one parent task family. */
  withTaskControlLock?<T>(taskId: TaskId, operation: () => Promise<T>): Promise<T>;
  isTaskActive?(taskId: TaskId): boolean;
  cancel(taskId: TaskId): void | Promise<void>;
  snapshotTask(taskId: TaskId): TaskView | undefined;
  getTaskView?(taskId: TaskId): Promise<TaskView | undefined>;
  mapWorldEvent(event: WorldEvent): void;
  mapVisionProgress(identity: { readonly definitionId: MediobotDefinitionId; readonly taskId: TaskId;
    readonly workerId: WorkerId }, event: VisionProgressEvent): void;
  readonly browserRuntime?: import("@mediobot-v2/vision").BrowserRuntime;
  readonly permissionEngine?: import("@mediobot-v2/tools").ToolPermissionEngine;
  readonly durableTaskEngine?: import("@mediobot-v2/runtime").DurableTaskEngine;
  readonly resourceGovernor?: import("@mediobot-v2/runtime").ResourceGovernor;
  readonly crawl4aiRuntime?: import("@mediobot-v2/runtime").Crawl4AiRuntime;
  shutdown?(): Promise<void>;
}

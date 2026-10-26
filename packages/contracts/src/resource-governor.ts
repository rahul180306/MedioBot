import type { TaskId } from "@mediobot-v2/domain";

export type TaskPriority = "interactive" | "background" | "batch";

export type ResourceCategory =
  | "execution-slot"
  | "model-request"
  | "browser-session"
  | "subprocess"
  | "memory";

export type MemoryPressureState = "normal" | "elevated" | "critical";

export interface ResourceLease {
  readonly id: string;
  readonly taskId: TaskId;
  readonly workspaceId: string | null;
  readonly category: ResourceCategory;
  readonly units: number;
  readonly acquiredAt: number;
  readonly expiresAt?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly released: boolean;
}

export interface ResourceBudget {
  readonly maxConcurrentTasks: number;
  readonly maxConcurrentTasksPerWorkspace: number;
  readonly maxConcurrentModelRequests: number;
  readonly maxConcurrentModelRequestsPerProvider: number;
  readonly maxConcurrentBrowserSessions: number;
  readonly maxConcurrentBrowserSessionsPerWorkspace: number;
  readonly maxConcurrentSubprocesses: number;
  readonly maxConcurrentSubprocessesPerWorkspace: number;
  readonly memoryPressureThresholdPercent: number;
}

export interface SystemResourceTelemetry {
  readonly platform: string;
  readonly cpuCount: number;
  readonly loadAverage1m: number;
  /** System-wide CPU busy percentage from per-core cumulative time deltas. Undefined until a valid sample exists. */
  readonly systemCpuPercent?: number;
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
  readonly usedMemoryPercent: number;
  readonly processRssBytes: number;
  readonly processHeapUsedBytes: number;
  readonly managedProcessTreeRssBytes?: number;
  readonly memoryPressureState: MemoryPressureState;
  readonly timestamp: number;
  readonly macDetails?: {
    readonly activeBytes: number;
    readonly inactiveBytes: number;
    readonly wiredBytes: number;
    readonly compressedBytes: number;
  };
}

export interface SubprocessRecord {
  readonly id: string;
  readonly pid: number;
  readonly command: string;
  readonly taskId: TaskId;
  readonly workspaceId: string | null;
  readonly startedAt: number;
  readonly pgid?: number;
}

export interface ResourceGovernorStatus {
  readonly telemetry: SystemResourceTelemetry;
  readonly activeLeases: {
    readonly executionSlots: number;
    readonly modelRequests: number;
    readonly browserSessions: number;
    readonly subprocesses: number;
  };
  readonly queuedTasksCount: number;
  readonly effectiveConcurrencyLimit: number;
  readonly memoryPressureState: MemoryPressureState;
  readonly workspaceAllocations: Readonly<Record<string, {
    readonly executionSlots: number;
    readonly subprocesses: number;
    readonly browserSessions: number;
  }>>;
  readonly budget?: ResourceBudget;
}

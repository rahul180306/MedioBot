import crypto from "node:crypto";
import os from "node:os";
import type { TaskId } from "@mediobot-v2/domain";
import type {
  MemoryPressureState,
  ResourceBudget,
  ResourceCategory,
  ResourceGovernorStatus,
  ResourceLease,
  SystemResourceTelemetry,
  TaskPriority,
} from "@mediobot-v2/contracts";
import { SystemResourceTelemetryCollector } from "./resource-telemetry.ts";
import { SubprocessSupervisor } from "./subprocess-supervisor.ts";

export interface ResourceGovernorOptions {
  readonly budget?: Partial<ResourceBudget>;
  readonly telemetryCollector?: SystemResourceTelemetryCollector;
  readonly subprocessSupervisor?: SubprocessSupervisor;
  readonly onDiagnostic?: (event: Record<string, unknown>) => void;
}

export interface ModelAdmissionPort {
  tryAcquire(attempt: {
    readonly taskId: string;
    readonly workspaceId?: string | null;
    readonly connectionId: string;
    readonly modelId: string;
  }): { readonly granted: true; readonly leaseId: string; readonly release: () => void } | { readonly granted: false; readonly retryAfterMs?: number };
  release(leaseId: string): void;
  subscribeCapacityChange(listener: () => void): () => void;
}

export interface AdmissionRequest {
  readonly taskId: TaskId;
  readonly workspaceId?: string | null;
  readonly priority?: TaskPriority;
  readonly signal?: AbortSignal;
}

interface QueuedEntry {
  readonly id: string;
  readonly taskId: TaskId;
  readonly workspaceId: string | null;
  readonly priority: TaskPriority;
  readonly requestedAt: number;
  readonly signal?: AbortSignal;
  readonly resolve: (lease: ResourceLease) => void;
  readonly reject: (error: Error) => void;
}

export function computeHardwareBudget(totalRamBytes = os.totalmem()): ResourceBudget {
  const gb = totalRamBytes / (1024 * 1024 * 1024);
  let maxTasks = 4;
  if (gb <= 8) {
    maxTasks = 2;
  } else if (gb <= 16) {
    maxTasks = 4;
  } else if (gb <= 32) {
    maxTasks = 8;
  } else {
    maxTasks = 12;
  }

  const maxTasksPerWorkspace = Math.max(1, Math.floor(maxTasks / 2));

  return {
    maxConcurrentTasks: maxTasks,
    maxConcurrentTasksPerWorkspace: maxTasksPerWorkspace,
    maxConcurrentModelRequests: Math.max(4, maxTasks * 2),
    maxConcurrentModelRequestsPerProvider: 4,
    maxConcurrentBrowserSessions: 2,
    maxConcurrentBrowserSessionsPerWorkspace: 1,
    maxConcurrentSubprocesses: Math.max(4, maxTasks * 2),
    maxConcurrentSubprocessesPerWorkspace: maxTasksPerWorkspace * 2,
    memoryPressureThresholdPercent: 75,
  };
}

export class ResourceGovernor {
  private readonly budget: ResourceBudget;
  private readonly telemetryCollector: SystemResourceTelemetryCollector;
  readonly subprocessSupervisor: SubprocessSupervisor;
  private readonly onDiagnostic?: (event: Record<string, unknown>) => void;

  private readonly activeLeases = new Map<string, ResourceLease>();
  private readonly queue: QueuedEntry[] = [];
  private readonly capacityListeners = new Set<() => void>();

  constructor(options: ResourceGovernorOptions = {}) {
    const baseBudget = computeHardwareBudget();
    this.budget = {
      ...baseBudget,
      ...options.budget,
    };
    this.telemetryCollector = options.telemetryCollector ?? new SystemResourceTelemetryCollector();
    this.subprocessSupervisor = options.subprocessSupervisor ?? new SubprocessSupervisor({
      maxConcurrentGlobal: this.budget.maxConcurrentSubprocesses,
      maxConcurrentPerWorkspace: this.budget.maxConcurrentSubprocessesPerWorkspace,
    });
    this.onDiagnostic = options.onDiagnostic;
  }

  get activeLeasesCount(): number {
    return this.activeLeases.size;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  getEffectiveConcurrencyLimit(): number {
    const telemetry = this.telemetryCollector.collect();
    if (telemetry.memoryPressureState === "critical") {
      return 1;
    }
    if (telemetry.memoryPressureState === "elevated" || (telemetry.systemCpuPercent !== undefined && telemetry.systemCpuPercent >= 90)) {
      return Math.max(1, Math.floor(this.budget.maxConcurrentTasks * 0.5));
    }
    return this.budget.maxConcurrentTasks;
  }

  activeCategoryCount(category: ResourceCategory): number {
    let count = 0;
    for (const lease of this.activeLeases.values()) {
      if (lease.category === category && !lease.released) {
        count += lease.units;
      }
    }
    return count;
  }

  activeCategoryCountForWorkspace(category: ResourceCategory, workspaceId: string | null): number {
    let count = 0;
    for (const lease of this.activeLeases.values()) {
      if (lease.category === category && lease.workspaceId === workspaceId && !lease.released) {
        count += lease.units;
      }
    }
    return count;
  }

  canAdmitTask(workspaceId: string | null, priority: TaskPriority = "background"): boolean {
    const effectiveLimit = this.getEffectiveConcurrencyLimit();
    const activeTasks = this.activeCategoryCount("execution-slot");
    if (activeTasks >= effectiveLimit) {
      return false;
    }

    if (workspaceId) {
      const activeInWorkspace = this.activeCategoryCountForWorkspace("execution-slot", workspaceId);
      if (activeInWorkspace >= this.budget.maxConcurrentTasksPerWorkspace) {
        return false;
      }
    }

    const telemetry = this.telemetryCollector.collect();
    if (telemetry.memoryPressureState === "critical" && priority !== "interactive") {
      return false;
    }

    return true;
  }

  async requestTaskAdmission(request: AdmissionRequest): Promise<ResourceLease> {
    const priority = request.priority ?? "background";
    const workspaceId = request.workspaceId ?? null;

    if (request.signal?.aborted) {
      throw new Error("Task admission aborted");
    }

    // Immediate admission check if queue is empty and capacity is available
    if (this.queue.length === 0 && this.canAdmitTask(workspaceId, priority)) {
      const lease = this.createLease(request.taskId, workspaceId, "execution-slot", 1, { priority });
      this.diagnostic({ event: "governor.admitted_immediate", taskId: request.taskId, priority, workspaceId });
      return lease;
    }

    // Queue entry
    return new Promise<ResourceLease>((resolve, reject) => {
      const entryId = crypto.randomUUID();
      let onAbort: (() => void) | undefined;

      const cleanup = () => {
        if (onAbort && request.signal) {
          request.signal.removeEventListener("abort", onAbort);
        }
      };

      if (request.signal) {
        onAbort = () => {
          const index = this.queue.findIndex((e) => e.id === entryId);
          if (index !== -1) {
            this.queue.splice(index, 1);
            this.diagnostic({ event: "governor.queue_aborted", taskId: request.taskId });
            reject(new Error("Task admission aborted while queued"));
          }
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.queue.push({
        id: entryId,
        taskId: request.taskId,
        workspaceId,
        priority,
        requestedAt: Date.now(),
        signal: request.signal,
        resolve: (lease) => {
          cleanup();
          resolve(lease);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });

      this.diagnostic({ event: "governor.queued", taskId: request.taskId, priority, workspaceId, queuePosition: this.queue.length });
      // Trigger drainage in case capacity was just freed
      this.drainQueue();
    });
  }

  subscribeCapacityChange(listener: () => void): () => void {
    this.capacityListeners.add(listener);
    return () => {
      this.capacityListeners.delete(listener);
    };
  }

  notifyCapacityChange(): void {
    for (const listener of this.capacityListeners) {
      try {
        listener();
      } catch {}
    }
  }

  tryAcquireModelSlot(attempt: {
    readonly taskId?: string;
    readonly workspaceId?: string | null;
    readonly connectionId?: string;
    readonly modelId?: string;
  }): { readonly granted: true; readonly leaseId: string; readonly release: () => void } | { readonly granted: false; readonly retryAfterMs?: number } {
    const activeGlobal = this.activeCategoryCount("model-request");
    if (activeGlobal >= this.budget.maxConcurrentModelRequests) {
      return { granted: false };
    }

    if (attempt.connectionId) {
      let activeForProvider = 0;
      for (const lease of this.activeLeases.values()) {
        if (lease.category === "model-request" && !lease.released && lease.metadata?.connectionId === attempt.connectionId) {
          activeForProvider += lease.units;
        }
      }
      if (activeForProvider >= this.budget.maxConcurrentModelRequestsPerProvider) {
        return { granted: false };
      }
    }

    const telemetry = this.telemetryCollector.collect();
    if (telemetry.memoryPressureState === "critical") {
      return { granted: false, retryAfterMs: 5000 };
    }

    const effectiveTaskId = (attempt.taskId || `model-task-${crypto.randomUUID()}`) as TaskId;
    const lease = this.createLease(
      effectiveTaskId,
      attempt.workspaceId ?? null,
      "model-request",
      1,
      { connectionId: attempt.connectionId, modelId: attempt.modelId }
    );

    return {
      granted: true,
      leaseId: lease.id,
      release: () => this.releaseLease(lease.id),
    };
  }

  toModelAdmissionPort(): ModelAdmissionPort {
    return {
      tryAcquire: (attempt) => this.tryAcquireModelSlot(attempt),
      release: (leaseId) => this.releaseLease(leaseId),
      subscribeCapacityChange: (listener) => this.subscribeCapacityChange(listener),
    };
  }

  acquireModelSlot(taskId: TaskId, workspaceId: string | null = null): ResourceLease {
    const active = this.activeCategoryCount("model-request");
    if (active >= this.budget.maxConcurrentModelRequests) {
      throw new Error(`Model request capacity reached (${this.budget.maxConcurrentModelRequests})`);
    }
    return this.createLease(taskId, workspaceId, "model-request", 1);
  }

  acquireBrowserSession(taskId: TaskId, workspaceId: string | null = null): ResourceLease {
    const active = this.activeCategoryCount("browser-session");
    if (active >= this.budget.maxConcurrentBrowserSessions) {
      throw new Error(`Browser session capacity reached (${this.budget.maxConcurrentBrowserSessions})`);
    }
    if (workspaceId) {
      const activeWs = this.activeCategoryCountForWorkspace("browser-session", workspaceId);
      if (activeWs >= this.budget.maxConcurrentBrowserSessionsPerWorkspace) {
        throw new Error(`Browser session per-workspace capacity reached (${this.budget.maxConcurrentBrowserSessionsPerWorkspace})`);
      }
    }
    return this.createLease(taskId, workspaceId, "browser-session", 1);
  }

  acquireSubprocess(taskId: TaskId, workspaceId: string | null, command: string, pid: number): ResourceLease {
    this.subprocessSupervisor.register({
      id: crypto.randomUUID(),
      pid,
      command,
      taskId,
      workspaceId,
      startedAt: Date.now(),
    });
    return this.createLease(taskId, workspaceId, "subprocess", 1, { pid, command });
  }

  releaseLease(leaseId: string): void {
    const lease = this.activeLeases.get(leaseId);
    if (!lease || lease.released) return;

    this.activeLeases.delete(leaseId);
    this.diagnostic({ event: "governor.lease_released", leaseId, category: lease.category, taskId: lease.taskId });
    this.drainQueue();
    this.notifyCapacityChange();
  }

  async releaseAllTaskResources(taskId: TaskId): Promise<void> {
    const toRelease: string[] = [];
    for (const [id, lease] of this.activeLeases) {
      if (lease.taskId === taskId) {
        toRelease.push(id);
      }
    }

    // Finish task-owned subprocess termination before returning execution
    // capacity to queued work.
    await this.subprocessSupervisor.terminateTaskSubprocesses(taskId);

    for (const id of toRelease) {
      this.activeLeases.delete(id);
    }

    if (toRelease.length > 0) {
      this.diagnostic({ event: "governor.task_resources_released", taskId, count: toRelease.length });
      this.drainQueue();
      this.notifyCapacityChange();
    }
  }

  drainQueue(): void {
    if (this.queue.length === 0) return;

    // Sort queue by priority score with aging and workspace fairness
    const now = Date.now();
    const scored = this.queue.map((entry) => {
      let baseScore = 500;
      if (entry.priority === "interactive") baseScore = 1000;
      else if (entry.priority === "batch") baseScore = 100;

      // Anti-starvation aging bonus: +1 point per 10ms waiting
      const waitBonus = Math.floor((now - entry.requestedAt) / 10);

      // Workspace load penalty: -150 points per active execution slot in that workspace
      const workspacePenalty = entry.workspaceId
        ? this.activeCategoryCountForWorkspace("execution-slot", entry.workspaceId) * 150
        : 0;

      const score = baseScore + waitBonus - workspacePenalty;
      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Attempt to admit candidates in score order
    const remainingQueue: QueuedEntry[] = [];
    for (const { entry } of scored) {
      if (entry.signal?.aborted) {
        entry.reject(new Error("Task admission aborted while queued"));
        continue;
      }

      if (this.canAdmitTask(entry.workspaceId, entry.priority)) {
        const lease = this.createLease(entry.taskId, entry.workspaceId, "execution-slot", 1, {
          priority: entry.priority,
          queuedDurationMs: now - entry.requestedAt,
        });
        this.diagnostic({ event: "governor.admitted_from_queue", taskId: entry.taskId, priority: entry.priority });
        entry.resolve(lease);
      } else {
        remainingQueue.push(entry);
      }
    }

    this.queue.length = 0;
    this.queue.push(...remainingQueue);
  }

  getStatus(): ResourceGovernorStatus {
    const telemetry = this.telemetryCollector.collect();
    const effectiveLimit = this.getEffectiveConcurrencyLimit();

    const workspaceAllocations: Record<string, { executionSlots: number; subprocesses: number; browserSessions: number }> = {};
    for (const lease of this.activeLeases.values()) {
      if (lease.workspaceId && !lease.released) {
        let entry = workspaceAllocations[lease.workspaceId];
        if (!entry) {
          entry = { executionSlots: 0, subprocesses: 0, browserSessions: 0 };
          workspaceAllocations[lease.workspaceId] = entry;
        }
        if (lease.category === "execution-slot") {
          entry.executionSlots += lease.units;
        } else if (lease.category === "subprocess") {
          entry.subprocesses += lease.units;
        } else if (lease.category === "browser-session") {
          entry.browserSessions += lease.units;
        }
      }
    }

    return {
      telemetry,
      activeLeases: {
        executionSlots: this.activeCategoryCount("execution-slot"),
        modelRequests: this.activeCategoryCount("model-request"),
        browserSessions: this.activeCategoryCount("browser-session"),
        subprocesses: this.activeCategoryCount("subprocess"),
      },
      queuedTasksCount: this.queue.length,
      effectiveConcurrencyLimit: effectiveLimit,
      memoryPressureState: telemetry.memoryPressureState,
      workspaceAllocations,
      budget: this.budget,
    };
  }

  async shutdown(): Promise<void> {
    for (const entry of this.queue) {
      entry.reject(new Error("Resource governor is shutting down"));
    }
    this.queue.length = 0;
    this.activeLeases.clear();
    await this.subprocessSupervisor.terminateAll();
  }

  private createLease(
    taskId: TaskId,
    workspaceId: string | null,
    category: ResourceCategory,
    units: number,
    metadata?: Record<string, unknown>
  ): ResourceLease {
    const lease: ResourceLease = {
      id: crypto.randomUUID(),
      taskId,
      workspaceId,
      category,
      units,
      acquiredAt: Date.now(),
      metadata,
      released: false,
    };
    this.activeLeases.set(lease.id, lease);
    return lease;
  }

  private diagnostic(event: Record<string, unknown>): void {
    if (this.onDiagnostic) {
      try {
        this.onDiagnostic(event);
      } catch {}
    }
  }
}

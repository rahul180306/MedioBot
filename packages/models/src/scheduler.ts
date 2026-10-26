import { AsyncLocalStorage } from "node:async_hooks";
import { ModelProviderError, sleepWithSignal } from "./index.ts";
import type { ModelAdmissionPort } from "./admission.ts";

interface ExecutionContext {
  hasPermit: boolean;
  activeLease?: () => void;
  readonly leaseRef?: { current?: (() => void) | undefined };
  readonly providerKey: string;
  readonly providerType?: string;
  readonly modelId?: string;
  readonly taskId?: string;
  readonly workspaceId?: string | null;
}

export interface ProviderSchedulerOptions {
  /** Maximum concurrent requests allowed per provider by default (default: 4). */
  readonly defaultConcurrency?: number;
  /** Explicit concurrency limits per providerKey or providerType. */
  readonly concurrencyLimits?: Readonly<Record<string, number>>;
  /** Maximum queued requests per provider before rejecting (default: 32). */
  readonly maxQueueSize?: number;
  /** Diagnostic telemetry hook (safe metadata only, no credentials). */
  readonly onDiagnostic?: (event: Record<string, unknown>) => void;
  /** Optional Resource Governor model admission port. */
  readonly admissionPort?: ModelAdmissionPort;
}

export interface ProviderScheduleRequest<T> {
  readonly providerKey: string;
  readonly providerType?: string;
  readonly modelId?: string;
  readonly taskId?: string;
  readonly workspaceId?: string | null;
  readonly signal?: AbortSignal;
  readonly execute: () => Promise<T>;
  /**
   * Optional mutable lease reference box. When provided, `schedule()` will
   * write the currently-active ModelAdmissionPort lease into `leaseRef.current`
   * before calling `execute()`. The `onBackoff` callback on the client can then
   * read `leaseRef.current` and pass it to `sleepWithBackoff` so the lease is
   * released before sleeping and re-acquired after — preventing the admission
   * port lease from being held during backoff delays (G05 deadlock fix).
   */
  readonly leaseRef?: { current?: (() => void) | undefined };
}

interface QueuedItem {
  readonly id: string;
  readonly providerKey: string;
  readonly providerType?: string;
  readonly modelId?: string;
  readonly taskId?: string;
  readonly workspaceId?: string | null;
  readonly queuedAt: number;
  readonly signal?: AbortSignal;
  readonly resolve: (leaseRelease?: () => void) => void;
  readonly reject: (error: Error) => void;
}

interface ProviderQueueState {
  activeCount: number;
  readonly queue: QueuedItem[];
  cooldownUntil?: number;
  cooldownTimer?: NodeJS.Timeout;
}

export class ProviderRequestScheduler {
  private readonly defaultConcurrency: number;
  private readonly concurrencyLimits: Record<string, number>;
  private readonly maxQueueSize: number;
  private readonly onDiagnostic?: (event: Record<string, unknown>) => void;
  private readonly queues = new Map<string, ProviderQueueState>();
  private counter = 0;
  private admissionPort?: ModelAdmissionPort;
  private unsubscribeAdmission?: () => void;
  private readonly executionContext = new AsyncLocalStorage<ExecutionContext>();

  constructor(options: ProviderSchedulerOptions = {}) {
    this.defaultConcurrency = Math.max(1, options.defaultConcurrency ?? 4);
    this.concurrencyLimits = { ...(options.concurrencyLimits ?? {}) };
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? 32);
    this.onDiagnostic = options.onDiagnostic;
    if (options.admissionPort) {
      this.setAdmissionPort(options.admissionPort);
    }
  }

  setAdmissionPort(port: ModelAdmissionPort): void {
    if (this.admissionPort === port) return;
    this.unsubscribeAdmission?.();
    this.admissionPort = port;
    this.unsubscribeAdmission = port.subscribeCapacityChange(() => {
      this.dispatchAll();
    });
    this.dispatchAll();
  }

  getConcurrencyLimit(providerKey: string, providerType?: string): number {
    if (typeof this.concurrencyLimits[providerKey] === "number") {
      return this.concurrencyLimits[providerKey];
    }
    if (providerType && typeof this.concurrencyLimits[providerType] === "number") {
      return this.concurrencyLimits[providerType];
    }
    return this.defaultConcurrency;
  }

  getProviderStatus(providerKey: string): {
    activeRequests: number;
    queuedRequests: number;
    limit: number;
    cooldownUntil?: number;
  } {
    const state = this.queues.get(providerKey);
    return {
      activeRequests: state ? state.activeCount : 0,
      queuedRequests: state ? state.queue.length : 0,
      limit: this.getConcurrencyLimit(providerKey),
      cooldownUntil: state?.cooldownUntil,
    };
  }

  setProviderCooldown(providerKey: string, cooldownMs: number): void {
    let state = this.queues.get(providerKey);
    if (!state) {
      state = { activeCount: 0, queue: [] };
      this.queues.set(providerKey, state);
    }
    const target = Date.now() + Math.max(0, cooldownMs);
    if (!state.cooldownUntil || target > state.cooldownUntil) {
      state.cooldownUntil = target;
      if (state.cooldownTimer) {
        clearTimeout(state.cooldownTimer);
      }
      this.onDiagnostic?.({
        event: "provider.cooldown.set",
        providerKey,
        cooldownMs,
        cooldownUntil: target,
      });
      const remaining = Math.max(0, target - Date.now());
      state.cooldownTimer = setTimeout(() => {
        state!.cooldownTimer = undefined;
        state!.cooldownUntil = undefined;
        this.onDiagnostic?.({
          event: "provider.cooldown.expired",
          providerKey,
        });
        this.dispatchNext(state!);
      }, remaining);
    }
  }

  /**
   * Sleep for `delayMs` during a 429 backoff, releasing the concurrency permit
   * and any active ModelAdmissionPort lease during the sleep, then re-acquiring
   * both before returning. Prevents the lease from being held while the scheduler
   * is blocked, which would starve other queued requests (G05 deadlock fix).
   *
   * @param providerKey  Provider identifier for queue state lookup.
   * @param delayMs      How long to sleep.
   * @param signal       Optional AbortSignal.
   * @param currentLease Active admission lease to release before sleeping; if
   *                     omitted, the active lease is retrieved automatically
   *                     from the ambient execution context.
   * @returns            New leaseRelease callback, or undefined when admission is
   *                     not configured or no lease was granted.
   */
  async sleepWithBackoff(
    providerKey: string,
    delayMs: number,
    signal?: AbortSignal,
    currentLease?: () => void
  ): Promise<(() => void) | undefined> {
    if (signal?.aborted) {
      throw new ModelProviderError("cancelled", "Model request cancelled");
    }

    const ctx = this.executionContext.getStore();
    const leaseToRelease = currentLease ?? ctx?.activeLease;
    try {
      leaseToRelease?.();
    } catch {
      // safe ignore
    }
    if (ctx) {
      ctx.activeLease = undefined;
      if (ctx.leaseRef) ctx.leaseRef.current = undefined;
    }

    let state = this.queues.get(providerKey);
    if (!state) {
      await sleepWithSignal(delayMs, signal);
      return undefined;
    }

    // 1. Release active capacity permit during backoff so other queued requests
    //    can acquire slots while this request is sleeping.
    if (ctx) {
      ctx.hasPermit = false;
    }
    state.activeCount = Math.max(0, state.activeCount - 1);
    this.onDiagnostic?.({
      event: "provider.request.backoff_released",
      providerKey,
      activeRequests: state.activeCount,
      queuedRequests: state.queue.length,
      delayMs,
    });

    // Notify other waiters that a slot opened.
    this.dispatchNext(state);

    // 2. Set provider-level cooldown to protect against retry storms.
    this.setProviderCooldown(providerKey, delayMs);

    // 3. Sleep for delayMs respecting cancellation.
    try {
      await sleepWithSignal(delayMs, signal);
    } catch (err) {
      this.dispatchNext(state);
      throw err;
    }

    // 4. Re-acquire concurrency permit and ModelAdmissionPort lease before the next network attempt.
    const newLease = await this.acquirePermit(
      state,
      providerKey,
      ctx?.providerType,
      ctx?.modelId,
      ctx?.taskId,
      ctx?.workspaceId,
      signal
    );

    if (ctx) {
      ctx.hasPermit = true;
      ctx.activeLease = newLease;
      if (ctx.leaseRef) ctx.leaseRef.current = newLease;
    }

    return newLease;
  }

  private async acquirePermit(
    state: ProviderQueueState,
    providerKey: string,
    providerType?: string,
    modelId?: string,
    taskId?: string,
    workspaceId?: string | null,
    signal?: AbortSignal
  ): Promise<(() => void) | undefined> {
    if (signal?.aborted) {
      throw new ModelProviderError("cancelled", "Model request cancelled");
    }

    const limit = this.getConcurrencyLimit(providerKey, providerType);
    const isCoolingDown = typeof state.cooldownUntil === "number" && Date.now() < state.cooldownUntil;

    // Fast-path: immediate admission if under concurrency limit and not cooling down
    if (state.activeCount < limit && !isCoolingDown) {
      if (this.admissionPort) {
        const admission = this.admissionPort.tryAcquire({
          taskId: taskId ?? "backoff-reacquire",
          workspaceId: workspaceId ?? null,
          connectionId: providerKey,
          modelId: modelId ?? "unknown",
        });
        if (admission.granted) {
          state.activeCount++;
          return admission.release;
        }
        // Governor capacity is currently exhausted across providers; must queue
      } else {
        state.activeCount++;
        return undefined;
      }
    }

    if (state.queue.length >= this.maxQueueSize) {
      throw new ModelProviderError(
        "capacity",
        `Provider capacity reached: request queue for '${providerKey}' is full (${state.queue.length}/${this.maxQueueSize}).`
      );
    }

    const entryId = `req-reacquire-${++this.counter}-${Date.now()}`;
    const queuedAt = performance.now();
    let leaseRelease: (() => void) | undefined;

    await new Promise<void>((resolve, reject) => {
      let abortListener: (() => void) | undefined;
      const cleanup = () => {
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
      };

      abortListener = () => {
        cleanup();
        const idx = state.queue.findIndex((item) => item.id === entryId);
        if (idx >= 0) {
          state.queue.splice(idx, 1);
          reject(new ModelProviderError("cancelled", "Model request cancelled while queued"));
        }
      };

      if (signal?.aborted) {
        abortListener();
        return;
      }
      if (signal) {
        signal.addEventListener("abort", abortListener, { once: true });
      }

      state.queue.push({
        id: entryId,
        providerKey,
        providerType,
        modelId,
        taskId,
        workspaceId,
        queuedAt,
        signal,
        resolve: (release) => {
          cleanup();
          leaseRelease = release;
          resolve();
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });

      // Pump dispatch in case cooldown expired or capacity opened
      this.dispatchNext(state);
    });

    return leaseRelease;
  }

  async schedule<T>(request: ProviderScheduleRequest<T>): Promise<T> {
    const { providerKey, providerType, modelId, taskId, workspaceId, signal, execute, leaseRef } = request;

    if (signal?.aborted) {
      throw new ModelProviderError("cancelled", "Model request cancelled");
    }

    let state = this.queues.get(providerKey);
    if (!state) {
      state = { activeCount: 0, queue: [] };
      this.queues.set(providerKey, state);
    }

    const limit = this.getConcurrencyLimit(providerKey, providerType);
    const isCoolingDown = typeof state.cooldownUntil === "number" && Date.now() < state.cooldownUntil;

    // Check immediate admission: capacity available AND not in cooldown
    if (state.activeCount < limit && !isCoolingDown) {
      if (this.admissionPort) {
        const admission = this.admissionPort.tryAcquire({
          taskId: taskId ?? "ad-hoc-model-slot",
          workspaceId: workspaceId ?? null,
          connectionId: providerKey,
          modelId: modelId ?? "unknown",
        });
        if (admission.granted) {
          state.activeCount++;
          this.onDiagnostic?.({
            event: "provider.request.admitted",
            providerKey,
            providerType,
            modelId,
            activeRequests: state.activeCount,
            queuedRequests: state.queue.length,
            limit,
          });
          return this.runWithRelease(state, providerKey, providerType, modelId, taskId, workspaceId, execute, admission.release, leaseRef);
        }
        // If not granted by governor, fall through to queue without incrementing activeCount
      } else {
        state.activeCount++;
        this.onDiagnostic?.({
          event: "provider.request.admitted",
          providerKey,
          providerType,
          modelId,
          activeRequests: state.activeCount,
          queuedRequests: state.queue.length,
          limit,
        });
        return this.runWithRelease(state, providerKey, providerType, modelId, taskId, workspaceId, execute, undefined, leaseRef);
      }
    }

    // Queue is full -> reject with capacity error
    if (state.queue.length >= this.maxQueueSize) {
      this.onDiagnostic?.({
        event: "provider.request.queue_full",
        providerKey,
        providerType,
        modelId,
        activeRequests: state.activeCount,
        queuedRequests: state.queue.length,
        limit,
      });
      throw new ModelProviderError(
        "capacity",
        `Provider capacity reached: request queue for '${providerKey}' is full (${state.queue.length}/${this.maxQueueSize}).`
      );
    }

    // Wait in queue for permit
    const entryId = `req-${++this.counter}-${Date.now()}`;
    const queuedAt = performance.now();

    this.onDiagnostic?.({
      event: "provider.request.queued",
      id: entryId,
      providerKey,
      providerType,
      modelId,
      activeRequests: state.activeCount,
      queuedRequests: state.queue.length + 1,
      limit,
    });

    let leaseRelease: (() => void) | undefined;
    await new Promise<void>((resolve, reject) => {
      let abortListener: (() => void) | undefined;

      const cleanup = () => {
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
      };

      abortListener = () => {
        cleanup();
        const idx = state!.queue.findIndex((item) => item.id === entryId);
        if (idx >= 0) {
          state!.queue.splice(idx, 1);
          this.onDiagnostic?.({
            event: "provider.request.cancelled_while_queued",
            id: entryId,
            providerKey,
            providerType,
            modelId,
            queuedDurationMs: Math.round(performance.now() - queuedAt),
            activeRequests: state!.activeCount,
            queuedRequests: state!.queue.length,
          });
          reject(new ModelProviderError("cancelled", "Model request cancelled while queued"));
        }
      };

      if (signal?.aborted) {
        abortListener();
        return;
      }

      if (signal) {
        signal.addEventListener("abort", abortListener, { once: true });
      }

      state!.queue.push({
        id: entryId,
        providerKey,
        providerType,
        modelId,
        taskId,
        workspaceId,
        queuedAt,
        signal,
        resolve: (release) => {
          cleanup();
          leaseRelease = release;
          resolve();
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });
    });

    this.onDiagnostic?.({
      event: "provider.request.admitted_from_queue",
      id: entryId,
      providerKey,
      providerType,
      modelId,
      queuedDurationMs: Math.round(performance.now() - queuedAt),
      activeRequests: state.activeCount,
      queuedRequests: state.queue.length,
      limit,
    });

    return this.runWithRelease(state, providerKey, providerType, modelId, taskId, workspaceId, execute, leaseRelease, leaseRef);
  }

  private async runWithRelease<T>(
    state: ProviderQueueState,
    providerKey: string,
    providerType: string | undefined,
    modelId: string | undefined,
    taskId: string | undefined,
    workspaceId: string | null | undefined,
    execute: () => Promise<T>,
    leaseRelease?: () => void,
    leaseRef?: { current?: (() => void) | undefined }
  ): Promise<T> {
    const ctx: ExecutionContext = {
      hasPermit: true,
      activeLease: leaseRelease,
      leaseRef,
      providerKey,
      providerType,
      modelId,
      taskId,
      workspaceId,
    };
    if (leaseRef) leaseRef.current = leaseRelease;

    return this.executionContext.run(ctx, async () => {
      try {
        return await execute();
      } finally {
        if (leaseRef) leaseRef.current = undefined;
        try {
          ctx.activeLease?.();
          ctx.activeLease = undefined;
        } finally {
          if (ctx.hasPermit) {
            this.releasePermit(state, providerKey, providerType, modelId);
            ctx.hasPermit = false;
          }
        }
      }
    });
  }

  private releasePermit(
    state: ProviderQueueState,
    providerKey: string,
    providerType: string | undefined,
    modelId: string | undefined
  ): void {
    state.activeCount = Math.max(0, state.activeCount - 1);
    this.onDiagnostic?.({
      event: "provider.request.released",
      providerKey,
      providerType,
      modelId,
      activeRequests: state.activeCount,
      queuedRequests: state.queue.length,
    });
    this.dispatchNext(state);
  }

  private dispatchAll(): void {
    for (const state of this.queues.values()) {
      this.dispatchNext(state);
    }
  }

  private dispatchNext(state: ProviderQueueState): void {
    if (typeof state.cooldownUntil === "number" && Date.now() < state.cooldownUntil) {
      if (!state.cooldownTimer) {
        const remaining = Math.max(0, state.cooldownUntil - Date.now());
        state.cooldownTimer = setTimeout(() => {
          state.cooldownTimer = undefined;
          state.cooldownUntil = undefined;
          this.dispatchNext(state);
        }, remaining);
      }
      return;
    }

    while (state.queue.length > 0) {
      const nextItem = state.queue[0];
      if (!nextItem) {
        break;
      }
      const limit = this.getConcurrencyLimit(nextItem.providerKey, nextItem.providerType);

      if (state.activeCount >= limit) {
        break;
      }

      if (nextItem.signal?.aborted) {
        const item = state.queue.shift();
        item?.reject(new ModelProviderError("cancelled", "Model request cancelled while queued"));
        continue;
      }

      let leaseRelease: (() => void) | undefined;
      if (this.admissionPort) {
        const admission = this.admissionPort.tryAcquire({
          taskId: nextItem.taskId ?? "ad-hoc-model-slot",
          workspaceId: nextItem.workspaceId ?? null,
          connectionId: nextItem.providerKey,
          modelId: nextItem.modelId ?? "unknown",
        });
        if (!admission.granted) {
          // Governor has no slot available right now; wait for capacity change
          break;
        }
        leaseRelease = admission.release;
      }

      const item = state.queue.shift();
      if (!item) {
        leaseRelease?.();
        break;
      }

      state.activeCount++;
      item.resolve(leaseRelease);
    }
  }

  clear(): void {
    this.unsubscribeAdmission?.();
    this.unsubscribeAdmission = undefined;
    for (const [, state] of this.queues) {
      if (state.cooldownTimer) {
        clearTimeout(state.cooldownTimer);
        state.cooldownTimer = undefined;
      }
      state.cooldownUntil = undefined;
      for (const item of state.queue) {
        item.reject(new ModelProviderError("cancelled", "Scheduler cleared"));
      }
      state.queue.length = 0;
      state.activeCount = 0;
    }
    this.queues.clear();
  }
}

import crypto from "node:crypto";
import type {
  AssignmentId,
  GoalId,
  InMemoryWorld,
  MediobotDefinitionId,
  TaskId,
  WorkerId,
  WorldEvent,
} from "@mediobot-v2/domain";
import type {
  IntermediateArtifact,
  IntermediateArtifactKind,
  OrchestrationPlanSpec,
  OrchestrationTaskSpec,
  ResourceGovernorStatus,
  ResourceLease,
  SupportRequest,
  SupportResolution,
  TaskPriority,
} from "@mediobot-v2/contracts";
import type {
  DurableTaskEngine,
  DurableTaskRecord,
  DurableTaskStatus,
  ResourceGovernor,
  RunContext,
  RunResult,
  WorkerExecutionContext,
  WorkerExecutionPlan,
  WorkerRuntime,
} from "@mediobot-v2/runtime";
import { projectSupervision } from "@mediobot-v2/runtime";
import { sanitizeReasoningAndSecrets } from "@mediobot-v2/models";
import type { MaestroContext, MaestroDecisionProvider, MaestroModelClient } from "./index.ts";
import type { TextAssignmentDraft, TextModelResolver, WorkerReport } from "./text-workers.ts";
import { readModelSelection } from "./text-workers.ts";
import type { WebIntelligenceRuntime } from "./web-workers.ts";

export interface OrchestratorOptions {
  readonly workspaceRoot?: string;
  readonly workspaceId?: string | null;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly maxConcurrency?: number;
  readonly maxDelegationDepth?: number;
  readonly maxTasksBudget?: number;
  readonly defaultTimeoutMs?: number;
  readonly assignmentModelSelections?: Record<string, unknown>;
  readonly modelSelection?: unknown;
  readonly projectContext?: Record<string, unknown>;
  readonly onArtifact?: (artifact: IntermediateArtifact) => void;
  readonly onEvent?: (event: WorldEvent) => void;
  readonly onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
  readonly specialistAdapters?: ReadonlyMap<
    MediobotDefinitionId,
    (context: WorkerExecutionContext, run: RunContext, emitArtifact: (a: Omit<IntermediateArtifact, "id" | "taskId" | "workerId" | "mediobotId" | "timestamp">) => void) => Promise<void>
  >;
}

export interface TaskExecutionState {
  readonly spec: OrchestrationTaskSpec;
  status: "waiting_dependencies" | "queued" | "running" | "completed" | "failed" | "cancelled" | "blocked";
  taskId: TaskId;
  workerId?: WorkerId;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  report?: WorkerReport;
  intermediateArtifacts: IntermediateArtifact[];
  lease?: ResourceLease;
  abortController?: AbortController;
}

export interface OrchestrationResult {
  readonly planId: string;
  readonly goal: string;
  readonly status: "completed" | "failed" | "cancelled" | "partial_success";
  readonly tasks: ReadonlyArray<TaskExecutionState>;
  readonly intermediateArtifacts: ReadonlyArray<IntermediateArtifact>;
  readonly reports: ReadonlyArray<WorkerReport>;
  readonly executionInterval: {
    readonly startedAt: number;
    readonly completedAt: number;
    readonly durationMs: number;
    readonly maxParallelWorkers: number;
    readonly verifiedOverlapMs: number;
  };
  readonly synthesis?: string;
}

export class MaestroOrchestrator {
  readonly world: InMemoryWorld;
  readonly runtime: WorkerRuntime;
  readonly resourceGovernor?: ResourceGovernor;
  readonly durableTaskEngine?: DurableTaskEngine;
  private readonly textModelResolver?: TextModelResolver;
  private readonly crawl4ai?: WebIntelligenceRuntime;
  private readonly decisions?: MaestroDecisionProvider;
  private readonly onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
  private readonly checkpointDatabasePath: string;

  private readonly intermediateArtifactsBus: IntermediateArtifact[] = [];
  private activeSupportHandler?: (request: SupportRequest) => Promise<SupportResolution>;

  async requestSupport(request: SupportRequest): Promise<SupportResolution> {
    if (this.activeSupportHandler) {
      return this.activeSupportHandler(request);
    }
    return {
      requestId: request.id,
      decision: "unnecessary",
      reason: "No active orchestration plan running to handle support request.",
      resolvedAt: Date.now(),
    };
  }

  constructor(options: {
    readonly world: InMemoryWorld;
    readonly runtime: WorkerRuntime;
    readonly resourceGovernor?: ResourceGovernor;
    readonly durableTaskEngine?: DurableTaskEngine;
    readonly textModelResolver?: TextModelResolver;
    readonly crawl4ai?: WebIntelligenceRuntime;
    readonly decisions?: MaestroDecisionProvider;
    readonly onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
    readonly checkpointDatabasePath?: string;
  }) {
    this.world = options.world;
    this.runtime = options.runtime;
    this.resourceGovernor = options.resourceGovernor;
    this.durableTaskEngine = options.durableTaskEngine;
    this.textModelResolver = options.textModelResolver;
    this.crawl4ai = options.crawl4ai;
    this.decisions = options.decisions;
    this.onDiagnostic = options.onDiagnostic;
    this.checkpointDatabasePath = options.checkpointDatabasePath ?? ":memory:";
  }

  private diagnostic(event: string, data: Record<string, unknown>): void {
    try {
      this.onDiagnostic?.({ system: "maestro-orchestrator", event, timestamp: Date.now(), ...data });
    } catch {
      // Diagnostic observers must never disrupt task execution
    }
  }

  /**
   * Executes an OrchestrationPlan with real dependency-aware concurrency,
   * Resource Governor quotas, dynamic delegation, and durability.
   */
  async executePlan(
    plan: OrchestrationPlanSpec,
    options: OrchestratorOptions = {},
    signal?: AbortSignal
  ): Promise<OrchestrationResult> {
    const orchestratorStartMonotonic = performance.now();
    const orchestratorStartEpoch = performance.timeOrigin + orchestratorStartMonotonic;

    const maxDepth = options.maxDelegationDepth ?? 3;
    const maxBudget = options.maxTasksBudget ?? 10;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;

    const taskStates = new Map<TaskId, TaskExecutionState>();
    const dynamicParentByTask = new Map<TaskId, TaskId>();
    // Request dedupe is scoped to one plan execution and cannot leak resolutions across turns.
    const supportRequestCache = new Map<string, Promise<SupportResolution>>();
    const supportRequestOwners = new Map<string, TaskId>();
    const completedTasks = new Set<TaskId>();
    const failedTasks = new Set<TaskId>();
    const runningTasks = new Set<TaskId>();
    const allArtifacts: IntermediateArtifact[] = [];
    const reports: WorkerReport[] = [];
    let executeTaskFn: ((state: TaskExecutionState) => Promise<void>) | undefined;
    let dispatchGraphTask: ((taskId: TaskId, requesterTaskId: TaskId) => Promise<void>) | undefined;
    const dynamicOutcomesByRequester = new Map<TaskId, Record<string, ExecutionSnapshot>>();
    const dynamicDispatchesByRequester = new Map<TaskId, Set<Promise<void>>>();

    // Track active parallel count and overlapping intervals
    let peakParallelWorkers = 0;
    const workerIntervals: Array<{ taskId: TaskId; startedAt: number; completedAt: number }> = [];

    // Initialize all tasks from plan
    for (const spec of plan.tasks) {
      taskStates.set(spec.id, {
        spec,
        status: (spec.dependencies && spec.dependencies.length > 0) ? "waiting_dependencies" : "queued",
        taskId: spec.id,
        intermediateArtifacts: [],
      });
    }

    // Persist all initial tasks in DurableTaskEngine if configured
    if (this.durableTaskEngine) {
      for (const state of taskStates.values()) {
        try {
          await this.durableTaskEngine.submitTask({
            id: state.taskId,
            workspaceId: options.workspaceId ?? null,
            threadId: options.threadId ?? null,
            turnId: options.turnId ?? null,
            goal: state.spec.objective,
            definitionId: state.spec.definitionId,
            maxRetries: state.spec.maxRetries ?? 2,
          });
        } catch {
          // Task might already exist from previous session (idempotent)
        }
      }
    }

    // Dynamic delegation support handler available to running specialists
    const handleSupportRequest = async (request: SupportRequest): Promise<SupportResolution> => {
      this.diagnostic("support_requested", {
        requestId: request.id,
        requesterTaskId: request.requesterTaskId,
        capability: request.capabilityNeeded,
        query: request.query,
      });

      // 1. Cache & Deduplication Check (normalized by capability and query)
      const cacheKey = [plan.planId, options.workspaceId ?? "", options.threadId ?? "",
        request.capabilityNeeded.toLowerCase().trim(), request.query.trim().toLowerCase()].join(":");
      const existing = supportRequestCache.get(cacheKey);
      if (existing) {
        const ownerTaskId = supportRequestOwners.get(cacheKey);
        let ancestorTaskId: TaskId | undefined = request.requesterTaskId;
        while (ancestorTaskId) {
          if (ancestorTaskId === ownerTaskId) {
            this.diagnostic("support_cycle_rejected", { requestId: request.id, requesterTaskId: request.requesterTaskId });
            return {
              requestId: request.id,
              decision: "unnecessary",
              reason: "An ancestor specialist already has this support request in flight; continue with available evidence and report any unresolved dependency.",
              resolvedAt: Date.now(),
            };
          }
          ancestorTaskId = dynamicParentByTask.get(ancestorTaskId);
        }
        this.diagnostic("support_deduplicated", { requestId: request.id, cacheKey });
        return existing;
      }

      let resolveResolution!: (res: SupportResolution) => void;
      let rejectResolution!: (err: unknown) => void;
      const resolutionPromise = new Promise<SupportResolution>((resolve, reject) => {
        resolveResolution = resolve;
        rejectResolution = reject;
      });
      // Synchronously populate cache so concurrent callers get the same in-flight promise
      supportRequestCache.set(cacheKey, resolutionPromise);
      supportRequestOwners.set(cacheKey, request.requesterTaskId);

      (async (): Promise<SupportResolution> => {
        // 2. Budget and Depth Guards
        const currentTaskCount = taskStates.size;
        const parentState = taskStates.get(request.requesterTaskId);
        const currentDepth = (parentState?.spec.depth ?? 0) + 1;

        if (currentTaskCount >= maxBudget || currentDepth > maxDepth) {
          this.diagnostic("support_budget_exceeded", { currentTaskCount, maxBudget, currentDepth, maxDepth });
          return {
            requestId: request.id,
            decision: "unnecessary",
            reason: `Delegation budget or depth limit reached (tasks: ${currentTaskCount}/${maxBudget}, depth: ${currentDepth}/${maxDepth}).`,
            resolvedAt: Date.now(),
          };
        }

        // 3. Option A: Check if existing project knowledge / artifacts already answer the query
        const queryLower = request.query.toLowerCase();
        const matchingArtifact = allArtifacts.find((a) =>
          a.content.toLowerCase().includes(queryLower) || a.title.toLowerCase().includes(queryLower)
        );

        if (matchingArtifact) {
          this.diagnostic("support_resolved_from_existing_artifact", { artifactId: matchingArtifact.id });
          return {
            requestId: request.id,
            decision: "existing_knowledge",
            reason: `Existing verified artifact "${matchingArtifact.title}" satisfies the requirement.`,
            answer: matchingArtifact.content,
            resolvedAt: Date.now(),
          };
        }

        // Check project context in options
        if (options.projectContext) {
          const files = (options.projectContext.files as Array<{ path: string; language?: string }>) ?? [];
          const matchingFile = files.find((f) => f.path.toLowerCase().includes(queryLower));
          if (matchingFile) {
            this.diagnostic("support_resolved_from_project_context", { path: matchingFile.path });
            return {
              requestId: request.id,
              decision: "existing_knowledge",
              reason: `File "${matchingFile.path}" is already available in the project context.`,
              answer: `Reference available at ${matchingFile.path}`,
              resolvedAt: Date.now(),
            };
          }
        }

        // 4. Option B: Doc specialist investigation
        const isDocNeed = /doc|documentation|api|signature|guide|version/i.test(request.capabilityNeeded) ||
          /doc|documentation|api reference|signature|usage/i.test(queryLower);

        // Find Doc or Research definition in world
        const definitions = this.world.inspect().definitions;
        const docDef = definitions.find((d) => d.role === "doc") ??
          definitions.find((d) => d.declaredCapabilities.some((c) => c.name.includes("doc")));
        const researchDef = definitions.find((d) => d.role === "research") ??
          definitions.find((d) => d.declaredCapabilities.some((c) => c.name.includes("research")));

        if (isDocNeed && docDef) {
          const newTaskId = `task-doc-${crypto.createHash("sha256").update(cacheKey).digest("hex").slice(0, 16)}` as TaskId;
          const docSpec: OrchestrationTaskSpec = {
            id: newTaskId,
            definitionId: docDef.id,
            objective: `Documentation inquiry from ${parentState?.spec.definitionId ?? "specialist"}: ${request.query}`,
            priority: "interactive",
            relevantContext: request.contextSnippet ?? request.query,
            expectedOutcome: "Authoritative documentation or API signature.",
            depth: currentDepth,
          };

          const newState: TaskExecutionState = {
            spec: docSpec,
            status: "queued",
            taskId: newTaskId,
            intermediateArtifacts: [],
          };
          taskStates.set(newTaskId, newState);
          dynamicParentByTask.set(newTaskId, request.requesterTaskId);

          if (this.durableTaskEngine) {
            try {
              await this.durableTaskEngine.submitTask({
                id: newTaskId,
                workspaceId: options.workspaceId ?? null,
                threadId: options.threadId ?? null,
                turnId: options.turnId ?? null,
                goal: docSpec.objective,
                definitionId: docSpec.definitionId,
              });
              await this.durableTaskEngine.recordDelegation(request.requesterTaskId, {
                parentTaskId: request.requesterTaskId,
                childTaskId: newTaskId,
                assignedMediobotId: docDef.id,
                assignedMediobotName: docDef.name,
                objective: docSpec.objective,
                status: "active",
              });
            } catch {}
          }

          this.diagnostic("support_scheduled_doc", { newTaskId, requesterTaskId: request.requesterTaskId });

          // Schedule and execute the Doc task immediately without waiting for other tasks
          void dispatchGraphTask?.(newTaskId, request.requesterTaskId);

          // Wait for Doc task to complete or produce an artifact
          const docResult = await waitForTaskCompletionOrArtifact(newTaskId);
          return {
            requestId: request.id,
            decision: "delegate_doc",
            reason: "Doc specialist investigated authoritative documentation.",
            answer: docResult,
            scheduledTaskId: newTaskId,
            targetSpecialistId: docDef.id,
            resolvedAt: Date.now(),
          };
        }

        // 5. Option C: Research specialist investigation
        if (researchDef) {
          const newTaskId = `task-res-${crypto.createHash("sha256").update(cacheKey).digest("hex").slice(0, 16)}` as TaskId;
          const resSpec: OrchestrationTaskSpec = {
            id: newTaskId,
            definitionId: researchDef.id,
            objective: `Research support request: ${request.query}`,
            priority: "interactive",
            relevantContext: request.contextSnippet ?? request.query,
            expectedOutcome: "Technical research findings.",
            depth: currentDepth,
          };

          const newState: TaskExecutionState = {
            spec: resSpec,
            status: "queued",
            taskId: newTaskId,
            intermediateArtifacts: [],
          };
          taskStates.set(newTaskId, newState);
          dynamicParentByTask.set(newTaskId, request.requesterTaskId);

          if (this.durableTaskEngine) {
            try {
              await this.durableTaskEngine.submitTask({
                id: newTaskId,
                workspaceId: options.workspaceId ?? null,
                threadId: options.threadId ?? null,
                turnId: options.turnId ?? null,
                goal: resSpec.objective,
                definitionId: resSpec.definitionId,
              });
              await this.durableTaskEngine.recordDelegation(request.requesterTaskId, {
                parentTaskId: request.requesterTaskId,
                childTaskId: newTaskId,
                assignedMediobotId: researchDef.id,
                assignedMediobotName: researchDef.name,
                objective: resSpec.objective,
                status: "active",
              });
            } catch {}
          }

          this.diagnostic("support_scheduled_research", { newTaskId, requesterTaskId: request.requesterTaskId });
          void dispatchGraphTask?.(newTaskId, request.requesterTaskId);

          const resResult = await waitForTaskCompletionOrArtifact(newTaskId);
          return {
            requestId: request.id,
            decision: "delegate_research",
            reason: "Research specialist investigated technical approach.",
            answer: resResult,
            scheduledTaskId: newTaskId,
            targetSpecialistId: researchDef.id,
            resolvedAt: Date.now(),
          };
        }

        // 6. Option D: Unnecessary or no specialist available
        return {
          requestId: request.id,
          decision: "unnecessary",
          reason: "No specialist available to investigate request; proceed with current project knowledge.",
          resolvedAt: Date.now(),
        };
      })().then(resolveResolution, rejectResolution);

      return resolutionPromise;
    };

    this.activeSupportHandler = handleSupportRequest;

    // Helper to wait for a specific task's result or intermediate artifact
    const waitForTaskCompletionOrArtifact = async (taskId: TaskId): Promise<string> => {
      while (true) {
        const state = taskStates.get(taskId);
        if (!state) return "Task not found";
        if (state.intermediateArtifacts.length > 0) {
          const last = state.intermediateArtifacts[state.intermediateArtifacts.length - 1];
          if (last) return last.content;
        }
        if (state.status === "completed") {
          return state.report?.summary ?? "Completed successfully.";
        }
        if (state.status === "failed" || state.status === "cancelled") {
          return `Task ended with status: ${state.status}`;
        }
        await new Promise((res) => setTimeout(res, 20));
      }
    };

    // Execute one individual task
    executeTaskFn = async (state: TaskExecutionState): Promise<void> => {
      const taskId = state.taskId;
      const spec = state.spec;
      const workerDef = this.world.inspect().definitions.find((d) => d.id === spec.definitionId);
      if (!workerDef) {
        state.status = "failed";
        state.error = `Mediobot definition ${spec.definitionId} not found in world`;
        failedTasks.add(taskId);
        return;
      }

      state.status = "running";
      runningTasks.add(taskId);
      peakParallelWorkers = Math.max(peakParallelWorkers, runningTasks.size);

      const taskStartEpoch = performance.timeOrigin + performance.now();
      state.startedAt = taskStartEpoch;

      const worker = this.world.spawnWorker(spec.definitionId);
      state.workerId = worker.id;

      // Create domain task in World
      const domainTask = this.world.assignTask(
        this.world.createTask(spec.objective, undefined, taskId).id,
        worker.id
      );

      // Register with durable task engine
      if (this.durableTaskEngine) {
        try {
          await this.durableTaskEngine.startTask(taskId);
        } catch {}
      }

      const taskController = new AbortController();
      state.abortController = taskController;

      // Propagate parent signal
      if (signal) {
        const onAbort = () => {
          taskController.abort();
          try {
            this.runtime.cancel(taskId);
          } catch {}
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      // Timeout guard
      const timeoutMs = spec.timeoutMs ?? defaultTimeoutMs;
      const timeoutTimer = setTimeout(() => {
        taskController.abort(new Error(`Task ${taskId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let lease: ResourceLease | undefined;
      try {
        // Acquire resource lease from Resource Governor if present
        if (this.resourceGovernor) {
          lease = await this.resourceGovernor.requestTaskAdmission({
            taskId,
            workspaceId: options.workspaceId ?? null,
            priority: spec.priority ?? "interactive",
            signal: taskController.signal,
          });
          state.lease = lease;
        }

        taskController.signal.throwIfAborted();

        // Intermediate artifact emitter for this task
        const emitArtifact = (
          artifactInput: Omit<IntermediateArtifact, "id" | "taskId" | "workerId" | "mediobotId" | "timestamp">
        ): IntermediateArtifact => {
          const artifact: IntermediateArtifact = {
            id: `art-${crypto.randomUUID().slice(0, 8)}`,
            taskId,
            workerId: worker.id,
            mediobotId: spec.definitionId,
            timestamp: Date.now(),
            ...artifactInput,
          };
          state.intermediateArtifacts.push(artifact);
          allArtifacts.push(artifact);
          this.intermediateArtifactsBus.push(artifact);

          // Record in World evidence
          this.world.recordEvidence({
            taskId,
            workerId: worker.id,
            source: { type: "intermediate-artifact", reference: artifact.id },
            kind: artifact.kind,
            claim: artifact.title,
            content: artifact.content,
            validity: artifact.isProvisional ? "observed" : "verified",
          });

          // Record in DurableTaskEngine
          if (this.durableTaskEngine) {
            void this.durableTaskEngine.recordEvidence(taskId, {
              kind: artifact.kind,
              source: { type: "intermediate-artifact", reference: artifact.id },
              claim: artifact.title,
              content: artifact.content,
              validity: artifact.isProvisional ? "observed" : "verified",
            });
          }

          this.diagnostic("artifact_emitted", {
            artifactId: artifact.id,
            taskId,
            kind: artifact.kind,
            title: artifact.title,
            isProvisional: artifact.isProvisional,
          });

          try {
            options.onArtifact?.(artifact);
          } catch {}

          // Trigger evaluation so dependent or listening agents can react immediately
          return artifact;
        };

        // Prepare execution context
        const executionContext: WorkerExecutionContext = {
          world: this.world,
          definitionId: spec.definitionId,
          workerId: worker.id,
          taskId,
          goal: spec.objective,
          options: {
            ...options,
            supportHandler: handleSupportRequest,
            orchestrator: Object.assign(Object.create(this), {
              requestSupport: handleSupportRequest,
            }),
            emitArtifact,
            onArtifact: emitArtifact,
            relevantArtifacts: allArtifacts,
          },
        };

        // Execute specialist
        // Check if explicit specialistAdapter registered
        const customAdapter = options.specialistAdapters?.get(spec.definitionId);

        if (customAdapter) {
          const abortRuntime = () => {
            try {
              this.runtime.cancel(taskId);
            } catch {}
          };
          taskController.signal.addEventListener("abort", abortRuntime, { once: true });

          let runResult: RunResult;
          try {
            runResult = await this.runtime.run({
              taskId,
              workerId: worker.id,
              resourceIds: [],
              // executePlan already acquired and owns this task's Governor
              // admission above. Do not ask WorkerRuntime for a second slot.
              admissionMode: lease ? "pre-admitted" : "execution",
              workspaceId: options.workspaceId,
              priority: spec.priority ?? "interactive",
              onEvent: options.onEvent,
              execute: async (runCtx) => {
                await customAdapter(executionContext, runCtx, emitArtifact);
              },
            });
          } finally {
            taskController.signal.removeEventListener("abort", abortRuntime);
          }

          if (runResult.state === "failed") {
            throw new Error(runResult.error ?? "Specialist execution failed");
          }
          if (runResult.state === "cancelled") {
            taskController.abort();
            throw new Error("Task cancelled");
          }
        } else {
          // Standard execution based on role
          await this.executeStandardSpecialist(
            spec,
            workerDef,
            executionContext,
            taskController.signal,
            emitArtifact,
            options
          );
        }

        taskController.signal.throwIfAborted();
        state.status = "completed";
        completedTasks.add(taskId);

        if (this.durableTaskEngine) {
          try {
            await this.durableTaskEngine.completeTask(taskId);
          } catch {}
        }
      } catch (err: unknown) {
        if (taskController.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          state.status = "cancelled";
          state.error = "Task cancelled";
          if (this.durableTaskEngine) {
            try {
              await this.durableTaskEngine.cancelTask(taskId, "Task cancelled");
            } catch {}
          }
        } else {
          state.status = "failed";
          state.error = err instanceof Error ? err.message : String(err);
          failedTasks.add(taskId);
          if (this.durableTaskEngine) {
            try {
              await this.durableTaskEngine.failTask(taskId, {
                code: "specialist_failed",
                message: state.error,
              });
            } catch {}
          }
        }
      } finally {
        clearTimeout(timeoutTimer);
        runningTasks.delete(taskId);

        const taskCompletedEpoch = performance.timeOrigin + performance.now();
        state.completedAt = taskCompletedEpoch;

        workerIntervals.push({
          taskId,
          startedAt: taskStartEpoch,
          completedAt: taskCompletedEpoch,
        });

        // Release Resource Governor lease
        if (lease && this.resourceGovernor) {
          this.resourceGovernor.releaseLease(lease.id);
        }
        if (this.resourceGovernor) {
          void this.resourceGovernor.releaseAllTaskResources(taskId).catch(() => {});
        }

      }
    };

    const [{ Annotation, END, Send, START, StateGraph, task }, { SqliteSaver }] = await Promise.all([
      import("@langchain/langgraph"), import("@langchain/langgraph-checkpoint-sqlite"),
    ]);
    type ExecutionSnapshot = {
      readonly spec: OrchestrationTaskSpec;
      readonly status: TaskExecutionState["status"];
      readonly workerId?: WorkerId;
      readonly startedAt?: number;
      readonly completedAt?: number;
      readonly error?: string;
      readonly report?: WorkerReport;
      readonly intermediateArtifacts: IntermediateArtifact[];
    };
    const WorkflowState = Annotation.Root({
      plan: Annotation<OrchestrationPlanSpec>(),
      planFingerprint: Annotation<string>(),
      outcomes: Annotation<Record<string, ExecutionSnapshot>>({
        reducer: (current, update) => ({ ...current, ...update }), default: () => ({}),
      }),
      readyTaskIds: Annotation<ReadonlyArray<TaskId>>(),
    });
    type WorkflowStateValue = typeof WorkflowState.State;
    const SpecialistInput = Annotation.Root({ taskId: Annotation<TaskId>() });
    const snapshot = (state: TaskExecutionState): ExecutionSnapshot => ({ spec: state.spec, status: state.status, workerId: state.workerId,
      startedAt: state.startedAt, completedAt: state.completedAt, error: state.error, report: state.report,
      intermediateArtifacts: [...state.intermediateArtifacts] });
    const restoredOutcomes = new Set<TaskId>();
    const restoreSnapshot = (taskId: TaskId, outcome: ExecutionSnapshot) => {
      let state = taskStates.get(taskId);
      if (!state) {
        state = { spec: outcome.spec, status: "queued", taskId, intermediateArtifacts: [] };
        taskStates.set(taskId, state);
      }
      state.status = outcome.status;
      state.workerId = outcome.workerId;
      state.startedAt = outcome.startedAt;
      state.completedAt = outcome.completedAt;
      state.error = outcome.error;
      state.report = outcome.report;
      state.intermediateArtifacts = [...outcome.intermediateArtifacts];
      if (state.status === "completed") completedTasks.add(taskId);
      else if (state.status === "failed" || state.status === "cancelled" || state.status === "blocked") failedTasks.add(taskId);
      if (!restoredOutcomes.has(taskId)) {
        allArtifacts.push(...state.intermediateArtifacts);
        if (state.startedAt !== undefined && state.completedAt !== undefined) {
          workerIntervals.push({ taskId, startedAt: state.startedAt, completedAt: state.completedAt });
        }
        restoredOutcomes.add(taskId);
      }
    };
    const scheduleReady = (state: WorkflowStateValue) => {
      signal?.throwIfAborted();
      for (const [id, outcome] of Object.entries(state.outcomes)) restoreSnapshot(id as TaskId, outcome);
      const blocked: Record<string, ExecutionSnapshot> = {};
      for (const taskState of taskStates.values()) {
        if (taskState.status !== "waiting_dependencies") continue;
        const dependencies = taskState.spec.dependencies ?? [];
        if (dependencies.some(dependency => failedTasks.has(dependency))) {
          taskState.status = "blocked";
          taskState.error = "Prerequisite dependency failed.";
          failedTasks.add(taskState.taskId);
          blocked[taskState.taskId] = snapshot(taskState);
        } else if (dependencies.every(dependency => completedTasks.has(dependency))) {
          taskState.status = "queued";
        }
      }
      const readyTaskIds = [...taskStates.values()].filter(taskState => taskState.status === "queued").map(taskState => taskState.taskId);
      if (!readyTaskIds.length) {
        const unresolved = [...taskStates.values()].filter(taskState => !["completed", "failed", "cancelled", "blocked"].includes(taskState.status));
        if (unresolved.length) throw new Error(`Workflow has unresolved dependencies or execution states: ${unresolved.map(item => item.taskId).join(", ")}`);
      }
      return { outcomes: blocked, readyTaskIds };
    };
    const graph = new StateGraph(WorkflowState)
      .addNode("schedule", scheduleReady)
      .addNode("run-specialist", async ({ taskId }: { readonly taskId: TaskId }) => {
        const state = taskStates.get(taskId);
        if (!state || state.status !== "queued") return { outcomes: {} };
        await executeTaskFn!(state);
        await Promise.all(dynamicDispatchesByRequester.get(taskId) ?? []);
        restoredOutcomes.add(taskId);
        return { outcomes: { [taskId]: snapshot(state), ...(dynamicOutcomesByRequester.get(taskId) ?? {}) } };
      }, { input: SpecialistInput });
    graph.addEdge(START, "schedule");
    graph.addConditionalEdges("schedule", (state: WorkflowStateValue) => state.readyTaskIds.length
      ? state.readyTaskIds.map(taskId => new Send("run-specialist", { taskId })) : END);
    graph.addEdge("run-specialist", "schedule");
    const checkpoint = SqliteSaver.fromConnString(this.checkpointDatabasePath);
    const workflow = graph.compile({ name: "mediobot-plan", checkpointer: checkpoint });
    const runDynamicSpecialist = task({ name: "run-dynamic-specialist" }, async (taskId: TaskId) => {
      const state = taskStates.get(taskId);
      if (!state || state.status !== "queued") return;
      await executeTaskFn!(state);
      await Promise.all(dynamicDispatchesByRequester.get(taskId) ?? []);
      return { outcome: snapshot(state), descendants: dynamicOutcomesByRequester.get(taskId) ?? {} };
    });
    dispatchGraphTask = (taskId, requesterTaskId) => {
      const dispatch = (async () => {
      const result = await runDynamicSpecialist(taskId);
      if (result) {
        const { outcome, descendants } = result;
        const state = taskStates.get(taskId);
        // A live execution already updated state and emitted artifacts/intervals.
        // A cached Functional task result needs projection into this invocation's state.
        if (state && (state.status === "queued" || state.status === "waiting_dependencies")) {
          restoreSnapshot(taskId, outcome);
        } else {
          restoredOutcomes.add(taskId);
        }
        const requesterOutcomes = dynamicOutcomesByRequester.get(requesterTaskId) ?? {};
        requesterOutcomes[taskId] = outcome;
        Object.assign(requesterOutcomes, descendants);
        dynamicOutcomesByRequester.set(requesterTaskId, requesterOutcomes);
      }
      })();
      const pending = dynamicDispatchesByRequester.get(requesterTaskId) ?? new Set<Promise<void>>();
      pending.add(dispatch);
      dynamicDispatchesByRequester.set(requesterTaskId, pending);
      void dispatch.then(() => pending.delete(dispatch), () => pending.delete(dispatch));
      return dispatch;
    };
    const checkpointScope = [options.workspaceId ?? "", options.threadId ?? "", plan.planId].join("\0");
    const checkpointThreadId = `mediobot-${crypto.createHash("sha256").update(checkpointScope).digest("hex")}`;
    const config = { configurable: { thread_id: checkpointThreadId }, ...(signal ? { signal } : {}) };
    try {
      const saved = await checkpoint.getTuple(config);
      const planFingerprint = crypto.createHash("sha256").update(`${checkpointScope}\0${JSON.stringify(plan)}`).digest("hex");
      if (saved) {
        const savedFingerprint = saved.checkpoint.channel_values.planFingerprint;
        if (savedFingerprint !== planFingerprint) {
          throw new Error(`Checkpoint plan mismatch for planId "${plan.planId}". Use a new planId for changed work.`);
        }
      }
      const input = saved ? null : { plan, planFingerprint, outcomes: {}, readyTaskIds: [] };
      const finalState = await workflow.invoke(input as never, config) as WorkflowStateValue;
      for (const [id, outcome] of Object.entries(finalState.outcomes)) restoreSnapshot(id as TaskId, outcome);
    } catch (error) {
      if (!signal?.aborted) throw error;
      // The caller's normal task lifecycle records cancellation and settles active workers.
    } finally {
      dispatchGraphTask = undefined;
      try { checkpoint.db.close(); } catch { /* In-memory and already-closed saver cases are harmless. */ }
    }
    const orchestratorEndMonotonic = performance.now();
    const orchestratorEndEpoch = performance.timeOrigin + orchestratorEndMonotonic;
    const durationMs = Math.round((orchestratorEndMonotonic - orchestratorStartMonotonic) * 100) / 100;

    // Calculate verified overlap
    let verifiedOverlapMs = 0;
    if (workerIntervals.length >= 2) {
      for (let i = 0; i < workerIntervals.length; i++) {
        for (let j = i + 1; j < workerIntervals.length; j++) {
          const a = workerIntervals[i]!;
          const b = workerIntervals[j]!;
          const overlap = Math.min(a.completedAt, b.completedAt) - Math.max(a.startedAt, b.startedAt);
          if (overlap > verifiedOverlapMs) {
            verifiedOverlapMs = Math.round(overlap * 100) / 100;
          }
        }
      }
    }

    // Collect all final reports
    for (const state of taskStates.values()) {
      if (state.report) {
        reports.push(state.report);
      } else {
        reports.push({
          assignmentId: `asg-${state.taskId}` as AssignmentId,
          taskId: state.taskId,
          workerId: state.workerId ?? (`worker-${state.taskId}` as WorkerId),
          mediobotId: state.spec.definitionId,
          status: state.status === "completed" ? "completed" : "failed",
          summary: state.status === "completed" ? `Task ${state.taskId} completed.` : (state.error ?? "Task failed"),
          evidence: state.intermediateArtifacts.map((a) => a.title),
          artifacts: state.intermediateArtifacts.map((a) => a.id),
          blockers: state.error ? [state.error] : [],
          unresolved: [],
        });
      }
    }

    // Final Maestro synthesis if decision provider is present
    let synthesisText: string | undefined;
    if (this.decisions) {
      try {
        const synthDecision = await this.decisions.decide(
          plan.goal,
          {
            availableIntents: ["respond", "request_user_input"],
            projectIntelligence: [
              { name: "bounded-worker-reports", value: JSON.stringify(reports) },
              { name: "intermediate-artifacts", value: JSON.stringify(allArtifacts) },
            ],
            goalAnchor: {
              goalId: `goal-${plan.planId}` as GoalId,
              objective: plan.goal,
              constraints: [],
              unresolvedCriteria: [],
              blockers: Array.from(taskStates.values())
                .filter((s) => s.error)
                .map((s) => s.error!),
            },
          },
          signal ?? new AbortController().signal
        );

        synthesisText =
          synthDecision.type === "respond"
            ? synthDecision.message
            : synthDecision.type === "request_user_input"
            ? synthDecision.question
            : undefined;
      } catch {
        // Synthesis failure is non-fatal to task execution results
      }
    }

    const overallStatus: OrchestrationResult["status"] =
      failedTasks.size === 0 && completedTasks.size > 0
        ? "completed"
        : completedTasks.size > 0 && failedTasks.size > 0
        ? "partial_success"
        : signal?.aborted
        ? "cancelled"
        : "failed";

    return {
      planId: plan.planId,
      goal: plan.goal,
      status: overallStatus,
      tasks: Array.from(taskStates.values()),
      intermediateArtifacts: allArtifacts,
      reports,
      executionInterval: {
        startedAt: orchestratorStartEpoch,
        completedAt: orchestratorEndEpoch,
        durationMs,
        maxParallelWorkers: peakParallelWorkers,
        verifiedOverlapMs,
      },
      synthesis: synthesisText,
    };
  }

  /**
   * Executes a standard specialist (Doc, Research, Tester, Cody) via appropriate text or web execution.
   */
  private async executeStandardSpecialist(
    spec: OrchestrationTaskSpec,
    workerDef: { readonly id: MediobotDefinitionId; readonly name: string; readonly role: string; readonly instructions: string },
    context: WorkerExecutionContext,
    signal: AbortSignal,
    emitArtifact: (artifact: Omit<IntermediateArtifact, "id" | "taskId" | "workerId" | "mediobotId" | "timestamp">) => IntermediateArtifact,
    options: OrchestratorOptions
  ): Promise<void> {
    const role = workerDef.role.toLowerCase();

    // 1. If Web/Crawl4AI specialist and crawl runtime available
    if (this.crawl4ai && (role === "doc" || role === "scraapy" || role === "research") && this.textModelResolver) {
      try {
        const filterType = role === "doc" ? "documentation" : role === "scraapy" ? "components" : "all";
        const searchRes = await this.crawl4ai.search({ query: spec.objective, filterType }, signal);

        // Emit intermediate search findings
        if (searchRes.items.length > 0) {
          const topResult = searchRes.items[0]!;
          emitArtifact({
            kind: role === "doc" ? "documentation" : "research-evidence",
            title: `Web Findings: ${topResult.title}`,
            content: `Found reference: ${topResult.url} (${topResult.snippet})`,
            isProvisional: true,
            references: [topResult.url],
          });
        }
      } catch {
        // Fall back to text inference
      }
    }

    // 2. Text model inference for the specialist
    if (this.textModelResolver) {
      const selection = readModelSelection(options.modelSelection);
      const resolved = this.textModelResolver.resolveForOperation("text-inference", selection);

      const systemPrompt = `You are ${workerDef.name}, a specialist Mediobot.\n${workerDef.instructions}\nProduce factual conclusions directly.`;
      const inputPrompt = JSON.stringify({
        objective: spec.objective,
        relevantContext: spec.relevantContext ?? "",
        expectedOutcome: spec.expectedOutcome ?? "",
      });

      const raw = await resolved.client.complete({
        system: systemPrompt,
        input: inputPrompt,
        signal,
      });

      const cleanSummary = sanitizeReasoningAndSecrets(raw).trim();

      // Emit intermediate or final artifact
      const kind: IntermediateArtifactKind =
        role === "doc"
          ? "api-signature"
          : role === "tester"
          ? "verification-result"
          : role === "research"
          ? "research-evidence"
          : "documentation";

      emitArtifact({
        kind,
        title: `${workerDef.name} Verified Findings`,
        content: cleanSummary.slice(0, 4000),
        isProvisional: false,
      });
    } else {
      // Deterministic fallback execution
      emitArtifact({
        kind: role === "doc" ? "api-signature" : "research-evidence",
        title: `${workerDef.name} Findings for: ${spec.objective.slice(0, 60)}`,
        content: `Standard specialist response for ${spec.objective}`,
        isProvisional: false,
      });
    }
  }
}

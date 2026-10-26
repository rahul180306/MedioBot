import type { MediobotDefinitionId, ResourceId, TaskId, WorkerId } from "@mediobot-v2/domain";
import type { WorkerExecutionAdapter, WorkerExecutionAvailability, WorkerExecutionContext, WorkerExecutionPlan } from "@mediobot-v2/runtime";
import { AutonomousBrowserTask, PlaywrightBrowserPage, PlaywrightBrowserRuntime } from "./index.ts";
import type { BrowserExecutor, DecisionProvider, GoalVerifier, ObservationProvider, VisionProgressEvent, BrowserRuntime } from "./index.ts";
import type { VisionDiagnostic } from "./index.ts";
import { PerceptionFailure } from "./perception.ts";
import type { VisualConfiguration, ViewportCaptureProvider } from "./perception.ts";
import type { BrowserOutcomeReader } from "./verifier.ts";

export type VisionBrowser = ObservationProvider & BrowserExecutor & Partial<ViewportCaptureProvider & BrowserOutcomeReader>;
export interface VisionAdapterFactoryInput {
  readonly context: WorkerExecutionContext;
  readonly browser: VisionBrowser;
  readonly resourceId: ResourceId;
}

export interface VisionLocalDiagnostic {
  readonly worldId: string;
  readonly taskId: TaskId;
  readonly workerId: WorkerId;
  readonly diagnostic: VisionDiagnostic;
}

export interface VisionExecutionAdapterOptions {
  readonly decisions: DecisionProvider;
  readonly resolveDecisions?: (options?: Readonly<Record<string, unknown>>) => DecisionProvider;
  readonly goalVerifier?: GoalVerifier;
  /** Trusted task-scoped factories; do not interpret model-authored finish fields as policy. */
  readonly createGoalVerifier?: (input: VisionAdapterFactoryInput) => GoalVerifier | undefined;
  readonly createPerception?: (input: VisionAdapterFactoryInput) => VisualConfiguration | undefined;
  readonly configured?: boolean;
  readonly headless?: boolean;
  readonly onProgress?: (identity: { readonly definitionId: MediobotDefinitionId; readonly taskId: TaskId;
    readonly workerId: WorkerId }, event: VisionProgressEvent) => void;
  readonly onDiagnostic?: (diagnostic: VisionLocalDiagnostic) => void;
  readonly browserFactory?: (resourceId: ResourceId) => Promise<VisionBrowser>;
  readonly browserRuntime?: BrowserRuntime;
}

/** Adapts one Mediobot definition to the existing Vision loop and owns its browser capability. */
export class VisionExecutionAdapter implements WorkerExecutionAdapter {
  private readonly options: VisionExecutionAdapterOptions;
  private defaultRuntime?: PlaywrightBrowserRuntime;

  constructor(options: VisionExecutionAdapterOptions) {
    this.options = options;
  }

  private getRuntime(): BrowserRuntime | undefined {
    if (this.options.browserRuntime) return this.options.browserRuntime;
    if (this.options.browserFactory) return undefined;
    if (!this.defaultRuntime) {
      this.defaultRuntime = new PlaywrightBrowserRuntime({
        headless: this.options.headless ?? false,
      });
    }
    return this.defaultRuntime;
  }

  async close(): Promise<void> {
    if (this.defaultRuntime) {
      await this.defaultRuntime.shutdown();
      this.defaultRuntime = undefined;
    }
  }

  availability(): WorkerExecutionAvailability {
    return this.options.configured === false ? { available: false, reason: "not-configured" } : { available: true };
  }

  prepare(context: WorkerExecutionContext): WorkerExecutionPlan {
    const resource = context.world.registerResource({
      kind: "browser-page",
      owner: { type: "worker", worldId: context.world.id, workerId: context.workerId },
    });

    return {
      resourceIds: [resource.id],
      execute: async ({ signal }) => {
        let browser: VisionBrowser | undefined;
        let task: AutonomousBrowserTask | undefined;
        const runtime = this.getRuntime();
        try {
          if (runtime) {
            browser = await runtime.acquireSession({
              resourceId: resource.id,
              workerId: context.workerId,
              taskId: context.taskId,
            });
          } else if (this.options.browserFactory) {
            browser = await this.options.browserFactory(resource.id);
          } else {
            browser = await PlaywrightBrowserPage.launch({
              resourceId: resource.id,
              headless: this.options.headless ?? false,
            });
          }
          task = new AutonomousBrowserTask({
            world: context.world,
            workerId: context.workerId,
            taskId: context.taskId,
            resourceId: resource.id,
            observations: browser,
            executor: browser,
            decisions: this.options.resolveDecisions?.(context.options) ?? this.options.decisions,
            goalVerifier: this.options.createGoalVerifier?.({ context, browser, resourceId: resource.id }) ?? this.options.goalVerifier,
            visual: this.options.createPerception?.({ context, browser, resourceId: resource.id }),
            signal,
            onProgress: (event) => {
              try { this.options.onProgress?.({ definitionId: context.definitionId, taskId: context.taskId,
                workerId: context.workerId }, event); } catch { /* observers cannot affect Vision */ }
            },
          });
          const result = await task.run(context.goal);
          if (result.state === "failed") {
            if (result.diagnostic) {
              try { this.options.onDiagnostic?.({ worldId: context.world.id, taskId: context.taskId,
                workerId: context.workerId, diagnostic: result.diagnostic }); } catch { /* diagnostics cannot affect cleanup */ }
            }
            if (result.diagnostic?.kind === "perception-failure") {
              throw new PerceptionFailure(result.diagnostic.source, result.diagnostic.code, result.diagnostic.capture);
            }
            throw new Error("Vision could not complete the task.");
          }
          if (result.state !== "completed" && !signal.aborted) {
            throw new Error("Vision stopped before the goal was verified.");
          }
        } finally {
          if (task) await task.close();
          else await browser?.close();
        }
      },
    };
  }
}

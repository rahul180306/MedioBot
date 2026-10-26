import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, BrowserContext, ElementHandle, Page } from "playwright";
import { chromium } from "playwright";
import type { ResourceId, TaskId, WorkerId, WorldId } from "@mediobot-v2/domain";
import { InMemoryWorld } from "@mediobot-v2/domain";
import { ModelActionValidationError, validateDecision } from "./model.ts";
import type { ModelActionDiagnostic } from "./model.ts";
import { validateVisualFacts, PerceptionFailure, safePerceptionFailure } from "./perception.ts";
import type { PerceptionFailureDiagnostic, CaptureStage } from "./perception.ts";
import type { VisualConfiguration, VisualEnvelope, VisualProvenance } from "./perception.ts";
import type { BrowserOutcomePredicate } from "./verifier.ts";

export interface ObservedElement {
  readonly id: string;
  readonly role: string;
  readonly name: string;
  readonly text?: string;
  readonly enabled: boolean;
  readonly value?: string;
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface BrowserObservation {
  readonly revision: number;
  readonly fingerprint: string;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly elements: ReadonlyArray<ObservedElement>;
}

export type BrowserAction =
  | { readonly type: "click"; readonly targetId: string; readonly observationRevision: number }
  | { readonly type: "type"; readonly targetId: string; readonly value: string; readonly observationRevision: number }
  | { readonly type: "press"; readonly key: string; readonly observationRevision: number }
  | { readonly type: "scroll"; readonly deltaY: number; readonly observationRevision: number }
  | { readonly type: "navigate"; readonly url: string; readonly observationRevision: number }
  | { readonly type: "select"; readonly targetId: string; readonly value: string; readonly observationRevision: number }
  | { readonly type: "wait"; readonly milliseconds?: number; readonly observationRevision: number }
  | { readonly type: "finish"; readonly observationRevision: number };

export interface ObservationProvider {
  observe(signal: AbortSignal): Promise<BrowserObservation>;
  /** A fresh AFTER sample. Never validate it against the obsolete BEFORE revision. */
  observeAfterAction?(before: BrowserObservation, signal: AbortSignal): Promise<BrowserObservation>;
}

export interface BrowserExecutor {
  /** Implementations must abort in-flight effects when signal is aborted and must terminate them on close. */
  execute(action: BrowserAction, observation: BrowserObservation, signal: AbortSignal): Promise<BrowserExecutionResult>;
  close(): Promise<void>;
}

export type BrowserExecutionResult =
  | { readonly state: "accepted"; readonly intendedEffect?: GoalVerificationState }
  | { readonly state: "rejected-before-mutation"; readonly reason: "busy" | "stale-observation" | "invalid-target" | "invalid-action" | "resource-unavailable" }
  | { readonly state: "execution-error" }
  | { readonly state: "cancelled" };

export type GoalVerificationState = "verified" | "not-verified" | "unknown";

export interface GoalVerifier {
  verify(input: { readonly goal: string; readonly observation: BrowserObservation;
    readonly evidence: ReadonlyArray<ActionAttemptEvidence>; readonly signal: AbortSignal }): Promise<GoalVerificationState>;
}

/** Conservative default: observing a page is not enough to infer arbitrary natural-language goal success. */
export class UnknownGoalVerifier implements GoalVerifier {
  async verify(): Promise<GoalVerificationState> { return "unknown"; }
}

export interface ActionAttemptEvidence {
  readonly worldId: WorldId;
  readonly workerId: WorkerId;
  readonly taskId: TaskId;
  readonly resourceId: ResourceId;
  readonly step: number;
  readonly actionType: BrowserAction["type"];
  readonly actionObservationRevision: number;
  readonly beforeObservation: { readonly revision: number; readonly fingerprint: string };
  readonly afterObservation?: { readonly revision: number; readonly fingerprint: string };
  readonly changed?: boolean;
  readonly intendedEffect?: GoalVerificationState;
  readonly execution: "accepted" | "rejected-before-mutation" | "execution-error" | "cancelled" | "not-required";
  readonly rejectionReason?: Extract<BrowserExecutionResult, { state: "rejected-before-mutation" }>["reason"];
  readonly effect: "observable-change" | "no-observable-change" | "wait-state-change" | "finish-requested"
    | "execution-failed" | "execution-rejected" | "cancelled" | "unknown";
  readonly goalVerification?: GoalVerificationState;
}

export interface DecisionProvider {
  decide(goal: string, observation: BrowserObservation, history: ReadonlyArray<HistoryEntry>, signal: AbortSignal,
    visual?: VisualEnvelope): Promise<BrowserAction>;
}

export interface HistoryEntry {
  readonly observation: BrowserObservation;
  readonly action: BrowserAction;
  readonly after: BrowserObservation;
  readonly progress: "action-effect-observed" | "no-effect" | "state-changed";
  readonly intendedEffect?: GoalVerificationState;
}

export interface StepTiming {
  readonly observationMs: number;
  readonly decisionMs: number;
  readonly actionMs: number;
  readonly verificationMs: number;
  readonly totalMs: number;
}

export interface BrowserFailureDiagnostic {
  readonly kind: "browser-failure";
  readonly code: "action-failed" | "observation-failed" | "observation-stale" | "stalled";
}
class BrowserTaskFailure extends Error {
  readonly diagnostic: BrowserFailureDiagnostic;
  constructor(code: BrowserFailureDiagnostic["code"], message: string) {
    super(message);
    this.diagnostic = Object.freeze({ kind: "browser-failure", code });
  }
}
export type VisionDiagnostic = ModelActionDiagnostic | PerceptionFailureDiagnostic | BrowserFailureDiagnostic;

export type BrowserTaskResult =
  | { readonly state: "completed"; readonly history: ReadonlyArray<HistoryEntry>; readonly evidence: ReadonlyArray<ActionAttemptEvidence>; readonly timings: ReadonlyArray<StepTiming> }
  | { readonly state: "cancelled"; readonly history: ReadonlyArray<HistoryEntry>; readonly evidence: ReadonlyArray<ActionAttemptEvidence>; readonly timings: ReadonlyArray<StepTiming> }
  | { readonly state: "failed"; readonly error: string; readonly history: ReadonlyArray<HistoryEntry>; readonly evidence: ReadonlyArray<ActionAttemptEvidence>; readonly timings: ReadonlyArray<StepTiming>; readonly diagnostic?: VisionDiagnostic };

export interface VisionProgressEvent {
  readonly type: "started" | "observation" | "action" | "verified" | "finish-requested" | "goal-verified" | "cancelled" | "failed";
  readonly step?: number;
  readonly actionType?: BrowserAction["type"];
  readonly progress?: HistoryEntry["progress"];
  readonly targetId?: string;
  readonly observationSummary?: string;
  readonly timing?: StepTiming;
  readonly message?: string;
  readonly diagnostic?: VisionDiagnostic;
}

export interface AutonomousBrowserTaskOptions {
  readonly world: InMemoryWorld;
  readonly workerId: WorkerId;
  readonly taskId: TaskId;
  readonly resourceId: ResourceId;
  readonly observations: ObservationProvider;
  readonly executor: BrowserExecutor;
  readonly decisions: DecisionProvider;
  readonly goalVerifier?: GoalVerifier;
  readonly visual?: VisualConfiguration;
  readonly signal?: AbortSignal;
  readonly maxSteps?: number;
  readonly maxHistory?: number;
  readonly actionTimeoutMs?: number;
  readonly providerTimeoutMs?: number;
  readonly onProgress?: (event: VisionProgressEvent) => void;
}

export class AutonomousBrowserTask {
  private readonly history: HistoryEntry[] = [];
  private readonly evidence: ActionAttemptEvidence[] = [];
  private readonly timings: StepTiming[] = [];
  private readonly controller = new AbortController();
  private readonly options: AutonomousBrowserTaskOptions;
  private externalAbort?: () => void;
  private running = false;
  private closed = false;
  private runPromise?: Promise<BrowserTaskResult>;
  private visualCalls = 0;

  constructor(options: AutonomousBrowserTaskOptions) {
    if (options.executor instanceof PlaywrightBrowserPage && options.executor.resourceId !== options.resourceId) {
      throw new Error("Playwright page is bound to a different browser resource");
    }
    this.options = options;
    if (options.visual && (!Number.isInteger(options.visual.policy.maxCalls) || options.visual.policy.maxCalls < 1
      || options.visual.policy.maxCalls > 20)) throw new Error("Visual maxCalls must be an integer from 1 to 20");
    if (options.visual) this.options = { ...options, visual: { ...options.visual, policy: Object.freeze({ ...options.visual.policy }) } };
  }

  run(goal: string): Promise<BrowserTaskResult> {
    if (this.running || this.closed) throw new Error("Browser task is not available");
    if (!goal.trim()) throw new Error("A task goal is required");
    this.running = true;
    this.externalAbort = () => this.controller.abort();
    if (this.options.signal?.aborted) this.controller.abort();
    else this.options.signal?.addEventListener("abort", this.externalAbort, { once: true });
    this.runPromise = this.runLoop(goal);
    return this.runPromise;
  }

  private async runLoop(goal: string): Promise<BrowserTaskResult> {
    const { world, workerId, taskId, resourceId } = this.options;
    const base = () => ({ history: [...this.history], evidence: [...this.evidence], timings: [...this.timings] });
    try {
      this.assertOwnership();
      world.appendEvent({ type: "vision.started", workerId, taskId, resourceId });
      this.report({ type: "started" });
      if (this.controller.signal.aborted) return this.finish("cancelled");
      const runStarted = performance.now();
      let observationStart = performance.now();
      let observation = await this.withProviderTimeout(
        (signal) => this.options.observations.observe(signal), "observation",
      );
      let observationMs = performance.now() - observationStart;
      this.report({ type: "observation", step: 1, observationSummary: summarizeObservation(observation),
        timing: { observationMs, decisionMs: 0, actionMs: 0, verificationMs: 0, totalMs: observationMs } });
      let noProgress = 0;
      const maxSteps = this.options.maxSteps ?? 20;
      for (let step = 0; step < maxSteps; step += 1) {
        const stepStart = step === 0 ? runStarted : performance.now();
        if (this.controller.signal.aborted) return this.finish("cancelled");
        this.assertOwnership();
        const decisionStart = performance.now();
        const visual = await this.perceive(observation, noProgress);
        const candidate = await this.withProviderTimeout((signal) => this.options.decisions.decide(
          goal, observation, this.history.slice(-(this.options.maxHistory ?? 12)), signal, visual,
        ), "decision");
        // All providers cross the same canonical boundary; retain and check the supplied revision.
        if (!candidate || !Number.isSafeInteger(candidate.observationRevision)) {
          throw new Error("Invalid browser decision revision");
        }
        const { observationRevision: _revision, ...payload } = candidate;
        const action = validateDecision(JSON.stringify(payload), observation);
        this.assertOwnership();
        if (candidate.observationRevision !== observation.revision) {
          this.recordEvidence({ step: step + 1, action: { ...action, observationRevision: candidate.observationRevision }, observation,
            execution: "rejected-before-mutation", rejectionReason: "stale-observation", effect: "execution-rejected" });
          throw new BrowserTaskFailure("observation-stale", "Decision references a stale observation");
        }
        const decisionMs = performance.now() - decisionStart;
        this.report({ type: "action", step: step + 1, actionType: action.type,
          ...( "targetId" in action ? { targetId: action.targetId } : {}) });
        this.assertOwnership();
        if (action.type === "finish") {
          this.report({ type: "finish-requested", step: step + 1, actionType: action.type,
            observationSummary: summarizeObservation(observation) });
          world.appendEvent({ type: "vision.finish-requested", workerId, taskId, resourceId });
          const verifyStart = performance.now();
          const finishBefore = observation;
          observation = await this.withProviderTimeout(signal => this.options.observations.observe(signal), "observation");
          let goalVerification: GoalVerificationState;
          try {
            goalVerification = await this.withProviderTimeout((signal) => (this.options.goalVerifier ?? new UnknownGoalVerifier()).verify({
              goal, observation, evidence: [...this.evidence], signal,
            }), "verification");
            const verifiedObservation = observation;
            observation = await this.withProviderTimeout(signal => this.options.observations.observe(signal), "observation");
            if (goalVerification === "verified" && (observation.revision !== verifiedObservation.revision
              || observation.fingerprint !== verifiedObservation.fingerprint)) goalVerification = "not-verified";
          } catch (error) {
            this.recordEvidence({ step: step + 1, action, observation: finishBefore, after: observation, execution: "not-required",
              effect: "finish-requested", goalVerification: "unknown" });
            throw error;
          }
          const verificationMs = performance.now() - verifyStart;
          this.recordEvidence({ step: step + 1, action, observation: finishBefore, after: observation, execution: "not-required",
            effect: "finish-requested", goalVerification });
          const timing = { observationMs, decisionMs, actionMs: 0, verificationMs, totalMs: performance.now() - stepStart };
          this.timings.push(timing);
          if (goalVerification === "verified") {
            this.assertOwnership();
            this.report({ type: "goal-verified", step: step + 1, actionType: action.type, timing });
            world.appendEvent({ type: "vision.goal-verified", workerId, taskId, resourceId });
            return this.finish("completed");
          }
          noProgress += 1;
          if (noProgress >= 3) throw new Error("Goal completion could not be verified after repeated finish requests");
          continue;
        }
        const beforeAction = observation;
        this.assertOwnership();
        const actionResult = await this.withTimeout((signal) => this.options.executor.execute(action, beforeAction, signal));
        if (actionResult.execution.state === "cancelled") {
          this.recordEvidence({ step: step + 1, action, observation: beforeAction, execution: "cancelled", effect: "cancelled" });
          return this.finish("cancelled");
        }
        observationStart = performance.now();
        let after: BrowserObservation | undefined;
        let observationError: unknown;
        try {
          after = await this.withProviderTimeout((signal) => this.options.observations.observeAfterAction
            ? this.options.observations.observeAfterAction(beforeAction, signal)
            : this.options.observations.observe(signal), "observation");
        } catch (error) { observationError = error; /* record uncertainty before ending the task */ }
        observationMs = performance.now() - observationStart;
        const verifyStart = performance.now();
        const same = after ? beforeAction.fingerprint === after.fingerprint : undefined;
        const execution = actionResult.execution;
        const effect = execution.state === "execution-error" ? "execution-failed"
          : execution.state === "rejected-before-mutation" ? "execution-rejected"
            : same === undefined ? "unknown"
              : action.type === "wait" && !same ? "wait-state-change"
                : same ? "no-observable-change" : "observable-change";
        this.recordEvidence({ step: step + 1, action, observation: beforeAction, after, execution: execution.state,
          ...(execution.state === "accepted" ? { intendedEffect: execution.intendedEffect ?? "unknown" } : {}),
          ...(execution.state === "rejected-before-mutation" ? { rejectionReason: execution.reason } : {}), effect });
        if (execution.state === "execution-error") throw new BrowserTaskFailure("action-failed", "Browser action execution failed; the action was not retried");
        if (!after) throw observationError instanceof PerceptionFailure ? observationError
          : new BrowserTaskFailure("observation-failed", "Browser state could not be observed after the action");
        const progress = execution.state === "rejected-before-mutation" ? "no-effect"
          : action.type === "wait" && !same ? "state-changed"
            : same ? "no-effect" : "action-effect-observed";
        noProgress = progress === "no-effect" || (execution.state === "accepted" && execution.intendedEffect === "not-verified") ? noProgress + 1 : 0;
        this.history.push({ observation: beforeAction, action, after, progress,
          ...(execution.state === "accepted" ? { intendedEffect: execution.intendedEffect ?? "unknown" } : {}) });
        const limit = this.options.maxHistory ?? 12;
        if (this.history.length > limit) this.history.splice(0, this.history.length - limit);
        const verificationMs = performance.now() - verifyStart;
        const timing = { observationMs, decisionMs, actionMs: actionResult.elapsedMs, verificationMs,
          totalMs: performance.now() - stepStart };
        this.timings.push(timing);
        this.report({ type: "verified", step: step + 1, actionType: action.type, progress, timing,
          observationSummary: summarizeObservation(after) });
        world.appendEvent({ type: "vision.step", workerId, taskId, resourceId });
        observation = after;
        if (noProgress >= 3) throw new BrowserTaskFailure("stalled", "Stopped after repeated actions made no observable progress");
      }
      throw new Error(`Maximum step limit (${maxSteps}) reached before task completion was verified`);
    } catch (error) {
      if (this.controller.signal.aborted) return this.finish("cancelled");
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = error instanceof ModelActionValidationError || error instanceof PerceptionFailure || error instanceof BrowserTaskFailure ? error.diagnostic : undefined;
      this.report({ type: "failed", message, ...(diagnostic ? { diagnostic } : {}) });
      try {
        this.assertOwnership();
        world.appendEvent({ type: "vision.failed", workerId, taskId, resourceId });
      } catch {
        // Invalid ownership must fail closed without recording against a claimed resource.
      }
      return { state: "failed", error: message, ...base(), ...(diagnostic ? { diagnostic } : {}) };
    } finally {
      this.options.signal?.removeEventListener("abort", this.externalAbort!);
      this.running = false;
      this.runPromise = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.running) this.controller.abort();
    await this.runPromise?.catch(() => undefined);
    await this.options.executor.close();
  }

  private recordEvidence(input: { readonly step: number; readonly action: BrowserAction; readonly observation: BrowserObservation;
    readonly after?: BrowserObservation; readonly execution: ActionAttemptEvidence["execution"];
    readonly rejectionReason?: ActionAttemptEvidence["rejectionReason"]; readonly effect: ActionAttemptEvidence["effect"];
    readonly goalVerification?: GoalVerificationState; readonly intendedEffect?: GoalVerificationState }): ActionAttemptEvidence {
    const { world, workerId, taskId, resourceId } = this.options;
    const record: ActionAttemptEvidence = {
      worldId: world.id, workerId, taskId, resourceId, step: input.step, actionType: input.action.type,
      actionObservationRevision: input.action.observationRevision,
      beforeObservation: { revision: input.observation.revision, fingerprint: input.observation.fingerprint },
      ...(input.after ? { afterObservation: { revision: input.after.revision, fingerprint: input.after.fingerprint },
        changed: input.observation.fingerprint !== input.after.fingerprint } : {}),
      execution: input.execution, ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
      effect: input.effect, ...(input.goalVerification ? { goalVerification: input.goalVerification } : {}),
      ...(input.intendedEffect ? { intendedEffect: input.intendedEffect } : {}),
    };
    this.evidence.push(record);
    this.assertOwnership();
    world.recordEvidence({ taskId, workerId, source: { type: "browser-outcome", reference: resourceId },
      subject: resourceId, revision: input.after?.fingerprint ?? input.observation.fingerprint,
      kind: input.goalVerification ? "browser-task-outcome" : "browser-action-attempt",
      validity: input.goalVerification === "verified" ? "verified" : "observed", content: JSON.stringify(record) });
    return record;
  }

  private finish(state: "completed" | "cancelled"): BrowserTaskResult {
    if (state === "cancelled") this.report({ type: state });
    try {
      this.assertOwnership();
      if (state === "cancelled") this.options.world.appendEvent({ type: "vision.cancelled", workerId: this.options.workerId,
        taskId: this.options.taskId, resourceId: this.options.resourceId });
    } catch {
      // A stale task may return its local outcome, but cannot emit an event against released ownership.
    }
    const result = { history: [...this.history], evidence: [...this.evidence], timings: [...this.timings] };
    if (state === "cancelled") return { state: "cancelled", ...result };
    return { state: "completed", ...result };
  }

  private assertOwnership(): void {
    const { world, workerId, taskId, resourceId } = this.options;
    const snapshot = world.inspect();
    const worker = snapshot.workers.find((item) => item.id === workerId);
    const task = snapshot.tasks.find((item) => item.id === taskId);
    const resource = snapshot.resources.find((item) => item.id === resourceId);
    if (!worker || worker.state !== "busy" || !task || task.state !== "running" || task.assignedWorkerId !== workerId
      || !resource || resource.kind !== "browser-page" || resource.state !== "in-use"
      || !((resource.owner.type === "worker" && resource.owner.workerId === workerId)
        || (resource.owner.type === "task" && resource.owner.taskId === taskId))) {
      throw new Error("Browser page resource is not owned by the running worker task");
    }
  }

  private report(event: VisionProgressEvent): void {
    try { this.options.onProgress?.(event); } catch { /* progress observers must not affect task execution */ }
  }

  private async perceive(observation: BrowserObservation, noProgress: number): Promise<VisualEnvelope | undefined> {
    const visual = this.options.visual;
    if (!visual) return undefined;
    const ambiguous = observation.elements.some((e, i, all) => e.enabled && (!e.name.trim()
      || all.some((other, j) => i !== j && other.enabled && other.role === e.role && other.name === e.name)));
    if (!visual.policy.required && !(visual.policy.onAmbiguity && ambiguous) && !(visual.policy.onNoEffect && noProgress > 0)) return undefined;
    if (this.visualCalls >= visual.policy.maxCalls) {
      if (visual.policy.required) throw new Error("Visual perception budget exhausted");
      return undefined;
    }
    this.visualCalls += 1;
    const envelope = await this.withProviderTimeout(signal => visual.captures.withViewportCapture(observation, signal,
      async (bytes, provenance) => {
        if (provenance.resourceId !== this.options.resourceId || provenance.revision !== observation.revision
          || provenance.fingerprint !== observation.fingerprint) throw new Error("Visual capture binding mismatch");
        let proposed: unknown;
        try { proposed = await visual.provider.perceive({ observation, bytes, provenance, signal }); }
        catch (error) { signal.throwIfAborted(); throw safePerceptionFailure(error, "model"); }
        let facts;
        try { facts = validateVisualFacts(proposed, observation, provenance); }
        catch { throw new PerceptionFailure("model", "invalid-response"); }
        signal.throwIfAborted();
        return Object.freeze({ provenance: Object.freeze({ ...provenance }), facts });
      }), "perception").catch(error => { throw safePerceptionFailure(error); });
    this.assertOwnership();
    this.options.world.recordEvidence({ taskId: this.options.taskId, workerId: this.options.workerId,
      source: { type: "browser-perception", reference: this.options.resourceId }, kind: "visual-observation",
      subject: this.options.resourceId, revision: observation.fingerprint, validity: "observed",
      content: JSON.stringify({ provenance: envelope.provenance, factCount: envelope.facts.length }) });
    return envelope;
  }

  private async withTimeout(run: (signal: AbortSignal) => Promise<BrowserExecutionResult>): Promise<{
    readonly execution: BrowserExecutionResult; readonly elapsedMs: number
  }> {
    const timeout = this.options.actionTimeoutMs ?? 15_000;
    if (this.controller.signal.aborted) return { execution: { state: "cancelled" }, elapsedMs: 0 };
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (this.controller.signal.aborted) controller.abort();
    else this.controller.signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancellation!: () => void;
    try {
      const start = performance.now();
      const result = await Promise.race([
        run(controller.signal).then((execution) => ({ kind: "result" as const, execution }),
          () => ({ kind: "error" as const })),
        new Promise<{ readonly kind: "timeout" }>((resolve) => { timer = setTimeout(() => {
          controller.abort(); resolve({ kind: "timeout" });
        }, timeout); }),
        new Promise<{ readonly kind: "cancelled" }>((resolve) => {
          rejectCancellation = () => resolve({ kind: "cancelled" });
          if (this.controller.signal.aborted) rejectCancellation();
          else this.controller.signal.addEventListener("abort", rejectCancellation, { once: true });
        }),
      ]);
      const elapsed = performance.now() - start;
      if (result.kind === "timeout") {
        try { await this.options.executor.close(); } catch { /* timeout remains an uncertain execution failure */ }
        finally { this.closed = true; }
        return { execution: { state: "execution-error" }, elapsedMs: elapsed };
      }
      if (result.kind === "cancelled" || this.controller.signal.aborted) {
        return { execution: { state: "cancelled" }, elapsedMs: elapsed };
      }
      return { execution: result.kind === "error" ? { state: "execution-error" } : result.execution, elapsedMs: elapsed };
    } finally {
      if (timer) clearTimeout(timer);
      this.controller.signal.removeEventListener("abort", abort);
      this.controller.signal.removeEventListener("abort", rejectCancellation);
    }
  }

  private async withProviderTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    operation: "observation" | "decision" | "verification" | "perception",
  ): Promise<T> {
    const timeout = this.options.providerTimeoutMs ?? 30_000;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (this.controller.signal.aborted) controller.abort();
    else this.controller.signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancellation!: () => void;
    try {
      return await Promise.race([
        run(controller.signal),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(operation === "perception" ? new PerceptionFailure("environment", "timeout")
              : new Error(`Browser ${operation} timed out after ${timeout} ms`));
          }, timeout);
        }),
        new Promise<T>((_, reject) => {
          rejectCancellation = () => reject(new Error("Browser task cancelled"));
          if (this.controller.signal.aborted) rejectCancellation();
          else this.controller.signal.addEventListener("abort", rejectCancellation, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.controller.signal.removeEventListener("abort", abort);
      this.controller.signal.removeEventListener("abort", rejectCancellation);
    }
  }
}

function summarizeObservation(observation: BrowserObservation): string {
  return JSON.stringify({ url: observation.url.slice(0, 180), title: observation.title.slice(0, 120),
    elementCount: observation.elements.length, text: observation.text.replace(/\s+/g, " ").slice(0, 240) });
}

export interface ViewportDimensions {
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_VIEWPORT: ViewportDimensions = Object.freeze({ width: 1280, height: 720 });

export interface PlaywrightBrowserPageOptions {
  readonly resourceId: ResourceId;
  readonly headless?: boolean;
  /** Optional process owner; this page still creates/owns its isolated context. */
  readonly browser?: Browser;
  /** Explicit viewport for the new context. Avoids the native-window resize flash that occurs
   *  when Playwright applies its default 1280×720 emulation after the OS creates the window
   *  at its own default size. Pass `null` to disable viewport emulation entirely. */
  readonly viewport?: ViewportDimensions | null;
  readonly onClose?: () => void | Promise<void>;
}

class StaleBrowserObservationError extends Error {
  constructor() { super("Stale or foreign visual observation"); }
}

/** One explicit page resource owns one isolated context and page. */
export class PlaywrightBrowserPage implements ObservationProvider, BrowserExecutor {
  readonly resourceId: ResourceId;
  private readonly options: PlaywrightBrowserPageOptions;
  private browser?: Browser;
  private ownsBrowser = false;
  private _context?: BrowserContext;
  private _page?: Page;
  private observedTargets = new WeakMap<BrowserObservation, ReadonlyMap<string, ElementHandle<HTMLElement>>>();
  private targetSets = new Set<ReadonlyMap<string, ElementHandle<HTMLElement>>>();
  private revision = 0;
  private closed = false;
  private actionInFlight = false;
  private visualHashes = new WeakMap<BrowserObservation, string>();

  private constructor(options: PlaywrightBrowserPageOptions) {
    this.resourceId = options.resourceId;
    this.options = options;
  }

  get context(): BrowserContext { return this.requireContext(); }
  get page(): Page { return this.requirePage(); }
  get browserInstance(): Browser | undefined { return this.browser; }

  private requireContext(): BrowserContext {
    if (this.closed || !this._context) throw new Error("Browser page resource is unavailable");
    return this._context;
  }

  static async launch(options: PlaywrightBrowserPageOptions): Promise<PlaywrightBrowserPage> {
    const resource = new PlaywrightBrowserPage(options);
    resource.ownsBrowser = !options.browser;
    resource.browser = options.browser ?? await chromium.launch({ headless: options.headless ?? true });
    try {
      resource._context = await resource.browser.newContext({
        ...(options.viewport === null ? { viewport: null } : { viewport: options.viewport ?? DEFAULT_VIEWPORT }),
      });
      resource._page = await resource._context.newPage();
      resource._page.on("framenavigated", frame => {
        if (frame === resource._page?.mainFrame()) resource.revision += 1;
      });
      return resource;
    } catch (error) {
      await resource._context?.close();
      if (resource.ownsBrowser) await resource.browser.close();
      throw error;
    }
  }

  async navigate(url: string): Promise<void> {
    if (this.actionInFlight) throw new Error("Browser page is busy");
    const page = this.requirePage();
    if (this.closed) throw new Error("Browser page resource is closed");
    await page.goto(url, { waitUntil: "domcontentloaded" });
    this.revision += 1;
  }

  async saveScreenshot(filePath: string): Promise<void> {
    await this.requirePage().screenshot({ path: filePath, fullPage: true });
  }

  async withViewportCapture<T>(observation: BrowserObservation, signal: AbortSignal,
    consume: (bytes: Uint8Array, provenance: VisualProvenance) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.actionInFlight) throw new PerceptionFailure("environment", "busy");
    let page: Page;
    try { page = this.requirePage(); }
    catch { throw new PerceptionFailure("environment", "resource-unavailable", { stage: "pre-dom",
      observationRevision: observation.revision, currentRevision: this.revision, pageAlive: false, aborted: signal.aborted }); }
    this.actionInFlight = true;
    let bytes: Buffer | undefined;
    let stage: CaptureStage = "pre-dom";
    const cancel = () => { bytes?.fill(0); void page.close().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await this.assertCaptureFresh(observation, signal);
      stage = "capture";
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      // Stabilize acquisition BEFORE giving any frame to perception. This is not
      // a retry of a stale model result: no model/action is invoked in this window.
      bytes = await this.stableViewport(observation, signal);
      const imageHash = createHash("sha256").update(bytes).digest("hex");
      stage = "captured-dom";
      await this.assertCaptureFresh(observation, signal);
      const provenance = Object.freeze({ resourceId: this.resourceId, revision: observation.revision,
        fingerprint: observation.fingerprint, imageHash, ...viewport });
      stage = "provider";
      const result = await consume(bytes, provenance);
      signal.throwIfAborted();
      stage = "post-dom";
      await this.assertCaptureFresh(observation, signal);
      stage = "post-image";
      if (await this.viewportHash() !== imageHash) throw new PerceptionFailure("environment", "visual-stale");
      signal.throwIfAborted();
      this.visualHashes.set(observation, imageHash);
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof PerceptionFailure && error.diagnostic.source === "model") throw error;
      const code = error instanceof PerceptionFailure ? error.diagnostic.code
        : error instanceof StaleBrowserObservationError ? "target-stale"
          : page.isClosed() ? "resource-unavailable" : "capture-failed";
      throw new PerceptionFailure("environment", code, { stage, observationRevision: observation.revision,
        currentRevision: this.revision, pageAlive: !page.isClosed(), aborted: signal.aborted });
    } finally {
      bytes?.fill(0);
      signal.removeEventListener("abort", cancel);
      this.actionInFlight = false;
    }
  }

  private async assertCaptureFresh(observation: BrowserObservation, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.observedTargets.has(observation) || observation.revision !== this.revision
      || (await this.observeWithoutReplacingTargets(signal, observation)).fingerprint !== observation.fingerprint) {
      throw new PerceptionFailure("environment", "observation-stale");
    }
  }

  private async viewportHash(): Promise<string> {
    const bytes = await this.requirePage().screenshot({ fullPage: false, scale: "css", type: "png", timeout: 5000 });
    try { return createHash("sha256").update(bytes).digest("hex"); }
    finally { bytes.fill(0); }
  }

  private async stableViewport(observation: BrowserObservation, signal: AbortSignal): Promise<Buffer> {
    const deadline = performance.now() + 1000;
    let retained: Buffer | undefined;
    let hash: string | undefined;
    let stableSince = performance.now();
    try {
      do {
        await this.assertCaptureFresh(observation, signal);
        const next = await this.requirePage().screenshot({ fullPage: false, scale: "css", type: "png",
          timeout: Math.max(1, deadline - performance.now()) });
        if (next.length > 8 * 1024 * 1024) { next.fill(0); throw new PerceptionFailure("environment", "capture-failed"); }
        const nextHash = createHash("sha256").update(next).digest("hex");
        retained?.fill(0);
        retained = next;
        if (hash !== nextHash) { hash = nextHash; stableSince = performance.now(); }
        else if (performance.now() - stableSince >= 100) {
          await this.assertCaptureFresh(observation, signal);
          const stable = retained;
          retained = undefined;
          return stable;
        }
        await delay(30, undefined, { signal });
      } while (performance.now() < deadline);
      throw new PerceptionFailure("environment", "visual-unstable");
    } finally { retained?.fill(0); }
  }

  async readOutcome(predicates: ReadonlyArray<BrowserOutcomePredicate>, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const page = this.requirePage();
    // One synchronous DOM sample prevents combining predicates from different states.
    const matched = await page.evaluate(items => items.every(p => {
      if (p.kind === "url") return location.href === p.equals;
      if (p.kind === "text") return (document.body?.innerText ?? "").includes(p.includes);
      const nodes = document.querySelectorAll(p.selector);
      if (nodes.length !== 1 || !(nodes[0] instanceof HTMLElement)) return false;
      const node = nodes[0];
      if (p.property === "text") return node.innerText === p.equals;
      if (p.property === "value") return (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        || node instanceof HTMLSelectElement) && node.value === p.equals;
      if (p.property === "checked") return node instanceof HTMLInputElement && node.checked === p.equals;
      if (p.property === "enabled") return (!node.matches(":disabled") && node.getAttribute("aria-disabled") !== "true") === p.equals;
      const rect = node.getBoundingClientRect();
      return (rect.width > 0 && rect.height > 0 && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        && !node.closest("[aria-hidden=true],[inert]")) === p.equals;
    }), predicates);
    signal.throwIfAborted();
    return matched;
  }

  async observe(signal: AbortSignal): Promise<BrowserObservation> {
    if (signal.aborted) throw new Error("Browser observation cancelled");
    const page = this.requirePage();
    const candidates = await page.locator(
      "a[href],button,input:not([type=password]):not([type=file]),textarea,select,[role=button],[role=link],[role=textbox],summary",
    ).all();
    const elements: ObservedElement[] = [];
    const targets = new Map<string, ElementHandle<HTMLElement>>();
    for (const candidate of candidates) {
      if (elements.length >= 160) break;
      const handle = await candidate.elementHandle() as ElementHandle<HTMLElement> | null;
      if (!handle) continue;
      const data = await handle.evaluate((element) => {
        const node = element as HTMLElement;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
          && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          && !node.closest("[aria-hidden=true],[inert]");
        if (!visible) return null;
        return {
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          role: node.getAttribute("role") ?? (node instanceof HTMLAnchorElement ? "link"
            : node instanceof HTMLButtonElement || node.tagName === "SUMMARY" ? "button"
              : node instanceof HTMLSelectElement ? "combobox"
                : node instanceof HTMLTextAreaElement ? "textbox"
                  : node instanceof HTMLInputElement ? (["button", "submit", "reset", "image"].includes(node.type)
                    ? "button" : ["checkbox", "radio"].includes(node.type) ? node.type : "textbox") : "generic"),
          name: node.getAttribute("aria-label") ?? node.getAttribute("title")
            ?? (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
              ? [...(node.labels ?? [])].map((label) => label.innerText.trim()).filter(Boolean).join(" ") || node.getAttribute("placeholder") : null)
            ?? node.innerText?.trim().slice(0, 160) ?? "",
          text: node.innerText?.trim().slice(0, 160) || undefined,
          enabled: !(node instanceof HTMLButtonElement || node instanceof HTMLInputElement
            || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) || !node.disabled,
          value: node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement
            ? node.value.slice(0, 500) : undefined,
        };
      });
      if (!data) { await handle.dispose(); continue; }
      const id = `e${elements.length + 1}`;
      elements.push({ id, ...data });
      targets.set(id, handle);
    }
    const data = await page.evaluate(() => {
      return { url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 6000) ?? "" };
    });
    const snapshot = { ...data, elements };
    const fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    elements.forEach(e => { Object.freeze(e.bounds); Object.freeze(e); });
    Object.freeze(elements);
    const observation = Object.freeze({ ...snapshot, revision: this.revision, fingerprint });
    this.observedTargets.set(observation, targets);
    this.targetSets.add(targets);
    return observation;
  }

  async observeAfterAction(before: BrowserObservation, signal: AbortSignal): Promise<BrowserObservation> {
    const deadline = performance.now() + 600;
    let latest = await this.observe(signal);
    let stableSince = performance.now();
    try {
      while (performance.now() < deadline) {
        signal.throwIfAborted();
        await delay(50, undefined, { signal });
        const next = await this.observe(signal);
        const stable = next.revision === latest.revision && next.fingerprint === latest.fingerprint;
        await this.disposeTargets(latest);
        latest = next;
        signal.throwIfAborted();
        if (!stable) stableSince = performance.now();
        // No change must get the full bounded observation window, allowing
        // delayed effects. A changed state needs a stable sampling interval.
        if (next.fingerprint !== before.fingerprint && stable && performance.now() - stableSince >= 100) return latest;
      }
      signal.throwIfAborted();
      return latest;
    } catch (error) { await this.disposeTargets(latest); throw error; }
  }

  async execute(requestedAction: BrowserAction, observation: BrowserObservation, signal: AbortSignal): Promise<BrowserExecutionResult> {
    if (this.actionInFlight) return { state: "rejected-before-mutation", reason: "busy" };
    this.actionInFlight = true;
    try {
      if (signal.aborted) return { state: "cancelled" };
      let page: Page;
      try { page = this.requirePage(); }
      catch { return { state: "rejected-before-mutation", reason: "resource-unavailable" }; }
      if (requestedAction.observationRevision !== this.revision || observation.revision !== this.revision) {
        return { state: "rejected-before-mutation", reason: "stale-observation" };
      }
      if (!this.observedTargets.has(observation)) return { state: "rejected-before-mutation", reason: "stale-observation" };
      let checked: BrowserAction;
      try {
        const { observationRevision: _revision, ...payload } = requestedAction;
        checked = validateDecision(JSON.stringify(payload), observation);
      } catch { return { state: "rejected-before-mutation", reason: "invalid-action" }; }
      const action = checked;
      let live: BrowserObservation;
      try { live = await this.observeWithoutReplacingTargets(signal, observation); }
      catch (error) {
        return signal.aborted ? { state: "cancelled" }
          : { state: "rejected-before-mutation", reason: error instanceof StaleBrowserObservationError ? "stale-observation" : "resource-unavailable" };
      }
      if (live.revision !== observation.revision || live.fingerprint !== observation.fingerprint) {
        return { state: "rejected-before-mutation", reason: "stale-observation" };
      }
      const imageHash = this.visualHashes.get(observation);
      if (imageHash && await this.viewportHash() !== imageHash) return { state: "rejected-before-mutation", reason: "stale-observation" };
      if (imageHash) {
        try { await this.assertCaptureFresh(observation, signal); }
        catch { return signal.aborted ? { state: "cancelled" } : { state: "rejected-before-mutation", reason: "stale-observation" }; }
      }

      let mutation: () => Promise<unknown>;
      try {
        if (action.type === "navigate") {
          const destination = new URL(action.url, page.url());
          if (destination.protocol !== "http:" && destination.protocol !== "https:") {
            return { state: "rejected-before-mutation", reason: "invalid-action" };
          }
          mutation = () => page.goto(destination.toString(), { waitUntil: "domcontentloaded" });
        } else if (action.type === "click") {
          const target = this.target(observation, action.targetId);
          mutation = () => target.click({ timeout: 5000 });
        } else if (action.type === "type") {
          const target = this.target(observation, action.targetId);
          mutation = () => target.fill(action.value, { timeout: 5000 });
        } else if (action.type === "select") {
          const target = this.target(observation, action.targetId);
          mutation = () => target.selectOption(action.value, { timeout: 5000 });
        } else if (action.type === "press") mutation = () => page.keyboard.press(action.key);
        else if (action.type === "scroll") mutation = () => page.evaluate((delta) => window.scrollBy({ top: delta }), action.deltaY);
        else if (action.type === "wait") mutation = () => page.waitForTimeout(Math.min(Math.max(action.milliseconds ?? 250, 0), 5000));
        else return { state: "rejected-before-mutation", reason: "invalid-action" };
      } catch {
        return { state: "rejected-before-mutation", reason: "invalid-target" };
      }

      if (signal.aborted) return { state: "cancelled" };
      const cancel = () => { void page.close().catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await mutation();
        if (signal.aborted) return { state: "cancelled" };
        const intendedEffect = await this.verifyIntendedEffect(action, observation, signal);
        this.revision += 1;
        await this.disposeTargets(observation);
        return { state: "accepted", intendedEffect };
      } catch {
        return signal.aborted ? { state: "cancelled" } : { state: "execution-error" };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    } finally {
      this.actionInFlight = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.targetSets].map((targets) => this.releaseTargetSet(targets)));
    this.observedTargets = new WeakMap();
    try {
      await this.options.onClose?.();
    } catch {
      /* ignore callback error */
    } finally {
      await this._context?.close();
      if (this.ownsBrowser) await this.browser?.close();
    }
  }

  private target(observation: BrowserObservation, targetId: string): ElementHandle<HTMLElement> {
    const index = observation.elements.findIndex((item) => item.id === targetId);
    const target = observation.elements[index];
    if (!target || !target.enabled) throw new Error("Browser action target was not enabled in the current observation");
    if (observation.revision !== this.revision) throw new Error("Browser action references a stale observation");
    const handle = this.observedTargets.get(observation)?.get(targetId);
    if (!handle) throw new Error("Browser action target is no longer bound to its observation");
    return handle;
  }

  private async verifyIntendedEffect(action: BrowserAction, before: BrowserObservation, signal: AbortSignal): Promise<GoalVerificationState> {
    if (action.type !== "type" && action.type !== "select" && action.type !== "navigate") return "unknown";
    const end = performance.now() + 600;
    let consecutive = 0;
    do {
      signal.throwIfAborted();
      let matches = false;
      try {
        matches = action.type === "navigate" ? this.requirePage().url() === new URL(action.url, before.url).href
          : await this.target(before, action.targetId).evaluate((node, value) => node.isConnected
            && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)
            && node.value === value, action.value);
      } catch { return "unknown"; }
      consecutive = matches ? consecutive + 1 : 0;
      if (consecutive >= 3) return "verified";
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (performance.now() < end);
    signal.throwIfAborted();
    return "not-verified";
  }

  private async disposeTargets(observation: BrowserObservation): Promise<void> {
    const targets = this.observedTargets.get(observation);
    this.observedTargets.delete(observation);
    if (targets) await this.releaseTargetSet(targets);
  }

  private async releaseTargetSet(targets: ReadonlyMap<string, ElementHandle<HTMLElement>>): Promise<void> {
    this.targetSets.delete(targets);
    await Promise.all([...targets.values()].map((handle) => handle.dispose().catch(() => undefined)));
  }

  private async observeWithoutReplacingTargets(signal: AbortSignal, observation: BrowserObservation): Promise<BrowserObservation> {
    const page = this.requirePage();
    if (signal.aborted) throw new Error("Browser observation cancelled");
    const targets = this.observedTargets.get(observation);
    if (!targets) throw new StaleBrowserObservationError();
    const snapshot = await page.evaluate((handles) => {
      const nodes = [...document.querySelectorAll<HTMLElement>(
      "a[href],button,input:not([type=password]):not([type=file]),textarea,select,[role=button],[role=link],[role=textbox],summary",
    )].filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
        && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !node.closest("[aria-hidden=true],[inert]");
    }).slice(0, 160);
    if (nodes.length !== handles.length || nodes.some((node, i) => node !== handles[i])) return null;
    const elements = nodes.map((node, index) => ({
      id: `e${index + 1}`,
      bounds: (() => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
      role: node.getAttribute("role") ?? (node instanceof HTMLAnchorElement ? "link"
        : node instanceof HTMLButtonElement || node.tagName === "SUMMARY" ? "button"
          : node instanceof HTMLSelectElement ? "combobox" : node instanceof HTMLTextAreaElement ? "textbox"
            : node instanceof HTMLInputElement ? (["button", "submit", "reset", "image"].includes(node.type)
              ? "button" : ["checkbox", "radio"].includes(node.type) ? node.type : "textbox") : "generic"),
      name: node.getAttribute("aria-label") ?? node.getAttribute("title")
        ?? (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
          ? [...(node.labels ?? [])].map((label) => label.innerText.trim()).filter(Boolean).join(" ") || node.getAttribute("placeholder") : null)
        ?? node.innerText?.trim().slice(0, 160) ?? "",
      text: node.innerText?.trim().slice(0, 160) || undefined,
      enabled: !(node instanceof HTMLButtonElement || node instanceof HTMLInputElement
        || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) || !node.disabled,
      value: node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement
        ? node.value.slice(0, 500) : undefined,
    }));
    return { url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 6000) ?? "", elements };
    }, [...targets.values()]);
    if (!snapshot || observation.revision !== this.revision) throw new StaleBrowserObservationError();
    return { ...snapshot, revision: this.revision,
      fingerprint: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
  }

  private requirePage(): Page {
    if (!this._page || this._page.isClosed()) throw new Error("Browser page resource is unavailable");
    return this._page;
  }
}

export { ModelActionValidationError, ModelDecisionProvider, OpenAICompatibleStructuredClient, validateDecision,
  normalizeModelOutput, structuredJsonOnly, stripPrivateReasoning } from "./model.ts";
export { ModelProviderError, OpenAICompatibleVisionClient } from "./model.ts";
export type { StructuredModelClient, StructuredModelRequest, OpenAICompatibleClientOptions, ModelContextMetrics,
  VisionModelRequest, VisionModelResult, VisionModelClient, ModelProviderErrorCode, ModelActionDiagnostic } from "./model.ts";
export { resolveDevelopmentModelConfig } from "./model-config.ts";
export type { DevelopmentModelConfig, TextModelId, VisionModelId } from "./model-config.ts";
export { VisionExecutionAdapter } from "./adapter.ts";
export type { VisionExecutionAdapterOptions, VisionLocalDiagnostic, VisionAdapterFactoryInput, VisionBrowser } from "./adapter.ts";
export { createModelPerceptionProvider, validateVisualFacts } from "./perception.ts";
export { PerceptionFailure } from "./perception.ts";
export type { PerceptionFailureDiagnostic } from "./perception.ts";
export type { VisualPolicy, VisualConfiguration, VisualEnvelope, VisualFact, VisualProvenance, PerceptionProvider, ViewportCaptureProvider } from "./perception.ts";
export { createBrowserOutcomeVerifier } from "./verifier.ts";
export type { BrowserOutcomePolicy, BrowserOutcomePredicate, BrowserOutcomeReader } from "./verifier.ts";
export { PlaywrightBrowserRuntime, BrowserSessionQuotaExceededError } from "./browser-runtime.ts";
export type { BrowserRuntime, BrowserRuntimeOptions, BrowserSessionIdentity } from "./browser-runtime.ts";

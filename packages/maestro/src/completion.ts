import type { Assignment, Goal, GoalEvidenceInput, GoalInput, InMemoryWorld } from "@mediobot-v2/domain";

export interface CompletionRequest {
  readonly objective: string;
  readonly expectedOutcome: string;
  readonly evidenceExpectations: readonly string[];
}

/** Application code only: never deserialize this configuration from a model or request. */
export interface TrustedCompletion {
  /** Explicitly accepts responsibility for the objective AND every listed obligation, or declines. */
  readonly createPolicy: (request: CompletionRequest) => {
    readonly coveredExpectations: readonly string[];
    readonly criteria: NonNullable<GoalInput["successCriteria"]>;
  } | undefined;
  readonly timeoutMs?: number;
  /** Must execute an independent verifier against current artifacts, not judge worker claims.
   * Evidence is goal-only: the runtime pins ownership, never impersonating the child producer. */
  readonly assess: (context: {
    readonly goal: Pick<Goal, "id" | "objective" | "successCriteria">;
    readonly assignment: Assignment;
    readonly result: { readonly state: "completed"; readonly toolEvidenceCount: number };
    readonly workspaceRoot: string;
  }, signal: AbortSignal) => Promise<readonly {
    readonly criterionId: string;
    readonly state: "satisfied" | "unsatisfied";
    readonly evidence: Omit<GoalEvidenceInput, "goalId" | "taskId" | "workerId">;
  }[] | undefined>;
}

export function compileCompletion(config: TrustedCompletion | undefined, request: CompletionRequest) {
  // Decline oversized anchors rather than silently truncate an obligation.
  if (request.objective.length > 8000) return undefined;
  const policy = config?.createPolicy(structuredClone(request));
  if (!policy || policy.criteria.length > 32 || !policy.criteria.some((c) => c.required !== false)
    || JSON.stringify(policy.criteria).length > 32_000
    || policy.criteria.some((c) => !c.evidenceRequirement)
    || request.evidenceExpectations.some((text) => !policy.coveredExpectations.includes(text))) return undefined;
  return structuredClone(policy.criteria);
}

export async function assessCompletion(config: TrustedCompletion, world: InMemoryWorld, goal: Goal,
  assignment: Assignment, workspaceRoot: string, toolEvidenceCount: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const requested = config.timeoutMs ?? 10_000;
  const timeout = setTimeout(abort, Number.isFinite(requested) ? Math.max(1, Math.min(requested, 30_000)) : 10_000);
  try {
    const expired = new Promise<undefined>((resolve) => controller.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
    const assessments = await Promise.race([expired, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return config.assess({ goal: structuredClone({ id: goal.id, objective: goal.objective, successCriteria: goal.successCriteria }),
        assignment: structuredClone(assignment), workspaceRoot, result: { state: "completed", toolEvidenceCount } }, controller.signal);
    })]);
    signal.throwIfAborted();
    if (controller.signal.aborted || !assessments || assessments.length > 32) return;
    // No await or external callbacks between the cancellation gate and proof commit.
    if (world.inspect().goals.find((g) => g.id === goal.id)?.status !== "active") return;
    for (const assessment of assessments) {
      const requirement = goal.successCriteria.find((c) => c.id === assessment.criterionId)?.evidenceRequirement;
      const proof = assessment.evidence;
      if (!requirement || !["satisfied", "unsatisfied"].includes(assessment.state)
        || requirement.taskId !== undefined || requirement.workerId !== undefined
        || proof.kind !== requirement.kind || proof.validity !== requirement.validity
        || proof.source.type !== requirement.source.type || proof.source.reference !== requirement.source.reference
        || (requirement.subject !== undefined && proof.subject !== requirement.subject)
        || (requirement.revision !== undefined && proof.revision !== requirement.revision)) continue;
      const evidence = world.recordEvidence({ goalId: goal.id, source: proof.source, content: proof.content,
        kind: proof.kind, validity: proof.validity, subject: proof.subject, revision: proof.revision,
        claim: proof.claim, artifactReference: proof.artifactReference });
      world.supportGoalCriterion(goal.id, assessment.criterionId, assessment.state, [evidence.id]);
    }
  } catch {
    signal.throwIfAborted(); // Verifier failure/timeout is unknown, never successful proof.
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}

# P0 completion contract / integration handoff

## Trusted boundary

World mutation APIs are for trusted runtime callers, not model tool calls. World checks attribution and policy compatibility; it does not independently execute a verifier, authenticate a source string, parse claims, or judge test adequacy. A `verified` flag alone is never sufficient. Runtime adapters must derive provenance and verification results from actual invocations and independently determine the assessment (`satisfied` or `unsatisfied`). No confidence threshold is used.

## Typed criteria

`GoalInput.successCriteria[].evidenceRequirement?: EvidenceRequirement` is copied into `GoalCriterion`:

```ts
interface EvidenceRequirement {
  readonly kind: string;
  readonly source: { readonly type: string; readonly reference: string };
  readonly validity: "observed" | "verified";
  readonly workerId?: WorkerId;
  readonly taskId?: TaskId;
  readonly subject?: string;
  readonly revision?: string;
}
```

All specified fields match exactly, including validity. Source reference should identify a trusted verifier or invocation. A stable verifier identity may be known before any invocation; an invocation-specific reference is not mandatory. Optional worker/task IDs pin the producer: specified entities must already exist, and a pinned pair must match task assignment. Revision requires a subject; both are opaque strings, with no ordering inference. Bind an optional revision when it is meaningful to the criterion, not simply because planning involves revisions. `Evidence`, `TaskEvidenceInput`, and `GoalEvidenceInput` accept optional `subject` and `revision`. Missing candidate fields cannot match specified requirements. An observed summary cannot satisfy a verified execution requirement; relabeling validity does not bypass kind/source matching.

Evidence recording enforces the runtime union: task evidence must have both own `taskId` and `workerId` properties identifying a valid assigned producer; goal-only evidence must have `goalId` and no producer properties. Inherited identity properties are rejected for evidence and policies. Source type/reference must be nonempty strings, optional kind must be a nonempty string, and optional validity must be a declared value. Content and optional textual fields are type-checked. Evidence and requirements store only declared fields; source is normalized to `{ type, reference }`, discarding extra nested metadata.

`supportGoalCriterion(goalId, criterionId, state, evidenceIds)` requires a nonempty candidate set, and **every** candidate must match the criterion policy and belong to that Goal. Failure leaves the assessment unchanged. A successful assessment replaces the previous supporting IDs. Goal satisfaction requires at least one required criterion, all required criteria satisfied, and an active Goal. Optional-only Goals never satisfy.

### Legacy migration

`Goal.evidenceRequirements` / `GoalInput.evidenceRequirements` remain string arrays for compatibility and are explicitly **uncompiled requirements**. Any nonempty legacy array blocks criterion assessment, even alongside typed policy. A criterion without a typed requirement also fails closed. Prose is never guessed or compiled implicitly.

At Goal creation, runtime integration must replace legacy prose with reviewed per-criterion typed policies and omit the legacy array. Preserve the immutable Goal identity/objective anchor through replanning, including when an invocation or revision is not yet known. A stable verifier identity can support policy before execution; revision pins are optional and should be bound when meaningful. Existing in-memory Goals have no policy mutation API, so uncompiled requirements remain fail-closed pending explicit trusted integration. Policy binding/migration and assessment integration belong in the forthcoming trusted Maestro integration; neither replacing a Goal to replan nor implicitly relaxing a policy is a migration strategy.

## Attribution

`linkEvidenceToGoal(goalId, evidenceId)` permits the first association of unassociated task evidence (needed by Maestro's existing child-link flow). It writes `Evidence.goalId` without changing task, worker, source, timestamps, validity, or subject/revision. Same-Goal relinking is permitted and does not duplicate IDs. Linking already-associated evidence to another Goal throws. Goal-only evidence cannot be reassigned. Assessment never treats membership in an arbitrary Goal evidence list as ownership.

## Lifecycle

`transitionGoal(goalId, status: GoalStatus): Goal` uses this graph:

- `active` → `waiting-user`, `blocked`, `paused`, `satisfied`, `failed`, `cancelled`.
- `waiting-user`, `blocked`, `paused` → each other, `active`, `failed`, `cancelled`.
- `satisfied`, `failed`, `cancelled` have no outgoing generic transitions.
- Same-state requests are permitted. Satisfaction always requires evidence-backed required criteria.

`updateGoal(..., { status })` is retained for compatibility and checks the same graph, but still disallows `satisfied` (use assessment or `transitionGoal`). Metadata updates remain permitted on terminal Goals. No generic status update resurrects a terminal Goal. Resuming a nonterminal Goal does not automatically satisfy it: reassess or explicitly transition active → satisfied after the proof gate passes.

## Revocation and reopening

`invalidateEvidence(evidenceId): Evidence` permanently marks the record invalidated and atomically clears every assessment using it to `unknown` with no supporting IDs. The historical evidence record and Goal evidence list are retained. The whole affected assessment is cleared even if other candidates remain; the caller must reassess them.

If required proof is lost, a `satisfied` Goal immediately becomes `blocked`. It cannot remain falsely satisfied. Similarly, `supportGoalCriterion(..., "unsatisfied", matchingEvidenceIds)` moves a formerly satisfied Goal to blocked when a required criterion becomes unsatisfied. This explicit, trusted contrary assessment is the other proof-loss path. Unrelated evidence invalidation and loss of optional proof do not reopen a Goal. Cancelled/failed and other non-active statuses are preserved.

Recovery is explicit: invalidate supporting evidence (or submit a qualifying contrary assessment), then `transitionGoal(goalId, "active")`. Fresh evidence alone cannot resume blocked work. Invalidated evidence cannot be reused. Preserve the Goal anchor when replanning or underlying revisions change. A revision-pinned policy cannot accept a different revision or silently drop its pin: explicit trusted policy binding/assessment integration is required, and is outside this patch. Stable-verifier policies without a revision pin still require runtime revocation and fresh assessment when state changes. World cannot detect external writes or clock-based expiry. No implicit wall-clock freshness policy is provided.

All returned Goals, nested policies, provenance records, and World snapshots are detached from internal state.

## Root integration actions

1. Author typed criteria in trusted composition/verifier code, replacing string requirements. Existing string-only callers still create Goals but cannot prove completion.
2. Supply exact kind/source/validity and optional producer/subject/revision from actual execution. Keep model summaries observed and distinct.
3. Retain Maestro's first-association flow; handle cross-Goal links as errors.
4. Call `invalidateEvidence` on relevant writes/revisions; explicitly resume blocked Goals after recovery authorization.
5. Handle illegal transition errors; preserve the Goal anchor through replanning and implement explicit trusted policy binding/migration without implicit relaxation. Cancelled/failed Goals remain terminal.

Only domain files were changed. Other packages' fixtures/callers need integration separately.

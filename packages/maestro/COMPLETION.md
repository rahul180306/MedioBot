# Trusted completion integration

Pass `completion: TrustedCompletion` to `createMaestroCodyExecution`,
`MaestroExecutionAdapter`, or command-center's `createComposition`. This is
application configuration, not a task option, POST field, or model decision.
There is no default verifier and no generic objective inference.

`createPolicy` runs before the child exists. Returning a policy accepts
responsibility for verifying the original objective and expected outcome.
`coveredExpectations` must explicitly include every incoming evidence expectation.
Return `undefined` for unfamiliar objectives or obligations. Partial coverage
retains the original uncompiled requirements and cannot establish satisfaction.
The assignment always retains those expectations, including when covered.

Criteria must have typed evidence requirements. Use a stable verifier identity
known before execution; do not guess a future invocation ID. Domain copies the
policy into the immutable Goal anchor. Assessment, invalidation, and explicit
recovery act on that same Goal; this seam does not replace Goals or introduce a
replanning loop.

`assess` runs after successful child execution and resource cleanup. Its context
contains the Goal anchor/criteria, assignment, workspace, and a result count,
not worker summaries or model self-evaluation. It must independently inspect
current artifacts or execute a trusted check. Return `undefined` when unknown,
or criterion outcomes with evidence authored by that verifier. Command exit
success by itself does not establish the requested objective.

The runtime records verifier evidence as goal-only evidence with the Goal ID
pinned locally. It does not attribute an independent check to Cody. Consequently
policies pinned to task/worker producers are not supported by this seam and
remain unproved. Kind, source, validity, subject, and revision must match before
the runtime calls the domain proof gate.

Assessment defaults to 10 seconds, capped at 30 seconds. Cancellation and timeout
abort the verifier signal and discard late results even if the verifier ignores
it. Verifiers must cooperate to terminate their own I/O/subprocesses; a timer
cannot interrupt synchronous code blocking the JavaScript event loop. Factory
code is synchronous trusted configuration. Oversized objectives (>8,000 chars)
or policies (>32 criteria or >32,000 serialized chars) decline compilation
rather than silently truncate obligations.

External writes are not automatically monitored. The owning integration must
call `world.invalidateEvidence` when a verified artifact changes. This reopens a
satisfied Goal as blocked; recovery requires explicit activation and fresh
assessment under the original policy. The runtime integration tests demonstrate
this with a real file write, deterministic current-file verification, and an
external mutation. They also show that worker command success and summaries
cannot substitute for the configured independent proof.

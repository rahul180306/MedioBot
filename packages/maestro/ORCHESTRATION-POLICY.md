# Maestro orchestration policy correction after failed UI acceptance

Status: **MANUAL UI ACCEPTANCE FAILED; GENERAL FIX IMPLEMENTED AND DETERMINISTICALLY TESTED; REAL BEHAVIOR AFTER FIX NOT PROVEN.** The prior controlled NVIDIA parallel-worker proof is preserved and was not repeated.

## Diagnosis before edits

A read-only inspection of the default application store found the matching failed UI turn:

- Thread: `thread-1791455694860`.
- Turn: `turn-a23cf5b9-07df-4f19-be7a-a655cebf56f5`.
- Selected pair: `nvidia` / `google/diffusiongemma-26b-a4b-it`.
- Status: completed; no task ID.
- Items: one user message and one Maestro message, with the server's direct-branch message ID `maestro-<turnId>`.
- No persisted decision/repair trace, worker activity, or task reference.

The output came from the direct conversational branch, not worker synthesis with hidden/missing timeline events. The user reports an answer, consistent with `respond`. However, the historical store does not distinguish the `respond` and `request_user_input` intents or retain earlier invalid attempts. The exact first structured intent and any repairs cannot be recovered. No raw provider output, user transcript body, credentials, or hidden reasoning was logged during inspection.

A pre-edit context reconstruction through the existing composition (using a diagnostic model fixture solely to capture compiled structure) showed:

| Context field | Pre-fix evidence |
| --- | --- |
| Available intents | respond, request_user_input, delegate, delegate_text |
| Cody | Assignable; role coding; capability names workspace, terminal.execute; no description |
| Research | Assignable; role research; capability name text-inference; no description |
| Tester | Assignable; role tester; capability name text-inference; no description |
| Maestro/Vision/Doc | Present in registry projection but not assignable |
| Maestro definition instructions | Included |
| Delegation skill | Compact metadata included; full body not loaded |
| delegate_text schema | Advertised explicitly |
| Dominant system guidance | “Conversation is the default, so answer directly when sufficient” |

This reconstruction establishes the current pre-change code path's structure, not a recovered historical request byte-for-byte. Role descriptions existed in Research/Tester worker definitions but were dropped by Maestro's registry projection. Cody's own description was a generic placeholder. The instructions described delegation as optional usefulness without clearly requiring a comparison against the correctness/evidence benefit of independent contributions.

## Failure classification

Primary evidenced deficiency: **instruction/policy boundary**, compounded by **incomplete descriptive context**. Specialist availability and the delegation contract existed, but the model was given sparse contribution metadata and a strong direct-answer default.

This is not evidence of a missing delegate_text schema or broken parallel runtime. No execution/presentation suppression is indicated for this stored direct turn. The existing parser preserves a valid decision's intent; structural failures can trigger fresh model attempts, which may select another intent. Historical repairs are unknown because they were not logged. The model's internal reason for selecting its answer is not observable and is not claimed as fact.

The diagnosis and these limits were reported before implementing the fix.

## Small general fix

1. The decision instructions now ask Maestro to compare a direct answer with the expected contribution of available specialists, choosing the simplest reliable strategy that maximizes the probability of satisfying the goal. Expertise or independent perspectives should justify delegation through expected improvements to correctness, evidence, implementation quality, verification, or efficiency. The ability to draft an answer is not by itself a reason to dismiss collaboration.
2. Direct responses remain preferable where collaboration adds little, including ordinary conversation and straightforward explanations. Material ambiguity calls for clarification. The model chooses the smallest useful team; no fixed roster or non-greeting delegation rule was added.
3. The registry projection now includes each definition's sanitized, bounded description (maximum 500 characters) and explicit assignment availability alongside existing identity, role, and capability names. Cody's placeholder definition instruction now explains its technical reasoning contribution and that tools require authorization. Research/Tester descriptions reuse their existing definitions; no worker-execution architecture changed.
4. Canonical Maestro instructions and compact delegation skill metadata now express the same general policy. Full skill bodies are still not loaded by default; the decision can understand collaboration value from concise metadata.
5. Safe decision diagnostics capture a generated call ID, context availability/description counts, fixed intent discriminators, validation result, attempt number, assignment count, and fixed rejection reason. They do not contain goal text, model answers, rejected payloads, provider errors, header values, credentials, or hidden reasoning. Observer errors cannot affect decisions.

No benchmark, queue, model, site, or keyword conditions were introduced. There is no new routing layer, classifier, mandatory team, scheduler, or automatic recovery. The canonical decision shapes and structural repair budget remain unchanged. WorkerRuntime and TextMediobotExecution were not edited. Existing bounded assignments, manual model resolution, failure isolation, reports, synthesis, and Goal truth are preserved.

## Safe diagnostics during the next UI run

The terminal now emits `maestro.decision` records. A normal configured planning context should show `assignableCount: 3`, `describedAssignableCount: 3`, and `textDelegationAvailable: true`. These counts are metadata, not a required worker count.

A `validated` record states `observedIntent`, accepted `intent`, `attempt`, and `assignmentCount`. A `rejected` record shows the fixed structural/semantic rejection reason. Records share a generated `callId` for that decision call. Thus a first-attempt `respond` can be distinguished from rejected `delegate_text` followed by a newly generated `respond`. No rejected decision is mechanically rewritten into a response by the validator.

The diagnostics are terminal-only and do not invent timeline activity. They intentionally omit full registry/assignment content and user text. Synthesis is a separate model decision and therefore a separate call ID.

## Regression evidence and limits

| Validation | Result |
| --- | --- |
| Models | 32 passed |
| Cody | 11 passed |
| Maestro, including four new diagnostics tests | 47 passed |
| Normal turn handler, parallel composition, direct conversation | 7 passed |
| Total focused deterministic checks | **97 passed** |
| Workspace typecheck | Passed |
| Production build | Passed; existing large-chunk warning |
| git diff --check / authored-file whitespace | Passed |

The normal-handler fixtures now check that the actual model request includes distinct bounded descriptions, assignment availability, and the general collaboration policy. Greetings and simple explanations remain direct with zero execution identities. Substantial design and independent critique fixtures cover different selected teams through the existing runtime, attributed reports and synthesis, and child failure without fabricated success.

Diagnostics tests cover accepted one/two/three-assignment decisions without forced counts; structural repair from rejected delegation to a fresh response with an observable trace; unknown intent/provider error redaction; and observer failure isolation.

These are deterministic model fixtures and contract regressions. They do not prove a real model will follow the new strategy policy. One real NVIDIA natural-goal handler attempt was made after the fix. It emitted the new context counts (3 assignable, 3 described, delegate_text available), then failed on attempt 1 with `transport`, before any intent. Final result: **0 passed, 1 skipped**. No network investigation or retry followed. A separate workspace watcher EMFILE warning was not treated as the transport cause.

The prior synthesis correctness gap also remains: bounded reports and claims are supplied to Maestro, but there is no independent final-answer correctness verifier. No queue-specific corrections were encoded.

## Files changed in this correction

- `packages/maestro/src/index.ts`: strategy guidance, descriptive registry projection, safe decision diagnostics.
- `packages/maestro/src/context.ts`: optional description/assignment-availability fields in model context typing.
- `packages/cody/src/index.ts`: replace placeholder definition instructions with role contribution/limits.
- `apps/command-center/src/composition.ts`: wire fixed-vocabulary Maestro diagnostics to the existing terminal logging boundary.
- `mediobots/maestro/MEDIOBOT.md`: align canonical adaptive strategy policy.
- `mediobots/maestro/skills/delegation/SKILL.md`: align compact metadata and skill guidance.
- `packages/maestro/tests/decision-diagnostics.test.ts`: new diagnostic/privacy/intent-preservation tests.
- `apps/command-center/tests/runtime/autonomous-turn.test.ts`: strengthen normal request context and behavioral-fixture regressions.
- `CONTINUATION.md`, `AUTONOMOUS-TURN.md`, and this report: failed acceptance evidence and current handoff.

## Exact manual acceptance

Restart the existing local server to load the updated instructions and code. From the normal Mac terminal:

```sh
cd /Users/rahulkarthikt/Documents/mediobot/mediobot-v2
pnpm dev
```

Open the unchanged UI at `http://127.0.0.1:4173`. Select Maestro and the connected NVIDIA DiffusionGemma model. Use fresh threads for these prompts:

1. `Hi`
2. `What is recursion? Explain it simply with one small example.`
3. `Design a small in-memory rate-limited job queue for one Node.js process. It must allow at most five job starts in any rolling one-second window and at most two jobs executing concurrently. Design a correct implementation and explain the important tradeoffs and failure cases. Have your team help where useful, but you own the final answer. Text only—do not modify files, run commands, browse the web, or claim anything was tested unless it actually was.`
4. `Review this proposal for a file-upload service: retry every timed-out upload as a new upload, and consider a successful HTTP response sufficient proof that the file is safely stored. Assess the assumptions, failure cases, and acceptance criteria from independent perspectives where useful, then give one recommendation. You own the final answer. Text only—do not modify files, run commands, browse, or claim tests were executed.`

The first two should normally remain direct with zero specialist activity. For the substantive design/critique prompts, assess whether the model chooses useful collaboration and a suitably small team; do not require exactly three specialists or a fixed roster. Real specialist activity must appear in the unchanged timeline. Review correctness and evidence honesty separately from execution.

Retain the safe `maestro.decision` records and visible activity/final answer for diagnosis. If the model still answers directly, the first validated intent and any rejected attempts will now be observable. Do not declare autonomous orchestration working until the user observes real useful specialist execution from a normal request.

No Vision/browser/Chromium/Playwright tests, image calls, UI redesign, Auto routing, recovery, durable World, self-improvement, secrets exposure, `.env` inspection, reset/clean, commit, or push occurred.

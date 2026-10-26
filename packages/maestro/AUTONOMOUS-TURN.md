# Autonomous Maestro turn audit and acceptance

**Superseded by failed human UI acceptance and the subsequent general correction.** Read [ORCHESTRATION-POLICY.md](ORCHESTRATION-POLICY.md) for persisted-turn evidence, the policy/context fix, new diagnostics, and fresh manual prompts. The audit below records the earlier integration-only findings; it did not establish real autonomous strategy selection.

**AUTONOMOUS DECOMPOSITION NOT PROVEN.** The normal turn path needs no production integration rewrite. Deterministic handler tests passed; human acceptance through the unchanged UI remains pending.

## Preserve the already proven result

The user supplied a passing normal-Mac NVIDIA run of the controlled staged harness. Pair: `nvidia` / `google/diffusiongemma-26b-a4b-it`.

| Stage | Result | Measured common worker call interval |
| --- | --- | --- |
| One Cody | Completed, attributed WorkerReport | Single call: 837.2763671875 ms |
| Cody + Research | Both completed | 1050.310791015625 ms |
| Cody + Research + Tester | All completed | 1155.5458984375 ms |
| Maestro synthesis | One real synthesis call completed | No additional worker overlap claim |

The controlled run made six real worker calls across stages and one real synthesis call. Assignment/worker/definition IDs and provider/model pairs were distinct and attributed as appropriate. The proof was not repeated in this continuation. It establishes real concurrent worker execution, not heterogeneous models, speedup, autonomous planning, or correct final advice.

## Normal product path audit

| Boundary | Existing behavior | Audit/test conclusion |
| --- | --- | --- |
| Composer/AppContext | Sends user's trimmed prompt, thread/turn identity, manually selected provider/model pair, bounded recent history and attachments | No worker assignments injected by UI |
| runtime/client.ts | Posts those fields to `/api/turns`; default `definition-maestro` resolves to the registered Maestro | No hidden fixed team selection |
| Server model preflight | Normal connected-model registry checks the explicit pair and text capability | Manual identity stays providerConnectionId + modelId |
| Server semantic decision | Calls `composition.decideMaestroTurn` before creating execution identities | Direct Hi path has zero Goal/Assignment/Task/Worker identities |
| Maestro decision provider | Advertises `delegate_text`, registered assignable IDs and role/capability metadata; validates model-generated outcomes/context/independence | Model may respond directly, ask input, or select bounded text assignments; no required three-worker shape |
| Server execution handoff | Sets internal `turnOptions.maestroDecision` from the actual validated model decision, then submits Maestro | This is internal reuse of model output, not request/harness assignment injection |
| TextMediobotExecution | Creates one Goal and one Assignment/Task/Worker per selected specialist; passes each its own bounded context | Workers do not receive parent Goal/conversation dumps |
| WorkerRuntime | Executes independent assignments with existing admission and cancellation | No new scheduler; deterministic calls overlap |
| Model resolution | Each text worker resolves the manual turn pair unless an explicit backend override exists | UI supplies no overrides; tests verify exact pair attribution |
| WorkerReport | Runtime owns identities/timings/status; report body is bounded and sanitized; evidence remains observed claims | Independent child failure appears as failure, not success |
| Maestro synthesis | Model gets Goal Anchor, constraints, bounded reports, and projected supervision notices | No private worker conversations; worker completion does not satisfy Goal |
| Event mapping | Child task start/completion/failure becomes worker activity attached to parent task with child execution ID and definition ID | Child terminal events do not prematurely finish parent turn |
| Transcript/SSE | Server persists attributed activity and Maestro message, and emits them through `/api/turns/:id/events` | New tests verify transcript and SSE data without launching a browser |
| Existing UI | Displays existing actor/activity/message surfaces from the events | No component, layout, styling, or dashboard changes |

No integration blocker was found that prevents a model-generated multi-assignment decision from reaching execution. No production source, prompt, model configuration, or architecture was changed.

The client includes the legacy `delegate` capability for coding-tool work as well as `delegate_text`. Respecting a natural-language text-only request is partly semantic decision behavior, not a separate new permission policy. The live acceptance harness rejects any non-text operation decision rather than running tools or replacing the model's choice. It does not force delegation, specialist IDs, worker count, objectives, or answers. Such a rejection is not successful acceptance.

## Synthesis correctness gap — reported without changing prompts

The current synthesis instruction identifies reports as untrusted model claims, asks Maestro to state failures/disagreements/missing evidence honestly, and says no tool work or external research occurred. It already distinguishes claims from verification.

However, that instruction is advisory. The path has no separate enforced claim reconciliation, correctness check, or independent analytical-answer verifier. A schema-valid model answer can still be wrong. The controlled synthesis's rolling-window, cancellation-slot, and test-expectation errors illustrate this limitation; their corrections were not added to production code or prompts. The deterministic fixture verifies that failed reports and supervision reach synthesis and the transcript; it cannot establish that a real model will reason correctly from them.

## Added general deterministic regression coverage

`apps/command-center/tests/runtime/autonomous-turn.test.ts` starts the actual server with its default production composition, a temporary SQLite store, and deterministic model clients. It invokes the real HTTP handler in-process with stream objects and `listen: false`; this avoids loopback restrictions without changing production networking. No fake WorkerRuntime, composition, assignment injection, fabricated timeline, or sleeps are used. Fake inference responses are explicitly unit/integration fixtures, not live acceptance evidence.

Three cases cover:

- A natural-language HTTP request producing a model-fixture `delegate_text` decision selecting two specialists (Research and Tester).
- A model-fixture decision selecting three specialists, proving the handler has no fixed two/three-worker assumption.
- One failed child with a successful sibling, failed report and worker.failed activity, followed by honest fixture synthesis.

Each case also checks a normal Hi turn with zero execution identities, exact model identity, concurrent running workers, positive recorded overlap, unique/consistent attribution, bounded worker context, synthesis reports/Goal Anchor/supervision, non-satisfied Goal, no Vision worker/resources/tools/artifacts, parent-only terminal events, transcript persistence, and SSE actor/message mapping. The server makes one semantic decision per request and reuses it rather than silently replanning.

These tests show that model-generated decisions are wired through the normal handler. They do not prove real-model autonomous decision quality.

## Actual current live outcome

One opt-in test submitted the exact natural-language acceptance goal through the same `/api/turns` handler, using real normal registry/native model clients and the explicitly selected NVIDIA pair. Provider configuration was opened read-only; transcript writes were isolated in a temporary application database. No pre-created assignments entered the request. A read-only observer captured validated semantic decisions if any; an acceptance safety gate rejected non-text decisions instead of executing tools.

The request failed at **Maestro semantic decision**, category **transport**. Result: **0 passed, 1 skipped**. No decision was returned, so:

- What Maestro decided: unavailable.
- Which Mediobots it selected and why: unavailable; no observable decision fields exist.
- Autonomous assignments, workers, overlap, and WorkerReports: not reached.
- Current real synthesis inputs/output: not reached.

No networking investigation, provider retry, Dahl request, or repetition of the controlled proof followed. Startup also logged workspace-watcher `EMFILE`; this was recorded as a separate environment warning, not asserted to cause the transport failure.

## Validation

| Check | Current result |
| --- | --- |
| New normal-handler/transcript/SSE tests | 3 passed |
| Existing model tests | 32 passed |
| Existing Maestro tests | 43 passed |
| Existing composition/parallel tests | 4 passed |
| Focused deterministic total | **82 passed** |
| Workspace typecheck | Passed |
| Production build | Passed; existing large-chunk warning |
| git diff --check / authored-file whitespace | Passed |
| Real natural-goal acceptance | Skipped after transport failure; not proven |
| Human UI acceptance | Pending |

Files changed in this continuation: new `autonomous-turn.test.ts`, new `autonomous-configured-acceptance.test.ts`, `CONTINUATION.md`, `PARALLEL-TEXT.md`, and this audit. Existing production/UI/Vision files were not edited.

## Exact human UI acceptance

In the normal Mac terminal:

```sh
cd /Users/rahulkarthikt/Documents/mediobot/mediobot-v2
pnpm dev
```

Open `http://127.0.0.1:4173` yourself. Use Maestro with the already-connected NVIDIA DiffusionGemma model selected in the existing composer. First submit `Hi`; expect an ordinary direct reply without specialist activity. In a new Maestro thread, submit only:

> Design a small in-memory rate-limited job queue for one Node.js process. It must allow at most five job starts in any rolling one-second window and at most two jobs executing concurrently. Design a correct implementation and explain the important tradeoffs and failure cases. Have your team help where useful, but you own the final answer. Text only—do not modify files, run commands, browse the web, or claim anything was tested unless it actually was.

Do not supply a fixed specialist roster or assignment list. Record the actual selected specialists/activity and final answer. A direct answer is a valid decision, but does not establish autonomous multi-worker decomposition. If specialists run, verify their timeline activity is genuine and the final answer uses their relevant contributions without fabricated research/testing or Goal-completion claims.

Evaluate correctness separately: the recommendation must meet the actual rolling-window and concurrency requirements, handle failure/cancellation honestly, and distinguish proposed acceptance checks from executed tests. A completed turn alone does not establish correctness.

The optional backend natural-goal diagnostic is:

```sh
MEDIOBOT_LIVE_AUTONOMOUS=1 MEDIOBOT_ALLOW_PROD_DB=1 node --experimental-strip-types --test apps/command-center/tests/runtime/autonomous-configured-acceptance.test.ts
```

This diagnostic can record actual semantic decision fields and worker timing without forcing the team shape. It is not a replacement for the required manual unchanged-UI acceptance. Do not call this milestone complete until that human run is reviewed.

No browser/Chromium/Playwright, Vision image calls, screenshots, OCR, or computer use was launched. No `.env` inspection, secrets exposure, hidden-reasoning dump, reset/clean, commit, or push. Unrelated dirty/untracked work was preserved.

## git status --short

Broad pre-existing dirty/untracked state:

```text
 M .gitignore
 M package.json
 M packages/cody/package.json
 D packages/cody/src/index.test.ts
 M packages/cody/src/index.ts
 M packages/domain/package.json
 D packages/domain/src/index.test.ts
 M packages/domain/src/index.ts
 M packages/runtime/package.json
 D packages/runtime/src/index.test.ts
 M packages/runtime/src/index.ts
 M packages/tools/package.json
 D packages/tools/src/index.test.ts
 M packages/tools/src/index.ts
 M pnpm-lock.yaml
 M pnpm-workspace.yaml
?? .env.example
?? CONTINUATION.md
?? apps/
?? mediobots/
?? packages/cody/src/agent.ts
?? packages/cody/tests/
?? packages/domain/COMPLETION-POLICY.md
?? packages/domain/tests/
?? packages/maestro/
?? packages/models/
?? packages/runtime/src/supervision.ts
?? packages/runtime/tests/
?? packages/tools/tests/
?? packages/vision/
```

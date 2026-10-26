# Vision acceptance foundation

Run from `packages/vision`:

```sh
pnpm test
pnpm typecheck
VISION_HEADED=1 node --experimental-strip-types --test --test-concurrency=1 tests/acceptance.test.ts
pnpm manual --goal 2
```

The manual command requires the existing model configuration. The deterministic tests require only installed Playwright Chromium, and never load `.env` or contact a model provider. Typechecking includes the fixtures and manual runner.

## Independent fixture verification

`fixtures/acceptance-verifier.ts` provides a generic `environmentVerifier(check)` implementing the production `GoalVerifier` contract. It ignores goal text, executor claims, and submitted observations. Failure to read state or cancellation produces `unknown`; a false predicate produces `not-verified`.

The benchmark-specific factory binds an explicit scenario ID and initial record identities before execution. It reads committed in-page fixture records via a separate Playwright evaluation, checks other records remain unchanged, and checks the target result is visible. Unsaved inputs and success notices are not sufficient. Archive acceptance additionally checks the fixture's actual confirmation event and its named target. Oracle state is never included in the decision provider's context.

The test-only page access cast follows the existing browser tests' seam; it is intentionally not exported as a production browser capability. This oracle trusts controlled fixture code. It is not an adversarial-page security boundary or a general verifier for arbitrary websites. “Committed” means the fixture's in-memory application state after its delayed callback, not durable server storage.

## Evidence obtained

- Full real-browser loop: search, observe an unambiguous edit control, select, premature finish rejected, save, wait, independently verified finish. Decisions in this test are scripted and grounded to current observation IDs.
- Fabricated success notice, wrong-record save, reload, and navigation away cannot produce acceptance.
- Open/cancelled archive confirmation cannot complete; a correctly named committed archive can. A deliberately mismatched confirmation is rejected even when the target is subsequently archived.
- Correct owner detail can be verified; page closure and cancellation cannot produce success.
- All four acceptance tests passed with `VISION_HEADED=1`; full suite: 47 passing tests. Typecheck passed including test/manual code.

## Remaining acceptance limits

- No real model was invoked in this validation. This is harness/contract evidence, not autonomous production Vision reliability evidence.
- Goal 1 verifies visible owner detail only. `BrowserAction.finish` has no answer field, so “tell me its owner” still needs human answer acceptance or a future answer contract.
- Archive evidence proves which confirmation was submitted, not that a model understood it.
- No 60-second stability soak, frame capture/flicker analysis, event-loop percentile measurements, OCR/canvas coverage, or process-leak telemetry was performed.
- Existing DOM observation names a select from option text rather than its associated label. The deterministic integration uses the sole observed combobox in the edit form.

## Normal registry integration found (read-only inspection)

Command Center's `src/composition.ts` registers `VisionExecutionAdapter` with a task-selected text client through `ModelDecisionProvider`, headed by default. `VisionExecutionAdapter` already supports an injected `goalVerifier`; normal composition does not supply one, so arbitrary goal completion remains conservatively unknown. A production solution needs an independently specified acceptance contract rather than reusing these fixture predicates or routing goal keywords.

The package also exports `OpenAICompatibleVisionClient`; the inspected normal browser decision wiring uses the text/DOM path. No screenshot-model decision integration or real model performance was established here.

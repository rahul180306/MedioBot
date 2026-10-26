# P1 hybrid Vision integration

> **Current acceptance blocked by visible size flicker.** During the newly authorized controlled session the user observed repeated normal/small tab-size transitions. The test browser was stopped and its owner confirmed absent. No more browser launches/connections without renewed approval. Eleven single-page functional checks passed, but do not prove visible stability. The new acquisition/post-action sampling patch remains unaccepted; review also found unbounded in-flight sample reads and a changed-state stability bypass at window expiry. See the latest section of `CONTINUATION.md` before acting on older validation statements below.

## Browser ownership architecture

- **Browser infrastructure lifetime is runtime-owned**: `PlaywrightBrowserRuntime` manages persistent Chromium process infrastructure across task executions. Applications and test suites create one runtime that survives across tasks.
- **Browser session/context/page lifetime is worker/resource-owned**: Each worker/assignment leases an isolated session via `acquireSession({ resourceId, workerId, taskId })` with its own isolated `BrowserContext` and `Page`. Releasing the session cleans up the context and page without closing the shared browser process.
- **Observation, action, and verification never own browser process lifetime**: Observers, actors, and verifiers read and operate only on the existing owned Page. Task completion or cancellation releases worker/session resources, never terminating the persistent browser process.
- **Underlying browser shutdown** occurs exclusively on explicit application/runtime shutdown (`shutdown()`), irrecoverable browser disconnection, or explicit lifecycle termination.

## Composition contract

All APIs below are exported by `@mediobot-v2/vision`. The normal model registry must supply a capability-compatible `StructuredModelClient`; this package does not choose a provider/model or route by website.

**Delivery scope:** this is a package-level capability and adapter integration seam. Normal startup currently does not inject visual/outcome policies. The hybrid path is exercised by deterministic browser/adapter tests; this is not a claim that hybrid Vision has shipped through the product UI.

- `createModelPerceptionProvider(client): PerceptionProvider` uses `client.complete({ system, input, images, signal })`. It does not use the legacy NVIDIA image client.
- `VisionExecutionAdapterOptions.createPerception({ context, browser, resourceId })` returns `VisualConfiguration | undefined`, once per execution.
- `VisionExecutionAdapterOptions.createGoalVerifier({ context, browser, resourceId })` returns `GoalVerifier | undefined`, once per execution. Existing `goalVerifier` remains the fallback, then the conservative unknown verifier.
- `VisionAdapterFactoryInput.context` is the existing `WorkerExecutionContext`. Factory inputs are trusted composition inputs. Do not compile model-authored finish fields or natural-language claims into verification policy.
- `VisionBrowser` exposes optional capture/outcome-reader capabilities for custom browser factories. The default `PlaywrightBrowserPage` implements both. Bind methods to the browser instance when constructing interface wrappers.

For example, root composition can use its own trusted per-task resolvers:

```ts
import { VisionExecutionAdapter, createModelPerceptionProvider,
  createBrowserOutcomeVerifier } from "@mediobot-v2/vision";
import type { DecisionProvider, VisualPolicy, BrowserOutcomePolicy } from "@mediobot-v2/vision";
import type { StructuredModelClient } from "@mediobot-v2/models";
import type { WorkerExecutionContext } from "@mediobot-v2/runtime";

export function makeVisionAdapter(
  decisions: DecisionProvider,
  resolveVisual: (context: WorkerExecutionContext) =>
    { client: StructuredModelClient; policy: VisualPolicy } | undefined,
  resolveOutcome: (context: WorkerExecutionContext) => BrowserOutcomePolicy | undefined,
) {
  return new VisionExecutionAdapter({
    decisions,
    createPerception({ context, browser }) {
      const config = resolveVisual(context);
      if (!config) return undefined;
      if (!browser.withViewportCapture) throw new Error("Browser cannot capture a viewport");
      return {
        policy: config.policy,
        provider: createModelPerceptionProvider(config.client),
        captures: { withViewportCapture: browser.withViewportCapture.bind(browser) },
      };
    },
    createGoalVerifier({ context, browser }) {
      const policy = resolveOutcome(context);
      if (!policy) return undefined;
      if (!browser.readOutcome) throw new Error("Browser cannot read outcome state");
      return createBrowserOutcomeVerifier({ readOutcome: browser.readOutcome.bind(browser) }, policy);
    },
  });
}
```

Direct loop users supply `AutonomousBrowserTaskOptions.visual = { policy, provider, captures }` and `goalVerifier`. The executable observation is the original frozen driver object, with its WeakMap-bound exact handles. Custom providers still return canonical decisions with `observationRevision`.

## Selective perception and bounds

`VisualPolicy` has `maxCalls` (integer 1–20), optional `required`, `onAmbiguity`, and `onNoEffect`. The policy is copied at task construction; budgets are per task, not shared by the provider.

- No visual configuration, or no enabled trigger: zero captures and zero image requests.
- `required: true`: perceive before every decision, including finish. Exhaustion fails closed.
- `onAmbiguity: true`: perceive when enabled controls have blank names or duplicate role/name pairs.
- `onNoEffect: true`: perceive after no observed progress, an unverified intended effect, or a rejected finish. Optional exhaustion resumes DOM-only decisions; it does not replenish the budget.
- At most one perception attempt per decision. Failures consume the attempt and stop the task; no hidden image/model retries.
- The existing provider timeout (default 30 seconds) also bounds capture + perception. Aborting it closes only the owning page and clears the owned byte buffer, even if a custom provider ignores its signal. Late results cannot execute.

The model returns exactly:

```json
{"facts":[{"text":"visible label or appearance","candidateTargetIds":["e2"],"region":{"x":160,"y":8,"width":140,"height":70}}]}
```

Maximum 24 facts, 240 characters per fact, eight candidate IDs per fact, 24,000 response characters. Every ID must already exist in the current observation. Each positive-size region must be entirely inside the viewport. Additional fields are rejected. There is no action, selector, completion, or policy field. Free text is explicitly treated as untrusted, fallible data, not instructions or proof.

Runtime attaches `VisualEnvelope = { provenance, facts }`. `provenance` contains `resourceId`, `revision`, `fingerprint`, `imageHash`, `width`, and `height`. The optional fifth argument of `DecisionProvider.decide(goal, observation, history, signal, visual)` carries this envelope separately. `ModelDecisionProvider` serializes it as `visualEvidence`, without image bytes. It never decorates or clones the executable observation.

## Capture and execution identity

`PlaywrightBrowserPage.withViewportCapture(observation, signal, consume)` captures an in-memory viewport PNG at CSS scale, bounded to 8 MiB. The callback receives ephemeral bytes and immutable provenance. The driver owns the resource and requires the exact previously issued observation object; cloned and cross-session observations fail even if fingerprints match.

Capture holds the driver's action lock. Revision/fingerprint checks bracket capture and perception; a second screenshot must have the same SHA-256 hash after perception. A captured observation carries an internal hash association; dispatch rechecks its pixels before executing a subsequent action. Main-frame navigation advances the revision, including identical-document reloads. Bounds are included in both observation and live fingerprint computations. Descriptions are read from the acquired exact handle, not from a locator before handle acquisition. Live validation checks the original handle identities and DOM order in the same browser evaluation as their properties/bounds. Identical-looking nodes swapped into each other's positions invalidate the old observation even when both fingerprint and screenshot are unchanged; the driver never substitutes a new node.

Owned PNG buffers are zeroed on return/error/abort. Base64 encoding uses a Buffer view over the supplied Uint8Array's buffer/offset/length, without copying the PNG bytes. No screenshots, raw model replies, visual fact text, or image data URLs are written to World or progress logs by this path. The structured client necessarily receives an ephemeral base64 request string; JavaScript cannot guarantee zeroization of strings or copies retained by an injected client/provider. Such clients must not log/retain request bodies.

Every decision provider, including deterministic/custom providers, crosses `validateDecision` before the loop accepts its result. The driver also validates direct actions. Target actions use original exact element handles, never selectors derived from perception or coordinate clicks. Standard `searchbox` inputs are accepted by the shared type-action validator.

## Effects and completion

`ActionAttemptEvidence.changed` / `effect` describe observed before/after difference, not causality or intent fulfillment. `intendedEffect` is separate:

- `type` / `select`: poll the original element handle for the requested value.
- `navigate`: poll the resolved requested URL; redirects to other URLs are conservatively unverified.
- These checks require three consecutive samples approximately 50 ms apart within a 600 ms polling window.
- Other actions return `unknown`; a click-induced page difference is not declared an intended verified effect.
- `HistoryEntry.intendedEffect` and the model's recent-action context expose this distinction. Failed intended effects count toward the no-progress/escalation budget.

Each finish obtains a fresh observation before calling the independent verifier, then observes again after verification for current evidence/context. A verified result is accepted only if both revision and fingerprint equal the pre-verification sample; otherwise the result is downgraded to `not-verified` and a later finish must verify again. Thus a disappearing success cannot acquire verified evidence carrying the changed post-state fingerprint. This is a conservative sampled-token check, not an atomic transaction or protection against every unobserved ABA state change. Model finish is only a request. The default verifier still returns `unknown`.

`createBrowserOutcomeVerifier(reader, { all, timeoutMs? })` copies and validates a trusted declarative policy. `all` contains 1–24 predicates:

- `{ kind: "url", equals: string }`
- `{ kind: "text", includes: string }` — rendered body text
- `{ kind: "element", selector: string, property: "value" | "text", equals: string }`
- `{ kind: "element", selector: string, property: "visible" | "enabled" | "checked", equals: boolean }`

Element selectors are **CSS selectors**, trusted configuration only, at most 500 characters. They must match exactly one HTMLElement. Values/text are bounded to 2,000 characters. `enabled` checks native disabled state and `aria-disabled`; `visible` checks layout/CSS/ARIA/inert state, not viewport occlusion. `checked` reads native input state.

The default reader samples all predicates synchronously in one read-only page evaluation, avoiding torn combinations across DOM states. Two consecutive matching samples are required, polling about every 50 ms. `timeoutMs` is 50–5,000 ms (default 1,000). Failure to match is `not-verified`; unreadable/invalid browser state is `unknown`; cancellation propagates. No click, navigation, script supplied by the policy, or hidden action sequence is allowed.

## World evidence integration

All records carry the running `taskId` / `workerId`, resource `subject`, and observation-fingerprint `revision`:

- `kind: "visual-observation"`, `source: { type: "browser-perception", reference: resourceId }`, `validity: "observed"`: only capture provenance and fact count.
- `kind: "browser-action-attempt"`, `source: { type: "browser-outcome", reference: resourceId }`, `validity: "observed"`: sanitized attempt metadata, revisions, hashes, execution/effect classifications. No typed values, keys, URL strings, or target names.
- `kind: "browser-task-outcome"`, same outcome source: verified only when the trusted verifier returned `verified`; otherwise observed. The revision identifies the post-verification observation, not an atomic database commit or durable external transaction.

Root may use these task-scoped records in its explicit evidence policy. Vision does not attach a `goalId`, assess criteria, or automatically satisfy Goals.

## Safe diagnostics

`ModelActionDiagnostic` exposes only allowlisted schema key names and known action discriminators. Unknown keys contribute `unknownKeyCount` / `nestedUnknownKeyCount`; unknown discriminator strings become `unknown`. Arbitrary alphabetic strings are not safe diagnostic labels. The same restrictions apply to nested action diagnostics and error messages.

`VisionDiagnostic` is now `ModelActionDiagnostic | PerceptionFailureDiagnostic`. Perception failures reach the failed task result, progress event and adapter `onDiagnostic` callback as `{ kind: "perception-failure", source: "model" | "environment", code }`. Model codes are allowlisted (`authentication`, `capacity`, `invalid-response`, `configuration`, `timeout`, `cancelled`, `transport`, `structured-parse`, `unsupported-modality`). Malformed perception output is `model/invalid-response`; capture failures are `environment/environment`; the aggregate perception deadline is `environment/timeout`. Caller cancellation still returns the cancelled task state.

`PerceptionFailure` is an exported typed error with a fixed safe message and diagnostic. The adapter preserves this category in its thrown error after publishing the diagnostic. Provider messages, diagnostic objects and causes are not forwarded. Custom provider failures lacking a typed code become `model/transport`. This does not alter the shared models client or imply automatic retry of capacity/environment failures.

## Validation and limits

**User pause in effect:** do not launch headed or headless browsers, run the full Vision suite, or run browser regression files until the user explicitly authorizes browser execution again. Browser rerun and investigation are pending. The current allowed checks are typecheck and the isolated browser-free `model-boundaries.test.ts` file.

Allowed checks during the pause:

```sh
pnpm --filter @mediobot-v2/vision typecheck
node --experimental-strip-types --test packages/vision/tests/model-boundaries.test.ts
```

Historical browser validation (executed **before** the user pause; commands below are not authorization to rerun):

```sh
pnpm typecheck
pnpm --filter @mediobot-v2/vision test
VISION_HEADED=1 node --experimental-strip-types --test --test-concurrency=1 packages/vision/tests/hybrid.test.ts
```

- Workspace typecheck passed after the review fixes; Vision typecheck also passed after the reordered-control test updates.
- Before review: 60 Vision tests and 13 headed hybrid tests passed.
- After review fixes, before pause: **66 Vision tests passed**. Six new review regressions cover same-handle descriptions, identical-node swaps with unchanged pixels, disappearing finish success, alphabetic diagnostic leakage, zero-copy image encoding, and safe typed error propagation through the adapter.
- Latest headed review/hybrid run, before pause: **18 passed, 1 failed**. The optional no-effect budget fixture received a safe `environment/environment` perception failure instead of reaching its no-progress limit. Root cause is unconfirmed. All six review regressions passed headed. This is **not** an all-green headed acceptance result; investigation and rerun are pending user permission.
- `model-boundaries.test.ts` is deliberately browser-free: synthetic observations, stubbed in-memory model responses, and no browser setup, runtime adapter, network request, or launch call. New pure tests were added after the pause; they do not replace the pending browser rerun.
- After the pause: Vision typecheck passed and **4 browser-free boundary tests passed** using only the allowed commands above. No browser tests or full Vision suites were run after the interruption.

This is deterministic real-browser acceptance, not connected-model reliability evidence. Existing `CONTINUATION.md` and driver/model/runtime/domain contracts supplied the implementation baseline; no third-party perception implementation or new dependency was imported. The relevant workflow stages were contract inspection, boundary design, implementation, real headless/headed execution, and adversarial invariant tests.

Limits: exact image hashes conservatively reject animation or other changing pixels; bounded DOM targets omit arbitrary canvas-only controls, frames, and shadow-root controls; regions do not create new executable targets. Checks prove sampled browser state within bounded windows, not persistence after that window or backend delivery. There is no general natural-language-goal verifier. A connected-model browser run, ordinary-site generalization, 60-second stability soak, and frame/event-loop telemetry remain separate acceptance work; no flicker/performance/reliability-rate claim is made here.

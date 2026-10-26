# Execution Recovery Changes

## Changes

- `packages/cody/src/agent.ts`: Cody now runs the existing `structuredJsonOnly` normalization at its decision boundary, validates each action against an exact allowlist/schema, distinguishes malformed JSON, invalid action shape, and unsupported action intent, and provides fixed actionable schema feedback for one bounded retry (two total attempts). Provider timeouts, transport errors, and cancellation are not retried. Rejected response content is never inserted into diagnostics or feedback.
- `packages/cody/src/agent.ts`: all ordinary failed tool operations are preserved in Cody’s bounded history and returned for a next model decision. Tool failure does not create success evidence. A cancelled invocation remains terminal; a task-level abort is still handled by WorkerRuntime.
- `packages/maestro/src/index.ts`: Maestro’s existing bounded structural retry is retained; the existing shared JSON/reasoning normalizer is also applied at the Maestro parser boundary so direct compatible clients and deterministic doubles receive the same normalization contract.
- `packages/cody/tests/agent.test.ts`, `packages/maestro/tests/reliability.test.ts`: deterministic coverage for malformed/wrapped decisions, bounded retry, no raw response echo, actual root/nested file listings reaching Cody continuation/final summary, legitimate repeated reads, repeated-action stopping, failed read/search/edit recovery, and existing verification attribution.
- `apps/command-center/tests/runtime/cody-turn.test.ts`: normal `/api/turns` path uses a fake model client, real temporary workspace, production Maestro/Cody/runtime/tools, and SQLite; the model double receives actual filename results and the persisted final message contains those exact names.
- `packages/maestro/src/index.ts`, `packages/maestro/src/text-workers.ts`: text delegation now retains the canonical context compiled for the initial Maestro decision during synthesis. Synthesis receives the original user goal/history/workspace/project/roster/tool/skill context plus bounded worker reports and goal anchor; its executable intent set stays limited to response/clarification.
- `apps/command-center/tests/runtime/cody-turn.test.ts`: added production `/api/turns` checks for the loaded Maestro definition and authority guard, direct conversation without a worker, no-workspace delegation rejection, and text-worker result synthesis with the original SQLite history and active project identity.

## Safety properties retained

- ToolRuntime remains the authorization, containment, and filesystem execution boundary.
- The original bounded Cody action loop and repeated-identical-action recovery remain in force.
- Model-generated summaries remain model claims, not verification evidence.
- No model provider, Vision, browser, or UI implementation was changed.

## Not claimed

No MiniMax request was made. These fixes show deterministic contract behavior, not guaranteed live-model completion.

## M3.3 runtime stabilization

- Root test execution is serialized and categories for backend, workspace watchers, UI, E2E, and Vision tests are explicit. The default test path excludes browser/UI/live-provider suites; it does not make native watcher failures disappear.
- `apps/command-center/src/workspaceManager.ts` now scopes native `WorkspaceWatcher` lifetime to active workspace-event subscribers, reuses a watcher for the same canonical root, and closes it on last unsubscribe, close, switch, and dispose. `restoreLastWorkspace()` also synchronizes watcher state on both early returns that clear an absent/missing workspace.
- Manager-owning workspace tests dispose managers; native create/delete watcher checks run as an explicit standalone probe rather than being mixed into the broad node:test suite.
- Deterministic Cody/Maestro/model/workspace tests remain passing. The full runtime matrix is not green: the hybrid Vision composition test has two completion-state assertion failures and its localhost API test is blocked by `listen EPERM`; the standalone native watcher probe fails `EMFILE`. These are not reclassified as passes or silently skipped.

## MiniMax adapter source audit (no credentials or provider request)

- The catalog identity is Dahl / `MiniMaxAI/MiniMax-M2.7` at `https://inference.dahl.global/v1` (`apps/command-center/src/runtime/modelRegistry.ts`). It uses the generic OpenAI-compatible adapter, not a MiniMax-specific SDK.
- The normal request path retains the selected model ID, sends `max_tokens: 4096` by default, JSON-object response mode, and system/user messages; the default client timeout is 120 seconds. A task `AbortSignal` is propagated through an abortable fetch/body parse (`packages/models/src/index.ts`).
- Response handling requires a nonempty string at `choices[0].message.content`, then applies `structuredJsonOnly`; Maestro/Cody apply their own semantic decision validation. Malformed JSON, missing content, transport errors, HTTP status classes, cancellation, and timeout have deterministic tests.
- **VERIFIED:** explicit `choices[0].finish_reason === "length"` is rejected as a structured parse/truncation failure before content parsing; a deterministic transport regression verifies one call and safe error handling.
- **UNPROVEN:** tests remain generic OpenAI-compatible transport/parser tests, not a recorded live MiniMax contract. Other provider-specific finish reasons/envelopes and actual reasoning-tag/output behavior are unverified. No credential value was read and no provider request was made.

## Maestro definition and runtime integration

- The authoritative source remains `mediobots/maestro/MEDIOBOT.md`; no identity/instruction content was rewritten. `apps/command-center/src/composition.ts` reads and parses it during composition, `createMaestroCodyExecution()` registers it into the domain, and `MaestroExecutionAdapter.decideTurn()` places the registered instructions in the exact model input via `compileMaestroContext()`.
- The normal `/api/turns` path supplies the current goal, SQLite-derived recent history and previous-turn execution evidence, active workspace identity/state, project intelligence, actual assignable definitions/capabilities, tool metadata, and compact available skill metadata. Skills and definitions remain guidance; `ToolRuntime`/`ToolPermissionEngine` enforce actual filesystem and terminal permissions.
- No-workspace decision context was misleading: delegation intents were disabled but specialist IDs still appeared assignable. The adapter now sends no assignable IDs until workspace execution is authorized. It also projects Research/Tester assignment capabilities as text-only where that is the actual selected execution path.
- Deterministic production-path regressions cover definition propagation, direct response without execution, SQLite history and prior failure evidence, canonical active workspace identity, specialist metadata, real Cody tool evidence, and rejection of model-requested delegation without an authorized workspace.
- No implementation was added for production `acquire_context`/`use_capability` decisions or selecting full skill bodies; these remain outside the currently executable Maestro intent set.
- A production traversal-attempt regression confirms the real runtime denies a model-selected out-of-workspace read and does not pass synthetic outside content into later model context, evidence, events, or persistence.

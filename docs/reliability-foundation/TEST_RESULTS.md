# Test Results

## Targeted deterministic runs

- **PASS:** Cody agent tests — 19 tests, all pass (`packages/cody/tests/agent.test.ts`). The Cody package suite is 21/21 including the separate native-tool proof file. Covers tool/runtime execution, malformed and reasoning-wrapped JSON, bounded repair, root/nested real file listing, legitimate repeated reads, no-progress recovery, failed read/search/edit handling, and verification evidence.
- **PASS:** Maestro reliability tests — 13 tests, all pass (`packages/maestro/tests/reliability.test.ts`). Structural repair remains bounded, semantic/transport errors do not retry, cancellation remains intact, and reasoning/prose-wrapped JSON is normalized.
- **PASS:** command-center Cody production-path plus execution-evidence tests — 11 tests, all pass (`apps/command-center/tests/runtime/cody-turn.test.ts`, `apps/command-center/tests/runtime/execution-evidence.test.ts`). Includes real temporary filesystem entries via `/api/turns`, exact filenames in persisted final message, SQLite-derived “Why?” continuity despite stale client history, project mismatch rejection, persistence/restart, and workspace isolation.
- **PASS:** model normalization/cancellation tests — 35 tests, all pass (`packages/models/tests/index.test.ts`, `packages/models/tests/cancellation.test.ts`).
- **PASS:** project-awareness workspace tests — 12 tests, all pass (`apps/command-center/tests/workspace/maestro-project-awareness.test.ts`).
- **PASS:** full workspace TypeScript typecheck (`pnpm typecheck`, all nine packages).

## Environmental test note

Command-center tests emitted non-failing `EMFILE: too many open files, watch` warnings from temporary `WorkspaceWatcher` setup. Assertions passed; the watcher limit warning is retained as an environment/resource risk for the final report. No browser or provider was run in these targeted commands.

## Broad suite and final checks

`pnpm -r --workspace-concurrency=1 test` was attempted and **failed** in an earlier tree snapshot. Its output recorded watcher `EMFILE` and 219 tests / 178 pass / 36 fail / 5 skipped; those historical totals are not a current-suite result. The current `workspace-foundation.test.ts` no longer contains Gates N/O (the create/delete event check is the separate `test:watchers` probe), so the old gate attribution should not be used to describe current coverage. Do not claim the full safe suite passes.

- **PASS:** `pnpm typecheck` across all nine packages.
- **UNRESOLVED:** `git diff --check` reports a trailing blank line at EOF in the already-dirty `packages/tools/src/index.ts`; it was not changed as part of this work because that file had unrelated pre-existing modifications.
- **NOT RUN:** graphical browser/UI tests, headed tests, and live provider calls.

The repository already contained unrelated dirty and untracked work at the start of this milestone. Results apply to that working tree, not to a clean-commit baseline.

## Maestro definition/context integration (2026-10-13)

- **PASS:** production `/api/turns` direct-conversation test confirms the canonical Markdown definition and runtime-authority guard reach the selected model, returns a persisted answer, and creates no execution task.
- **PASS:** no-workspace test confirms a model-requested delegation has no assignable definitions/available delegation intent and starts no execution.
- **PASS:** text-specialist production-path test confirms the definition and authority guard reach both initial planning and synthesis; synthesis preserves the original prompt, SQLite-derived history, canonical workspace state, real bounded worker report/evidence, and can only respond or request clarification.
- **PASS:** production traversal-attempt regression confirms ToolRuntime denies an out-of-workspace read and its synthetic sentinel does not reach continuation, evidence, events, or persistence.
- **PASS:** Cody production delegation and execution-evidence regressions remain green. Combined Cody-turn and execution-evidence suites: 15/15; with the autonomous text-worker cases, the targeted production-path set is 18/18.
- **PASS:** Maestro package suite: 57/57; `pnpm typecheck`; command-center production build.
- **PASS:** autonomous text-worker suite: 3/3 (two-worker success, three-worker success, partial failure); Tool Permission Engine suite: 14/14.
- **NOT RUN:** live provider requests, Vision, and graphical UI tests.

## M3.3 stabilization revalidation (2026-10-13)

- **PASS:** Cody package suite — 21/21.
- **PASS:** Maestro package suite — 57/57 across its three suites.
- **PASS:** `/api/turns` Cody production-path plus execution-evidence tests — 11/11. These use deterministic model doubles and local disposable projects; no live model/provider call was made.
- **PASS:** model parsing/cancellation focused suites — 35/35.
- **PASS:** project-awareness suite — 12/12, including workspace capture/switch/closed-workspace contract coverage.
- **PASS:** workspace foundation suite — 25/25 deterministic gates (native watcher event probe is separate).
- **PASS:** `pnpm typecheck` across all nine packages.
- **PASS:** command-center Vite production build. Build warns that the main JavaScript chunk is 2.4 MB minified (789 kB gzip); no frontend redesign or code splitting was attempted in this milestone.
- **FAIL / environment not isolated:** `vision-hybrid-composition.test.ts` yields 4 failures: two deterministic task assertions return `failed` where the test expects `completed`, and localhost API setup fails `listen EPERM: operation not permitted 127.0.0.1`. These are confirmed failures; the exact reason for the task-state mismatch was not exposed by the test output and remains unproven. The HTTP failure is consistent with sandbox bind restrictions, but was not reproduced outside the sandbox.
- **FAIL / underlying watcher facility:** a disposable diagnostic compared bare recursive `node:fs.watch` with `WorkspaceWatcher`. Both initialized, then both emitted asynchronous `EMFILE: too many open files, watch` during create-event observation; no create event arrived. This establishes failure below Mediobot's wrapper, while the exact host quota/sandbox cause remains unknown. Do not claim watcher delivery passes in this environment.
- **INCOMPLETE:** one serial root `pnpm test` run was interrupted after it stopped producing output. The targeted rerun established the hybrid-composition failures above. The historical 219/178/36/5 result is not a proven failure breakdown; only workspace watcher Gates N/O were directly tied to EMFILE, so the remaining old failures are unclassified.
- **UNRESOLVED:** `git diff --check` still reports a trailing blank line at EOF in already-dirty `packages/tools/src/index.ts`; that file was not changed for this stabilization work.
- **NOT RUN:** browser UI, headed Vision, real Vision tasks, and live provider calls. No credentials were inspected.

## Deterministic backend revalidation (2026-10-13 continuation)

- **PASS:** all command-center runtime, persistence, and workspace `*.test.ts` files except Vision-named files: 214 tests total, 210 passed, 0 failed, 4 skipped because live-provider opt-in was absent. Run with loopback enabled; live opt-ins were explicitly set empty. No browser automation or provider calls ran.
- **PASS:** `cody-turn.test.ts` + `autonomous-turn.test.ts`: 12/12; `live-execution-foundation.test.ts` + `events.test.ts`: 16/16; workspace project-context set: 47/47; isolated SQLite/chat persistence file: 28/28; provider/model-registry: 14/14.
- **PASS:** seven non-Vision/non-command-center package suites; `pnpm typecheck`; command-center production build.
- **UNRESOLVED:** Vision-hybrid composition test was excluded by instruction and its prior task-state failures were not re-investigated. Do not fold this outside-scope test into the non-Vision backend pass.
- **BLOCKED:** approved MiniMax M2.7 live check cannot resolve `inference.dahl.global` (`ENOTFOUND`) in this environment; no model completion was obtained.
- **WATCHER ENVIRONMENT:** read-only `ulimit -n` reports 1,048,575, while `launchctl limit maxfiles` reports a soft limit of 256 (hard limit unlimited). This is relevant host context but does not by itself prove which OS limit triggers recursive `fs.watch` `EMFILE`; no limit was changed.
- **PASS (outside sandbox):** `pnpm --filter @mediobot-v2/command-center test:watchers` passed create/delete observation in a disposable temp project (78 ms) with local filesystem watcher access. Together with the sandbox-only `EMFILE` reproductions, this classifies watcher delivery failure as an execution-sandbox limitation for this run; no OS limits changed.
- **NOT RUN:** graphical browser/UI automation, Vision tests, and full root `pnpm test` (would run the Vision package).

The workspace manager now creates a watcher only while an event subscriber needs it and disposes it on unsubscribe/close/switch. A follow-up code review found and corrected two `restoreLastWorkspace()` early returns that otherwise could retain an old watcher after clearing workspace state. Native watcher event delivery still requires a normal local-machine rerun.

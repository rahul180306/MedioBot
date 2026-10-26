# Project Context Verification

## Workspace authority

- **VERIFIED:** a turn captures the active open WorkspaceSession before later awaits. Existing session validation, project-intelligence construction, execution options, Cody workspace resource binding, and ToolRuntime containment remain the resource path.
- **VERIFIED:** `/api/turns` now rejects an explicitly requested project ID that is absent/unavailable or differs from the active session, and rejects continuation of a persisted project-bound thread when another workspace is active. Rejection is HTTP 409 and happens before prompt persistence/model invocation.
- **VERIFIED:** project-independent threads acquire the active project ID when the first accepted project turn is persisted. Existing nonempty project IDs are not silently reassigned.
- **VERIFIED:** workspace switch during an already-started decision cannot change that turn’s root; existing MPA-10/MPA-12 and Cody workspace-isolation tests cover the captured session behavior.
- **VERIFIED:** new integration test seeds a project-A thread, switches to project B, then verifies 409, no model call, no appended prompt, and unchanged thread association.
- **VERIFIED:** a separate closed-workspace regression continues a persisted project-bound thread conversationally with `workspaceExecutionAuthorized: false`, no `workspaceRoot`, and `workspaceState: EMPTY`; it does not submit project execution.
- **VERIFIED:** a production text-worker synthesis call receives the same canonical workspace identity/root/status and recent SQLite conversation as initial Maestro planning, along with the actual bounded worker report and original user goal.

## Continuity authority

- **VERIFIED:** up to four prior turns are now derived from SQLite and sanitized before the next Maestro call. Client-supplied `recentHistory` is ignored because AppContext is a projection, not durable truth.
- **VERIFIED:** the previous-turn execution summary/evidence is assembled from the stored turn, retaining the existing attribution and evidence-validity path.
- **VERIFIED:** the “Why did you fail?” production-path regression now also submits deliberately stale client history and verifies the model receives persisted history instead.
- **VERIFIED:** existing restart regression reloads failed execution evidence from the same SQLite database after server recreation.

## Filesystem path boundary

No new filesystem access path was added. Project discovery continues through WorkspaceManager and ToolRuntime’s canonical workspace binding/containment. The regression list scenario uses disposable roots only and verifies that the sensitive `.env` name is not returned.

## Limitations

Conversation continuity is durable and thread-scoped. This change does not implement cross-thread learned project memory or auto-extracted user facts. Real filesystem performance and provider behavior remain unverified.

## M3.3 revalidation

The workspace/project path remains covered by the 12-test project-awareness suite, all passing on 2026-10-13. The workspace event watcher is now opened only for active subscribers and is stopped on workspace transitions/disposal. A code review found and the implementation corrected stale watcher ownership on `restoreLastWorkspace()` early returns. A follow-up disposable comparison created both a bare recursive `node:fs.watch` watcher and the `WorkspaceWatcher` wrapper successfully, but both emitted asynchronous `EMFILE: too many open files, watch` on the first filesystem event; neither delivered an event. This reproduces below Mediobot's wrapper. The exact host quota/sandbox cause remains unknown, so native event delivery cannot be claimed in this environment. Explicit workspace reads and deterministic session/context tests are separate from this OS watcher facility.

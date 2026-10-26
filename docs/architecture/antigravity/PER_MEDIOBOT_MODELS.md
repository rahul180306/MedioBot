# Exact per-Mediobot model selection — implementation guide

Source audit: 2026-10-26, current dirty worktree. No provider calls or settings changes. Paths are repository-relative.

## Current architecture and gaps

- **Working in source:** `apps/command-center/src/features/composer/Composer.tsx` reads specialist preferences and sends selected model/effort. `state/AppContext.tsx` persists `mediobot_agent_preferences_v5`; `state/agentModelRouting.ts` resolves provider-qualified selections and builds `assignmentModelSelections`. Duplicate display names are not model identities.
- **Working in source:** `src/runtime/client.ts` sends these values; `src/server.ts`, `POST /api/turns`, validates exact provider/model pairs, active specialist identities and configured availability. `src/runtime/modelRegistry.ts`, `ModelResolver.resolveClient`, rejects stale/disabled explicit selections and constructs the selected transport/model.
- **Working in source:** `packages/maestro/src/index.ts`, `resolveDurableChildModelSelection`, prefers persisted child selection on recovery. Cody/text/web adapters resolve assignment overrides; current durable child records must remain authoritative on resume.
- **Confirmed gap:** `buildAssignmentModelSelections` carries provider/model only. The server accepts no per-specialist effort map and forwards one parent `reasoningEffort`. Delegated Cody/text/web paths read that shared option, so their own Settings effort is not reliably represented.
- **Confirmed fallback paths:** missing assignment overrides inherit the parent selection in `resolveDurableChildModelSelection`, text/web adapters; `ModelResolver.resolveClient(undefined)` chooses the first enabled text model. UI omits specialists with missing preferences. These paths cannot guarantee every delegated bot uses an explicit personal selection.
- **Confirmed reporting gap:** `packages/maestro/src/web-workers.ts`, `WebAgentExecution.execute`, catches model-resolution failure and proceeds as `deterministic-extractor`/`fallback`. This is local extraction, not another model, but must be reported explicitly rather than presented as selected-model execution.
- **Partial effort support:** `packages/cody/src/agent.ts` forwards `reasoningEffort` to the compatibility request. Text/web requests primarily add prompt guidance. `packages/models/src/index.ts` serializes `reasoning_effort` only when the exact protocol profile lists both parameter and value. UI `extra`/`max` must not be silently equated with provider values such as `xhigh`.

## Minimal implementation

1. Extend the existing assignment selection contract with a bounded per-specialist effort map (or one typed selection record); reuse existing contracts, preference IDs and provider/model identities. Keep current Settings and composer controls.
2. Carry the record through `agentModelRouting.ts` → AppContext → runtime client → server validation → task submission. Validate effort enums and conflicting aliases. For managed model-backed specialists, missing/invalid personal configuration must block that assignment explicitly; never default to Maestro or the first enabled model.
3. Persist provider, exact model ID and requested effort with the existing durable child execution snapshot before inference. Resume from that snapshot even if Settings changed. Inspect current durable options/repositories before adding fields; use an additive migration only if required. Never persist secrets in task metadata.
4. Pass each child's effort to Cody, text and web compatibility requests, including repairs, responder calls and synthesis updates. Maestro synthesis uses Maestro's captured selection. Deterministic Tester/tool execution should report no inference rather than invent a model invocation.
5. Retain `ModelResolver` and exact protocol profiles. Record requested versus effective effort and explicit unsupported status. Unsupported effort needs an approved documented policy; never silently claim the provider honored it or switch model/protocol guarantees.
6. Publish bounded actual provider-connection ID/model/protocol attribution from resolved clients. Keep account credentials server-side. Surface unavailable-model extraction as a degraded local result, not successful AI execution.

## Acceptance and dependencies

- Extend `tests/runtime/agent-model-routing.test.ts`, `model-registry.test.ts`, `model-compatibility-production.test.ts`, `tests/ui/model-identity.test.ts`, plus existing Maestro adapter tests.
- Controlled production `/api/turns`: different Maestro/Cody/Doc/Research provider IDs, exact model IDs and effort values; intercept transport bodies and assert every initial/repair/peer/synthesis call. Do not infer execution from stored preferences alone.
- Use identical model display labels across providers; missing, disabled and stale selections must never invoke another model. Preserve successful siblings when one assignment is blocked.
- Restart/approval resume retains captured selections; Settings edits affect subsequent tasks only. Verify supported effort serialization and explicit unsupported-value handling.
- Keep permissions/action validation, LangGraph, Governor and current UI intact. No new dependencies, model processes, credentials inspection, provider calls or automatic configuration edits.
- Real-model adherence/latency remains unverified until separately authorized zero-cost live acceptance. Cross-platform acceptance requires Windows and macOS runs.

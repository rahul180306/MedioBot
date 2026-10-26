# Memory Architecture Decision

## Current state

SQLite is already the durable authority for thread turns, project association, tool/activity summaries, and execution evidence. Project intelligence is bounded, on-demand filesystem context. Maestro exposes a `relevantMemory` context seam, but this repository has no producer or durable memory table. The new reliability behavior uses persisted SQLite turns and execution outcomes as bounded conversational memory; it does not promote model-generated summaries into verified facts.

## Evaluation

| Option | License / local fit | Cost and overlap | Decision |
|---|---|---|---|
| Mem0 | Its upstream repository identifies Apache-2.0 and supports open-source library/self-hosted and hosted modes. Local use is possible, but a useful semantic setup requires configured extraction/retrieval models and storage choices. | Adds a memory engine, extraction policy, and retrieval/dependency surface. It does not solve provenance automatically for Mediobot’s execution evidence. | Do not integrate in this milestone. Re-evaluate as an optional adapter only if local retrieval tests show native retrieval is insufficient. |
| Letta | Upstream identifies Apache-2.0; current source includes a stateful agent harness with local/self-hosted usage. | Broader harness, agent lifecycle, tools, and orchestration overlap with Mediobot’s native runtime and are outside the allowed ownership boundary. | Do not integrate as runtime or memory owner. Inspect its user-visible/inspectable memory ideas only. |
| Native SQLite | Already bundled and used; fully local; no additional package/service/model is required. Scope, provenance, deletion, and project partitioning can be controlled by Mediobot. | Lowest operational and dependency cost; retrieval can begin as explicit project-scoped metadata/keyword search. Semantic recall is not implied. | Keep SQLite as the durable truth. Current transcript plus typed execution evidence is the minimum implemented continuity layer. Do not add fact extraction until user controls and provenance transitions are specified and tested. |

## Provenance rule

Current durable records keep their source/actor/status distinctions: user messages are user-authored; tool outcomes and executed checks are observed evidence; Cody/Maestro summaries are model claims, not verification. No generated hypothesis is automatically persisted as a confirmed project fact. Changed project facts are not inferred from an old transcript; current filesystem/project discovery remains authoritative for current files.

If a future explicit long-term memory store is added, it must be project-partitioned and record at least: scope, memory kind (`user-provided`, `observed-execution`, `model-hypothesis`), source/thread/evidence ID, validity (`active`, `stale`, `invalidated`), timestamps, and deletion/invalidation controls. This is a future decision boundary, not a schema implemented here.

## M3.3 continuity regression check

The focused production-path turn/evidence and workspace-context suites passed again on 2026-10-13 (11/11 and 12/12). The source/test evidence remains limited to deterministic model doubles and SQLite-backed persisted history; no cross-thread memory, real-provider behavior, or human product acceptance is established by these tests.

## Research sources

- Mem0 upstream: https://github.com/mem0ai/mem0
- Letta upstream: https://github.com/letta-ai/letta (currently points to `letta-ai/letta-code` for active harness source)
- Letta Code upstream: https://github.com/letta-ai/letta-code

License labels and repository descriptions were checked against the upstream GitHub repositories on 2026-10-12; package-level transitive licenses were not audited because neither dependency was added.

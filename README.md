# Mediobot V2

Mediobot V2 is a clean product generation, independent from the experimental Mediobot V1 repository. The current implementation contains only the initial domain foundation for worlds, Mediobot definitions, workers, tasks, resources, evidence, artifacts, events, and explicit resource ownership.

## Product principles

- Local-first, with no mandatory paid Mediobot cloud infrastructure for local operation.
- Windows and macOS are first-class targets.
- Model providers are pluggable. User-supplied API providers may charge for inference, and local models may be supported later.
- Mediobot workers are native runtime entities owned by Mediobot.
- Parallel worker execution will eventually be observable and understandable by users.
- Mutable execution resources require explicit, inspectable ownership.
- Open-source libraries may provide infrastructure, while Mediobot owns its worker runtime, orchestration semantics, task lifecycle, resource ownership, and user experience.

The foundational identity rules are:

- `MediobotDefinition != Worker`
- `Worker != Task`
- `Model != Mediobot`

A Mediobot is not merely an AI model prompt. A model or provider is replaceable intelligence used by a Mediobot.

Mediobot V2 must not depend on Claude Code, Codex CLI, Cursor, OpenCode, or another external coding-agent runtime.

Maestro, Cody, Vision, parallel execution, computer use, and the Hub are not implemented yet.

# Mediobot V2

Mediobot V2 is a clean product generation, independent from the experimental Mediobot V1 repository. The current implementation contains a platform-neutral ownership domain, a minimal worker runtime, native local tools, and a deterministic Cody tool-boundary proof.

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

Maestro, Cody intelligence, Vision, computer use, and the Hub are not implemented yet.

## Native local tools

`@mediobot-v2/tools` maps explicitly owned workspace resources to canonical local directories. Filesystem calls reject traversal, absolute path forms, and existing symlinks along the requested path. Bindings for one world cannot point at identical or overlapping roots. Terminal commands use argument-based process spawning with shell interpretation disabled, run from an owned workspace directory, and inherit the task's cancellation signal. Tool events include the tool name alongside world, worker, task, and resource attribution.

These checks are an ownership boundary for cooperative tool calls, not an operating-system sandbox. A terminal executable runs with the Mediobot process user's privileges and can access other paths, use the network, inspect its inherited environment, or start child processes. Filesystem checks inspect path components before file operations, so an external process racing to replace a component can still create a time-of-check/time-of-use gap. Cancellation terminates the directly spawned process; descendant process trees are not guaranteed to stop on every platform. File reads are limited to 8 MiB, directory listings to 4096 entries, and each terminal output stream to 1 MiB (with truncation reported).

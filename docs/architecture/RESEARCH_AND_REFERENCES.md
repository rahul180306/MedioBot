# RESEARCH_AND_REFERENCES.md — State-of-the-Art Agent Architectures & Academic Literature

**Document Status:** Comparative Research & Reference Architecture  
**Date:** October 2026  
**Target:** MedioBot V2 Platform Architecture  
**Scope:** Coding Agents, Agent Skills, Tool Protocols, Academic Foundations, and Open-Source Ecosystem  

---

## 1. Executive Summary

This document synthesizes findings from official documentation, production coding agents (OpenAI Codex, Anthropic Claude Code), open standards (Agent Skills, Model Context Protocol), academic literature (ReAct, SWE-agent, SWE-bench), and prominent open-source implementations.

Rather than copying proprietary implementations, this research extracts proven, foundational engineering principles to inform MedioBot's local-first architecture:
1. **Agent-Computer Interfaces (ACI):** Why traditional bash interactions fail LLMs and how specialized editing and viewing tools maximize correctness.
2. **Progressive Disclosure of Context:** How tiered skill discovery prevents prompt saturation and context degradation.
3. **Deterministic Hooks vs. Probabilistic Skills:** Separating inviolable security constraints from model-invoked procedural playbooks.
4. **Adversarial Verification:** Why the implementation agent cannot be the sole evaluator of its own work.

---

## 2. Production Coding Agents Analysis

### 2.1 OpenAI Codex (Architecture & CLI)

*Sources: [OpenAI Codex](https://github.com/openai/codex), [OpenAI Developers Codex Documentation](https://developers.openai.com/codex/)*

#### Architecture Overview
- **Execution Sandbox:** Codex pairs a client interface with a hardened local or containerized sandbox. Code execution and tool calls run isolated from the host environment, preventing untracked side effects.
- **Streaming Event Protocol:** Codex uses fine-grained server-sent events for all execution feedback. Events distinguish between model reasoning tokens, command lifecycle events (`command_started`, `command_completed`), file mutation diffs, and terminal status codes.
- **Context Compaction:** Codex periodically summarizes previous tool outputs while preserving file diff evidence and recent errors, preventing context window saturation during extended refactorings.

#### Key Takeaways for MedioBot
- **Separation of Presentation and Execution:** The CLI is a pure presentation and streaming client; execution orchestration lives in a dedicated daemon/runtime core.
- **Granular Command Evidence:** Success is never assumed from model statements; stdout/stderr streams, exit codes, and diffs provide authoritative telemetry.

---

### 2.2 Anthropic Claude Code (Architecture & CLI)

*Sources: [Claude Code Overview](https://code.claude.com/docs/en/overview), [Claude Code Repository](https://github.com/anthropics/claude-code), [Steering Claude Code](https://claude.com/resources/articles/steering-claude-code-skills-hooks-rules-subagents-and-more)*

#### Architectural Layers
Claude Code organizes agentic execution into five discrete layers:
1. **Input & Permission Layer:** Handles terminal REPL input, session persistence, user trust tiers (`trusted`, `read-only`, `confirm-always`), and destructive command barriers.
2. **Knowledge & Context Layer:** Manages project instructions (`CLAUDE.md`), the skill registry, persistent cross-session memory, and context compression.
3. **Execution Layer:** Dispatches typed tools (file system, search, bash) through a Zod-validated registry with bounded timeouts and streaming lifecycle observers.
4. **Integration Layer:** Provides bidirectional tool and resource bridges via the Model Context Protocol (MCP).
5. **Multi-Agent Layer:** Manages subagents with isolated context windows to prevent pollutive tool output from degrading the main agent's reasoning.

#### Hooks vs. Skills vs. Subagents vs. Rules
Anthropic established a clear distinction among agent customization mechanisms:
- **Rules (`CLAUDE.md` / `AGENTS.md`):** Passive, global instructions loaded into every context window. Suitable for coding style and repository layout guidelines.
- **Skills (`SKILL.md`):** Reusable, model-selected procedural workflows. Loaded on demand when user goals match metadata descriptions (**progressive disclosure**).
- **Subagents:** Independent execution workers spawned with dedicated, isolated context windows and targeted toolsets (e.g., Explore/Search agent vs. Coding agent).
- **Hooks:** Deterministic, non-negotiable system interceptors (`PreToolUse`, `PostToolUse`, `SessionStart`). Hooks execute shell scripts or system validations regardless of LLM intent, providing hard security guardrails.

---

## 3. Agent Instructions, Skills & Tool Protocols

### 3.1 Agent Skills Standard (`agentskills.io` / `SKILL.md`)

*Sources: [Agent Skills Specification](https://agentskills.io/), [OpenAI Skills](https://github.com/openai/skills)*

#### Progressive Disclosure Workflow
The standard prevents context bloat by staging skill availability in three phases:
```
1. Discovery Phase (Startup)
   - Agent loads ONLY YAML frontmatter:
     * name (1–64 chars)
     * description (max 1024 chars, defines trigger conditions)
   - Cost: ~50–100 tokens per registered skill.

2. Activation Phase (Task Match)
   - When the user goal matches the description, the agent explicitly loads SKILL.md body.
   - Contains: procedural steps, input parameters, verification rules.

3. Execution Phase (On Demand)
   - Agent reads referenced scripts/ or references/ files only if required.
```

#### Directory Layout
```
my-skill/
├── SKILL.md             # Required: YAML frontmatter + procedural instructions
├── scripts/             # Optional: executable scripts (Bash, Python, Node)
├── references/          # Optional: deep API docs, schemas, checklists
└── assets/              # Optional: templates, test fixtures
```

#### Frontmatter Specification
```yaml
---
name: unit-test-generation
description: Generate unit tests for JavaScript/TypeScript modules using Vitest or Node Test Runner. Trigger when asked to add tests or verify regressions.
license: Apache-2.0
compatibility: mediobot-v2
allowed-tools:
  - filesystem.read
  - filesystem.write
  - terminal.execute
metadata:
  framework: node:test
---
```

---

### 3.2 Model Context Protocol (MCP)

*Sources: [Model Context Protocol Specification](https://modelcontextprotocol.io/specification/), [MCP GitHub](https://github.com/modelcontextprotocol/modelcontextprotocol)*

#### Architecture
- **JSON-RPC 2.0 Base:** Standardized request/response/notification protocol running over local stdio or remote SSE transports.
- **Primitive Primitives:**
  - **Resources:** Read-only data sources (file contents, database schemas, git logs).
  - **Tools:** Callable actions with side effects, validated against JSON Schema / Zod definitions.
  - **Prompts:** Reusable prompt templates with parameter substitution.
  - **Sampling:** Allows an MCP server to request LLM completions back through the host client.
- **Security & Trust Boundaries:** The MCP host (MedioBot) enforces strict boundaries:
  - Roots: Servers declare allowed root URIs; access outside roots is rejected.
  - User Approval: Tool invocations require host-managed confirmation before execution.

---

## 4. Academic Literature & Research Foundations

### 4.1 ReAct: Synergizing Reasoning and Acting in Language Models
*Yao et al., 2022 (Princeton University / Google Brain)*

- **Core Finding:** Decoupled approaches—either generating an entire plan upfront or executing actions without reasoning—suffer from high error rates. Pure reasoning leads to hallucination; pure acting lacks state tracking.
- **The ReAct Loop:** Interleaving `Thought: [reasoning about current state]`, `Action: [tool invocation]`, and `Observation: [tool output]` enables dynamic plan adjustment, error diagnosis, and task progress monitoring.
- **Relevance to MedioBot:** Cody and Tester must follow an explicit ReAct cycle where actions are justified by reasoning over prior observations, but internal thought traces must be sanitized before presentation to the user.

---

### 4.2 SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering
*Yang et al., 2024 (Princeton University)*

- **Core Finding:** Giving an LLM raw bash access produces severe failure modes:
  - Commands return thousands of lines of output, overflowing context windows.
  - Traditional text editors (`nano`, `vim`) fail completely; shell redirection (`cat << 'EOF' > file`) frequently truncates or escapes characters incorrectly.
  - LLMs lose track of cursor positions and line numbers.
- **Agent-Computer Interface (ACI) Principles:**
  1. **Windowed File Viewing:** Tools should display a bounded number of lines (e.g., 100 lines) with explicit line numbers (`1: function foo()`).
  2. **Targeted Line Replacement:** Instead of whole-file overwrites, provide an `edit_file` tool that takes `start_line`, `end_line`, and `replacement_text`, with exact string matching validation.
  3. **Dedicated Code Search:** Custom search commands (`search_file`, `find_file`) formatted concisely rather than raw `grep` or `find`.
  4. **Bounded Output Limits:** Truncate terminal outputs to prevent context pollution while reporting truncation metadata (`stdoutTruncated: true`).
- **Relevance to MedioBot:** Cody currently uses full-file replacement (`filesystem.write`). Adopting an ACI-inspired line-replacement and windowed-read tool will immediately improve reliability and token efficiency on large codebases.

---

### 4.3 SWE-bench: Can Language Models Resolve Real-World GitHub Issues?
*Jimenez et al., 2024 (Princeton University / University of Chicago)*

- **Core Finding:** Resolving real-world software engineering tasks requires:
  1. **Fail-to-Pass Verification:** A fix is only valid if it makes a previously failing reproduction test pass without breaking existing tests (pass-to-pass).
  2. **Test Isolation:** Evaluation must run in isolated environments to avoid state bleed across attempts.
  3. **Objective Patch Proof:** Relying on model self-reporting results in false positives; independent test execution is the only reliable verification signal.
- **Relevance to MedioBot:** Validates MedioBot's architectural separation between Cody (implementation) and Tester (adversarial reproduction and verification). Cody's summary cannot satisfy a Goal criterion without an independent test execution trace.

---

### 4.4 Complementary Research Literature
- **Reflexion (Shinn et al., 2023):** Verbal reinforcement learning. When a test fails, the agent generates a persistent self-reflection note stored in memory to prevent repeating the same mistake on the next iteration.
- **Toolformer (Schick et al., 2023):** Demonstrates that models perform tool use most accurately when tool calls follow simple, rigid syntax with minimal prompt overhead.
- **MetaGPT (Hong et al., 2023) & ChatDev (Qian et al., 2023):** Demonstrates that assigning distinct, specialized roles (Architect, Engineer, QA Tester) with structured handoffs significantly outperforms monolithic single-agent prompts.

---

## 5. Open-Source Ecosystem Evaluation

| Project | License | Maintenance Status | Architectural Pattern | Key Strengths | Risks / Integration Costs for MedioBot |
|---|---|---|---|---|---|
| **Aider** | Apache-2.0 | Actively Maintained | Single-agent CLI, Tree-sitter repo map, git diff pairing | Excellent repo map generation, compact unified diff editing format | Tightly coupled to terminal UI; monolithic single-agent architecture. |
| **OpenHands** | MIT | Actively Maintained | Multi-agent, event-stream runtime, Docker sandbox | Clean event-driven state machine, browser & terminal execution | Heavyweight Docker dependency; complex infrastructure overhead. |
| **Continue** | Apache-2.0 | Actively Maintained | Local IDE extension, MCP client, config-driven | Strong MCP client implementation, multi-provider abstraction | Designed primarily for inline autocomplete and chat sidebars rather than autonomous multi-agent loops. |
| **Claude Code** | Proprietary CLI | Actively Maintained | 5-layer agentic CLI, hooks, subagents, MCP | State-of-the-art UX, progressive disclosure, strict permission tiers | Closed source; patterns must be cleanly reverse-engineered and independently implemented. |

---

## 6. Fable 5.1 Clean-Room Verification

- **Inspection:** A repository-wide and workspace-wide search confirmed that **no proprietary Fable 5.1 prompt artifacts exist** in the MedioBot codebase.
- **Clean-Room Policy:** MedioBot's prompt engineering and agent persona specifications are developed strictly using first-principles clean-room design, grounded in open standards (WHATWG, W3C, MCP, Agent Skills) and published academic research (ReAct, SWE-agent, SWE-bench). No unverified proprietary instructions or leaked system prompts are utilized.

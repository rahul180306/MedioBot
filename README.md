# Mediobot V2

Mediobot V2 is an autonomous AI agent development system featuring local-first worker orchestration, multi-specialist collaboration (Maestro, Cody, Research, Doc, Tester), durable task lifecycles, and a local Command Center UI.

## Architecture Highlights

- **Local-First & Resource-Attributed**: Coordinated local worker runtime, bounded execution boundaries, and explicit workspace ownership.
- **Maestro Orchestrator**: LangGraph-based workflow authority, capability-aware specialist dispatch, live peer collaboration, and structured synthesis.
- **Specialist Roster**:
  - **Cody**: Local coding agent for bounded inspection, file editing, and terminal verification.
  - **Doc / Research**: Retrieval, doc verification, and live intelligence gathering.
  - **Tester**: Independent verification and deterministic execution validation.
- **Pluggable Model System**: Compatible with standard OpenAI/OpenAI-compatible inference endpoints (Dahl, NVIDIA NIM, MiniMax, DeepSeek, Llama, etc.).
- **Command Center**: Local React-based UI with real-time SSE task streaming, multi-specialist event projections, and interactive thread management.

---

## Quick Start (For Laptop Setup)

### 1. Prerequisites

- **Node.js**: v20 or v22+
- **pnpm**: v9.15.0 (recommended: `corepack enable` or `npm install -g pnpm@9.15.0`)
- **Python**: 3.10+ (optional, required if using Python-based crawl workers)

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Environment Configuration

Copy the example environment template and add your preferred provider credentials:

```bash
cp .env.example .env
```

Edit `.env` to configure your API keys (e.g., DAHL, NVIDIA NIM, OpenAI-compatible endpoints):
```env
DAHL_API_KEY=your_dahl_key_here
NVIDIA_API_KEY=your_nvidia_key_here
```

> **Security Note:** `.env` is git-ignored and will never be pushed or tracked. Do not commit API keys or credentials.

### 4. Verify Build & Tests

Run workspace typechecking:
```bash
pnpm typecheck
```

Run workspace unit tests:
```bash
pnpm test:unit
```

### 5. Launch the Command Center UI

Start the local development server:
```bash
pnpm dev
```

Open your browser and navigate to:
```
http://localhost:4173
```

---

## Project Structure

```
mediobot-v2/
├── apps/
│   └── command-center/       # React web UI & local backend server
├── packages/
│   ├── cody/                 # Cody coding agent implementation
│   ├── contracts/            # Core schema, event, and protocol definitions
│   ├── domain/               # Domain models, ownership, and completion policies
│   ├── intelligence/         # Code indexing, AST search, sensitive-file filtering
│   ├── maestro/              # Orchestration, autonomous turns, specialist group comms
│   ├── models/               # Resilient streaming client, backoff, retry logic
│   ├── runtime/              # Worker runtime, durable task engine, resource governor
│   ├── tester/               # Independent verification tools
│   ├── tools/                # Canonical filesystem and terminal tool providers
│   └── vision/               # Computer-vision & visual perception adapters
├── docs/                     # Architecture, orchestration, and reliability docs
└── .env.example              # Template for environment variables
```

## Useful Commands

- `pnpm dev`: Launch the Command Center frontend and local API server.
- `pnpm test:unit`: Run all unit tests across all workspace packages.
- `pnpm test:backend`: Run backend integration tests for Command Center.
- `pnpm typecheck`: Run TypeScript typechecking across all workspace packages.
- `pnpm eval:models:offline`: Run offline contract evaluations.

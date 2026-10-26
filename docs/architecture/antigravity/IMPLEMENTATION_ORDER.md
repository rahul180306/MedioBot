# Implementation order

Audit date: 2026-10-26. These guides are implementation instructions, not approval to call providers or change configured selections. This checkpoint changes documentation only.

1. **Exact specialist configuration:** follow `PER_MEDIOBOT_MODELS.md`. Close missing-selection inheritance and per-specialist effort propagation first. Accept only when controlled production requests retain each bot's exact selection through delegation, repairs and restart.
2. **Authorized real web execution:** follow `SCRAPING_INTEGRATION.md`. Establish web permission enforcement before routing adapters through one tool path. Close browser-admission, cache and cancellation gaps. Accept local fixture evidence from Scraapy/Research/Doc; review any new destination policy at the security gate.
3. **Demonstrable parallel collaboration:** follow `TRUE_PARALLELISM.md`. Preserve the existing graph; verify assignment overlap, dependency waits, provider queuing, resource cleanup and real UI attribution. Configure capacity from explicit policy, never from an assumed account entitlement.
4. **Integrated acceptance:** one disposable project and isolated SQLite database; controlled `/api/turns` delegates independent Cody and Doc/Research work, exchanges authorized findings, executes actual local tools, preserves results through cancellation/restart, and replays accurate UI activity. Record timing and evidence, then run relevant regressions/typechecks/build. Do not run tests that make live requests inadvertently.

Keep current UI, LangGraph, WorkerRuntime, Resource Governor, permissions, SQLite, durable events and model compatibility layer. No replacement frameworks, extra schedulers, always-on models or unrelated features. Preserve all existing dirty files; no commits/pushes.

**Mandatory remaining validation:** separately authorized provider execution (currently forbidden), human UI review and Windows/macOS resource/process tests. Controlled adapters prove application behavior only. Do not declare production/model acceptance from fixtures, source inspection or this documentation.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";
import { createComposition } from "../../src/composition.ts";
import { DurableTaskEngine } from "@mediobot-v2/runtime";
import type { MaestroDecision } from "@mediobot-v2/maestro";

test("manual explicit assignments use the production composition for concurrent web tools and synthesis", { timeout: 15_000 }, async t => {
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-manual-collaboration-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "brief.md"), "Recommend timeout and cancellation behavior for a Node.js HTTP client.\n");
  const db = new LocalDatabase(path.join(root, "runtime.db"));
  const repository = new ProviderRepository(db.raw);
  repository.save({ id: "manual-provider", providerType: "custom", displayName: "Manual fixture", baseUrl: "http://unused.invalid",
    connected: true, enabled: true, models: [{ id: "manual-model", name: "Manual fixture", enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: true } }] });
  let searchCount = 0;
  let releaseSearches!: () => void;
  const bothSearches = new Promise<void>(resolve => { releaseSearches = resolve; });
  const searchIntervals: Array<{ query: string; start: number; end?: number }> = [];
  const resolver = new ModelResolver(repository, { createClient: () => ({ complete: async ({ system, input }) => {
    if (system.includes("Answer one bounded request from an authorized collaborating specialist")) {
      return "Doc confirms separate response-header and socket inactivity timeout behavior.";
    }
    if (system.startsWith("Doc:")) {
      return JSON.stringify({ status: "completed", summary: "DOC_FINDING: official guidance distinguishes response-header and socket inactivity timeout behavior.",
        evidence: ["DOC_SOURCE: https://nodejs.org/api/http.html"], blockers: [], unresolved: [] });
    }
    if (system.startsWith("Research:")) {
      return JSON.stringify({ status: "completed", summary: "RESEARCH_FINDING: cancellation should abort the request and release listeners.",
        evidence: ["RESEARCH_SOURCE: https://nodejs.org/api/globals.html"], blockers: [], unresolved: [] });
    }
    if (system.includes("You are Maestro")) {
      assert.match(input, /DOC_FINDING/);
      assert.match(input, /RESEARCH_FINDING/);
      return JSON.stringify({ type: "respond", message: "Use distinct header and inactivity timeouts, propagate cancellation to the underlying request, and preserve cleanup evidence.", basis: "conversation", evidenceRefs: [] });
    }
    throw new Error("Unexpected controlled model call");
  } }) });
  const crawl4aiRuntime = {
    isRunning: true,
    async search({ query }: { query: string }) {
      const interval: { query: string; start: number; end?: number } = { query, start: Date.now() };
      searchIntervals.push(interval);
      searchCount += 1;
      if (searchCount === 2) releaseSearches();
      await bothSearches;
      await new Promise(resolve => setTimeout(resolve, 25));
      interval.end = Date.now();
      const cancellationQuery = /cancel|abort/i.test(query);
      return { items: [{ title: cancellationQuery ? "Node.js AbortSignal API" : "Node.js HTTP API", url: cancellationQuery ? "https://nodejs.org/api/globals.html" : "https://nodejs.org/api/http.html",
        snippet: cancellationQuery ? "AbortSignal cancellation behavior and request interruption." : "HTTP response timeout and request lifecycle behavior." }] };
    },
    async crawl({ url }: { url: string }) {
      return { success: true, finalUrl: url, title: "Node.js API", markdown: "Request timeout and cancellation guidance.", sanitized: true, promptInjectionFlags: [] };
    },
    async shutdown() {},
  };
  const engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.raw));
  const composition = createComposition({ modelResolver: resolver, durableTaskEngine: engine, crawl4aiRuntime: crawl4aiRuntime as never });
  t.after(async () => { await composition.shutdown?.(); db.close(); await rm(root, { recursive: true, force: true }); });

  const definitions = composition.world.inspect().definitions;
  const doc = definitions.find(definition => definition.role === "doc")!;
  const research = definitions.find(definition => definition.role === "research")!;
  const decision: MaestroDecision = { type: "delegate_text", independence: "Doc and Research search independently and their reports are reconciled by Maestro.",
    assignments: [
      { definitionId: doc.id, objective: "Check official Node.js HTTP timeout documentation", relevantContext: "Investigate timeout boundaries.", relevantContextRefs: [],
        constraints: ["Use web search and crawl."], expectedOutcome: "Produce an official documentation report.", evidenceExpectations: ["Source URL"], requiredCapabilities: ["web.search", "web.crawl"] },
      { definitionId: research.id, objective: "Independently check cancellation guidance", relevantContext: "Investigate request cancellation risks.", relevantContextRefs: [],
        constraints: ["Use web search and crawl."], expectedOutcome: "Produce an independent cancellation report.", evidenceExpectations: ["Source URL"], requiredCapabilities: ["web.search", "web.crawl"] },
    ] };
  const parent = composition.submit(composition.maestroDefinitionId, "Recommend a safe Node.js HTTP timeout and cancellation policy.", {
    threadId: "manual-test-thread", turnId: "manual-test-turn", workspaceId: "manual-test-workspace", workspaceRoot: projectRoot,
    workspaceExecutionAuthorized: true, modelSelection: { providerConnectionId: "manual-provider", modelId: "manual-model" }, maestroDecision: decision,
  });
  const result = await parent.result;
  assert.deepEqual(result, { state: "completed" });
  const events = composition.taskEvents.get(parent.taskId)!;
  const tools = events.filter(event => event.type === "tool.completed");
  assert.equal(tools.filter(event => event.toolName === "web.search" && event.workerDefinitionId === doc.id).length, 1);
  assert.equal(tools.filter(event => event.toolName === "web.search" && event.workerDefinitionId === research.id).length, 1);
  assert.equal(tools.filter(event => event.toolName === "web.crawl" && [doc.id, research.id].includes(event.workerDefinitionId!)).length, 2, JSON.stringify(tools.map(event => ({ tool: event.toolName, worker: event.workerDefinitionId, error: event.message }))));
  assert.equal(searchIntervals.length, 2);
  assert.ok(Math.min(...searchIntervals.map(interval => interval.end!)) > Math.max(...searchIntervals.map(interval => interval.start)), "Doc and Research search intervals overlap");

  const childTargets = composition.world.inspect().tasks.filter(task => task.parentTaskId === parent.taskId)
    .map(task => composition.world.inspect().workers.find(worker => worker.id === task.assignedWorkerId)?.definitionId);
  assert.deepEqual(new Set(childTargets), new Set([doc.id, research.id]));
  const delegations = await engine.getDelegations(parent.taskId);
  assert.deepEqual(new Set(delegations.map(delegation => delegation.assignedMediobotId)), new Set([doc.id, research.id]));
  for (const delegation of delegations) {
    assert.ok(delegation.childTaskId);
    assert.deepEqual(await engine.getTaskModelSelection(delegation.childTaskId!),
      { providerConnectionId: "manual-provider", modelId: "manual-model" },
      `${delegation.assignedMediobotName} must retain the exact model selection on its durable child task`);
  }
  const final = events.find(event => event.type === "maestro.responded");
  assert.match(final?.message ?? "", /distinct header and inactivity timeouts/i);
  t.diagnostic(JSON.stringify({ controlled: true, parentTaskId: parent.taskId, selected: ["Doc", "Research"],
    concurrentSearches: searchIntervals.length, webToolCalls: tools.length, durableAssignments: delegations.length,
    synthesized: Boolean(final?.message) }));
});

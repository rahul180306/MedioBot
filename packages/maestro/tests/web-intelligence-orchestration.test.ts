import assert from "node:assert/strict";
import test from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import type { TaskId, WorkerId } from "@mediobot-v2/domain";
import { WorkerRuntime, ResourceGovernor, SubprocessSupervisor } from "@mediobot-v2/runtime";
import { ToolRuntime } from "@mediobot-v2/tools";
import {
  createMaestroCodyExecution,
  buildSearchQuery,
  filterRelevantSearchItems,
  searchCandidateRejectionReason,
  MaestroDecisionProvider,
  parseWebReport,
  WebAgentExecution,
} from "../src/index.ts";
import type { CrawlRequest, CrawlResult, WebSearchRequest, WebSearchResult } from "@mediobot-v2/contracts";

test("search queries use the shared task subject and discard unrelated candidates", () => {
  const query = buildSearchQuery("Use official documentation sources and send findings to Cody. Shared objective: Check whether Node.js fetch supports AbortSignal.timeout and cite the official documentation.");
  assert.match(query, /^Check whether Node\.js fetch supports AbortSignal\.timeout/);
  const items = filterRelevantSearchItems(query, [
    { title: "Node.js Globals: AbortSignal.timeout", url: "https://nodejs.org/api/globals.html", snippet: "AbortSignal.timeout(delay) creates a signal that aborts after delay milliseconds.", source: "nodejs.org" },
    { title: "React & GSAP | Docs", url: "https://gsap.com/resources/React/", snippet: "GSAP animation guidance for React projects.", source: "gsap.com" },
  ]);
  assert.deepEqual(items.map(item => item.url), ["https://nodejs.org/api/globals.html"]);
  assert.equal(searchCandidateRejectionReason(query, {
    title: "Timers | Node.js Documentation", url: "https://nodejs.org/api/timers.html",
    snippet: "Timer functions and the Node.js event loop.", source: "nodejs.org",
  }), "no topical overlap with query terms: fetch, abortsignal, timeout");
  assert.equal(searchCandidateRejectionReason(query, {
    title: "GSAP Documentation", url: "https://gsap.com/resources/React/",
    snippet: `Web search match for '${query}' from gsap.com`, source: "gsap.com",
  }), "provider returned no source snippet; query echo is not relevance evidence");
  assert.deepEqual(filterRelevantSearchItems("Use official documentation", [
    { title: "React animation guide", url: "https://react.dev/", snippet: "Animation docs", source: "react.dev" },
  ]), []);
});

test("web report model cannot promote an empty relevant source set into completed evidence", () => {
  const report = parseWebReport(JSON.stringify({ status: "completed", summary: "Verified from docs", evidence: ["https://nodejs.org/api/globals.html"] }), {
    status: "blocked", summary: "No relevant web sources were available.", evidence: [],
    blockers: ["No relevant search results or crawled content were available."], unresolved: ["Node.js API details"],
  });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.evidence, []);
  assert.match(report.blockers[0]!, /No relevant search results/);
});

test("Maestro + WebAgentExecution: coordinates Scraapy and Doc specialists and synthesizes findings", async () => {
  const world = createWorld();
  const supervisor = new SubprocessSupervisor({ maxConcurrentGlobal: 5 });
  const governor = new ResourceGovernor({
    budget: { maxConcurrentTasks: 4, maxConcurrentBrowserSessions: 2 },
    subprocessSupervisor: supervisor,
  });
  const runtime = new WorkerRuntime(world, { resourceGovernor: governor });
  const tools = new ToolRuntime(world, { subprocessSupervisor: supervisor });

  // Mock WebIntelligenceRuntime
  let crawlCallCount = 0;
  let searchCallCount = 0;

  const mockCrawl4Ai = {
    isRunning: true,
    async search(req: WebSearchRequest): Promise<WebSearchResult> {
      searchCallCount++;
      if (req.filterType === "components") {
        return {
          query: req.query,
          totalMatches: 1,
          items: [
            {
              title: "React Bits: GSAP Animated Card",
              url: "https://reactbits.dev/components/gsap-card",
              snippet: "High-performance animated card with GSAP timeline. MIT license.",
              source: "reactbits",
            },
          ],
        };
      }
      return {
        query: req.query,
        totalMatches: 1,
        items: [
          {
            title: "GSAP React Documentation",
            url: "https://gsap.com/resources/React",
            snippet: "Official useGSAP hook documentation and best practices.",
            source: "gsap.com",
          },
        ],
      };
    },
    async crawl(req: CrawlRequest): Promise<CrawlResult> {
      crawlCallCount++;
      const isCard = req.url.includes("gsap-card");
      return {
        url: req.url,
        finalUrl: req.url,
        title: isCard ? "GSAP Animated Card" : "useGSAP Documentation",
        markdown: isCard
          ? "# GSAP Animated Card\n\nLicense: MIT\n\n```jsx\nimport { useGSAP } from '@gsap/react';\n```"
          : "# useGSAP Hook\n\nOfficial GSAP React hook for safe animation context cleanup.\n\nVersion: 2.1.1",
        sanitized: false,
        promptInjectionFlags: [],
        provenance: {
          url: req.url,
          timestamp: Date.now(),
          contentHash: "hash-123",
          byteSize: 100,
        },
        cached: false,
        durationMs: 45,
        success: true,
      };
    },
  };

  // Mock Model client for text-inference & decision
  const mockTextClient = {
    async complete(): Promise<string> {
      throw new Error("Web specialists must use the shared model-contract compatibility API");
    },
    async completeCompatible(req: { system: string; input: string; outputContract: { name: string } }): Promise<{
      kind: "structured"; value: unknown; protocol: "json-schema";
    }> {
      // Check if this is a web worker report request
      if (req.system.includes("Scraapy")) {
        assert.equal(req.outputContract.name, "mediobot_worker_report");
        return { kind: "structured", protocol: "json-schema", value: {
          status: "completed",
          summary: "Discovered React Bits GSAP Animated Card (MIT licensed). Clean component using @gsap/react with no heavy extra dependencies.",
          evidence: ["React Bits component uses MIT license", "Compatible with React 18/19 via useGSAP hook"],
          blockers: [],
          unresolved: [],
        } };
      }
      if (req.system.includes("Doc")) {
        assert.equal(req.outputContract.name, "mediobot_worker_report");
        return { kind: "structured", protocol: "json-schema", value: {
          status: "completed",
          summary: "GSAP requires '@gsap/react' and 'gsap' packages. The useGSAP() hook must be used to ensure animations are reverted on unmount.",
          evidence: ["@gsap/react version 2.1.1 is recommended", "Always pass dependencies or scope ref to useGSAP"],
          blockers: [],
          unresolved: [],
        } };
      }
      // Maestro final synthesis response
      return { kind: "structured", protocol: "json-schema", value: {
        type: "respond",
        message: "To build a modern React website using GSAP:\n1. Architecture: Install `gsap` and `@gsap/react`.\n2. Documentation (Doc): Use the `useGSAP()` hook for lifecycle management and automatic cleanup.\n3. Components (Scraapy): React Bits GSAP Card (MIT licensed) provides an inspectable component template ready for Cody to implement.",
        basis: "conversation",
        evidenceRefs: [],
      } };
    },
  };

  const textModelResolver = {
    resolveForOperation() {
      return {
        client: mockTextClient,
        descriptor: { providerId: "mock-provider", modelId: "mock-model" },
      };
    },
  };

  let maestroTurnCount = 0;
  const mockMaestroDecisions = {
    async decide(): Promise<any> {
      maestroTurnCount++;
      if (maestroTurnCount === 1) {
        // Maestro delegates to both Scraapy and Doc
        return {
          type: "delegate_text",
          independence: "Scraapy finds components while Doc reads official API documentation.",
          assignments: [
            {
              definitionId: execution.scraapyDefinitionId,
              objective: "Discover open-source GSAP animated card components on React Bits",
              relevantContext: "User wants modern animated React components using GSAP.",
              relevantContextRefs: [],
              constraints: ["Must have MIT or permissive license"],
              expectedOutcome: "Actionable component code reference and dependencies",
              evidenceExpectations: ["Component license", "Code snippet"],
              requiredCapabilities: ["web.search", "web.crawl"],
            },
            {
              definitionId: execution.docDefinitionId,
              objective: "Retrieve official GSAP React documentation for useGSAP hook",
              relevantContext: "User needs accurate API integration pattern for GSAP in React.",
              relevantContextRefs: [],
              constraints: ["Cite official documentation"],
              expectedOutcome: "Authoritative useGSAP API pattern",
              evidenceExpectations: ["Package versions", "Cleanup pattern"],
              requiredCapabilities: ["web.search", "web.crawl"],
            },
          ],
        };
      }
      // Turn 2: Synthesis response
      return {
        type: "respond",
        message: "Synthesized recommendation for Cody: use @gsap/react with React Bits card component.",
        basis: "conversation",
        evidenceRefs: [],
      };
    },
  };

  const maestroDefinition = {
    id: "maestro",
    name: "Maestro",
    role: "orchestration",
    version: "1.0.0",
    instructions: "Maestro: coordinate specialists.",
  };

  const execution = createMaestroCodyExecution({
    world,
    runtime,
    tools,
    maestroDefinition,
    maestroDecisions: mockMaestroDecisions as any,
    codyDecisions: new MaestroDecisionProvider(mockTextClient as any) as any,
    textModelResolver,
    crawl4ai: mockCrawl4Ai as any,
  });

  assert.ok(execution.scraapyDefinitionId, "Scraapy definition ID must exist");
  assert.ok(execution.docDefinitionId, "Doc definition ID must exist");
  assert.ok(execution.webExecution, "WebAgentExecution must be initialized");

  // Prepare and run Maestro task
  const maestroWorker = world.spawnWorker(execution.maestroDefinitionId);
  const maestroTask = world.createTask("Build a React website using GSAP with modern animated components.");
  world.assignTask(maestroTask.id, maestroWorker.id);

  let respondedMessage = "";
  const plan = execution.adapter.prepare({
    world,
    definitionId: execution.maestroDefinitionId,
    workerId: maestroWorker.id,
    taskId: maestroTask.id,
    goal: "Build a React website using GSAP with modern animated components.",
    options: {
      workspaceRoot: "/tmp/fake-workspace",
    },
  });

  const runResult = await runtime.run({
    taskId: maestroTask.id,
    workerId: maestroWorker.id,
    resourceIds: [],
    execute: plan.execute,
  });

  if (runResult.state === "failed") {
    throw new Error("RUN FAILED: " + runResult.error);
  }
  assert.equal(runResult.state, "completed");
  assert.equal(searchCallCount, 2, "Both Scraapy and Doc should have searched the web");
  assert.equal(crawlCallCount, 2, "Both Scraapy and Doc should have crawled top URLs");

  // Check recorded evidence in world
  const evidences = world.inspect().evidence;
  const webEvidence = evidences.filter((e) => e.source.type === "worker-report");
  assert.equal(webEvidence.length, 2, "Both Scraapy and Doc should have recorded worker reports");

  // Check that the reports contain the extracted conclusions
  const reports = webEvidence.map(e => JSON.parse(e.content));
  const scraapyReport = reports.find(r => r.summary?.includes("React Bits GSAP Animated Card")) ?? reports[0];
  const docReport = reports.find(r => r.summary?.includes("useGSAP")) ?? reports[1];
  assert.equal(scraapyReport.status, "completed");
  assert.ok(scraapyReport.summary.includes("React Bits GSAP Animated Card"));
  assert.equal(docReport.status, "completed");
  assert.ok(docReport.summary.includes("useGSAP"));
});

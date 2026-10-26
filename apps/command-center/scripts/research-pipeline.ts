import { createWorld } from "@mediobot-v2/domain";
import type { TaskId } from "@mediobot-v2/domain";
import { Crawl4AiRuntime, ResourceGovernor, WorkerRuntime } from "@mediobot-v2/runtime";
import { MaestroDecisionProvider, createMaestroCodyExecution } from "@mediobot-v2/maestro";
import { ToolRuntime } from "@mediobot-v2/tools";
import { buildSearchQuery, filterRelevantSearchItems, searchCandidateRejectionReason } from "@mediobot-v2/maestro";
import type { WebSearchResultItem } from "@mediobot-v2/contracts";

const taskId = (value: string) => value as TaskId;
const write = (record: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(record)}\n`);
const objective = "Verify whether Node.js AbortSignal.timeout() is supported and what it returns, using official documentation.";
const query = buildSearchQuery(`Search the official documentation. Shared objective: ${objective}`);
const adapterSearchObjective = "site:nodejs.org/api AbortSignal.timeout Node.js official API documentation";
const knownIntroductionUrl = "https://nodejs.org/learn/getting-started/introduction-to-nodejs";

function deterministicReport(input: string): string {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(input) as Record<string, unknown>; } catch { /* non-report call */ }
  const content = typeof payload.webContent === "string" ? payload.webContent : "";
  const pages = [...content.matchAll(/### ([^\n]+)\nURL: ([^\n]+)\n\n([\s\S]*?)(?=\n### |$)/g)];
  const evidence = pages.slice(0, 3).map(match => {
    const pageText = match[3]!;
    const focusMatches = [...pageText.matchAll(/AbortSignal\.timeout/ig)];
    const specificMatch = focusMatches.find(item => /returns a new/i.test(pageText.slice(item.index!, item.index! + 700)));
    const focusIndex = specificMatch?.index ?? focusMatches[0]?.index ?? -1;
    if (focusIndex < 0) return "";
    const excerpt = pageText.slice(Math.max(0, focusIndex - 100), focusIndex + 260).replace(/\s+/g, " ").trim();
    return `Retrieved source ${match[2]} (${match[1]}): ${excerpt}`;
  }).filter(item => item.length > 80);
  return JSON.stringify({ status: evidence.length ? "completed" : "blocked",
    summary: evidence.length ? `Retrieved ${evidence.length} source page(s) for the assigned objective.` : "No relevant source page was retrieved.",
    evidence, blockers: evidence.length ? [] : ["No relevant source page was retrieved."], unresolved: [] });
}

async function main(): Promise<void> {
  const governor = new ResourceGovernor();
  const crawler = new Crawl4AiRuntime({ resourceGovernor: governor, defaultTimeoutMs: 20_000 });
  const liveSearch = crawler.search.bind(crawler);
  crawler.search = async (request, signal) => {
    const result = await liveSearch(request, signal);
    write({ scenario: "adapter-search-call", query: request.query, filterType: request.filterType,
      providerStatus: result.providerStatus ?? "unknown", totalMatches: result.totalMatches,
      results: result.items.slice(0, 5).map(item => ({ title: item.title, url: item.url, snippet: item.snippet.slice(0, 240) })) });
    return result;
  };
  const liveCrawl = crawler.crawl.bind(crawler);
  crawler.crawl = async (request, signal) => {
    const result = await liveCrawl(request, signal);
    write({ scenario: "adapter-crawl-call", url: request.url, success: result.success, status: result.status,
      title: result.title, markdownChars: result.markdown.length });
    return result;
  };
  const world = createWorld();
  const runtime = new WorkerRuntime(world, { resourceGovernor: governor, maxConcurrentExecutions: 6 });
  const tools = new ToolRuntime(world, { webIntelligence: crawler });
  const reportClient = { complete: async ({ input }: { input: string }) => deterministicReport(input) };
  const resolver = { resolveForOperation: () => ({ descriptor: { providerId: "controlled-report-extractor", modelId: "deterministic" }, client: reportClient }) };
  const maestroDecisions = new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: "respond",
    message: "Research pipeline adapter run completed; see attributed specialist reports for retrieved sources and evidence.",
    basis: "conversation", evidenceRefs: [] }) });
  const execution = createMaestroCodyExecution({ world, runtime, tools,
    maestroDefinition: { id: "maestro", name: "Maestro", role: "orchestration", version: "1", instructions: "Run explicit research test assignments." },
    maestroDecisions, codyDecisions: maestroDecisions as never, textModelResolver: resolver as never, crawl4ai: crawler });

  try {
    write({ scenario: "A-search-discovery", query, source: "existing Crawl4AI runtime search adapter", allowedDomains: ["nodejs.org"] });
    const found = await crawler.search({ query, maxResults: 10, filterType: "documentation", allowedDomains: ["nodejs.org"] });
    const selected = filterRelevantSearchItems(query, found.items);
    write({ scenario: "A-search-results", providerStatus: found.providerStatus ?? "unknown", totalMatches: found.totalMatches, results: found.items.map(item => ({ title: item.title, url: item.url, snippet: item.snippet })),
      rejections: found.items.filter(item => searchCandidateRejectionReason(query, item)).map(item => ({ url: item.url, reason: searchCandidateRejectionReason(query, item) })),
      selectedUrls: selected.map(item => item.url), passed: selected.some(item => new URL(item.url).hostname.endsWith("nodejs.org")) });

    write({ scenario: "B-known-url-crawl", url: knownIntroductionUrl });
    const known = await crawler.crawl({ url: knownIntroductionUrl, taskId: taskId("research-pipeline-known-source"),
      preferHttp: true, renderJs: false, cacheMode: "bypass", timeoutMs: 20_000 });
    const knownExcerpt = known.markdown.match(/Node\.js is an open-source[\s\S]{0,220}/i)?.[0].replace(/\s+/g, " ")
      ?? known.markdown.slice(0, 260).replace(/\s+/g, " ");
    write({ scenario: "B-known-url-result", success: known.success, status: known.status, finalUrl: known.finalUrl,
      title: known.title, extractionBackend: known.metadata.extractionBackend, markdownChars: known.markdown.length,
      contentHash: known.provenance.contentHash, evidenceExcerpt: knownExcerpt, passed: known.success && known.markdown.length > 500 && known.provenance.contentHash.length > 0 });

    const unrelated: WebSearchResultItem[] = [
      { title: "React and GSAP animation guide", url: "https://gsap.com/resources/React/", snippet: "React animation integration and hooks.", source: "gsap.com" },
      { title: "React documentation", url: "https://react.dev/learn", snippet: "Learn React components and state.", source: "react.dev" },
    ];
    write({ scenario: "C-unrelated-rejection", query, candidates: unrelated.map(item => ({ ...item,
      rejectionReason: searchCandidateRejectionReason(query, item) })),
      selectedUrls: filterRelevantSearchItems(query, unrelated).map(item => item.url),
      passed: filterRelevantSearchItems(query, unrelated).length === 0 });

    const runAssignments = async (names: ReadonlyArray<"Doc" | "Research">, label: string) => {
      const snapshotBefore = world.inspect();
      const parentWorker = world.spawnWorker(execution.maestroDefinitionId);
      const parentTask = world.assignTask(world.createTask(`Manual ${label}: ${objective}`).id, parentWorker.id);
      const definitions = new Map(snapshotBefore.definitions.map(definition => [definition.name, definition.id]));
      const assignments = names.map(name => ({ definitionId: definitions.get(name)!, objective: `${name} assignment. Shared objective: ${adapterSearchObjective}`,
        relevantContext: "Use retrieved source text only; cite the source URL and quote a short relevant excerpt.", relevantContextRefs: [],
        constraints: ["Do not state a fact that is absent from retrieved source content."], expectedOutcome: "A concise source-backed report.",
        evidenceExpectations: ["Official Node.js documentation URL", "Retrieved content excerpt"], requiredCapabilities: ["web.search", "web.crawl"] }));
      const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: parentWorker.id, taskId: parentTask.id,
        goal: objective, options: { workspaceRoot: process.cwd(), maestroDecision: { type: "delegate_text", independence: "Each web specialist runs independently against the same objective.", assignments } } });
      const result = await runtime.run({ ...plan, workerId: parentWorker.id, taskId: parentTask.id });
      const snapshot = world.inspect();
      const childAssignments = snapshot.assignments.filter(assignment => names.some(name => assignment.targetDefinitionId === definitions.get(name))
        && !snapshotBefore.assignments.some(previous => previous.id === assignment.id));
      const intervals = childAssignments.map(assignment => {
        const childTask = snapshot.tasks.find(item => item.parentTaskId === parentTask.id && item.goal === assignment.objective);
        const events = snapshot.events.filter(event => event.taskId === childTask?.id);
        return { specialist: names.find(name => definitions.get(name) === assignment.targetDefinitionId), taskId: childTask?.id,
          workerId: childTask?.assignedWorkerId ?? undefined, startedAt: events.find(event => event.type === "task.started")?.occurredAt,
          finishedAt: events.find(event => ["task.completed", "task.failed", "task.cancelled"].includes(event.type))?.occurredAt };
      });
      const reports = snapshot.evidence.filter(item => item.source.type === "worker-report" && childAssignments.some(assignment => assignment.id === item.source.reference))
        .map(item => { try { return JSON.parse(item.content) as Record<string, unknown>; } catch { return { raw: item.content }; } });
      const overlapMs = intervals.length >= 2 && intervals.every(item => item.startedAt && item.finishedAt)
        ? Math.max(0, Math.min(...intervals.map(item => item.finishedAt!)) - Math.max(...intervals.map(item => item.startedAt!))) : 0;
      write({ scenario: label, taskId: parentTask.id, state: result.state, assignments: intervals,
        reports: reports.map(report => ({ specialist: names.find(name => definitions.get(name) === report.mediobotId), status: report.status,
          summary: report.summary, evidence: report.evidence, blockers: report.blockers, provider: report.providerId, model: report.modelId })),
        overlapMs, modelMode: "deterministic report extractor; retrieval/search/crawl are live", passed: result.state === "completed"
        && reports.length === names.length && reports.every(report => report.status === "completed" && Array.isArray(report.evidence)
          && report.evidence.some((item: unknown) => typeof item === "string" && item.includes("nodejs.org")))
          && (names.length < 2 || overlapMs > 0) });
      return { result, reports, overlapMs };
    };

    await runAssignments(["Doc"], "D-doc-adapter");
    await runAssignments(["Research"], "E-research-adapter");
    await runAssignments(["Doc", "Research"], "F-doc-research-concurrent");
  } finally {
    await crawler.shutdown();
    await governor.shutdown();
  }
}

main().catch(error => {
  write({ scenario: "fatal", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

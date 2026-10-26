import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorld } from '@mediobot-v2/domain';
import { ResourceGovernor, WorkerRuntime } from '@mediobot-v2/runtime';
import { ToolRuntime } from '@mediobot-v2/tools';
import { TesterDecisionProvider } from '@mediobot-v2/tester';
import { CodyDecisionProvider } from '@mediobot-v2/cody';
import { DurableTaskEngine } from '@mediobot-v2/runtime';
import { LocalDatabase } from '../../../apps/command-center/src/storage/db.ts';
import { SqliteDurableTaskStore } from '../../../apps/command-center/src/storage/durableTaskStore.ts';
import { createMaestroCodyExecution, hasOnlyBlockedWebReportsWithoutEvidence, MaestroDecisionProvider, validateMaestroDecision,
  WEB_EVIDENCE_UNAVAILABLE_MARKER } from '../src/index.ts';
import type { CrawlRequest, CrawlResult, WebSearchRequest, WebSearchResult } from '@mediobot-v2/contracts';

const report = (summary: string) => JSON.stringify({ status: 'completed', summary, evidence: [summary], blockers: [], unresolved: [] });

test('legacy bootstrap aliases remain available for recovery but are omitted from Maestro discovery', async () => {
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  let decisionContext: { availableMediobots?: Array<{ definitionId: string; name: string }> } | undefined;
  const decisions = new MaestroDecisionProvider({ complete: async ({ input }) => {
    decisionContext = JSON.parse(input) as typeof decisionContext;
    return JSON.stringify({ type: 'respond', message: 'The existing project scope is understood.', basis: 'conversation', evidenceRefs: [] });
  } });
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate.' },
    maestroDecisions: decisions,
    codyDecisions: new CodyDecisionProvider({ complete: async () => { throw new Error('unused'); } }) as never,
  });
  world.registerMediobotDefinition({ id: 'vision' as never, name: 'Vision', role: 'visual-browser', version: '1',
    instructions: 'Use observed browser state.', declaredCapabilities: [] });
  world.registerMediobotDefinition({ id: 'legacy-maestro-generated' as never, name: 'Maestro', role: 'orchestration', version: '1',
    instructions: 'Legacy identity for durable task recovery.', declaredCapabilities: [] });
  world.registerMediobotDefinition({ id: 'legacy-vision-generated' as never, name: 'Vision', role: 'visual-browser', version: '1',
    instructions: 'Legacy identity for durable task recovery.', declaredCapabilities: [] });

  await execution.adapter.decideTurn(world, execution.maestroDefinitionId, 'Clarify the active project scope.',
    { workspaceRoot: '/tmp/mediobot-project' }, new AbortController().signal);
  const roster = decisionContext?.availableMediobots ?? [];
  assert.equal(roster.filter(member => member.name === 'Maestro').length, 1);
  assert.equal(roster.filter(member => member.name === 'Vision').length, 1);
  assert.ok(world.inspect().definitions.some(definition => definition.id === 'legacy-maestro-generated'),
    'the runtime retains old identities to resolve durable task ownership');
  assert.ok(world.inspect().definitions.some(definition => definition.id === 'legacy-vision-generated'));
});

test('factual synthesis is withheld when every web report is blocked with no evidence', () => {
  const groups = [{ kind: 'web', result: `bounded-web-worker-reports: ${JSON.stringify([
    { status: 'blocked', summary: 'No results', evidence: [] }, { status: 'blocked', summary: 'No crawl', evidence: [] },
  ])}` }];
  assert.equal(hasOnlyBlockedWebReportsWithoutEvidence(groups), true);
  assert.equal(hasOnlyBlockedWebReportsWithoutEvidence([{ kind: 'web', result: `${WEB_EVIDENCE_UNAVAILABLE_MARKER}\n# Research Findings` }]), true);
  assert.equal(hasOnlyBlockedWebReportsWithoutEvidence([{ kind: 'web', result: `bounded-web-worker-reports: ${JSON.stringify([
    { status: 'completed', summary: 'Found source', evidence: ['https://nodejs.org/api/globals.html'] },
  ])}` }]), false);
});

test('model-produced delegation can explicitly request executor capabilities', async () => {
  const docId = 'doc-specialist';
  const provider = new MaestroDecisionProvider({ complete: async ({ system }) => {
    assert.match(system, /requiredCapabilities/);
    assert.match(system, /Tester can execute approved terminal commands but cannot create or edit workspace files/);
    return JSON.stringify({ type: 'delegate_text', independence: 'Documentation lookup is independent.', assignments: [
      { definitionId: docId, objective: 'Search and crawl official API docs', relevantContext: 'Use official sources.',
        relevantContextRefs: [], constraints: [], expectedOutcome: 'Documented behavior', evidenceExpectations: ['Crawled page'],
        requiredCapabilities: ['web.search', 'web.crawl'] },
    ] });
  } });
  const decision = await provider.decide('Research official API documentation', {
    availableIntents: ['delegate_text'], assignableDefinitionIds: [docId],
    availableMediobots: [{ definitionId: docId, name: 'Doc', capabilities: ['text-inference', 'web.search', 'web.crawl'] }],
  }, new AbortController().signal);
  assert.equal(decision.type, 'delegate_text');
  if (decision.type !== 'delegate_text') throw new Error('Expected a text delegation decision');
  assert.deepEqual(decision.assignments[0]?.requiredCapabilities, ['web.search', 'web.crawl']);
});

test('Maestro advertises Testers real read/list/terminal capabilities without granting write', { timeout: 8000 }, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'mediobot-tester-capabilities-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  let capturedCapabilities: string[] = [];
  const maestro = new MaestroDecisionProvider({ complete: async ({ input }) => {
    const payload = JSON.parse(input) as { availableMediobots?: Array<{ name: string; assignable?: boolean; capabilities?: string[] }> };
    const tester = payload.availableMediobots?.find(entry => entry.name === 'Tester');
    assert.ok(tester?.assignable);
    capturedCapabilities = tester.capabilities ?? [];
    return JSON.stringify({ type: 'respond', message: 'Capability map inspected.', basis: 'conversation', evidenceRefs: [] });
  } });
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate.' },
    maestroDecisions: maestro, codyDecisions: new MaestroDecisionProvider({ complete: async () => '' }) as never,
    testerDecisions: new TesterDecisionProvider({ complete: async () => JSON.stringify({ type: 'finish', report: { status: 'unverified', summary: 'unused', observations: [] } }) }),
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: 'fixture', modelId: 'fixture' }, client: { complete: async () => report('unused') } }; } },
  });
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const task = world.assignTask(world.createTask('Explain this ordinary testing concept').id, worker.id);
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: task.id,
    goal: 'Explain this ordinary testing concept', options: { workspaceRoot } });
  assert.equal((await runtime.run({ ...plan, workerId: worker.id, taskId: task.id })).state, 'completed');
  assert.ok(capturedCapabilities.includes('filesystem.list'));
  assert.ok(capturedCapabilities.includes('filesystem.read'));
  assert.ok(capturedCapabilities.includes('terminal.execute'));
  assert.ok(capturedCapabilities.includes('text-inference'));
  assert.equal(capturedCapabilities.includes('filesystem.write'), false, 'Tester remains read-only');
});

test('unavailable capability report names only the capability missing from the closest executor', { timeout: 8000 }, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'mediobot-tester-missing-capability-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  const maestro = new MaestroDecisionProvider({ complete: async ({ input }) => {
    const payload = JSON.parse(input) as { projectIntelligence?: Array<{ name: string; value: string }> };
    const execution = payload.projectIntelligence?.find(item => item.name === 'specialist-executor-results');
    return JSON.stringify({ type: 'respond', message: execution?.value ?? 'No assignment was executed.', basis: 'conversation', evidenceRefs: [] });
  } });
  let testerCalls = 0;
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate.' },
    maestroDecisions: maestro, codyDecisions: new MaestroDecisionProvider({ complete: async () => '' }) as never,
    testerDecisions: new TesterDecisionProvider({ complete: async () => { testerCalls++; throw new Error('unsupported write must be rejected before execution'); } }),
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: 'fixture', modelId: 'fixture' }, client: { complete: async () => report('unused') } }; } },
  });
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const taskGoal = 'Ask Tester to inspect and verify a code change';
  const goal = world.assignTask(world.createTask(taskGoal).id, worker.id);
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: goal.id,
    goal: taskGoal, options: { workspaceRoot, maestroDecision: { type: 'delegate_text', independence: 'One bounded tester assignment.', assignments: [
      { definitionId: execution.testerDefinitionId, objective: 'Inspect, edit, and run the verification command', relevantContext: 'Do not bypass tool permissions.',
        relevantContextRefs: [], constraints: [], expectedOutcome: 'Verified result', evidenceExpectations: ['Read, write, and terminal execution'],
        requiredCapabilities: ['filesystem.read', 'terminal.execute', 'filesystem.write'] },
    ] } } });
  const result = await runtime.run({ ...plan, workerId: worker.id, taskId: goal.id });
  assert.equal(result.state, 'completed');
  assert.equal(testerCalls, 0, 'an unsupported write request is rejected before Tester starts');
  const final = world.inspect().evidence.find(entry => entry.source.type === 'maestro-response')?.content ?? '';
  assert.match(final, /missing: filesystem\.write/);
  assert.doesNotMatch(final, /missing: filesystem\.read, terminal\.execute/);
});

test('model-produced assignment dependencies are bounded, validated, and returned for LangGraph scheduling', async () => {
  const codyId = 'cody-specialist';
  const docId = 'doc-specialist';
  const provider = new MaestroDecisionProvider({ complete: async () => JSON.stringify({
    type: 'delegate_text', independence: 'Doc researches first; Cody uses the finding, while this bounded plan has a single prerequisite.',
    assignments: [
      { assignmentId: 'docs', definitionId: docId, objective: 'Retrieve the official option documentation', relevantContext: 'Find the source.',
        relevantContextRefs: [], constraints: [], expectedOutcome: 'An attributed official source', evidenceExpectations: ['Source URL'],
        requiredCapabilities: ['web.search', 'web.crawl'] },
      { assignmentId: 'code', dependsOn: ['docs'], definitionId: codyId, objective: 'Use the documented option in the project', relevantContext: 'Apply the requirement safely.',
        relevantContextRefs: [], constraints: [], expectedOutcome: 'An implementation based on the source', evidenceExpectations: ['Change evidence'],
        requiredCapabilities: ['filesystem.read'] },
    ],
  }) });
  const decision = await provider.decide('Retrieve docs and implement the documented setting', {
    availableIntents: ['delegate_text'], assignableDefinitionIds: [codyId, docId],
    availableMediobots: [
      { definitionId: codyId, name: 'Cody', capabilities: ['text-inference', 'filesystem.read'] },
      { definitionId: docId, name: 'Doc', capabilities: ['text-inference', 'web.search', 'web.crawl'] },
    ],
  }, new AbortController().signal);
  assert.equal(decision.type, 'delegate_text');
  if (decision.type !== 'delegate_text') throw new Error('Expected dependency-aware assignment plan');
  assert.deepEqual(decision.assignments.map(item => item.assignmentId), ['docs', 'code']);
  assert.deepEqual(decision.assignments[1]?.dependsOn, ['docs']);

  const cycleProvider = new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: 'delegate_text', independence: 'Invalid cycle.', assignments: [
    { assignmentId: 'a', dependsOn: ['b'], definitionId: docId, objective: 'A', relevantContext: 'A', relevantContextRefs: [], constraints: [], expectedOutcome: 'A', evidenceExpectations: [] },
    { assignmentId: 'b', dependsOn: ['a'], definitionId: codyId, objective: 'B', relevantContext: 'B', relevantContextRefs: [], constraints: [], expectedOutcome: 'B', evidenceExpectations: [] },
  ] }) });
  await assert.rejects(cycleProvider.decide('Invalid plan', {
    availableIntents: ['delegate_text'], assignableDefinitionIds: [codyId, docId],
  }, new AbortController().signal), error => error instanceof Error && /invalid|decision/i.test(error.message));
});

test('Maestro routes mixed assignments by required capabilities, runs tools concurrently, and synthesizes sibling findings', { timeout: 15000 }, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'mediobot-capability-routing-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(path.join(workspaceRoot, 'existing-check.txt'), 'Existing controlled check fixture.\n');
  const world = createWorld();
  const runtime = new WorkerRuntime(world, { maxConcurrentExecutions: 5 });
  const tools = new ToolRuntime(world);
  const database = new LocalDatabase(path.join(workspaceRoot, 'mediobot.db'));
  const durableTaskEngine = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
  t.after(() => database.close());
  let searchCalls = 0;
  let crawlCalls = 0;
  const web = {
    isRunning: true,
    async search(request: WebSearchRequest): Promise<WebSearchResult> {
      searchCalls++;
      await new Promise(resolve => setTimeout(resolve, 250));
      const doc = request.filterType === 'documentation';
      return { query: request.query, totalMatches: 1, items: [{ title: doc ? 'Doc Source' : 'Research Source',
        url: doc ? 'https://docs.example.test/api' : 'https://research.example.test/paper',
        snippet: doc ? 'DOC_WEB_FINDING_71' : 'RESEARCH_WEB_FINDING_82', source: 'controlled-web-fixture' }] };
    },
    async crawl(request: CrawlRequest): Promise<CrawlResult> {
      crawlCalls++;
      return { url: request.url, finalUrl: request.url, title: 'Crawled source', markdown: `CRAWLED_${request.url.includes('docs.') ? 'DOC' : 'RESEARCH'}_FINDING`,
        sanitized: true, promptInjectionFlags: [], provenance: { url: request.url, timestamp: Date.now(), contentHash: 'fixture', byteSize: 20 },
        cached: false, durationMs: 1, success: true };
    },
  };
  let finalInput = '';
  let docGroupRepairCalls = 0;
  const maestro = new MaestroDecisionProvider({ complete: async ({ input }) => {
    finalInput = input;
    return JSON.stringify({ type: 'respond', message: 'Combined findings: authoritative docs, current research, and Tester execution evidence were reconciled.', basis: 'conversation', evidenceRefs: [] });
  } });
  let testerAction = 0;
  const testerDecisionModels: string[] = [];
  const testerDecisionsForModel = (modelId: string) => new TesterDecisionProvider({ complete: async () => {
    testerDecisionModels.push(modelId);
    const actions = [
      { type: 'read', path: 'existing-check.txt' },
      { type: 'run', command: process.execPath, args: ['-e', "setTimeout(() => { console.log('TEST_TOOL_FINDING_93'); process.exit(1); }, 200)"], check: 'Controlled test command exposes a failure' },
      { type: 'finish', report: { status: 'failed', summary: 'Tester observed the controlled test failure.', observations: ['TEST_TOOL_FINDING_93'], assertions: [{ name: 'controlled-command', passed: false }] } },
    ];
    return JSON.stringify(actions[testerAction++] ?? actions.at(-1));
  } });
  const codyDecisions = new MaestroDecisionProvider({ complete: async () => { throw new Error('Cody tools are outside this test'); } });
  const execution = createMaestroCodyExecution({ world, runtime, tools,
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate specialists.' },
    maestroDecisions: maestro,
    codyDecisions: codyDecisions as never,
    decisionResolver: { resolveDecisions(options) {
      const selection = options?.modelSelection as { modelId?: unknown } | undefined;
      return { maestroDecisions: maestro, codyDecisions,
        testerDecisions: testerDecisionsForModel(typeof selection?.modelId === 'string' ? selection.modelId : 'parent-model') };
    } },
    durableTaskEngine,
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: 'fixture', modelId: 'fixture' }, client: { complete: async ({ input, system }) => {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (system.includes('requires one model-authored group finding')) {
        docGroupRepairCalls++;
        return JSON.stringify({ status: 'completed', summary: 'Official docs evidence retrieved.',
          evidence: ['CRAWLED_DOC_FINDING'], blockers: [], unresolved: [],
          groupMessages: [{ kind: 'finding', content: 'The crawled official documentation source reports CRAWLED_DOC_FINDING for the API behavior.', evidenceRefs: [] }] });
      }
      return report(input.includes('CRAWLED_') ? input : 'TEXT_ONLY_WORKER_FINDING');
    } } }; } },
    crawl4ai: web,
  });
  const docId = execution.docDefinitionId!;
  const researchId = execution.researchDefinitionId!;
  const testerId = execution.testerDefinitionId;
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const task = world.assignTask(world.createTask('Run a mixed specialist verification task').id, worker.id);
  await durableTaskEngine.submitTask({ id: task.id, workspaceId: 'capability-routing-test', threadId: 'capability-routing-thread',
    goal: task.goal, definitionId: execution.maestroDefinitionId });
  await durableTaskEngine.startTask(task.id);
  const assignments = [
    { definitionId: docId, objective: 'Research official docs.example.test API documentation and publish a group finding', relevantContext: 'Retrieve documentation.', relevantContextRefs: [], constraints: [], expectedOutcome: 'Official API evidence', evidenceExpectations: ['Crawled documentation'], requiredCapabilities: ['web.search', 'web.crawl'] },
    { definitionId: researchId, objective: 'Research implementation evidence from research.example.test', relevantContext: 'Search and crawl sources.', relevantContextRefs: [], constraints: [], expectedOutcome: 'Research evidence', evidenceExpectations: ['Crawled research'], requiredCapabilities: ['web.search', 'web.crawl'] },
    { definitionId: testerId, objective: 'Inspect the existing test file and execute its controlled check', relevantContext: 'Read the existing check; do not modify files.', relevantContextRefs: [], constraints: [], expectedOutcome: 'Observed read and command results', evidenceExpectations: ['Read and terminal tool results'], requiredCapabilities: ['filesystem.read', 'terminal.execute'] },
  ];
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: task.id,
    goal: 'Run a mixed specialist verification task', options: { workspaceRoot, workspaceId: 'capability-routing-test', threadId: 'capability-routing-thread', durableTaskEngine,
      modelSelection: { providerConnectionId: 'parent', modelId: 'parent-model' },
      assignmentModelSelections: { [testerId]: { providerConnectionId: 'tester', modelId: 'tester-model' } },
      maestroDecision: { type: 'delegate_text', independence: 'Each assignment is independent.', assignments } } });
  const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(searchCalls, 2, 'Doc and Research each performed an actual web search');
  assert.equal(docGroupRepairCalls, 1, 'Doc performs one bounded model-only repair when its first report omits the required finding');
  assert.ok(testerDecisionModels.includes('tester-model'), 'Tester resolves its decision client using its assigned model');
  assert.equal(crawlCalls, 2, 'Doc and Research each crawled the returned source');
  assert.match(finalInput, /CRAWLED_DOC_FINDING/);
  assert.match(finalInput, /CRAWLED_RESEARCH_FINDING/);
  assert.match(finalInput, /TEST_TOOL_FINDING_93/);
  const synthesisContext = JSON.parse(finalInput);
  const specialistRecords = synthesisContext.projectIntelligence.filter((record: { name: string }) => record.name === 'specialist-result');
  assert.ok(specialistRecords.length >= 3, 'Final synthesis receives separate records for each specialist');
  assert.ok(specialistRecords.every((record: { value: string }) => record.value.length <= 4_000), 'Each report stays below context truncation limits');
  assert.ok(specialistRecords.some((record: { value: string }) => record.value.includes('CRAWLED_DOC_FINDING')));
  assert.ok(specialistRecords.some((record: { value: string }) => record.value.includes('CRAWLED_RESEARCH_FINDING')));
  assert.ok(specialistRecords.some((record: { value: string }) => record.value.includes('TEST_TOOL_FINDING_93')));

  const docAccess = await durableTaskEngine.authorizeSpecialistSessionScope(task.id, docId);
  const group = await durableTaskEngine.getCollaborationGroupForTask(docAccess);
  assert.ok(group, 'Durable group exists for the active parent task');
  const docMessages = await durableTaskEngine.listCollaborationGroupMessages(docAccess, group!.id, 8, 4_000);
  const authoredFinding = docMessages.messages.find(message => message.senderSpecialistId === docId && message.kind === 'finding');
  assert.ok(authoredFinding, 'Doc published a specialist-authored group finding, separately attributed from Maestro kickoff');
  assert.match(authoredFinding!.content, /CRAWLED_DOC_FINDING/);
  assert.equal(authoredFinding!.sequenceNumber, 2, 'Finding follows the coordinator kickoff in deterministic group order');

  const snapshot = world.inspect();
  assert.ok(snapshot.assignments.some(assignment => assignment.targetDefinitionId === testerId),
    'The actual Tester assignment is recorded in authoritative organizational state.');
  assert.equal(snapshot.events.some(event => event.type === 'worker.message' && event.message?.includes('I’ve assigned Tester')), false,
    'The runtime does not emit a scripted first-person announcement as model-authored dialogue.');
  const webWorkers = new Set(snapshot.assignments.filter(a => a.targetDefinitionId === docId || a.targetDefinitionId === researchId)
    .map(a => snapshot.workers.find(w => w.definitionId === a.targetDefinitionId)?.id));
  const searchEvents = snapshot.events.filter(event => event.toolName === 'web.search' && event.type === 'tool.started');
  assert.equal(searchEvents.length, 2);
  assert.ok(searchEvents.every(event => event.workerId && webWorkers.has(event.workerId)), 'Web lifecycle events retain specialist identity');
  const testerWorker = snapshot.workers.find(w => w.definitionId === testerId)!;
  assert.ok(snapshot.events.some(event => event.type === 'tool.completed' && event.toolName === 'filesystem.read'
    && event.workerId === testerWorker.id), 'Tester uses its real read-only filesystem capability');
  const terminalEvents = snapshot.events.filter(event => event.toolName === 'terminal.execute');
  assert.ok(terminalEvents.some(event => event.type === 'tool.started' && event.workerId === testerWorker.id));
  assert.ok(terminalEvents.some(event => event.type === 'tool.failed' && event.workerId === testerWorker.id));
  const testerEvidence = snapshot.evidence.find(entry => entry.source.type === 'tester-verification' && entry.workerId === testerWorker.id);
  assert.ok(testerEvidence, 'The failing test invocation is recorded as Tester evidence');
  const finalMessage = snapshot.evidence.find(entry => entry.source.type === 'maestro-response');
  assert.match(finalMessage?.content ?? '', /Combined findings/);

  const intervals = searchEvents.map(start => ({ start: start.occurredAt,
    end: snapshot.events.find(e => e.type === 'tool.completed' && e.toolInvocationId === start.toolInvocationId)!.occurredAt }));
  assert.ok(Math.min(...intervals.map(i => i.end)) - Math.max(...intervals.map(i => i.start)) > 0, 'Independent web specialist calls overlap');
  const testerStart = terminalEvents.find(event => event.type === 'tool.started')!;
  const testerEnd = terminalEvents.find(event => event.type === 'tool.failed')!;
  const mixedOverlapMs = Math.min(intervals[0]!.end, testerEnd.occurredAt) - Math.max(intervals[0]!.start, testerStart.occurredAt);
  assert.ok(mixedOverlapMs > 0, 'Web and test executors overlap');
  t.diagnostic(JSON.stringify({ searchCalls, crawlCalls, testerToolEvents: terminalEvents.length,
    webOverlapMs: Math.min(...intervals.map(i => i.end)) - Math.max(...intervals.map(i => i.start)),
    mixedOverlapMs, finalSynthesisIncludesSuccessfulFindings: /CRAWLED_DOC_FINDING/.test(finalInput) && /TEST_TOOL_FINDING_93/.test(finalInput),
    partialFailureIsolated: Boolean(testerEvidence) }));
});

test('Doc without a web requirement stays on the text executor', { timeout: 8000 }, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'mediobot-text-doc-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  const tools = new ToolRuntime(world);
  let modelCalls = 0;
  let finalInput = '';
  const maestro = new MaestroDecisionProvider({ complete: async ({ input }) => {
    finalInput = input;
    return JSON.stringify({ type: 'respond', message: 'Text analysis included.', basis: 'conversation', evidenceRefs: [] });
  } });
  const execution = createMaestroCodyExecution({ world, runtime, tools,
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate.' },
    maestroDecisions: maestro,
    codyDecisions: new MaestroDecisionProvider({ complete: async () => { throw new Error('Unused'); } }) as never,
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: 'fixture', modelId: 'text' }, client: { complete: async () => {
      modelCalls++;
      return report('TEXT_ONLY_DOC_REPORT_14');
    } } }; } },
  });
  const doc = world.inspect().definitions.find(definition => definition.role === 'doc')!;
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const task = world.assignTask(world.createTask('Explain the supplied API notes').id, worker.id);
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: task.id,
    goal: 'Explain the supplied API notes', options: { workspaceRoot, maestroDecision: { type: 'delegate_text', independence: 'One bounded analysis.', assignments: [
      { definitionId: doc.id, objective: 'Summarize supplied API notes', relevantContext: 'API notes are supplied directly.', relevantContextRefs: [], constraints: [], expectedOutcome: 'Concise explanation', evidenceExpectations: [] },
    ] } } });
  const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(modelCalls, 1);
  assert.match(finalInput, /TEXT_ONLY_DOC_REPORT_14/);
  assert.equal(world.inspect().events.some(event => event.toolName === 'web.search' || event.toolName === 'web.crawl'), false);
  t.diagnostic(JSON.stringify({ textModelCalls: modelCalls, webToolCalls: 0, synthesisIncludesTextFinding: finalInput.includes('TEXT_ONLY_DOC_REPORT_14') }));
});

test('a text-capable specialist registered after Maestro startup is discoverable and executable', { timeout: 8000 }, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'mediobot-dynamic-text-specialist-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  let specialistCalls = 0;
  let synthesisInput = '';
  let assignmentInput = '';
  let assignmentSystem = '';
  const decisions = new MaestroDecisionProvider({ complete: async ({ input }) => {
    const payload = JSON.parse(input) as { projectIntelligence?: unknown; availableMediobots?: Array<{ definitionId: string; name: string; assignable: boolean; capabilities?: string[] }> };
    if (payload.projectIntelligence) {
      synthesisInput = input;
      return JSON.stringify({ type: 'respond', message: 'The analyst completed the requested review.', basis: 'conversation', evidenceRefs: [] });
    }
    const analyst = payload.availableMediobots?.find(entry => entry.name === 'Analyst');
    const pausedAnalyst = payload.availableMediobots?.find(entry => entry.name === 'Paused Analyst');
    assert.ok(analyst?.assignable, 'Maestro should discover the late-registered capability-compatible specialist');
    assert.deepEqual(analyst.capabilities, ['text-inference']);
    assert.equal(pausedAnalyst?.assignable, false, 'draining specialists remain visible but receive no new assignments');
    return JSON.stringify({ type: 'delegate_text', independence: 'One bounded analysis.', assignments: [
      { definitionId: analyst.definitionId, objective: 'Analyze supplied deployment notes', relevantContext: 'The notes say to deploy on Tuesdays.',
        relevantContextRefs: [], constraints: [], expectedOutcome: 'A concise scheduling recommendation', evidenceExpectations: [], requiredCapabilities: ['text-inference'] },
    ] });
  } });
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate.' },
    maestroDecisions: decisions,
    codyDecisions: new MaestroDecisionProvider({ complete: async () => { throw new Error('Cody route must not be selected'); } }) as never,
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: 'fixture', modelId: 'text' }, client: { complete: async ({ system, input }) => {
      specialistCalls++;
      assignmentInput = input;
      assignmentSystem = system;
      return report('Only deploy on Tuesdays if the change window is approved.');
    } } }; } },
  });
  const analyst = world.registerMediobotDefinition({ id: 'analyst' as never, name: 'Analyst', role: 'deployment-analysis', version: '1.0.0',
    instructions: 'Analyze supplied operational notes and identify constraints.',
    declaredCapabilities: [{ kind: 'action', name: 'text-inference', description: 'Bounded analysis over supplied context' }] });
  const pausedAnalyst = world.registerMediobotDefinition({ id: 'paused-analyst' as never, name: 'Paused Analyst', role: 'deployment-analysis', version: '1.0.0',
    instructions: 'Do not receive new work while draining.', lifecycleState: 'draining',
    declaredCapabilities: [{ kind: 'action', name: 'text-inference', description: 'Bounded analysis over supplied context' }] });
  assert.equal(world.inspect().definitions.find(entry => entry.id === pausedAnalyst.id)?.lifecycleState, 'draining');
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const task = world.assignTask(world.createTask('Analyze the deployment notes').id, worker.id);
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: task.id,
    goal: 'Analyze the deployment notes', options: { workspaceRoot, modelSelection: { providerConnectionId: 'fixture', modelId: 'text' } } });
  const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(specialistCalls, 1);
  assert.match(assignmentSystem, /Analyze supplied operational notes/);
  assert.match(assignmentInput, /Analyze supplied deployment notes/);
  assert.match(synthesisInput, /Only deploy on Tuesdays/);
  const assignment = world.inspect().assignments.find(entry => entry.targetDefinitionId === analyst.id);
  assert.ok(assignment, 'The dynamic specialist owns a first-class organizational assignment');
  assert.ok(world.inspect().evidence.some(entry => entry.workerId && entry.taskId
    && world.inspect().workers.some(candidate => candidate.id === entry.workerId && candidate.definitionId === analyst.id)));
  world.setMediobotLifecycleState(analyst.id, 'draining');
  assert.throws(() => world.spawnWorker(analyst.id), /not active/i);
  world.setMediobotLifecycleState(analyst.id, 'disabled');
  assert.equal(world.inspect().definitions.some(entry => entry.id === analyst.id), true, 'disabled specialist identity remains for attribution');
});

test('a persisted text-only specialist using the doc role cannot inherit the built-in web adapter', () => {
  const world = createWorld();
  const customDoc = world.registerMediobotDefinition({ id: 'definition-custom-doc' as never, name: 'Custom Doc', role: 'doc', version: '1',
    instructions: 'Analyze supplied text only.', declaredCapabilities: [{ kind: 'action', name: 'text-inference' }] });
  const runtime = new WorkerRuntime(world);
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate.' },
    maestroDecisions: new MaestroDecisionProvider({ complete: async () => '{"type":"respond","message":"ok","basis":"conversation","evidenceRefs":[]}' }),
    codyDecisions: new MaestroDecisionProvider({ complete: async () => '{"type":"finish","summary":"unused"}' }) as never,
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: 'fixture', modelId: 'fixture' }, client: { complete: async () => report('unused') } }; } },
    crawl4ai: { isRunning: true, async search(request) { return { query: request.query, totalMatches: 0, items: [] }; },
      async crawl(request) { return { url: request.url, finalUrl: request.url, markdown: '', sanitized: true, promptInjectionFlags: [],
        provenance: { url: request.url, timestamp: Date.now(), contentHash: '', byteSize: 0 }, cached: false, durationMs: 0, success: true }; } },
  });

  assert.equal(execution.docDefinitionId, 'doc', 'the built-in adapter keeps its canonical identity');
  assert.equal(execution.webExecution?.definitionIds.includes(customDoc.id), false,
    'a restored role name does not grant web capabilities when the saved contract is text-only');
});

test('a newly registered web-capable specialist is discovered and dispatched through the existing web execution adapter', { timeout: 10000 }, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'mediobot-dynamic-web-specialist-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  const tools = new ToolRuntime(world);
  let searches = 0;
  let crawls = 0;
  let finalInput = '';
  const web = {
    isRunning: true,
    async search(request: WebSearchRequest): Promise<WebSearchResult> {
      searches++;
      return { query: request.query, totalMatches: 1, items: [{ title: 'Custom policy documentation', url: 'https://docs.example.test/custom-policy',
        snippet: 'custom policy configuration and defaults', source: 'controlled-fixture' }] };
    },
    async crawl(request: CrawlRequest): Promise<CrawlResult> {
      crawls++;
      return { url: request.url, finalUrl: request.url, title: 'Custom policy documentation', markdown: 'CUSTOM_POLICY_WEB_EVIDENCE_91',
        sanitized: true, promptInjectionFlags: [], provenance: { url: request.url, timestamp: Date.now(), contentHash: 'fixture', byteSize: 28 },
        cached: false, durationMs: 1, success: true };
    },
  };
  const maestro = new MaestroDecisionProvider({ complete: async ({ input }) => {
    finalInput = input;
    return JSON.stringify({ type: 'respond', message: 'The custom specialist retrieved and summarized its assigned policy source.', basis: 'conversation', evidenceRefs: [] });
  } });
  const codyDecisions = new MaestroDecisionProvider({ complete: async () => { throw new Error('Cody is not assigned in this scenario'); } });
  const execution = createMaestroCodyExecution({ world, runtime, tools,
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate specialists.' },
    maestroDecisions: maestro, codyDecisions: codyDecisions as never,
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: 'fixture', modelId: 'custom-web-model' }, client: {
      complete: async ({ input }: { input: string }) => report(input.includes('CUSTOM_POLICY_WEB_EVIDENCE_91')
        ? 'Custom policy findings grounded in crawled evidence.' : 'No crawled evidence was supplied.') } }; } },
    crawl4ai: web,
  });
  const custom = world.registerMediobotDefinition({ id: 'custom-policy-analyst' as never, name: 'Policy Analyst', role: 'policy-research', version: '1',
    instructions: 'Research custom policy documentation and cite the crawled source.', declaredCapabilities: [
      { kind: 'action', name: 'text-inference' }, { kind: 'action', name: 'web.search' }, { kind: 'action', name: 'web.crawl' },
    ] });
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const task = world.assignTask(world.createTask('Find the custom policy documentation and summarize its defaults.').id, worker.id);
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: task.id,
    goal: task.goal, options: { workspaceRoot, maestroDecision: { type: 'delegate_text', independence: 'One bounded source retrieval and summary.', assignments: [
      { assignmentId: 'policy-docs', definitionId: custom.id, objective: 'Find custom policy documentation and summarize the configuration defaults.',
        relevantContext: 'Use relevant web sources and the existing web retrieval capability.', relevantContextRefs: [], constraints: [],
        expectedOutcome: 'A concise evidence-backed summary of custom policy defaults.', evidenceExpectations: ['Crawled policy source'],
        requiredCapabilities: ['web.search', 'web.crawl'] },
    ] } } });
  const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });

  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(searches, 1, 'the registered specialist uses the existing search implementation');
  assert.equal(crawls, 1, 'the registered specialist uses the existing crawl implementation');
  assert.match(finalInput, /Custom policy findings grounded in crawled evidence/);
  const workerIds = new Set(world.inspect().workers.filter(item => item.definitionId === custom.id).map(item => item.id));
  assert.ok(world.inspect().events.some(event => event.workerId && workerIds.has(event.workerId)
    && event.toolName === 'web.search' && event.type === 'tool.started'), 'the web call is attributed to the dynamic specialist');
});

test('failed assignment prerequisite blocks dependent work and remains visible to Maestro', { timeout: 8000 }, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'mediobot-failed-prerequisite-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate.' },
    maestroDecisions: new MaestroDecisionProvider({ complete: async ({ input }) => {
      synthesisInput = input;
      return JSON.stringify({ type: 'respond', message: 'The prerequisite failed; dependent work remains blocked.', basis: 'conversation', evidenceRefs: [] });
    } }),
    codyDecisions: new MaestroDecisionProvider({ complete: async () => { throw new Error('Cody is not assigned.'); } }) as never,
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: 'fixture', modelId: 'fixture' }, client: { complete: async ({ input }) => {
      specialistCalls++;
      const assignment = JSON.parse(input).assignment;
      if (assignment.objective === 'Retrieve the required summary') throw new Error('controlled prerequisite failure');
      return report('Dependent research must not be invoked');
    } } }; } },
  });
  const doc = 'doc';
  const research = 'research';
  assert.doesNotThrow(() => validateMaestroDecision({ type: 'delegate_text', independence: 'Independent with prerequisite.', assignments: [
    { assignmentId: 'docs', definitionId: doc, objective: 'Retrieve the required summary', relevantContext: 'Summarize this supplied note.', relevantContextRefs: [], constraints: [], expectedOutcome: 'Required summary', evidenceExpectations: [] },
    { assignmentId: 'research', dependsOn: ['docs'], definitionId: research, objective: 'Analyze the supplied finding', relevantContext: 'Use the prerequisite result.', relevantContextRefs: [], constraints: [], expectedOutcome: 'Bounded analysis', evidenceExpectations: [] },
  ] }, { availableIntents: ['delegate_text'], assignableDefinitionIds: [doc, research], availableMediobots: [
    { definitionId: doc, name: 'Doc', role: 'doc', assignable: true, capabilities: ['text-inference'] },
    { definitionId: research, name: 'Research', role: 'research', assignable: true, capabilities: ['text-inference'] },
  ] }));
  let specialistCalls = 0;
  let synthesisInput = '';
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const parent = world.assignTask(world.createTask('Use verified API evidence for research').id, worker.id);
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: parent.id,
      goal: 'Summarize supplied requirements using dependent analysis', options: { workspaceRoot, maestroDecision: { type: 'delegate_text', independence: 'Research depends on the required documentation result.', assignments: [
      { assignmentId: 'docs', definitionId: doc, objective: 'Retrieve the required summary', relevantContext: 'Summarize this supplied note.', relevantContextRefs: [], constraints: [], expectedOutcome: 'Required summary', evidenceExpectations: [] },
      { assignmentId: 'research', dependsOn: ['docs'], definitionId: research, objective: 'Analyze the supplied finding', relevantContext: 'Use the prerequisite result.', relevantContextRefs: [], constraints: [], expectedOutcome: 'Bounded analysis', evidenceExpectations: [] },
    ] } } });
  const result = await runtime.run({ ...plan, workerId: worker.id, taskId: parent.id });
  assert.equal(result.state, 'completed', `${JSON.stringify(result)}; synthesis=${synthesisInput.slice(0, 1000)}`);
  assert.equal(specialistCalls, 1, 'dependent Research must not invoke its model after the Doc prerequisite fails');
  assert.match(synthesisInput, /model-unavailable|prerequisite/i);
  assert.match(synthesisInput, /blocked/i);
});

test('specialist findings survive a failed final synthesis request', { timeout: 8000 }, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'mediobot-partial-synthesis-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  const tools = new ToolRuntime(world);
  const execution = createMaestroCodyExecution({ world, runtime, tools,
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate.' },
    maestroDecisions: new MaestroDecisionProvider({ complete: async () => { throw new Error('controlled provider interruption'); } }),
    codyDecisions: new MaestroDecisionProvider({ complete: async () => { throw new Error('Unused'); } }) as never,
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: 'fixture', modelId: 'text' }, client: { complete: async () => report('PRESERVED_SPECIALIST_FINDING_41') } }; } },
  });
  const doc = world.inspect().definitions.find(definition => definition.role === 'doc')!;
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const task = world.assignTask(world.createTask('Explain supplied documentation').id, worker.id);
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: task.id,
    goal: 'Explain supplied documentation', options: { workspaceRoot, maestroDecision: { type: 'delegate_text', independence: 'One assignment.', assignments: [
      { definitionId: doc.id, objective: 'Summarize the provided API notes', relevantContext: 'Notes are supplied directly.', relevantContextRefs: [], constraints: [], expectedOutcome: 'Summary', evidenceExpectations: [] },
    ] } } });
  const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
  assert.equal(result.state, 'completed');
  const message = world.inspect().evidence.find(entry => entry.source.type === 'maestro-response')?.content ?? '';
  assert.match(message, /could not provide a verified final synthesis/i);
  assert.match(message, /PRESERVED_SPECIALIST_FINDING_41/);
  assert.match(message, /verbatim/);
});

test('required web capability with no capable adapter is reported instead of sent to text', { timeout: 8000 }, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'mediobot-missing-web-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  const maestro = new MaestroDecisionProvider({ complete: async ({ input }) => {
    const parsed = JSON.parse(input);
    const result = parsed.projectIntelligence?.find((item: { name: string }) => item.name === 'specialist-executor-results')?.value ?? '';
    return JSON.stringify({ type: 'respond', message: result, basis: 'conversation', evidenceRefs: [] });
  } });
  let textCalls = 0;
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate.' },
    maestroDecisions: maestro, codyDecisions: new MaestroDecisionProvider({ complete: async () => { throw new Error('Unused'); } }) as never,
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: 'fixture', modelId: 'text' }, client: { complete: async () => {
      textCalls++;
      return report('Incorrect fallback');
    } } }; } },
  });
  const doc = world.inspect().definitions.find(definition => definition.role === 'doc')!;
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const task = world.assignTask(world.createTask('Find current API docs').id, worker.id);
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: task.id,
    goal: 'Find current API docs', options: { workspaceRoot, maestroDecision: { type: 'delegate_text', independence: 'One assignment.', assignments: [
      { definitionId: doc.id, objective: 'Search and crawl official API docs', relevantContext: 'Find authoritative docs.', relevantContextRefs: [], constraints: [], expectedOutcome: 'Documented behavior', evidenceExpectations: [], requiredCapabilities: ['web.search', 'web.crawl'] },
    ] } } });
  const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
  assert.equal(result.state, 'completed');
  assert.equal(textCalls, 0);
  assert.match(world.inspect().evidence.find(entry => entry.source.type === 'maestro-response')?.content ?? '', /required capabilities unavailable/);
  assert.equal(world.inspect().events.some(event => event.toolName === 'web.search' || event.toolName === 'web.crawl'), false);
  t.diagnostic('Unavailable web capability surfaced; no text substitution occurred.');
});

test('Cody support request expands the LangGraph plan and resumes after the authorized helper while sibling work continues', { timeout: 15000 }, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'mediobot-dynamic-support-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const world = createWorld();
  const governor = new ResourceGovernor({ budget: { maxConcurrentTasks: 2, maxConcurrentTasksPerWorkspace: 2 } });
  const runtime = new WorkerRuntime(world, { maxConcurrentExecutions: 5, resourceGovernor: governor });
  const database = new LocalDatabase(path.join(workspaceRoot, 'mediobot.db'));
  const durableTaskEngine = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
  t.after(() => database.close());
  const webIntervals: Array<{ query: string; start: number; end: number }> = [];
  let peakExecutionSlots = 0;
  const crawledUrls: string[] = [];
  let releaseIndependentSearch!: () => void;
  const independentSearchGate = new Promise<void>(resolve => { releaseIndependentSearch = resolve; });
  const releaseGuard = setTimeout(releaseIndependentSearch, 2_000);
  t.after(() => { clearTimeout(releaseGuard); releaseIndependentSearch(); });
  let codyCalls = 0;
  let continuationInput = '';
  let finalInput = '';
  let docDefinitionId = '';
  const maestro = new MaestroDecisionProvider({ complete: async ({ input }) => {
    finalInput = input;
    return JSON.stringify({ type: 'respond', message: 'Cody used the attributed Doc result and Research completed independently.',
      basis: 'conversation', evidenceRefs: [] });
  } });
  const codyDecisions = new CodyDecisionProvider({ complete: async ({ input }) => {
    codyCalls++;
    if (codyCalls === 1) return JSON.stringify({ type: 'request_support', definitionId: docDefinitionId,
      capabilityNeeded: 'web.search', query: 'Node.js official API documentation guidance', contextSnippet: 'Use official documentation.' });
    continuationInput = input;
    assert.match(input, /DOC_SUPPORT_RESULT/);
    return JSON.stringify({ type: 'finish', summary: 'Continued using the authorized Doc report.' });
  } });
  const web = {
    isRunning: true,
    async search(request: WebSearchRequest): Promise<WebSearchResult> {
      peakExecutionSlots = Math.max(peakExecutionSlots, governor.activeCategoryCount('execution-slot'));
      const start = performance.now();
      const independent = request.query.toLowerCase().includes('independent');
      if (independent) await independentSearchGate;
      else releaseIndependentSearch();
      await new Promise(resolve => setTimeout(resolve, 45));
      const url = independent
        ? 'https://research.example.test/independent' : 'https://nodejs.org/en/learn/getting-started/introduction-to-nodejs';
      webIntervals.push({ query: request.query, start, end: performance.now() });
      return { query: request.query, totalMatches: 1, items: [{ title: independent ? 'Independent research result' : 'Node.js official API documentation',
        url, snippet: independent ? 'Independent research result from a relevant source' : 'Node.js official API documentation guidance',
        source: 'controlled-fixture' }] };
    },
    async crawl(request: CrawlRequest): Promise<CrawlResult> {
      crawledUrls.push(request.url);
      return { url: request.url, finalUrl: request.url, title: 'Official documentation',
        markdown: request.url.includes('nodejs.org') ? 'DOC_SUPPORT_RESULT' : 'RESEARCH_CRAWL_RESULT',
        sanitized: true, promptInjectionFlags: [], provenance: { url: request.url, timestamp: Date.now(),
          contentHash: 'controlled', byteSize: 32 }, cached: false, durationMs: 1, success: true };
    },
  };
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate.' },
    maestroDecisions: maestro, codyDecisions: codyDecisions as never,
    durableTaskEngine,
    textModelResolver: { resolveForOperation() { return { descriptor: { providerId: 'fixture', modelId: 'support-model' },
      client: { complete: async ({ input }) => {
        const output = report(input.includes('RESEARCH_CRAWL_RESULT') || input.includes('RESEARCH_REPORT')
          ? 'RESEARCH_REPORT' : 'DOC_SUPPORT_RESULT');
        return output;
      } } }; } },
    crawl4ai: web,
  });
  const codyId = execution.codyDefinitionId;
  const researchId = execution.researchDefinitionId!;
  docDefinitionId = execution.docDefinitionId!;
  const worker = world.spawnWorker(execution.maestroDefinitionId);
  const task = world.assignTask(world.createTask('Use official guidance and conduct independent research').id, worker.id);
  await durableTaskEngine.submitTask({ id: task.id, workspaceId: 'support-test', threadId: 'support-thread',
    goal: task.goal, definitionId: execution.maestroDefinitionId });
  await durableTaskEngine.startTask(task.id);
  const plan = execution.adapter.prepare({ world, definitionId: execution.maestroDefinitionId, workerId: worker.id, taskId: task.id,
    goal: 'Use official guidance and conduct independent research',
    options: { workspaceRoot, maestroDecision: { type: 'delegate_text', independence: 'Cody and Research start independently; Cody may request one bounded Doc follow-up.',
      assignments: [
        { assignmentId: 'cody-phase', definitionId: codyId, objective: 'Inspect the task and continue after specialist support',
          relevantContext: 'Use the selected official documentation.', relevantContextRefs: [], constraints: [],
          expectedOutcome: 'An evidence-backed continuation', evidenceExpectations: ['Cody continuation report'], requiredCapabilities: ['filesystem.read'] },
        { assignmentId: 'research-independent', definitionId: researchId, objective: 'Independent research result for the same task',
          relevantContext: 'Search and crawl a relevant source.', relevantContextRefs: [], constraints: [],
          expectedOutcome: 'A relevant research report', evidenceExpectations: ['Crawled research source'], requiredCapabilities: ['web.search', 'web.crawl'] },
      ] } } });
  const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id, admissionMode: 'coordination', workspaceId: 'support-test' });
  const synthesisContext = JSON.parse(finalInput) as { projectIntelligence?: Array<{ name: string; value: string }> };
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(codyCalls, 2, 'Cody runs its support request and the dependent continuation');
  assert.match(continuationInput, /DOC_SUPPORT_RESULT/);
  assert.ok(finalInput.includes('DOC_SUPPORT_RESULT'),
    'Maestro receives Cody’s attributed continuation together with the explicitly authorized Doc assistance result');
  const synthesizedReports = (synthesisContext.projectIntelligence ?? []).filter(item => item.name === 'specialist-result')
    .map(item => { try { return JSON.parse(item.value) as { specialistId?: string; status?: string }; } catch { return {}; } });
  const codySynthesis = (synthesisContext.projectIntelligence ?? []).find(item => item.name === 'specialist-result'
    && item.value.includes('"executor":"cody"'))?.value ?? '';
  assert.match(codySynthesis, /continue-[a-f0-9]+ \(cody, completed\)/,
    'Maestro receives the completed, attributed Cody continuation outcome');
  assert.ok(codySynthesis.includes('DOC_SUPPORT_RESULT'), 'Maestro receives the authorized helper evidence through Cody’s outcome');
  assert.ok(synthesizedReports.some(report => report.specialistId === researchId && report.status === 'completed'),
    'Maestro synthesis context retains the independent Research assignment attribution');
  assert.ok(finalInput.includes('RESEARCH_REPORT'), 'Maestro synthesis includes the independent Research finding');
  const research = webIntervals.find(interval => interval.query.toLowerCase().includes('independent'));
  const support = webIntervals.find(interval => interval.query.toLowerCase().includes('node.js'));
  assert.ok(research && support, 'both the initial Research assignment and dynamic Doc assignment invoked web.search');
  assert.ok(crawledUrls.some(url => url.includes('nodejs.org')) && crawledUrls.some(url => url.includes('research.example.test')),
    'Doc and Research both invoked web.crawl for their selected sources');
  const overlapMs = Math.max(0, Math.min(research.end, support.end) - Math.max(research.start, support.start));
  assert.ok(overlapMs > 0, 'the dynamic Doc assignment overlaps independent Research work');
  assert.equal(peakExecutionSlots, 2, 'specialist execution is admitted by the shared governor up to the configured cap');
  assert.equal(governor.activeCategoryCount('execution-slot'), 0, 'specialist admission leases are released after workflow settlement');
  const events = world.inspect().events;
  assert.ok(events.some(event => event.type === 'worker.progress' && event.workerId
    && world.inspect().workers.find(worker => worker.id === event.workerId)?.definitionId === execution.docDefinitionId));
  t.diagnostic(JSON.stringify({ codyCalls, docSearch: support.query, researchSearch: research.query, overlapMs,
    crawledUrls,
    continuationConsumedDocReport: continuationInput.includes('DOC_SUPPORT_RESULT'),
    synthesisContainsCodyContinuationAndResearch: codySynthesis.includes('(cody, completed)') && finalInput.includes('RESEARCH_REPORT'),
    specialistReportEvidence: (synthesisContext.projectIntelligence ?? []).filter(item => item.name === 'specialist-result')
      .map(item => { try { const report = JSON.parse(item.value) as { specialistId?: string; summary?: string }; return { specialistId: report.specialistId, summary: report.summary }; } catch { return {}; } }),
    researchVisible: finalInput.includes('RESEARCH_REPORT') }));
});

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createWorld } from '@mediobot-v2/domain';
import { RuntimeTaskSubmission, WorkerRuntime } from '@mediobot-v2/runtime';
import { ToolRuntime } from '@mediobot-v2/tools';
import { CodyDecisionProvider } from '@mediobot-v2/cody';
import { MaestroDecisionProvider, createMaestroCodyExecution, parseMediobotDefinition } from '@mediobot-v2/maestro';
import type { WorkerReport } from '@mediobot-v2/maestro';
import { OpenAICompatibleStructuredClient } from '@mediobot-v2/models';
import { ModelResolver, getEnabledModels } from '../../src/runtime/modelRegistry.ts';
import { ProviderRepository } from '../../src/storage/providerRepository.ts';
import { assertNonProductionDatabase, getProductionDatabasePath } from '../../src/storage/appPaths.ts';

/** Real native clients only. Read-only Settings store, explicit pair, no browser imports or calls.
 * Stage 1/2 cancel the coordinator AFTER child reports settle, before its synthesis call.
 * Stage 3 permits the existing real Maestro synthesis. No inference outputs are substituted.
 */
test('configured staged real text workers: one, two, three, then Maestro synthesis', {
  skip: process.env.MEDIOBOT_LIVE_PARALLEL !== '1' ? 'live-opt-in-required' : false,
  timeout: 360_000,
}, async t => {
  const providerConnectionId = process.env.MEDIOBOT_PARALLEL_PROVIDER;
  const modelId = process.env.MEDIOBOT_PARALLEL_MODEL;
  assert.ok(providerConnectionId && modelId, 'Set MEDIOBOT_PARALLEL_PROVIDER and MEDIOBOT_PARALLEL_MODEL explicitly; no fallback.');
  const selection = { providerConnectionId, modelId };
  const databasePath = process.env.MEDIOBOT_DATA_DIR?.trim()
    ? path.join(path.resolve(process.env.MEDIOBOT_DATA_DIR.trim()), 'mediobot.db') : getProductionDatabasePath();
  assertNonProductionDatabase(databasePath);
  assert.ok(existsSync(databasePath), 'Existing Settings application store required.');
  const db = new DatabaseSync(databasePath, { readOnly: true }); t.after(() => db.close());
  const repo = new ProviderRepository(db);
  const selected = getEnabledModels(repo).find(m => m.providerId === providerConnectionId && m.id === modelId);
  assert.ok(selected?.capabilities.text, 'Explicit pair must already be connected, enabled, and text-capable.');
  const definition = parseMediobotDefinition(readFileSync(new URL('../../../../mediobots/maestro/MEDIOBOT.md', import.meta.url), 'utf8'));
  const context = 'One Node.js process runs an in-memory job queue. Jobs arrive concurrently. Limit starts to five per second and active jobs to two. No persistence is required. Jobs can fail or be cancelled.';
  const goal = `Recommend a small rate-limited job queue design. ${context} Integrate implementation, tradeoffs, and verification concerns. This is text-only design, not executed implementation or tests.`;
  const objectives = [
    'Cody: propose a concrete implementation approach for the supplied queue requirements.',
    'Research: independently analyze architecture tradeoffs and assumptions using only the supplied context; no web claims.',
    'Tester: independently identify failure cases and specific acceptance criteria; do not claim tests were run.',
  ];

  for (const count of [1, 2, 3]) {
    const world = createWorld();
    let parentTaskId: Parameters<WorkerRuntime['cancel']>[0] | undefined;
    let transportBlocked = false;
    let synthesisCalls = 0;
    let workerCalls = 0;
    let responseCount = 0;
    let synthesisMessage = '';
    const runtime = new WorkerRuntime(world, { onSupervision: notice => {
      if (notice.event.type !== 'maestro.evidence-received' || !parentTaskId) return;
      const reports = world.inspect().evidence.filter(e => e.source.type === 'worker-report').map(e => JSON.parse(e.content) as WorkerReport);
      if (count < 3 || reports.length !== count || reports.some(r => r.status !== 'completed')) runtime.cancel(parentTaskId);
    } });
    const resolver = new ModelResolver(repo, { createClient: options => {
      assert.ok(options.modelId === modelId, 'Resolved model must match the explicit selection.');
      const native = new OpenAICompatibleStructuredClient({ ...options, fetch: async (input, init) => {
        const started = performance.now();
        try {
          const response = await fetch(input, init);
          responseCount++;
          t.diagnostic(JSON.stringify({ stage: count, requestStage: 'http-response', httpStatus: response.status, elapsedMs: performance.now() - started }));
          return response;
        } catch (error) {
          transportBlocked = true;
          t.diagnostic(JSON.stringify({ stage: count, requestStage: 'native-fetch-before-response', codes: safeCodes(error), elapsedMs: performance.now() - started }));
          if (parentTaskId) runtime.cancel(parentTaskId);
          throw error;
        }
      } });
      // Instrument calls without changing the native model input, output, signal, or timestamps.
      return { complete: async request => {
        const input = JSON.parse(request.input);
        if (input.assignment) workerCalls++;
        else {
          synthesisCalls++;
          assert.ok(count === 3, 'No synthesis call before the final stage.');
          assert.ok(input.goalAnchor && input.projectIntelligence?.some((e: { name: string }) => e.name === 'bounded-worker-reports'), 'Synthesis must receive Goal Anchor and bounded reports.');
        }
        return native.complete(request);
      } };
    } });
    // Resolution uses the same ProviderRepository/ModelResolver and native client as the product.
    const { client } = resolver.resolveForOperation('text-inference', selection);
    const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world), maestroDefinition: definition,
      codyDecisions: new CodyDecisionProvider(client), maestroDecisions: new MaestroDecisionProvider(client),
      textModelResolver: resolver, onUserMessage: message => { synthesisMessage = message; } });
    const submission = new RuntimeTaskSubmission(world, runtime);
    submission.registerAdapter(execution.maestroDefinitionId, execution.adapter);
    const roles = ['coding', 'research', 'tester'].slice(0, count);
    const definitions = roles.map(role => world.inspect().definitions.find(d => d.role === role)!);
    assert.ok(definitions.every(Boolean), 'Registered specialist definitions required.');
    const decision = { type: 'delegate_text', independence: 'Each specialist works only from supplied requirements and needs no sibling result.',
      assignments: definitions.map((d, index) => ({ definitionId: d.id, objective: objectives[index]!, relevantContext: context,
        relevantContextRefs: [], constraints: ['Text only. No tools, browser, web search, or executed tests.'],
        expectedOutcome: 'A concise useful recommendation from the assigned specialist perspective.', evidenceExpectations: ['Support conclusions from supplied requirements; state assumptions.'] })) };
    const submitted = submission.submit({ definitionId: execution.maestroDefinitionId, goal,
      options: { workspaceRoot: process.cwd(), modelSelection: selection, maestroDecision: decision },
      onCreated: ({ task }) => { parentTaskId = task.id; } });
    const timer = setTimeout(() => runtime.cancel(submitted.task.id), 110_000);
    let result;
    try { result = await submitted.result; } finally { clearTimeout(timer); }
    if (transportBlocked) {
      // Stop immediately: no alternate provider, retry, sibling stage, or synthesis.
      t.skip(`stage-${count}:native-transport-blocked:run-on-normal-Mac`);
      return;
    }
    const snapshot = world.inspect();
    const reports = snapshot.evidence.filter(e => e.source.type === 'worker-report').map(e => JSON.parse(e.content) as WorkerReport);
    for (const r of reports) t.diagnostic(JSON.stringify({ stage: count, assignmentId: safeId(r.assignmentId), workerId: safeId(r.workerId),
      mediobotId: safeId(r.mediobotId), mediobot: definitions.find(d => d.id === r.mediobotId)?.name,
      providerConnectionId: safeId(r.providerId), modelId: safeId(r.modelId), inferenceStartedAt: r.startedAt, inferenceCompletedAt: r.completedAt, status: r.status }));
    assert.ok(workerCalls === count && responseCount >= count, 'Every worker must make a real provider call.');
    assert.ok(reports.length === count && reports.every(r => r.status === 'completed'), 'Every stage requires valid completed WorkerReports.');
    assert.ok(new Set(reports.map(r => r.workerId)).size === count, 'Workers must be distinct.');
    assert.ok(new Set(reports.map(r => r.assignmentId)).size === count, 'Assignments must be distinct.');
    for (const r of reports) {
      assert.ok(r.providerId === providerConnectionId && r.modelId === modelId, 'No model substitution.');
      assert.ok(snapshot.assignments.find(a => a.id === r.assignmentId)?.targetDefinitionId === r.mediobotId, 'Assignment attribution mismatch.');
      assert.ok(snapshot.tasks.find(task => task.id === r.taskId)?.assignedWorkerId === r.workerId, 'Task attribution mismatch.');
      assert.ok(typeof r.startedAt === 'number' && typeof r.completedAt === 'number' && r.completedAt > r.startedAt, 'Actual model interval required.');
    }
    const commonStart = Math.max(...reports.map(r => r.startedAt!));
    const commonEnd = Math.min(...reports.map(r => r.completedAt!));
    t.diagnostic(JSON.stringify({ stage: count, workerCalls, synthesisCalls, commonStart, commonEnd, commonIntervalMs: commonEnd - commonStart }));
    assert.ok(commonStart < commonEnd, 'Positive real common inference interval required.');
    assert.ok(snapshot.resources.length === 0, 'Text-only acceptance must acquire no browser/workspace resources.');
    if (count < 3) {
      assert.ok(result.state === 'cancelled' && synthesisCalls === 0, 'Coordinator stops after reports in stages one and two.');
    } else {
      assert.ok(result.state === 'completed' && synthesisCalls > 0 && synthesisMessage.trim(), 'Real Maestro synthesis required.');
      // These are sanitized bounded conclusions, not raw provider payloads or hidden reasoning.
      t.diagnostic(JSON.stringify({ stage: 3, review: 'bounded-conclusions', specialists: reports.map(r => ({ mediobotId: safeId(r.mediobotId), summary: r.summary })), maestroSynthesis: synthesisMessage }));
    }
  }
});
function safeId(value?: string): string | undefined {
  return value && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(value) && !/(?:sk-|key|token|secret)/i.test(value) ? value : undefined;
}
function safeCodes(error: unknown): string[] {
  const allowed = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPERM', 'EACCES', 'ETIMEDOUT', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
  const codes: string[] = [];
  for (let i = 0; i < 4 && error && typeof error === 'object'; i++) {
    const item = error as { code?: unknown; cause?: unknown };
    if (typeof item.code === 'string' && allowed.has(item.code)) codes.push(item.code);
    error = item.cause;
  }
  return codes;
}

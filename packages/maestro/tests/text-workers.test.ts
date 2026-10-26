import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorld } from '@mediobot-v2/domain';
import { WorkerRuntime, RuntimeTaskSubmission } from '@mediobot-v2/runtime';
import { CodyDecisionProvider } from '@mediobot-v2/cody';
import { ToolRuntime } from '@mediobot-v2/tools';
import { createMaestroCodyExecution, MaestroDecisionProvider, readModelSelection, validateMaestroDecision } from '../src/index.ts';
import { requiresGroupFinding } from '../src/text-workers.ts';
import type { WorkerReport, ModelSelection } from '../src/index.ts';

const body = JSON.stringify({ status: 'completed', summary: 'Bounded conclusion', evidence: ['Supplied constraint'], blockers: [], unresolved: [] });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(mode: 'normal' | 'failure' | 'cancel' | 'unavailable' | 'blocked' | 'admission' | 'parent-cancel' | 'invalid-report' = 'normal', count = 3) {
  const world = createWorld();
  const notices: string[] = [];
  const runtime = new WorkerRuntime(world, { maxConcurrentExecutions: mode === 'admission' ? 1 : 4, onSupervision: n => { notices.push(n.event.type); } });
  const entered = deferred(); const release = deferred();
  let calls = 0; let synthesis = ''; let delivered = ''; const selections: ModelSelection[] = [];
  const decisions = new MaestroDecisionProvider({ complete: async ({ input }) => {
    const parsed = JSON.parse(input);
    if (parsed.projectIntelligence) {
      synthesis = input;
      return JSON.stringify({ type: 'respond', message: 'Final independent recommendation', basis: 'conversation', evidenceRefs: [] });
    }
    return JSON.stringify({ type: 'delegate_text', independence: 'Each evaluates supplied context without sibling output.',
      assignments: parsed.availableMediobots.filter((d: { name: string }) => ['Cody', 'Research', 'Tester'].includes(d.name)).slice(0, count)
        .map((d: { definitionId: string }) => ({ definitionId: d.definitionId, objective: 'Analyze assigned perspective', relevantContext: 'Jobs must be rate limited.', relevantContextRefs: [], constraints: ['Text only'], expectedOutcome: 'Recommendation', evidenceExpectations: ['Supplied constraints'] })) });
  } });
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world), maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate' },
    maestroDecisions: decisions, codyDecisions: new CodyDecisionProvider({ complete: async () => { throw new Error('No coding tools allowed'); } }),
    onUserMessage: message => { delivered = message; },
    textModelResolver: { resolveForOperation(operation, selection) {
      assert.equal(operation, 'text-inference'); assert.ok(selection); selections.push(selection);
      if (mode === 'unavailable' && selections.length === 1) throw new Error('Unavailable');
      return { descriptor: { providerId: selection.providerConnectionId, modelId: selection.modelId }, client: { complete: async ({ input, signal }) => {
        assert.equal(JSON.parse(input).assignment.objective, 'Analyze assigned perspective');
        assert.equal(input.includes('PARENT GOAL'), false);
        const index = ++calls;
        if (calls === (mode === 'unavailable' ? count - 1 : count)) entered.resolve();
        await release.promise;
        signal.throwIfAborted();
        if (mode === 'invalid-report' && index === 1) return JSON.stringify({ ...JSON.parse(body), reasoning: 'Private content must not reach Maestro' });
        if (mode === 'failure' && index === 1) throw new Error('Provider failed');
        if (mode === 'blocked' && index === 1) return body.replace('"completed"', '"blocked"');
        return body;
      } } };
    } } });
  const submission = new RuntimeTaskSubmission(world, runtime); submission.registerAdapter(execution.maestroDefinitionId, execution.adapter);
  return { world, runtime, execution, submission, entered, release, notices, selections,
    get synthesis() { return synthesis; }, get delivered() { return delivered; } };
}
for (const mode of ['normal', 'failure', 'cancel', 'unavailable', 'blocked', 'admission', 'parent-cancel', 'invalid-report'] as const) {
  test(`general text workers: ${mode}`, { timeout: 5000 }, async t => {
    const f = fixture(mode);
    const defs = f.world.inspect().definitions.filter(d => ['coding', 'research', 'tester'].includes(d.role));
    const submitted = f.submission.submit({ definitionId: f.execution.maestroDefinitionId, goal: 'PARENT GOAL', options: {
      workspaceRoot: process.cwd(), modelSelection: { providerConnectionId: 'a', modelId: 'same' },
      assignmentModelSelections: { [defs[1]!.id]: { providerConnectionId: 'b', modelId: 'same' } },
    } });
    if (mode !== 'admission') {
      await f.entered.promise;
      assert.equal(f.world.inspect().tasks.filter(t => t.state === 'running').length, mode === 'unavailable' ? 3 : 4);
      if (mode === 'cancel') f.runtime.cancel(f.world.inspect().tasks.find(t => t.parentTaskId === submitted.task.id)!.id);
      if (mode === 'parent-cancel') f.runtime.cancel(submitted.task.id);
      f.release.resolve();
    }
    const result = await submitted.result;
    assert.equal(result.state, mode === 'parent-cancel' ? 'cancelled' : 'completed');
    const snapshot = f.world.inspect();
    const reports = snapshot.evidence.filter(e => e.source.type === 'worker-report').map(e => JSON.parse(e.content) as WorkerReport);
    assert.equal(reports.length, 3);
    assert.equal(snapshot.goals[0]!.status === 'satisfied', false);
    for (const r of reports) {
      assert.equal(snapshot.assignments.find(a => a.id === r.assignmentId)!.targetDefinitionId, r.mediobotId);
      assert.equal(snapshot.tasks.find(t => t.id === r.taskId)!.assignedWorkerId, r.workerId);
      assert.deepEqual(r.artifacts, []);
    }
    if (mode === 'normal') {
      assert.equal(reports.every(r => r.status === 'completed'), true);
      const overlapMs = Math.min(...reports.map(r => r.completedAt!)) - Math.max(...reports.map(r => r.startedAt!));
      assert.ok(overlapMs > 0);
      t.diagnostic(JSON.stringify({ category: 'deterministic-adapter-only', overlappingWorkers: 3, overlapMs }));
      assert.deepEqual(f.selections.map(s => s.providerConnectionId), ['a', 'b', 'a']);
      assert.equal(f.selections.every(s => s.modelId === 'same'), true);
    } else if (mode === 'parent-cancel') {
      assert.equal(reports.every(r => r.status === 'cancelled'), true); assert.equal(f.delivered, '');
    } else if (mode === 'admission') assert.equal(reports.every(r => r.status === 'blocked'), true);
    else {
      const expected = mode === 'failure' || mode === 'invalid-report' ? 'failed' : mode === 'cancel' ? 'cancelled' : mode === 'unavailable' ? 'model-unavailable' : 'blocked';
      assert.equal(reports.filter(r => r.status === expected).length, 1);
      assert.equal(reports.filter(r => r.status === 'completed').length, 2);
      assert.ok(f.synthesis.includes(expected));
      assert.equal(f.synthesis.includes('Private content'), false);
    }
    if (mode !== 'parent-cancel') {
      assert.equal(f.delivered, 'Final independent recommendation');
      if (mode === 'admission') assert.ok(f.synthesis.includes('blocked'));
      else {
        assert.ok(f.synthesis.includes('specialist-result') || f.synthesis.includes('bounded-worker-reports'));
        assert.ok(f.synthesis.includes('Bounded conclusion') || f.synthesis.includes('supervision'));
      }
    }
    assert.equal(snapshot.events.some(e => /vision|browser/i.test(e.type)), false);
    assert.equal(snapshot.resources.length, 0);
    assert.equal(snapshot.tasks.some(t => t.state === 'assigned' || t.state === 'running'), false);
  });
}
test('single text assignment retains identity and synthesis', { timeout: 5000 }, async () => {
  const f = fixture('normal', 1);
  const submitted = f.submission.submit({ definitionId: f.execution.maestroDefinitionId, goal: 'A bounded task', options: { workspaceRoot: process.cwd(), modelSelection: { providerConnectionId: 'a', modelId: 'm' } } });
  await f.entered.promise; f.release.resolve(); assert.equal((await submitted.result).state, 'completed');
  assert.equal(f.world.inspect().assignments.length, 1);
});
test('direct turn creates zero execution identities with general workers enabled', async () => {
  const f = fixture();
  const direct = new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: 'respond', message: 'Hello', basis: 'conversation', evidenceRefs: [] }) });
  const result = await direct.decide('Hi', {}, new AbortController().signal);
  assert.equal(result.type, 'respond');
  const s = f.world.inspect();
  for (const entries of [s.goals, s.assignments, s.tasks, s.workers, s.evidence]) assert.equal(entries.length, 0);
});
test('text assignment contract rejects dependencies encoded as unknown fields and unavailable targets', () => {
  const assignment = { definitionId: 'cody', objective: 'Analyze', relevantContext: 'Context', relevantContextRefs: [], constraints: [], expectedOutcome: 'Advice', evidenceExpectations: [] };
  assert.throws(() => validateMaestroDecision({ type: 'delegate_text', independence: 'Independent', assignments: [{ ...assignment, dependsOn: 'research' }] }, { assignableDefinitionIds: ['cody'] }));
  assert.throws(() => validateMaestroDecision({ type: 'delegate_text', independence: 'Independent', assignments: [assignment] }, { assignableDefinitionIds: ['tester'] }));
});

test('manual pair validation never treats malformed explicit selections as Auto', () => {
  for (const value of [null, '', 'bad JSON', {}, { providerConnectionId: 'a' }, { providerConnectionId: '', modelId: 'm' }]) assert.throws(() => readModelSelection(value));
  assert.deepEqual(readModelSelection({ providerConnectionId: 'a', modelId: 'm' }), { providerConnectionId: 'a', modelId: 'm' });
  assert.deepEqual(readModelSelection({ providerConnectionId: 'a', modelId: 'm', reasoningEffort: 'high' }), { providerConnectionId: 'a', modelId: 'm', reasoningEffort: 'high' });
  assert.deepEqual(readModelSelection({ providerConnectionId: 'a', modelId: 'm', effort: 'medium' }), { providerConnectionId: 'a', modelId: 'm', reasoningEffort: 'medium' });
  assert.deepEqual(readModelSelection({ providerConnectionId: 'a', modelId: 'm', reasoningEffort: 'invalid-effort' }), { providerConnectionId: 'a', modelId: 'm' });
});

test('per-specialist reasoningEffort is passed to model execution and client request', async () => {
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  let capturedEffort: string | undefined;
  const decisions = new MaestroDecisionProvider({ complete: async ({ input }) => {
    const parsed = JSON.parse(input);
    if (parsed.projectIntelligence) {
      return JSON.stringify({ type: 'respond', message: 'Done', basis: 'conversation', evidenceRefs: [] });
    }
    return JSON.stringify({
      type: 'delegate_text',
      independence: 'Independent',
      assignments: [{
        definitionId: 'research',
        objective: 'Analyze context',
        relevantContext: 'Some context',
        relevantContextRefs: [],
        constraints: [],
        expectedOutcome: 'Analysis',
        evidenceExpectations: [],
      }],
    });
  } });

  const execution = createMaestroCodyExecution({
    world,
    runtime,
    tools: new ToolRuntime(world),
    maestroDefinition: { id: 'maestro', name: 'Maestro', role: 'orchestration', version: '1', instructions: 'Coordinate' },
    maestroDecisions: decisions,
    codyDecisions: new CodyDecisionProvider({ complete: async () => { throw new Error('Unused'); } }),
    onUserMessage: () => {},
    textModelResolver: {
      resolveForOperation(op, selection) {
        assert.equal(selection?.providerConnectionId, 'conn-1');
        assert.equal(selection?.modelId, 'model-1');
        assert.equal(selection?.reasoningEffort, 'high');
        return {
          descriptor: { providerId: 'conn-1', modelId: 'model-1' },
          client: {
            complete: async (req) => {
              capturedEffort = req.reasoningEffort;
              return body;
            },
          },
        };
      },
    },
  });

  const submission = new RuntimeTaskSubmission(world, runtime);
  submission.registerAdapter(execution.maestroDefinitionId, execution.adapter);
  const submitted = submission.submit({
    definitionId: execution.maestroDefinitionId,
    goal: 'Test goal',
    options: {
      workspaceRoot: process.cwd(),
      assignmentModelSelections: {
        research: { providerConnectionId: 'conn-1', modelId: 'model-1', reasoningEffort: 'high' },
      },
    },
  });

  const result = await submitted.result;
  assert.equal(result.state, 'completed');
  assert.equal(capturedEffort, 'high');
});

test('group publication is required only when the specialist assignment explicitly asks for a finding', () => {
  assert.equal(requiresGroupFinding({ objective: 'Publish a group finding with the retrieved API guidance.', expectedOutcome: 'Cite the group finding', constraints: [] }), true);
  assert.equal(requiresGroupFinding({ objective: 'Research the API and share a private finding with Cody.', expectedOutcome: 'Answer Cody', constraints: [] }), false);
  assert.equal(requiresGroupFinding({ objective: 'Analyze the supplied behavior.', expectedOutcome: 'A concise report', constraints: [] }), false);
});

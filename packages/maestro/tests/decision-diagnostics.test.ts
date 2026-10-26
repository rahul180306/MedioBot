import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelProviderError } from '@mediobot-v2/models';
import { MaestroDecisionProvider, validateMaestroDecision, type MaestroDecisionDiagnostic } from '../src/index.ts';
const signal = () => new AbortController().signal;
const assignment = (definitionId: string) => ({ definitionId, objective: 'Independent assessment', relevantContext: 'Supplied facts',
  relevantContextRefs: [], constraints: [], expectedOutcome: 'Bounded conclusion', evidenceExpectations: [] });
const specialists = ['specialist-1', 'specialist-2', 'specialist-3'];
const context = { availableIntents: ['respond', 'delegate_text'] as const, assignableDefinitionIds: specialists,
  availableMediobots: specialists.map(definitionId => ({ definitionId, name: 'Specialist', role: 'review', description: 'Independent review of supplied facts.', assignable: true, capabilities: ['text-inference'] })) };

test('diagnostics preserve valid text delegation intent and do not impose a worker count', async () => {
  for (const count of [1, 2, 3]) {
    const diagnostics: MaestroDecisionDiagnostic[] = [];
    const decision = { type: 'delegate_text', independence: 'Independent perspectives', assignments: specialists.slice(0, count).map((id, index) => ({
      ...assignment(id), assignmentId: `assignment-${index + 1}`,
    })) };
    const provider = new MaestroDecisionProvider({ complete: async () => JSON.stringify(decision) }, d => diagnostics.push(d));
    const result = await provider.decide('Private user objective', context, signal());
    assert.deepEqual(result, decision);
    assert.equal(diagnostics[0]!.describedAssignableCount, specialists.length);
    assert.equal(diagnostics[0]!.textDelegationAvailable, true);
    assert.equal(diagnostics[1]!.observedIntent, 'delegate_text');
    assert.equal(diagnostics[1]!.intent, 'delegate_text');
    assert.equal(diagnostics[1]!.assignmentCount, count);
    assert.equal(diagnostics[1]!.attempt, 1);
    assert.equal(JSON.stringify(diagnostics).includes('Private user objective'), false);
  }
});

test('normalizes a single-assignment delegate_text response and retains required capabilities inside its assignment', () => {
  const parsed = validateMaestroDecision({ type: 'delegate_text', definitionId: 'specialist-1',
    objective: 'Check the official Python math.isqrt documentation', relevantContextRefs: [], constraints: [],
    expectedOutcome: 'A source-backed summary', evidenceExpectations: ['Cite the official docs'],
    requiredCapabilities: ['web.search', 'web.crawl'] }, { ...context, availableIntents: ['delegate_text'] });
  assert.equal(parsed.type, 'delegate_text');
  if (parsed.type !== 'delegate_text') throw new Error('Expected bounded text delegation');
  assert.equal(parsed.assignments.length, 1);
  assert.equal(parsed.assignments[0]!.definitionId, 'specialist-1');
  assert.equal(parsed.assignments[0]!.objective, 'Check the official Python math.isqrt documentation');
  assert.deepEqual(parsed.assignments[0]!.requiredCapabilities, ['web.search', 'web.crawl']);
});

test('repairs are observable without replaying or logging rejected payloads', async () => {
  const diagnostics: MaestroDecisionDiagnostic[] = [];
  const validRepair = { type: 'delegate_text', independence: 'Independent perspectives', assignments: [assignment('specialist-1')] };
  const outputs = [JSON.stringify({ ...validRepair, secretField: 'private rejected content' }), JSON.stringify(validRepair)];
  const provider = new MaestroDecisionProvider({ complete: async ({ system }) => {
    assert.equal(system.includes('private rejected content'), false);
    return outputs.shift()!;
  } }, d => diagnostics.push(d));
  assert.equal((await provider.decide('Goal', context, signal())).type, 'delegate_text');
  assert.deepEqual(diagnostics.map(d => d.stage), ['context', 'rejected', 'validated']);
  assert.equal(diagnostics[1]!.observedIntent, 'delegate_text');
  assert.equal(diagnostics[1]!.reason, 'schema-mismatch');
  assert.deepEqual(diagnostics[1]!.recognizedKeys, ['type', 'independence', 'assignments']);
  assert.equal(diagnostics[2]!.observedIntent, 'delegate_text');
  assert.equal(diagnostics[2]!.attempt, 2);
  assert.equal(new Set(diagnostics.map(d => d.callId)).size, 1);
  assert.equal(JSON.stringify(diagnostics).includes('private rejected content'), false);
});
test('unknown intent and model errors expose only fixed diagnostic vocabulary', async () => {
  const diagnostics: MaestroDecisionDiagnostic[] = [];
  const provider = new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: 'private-unknown-value' }) }, d => diagnostics.push(d));
  await assert.rejects(provider.decide('Goal', context, signal()));
  assert.equal(diagnostics[1]!.observedIntent, 'unknown');
  const failing = new MaestroDecisionProvider({ complete: async () => { throw new Error('private transport detail'); } }, d => diagnostics.push(d));
  await assert.rejects(failing.decide('Goal', context, signal()));
  assert.equal(diagnostics.at(-1)!.stage, 'model-failed');
  assert.equal(JSON.stringify(diagnostics).includes('private'), false);
});
test('diagnostic observer failure cannot change semantic decisions', async () => {
  const provider = new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: 'respond', message: 'Hello', basis: 'conversation', evidenceRefs: [] }) }, () => { throw new Error('Observer failed'); });
  assert.equal((await provider.decide('Hi', context, signal())).type, 'respond');
});

test('diagnostics retain safe transport phase and timing for failed or rejected model responses', async () => {
  const diagnostics: MaestroDecisionDiagnostic[] = [];
  let calls = 0;
  const malformed = { type: 'delegate_text', independence: 'Independent', assignments: [assignment('specialist-1')], extra: 'private' };
  const provider = new MaestroDecisionProvider({
    complete: async () => calls++ === 0 ? JSON.stringify(malformed)
      : JSON.stringify({ type: 'delegate_text', independence: 'Independent', assignments: [assignment('specialist-1')] }),
    metrics: () => ({ durationMs: 118_200, ttfbMs: 112_800, ttftMs: 113_100 }),
  }, value => diagnostics.push(value));
  await provider.decide('Goal', context, signal());
  assert.equal(diagnostics[1]!.modelDurationMs, 118_200);
  assert.equal(diagnostics[1]!.ttfbMs, 112_800);
  assert.equal(diagnostics[1]!.ttftMs, 113_100);
  assert.equal(JSON.stringify(diagnostics).includes('private'), false);

  const failed = new MaestroDecisionProvider({ complete: async () => {
    throw new ModelProviderError('timeout', 'safe timeout', { phase: 'headers', elapsedMs: 180_000, timeoutMs: 180_000 });
  } }, value => diagnostics.push(value));
  await assert.rejects(failed.decide('Goal', context, signal()));
  assert.deepEqual(diagnostics.at(-1)!.transportFailure, {
    code: 'timeout', phase: 'headers', elapsedMs: 180_000, timeoutMs: 180_000,
  });
});

test('Maestro retries one timed-out reasoning request before any delegation or synthesis side effect', async () => {
  const diagnostics: MaestroDecisionDiagnostic[] = [];
  let calls = 0;
  const expected = { type: 'respond', message: 'Complete result', basis: 'conversation', evidenceRefs: [] } as const;
  const provider = new MaestroDecisionProvider({ complete: async () => {
    calls++;
    if (calls === 1) throw new ModelProviderError('timeout', 'safe timeout', { phase: 'body', elapsedMs: 180_000, timeoutMs: 180_000 });
    return JSON.stringify(expected);
  } }, value => diagnostics.push(value));
  assert.deepEqual(await provider.decide('Goal', { availableIntents: ['respond'] }, signal()), expected);
  assert.equal(calls, 2);
  assert.equal(diagnostics.some(diagnostic => diagnostic.transportRetry), true);
  assert.equal(diagnostics.at(-1)?.stage, 'validated');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalDatabase } from '../../src/storage/db.ts';
import { ProviderRepository } from '../../src/storage/providerRepository.ts';
import { ModelResolver, PROVIDER_CATALOG } from '../../src/runtime/modelRegistry.ts';
import { SqliteDurableTaskStore } from '../../src/storage/durableTaskStore.ts';
import { createComposition } from '../../src/composition.ts';
import type { WorkerReport } from '@mediobot-v2/maestro';
import { DurableTaskEngine } from '@mediobot-v2/runtime';

for (const incompatible of [false, true]) test(`registry-backed text composition, incompatible=${incompatible}`, { timeout: 5000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediobot-parallel-'));
  const db = new LocalDatabase(path.join(root, 'mediobot.db'));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const repo = new ProviderRepository(db.raw);
  const gemma = PROVIDER_CATALOG.find(p => p.id === 'nvidia')!.defaultModels[0]!;
  repo.save({ id: 'first', providerType: 'custom', displayName: 'Same display name', baseUrl: 'http://unused.invalid', connected: true, enabled: true,
    models: [{ id: 'text', name: 'Duplicate', enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }] });
  repo.save({ id: 'second', providerType: 'custom', displayName: 'Same display name', baseUrl: 'http://unused.invalid', connected: true, enabled: true,
    models: [{ ...gemma, name: 'Duplicate', enabled: true, capabilities: { ...gemma.capabilities!, text: !incompatible } }] });
  let count = 0; let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const calls: string[] = [];
  const resolver = new ModelResolver(repo, { createClient: options => ({ complete: async ({ input, images }) => {
    assert.equal(images, undefined);
    const value = JSON.parse(input);
    if (value.assignment) {
      calls.push(options.modelId); count++;
      if (count === (incompatible ? 2 : 3)) release();
      await barrier;
      return JSON.stringify({ status: 'completed', summary: 'Conclusion', evidence: ['Supplied constraints'], blockers: [], unresolved: [] });
    }
    if (value.projectIntelligence) {
      assert.ok(input.includes('bounded-worker-reports'));
      return JSON.stringify({ type: 'respond', message: 'Synthesis of the available reports.', basis: 'conversation', evidenceRefs: [] });
    }
    if (value.userGoal === 'Hi') return JSON.stringify({ type: 'respond', message: 'Hello', basis: 'conversation', evidenceRefs: [] });
    return JSON.stringify({ type: 'delegate_text', independence: 'Independent perspectives from supplied context.',
      assignments: value.availableMediobots.filter((d: { role: string }) => ['coding', 'research', 'tester'].includes(d.role)).map((d: { definitionId: string }) => ({
        definitionId: d.definitionId, objective: 'Analyze perspective', relevantContext: 'Queue processes at most two jobs.', relevantContextRefs: [], constraints: ['Text only'], expectedOutcome: 'Recommendation', evidenceExpectations: [] })) });
  } }) });
  const durableEngine = new DurableTaskEngine(new SqliteDurableTaskStore(db.raw));
  const composition = createComposition({ modelResolver: resolver, durableTaskEngine: durableEngine });
  t.after(() => composition.shutdown?.());
  const research = composition.world.inspect().definitions.find(d => d.role === 'research')!;
  const opts = { workspaceRoot: root, modelSelection: { providerConnectionId: 'first', modelId: 'text' },
    assignmentModelSelections: { [research.id]: { providerConnectionId: 'second', modelId: gemma.id } } };
  assert.equal((await composition.decideMaestroTurn!('Hi', opts, new AbortController().signal)).type, 'respond');
  assert.equal(composition.world.inspect().workers.length, 0);
  const decision = await composition.decideMaestroTurn!('Evaluate queue', opts, new AbortController().signal);
  const submitted = composition.submit(composition.maestroDefinitionId!, 'Evaluate queue', { ...opts, maestroDecision: decision });
  assert.equal((await submitted.result).state, 'completed');
  const s = composition.world.inspect();
  const reports = s.evidence.filter(e => e.source.type === 'worker-report').map(e => JSON.parse(e.content) as WorkerReport);
  assert.equal(reports.length, 3);
  assert.equal(reports.find(r => r.mediobotId === research.id)!.providerId, 'second');
  assert.equal(reports.find(r => r.mediobotId === research.id)!.status, incompatible ? 'model-unavailable' : 'completed');
  const delegations = await durableEngine.getDelegations(submitted.taskId);
  const researchTaskId = delegations.find(entry => entry.assignedMediobotId === research.id)?.childTaskId;
  assert.ok(researchTaskId);
  assert.deepEqual(await durableEngine.getTaskModelSelection(researchTaskId),
    { providerConnectionId: 'second', modelId: gemma.id }, 'the durable Research child must retain its exact assignment model');
  for (const delegation of delegations.filter(entry => entry.assignedMediobotId !== research.id && entry.childTaskId)) {
    assert.deepEqual(await durableEngine.getTaskModelSelection(delegation.childTaskId!),
      { providerConnectionId: 'first', modelId: 'text' }, 'other durable specialist children must retain the parent-selected model');
  }
  assert.equal(calls.filter(id => id === gemma.id).length, incompatible ? 0 : 1);
  assert.equal(calls.filter(id => id === 'text').length, 2);
  assert.equal(s.resources.length, 0);
  assert.equal(s.workers.some(w => w.definitionId === composition.visionDefinitionId), false);
  assert.equal(s.evidence.some(e => e.source.type === 'maestro-response'), true);
});


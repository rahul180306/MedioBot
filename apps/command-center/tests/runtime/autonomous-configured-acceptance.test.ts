import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Writable } from 'node:stream';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { startCommandCenter } from '../../src/server.ts';
import { ProviderRepository } from '../../src/storage/providerRepository.ts';
import { ModelResolver, ModelProviderError } from '../../src/runtime/modelRegistry.ts';
import { assertNonProductionDatabase, getProductionDatabasePath } from '../../src/storage/appPaths.ts';
import type { MaestroDecision, WorkerReport } from '@mediobot-v2/maestro';

// Acceptance-only goal. No assignments or expected team shape enter the HTTP request.
const goal = 'Design a small in-memory rate-limited job queue for one Node.js process. It must allow at most five job starts in any rolling one-second window and at most two jobs executing concurrently. Design a correct implementation and explain the important tradeoffs and failure cases. Have your team help where useful, but you own the final answer. Text only—do not modify files, run commands, browse the web, or claim anything was tested unless it actually was.';
class ResponseCapture extends Writable {
  statusCode = 200; output = '';
  writeHead(status: number) { this.statusCode = status; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { this.output += chunk.toString(); callback(); }
}
test('real natural-language /api/turns Maestro decision and execution', {
  skip: process.env.MEDIOBOT_LIVE_AUTONOMOUS !== '1' ? 'live-opt-in-required' : false, timeout: 180_000,
}, async t => {
  const store = process.env.MEDIOBOT_DATA_DIR?.trim()
    ? path.join(path.resolve(process.env.MEDIOBOT_DATA_DIR.trim()), 'mediobot.db') : getProductionDatabasePath();
  assertNonProductionDatabase(store); assert.ok(existsSync(store), 'Existing Settings store required.');
  if (existsSync(`${store}-wal`) || existsSync(`${store}-shm`)) {
    t.diagnostic('Configured Settings store has active SQLite WAL sidecars; immutable acceptance reads are skipped to avoid a stale snapshot.');
    t.skip('configured-provider-store-active-wal');
    return;
  }
  // Immutable read-only mode avoids SQLite attempting to create -shm in a protected app-data directory.
  const config = new DatabaseSync(`${pathToFileURL(store).href}?immutable=1`, { readOnly: true });
  const repo = new ProviderRepository(config);
  const resolver = new ModelResolver(repo);
  const selection = { providerConnectionId: 'nvidia', modelId: 'google/diffusiongemma-26b-a4b-it' };
  resolver.resolveForOperation('text-inference', selection);
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'mediobot-live-autonomous-'));
  // Application transcript writes are isolated; provider configuration is the normal read-only store.
  const app = await startCommandCenter({ databasePath: path.join(temporary, 'mediobot.db'), providerRepository: repo,
    modelResolver: resolver, workspaceRoot: temporary, vite: false, listen: false });
  t.after(async () => { await app.close(); config.close(); rmSync(temporary, { recursive: true, force: true }); });
  let decision: MaestroDecision | undefined;
  let failure: string | undefined;
  const originalDecide = app.composition.decideMaestroTurn!.bind(app.composition);
  app.composition.decideMaestroTurn = async (...args) => {
    try { decision = await originalDecide(...args); }
    catch (error) { failure = error instanceof ModelProviderError ? error.code : 'decision-failure'; throw error; }
    // Safety gate only: reject a tool-operation choice; never replace its decision or force delegation.
    if (!['respond', 'request_user_input', 'delegate_text'].includes(decision.type)) throw new Error('Non-text intent is outside this acceptance scope.');
    return decision;
  };
  const res = new ResponseCapture();
  const finished = new Promise<void>(resolve => res.once('finish', resolve));
  const req = Object.assign(Readable.from([JSON.stringify({ threadId: 'autonomous-acceptance', turnId: 'natural-goal',
    prompt: goal, modelSelection: selection, definitionId: 'definition-maestro' })]), { method: 'POST', url: '/api/turns', headers: {} });
  app.handle(req as never, res as never); await finished;
  if (failure) {
    t.diagnostic(JSON.stringify({ stage: 'maestro-semantic-decision', providerConnectionId: selection.providerConnectionId, modelId: selection.modelId, category: failure }));
    if (['transport', 'timeout', 'authentication', 'capacity', 'configuration'].includes(failure)) { t.skip('provider-unavailable:run-normal-product-locally'); return; }
    assert.fail('Maestro decision failed; see safe category.');
  }
  assert.ok(decision, 'A real semantic decision is required.');
  const names = new Map(app.composition.world.inspect().definitions.map(d => [String(d.id), d.name]));
  t.diagnostic(JSON.stringify({ decision: decision.type, ...(decision.type === 'delegate_text' ? { independence: decision.independence,
    assignments: decision.assignments.map(a => ({ mediobot: names.get(a.definitionId), objective: a.objective, expectedOutcome: a.expectedOutcome })) } : {}) }));
  assert.ok(res.statusCode === 200 || res.statusCode === 202, 'Normal turn rejected.');
  if (decision.type === 'respond' || decision.type === 'request_user_input') {
    const snapshot = app.composition.world.inspect();
    assert.ok([snapshot.goals, snapshot.tasks, snapshot.workers, snapshot.assignments].every(a => a.length === 0));
    t.diagnostic('Model chose no delegation. Direct decision is valid; autonomous multi-assignment execution remains unproved.'); return;
  }
  assert.ok(decision.type === 'delegate_text', 'Only text delegation may execute.');
  const taskId = JSON.parse(res.output).taskId;
  if (!['completed', 'failed', 'cancelled'].includes(app.composition.snapshotTask(taskId)!.state)) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { app.composition.cancel(taskId); reject(new Error('Acceptance deadline reached.')); }, 100_000);
      app.composition.subscribers.get(taskId)!.add(event => {
        if (['task.completed', 'task.failed', 'task.cancelled'].includes(event.type)) { clearTimeout(timeout); resolve(); }
      });
    });
  }
  const snapshot = app.composition.world.inspect();
  const reports = snapshot.evidence.filter(e => e.source.type === 'worker-report').map(e => JSON.parse(e.content) as WorkerReport);
  assert.ok(reports.length === decision.assignments.length, 'Every selected assignment must have an attributed report.');
  for (const r of reports) {
    t.diagnostic(JSON.stringify({ mediobot: names.get(r.mediobotId), assignmentId: r.assignmentId, workerId: r.workerId,
      providerConnectionId: r.providerId, modelId: r.modelId, startedAt: r.startedAt, completedAt: r.completedAt, status: r.status }));
    assert.ok(r.providerId === selection.providerConnectionId && r.modelId === selection.modelId, 'Manual pair changed.');
    assert.ok(snapshot.assignments.find(a => a.id === r.assignmentId)?.targetDefinitionId === r.mediobotId, 'Attribution mismatch.');
    assert.ok(r.status === 'completed', 'Specialist did not complete; inspect status.');
  }
  const commonIntervalMs = Math.min(...reports.map(r => r.completedAt!)) - Math.max(...reports.map(r => r.startedAt!));
  t.diagnostic(JSON.stringify({ workers: reports.length, commonIntervalMs, parallel: reports.length > 1 && commonIntervalMs > 0 }));
  if (reports.length > 1) assert.ok(commonIntervalMs > 0, 'Independent worker calls did not overlap.');
  assert.ok(snapshot.resources.length === 0 && snapshot.workers.every(w => w.definitionId !== app.composition.visionDefinitionId));
  assert.ok(snapshot.goals.every(g => g.status !== 'satisfied'), 'Worker completion is not Goal satisfaction.');
  const thread = await app.history.get('autonomous-acceptance');
  const turn = thread!.turns[0]!;
  assert.ok(turn.status === 'completed' && turn.items.some(item => item.type === 'agent_message'), 'Synthesis/transcript missing.');
  t.diagnostic(JSON.stringify({ synthesis: turn.items.filter(item => item.type === 'agent_message').map(item => item.text),
    status: reports.length > 1 ? 'BACKEND AUTONOMOUS DECOMPOSITION PROVEN; human UI acceptance pending' : 'Single autonomous assignment executed; parallel decomposition not selected' }));
});

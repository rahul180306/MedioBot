import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCommandCenter } from '../../src/server.ts';
import { LocalDatabase } from '../../src/storage/db.ts';
import { ProviderRepository } from '../../src/storage/providerRepository.ts';
import { ModelResolver } from '../../src/runtime/modelRegistry.ts';

class ResponseCapture extends Writable {
  statusCode = 200;
  output = '';
  writeHead(status: number) { this.statusCode = status; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { this.output += chunk.toString(); callback(); }
}

async function request(app: Awaited<ReturnType<typeof startCommandCenter>>, method: string, url: string, body?: unknown) {
  const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method, url, headers: {} });
  const res = new ResponseCapture();
  const finished = new Promise<void>(resolve => res.once('finish', resolve));
  app.handle(req as never, res as never);
  await finished;
  return { status: res.statusCode, output: res.output,
    json: res.output && !url.includes('/events') ? JSON.parse(res.output) : undefined };
}

test('Maestro decision failure persists a safe reason and replays it with the terminal event', { timeout: 10_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediobot-decision-failure-sync-'));
  const dbPath = path.join(root, 'mediobot.db');
  const database = new LocalDatabase(dbPath);
  const repo = new ProviderRepository(database.raw);
  repo.save({ id: 'local-provider', providerType: 'custom', displayName: 'Local test provider', connected: true, enabled: true,
    baseUrl: 'http://unused.invalid', models: [{ id: 'test-model', name: 'Test model', enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: false } }] });
  let decisionCalls = 0;
  const resolver = new ModelResolver(repo, { createClient: () => ({ complete: async ({ system, input }: { system: string; input: string }) => {
    if (system.includes('MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER')) return JSON.stringify({ requiresCurrentProjectEvidence: false });
    decisionCalls++;
    if (JSON.parse(input).userGoal === 'Trigger a semantic delegation rejection.') return JSON.stringify({ type: 'delegate',
      definitionId: 'not-authorized', objective: 'Attempt a rejected assignment.', relevantContextRefs: [], constraints: [],
      expectedOutcome: 'No work should start.', evidenceExpectations: [] });
    return JSON.stringify({ type: 'unsupported-test-intent', privateRejectedModelOutput: 'must not be persisted' });
  } }) });
  const app = await startCommandCenter({ databasePath: dbPath, providerRepository: repo, modelResolver: resolver,
    workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });

  const threadId = 'decision-failure-thread';
  const turnId = 'decision-failure-turn';
  const selection = { providerConnectionId: 'local-provider', modelId: 'test-model' };
  const submitted = await request(app, 'POST', '/api/turns', { threadId, turnId, prompt: 'Inspect the project and report verified findings.', modelSelection: selection });
  assert.equal(submitted.status, 502);
  assert.equal(submitted.json.error.code, 'invalid-maestro-decision');
  assert.ok(decisionCalls >= 1);

  const saved = await request(app, 'GET', `/api/threads/${threadId}`);
  const turn = saved.json.thread.turns.find((entry: { id: string }) => entry.id === turnId);
  assert.equal(turn.status, 'failed');
  const failureItem = turn.items.find((item: { actor?: { type?: string }; type: string }) => item.type === 'agent_message' && item.actor?.type === 'system');
  assert.match(failureItem.text, /supported execution format; no specialist work started/);
  assert.deepEqual(failureItem.failure, { stage: 'maestro-decision', category: 'structural', reason: 'unsupported-intent',
    providerId: 'local-provider', modelId: 'test-model' });
  assert.equal(JSON.stringify(turn).includes('privateRejectedModelOutput'), false);
  assert.equal(turn.taskId, undefined);
  assert.equal(turn.items.some((item: { type: string }) => item.type === 'tool_execution'), false);

  const stream = await request(app, 'GET', `/api/turns/${turnId}/events?threadId=${threadId}`);
  const events = stream.output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const failed = events.find((event: { type: string }) => event.type === 'turn.failed');
  assert.equal(failed.payload.item.failure.reason, 'unsupported-intent');
  assert.equal(failed.payload.summary, failureItem.text);

  const semantic = await request(app, 'POST', '/api/turns', { threadId, turnId: 'semantic-failure-turn',
    prompt: 'Trigger a semantic delegation rejection.', modelSelection: selection });
  assert.equal(semantic.status, 502);
  const semanticThread = await request(app, 'GET', `/api/threads/${threadId}`);
  const semanticTurn = semanticThread.json.thread.turns.find((entry: { id: string }) => entry.id === 'semantic-failure-turn');
  const semanticItem = semanticTurn.items.find((item: { actor?: { type?: string }; type: string }) => item.type === 'agent_message' && item.actor?.type === 'system');
  assert.match(semanticItem.text, /semantic validation; no specialist work started/);
  assert.equal(semanticItem.failure.reason, 'unknown-delegation');
  assert.equal(semanticItem.failure.category, 'semantic');
});

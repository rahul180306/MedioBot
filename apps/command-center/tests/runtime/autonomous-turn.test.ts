import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCommandCenter } from '../../src/server.ts';
import { LocalDatabase } from '../../src/storage/db.ts';
import { ProviderRepository } from '../../src/storage/providerRepository.ts';
import { ModelResolver } from '../../src/runtime/modelRegistry.ts';
import type { WorkerReport } from '@mediobot-v2/maestro';

class ResponseCapture extends Writable {
  statusCode = 200;
  output = '';
  onChunk?: () => void;
  writeHead(status: number) { this.statusCode = status; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { this.output += chunk.toString(); this.onChunk?.(); callback(); }
}
async function request(app: Awaited<ReturnType<typeof startCommandCenter>>, method: string, url: string, body?: unknown) {
  const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method, url, headers: {} });
  const res = new ResponseCapture();
  const finished = new Promise<void>(resolve => res.once('finish', resolve));
  app.handle(req as never, res as never); await finished;
  return { status: res.statusCode, json: JSON.parse(res.output) };
}
async function turnEvents(app: Awaited<ReturnType<typeof startCommandCenter>>, threadId: string, turnId: string) {
  const req = Object.assign(Readable.from([]), { method: 'GET', url: `/api/turns/${turnId}/events?threadId=${threadId}`, headers: {} });
  const res = new ResponseCapture();
  const terminal = new Promise<void>(resolve => { res.onChunk = () => {
    if (res.output.includes('"type":"task.completed"')
      || res.output.includes('"type":"turn.snapshot"') && res.output.includes('"status":"completed"')) resolve();
  }; });
  app.handle(req as never, res as never); await terminal; res.emit('close');
  return res.output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

for (const scenario of [
  { count: 2, failed: false },
  { count: 3, failed: false },
  { count: 2, failed: true },
  // Text-only control: these role-labeled assignments analyze supplied context and do not request retrieval or test execution.
  { count: 3, failed: false, roles: ['doc', 'research', 'tester'] },
]) {
  test(`normal /api/turns model decision → ${scenario.count} workers → persisted transcript; failed=${scenario.failed}`, { timeout: 5000 }, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mediobot-autonomous-turn-'));
    const dbPath = path.join(root, 'mediobot.db');
    const database = new LocalDatabase(dbPath);
    const repo = new ProviderRepository(database.raw);
    repo.save({ id: 'selected-provider', providerType: 'custom', displayName: 'Selected text provider', connected: true, enabled: true,
      baseUrl: 'http://unused.invalid', models: [{ id: 'selected-model', name: 'Text engine', enabled: true,
        capabilities: { text: true, reasoning: true, vision: true, tools: false } }] });
    const allEntered = deferred(); const release = deferred(); const settled = deferred();
    let workerCalls = 0; let decisionCalls = 0; let synthesisCalls = 0;
    const workerInputs: string[] = []; let synthesisInput: any;
    // Deterministic model fixture only: the HTTP request contains no decision or assignments.
    const resolver = new ModelResolver(repo, { createClient: options => {
      assert.equal(options.modelId, 'selected-model');
      return { complete: async ({ system, input, images }) => {
        assert.ok(!images?.length);
        if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
        const data = JSON.parse(input);
        if (data.assignment) {
          assert.match(system, /Requested reasoning effort: high/);
          const ordinal = workerCalls++;
          workerInputs.push(input);
          if (workerCalls === scenario.count) allEntered.resolve();
          await release.promise;
          if (scenario.failed && ordinal === 0) throw new Error('Controlled model failure');
          return JSON.stringify({ status: 'completed', summary: `Independent conclusion ${ordinal}`, evidence: ['Supplied constraints only'], blockers: [], unresolved: [] });
        }
        if (data.projectIntelligence) {
          synthesisCalls++; synthesisInput = data;
          const reports = data.projectIntelligence.filter((entry: { name: string }) => entry.name === 'specialist-result')
            .map((entry: { value: string }) => JSON.parse(entry.value)) as WorkerReport[];
          assert.equal(reports.length, scenario.count);
          assert.equal(reports.filter(r => r.status === 'failed').length, scenario.failed ? 1 : 0);
          return JSON.stringify({ type: 'respond', message: scenario.failed ? 'One specialist failed. This recommendation uses only the available report.' : 'Recommendation based on the independent specialist reports.', basis: 'conversation', evidenceRefs: [] });
        }
        decisionCalls++;
        assert.match(system, /smallest useful team/);
        assert.match(system, /independent perspectives/);
        for (const d of data.availableMediobots.filter((d: { definitionId: string }) => data.assignableDefinitionIds.includes(d.definitionId))) {
          assert.equal(d.assignable, true); assert.ok(d.description?.length > 30 && d.description.length <= 500);
        }
        const metadata = data.availableMediobots;
        assert.match(metadata.find((d: { role: string }) => d.role === 'coding').description, /technical reasoning/);
        assert.match(metadata.find((d: { role: string }) => d.role === 'research').description, /tradeoffs/);
        assert.match(metadata.find((d: { role: string }) => d.role === 'tester').description, /critical independent review/);
        if (data.userGoal === 'What is recursion?') return JSON.stringify({ type: 'respond', message: 'Recursion is a function solving a problem through smaller calls to itself.', basis: 'conversation', evidenceRefs: [] });
        if (data.userGoal === 'Hi') return JSON.stringify({ type: 'respond', message: 'Hello', basis: 'conversation', evidenceRefs: [] });
        assert.equal(data.reasoningEffortPreference, 'high');
        assert.ok(data.availableIntents.includes('delegate_text'));
        const roles = scenario.roles ?? (scenario.count === 2 ? ['research', 'tester'] : ['coding', 'research', 'tester']);
        return JSON.stringify({ type: 'delegate_text', independence: 'Each perspective can be evaluated from supplied constraints without sibling results.',
          assignments: roles.map((role: string) => {
            const definition = data.availableMediobots.find((d: { role: string }) => d.role === role);
            assert.ok(data.assignableDefinitionIds.includes(definition.definitionId));
            return { definitionId: definition.definitionId, objective: `Evaluate the ${role} perspective.`, relevantContext: 'The component must remain bounded under overload.',
              relevantContextRefs: [], constraints: ['Text only'], expectedOutcome: 'A concise assessment of the assigned perspective.', evidenceExpectations: ['Identify assumptions.'] };
          }) });
      } };
    } });
    // No injected composition: exercise the production model-selection preflight and composition.
    const app = await startCommandCenter({ databasePath: dbPath, providerRepository: repo, modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
    t.after(async () => { release.resolve(); await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
    const selection = { providerConnectionId: 'selected-provider', modelId: 'selected-model' };
    const greet = await request(app, 'POST', '/api/turns', { threadId: 'greeting', turnId: 'hi', prompt: 'Hi', modelSelection: selection });
    assert.ok([200, 202].includes(greet.status)); assert.equal(greet.json.direct, true);
    const explanation = await request(app, 'POST', '/api/turns', { threadId: 'explanation', turnId: 'recursion', prompt: 'What is recursion?', modelSelection: selection });
    assert.ok([200, 202].includes(explanation.status)); assert.equal(explanation.json.direct, true);
    const empty = app.composition.world.inspect();
    for (const entries of [empty.goals, empty.assignments, empty.tasks, empty.workers, empty.evidence]) assert.equal(entries.length, 0);
    const response = await request(app, 'POST', '/api/turns', { threadId: 'analysis', turnId: 'evaluate',
      prompt: scenario.count === 3 ? 'Design a reusable component with cancellation and resource bounds. Explain implementation choices and failure cases. Text only.' : 'Independently critique a proposal for a bounded component, examining assumptions and failure cases. Text only.',
      modelSelection: selection, reasoningEffort: 'high' });
    assert.equal(response.status, 202);
    assert.equal(response.json.providerId, selection.providerConnectionId); assert.equal(response.json.modelId, selection.modelId);
    const taskId = response.json.taskId;
    const listener = (event: { type: string }) => { if (['task.completed', 'task.failed', 'task.cancelled'].includes(event.type)) settled.resolve(); };
    app.composition.subscribers.get(taskId)!.add(listener);
    await allEntered.promise;
    const running = app.composition.world.inspect();
    assert.equal(running.goals.length, 1); assert.equal(running.assignments.length, scenario.count);
    assert.equal(running.tasks.filter(task => task.state === 'running').length, scenario.count + 1);
    assert.equal(synthesisCalls, 0);
    if (scenario.count === 2 && !scenario.failed) {
      const specialistWorker = running.workers.find(worker => worker.definitionId !== app.composition.maestroDefinitionId)!;
      const specialist = running.definitions.find(definition => definition.id === specialistWorker.definitionId)!;
      app.composition.publish({ id: 'test-low-level-progress', type: 'worker.progress', worldId: running.world.id, taskId,
        workerId: specialistWorker.id, workerDefinitionId: specialist.id, workerName: specialist.name,
        message: 'filesystem.list', occurredAt: Date.now() });
      app.composition.publish({ id: 'test-meaningful-progress', type: 'worker.progress', worldId: running.world.id, taskId,
        workerId: specialistWorker.id, workerDefinitionId: specialist.id, workerName: specialist.name,
        message: `${specialist.name} found a relevant constraint and is applying it.`, occurredAt: Date.now() + 1 });
    }
    release.resolve(); await settled.promise;
    const snapshot = app.composition.world.inspect();
    const reports = snapshot.evidence.filter(e => e.source.type === 'worker-report').map(e => JSON.parse(e.content) as WorkerReport);
    const events = app.composition.taskEvents.get(taskId)!;
    assert.equal(reports.length, scenario.count);
    assert.equal(synthesisCalls, 1); assert.equal(decisionCalls, 3, 'Server reuses its validated decision; no second planning call.');
    const scriptedAssignmentMessages = events.filter(event => event.type === 'worker.message' && event.message?.startsWith('I’ve assigned '));
    assert.equal(scriptedAssignmentMessages.length, 0, 'Runtime assignment state is not impersonated as model-authored dialogue.');
    const durableParent = (await app.composition.getTaskView(taskId))!;
    const expectedParticipantRoles = scenario.roles ?? (scenario.count === 2 ? ['research', 'tester'] : ['coding', 'research', 'tester']);
    const expectedParticipantIds = expectedParticipantRoles.map(role => snapshot.definitions.find(definition => definition.role === role)!.id).sort();
    assert.deepEqual(durableParent.delegations.map(delegation => delegation.assignedMediobotId).sort(), expectedParticipantIds,
      'Stage 2B persists authorized collaboration membership for the selected specialists.');
    for (const report of reports) {
      const child = await app.composition.durableTaskEngine!.getTask(report.taskId);
      assert.ok(child, `Specialist ${report.mediobotId} has a durable child task.`);
      assert.equal(child.definitionId, report.mediobotId);
      assert.equal(child.status, report.status === 'completed' ? 'completed' : report.status === 'cancelled' ? 'cancelled' : 'failed');
      assert.ok((await app.composition.durableTaskEngine!.getEvidence(report.taskId)).some(entry => entry.kind === 'worker-report'),
        `Specialist ${report.mediobotId} has a durable attributed report.`);
      const delegation = durableParent.delegations.find(entry => entry.assignedMediobotId === report.mediobotId
        && entry.childTaskId === report.taskId);
      assert.ok(delegation, `Parent delegation links ${report.mediobotId} to its durable child.`);
    }
    assert.equal(snapshot.goals[0]!.status === 'satisfied', false);
    assert.equal(snapshot.resources.length, 0); assert.equal(snapshot.artifacts.length, 0);
    if (scenario.failed) {
      const supervision = synthesisInput.projectIntelligence.find((entry: { name: string }) => entry.name === 'bounded-supervision-notices');
      assert.ok(supervision, 'Maestro synthesis receives bounded runtime failure attention in addition to the specialist report.');
      assert.ok(JSON.parse(supervision.value).some((notice: { category?: string; taskId?: string }) =>
        notice.category === 'model' && reports.some(report => report.taskId === notice.taskId)), 'The notice preserves failed specialist/task attribution.');
      assert.ok(events.some(event => event.type === 'worker.progress' && event.message?.includes('supervision recorded a model failure')),
        'The existing event stream exposes the real supervision notice without leaking model payloads.');
    }
    for (const report of reports) {
      assert.equal(report.providerId, selection.providerConnectionId); assert.equal(report.modelId, selection.modelId);
      assert.equal(snapshot.assignments.find(a => a.id === report.assignmentId)!.targetDefinitionId, report.mediobotId);
      assert.equal(snapshot.tasks.find(task => task.id === report.taskId)!.assignedWorkerId, report.workerId);
    }
    assert.ok(Math.max(...reports.map(r => r.startedAt!)) < Math.min(...reports.map(r => r.completedAt!)));
    if (scenario.roles?.includes('doc')) {
      const doc = app.composition.world.inspect().definitions.find(d => d.role === 'doc')!;
      const docMetadata = synthesisInput.availableMediobots.find((d: { definitionId: string }) => d.definitionId === doc.id);
      assert.match(docMetadata.description, /official documentation/);
      assert.ok(docMetadata.capabilities.includes('web.search') && docMetadata.capabilities.includes('web.crawl'));
      const docReport = reports.find(r => r.mediobotId === doc.id)!;
      assert.equal(docReport.status, 'completed');
      assert.equal(events.filter(e => e.workerId === docReport.workerId && e.type.startsWith('tool.')).length, 0,
        'The assignment omitted requiredCapabilities and only asked for supplied-context analysis, so text execution is expected.');
      assert.ok(workerInputs.some(input => input.includes('official documentation') === false),
        'Text-worker input contains only the assignment and supplied context, not a web-search result.');
    }
    assert.equal(workerInputs.some(input => input.includes('userGoal') || input.includes('recentHistory') || input.includes('bounded-worker-reports')), false);
    assert.deepEqual(synthesisInput.recentHistory, [], 'synthesis receives an explicit empty history when SQLite has no prior turns');
    assert.equal(snapshot.workers.some(w => w.definitionId === app.composition.visionDefinitionId), false);
    for (const report of reports) {
      assert.ok(events.some(e => e.type === 'worker.started' && e.workerId === report.workerId && e.executionTaskId === report.taskId));
      assert.ok(events.some(e => e.type === (report.status === 'failed' ? 'worker.failed' : 'worker.completed') && e.workerId === report.workerId));
    }
    assert.equal(events.filter(e => e.type === 'task.completed').length, 1, 'Child completions do not terminalize the parent turn.');
    const streamed = await turnEvents(app, 'analysis', 'evaluate');
    const replayedSnapshot = streamed.find(e => e.type === 'turn.snapshot')!;
    assert.equal(replayedSnapshot.payload.turn.status, 'completed', 'A late subscriber receives the current terminal transcript snapshot.');
    for (const report of reports) assert.ok(replayedSnapshot.payload.turn.items.some((item: any) =>
      item.type === 'activity' && item.actor?.mediobotId === report.mediobotId), `Snapshot includes ${report.mediobotId} activity.`);
    assert.ok(replayedSnapshot.payload.turn.items.some((item: any) => item.type === 'agent_message'));
    const saved = await request(app, 'GET', '/api/threads/analysis');
    const turn = saved.json.thread.turns[0];
    assert.equal(turn.status, 'completed');
    assert.ok(turn.items.some((item: { type: string; text?: string }) => item.type === 'agent_message' && item.text?.includes(scenario.failed ? 'One specialist failed' : 'independent specialist reports')),
      JSON.stringify(turn.items));
    assert.equal(turn.items.filter((item: { type: string; text?: string }) => item.type === 'agent_message' && item.text?.startsWith('I’ve assigned ')).length,
      0, 'The durable Main Chat transcript does not fabricate first-person assignment narration.');
    if (scenario.count === 2 && !scenario.failed) {
      assert.equal(turn.items.some((item: { text?: string }) => item.text === 'filesystem.list'), false,
        'Low-level progress stays in execution telemetry, not Main Chat conversation.');
      assert.ok(turn.items.some((item: { type: string; text?: string }) => item.type === 'activity'
        && item.text?.includes('found a relevant constraint')), 'Meaningful progress remains visible in the durable transcript.');
    }
    for (const report of reports) {
      assert.ok(turn.items.some((item: { type: string; actor?: { mediobotId: string } }) => item.type === 'activity' && item.actor?.mediobotId === report.mediobotId));
    }
    assert.equal(turn.items.some((item: { type: string }) => item.type === 'tool_execution' || item.type === 'diff'), false);
  });
}

test('completed Doc child is reused after restart without repeating its model work', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediobot-doc-child-recovery-'));
  const dbPath = path.join(root, 'mediobot.db');
  const database = new LocalDatabase(dbPath);
  const repo = new ProviderRepository(database.raw);
  repo.save({ id: 'selected-provider', providerType: 'custom', displayName: 'Selected', connected: true, enabled: true,
    baseUrl: 'http://unused.invalid', models: [{ id: 'selected-model', name: 'Text engine', enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: false } }] });
  let specialistCalls = 0;
  const resolver = new ModelResolver(repo, { createClient: () => ({ complete: async ({ input }: { input: string }) => {
    const data = JSON.parse(input);
    if (data.assignment) { specialistCalls++; return JSON.stringify({ status: 'completed', summary: 'Doc outcome persisted.', evidence: ['Bounded supplied-context finding'], blockers: [], unresolved: [] }); }
    if (data.projectIntelligence) return JSON.stringify({ type: 'respond', message: 'Doc completed with a persisted finding.', basis: 'conversation', evidenceRefs: [] });
    const doc = data.availableMediobots.find((item: { role: string }) => item.role === 'doc');
    return JSON.stringify({ type: 'delegate_text', independence: 'One bounded specialist assignment.', assignments: [{
      assignmentId: 'doc-recovery', definitionId: doc.definitionId, objective: 'Assess the supplied documentation notes.',
      relevantContext: 'Use only the bounded notes below.', relevantContextRefs: [], constraints: ['No external research'],
      expectedOutcome: 'A concise assessment.', evidenceExpectations: ['Record the finding'],
    }] });
  } }) });
  const app1 = await startCommandCenter({ databasePath: dbPath, providerRepository: repo, modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { try { await app1.close(); } catch {} try { database.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  const submitted = await request(app1, 'POST', '/api/turns', { threadId: 'doc-recovery-thread', turnId: 'doc-first',
    prompt: 'Review the supplied documentation notes.', modelSelection: { providerConnectionId: 'selected-provider', modelId: 'selected-model' } });
  assert.equal(submitted.status, 202);
  const parentTaskId = submitted.json.taskId;
  const childTaskId = `task_${(await import('node:crypto')).createHash('sha256')
    .update(`${parentTaskId}\0doc\0doc-recovery\0Assess the supplied documentation notes.`).digest('hex').slice(0, 32)}`;
  for (let i = 0; i < 100; i++) {
    if ((await app1.composition.durableTaskEngine!.getTask(parentTaskId))?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await app1.composition.durableTaskEngine!.getTask(childTaskId))?.status, 'completed');
  assert.ok((await app1.composition.durableTaskEngine!.getEvidence(childTaskId)).some(item => item.kind === 'worker-report'));
  assert.equal(specialistCalls, 1);

  // Model an abrupt process loss after Doc settled but before the parent graph
  // outcome was durably checkpointed. The live group remains open, as it would
  // while the parent task was still active during a real crash.
  await app1.close();
  database.raw.prepare("UPDATE durable_tasks SET status = 'interrupted', completed_at = NULL WHERE id = ?").run(parentTaskId);
  database.raw.prepare("UPDATE durable_task_delegations SET status = 'active' WHERE parent_task_id = ?").run(parentTaskId);
  database.raw.prepare("UPDATE collaboration_groups SET status = 'active' WHERE parent_task_id = ?").run(parentTaskId);
  database.raw.prepare("DELETE FROM langgraph_task_outcomes WHERE thread_id = ? AND workflow_name = 'maestro-specialist-groups'").run(parentTaskId);
  database.raw.prepare('DELETE FROM writes WHERE thread_id = ?').run(parentTaskId);
  database.raw.prepare('DELETE FROM checkpoints WHERE thread_id = ?').run(parentTaskId);

  const app2 = await startCommandCenter({ databasePath: dbPath, providerRepository: repo, modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { try { await app2.close(); } catch {} });
  const resumed = await request(app2, 'POST', `/api/tasks/${parentTaskId}/resume`);
  assert.equal(resumed.status, 202, JSON.stringify(resumed.json));
  for (let i = 0; i < 150; i++) {
    if ((await app2.composition.durableTaskEngine!.getTask(parentTaskId))?.status === 'completed') break;
    const current = await app2.composition.durableTaskEngine!.getTask(parentTaskId);
    assert.notEqual(current?.status, 'failed', JSON.stringify(current?.error));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await app2.composition.durableTaskEngine!.getTask(parentTaskId))?.status, 'completed');
  assert.equal(specialistCalls, 1, 'completed Doc work is recovered from durable report evidence, not executed again');
  assert.ok((await app2.composition.durableTaskEngine!.getEvidence(childTaskId)).filter(item => item.kind === 'worker-report').length >= 1);
});

test('completed Cody child restores durable tool evidence into post-restart Maestro synthesis', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediobot-cody-evidence-recovery-'));
  writeFileSync(path.join(root, 'notes.txt'), 'A bounded, authorized project note.\n');
  const dbPath = path.join(root, 'mediobot.db');
  const database = new LocalDatabase(dbPath);
  const repo = new ProviderRepository(database.raw);
  repo.save({ id: 'selected-provider', providerType: 'custom', displayName: 'Selected', connected: true, enabled: true,
    baseUrl: 'http://unused.invalid', models: [{ id: 'selected-model', name: 'Text engine', enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: false } }] });
  let codyCalls = 0;
  let maestroCalls = 0;
  let synthesisInput: any;
  const resolver = new ModelResolver(repo, { createClient: () => ({ complete: async ({ system, input }: { system: string; input: string }) => {
    if (system.includes('MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER')) return JSON.stringify({ requiresCurrentProjectEvidence: false });
    const data = JSON.parse(input);
    if (system.includes("You are Cody, Mediabot's coding worker.")) {
      codyCalls++;
      return codyCalls === 1 ? JSON.stringify({ type: 'read', path: 'notes.txt' })
        : JSON.stringify({ type: 'finish', summary: 'Read notes.txt and reported its contents.' });
    }
    if (maestroCalls++ > 0) {
      synthesisInput = data;
      return JSON.stringify({ type: 'respond', message: 'Cody read the requested file; its tool evidence was restored after restart.', basis: 'conversation', evidenceRefs: [] });
    }
    const cody = data.availableMediobots.find((item: { role: string }) => item.role === 'coding');
    return JSON.stringify({ type: 'delegate', definitionId: cody.definitionId, objective: 'Read notes.txt and report the bounded tool result.',
      relevantContextRefs: [], constraints: ['Read only; do not modify files.'], expectedOutcome: 'A concise report.',
      evidenceExpectations: ['Record the filesystem.read tool result.'] });
  } }) });
  const app1 = await startCommandCenter({ databasePath: dbPath, providerRepository: repo, modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { try { await app1.close(); } catch {} try { database.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  const submitted = await request(app1, 'POST', '/api/turns', { threadId: 'cody-recovery-thread', turnId: 'cody-first',
    prompt: 'Ask Cody to inspect notes.txt and report what its read tool returned.',
    modelSelection: { providerConnectionId: 'selected-provider', modelId: 'selected-model' } });
  assert.equal(submitted.status, 202);
  const parentTaskId = submitted.json.taskId;
  for (let i = 0; i < 150; i++) {
    if ((await app1.composition.durableTaskEngine!.getTask(parentTaskId))?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const childId = (await app1.composition.durableTaskEngine!.getDelegations(parentTaskId))
    .find(entry => entry.childTaskId)?.childTaskId;
  assert.ok(childId);
  assert.equal((await app1.composition.durableTaskEngine!.getTask(childId))?.status, 'completed');
  const childEvidence = await app1.composition.durableTaskEngine!.getEvidence(childId);
  assert.ok(childEvidence.some(entry => entry.kind === 'tool-result' && (entry.source as { type?: string }).type === 'coding-tool'));
  assert.equal(codyCalls, 2);

  await app1.close();
  database.raw.prepare("UPDATE durable_tasks SET status = 'interrupted', completed_at = NULL WHERE id = ?").run(parentTaskId);
  database.raw.prepare("UPDATE durable_task_delegations SET status = 'active' WHERE parent_task_id = ?").run(parentTaskId);
  database.raw.prepare("UPDATE collaboration_groups SET status = 'active' WHERE parent_task_id = ?").run(parentTaskId);
  database.raw.prepare("DELETE FROM langgraph_task_outcomes WHERE thread_id = ? AND workflow_name = 'maestro-specialist-groups'").run(parentTaskId);
  database.raw.prepare('DELETE FROM writes WHERE thread_id = ?').run(parentTaskId);
  database.raw.prepare('DELETE FROM checkpoints WHERE thread_id = ?').run(parentTaskId);

  const app2 = await startCommandCenter({ databasePath: dbPath, providerRepository: repo, modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { try { await app2.close(); } catch {} });
  const resumed = await request(app2, 'POST', `/api/tasks/${parentTaskId}/resume`);
  assert.equal(resumed.status, 202, JSON.stringify(resumed.json));
  for (let i = 0; i < 150; i++) {
    if ((await app2.composition.durableTaskEngine!.getTask(parentTaskId))?.status === 'completed') break;
    const current = await app2.composition.durableTaskEngine!.getTask(parentTaskId);
    assert.notEqual(current?.status, 'failed', JSON.stringify(current?.error));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await app2.composition.durableTaskEngine!.getTask(parentTaskId))?.status, 'completed');
  assert.equal(codyCalls, 2, 'the completed Cody child is reused; its tools and model decisions are not replayed');
  const restored = app2.composition.world.inspect().evidence.filter(item => item.taskId === childId && item.source.type === 'coding-tool');
  assert.ok(restored.length > 0, 'durable tool evidence is restored into the resumed world');
  assert.ok(synthesisInput.relevantEvidence.some((item: { source: { type: string }; content: string }) =>
    item.source.type === 'coding-tool' && item.content.includes('filesystem.read succeeded')),
  'Maestro synthesis receives the actual bounded tool outcome after restart');
});

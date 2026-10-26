import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimelineNavigatorAnchors, conversationActorName, projectThreadTimeline } from '../../src/features/threads/timeline.ts';
import type { ThreadItem, Turn } from '../../src/types/index.ts';

const makeTurn = (items: ThreadItem[], id = 'turn-1'): Turn => ({ id, threadId: 'thread-1', prompt: 'Build this', status: 'completed',
  createdAt: 1, items });

test('timeline identity is explicit structured data and is never inferred from prose', () => {
  const entries = projectThreadTimeline([makeTurn([
    { id: 'u', turnId: 'turn-1', type: 'user_message', actor: { type: 'user' }, timestamp: 1, text: 'Hi' },
    { id: 'a', turnId: 'turn-1', type: 'agent_message', actor: { type: 'mediobot', mediobotId: 'cody' }, timestamp: 2, text: 'Vision inspected the page.' },
  ])]);
  assert.equal(conversationActorName(entries[0]?.actor), 'You');
  assert.equal(conversationActorName(entries[1]?.actor), 'Cody');
  assert.equal(entries[1]?.preview, 'Vision inspected the page.');
});

test('timeline groups adjacent activity by structured actor and keeps meaningful message anchors', () => {
  const entries = projectThreadTimeline([makeTurn([
    { id: 'u', turnId: 'turn-1', type: 'user_message', timestamp: 1, text: 'Build this' },
    { id: 'e1', turnId: 'turn-1', type: 'activity', actor: { type: 'mediobot', mediobotId: 'cody' }, timestamp: 2, activityLabel: 'Read files' },
    { id: 'e2', turnId: 'turn-1', type: 'tool_execution', actor: { type: 'mediobot', mediobotId: 'cody' }, timestamp: 3, tool: { toolName: 'filesystem.read', status: 'success' } },
    { id: 'm', turnId: 'turn-1', type: 'agent_message', actor: { type: 'mediobot', mediobotId: 'cody' }, timestamp: 4, text: 'Done.' },
  ])]);
  assert.deepEqual(entries.map((entry) => entry.kind), ['user', 'activity', 'message']);
  assert.equal(entries[1]?.items.length, 2);
  assert.equal(entries[1]?.label, 'Cody activity');
  assert.equal(entries[1]?.targetId, 'timeline-turn-1-e1');
});

test('legacy messages without actor remain unattributed instead of being labeled Maestro', () => {
  const entries = projectThreadTimeline([makeTurn([
    { id: 'u', turnId: 'turn-1', type: 'user_message', timestamp: 1, text: 'Hi' },
    { id: 'm', turnId: 'turn-1', type: 'agent_message', timestamp: 2, text: 'Hello' },
  ])]);
  assert.equal(entries[1]?.actor, undefined);
  assert.equal(entries[1]?.label, 'Mediobot');
});

test('navigator compresses very long histories deterministically and stays bounded', () => {
  const items = Array.from({ length: 2_000 }, (_, index) => ({ id: `m-${index}`, turnId: 'turn-1', type: 'agent_message' as const,
    actor: { type: 'mediobot' as const, mediobotId: 'maestro' }, timestamp: index, text: `Message ${index}` }));
  const entries = projectThreadTimeline([makeTurn(items)]);
  const first = buildTimelineNavigatorAnchors(entries);
  const second = buildTimelineNavigatorAnchors(entries);
  assert.ok(first.length <= 160);
  assert.deepEqual(first, second);
  assert.equal(first[0]?.targetId, entries[0]?.targetId);
  assert.ok((first[0]?.represents.length ?? 0) > 1);
});

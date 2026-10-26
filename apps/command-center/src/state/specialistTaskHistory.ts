import type { RuntimeTaskSummary } from '../runtime/types';

type TaskEvent = NonNullable<RuntimeTaskSummary['events']>[number];

function eventKey(event: TaskEvent): string {
  if (event.id) return `id:${event.id}`;
  if (event.sequence !== undefined) return `sequence:${event.sequence}`;
  return [event.type ?? '', event.occurredAt, event.toolName ?? '', event.message ?? ''].join('|');
}

function compareEvents(left: TaskEvent, right: TaskEvent): number {
  if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  return left.occurredAt - right.occurredAt;
}

/** Merge an asynchronously fetched durable snapshot with newer events already received live. */
export function mergeAgentTaskHistory(
  durable: ReadonlyArray<RuntimeTaskSummary>,
  current: ReadonlyArray<RuntimeTaskSummary>,
): RuntimeTaskSummary[] {
  const durableIds = new Set(durable.map((task) => task.id));
  const merged = durable.map((snapshot) => {
    const live = current.find((task) => task.id === snapshot.id);
    if (!live) return { ...snapshot, events: snapshot.events?.slice(-30) };

    const mergedEvents = new Map<string, TaskEvent>();
    for (const event of [...(snapshot.events ?? []), ...(live.events ?? [])]) mergedEvents.set(eventKey(event), event);
    const events = [...mergedEvents.values()].sort(compareEvents).slice(-30);
    const latestLive = [...(live.events ?? [])].sort(compareEvents).at(-1);
    const latestSnapshot = [...(snapshot.events ?? [])].sort(compareEvents).at(-1);
    const liveIsNewer = Boolean(latestLive && (!latestSnapshot || compareEvents(latestLive, latestSnapshot) > 0));

    return {
      ...snapshot,
      ...(liveIsNewer ? { state: live.state } : {}),
      events,
      evidence: mergeById(snapshot.evidence, live.evidence),
      artifacts: mergeById(snapshot.artifacts, live.artifacts),
    };
  });

  // The SSE stream can announce a child assignment before the durable task
  // listing reflects it. Keep that event-backed work visible until the next
  // durable snapshot catches up; terminal entries remain governed by SQLite.
  merged.push(...current.filter((task) => !durableIds.has(task.id)
    && ['queued', 'running', 'waiting_approval', 'waiting_input'].includes(task.state))
    .map((task) => ({ ...task, events: task.events?.slice(-30) })));

  if (merged.length > 100) {
    merged.sort((left, right) => {
      const leftActive = ['running', 'queued', 'waiting_approval', 'waiting_input'].includes(left.state) ? 1 : 0;
      const rightActive = ['running', 'queued', 'waiting_approval', 'waiting_input'].includes(right.state) ? 1 : 0;
      const leftLatest = Math.max(0, ...(left.events ?? []).map((event) => event.occurredAt));
      const rightLatest = Math.max(0, ...(right.events ?? []).map((event) => event.occurredAt));
      return rightActive - leftActive || rightLatest - leftLatest;
    });
    merged.length = 100;
  }
  return merged;
}

function mergeById<T extends { readonly id?: string }>(
  durable: ReadonlyArray<T> | undefined,
  live: ReadonlyArray<T> | undefined,
): ReadonlyArray<T> | undefined {
  if (!durable?.length && !live?.length) return undefined;
  const merged = new Map<string, T>();
  for (const [index, item] of [...(durable ?? []), ...(live ?? [])].entries()) {
    merged.set(item.id ? `id:${item.id}` : `index:${index}`, item);
  }
  return [...merged.values()];
}

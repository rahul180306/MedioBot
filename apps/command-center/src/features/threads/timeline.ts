import type { ConversationActor, ThreadItem, Turn } from '../../types';
import { getMediobotPresentation } from '../mediobots/presentation.ts';

export type TimelineEntry = {
  readonly id: string;
  readonly targetId: string;
  readonly kind: 'user' | 'message' | 'activity';
  readonly actor?: ConversationActor;
  readonly label: string;
  readonly preview: string;
  readonly items: ReadonlyArray<ThreadItem>;
  readonly turnStatus: Turn['status'];
};

export type TimelineNavigatorAnchor = {
  readonly id: string;
  readonly targetId: string;
  readonly kind: TimelineEntry['kind'];
  readonly actor?: ConversationActor;
  readonly label: string;
  readonly preview: string;
  readonly represents: ReadonlyArray<string>;
};

export const MAX_TIMELINE_NAVIGATOR_ANCHORS = 160;

export function conversationActorName(actor?: ConversationActor): string {
  if (actor?.type === 'user') return 'You';
  if (actor?.type === 'system') return 'System';
  if (actor?.type === 'mediobot') return getMediobotPresentation(actor.presentationId ?? actor.mediobotId, actor.name).displayName;
  return 'Mediobot';
}

function targetId(turnId: string, itemId: string): string {
  return `timeline-${encodeURIComponent(turnId)}-${encodeURIComponent(itemId)}`;
}

function previewFor(item: ThreadItem): string {
  if (item.text?.trim()) return item.text.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (item.attachments?.length) return item.attachments.map((attachment) => attachment.name).join(', ').slice(0, 120);
  if (item.type === 'tool_execution') return item.tool?.toolName ?? 'Tool activity';
  if (item.type === 'diff') return 'File changes';
  if (item.type === 'approval_request') return item.approval?.title ?? 'Approval request';
  if (item.type === 'computer_action') return 'Computer activity';
  if (item.type === 'perception_snapshot') return 'Observation';
  return item.activityLabel ?? 'Activity';
}

function activityLabel(items: ReadonlyArray<ThreadItem>): string {
  const kinds = new Set(items.map((item) => item.type));
  if (kinds.size === 1 && kinds.has('tool_execution')) return 'Tool activity';
  if (kinds.size === 1 && kinds.has('diff')) return 'File changes';
  if (kinds.size === 1 && kinds.has('approval_request')) return 'Approval';
  if (kinds.size === 1 && (kinds.has('computer_action') || kinds.has('perception_snapshot'))) return 'Computer activity';
  return 'Activity';
}

function sameActor(left?: ConversationActor, right?: ConversationActor): boolean {
  if (!left || !right) return left === right;
  if (left.type !== right.type) return false;
  return left.type !== 'mediobot' || (right.type === 'mediobot' && left.mediobotId === right.mediobotId);
}

/** Projects persisted, structured transcript items into renderable groups without parsing prose. */
export function projectThreadTimeline(turns: ReadonlyArray<Turn>): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const turn of turns) {
    const items = turn.items.length > 0 || !turn.prompt
      ? turn.items
      : [{ id: `legacy-user-${turn.id}`, turnId: turn.id, type: 'user_message' as const,
          actor: { type: 'user' as const }, timestamp: turn.createdAt, text: turn.prompt }];
    let activity: ThreadItem[] = [];
    const flushActivity = () => {
      if (!activity.length) return;
      const first = activity[0]!;
      const label = `${conversationActorName(first.actor)} ${activityLabel(activity).toLowerCase()}`;
      entries.push({ id: `${turn.id}:activity:${first.id}`, targetId: targetId(turn.id, first.id), kind: 'activity',
        ...(first.actor ? { actor: first.actor } : {}), label, preview: previewFor(first), items: activity, turnStatus: turn.status });
      activity = [];
    };

    for (const item of items) {
      if (item.type === 'user_message') {
        flushActivity();
        if (!item.text && !item.attachments?.length) continue;
        entries.push({ id: `${turn.id}:user:${item.id}`, targetId: targetId(turn.id, item.id), kind: 'user',
          actor: item.actor ?? { type: 'user' }, label: 'User request', preview: previewFor(item), items: [item], turnStatus: turn.status });
      } else if (item.type === 'agent_message') {
        flushActivity();
        if (!item.text?.trim()) continue;
        entries.push({ id: `${turn.id}:message:${item.id}`, targetId: targetId(turn.id, item.id), kind: 'message',
          ...(item.actor ? { actor: item.actor } : {}), label: conversationActorName(item.actor), preview: previewFor(item), items: [item], turnStatus: turn.status });
      } else if (activity.length && !sameActor(activity[activity.length - 1]?.actor, item.actor) && !(item.type === 'tool_execution' && activity[activity.length - 1]?.type === 'tool_execution')) {
        flushActivity();
        activity.push(item);
      } else {
        activity.push(item);
      }
    }
    flushActivity();
  }
  return entries;
}

/** Keeps the navigator bounded for long histories by grouping adjacent semantic anchors. */
export function buildTimelineNavigatorAnchors(entries: ReadonlyArray<TimelineEntry>, max = MAX_TIMELINE_NAVIGATOR_ANCHORS): TimelineNavigatorAnchor[] {
  if (entries.length <= max) return entries.map((entry) => ({ id: entry.id, targetId: entry.targetId,
    kind: entry.kind, ...(entry.actor ? { actor: entry.actor } : {}), label: entry.label,
    preview: entry.preview, represents: [entry.id] }));
  const groupSize = Math.ceil(entries.length / max);
  const anchors: TimelineNavigatorAnchor[] = [];
  for (let start = 0; start < entries.length; start += groupSize) {
    const group = entries.slice(start, start + groupSize);
    const first = group[0]!;
    anchors.push({ id: `group:${first.id}`, targetId: first.targetId, kind: first.kind,
      ...(first.actor ? { actor: first.actor } : {}),
      label: group.length > 1 ? `${first.label} + ${group.length - 1} more` : first.label,
      preview: first.preview, represents: group.map((entry) => entry.id) });
  }
  return anchors;
}

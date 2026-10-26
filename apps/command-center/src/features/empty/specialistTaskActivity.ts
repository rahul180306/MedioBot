export interface SpecialistTaskEvent {
  readonly type?: string;
  readonly occurredAt: number;
  readonly message?: string;
  readonly toolName?: string;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly errorCode?: string;
  readonly exitCode?: number | null;
  readonly recoveryReason?: string;
  readonly activityState?: import('../../types/index.ts').AgentActivityState;
}

export function specialistActivityState(event: SpecialistTaskEvent): import('../../types/index.ts').AgentActivityState | undefined {
  if (event.activityState) return event.activityState;
  if (event.type === 'worker.assigned') return 'planning';
  if (event.type === 'worker.started' || event.type === 'task.started') return 'thinking';
  if (event.type === 'worker.completed' || event.type === 'task.completed') return 'completed';
  if (event.type === 'worker.failed' || event.type === 'task.failed') return 'failed';
  if (event.type === 'worker.cancelled' || event.type === 'task.cancelled') return 'cancelled';
  if (event.type === 'approval.required') return 'waiting_for_approval';
  if (event.type === 'approval.resolved') return 'thinking';
  if (event.type?.startsWith('tool.')) {
    if (event.toolName === 'filesystem.write' || event.toolName === 'filesystem.edit') return 'editing';
    if (event.toolName?.startsWith('filesystem.')) return 'inspecting';
    if (event.toolName?.startsWith('web.')) return 'researching';
    if (event.toolName === 'terminal.execute') return 'running';
  }
  return undefined;
}

export function specialistTaskIdentity(event: { readonly taskId?: string; readonly executionTaskId?: string }): string | undefined {
  return event.executionTaskId ?? event.taskId;
}

export function specialistAssignmentGoal(message?: string): string | undefined {
  const goal = message?.trim().replace(/^(?:Assigned:\s*|I[’']ve assigned .+? to:\s*)/i, "");
  return goal ? goal.slice(0, 180) : undefined;
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "worker.assigned": "Assignment received",
  "worker.started": "Work started",
  "worker.completed": "Work completed",
  "worker.failed": "Work failed",
  "worker.cancelled": "Work cancelled",
  "approval.required": "Approval requested",
  "approval.resolved": "Approval resolved",
  "file.changed": "File changed",
};

export function specialistTaskActivity(events: ReadonlyArray<SpecialistTaskEvent> = [], limit = 6): SpecialistTaskEvent[] {
  const eligible = events.filter((event) => {
    if (!event.type) return false;
    if (event.type.startsWith("tool.")) return Boolean(event.toolName);
    if (event.type === "worker.progress") {
      return Boolean(event.message?.trim()) && !/^(?:[\w -]+\s+)?progress\.?$/i.test(event.message!.trim());
    }
    return event.type in EVENT_LABELS || event.type === "worker.message";
  }).sort((left, right) => left.occurredAt - right.occurredAt);
  const boundedLimit = Math.max(0, limit);
  if (eligible.length <= boundedLimit) return eligible;
  const selected = eligible.slice(-boundedLimit);
  // Keep a recent failure visible even when later completion or recovery events
  // would otherwise push its diagnostic out of the bounded activity window.
  for (const failure of eligible.filter((event) => event.type === "tool.failed" || event.type === "worker.failed").reverse()) {
    if (selected.includes(failure)) continue;
    const replace = selected.findIndex((event) => event.type !== "tool.failed" && event.type !== "worker.failed");
    if (replace < 0) break;
    selected[replace] = failure;
  }
  return selected.sort((left, right) => left.occurredAt - right.occurredAt);
}

export function specialistTaskEventLabel(event: SpecialistTaskEvent): string {
  if (event.toolName) {
    const state = event.type?.slice("tool.".length) ?? "activity";
    const diagnostics = [event.command, event.workingDirectory ? `cwd=${event.workingDirectory}` : undefined,
      event.errorCode, typeof event.exitCode === "number" ? `exit ${event.exitCode}` : event.exitCode === null ? "no exit code" : undefined, event.recoveryReason]
      .filter(Boolean).join(" · ").slice(0, 700);
    return `${event.toolName} · ${state}${diagnostics ? ` · ${diagnostics}` : ""}`;
  }
  const message = event.message?.trim().replace(/^Assigned:\s*/i, "");
  if (message) return message;
  return EVENT_LABELS[event.type ?? ""] ?? "Specialist update";
}

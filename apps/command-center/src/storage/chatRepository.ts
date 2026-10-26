import type { DatabaseSync } from "node:sqlite";
import { sanitizeReasoningAndSecrets } from "@mediobot-v2/models";
import type { Thread, Turn, ThreadItem } from "../types/index.ts";

const terminationSignals = new Set(['SIGABRT', 'SIGALRM', 'SIGBREAK', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2']);

function sanitizeText(text: unknown): string {
  return typeof text === 'string' ? sanitizeReasoningAndSecrets(text) : '';
}

function sanitizeItem(item: ThreadItem): ThreadItem {
  const toolStatuses = new Set(['running', 'success', 'failed', 'cancelled']);
  const toolFailures = new Set(['path-error', 'command-error', 'filesystem-error', 'tool-error', 'interrupted', 'lifecycle-conflict']);
  const verificationStatuses = new Set(['command-succeeded', 'command-failed', 'unverified']);
  const tool = item.tool ? {
    toolName: sanitizeText(item.tool.toolName),
    toolInvocationId: item.tool.toolInvocationId,
    ...(typeof item.tool.command === 'string' && (item.tool.errorCode || item.tool.recoveryReason || item.tool.exitCode !== undefined)
      ? { command: sanitizeText(item.tool.command).slice(0, 500) } : {}),
    ...(typeof item.tool.workingDirectory === 'string' && (item.tool.errorCode || item.tool.recoveryReason || item.tool.exitCode !== undefined)
      && !item.tool.workingDirectory.startsWith('/')
      && !/^[A-Za-z]:/.test(item.tool.workingDirectory) && !item.tool.workingDirectory.split(/[\\/]+/).includes('..')
      ? { workingDirectory: sanitizeText(item.tool.workingDirectory).slice(0, 180) } : {}),
    ...(typeof item.tool.recoveryReason === 'string' ? { recoveryReason: sanitizeText(item.tool.recoveryReason).slice(0, 240) } : {}),
    status: toolStatuses.has(item.tool.status) ? item.tool.status : 'failed' as const,
    ...(Number.isFinite(item.tool.startedAt) ? { startedAt: item.tool.startedAt } : {}),
    ...(Number.isFinite(item.tool.durationMs) && (item.tool.durationMs ?? -1) >= 0 ? { durationMs: item.tool.durationMs } : {}),
    error: item.tool.error ? sanitizeText(item.tool.error) : undefined,
    ...(typeof item.tool.errorCode === 'string' && /^[A-Z0-9_]{1,32}$/.test(item.tool.errorCode) ? { errorCode: item.tool.errorCode } : {}),
    ...(item.tool.failureCategory && toolFailures.has(item.tool.failureCategory) ? { failureCategory: item.tool.failureCategory } : {}),
    ...(typeof item.tool.recoveredFromExecution === 'boolean' ? { recoveredFromExecution: item.tool.recoveredFromExecution } : {}),
    ...(typeof item.tool.isVerification === 'boolean' ? { isVerification: item.tool.isVerification } : {}),
    ...(Number.isInteger(item.tool.exitCode) || item.tool.exitCode === null ? { exitCode: item.tool.exitCode } : {}),
    ...(typeof item.tool.terminationSignal === 'string' && terminationSignals.has(item.tool.terminationSignal) ? { terminationSignal: item.tool.terminationSignal } : {}),
    ...(Number.isSafeInteger(item.tool.stdoutBytes) && (item.tool.stdoutBytes ?? -1) >= 0 ? { stdoutBytes: item.tool.stdoutBytes } : {}),
    ...(Number.isSafeInteger(item.tool.stderrBytes) && (item.tool.stderrBytes ?? -1) >= 0 ? { stderrBytes: item.tool.stderrBytes } : {}),
    ...(Number.isSafeInteger(item.tool.eventSequence) && (item.tool.eventSequence ?? -1) >= 0 ? { eventSequence: item.tool.eventSequence } : {}),
    ...(typeof item.tool.lifecycleConflict === 'boolean' ? { lifecycleConflict: item.tool.lifecycleConflict } : {}),
    // Historical records used "verified" for model-designated commands; that is
    // not sufficient provenance to assert task correctness.
    verificationStatus: item.tool.verificationStatus === ('verified' as string)
      ? 'unverified' as const : verificationStatuses.has(item.tool.verificationStatus ?? '')
        ? item.tool.verificationStatus : 'unverified' as const } : undefined;
  const actor = item.actor?.type === 'user' || item.actor?.type === 'system'
    ? { type: item.actor.type }
    : item.actor?.type === 'mediobot' && typeof item.actor.mediobotId === 'string'
      ? { type: 'mediobot' as const, mediobotId: item.actor.mediobotId,
          ...(typeof item.actor.name === 'string' ? { name: sanitizeText(item.actor.name) } : {}),
          ...(typeof item.actor.presentationId === 'string' ? { presentationId: item.actor.presentationId } : {}) }
      : undefined;
  const failureCategories = new Set(['structural', 'semantic', 'provider', 'runtime']);
  const failureReasons = new Set(['invalid-json', 'non-object-response', 'missing-intent', 'unsupported-intent', 'intent-not-available',
    'schema-mismatch', 'unknown-delegation', 'unavailable-capability', 'insufficient-evidence', 'repair-intent-changed',
    'configuration', 'authentication', 'capacity', 'timeout', 'cancelled', 'transport', 'invalid-response', 'structured-parse',
    'unsupported-modality']);
  const failure = item.failure?.stage === 'maestro-decision' && failureCategories.has(item.failure.category)
    ? { stage: 'maestro-decision' as const, category: item.failure.category,
        ...(item.failure.reason && failureReasons.has(item.failure.reason) ? { reason: item.failure.reason } : {}),
        ...(typeof item.failure.providerId === 'string' ? { providerId: sanitizeText(item.failure.providerId).slice(0, 200) } : {}),
        ...(typeof item.failure.modelId === 'string' ? { modelId: sanitizeText(item.failure.modelId).slice(0, 200) } : {}) }
    : undefined;
  return {
    id: item.id,
    turnId: item.turnId,
    type: item.type,
    timestamp: item.timestamp,
    ...(actor ? { actor } : {}),
    ...(typeof item.text === 'string' ? { text: sanitizeText(item.text) } : {}),
    ...(typeof item.activityLabel === 'string' ? { activityLabel: sanitizeText(item.activityLabel) } : {}),
    ...(typeof item.activityState === 'string' && ['thinking', 'planning', 'inspecting', 'editing', 'running', 'testing', 'verifying',
      'researching', 'collaborating', 'waiting', 'waiting_for_approval', 'retrying', 'recovered', 'verified', 'blocked',
      'completed', 'failed', 'cancelled'].includes(item.activityState) ? { activityState: item.activityState } : {}),
    ...(Number.isFinite(item.durationMs) && (item.durationMs ?? -1) >= 0 ? { durationMs: item.durationMs } : {}),
    ...(item.type === 'tool_execution' && tool ? { tool } : {}),
    ...(item.type === 'diff' && item.diff ? { diff: {
      filePath: sanitizeText(item.diff.filePath),
      ...(typeof item.diff.language === 'string' ? { language: sanitizeText(item.diff.language) } : {}),
      additions: item.diff.additions,
      deletions: item.diff.deletions,
      ...(typeof item.diff.truncated === 'boolean' ? { truncated: item.diff.truncated } : {}),
      ...(Array.isArray(item.diff.hunks) ? { hunks: item.diff.hunks.map((hunk) => ({
        header: sanitizeText(hunk.header),
        lines: hunk.lines.map((line) => ({ type: line.type, content: sanitizeText(line.content),
          ...(typeof line.oldLineNo === 'number' ? { oldLineNo: line.oldLineNo } : {}),
          ...(typeof line.newLineNo === 'number' ? { newLineNo: line.newLineNo } : {}) })),
      })) } : {}),
    } } : {}),
    ...(item.type === 'approval_request' && item.approval ? { approval: {
      approvalId: item.approval.approvalId, title: sanitizeText(item.approval.title), description: sanitizeText(item.approval.description),
      risk: item.approval.risk, status: item.approval.status,
      ...(typeof item.approval.mediobotName === 'string' ? { mediobotName: sanitizeText(item.approval.mediobotName) } : {}),
      ...(typeof item.approval.workspace === 'string' ? { workspace: sanitizeText(item.approval.workspace) } : {}),
      ...(typeof item.approval.reason === 'string' ? { reason: sanitizeText(item.approval.reason) } : {}),
      ...(item.approval.actionPayload ? { actionPayload: { type: item.approval.actionPayload.type,
        detail: sanitizeText(item.approval.actionPayload.detail) } } : {}),
    } } : {}),
    ...(item.type === 'computer_action' && item.computerAction ? { computerAction: {
      action: item.computerAction.action,
      ...(typeof item.computerAction.target === 'string' ? { target: sanitizeText(item.computerAction.target) } : {}),
      ...(item.computerAction.coordinate ? { coordinate: { x: item.computerAction.coordinate.x, y: item.computerAction.coordinate.y } } : {}),
      ...(typeof item.computerAction.keys === 'string' ? { keys: sanitizeText(item.computerAction.keys) } : {}),
      status: item.computerAction.status,
    } } : {}),
    ...(item.type === 'perception_snapshot' && item.perception ? { perception: {
      windowTitle: sanitizeText(item.perception.windowTitle), focusedApp: sanitizeText(item.perception.focusedApp),
      detectedElementsCount: item.perception.detectedElementsCount,
      ...(typeof item.perception.visualSummary === 'string' ? { visualSummary: sanitizeText(item.perception.visualSummary) } : {}),
      ...(typeof item.perception.confidenceScore === 'number' ? { confidenceScore: item.perception.confidenceScore } : {}),
    } } : {}),
    ...(Array.isArray(item.attachments) ? { attachments: item.attachments.map(({ id, name, mimeType, size }) => ({ id, name: sanitizeText(name), mimeType, size })) } : {}),
    ...(typeof item.eventSequence === 'number' ? { eventSequence: item.eventSequence } : {}),
    ...(failure ? { failure } : {}),
  };
}

function sanitizeTurn(turn: Turn): Turn {
  const activityStates = new Set(['thinking', 'planning', 'inspecting', 'editing', 'running', 'testing', 'verifying', 'researching',
    'collaborating', 'waiting', 'waiting_for_approval', 'retrying', 'recovered', 'verified', 'blocked', 'completed', 'failed', 'cancelled']);
  return {
    id: turn.id,
    threadId: turn.threadId,
    prompt: sanitizeText(turn.prompt),
    status: turn.status,
    ...(typeof turn.currentActivity === 'string' && activityStates.has(turn.currentActivity) ? { currentActivity: turn.currentActivity } : {}),
    createdAt: turn.createdAt,
    ...(typeof turn.completedAt === 'number' ? { completedAt: turn.completedAt } : {}),
    ...(typeof turn.taskId === 'string' ? { taskId: turn.taskId } : {}),
    ...(typeof turn.lastEventSequence === 'number' ? { lastEventSequence: turn.lastEventSequence } : {}),
    items: (turn.items || []).map(sanitizeItem),
  };
}

function parseModelSelection(selectedModel: string | null | undefined): { model?: string; modelSelection?: Thread["modelSelection"] } {
  if (!selectedModel) return {};
  try {
    const parsed = JSON.parse(selectedModel);
    if (parsed && typeof parsed === "object" && typeof parsed.providerConnectionId === "string" && typeof parsed.modelId === "string") {
      const rawEffort = typeof parsed.reasoningEffort === "string" ? parsed.reasoningEffort.toLowerCase() : undefined;
      const validEffort = rawEffort && ["low", "medium", "high", "extra", "max"].includes(rawEffort)
        ? (rawEffort as "low" | "medium" | "high" | "extra" | "max")
        : undefined;
      return {
        model: parsed.modelId,
        modelSelection: {
          providerConnectionId: parsed.providerConnectionId,
          modelId: parsed.modelId,
          ...(validEffort ? { reasoningEffort: validEffort } : {}),
        },
      };
    }
  } catch {
    // not JSON
  }
  if (selectedModel.includes(":")) {
    const [providerConnectionId, ...rest] = selectedModel.split(":");
    const modelId = rest.join(":");
    if (providerConnectionId && modelId) {
      return {
        model: modelId,
        modelSelection: { providerConnectionId, modelId },
      };
    }
  }
  return { model: selectedModel };
}

export function sanitizeThread(thread: Thread): Thread {
  return {
    id: thread.id,
    title: thread.title || "Untitled Conversation",
    projectId: thread.projectId,
    createdAt: thread.createdAt || Date.now(),
    updatedAt: thread.updatedAt || Date.now(),
    model: thread.model,
    modelSelection: thread.modelSelection,
    branch: thread.branch,
    approvalMode: thread.approvalMode,
    turns: (thread.turns || []).map(sanitizeTurn),
  };
}

export class ChatRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(workspaceId?: string | null): Thread[] {
    let rows: Array<{
      id: string;
      workspace_id: string | null;
      title: string;
      created_at: number;
      updated_at: number;
      selected_model: string | null;
      branch: string | null;
      approval_mode: string | null;
      turns_json: string;
    }>;

    if (workspaceId !== undefined) {
      if (workspaceId === null) {
        rows = this.db.prepare(
          "SELECT * FROM threads WHERE workspace_id IS NULL ORDER BY updated_at DESC"
        ).all() as typeof rows;
      } else {
        rows = this.db.prepare(
          "SELECT * FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC"
        ).all(workspaceId) as typeof rows;
      }
    } else {
      rows = this.db.prepare("SELECT * FROM threads ORDER BY updated_at DESC").all() as typeof rows;
    }

    return rows.map((r) => {
      let turns: Turn[] = [];
      try {
        turns = JSON.parse(r.turns_json);
      } catch {
        turns = [];
      }
      const modelInfo = parseModelSelection(r.selected_model);
      return sanitizeThread({
        id: r.id,
        title: r.title,
        projectId: r.workspace_id || undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        model: (modelInfo.model as any) || undefined,
        modelSelection: modelInfo.modelSelection,
        branch: r.branch || undefined,
        approvalMode: (r.approval_mode as Thread["approvalMode"]) || undefined,
        turns,
      });
    });
  }

  get(id: string): Thread | null {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as {
      id: string;
      workspace_id: string | null;
      title: string;
      created_at: number;
      updated_at: number;
      selected_model: string | null;
      branch: string | null;
      approval_mode: string | null;
      turns_json: string;
    } | undefined;

    if (!row) return null;

    let turns: Turn[] = [];
    try {
      turns = JSON.parse(row.turns_json);
    } catch {
      turns = [];
    }

    const modelInfo = parseModelSelection(row.selected_model);
    return sanitizeThread({
      id: row.id,
      title: row.title,
      projectId: row.workspace_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      model: (modelInfo.model as any) || undefined,
      modelSelection: modelInfo.modelSelection,
      branch: row.branch || undefined,
      approvalMode: (row.approval_mode as Thread["approvalMode"]) || undefined,
      turns,
    });
  }

  save(thread: Thread): Thread {
    const sanitized = sanitizeThread(thread);
    const stmt = this.db.prepare(`
      INSERT INTO threads (id, workspace_id, title, created_at, updated_at, selected_model, branch, approval_mode, turns_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        title = excluded.title,
        updated_at = excluded.updated_at,
        selected_model = excluded.selected_model,
        branch = excluded.branch,
        approval_mode = excluded.approval_mode,
        turns_json = excluded.turns_json
    `);

    let workspaceId: string | null = null;
    if (sanitized.projectId) {
      try {
        this.db.prepare(`
          INSERT OR IGNORE INTO workspaces (id, canonical_path, display_name, created_at, last_opened_at, availability)
          VALUES (?, ?, ?, ?, ?, 'available')
        `).run(sanitized.projectId, sanitized.projectId, sanitized.projectId, Date.now(), Date.now());
        workspaceId = sanitized.projectId;
      } catch {
        workspaceId = null;
      }
    }

    stmt.run(
      sanitized.id,
      workspaceId,
      sanitized.title,
      sanitized.createdAt,
      Date.now(),
      sanitized.modelSelection ? JSON.stringify(sanitized.modelSelection) : (sanitized.model || null),
      sanitized.branch || null,
      sanitized.approvalMode || null,
      JSON.stringify(sanitized.turns)
    );

    return sanitized;
  }

  saveMetadata(metadata: {
    id: string;
    title?: string;
    projectId?: string;
    model?: string;
    modelSelection?: Thread["modelSelection"];
    branch?: string;
    approvalMode?: string;
    createdAt?: number;
    updatedAt?: number;
  }): Thread {
    const existing = this.get(metadata.id);
    const id = metadata.id;
    const title = metadata.title ? sanitizeText(metadata.title) : (existing?.title ?? "New Discussion");
    const workspaceId = metadata.projectId ?? existing?.projectId ?? null;
    const createdAt = existing?.createdAt ?? metadata.createdAt ?? Date.now();
    const updatedAt = Date.now();
    const modelToSave = metadata.modelSelection
      ? JSON.stringify(metadata.modelSelection)
      : (metadata.model !== undefined
          ? metadata.model
          : (existing?.modelSelection ? JSON.stringify(existing.modelSelection) : (existing?.model ?? null)));
    const branch = metadata.branch ?? existing?.branch ?? null;
    const approvalMode = metadata.approvalMode ?? existing?.approvalMode ?? null;

    if (workspaceId) {
      try {
        this.db.prepare(`
          INSERT OR IGNORE INTO workspaces (id, canonical_path, display_name, created_at, last_opened_at, availability)
          VALUES (?, ?, ?, ?, ?, 'available')
        `).run(workspaceId, workspaceId, workspaceId, Date.now(), Date.now());
      } catch {
        // ignore workspace creation error
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO threads (id, workspace_id, title, created_at, updated_at, selected_model, branch, approval_mode, turns_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]')
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = COALESCE(excluded.workspace_id, threads.workspace_id),
        title = excluded.title,
        updated_at = excluded.updated_at,
        selected_model = COALESCE(excluded.selected_model, threads.selected_model),
        branch = COALESCE(excluded.branch, threads.branch),
        approval_mode = COALESCE(excluded.approval_mode, threads.approval_mode)
    `);

    stmt.run(id, workspaceId, title, createdAt, updatedAt, modelToSave, branch, approvalMode);
    return this.get(id)!;
  }

  updateTitle(id: string, title: string): boolean {
    const res = this.db.prepare("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?").run(title.trim(), Date.now(), id);
    return res.changes > 0;
  }

  delete(id: string): boolean {
    const res = this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    return res.changes > 0;
  }

  reconcileInterruptedTurns(): number {
    const allThreads = this.list();
    let reconciledCount = 0;
    for (const thread of allThreads) {
      let modified = false;
      for (const turn of thread.turns) {
        // A pending approval has a durable approval record and can be resumed
        // after restart. Only an in-flight turn with no approval checkpoint is
        // reconciled as an interrupted failure here.
        if (turn.status === "running") {
          turn.status = "failed";
          turn.currentActivity = "failed";
          turn.completedAt = Date.now();
          if (!turn.items.some((it) => it.id === `item-${turn.id}-interrupted`)) {
            turn.items.push({
              id: `item-${turn.id}-interrupted`,
              turnId: turn.id,
              type: "agent_message",
              timestamp: Date.now(),
              text: "Turn interrupted: Server restarted while execution was in progress.",
            });
          }
          for (const item of turn.items) {
            if (item.type === "tool_execution" && item.tool?.status === "running") {
              item.tool = { ...item.tool, status: "failed", error: "Execution interrupted by server restart.", failureCategory: "interrupted" };
            }
          }
          modified = true;
          reconciledCount++;
        }
      }
      if (modified) {
        this.save(thread);
      }
    }
    return reconciledCount;
  }
}

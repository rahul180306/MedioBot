import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { TaskSubmissionError, DurableTaskEngine, ResourceGovernor } from "@mediobot-v2/runtime";
import { ToolPermissionEngine } from "@mediobot-v2/tools";
import { MaestroDecisionError, isOrdinaryConversationGoal } from "@mediobot-v2/maestro";
import { createComposition, normalizeProductEvent } from "./composition.ts";
import { SqliteDurableTaskStore } from "./storage/durableTaskStore.ts";
import { SqliteApprovalRecordStore } from "./storage/approvalStore.ts";
import type { TaskId } from "@mediobot-v2/domain";
import type { CommandCenterComposition, ProductEvent, TaskView } from "./contracts.ts";
import { LocalHistoryStore } from "./history.ts";
import type { ConversationActor, ProjectInfo, Thread, ThreadItem, Turn } from "./types/index.ts";
import { ThreadTitleService } from "./services/titleService.ts";
import { getProviderCatalog, getEnabledModels, ModelProviderError, ModelResolver, PROVIDER_CATALOG, type ThreadModelSelection } from "./runtime/modelRegistry.ts";
import { ProviderRepository, SystemCredentialStore, type ConfiguredModel, type CredentialStore } from "./storage/providerRepository.ts";
import { validateProvider, type ProviderValidationInput } from "./runtime/providerValidation.ts";
import { pickNativeDirectory } from "./nativePicker.ts";
import { categorizeFailure } from "./failureCategories.ts";
import { LocalDatabase } from "./storage/db.ts";
import { WorkspaceRepository } from "./storage/workspaceRepository.ts";
import { SqliteMediobotDefinitionRepository } from "./storage/mediobotDefinitionRepository.ts";
import { SqliteWorldIdentityRepository } from "./storage/worldIdentityRepository.ts";
import { ChatRepository } from "./storage/chatRepository.ts";
import { WorkspaceManager, type WorkspaceSession } from "./workspaceManager.ts";
import { sanitizeReasoningAndSecrets, mergeMonotonicToolData } from "@mediobot-v2/models";
import { getAppDataDirectory } from "./storage/appPaths.ts";
import { realpath } from "node:fs/promises";
import { defaultFileLockManager } from "@mediobot-v2/tools";
import { PathEscapeForbiddenError, type ExecutionScope, type UnifiedFileLockService } from "@mediobot-v2/contracts";
import { AttachmentStore, MAX_ATTACHMENT_BYTES, type StoredAttachment } from "./storage/attachmentStore.ts";
import { MultimodalContextIngestion } from "./runtime/contextIngestion.ts";

function isForbiddenPathError(error: unknown): boolean {
  if (error instanceof PathEscapeForbiddenError) return true;
  if (error && typeof error === "object") {
    const code = (error as { code?: string }).code;
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (code === "FORBIDDEN" || statusCode === 403) return true;
    const msg = (error as Error).message;
    if (typeof msg === "string" && (
      msg.includes("outside this project") ||
      msg.includes("escapes the owned workspace") ||
      msg.includes("escapes the canonical project root") ||
      msg.includes("Path traversal is not allowed") ||
      msg.includes("Absolute paths are not allowed") ||
      msg.includes("Symlinks are not allowed") ||
      msg.includes("Symbolic links are not opened")
    )) {
      return true;
    }
  }
  return false;
}

try {
  if (typeof process.loadEnvFile === "function") {
    const candidates = [
      path.resolve(process.cwd(), ".env"),
      path.resolve(process.cwd(), "../../.env"),
      path.resolve(fileURLToPath(import.meta.url), "../../../../.env"),
    ];
    for (const p of candidates) {
      try { process.loadEnvFile(p); break; } catch {}
    }
  }
} catch {}


function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request: import("node:http").IncomingMessage, maxBytes = 32_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) throw new Error("request-too-large");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("invalid-json"); }
}

function hasJsonContentType(request: import("node:http").IncomingMessage): boolean {
  return String(request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function taskErrorMessage(error: unknown): { status: number; body: object } {
  if (error instanceof TaskSubmissionError && error.reason === "not-configured") return { status: 409,
    body: { error: { code: "not-configured", message: "Mediobot can't start because a text reasoning model is not configured." } } };
  if (error instanceof TaskSubmissionError && error.reason === "not-executable") return { status: 409,
    body: { error: { code: "not-executable", message: "That Mediobot is not available to run tasks yet." } } };
  return { status: 400, body: { error: { code: "invalid-request", message: "Check the task details and try again." } } };
}

function directTurnErrorMessage(error: unknown): { status: number; body: object; category: string } {
  if (error instanceof MaestroDecisionError) {
    const message = error.category === "structural"
      ? "Maestro's model decision did not match the supported execution format; no specialist work started."
      : "Maestro rejected the model's assignment during semantic validation; no specialist work started.";
    return { status: 502, category: "invalid-maestro-decision",
      body: { error: { code: "invalid-maestro-decision", message } } };
  }
  if (error instanceof ModelProviderError) {
    const mapped: Record<ModelProviderError["code"], { readonly status: number; readonly message: string }> = {
      configuration: { status: 409, message: "The selected provider or model is no longer available. Check its connection in Settings." },
      authentication: { status: 502, message: "The selected provider rejected authentication. Check its connection in Settings." },
      capacity: { status: 503, message: "The selected provider is at capacity. Try again later." },
      timeout: { status: 504, message: "The selected model request timed out." },
      cancelled: { status: 499, message: "The model request was cancelled." },
      transport: { status: 502, message: "Mediobot could not reach the selected model provider." },
      "invalid-response": { status: 502, message: "The selected model returned a response Mediobot could not use." },
      "structured-parse": { status: 502, message: "Maestro could not interpret the selected model's decision." },
      "unsupported-modality": { status: 400, message: "The selected model cannot handle this request." },
    };
    const result = mapped[error.code];
    return { status: result.status, category: error.code, body: { error: { code: error.code, message: result.message } } };
  }
  return { status: 500, category: "runtime-failure",
    body: { error: { code: "runtime-failure", message: "Mediobot could not complete this conversation turn." } } };
}

function explicitlyRequestsVerification(prompt: string): boolean {
  return /\b(?:independently\s+)?(?:verify|validate|check)\s+(?:(?:the|this|that|its|their)\s+)?(?:result|implementation|changes?|code|behavior|output|work|it)\b/i.test(prompt)
    || /\b(?:run|execute)\s+(?:the\s+)?tests?\b/i.test(prompt)
    || /\btest\s+(?:(?:the|this|its|their)\s+)?(?:result|implementation|changes?|code|behavior|it)\b/i.test(prompt);
}

export function summarizePreviousTurnExecution(turn: Turn): string {
  const tools = turn.items.filter((it) => it.type === "tool_execution" && it.tool);
  const diffs = turn.items.filter((it) => it.type === "diff" && it.diff);
  const failedTool = tools.find((it) => it.tool?.status === "failed");

  const toolSummaries = tools.map((it) => {
    const t = it.tool!;
    const name = t.command || t.toolName;
    if (t.status === "failed") {
      const err = t.error || t.outputLog || "error details unavailable";
      return `${name} (failed: ${err})`;
    }
    return `${name} (${t.status})`;
  });

  let changeStatus: string;
  if (diffs.length > 0) {
    const files = diffs.map((d) => d.diff!.filePath).join(", ");
    changeStatus = `Partial changes made to ${diffs.length} file(s) (${files})`;
  } else {
    changeStatus = "No changes made to workspace";
  }

  let failureSummary = "";
  if (turn.status === "failed") {
    if (failedTool?.tool?.error) {
      failureSummary = `Failed tool: ${failedTool.tool.toolName} with error: "${failedTool.tool.error}"`;
    } else {
      // Prefer a detailed specialist failure report over the generic turn
      // lifecycle message, which may be appended later and hide the reason.
      const agentMessages = turn.items.filter((it) => it.type === "agent_message" && it.text);
      const failureMsg = agentMessages.find((it) => it.text!.includes("Failure reason:"))
        ?? agentMessages.find((it) => it.text!.startsWith("Turn ended:")
          && !/could not complete the task\.?$/i.test(it.text!));
      if (failureMsg?.text) {
        failureSummary = failureMsg.text;
      } else {
        failureSummary = "Underlying failure reason is unavailable.";
      }
    }
  }

  const lines = [
    `Previous turn (status: ${turn.status}):`,
    `- User prompt: "${turn.prompt.slice(0, 200)}"`,
    `- Workspace changes: ${changeStatus}`,
    `- Executed tools: ${toolSummaries.length ? toolSummaries.join(", ") : "none"}`,
  ];
  if (failureSummary) {
    lines.push(`- Failure details: ${failureSummary}`);
  }
  return lines.join("\n");
}

function sessionToProject(session: WorkspaceSession): ProjectInfo {
  return {
    id: session.workspaceId,
    name: session.displayName,
    path: session.canonicalRootPath,
    branch: "main",
    branches: ["main"],
    environment: "Local",
  };
}

/** Local in-memory bounded cache with FIFO eviction to prevent unbounded memory growth. */
class BoundedMap<K, V> {
  private readonly max: number;
  private readonly map = new Map<K, V>();
  constructor(max = 500) {
    this.max = max;
  }
  get(key: K): V | undefined {
    return this.map.get(key);
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
    return this;
  }
  delete(key: K): boolean {
    return this.map.delete(key);
  }
  values() {
    return this.map.values();
  }
  keys() {
    return this.map.keys();
  }
  get size() {
    return this.map.size;
  }
}

export type TurnExecutionKey = string;
export const compositeTurnKey = (threadId: string, turnId: string): TurnExecutionKey =>
  JSON.stringify([threadId, turnId]);

type TurnStartResult = {
  readonly turnId: string;
  readonly taskId?: string;
  readonly direct?: boolean;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly modelExecution?: unknown;
  readonly timing?: Record<string, unknown>;
};
class ProjectWorkspaceMismatchError extends Error {
  constructor() { super("This conversation belongs to a different project. Switch back to its project before continuing."); }
}
type SettledTurn =
  | { readonly kind: "task"; readonly taskId: TaskView["id"]; readonly threadId: string; readonly turnId: string }
  | { readonly kind: "conversation"; readonly threadId: string; readonly turnId: string; readonly status: Turn["status"] };

export async function startCommandCenter(options: {
  readonly host?: string;
  readonly port?: number;
  readonly composition?: CommandCenterComposition;
  readonly historyStore?: LocalHistoryStore;
  readonly workspaceManager?: WorkspaceManager;
  readonly workspaceRoot?: string;
  readonly vite?: boolean;
  readonly listen?: boolean;
  readonly databasePath?: string;
  readonly providerRepository?: ProviderRepository;
  /** Explicit injection point for isolated tests; production defaults to the OS credential vault. */
  readonly credentialStoreFactory?: (database: LocalDatabase["raw"]) => CredentialStore;
  readonly modelResolver?: ModelResolver;
  readonly providerValidator?: (input: ProviderValidationInput) => Promise<void>;
  readonly defaultApprovalMode?: string;
  readonly permissionEngine?: ToolPermissionEngine;
  readonly resourceGovernor?: ResourceGovernor;
  readonly fileLockManager?: UnifiedFileLockService;
} = {}) {
  const fileLockManager = options.fileLockManager ?? defaultFileLockManager;
  const db = new LocalDatabase(options.databasePath);
  const workspaceRepo = new WorkspaceRepository(db.raw);
  const chatRepo = new ChatRepository(db.raw);
  const credentialStore = options.credentialStoreFactory?.(db.raw) ?? new SystemCredentialStore(db.raw);
  const providerRepo = options.providerRepository ?? new ProviderRepository(db.raw, credentialStore);
  const durableTaskStore = new SqliteDurableTaskStore(db.raw);
  const mediobotDefinitionRepository = new SqliteMediobotDefinitionRepository(db.raw);
  const durableTaskEngine = new DurableTaskEngine(durableTaskStore, (diagnostic) =>
    process.stderr.write(`${JSON.stringify({ event: "durable.task.diagnostic", ...diagnostic })}\n`)
  );
  const worldIdentity = new SqliteWorldIdentityRepository(db.raw).getOrCreate();
  try {
    await durableTaskEngine.reconcileOnStartup();
  } catch {
    // Non-fatal if schema not migrated or read-only test DB
  }
  if (!options.databasePath) {
    try { providerRepo.syncFromCatalog(PROVIDER_CATALOG); } catch {}
  }
  const modelResolver = options.modelResolver ?? new ModelResolver(providerRepo);
  if (options.resourceGovernor && typeof (options.resourceGovernor as any).toModelAdmissionPort === "function") {
    modelResolver.connectAdmissionPort?.((options.resourceGovernor as any).toModelAdmissionPort());
  }

  // In-flight synchronization barrier: represents in-flight execution only
  const inFlightTurns = new Map<TurnExecutionKey, Promise<TurnStartResult>>();
  const approvalResumeInFlight = new Map<string, Promise<void>>();
  // Settled mapping: separately maintained with the SAME composite key, bounded lifecycle
  const settledTurns = new BoundedMap<TurnExecutionKey, SettledTurn>(500);
  const turnAbortControllers = new Map<TurnExecutionKey, AbortController>();
  const directTurnSubscribers = new Map<TurnExecutionKey, Set<(event: Record<string, unknown>) => void>>();
  const directTurnEvents = new BoundedMap<TurnExecutionKey, Array<Record<string, unknown>>>(500);

  const emitDirectTurnEvent = (turnKey: TurnExecutionKey, event: Record<string, unknown>): void => {
    const buffered = directTurnEvents.get(turnKey) ?? [];
    buffered.push(event);
    directTurnEvents.set(turnKey, buffered);
    const subs = directTurnSubscribers.get(turnKey);
    if (subs) {
      for (const sub of subs) {
        try { sub(event); } catch {}
      }
    }
  };

  let compositionRef: CommandCenterComposition | undefined = options.composition;
  const workspaceManager = options.workspaceManager ?? new WorkspaceManager(workspaceRepo, options.workspaceRoot, {
    fileLockManager,
    onBeforeSwitch: async () => {
      // 1. Abort any in-flight turns
      for (const [, controller] of turnAbortControllers) {
        try { controller.abort(); } catch {}
      }
      turnAbortControllers.clear();

      // 2. Safely cancel active composition tasks
      if (compositionRef) {
        const tasks = compositionRef.world.inspect().tasks;
        for (const task of tasks) {
          if (task.state === "created" || task.state === "assigned" || task.state === "running") {
            try { compositionRef.cancel(task.id); } catch {}
          }
        }
      }
    },
  });
  const defaultMode = (options.defaultApprovalMode as any) ?? "Approve for me";
  const permissionEngine = options.permissionEngine ?? new ToolPermissionEngine({
    defaultPolicy: { mode: defaultMode },
    approvalStore: new SqliteApprovalRecordStore(db.raw),
  });
  const composition = options.composition ?? createComposition({
    workspaceRoot: workspaceManager.session?.canonicalRootPath,
    fileLockManager,
    modelResolver,
    durableTaskEngine,
    permissionEngine,
    resourceGovernor: options.resourceGovernor,
    checkpointDatabasePath: db.path,
    checkpointDatabase: db.raw,
    mediobotDefinitionRepository,
    worldIdentity,
  });
  compositionRef = composition;
  const readTaskView = async (taskId: TaskId) => composition.getTaskView
    ? composition.getTaskView(taskId)
    : composition.snapshotTask(taskId);
  const taskWorkspaceIds = new Map<TaskId, string | null>();
  const rememberTaskWorkspace = (taskId: TaskId, workspaceId: string | null) => {
    taskWorkspaceIds.delete(taskId);
    taskWorkspaceIds.set(taskId, workspaceId);
    if (taskWorkspaceIds.size > 500) {
      const activeIds = new Set(composition.world.inspect().tasks
        .filter((task) => !["completed", "failed", "cancelled"].includes(task.state))
        .map((task) => task.id as TaskId));
      for (const knownTaskId of taskWorkspaceIds.keys()) {
        if (!activeIds.has(knownTaskId)) taskWorkspaceIds.delete(knownTaskId);
        if (taskWorkspaceIds.size <= 500) break;
      }
    }
  };
  const taskIsInActiveWorkspace = async (taskId: TaskId): Promise<boolean> => {
    const engine = composition.durableTaskEngine ?? durableTaskEngine;
    const activeWorkspaceId = workspaceManager.status === "OPEN" ? workspaceManager.session?.workspaceId ?? null : null;
    const task = await engine?.getTask(taskId);
    if (task) return task.workspaceId === activeWorkspaceId;
    // Some in-memory compositions used by tests or embedded callers do not
    // persist task records. Keep their task routes scoped to the workspace
    // captured at submission; an unregistered task fails closed.
    return taskWorkspaceIds.has(taskId) && taskWorkspaceIds.get(taskId) === activeWorkspaceId
      && Boolean(await readTaskView(taskId));
  };
  const addRecoveryState = async (thread: Thread): Promise<Thread> => {
    const engine = composition.durableTaskEngine ?? durableTaskEngine;
    if (!engine) return thread;
    const turns = await Promise.all(thread.turns.map(async (turn) => {
      if (!turn.taskId) return turn;
      const task = await engine.getTask(turn.taskId).catch(() => null);
      return task && task.threadId === thread.id && task.turnId === turn.id
        && (task.status === "interrupted" || task.status === "queued" || task.status === "paused")
        ? { ...turn, status: task.status === "paused" ? "paused" : turn.status, recoveryState: task.status }
        : turn;
    }));
    return { ...thread, turns };
  };

  const actorForDefinition = (definitionId?: string): ConversationActor | undefined => {
    if (!definitionId) return undefined;
    const definition = composition.definitions.find((candidate) => candidate.id === definitionId);
    if (!definition) return undefined;
    const presentationId = definition.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { type: "mediobot", mediobotId: definition.id, presentationId, name: definition.name };
  };
  const maestroActor: ConversationActor = actorForDefinition(composition.maestroDefinitionId) ?? { type: "mediobot", mediobotId: "maestro", name: "Maestro" };
  const actorForProductEvent = (type: ProductEvent["type"], definitionId?: string): ConversationActor => {
    if (type === "worker.assigned") return maestroActor;
    if (type === "maestro.responded") return actorForDefinition(definitionId) ?? maestroActor;
    return actorForDefinition(definitionId) ?? { type: "system" };
  };
  const isLowLevelProgress = (event: ProductEvent): boolean => {
    if (event.type !== "worker.progress") return false;
    const message = event.message?.trim();
    return !message || /^(?:filesystem|terminal|web)\.[a-z0-9_.-]+$/i.test(message)
      || /^(?:cody|worker)\.[a-z0-9_.-]+$/i.test(message)
      || /^(?:[\w -]+\s+)?progress\.?$/i.test(message) || message === "request_support";
  };

  const mapProductEventToRuntimeEvent = (
    event: ProductEvent,
    threadId: string,
    turnId: string
  ): Record<string, unknown> => {
    const type = event.type;
    const terminal = type === "task.completed" || type === "task.failed" || type === "task.cancelled";
    const failureCategory = event.error ? categorizeFailure(event.error.message) : undefined;
    const safeError = failureCategory === "repeated action" && event.error?.message.startsWith("Cody stopped after repeating ")
      ? event.error.message : failureCategory;
    const structural = type.startsWith("tool.") || ["task.started", "worker.started", "worker.completed", "worker.cancelled"].includes(type);
    const rawMessage = safeError ?? event.message ?? (structural ? "" : type === "worker.assigned" ? `Assigned: ${event.workerName ?? "specialist"}` : type === "task.cancelled" ? "Task cancelled." : type === "task.completed" ? "Task completed." :
      event.workerName ? `${event.workerName} ${type.replace(/^worker\./, "").replaceAll(".", " ")}.` : "Mediobot is working on the task.");
    const safeRawMessage = type === "worker.assigned"
      ? `Assigned: ${rawMessage.replace(/^I[’']ve assigned .+? to:\s*/i, "")}` : rawMessage;
    const message = sanitizeReasoningAndSecrets(safeRawMessage);
    const lowLevelProgress = isLowLevelProgress(event);
    const toolStatus: import("./types/index.ts").ToolExecutionData["status"] = type === "tool.started" ? "running" : type === "tool.failed" ? "failed"
      : type === "tool.cancelled" ? "cancelled" : "success";

    return {
      id: event.id,
      ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
      ...(event.workerId ? { workerId: event.workerId } : {}),
      ...(event.workerDefinitionId ? { workerDefinitionId: event.workerDefinitionId } : {}),
      ...(event.workerName ? { workerName: event.workerName } : {}),
      taskId: event.taskId,
      ...(event.executionTaskId ? { executionTaskId: event.executionTaskId } : {}),
      type: type === "maestro.responded" ? "agent.progress" : event.type === "file.changed" && event.diff ? "diff.created"
        : type === "approval.required" || type === "approval.resolved" ? type
        : type === "task.pause_requested" || type === "task.paused" || type === "task.resumed" ? type
        : terminal ? type : type.startsWith("worker.") ? type : type === "task.started" ? "agent.started"
        : type.startsWith("tool.") ? type : "agent.progress",
      turnId, threadId, timestamp: event.occurredAt,
      payload: type === "worker.assigned"
        ? { item: { id: event.id, turnId, type: "activity", actor: maestroActor, timestamp: event.occurredAt,
          text: message, activityLabel: `Assigned ${event.workerName ?? "specialist"}`,
          activityDetail: message.replace(/^Assigned:\s*/, "").slice(0, 400), activityState: "planning" } }
        : type === "maestro.responded" || type === "worker.message"
        ? { ...(event.activityState ? { activityState: event.activityState } : {}), item: { id: event.id, turnId, type: "agent_message", actor: actorForProductEvent(type, event.workerDefinitionId), timestamp: event.occurredAt, text: message,
          ...(event.activityState ? { activityState: event.activityState } : {}) } }
        : lowLevelProgress ? { ...(event.message?.trim() ? { message } : {}), ...(event.activityState ? { activityState: event.activityState } : {}) }
        : type === "approval.required" && event.approval ? { item: { id: `approval-${event.approval.approvalId}`, turnId, type: "approval_request", actor: actorForDefinition(event.workerDefinitionId), timestamp: event.occurredAt, approval: event.approval } }
        : type === "approval.resolved" && event.approval ? { approval: event.approval }
        : event.type === "file.changed" && event.diff ? { item: { id: event.id, turnId, type: "diff", ...(actorForDefinition(event.workerDefinitionId) ? { actor: actorForDefinition(event.workerDefinitionId) } : {}), timestamp: event.occurredAt, diff: event.diff } }
        : terminal ? { ...(type === "task.failed" ? { item: { id: `${event.id}-failure`, turnId, type: "agent_message", actor: actorForProductEvent(type, event.workerDefinitionId), timestamp: event.occurredAt, text: `Turn ended: ${message}` } } : {}), summary: message }
        : type.startsWith("tool.") ? { item: {
            id: event.toolInvocationId!,
            turnId,
            type: "tool_execution",
            ...(actorForDefinition(event.workerDefinitionId) ? { actor: actorForDefinition(event.workerDefinitionId) } : {}),
            timestamp: event.occurredAt,
            text: message,
            tool: {
              toolName: event.toolName ?? "Mediobot tool",
              toolInvocationId: event.toolInvocationId,
              command: event.command,
              workingDirectory: event.workingDirectory,
              recoveryReason: event.recoveryReason,
              status: toolStatus,
              startedAt: event.startedAt ?? event.occurredAt,
              durationMs: event.durationMs,
              error: event.type === "tool.failed" ? (event.error?.message ?? "Tool operation failed.") : undefined,
              errorCode: event.errorCode,
              failureCategory: event.failureCategory,
              recoveredFromExecution: event.recoveredFromExecution,
              isVerification: event.isVerification,
              verificationStatus: event.verificationStatus,
              exitCode: event.exitCode,
              terminationSignal: event.terminationSignal,
              stdoutBytes: event.stdoutBytes,
              stderrBytes: event.stderrBytes,
              eventSequence: event.sequence,
            } } }
        : { ...(event.activityState ? { activityState: event.activityState } : {}), ...(message ? { message, item: { id: event.id, turnId, type: "activity", actor: actorForProductEvent(type, event.workerDefinitionId), timestamp: event.occurredAt,
          text: message, activityLabel: message, ...(event.activityState ? { activityState: event.activityState } : {}) } } : {}) },
    };
  };
  const settleToolAttemptsSuspendedForApproval = (turn: Turn, specialistId?: string) => {
    if (!specialistId) return;
    for (const item of turn.items) {
      if (item.type !== "tool_execution" || item.actor?.type !== "mediobot" || item.actor.mediobotId !== specialistId || item.tool?.status !== "running") continue;
      item.tool = { ...item.tool, status: "cancelled" };
      item.text = "This tool invocation ended while awaiting approval; the resumed action is recorded separately.";
    }
  };
  const productRuntime = options.composition === undefined;
  const history = options.historyStore ?? new LocalHistoryStore(undefined, chatRepo);
  const attachmentStore = new AttachmentStore(getAppDataDirectory());

  const projectDurableEventsIntoTurn = async (
    threadId: string,
    turnId: string,
    events: readonly ProductEvent[],
    afterSequence: number,
  ): Promise<void> => {
    const unseen = [...events].filter((event) => (event.sequence ?? 0) > afterSequence)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    if (!unseen.length) return;
    const attributedEvents = await Promise.all(unseen.map(async (event) => {
      if (event.workerDefinitionId || !event.executionTaskId || !composition.durableTaskEngine) return event;
      const execution = await composition.durableTaskEngine.getTask(event.executionTaskId).catch(() => null);
      return execution?.definitionId ? { ...event, workerDefinitionId: execution.definitionId as ProductEvent["workerDefinitionId"] } : event;
    }));

    await history.updateTurn(threadId, turnId, (turn) => {
      const upsertItem = (item: ThreadItem | undefined) => {
        if (!item) return;
        const index = turn.items.findIndex((existing) => existing.id === item.id);
        if (index < 0) {
          turn.items.push(item);
          return;
        }
        const existing = turn.items[index]!;
        if (existing.type === "tool_execution" && item.type === "tool_execution" && existing.tool && item.tool) {
          turn.items[index] = { ...existing, ...item, tool: mergeMonotonicToolData(existing.tool, item.tool) };
        } else {
          turn.items[index] = { ...existing, ...item };
        }
      };

      for (const event of attributedEvents) {
        const mapped = mapProductEventToRuntimeEvent(event, threadId, turnId) as {
          type: string;
          timestamp: number;
          payload?: { item?: ThreadItem; approval?: { approvalId: string; status: import("./types/index.ts").ApprovalStatus } };
        };
        const sequence = event.sequence ?? 0;
        turn.lastEventSequence = Math.max(turn.lastEventSequence ?? 0, sequence);

        if (mapped.type === "approval.required") {
          upsertItem(mapped.payload?.item);
          turn.status = "waiting_approval";
          turn.currentActivity = "waiting_for_approval";
        } else if (mapped.type === "approval.resolved" && mapped.payload?.approval) {
          const approval = mapped.payload.approval;
          const item = turn.items.find((candidate) => candidate.type === "approval_request"
            && candidate.approval?.approvalId === approval.approvalId);
          if (item?.approval) {
            item.approval = { ...item.approval, status: approval.status };
            item.actor ??= actorForDefinition(event.workerDefinitionId);
          }
          settleToolAttemptsSuspendedForApproval(turn, event.workerDefinitionId);
          if (turn.status === "waiting_approval") {
            turn.status = "running";
            turn.currentActivity = "running";
          }
        } else if (mapped.type.startsWith("tool.") || mapped.type === "diff.created" || mapped.type === "agent.progress") {
          upsertItem(mapped.payload?.item);
        } else if (mapped.type === "task.pause_requested") {
          turn.status = "pause_requested";
          turn.currentActivity = "waiting";
        } else if (mapped.type === "task.paused") {
          turn.status = "paused";
          turn.currentActivity = "waiting";
        } else if (mapped.type === "task.resumed") {
          turn.status = "running";
          turn.currentActivity = "running";
          turn.recoveryState = undefined;
        } else if (mapped.type === "task.completed" || mapped.type === "task.failed" || mapped.type === "task.cancelled") {
          turn.status = mapped.type === "task.completed" ? "completed" : mapped.type === "task.cancelled" ? "cancelled" : "failed";
          turn.currentActivity = turn.status === "cancelled" ? "completed" : turn.status;
          turn.completedAt = mapped.timestamp;
          upsertItem(mapped.payload?.item);
        } else if (mapped.type === "agent.started") {
          turn.status = "running";
          turn.currentActivity = "running";
        }
      }
    });
  };

  // Reconcile stale running turns from previous process death
  await history.reconcileInterruptedTurns();

  // Safe startup metadata logging
  console.log(`Persistence: SQLite\nDatabase: application-data\nSchema version: ${db.currentSchemaVersion}`);

  if (!workspaceManager.session && options.composition?.projects) {
    const initialList = await options.composition.projects.list();
    if (initialList.length > 0) {
      await workspaceManager.openWorkspace(initialList[0].path);
    }
  }
  const vite = options.vite === false ? undefined : await createViteServer({
    configFile: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../vite.config.ts"),
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "spa",
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/api/dev/persistence-health") {
        let writable = false;
        try {
          const testStmt = db.raw.prepare("SELECT 1 as ok").get() as { ok: number } | undefined;
          writable = testStmt?.ok === 1;
        } catch {
          writable = false;
        }
        json(response, 200, {
          provider: "sqlite",
          schemaVersion: db.currentSchemaVersion,
          writable,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/system/resources") {
        const governor = composition.resourceGovernor;
        if (!governor) {
          json(response, 503, { error: { code: "not-available", message: "Resource governor is not available" } });
          return;
        }
        json(response, 200, governor.getStatus());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/definitions") {
        json(response, 200, { definitions: composition.definitions });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/definitions") {
        if (!composition.registerSpecialist) { json(response, 503, { error: { code: "unavailable", message: "Specialist registration is unavailable" } }); return; }
        if (!hasJsonContentType(request)) { json(response, 415, { error: { code: "unsupported-media-type", message: "Send registration data as application/json" } }); return; }
        try {
          const value = await body(request, 12_000) as Record<string, unknown>;
          if (!value || typeof value.name !== "string" || typeof value.role !== "string"
            || typeof value.version !== "string" || typeof value.instructions !== "string") throw new Error("Invalid Mediobot registration fields");
          if (value.capabilities !== undefined && (!Array.isArray(value.capabilities)
            || value.capabilities.some(capability => typeof capability !== "string"))) throw new Error("Invalid specialist capabilities");
          const definition = composition.registerSpecialist({ name: value.name, role: value.role,
            version: value.version, instructions: value.instructions,
            ...(value.capabilities !== undefined ? { capabilities: value.capabilities as string[] } : {}) });
          json(response, 201, { definition });
        } catch (error) {
          json(response, 400, { error: { code: "invalid-registration", message: error instanceof Error ? error.message : "Invalid Mediobot registration" } });
        }
        return;
      }

      const lifecycleMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)\/lifecycle$/);
      if (request.method === "PATCH" && lifecycleMatch) {
        if (!composition.setSpecialistLifecycle) { json(response, 503, { error: { code: "unavailable", message: "Specialist lifecycle management is unavailable" } }); return; }
        if (!hasJsonContentType(request)) { json(response, 415, { error: { code: "unsupported-media-type", message: "Send lifecycle changes as application/json" } }); return; }
        try {
          const value = await body(request, 2_000) as Record<string, unknown>;
          if (!value || !["active", "draining", "disabled"].includes(String(value.state))) throw new Error("Invalid Mediobot lifecycle state");
          const definitionId = decodeURIComponent(lifecycleMatch[1]!) as import("@mediobot-v2/domain").MediobotDefinitionId;
          const definition = composition.setSpecialistLifecycle(definitionId, value.state as import("@mediobot-v2/domain").MediobotLifecycleState);
          json(response, 200, { definition });
        } catch (error) {
          json(response, 409, { error: { code: "lifecycle-transition-rejected", message: error instanceof Error ? error.message : "Lifecycle transition rejected" } });
        }
        return;
      }

      const definitionMatch = url.pathname.match(/^\/api\/definitions\/([^/]+)$/);
      if (request.method === "DELETE" && definitionMatch) {
        if (!composition.removeSpecialist) { json(response, 503, { error: { code: "unavailable", message: "Specialist removal is unavailable" } }); return; }
        try {
          const definitionId = decodeURIComponent(definitionMatch[1]!) as import("@mediobot-v2/domain").MediobotDefinitionId;
          composition.removeSpecialist(definitionId);
          json(response, 200, { removed: true, definitionId });
        } catch (error) {
          json(response, 409, { error: { code: "removal-rejected", message: error instanceof Error ? error.message : "Mediobot removal rejected" } });
        }
        return;
      }

      // --- Provider & Model Registry Endpoints ---
      if (request.method === "GET" && url.pathname === "/api/providers/catalog") {
        json(response, 200, { catalog: getProviderCatalog() });
        return;
      }

      const publicProvider = (provider: ReturnType<ProviderRepository["list"]>[number]) => {
        const { customHeaders: _privateHeaders, credentialRef: _credentialRef, ...safe } = provider;
        return safe;
      };

      if (request.method === "GET" && url.pathname === "/api/providers") {
        json(response, 200, { providers: providerRepo.list().map(publicProvider) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/providers") {
        json(response, 410, { error: { message: "Choose a provider in Settings and validate its configuration before connecting." } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/providers/connect") {
        let value: unknown;
        try { value = await body(request); } catch {
          json(response, 400, { error: { message: "Invalid provider payload." } });
          return;
        }
        if (!value || typeof value !== "object") {
          json(response, 400, { error: { message: "Invalid provider payload." } });
          return;
        }
        const data = value as Record<string, unknown>;
        const id = typeof data.id === "string" ? data.id.trim() : "";
        const displayName = typeof data.displayName === "string" ? data.displayName.trim() : (typeof data.name === "string" ? (data.name as string).trim() : id);
        const providerType = typeof data.providerType === "string" ? data.providerType.trim() : id;

        if (!id) {
          json(response, 400, { error: { message: "Provider ID is required." } });
          return;
        }

        const catalogEntry = getProviderCatalog().find((provider) => provider.id === providerType || provider.id === id);
        if (!catalogEntry) { json(response, 400, { error: { message: "Choose a provider from the catalog." } }); return; }
        let models: ConfiguredModel[] = Array.isArray(data.models) ? (data.models as ConfiguredModel[]) : [];
        if (models.length === 0) {
          models = catalogEntry.defaultModels.map((m) => ({ id: m.id, name: m.name, enabled: true,
            capabilities: m.capabilities, context: m.context, tag: m.tag, description: m.description }));
        }

        const apiKey = typeof data.apiKey === "string" ? data.apiKey : undefined;
        const baseUrl = catalogEntry.configurableBaseUrl
          ? (typeof data.baseUrl === "string" ? data.baseUrl.trim() : undefined)
          : catalogEntry.defaultBaseUrl;
        const customHeaders = Array.isArray(data.customHeaders) ? data.customHeaders : undefined;
        try {
          await (options.providerValidator ?? ((input) => validateProvider(input)))({
            provider: catalogEntry, baseUrl, apiKey,
            modelId: typeof data.modelId === "string" ? data.modelId : models[0]?.id,
            customHeaders: customHeaders as ProviderValidationInput["customHeaders"],
          });
        } catch (error) {
          json(response, 422, { error: { message: error instanceof Error ? error.message : "Provider validation failed." } });
          return;
        }
        const saved = providerRepo.save(
          {
            id,
            providerType,
            displayName,
            baseUrl,
            models,
            customHeaders: customHeaders as ProviderValidationInput["customHeaders"],
            connected: true,
            enabled: data.enabled !== false,
            badge: typeof data.badge === "string" ? data.badge : undefined,
            iconType: typeof data.iconType === "string" ? data.iconType : providerType,
            description: typeof data.description === "string" ? data.description : undefined,
          },
          apiKey
        );

        json(response, 200, { provider: publicProvider(saved) });
        return;
      }

      const providerPath = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
      if (request.method === "DELETE" && providerPath) {
        const provId = decodeURIComponent(providerPath[1]!);
        const ok = providerRepo.delete(provId);
        json(response, 200, { ok });
        return;
      }

      if (request.method === "PATCH" && providerPath) {
        let value: unknown;
        try { value = await body(request); } catch {
          json(response, 400, { error: { message: "Invalid payload." } });
          return;
        }
        const provId = decodeURIComponent(providerPath[1]!);
        if (value && typeof value === "object" && "enabled" in value && typeof value.enabled === "boolean") {
          const ok = providerRepo.updateEnabled(provId, value.enabled);
          json(response, 200, { ok });
          return;
        }
        json(response, 400, { error: { message: "Specify enabled boolean." } });
        return;
      }

      const providerModelPath = url.pathname.match(/^\/api\/providers\/([^/]+)\/models\/([^/]+)$/);
      if (request.method === "PATCH" && providerModelPath) {
        let value: unknown;
        try { value = await body(request); } catch {
          json(response, 400, { error: { message: "Invalid payload." } });
          return;
        }
        const provId = decodeURIComponent(providerModelPath[1]!);
        const modelId = decodeURIComponent(providerModelPath[2]!);
        if (value && typeof value === "object" && "enabled" in value && typeof value.enabled === "boolean") {
          const ok = providerRepo.updateModelEnabled(provId, modelId, value.enabled);
          json(response, 200, { ok });
          return;
        }
        json(response, 400, { error: { message: "Specify enabled boolean." } });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/models/enabled") {
        json(response, 200, { models: getEnabledModels(providerRepo) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/models") {
        json(response, 200, {
          models: getEnabledModels(providerRepo),
          catalog: getProviderCatalog(),
          providers: providerRepo.list().map(publicProvider),
        });
        return;
      }

      // --- Canonical Workspace Lifecycle Endpoints ---
      if (request.method === "GET" && url.pathname === "/api/workspace") {
        json(response, 200, {
          status: workspaceManager.status,
          session: workspaceManager.session,
          uiState: workspaceManager.getUIState(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/workspace/open") {
        let value: unknown;
        try { value = await body(request); } catch { /* optional body */ }
        const requestedPath =
          value && typeof value === "object"
            ? ("path" in value && typeof value.path === "string"
                ? value.path.trim()
                : "preferredPath" in value && typeof value.preferredPath === "string"
                ? value.preferredPath.trim()
                : undefined)
            : undefined;

        if (requestedPath) {
          try {
            const session = await workspaceManager.openWorkspace(requestedPath);
            json(response, 200, { session, uiState: workspaceManager.getUIState(), cancelled: false });
          } catch (error) {
            json(response, 400, { error: { message: error instanceof Error ? error.message : "The project folder could not be opened." } });
          }
          return;
        }

        const picked = await pickNativeDirectory();
        if (picked.cancelled || !picked.path) {
          json(response, 200, { cancelled: true });
          return;
        }

        try {
          const session = await workspaceManager.openWorkspace(picked.path);
          json(response, 200, { session, uiState: workspaceManager.getUIState(), cancelled: false });
        } catch (error) {
          json(response, 400, { error: { message: error instanceof Error ? error.message : "The project folder could not be opened." } });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/workspace/close") {
        workspaceManager.closeWorkspace();
        json(response, 200, { ok: true, status: "EMPTY", session: null });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/workspace/ui-state") {
        json(response, 200, { uiState: workspaceManager.getUIState() });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/workspace/ui-state") {
        let value: unknown;
        try { value = await body(request); } catch { json(response, 400, { error: { message: "Invalid UI state." } }); return; }
        if (value && typeof value === "object") {
          const activeFile = "activeFile" in value && typeof value.activeFile === "string" ? value.activeFile : null;
          const openTabs = "openTabs" in value && Array.isArray(value.openTabs) ? value.openTabs : [];
          const expandedPaths = "expandedPaths" in value && Array.isArray(value.expandedPaths) ? value.expandedPaths : [];
          const workbenchTabs = "workbenchTabs" in value && Array.isArray(value.workbenchTabs) ? value.workbenchTabs : [];
          const activeWorkbenchTabId = "activeWorkbenchTabId" in value && typeof value.activeWorkbenchTabId === "string" ? value.activeWorkbenchTabId : null;
          workspaceManager.saveUIState(activeFile, openTabs, expandedPaths, workbenchTabs, activeWorkbenchTabId);
          json(response, 200, { ok: true });
          return;
        }
        json(response, 400, { error: { message: "Invalid UI state payload." } });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/workspace/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        response.write(": connected\n\n");

        const unsubscribe = workspaceManager.subscribe((event) => {
          response.write(`event: workspace\ndata: ${JSON.stringify(event)}\n\n`);
        });

        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
        response.on("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
        });
        return;
      }

      // --- Backward-compatible Project Routes ---
      if (request.method === "GET" && url.pathname === "/api/projects") {
        const session = workspaceManager.session;
        if (session && workspaceManager.status === "OPEN") {
          json(response, 200, { projects: [sessionToProject(session)] });
        } else {
          json(response, 200, { projects: [] });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        let value: unknown;
        try { value = await body(request); } catch { json(response, 400, { error: { message: "Choose a valid local project folder." } }); return; }
        if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string") {
          json(response, 400, { error: { message: "Choose a valid local project folder." } }); return;
        }
        try {
          const session = await workspaceManager.openWorkspace(value.path);
          json(response, 201, { project: sessionToProject(session) });
        } catch (error) {
          json(response, 400, { error: { message: error instanceof Error ? error.message : "The project folder could not be added." } });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/workspace/pick-directory") {
        let value: unknown;
        try { value = await body(request); } catch { /* empty body allowed */ }
        const requestedPath = value && typeof value === "object" && "path" in value && typeof value.path === "string" ? value.path.trim() : undefined;
        if (requestedPath) {
          try {
            const session = await workspaceManager.openWorkspace(requestedPath);
            json(response, 200, { project: sessionToProject(session), cancelled: false });
          } catch (error) {
            json(response, 400, { error: { message: error instanceof Error ? error.message : "The project folder could not be added." } });
          }
          return;
        }
        const picked = await pickNativeDirectory();
        if (picked.cancelled || !picked.path) {
          json(response, 200, { cancelled: true });
          return;
        }
        try {
          const session = await workspaceManager.openWorkspace(picked.path);
          json(response, 200, { project: sessionToProject(session), cancelled: false });
        } catch (error) {
          json(response, 400, { error: { message: error instanceof Error ? error.message : "The project folder could not be added." } });
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/threads") {
        const param = url.searchParams.get("workspaceId");
        let wsId: string | null | undefined;
        if (param === "all") {
          wsId = undefined;
        } else if (param !== null) {
          wsId = param.trim() ? param.trim() : null;
        } else if (workspaceManager.session?.workspaceId) {
          wsId = workspaceManager.session.workspaceId;
        } else {
          wsId = null;
        }
        const threads = await history.list(wsId);
        json(response, 200, { threads: await Promise.all(threads.map(addRecoveryState)) });
        return;
      }

      const threadPath = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
      if (request.method === "GET" && threadPath) {
        const thread = await history.get(decodeURIComponent(threadPath[1]!));
        if (!thread) { json(response, 404, { error: { message: "Thread not found." } }); return; }
        const scopedWsId = url.searchParams.get("workspaceId") || url.searchParams.get("projectId");
        if (scopedWsId && thread.projectId && thread.projectId !== scopedWsId) {
          json(response, 404, { error: { message: "Thread not found in active project." } }); return;
        }
        json(response, 200, { thread: await addRecoveryState(thread) }); return;
      }

      if (request.method === "POST" && url.pathname === "/api/threads") {
        let value: unknown;
        try { value = await body(request, 2_000_000); } catch { json(response, 400, { error: { message: "Invalid thread data." } }); return; }
        if (!value || typeof value !== "object" || !("thread" in value) || !value.thread || typeof value.thread !== "object") {
          json(response, 400, { error: { message: "Choose a thread object to save." } }); return;
        }
        const input = value.thread as Record<string, unknown>;
        if (typeof input.id !== "string" || !input.id.trim()) {
          json(response, 400, { error: { message: "Thread id is required." } }); return;
        }
        const activeWsId = workspaceManager.session?.workspaceId;
        const requestedProjectId = typeof input.projectId === "string" ? input.projectId.trim() : undefined;
        if (activeWsId && requestedProjectId && requestedProjectId !== activeWsId && workspaceRepo.get(requestedProjectId)) {
          json(response, 403, { error: { message: "Cannot create thread for an inactive project." } });
          return;
        }
        const effectiveProjectId = activeWsId ?? (requestedProjectId || undefined);
        // At the API contract level: client cannot provide turns.
        // We only extract metadata fields. Any client-provided turns are strictly ignored.
        const saved = await history.saveMetadata({
          id: input.id.trim(),
          title: typeof input.title === "string" ? input.title.trim() : undefined,
          projectId: effectiveProjectId,
          model: typeof input.model === "string" ? input.model as any : undefined,
          modelSelection: input.modelSelection && typeof input.modelSelection === "object" ? input.modelSelection as any : undefined,
          branch: typeof input.branch === "string" ? input.branch : undefined,
          approvalMode: typeof input.approvalMode === "string" ? input.approvalMode as any : undefined,
        });
        json(response, 200, { thread: saved }); return;
      }

      if (request.method === "PATCH" && threadPath) {
        let value: unknown;
        try { value = await body(request); } catch { json(response, 400, { error: { message: "Invalid request." } }); return; }
        if (!value || typeof value !== "object") {
          json(response, 400, { error: { message: "Invalid request payload." } }); return;
        }
        const threadId = decodeURIComponent(threadPath[1]!);
        const existing = await history.get(threadId);
        if (!existing) { json(response, 404, { error: { message: "Thread not found." } }); return; }
        const activeWsId = workspaceManager.session?.workspaceId;
        if (activeWsId && existing.projectId && existing.projectId !== activeWsId && workspaceRepo.get(existing.projectId)) {
          json(response, 404, { error: { message: "Thread not found in active project." } }); return;
        }

        const patchData = value as Record<string, unknown>;
        const title = typeof patchData.title === "string" && patchData.title.trim() ? patchData.title.trim() : undefined;
        const hasModelSelection = Object.prototype.hasOwnProperty.call(patchData, "modelSelection");
        const modelSelection = hasModelSelection && patchData.modelSelection && typeof patchData.modelSelection === "object" ? patchData.modelSelection as any : undefined;
        const model = typeof patchData.model === "string" ? patchData.model as any : undefined;

        if (!title && !hasModelSelection && !model) {
          json(response, 400, { error: { message: "Provide title, model, or modelSelection." } }); return;
        }

        const saved = await history.saveMetadata({
          id: threadId,
          title: title ?? existing.title,
          modelSelection: hasModelSelection ? modelSelection : existing.modelSelection,
          model: model ?? existing.model,
        });
        json(response, 200, { ok: true, thread: saved }); return;
      }

      if (request.method === "DELETE" && threadPath) {
        const threadId = decodeURIComponent(threadPath[1]!);
        const existing = await history.get(threadId);
        const activeWsId = workspaceManager.session?.workspaceId;
        if (activeWsId && existing?.projectId && existing.projectId !== activeWsId && workspaceRepo.get(existing.projectId)) {
          json(response, 404, { error: { message: "Thread not found in active project." } }); return;
        }
        const ok = await history.delete(threadId);
        for (const turn of existing?.turns ?? []) for (const item of turn.items) {
          for (const attachment of item.attachments ?? []) await attachmentStore.remove(attachment.id);
        }
        json(response, 200, { ok }); return;
      }

      const turnCancelPath = url.pathname.match(/^\/api\/turns\/([^/]+)\/cancel$/);
      if (request.method === "POST" && turnCancelPath) {
        const turnId = decodeURIComponent(turnCancelPath[1]!);
        const threadId = url.searchParams.get("threadId")?.trim();
        if (!threadId) { json(response, 400, { error: { message: "threadId is required." } }); return; }
        const turnKey = compositeTurnKey(threadId, turnId);
        const turn = settledTurns.get(turnKey);
        if (turn?.kind === "task") {
          if (!await taskIsInActiveWorkspace(turn.taskId)) {
            json(response, 404, { error: { code: "task-not-found", message: "The turn's execution task could not be found in the active workspace." } }); return;
          }
          const task = composition.getTaskView
            ? await composition.getTaskView(turn.taskId)
            : composition.snapshotTask(turn.taskId);
          if (!task) {
            json(response, 404, { error: { code: "task-not-found", message: "The turn's execution task could not be found." } }); return;
          }
          if (["completed", "failed", "cancelled"].includes(task.state)) {
            json(response, 409, { error: { code: "turn-not-running", message: "This turn has already reached a terminal state.", state: task.state } }); return;
          }
          // This endpoint records a cancellation request. The durable worker
          // terminal event owns the eventual cancelled state after tools settle.
          try { await composition.cancel(turn.taskId); }
          catch {
            const latest = composition.getTaskView
              ? await composition.getTaskView(turn.taskId)
              : composition.snapshotTask(turn.taskId);
            const terminal = latest && ["completed", "failed", "cancelled"].includes(latest.state);
            json(response, 409, { error: {
              code: terminal ? "turn-not-running" : "cancellation-unavailable",
              message: terminal ? "This turn has already reached a terminal state." : "Cancellation could not be delivered to the active task.",
              ...(latest ? { state: latest.state } : {}),
            } }); return;
          }
          json(response, 202, { ok: true, cancellationRequested: true }); return;
        }
        const controller = turnAbortControllers.get(turnKey);
        if (controller) {
          if (!controller.signal.aborted) controller.abort();
          json(response, 202, { ok: true, cancellationRequested: true }); return;
        }
        const currentThread = await history.get(threadId);
        const currentTurn = currentThread?.turns.find((t) => t.id === turnId);
        if (currentTurn && currentTurn.status === "running") {
          json(response, 409, { error: { code: "cancellation-unavailable", message: "No active execution controller is registered for this turn." } }); return;
        }
        json(response, 404, { error: { message: "Turn not running." } }); return;
      }

      const turnApprovalPath = url.pathname.match(/^\/api\/turns\/([^/]+)\/approvals\/([^/]+)$/);
      if (request.method === "POST" && turnApprovalPath) {
        const turnId = decodeURIComponent(turnApprovalPath[1]!);
        const approvalId = decodeURIComponent(turnApprovalPath[2]!);
        let value: unknown;
        try {
          value = await body(request);
        } catch {
          json(response, 400, { error: { message: "Invalid JSON body." } });
          return;
        }
        if (!value || typeof value !== "object" || typeof (value as any).approved !== "boolean") {
          json(response, 400, { error: { message: "Field 'approved' (boolean) is required." } });
          return;
        }
        const approved = (value as { approved: boolean; threadId?: string }).approved;
        const requestedThreadId = (value as any).threadId ?? url.searchParams.get("threadId")?.trim();

        if (!composition.permissionEngine) {
          json(response, 500, { error: { message: "Permission engine not available." } });
          return;
        }

        const approvalRequest = composition.permissionEngine.getApproval(approvalId);
        const threadId = requestedThreadId ?? approvalRequest?.threadId;
        if (approvalRequest?.threadId && threadId !== approvalRequest.threadId) {
          json(response, 409, { error: { message: "The approval must be resolved from its owning thread." } });
          return;
        }
        let restartResume: { parentTaskId: TaskId; session: WorkspaceSession; selection?: ThreadModelSelection; interruptId?: string } | undefined;
        if (approvalRequest && !composition.permissionEngine.hasActiveApprovalWaiter(approvalId)) {
          if (!approvalRequest.taskId || !threadId || !composition.resume || !composition.durableTaskEngine) {
            json(response, 409, { error: { message: "The interrupted workflow cannot be resumed in this session; the approval remains pending." } });
            return;
          }
          const thread = await history.get(threadId);
          const turn = thread?.turns.find((entry) => entry.id === turnId);
          const parentTaskId = turn?.taskId as TaskId | undefined;
          const parentTask = parentTaskId ? await composition.durableTaskEngine.getTask(parentTaskId) : null;
          const session = workspaceManager.status === "OPEN" ? workspaceManager.session : null;
          if (!parentTask || !session || (parentTask.workspaceId && session.workspaceId !== parentTask.workspaceId)) {
            json(response, 409, { error: { message: "Open the approval's workspace before resolving it; the approval remains pending." } });
            return;
          }
          // The approval belongs to the exact child execution. Its model may
          // differ from Maestro's, so prefer the child selection and only use
          // parent/thread identity as a legacy fallback.
          const childTask = approvalRequest.taskId ? await composition.durableTaskEngine.getTask(approvalRequest.taskId) : null;
          const snapshot = childTask?.inferenceSnapshot ?? parentTask?.inferenceSnapshot;
          let selection: ThreadModelSelection | undefined;
          if (snapshot && typeof snapshot === "object") {
            const s = snapshot;
            if (typeof s.connectionId === "string" && typeof s.modelId === "string") {
              const rawEffort = typeof s.effectiveEffort === "string" ? s.effectiveEffort : typeof s.requestedEffort === "string" ? s.requestedEffort : undefined;
              const validEfforts = ["low", "medium", "high", "extra", "max"] as const;
              const reasoningEffort = rawEffort && validEfforts.includes(rawEffort.toLowerCase() as any)
                ? (rawEffort.toLowerCase() as "low" | "medium" | "high" | "extra" | "max")
                : undefined;
              selection = {
                providerConnectionId: s.connectionId,
                modelId: s.modelId,
                ...(reasoningEffort ? { reasoningEffort } : {}),
              };
            }
          }
          if (!selection) {
            selection = approvalRequest.taskId
              ? await composition.durableTaskEngine.getTaskModelSelection(approvalRequest.taskId)
              : undefined;
            selection ??= await composition.durableTaskEngine.getTaskModelSelection(parentTask.id);
            selection ??= thread?.modelSelection;
          }
          if (productRuntime && !selection) {
            json(response, 409, { error: { code: "model-selection-required", message: "Select the task's configured model before resolving its approval; the approval remains pending." } });
            return;
          }
          if (selection) {
            try { modelResolver.resolveTextClient(selection); }
            catch (error) {
              json(response, 409, { error: { code: "model-unavailable", message: error instanceof Error ? error.message : "The task's selected model is unavailable.", detail: "The approval remains pending." } });
              return;
            }
          }
          restartResume = { parentTaskId: parentTask.id as TaskId, session,
            ...(selection ? { selection } : {}),
            ...(composition.permissionEngine.getWorkflowInterruptId(approvalId)
              ? { interruptId: composition.permissionEngine.getWorkflowInterruptId(approvalId)! } : {}) };
        }
        const resolveApproval = async () => {
        // Re-read under the same task-family lock used by cancellation. A
        // cancellation that wins while recovery metadata is being loaded must
        // not be followed by a stale approval grant or workflow resume.
        const currentApproval = composition.permissionEngine!.getApproval(approvalId);
        const retryingSameDecision = currentApproval?.status === (approved ? "approved" : "rejected");
        if (!currentApproval || (currentApproval.status !== "requested" && !retryingSameDecision)) {
          json(response, 409, { error: { message: "Approval request is no longer pending.", status: currentApproval?.status } });
          return;
        }
        if (retryingSameDecision && composition.isTaskActive?.(currentApproval.taskId)) {
          json(response, 409, { error: { message: "The approved workflow is already running; this response will not start it twice.", status: currentApproval.status } });
          return;
        }
        const res = composition.permissionEngine!.respond(approvalId, approved, {
          turnId,
          threadId: threadId ?? undefined,
        });

        if (!res.success) {
          json(response, 409, { error: { message: res.error ?? "Approval request could not be processed.", status: res.status } });
          return;
        }

        if (res.needsWorkflowResume && restartResume && approvalRequest?.taskId && threadId
          && composition.resume && composition.durableTaskEngine) {
            let resumePromise = approvalResumeInFlight.get(approvalId);
            if (!resumePromise) {
              resumePromise = (async () => {
                const approvalTask = await composition.durableTaskEngine!.getTask(approvalRequest.taskId!);
                if (approvalTask?.status === "waiting_approval") {
                  await composition.durableTaskEngine!.resumeFromApproval(approvalRequest.taskId!);
                }
                await composition.resume!(restartResume!.parentTaskId, {
                  workspaceRoot: restartResume!.session.canonicalRootPath,
                  workspaceId: restartResume!.session.workspaceId,
                  threadId,
                  turnId,
                  // Existing approval records carry the policy bound to the
                  // original task. Older records without it fail closed.
                  approvalMode: approvalRequest?.approvalMode ?? "Require approval",
                  ...(restartResume!.selection ? { modelSelection: restartResume!.selection } : {}),
                  ...(restartResume!.interruptId ? { resumeValues: { [restartResume!.interruptId]: { approved } } } : {}),
                });
              })();
              approvalResumeInFlight.set(approvalId, resumePromise);
            }
            try { await resumePromise; }
            finally { if (approvalResumeInFlight.get(approvalId) === resumePromise) approvalResumeInFlight.delete(approvalId); }
            json(response, 202, { ok: true, status: res.status, resumed: true, task: await readTaskView(restartResume.parentTaskId) });
            return;
        }

        json(response, 200, { ok: true, status: res.status });
        };
        if (approvalRequest?.taskId && composition.withTaskControlLock) {
          await composition.withTaskControlLock(approvalRequest.taskId, resolveApproval);
        } else {
          await resolveApproval();
        }
        return;
      }

      // --- Project Mutation & Filesystem Endpoints ---
      const ensureProject = async (projectId: string): Promise<boolean> => {
        if (workspaceManager.session?.workspaceId === projectId) return true;
        const persisted = workspaceRepo.get(projectId);
        if (persisted && persisted.canonicalPath) {
          try {
            await workspaceManager.openWorkspace(persisted.canonicalPath);
            return true;
          } catch {
            return false;
          }
        }
        if (options.composition?.projects) {
          const list = await options.composition.projects.list();
          const found = list.find((p) => p.id === projectId);
          if (found) {
            try {
              await workspaceManager.openWorkspace(found.path);
              return true;
            } catch {
              return false;
            }
          }
        }
        return false;
      };

      const projectMutation = url.pathname.match(/^\/api\/projects\/([^/]+)\/files$/);
      if (request.method === "POST" && projectMutation) {
        if (!await ensureProject(projectMutation[1])) {
          json(response, 404, { error: { message: `Project ${projectMutation[1]} not found or inactive.` } });
          return;
        }
        let value: unknown;
        try { value = await body(request); } catch { json(response, 400, { error: { message: "Choose a valid file or folder name." } }); return; }
        if (!value || typeof value !== "object" || !("name" in value) || !("type" in value)
          || typeof value.name !== "string" || (value.type !== "file" && value.type !== "folder")
          || !("parentPath" in value) || typeof value.parentPath !== "string") {
          json(response, 400, { error: { message: "Choose a valid file or folder name." } }); return;
        }
        try {
          await workspaceManager.createEntry(value.parentPath, value.name, value.type);
          json(response, 201, { ok: true });
        } catch (error) {
          if (isForbiddenPathError(error)) {
            json(response, 403, { error: { code: "FORBIDDEN", message: error instanceof Error ? error.message : "Path escapes canonical project root." } });
            return;
          }
          json(response, 400, { error: { message: error instanceof Error ? error.message : "The file could not be created." } });
        }
        return;
      }

      if (request.method === "PATCH" && projectMutation) {
        if (!await ensureProject(projectMutation[1])) {
          json(response, 404, { error: { message: `Project ${projectMutation[1]} not found or inactive.` } });
          return;
        }
        let value: unknown;
        try { value = await body(request); } catch { json(response, 400, { error: { message: "The rename request is invalid." } }); return; }
        if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string"
          || !("name" in value) || typeof value.name !== "string") {
          json(response, 400, { error: { message: "Choose a project item and a new name." } }); return;
        }
        try {
          await workspaceManager.renameEntry(value.path, value.name);
          json(response, 200, { ok: true });
        } catch (error) {
          if (isForbiddenPathError(error)) {
            json(response, 403, { error: { code: "FORBIDDEN", message: error instanceof Error ? error.message : "Path escapes canonical project root." } });
            return;
          }
          json(response, 400, { error: { message: error instanceof Error ? error.message : "The item could not be renamed." } });
        }
        return;
      }

      if (request.method === "DELETE" && projectMutation) {
        if (!await ensureProject(projectMutation[1])) {
          json(response, 404, { error: { message: `Project ${projectMutation[1]} not found or inactive.` } });
          return;
        }
        let value: unknown;
        try { value = await body(request); } catch { json(response, 400, { error: { message: "The delete request is invalid." } }); return; }
        if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string") {
          json(response, 400, { error: { message: "Choose a project item to delete." } }); return;
        }
        try {
          await workspaceManager.deleteEntry(value.path);
          json(response, 200, { ok: true });
        } catch (error) {
          if (isForbiddenPathError(error)) {
            json(response, 403, { error: { code: "FORBIDDEN", message: error instanceof Error ? error.message : "Path escapes canonical project root." } });
            return;
          }
          json(response, 400, { error: { message: error instanceof Error ? error.message : "The item could not be deleted." } });
        }
        return;
      }

      const fileWritePath = url.pathname.match(/^\/api\/projects\/([^/]+)\/file$/);
      if (request.method === "PUT" && fileWritePath) {
        if (!await ensureProject(fileWritePath[1])) {
          json(response, 404, { error: { message: `Project ${fileWritePath[1]} not found or inactive.` } });
          return;
        }
        let value: unknown;
        try { value = await body(request, 6_400_000); } catch (error) {
          json(response, error instanceof Error && error.message === "request-too-large" ? 413 : 400,
            { error: { message: "The file contents must be valid text under 1 MB." } }); return;
        }
        if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string"
          || !("content" in value) || typeof value.content !== "string" || !("expectedHash" in value) || typeof value.expectedHash !== "string") {
          json(response, 400, { error: { message: "The file contents are invalid." } }); return;
        }
        try {
          const saved = await workspaceManager.writeFile(value.path, value.content, value.expectedHash);
          json(response, 200, saved);
        } catch (error) {
          if (isForbiddenPathError(error)) {
            json(response, 403, { error: { code: "FORBIDDEN", message: error instanceof Error ? error.message : "Path escapes canonical project root." } });
            return;
          }
          const conflict = error instanceof Error && (error.message === "file-conflict" || (error as any).code === "STALE_REVISION" || error.message.includes("conflict"));
          json(response, conflict ? 409 : 400, { error: { code: conflict ? "file-conflict" : "file-save-failed",
            message: conflict ? "This file changed outside the editor. Reload it before saving." : error instanceof Error ? error.message : "The file could not be saved." } });
        }
        return;
      }

      const projectPath = url.pathname.match(/^\/api\/projects\/([^/]+)\/(files|file)$/);
      if (request.method === "GET" && projectPath) {
        if (!await ensureProject(projectPath[1])) {
          json(response, 404, { error: { message: `Project ${projectPath[1]} not found or inactive.` } });
          return;
        }
        try {
          const relative = url.searchParams.get("path") ?? "";
          if (projectPath[2] === "files") {
            json(response, 200, { entries: await workspaceManager.listFiles(relative) });
          } else {
            const versioned = await workspaceManager.readFileVersioned(relative);
            json(response, 200, versioned);
          }
        } catch (error) {
          if (isForbiddenPathError(error)) {
            json(response, 403, { error: { code: "FORBIDDEN", message: error instanceof Error ? error.message : "Path escapes canonical project root." } });
            return;
          }
          json(response, 404, { error: { message: error instanceof Error ? error.message : "Project file unavailable." } });
        }
        return;
      }

      // --- Task / Turn Execution ---
      if (request.method === "POST" && url.pathname === "/api/attachments") {
        let value: unknown;
        try { value = await body(request, 7_100_000); } catch {
          json(response, 413, { error: { message: "Attachment upload exceeds the 5 MB per-file limit." } }); return;
        }
        if (!value || typeof value !== "object") { json(response, 400, { error: { message: "Choose a valid file." } }); return; }
        const input = value as Record<string, unknown>;
        if (typeof input.name !== "string" || typeof input.type !== "string" || typeof input.base64 !== "string"
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64) || input.base64.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 4) {
          json(response, 400, { error: { message: "Choose a supported file under 5 MB." } }); return;
        }
        const session = workspaceManager.session;
        const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : (session ? session.workspaceId : undefined);
        const threadId = typeof input.threadId === "string" ? input.threadId : undefined;
        try {
          const attachment = await attachmentStore.save(
            input.name,
            input.type || "application/octet-stream",
            Buffer.from(input.base64, "base64"),
            { ...(workspaceId ? { workspaceId } : {}), ...(threadId ? { threadId } : {}) },
          );
          json(response, 201, { attachment });
        } catch (error) { json(response, 400, { error: { message: error instanceof Error ? error.message : "File could not be stored." } }); }
        return;
      }
      const attachmentGet = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (request.method === "GET" && attachmentGet) {
        const id = decodeURIComponent(attachmentGet[1]!);
        const stored = await attachmentStore.get(id);
        if (!stored) {
          json(response, 404, { error: { message: "Attachment not found or expired." } });
          return;
        }
        response.writeHead(200, {
          "content-type": stored.mimeType,
          "content-length": String(stored.size),
          "cache-control": "public, max-age=86400, immutable",
          "content-disposition": `inline; filename="${stored.name.replace(/"/g, "")}"`,
        });
        response.end(stored.bytes);
        return;
      }
      const attachmentDelete = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (request.method === "DELETE" && attachmentDelete) {
        await attachmentStore.remove(decodeURIComponent(attachmentDelete[1]!));
        json(response, 200, { ok: true }); return;
      }

      if (request.method === "POST" && url.pathname === "/api/turns") {
        const turnStartTime = performance.now();
        let value: unknown;
        try { value = await body(request); } catch (error) {
          json(response, error instanceof Error && error.message === "request-too-large" ? 413 : 400,
            { error: { message: "The turn request must be valid JSON under 32 KB." } }); return;
        }
        if (!value || typeof value !== "object" || !("prompt" in value) || !("turnId" in value)
          || !("threadId" in value)
          || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 4000
          || typeof value.turnId !== "string" || value.turnId.length > 120 || typeof value.threadId !== "string"
          || value.threadId.length > 120) {
          json(response, 400, { error: { message: "Enter a task goal." } }); return;
        }

        const requestValue = value as Record<string, unknown>;
        const requestedEffort = typeof requestValue.reasoningEffort === "string" ? requestValue.reasoningEffort.toLowerCase() : undefined;
        if (requestedEffort !== undefined && !["low", "medium", "high", "extra", "max"].includes(requestedEffort)) {
          json(response, 400, { error: { code: "invalid-reasoning-effort", message: "Choose Low, Medium, High, Extra, or Max reasoning effort." } }); return;
        }
        const specialistFieldPresent = Object.hasOwn(requestValue, "specialistId");
        const requestedSpecialistId = specialistFieldPresent && typeof requestValue.specialistId === "string"
          ? requestValue.specialistId.trim() : undefined;
        const requestedSpecialist = requestedSpecialistId
          ? composition.definitions.find(entry => entry.id === requestedSpecialistId
            && entry.group === "specialist" && entry.directConversationAvailable === true)
          : undefined;
        if (specialistFieldPresent && (!requestedSpecialistId || !requestedSpecialist)) {
          json(response, 400, { error: { code: "invalid-specialist", message: "Choose an available individual specialist conversation." } }); return;
        }
        if (requestedSpecialist?.availability === "not-configured") {
          json(response, 409, { error: { code: "specialist-not-configured", message: "This specialist is not configured for execution. Connect an enabled model and try again." } }); return;
        }

        const tAfterRequest = performance.now();
        const targetThreadId = value.threadId.trim();
        const targetTurnId = value.turnId.trim();
        const turnKey = compositeTurnKey(targetThreadId, targetTurnId);

        // 1. Join in-flight barrier if already submitting (concurrent duplicate submissions)
        const existingInFlight = inFlightTurns.get(turnKey);
        if (existingInFlight) {
          try {
            const inFlightResult = await existingInFlight;
            json(response, 200, inFlightResult);
          } catch (err) {
            const workspaceConflict = err instanceof ProjectWorkspaceMismatchError;
            json(response, workspaceConflict ? 409 : 500, { error: {
              ...(workspaceConflict ? { code: "project-workspace-mismatch" } : {}),
              message: err instanceof Error ? err.message : "Execution failed",
            } });
          }
          return;
        }

        // 2. Return settled turn if already in-memory (composite key lookup)
        const existingSettled = settledTurns.get(turnKey);
        if (existingSettled) {
          json(response, 200, existingSettled.kind === "task"
            ? { turnId: targetTurnId, taskId: existingSettled.taskId }
            : { turnId: targetTurnId, direct: true });
          return;
        }

        // Reserve the pair synchronously before any awaited database read so
        // concurrent duplicates cannot all pass the lookup before registration.
        let resolveInFlight!: (val: TurnStartResult) => void;
        let rejectInFlight!: (err: unknown) => void;
        const inFlightBarrier = new Promise<TurnStartResult>((res, rej) => {
          resolveInFlight = res;
          rejectInFlight = rej;
        });
      inFlightBarrier.catch(() => {});
      inFlightTurns.set(turnKey, inFlightBarrier);
        // Own cancellation from the moment this request claims the turn, including
        // workspace/context preparation before a model request or worker exists.
        const turnController = new AbortController();
        turnAbortControllers.set(turnKey, turnController);

        let directMaestroDecision = false;
        let decisionProviderId: string | undefined;
        let decisionModelId: string | undefined;
        try {
          // A persisted turn is already authoritative, including direct conversations with no taskId.
          const existingThread = await history.get(targetThreadId);
          const existingTurn = existingThread?.turns.find((t) => t.id === targetTurnId);
          const existingTaskId = existingTurn && (existingTurn as any).taskId;
          if (existingTurn) {
            const result: TurnStartResult = typeof existingTaskId === "string" && existingTaskId
              ? { turnId: targetTurnId, taskId: existingTaskId }
              : { turnId: targetTurnId, direct: true };
            settledTurns.set(turnKey, typeof existingTaskId === "string" && existingTaskId
              ? { kind: "task", taskId: existingTaskId as TaskView["id"], threadId: targetThreadId, turnId: targetTurnId }
              : { kind: "conversation", threadId: targetThreadId, turnId: targetTurnId, status: existingTurn.status });
            resolveInFlight(result);
            json(response, 200, result);
            return;
          }

          // Bind this turn to the validated session snapshot. Later workspace switches
          // must not change the root or project ID used by this turn.
          const session = workspaceManager.status === "OPEN" ? workspaceManager.session : null;
          const requestedProject = (value as Record<string, unknown>).projectId;
          const requestedProjectId = typeof requestedProject === "string" && requestedProject.trim() ? requestedProject.trim() : undefined;
          if ((existingThread?.projectId && session && existingThread.projectId !== session.workspaceId)
            || (requestedProjectId && (!session || requestedProjectId !== session.workspaceId))) {
            const conflict = new ProjectWorkspaceMismatchError();
            rejectInFlight(conflict);
            json(response, 409, { error: { code: "project-workspace-mismatch", message: conflict.message } });
            return;
          }
          const promptText = value.prompt.trim();

          let modelSelection = ("modelSelection" in value && value.modelSelection && typeof value.modelSelection === "object"
            ? value.modelSelection as ThreadModelSelection
            : undefined);

          if (!modelSelection) {
            const currentThread = await history.get(targetThreadId);
            if (currentThread?.modelSelection) {
              modelSelection = currentThread.modelSelection;
            }
          }

          const rawTurnEffort = (requestedEffort || modelSelection?.reasoningEffort)?.toLowerCase();
          const validEfforts = ["low", "medium", "high", "extra", "max"] as const;
          const effectiveTurnEffort = rawTurnEffort && (validEfforts as readonly string[]).includes(rawTurnEffort)
            ? (rawTurnEffort as "low" | "medium" | "high" | "extra" | "max")
            : undefined;

          if (modelSelection) {
            modelSelection = {
              ...modelSelection,
              ...(effectiveTurnEffort ? { reasoningEffort: effectiveTurnEffort } : {}),
            };
          }

        if (productRuntime && !modelSelection) {
          json(response, 409, { error: { code: "model-not-selected", message: "Connect and enable a model in Settings, then select it in the composer." } });
          return;
        }
        let resolvedModelCapabilities: ReturnType<ModelResolver["resolveTextClient"]>["descriptor"]["capabilities"] | undefined;
        if (productRuntime && modelSelection) {
          try { resolvedModelCapabilities = modelResolver.resolveTextClient(modelSelection).descriptor.capabilities; }
          catch (error) {
            json(response, 409, { error: { code: "model-unavailable", message: error instanceof Error ? error.message : "The selected model is unavailable." } });
            return;
          }
        }

        const assignmentModelSelections: Record<string, ThreadModelSelection> = {};
        const rawAssignmentSelections = (value as Record<string, unknown>).assignmentModelSelections;
        if (rawAssignmentSelections !== undefined) {
          if (!rawAssignmentSelections || typeof rawAssignmentSelections !== "object" || Array.isArray(rawAssignmentSelections)
            || Object.keys(rawAssignmentSelections).length > 32) {
            json(response, 400, { error: { code: "invalid-assignment-models", message: "Specialist model preferences are invalid." } }); return;
          }
          const definitions = composition.world.inspect().definitions;
          for (const [requestedIdentity, rawSelection] of Object.entries(rawAssignmentSelections)) {
            if (!requestedIdentity.trim() || requestedIdentity.length > 160 || !rawSelection || typeof rawSelection !== "object" || Array.isArray(rawSelection)) {
              json(response, 400, { error: { code: "invalid-assignment-models", message: "Specialist model preferences are invalid." } }); return;
            }
            const selection = rawSelection as Record<string, unknown>;
            const rawEffort = typeof selection.reasoningEffort === "string" ? selection.reasoningEffort.toLowerCase() : undefined;
            if (rawEffort !== undefined && !["low", "medium", "high", "extra", "max"].includes(rawEffort)) {
              json(response, 400, { error: { code: "invalid-assignment-models", message: "Choose Low, Medium, High, Extra, or Max reasoning effort for specialists." } }); return;
            }
            if (Object.keys(selection).some(key => !["providerConnectionId", "providerId", "modelId", "reasoningEffort"].includes(key))
              || typeof selection.providerConnectionId !== "string" || typeof selection.modelId !== "string"
              || selection.providerId !== undefined && selection.providerId !== selection.providerConnectionId
              || !selection.providerConnectionId.trim() || selection.providerConnectionId.length > 200
              || !selection.modelId.trim() || selection.modelId.length > 200) {
              json(response, 400, { error: { code: "invalid-assignment-models", message: "Specialist model preferences are invalid." } }); return;
            }
            const matches = definitions.filter(definition => definition.id === requestedIdentity
              || definition.name.toLocaleLowerCase() === requestedIdentity.toLocaleLowerCase());
            const definition = matches.length === 1 ? matches[0] : undefined;
            if (!definition || definition.id === composition.maestroDefinitionId || definition.lifecycleState !== "active") {
              json(response, 400, { error: { code: "invalid-assignment-models", message: "A model preference references an unavailable specialist." } }); return;
            }
            const exactSelection: ThreadModelSelection = {
              providerConnectionId: selection.providerConnectionId,
              modelId: selection.modelId,
              ...(rawEffort ? { reasoningEffort: rawEffort as "low" | "medium" | "high" | "extra" | "max" } : {}),
            };
            try { modelResolver.resolveTextClient(exactSelection); }
            catch {
              json(response, 409, { error: { code: "assignment-model-unavailable",
                message: `The configured model preference for ${definition.name} is unavailable or does not support text.` } }); return;
            }
            assignmentModelSelections[definition.id] = exactSelection;
          }
        }

          const rawAttachmentRefs = (value as Record<string, unknown>).attachments;
          const attachmentRefs = Array.isArray(rawAttachmentRefs)
            ? rawAttachmentRefs.slice(0, 5)
            : [];
          if (Array.isArray(rawAttachmentRefs) && rawAttachmentRefs.length > 5) {
            json(response, 413, { error: { message: "A turn can include at most 5 attachments." } }); return;
          }
          const attachments: StoredAttachment[] = [];
          for (const ref of attachmentRefs) {
            if (!ref || typeof ref !== "object" || typeof (ref as Record<string, unknown>).id !== "string") {
              json(response, 400, { error: { message: "An attachment reference is invalid." } }); return;
            }
            const stored = await attachmentStore.get((ref as { id: string }).id);
            if (!stored) { json(response, 400, { error: { message: "An attachment is missing or expired. Please attach it again." } }); return; }
            attachments.push(stored);
          }
          if (attachments.reduce((sum, attachment) => sum + attachment.size, 0) > 10 * 1024 * 1024) {
            json(response, 413, { error: { message: "Attachments for one turn cannot exceed 10 MB total." } }); return;
          }
          const activeWorkspaceRoot = workspaceManager.session?.canonicalRootPath;
          const contextIngestion = new MultimodalContextIngestion(productRuntime ? modelResolver : undefined);
          const resolvedContext = await contextIngestion.resolve({
            prompt: promptText,
            attachments,
            workspaceRoot: activeWorkspaceRoot,
            selectedModelCapabilities: resolvedModelCapabilities,
          });

          // 1. STEP 1 & 2: DURABLY PERSIST USER MESSAGE & INITIAL TURN BEFORE EXECUTION
          const userItem: ThreadItem = {
            id: `item-${Date.now()}-user`,
            turnId: targetTurnId,
            type: "user_message",
            actor: { type: "user" },
            timestamp: Date.now(),
            text: promptText,
            ...(attachments.length ? { attachments: attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })) } : {}),
          };
          const initialTurn: Turn = {
            id: targetTurnId,
            threadId: targetThreadId,
            prompt: promptText,
            status: "running",
            currentActivity: "thinking",
            createdAt: Date.now(),
            items: [userItem],
          };
          await history.appendTurn(targetThreadId, initialTurn, {
            projectId: session ? session.workspaceId : undefined,
            title: ThreadTitleService.generateTitle(promptText),
            modelSelection,
            ...(effectiveTurnEffort ? { reasoningEffort: effectiveTurnEffort } : {}),
          });
          const tAfterInitialPersistence = performance.now();

          if (resolvedContext.unsupportedError) {
            await history.updateTurn(targetThreadId, targetTurnId, (turn) => {
              turn.status = "failed"; turn.currentActivity = "failed"; turn.completedAt = Date.now();
              turn.items.push({ id: `attachment-error-${targetTurnId}`, turnId: targetTurnId, type: "agent_message", actor: { type: "system" }, timestamp: Date.now(), text: resolvedContext.unsupportedError! });
            });
            inFlightTurns.delete(turnKey);
            json(response, 415, { error: { code: "unsupported-attachment", message: resolvedContext.unsupportedError } }); return;
          }

          if (modelSelection) {
            const check = modelResolver.checkCapability(modelSelection, "text");
            if (check.ok === false) {
              const errMsg = `Model cannot perform this operation: ${(check as { error: string }).error}`;
              await history.updateTurn(targetThreadId, targetTurnId, (t) => {
                t.status = "failed";
                t.currentActivity = "failed";
                t.completedAt = Date.now();
                t.items.push({
                  id: `item-${Date.now()}-err`,
                  turnId: targetTurnId,
                  type: "agent_message",
                  actor: { type: "system" },
                  timestamp: Date.now(),
                  text: `Turn ended: ${errMsg}`,
                });
              });
              const err = new Error(errMsg);
              rejectInFlight(err);
              inFlightTurns.delete(turnKey);
              json(response, 400, { code: "unsupported-modality", error: { message: errMsg, code: "unsupported-modality" } });
              return;
            }
          }

          // 2. Resolve definition resiliently (fall back to Maestro / available agent)
          const requestedDefId = "definitionId" in value && typeof value.definitionId === "string" ? value.definitionId : undefined;
          let definition = requestedSpecialist ? composition.definitions.find(entry => entry.id === composition.maestroDefinitionId) : requestedDefId
            ? composition.definitions.find((entry) => entry.id === requestedDefId || entry.name.toLowerCase() === requestedDefId.toLowerCase().replace(/^definition-/, ""))
            : undefined;
          if (!definition || (!definition.executable && (requestedDefId?.toLowerCase().includes("maestro") || requestedDefId === "default"))) {
            definition = composition.definitions.find((entry) => entry.id === composition.maestroDefinitionId)
              ?? composition.definitions.find((entry) => entry.executable && entry.role === "Team orchestration")
              ?? composition.definitions.find((entry) => entry.executable)
              ?? composition.definitions[0];
          }

          if (!definition) {
            const errMsg = "Choose an available Mediobot.";
            await history.updateTurn(targetThreadId, targetTurnId, (t) => {
              t.status = "failed";
              t.currentActivity = "failed";
              t.completedAt = Date.now();
              t.items.push({
                id: `item-${Date.now()}-err`,
                turnId: targetTurnId,
                type: "agent_message",
                actor: { type: "system" },
                timestamp: Date.now(),
                text: `Turn ended: ${errMsg}`,
              });
            });
            const err = new Error(errMsg);
            rejectInFlight(err);
            inFlightTurns.delete(turnKey);
            json(response, 400, { error: { message: errMsg } });
            return;
          }

          // 3. STEP 4: PRE-REGISTER PERSISTENCE LISTENER AND BEGIN MODEL/AGENT EXECUTION
          const persistTurnUpdate = (updater: (t: Turn) => void) => {
            history.updateTurn(targetThreadId, targetTurnId, updater).catch(() => {
              // Ignore writes if database was closed during shutdown
            });
          };

          let assignedTaskId: TaskId | undefined;

          const serverPersistListener = (event: ProductEvent) => {
            if (assignedTaskId && event.taskId !== assignedTaskId) return;
            persistTurnUpdate((t) => {
              if (typeof event.sequence === "number") t.lastEventSequence = Math.max(t.lastEventSequence ?? 0, event.sequence);
            });
            const type = event.type;
            const terminal = type === "task.completed" || type === "task.failed" || type === "task.cancelled";
            const failureCategory = event.error ? categorizeFailure(event.error.message) : undefined;
            const safeError = failureCategory === "repeated action" && event.error?.message.startsWith("Cody stopped after repeating ")
              ? event.error.message : failureCategory;
            const structural = type.startsWith("tool.") || ["task.started", "worker.started", "worker.completed", "worker.cancelled"].includes(type);
            const rawMessage = safeError ?? event.message ?? (structural ? "" : type === "worker.assigned" ? `Assigned: ${event.workerName ?? "specialist"}` : type === "task.cancelled" ? "Task cancelled." : type === "task.completed" ? "Task completed." :
              event.workerName ? `${event.workerName} ${type.replace(/^worker\./, "").replaceAll(".", " ")}.` : "Mediobot is working on the task.");
            const safeRawMessage = type === "worker.assigned"
              ? `Assigned: ${rawMessage.replace(/^I[’']ve assigned .+? to:\s*/i, "")}` : rawMessage;
            const message = sanitizeReasoningAndSecrets(safeRawMessage);
            if (type.startsWith("tool.") && !event.toolInvocationId) return;
            const toolStatus: import("./types/index.ts").ToolExecutionData["status"] = type === "tool.started" ? "running" : type === "tool.failed" ? "failed"
              : type === "tool.cancelled" ? "cancelled" : "success";

            if (type === "task.pause_requested") {
              persistTurnUpdate(t => { t.status = "pause_requested"; t.currentActivity = "waiting"; });
            } else if (type === "task.paused") {
              persistTurnUpdate(t => { t.status = "paused"; t.currentActivity = "waiting"; });
            } else if (type === "task.resumed") {
              persistTurnUpdate(t => { t.status = "running"; t.currentActivity = "running"; t.recoveryState = undefined; });
            } else if (type === "worker.assigned") {
              const item: ThreadItem = { id: event.id, turnId: targetTurnId, type: "activity", actor: maestroActor,
                timestamp: event.occurredAt, text: message, activityLabel: `Assigned ${event.workerName ?? "specialist"}`,
                activityDetail: message.replace(/^Assigned:\s*/, "").slice(0, 400), activityState: "planning" };
              persistTurnUpdate((t) => { if (!t.items.some((it) => it.id === item.id)) t.items.push(item); });
            } else if (type === "maestro.responded" || type === "worker.message") {
              const item: ThreadItem = { id: event.id, turnId: targetTurnId, type: "agent_message", actor: actorForProductEvent(type, event.workerDefinitionId), timestamp: event.occurredAt, text: message };
              persistTurnUpdate((t) => {
                if (!t.items.some((it) => it.id === item.id)) {
                  t.items.push(item);
                }
              });
            } else if (event.type === "file.changed" && event.diff) {
              const item: ThreadItem = { id: event.id, turnId: targetTurnId, type: "diff", ...(actorForDefinition(event.workerDefinitionId) ? { actor: actorForDefinition(event.workerDefinitionId) } : {}), timestamp: event.occurredAt, diff: event.diff };
              persistTurnUpdate((t) => {
                if (!t.items.some((it) => it.id === item.id)) {
                  t.items.push(item);
                }
              });
            } else if (event.type === "approval.required" && event.approval) {
              const approvalItem: ThreadItem = {
                id: `approval-${event.approval.approvalId}`,
                turnId: targetTurnId,
                type: "approval_request",
                timestamp: event.occurredAt,
                actor: actorForDefinition(event.workerDefinitionId),
                approval: event.approval,
              };
              persistTurnUpdate((t) => {
                const existingIdx = t.items.findIndex((it) => it.id === approvalItem.id);
                if (existingIdx >= 0) {
                  t.items[existingIdx] = approvalItem;
                } else {
                  t.items.push(approvalItem);
                }
                t.status = "waiting_approval";
                t.currentActivity = "waiting_for_approval";
              });
            } else if (event.type === "approval.resolved" && event.approval) {
              persistTurnUpdate((t) => {
                const approvalItem = t.items.find((it) => it.id === `approval-${event.approval!.approvalId}`);
                if (approvalItem && approvalItem.approval) {
                  approvalItem.approval = { ...approvalItem.approval, status: event.approval!.status };
                }
                if (t.status === "waiting_approval") {
                  t.status = "running";
                  t.currentActivity = "running";
                }
              });
            } else if (type.startsWith("tool.")) {
              const itemId = event.toolInvocationId!;
              persistTurnUpdate((t) => {
                const existingIndex = t.items.findIndex((it) => it.id === itemId);
                if (existingIndex >= 0) {
                  const existing = t.items[existingIndex]!;
                  const stalePresentation = typeof existing.tool?.eventSequence === "number"
                    && typeof event.sequence === "number" && event.sequence < existing.tool.eventSequence;
                  const incomingToolData = {
                    toolName: event.toolName ?? existing.tool?.toolName ?? "Mediobot tool",
                    toolInvocationId: event.toolInvocationId,
                    status: toolStatus,
                    command: event.command ?? existing.tool?.command,
                    workingDirectory: event.workingDirectory ?? existing.tool?.workingDirectory,
                    recoveryReason: event.recoveryReason ?? existing.tool?.recoveryReason,
                    startedAt: event.startedAt ?? existing.tool?.startedAt ?? event.occurredAt,
                    durationMs: event.durationMs ?? existing.tool?.durationMs,
                    error: event.error?.message ?? existing.tool?.error,
                    errorCode: event.errorCode ?? existing.tool?.errorCode,
                    failureCategory: event.failureCategory ?? existing.tool?.failureCategory,
                    recoveredFromExecution: event.recoveredFromExecution ?? existing.tool?.recoveredFromExecution,
                    isVerification: event.isVerification ?? existing.tool?.isVerification,
                    verificationStatus: event.verificationStatus ?? existing.tool?.verificationStatus,
                    exitCode: event.exitCode !== undefined ? event.exitCode : existing.tool?.exitCode,
                    terminationSignal: event.terminationSignal ?? existing.tool?.terminationSignal,
                    stdoutBytes: event.stdoutBytes ?? existing.tool?.stdoutBytes,
                    stderrBytes: event.stderrBytes ?? existing.tool?.stderrBytes,
                    eventSequence: event.sequence ?? existing.tool?.eventSequence,
                  };
                  existing.tool = mergeMonotonicToolData(existing.tool, incomingToolData);
                  if (!stalePresentation) {
                    existing.text = message;
                    existing.actor = actorForDefinition(event.workerDefinitionId) ?? existing.actor;
                  }
                } else {
                  t.items.push({
                    id: itemId,
                    turnId: targetTurnId,
                    type: "tool_execution",
                    timestamp: event.occurredAt,
                    ...(actorForDefinition(event.workerDefinitionId) ? { actor: actorForDefinition(event.workerDefinitionId) } : {}),
                    text: message,
                    tool: {
                      toolName: event.toolName ?? "Mediobot tool",
                      toolInvocationId: event.toolInvocationId,
                      command: event.command,
                      workingDirectory: event.workingDirectory,
                      recoveryReason: event.recoveryReason,
                      status: toolStatus,
                      startedAt: event.startedAt ?? event.occurredAt,
                      durationMs: event.durationMs,
                      error: event.error?.message ?? (event.type === "tool.failed" ? "Tool operation failed." : undefined),
                      errorCode: event.errorCode,
                      failureCategory: event.failureCategory,
                      recoveredFromExecution: event.recoveredFromExecution,
                      isVerification: event.isVerification,
                      verificationStatus: event.verificationStatus,
                      exitCode: event.exitCode,
                      terminationSignal: event.terminationSignal,
                      stdoutBytes: event.stdoutBytes,
                      stderrBytes: event.stderrBytes,
                      eventSequence: event.sequence,
                    },
                  });
                }
              });
            } else if (!terminal && message && !isLowLevelProgress(event)) {
              const item: ThreadItem = { id: event.id, turnId: targetTurnId, type: "activity", timestamp: event.occurredAt,
                actor: actorForProductEvent(type, event.workerDefinitionId),
                text: message, activityLabel: message };
              persistTurnUpdate((t) => {
                if (!t.items.some((it) => it.id === item.id)) {
                  t.items.push(item);
                }
              });
            }

            if (terminal) {
              persistTurnUpdate((t) => {
                t.status = type === "task.completed" ? "completed" : type === "task.cancelled" ? "cancelled" : "failed";
                t.currentActivity = t.status === "cancelled" ? "completed" : t.status;
                t.completedAt = Date.now();
                if (type === "task.failed") {
                  const errorSummary = event.error?.message ? sanitizeReasoningAndSecrets(event.error.message) : message;
                  if (!t.items.some((it) => it.type === "agent_message" && it.text && it.text.includes(errorSummary))) {
                    t.items.push({
                      id: `item-${Date.now()}-failed`,
                      turnId: targetTurnId,
                      type: "agent_message",
                      actor: actorForProductEvent(type, event.workerDefinitionId),
                      timestamp: Date.now(),
                      text: `Turn ended: ${errorSummary}`,
                    });
                  }
                }
              });
              if (assignedTaskId) {
                const currentSubs = composition.subscribers.get(assignedTaskId);
                currentSubs?.delete(serverPersistListener);
                if (currentSubs && currentSubs.size === 0) composition.subscribers.delete(assignedTaskId);
              }
            }
          };

          const isOrdinary = isOrdinaryConversationGoal(resolvedContext.promptWithContext);
          const tBeforeContext = performance.now();
          const projectContext = await workspaceManager.getProjectIntelligenceContext(session, { skipDeepDiscovery: isOrdinary });
          const tAfterContext = performance.now();
          const projectContextMs = Math.round((tAfterContext - tBeforeContext) * 100) / 100;
          const workspaceRoot = projectContext.workspaceRoot;
          const projectName = projectContext.projectName;

          const priorTurns = existingThread?.turns?.filter((t) => t.id !== targetTurnId) ?? [];
          const previousTurn = priorTurns.length > 0 ? priorTurns[priorTurns.length - 1] : undefined;
          const continuitySpeakerId = requestedSpecialist?.id ?? composition.maestroDefinitionId;
          const previousTurnHasSpeakerResponse = previousTurn?.items.some((item) => item.type === "agent_message"
            && item.actor?.type === "mediobot" && item.actor.mediobotId === continuitySpeakerId);
          const previousTurnEvidence = previousTurn && previousTurnHasSpeakerResponse ? [{
            id: `turn-evidence-${previousTurn.id}` as any,
            source: { type: "previous-turn-execution", reference: previousTurn.id },
            kind: "execution-outcome",
            claim: `Previous turn execution outcome (status: ${previousTurn.status})`,
            content: summarizePreviousTurnExecution(previousTurn),
            validity: "confirmed" as const,
          }] : undefined;

          // Reuse verified evidence from this workspace (or exact thread when no
          // workspace is selected). Private specialist transcripts are never queried.
          const memoryEngine = composition.durableTaskEngine ?? durableTaskEngine;
          const verifiedMemory = await memoryEngine.searchVerifiedEvidence(
            session && workspaceRoot ? session.workspaceId : null,
            targetThreadId,
            targetTurnId,
            resolvedContext.promptWithContext.slice(0, 2_000),
            3,
          );
          const relevantMemory = verifiedMemory.map((record) => {
            const sourceType = typeof record.source.type === "string" ? record.source.type : "durable-evidence";
            const sourceReference = typeof record.source.reference === "string" ? record.source.reference : record.taskId;
            return {
              name: `Verified project evidence (${record.kind}; task ${record.taskId}; ${sourceType}: ${sourceReference})`,
              value: `Evidence ID ${record.id}${record.claim ? `; claim: ${record.claim.slice(0, 400)}` : ""}`,
            };
          });
          const memoryEvidence = verifiedMemory.map((record) => ({
            id: record.id as any,
            source: { type: "durable-task-evidence", reference: `${record.taskId}:${record.id}` },
            kind: record.kind,
            claim: record.claim ?? undefined,
            content: record.content.slice(0, 1_000),
            validity: "verified" as const,
          }));

          // SQLite is authoritative. AppContext history is only a projection and
          // can be stale during reconnects or project switches.
          const historyEntries = priorTurns.slice(-4).map((t) => {
              const assistantMsgs = t.items.filter((it) => it.type === "agent_message" && it.text
                && it.actor?.type === "mediobot"
                && it.actor.mediobotId === (requestedSpecialist?.id ?? composition.maestroDefinitionId));
              const assistantText = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].text : undefined;
              return assistantText ? {
                user: sanitizeReasoningAndSecrets(t.prompt).slice(0, 1000),
                assistant: sanitizeReasoningAndSecrets(assistantText).slice(0, 1000),
              } : undefined;
            }).filter((entry): entry is { user: string; assistant: string } => Boolean(entry));

          const canonicalRoot = session ? await realpath(session.canonicalRootPath).catch(() => session.canonicalRootPath) : undefined;
          const executionScope: ExecutionScope | undefined = session && canonicalRoot ? {
            workspaceRoot: session.canonicalRootPath,
            canonicalRoot,
            workspaceId: session.workspaceId,
            threadId: targetThreadId,
            turnId: targetTurnId,
            scopeType: requestedSpecialist ? "direct_private" : "team",
            initiatingSpecialistId: requestedSpecialist?.id,
            authorizationScope: "standard_mutation",
          } : undefined;

          const turnOptions: Record<string, unknown> = {
            ...(executionScope ? { executionScope, workspaceRoot: executionScope.canonicalRoot, workspaceId: executionScope.workspaceId } : (workspaceRoot ? { workspaceRoot } : {})),
            ...(projectName ? { projectName } : {}),
            ...(session && workspaceRoot && !executionScope ? { workspaceId: session.workspaceId } : {}),
            workspaceExecutionAuthorized: Boolean(executionScope || (session && workspaceRoot)) || Boolean(requestedSpecialist && requestedSpecialist.role !== "Software engineering"),
            workspaceState: projectContext.workspaceState,
            projectIntelligence: projectContext.projectIntelligence,
            toolMetadata: projectContext.toolMetadata,
            recentHistory: JSON.stringify(historyEntries),
            ...((previousTurnEvidence?.length || memoryEvidence.length)
              ? { relevantEvidence: [...(previousTurnEvidence ?? []), ...memoryEvidence] } : {}),
            ...(relevantMemory.length ? { relevantMemory } : {}),
            modelSelection,
            ...(Object.keys(assignmentModelSelections).length ? { assignmentModelSelections } : {}),
            ...(effectiveTurnEffort ? { reasoningEffort: effectiveTurnEffort } : {}),
            imageInputs: resolvedContext.imageInputs,
            threadId: targetThreadId,
            turnId: targetTurnId,
            approvalMode: ("approvalMode" in value && typeof value.approvalMode === "string")
              ? value.approvalMode
              : (options.defaultApprovalMode ?? "Approve for me"),
            priority: "interactive",
            ...(typeof value.prompt === "string" && explicitlyRequestsVerification(value.prompt)
              ? { requireVerification: true } : {}),
            ...(requestedSpecialist ? { specialistConversationId: requestedSpecialist.id } : {}),
          };

          if ((!session || !workspaceRoot) && definition.id !== composition.maestroDefinitionId) {
            const message = "Open a project workspace before starting project-bound execution.";
            await history.updateTurn(targetThreadId, targetTurnId, (turn) => {
              turn.status = "failed";
              turn.currentActivity = "failed";
              turn.completedAt = Date.now();
              turn.items.push({ id: `workspace-required-${targetTurnId}`, turnId: targetTurnId, type: "agent_message",
                actor: { type: "system" }, timestamp: Date.now(), text: message });
            });
            const result: TurnStartResult = { turnId: targetTurnId, direct: true };
            settledTurns.set(turnKey, { kind: "conversation", threadId: targetThreadId, turnId: targetTurnId, status: "failed" });
            inFlightTurns.delete(turnKey);
            resolveInFlight(result);
            json(response, 409, { error: { code: "workspace-required", message } });
            return;
          }
          if (requestedSpecialist?.role === "Software engineering" && (!session || !workspaceRoot)) {
            json(response, 409, { error: { code: "workspace-required", message: "Open a project workspace before starting a Cody conversation." } }); return;
          }

          if (definition.id === composition.maestroDefinitionId && composition.decideMaestroTurn) {
            directMaestroDecision = true;
            decisionProviderId = modelSelection?.providerConnectionId;
            decisionModelId = modelSelection?.modelId;

            let decision;
            const tBeforeDecision = performance.now();
            try {
              emitDirectTurnEvent(turnKey, {
                id: `agent-start-${targetTurnId}`,
                type: "agent.started",
                threadId: targetThreadId,
                turnId: targetTurnId,
                timestamp: Date.now(),
                payload: {},
              });

              let accumulatedMessage = "";
              decision = requestedSpecialist
                ? { type: "delegate_text", independence: "The user explicitly selected one specialist for this turn.", assignments: [{
                      definitionId: requestedSpecialist.id, objective: resolvedContext.promptWithContext,
                      relevantContext: "Prior private conversation context will be added by the authorized specialist-session runtime.",
                      relevantContextRefs: [], constraints: [], expectedOutcome: "Answer the user's specialist request using the assigned specialist's actual tools and report evidence or blockers.",
                      evidenceExpectations: ["Cite retrieved sources or state when evidence is unavailable."],
                      requiredCapabilities: requestedSpecialist.role === "doc" || requestedSpecialist.role === "research" || requestedSpecialist.role === "scraapy"
                        ? ["web.search", "web.crawl"] : requestedSpecialist.role === "Software engineering"
                          ? ["filesystem.read", "terminal.execute"] : requestedSpecialist.role === "tester"
                            ? ["text-inference", "filesystem.list", "filesystem.read", "terminal.execute"] : ["text-inference"],
                    }] }
                : await composition.decideMaestroTurn(resolvedContext.promptWithContext, {
                  ...turnOptions,
                  onProgress: (chunk: string) => {
                  accumulatedMessage += chunk;
                  emitDirectTurnEvent(turnKey, {
                    id: `agent-prog-${targetTurnId}`,
                    type: "agent.progress",
                    threadId: targetThreadId,
                    turnId: targetTurnId,
                    timestamp: Date.now(),
                    payload: {
                      item: {
                        id: `maestro-${targetTurnId}`,
                        turnId: targetTurnId,
                        type: "agent_message",
                        actor: maestroActor,
                        timestamp: Date.now(),
                        text: sanitizeReasoningAndSecrets(accumulatedMessage),
                      },
                    },
                  });
                  },
              }, turnController.signal);
              if (turnController.signal.aborted) throw new Error("turn-cancelled");
            } catch (error) {
              if (turnController.signal.aborted || (error instanceof Error && error.message === "turn-cancelled")) {
                await history.updateTurn(targetThreadId, targetTurnId, (t) => {
                  t.status = "cancelled"; t.currentActivity = "completed"; t.completedAt = t.completedAt ?? Date.now();
                });
                turnAbortControllers.delete(turnKey);
                const result: TurnStartResult = { turnId: targetTurnId, direct: true };
                settledTurns.set(turnKey, { kind: "conversation", threadId: targetThreadId, turnId: targetTurnId, status: "cancelled" });
                emitDirectTurnEvent(turnKey, {
                  id: `turn-cancelled-${targetTurnId}`,
                  type: "turn.cancelled",
                  threadId: targetThreadId,
                  turnId: targetTurnId,
                  timestamp: Date.now(),
                  payload: { summary: "Turn cancelled." },
                });
                resolveInFlight(result);
                json(response, 202, result);
                return;
              }
              throw error;
            }
            const decisionDurationMs = Math.round((performance.now() - tBeforeDecision) * 100) / 100;

            if (decision.type === "respond" || decision.type === "request_user_input") {
              const message = sanitizeReasoningAndSecrets(decision.type === "respond" ? decision.message : decision.question);
              const assistantItem: ThreadItem = { id: `maestro-${targetTurnId}`, turnId: targetTurnId, type: "agent_message",
                actor: maestroActor, timestamp: Date.now(), text: message };
              await history.updateTurn(targetThreadId, targetTurnId, (t) => {
                if (t.status === "cancelled") return;
                if (!t.items.some((item) => item.id === assistantItem.id)) t.items.push(assistantItem);
                t.status = "completed"; t.currentActivity = "completed"; t.completedAt = assistantItem.timestamp;
              });
              const savedThread = await history.get(targetThreadId);
              const savedTurn = savedThread?.turns.find((entry) => entry.id === targetTurnId);
              const finalStatus = savedTurn?.status === "cancelled" ? "cancelled" : "completed";
              turnAbortControllers.delete(turnKey);
              const totalResponseMs = Math.round((performance.now() - turnStartTime) * 100) / 100;
              const requestProcessingMs = Math.round((tAfterRequest - turnStartTime) * 100) / 100;
              const orchestrationOverheadMs = Math.max(0, Math.round((totalResponseMs - decisionDurationMs) * 100) / 100);
              const timing = {
                requestProcessingMs,
                projectContextMs,
                decisionDurationMs,
                totalResponseMs,
                orchestrationOverheadMs,
              };
              process.stderr.write(`${JSON.stringify({
                event: "maestro.turn.executed",
                turnId: targetTurnId,
                threadId: targetThreadId,
                status: finalStatus,
                isOrdinary,
                timing,
              })}\n`);
              const result: TurnStartResult = {
                turnId: targetTurnId,
                direct: true,
                providerId: modelSelection?.providerConnectionId,
                modelId: modelSelection?.modelId,
                modelExecution: modelSelection
                  ? {
                      providerConnectionId: modelSelection.providerConnectionId,
                      providerId: modelSelection.providerConnectionId,
                      modelId: modelSelection.modelId,
                      displayName: providerRepo.get(modelSelection.providerConnectionId)?.models.find((model) => model.id === modelSelection.modelId)?.name,
                    }
                  : undefined,
              };
              settledTurns.set(turnKey, { kind: "conversation", threadId: targetThreadId, turnId: targetTurnId, status: finalStatus });
              resolveInFlight(result);
              emitDirectTurnEvent(turnKey, {
                id: `turn-completed-${targetTurnId}`,
                type: "turn.completed",
                threadId: targetThreadId,
                turnId: targetTurnId,
                timestamp: Date.now(),
                payload: { summary: "Task completed.", item: assistantItem },
              });
              json(response, 202, result);
              return;
            }
            turnOptions.maestroDecision = decision;
          }

          if (turnController.signal.aborted) throw new Error("turn-cancelled");

          // REGISTER PERSISTENCE LISTENER BEFORE EXECUTION CAN EMIT EVENTS!
          // composition.submit invokes the onBeforeEmit callback inside task creation before publish()
          const submitted = composition.submit(
            definition.id,
            resolvedContext.promptWithContext,
            turnOptions,
            (taskId) => {
              assignedTaskId = taskId;
              rememberTaskWorkspace(taskId, session?.workspaceId ?? null);
              const subs = composition.subscribers.get(taskId) ?? new Set();
              subs.add(serverPersistListener);
              composition.subscribers.set(taskId, subs);
            }
          );
          assignedTaskId = submitted.taskId;
          settledTurns.set(turnKey, { kind: "task", taskId: submitted.taskId, threadId: targetThreadId, turnId: targetTurnId });
          turnAbortControllers.delete(turnKey);

          // Also persist taskId on turn in SQLite
          await history.updateTurn(targetThreadId, targetTurnId, (t) => {
            t.taskId = submitted.taskId;
          }).catch(() => {});

          const result = {
            turnId: targetTurnId,
            taskId: submitted.taskId,
            providerId: modelSelection?.providerConnectionId,
            modelId: modelSelection?.modelId,
            modelExecution: modelSelection
              ? { providerConnectionId: modelSelection.providerConnectionId, providerId: modelSelection.providerConnectionId,
                  modelId: modelSelection.modelId, displayName: providerRepo.get(modelSelection.providerConnectionId)?.models.find((model) => model.id === modelSelection.modelId)?.name }
              : undefined,
          };
          resolveInFlight(result);
          json(response, 202, result);
          return;
        } catch (error) {
          const abortedController = turnAbortControllers.get(turnKey);
          turnAbortControllers.delete(turnKey);
          if (abortedController?.signal.aborted) {
            await history.updateTurn(targetThreadId, targetTurnId, (t) => {
              t.status = "cancelled"; t.currentActivity = "completed"; t.completedAt = t.completedAt ?? Date.now();
            }).catch(() => {});
            const result: TurnStartResult = { turnId: targetTurnId, direct: true };
            settledTurns.set(turnKey, { kind: "conversation", threadId: targetThreadId, turnId: targetTurnId, status: "cancelled" });
            emitDirectTurnEvent(turnKey, {
              id: `turn-cancelled-${targetTurnId}`,
              type: "turn.cancelled",
              threadId: targetThreadId,
              turnId: targetTurnId,
              timestamp: Date.now(),
              payload: { summary: "Turn cancelled." },
            });
            resolveInFlight(result);
            json(response, 200, result);
            return;
          }
          rejectInFlight(error);
          const directFailure = directMaestroDecision ? directTurnErrorMessage(error) : undefined;
          if (directFailure) {
            process.stderr.write(`${JSON.stringify({ event: "maestro.turn.failed", worldId: composition.world.id,
              threadId: targetThreadId, turnId: targetTurnId, stage: "decision", category: directFailure.category,
              ...(error instanceof MaestroDecisionError ? { decisionReason: error.reason,
                ...(error.intent ? { intent: error.intent } : {}), recognizedKeys: error.recognizedKeys } : {}),
              ...(decisionProviderId ? { providerId: decisionProviderId } : {}), ...(decisionModelId ? { modelId: decisionModelId } : {}) })}\n`);
          }
          const mapped = directFailure ?? taskErrorMessage(error);
          const errMsg = typeof mapped.body === "object" && mapped.body && "error" in mapped.body && typeof (mapped.body as any).error?.message === "string"
            ? (mapped.body as any).error.message
            : (error instanceof Error ? error.message : "Task could not be started.");

          const failure = directFailure && error instanceof MaestroDecisionError
            ? { stage: "maestro-decision" as const, category: error.category, reason: error.reason,
                ...(decisionProviderId ? { providerId: decisionProviderId } : {}), ...(decisionModelId ? { modelId: decisionModelId } : {}) }
            : directFailure && error instanceof ModelProviderError
              ? { stage: "maestro-decision" as const, category: "provider" as const, reason: error.code,
                  ...(decisionProviderId ? { providerId: decisionProviderId } : {}), ...(decisionModelId ? { modelId: decisionModelId } : {}) }
              : undefined;

          await history.updateTurn(targetThreadId, targetTurnId, (t) => {
            t.status = "failed";
            t.currentActivity = "failed";
            t.completedAt = Date.now();
            t.items.push({
              id: `item-${Date.now()}-err`,
              turnId: targetTurnId,
              type: "agent_message",
              actor: { type: "system" },
              timestamp: Date.now(),
              text: `Turn ended: ${errMsg}`,
              ...(failure ? { failure } : {}),
            });
          }).catch(() => {});
          json(response, mapped.status, mapped.body);
          return;
        } finally {
          // inFlightTurns represents IN-FLIGHT synchronization only.
          inFlightTurns.delete(turnKey);
          if (turnAbortControllers.get(turnKey) === turnController) turnAbortControllers.delete(turnKey);
        }
      }

      const turnEvents = url.pathname.match(/^\/api\/turns\/([^/]+)\/events$/);
      if (request.method === "GET" && turnEvents) {
        const turnId = decodeURIComponent(turnEvents[1]!);
        const threadId = url.searchParams.get("threadId")?.trim();
        if (!threadId) { json(response, 400, { error: { message: "threadId is required." } }); return; }
        const turnKey = compositeTurnKey(threadId, turnId);
        const settled = settledTurns.get(turnKey);
        const initialThread = await history.get(threadId);
        const initialTurn = initialThread?.turns.find((entry) => entry.id === turnId);
        if (!initialTurn) { json(response, 404, { error: { message: "Turn not found." } }); return; }
        const taskId = settled?.kind === "task" ? settled.taskId : initialTurn.taskId as TaskId | undefined;

        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        response.write(": connected\n\n");

        if (taskId) {
          let ready = false;
          const pending: ProductEvent[] = [];
          const sent = new Set<string>();
          const send = (event: ProductEvent) => {
            if (response.writableEnded || !taskId || event.taskId !== taskId || sent.has(event.id)) return;
            sent.add(event.id);
            const mapped = mapProductEventToRuntimeEvent(event, threadId, turnId);
            response.write(`id: ${event.id}\nevent: mediobot\ndata: ${JSON.stringify(mapped)}\n\n`);
            if (["task.completed", "task.failed", "task.cancelled", "task.paused"].includes(event.type)) {
              cleanupTaskSubscription();
              response.end();
            }
          };
          const bufferOrSend = (event: ProductEvent) => { if (ready) send(event); else pending.push(event); };
          const listeners = composition.subscribers.get(taskId) ?? new Set();
          listeners.add(bufferOrSend);
          composition.subscribers.set(taskId, listeners);

          const cleanupTaskSubscription = () => {
            clearInterval(keepAlive);
            listeners.delete(bufferOrSend);
            if (!listeners.size) composition.subscribers.delete(taskId);
          };

          const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
          keepAlive.unref();
          response.on("close", () => {
            clearInterval(keepAlive);
            cleanupTaskSubscription();
          });

          // Subscribe before reading either snapshot or durable history. Events
          // arriving during the reads are buffered and drained after ordered replay.
          try {
            let [latestThread, taskHistory] = await Promise.all([
              history.get(threadId),
              composition.getTaskEvents ? composition.getTaskEvents(taskId) : Promise.resolve(composition.taskEvents.get(taskId) ?? []),
            ]);
            if (response.writableEnded) return;
            const initialTranscriptTurn = latestThread?.turns.find((entry) => entry.id === turnId) ?? initialTurn;
            const initialTranscriptSequence = initialTranscriptTurn.lastEventSequence ?? 0;
            let latestTurn = initialTranscriptTurn;
            await projectDurableEventsIntoTurn(threadId, turnId, taskHistory, latestTurn.lastEventSequence ?? 0);
            latestThread = await history.get(threadId);
            latestTurn = latestThread?.turns.find((entry) => entry.id === turnId) ?? latestTurn;
            const suppliedCursor = request.headers["last-event-id"] || url.searchParams.get("lastEventId") || undefined;
            const cursor = typeof suppliedCursor === "string" ? suppliedCursor.trim() : "";
            const eventCursor = cursor ? taskHistory.find((event) => event.id === cursor) : undefined;
            const snapshotPrefix = `snapshot-${turnId}-`;
            const snapshotCursor = cursor.startsWith(snapshotPrefix)
              ? Number(cursor.slice(snapshotPrefix.length)) : Number.NaN;
            const validSnapshotCursor = Number.isSafeInteger(snapshotCursor) && snapshotCursor >= 0;
            let snapshotCoversSequence: number | undefined;

            if (eventCursor || validSnapshotCursor || !cursor) {
              // A connected EventSource retains the snapshot already applied by
              // the client, so replay only events after its durable cursor.
              // A first connection gets the current transcript snapshot and any
              // journal entries newer than the transcript projection.
              const cursorSequence = eventCursor?.sequence ?? (validSnapshotCursor ? snapshotCursor : undefined);
              if (cursorSequence === undefined) {
                // Projection above reconstructs current state, but the replay
                // cursor remains the sequence captured before projection so
                // journal events without transcript items are still delivered.
                snapshotCoversSequence = initialTranscriptSequence;
                const snapshotEvent = {
                  type: "turn.snapshot", threadId, turnId,
                  ...(latestTurn.taskId ? { taskId: latestTurn.taskId } : {}),
                  timestamp: Date.now(), payload: { turn: latestTurn },
                };
                response.write(`id: snapshot-${turnId}-${initialTranscriptSequence}\nevent: mediobot\ndata: ${JSON.stringify(snapshotEvent)}\n\n`);
              }
              const replayAfter = cursorSequence ?? initialTranscriptSequence;
              for (const event of [...taskHistory].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
                if ((event.sequence ?? 0) <= replayAfter) continue;
                send(event);
                if (response.writableEnded) return;
              }
            } else {
              // An expired event cursor cannot be mapped to the bounded journal;
              // recover from the complete sanitized transcript snapshot.
              snapshotCoversSequence = latestTurn.lastEventSequence ?? 0;
              const snapshotEvent = {
                type: "turn.snapshot", threadId, turnId,
                ...(latestTurn.taskId ? { taskId: latestTurn.taskId } : {}),
                timestamp: Date.now(), payload: { turn: latestTurn },
              };
              response.write(`id: snapshot-${turnId}-${latestTurn.lastEventSequence ?? 0}\nevent: mediobot\ndata: ${JSON.stringify(snapshotEvent)}\n\n`);
              const replayAfter = latestTurn.lastEventSequence ?? 0;
              for (const event of [...taskHistory].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
                if ((event.sequence ?? 0) <= replayAfter) continue;
                send(event);
                if (response.writableEnded) return;
              }
            }
            ready = true;
            for (const event of pending.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
              if (snapshotCoversSequence !== undefined && (event.sequence ?? 0) <= snapshotCoversSequence) continue;
              send(event);
              if (response.writableEnded) return;
            }
            if (["completed", "failed", "cancelled"].includes(latestTurn.status) && !response.writableEnded) {
              cleanupTaskSubscription();
              response.end();
            }
          } catch (error) {
            clearInterval(keepAlive);
            cleanupTaskSubscription();
            throw error;
          }
          return;
        }

        const latestThread = await history.get(threadId);
        const latestTurn = latestThread?.turns.find((entry) => entry.id === turnId) ?? initialTurn;
        const snapshotEvent = {
          type: "turn.snapshot",
          threadId,
          turnId,
          ...(latestTurn.taskId ? { taskId: latestTurn.taskId } : {}),
          timestamp: Date.now(),
          payload: { turn: latestTurn },
        };
        response.write(`id: snapshot-${turnId}-${latestTurn.lastEventSequence ?? 0}\nevent: mediobot\ndata: ${JSON.stringify(snapshotEvent)}\n\n`);

        // Direct conversational turn live streaming
        if (["completed", "cancelled", "failed"].includes(latestTurn.status)) {
          if (latestTurn.status === "completed") {
            const completedEvent = { type: "turn.completed", threadId, turnId, timestamp: Date.now(), payload: { summary: "Task completed." } };
            response.write(`id: turn-completed-${turnId}\nevent: mediobot\ndata: ${JSON.stringify(completedEvent)}\n\n`);
          } else if (latestTurn.status === "cancelled") {
            const cancelledEvent = { type: "turn.cancelled", threadId, turnId, timestamp: Date.now(), payload: { summary: "Turn cancelled." } };
            response.write(`id: turn-cancelled-${turnId}\nevent: mediobot\ndata: ${JSON.stringify(cancelledEvent)}\n\n`);
          } else if (latestTurn.status === "failed") {
            const failedItem = latestTurn.items.find((it) => it.type === "agent_message" && it.actor?.type === "system");
            const failedEvent = {
              type: "turn.failed",
              threadId,
              turnId,
              timestamp: Date.now(),
              payload: {
                summary: failedItem?.text ?? "Turn failed.",
                ...(failedItem ? { item: failedItem } : {}),
              },
            };
            response.write(`id: turn-failed-${turnId}\nevent: mediobot\ndata: ${JSON.stringify(failedEvent)}\n\n`);
          }
          response.end();
          return;
        }

        const sendDirect = (evt: Record<string, unknown>) => {
          if (response.writableEnded) return;
          const eventId = typeof evt.id === "string" ? evt.id : `evt-${Date.now()}`;
          response.write(`id: ${eventId}\nevent: mediobot\ndata: ${JSON.stringify(evt)}\n\n`);
          if (typeof evt.type === "string" && ["turn.completed", "turn.failed", "turn.cancelled"].includes(evt.type)) {
            cleanupDirectSubscription();
            response.end();
          }
        };

        const subs = directTurnSubscribers.get(turnKey) ?? new Set();
        subs.add(sendDirect);
        directTurnSubscribers.set(turnKey, subs);

        const cleanupDirectSubscription = () => {
          subs.delete(sendDirect);
          if (!subs.size) directTurnSubscribers.delete(turnKey);
        };

        const bufferedEvents = directTurnEvents.get(turnKey) ?? [];
        for (const evt of bufferedEvents) {
          sendDirect(evt);
        }

        if (response.writableEnded) return;

        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
        keepAlive.unref();
        response.on("close", () => {
          clearInterval(keepAlive);
          cleanupDirectSubscription();
        });
        return;
      }

      const specialistGroupHistoryMatch = url.pathname.match(/^\/api\/specialists\/([^/]+)\/group-history$/);
      if (request.method === "GET" && specialistGroupHistoryMatch) {
        let requestedSpecialistId: string;
        try { requestedSpecialistId = decodeURIComponent(specialistGroupHistoryMatch[1]!); }
        catch { json(response, 400, { error: { code: "invalid-specialist", message: "Choose a valid specialist." } }); return; }
        const specialist = composition.definitions.find(definition => definition.id === requestedSpecialistId
          || definition.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") === requestedSpecialistId);
        if (!specialist) { json(response, 404, { error: { code: "specialist-not-found", message: "That specialist is not available." } }); return; }
        // Historical tasks can reference persisted alias IDs that are intentionally
        // folded out of the user-facing definition roster. Resolve attribution from
        // the runtime registry so those messages still show a readable bot name.
        const specialistName = (definitionId: string) => composition.world.inspect().definitions
          .find(definition => definition.id === definitionId)?.name ?? definitionId;
        const session = workspaceManager.status === "OPEN" ? workspaceManager.session : null;
        const engine = composition.durableTaskEngine ?? durableTaskEngine;
        if (!session || !engine) { json(response, 200, { groups: [] }); return; }
        try {
          const taskRecords = (await engine.listTasks(session.workspaceId)).slice(0, 100);
          const groups: Array<{
            taskId: string; taskGoal: string; groupId: string; status: "active" | "completed" | "cancelled" | "failed";
            messages: Array<{ id: string; sequenceNumber: number; senderSpecialistId: string; senderName: string;
              kind: "finding" | "request"; content: string; evidenceRefs: readonly string[]; createdAt: number }>;
            privateMessages: Array<{ id: string; sequenceNumber: number; senderSpecialistId: string; senderName: string;
              kind: "request" | "finding" | "response"; deliveryStatus: string; content: string; evidenceRefs: readonly string[]; createdAt: number }>;
          }> = [];
          for (const task of taskRecords) {
            if (!task.threadId) continue;
            const delegations = await engine.getDelegations(task.id);
            const assigned = task.definitionId === specialist.id || delegations.some(delegation =>
              delegation.assignedMediobotId === specialist.id && delegation.status !== "cancelled" && delegation.status !== "failed");
            if (!assigned) continue;
            const access = await engine.authorizeSpecialistSessionScope(task.id, specialist.id);
            const group = await engine.getCollaborationGroupForTask(access);
            if (!group) continue;
            const history = await engine.listCollaborationGroupMessages(access, group.id, 6, 2_000);
            const privateHistory = await engine.getSpecialistMessages(access, { limit: 12 });
            const privateMessages = privateHistory.flatMap(message => {
              if (message.parentTaskId !== task.id || message.recipientSpecialistId !== specialist.id) return [];
              try {
                const payload = JSON.parse(message.content) as { kind?: unknown; text?: unknown };
                if (!(["request", "finding", "response"] as unknown[]).includes(payload.kind)
                  || typeof payload.text !== "string" || !payload.text.trim()) return [];
                return [{ id: message.id, sequenceNumber: message.sequenceNumber, senderSpecialistId: message.senderSpecialistId,
                  senderName: specialistName(message.senderSpecialistId),
                  kind: payload.kind as "request" | "finding" | "response", deliveryStatus: message.deliveryStatus,
                  content: payload.text.slice(0, 1_000), evidenceRefs: message.evidenceRefs.slice(0, 8), createdAt: message.createdAt }];
              } catch { return []; }
            });
            if (!history.messages.length && !privateMessages.length) continue;
            groups.push({ taskId: task.id, taskGoal: task.goal.slice(0, 180), groupId: group.id, status: group.status,
              messages: history.messages.map(message => ({ id: message.id, sequenceNumber: message.sequenceNumber,
                senderSpecialistId: message.senderSpecialistId,
                senderName: specialistName(message.senderSpecialistId),
                kind: message.kind, content: message.content, evidenceRefs: message.evidenceRefs, createdAt: message.createdAt })),
              privateMessages });
          }
          groups.sort((left, right) => (right.messages.at(-1)?.createdAt ?? 0) - (left.messages.at(-1)?.createdAt ?? 0));
          json(response, 200, { groups: groups.slice(0, 6) });
        } catch {
          json(response, 503, { error: { code: "collaboration-history-unavailable", message: "Shared collaboration history is temporarily unavailable." } });
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tasks") {
        const session = workspaceManager.status === "OPEN" ? workspaceManager.session : null;
        const engine = composition.durableTaskEngine ?? durableTaskEngine;
        let taskViews: (TaskView | undefined)[];
        if (engine) {
          // The runtime world is shared across workspace switches. Use the
          // durable workspace index as the authoritative task list so live
          // in-memory tasks from another project cannot leak into this view.
          const durableTasks = await engine.listTasks(session?.workspaceId ?? null);
          taskViews = (await Promise.all(durableTasks.map((task) => readTaskView(task.id as TaskId)))).filter(Boolean);
        } else {
          const snapshot = composition.world.inspect();
          taskViews = (await Promise.all(snapshot.tasks.map((task) => readTaskView(task.id)))).filter(Boolean);
        }
        const tasks = composition.getTaskEvents
          ? await Promise.all(taskViews.map(async task => task ? { ...task, events: await composition.getTaskEvents!(task.id) } : task))
          : taskViews;
        json(response, 200, { tasks }); return;
      }

      if (url.pathname === "/api/tasks" && request.method === "POST") {
        let value: unknown;
        try { value = await body(request); } catch (error) {
          json(response, error instanceof Error && error.message === "request-too-large" ? 413 : 400,
            { error: { code: "invalid-request", message: "The request body must be valid JSON under 32 KB." } }); return;
        }
        if (!value || typeof value !== "object" || !("definitionId" in value) || !("goal" in value)
          || typeof value.definitionId !== "string" || typeof value.goal !== "string"
          || value.goal.trim().length === 0 || value.goal.length > 4000
          || !composition.definitions.some((definition) => definition.id === value.definitionId)) {
          json(response, 400, { error: { code: "invalid-request", message: "Choose an available Mediobot and enter a task goal." } }); return;
        }
        const taskInput = value as Record<string, unknown>;
        const selection = taskInput.modelSelection && typeof taskInput.modelSelection === "object"
          ? taskInput.modelSelection as ThreadModelSelection : undefined;
        if (productRuntime && !selection) {
          json(response, 409, { error: { code: "model-not-selected", message: "Connect and enable a model in Settings, then select it before starting a task." } }); return;
        }
        if (productRuntime && selection) {
          try { modelResolver.resolveTextClient(selection); }
          catch (error) { json(response, 409, { error: { code: "model-unavailable", message: error instanceof Error ? error.message : "The selected model is unavailable." } }); return; }
        }
        const session = workspaceManager.status === "OPEN" ? workspaceManager.session : null;
        if ((value.definitionId === composition.codyDefinitionId || value.definitionId === composition.maestroDefinitionId) && !workspaceManager.isSessionValid(session)) {
          json(response, 409, { error: { code: "workspace-required", message: "Open a project workspace before starting project-bound execution." } }); return;
        }
        const engine = composition.durableTaskEngine ?? durableTaskEngine;
        if (engine && typeof taskInput.idempotencyKey === "string" && taskInput.idempotencyKey.trim()) {
          const existing = await engine.getTaskByIdempotencyKey(taskInput.idempotencyKey.trim(), session?.workspaceId);
          if (existing) {
            const task = await readTaskView(existing.id as TaskId);
            json(response, 200, { task, deduplicated: true }); return;
          }
        }
        try {
          const submitted = composition.submit(value.definitionId as typeof composition.visionDefinitionId, value.goal.trim(), {
            workspaceRoot: session?.canonicalRootPath,
            workspaceId: session?.workspaceId,
            modelSelection: selection,
            approvalMode: (typeof taskInput.approvalMode === "string" ? taskInput.approvalMode : options.defaultApprovalMode) ?? "Approve for me",
            priority: (typeof taskInput.priority === "string" ? taskInput.priority : "background") as any,
            idempotencyKey: typeof taskInput.idempotencyKey === "string" ? taskInput.idempotencyKey.trim() : undefined,
          }, (taskId) => rememberTaskWorkspace(taskId, session?.workspaceId ?? null));
          if (engine) {
            await engine.submitTask({
              id: submitted.taskId,
              goal: value.goal.trim(),
              definitionId: value.definitionId,
              workspaceId: session?.workspaceId ?? null,
              idempotencyKey: typeof taskInput.idempotencyKey === "string" ? taskInput.idempotencyKey.trim() : null,
            }).catch(() => {});
          }
          const task = await readTaskView(submitted.taskId);
          json(response, 202, { task }); return;
        } catch (error) { const mapped = taskErrorMessage(error); json(response, mapped.status, mapped.body); return; }
      }

      const taskPath = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(cancel|events|resume|pause))?$/);
      if (taskPath) {
        const taskId = taskPath[1] as TaskView["id"];
        if (request.method === "GET" && !taskPath[2]) {
          if (!await taskIsInActiveWorkspace(taskId)) { json(response, 404, { error: { code: "not-found", message: "Task not found." } }); return; }
          const task = await readTaskView(taskId);
          if (!task) { json(response, 404, { error: { code: "not-found", message: "Task not found." } }); return; }
          const events = composition.getTaskEvents ? await composition.getTaskEvents(taskId) : task.events;
          json(response, 200, { task: { ...task, events } }); return;
        }
        if (request.method === "POST" && taskPath[2] === "cancel") {
          if (!await taskIsInActiveWorkspace(taskId)) { json(response, 404, { error: { code: "not-found", message: "Task not found." } }); return; }
          try { await composition.cancel(taskId); json(response, 202, { task: await readTaskView(taskId) }); }
          catch { json(response, 409, { error: { code: "not-running", message: "This task is not currently running." } }); }
          return;
        }
        if (request.method === "POST" && taskPath[2] === "pause") {
          if (!await taskIsInActiveWorkspace(taskId)) { json(response, 404, { error: { code: "not-found", message: "Task not found." } }); return; }
          if (!composition.pause) { json(response, 409, { error: { code: "pause-unavailable", message: "Task pause is not available in this runtime." } }); return; }
          try {
            await composition.pause(taskId);
            json(response, 202, { ok: true, pauseRequested: true, task: await readTaskView(taskId) });
          } catch (error) {
            json(response, 409, { error: { code: "pause-unavailable", message: error instanceof Error ? error.message : "Task cannot be paused." } });
          }
          return;
        }
        if (request.method === "POST" && taskPath[2] === "resume") {
          const resumeTask = async () => {
          const engine = composition.durableTaskEngine ?? durableTaskEngine;
          if (!engine) {
            json(response, 500, { error: { code: "not-configured", message: "Durable tasks are not configured." } });
            return;
          }
          const taskRecord = await engine.getTask(taskId);
          if (!taskRecord) {
            json(response, 404, { error: { code: "not-found", message: "Task not found." } });
            return;
          }
          if (taskRecord.status !== "interrupted" && taskRecord.status !== "queued" && taskRecord.status !== "paused") {
            json(response, 409, { error: { code: "invalid-state", message: `Task cannot be resumed from status "${taskRecord.status}".` } });
            return;
          }
          try {
            const session = workspaceManager.status === "OPEN" ? workspaceManager.session : null;
            if (taskRecord.workspaceId !== null
              && (!session || session.workspaceId !== taskRecord.workspaceId)) {
              json(response, 409, { error: { code: "workspace-mismatch",
                message: "Open the task's original workspace before resuming it." } });
              return;
            }
            let resumeModelSelection: ThreadModelSelection | undefined;
            try {
              const bodyPayload = await body(request);
              if (bodyPayload && typeof bodyPayload === "object" && "modelSelection" in bodyPayload) {
                resumeModelSelection = (bodyPayload as any).modelSelection;
              }
            } catch {}
            resumeModelSelection ??= await engine.getTaskModelSelection(taskId);
            if (!resumeModelSelection && taskRecord.threadId) {
              resumeModelSelection = (await history.get(taskRecord.threadId))?.modelSelection;
            }
            if (productRuntime && !resumeModelSelection) {
              json(response, 409, { error: { code: "model-selection-required",
                message: "This interrupted task has no saved model selection. Select a connected model to resume it." } }); return;
            }
            if (resumeModelSelection) {
              try { modelResolver.resolveTextClient(resumeModelSelection); }
              catch (error) {
                json(response, 409, { error: { code: "model-unavailable",
                  message: error instanceof Error ? error.message : "The task's selected model is unavailable." } }); return;
              }
            }
            if (composition.resume) {
              await composition.resume(taskId, {
                workspaceRoot: taskRecord.workspaceId === null ? undefined : session!.canonicalRootPath,
                workspaceId: taskRecord.workspaceId,
                approvalMode: options.defaultApprovalMode ?? "Approve for me",
                modelSelection: resumeModelSelection,
              });
            }
            json(response, 202, { task: await readTaskView(taskId), resumed: true });
            return;
          } catch (error) {
            json(response, 500, { error: { code: "resume-failed", message: error instanceof Error ? error.message : "Failed to resume task." } });
            return;
          }
          };
          if (composition.withTaskControlLock) await composition.withTaskControlLock(taskId, resumeTask);
          else await resumeTask();
          return;
        }
        if (request.method === "GET" && taskPath[2] === "events") {
          if (!await taskIsInActiveWorkspace(taskId) || !await readTaskView(taskId)) { json(response, 404, { error: { code: "not-found", message: "Task not found." } }); return; }
          const lastEventId = request.headers["last-event-id"] || (url.searchParams.get("lastEventId") ?? undefined);
          const lastIdStr = typeof lastEventId === "string" ? lastEventId.trim() : undefined;
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
          response.write(": connected\n\n");
          const listeners = composition.subscribers.get(taskId) ?? new Set();
          const seen = new Set<string>();
          const pending: ProductEvent[] = [];
      const terminalEvents = new Set<ProductEvent["type"]>(["task.completed", "task.failed", "task.cancelled", "task.paused"]);
          let replaying = true;
          let finished = false;
          const writeEvent = (event: ProductEvent) => {
            if (finished || seen.has(event.id)) return;
            seen.add(event.id);
            response.write(`id: ${event.id}\nevent: product\ndata: ${JSON.stringify(normalizeProductEvent(event))}\n\n`);
            if (terminalEvents.has(event.type)) {
              finished = true;
              cleanup();
              response.end();
            }
          };
          const send = (event: ProductEvent) => {
            if (finished) return;
            if (replaying) pending.push(event);
            else writeEvent(event);
          };
          // Subscribe before reading durable history so an event appended during
          // replay is buffered and delivered after the snapshot, without a gap.
          listeners.add(send); composition.subscribers.set(taskId, listeners);
          const cleanup = () => {
            clearInterval(keepAlive);
            listeners.delete(send);
            if (!listeners.size) composition.subscribers.delete(taskId);
          };
          const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
          keepAlive.unref();
          response.on("close", cleanup);
          try {
            const taskHistory = composition.getTaskEvents ? await composition.getTaskEvents(taskId) : composition.taskEvents.get(taskId) ?? [];
            let historyToReplay = taskHistory;
            if (lastIdStr) {
              const lastIdx = taskHistory.findIndex((event) => event.id === lastIdStr);
              if (lastIdx >= 0) historyToReplay = taskHistory.slice(lastIdx + 1);
            }
            for (const event of historyToReplay) {
              writeEvent(event);
              if (finished) break;
            }
            replaying = false;
            for (const event of pending.splice(0)) {
              writeEvent(event);
              if (finished) break;
            }
          } catch (error) {
            cleanup();
            throw error;
          }
          return;
        }
      }

      if (vite) {
        vite.middlewares(request, response, (error?: unknown) => {
          if (error) { vite?.ssrFixStacktrace(error as Error); json(response, 500, { error: { code: "internal", message: "The local interface could not be served." } }); }
          else if (!response.headersSent) json(response, 404, { error: { code: "not-found", message: "Not found." } });
        });
        return;
      }
      json(response, 404, { error: { code: "not-found", message: "Not found." } });
    } catch (error) {
      console.error("Internal server error:", error);
      if (!response.headersSent) json(response, 500, { error: { code: "internal", message: "The local command center encountered an error." } });
      else response.end();
      if (vite && error instanceof Error) vite.ssrFixStacktrace(error);
    }
  });

  let url: string | undefined;
  if (options.listen !== false) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 4173, options.host ?? "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port ?? 4173;
    url = `http://${options.host ?? "127.0.0.1"}:${port}`;
  }

  return {
    url,
    server,
    composition,
    history,
    providerRepo,
    modelResolver,
    workspaceManager,
    inFlightTurns: {
      has: (key: string) => inFlightTurns.has(key as any),
      get size() { return inFlightTurns.size; },
      keys: () => Array.from(inFlightTurns.keys()),
    },
    settledTurns: {
      has: (key: string) => settledTurns.has(key as any),
      get size() { return settledTurns.size; },
      keys: () => Array.from(settledTurns.keys()),
    },
    handle: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) =>
      server.emit("request", request, response),
    close: async () => {
      if (server.listening) {
        if (typeof (server as any).closeAllConnections === "function") {
          (server as any).closeAllConnections();
        }
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
      for (const controller of turnAbortControllers.values()) controller.abort();
      const pendingTurnStarts = Promise.allSettled([...inFlightTurns.values()]);
      let turnTimeout: ReturnType<typeof setTimeout> | undefined;
      const turnsSettled = await Promise.race([
        pendingTurnStarts.then(() => true),
        new Promise<false>(resolve => { turnTimeout = setTimeout(() => resolve(false), 10_000); }),
      ]);
      if (turnTimeout) clearTimeout(turnTimeout);
      if (!turnsSettled) throw new Error("Active turn decisions did not settle before shutdown; the database remains open.");
      await composition.shutdown?.();
      composition.permissionEngine?.suspendForRestart();
      workspaceManager.dispose();
      try { db.close(); } catch {}
      await vite?.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startCommandCenter().then(({ url }) => process.stdout.write(`Mediobot Command Center ready at ${url}\n`))
    .catch((error: unknown) => { process.stderr.write(`Command Center could not start: ${error instanceof Error ? error.message : "unknown error"}\n`); process.exitCode = 1; });
}

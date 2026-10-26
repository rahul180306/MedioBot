import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorld } from "@mediobot-v2/domain";
import type { MediobotDefinitionId, TaskId, WorkerActivityState, World } from "@mediobot-v2/domain";
import { RuntimeTaskSubmission, TaskSubmissionError, WorkerRuntime, DurableTaskEngine, ResourceGovernor, Crawl4AiRuntime } from "@mediobot-v2/runtime";
import type { SupervisionNotice, WorkerExecutionContext } from "@mediobot-v2/runtime";
import { CodyDecisionProvider } from "@mediobot-v2/cody";
import { TesterDecisionProvider } from "@mediobot-v2/tester";
import { LangGraphInterruptedError, MaestroDecisionProvider, MarkdownSkillCatalog, createMaestroCodyExecution, parseMediobotDefinition } from "@mediobot-v2/maestro";
import type { TrustedCompletion } from "@mediobot-v2/maestro";
import { ToolRuntime, ToolPermissionEngine } from "@mediobot-v2/tools";
import { sanitizeReasoningAndSecrets } from "@mediobot-v2/models";
import { ModelDecisionProvider, VisionExecutionAdapter, createModelPerceptionProvider, createBrowserOutcomeVerifier, PlaywrightBrowserRuntime } from "@mediobot-v2/vision";
import type { VisualPolicy, BrowserOutcomePolicy, BrowserRuntime } from "@mediobot-v2/vision";
import type { CommandCenterComposition, DefinitionView, ProductEvent, ProductEventType, TaskView } from "./contracts.ts";
import type { FileDiff } from "./types/index.ts";
import { LocalProjectCatalog } from "./projects.ts";
import { visionProductEvent, worldProductEvent } from "./events.ts";
import { categorizeFailure } from "./failureCategories.ts";
import { globalOwnWriteRegistry } from "./watcher/workspaceWatcher.ts";
import type { UnifiedFileLockService, ExecutionScope } from "@mediobot-v2/contracts";

const JOURNALED_PRODUCT_EVENT_TYPES = new Set<ProductEventType>([
  "task.created", "task.started", "task.pause_requested", "task.paused", "task.resumed", "task.completed", "task.failed", "task.cancelled", "maestro.responded",
  "worker.started", "worker.assigned", "worker.message", "worker.progress", "worker.completed", "worker.cancelled", "worker.failed",
  "tool.started", "tool.completed", "tool.failed", "tool.cancelled", "file.changed", "approval.required", "approval.resolved",
  "worker.observing", "worker.action-selected", "worker.action-verified", "worker.finish-requested", "worker.goal-verified",
]);

const SAFE_ACTIVITY_STATES = new Set<WorkerActivityState>(["thinking", "planning", "inspecting", "editing", "running", "testing", "verifying", "researching",
  "collaborating", "waiting", "waiting_for_approval", "retrying", "recovered", "verified", "blocked", "completed", "failed", "cancelled"]);

export function normalizeProductEvent(event: ProductEvent): ProductEvent {
  const message = event.message ? sanitizeReasoningAndSecrets(event.message) : undefined;
  const isToolFailure = event.type === "tool.failed";
  const safeErrorCode = event.errorCode && ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "E2BIG", "ENOTDIR", "EISDIR", "EMFILE", "ENFILE", "PROCESS_TERMINATED", "TERMINAL_OUTCOME_UNKNOWN"].includes(event.errorCode)
    ? event.errorCode : undefined;
  const terminationSignal = typeof event.terminationSignal === "string"
    && ["SIGABRT", "SIGALRM", "SIGBREAK", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP", "SIGUSR1", "SIGUSR2"].includes(event.terminationSignal)
    ? event.terminationSignal : undefined;
  const activityState = event.activityState && SAFE_ACTIVITY_STATES.has(event.activityState) ? event.activityState : undefined;
  const terminalDiagnostic = event.toolName === "terminal.execute" && event.type.startsWith("tool.")
    && (Boolean(event.errorCode) || Boolean(event.recoveryReason) || event.exitCode !== undefined);
  const terminalCommand = terminalDiagnostic && typeof event.command === "string"
    ? sanitizeReasoningAndSecrets(event.command)
      .replace(/((?:--?|\/)(?:password|passwd|token|secret|api[-_]?key|authorization|credential)(?:=|\s+))([^\s]+)/gi, "$1[REDACTED]")
      .replace(/([?&](?:password|passwd|token|secret|api[-_]?key|authorization|credential)=)[^&#\s]+/gi, "$1[REDACTED]")
      .replace(/[\r\n\t\0]/g, " ").slice(0, 500)
    : undefined;
  const workingDirectory = terminalDiagnostic && typeof event.workingDirectory === "string"
    ? event.workingDirectory.replace(/\\/g, "/").trim()
    : undefined;
  const safeWorkingDirectory = workingDirectory && !workingDirectory.startsWith("/") && !/^[A-Za-z]:/.test(workingDirectory)
    && !workingDirectory.split("/").includes("..") && !/[\r\n\0]/.test(workingDirectory) ? workingDirectory.slice(0, 180) : undefined;
  const recoveryReason = terminalDiagnostic && typeof event.recoveryReason === "string"
    ? sanitizeReasoningAndSecrets(event.recoveryReason).replace(/[\r\n\t\0]/g, " ").slice(0, 240) : undefined;
  const safeToolMessage = safeErrorCode === "ENOENT" && event.toolName === "terminal.execute"
    ? "Command could not start (ENOENT)."
    : safeErrorCode === "TERMINAL_OUTCOME_UNKNOWN" && event.toolName === "terminal.execute"
      ? "A previous terminal command may have taken effect; it was not repeated. Inspect the workspace or process state before continuing."
    : terminationSignal && event.toolName === "terminal.execute"
      ? `Process terminated by signal ${terminationSignal}.`
    : (safeErrorCode === "EACCES" || safeErrorCode === "EPERM") && event.toolName === "terminal.execute"
      ? `Command could not start (${safeErrorCode}).`
      : event.recoveredFromExecution && event.toolName === "terminal.execute" && typeof event.exitCode === "number"
        ? `Restored prior terminal result (exit code ${event.exitCode}); command was not run again.`
        : event.toolName === "terminal.execute" && typeof event.exitCode === "number"
        ? `Process exited with code ${event.exitCode}`
        : event.toolName === "terminal.execute" && event.exitCode === null && (event.stderrBytes ?? 0) > 0
          ? `Process ended without an exit code; ${event.stderrBytes} stderr bytes were captured.`
          : safeErrorCode === "ENOENT" && event.toolName === "filesystem.read"
            ? "File not found (ENOENT); no content was read."
            : (event.error?.message && /^(?:Process exited with code (?:\d+|null)|Command could not start \(ENOENT\)\.|Absolute paths are not allowed|File not found \(ENOENT\); no content was read\.)/.test(event.error.message))
              ? event.error.message : "Tool operation failed.";
  const error = isToolFailure ? { code: "execution_failed" as const, message: safeToolMessage }
    : event.error ? { code: event.error.code, message: sanitizeReasoningAndSecrets(event.error.message) } : undefined;
  // Rebuild the product contract instead of spreading producer objects. This
  // drops raw output, command strings, and arbitrary nested diagnostic fields.
  return {
    id: event.id, type: event.type, worldId: event.worldId, taskId: event.taskId,
    occurredAt: event.occurredAt,
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    ...(event.workerId ? { workerId: event.workerId } : {}),
    ...(event.executionTaskId ? { executionTaskId: event.executionTaskId } : {}),
    ...(event.workerDefinitionId ? { workerDefinitionId: event.workerDefinitionId } : {}),
    ...(event.workerName ? { workerName: event.workerName } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(activityState ? { activityState } : {}),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(terminalCommand ? { command: terminalCommand } : {}),
    ...(safeWorkingDirectory ? { workingDirectory: safeWorkingDirectory } : {}),
    ...(recoveryReason ? { recoveryReason } : {}),
    ...(safeErrorCode ? { errorCode: safeErrorCode } : {}),
    ...(event.recoveredFromExecution ? { recoveredFromExecution: true } : {}),
    ...(event.toolInvocationId ? { toolInvocationId: event.toolInvocationId } : {}),
    ...(event.failureCategory ? { failureCategory: event.failureCategory } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
    ...(event.isVerification ? { isVerification: true, verificationStatus: event.verificationStatus } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(terminationSignal ? { terminationSignal } : {}),
    ...(event.stdoutBytes !== undefined ? { stdoutBytes: event.stdoutBytes } : {}),
    ...(event.stderrBytes !== undefined ? { stderrBytes: event.stderrBytes } : {}),
    ...(event.diff ? { diff: event.diff } : {}),
    ...(event.step !== undefined ? { step: event.step } : {}),
    ...(event.actionType ? { actionType: event.actionType } : {}),
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.approval ? { approval: event.approval } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

import type { ModelResolver, ThreadModelSelection } from "./runtime/modelRegistry.ts";

export interface TrustedVisionPolicy {
  readonly visualPolicy?: VisualPolicy;
  readonly outcomePolicy?: BrowserOutcomePolicy;
  readonly perceptionSelection?: ThreadModelSelection;
}

function resolveSelection(options?: Readonly<Record<string, unknown>>): ThreadModelSelection | undefined {
  const value = options?.modelSelection;
  const validEfforts = ["low", "medium", "high", "extra", "max"] as const;
  const topEffort = typeof options?.reasoningEffort === "string"
    ? options.reasoningEffort
    : typeof options?.effort === "string"
      ? options.effort
      : undefined;

  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const providerConnectionId = typeof v.providerConnectionId === "string" ? v.providerConnectionId : typeof v.providerId === "string" ? v.providerId : undefined;
    const modelId = typeof v.modelId === "string" ? v.modelId : undefined;
    if (providerConnectionId && modelId) {
      const rawEffort = (typeof v.reasoningEffort === "string"
        ? v.reasoningEffort
        : typeof v.effort === "string"
          ? v.effort
          : topEffort)?.toLowerCase();
      const reasoningEffort = rawEffort && (validEfforts as readonly string[]).includes(rawEffort)
        ? (rawEffort as "low" | "medium" | "high" | "extra" | "max")
        : undefined;
      const taskId = typeof v.taskId === "string" ? v.taskId : typeof options?.taskId === "string" ? options.taskId : undefined;
      const workspaceId = typeof v.workspaceId === "string" ? v.workspaceId : typeof options?.workspaceId === "string" ? options.workspaceId : undefined;
      return {
        providerConnectionId,
        modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(taskId ? { taskId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      };
    }
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const providerConnectionId = typeof parsed.providerConnectionId === "string" ? parsed.providerConnectionId : typeof parsed.providerId === "string" ? parsed.providerId : undefined;
      const modelId = typeof parsed.modelId === "string" ? parsed.modelId : undefined;
      if (providerConnectionId && modelId) {
        const rawEffort = (typeof parsed.reasoningEffort === "string"
          ? parsed.reasoningEffort
          : typeof parsed.effort === "string"
            ? parsed.effort
            : topEffort)?.toLowerCase();
        const reasoningEffort = rawEffort && (validEfforts as readonly string[]).includes(rawEffort)
          ? (rawEffort as "low" | "medium" | "high" | "extra" | "max")
          : undefined;
        const taskId = typeof parsed.taskId === "string" ? parsed.taskId : typeof options?.taskId === "string" ? options.taskId : undefined;
        const workspaceId = typeof parsed.workspaceId === "string" ? parsed.workspaceId : typeof options?.workspaceId === "string" ? options.workspaceId : undefined;
        return {
          providerConnectionId,
          modelId,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(taskId ? { taskId } : {}),
          ...(workspaceId ? { workspaceId } : {}),
        };
      }
    } catch { /* malformed selection is rejected by ModelResolver */ }
  }
  return undefined;
}

export function createComposition(options: {
  /** Legacy test-call compatibility only; normal runtime never resolves models from process environment. */
  readonly env?: Record<string, string | undefined>;
  readonly headless?: boolean;
  readonly workspaceRoot?: string;
  readonly modelResolver?: ModelResolver;
  /** Trusted application verifier configuration; never supplied through POST/task options. */
  readonly completion?: TrustedCompletion;
  /** Trusted application configuration only. context.options is untrusted client input;
   * never return policies or selectors copied from it or inferred from goal prose. */
  readonly resolveVisionPolicy?: (context: WorkerExecutionContext) => TrustedVisionPolicy | undefined;
  readonly browserRuntime?: BrowserRuntime;
  readonly permissionEngine?: ToolPermissionEngine;
  readonly durableTaskEngine?: DurableTaskEngine;
  /** Stable product-organization identity loaded from the existing application database. */
  readonly worldIdentity?: World;
  readonly resourceGovernor?: ResourceGovernor;
  readonly crawl4aiRuntime?: Crawl4AiRuntime;
  readonly checkpointDatabasePath?: string;
  readonly checkpointDatabase?: import("@mediobot-v2/maestro").CheckpointDatabase;
  readonly mediobotDefinitionRepository?: import("./storage/mediobotDefinitionRepository.ts").SqliteMediobotDefinitionRepository;
  readonly fileLockManager?: UnifiedFileLockService;
} = {}): CommandCenterComposition {
  const resourceGovernor = options.resourceGovernor ?? new ResourceGovernor({
    budget: {
      maxConcurrentTasks: 8,
      maxConcurrentTasksPerWorkspace: 6,
      maxConcurrentModelRequests: 8,
      maxConcurrentModelRequestsPerProvider: 4,
      maxConcurrentBrowserSessions: 2,
      maxConcurrentBrowserSessionsPerWorkspace: 2,
      maxConcurrentSubprocesses: 8,
      maxConcurrentSubprocessesPerWorkspace: 6,
      memoryPressureThresholdPercent: 85,
    },
  });
  if (options.modelResolver && typeof (options.modelResolver as any).connectAdmissionPort === "function"
    && typeof resourceGovernor.toModelAdmissionPort === "function") {
    options.modelResolver.connectAdmissionPort((resourceGovernor as any).toModelAdmissionPort());
  }
  const crawl4aiRuntime = options.crawl4aiRuntime ?? new Crawl4AiRuntime({
    resourceGovernor,
    subprocessSupervisor: resourceGovernor.subprocessSupervisor,
  });
  const world = createWorld(options.worldIdentity);
  let publishSupervisionNotice: ((notice: SupervisionNotice) => void) | undefined;
  const runtime = new WorkerRuntime(world, { resourceGovernor,
    onSupervision: notice => publishSupervisionNotice?.(notice),
  });
  const submission = new RuntimeTaskSubmission(world, runtime, { resourceGovernor });
  const activeTaskResults = new Map<TaskId, Promise<unknown>>();
  const pauseRequests = new Set<TaskId>();
  const taskControlTails = new Map<string, Promise<void>>();
  const withTaskControlLock = async <T>(taskId: TaskId, operation: () => Promise<T>): Promise<T> => {
    const parentTaskId = world.inspect().tasks.find(task => task.id === taskId)?.parentTaskId ?? taskId;
    const previous = taskControlTails.get(parentTaskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    taskControlTails.set(parentTaskId, tail);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (taskControlTails.get(parentTaskId) === tail) taskControlTails.delete(parentTaskId);
    }
  };
  const configured = Boolean(options.modelResolver);
  const projects = new LocalProjectCatalog(options.workspaceRoot);
  const permissionEngine = options.permissionEngine ?? new ToolPermissionEngine();
  const tools = new ToolRuntime(world, {
    permissionEngine,
    subprocessSupervisor: resourceGovernor.subprocessSupervisor,
    webIntelligence: crawl4aiRuntime,
    invocationJournal: options.durableTaskEngine,
    fileLockManager: options.fileLockManager,
    onWriteCommitted: (target, hash) => {
      globalOwnWriteRegistry.recordWrite(target, hash, "agent");
    },
  });
  const visionPolicies = new WeakMap<WorkerExecutionContext, TrustedVisionPolicy | undefined>();
  const visionPolicy = (context: WorkerExecutionContext) => {
    if (!visionPolicies.has(context)) visionPolicies.set(context, options.resolveVisionPolicy?.(context));
    return visionPolicies.get(context);
  };
  const unavailableClient = { complete: async () => { throw new Error("Text model is not configured"); } };
  const maestroDefinition = parseMediobotDefinition(readFileSync(new URL("../../../mediobots/maestro/MEDIOBOT.md", import.meta.url), "utf8"));
  const skillCatalog = new MarkdownSkillCatalog(fileURLToPath(new URL("../../../mediobots/maestro/skills/", import.meta.url))).listSync();
  const execution = createMaestroCodyExecution({ world, runtime, tools,
    maestroDefinition,
    skillCatalog,
    completion: options.completion,
    crawl4ai: crawl4aiRuntime,
    textModelResolver: options.modelResolver ?? { resolveForOperation() { throw new Error("Text model is not configured"); } },
    codyDecisions: new CodyDecisionProvider(unavailableClient,
      (diagnostic) => process.stderr.write(`${JSON.stringify({ event: "cody.diagnostic", ...diagnostic })}\n`)),
    maestroDecisions: new MaestroDecisionProvider(unavailableClient),
    onUserMessage: (message, identity) => {
      const definitions = world.inspect().definitions;
      const speaker = identity.respondingSpecialistId
        ? definitions.find(definition => definition.id === identity.respondingSpecialistId)
        : definitions.find(definition => definition.role === "Team orchestration");
      const speakerId = speaker?.id ?? "maestro" as MediobotDefinitionId;
      publish({ id: crypto.randomUUID(), type: "maestro.responded", worldId: world.id,
        taskId: identity.taskId, workerId: identity.workerId, workerDefinitionId: speakerId,
        workerName: speaker?.name ?? "Maestro", occurredAt: Date.now(), message });
    },
    onSpecialistMessageEvent: (event) => {
      const state = world.inspect();
      const sender = state.definitions.find(definition => definition.id === event.senderSpecialistId)?.name ?? "Specialist";
      const recipient = state.definitions.find(definition => definition.id === event.recipientSpecialistId)?.name ?? "Specialist";
      const executing = state.workers.find(worker => worker.id === event.workerId);
      const executingDefinition = executing && state.definitions.find(definition => definition.id === executing.definitionId);
      const messageKind = event.messageKind ?? "message";
      publish({ id: crypto.randomUUID(), type: "worker.progress", worldId: world.id, taskId: event.parentTaskId,
        executionTaskId: event.executionTaskId, workerId: event.workerId, workerDefinitionId: executing?.definitionId,
        workerName: executingDefinition?.name, occurredAt: Date.now(),
        ...(event.status === "sent" || event.status === "delivered" ? { activityState: "collaborating" as const } : {}),
        message: event.scope === "group" ? event.status === "delivered"
          ? `${recipient} received shared ${messageKind} from ${sender} (sequence ${event.sequenceNumber}).`
          : `${sender} published shared ${messageKind} (sequence ${event.sequenceNumber}).`
          : event.status === "delivered" ? `${recipient} received a ${messageKind} from ${sender} (sequence ${event.sequenceNumber}).`
          : event.status === "timed_out" ? `${sender} received no reply from ${recipient} before the request timeout.`
          : event.status === "failed" ? `A message from ${sender} to ${recipient} could not be delivered.`
          : event.status === "cancelled" ? `A message from ${sender} to ${recipient} was cancelled.`
          : `${sender} sent a ${messageKind} to ${recipient} (sequence ${event.sequenceNumber}).` });
    },
    onCodyDiagnostic: (diagnostic) => process.stderr.write(`${JSON.stringify({ event: "cody.diagnostic", ...diagnostic })}\n`),
    decisionResolver: options.modelResolver
      ? {
          resolveDecisions(taskOpts) {
            const selection = resolveSelection(taskOpts);
            const effort = selection?.reasoningEffort ?? (typeof taskOpts?.reasoningEffort === "string" ? taskOpts.reasoningEffort.toLowerCase() as any : undefined);
            const { client } = options.modelResolver!.resolveForOperation("dom-reasoning", selection);
            return {
              maestroDecisions: new MaestroDecisionProvider(client, diagnostic =>
                process.stderr.write(`${JSON.stringify({ event: "maestro.decision", ...diagnostic })}\n`),
                effort),
              codyDecisions: new CodyDecisionProvider(client, (diagnostic) =>
                process.stderr.write(`${JSON.stringify({ event: "cody.diagnostic", ...diagnostic })}\n`),
                effort),
              testerDecisions: new TesterDecisionProvider(client, (diagnostic) =>
                process.stderr.write(`${JSON.stringify({ event: "tester.diagnostic", ...diagnostic })}\n`),
                effort),
            };
          },
        }
      : undefined,
    durableTaskEngine: options.durableTaskEngine,
    checkpointDatabasePath: options.checkpointDatabasePath,
    checkpointDatabase: options.checkpointDatabase,
  });
  const vision = world.registerMediobotDefinition({ id: "vision" as MediobotDefinitionId, name: "Vision", role: "visual-browser", version: "0.1.0",
    instructions: "Operate a browser from observed state to pursue the assigned goal.", declaredCapabilities: [] });
  const registry = options.mediobotDefinitionRepository;
  if (registry) {
    for (const stored of registry.listStored()) {
      const persisted = stored.definition;
      const existing = world.inspect().definitions.find(definition => definition.id === persisted.id);
      if (existing) {
        if (existing.lifecycleState !== persisted.lifecycleState) world.setMediobotLifecycleState(existing.id, persisted.lifecycleState);
      } else {
        // Keep legacy identities in the runtime world for durable task attribution
        // and recovery. Stable bootstrap IDs mean these rows no longer multiply on
        // restart; the definition view below folds aliases onto the canonical bot.
        world.registerMediobotDefinition(persisted);
      }
    }
    for (const definition of world.inspect().definitions) registry.register(definition);
  }
  // Durable tasks created before restart retain their original Maestro definition ID.
  // Restore that identity to the same coordinator adapter so approval/checkpoint
  // recovery can resume the existing task instead of failing executable lookup.
  for (const definition of world.inspect().definitions) {
    if (definition.role === "orchestration" && definition.id !== execution.maestroDefinitionId
      && !submission.availability(definition.id).available) {
      submission.registerAdapter(definition.id, execution.adapter);
    }
  }
  submission.registerAdapter(execution.maestroDefinitionId, execution.adapter);
  const browserRuntime = options.browserRuntime ?? new PlaywrightBrowserRuntime({
    headless: options.headless ?? false,
  });
  submission.registerAdapter(vision.id, new VisionExecutionAdapter({ configured,
    browserRuntime,
    decisions: { decide: async () => { throw new Error("Select a connected text model before starting a task."); } },
    resolveDecisions: (taskOptions) => {
      if (!options.modelResolver) throw new Error("Select a connected text model before starting a task.");
      const { client } = options.modelResolver.resolveForOperation("dom-reasoning", resolveSelection(taskOptions));
      return new ModelDecisionProvider(client);
    },
    createPerception: ({ context, browser }) => {
      const config = visionPolicy(context);
      if (!config?.visualPolicy) return undefined;
      if (!options.modelResolver) throw new Error("Select a connected model before requesting perception.");
      const { client } = options.modelResolver.resolveForOperation("image-perception",
        config.perceptionSelection ?? resolveSelection(context.options));
      if (!browser.withViewportCapture) throw new Error("Browser cannot capture a viewport.");
      return { policy: config.visualPolicy, provider: createModelPerceptionProvider(client),
        captures: { withViewportCapture: browser.withViewportCapture.bind(browser) } };
    },
    createGoalVerifier: ({ context, browser }) => {
      const policy = visionPolicy(context)?.outcomePolicy;
      if (!policy) return undefined;
      if (!browser.readOutcome) throw new Error("Browser cannot read outcome state.");
      return createBrowserOutcomeVerifier({ readOutcome: browser.readOutcome.bind(browser) }, policy);
    },
    headless: options.headless ?? false,
    onProgress: (identity, event) => { const product = visionProductEvent(world.id, identity.taskId, identity.workerId, event); if (product) publish(product); },
    onDiagnostic: ({ worldId, taskId, workerId, diagnostic }) => process.stderr.write(`${JSON.stringify({ event: "vision.diagnostic", worldId, taskId, workerId, diagnostic })}\n`),
  }));
  const baseDefinitions: DefinitionView[] = [
    { id: execution.maestroDefinitionId, name: "Maestro", group: "orchestrator", role: "Team orchestration", summary: "Delegate work to specialized Mediobots", availability: configured ? "available" : "not-configured", executable: configured, directConversationAvailable: false },
    { id: execution.codyDefinitionId, name: "Cody", group: "specialist", role: "Software engineering", summary: "Inspect, edit, build, and verify project code when assigned by Maestro", availability: "development", executable: false, directConversationAvailable: true },
    { id: vision.id, name: "Vision", group: "specialist", role: "Browser and visual work", summary: "Structured browser observation and action", availability: configured ? "available" : "not-configured", executable: configured, directConversationAvailable: false },
    ...(execution.scraapyDefinitionId ? [{
      id: execution.scraapyDefinitionId,
      name: "Scraapy",
      group: "specialist" as const,
      role: "scraapy",
      summary: "UI component extraction and open-source asset discovery via web intelligence",
      availability: configured ? "available" as const : "not-configured" as const,
      executable: false,
      directConversationAvailable: true,
    }] : []),
    ...(execution.docDefinitionId ? [{
      id: execution.docDefinitionId,
      name: "Doc",
      group: "specialist" as const,
      role: "doc",
      summary: "Technical documentation retrieval and API guidance via web intelligence",
      availability: configured ? "available" as const : "not-configured" as const,
      executable: false,
      directConversationAvailable: true,
    }] : []),
    ...(["research", "tester"] as const).map((role) => world.inspect().definitions.find((d) => d.role === role)).filter((d): d is NonNullable<typeof d> => Boolean(d)).map((d) => ({
      id: d.id,
      name: d.name,
      group: "specialist" as const,
      role: d.role,
      summary: d.role === "research"
        ? "Investigation and technical analysis with web intelligence and evidence backing"
        : "Critical independent review and verification",
      availability: configured ? "available" as const : "not-configured" as const,
      executable: false,
      directConversationAvailable: execution.webExecution?.definitionIds.includes(d.id) === true
        || d.declaredCapabilities.some(capability => capability.kind === "action" && capability.name === "text-inference"),
    })),
  ];
  const taskEvents = new Map<TaskId, ProductEvent[]>();
  const taskEventWrites = new Map<TaskId, Promise<void>>();
  const subscribers = new Map<TaskId, Set<(event: ProductEvent) => void>>();
  const taskErrors = new Map<TaskId, TaskView["error"]>();
  const appendPublishedEvent = async (rawEvent: ProductEvent) => {
    let event = normalizeProductEvent(rawEvent);
    if (options.durableTaskEngine) {
      const record = await options.durableTaskEngine.appendEvent(event.taskId, "product.event", {
        schemaVersion: 1,
        event,
      });
      await options.durableTaskEngine.trimEvents(event.taskId, "product.event", 200);
      event = { ...event, sequence: record.sequenceNumber };
    }
    const history = taskEvents.get(event.taskId) ?? [];
    history.push(event); if (history.length > 200) history.splice(0, history.length - 200);
    taskEvents.set(event.taskId, history);
    for (const listener of subscribers.get(event.taskId) ?? []) listener(event);
  };
  const publish = (rawEvent: ProductEvent) => {
    const previous = taskEventWrites.get(rawEvent.taskId) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(() => appendPublishedEvent(rawEvent));
    taskEventWrites.set(rawEvent.taskId, write);
    void write.then(() => {
      if (taskEventWrites.get(rawEvent.taskId) === write) taskEventWrites.delete(rawEvent.taskId);
    }, () => {
      if (taskEventWrites.get(rawEvent.taskId) === write) taskEventWrites.delete(rawEvent.taskId);
    });
    void write.catch(() => {
      process.stderr.write(`${JSON.stringify({ event: "product_event.persistence_failed", taskId: rawEvent.taskId, type: rawEvent.type })}\n`);
    });
  };
  publishSupervisionNotice = notice => {
    if (notice.disposition !== "wake" || notice.priority !== "failure" || !notice.event.taskId) return;
    const snapshot = world.inspect();
    let task = snapshot.tasks.find(candidate => candidate.id === notice.event.taskId);
    if (!task) return;
    while (task.parentTaskId) {
      const parent = snapshot.tasks.find(candidate => candidate.id === task!.parentTaskId);
      if (!parent) break;
      task = parent;
    }
    const worker = notice.event.workerId && snapshot.workers.find(candidate => candidate.id === notice.event.workerId);
    const definition = worker && snapshot.definitions.find(candidate => candidate.id === worker.definitionId);
    const category = notice.category;
    if (!category) return;
    const specialist = definition?.name ?? "A worker";
    publish({ id: `supervision-${notice.event.id}`, type: "worker.progress", worldId: world.id,
      taskId: task.id, ...(notice.event.taskId !== task.id ? { executionTaskId: notice.event.taskId } : {}),
      ...(notice.event.workerId ? { workerId: notice.event.workerId } : {}),
      ...(definition ? { workerDefinitionId: definition.id, workerName: definition.name } : {}),
      occurredAt: notice.event.occurredAt, failureCategory: category,
      message: `Execution supervision recorded a ${category} failure for ${specialist}; Maestro will review the preserved task outcomes.` });
  };
  const flushTaskEvents = async (taskId?: TaskId) => {
    const writes = taskId ? [taskEventWrites.get(taskId)].filter((item): item is Promise<void> => Boolean(item))
      : [...taskEventWrites.values()];
    await Promise.all(writes.map(write => write.catch(() => {})));
  };
  const getTaskEvents = async (taskId: TaskId): Promise<ReadonlyArray<ProductEvent>> => {
    const taskRecord = await options.durableTaskEngine?.getTask(taskId).catch(() => null);
    const parentTaskId = taskRecord ? await options.durableTaskEngine?.findParentTaskForChild(taskId, taskRecord.workspaceId) : null;
    const eventOwnerTaskId = (parentTaskId ?? taskId) as TaskId;
    await flushTaskEvents(eventOwnerTaskId);
    if (!options.durableTaskEngine) return [...(taskEvents.get(taskId) ?? [])];
    const records = await options.durableTaskEngine.getEvents(eventOwnerTaskId);
    const persisted: ProductEvent[] = [];
    for (const record of records) {
      if (record.eventType !== "product.event" || record.payload.schemaVersion !== 1) continue;
      const raw = record.payload.event;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const candidate = raw as ProductEvent;
      if ((parentTaskId ? candidate.executionTaskId !== taskId : candidate.taskId !== taskId)
        || typeof candidate.id !== "string" || !JOURNALED_PRODUCT_EVENT_TYPES.has(candidate.type)) continue;
      persisted.push({ ...normalizeProductEvent(candidate), sequence: record.sequenceNumber });
    }
    return persisted.slice(-200);
  };
  permissionEngine.setNotifiers({
    onApprovalRequested: async (request) => {
      let workerDefinitionId = request.workerId
        ? world.inspect().workers.find((worker) => worker.id === request.workerId)?.definitionId
        : undefined;
      if (options.durableTaskEngine && request.taskId) {
        await options.durableTaskEngine.pauseForApproval(request.taskId, {
          approvalId: request.approvalId, tool: request.toolName, description: request.sanitizedDescription,
        }).catch(() => {});
        const executionTask = await options.durableTaskEngine.getTask(request.taskId).catch(() => null);
        workerDefinitionId ??= executionTask?.definitionId as MediobotDefinitionId | undefined;
        const parentTaskId = request.parentTaskId ?? executionTask?.parentTaskId;
        if (parentTaskId && parentTaskId !== request.taskId) {
          await options.durableTaskEngine.pauseForApproval(parentTaskId, {
            approvalId: request.approvalId, childTaskId: request.taskId,
          }).catch(() => {});
        }
      }
      publish({
        id: crypto.randomUUID(),
        type: "approval.required",
        worldId: world.id,
        taskId: request.parentTaskId ?? request.taskId!,
        ...(request.parentTaskId && request.taskId !== request.parentTaskId ? { executionTaskId: request.taskId } : {}),
        workerId: request.workerId,
        ...(workerDefinitionId ? { workerDefinitionId } : {}),
        workerName: request.mediobotName,
        occurredAt: request.createdAt,
        approval: {
          approvalId: request.approvalId,
          title: `${request.mediobotName ?? "Mediobot"} requests permission`,
          description: request.sanitizedDescription,
          risk: request.risk,
          status: "pending",
          mediobotName: request.mediobotName,
          workspace: request.targetWorkspace,
          actionPayload: {
            type: request.toolName === "terminal.execute" ? "terminal_command" : "file_write",
            detail: request.sanitizedDescription,
          },
        },
      });
    },
    onApprovalResolved: (request, context) => {
      const workerDefinitionId = request.workerId
        ? world.inspect().workers.find((worker) => worker.id === request.workerId)?.definitionId
        : undefined;
      if (options.durableTaskEngine && context.activeWaiter && request.taskId) {
        void (async () => {
          await options.durableTaskEngine!.resumeFromApproval(request.taskId!).catch(() => {});
          const executionTask = await options.durableTaskEngine!.getTask(request.taskId!).catch(() => null);
          const parentTaskId = request.parentTaskId ?? executionTask?.parentTaskId;
          if (parentTaskId && parentTaskId !== request.taskId) {
            await options.durableTaskEngine!.resumeFromApproval(parentTaskId).catch(() => {});
          }
        })();
      }
      publish({
        id: crypto.randomUUID(),
        type: "approval.resolved",
        worldId: world.id,
        taskId: request.parentTaskId ?? request.taskId!,
        ...(request.parentTaskId && request.taskId !== request.parentTaskId ? { executionTaskId: request.taskId } : {}),
        workerId: request.workerId,
        ...(workerDefinitionId ? { workerDefinitionId } : {}),
        workerName: request.mediobotName,
        occurredAt: request.resolvedAt ?? Date.now(),
        approval: {
          approvalId: request.approvalId,
          title: `${request.mediobotName ?? "Mediobot"} requests permission`,
          description: request.sanitizedDescription,
          risk: request.risk,
          status: request.status === "approved" ? "approved" : "rejected",
          mediobotName: request.mediobotName,
          workspace: request.targetWorkspace,
          actionPayload: {
            type: request.toolName === "terminal.execute" ? "terminal_command" : "file_write",
            detail: request.sanitizedDescription,
          },
        },
      });
    },
  });
  const snapshotTask = (taskId: TaskId): TaskView | undefined => {
    const snapshot = world.inspect(); const task = snapshot.tasks.find((item) => item.id === taskId);
    if (!task) return undefined;
    const descendants = snapshot.tasks.filter((item) => item.parentTaskId === taskId);
    const related = [task, ...descendants];
    const workers = related.flatMap((item) => {
      const worker = item.assignedWorkerId && snapshot.workers.find((entry) => entry.id === item.assignedWorkerId);
      const definition = worker && snapshot.definitions.find((entry) => entry.id === worker.definitionId);
      return worker && definition ? [{ id: worker.id, taskId: item.id, definitionId: worker.definitionId, name: definition.name, state: item.state }] : [];
    });
    const assignedWorker = task.assignedWorkerId && snapshot.workers.find((entry) => entry.id === task.assignedWorkerId);
    const assignedDefinition = assignedWorker && snapshot.definitions.find((entry) => entry.id === assignedWorker.definitionId);
    const evidence = snapshot.evidence.filter(entry => related.some(item => item.id === entry.taskId));
    return { id: task.id, worldId: task.worldId, goal: task.goal, state: task.state, workers,
      ...(assignedDefinition ? { assignedMediobot: { id: assignedDefinition.id, name: assignedDefinition.name } } : {}),
      events: [...(taskEvents.get(taskId) ?? [])], evidence,
      ...(taskErrors.get(taskId) ? { error: taskErrors.get(taskId) } : {}) };
  };
  const getTaskView = async (taskId: TaskId): Promise<TaskView | undefined> => {
    const durableEngine = options.durableTaskEngine;
    const liveView = snapshotTask(taskId);
    const durableTask = liveView ? undefined : await durableEngine?.getTask(taskId);
    if (!liveView && !durableTask) return undefined;
    const delegations = durableEngine ? await durableEngine.getDelegations(taskId) : undefined;
    const relatedTaskIds = [taskId, ...(delegations ?? []).flatMap(delegation => delegation.childTaskId ? [delegation.childTaskId] : [])];
    const [checkpointGroups, evidenceGroups, artifactGroups] = durableEngine
      ? await Promise.all([
        Promise.all(relatedTaskIds.map(id => durableEngine.getCheckpoints(id))),
        Promise.all(relatedTaskIds.map(id => durableEngine.getEvidence(id))),
        Promise.all(relatedTaskIds.map(id => durableEngine.getArtifacts(id))),
      ])
      : [undefined, undefined, undefined];
    const checkpoints = checkpointGroups?.flat();
    const evidence = evidenceGroups?.flat();
    const artifacts = artifactGroups?.flat();
    if (liveView) return { ...liveView,
      ...(checkpoints ? { checkpoints } : {}), ...(delegations ? { delegations } : {}), ...(evidence ? { evidence } : {}),
      ...(artifacts ? { artifacts } : {}) };
    const assignedDefinition = world.inspect().definitions.find(definition => definition.id === durableTask!.definitionId);
    return {
      id: durableTask!.id as TaskId,
      worldId: world.id,
      goal: durableTask!.goal,
      state: durableTask!.status,
      ...(assignedDefinition ? { assignedMediobot: { id: assignedDefinition.id, name: assignedDefinition.name } } : {}),
      workers: [],
      events: durableEngine ? await getTaskEvents(taskId) : [],
      ...(checkpoints ? { checkpoints } : {}),
      ...(delegations ? { delegations } : {}),
      ...(evidence ? { evidence } : {}),
      ...(artifacts ? { artifacts } : {}),
      ...(durableTask!.error ? { error: { code: "execution-failed" as const, message: durableTask!.error.message } } : {}),
    };
  };
  const publishWorldEvent = (event: import("@mediobot-v2/domain").WorldEvent) => {
    const state = world.inspect();
    const product = worldProductEvent(event, state.definitions, state.workers, state.tasks);
    if (product) publish(product);
    if (event.type === "task.completed" && event.taskId) {
      void options.durableTaskEngine?.completeTask(event.taskId).catch(() => {});
    } else if (event.type === "task.failed" && event.taskId) {
      const errMsg = (event as any).error ? String((event as any).error) : "Task execution failed";
      void options.durableTaskEngine?.failTask(event.taskId, { code: "execution-failed", message: errMsg }).catch(() => {});
    } else if (event.type === "task.cancelled" && event.taskId) {
      void options.durableTaskEngine?.cancelTask(event.taskId).catch(() => {});
    }
    if ((event.type !== "task.completed" && event.type !== "task.failed") || !event.taskId) return;
    const task = state.tasks.find((entry) => entry.id === event.taskId);
    const worker = event.workerId && state.workers.find((entry) => entry.id === event.workerId);
    const definition = worker && state.definitions.find((entry) => entry.id === worker.definitionId);
    if (!task?.parentTaskId || !worker || !definition) return;
    for (const evidence of state.evidence.filter((entry) => entry.taskId === task.id && entry.workerId === worker.id && entry.source.type === "workspace-diff")) {
      try {
        const value = JSON.parse(evidence.content) as Record<string, unknown>;
        const filePath = evidence.source.reference;
        if (typeof value.filePath !== "string" || value.filePath !== filePath || value.filePath.startsWith("/")
          || filePath.split(/[\\/]+/).includes("..") || filePath.split(/[\\/]+/).some((part) => /^\.env(?:\.|$)/i.test(part))
          || !Number.isInteger(value.additions) || !Number.isInteger(value.deletions) || !Array.isArray(value.hunks)) continue;
        const diff: FileDiff = { filePath, additions: value.additions as number, deletions: value.deletions as number,
          ...(value.truncated === true ? { truncated: true } : {}), hunks: value.hunks as FileDiff["hunks"] };
        publish({ id: crypto.randomUUID(), type: "file.changed", worldId: event.worldId, taskId: task.parentTaskId,
          executionTaskId: task.id, workerId: worker.id, workerDefinitionId: worker.definitionId, workerName: definition.name,
          occurredAt: event.occurredAt, diff });
      } catch { /* Malformed tool evidence is omitted from product events. */ }
    }
  };
  const definitionView = (definition: import("@mediobot-v2/domain").MediobotDefinition): DefinitionView => ({
    id: definition.id, name: definition.name,
    group: "specialist",
    role: definition.role,
    summary: definition.instructions.slice(0, 240),
    availability: definition.lifecycleState === "active" ? configured ? "available" : "not-configured" : "unavailable",
    directConversationAvailable: definition.lifecycleState === "active" && (definition.id === execution.codyDefinitionId
      || execution.webExecution?.definitionIds.includes(definition.id) === true
      || definition.declaredCapabilities.some(capability => capability.kind === "action" && capability.name === "text-inference")),
    // These definitions execute only as Maestro's delegated text-worker path, not /api/tasks direct workers.
    executable: false,
  });
  return { world, submission,
    get definitions() {
      const configuredTextModel = options.modelResolver?.hasEnabledTextModel() ?? false;
      const availability: DefinitionView["availability"] = configuredTextModel ? "available" : "not-configured";
      const standard = new Map(baseDefinitions.map(definition => [definition.id, definition]));
      const seenNames = new Set<string>();
      return world.inspect().definitions.flatMap((definition) => {
        if (registry?.isRemoved(definition.id)) return [];
        const nameKey = definition.name.trim().toLowerCase();
        if (seenNames.has(nameKey)) return [];
        seenNames.add(nameKey);
        const known = standard.get(definition.id);
        if (known) {
          const currentAvailability: DefinitionView["availability"] = definition.lifecycleState !== "active" ? "unavailable"
            : known.availability === "development" ? "development" : availability;
          return [{ ...known,
          availability: currentAvailability,
          directConversationAvailable: definition.lifecycleState === "active" && known.directConversationAvailable === true,
          executable: definition.lifecycleState === "active" && (definition.id === execution.maestroDefinitionId || definition.id === vision.id) && configuredTextModel }];
        }
        return [definitionView(definition)];
      });
    },
    registerSpecialist(input) {
      if (!input.name.trim() || input.name.length > 80 || !input.role.trim() || input.role.length > 120
        || !input.version.trim() || input.version.length > 40 || !input.instructions.trim() || input.instructions.length > 8000) {
        throw new Error("Invalid Mediobot registration fields");
      }
      if (["orchestration", "team orchestration"].includes(input.role.trim().toLowerCase())) {
        throw new Error("Custom specialists cannot claim the coordinator role");
      }
      const requestedCapabilities = input.capabilities ?? ["text-inference"];
      const supportedCapabilities = new Set(["text-inference", "web.search", "web.crawl"]);
      if (!Array.isArray(requestedCapabilities) || requestedCapabilities.length > supportedCapabilities.size
        || requestedCapabilities.some(capability => typeof capability !== "string" || !supportedCapabilities.has(capability))) {
        throw new Error("Unsupported specialist capability; supported capabilities are text-inference, web.search, and web.crawl");
      }
      const uniqueCapabilities = [...new Set(requestedCapabilities)];
      if (uniqueCapabilities.includes("web.search") !== uniqueCapabilities.includes("web.crawl")) {
        throw new Error("Web specialists must declare both web.search and web.crawl");
      }
      if (uniqueCapabilities.length === 0) throw new Error("At least one supported specialist capability is required");
      if (uniqueCapabilities.some(capability => capability.startsWith("web.")) && !uniqueCapabilities.includes("text-inference")) {
        uniqueCapabilities.push("text-inference");
      }
      const duplicate = world.inspect().definitions.some(definition => definition.name.toLowerCase() === input.name.trim().toLowerCase());
      if (duplicate) throw new Error("A Mediobot with this name is already registered");
      const candidate = { ...input, id: `definition-${crypto.randomUUID()}` as MediobotDefinitionId,
        name: input.name.trim(), role: input.role.trim(),
        version: input.version.trim(), instructions: input.instructions.trim(),
        declaredCapabilities: uniqueCapabilities.map(name => ({ kind: "action" as const, name,
          description: name === "text-inference" ? "Bounded analysis over supplied context"
            : name === "web.search" ? "Search the web for relevant sources" : "Crawl and extract content from selected web sources" })),
        lifecycleState: "active" as const };
      const persisted = registry?.register(candidate, true);
      const definition = world.registerMediobotDefinition(persisted ?? candidate);
      return definitionView(definition);
    },
    setSpecialistLifecycle(definitionId, state) {
      if (definitionId === execution.maestroDefinitionId) throw new Error("Maestro's lifecycle cannot be changed");
      if (registry?.isRemoved(definitionId)) throw new Error("A removed Mediobot identity cannot be reactivated");
      const previous = world.inspect().definitions.find(definition => definition.id === definitionId);
      if (!previous) throw new Error("Mediobot definition does not exist in this world");
      const definition = world.setMediobotLifecycleState(definitionId, state);
      try { registry?.saveLifecycle(definitionId, state); }
      catch (error) {
        world.setMediobotLifecycleState(definitionId, previous.lifecycleState);
        throw error;
      }
      return definitionView(definition);
    },
    removeSpecialist(definitionId) {
      if (definitionId === execution.maestroDefinitionId) throw new Error("Maestro cannot be removed");
      if (!registry) throw new Error("Durable Mediobot registry is unavailable");
      const previous = world.inspect().definitions.find(definition => definition.id === definitionId);
      if (!previous) throw new Error("Mediobot definition does not exist in this world");
      // Domain validation prevents removal while work is active. Persist the tombstone
      // only after validation, then roll back runtime state if SQLite rejects it.
      world.setMediobotLifecycleState(definitionId, "disabled");
      try { registry.remove(definitionId); }
      catch (error) {
        world.setMediobotLifecycleState(definitionId, previous.lifecycleState);
        throw error;
      }
    },
    visionDefinitionId: vision.id, maestroDefinitionId: execution.maestroDefinitionId,
    codyDefinitionId: execution.codyDefinitionId, projects, taskEvents, subscribers, taskErrors, publish, getTaskEvents, flushTaskEvents, snapshotTask, getTaskView,
    decideMaestroTurn: (goal, turnOptions, signal) => execution.adapter.decideTurn(world, execution.maestroDefinitionId, goal, turnOptions, signal),
    submit(
      definitionId: MediobotDefinitionId,
      goal: string,
      submitOptions?: Readonly<Record<string, unknown>>,
      onBeforeEmit?: (taskId: TaskId) => void
    ) {
      const activeEngine = (submitOptions?.durableTaskEngine as DurableTaskEngine | undefined) ?? options.durableTaskEngine;
      const availability = submission.availability(definitionId);
      if (!availability.available) throw new TaskSubmissionError("reason" in availability && availability.reason === "not-configured" ? "not-configured" : "not-executable");
      let created = false;
      let pauseTaskId = (submitOptions?.taskId as TaskId | undefined) ?? "" as TaskId;
      const bindContext = (taskId: TaskId) => {
        pauseTaskId = taskId;
        const def = world.inspect().definitions.find((d) => d.id === definitionId);
        permissionEngine.bindTaskContext(taskId, {
          threadId: typeof submitOptions?.threadId === "string" ? submitOptions.threadId : undefined,
          turnId: typeof submitOptions?.turnId === "string" ? submitOptions.turnId : undefined,
          workspaceId: typeof submitOptions?.workspaceId === "string" ? submitOptions.workspaceId : undefined,
          mediobotName: def?.name,
          policy: typeof submitOptions?.approvalMode === "string" ? { mode: submitOptions.approvalMode as any } : undefined,
        });
      };
      const submitted = submission.submit({
        definitionId,
        goal,
        taskId: submitOptions?.taskId as TaskId | undefined,
        options: {
          ...submitOptions,
          // This trusted callback is always composed by the host and overwrites
          // any untrusted task option with the same name.
          shouldPauseTask: () => pauseRequests.has(pauseTaskId),
          ...(activeEngine ? { durableTaskEngine: activeEngine } : {}),
        },
        onCreated: async ({ task }) => {
          created = true;
          bindContext(task.id);
          // Subscribe before durable startup: startTask() can emit lifecycle events
          // before its worker adapter yields, and callers can receive 202 meanwhile.
          if (onBeforeEmit) onBeforeEmit(task.id);
          try {
            if (activeEngine) {
              const selection = resolveSelection(submitOptions);
              const inferenceSnapshot = options.modelResolver?.createInferenceSnapshot?.(selection);
              const executionScope = submitOptions?.executionScope as ExecutionScope | undefined;
              await activeEngine.submitTask({
                id: task.id,
                goal,
                definitionId,
                workspaceId: executionScope?.workspaceId ?? (typeof submitOptions?.workspaceId === "string" ? submitOptions.workspaceId : null),
                threadId: executionScope?.threadId ?? (typeof submitOptions?.threadId === "string" ? submitOptions.threadId : undefined),
                turnId: executionScope?.turnId ?? (typeof submitOptions?.turnId === "string" ? submitOptions.turnId : undefined),
                ...(executionScope ? { executionScope } : {}),
                modelSelection: selection,
                ...(inferenceSnapshot ? { inferenceSnapshot } : {}),
                idempotencyKey: typeof submitOptions?.idempotencyKey === "string" ? submitOptions.idempotencyKey : undefined,
              });
              await activeEngine.startTask(task.id);
            }
          } finally {
            // Publish creation after binding so buffered task streams can replay it.
            publish({ id: crypto.randomUUID(), type: "task.created", worldId: task.worldId, taskId: task.id, occurredAt: Date.now() });
          }
        },
        onEvent: publishWorldEvent,
      });
      const result = submitted.result.then(async outcome => {
        pauseRequests.delete(submitted.task.id);
        await flushTaskEvents(submitted.task.id);
        return outcome;
      }, async error => {
        const pauseInterrupts = error instanceof LangGraphInterruptedError
          ? error.interrupts.filter(interrupt => interrupt.value && typeof interrupt.value === "object"
            && !Array.isArray(interrupt.value) && (interrupt.value as Record<string, unknown>).kind === "user-pause")
          : [];
        if (!activeEngine || pauseInterrupts.length === 0) {
          pauseRequests.delete(submitted.task.id);
          throw error;
        }
        const interruptIds = pauseInterrupts.map(interrupt => interrupt.id);
        const delegations = await activeEngine.getDelegations(submitted.task.id);
        const familyIds: TaskId[] = [submitted.task.id, ...delegations.flatMap(delegation => delegation.childTaskId ? [delegation.childTaskId as TaskId] : [])];
        for (const id of familyIds) {
          const durable = await activeEngine.getTask(id);
          if (durable?.status === "running") await activeEngine.pauseForUser(id, { interruptIds });
          const task = world.inspect().tasks.find(item => item.id === id);
          if (task && (task.state === "running" || task.state === "assigned")) world.setTaskState(id, "paused");
        }
        pauseRequests.delete(submitted.task.id);
        publish({ id: crypto.randomUUID(), type: "task.paused", worldId: world.id, taskId: submitted.task.id,
          message: "Task paused at a checkpoint. Completed work is preserved.", occurredAt: Date.now() });
        await flushTaskEvents(submitted.task.id);
        return { state: "paused" as const };
      });
      activeTaskResults.set(submitted.task.id, result);
      void result.finally(() => activeTaskResults.delete(submitted.task.id)).catch(() => {});
      if (!created && onBeforeEmit) {
        bindContext(submitted.task.id);
        if (activeEngine) {
          const selection = resolveSelection(submitOptions);
          const inferenceSnapshot = options.modelResolver?.createInferenceSnapshot?.(selection);
          void activeEngine.submitTask({
            id: submitted.task.id,
            goal,
            definitionId,
            workspaceId: typeof submitOptions?.workspaceId === "string" ? submitOptions.workspaceId : null,
            threadId: typeof submitOptions?.threadId === "string" ? submitOptions.threadId : undefined,
            turnId: typeof submitOptions?.turnId === "string" ? submitOptions.turnId : undefined,
            modelSelection: selection,
            ...(inferenceSnapshot ? { inferenceSnapshot } : {}),
            idempotencyKey: typeof submitOptions?.idempotencyKey === "string" ? submitOptions.idempotencyKey : undefined,
          }).then(() => activeEngine.startTask(submitted.task.id)).catch(() => {});
        }
        onBeforeEmit(submitted.task.id);
      }
      if (!created) {
        bindContext(submitted.task.id);
        publish({ id: crypto.randomUUID(), type: "task.created", worldId: submitted.task.worldId, taskId: submitted.task.id, occurredAt: Date.now() });
      }
      void result.then((outcome) => {
        if (outcome.state === "failed") {
          const rawMessage = "error" in outcome ? outcome.error : undefined;
          taskErrors.set(submitted.task.id, { code: "execution-failed", message: categorizeFailure(rawMessage) });
        }
      });
      return { taskId: submitted.task.id, result };
    },
    async resume(
      taskId: TaskId,
      resumeOptions?: Readonly<Record<string, unknown>>
    ) {
      const activeEngine = options.durableTaskEngine;
      if (!activeEngine) throw new Error("Durable task engine is not configured");
      const durable = await activeEngine.getTask(taskId);
      if (!durable) throw new Error(`Task "${taskId}" not found`);
      const requestedWorkspaceId = typeof resumeOptions?.workspaceId === "string"
        ? resumeOptions.workspaceId : null;
      if (requestedWorkspaceId !== durable.workspaceId) {
        throw new Error("Cannot resume a task from a different workspace scope.");
      }
      if (durable.status !== "interrupted" && durable.status !== "queued" && durable.status !== "paused" && durable.status !== "waiting_approval" && durable.status !== "running") {
        throw new Error(`Cannot resume task "${taskId}" from status "${durable.status}"`);
      }
      const delegations = await activeEngine.getDelegations(taskId);
      const latestDelegation = delegations.length > 0 ? delegations[delegations.length - 1] : undefined;
      const childTaskId = latestDelegation?.childTaskId ?? undefined;
      const resumableDelegations = [...new Map(delegations.filter(entry => entry.childTaskId)
        .map(entry => [entry.childTaskId!, entry])).values()];
      const resumedApproval = resumeOptions && typeof resumeOptions.resumeValues === "object";
      const checkpoints = await activeEngine.getCheckpoints(taskId);
      const savedPlan = [...checkpoints].reverse()
        .find(checkpoint => checkpoint.snapshot.kind === "maestro-assignment-plan-v1");
      const savedDecision = savedPlan?.snapshot.decision && typeof savedPlan.snapshot.decision === "object"
        ? savedPlan.snapshot.decision : undefined;
      const resumedDecision = savedDecision
        ? savedDecision
        : resumedApproval && resumableDelegations.length === 1
        ? {
            type: "delegate_text",
            independence: "Resume the previously authorized durable specialist assignment without asking a model to replace its identity or objective.",
            assignments: [{
              assignmentId: "assignment-1",
              definitionId: resumableDelegations[0]!.assignedMediobotId,
              objective: resumableDelegations[0]!.objective,
              relevantContext: "Resume the exact persisted specialist assignment and its LangGraph checkpoint.",
              relevantContextRefs: [],
              constraints: [],
              expectedOutcome: resumableDelegations[0]!.objective,
              evidenceExpectations: [],
              ...(resumableDelegations[0]!.assignedMediobotId === this.codyDefinitionId
                ? { requiredCapabilities: ["filesystem.read", "filesystem.write", "terminal.execute"] } : {}),
            }],
          }
        : undefined;
      if ((durable.status === "interrupted" || durable.status === "paused" || durable.status === "waiting_approval")
        && delegations.length > 0 && !savedDecision && !resumedApproval) {
        throw new Error("Cannot safely resume interrupted delegated work because its validated Maestro assignment plan was not persisted.");
      }
      if (resumedApproval && (resumableDelegations.length > 1 || delegations.length > 1) && !savedDecision) {
        throw new Error("Cannot safely resume this approval because the original multi-specialist assignment plan was not persisted.");
      }

      const registeredDefs = world.inspect().definitions;
      const targetDefId = registeredDefs.find((d) => d.id === durable.definitionId)?.id
        ?? this.maestroDefinitionId;
      const taskModelSelection = resolveSelection(resumeOptions) ?? await activeEngine.getTaskModelSelection(taskId);
      if (targetDefId === this.maestroDefinitionId) {
        if (!options.modelResolver || !taskModelSelection || !options.modelResolver.hasEnabledTextModel()) {
          throw new TaskSubmissionError("not-configured");
        }
        try { options.modelResolver.resolveForOperation("dom-reasoning", taskModelSelection); }
        catch { throw new TaskSubmissionError("not-configured"); }
      }
      const availability = submission.availability(targetDefId);
      if (!availability.available) throw new TaskSubmissionError("reason" in availability && availability.reason === "not-configured"
        ? "not-configured" : "not-executable");

      // Validate recovery metadata before transitioning the durable task back to running.
      // Maestro revalidates the saved decision against current capabilities before dispatch.
      if (durable.status === "waiting_approval") await activeEngine.resumeFromApproval(taskId);
      else if (durable.status === "paused") {
        await activeEngine.resumeFromUserPause(taskId);
        publish({ id: crypto.randomUUID(), type: "task.resumed", worldId: world.id, taskId,
          message: "Task resumed from its saved checkpoint.", occurredAt: Date.now() });
      }
      else if (durable.status !== "running") await activeEngine.startTask(taskId);

      const pauseStateEvent = durable.status === "paused"
        ? [...await activeEngine.getEvents(taskId)].reverse().find(event => event.eventType === "task.state_changed"
          && event.payload.toState === "paused") : undefined;
      const pauseDetails = pauseStateEvent?.payload.details && typeof pauseStateEvent.payload.details === "object"
        ? pauseStateEvent.payload.details as Record<string, unknown> : undefined;
      const pauseInterruptIds = Array.isArray(pauseDetails?.interruptIds)
        ? pauseDetails.interruptIds.filter((id): id is string => typeof id === "string" && id.length <= 300) : [];
      const resumeValues = resumeOptions?.resumeValues && typeof resumeOptions.resumeValues === "object"
        ? resumeOptions.resumeValues as Record<string, unknown>
        : pauseInterruptIds.length ? Object.fromEntries(pauseInterruptIds.map(id => [id, { resumed: true }])) : undefined;

      const subOptions: Record<string, unknown> = {
        ...resumeOptions,
        ...(resumeValues ? { resumeValues } : {}),
        ...(resumedDecision ? { maestroDecision: resumedDecision } : {}),
        taskId,
        resumeTaskId: taskId,
        resumeChildTaskId: childTaskId,
        durableTaskEngine: activeEngine,
        workspaceId: durable.workspaceId,
        modelSelection: taskModelSelection,
      };

      return this.submit(
        targetDefId,
        durable.goal,
        subOptions
      );
    },
    withTaskControlLock,
    isTaskActive: (taskId) => runtime.activeTaskIds().includes(taskId),
    async pause(taskId) {
      return withTaskControlLock(taskId, async () => {
        const engine = options.durableTaskEngine;
        const durable = await engine?.getTask(taskId);
        if (!engine || !durable || durable.status !== "running" || !runtime.activeTaskIds().includes(taskId)) {
          throw new Error("Task is not actively running and cannot be paused.");
        }
        pauseRequests.add(taskId);
        publish({ id: crypto.randomUUID(), type: "task.pause_requested", worldId: world.id, taskId,
          message: "Pause requested; active model and tool operations will settle at a safe checkpoint.", occurredAt: Date.now() });
      });
    },
    async cancel(taskId) {
      return withTaskControlLock(taskId, async () => {
      // Ask the execution owner to accept cancellation before changing any
      // approval records. LangGraph interrupts are already suspended and are
      // not active WorkerRuntime runs; in that case submission.cancel throws,
      // so cancel the durable approval workflow as one bounded task group.
      try {
        submission.cancel(taskId);
        permissionEngine.cancelPending((req) => req.taskId === taskId);
        return;
      } catch (activeCancellationError) {
        const engine = options.durableTaskEngine;
        let worldState = world.inspect();
        const requestedTask = worldState.tasks.find(task => task.id === taskId);
        const rootTaskId = requestedTask?.parentTaskId ?? taskId;
        if (pauseRequests.has(rootTaskId)) {
          // The worker may have just unwound into a persisted LangGraph pause;
          // wait for that bounded state transition before classifying cancellation.
          await activeTaskResults.get(rootTaskId)?.catch(() => undefined);
          worldState = world.inspect();
        }
        const root = await engine?.getTask(rootTaskId);
        const rootWorldTask = worldState.tasks.find(task => task.id === rootTaskId);
        if (engine && (root?.status === "interrupted" || root?.status === "paused")) {
          const delegations = await engine.getDelegations(rootTaskId);
          const familyIds = [rootTaskId, ...delegations.flatMap(delegation => delegation.childTaskId ? [delegation.childTaskId] : [])];
          if (runtime.activeTaskIds().some(activeId => familyIds.includes(activeId))) throw activeCancellationError;
          const family = await Promise.all(familyIds.map(async id => ({ id, durable: await engine.getTask(id) })));
          const interruptedFamily = family.filter(({ durable }) => durable?.status === "interrupted" || durable?.status === "paused");
          const worldFamily = world.inspect().tasks;
          if (!interruptedFamily.some(({ id }) => id === rootTaskId)
            || interruptedFamily.length !== family.filter(({ durable }) => durable
              && ["queued", "running", "waiting_approval", "interrupted", "paused"].includes(durable.status)).length
            || interruptedFamily.some(({ id }) => {
              const task = worldFamily.find(candidate => candidate.id === id);
              return task && !["running", "waiting_approval", "paused"].includes(task.state);
            })) throw activeCancellationError;
          const cancellationOrder = [...interruptedFamily.filter(({ id }) => id !== rootTaskId), ...interruptedFamily.filter(({ id }) => id === rootTaskId)];
          for (const { id } of cancellationOrder) await engine.cancelTask(id, root.status === "paused" ? "user_cancelled_while_paused" : "user_cancelled_after_interruption");
          permissionEngine.cancelPending(approval => familyIds.includes(approval.taskId));
          for (const { id } of cancellationOrder) {
            const task = world.inspect().tasks.find(candidate => candidate.id === id);
            if (task && !["completed", "failed", "cancelled"].includes(task.state)) world.setTaskState(id as TaskId, "cancelled");
            const durable = family.find(candidate => candidate.id === id)?.durable;
            const definition = durable && world.inspect().definitions.find(candidate => candidate.id === durable.definitionId);
            publish({ id: crypto.randomUUID(), type: "task.cancelled", worldId: world.id, taskId: id as TaskId,
              ...(definition ? { workerDefinitionId: definition.id, workerName: definition.name } : {}), occurredAt: Date.now() });
          }
          await flushTaskEvents(rootTaskId as TaskId);
          return;
        }
        if (!engine || root?.status !== "waiting_approval"
          || !["running", "waiting_approval"].includes(rootWorldTask?.state ?? "")) {
          throw activeCancellationError;
        }

        const delegations = await engine.getDelegations(rootTaskId);
        const familyIds = [rootTaskId, ...delegations.flatMap(delegation => delegation.childTaskId ? [delegation.childTaskId] : [])];
        if (runtime.activeTaskIds().some(activeId => familyIds.includes(activeId))) throw activeCancellationError;
        const family = await Promise.all(familyIds.map(async id => ({ id, durable: await engine.getTask(id) })));
        const pendingApprovals = permissionEngine.getPendingApprovals().filter(approval => familyIds.includes(approval.taskId));
        const activeFamily = family.filter(({ durable }) => durable && ["queued", "running", "waiting_approval"].includes(durable.status));
        const worldFamily = world.inspect().tasks;
        if (!pendingApprovals.length || !activeFamily.some(({ id }) => id === rootTaskId)
          || activeFamily.some(({ id, durable }) => durable?.status !== "waiting_approval"
            || !["running", "waiting_approval"].includes(worldFamily.find(task => task.id === id)?.state ?? ""))) throw activeCancellationError;
        const cancellationOrder = [...activeFamily.filter(({ id }) => id !== rootTaskId), ...activeFamily.filter(({ id }) => id === rootTaskId)];

        // All family runs are suspended (not merely slow). Persist every
        // terminal task state before publishing the root terminal event; keep
        // already-completed sibling outcomes untouched.
        for (const { id } of cancellationOrder) await engine.cancelTask(id, "user_cancelled_while_waiting_for_approval");
        permissionEngine.cancelPending(approval => familyIds.includes(approval.taskId));
        for (const { id } of cancellationOrder) {
          const task = world.inspect().tasks.find(candidate => candidate.id === id);
          if (task && !["completed", "failed", "cancelled"].includes(task.state)) world.setTaskState(id as TaskId, "cancelled");
        }
        for (const { id } of cancellationOrder) {
          if (id === rootTaskId) continue;
          const worker = world.inspect().tasks.find(candidate => candidate.id === id)?.assignedWorkerId;
          runtime.appendEvent({ type: "task.cancelled", taskId: id as TaskId, ...(worker ? { workerId: worker } : {}) }, publishWorldEvent);
        }
        const worker = world.inspect().tasks.find(candidate => candidate.id === rootTaskId)?.assignedWorkerId;
        runtime.appendEvent({ type: "task.cancelled", taskId: rootTaskId as TaskId, ...(worker ? { workerId: worker } : {}) }, publishWorldEvent);
        await flushTaskEvents(rootTaskId as TaskId);
      }
      });
    },
    mapWorldEvent: publishWorldEvent,
    mapVisionProgress: (identity, event) => { const product = visionProductEvent(world.id, identity.taskId, identity.workerId, event); if (product) publish(product); },
    browserRuntime,
    permissionEngine,
    durableTaskEngine: options.durableTaskEngine,
    resourceGovernor,
    crawl4aiRuntime,
    shutdown: async () => {
      const active = world.inspect().tasks.filter(task => task.state === "created" || task.state === "assigned" || task.state === "running");
      for (const task of active) {
        try { submission.cancel(task.id); } catch { /* The run may have settled between inspection and cancellation. */ }
      }
      const pending = Promise.allSettled([...activeTaskResults.values()]);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        pending.then(() => true),
        new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), 10_000); }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!settled) throw new Error("Active task execution did not settle before shutdown; the database remains open for checkpoint cleanup.");
      await flushTaskEvents();
      await browserRuntime.shutdown();
      await crawl4aiRuntime.shutdown();
      await resourceGovernor.shutdown();
    },
  };
}

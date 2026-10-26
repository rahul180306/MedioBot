import { randomUUID } from "node:crypto";
import type { MediobotDefinition, MediobotDefinitionId, Task, TaskId, Worker, WorkerActivityState, WorkerId, WorldEvent } from "@mediobot-v2/domain";
import type { ProductEvent, ProductEventType } from "./contracts.ts";
import type { VisionProgressEvent } from "@mediobot-v2/vision";

const ACTIONS = new Set(["click", "type", "press", "scroll", "navigate", "select", "wait", "finish"]);
const OUTCOMES = new Set(["action-effect-observed", "no-effect", "state-changed"]);
const TOOLS = new Set(["filesystem.list", "filesystem.read", "filesystem.write", "terminal.execute", "web.search", "web.crawl", "web.doc"]);
const SAFE_TOOL_FAILURES = new Set(["path-error", "command-error", "filesystem-error", "file-not-found", "tool-error", "interrupted", "lifecycle-conflict"]);
const SAFE_OS_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "E2BIG", "ENOTDIR", "EISDIR", "EMFILE", "ENFILE", "PROCESS_TERMINATED", "TERMINAL_OUTCOME_UNKNOWN"]);
const SAFE_TERMINATION_SIGNALS = new Set(["SIGABRT", "SIGALRM", "SIGBREAK", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP", "SIGUSR1", "SIGUSR2"]);
const SAFE_ACTIVITY_STATES = new Set(["thinking", "planning", "inspecting", "editing", "running", "testing", "verifying", "researching",
  "collaborating", "waiting", "waiting_for_approval", "retrying", "recovered", "verified", "blocked", "completed", "failed", "cancelled"]);

export function worldProductEvent(event: WorldEvent, definitions: ReadonlyArray<MediobotDefinition>, workers: ReadonlyArray<Worker>, tasks?: ReadonlyArray<Task>): ProductEvent | undefined {
  if (!event.taskId) return undefined;
  const executionTask = tasks?.find((task) => task.id === event.taskId);
  const rootTaskId = executionTask?.parentTaskId ?? event.taskId;
  const worker = event.workerId ? workers.find((entry) => entry.id === event.workerId) : undefined;
  const definition = worker && definitions.find((entry) => entry.id === worker.definitionId);
  // Runtime tool lifecycle already carries the useful detail. Repeating its
  // synthetic "worker progress" and a second "worker finished" adds noise.
  if (event.type === "worker.progress" && !event.message?.trim()) return undefined;
  if (event.type === "worker.finished") return undefined;
  if (event.type === "maestro.worker-assigned") {
    const assignedTask = tasks?.find((task) => task.id === event.executionTaskId)
      ?? tasks?.find((task) => task.parentTaskId === event.taskId && task.assignedWorkerId
        && (!event.assignedWorkerId || task.assignedWorkerId === event.assignedWorkerId));
    const assignedWorker = workers.find((entry) => entry.id === (event.assignedWorkerId ?? assignedTask?.assignedWorkerId));
    const assignedDefinition = definitions.find((entry) => entry.id === (event.assignedDefinitionId ?? assignedWorker?.definitionId));
    if (!assignedDefinition || (!assignedTask && !event.executionTaskId)) return undefined;
    return { id: randomUUID(), type: "worker.assigned", worldId: event.worldId, taskId: rootTaskId,
      executionTaskId: event.executionTaskId ?? assignedTask!.id, workerId: event.assignedWorkerId ?? assignedWorker?.id,
      workerDefinitionId: assignedDefinition.id,
      workerName: assignedDefinition.name,
      message: `Assigned: ${(event.assignmentObjective ?? assignedTask?.goal ?? "Specialist task").split("\n", 1)[0]!.slice(0, 400)}`,
      activityState: "planning", occurredAt: event.occurredAt };
  }
  let type: ProductEventType | undefined;
  if (event.type === "task.started") type = executionTask?.parentTaskId ? "worker.started" : "task.started";
  else if (event.type === "task.completed") type = executionTask?.parentTaskId ? "worker.completed" : "task.completed";
  else if (event.type === "task.cancelled") type = executionTask?.parentTaskId ? "worker.cancelled" : "task.cancelled";
  else if (event.type === "task.failed") type = executionTask?.parentTaskId ? "worker.failed" : "task.failed";
  else if (event.type === "tool.started") type = "tool.started";
  else if (event.type === "tool.completed") type = "tool.completed";
  else if (event.type === "tool.failed") type = "tool.failed";
  else if (event.type === "tool.cancelled") type = "tool.cancelled";
  else if (event.type === "worker.progress") type = "worker.progress";
  else if (event.type === "worker.message") type = "worker.message";
  else if (event.type === "worker.finished") type = "worker.completed";
  else if (event.type === "file.changed") type = "file.changed";
  if (!type) return undefined;
  // Tool events without the invocation's correlation key cannot safely update a row.
  if (type.startsWith("tool.") && !event.toolInvocationId) return undefined;
  const errorCode = typeof event.errorCode === "string" && SAFE_OS_ERROR_CODES.has(event.errorCode) ? event.errorCode : undefined;
  const toolActivityState = event.type.startsWith("tool.")
    ? event.recoveredFromExecution ? "recovered" as const
      : event.toolName === "filesystem.write" || event.toolName === "filesystem.edit" ? "editing" as const
        : event.toolName === "filesystem.list" || event.toolName === "filesystem.read" || event.toolName === "filesystem.search" ? "inspecting" as const
          : event.toolName === "web.search" || event.toolName === "web.crawl" || event.toolName === "web.doc" ? "researching" as const
            : event.toolName === "terminal.execute" ? event.isVerification ? "verifying" as const : "running" as const : undefined
    : undefined;
  const activityState: WorkerActivityState | undefined = event.activityState
    ?? (event.type === "maestro.worker-assigned" ? "planning" as const
      : event.type === "task.started" && worker ? "thinking" as const
        : event.type === "task.completed" ? "completed" as const
          : event.type === "task.failed" ? "failed" as const
            : event.type === "task.cancelled" ? "cancelled" as const : toolActivityState);
  const safeToolFailureMessage = type === "tool.failed" && event.toolName === "terminal.execute"
    ? errorCode === "TERMINAL_OUTCOME_UNKNOWN" ? "A previous terminal command may have taken effect; it was not repeated. Inspect the workspace or process state before continuing."
      : SAFE_TERMINATION_SIGNALS.has(event.terminationSignal ?? "") ? `Process terminated by signal ${event.terminationSignal}.`
      : errorCode === "ENOENT" ? "Command could not start (ENOENT)."
      : errorCode === "EACCES" || errorCode === "EPERM" ? `Command could not start (${errorCode}).`
      : event.recoveredFromExecution && typeof event.exitCode === "number"
        ? `Restored prior terminal result (exit code ${event.exitCode}); command was not run again.`
        : typeof event.exitCode === "number" ? `Process exited with code ${event.exitCode}`
      : event.exitCode === null && (event.stderrBytes ?? 0) > 0
        ? `Process ended without an exit code; ${event.stderrBytes} stderr bytes were captured.` : undefined
    : type === "tool.failed" && event.toolName === "filesystem.read" && errorCode === "ENOENT"
      ? "File not found (ENOENT); no content was read." : undefined;
  const safeError = type === "task.failed"
    ? { code: "execution_failed" as const, message: `${definition?.name ?? "Mediobot"} could not complete the task.` }
    : type === "worker.failed"
      ? (() => {
        const repeated = event.error?.match(/Cody repeated the same action without progress after recovery feedback \((filesystem\.(?:list|search|read|write|edit)|terminal\.execute)\); the repeated tool operation was not executed\./);
        return { code: "execution_failed" as const, message: repeated
          ? `Cody stopped after repeating ${repeated[1]} despite recovery guidance; the repeated tool call was not executed.`
          : `${definition?.name ?? "Worker"} could not complete the assignment.` };
      })()
      : type === "tool.failed"
        ? { code: "execution_failed" as const, message: event.failureCategory === "file-not-found"
          ? "File not found (ENOENT); no content was read."
          : safeToolFailureMessage ?? (("error" in event && typeof event.error === "string") ? event.error : "Tool operation failed.") }
        : undefined;
  const safeWorkerFailureMessage = type === "worker.failed" && typeof safeError?.message === "string"
    && safeError.message.startsWith("Cody stopped after repeating ") ? safeError.message : undefined;
  return { id: randomUUID(), type, worldId: event.worldId, taskId: rootTaskId,
    ...(event.workerId ? { workerId: event.workerId } : {}), ...(event.taskId !== rootTaskId ? { executionTaskId: event.taskId } : {}),
    ...(worker ? { workerDefinitionId: worker.definitionId } : {}), ...(definition ? { workerName: definition.name } : {}),
    ...(event.toolName && TOOLS.has(event.toolName) ? { toolName: event.toolName as ProductEvent["toolName"] } : {}),
    ...(event.message ?? safeWorkerFailureMessage ? { message: event.message ?? safeWorkerFailureMessage } : {}),
    ...(activityState && SAFE_ACTIVITY_STATES.has(activityState) ? { activityState } : {}),
    ...(event.toolInvocationId ? { toolInvocationId: event.toolInvocationId } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(event.recoveredFromExecution ? { recoveredFromExecution: true } : {}),
    ...(event.toolName === "terminal.execute" && (type === "tool.failed" || event.recoveredFromExecution) && event.command ? { command: event.command } : {}),
    ...(event.toolName === "terminal.execute" && (type === "tool.failed" || event.recoveredFromExecution) && event.workingDirectory ? { workingDirectory: event.workingDirectory } : {}),
    ...(event.toolName === "terminal.execute" && (type === "tool.failed" || event.recoveredFromExecution) && event.recoveryReason ? { recoveryReason: event.recoveryReason } : {}),
    ...(event.failureCategory && SAFE_TOOL_FAILURES.has(event.failureCategory) ? { failureCategory: event.failureCategory } : {}),
    ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
    ...(typeof event.startedAt === "number" ? { startedAt: event.startedAt } : {}),
    ...(event.isVerification ? { isVerification: true, verificationStatus: event.verificationStatus } : {}),
    ...(typeof event.exitCode === "number" || event.exitCode === null ? { exitCode: event.exitCode } : {}),
    ...(event.terminationSignal && SAFE_TERMINATION_SIGNALS.has(event.terminationSignal) ? { terminationSignal: event.terminationSignal } : {}),
    ...(typeof event.stdoutBytes === "number" ? { stdoutBytes: event.stdoutBytes } : {}),
    ...(typeof event.stderrBytes === "number" ? { stderrBytes: event.stderrBytes } : {}),
    sequence: event.sequence,
    occurredAt: event.occurredAt, ...(safeError ? { error: safeError } : {}) };
}

export function visionProductEvent(worldId: string, taskId: TaskId, workerId: WorkerId, event: VisionProgressEvent): ProductEvent | undefined {
  const types: Partial<Record<VisionProgressEvent["type"], ProductEventType>> = {
    started: "worker.started", observation: "worker.observing", action: "worker.action-selected",
    verified: "worker.action-verified", "finish-requested": "worker.finish-requested", "goal-verified": "worker.goal-verified",
    cancelled: "worker.cancelled", failed: "worker.failed",
  };
  const type = types[event.type]; if (!type) return undefined;
  const actionType = event.actionType && ACTIONS.has(event.actionType) ? event.actionType as ProductEvent["actionType"] : undefined;
  const outcome = event.progress && OUTCOMES.has(event.progress) ? event.progress as ProductEvent["outcome"] : undefined;
  const invalidAction = event.diagnostic?.kind === "invalid-model-action" || event.diagnostic?.kind === "malformed-model-json";
  return { id: randomUUID(), type, worldId, taskId, workerId, occurredAt: Date.now(),
    ...(Number.isInteger(event.step) ? { step: event.step } : {}), ...(actionType ? { actionType } : {}), ...(outcome ? { outcome } : {}),
    ...(event.type === "failed" ? { error: invalidAction ? { code: "invalid_browser_action" as const,
      message: "Vision could not produce a valid browser action." } : { code: "execution_failed" as const, message: "Vision could not complete the task." } } : {}) };
}

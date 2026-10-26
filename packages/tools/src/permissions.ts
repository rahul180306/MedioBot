import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { TaskId, WorkerId } from "@mediobot-v2/domain";
import type { ToolInvocation } from "./index.ts";

export type ToolOperationCategory = "read-only" | "mutating" | "forbidden";
export type ApprovalRisk = "low" | "medium" | "high";
export type ApprovalStatus = "requested" | "approved" | "rejected" | "expired" | "cancelled";
export type StoredApprovalStatus = ApprovalStatus | "consumed" | "rejected_consumed";

export interface StoredApprovalRecord {
  readonly request: ApprovalRequest;
  readonly invocationHash: string;
  readonly status: StoredApprovalStatus;
  readonly workflowInterruptId?: string;
}

/** Optional durable journal. Implementations must persist before returning. */
export interface ApprovalRecordStore {
  listRequested(): ReadonlyArray<StoredApprovalRecord>;
  findActive(taskId: TaskId, invocationHash: string): StoredApprovalRecord | undefined;
  get(approvalId: string): StoredApprovalRecord | undefined;
  save(record: StoredApprovalRecord): void;
  setStatus(approvalId: string, status: StoredApprovalStatus, resolvedAt?: number, reason?: string): void;
  setWorkflowInterruptId?(approvalId: string, interruptId: string): void;
}

/** A workflow-owned suspension hook used only while executing a checkpointed task. */
export interface ToolExecutionControl {
  readonly interruptTask?: (value: unknown) => never;
  readonly isControlSignal?: (error: unknown) => boolean;
}

export interface AuthorizationScope {
  readonly toolName: ToolInvocation["name"];
  readonly path?: string;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly contentHash?: string;
  readonly writeMode?: "create";
  readonly detail: string;
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly taskId?: TaskId;
  readonly parentTaskId?: TaskId;
  readonly workerId?: WorkerId;
  readonly mediobotName: string;
  readonly toolName: ToolInvocation["name"];
  readonly targetWorkspace: string;
  readonly sanitizedDescription: string;
  /** The task's original policy, so restart recovery never inherits a changed app default. */
  readonly approvalMode?: ToolPermissionPolicy["mode"];
  readonly scope: AuthorizationScope;
  readonly risk: ApprovalRisk;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: ApprovalStatus;
  resolvedAt?: number;
  reason?: string;
}

export type PermissionDecision =
  | { readonly decision: "allow"; readonly category: "read-only" | "mutating" }
  | { readonly decision: "deny"; readonly reason: string; readonly failureStage: "workspace-validation" | "filesystem" | "terminal" }
  | { readonly decision: "require_approval"; readonly request: ApprovalRequest };

export interface ToolPermissionPolicy {
  readonly mode?: "Ask for approval" | "Require approval" | "Approve for me" | "Full auto" | "Full access" | "Ask before edits" | "Ask before commands" | "Full manual review";
  readonly approvalTimeoutMs?: number;
}

export class ToolPermissionError extends Error {
  readonly failureStage: "workspace-validation" | "filesystem" | "terminal";
  constructor(message: string, failureStage: "workspace-validation" | "filesystem" | "terminal" = "workspace-validation") {
    super(message);
    this.name = "ToolPermissionError";
    this.failureStage = failureStage;
  }
}

function isSensitiveName(name: string): boolean {
  return /^\.env(?:\.|$)/i.test(name) || /^(?:\.aws|\.ssh|secrets?|credentials?)$/i.test(name)
    || /(?:^|[._-])(?:secret|credential|private[-_]?key)(?:[._-]|$)/i.test(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name);
}

export function classifyToolOperation(
  invocation: ToolInvocation,
  workspaceRoot: string
): { readonly category: ToolOperationCategory; readonly reason?: string; readonly failureStage?: "workspace-validation" | "filesystem" | "terminal" } {
  if (invocation.name === "filesystem.list" || invocation.name === "filesystem.read" || invocation.name === "filesystem.write" || invocation.name === "filesystem.search" || invocation.name === "filesystem.edit") {
    const rawPath = "path" in invocation.input ? (invocation.input.path ?? ".") : ".";
    if (rawPath.includes("\0")) {
      return { category: "forbidden", reason: "Path contains a NUL byte", failureStage: "filesystem" };
    }
    if (path.isAbsolute(rawPath) || path.posix.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath) || /^[A-Za-z]:/.test(rawPath)) {
      return { category: "forbidden", reason: "Absolute paths are not allowed", failureStage: "filesystem" };
    }
    const components = rawPath.split(/[\\/]+/);
    if (components.includes("..")) {
      return { category: "forbidden", reason: "Path traversal is not allowed", failureStage: "filesystem" };
    }
    const target = path.resolve(workspaceRoot, rawPath);
    const relative = path.relative(workspaceRoot, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { category: "forbidden", reason: "Path escapes the owned workspace", failureStage: "filesystem" };
    }
    if ((relative ? relative.split(path.sep) : []).some(isSensitiveName)) {
      return { category: "forbidden", reason: "Credential and secret files are not available to Mediobot tools", failureStage: "filesystem" };
    }

    if (invocation.name === "filesystem.write" || invocation.name === "filesystem.edit") {
      return { category: "mutating" };
    }
    return { category: "read-only" };
  }

  if (invocation.name === "terminal.execute") {
    if (invocation.input.cwd) {
      const rawCwd = invocation.input.cwd;
      if (rawCwd.includes("\0")) return { category: "forbidden", reason: "Path contains a NUL byte", failureStage: "terminal" };
      if (path.isAbsolute(rawCwd) || path.posix.isAbsolute(rawCwd) || path.win32.isAbsolute(rawCwd) || /^[A-Za-z]:/.test(rawCwd)) {
        return { category: "forbidden", reason: "Absolute paths are not allowed in cwd", failureStage: "terminal" };
      }
      const targetCwd = path.resolve(workspaceRoot, rawCwd);
      const relCwd = path.relative(workspaceRoot, targetCwd);
      if (relCwd === ".." || relCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relCwd)) {
        return { category: "forbidden", reason: "Cwd escapes the owned workspace", failureStage: "terminal" };
      }
    }
    return { category: "mutating" };
  }

  if (invocation.name === "web.search" || invocation.name === "web.crawl" || invocation.name === "web.doc") {
    return { category: "read-only" };
  }

  return { category: "mutating" };
}

function computeScope(invocation: ToolInvocation): AuthorizationScope {
  if (invocation.name === "filesystem.write") {
    const contentHash = createHash("sha256").update(invocation.input.content).digest("hex").slice(0, 16);
    const createOnly = invocation.input.createOnly === true;
    return {
      toolName: invocation.name,
      path: invocation.input.path,
      contentHash,
      ...(createOnly ? { writeMode: "create" as const } : {}),
      detail: `${createOnly ? "Create new file" : "Write to"} ${invocation.input.path} (${Buffer.byteLength(invocation.input.content)} bytes, sha256:${contentHash}${createOnly ? "; fails if the path already exists" : ""})`,
    };
  }
  if (invocation.name === "filesystem.edit") {
    const editsSummary = invocation.input.edits.map((e) => `replace '${e.oldText.slice(0, 30)}' with '${e.newText.slice(0, 30)}'`).join("; ");
    const contentHash = createHash("sha256").update(JSON.stringify(invocation.input.edits)).digest("hex").slice(0, 16);
    return {
      toolName: invocation.name,
      path: invocation.input.path,
      contentHash,
      detail: `Edit ${invocation.input.path} (${editsSummary.slice(0, 200)}, editsHash:${contentHash})`,
    };
  }
  if (invocation.name === "filesystem.search") {
    return {
      toolName: invocation.name,
      detail: `Search '${invocation.input.query}' in ${invocation.input.path ?? "."}`,
    };
  }
  if (invocation.name === "terminal.execute") {
    const argsStr = (invocation.input.args ?? []).join(" ");
    const fullCmd = argsStr ? `${invocation.input.command} ${argsStr}` : invocation.input.command;
    return {
      toolName: invocation.name,
      command: invocation.input.command,
      args: invocation.input.args,
      detail: `Execute command: ${fullCmd.slice(0, 300)}`,
    };
  }
  if (invocation.name === "web.search") {
    return {
      toolName: invocation.name,
      detail: `Web search for "${invocation.input.query}" (filter: ${invocation.input.filterType ?? "all"})`,
    };
  }
  if (invocation.name === "web.crawl") {
    return {
      toolName: invocation.name,
      path: invocation.input.url,
      detail: `Web crawl of "${invocation.input.url}" (renderJs: ${Boolean((invocation.input as any).renderJs)})`,
    };
  }
  if (invocation.name === "web.doc") {
    return {
      toolName: invocation.name,
      path: invocation.input.url,
      detail: `Web documentation fetch from "${invocation.input.url}"`,
    };
  }
  return {
    toolName: invocation.name,
    detail: `${invocation.name} on workspace`,
  };
}

export function scopesMatch(scope: AuthorizationScope, invocation: ToolInvocation): boolean {
  if (scope.toolName !== invocation.name) return false;
  if (invocation.name === "filesystem.write") {
    if (scope.path !== invocation.input.path) return false;
    if ((scope.writeMode === "create") !== (invocation.input.createOnly === true)) return false;
    const currentHash = createHash("sha256").update(invocation.input.content).digest("hex").slice(0, 16);
    if (scope.contentHash && scope.contentHash !== currentHash) return false;
    return true;
  }
  if (invocation.name === "terminal.execute") {
    if (scope.command !== invocation.input.command) return false;
    const currentArgs = (invocation.input.args ?? []).join(" ");
    const scopeArgs = (scope.args ?? []).join(" ");
    if (currentArgs !== scopeArgs) return false;
    return true;
  }
  if (invocation.name === "web.search") {
    return scope.detail.includes(invocation.input.query);
  }
  if (invocation.name === "web.crawl" || invocation.name === "web.doc") {
    return scope.path === invocation.input.url;
  }
  return true;
}

export interface TaskContextBinding {
  readonly parentTaskId?: TaskId;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly workspaceId?: string;
  readonly mediobotName?: string;
  readonly policy?: ToolPermissionPolicy;
}

export class ToolPermissionEngine {
  private readonly pendingApprovals = new Map<string, {
    request: ApprovalRequest;
    invocationHash: string;
    resolve?: (result: { ok: boolean; status: ApprovalStatus; reason?: string }) => void;
    timeoutId?: NodeJS.Timeout;
    cleanupSignal?: () => void;
  }>();

  private readonly consumedApprovals = new Set<string>();
  private readonly taskContexts = new Map<TaskId, TaskContextBinding>();
  private readonly defaultPolicy: ToolPermissionPolicy;
  private readonly approvalStore?: ApprovalRecordStore;
  private parentTaskIdResolver?: (taskId: TaskId) => TaskId | undefined;
  private onApprovalRequested?: (request: ApprovalRequest) => void | Promise<void>;
  private onApprovalResolved?: (request: ApprovalRequest, context: { readonly activeWaiter: boolean }) => void;
  private disposed = false;

  constructor(options: {
    defaultPolicy?: ToolPermissionPolicy;
    approvalStore?: ApprovalRecordStore;
    onApprovalRequested?: (request: ApprovalRequest) => void | Promise<void>;
    onApprovalResolved?: (request: ApprovalRequest, context: { readonly activeWaiter: boolean }) => void;
  } = {}) {
    this.defaultPolicy = options.defaultPolicy ?? { mode: "Require approval" };
    this.approvalStore = options.approvalStore;
    this.onApprovalRequested = options.onApprovalRequested;
    this.onApprovalResolved = options.onApprovalResolved;
    for (const record of this.approvalStore?.listRequested() ?? []) {
      if (record.request.expiresAt <= Date.now()) {
        this.approvalStore?.setStatus(record.request.approvalId, "expired", Date.now(), "Tool authorization request expired");
        continue;
      }
      const request = { ...record.request, status: "requested" as const };
      const entry: { request: ApprovalRequest; invocationHash: string; timeoutId?: NodeJS.Timeout; resolve?: (result: { ok: boolean; status: ApprovalStatus; reason?: string }) => void; cleanupSignal?: () => void } = { request, invocationHash: record.invocationHash };
      entry.timeoutId = this.scheduleExpiry(entry);
      this.pendingApprovals.set(request.approvalId, entry);
    }
  }

  setParentTaskIdResolver(resolver: (taskId: TaskId) => TaskId | undefined): void {
    this.parentTaskIdResolver = resolver;
  }

  setNotifiers(notifiers: {
    onApprovalRequested?: (request: ApprovalRequest) => void | Promise<void>;
    onApprovalResolved?: (request: ApprovalRequest, context: { readonly activeWaiter: boolean }) => void;
  }): void {
    if (notifiers.onApprovalRequested) this.onApprovalRequested = notifiers.onApprovalRequested;
    if (notifiers.onApprovalResolved) this.onApprovalResolved = notifiers.onApprovalResolved;
  }

  bindTaskContext(taskId: TaskId, context: TaskContextBinding): void {
    this.taskContexts.set(taskId, {
      ...this.taskContexts.get(taskId),
      ...context,
    });
  }

  getTaskContext(taskId?: TaskId): TaskContextBinding | undefined {
    if (!taskId) return undefined;
    const direct = this.taskContexts.get(taskId);
    if (direct) return direct;
    const parentId = this.parentTaskIdResolver?.(taskId);
    if (parentId && parentId !== taskId) return this.getTaskContext(parentId);
    return undefined;
  }

  resolvePolicy(taskId?: TaskId): ToolPermissionPolicy {
    const bound = this.getTaskContext(taskId);
    return bound?.policy ?? this.defaultPolicy;
  }

  isApprovalRequired(policy: ToolPermissionPolicy, invocation?: ToolInvocation): boolean {
    const mode = policy.mode ?? "Require approval";
    // Migration & security invariant:
    // "Require approval", "Ask for approval", and "Full manual review" require approval for mutating operations.
    // "Ask before edits" only prompts for filesystem.write.
    // "Ask before commands" only prompts for terminal.execute.
    // Undefined / unknown mode fails closed to true.
    if (mode === "Approve for me" || mode === "Full auto" || mode === "Full access") {
      return false;
    }
    if (mode === "Ask before edits") {
      return invocation ? invocation.name === "filesystem.write" : true;
    }
    if (mode === "Ask before commands") {
      return invocation ? invocation.name === "terminal.execute" : true;
    }
    return true;
  }

  evaluate(
    invocation: ToolInvocation,
    context: { workspaceRoot: string; workerName?: string; taskId?: TaskId }
  ): PermissionDecision {
    const classification = classifyToolOperation(invocation, context.workspaceRoot);
    if (classification.category === "forbidden") {
      return {
        decision: "deny",
        reason: classification.reason ?? "Forbidden operation",
        failureStage: classification.failureStage ?? "workspace-validation",
      };
    }

    if (context.workerName?.toLowerCase() === "tester" && (invocation.name === "filesystem.write" || invocation.name === "filesystem.edit")) {
      return {
        decision: "deny",
        reason: "Tester is not permitted to perform file modifications",
        failureStage: "filesystem",
      };
    }

    if (classification.category === "read-only") {
      return { decision: "allow", category: "read-only" };
    }

    // Mutating operation: evaluate policy
    const policy = this.resolvePolicy(context.taskId ?? invocation.taskId);
    if (!this.isApprovalRequired(policy, invocation)) {
      return { decision: "allow", category: "mutating" };
    }

    const boundContext = this.getTaskContext(context.taskId ?? invocation.taskId);
    const scope = computeScope(invocation);
    const timeoutMs = policy.approvalTimeoutMs ?? 300_000; // 5 minutes
    const now = Date.now();
    const approvalId = randomUUID();
    const risk: ApprovalRisk = invocation.name === "terminal.execute" ? "high" : "medium";
    const mediobotName = context.workerName ?? boundContext?.mediobotName ?? "Cody";

    const request: ApprovalRequest = {
      approvalId,
      threadId: boundContext?.threadId,
      turnId: boundContext?.turnId,
      taskId: invocation.taskId,
      parentTaskId: boundContext?.parentTaskId,
      workerId: invocation.workerId,
      mediobotName,
      toolName: invocation.name,
      targetWorkspace: context.workspaceRoot,
      sanitizedDescription: scope.detail,
      approvalMode: policy.mode ?? "Require approval",
      scope,
      risk,
      createdAt: now,
      expiresAt: now + timeoutMs,
      status: "requested",
    };

    return { decision: "require_approval", request };
  }

  async requestApproval(
    invocation: ToolInvocation,
    context: { workspaceRoot: string; workerName?: string; signal?: AbortSignal; taskId?: TaskId } & ToolExecutionControl
  ): Promise<{ ok: boolean; status: ApprovalStatus; reason?: string }> {
    const taskId = context.taskId ?? invocation.taskId;
    const invocationHash = this.invocationHash(invocation, context.workspaceRoot);
    const stored = taskId ? this.approvalStore?.findActive(taskId, invocationHash) : undefined;
    if (stored?.status === "approved") {
      this.approvalStore?.setStatus(stored.request.approvalId, "consumed", Date.now());
      this.consumedApprovals.add(stored.request.approvalId);
      return { ok: true, status: "approved" };
    }
    if (stored?.status === "rejected" || stored?.status === "rejected_consumed") {
      if (stored.status === "rejected") {
        // The denial is now being consumed by the resumed exact tool call.
        // Persist this before returning so duplicate API retries cannot resume
        // an already-settled graph a second time.
        this.approvalStore?.setStatus(stored.request.approvalId, "rejected_consumed", Date.now(),
          stored.request.reason ?? "Tool execution rejected by user");
      }
      return { ok: false, status: "rejected", reason: stored.request.reason ?? "Tool execution rejected by user" };
    }
    if (stored?.status === "consumed") {
      return { ok: false, status: "rejected", reason: "This exact action was already authorized before interruption; its outcome is ambiguous and it will not be replayed automatically." };
    }

    const decision = this.evaluate(invocation, context);
    if (decision.decision === "allow") {
      return { ok: true, status: "approved" };
    }
    if (decision.decision === "deny") {
      return { ok: false, status: "rejected", reason: decision.reason };
    }

    const request = stored?.request ?? decision.request;
    if (context.signal?.aborted) {
      request.status = "cancelled";
      this.approvalStore?.setStatus(request.approvalId, "cancelled", Date.now(), "Tool invocation was cancelled");
      return { ok: false, status: "cancelled", reason: "Tool invocation was cancelled" };
    }

    // A durable graph run must suspend at the permission boundary so that its
    // checkpoint records the exact action awaiting approval. Keep the ordinary
    // process-local resolver path below for non-graph callers.
    if (context.interruptTask) {
      let entry = this.pendingApprovals.get(request.approvalId);
      if (!entry) {
        entry = { request, invocationHash };
        this.approvalStore?.save({ request, invocationHash, status: "requested" });
        entry.timeoutId = this.scheduleExpiry(entry);
        this.pendingApprovals.set(request.approvalId, entry);
      }
      entry.request = request;
      entry.invocationHash = invocationHash;
      if (!stored) {
        try { await this.onApprovalRequested?.(request); }
        catch { /* Notification errors must not alter authorization state */ }
      }
      context.interruptTask({ kind: "tool-approval", approvalId: request.approvalId, taskId,
        invocationHash, toolName: request.toolName });
      throw new Error("Workflow interrupt hook returned without suspending execution");
    }

    return new Promise((resolve) => {
      let entry = this.pendingApprovals.get(request.approvalId);
      if (!entry) {
        entry = { request, invocationHash };
        this.approvalStore?.save({ request, invocationHash, status: "requested" });
        entry.timeoutId = this.scheduleExpiry(entry);
        this.pendingApprovals.set(request.approvalId, entry);
      }
      entry.request = request;
      entry.invocationHash = invocationHash;
      entry.resolve = resolve;

      let cleanupSignal: (() => void) | undefined;
      if (context.signal) {
        const onAbort = () => {
          if (entry?.request.status === "requested") {
            if (entry.timeoutId) clearTimeout(entry.timeoutId);
            request.status = "cancelled";
            request.resolvedAt = Date.now();
            request.reason = "Tool invocation was cancelled";
            this.approvalStore?.setStatus(request.approvalId, "cancelled", request.resolvedAt, request.reason);
            this.pendingApprovals.delete(request.approvalId);
            this.onApprovalResolved?.(request, { activeWaiter: true });
            resolve({ ok: false, status: "cancelled", reason: request.reason });
          }
        };
        context.signal.addEventListener("abort", onAbort, { once: true });
        cleanupSignal = () => context.signal?.removeEventListener("abort", onAbort);
      }

      const previousCleanup = entry.cleanupSignal;
      previousCleanup?.();
      entry.cleanupSignal = cleanupSignal;
      entry.resolve = (result) => {
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        entry.cleanupSignal?.();
        entry.resolve = undefined;
        resolve(result);
      };

      if (!stored) {
        try { this.onApprovalRequested?.(request); }
        catch { /* Notification errors must not alter authorization state */ }
      }
    });
  }

  respond(
    approvalId: string,
    approved: boolean,
    callerContext?: { threadId?: string; turnId?: string }
  ): { success: boolean; status: ApprovalStatus; error?: string; needsWorkflowResume?: boolean } {
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) {
      const stored = this.approvalStore?.get(approvalId);
      if (stored?.status === "approved") {
        const request = stored.request;
        if (!approved) {
          return { success: false, status: "approved", error: "This approval was already granted and cannot be changed during resume." };
        }
        if (callerContext?.threadId && request.threadId && callerContext.threadId !== request.threadId) {
          return { success: false, status: "rejected", error: "Cross-thread approval is not permitted" };
        }
        if (callerContext?.turnId && request.turnId && callerContext.turnId !== request.turnId) {
          return { success: false, status: "rejected", error: "Cross-turn approval is not permitted" };
        }
        // Approval was durably recorded but graph resume failed before consuming
        // the exact action. Let the owning turn retry resume; requestApproval
        // still consumes this grant once, immediately before tool execution.
        return { success: true, status: "approved", needsWorkflowResume: true };
      }
      if (stored?.status === "rejected") {
        const request = stored.request;
        if (approved) {
          return { success: false, status: "rejected", error: "This approval was already rejected and cannot be changed during resume." };
        }
        if (callerContext?.threadId && request.threadId && callerContext.threadId !== request.threadId) {
          return { success: false, status: "rejected", error: "Cross-thread approval is not permitted" };
        }
        if (callerContext?.turnId && request.turnId && callerContext.turnId !== request.turnId) {
          return { success: false, status: "rejected", error: "Cross-turn approval is not permitted" };
        }
        // A durable rejection must resume the interrupted graph too. If the
        // first resume attempt failed, retrying this exact decision is safe:
        // requestApproval replays the stored rejection and cannot run the tool.
        return { success: true, status: "rejected", needsWorkflowResume: true };
      }
      if (stored?.status === "rejected_consumed") {
        return { success: false, status: "rejected", error: "This rejection has already been delivered to the interrupted workflow." };
      }
      if (stored?.status === "consumed") {
        return { success: false, status: "approved", error: "Approval already consumed" };
      }
      if (this.consumedApprovals.has(approvalId)) {
        return { success: false, status: "approved", error: "Approval already consumed" };
      }
      return { success: false, status: "rejected", error: "Approval request not found or already settled" };
    }

    const request = entry.request;

    // Cross-thread and cross-turn validation
    if (callerContext?.threadId && request.threadId && callerContext.threadId !== request.threadId) {
      return { success: false, status: "rejected", error: "Cross-thread approval is not permitted" };
    }
    if (callerContext?.turnId && request.turnId && callerContext.turnId !== request.turnId) {
      return { success: false, status: "rejected", error: "Cross-turn approval is not permitted" };
    }

    // Expiration check
    if (Date.now() > request.expiresAt) {
      request.status = "expired";
      request.resolvedAt = Date.now();
      request.reason = "Tool authorization request expired";
      this.pendingApprovals.delete(approvalId);
      this.approvalStore?.setStatus(approvalId, "expired", request.resolvedAt, request.reason);
      const activeWaiter = Boolean(entry.resolve);
      entry.resolve?.({ ok: false, status: "expired", reason: request.reason });
      this.onApprovalResolved?.(request, { activeWaiter });
      return { success: false, status: "expired", error: "Approval request expired" };
    }

    if (approved) {
      request.status = "approved";
      request.resolvedAt = Date.now();
      const activeWaiter = Boolean(entry.resolve);
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      this.approvalStore?.setStatus(approvalId, activeWaiter ? "consumed" : "approved", request.resolvedAt);
      if (activeWaiter) this.consumedApprovals.add(approvalId);
      this.pendingApprovals.delete(approvalId);
      this.onApprovalResolved?.(request, { activeWaiter });
      entry.resolve?.({ ok: true, status: "approved" });
      return { success: true, status: "approved", ...(!activeWaiter ? { needsWorkflowResume: true } : {}) };
    } else {
      request.status = "rejected";
      request.resolvedAt = Date.now();
      request.reason = "Tool execution rejected by user";
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      this.pendingApprovals.delete(approvalId);
      const activeWaiter = Boolean(entry.resolve);
      this.approvalStore?.setStatus(approvalId, activeWaiter ? "rejected_consumed" : "rejected",
        request.resolvedAt, request.reason);
      this.onApprovalResolved?.(request, { activeWaiter });
      entry.resolve?.({ ok: false, status: "rejected", reason: request.reason });
      return { success: true, status: "rejected", ...(!activeWaiter ? { needsWorkflowResume: true } : {}) };
    }
  }

  getPendingApprovals(): ReadonlyArray<ApprovalRequest> {
    return Array.from(this.pendingApprovals.values()).filter((e) => e.request.status === "requested").map((e) => e.request);
  }

  getApproval(approvalId: string): ApprovalRequest | undefined {
    return this.pendingApprovals.get(approvalId)?.request ?? this.approvalStore?.get(approvalId)?.request;
  }

  getWorkflowInterruptId(approvalId: string): string | undefined {
    return this.approvalStore?.get(approvalId)?.workflowInterruptId;
  }

  attachWorkflowInterrupt(approvalId: string, interruptId: string): void {
    if (!/^[\w-]{1,200}$/.test(interruptId)) throw new Error("Invalid workflow interrupt identity");
    const store = this.approvalStore;
    const approval = store?.get(approvalId);
    if (!approval || approval.status !== "requested") throw new Error("Only a pending durable approval can be attached to a workflow interrupt");
    if (!store?.setWorkflowInterruptId) throw new Error("Approval storage does not support durable workflow interrupts");
    store.setWorkflowInterruptId(approvalId, interruptId);
  }

  hasActiveApprovalWaiter(approvalId: string): boolean {
    return Boolean(this.pendingApprovals.get(approvalId)?.resolve);
  }

  /** Clear process-local waiters and timers while leaving durable requests pending for restart recovery. */
  suspendForRestart(): void {
    this.disposed = true;
    for (const [id, entry] of this.pendingApprovals) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.cleanupSignal?.();
      entry.cleanupSignal = undefined;
      const waiter = entry.resolve;
      entry.resolve = undefined;
      if (waiter) waiter({ ok: false, status: "cancelled", reason: "Execution suspended for application restart" });
      // Keep only authorization requests that were not explicitly settled.
      if (entry.request.status !== "requested") this.pendingApprovals.delete(id);
    }
  }

  private invocationHash(invocation: ToolInvocation, workspaceRoot: string): string {
    // Runtime world, worker, and resource IDs are process-local. Keep the
    // authorization tied to the durable task, canonical workspace, tool, and
    // exact arguments so the same pending action can resume after restart.
    const identity = { taskId: invocation.taskId, workspaceRoot, name: invocation.name, input: invocation.input };
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  }

  private scheduleExpiry(entry: { request: ApprovalRequest; invocationHash: string; resolve?: (result: { ok: boolean; status: ApprovalStatus; reason?: string }) => void;
    timeoutId?: NodeJS.Timeout; cleanupSignal?: () => void }): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (this.disposed) return;
      const request = entry.request;
      if (request.status !== "requested") return;
      request.status = "expired";
      request.resolvedAt = Date.now();
      request.reason = "Tool authorization request expired";
      this.pendingApprovals.delete(request.approvalId);
      this.approvalStore?.setStatus(request.approvalId, "expired", request.resolvedAt, request.reason);
      const activeWaiter = Boolean(entry.resolve);
      this.onApprovalResolved?.(request, { activeWaiter });
      entry.resolve?.({ ok: false, status: "expired", reason: request.reason });
    }, Math.max(10, entry.request.expiresAt - Date.now()));
    return timer;
  }

  cancelPending(predicate?: (req: ApprovalRequest) => boolean): void {
    for (const [id, entry] of this.pendingApprovals.entries()) {
      if (!predicate || predicate(entry.request)) {
        entry.request.status = "cancelled";
        entry.request.resolvedAt = Date.now();
        entry.request.reason = "Tool execution cancelled";
        this.approvalStore?.setStatus(id, "cancelled", entry.request.resolvedAt, entry.request.reason);
        this.pendingApprovals.delete(id);
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        const activeWaiter = Boolean(entry.resolve);
        this.onApprovalResolved?.(entry.request, { activeWaiter });
        entry.resolve?.({ ok: false, status: "cancelled", reason: entry.request.reason });
      }
    }
  }

  invalidateAll(): void {
    this.cancelPending();
  }
}

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, link, mkdir, open, opendir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import type { ResourceId, TaskId, WorkerId, WorldId } from "@mediobot-v2/domain";
import { InMemoryWorld } from "@mediobot-v2/domain";
import type { CrawlRequest, CrawlResult, WebSearchRequest, WebSearchResult, ProvenanceRecord, UnifiedFileLockService, FileLockOptions } from "@mediobot-v2/contracts";
import { isOSMetadata, PathEscapeForbiddenError, FileLockTimeoutError } from "@mediobot-v2/contracts";
export { FileLockManager, defaultFileLockManager, resolveCanonicalPath } from "./fileLockManager.ts";
export type { UnifiedFileLockService, FileLockOptions };
export { FileLockTimeoutError };
import { defaultFileLockManager } from "./fileLockManager.ts";

/**
 * Duck-typed interface for web intelligence — matches Crawl4AiRuntime
 * without creating a circular dependency on @mediobot-v2/runtime.
 */
export interface WebIntelligenceProvider {
  crawl(request: CrawlRequest, signal?: AbortSignal): Promise<CrawlResult>;
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
  readonly isRunning: boolean;
}

interface WorkspaceBinding {
  readonly root: string;
  readonly taskId?: TaskId;
  readonly parentTaskId?: TaskId;
}

const workspaceBindingsByWorld = new WeakMap<InMemoryWorld, Map<ResourceId, WorkspaceBinding>>();

const activeTempFiles = new Set<string>();

if (typeof process !== "undefined" && typeof process.once === "function") {
  process.once("exit", () => {
    for (const tempFile of activeTempFiles) {
      try {
        unlinkSync(tempFile);
      } catch {
        // ignore cleanup error on exit
      }
    }
  });
}

async function atomicRename(source: string, destination: string): Promise<void> {
  const maxRetries = 5;
  let delayMs = 10;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs *= 2;
        continue;
      }
      throw err;
    }
  }
}

interface InvocationBase {
  readonly worldId: WorldId;
  readonly workerId: WorkerId;
  readonly taskId: TaskId;
  readonly resourceId: ResourceId;
  readonly signal?: AbortSignal;
  /** Stable identity for replaying one logical tool action after recovery. */
  readonly executionKey?: string;
}

export type ToolInvocation = InvocationBase & (
  | { readonly name: "filesystem.list"; readonly input: { readonly path?: string } }
  | { readonly name: "filesystem.read"; readonly input: { readonly path: string; readonly startLine?: number; readonly endLine?: number } }
  | { readonly name: "filesystem.search"; readonly input: {
      readonly query: string;
      readonly path?: string;
      readonly isRegex?: boolean;
      readonly caseSensitive?: boolean;
      readonly maxResults?: number;
    } }
  | { readonly name: "filesystem.write"; readonly input: {
    readonly path: string; readonly content: string; readonly createOnly?: boolean; readonly expectedContentHash?: string;
  } }
  | { readonly name: "filesystem.edit"; readonly input: {
      readonly path: string;
      readonly edits: ReadonlyArray<{ readonly oldText: string; readonly newText: string; readonly allowMultiple?: boolean }>;
      readonly expectedContentHash?: string;
    } }
  | { readonly name: "terminal.execute"; readonly input: {
    readonly command: string;
    readonly args?: ReadonlyArray<string>;
    readonly cwd?: string;
  } }
  /** Web intelligence tools — no workspace required; resourceId is unused and may be omitted. */
  | { readonly name: "web.search"; readonly input: {
      readonly query: string;
      readonly maxResults?: number;
      readonly allowedDomains?: ReadonlyArray<string>;
      readonly filterType?: "all" | "documentation" | "components" | "articles";
    } }
  | { readonly name: "web.crawl"; readonly input: {
      readonly url: string;
      readonly cacheMode?: "enabled" | "bypass" | "read-only";
      readonly waitForSelector?: string;
      readonly extractMarkdown?: boolean;
    } }
  | { readonly name: "web.doc"; readonly input: {
      readonly url: string;
      readonly cssSelector?: string;
      readonly cacheMode?: "enabled" | "bypass" | "read-only";
    } }
);

export interface WebSearchOutput {
  readonly searchResults: ReadonlyArray<{
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
    readonly source: string;
  }>;
  readonly totalMatches: number;
  readonly query: string;
  readonly providerStatus?: "ok" | "empty" | "challenge" | "unavailable";
}

export interface WebCrawlOutput {
  readonly url: string;
  readonly finalUrl: string;
  readonly title?: string;
  readonly markdown: string;
  readonly sanitized: boolean;
  readonly promptInjectionFlags: ReadonlyArray<string>;
  readonly provenance: ProvenanceRecord;
  readonly cached: boolean;
  readonly durationMs: number;
}

export type ToolOutput =
  | { readonly entries: ReadonlyArray<string> }
  | { readonly content: string; readonly totalLines?: number; readonly startLine?: number; readonly endLine?: number }
  | { readonly bytesWritten: number; readonly contentHash: string }
  | {
      readonly matches: ReadonlyArray<{ readonly path: string; readonly lineNumber: number; readonly lineContent: string }>;
      readonly totalMatches: number;
    }
  | {
      readonly bytesWritten: number;
      readonly additions: number;
      readonly deletions: number;
      readonly contentHash: string;
      readonly diff: string;
    }
  | {
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
    readonly exitCode: number | null;
    readonly termination: "exited" | "cancelled";
    readonly launchErrorCode?: string;
    readonly terminationSignal?: NodeJS.Signals;
  }
  | WebSearchOutput
  | WebCrawlOutput;

const MAX_CAPTURED_STREAM_BYTES = 1024 * 1024;
const MAX_FILE_READ_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const SAFE_TERMINATION_SIGNALS = new Set<NodeJS.Signals>([
  "SIGABRT", "SIGALRM", "SIGBREAK", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE",
  "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP", "SIGUSR1", "SIGUSR2",
]);

function isNodeSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === "string" && SAFE_TERMINATION_SIGNALS.has(value as NodeJS.Signals);
}

function fileContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function matchesExpectedContentHash(content: string, expected: string): boolean {
  if (!/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/i.test(expected)) return false;
  const actual = fileContentHash(content);
  return expected === actual || expected === actual.slice(0, 16);
}

function staleRevision(message = "STALE_REVISION: File content changed since it was read"): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = "STALE_REVISION";
  return error;
}

function isSensitiveName(name: string): boolean {
  return /^\.env(?:\.|$)/i.test(name) || /^(?:\.aws|\.ssh|secrets?|credentials?)$/i.test(name)
    || /(?:^|[._-])(?:secret|credential|private[-_]?key)(?:[._-]|$)/i.test(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name);
}

function isSensitiveEnvironmentName(name: string): boolean {
  return /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTHORIZATION|PASSWORD|SECRET|CREDENTIAL)/i.test(name);
}

export interface ToolResult {
  readonly invocationId: string;
  readonly worldId: WorldId;
  readonly workerId: WorkerId;
  readonly taskId: TaskId;
  readonly resourceId: ResourceId;
  readonly toolName: ToolInvocation["name"];
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly output?: ToolOutput;
  readonly error?: string;
  readonly errorCode?: string;
  readonly failureStage?: "workspace-validation" | "filesystem" | "terminal" | "web-intelligence";
  /** True when a durable prior terminal outcome was returned without starting a process. */
  readonly recoveredFromExecution?: boolean;
}

export {
  ToolPermissionEngine,
  ToolPermissionError,
  classifyToolOperation,
  scopesMatch,
  type ToolOperationCategory,
  type ApprovalRisk,
  type ApprovalStatus,
  type AuthorizationScope,
  type ApprovalRequest,
  type ApprovalRecordStore,
  type StoredApprovalRecord,
  type StoredApprovalStatus,
  type PermissionDecision,
  type ToolPermissionPolicy,
  type TaskContextBinding,
  type ToolExecutionControl,
} from "./permissions.ts";
import { ToolPermissionEngine, ToolPermissionError } from "./permissions.ts";
import type { ToolExecutionControl } from "./permissions.ts";

export interface ToolSubprocessSupervisor {
  register(record: import("@mediobot-v2/contracts").SubprocessRecord): void;
  unregister(id: string): void;
  terminateTaskSubprocesses(taskId: TaskId): Promise<number>;
}

export interface ToolInvocationEventJournal {
  appendEvent(taskId: string, eventType: string, payload: Record<string, unknown>): Promise<unknown>;
  getEvents(taskId: string): Promise<ReadonlyArray<{ readonly eventType: string; readonly payload: Record<string, unknown> }>>;
}

class TerminalOutcomeUnknownError extends Error {
  readonly code = "TERMINAL_OUTCOME_UNKNOWN";
  constructor() {
    super("A previous terminal command may have taken effect before interruption. It was not repeated; inspect workspace or process state before continuing.");
    this.name = "TerminalOutcomeUnknownError";
  }
}

export interface ToolRuntimeOptions {
  readonly permissionEngine?: ToolPermissionEngine;
  readonly subprocessSupervisor?: ToolSubprocessSupervisor;
  readonly webIntelligence?: WebIntelligenceProvider;
  readonly invocationJournal?: ToolInvocationEventJournal;
  readonly fileLockManager?: UnifiedFileLockService;
  readonly onWriteCommitted?: (target: string, hash: string) => void;
}

export class ToolRuntime {
  private readonly workspaces: Map<ResourceId, WorkspaceBinding>;
  private readonly world: InMemoryWorld;
  private permissionEngine?: ToolPermissionEngine;
  private subprocessSupervisor?: ToolSubprocessSupervisor;
  private webIntelligence?: WebIntelligenceProvider;
  private invocationJournal?: ToolInvocationEventJournal;
  private readonly fileLockManager: UnifiedFileLockService;
  private readonly onWriteCommitted?: (target: string, hash: string) => void;
  private readonly terminalInvocationLocks = new Map<string, Promise<void>>();

  constructor(world: InMemoryWorld, options?: ToolRuntimeOptions) {
    this.world = world;
    this.permissionEngine = options?.permissionEngine;
    this.subprocessSupervisor = options?.subprocessSupervisor;
    this.webIntelligence = options?.webIntelligence;
    this.invocationJournal = options?.invocationJournal;
    this.fileLockManager = options?.fileLockManager ?? defaultFileLockManager;
    this.onWriteCommitted = options?.onWriteCommitted;
    if (this.permissionEngine) {
      this.permissionEngine.setParentTaskIdResolver((taskId) => {
        const task = this.world.inspect().tasks.find((t) => t.id === taskId);
        return task?.parentTaskId;
      });
    }
    let bindings = workspaceBindingsByWorld.get(world);
    if (!bindings) {
      bindings = new Map();
      workspaceBindingsByWorld.set(world, bindings);
    }
    this.workspaces = bindings;
  }

  setSubprocessSupervisor(supervisor: ToolSubprocessSupervisor | undefined): void {
    this.subprocessSupervisor = supervisor;
  }

  getSubprocessSupervisor(): ToolSubprocessSupervisor | undefined {
    return this.subprocessSupervisor;
  }

  setWebIntelligence(provider: WebIntelligenceProvider | undefined): void {
    this.webIntelligence = provider;
  }

  getWebIntelligence(): WebIntelligenceProvider | undefined {
    return this.webIntelligence;
  }

  setInvocationJournal(journal: ToolInvocationEventJournal | undefined): void {
    this.invocationJournal = journal;
  }

  setPermissionEngine(engine: ToolPermissionEngine | undefined): void {
    this.permissionEngine = engine;
    if (engine) {
      engine.setParentTaskIdResolver((taskId) => {
        const task = this.world.inspect().tasks.find((t) => t.id === taskId);
        return task?.parentTaskId;
      });
    }
  }

  getPermissionEngine(): ToolPermissionEngine | undefined {
    return this.permissionEngine;
  }

  async bindWorkspace(resourceId: ResourceId, location: string): Promise<void> {
    const snapshot = this.world.inspect();
    const resource = snapshot.resources.find((item) => item.id === resourceId);
    if (!resource || resource.kind !== "workspace" || resource.owner.type === "world") {
      throw new Error("Workspace resource must be owned by a worker or task");
    }
    const owner = resource.owner;
    if (this.workspaces.has(resourceId)) throw new Error("Workspace resource is already bound");
    const canonical = await realpath(location);
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory()) throw new Error("Workspace root must be a directory");
    if (this.workspaces.has(resourceId)) throw new Error("Workspace resource is already bound");
    const activeTask = owner.type === "task"
      ? snapshot.tasks.find((item) => item.id === owner.taskId)
      : snapshot.tasks.filter((item) => item.assignedWorkerId === owner.workerId
        && !["completed", "failed", "cancelled"].includes(item.state)).length === 1
        ? snapshot.tasks.find((item) => item.assignedWorkerId === owner.workerId
          && !["completed", "failed", "cancelled"].includes(item.state))
        : undefined;
    const binding: WorkspaceBinding = { root: canonical, ...(activeTask ? { taskId: activeTask.id } : {}),
      ...(activeTask?.parentTaskId ? { parentTaskId: activeTask.parentTaskId } : {}) };
    for (const [boundResourceId, bound] of this.workspaces) {
      if (!this.pathsOverlap(bound.root, canonical)) continue;
      const sameAuthorizedParent = bound.root === canonical && activeTask?.parentTaskId !== undefined
        && bound.parentTaskId === activeTask.parentTaskId && bound.taskId !== activeTask.id && boundResourceId !== resourceId;
      if (!sameAuthorizedParent) throw new Error("Workspace locations must not overlap");
    }
    this.workspaces.set(resourceId, binding);
  }

  releaseWorkspace(resourceId: ResourceId): void {
    this.workspaces.delete(resourceId);
  }

  async invoke(invocation: ToolInvocation, control?: ToolExecutionControl): Promise<ToolResult> {
    const invocationId = globalThis.crypto.randomUUID();
    const base = {
      invocationId,
      worldId: invocation.worldId,
      workerId: invocation.workerId,
      taskId: invocation.taskId,
      resourceId: invocation.resourceId,
      toolName: invocation.name,
    };

    // Web intelligence tools bypass workspace validation.
    if (invocation.name === "web.search" || invocation.name === "web.crawl" || invocation.name === "web.doc") {
      return this.runWebIntelligence(
        invocation as Extract<ToolInvocation, { name: `web.${string}` }>,
        base,
        control,
      );
    }

    let failureStage: ToolResult["failureStage"] = "workspace-validation";
    try {
      const root = await this.validate(invocation);
      failureStage = invocation.name === "terminal.execute" ? "terminal" : "filesystem";

      if (this.permissionEngine) {
        const worker = this.world.inspect().workers.find((w) => w.id === invocation.workerId);
        const def = worker && this.world.inspect().definitions.find((d) => d.id === worker.definitionId);
        const workerName = def?.name ?? "Cody";
        const auth = await this.permissionEngine.requestApproval(invocation, {
          workspaceRoot: root,
          workerName,
          signal: invocation.signal,
          taskId: invocation.taskId,
          ...control,
        });
        if (!auth.ok) {
          if (auth.status === "cancelled") {
            if (invocation.name === "terminal.execute") this.event(invocation, "tool.started");
            this.event(invocation, "tool.cancelled");
            return { ...base, status: "cancelled", error: auth.reason ?? "Tool invocation was cancelled" };
          }
          throw new ToolPermissionError(auth.reason ?? "Tool execution was not authorized", failureStage);
        }
      }

      if (invocation.name !== "terminal.execute") this.event(invocation, "tool.started");
      if (invocation.signal?.aborted) {
        if (invocation.name === "terminal.execute") this.event(invocation, "tool.started");
        this.event(invocation, "tool.cancelled");
        return { ...base, status: "cancelled", error: "Tool invocation was cancelled" };
      }
      let recoveredFromExecution = false;
      const output = invocation.name === "terminal.execute"
        ? await this.runTerminal(invocation, root, async () => {
            const prior = await this.prepareTerminalInvocation(invocation, invocationId);
            if (prior) {
              recoveredFromExecution = true;
              return prior;
            }
            this.event(invocation, "tool.started");
            return undefined;
          })
        : await this.runFilesystem(invocation as Extract<ToolInvocation, { name: `filesystem.${string}` }>, root);
      if (invocation.name === "terminal.execute" && !recoveredFromExecution) {
        await this.settleTerminalInvocation(invocation, invocationId, output as Extract<ToolOutput, { readonly stdout: string }>);
      }
      if (invocation.signal?.aborted && invocation.name !== "terminal.execute") {
        this.event(invocation, "tool.cancelled");
        return { ...base, status: "cancelled", error: "Tool invocation was cancelled" };
      }
      if (invocation.name === "terminal.execute" && "exitCode" in output && output.termination === "cancelled") {
        this.event(invocation, "tool.cancelled");
        return { ...base, status: "cancelled", output, ...(recoveredFromExecution ? { recoveredFromExecution: true } : {}) };
      }
      if (invocation.name === "terminal.execute" && "exitCode" in output && output.exitCode !== 0) {
        const errorMsg = output.launchErrorCode
          ? `Command could not start (${output.launchErrorCode}).`
          : output.terminationSignal ? `Process terminated by signal ${output.terminationSignal}.`
            : `Process exited with code ${output.exitCode}`;
        this.event(invocation, "tool.failed", errorMsg);
        return { ...base, status: "failed", output, error: errorMsg,
          ...(output.launchErrorCode ? { errorCode: output.launchErrorCode }
            : output.terminationSignal ? { errorCode: "PROCESS_TERMINATED" } : {}), failureStage: "terminal",
          ...(recoveredFromExecution ? { recoveredFromExecution: true } : {}) };
      }
      this.event(invocation, "tool.succeeded");
      return { ...base, status: "succeeded", output, ...(recoveredFromExecution ? { recoveredFromExecution: true } : {}) };
    } catch (error) {
      if (control?.isControlSignal?.(error)) throw error;
      const status = invocation.signal?.aborted ? "cancelled" : "failed";
      let errorMsg = error instanceof Error ? error.message : String(error);
      if ((error as any)?.code === "STALE_REVISION" && !errorMsg.includes("STALE_REVISION")) {
        errorMsg = `STALE_REVISION: ${errorMsg}`;
      }
      try {
        if (this.canAttribute(invocation)) this.event(invocation, status === "cancelled" ? "tool.cancelled" : "tool.failed", errorMsg);
      } catch {
        // Invalid ownership cannot safely be recorded against the claimed resource.
      }
      return {
        ...base,
        status,
        error: errorMsg,
        errorCode: error instanceof ToolPermissionError ? "PERMISSION_DENIED"
          : error instanceof TerminalOutcomeUnknownError ? error.code
          : typeof (error as NodeJS.ErrnoException)?.code === "string"
            ? (error as NodeJS.ErrnoException).code
            : "TOOL_ERROR",
        failureStage: error instanceof ToolPermissionError ? error.failureStage : failureStage,
      };
    }
  }

  private terminalSignature(invocation: Extract<ToolInvocation, { name: "terminal.execute" }>): string {
    const parts = invocation.input.command.trim().split(/\s+/);
    const program = parts[0] || invocation.input.command;
    const extraArgs = (!invocation.input.args || invocation.input.args.length === 0) ? parts.slice(1) : [];
    const descriptor = { program, args: [...extraArgs, ...(invocation.input.args ?? [])], cwd: invocation.input.cwd ?? "." };
    return createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
  }

  private async prepareTerminalInvocation(invocation: Extract<ToolInvocation, { name: "terminal.execute" }>, invocationId: string)
    : Promise<Extract<ToolOutput, { readonly stdout: string }> | undefined> {
    const journal = this.invocationJournal;
    if (!journal) return undefined;
    return this.withTerminalInvocationLock(String(invocation.taskId), async () => {
      const events = await journal.getEvents(String(invocation.taskId));
      const started = new Map<string, Record<string, unknown>>();
      const settled = new Map<string, Record<string, unknown>>();
      for (const event of events) {
        const payload = event.payload;
        const key = typeof payload.executionKey === "string" ? payload.executionKey : payload.invocationId;
        if (typeof key !== "string") continue;
        if (event.eventType === "tool.side_effect.started") started.set(key, payload);
        else if (event.eventType === "tool.side_effect.settled") settled.set(key, payload);
      }
      if ([...started.keys()].some(id => !settled.has(id))) throw new TerminalOutcomeUnknownError();

      const signature = this.terminalSignature(invocation);
      const executionKey = invocation.executionKey ?? invocationId;
      const prior = settled.get(executionKey);
      if (prior) {
        if (prior.signature !== signature) throw new TerminalOutcomeUnknownError();
        const exitCode = typeof prior.exitCode === "number" ? prior.exitCode : null;
        const launchErrorCode = typeof prior.launchErrorCode === "string" ? prior.launchErrorCode : undefined;
        const terminationSignal = isNodeSignal(prior.terminationSignal) ? prior.terminationSignal : undefined;
        return {
          stdout: "", stderr: "", stdoutTruncated: Boolean(prior.stdoutTruncated), stderrTruncated: Boolean(prior.stderrTruncated),
          exitCode, termination: prior.termination === "cancelled" ? "cancelled" as const : "exited" as const,
          ...(launchErrorCode ? { launchErrorCode } : {}),
          ...(terminationSignal ? { terminationSignal } : {}),
        };
      }

      await journal.appendEvent(String(invocation.taskId), "tool.side_effect.started", {
        invocationId, executionKey, workerId: invocation.workerId, toolName: "terminal.execute", signature, occurredAt: Date.now(),
      });
      return undefined;
    });
  }

  private async settleTerminalInvocation(invocation: Extract<ToolInvocation, { name: "terminal.execute" }>, invocationId: string,
    output: Extract<ToolOutput, { readonly stdout: string }>): Promise<void> {
    if (!this.invocationJournal) return;
    await this.invocationJournal.appendEvent(String(invocation.taskId), "tool.side_effect.settled", {
      invocationId, executionKey: invocation.executionKey ?? invocationId, workerId: invocation.workerId,
      toolName: "terminal.execute", signature: this.terminalSignature(invocation),
      status: output.termination === "cancelled" ? "cancelled" : output.exitCode === 0 ? "succeeded" : "failed",
      exitCode: output.exitCode, termination: output.termination, stdoutTruncated: output.stdoutTruncated,
      stderrTruncated: output.stderrTruncated, ...(output.launchErrorCode ? { launchErrorCode: output.launchErrorCode } : {}),
      ...(output.terminationSignal ? { terminationSignal: output.terminationSignal } : {}), occurredAt: Date.now(),
    });
  }

  private async withTerminalInvocationLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.terminalInvocationLocks.get(taskId);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.terminalInvocationLocks.set(taskId, current);
    if (previous) await previous;
    try { return await action(); }
    finally {
      if (this.terminalInvocationLocks.get(taskId) === current) this.terminalInvocationLocks.delete(taskId);
      release();
    }
  }

  private async validate(invocation: ToolInvocation): Promise<string> {
    if (invocation.worldId !== this.world.id) throw new Error("Invocation belongs to another world");
    const snapshot = this.world.inspect();
    const worker = snapshot.workers.find((item) => item.id === invocation.workerId);
    const task = snapshot.tasks.find((item) => item.id === invocation.taskId);
    const resource = snapshot.resources.find((item) => item.id === invocation.resourceId);
    if (!worker || worker.state !== "busy") throw new Error("Worker is not active");
    if (!task || task.state !== "running" || task.assignedWorkerId !== worker.id) {
      throw new Error("Task is not running for this worker");
    }
    if (!resource || resource.kind !== "workspace" || resource.state !== "in-use") {
      throw new Error("Resource is not an active workspace");
    }
    const owned = (resource.owner.type === "worker" && resource.owner.workerId === worker.id)
      || (resource.owner.type === "task" && resource.owner.taskId === task.id);
    if (!owned) throw new Error("Workspace is not owned by this worker or task");
    const binding = this.workspaces.get(resource.id);
    if (!binding) throw new Error("Workspace resource has no local binding");
    const root = binding.root;
    await this.assertCanonicalRoot(root);
    return root;
  }

  private async assertCanonicalRoot(root: string): Promise<void> {
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(root) !== root) {
      throw new Error("Workspace root changed after it was bound");
    }
  }

  private canAttribute(invocation: ToolInvocation): boolean {
    const snapshot = this.world.inspect();
    const task = snapshot.tasks.find((item) => item.id === invocation.taskId);
    const resource = snapshot.resources.find((item) => item.id === invocation.resourceId);
    return invocation.worldId === this.world.id
      && task?.assignedWorkerId === invocation.workerId
      && (resource?.owner.type === "worker" && resource.owner.workerId === invocation.workerId
        || resource?.owner.type === "task" && resource.owner.taskId === invocation.taskId);
  }

  private event(invocation: ToolInvocation, type: string, error?: string): void {
    this.world.appendEvent({
      type,
      workerId: invocation.workerId,
      taskId: invocation.taskId,
      resourceId: invocation.resourceId,
      toolName: invocation.name,
      ...(error ? { error } : {}),
    });
  }

  private async runFilesystem(
    invocation: Extract<ToolInvocation, { name: `filesystem.${string}` }>,
    root: string,
  ): Promise<ToolOutput> {
    const relativePath = "path" in invocation.input ? (invocation.input.path ?? ".") : ".";
    const target = this.resolveContained(root, relativePath);
    this.assertNonSensitivePath(root, target);
    const allowMissing = invocation.name === "filesystem.write";
    await this.assertNoSymlink(root, target, allowMissing);

    if (invocation.name === "filesystem.list") {
      await this.assertNoSymlink(root, target, false);
      const directory = await opendir(target);
      const entries: string[] = [];
      for await (const entry of directory) {
        if (isOSMetadata(entry.name) || isSensitiveName(entry.name)) continue;
        if (entries.length >= MAX_DIRECTORY_ENTRIES) {
          throw new Error(`Directory exceeds the ${MAX_DIRECTORY_ENTRIES} entry limit`);
        }
        entries.push(entry.name);
      }
      return { entries: entries.sort() };
    }

    if (invocation.name === "filesystem.read") {
      await this.assertNoSymlink(root, target, false);
      const metadata = await lstat(target);
      if (!metadata.isFile()) throw new Error("Only regular files can be read");
      if (metadata.nlink > 1) throw new Error("Hard-linked files cannot be read from a workspace");
      if (metadata.size > MAX_FILE_READ_BYTES) {
        throw new Error(`File exceeds the ${MAX_FILE_READ_BYTES} byte read limit`);
      }
      const rawContent = await readFile(target, "utf8");
      const { startLine, endLine } = invocation.input;
      if (startLine !== undefined || endLine !== undefined) {
        if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
          throw new Error("startLine must be a positive integer");
        }
        if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
          throw new Error("endLine must be a positive integer");
        }
        if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
          throw new Error("startLine must not exceed endLine");
        }
        const lines = rawContent.split("\n");
        const totalLines = lines.length;
        const start = Math.max(1, startLine ?? 1);
        const end = Math.min(totalLines, endLine ?? totalLines);
        const sliced = lines.slice(start - 1, end).join("\n");
        return { content: sliced, totalLines, startLine: start, endLine: end };
      }
      return { content: rawContent };
    }

    if (invocation.name === "filesystem.search") {
      const { query, isRegex, caseSensitive, maxResults = 50 } = invocation.input;
      if (!query || typeof query !== "string") throw new Error("Search query must be a non-empty string");
      const limit = Math.max(1, Math.min(maxResults, 200));

      let matcher: (line: string) => boolean;
      if (isRegex) {
        const flags = caseSensitive ? "u" : "iu";
        const re = new RegExp(query, flags);
        matcher = (line) => re.test(line);
      } else {
        const needle = caseSensitive ? query : query.toLowerCase();
        matcher = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
      }

      const matches: Array<{ path: string; lineNumber: number; lineContent: string }> = [];

      const walk = async (dir: string) => {
        if (matches.length >= limit) return;
        const entries = await opendir(dir);
        for await (const entry of entries) {
          if (matches.length >= limit) break;
          const entryPath = path.join(dir, entry.name);
          const relPath = path.relative(root, entryPath);
          if (isOSMetadata(entry.name) || isSensitiveName(entry.name)) continue;
          if (entry.isDirectory()) {
            if (["node_modules", ".git", ".turbo", "dist", "build", ".next"].includes(entry.name)) continue;
            await walk(entryPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if ([".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf", ".zip", ".tar", ".gz", ".db", ".sqlite", ".sqlite3", ".exe", ".bin", ".woff", ".woff2", ".lock"].includes(ext)) {
              continue;
            }
            try {
              const stat = await lstat(entryPath);
              if (stat.size > 2 * 1024 * 1024) continue;
              const content = await readFile(entryPath, "utf8");
              if (content.includes("\0")) continue;
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (matcher(lines[i]!)) {
                  matches.push({
                    path: relPath,
                    lineNumber: i + 1,
                    lineContent: lines[i]!.slice(0, 500),
                  });
                  if (matches.length >= limit) break;
                }
              }
            } catch {
              // Ignore unreadable files
            }
          }
        }
      };

      await walk(target);
      return { matches, totalMatches: matches.length };
    }

    if (invocation.name === "filesystem.write") {
      return await this.fileLockManager.acquireWriteLock(target, invocation.input.expectedContentHash, async () => {
        await this.ensureSafeParents(root, target);
        let existingMode: number | undefined;
        try {
          const stat = await lstat(target);
          if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in workspace paths");
          if (stat.nlink > 1) throw new Error("Hard-linked files cannot be written in a workspace");
          existingMode = stat.mode;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        if (existingMode !== undefined) {
          if (invocation.input.createOnly) throw Object.assign(new Error("The file already exists"), { code: "EEXIST" });
          const currentContent = await readFile(target, "utf8");
          const expected = invocation.input.expectedContentHash;
          if (!expected) {
            const error = new Error("Existing file replacement requires an expected content hash");
            (error as NodeJS.ErrnoException).code = "PRECONDITION_REQUIRED";
            throw error;
          }
          if (!matchesExpectedContentHash(currentContent, expected)) throw staleRevision();
        } else if (invocation.input.expectedContentHash) {
          throw staleRevision("STALE_REVISION: File no longer exists at the observed revision");
        }

        const tempPath = path.join(path.dirname(target), `.tmp.${randomUUID()}.${path.basename(target)}`);
        activeTempFiles.add(tempPath);
        try {
          await writeFile(tempPath, invocation.input.content, {
            encoding: "utf8",
            ...(existingMode !== undefined ? { mode: existingMode } : {}),
          });
          if (existingMode !== undefined) {
            try { await chmod(tempPath, existingMode); } catch { /* ignore */ }
          }
          if (invocation.input.createOnly) {
            await link(tempPath, target);
          } else {
            if (existingMode !== undefined) {
              const contentNow = await readFile(target, "utf8");
              if (!matchesExpectedContentHash(contentNow, invocation.input.expectedContentHash!)) throw staleRevision();
            } else {
              try {
                await lstat(target);
                throw staleRevision("STALE_REVISION: A file appeared before the new file could be committed");
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
            }
            await atomicRename(tempPath, target);
          }
        } finally {
          activeTempFiles.delete(tempPath);
          try { await unlink(tempPath); } catch { /* ignore */ }
        }

        const writtenHash = fileContentHash(invocation.input.content);
        this.onWriteCommitted?.(target, writtenHash);
        return { bytesWritten: Buffer.byteLength(invocation.input.content, "utf8"), contentHash: writtenHash };
      });
    }

    if (invocation.name === "filesystem.edit") {
      return await this.fileLockManager.acquireWriteLock(target, invocation.input.expectedContentHash, async () => {
        await this.ensureSafeParents(root, target);
        await this.assertNoSymlink(root, target, false);
        const metadata = await lstat(target);
        if (!metadata.isFile()) throw new Error("Only regular files can be edited");
        if (metadata.nlink > 1) throw new Error("Hard-linked files cannot be edited in a workspace");
        if (metadata.size > MAX_FILE_READ_BYTES) {
          throw new Error(`File exceeds the ${MAX_FILE_READ_BYTES} byte edit limit`);
        }

        const original = await readFile(target, "utf8");
        const fullHash = createHash("sha256").update(original).digest("hex");
        const shortHash = fullHash.slice(0, 16);

        if (invocation.input.expectedContentHash
          && invocation.input.expectedContentHash !== fullHash
          && invocation.input.expectedContentHash !== shortHash) {
          const err = new Error(`STALE_REVISION: File content hash (${shortHash}) does not match expectedContentHash (${invocation.input.expectedContentHash})`);
          (err as NodeJS.ErrnoException).code = "STALE_REVISION";
          throw err;
        }

        const edits = invocation.input.edits;
        if (!Array.isArray(edits) || edits.length === 0) {
          throw new Error("filesystem.edit requires a non-empty array of edits");
        }

        let content = original;
        for (const edit of edits) {
          const { oldText, newText, allowMultiple } = edit;
          if (typeof oldText !== "string" || oldText.length === 0) {
            throw new Error("oldText must be a non-empty string");
          }
          if (typeof newText !== "string") {
            throw new Error("newText must be a string");
          }

          // Count occurrences
          let count = 0;
          let pos = 0;
          while ((pos = content.indexOf(oldText, pos)) !== -1) {
            count++;
            pos += oldText.length;
          }

          if (count === 0) {
            const err = new Error(`TARGET_NOT_FOUND: Target text was not found in file: ${oldText.slice(0, 100)}`);
            (err as NodeJS.ErrnoException).code = "TARGET_NOT_FOUND";
            throw err;
          }
          if (count > 1 && !allowMultiple) {
            const err = new Error(`AMBIGUOUS_MATCH: Target text appears ${count} times; provide unique context or set allowMultiple: true`);
            (err as NodeJS.ErrnoException).code = "AMBIGUOUS_MATCH";
            throw err;
          }

          if (allowMultiple) {
            content = content.replaceAll(oldText, newText);
          } else {
            content = content.replace(oldText, newText);
          }
        }

        // Compute diff
        const diff = buildSimpleDiff(original, content);

        // Pre-commit validation: verify file on disk has not been altered since initial read (TOCTOU guard)
        const preCommitStat = await lstat(target);
        if (preCommitStat.isSymbolicLink()) {
          throw new Error("Symlinks are not allowed in workspace paths");
        }
        if (preCommitStat.mtimeMs !== metadata.mtimeMs || preCommitStat.size !== metadata.size) {
          const diskContentNow = await readFile(target, "utf8");
          if (diskContentNow !== original) {
            const err = new Error("STALE_REVISION: File was modified concurrently on disk before edit could be committed");
            (err as NodeJS.ErrnoException).code = "STALE_REVISION";
            throw err;
          }
        }

        // Atomic write with metadata preservation: write to temp file in same directory, then rename
        const tempPath = path.join(path.dirname(target), `.tmp.${randomUUID()}.${path.basename(target)}`);
        activeTempFiles.add(tempPath);
        try {
          await writeFile(tempPath, content, {
            encoding: "utf8",
            mode: metadata.mode,
          });
          try { await chmod(tempPath, metadata.mode); } catch { /* ignore */ }
          await atomicRename(tempPath, target);
        } finally {
          activeTempFiles.delete(tempPath);
          try { await unlink(tempPath); } catch { /* ignore */ }
        }

        const fullNewHash = createHash("sha256").update(content).digest("hex");
        const newHash = fullNewHash.slice(0, 16);
        this.onWriteCommitted?.(target, fullNewHash);
        return {
          bytesWritten: Buffer.byteLength(content, "utf8"),
          additions: diff.additions,
          deletions: diff.deletions,
          contentHash: newHash,
          diff: JSON.stringify(diff),
        };
      });
    }

    throw new Error(`Unsupported filesystem operation: ${(invocation as any).name}`);
  }

  private async runTerminal(
    invocation: Extract<ToolInvocation, { name: "terminal.execute" }>,
    root: string,
    beforeSpawn: () => Promise<Extract<ToolOutput, { readonly stdout: string }> | undefined>,
  ): Promise<Extract<ToolOutput, { readonly stdout: string }>> {
    const cwd = this.resolveContained(root, invocation.input.cwd ?? ".");
    await this.assertNoSymlink(root, cwd, false);
    const cwdStat = await lstat(cwd);
    if (!cwdStat.isDirectory()) throw new Error("Terminal working directory must be a directory");
    const parts = invocation.input.command.trim().split(/\s+/);
    const program = parts[0] || invocation.input.command;
    const extraArgs = (!invocation.input.args || invocation.input.args.length === 0) ? parts.slice(1) : [];
    const cleanEnv: Record<string, string | undefined> = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !isSensitiveEnvironmentName(name))),
      PWD: cwd,
    };
    delete cleanEnv.INIT_CWD;
    delete cleanEnv.npm_config_local_prefix;

    const recovered = await beforeSpawn();
    if (recovered) return recovered;
    return new Promise<Extract<ToolOutput, { readonly stdout: string }>>((resolve) => {

      const child = spawn(program, [...extraArgs, ...(invocation.input.args ?? [])], {
        cwd,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let cancelled = invocation.signal?.aborted ?? false;
      let quotaError: string | null = null;
      const subId = randomUUID();
      let cancellationSettlement: Promise<number> | undefined;
      const cancel = (retryAfterSpawn = false) => {
        cancelled = true;
        if (!this.subprocessSupervisor) {
          child.kill();
          return;
        }
        if (cancellationSettlement && !retryAfterSpawn) return;
        cancellationSettlement = this.subprocessSupervisor.terminateTaskSubprocesses(invocation.taskId);
        void cancellationSettlement.then(terminated => { if (terminated === 0) child.kill(); }, () => child.kill());
      };
      const abortListener = () => cancel();
      child.once("spawn", () => {
        if (this.subprocessSupervisor && child.pid) {
          try {
            this.subprocessSupervisor.register({
              id: subId,
              pid: child.pid,
              ...(process.platform !== "win32" ? { pgid: child.pid } : {}),
              command: invocation.input.command,
              taskId: invocation.taskId,
              workspaceId: this.permissionEngine?.getTaskContext(invocation.taskId)?.workspaceId ?? null,
              startedAt: Date.now(),
            });
          } catch (err) {
            quotaError = err instanceof Error ? err.message : String(err);
            child.kill();
            return;
          }
          if (cancelled) cancel(true);
        } else if (cancelled) cancel(true);
      });
      if (cancelled) cancel();
      else invocation.signal?.addEventListener("abort", abortListener, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        const remaining = MAX_CAPTURED_STREAM_BYTES - stdoutBytes;
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining);
          stdout.push(retained);
          stdoutBytes += retained.length;
        }
        if (chunk.length > remaining) stdoutTruncated = true;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = MAX_CAPTURED_STREAM_BYTES - stderrBytes;
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining);
          stderr.push(retained);
          stderrBytes += retained.length;
        }
        if (chunk.length > remaining) stderrTruncated = true;
      });
      child.once("error", (error) => {
        void (async () => {
          if (cancelled && cancellationSettlement) await cancellationSettlement;
          if (this.subprocessSupervisor) this.subprocessSupervisor.unregister(subId);
          invocation.signal?.removeEventListener("abort", abortListener);
          const launchErrorCode = typeof (error as NodeJS.ErrnoException).code === "string"
            ? (error as NodeJS.ErrnoException).code!.slice(0, 32) : "PROCESS_LAUNCH_FAILED";
          resolve({ stdout: Buffer.concat(stdout).toString(), stderr: `${Buffer.concat(stderr).toString()}${error.message}`,
            stdoutTruncated, stderrTruncated, exitCode: null, termination: cancelled ? "cancelled" : "exited",
            ...(!cancelled ? { launchErrorCode } : {}) });
        })();
      });
      child.once("close", (code, signal) => {
        void (async () => {
          if (cancelled && cancellationSettlement) await cancellationSettlement;
          if (this.subprocessSupervisor) this.subprocessSupervisor.unregister(subId);
          invocation.signal?.removeEventListener("abort", abortListener);
          const effectiveStderr = quotaError ? (Buffer.concat(stderr).toString() + `\n${quotaError}`) : Buffer.concat(stderr).toString();
          const effectiveExitCode = quotaError ? 1 : code;
          resolve({ stdout: Buffer.concat(stdout).toString(), stderr: effectiveStderr,
            stdoutTruncated, stderrTruncated, exitCode: effectiveExitCode, termination: (cancelled && !quotaError) ? "cancelled" : "exited",
            ...(!quotaError && signal ? { terminationSignal: signal } : {}) });
        })();
      });
    });
  }

  private resolveContained(root: string, candidate: string): string {
    if (candidate.includes("\0")) throw new PathEscapeForbiddenError("Path contains a NUL byte");
    if (path.isAbsolute(candidate) || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)
      || /^[A-Za-z]:/.test(candidate)) throw new PathEscapeForbiddenError("Absolute paths are not allowed");
    const components = candidate.split(/[\\/]+/);
    if (components.includes("..")) throw new PathEscapeForbiddenError("Path traversal is not allowed");
    const target = path.resolve(root, candidate);
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new PathEscapeForbiddenError("Path escapes the owned workspace");
    }
    return target;
  }

  private assertNonSensitivePath(root: string, target: string): void {
    const relative = path.relative(root, target);
    if ((relative ? relative.split(path.sep) : []).some(isSensitiveName)) {
      throw new Error("Credential and secret files are not available to Mediobot tools");
    }
  }

  private pathsOverlap(left: string, right: string): boolean {
    const inside = (parent: string, child: string): boolean => {
      const relative = path.relative(parent, child);
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    return inside(left, right) || inside(right, left);
  }

  private async assertNoSymlink(root: string, target: string, allowMissing: boolean): Promise<void> {
    const relative = path.relative(root, target);
    let current = root;
    for (const part of relative ? relative.split(path.sep) : []) {
      current = path.join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new PathEscapeForbiddenError("Symlinks are not allowed in workspace paths");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return;
        throw error;
      }
    }
    try {
      const realTarget = await realpath(target);
      const canonicalRoot = await realpath(root);
      const rel = path.relative(canonicalRoot, realTarget);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new PathEscapeForbiddenError("Path escapes the canonical project root");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return;
      if (error instanceof PathEscapeForbiddenError) throw error;
    }
  }

  private async ensureSafeParents(root: string, target: string): Promise<void> {
    const parent = path.dirname(target);
    const relativeParent = path.relative(root, parent);
    let current = root;
    for (const part of relativeParent ? relativeParent.split(path.sep) : []) {
      current = path.join(current, part);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new PathEscapeForbiddenError("Workspace parent is not a safe directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(current);
      }
    }
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new PathEscapeForbiddenError("Symlinks are not allowed in workspace paths");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // --- Web intelligence tools ---

  private validateWebContext(invocation: ToolInvocation): void {
    if (invocation.worldId !== this.world.id) throw new Error("Invocation belongs to another world");
    const snapshot = this.world.inspect();
    const worker = snapshot.workers.find((item) => item.id === invocation.workerId);
    const task = snapshot.tasks.find((item) => item.id === invocation.taskId);
    if (!worker || worker.state !== "busy") throw new Error("Worker is not active");
    if (!task || task.state !== "running" || task.assignedWorkerId !== worker.id) {
      throw new Error("Task is not running for this worker");
    }
    const def = snapshot.definitions.find((item) => item.id === worker.definitionId);
    const hasCapability = def && (
      def.declaredCapabilities.some(c => c.kind === "action" && (c.name === invocation.name || c.name === "web-intelligence"))
      || ["scraapy", "doc", "research"].includes(def.role)
      || ["scraapy", "doc", "research"].includes(def.id)
    );
    if (!hasCapability) {
      throw new Error(`Worker "${worker.id}" (${def?.name ?? worker.definitionId}) does not have capability for ${invocation.name}`);
    }
    if (invocation.name === "web.crawl" || invocation.name === "web.doc") {
      if (!invocation.input.url.startsWith("raw:")) {
        validateWebDestination(invocation.input.url);
      }
    }
  }

  private emitWebEvent(invocation: ToolInvocation, type: string, error?: string): void {
    if ((invocation as any).skipWorldLifecycleEvent) return;
    // Web tools emit events without resourceId (optional in EventInput).
    this.world.appendEvent({
      type,
      workerId: invocation.workerId,
      taskId: invocation.taskId,
      toolName: invocation.name,
      toolInvocationId: (invocation as any).toolInvocationId ?? (invocation as any).invocationId,
      ...(error ? { error } : {}),
    });
  }

  private async runWebIntelligence(
    invocation: Extract<ToolInvocation, { name: `web.${string}` }>,
    base: { invocationId: string; worldId: WorldId; workerId: WorkerId; taskId: TaskId; resourceId: ResourceId; toolName: ToolInvocation["name"] },
    control?: ToolExecutionControl,
  ): Promise<ToolResult> {
    const failureStage: ToolResult["failureStage"] = "web-intelligence";
    try {
      this.validateWebContext(invocation);
      if (invocation.name === "web.crawl" || invocation.name === "web.doc") {
        if (!invocation.input.url.startsWith("raw:")) {
          await validateWebDestinationAsync(invocation.input.url, {
            allowedDestinations: (invocation.input as any).allowedDestinations,
            allowLocalhost: (invocation.input as any).allowLocalhost,
          });
        }
      }

      if (this.permissionEngine) {
        const worker = this.world.inspect().workers.find((w) => w.id === invocation.workerId);
        const def = worker && this.world.inspect().definitions.find((d) => d.id === worker.definitionId);
        const workerName = def?.name ?? "Web Specialist";
        const auth = await this.permissionEngine.requestApproval(invocation, {
          workspaceRoot: process.cwd(),
          workerName,
          signal: invocation.signal,
          taskId: invocation.taskId,
          ...control,
        });
        if (!auth.ok) {
          if (auth.status === "cancelled") {
            this.emitWebEvent(invocation, "tool.cancelled");
            return { ...base, status: "cancelled", error: auth.reason ?? "Tool invocation was cancelled" };
          }
          this.emitWebEvent(invocation, "tool.failed", auth.reason ?? "Permission denied");
          return { ...base, failureStage, status: "failed", error: auth.reason ?? "Permission denied" };
        }
      }

      if (!this.webIntelligence) {
        throw new Error("Web intelligence is not configured for this runtime");
      }

      if (invocation.signal?.aborted) {
        this.emitWebEvent(invocation, "tool.cancelled");
        return { ...base, status: "cancelled", error: "Tool invocation was cancelled" };
      }

      this.emitWebEvent(invocation, "tool.started");

      let output: ToolOutput;

      if (invocation.name === "web.search") {
        const result = await this.webIntelligence.search(
          {
            query: invocation.input.query,
            maxResults: invocation.input.maxResults,
            allowedDomains: invocation.input.allowedDomains,
            filterType: invocation.input.filterType,
          },
          invocation.signal,
        );
        const webOut: WebSearchOutput = {
          query: result.query,
          totalMatches: result.totalMatches,
          ...(result.providerStatus ? { providerStatus: result.providerStatus } : {}),
          searchResults: result.items.map((item) => ({
            title: item.title,
            url: item.url,
            snippet: item.snippet,
            source: item.source,
          })),
        };
        output = webOut;
      } else {
        // web.crawl or web.doc
        const isDoc = invocation.name === "web.doc";
        const inputExtractOptions = "extractOptions" in invocation.input && invocation.input.extractOptions ? invocation.input.extractOptions : undefined;
        const crawlRequest: CrawlRequest = {
          url: invocation.input.url,
          taskId: invocation.taskId,
          allowedDestinations: (invocation.input as any).allowedDestinations,
          cacheMode: ("cacheMode" in invocation.input ? invocation.input.cacheMode : undefined) ?? "enabled",
          preferHttp: (typeof (invocation.input as any).preferHttp === "boolean" ? (invocation.input as any).preferHttp : undefined) ?? true,
          renderJs: (typeof (invocation.input as any).renderJs === "boolean" ? (invocation.input as any).renderJs : undefined) ?? false,
          extractOptions: inputExtractOptions ?? (isDoc ? {
            targetType: "documentation",
            extractMarkdown: true,
            cssSelector: ("cssSelector" in invocation.input ? invocation.input.cssSelector : undefined),
          } : {
            targetType: "general",
            extractMarkdown: true,
          }),
          ...("waitForSelector" in invocation.input && invocation.input.waitForSelector ? {
            waitForSelector: invocation.input.waitForSelector,
          } : {}),
        };
        const result = await this.webIntelligence.crawl(crawlRequest, invocation.signal);

        if (!result.success) {
          const errorMsg = result.errorMessage ?? "Web crawl failed";
          this.emitWebEvent(invocation, "tool.failed", errorMsg);
          return { ...base, failureStage, status: "failed", error: errorMsg };
        }

        const webOut: WebCrawlOutput = {
          url: result.url,
          finalUrl: result.finalUrl,
          title: result.title,
          markdown: result.markdown,
          sanitized: result.sanitized,
          promptInjectionFlags: result.promptInjectionFlags,
          provenance: result.provenance,
          cached: result.cached,
          durationMs: result.durationMs,
        };
        output = webOut;
      }

      if (invocation.signal?.aborted) {
        this.emitWebEvent(invocation, "tool.cancelled");
        return { ...base, status: "cancelled", error: "Tool invocation was cancelled" };
      }

      this.emitWebEvent(invocation, "tool.completed");
      return { ...base, status: "succeeded", output };
    } catch (error) {
      const status = invocation.signal?.aborted ? "cancelled" : "failed";
      let errorMsg = error instanceof Error ? error.message : String(error);
      if ((error as any)?.code === "STALE_REVISION" && !errorMsg.includes("STALE_REVISION")) {
        errorMsg = `STALE_REVISION: ${errorMsg}`;
      }
      try {
        this.emitWebEvent(invocation, status === "cancelled" ? "tool.cancelled" : "tool.failed", errorMsg);
      } catch { /* ignore */ }
      return { ...base, failureStage, status, error: errorMsg };
    }
  }
}

export interface WebDestinationSecurityOptions {
  readonly allowLocalhost?: boolean;
  readonly allowedDestinations?: ReadonlyArray<string>;
}

export function isIpAddressForbidden(ip: string): { forbidden: boolean; reason?: string } {
  const lowerIp = ip.toLowerCase().replace(/^\[|\]$/g, "");
  let ipv4Candidate = lowerIp;
  if (lowerIp.startsWith("::ffff:") || lowerIp.startsWith("0:0:0:0:0:ffff:")) {
    const rest = lowerIp.replace(/^(::ffff:|0:0:0:0:0:ffff:)/, "");
    if (net.isIPv4(rest)) {
      ipv4Candidate = rest;
    } else if (rest.includes(":")) {
      const hexWords = rest.split(":");
      const [w0, w1] = hexWords;
      if (hexWords.length === 2 && w0 !== undefined && w1 !== undefined) {
        const high = parseInt(w0, 16);
        const low = parseInt(w1, 16);
        if (!isNaN(high) && !isNaN(low)) {
          ipv4Candidate = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        }
      }
    }
  } else if (lowerIp.startsWith("::") && !lowerIp.includes(".") && lowerIp !== "::" && lowerIp !== "::1") {
    const rest = lowerIp.slice(2);
    const hexWords = rest.split(":");
    const [w0, w1] = hexWords;
    if (hexWords.length === 2 && w0 !== undefined && w1 !== undefined) {
      const high = parseInt(w0, 16);
      const low = parseInt(w1, 16);
      if (!isNaN(high) && !isNaN(low)) {
        ipv4Candidate = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      }
    }
  }

  if (net.isIPv4(ipv4Candidate)) {
    const parts = ipv4Candidate.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return { forbidden: true, reason: "Malformed IPv4 address" };
    }
    const [a, b, c, d] = parts as [number, number, number, number];
    // 0.0.0.0/8 (Current network)
    if (a === 0) return { forbidden: true, reason: "Current network (0.0.0.0/8) is forbidden" };
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return { forbidden: true, reason: "Loopback address (127.0.0.0/8) is forbidden" };
    // 10.0.0.0/8 (Private)
    if (a === 10) return { forbidden: true, reason: "Private address space (10.0.0.0/8) is forbidden" };
    // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return { forbidden: true, reason: "Private address space (172.16.0.0/12) is forbidden" };
    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return { forbidden: true, reason: "Private address space (192.168.0.0/16) is forbidden" };
    // 169.254.0.0/16 (Link-local & cloud metadata)
    if (a === 169 && b === 254) return { forbidden: true, reason: "Link-local / cloud metadata (169.254.0.0/16) is strictly forbidden" };
    // 100.64.0.0/10 (Shared address space / CGNAT)
    if (a === 100 && b >= 64 && b <= 127) return { forbidden: true, reason: "Shared address space / CGNAT (100.64.0.0/10) is forbidden" };
    // 192.0.0.0/24 (IETF protocol assignments)
    if (a === 192 && b === 0 && c === 0) return { forbidden: true, reason: "IETF protocol assignments (192.0.0.0/24) is forbidden" };
    // 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 0 && c === 2) return { forbidden: true, reason: "Documentation / TEST-NET-1 is forbidden" };
    // 198.18.0.0/15 (Network benchmark tests)
    if (a === 198 && (b === 18 || b === 19)) return { forbidden: true, reason: "Benchmark test network (198.18.0.0/15) is forbidden" };
    // 198.51.100.0/24 (TEST-NET-2)
    if (a === 198 && b === 51 && c === 100) return { forbidden: true, reason: "Documentation / TEST-NET-2 is forbidden" };
    // 203.0.113.0/24 (TEST-NET-3)
    if (a === 203 && b === 0 && c === 113) return { forbidden: true, reason: "Documentation / TEST-NET-3 is forbidden" };
    // 224.0.0.0/4 (Multicast)
    if (a >= 224 && a <= 239) return { forbidden: true, reason: "Multicast address space (224.0.0.0/4) is forbidden" };
    // 240.0.0.0/4 (Reserved / future use & broadcast)
    if (a >= 240) return { forbidden: true, reason: "Reserved / broadcast address space (240.0.0.0/4) is forbidden" };

    return { forbidden: false };
  }

  if (net.isIPv6(lowerIp)) {
    // ::1 (Loopback)
    if (lowerIp === "::1" || lowerIp === "0:0:0:0:0:0:0:1") return { forbidden: true, reason: "IPv6 loopback (::1) is forbidden" };
    // :: (Unspecified)
    if (lowerIp === "::" || lowerIp === "0:0:0:0:0:0:0:0") return { forbidden: true, reason: "IPv6 unspecified (::) is forbidden" };
    // fc00::/7 (Unique local address / ULA private)
    if (/^f[cd][0-9a-f]{2}:/i.test(lowerIp) || lowerIp.startsWith("fc") || lowerIp.startsWith("fd")) {
      return { forbidden: true, reason: "IPv6 unique local address (fc00::/7) is forbidden" };
    }
    // fe80::/10 (Link-local unicast)
    if (/^fe[89ab][0-9a-f]:/i.test(lowerIp) || lowerIp.startsWith("fe8") || lowerIp.startsWith("fe9") || lowerIp.startsWith("fea") || lowerIp.startsWith("feb")) {
      return { forbidden: true, reason: "IPv6 link-local address (fe80::/10) is forbidden" };
    }
    // ff00::/8 (Multicast)
    if (lowerIp.startsWith("ff")) return { forbidden: true, reason: "IPv6 multicast address (ff00::/8) is forbidden" };
    // 2001:db8::/32 (Documentation)
    if (lowerIp.startsWith("2001:db8:") || lowerIp.startsWith("2001:0db8:")) return { forbidden: true, reason: "IPv6 documentation network is forbidden" };
    // 100::/64 (Discard prefix)
    if (lowerIp.startsWith("100::")) return { forbidden: true, reason: "IPv6 discard prefix is forbidden" };

    return { forbidden: false };
  }

  return { forbidden: false };
}

function isCloudMetadataHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "169.254.169.254" ||
    h === "metadata.google.internal" ||
    h.endsWith(".internal") ||
    h.endsWith(".local") ||
    h.includes("169.254.169.254") ||
    h.includes("a9fe:a9fe") ||
    h === "instance-data"
  );
}

function isDestinationAllowed(url: URL, options?: WebDestinationSecurityOptions): boolean {
  if (!options) return false;
  const origin = `${url.protocol}//${url.host}`;
  const full = url.href;
  if (options.allowedDestinations) {
    for (const allowed of options.allowedDestinations) {
      if (!allowed) continue;
      const trimmed = allowed.trim();
      if (trimmed === full || trimmed === origin || full.startsWith(trimmed.endsWith("/") ? trimmed : `${trimmed}/`)) {
        return true;
      }
    }
  }
  return false;
}

export function validateWebDestination(rawUrl: string, options: WebDestinationSecurityOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid web URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Forbidden protocol "${parsed.protocol}"; only HTTP and HTTPS destinations are permitted`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) {
    throw new Error("Invalid web URL: missing host");
  }
  if (isCloudMetadataHost(host)) {
    throw new Error(`Access to private metadata service "${host}" is strictly forbidden`);
  }

  const allowed = isDestinationAllowed(parsed, options);
  if (allowed) {
    return parsed;
  }

  // Static IP literal check
  const ipCheck = isIpAddressForbidden(host);
  if (ipCheck.forbidden) {
    if (options.allowLocalhost && (host === "127.0.0.1" || host === "localhost" || host === "::1")) {
      return parsed;
    }
    throw new Error(`Access to private or local destination "${host}" is forbidden: ${ipCheck.reason}`);
  }

  if (host === "localhost" && !options.allowLocalhost) {
    throw new Error(`Access to private or local destination "${host}" is forbidden`);
  }

  return parsed;
}

export async function validateWebDestinationAsync(rawUrl: string, options: WebDestinationSecurityOptions = {}): Promise<URL & { validatedIp?: string }> {
  const parsed = validateWebDestination(rawUrl, options);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  const allowed = isDestinationAllowed(parsed, options);
  if (allowed) {
    return parsed;
  }

  if (options.allowLocalhost && (host === "localhost" || host === "127.0.0.1" || host === "::1")) {
    return parsed;
  }

  // RFC 2606 reserved testing and documentation domains are non-routable fixtures
  if (host.endsWith(".test") || host.endsWith(".example") || host.endsWith(".invalid")) {
    return parsed;
  }

  // Resolve DNS before network access and fail closed if resolution fails
  if (net.isIP(host) === 0) {
    try {
      const addresses = await dns.lookup(host, { all: true });
      if (!addresses || addresses.length === 0) {
        throw new Error(`DNS resolution returned no addresses for "${host}"`);
      }
      for (const addr of addresses) {
        const check = isIpAddressForbidden(addr.address);
        if (check.forbidden) {
          throw new Error(`Access to destination "${host}" is forbidden: resolves to private/loopback IP ${addr.address} (${check.reason})`);
        }
      }
      (parsed as any).validatedIp = addresses[0]?.address;
    } catch (err: any) {
      if (err.message && (err.message.includes("forbidden") || err.message.includes("no addresses"))) {
        throw err;
      }
      throw new Error(`DNS resolution failed for "${host}": ${err.message}`);
    }
  } else {
    const check = isIpAddressForbidden(host);
    if (check.forbidden) {
      throw new Error(`Access to private or local destination "${host}" is forbidden (${check.reason})`);
    }
    (parsed as any).validatedIp = host;
  }

  return parsed;
}

export function buildSimpleDiff(before: string, after: string): { additions: number; deletions: number; hunks: Array<{ header: string; lines: Array<{ type: "context" | "add" | "remove"; content: string }> }> } {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const n = oldLines.length;
  const m = newLines.length;
  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && oldLines[n - suffix - 1] === newLines[m - suffix - 1]) suffix += 1;
  const removed = oldLines.slice(prefix, n - suffix);
  const added = newLines.slice(prefix, m - suffix);
  return {
    additions: added.length,
    deletions: removed.length,
    hunks: [{
      header: `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
      lines: [
        ...removed.map((content) => ({ type: "remove" as const, content })),
        ...added.map((content) => ({ type: "add" as const, content })),
      ],
    }],
  };
}

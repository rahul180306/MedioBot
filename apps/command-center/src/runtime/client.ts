import type {
  IMediobotRuntime,
  RuntimeEvent,
  TurnOptions,
  WorkspaceStatus,
  WorkspaceSession,
  PersistedWorkspaceUIState,
  WorkspaceWatchEvent,
  RuntimeTaskSummary,
  RuntimeSpecialistGroupHistory,
} from "./types";
import type { FileNode, ProjectInfo, Thread } from "../types";
import { MockMediobotRuntime } from "./mockClient.ts";

type Listener = (event: RuntimeEvent) => void;
type WorkspaceListener = (event: {
  type: "state" | "fs";
  state?: { status: WorkspaceStatus; session: WorkspaceSession | null };
  fsEvents?: WorkspaceWatchEvent[];
}) => void;

interface ApiError { readonly error?: { readonly message?: string } }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const value = await response.json() as T & ApiError;
  if (!response.ok) throw new Error(value.error?.message ?? "The local Mediobot runtime could not complete the request.");
  return value;
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RuntimeEvent>;
  return typeof event.threadId === "string" && typeof event.turnId === "string"
    && typeof event.timestamp === "number" && typeof event.type === "string"
    && ["turn.snapshot", "agent.started", "agent.progress", "worker.assigned", "worker.message", "worker.started", "worker.progress", "worker.completed", "worker.failed", "worker.cancelled", "tool.started", "tool.progress", "tool.completed", "tool.failed", "tool.cancelled",
      "approval.required", "approval.resolved", "file.changed", "diff.created", "task.pause_requested", "task.paused", "task.resumed", "task.completed", "task.failed", "task.cancelled",
      "turn.completed", "turn.cancelled", "turn.failed"].includes(event.type)
    && Boolean(event.payload && typeof event.payload === "object");
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

/** Real backend client connecting to a live Mediobot V2 server over HTTP & SSE. */
export class MediobotRuntimeClient implements IMediobotRuntime {
  private readonly listeners = new Set<Listener>();
  private readonly workspaceListeners = new Set<WorkspaceListener>();
  private readonly streams = new Map<string, EventSource>();
  private workspaceEventSource: EventSource | null = null;

  getInitialProjects(): ProjectInfo[] { return []; }
  getInitialThreads(): Thread[] { return []; }

  async getWorkspace(): Promise<{ status: WorkspaceStatus; session: WorkspaceSession | null; uiState: PersistedWorkspaceUIState | null }> {
    return request<{ status: WorkspaceStatus; session: WorkspaceSession | null; uiState: PersistedWorkspaceUIState | null }>("/api/workspace");
  }

  async openWorkspace(path?: string): Promise<{ session?: WorkspaceSession; uiState?: PersistedWorkspaceUIState | null; cancelled: boolean }> {
    return request<{ session?: WorkspaceSession; uiState?: PersistedWorkspaceUIState | null; cancelled: boolean }>("/api/workspace/open", {
      method: "POST",
      body: JSON.stringify(path ? { path } : {}),
    });
  }

  async closeWorkspace(): Promise<void> {
    await request("/api/workspace/close", { method: "POST" });
  }

  async saveUIState(
    activeFile: string | null,
    openTabs: Array<{ path: string; name: string }>,
    expandedPaths: string[],
    workbenchTabs?: import('./types').PersistedWorkbenchTab[],
    activeWorkbenchTabId?: string | null
  ): Promise<void> {
    await request("/api/workspace/ui-state", {
      method: "PUT",
      body: JSON.stringify({ activeFile, openTabs, expandedPaths, workbenchTabs, activeWorkbenchTabId }),
    });
  }

  onWorkspaceEvent(listener: WorkspaceListener): () => void {
    this.workspaceListeners.add(listener);
    if (!this.workspaceEventSource && typeof window !== "undefined") {
      this.workspaceEventSource = new EventSource("/api/workspace/events");
      this.workspaceEventSource.addEventListener("workspace", (event) => {
        try {
          const parsed = JSON.parse(event.data);
          for (const l of this.workspaceListeners) {
            l(parsed);
          }
        } catch {
          // ignore
        }
      });
      this.workspaceEventSource.onerror = () => {
        // EventSource will auto-reconnect
      };
    }

    return () => {
      this.workspaceListeners.delete(listener);
      if (this.workspaceListeners.size === 0 && this.workspaceEventSource) {
        this.workspaceEventSource.close();
        this.workspaceEventSource = null;
      }
    };
  }

  async loadProjects(): Promise<ProjectInfo[]> {
    const result = await request<{ projects: ProjectInfo[] }>("/api/projects");
    return result.projects;
  }

  async loadThreads(workspaceId?: string | null): Promise<Thread[]> {
    const query = workspaceId !== undefined && workspaceId !== null
      ? `?workspaceId=${encodeURIComponent(workspaceId)}`
      : workspaceId === null
      ? `?workspaceId=`
      : "";
    const result = await request<{ threads: Thread[] }>(`/api/threads${query}`);
    return result.threads;
  }

  async loadThread(threadId: string): Promise<Thread> {
    const result = await request<{ thread: Thread }>(`/api/threads/${encodeURIComponent(threadId)}`);
    return result.thread;
  }

  async saveThread(thread: Thread): Promise<Thread> {
    const { turns: _turns, ...metadata } = thread;
    const result = await request<{ thread: Thread }>("/api/threads", {
      method: "POST",
      body: JSON.stringify({ thread: metadata }),
    });
    return result.thread;
  }

  async deleteThread(threadId: string): Promise<void> {
    await request(`/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    await request(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
  }

  async listFiles(projectId: string, path = ""): Promise<FileNode[]> {
    const result = await request<{ entries: FileNode[] }>(`/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`);
    return result.entries;
  }

  async readFile(projectId: string, path: string): Promise<string> {
    const result = await request<{ content: string }>(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`);
    return result.content;
  }

  async readFileVersioned(projectId: string, path: string): Promise<{ content: string; hash: string }> {
    return request<{ content: string; hash: string }>(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`);
  }

  async saveFile(projectId: string, path: string, content: string, expectedHash: string): Promise<string> {
    const result = await request<{ hash: string }>(`/api/projects/${encodeURIComponent(projectId)}/file`, {
      method: "PUT", body: JSON.stringify({ path, content, expectedHash }),
    });
    return result.hash;
  }

  async createFileEntry(projectId: string, parentPath: string, name: string, type: "file" | "folder"): Promise<void> {
    await request(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: "POST", body: JSON.stringify({ parentPath, name, type }),
    });
  }

  async renameFileEntry(projectId: string, path: string, name: string): Promise<void> {
    await request(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: "PATCH", body: JSON.stringify({ path, name }) });
  }

  async deleteFileEntry(projectId: string, path: string): Promise<void> {
    await request(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: "DELETE", body: JSON.stringify({ path }) });
  }

  async addProject(projectPath: string): Promise<ProjectInfo> {
    const res = await this.openWorkspace(projectPath);
    if (!res.session) throw new Error("Could not open workspace");
    return sessionToProject(res.session);
  }

  async pickProjectDirectory(preferredPath?: string): Promise<{ project?: ProjectInfo; cancelled: boolean }> {
    const res = await this.openWorkspace(preferredPath);
    if (res.cancelled || !res.session) {
      return { cancelled: true };
    }
    return { project: sessionToProject(res.session), cancelled: false };
  }

  async startTurn(threadId: string, prompt: string, options: TurnOptions, turnId = `turn-${Date.now()}`): Promise<string> {
    const effectiveEffort = options.reasoningEffort ?? options.modelSelection?.reasoningEffort;
    const bodyPayload = {
      turnId,
      threadId,
      prompt,
      modelSelection: options.modelSelection
        ? {
            ...options.modelSelection,
            ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}),
          }
        : undefined,
      assignmentModelSelections: options.assignmentModelSelections,
      reasoningEffort: effectiveEffort,
      specialistId: options.specialistId,
      definitionId: options.definitionId ?? "maestro",
      projectId: options.project?.id,
      recentHistory: options.recentHistory,
      attachments: options.attachments,
    };
    await request<{ turnId: string; taskId?: string; direct?: boolean; modelExecution?: { providerId: string; modelId: string } }>("/api/turns", { method: "POST", body: JSON.stringify(bodyPayload) });
    this.ensureTurnStream(threadId, turnId);
    return turnId;
  }

  resumeTurn(threadId: string, turnId: string): void {
    this.ensureTurnStream(threadId, turnId);
  }

  async pauseTask(taskId: string): Promise<void> {
    await request(`/api/tasks/${encodeURIComponent(taskId)}/pause`, { method: "POST", body: JSON.stringify({}) });
  }

  async resumeTask(taskId: string, threadId: string, turnId: string): Promise<void> {
    await request(`/api/tasks/${encodeURIComponent(taskId)}/resume`, { method: "POST", body: JSON.stringify({}) });
    this.ensureTurnStream(threadId, turnId);
  }

  async uploadAttachment(file: { readonly name: string; readonly type: string; readonly base64: string }): Promise<import("../types").TurnAttachment> {
    const result = await request<{ attachment: import("../types").TurnAttachment }>("/api/attachments", { method: "POST", body: JSON.stringify(file) });
    return result.attachment;
  }

  async removeAttachment(id: string): Promise<void> {
    await request(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async getProviderCatalog(): Promise<any[]> {
    const res = await request<{ catalog: any[] }>("/api/providers/catalog");
    return res.catalog;
  }

  async getDefinitions(): Promise<any[]> {
    const res = await request<{ definitions: any[] }>("/api/definitions");
    return res.definitions;
  }

  async getTasks(): Promise<RuntimeTaskSummary[]> {
    const res = await request<{ tasks: RuntimeTaskSummary[] }>("/api/tasks");
    return res.tasks;
  }

  async getSpecialistGroupHistory(specialistId: string): Promise<RuntimeSpecialistGroupHistory[]> {
    const res = await request<{ groups: RuntimeSpecialistGroupHistory[] }>(`/api/specialists/${encodeURIComponent(specialistId)}/group-history`);
    return res.groups;
  }

  async getConnectedProviders(): Promise<any[]> {
    const res = await request<{ providers: any[] }>("/api/providers");
    return res.providers;
  }

  async connectProvider(data: any): Promise<any> {
    const res = await request<{ provider: any }>("/api/providers/connect", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return res.provider;
  }

  async disconnectProvider(id: string): Promise<boolean> {
    const res = await request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return res.ok;
  }

  async toggleProvider(id: string, enabled: boolean): Promise<boolean> {
    const res = await request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    return res.ok;
  }

  async toggleModel(providerId: string, modelId: string, enabled: boolean): Promise<boolean> {
    const res = await request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    return res.ok;
  }

  async getEnabledModels(): Promise<any[]> {
    const res = await request<{ models: any[] }>("/api/models/enabled");
    return res.models;
  }

  async updateThreadModel(threadId: string, modelSelection: import("../types").ThreadModelSelection | null, modelName?: string): Promise<void> {
    await request(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection, model: modelName }),
    });
  }

  async respondToApproval(turnId: string, approvalId: string, approved: boolean): Promise<void> {
    await request(`/api/turns/${encodeURIComponent(turnId)}/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      body: JSON.stringify({ approved }),
    });
  }

  async cancelTurn(threadId: string, turnId: string): Promise<void> {
    const query = new URLSearchParams({ threadId });
    await request(`/api/turns/${encodeURIComponent(turnId)}/cancel?${query}`, { method: "POST" });
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private ensureTurnStream(threadId: string, turnId: string): void {
    const identityKey = JSON.stringify([threadId, turnId]);
    if (this.streams.has(identityKey)) return;
    const query = new URLSearchParams({ threadId });
    const stream = new EventSource(`/api/turns/${encodeURIComponent(turnId)}/events?${query}`);
    this.streams.set(identityKey, stream);
    stream.addEventListener("mediobot", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (isRuntimeEvent(payload)) {
          for (const listener of this.listeners) listener(payload);
          if (["task.completed", "task.failed", "task.cancelled", "task.paused", "turn.completed", "turn.failed", "turn.cancelled"].includes(payload.type)) {
            stream.close();
            this.streams.delete(identityKey);
          }
        }
      } catch { /* malformed payloads are dropped */ }
    });
    stream.onerror = () => {
      // EventSource owns transient reconnection and sends Last-Event-ID. Closing
      // here would convert every temporary outage into permanent disconnection.
    };
  }
}

/**
 * Flag determining whether to use the standalone synthetic mock runtime or connect to a real backend.
 * Connected to live MedioBot V2 backend by default.
 */
export const USE_MOCK_RUNTIME = false;

export const runtimeInstance: IMediobotRuntime = USE_MOCK_RUNTIME
  ? new MockMediobotRuntime()
  : new MediobotRuntimeClient();

export { MockMediobotRuntime };

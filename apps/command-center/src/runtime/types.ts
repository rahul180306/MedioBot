import type {
  ApprovalMode,
  ApprovalRequestData,
  ComputerActionData,
  FileDiff,
  FileNode,
  ModelOption,
  PerceptionData,
  ProjectInfo,
  Thread,
  ThreadItem,
  Turn,
  ToolExecutionData,
  AgentActivityState,
} from "../types";

export type WorkspaceStatus = "EMPTY" | "OPENING" | "OPEN" | "SWITCHING" | "UNAVAILABLE";

export interface WorkspaceSession {
  readonly workspaceId: string;
  readonly canonicalRootPath: string;
  readonly displayName: string;
  readonly openedAt: number;
}

export interface PersistedWorkbenchTab {
  readonly id: string;
  readonly kind: 'file' | 'chat';
  readonly path?: string;
  readonly name?: string;
  readonly threadId?: string;
  readonly title?: string;
}

export interface PersistedWorkspaceUIState {
  readonly workspaceId: string;
  readonly activeFile: string | null;
  readonly openTabs: readonly { readonly path: string; readonly name: string }[];
  readonly expandedPaths: readonly string[];
  readonly updatedAt: number;
  readonly workbenchTabs: readonly PersistedWorkbenchTab[];
  readonly activeWorkbenchTabId: string | null;
}

import type { WorkspaceWatchEvent } from "@mediobot-v2/contracts";
export type { WorkspaceWatchEvent };

export interface RuntimeEvent {
  id?: string;
  sequence?: number;
  type: string;
  threadId: string;
  turnId: string;
  timestamp: number;
  workerId?: string;
  workerDefinitionId?: string;
  workerName?: string;
  taskId?: string;
  executionTaskId?: string;
  payload: {
    activityState?: AgentActivityState;
    message?: string;
    item?: ThreadItem;
    tool?: ToolExecutionData;
    diff?: FileDiff;
    approval?: ApprovalRequestData;
    computerAction?: ComputerActionData;
    perception?: PerceptionData;
    summary?: string;
    turn?: Turn;
  };
}

export interface RuntimeTaskSummary {
  readonly id: string;
  readonly state: string;
  readonly goal: string;
  readonly assignedMediobot?: { readonly id: string; readonly name: string };
  readonly events?: ReadonlyArray<{
    readonly id?: string;
    readonly sequence?: number;
    readonly type?: string;
    readonly occurredAt: number;
    readonly workerDefinitionId?: string;
    readonly workerName?: string;
    readonly message?: string;
    readonly toolName?: string;
    readonly command?: string;
    readonly workingDirectory?: string;
    readonly errorCode?: string;
    readonly exitCode?: number | null;
    readonly terminationSignal?: string;
    readonly recoveryReason?: string;
    readonly activityState?: AgentActivityState;
  }>;
  readonly evidence?: ReadonlyArray<{ readonly id?: string; readonly kind?: string; readonly validity?: string; readonly artifactReference?: string }>;
  readonly artifacts?: ReadonlyArray<{ readonly id: string; readonly mediobotId: string; readonly name: string; readonly reference: string; readonly contentHash: string }>;
}

export interface RuntimeSpecialistGroupHistory {
  readonly taskId: string;
  readonly taskGoal: string;
  readonly groupId: string;
  readonly status: "active" | "completed" | "cancelled" | "failed";
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly sequenceNumber: number;
    readonly senderSpecialistId: string;
    readonly senderName: string;
    readonly kind: "finding" | "request";
    readonly content: string;
    readonly evidenceRefs: ReadonlyArray<string>;
    readonly createdAt: number;
  }>;
  /** Private inbox items delivered to this specialist within this task scope. */
  readonly privateMessages?: ReadonlyArray<{
    readonly id: string;
    readonly sequenceNumber: number;
    readonly senderSpecialistId: string;
    readonly senderName: string;
    readonly kind: "request" | "finding" | "response";
    readonly deliveryStatus: string;
    readonly content: string;
    readonly evidenceRefs: ReadonlyArray<string>;
    readonly createdAt: number;
  }>;
}

export interface TurnOptions {
  model: ModelOption;
  modelSelection?: import("../types").ThreadModelSelection;
  /** Provider-qualified preferences for registered specialists when Maestro delegates this turn. */
  assignmentModelSelections?: Readonly<Record<string, import("../types").ThreadModelSelection>>;
  reasoningEffort?: "low" | "medium" | "high" | "extra" | "max";
  /** Explicit selected Mediobot identity for an individual specialist conversation. */
  specialistId?: string;
  approvalMode: ApprovalMode;
  project: ProjectInfo;
  branch: string;
  definitionId?: string;
  recentHistory?: ReadonlyArray<{ readonly user: string; readonly assistant?: string }>;
  attachments?: ReadonlyArray<import("../types").TurnAttachment>;
}

export interface IMediobotRuntime {
  startTurn(threadId: string, prompt: string, options: TurnOptions, turnId?: string): Promise<string>;
  resumeTurn?(threadId: string, turnId: string): void;
  resumeTask?(taskId: string, threadId: string, turnId: string): Promise<void>;
  pauseTask?(taskId: string): Promise<void>;
  uploadAttachment(file: { readonly name: string; readonly type: string; readonly base64: string }): Promise<import("../types").TurnAttachment>;
  removeAttachment(id: string): Promise<void>;
  respondToApproval(turnId: string, approvalId: string, approved: boolean): Promise<void>;
  cancelTurn(threadId: string, turnId: string): Promise<void>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  getInitialProjects(): ProjectInfo[];
  getInitialThreads(): Thread[];
  loadProjects(): Promise<ProjectInfo[]>;
  loadThreads(workspaceId?: string | null): Promise<Thread[]>;
  loadThread?(threadId: string): Promise<Thread>;
  saveThread(thread: Thread): Promise<Thread>;
  deleteThread(threadId: string): Promise<void>;
  renameThread(threadId: string, title: string): Promise<void>;
  listFiles(projectId: string, path?: string): Promise<FileNode[]>;
  readFile(projectId: string, path: string): Promise<string>;
  readFileVersioned(projectId: string, path: string): Promise<{ content: string; hash: string }>;
  saveFile(projectId: string, path: string, content: string, expectedHash: string): Promise<string>;
  createFileEntry(projectId: string, parentPath: string, name: string, type: "file" | "folder"): Promise<void>;
  renameFileEntry(projectId: string, path: string, name: string): Promise<void>;
  deleteFileEntry(projectId: string, path: string): Promise<void>;
  addProject(path: string): Promise<ProjectInfo>;
  pickProjectDirectory(path?: string): Promise<{ project?: ProjectInfo; cancelled: boolean }>;
  getWorkspace(): Promise<{ status: WorkspaceStatus; session: WorkspaceSession | null; uiState: PersistedWorkspaceUIState | null }>;
  openWorkspace(path?: string): Promise<{ session?: WorkspaceSession; uiState?: PersistedWorkspaceUIState | null; cancelled: boolean }>;
  closeWorkspace(): Promise<void>;
  saveUIState(
    activeFile: string | null,
    openTabs: Array<{ path: string; name: string }>,
    expandedPaths: string[],
    workbenchTabs?: PersistedWorkbenchTab[],
    activeWorkbenchTabId?: string | null
  ): Promise<void>;
  onWorkspaceEvent(listener: (event: { type: "state" | "fs"; state?: { status: WorkspaceStatus; session: WorkspaceSession | null }; fsEvents?: WorkspaceWatchEvent[] }) => void): () => void;
  getConnectedProviders(): Promise<any[]>;
  getProviderCatalog(): Promise<any[]>;
  getDefinitions(): Promise<any[]>;
  getTasks(): Promise<RuntimeTaskSummary[]>;
  getSpecialistGroupHistory(specialistId: string): Promise<RuntimeSpecialistGroupHistory[]>;
  connectProvider(data: any): Promise<any>;
  disconnectProvider(id: string): Promise<boolean>;
  toggleProvider(id: string, enabled: boolean): Promise<boolean>;
  toggleModel(providerId: string, modelId: string, enabled: boolean): Promise<boolean>;
  getEnabledModels(): Promise<any[]>;
  updateThreadModel(threadId: string, modelSelection: import("../types").ThreadModelSelection | null, modelName?: string): Promise<void>;
}

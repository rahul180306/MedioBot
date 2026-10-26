import type {
  IMediobotRuntime,
  RuntimeEvent,
  TurnOptions,
  WorkspaceStatus,
  WorkspaceSession,
  PersistedWorkspaceUIState,
  WorkspaceWatchEvent,
  PersistedWorkbenchTab,
} from './types';
import type {
  FileNode,
  ProjectInfo,
  Thread,
  Turn,
  ThreadItem,
  TurnAttachment,
  ProviderConfig,
  CatalogProviderItem,
} from '../types';
import {
  MOCK_SESSION,
  MOCK_PROJECTS,
  MOCK_FILES,
  MOCK_FILE_NODES,
  MOCK_THREADS,
  MOCK_PROVIDERS,
  MOCK_CATALOG,
  MOCK_DEFINITIONS,
} from './mockData.ts';

type Listener = (event: RuntimeEvent) => void;
type WorkspaceListener = (event: {
  type: 'state' | 'fs';
  state?: { status: WorkspaceStatus; session: WorkspaceSession | null };
  fsEvents?: WorkspaceWatchEvent[];
}) => void;

/**
 * MockMediobotRuntime
 *
 * Full in-memory demonstration runtime for the MedioBot V2 Frontend UI.
 * Allows testing and redesigning all UI surfaces (workbench, file explorer,
 * code editor, chat timeline, live execution cards, diff viewers, and settings)
 * without requiring the live Node.js/SQLite MedioBot backend.
 */
export class MockMediobotRuntime implements IMediobotRuntime {
  private readonly listeners = new Set<Listener>();
  private readonly workspaceListeners = new Set<WorkspaceListener>();

  private projects: ProjectInfo[] = [...MOCK_PROJECTS];
  private threads: Thread[] = JSON.parse(JSON.stringify(MOCK_THREADS));
  private files: Record<string, string> = { ...MOCK_FILES };
  private fileNodes: FileNode[] = JSON.parse(JSON.stringify(MOCK_FILE_NODES));
  private providers: ProviderConfig[] = JSON.parse(JSON.stringify(MOCK_PROVIDERS));
  private session: WorkspaceSession | null = { ...MOCK_SESSION };
  private status: WorkspaceStatus = 'OPEN';
  private uiState: PersistedWorkspaceUIState | null = (() => {
    try {
      const saved = localStorage.getItem('mediobot_runtime_ui_state');
      if (saved) {
        const parsed = JSON.parse(saved);
        const savedTabId = localStorage.getItem('mediobot_active_workbench_tab_id');
        if (savedTabId) {
          parsed.activeWorkbenchTabId = savedTabId;
        }
        return parsed;
      }
    } catch {
      // ignore
    }
    const savedActiveTabId = (() => {
      try {
        return localStorage.getItem('mediobot_active_workbench_tab_id');
      } catch {
        return null;
      }
    })();
    const savedTabs = (() => {
      try {
        const raw = localStorage.getItem('mediobot_workbench_tabs');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      } catch {
        // ignore
      }
      return null;
    })();

    const initialTabs = savedTabs ?? [
      { id: 'tab-chat-1', kind: 'chat' as const, threadId: 'thread-demo-1', title: 'Fix calculator division by zero defect' },
      { id: 'tab-file-1', kind: 'file' as const, path: 'src/calculator.js', name: 'calculator.js' },
    ];

    return {
      workspaceId: MOCK_SESSION.workspaceId,
      activeFile: 'src/calculator.js',
      openTabs: [{ path: 'src/calculator.js', name: 'calculator.js' }],
      expandedPaths: ['src', 'tests'],
      updatedAt: Date.now(),
      workbenchTabs: initialTabs,
      activeWorkbenchTabId: savedActiveTabId || initialTabs[0]?.id || 'tab-chat-1',
    };
  })();

  setCustomWorkspace(folderName: string, nodes: FileNode[], fileContents?: Record<string, string>): void {
    this.fileNodes = nodes;
    if (fileContents) {
      this.files = { ...this.files, ...fileContents };
    }
    this.session = {
      workspaceId: `workspace-${Date.now()}`,
      canonicalRootPath: `/workspace/${folderName}`,
      displayName: folderName,
      openedAt: Date.now(),
    };
    this.status = 'OPEN';
    this.notifyWorkspaceState();
  }

  private activeSimulationTimeouts: NodeJS.Timeout[] = [];

  getInitialProjects(): ProjectInfo[] {
    return this.projects;
  }

  getInitialThreads(): Thread[] {
    const seen = new Set<string>();
    return this.threads.filter((t) => {
      if (!t.id || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }

  async getWorkspace(): Promise<{
    status: WorkspaceStatus;
    session: WorkspaceSession | null;
    uiState: PersistedWorkspaceUIState | null;
  }> {
    return {
      status: this.status,
      session: this.session,
      uiState: this.uiState,
    };
  }

  async openWorkspace(path?: string): Promise<{
    session?: WorkspaceSession;
    uiState?: PersistedWorkspaceUIState | null;
    cancelled: boolean;
  }> {
    this.status = 'OPEN';
    const folderName = path ? path.split('/').filter(Boolean).pop() ?? 'project' : 'mediobot-demo';
    this.session = {
      workspaceId: `workspace-${Date.now()}`,
      canonicalRootPath: path ?? '/workspace/mediobot-demo',
      displayName: folderName,
      openedAt: Date.now(),
    };
    this.notifyWorkspaceState();
    return { session: this.session, uiState: this.uiState, cancelled: false };
  }

  async closeWorkspace(): Promise<void> {
    this.status = 'EMPTY';
    this.session = null;
    this.notifyWorkspaceState();
  }

  async saveUIState(
    activeFile: string | null,
    openTabs: Array<{ path: string; name: string }>,
    expandedPaths: string[],
    workbenchTabs?: PersistedWorkbenchTab[],
    activeWorkbenchTabId?: string | null
  ): Promise<void> {
    if (!this.session) return;
    this.uiState = {
      workspaceId: this.session.workspaceId,
      activeFile,
      openTabs,
      expandedPaths,
      updatedAt: Date.now(),
      workbenchTabs: workbenchTabs ?? [],
      activeWorkbenchTabId: activeWorkbenchTabId ?? null,
    };
    try {
      localStorage.setItem('mediobot_runtime_ui_state', JSON.stringify(this.uiState));
      if (activeWorkbenchTabId) {
        localStorage.setItem('mediobot_active_workbench_tab_id', activeWorkbenchTabId);
      }
    } catch {
      // ignore
    }
  }

  onWorkspaceEvent(listener: WorkspaceListener): () => void {
    this.workspaceListeners.add(listener);
    return () => {
      this.workspaceListeners.delete(listener);
    };
  }

  private notifyWorkspaceState(): void {
    for (const listener of this.workspaceListeners) {
      listener({
        type: 'state',
        state: { status: this.status, session: this.session },
      });
    }
  }

  async loadProjects(): Promise<ProjectInfo[]> {
    return this.projects;
  }

  async loadThreads(_workspaceId?: string | null): Promise<Thread[]> {
    const seen = new Set<string>();
    return this.threads.filter((t) => {
      if (!t.id || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }

  async loadThread(threadId: string): Promise<Thread> {
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error("Thread not found");
    return thread;
  }

  async saveThread(thread: Thread): Promise<Thread> {
    const idx = this.threads.findIndex((t) => t.id === thread.id);
    if (idx >= 0) {
      this.threads[idx] = thread;
    } else {
      this.threads.unshift(thread);
    }
    return thread;
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threads = this.threads.filter((t) => t.id !== threadId);
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    const thread = this.threads.find((t) => t.id === threadId);
    if (thread) {
      thread.title = title;
    }
  }

  async listFiles(_projectId: string, _path = ''): Promise<FileNode[]> {
    return this.fileNodes;
  }

  async readFile(_projectId: string, path: string): Promise<string> {
    return this.files[path] ?? `// File: ${path}\n// [Mock file content]`;
  }

  async readFileVersioned(projectId: string, path: string): Promise<{ content: string; hash: string }> {
    const content = await this.readFile(projectId, path);
    return { content, hash: `mock-hash-${content.length}` };
  }

  async saveFile(_projectId: string, path: string, content: string, _expectedHash: string): Promise<string> {
    this.files[path] = content;
    return `mock-hash-${content.length}`;
  }

  async createFileEntry(_projectId: string, parentPath: string, name: string, type: 'file' | 'folder'): Promise<void> {
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    if (type === 'file') {
      this.files[fullPath] = `// ${name}\n`;
    }
    const newNode: FileNode = { name, path: fullPath, type, children: type === 'folder' ? [] : undefined };
    this.fileNodes.push(newNode);
  }

  async renameFileEntry(_projectId: string, path: string, name: string): Promise<void> {
    if (this.files[path]) {
      const content = this.files[path];
      delete this.files[path];
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const newPath = dir ? `${dir}/${name}` : name;
      this.files[newPath] = content;
    }
  }

  async deleteFileEntry(_projectId: string, path: string): Promise<void> {
    delete this.files[path];
    this.fileNodes = this.fileNodes.filter((node) => node.path !== path);
  }

  async addProject(projectPath: string): Promise<ProjectInfo> {
    const name = projectPath.split('/').filter(Boolean).pop() ?? 'new-project';
    const project: ProjectInfo = {
      id: `project-${Date.now()}`,
      name,
      path: projectPath,
      branch: 'main',
      branches: ['main'],
      environment: 'Local',
    };
    this.projects.push(project);
    return project;
  }

  async pickProjectDirectory(preferredPath?: string): Promise<{ project?: ProjectInfo; cancelled: boolean }> {
    const proj = await this.addProject(preferredPath ?? '/workspace/new-mock-project');
    return { project: proj, cancelled: false };
  }

  async uploadAttachment(file: { readonly name: string; readonly type: string; readonly base64: string }): Promise<TurnAttachment> {
    return {
      id: `att-${Date.now()}`,
      name: file.name,
      mimeType: file.type,
      size: Math.round(file.base64.length * 0.75),
    };
  }

  async removeAttachment(_id: string): Promise<void> {}

  async respondToApproval(_turnId: string, _approvalId: string, _approved: boolean): Promise<void> {}

  async cancelTurn(threadId: string, turnId: string): Promise<void> {
    this.clearSimulations();
    this.emitEvent({
      type: 'turn.cancelled',
      threadId,
      turnId,
      timestamp: Date.now(),
      payload: { message: 'Turn was cancelled by user.' },
    });
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitEvent(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Mock runtime listener error:', err);
      }
    }
  }

  private clearSimulations(): void {
    for (const t of this.activeSimulationTimeouts) {
      clearTimeout(t);
    }
    this.activeSimulationTimeouts = [];
  }

  /**
   * Simulates realistic live execution turn with streaming step cards,
   * tool execution cards, verified badges, diff view, and assistant summary.
   */
  async startTurn(
    threadId: string,
    prompt: string,
    _options: TurnOptions,
    turnId = `turn-${Date.now()}`
  ): Promise<string> {
    this.clearSimulations();

    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread) {
      const newThread: Thread = {
        id: threadId,
        title: prompt.slice(0, 40) || 'New chat',
        projectId: this.session?.workspaceId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: 'MiniMax-M2.7',
        branch: 'main',
        approvalMode: 'Approve for me',
        turns: [],
      };
      this.threads.unshift(newThread);
    }

    const schedule = (ms: number, fn: () => void) => {
      const timer = setTimeout(fn, ms);
      this.activeSimulationTimeouts.push(timer);
    };

    // Step 0: User prompt already added in AppContext.
    // Step 1 (150ms): Maestro orchestration assignment
    schedule(150, () => {
      this.emitEvent({
        type: 'agent.progress',
        threadId,
        turnId,
        timestamp: Date.now(),
        payload: {
          item: {
            id: `msg-maestro-${Date.now()}`,
            turnId,
            type: 'agent_message',
            actor: { type: 'mediobot', name: 'Maestro', role: 'Team orchestration' },
            timestamp: Date.now(),
            text: 'Analyzing prompt and delegating task to Cody for implementation and verification.',
          },
        },
      });
    });

    // Step 2 (400ms): Cody activity step (inspecting)
    schedule(400, () => {
      this.emitEvent({
        type: 'agent.progress',
        threadId,
        turnId,
        timestamp: Date.now(),
        payload: {
          item: {
            id: `act-1-${Date.now()}`,
            turnId,
            type: 'activity',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now(),
            activityState: 'inspecting',
            activityLabel: 'Inspecting workspace files',
            text: 'Cody inspected workspace files',
          },
        },
      });
    });

    // Step 3 (700ms): Tool started (filesystem.read)
    schedule(700, () => {
      this.emitEvent({
        type: 'tool.started',
        threadId,
        turnId,
        timestamp: Date.now(),
        payload: {
          item: {
            id: `tool-read-${Date.now()}`,
            turnId,
            type: 'tool_execution',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now(),
            text: 'filesystem.read src/calculator.js',
            tool: {
              toolName: 'filesystem.read',
              command: 'filesystem.read src/calculator.js',
              status: 'running',
              startedAt: Date.now(),
              outcomeBadge: 'running',
            },
          },
        },
      });
    });

    // Step 4 (1000ms): Tool completed (filesystem.read)
    schedule(1000, () => {
      this.emitEvent({
        type: 'tool.completed',
        threadId,
        turnId,
        timestamp: Date.now(),
        payload: {
          item: {
            id: `tool-read-${Date.now()}`,
            turnId,
            type: 'tool_execution',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now(),
            text: 'filesystem.read src/calculator.js',
            tool: {
              toolName: 'filesystem.read',
              command: 'filesystem.read src/calculator.js',
              status: 'success',
              startedAt: Date.now() - 300,
              durationMs: 300,
              outcomeBadge: 'success',
            },
          },
        },
      });
    });

    // Step 5 (1300ms): File diff created
    schedule(1300, () => {
      this.emitEvent({
        type: 'diff.created',
        threadId,
        turnId,
        timestamp: Date.now(),
        payload: {
          item: {
            id: `diff-${Date.now()}`,
            turnId,
            type: 'diff',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now(),
            diff: {
              filePath: 'src/calculator.js',
              additions: 3,
              deletions: 0,
              hunks: [
                {
                  oldStart: 13,
                  oldLines: 2,
                  newStart: 13,
                  newLines: 5,
                  lines: [
                    { type: 'context', content: 'export function divide(a, b) {' },
                    { type: 'add', content: '  if (b === 0) {' },
                    { type: 'add', content: "    throw new Error('Division by zero is not allowed');" },
                    { type: 'add', content: '  }' },
                    { type: 'context', content: '  return a / b;' },
                  ],
                },
              ],
            },
          },
        },
      });
    });

    // Step 6 (1600ms): Verification tool started (terminal.execute)
    schedule(1600, () => {
      this.emitEvent({
        type: 'tool.started',
        threadId,
        turnId,
        timestamp: Date.now(),
        payload: {
          item: {
            id: `tool-test-${Date.now()}`,
            turnId,
            type: 'tool_execution',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now(),
            text: 'terminal.execute node --test tests/calculator.test.js',
            tool: {
              toolName: 'terminal.execute',
              command: 'node --test tests/calculator.test.js',
              status: 'running',
              startedAt: Date.now(),
              isVerification: true,
              outcomeBadge: 'running',
            },
          },
        },
      });
    });

    // Step 7 (1900ms): Verification tool completed with exit 0
    schedule(1900, () => {
      this.emitEvent({
        type: 'tool.completed',
        threadId,
        turnId,
        timestamp: Date.now(),
        payload: {
          item: {
            id: `tool-test-${Date.now()}`,
            turnId,
            type: 'tool_execution',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now(),
            text: 'terminal.execute node --test tests/calculator.test.js',
            tool: {
              toolName: 'terminal.execute',
              command: 'node --test tests/calculator.test.js',
              status: 'success',
              startedAt: Date.now() - 300,
              durationMs: 300,
              isVerification: true,
              verificationStatus: 'command-succeeded',
              outcomeBadge: '✓ verified (exit 0)',
              outputLog: '✔ calculator arithmetic operations (1.2ms)\n✔ divide by zero guard (0.8ms)\n\nℹ tests 2\nℹ suites 0\nℹ pass 2\nℹ fail 0\nℹ duration_ms 42.1',
            },
          },
        },
      });
    });

    // Step 8 (2200ms): Assistant response message
    schedule(2200, () => {
      this.emitEvent({
        type: 'agent.progress',
        threadId,
        turnId,
        timestamp: Date.now(),
        payload: {
          item: {
            id: `msg-cody-${Date.now()}`,
            turnId,
            type: 'agent_message',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now(),
            text: `[Simulated Live Execution]\n\nTask "${prompt}" completed successfully. All unit tests passed deterministically with exit code 0.`,
          },
        },
      });
    });

    // Step 9 (2400ms): Turn completed
    schedule(2400, () => {
      this.emitEvent({
        type: 'turn.completed',
        threadId,
        turnId,
        timestamp: Date.now(),
        payload: { summary: 'Turn completed successfully' },
      });
    });

    return turnId;
  }

  // Provider & Model management methods
  async getProviders(): Promise<ProviderConfig[]> {
    return this.providers;
  }

  async getCatalog(): Promise<CatalogProviderItem[]> {
    return MOCK_CATALOG;
  }

  async getEnabledModels(): Promise<any[]> {
    const list: any[] = [];
    for (const p of this.providers) {
      if (p.connected && p.enabled) {
        for (const m of p.models) {
          if (m.enabled) {
            list.push({
              id: m.id,
              name: m.name,
              providerId: p.id,
              providerName: p.name,
              badge: p.badge,
              tag: m.tag,
              description: m.description,
            });
          }
        }
      }
    }
    return list;
  }

  async getConnectedProviders(): Promise<any[]> {
    return this.providers;
  }

  async getProviderCatalog(): Promise<any[]> {
    return MOCK_CATALOG;
  }

  async getDefinitions(): Promise<any[]> {
    return MOCK_DEFINITIONS;
  }

  async getTasks(): Promise<[]> { return []; }

  async getSpecialistGroupHistory(_specialistId: string): Promise<[]> { return []; }

  async toggleProvider(providerId: string, enabled: boolean): Promise<boolean> {
    return this.toggleProviderEnabled(providerId, enabled);
  }

  async toggleModel(providerId: string, modelId: string, enabled: boolean): Promise<boolean> {
    return this.toggleModelEnabled(providerId, modelId, enabled);
  }

  async toggleProviderEnabled(providerId: string, enabled: boolean): Promise<boolean> {
    const p = this.providers.find((prov) => prov.id === providerId);
    if (p) {
      p.enabled = enabled;
      return true;
    }
    return false;
  }

  async toggleModelEnabled(providerId: string, modelId: string, enabled: boolean): Promise<boolean> {
    const p = this.providers.find((prov) => prov.id === providerId);
    if (p) {
      const m = p.models.find((mod) => mod.id === modelId);
      if (m) {
        m.enabled = enabled;
        return true;
      }
    }
    return false;
  }

  async connectProvider(config: Record<string, unknown>): Promise<ProviderConfig> {
    const id = String(config.providerId || config.id || `custom-${Date.now()}`);
    const name = String(config.name || id);
    const existing = this.providers.find((p) => p.id === id);
    if (existing) {
      existing.connected = true;
      existing.enabled = true;
      return existing;
    }
    const newProv: ProviderConfig = {
      id,
      name,
      type: 'custom',
      iconType: 'custom',
      connected: true,
      enabled: true,
      baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : undefined,
      models: [{ id: `${id}-model`, name: `${name} Model`, enabled: true }],
    };
    this.providers.push(newProv);
    return newProv;
  }

  async disconnectProvider(providerId: string): Promise<boolean> {
    const p = this.providers.find((prov) => prov.id === providerId);
    if (p) {
      p.connected = false;
      p.enabled = false;
      return true;
    }
    return false;
  }

  async updateThreadModel(threadId: string, modelSelection: import('../types').ThreadModelSelection | null, modelName?: string): Promise<void> {
    const t = this.threads.find((th) => th.id === threadId);
    if (t) {
      t.modelSelection = modelSelection ?? undefined;
      if (modelName) t.model = modelName;
    }
  }
}

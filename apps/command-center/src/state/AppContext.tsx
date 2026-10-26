import React, { createContext, useContext, useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  Thread,
  ProjectInfo,
  Turn,
  ThreadItem,
  ApprovalMode,
  ModelOption,
  ThreadModelSelection,
  UserProfile,
  ProviderConfig,
  MedioBotAgent,
  AgentStatus,
  AgentActivityState,
  FileNode,
  WorkbenchTab,
} from '../types';
import { runtimeInstance } from '../runtime/client';
import { RuntimeEvent, RuntimeTaskSummary, RuntimeSpecialistGroupHistory, WorkspaceStatus, WorkspaceSession, WorkspaceWatchEvent } from '../runtime/types';
import { ThreadTitleService } from '../services/titleService';
import type { CatalogProviderItem } from '../types';
import { mergeMonotonicToolData } from '../utils/monotonicMerge';
import { MOCK_PROVIDERS, MOCK_CATALOG } from '../runtime/mockData';
import { buildAssignmentModelSelections, resolveTurnModelSelection } from './agentModelRouting';
import { specialistActivityState, specialistAssignmentGoal, specialistTaskIdentity } from '../features/empty/specialistTaskActivity';
import { mergeAgentTaskHistory } from './specialistTaskHistory';

function mergeIncomingItem(existing: ThreadItem, incoming: ThreadItem): ThreadItem {
  return {
    ...existing,
    ...incoming,
    ...(existing.tool || incoming.tool
      ? { tool: mergeMonotonicToolData(existing.tool, incoming.tool) }
      : {}),
    timestamp: Math.min(existing.timestamp, incoming.timestamp),
    actor: incoming.actor ?? existing.actor,
    text: incoming.text || existing.text,
  };
}

const mapProviderConnection = (sp: any): ProviderConfig => ({
  id: sp.id,
  name: sp.displayName ?? sp.name ?? sp.id,
  type: sp.providerType === 'custom' ? 'custom' : 'builtin',
  description: sp.description,
  iconType: sp.iconType ?? sp.providerType,
  badge: sp.badge,
  connected: sp.connected === true,
  credentialStatus: sp.credentialStatus ?? (sp.connected ? 'configured' : 'missing'),
  enabled: sp.enabled === true,
  baseUrl: sp.baseUrl,
  models: (sp.models ?? []).map((m: any) => ({ id: m.id, name: m.name ?? m.id, enabled: m.enabled === true,
    capabilities: m.capabilities, tag: m.tag, context: m.context, description: m.description })),
});

export const INITIAL_AGENTS: MedioBotAgent[] = [
  { id: 'maestro', name: 'Maestro', group: 'orchestrator', role: 'Team orchestration', status: 'idle' },
  { id: 'cody', definitionId: 'cody', directConversationAvailable: true, name: 'Cody', group: 'specialist', role: 'Software engineering', status: 'waiting', currentTask: 'development' },
  { id: 'vision', name: 'Vision', group: 'specialist', role: 'Browser and visual work', status: 'idle' },
  { id: 'doc', definitionId: 'doc', directConversationAvailable: true, name: 'Doc', group: 'specialist', role: 'Documentation intelligence', status: 'waiting', currentTask: 'unavailable' },
  { id: 'research', definitionId: 'research', directConversationAvailable: true, name: 'Research', group: 'specialist', role: 'Web research', status: 'waiting', currentTask: 'unavailable' },
  { id: 'tester', definitionId: 'tester', directConversationAvailable: true, name: 'Tester', group: 'specialist', role: 'Independent verification', status: 'waiting', currentTask: 'unavailable' },
];

const mediobotSlug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const CANONICAL_MEDIOBOT_IDS = new Set(['maestro', 'cody', 'vision', 'doc', 'research', 'tester', 'scraapy']);

function mapMediobotDefinitions(definitions: ReadonlyArray<any>): MedioBotAgent[] {
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  return definitions.flatMap((definition): MedioBotAgent[] => {
    if (!definition || typeof definition.id !== 'string' || !definition.id || seen.has(definition.id)) return [];
    const nameKey = typeof definition.name === 'string' ? definition.name.trim().toLowerCase() : '';
    // Names are unique by the durable registry contract. This also coalesces
    // legacy generated-ID bootstrap aliases while the backend upgrade rolls out.
    if (nameKey && seenNames.has(nameKey)) return [];
    const preferenceId = mediobotSlug(typeof definition.name === 'string' ? definition.name : definition.id);
    const identityId = CANONICAL_MEDIOBOT_IDS.has(preferenceId) ? preferenceId : definition.id;
    if (seen.has(identityId)) return [];
    seen.add(identityId);
    if (nameKey) seenNames.add(nameKey);
    return [{ id: identityId, definitionId: definition.id, preferenceId,
      directConversationAvailable: definition.directConversationAvailable === true,
      name: definition.name, group: definition.group, role: definition.role,
      availability: definition.availability,
      status: definition.availability === 'available' ? 'idle' : 'waiting',
      currentTask: definition.availability === 'available' ? undefined : definition.availability }];
  });
}

function taskAgentStatus(state: string, events: Array<{ type?: string; occurredAt?: number }> = []): AgentStatus {
  const latestEvent = [...events].sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0))[0];
  if (latestEvent?.type === 'approval.required') return 'waiting';
  if (state === 'queued' || state === 'running') return 'working';
  if (state === 'interrupted') return 'waiting';
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  return 'idle';
}

interface AgentTaskProjection {
  readonly status: AgentStatus;
  readonly activityState?: AgentActivityState;
  readonly currentTask?: string;
  readonly updatedAt: number;
}

function mostRelevantAgentTask(tasks: ReadonlyMap<string, AgentTaskProjection>): AgentTaskProjection | undefined {
  return [...tasks.values()].sort((a, b) => {
    const aActive = a.status === 'working' || a.status === 'waiting' ? 1 : 0;
    const bActive = b.status === 'working' || b.status === 'waiting' ? 1 : 0;
    return bActive - aActive || b.updatedAt - a.updatedAt;
  })[0];
}

export interface AgentModelPreference {
  modelKey: string;
  effort: string;
  modelSelection?: ThreadModelSelection;
}

export const DEFAULT_AGENT_PREFERENCES: Record<string, AgentModelPreference> = {
  maestro: {
    modelKey: 'MiniMaxAI/MiniMax-M2.7',
    effort: 'Medium',
  },
  cody: {
    modelKey: 'MiniMaxAI/MiniMax-M2.7',
    effort: 'High',
  },
  vision: {
    modelKey: 'google/diffusiongemma-26b-a4b-it',
    effort: 'Medium',
  },
  doc: {
    modelKey: 'MiniMaxAI/MiniMax-M2.7',
    effort: 'Low',
  },
  research: {
    modelKey: 'MiniMaxAI/MiniMax-M2.7',
    effort: 'High',
  },
  tester: {
    modelKey: 'MiniMaxAI/MiniMax-M2.7',
    effort: 'Extra',
  },
  deployer: {
    modelKey: 'MiniMaxAI/MiniMax-M2.7',
    effort: 'Medium',
  },
};

export interface EnabledModelOption {
  id: string;
  name: string;
  providerName: string;
  providerId: string;
  badge?: string;
  context?: string;
  tag?: string;
  description?: string;
}

export type AppLocation =
  | { type: 'home' }
  | { type: 'thread'; threadId: string }
  | { type: 'settings'; tab: string }
  | { type: 'library' };

interface AppContextType {
  threads: Thread[];
  activeThreadId: string | null;
  activeThread: Thread | null;
  projects: ProjectInfo[];
  activeProjectId: string;
  activeProject: ProjectInfo;
  activeBranch: string;
  activeEnvironment: 'Local' | 'Remote Container' | 'Cloud Sandbox';
  approvalMode: ApprovalMode;
  model: ModelOption;
  modelSelection: ThreadModelSelection | undefined;
  providers: ProviderConfig[];
  providerCatalog: CatalogProviderItem[];
  enabledModels: EnabledModelOption[];
  isSidebarOpen: boolean;
  sidebarTab: 'home' | 'history' | 'maestro';
  openedFolderName: string | null;
  workspaceStatus: WorkspaceStatus;
  workspaceSession: WorkspaceSession | null;
  treeVersion: number;
  lastFsEvent: WorkspaceWatchEvent | null;
  closeWorkspace: () => Promise<void>;
  chatHydrationStatus: 'UNHYDRATED' | 'LOADING' | 'READY' | 'ERROR';
  reloadThreads: () => Promise<void>;
  workbenchTabs: WorkbenchTab[];
  activeWorkbenchTabId: string | null;
  activeWorkbenchTab: WorkbenchTab | null;
  openTabs: Array<{ path: string; name: string }>;
  activeTabPath: string | null;
  openChatTab: (threadId: string) => void;
  closeWorkbenchTab: (tabId: string) => void;
  setActiveWorkbenchTabId: (id: string | null) => void;
  reorderWorkbenchTabs: (fromIndex: number, toIndex: number) => void;
  setWorkbenchTabsList: (tabs: WorkbenchTab[]) => void;
  getDraft: (threadId: string) => string;
  setDraft: (threadId: string, text: string) => void;
  activeModal: 'settings' | 'projects' | 'export_zip' | 'shortcuts' | null;
  isSettingsView: boolean;
  isLibraryView: boolean;
  settingsTab: string;
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
  canUndoSettingsTab: boolean;
  canRedoSettingsTab: boolean;
  undoSettingsTab: () => void;
  redoSettingsTab: () => void;
  isGenerating: boolean;
  activeTurnId: string | null;
  isThreadGenerating: (threadId: string) => boolean;
  activeTurnsByThread: Record<string, string>;
  cancelTurn: (threadId: string, turnId?: string) => Promise<void>;
  theme: 'dark' | 'light';
  setTheme: (theme: 'dark' | 'light') => void;
  toggleTheme: () => void;
  user: UserProfile;
  agents: MedioBotAgent[];
  agentTaskHistory: RuntimeTaskSummary[];
  agentGroupHistory: RuntimeSpecialistGroupHistory[];
  agentGroupHistoryUnavailable: boolean;
  selectedMediobotId: string | null;
  agentPreferences: Record<string, AgentModelPreference>;
  setAgentModelPreference: (agentId: string, modelKey: string) => void;
  setAgentEffortPreference: (agentId: string, effort: string) => void;
  getAgentPreference: (agentId: string) => AgentModelPreference;

  // Actions
  signIn: (name: string, email: string) => void;
  signOut: () => void;
  updateAgentStatus: (agentId: string, status: AgentStatus, currentTask?: string) => void;
  addAgent: (agent: MedioBotAgent) => void;
  selectAgent: (agentId: string | null) => void;
  setActiveThreadId: (id: string | null) => void;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  openLibrary: () => void;
  closeLibrary: () => void;
  setSettingsTab: (tab: string) => void;
  setIsSettingsView: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarTab: (tab: 'home' | 'history' | 'maestro') => void;
  setOpenedFolderName: (name: string | null) => void;
  customProjectTree: FileNode[] | null;
  setCustomProjectTree: (tree: FileNode[] | null) => void;
  openProjectDirectory: (preferredPath?: string) => Promise<WorkspaceSession | undefined>;
  openFileTab: (path: string, name?: string) => void;
  closeFileTab: (path: string) => void;
  setActiveTabPath: (path: string | null) => void;
  setActiveModal: (modal: 'settings' | 'projects' | 'export_zip' | 'shortcuts' | null) => void;
  setActiveProjectId: (id: string) => void;
  addProject: (path: string) => Promise<void>;
  setActiveBranch: (branch: string) => void;
  setActiveEnvironment: (env: 'Local' | 'Remote Container' | 'Cloud Sandbox') => void;
  setApprovalMode: (mode: ApprovalMode) => void;
  setModel: (model: ModelOption, selection?: ThreadModelSelection) => void;
  toggleProviderEnabled: (providerId: string) => void;
  toggleModelEnabled: (providerId: string, modelId: string) => void;
  connectProvider: (provider: Record<string, unknown>) => Promise<void>;
  addCustomProvider: (provider: Record<string, unknown>) => Promise<void>;
  disconnectProvider: (providerId: string) => void;
  createNewChat: () => void;
  deleteThread: (id: string) => void;
  renameThread: (id: string, newTitle: string) => void;
  regenerateThreadTitle: (id: string) => void;
  syncRenamedEntry: (oldPath: string, newPath: string, isFolder: boolean) => void;
  syncDeletedEntry: (deletedPath: string, isFolder: boolean) => void;
  sendPrompt: (text: string, attachments?: import('../types').TurnAttachment[], modelSelection?: ThreadModelSelection, reasoningEffort?: string) => Promise<void>;
  respondApproval: (turnId: string, approvalId: string, approved: boolean) => Promise<void>;
  cancelCurrentTurn: () => Promise<void>;
}

export const normalizeFilePath = (p: string): string => {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
};

const AppContext = createContext<AppContextType | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Global Interface Theme (Dark vs Light Mode)
  const [theme, setThemeState] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('mediobot_theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      // ignore
    }
    return 'dark';
  });

  const setTheme = useCallback((newTheme: 'dark' | 'light') => {
    setThemeState(newTheme);
    try {
      localStorage.setItem('mediobot_theme', newTheme);
    } catch {
      // ignore
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      if (theme === 'light') {
        root.classList.add('light');
        root.classList.remove('dark');
        root.setAttribute('data-theme', 'light');
      } else {
        root.classList.add('dark');
        root.classList.remove('light');
        root.setAttribute('data-theme', 'dark');
      }
    }
  }, [theme]);

  const deduplicateThreads = useCallback((list: Thread[]): Thread[] => {
    const seen = new Set<string>();
    return (list || []).filter((t) => {
      if (!t.id || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }, []);

  const [threads, setThreads] = useState<Thread[]>(() => {
    const initial = runtimeInstance.getInitialThreads();
    const seen = new Set<string>();
    return (initial || []).filter((t) => {
      if (!t.id || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  });
  const workspaceThreadIds = useRef(new Set(threads.map((thread) => thread.id)));
  workspaceThreadIds.current = new Set(threads.map((thread) => thread.id));
  const [activeTurnsByThread, setActiveTurnsByThread] = useState<Record<string, string>>({});
  const [chatHydrationStatus, setChatHydrationStatus] = useState<'UNHYDRATED' | 'LOADING' | 'READY' | 'ERROR'>('LOADING');
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatus>('EMPTY');
  const [workspaceSession, setWorkspaceSession] = useState<WorkspaceSession | null>(null);
  const [treeVersion, setTreeVersion] = useState<number>(0);
  const [lastFsEvent, setLastFsEvent] = useState<WorkspaceWatchEvent | null>(null);

  const reloadThreads = useCallback(async () => {
    try {
      setChatHydrationStatus('LOADING');
      const loaded = await runtimeInstance.loadThreads(workspaceSession?.workspaceId);
      const deduped = deduplicateThreads(loaded);
      setThreads(deduped);
      setActiveTurnsByThread((prev) => {
        const next: Record<string, string> = {};
        for (const thread of deduped) {
          const runningTurn = thread.turns.find((t) => t.status === 'running' || t.status === 'pause_requested' || t.status === 'waiting_approval');
          if (runningTurn) {
            next[thread.id] = runningTurn.id;
          }
        }
        return next;
      });
      setChatHydrationStatus('READY');
    } catch (err) {
      console.error('Failed to reload threads:', err);
      setChatHydrationStatus('ERROR');
    }
  }, [workspaceSession?.workspaceId, deduplicateThreads]);

  // App-wide Unified Navigation History
  const [navHistory, setNavHistory] = useState<AppLocation[]>(() => {
    try {
      const saved = localStorage.getItem('mediobot_nav_history');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore
    }
    return [{ type: 'home' }];
  });
  const [navIndex, setNavIndex] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('mediobot_nav_index');
      if (saved !== null) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 0) return parsed;
      }
    } catch {
      // ignore
    }
    return 0;
  });

  useEffect(() => {
    try {
      localStorage.setItem('mediobot_nav_history', JSON.stringify(navHistory));
      localStorage.setItem('mediobot_nav_index', navIndex.toString());
    } catch {
      // ignore
    }
  }, [navHistory, navIndex]);

  const areLocationsEqual = (a: AppLocation, b: AppLocation): boolean => {
    if (a.type !== b.type) return false;
    if (a.type === 'home' && b.type === 'home') return true;
    if (a.type === 'library' && b.type === 'library') return true;
    if (a.type === 'thread' && b.type === 'thread') return a.threadId === b.threadId;
    if (a.type === 'settings' && b.type === 'settings') return a.tab === b.tab;
    return false;
  };

  const pushLocation = useCallback((newLoc: AppLocation) => {
    setNavHistory((prev) => {
      const current = prev[navIndex];
      if (current && areLocationsEqual(current, newLoc)) {
        return prev;
      }
      const truncated = prev.slice(0, navIndex + 1);
      const next = [...truncated, newLoc];
      setNavIndex(next.length - 1);
      return next;
    });
  }, [navIndex]);

  const goBack = useCallback(() => {
    setNavIndex((prev) => (prev > 0 ? prev - 1 : prev));
  }, []);

  const goForward = useCallback(() => {
    setNavIndex((prev) => (prev < navHistory.length - 1 ? prev + 1 : prev));
  }, [navHistory.length]);

  const canGoBack = navIndex > 0;
  const canGoForward = navIndex < navHistory.length - 1;

  const currentLoc: AppLocation = navHistory[navIndex] || { type: 'home' };
  const isSettingsView = currentLoc.type === 'settings';
  const isLibraryView = currentLoc.type === 'library';
  const settingsTab = currentLoc.type === 'settings' ? currentLoc.tab : 'general';

  // Canonical Workbench Tabs state
  const [workbenchTabs, setWorkbenchTabs] = useState<WorkbenchTab[]>(() => {
    try {
      const saved = localStorage.getItem('mediobot_workbench_tabs');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const seen = new Set<string>();
          return parsed.filter((t) => {
            if (!t || !t.id) return false;
            const key =
              t.kind === 'file'
                ? `file:${normalizeFilePath(t.path || t.id.replace(/^file:/, ''))}`
                : `chat:${t.threadId || t.id.replace(/^chat:/, '')}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
      }
    } catch {
      // ignore
    }
    return [];
  });
  const [activeWorkbenchTabId, setActiveWorkbenchTabIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem('mediobot_active_workbench_tab_id') || null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('mediobot_workbench_tabs', JSON.stringify(workbenchTabs));
    } catch {
      // ignore
    }
  }, [workbenchTabs]);

  useEffect(() => {
    try {
      if (activeWorkbenchTabId) {
        localStorage.setItem('mediobot_active_workbench_tab_id', activeWorkbenchTabId);
      } else {
        localStorage.removeItem('mediobot_active_workbench_tab_id');
      }
    } catch {
      // ignore
    }
  }, [activeWorkbenchTabId]);

  // Per-chat draft isolation
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const getDraft = useCallback((threadId: string) => drafts[threadId] ?? '', [drafts]);
  const setDraft = useCallback((threadId: string, text: string) => {
    setDrafts((prev) => (prev[threadId] === text ? prev : { ...prev, [threadId]: text }));
  }, []);

  const activeWorkbenchTab = useMemo(() => {
    if (!activeWorkbenchTabId) return null;
    return workbenchTabs.find((t) => t.id === activeWorkbenchTabId) || null;
  }, [workbenchTabs, activeWorkbenchTabId]);

  // Backward-compatible projections
  const openTabs = useMemo(() => {
    return workbenchTabs
      .filter((t): t is WorkbenchTab & { kind: 'file' } => t.kind === 'file')
      .map((t) => ({ path: t.path, name: t.name }));
  }, [workbenchTabs]);

  const activeTabPath = useMemo(() => {
    return activeWorkbenchTab && activeWorkbenchTab.kind === 'file' ? activeWorkbenchTab.path : null;
  }, [activeWorkbenchTab]);

  const activeThreadId = useMemo(() => {
    if (activeWorkbenchTab && activeWorkbenchTab.kind === 'chat') {
      return activeWorkbenchTab.threadId;
    }
    return currentLoc.type === 'thread' ? currentLoc.threadId : null;
  }, [activeWorkbenchTab, currentLoc]);

  const [isSidebarOpen, setSidebarOpenState] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('mediobot_sidebar_open');
      if (saved !== null) {
        return JSON.parse(saved) === true;
      }
    } catch {
      // ignore
    }
    return false;
  });

  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open);
    try {
      localStorage.setItem('mediobot_sidebar_open', JSON.stringify(open));
    } catch {
      // ignore
    }
  }, []);

  const [sidebarTab, setSidebarTabState] = useState<'home' | 'history' | 'maestro'>(() => {
    try {
      const saved = localStorage.getItem('mediobot_sidebar_tab');
      if (saved === 'home' || saved === 'history' || saved === 'maestro') {
        return saved;
      }
    } catch {
      // ignore
    }
    return 'home';
  });

  const setSidebarTab = useCallback((tab: 'home' | 'history' | 'maestro') => {
    setSidebarTabState(tab);
    try {
      localStorage.setItem('mediobot_sidebar_tab', tab);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('mediobot_sidebar_open', JSON.stringify(isSidebarOpen));
    } catch {
      // ignore
    }
  }, [isSidebarOpen]);

  useEffect(() => {
    try {
      localStorage.setItem('mediobot_sidebar_tab', sidebarTab);
    } catch {
      // ignore
    }
  }, [sidebarTab]);

  const [selectedMediobotId, setSelectedMediobotId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('mediobot_selected_mediobot_id') || null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      if (selectedMediobotId) {
        localStorage.setItem('mediobot_selected_mediobot_id', selectedMediobotId);
      } else {
        localStorage.removeItem('mediobot_selected_mediobot_id');
      }
    } catch {
      // ignore
    }
  }, [selectedMediobotId]);

  const [openedFolderName, setOpenedFolderName] = useState<string | null>(null);
  const [customProjectTree, setCustomProjectTree] = useState<FileNode[] | null>(null);
  const [activeModal, setActiveModal] = useState<'settings' | 'projects' | 'export_zip' | 'shortcuts' | null>(null);

  const openSettings = useCallback((tab: string = 'general') => {
    setSelectedMediobotId(null);
    setNavHistory((prev) => {
      const current = prev[navIndex];
      if (current && current.type === 'settings') {
        const next = [...prev];
        next[navIndex] = { type: 'settings' as const, tab };
        return next;
      }
      const truncated = prev.slice(0, navIndex + 1);
      const next = [...truncated, { type: 'settings' as const, tab }];
      setNavIndex(next.length - 1);
      return next;
    });
  }, [navIndex]);

  const closeSettings = useCallback(() => {
    // If active chat tab is open, return to it
    if (activeWorkbenchTab && activeWorkbenchTab.kind === 'chat') {
      pushLocation({ type: 'thread', threadId: activeWorkbenchTab.threadId });
      return;
    }
    // Search backward for the most recent non-settings, non-library location
    for (let i = navIndex - 1; i >= 0; i--) {
      if (navHistory[i] && navHistory[i].type !== 'settings' && navHistory[i].type !== 'library') {
        setNavIndex(i);
        return;
      }
    }
    // Default to home view
    pushLocation({ type: 'home' });
  }, [activeWorkbenchTab, navIndex, navHistory, pushLocation]);

  const openLibrary = useCallback(() => {
    setSelectedMediobotId(null);
    pushLocation({ type: 'library' });
  }, [pushLocation]);

  const closeLibrary = useCallback(() => {
    for (let i = navIndex - 1; i >= 0; i--) {
      if (navHistory[i] && navHistory[i].type !== 'settings' && navHistory[i].type !== 'library') {
        setNavIndex(i);
        return;
      }
    }
    pushLocation({ type: 'home' });
  }, [navIndex, navHistory, pushLocation]);

  const setSettingsTab = useCallback((tab: string) => {
    setNavHistory((prev) => {
      const current = prev[navIndex];
      if (current && current.type === 'settings') {
        const next = [...prev];
        next[navIndex] = { type: 'settings' as const, tab };
        return next;
      }
      const truncated = prev.slice(0, navIndex + 1);
      const next = [...truncated, { type: 'settings' as const, tab }];
      setNavIndex(next.length - 1);
      return next;
    });
  }, [navIndex]);

  const setIsSettingsView = useCallback((open: boolean) => {
    if (open) {
      openSettings(settingsTab || 'general');
    } else {
      closeSettings();
    }
  }, [openSettings, closeSettings, settingsTab]);

  const isTabMatch = useCallback((tab: WorkbenchTab, idOrPath: string | null): boolean => {
    if (!idOrPath || !tab) return false;
    if (tab.id === idOrPath) return true;
    if (tab.kind === 'file') {
      const cleanId = idOrPath.replace(/^file:/, '');
      const cleanPath = normalizeFilePath(tab.path);
      return cleanPath === normalizeFilePath(cleanId) || tab.path === idOrPath || tab.id === `file:${cleanPath}`;
    }
    if (tab.kind === 'chat') {
      const cleanId = idOrPath.replace(/^chat:/, '');
      return tab.threadId === cleanId || tab.threadId === idOrPath || tab.id === `chat:${tab.threadId}`;
    }
    return false;
  }, []);

  const setActiveWorkbenchTabId = useCallback((id: string | null) => {
    setSelectedMediobotId(null);
    setActiveWorkbenchTabIdState(id);
    try {
      if (id) {
        localStorage.setItem('mediobot_active_workbench_tab_id', id);
      } else {
        localStorage.removeItem('mediobot_active_workbench_tab_id');
      }
    } catch {
      // ignore
    }
    // Also immediately sync to runtime uiState so refresh preserves it instantly
    if (workspaceStatus === 'OPEN' && workspaceSession) {
      const activeTab = workbenchTabs.find((t) => isTabMatch(t, id));
      const activePath = activeTab?.kind === 'file' ? activeTab.path : null;
      void runtimeInstance.saveUIState(
        activePath,
        openTabs,
        [],
        workbenchTabs.map((t) =>
          t.kind === 'file'
            ? { id: t.id, kind: 'file' as const, path: t.path, name: t.name }
            : { id: t.id, kind: 'chat' as const, threadId: t.threadId, title: t.title }
        ),
        id
      );
    }
    if (!id) {
      pushLocation({ type: 'home' });
      return;
    }
    const tab = workbenchTabs.find((t) => isTabMatch(t, id));
    if (tab?.kind === 'chat') {
      pushLocation({ type: 'thread', threadId: tab.threadId });
    } else {
      pushLocation({ type: 'home' });
    }
  }, [workbenchTabs, pushLocation, workspaceStatus, workspaceSession, openTabs, isTabMatch]);

  const setActiveTabPath = useCallback((path: string | null) => {
    setSelectedMediobotId(null);
    if (!path) {
      if (activeWorkbenchTab?.kind === 'file') {
        setActiveWorkbenchTabIdState(null);
      }
    } else {
      setActiveWorkbenchTabIdState(`file:${path}`);
    }
  }, [activeWorkbenchTab]);

  const openFileTab = useCallback((filePath: string, name?: string) => {
    const cleanPath = normalizeFilePath(filePath);
    const fileName = name || cleanPath.split('/').pop() || cleanPath;
    const canonicalTabId = `file:${cleanPath}`;

    // 1. If tab for this file is already opened, switch directly to it without opening a duplicate
    const existingTab = workbenchTabs.find(
      (t) =>
        t.kind === 'file' &&
        (t.id === canonicalTabId ||
          t.id === `file:${filePath}` ||
          normalizeFilePath(t.path) === cleanPath ||
          t.path === filePath)
    );

    if (existingTab) {
      setActiveWorkbenchTabIdState(existingTab.id);
      try {
        localStorage.setItem('mediobot_active_workbench_tab_id', existingTab.id);
      } catch {}
      if (isSettingsView) {
        closeSettings();
      }
      return;
    }

    // 2. Only open the tab if it is not already opened
    setWorkbenchTabs((prev) => {
      const alreadyOpen = prev.find(
        (t) =>
          t.kind === 'file' &&
          (t.id === canonicalTabId ||
            t.id === `file:${filePath}` ||
            normalizeFilePath(t.path) === cleanPath ||
            t.path === filePath)
      );
      if (alreadyOpen) {
        return prev;
      }
      return [...prev, { id: canonicalTabId, kind: 'file', path: cleanPath, name: fileName }];
    });

    setActiveWorkbenchTabIdState(canonicalTabId);
    try {
      localStorage.setItem('mediobot_active_workbench_tab_id', canonicalTabId);
    } catch {}
    if (isSettingsView) {
      closeSettings();
    }
  }, [workbenchTabs, isSettingsView, closeSettings]);

  const openChatTab = useCallback((threadId: string) => {
    setSelectedMediobotId(null);
    const tabId = `chat:${threadId}`;

    // 1. If tab for this thread is already opened, switch directly to it
    const existingTab = workbenchTabs.find(
      (t) => t.kind === 'chat' && (t.id === tabId || t.threadId === threadId)
    );

    if (existingTab) {
      setActiveWorkbenchTabIdState(existingTab.id);
      try {
        localStorage.setItem('mediobot_active_workbench_tab_id', existingTab.id);
      } catch {}
      pushLocation({ type: 'thread', threadId });
      if (isSettingsView) {
        closeSettings();
      }
      return;
    }

    // 2. Only open the tab if it is not already opened
    setWorkbenchTabs((prev) => {
      if (prev.some((t) => t.kind === 'chat' && (t.id === tabId || t.threadId === threadId))) {
        return prev;
      }
      const thread = threads.find((t) => t.id === threadId);
      return [...prev, { id: tabId, kind: 'chat', threadId, title: thread?.title || 'New chat' }];
    });

    setActiveWorkbenchTabIdState(tabId);
    try {
      localStorage.setItem('mediobot_active_workbench_tab_id', tabId);
    } catch {}
    pushLocation({ type: 'thread', threadId });
    if (isSettingsView) {
      closeSettings();
    }
  }, [workbenchTabs, threads, pushLocation, isSettingsView, closeSettings]);

  const closeWorkbenchTab = useCallback((tabId: string) => {
    setWorkbenchTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx === -1) return prev;
      const nextTabs = prev.filter((t) => t.id !== tabId);
      if (activeWorkbenchTabId === tabId) {
        if (nextTabs.length > 0) {
          const nextIdx = Math.min(idx, nextTabs.length - 1);
          const nextTab = nextTabs[nextIdx];
          setActiveWorkbenchTabIdState(nextTab.id);
          try {
            localStorage.setItem('mediobot_active_workbench_tab_id', nextTab.id);
          } catch {}
          if (nextTab.kind === 'chat') {
            pushLocation({ type: 'thread', threadId: nextTab.threadId });
          }
        } else {
          setActiveWorkbenchTabIdState(null);
          try {
            localStorage.removeItem('mediobot_active_workbench_tab_id');
          } catch {}
          pushLocation({ type: 'home' });
        }
      }
      return nextTabs;
    });
  }, [activeWorkbenchTabId, pushLocation]);

  const closeFileTab = useCallback((path: string) => {
    closeWorkbenchTab(`file:${path}`);
  }, [closeWorkbenchTab]);

  const reorderWorkbenchTabs = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setWorkbenchTabs((prev) => {
      if (fromIndex < 0 || fromIndex >= prev.length || toIndex < 0 || toIndex >= prev.length) {
        return prev;
      }
      const updated = [...prev];
      const [movedItem] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, movedItem);
      return updated;
    });
  }, []);

  const setWorkbenchTabsList = useCallback((tabs: WorkbenchTab[]) => {
    setWorkbenchTabs(tabs);
  }, []);

  const syncRenamedEntry = useCallback((oldPath: string, newPath: string, isFolder: boolean) => {
    setWorkbenchTabs((prev) =>
      prev.map((tab) => {
        if (tab.kind !== 'file') return tab;
        if (!isFolder && tab.path === oldPath) {
          return { id: `file:${newPath}`, kind: 'file', path: newPath, name: newPath.split('/').pop() || newPath };
        }
        if (isFolder && tab.path.startsWith(oldPath + '/')) {
          const subPath = tab.path.slice(oldPath.length);
          const nextPath = `${newPath}${subPath}`;
          return { id: `file:${nextPath}`, kind: 'file', path: nextPath, name: nextPath.split('/').pop() || nextPath };
        }
        return tab;
      })
    );
    setActiveWorkbenchTabIdState((current) => {
      if (!current || !current.startsWith('file:')) return current;
      const currentPath = current.slice(5);
      if (!isFolder && currentPath === oldPath) return `file:${newPath}`;
      if (isFolder && currentPath.startsWith(oldPath + '/')) {
        return `file:${newPath}${currentPath.slice(oldPath.length)}`;
      }
      return current;
    });
  }, []);

  const syncDeletedEntry = useCallback((deletedPath: string, isFolder: boolean) => {
    setWorkbenchTabs((prev) => {
      const remaining = prev.filter((tab) => {
        if (tab.kind !== 'file') return true;
        if (!isFolder && tab.path === deletedPath) return false;
        if (isFolder && (tab.path === deletedPath || tab.path.startsWith(deletedPath + '/'))) return false;
        return true;
      });
      return remaining;
    });
    setActiveWorkbenchTabIdState((current) => {
      if (!current || !current.startsWith('file:')) return current;
      const currentPath = current.slice(5);
      const isMatch = (!isFolder && currentPath === deletedPath) || (isFolder && (currentPath === deletedPath || currentPath.startsWith(deletedPath + '/')));
      return isMatch ? null : current;
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    setChatHydrationStatus('LOADING');
    Promise.allSettled([
      runtimeInstance.getWorkspace(),
      runtimeInstance.loadThreads(),
      runtimeInstance.getConnectedProviders(),
      runtimeInstance.getProviderCatalog(),
      runtimeInstance.getDefinitions(),
    ]).then(([wsRes, threadsRes, provRes, catalogRes, definitionsRes]) => {
      if (!mounted) return;

      if (provRes.status === 'fulfilled' && Array.isArray(provRes.value)) {
        setProviders(provRes.value.map(mapProviderConnection));
      }
      if (catalogRes.status === 'fulfilled') setProviderCatalog(catalogRes.value as CatalogProviderItem[]);
      if (definitionsRes.status === 'fulfilled') {
        setAgents(mapMediobotDefinitions(definitionsRes.value));
        setAgentRegistryLoaded(true);
      }

      const loadedThreads = threadsRes.status === 'fulfilled' ? threadsRes.value : [];
      if (threadsRes.status === 'fulfilled') {
        const deduped = deduplicateThreads(loadedThreads);
        setThreads(deduped);
        setChatHydrationStatus('READY');
        const runningMap: Record<string, string> = {};
        for (const thread of deduped) {
          const runningTurn = thread.turns.find((t) => t.status === 'running' || t.status === 'pause_requested' || t.status === 'waiting_approval');
          if (runningTurn) {
            runningMap[thread.id] = runningTurn.id;
            runtimeInstance.resumeTurn?.(thread.id, runningTurn.id);
          }
        }
        setActiveTurnsByThread(runningMap);
      } else {
        console.error('Failed to load threads from SQLite:', threadsRes.reason);
        setChatHydrationStatus('ERROR');
      }

      const ws = wsRes.status === 'fulfilled' ? wsRes.value : { status: 'EMPTY' as WorkspaceStatus, session: null, uiState: null };
      setWorkspaceStatus(ws.status);
      if (ws.status === 'OPEN' && ws.session) {
        setWorkspaceSession(ws.session);
        setOpenedFolderName(ws.session.displayName);

        // Hydrate workbench tabs from SQLite uiState
        let restoredTabs: WorkbenchTab[] = [];
        if (ws.uiState?.workbenchTabs && Array.isArray(ws.uiState.workbenchTabs) && ws.uiState.workbenchTabs.length > 0) {
          restoredTabs = ws.uiState.workbenchTabs
            .map((t) => {
              if (t.kind === 'file' && t.path) {
                return {
                  id: t.id || `file:${t.path}`,
                  kind: 'file' as const,
                  path: t.path,
                  name: t.name || t.path.split('/').pop() || t.path,
                };
              }
              if (t.kind === 'chat' && t.threadId) {
                const thread = loadedThreads.find((th) => th.id === t.threadId);
                return {
                  id: t.id || `chat:${t.threadId}`,
                  kind: 'chat' as const,
                  threadId: t.threadId,
                  title: thread?.title || t.title || 'New chat',
                };
              }
              return null;
            })
            .filter((t): t is WorkbenchTab => t !== null);
        } else if (ws.uiState?.openTabs && Array.isArray(ws.uiState.openTabs)) {
          restoredTabs = ws.uiState.openTabs.map((t) => ({
            id: `file:${t.path}`,
            kind: 'file' as const,
            path: t.path,
            name: t.name,
          }));
        }
        // Prioritize localStorage tabs (which have user's latest opened tabs & exact order)
        let finalTabs: WorkbenchTab[] = [];
        const savedTabsJson = (() => {
          try {
            return localStorage.getItem('mediobot_workbench_tabs');
          } catch {
            return null;
          }
        })();
        if (savedTabsJson) {
          try {
            const parsedSaved = JSON.parse(savedTabsJson);
            if (Array.isArray(parsedSaved) && parsedSaved.length > 0) {
              finalTabs = parsedSaved.filter((t) => t && t.id);
            }
          } catch {
            // ignore
          }
        }
        if (finalTabs.length === 0) {
          finalTabs = restoredTabs;
        } else {
          // Merge in any tabs from workspace that might be missing
          restoredTabs.forEach((rt) => {
            if (!finalTabs.some((ft) => isTabMatch(ft, rt.id))) {
              finalTabs.push(rt);
            }
          });
        }
        setWorkbenchTabs(finalTabs);

        const savedActiveTabId = (() => {
          try {
            return localStorage.getItem('mediobot_active_workbench_tab_id');
          } catch {
            return null;
          }
        })();

        const resolvedTab = (savedActiveTabId && finalTabs.find((t) => isTabMatch(t, savedActiveTabId)))
          || (ws.uiState?.activeWorkbenchTabId && finalTabs.find((t) => isTabMatch(t, ws.uiState.activeWorkbenchTabId)))
          || (ws.uiState?.activeFile && finalTabs.find((t) => isTabMatch(t, `file:${ws.uiState.activeFile}`)))
          || (finalTabs.length > 0 ? finalTabs[0] : null);

        if (resolvedTab) {
          setActiveWorkbenchTabIdState(resolvedTab.id);
          try {
            localStorage.setItem('mediobot_active_workbench_tab_id', resolvedTab.id);
          } catch {
            // ignore
          }
          if (resolvedTab.kind === 'chat') {
            setNavHistory([{ type: 'home' }, { type: 'thread', threadId: resolvedTab.threadId }]);
            setNavIndex(1);
          } else {
            setNavHistory([{ type: 'home' }]);
            setNavIndex(0);
          }
        }
      } else if (ws.status === 'UNAVAILABLE' && ws.session) {
        setWorkspaceSession(ws.session);
        setOpenedFolderName(ws.session.displayName);
      } else {
        setWorkspaceSession(null);
        setOpenedFolderName(null);
        setWorkbenchTabs([]);
        setActiveWorkbenchTabIdState(null);
      }
    }).catch(() => {
      if (!mounted) return;
      setChatHydrationStatus('ERROR');
    });

    const unsubscribe = runtimeInstance.onWorkspaceEvent((event) => {
      if (!mounted) return;
      if (event.type === 'state' && event.state) {
        setWorkspaceStatus(event.state.status);
        setWorkspaceSession(event.state.session);
        if (event.state.status === 'OPEN' && event.state.session) {
          setOpenedFolderName(event.state.session.displayName);
        }
        setTreeVersion((v) => v + 1);
      } else if (event.type === 'fs' && event.fsEvents) {
        setTreeVersion((v) => v + 1);
        for (const fe of event.fsEvents) {
          if (fe.type === 'delete') {
            closeFileTab(fe.relativePath);
          }
          setLastFsEvent(fe);
        }
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const openProjectDirectory = useCallback(async (preferredPath?: string) => {
    try {
      // 1. Persist current workspace state before switching
      if (workspaceStatus === 'OPEN' && workspaceSession) {
        const activeTab = workbenchTabs.find((t) => isTabMatch(t, activeWorkbenchTabId));
        const activePath = activeTab?.kind === 'file' ? activeTab.path : null;
        try {
          await runtimeInstance.saveUIState(
            activePath,
            openTabs,
            [],
            workbenchTabs.map((t) =>
              t.kind === 'file'
                ? { id: t.id, kind: 'file' as const, path: t.path, name: t.name }
                : { id: t.id, kind: 'chat' as const, threadId: t.threadId, title: t.title }
            ),
            activeWorkbenchTabId
          );
        } catch (e) {
          console.warn('Failed to persist previous workspace UI state before switch:', e);
        }
      }

      setWorkspaceStatus('OPENING');
      const result = await runtimeInstance.openWorkspace(typeof preferredPath === 'string' ? preferredPath : undefined);
      if (result.cancelled || !result.session) {
        setWorkspaceStatus((prev) => (workspaceSession ? 'OPEN' : 'EMPTY'));
        return;
      }
      const session = result.session;
      const uiState = result.uiState;

      // 2. Clear any custom tree & wipe previous threads immediately
      setCustomProjectTree(null);
      setThreads([]);
      setChatHydrationStatus('LOADING');

      // 3. ATOMIC SWITCH: Clean wipe old tabs first and load new workspace tabs
      let newTabs: WorkbenchTab[] = [];
      if (uiState?.workbenchTabs && Array.isArray(uiState.workbenchTabs) && uiState.workbenchTabs.length > 0) {
        newTabs = uiState.workbenchTabs
          .map((t) => {
            if (t.kind === 'file' && t.path) {
              return { id: t.id || `file:${t.path}`, kind: 'file' as const, path: t.path, name: t.name || t.path.split('/').pop() || t.path };
            }
            if (t.kind === 'chat' && t.threadId) {
              return { id: t.id || `chat:${t.threadId}`, kind: 'chat' as const, threadId: t.threadId, title: t.title || 'New chat' };
            }
            return null;
          })
          .filter((t): t is WorkbenchTab => t !== null);
      } else if (uiState?.openTabs && Array.isArray(uiState.openTabs)) {
        newTabs = uiState.openTabs.map((t) => ({
          id: `file:${t.path}`,
          kind: 'file' as const,
          path: t.path,
          name: t.name,
        }));
      }
      setWorkbenchTabs(newTabs);

      const savedActiveTabId = (() => {
        try {
          return localStorage.getItem('mediobot_active_workbench_tab_id');
        } catch {
          return null;
        }
      })();

      const targetId = (savedActiveTabId && newTabs.some((t) => isTabMatch(t, savedActiveTabId)))
        ? savedActiveTabId
        : (uiState?.activeWorkbenchTabId || (uiState?.activeFile ? `file:${uiState.activeFile}` : null));
      const resolvedTab = newTabs.find((t) => isTabMatch(t, targetId)) || (newTabs.length > 0 ? newTabs[0] : null);
      setActiveWorkbenchTabIdState(resolvedTab?.id ?? null);
      if (resolvedTab?.kind === 'chat') {
        pushLocation({ type: 'thread', threadId: resolvedTab.threadId });
      } else {
        pushLocation({ type: 'home' });
      }

      setOpenedFolderName(session.displayName);
      setWorkspaceSession(session);
      setWorkspaceStatus('OPEN');
      setTreeVersion((v) => v + 1);

      // 4. Reload threads for this workspace strictly
      try {
        const loaded = await runtimeInstance.loadThreads(session.workspaceId);
        setThreads(deduplicateThreads(loaded));
        setChatHydrationStatus('READY');
      } catch (err) {
        console.error('Failed to reload workspace threads:', err);
        setChatHydrationStatus('ERROR');
      }

      if (currentLoc.type === 'settings' || currentLoc.type === 'library') {
        pushLocation({ type: 'home' });
      }
      return session;
    } catch (error) {
      console.error('Failed to open project directory:', error);
      setWorkspaceStatus((prev) => (workspaceSession ? 'OPEN' : 'EMPTY'));
    }
  }, [workspaceSession, workspaceStatus, workbenchTabs, openTabs, activeWorkbenchTabId, currentLoc, pushLocation, isTabMatch]);

  const closeWorkspace = useCallback(async () => {
    try {
      await runtimeInstance.closeWorkspace();
      setWorkspaceSession(null);
      setWorkspaceStatus('EMPTY');
      setOpenedFolderName(null);
      setWorkbenchTabs([]);
      setActiveWorkbenchTabIdState(null);
      setCustomProjectTree(null);
      setTreeVersion((v) => v + 1);
      setThreads([]);
      setChatHydrationStatus('LOADING');
      try {
        const loaded = await runtimeInstance.loadThreads(null);
        setThreads(deduplicateThreads(loaded));
        setChatHydrationStatus('READY');
      } catch {
        setChatHydrationStatus('READY');
      }
    } catch (error) {
      console.error('Failed to close workspace:', error);
    }
  }, []);
  
  // MedioBot Agents state 
  const [agents, setAgents] = useState<MedioBotAgent[]>(INITIAL_AGENTS);
  const [agentRegistryLoaded, setAgentRegistryLoaded] = useState(false);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const [agentTaskHistory, setAgentTaskHistory] = useState<RuntimeTaskSummary[]>([]);
  const [agentGroupHistory, setAgentGroupHistory] = useState<RuntimeSpecialistGroupHistory[]>([]);
  const [agentGroupHistoryUnavailable, setAgentGroupHistoryUnavailable] = useState(false);
  const agentTaskHistoryRef = useRef(agentTaskHistory);
  agentTaskHistoryRef.current = agentTaskHistory;
  const agentTaskProjections = useRef(new Map<string, Map<string, AgentTaskProjection>>());
  const agentTaskProjectionWorkspace = useRef<string | null>(null);

  const selectAgent = useCallback((agentId: string | null) => {
    setSelectedMediobotId(agentId);
    if (agentId) {
      setActiveWorkbenchTabIdState(null);
      pushLocation({ type: 'home' });
    }
  }, [pushLocation]);

  useEffect(() => {
    if (!agentRegistryLoaded || !selectedMediobotId || agents.some(agent => agent.id === selectedMediobotId)) return;
    const legacyMatches = agents.filter(agent => agent.preferenceId === selectedMediobotId);
    if (legacyMatches.length === 1) setSelectedMediobotId(legacyMatches[0]!.id);
    else if (agents.length) setSelectedMediobotId(null);
  }, [agentRegistryLoaded, agents, selectedMediobotId]);

  const updateAgentStatus = useCallback((agentId: string, status: AgentStatus, currentTask?: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, status, ...(currentTask !== undefined ? { currentTask } : {}) } : a))
    );
  }, []);

  const updateAgentTaskStatus = useCallback((agentId: string, taskId: string, status: AgentStatus,
    currentTask: string | undefined, updatedAt: number, activityState?: AgentActivityState) => {
    const workspaceId = workspaceSession?.workspaceId ?? null;
    if (agentTaskProjectionWorkspace.current !== workspaceId) {
      agentTaskProjections.current.clear();
      agentTaskProjectionWorkspace.current = workspaceId;
    }
    const tasks = agentTaskProjections.current.get(agentId) ?? new Map<string, AgentTaskProjection>();
    const previous = tasks.get(taskId);
    const taskLabel = currentTask ?? previous?.currentTask;
    tasks.set(taskId, {
      status,
      ...(activityState ? { activityState } : previous?.activityState ? { activityState: previous.activityState } : {}),
      ...(taskLabel !== undefined ? { currentTask: taskLabel.slice(0, 180) } : {}),
      updatedAt,
    });
    if (tasks.size > 100) {
      const terminal = [...tasks.entries()].filter(([, projection]) => projection.status !== 'working' && projection.status !== 'waiting')
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      while (tasks.size > 100 && terminal.length) tasks.delete(terminal.shift()![0]);
    }
    agentTaskProjections.current.set(agentId, tasks);
    const projection = mostRelevantAgentTask(tasks);
    if (projection) setAgents((prev) => prev.map((agent) => agent.id === agentId
      ? { ...agent, status: projection.status, currentTask: projection.currentTask,
        ...(projection.activityState ? { activityState: projection.activityState } : {}) } : agent));
  }, [workspaceSession?.workspaceId]);

  const refreshAgentAssignments = useCallback(async () => {
    const defaults = (agent: MedioBotAgent): MedioBotAgent => ({
      ...agent,
      status: agent.availability === 'available' || !agent.availability ? 'idle' : 'waiting',
      activityState: undefined,
      currentTask: agent.availability && agent.availability !== 'available' ? agent.availability : undefined,
    });
    if (workspaceStatus !== 'OPEN' || !workspaceSession) {
      agentTaskProjections.current.clear();
      agentTaskProjectionWorkspace.current = null;
      setAgentTaskHistory([]);
      setAgents((prev) => prev.map(defaults));
      return;
    }
    const workspaceId = workspaceSession.workspaceId;
    if (agentTaskProjectionWorkspace.current !== workspaceId) {
      agentTaskProjections.current.clear();
      agentTaskProjectionWorkspace.current = workspaceId;
    }
    try {
      const tasks = await runtimeInstance.getTasks();
      if (agentTaskProjectionWorkspace.current !== workspaceId) return;
      const boundedHistory = tasks.map((task) => ({ ...task, events: task.events?.slice(-30) }))
        .sort((a, b) => {
          const aActive = a.state === 'running' || a.state === 'queued' ? 1 : 0;
          const bActive = b.state === 'running' || b.state === 'queued' ? 1 : 0;
          const aLatest = Math.max(0, ...(a.events ?? []).map((event) => event.occurredAt));
          const bLatest = Math.max(0, ...(b.events ?? []).map((event) => event.occurredAt));
          return bActive - aActive || bLatest - aLatest;
        }).slice(0, 100);
      setAgentTaskHistory((current) => mergeAgentTaskHistory(boundedHistory, current));
      const nextProjections = new Map<string, Map<string, AgentTaskProjection>>();
      for (const task of tasks) {
        if (!task.assignedMediobot) continue;
        const agentId = agentsRef.current.find(agent => agent.definitionId === task.assignedMediobot!.id)?.id
          ?? mediobotSlug(task.assignedMediobot.name);
        const perAgent = nextProjections.get(agentId) ?? new Map<string, AgentTaskProjection>();
        const latestTaskEvent = [...(task.events ?? [])].sort((a, b) => b.occurredAt - a.occurredAt)[0];
        perAgent.set(task.id, { status: taskAgentStatus(task.state, [...(task.events ?? [])]),
          ...(latestTaskEvent ? { activityState: specialistActivityState({ type: latestTaskEvent.type, occurredAt: latestTaskEvent.occurredAt,
            toolName: latestTaskEvent.toolName, activityState: latestTaskEvent.activityState }) } : {}),
          currentTask: task.goal.slice(0, 180),
          updatedAt: Math.max(0, ...(task.events ?? []).map((event) => event.occurredAt)) });
        nextProjections.set(agentId, perAgent);
      }
      for (const [agentId, current] of agentTaskProjections.current) {
        const perAgent = nextProjections.get(agentId) ?? new Map<string, AgentTaskProjection>();
        for (const [taskId, projection] of current) {
          if (projection.updatedAt > (perAgent.get(taskId)?.updatedAt ?? 0)) perAgent.set(taskId, projection);
        }
        nextProjections.set(agentId, perAgent);
      }
      for (const perAgent of nextProjections.values()) {
        const entries = [...perAgent.entries()].sort((a, b) => {
          const aActive = a[1].status === 'working' || a[1].status === 'waiting' ? 1 : 0;
          const bActive = b[1].status === 'working' || b[1].status === 'waiting' ? 1 : 0;
          return bActive - aActive || b[1].updatedAt - a[1].updatedAt;
        });
        for (const [taskId] of entries.slice(100)) perAgent.delete(taskId);
      }
      agentTaskProjections.current = nextProjections;
      setAgents((prev) => prev.map((agent) => {
        const projection = mostRelevantAgentTask(agentTaskProjections.current.get(agent.id) ?? new Map());
      if (!projection) return defaults(agent);
        return { ...agent, status: projection.status, currentTask: projection.currentTask,
          ...(projection.activityState ? { activityState: projection.activityState } : {}) };
      }));
    } catch {
      // Keep the last event-backed status when the task projection is temporarily unavailable.
    }
  }, [workspaceStatus, workspaceSession?.workspaceId]);

  useEffect(() => { void refreshAgentAssignments(); }, [refreshAgentAssignments]);

  useEffect(() => {
    const selectedDefinitionId = agents.find(agent => agent.id === selectedMediobotId)?.definitionId;
    if (!selectedMediobotId || !selectedDefinitionId || workspaceStatus !== 'OPEN' || !workspaceSession) {
      setAgentGroupHistory([]);
      setAgentGroupHistoryUnavailable(false);
      return;
    }
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setAgentGroupHistory([]);
    setAgentGroupHistoryUnavailable(false);
    const refresh = async () => {
      try {
        const groups = await runtimeInstance.getSpecialistGroupHistory(selectedDefinitionId);
        if (!disposed) {
          setAgentGroupHistory(groups.slice(0, 6));
          setAgentGroupHistoryUnavailable(false);
        }
      } catch {
        if (!disposed) setAgentGroupHistoryUnavailable(true);
      }
    };
    void refresh();
    const unsubscribe = runtimeInstance.onEvent(event => {
      if (event.type !== 'worker.progress' || !event.taskId
        || !/(?:shared (?:finding|request)|received a (?:request|finding|response)|sent a (?:request|finding|response))/i.test(event.payload.message ?? "")) return;
      const belongsToWorkspace = workspaceThreadIds.current.has(event.threadId)
        || agentTaskHistoryRef.current.some(task => task.id === event.taskId);
      if (!belongsToWorkspace) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 120);
    });
    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [selectedMediobotId, agents.find(agent => agent.id === selectedMediobotId)?.definitionId,
    workspaceStatus, workspaceSession?.workspaceId]);

  const addAgent = useCallback((agent: Omit<MedioBotAgent, 'group'> & { group?: MedioBotAgent['group'] }) => {
    setAgents((prev) => {
      if (prev.some((a) => a.id === agent.id)) return prev;
      return [...prev, { ...agent, group: agent.group ?? 'specialist' }];
    });
  }, []);

  // AI Providers & Models configuration state
  const [providers, setProviders] = useState<ProviderConfig[]>(() => {
    return MOCK_PROVIDERS;
  });
  const [providerCatalog, setProviderCatalog] = useState<CatalogProviderItem[]>(() => {
    return MOCK_CATALOG;
  });
  const refreshProviders = useCallback(async () => {
    try {
      const [serverProviders, definitions] = await Promise.all([
        runtimeInstance.getConnectedProviders(), runtimeInstance.getDefinitions(),
      ]);
      if (Array.isArray(serverProviders)) {
        setProviders(serverProviders.map(mapProviderConnection));
      }
      if (definitions) setAgentRegistryLoaded(true);
      if (definitions && definitions.length > 0) {
        setAgents(mapMediobotDefinitions(definitions));
      }
    } catch {
      // Keep initial mock providers intact
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const toggleProviderEnabled = useCallback(async (providerId: string) => {
    await runtimeInstance.toggleProvider(providerId, !providers.find((p) => p.id === providerId)?.enabled);
    await refreshProviders();
  }, [providers, refreshProviders]);

  const toggleModelEnabled = useCallback(async (providerId: string, modelId: string) => {
    const current = providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId)?.enabled;
    await runtimeInstance.toggleModel(providerId, modelId, !current);
    await refreshProviders();
  }, [providers, refreshProviders]);

  const connectProvider = useCallback(async (provider: Record<string, unknown>) => {
    await runtimeInstance.connectProvider(provider);
    await refreshProviders();
  }, [refreshProviders]);

  const addCustomProvider = connectProvider;

  const disconnectProvider = useCallback(async (providerId: string) => {
    await runtimeInstance.disconnectProvider(providerId);
    await refreshProviders();
  }, [refreshProviders]);

  const enabledModels = useMemo<EnabledModelOption[]>(() => {
    const list: EnabledModelOption[] = [];
    providers.forEach((prov) => {
      if (prov.connected && prov.enabled && prov.credentialStatus !== 'missing') {
        prov.models.forEach((m) => {
          if (m.enabled) {
            list.push({
              id: m.id,
              name: m.name,
              providerName: prov.name,
              providerId: prov.id,
              badge: m.tag || prov.badge,
              context: m.context,
              description: m.description,
            });
          }
        });
      }
    });
    return list;
  }, [providers]);

  const [activeBranch, setActiveBranch] = useState<string>('main');
  const [activeEnvironment, setActiveEnvironment] = useState<'Local' | 'Remote Container' | 'Cloud Sandbox'>('Local');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('Approve for me');
  const [draftModelSelection, setDraftModelSelection] = useState<ThreadModelSelection>();

  const activeThread = useMemo(() => {
    if (!activeThreadId) return null;
    return threads.find((t) => t.id === activeThreadId) || null;
  }, [threads, activeThreadId]);

  const modelSelection = activeThread ? activeThread.modelSelection : draftModelSelection;
  const model = useMemo<ModelOption>(() => {
    if (modelSelection) {
      const selected = enabledModels.find((candidate) =>
        candidate.providerId === modelSelection.providerConnectionId && candidate.id === modelSelection.modelId
      );
      return selected?.name ?? `Unavailable model · ${modelSelection.modelId}`;
    }
    if (activeThread?.model) return activeThread.model;
    return 'No configured model';
  }, [activeThread?.model, modelSelection, enabledModels]);

  const setModel = useCallback((newModel: ModelOption, explicitSelection?: import('../types').ThreadModelSelection) => {
    let selection = explicitSelection;
    if (!selection) {
      const matches = enabledModels.filter((m) => m.name === newModel || m.id === newModel);
      if (matches.length !== 1) return;
      selection = { providerConnectionId: matches[0].providerId, modelId: matches[0].id };
    }

    if (activeThreadId) {
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== activeThreadId) return t;
          return {
            ...t,
            model: newModel,
            modelSelection: selection,
            updatedAt: Date.now(),
          };
        })
      );
      void runtimeInstance.updateThreadModel(activeThreadId, selection ?? null, newModel).catch(() => {});
    } else {
      setDraftModelSelection(selection);
    }
  }, [activeThreadId, enabledModels]);

  // Per-MedioBot model and effort (level) preferences
  const [agentPreferences, setAgentPreferences] = useState<Record<string, AgentModelPreference>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('mediobot_agent_preferences_v5');
        if (saved) {
          const parsed = JSON.parse(saved);
          const merged: Record<string, AgentModelPreference> = { ...DEFAULT_AGENT_PREFERENCES };

          // Verify that parsed models aren't all collapsed to a single common model
          const savedModelKeys = Object.keys(DEFAULT_AGENT_PREFERENCES)
            .map((k) => parsed[k]?.modelKey)
            .filter(Boolean);
          const uniqueSavedModels = new Set(savedModelKeys);
          const isCommonCollapsed = savedModelKeys.length >= 3 && uniqueSavedModels.size === 1;

          Object.keys(DEFAULT_AGENT_PREFERENCES).forEach((key) => {
            if (parsed[key]) {
              merged[key] = {
                modelKey: isCommonCollapsed
                  ? DEFAULT_AGENT_PREFERENCES[key].modelKey
                  : (parsed[key].modelKey || DEFAULT_AGENT_PREFERENCES[key].modelKey),
                effort: parsed[key].effort || DEFAULT_AGENT_PREFERENCES[key].effort,
                ...(parsed[key].modelSelection && typeof parsed[key].modelSelection.providerConnectionId === 'string'
                  && typeof parsed[key].modelSelection.modelId === 'string'
                  ? { modelSelection: { providerConnectionId: parsed[key].modelSelection.providerConnectionId,
                    modelId: parsed[key].modelSelection.modelId } } : {}),
              };
            }
          });
          return merged;
        }
      } catch {
        // ignore
      }
    }
    return DEFAULT_AGENT_PREFERENCES;
  });

  useEffect(() => {
    try {
      localStorage.setItem('mediobot_agent_preferences_v5', JSON.stringify(agentPreferences));
    } catch {
      // ignore
    }
  }, [agentPreferences]);

  const setAgentModelPreference = useCallback((agentId: string, modelKey: string) => {
    const safeId = (agentsRef.current.find(agent => agent.id === agentId)?.preferenceId ?? agentId ?? 'maestro').toLowerCase();
    const matchingModels = enabledModels.filter(candidate => candidate.id === modelKey || candidate.name === modelKey
      || `${candidate.providerId}::${candidate.id}` === modelKey);
    const modelSelection = matchingModels.length === 1
      ? { providerConnectionId: matchingModels[0]!.providerId, modelId: matchingModels[0]!.id }
      : undefined;
    setAgentPreferences((prev) => {
      const existing = prev[safeId] || DEFAULT_AGENT_PREFERENCES[safeId] || { modelKey: '', effort: 'Medium' };
      return {
        ...prev,
        [safeId]: {
          ...existing,
          modelKey,
          modelSelection,
        },
      };
    });
    // If setting maestro, also sync with draftModelSelection for the main chat
    if (safeId === 'maestro') {
      const found = enabledModels.find((m) => m.id === modelKey || m.name === modelKey);
      if (found) {
        setDraftModelSelection({ providerConnectionId: found.providerId, modelId: found.id });
      }
    }
  }, [enabledModels]);

  const setAgentEffortPreference = useCallback((agentId: string, effort: string) => {
    const safeId = (agentsRef.current.find(agent => agent.id === agentId)?.preferenceId ?? agentId ?? 'maestro').toLowerCase();
    setAgentPreferences((prev) => {
      const existing = prev[safeId] || DEFAULT_AGENT_PREFERENCES[safeId] || { modelKey: '', effort: 'Medium' };
      return {
        ...prev,
        [safeId]: {
          ...existing,
          effort,
        },
      };
    });
  }, []);

  const getAgentPreference = useCallback((agentId: string): AgentModelPreference => {
    const safeId = (agentsRef.current.find(agent => agent.id === agentId)?.preferenceId ?? agentId ?? 'maestro').toLowerCase();
    const pref = agentPreferences[safeId];
    const def = DEFAULT_AGENT_PREFERENCES[safeId];
    return {
      modelKey: pref?.modelKey || def?.modelKey || 'MiniMaxAI/MiniMax-M2.7',
      effort: pref?.effort || def?.effort || 'Medium',
      ...(pref?.modelSelection ? { modelSelection: pref.modelSelection } : {}),
    };
  }, [agentPreferences]);

  const activeProjectId = workspaceSession && workspaceStatus === 'OPEN' ? workspaceSession.workspaceId : '';

  const activeProject = useMemo<ProjectInfo>(() => {
    if (workspaceSession && workspaceStatus === 'OPEN') {
      return {
        id: workspaceSession.workspaceId,
        name: workspaceSession.displayName,
        path: workspaceSession.canonicalRootPath,
        branch: activeBranch,
        branches: [activeBranch],
        environment: activeEnvironment,
      };
    }
    return {
      id: '',
      name: 'No Project',
      path: '',
      branch: 'main',
      branches: ['main'],
      environment: 'Local' as const,
    };
  }, [workspaceSession, workspaceStatus, activeBranch, activeEnvironment]);

  const projects = useMemo<ProjectInfo[]>(() => {
    return activeProject.id ? [activeProject] : [];
  }, [activeProject]);

  const createNewChat = useCallback(() => {
    setSelectedMediobotId(null);

    // Deduplication check: if current active tab is already an untouched blank new chat, keep focus on it
    if (activeWorkbenchTab?.kind === 'chat') {
      const curThread = threads.find((t) => t.id === activeWorkbenchTab.threadId);
      const curDraft = drafts[activeWorkbenchTab.threadId] ?? '';
      if (curThread && curThread.turns.length === 0 && !curDraft.trim()) {
        pushLocation({ type: 'thread', threadId: curThread.id });
        return;
      }
    }

    const uniqueSuffix = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 8);
    const threadId = `thread-${Date.now()}-${uniqueSuffix}`;
    const newThread: Thread = {
      id: threadId,
      title: 'New chat',
      projectId: activeProjectId || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: 'No configured model',
      branch: activeBranch,
      approvalMode,
      turns: [],
    };

    void runtimeInstance.saveThread(newThread).catch(() => {});
    setThreads((prev) => {
      if (prev.some((t) => t.id === newThread.id)) return prev;
      return [newThread, ...prev];
    });

    const newTab: WorkbenchTab = {
      id: `chat:${threadId}`,
      kind: 'chat',
      threadId,
      title: 'New chat',
    };

    setWorkbenchTabs((prev) => {
      if (prev.some((t) => t.id === newTab.id)) return prev;
      return [...prev, newTab];
    });
    setActiveWorkbenchTabIdState(newTab.id);
    pushLocation({ type: 'thread', threadId });
  }, [activeWorkbenchTab, threads, drafts, activeProjectId, activeBranch, approvalMode, pushLocation]);

  const setActiveProjectId = useCallback((_id: string) => {
    // Single workspace session is canonical
  }, []);

  const handleSetActiveThreadId = useCallback((id: string | null) => {
    setSelectedMediobotId(null);
    if (id) {
      openChatTab(id);
    } else {
      setActiveWorkbenchTabIdState(null);
      pushLocation({ type: 'home' });
    }
  }, [openChatTab, pushLocation]);

  // Auto-save UI state to SQLite when tabs or active file change in an OPEN workspace
  useEffect(() => {
    if (workspaceStatus !== 'OPEN' || !workspaceSession) return;
    const timer = setTimeout(() => {
      const persistedTabs = workbenchTabs.map((t) =>
        t.kind === 'file'
          ? { id: t.id, kind: 'file' as const, path: t.path, name: t.name }
          : { id: t.id, kind: 'chat' as const, threadId: t.threadId, title: t.title }
      );
      void runtimeInstance.saveUIState(
        activeTabPath,
        openTabs,
        [],
        persistedTabs,
        activeWorkbenchTabId
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [workspaceStatus, workspaceSession, activeTabPath, openTabs, workbenchTabs, activeWorkbenchTabId]);

  // Active running turn tracker
  const activeTurnId = activeThreadId ? activeTurnsByThread[activeThreadId] ?? null : null;
  const isGenerating = Boolean(activeThreadId && activeTurnsByThread[activeThreadId]);
  const isThreadGenerating = useCallback((threadId: string) => Boolean(activeTurnsByThread[threadId]), [activeTurnsByThread]);

  // Sync branch when active project changes
  useEffect(() => {
    if (activeProject) {
      setActiveBranch(activeProject.branch);
      setActiveEnvironment(activeProject.environment);
      setOpenedFolderName(activeProject.id ? activeProject.name : null);
    }
  }, [activeProject]);

  // Real user profile state with local persistence
  const [user, setUser] = useState<UserProfile>(() => {
    try {
      const saved = localStorage.getItem('mediobot_user');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {
      // ignore
    }
    return {
      name: '',
      email: '',
      avatarText: '',
      isSignedIn: false,
    };
  });

  const addProject = useCallback(async (path: string) => {
    await openProjectDirectory(path);
  }, [openProjectDirectory]);

  const signIn = useCallback((name: string, email: string) => {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const initials = trimmedName
      ? trimmedName
          .split(' ')
          .map((n) => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2)
      : trimmedEmail
      ? trimmedEmail[0].toUpperCase()
      : 'U';

    const newUser: UserProfile = {
      name: trimmedName || trimmedEmail.split('@')[0] || 'User',
      email: trimmedEmail,
      avatarText: initials,
      isSignedIn: true,
    };
    setUser(newUser);
    try {
      localStorage.setItem('mediobot_user', JSON.stringify(newUser));
    } catch {
      // ignore
    }
  }, []);

  const signOut = useCallback(() => {
    const defaultUser: UserProfile = {
      name: '',
      email: '',
      avatarText: '',
      isSignedIn: false,
    };
    setUser(defaultUser);
    try {
      localStorage.removeItem('mediobot_user');
    } catch {
      // ignore
    }
  }, []);

  // Subscribe to Runtime Events
  useEffect(() => {
    const taskRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const unsubscribe = runtimeInstance.onEvent((event: RuntimeEvent) => {
      const eventAgent = agentsRef.current.find(agent => agent.definitionId === event.workerDefinitionId)
        ?? agentsRef.current.find(agent => agent.id === mediobotSlug(event.workerName ?? ''));
      const eventAgentId = eventAgent?.id ?? (event.workerName
        ? mediobotSlug(event.workerName)
        : event.workerDefinitionId?.replace(/^definition-/, ''));
      const activityTaskId = specialistTaskIdentity(event);
      const belongsToWorkspace = workspaceThreadIds.current.has(event.threadId)
        || Boolean((event.taskId || activityTaskId) && agentTaskHistoryRef.current.some((task) =>
          task.id === event.taskId || task.id === activityTaskId));
      // A child execution can first appear as worker.started or a tool event
      // without a prior worker.assigned event in the thread stream. Hydrate the durable task
      // projection so the specialist workspace can show its live assignment
      // and tool history instead of waiting for a reload or terminal event.
      const startsVisibleTask = event.type === 'worker.started' || event.type === 'worker.assigned'
        || event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.failed' || event.type === 'tool.cancelled';
      if (eventAgentId && belongsToWorkspace && startsVisibleTask && activityTaskId
        && !agentTaskHistoryRef.current.some((task) => task.id === activityTaskId)
        && !taskRefreshTimers.has(activityTaskId)) {
        taskRefreshTimers.set(activityTaskId, setTimeout(() => {
          taskRefreshTimers.delete(activityTaskId);
          void refreshAgentAssignments();
        }, 50));
      }
      if (eventAgentId && belongsToWorkspace) {
        const status = event.type === 'worker.failed' ? 'failed'
          : event.type === 'worker.completed' ? 'completed'
          : event.type === 'worker.cancelled' ? 'idle'
          : event.type === 'approval.required' ? 'waiting'
          : event.type === 'worker.assigned' || event.type === 'worker.started' || event.type === 'worker.progress'
            || event.type === 'tool.started' || event.type === 'tool.progress' || event.type === 'tool.completed'
            || event.type === 'tool.failed' || event.type === 'tool.cancelled' || event.type === 'approval.resolved'
            ? 'working' : undefined;
        const eventTool = event.payload.tool ?? event.payload.item?.tool;
        const activityState = specialistActivityState({ type: event.type, occurredAt: event.timestamp,
          activityState: event.payload.activityState, toolName: eventTool?.toolName });
        if (status && activityTaskId) updateAgentTaskStatus(eventAgentId, activityTaskId, status,
          event.type === 'worker.assigned' ? event.payload.message : undefined, event.timestamp, activityState);
        else if (status) {
          updateAgentStatus(eventAgentId, status, event.type === 'worker.assigned' ? event.payload.message : undefined);
          if (activityState) setAgents(previous => previous.map(agent => agent.id === eventAgentId ? { ...agent, activityState } : agent));
        }
        if (activityTaskId && ['worker.assigned', 'worker.started', 'worker.progress', 'worker.completed', 'worker.failed', 'worker.cancelled',
          'tool.started', 'tool.progress', 'tool.completed', 'tool.failed', 'tool.cancelled', 'approval.required', 'approval.resolved'].includes(event.type)) {
          setAgentTaskHistory((previous) => {
            const index = previous.findIndex((task) => task.id === activityTaskId);
            const existing = index >= 0 ? previous[index]! : undefined;
            if (!existing && event.type !== 'worker.assigned') return previous;
            const agentName = eventAgent?.name ?? event.workerName ?? eventAgentId;
            const eventRecord = {
              type: event.type,
              occurredAt: event.timestamp,
              ...(event.id ? { id: event.id } : {}),
              ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
              ...(event.workerDefinitionId ? { workerDefinitionId: event.workerDefinitionId } : {}),
              ...(event.workerName ? { workerName: event.workerName } : {}),
              ...(event.payload.message ? { message: event.payload.message.slice(0, 180) } : {}),
              ...(eventTool?.toolName ? { toolName: eventTool.toolName } : {}),
              ...(eventTool?.command ? { command: eventTool.command } : {}),
              ...(eventTool?.workingDirectory ? { workingDirectory: eventTool.workingDirectory } : {}),
              ...(eventTool?.error ? { message: eventTool.error.slice(0, 180) } : {}),
              ...(eventTool?.exitCode !== undefined ? { exitCode: eventTool.exitCode } : {}),
              ...(eventTool?.errorCode ? { errorCode: eventTool.errorCode } : {}),
              ...(eventTool?.recoveryReason ? { recoveryReason: eventTool.recoveryReason } : {}),
              ...(activityState ? { activityState } : {}),
            };
            const priorEvents = existing?.events ?? [];
            const alreadyRecorded = eventRecord.id
              ? priorEvents.some((item) => item.id === eventRecord.id)
              : eventRecord.sequence !== undefined
                ? priorEvents.some((item) => item.sequence === eventRecord.sequence)
                : priorEvents.some((item) => item.type === eventRecord.type && item.occurredAt === eventRecord.occurredAt
                  && item.toolName === eventRecord.toolName && item.message === eventRecord.message);
            if (alreadyRecorded) return previous;
            const lifecycleState = event.type === 'worker.completed' ? 'completed'
              : event.type === 'worker.failed' ? 'failed'
              : event.type === 'worker.cancelled' ? 'cancelled'
              : event.type === 'approval.required' ? 'waiting_approval'
              : event.type === 'worker.assigned' || event.type === 'worker.started' ? 'running' : existing?.state ?? 'running';
            const nextTask = {
              ...(existing ?? { id: activityTaskId, goal: specialistAssignmentGoal(event.payload.message) ?? 'Specialist assignment',
                assignedMediobot: { id: event.workerDefinitionId ?? eventAgentId, name: agentName } }),
              state: lifecycleState,
              events: [...priorEvents, eventRecord].sort((a, b) => a.occurredAt - b.occurredAt).slice(-30),
            };
            const next = [...previous];
            if (index >= 0) next[index] = nextTask;
            else next.unshift(nextTask);
            return next.slice(0, 100);
          });
        }
      }
      if (event.type === 'turn.snapshot' && event.payload.turn) {
        const snapshot = event.payload.turn;
        setThreads((prev) => prev.map((thread) => {
          if (thread.id !== event.threadId) return thread;
          const exists = thread.turns.some((turn) => turn.id === snapshot.id);
          return { ...thread, updatedAt: Math.max(thread.updatedAt, snapshot.completedAt ?? snapshot.createdAt),
            turns: exists ? thread.turns.map((turn) => turn.id === snapshot.id ? snapshot : turn) : [...thread.turns, snapshot] };
        }));
        if (snapshot.status === 'running' || snapshot.status === 'waiting_approval') {
          setActiveTurnsByThread((prev) => ({ ...prev, [event.threadId]: snapshot.id }));
        } else {
          setActiveTurnsByThread((prev) => {
            if (prev[event.threadId] === snapshot.id) {
              const next = { ...prev };
              delete next[event.threadId];
              return next;
            }
            return prev;
          });
        }
        return;
      }
      setThreads((prevThreads) => {
        return prevThreads.map((thread) => {
          if (thread.id !== event.threadId) return thread;

          const updatedTurns = thread.turns.map((turn) => {
            if (turn.id !== event.turnId) return turn;
            if (['completed', 'failed', 'cancelled'].includes(turn.status)) return turn;

            const nextTurn: Turn = { ...turn };

            switch (event.type) {
              case 'agent.started':
                nextTurn.status = 'running';
                break;

              case 'task.pause_requested':
                nextTurn.status = 'pause_requested';
                nextTurn.currentActivity = 'waiting';
                break;

              case 'task.paused':
                nextTurn.status = 'paused';
                nextTurn.currentActivity = 'waiting';
                break;

              case 'task.resumed':
                nextTurn.status = 'running';
                nextTurn.currentActivity = 'running';
                nextTurn.recoveryState = undefined;
                break;

              case 'worker.assigned':
              case 'worker.started':
                nextTurn.status = 'running';
                if (event.payload.item) nextTurn.items = [...nextTurn.items, event.payload.item];
                break;

              case 'worker.progress':
              case 'worker.completed':
              case 'worker.failed':
              case 'worker.cancelled':
                if (event.payload.item) {
                  const incoming = event.payload.item;
                  const idx = nextTurn.items.findIndex((it) => it.id === incoming.id);
                  if (idx >= 0) {
                    const nextItems = [...nextTurn.items];
                    nextItems[idx] = mergeIncomingItem(nextItems[idx]!, incoming);
                    nextTurn.items = nextItems;
                  } else {
                    nextTurn.items = [...nextTurn.items, incoming];
                  }
                }
                break;

              case 'agent.progress':
                if (event.payload.activityState) {
                  nextTurn.currentActivity = event.payload.activityState;
                }
                if (event.payload.item) {
                  const incoming = event.payload.item;
                  const idx = nextTurn.items.findIndex((it) => it.id === incoming.id);
                  if (idx >= 0) {
                    const nextItems = [...nextTurn.items];
                    nextItems[idx] = mergeIncomingItem(nextItems[idx]!, incoming);
                    nextTurn.items = nextItems;
                  } else {
                    nextTurn.items = [...nextTurn.items, incoming];
                  }
                }
                break;

              case 'tool.started':
              case 'tool.completed':
              case 'tool.failed':
              case 'tool.cancelled':
                if (event.payload.item) {
                  const incoming = event.payload.item;
                  const idx = nextTurn.items.findIndex((it) => it.id === incoming.id);
                  if (idx >= 0) {
                    const nextItems = [...nextTurn.items];
                    nextItems[idx] = mergeIncomingItem(nextItems[idx]!, incoming);
                    nextTurn.items = nextItems;
                  } else {
                    nextTurn.items = [...nextTurn.items, incoming];
                  }
                }
                break;

              case 'approval.required':
                nextTurn.status = 'waiting_approval';
                nextTurn.currentActivity = 'waiting_for_approval';
                if (event.payload.item) {
                  const incoming = event.payload.item;
                  const idx = nextTurn.items.findIndex((it) => it.id === incoming.id);
                  if (idx >= 0) {
                    const nextItems = [...nextTurn.items];
                    nextItems[idx] = mergeIncomingItem(nextItems[idx]!, incoming);
                    nextTurn.items = nextItems;
                  } else {
                    nextTurn.items = [...nextTurn.items, incoming];
                  }
                }
                break;

              case 'approval.resolved':
                if (event.payload.approval) {
                  const approvalId = event.payload.approval.approvalId;
                  nextTurn.items = nextTurn.items.map((item) => item.type === 'approval_request'
                    && item.approval?.approvalId === approvalId
                    ? { ...item, approval: { ...item.approval, status: event.payload.approval!.status } }
                    : item);
                }
                if (nextTurn.status === 'waiting_approval') {
                  nextTurn.status = 'running';
                  nextTurn.currentActivity = 'running';
                }
                break;

              case 'diff.created':
                if (event.payload.item) {
                  const incoming = event.payload.item;
                  const idx = nextTurn.items.findIndex((it) => it.id === incoming.id);
                  if (idx >= 0) {
                    const nextItems = [...nextTurn.items];
                    nextItems[idx] = mergeIncomingItem(nextItems[idx]!, incoming);
                    nextTurn.items = nextItems;
                  } else {
                    nextTurn.items = [...nextTurn.items, incoming];
                  }
                }
                break;

              case 'task.completed':
              case 'turn.completed':
                nextTurn.status = 'completed';
                nextTurn.currentActivity = 'completed';
                nextTurn.completedAt = Date.now();
                if (event.payload.item) {
                  nextTurn.items = [...nextTurn.items, event.payload.item];
                }
                break;

              case 'task.failed':
              case 'turn.failed':
                nextTurn.status = 'failed';
                nextTurn.currentActivity = 'failed';
                nextTurn.completedAt = Date.now();
                if (event.payload.item) {
                  nextTurn.items = [...nextTurn.items, event.payload.item];
                } else if (event.payload.summary) {
                  const errorItem: ThreadItem = {
                    id: `err-${Date.now()}`,
                    turnId: turn.id,
                    type: 'agent_message',
                    actor: { type: 'system' },
                    timestamp: Date.now(),
                    text: `Turn ended: ${event.payload.summary}`,
                  };
                  nextTurn.items = [...nextTurn.items, errorItem];
                }
                break;

              case 'task.cancelled':
              case 'turn.cancelled':
                nextTurn.status = 'cancelled';
                nextTurn.currentActivity = 'completed';
                nextTurn.completedAt = Date.now();
                if (event.payload.summary) nextTurn.items = [...nextTurn.items, { id: `cancel-${Date.now()}`, turnId: turn.id,
                  type: 'activity', actor: { type: 'system' }, timestamp: Date.now(), text: event.payload.summary }];
                break;
            }

            return nextTurn;
          });

          const updated = {
            ...thread,
            updatedAt: Date.now(),
            turns: updatedTurns,
          };
          return updated;
        });
      });

      if (event.type === 'task.paused' || event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled'
        || event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') {
        setActiveTurnsByThread((prev) => {
          if (prev[event.threadId] === event.turnId) {
            const next = { ...prev };
            delete next[event.threadId];
            return next;
          }
          return prev;
        });
      }
    });

    return () => {
      unsubscribe();
      for (const timer of taskRefreshTimers.values()) clearTimeout(timer);
      taskRefreshTimers.clear();
    };
  }, [refreshAgentAssignments, updateAgentStatus, updateAgentTaskStatus]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpenState((prev) => !prev);
  }, []);

  const deleteThread = useCallback(async (id: string) => {
    try {
      await runtimeInstance.deleteThread(id);
    } catch {
      // ignore
    }
    setThreads((prev) => prev.filter((t) => t.id !== id));
    setActiveTurnsByThread((prev) => {
      if (prev[id]) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return prev;
    });
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    closeWorkbenchTab(`chat:${id}`);
  }, [closeWorkbenchTab]);

  const renameThread = useCallback(async (id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    try {
      await runtimeInstance.renameThread(id, trimmed);
    } catch {
      // ignore
    }
    setThreads((prev) =>
      prev.map((t) => (t.id === id ? { ...t, title: trimmed, updatedAt: Date.now() } : t))
    );
    setWorkbenchTabs((prev) =>
      prev.map((tab) => (tab.kind === 'chat' && tab.threadId === id ? { ...tab, title: trimmed } : tab))
    );
  }, []);

  const regenerateThreadTitle = useCallback((id: string) => {
    let autoTitle = '';
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const firstPrompt = t.turns[0]?.prompt;
        if (!firstPrompt) return t;
        autoTitle = ThreadTitleService.generateTitle(firstPrompt);
        void runtimeInstance.renameThread(id, autoTitle).catch(() => {});
        return { ...t, title: autoTitle, updatedAt: Date.now() };
      })
    );
    if (autoTitle) {
      setWorkbenchTabs((prev) =>
        prev.map((tab) => (tab.kind === 'chat' && tab.threadId === id ? { ...tab, title: autoTitle } : tab))
      );
    }
  }, []);

  const sendPrompt = useCallback(
    async (text: string, attachments: import('../types').TurnAttachment[] = [], selectedModelSelection?: ThreadModelSelection, reasoningEffort?: string) => {
      const trimmed = text.trim();
      let threadId = activeThreadId;
      const selectedAgent = selectedMediobotId ? agents.find((agent) => agent.id === selectedMediobotId) : undefined;
      const specialistId = selectedAgent?.directConversationAvailable
        ? (selectedAgent.definitionId ?? selectedAgent.id) : undefined;
      const specialistPreferenceId = specialistId ? (selectedAgent?.preferenceId ?? selectedAgent?.id) : undefined;
      const requestedModelSelection = resolveTurnModelSelection(selectedModelSelection, modelSelection, specialistPreferenceId, agentPreferences);
      const rawEffort = (
        reasoningEffort
        || requestedModelSelection?.reasoningEffort
        || (threadId ? threads.find((t) => t.id === threadId)?.reasoningEffort : undefined)
        || activeThread?.reasoningEffort
      )?.toLowerCase();
      const validEffort = rawEffort && ['low', 'medium', 'high', 'extra', 'max'].includes(rawEffort)
        ? (rawEffort as 'low' | 'medium' | 'high' | 'extra' | 'max')
        : undefined;
      const effectiveModelSelection: ThreadModelSelection | undefined = requestedModelSelection
        ? {
            ...requestedModelSelection,
            ...(validEffort ? { reasoningEffort: validEffort } : {}),
          }
        : undefined;
      const assignmentModelSelections = specialistId ? undefined : buildAssignmentModelSelections(
        agentPreferences,
        agents.filter((agent) => agent.group === 'specialist' && agent.id !== 'maestro')
          .map((agent) => ({ preferenceId: agent.preferenceId ?? agent.id, definitionId: agent.definitionId ?? agent.id })),
      );
      if (!trimmed || (threadId && activeTurnsByThread[threadId])) return;

      // If in empty state, spawn a new thread with automated concise title based on prompt
      if (!threadId) {
        const newTitle = ThreadTitleService.generateTitle(trimmed);
        const uniqueSuffix = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 8);
        threadId = `thread-${Date.now()}-${uniqueSuffix}`;
        const newThread: Thread = {
          id: threadId,
          title: newTitle,
          projectId: activeProjectId,
          ...(specialistId ? { specialistId } : {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          model: effectiveModelSelection
            ? enabledModels.find((entry) => entry.providerId === effectiveModelSelection.providerConnectionId && entry.id === effectiveModelSelection.modelId)?.name ?? model
            : model,
          modelSelection: effectiveModelSelection,
          ...(validEffort ? { reasoningEffort: validEffort } : {}),
          branch: activeBranch,
          approvalMode,
          turns: [],
        };

        setThreads((prev) => {
          if (prev.some((t) => t.id === newThread.id)) return prev;
          return [newThread, ...prev];
        });
        void runtimeInstance.saveThread(newThread).catch(() => {});
        const newTab: WorkbenchTab = {
          id: `chat:${threadId}`,
          kind: 'chat',
          threadId,
          title: newTitle,
        };
        setWorkbenchTabs((prev) => {
          if (prev.some((t) => t.id === newTab.id)) return prev;
          return [...prev, newTab];
        });
        setActiveWorkbenchTabIdState(newTab.id);
        pushLocation({ type: 'thread', threadId });
      } else {
        const existingThread = threads.find((t) => t.id === threadId);
        if (existingThread && (existingThread.turns.length === 0 || existingThread.title === 'New chat')) {
          const generatedTitle = ThreadTitleService.generateTitle(trimmed);
          setThreads((prev) =>
            prev.map((t) => (t.id === threadId ? { ...t, title: generatedTitle, updatedAt: Date.now() } : t))
          );
          setWorkbenchTabs((prev) =>
            prev.map((tab) => (tab.kind === 'chat' && tab.threadId === threadId ? { ...tab, title: generatedTitle } : tab))
          );
          void runtimeInstance.renameThread(threadId, generatedTitle).catch(() => {});
        }
      }

      setDraft(threadId, '');
      setDraft('home', '');

      // Create new turn with unique ID
      const turnId = `turn-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
      const userItem: ThreadItem = {
        id: `user-${Date.now()}`,
        turnId,
        type: 'user_message',
        actor: { type: 'user' },
        timestamp: Date.now(),
        text: trimmed,
        ...(attachments.length ? { attachments } : {}),
      };

      const newTurn: Turn = {
        id: turnId,
        threadId,
        prompt: trimmed,
        status: 'running',
        currentActivity: 'thinking',
        createdAt: Date.now(),
        items: [userItem],
      };

      // Optimistically project in local UI - server remains authoritative transcript writer
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== threadId) return t;
          return {
            ...t,
            updatedAt: Date.now(),
            turns: [...t.turns, newTurn],
            ...(validEffort ? { reasoningEffort: validEffort } : {}),
            ...(effectiveModelSelection ? { modelSelection: effectiveModelSelection } : {}),
          };
        })
      );

      setActiveTurnsByThread((prev) => ({ ...prev, [threadId]: turnId }));

      try {
        await runtimeInstance.startTurn(threadId, trimmed, {
          model,
          modelSelection: effectiveModelSelection ?? requestedModelSelection,
          ...(validEffort ? { reasoningEffort: validEffort } : {}),
          ...(assignmentModelSelections && Object.keys(assignmentModelSelections).length ? { assignmentModelSelections } : {}),
          ...(specialistId ? { specialistId } : {}),
          approvalMode,
          project: activeProject,
          branch: activeBranch,
          recentHistory: (activeThread?.turns ?? []).slice(-4).map((turn) => {
            const assistant = [...turn.items].reverse().find((item) => item.type === 'agent_message' && item.text);
            return { user: turn.prompt, ...(assistant?.text ? { assistant: assistant.text } : {}) };
          }),
          attachments,
        }, turnId);

        try {
          const freshThread = await runtimeInstance.loadThread?.(threadId);
          if (freshThread) {
            setThreads((prev) => prev.map((t) => (t.id === threadId ? freshThread : t)));
            const latestTurn = freshThread.turns.find((t) => t.id === turnId);
            if (latestTurn && ['completed', 'failed', 'cancelled'].includes(latestTurn.status)) {
              setActiveTurnsByThread((prev) => {
                if (prev[threadId] === turnId) {
                  const next = { ...prev };
                  delete next[threadId];
                  return next;
                }
                return prev;
              });
            }
          }
        } catch {
          // SSE stream handles active transitions
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The task could not be started.';
        const failedItem: ThreadItem = {
          id: `start-error-${turnId}`,
          turnId,
          type: 'agent_message',
          actor: { type: 'system' },
          timestamp: Date.now(),
          text: message,
        };
        setThreads((prev) => prev.map((thread) => {
          if (thread.id !== threadId) return thread;
          const updatedTurns: Turn[] = thread.turns.map((turn) => turn.id === turnId
            ? { ...turn, status: 'failed', currentActivity: 'failed', completedAt: Date.now(), items: [...turn.items, failedItem] }
            : turn);
          return { ...thread, updatedAt: Date.now(), turns: updatedTurns };
        }));
        setActiveTurnsByThread((prev) => {
          if (prev[threadId] === turnId) {
            const next = { ...prev };
            delete next[threadId];
            return next;
          }
          return prev;
        });
      }
    },
    [
      activeThreadId,
      activeTurnsByThread,
      activeProjectId,
      model,
      modelSelection,
      selectedMediobotId,
      agents,
      enabledModels,
      agentPreferences,
      activeBranch,
      approvalMode,
      activeProject,
      activeThread,
      threads,
      setDraft,
      pushLocation,
    ]
  );

  const respondApproval = useCallback(
    async (turnId: string, approvalId: string, approved: boolean) => {
      // Update UI state immediately
      setThreads((prev) =>
        prev.map((thread) => ({
          ...thread,
          turns: thread.turns.map((turn) => {
            if (turn.id !== turnId) return turn;
            return {
              ...turn,
              status: approved ? 'running' : 'failed',
              currentActivity: approved ? 'editing' : 'failed',
              items: turn.items.map((item) => {
                if (item.approval && item.approval.approvalId === approvalId) {
                  return {
                    ...item,
                    approval: {
                      ...item.approval,
                      status: approved ? 'approved' : 'rejected',
                    },
                  };
                }
                return item;
              }),
            };
          }),
        }))
      );

      await runtimeInstance.respondToApproval(turnId, approvalId, approved);
    },
    []
  );

  const cancelTurn = useCallback(async (threadId: string, turnId?: string) => {
    const targetTurnId = turnId ?? activeTurnsByThread[threadId];
    if (targetTurnId) {
      await runtimeInstance.cancelTurn(threadId, targetTurnId);
      // Keep the turn active until its durable terminal event arrives. The API
      // acknowledges an abort request, not completed worker/tool settlement.
    }
  }, [activeTurnsByThread]);

  const cancelCurrentTurn = useCallback(async () => {
    if (activeThreadId) {
      await cancelTurn(activeThreadId);
    }
  }, [activeThreadId, cancelTurn]);

  return (
    <AppContext.Provider
      value={{
        threads,
        activeThreadId,
        activeThread,
        projects,
        activeProjectId,
        activeProject,
        activeBranch,
        activeEnvironment,
        approvalMode,
        model,
        modelSelection,
        providers,
        providerCatalog,
        enabledModels,
        isSidebarOpen,
        sidebarTab,
        openedFolderName,
        workspaceStatus,
        workspaceSession,
        treeVersion,
        lastFsEvent,
        closeWorkspace,
        chatHydrationStatus,
        reloadThreads,
        workbenchTabs,
        activeWorkbenchTabId,
        activeWorkbenchTab,
        openTabs,
        activeTabPath,
        openChatTab,
        closeWorkbenchTab,
        setActiveWorkbenchTabId,
        reorderWorkbenchTabs,
        setWorkbenchTabsList,
        getDraft,
        setDraft,
        openFileTab,
        closeFileTab,
        setActiveTabPath,
        activeModal,
        isSettingsView,
        isLibraryView,
        settingsTab,
        setSettingsTab,
        canGoBack,
        canGoForward,
        goBack,
        goForward,
        canUndoSettingsTab: canGoBack,
        canRedoSettingsTab: canGoForward,
        undoSettingsTab: goBack,
        redoSettingsTab: goForward,
        isGenerating,
        activeTurnId,
        isThreadGenerating,
        activeTurnsByThread,
        cancelTurn,
        theme,
        setTheme,
        toggleTheme,
        user,
        agents,
        agentTaskHistory,
        agentGroupHistory,
        agentGroupHistoryUnavailable,
        selectedMediobotId,
        agentPreferences,
        setAgentModelPreference,
        setAgentEffortPreference,
        getAgentPreference,
        selectAgent,
        updateAgentStatus,
        addAgent,
        signIn,
        signOut,
        setActiveThreadId: handleSetActiveThreadId,
        openSettings,
        closeSettings,
        openLibrary,
        closeLibrary,
        setIsSettingsView,
        toggleSidebar,
        setSidebarOpen,
        setSidebarTab,
        setOpenedFolderName,
        customProjectTree,
        setCustomProjectTree,
        openProjectDirectory,
        setActiveModal,
        setActiveProjectId,
        addProject,
        setActiveBranch,
        setActiveEnvironment,
        setApprovalMode,
        setModel,
        toggleProviderEnabled,
        toggleModelEnabled,
        connectProvider,
        addCustomProvider,
        disconnectProvider,
        createNewChat,
        deleteThread,
        renameThread,
        regenerateThreadTitle,
        syncRenamedEntry,
        syncDeletedEntry,
        sendPrompt,
        respondApproval,
        cancelCurrentTurn,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
};

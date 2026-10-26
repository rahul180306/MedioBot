import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Bell,
  Search,
  SquarePen,
  Pin,
  X,
  Folder,
  ChevronRight,
  ChevronDown,
  Clock,
  Sparkles,
  Pencil,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { FileNode } from '../../types';
import { FileIcon, FolderIcon } from '../../components/icons/FileIcon';
import { runtimeInstance } from '../../runtime/client';
import { ExplorerInlineNameEditor } from './ExplorerInlineNameEditor';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { ExplorerContextMenu, type ContextMenuTarget } from './ExplorerContextMenu';
import { getMediobotPresentation } from '../mediobots/presentation';
import RubberSegment from '../../components/RubberSegment';
import AnimatedList from '../../components/AnimatedList';
import FuseButton from '../../components/FuseButton';

const DEFAULT_PROJECT_TREE: FileNode[] = [];

const formatShortModel = (key?: string): string => {
  if (!key) return 'Default';
  if (key.includes('MiniMax')) return 'MiniMax M2.7';
  if (key.includes('diffusiongemma')) return 'DiffGemma';
  if (key.includes('gpt-4o-mini')) return 'GPT-4o mini';
  if (key.includes('gpt-4o')) return 'GPT-4o';
  if (key.includes('claude-3-5-sonnet') || key.includes('claude')) return 'Claude 3.5';
  if (key.includes('gemini-2.5-pro')) return 'Gemini Pro';
  if (key.includes('gemini-2.5-flash')) return 'Gemini Flash';
  const parts = key.split('/');
  return parts[parts.length - 1].slice(0, 11);
};

export const ThreadsDrawer: React.FC = () => {
  const {
    isSidebarOpen,
    isSettingsView,
    sidebarTab,
    setSidebarTab,
    openedFolderName,
    openFileTab,
    openChatTab,
    activeProject,
    activeTabPath,
    threads,
    activeThreadId,
    setActiveThreadId,
    createNewChat,
    setActiveModal,
    agents,
    selectedMediobotId,
    selectAgent,
    getAgentPreference,
    syncRenamedEntry,
    syncDeletedEntry,
    deleteThread,
    renameThread,
    workspaceStatus,
    treeVersion,
    openProjectDirectory,
    theme,
  } = useApp();
  const isLight = theme === 'light';
  const specialistAgents = agents.filter((agent) => agent.group === 'specialist');

  const [treeData, setTreeData] = useState<FileNode[]>(DEFAULT_PROJECT_TREE);
  const [isRootExpanded, setIsRootExpanded] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('mediobot_explorer_root_expanded');
      if (saved !== null) {
        return JSON.parse(saved) === true;
      }
    } catch {
      // ignore
    }
    return true;
  });

  useEffect(() => {
    try {
      localStorage.setItem('mediobot_explorer_root_expanded', JSON.stringify(isRootExpanded));
    } catch {
      // ignore
    }
  }, [isRootExpanded]);

  const [selectedPath, setSelectedPath] = useState<string | null>(() => {
    try {
      return localStorage.getItem('mediobot_explorer_selected_path') || null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      if (selectedPath !== null) {
        localStorage.setItem('mediobot_explorer_selected_path', selectedPath);
      } else {
        localStorage.removeItem('mediobot_explorer_selected_path');
      }
    } catch {
      // ignore
    }
  }, [selectedPath]);

  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('mediobot_explorer_expanded_folders');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {
      // ignore
    }
    return {};
  });

  useEffect(() => {
    try {
      localStorage.setItem('mediobot_explorer_expanded_folders', JSON.stringify(expandedFolders));
    } catch {
      // ignore
    }
  }, [expandedFolders]);

  // Inline creation state (New File / New Folder)
  const [inlineCreating, setInlineCreating] = useState<{
    type: 'file' | 'folder';
    parentPath: string;
  } | null>(null);

  // Inline rename state
  const [renamingNode, setRenamingNode] = useState<{
    path: string;
    name: string;
    isFolder: boolean;
  } | null>(null);

  // Delete modal state
  const [deletingNode, setDeletingNode] = useState<{
    path: string;
    name: string;
    isFolder: boolean;
  } | null>(null);

  // Parallel deleting threads state & timers
  const [deletingThreadIds, setDeletingThreadIds] = useState<Set<string>>(new Set());
  const deleteTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clean up all pending deletion timers on unmount
  useEffect(() => {
    return () => {
      deleteTimersRef.current.forEach((timer) => clearTimeout(timer));
      deleteTimersRef.current.clear();
    };
  }, []);

  const confirmDeleteThread = useCallback(
    (threadId: string) => {
      const timer = deleteTimersRef.current.get(threadId);
      if (timer) clearTimeout(timer);
      deleteTimersRef.current.delete(threadId);
      setDeletingThreadIds((prev) => {
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });
      deleteThread(threadId);
    },
    [deleteThread]
  );

  const startDeletingThread = useCallback(
    (threadId: string) => {
      setDeletingThreadIds((prev) => {
        const next = new Set(prev);
        next.add(threadId);
        return next;
      });
      const timer = setTimeout(() => {
        confirmDeleteThread(threadId);
      }, 2500);
      deleteTimersRef.current.set(threadId, timer);
    },
    [confirmDeleteThread]
  );

  const undoDeleteThread = useCallback((threadId: string) => {
    const timer = deleteTimersRef.current.get(threadId);
    if (timer) clearTimeout(timer);
    deleteTimersRef.current.delete(threadId);
    setDeletingThreadIds((prev) => {
      const next = new Set(prev);
      next.delete(threadId);
      return next;
    });
  }, []);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    target: ContextMenuTarget;
    x: number;
    y: number;
  } | null>(null);

  const [explorerMessage, setExplorerMessage] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    if (!activeProject.id) {
      setTreeData([]);
      return;
    }
    let mounted = true;
    runtimeInstance
      .listFiles(activeProject.id)
      .then((entries: FileNode[]) => {
        if (mounted) setTreeData(entries);
      })
      .catch(() => {
        if (mounted) setTreeData([]);
      });
    return () => {
      mounted = false;
    };
  }, [activeProject.id, treeVersion]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => ({ ...prev, [path]: !prev[path] }));
    setSelectedPath(path);
  };

  // ONE canonical open-folder command — same as Composer's Open button.
  // Must NOT open ProjectModal; must invoke the native OS directory picker
  // via POST /api/workspace/open → nativePicker.ts → osascript / PowerShell.
  const handleOpenFolderClick = () => openProjectDirectory();

  const handleStartNewFile = (parentPath?: string) => {
    let target = parentPath;
    if (target === undefined) {
      target = selectedPath && !selectedPath.includes('.') ? selectedPath : '';
    }
    setExplorerMessage('');
    setInlineCreating({ type: 'file', parentPath: target });
    if (target) {
      setExpandedFolders((prev) => ({ ...prev, [target]: true }));
    } else {
      setIsRootExpanded(true);
    }
  };

  const handleStartNewFolder = (parentPath?: string) => {
    let target = parentPath;
    if (target === undefined) {
      target = selectedPath && !selectedPath.includes('.') ? selectedPath : '';
    }
    setExplorerMessage('');
    setInlineCreating({ type: 'folder', parentPath: target });
    if (target) {
      setExpandedFolders((prev) => ({ ...prev, [target]: true }));
    } else {
      setIsRootExpanded(true);
    }
  };

  const handleRefreshExplorer = () => {
    if (!activeProject.id) return;
    setIsRefreshing(true);
    runtimeInstance
      .listFiles(activeProject.id)
      .then((entries: FileNode[]) => setTreeData(entries))
      .catch(() => setTreeData([]))
      .finally(() => setIsRefreshing(false));
  };

  const handleCollapseAll = () => {
    setExpandedFolders({});
  };

  const handleCommitInlineCreate = async (name: string) => {
    if (!inlineCreating || !activeProject.id) return;
    try {
      await runtimeInstance.createFileEntry(activeProject.id, inlineCreating.parentPath, name, inlineCreating.type);
      const entries = (await runtimeInstance.listFiles(activeProject.id)) as FileNode[];
      setTreeData(entries);
      const newPath = inlineCreating.parentPath ? `${inlineCreating.parentPath}/${name}` : name;
      if (inlineCreating.type === 'file') {
        openFileTab(newPath, name);
        setSelectedPath(newPath);
      } else {
        setExpandedFolders((prev) => ({ ...prev, [newPath]: true }));
        setSelectedPath(newPath);
      }
      setExplorerMessage(`${inlineCreating.type === 'file' ? 'File' : 'Folder'} created.`);
    } catch (err) {
      setExplorerMessage(err instanceof Error ? err.message : 'Creation failed.');
      throw err;
    } finally {
      setInlineCreating(null);
    }
  };

  const handleCommitRename = async (newName: string) => {
    if (!renamingNode || !activeProject.id) return;
    try {
      await runtimeInstance.renameFileEntry(activeProject.id, renamingNode.path, newName);
      const parent = renamingNode.path.split('/').slice(0, -1).join('/');
      const newPath = parent ? `${parent}/${newName}` : newName;
      syncRenamedEntry(renamingNode.path, newPath, renamingNode.isFolder);
      const entries = (await runtimeInstance.listFiles(activeProject.id)) as FileNode[];
      setTreeData(entries);
      setSelectedPath(newPath);
      setExplorerMessage(`${renamingNode.isFolder ? 'Folder' : 'File'} renamed.`);
    } catch (err) {
      setExplorerMessage(err instanceof Error ? err.message : 'Rename failed.');
      throw err;
    } finally {
      setRenamingNode(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingNode || !activeProject.id) return;
    try {
      await runtimeInstance.deleteFileEntry(activeProject.id, deletingNode.path);
      syncDeletedEntry(deletingNode.path, deletingNode.isFolder);
      const entries = (await runtimeInstance.listFiles(activeProject.id)) as FileNode[];
      setTreeData(entries);
      if (selectedPath === deletingNode.path) setSelectedPath(null);
      setExplorerMessage(`${deletingNode.isFolder ? 'Folder' : 'File'} deleted.`);
    } catch (err) {
      setExplorerMessage(err instanceof Error ? err.message : 'Deletion failed.');
    } finally {
      setDeletingNode(null);
    }
  };

  const handleTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (inlineCreating || renamingNode || deletingNode || contextMenu) return;

    const visible: Array<{ path: string; isFolder: boolean; name: string; parentPath: string }> = [
      { path: '', isFolder: true, name: activeProject.name, parentPath: '' },
    ];

    if (isRootExpanded) {
      const walk = (nodes: FileNode[], parent: string) => {
        for (const n of nodes) {
          visible.push({ path: n.path, isFolder: n.type === 'folder', name: n.name, parentPath: parent });
          if (n.type === 'folder' && expandedFolders[n.path] && n.children) {
            walk(n.children, n.path);
          }
        }
      };
      walk(treeData, '');
    }

    const currentIdx = visible.findIndex((item) => item.path === (selectedPath ?? ''));

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = Math.min(visible.length - 1, currentIdx + 1);
      setSelectedPath(visible[nextIdx].path);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIdx = Math.max(0, currentIdx - 1);
      setSelectedPath(visible[prevIdx].path);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (currentIdx >= 0) {
        const item = visible[currentIdx];
        if (item.path === '') {
          setIsRootExpanded(true);
        } else if (item.isFolder) {
          setExpandedFolders((prev) => ({ ...prev, [item.path]: true }));
        }
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (currentIdx >= 0) {
        const item = visible[currentIdx];
        if (item.path === '') {
          setIsRootExpanded(false);
        } else if (item.isFolder && expandedFolders[item.path]) {
          setExpandedFolders((prev) => ({ ...prev, [item.path]: false }));
        } else if (item.parentPath !== undefined) {
          setSelectedPath(item.parentPath);
        }
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (currentIdx >= 0) {
        const item = visible[currentIdx];
        if (item.path === '') {
          setIsRootExpanded((prev) => !prev);
        } else if (item.isFolder) {
          toggleFolder(item.path);
        } else {
          openFileTab(item.path, item.name);
        }
      }
    }
  };

  // Deduplicate threads by unique id to prevent duplicate keys in history list
  const uniqueThreads = useMemo(() => {
    const seen = new Set<string>();
    return (threads || []).filter((t) => {
      if (!t.id || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }, [threads]);

  const allItems = useMemo(
    () => uniqueThreads.map((t) => ({ id: t.id, title: t.title })),
    [uniqueThreads]
  );

  const filteredItems = useMemo(
    () => allItems.filter((item) => item.title.toLowerCase().includes(searchQuery.toLowerCase())),
    [allItems, searchQuery]
  );

  const animatedHistoryItems = useMemo(() => {
    return filteredItems.map((item) => ({
      id: item.id,
      title: item.title,
      isDeleting: deletingThreadIds.has(String(item.id)),
      deleteFuseMs: 2500,
    }));
  }, [filteredItems, deletingThreadIds]);

  const activeHistoryIndex = useMemo(() => {
    return filteredItems.findIndex((item) => item.id === activeThreadId);
  }, [filteredItems, activeThreadId]);

  // Render recursive file tree with VS Code automatic icon resolution
  const renderTree = (nodes: FileNode[], depth = 1, currentParentPath = '') => {
    return (
      <>
        {nodes.map((node) => {
          const isFolder = node.type === 'folder';
          const isExpanded = expandedFolders[node.path];
          const isSelected = selectedPath === node.path || (!isFolder && activeTabPath === node.path);
          const isRenaming = renamingNode?.path === node.path;

          if (isRenaming) {
            return (
              <div key={node.path} className="my-0.5">
                <ExplorerInlineNameEditor
                  mode="RENAME"
                  initialValue={node.name}
                  depth={depth}
                  onCommit={handleCommitRename}
                  onCancel={() => setRenamingNode(null)}
                />
              </div>
            );
          }

          const isDeletingNode = deletingNode && deletingNode.path === node.path;

          return (
            <div key={node.path} className="select-none">
              <div
                onClick={() => {
                  if (isDeletingNode) return;
                  setSelectedPath(node.path);
                  if (isFolder) {
                    toggleFolder(node.path);
                  } else {
                    openFileTab(node.path, node.name);
                  }
                }}
                onContextMenu={(e) => {
                  if (isDeletingNode) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setSelectedPath(node.path);
                  setContextMenu({
                    target: { type: isFolder ? 'folder' : 'file', path: node.path, name: node.name },
                    x: e.clientX,
                    y: e.clientY,
                  });
                }}
                style={{ paddingLeft: `${depth * 12 + 6}px` }}
                className={`relative flex items-center gap-1.5 py-1 pr-2 rounded-md text-[12px] transition-all cursor-pointer group overflow-hidden ${
                  isDeletingNode
                    ? isLight
                      ? 'border-2 border-red-500 bg-red-50/90 text-red-950 font-medium shadow-xs'
                      : 'border-2 border-red-500 bg-[#2b161e] text-red-100 font-medium shadow-xs'
                    : isSelected
                    ? isLight
                      ? 'bg-[#ffffff] text-[#09090b] font-medium border border-[#dcdce2] shadow-xs'
                      : 'bg-[#2b2a33] text-white font-medium shadow-xs'
                    : isLight
                    ? 'text-[#374151] hover:text-[#09090b] hover:bg-[#eaebee]'
                    : 'text-neutral-300 hover:text-white hover:bg-[#202024]'
                }`}
              >
                {isFolder ? (
                  <>
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                    )}
                    <FolderIcon name={node.name} isOpen={Boolean(isExpanded)} className="w-3.5 h-3.5 shrink-0" />
                  </>
                ) : (
                  <>
                    <span className="w-3.5 shrink-0" />
                    <FileIcon filename={node.name} className="w-3.5 h-3.5 shrink-0" />
                  </>
                )}

                <span className="truncate flex-1">{node.name}</span>

                {isDeletingNode ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeletingNode(null);
                    }}
                    className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-red-600 hover:bg-red-700 text-white text-[11px] font-semibold shadow-xs active:scale-95 transition-all cursor-pointer z-10"
                  >
                    <RotateCcw className="w-3 h-3 stroke-[2.5]" />
                    <span>Undo</span>
                  </button>
                ) : (
                  <span className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      aria-label={`Rename ${node.name}`}
                      title={`Rename ${node.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenamingNode({ path: node.path, name: node.name, isFolder });
                      }}
                      className={`p-1 rounded cursor-pointer ${
                        isLight
                          ? 'hover:bg-[#dedee5] text-[#6b6a75] hover:text-[#09090b]'
                          : 'hover:bg-[#35343d] text-neutral-400 hover:text-white'
                      }`}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      aria-label={`Delete ${node.name}`}
                      title={`Delete ${node.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeletingNode({ path: node.path, name: node.name, isFolder });
                      }}
                      className={`p-1 rounded cursor-pointer ${
                        isLight
                          ? 'hover:bg-red-100 text-[#6b6a75] hover:text-red-700'
                          : 'hover:bg-red-950/60 text-neutral-400 hover:text-red-200'
                      }`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </span>
                )}

                {isDeletingNode && (
                  <div
                    className="absolute inset-x-0 bottom-0 h-[2px] bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)] animate-fuse-burn origin-left pointer-events-none"
                    style={{ animationDuration: '8000ms' }}
                    onAnimationEnd={() => {
                      handleConfirmDelete();
                    }}
                  />
                )}
              </div>

              {/* Children and inline creating within this folder */}
              {isFolder && isExpanded && (
                <div>
                  {inlineCreating && inlineCreating.parentPath === node.path && (
                    <div className="my-0.5">
                      <ExplorerInlineNameEditor
                        mode={inlineCreating.type === 'file' ? 'CREATE_FILE' : 'CREATE_FOLDER'}
                        depth={depth + 1}
                        onCommit={handleCommitInlineCreate}
                        onCancel={() => setInlineCreating(null)}
                      />
                    </div>
                  )}
                  {renderTree(node.children || [], depth + 1, node.path)}
                </div>
              )}
            </div>
          );
        })}
      </>
    );
  };

  return (
    <>
      <aside
        className={`h-[calc(100vh-44px)] mt-11 rounded-tl-[24px] border-r flex flex-col shrink-0 select-none z-10 overflow-hidden relative [transform:translateZ(0)] will-change-[width,opacity] transition-[width,opacity,border-color] duration-[320ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
          isLight
            ? 'bg-white/70 backdrop-blur-2xl backdrop-saturate-[180%] border-[#e0e0e8]/80 text-[#111827] shadow-[inset_0_1px_1px_0_rgba(255,255,255,0.9),inset_-1px_0_0_0_rgba(255,255,255,0.45),0_10px_30px_rgba(0,0,0,0.04)]'
            : 'bg-[#141419] border-[#222127] text-[#e4e4e7] shadow-none'
        } ${
          isSettingsView
            ? 'w-0 opacity-0 border-transparent pointer-events-none hidden'
            : isSidebarOpen
            ? 'w-[270px] opacity-100'
            : 'w-0 opacity-0 border-transparent pointer-events-none'
        }`}
      >
        {/* Liquid frost top sheen highlight (light mode only) */}
        {isLight && (
          <div className="absolute top-0 left-0 right-0 h-[1.5px] bg-gradient-to-r from-white/70 via-white/30 to-transparent pointer-events-none z-20 rounded-tl-[24px]" />
        )}
        {/* Liquid frost subtle crystalline glow (light mode only) */}
        {isLight && (
          <div className="absolute -top-10 -left-10 w-28 h-28 bg-white/25 rounded-full blur-xl pointer-events-none z-0" />
        )}

        {/* Rigid-width inner wrapper: prevents internal reflow while sliding with buttery smooth transform */}
        <div
          className={`w-[270px] min-w-[270px] h-full flex flex-col relative z-10 will-change-transform transition-transform duration-[320ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
            isSidebarOpen ? 'translate-x-0' : '-translate-x-6'
          }`}
        >
          {/* 1. Header Segmented Toggle: [ Home / Project Folder ] vs [ History ] (RubberSegment from React Bits) */}
          {sidebarTab !== 'maestro' && (
            <div className="w-[270px] min-w-[270px] px-3 pt-3 pb-1.5 flex items-center justify-between shrink-0 rounded-tl-[24px]">
              <RubberSegment
                items={[
                  {
                    value: 'home',
                    label: 'Home',
                    icon: <Folder className="w-3.5 h-3.5 stroke-[1.8]" />
                  },
                  {
                    value: 'history',
                    label: 'History',
                    icon: <Clock className="w-3.5 h-3.5 stroke-[1.8]" />
                  }
                ]}
                value={sidebarTab === 'history' ? 'history' : 'home'}
                onChange={(val) => setSidebarTab(val as 'home' | 'history')}
                trackColor={isLight ? '#eaebee' : '#202025'}
                thumbColor={isLight ? '#ffffff' : '#2e2d36'}
                textColor={isLight ? '#6b6a75' : '#a1a1aa'}
                activeTextColor={isLight ? '#09090b' : '#ffffff'}
                size="sm"
                radius={10}
                inset={2}
                equalSlots
                stretch={100}
                squash={3}
                speed={1}
                glide={75}
                draggable
                className="w-full shadow-xs"
              />
            </div>
          )}

      {/* 2. DYNAMIC CONTENT: Home (Project Folder Explorer) vs History (Chat Threads) vs Maestro (Empty Aside Bar) */}
      {sidebarTab === 'maestro' ? (
        /* MAESTRO ASIDE: Dedicated MedioBots & Maestro Agents Workspace */
        <div className="w-[270px] min-w-[270px] flex-1 flex flex-col min-h-0 select-none">
          {/* 1. Header: Maestro Row with count matching uploaded reference */}
          <div className="px-3.5 pt-3.5 pb-1 shrink-0">
            {(() => {
              const maestroPref = getAgentPreference('maestro');
              return (
                <button
                  onClick={() => selectAgent('maestro')}
                  data-testid="mediobot-select-maestro"
                  aria-pressed={selectedMediobotId === 'maestro'}
                  title={`Maestro (${formatShortModel(maestroPref.modelKey)} · ${maestroPref.effort}) — Team orchestration`}
                  className={`w-full flex items-center justify-between p-2 rounded-xl transition-all cursor-pointer group ${
                    selectedMediobotId === 'maestro'
                      ? isLight
                        ? 'bg-[#ffffff] text-[#09090b] shadow-xs border border-[#dcdce2]'
                        : 'bg-[#232328] text-white shadow-xs'
                      : isLight
                      ? 'hover:bg-[#eaebee] text-[#18181b]'
                      : 'hover:bg-[#202025] text-neutral-200'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Signature white circle with two vertical blinking eyes */}
                    <div className="w-[22px] h-[22px] rounded-full bg-[#f4f4f5] flex items-center justify-center gap-[2.5px] shrink-0 shadow-xs transition-transform group-hover:scale-105">
                      <span
                        className="w-[2.2px] h-[7px] rounded-full bg-black animate-eye-blink block"
                        style={{ animationDelay: '0.2s' }}
                      />
                      <span
                        className="w-[2.2px] h-[7px] rounded-full bg-black animate-eye-blink block"
                        style={{ animationDelay: '0.2s' }}
                      />
                    </div>
                    <div className="flex flex-col min-w-0 text-left">
                      <span className={`font-semibold text-[14.5px] tracking-tight ${isLight ? 'text-[#09090b]' : 'text-neutral-100'}`}>
                        Maestro
                      </span>
                      <span className={`text-[10.5px] font-mono leading-none mt-0.5 ${isLight ? 'text-neutral-500' : 'text-neutral-400'}`}>
                        {formatShortModel(maestroPref.modelKey)} · {maestroPref.effort}
                      </span>
                    </div>
                  </div>

                  {/* Agent Count Pill matching screenshot */}
                  <span className={`text-[12px] px-2 py-0.5 rounded-full ${isLight ? 'bg-[#eaebee] text-[#6b6a75]' : 'bg-[#27272e] text-neutral-400'} font-normal`}>
                    {specialistAgents.length}
                  </span>
                </button>
              );
            })()}

            {/* Horizontal separation line matching image */}
            <div className={`w-full h-[1px] ${isLight ? 'bg-[#dcdce2]' : 'bg-[#292830]'} my-2.5`} />
          </div>

          {/* 2. Scrollable Dynamic MedioBots List matching uploaded reference */}
          <div className="flex-1 overflow-y-auto px-3.5 space-y-2 scrollbar-thin scrollbar-thumb-neutral-700 pb-4">
            {specialistAgents.map((agent) => {
              const isSelected = selectedMediobotId === agent.id;
              const isWorking = agent.status === 'working';
              const avatar = getMediobotPresentation(agent.id, agent.name, agent.role);
              const botPref = getAgentPreference(agent.id);

              return (
                <button
                  key={agent.id}
                  onClick={() => selectAgent(agent.id)}
                  data-testid={`mediobot-select-${agent.id}`}
                  aria-pressed={isSelected}
                  title={`${agent.name} · ${agent.activityState ?? agent.status} (${formatShortModel(botPref.modelKey)} · ${botPref.effort}) — ${agent.role || ''}`}
                  data-activity-state={agent.activityState ?? agent.status}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer text-left group ${
                    isSelected
                      ? isLight
                        ? 'bg-[#ffffff] text-[#09090b] shadow-xs border border-[#dcdce2]'
                        : 'bg-[#2f2e36] text-white shadow-xs border border-[#3a3944]'
                      : isLight
                      ? 'hover:bg-[#eaebee] text-[#374151] hover:text-[#09090b] border border-transparent'
                      : 'hover:bg-[#32313a] text-neutral-300 hover:text-white border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Circle Avatar with two vertical blinking eyes */}
                    <div
                      className={`w-[22px] h-[22px] rounded-full ${avatar.avatar} flex items-center justify-center gap-[2.5px] shrink-0 shadow-xs transition-transform group-hover:scale-105`}
                    >
                      <span
                        className={`w-[2.2px] h-[7px] rounded-full ${avatar.eye} animate-eye-blink block`}
                        style={{ animationDelay: avatar.delay }}
                      />
                      <span
                        className={`w-[2.2px] h-[7px] rounded-full ${avatar.eye} animate-eye-blink block`}
                        style={{ animationDelay: avatar.delay }}
                      />
                    </div>

                    {/* Agent Name & configured model pill */}
                    <div className="flex items-center justify-between gap-1.5 min-w-0 flex-1">
                      <span
                        className={`truncate text-[14.5px] font-medium transition-colors ${isLight ? avatar.lightText : avatar.darkText}`}
                      >
                        {agent.name}
                      </span>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md shrink-0 transition-colors ${
                          isSelected
                            ? isLight
                              ? 'bg-black/5 text-neutral-800 font-semibold'
                              : 'bg-white/10 text-white font-medium'
                            : isLight
                            ? 'bg-[#eaebee] text-neutral-500'
                            : 'bg-[#25252c] text-neutral-400'
                        }`}
                      >
                        {formatShortModel(botPref.modelKey)} · {botPref.effort}
                      </span>
                    </div>
                  </div>

                  {/* Subtle active status indicator dot when working */}
                  {isWorking && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping mr-1 shrink-0 ml-1.5" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : sidebarTab === 'home' ? (
        /* HOME ASIDE: Opened Project Folder File Tree or No Folder Opened */
        <div className="w-[270px] min-w-[270px] flex-1 flex flex-col min-h-0">
          {!openedFolderName || workspaceStatus === 'EMPTY' ? (
            /* Matches uploaded screenshot: "No Folder Opened" */
            <div className="p-3.5 flex flex-col items-start select-none">
              <div className={`flex items-center gap-1.5 text-[13px] font-medium ${isLight ? 'text-[#09090b]' : 'text-neutral-200'} mb-2.5`}>
                <ChevronDown className="w-4 h-4 text-neutral-400 stroke-[2]" />
                <span>No Folder Opened</span>
              </div>

              <p className={`text-[12.5px] ${isLight ? 'text-[#64748b]' : 'text-neutral-400'} mb-4 pl-5`}>
                You have not yet opened a folder.
              </p>

              <div className="w-full px-5">
                <button
                  onClick={handleOpenFolderClick}
                  className="w-full py-2 px-4 rounded-lg bg-[#0078d4] hover:bg-[#0086f0] text-white text-[13px] font-medium transition-all shadow-sm text-center cursor-pointer active:scale-98"
                >
                  Open Folder
                </button>
              </div>
            </div>
          ) : (
            /* Opened Folder File Tree */
            <div className="flex-1 flex flex-col min-h-0">
              {/* Opened Folder Header Bar matching Antigravity toolbar */}
              <div className={`px-3 py-2 flex items-center justify-between border-b ${isLight ? 'border-[#dcdce2]' : 'border-[#222127]'} shrink-0 select-none`}>
                {/* Left side: Pure EXPLORER label */}
                <div className="flex items-center min-w-0">
                  <span className={`text-[11px] font-semibold tracking-wider ${isLight ? 'text-[#64748b]' : 'text-neutral-400'} uppercase select-none`}>
                    Explorer
                  </span>
                </div>

                {/* Right side toolbar: 4 controls in exact order [New File] [New Folder] [Refresh] [Collapse All] */}
                <div className={`flex items-center gap-0.5 ${isLight ? 'text-[#6b6a75]' : 'text-neutral-400'}`}>
                  {/* 1. New File */}
                  <button
                    onClick={() => handleStartNewFile()}
                    title="New File"
                    aria-label="New File"
                    className={`p-1 rounded transition-colors cursor-pointer group relative ${
                      isLight
                        ? 'hover:bg-[#dedee5] hover:text-[#09090b] text-[#6b6a75]'
                        : 'hover:bg-[#282730] hover:text-white text-neutral-400'
                    }`}
                  >
                    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <path d="M9 1.5H3.5A1 1 0 0 0 2.5 2.5V13.5A1 1 0 0 0 3.5 14.5H12.5A1 1 0 0 0 13.5 13.5V6L9 1.5Z" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M9 1.5V6H13.5" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M8 10.5H12" strokeLinecap="round" />
                      <path d="M10 8.5V12.5" strokeLinecap="round" />
                    </svg>
                  </button>

                  {/* 2. New Folder */}
                  <button
                    onClick={() => handleStartNewFolder()}
                    title="New Folder"
                    aria-label="New Folder"
                    className={`p-1 rounded transition-colors cursor-pointer group relative ${
                      isLight
                        ? 'hover:bg-[#dedee5] hover:text-[#09090b] text-[#6b6a75]'
                        : 'hover:bg-[#282730] hover:text-white text-neutral-400'
                    }`}
                  >
                    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <path d="M1.5 3.5A1 1 0 0 1 2.5 2.5H6L7.5 4.5H13.5A1 1 0 0 1 14.5 5.5V8" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M1.5 5.5V12.5A1 1 0 0 0 2.5 13.5H8" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M11 11.5H15" strokeLinecap="round" />
                      <path d="M13 9.5V13.5" strokeLinecap="round" />
                    </svg>
                  </button>

                  {/* 3. Refresh Explorer */}
                  <button
                    onClick={handleRefreshExplorer}
                    title="Refresh Explorer"
                    aria-label="Refresh Explorer"
                    className={`p-1 rounded transition-colors cursor-pointer group relative ${
                      isRefreshing ? 'animate-spin text-white' : ''
                    } ${
                      isLight
                        ? 'hover:bg-[#dedee5] hover:text-[#09090b] text-[#6b6a75]'
                        : 'hover:bg-[#282730] hover:text-white text-neutral-400'
                    }`}
                  >
                    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13.5 2.5V6H10" />
                      <path d="M13.2 8.5A5.5 5.5 0 1 1 11.8 4.2L13.5 6" />
                    </svg>
                  </button>

                  {/* 4. Collapse All */}
                  <button
                    onClick={handleCollapseAll}
                    title="Collapse All"
                    aria-label="Collapse All"
                    className={`p-1 rounded transition-colors cursor-pointer group relative ${
                      isLight
                        ? 'hover:bg-[#dedee5] hover:text-[#09090b] text-[#6b6a75]'
                        : 'hover:bg-[#282730] hover:text-white text-neutral-400'
                    }`}
                  >
                    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2.5" y="4.5" width="8" height="8" rx="1.5" />
                      <path d="M5.5 2.5H12A1.5 1.5 0 0 1 13.5 4V10.5" />
                      <line x1="4.5" y1="8.5" x2="8.5" y2="8.5" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Project File Tree with Scrollable Area */}
              <div
                tabIndex={0}
                onKeyDown={handleTreeKeyDown}
                className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-0.5 scrollbar-thin outline-none"
              >
                {explorerMessage && <p className="px-2 py-1 text-[11px] text-neutral-400" role="status">{explorerMessage}</p>}

                {/* Workspace Root Folder Row (Visible & Collapsible) */}
                <div className="select-none mb-0.5">
                  <div
                    onClick={() => {
                      setIsRootExpanded((prev) => !prev);
                      setSelectedPath('');
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({
                        target: { type: 'root', path: '', name: openedFolderName || activeProject.name },
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }}
                    className={`flex items-center gap-1.5 py-1 px-2 rounded-md text-[12px] font-semibold transition-colors duration-150 cursor-pointer group ${
                      selectedPath === ''
                        ? isLight
                          ? 'bg-[#ffffff] text-[#09090b] border border-[#dcdce2] shadow-xs'
                          : 'bg-[#2b2a33] text-white shadow-xs'
                        : isLight
                        ? 'text-[#18181b] hover:text-[#09090b] hover:bg-[#eaebee]'
                        : 'text-neutral-200 hover:text-white hover:bg-[#202024]'
                    }`}
                  >
                    {isRootExpanded ? (
                      <ChevronDown className={`w-3.5 h-3.5 stroke-[2] shrink-0 transition-colors duration-150 ${isLight ? 'text-[#64748b] group-hover:text-[#09090b]' : 'text-neutral-400 group-hover:text-white'}`} />
                    ) : (
                      <ChevronRight className={`w-3.5 h-3.5 stroke-[2] shrink-0 transition-colors duration-150 ${isLight ? 'text-[#64748b] group-hover:text-[#09090b]' : 'text-neutral-400 group-hover:text-white'}`} />
                    )}
                    <Folder className="w-3.5 h-3.5 text-[#e5a93c] shrink-0" />
                    <span
                      className={`truncate flex-1 font-mono text-[11.5px] transition-colors duration-150 ${
                        selectedPath === ''
                          ? isLight
                            ? 'text-[#09090b]'
                            : 'text-white'
                          : isLight
                          ? 'text-[#18181b] group-hover:text-[#09090b]'
                          : 'text-neutral-200 group-hover:text-white'
                      }`}
                    >
                      {openedFolderName || activeProject.name}
                    </span>
                  </div>

                  {/* Children of root */}
                  {isRootExpanded && (
                    <div className="mt-0.5">
                      {inlineCreating && inlineCreating.parentPath === '' && (
                        <div className="my-0.5">
                          <ExplorerInlineNameEditor
                            mode={inlineCreating.type === 'file' ? 'CREATE_FILE' : 'CREATE_FOLDER'}
                            depth={1}
                            onCommit={handleCommitInlineCreate}
                            onCancel={() => setInlineCreating(null)}
                          />
                        </div>
                      )}
                      {renderTree(treeData, 1, '')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* HISTORY ASIDE: Search + New Chat + Chat History List */
        <div className="w-[270px] min-w-[270px] flex-1 flex flex-col min-h-0">
          {/* Header Row: "MedioBot" + Bell + Search */}
          <div className="w-[270px] min-w-[270px] h-9 px-4 py-1 flex items-center justify-between shrink-0">
            <button
              onClick={() => setActiveModal('projects')}
              className={`flex items-center text-[13.5px] font-semibold ${isLight ? 'text-[#09090b] hover:text-[#27272a]' : 'text-white hover:text-neutral-200'} transition-colors cursor-pointer`}
              title="Switch workspace / project"
            >
              <span>MedioBot</span>
            </button>

            <div className="flex items-center gap-1">
              <button
                onClick={() => setActiveModal('shortcuts')}
                title="Notifications"
                className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors cursor-pointer ${
                  isLight
                    ? 'text-[#6b6a75] hover:text-[#09090b] hover:bg-[#dedee5]'
                    : 'text-neutral-400 hover:text-white hover:bg-[#222227]'
                }`}
              >
                <Bell className="w-3.5 h-3.5 stroke-[1.75]" />
              </button>
              <button
                onClick={() => setIsSearchOpen((prev) => !prev)}
                title="Search chats"
                className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors cursor-pointer ${
                  isSearchOpen
                    ? isLight ? 'text-[#09090b] bg-[#dedee5]' : 'text-white bg-[#26262b]'
                    : isLight ? 'text-[#6b6a75] hover:text-[#09090b] hover:bg-[#dedee5]' : 'text-neutral-400 hover:text-white hover:bg-[#222227]'
                }`}
              >
                <Search className="w-3.5 h-3.5 stroke-[1.75]" />
              </button>
            </div>
          </div>

          {/* New Chat Action Button */}
          <div className="w-[270px] min-w-[270px] px-3 pt-1 pb-1.5 shrink-0">
            {isSearchOpen && (
              <div className="mb-2 flex items-center gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search conversations..."
                  autoFocus
                  className={`w-full ${
                    isLight
                      ? 'bg-[#ffffff] text-[#09090b] placeholder-[#9ca3af] border-[#dcdce2] focus:border-[#0284c7]'
                      : 'bg-[#121214] text-white placeholder-neutral-500 border-[#2b2b32] focus:border-neutral-400'
                  } text-xs rounded-md px-2.5 py-1.5 outline-none border`}
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className={`cursor-pointer ${isLight ? 'text-[#6b6a75] hover:text-[#09090b]' : 'text-neutral-400 hover:text-white'}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}

            <button
              onClick={() => {
                createNewChat();
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[12.5px] font-medium rounded-lg transition-colors cursor-pointer ${
                isLight
                  ? 'text-[#18181b] hover:text-[#09090b] hover:bg-[#eaebee]'
                  : 'text-neutral-200 hover:text-white hover:bg-[#222227]'
              }`}
            >
              <SquarePen className={`w-4 h-4 ${isLight ? 'text-[#6b6a75]' : 'text-neutral-300'} stroke-[1.75]`} />
              <span>New chat</span>
            </button>
          </div>

          {/* Scrollable History List with AnimatedList */}
          <div className="w-[270px] min-w-[270px] flex-1 overflow-hidden px-2">
            {filteredItems.length === 0 ? (
              <div className={`px-3 py-6 text-center text-xs ${isLight ? 'text-[#9ca3af]' : 'text-neutral-500'}`}>
                {searchQuery ? 'No matching conversations' : 'No conversations yet'}
              </div>
            ) : (
              <AnimatedList
                items={animatedHistoryItems}
                initialSelectedIndex={activeHistoryIndex}
                onItemSelect={(selectedItem) => {
                  if (selectedItem && typeof selectedItem === 'object' && selectedItem.id) {
                    if (deletingThreadIds.has(String(selectedItem.id))) return;
                    openChatTab(String(selectedItem.id));
                  }
                }}
                renderItem={(itemObj) => {
                  const entry = typeof itemObj === 'object' ? itemObj : { id: itemObj, title: String(itemObj) };
                  const isDeleting = deletingThreadIds.has(String(entry.id));

                  return (
                    <div
                      key={entry.id}
                      onClick={(e) => {
                        if (isDeleting) e.stopPropagation();
                      }}
                      className={`relative w-full flex items-center justify-between text-left group transition-colors ${
                        isLight ? 'text-[#18181b]' : 'text-neutral-200'
                      }`}
                    >
                      <span className="truncate flex-1 pr-2 font-medium text-[13px]">{entry.title}</span>

                      {isDeleting ? (
                        <div className="flex items-center gap-1 shrink-0 z-10" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              undoDeleteThread(String(entry.id));
                            }}
                            title="Undo deletion"
                            className="shrink-0 flex items-center gap-1 px-2.5 py-0.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[11px] font-semibold shadow-xs active:scale-95 transition-all cursor-pointer"
                          >
                            <RotateCcw className="w-3 h-3 stroke-[2.5]" />
                            <span>Undo</span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              confirmDeleteThread(String(entry.id));
                            }}
                            title="Delete immediately"
                            className="p-1 rounded-md text-red-400 hover:text-white hover:bg-red-600/40 transition-all cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <span className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 shrink-0">
                          <button
                            aria-label={`Rename ${entry.title}`}
                            title="Rename conversation"
                            onClick={(e) => {
                              e.stopPropagation();
                              const next = window.prompt('Rename conversation', entry.title);
                              if (next && next.trim() && next.trim() !== entry.title) {
                                renameThread(String(entry.id), next.trim());
                              }
                            }}
                            className={`p-1 transition-colors cursor-pointer ${
                              isLight
                                ? 'text-[#6b6a75] hover:text-[#09090b]'
                                : 'text-neutral-400 hover:text-white'
                            }`}
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            aria-label={`Delete ${entry.title}`}
                            title="Delete conversation"
                            onClick={(e) => {
                              e.stopPropagation();
                              startDeletingThread(String(entry.id));
                            }}
                            className={`p-1 transition-colors cursor-pointer ${
                              isLight
                                ? 'text-[#6b6a75] hover:text-red-600'
                                : 'text-neutral-400 hover:text-red-400'
                            }`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </span>
                      )}
                    </div>
                  );
                }}
                theme={isLight ? 'light' : 'dark'}
                frame={false}
                animation="pop"
                stagger={0.03}
                showGradients={false}
                radius={12}
                gap={6}
                width="100%"
                maxHeight="100%"
                className="w-full h-full"
              />
            )}
          </div>
        </div>
      )}

      {/* 3. COMMON MAESTRO BOTS CARD (Shown for Home and History) */}
      {sidebarTab !== 'maestro' && (
        <div
          className={`w-[246px] min-w-[246px] m-2.5 p-3 rounded-2xl border shrink-0 text-xs transition-all duration-200 flex flex-col shadow-sm ${
            isLight
              ? 'bg-white/85 border-[#e2e4e8] text-[#1f2937] backdrop-blur-xl shadow-[0_4px_20px_rgba(0,0,0,0.04)]'
              : 'bg-[#1c1c20] border-[#28282e] text-[#e5e5e7]'
          }`}
        >
          {/* Fixed Header: Maestro title + avatar + count */}
          <div className="flex items-center justify-between mb-2 shrink-0">
            <div className="flex items-center gap-2">
              {/* Maestro Avatar: Light white medium circle with two vertical black blinking eyes */}
              <div className="w-[18px] h-[18px] rounded-full bg-[#f4f4f5] flex items-center justify-center gap-[2.5px] shrink-0 shadow-xs border border-neutral-300/40">
                <span className="w-[2.5px] h-[7px] rounded-full bg-black animate-eye-blink block" />
                <span className="w-[2.5px] h-[7px] rounded-full bg-black animate-eye-blink block" />
              </div>
              <span className={`font-semibold text-[12px] tracking-tight ${isLight ? 'text-[#09090b]' : 'text-neutral-200'}`}>
                Maestro
              </span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-normal ${
                isLight ? 'bg-[#eaebee] text-[#4b5563]' : 'bg-[#27272d] text-neutral-400'
              }`}>
                {specialistAgents.length}
              </span>
            </div>
          </div>

          {/* Horizontal separation line matching image */}
          <div className={`w-full h-1 rounded-full mb-2.5 shrink-0 ${
            isLight ? 'bg-[#e5e7eb]' : 'bg-[#2b2b32]'
          }`} />

          {/* Scrollable Agents List with Smooth Scrolling */}
          <div className={`space-y-1.5 text-[12px] overflow-y-auto max-h-[160px] scrollbar-thin ${
            isLight ? 'scrollbar-thumb-neutral-300' : 'scrollbar-thumb-neutral-700'
          } pr-1 scroll-smooth`}>
            {specialistAgents.map((agent) => {
              const isWorking = agent.status === 'working';
              const avatar = getMediobotPresentation(agent.id, agent.name, agent.role);

              return (
                <button
                  key={agent.id}
                  onClick={() => selectAgent(agent.id)}
                  title={`${agent.name} · ${agent.activityState ?? agent.status}${agent.currentTask ? `: ${agent.currentTask}` : ''}`}
                  data-activity-state={agent.activityState ?? agent.status}
                  className={`w-full group flex items-center py-2 px-2.5 rounded-xl transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] text-left cursor-pointer ${
                    isLight ? 'hover:bg-[#f1f2f5]' : 'hover:bg-[#32313a]'
                  }`}
                >
                  {/* Status Avatar Circle & Name */}
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    {/* Small circle with two vertical blinking eyes */}
                    <div
                      className={`w-3.5 h-3.5 rounded-full ${avatar.avatar} flex items-center justify-center gap-[2px] shrink-0 shadow-xs transition-transform duration-200 group-hover:scale-105`}
                    >
                      <span className={`w-[2.2px] h-[6px] rounded-full ${avatar.eye} animate-eye-blink block`} />
                      <span className={`w-[2.2px] h-[6px] rounded-full ${avatar.eye} animate-eye-blink block`} />
                    </div>

                    {/* Agent Name with matching circle color */}
                    <span
                      className={`truncate text-[12px] font-medium transition-colors ${isLight ? avatar.lightText : avatar.darkText} ${
                        isWorking ? 'animate-pulse' : ''
                      }`}
                    >
                      {agent.name}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
        </div>
      </aside>



    {contextMenu && (
      <ExplorerContextMenu
        target={contextMenu.target}
        x={contextMenu.x}
        y={contextMenu.y}
        onClose={() => setContextMenu(null)}
        onNewFile={(p) => handleStartNewFile(p)}
        onNewFolder={(p) => handleStartNewFolder(p)}
        onRename={(p, n) => setRenamingNode({ path: p, name: n, isFolder: contextMenu.target.type === 'folder' })}
        onDelete={(p, n, isF) => setDeletingNode({ path: p, name: n, isFolder: isF })}
        onRefresh={handleRefreshExplorer}
        onCollapseAll={handleCollapseAll}
        onOpen={(p, n) => openFileTab(p, n)}
      />
    )}
  </>
  );
};

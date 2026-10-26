import React, { useState, useEffect } from 'react';
import type { ToolExecutionData, ThreadItem } from '../../types';
import {
  BookOpen,
  Search,
  Folder,
  Terminal,
  FileCode,
  Globe,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileText,
} from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { runtimeInstance } from '../../runtime/client';
import { toolOutputFallback } from './toolExecutionFallback';
import { getOutcomeBadge } from './toolExecutionPresentation';

export interface ParsedToolAction {
  id: string;
  icon: 'read' | 'search' | 'list' | 'terminal' | 'edit' | 'web' | 'generic';
  label: string;
  target?: string;
  tool: ToolExecutionData;
}

export function parseToolAction(tool: ToolExecutionData, idPrefix: string = 'tool'): ParsedToolAction {
  const name = (tool.toolName || '').trim();
  const cmd = (tool.command || '').trim();
  const id = tool.toolInvocationId || `${idPrefix}-${name}-${cmd}`;

  // 1. Filesystem Read
  if (name === 'filesystem.read' || cmd.startsWith('filesystem.read')) {
    const rawPath = cmd.replace(/^filesystem\.read\s*/, '').trim();
    let path = rawPath.replace(/^["']|["']$/g, '');
    try {
      if (rawPath.startsWith('{')) {
        const parsed = JSON.parse(rawPath);
        if (parsed.path) path = parsed.path;
      }
    } catch {
      // Keep plain text path
    }
    const fileName = path.split('/').pop() || path || 'file';
    return {
      id,
      icon: 'read',
      label: tool.status === 'running' ? `Reading ${fileName}` : `Read ${fileName}`,
      target: path,
      tool,
    };
  }

  // 2. Filesystem List
  if (name === 'filesystem.list' || cmd.startsWith('filesystem.list')) {
    const rawDir = cmd.replace(/^filesystem\.list\s*/, '').trim();
    let dir = rawDir.replace(/^["']|["']$/g, '');
    try {
      if (rawDir.startsWith('{')) {
        const parsed = JSON.parse(rawDir);
        if (parsed.directory || parsed.path) dir = parsed.directory || parsed.path;
      }
    } catch {
      // Keep plain text dir
    }
    const dirName = dir ? (dir.split('/').filter(Boolean).pop() || dir) : 'workspace';
    return {
      id,
      icon: 'list',
      label: tool.status === 'running' ? `Listing ${dirName}` : `Listed files in ${dirName}`,
      target: dir,
      tool,
    };
  }

  // 3. Search / Grep
  if (name.includes('search') || cmd.startsWith('filesystem.search') || cmd.startsWith('project.search') || cmd.startsWith('search')) {
    const query = cmd.replace(/^(filesystem|project)\.search\s*/, '').trim();
    return {
      id,
      icon: 'search',
      label: tool.status === 'running' ? `Searching for ${query}` : `Searched for ${query}`,
      target: query,
      tool,
    };
  }

  // 4. Terminal Command
  if (name === 'terminal.execute' || cmd.startsWith('terminal.execute') || name.startsWith('terminal')) {
    const execCmd = cmd.replace(/^terminal\.execute\s*/, '').trim();
    let displayCmd = execCmd.replace(/^["']|["']$/g, '');
    try {
      if (execCmd.startsWith('{')) {
        const parsed = JSON.parse(execCmd);
        if (parsed.command) displayCmd = parsed.command;
      }
    } catch {
      // Keep plain command
    }
    return {
      id,
      icon: 'terminal',
      label: tool.status === 'running' ? `Running ${displayCmd}` : `Ran ${displayCmd}`,
      target: displayCmd,
      tool,
    };
  }

  // 5. File Edit / Write
  if (name.includes('write') || name.includes('edit')) {
    const rawPath = cmd.replace(/^filesystem\.(write|edit)\s*/, '').trim();
    const fileName = rawPath.split('/').pop() || rawPath || 'file';
    return {
      id,
      icon: 'edit',
      label: tool.status === 'running' ? `Writing ${fileName}` : `Edited ${fileName}`,
      target: rawPath,
      tool,
    };
  }

  // 6. Browser / Web
  if (name.includes('browser') || name.includes('vision') || name.includes('web')) {
    return {
      id,
      icon: 'web',
      label: tool.status === 'running' ? `Browsing web` : `Browsed web`,
      target: cmd,
      tool,
    };
  }

  // 7. Generic fallback
  return {
    id,
    icon: 'generic',
    label: cmd || name || 'Tool action',
    target: cmd,
    tool,
  };
}

export function computeGroupHeader(actions: ParsedToolAction[]): string {
  if (actions.length === 0) return 'Read files';
  const hasReads = actions.some((a) => a.icon === 'read');
  const hasLists = actions.some((a) => a.icon === 'list');
  const hasSearches = actions.some((a) => a.icon === 'search');
  const hasTerminal = actions.some((a) => a.icon === 'terminal');
  const hasEdits = actions.some((a) => a.icon === 'edit');

  const onlyReads = hasReads && !hasTerminal && !hasSearches && !hasLists && !hasEdits;
  if (onlyReads) {
    return 'Read files';
  }

  const onlyLists = hasLists && !hasReads && !hasTerminal && !hasSearches && !hasEdits;
  if (onlyLists) {
    return 'Listed files';
  }

  const onlySearches = hasSearches && !hasReads && !hasTerminal && !hasLists && !hasEdits;
  if (onlySearches) {
    return 'Searched codebase';
  }

  const onlyTerminal = hasTerminal && !hasReads && !hasSearches && !hasLists && !hasEdits;
  if (onlyTerminal) {
    return actions.length === 1 ? 'Ran a command' : 'Ran commands';
  }

  if (hasReads && hasTerminal && !hasSearches) {
    return actions.filter((a) => a.icon === 'terminal').length === 1
      ? 'Read files, ran a command'
      : 'Read files, ran commands';
  }

  if (hasReads && hasSearches && !hasTerminal) {
    return 'Read files, searched codebase';
  }

  return 'Read files, ran commands';
}

function renderActionIcon(icon: ParsedToolAction['icon'], isLight: boolean, isRunning: boolean) {
  if (isRunning) {
    return <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin shrink-0" />;
  }

  const baseColor = isLight ? 'text-neutral-500' : 'text-neutral-400';

  switch (icon) {
    case 'read':
      return <BookOpen className={`w-3.5 h-3.5 ${baseColor} shrink-0`} />;
    case 'search':
      return <Search className={`w-3.5 h-3.5 ${baseColor} shrink-0`} />;
    case 'list':
      return <Folder className={`w-3.5 h-3.5 ${baseColor} shrink-0`} />;
    case 'terminal':
      return <Terminal className={`w-3.5 h-3.5 ${baseColor} shrink-0`} />;
    case 'edit':
      return <FileCode className={`w-3.5 h-3.5 ${baseColor} shrink-0`} />;
    case 'web':
      return <Globe className={`w-3.5 h-3.5 ${baseColor} shrink-0`} />;
    default:
      return <FileText className={`w-3.5 h-3.5 ${baseColor} shrink-0`} />;
  }
}

/**
 * Deduplicate consecutive or re-delivered tool events so running and completed states
 * for the same invocation never render as duplicate rows.
 */
export function deduplicateTools(tools: ToolExecutionData[]): ToolExecutionData[] {
  const byKey = new Map<string, ToolExecutionData>();
  for (const tool of tools) {
    const key = tool.toolInvocationId || `${tool.toolName}:${tool.command ?? ''}:${tool.startedAt ?? ''}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, tool);
    } else {
      // Monotonic progression: prefer terminal states over running
      if (existing.status === 'running' && tool.status !== 'running') {
        byKey.set(key, tool);
      } else if (tool.durationMs !== undefined && existing.durationMs === undefined) {
        byKey.set(key, tool);
      } else if (tool.outputLog && !existing.outputLog) {
        byKey.set(key, tool);
      }
    }
  }
  return Array.from(byKey.values());
}

/**
 * Codex-style Single Tool Action Row
 * Clean, typography-first, without box borders.
 * Clicking toggles the view of what was read or executed inline!
 */
export const CodexToolRow: React.FC<{
  action: ParsedToolAction;
  isLight: boolean;
}> = ({ action, isLight }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [asyncContent, setAsyncContent] = useState<string | null>(null);
  const [isLoadingAsync, setIsLoadingAsync] = useState(false);
  const { activeProjectId } = useApp();

  const tool = action.tool;
  const isRunning = tool.status === 'running';
  const isFailed = tool.status === 'failed';
  const isSuccess = tool.status === 'success';
  const outcomeBadge = getOutcomeBadge(tool);
  const emptyOutputMessage = toolOutputFallback(tool.toolName, tool.status);

  // Content to display when clicked open
  const outputContent = tool.outputLog || asyncContent || tool.error || emptyOutputMessage;
  const hasDetail = true;

  const handleToggle = async () => {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);

    // On-demand fetch file or directory content if not present in tool payload
    if (nextOpen && !tool.outputLog && !asyncContent && !isLoadingAsync && activeProjectId) {
      if (action.icon === 'read' && action.target) {
        setIsLoadingAsync(true);
        try {
          const res = await runtimeInstance.readFileVersioned(activeProjectId, action.target);
          if (res && typeof res.content === 'string') {
            setAsyncContent(res.content);
          }
        } catch {
          // If file could not be read, emptyOutputMessage will remain
        } finally {
          setIsLoadingAsync(false);
        }
      } else if (action.icon === 'list' && action.target !== undefined) {
        setIsLoadingAsync(true);
        try {
          const entries = await runtimeInstance.listFiles(activeProjectId, action.target || '');
          if (Array.isArray(entries) && entries.length > 0) {
            setAsyncContent(entries.map((e) => `${e.type === 'folder' ? '📁 ' : '📄 '}${e.name}`).join('\n'));
          }
        } catch {
          // Fallback remains
        } finally {
          setIsLoadingAsync(false);
        }
      }
    }
  };

  const lines = outputContent ? outputContent.split('\n') : [];
  const lineCount = lines.length;

  return (
    <div className="select-text">
      <div
        onClick={handleToggle}
        className={`group flex items-center justify-between gap-2 py-1 px-1 rounded-md text-xs cursor-pointer transition-colors ${
          isLight
            ? 'hover:bg-black/[0.03] text-[#334155]'
            : 'hover:bg-white/[0.04] text-neutral-300'
        }`}
        title={action.target || action.label}
      >
        <div className="flex items-center gap-2 min-w-0">
          {renderActionIcon(action.icon, isLight, isRunning)}

          <span className={`font-mono text-[11.5px] truncate ${
            isLight ? 'text-[#1e293b]' : 'text-neutral-200'
          }`}>
            {action.label}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {outcomeBadge && (
            <span className={outcomeBadge.className}>
              {outcomeBadge.label}
            </span>
          )}

          {tool.durationMs !== undefined && !isRunning && (
            <span className={`text-[10px] ${isLight ? 'text-neutral-400' : 'text-neutral-500'} font-mono tabular-nums`}>
              {(tool.durationMs / 1000).toFixed(1)}s
            </span>
          )}

          {isSuccess && !outcomeBadge && (
            <CheckCircle2 className="w-3 h-3 text-emerald-500/80 shrink-0" />
          )}

          {isFailed && (
            <AlertCircle className="w-3 h-3 text-rose-500 shrink-0" />
          )}

          {hasDetail && (
            <span className={`${isLight ? 'text-neutral-400' : 'text-neutral-500'} transition-transform`}>
              {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </span>
          )}
        </div>
      </div>

      {/* Expanded read content / command output inline */}
      {isOpen && (
        <div className={`mt-1.5 mb-2 ml-5 p-3 rounded-lg text-[11px] font-mono leading-relaxed whitespace-pre overflow-x-auto max-h-80 select-text ${
          isLight
            ? 'bg-[#f4f4f7] border border-[#e2e4e8] text-[#1e293b]'
            : 'bg-[#18181c] border border-white/10 text-neutral-300'
        }`}>
          {isLoadingAsync ? (
            <div className="flex items-center gap-2 py-2 text-neutral-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500 shrink-0" />
              <span>Loading {action.target || 'content'}…</span>
            </div>
          ) : (
            <>
              {/* File header if reading a file */}
              {action.icon === 'read' && action.target && (
                <div className={`text-[10px] font-sans pb-1.5 mb-2 border-b flex items-center justify-between ${
                  isLight ? 'border-neutral-200 text-neutral-500' : 'border-white/10 text-neutral-400'
                }`}>
                  <span className="font-mono font-medium truncate">{action.target}</span>
                  <span className="shrink-0">{lineCount} {lineCount === 1 ? 'line' : 'lines'}</span>
                </div>
              )}

              {/* Terminal command preview */}
              {action.icon === 'terminal' && (tool.command || tool.workingDirectory) && (
                <div className="mb-2 text-[10.5px] opacity-70 border-b border-current/10 pb-1.5">
                  {tool.command ? `$ ${tool.command}\n` : ''}
                  {tool.workingDirectory ? `cd ${tool.workingDirectory}\n` : ''}
                  {tool.exitCode !== undefined && tool.exitCode !== null ? `Exit code: ${tool.exitCode}` : ''}
                </div>
              )}

              {/* Error display */}
              {tool.error ? (
                <div className={isLight ? 'text-rose-700' : 'text-rose-400'}>
                  <span className="font-semibold">Error: </span>
                  {tool.error}
                  {tool.outputLog ? `\n\n${tool.outputLog}` : ''}
                </div>
              ) : (
                outputContent
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Codex-style Collapsible Tool Cluster
 * Groups multiple tool executions into a single expandable list:
 * "📁 Read files v"
 *   "📖 Read package.json"
 *   "📖 Read agent.ts"
 *   "🔍 Searched for ..."
 * Clicking open on any item reveals what it read/executed inline.
 */
export const CodexToolCluster: React.FC<{
  tools: ToolExecutionData[];
  defaultOpen?: boolean;
}> = ({ tools, defaultOpen = true }) => {
  const { theme } = useApp();
  const isLight = theme === 'light';
  const [isGroupOpen, setIsGroupOpen] = useState(defaultOpen);

  const deduplicated = deduplicateTools(tools);
  const actions = deduplicated.map((t, index) => parseToolAction(t, `cluster-${index}`));
  const groupHeader = computeGroupHeader(actions);

  if (actions.length === 0) return null;

  // If there's only 1 tool execution, render it inline cleanly without double nesting
  if (actions.length === 1) {
    return (
      <div className="my-1 pl-1">
        <CodexToolRow action={actions[0]!} isLight={isLight} />
      </div>
    );
  }

  const anyRunning = actions.some((a) => a.tool.status === 'running');

  return (
    <div className="my-1.5 select-none">
      {/* Group Header: "📁 Read files v" */}
      <button
        type="button"
        onClick={() => setIsGroupOpen((prev) => !prev)}
        className={`flex items-center gap-2 py-1 px-1 rounded-md text-xs font-medium cursor-pointer transition-colors ${
          isLight
            ? 'text-neutral-700 hover:text-neutral-900 hover:bg-black/[0.03]'
            : 'text-neutral-300 hover:text-white hover:bg-white/[0.04]'
        }`}
      >
        <Folder className={`w-3.5 h-3.5 ${isLight ? 'text-neutral-500' : 'text-neutral-400'} shrink-0`} />
        <span>{groupHeader}</span>
        {isGroupOpen ? (
          <ChevronDown className="w-3 h-3 opacity-60" />
        ) : (
          <ChevronRight className="w-3 h-3 opacity-60" />
        )}

        {anyRunning && (
          <Loader2 className="w-3 h-3 text-amber-500 animate-spin ml-1 shrink-0" />
        )}
      </button>

      {/* Indented operations list */}
      {isGroupOpen && (
        <div className={`mt-0.5 ml-2 pl-3 border-l ${
          isLight ? 'border-neutral-200' : 'border-neutral-800'
        } space-y-0.5`}>
          {actions.map((action) => (
            <CodexToolRow key={action.id} action={action} isLight={isLight} />
          ))}
        </div>
      )}
    </div>
  );
};

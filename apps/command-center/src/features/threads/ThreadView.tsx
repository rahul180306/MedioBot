import React, { useMemo, useRef, useEffect, useState, useCallback, useLayoutEffect } from 'react';
import { useApp } from '../../state/AppContext';
import { ActivityItem } from '../activity/ActivityItem';
import { Composer } from '../composer/Composer';
import { MarkdownContent } from './MarkdownContent';
import { Loader2, Image, Paperclip, Copy, Check, X } from 'lucide-react';
import { EmptyState } from '../empty/EmptyState';
import { TimelineNavigator } from './TimelineNavigator';
import { MediobotAvatar } from './MediobotAvatar';
import { buildTimelineNavigatorAnchors, conversationActorName, projectThreadTimeline } from './timeline';
import { getMediobotPresentation } from '../mediobots/presentation';
import type { ConversationActor, ThreadItem } from '../../types';
import LatticeLoader from '../../components/LatticeLoader';
import { runtimeInstance } from '../../runtime/client';
import { CodexToolCluster } from '../activity/CodexExecutionView';

function formatElapsedDuration(seconds: number): string {
  const total = Math.max(1, Math.round(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function useTurnTimer(isRunning: boolean, startedAt?: number, completedAt?: number): string {
  const [elapsed, setElapsed] = useState(() => {
    if (!startedAt) return '0s';
    const end = completedAt || Date.now();
    return formatElapsedDuration((end - startedAt) / 1000);
  });

  useEffect(() => {
    if (!isRunning || !startedAt) {
      if (startedAt && completedAt) {
        setElapsed(formatElapsedDuration((completedAt - startedAt) / 1000));
      }
      return;
    }
    const update = () => {
      setElapsed(formatElapsedDuration((Date.now() - startedAt) / 1000));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [isRunning, startedAt, completedAt]);

  return elapsed;
}

const TurnDurationHeader: React.FC<{
  isRunning: boolean;
  createdAt: number;
  completedAt?: number;
  isLight: boolean;
}> = ({ isRunning, createdAt, completedAt, isLight }) => {
  const durationText = useTurnTimer(isRunning, createdAt, completedAt);

  return (
    <div className={`text-[12px] font-sans ${isLight ? 'text-neutral-500' : 'text-neutral-400'} select-none pl-1 mb-2 font-normal tracking-tight`}>
      {isRunning ? `Working for ${durationText}` : `Worked for ${durationText}`}
    </div>
  );
};

function formatUserTimestamp(ts?: number): string {
  if (!ts) return '';
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '';
  const day = date.getDate();
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${day} ${month}, ${hours}:${minutes}`;
}

function targetId(turnId: string, itemId: string): string {
  return `timeline-${encodeURIComponent(turnId)}-${encodeURIComponent(itemId)}`;
}

function activityGroupLabel(items: ReadonlyArray<ThreadItem>): string {
  const kinds = new Set(items.map((item) => item.type));
  if (kinds.size === 1 && kinds.has('tool_execution')) return 'Tool activity';
  if (kinds.size === 1 && kinds.has('diff')) return 'File changes';
  if (kinds.size === 1 && kinds.has('approval_request')) return 'Approval';
  if (kinds.size === 1 && (kinds.has('computer_action') || kinds.has('perception_snapshot'))) return 'Computer activity';
  return 'Activity';
}

function activeActivityLabel(items: ReadonlyArray<ThreadItem>): string {
  const latest = items[items.length - 1];
  if (!latest) return 'Working…';
  if (latest.type === 'tool_execution' && latest.tool) {
    const cmd = latest.tool.command || latest.tool.toolName;
    if (cmd.startsWith('filesystem.read')) {
      const path = cmd.replace('filesystem.read', '').trim();
      return path ? `Reading ${path}` : 'Reading file…';
    }
    if (cmd.startsWith('filesystem.write')) {
      const path = cmd.replace('filesystem.write', '').trim();
      return path ? `Writing ${path}` : 'Writing file…';
    }
    if (cmd.startsWith('terminal.execute')) {
      const execCmd = cmd.replace('terminal.execute', '').trim();
      return execCmd ? `Running ${execCmd.slice(0, 32)}…` : 'Running command…';
    }
    return cmd.length > 40 ? `${cmd.slice(0, 37)}…` : `${cmd}…`;
  }
  if (latest.type === 'diff') return 'Writing file changes…';
  if (latest.activityLabel) return `${latest.activityLabel}…`;
  if (latest.text) return `${latest.text.slice(0, 36)}…`;
  return 'Working…';
}

export const ThreadView: React.FC = () => {
  const { activeThread, activeTurnId, chatHydrationStatus, reloadThreads, theme, selectedMediobotId } = useApp();
  const isLight = theme === 'light';

  // Determine whether this conversation is an individual specialist's separate workspace/chat
  // versus the main team/orchestration chat.
  const isSpecificMediobotChat = Boolean(
    (selectedMediobotId && selectedMediobotId !== 'maestro') ||
    (activeThread?.specialistId && activeThread.specialistId !== 'maestro')
  );
  const isMainChat = !isSpecificMediobotChat;
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [resumingTaskId, setResumingTaskId] = useState<string | null>(null);
  const [pausingTaskId, setPausingTaskId] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [viewingImage, setViewingImage] = useState<{ id: string; name: string; url: string } | null>(null);

  const handleCopy = (text: string, id: string) => {
    if (!text) return;
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((current) => (current === id ? null : current));
    }, 2000);
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const restoredThreadId = useRef<string | null>(null);
  const wasNearBottom = useRef(true);
  const bindScrollRoot = useCallback((element: HTMLDivElement | null) => {
    setScrollRoot(previous => previous === element ? previous : element);
  }, []);
  const targetElements = useRef(new Map<string, HTMLElement>());
  const timeline = useMemo(() => projectThreadTimeline(activeThread?.turns ?? []), [activeThread?.turns]);
  const entriesByTurn = useMemo(() => {
    const byTurn = new Map<string, typeof timeline>();
    for (const entry of timeline) {
      const turnId = entry.items[0]?.turnId;
      if (!turnId) continue;
      const entries = byTurn.get(turnId) ?? [];
      entries.push(entry);
      byTurn.set(turnId, entries);
    }
    return byTurn;
  }, [timeline]);
  const anchors = useMemo(() => buildTimelineNavigatorAnchors(timeline), [timeline]);

  useLayoutEffect(() => {
    if (!scrollRoot || !activeThread || restoredThreadId.current === activeThread.id) return;
    let saved: number | null = null;
    try {
      const value = sessionStorage.getItem(`mediobot-thread-scroll:${activeThread.id}`);
      if (value !== null && Number.isFinite(Number(value))) saved = Number(value);
    } catch { /* Session storage may be unavailable in private browsing. */ }
    scrollRoot.scrollTop = saved ?? scrollRoot.scrollHeight;
    wasNearBottom.current = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight < 120;
    restoredThreadId.current = activeThread.id;
  }, [activeThread?.id, scrollRoot]);

  // Follow new activity only while the reader is already at the bottom.
  useEffect(() => {
    if (!scrollRoot || !activeThread || restoredThreadId.current !== activeThread.id || !wasNearBottom.current) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [activeThread?.turns, activeTurnId, activeThread?.id, scrollRoot]);

  if (!activeThread) {
    if (chatHydrationStatus === 'LOADING') {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-neutral-400">
          <LatticeLoader
            status="working"
            label="Loading conversation"
            color={isLight ? '#475569' : '#a1a1aa'}
            fontSize={12}
            cellSize={3.5}
            gap={1.5}
            showTimer={false}
          />
        </div>
      );
    }
    if (chatHydrationStatus === 'ERROR') {
      return <div className="flex-1 flex flex-col items-center justify-center p-8 text-neutral-400"><span className="text-xs text-rose-400 mb-2">Conversation failed to load from database.</span><button onClick={() => void reloadThreads()} className="px-3 py-1 bg-[#242429] hover:bg-[#2f2f37] text-neutral-200 text-xs rounded border border-[#3b3b45] transition-colors">Retry</button></div>;
    }
    return null;
  }

  if (activeThread.turns.length === 0) return <EmptyState />;

  const bindTarget = (id: string) => (element: HTMLElement | null) => {
    if (element) targetElements.current.set(id, element);
    else targetElements.current.delete(id);
  };
  const bindActivityTarget = (id: string, initiallyOpen: boolean) => (element: HTMLDetailsElement | null) => {
    bindTarget(id)(element);
    if (element && element.dataset.initialized !== 'true') {
      element.open = initiallyOpen;
      element.dataset.initialized = 'true';
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden relative">
      <div ref={bindScrollRoot} onScroll={(event) => {
        const element = event.currentTarget;
        wasNearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        if (activeThread) {
          try { sessionStorage.setItem(`mediobot-thread-scroll:${activeThread.id}`, String(element.scrollTop)); }
          catch { /* Session storage may be unavailable in private browsing. */ }
        }
      }} data-testid="thread-scroll-root" className="flex-1 overflow-y-auto px-4 py-6 md:px-8 max-w-3xl w-full mx-auto space-y-8">
        {activeThread.turns.map((turn) => {
          const entries = entriesByTurn.get(turn.id) ?? [];
          const isTurnRunning = turn.status === 'running' || turn.status === 'pause_requested';
          return <div key={turn.id} className="space-y-4">
            {turn.taskId && turn.status === 'running' && runtimeInstance.pauseTask && (
              <div className="flex justify-end">
                <button type="button" disabled={pausingTaskId === turn.taskId}
                  onClick={async () => {
                    setRecoveryError(null); setPausingTaskId(turn.taskId!);
                    try { await runtimeInstance.pauseTask!(turn.taskId!); }
                    catch (error) { setRecoveryError(error instanceof Error ? error.message : 'Could not pause this task.'); }
                    finally { setPausingTaskId(null); }
                  }}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${isLight ? 'border border-gray-300 hover:bg-gray-100 text-gray-700' : 'border border-white/10 hover:bg-white/5 text-gray-300'}`}>
                  {pausingTaskId === turn.taskId ? 'Requesting pause…' : 'Pause task'}
                </button>
              </div>
            )}
            {turn.status === 'pause_requested' && <div className="text-xs text-gray-500" role="status">Pause requested. Active work is settling at a safe checkpoint.</div>}
            {turn.recoveryState && turn.taskId && (
              <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs ${isLight ? 'bg-amber-50 text-amber-900 border border-amber-200' : 'bg-amber-950/30 text-amber-200 border border-amber-900/60'}`} role="status">
                <span>{turn.recoveryState === 'paused'
                  ? 'This task is paused at a saved checkpoint.'
                  : turn.recoveryState === 'interrupted'
                  ? 'This task was interrupted. Its saved execution can be resumed.'
                  : 'This task is queued and ready to start.'}</span>
                <button
                  type="button"
                  disabled={resumingTaskId === turn.taskId}
                  onClick={async () => {
                    setRecoveryError(null);
                    setResumingTaskId(turn.taskId!);
                    try {
                      if (!runtimeInstance.resumeTask) throw new Error('Task recovery is not available in this runtime.');
                      await runtimeInstance.resumeTask(turn.taskId!, activeThread.id, turn.id);
                    } catch (error) {
                      setRecoveryError(error instanceof Error ? error.message : 'Could not resume this task.');
                    } finally {
                      setResumingTaskId(null);
                    }
                  }}
                  className={`rounded-md px-2.5 py-1 font-medium transition-colors disabled:cursor-wait disabled:opacity-60 ${isLight ? 'bg-amber-100 hover:bg-amber-200 text-amber-950' : 'bg-amber-900/50 hover:bg-amber-900 text-amber-100'}`}
                >
                  {resumingTaskId === turn.taskId ? 'Resuming…' : 'Resume task'}
                </button>
                {recoveryError && <span className="basis-full text-rose-500">{recoveryError}</span>}
              </div>
            )}
            {entries.map((entry, entryIndex) => {
              const first = entry.items[0]!;
              const isFirstAssistantEntry = entry.kind !== 'user' && (entryIndex === 0 || entries[entryIndex - 1]?.kind === 'user');

              if (entry.kind === 'user') {
                const itemTimestamp = first.timestamp || turn.createdAt;
                const displayTime = formatUserTimestamp(itemTimestamp);

                return (
                  <div
                    key={entry.id}
                    id={entry.targetId}
                    ref={bindTarget(entry.targetId)}
                    data-timeline-anchor="user"
                    className="group flex flex-col items-end scroll-mt-24 scroll-mb-24"
                  >
                    <div
                      className={`max-w-[85%] ${
                        isLight
                          ? 'bg-[#f4f4f7] text-[#09090b] border-[#e2e4e8] shadow-xs'
                          : 'bg-[#242429] text-neutral-100 border-[#2f2f37]'
                      } text-sm px-4 py-2.5 rounded-2xl rounded-tr-sm border leading-relaxed select-text`}
                    >
                      {first.text}
                      {first.attachments?.length ? (
                        <div className="mt-2.5 flex flex-col gap-2">
                          {/* Image preview cards with preserved aspect ratio */}
                          {first.attachments.filter((a) => a.mimeType.startsWith('image/')).length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {first.attachments
                                .filter((a) => a.mimeType.startsWith('image/'))
                                .map((attachment) => (
                                  <div
                                    key={attachment.id}
                                    className={`group/img relative rounded-xl overflow-hidden border ${
                                      isLight ? 'border-black/10 bg-black/5' : 'border-white/10 bg-black/40'
                                    } shadow-xs cursor-pointer transition-transform hover:scale-[1.02]`}
                                    onClick={() => setViewingImage({ id: attachment.id, name: attachment.name, url: `/api/attachments/${attachment.id}` })}
                                  >
                                    <img
                                      src={`/api/attachments/${attachment.id}`}
                                      alt={attachment.name}
                                      loading="lazy"
                                      className="max-h-[180px] max-w-[260px] object-contain rounded-xl block"
                                    />
                                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2 py-1 opacity-0 group-hover/img:opacity-100 transition-opacity">
                                      <p className="text-[10px] text-white truncate font-medium">{attachment.name}</p>
                                    </div>
                                  </div>
                                ))}
                            </div>
                          )}

                          {/* Document and non-image badges */}
                          {first.attachments.filter((a) => !a.mimeType.startsWith('image/')).length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {first.attachments
                                .filter((a) => !a.mimeType.startsWith('image/'))
                                .map((attachment) => (
                                  <span
                                    key={attachment.id}
                                    className={`inline-flex items-center gap-1.5 rounded-lg ${
                                      isLight
                                        ? 'bg-white border-[#dcdce2] text-[#334155]'
                                        : 'bg-[#19191d] border-[#383841] text-neutral-300'
                                    } border px-2.5 py-1 text-[11px] font-medium shadow-2xs`}
                                    title={`${attachment.name} · ${attachment.mimeType} · ${attachment.size} bytes`}
                                  >
                                    <Paperclip className="w-3.5 h-3.5 opacity-70" />
                                    <span className="truncate max-w-[180px]">{attachment.name}</span>
                                    <span className="text-[9px] opacity-60">
                                      {attachment.size < 1024 * 1024
                                        ? `${(attachment.size / 1024).toFixed(0)} KB`
                                        : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`}
                                    </span>
                                  </span>
                                ))}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>

                    {/* Below the input chat component (Not inside it): Copy icon and time on hover */}
                    <div
                      className={`mt-1 flex items-center gap-2 text-[11px] ${
                        isLight ? 'text-[#64748b]' : 'text-neutral-400'
                      } opacity-0 group-hover:opacity-100 transition-opacity duration-200 select-none pr-1`}
                    >
                      {displayTime && <span className="font-sans">{displayTime}</span>}
                      <button
                        type="button"
                        onClick={() => handleCopy(first.text || '', entry.id)}
                        className={`p-1 rounded transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${
                          isLight ? 'text-[#64748b] hover:text-[#09090b]' : 'text-neutral-400 hover:text-neutral-200'
                        } flex items-center gap-1 text-[11px] font-medium cursor-pointer`}
                        title="Copy input text"
                        aria-label="Copy input text"
                      >
                        {copiedId === entry.id ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-500" />
                            <span className="text-emerald-500 text-[10.5px]">Copied</span>
                          </>
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                );
              }

              if (entry.kind === 'message') {
                const actor: ConversationActor | undefined = first.actor;
                const isSystem = actor?.type === 'system';
                const presentation = actor?.type === 'mediobot'
                  ? getMediobotPresentation(actor.presentationId ?? actor.mediobotId, actor.name)
                  : null;

                // In Main Chat alone, each mediobot's color reflects on the font color for dark and light mode!
                // In the specific mediobot chat, it is normal white on dark mode, normal black on light mode.
                const botTextColor = isSpecificMediobotChat
                  ? (isLight ? 'text-[#18181b]' : 'text-neutral-100')
                  : presentation
                    ? (isLight ? presentation.lightText : presentation.darkText)
                    : (isLight ? 'text-[#18181b]' : 'text-neutral-200');

                const botNameColor = isSpecificMediobotChat
                  ? (isLight ? 'text-[#18181b]' : 'text-neutral-200')
                  : presentation
                    ? (isLight ? presentation.lightText : presentation.darkText)
                    : (isLight ? 'text-[#64748b]' : 'text-neutral-400');

                return (
                  <React.Fragment key={entry.id}>
                    {isFirstAssistantEntry && (
                      <TurnDurationHeader
                        isRunning={isTurnRunning}
                        createdAt={turn.createdAt}
                        completedAt={turn.completedAt}
                        isLight={isLight}
                      />
                    )}
                    <div
                      id={entry.targetId}
                      ref={bindTarget(entry.targetId)}
                      data-timeline-anchor="message"
                      className="group scroll-mt-24 scroll-mb-24 pl-1"
                    >
                      <div className={`mb-1.5 flex items-center gap-2 text-[11px] font-semibold ${botNameColor}`}>
                        <MediobotAvatar actor={actor} size="sm" />
                        <span>{conversationActorName(actor)}</span>
                        {isSystem && (
                          <span
                            className={`rounded border ${
                              isLight
                                ? 'border-[#dcdce2] text-[#64748b]'
                                : 'border-white/10 text-neutral-500'
                            } px-1.5 py-0.5 text-[9px] uppercase tracking-wide`}
                          >
                            Notice
                          </span>
                        )}
                      </div>
                      <div className={`text-sm ${botTextColor} leading-relaxed select-text`}>
                        <MarkdownContent content={first.text || ''} textColor={botTextColor} />
                      </div>

                      {/* Below output message: Only copy icon on hover */}
                      <div
                        className={`mt-1 flex items-center gap-1.5 ${
                          isLight ? 'text-[#64748b]' : 'text-neutral-400'
                        } opacity-0 group-hover:opacity-100 transition-opacity duration-200 select-none`}
                      >
                        <button
                          type="button"
                          onClick={() => handleCopy(first.text || '', entry.id)}
                          className={`p-1 rounded transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${
                            isLight ? 'text-[#64748b] hover:text-[#09090b]' : 'text-neutral-400 hover:text-neutral-200'
                          } flex items-center gap-1 text-[11px] font-medium cursor-pointer`}
                          title="Copy output text"
                          aria-label="Copy output text"
                        >
                          {copiedId === entry.id ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-500" />
                              <span className="text-emerald-500 text-[10.5px]">Copied</span>
                            </>
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  </React.Fragment>
                );
              }

              const isActiveGroup = isTurnRunning && entries[entries.length - 1]?.id === entry.id;
              const tools = entry.items.filter((it) => it.type === 'tool_execution' && it.tool).map((it) => it.tool!);
              const nonTools = entry.items.filter((it) => it.type !== 'tool_execution');

              return (
                <React.Fragment key={entry.id}>
                  {isFirstAssistantEntry && (
                    <TurnDurationHeader
                      isRunning={isTurnRunning}
                      createdAt={turn.createdAt}
                      completedAt={turn.completedAt}
                      isLight={isLight}
                    />
                  )}
                  <div
                    id={entry.targetId}
                    ref={bindTarget(entry.targetId)}
                    data-timeline-anchor="activity"
                    className="group scroll-mt-24 scroll-mb-24 pl-1 my-1.5"
                  >
                    {/* Render tool executions cleanly as a Codex collapsible cluster */}
                    {tools.length > 0 && (
                      <CodexToolCluster
                        tools={tools}
                        defaultOpen={isSpecificMediobotChat || isActiveGroup}
                      />
                    )}

                    {/* Render diffs, approvals, perceptions, or genuine detailed activities */}
                    {nonTools.length > 0 && (
                      <div className="space-y-1 mt-1">
                        {nonTools.map((item) => (
                          <ActivityItem
                            key={item.id}
                            item={item}
                            turnId={turn.id}
                            turnStatus={turn.status}
                            isActive={Boolean(isActiveGroup && item === entry.items[entry.items.length - 1])}
                            isMainChat={isMainChat}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </React.Fragment>
              );
            })}
            {isTurnRunning && entries.every(e => e.kind === 'user') && (
              <div className={`pl-3 border-l ${isLight ? 'border-[#e2e4e8]' : 'border-[#27272f]'}`}>
                <div className={`flex items-center gap-2 py-1 text-xs ${isLight ? 'text-[#64748b]' : 'text-neutral-400'}`}>
                  <LatticeLoader
                    status="working"
                    label="Deciding"
                    color={isLight ? '#475569' : '#a1a1aa'}
                    fontSize={11}
                    cellSize={3}
                    gap={1.5}
                    showTimer={false}
                  />
                </div>
              </div>
            )}
          </div>;
        })}
        <div ref={messagesEndRef} className="h-6" />
      </div>

      {anchors.length > 0 && <TimelineNavigator anchors={anchors} scrollRoot={scrollRoot} targets={targetElements} />}

      <div className={`w-full pb-6 pt-2 ${
        isLight
          ? 'bg-gradient-to-t from-[#ffffff] via-[#ffffff] to-transparent'
          : 'bg-gradient-to-t from-[#141415] via-[#141415] to-transparent'
      } z-10 shrink-0`}><Composer compact /></div>

      {viewingImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-xs p-4"
          onClick={() => setViewingImage(null)}
        >
          <div
            className={`relative max-w-4xl max-h-[90vh] flex flex-col items-center ${
              isLight ? 'bg-white border-[#e2e4e8]' : 'bg-[#1a1a20] border-white/10'
            } rounded-2xl border p-3 shadow-2xl overflow-hidden`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between w-full px-2 py-1 border-b border-white/10 mb-2">
              <span className={`text-xs font-semibold ${isLight ? 'text-black' : 'text-neutral-200'} truncate`}>
                {viewingImage.name}
              </span>
              <button
                onClick={() => setViewingImage(null)}
                className="text-neutral-400 hover:text-white p-1 rounded-md hover:bg-white/10 transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center justify-center overflow-auto max-h-[calc(90vh-80px)]">
              <img
                src={viewingImage.url}
                alt={viewingImage.name}
                className="max-h-[calc(90vh-100px)] max-w-full object-contain rounded-lg"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


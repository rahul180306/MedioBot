import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { CodexGlyph } from '../../components/icons/CodexGlyph';
import { Composer } from '../composer/Composer';
import { useApp } from '../../state/AppContext';
import { getMediobotPresentation } from '../mediobots/presentation';
import { specialistTaskActivity, specialistTaskEventLabel } from './specialistTaskActivity';

const formatModelName = (key?: string): string => {
  if (!key) return 'Default';
  if (key.includes('MiniMax')) return 'MiniMax M2.7';
  if (key.includes('diffusiongemma')) return 'DiffusionGemma 26B';
  if (key.includes('gpt-4o-mini')) return 'GPT-4o mini';
  if (key.includes('gpt-4o')) return 'GPT-4o';
  if (key.includes('claude-3-5-sonnet') || key.includes('claude')) return 'Claude 3.5 Sonnet';
  if (key.includes('gemini-2.5-pro')) return 'Gemini 2.5 Pro';
  if (key.includes('gemini-2.5-flash')) return 'Gemini 2.5 Flash';
  const parts = key.split('/');
  return parts[parts.length - 1];
};

export const EmptyState: React.FC = () => {
  const { selectedMediobotId, agents, threads, openChatTab, agentTaskHistory, agentGroupHistory, agentGroupHistoryUnavailable, theme, getAgentPreference } = useApp();
  const isLight = theme === 'light';
  const isMedioBotMode = selectedMediobotId !== null;
  const currentAgent = selectedMediobotId
    ? agents.find((agent) => agent.id === selectedMediobotId) ?? null
    : null;

  const targetName = isMedioBotMode ? currentAgent?.name ?? 'Mediobot' : 'Mediobot';
  const botVisuals = getMediobotPresentation(currentAgent?.preferenceId ?? selectedMediobotId ?? 'maestro', currentAgent?.name, currentAgent?.role);
  const activeBotKey = (currentAgent?.preferenceId ?? selectedMediobotId ?? 'maestro').toLowerCase();
  const botPref = getAgentPreference(activeBotKey);
  const recentAssignments = currentAgent
    ? agentTaskHistory.filter((task) => task.assignedMediobot?.id === (currentAgent.definitionId ?? currentAgent.id)
      || task.assignedMediobot?.name?.toLowerCase() === currentAgent.name.toLowerCase())
      .map((task) => ({
        task,
        latestEvent: [...(task.events ?? [])].sort((a, b) => b.occurredAt - a.occurredAt)[0],
      }))
      .sort((a, b) => (b.latestEvent?.occurredAt ?? 0) - (a.latestEvent?.occurredAt ?? 0))
      .slice(0, 4)
    : [];
  const botConversations = currentAgent
    ? threads.filter(thread => thread.turns.some(turn => turn.items.some(item => item.actor?.type === 'mediobot'
      && (item.actor.mediobotId === (currentAgent.definitionId ?? currentAgent.id)
        || item.actor.name?.toLowerCase() === currentAgent.name.toLowerCase()))))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4)
    : [];
  const hasExistingWork = recentAssignments.length > 0 || botConversations.length > 0
    || agentGroupHistory.length > 0 || agentGroupHistoryUnavailable;

  const [typedText, setTypedText] = useState('');
  const workspaceContentRef = useRef<HTMLDivElement | null>(null);
  const workspaceScrollPositions = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const root = workspaceContentRef.current;
    if (!root) return;
    if (!selectedMediobotId) {
      root.scrollTop = 0;
      return;
    }
    const key = `mediobot-workspace-scroll:${selectedMediobotId}`;
    let stored = 0;
    try { stored = Number(sessionStorage.getItem(key)) || 0; } catch { /* session storage may be unavailable */ }
    root.scrollTop = workspaceScrollPositions.current.get(selectedMediobotId) ?? stored;
  }, [selectedMediobotId]);

  useEffect(() => {
    let index = 0;
    setTypedText('');

    const startTimer = setTimeout(() => {
      const interval = setInterval(() => {
        index++;
        if (index <= targetName.length) {
          setTypedText(targetName.slice(0, index));
        } else {
          clearInterval(interval);
        }
      }, 90);

      return () => clearInterval(interval);
    }, 120);

    return () => clearTimeout(startTimer);
  }, [targetName]);

  return (
    <div className={`flex-1 flex flex-col items-center w-full h-full min-h-0 pb-8 select-none ${hasExistingWork ? 'justify-start' : 'justify-between'}`}>
      <div className={hasExistingWork ? 'h-4 shrink-0' : 'flex-1'} />

      {/* Center Emblem & Headline */}
      <div ref={workspaceContentRef}
        data-testid={isMedioBotMode && currentAgent ? `mediobot-workspace-content-${currentAgent.id}` : undefined}
        onScroll={(event) => {
          if (!selectedMediobotId) return;
          const position = event.currentTarget.scrollTop;
          workspaceScrollPositions.current.set(selectedMediobotId, position);
          try { sessionStorage.setItem(`mediobot-workspace-scroll:${selectedMediobotId}`, String(position)); }
          catch { /* session storage may be unavailable */ }
        }}
        className={`flex flex-col items-center text-center px-4 ${hasExistingWork
          ? 'flex-1 min-h-0 w-full overflow-y-auto justify-start max-w-none'
          : 'justify-center max-w-xl'} animate-in fade-in duration-300`}>
        {/* Emblem: SVG circle emblem with vertical blinking eyes */}
        <div
          data-testid={isMedioBotMode && selectedMediobotId ? `mediobot-welcome-${selectedMediobotId}` : undefined}
          className={`${hasExistingWork ? 'mb-1 shrink-0' : 'mb-6'} opacity-90 hover:opacity-100 transition-opacity`}
        >
          {isMedioBotMode && currentAgent ? (
            <CodexGlyph
              className={hasExistingWork ? 'w-8 h-8' : 'w-16 h-16'}
              bgColor={
                botVisuals.id === 'maestro'
                  ? (isLight ? '#18181b' : '#f4f4f5')
                  : botVisuals.id === 'cody'
                  ? '#fef08a'
                  : botVisuals.id === 'vision'
                  ? '#bae6fd'
                  : botVisuals.id === 'doc'
                  ? '#4b4a56'
                  : botVisuals.id === 'research'
                  ? '#fed7aa'
                  : botVisuals.id === 'tester'
                  ? '#ddd6fe'
                  : botVisuals.id === 'deployer'
                  ? '#a7f3d0'
                  : (isLight ? '#18181b' : '#f4f4f5')
              }
              eyeColor={
                botVisuals.id === 'maestro'
                  ? (isLight ? '#ffffff' : '#000000')
                  : botVisuals.id === 'doc'
                  ? '#ffffff'
                  : botVisuals.id === 'tester'
                  ? '#1e1b4b'
                  : botVisuals.id === 'deployer'
                  ? '#064e3b'
                  : '#000000'
              }
              isLight={isLight}
            />
          ) : (
            <CodexGlyph className={hasExistingWork ? 'w-8 h-8' : 'w-16 h-16'} isLight={isLight} />
          )}
        </div>

        {/* Original product welcome copy; Maestro mode addresses the selected definition. */}
        <h1 className={`${hasExistingWork ? 'text-base sm:text-lg' : 'text-2xl sm:text-[28px]'} font-medium tracking-tight ${isLight ? 'text-[#18181b]' : 'text-neutral-200'} inline-flex items-center justify-center flex-wrap gap-x-2`}>
          <span>{isMedioBotMode ? 'Hi, I am' : 'What Should we Build with'}</span>
            <span className={`font-semibold inline-flex items-center ${isMedioBotMode ? (isLight ? botVisuals.lightText : botVisuals.darkText) : isLight ? 'text-[#09090b]' : 'text-white'}`}>
            <span>{typedText}{!isMedioBotMode && typedText === targetName ? '?' : ''}</span>
            {/* Smooth terminal-grade blinking cursor */}
            <span
              className={`inline-block w-[2px] h-[0.88em] ${isLight ? 'bg-[#18181b]' : 'bg-neutral-200'} ml-[2px] animate-cursor-blink align-middle rounded-full`}
              aria-hidden="true"
            />
          </span>
        </h1>

        {/* Subtitle / Role description for selected MedioBot only in Maestro mode */}
        {isMedioBotMode && currentAgent?.role && (
          <p className={`${hasExistingWork ? 'mt-1' : 'mt-2.5'} text-xs ${isLight ? 'text-neutral-600' : 'text-neutral-400'} font-normal animate-in fade-in duration-200`}>
            Specialization: <span className={`${isLight ? 'text-neutral-900 font-semibold' : 'text-neutral-200 font-medium'}`}>{currentAgent.role}</span>
          </p>
        )}

        {isMedioBotMode && !hasExistingWork && (
          <div className="mt-3 flex items-center justify-center gap-2 text-[11.5px] font-medium animate-in fade-in duration-200">
            <span
              className={`px-2.5 py-1 rounded-full border transition-colors ${
                isLight
                  ? 'bg-black/[0.03] border-black/10 text-neutral-700'
                  : 'bg-white/[0.04] border-white/10 text-neutral-300'
              }`}
            >
              Model: <span className="font-semibold">{formatModelName(botPref.modelKey)}</span>
            </span>
            <span
              className={`px-2.5 py-1 rounded-full border transition-colors ${
                isLight
                  ? 'bg-black/[0.03] border-black/10 text-neutral-700'
                  : 'bg-white/[0.04] border-white/10 text-neutral-300'
              }`}
            >
              Level: <span className="font-semibold">{botPref.effort}</span>
            </span>
          </div>
        )}

        {isMedioBotMode && currentAgent && (
          <div className={`${hasExistingWork ? 'mt-1' : 'mt-3'} text-xs ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}
            data-testid={`mediobot-workspace-status-${currentAgent.id}`}>
            Availability: <span className={`${isLight ? 'text-neutral-900' : 'text-neutral-200'} font-medium`}>
              {currentAgent.availability === 'development' ? 'In development'
                : currentAgent.availability === 'not-configured' ? 'Not configured'
                  : currentAgent.availability === 'unavailable' ? 'Unavailable' : 'Available'}
            </span>
            <span className="ml-3">Execution: <span className={`${isLight ? 'text-neutral-900' : 'text-neutral-200'} font-medium`}>
              {currentAgent.status.charAt(0).toUpperCase() + currentAgent.status.slice(1)}
            </span></span>
            {(currentAgent.status === 'working' || (currentAgent.status === 'waiting' && currentAgent.availability === 'available'))
              && currentAgent.currentTask && !['available', 'development', 'unavailable', 'not-configured'].includes(currentAgent.currentTask) && (
              <p className="mt-1 max-w-md truncate" title={currentAgent.currentTask}
                data-testid={`mediobot-active-assignment-${currentAgent.id}`}>
                {currentAgent.status === 'waiting' ? 'Waiting on: ' : 'Current assignment: '}{currentAgent.currentTask}
              </p>
            )}
          </div>
        )}

        {isMedioBotMode && botConversations.length > 0 && (
          <section className={`mt-4 w-full max-w-6xl shrink-0 rounded-xl border px-4 py-3 text-left ${
            isLight ? 'border-black/10 bg-black/[0.025]' : 'border-white/10 bg-white/[0.025]'
          }`} data-testid={`mediobot-conversations-${currentAgent?.id}`} aria-label={`${currentAgent?.name} conversations`}>
            <h2 className={`text-[11px] font-semibold uppercase tracking-wide ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}>
              Recent conversations
            </h2>
            <ul className="mt-2 space-y-1.5">
              {botConversations.map(thread => (
                <li key={thread.id}>
                  <button type="button" onClick={() => openChatTab(thread.id)} data-testid={`mediobot-conversation-${thread.id}`}
                    className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${isLight ? 'hover:bg-black/[0.05]' : 'hover:bg-white/[0.06]'}`}>
                    <span className={`block truncate text-xs font-medium ${isLight ? 'text-neutral-900' : 'text-neutral-200'}`}>{thread.title}</span>
                    <span className={`mt-0.5 block truncate text-[11px] ${isLight ? 'text-neutral-500' : 'text-neutral-400'}`}>
                      {thread.turns.at(-1)?.prompt ?? 'Conversation'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {isMedioBotMode && currentAgent && (agentGroupHistory.length > 0 || agentGroupHistoryUnavailable) && (
          <section className={`mt-3 w-full max-w-6xl shrink-0 rounded-xl border px-4 py-3 text-left ${
            isLight ? 'border-black/10 bg-black/[0.025]' : 'border-white/10 bg-white/[0.025]'
          } max-h-64 overflow-y-auto`} data-testid={`mediobot-collaboration-history-${currentAgent.id}`} aria-label={`${currentAgent.name} shared collaboration history`}>
            <h2 className={`text-[11px] font-semibold uppercase tracking-wide ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}>
              Shared collaboration
            </h2>
            {agentGroupHistoryUnavailable && (
              <p className={`mt-2 text-xs ${isLight ? 'text-amber-800' : 'text-amber-200'}`} role="status">
                Shared history could not be loaded.
              </p>
            )}
            {agentGroupHistory.slice(0, 2).map((group) => (
              <div key={group.groupId} className="mt-2 border-t border-current/10 pt-2 first:border-0 first:pt-0"
                data-testid={`mediobot-shared-group-${group.groupId}`}>
                <p className={`truncate text-xs ${isLight ? 'text-neutral-500' : 'text-neutral-500'}`} title={group.taskGoal}>
                  {group.taskGoal}
                </p>
                <ul className="mt-1 space-y-1.5">
                  {group.messages.slice(-6).map((message) => (
                    <li key={message.id} data-testid={`mediobot-shared-message-${message.sequenceNumber}`}
                      className={`min-w-0 rounded-lg border px-3 py-2 ${isLight ? 'border-black/[0.08] bg-black/[0.015]' : 'border-white/[0.08] bg-white/[0.015]'}`}>
                      <p className={`text-xs ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}>
                        <span className={`${isLight ? 'text-neutral-900' : 'text-neutral-200'} font-medium`}>{message.senderName}</span>
                        {' · '}{message.kind === 'finding' ? 'Finding' : 'Request'} · #{message.sequenceNumber}
                      </p>
                      <p className={`mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed ${isLight ? 'text-neutral-800' : 'text-neutral-300'}`}
                        title={message.content}>
                        {message.content}
                      </p>
                      {!!message.evidenceRefs.length && (
                        <p className={`mt-0.5 text-[10px] ${isLight ? 'text-neutral-500' : 'text-neutral-500'}`}>
                          {message.evidenceRefs.length} evidence reference{message.evidenceRefs.length === 1 ? '' : 's'}
                        </p>
                      )}
                    </li>
                  ))}
                  {!!group.privateMessages?.length && (
                    <li className="mt-2 border-t border-current/10 pt-2" data-testid={`mediobot-private-messages-${group.groupId}`}>
                      <p className={`text-[10px] font-medium ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}>Private messages received</p>
                      <ul className="mt-1 space-y-1.5">
                        {group.privateMessages.slice(-2).map((message) => (
                          <li key={message.id} data-testid={`mediobot-private-message-${message.sequenceNumber}`}
                            className={`min-w-0 rounded-lg border px-3 py-2 ${isLight ? 'border-black/[0.08] bg-black/[0.015]' : 'border-white/[0.08] bg-white/[0.015]'}`}>
                          <p className={`text-xs ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}>
                              <span className={`${isLight ? 'text-neutral-900' : 'text-neutral-200'} font-medium`}>{message.senderName}</span>
                              {' · '}{message.kind === 'request' ? 'Request' : message.kind === 'response' ? 'Response' : 'Finding'}
                              {message.deliveryStatus !== 'delivered' ? ` · ${message.deliveryStatus}` : ''}
                            </p>
                          <p className={`mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed ${isLight ? 'text-neutral-800' : 'text-neutral-300'}`}
                              title={message.content}>
                              {message.content}
                            </p>
                            {!!message.evidenceRefs.length && (
                              <p className={`mt-0.5 text-[10px] ${isLight ? 'text-neutral-500' : 'text-neutral-500'}`}>
                                {message.evidenceRefs.length} evidence reference{message.evidenceRefs.length === 1 ? '' : 's'}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </li>
                  )}
                </ul>
              </div>
            ))}
          </section>
        )}

        {isMedioBotMode && currentAgent && recentAssignments.length > 0 && (
          <section className={`mt-4 w-full max-w-6xl shrink-0 rounded-xl border px-4 py-3 text-left ${
            isLight ? 'border-black/10 bg-black/[0.025]' : 'border-white/10 bg-white/[0.025]'
          }`} data-testid={`mediobot-task-history-${currentAgent.id}`} aria-label={`${currentAgent.name} recent assignments`}>
            <h2 className={`text-[11px] font-semibold uppercase tracking-wide ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}>
              Recent work
            </h2>
            <ul className="mt-2 space-y-2">
              {recentAssignments.map(({ task, latestEvent }) => {
                const activity = latestEvent?.toolName
                  ? `Used ${latestEvent.toolName}`
                  : latestEvent?.message ?? latestEvent?.type?.replaceAll('.', ' ');
                const activityEvents = specialistTaskActivity(task.events ?? []);
                return (
                  <li key={task.id} data-testid={`mediobot-assignment-${task.id}`} className="min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <p className={`min-w-0 line-clamp-2 text-xs leading-relaxed ${isLight ? 'text-neutral-900' : 'text-neutral-200'}`} title={task.goal}>{task.goal}</p>
                      <span className={`shrink-0 text-[10px] ${isLight ? 'text-neutral-500' : 'text-neutral-500'}`}>{task.state.replaceAll('_', ' ')}</span>
                    </div>
                    {activity && <p className={`mt-0.5 text-[11px] leading-relaxed ${isLight ? 'text-neutral-500' : 'text-neutral-500'}`} title={activity}>{activity}</p>}
                    {!!task.evidence?.length && <p className={`mt-0.5 text-[11px] ${isLight ? 'text-neutral-500' : 'text-neutral-500'}`}>{task.evidence.length} evidence records</p>}
                    {!!task.artifacts?.length && (
                      <p className={`mt-0.5 truncate text-[10px] ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}
                        data-testid={`mediobot-artifacts-${task.id}`} title={task.artifacts.map(artifact => artifact.reference).join(', ')}>
                        Files: {task.artifacts.slice(0, 3).map(artifact => artifact.name).join(', ')}
                        {task.artifacts.length > 3 ? ` +${task.artifacts.length - 3}` : ''}
                      </p>
                    )}
                    {activityEvents.length > 0 && (
                      <details className="mt-1.5">
                        <summary className={`cursor-pointer text-[10px] ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}>
                          Activity ({activityEvents.length})
                        </summary>
                        <ol className="mt-1.5 space-y-1 border-l border-current/15 pl-2.5">
                          {activityEvents.map((event, index) => (
                            <li key={`${event.occurredAt}-${event.type}-${index}`}
                              data-testid={`mediobot-task-event-${task.id}-${index}`}
                              className={`break-words text-[11px] leading-relaxed ${event.type?.endsWith('.failed')
                                ? (isLight ? 'text-rose-700' : 'text-rose-300')
                                : (isLight ? 'text-neutral-600' : 'text-neutral-400')}`}>
                              <time dateTime={new Date(event.occurredAt).toISOString()} className="mr-1 opacity-70">
                                {new Date(event.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </time>
                              {specialistTaskEventLabel(event)}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}


      </div>

      {/* Spacer between headline and bottom composer */}
      {!hasExistingWork && <div className="flex-1" />}

      {/* Floating Composer */}
      <div className="w-full">
        <Composer />
      </div>
    </div>
  );
};

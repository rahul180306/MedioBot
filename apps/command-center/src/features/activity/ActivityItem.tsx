import React, { useState } from 'react';
import { ThreadItem, Turn } from '../../types';
import {
  Brain,
  ListTodo,
  Search,
  FileEdit,
  Play,
  FlaskConical,
  CheckCircle,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  XCircle,
  Clock,
  Users,
  RotateCcw,
} from 'lucide-react';
import { DiffViewer } from './DiffViewer';
import { ToolExecutionView } from './ToolExecutionView';
import { ApprovalBanner } from './ApprovalBanner';
import { PerceptionView } from './PerceptionView';
import { useApp } from '../../state/AppContext';
import LatticeLoader from '../../components/LatticeLoader';

export const ActivityItem: React.FC<{
  item: ThreadItem;
  turnId: string;
  turnStatus?: Turn['status'];
  isActive?: boolean;
  isMainChat?: boolean;
}> = ({ item, turnId, turnStatus, isActive = false, isMainChat = false }) => {
  const { theme } = useApp();
  const isLight = theme === 'light';
  const [isDetailOpen, setIsDetailOpen] = useState(false);

  // If item is tool execution
  if (item.type === 'tool_execution' && item.tool) {
    return <ToolExecutionView tool={item.tool} />;
  }

  // If item is diff
  if (item.type === 'diff' && item.diff) {
    return <DiffViewer diff={item.diff} />;
  }

  // If item is approval request
  if (item.type === 'approval_request' && item.approval) {
    return <ApprovalBanner approval={item.approval} turnId={turnId} />;
  }

  // If item is perception or computer action
  if (item.type === 'perception_snapshot' || item.type === 'computer_action') {
    return <PerceptionView computerAction={item.computerAction} perception={item.perception} />;
  }

  // In Main Chat, only keep clean delegation notices (e.g. "Assigned Cody");
  // all internal thoughts, inspecting, and progress belong strictly to the specialist's separate chat!
  if (isMainChat) {
    const isDelegation = item.activityState === 'planning' || item.activityLabel?.startsWith('Assigned') || item.activityLabel?.includes('started working');
    if (isDelegation && item.activityLabel) {
      return (
        <div className={`flex items-center gap-2 py-1 text-xs select-none ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}>
          <span className="text-sky-400">🌐</span>
          <span className="font-medium">{item.activityLabel}</span>
        </div>
      );
    }
    // Suppress internal thoughts and intermediate progress in Main Chat
    return null;
  }

  // Activity steps (Thinking, Planning, Inspecting, Editing, Running, Testing, Verifying)
  const getIcon = () => {
    const isFailedLabel =
      item.activityState === 'failed' ||
      item.activityLabel?.toLowerCase().includes('fail') ||
      item.text?.toLowerCase().includes('fail') ||
      item.activityLabel?.toLowerCase().includes('error') ||
      item.text?.toLowerCase().includes('error');

    if (isFailedLabel || (turnStatus === 'failed' && isActive)) {
      return <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />;
    }
    if (turnStatus === 'cancelled' || item.activityState === 'cancelled') {
      return <XCircle className="w-3.5 h-3.5 text-neutral-500 shrink-0" />;
    }
    if (turnStatus === 'waiting_approval' && isActive) {
      return <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    }
    if (isActive) {
      return (
        <LatticeLoader
          status="working"
          label=""
          color={isLight ? '#475569' : '#d4d4d8'}
          fontSize={10}
          cellSize={3.5}
          gap={1.2}
          showTimer={false}
          className="shrink-0"
        />
      );
    }

    // Historical / completed events
    switch (item.activityState) {
      case 'thinking':
        return <Brain className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
      case 'planning':
        return <ListTodo className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
      case 'inspecting':
        return <Search className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
      case 'editing':
        return <FileEdit className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
      case 'running':
        return <Play className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
      case 'testing':
        return <FlaskConical className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
      case 'verifying':
        return <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
      case 'verified':
      case 'completed':
        return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500/80 shrink-0" />;
      case 'collaborating':
        return <Users className="w-3.5 h-3.5 text-neutral-400 shrink-0" />;
      case 'waiting':
      case 'waiting_for_approval':
        return <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
      case 'retrying':
      case 'recovered':
        return <RotateCcw className="w-3.5 h-3.5 text-sky-400 shrink-0" />;
      case 'blocked':
      case 'failed':
        return <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />;
      default:
        if (turnStatus === 'failed') {
          return <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />;
        }
        return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500/80 shrink-0" />;
    }
  };

  const hasDetail = Boolean(item.activityDetail);

  // Suppress mechanical lifecycle heartbeats that clutter the chat like in Image 5
  const isHeartbeatNoise =
    !hasDetail &&
    (item.activityLabel?.endsWith('progress.') ||
      item.activityLabel?.endsWith('started.') ||
      item.activityLabel?.toLowerCase() === 'mediobot is working on the task.' ||
      item.activityLabel?.toLowerCase() === 'cody progress.' ||
      item.activityLabel?.toLowerCase() === 'maestro task started.' ||
      item.activityLabel?.toLowerCase() === 'cody started.');

  if (isHeartbeatNoise && !isActive) {
    return null;
  }

  return (
    <div className="py-1 select-none">
      <div
        onClick={() => hasDetail && setIsDetailOpen((p) => !p)}
        className={`flex items-center gap-2 text-xs ${
          isLight ? 'text-[#64748b]' : 'text-neutral-400'
        } transition-colors ${
          hasDetail ? (isLight ? 'cursor-pointer hover:text-[#09090b]' : 'cursor-pointer hover:text-neutral-200') : ''
        }`}
      >
        <span className="shrink-0">{getIcon()}</span>
        <span className={`font-medium ${isLight ? 'text-[#18181b]' : 'text-neutral-300'}`}>{item.activityLabel || 'Activity'}</span>

        {item.durationMs && (
          <span className={`text-[11px] ${isLight ? 'text-[#94a3b8]' : 'text-neutral-500'} tabular-nums`}>
            {(item.durationMs / 1000).toFixed(1)}s
          </span>
        )}

        {hasDetail && (
          <span className={isLight ? 'text-[#94a3b8]' : 'text-neutral-500'}>
            {isDetailOpen ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
        )}
      </div>

      {isDetailOpen && item.activityDetail && (
        <div className={`mt-1 ml-5 p-2 ${
          isLight ? 'bg-[#f8f9fa] border-[#e2e4e8] text-[#334155]' : 'bg-[#17171b] border-[#26262d] text-neutral-400'
        } border rounded-md text-[11px] font-mono leading-relaxed whitespace-pre-line`}>
          {item.activityDetail}
        </div>
      )}
    </div>
  );
};

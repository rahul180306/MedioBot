import type { ToolExecutionData } from '../../types';

export function getOutcomeBadge(tool: ToolExecutionData): { label: string; className: string } | null {
  if (tool.recoveredFromExecution) {
    return {
      label: typeof tool.exitCode === 'number' ? `↺ restored · exit ${tool.exitCode}` : '↺ restored result',
      className: 'text-[10px] text-sky-300 bg-sky-950/40 border border-sky-800/50 px-1.5 py-0.5 rounded font-mono',
    };
  }
  if (tool.isVerification) {
    if (tool.verificationStatus === 'command-succeeded' || (tool.status === 'success' && tool.verificationStatus !== 'command-failed')) {
      return {
        label: '✓ check exited 0',
        className: 'text-[10px] text-emerald-400 bg-emerald-950/60 border border-emerald-700/60 px-1.5 py-0.5 rounded font-mono font-semibold',
      };
    }
    if (tool.status === 'cancelled' || tool.verificationStatus === 'unverified') {
      return {
        label: 'cancelled',
        className: 'text-[10px] text-neutral-400 bg-neutral-900 border border-neutral-700/50 px-1.5 py-0.5 rounded font-mono',
      };
    }
    if (typeof tool.exitCode === 'number') {
      return {
        label: `✗ check exited ${tool.exitCode}`,
        className: 'text-[10px] text-rose-400 bg-rose-950/60 border border-rose-700/60 px-1.5 py-0.5 rounded font-mono font-semibold',
      };
    }
    if (tool.terminationSignal) {
      return {
        label: `✗ terminated ${tool.terminationSignal}`,
        className: 'text-[10px] text-rose-400 bg-rose-950/60 border border-rose-700/60 px-1.5 py-0.5 rounded font-mono font-semibold',
      };
    }
    const launchCode = tool.error?.match(/^Command could not start \((ENOENT|EACCES|EPERM|ETIMEDOUT)\)\.$/)?.[1];
    if (launchCode) {
      return {
        label: `✗ could not start (${launchCode})`,
        className: 'text-[10px] text-rose-400 bg-rose-950/60 border border-rose-700/60 px-1.5 py-0.5 rounded font-mono font-semibold',
      };
    }
    if (tool.verificationStatus === 'command-failed' || tool.status === 'failed') {
      return {
        label: '✗ check failed',
        className: 'text-[10px] text-rose-400 bg-rose-950/60 border border-rose-700/60 px-1.5 py-0.5 rounded font-mono font-semibold',
      };
    }
  }

  if (tool.failureCategory && tool.status === 'failed') {
    return {
      label: tool.failureCategory,
      className: 'text-[10px] text-rose-400 bg-rose-950/40 border border-rose-800/50 px-1.5 py-0.5 rounded font-mono',
    };
  }

  if (tool.status === 'success') {
    if (tool.toolName === 'terminal.execute') {
      return {
        label: 'exit 0',
        className: 'text-[10px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-1.5 py-0.5 rounded font-mono',
      };
    }
    if (tool.toolName === 'filesystem.read') {
      return {
        label: 'read',
        className: 'text-[10px] text-sky-400 bg-sky-950/40 border border-sky-800/40 px-1.5 py-0.5 rounded font-mono',
      };
    }
    if (tool.toolName === 'filesystem.write') {
      return {
        label: 'saved',
        className: 'text-[10px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-1.5 py-0.5 rounded font-mono',
      };
    }
    if (tool.toolName === 'filesystem.list') {
      return {
        label: 'listed',
        className: 'text-[10px] text-neutral-400 bg-neutral-900 border border-neutral-700/50 px-1.5 py-0.5 rounded font-mono',
      };
    }
  }

  return null;
}

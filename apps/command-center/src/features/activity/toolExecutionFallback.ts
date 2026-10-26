import type { ToolExecutionData } from '../../types';

export function toolOutputFallback(toolName: string, status: ToolExecutionData['status']): string {
  if (toolName.startsWith('filesystem.')) {
    return status === 'running' ? 'Filesystem operation in progress...'
      : status === 'failed' ? 'Filesystem operation failed.' : 'Filesystem operation completed.';
  }
  return status === 'running' ? 'Executing process...' : 'No output captured.';
}

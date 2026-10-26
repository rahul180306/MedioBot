import React from 'react';
import type { ToolExecutionData } from '../../types';
import { useApp } from '../../state/AppContext';
import { parseToolAction, CodexToolRow } from './CodexExecutionView';

export const ToolExecutionView: React.FC<{ tool: ToolExecutionData }> = ({ tool }) => {
  const { theme } = useApp();
  const isLight = theme === 'light';
  const action = parseToolAction(tool);

  return (
    <div className="my-0.5">
      <CodexToolRow action={action} isLight={isLight} />
    </div>
  );
};

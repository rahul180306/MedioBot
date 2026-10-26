import {
  Thread,
  ProjectInfo,
  ThreadItem,
  AgentActivityState,
  ApprovalMode,
  ModelOption,
  FileDiff,
  ToolExecutionData,
  ApprovalRequestData,
  ComputerActionData,
  PerceptionData,
  Turn,
} from './types/index.ts';

export type RuntimeEventType =
  | 'agent.started'
  | 'agent.progress'
  | 'worker.assigned'
  | 'worker.message'
  | 'tool.started'
  | 'tool.progress'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.cancelled'
  | 'approval.required'
  | 'approval.resolved'
  | 'file.changed'
  | 'diff.created'
  | 'screenshot.available'
  | 'computer.action'
  | 'perception.updated'
  | 'task.completed'
  | 'task.failed'
  | 'turn.snapshot';

export interface RuntimeEvent {
  type: RuntimeEventType;
  turnId: string;
  threadId: string;
  timestamp: number;
  payload: {
    activityState?: AgentActivityState;
    message?: string;
    item?: ThreadItem;
    tool?: ToolExecutionData;
    diff?: FileDiff;
    approval?: ApprovalRequestData;
    computerAction?: ComputerActionData;
    perception?: PerceptionData;
    summary?: string;
    turn?: Turn;
  };
}

export interface TurnOptions {
  model: ModelOption;
  approvalMode: ApprovalMode;
  project: ProjectInfo;
  branch: string;
}

export interface IMediobotRuntime {
  startTurn(threadId: string, prompt: string, options: TurnOptions): Promise<string>;
  respondToApproval(turnId: string, approvalId: string, approved: boolean): Promise<void>;
  cancelTurn(threadId: string, turnId: string): Promise<void>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  getInitialProjects(): ProjectInfo[];
  getInitialThreads(): Thread[];
}

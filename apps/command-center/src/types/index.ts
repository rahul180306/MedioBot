export type AgentActivityState = import('@mediobot-v2/domain').WorkerActivityState;

export type ApprovalRisk = 'low' | 'medium' | 'high';
export type ApprovalStatus = 'pending' | 'requested' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export type AgentStatus = 'idle' | 'active' | 'working' | 'waiting' | 'completed' | 'failed';

export interface MedioBotAgent {
  /** Stable durable runtime identity. */
  definitionId?: string;
  id: string;
  /** Legacy preference key retained so existing per-bot model settings survive. */
  preferenceId?: string;
  name: string;
  group?: 'orchestrator' | 'specialist';
  role?: string;
  status: AgentStatus;
  availability?: 'available' | 'development' | 'unavailable' | 'not-configured';
  directConversationAvailable?: boolean;
  currentTask?: string;
  activityState?: AgentActivityState;
  icon?: string;
  lastActiveAt?: number;
}

export interface FileDiff {
  filePath: string;
  language?: string;
  additions: number;
  deletions: number;
  truncated?: boolean;
  hunks?: {
    header?: string;
    oldStart?: number;
    oldLines?: number;
    newStart?: number;
    newLines?: number;
    lines: {
      type: 'context' | 'add' | 'remove';
      content: string;
      oldLineNo?: number;
      newLineNo?: number;
    }[];
  }[];
}

export interface ToolExecutionData {
  toolInvocationId?: string;
  toolName: string;
  command?: string;
  workingDirectory?: string;
  recoveryReason?: string;
  inputArgs?: Record<string, unknown> | string;
  outputLog?: string;
  output?: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  startedAt?: number;
  durationMs?: number;
  error?: string;
  errorCode?: string;
  failureCategory?: string;
  recoveredFromExecution?: boolean;
  isVerification?: boolean;
  /** Reports command execution only; it is not proof that task requirements are met. */
  verificationStatus?: 'command-succeeded' | 'command-failed' | 'unverified';
  exitCode?: number | null;
  terminationSignal?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  eventSequence?: number;
  lifecycleConflict?: boolean;
  outcomeBadge?: string;
}

/** Safe, bounded failure metadata for the durable turn transcript. Never stores model output. */
export interface TurnFailureData {
  stage: 'maestro-decision';
  category: 'structural' | 'semantic' | 'provider' | 'runtime';
  reason?: 'invalid-json' | 'non-object-response' | 'missing-intent' | 'unsupported-intent' | 'intent-not-available'
    | 'schema-mismatch' | 'unknown-delegation' | 'unavailable-capability' | 'insufficient-evidence' | 'repair-intent-changed'
    | 'configuration' | 'authentication' | 'capacity' | 'timeout' | 'cancelled' | 'transport' | 'invalid-response'
    | 'structured-parse' | 'unsupported-modality';
  providerId?: string;
  modelId?: string;
}

export interface ComputerActionData {
  action: 'click' | 'type' | 'scroll' | 'hotkey' | 'open_window';
  target?: string;
  coordinate?: { x: number; y: number };
  keys?: string;
  status: 'executing' | 'completed';
}

export interface PerceptionData {
  windowTitle: string;
  focusedApp: string;
  detectedElementsCount: number;
  visualSummary?: string;
  confidenceScore?: number;
}

export interface ApprovalRequestData {
  approvalId: string;
  title: string;
  description: string;
  risk: ApprovalRisk;
  status: ApprovalStatus;
  mediobotName?: string;
  workspace?: string;
  reason?: string;
  actionPayload?: {
    type: 'file_write' | 'terminal_command' | 'git_push' | 'os_permission';
    detail: string;
  };
}

export type ThreadItemType =
  | 'user_message'
  | 'agent_message'
  | 'activity'
  | 'tool_execution'
  | 'diff'
  | 'approval_request'
  | 'computer_action'
  | 'perception_snapshot'
  | 'perception';

export type ConversationActor =
  | { readonly type: 'user'; readonly name?: string }
  | { readonly type: 'system'; readonly name?: string }
  | { readonly type: 'mediobot'; readonly mediobotId?: string; readonly name?: string; readonly presentationId?: string; readonly role?: string };

export interface ThreadItem {
  id: string;
  turnId: string;
  type: ThreadItemType;
  /** Explicit producer identity. Never infer this from visible message text. */
  actor?: ConversationActor;
  timestamp: number;
  
  // Content variants
  text?: string;
  activityState?: AgentActivityState;
  activityLabel?: string;
  activityDetail?: string;
  durationMs?: number;
  
  // Structured payloads
  diff?: FileDiff;
  tool?: ToolExecutionData;
  approval?: ApprovalRequestData;
  computerAction?: ComputerActionData;
  perception?: PerceptionData;
  attachments?: TurnAttachment[];
  eventSequence?: number;
  failure?: TurnFailureData;
}

export interface TurnAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface Turn {
  id: string;
  threadId: string;
  prompt: string;
  status: 'idle' | 'running' | 'pause_requested' | 'paused' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  currentActivity?: AgentActivityState;
  createdAt: number;
  updatedAt?: number;
  completedAt?: number;
  taskId?: string;
  /** Set by the API when the durable execution record can be resumed. */
  recoveryState?: 'interrupted' | 'queued' | 'paused';
  lastEventSequence?: number;
  items: ThreadItem[];
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  branch: string;
  branches: string[];
  environment: 'Local' | 'Remote Container' | 'Cloud Sandbox';
  packageManager?: string;
  framework?: string;
}

export type ApprovalMode =
  | 'Ask for approval'
  | 'Approve for me'
  | 'Full access'
  | 'Ask before edits'
  | 'Ask before commands'
  | 'Full manual review'
  | 'Review changes';

export type ModelOption =
  | 'Gemini 3.8 Flash'
  | 'Gemini 3.1 Pro Preview'
  | 'Gemini 3.1 Flash Lite'
  | 'Gemini 3.8 Live'
  | 'Gemini 3.1 Flash Image'
  | 'Claude 3.7 Sonnet'
  | 'Claude 3.5 Haiku'
  | 'GPT-4o'
  | 'o3-mini'
  | 'DeepSeek R1 (Local)'
  | 'Llama 3.3 70B'
  | 'Big Pickle'
  | 'Ling 3.0 Flash Fin Free'
  | 'LongCat 2.5 Preview Free'
  | 'MiMo - V2.6 - Flash Free'
  | 'Muse Spark 1.3 Free'
  | 'Nemotron 3 Ultra Free'
  | 'Nemotron 3.5 Lightning Free'
  | 'Code Engine Light'
  | 'Code Engine Core'
  | 'Code Engine Fast'
  | 'Custom Medium'
  | 'Mediobot Ultra 2.5'
  | 'Mediobot Fast Code'
  | 'Claude 3.7 Sonnet (Mock)'
  | (string & {});

export interface CustomHeader {
  id: string;
  name: string;
  value: string;
}

export interface ConfiguredModel {
  id: string;
  name: string;
  enabled: boolean;
  tag?: string;
  context?: string;
  description?: string;
  isCustom?: boolean;
  capabilities?: {
    text: boolean;
    reasoning: boolean;
    vision: boolean;
    tools: boolean;
    structuredOutput?: boolean;
    maestroCompatible?: boolean;
  };
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: 'builtin' | 'custom';
  description?: string;
  badge?: string;
  iconType: string;
  connected: boolean;
  enabled: boolean;
  credentialStatus?: 'configured' | 'missing';
  baseUrl?: string;
  apiKey?: string;
  headers?: CustomHeader[];
  models: ConfiguredModel[];
}

export interface FileNode {
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: FileNode[];
  content?: string;
}

export interface DynamicModelInfo {
  id: string;
  name: string;
  provider: 'Google Gemini' | 'OpenCode Zen';
  badge?: string;
  tag?: string;
  context?: string;
  description?: string;
  isAvailable?: boolean;
}

export interface ProviderConnectionStatus {
  provider: string;
  connected: boolean;
  keyConfigured: boolean;
  latencyMs?: number;
  message?: string;
}

export interface UserProfile {
  name: string;
  email: string;
  avatarText: string;
  isSignedIn: boolean;
}

export interface ThreadModelSelection {
  readonly providerConnectionId: string;
  readonly providerId?: string;
  readonly modelId: string;
  readonly reasoningEffort?: "low" | "medium" | "high" | "extra" | "max";
  readonly taskId?: string;
  readonly workspaceId?: string | null;
}

export interface Thread {
  id: string;
  title: string;
  projectId?: string;
  specialistId?: string;
  createdAt: number;
  updatedAt: number;
  model?: ModelOption;
  modelSelection?: ThreadModelSelection;
  readonly reasoningEffort?: "low" | "medium" | "high" | "extra" | "max";
  branch?: string;
  approvalMode?: ApprovalMode;
  turns: Turn[];
}

export type WorkbenchTab =
  | {
      readonly id: string;
      readonly kind: 'file';
      readonly path: string;
      readonly name: string;
    }
  | {
      readonly id: string;
      readonly kind: 'chat';
      readonly threadId: string;
      readonly title: string;
    };

export type AppModal = 'settings' | 'projects' | 'export_zip' | 'shortcuts' | null;

export type ThemeMode = 'dark' | 'light';

export interface ModelCapabilities {
  readonly text?: boolean;
  readonly code?: boolean;
  readonly vision?: boolean;
  readonly tools?: boolean;
  readonly json?: boolean;
}

export interface CatalogProviderItem {
  readonly id: string;
  readonly name: string;
  readonly subtitle?: string;
  readonly badge?: string;
  readonly group: 'Popular' | 'Other';
  readonly iconType: string;
  readonly isCustom?: boolean;
  readonly adapterType?: string;
  readonly defaultModels: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly capabilities?: ModelCapabilities;
    readonly context?: string;
    readonly tag?: string;
    readonly description?: string;
  }>;
  readonly defaultBaseUrl?: string;
  readonly requiresApiKey: boolean;
  readonly configurableBaseUrl: boolean;
  readonly documentationUrl?: string;
}

export interface AgentModelPreference {
  modelKey: string;
  effort: string;
}

export type ExpressionEyeShape = 'bars' | 'happy' | 'focused' | 'surprise' | 'wink' | 'sleep' | 'hearts' | 'stars' | 'shades' | 'curious' | 'glitch' | (string & {});
export type ExpressionAnimation = 'blink' | 'bounce' | 'pulse' | 'gaze' | 'laser-glow' | 'rapid-shimmer' | 'sleep-float' | 'wink-cycle' | (string & {});

export interface MedioBotExpression {
  id: string;
  name: string;
  category: 'mood' | 'focus' | 'reaction' | 'custom' | (string & {});
  eyeShape: ExpressionEyeShape;
  animation: ExpressionAnimation;
  moodColor: string;
  description: string;
  isCustom?: boolean;
  createdAt?: number;
}

export { mergeMonotonicToolData, type MonotonicToolData } from '../utils/monotonicMerge';

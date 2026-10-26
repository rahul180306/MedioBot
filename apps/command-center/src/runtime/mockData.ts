import type {
  Thread,
  ProjectInfo,
  FileNode,
  ProviderConfig,
  CatalogProviderItem,
  Turn,
} from '../types';
import type { WorkspaceSession, PersistedWorkspaceUIState } from './types';

export const MOCK_SESSION: WorkspaceSession = {
  workspaceId: 'workspace-demo-1',
  canonicalRootPath: '/workspace/mediobot-demo',
  displayName: 'mediobot-demo',
  openedAt: Date.now() - 3600000,
};

export const MOCK_PROJECTS: ProjectInfo[] = [
  {
    id: 'workspace-demo-1',
    name: 'mediobot-demo',
    path: '/workspace/mediobot-demo',
    branch: 'main',
    branches: ['main', 'feature/auth-refresh', 'fix/calc-zero'],
    environment: 'Local',
  },
  {
    id: 'project-web-suite',
    name: 'web-automation-suite',
    path: '/workspace/web-automation',
    branch: 'main',
    branches: ['main'],
    environment: 'Local',
  },
];

export const MOCK_FILES: Record<string, string> = {
  'src/calculator.js': `// Calculator implementation
export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a * b;
}

export function divide(a, b) {
  if (b === 0) {
    throw new Error('Division by zero is not allowed');
  }
  return a / b;
}
`,
  'tests/calculator.test.js': `import assert from 'node:assert/strict';
import test from 'node:test';
import { add, subtract, multiply, divide } from '../src/calculator.js';

test('calculator arithmetic operations', () => {
  assert.equal(add(2, 2), 4);
  assert.equal(subtract(5, 3), 2);
  assert.equal(multiply(3, 3), 9);
  assert.equal(divide(10, 2), 5);
});

test('divide by zero guard', () => {
  assert.throws(() => divide(10, 0), /Division by zero/);
});
`,
  'src/index.ts': `import { add, subtract, multiply, divide } from './calculator.js';

console.log('MedioBot Demo Runtime initialized.');
console.log('Sample calculation: 42 * 2 =', multiply(42, 2));
`,
  'package.json': `{
  "name": "mediobot-demo-workspace",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test tests/*.test.js"
  }
}
`,
  'README.md': `# MedioBot Demo Project

This is a synthetic mock workspace bundled with the standalone MedioBot V2 Frontend export.
It allows testing and redesigning all UI features without connecting to a live backend.

## Included Components
- **File Explorer & Code Editor**: Click on files in the left sidebar to open them in tabs.
- **Chat & Execution Timeline**: Inspect live tool execution cards, verification badges, and file diffs.
- **Models & Settings**: Configure AI providers, model toggles, and UI preferences.
`,
};

export const MOCK_FILE_NODES: FileNode[] = [
  {
    name: 'src',
    path: 'src',
    type: 'folder',
    children: [
      { name: 'calculator.js', path: 'src/calculator.js', type: 'file' },
      { name: 'index.ts', path: 'src/index.ts', type: 'file' },
    ],
  },
  {
    name: 'tests',
    path: 'tests',
    type: 'folder',
    children: [
      { name: 'calculator.test.js', path: 'tests/calculator.test.js', type: 'file' },
    ],
  },
  { name: 'package.json', path: 'package.json', type: 'file' },
  { name: 'README.md', path: 'README.md', type: 'file' },
];

export const MOCK_THREADS: Thread[] = [
  {
    id: 'thread-demo-1',
    title: 'Fix calculator division by zero defect',
    projectId: 'workspace-demo-1',
    createdAt: Date.now() - 7200000,
    updatedAt: Date.now() - 3600000,
    model: 'MiniMax-M2.7',
    modelSelection: { providerConnectionId: 'minimax', providerId: 'minimax', modelId: 'MiniMaxAI/MiniMax-M2.7' },
    branch: 'main',
    approvalMode: 'Approve for me',
    turns: [
      {
        id: 'turn-demo-1',
        threadId: 'thread-demo-1',
        prompt: 'Fix the division by zero error in calculator.js and verify with tests',
        status: 'completed',
        createdAt: Date.now() - 3600000,
        completedAt: Date.now() - 3590000,
        items: [
          {
            id: 'item-user-1',
            turnId: 'turn-demo-1',
            type: 'user_message',
            actor: { type: 'user', name: 'User' },
            timestamp: Date.now() - 3600000,
            text: 'Fix the division by zero error in calculator.js and verify with tests',
          },
          {
            id: 'item-maestro-1',
            turnId: 'turn-demo-1',
            type: 'agent_message',
            actor: { type: 'mediobot', name: 'Maestro', role: 'Team orchestration' },
            timestamp: Date.now() - 3598000,
            text: 'I have assigned Cody to inspect `calculator.js`, implement a guarded division check, and verify the fix against `tests/calculator.test.js`.',
          },
          {
            id: 'item-act-1',
            turnId: 'turn-demo-1',
            type: 'activity',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now() - 3597000,
            activityState: 'inspecting',
            activityLabel: 'Inspecting calculator.js',
            text: 'Cody inspected calculator.js',
          },
          {
            id: 'item-tool-1',
            turnId: 'turn-demo-1',
            type: 'tool_execution',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now() - 3596000,
            text: 'filesystem.read src/calculator.js',
            tool: {
              toolName: 'filesystem.read',
              command: 'filesystem.read src/calculator.js',
              status: 'success',
              startedAt: Date.now() - 3596120,
              durationMs: 120,
              outcomeBadge: 'success',
            },
          },
          {
            id: 'item-diff-1',
            turnId: 'turn-demo-1',
            type: 'diff',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now() - 3594000,
            diff: {
              filePath: 'src/calculator.js',
              additions: 3,
              deletions: 0,
              hunks: [
                {
                  oldStart: 13,
                  oldLines: 2,
                  newStart: 13,
                  newLines: 5,
                  lines: [
                    { type: 'context', content: 'export function divide(a, b) {' },
                    { type: 'add', content: '  if (b === 0) {' },
                    { type: 'add', content: "    throw new Error('Division by zero is not allowed');" },
                    { type: 'add', content: '  }' },
                    { type: 'context', content: '  return a / b;' },
                    { type: 'context', content: '}' },
                  ],
                },
              ],
            },
          },
          {
            id: 'item-tool-2',
            turnId: 'turn-demo-1',
            type: 'tool_execution',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now() - 3592000,
            text: 'terminal.execute node --test tests/calculator.test.js',
            tool: {
              toolName: 'terminal.execute',
              command: 'node --test tests/calculator.test.js',
              status: 'success',
              startedAt: Date.now() - 3592340,
              durationMs: 340,
              isVerification: true,
              verificationStatus: 'command-succeeded',
              outcomeBadge: '✓ verified (exit 0)',
              outputLog: '✔ calculator arithmetic operations (1.2ms)\n✔ divide by zero guard (0.8ms)\n\nℹ tests 2\nℹ suites 0\nℹ pass 2\nℹ fail 0\nℹ duration_ms 42.1',
            },
          },
          {
            id: 'item-agent-1',
            turnId: 'turn-demo-1',
            type: 'agent_message',
            actor: { type: 'mediobot', name: 'Cody', role: 'Software engineering' },
            timestamp: Date.now() - 3590000,
            text: 'I have updated `src/calculator.js` to guard against zero divisors and verified that both arithmetic and error assertions pass deterministically (exit code 0).',
          },
        ],
      },
    ],
  },
  {
    id: 'thread-demo-2',
    title: 'Inspect checkout modal flow in browser',
    projectId: 'workspace-demo-1',
    createdAt: Date.now() - 14400000,
    updatedAt: Date.now() - 7200000,
    model: 'google/diffusiongemma-26b-a4b-it',
    modelSelection: { providerConnectionId: 'nvidia', providerId: 'nvidia', modelId: 'google/diffusiongemma-26b-a4b-it' },
    branch: 'main',
    approvalMode: 'Review changes',
    turns: [
      {
        id: 'turn-demo-2',
        threadId: 'thread-demo-2',
        prompt: 'Check if the checkout modal button opens correctly',
        status: 'completed',
        createdAt: Date.now() - 7200000,
        completedAt: Date.now() - 7190000,
        items: [
          {
            id: 'item-user-2',
            turnId: 'turn-demo-2',
            type: 'user_message',
            actor: { type: 'user', name: 'User' },
            timestamp: Date.now() - 7200000,
            text: 'Check if the checkout modal button opens correctly',
          },
          {
            id: 'item-act-vis-1',
            turnId: 'turn-demo-2',
            type: 'activity',
            actor: { type: 'mediobot', name: 'Vision', role: 'Browser and visual work' },
            timestamp: Date.now() - 7198000,
            activityState: 'running',
            activityLabel: 'Navigating to localhost:3000/cart',
            text: 'Vision opened cart page',
          },
          {
            id: 'item-percep-1',
            turnId: 'turn-demo-2',
            type: 'perception',
            actor: { type: 'mediobot', name: 'Vision', role: 'Browser and visual work' },
            timestamp: Date.now() - 7195000,
            perception: {
              focusedApp: 'Chromium',
              windowTitle: 'Shopping Cart - MedioBot Demo',
              visualSummary: 'Observed Cart page with 2 items and a primary blue [Proceed to Checkout] button.',
              confidenceScore: 0.96,
              detectedElementsCount: 8,
            },
            computerAction: {
              action: 'click',
              target: 'button#checkout-btn',
              coordinate: { x: 540, y: 720 },
              status: 'completed',
            },
          },
          {
            id: 'item-agent-2',
            turnId: 'turn-demo-2',
            type: 'agent_message',
            actor: { type: 'mediobot', name: 'Vision', role: 'Browser and visual work' },
            timestamp: Date.now() - 7190000,
            text: 'The checkout modal launched as expected with payment provider options and order totals verified.',
          },
        ],
      },
    ],
  },
];

export const MOCK_PROVIDERS: ProviderConfig[] = [
  {
    id: 'dahl',
    name: 'Dahl',
    type: 'builtin',
    description: 'High-throughput coding model with advanced reasoning support.',
    iconType: 'minimax',
    badge: 'Coding Specialist',
    connected: true,
    enabled: true,
    baseUrl: 'https://inference.dahl.global/v1',
    models: [
      { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7', enabled: true, tag: 'Reasoning', context: '128K', description: 'Primary coding agent model', capabilities: { text: true, reasoning: true, vision: false, tools: true, structuredOutput: true, maestroCompatible: true } },
    ],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    type: 'builtin',
    description: 'Accelerated vision and multimodal perception inference.',
    iconType: 'nvidia',
    badge: 'Vision Specialist',
    connected: true,
    enabled: true,
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      { id: 'google/diffusiongemma-26b-a4b-it', name: 'DiffusionGemma 26B', enabled: true, tag: 'Vision', context: '32K', description: 'Computer control perception', capabilities: { text: true, reasoning: false, vision: true, tools: false, structuredOutput: false, maestroCompatible: false } },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'builtin',
    description: 'Industry-standard language and reasoning models.',
    iconType: 'openai',
    badge: 'Popular',
    connected: false,
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', enabled: false, tag: 'High Intelligence', description: 'Multimodal flagship model' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', enabled: false, tag: 'Fast', description: 'Lightweight fast model' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'builtin',
    description: 'Claude models built for safety, steerability, and coding excellence.',
    iconType: 'anthropic',
    badge: 'Popular',
    connected: false,
    enabled: false,
    baseUrl: 'https://api.anthropic.com/v1',
    models: [
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', enabled: false, tag: 'Top Coding', description: 'State-of-the-art coding benchmark' },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'builtin',
    description: 'Google multimodal models with immense context windows.',
    iconType: 'gemini',
    badge: 'Multimodal',
    connected: false,
    enabled: false,
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', enabled: false, tag: '2M Context', description: 'Deep reasoning model' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', enabled: false, tag: 'Ultra Fast', description: 'Low latency assistant' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    type: 'custom',
    description: 'Locally hosted open models with zero telemetry.',
    iconType: 'ollama',
    badge: 'Local',
    connected: false,
    enabled: false,
    baseUrl: 'http://localhost:11434/v1',
    models: [
      { id: 'llama3.3:70b', name: 'Llama 3.3 70B', enabled: false, tag: 'Open Weights' },
    ],
  },
];

export const MOCK_CATALOG: CatalogProviderItem[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    subtitle: 'GPT-4o, GPT-4o mini, o1',
    badge: 'Popular',
    group: 'Popular',
    iconType: 'openai',
    requiresApiKey: true,
    configurableBaseUrl: true,
    defaultModels: [
      { id: 'gpt-4o', name: 'GPT-4o', context: '128k', tag: 'Flagship' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', context: '128k', tag: 'Fast' },
      { id: 'o1', name: 'o1', context: '200k', tag: 'Deep Reasoning' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    subtitle: 'Claude 3.5 Sonnet, Haiku',
    badge: 'Popular',
    group: 'Popular',
    iconType: 'anthropic',
    requiresApiKey: true,
    configurableBaseUrl: true,
    defaultModels: [
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', context: '200k', tag: 'Coding Champion' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', context: '200k', tag: 'Speed' },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    subtitle: 'Gemini 2.5 Pro, Flash',
    badge: 'Recommended',
    group: 'Popular',
    iconType: 'gemini',
    requiresApiKey: true,
    configurableBaseUrl: false,
    defaultModels: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', context: '2M', tag: 'Deep Context' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', context: '1M', tag: 'Fast' },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    subtitle: 'MiniMax-M2.7',
    badge: 'Coding Specialist',
    group: 'Popular',
    iconType: 'minimax',
    requiresApiKey: true,
    configurableBaseUrl: true,
    defaultModels: [
      { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax-M2.7', context: '128k', tag: 'MedioBot Cody' },
    ],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    subtitle: 'DiffusionGemma, Llama 3 Vision',
    badge: 'Vision Specialist',
    group: 'Popular',
    iconType: 'nvidia',
    requiresApiKey: true,
    configurableBaseUrl: true,
    defaultModels: [
      { id: 'google/diffusiongemma-26b-a4b-it', name: 'DiffusionGemma 26B', context: '32k', tag: 'MedioBot Vision' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    subtitle: 'Local open-source models',
    badge: 'Local',
    group: 'Other',
    iconType: 'ollama',
    requiresApiKey: false,
    configurableBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModels: [
      { id: 'llama3.3:70b', name: 'Llama 3.3 70B', context: '128k' },
      { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B', context: '32k' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    subtitle: 'Unified API for 100+ models',
    badge: 'Aggregator',
    group: 'Other',
    iconType: 'openrouter',
    requiresApiKey: true,
    configurableBaseUrl: true,
    defaultModels: [
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
    ],
  },
  {
    id: 'custom',
    name: 'Custom OpenAI-Compatible',
    subtitle: 'Any self-hosted or proxy endpoint',
    badge: 'Self-Hosted',
    group: 'Other',
    iconType: 'custom',
    requiresApiKey: false,
    configurableBaseUrl: true,
    defaultModels: [
      { id: 'custom-model', name: 'Custom Model' },
    ],
  },
];

export const MOCK_DEFINITIONS = [
  {
    id: 'maestro',
    name: 'Maestro',
    group: 'orchestrator' as const,
    role: 'Team orchestration',
    summary: 'Delegate work to specialized Mediobots',
    description: 'Plans and coordinates multi-agent execution',
    availability: 'available',
    executable: true,
  },
  {
    id: 'definition-cody',
    name: 'Cody',
    group: 'specialist' as const,
    role: 'Software engineering',
    summary: 'Inspect, edit, build, and verify project code when assigned by Maestro',
    description: 'Inspect, edit, build, and verify project code when assigned by Maestro',
    availability: 'available',
    executable: true,
  },
  {
    id: 'definition-vision',
    name: 'Vision',
    group: 'specialist' as const,
    role: 'Browser and visual work',
    summary: 'Structured browser observation and action',
    description: 'Analyzes visual UI state, browser actions, and screenshots',
    availability: 'available',
    executable: true,
  },
  {
    id: 'definition-doc',
    name: 'Doc',
    group: 'specialist' as const,
    role: 'Documentation intelligence',
    summary: 'Analyze and generate documentation, API references, and architecture guides',
    description: 'Documentation intelligence and architecture synthesis',
    availability: 'available',
    executable: false,
  },
  {
    id: 'definition-research',
    name: 'Research',
    group: 'specialist' as const,
    role: 'Web research',
    summary: 'Deep research, information retrieval, and synthesis',
    description: 'Text analysis and web research when assigned by Maestro',
    availability: 'available',
    executable: false,
  },
  {
    id: 'definition-tester',
    name: 'Tester',
    group: 'specialist' as const,
    role: 'Independent verification',
    summary: 'Automated test suite execution and verification',
    description: 'Independent verification and assertion validation',
    availability: 'available',
    executable: false,
  },
  {
    id: 'definition-deployer',
    name: 'Deployer',
    group: 'specialist' as const,
    role: 'Deployment',
    summary: 'CI/CD pipeline and release deployment operations',
    description: 'Deployments, preview environments, and release verification',
    availability: 'available',
    executable: false,
  },
];


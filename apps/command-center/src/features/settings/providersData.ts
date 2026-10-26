import { ProviderConfig } from '../../types';

export const INITIAL_PROVIDERS: ProviderConfig[] = [
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    type: 'builtin',
    description: 'Reliable optimized models',
    iconType: 'opencode',
    connected: true,
    enabled: true,
    models: [
      { id: 'big-pickle', name: 'Big Pickle', enabled: true, tag: 'Free', context: '128K' },
      { id: 'ling-3-flash', name: 'Ling 3.0 Flash Fin Free', enabled: true, tag: 'Free', context: '128K' },
      { id: 'longcat-25', name: 'LongCat 2.5 Preview Free', enabled: true, tag: 'Free', context: '128K' },
      { id: 'mimo-v26', name: 'MiMo-V2.6-Flash Free', enabled: true, tag: 'Free', context: '64K' },
      { id: 'muse-spark-13', name: 'Muse Spark 1.3 Free', enabled: true, tag: 'Free', context: '64K' },
      { id: 'nemotron-3-ultra', name: 'Nemotron 3 Ultra Free', enabled: false, tag: 'Free', context: '128K' },
      { id: 'nemotron-35-lightning', name: 'Nemotron 3.5 Lightning Free', enabled: false, tag: 'Free', context: '128K' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'builtin',
    description: 'Frontier reasoning & code comprehension',
    iconType: 'anthropic',
    connected: true,
    enabled: true,
    models: [
      { id: 'claude-fable-5', name: 'Claude Fable 5', enabled: false, tag: 'Preview', context: '200K' },
      { id: 'claude-fable-51', name: 'Claude Fable 5.1', enabled: true, tag: 'Reasoning', context: '200K' },
      { id: 'claude-haiku-45', name: 'Claude Haiku 4.5', enabled: false, tag: 'Fast', context: '200K' },
      { id: 'claude-opus-45', name: 'Claude Opus 4.5', enabled: false, tag: 'Deep Logic', context: '200K' },
      { id: 'claude-37-sonnet', name: 'Claude 3.7 Sonnet', enabled: true, tag: 'Hybrid Thinking', context: '200K' },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    type: 'builtin',
    description: 'Gemini multimodal & high-speed reasoning',
    iconType: 'google',
    connected: true,
    enabled: true,
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', enabled: true, tag: 'Default', context: '1M tokens' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', enabled: true, tag: 'Pro', context: '2M tokens' },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', enabled: true, tag: 'Lite', context: '1M tokens' },
      { id: 'gemini-3.8-live', name: 'Gemini 3.8 Live', enabled: false, tag: 'Streaming', context: '128K tokens' },
      { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image', enabled: false, tag: 'Vision', context: '1M tokens' },
    ],
  },
];

export interface CatalogProviderItem {
  id: string;
  name: string;
  subtitle?: string;
  badge?: string;
  group: 'Popular' | 'Other';
  iconType: ProviderConfig['iconType'];
  defaultModels: Array<{ id: string; name: string }>;
  isCustom?: boolean;
}

export const CATALOG_PROVIDERS: CatalogProviderItem[] = [
  // Popular
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    subtitle: 'Reliable optimized models',
    group: 'Popular',
    iconType: 'opencode',
    defaultModels: [
      { id: 'big-pickle', name: 'Big Pickle' },
      { id: 'ling-3-flash', name: 'Ling 3.0 Flash Fin Free' },
      { id: 'longcat-25', name: 'LongCat 2.5 Preview Free' },
      { id: 'mimo-v26', name: 'MiMo-V2.6-Flash Free' },
      { id: 'muse-spark-13', name: 'Muse Spark 1.3 Free' },
    ],
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    subtitle: 'Low cost subscription for everyone',
    group: 'Popular',
    iconType: 'opencode',
    defaultModels: [
      { id: 'opencode-go-fast', name: 'OpenCode Go Fast' },
      { id: 'opencode-go-mini', name: 'OpenCode Go Mini' },
      { id: 'opencode-go-code', name: 'OpenCode Go Code' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    subtitle: 'Claude 3.7 Sonnet, Haiku & Opus series',
    group: 'Popular',
    iconType: 'anthropic',
    defaultModels: [
      { id: 'claude-37-sonnet', name: 'Claude 3.7 Sonnet' },
      { id: 'claude-35-haiku', name: 'Claude 3.5 Haiku' },
      { id: 'claude-fable-51', name: 'Claude Fable 5.1' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    subtitle: 'GPT-4o, o3-mini & reasoning models',
    group: 'Popular',
    iconType: 'openai',
    defaultModels: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'o3-mini', name: 'o3-mini' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
      { id: 'o1', name: 'o1' },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    subtitle: 'Gemini 3.8 Flash, Pro & Flash Lite',
    group: 'Popular',
    iconType: 'google',
    defaultModels: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    subtitle: 'Universal router for open and proprietary models',
    group: 'Popular',
    iconType: 'openrouter',
    defaultModels: [
      { id: 'deepseek-r1', name: 'DeepSeek R1' },
      { id: 'llama-33-70b', name: 'Llama 3.3 70B Instruct' },
      { id: 'mistral-large-2411', name: 'Mistral Large 2411' },
    ],
  },
  {
    id: 'vercel-ai',
    name: 'Vercel AI Gateway',
    subtitle: 'Enterprise model edge proxy and telemetry',
    group: 'Popular',
    iconType: 'vercel',
    defaultModels: [
      { id: 'vercel-edge-fast', name: 'Vercel Edge Fast' },
      { id: 'vercel-edge-reasoning', name: 'Vercel Edge Reasoning' },
    ],
  },

  // Other
  {
    id: 'custom',
    name: 'Custom OpenAI-compatible provider',
    subtitle: 'Connect self-hosted vLLM, Ollama, LiteLLM or proxies',
    badge: 'Custom',
    group: 'Other',
    iconType: 'custom',
    isCustom: true,
    defaultModels: [],
  },
  {
    id: '302-ai',
    name: '302.AI',
    subtitle: 'Pay-as-you-go model aggregator',
    group: 'Other',
    iconType: '302-ai',
    defaultModels: [
      { id: '302-claude', name: '302.AI Claude 3.5 Sonnet' },
      { id: '302-gpt4o', name: '302.AI GPT-4o' },
    ],
  },
  {
    id: 'abacus',
    name: 'Abacus',
    subtitle: 'Enterprise AI & deep learning pipelines',
    group: 'Other',
    iconType: 'abacus',
    defaultModels: [
      { id: 'smaug-72b', name: 'Smaug 72B' },
      { id: 'liberator-code', name: 'Liberator Code' },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    subtitle: 'LPU high-speed inference',
    group: 'Other',
    iconType: 'groq',
    defaultModels: [
      { id: 'llama-33-70b-versatile', name: 'Llama 3.3 70B (Groq)' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B (Groq)' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    subtitle: 'Run local open-weight models on your machine',
    group: 'Other',
    iconType: 'ollama',
    defaultModels: [
      { id: 'deepseek-r1-local', name: 'DeepSeek R1 (Local)' },
      { id: 'llama-33-local', name: 'Llama 3.3 70B (Local)' },
    ],
  },
];

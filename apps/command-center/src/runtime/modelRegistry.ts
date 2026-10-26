/**
 * Central Model Registry and Resolver for Mediobot V2
 *
 * Implements:
 * 1. Provider Catalog (what CAN be connected)
 * 2. Model Capabilities & Descriptors
 * 3. Enabled Model Projections
 * 4. Runtime Model Resolver (with capability checks and real provider dispatch)
 */

import {
  type ModelCapabilities,
  ModelProviderError,
  type OpenAICompatibleClientOptions,
  type AnthropicMessagesClientOptions,
  AnthropicMessagesStructuredClient,
  OpenAICompatibleStructuredClient,
  type StructuredModelClient,
  type StructuredModelRequest,
  type ModelProtocolCapabilities,
  type ModelAdmissionPort,
  ProviderRequestScheduler,
} from "@mediobot-v2/models";
import type { InferenceSnapshot } from "@mediobot-v2/contracts";
import type { ConfiguredModel, ProviderConnection, ProviderRepository } from "../storage/providerRepository.ts";

export type { ModelCapabilities };
export { ModelProviderError };

export interface CatalogProviderItem {
  readonly id: string;
  readonly name: string;
  readonly subtitle?: string;
  readonly badge?: string;
  readonly group: "Popular" | "Other";
  readonly iconType: string;
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
  readonly adapterType: "openai-compatible" | "anthropic-messages" | "not-yet-supported";
  readonly isCustom?: boolean;
}

export const PROVIDER_CATALOG: ReadonlyArray<CatalogProviderItem> = [
  // Popular
  {
    id: "dahl",
    name: "Dahl",
    subtitle: "MiniMax M2.7 reasoning model",
    group: "Popular",
    iconType: "dahl",
    defaultBaseUrl: "https://inference.dahl.global/v1",
    requiresApiKey: true,
    configurableBaseUrl: false,
    adapterType: "openai-compatible",
    defaultModels: [
      {
        id: "MiniMaxAI/MiniMax-M2.7",
        name: "MiniMax M2.7",
        capabilities: { text: true, reasoning: true, vision: false, tools: true, structuredOutput: true, maestroCompatible: true },
        context: "128K",
        tag: "Reasoning",
        description: "Advanced text reasoning with chain-of-thought normalization & structured output.",
      },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    subtitle: "High-performance inference, reasoning & vision models",
    group: "Popular",
    iconType: "nvidia",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    requiresApiKey: true,
    configurableBaseUrl: false,
    adapterType: "openai-compatible",
    defaultModels: [
      {
        id: "google/diffusiongemma-26b-a4b-it",
        name: "DiffusionGemma 26B",
        capabilities: { text: true, reasoning: true, vision: true, tools: false, structuredOutput: true, maestroCompatible: true },
        context: "Vision 4K",
        tag: "Multimodal Vision",
        description: "Accelerated visual perception, image understanding, layout detection & UI analysis.",
      },
      {
        id: "google/gemma-4-31b-it",
        name: "Gemma 4 31B",
        capabilities: { text: true, reasoning: true, vision: false, tools: true, structuredOutput: true, maestroCompatible: true },
        context: "8K",
        tag: "Text Reasoning",
        description: "Instruction-tuned open model for high-efficiency logic, code assistance & text reasoning.",
      },
      {
        id: "nvidia/nemotron-3-ultra-550b-a55b",
        name: "Nemotron 3 Ultra 550B",
        capabilities: { text: true, reasoning: true, vision: false, tools: true, structuredOutput: true, maestroCompatible: true },
        context: "16K",
        tag: "Ultra Reasoning",
        description: "Flagship 550B ultra-scale reasoning and planning model with chain-of-thought orchestration.",
      },
      {
        id: "meta/llama-3.2-11b-vision-instruct",
        name: "Llama 3.2 11B Vision",
        capabilities: { text: true, reasoning: true, vision: true, tools: true, structuredOutput: true, maestroCompatible: true },
        context: "8K",
        tag: "Vision + Text",
        description: "Multimodal vision-language model for joint image analysis and instruction reasoning.",
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    subtitle: "OpenAI API models",
    group: "Popular",
    iconType: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true, configurableBaseUrl: false, adapterType: "openai-compatible",
    defaultModels: [{ id: "gpt-5.5", name: "GPT-5.5",
      capabilities: { text: true, reasoning: true, vision: true, tools: true, structuredOutput: true, maestroCompatible: true },
      tag: "Agentic", description: "OpenAI Chat Completions model. Function proposals remain subject to MedioBot validation and authorization." }],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    subtitle: "Claude 3.7 Sonnet, Haiku & Opus series",
    group: "Popular",
    iconType: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    requiresApiKey: true, configurableBaseUrl: false, adapterType: "anthropic-messages", defaultModels: [],
  },
  {
    id: "google",
    name: "Google",
    subtitle: "Gemini API through its OpenAI-compatible endpoint",
    group: "Popular",
    iconType: "google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    requiresApiKey: true, configurableBaseUrl: false, adapterType: "openai-compatible",
    defaultModels: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash",
      capabilities: { text: true, reasoning: true, vision: true, tools: true, maestroCompatible: true },
      tag: "Stable", description: "Google's stable Gemini Flash model; tool actions are returned to MedioBot for validation and authorization." }],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    subtitle: "Universal router for open and proprietary models",
    group: "Popular",
    iconType: "openrouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    // OpenRouter's Chat Completions API is OpenAI-compatible. Individual routed
    // models remain unprofiled here, so ModelResolver keeps them on prompt-JSON
    // unless an exact provider/model protocol profile is added and verified.
    requiresApiKey: true, configurableBaseUrl: false, adapterType: "openai-compatible", defaultModels: [],
  },

  // Other
  {
    id: "custom",
    name: "Custom OpenAI-compatible provider",
    subtitle: "Connect self-hosted vLLM, Ollama, LiteLLM or proxies",
    badge: "Custom",
    group: "Other",
    iconType: "custom",
    isCustom: true,
    requiresApiKey: false,
    configurableBaseUrl: true,
    adapterType: "openai-compatible",
    defaultModels: [],
  },
];

export function getProviderCatalog(): ReadonlyArray<CatalogProviderItem> {
  return PROVIDER_CATALOG;
}

export interface EnabledModelOption {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly capabilities: ModelCapabilities;
  readonly modality?: "text" | "vision";
  readonly registered?: boolean;
  readonly badge?: string;
  readonly tag?: string;
  readonly context?: string;
  readonly description?: string;
}

const NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DAHL_BASE_URL = "https://inference.dahl.global/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const GOOGLE_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Exact hosted endpoint/model facts from provider API references. This deliberately does not derive protocol support from `capabilities.tools`. */
export function verifiedModelProtocol(providerType: string, baseUrl: string | undefined, modelId: string): ModelProtocolCapabilities | undefined {
  const normalizedBase = (baseUrl ?? "").replace(/\/+$/, "").toLowerCase();
  if (providerType === "dahl" && normalizedBase === DAHL_BASE_URL && modelId === "MiniMaxAI/MiniMax-M2.7") return {
    // Dahl documents OpenAI-style client function tools for MiniMax M2.7.
    // Hosted server tools are deliberately not exposed to MedioBot.
    verifiedModes: ["native-tool"],
    supportsSystemRole: true,
    source: "https://inference.dahl.global/docs/api/",
  };
  if (providerType === "anthropic" && normalizedBase === ANTHROPIC_BASE_URL
    && ["claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8",
      "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-4-5-20251001"].includes(modelId)) return {
    verifiedModes: ["native-tool", "json-schema"],
    supportsSystemRole: true,
    source: "https://platform.claude.com/docs/en/api/messages/create",
  };
  if (providerType === "google" && normalizedBase === GOOGLE_OPENAI_BASE_URL && modelId === "gemini-3.8-flash") return {
    // Google's documented OpenAI-compat endpoint supports function calling;
    // its documentation demonstrates automatic tool choice, not named forcing.
    verifiedModes: ["native-tool"],
    supportsSystemRole: true,
    nativeToolChoice: "auto",
    source: "https://ai.google.dev/gemini-api/docs/openai/",
  };
  if (providerType === "openai" && normalizedBase === OPENAI_BASE_URL && modelId === "gpt-5.5") return {
    verifiedModes: ["native-tool", "json-schema", "json-object"],
    supportsSystemRole: true,
    tokenLimitParameter: "max_completion_tokens",
    reasoningParameter: "reasoning_effort",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    source: "https://developers.openai.com/api/docs/models/gpt-5.5",
  };
  if (providerType !== "nvidia" || normalizedBase !== NVIDIA_NIM_BASE_URL) return undefined;
  if (modelId === "nvidia/nemotron-3-ultra-550b-a55b") return {
    verifiedModes: ["prompt-json"],
    supportsSystemRole: true,
    reasoningParameter: "reasoning_effort",
    reasoningEfforts: ["none", "medium", "high"],
    source: "https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b-infer",
  };
  if (modelId === "google/gemma-4-31b-it") return {
    verifiedModes: ["prompt-json"], supportsSystemRole: false,
    source: "https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it-infer",
  };
  if (modelId === "meta/llama-3.2-11b-vision-instruct") return {
    verifiedModes: ["prompt-json"], supportsSystemRole: false,
    source: "https://docs.api.nvidia.com/nim/reference/meta-llama-3_2-11b-vision-instruct-infer",
  };
  if (modelId === "google/diffusiongemma-26b-a4b-it") return {
    // The model card advertises function calling and structured JSON. Its hosted
    // inference reference does not document tools/response_format request fields,
    // so only the prompt contract is enabled on this endpoint.
    verifiedModes: ["prompt-json"], supportsSystemRole: false,
    source: "https://docs.api.nvidia.com/nim/reference/diffusiongemma-26b-a4b-it-infer",
  };
  return undefined;
}

export function getEnabledModels(providerRepo: ProviderRepository): EnabledModelOption[] {
  const connections = providerRepo.list();
  const list: EnabledModelOption[] = [];

  for (const conn of connections) {
    if (!conn.connected || !conn.enabled || conn.credentialStatus !== "configured") continue;
    for (const m of conn.models) {
      if (!m.enabled) continue;
      const catalogMatch = PROVIDER_CATALOG
        .find((p) => p.id === conn.providerType || p.id === conn.id)
        ?.defaultModels.find((dm) => dm.id === m.id);
      const defaultCaps: ModelCapabilities = catalogMatch?.capabilities ?? { text: true, reasoning: true, vision: false, tools: true };
      const caps: ModelCapabilities = {
        ...defaultCaps,
        ...(m.capabilities ?? {}),
        ...(catalogMatch?.capabilities?.maestroCompatible !== undefined ? { maestroCompatible: catalogMatch.capabilities.maestroCompatible } : {}),
        ...(catalogMatch?.capabilities?.reasoning !== undefined ? { reasoning: catalogMatch.capabilities.reasoning } : {}),
      };
      list.push({
        id: m.id,
        name: m.name,
        providerId: conn.id,
        providerName: conn.displayName,
        capabilities: caps,
        // This is a presentation label; capability checks continue to use the full metadata.
        modality: caps.vision ? "vision" : "text",
        registered: true,
        badge: conn.badge,
        tag: m.tag,
        context: m.context,
        description: m.description,
      });
    }
  }

  return list;
}

export interface ThreadModelSelection {
  readonly providerConnectionId: string;
  readonly modelId: string;
  readonly reasoningEffort?: "low" | "medium" | "high" | "extra" | "max";
  readonly taskId?: string;
  readonly workspaceId?: string | null;
}

export type ModelOperation = "text-inference" | "dom-reasoning" | "image-perception" | "tool-calling";

export interface ModelResolverOptions {
  readonly createClient?: (options: OpenAICompatibleClientOptions) => StructuredModelClient;
  readonly createAnthropicClient?: (options: AnthropicMessagesClientOptions) => StructuredModelClient;
  /** Accepted for isolated callers; product resolution intentionally never reads this value. */
  readonly env?: Record<string, string | undefined>;
  readonly scheduler?: ProviderRequestScheduler;
  readonly concurrencyLimits?: Readonly<Record<string, number>>;
  readonly defaultConcurrency?: number;
  readonly admissionPort?: ModelAdmissionPort;
}

export class ModelResolver {
  private readonly providerRepo: ProviderRepository;
  private readonly options?: ModelResolverOptions;
  private readonly scheduler: ProviderRequestScheduler;

  constructor(providerRepo: ProviderRepository, options?: ModelResolverOptions) {
    this.providerRepo = providerRepo;
    this.options = options;
    const concurrencyLimits: Record<string, number> = { ...(options?.concurrencyLimits ?? {}) };
    try {
      for (const conn of providerRepo.list()) {
        if (typeof (conn as any).concurrencyLimit === "number") {
          concurrencyLimits[conn.id] = (conn as any).concurrencyLimit;
        }
      }
    } catch {}
    this.scheduler = options?.scheduler ?? new ProviderRequestScheduler({
      defaultConcurrency: options?.defaultConcurrency,
      concurrencyLimits,
      admissionPort: options?.admissionPort,
      onDiagnostic: (event) => {
        try {
          process.stderr.write(`${JSON.stringify({ domain: "model.scheduler", ...event })}\n`);
        } catch {}
      },
    });
  }

  connectAdmissionPort(admissionPort: ModelAdmissionPort): void {
    this.scheduler.setAdmissionPort(admissionPort);
  }

  getScheduler(): ProviderRequestScheduler {
    return this.scheduler;
  }

  createInferenceSnapshot(selection?: ThreadModelSelection): InferenceSnapshot {
    let targetConn: ProviderConnection | null = null;
    let targetModel: ConfiguredModel | undefined;

    if (selection) {
      const connId = selection.providerConnectionId || (selection as any).providerId;
      targetConn = connId ? this.providerRepo.get(connId) : null;
      targetModel = targetConn?.models.find((m) => m.id === selection.modelId);
    }
    if (!targetConn || !targetModel) {
      const enabled = getEnabledModels(this.providerRepo);
      const textCandidate = enabled.find((m) => m.capabilities.text || m.capabilities.reasoning);
      if (textCandidate) {
        targetConn = this.providerRepo.get(textCandidate.providerId);
        targetModel = targetConn?.models.find((m) => m.id === textCandidate.id);
      }
    }

    const connId = targetConn?.id ?? selection?.providerConnectionId ?? "unknown";
    const modelId = targetModel?.id ?? selection?.modelId ?? "unknown";
    const providerKey = targetConn?.providerType ?? targetConn?.id ?? "custom";
    const baseUrl = targetConn?.baseUrl;
    const protocol = targetConn ? verifiedModelProtocol(targetConn.providerType, baseUrl, modelId) : undefined;
    const requestedEffort = selection?.reasoningEffort?.toLowerCase();
    const isSupported = Boolean(
      requestedEffort &&
      protocol?.reasoningParameter === "reasoning_effort" &&
      protocol.reasoningEfforts?.includes(requestedEffort)
    );

    return {
      connectionId: connId,
      providerKey,
      modelId,
      ...(requestedEffort ? { requestedEffort } : {}),
      ...(isSupported ? { effectiveEffort: requestedEffort } : {}),
      protocolCapabilities: protocol?.verifiedModes ? [...protocol.verifiedModes] : [],
      resolvedAt: Date.now(),
    };
  }

  hasEnabledTextModel(): boolean {
    return getEnabledModels(this.providerRepo).some((model) => model.capabilities.text || model.capabilities.reasoning);
  }

  /**
   * Resolve runtime model client for turn execution with strict capability validation.
   */
  resolve(selection?: ThreadModelSelection) {
    return this.resolveTextClient(selection);
  }

  /** Operation routing always uses the selected pair; never substitutes another model. */
  resolveForOperation(operation: ModelOperation, selection?: ThreadModelSelection) {
    if (!selection?.providerConnectionId || !selection.modelId) {
      throw new ModelProviderError("configuration", "Select a connected model before starting this operation.");
    }
    return this.resolveClient(selection, operation);
  }

  resolveTextClient(selection?: ThreadModelSelection) {
    return this.resolveClient(selection);
  }

  private resolveClient(selection?: ThreadModelSelection, operation?: ModelOperation): {
    readonly client: StructuredModelClient;
    readonly descriptor: {
      readonly providerId: string;
      readonly providerName: string;
      readonly modelId: string;
      readonly modelName: string;
      readonly capabilities: ModelCapabilities;
    };
  } {
    let targetConn: ProviderConnection | null = null;
    let targetModel: ConfiguredModel | undefined;

    if (selection) {
      const connId = selection.providerConnectionId || (selection as any).providerId;
      targetConn = connId ? this.providerRepo.get(connId) : null;
      if (!targetConn || !targetConn.connected) {
        throw new ModelProviderError(
          "configuration",
          `Provider '${connId ?? "unknown"}' is not connected.`
        );
      }
      if (!targetConn.enabled) {
        throw new ModelProviderError(
          "configuration",
          `Provider '${connId}' is disabled.`
        );
      }
      targetModel = targetConn.models.find((m) => m.id === selection.modelId);
      if (!targetModel) {
        throw new ModelProviderError(
          "configuration",
          `Model '${selection.modelId}' was not found in provider '${targetConn.displayName}'.`
        );
      }
      if (!targetModel.enabled) {
        throw new ModelProviderError(
          "configuration",
          `Model '${selection.modelId}' is currently disabled in Manage Models.`
        );
      }
    } else {
      // Find first available enabled model with text capability
      const enabled = getEnabledModels(this.providerRepo);
      const textCandidate = enabled.find((m) => m.capabilities.text || m.capabilities.reasoning);
      if (!textCandidate) {
        throw new ModelProviderError(
          "configuration",
          "No text reasoning model is configured or enabled in Manage Models."
        );
      }
      targetConn = this.providerRepo.get(textCandidate.providerId);
      targetModel = targetConn?.models.find((m) => m.id === textCandidate.id);
    }

    if (!targetConn || !targetModel) {
      throw new ModelProviderError(
        "configuration",
        "Could not resolve an available model configuration."
      );
    }

    const catalogMatch = PROVIDER_CATALOG
      .find((p) => p.id === targetConn.providerType || p.id === targetConn.id)
      ?.defaultModels.find((dm) => dm.id === targetModel.id);
    const defaultCaps: ModelCapabilities = catalogMatch?.capabilities ?? {
      text: true,
      reasoning: true,
      vision: false,
      tools: true,
    };

    const capabilities: ModelCapabilities = {
      ...defaultCaps,
      ...(catalogMatch?.capabilities ?? {}),
      ...(targetModel.capabilities ?? {}),
    };

    if (operation && (!capabilities.text || (operation === "image-perception" && !capabilities.vision))) {
      throw new ModelProviderError("unsupported-modality",
        `Selected model ${targetModel.id} does not support ${operation === "image-perception" ? "text and vision" : "text reasoning"}.`);
    }

    if (operation === "tool-calling" && !capabilities.tools) {
      throw new ModelProviderError("unsupported-modality",
        `Selected model ${targetModel.id} does not support tool calling.`);
    }

    if (operation === "dom-reasoning" && capabilities.maestroCompatible === false) {
      throw new ModelProviderError(
        "unsupported-modality",
        `Selected model ${targetModel.id} is not compatible with Maestro structured orchestration. Choose a compatible reasoning model.`
      );
    }

    // Strict capability compatibility check:
    // If model lacks text AND reasoning capability, reject truthfully without silent fallback
    if (!capabilities.text && !capabilities.reasoning) {
      throw new ModelProviderError(
        "unsupported-modality",
        `Selected model ${targetModel.id} does not support text reasoning.`
      );
    }

    const apiKey = this.providerRepo.getSecret(targetConn.id);

    if (!apiKey && targetConn.providerType !== "custom") {
      throw new ModelProviderError(
        "authentication",
        `API key is not configured for provider '${targetConn.displayName}'.`
      );
    }

    const baseUrl = targetConn.baseUrl ?? PROVIDER_CATALOG.find((provider) => provider.id === targetConn!.providerType)?.defaultBaseUrl;

    const headersRecord: Record<string, string> = {};
    if (targetConn.customHeaders) {
      for (const h of targetConn.customHeaders) {
        if (h.name && h.value) {
          headersRecord[h.name] = h.value;
        }
      }
    }

    const protocolCapabilities = verifiedModelProtocol(targetConn.providerType, baseUrl, targetModel.id);
    if (targetConn.providerType === "google" && baseUrl?.replace(/\/+$/, "").toLowerCase() !== GOOGLE_OPENAI_BASE_URL) {
      throw new ModelProviderError("configuration", "Google connections require the official Gemini OpenAI-compatible API endpoint.");
    }
    const clientOptions: OpenAICompatibleClientOptions = {
      apiKey: apiKey ?? "",
      modelId: targetModel.id,
      baseUrl,
      headers: Object.keys(headersRecord).length > 0 ? headersRecord : undefined,
      // NVIDIA's documented chat-completions contract does not require JSON mode;
      // Mediobot's decision prompt is normalized/parsed locally at this boundary.
      // JSON-object mode is a provider/model protocol capability, not a
      // provider-family default. Unprofiled OpenAI-compatible endpoints use
      // the existing prompt-JSON compatibility path instead.
      jsonMode: Boolean(protocolCapabilities?.verifiedModes.includes("json-object")),
      // NVIDIA's documented role enum is user/assistant, not system.
      supportsSystemRole: protocolCapabilities?.supportsSystemRole ?? (!["nvidia", "google"].includes(targetConn.providerType)
        && !["nvidia", "google"].includes(targetConn.id)),
      protocolCapabilities,
      legacyOutputMode: "prompt-json",
      onBackoff: async (delayMs, signal) => {
        // Release the current admission lease before sleeping, acquire a fresh
        // one after. This prevents the lease from being held during the backoff
        // delay, which would starve other queued requests (G05 deadlock fix).
        const currentLease = leaseRef.current;
        leaseRef.current = undefined;
        const newLease = await this.scheduler.sleepWithBackoff(targetConn.id, delayMs, signal, currentLease);
        leaseRef.current = newLease;
      },
    };

    const isAnthropicMessages = targetConn.providerType === "anthropic" && baseUrl?.replace(/\/+$/, "").toLowerCase() === ANTHROPIC_BASE_URL;
    if (targetConn.providerType === "anthropic" && !isAnthropicMessages) {
      throw new ModelProviderError("configuration", "Anthropic is only supported through its configured Claude Messages API endpoint.");
    }
    const anthropicOptions: AnthropicMessagesClientOptions = {
      apiKey: apiKey ?? "", modelId: targetModel.id, baseUrl, protocolCapabilities,
    };
    const rawClient: StructuredModelClient = isAnthropicMessages
      ? (this.options?.createAnthropicClient ? this.options.createAnthropicClient(anthropicOptions) : new AnthropicMessagesStructuredClient(anthropicOptions))
      : (this.options?.createClient ? this.options.createClient(clientOptions) : new OpenAICompatibleStructuredClient(clientOptions));

    const scheduler = this.scheduler;
    const providerKey = targetConn.id;
    const providerType = targetConn.providerType;
    const modelId = targetModel.id;

    // Per-client lease reference box: runWithRelease writes the active
    // ModelAdmissionPort lease here so the onBackoff callback can release it
    // before sleeping and update it with the re-acquired lease after. This
    // prevents the admission lease from being held during the backoff window
    // (G05 deadlock fix). A single box is safe because only one request can
    // hold a lease slot at a time per concurrency permit.
    const leaseRef: { current?: (() => void) | undefined } = {};

    const scheduledClient: StructuredModelClient = {
      complete(request: StructuredModelRequest): Promise<string> {
        return scheduler.schedule({
          providerKey,
          providerType,
          modelId,
          taskId: (request as any).taskId ?? selection?.taskId,
          workspaceId: (request as any).workspaceId ?? selection?.workspaceId,
          signal: request.signal,
          execute: () => rawClient.complete(request),
          leaseRef,
        });
      },
      completeCompatible(request: StructuredModelRequest & { readonly outputContract: import("@mediobot-v2/models").ModelOutputContract }) {
        return scheduler.schedule({
          providerKey,
          providerType,
          modelId,
          taskId: (request as any).taskId ?? selection?.taskId,
          workspaceId: (request as any).workspaceId ?? selection?.workspaceId,
          signal: request.signal,
          execute: () => rawClient.completeCompatible
            ? rawClient.completeCompatible(request)
            : rawClient.complete(request).then(text => ({ kind: "text" as const, text, protocol: "legacy" as const })),
          leaseRef,
        });
      },
      usage() {
        return rawClient.usage?.();
      },
      metrics() {
        return rawClient.metrics?.();
      },
    };

    return {
      client: scheduledClient,
      descriptor: {
        providerId: targetConn.id,
        providerName: targetConn.displayName,
        modelId: targetModel.id,
        modelName: targetModel.name,
        capabilities,
      },
    };
  }

  checkCapability(
    selection: ThreadModelSelection,
    requiredModality: "text" | "reasoning" | "vision" | "tools" | "maestro"
  ): { ok: true } | { ok: false; error: string } {
    const conn = this.providerRepo.get(selection.providerConnectionId);
    if (!conn) {
      return { ok: false, error: `Provider '${selection.providerConnectionId}' is not connected.` };
    }
    const model = conn.models.find((m) => m.id === selection.modelId);
    if (!model) {
      return { ok: false, error: `Model '${selection.modelId}' was not found in provider '${conn.displayName}'.` };
    }
    const catalogMatch = PROVIDER_CATALOG
      .find((p) => p.id === conn.providerType || p.id === conn.id)
      ?.defaultModels.find((dm) => dm.id === model.id);
    const caps: ModelCapabilities = {
      ...(catalogMatch?.capabilities ?? { text: true, reasoning: true, vision: false, tools: true }),
      ...(model.capabilities ?? {}),
    };
    if (requiredModality === "text" && !caps.text && !caps.reasoning) {
      return { ok: false, error: `Model '${model.name}' does not support text reasoning (it is vision-only).` };
    }
    if (requiredModality === "tools" && !caps.tools) {
      return { ok: false, error: `Model '${model.name}' does not support tool calling.` };
    }
    if (requiredModality === "vision" && !caps.vision) {
      return { ok: false, error: `Model '${model.name}' does not support vision capabilities.` };
    }
    if (requiredModality === "maestro" && (caps.maestroCompatible === false || !caps.reasoning)) {
      return { ok: false, error: `Model '${model.name}' is not compatible with Maestro structured orchestration.` };
    }
    return { ok: true };
  }
}

export function getModelRegistry() {
  return PROVIDER_CATALOG;
}

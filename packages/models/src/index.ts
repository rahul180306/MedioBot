export type TextModelId = "MiniMaxAI/MiniMax-M2.7" | "deepseek-ai/DeepSeek-V4-Flash-0731";
export type VisionModelId = "google/diffusiongemma-26b-a4b-it" | "meta/llama-3.2-90b-vision-instruct";

export interface DevelopmentModelConfig {
  readonly text: { readonly modelId: TextModelId; readonly apiKey: string; readonly baseUrl: string; readonly timeoutMs: number };
  readonly vision: { readonly modelId: VisionModelId; readonly apiKey: string; readonly baseUrl: string; readonly timeoutMs: number };
}

const DEFAULT_DAHL_URL = "https://inference.dahl.global/v1";
const DEFAULT_NVIDIA_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
const MAX_MODEL_RESPONSE_BYTES = 8 * 1024 * 1024;
const TEXT_MODELS = new Set<TextModelId>(["MiniMaxAI/MiniMax-M2.7", "deepseek-ai/DeepSeek-V4-Flash-0731"]);
const VISION_MODELS = new Set<VisionModelId>(["google/diffusiongemma-26b-a4b-it", "meta/llama-3.2-90b-vision-instruct"]);

function selected<T extends string>(value: string | undefined, fallback: T, choices: ReadonlySet<T>, label: string): T {
  const candidate = value?.trim() || fallback;
  if (!choices.has(candidate as T)) throw new Error(`Unsupported ${label} model selection`);
  return candidate as T;
}

function timeout(value: string | undefined): number {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1_000 || result > 600_000) throw new Error("Model timeout must be an integer from 1000 to 600000 ms");
  return result;
}

function configuredTimeout(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1_000 || result > 600_000) {
    throw new Error(`${label} must be an integer from 1000 to 600000 ms`);
  }
  return result;
}

/** Resolve local development providers once at the composition boundary; no global client is created. */
export function resolveDevelopmentModelConfig(env: Record<string, string | undefined> = process.env): DevelopmentModelConfig {
  return {
    text: {
      modelId: selected(env.MEDIOBOT_DEV_TEXT_MODEL ?? env.MINIMAX_MODEL_ID, "MiniMaxAI/MiniMax-M2.7", TEXT_MODELS, "text"),
      apiKey: (env.DAHL_API_KEY ?? "").trim(),
      baseUrl: env.DAHL_BASE_URL?.trim() || DEFAULT_DAHL_URL,
      timeoutMs: timeout(env.MEDIOBOT_PRIMARY_TIMEOUT_MS),
    },
    vision: {
      modelId: selected(env.MEDIOBOT_DEV_VISION_MODEL ?? env.DIFFUSIONGEMMA_MODEL_ID,
        "google/diffusiongemma-26b-a4b-it", VISION_MODELS, "vision"),
      apiKey: (env.NVIDIA_API_KEY ?? "").trim(),
      baseUrl: env.NVIDIA_BASE_URL?.trim() || DEFAULT_NVIDIA_URL,
      timeoutMs: timeout(env.MEDIOBOT_VISION_TIMEOUT_MS),
    },
  };
}

export type ModelParseOutcome =
  | "blank"
  | "reasoning-only"
  | "content-filtered"
  | "length-truncated"
  | "unrequested-tool-call"
  | "malformed"
  | "interrupted";


const ALLOWED_FINISH_REASONS = new Set([
  "stop",
  "length",
  "content_filter",
  "tool_calls",
  "function_call",
  "timeout",
  "error",
  "cancelled",
]);

export function sanitizeFinishReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason !== "string") return "other";
  const normalized = reason.trim().toLowerCase();
  if (ALLOWED_FINISH_REASONS.has(normalized)) return normalized;
  return "other";
}

export function sanitizeIdentifier(id: unknown, maxLength = 80): string {
  if (id === undefined || id === null) return "";
  if (typeof id !== "string") return "";
  const trimmed = id.trim().slice(0, maxLength);
  return trimmed.replace(/[^\w.-]/g, "_");
}

export interface ModelEmptyResponseDiagnostic {
  readonly modelId: string;
  readonly protocol?: string;
  readonly outputMode: ModelOutputProtocol;
  readonly httpStatus: number;
  readonly finishReason?: string | null;
  readonly contentCharacterCount: number;
  readonly reasoningCharacterCount: number;
  readonly toolCallCount: number;
  readonly parseOutcome: ModelParseOutcome;
  readonly durationMs: number;
  readonly ttfbMs?: number;
  readonly ttftMs?: number;
}

export type ModelProviderErrorCode = "configuration" | "authentication" | "capacity" | "timeout" | "cancelled"
  | "transport" | "invalid-response" | "structured-parse" | "unsupported-modality";

export class ModelProviderError extends Error {
  readonly code: ModelProviderErrorCode;
  readonly diagnostic?: unknown;
  constructor(code: ModelProviderErrorCode, message: string, diagnostic?: unknown) {
    super(message);
    this.name = "ModelProviderError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

export {
  ProviderRequestScheduler,
  type ProviderSchedulerOptions,
  type ProviderScheduleRequest,
} from "./scheduler.ts";

export {
  type ModelAdmissionScope,
  type ModelAdmissionResult,
  type ModelAdmissionPort,
} from "./admission.ts";

export function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "UND_ERR_CONNECT_TIMEOUT";
  }
  return false;
}

export function parseRetryAfter(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;

  // Case 1: Numeric seconds (e.g. "5", "0.5", "120")
  const seconds = Number(trimmed);
  if (!isNaN(seconds) && isFinite(seconds)) {
    if (seconds < 0) return undefined;
    return Math.max(50, Math.round(seconds * 1000));
  }

  // Case 2: HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
  const parsedDate = Date.parse(trimmed);
  if (!isNaN(parsedDate)) {
    const diffMs = parsedDate - Date.now();
    return Math.max(50, Math.max(0, diffMs));
  }

  return undefined;
}

export function computeBackoffDelay(
  attempt: number,
  retryAfterMs?: number,
  baseDelayMs = 500,
  maxDelayMs = 10_000
): number {
  if (typeof retryAfterMs === "number" && !isNaN(retryAfterMs) && isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.max(50, Math.round(retryAfterMs));
  }
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * (baseDelayMs * 0.5));
  return Math.min(maxDelayMs, exponential + jitter);
}

export async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new ModelProviderError("cancelled", "Model request cancelled");
  }
  if (ms <= 0) return;

  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new ModelProviderError("cancelled", "Model request cancelled"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function providerHttpError(status: number): ModelProviderError {
  if (status === 401 || status === 403) return new ModelProviderError("authentication", `Model provider authentication failed (HTTP ${status})`);
  if (status === 429) return new ModelProviderError("capacity", "Model provider capacity or rate limit reached (HTTP 429)");
  if (status >= 500) return new ModelProviderError("transport", `Model provider request failed (HTTP ${status})`);
  return new ModelProviderError("invalid-response", `Model provider rejected the request (HTTP ${status})`);
}

function classifyStreamingProviderError(error: { readonly code?: number | string; readonly status?: number; readonly type?: string; readonly message?: string }): ModelProviderErrorCode {
  const code = error.code;
  const description = `${typeof code === "string" ? code : ""} ${error.type ?? ""} ${error.message ?? ""}`.toLowerCase();
  const status = error.status ?? (typeof code === "number" ? code : undefined);
  if (status === 401 || status === 403 || /authentication_error|invalid_api_key/.test(description)) return "authentication";
  if (status === 429 || status === 503 || /rate[_ -]?limit|overload|capacity/.test(description)) return "capacity";
  if (typeof status === "number" && status >= 500 || /internal[_ -]?server[_ -]?error|server error|service unavailable|bad gateway/.test(description)) return "transport";
  return "invalid-response";
}

export interface StructuredModelRequest {
  readonly system: string;
  readonly input: string;
  readonly signal: AbortSignal;
  readonly images?: ReadonlyArray<{ readonly mimeType: string; readonly dataUrl: string }>;
  readonly onProgress?: (chunk: string) => void;
  readonly rawText?: boolean;
  /** Requested reasoning level. Provider adapters may transmit this only when the selected model documents it. */
  readonly reasoningEffort?: string;
  readonly outputContract?: ModelOutputContract;
}

export type ModelOutputMode = "native-tool" | "json-schema" | "json-object" | "prompt-json";
export type ModelOutputProtocol = ModelOutputMode | "legacy";

export interface ModelJsonSchema {
  readonly type?: string;
  readonly [key: string]: unknown;
}

export interface ModelFunctionTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ModelJsonSchema;
}

/** A model may propose one decision function. The adapter returns its arguments as data; it never runs it. */
export interface ModelOutputContract {
  readonly name: string;
  readonly description: string;
  readonly schema: ModelJsonSchema;
  readonly tools?: ReadonlyArray<ModelFunctionTool>;
  readonly preferredModes?: ReadonlyArray<ModelOutputMode>;
  readonly strict?: boolean;
}

export interface ModelProtocolCapabilities {
  /** Only exact endpoint/model capabilities backed by documented support belong here. */
  readonly verifiedModes: ReadonlyArray<ModelOutputMode>;
  readonly supportsSystemRole?: boolean;
  readonly reasoningEfforts?: ReadonlyArray<string>;
  readonly reasoningParameter?: "reasoning_effort";
  /** Some OpenAI-compatible endpoints document automatic selection but not a forced named tool choice. */
  readonly nativeToolChoice?: "named" | "auto";
  readonly tokenLimitParameter?: "max_tokens" | "max_completion_tokens";
  readonly source?: string;
}

export type ModelCompatibilityResponse = (
  | { readonly kind: "text"; readonly text: string; readonly protocol: ModelOutputProtocol }
  | { readonly kind: "structured"; readonly value: unknown; readonly protocol: Exclude<ModelOutputProtocol, "native-tool" | "legacy"> }
  | { readonly kind: "tool-call"; readonly name: string; readonly arguments: unknown; readonly protocol: "native-tool" }
  ) & { readonly metrics?: ModelExecutionMetrics; readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number } };

export interface ModelExecutionMetrics {
  readonly durationMs: number;
  /** Time from dispatch until response headers arrive. */
  readonly ttfbMs?: number;
  /** Time from dispatch until the first generated content delta. */
  readonly ttftMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly requestedReasoningEffort?: string;
  readonly effectiveReasoningEffort?: string;
  readonly unsupportedReasoningEffort?: string;
}

/** Provider-neutral structured text seam. Credentials and provider details stay behind this boundary. */
export interface StructuredModelClient {
  complete(request: StructuredModelRequest): Promise<string>;
  completeCompatible?(request: StructuredModelRequest & { readonly outputContract: ModelOutputContract }): Promise<ModelCompatibilityResponse>;
  usage?(): { readonly inputTokens?: number; readonly outputTokens?: number } | undefined;
  metrics?(): ModelExecutionMetrics | undefined;
}

export async function completeWithModelContract(client: StructuredModelClient,
  request: StructuredModelRequest & { readonly outputContract: ModelOutputContract }): Promise<ModelCompatibilityResponse> {
  if (client.completeCompatible) return client.completeCompatible(request);
  return { kind: "text", text: await client.complete(request), protocol: "legacy" };
}

/** Serialize model output for the existing internal validators; this does not authorize or execute actions. */
export function modelCompatibilityResponseText(response: ModelCompatibilityResponse): string {
  if (response.kind === "text") return response.text;
  return JSON.stringify(response.kind === "tool-call" ? response.arguments : response.value);
}

export interface ModelContextMetrics {
  readonly systemCharacters: number;
  readonly inputCharacters: number;
  readonly providerInputTokens?: number;
  readonly providerOutputTokens?: number;
}

export interface ModelCapabilities {
  readonly text: boolean;
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly tools: boolean;
  readonly structuredOutput?: boolean;
  readonly maestroCompatible?: boolean;
}

export interface OpenAICompatibleClientOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Maximum quiet period while reading a response body. Overall request timeout still applies. */
  readonly idleTimeoutMs?: number;
  readonly maxTokens?: number;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof fetch;
  readonly jsonMode?: boolean;
  /** Explicit provider capability; takes precedence over the legacy jsonMode flag. */
  readonly structuredOutput?: "json-object" | "prompt-only";
  readonly supportsSystemRole?: boolean;
  readonly stream?: boolean;
  readonly rawText?: boolean;
  readonly maxRetries?: number;
  readonly protocolCapabilities?: ModelProtocolCapabilities;
  readonly legacyOutputMode?: "json-object" | "prompt-json";
  /** Optional backoff coordinator to release scheduler/governor capacity and observe cooldowns during retry waits. */
  readonly onBackoff?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface AnthropicMessagesClientOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxTokens?: number;
  readonly fetch?: typeof fetch;
  readonly protocolCapabilities?: ModelProtocolCapabilities;
}

/** Claude Messages codec. It only returns proposals; MedioBot validates and authorizes them elsewhere. */
export class AnthropicMessagesStructuredClient implements StructuredModelClient {
  private readonly key: string;
  private readonly endpoint: string;
  private readonly modelId: string;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxTokens: number;
  private readonly fetcher: typeof fetch;
  private readonly protocols?: ModelProtocolCapabilities;
  private lastUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  private lastMetrics?: ModelExecutionMetrics;

  constructor(options: AnthropicMessagesClientOptions) {
    if (!options.modelId.trim()) throw new Error("Model ID is required");
    this.key = options.apiKey;
    this.modelId = options.modelId;
    const base = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.endpoint = `${base}/messages`;
    this.timeoutMs = options.timeoutMs ?? configuredTimeout(process.env.MEDIOBOT_MODEL_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "Model request timeout");
    this.idleTimeoutMs = options.idleTimeoutMs ?? configuredTimeout(process.env.MEDIOBOT_MODEL_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, "Model idle timeout");
    this.maxTokens = options.maxTokens ?? 4096;
    this.fetcher = options.fetch ?? fetch;
    this.protocols = options.protocolCapabilities;
  }

  async complete(request: StructuredModelRequest): Promise<string> {
    const result = await this.execute(request);
    return result.text;
  }

  async completeCompatible(request: StructuredModelRequest & { readonly outputContract: ModelOutputContract }): Promise<ModelCompatibilityResponse> {
    return (await this.execute(request)).response;
  }

  usage() { return this.lastUsage; }
  metrics() { return this.lastMetrics; }

  private async execute(request: StructuredModelRequest & { readonly outputContract?: ModelOutputContract }): Promise<{
    readonly text: string; readonly response: ModelCompatibilityResponse;
  }> {
    if (request.signal.aborted) throw new ModelProviderError("cancelled", "Model request cancelled");
    this.lastUsage = undefined;
    this.lastMetrics = undefined;
    const started = performance.now();
    const mode = request.outputContract
      ? selectModelOutputMode(request.outputContract, this.protocols, "prompt-json")
      : "legacy";
    if (mode === "json-schema" && request.outputContract && !isAnthropicStrictSchemaCompatible(request.outputContract.schema)) {
      throw new ModelProviderError("unsupported-modality", "The selected Claude Messages route cannot enforce this schema; choose a compatible protocol explicitly.");
    }
    const controller = new AbortController();
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abortFromParent = () => { controller.abort(); rejectAbort(new ModelProviderError("cancelled", "Model request cancelled")); };
    const timer = setTimeout(() => { controller.abort(); rejectAbort(new ModelProviderError("timeout", "Model request timed out")); }, this.timeoutMs);
    request.signal.addEventListener("abort", abortFromParent, { once: true });
    try {
      const tools = mode === "native-tool" && request.outputContract
        ? (request.outputContract.tools?.length ? request.outputContract.tools : [{
          name: request.outputContract.name, description: request.outputContract.description, parameters: request.outputContract.schema,
        }]).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
        : undefined;
      const body = {
        model: this.modelId,
        max_tokens: this.maxTokens,
        system: `${request.system}${mode === "prompt-json" && request.outputContract ? `\n\nReturn only one JSON object matching this contract: ${JSON.stringify(request.outputContract.schema)}` : ""}`,
        messages: [{ role: "user", content: [
          ...(request.images ?? []).map(image => ({ type: "image" as const, source: { type: "base64", media_type: image.mimeType, data: image.dataUrl.replace(/^data:[^,]+,/, "") } })),
          { type: "text", text: request.input },
        ] }],
        ...(tools ? { tools, tool_choice: { type: "tool", name: tools[0]!.name, disable_parallel_tool_use: true } } : {}),
        ...(mode === "json-schema" && request.outputContract ? {
          output_config: { format: { type: "json_schema", schema: request.outputContract.schema } },
        } : {}),
        ...(request.rawText ? {} : {}),
        stream: true,
      };
      const response = await Promise.race([this.fetcher(this.endpoint, {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "text/event-stream, application/json",
          "x-api-key": this.key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      }), aborted]);
      const ttfbMs = Math.round(performance.now() - started);
      if (!response.ok) throw providerHttpError(response.status);
      const contentType = response.headers.get("content-type") ?? "";
      let text = "";
      let toolName = "";
      let toolInput = "";
      let toolCallCount = 0;
      let firstContentAt: number | undefined;
      if (contentType.includes("text/event-stream") && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventType = "";
        let bytes = 0;
        let messageStopped = false;
        try {
          while (true) {
            let idleTimer: NodeJS.Timeout | undefined;
            let read: ReadableStreamReadResult<Uint8Array>;
            try {
              read = await Promise.race([reader.read(), aborted, new Promise<never>((_resolve, reject) => {
                idleTimer = setTimeout(() => reject(new ModelProviderError("timeout", "Model response became idle", {
                  phase: "body", idleTimeoutMs: this.idleTimeoutMs,
                })), this.idleTimeoutMs);
              })]);
            } catch (error) {
              if (error instanceof ModelProviderError && error.code === "timeout") controller.abort();
              throw error;
            } finally { if (idleTimer) clearTimeout(idleTimer); }
            if (read.done) break;
            bytes += read.value.byteLength;
            if (bytes > MAX_MODEL_RESPONSE_BYTES) throw new ModelProviderError("invalid-response", "Model response exceeded the 8 MiB limit");
            buffer += decoder.decode(read.value, { stream: true });
            const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("event:")) { eventType = line.slice(6).trim(); continue; }
              if (!line.startsWith("data:")) continue;
              let data: Record<string, any>;
              try { data = JSON.parse(line.slice(5).trim()) as Record<string, any>; }
              catch { throw new ModelProviderError("invalid-response", "Provider returned malformed streaming data"); }
              if (eventType === "error" || data.type === "error") throw new ModelProviderError("transport", "Provider reported a streaming error");
              if (eventType === "content_block_start" && data.content_block?.type === "tool_use") {
                toolCallCount++;
                if (toolCallCount > 1) throw new ModelProviderError("invalid-response", "Provider returned multiple tool proposals for a single-decision contract");
                toolName = String(data.content_block.name ?? "");
                if (data.content_block.input && Object.keys(data.content_block.input).length) toolInput = JSON.stringify(data.content_block.input);
              }
              if (eventType === "content_block_delta") {
                const delta = data.delta;
                if (delta?.type === "text_delta" && typeof delta.text === "string") {
                  firstContentAt ??= performance.now(); text += delta.text; request.onProgress?.(delta.text);
                } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                  firstContentAt ??= performance.now(); toolInput += delta.partial_json;
                }
              }
              if (eventType === "message_start" && data.message?.usage) this.lastUsage = {
                ...(typeof data.message.usage.input_tokens === "number" ? { inputTokens: data.message.usage.input_tokens } : {}),
              };
              if (eventType === "message_delta") {
                if (data.usage) this.lastUsage = { ...this.lastUsage,
                  ...(typeof data.usage.output_tokens === "number" ? { outputTokens: data.usage.output_tokens } : {}) };
                if (data.delta?.stop_reason === "max_tokens") throw new ModelProviderError("structured-parse", "Provider response was truncated at the output token limit");
              }
              if (eventType === "message_stop") messageStopped = true;
              eventType = "";
            }
          }
          if (!messageStopped) throw new ModelProviderError("invalid-response", "Provider stream ended before message_stop");
        } finally { reader.releaseLock(); }
      } else {
        const result = await Promise.race([response.json(), aborted]) as Record<string, any>;
        if (result.stop_reason === "max_tokens") throw new ModelProviderError("structured-parse", "Provider response was truncated at the output token limit");
        for (const block of Array.isArray(result.content) ? result.content : []) {
          if (block?.type === "text" && typeof block.text === "string") text += block.text;
          if (block?.type === "tool_use") {
            toolCallCount++;
            if (toolCallCount > 1) throw new ModelProviderError("invalid-response", "Provider returned multiple tool proposals for a single-decision contract");
            toolName = String(block.name ?? ""); toolInput = JSON.stringify(block.input ?? {});
          }
        }
        this.lastUsage = { ...(typeof result.usage?.input_tokens === "number" ? { inputTokens: result.usage.input_tokens } : {}),
          ...(typeof result.usage?.output_tokens === "number" ? { outputTokens: result.usage.output_tokens } : {}) };
      }
      const metrics = { durationMs: Math.round(performance.now() - started), ttfbMs,
        ...(firstContentAt === undefined ? {} : { ttftMs: Math.round(firstContentAt - started) }), ...this.lastUsage };
      this.lastMetrics = metrics;
      let result: ModelCompatibilityResponse;
      if (mode === "native-tool" && !toolName) throw new ModelProviderError("invalid-response", "Provider did not return the required native tool proposal");
      if (toolName) {
        const allowedToolNames = request.outputContract?.tools?.length
          ? request.outputContract.tools.map(tool => tool.name) : [request.outputContract?.name];
        if (mode !== "native-tool" || !allowedToolNames.includes(toolName)) {
          throw new ModelProviderError("invalid-response", "Provider returned an unrequested tool proposal");
        }
        let argumentsValue: unknown;
        try { argumentsValue = JSON.parse(toolInput || "{}"); }
        catch { throw new ModelProviderError("structured-parse", "Provider returned malformed tool arguments"); }
        result = { kind: "tool-call", name: toolName, arguments: argumentsValue, protocol: "native-tool", metrics, usage: this.lastUsage };
      } else if (mode === "json-schema" || mode === "json-object") {
        let value: unknown;
        try { value = JSON.parse(text); } catch { throw new ModelProviderError("structured-parse", "Provider returned malformed structured output"); }
        result = { kind: "structured", value, protocol: mode, metrics, usage: this.lastUsage };
      } else result = { kind: "text", text, protocol: mode, metrics, usage: this.lastUsage };
      return { text, response: result };
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (request.signal.aborted) throw new ModelProviderError("cancelled", "Model request cancelled");
      throw new ModelProviderError("transport", "Could not complete the provider request");
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abortFromParent);
    }
  }
}

/** Small neutral OpenAI-compatible structured transport client with genuine streaming support. */
export class OpenAICompatibleStructuredClient implements StructuredModelClient {
  #key: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly modelId: string;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxTokens: number;
  private readonly headers?: Record<string, string>;
  private readonly jsonMode: boolean;
  private readonly supportsSystemRole: boolean;
  private readonly stream: boolean;
  private readonly rawText: boolean;
  private readonly maxRetries: number;
  private readonly protocolCapabilities?: ModelProtocolCapabilities;
  private readonly legacyOutputMode: "json-object" | "prompt-json";
  private readonly onBackoff?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private lastUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  private lastMetrics?: ModelExecutionMetrics;

  constructor(options: OpenAICompatibleClientOptions) {
    if (!options.modelId.trim()) throw new Error("Model ID is required");
    this.#key = options.apiKey;
    this.modelId = options.modelId;
    this.timeoutMs = options.timeoutMs ?? configuredTimeout(process.env.MEDIOBOT_MODEL_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "Model request timeout");
    this.idleTimeoutMs = options.idleTimeoutMs ?? configuredTimeout(process.env.MEDIOBOT_MODEL_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, "Model idle timeout");
    this.maxTokens = options.maxTokens ?? 4096;
    this.headers = options.headers;
    this.jsonMode = options.structuredOutput ? options.structuredOutput === "json-object" : options.jsonMode ?? true;
    this.supportsSystemRole = options.supportsSystemRole ?? true;
    this.stream = options.stream ?? true;
    this.rawText = options.rawText ?? false;
    this.maxRetries = options.maxRetries ?? 3;
    this.protocolCapabilities = options.protocolCapabilities;
    this.legacyOutputMode = options.legacyOutputMode ?? (this.jsonMode ? "json-object" : "prompt-json");
    this.onBackoff = options.onBackoff;
    const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.endpoint = base.endsWith("/openai")
      ? `${base}/chat/completions`
      : `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
    this.fetcher = options.fetch ?? fetch;
  }

  async complete(request: StructuredModelRequest): Promise<string> {
    return (await this.execute(request)).text;
  }

  private async execute(request: StructuredModelRequest): Promise<{ readonly text: string; readonly response?: ModelCompatibilityResponse;
    readonly outputMode: ModelOutputProtocol; readonly metrics?: ModelExecutionMetrics;
    readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number } }> {
    if (request.signal?.aborted) throw new ModelProviderError("cancelled", "Model request cancelled");
    const callStartTime = performance.now();
    const outputMode = request.outputContract
      ? selectModelOutputMode(request.outputContract, this.protocolCapabilities, this.legacyOutputMode)
      : "legacy";
    let compatibilityResponse: ModelCompatibilityResponse | undefined;
    let requestUsage: { readonly inputTokens?: number; readonly outputTokens?: number } | undefined;
    let requestMetrics: ModelExecutionMetrics | undefined;
    let ttftMs: number | undefined;

    let attempt = 0;
    while (true) {
      if (request.signal?.aborted) throw new ModelProviderError("cancelled", "Model request cancelled");

      const controller = new AbortController();
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => rejectAbort(new ModelProviderError(
        request.signal?.aborted ? "cancelled" : "timeout",
        request.signal?.aborted ? "Model request cancelled" : "Model request timed out",
      ));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const abort = () => controller.abort();
      if (request.signal?.aborted) controller.abort();
      else if (request.signal) request.signal.addEventListener("abort", abort, { once: true });

      let tokensEmitted = 0;
      let phase: "headers" | "body" = "headers";
      let ttfbMs: number | undefined;
      let idleTimeoutFailure: ModelProviderError | undefined;
      const handleProgress = (chunk: string) => {
        tokensEmitted += chunk.length;
        request.onProgress?.(chunk);
      };

      try {
        controller.signal.throwIfAborted();
        const payload: Record<string, unknown> = {
          model: this.modelId,
          [this.protocolCapabilities?.tokenLimitParameter ?? "max_tokens"]: this.maxTokens,
          ...(this.stream ? { stream: true } : {}),
          ...(outputMode === "json-object" || outputMode === "legacy" && this.jsonMode ? { response_format: { type: "json_object" } } : {}),
          ...(outputMode === "json-schema" && request.outputContract ? { response_format: {
            type: "json_schema", json_schema: { name: request.outputContract.name, strict: request.outputContract.strict ?? false, schema: request.outputContract.schema },
          } } : {}),
          ...(outputMode === "native-tool" && request.outputContract ? {
            tools: (request.outputContract.tools?.length ? request.outputContract.tools : [{
              name: request.outputContract.name, description: request.outputContract.description, parameters: request.outputContract.schema,
            }]).map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
            tool_choice: this.protocolCapabilities?.nativeToolChoice === "auto"
              ? "auto" : { type: "function", function: { name: request.outputContract.name } },
            parallel_tool_calls: false,
          } : {}),
          ...(request.reasoningEffort && this.protocolCapabilities?.reasoningParameter === "reasoning_effort"
            && this.protocolCapabilities.reasoningEfforts?.includes(request.reasoningEffort)
            ? { reasoning_effort: request.reasoningEffort } : {}),
          messages: [
            ...(this.supportsSystemRole ? [{ role: "system", content: request.system }] : []),
            {
              role: "user",
              content: [
                ...(request.images ?? []).map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
                { type: "text", text: this.supportsSystemRole ? request.input : `Instructions:\n${request.system}\n\nInput:\n${request.input}` },
              ],
            },
          ],
        };

        let response: Response;
        try {
          response = await Promise.race([
            this.fetcher(this.endpoint, {
              method: "POST",
              signal: controller.signal,
              headers: {
                "content-type": "application/json",
                ...(this.stream ? { accept: "text/event-stream, application/json" } : {}),
                ...(this.#key.trim() ? { authorization: `Bearer ${this.#key}` } : {}),
                ...(this.headers ?? {}),
              },
              body: JSON.stringify(payload),
            }),
            aborted,
          ]);
        } catch (fetchErr) {
          if (isRetryableNetworkError(fetchErr) && !request.signal?.aborted && !controller.signal.aborted && tokensEmitted === 0 && attempt < this.maxRetries) {
            clearTimeout(timeout);
            request.signal?.removeEventListener("abort", abort);
            controller.signal.removeEventListener("abort", onAbort);
            const delay = computeBackoffDelay(attempt);
            const elapsedMs = performance.now() - callStartTime;
            const remainingDeadlineMs = this.timeoutMs - elapsedMs;
            if (delay > remainingDeadlineMs) {
              throw new ModelProviderError(
                "timeout",
                `Model request retry delay (${delay}ms) exceeds remaining deadline (${Math.max(0, Math.round(remainingDeadlineMs))}ms)`
              );
            }
            if (this.onBackoff) {
              await this.onBackoff(delay, request.signal);
            } else {
              await sleepWithSignal(delay, request.signal);
            }
            attempt++;
            continue;
          }
          throw fetchErr;
        }

        controller.signal.throwIfAborted();
        ttfbMs = Math.round(performance.now() - callStartTime);
        phase = "body";
        if (!response.ok) {
          const status = response.status;
          const isRetryable = status === 429 || status === 502 || status === 503 || status === 504;
          if (isRetryable && tokensEmitted === 0 && attempt < this.maxRetries && !request.signal?.aborted && !controller.signal.aborted) {
            clearTimeout(timeout);
            request.signal?.removeEventListener("abort", abort);
            controller.signal.removeEventListener("abort", onAbort);
            const retryAfterHeader = typeof response.headers?.get === "function" ? response.headers.get("retry-after") : undefined;
            const retryAfterMs = parseRetryAfter(retryAfterHeader);
            const delay = computeBackoffDelay(attempt, retryAfterMs);
            const elapsedMs = performance.now() - callStartTime;
            const remainingDeadlineMs = this.timeoutMs - elapsedMs;
            if (delay > remainingDeadlineMs) {
              throw new ModelProviderError(
                "timeout",
                `Model request retry delay (${delay}ms) exceeds remaining deadline (${Math.max(0, Math.round(remainingDeadlineMs))}ms)`
              );
            }
            if (this.onBackoff) {
              await this.onBackoff(delay, request.signal);
            } else {
              await sleepWithSignal(delay, request.signal);
            }
            attempt++;
            continue;
          }
          throw providerHttpError(status);
        }

        const contentType = (typeof response.headers?.get === "function" ? response.headers.get("content-type") : undefined) ?? "";
        if (this.stream && contentType.includes("text/event-stream") && response.body) {
          // Genuine SSE Streaming mode
          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buffer = "";
          let accumulatedContent = "";
          let totalBytes = 0;
          const streamedToolCalls = new Map<number, { id?: string; name: string; arguments: string }>();
          let truncated = false;
          let malformedChunk = false;
          let retryStream = false;
          let lastFinishReason: string | null | undefined = undefined;
          let accumulatedReasoningLength = 0;

          try {
            outer: while (true) {
              controller.signal.throwIfAborted();
              let readTimer: NodeJS.Timeout | undefined;
              let readResult: ReadableStreamReadResult<Uint8Array>;
              try {
                readResult = await Promise.race([
                  reader.read(),
                  aborted,
                  new Promise<never>((_resolve, reject) => {
                    readTimer = setTimeout(() => reject(new ModelProviderError("timeout", "Model response became idle", {
                      phase: "body", elapsedMs: Math.round(performance.now() - callStartTime), idleTimeoutMs: this.idleTimeoutMs,
                    })), this.idleTimeoutMs);
                  }),
                ]);
              } catch (error) {
                const idleTimeout = error instanceof ModelProviderError && error.code === "timeout"
                  && (error.diagnostic as { phase?: string } | undefined)?.phase === "body";
                if (idleTimeout) { idleTimeoutFailure = error; controller.abort(); }
                if (!request.signal?.aborted && (idleTimeout || !controller.signal.aborted && isRetryableNetworkError(error))
                  && tokensEmitted === 0 && attempt < this.maxRetries) {
                  retryStream = true;
                  break outer;
                }
                throw error;
              } finally { if (readTimer) clearTimeout(readTimer); }
              const { done, value } = readResult;
              if (done) break outer;
              totalBytes += value.byteLength;
              if (totalBytes > MAX_MODEL_RESPONSE_BYTES) {
                controller.abort();
                throw new ModelProviderError("invalid-response", "Model response exceeded the 8 MiB limit");
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
                const jsonStr = trimmed.slice(5).trim();
                if (jsonStr === "[DONE]") break outer;
                try {
                  const chunk = JSON.parse(jsonStr) as {
                    error?: { message?: string; code?: number | string; status?: number; type?: string };
                    choices?: Array<{
                      finish_reason?: string | null;
                      delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null;
                        tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
                    }>;
                    usage?: { prompt_tokens?: number; completion_tokens?: number };
                  };
                  if (chunk.error) {
                    const errorMsg = chunk.error.message || "Model provider error";
                    const code = classifyStreamingProviderError(chunk.error);
                    if ((code === "capacity" || code === "transport") && tokensEmitted === 0 && attempt < this.maxRetries && !request.signal?.aborted) {
                      retryStream = true;
                      break outer;
                    }
                    throw new ModelProviderError(code, errorMsg, { phase: "body",
                      ...(typeof chunk.error.code === "string" ? { providerCode: chunk.error.code.slice(0, 80) } : {}),
                      ...(typeof chunk.error.status === "number" ? { httpStatus: chunk.error.status } : {}),
                      ...(typeof chunk.error.code === "number" ? { httpStatus: chunk.error.code } : {}) });
                  }
                  if (chunk.choices?.[0]?.finish_reason !== undefined && chunk.choices[0].finish_reason !== null) {
                    lastFinishReason = sanitizeFinishReason(chunk.choices[0].finish_reason) ?? "other";
                  }
                  if (chunk.choices?.[0]?.finish_reason === "length") {
                    truncated = true;
                  }
                  const reasoningDelta = chunk.choices?.[0]?.delta?.reasoning_content
                    ?? (chunk.choices?.[0]?.delta as { reasoning?: string | null } | undefined)?.reasoning;
                  if (typeof reasoningDelta === "string" && reasoningDelta) {
                    accumulatedReasoningLength += reasoningDelta.length;
                  }
                  const delta = chunk.choices?.[0]?.delta?.content;
                  if (typeof delta === "string" && delta) {
                    if (ttftMs === undefined) {
                      ttftMs = Math.round(performance.now() - callStartTime);
                    }
                    accumulatedContent += delta;
                    handleProgress?.(delta);
                  }
                  for (const [position, call] of (chunk.choices?.[0]?.delta?.tool_calls ?? []).entries()) {
                    const index = Number.isInteger(call.index) ? call.index! : position;
                    const previous = streamedToolCalls.get(index) ?? { name: "", arguments: "" };
                    if (ttftMs === undefined && (call.function?.name || call.function?.arguments)) {
                      ttftMs = Math.round(performance.now() - callStartTime);
                    }
                    if (call.id) previous.id = (previous.id ?? "") + call.id;
                    if (call.function?.name) previous.name += call.function.name;
                    if (call.function?.arguments) {
                      previous.arguments += call.function.arguments;
                      tokensEmitted += call.function.arguments.length;
                    }
                    streamedToolCalls.set(index, previous);
                  }
                  if (chunk.usage) {
                    const usage = {
                      ...(typeof chunk.usage.prompt_tokens === "number" ? { inputTokens: chunk.usage.prompt_tokens } : {}),
                      ...(typeof chunk.usage.completion_tokens === "number" ? { outputTokens: chunk.usage.completion_tokens } : {}),
                    };
                    requestUsage = Object.keys(usage).length ? usage : undefined;
                    this.lastUsage = requestUsage;
                  }
                } catch (e) {
                  if (e instanceof ModelProviderError) throw e;
                  malformedChunk = true;
                }
              }
            }
          } finally {
            reader.releaseLock();
          }

          if (retryStream) {
            clearTimeout(timeout);
            request.signal?.removeEventListener("abort", abort);
            controller.signal.removeEventListener("abort", onAbort);
            const delay = computeBackoffDelay(attempt);
            const elapsedMs = performance.now() - callStartTime;
            const remainingDeadlineMs = this.timeoutMs - elapsedMs;
            if (delay > remainingDeadlineMs) {
              throw new ModelProviderError(
                "timeout",
                `Model request retry delay (${delay}ms) exceeds remaining deadline (${Math.max(0, Math.round(remainingDeadlineMs))}ms)`
              );
            }
            if (this.onBackoff) {
              await this.onBackoff(delay, request.signal);
            } else {
              await sleepWithSignal(delay, request.signal);
            }
            attempt++;
            continue;
          }

          controller.signal.throwIfAborted();
          const callDurationMs = Math.round(performance.now() - callStartTime);
          if (truncated) {
            const diagnostic: ModelEmptyResponseDiagnostic = {
              modelId: sanitizeIdentifier(this.modelId, 80),
              protocol: this.protocolCapabilities ? "openai-compatible" : undefined,
              outputMode,
              httpStatus: response.status,
              finishReason: lastFinishReason ?? "length",
              contentCharacterCount: accumulatedContent.length,
              reasoningCharacterCount: accumulatedReasoningLength,
              toolCallCount: streamedToolCalls.size,
              parseOutcome: "length-truncated",
              durationMs: callDurationMs,
              ...(ttfbMs !== undefined ? { ttfbMs } : {}),
              ...(ttftMs !== undefined ? { ttftMs } : {}),
            };
            throw new ModelProviderError("structured-parse", "Model response was truncated before the decision completed", diagnostic);
          }
          if (malformedChunk) throw new ModelProviderError("invalid-response", "Model provider returned malformed streaming data");
          if (outputMode === "native-tool") {
            const calls = [...streamedToolCalls.values()];
            if (calls.length !== 1) {
              if (calls.length === 0) {
                const outcome: ModelParseOutcome = lastFinishReason === "content_filter"
                  ? "content-filtered"
                  : (accumulatedReasoningLength > 0 ? "reasoning-only" : "blank");
                const diagnostic: ModelEmptyResponseDiagnostic = {
                  modelId: sanitizeIdentifier(this.modelId, 80),
                  protocol: this.protocolCapabilities ? "openai-compatible" : undefined,
                  outputMode,
                  httpStatus: response.status,
                  finishReason: lastFinishReason,
                  contentCharacterCount: accumulatedContent.length,
                  reasoningCharacterCount: accumulatedReasoningLength,
                  toolCallCount: 0,
                  parseOutcome: outcome,
                  durationMs: callDurationMs,
                  ...(ttfbMs !== undefined ? { ttfbMs } : {}),
                  ...(ttftMs !== undefined ? { ttftMs } : {}),
                };
                throw new ModelProviderError("invalid-response", "Model provider returned an invalid tool-call count", diagnostic);
              }
              throw new ModelProviderError("invalid-response", "Model provider returned an invalid tool-call count");
            }
            const call = calls[0]!;
            const allowedNames = new Set(request.outputContract?.tools?.map(tool => tool.name) ?? [request.outputContract!.name]);
            if (!allowedNames.has(call.name)) throw new ModelProviderError("invalid-response", "Model provider returned an unsupported function name");
            let args: unknown;
            try { args = JSON.parse(call.arguments); } catch { throw new ModelProviderError("structured-parse", "Model provider returned incomplete tool arguments"); }
            if (!args || typeof args !== "object" || Array.isArray(args)) throw new ModelProviderError("invalid-response", "Model tool arguments must be an object");
            compatibilityResponse = { kind: "tool-call", name: call.name, arguments: args, protocol: "native-tool" };
          } else if (!accumulatedContent.trim()) {
            let outcome: ModelParseOutcome = "blank";
            if (lastFinishReason === "content_filter") {
              outcome = "content-filtered";
            } else if (accumulatedReasoningLength > 0) {
              outcome = "reasoning-only";
            } else if (lastFinishReason === "length") {
              outcome = "length-truncated";
            }
            const diagnostic: ModelEmptyResponseDiagnostic = {
              modelId: sanitizeIdentifier(this.modelId, 80),
              protocol: this.protocolCapabilities ? "openai-compatible" : undefined,
              outputMode,
              httpStatus: response.status,
              finishReason: lastFinishReason,
              contentCharacterCount: accumulatedContent.length,
              reasoningCharacterCount: accumulatedReasoningLength,
              toolCallCount: streamedToolCalls.size,
              parseOutcome: outcome,
              durationMs: callDurationMs,
              ...(ttfbMs !== undefined ? { ttfbMs } : {}),
              ...(ttftMs !== undefined ? { ttftMs } : {}),
            };
            throw new ModelProviderError("invalid-response", "Model provider returned no structured content", diagnostic);
          }
          const isEffortSupported = Boolean(request.reasoningEffort && this.protocolCapabilities?.reasoningParameter === "reasoning_effort"
            && this.protocolCapabilities.reasoningEfforts?.includes(request.reasoningEffort));
          this.lastMetrics = {
            durationMs: callDurationMs,
            ...(ttfbMs !== undefined ? { ttfbMs } : {}),
            ...(ttftMs !== undefined ? { ttftMs } : {}),
            ...(requestUsage?.inputTokens !== undefined ? { inputTokens: requestUsage.inputTokens } : {}),
            ...(requestUsage?.outputTokens !== undefined ? { outputTokens: requestUsage.outputTokens } : {}),
            ...(request.reasoningEffort ? { requestedReasoningEffort: request.reasoningEffort } : {}),
            ...(isEffortSupported ? { effectiveReasoningEffort: request.reasoningEffort } : {}),
            ...(request.reasoningEffort && !isEffortSupported ? { unsupportedReasoningEffort: request.reasoningEffort } : {}),
          };
          requestMetrics = this.lastMetrics;
          if (outputMode === "native-tool") return { text: JSON.stringify(compatibilityResponse && compatibilityResponse.kind === "tool-call"
            ? compatibilityResponse.arguments : {}), response: compatibilityResponse, outputMode, metrics: requestMetrics, usage: requestUsage };
          const isRaw = this.rawText || request.rawText === true;
          let result: string;
          try {
            result = isRaw ? accumulatedContent.trim() : structuredJsonOnly(accumulatedContent);
          } catch (parseErr) {
            if (parseErr instanceof ModelProviderError) {
              let cleanStripped: string | undefined;
              try { cleanStripped = stripPrivateReasoning(accumulatedContent); } catch {}
              const onlyReasoning = cleanStripped !== undefined && cleanStripped.trim().length === 0 && accumulatedContent.trim().length > 0;
              if (onlyReasoning) {
                const diagnostic: ModelEmptyResponseDiagnostic = {
                  modelId: sanitizeIdentifier(this.modelId, 80),
                  protocol: this.protocolCapabilities ? "openai-compatible" : undefined,
                  outputMode,
                  httpStatus: response.status,
                  finishReason: lastFinishReason,
                  contentCharacterCount: 0,
                  reasoningCharacterCount: accumulatedReasoningLength + (accumulatedContent.length - (cleanStripped ?? "").length),
                  toolCallCount: streamedToolCalls.size,
                  parseOutcome: "reasoning-only",
                  durationMs: callDurationMs,
                  ...(ttfbMs !== undefined ? { ttfbMs } : {}),
                  ...(ttftMs !== undefined ? { ttftMs } : {}),
                };
                throw new ModelProviderError("invalid-response", "Model provider returned no structured content", diagnostic);
              }
            }
            throw parseErr;
          }
          compatibilityResponse = this.captureStructuredResponse(outputMode, result, request.outputContract);
          return { text: result, response: compatibilityResponse, outputMode, metrics: requestMetrics, usage: requestUsage };
        }

        // Non-streaming fallback
        let body: unknown;
        try {
          if (!response.body) {
            body = await Promise.race([response.json(), aborted]);
          } else {
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          try {
            while (true) {
              let readTimer: NodeJS.Timeout | undefined;
              let item: ReadableStreamReadResult<Uint8Array>;
              try {
                item = await Promise.race([reader.read(), aborted, new Promise<never>((_resolve, reject) => {
                  readTimer = setTimeout(() => reject(new ModelProviderError("timeout", "Model response became idle", {
                    phase: "body", elapsedMs: Math.round(performance.now() - callStartTime), idleTimeoutMs: this.idleTimeoutMs,
                  })), this.idleTimeoutMs);
                })]);
              } catch (error) {
                if (error instanceof ModelProviderError && error.code === "timeout") { idleTimeoutFailure = error; controller.abort(); }
                throw error;
              } finally { if (readTimer) clearTimeout(readTimer); }
              if (item.done) break;
              totalBytes += item.value.byteLength;
              if (totalBytes > MAX_MODEL_RESPONSE_BYTES) throw new ModelProviderError("invalid-response", "Model response exceeded the 8 MiB limit");
              chunks.push(item.value);
            }
          } finally { reader.releaseLock(); }
          const joined = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
          try { body = JSON.parse(new TextDecoder().decode(joined)); }
          catch { throw new SyntaxError("Invalid model response JSON"); }
          }
        } catch (error) {
          if (error instanceof SyntaxError) throw new ModelProviderError("invalid-response", "Model provider returned invalid JSON");
          throw error;
        }
        controller.signal.throwIfAborted();
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new ModelProviderError("invalid-response", "Model provider returned an invalid response");
        }
        const data = body as { choices?: Array<{ finish_reason?: string | null; message?: {
          content?: string | null; parsed?: unknown; reasoning_content?: string | null; reasoning?: string | null;
          tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
        } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const choice = data.choices?.[0];
        const finishReason = sanitizeFinishReason(choice?.finish_reason);
        const message = choice?.message;
        const content = message?.content;
        const rawReasoning = message?.reasoning_content ?? (message as { reasoning?: string | null } | undefined)?.reasoning;
        let reasoningLength = typeof rawReasoning === "string" ? rawReasoning.length : 0;
        if (typeof content === "string") {
          const inlineMatch = content.match(/<think(?:\s+[^>]*)?>([\s\S]*?)(?:<\/think>|$)/i);
          if (inlineMatch && inlineMatch[1]) {
            reasoningLength += inlineMatch[1].length;
          }
        }
        const toolCalls = message?.tool_calls ?? [];
        const callDurationMs = Math.round(performance.now() - callStartTime);
        if (finishReason === "length") {
          const diagnostic: ModelEmptyResponseDiagnostic = {
            modelId: sanitizeIdentifier(this.modelId, 80),
            protocol: this.protocolCapabilities ? "openai-compatible" : undefined,
            outputMode,
            httpStatus: response.status,
            finishReason: "length",
            contentCharacterCount: typeof content === "string" ? content.length : 0,
            reasoningCharacterCount: reasoningLength,
            toolCallCount: toolCalls.length,
            parseOutcome: "length-truncated",
            durationMs: callDurationMs,
            ...(ttfbMs !== undefined ? { ttfbMs } : {}),
          };
          throw new ModelProviderError("structured-parse", "Model response was truncated before the decision completed", diagnostic);
        }
        const usage = {
          ...(typeof data.usage?.prompt_tokens === "number" ? { inputTokens: data.usage.prompt_tokens } : {}),
          ...(typeof data.usage?.completion_tokens === "number" ? { outputTokens: data.usage.completion_tokens } : {}),
        };
        requestUsage = Object.keys(usage).length ? usage : undefined;
        this.lastUsage = requestUsage;
        const isEffortSupportedNonStream = Boolean(request.reasoningEffort && this.protocolCapabilities?.reasoningParameter === "reasoning_effort"
          && this.protocolCapabilities.reasoningEfforts?.includes(request.reasoningEffort));
        this.lastMetrics = {
          durationMs: callDurationMs,
          ...(ttfbMs !== undefined ? { ttfbMs } : {}),
          ...(requestUsage?.inputTokens !== undefined ? { inputTokens: requestUsage.inputTokens } : {}),
          ...(requestUsage?.outputTokens !== undefined ? { outputTokens: requestUsage.outputTokens } : {}),
          ...(request.reasoningEffort ? { requestedReasoningEffort: request.reasoningEffort } : {}),
          ...(isEffortSupportedNonStream ? { effectiveReasoningEffort: request.reasoningEffort } : {}),
          ...(request.reasoningEffort && !isEffortSupportedNonStream ? { unsupportedReasoningEffort: request.reasoningEffort } : {}),
        };
        requestMetrics = this.lastMetrics;
        if (outputMode === "native-tool") {
          const calls = message?.tool_calls ?? [];
          const allowedNames = new Set(request.outputContract?.tools?.map(tool => tool.name) ?? [request.outputContract!.name]);
          if (calls.length !== 1 || !calls[0]?.function?.name || !allowedNames.has(calls[0].function.name)) {
            if (calls.length === 0) {
              const outcome: ModelParseOutcome = finishReason === "content_filter"
                ? "content-filtered"
                : (reasoningLength > 0 ? "reasoning-only" : "blank");
              const diagnostic: ModelEmptyResponseDiagnostic = {
                modelId: sanitizeIdentifier(this.modelId, 80),
                protocol: this.protocolCapabilities ? "openai-compatible" : undefined,
                outputMode,
                httpStatus: response.status,
                finishReason,
                contentCharacterCount: typeof content === "string" ? content.length : 0,
                reasoningCharacterCount: reasoningLength,
                toolCallCount: 0,
                parseOutcome: outcome,
                durationMs: callDurationMs,
                ...(ttfbMs !== undefined ? { ttfbMs } : {}),
              };
              throw new ModelProviderError("invalid-response", "Model provider returned an invalid tool call", diagnostic);
            }
            throw new ModelProviderError("invalid-response", "Model provider returned an invalid tool call");
          }
          let args: unknown;
          try { args = JSON.parse(calls[0].function.arguments ?? ""); } catch { throw new ModelProviderError("structured-parse", "Model provider returned invalid tool arguments"); }
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new ModelProviderError("invalid-response", "Model tool arguments must be an object");
          compatibilityResponse = { kind: "tool-call", name: calls[0].function.name, arguments: args, protocol: "native-tool" };
          return { text: JSON.stringify(args), response: compatibilityResponse, outputMode, metrics: requestMetrics, usage: requestUsage };
        }
        if (message?.parsed !== undefined && outputMode === "json-schema") {
          compatibilityResponse = { kind: "structured", value: message.parsed, protocol: "json-schema" };
          return { text: JSON.stringify(message.parsed), response: compatibilityResponse, outputMode, metrics: requestMetrics, usage: requestUsage };
        }
        if (typeof content !== "string" || !content.trim()) {
          let outcome: ModelParseOutcome = "blank";
          if (finishReason === "content_filter") {
            outcome = "content-filtered";
          } else if (reasoningLength > 0) {
            outcome = "reasoning-only";
          } else if (finishReason === "length") {
            outcome = "length-truncated";
          }
          const diagnostic: ModelEmptyResponseDiagnostic = {
            modelId: sanitizeIdentifier(this.modelId, 80),
            protocol: this.protocolCapabilities ? "openai-compatible" : undefined,
            outputMode,
            httpStatus: response.status,
            finishReason,
            contentCharacterCount: typeof content === "string" ? content.length : 0,
            reasoningCharacterCount: reasoningLength,
            toolCallCount: toolCalls.length,
            parseOutcome: outcome,
            durationMs: callDurationMs,
            ...(ttfbMs !== undefined ? { ttfbMs } : {}),
          };
          throw new ModelProviderError("invalid-response", "Model provider returned no structured content", diagnostic);
        }
        const isRaw = this.rawText || request.rawText === true;
        let result: string;
        try {
          result = isRaw ? content.trim() : structuredJsonOnly(content);
        } catch (parseErr) {
          if (parseErr instanceof ModelProviderError) {
            let cleanStripped: string | undefined;
            try { cleanStripped = stripPrivateReasoning(content); } catch {}
            const onlyReasoning = cleanStripped !== undefined && cleanStripped.trim().length === 0 && content.trim().length > 0;
            if (onlyReasoning) {
              const diagnostic: ModelEmptyResponseDiagnostic = {
                modelId: sanitizeIdentifier(this.modelId, 80),
                protocol: this.protocolCapabilities ? "openai-compatible" : undefined,
                outputMode,
                httpStatus: response.status,
                finishReason,
                contentCharacterCount: 0,
                reasoningCharacterCount: reasoningLength + (content.length - (cleanStripped ?? "").length),
                toolCallCount: toolCalls.length,
                parseOutcome: "reasoning-only",
                durationMs: callDurationMs,
                ...(ttfbMs !== undefined ? { ttfbMs } : {}),
              };
              throw new ModelProviderError("invalid-response", "Model provider returned no structured content", diagnostic);
            }
          }
          throw parseErr;
        }
        compatibilityResponse = this.captureStructuredResponse(outputMode, result, request.outputContract);
        return { text: result, response: compatibilityResponse, outputMode, metrics: requestMetrics, usage: requestUsage };
      } catch (error) {
        if (request.signal?.aborted) {
          const elapsedMs = Math.round(performance.now() - callStartTime);
          this.lastMetrics = { durationMs: elapsedMs, ...(ttfbMs !== undefined ? { ttfbMs } : {}),
            ...(ttftMs !== undefined ? { ttftMs } : {}) };
          throw new ModelProviderError("cancelled", "Model request cancelled", { phase, elapsedMs,
            ...(ttfbMs !== undefined ? { ttfbMs } : {}), ...(ttftMs !== undefined ? { ttftMs } : {}),
            outputCharacters: tokensEmitted });
        }
        if (idleTimeoutFailure) throw idleTimeoutFailure;
        if (error instanceof ModelProviderError && error.code === "invalid-response"
          && error.message === "Model response exceeded the 8 MiB limit") throw error;
        if (controller.signal.aborted) throw new ModelProviderError("timeout", `Model request timed out during ${phase}`, {
          phase, elapsedMs: Math.round(performance.now() - callStartTime), timeoutMs: this.timeoutMs,
          ...(ttfbMs !== undefined ? { ttfbMs } : {}), ...(ttftMs !== undefined ? { ttftMs } : {}),
        });
        if (error instanceof ModelProviderError) throw error;
        throw new ModelProviderError("transport", "Model provider request failed");
      }

 finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  usage(): { readonly inputTokens?: number; readonly outputTokens?: number } | undefined { return this.lastUsage; }
  metrics(): ModelExecutionMetrics | undefined { return this.lastMetrics; }

  async completeCompatible(request: StructuredModelRequest & { readonly outputContract: ModelOutputContract }): Promise<ModelCompatibilityResponse> {
    const result = await this.execute(request);
    if (result.response) return { ...result.response, ...(result.metrics ? { metrics: result.metrics } : {}),
      ...(result.usage ? { usage: result.usage } : {}) } as ModelCompatibilityResponse;
    const resultText = result.text;
    let value: unknown;
    try { value = JSON.parse(resultText); }
    catch { return { kind: "text", text: resultText, protocol: result.outputMode,
      ...(result.metrics ? { metrics: result.metrics } : {}), ...(result.usage ? { usage: result.usage } : {}) }; }
    if (result.outputMode === "json-schema" || result.outputMode === "json-object") {
      return { kind: "structured", value, protocol: result.outputMode,
        ...(result.metrics ? { metrics: result.metrics } : {}), ...(result.usage ? { usage: result.usage } : {}) };
    }
    return { kind: "text", text: resultText, protocol: result.outputMode,
      ...(result.metrics ? { metrics: result.metrics } : {}), ...(result.usage ? { usage: result.usage } : {}) };
  }

  private captureStructuredResponse(mode: ModelOutputProtocol, text: string, contract?: ModelOutputContract): ModelCompatibilityResponse {
    if (mode === "native-tool") throw new ModelProviderError("invalid-response", "Native tool response was not decoded");
    if (!contract || mode === "legacy" || mode === "prompt-json") {
      return { kind: "text", text, protocol: mode };
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new ModelProviderError("structured-parse", "Model provider returned malformed structured output"); }
    return { kind: "structured", value, protocol: mode };
  }
}

function selectModelOutputMode(contract: ModelOutputContract, capabilities: ModelProtocolCapabilities | undefined,
  legacyMode: "json-object" | "prompt-json"): ModelOutputProtocol {
  if (contract.preferredModes) {
    for (const mode of contract.preferredModes) {
      if (mode === "prompt-json" || capabilities?.verifiedModes.includes(mode)) return mode;
    }
    throw new ModelProviderError("unsupported-modality", "The selected provider/model does not support the requested structured decision protocol");
  }
  for (const mode of ["native-tool", "json-schema", "json-object"] as const) {
    if (capabilities?.verifiedModes.includes(mode)) return mode;
  }
  if (capabilities?.verifiedModes.includes("prompt-json")) return "prompt-json";
  return legacyMode;
}

function isAnthropicStrictSchemaCompatible(schema: ModelJsonSchema): boolean {
  const supportedKeys = new Set(["type", "properties", "required", "additionalProperties", "enum", "const", "anyOf", "allOf", "items", "description", "title"]);
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const node = value as Record<string, unknown>;
    if (Object.keys(node).some(key => !supportedKeys.has(key))) return false;
    if (["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(node.type)) === false) return false;
    if (node.type === "object") {
      if (node.additionalProperties !== false || !node.properties || typeof node.properties !== "object" || Array.isArray(node.properties)) return false;
      const properties = node.properties as Record<string, unknown>;
      if (!Array.isArray(node.required) || !node.required.every((key): key is string => typeof key === "string")
        || Object.keys(properties).some(key => !(node.required as string[]).includes(key))
        || (node.required as string[]).some(key => !Object.hasOwn(properties, key))) return false;
      return Object.values(properties).every(visit);
    }
    if (node.type === "array") return visit(node.items);
    if (Array.isArray(node.anyOf) && !node.anyOf.every(visit)) return false;
    if (Array.isArray(node.allOf) && !node.allOf.every(visit)) return false;
    return true;
  };
  return visit(schema);
}

export function normalizeModelOutput(content: string): { visibleText: string; reasoning?: string } {
  let reasoning: string | undefined;
  const match = content.match(/<think>([\s\S]*?)<\/think>/i);
  if (match) {
    reasoning = match[1]?.trim();
  }
  const stripped = stripPrivateReasoning(content);
  if (stripped === undefined) {
    throw new ModelProviderError("structured-parse", "Model response contained an incomplete reasoning block");
  }
  return { visibleText: stripped.trim(), ...(reasoning ? { reasoning } : {}) };
}

export function extractStructuredJsonObject(text: string): string {
  let clean = text.trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  clean = clean.split("\0")[0]!.trim();
  const start = clean.indexOf("{");
  if (start === -1) return clean;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < clean.length; i++) {
    const char = clean[i];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === "\"") { inString = !inString; continue; }
    if (!inString) {
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          return clean.slice(start, i + 1);
        }
      }
    }
  }
  return clean;
}

function sanitizeJsonStringLiterals(jsonStr: string): string {
  return jsonStr.replace(/"((?:[^"\\]|\\.)*)"/gs, (_match, inner) => {
    const escaped = inner
      .replace(/\r\n/g, "\\n")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\n")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  });
}

export function structuredJsonOnly(content: string): string {
  const stripped = stripPrivateReasoning(content);
  if (stripped === undefined) throw new ModelProviderError("structured-parse", "Model response contained an incomplete reasoning block");
  let clean = stripped.trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  clean = clean.split("\0")[0]!.trim();
  clean = clean.replace(/<\/?(?:minimax:[a-z_-]+)>/gi, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    const sanitizedClean = sanitizeJsonStringLiterals(clean);
    try {
      parsed = JSON.parse(sanitizedClean);
      clean = sanitizedClean;
    } catch {
      // Fallback: extract the first balanced JSON object from mixed content (e.g., preamble text before JSON).
      const extracted = extractStructuredJsonObject(clean);
      if (extracted !== clean) {
        try { parsed = JSON.parse(extracted); clean = extracted; }
        catch {
          const sanitizedExtracted = sanitizeJsonStringLiterals(extracted);
          try { parsed = JSON.parse(sanitizedExtracted); clean = sanitizedExtracted; }
          catch { throw new ModelProviderError("structured-parse", "Model response was not valid JSON"); }
        }
      } else {
        throw new ModelProviderError("structured-parse", "Model response was not valid JSON");
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelProviderError("structured-parse", "Model response was not a JSON object");
  }
  return clean;
}

export function sanitizeReasoningAndSecrets(text: string): string {
  if (!text) return "";
  let cleaned = text
    .replace(/\\u003c\s*(\/?\s*(?:think|thought|minimax:thought)(?:\s+(?:(?!\\u003e)[\s\S])*?)?\s*)\\u003e/gi, "<$1>")
    .replace(/&lt;\s*(\/?\s*(?:think|thought|minimax:thought)(?:\s+(?:(?!&gt;)[\s\S])*?)?\s*)&gt;/gi, "<$1>")
    .replace(/<\s*(?:thought|minimax:thought)(?:\s+[^>]*)?>/gi, "<think>")
    .replace(/<\/\s*(?:thought|minimax:thought)\s*>/gi, "</think>");

  // 1. Strip complete <think>...</think> blocks without spanning across intermediate <think> tags
  // (Prevents matching from an earlier literal <think> token across to a subsequent </think> closing tag)
  cleaned = cleaned
    .replace(/\\u003c\s*think(?:\s+[^>]*)?\\u003e((?:(?!(?:\\u003c\s*think|<think))[\s\S])*?)\\u003c\s*\/\s*think\s*\\u003e/gi, "")
    .replace(/&lt;\s*think(?:\s+[^>]*)?&gt;((?:(?!(?:&lt;\s*think|<think))[\s\S])*?)&lt;\s*\/\s*think\s*&gt;/gi, "")
    .replace(/<think(?:\s+[^>]*)?>((?:(?!<think)[\s\S])*?)<\/think>/gi, "");

  // 2. Strip unclosed reasoning blocks while preserving legitimate literal token references.
  // We locate any remaining <think> tags. If a <think> tag is not part of a literal token reference,
  // it represents an unclosed reasoning leakage that must be stripped to the end of the text.
  const thinkTagRegex = /<think(?:\s+[^>]*)?>/gi;
  let match: RegExpExecArray | null;
  let stripFromIndex = -1;

  while ((match = thinkTagRegex.exec(cleaned)) !== null) {
    const matchIndex = match.index;
    const prefix = cleaned.slice(0, matchIndex);
    const suffix = cleaned.slice(matchIndex + match[0].length);

    const isLiteralReference =
      /(?:token|literal|tag|word|string|placeholder)\s*$/i.test(prefix.trim()) ||
      /[`'"]\s*$/.test(prefix) ||
      /^\s*[`'"]/.test(suffix) ||
      /^\s+(?:in\s+the|is\s+a|tag|element)\b/i.test(suffix);

    if (!isLiteralReference) {
      stripFromIndex = matchIndex;
      break;
    }
  }

  if (stripFromIndex !== -1) {
    cleaned = cleaned.slice(0, stripFromIndex);
  }

  // 3. Strip stray closing </think> tags
  cleaned = cleaned
    .replace(/\\u003c\s*\/\s*think\s*\\u003e/gi, "")
    .replace(/&lt;\s*\/\s*think\s*&gt;/gi, "")
    .replace(/<\/think>/gi, "");

  // 4. Strip secrets and auth tokens
  cleaned = cleaned.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
  cleaned = cleaned.replace(/(?:nvapi-|dahl_|sk-|ghp_)[A-Za-z0-9_\-\.]{15,}/gi, "[REDACTED_API_KEY]");

  return cleaned.trim();
}

export function stripPrivateReasoning(content: string): string | undefined {
  let normalized = content
    .replace(/\\u003c\s*(\/?\s*(?:think|thought|minimax:thought))\s*\\u003e/gi, "<$1>")
    .replace(/&lt;\s*(\/?\s*(?:think|thought|minimax:thought))\s*&gt;/gi, "<$1>")
    .replace(/<\s*(?:thought|minimax:thought)(?:\s+[^>]*)?>/gi, "<think>")
    .replace(/<\/\s*(?:thought|minimax:thought)\s*>/gi, "</think>");
  // 1. Strip complete <think>...</think> blocks
  let cleaned = normalized.replace(/<think(?:\s+[^>]*)?>[\s\S]*?<\/think>/gi, "");
  // Candidate JSON inside unclosed reasoning is not a final structured response.
  if (/^\s*<think(?:\s+[^>]*)?>/i.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

/** Raw process output is private execution input, not durable or product telemetry.
 * Pattern-based redaction cannot safely classify arbitrary output, so callers must
 * persist structured execution metadata instead.
 */
export function sanitizeOutputLog(toolName: string | undefined, rawOutput: string | undefined): string | undefined {
  void toolName;
  void rawOutput;
  return undefined;
}

export interface MonotonicToolData {
  toolName: string;
  command?: string;
  workingDirectory?: string;
  recoveryReason?: string;
  inputArgs?: Record<string, unknown> | string;
  outputLog?: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  startedAt?: number;
  durationMs?: number;
  error?: string;
  failureCategory?: string;
  isVerification?: boolean;
  verificationStatus?: 'command-succeeded' | 'command-failed' | 'unverified';
  eventSequence?: number;
  lifecycleConflict?: boolean;
  outcomeBadge?: string;
}

/**
 * Deterministic, idempotent invocation projection. Conflicting terminal outcomes
 * fail closed independently of arrival order; stale nonterminal events cannot reopen it.
 */
export function mergeMonotonicToolData<T extends MonotonicToolData>(
  existing?: T,
  incoming?: T
): T | undefined {
  if (!existing && !incoming) return undefined;
  if (!existing || !incoming) {
    const value = { ...(existing ?? incoming!) } as T;
    delete value.outputLog;
    return value;
  }

  const existingTerminal = existing.status !== 'running';
  const incomingTerminal = incoming.status !== 'running';
  const staleMetadata = typeof existing.eventSequence === 'number' && typeof incoming.eventSequence === 'number'
    && incoming.eventSequence < existing.eventSequence;
  const merged = (staleMetadata ? { ...incoming, ...existing } : { ...existing, ...incoming }) as T;
  delete merged.outputLog;
  const starts = [existing.startedAt, incoming.startedAt].filter((n): n is number => typeof n === 'number');
  merged.startedAt = starts.length ? Math.min(...starts) : undefined;

  if (existing.lifecycleConflict || incoming.lifecycleConflict
    || (existingTerminal && incomingTerminal && existing.status !== incoming.status)) {
    merged.status = 'failed';
    merged.lifecycleConflict = true;
    merged.error = 'Conflicting terminal tool events were received.';
    merged.failureCategory = 'lifecycle-conflict';
    merged.verificationStatus = 'unverified';
    return merged;
  }

  if (existingTerminal && !incomingTerminal) {
    merged.status = existing.status;
    merged.outcomeBadge = existing.outcomeBadge;
    merged.durationMs = existing.durationMs ?? incoming.durationMs;
    merged.error = existing.error;
    merged.failureCategory = existing.failureCategory;
    merged.verificationStatus = existing.verificationStatus;
  } else {
    merged.status = incomingTerminal ? incoming.status : 'running';
    merged.durationMs = (staleMetadata ? existing.durationMs : incoming.durationMs) ?? existing.durationMs;
    merged.error = (staleMetadata ? existing.error : incoming.error) ?? existing.error;
    merged.failureCategory = (staleMetadata ? existing.failureCategory : incoming.failureCategory) ?? existing.failureCategory;
    merged.verificationStatus = (staleMetadata ? existing.verificationStatus : incoming.verificationStatus) ?? existing.verificationStatus;
  }
  if (typeof existing.eventSequence === 'number' || typeof incoming.eventSequence === 'number') {
    merged.eventSequence = Math.max(existing.eventSequence ?? -1, incoming.eventSequence ?? -1);
  }
  return merged;
}

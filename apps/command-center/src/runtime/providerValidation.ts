import type { CatalogProviderItem } from "./modelRegistry.ts";
import type { CustomHeader } from "../storage/providerRepository.ts";

export interface ProviderValidationInput {
  readonly provider: CatalogProviderItem;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly modelId?: string;
  readonly customHeaders?: ReadonlyArray<CustomHeader>;
}

export interface ProviderValidationResult {
  readonly status: "available" | "authenticated" | "degraded" | "unavailable";
  readonly latencyMs?: number;
}

/** Explicit user-triggered validation. Credentials and provider bodies are never returned or logged. */
export async function validateProvider(input: ProviderValidationInput, fetcher: typeof fetch = fetch): Promise<ProviderValidationResult> {
  const apiKey = input.apiKey?.trim() ?? "";
  if (input.provider.requiresApiKey && !apiKey && !input.customHeaders?.some((header) => header.name.trim() && header.value.trim())) {
    throw new Error("An API key is required for this provider.");
  }
  if (input.provider.adapterType === "not-yet-supported") {
    throw new Error(`${input.provider.name} connections are not supported by this runtime yet.`);
  }
  const modelId = input.modelId?.trim() || input.provider.defaultModels[0]?.id;
  if (!modelId) throw new Error("No model is available to validate for this provider.");
  const base = (input.baseUrl ?? input.provider.defaultBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("A provider base URL is required.");
  if (input.provider.adapterType === "anthropic-messages") {
    if (input.provider.id !== "anthropic" || base.toLowerCase() !== "https://api.anthropic.com/v1") {
      throw new Error("Anthropic connections require the official Claude Messages API endpoint.");
    }
    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetcher(`${base}/messages`, {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json", "x-api-key": apiKey,
          "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: modelId, max_tokens: 8, stream: false,
          messages: [{ role: "user", content: "Reply with OK." }] }),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error("The provider rejected these credentials.");
        if (response.status === 429) throw new Error("The provider is rate-limiting requests. Try again later.");
        throw new Error(`The provider could not validate this connection (HTTP ${response.status}).`);
      }
      const result = await response.json() as { content?: Array<{ type?: string; text?: unknown }> };
      if (!result.content?.some(block => block.type === "text" && typeof block.text === "string")) {
        throw new Error("The provider returned an unsupported response format.");
      }
      return { status: "available", latencyMs: Date.now() - startTime };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The provider ")) throw error;
      if (controller.signal.aborted) throw new Error("Provider validation timed out.");
      throw new Error("Could not reach the provider. Check the endpoint and try again.");
    } finally { clearTimeout(timer); }
  }
  const isGoogleCompat = input.provider.id === "google";
  if (isGoogleCompat && base.toLowerCase() !== "https://generativelanguage.googleapis.com/v1beta/openai") {
    throw new Error("Google connections require the official Gemini OpenAI-compatible API endpoint.");
  }
  const endpoint = isGoogleCompat ? `${base}/chat/completions`
    : `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;

  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  for (const header of input.customHeaders ?? []) {
    const name = header.name.trim();
    if (name && header.value.trim() && !["content-type", "host", "content-length"].includes(name.toLowerCase())) {
      headers[name] = header.value;
    }
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 32,
        stream: false,
      }),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("The provider rejected these credentials.");
      }
      if (response.status === 429) {
        throw new Error("The provider is rate-limiting requests. Try again later.");
      }
      throw new Error(`The provider could not validate this connection (HTTP ${response.status}).`);
    }

    const result = await response.json() as {
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>;
    };
    const choice = result.choices?.[0]?.message;
    if (!choice || (typeof choice.content !== "string" && typeof choice.reasoning_content !== "string")) {
      throw new Error("The provider returned an unsupported response format.");
    }

    return {
      status: "available",
      latencyMs: Date.now() - startTime,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The provider ")) throw error;
    if (error instanceof Error && error.message.includes("API key is required")) throw error;
    if (error instanceof Error && error.message.includes("not supported by this runtime yet")) throw error;
    if (controller.signal.aborted) throw new Error("Provider validation timed out.");
    throw new Error("Could not reach the provider. Check the endpoint and try again.");
  } finally {
    clearTimeout(timer);
  }
}

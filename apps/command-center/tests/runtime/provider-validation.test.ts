import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_CATALOG } from "../../src/runtime/modelRegistry.ts";
import { validateProvider } from "../../src/runtime/providerValidation.ts";

test("NVIDIA validation follows its text chat-completions identity without leaking credentials", async () => {
  const provider = PROVIDER_CATALOG.find((item) => item.id === "nvidia")!;
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  await validateProvider({ provider, apiKey: "test-key-never-logged", modelId: "google/diffusiongemma-26b-a4b-it" }, async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  });
  assert.equal(requestUrl, "https://integrate.api.nvidia.com/v1/chat/completions");
  assert.equal((requestInit?.headers as Record<string, string>).authorization, "Bearer test-key-never-logged");
  const body = JSON.parse(String(requestInit?.body));
  assert.equal(body.model, "google/diffusiongemma-26b-a4b-it");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content, "Reply with OK.");
  assert.equal("response_format" in body, false);
});

test("provider validation rejects invalid credentials without exposing response body", async () => {
  const provider = PROVIDER_CATALOG.find((item) => item.id === "dahl")!;
  await assert.rejects(
    validateProvider({ provider, apiKey: "invalid-key", modelId: "MiniMaxAI/MiniMax-M2.7" }, async () =>
      new Response("private provider diagnostic", { status: 401 })),
    (error: unknown) => error instanceof Error && error.message === "The provider rejected these credentials.",
  );
});

test("Anthropic validation uses the official Messages contract and never returns credentials", async () => {
  const anthropic = PROVIDER_CATALOG.find((item) => item.id === "anthropic")!;
  await assert.rejects(validateProvider({ provider: anthropic }), /API key is required/);
  let sentUrl = "";
  let sentInit: RequestInit | undefined;
  const validation = await validateProvider({ provider: anthropic, apiKey: "stub-secret", modelId: "claude-sonnet-4-6" }, async (url, init) => {
    sentUrl = String(url); sentInit = init;
    return Response.json({ content: [{ type: "text", text: "OK" }] });
  });
  assert.equal(validation.status, "available");
  assert.equal(sentUrl, "https://api.anthropic.com/v1/messages");
  const headers = new Headers(sentInit?.headers);
  assert.equal(headers.get("x-api-key"), "stub-secret");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(headers.has("authorization"), false);
  const body = JSON.parse(String(sentInit?.body));
  assert.equal(body.model, "claude-sonnet-4-6");
  assert.equal(body.max_tokens, 8);
  await assert.rejects(validateProvider({ provider: anthropic, baseUrl: "https://proxy.example/v1", apiKey: "stub-secret", modelId: "custom" },
    async () => { throw new Error("must not call nonofficial endpoint"); }), /official Claude Messages API endpoint/);
  const dahl = PROVIDER_CATALOG.find((item) => item.id === "dahl")!;
  await assert.rejects(validateProvider({ provider: dahl }), /API key is required/);
});

test("Gemini validation uses the official OpenAI-compat URL and keeps the API key in the auth header", async () => {
  const google = PROVIDER_CATALOG.find(item => item.id === "google")!;
  let sentUrl = "";
  let sentInit: RequestInit | undefined;
  const validation = await validateProvider({ provider: google, apiKey: "test-gemini-key", modelId: "gemini-3.8-flash" }, async (url, init) => {
    sentUrl = String(url);
    sentInit = init;
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  });
  assert.equal(validation.status, "available");
  assert.equal(sentUrl, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  const headers = new Headers(sentInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer test-gemini-key");
  const body = JSON.parse(String(sentInit?.body));
  assert.equal(body.model, "gemini-3.8-flash");
  await assert.rejects(validateProvider({ provider: google, baseUrl: "https://proxy.example/v1", apiKey: "test-key", modelId: "manual-model" },
    async () => { throw new Error("must not dispatch to an unverified Google route"); }), /official Gemini OpenAI-compatible/);
});

test("OpenAI validation targets Chat Completions and retains bearer auth", async () => {
  const provider = PROVIDER_CATALOG.find(item => item.id === "openai")!;
  let sentUrl = "";
  let sentInit: RequestInit | undefined;
  const result = await validateProvider({ provider, apiKey: "stub-openai-key", modelId: "gpt-5.5" }, async (url, init) => {
    sentUrl = String(url); sentInit = init;
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  });
  assert.equal(result.status, "available");
  assert.equal(sentUrl, "https://api.openai.com/v1/chat/completions");
  assert.equal(new Headers(sentInit?.headers).get("authorization"), "Bearer stub-openai-key");
  assert.equal(JSON.parse(String(sentInit?.body)).model, "gpt-5.5");
});

test("OpenRouter connects through its documented Chat Completions endpoint without claiming model protocol capabilities", async () => {
  const provider = PROVIDER_CATALOG.find(item => item.id === "openrouter")!;
  assert.equal(provider.adapterType, "openai-compatible");
  let sentUrl = "";
  let sentInit: RequestInit | undefined;
  const result = await validateProvider({ provider, apiKey: "fixture-openrouter-key", modelId: "anthropic/claude-sonnet-4.6" }, async (url, init) => {
    sentUrl = String(url); sentInit = init;
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  });
  assert.equal(result.status, "available");
  assert.equal(sentUrl, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(new Headers(sentInit?.headers).get("authorization"), "Bearer fixture-openrouter-key");
  const body = JSON.parse(String(sentInit?.body));
  assert.equal(body.model, "anthropic/claude-sonnet-4.6");
});

test("custom local provider can validate without an API key using an explicit authentication header", async () => {
  const custom = PROVIDER_CATALOG.find((item) => item.id === "custom")!;
  let sentHeaders: Headers | undefined;
  await validateProvider({
    provider: custom,
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "local-model",
    customHeaders: [{ id: "auth", name: "authorization", value: "Basic local-token" }],
  }, async (_input, init) => {
    sentHeaders = new Headers(init?.headers);
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  });
  assert.equal(sentHeaders?.get("authorization"), "Basic local-token");
});

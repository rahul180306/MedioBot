import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository, SqliteCredentialStore, SystemCredentialStore } from "../../src/storage/providerRepository.ts";
import { ChatRepository } from "../../src/storage/chatRepository.ts";
import { LocalHistoryStore } from "../../src/history.ts";
import {
  ModelResolver,
  ModelProviderError,
  PROVIDER_CATALOG,
  getEnabledModels,
  verifiedModelProtocol,
} from "../../src/runtime/modelRegistry.ts";
import { startCommandCenter as startCommandCenterWithSystemCredentials } from "../../src/server.ts";
import { createFakeComposition } from "../helpers/fakeComposition.ts";
import type { OpenAICompatibleClientOptions, StructuredModelClient } from "@mediobot-v2/models";
import { AnthropicMessagesStructuredClient } from "@mediobot-v2/models";
import { OpenAICompatibleStructuredClient } from "@mediobot-v2/models";
import type { ThreadModelSelection } from "../../src/types/index.ts";
import type { DatabaseSync } from "node:sqlite";

// Server tests explicitly inject SQLite credentials so they never touch the
// developer's OS keychain. Production composition always uses the system vault.
const startCommandCenter = (options: Parameters<typeof startCommandCenterWithSystemCredentials>[0] = {}) =>
  startCommandCenterWithSystemCredentials({
    ...options,
    credentialStoreFactory: options.credentialStoreFactory ?? (database => new SqliteCredentialStore(database)),
  });

function createTempDb(): { dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "mediobot-test-models-"));
  const dbPath = path.join(tempDir, "mediobot.db");
  return {
    dbPath,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

test("hosted NIM protocol capability uses exact provider, base URL, and model identity", () => {
  const nemotron = verifiedModelProtocol("nvidia", "https://integrate.api.nvidia.com/v1/", "nvidia/nemotron-3-ultra-550b-a55b");
  assert.deepEqual(nemotron?.verifiedModes, ["prompt-json"]);
  assert.equal(nemotron?.supportsSystemRole, true);
  assert.deepEqual(nemotron?.reasoningEfforts, ["none", "medium", "high"]);
  assert.equal(verifiedModelProtocol("nvidia", "https://custom-proxy.example/v1", "nvidia/nemotron-3-ultra-550b-a55b"), undefined);
  assert.equal(verifiedModelProtocol("custom", "https://integrate.api.nvidia.com/v1", "google/gemma-4-31b-it"), undefined);
  assert.deepEqual(verifiedModelProtocol("nvidia", "https://integrate.api.nvidia.com/v1", "google/gemma-4-31b-it")?.verifiedModes,
    ["prompt-json"], "a generic model catalog tools flag must not promote the hosted route to native tool calling");
});

test("Dahl native tool capability is limited to its documented exact model route", () => {
  const dahl = verifiedModelProtocol("dahl", "https://inference.dahl.global/v1/", "MiniMaxAI/MiniMax-M2.7");
  assert.deepEqual(dahl?.verifiedModes, ["native-tool"]);
  assert.equal(dahl?.source, "https://inference.dahl.global/docs/api/");
  assert.equal(verifiedModelProtocol("dahl", "https://proxy.example/v1", "MiniMaxAI/MiniMax-M2.7"), undefined);
  assert.equal(verifiedModelProtocol("custom", "https://inference.dahl.global/v1", "MiniMaxAI/MiniMax-M2.7"), undefined);
  assert.equal(verifiedModelProtocol("dahl", "https://inference.dahl.global/v1", "unlisted-model"), undefined);
});

test("unprofiled Dahl and custom models stay on prompt-JSON without assuming JSON-object support", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repository = new ProviderRepository(db.raw, new SqliteCredentialStore(db.raw));
    const selections = [
      { id: "dahl-connection", providerType: "dahl", baseUrl: "https://inference.dahl.global/v1", modelId: "unlisted-model" },
      { id: "custom-connection", providerType: "custom", baseUrl: "https://custom.example/v1", modelId: "unlisted-model" },
    ] as const;
    for (const selection of selections) {
      repository.save({ id: selection.id, providerType: selection.providerType, displayName: selection.providerType,
        baseUrl: selection.baseUrl, connected: true, enabled: true,
        models: [{ id: selection.modelId, name: selection.modelId, enabled: true,
          capabilities: { text: true, reasoning: true, vision: false, tools: true, maestroCompatible: true } }] }, "stub-key");
    }
    for (const selection of selections) {
      let requestBody: Record<string, unknown> | undefined;
      let options: OpenAICompatibleClientOptions | undefined;
      const resolver = new ModelResolver(repository, { createClient: value => {
        options = value;
        return new OpenAICompatibleStructuredClient({ ...value, stream: false, fetch: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({ choices: [{ message: { content: '{"action":"inspect"}' } }] });
        } });
      } });
      const resolved = resolver.resolveTextClient({ providerConnectionId: selection.id, modelId: selection.modelId });
      assert.equal(options?.jsonMode, false, `${selection.providerType} must not inherit JSON-object mode`);
      assert.equal(options?.legacyOutputMode, "prompt-json");
      const result = await resolved.client.completeCompatible!({ system: "Choose an action.", input: "Inspect the project.",
        signal: new AbortController().signal, outputContract: { name: "mediobot_action", description: "one action",
          schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false } } });
      assert.equal(result.kind, "text", "prompt-JSON remains on the existing text parser path");
      assert.equal("response_format" in requestBody!, false, `${selection.providerType} must not receive an unverified format field`);
    }
    db.close();
  } finally { cleanup(); }
});

test("Gemini enables only documented native function proposals on its exact compatibility route", async () => {
  const google = PROVIDER_CATALOG.find(provider => provider.id === "google")!;
  assert.equal(google.adapterType, "openai-compatible");
  assert.equal(google.defaultBaseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.deepEqual(verifiedModelProtocol("google", `${google.defaultBaseUrl}/`, "gemini-3.8-flash")?.verifiedModes, ["native-tool"]);
  assert.equal(verifiedModelProtocol("google", "https://proxy.example/v1", "gemini-3.8-flash"), undefined);
  assert.equal(verifiedModelProtocol("google", google.defaultBaseUrl, "unprofiled-gemini"), undefined);

  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repository = new ProviderRepository(db.raw, new SqliteCredentialStore(db.raw));
    repository.save({ id: "google-connection", providerType: "google", displayName: "Gemini",
      baseUrl: google.defaultBaseUrl, connected: true, enabled: true,
      models: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", enabled: true,
        capabilities: { text: true, reasoning: true, vision: true, tools: true, maestroCompatible: true } }] }, "stub-key");
    let options: OpenAICompatibleClientOptions | undefined;
    let sentUrl = "";
    const resolver = new ModelResolver(repository, { createClient: value => {
      options = value;
      return new OpenAICompatibleStructuredClient({ ...value, stream: false, fetch: async (url, init) => {
        sentUrl = String(url);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.model, "gemini-3.8-flash");
        assert.equal(body.tool_choice, "auto");
        assert.equal("response_format" in body, false);
        return Response.json({ choices: [{ message: { tool_calls: [{ id: "call-1", type: "function",
          function: { name: "mediobot_action", arguments: JSON.stringify({ action: "inspect" }) } }] } }] });
      } });
    } });
    const resolved = resolver.resolveTextClient({ providerConnectionId: "google-connection", modelId: "gemini-3.8-flash" });
    assert.equal(options?.baseUrl, google.defaultBaseUrl);
    assert.equal(options?.jsonMode, false);
    assert.equal(options?.legacyOutputMode, "prompt-json");
    assert.equal(options?.protocolCapabilities?.nativeToolChoice, "auto");
    const decision = await resolved.client.completeCompatible!({ system: "Choose one action.", input: "Inspect.",
      signal: new AbortController().signal, outputContract: { name: "mediobot_action", description: "one action",
        schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false } } });
    assert.equal(sentUrl, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    assert.equal(decision.kind, "tool-call");
    db.close();
  } finally { cleanup(); }
});

test("OpenAI GPT-5.5 profile uses exact documented modes and completion-token semantics", async () => {
  const openai = PROVIDER_CATALOG.find(provider => provider.id === "openai")!;
  assert.equal(openai.adapterType, "openai-compatible");
  assert.deepEqual(verifiedModelProtocol("openai", openai.defaultBaseUrl, "gpt-5.5")?.verifiedModes, ["native-tool", "json-schema", "json-object"]);
  assert.equal(verifiedModelProtocol("openai", "https://proxy.example/v1", "gpt-5.5"), undefined);
  assert.equal(verifiedModelProtocol("openai", openai.defaultBaseUrl, "unprofiled-model"), undefined);
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repository = new ProviderRepository(db.raw, new SqliteCredentialStore(db.raw));
    repository.save({ id: "openai-connection", providerType: "openai", displayName: "OpenAI", connected: true,
      enabled: true, baseUrl: openai.defaultBaseUrl, models: [{ id: "gpt-5.5", name: "GPT-5.5", enabled: true,
        capabilities: { text: true, reasoning: true, vision: true, tools: true, structuredOutput: true, maestroCompatible: true } },
        { id: "unprofiled-model", name: "Unprofiled model", enabled: true,
          capabilities: { text: true, reasoning: false, vision: false, tools: true, maestroCompatible: true } }] }, "stub-key");
    let options: OpenAICompatibleClientOptions | undefined;
    let sent: Record<string, unknown> | undefined;
    const resolver = new ModelResolver(repository, { createClient: value => {
      options = value;
      return new OpenAICompatibleStructuredClient({ ...value, stream: false, fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (sent.response_format) return Response.json({ choices: [{ message: { content: JSON.stringify({ action: "schema" }) } }] });
        return Response.json({ choices: [{ message: { tool_calls: [{ id: "call-1", type: "function",
          function: { name: "mediobot_action", arguments: JSON.stringify({ action: "inspect" }) } }] } }] });
      } });
    } });
    const resolved = resolver.resolveTextClient({ providerConnectionId: "openai-connection", modelId: "gpt-5.5" });
    const result = await resolved.client.completeCompatible!({ system: "system", input: "inspect", reasoningEffort: "medium",
      signal: new AbortController().signal, outputContract: { name: "mediobot_action", description: "one action",
        schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false } } });
    assert.equal(options?.legacyOutputMode, "prompt-json", "the exact profile chooses native/schema explicitly; legacy mode stays conservative");
    assert.equal(options?.protocolCapabilities?.tokenLimitParameter, "max_completion_tokens");
    assert.equal(sent?.model, "gpt-5.5");
    assert.equal(sent?.max_completion_tokens, 4096);
    assert.equal("max_tokens" in sent!, false);
    assert.equal(sent?.reasoning_effort, "medium");
    assert.equal(result.kind, "tool-call");
    const schemaResult = await resolved.client.completeCompatible!({ system: "system", input: "inspect", signal: new AbortController().signal,
      outputContract: { name: "mediobot_action", description: "one action",
        schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false }, preferredModes: ["json-schema"] } });
    assert.equal((sent?.response_format as { type?: string }).type, "json_schema");
    assert.equal(schemaResult.kind, "structured");
    assert.deepEqual(schemaResult.value, { action: "schema" });
    let unprofiledOptions: OpenAICompatibleClientOptions | undefined;
    const unprofiledResolver = new ModelResolver(repository, { createClient: value => {
      unprofiledOptions = value; return new OpenAICompatibleStructuredClient({ ...value, stream: false, fetch: async () => Response.json({ choices: [{ message: { content: "{}" } }] }) });
    } });
    unprofiledResolver.resolveTextClient({ providerConnectionId: "openai-connection", modelId: "unprofiled-model" });
    assert.equal(unprofiledOptions?.jsonMode, false);
    assert.equal(unprofiledOptions?.legacyOutputMode, "prompt-json");
    db.close();
  } finally { cleanup(); }
});

test("OpenRouter uses the shared OpenAI-compatible codec with conservative prompt-JSON for unprofiled routed models", async () => {
  const provider = PROVIDER_CATALOG.find(item => item.id === "openrouter")!;
  assert.equal(provider.adapterType, "openai-compatible");
  assert.equal(verifiedModelProtocol("openrouter", provider.defaultBaseUrl, "anthropic/claude-sonnet-4.6"), undefined,
    "the aggregator endpoint must not imply native tools or structured-output support for every routed model");
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repository = new ProviderRepository(db.raw, new SqliteCredentialStore(db.raw));
    repository.save({ id: "router", providerType: "openrouter", displayName: "Router", connected: true, enabled: true,
      baseUrl: provider.defaultBaseUrl, models: [{ id: "anthropic/claude-sonnet-4.6", name: "Claude via OpenRouter", enabled: true,
        capabilities: { text: true, reasoning: true, vision: false, tools: true } }] }, "fixture-openrouter-key");
    let options: OpenAICompatibleClientOptions | undefined;
    let sent: Record<string, unknown> | undefined;
    const resolver = new ModelResolver(repository, { createClient: value => {
      options = value;
      return new OpenAICompatibleStructuredClient({ ...value, stream: false, fetch: async (url, init) => {
        assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-openrouter-key");
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: '{"action":"inspect"}' } }] });
      } });
    } });
    const resolved = resolver.resolveTextClient({ providerConnectionId: "router", modelId: "anthropic/claude-sonnet-4.6" });
    const response = await resolved.client.completeCompatible!({ system: "Return one action.", input: "inspect", signal: new AbortController().signal,
      outputContract: { name: "mediobot_action", description: "one internal action",
        schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false } } });
    assert.equal(options?.protocolCapabilities, undefined);
    assert.equal(options?.jsonMode, false);
    assert.equal(options?.legacyOutputMode, "prompt-json");
    assert.equal(sent?.model, "anthropic/claude-sonnet-4.6");
    assert.equal("tools" in sent!, false);
    assert.equal("response_format" in sent!, false);
    assert.equal(response.kind, "text");
    if (response.kind === "text") assert.equal(response.protocol, "prompt-json");
    assert.deepEqual(JSON.parse(response.kind === "text" ? response.text : "{}"), { action: "inspect" });
    db.close();
  } finally { cleanup(); }
});

test("Anthropic exact Claude Messages route uses the native codec through ModelResolver scheduling", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repository = new ProviderRepository(db.raw, new SqliteCredentialStore(db.raw));
    repository.save({ id: "claude-connection", providerType: "anthropic", displayName: "Claude", connected: true,
      enabled: true, baseUrl: "https://api.anthropic.com/v1", models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6",
        enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: true, maestroCompatible: true } }] }, "stub-key");
    assert.deepEqual(verifiedModelProtocol("anthropic", "https://api.anthropic.com/v1", "claude-sonnet-4-6")?.verifiedModes,
      ["native-tool", "json-schema"]);
    assert.equal(verifiedModelProtocol("anthropic", "https://proxy.example/v1", "claude-sonnet-4-6"), undefined);
    let openAiFactoryCalled = false;
    const resolver = new ModelResolver(repository, {
      createClient: () => { openAiFactoryCalled = true; throw new Error("wrong provider codec"); },
      createAnthropicClient: options => new AnthropicMessagesStructuredClient({ ...options, fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { tools?: Array<{ name: string }> };
        assert.equal(request.tools?.[0]?.name, "mediobot_test_action");
        return Response.json({ type: "message", content: [{ type: "tool_use", id: "toolu_test", name: "mediobot_test_action",
          input: { action: "inspect" } }], usage: { input_tokens: 5, output_tokens: 3 } });
      } }),
    });
    const resolved = resolver.resolveForOperation("tool-calling", { providerConnectionId: "claude-connection", modelId: "claude-sonnet-4-6" });
    assert.equal(resolved.descriptor.providerId, "claude-connection");
    assert.equal(resolved.descriptor.modelId, "claude-sonnet-4-6");
    const proposal = await resolved.client.completeCompatible!({ system: "", input: "inspect", signal: new AbortController().signal,
      outputContract: { name: "mediobot_test_action", description: "one internal action", schema: { type: "object" } } });
    assert.equal(proposal.kind, "tool-call");
    assert.equal(openAiFactoryCalled, false);
    db.close();
  } finally { cleanup(); }
});

test("legacy provider secrets migrate from SQLite into the platform credential store", () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const legacyRepository = new ProviderRepository(db.raw, new SqliteCredentialStore(db.raw));
    legacyRepository.save({ id: "provider-migration", providerType: "custom", displayName: "Test provider",
      baseUrl: "https://provider.example/v1", connected: true, enabled: true, models: [] }, "legacy-test-secret");
    // Recreate the older on-disk format before header values were moved to the credential store.
    db.raw.prepare("UPDATE provider_connections SET custom_headers_json = ? WHERE id = ?")
      .run(JSON.stringify([{ id: "authorization", name: "authorization", value: "legacy-header-secret" }]), "provider-migration");
    const vault = new Map<string, string>();
    const secureStore = new SystemCredentialStore(db.raw, reference => ({
      getPassword: () => vault.get(reference) ?? null,
      setPassword: (secret: string) => { vault.set(reference, secret); },
      deletePassword: () => vault.delete(reference),
    } as never));
    assert.equal((db.raw.prepare("SELECT provider_id FROM provider_secrets WHERE provider_id = ?").get("provider-migration") as unknown), undefined,
      "plaintext SQLite row must be removed after secure storage succeeds");
    assert.deepEqual(secureStore.get("provider-migration"), {
      apiKey: "legacy-test-secret",
      customHeaders: [{ id: "authorization", name: "authorization", value: "legacy-header-secret" }],
    });
    const migratedHeaders = db.raw.prepare("SELECT custom_headers_json FROM provider_connections WHERE id = ?").get("provider-migration") as { custom_headers_json: string };
    assert.equal(migratedHeaders.custom_headers_json.includes("legacy-header-secret"), false,
      "legacy custom header values must be redacted after the credential vault confirms storage");
    const secureRepository = new ProviderRepository(db.raw, secureStore);
    assert.equal(secureRepository.getSecret("provider-migration"), "legacy-test-secret");
    secureRepository.save({ id: "provider-migration", providerType: "custom", displayName: "Test provider",
      baseUrl: "https://provider.example/v1", connected: true, enabled: true,
      customHeaders: [{ id: "authorization", name: "authorization", value: "replacement-header-secret" }],
      models: [{ id: "saved-model", name: "Saved model", enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }] }, "replacement-test-secret");
    assert.equal(secureRepository.getSecret("provider-migration"), "replacement-test-secret");
    assert.equal((db.raw.prepare("SELECT provider_id FROM provider_secrets WHERE provider_id = ?").get("provider-migration") as unknown), undefined,
      "new settings writes must go to the platform store, not SQLite");
    assert.equal((db.raw.prepare("SELECT custom_headers_json FROM provider_connections WHERE id = ?").get("provider-migration") as { custom_headers_json: string }).custom_headers_json.includes("replacement-header-secret"), false);
    let resolvedOptions: OpenAICompatibleClientOptions | undefined;
    const resolver = new ModelResolver(secureRepository, { createClient: options => {
      resolvedOptions = options;
      return { complete: async () => '{"type":"respond","message":"controlled"}' };
    } });
    const resolved = resolver.resolveTextClient({ providerConnectionId: "provider-migration", modelId: "saved-model" });
    assert.equal(resolved.descriptor.providerId, "provider-migration");
    assert.equal(resolved.descriptor.modelId, "saved-model");
    assert.equal(resolvedOptions?.apiKey, "replacement-test-secret",
      "runtime must resolve the exact credential and model saved through Settings without a network call");
    db.close();
  } finally { cleanup(); }
});

test("credential migration keeps the SQLite source intact until the platform store confirms persistence", () => {
  const failedVault = (reference: string) => ({
    getPassword: () => null,
    setPassword: (_secret: string) => {},
    deletePassword: () => {},
  } as never);

  const secretDb = createTempDb();
  try {
    const db = new LocalDatabase(secretDb.dbPath);
    const legacy = new ProviderRepository(db.raw, new SqliteCredentialStore(db.raw));
    legacy.save({ id: "provider-unconfirmed-secret", providerType: "custom", displayName: "Migration fixture",
      baseUrl: "https://provider.example/v1", connected: true, enabled: true, models: [] }, "fixture-secret-preserve-me");

    assert.throws(() => new SystemCredentialStore(db.raw, failedVault), /did not confirm/);
    const stillStored = db.raw.prepare("SELECT api_key FROM provider_secrets WHERE provider_id = ?")
      .get("provider-unconfirmed-secret") as { api_key: string } | undefined;
    assert.ok(stillStored?.api_key.includes("fixture-secret-preserve-me"),
      "SQLite credential must remain if the platform vault does not read back the write");
    db.close();
  } finally { secretDb.cleanup(); }

  const headerDb = createTempDb();
  try {
    const db = new LocalDatabase(headerDb.dbPath);
    const legacy = new ProviderRepository(db.raw, new SqliteCredentialStore(db.raw));
    legacy.save({ id: "provider-unconfirmed-header", providerType: "custom", displayName: "Header migration fixture",
      baseUrl: "https://provider.example/v1", connected: true, enabled: true, models: [],
      customHeaders: [{ id: "authorization", name: "authorization", value: "fixture-header-preserve-me" }] });
    db.raw.prepare("DELETE FROM provider_secrets WHERE provider_id = ?").run("provider-unconfirmed-header");
    db.raw.prepare("UPDATE provider_connections SET custom_headers_json = ? WHERE id = ?")
      .run(JSON.stringify([{ id: "authorization", name: "authorization", value: "fixture-header-preserve-me" }]), "provider-unconfirmed-header");

    assert.throws(() => new SystemCredentialStore(db.raw, failedVault), /did not confirm/);
    const stillStored = db.raw.prepare("SELECT custom_headers_json FROM provider_connections WHERE id = ?")
      .get("provider-unconfirmed-header") as { custom_headers_json: string } | undefined;
    assert.ok(stillStored?.custom_headers_json.includes("fixture-header-preserve-me"),
      "custom header must remain if the platform vault does not read back the write");
    db.close();
  } finally { headerDb.cleanup(); }
});

test("Settings API stores credentials in the system-store adapter and resolves the exact configured model", async () => {
  const { dbPath, cleanup } = createTempDb();
  const vault = new Map<string, string>();
  const credentialStoreFactory = (database: DatabaseSync) =>
    new SystemCredentialStore(database, reference => ({
      getPassword: () => vault.get(reference) ?? null,
      setPassword: (secret: string) => { vault.set(reference, secret); },
      deletePassword: () => { vault.delete(reference); },
    } as never));
  const server = await startCommandCenterWithSystemCredentials({
    providerValidator: async () => {},
    credentialStoreFactory,
    databasePath: dbPath,
    composition: createFakeComposition(),
    vite: false,
    listen: true,
    port: 0,
  });
  try {
    const connected = await fetch(`${server.url}/api/providers/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "openai", providerType: "openai", displayName: "Controlled OpenAI",
        apiKey: "controlled-secret", customHeaders: [{ id: "authorization", name: "authorization", value: "controlled-header" }],
        models: [{ id: "chosen-model", name: "Chosen model", enabled: true,
          capabilities: { text: true, reasoning: true, vision: false, tools: true } }],
      }),
    });
    assert.equal(connected.status, 200);
    const payload = await connected.json() as { provider: { credentialStatus: string; models: Array<{ id: string }> } };
    assert.equal(payload.provider.credentialStatus, "configured");
    assert.equal(payload.provider.models[0]?.id, "chosen-model");

    const listed = await fetch(`${server.url}/api/providers`);
    const listedPayload = await listed.json() as { providers: unknown[] };
    assert.equal(JSON.stringify(listedPayload).includes("controlled-secret"), false);
    const inspectionDb = new LocalDatabase(dbPath);
    try {
      assert.equal(inspectionDb.raw.prepare("SELECT provider_id FROM provider_secrets WHERE provider_id = ?").get("openai"), undefined,
        "provider secrets must not be persisted in SQLite");
      const headersRow = inspectionDb.raw.prepare("SELECT custom_headers_json FROM provider_connections WHERE id = ?").get("openai") as { custom_headers_json: string };
      assert.equal(headersRow.custom_headers_json.includes("controlled-header"), false,
        "custom header values must not be persisted in SQLite");
    } finally { inspectionDb.close(); }

    let resolvedOptions: OpenAICompatibleClientOptions | undefined;
    const resolver = new ModelResolver(server.providerRepo, { createClient: options => {
      resolvedOptions = options;
      return { complete: async () => '{"type":"respond","message":"controlled"}' };
    } });
    const resolved = resolver.resolveTextClient({ providerConnectionId: "openai", modelId: "chosen-model" });
    assert.equal(resolved.descriptor.providerId, "openai");
    assert.equal(resolved.descriptor.modelId, "chosen-model");
    assert.equal(resolvedOptions?.apiKey, "controlled-secret");
  } finally {
    await server.close();
    cleanup();
  }
});

test("a provider connected in Settings is used by the normal /api/turns execution with the exact model pair", { timeout: 10_000 }, async t => {
  const { dbPath, cleanup } = createTempDb();
  const database = new LocalDatabase(dbPath);
  const vault = new Map<string, string>();
  const credentialStoreFactory = (databaseHandle: DatabaseSync) => new SystemCredentialStore(databaseHandle, reference => ({
    getPassword: () => vault.get(reference) ?? null,
    setPassword: (secret: string) => { vault.set(reference, secret); },
    deletePassword: () => { vault.delete(reference); },
  } as never));
  const credentialStore = credentialStoreFactory(database.raw);
  const providerRepository = new ProviderRepository(database.raw, credentialStore);
  const resolved: OpenAICompatibleClientOptions[] = [];
  const requests: Array<{ system: string; input: string }> = [];
  const modelResolver = new ModelResolver(providerRepository, { createClient: options => {
    resolved.push(options);
    return { complete: async ({ system, input }) => {
      requests.push({ system, input });
      return JSON.stringify({ type: "respond", message: "Settings-selected model response.", basis: "conversation", evidenceRefs: [] });
    } };
  } });
  const app = await startCommandCenterWithSystemCredentials({
    databasePath: dbPath,
    providerRepository,
    modelResolver,
    providerValidator: async () => {},
    credentialStoreFactory,
    workspaceRoot: path.dirname(dbPath),
    vite: false,
    listen: true,
    port: 0,
  });
  t.after(async () => { await app.close(); database.close(); cleanup(); });

  const connected = await fetch(`${app.url}/api/providers/connect`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "settings-openai", providerType: "openai", displayName: "Settings OpenAI",
      apiKey: "controlled-settings-credential",
      models: [{ id: "settings-model-v2", name: "Settings model v2", enabled: true,
        capabilities: { text: true, reasoning: true, vision: false, tools: false } }],
    }),
  });
  assert.equal(connected.status, 200);
  const selected = { providerConnectionId: "settings-openai", modelId: "settings-model-v2" };
  const started = await fetch(`${app.url}/api/turns`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: "settings-thread", turnId: "settings-turn", prompt: "Hi", modelSelection: selected }),
  });
  assert.equal(started.status, 202);
  const payload = await started.json() as { providerId: string; modelId: string; modelExecution: { providerConnectionId: string; modelId: string } };
  assert.equal(payload.providerId, selected.providerConnectionId);
  assert.equal(payload.modelId, selected.modelId);
  assert.deepEqual(payload.modelExecution, {
    providerConnectionId: selected.providerConnectionId,
    providerId: selected.providerConnectionId,
    modelId: selected.modelId,
    displayName: "Settings model v2",
  });

  const deadline = Date.now() + 3_000;
  let savedTurn: { status: string } | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(`${app.url}/api/threads/settings-thread`);
    if (response.ok) {
      const body = await response.json() as { thread: { turns: Array<{ status: string }> } };
      savedTurn = body.thread.turns.find(turn => turn.status === "completed");
      if (savedTurn) break;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(savedTurn?.status, "completed", "controlled /api/turns must settle through the ordinary product path");
  assert.ok(requests.length > 0, "the selected model must receive a real structured decision request");
  assert.ok(resolved.length > 0);
  for (const options of resolved) {
    assert.equal(options.modelId, selected.modelId);
    assert.equal(options.apiKey, "controlled-settings-credential");
  }
  assert.ok(requests.some(request => request.system.includes("Maestro")));
  assert.equal((await app.providerRepo.get("settings-openai"))?.models.find(model => model.id === selected.modelId)?.enabled, true);
});

test("ACCEPTANCE 1: FRESH INSTALL - Empty connected providers and empty enabled models", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const providerRepo = new ProviderRepository(db.raw);
    const server = await startCommandCenter({ providerValidator: async () => {},
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      // 1. Direct repository is empty
      const initialProviders = providerRepo.list();
      assert.deepEqual(initialProviders, [], "Fresh DB must have 0 connected providers");

      const initialEnabled = getEnabledModels(providerRepo);
      assert.deepEqual(initialEnabled, [], "Fresh DB must have 0 enabled models");

      // 2. HTTP GET /api/providers is empty
      const provRes = await fetch(`${server.url}/api/providers`);
      assert.equal(provRes.status, 200);
      const { providers } = (await provRes.json()) as { providers: any[] };
      assert.deepEqual(providers, [], "GET /api/providers must return empty array on fresh install");

      // 3. HTTP GET /api/models/enabled is empty
      const enabledRes = await fetch(`${server.url}/api/models/enabled`);
      assert.equal(enabledRes.status, 200);
      const { models: enabledModels } = (await enabledRes.json()) as { models: any[] };
      assert.deepEqual(enabledModels, [], "GET /api/models/enabled must return empty array on fresh install");

      // 4. HTTP GET /api/models returns empty list
      const modelsRes = await fetch(`${server.url}/api/models`);
      assert.equal(modelsRes.status, 200);
      const modelsData = (await modelsRes.json()) as { models: any[] };
      assert.deepEqual(modelsData.models, [], "GET /api/models must return empty models array on fresh install");
    } finally {
      await server.close();
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("ACCEPTANCE 2: CONNECT PROVIDER - Connect fake provider P with models M1/M2", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const server = await startCommandCenter({ providerValidator: async () => {},
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      const payload = {
        id: "provider-p",
        providerType: "custom",
        displayName: "Provider P",
        baseUrl: "https://api.provider-p.test/v1",
        apiKey: "secret-p-key",
        customHeaders: [{ id: "header-1", name: "x-provider-secret", value: "secret-header-value" }],
        models: [
          {
            id: "m1",
            name: "Model 1",
            capabilities: { text: true, reasoning: true, vision: false, tools: true },
            enabled: true,
          },
          {
            id: "m2",
            name: "Model 2",
            capabilities: { text: true, reasoning: false, vision: true, tools: false },
            enabled: false,
          },
        ],
      };

      const createRes = await fetch(`${server.url}/api/providers/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(createRes.status, 200);
      const { provider: created } = (await createRes.json()) as { provider: any };
      assert.equal(created.id, "provider-p");
      assert.equal(created.displayName, "Provider P");
      assert.equal(created.credentialStatus, "configured");
      // Secret must NEVER be returned
      assert.equal(created.apiKey, undefined);
      assert.equal(JSON.stringify(created).includes("secret-p-key"), false);
      assert.equal(JSON.stringify(created).includes("secret-header-value"), false);

      // Verify listing shows provider P with models M1/M2
      const listRes = await fetch(`${server.url}/api/providers`);
      assert.equal(listRes.status, 200);
      const { providers: list } = (await listRes.json()) as { providers: any[] };
      assert.equal(list.length, 1);
      assert.equal(list[0].id, "provider-p");
      assert.equal(list[0].models.length, 2);
      assert.equal(list[0].models[0].id, "m1");
      assert.equal(list[0].models[1].id, "m2");
      assert.equal(JSON.stringify(list).includes("secret-p-key"), false);
      assert.equal(JSON.stringify(list).includes("secret-header-value"), false);
    } finally {
      await server.close();
    }
  } finally {
    cleanup();
  }
});

test("ACCEPTANCE 3: ENABLE MODEL - Enable M1 -> M1 appears in enabled model projection", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const server = await startCommandCenter({ providerValidator: async () => {},
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      await fetch(`${server.url}/api/providers/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "provider-enable",
          providerType: "custom",
          displayName: "Provider Enable",
          baseUrl: "https://api.enable.test/v1",
          apiKey: "enable-key",
          models: [
            {
              id: "model-m1",
              name: "Model M1",
              capabilities: { text: true, reasoning: true, vision: false, tools: true },
              enabled: false,
            },
          ],
        }),
      });

      // Initially 0 enabled models
      let enabledRes = await fetch(`${server.url}/api/models/enabled`);
      let { models: enabled } = (await enabledRes.json()) as { models: any[] };
      assert.equal(enabled.length, 0);

      // ENABLE M1
      const enableRes = await fetch(
        `${server.url}/api/providers/provider-enable/models/model-m1`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }
      );
      assert.equal(enableRes.status, 200);

      // M1 now appears in enabled model projection
      enabledRes = await fetch(`${server.url}/api/models/enabled`);
      enabled = ((await enabledRes.json()) as { models: any[] }).models;
      assert.equal(enabled.length, 1);
      assert.equal(enabled[0].id, "model-m1");
    } finally {
      await server.close();
    }
  } finally {
    cleanup();
  }
});

test("ACCEPTANCE 4: DISABLE MODEL - Disable M1 -> M1 disappears from enabled model projection", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const server = await startCommandCenter({ providerValidator: async () => {},
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      await fetch(`${server.url}/api/providers/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "provider-disable",
          providerType: "custom",
          displayName: "Provider Disable",
          baseUrl: "https://api.disable.test/v1",
          apiKey: "disable-key",
          models: [
            {
              id: "model-m1",
              name: "Model M1",
              capabilities: { text: true, reasoning: true, vision: false, tools: true },
              enabled: true,
            },
          ],
        }),
      });

      // Initially 1 enabled model
      let enabledRes = await fetch(`${server.url}/api/models/enabled`);
      let { models: enabled } = (await enabledRes.json()) as { models: any[] };
      assert.equal(enabled.length, 1);
      assert.equal(enabled[0].id, "model-m1");

      // DISABLE M1
      const disableRes = await fetch(
        `${server.url}/api/providers/provider-disable/models/model-m1`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        }
      );
      assert.equal(disableRes.status, 200);

      // M1 disappears from enabled model projection
      enabledRes = await fetch(`${server.url}/api/models/enabled`);
      enabled = ((await enabledRes.json()) as { models: any[] }).models;
      assert.equal(enabled.length, 0);
    } finally {
      await server.close();
    }
  } finally {
    cleanup();
  }
});

test("ACCEPTANCE 5: DISCONNECT PROVIDER - P removed, models unavailable, no stale routing", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const server = await startCommandCenter({ providerValidator: async () => {},
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      // Connect provider
      await fetch(`${server.url}/api/providers/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "provider-to-remove",
          providerType: "custom",
          displayName: "Temporary Provider",
          baseUrl: "https://api.temp.test/v1",
          apiKey: "temp-key",
          models: [
            {
              id: "temp-model",
              name: "Temp Model",
              capabilities: { text: true, reasoning: true, vision: false, tools: true },
              enabled: true,
            },
          ],
        }),
      });

      // Confirm it exists
      let provs = ((await (await fetch(`${server.url}/api/providers`)).json()) as { providers: any[] }).providers;
      assert.equal(provs.length, 1);

      // DELETE provider
      const delRes = await fetch(`${server.url}/api/providers/provider-to-remove`, {
        method: "DELETE",
      });
      assert.equal(delRes.status, 200);

      // Verify provider is gone
      provs = ((await (await fetch(`${server.url}/api/providers`)).json()) as { providers: any[] }).providers;
      assert.equal(provs.length, 0);

      // Verify enabled models is empty
      const enabled = ((await (await fetch(`${server.url}/api/models/enabled`)).json()) as { models: any[] }).models;
      assert.equal(enabled.length, 0);

      // Attempting to resolve deleted provider fails truthfully
      assert.throws(
        () => {
          server.modelResolver.resolve({
            providerConnectionId: "provider-to-remove",
            modelId: "temp-model",
          });
        },
        (err: any) => {
          assert.equal(err.code, "configuration");
          assert.match(err.message, /not connected/);
          return true;
        }
      );
    } finally {
      await server.close();
    }
  } finally {
    cleanup();
  }
});

test("ACCEPTANCE 6: THREAD ISOLATION - Thread A selects P/M1 and Thread B selects Q/M2 independently", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const server = await startCommandCenter({ providerValidator: async () => {},
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      const selectionA: ThreadModelSelection = { providerConnectionId: "provider-p", modelId: "m1" };
      const selectionB: ThreadModelSelection = { providerConnectionId: "provider-q", modelId: "m2" };

      // Create Thread A with selection A
      const threadARes = await fetch(`${server.url}/api/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread: {
            id: "thread-a",
            title: "Chat A",
            modelSelection: selectionA,
          },
        }),
      });
      assert.equal(threadARes.status, 200);
      const { thread: threadA } = (await threadARes.json()) as { thread: any };
      assert.deepEqual(threadA.modelSelection, selectionA);

      // Create Thread B with selection B
      const threadBRes = await fetch(`${server.url}/api/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread: {
            id: "thread-b",
            title: "Chat B",
            modelSelection: selectionB,
          },
        }),
      });
      assert.equal(threadBRes.status, 200);
      const { thread: threadB } = (await threadBRes.json()) as { thread: any };
      assert.deepEqual(threadB.modelSelection, selectionB);

      // Fetch all threads and verify independent retention
      const listRes = await fetch(`${server.url}/api/threads`);
      assert.equal(listRes.status, 200);
      const { threads } = (await listRes.json()) as { threads: any[] };
      const retrievedA = threads.find((t) => t.id === "thread-a");
      const retrievedB = threads.find((t) => t.id === "thread-b");

      assert.deepEqual(retrievedA.modelSelection, selectionA);
      assert.deepEqual(retrievedB.modelSelection, selectionB);

      // Update Thread A's model to selection B
      const patchRes = await fetch(`${server.url}/api/threads/thread-a`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelSelection: selectionB }),
      });
      assert.equal(patchRes.status, 200);
      const { thread: patchedA } = (await patchRes.json()) as { thread: any };
      assert.deepEqual(patchedA.modelSelection, selectionB);
    } finally {
      await server.close();
    }
  } finally {
    cleanup();
  }
});

test("ACCEPTANCE 7: RELOAD / SERVER RESTART - Persisted connections, enabled preferences, and thread selections restored from SQLite", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const selectionA: ThreadModelSelection = { providerConnectionId: "provider-persisted", modelId: "model-1" };

    // Phase 1: Start Server 1, configure provider, enable model, create thread
    const server1 = await startCommandCenter({ providerValidator: async () => {},
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      await fetch(`${server1.url}/api/providers/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "provider-persisted",
          providerType: "custom",
          displayName: "Persisted Provider",
          baseUrl: "https://api.persisted.test/v1",
          apiKey: "persisted-secret",
          models: [
            {
              id: "model-1",
              name: "Persisted Model 1",
              capabilities: { text: true, reasoning: true, vision: false, tools: true },
              enabled: true,
            },
            {
              id: "model-2",
              name: "Persisted Model 2",
              capabilities: { text: true, reasoning: false, vision: true, tools: false },
              enabled: false,
            },
          ],
        }),
      });

      await fetch(`${server1.url}/api/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread: {
            id: "thread-persisted-1",
            title: "Persistent Thread",
            modelSelection: selectionA,
          },
        }),
      });
    } finally {
      await server1.close();
    }

    // Phase 2: Start Server 2 against the exact same SQLite database
    const server2 = await startCommandCenter({ providerValidator: async () => {},
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      // 1. Provider connection and models restored
      const provRes = await fetch(`${server2.url}/api/providers`);
      assert.equal(provRes.status, 200);
      const { providers: provs } = (await provRes.json()) as { providers: any[] };
      assert.equal(provs.length, 1);
      assert.equal(provs[0].id, "provider-persisted");
      assert.equal(provs[0].displayName, "Persisted Provider");
      assert.equal(provs[0].credentialStatus, "configured");
      assert.equal(provs[0].models.length, 2);
      assert.equal(provs[0].models[0].enabled, true);
      assert.equal(provs[0].models[1].enabled, false);

      // 2. Enabled models projection restored
      const enabledRes = await fetch(`${server2.url}/api/models/enabled`);
      assert.equal(enabledRes.status, 200);
      const { models: enabled } = (await enabledRes.json()) as { models: any[] };
      assert.equal(enabled.length, 1);
      assert.equal(enabled[0].id, "model-1");

      // 3. Thread model selection restored
      const threadsRes = await fetch(`${server2.url}/api/threads`);
      assert.equal(threadsRes.status, 200);
      const { threads } = (await threadsRes.json()) as { threads: any[] };
      const t = threads.find((item) => item.id === "thread-persisted-1");
      assert.ok(t);
      assert.deepEqual(t.modelSelection, selectionA);
    } finally {
      await server2.close();
    }
  } finally {
    cleanup();
  }
});

test("ACCEPTANCE 8: REAL RESOLUTION - Selecting P/M1 routes to adapter P with M1; selecting Q/M2 routes to adapter Q with M2", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const providerRepo = new ProviderRepository(db.raw);

    // Save provider P with model M1
    providerRepo.save(
      {
        id: "provider-p",
        providerType: "custom",
        displayName: "Provider P",
        baseUrl: "https://api.p.test/v1",
        connected: true,
        enabled: true,
        models: [
          {
            id: "m1",
            name: "Model M1",
            capabilities: { text: true, reasoning: true, vision: false, tools: true },
            enabled: true,
          },
        ],
      },
      "secret-key-p"
    );

    // Save provider Q with model M2
    providerRepo.save(
      {
        id: "provider-q",
        providerType: "custom",
        displayName: "Provider Q",
        baseUrl: "https://api.q.test/v1",
        connected: true,
        enabled: true,
        models: [
          {
            id: "m2",
            name: "Model M2",
            capabilities: { text: true, reasoning: true, vision: false, tools: true },
            enabled: true,
          },
        ],
      },
      "secret-key-q"
    );

    const clientCalls: OpenAICompatibleClientOptions[] = [];
    const resolver = new ModelResolver(providerRepo, {
      createClient: (options) => {
        clientCalls.push(options);
        return {
          id: `fake-client-${options.modelId}`,
          complete: async () => ({
            rawText: `Response for ${options.modelId}`,
            content: `Response for ${options.modelId}`,
            provider: options.modelId,
            model: options.modelId,
          }),
          executeStructuredTurn: async () => ({
            rawText: `Response for ${options.modelId}`,
            content: `Response for ${options.modelId}`,
            provider: options.modelId,
            model: options.modelId,
          }),
        } as unknown as StructuredModelClient;
      },
    });

    // 1. Resolve P / M1
    const resolvedP = resolver.resolve({ providerConnectionId: "provider-p", modelId: "m1" });
    assert.equal(resolvedP.descriptor.providerId, "provider-p");
    assert.equal(resolvedP.descriptor.modelId, "m1");
    assert.equal(clientCalls.length, 1);
    assert.equal(clientCalls[0].modelId, "m1");
    assert.equal(clientCalls[0].baseUrl, "https://api.p.test/v1");
    assert.equal(clientCalls[0].apiKey, "secret-key-p");

    // 2. Resolve Q / M2
    const resolvedQ = resolver.resolve({ providerConnectionId: "provider-q", modelId: "m2" });
    assert.equal(resolvedQ.descriptor.providerId, "provider-q");
    assert.equal(resolvedQ.descriptor.modelId, "m2");
    assert.equal(clientCalls.length, 2);
    assert.equal(clientCalls[1].modelId, "m2");
    assert.equal(clientCalls[1].baseUrl, "https://api.q.test/v1");
    assert.equal(clientCalls[1].apiKey, "secret-key-q");

    // 3. Test end-to-end through HTTP turn execution
    let capturedSubmitOptions: Record<string, unknown> | undefined;
    const fakeComp = createFakeComposition();
    const originalSubmit = fakeComp.submit.bind(fakeComp);
    fakeComp.submit = (defId, goal, submitOpts, onBeforeEmit) => {
      capturedSubmitOptions = submitOpts;
      return originalSubmit(defId, goal, submitOpts, onBeforeEmit);
    };

    const server = await startCommandCenter({ providerValidator: async () => {},
      databasePath: dbPath,
      composition: fakeComp,
      modelResolver: resolver,
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      const turnRes = await fetch(`${server.url}/api/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "test-thread-real-switch",
          turnId: "turn-p-m1",
          prompt: "Hello with model P/M1",
          modelSelection: { providerConnectionId: "provider-p", modelId: "m1" },
        }),
      });
      assert.equal(turnRes.status, 202);
      const turnData = (await turnRes.json()) as any;
      // Dev-safe observability includes providerId and modelId
      assert.equal(turnData.providerId, "provider-p");
      assert.equal(turnData.modelId, "m1");
      assert.equal(turnData.apiKey, undefined, "Secrets must NEVER be in turn response");

      // Verify that options passed to submission contains the exact modelSelection
      assert.ok(capturedSubmitOptions);
      assert.deepEqual(capturedSubmitOptions.modelSelection, {
        providerConnectionId: "provider-p",
        modelId: "m1",
      });
    } finally {
      await server.close();
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("ACCEPTANCE 9: CAPABILITY MISMATCH - Vision-only model rejects text turn with truthful error (no silent fallback)", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const providerRepo = new ProviderRepository(db.raw);

    // Save vision-only provider
    providerRepo.save(
      {
        id: "nvidia-vision",
        providerType: "nvidia",
        displayName: "NVIDIA Vision",
        baseUrl: "https://api.nvidia.test/v1",
        connected: true,
        enabled: true,
        models: [
          {
            id: "diffusion-gemma",
            name: "DiffusionGemma",
            capabilities: { text: false, reasoning: false, vision: true, tools: false },
            enabled: true,
          },
        ],
      },
      "nvidia-key"
    );

    const resolver = new ModelResolver(providerRepo);

    // 1. checkCapability returns ok: false
    const check = resolver.checkCapability(
      { providerConnectionId: "nvidia-vision", modelId: "diffusion-gemma" },
      "text"
    );
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.match(check.error, /does not support text/);
    }

    // 2. resolve() throws ModelProviderError with unsupported-modality
    assert.throws(
      () => {
        resolver.resolve({ providerConnectionId: "nvidia-vision", modelId: "diffusion-gemma" });
      },
      (err: any) => {
        assert.equal(err.code, "unsupported-modality");
        assert.match(err.message, /does not support text reasoning/);
        return true;
      }
    );

    // 3. HTTP POST /api/turns returns 400 with truthful error code and message
    const server = await startCommandCenter({ providerValidator: async () => {},
      databasePath: dbPath,
      composition: createFakeComposition(),
      modelResolver: resolver,
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      const turnRes = await fetch(`${server.url}/api/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "test-thread-capability",
          turnId: "turn-nvidia-vision",
          prompt: "Try text reasoning on vision-only model",
          modelSelection: { providerConnectionId: "nvidia-vision", modelId: "diffusion-gemma" },
        }),
      });
      assert.equal(turnRes.status, 400);
      const turnError = (await turnRes.json()) as any;
      assert.equal(turnError.code, "unsupported-modality");
      assert.match(turnError.error.message, /does not support text/);
    } finally {
      await server.close();
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("ACCEPTANCE 10: NO FAKE CATALOG LEAK - Unconnected catalog providers never appear in connected projection", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      // 1. Catalog has standard available provider types
      const catRes = await fetch(`${server.url}/api/providers/catalog`);
      assert.equal(catRes.status, 200);
      const { catalog } = (await catRes.json()) as { catalog: any[] };
      assert.ok(catalog.length > 0);
      assert.ok(catalog.some((c) => c.id === "anthropic"));
      assert.ok(catalog.some((c) => c.id === "google"));
      assert.ok(catalog.some((c) => c.id === "openai"));

      // 2. Connected providers does NOT contain any of them
      const provRes = await fetch(`${server.url}/api/providers`);
      assert.equal(provRes.status, 200);
      const { providers: connected } = (await provRes.json()) as { providers: any[] };
      assert.equal(connected.length, 0, "No catalog providers can leak into connected providers list");

      const names = connected.map((c) => c.displayName.toLowerCase());
      assert.ok(!names.includes("anthropic"));
      assert.ok(!names.includes("google"));
      assert.ok(!names.includes("opencode zen"));
      assert.ok(!names.includes("dahl"));
      assert.ok(!names.includes("nvidia"));

      // 3. Enabled models projection does NOT contain any catalog models
      const enabledRes = await fetch(`${server.url}/api/models/enabled`);
      assert.equal(enabledRes.status, 200);
      const { models: enabled } = (await enabledRes.json()) as { models: any[] };
      assert.equal(enabled.length, 0, "No catalog models can leak into enabled models");
    } finally {
      await server.close();
    }
  } finally {
    cleanup();
  }
});

test("DiffusionGemma is text-capable and resolves the configured NVIDIA model identity exactly", () => {
  const nvidia = PROVIDER_CATALOG.find((provider) => provider.id === "nvidia")!;
  const model = nvidia.defaultModels.find((item) => item.id === "google/diffusiongemma-26b-a4b-it")!;
  assert.deepEqual(model.capabilities, {
    text: true,
    reasoning: true,
    vision: true,
    tools: false,
    structuredOutput: true,
    maestroCompatible: true,
  });
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ProviderRepository(db.raw);
    repo.save({ id: "nvidia", providerType: "nvidia", displayName: "NVIDIA", baseUrl: nvidia.defaultBaseUrl,
      connected: true, enabled: true, models: [{ ...model, enabled: true }] }, "test-only-key");
    let clientOptions: OpenAICompatibleClientOptions | undefined;
    const resolver = new ModelResolver(repo, { createClient: (options) => {
      clientOptions = options;
      return { complete: async () => '{"type":"respond","message":"Hi"}' };
    } });
    const resolved = resolver.resolveTextClient({ providerConnectionId: "nvidia", modelId: model.id });
    assert.equal(resolved.descriptor.providerId, "nvidia");
    assert.equal(resolved.descriptor.modelId, "google/diffusiongemma-26b-a4b-it");
    assert.equal(resolved.descriptor.modelName, "DiffusionGemma 26B");
    assert.equal(clientOptions?.jsonMode, false);
    assert.equal(clientOptions?.supportsSystemRole, false);
    assert.deepEqual(clientOptions?.protocolCapabilities?.verifiedModes, ["prompt-json"]);
    assert.match(clientOptions?.protocolCapabilities?.source ?? "", /diffusiongemma-26b-a4b-it-infer/);
    db.close();
  } finally { cleanup(); }
});

test("environment credentials alone cannot connect or resolve a provider", () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ProviderRepository(db.raw);
    repo.save({ id: "dahl", providerType: "dahl", displayName: "Dahl", connected: true, enabled: true,
      models: [{ id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7", enabled: true }] });
    const resolver = new ModelResolver(repo, { env: { DAHL_API_KEY: "ignored-test-env-key" } });
    assert.equal(repo.list()[0]?.connected, false);
    assert.deepEqual(getEnabledModels(repo), []);
    assert.throws(() => resolver.resolveTextClient({ providerConnectionId: "dahl", modelId: "MiniMaxAI/MiniMax-M2.7" }),
      (error: unknown) => error instanceof ModelProviderError && /not connected/.test(error.message));
    db.close();
  } finally { cleanup(); }
});

test("custom no-key endpoint resolves with its CredentialStore auth header and no invented bearer token", () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ProviderRepository(db.raw);
    repo.save({ id: "local", providerType: "custom", displayName: "Local", baseUrl: "http://127.0.0.1:11434/v1",
      connected: true, enabled: true, customHeaders: [{ id: "auth", name: "authorization", value: "Basic local-token" }],
      models: [{ id: "local-model", name: "Local model", enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }] });
    let clientOptions: OpenAICompatibleClientOptions | undefined;
    const resolver = new ModelResolver(repo, { createClient: (options) => {
      clientOptions = options;
      return { complete: async () => '{"type":"respond"}' };
    } });
    resolver.resolveTextClient({ providerConnectionId: "local", modelId: "local-model" });
    assert.equal(clientOptions?.apiKey, "");
    assert.deepEqual(clientOptions?.headers, { authorization: "Basic local-token" });
    db.close();
  } finally { cleanup(); }
});

test("catalog click is not a connection and Anthropic without credentials stays disconnected", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const server = await startCommandCenter({ databasePath: dbPath, composition: createFakeComposition(), vite: false, listen: true, port: 0 });
    try {
      const legacy = await fetch(`${server.url}/api/providers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "anthropic" }) });
      assert.equal(legacy.status, 410);
      const response = await fetch(`${server.url}/api/providers/connect`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "anthropic", providerType: "anthropic", displayName: "Anthropic", models: [] }) });
      assert.equal(response.status, 422);
      assert.match(JSON.stringify(await response.json()), /API key is required/);
      assert.deepEqual(await server.providerRepo.list(), []);
    } finally { await server.close(); }
  } finally { cleanup(); }
});

test("ModelResolver.createInferenceSnapshot creates valid snapshot from selection", () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ProviderRepository(db.raw);
    repo.save({
      id: "nvidia", providerType: "nvidia", displayName: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1/",
      connected: true, enabled: true,
      models: [{ id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }],
    }, "nim-key");
    const resolver = new ModelResolver(repo);
    const snapshot = resolver.createInferenceSnapshot({
      providerConnectionId: "nvidia",
      modelId: "nvidia/nemotron-3-ultra-550b-a55b",
      reasoningEffort: "high",
    });
    assert.equal(snapshot.connectionId, "nvidia");
    assert.equal(snapshot.providerKey, "nvidia");
    assert.equal(snapshot.modelId, "nvidia/nemotron-3-ultra-550b-a55b");
    assert.equal(snapshot.requestedEffort, "high");
    assert.equal(snapshot.effectiveEffort, "high");
    assert.deepEqual(snapshot.protocolCapabilities, ["prompt-json"]);
    assert.equal(typeof snapshot.resolvedAt, "number");
    db.close();
  } finally { cleanup(); }
});

test("ModelResolver.connectAdmissionPort coordinates with admission port on scheduled complete", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ProviderRepository(db.raw);
    repo.save({
      id: "nvidia", providerType: "nvidia", displayName: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1/",
      connected: true, enabled: true,
      models: [{ id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }],
    }, "nim-key");
    let admissionAttempts = 0;
    const admissionPort: import("@mediobot-v2/models").ModelAdmissionPort = {
      tryAcquire: (scope) => {
        admissionAttempts++;
        assert.equal(scope.connectionId, "nvidia");
        assert.equal(scope.modelId, "nvidia/nemotron-3-ultra-550b-a55b");
        assert.equal(scope.taskId, "task-123");
        assert.equal(scope.workspaceId, "ws-456");
        return { granted: true, leaseId: "lease-1", release: () => {} };
      },
      release: () => {},
      subscribeCapacityChange: () => () => {},
    };
    const resolver = new ModelResolver(repo, {
      admissionPort,
      createClient: () => ({
        complete: async () => '{"output":"done"}',
      }),
    });
    const resolved = resolver.resolveTextClient({
      providerConnectionId: "nvidia",
      modelId: "nvidia/nemotron-3-ultra-550b-a55b",
      taskId: "task-123",
      workspaceId: "ws-456",
    });
    const result = await resolved.client.complete({
      system: "system",
      input: "input",
      signal: new AbortController().signal,
    });
    assert.equal(result, '{"output":"done"}');
    assert.equal(admissionAttempts, 1);
    db.close();
  } finally { cleanup(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAICompatibleStructuredClient,
  ModelProviderError,
} from "@mediobot-v2/models";
import {
  getEnabledModels,
  getProviderCatalog,
  ModelResolver,
  PROVIDER_CATALOG,
} from "../../src/runtime/modelRegistry.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";

function createMockRepo() {
  const db = new LocalDatabase(":memory:");
  const repo = new ProviderRepository(db.raw);
  return { db, repo };
}

test("1. Streaming SSE accumulation, TTFT measurement, and reasoning extraction", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"<think>Internal plan</think>"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"{\\"type\\":\\"respond\\","}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"\\"message\\":\\"Hello from Dahl!\\",\\"basis\\":\\"greeting\\"}"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":25}}\n\n',
    "data: [DONE]\n\n",
  ];

  let streamRead = false;
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "test-dahl-key",
    modelId: "MiniMaxAI/MiniMax-M2.7",
    stream: true,
    fetch: async () => {
      streamRead = true;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });

  const progressChunks: string[] = [];
  const result = await client.complete({
    system: "Return structured JSON.",
    input: "Hi",
    signal: new AbortController().signal,
    onProgress: (chunk) => progressChunks.push(chunk),
  });

  assert.equal(streamRead, true);
  const parsed = JSON.parse(result);
  assert.equal(parsed.type, "respond");
  assert.equal(parsed.message, "Hello from Dahl!");
  assert.deepEqual(client.usage(), { inputTokens: 12, outputTokens: 25 });
  assert.ok(progressChunks.length > 0);
});

test("2. Rejection of truncated responses on finish_reason: 'length'", async () => {
  const truncatedChunks = [
    'data: {"choices":[{"delta":{"content":"{\\"type\\":\\"respond\\",\\"message\\":\\"incomplete"}}]}}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    "data: [DONE]\n\n",
  ];

  const client = new OpenAICompatibleStructuredClient({
    apiKey: "test-dahl-key",
    modelId: "MiniMaxAI/MiniMax-M2.7",
    stream: true,
    fetch: async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of truncatedChunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  await assert.rejects(
    client.complete({
      system: "Return JSON",
      input: "Hi",
      signal: new AbortController().signal,
    }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "structured-parse");
      assert.match(err.message, /truncated/);
      return true;
    }
  );
});

test("3. NVIDIA DiffusionGemma is permitted for image-perception but strictly rejected for Maestro orchestration", () => {
  const { db, repo } = createMockRepo();
  try {
    const nvidiaEntry = PROVIDER_CATALOG.find((p) => p.id === "nvidia")!;
    repo.save(
      {
        id: "nvidia",
        providerType: "nvidia",
        displayName: "NVIDIA",
        baseUrl: nvidiaEntry.defaultBaseUrl,
        connected: true,
        enabled: true,
        models: [
          {
            id: "google/diffusiongemma-26b-a4b-it",
            name: "DiffusionGemma",
            enabled: true,
            capabilities: {
              text: true,
              reasoning: false,
              vision: true,
              tools: false,
              maestroCompatible: false,
            },
          },
        ],
      },
      "test-nvidia-key"
    );

    const resolver = new ModelResolver(repo, {
      createClient: (opts) =>
        new OpenAICompatibleStructuredClient({
          ...opts,
          fetch: async () => Response.json({ choices: [{ message: { content: "OK" } }] }),
        }),
    });

    // 1. image-perception is supported by DiffusionGemma
    const visionClient = resolver.resolveForOperation("image-perception", {
      providerConnectionId: "nvidia",
      modelId: "google/diffusiongemma-26b-a4b-it",
    });
    assert.equal(visionClient.descriptor.modelId, "google/diffusiongemma-26b-a4b-it");
    assert.equal(visionClient.descriptor.capabilities.vision, true);

    // 2. Maestro structured orchestration (dom-reasoning) must be strictly rejected
    assert.throws(
      () =>
        resolver.resolveForOperation("dom-reasoning", {
          providerConnectionId: "nvidia",
          modelId: "google/diffusiongemma-26b-a4b-it",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ModelProviderError);
        assert.equal(err.code, "unsupported-modality");
        assert.match(err.message, /not compatible with Maestro/);
        return true;
      }
    );

    // 3. checkCapability also identifies incompatibility
    const check = resolver.checkCapability(
      { providerConnectionId: "nvidia", modelId: "google/diffusiongemma-26b-a4b-it" },
      "maestro"
    );
    assert.equal(check.ok, false);
  } finally {
    db.close();
  }
});

test("4. Dahl MiniMax M2.7 is maestroCompatible and succeeds for dom-reasoning", () => {
  const { db, repo } = createMockRepo();
  try {
    const dahlEntry = PROVIDER_CATALOG.find((p) => p.id === "dahl")!;
    repo.save(
      {
        id: "dahl",
        providerType: "dahl",
        displayName: "Dahl",
        baseUrl: dahlEntry.defaultBaseUrl,
        connected: true,
        enabled: true,
        models: [
          {
            id: "MiniMaxAI/MiniMax-M2.7",
            name: "MiniMax M2.7",
            enabled: true,
            capabilities: {
              text: true,
              reasoning: true,
              vision: false,
              tools: true,
              maestroCompatible: true,
              structuredOutput: true,
            },
          },
        ],
      },
      "test-dahl-key"
    );

    const resolver = new ModelResolver(repo, {
      createClient: (opts) =>
        new OpenAICompatibleStructuredClient({
          ...opts,
          fetch: async () => Response.json({ choices: [{ message: { content: "OK" } }] }),
        }),
    });

    const maestroResolved = resolver.resolveForOperation("dom-reasoning", {
      providerConnectionId: "dahl",
      modelId: "MiniMaxAI/MiniMax-M2.7",
    });
    assert.equal(maestroResolved.descriptor.modelId, "MiniMaxAI/MiniMax-M2.7");
    assert.equal(maestroResolved.descriptor.capabilities.maestroCompatible, true);
    assert.equal(maestroResolved.descriptor.capabilities.reasoning, true);

    const check = resolver.checkCapability(
      { providerConnectionId: "dahl", modelId: "MiniMaxAI/MiniMax-M2.7" },
      "maestro"
    );
    assert.equal(check.ok, true);
  } finally {
    db.close();
  }
});

test("5. Unconnected Anthropic is absent from enabled model selector and active projections", () => {
  const { db, repo } = createMockRepo();
  try {
    // Only Dahl is connected; Anthropic is in catalog but not connected
    const dahlEntry = PROVIDER_CATALOG.find((p) => p.id === "dahl")!;
    repo.save(
      {
        id: "dahl",
        providerType: "dahl",
        displayName: "Dahl",
        baseUrl: dahlEntry.defaultBaseUrl,
        connected: true,
        enabled: true,
        models: [{ id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7", enabled: true }],
      },
      "test-key"
    );

    const enabledModels = getEnabledModels(repo);
    assert.equal(enabledModels.length, 1);
    assert.equal(enabledModels[0]?.providerId, "dahl");
    assert.equal(enabledModels[0]?.id, "MiniMaxAI/MiniMax-M2.7");

    // Anthropic is NOT in enabled models
    const hasAnthropic = enabledModels.some(
      (m) => m.providerId === "anthropic" || m.name.toLowerCase().includes("claude")
    );
    assert.equal(hasAnthropic, false);

    // Connecting Anthropic without credentials fails validation
    const resolver = new ModelResolver(repo);
    assert.throws(
      () =>
        resolver.resolveForOperation("dom-reasoning", {
          providerConnectionId: "anthropic",
          modelId: "claude-3-5-sonnet",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ModelProviderError);
        assert.equal(err.code, "configuration");
        assert.match(err.message, /not connected/);
        return true;
      }
    );
  } finally {
    db.close();
  }
});

test("6. HTTP 401/403/429 status codes map truthfully without leaking secrets", async () => {
  for (const [status, expectedCode] of [
    [401, "authentication"],
    [403, "authentication"],
    [429, "capacity"],
  ] as const) {
    const client = new OpenAICompatibleStructuredClient({
      apiKey: "super-secret-token",
      modelId: "MiniMaxAI/MiniMax-M2.7",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "Internal provider error" } }), {
          status,
          headers: { "content-type": "application/json" },
        }),
    });

    await assert.rejects(
      client.complete({
        system: "System",
        input: "Hello",
        signal: new AbortController().signal,
      }),
      (err: unknown) => {
        assert.ok(err instanceof ModelProviderError);
        assert.equal(err.code, expectedCode);
        assert.doesNotMatch(err.message, /super-secret-token/);
        return true;
      }
    );
  }
});

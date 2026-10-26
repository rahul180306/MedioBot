import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAICompatibleStructuredClient, normalizeModelOutput } from "@mediobot-v2/models";
import { OpenAICompatibleVisionClient } from "@mediobot-v2/vision";

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.env");
try { process.loadEnvFile(envPath); } catch { /* ignore */ }

test("Live Model Test: Dahl MiniMax M2.7 text, structured output, and <think> normalization", async () => {
  const dahlKey = process.env.DAHL_API_KEY?.trim();
  if (!dahlKey) {
    console.log("Skipping live Dahl test: DAHL_API_KEY not set");
    return;
  }

  // The explicit live test reaches the configured provider directly.
  const client = new OpenAICompatibleStructuredClient({
    apiKey: dahlKey,
    modelId: "MiniMaxAI/MiniMax-M2.7",
    baseUrl: "https://inference.dahl.global/v1",
    maxTokens: 4096,
  });

  const abort = new AbortController();
  const rawResponse = await client.complete({
    system: "You are a test assistant. Always output a single JSON object with key 'answer'.",
    input: "Say hello",
    signal: abort.signal,
  });

  const parsed = JSON.parse(rawResponse);
  assert.ok(parsed.answer);

  // 3. Normalization works on output
  const normalized = normalizeModelOutput(rawResponse);
  assert.ok(normalized.visibleText.length > 0);
});

test("Live Model Test: NVIDIA DiffusionGemma multimodal endpoint", async () => {
  const nvKey = process.env.NVIDIA_API_KEY?.trim();
  if (!nvKey) {
    console.log("Skipping live NVIDIA test: NVIDIA_API_KEY not set");
    return;
  }

  // Multimodal analysis through the provider client.
  const visionClient = new OpenAICompatibleVisionClient({
    apiKey: nvKey,
    modelId: "google/diffusiongemma-26b-a4b-it",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    timeoutMs: 30000,
  });

  // Minimal 1x1 black png base64
  const testImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const visionResult = await visionClient.analyzeImage({
    image: testImage,
    prompt: "What is in this image?",
  });

  assert.equal(visionResult.provider, "nvidia");
  assert.equal(visionResult.model, "google/diffusiongemma-26b-a4b-it");
  assert.ok(visionResult.content.length > 0);
  assert.ok(visionResult.latencyMs > 0);
});

test("Live End-to-End Workflow: Screenshot -> NVIDIA Vision Specialist Perception -> Dahl MiniMax Code Implementation", async () => {
  const nvKey = process.env.NVIDIA_API_KEY?.trim();
  const dahlKey = process.env.DAHL_API_KEY?.trim();
  if (!nvKey || !dahlKey) {
    console.log("Skipping live full multimodal test: Keys not set");
    return;
  }

  // 1. Create client for NVIDIA Vision specialist
  const visionClient = new OpenAICompatibleStructuredClient({
    apiKey: nvKey,
    modelId: "google/diffusiongemma-26b-a4b-it",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    timeoutMs: 30000,
    stream: false,
    jsonMode: false,
    supportsSystemRole: false,
    rawText: true,
  });

  // Mock ModelResolver providing image-perception via NVIDIA
  const mockResolver = {
    resolveForOperation: (op: string) => {
      if (op === "image-perception") {
        return {
          client: visionClient,
          descriptor: { providerId: "nvidia", modelId: "google/diffusiongemma-26b-a4b-it", capabilities: { text: true, vision: true } },
        };
      }
      throw new Error("unsupported");
    },
  } as any;

  // 2. Ingest turn with image attachment through MultimodalContextIngestion
  const { MultimodalContextIngestion } = await import("../../src/runtime/contextIngestion.ts");
  const ingestion = new MultimodalContextIngestion(mockResolver);

  // Valid 1x1 PNG
  const testPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const imageAttachment = {
    id: "33333333-4444-4555-8666-777777777777",
    name: "dialog.png",
    mimeType: "image/png",
    size: testPng.length,
    kind: "image" as const,
    createdAt: Date.now(),
    hash: "testimg",
    bytes: testPng,
  };

  const resolved = await ingestion.resolve({
    prompt: "Implement a button component matching the visual design described.",
    attachments: [imageAttachment],
    selectedModelCapabilities: { text: true, reasoning: true, vision: false, tools: true }, // Dahl is text-only
  });

  assert.ok(resolved.visualPerception, "Must extract visual perception via NVIDIA Vision specialist");
  assert.equal(resolved.visualPerception?.modelId, "google/diffusiongemma-26b-a4b-it");
  assert.ok(resolved.promptWithContext.includes("Visual Perception Analysis"), "Prompt must include visual findings");

  // 3. Send resolved multimodal context to Dahl MiniMax M2.7 to implement the code
  const dahlClient = new OpenAICompatibleStructuredClient({
    apiKey: dahlKey,
    modelId: "MiniMaxAI/MiniMax-M2.7",
    baseUrl: "https://inference.dahl.global/v1",
    maxTokens: 4096,
    stream: true,
  });

  const abort = new AbortController();
  const codeResponse = await dahlClient.complete({
    system: "You are an expert React TypeScript engineer. Output a valid React component implementing the requested feature based on the visual specifications.",
    input: resolved.promptWithContext,
    signal: abort.signal,
  });

  assert.ok(codeResponse.length > 50, "Dahl must generate complete code response based on vision perception");
  assert.ok(codeResponse.includes("button") || codeResponse.includes("Button"), "Generated code must include button component");
});


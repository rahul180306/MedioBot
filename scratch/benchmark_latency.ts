import { OpenAICompatibleStructuredClient } from "../packages/models/src/index.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

function parseEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), ".env");
  const env: Record<string, string> = {};
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  } catch (err) {
    console.error("Could not read .env", err);
  }
  return env;
}

const env = parseEnv();
const DAHL_API_KEY = env.DAHL_API_KEY || process.env.DAHL_API_KEY;
const DAHL_BASE_URL = env.DAHL_BASE_URL || "https://inference.dahl.global/v1";
const MODEL_ID = env.MINIMAX_MODEL_ID || "MiniMaxAI/MiniMax-M2.7";

async function runDirectInference(prompt: string): Promise<{ totalMs: number; ttftMs: number }> {
  const client = new OpenAICompatibleStructuredClient({
    apiKey: DAHL_API_KEY ?? "",
    baseUrl: DAHL_BASE_URL,
    modelId: MODEL_ID,
    jsonMode: false,
    supportsSystemRole: true,
  });

  const tStart = performance.now();
  await client.complete({
    system: `You are a helpful assistant. Return ONLY a JSON object matching this schema: {"greeting": string}`,
    input: prompt,
    signal: AbortSignal.timeout(30000),
  });
  const tEnd = performance.now();
  const metrics = client.metrics?.();
  return {
    totalMs: Math.round((tEnd - tStart) * 10) / 10,
    ttftMs: metrics?.ttftMs ?? 0,
  };
}

async function runMediobotTurn(prompt: string, threadId: string, turnId: string): Promise<{ totalMs: number; timing?: any; assistantText?: string }> {
  const tStart = performance.now();
  const res = await fetch("http://127.0.0.1:4173/api/turns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId,
      turnId,
      prompt,
      modelSelection: {
        providerConnectionId: "dahl",
        modelId: MODEL_ID,
      },
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Turn failed with status ${res.status}: ${txt}`);
  }

  // Fetch the completed turn from thread to verify answer
  const threadRes = await fetch(`http://127.0.0.1:4173/api/threads/${threadId}`);
  const threadData = await threadRes.json();
  const turn = threadData.thread?.turns?.find((t: any) => t.id === turnId);
  const assistantMsg = turn?.items?.find((i: any) => i.type === "agent_message");

  const tEnd = performance.now();
  return {
    totalMs: Math.round((tEnd - tStart) * 10) / 10,
    assistantText: assistantMsg?.text,
  };
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

function median(arr: number[]): number {
  return percentile(arr, 50);
}

async function main() {
  console.log("=== GATE A: LATENCY COMPARISON (DIRECT PROVIDER vs MEDIOBOT TURN) ===");
  console.log(`Provider: Dahl (${DAHL_BASE_URL}) | Model: ${MODEL_ID}\n`);

  const iterations = 5;
  const directLatencies: number[] = [];
  const directTTFTs: number[] = [];
  const mediobotLatencies: number[] = [];

  for (let i = 1; i <= iterations; i++) {
    console.log(`--- Iteration ${i} of ${iterations} ---`);
    try {
      console.log("Running direct provider inference...");
      const direct = await runDirectInference("Hi");
      directLatencies.push(direct.totalMs);
      directTTFTs.push(direct.ttftMs);
      console.log(`Direct: total=${direct.totalMs}ms, ttft=${direct.ttftMs}ms`);

      const turnId = `bench-turn-${Date.now()}-${i}`;
      const threadId = `bench-thread-${Date.now()}`;
      console.log("Running MedioBot turn handler...");
      const mb = await runMediobotTurn("Hi", threadId, turnId);
      mediobotLatencies.push(mb.totalMs);
      console.log(`MedioBot: total=${mb.totalMs}ms, response="${mb.assistantText?.slice(0, 40)}..."`);

      const delta = Math.round((mb.totalMs - direct.totalMs) * 10) / 10;
      console.log(`Delta: ${delta}ms\n`);
    } catch (err) {
      console.error(`Iteration ${i} error:`, err);
    }
  }

  console.log("=== SUMMARY RESULTS ===");
  console.log(`Direct Provider:`);
  console.log(`  Median Latency: ${median(directLatencies)}ms`);
  console.log(`  P95 Latency:    ${percentile(directLatencies, 95)}ms`);
  console.log(`  Median TTFT:    ${median(directTTFTs)}ms`);
  console.log(`  P95 TTFT:       ${percentile(directTTFTs, 95)}ms`);
  console.log(`\nMedioBot V2 (with Capability-Aware Fast Path):`);
  console.log(`  Median Latency: ${median(mediobotLatencies)}ms`);
  console.log(`  P95 Latency:    ${percentile(mediobotLatencies, 95)}ms`);
  console.log(`\nOrchestration Overhead:`);
  console.log(`  Median Delta:   ${Math.round((median(mediobotLatencies) - median(directLatencies)) * 10) / 10}ms`);
  console.log(`  P95 Delta:      ${Math.round((percentile(mediobotLatencies, 95) - percentile(directLatencies, 95)) * 10) / 10}ms`);
}

main().catch(console.error);

import { startCommandCenter } from "../apps/command-center/src/server.ts";
import { getProductionDatabasePath } from "../apps/command-center/src/storage/appPaths.ts";
import { LocalDatabase } from "../apps/command-center/src/storage/db.ts";
import { ProviderRepository } from "../apps/command-center/src/storage/providerRepository.ts";

interface AuditMetric {
  threadId: string;
  turnId: string;
  providerId: string;
  modelId: string;
  httpAdmissionStatus: number;
  httpAdmissionMs: number;
  sseConnectedAt?: number;
  firstEventAt?: number;
  completedAt?: number;
  terminalState?: string;
  eventsReceived: string[];
  errorMessage?: string;
}

async function runLiveAudit() {
  process.env.MEDIOBOT_ALLOW_PROD_DB = "1";
  const prodDbPath = getProductionDatabasePath();
  console.log("================================================================================");
  console.log("MEDIOBOT V2 — STAGE 1A LIVE ACCEPTANCE AUDIT");
  console.log("Running against database:", prodDbPath);
  console.log("================================================================================\n");

  const db = new LocalDatabase(prodDbPath);
  const repo = new ProviderRepository(db.raw);
  const providers = repo.list();

  const dahl = providers.find((p) => p.id === "dahl" && p.connected && p.enabled);
  const nvidia = providers.find((p) => p.id === "nvidia" && p.connected && p.enabled);

  console.log("Live Provider Detection:");
  console.log(`- Dahl: ${dahl ? "AVAILABLE (" + dahl.models.map((m) => m.id).join(", ") + ")" : "NOT CONFIGURED"}`);
  console.log(`- NVIDIA: ${nvidia ? "AVAILABLE (" + nvidia.models.map((m) => m.id).join(", ") + ")" : "NOT CONFIGURED"}`);
  console.log("");

  const app = await startCommandCenter({
    databasePath: prodDbPath,
    vite: false,
    listen: true,
    port: 4173,
  });
  console.log(`Command Center server started at: ${app.url}\n`);

  const dahlModel = dahl?.models[0]?.id ?? "MiniMaxAI/MiniMax-M2.7";
  const nvidiaModel = nvidia?.models.find((m) => m.capabilities?.text || m.capabilities?.reasoning)?.id ?? "google/gemma-4-31b-it";

  // -------------------------------------------------------------------------
  // TEST 1: Two concurrent chats using different providers (Dahl vs NVIDIA)
  // -------------------------------------------------------------------------
  console.log("--- TEST 1: Two Concurrent Chats Using Different Providers ---");
  const threadDahl = `live-diff-dahl-${Date.now()}`;
  const turnDahl = `turn-dahl-1`;
  const threadNvidia = `live-diff-nvidia-${Date.now()}`;
  const turnNvidia = `turn-nvidia-1`;

  const t1_start = performance.now();

  const submitTurn = async (threadId: string, turnId: string, providerId: string, modelId: string, prompt: string) => {
    const t0 = performance.now();
    const res = await fetch(`${app.url}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        turnId,
        prompt,
        modelSelection: { providerConnectionId: providerId, modelId },
      }),
    });
    const t1 = performance.now();
    const json = await res.json();
    return {
      status: res.status,
      durationMs: Math.round(t1 - t0),
      json,
    };
  };

  const listenEvents = async (threadId: string, turnId: string, timeoutMs = 60_000) => {
    const events: Array<{ type: string; timestamp: number; payload?: any }> = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${app.url}/api/turns/${turnId}/events?threadId=${threadId}`, {
        signal: controller.signal,
      });
      const reader = res.body?.getReader();
      if (!reader) return events;
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        for (const line of text.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              events.push(data);
              if (["turn.completed", "turn.cancelled", "turn.failed"].includes(data.type)) {
                clearTimeout(timer);
                return events;
              }
            } catch {}
          }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        events.push({ type: "error", timestamp: Date.now(), payload: { error: e.message } });
      }
    } finally {
      clearTimeout(timer);
    }
    return events;
  };

  const [t1_dahl_sub, t1_nvidia_sub] = await Promise.all([
    submitTurn(threadDahl, turnDahl, "dahl", dahlModel, "Count from 1 to 3 and say DONE."),
    submitTurn(threadNvidia, turnNvidia, "nvidia", nvidiaModel, "Count from 1 to 3 and say DONE."),
  ]);

  console.log(`[HTTP Admission] Dahl: HTTP ${t1_dahl_sub.status} in ${t1_dahl_sub.durationMs}ms`);
  console.log(`[HTTP Admission] NVIDIA: HTTP ${t1_nvidia_sub.status} in ${t1_nvidia_sub.durationMs}ms`);

  const [t1_dahl_events, t1_nvidia_events] = await Promise.all([
    listenEvents(threadDahl, turnDahl),
    listenEvents(threadNvidia, turnNvidia),
  ]);

  console.log(`[SSE Stream] Dahl events: ${t1_dahl_events.map((e) => e.type).join(" -> ")}`);
  console.log(`[SSE Stream] NVIDIA events: ${t1_nvidia_events.map((e) => e.type).join(" -> ")}`);
  console.log(`Test 1 Total Wall Clock: ${Math.round(performance.now() - t1_start)}ms\n`);

  // -------------------------------------------------------------------------
  // TEST 2: Two chats using the SAME provider (Dahl + Dahl)
  // -------------------------------------------------------------------------
  console.log("--- TEST 2: Two Chats Using the SAME Provider (Dahl + Dahl) ---");
  const threadSame1 = `live-same-dahl1-${Date.now()}`;
  const turnSame1 = `turn-same-1`;
  const threadSame2 = `live-same-dahl2-${Date.now()}`;
  const turnSame2 = `turn-same-2`;

  const t2_start = performance.now();
  const [t2_sub1, t2_sub2] = await Promise.all([
    submitTurn(threadSame1, turnSame1, "dahl", dahlModel, "What is 2 + 2? Answer in one word."),
    submitTurn(threadSame2, turnSame2, "dahl", dahlModel, "What is 3 + 3? Answer in one word."),
  ]);

  console.log(`[HTTP Admission] Chat 1: HTTP ${t2_sub1.status} in ${t2_sub1.durationMs}ms`);
  console.log(`[HTTP Admission] Chat 2: HTTP ${t2_sub2.status} in ${t2_sub2.durationMs}ms`);

  const [t2_events1, t2_events2] = await Promise.all([
    listenEvents(threadSame1, turnSame1),
    listenEvents(threadSame2, turnSame2),
  ]);

  console.log(`[SSE Stream] Chat 1 events: ${t2_events1.map((e) => e.type).join(" -> ")}`);
  console.log(`[SSE Stream] Chat 2 events: ${t2_events2.map((e) => e.type).join(" -> ")}`);
  console.log(`Test 2 Total Wall Clock: ${Math.round(performance.now() - t2_start)}ms\n`);

  // -------------------------------------------------------------------------
  // TEST 3: Cancellation Isolation (Cancel Chat A while Chat B continues)
  // -------------------------------------------------------------------------
  console.log("--- TEST 3: Cancellation Isolation ---");
  const threadCancelA = `live-cancel-a-${Date.now()}`;
  const turnCancelA = `turn-cancel-a`;
  const threadKeepB = `live-keep-b-${Date.now()}`;
  const turnKeepB = `turn-keep-b`;

  const [t3_subA, t3_subB] = await Promise.all([
    submitTurn(threadCancelA, turnCancelA, "dahl", dahlModel, "Write a long 200 word essay on distributed computing theory."),
    submitTurn(threadKeepB, turnKeepB, "dahl", dahlModel, "What is 10 * 10?"),
  ]);

  console.log(`[HTTP Admission] Chat A (to cancel): HTTP ${t3_subA.status}`);
  console.log(`[HTTP Admission] Chat B (to keep): HTTP ${t3_subB.status}`);

  // Cancel Chat A after 100ms
  await new Promise((r) => setTimeout(r, 100));
  const cancelRes = await fetch(`${app.url}/api/turns/${turnCancelA}/cancel?threadId=${threadCancelA}`, { method: "POST" });
  console.log(`[Cancel Request] Cancel Chat A returned: HTTP ${cancelRes.status}`);

  const [t3_eventsA, t3_eventsB] = await Promise.all([
    listenEvents(threadCancelA, turnCancelA),
    listenEvents(threadKeepB, turnKeepB),
  ]);

  console.log(`[SSE Stream] Cancelled Chat A events: ${t3_eventsA.map((e) => e.type).join(" -> ")}`);
  console.log(`[SSE Stream] Kept Chat B events: ${t3_eventsB.map((e) => e.type).join(" -> ")}`);

  // Verify DB state
  const threadSavedA = await fetch(`${app.url}/api/threads/${threadCancelA}`).then((r) => r.json());
  const threadSavedB = await fetch(`${app.url}/api/threads/${threadKeepB}`).then((r) => r.json());
  console.log(`[Persistence] Chat A DB Status: ${threadSavedA.thread?.turns[0]?.status}`);
  console.log(`[Persistence] Chat B DB Status: ${threadSavedB.thread?.turns[0]?.status}\n`);

  // -------------------------------------------------------------------------
  // TEST 4: Refresh & Execution-State Reconciliation (SSE Reconnect + Restart)
  // -------------------------------------------------------------------------
  console.log("--- TEST 4: Refresh & Reconnection State Reconciliation ---");
  // Connect to an already completed turn (Chat B from Test 3)
  const reconnectEvents = await listenEvents(threadKeepB, turnKeepB);
  console.log(`[Reconnection] Replayed events for completed turn: ${reconnectEvents.map((e) => e.type).join(" -> ")}`);

  // -------------------------------------------------------------------------
  // TEST 5: Correct Per-Thread Model Routing
  // -------------------------------------------------------------------------
  console.log("\n--- TEST 5: Correct Per-Thread Model Routing ---");
  const threadRoute1 = await fetch(`${app.url}/api/threads/${threadDahl}`).then((r) => r.json());
  const threadRoute2 = await fetch(`${app.url}/api/threads/${threadNvidia}`).then((r) => r.json());
  console.log(`Thread Dahl routed model: ${JSON.stringify(threadRoute1.thread?.modelSelection)}`);
  console.log(`Thread NVIDIA routed model: ${JSON.stringify(threadRoute2.thread?.modelSelection)}\n`);

  // -------------------------------------------------------------------------
  // TEST 6: Provider Queue Admission and Release Status
  // -------------------------------------------------------------------------
  console.log("--- TEST 6: Provider Queue Admission & Release Status ---");
  const scheduler = (app as any).modelResolver?.getScheduler();
  if (scheduler) {
    console.log("Scheduler Status Dahl:", scheduler.getProviderStatus("dahl"));
    console.log("Scheduler Status NVIDIA:", scheduler.getProviderStatus("nvidia"));
    console.log("Dahl Limit:", scheduler.getConcurrencyLimit("dahl", "dahl"));
    console.log("NVIDIA Limit:", scheduler.getConcurrencyLimit("nvidia", "nvidia"));
  }

  // -------------------------------------------------------------------------
  // TEST 7: Token Streaming vs Completed Response Verification
  // -------------------------------------------------------------------------
  console.log("\n--- TEST 7: Token Streaming vs Completed Response Delivery ---");
  const streamingThread = `live-streaming-check-${Date.now()}`;
  const streamingTurn = `turn-stream-check`;
  await submitTurn(streamingThread, streamingTurn, "dahl", dahlModel, "Tell me a 20 word joke.");

  const streamEvents: Array<{ type: string; payloadSummary?: string }> = [];
  const streamRes = await fetch(`${app.url}/api/turns/${streamingTurn}/events?threadId=${streamingThread}`);
  const streamReader = streamRes.body?.getReader();
  if (streamReader) {
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await streamReader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            streamEvents.push({
              type: data.type,
              payloadSummary: data.payload?.item?.text ? data.payload.item.text.slice(0, 40) + "..." : undefined,
            });
            if (["turn.completed", "turn.failed"].includes(data.type)) break;
          } catch {}
        }
      }
    }
  }
  console.log("Stream events received during turn:", JSON.stringify(streamEvents, null, 2));

  await app.close();
  console.log("\n================================================================================");
  console.log("LIVE ACCEPTANCE AUDIT COMPLETE");
  console.log("================================================================================");
}

runLiveAudit().catch((err) => {
  console.error("FATAL AUDIT ERROR:", err);
  process.exit(1);
});

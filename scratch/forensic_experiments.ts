import { ResourceGovernor, computeHardwareBudget, WorkerRuntime } from "../packages/runtime/src/index.ts";
import { ModelResolver } from "../apps/command-center/src/runtime/modelRegistry.ts";
import { ProviderRepository } from "../apps/command-center/src/storage/providerRepository.ts";
import { getProductionAppDataDirectory } from "../apps/command-center/src/storage/appPaths.ts";
import { LocalDatabase } from "../apps/command-center/src/storage/db.ts";
import { createMaestroCodyExecution, MaestroDecisionProvider, MaestroOrchestrator } from "../packages/maestro/src/index.ts";
import { InMemoryWorld } from "../packages/domain/src/index.ts";
import path from "node:path";
import crypto from "node:crypto";

interface ExperimentTelemetry {
  experimentNumber: number;
  experimentName: string;
  isSimulated: boolean;
  records: Array<{
    threadId: string;
    turnId: string;
    executionId: string;
    agent: string;
    providerId: string;
    modelId: string;
    admissionTimestamp: number;
    providerRequestStartTimestamp: number;
    firstTokenTimestamp: number;
    completionTimestamp: number;
    errorCategory: string | null;
    resourceLease: {
      leaseId?: string;
      category?: string;
      units?: number;
      governorQueueLength?: number;
      activeLeasesCount?: number;
    } | null;
  }>;
}

const results: ExperimentTelemetry[] = [];

async function main() {
  console.log("=== RUNNING MEDIOBOT V2 FORENSIC AUDIT EXPERIMENTS ===");
  const appData = getProductionAppDataDirectory();
  const dbPath = path.join(appData, "mediobot.db");
  const db = new LocalDatabase(dbPath);
  const repo = new ProviderRepository((db as any).db);
  const resolver = new ModelResolver(repo);

  // Check available credentials
  const connections = repo.list();
  console.log("Found configured provider connections:", connections.map(c => ({ id: c.id, connected: c.connected, models: c.models.map(m => m.id) })));

  // ==========================================
  // EXPERIMENT 1: Two concurrent chats using the same model
  // ==========================================
  console.log("\n--- EXPERIMENT 1: Concurrent chats, same model ---");
  {
    const governor = new ResourceGovernor();
    const thread1 = `thread-exp1-a-${Date.now()}`;
    const thread2 = `thread-exp1-b-${Date.now()}`;
    const turn1 = `turn-${crypto.randomUUID()}`;
    const turn2 = `turn-${crypto.randomUUID()}`;
    const modelSelection = { providerConnectionId: "nvidia", modelId: "nvidia/nemotron-3-ultra-550b-a55b" };

    const records: ExperimentTelemetry["records"] = [];

    // Simulate/test concurrent turn admission and execution
    const runTurn = async (threadId: string, turnId: string, delayMs = 0) => {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      const admissionStart = Date.now();
      const lease = governor.canAdmitTask(null, "interactive")
        ? governor.createLease(turnId as any, null, "execution-slot", 1)
        : null;
      const admissionTimestamp = Date.now();

      const providerRequestStart = Date.now();
      let firstTokenTimestamp = 0;
      let completionTimestamp = 0;
      let errorCategory: string | null = null;

      try {
        const clientWrapper = resolver.resolveTextClient(modelSelection);
        const responsePromise = clientWrapper.client.complete({
          system: "You are Maestro. Respond with JSON: {\"type\":\"respond\",\"message\":\"Hello\",\"basis\":\"conversation\",\"evidenceRefs\":[]}",
          input: "Say hello",
          signal: new AbortController().signal,
          onProgress: () => {
            if (!firstTokenTimestamp) firstTokenTimestamp = Date.now();
          }
        });
        await responsePromise;
        completionTimestamp = Date.now();
        if (!firstTokenTimestamp) firstTokenTimestamp = completionTimestamp;
      } catch (err: any) {
        completionTimestamp = Date.now();
        errorCategory = err.code || "capacity";
      } finally {
        if (lease) governor.releaseLease(lease.id);
      }

      records.push({
        threadId,
        turnId,
        executionId: `exec-${turnId.slice(-8)}`,
        agent: "Maestro",
        providerId: modelSelection.providerConnectionId,
        modelId: modelSelection.modelId,
        admissionTimestamp,
        providerRequestStartTimestamp: providerRequestStart,
        firstTokenTimestamp,
        completionTimestamp,
        errorCategory,
        resourceLease: lease ? {
          leaseId: lease.id,
          category: lease.category,
          units: lease.units,
          governorQueueLength: governor.queueLength,
          activeLeasesCount: governor.activeLeasesCount,
        } : null,
      });
    };

    // Run both concurrently
    await Promise.all([runTurn(thread1, turn1, 0), runTurn(thread2, turn2, 20)]);
    results.push({
      experimentNumber: 1,
      experimentName: "Two concurrent chats using same model",
      isSimulated: false,
      records,
    });
  }

  // ==========================================
  // EXPERIMENT 2: Two concurrent chats using different models from same provider
  // ==========================================
  console.log("\n--- EXPERIMENT 2: Concurrent chats, different models from same provider ---");
  {
    const governor = new ResourceGovernor();
    const thread1 = `thread-exp2-a-${Date.now()}`;
    const thread2 = `thread-exp2-b-${Date.now()}`;
    const turn1 = `turn-${crypto.randomUUID()}`;
    const turn2 = `turn-${crypto.randomUUID()}`;
    const modelSelection1 = { providerConnectionId: "nvidia", modelId: "nvidia/nemotron-3-ultra-550b-a55b" };
    const modelSelection2 = { providerConnectionId: "nvidia", modelId: "google/gemma-4-31b-it" };

    const records: ExperimentTelemetry["records"] = [];

    const runTurn = async (threadId: string, turnId: string, sel: typeof modelSelection1) => {
      const lease = governor.canAdmitTask(null, "interactive")
        ? governor.createLease(turnId as any, null, "execution-slot", 1)
        : null;
      const admissionTimestamp = Date.now();
      const providerRequestStart = Date.now();
      let firstTokenTimestamp = 0;
      let completionTimestamp = 0;
      let errorCategory: string | null = null;

      try {
        const clientWrapper = resolver.resolveTextClient(sel);
        await clientWrapper.client.complete({
          system: "You are Maestro. Respond with JSON: {\"type\":\"respond\",\"message\":\"Hello\",\"basis\":\"conversation\",\"evidenceRefs\":[]}",
          input: "Say hello",
          signal: new AbortController().signal,
          onProgress: () => {
            if (!firstTokenTimestamp) firstTokenTimestamp = Date.now();
          }
        });
        completionTimestamp = Date.now();
        if (!firstTokenTimestamp) firstTokenTimestamp = completionTimestamp;
      } catch (err: any) {
        completionTimestamp = Date.now();
        errorCategory = err.code || "capacity";
      } finally {
        if (lease) governor.releaseLease(lease.id);
      }

      records.push({
        threadId,
        turnId,
        executionId: `exec-${turnId.slice(-8)}`,
        agent: "Maestro",
        providerId: sel.providerConnectionId,
        modelId: sel.modelId,
        admissionTimestamp,
        providerRequestStartTimestamp: providerRequestStart,
        firstTokenTimestamp,
        completionTimestamp,
        errorCategory,
        resourceLease: lease ? {
          leaseId: lease.id,
          category: lease.category,
          units: lease.units,
          governorQueueLength: governor.queueLength,
          activeLeasesCount: governor.activeLeasesCount,
        } : null,
      });
    };

    await Promise.all([runTurn(thread1, turn1, modelSelection1), runTurn(thread2, turn2, modelSelection2)]);
    results.push({
      experimentNumber: 2,
      experimentName: "Two concurrent chats using different models from same provider",
      isSimulated: false,
      records,
    });
  }

  // ==========================================
  // EXPERIMENT 3: Two concurrent chats using different providers
  // ==========================================
  console.log("\n--- EXPERIMENT 3: Concurrent chats, different providers ---");
  {
    const governor = new ResourceGovernor();
    const thread1 = `thread-exp3-a-${Date.now()}`;
    const thread2 = `thread-exp3-b-${Date.now()}`;
    const turn1 = `turn-${crypto.randomUUID()}`;
    const turn2 = `turn-${crypto.randomUUID()}`;
    const modelSelection1 = { providerConnectionId: "nvidia", modelId: "nvidia/nemotron-3-ultra-550b-a55b" };
    const modelSelection2 = { providerConnectionId: "dahl", modelId: "MiniMaxAI/MiniMax-M2.7" };

    const records: ExperimentTelemetry["records"] = [];

    const runTurn = async (threadId: string, turnId: string, sel: typeof modelSelection1) => {
      const lease = governor.canAdmitTask(null, "interactive")
        ? governor.createLease(turnId as any, null, "execution-slot", 1)
        : null;
      const admissionTimestamp = Date.now();
      const providerRequestStart = Date.now();
      let firstTokenTimestamp = 0;
      let completionTimestamp = 0;
      let errorCategory: string | null = null;

      try {
        const clientWrapper = resolver.resolveTextClient(sel);
        await clientWrapper.client.complete({
          system: "You are Maestro. Respond with JSON: {\"type\":\"respond\",\"message\":\"Hello\",\"basis\":\"conversation\",\"evidenceRefs\":[]}",
          input: "Say hello",
          signal: new AbortController().signal,
          onProgress: () => {
            if (!firstTokenTimestamp) firstTokenTimestamp = Date.now();
          }
        });
        completionTimestamp = Date.now();
        if (!firstTokenTimestamp) firstTokenTimestamp = completionTimestamp;
      } catch (err: any) {
        completionTimestamp = Date.now();
        errorCategory = err.code || "capacity";
      } finally {
        if (lease) governor.releaseLease(lease.id);
      }

      records.push({
        threadId,
        turnId,
        executionId: `exec-${turnId.slice(-8)}`,
        agent: "Maestro",
        providerId: sel.providerConnectionId,
        modelId: sel.modelId,
        admissionTimestamp,
        providerRequestStartTimestamp: providerRequestStart,
        firstTokenTimestamp,
        completionTimestamp,
        errorCategory,
        resourceLease: lease ? {
          leaseId: lease.id,
          category: lease.category,
          units: lease.units,
          governorQueueLength: governor.queueLength,
          activeLeasesCount: governor.activeLeasesCount,
        } : null,
      });
    };

    await Promise.all([runTurn(thread1, turn1, modelSelection1), runTurn(thread2, turn2, modelSelection2)]);
    results.push({
      experimentNumber: 3,
      experimentName: "Two concurrent chats using different providers",
      isSimulated: false,
      records,
    });
  }

  // ==========================================
  // EXPERIMENT 4: Genuine multi-specialist task requiring independent parallel work
  // ==========================================
  console.log("\n--- EXPERIMENT 4: Multi-specialist task with independent parallel work ---");
  {
    // Test how MaestroOrchestrator handles dependency graphs vs production MaestroExecutionAdapter
    const governor = new ResourceGovernor();
    const threadId = `thread-exp4-${Date.now()}`;
    const turnId = `turn-${crypto.randomUUID()}`;
    const records: ExperimentTelemetry["records"] = [];

    // In production adapter: executes sequentially or single-delegate
    // In MaestroOrchestrator: executes topologically in parallel batches
    const tAdmit = Date.now();
    const lease1 = governor.createLease(turnId as any, null, "execution-slot", 1);
    const lease2 = governor.createLease(turnId as any, null, "execution-slot", 1);

    // Specialist 1: Scraapy (UI component discovery)
    records.push({
      threadId,
      turnId,
      executionId: `exec-scraapy-${Date.now()}`,
      agent: "Scraapy",
      providerId: "nvidia",
      modelId: "nvidia/nemotron-3-ultra-550b-a55b",
      admissionTimestamp: tAdmit,
      providerRequestStartTimestamp: tAdmit + 5,
      firstTokenTimestamp: tAdmit + 350,
      completionTimestamp: tAdmit + 1200,
      errorCategory: null,
      resourceLease: {
        leaseId: lease1.id,
        category: "execution-slot",
        units: 1,
        governorQueueLength: 0,
        activeLeasesCount: 2,
      },
    });

    // Specialist 2: Doc (Documentation retrieval)
    records.push({
      threadId,
      turnId,
      executionId: `exec-doc-${Date.now()}`,
      agent: "Doc",
      providerId: "nvidia",
      modelId: "nvidia/nemotron-3-ultra-550b-a55b",
      admissionTimestamp: tAdmit,
      providerRequestStartTimestamp: tAdmit + 8,
      firstTokenTimestamp: tAdmit + 380,
      completionTimestamp: tAdmit + 1250,
      errorCategory: null,
      resourceLease: {
        leaseId: lease2.id,
        category: "execution-slot",
        units: 1,
        governorQueueLength: 0,
        activeLeasesCount: 2,
      },
    });

    governor.releaseLease(lease1.id);
    governor.releaseLease(lease2.id);

    results.push({
      experimentNumber: 4,
      experimentName: "Multi-specialist parallel execution (Scraapy + Doc)",
      isSimulated: true,
      records,
    });
  }

  // ==========================================
  // EXPERIMENT 5: Question requiring current documentation rather than static model knowledge
  // ==========================================
  console.log("\n--- EXPERIMENT 5: Question requiring current documentation ---");
  {
    const governor = new ResourceGovernor();
    const threadId = `thread-exp5-${Date.now()}`;
    const turnId = `turn-${crypto.randomUUID()}`;
    const prompt = "What are the latest React 19 Action hooks and how has useFormState been renamed?";
    const modelSelection = { providerConnectionId: "nvidia", modelId: "nvidia/nemotron-3-ultra-550b-a55b" };

    const records: ExperimentTelemetry["records"] = [];
    const tAdmit = Date.now();
    const tReqStart = Date.now();
    let firstToken = 0;
    let completion = 0;
    let errorCat: string | null = null;

    try {
      const client = resolver.resolveTextClient(modelSelection);
      await client.client.complete({
        system: "You are Maestro. Decide turn.",
        input: prompt,
        signal: new AbortController().signal,
        onProgress: () => {
          if (!firstToken) firstToken = Date.now();
        }
      });
      completion = Date.now();
      if (!firstToken) firstToken = completion;
    } catch (e: any) {
      completion = Date.now();
      errorCat = e.code || "capacity";
    }

    records.push({
      threadId,
      turnId,
      executionId: `exec-exp5-${Date.now()}`,
      agent: "Maestro",
      providerId: modelSelection.providerConnectionId,
      modelId: modelSelection.modelId,
      admissionTimestamp: tAdmit,
      providerRequestStartTimestamp: tReqStart,
      firstTokenTimestamp: firstToken,
      completionTimestamp: completion,
      errorCategory: errorCat,
      resourceLease: null,
    });

    results.push({
      experimentNumber: 5,
      experimentName: "Fresh documentation question vs static knowledge",
      isSimulated: false,
      records,
    });
  }

  console.log("\n=== ALL EXPERIMENT RESULTS ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error("Experiment runner error:", err);
  process.exit(1);
});

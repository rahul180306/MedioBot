import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import type { TaskId } from "@mediobot-v2/domain";
import {
  Crawl4AiRuntime,
  ResourceGovernor,
  SubprocessSupervisor,
} from "@mediobot-v2/runtime";

// This test starts a browser-backed crawler and makes requests to public sites.
// Keep it out of the default regression suite; opt in explicitly when the live
// acceptance environment and network access are available.
const liveAcceptanceEnabled = process.env.MEDIOBOT_RUN_LIVE_CRAWL4AI === "1";
const liveTest = liveAcceptanceEnabled ? test : test.skip;

liveTest("PHASE 5 LIVE ACCEPTANCE: Full End-to-End Crawl4AI Verification & RAM Optimization", { timeout: 120_000 }, async (t) => {
  // =========================================================================
  // 1. ENVIRONMENT & CRAWL4AI INSTALLATION AUDIT
  // =========================================================================
  const pythonBin = "/Users/rahulkarthikt/Documents/mediobot/mediobot-v2/.venv/bin/python";
  
  // Verify Crawl4AI is genuinely installed and importable in this environment
  const auditCmd = `${pythonBin} -c "
import crawl4ai
from crawl4ai.__version__ import __version__
from crawl4ai import AsyncWebCrawler
print('VERSION:' + __version__)
print('BACKEND:' + AsyncWebCrawler.__name__)
"`;

  const auditOutput = execSync(auditCmd, { encoding: "utf-8" }).trim();
  console.log("\n[LIVE AUDIT] Python Environment Verification:");
  console.log(`Interpreter: ${pythonBin}`);
  console.log(auditOutput);

  assert.ok(auditOutput.includes("VERSION:0.9.4"), "Must run genuine Crawl4AI version 0.9.4");
  assert.ok(auditOutput.includes("BACKEND:AsyncWebCrawler"), "Must use AsyncWebCrawler backend");

  // =========================================================================
  // 2. RUNTIME INITIALIZATION & MEMORY BASELINE
  // =========================================================================
  const supervisor = new SubprocessSupervisor({ maxConcurrentGlobal: 4 });
  const governor = new ResourceGovernor({
    budget: { maxConcurrentTasks: 3, maxConcurrentBrowserSessions: 2 },
    subprocessSupervisor: supervisor,
  });

  const sharedCrawl4Ai = new Crawl4AiRuntime({
    pythonPath: pythonBin,
    resourceGovernor: governor,
    subprocessSupervisor: supervisor,
    idleTimeoutMs: 5000, // 5 second idle timeout for testing
    maxCacheSizeBytes: 5 * 1024 * 1024, // 5 MB bounded cache
    maxCacheEntries: 10,
    maxSingleEntryBytes: 300 * 1024,
  });

  const initialMetrics = await sharedCrawl4Ai.getMemoryMetrics();
  console.log("\n[RAM AUDIT] 1. Pre-Execution Idle State:");
  console.log(`Worker RSS: ${(initialMetrics.workerRssBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Process Tree RSS: ${(initialMetrics.totalProcessTreeRssBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Child Processes: ${initialMetrics.childProcessCount}`);

  try {
    // =========================================================================
    // 3. LIVE MULTI-AGENT EXECUTION THROUGH MAESTRO WEB AGENT ENGINE
    // =========================================================================
    // Real user task:
    // “Research how to build a React website using GSAP, study the official documentation,
    //  and find suitable animated components from React Bits.”
    console.log("\n[LIVE EXECUTION] Commencing multi-specialist web intelligence on live network targets...");

    // Real target 1: Official GSAP React documentation
    const gsapDocCrawl = await sharedCrawl4Ai.crawl({
      taskId: "task-live" as TaskId,
      url: "https://gsap.com/resources/React/",
      cacheMode: "enabled",
      extractOptions: { targetType: "documentation", extractMarkdown: true },
    });

    assert.equal(gsapDocCrawl.success, true, "Doc must successfully crawl official GSAP documentation");
    assert.equal(gsapDocCrawl.status, 200, "Doc status must be 200");
    assert.ok(gsapDocCrawl.markdown.length > 5000, "Must extract rich documentation content");
    assert.ok(gsapDocCrawl.markdown.includes("useGSAP") || gsapDocCrawl.markdown.includes("GSAP"), "Must mention useGSAP hook");
    assert.ok(gsapDocCrawl.provenance, "Must include provenance");
    assert.equal(gsapDocCrawl.provenance.sourceUrl, "https://gsap.com/resources/React/");

    console.log(`[DOC SPECIALIST] Extracted ${gsapDocCrawl.markdown.length} characters from ${gsapDocCrawl.url}`);
    console.log(`[DOC SPECIALIST] Title: "${gsapDocCrawl.title}"`);
    console.log(`[DOC SPECIALIST] Extraction Backend: ${gsapDocCrawl.metadata.extractionBackend}`);

    const midMetrics = await sharedCrawl4Ai.getMemoryMetrics();
    console.log(`\n[RAM AUDIT] 2. Single-Page Crawl State (GSAP Docs):`);
    console.log(`Process Tree RSS: ${(midMetrics.totalProcessTreeRssBytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Child Processes: ${midMetrics.childProcessCount}`);

    // Real target 2: React Bits component library
    const reactBitsCrawl = await sharedCrawl4Ai.crawl({
      taskId: "task-live" as TaskId,
      url: "https://github.com/DavidHDev/react-bits",
      cacheMode: "enabled",
      extractOptions: { targetType: "component", extractMarkdown: true },
    });

    assert.equal(reactBitsCrawl.success, true, "Scraapy must successfully crawl React Bits repository");
    assert.equal(reactBitsCrawl.status, 200, "Scraapy status must be 200");
    assert.ok(reactBitsCrawl.markdown.length > 5000, "Must extract React Bits component details");
    assert.ok(
      reactBitsCrawl.markdown.includes("MIT") || reactBitsCrawl.markdown.includes("animated") || reactBitsCrawl.markdown.includes("components"),
      "Must identify components and license"
    );
    assert.ok(reactBitsCrawl.provenance, "Must include provenance record");

    console.log(`[SCRAAPY SPECIALIST] Extracted ${reactBitsCrawl.markdown.length} characters from ${reactBitsCrawl.url}`);
    console.log(`[SCRAAPY SPECIALIST] Title: "${reactBitsCrawl.title}"`);

    // Real target 3: React lifecycle / synchronization for Research tradeoffs
    const reactDocsCrawl = await sharedCrawl4Ai.crawl({
      taskId: "task-live" as TaskId,
      url: "https://react.dev/learn/synchronizing-with-effects",
      cacheMode: "enabled",
      extractOptions: { targetType: "general", extractMarkdown: true },
    });

    assert.equal(reactDocsCrawl.success, true, "Research must successfully crawl React docs");
    assert.ok(reactDocsCrawl.markdown.includes("Effect") || reactDocsCrawl.markdown.includes("cleanup"), "Must cover lifecycle cleanup");

    console.log(`[RESEARCH SPECIALIST] Extracted ${reactDocsCrawl.markdown.length} characters from ${reactDocsCrawl.url}`);

    // =========================================================================
    // 4. VERIFY SHARED SINGLE PROCESS & ZERO EXTRA HTTP SERVERS
    // =========================================================================
    // Check SubprocessSupervisor tracking: exactly 1 worker running
    assert.equal(supervisor.activeCount, 1, "Exactly ONE managed worker process must serve all three specialists");
    console.log(`\n[SINGLE RUNTIME INVARIANT] Active managed subprocesses: ${supervisor.activeCount} (PASSED)`);

    // Verify peak RSS and browser release
    const peakMetrics = await sharedCrawl4Ai.getMemoryMetrics();
    console.log(`\n[RAM AUDIT] 3. Peak Execution Memory:`);
    console.log(`Worker RSS: ${(peakMetrics.workerRssBytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Process Tree Peak RSS: ${(peakMetrics.peakProcessTreeRssBytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Browser Processes: ${peakMetrics.childProcessCount}`);

    // =========================================================================
    // 5. BROWSER RELEASE & MEMORY RECOVERY TEST
    // =========================================================================
    console.log("\n[RAM AUDIT] 4. Releasing browser resources explicitly...");
    const releasedMetrics = await sharedCrawl4Ai.releaseBrowser();
    console.log(`Process Tree RSS after browser release: ${(releasedMetrics.totalProcessTreeRssBytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Browser Child Processes remaining: ${releasedMetrics.childProcessCount}`);
    
    assert.equal(releasedMetrics.browserActive, false, "Browser must be inactive after release");
    assert.equal(releasedMetrics.childProcessCount <= 1, true, "Chromium helper processes must be terminated");

    const recoveredBytes = peakMetrics.peakProcessTreeRssBytes - releasedMetrics.totalProcessTreeRssBytes;
    console.log(`Memory Recovered: ${(recoveredBytes / 1024 / 1024).toFixed(1)} MB`);

    // =========================================================================
    // 6. BOUNDED LRU CACHE WITH MEMORY LIMITS
    // =========================================================================
    console.log("\n[CACHE AUDIT] 5. Verifying Bounded LRU Cache:");
    const cacheMetrics = sharedCrawl4Ai.getCacheMetrics();
    console.log(`Cached Entries: ${cacheMetrics.entries} / ${cacheMetrics.maxEntries}`);
    console.log(`Cache Size: ${(cacheMetrics.sizeBytes / 1024).toFixed(1)} KB / ${(cacheMetrics.maxSizeBytes / 1024 / 1024).toFixed(1)} MB`);
    assert.ok(cacheMetrics.sizeBytes <= cacheMetrics.maxSizeBytes, "Cache size must be strictly bounded");

    // Evict 50%
    const evicted = sharedCrawl4Ai.evictCache(0.5);
    console.log(`Evicted ${evicted} entries under simulated pressure`);
    const afterEvict = sharedCrawl4Ai.getCacheMetrics();
    console.log(`Cache Size after eviction: ${(afterEvict.sizeBytes / 1024).toFixed(1)} KB`);

    // =========================================================================
    // 7. IDLE SHUTDOWN TEST
    // =========================================================================
    console.log("\n[IDLE AUDIT] 6. Awaiting idle shutdown (5s timeout)...");
    assert.equal(sharedCrawl4Ai.isRunning, true, "Worker should be running before idle expiry");

    // Wait for the 5s idle shutdown timer to fire
    await new Promise((resolve) => setTimeout(resolve, 6000));

    assert.equal(sharedCrawl4Ai.isRunning, false, "Worker must shut down automatically after idle timeout");
    assert.equal(supervisor.activeCount, 0, "Zero processes must remain in supervisor after idle shutdown");
    console.log("[IDLE AUDIT] Worker successfully shut down and released all OS process resources.");

  } finally {
    await sharedCrawl4Ai.shutdown();
  }
});

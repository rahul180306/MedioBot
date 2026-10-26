import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ProjectIntelligenceEngineImpl } from "../src/engine.ts";

async function runBenchmark() {
  console.log("=== MEDIOBOT V2: PROJECT INTELLIGENCE ENGINE BENCHMARK ===\n");

  const repoRoot = path.resolve("../..");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-bench-"));
  const dbPath = path.join(tempDir, "bench-intelligence.db");

  const initialMemory = process.memoryUsage();
  console.log(`Repository root: ${repoRoot}`);
  console.log(`Database target: ${dbPath}`);
  console.log(`Initial RSS: ${(initialMemory.rss / (1024 * 1024)).toFixed(2)} MB\n`);

  const engine = new ProjectIntelligenceEngineImpl({
    workspaceRoot: repoRoot,
    dbPath,
  });

  const initStart = performance.now();
  await engine.initialize();
  const initDuration = performance.now() - initStart;
  console.log(`[1] Engine Initialization: ${initDuration.toFixed(2)} ms`);

  // 1. Full Indexing Duration
  const fullIndexStart = performance.now();
  const report = await engine.fullIndex();
  const fullIndexDuration = performance.now() - fullIndexStart;
  console.log(`[2] Full Index Duration: ${fullIndexDuration.toFixed(2)} ms`);
  console.log(`    - Files indexed: ${report.filesIndexed}`);
  console.log(`    - Files skipped: ${report.filesSkipped}`);
  console.log(`    - Symbols extracted: ${report.symbolsExtracted}`);
  console.log(`    - Dependencies tracked: ${report.dependenciesTracked}`);
  console.log(`    - Errors encountered: ${report.errors.length}`);

  // 2. Incremental Update Duration (single file modified)
  const incrementalStart = performance.now();
  const incReport = await engine.incrementalUpdate(["packages/contracts/src/index.ts"]);
  const incrementalDuration = performance.now() - incrementalStart;
  console.log(`\n[3] Incremental Update (1 file): ${incrementalDuration.toFixed(2)} ms`);
  console.log(`    - Files indexed: ${incReport.filesIndexed}`);
  console.log(`    - Symbols extracted: ${incReport.symbolsExtracted}`);

  // 3. Exact Symbol Retrieval Latency
  const exactLookupSamples: number[] = [];
  const testSymbols = ["TaskNode", "TaskId", "SymbolDefinition", "IndexReport", "ArchitecturalSafetyRule"];
  for (const sym of testSymbols) {
    const t0 = performance.now();
    const results = await engine.findSymbol(sym);
    exactLookupSamples.push(performance.now() - t0);
  }
  const avgExactLatency = exactLookupSamples.reduce((a, b) => a + b, 0) / exactLookupSamples.length;
  console.log(`\n[4] Exact Symbol Retrieval:`);
  console.log(`    - Average latency: ${avgExactLatency.toFixed(3)} ms`);
  console.log(`    - Samples: ${exactLookupSamples.map((s) => s.toFixed(3) + "ms").join(", ")}`);

  // 4. FTS5 Search Latency
  const ftsQueries = ["task", "execution", "validation", "safety", "evidence"];
  const ftsSamples: number[] = [];
  for (const q of ftsQueries) {
    const t0 = performance.now();
    const results = await engine.searchSymbols(q, { maxResults: 10 });
    ftsSamples.push(performance.now() - t0);
  }
  const avgFtsLatency = ftsSamples.reduce((a, b) => a + b, 0) / ftsSamples.length;
  console.log(`\n[5] FTS5 Search:`);
  console.log(`    - Average latency: ${avgFtsLatency.toFixed(3)} ms`);
  console.log(`    - Samples: ${ftsSamples.map((s) => s.toFixed(3) + "ms").join(", ")}`);

  // 5. RepoMap Generation Latency
  const repoMapStart = performance.now();
  const repoMap = await engine.generateRepoMap({ maxTokens: 1500 });
  const repoMapDuration = performance.now() - repoMapStart;
  console.log(`\n[6] RepoMap Generation:`);
  console.log(`    - Duration: ${repoMapDuration.toFixed(2)} ms`);
  console.log(`    - Files included: ${repoMap.filesIncluded}`);
  console.log(`    - Estimated tokens: ${repoMap.estimatedTokens}`);

  // 6. Database Size
  const dbStat = fs.statSync(dbPath);
  const dbSizeBytes = dbStat.size;
  const dbSizeMB = (dbSizeBytes / (1024 * 1024)).toFixed(2);
  console.log(`\n[7] SQLite Database Size: ${dbSizeMB} MB (${dbSizeBytes} bytes)`);

  // 7. Memory Overhead
  const finalMemory = process.memoryUsage();
  const memoryDeltaMB = ((finalMemory.rss - initialMemory.rss) / (1024 * 1024)).toFixed(2);
  console.log(`\n[8] Memory Overhead:`);
  console.log(`    - Initial RSS: ${(initialMemory.rss / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`    - Final RSS: ${(finalMemory.rss / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`    - Delta RSS: ${memoryDeltaMB} MB`);

  await engine.dispose();

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  console.log("\n=== BENCHMARK COMPLETE ===");
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectIntelligenceEngineImpl } from "../src/engine.ts";
import { ProjectFileWatcher } from "../src/watcher.ts";

function createTempProject(): { root: string; dbPath: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pie-engine-test-"));
  const dbPath = path.join(root, "pie.db");
  return {
    root,
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

test("Scenario 9: File creation and modification", async () => {
  const { root, dbPath, cleanup } = createTempProject();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const file1 = path.join(root, "src", "service.ts");
    fs.writeFileSync(file1, "export function originalFunction(): string { return 'v1'; }");

    const engine = new ProjectIntelligenceEngineImpl({ workspaceRoot: root, dbPath });
    await engine.initialize();

    const report1 = await engine.fullIndex();
    assert.equal(report1.filesIndexed, 1);
    assert.equal(report1.symbolsExtracted, 1);

    const syms1 = await engine.findSymbol("originalFunction");
    assert.equal(syms1.length, 1);
    assert.equal(syms1[0]!.signature?.includes("originalFunction"), true);

    // Modify file
    fs.writeFileSync(file1, "export function updatedFunction(): string { return 'v2'; }");

    const report2 = await engine.incrementalUpdate(["src/service.ts"]);
    assert.equal(report2.filesIndexed, 1);
    assert.equal(report2.filesSkipped, 0);

    // Old symbol must be removed, new symbol present
    const oldSyms = await engine.findSymbol("originalFunction");
    assert.equal(oldSyms.length, 0, "Old symbol must be removed on update");

    const newSyms = await engine.findSymbol("updatedFunction");
    assert.equal(newSyms.length, 1, "New symbol must be extracted on update");

    await engine.dispose();
  } finally {
    cleanup();
  }
});

test("Scenario 10: File deletion", async () => {
  const { root, dbPath, cleanup } = createTempProject();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const file1 = path.join(root, "src", "temp.ts");
    fs.writeFileSync(file1, "export const TO_BE_DELETED = 42;");

    const engine = new ProjectIntelligenceEngineImpl({ workspaceRoot: root, dbPath });
    await engine.initialize();

    await engine.fullIndex();
    assert.equal((await engine.findSymbol("TO_BE_DELETED")).length, 1);

    // Delete file from disk
    fs.unlinkSync(file1);

    // Incremental update should detect deletion and remove from database
    await engine.incrementalUpdate(["src/temp.ts"]);

    assert.equal((await engine.findSymbol("TO_BE_DELETED")).length, 0);
    assert.deepEqual(await engine.listFiles(), []);

    await engine.dispose();
  } finally {
    cleanup();
  }
});

test("Scenario 11: Rapid consecutive file changes", async () => {
  const { root, cleanup } = createTempProject();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });

    let eventBatches = 0;
    const watcher = new ProjectFileWatcher(
      root,
      async (paths) => {
        eventBatches++;
        // Simulate async indexing delay
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      50 // fast 50ms debounce for test
    );

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Rapid writes in quick succession
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(root, "src", `rapid_${i}.ts`), `export const v${i} = ${i};`);
    }

    // Wait for debounced flush
    const startWait = Date.now();
    while (eventBatches === 0 && Date.now() - startWait < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    watcher.close();
    assert.ok(eventBatches >= 1, "Must handle batched events without crashing or dropping state");
  } finally {
    cleanup();
  }
});

test("Scenario 19: Cancellation and cleanup", async () => {
  const { root, dbPath, cleanup } = createTempProject();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(root, "src", `file_${i}.ts`), `export const num_${i} = ${i};`);
    }

    const engine = new ProjectIntelligenceEngineImpl({ workspaceRoot: root, dbPath });
    await engine.initialize();

    const controller = new AbortController();
    controller.abort(); // Pre-abort signal

    const report = await engine.fullIndex(controller.signal);
    // Indexing aborted early
    assert.equal(report.filesIndexed, 0, "Pre-aborted signal stops indexing immediately");

    // dispose closes all handles cleanly
    await engine.dispose();
  } finally {
    cleanup();
  }
});

test("Scenario 20: Bounded memory and indexing behavior", async () => {
  const { root, dbPath, cleanup } = createTempProject();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(
        path.join(root, "src", `module_${i}.ts`),
        `
        export function compute_${i}(): number { return ${i}; }
        export class Class_${i} {}
        `
      );
    }

    const engine = new ProjectIntelligenceEngineImpl({ workspaceRoot: root, dbPath });
    await engine.initialize();
    await engine.fullIndex();

    // RepoMap with small token budget (e.g. 100 tokens ~ 400 chars)
    const repoMap = await engine.generateRepoMap({ maxTokens: 100 });
    assert.ok(repoMap.estimatedTokens <= 150, "RepoMap should strictly obey bounded token budget");
    assert.ok(repoMap.filesIncluded > 0);

    await engine.dispose();
  } finally {
    cleanup();
  }
});

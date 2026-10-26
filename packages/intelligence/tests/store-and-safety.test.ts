import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteStore } from "../src/store.ts";

function createTempDb(): { dbPath: string; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-store-test-"));
  const dbPath = path.join(dir, "test-intelligence.db");
  return {
    dbPath,
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

test("Scenario 5: Duplicate symbol names in different files", () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const store = new SqliteStore({ dbPath });
    store.init();

    const fileA = store.upsertFile({
      path: "src/moduleA.ts",
      language: "typescript",
      contentHash: "hash-a",
      sizeBytes: 100,
      lineCount: 10,
      indexedAt: Date.now(),
      isTest: false,
      isConfig: false,
    });

    const fileB = store.upsertFile({
      path: "src/moduleB.ts",
      language: "typescript",
      contentHash: "hash-b",
      sizeBytes: 120,
      lineCount: 12,
      indexedAt: Date.now(),
      isTest: false,
      isConfig: false,
    });

    // Both files define "runTask"
    store.insertSymbols(fileA, [
      {
        name: "runTask",
        kind: "function",
        filePath: "src/moduleA.ts",
        startLine: 5,
        endLine: 8,
        character: 0,
        signature: "(task: string): void",
        isExported: true,
      },
    ]);

    store.insertSymbols(fileB, [
      {
        name: "runTask",
        kind: "function",
        filePath: "src/moduleB.ts",
        startLine: 10,
        endLine: 15,
        character: 0,
        signature: "(options: object): Promise<boolean>",
        isExported: true,
      },
    ]);

    const results = store.findSymbol("runTask");
    assert.equal(results.length, 2, "Must return both symbols with duplicate names");
    assert.ok(results.some((r) => r.filePath === "src/moduleA.ts"));
    assert.ok(results.some((r) => r.filePath === "src/moduleB.ts"));

    store.close();
  } finally {
    cleanup();
  }
});

test("Scenario 7: Empty projects", () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const store = new SqliteStore({ dbPath });
    store.init();

    assert.deepEqual(store.listFiles(), []);
    assert.deepEqual(store.searchSymbols("anything"), []);
    assert.deepEqual(store.findSymbol("nonexistent"), []);

    const meta = store.getProjectMetadata();
    assert.equal(meta.totalFiles, 0);
    assert.equal(meta.totalSymbols, 0);

    store.close();
  } finally {
    cleanup();
  }
});

test("Scenario 12: Index persistence across restarts", () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    // Session 1: Create and write
    const store1 = new SqliteStore({ dbPath });
    store1.init();

    const fileId = store1.upsertFile({
      path: "src/persisted.ts",
      language: "typescript",
      contentHash: "hash-persisted",
      sizeBytes: 250,
      lineCount: 20,
      indexedAt: 1234567,
      isTest: false,
      isConfig: false,
    });

    store1.insertSymbols(fileId, [
      {
        name: "PersistedService",
        kind: "class",
        filePath: "src/persisted.ts",
        startLine: 1,
        endLine: 20,
        character: 0,
        signature: "class PersistedService",
        isExported: true,
      },
    ]);

    store1.close();

    // Session 2: Reopen same database
    const store2 = new SqliteStore({ dbPath });
    store2.init();

    const file = store2.getFile("src/persisted.ts");
    assert.ok(file, "File must persist across restart");
    assert.equal(file.contentHash, "hash-persisted");

    const symbols = store2.findSymbol("PersistedService");
    assert.equal(symbols.length, 1, "Symbol must persist across restart");
    assert.equal(symbols[0]!.name, "PersistedService");

    // FTS search must also persist
    const ftsResults = store2.searchSymbols("PersistedService");
    assert.equal(ftsResults.length, 1, "FTS5 index must persist across restart");

    store2.close();
  } finally {
    cleanup();
  }
});

test("Scenario 13: Workspace separation", () => {
  const ws1 = createTempDb();
  const ws2 = createTempDb();
  try {
    const store1 = new SqliteStore({ dbPath: ws1.dbPath });
    store1.init();

    const store2 = new SqliteStore({ dbPath: ws2.dbPath });
    store2.init();

    const id1 = store1.upsertFile({
      path: "src/secret1.ts",
      language: "typescript",
      contentHash: "h1",
      sizeBytes: 10,
      lineCount: 2,
      indexedAt: Date.now(),
      isTest: false,
      isConfig: false,
    });
    store1.insertSymbols(id1, [
      {
        name: "Workspace1Symbol",
        kind: "constant",
        filePath: "src/secret1.ts",
        startLine: 1,
        endLine: 1,
        character: 0,
        isExported: true,
      },
    ]);

    // Query store2 — must NOT have Workspace1Symbol
    assert.equal(store2.findSymbol("Workspace1Symbol").length, 0);
    assert.deepEqual(store2.listFiles(), []);

    store1.close();
    store2.close();
  } finally {
    ws1.cleanup();
    ws2.cleanup();
  }
});

test("Scenario 16: Database corruption handling and quarantine", () => {
  const { dbPath, dir, cleanup } = createTempDb();
  try {
    // 1. Create a valid store first
    const store1 = new SqliteStore({ dbPath });
    store1.init();
    store1.close();

    // 2. Corrupt the database file by writing junk bytes
    fs.writeFileSync(dbPath, "NOT A VALID SQLITE DATABASE FILE HEADER JUNK BYTES 1234567890");

    // 3. Opening corrupted database must quarantine the corrupt file and recreate fresh DB
    const store2 = new SqliteStore({ dbPath });
    store2.init(); // Must NOT throw!

    // Check that a quarantined file was created and original was NOT deleted
    const filesInDir = fs.readdirSync(dir);
    const quarantined = filesInDir.filter((f) => f.includes(".corrupt-"));
    assert.ok(quarantined.length >= 1, "Must quarantine corrupt database to .corrupt-<timestamp>");

    // Verify fresh store is functional
    assert.deepEqual(store2.listFiles(), []);
    const newId = store2.upsertFile({
      path: "src/fresh.ts",
      language: "typescript",
      contentHash: "fresh-hash",
      sizeBytes: 10,
      lineCount: 1,
      indexedAt: Date.now(),
      isTest: false,
      isConfig: false,
    });
    assert.ok(newId > 0);

    store2.close();
  } finally {
    cleanup();
  }
});

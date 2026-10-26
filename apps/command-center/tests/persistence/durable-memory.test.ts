import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { startCommandCenter } from "../../src/server.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";
import { DurableTaskEngine } from "@mediobot-v2/runtime";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";

class ResponseCapture extends Writable {
  statusCode = 200;
  output = "";
  writeHead(status: number) { this.statusCode = status; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { this.output += chunk.toString(); callback(); }
}

test("verified evidence retrieval is relevant, bounded, and isolated by workspace or thread", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-memory-"));
  const databasePath = path.join(root, "mediobot.db");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let database = new LocalDatabase(databasePath);
  let engine = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
  try {
    await engine.submitTask({ id: "memory-source-a", workspaceId: "project-a", threadId: "thread-a", goal: "Check prime function", definitionId: "cody" });
    await engine.recordEvidence("memory-source-a", { kind: "test-result", source: { type: "terminal", reference: "pytest" },
      claim: "Prime checker handles negative integers", content: "Verified: negative integers and values below two return false.", validity: "verified" });
    await engine.recordEvidence("memory-source-a", { kind: "observation", source: { type: "terminal", reference: "pytest" },
      claim: "Unverified prime guess", content: "Prime checker may handle negative integers.", validity: "observed" });
    await engine.submitTask({ id: "memory-source-b", workspaceId: "project-b", threadId: "thread-b", goal: "Same query in another project", definitionId: "cody" });
    await engine.recordEvidence("memory-source-b", { kind: "test-result", source: { type: "terminal", reference: "pytest" },
      claim: "Other project's prime checker", content: "Verified in a separate project.", validity: "verified" });
    await engine.submitTask({ id: "memory-current", workspaceId: "project-a", threadId: "thread-current", goal: "Review prime checker", definitionId: "cody" });

    const matches = await engine.searchVerifiedEvidence("project-a", "thread-current", "memory-current", "prime checker negative integers", 99);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.taskId, "memory-source-a");
    assert.equal(matches[0]?.validity, "verified");
    assert.equal(matches[0]?.claim, "Prime checker handles negative integers");
    assert.deepEqual(await engine.searchVerifiedEvidence("project-a", "thread-current", "memory-current", "unrelated phrase", 3), []);

    await engine.submitTask({ id: "private-source", workspaceId: null, threadId: "private-thread-a", goal: "private evidence", definitionId: "cody" });
    await engine.recordEvidence("private-source", { kind: "test-result", source: { type: "terminal", reference: "pytest" },
      claim: "Private thread fact", content: "Verified private-thread result.", validity: "verified" });
    await engine.submitTask({ id: "private-current", workspaceId: null, threadId: "private-thread-b", goal: "other private thread", definitionId: "cody" });
    assert.deepEqual(await engine.searchVerifiedEvidence(null, "private-thread-b", "private-current", "private thread fact", 3), []);
  } finally { database.close(); }

  // Simulate opening an existing v15 database: the additive migration must index
  // prior evidence without changing its task or provenance records.
  database = new LocalDatabase(databasePath);
  engine = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
  const priorEvidence = await engine.getEvidence("memory-source-a");
  database.raw.exec(`DROP TRIGGER durable_task_evidence_fts_insert;
    DROP TRIGGER durable_task_evidence_fts_delete;
    DROP TRIGGER durable_task_evidence_fts_update;
    DROP TABLE durable_task_evidence_fts;
    DROP TABLE runtime_world_identity;
    DELETE FROM schema_migrations WHERE version >= 16;`);
  database.close();

  database = new LocalDatabase(databasePath);
  try {
    assert.equal(database.currentSchemaVersion, 18);
    const restored = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
    assert.deepEqual(await restored.getEvidence("memory-source-a"), priorEvidence);
    const matches = await restored.searchVerifiedEvidence("project-a", "thread-current", "memory-current", "prime checker negative integers", 3);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.id, priorEvidence[0]?.id);
  } finally { database.close(); }
});

test("normal /api/turns injects bounded verified project evidence and excludes unverified evidence", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-memory-turn-"));
  const databasePath = path.join(root, "mediobot.db");
  const database = new LocalDatabase(databasePath);
  const repo = new ProviderRepository(database.raw);
  repo.save({ id: "memory-provider", providerType: "custom", displayName: "Memory fixture", connected: true, enabled: true,
    baseUrl: "http://unused.invalid", models: [{ id: "memory-model", name: "Fixture", enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: false } }] });
  let seen: Record<string, unknown> | undefined;
  const resolver = new ModelResolver(repo, { createClient: () => ({ complete: async ({ system, input }) => {
    if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
    seen = JSON.parse(input);
    const evidence = seen.relevantEvidence as Array<{ id: string; content: string }>;
    const matching = evidence.find(record => record.content.includes("0 and 1 are not prime numbers"));
    assert.ok(matching, "verified retrieval must be exposed through the evidence contract");
    return JSON.stringify({ type: "respond", message: "The verified project evidence supports the answer.", basis: "project-evidence", evidenceRefs: [matching.id] });
  } }) });
  const app = await startCommandCenter({ databasePath, providerRepository: repo, modelResolver: resolver,
    workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  const workspaceId = app.workspaceManager.session!.workspaceId;
  const engine = app.composition.durableTaskEngine!;
  await engine.submitTask({ id: "memory-turn-source", workspaceId, threadId: "source-thread", goal: "verify prime number function", definitionId: "cody" });
  const verifiedEvidence = await engine.recordEvidence("memory-turn-source", { kind: "test-result", source: { type: "terminal", reference: "pytest" },
    claim: "Prime number edge cases verified", content: "Verified: 0 and 1 are not prime numbers.", validity: "verified" });
  await engine.recordEvidence("memory-turn-source", { kind: "observation", source: { type: "model", reference: "prior-turn" },
    claim: "Unverified prime number guess", content: "Maybe 1 is prime.", validity: "observed" });
  const request = Object.assign(Readable.from([JSON.stringify({ threadId: "memory-current-thread", turnId: "memory-current-turn",
    prompt: "Explain prime number edge cases", modelSelection: { providerConnectionId: "memory-provider", modelId: "memory-model" } })]),
    { method: "POST", url: "/api/turns", headers: {} });
  const response = new ResponseCapture();
  await new Promise<void>(resolve => { response.once("finish", resolve); app.handle(request as never, response as never); });
  assert.ok([200, 202].includes(response.statusCode));
  assert.ok(seen);
  const memory = seen!.relevantMemory as Array<{ name: string; value: string }>;
  assert.equal(memory.length, 1);
  assert.match(memory[0]!.name, /Verified project evidence.*memory-turn-source/);
  assert.match(memory[0]!.value, new RegExp(verifiedEvidence.id));
  const evidence = seen!.relevantEvidence as Array<{ id: string; content: string; validity: string }>;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.id, verifiedEvidence.id);
  assert.equal(evidence[0]!.validity, "verified");
  assert.match(evidence[0]!.content, /0 and 1 are not prime numbers/);
  assert.doesNotMatch(JSON.stringify(memory), /Maybe 1 is prime/);
});

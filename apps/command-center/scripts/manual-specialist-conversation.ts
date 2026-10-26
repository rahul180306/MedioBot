import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ModelResolver } from "../src/runtime/modelRegistry.ts";
import { ProviderRepository } from "../src/storage/providerRepository.ts";
import { getProductionDatabasePath } from "../src/storage/appPaths.ts";
import { startCommandCenter } from "../src/server.ts";
import { sanitizeReasoningAndSecrets } from "@mediobot-v2/models";
import type { SpecialistSessionRecord } from "@mediobot-v2/contracts";

const settingsPath = process.env.MEDIOBOT_DATA_DIR?.trim()
  ? path.join(path.resolve(process.env.MEDIOBOT_DATA_DIR.trim()), "mediobot.db") : getProductionDatabasePath();
if (!existsSync(settingsPath)) throw new Error("The configured MedioBot settings database is unavailable.");
const settingsDb = new DatabaseSync(settingsPath, { readOnly: true });
const providerRepository = new ProviderRepository(settingsDb);
const modelResolver = new ModelResolver(providerRepository);
const providerId = process.env.MEDIOBOT_LIVE_COLLAB_PROVIDER?.trim();
const modelId = process.env.MEDIOBOT_LIVE_COLLAB_MODEL?.trim();
if (Boolean(providerId) !== Boolean(modelId)) throw new Error("Set both MEDIOBOT_LIVE_COLLAB_PROVIDER and MEDIOBOT_LIVE_COLLAB_MODEL, or neither.");
const resolved = modelResolver.resolveTextClient(providerId && modelId ? { providerConnectionId: providerId, modelId } : undefined);
const modelSelection = { providerConnectionId: resolved.descriptor.providerId, modelId: resolved.descriptor.modelId };
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "mediobot-specialist-conversation-"));
const projectRoot = path.join(tempRoot, "project");
mkdirSync(projectRoot);
writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "conversation-context-fixture", packageManager: "pnpm@10.0.0", scripts: { test: "node --test" } }, null, 2));
writeFileSync(path.join(projectRoot, "continuity-notes.md"), "The user prefers short, evidence-backed answers.\n");
const runtimeDbPath = path.join(tempRoot, "runtime.db");
const threadId = `specialist-manual-${randomUUID()}`;
const events: Array<Record<string, unknown>> = [];
let app: Awaited<ReturnType<typeof startCommandCenter>> | undefined;

function write(record: Record<string, unknown>) { process.stdout.write(`${JSON.stringify(record)}\n`); }
function specialistId(name: string): string {
  const item = app!.composition.definitions.find(definition => definition.name.toLowerCase() === name.toLowerCase());
  if (!item) throw new Error(`Specialist ${name} is not registered.`);
  return item.id;
}

async function start() {
  app = await startCommandCenter({ databasePath: runtimeDbPath, providerRepository, modelResolver, workspaceRoot: projectRoot,
    defaultApprovalMode: "Ask before edits", vite: false, host: "127.0.0.1", port: 0, listen: true });
}

async function turn(name: string, prompt: string, label: string) {
  const id = `turn-${randomUUID()}`;
  const response = await fetch(`${app!.url}/api/turns`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, turnId: id, prompt, specialistId: specialistId(name), modelSelection }) });
  const started = await response.json() as { taskId?: string; error?: { message?: string } };
  if (!response.ok || !started.taskId) throw new Error(started.error?.message ?? `Turn ${label} did not start (HTTP ${response.status}).`);
  const timeoutAt = Date.now() + Math.min(720_000, Math.max(30_000, Number(process.env.MEDIOBOT_SPECIALIST_TIMEOUT_MS ?? 600_000)));
  while (Date.now() < timeoutAt) {
    const task = app!.composition.snapshotTask(started.taskId as never);
    const history = await app!.history.get(threadId);
    const saved = history?.turns.find(item => item.id === id);
    if (task && ["completed", "failed", "cancelled"].includes(task.state) && saved?.status !== "running") {
      const taskEvents = app!.composition.taskEvents.get(started.taskId as never) ?? [];
      events.push(...taskEvents.map(event => ({ taskId: started.taskId, type: event.type, specialist: event.workerName,
        tool: event.toolName, at: event.occurredAt, executionTaskId: event.executionTaskId })));
      const answer = saved?.items.filter(item => item.type === "agent_message").at(-1)?.text ?? "";
      write({ event: "specialist-conversation.turn", label, specialist: name, taskId: started.taskId, status: task.state,
        prompt, answer: sanitizeReasoningAndSecrets(answer).slice(0, 2500), startedAt: saved?.createdAt, completedAt: saved?.completedAt,
        error: task.error?.message,
        toolCalls: taskEvents.filter(event => event.type === "tool.started").map(event => ({ specialist: event.workerName, tool: event.toolName, at: event.occurredAt })) });
      return { taskId: started.taskId, status: task.state, answer };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  try { await fetch(`${app!.url}/api/turns/${id}/cancel?threadId=${encodeURIComponent(threadId)}`, { method: "POST" }); } catch {}
  throw new Error(`Turn ${label} exceeded its bounded wait.`);
}

async function sessionSummary(taskId: string, name: string) {
  const engine = app!.composition.durableTaskEngine!;
  try {
    const session = await engine.authorizeSpecialistSessionScope(taskId, specialistId(name), { persistentForThread: true });
    return await engine.getSpecialistSession(session);
  } catch { return null; }
}

try {
  write({ event: "specialist-conversation.started", providerId: sanitizeReasoningAndSecrets(resolved.descriptor.providerId),
    modelId: sanitizeReasoningAndSecrets(resolved.descriptor.modelId), threadId, workspace: path.basename(projectRoot),
    runtimeDatabase: "isolated temporary SQLite database" });
  await start();
  const codyFirst = await turn("Cody", "Read package.json and report the configured package manager and one available script. Do not modify files.", "A-cody-first");
  const codySecond = await turn("Cody", "From your earlier turn, what package manager and script did you find? Recheck package.json and state whether the earlier answer was correct.", "B-cody-second");
  rmSync(path.join(projectRoot, "package.json"));
  write({ event: "specialist-conversation.fixture-hidden", reason: "The post-restart continuity check must rely on saved specialist context." });
  const doc = await turn("Doc", "Use official Node.js documentation to explain what AbortSignal.timeout(ms) returns. Include the retrieved official source URL and any caveat.", "C-doc-independent");
  const beforeRestart = await sessionSummary(codySecond.taskId, "Cody");
  write({ event: "specialist-conversation.pre-restart", codyContextChars: beforeRestart?.contextSummary.length ?? 0,
    codyVersion: beforeRestart?.contextVersion, codyIncludesFirstTurn: /package manager|pnpm/i.test(beforeRestart?.contextSummary ?? ""),
    docTaskStatus: doc.status });
  await app.close();
  app = undefined;

  await start();
  const restored = await sessionSummary(codySecond.taskId, "Cody");
  write({ event: "specialist-conversation.restart-recovery", recovered: Boolean(restored?.contextSummary),
    contextChars: restored?.contextSummary.length ?? 0, contextVersion: restored?.contextVersion,
    containsPriorRequest: restored?.contextSummary.includes("Read package.json") ?? false });
  const codyAfterRestart = await turn("Cody", "Continue our conversation after restart. What package manager and script did you find earlier? The package.json file has since been removed, so use our saved conversation context.", "D-cody-after-restart");
  writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "conversation-context-fixture", packageManager: "pnpm@10.0.0", scripts: { test: "node --test" } }, null, 2));

  const separateThreadId = `specialist-isolation-${randomUUID()}`;
  const separateTurnId = `turn-${randomUUID()}`;
  const separateResponse = await fetch(`${app.url}/api/turns`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: separateThreadId, turnId: separateTurnId, prompt: "Read package.json and report the package manager.", specialistId: specialistId("Cody"), modelSelection }) });
  const separateStart = await separateResponse.json() as { taskId?: string; error?: { message?: string } };
  if (!separateResponse.ok || !separateStart.taskId) throw new Error(separateStart.error?.message ?? "Isolation turn did not start.");
  const separateTask = separateStart.taskId;
  let isolatedSessionAtStart: SpecialistSessionRecord | null = null;
  const authorizationDeadline = Date.now() + 30_000;
  while (Date.now() < authorizationDeadline && !isolatedSessionAtStart) {
    try {
      const isolated = await app.composition.durableTaskEngine!.authorizeSpecialistSessionScope(separateTask, specialistId("Cody"), { persistentForThread: true });
      isolatedSessionAtStart = await app.composition.durableTaskEngine!.getSpecialistSession(isolated);
    } catch {
      const state = app.composition.snapshotTask(separateTask as never)?.state;
      if (state && ["completed", "failed", "cancelled"].includes(state)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const isolatedDeadline = Date.now() + 600_000;
  let isolatedTask = app.composition.snapshotTask(separateTask as never);
  while (isolatedTask && !["completed", "failed", "cancelled"].includes(isolatedTask.state) && Date.now() < isolatedDeadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    isolatedTask = app.composition.snapshotTask(separateTask as never);
  }
  let isolatedSession: SpecialistSessionRecord | null = null;
  try {
    const isolated = await app.composition.durableTaskEngine!.authorizeSpecialistSessionScope(separateTask, specialistId("Cody"), { persistentForThread: true });
    isolatedSession = await app.composition.durableTaskEngine!.getSpecialistSession(isolated);
  } catch { /* A failed isolated turn may have no authorized specialist session. */ }
  write({ event: "specialist-conversation.isolation", distinctThread: separateThreadId !== threadId,
    priorThreadId: threadId, isolatedContextInitiallyEmpty: isolatedSessionAtStart !== null && isolatedSessionAtStart.contextSummary.length === 0,
    initialSessionCaptured: isolatedSessionAtStart !== null, isolatedContextAfterTurnChars: isolatedSession?.contextSummary.length ?? 0,
    sessionId: isolatedSessionAtStart?.id ?? isolatedSession?.id });
  if (isolatedTask && !["completed", "failed", "cancelled"].includes(isolatedTask.state)) {
    await app.composition.cancel(separateTask as never);
  }

  const latest = await sessionSummary(codyAfterRestart.taskId, "Cody");
  write({ event: "specialist-conversation.finished", status: [codyFirst.status, codySecond.status, doc.status, codyAfterRestart.status].every(value => value === "completed") ? "completed" : "partial",
    contextChars: latest?.contextSummary.length ?? 0, contextBound: (latest?.contextSummary.length ?? 0) <= 16_000,
    durableContextVersion: latest?.contextVersion, specialistEvents: events.slice(-100) });
  if ([codyFirst, codySecond, doc, codyAfterRestart].some(result => result.status !== "completed")) process.exitCode = 1;
} finally {
  await app?.close();
  settingsDb.close();
  rmSync(tempRoot, { recursive: true, force: true });
}

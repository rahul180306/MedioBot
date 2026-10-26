import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getEnabledModels, ModelResolver } from "../src/runtime/modelRegistry.ts";
import { ProviderRepository } from "../src/storage/providerRepository.ts";
import { getProductionDatabasePath } from "../src/storage/appPaths.ts";
import { startCommandCenter } from "../src/server.ts";
import { sanitizeReasoningAndSecrets } from "@mediobot-v2/models";
import type { MaestroDecision } from "@mediobot-v2/maestro";
import type { ThreadModelSelection } from "../src/runtime/modelRegistry.ts";

const DEFAULT_OBJECTIVE = "Recommend a safe approach for adding request timeouts and cancellation to a Node.js HTTP client. Use official documentation, identify design risks independently, then reconcile the findings.";
const ROLE_BY_NAME = new Map([["cody", "coding"], ["doc", "doc"], ["research", "research"]]);

function selectionFromEnvironment(): ThreadModelSelection | undefined {
  const providerConnectionId = process.env.MEDIOBOT_LIVE_COLLAB_PROVIDER?.trim();
  const modelId = process.env.MEDIOBOT_LIVE_COLLAB_MODEL?.trim();
  if (Boolean(providerConnectionId) !== Boolean(modelId)) {
    throw new Error("Set both MEDIOBOT_LIVE_COLLAB_PROVIDER and MEDIOBOT_LIVE_COLLAB_MODEL, or neither.");
  }
  return providerConnectionId && modelId ? { providerConnectionId, modelId } : undefined;
}

function safeId(value: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(value) && !/(?:sk-|key|token|secret)/i.test(value)
    ? value : "redacted-id";
}

function participantsFromArgs(definitions: ReadonlyArray<{ id: string; name: string }>): Array<{ id: string; name: string; role: string }> {
  const args = process.argv.slice(2);
  const listArg = args.find(value => value.startsWith("--specialists="))?.slice("--specialists=".length);
  const selectedNames = (listArg ?? "Doc,Research,Cody").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (selectedNames.length < 1 || selectedNames.length > 3 || new Set(selectedNames).size !== selectedNames.length
    || selectedNames.some(name => !ROLE_BY_NAME.has(name))) {
    throw new Error("Use --specialists=Doc,Research,Cody with one to three unique names from Cody, Doc, Research.");
  }
  return selectedNames.map(name => {
    const role = ROLE_BY_NAME.get(name)!;
    const definition = definitions.find(entry => entry.name.toLowerCase() === name);
    if (!definition) throw new Error(`Specialist is not registered: ${name}.`);
    return { id: definition.id, name: definition.name, role };
  });
}

function objectiveFromArgs(): string {
  const args = process.argv.slice(2);
  const index = args.indexOf("--objective");
  const objective = index >= 0 ? args[index + 1]?.trim() : DEFAULT_OBJECTIVE;
  if (!objective || objective.length > 1000) throw new Error("Provide --objective followed by a task objective of at most 1000 characters.");
  return objective;
}

function assignmentsFor(objective: string, participants: ReturnType<typeof participantsFromArgs>): MaestroDecision {
  const assignments = participants.map(participant => {
    const cody = participant.role === "coding";
    const doc = participant.role === "doc";
    const peers = participants.filter(peer => peer.id !== participant.id);
    const recipient = peers.find(peer => peer.role === "coding") ?? peers[0];
    return {
      definitionId: participant.id,
      objective: cody
        ? `First inspect collaboration-brief.md using an authorized filesystem tool. Use relevant findings published to the shared group and continue your assigned work; do not ask peers again for information already present. Ask at most one bounded clarification only if a required fact is still missing. Do not modify project files. Shared objective: ${objective}`
        : doc
          ? `Use official documentation sources to investigate the shared objective. Publish one concise, evidence-backed specialist finding to the active shared collaboration group using groupMessages so all authorized members can read it. Do not substitute a private direct message for this group finding.${recipient ? ` You may also send ${recipient.name} a private message only if it contains information not intended for the group.` : ""} Shared objective: ${objective}`
          : `Independently research technical risks and recommended approaches for the shared objective. Publish one concise, evidence-backed specialist finding to the active shared collaboration group using groupMessages so all authorized members can read it. Do not substitute a private direct message for this group finding.${recipient ? ` You may also send ${recipient.name} a private message only if it contains information not intended for the group.` : ""} Shared objective: ${objective}`,
      relevantContext: `Shared objective: ${objective}. Use bounded, evidence-backed findings. Be explicit about source URLs and uncertainty.`,
      relevantContextRefs: [],
      constraints: ["Do not make workspace changes.", "Do not claim a tool succeeded unless its result is observed."],
      expectedOutcome: cody ? "A concise recommendation that uses attributed group findings after inspecting the brief." : "A concise, source-backed report with one specialist-authored shared group finding.",
      evidenceExpectations: ["Include the tool-backed source URLs used, or report why none were available."],
      ...(cody ? { requiredCapabilities: ["agent.message"] } : { requiredCapabilities: ["web.search", "web.crawl"] }),
    };
  });
  if (assignments.length === 1) {
    const [assignment] = assignments;
    if (assignment!.definitionId === participants.find(p => p.role === "coding")?.id) {
      return { type: "delegate", definitionId: assignment!.definitionId, objective: assignment!.objective,
        relevantContextRefs: assignment!.relevantContextRefs, constraints: assignment!.constraints,
        expectedOutcome: assignment!.expectedOutcome, evidenceExpectations: assignment!.evidenceExpectations };
    }
    return { type: "delegate", definitionId: assignment!.definitionId, objective: assignment!.objective,
      relevantContextRefs: assignment!.relevantContextRefs, constraints: assignment!.constraints,
      expectedOutcome: assignment!.expectedOutcome, evidenceExpectations: assignment!.evidenceExpectations,
      requiredCapabilities: assignment!.requiredCapabilities };
  }
  return { type: "delegate_text", independence: "Doc and Research gather independent evidence in parallel; Cody reconciles their attributed findings under the shared objective.", assignments };
}

const configuredStore = process.env.MEDIOBOT_DATA_DIR?.trim()
  ? path.join(path.resolve(process.env.MEDIOBOT_DATA_DIR.trim()), "mediobot.db")
  : getProductionDatabasePath();
if (!existsSync(configuredStore)) throw new Error("The configured MedioBot settings database is unavailable.");

const registryDb = new DatabaseSync(configuredStore, { readOnly: true });
const providerRepository = new ProviderRepository(registryDb);
const modelResolver = new ModelResolver(providerRepository);
const selection = selectionFromEnvironment();
const resolved = modelResolver.resolveTextClient(selection);
const modelSelection = { providerConnectionId: resolved.descriptor.providerId, modelId: resolved.descriptor.modelId };
const objective = objectiveFromArgs();
const workspace = mkdtempSync(path.join(os.tmpdir(), "mediobot-manual-collaboration-"));
const projectRoot = path.join(workspace, "project");
mkdirSync(projectRoot);
writeFileSync(path.join(projectRoot, "collaboration-brief.md"), `${objective}\n`);
const app = await startCommandCenter({
  databasePath: path.join(workspace, "runtime.db"),
  providerRepository,
  modelResolver,
  workspaceRoot: projectRoot,
  defaultApprovalMode: "Ask before edits",
  vite: false,
  host: "127.0.0.1",
  port: 0,
  listen: true,
});

try {
  const state = app.composition.world.inspect();
  const participants = participantsFromArgs(state.definitions.map(definition => ({ id: definition.id, name: definition.name })));
  const decision = assignmentsFor(objective, participants);
  const threadId = `manual-${randomUUID()}`;
  const turnId = `turn-${randomUUID()}`;
  const workspaceId = `manual-workspace-${randomUUID()}`;
  const startedAt = Date.now();
  let parentTaskId = "";
  const searchQueries: Array<{ query: string; startedAt: number; finishedAt?: number; results?: Array<{ title: string; url: string }> }> = [];
  const originalSearch = app.composition.crawl4aiRuntime.search.bind(app.composition.crawl4aiRuntime);
  app.composition.crawl4aiRuntime.search = async (request, signal) => {
    const searchRecord: { query: string; startedAt: number; finishedAt?: number; results: Array<{ title: string; url: string }> } = {
      query: sanitizeReasoningAndSecrets(request.query).slice(0, 300), startedAt: Date.now(), results: [],
    };
    searchQueries.push(searchRecord);
    const result = await originalSearch(request, signal);
    searchRecord.results = result.items.slice(0, 5).map(item => ({
      title: sanitizeReasoningAndSecrets(item.title).slice(0, 200), url: sanitizeReasoningAndSecrets(item.url).slice(0, 500),
    }));
    searchRecord.finishedAt = Date.now();
    return result;
  };
  const submission = app.composition.submit(app.composition.maestroDefinitionId, objective, {
    threadId, turnId, workspaceId, workspaceRoot: projectRoot, workspaceExecutionAuthorized: true,
    modelSelection, approvalMode: "Ask before edits", priority: "interactive", maestroDecision: decision,
  }, taskId => {
    parentTaskId = taskId;
    const listeners = app.composition.subscribers.get(taskId) ?? new Set();
    listeners.add(event => {
      process.stdout.write(`${JSON.stringify({ event: "manual-collaboration.progress", taskId,
        type: event.type, at: event.occurredAt, specialist: event.workerName, executionTaskId: event.executionTaskId,
        tool: event.toolName, message: event.message?.slice(0, 400), outputLog: event.outputLog?.slice(0, 500),
        failureCategory: event.failureCategory })}\n`);
    });
    app.composition.subscribers.set(taskId, listeners);
  });
  parentTaskId = submission.taskId;
  process.stdout.write(`${JSON.stringify({ event: "manual-collaboration.started", taskId: parentTaskId,
    providerId: safeId(resolved.descriptor.providerId), modelId: safeId(resolved.descriptor.modelId), participants: participants.map(p => p.name),
    startedAt, decisionSource: "manual-explicit-assignments" })}\n`);

  const timeoutMs = Number(process.env.MEDIOBOT_MANUAL_COLLAB_TIMEOUT_MS ?? 720_000);
  const timeout = setTimeout(() => { try { app.composition.cancel(parentTaskId as never); } catch {} },
    Number.isFinite(timeoutMs) ? Math.min(720_000, Math.max(30_000, timeoutMs)) : 720_000);
  const result = await submission.result.finally(() => clearTimeout(timeout));
  const events = app.composition.taskEvents.get(parentTaskId as never) ?? [];
  const workers = new Map(state.definitions.map(definition => [definition.id, definition.name]));
  const intervals = new Map<string, { name: string; start?: number; end?: number }>();
  for (const event of events) {
    if (!event.executionTaskId || !event.workerDefinitionId) continue;
    const entry = intervals.get(event.executionTaskId) ?? { name: workers.get(event.workerDefinitionId) ?? "Specialist" };
    if (event.type === "worker.started") entry.start = event.occurredAt;
    if (["worker.completed", "worker.failed", "worker.cancelled"].includes(event.type)) entry.end = event.occurredAt;
    intervals.set(event.executionTaskId, entry);
  }
  const engine = app.composition.durableTaskEngine!;
  const messages = [];
  for (const participant of participants) {
    const access = await engine.authorizeSpecialistSessionScope(parentTaskId as never, participant.id as never);
    for (const message of await engine.getSpecialistMessages(access, { limit: 100 })) {
      if (!messages.some(item => item.id === message.id)) {
        let content = "";
        try { content = JSON.parse(message.content).text ?? ""; } catch {}
        messages.push({ id: message.id, sender: workers.get(message.senderSpecialistId) ?? "Specialist",
          recipient: workers.get(message.recipientSpecialistId) ?? "Specialist", sequence: message.sequenceNumber,
          status: message.deliveryStatus, kind: (() => { try { return JSON.parse(message.content).kind; } catch { return "unknown"; } })(),
          text: sanitizeReasoningAndSecrets(content).slice(0, 400) });
      }
    }
  }
  const finalEvent = [...events].reverse().find(event => event.type === "maestro.responded");
  const toolEvents = events.filter(event => event.type.startsWith("tool."));
  const webIntervals = [...intervals.values()].filter(entry => ["Doc", "Research"].includes(entry.name) && entry.start && entry.end);
  const overlapMs = webIntervals.length >= 2
    ? Math.max(0, Math.min(...webIntervals.map(entry => entry.end!)) - Math.max(...webIntervals.map(entry => entry.start!))) : 0;
  const resultEvent = { event: "manual-collaboration.finished", taskId: parentTaskId, status: result.state,
    finishedAt: Date.now(), durationMs: Date.now() - startedAt, assignments: [...intervals].map(([executionTaskId, entry]) => ({
      executionTaskId, specialist: entry.name, startedAt: entry.start, finishedAt: entry.end })),
    webSpecialistOverlapMs: overlapMs,
    searchQueries, toolEvents: toolEvents.map(event => ({ type: event.type, specialist: event.workerName, tool: event.toolName,
      at: event.occurredAt, executionTaskId: event.executionTaskId })), messages,
    finalResponse: finalEvent?.message ? sanitizeReasoningAndSecrets(finalEvent.message).slice(0, 6000) : undefined,
    providerRequests: "See sanitized model.scheduler/model.client diagnostics emitted by the configured runtime." };
  process.stdout.write(`${JSON.stringify(resultEvent)}\n`);
  if (result.state !== "completed") process.exitCode = 1;
} finally {
  await app.close();
  registryDb.close();
  rmSync(workspace, { recursive: true, force: true });
}

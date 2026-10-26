import { createHash } from "node:crypto";
import { TextMediobotExecution, readModelSelection } from "./text-workers.ts";
import type { TextAssignmentDraft, TextModelResolver } from "./text-workers.ts";
export { TextMediobotExecution, readModelSelection } from "./text-workers.ts";
export type { TextAssignmentDraft, TextModelResolver, WorkerReport, ModelSelection } from "./text-workers.ts";

export function resolveDurableChildModelSelection(input: {
  readonly childExists: boolean;
  readonly savedSelection?: unknown;
  readonly assignmentOverride?: unknown;
  readonly parentSelection?: unknown;
  readonly allowParentFallback?: boolean;
}) {
  if (input.childExists && input.savedSelection !== undefined) return readModelSelection(input.savedSelection);
  if (input.assignmentOverride !== undefined) return readModelSelection(input.assignmentOverride);
  if (input.allowParentFallback !== false && input.parentSelection !== undefined) return readModelSelection(input.parentSelection);
  return undefined;
}

export type CheckpointDatabase = {
  exec(sql: string): void;
  prepare(sql: string): { all(...values: unknown[]): unknown[]; get(...values: unknown[]): unknown; run(...values: unknown[]): unknown };
};

function checkpointDatabaseAdapter(database: CheckpointDatabase) {
  return {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string) => {
      const statement = database.prepare(sql);
      const bind = (values: unknown[]) => values.map(value => value === undefined ? null : value);
      return {
        all: (...values: unknown[]) => statement.all(...bind(values)),
        get: (...values: unknown[]) => statement.get(...bind(values)),
        run: (...values: unknown[]) => statement.run(...bind(values)),
      };
    },
    pragma: (sql: string) => database.exec(`PRAGMA ${sql}`),
    transaction: (callback: (...args: any[]) => any) => (...args: any[]) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = callback(...args);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function stableSpecialistTaskId(parentTaskId: TaskId, specialistId: string, assignmentIndex: number, objective: string): TaskId {
  const identity = `${parentTaskId}\0${specialistId}\0${assignmentIndex}\0${objective}`;
  return `task_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}` as TaskId;
}

function stableAssignmentTaskId(parentTaskId: TaskId, specialistId: string, assignmentId: string, objective: string): TaskId {
  const identity = `${parentTaskId}\0${specialistId}\0${assignmentId}\0${objective}`;
  return `task_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}` as TaskId;
}
import { WebAgentExecution, WEB_EVIDENCE_UNAVAILABLE_MARKER } from "./web-workers.ts";
import type { WebIntelligenceRuntime } from "./web-workers.ts";
export { WebAgentExecution, WEB_EVIDENCE_UNAVAILABLE_MARKER, buildSearchQuery, filterRelevantSearchItems, searchCandidateRejectionReason, parseWebReport } from "./web-workers.ts";
export type { WebIntelligenceRuntime } from "./web-workers.ts";
import { SpecialistCommunicationHub, type SpecialistCommunicationEvent } from "./specialist-communication.ts";
import { LangGraphExecutionEngine, LangGraphInterruptedError, sqliteLangGraphOutcomeStore } from "./langgraph-engine.ts";
export { LangGraphExecutionEngine, LangGraphInterruptedError } from "./langgraph-engine.ts";
export { SpecialistCommunicationHub } from "./specialist-communication.ts";
import { DynamicSpecialistSelector } from "./specialist-selection.ts";
export { DynamicSpecialistSelector } from "./specialist-selection.ts";
export type { SpecialistCandidate, SelectionInput, SpecialistSelectionResult } from "./specialist-selection.ts";
import type { InMemoryWorld, MediobotDefinition, MediobotDefinitionId, TaskId, WorkerId, WorldEvent } from "@mediobot-v2/domain";
import { CodyExecutionAdapter, createCodyDefinition } from "@mediobot-v2/cody";
import type { CodyDecisionProvider, CodyToolDiagnostic } from "@mediobot-v2/cody";
import { createTesterDefinition, TesterExecutionAdapter } from "@mediobot-v2/tester";
import type { TesterDecisionProvider, TesterToolDiagnostic, VerificationReport } from "@mediobot-v2/tester";
export { createTesterDefinition } from "@mediobot-v2/tester";
import type { RunContext, RunResult, WorkerExecutionAdapter, WorkerExecutionContext, WorkerExecutionPlan, WorkerRuntime, DurableTaskEngine, DurableTaskDelegationRecord } from "@mediobot-v2/runtime";
import type { ToolRuntime } from "@mediobot-v2/tools";
import { ModelProviderError, completeWithModelContract, modelCompatibilityResponseText, sanitizeReasoningAndSecrets, structuredJsonOnly } from "@mediobot-v2/models";
import type { ModelOutputContract, StructuredModelClient } from "@mediobot-v2/models";
import { compileMaestroContext } from "./context.ts";
import type { MaestroContextRecord, MaestroContextSources } from "./context.ts";
import { registerMaestroDefinition } from "./definitions.ts";
import type { MarkdownMediobotDefinition } from "./definitions.ts";
import type { SkillMetadata } from "./skills.ts";
import { assessCompletion, compileCompletion } from "./completion.ts";
import { statusFromAssignmentReports } from "./assignment-status.ts";
import type { TrustedCompletion } from "./completion.ts";
export type { TrustedCompletion, CompletionRequest } from "./completion.ts";
export { loadMediobotDefinition, parseMediobotDefinition, registerMaestroDefinition } from "./definitions.ts";
export type { MarkdownMediobotDefinition } from "./definitions.ts";
export { MarkdownSkillCatalog } from "./skills.ts";
export type { SkillMetadata } from "./skills.ts";
export { compileMaestroContext } from "./context.ts";
export type { CompiledMaestroContext, MaestroContextRecord, MaestroContextSources, MaestroConversationTurn } from "./context.ts";
import { DEFAULT_WORKSPACE_TOOL_METADATA, discoverProjectIntelligence, discoverLegacyProjectIntelligence, isSensitiveName } from "./discovery.ts";
export { DEFAULT_WORKSPACE_TOOL_METADATA, discoverProjectIntelligence, discoverLegacyProjectIntelligence, isSensitiveName, readWorkspaceFile } from "./discovery.ts";
export type { ProjectDiscoveryOptions } from "./discovery.ts";

export type MaestroModelClient = StructuredModelClient;

export class MaestroDecisionError extends Error {
  readonly reason: "invalid-json" | "non-object-response" | "missing-intent" | "unsupported-intent" | "intent-not-available" | "schema-mismatch" | "unknown-delegation" | "unavailable-capability" | "insufficient-evidence" | "repair-intent-changed";
  readonly category: "structural" | "semantic";
  readonly intent?: "respond" | "request_user_input" | "acquire_context" | "use_capability" | "delegate" | "delegate_text";
  readonly recognizedKeys: ReadonlyArray<string>;
  constructor(reason: MaestroDecisionError["reason"], details: { readonly intent?: MaestroDecisionError["intent"]; readonly keys?: ReadonlyArray<string> } = {}) {
    super("Maestro returned an invalid decision");
    this.name = "MaestroDecisionError";
    this.reason = reason;
    this.category = ["intent-not-available", "unknown-delegation", "unavailable-capability"].includes(reason) ? "semantic" : "structural";
    this.intent = details.intent;
    this.recognizedKeys = details.keys ?? [];
  }
}

export type MaestroTurnDecision =
  | { readonly type: "delegate_text"; readonly independence: string; readonly assignments: ReadonlyArray<TextAssignmentDraft> }
  | { readonly type: "respond"; readonly message: string; readonly basis: "conversation" | "project-evidence" | "cannot-verify"; readonly evidenceRefs: ReadonlyArray<string> }
  | { readonly type: "request_user_input"; readonly question: string }
  | { readonly type: "acquire_context"; readonly request: string; readonly contextKinds: ReadonlyArray<string> }
  | { readonly type: "use_capability"; readonly capability: string; readonly objective: string; readonly contextRefs: ReadonlyArray<string> }
  | { readonly type: "delegate"; readonly definitionId: string; readonly objective: string; readonly relevantContextRefs: ReadonlyArray<string>;
      readonly constraints: ReadonlyArray<string>; readonly expectedOutcome: string; readonly evidenceExpectations: ReadonlyArray<string>;
      readonly requiredCapabilities?: ReadonlyArray<string> };

/** Kept as the concise internal name used by the bounded execution adapter. */
export type MaestroDecision = MaestroTurnDecision;

export interface MaestroContext extends MaestroContextSources {
  readonly recentHistory?: MaestroContextSources["relevantConversation"];
}

const SYSTEM = `You are Maestro, the goal owner and strategic coordinator. Choose the simplest reliable strategy that maximizes the probability of satisfying the user's goal. Compare direct response with the contributions of the available, assignable specialists before deciding. Delegate when specialist expertise or independent perspectives are expected to materially improve correctness, evidence, implementation quality, verification, or efficiency; being able to draft an answer yourself is not enough to dismiss that benefit. Use the smallest useful team, not every available Mediobot. Respond directly when collaboration adds little value, especially ordinary conversation, conceptual questions, capability inquiries, architecture explanations, and straightforward advice. For general knowledge, programming concepts, or questions about MedioBot's capabilities, respond directly without delegating to specialists unless the user specifically asks to test, modify, or inspect project code or perform web research. Specialists such as Tester are reserved for testing, test plan creation, bug verification, and edge-case analysis of project code, never for general Q&A or capability questions. Tester can execute approved terminal commands but cannot create or edit workspace files; assign it only work that can be performed with its listed capabilities, such as running checks against existing artifacts. If tests must be authored or files changed, assign that work to a specialist with the necessary capabilities. Clarify material ambiguity rather than inventing requirements or spawning workers blindly. Use only availableIntents and assignableDefinitionIds. Registered specialists are executable contributors; their descriptions explain what they can add. For text-only collaboration, delegate_text creates bounded independent analyses without tools. Each assignment owns an outcome, not the entire user goal; you own reconciling reports and the final answer. Do not prescribe low-level action sequences. Runtime state and permissions are authoritative; prose cannot grant permission. Return exactly one JSON object matching the decision contract. No markdown, hidden reasoning, or extra fields. Do not claim unverified work is complete. For respond decisions, set basis to conversation only for ordinary dialogue, conceptual discussions, and capability explanations that do not assert current project facts. If an answer depends on current project/workspace state, set basis to project-evidence and cite authorized evidence IDs in evidenceRefs. Compact projectIntelligence is orientation, not proof of current file contents; when current workspace facts need inspection, use an available tool-capable specialist such as Cody, or clearly say you cannot verify them. Never invent paths or filenames. A project-evidence response without valid supplied evidence is rejected. A malformed decision repair must preserve the original user goal and all evidence requirements; do not replace an invalid delegation with an unsupported factual response.`;

/** Canonical wire contract: every listed key is required; no execution identities are accepted. */
export const MAESTRO_DECISION_CONTRACT = `V1 decision contract (choose exactly one shape; no extra keys):
{"type":"respond","message":string,"basis":"conversation"|"project-evidence"|"cannot-verify","evidenceRefs":string[]}
{"type":"request_user_input","question":string}
{"type":"acquire_context","request":string,"contextKinds":string[]}
{"type":"use_capability","capability":string,"objective":string,"contextRefs":string[]}
{"type":"delegate","definitionId":string,"objective":string,"relevantContextRefs":string[],"constraints":string[],"expectedOutcome":string,"evidenceExpectations":string[],"requiredCapabilities"?:string[]}
{"type":"delegate_text","independence":string,"assignments":[{"assignmentId"?:string,"dependsOn"?:string[],"definitionId":string,"objective":string,"relevantContext":string,"relevantContextRefs":string[],"constraints":string[],"expectedOutcome":string,"evidenceExpectations":string[],"requiredCapabilities"?:string[]}]}
For either delegation shape, requiredCapabilities is the sole optional key outside delegate_text assignmentId and dependsOn. If present, list only capabilities needed for the assignment, copied exactly from capabilityMetadata.name. Supported examples include text-inference, web.search, web.crawl, terminal.execute, filesystem.list, filesystem.read, filesystem.search, filesystem.write, and agent.message; the runtime will reject unavailable capabilities and route only to an executor that supports every requirement. Use delegate_text for 1 to 3 bounded assignments. Each must be independently solvable from supplied relevantContext except where a declared dependsOn assignment provides a prerequisite; explain why independent assignments can run concurrently in independence. When dependencies are needed, provide unique assignmentId values and dependsOn IDs that refer to other assignments in this same decision. The runtime rejects unknown IDs and cycles. Use only assignableDefinitionIds. Include relevant facts, not the entire Goal. State web.search and/or web.crawl when the task requires web research, and terminal.execute when it requires actual command/test execution; omit requiredCapabilities for supplied-context text analysis. The runtime routes each assignment to an executor that supports every required capability and reports unavailable capabilities instead of substituting a text worker. Do not automatically invoke all specialists; direct answers need no delegation. For respond, basis is "conversation" only for ordinary dialogue and evidenceRefs must be []; for current project facts use basis "project-evidence" and cite supplied relevantEvidence IDs. Project-intelligence summaries and model claims are not execution evidence. If runtime supplies projectEvidenceRequired=true, that requirement cannot be waived: use an authorized specialist when assignable, otherwise return basis "cannot-verify" with no evidenceRefs. The runtime replaces that message with a fixed safe notice. Never guess.
For a Cody assignment that must exchange a bounded request with another assigned specialist, require agent.message and include any filesystem or terminal capabilities the work needs. Do not request agent.message for text-only work. Supported capabilities: text-inference, web.search, web.crawl, terminal.execute, agent.message, filesystem.list, filesystem.read, filesystem.search, filesystem.write.
Strings must be nonempty. Arrays may be empty, contain at most 12 nonempty strings, each at most 500 characters. String limits: message and delegate objective 2000; capability 200; other prose 1000. Copy definitionId exactly from assignableDefinitionIds and capability exactly from capabilityMetadata.name. Use only availableIntents when supplied. Never include taskId, workerId, reasoning, or an action sequence.`;

const jsonText = { type: "string" } as const;
const jsonTextList = { type: "array", items: jsonText, maxItems: 12 } as const;
function maestroVariant(type: string, required: string[], properties: Record<string, unknown>) {
  return { type: "object", properties: { type: { const: type }, ...properties }, required: ["type", ...required], additionalProperties: false };
}
const MAESTRO_DECISION_SCHEMA = { oneOf: [
  maestroVariant("respond", ["message", "basis", "evidenceRefs"], { message: jsonText,
    basis: { type: "string", enum: ["conversation", "project-evidence", "cannot-verify"] }, evidenceRefs: jsonTextList }),
  maestroVariant("request_user_input", ["question"], { question: jsonText }),
  maestroVariant("acquire_context", ["request", "contextKinds"], { request: jsonText, contextKinds: jsonTextList }),
  maestroVariant("use_capability", ["capability", "objective", "contextRefs"], { capability: jsonText, objective: jsonText, contextRefs: jsonTextList }),
  maestroVariant("delegate", ["definitionId", "objective", "relevantContextRefs", "constraints", "expectedOutcome", "evidenceExpectations"], {
    definitionId: jsonText, objective: jsonText, relevantContextRefs: jsonTextList, constraints: jsonTextList, expectedOutcome: jsonText,
    evidenceExpectations: jsonTextList, requiredCapabilities: jsonTextList }),
  maestroVariant("delegate_text", ["independence", "assignments"], { independence: jsonText,
    assignments: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", properties: {
      assignmentId: jsonText, dependsOn: jsonTextList, definitionId: jsonText, objective: jsonText, relevantContext: jsonText,
      relevantContextRefs: jsonTextList, constraints: jsonTextList, expectedOutcome: jsonText, evidenceExpectations: jsonTextList,
      requiredCapabilities: jsonTextList,
    }, required: ["definitionId", "objective", "relevantContext", "relevantContextRefs", "constraints", "expectedOutcome", "evidenceExpectations"], additionalProperties: false } } }),
] } as const;
export const MAESTRO_DECISION_OUTPUT_CONTRACT: ModelOutputContract = {
  name: "mediobot_decision", description: "Propose one Maestro decision. MedioBot validates it before orchestration.", schema: MAESTRO_DECISION_SCHEMA,
  tools: [{ name: "mediobot_decision", description: "Propose one Maestro decision; MedioBot validates and authorizes assignments.", parameters: MAESTRO_DECISION_SCHEMA }],
};

export const MAESTRO_MAX_DECISION_ATTEMPTS = 3;

export function hasOnlyBlockedWebReportsWithoutEvidence(groups: ReadonlyArray<{ readonly kind: string; readonly result: string }>): boolean {
  const webGroups = groups.filter(group => group.kind === "web");
  if (webGroups.length === 0) return false;
  if (webGroups.every(group => group.result.includes(WEB_EVIDENCE_UNAVAILABLE_MARKER))) return true;
  const reports = webGroups.flatMap(group => {
    const marker = /bounded-web-worker-reports:\s*/.exec(group.result);
    if (!marker) return [];
    try {
      const parsed = JSON.parse(group.result.slice(marker.index + marker[0].length)) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });
  return reports.length > 0 && reports.every(report => report && typeof report === "object" && !Array.isArray(report)
    && (report as Record<string, unknown>).status === "blocked"
    && (!Array.isArray((report as Record<string, unknown>).evidence) || ((report as Record<string, unknown>).evidence as unknown[]).length === 0));
}

/** Fixed required key lists per intent, used only for repair feedback. Never crosses the repair boundary as model-generated content. */
const REQUIRED_DECISION_KEYS: Readonly<Record<string, readonly string[]>> = {
  respond: ["type", "message", "basis", "evidenceRefs"],
  request_user_input: ["type", "question"],
  acquire_context: ["type", "request", "contextKinds"],
  use_capability: ["type", "capability", "objective", "contextRefs"],
  delegate: ["type", "definitionId", "objective", "relevantContextRefs", "constraints", "expectedOutcome", "evidenceExpectations"],
  delegate_text: ["type", "independence", "assignments"],
};

function parseFirstJsonValue(text: string): unknown {
  const start = text.search(/[\[{]/);
  if (start < 0) return undefined;
  let braces = 0; let brackets = 0; let quoted = false; let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") braces++;
    else if (character === "}") braces--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    if (braces === 0 && brackets === 0) {
      const candidate = text.slice(start, index + 1);
      try { return JSON.parse(candidate); }
      catch {
        try { return JSON.parse(candidate.replace(/\\"/g, '"')); }
        catch { return undefined; }
      }
    }
  }
  return undefined;
}

function compactSpecialistResults(groups: ReadonlyArray<{ readonly kind: string; readonly result: string }>): ReadonlyArray<MaestroContextRecord> {
  const compactText = (value: unknown, max: number) => typeof value === "string" ? sanitizeReasoningAndSecrets(value).slice(0, max) : undefined;
  const compactList = (value: unknown, maxItems: number, maxText: number) => Array.isArray(value)
    ? value.slice(0, maxItems).map(item => compactText(item, maxText)).filter((item): item is string => Boolean(item)) : undefined;
  const records: MaestroContextRecord[] = [];
  for (const group of groups) {
    const reportMarker = /bounded-(?:web-)?worker-reports:\s*/.exec(group.result);
    const reportPayload = reportMarker ? group.result.slice(reportMarker.index + reportMarker[0].length) : "";
    const candidates = [...(reportPayload ? [parseFirstJsonValue(reportPayload)] : []), ...group.result.split(/\r?\n/).map(parseFirstJsonValue)];
    const parsed = candidates.find(value => value !== undefined);
    const reports = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
    if (reports.length === 0) {
      records.push({ name: "specialist-result", value: JSON.stringify({ executor: group.kind, result: group.result.slice(0, 3_000) }) });
      continue;
    }
    for (const report of reports.slice(0, 6)) {
      if (!report || typeof report !== "object" || Array.isArray(report)) continue;
      const value = report as Record<string, unknown>;
      const compact = {
        executor: group.kind,
        ...(compactText(value.mediobotId, 100) ? { specialistId: compactText(value.mediobotId, 100) } : {}),
        ...(compactText(value.status, 40) ? { status: compactText(value.status, 40) } : {}),
        ...(compactText(value.summary, 900) ? { summary: compactText(value.summary, 900) } : {}),
        ...(compactList(value.evidence, 3, 350) ? { evidence: compactList(value.evidence, 3, 350) } : {}),
        ...(compactList(value.findings, 3, 350) ? { findings: compactList(value.findings, 3, 350) } : {}),
        ...(compactList(value.blockers, 2, 200) ? { blockers: compactList(value.blockers, 2, 200) } : {}),
        ...(compactList(value.unresolved, 2, 200) ? { unresolved: compactList(value.unresolved, 2, 200) } : {}),
        ...(compactList(value.artifacts, 2, 200) ? { artifacts: compactList(value.artifacts, 2, 200) } : {}),
      };
      records.push({ name: "specialist-result", value: JSON.stringify(compact) });
    }
  }
  return records;
}

function deniesCompletedCoordination(message: string): boolean {
  const globalDenial = /\b(?:cannot|can't|could not|unable to)\s+coordinate\b.{0,160}\bfor\s+(?:this|the)\s+task\b|\bdelegation\s+(?:is|was)\s+(?:not\s+permitted|not\s+allowed|unavailable|unsupported)\b|\bavailable\s+intents?\b.{0,100}\b(?:only|limited)\b.{0,100}\bdelegat(?:e|ion|ing)\b.{0,60}\b(?:not|unavailable|unsupported)\b/i;
  if (!globalDenial.test(message)) return false;
  // A statement that one named specialist or capability is unavailable can
  // be a truthful partial result even when other assignments completed.
  const scopedDenial = /\b(?:delegation|coordination)\b[^.]{0,100}\b(?:to|for)\s+(?:the\s+)?(?:[A-Z][\w.-]*|specialist|executor|capability)\b[^.]{0,100}\b(?:not\s+permitted|not\s+allowed|unavailable|unsupported)\b/i;
  return !scopedDenial.test(message);
}

export interface MaestroDecisionDiagnostic {
  readonly callId: string;
  readonly stage: "context" | "validated" | "rejected" | "model-failed";
  readonly attempt?: number;
  readonly observedIntent?: MaestroDecision["type"] | "unknown";
  readonly intent?: MaestroDecision["type"];
  readonly assignmentCount?: number;
  readonly reason?: MaestroDecisionError["reason"];
  /** Contract fields observed in a rejected decision; values/raw provider output are never recorded. */
  readonly recognizedKeys?: ReadonlyArray<string>;
  readonly assignableCount?: number;
  readonly describedAssignableCount?: number;
  readonly textDelegationAvailable?: boolean;
  readonly durationMs?: number;
  readonly ttfbMs?: number;
  readonly ttftMs?: number;
  readonly modelDurationMs?: number;
  readonly systemCharacters?: number;
  readonly inputCharacters?: number;
  readonly transportRetry?: boolean;
  readonly evidenceClassifierDurationMs?: number;
  readonly providerCallCount?: number;
  readonly tokenUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly transportFailure?: { readonly code: string; readonly phase?: string; readonly elapsedMs?: number;
    readonly timeoutMs?: number; readonly ttfbMs?: number; readonly ttftMs?: number };
}

const PROJECT_AWARE_KEYWORDS_REGEX = /\b(?:project|projects|workspace|workspaces|file|files|path|paths|folder|folders|directory|directories|repo|repos|repository|repositories|git|branch|branches|commit|commits|diff|status|log|test|tests|testing|build|package|packages|code|bug|bugs|issue|issues|src|component|components|function|functions|class|import|imports|export|exports|terminal|command|commands|run|lint|fix|fixes|read|write|edit|delete|remove|pnpm|npm|node(?!\.js\b)|config|tsconfig|package\.json|readme)\b|\.(?!js\b)[a-z0-9]{2,4}\b|[\\/]/i;
const CAPABILITY_OR_CONCEPT_REGEX = /^(?:can you|can mediobot|what is|what are|how do|how does|how can|explain|tell me about|what can you|who are you|help|hello|hi|hey)\b/i;
const EXPLICIT_FILE_OR_PATH_REGEX = /(?:\b[\w-]+\.(?!js\b)[\w]{1,5}\b|[\\/]|package\.json|tsconfig|\b(?:in this (?:project|repo|workspace)|current (?:files|code|diff|status))\b)/i;

/**
 * Capability-aware fast path helper:
 * Distinguishes ordinary conversation / conceptual Q&A / greetings from project-aware inquiries that require workspace evidence.
 */
export function isOrdinaryConversationGoal(goal: string, proposedAnswer?: string): boolean {
  const trimmed = goal.trim();
  if (!trimmed) return true;
  // If the user's goal mentions the project, workspace, repository, or explicit files/paths, it is project-aware
  if (/\b(?:project|projects|workspace|workspaces|repo|repos|repository|repositories)\b/i.test(trimmed) || EXPLICIT_FILE_OR_PATH_REGEX.test(trimmed)) {
    return false;
  }
  // If the user is asking a conceptual, capability, or explanatory question without referencing specific project files/paths
  if (CAPABILITY_OR_CONCEPT_REGEX.test(trimmed)) {
    // If the proposed answer asserts explicit file paths or extensions, require project evidence
    if (proposedAnswer && EXPLICIT_FILE_OR_PATH_REGEX.test(proposedAnswer)) return false;
    return true;
  }
  // If the user's goal contains workspace/file/coding keywords, it is project-aware
  if (PROJECT_AWARE_KEYWORDS_REGEX.test(trimmed)) return false;
  // If the proposed answer asserts concrete file paths or extensions, it requires project evidence
  if (proposedAnswer && PROJECT_AWARE_KEYWORDS_REGEX.test(proposedAnswer)) return false;
  return true;
}

export class MaestroDecisionProvider {
  private readonly model: MaestroModelClient;
  private readonly onDiagnostic?: (diagnostic: MaestroDecisionDiagnostic) => void;
  private readonly defaultReasoningEffort?: "low" | "medium" | "high" | "extra" | "max";
  constructor(model: MaestroModelClient, onDiagnostic?: (diagnostic: MaestroDecisionDiagnostic) => void, defaultReasoningEffort?: "low" | "medium" | "high" | "extra" | "max") {
    this.model = model; this.onDiagnostic = onDiagnostic; this.defaultReasoningEffort = defaultReasoningEffort;
  }
  private diagnostic(value: MaestroDecisionDiagnostic): void {
    try { void Promise.resolve(this.onDiagnostic?.(value)).catch(() => {}); } catch { /* Observers cannot change the decision. */ }
  }

  async decide(goal: string, context: MaestroContext, signal: AbortSignal): Promise<MaestroDecision> {
    const callId = crypto.randomUUID();
    const startTime = performance.now();
    let providerCallCount = 0;
    let evidenceClassifierDurationMs = 0;
    let transportRetryUsed = false;
    this.diagnostic({ callId, stage: "context", assignableCount: context.assignableDefinitionIds?.length ?? 0,
      describedAssignableCount: context.availableMediobots?.filter(d => context.assignableDefinitionIds?.includes(d.definitionId) && d.description?.trim()).length ?? 0,
      textDelegationAvailable: Boolean(context.availableIntents?.includes("delegate_text")) });
    let feedback = "";
    let repairIntent: MaestroDecision["type"] | undefined;
    let projectEvidenceRequired: boolean | undefined;
    for (let attempt = 0; attempt < MAESTRO_MAX_DECISION_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      const attemptContext = { ...context, ...(projectEvidenceRequired === true ? { projectEvidenceRequired: true } : {}),
        relevantConversation: context.recentHistory ?? context.relevantConversation };
      const compiled = compileMaestroContext(goal, attemptContext);
      let observedIntent: MaestroDecisionDiagnostic["observedIntent"];
      let requestDurationMs: number | undefined;
      let requestTtfbMs: number | undefined;
      let requestTtftMs: number | undefined;
      try {
        const tModelStart = performance.now();
        providerCallCount++;
        const decisionSystem = context.responseIdentity
          ? `You are ${context.responseIdentity.name}, MedioBot's ${context.responseIdentity.role} specialist, responding directly to the client. Use your configured specialist identity and communication style. Do not speak as Maestro. Base factual claims on the supplied assignment results and evidence; preserve uncertainty and never claim unverified work as complete. Do not request unnecessary tools for ordinary conversation.\nSpecialist instructions: ${context.responseIdentity.instructions}`
          : SYSTEM;
        const executableCapabilities = context.availableMediobots
          ?.filter(specialist => specialist.assignable && context.assignableDefinitionIds?.includes(specialist.definitionId))
          .map(specialist => ({ definitionId: specialist.definitionId, name: specialist.name, capabilities: specialist.capabilities })) ?? [];
        const capabilityGuidance = executableCapabilities.length
          ? `\nRuntime capability contract (authoritative): ${JSON.stringify(executableCapabilities)}. Request only capabilities listed for the selected specialist. A missing capability is not permission to substitute another executor.` : "";
        const effectiveEffort = context.reasoningEffort ?? this.defaultReasoningEffort;
        const compatible = await completeWithModelContract(this.model, { system: `${decisionSystem}${capabilityGuidance}\n\n${compiled.system}\n\n${MAESTRO_DECISION_CONTRACT}${feedback}`,
          input: compiled.input, signal, images: compiled.images, outputContract: MAESTRO_DECISION_OUTPUT_CONTRACT,
          ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}) });
        const response = modelCompatibilityResponseText(compatible);
        const modelMetrics = compatible.metrics ?? this.model.metrics?.();
        const modelDurationMs = modelMetrics?.durationMs ?? Math.round(performance.now() - tModelStart);
        requestDurationMs = modelDurationMs;
        requestTtfbMs = modelMetrics?.ttfbMs;
        requestTtftMs = modelMetrics?.ttftMs;
        const tokenUsage = compatible.usage ?? (modelMetrics ? { inputTokens: modelMetrics.inputTokens, outputTokens: modelMetrics.outputTokens } : this.model.usage?.());
        signal.throwIfAborted();
        let parsed: unknown;
        try { parsed = JSON.parse(structuredJsonOnly(response)); }
        catch { throw new MaestroDecisionError("invalid-json"); }
        const rawIntent = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).type : undefined;
        observedIntent = typeof rawIntent === "string" && ["respond", "request_user_input", "acquire_context", "use_capability", "delegate", "delegate_text"].includes(rawIntent)
          ? rawIntent as MaestroDecision["type"] : "unknown";
        // The model's self-selected "conversation" label is not an evidence boundary. Independently
        // classify every direct response against the original goal when a workspace state is in scope.
        // CAPABILITY-AWARE EXECUTION STRATEGY: avoid redundant classifier model call for ordinary conversations.
        if (rawIntent === "respond" && projectEvidenceRequired === undefined && typeof context.workspaceState?.status === "string") {
          const proposedMessage = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            && typeof (parsed as Record<string, unknown>).message === "string"
            ? ((parsed as Record<string, unknown>).message as string).slice(0, 2000) : "";
          if (isOrdinaryConversationGoal(goal, proposedMessage)) {
            // Ordinary conversation does not assert project facts; avoid redundant model call
            projectEvidenceRequired = false;
          } else {
            const tClassifierStart = performance.now();
            projectEvidenceRequired = await classifyProjectEvidenceNeed(this.model, goal, context.workspaceState.status, signal, proposedMessage);
            evidenceClassifierDurationMs = Math.round(performance.now() - tClassifierStart);
            providerCallCount++;
            signal.throwIfAborted();
          }
        }
        const decision = validateMaestroDecision(parsed, {
          ...context,
          ...(projectEvidenceRequired === true ? { projectEvidenceRequired: true } : {}),
        });
        if (repairIntent && decision.type !== repairIntent) {
          throw new MaestroDecisionError("repair-intent-changed", { intent: repairIntent });
        }
        const totalDurationMs = Math.round(performance.now() - startTime);
        this.diagnostic({ callId, stage: "validated", attempt: attempt + 1, observedIntent, intent: decision.type,
          assignmentCount: decision.type === "delegate_text" ? decision.assignments.length : decision.type === "delegate" ? 1 : 0,
          durationMs: totalDurationMs, ttfbMs: requestTtfbMs, ttftMs: requestTtftMs, modelDurationMs,
          systemCharacters: compiled.system.length, inputCharacters: compiled.input.length,
          evidenceClassifierDurationMs, providerCallCount, tokenUsage });
        return decision;
      } catch (error) {
        signal.throwIfAborted();
        const failure = error instanceof ModelProviderError && error.code === "structured-parse"
          ? new MaestroDecisionError("invalid-json") : error;
        const totalDurationMs = Math.round(performance.now() - startTime);
        const providerError = failure instanceof ModelProviderError ? failure : undefined;
        const transport = providerError?.diagnostic && typeof providerError.diagnostic === "object"
          ? providerError.diagnostic as Record<string, unknown> : undefined;
        this.diagnostic({ callId, stage: failure instanceof MaestroDecisionError ? "rejected" : "model-failed",
          attempt: attempt + 1, observedIntent, durationMs: totalDurationMs, modelDurationMs: requestDurationMs,
          systemCharacters: compiled.system.length, inputCharacters: compiled.input.length,
          ttfbMs: requestTtfbMs, ttftMs: requestTtftMs, providerCallCount, ...(providerError ? {
            transportFailure: { code: providerError.code,
              ...(typeof transport?.phase === "string" ? { phase: transport.phase } : {}),
              ...(typeof transport?.elapsedMs === "number" ? { elapsedMs: transport.elapsedMs } : {}),
              ...(typeof transport?.timeoutMs === "number" ? { timeoutMs: transport.timeoutMs } : {}),
              ...(typeof transport?.ttfbMs === "number" ? { ttfbMs: transport.ttfbMs } : {}),
              ...(typeof transport?.ttftMs === "number" ? { ttftMs: transport.ttftMs } : {}),
              ...(typeof transport?.parseOutcome === "string" ? { parseOutcome: String(transport.parseOutcome).slice(0, 40) } : {}),
              ...(typeof transport?.finishReason === "string" ? { finishReason: String(transport.finishReason).slice(0, 40) } : {}),
              ...(typeof transport?.contentCharacterCount === "number" ? { contentCharacterCount: transport.contentCharacterCount } : {}),
              ...(typeof transport?.reasoningCharacterCount === "number" ? { reasoningCharacterCount: transport.reasoningCharacterCount } : {}),
              ...(typeof transport?.toolCallCount === "number" ? { toolCallCount: transport.toolCallCount } : {}),
              ...(typeof transport?.httpStatus === "number" ? { httpStatus: transport.httpStatus } : {}) },
          } : {}), ...(failure instanceof MaestroDecisionError
            ? { reason: failure.reason, recognizedKeys: failure.recognizedKeys } : {}) });
        if (failure instanceof ModelProviderError && (failure.code === "timeout" || failure.code === "transport")
          && !transportRetryUsed && attempt < MAESTRO_MAX_DECISION_ATTEMPTS - 1) {
          transportRetryUsed = true;
          this.diagnostic({ callId, stage: "context", attempt: attempt + 1, systemCharacters: compiled.system.length,
            inputCharacters: compiled.input.length, providerCallCount, transportRetry: true });
          continue;
        }
        if (!(failure instanceof MaestroDecisionError) || failure.category === "semantic"
          || attempt === MAESTRO_MAX_DECISION_ATTEMPTS - 1) throw failure;
        // A correctly shaped but ungrounded response is a semantic planning failure, not
        // continuation of the prior schema repair. Allow a safe intent change while keeping
        // the original request and the evidence gate in the next compiled context.
        if (failure.reason === "insufficient-evidence") repairIntent = undefined;
        // Only local, fixed vocabulary crosses the repair boundary. Never replay raw output or reasoning.
        let feedbackHint = "Re-evaluate the original user goal using the exact contract. Keep all original evidence requirements; do not replace a request for current facts with an unsupported response.";
        if (failure.reason === "schema-mismatch" && failure.intent) {
          repairIntent = failure.intent;
          const required = REQUIRED_DECISION_KEYS[failure.intent];
          if (required) feedbackHint = `Preserve the "${failure.intent}" intent and original user goal. Return the same decision using exactly these keys: ${required.join(", ")}. Do not switch to another intent during schema repair.`;
        } else if (failure.reason === "repair-intent-changed" && repairIntent) {
          feedbackHint = `Preserve the "${repairIntent}" intent and original user goal. Return the same intent using exactly the contract keys.`;
        } else if (failure.reason === "insufficient-evidence") {
          feedbackHint = "The project-evidence response had no valid authorized evidence reference. Preserve the original user goal and evidence requirement: use an authorized capability or specialist to acquire the needed evidence, or state plainly that the current project fact cannot be verified. Do not provide guessed facts.";
        } else if (failure.reason === "invalid-json") {
          feedbackHint = `Return ONLY a valid JSON object matching the contract, for example: {"type":"respond","message":"<your answer>","basis":"conversation","evidenceRefs":[]}. Do not output markdown, preambles, or explanation outside the JSON object.`;
        }
        feedback = `\nPrevious attempt failed structural validation: ${failure.reason}. ${feedbackHint}`;
      }
    }
    throw new MaestroDecisionError("schema-mismatch");
  }
}

const PROJECT_EVIDENCE_CLASSIFIER = `MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER\nInput contains userGoal, workspaceStatus, and optionally proposedAnswer. Classify whether current project workspace evidence is required:
1. Would accurately addressing userGoal require inspecting current files, paths, project configuration, git status, or other mutable workspace state?
2. If proposedAnswer is present, does proposedAnswer assert any fact whose truth depends on current workspace state?
If userGoal is casual conversation, greetings, creative writing, or general knowledge explanations, return false even if workspaceStatus is OPEN.
Examples:
- userGoal: "hello", "hi", "say hello in 3 words", "tell a joke", "what is 2+2" -> {"requiresCurrentProjectEvidence": false}
- userGoal: "read package.json", "find bugs in src", "git status" -> {"requiresCurrentProjectEvidence": true}
If either condition is met, or if ambiguous, return true. Return exactly JSON: {"requiresCurrentProjectEvidence": boolean}. Do not answer the user or infer project contents.`;

const PROJECT_EVIDENCE_CLASSIFIER_OUTPUT: ModelOutputContract = {
  name: "project_evidence_requirement",
  description: "Classify whether a response needs current project evidence. MedioBot independently applies the result fail-closed.",
  schema: { type: "object", properties: { requiresCurrentProjectEvidence: { type: "boolean" } },
    required: ["requiresCurrentProjectEvidence"], additionalProperties: false },
};

async function classifyProjectEvidenceNeed(model: MaestroModelClient, goal: string, workspaceStatus: string, signal: AbortSignal,
  proposedAnswer?: string): Promise<boolean> {
  const input = JSON.stringify({ userGoal: goal, workspaceStatus, ...(proposedAnswer !== undefined ? { proposedAnswer } : {}) });
  try {
    const compatible = await completeWithModelContract(model, { system: PROJECT_EVIDENCE_CLASSIFIER, input, signal,
      outputContract: PROJECT_EVIDENCE_CLASSIFIER_OUTPUT });
    const raw = modelCompatibilityResponseText(compatible);
    signal.throwIfAborted();
    let value: unknown;
    try {
      value = JSON.parse(structuredJsonOnly(raw));
    } catch {
      return true;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length !== 1 || typeof record.requiresCurrentProjectEvidence !== "boolean"
      ? true : record.requiresCurrentProjectEvidence;
  } catch (error) {
    signal.throwIfAborted();
    // Classification errors fail closed: they never authorize a factual project answer.
    if (error instanceof ModelProviderError && error.code !== "structured-parse") throw error;
    return true;
  }
}

/** Shared by model output and precomputed decisions at the execution boundary. */
export function validateMaestroDecision(parsed: unknown, context: MaestroContext): MaestroDecision {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MaestroDecisionError("non-object-response");
    const decision = parsed as Record<string, unknown>;
    // Strict schema normalization: if model returns single assignment for delegate_text, normalize within delegate_text only.
    // NEVER convert delegate_text to executable delegate!
    if (decision.type === "delegate_text" && typeof decision.definitionId === "string" && !decision.assignments) {
      if (context.availableIntents?.includes("delegate_text")) {
        (decision as any).independence = typeof (decision as any).independence === "string" ? (decision as any).independence : "Direct text assignment";
        (decision as any).assignments = [{
          definitionId: decision.definitionId,
          objective: decision.objective,
          relevantContext: typeof (decision as any).objective === "string" ? (decision as any).objective : "",
          relevantContextRefs: Array.isArray(decision.relevantContextRefs) ? decision.relevantContextRefs : [],
          constraints: Array.isArray(decision.constraints) ? decision.constraints : [],
          expectedOutcome: typeof (decision as any).expectedOutcome === "string" ? (decision as any).expectedOutcome : "",
          evidenceExpectations: Array.isArray(decision.evidenceExpectations) ? decision.evidenceExpectations : [],
          requiredCapabilities: Array.isArray(decision.requiredCapabilities) ? decision.requiredCapabilities : [],
        }];
        delete (decision as any).definitionId;
        delete (decision as any).objective;
        delete (decision as any).relevantContextRefs;
        delete (decision as any).constraints;
        delete (decision as any).expectedOutcome;
        delete (decision as any).evidenceExpectations;
        delete (decision as any).requiredCapabilities;
      }
    }
    const kinds = ["respond", "request_user_input", "acquire_context", "use_capability", "delegate", "delegate_text"] as const;
    const intent = typeof decision.type === "string" && kinds.includes(decision.type as typeof kinds[number])
      ? decision.type as typeof kinds[number] : undefined;
    const recognizedKeySet = new Set(["type", "message", "basis", "evidenceRefs", "question", "request", "contextKinds", "capability", "objective",
      "contextRefs", "definitionId", "relevantContextRefs", "constraints", "expectedOutcome", "evidenceExpectations",
      "independence", "assignments", "requiredCapabilities"]);
    const recognizedKeys = Object.keys(decision).filter((key) => recognizedKeySet.has(key)).slice(0, 16);
    const invalid = (reason: MaestroDecisionError["reason"] = "schema-mismatch") =>
      new MaestroDecisionError(reason, { intent, keys: recognizedKeys });
    if (typeof decision.type !== "string") throw invalid("missing-intent");
    if (!intent) throw invalid("unsupported-intent");
    if (context.availableIntents && !context.availableIntents.includes(intent)) throw invalid("intent-not-available");
    const exact = (keys: string[]) => Object.keys(decision).length === keys.length && keys.every((key) => key in decision);
    const text = (key: string, max: number) => {
      if (typeof decision[key] !== "string" || !decision[key].trim()) return undefined;
      const sanitized = sanitizeReasoningAndSecrets(decision[key]);
      return sanitized ? sanitized.slice(0, max) : undefined;
    };
    if (intent === "delegate_text" && exact(["type", "independence", "assignments"])) {
      const independence = text("independence", 1000);
      if (!independence || !Array.isArray(decision.assignments) || decision.assignments.length < 1 || decision.assignments.length > 3) throw invalid();
      const assignedSpecialists = new Set<string>();
      const assignments = decision.assignments.map((entry: unknown, assignmentIndex: number) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
        const { relevantContext, assignmentId, dependsOn, ...rest } = entry as Record<string, unknown>;
        if (typeof (rest as any).evidenceExpectations === "string" && (rest as any).evidenceExpectations.trim()) {
          (rest as any).evidenceExpectations = [(rest as any).evidenceExpectations.trim()];
        }
        if (typeof (rest as any).constraints === "string" && (rest as any).constraints.trim()) {
          (rest as any).constraints = [(rest as any).constraints.trim()];
        }
        if (typeof (rest as any).relevantContextRefs === "string" && (rest as any).relevantContextRefs.trim()) {
          (rest as any).relevantContextRefs = [(rest as any).relevantContextRefs.trim()];
        }
        if (typeof relevantContext !== "string" || !relevantContext.trim() || relevantContext.length > 4000) throw invalid();
        if ("type" in rest) throw invalid();
        if (typeof rest.definitionId === "string" && assignedSpecialists.has(rest.definitionId)) throw invalid();
        if (typeof rest.definitionId === "string") assignedSpecialists.add(rest.definitionId);
        const validated = validateMaestroDecision({ type: "delegate", ...rest }, { ...context, availableIntents: ["delegate"] });
        if (validated.type !== "delegate") throw invalid();
        const { type, ...draft } = validated;
        const cleanContext = sanitizeReasoningAndSecrets(relevantContext);
        if (!cleanContext.trim()) throw invalid();
        if (assignmentId !== undefined && (typeof assignmentId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(assignmentId))) throw invalid();
        if (dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.length > 2
          || dependsOn.some(value => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)))) throw invalid();
        return { ...draft, assignmentId: (assignmentId as string | undefined) ?? `assignment-${assignmentIndex + 1}`,
          ...(Array.isArray(dependsOn) && dependsOn.length ? { dependsOn: dependsOn as string[] } : {}), relevantContext: cleanContext };
      });
      const assignmentIds = new Set(assignments.map(assignment => assignment.assignmentId));
      if (assignmentIds.size !== assignments.length || assignments.some(assignment =>
        (assignment.dependsOn ?? []).some(parent => !assignmentIds.has(parent) || parent === assignment.assignmentId))) throw invalid();
      const ready = new Set<string>();
      const unresolved = new Set(assignmentIds);
      while (unresolved.size) {
        const batch = [...unresolved].filter(id => (assignments.find(assignment => assignment.assignmentId === id)?.dependsOn ?? []).every(parent => ready.has(parent)));
        if (!batch.length) throw invalid();
        for (const id of batch) { ready.add(id); unresolved.delete(id); }
      }
      return { type: "delegate_text", independence, assignments };
    }
    if (intent === "request_user_input" && exact(["type", "question"])) {
      const question = text("question", 1000); if (question) return { type: "request_user_input", question };
    }
    const stringArray = (key: string, maxItems = 12): string[] | undefined => {
      let value = decision[key];
      if (value === null || value === undefined) {
        value = [];
      } else if (typeof value === "string") {
        value = value.trim() ? [value.trim()] : [];
      }
      if (!Array.isArray(value) || value.length > maxItems || value.some((entry) => typeof entry !== "string" || !entry.trim())) return undefined;
      const sanitized = value.map((entry) => sanitizeReasoningAndSecrets(entry).slice(0, 500));
      return sanitized.every((entry) => entry.trim()) ? sanitized : undefined;
    };
    if (intent === "respond" && (exact(["type", "message", "basis", "evidenceRefs"]) || exact(["type", "message", "basis"]) || exact(["type", "message"]))) {
      const message = text("message", 2000);
      const basis = typeof decision.basis === "string" ? decision.basis : "conversation";
      const evidenceRefs = stringArray("evidenceRefs") ?? [];
      if (message && (basis === "conversation" || basis === "project-evidence" || basis === "cannot-verify")) {
        if (basis === "cannot-verify" && context.projectEvidenceRequired && evidenceRefs.length === 0
          && (context.workspaceState?.status !== "OPEN" || context.assignableDefinitionIds?.length === 0)) {
          return { type: "respond", message: "I cannot verify current project information because no authorized project tools are available for this turn.",
            basis: "cannot-verify", evidenceRefs };
        }
        if (basis === "conversation" && evidenceRefs.length === 0 && !context.projectEvidenceRequired) {
          return { type: "respond", message, basis: "conversation", evidenceRefs };
        }
        if (decision.basis === "project-evidence" && evidenceRefs.length > 0) {
          const evidence = context.relevantEvidence ?? [];
          const authorizedIds = new Set(evidence.filter((entry) => {
            if (context.projectEvidenceRequired) return ["observed", "verified"].includes(String(entry.validity))
              && ["coding-tool", "tester-verification"].includes(entry.source.type);
            return ["observed", "verified", "confirmed"].includes(String(entry.validity));
          }).map((entry) => String(entry.id)));
          if (evidenceRefs.every((reference) => authorizedIds.has(reference))) {
            return { type: "respond", message, basis: "project-evidence", evidenceRefs };
          }
          throw invalid("insufficient-evidence");
        }
        throw invalid("insufficient-evidence");
      }
    }
    if (intent === "acquire_context" && exact(["type", "request", "contextKinds"])) {
      const request = text("request", 1000); const contextKinds = stringArray("contextKinds");
      if (request && contextKinds) return { type: "acquire_context", request, contextKinds };
    }
    if (intent === "use_capability" && exact(["type", "capability", "objective", "contextRefs"])) {
      const capability = text("capability", 200); const objective = text("objective", 1000); const contextRefs = stringArray("contextRefs");
      if (capability && objective && contextRefs) {
        if (!context.capabilityMetadata?.some((entry) => entry.name === decision.capability)) throw invalid("unavailable-capability");
        return { type: "use_capability", capability, objective, contextRefs };
      }
    }
    if (intent === "delegate" && (exact(["type", "definitionId", "objective", "relevantContextRefs", "constraints", "expectedOutcome", "evidenceExpectations"])
      || exact(["type", "definitionId", "objective", "relevantContextRefs", "constraints", "expectedOutcome", "evidenceExpectations", "requiredCapabilities"]))
      && typeof decision.definitionId === "string" && decision.definitionId.trim()) {
      const objective = text("objective", 2000); const expectedOutcome = text("expectedOutcome", 1000);
      const relevantContextRefs = stringArray("relevantContextRefs"); const constraints = stringArray("constraints");
      const evidenceExpectations = stringArray("evidenceExpectations");
      const requiredCapabilities = stringArray("requiredCapabilities", 4);
      if (objective && expectedOutcome && relevantContextRefs && constraints && evidenceExpectations && requiredCapabilities) {
        let defId = decision.definitionId;
        if (!context.assignableDefinitionIds?.includes(defId)) {
          const match = context.availableMediobots?.find((m) =>
            m.assignable && (m.name.toLowerCase() === defId.toLowerCase() || m.definitionId.toLowerCase() === defId.toLowerCase())
          );
          if (match) defId = match.definitionId;
        }
        if (!context.assignableDefinitionIds?.includes(defId)) throw invalid("unknown-delegation");
        if (requiredCapabilities.some(capability => !["text-inference", "web.search", "web.crawl", "terminal.execute", "agent.message", "filesystem.list", "filesystem.read", "filesystem.search", "filesystem.write"].includes(capability))) throw invalid("unavailable-capability");
        return { type: "delegate", definitionId: defId, objective, relevantContextRefs, constraints, expectedOutcome, evidenceExpectations,
          ...(requiredCapabilities.length ? { requiredCapabilities } : {}) };
      }
    }
    throw invalid();
}

export function createMaestroDefinition(world: InMemoryWorld, markdownDefinition: MarkdownMediobotDefinition): MediobotDefinition {
  return registerMaestroDefinition(world, markdownDefinition);
}

export interface MaestroDecisionResolver {
  resolveDecisions(options?: Readonly<Record<string, unknown>>): {
    readonly maestroDecisions: MaestroDecisionProvider;
    readonly codyDecisions: CodyDecisionProvider;
    readonly testerDecisions?: TesterDecisionProvider;
  } | undefined;
}

export class MaestroExecutionAdapter implements WorkerExecutionAdapter {
  private readonly executionEngine = new LangGraphExecutionEngine();
  private readonly codyDefinitionId: MediobotDefinitionId;
  private readonly cody: CodyExecutionAdapter;
  private readonly testerDefinitionId?: MediobotDefinitionId;
  private readonly tester?: TesterExecutionAdapter;
  private readonly decisions: MaestroDecisionProvider;
  private readonly runtime: WorkerRuntime;
  private readonly tools?: ToolRuntime;
  private readonly onUserMessage?: (message: string, identity: { readonly taskId: TaskId; readonly workerId: WorkerId; readonly respondingSpecialistId?: MediobotDefinitionId }) => void;
  private readonly onCodyDiagnostic?: (diagnostic: CodyToolDiagnostic) => void;
  private readonly onTesterDiagnostic?: (diagnostic: TesterToolDiagnostic) => void;
  private readonly decisionResolver?: MaestroDecisionResolver;
  private readonly skillCatalog?: ReadonlyArray<SkillMetadata>;
  private readonly completion?: TrustedCompletion;
  private readonly textExecution?: TextMediobotExecution;
  private readonly webExecution?: WebAgentExecution;
  private readonly durableTaskEngine?: DurableTaskEngine;
  private readonly checkpointDatabasePath: string;
  private readonly checkpointDatabase?: CheckpointDatabase;
  private readonly onSpecialistMessageEvent?: (event: SpecialistCommunicationEvent) => void;

  constructor(options: {
    readonly codyDefinitionId: MediobotDefinitionId;
    readonly cody: CodyExecutionAdapter;
    readonly testerDefinitionId?: MediobotDefinitionId;
    readonly tester?: TesterExecutionAdapter;
    readonly decisions: MaestroDecisionProvider;
    readonly runtime: WorkerRuntime;
    readonly tools?: ToolRuntime;
    readonly onUserMessage?: (message: string, identity: { readonly taskId: TaskId; readonly workerId: WorkerId; readonly respondingSpecialistId?: MediobotDefinitionId }) => void;
    readonly onCodyDiagnostic?: (diagnostic: CodyToolDiagnostic) => void;
    readonly onTesterDiagnostic?: (diagnostic: TesterToolDiagnostic) => void;
    readonly decisionResolver?: MaestroDecisionResolver;
    readonly skillCatalog?: ReadonlyArray<SkillMetadata>;
    readonly completion?: TrustedCompletion;
    readonly textExecution?: TextMediobotExecution;
    readonly webExecution?: WebAgentExecution;
    readonly durableTaskEngine?: DurableTaskEngine;
    readonly checkpointDatabasePath?: string;
    readonly checkpointDatabase?: CheckpointDatabase;
    readonly onSpecialistMessageEvent?: (event: SpecialistCommunicationEvent) => void;
  }) {
    this.codyDefinitionId = options.codyDefinitionId;
    this.cody = options.cody;
    this.testerDefinitionId = options.testerDefinitionId;
    this.tester = options.tester;
    this.decisions = options.decisions;
    this.runtime = options.runtime;
    this.tools = options.tools;
    this.onUserMessage = options.onUserMessage;
    this.onCodyDiagnostic = options.onCodyDiagnostic;
    this.onTesterDiagnostic = options.onTesterDiagnostic;
    this.decisionResolver = options.decisionResolver;
    this.skillCatalog = options.skillCatalog;
    this.completion = options.completion;
    this.textExecution = options.textExecution;
    this.webExecution = options.webExecution;
    this.durableTaskEngine = options.durableTaskEngine;
    this.checkpointDatabasePath = options.checkpointDatabasePath ?? ":memory:";
    this.checkpointDatabase = options.checkpointDatabase;
    this.onSpecialistMessageEvent = options.onSpecialistMessageEvent;
  }

  prepare(context: WorkerExecutionContext): WorkerExecutionPlan {
    const workspaceRoot = typeof context.options?.workspaceRoot === "string" ? context.options.workspaceRoot : undefined;
    if (!workspaceRoot) throw new Error("Maestro requires an explicitly selected project workspace");
    return { resourceIds: [], isControlSignal: error => error instanceof LangGraphInterruptedError
      && error.interrupts.some(interrupt => interrupt.value && typeof interrupt.value === "object"
        && !Array.isArray(interrupt.value) && (interrupt.value as Record<string, unknown>).kind === "user-pause"), execute: async (run) => {
      try { await this.execute(context, workspaceRoot, run); }
      finally {
        // Child executions are awaited inside execute; only after that wait
        // settles should the parent durable task/group become terminal.
        if (run.signal.aborted) {
          await this.durableTaskEngine?.cancelTask(context.taskId).catch(() => {});
          await Promise.all(this.runtime.activeTaskIds().map(async childTaskId => {
            if (context.world.inspect().tasks.find(task => task.id === childTaskId)?.parentTaskId === context.taskId) {
              await this.durableTaskEngine?.cancelTask(childTaskId).catch(() => {});
            }
          }));
        }
      }
    } };
  }

  /** Performs Maestro's semantic decision without creating a Task, Worker, or Goal. */
  async decideTurn(world: InMemoryWorld, definitionId: MediobotDefinitionId, goal: string,
    options: Readonly<Record<string, unknown>> | undefined, signal: AbortSignal): Promise<MaestroDecision> {
    const maestroDecisions = this.decisionResolver?.resolveDecisions(options)?.maestroDecisions ?? this.decisions;
    return maestroDecisions.decide(goal, this.createDecisionContext(world, definitionId, options), signal);
  }

  private createDecisionContext(world: InMemoryWorld, definitionId: MediobotDefinitionId,
    options: Readonly<Record<string, unknown>> | undefined): MaestroContext {
    const snapshot = world.inspect();
    const visibleDefinitions = snapshot.definitions.filter(definition => {
      const name = definition.name.trim().toLowerCase();
      // Older releases persisted generated IDs for these code-owned bootstrap
      // identities. Keep them in the world for durable recovery, but never offer
      // them as separate organizational members to a new model decision.
      return !((name === "maestro" && definition.role === "orchestration" && definition.id !== "maestro")
        || (name === "vision" && definition.role === "visual-browser" && definition.id !== "vision"));
    });
    const maestroDefinition = snapshot.definitions.find((definition) => definition.id === definitionId);
    const requestedSpeakerId = typeof options?.specialistConversationId === "string"
      ? options.specialistConversationId : undefined;
    const responseSpecialist = requestedSpeakerId
      ? snapshot.definitions.find((definition) => definition.id === requestedSpeakerId
        && ["Software engineering", "doc", "research", "tester"].includes(definition.role))
      : undefined;
    const workspaceRoot = typeof options?.workspaceRoot === "string" ? options.workspaceRoot : undefined;
    const workspaceExecutionAuthorized = typeof options?.workspaceExecutionAuthorized === "boolean"
      ? options.workspaceExecutionAuthorized
      : Boolean(workspaceRoot);
    const assignableDefinitionIds = !workspaceExecutionAuthorized ? []
      : [
          ...(this.textExecution?.definitionIds ?? (snapshot.definitions.some((definition) => definition.id === this.codyDefinitionId) ? [this.codyDefinitionId] : [])),
          ...(this.webExecution?.definitionIds ?? []),
        ].filter((id, index, self) => self.indexOf(id) === index
          && snapshot.definitions.some(definition => definition.id === id && definition.lifecycleState === "active"));
    const recentHistory = parseHistory(typeof options?.recentHistory === "string" ? options.recentHistory : undefined);
    const projectName = typeof options?.projectName === "string" ? options.projectName : undefined;
    const images = Array.isArray(options?.imageInputs) ? options.imageInputs as MaestroContext["images"] : undefined;
    const projectIntelligence = Array.isArray(options?.projectIntelligence) && options.projectIntelligence.length > 0
      ? options.projectIntelligence as MaestroContextSources["projectIntelligence"]
      : undefined;
    const workspaceState = (options?.workspaceState && typeof options.workspaceState === "object")
      ? options.workspaceState as MaestroContextSources["workspaceState"]
      : workspaceRoot
        ? { rootPath: workspaceRoot, ...(projectName ? { projectName } : {}) }
        : undefined;
    const toolMetadata = Array.isArray(options?.toolMetadata)
      ? options.toolMetadata as MaestroContextSources["toolMetadata"]
      : (this.tools || assignableDefinitionIds.includes(this.codyDefinitionId))
        ? DEFAULT_WORKSPACE_TOOL_METADATA
        : undefined;
    const capabilityMetadata = Array.isArray(options?.capabilityMetadata)
      ? options.capabilityMetadata as MaestroContextSources["capabilityMetadata"]
      : undefined;
    const relevantEvidence = Array.isArray(options?.relevantEvidence)
      ? options.relevantEvidence as MaestroContextSources["relevantEvidence"]
      : undefined;
    const relevantMemory = Array.isArray(options?.relevantMemory)
      ? options.relevantMemory.filter((record): record is MaestroContextRecord =>
        Boolean(record && typeof record === "object" && typeof (record as { name?: unknown }).name === "string"
          && typeof (record as { value?: unknown }).value === "string")).slice(0, 3)
      : undefined;
    const hasParallelExecution = Boolean(this.textExecution || this.webExecution);
    const testerAvailable = Boolean(this.tester || (this.tools && this.decisionResolver?.resolveDecisions(options)?.testerDecisions));
    return {
      availableIntents: !workspaceExecutionAuthorized
        ? ["respond", "request_user_input"]
        : hasParallelExecution ? ["respond", "request_user_input", "delegate", "delegate_text"] : ["respond", "request_user_input", "delegate"],
      definitionInstructions: responseSpecialist?.instructions ?? maestroDefinition?.instructions,
      ...(responseSpecialist ? { responseIdentity: { name: responseSpecialist.name, role: responseSpecialist.role,
        instructions: responseSpecialist.instructions } } : {}),
      skillCatalog: this.skillCatalog,
      availableMediobots: visibleDefinitions.map((definition) => {
        const isWebSpecialist = Boolean(this.webExecution?.definitionIds.includes(definition.id));
        const textOnlyAssignment = Boolean(this.textExecution && definition.id !== this.codyDefinitionId
          && assignableDefinitionIds.includes(definition.id));
        const executorCapabilities = [
          ...(textOnlyAssignment ? ["text-inference"] : []),
          ...(isWebSpecialist ? ["web.search", "web.crawl"] : []),
          ...(definition.id === this.testerDefinitionId && testerAvailable ? ["filesystem.list", "filesystem.read", "terminal.execute"] : []),
        ];
        const capabilities = executorCapabilities.length
          ? executorCapabilities
          : [...definition.declaredCapabilities.map((capability) => capability.name),
            ...(this.textExecution && definition.id === this.codyDefinitionId ? ["text-inference", "filesystem.list", "filesystem.read",
              "filesystem.search", "filesystem.write", "terminal.execute"] : [])];
        const description = isWebSpecialist
          ? definition.role === "scraapy"
            ? "Scraapy: discover and extract UI components, animations, and design references with open-source license verification via web intelligence."
            : definition.role === "doc"
              ? "Doc: retrieve and analyze authoritative official documentation, API references, and integration guides via web intelligence."
              : definition.role === "research"
                ? "Research: investigate project approaches, tradeoffs, and best practices with evidence backing via web intelligence."
                : sanitizeReasoningAndSecrets(definition.instructions).slice(0, 500)
          : textOnlyAssignment
            ? definition.role === "research"
              ? "Bounded text analysis of supplied context and tradeoffs; no web retrieval or tool execution in this assignment."
              : definition.role === "tester"
                ? testerAvailable ? "Tester provides critical independent review, verification, and edge-case analysis; it can inspect the selected workspace and execute approved tests with read-only isolation. Request terminal.execute when actual test execution is required." : "Tester provides critical independent review and edge-case analysis in supplied context; test execution is unavailable."
                : sanitizeReasoningAndSecrets(definition.instructions).slice(0, 500)
            : sanitizeReasoningAndSecrets(definition.instructions).slice(0, 500);
        return { definitionId: definition.id, name: definition.name, role: definition.role, description,
          assignable: assignableDefinitionIds.includes(definition.id), capabilities };
      }),
      assignableDefinitionIds, projectName, recentHistory, images,
      ...(typeof options?.reasoningEffort === "string" && ["low", "medium", "high", "extra", "max"].includes(options.reasoningEffort)
        ? { reasoningEffort: options.reasoningEffort as MaestroContextSources["reasoningEffort"] }
        : typeof (options?.modelSelection as any)?.reasoningEffort === "string" && ["low", "medium", "high", "extra", "max"].includes((options?.modelSelection as any).reasoningEffort)
          ? { reasoningEffort: (options?.modelSelection as any).reasoningEffort as MaestroContextSources["reasoningEffort"] }
          : {}),
      workspaceState, projectIntelligence, toolMetadata, capabilityMetadata,
      ...(relevantEvidence ? { relevantEvidence } : {}),
      ...(relevantMemory ? { relevantMemory } : {}),
    };
  }

  private async execute(context: WorkerExecutionContext, workspaceRoot: string, run: RunContext): Promise<void> {
    const durableEngine = (context.options?.durableTaskEngine as DurableTaskEngine | undefined) ?? this.durableTaskEngine;
    const resolved = this.decisionResolver?.resolveDecisions(context.options);
    const activeTester = (resolved?.testerDecisions && this.tools)
      ? new TesterExecutionAdapter({ tools: this.tools, decisions: resolved.testerDecisions, onDiagnostic: this.onTesterDiagnostic })
      : this.tester;
    const codyAdapter = (resolved?.codyDecisions && this.tools)
      ? new CodyExecutionAdapter({ tools: this.tools, decisions: resolved.codyDecisions, onDiagnostic: this.onCodyDiagnostic, durableTaskEngine: durableEngine })
      : this.cody;
    const hasParallelExecution = Boolean(this.textExecution || this.webExecution);
    const decision = context.options && Object.hasOwn(context.options, "maestroDecision")
      ? validateMaestroDecision(context.options.maestroDecision, {
        availableIntents: hasParallelExecution ? ["respond", "request_user_input", "delegate", "delegate_text"] : ["respond", "request_user_input", "delegate"],
        ...this.createDecisionContext(context.world, context.definitionId, context.options),
      })
      : await this.decideTurn(context.world, context.definitionId, context.goal, context.options, run.signal);
    if (durableEngine && (decision.type === "delegate_text" || decision.type === "delegate")) {
      // Preserve the exact validated assignment plan before any specialist
      // starts. Approval recovery can then resume its graph checkpoint without
      // asking Maestro to invent a replacement plan after process restart.
      const checkpoints = await durableEngine.getCheckpoints(context.taskId);
      const savedPlan = [...checkpoints].reverse().find(checkpoint => checkpoint.snapshot.kind === "maestro-assignment-plan-v1");
      if (!savedPlan) {
        const stepIndex = checkpoints.reduce((next, checkpoint) => Math.max(next, checkpoint.stepIndex + 1), 0);
        await durableEngine.recordCheckpoint(context.taskId, stepIndex, {
          kind: "maestro-assignment-plan-v1",
          decision,
        });
      }
    }
    if (decision.type === "respond" || decision.type === "request_user_input") {
      const message = decision.type === "respond" ? decision.message : decision.question;
      context.world.recordEvidence({ taskId: context.taskId, workerId: context.workerId,
        source: { type: "maestro-response", reference: String(context.taskId) }, content: message });
      this.onUserMessage?.(message, { taskId: context.taskId, workerId: context.workerId });
      run.emit("worker.finished");
      return;
    }
    // LangGraph also supports deterministic in-memory workflows (tests and
    // ephemeral callers); durable child records are added only when configured.
    const langGraphExecutionAvailable = Boolean(this.textExecution || this.webExecution);
    if (langGraphExecutionAvailable && (decision.type === "delegate_text" || decision.type === "delegate")) {
      const drafts = (decision.type === "delegate_text" ? decision.assignments : [{ ...decision, relevantContext: decision.objective }])
        .map((draft, index) => {
          const assignmentId = draft.assignmentId ?? `assignment-${index + 1}`;
          return { ...draft, assignmentId, executionTaskId: stableAssignmentTaskId(context.taskId,
            draft.definitionId, assignmentId, draft.objective) };
        });
      const directCodyAssignmentIds = decision.type === "delegate" && decision.definitionId === this.codyDefinitionId
        ? new Set(drafts.map(draft => draft.assignmentId!)) : new Set<string>();
      const groups = new Map<"text" | "web" | "tester" | "cody", TextAssignmentDraft[]>();
      const unavailable: string[] = [];
      const unavailableByAssignment = new Map<string, string>();
      for (const draft of drafts) {
        const required = draft.requiredCapabilities ?? [];
        const definition = context.world.inspect().definitions.find(d => d.id === draft.definitionId);
        const candidates: Array<{ kind: "text" | "web" | "tester" | "cody"; capabilities: ReadonlyArray<string>; available: boolean }> = [
          { kind: "text", capabilities: ["text-inference"], available: Boolean(this.textExecution?.definitionIds.includes(draft.definitionId as MediobotDefinitionId)) },
          { kind: "web", capabilities: ["text-inference", "web.search", "web.crawl"], available: Boolean(this.webExecution?.definitionIds.includes(draft.definitionId as MediobotDefinitionId)) },
          { kind: "tester", capabilities: ["text-inference", "filesystem.list", "filesystem.read", "terminal.execute"], available: Boolean(activeTester && draft.definitionId === this.testerDefinitionId) },
          { kind: "cody", capabilities: ["text-inference", "agent.message", "filesystem.list", "filesystem.read", "filesystem.search", "filesystem.write", "terminal.execute"],
            available: Boolean(durableEngine && draft.definitionId === this.codyDefinitionId) },
        ];
        const chosen = required.length
          ? candidates.find(candidate => candidate.available && required.every(capability => candidate.capabilities.includes(capability)))
          : directCodyAssignmentIds.has(draft.assignmentId!)
            ? candidates.find(candidate => candidate.kind === "cody" && candidate.available)
          : definition?.role === "scraapy" && candidates[1]!.available ? candidates[1]
            : candidates.find(candidate => candidate.available && candidate.kind === "text");
        if (!chosen) {
          const closest = candidates.filter(candidate => candidate.available).sort((left, right) =>
            right.capabilities.filter(capability => required.includes(capability)).length
              - left.capabilities.filter(capability => required.includes(capability)).length)[0];
          const missing = (required.length ? required : ["text-inference"])
            .filter(capability => !closest?.capabilities.includes(capability));
          const detail = missing.length ? `missing: ${missing.join(", ")}`
            : `no single executor supports the required combination (${required.join(", ")})`;
          const reason = `${definition?.name ?? draft.definitionId}: required capabilities unavailable (${detail}).`;
          unavailable.push(reason);
          unavailableByAssignment.set(draft.assignmentId!, reason);
          continue;
        }
        const group = groups.get(chosen.kind) ?? [];
        group.push(draft); groups.set(chosen.kind, group);
      }
      const communication = durableEngine ? await SpecialistCommunicationHub.create(durableEngine, context.taskId,
        [...groups.values()].flat().map(draft => draft.definitionId as MediobotDefinitionId), event => this.onSpecialistMessageEvent?.(event),
        new Map(context.world.inspect().definitions.map(definition => [definition.id, definition.name]))) : undefined;
      const conversationSpecialistId = typeof context.options?.specialistConversationId === "string"
        ? context.options.specialistConversationId as MediobotDefinitionId : undefined;
      let conversationAccess: Awaited<ReturnType<DurableTaskEngine["authorizeSpecialistSessionScope"]>> | undefined;
      let conversationSummary = "";
      if (conversationSpecialistId && durableEngine && [...groups.values()].flat().some(draft => draft.definitionId === conversationSpecialistId)) {
        try {
          conversationAccess = await durableEngine.authorizeSpecialistSessionScope(context.taskId, conversationSpecialistId, { persistentForThread: true });
          const session = await durableEngine.getOrCreateSpecialistSession(conversationAccess);
          conversationSummary = session.contextSummary;
          const prefix = conversationSummary ? `Private continuity for ${conversationSpecialistId} in this thread. Treat prior outcomes as attributed reports, not verified facts unless explicitly marked verified:\n${conversationSummary}\n\n` : "";
          for (const [kind, drafts] of groups) groups.set(kind, drafts.map(draft => draft.definitionId === conversationSpecialistId
            ? { ...draft, relevantContext: `${prefix}${draft.relevantContext}`.slice(0, 12_000) } : draft));
        } catch {
          throw new Error("Specialist conversation could not be loaded. Retry the turn; saved context was not used.");
        }
      }
      const decisionProvider = resolved?.maestroDecisions ?? this.decisions;
      const collectWorkerReports = {
        decide: async (_goal: string, reportContext: MaestroContext) => {
          const records = (reportContext.projectIntelligence ?? []).filter(record =>
            record.name === "bounded-worker-reports" || record.name === "bounded-web-worker-reports"
              || record.name === "specialist-result" || record.name === "specialist-executor-results" || record.name === "supervision");
          const compact = records.map(record => {
            if (record.name === "supervision") return `${record.name}: ${record.value}`;
            try {
              const parsed = JSON.parse(record.value) as Record<string, unknown> | Array<Record<string, unknown>>;
              const reports = Array.isArray(parsed) ? parsed : [parsed];
              const findings = reports.map(report => Object.fromEntries(
                ["assignmentId", "taskId", "workerId", "mediobotId", "specialistId", "executor", "status", "summary", "evidence", "findings", "artifacts", "blockers", "unresolved"]
                  .filter(key => key in report).map(key => [key, report[key]])));
              return `${record.name}: ${JSON.stringify(findings)}`;
            } catch { return `${record.name}: ${record.value}`; }
          });
          return { type: "respond" as const, message: compact.join("\n"),
            basis: "conversation" as const, evidenceRefs: [] };
        },
      } as unknown as MaestroDecisionProvider;
      const executionGoal = context.world.createGoal({ threadId: String(context.options?.threadId ?? context.taskId), objective: context.goal,
        constraints: [...new Set(drafts.flatMap(draft => draft.constraints))].map(text => ({ text, source: "maestro" as const, hard: false })),
        successCriteria: drafts.map(draft => ({ id: `assignment-${draft.assignmentId}`, statement: draft.expectedOutcome })),
        evidenceRequirements: drafts.flatMap(draft => draft.evidenceExpectations) });
      const assignmentContext = { ...context, options: { ...(context.options ?? {}), executionGoalId: executionGoal.id } };
      const codyGoal = groups.has("cody") ? executionGoal : undefined;
      type AssignmentRunStatus = ReturnType<typeof statusFromAssignmentReports>;
      type SpecialistGroupInput = { readonly kind: "text" | "web" | "tester" | "cody" | "unavailable";
        readonly assignment: TextAssignmentDraft; readonly continuationOfTaskId?: TaskId; readonly privateSupportAssignment?: boolean;
        readonly runtimeAuthorized?: boolean };
      const authorizedDynamicInputs = new Map<string, string>();
      const supportRequests = new Map<string, string>();
      const initialGraphTaskCount = [...groups.values()].reduce((count, assignments) => count + assignments.length, unavailable.length);
      const supportExecutorFor = (definitionId: string, capability: string): SpecialistGroupInput["kind"] | undefined => {
        if (capability === "text-inference" && this.textExecution?.definitionIds.includes(definitionId as MediobotDefinitionId)) return "text";
        if ((capability === "web.search" || capability === "web.crawl")
          && this.webExecution?.definitionIds.includes(definitionId as MediobotDefinitionId)) return "web";
        if ((capability === "terminal.execute" || capability === "filesystem.list" || capability === "filesystem.read")
          && activeTester && definitionId === this.testerDefinitionId) return "tester";
        if ((capability === "filesystem.read" || capability === "filesystem.search")
          && durableEngine && definitionId === this.codyDefinitionId) return "cody";
        return undefined;
      };
      const runGroup = async (kind: "text" | "web" | "tester" | "cody", group: TextAssignmentDraft[],
        interruptTask?: (value: unknown) => unknown, isControlSignal?: (error: unknown) => boolean,
        addDynamicTask?: (input: SpecialistGroupInput) => Promise<string>,
        runDynamicTasks?: (inputs: ReadonlyArray<SpecialistGroupInput>) => Promise<ReadonlyArray<{ kind: string; assignmentId: string; status: AssignmentRunStatus; result: string }>>,
        addDynamicTasks?: (inputs: ReadonlyArray<SpecialistGroupInput>) => Promise<ReadonlyArray<string>>,
        continuationOfTaskId?: TaskId,
        privateSupportAssignment = false,
        runtimeAuthorized = false): Promise<{ kind: string; assignmentId: string; status: AssignmentRunStatus; result: string }> => {
        const isWorkflowControlSignal = (error: unknown) => isControlSignal?.(error) === true || error instanceof LangGraphInterruptedError;
        try {
          let executionAssignmentContext: WorkerExecutionContext = assignmentContext;
          if (durableEngine && kind !== "cody") for (const draft of group) {
            const childTaskId = draft.executionTaskId;
            if (!childTaskId) throw new Error("Specialist assignment is missing its durable identity.");
            const definition = context.world.inspect().definitions.find(item => item.id === draft.definitionId);
            if (!definition) throw new Error("Assigned specialist is unavailable.");
            const modelSelections = context.options?.assignmentModelSelections && typeof context.options.assignmentModelSelections === "object"
              ? context.options.assignmentModelSelections as Record<string, unknown> : undefined;
            const assignmentOverride = modelSelections && Object.hasOwn(modelSelections, draft.assignmentId!)
              ? modelSelections[draft.assignmentId!]
              : modelSelections && Object.hasOwn(modelSelections, draft.definitionId) ? modelSelections[draft.definitionId] : undefined;
            const existingChild = await durableEngine.getTask(childTaskId);
            const savedSelection = existingChild ? await durableEngine.getTaskModelSelection(childTaskId) : undefined;
            const modelSelection = resolveDurableChildModelSelection({ childExists: existingChild !== null,
              savedSelection, assignmentOverride, parentSelection: context.options?.modelSelection });
            if (existingChild && !savedSelection && ["queued", "running", "paused", "interrupted", "waiting_approval"].includes(existingChild.status)) {
              throw new Error(`${definition.name} has no persisted provider/model selection; refusing to resume with a different model.`);
            }
            const submitted = await durableEngine.submitTask({ id: childTaskId,
              workspaceId: typeof context.options?.workspaceId === "string" ? context.options.workspaceId : null,
              threadId: typeof context.options?.threadId === "string" ? context.options.threadId : undefined,
              turnId: typeof context.options?.turnId === "string" ? context.options.turnId : undefined,
              goal: draft.objective, definitionId: draft.definitionId, modelSelection });
            if (modelSelection) executionAssignmentContext = { ...assignmentContext, options: {
              ...(assignmentContext.options ?? {}),
              modelSelection,
              ...(modelSelection.reasoningEffort ? { reasoningEffort: modelSelection.reasoningEffort } : {}),
              assignmentModelSelections: {
                ...(modelSelections ?? {}),
                [draft.assignmentId!]: modelSelection,
              },
            } };
            const rows = await durableEngine.getDelegations(context.taskId);
            const membership = rows.find(entry => entry.assignedMediobotId === draft.definitionId);
            if (membership) {
              if (membership.childTaskId !== childTaskId) await durableEngine.updateDelegation(membership.id, { childTaskId });
            } else await durableEngine.recordDelegation(context.taskId, { parentTaskId: context.taskId, childTaskId,
              assignedMediobotId: draft.definitionId, assignedMediobotName: definition.name, objective: draft.objective, status: "active" });
            if (submitted.task.status === "queued") await durableEngine.startTask(childTaskId);
            else if (submitted.task.status === "paused") await durableEngine.resumeFromUserPause(childTaskId);
            else if (submitted.task.status === "interrupted" && kind !== "tester") await durableEngine.resumeTask(childTaskId);
            else if (["completed", "failed", "cancelled", "running", "interrupted"].includes(submitted.task.status)) {
              const saved = submitted.task.status === "completed"
                ? (await durableEngine.getEvidence(childTaskId)).find(entry => entry.kind === "worker-report") : undefined;
              const status: AssignmentRunStatus = saved ? "completed" : submitted.task.status === "cancelled" ? "cancelled" : "blocked";
              return { kind, assignmentId: draft.assignmentId!, status, result: saved?.content ?? JSON.stringify({ status,
                summary: `Prior ${kind} execution is ${submitted.task.status}; it was not repeated.`, blockers: ["Durable report unavailable or execution is not safely resumable."], evidence: [], unresolved: [] }) };
            }
          }
          if (runtimeAuthorized) {
            if (!communication) throw new Error("Runtime specialist expansion requires an active collaboration group.");
            const definition = context.world.inspect().definitions.find(item => item.id === group[0]!.definitionId);
            if (!definition) throw new Error("Runtime specialist is no longer available.");
            await communication.addAuthorizedParticipant(group[0]!.definitionId as MediobotDefinitionId, definition.name);
          }
          const persistReports = async (result: string) => {
            if (!durableEngine || kind === "cody") return;
            for (const line of result.split("\n")) {
              let value: Record<string, unknown>;
              try { value = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
              if (typeof value.taskId !== "string" || !group.some(draft => draft.executionTaskId === value.taskId)) continue;
              await durableEngine.recordEvidence(value.taskId, { kind: "worker-report", source: { type: "maestro-assignment", reference: String(value.assignmentId ?? "") },
                claim: typeof value.summary === "string" ? value.summary.slice(0, 2_000) : "Specialist execution report", content: line.slice(0, 12_000), validity: "observed" });
              const delegation = (await durableEngine.getDelegations(context.taskId)).find(entry => entry.childTaskId === value.taskId);
              const status = value.status === "completed" ? "completed" : value.status === "cancelled" ? "cancelled" : "failed";
              if (delegation && delegation.status !== status) await durableEngine.updateDelegation(delegation.id, { status });
            }
          };
          const assignmentCommunication = privateSupportAssignment ? undefined : communication;
          if (kind === "web" && this.webExecution) { const result = await this.webExecution.execute(executionAssignmentContext, run, group, collectWorkerReports, this.createDecisionContext(context.world, context.definitionId, context.options), assignmentCommunication); return { kind, assignmentId: group[0]!.assignmentId!, status: statusFromAssignmentReports(result), result }; }
          if (kind === "text" && this.textExecution) { const result = await this.textExecution.execute(executionAssignmentContext, run, group, collectWorkerReports, this.createDecisionContext(context.world, context.definitionId, context.options), assignmentCommunication); return { kind, assignmentId: group[0]!.assignmentId!, status: statusFromAssignmentReports(result), result }; }
          if (kind === "tester" && activeTester && this.testerDefinitionId) {
            const testerDefinitionId = this.testerDefinitionId;
            const goal = executionGoal;
            const reports = await Promise.all(group.map(async draft => {
              run.signal.throwIfAborted();
              // Tester owns a model-backed decision loop too. Resolve its client
              // from the same durable assignment selection used by the other
              // specialists; the adapter created at turn start only reflects
              // Maestro's parent selection.
              const assignment = context.world.createAssignment({ goalId: goal.id, targetDefinitionId: testerDefinitionId,
                objective: draft.objective, relevantContext: draft.relevantContext, relevantContextRefs: draft.relevantContextRefs,
                constraints: draft.constraints, expectedOutcome: draft.expectedOutcome, evidenceExpectations: draft.evidenceExpectations });
              const worker = context.world.spawnWorker(testerDefinitionId);
              const task = context.world.assignTask(context.world.createTask(assignment.objective, context.taskId, draft.executionTaskId).id, worker.id);

              const assignmentSelections = executionAssignmentContext.options?.assignmentModelSelections
                && typeof executionAssignmentContext.options.assignmentModelSelections === "object"
                ? executionAssignmentContext.options.assignmentModelSelections as Record<string, unknown> : undefined;
              const testerSelection = assignmentSelections && Object.hasOwn(assignmentSelections, draft.assignmentId!)
                ? assignmentSelections[draft.assignmentId!]
                : assignmentSelections && Object.hasOwn(assignmentSelections, draft.definitionId)
                  ? assignmentSelections[draft.definitionId] : undefined;
              const hasTesterRouting = executionAssignmentContext.options?.assignmentModelSelections !== undefined;
              const effectiveTesterRaw = testerSelection !== undefined
                ? testerSelection
                : hasTesterRouting ? undefined : executionAssignmentContext.options?.modelSelection;
              const parsedTesterSelection = readModelSelection(effectiveTesterRaw);
              if (this.decisionResolver && !parsedTesterSelection) {
                context.world.setTaskState(task.id, "failed");
                return JSON.stringify({ definitionId: draft.definitionId, assignmentId: assignment.id, workerId: worker.id, taskId: task.id,
                  status: "blocked", summary: "Tester was blocked: no explicit model selection was configured.", findings: [] });
              }
              const testerOptions = {
                ...(executionAssignmentContext.options ?? {}),
                modelSelection: parsedTesterSelection,
                ...(parsedTesterSelection?.reasoningEffort ? { reasoningEffort: parsedTesterSelection.reasoningEffort } : {}),
              };
              const selectedTester = this.decisionResolver?.resolveDecisions(testerOptions)?.testerDecisions;
              const tester = selectedTester && this.tools
                ? new TesterExecutionAdapter({ tools: this.tools, decisions: selectedTester, onDiagnostic: this.onTesterDiagnostic })
                : activeTester;
              run.emit("maestro.worker-assigned", undefined, { assignedWorkerId: worker.id, assignedDefinitionId: testerDefinitionId,
                executionTaskId: task.id, assignmentObjective: draft.objective });
              const plan = tester.prepare({ world: context.world, definitionId: testerDefinitionId, workerId: worker.id,
                taskId: task.id, goal: `${draft.objective}\nExpected outcome: ${draft.expectedOutcome}\nContext: ${draft.relevantContext}`,
                options: { ...testerOptions, workspaceRoot } });
              const cancel = () => { try { this.runtime.cancel(task.id); } catch { /* Registration may still be in progress. */ } };
              run.signal.addEventListener("abort", cancel, { once: true });
              try {
                if (run.signal.aborted) { context.world.setTaskState(task.id, "cancelled"); return JSON.stringify({ definitionId: draft.definitionId,
                  assignmentId: assignment.id, workerId: worker.id, taskId: task.id, status: "cancelled", summary: "Tester assignment cancelled." }); }
                await this.runtime.run({ ...plan, taskId: task.id, workerId: worker.id,
                  workspaceId: typeof context.options?.workspaceId === "string" ? context.options.workspaceId : null,
                  onEvent: event => run.forward(event) });
                run.signal.throwIfAborted();
                const evidence = context.world.inspect().evidence.filter(entry => entry.taskId === task.id && entry.workerId === worker.id
                  && (entry.source.type === "tester-report" || entry.source.type === "tester-verification"));
                return JSON.stringify({ definitionId: draft.definitionId, assignmentId: assignment.id, workerId: worker.id, taskId: task.id,
                  status: "completed", summary: "Tester assignment completed.", findings: evidence.map(entry => entry.content) });
              } catch (error) {
                const status = run.signal.aborted ? "cancelled" : "failed";
                context.world.setTaskState(task.id, status);
                return JSON.stringify({ definitionId: draft.definitionId, assignmentId: assignment.id, workerId: worker.id, taskId: task.id, status,
                  summary: status === "cancelled" ? "Tester assignment cancelled." : "Tester assignment failed.",
                  blocker: error instanceof Error ? error.message : "Tester execution failed" });
              } finally { run.signal.removeEventListener("abort", cancel); }
            }));
            const result = reports.join("\n");
            await persistReports(result);
            return { kind, assignmentId: group[0]!.assignmentId!, status: statusFromAssignmentReports(result), result };
          }
          if (kind === "cody") {
            const reports = await Promise.all(group.map(async (draft, index) => {
              const modelSelections = context.options?.assignmentModelSelections && typeof context.options.assignmentModelSelections === "object"
                ? context.options.assignmentModelSelections as Record<string, unknown> : undefined;
              const modelOverride = modelSelections && Object.hasOwn(modelSelections, draft.definitionId)
                ? modelSelections[draft.definitionId]
                : modelSelections && Object.hasOwn(modelSelections, this.codyDefinitionId) ? modelSelections[this.codyDefinitionId] : undefined;
              const assignment = context.world.createAssignment({ goalId: codyGoal!.id,
                targetDefinitionId: this.codyDefinitionId, objective: draft.objective, relevantContext: draft.relevantContext,
                relevantContextRefs: draft.relevantContextRefs, constraints: draft.constraints, expectedOutcome: draft.expectedOutcome,
                evidenceExpectations: draft.evidenceExpectations });
              const worker = context.world.spawnWorker(this.codyDefinitionId);
              const task = context.world.assignTask(context.world.createTask(
                `${draft.objective}\nExpected outcome: ${draft.expectedOutcome}\nContext: ${draft.relevantContext}`,
                context.taskId,
                continuationOfTaskId
                  ? stableAssignmentTaskId(context.taskId, this.codyDefinitionId, draft.assignmentId!, draft.objective)
                  : stableSpecialistTaskId(context.taskId, this.codyDefinitionId,
                    drafts.findIndex(entry => entry.definitionId === draft.definitionId && entry.objective === draft.objective), draft.objective),
              ).id, worker.id);
              run.emit("maestro.worker-assigned", undefined, { assignedWorkerId: worker.id, assignedDefinitionId: this.codyDefinitionId,
                executionTaskId: task.id, assignmentObjective: draft.objective });
              const permissionEngine = this.tools?.getPermissionEngine();
              const parentPermissionContext = permissionEngine?.getTaskContext(context.taskId);
              permissionEngine?.bindTaskContext(task.id, { ...parentPermissionContext, parentTaskId: context.taskId });
              // A stable durable child keeps its original model identity across recovery.
              // Only a new child may inherit the current parent model or assignment override.
              const existingChild = durableEngine ? await durableEngine.getTask(task.id) : null;
              const savedChildSelection = existingChild ? await durableEngine!.getTaskModelSelection(task.id) : undefined;
              const hasAssignmentRouting = context.options?.assignmentModelSelections !== undefined;
              const modelSelection = resolveDurableChildModelSelection({ childExists: existingChild !== null,
                savedSelection: savedChildSelection, assignmentOverride: modelOverride, parentSelection: context.options?.modelSelection,
                allowParentFallback: !hasAssignmentRouting });
              if (this.decisionResolver && !modelSelection) {
                context.world.setTaskState(task.id, "failed");
                return JSON.stringify({ definitionId: draft.definitionId, assignmentId: assignment.id, taskId: task.id,
                  workerId: worker.id, status: "blocked", summary: "Cody was blocked: no explicit model selection was configured.", blockers: ["No configured model selection for Cody."] });
              }
              if (durableEngine) {
                const submitted = await durableEngine.submitTask({ id: task.id, workspaceId: (context.options?.workspaceId as string | undefined) ?? null,
                  threadId: typeof context.options?.threadId === "string" ? context.options.threadId : undefined,
                  turnId: typeof context.options?.turnId === "string" ? context.options.turnId : undefined,
                goal: task.goal, definitionId: this.codyDefinitionId, modelSelection });
                if (submitted.task.status === "queued") await durableEngine.startTask(task.id);
                else if (submitted.task.status === "interrupted") await durableEngine.resumeTask(task.id);
                else if (submitted.task.status === "paused") await durableEngine.resumeFromUserPause(task.id);
                else if (submitted.task.status === "completed") {
                  const evidence = await durableEngine.getEvidence(task.id);
                  const summary = evidence.find(entry => entry.kind === "model-summary")?.content ?? "Cody completed this assignment before recovery.";
                  const executionEvidence = evidence.filter(entry => {
                    const sourceType = entry.source?.type;
                    return ["coding-tool", "workspace-diff", "coding-verification"].includes(String(sourceType))
                      && ["observed", "verified"].includes(entry.validity)
                      && typeof entry.content === "string";
                  }).slice(0, 12);
                  const currentEvidence = context.world.inspect().evidence;
                  for (const entry of executionEvidence) {
                    const sourceType = String(entry.source.type);
                    const sourceReference = typeof entry.source.reference === "string" ? entry.source.reference : "";
                    const alreadyRestored = currentEvidence.some(item => item.taskId === task.id
                      && item.workerId === worker.id && item.kind === entry.kind
                      && item.source.type === sourceType && item.source.reference === sourceReference);
                    if (alreadyRestored) continue;
                    context.world.recordEvidence({ taskId: task.id, workerId: worker.id,
                      source: { type: sourceType, reference: sourceReference }, kind: entry.kind,
                      ...(entry.claim ? { claim: entry.claim } : {}), content: entry.content, validity: entry.validity });
                  }
                  context.world.setTaskState(task.id, "completed");
                  const delegation = (await durableEngine.getDelegations(context.taskId)).find(entry => entry.childTaskId === task.id);
                  if (delegation && delegation.status !== "completed") await durableEngine.updateDelegation(delegation.id, { status: "completed" });
                  return JSON.stringify({ definitionId: draft.definitionId, assignmentId: assignment.id, taskId: task.id,
                    workerId: worker.id, status: "completed", summary,
                    evidence: executionEvidence.slice(0, 6).map(entry => sanitizeReasoningAndSecrets(entry.content).slice(0, 350)) });
                } else if (submitted.task.status === "cancelled" || submitted.task.status === "failed") {
                  context.world.setTaskState(task.id, submitted.task.status);
                  const delegation = (await durableEngine.getDelegations(context.taskId)).find(entry => entry.childTaskId === task.id);
                  if (delegation && delegation.status !== submitted.task.status) {
                    await durableEngine.updateDelegation(delegation.id, { status: submitted.task.status });
                  }
                  return JSON.stringify({ definitionId: draft.definitionId, assignmentId: assignment.id, taskId: task.id,
                    workerId: worker.id, status: submitted.task.status, blocker: "The durable Cody assignment is terminal and requires a new parent task." });
                }
                const delegations = await durableEngine.getDelegations(context.taskId);
                const delegation = delegations.find(entry => entry.childTaskId === task.id);
                if (delegation) await durableEngine.updateDelegation(delegation.id, { status: "active" });
                else await durableEngine.recordDelegation(context.taskId, { parentTaskId: context.taskId, childTaskId: task.id,
                  assignedMediobotId: this.codyDefinitionId, assignedMediobotName: "Cody", objective: draft.objective, status: "active" });
              }
              const communicationPort = privateSupportAssignment ? undefined : communication?.open(this.codyDefinitionId, task.id, worker.id);
              const supportCandidates = (continuationOfTaskId ? [] : context.world.inspect().definitions)
                .filter(definition => ![...groups.values()].flat().some(assigned => assigned.definitionId === definition.id))
                .map(definition => {
                  const capabilities = ["text-inference", "web.search", "web.crawl", "terminal.execute", "filesystem.read", "filesystem.search"]
                    .filter(capability => supportExecutorFor(definition.id, capability));
                  return capabilities.length ? definition.id + " (" + definition.name + "): " + capabilities.join(", ") : "";
                }).filter(Boolean).join("\n");
              let handoffRequested = false;
              let supportWorkspaceResourceId: WorkerExecutionPlan["resourceIds"][number] | undefined;
              let handoffOutcome: ReadonlyArray<{ kind: string; assignmentId: string; status: AssignmentRunStatus; result: string }> = [];
              const supportHandler = durableEngine && communication && runDynamicTasks && !continuationOfTaskId ? async (request: Record<string, unknown>) => {
                const definitionId = typeof request.definitionId === "string" ? request.definitionId : "";
                const capability = typeof request.capabilityNeeded === "string" ? request.capabilityNeeded : "";
                const query = typeof request.query === "string" ? request.query.trim().slice(0, 1_000) : "";
                const contextSnippet = typeof request.contextSnippet === "string" ? request.contextSnippet.trim().slice(0, 1_500) : "";
                const requestedAtStep = typeof request.requesterStep === "number" ? request.requesterStep : -1;
                const chosenKind = supportExecutorFor(definitionId, capability);
                const alreadyAssigned = [...groups.values()].flat().some(assigned => assigned.definitionId === definitionId);
                const anotherRequestActive = [...supportRequests.keys()].some(requesterId => requesterId !== task.id);
                if (request.requesterTaskId !== task.id || requestedAtStep < 0 || !query) return { decision: "rejected", reason: "Maestro rejected an invalid support request identity or payload." };
                if (!chosenKind || alreadyAssigned || definitionId === this.codyDefinitionId) return { decision: "rejected", reason: "Maestro could not authorize that specialist and capability combination. Continue with available evidence." };
                if (initialGraphTaskCount > 10 || anotherRequestActive) return { decision: "rejected", reason: "The workflow's bounded support task budget is exhausted." };
                const requestFingerprint = JSON.stringify([definitionId, capability, query, contextSnippet]);
                const priorRequest = supportRequests.get(task.id);
                if (priorRequest && priorRequest !== requestFingerprint) {
                  return { decision: "rejected", reason: "Only one distinct runtime support request is permitted for this Cody phase." };
                }
                supportRequests.set(task.id, requestFingerprint);
                const suffix = createHash("sha256").update(task.id + ":" + requestedAtStep + ":" + requestFingerprint).digest("hex").slice(0, 12);
                const helperId = "support-" + suffix;
                const helperDraft: TextAssignmentDraft = { assignmentId: helperId,
                  executionTaskId: stableAssignmentTaskId(context.taskId, definitionId, helperId, query),
                  definitionId, objective: query,
                  relevantContext: contextSnippet || "Bounded assistance requested by Cody for its current parent task.",
                  relevantContextRefs: [], constraints: ["Answer only the bounded request; do not perform unrelated work."],
                  expectedOutcome: "Return a concise answer with attributed findings and unresolved limits.",
                  evidenceExpectations: ["Provide source or tool evidence when available."], requiredCapabilities: [capability] };
                const helperInput: SpecialistGroupInput = { kind: chosenKind, assignment: helperDraft, runtimeAuthorized: true };
                const continuationId = `continue-${suffix}`;
                const continuationDraft: TextAssignmentDraft = { ...draft, assignmentId: continuationId,
                  executionTaskId: stableAssignmentTaskId(context.taskId, this.codyDefinitionId, continuationId, draft.objective),
                  dependsOn: [helperId] };
                const continuationInput: SpecialistGroupInput = { kind: "cody", assignment: continuationDraft,
                  continuationOfTaskId: task.id };
                authorizedDynamicInputs.set(helperId, JSON.stringify(helperInput));
                authorizedDynamicInputs.set(continuationId, JSON.stringify(continuationInput));
                // Run the bounded helper/continuation as a nested LangGraph branch.
                // LangGraph schedules in supersteps, so adding nodes to the parent
                // graph would wait for every current sibling before dispatching the
                // helper. Yield Cody's governor lease while the nested graph runs;
                // this lets the helper overlap independent parent branches.
                // The communication hub permits one live worker per specialist
                // in a parent task. Cody will return immediately after a successful
                // handoff, so release that identity before its distinct continuation
                // worker opens the same authorized specialist session. Release the
                // parent workspace binding so only the authorized child assignments
                // in this task scope can bind the same root during the handoff.
                if (!supportWorkspaceResourceId) return { decision: "rejected", reason: "Cody workspace lease is unavailable; continue with current evidence." };
                communication.closeWorker(this.codyDefinitionId, task.id);
                this.tools?.releaseWorkspace(supportWorkspaceResourceId);
                try {
                  handoffOutcome = await this.runtime.withYieldedExecutionSlot(task.id,
                    () => runDynamicTasks([helperInput, continuationInput]));
                } catch (error) {
                  await this.tools?.bindWorkspace(supportWorkspaceResourceId, workspaceRoot);
                  communication.open(this.codyDefinitionId, task.id, worker.id);
                  throw error;
                }
                const helperResult = handoffOutcome.find(outcome => outcome.assignmentId === helperId);
                const continuationResult = handoffOutcome.find(outcome => outcome.assignmentId === continuationId);
                if (!helperResult || helperResult.status !== "completed" || !continuationResult || continuationResult.status !== "completed") {
                  await this.tools?.bindWorkspace(supportWorkspaceResourceId, workspaceRoot);
                  communication.open(this.codyDefinitionId, task.id, worker.id);
                  const statuses = handoffOutcome.map(outcome => `${outcome.assignmentId}:${outcome.status}:${outcome.result.slice(0, 1_000)}`).join(" | ") || "no outcomes returned";
                  return { decision: "authorized", handoff: false,
                    answer: `The bounded support branch did not fully complete (${statuses}). Use returned evidence, continue safely, and report unresolved work truthfully.` };
                }
                handoffRequested = true;
                return { decision: "authorized", handoff: true,
                  answer: `The authorized ${definitionId} assignment completed and Cody's dependent continuation ran. Use its attributed findings in the final report.` };
              } : undefined;
              const actionSystem = supportCandidates
                ? "Authorized support candidates and exact capabilities:\n" + supportCandidates
                : "No additional support candidates are currently authorized.";
              const codyChildOptions = {
                ...(context.options ?? {}),
                modelSelection,
                ...(modelSelection?.reasoningEffort ? { reasoningEffort: modelSelection.reasoningEffort } : {}),
              };
              const codyChildDecisions = this.decisionResolver?.resolveDecisions(codyChildOptions)?.codyDecisions;
              const executingCodyAdapter = (codyChildDecisions && this.tools)
                ? new CodyExecutionAdapter({ tools: this.tools, decisions: codyChildDecisions, onDiagnostic: this.onCodyDiagnostic, durableTaskEngine: durableEngine })
                : codyAdapter;
              const plan = executingCodyAdapter.prepare({ world: context.world, definitionId: this.codyDefinitionId, workerId: worker.id, taskId: task.id,
                goal: task.goal + "\n\n" + actionSystem, options: { ...context.options, workspaceRoot, durableTaskEngine: durableEngine,
                  ...(supportHandler ? { supportHandler } : {}),
                  ...(modelSelection ? { modelSelection } : {}),
                  ...(modelSelection?.reasoningEffort ? { reasoningEffort: modelSelection.reasoningEffort } : {}),
                  parentTaskId: context.taskId,
                  resumeTaskId: continuationOfTaskId ?? task.id,
                  ...(interruptTask && isControlSignal ? { langGraphInterruptTask: interruptTask, isLangGraphControlSignal: isWorkflowControlSignal } : {}) },
                ...(communicationPort ? { specialistCommunication: communicationPort } : {}) });
              supportWorkspaceResourceId = plan.resourceIds[0];
              const cancel = () => { try { this.runtime.cancel(task.id); } catch { /* task may not have entered runtime yet */ } };
              run.signal.addEventListener("abort", cancel, { once: true });
              try {
                if (run.signal.aborted) {
                  context.world.setTaskState(task.id, "cancelled");
                  return JSON.stringify({ definitionId: draft.definitionId, assignmentId: assignment.id, taskId: task.id,
                    workerId: worker.id, status: "cancelled", summary: "Cody was cancelled before execution started." });
                }
                const result = await this.runtime.run({ ...plan, taskId: task.id, workerId: worker.id,
                  workspaceId: typeof context.options?.workspaceId === "string" ? context.options.workspaceId : null,
                  onEvent: event => run.forward(event) });
                const summary = context.world.inspect().evidence.find(entry => entry.taskId === task.id && entry.workerId === worker.id && entry.source.type === "cody-summary")?.content;
                if (durableEngine) {
                  const delegation = (await durableEngine.getDelegations(context.taskId)).find(entry => entry.childTaskId === task.id);
                  const terminalStatus = result.state === "completed" ? "completed" : result.state === "cancelled" ? "cancelled" : "failed";
                  if (delegation && delegation.status !== terminalStatus) {
                    await durableEngine.updateDelegation(delegation.id, { status: terminalStatus });
                  }
                  try {
                    if (result.state === "completed") await durableEngine.completeTask(task.id);
                    else if (result.state === "cancelled") await durableEngine.cancelTask(task.id, "Cody assignment cancelled");
                    else await durableEngine.failTask(task.id, { code: "cody-assignment-failed", message: "Cody assignment did not complete." });
                  } catch (error) {
                    // Runtime event delivery can persist the same terminal transition first.
                    const current = await durableEngine.getTask(task.id);
                    if (current?.status !== terminalStatus) throw error;
                  }
                }
                const yielded = handoffRequested || Boolean(summary?.includes("yielded after Maestro authorized"));
                const continuationSummary = handoffOutcome.length
                  ? "\nAuthorized dynamic assistance outcomes (attributed):\n" + [...handoffOutcome]
                    .sort((left, right) => Number(right.kind === "cody") - Number(left.kind === "cody"))
                    .map(outcome => {
                      let summary = outcome.result;
                      let evidence: string[] = [];
                      {
                        const marker = /bounded-(?:web-)?worker-reports:\s*/.exec(outcome.result);
                        const payload = marker ? outcome.result.slice(marker.index + marker[0].length) : outcome.result;
                        const parsed = parseFirstJsonValue(payload);
                        const reports = Array.isArray(parsed) ? parsed : [parsed];
                        const summaries: string[] = [];
                        for (const report of reports) {
                          if (!report || typeof report !== "object" || Array.isArray(report)) continue;
                          const record = report as Record<string, unknown>;
                          if (typeof record.summary === "string") summaries.push(record.summary);
                          if (Array.isArray(record.evidence)) evidence.push(...record.evidence
                            .filter((item): item is string => typeof item === "string"));
                        }
                        if (summaries.length) summary = summaries.join("; ");
                        evidence = evidence.slice(0, 2);
                      }
                      return `${outcome.assignmentId} (${outcome.kind}, ${outcome.status}): ${summary.slice(0, 300)}`
                        + (evidence.length ? ` Evidence: ${evidence.join("; ").slice(0, 180)}` : "");
                    }).join("\n")
                  : "";
                return JSON.stringify({ definitionId: draft.definitionId, assignmentId: draft.assignmentId, taskId: task.id, workerId: worker.id,
                  status: yielded ? "yielded" : result.state, summary: (summary ?? (result.state === "completed" ? "Cody completed the assignment."
                    : result.state === "failed" ? `Cody did not complete the assignment: ${result.error}` : "Cody assignment was cancelled.")) + continuationSummary });
              } finally {
                run.signal.removeEventListener("abort", cancel);
                communication?.closeWorker(this.codyDefinitionId, task.id);
              }
            }));
            const result = reports.join("\n");
            return { kind, assignmentId: group[0]!.assignmentId!, status: statusFromAssignmentReports(result), result };
          }
          const message = `${kind} executor unavailable.`;
          return { kind, assignmentId: group[0]!.assignmentId!, status: "blocked",
            result: JSON.stringify({ status: "blocked", summary: message, blockers: [message], evidence: [], unresolved: [] }) };
        } catch (error) {
          if (isWorkflowControlSignal(error)) throw error;
          const status = run.signal.aborted ? "cancelled" : "failed";
          const message = `${kind} executor failed: ${error instanceof Error ? error.message : "unknown error"}`;
          return { kind, assignmentId: group[0]!.assignmentId!, status,
            result: JSON.stringify({ status, summary: message, blockers: [message], evidence: [], unresolved: [] }) };
        }
      };
      let groupResults: Array<{ kind: string; assignmentId: string; status: AssignmentRunStatus; result: string }>;
      let sharedGroupHistory: Awaited<ReturnType<SpecialistCommunicationHub["readCoordinatorHistory"]>> = [];
      let communicationCloseStatus: "completed" | "failed" | "cancelled" | undefined;
      try {
        const { SqliteSaver } = await import("@langchain/langgraph-checkpoint-sqlite");
          const checkpoint = this.checkpointDatabase
            ? new SqliteSaver(checkpointDatabaseAdapter(this.checkpointDatabase) as never)
            : SqliteSaver.fromConnString(this.checkpointDatabasePath);
          try {
            const interruptedRun = Boolean(context.options?.resumeTaskId || context.options?.resumeChildTaskId);
            groupResults = [...await this.executionEngine.runParallel<SpecialistGroupInput, { kind: string; assignmentId: string; status: AssignmentRunStatus; result: string }>({
              workflowName: "maestro-specialist-groups",
              taskName: "run-specialist-group",
              threadId: String(context.taskId),
              namespace: "specialists",
              tasks: [
                ...[...groups.entries()].flatMap(([kind, assignments]) => assignments.map(assignment => ({ kind, assignment }))),
                ...drafts.filter(assignment => unavailableByAssignment.has(assignment.assignmentId!))
                  .map(assignment => ({ kind: "unavailable" as const, assignment })),
              ],
              taskId: item => item.assignment.assignmentId!,
              dependencies: item => item.assignment.dependsOn ?? [],
              checkpointer: checkpoint,
              outcomeStore: sqliteLangGraphOutcomeStore(checkpoint.db as never),
              signal: run.signal,
              shouldPause: typeof context.options?.shouldPauseTask === "function"
                ? context.options.shouldPauseTask as () => boolean : undefined,
              resume: interruptedRun,
              ...(context.options?.resumeValues && typeof context.options.resumeValues === "object"
                ? { resumeValues: context.options.resumeValues as Readonly<Record<string, unknown>> } : {}),
              authorizeTaskExpansion: async (parent, proposed, signal) => {
                signal?.throwIfAborted();
                if (parent.kind !== "cody") throw new Error("Only an active Cody assignment may request bounded runtime support.");
                const expected = authorizedDynamicInputs.get(proposed.assignment.assignmentId ?? "");
                if (!expected || expected !== JSON.stringify(proposed)) throw new Error("Runtime support assignment was not authorized by Maestro.");
                const capability = proposed.assignment.requiredCapabilities?.[0] ?? "";
                if (proposed.kind === "cody") {
                  if (!proposed.continuationOfTaskId || proposed.assignment.dependsOn?.length !== 1
                    || !authorizedDynamicInputs.has(proposed.assignment.dependsOn[0]!)) {
                    throw new Error("Cody continuation must be bound to the active task and an authorized prerequisite.");
                  }
                } else if (supportExecutorFor(proposed.assignment.definitionId, capability) !== proposed.kind
                  || proposed.runtimeAuthorized !== true) {
                  throw new Error("Runtime support executor does not satisfy the requested capability.");
                }
                signal?.throwIfAborted();
              },
              execute: async (item, _signal, outcomes, interruptTask, isControlSignal, addTask, runDynamicTasks, addDynamicTasks) => {
                run.signal.throwIfAborted();
                if (item.kind === "unavailable") {
                  const message = `Blocked: ${unavailableByAssignment.get(item.assignment.assignmentId!) ?? "required executor unavailable"}`;
                  return { kind: "unavailable", assignmentId: item.assignment.assignmentId!, status: "blocked",
                    result: JSON.stringify({ status: "blocked", summary: message, blockers: [message], evidence: [], unresolved: [] }) };
                }
                const prerequisites = (item.assignment.dependsOn ?? []).map(id => outcomes?.[id]).filter(Boolean);
                const failedPrerequisites = prerequisites.filter(outcome => outcome!.status !== "completed");
                if (failedPrerequisites.length) {
                  const message = "Blocked because prerequisite assignment(s) did not complete successfully: "
                    + failedPrerequisites.map(outcome => outcome!.assignmentId + ":" + outcome!.status).join(", ") + ".";
                  return { kind: item.kind, assignmentId: item.assignment.assignmentId!, status: "blocked",
                    result: JSON.stringify({ status: "blocked", summary: message, blockers: [message], evidence: [], unresolved: [] }) };
                }
                const prerequisiteReports = prerequisites
                  .map(outcome => `Prerequisite ${outcome!.assignmentId} (${outcome!.kind}): ${outcome!.result.slice(0, 8_000)}`);
                const assignment = prerequisiteReports.length ? { ...item.assignment,
                  relevantContext: `${item.assignment.relevantContext}\n\nPrerequisite specialist reports (attributed, not independently verified):\n${prerequisiteReports.join("\n\n")}`.slice(0, 12_000) } : item.assignment;
                return runGroup(item.kind, [assignment], interruptTask, isControlSignal, addTask,
                  runDynamicTasks, addDynamicTasks, item.continuationOfTaskId, item.privateSupportAssignment, item.runtimeAuthorized);
              },
            })];
          } finally {
            if (!this.checkpointDatabase) {
              try { checkpoint.db.close(); } catch { /* In-memory and already-closed saver cases are harmless. */ }
            }
          }
        sharedGroupHistory = await communication?.readCoordinatorHistory() ?? [];
        communicationCloseStatus = "completed";
      } catch (error) {
        communicationCloseStatus = run.signal.aborted ? "cancelled"
          : error instanceof LangGraphInterruptedError ? undefined : "failed";
        // Persist approval-to-interrupt linkage on the production grouped path
        // before the parent runtime records its waiting state.
        if (error instanceof LangGraphInterruptedError) {
          const permissionEngine = this.tools?.getPermissionEngine();
          for (const interrupted of error.interrupts) {
            const value = interrupted.value;
            if (!value || typeof value !== "object" || Array.isArray(value)) continue;
            const approvalId = (value as Record<string, unknown>).approvalId;
            if (typeof approvalId === "string") permissionEngine?.attachWorkflowInterrupt(approvalId, interrupted.id);
          }
        }
        throw error;
      }
      finally { if (communicationCloseStatus) await communication?.close(communicationCloseStatus); }
      run.signal.throwIfAborted();
      if (conversationAccess && conversationSpecialistId && durableEngine) {
        const specialistResult = [...groupResults].reverse().find(group => {
          if (drafts.find(draft => draft.assignmentId === group.assignmentId)?.definitionId === conversationSpecialistId) return true;
          return group.result.split("\n").some(line => {
            try { return (JSON.parse(line) as { definitionId?: string }).definitionId === conversationSpecialistId; }
            catch { return false; }
          });
        })?.result;
        if (specialistResult?.trim()) {
          const turnId = typeof context.options?.turnId === "string" ? context.options.turnId : String(context.taskId);
          const addition = `User request (${turnId}): ${sanitizeReasoningAndSecrets(context.goal).slice(0, 2_000)}\nSpecialist outcome (${turnId}; reported, not independently verified): ${sanitizeReasoningAndSecrets(specialistResult).slice(0, 4_000)}`;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const current = await durableEngine.getSpecialistSession(conversationAccess) ?? await durableEngine.getOrCreateSpecialistSession(conversationAccess);
              const combined = [current.contextSummary, addition].filter(Boolean).join("\n\n");
              await durableEngine.updateSpecialistSessionContext(conversationAccess, {
                contextSummary: combined.slice(-16_000),
                provenance: [...current.provenance, { kind: "specialist-turn", reference: turnId, taskId: context.taskId, capturedAt: Date.now() }].slice(-32),
                expectedVersion: current.contextVersion,
              });
              break;
            } catch (error) {
              const versionConflict = error instanceof Error && error.message.includes("version conflict");
              if (!versionConflict || attempt === 1) {
                throw new Error("Specialist conversation could not be saved. Completed findings remain recorded, but continuity may be incomplete.");
              }
            }
          }
        }
      }
      const baseSynthesisContext = this.createDecisionContext(context.world, context.definitionId, context.options);
      // Cody/tool evidence is recorded inside the specialist child task after the
      // original /api/turns context was assembled. Rebuild the authorized evidence
      // slice from this run's task tree so final synthesis can cite actual work.
      const worldSnapshot = context.world.inspect();
      const runTaskIds = new Set<string>([String(context.taskId)]);
      let discoveredTask = true;
      while (discoveredTask) {
        discoveredTask = false;
        for (const task of worldSnapshot.tasks) {
          if (task.parentTaskId && runTaskIds.has(String(task.parentTaskId)) && !runTaskIds.has(String(task.id))) {
            runTaskIds.add(String(task.id)); discoveredTask = true;
          }
        }
      }
      const runEvidence = worldSnapshot.evidence.filter(evidence =>
        evidence.taskId && runTaskIds.has(String(evidence.taskId))
        && ["observed", "verified"].includes(String(evidence.validity))
        && ["coding-tool", "tester-verification"].includes(evidence.source.type));
      const supervisionNotices = this.runtime.getSupervisionNotices(
        [...runTaskIds].filter(taskId => taskId !== String(context.taskId)) as TaskId[],
      ).flatMap(notice => notice.disposition === "wake" && notice.priority === "failure" ? [{
        eventType: notice.event.type,
        taskId: notice.event.taskId,
        ...(notice.event.workerId ? { workerId: notice.event.workerId } : {}),
        category: notice.category,
        occurredAt: notice.event.occurredAt,
      }] : []);
      const evidenceById = new Map([...(baseSynthesisContext.relevantEvidence ?? []), ...runEvidence].map(evidence => [String(evidence.id), evidence]));
      const synthesisContext = { ...baseSynthesisContext, relevantEvidence: [...evidenceById.values()] };
      let synthesizedMessage: string;
      let synthesisConflict: string | undefined;
      try {
        if (hasOnlyBlockedWebReportsWithoutEvidence(groupResults)) throw new Error("No relevant web evidence is available for factual synthesis.");
        const completedAssignmentCount = groupResults.filter(group => group.status === "completed").length;
        const specialistGroupMessages = sharedGroupHistory.filter(message => message.senderSpecialistId !== context.definitionId);
        const synthesis = await decisionProvider.decide(context.goal, { ...synthesisContext, availableIntents: ["respond", "request_user_input"],
          projectIntelligence: [...(synthesisContext.projectIntelligence ?? []), ...compactSpecialistResults(groupResults),
            { name: "bounded-execution-state", value: JSON.stringify({
              phase: "final-synthesis",
              assignments: groupResults.map(({ kind, assignmentId, status }) => ({ kind, assignmentId, status })),
              completedAssignmentCount,
              specialistAuthoredGroupMessageCount: specialistGroupMessages.length,
              intentScope: "availableIntents applies only to this final synthesis decision; it does not describe the completed delegation or specialist capabilities",
              synthesisRules: [
                "Treat the listed assignment states and durable group history as authoritative execution evidence.",
                "Do not say delegation or coordination was unavailable if the execution record lists specialist assignments.",
                "Do not claim a specialist published or consumed a group finding unless the durable group history records it.",
                "If no specialist-authored group message is recorded, state that explicitly and distinguish coordinator-authored messages from specialist findings.",
              ],
            }) },
            ...(sharedGroupHistory.length ? [{ name: "bounded-shared-group-history", value: JSON.stringify(sharedGroupHistory.map(message => ({
              sequenceNumber: message.sequenceNumber, senderSpecialistId: message.senderSpecialistId, kind: message.kind,
              content: message.content, evidenceRefs: message.evidenceRefs,
            }))) }] : []),
            ...(supervisionNotices.length ? [{ name: "bounded-supervision-notices", value: JSON.stringify(supervisionNotices) }] : []),
            ...(unavailable.length ? [{ name: "specialist-executor-results", value: JSON.stringify({ unavailable }) }] : [])],
        }, run.signal);
        if (synthesis.type === "respond" && completedAssignmentCount > 0 && deniesCompletedCoordination(synthesis.message)) {
          synthesisConflict = "The generated final response denied coordination despite completed specialist assignments.";
          throw new Error(synthesisConflict);
        }
        synthesizedMessage = synthesis.type === "respond" ? synthesis.message
          : synthesis.type === "request_user_input" ? synthesis.question
          : `Specialist findings received; unavailable capabilities: ${unavailable.join(" ")}`;
      } catch (error) {
        run.signal.throwIfAborted();
        const preserved = groupResults.map(({ kind, result }) => `${kind}: ${result}`).join("\n\n").trim();
        const specialistGroupMessages = sharedGroupHistory.filter(message => message.senderSpecialistId !== context.definitionId);
        const coordinatorGroupMessageCount = sharedGroupHistory.length - specialistGroupMessages.length;
        const groupRecord = sharedGroupHistory.length === 0
          ? "Durable shared group history was unavailable."
          : specialistGroupMessages.length === 0
            ? `Durable shared group history contains no specialist-authored messages; all ${coordinatorGroupMessageCount} recorded message(s) were coordinator-authored.`
            : `Durable specialist-authored group messages:\n${specialistGroupMessages.map(message =>
              `- ${message.senderSpecialistId} (${message.kind}, sequence ${message.sequenceNumber}): ${message.content}`,
            ).join("\n")}`;
        synthesizedMessage = [
          synthesisConflict
            ? `Maestro's generated synthesis conflicted with recorded execution evidence (${synthesisConflict}). Specialist reports and collaboration records are preserved below.`
            : "Maestro could not provide a verified final synthesis. Specialist executor reports are preserved verbatim below; any reported status or blocker remains authoritative:",
          groupRecord,
          preserved || "No specialist report was returned.",
        ].join("\n\n");
        if (unavailable.length) synthesizedMessage += `\n\nUnavailable specialist capabilities: ${unavailable.join(" ")}`;
      }
      const message = unavailable.length
        ? `${synthesizedMessage}\n\nUnavailable specialist capabilities: ${unavailable.join(" ")}`
        : synthesizedMessage;
      // A bounded blocked report (for example, a required executor is absent)
      // is a successfully reported outcome, not an execution crash. Keep the
      // task terminal-but-complete with the explicit blocker. Mark it failed
      // only when every dispatched assignment actually failed.
      const noSuccessfulSpecialist = groupResults.length > 0 && groupResults.every(group => group.status === "failed");
      const finalMessage = noSuccessfulSpecialist
        ? `No specialist assignment completed. ${groupResults.map(group => `${group.kind}: ${sanitizeReasoningAndSecrets(group.result).slice(0, 2000)}`).join("\n\n")}`
        : message;
      context.world.recordEvidence({ taskId: context.taskId, workerId: context.workerId,
        source: { type: "maestro-response", reference: String(context.taskId) }, content: finalMessage });
      this.onUserMessage?.(finalMessage, { taskId: context.taskId, workerId: context.workerId,
        ...(conversationSpecialistId ? { respondingSpecialistId: conversationSpecialistId } : {}) });
      if (noSuccessfulSpecialist) {
        throw new Error("No specialist assignment completed. The available reports are preserved in the task record.");
      }
      run.emit("worker.finished");
      return;
    }
    if (decision.type !== "delegate") throw new Error(`Maestro intent is not executable in this milestone: ${decision.type}`);
    if (decision.definitionId !== this.codyDefinitionId) throw new MaestroDecisionError("schema-mismatch", {
      intent: decision.type, keys: ["type", "definitionId", "objective", "relevantContextRefs", "constraints", "expectedOutcome", "evidenceExpectations"],
    });

    run.signal.throwIfAborted();
    const criteria = compileCompletion(this.completion, { objective: context.goal,
      expectedOutcome: decision.expectedOutcome, evidenceExpectations: decision.evidenceExpectations });
    run.signal.throwIfAborted();
    const userCriteria = Array.isArray(context.options?.successCriteria)
      ? (context.options.successCriteria as NonNullable<import("@mediobot-v2/domain").GoalInput["successCriteria"]>)
      : undefined;
    const goal = context.world.createGoal({ threadId: String(context.options?.threadId ?? context.taskId), objective: context.goal,
      constraints: decision.constraints.map((text) => ({ text, source: "maestro" as const, hard: false })),
      successCriteria: criteria ?? userCriteria ?? [{ id: "expected-outcome", statement: decision.expectedOutcome }],
      evidenceRequirements: (criteria || userCriteria) ? [] : decision.evidenceExpectations });
    const assignment = context.world.createAssignment({ goalId: goal.id, targetDefinitionId: this.codyDefinitionId,
      objective: decision.objective, relevantContextRefs: decision.relevantContextRefs, constraints: decision.constraints,
      expectedOutcome: decision.expectedOutcome, evidenceExpectations: decision.evidenceExpectations });

    const worker = context.world.spawnWorker(this.codyDefinitionId);
    const boundedWorkRequest = [
      `Objective: ${assignment.objective}`,
      ...(assignment.relevantContextRefs.length ? [`Relevant context references: ${assignment.relevantContextRefs.join(", ")}`] : []),
      ...(assignment.constraints.length ? [`Constraints: ${assignment.constraints.join("; ")}`] : []),
      `Expected outcome: ${assignment.expectedOutcome}`,
      ...(assignment.evidenceExpectations.length ? [`Evidence expectations: ${assignment.evidenceExpectations.join(", ")}`] : []),
    ].join("\n");
    const explicitChildTaskId = (context.options?.resumeChildTaskId as TaskId | undefined);
    const task = context.world.assignTask(context.world.createTask(boundedWorkRequest, context.taskId, explicitChildTaskId).id, worker.id);
    const permissionEngine = this.tools?.getPermissionEngine();
    const parentPermissionContext = permissionEngine?.getTaskContext(context.taskId);
    permissionEngine?.bindTaskContext(task.id, { ...parentPermissionContext, parentTaskId: context.taskId });
    let currentChildTaskId: TaskId = task.id;
    run.emit("maestro.worker-assigned", undefined, { assignedWorkerId: worker.id,
      assignedDefinitionId: this.codyDefinitionId, executionTaskId: task.id, assignmentObjective: assignment.objective });
    context.world.recordEvidence({ taskId: context.taskId, workerId: context.workerId,
      goalId: goal.id, source: { type: "worker-assignment", reference: String(task.id) }, content: `Assigned Cody worker ${worker.id}` });

    const assignmentSelections = context.options?.assignmentModelSelections
      && typeof context.options.assignmentModelSelections === "object"
      ? context.options.assignmentModelSelections as Record<string, unknown> : undefined;
    const codySelection = assignmentSelections && Object.hasOwn(assignmentSelections, assignment.id)
      ? assignmentSelections[assignment.id]
      : assignmentSelections && Object.hasOwn(assignmentSelections, this.codyDefinitionId)
        ? assignmentSelections[this.codyDefinitionId] : undefined;
    const hasCodyRouting = context.options?.assignmentModelSelections !== undefined;
    const effectiveCodyRaw = codySelection !== undefined
      ? codySelection
      : hasCodyRouting ? undefined : context.options?.modelSelection;
    const parsedCodySelection = readModelSelection(effectiveCodyRaw);
    if (this.decisionResolver && !parsedCodySelection) {
      context.world.setTaskState(task.id, "failed");
      const summary = "Cody was blocked: no explicit model selection was configured.";
      context.world.recordEvidence({ taskId: context.taskId, workerId: context.workerId,
        source: { type: "maestro-response", reference: String(context.taskId) }, content: summary });
      this.onUserMessage?.(summary, { taskId: context.taskId, workerId: context.workerId });
      run.emit("worker.finished");
      return;
    }
    const codyChildOptions = {
      ...(context.options ?? {}),
      modelSelection: parsedCodySelection,
      ...(parsedCodySelection?.reasoningEffort ? { reasoningEffort: parsedCodySelection.reasoningEffort } : {}),
    };

    let delegationRecord: DurableTaskDelegationRecord | undefined;
    if (durableEngine) {
      try {
        const existingDelegations = await durableEngine.getDelegations(context.taskId);
        const match = existingDelegations.find((d) => d.childTaskId === task.id || d.status === "active");
        if (match) {
          delegationRecord = match;
          if (match.childTaskId !== task.id) {
            delegationRecord = await durableEngine.updateDelegation(match.id, { childTaskId: task.id });
          }
        } else {
          await durableEngine.submitTask({
            id: task.id,
            workspaceId: (context.options as any)?.workspaceId ?? null,
            goal: task.goal,
            definitionId: this.codyDefinitionId,
            modelSelection: parsedCodySelection,
          });
          delegationRecord = await durableEngine.recordDelegation(context.taskId, {
            parentTaskId: context.taskId,
            childTaskId: task.id,
            assignedMediobotId: this.codyDefinitionId,
            assignedMediobotName: "Cody",
            objective: decision.objective,
            status: "active",
          });
          await durableEngine.startTask(task.id);
        }
      } catch {}
    }

    const existingResources = new Set(context.world.inspect().resources.map((resource) => resource.id));
    const cleanup = () => {
      // Match submission-scoped cleanup without touching world-owned or reentrant runs' leases.
      const resources = context.world.inspect().resources.filter((resource) => {
        if (existingResources.has(resource.id) || resource.state !== "available") return false;
        if (resource.owner.type === "worker") {
          const ownerWorkerId = resource.owner.workerId;
          return ownerWorkerId === worker.id || Boolean(context.world.inspect().workers.find((w) => w.id === ownerWorkerId && w.definitionId === this.testerDefinitionId));
        }
        if (resource.owner.type === "task") {
          return resource.owner.taskId === task.id || resource.owner.taskId === currentChildTaskId;
        }
        return false;
      });
      for (const resource of resources) context.world.setResourceState(resource.id, "released");
      for (const resource of resources) this.runtime.appendEvent({ type: "resource.released",
        workerId: resource.owner.type === "worker" ? resource.owner.workerId : worker.id,
        taskId: resource.owner.type === "task" ? resource.owner.taskId : task.id, resourceId: resource.id }, (event) => run.forward(event));
    };
    const cancelChild = () => {
      const current = context.world.inspect().goals.find((entry) => entry.id === goal.id);
      if (current?.status === "satisfied") {
        for (const criterion of current.successCriteria) for (const id of criterion.supportingEvidenceIds) context.world.invalidateEvidence(id);
        context.world.transitionGoal(goal.id, "cancelled");
      }
      if (current && !["satisfied", "failed", "cancelled"].includes(current.status)) context.world.transitionGoal(goal.id, "cancelled");
      try { this.runtime.cancel(currentChildTaskId); } catch { /* The child may be between setup and runtime registration. */ }
      if (currentChildTaskId !== task.id) {
        try { this.runtime.cancel(task.id); } catch { /* ignore */ }
      }
    };
    run.signal.addEventListener("abort", cancelChild, { once: true });
    try {
      if (run.signal.aborted) throw new Error("Maestro task cancelled");
      if (run.signal.aborted) throw new Error("Maestro task cancelled");
      const { SqliteSaver } = await import("@langchain/langgraph-checkpoint-sqlite");
      const checkpoint = this.checkpointDatabase
        ? new SqliteSaver(checkpointDatabaseAdapter(this.checkpointDatabase) as never)
        : SqliteSaver.fromConnString(this.checkpointDatabasePath);
      let result: RunResult;
      try {
        const resumed = Boolean(context.options?.resumeTaskId || context.options?.resumeChildTaskId);
        const outcomes = await this.executionEngine.runParallel<{ readonly taskId: TaskId }, RunResult>({
          workflowName: "maestro-specialist-groups", taskName: "run-specialist-group",
          threadId: String(context.taskId), namespace: "specialists", tasks: [{ taskId: task.id }],
          taskId: item => item.taskId, checkpointer: checkpoint,
          outcomeStore: sqliteLangGraphOutcomeStore(checkpoint.db as never), signal: run.signal,
          resume: resumed,
          ...(context.options?.resumeValues && typeof context.options.resumeValues === "object"
            ? { resumeValues: context.options.resumeValues as Readonly<Record<string, unknown>> } : {}),
          execute: async (_item, _signal, _outcomes, interruptTask, isControlSignal) => {
            run.signal.throwIfAborted();
            const isWorkflowControlSignal = (error: unknown) => isControlSignal?.(error) === true || error instanceof LangGraphInterruptedError;
            const selectedCody = this.decisionResolver?.resolveDecisions(codyChildOptions)?.codyDecisions;
            const executingCodyAdapter = selectedCody && this.tools
              ? new CodyExecutionAdapter({ tools: this.tools, decisions: selectedCody, onDiagnostic: this.onCodyDiagnostic, durableTaskEngine: durableEngine })
              : codyAdapter;
            const plan = executingCodyAdapter.prepare({ world: context.world, definitionId: this.codyDefinitionId,
              workerId: worker.id, taskId: task.id, goal: task.goal, options: {
                workspaceRoot, durableTaskEngine: durableEngine,
                resumeTaskId: delegationRecord?.childTaskId ?? task.id, parentTaskId: context.taskId,
                ...codyChildOptions,
                ...(interruptTask && isControlSignal ? { langGraphInterruptTask: interruptTask, isLangGraphControlSignal: isWorkflowControlSignal } : {}),
              } });
            // prepare() may synchronously trigger cancellation (for example a
            // permission boundary or test adapter). The parent abort listener
            // cannot cancel a child that has not entered WorkerRuntime yet, so
            // settle it here instead of starting work after cancellation.
            if (run.signal.aborted) {
              context.world.setTaskState(task.id, "cancelled");
              this.runtime.appendEvent({ type: "task.cancelled", taskId: task.id, workerId: worker.id }, event => run.forward(event));
              if (durableEngine) {
                await durableEngine.cancelTask(task.id, "Maestro assignment cancelled before worker start").catch(() => {});
                if (delegationRecord && delegationRecord.status !== "cancelled") {
                  await durableEngine.updateDelegation(delegationRecord.id, { status: "cancelled" }).catch(() => {});
                }
              }
              return { state: "cancelled" };
            }
            return this.runtime.run({ ...plan, workerId: worker.id, taskId: task.id,
              onEvent: (event: WorldEvent) => run.forward(event) });
          },
        });
        const completed = outcomes[0];
        if (!completed) throw new Error("LangGraph completed without a Cody assignment outcome");
        result = completed;
      } finally {
        if (!this.checkpointDatabase) {
          try { checkpoint.db.close(); } catch { /* Saver can already be closed after interruption. */ }
        }
      }
      run.signal.throwIfAborted();
      cleanup();
      run.signal.throwIfAborted();
      if (result.state !== "completed") {
        const errorMsg = result.state === "cancelled" ? "Cody task cancelled" : ("error" in result && typeof result.error === "string" && result.error ? result.error : "Underlying failure reason is unavailable.");
        if (result.state === "failed") {
          const childEvidence = context.world.inspect().evidence.filter((entry) => entry.taskId === task.id);
          const diffs = childEvidence.filter((entry) => entry.source.type === "workspace-diff");
          let changeStatus: string;
          if (diffs.length > 0) {
            const files = diffs.map((d) => d.source.reference).join(", ");
            changeStatus = `Partial unverified changes made to ${diffs.length} file(s) (${files}). Verification was not completed.`;
          } else {
            changeStatus = "No changes made to the workspace.";
          }

          const failureSummary = `Cody could not complete the assigned work; no successful result is being claimed.\n- Workspace changes: ${changeStatus}\n- Failure reason: ${errorMsg}`;
          this.onUserMessage?.(failureSummary, { taskId: context.taskId, workerId: context.workerId });
          context.world.recordEvidence({
            taskId: context.taskId,
            workerId: context.workerId,
            source: { type: "task-failure", reference: String(task.id) },
            kind: "execution-summary",
            validity: "observed",
            claim: `Task ${task.id} failed: ${changeStatus}`,
            content: failureSummary,
          });
        }
        if (durableEngine && delegationRecord) {
          try {
            await durableEngine.updateDelegation(delegationRecord.id, { status: "failed" });
            await durableEngine.failTask(task.id, { code: "delegation-failed", message: errorMsg });
          } catch {}
        }
        throw new Error(errorMsg);
      }
      if (durableEngine) {
        try {
          if (delegationRecord) {
            await durableEngine.updateDelegation(delegationRecord.id, {
              status: "completed",
              childTaskId: task.id,
            });
          }
          await durableEngine.completeTask(task.id);
        } catch {}
      }
      const evidence = context.world.inspect().evidence.filter((entry) => entry.taskId === task.id && entry.workerId === worker.id);
      const toolEvidence = evidence.filter((entry) =>
        entry.source.type === "coding-tool" && entry.kind === "tool-result" && entry.validity === "observed"
        || entry.source.type === "coding-verification" && entry.kind === "command-execution" && entry.validity === "observed");
      if (!toolEvidence.length) throw new Error("Cody returned no tool-backed evidence");
      const commandExecutions = toolEvidence.filter((entry) => entry.kind === "command-execution");
      // A tool-backed, read-only inspection has a meaningful completion outcome
      // even though it has no code change or command to verify. Any write/edit
      // or terminal attempt remains subject to the normal verification policy.
      const isReadOnly = !toolEvidence.some((entry) => /^(?:filesystem\.(?:write|edit)|terminal\.execute)\b/.test(entry.claim ?? ""));
      const verificationStatus = commandExecutions.length
        ? `${commandExecutions.length} check command(s) exited successfully; task correctness remains unverified.`
        : isReadOnly
          ? "No check command was applicable to this read-only task. Findings are grounded in observed tool results; project behavior was not independently tested."
          : "No successful check command was recorded; workspace changes remain unverified.";
      for (const record of evidence) context.world.linkEvidenceToGoal(goal.id, record.id);
      context.world.recordEvidence({ taskId: context.taskId, workerId: context.workerId,
        goalId: goal.id, source: { type: "worker-result", reference: String(task.id) },
        kind: "execution-summary", claim: `Cody task ${task.id} returned ${toolEvidence.length} tool-backed evidence records. ${verificationStatus}`,
        content: `Cody task ${task.id} returned ${toolEvidence.length} tool-backed evidence records. ${verificationStatus}` });
      if (durableEngine) {
        for (const record of evidence) {
          try {
            await durableEngine.recordEvidence(context.taskId, {
              kind: record.kind ?? "tool-result",
              source: { ...record.source },
              claim: record.claim ?? null,
              content: record.content,
              validity: record.validity ?? "observed",
            });
          } catch {}
        }
      }
      run.emit("maestro.evidence-received");

      const testerAdapter = activeTester;
      const shouldVerifyWithTester = Boolean(testerAdapter && this.testerDefinitionId && (context.options?.verifyWithTester || context.options?.requireVerification));

      if (shouldVerifyWithTester && testerAdapter && this.testerDefinitionId) {
        const testerWorker = context.world.spawnWorker(this.testerDefinitionId);
        const verificationGoal = `Verify implementation of task ${task.id} for objective: ${context.goal}. Expected outcome: ${decision.expectedOutcome}`;
        const testerTask = context.world.assignTask(context.world.createTask(verificationGoal, context.taskId).id, testerWorker.id);
        currentChildTaskId = testerTask.id;
        run.emit("maestro.worker-assigned", undefined, { assignedWorkerId: testerWorker.id,
          assignedDefinitionId: this.testerDefinitionId, executionTaskId: testerTask.id, assignmentObjective: verificationGoal });
        context.world.recordEvidence({
          taskId: context.taskId,
          workerId: context.workerId,
          goalId: goal.id,
          source: { type: "worker-assignment", reference: String(testerTask.id) },
          content: `Assigned Tester worker ${testerWorker.id}`,
        });

        const testerPlan = testerAdapter.prepare({
          world: context.world,
          definitionId: this.testerDefinitionId,
          workerId: testerWorker.id,
          taskId: testerTask.id,
          goal: testerTask.goal,
          options: { workspaceRoot },
        });

        const testerResult = await this.runtime.run({
          ...testerPlan,
          workerId: testerWorker.id,
          taskId: testerTask.id,
          onEvent: (event: WorldEvent) => run.forward(event),
        });

        cleanup();
        run.signal.throwIfAborted();

        const testerEvidence = context.world.inspect().evidence.filter((entry) => entry.taskId === testerTask.id && entry.workerId === testerWorker.id);
        for (const record of testerEvidence) {
          context.world.linkEvidenceToGoal(goal.id, record.id);
        }

        const testerReportEvidence = testerEvidence.find((entry) => entry.source.type === "tester-report");
        const testerVerificationEvidence = testerEvidence.find((entry) => entry.source.type === "tester-verification");
        let testerReport: VerificationReport | undefined;
        if (testerReportEvidence) {
          try {
            testerReport = JSON.parse(testerReportEvidence.content) as VerificationReport;
          } catch { /* malformed */ }
        }

        const summaryEvidence = evidence.find((entry) => entry.source.type === "cody-summary");
        const testerFailed = testerResult.state === "failed" || testerReport?.status === "failed";
        const testerVerified = testerResult.state === "completed" && testerReport?.status === "verified" && testerVerificationEvidence?.validity === "verified";

        if (testerFailed) {
          const failureReason = testerReport?.summary ?? (testerResult.state === "failed" ? "Tester execution failed" : "Verification checks reported failure");
          context.world.recordEvidence({
            taskId: context.taskId,
            workerId: context.workerId,
            goalId: goal.id,
            source: { type: "maestro-evaluation", reference: String(context.taskId) },
            kind: "evaluation-summary",
            validity: "observed",
            claim: "Cody claimed success but Tester verification failed",
            content: `Maestro rejected completion: Cody reported success, but independent Tester verification failed: ${failureReason}.`,
          });

          for (const criterion of goal.successCriteria) {
            if (criterion.evidenceRequirement && testerVerificationEvidence) {
              try {
                context.world.supportGoalCriterion(goal.id, criterion.id, "unsatisfied", [testerVerificationEvidence.id]);
              } catch { /* ignore mismatch */ }
            }
          }
          if (context.world.inspect().goals.find((g) => g.id === goal.id)?.status === "active") {
            try { context.world.transitionGoal(goal.id, "failed"); } catch { /* terminal */ }
          }

          const failureMessage = `Maestro rejected completion: Cody claimed success, but independent Tester verification failed.\n- Verification status: failed\n- Tester summary: ${failureReason}\n- Cody summary (unsupported claim): ${summaryEvidence?.content ?? "N/A"}`;
          context.world.recordEvidence({
            taskId: context.taskId,
            workerId: context.workerId,
            source: { type: "maestro-response", reference: String(context.taskId) },
            content: failureMessage,
          });
          this.onUserMessage?.(failureMessage, { taskId: context.taskId, workerId: context.workerId });
          return;
        }

        if (testerVerified && testerVerificationEvidence) {
          for (const criterion of goal.successCriteria) {
            if (criterion.evidenceRequirement) {
              const req = criterion.evidenceRequirement;
              const matchesKind = req.kind === testerVerificationEvidence.kind;
              const matchesSourceType = req.source.type === testerVerificationEvidence.source.type;
              const matchesValidity = req.validity === testerVerificationEvidence.validity;
              const matchesSubject = req.subject === undefined || req.subject === testerVerificationEvidence.subject;
              const matchesRevision = req.revision === undefined || req.revision === testerVerificationEvidence.revision;
              if (matchesKind && matchesSourceType && matchesValidity && matchesSubject && matchesRevision) {
                try {
                  let evidenceToSupport = testerVerificationEvidence.id;
                  if (req.source.reference !== testerVerificationEvidence.source.reference) {
                    const goalEvidence = context.world.recordEvidence({
                      goalId: goal.id,
                      taskId: context.taskId,
                      workerId: context.workerId,
                      source: req.source,
                      kind: req.kind,
                      validity: "verified",
                      subject: req.subject ?? testerVerificationEvidence.subject,
                      revision: req.revision ?? testerVerificationEvidence.revision,
                      content: testerVerificationEvidence.content,
                      claim: testerVerificationEvidence.claim,
                    });
                    evidenceToSupport = goalEvidence.id;
                  }
                  context.world.supportGoalCriterion(goal.id, criterion.id, "satisfied", [evidenceToSupport]);
                } catch { /* ignore mismatch */ }
              }
            }
          }

          if (criteria && this.completion) {
            await assessCompletion(this.completion, context.world, goal, assignment, workspaceRoot, toolEvidence.length, run.signal);
          }

          run.signal.throwIfAborted();
          const currentGoal = context.world.inspect().goals.find((entry) => entry.id === goal.id);
          const completionStatus = currentGoal?.status === "satisfied"
            ? "Goal satisfied by independent Tester verification."
            : "Goal verified by Tester; criteria evaluation complete.";
          const finalMessage = `${completionStatus}\nTester verification: ${testerReport?.summary ?? "Verified"}${summaryEvidence ? `\nCody summary: ${summaryEvidence.content}` : ""}`;
          context.world.recordEvidence({
            taskId: context.taskId,
            workerId: context.workerId,
            source: { type: "maestro-response", reference: String(context.taskId) },
            content: finalMessage,
          });
          this.onUserMessage?.(finalMessage, { taskId: context.taskId, workerId: context.workerId });
          return;
        }

        const unverifiedMsg = `Goal remains unverified; Tester verification status: ${testerReport?.status ?? "unverified"}.\n${summaryEvidence ? `Cody summary: ${summaryEvidence.content}` : ""}`;
        context.world.recordEvidence({
          taskId: context.taskId,
          workerId: context.workerId,
          source: { type: "maestro-response", reference: String(context.taskId) },
          content: unverifiedMsg,
        });
        this.onUserMessage?.(unverifiedMsg, { taskId: context.taskId, workerId: context.workerId });
        return;
      }

      if (criteria && this.completion) await assessCompletion(this.completion, context.world, goal,
        assignment, workspaceRoot, toolEvidence.length, run.signal);
      run.signal.throwIfAborted();
      const completionStatus = context.world.inspect().goals.find((entry) => entry.id === goal.id)?.status === "satisfied"
        ? "Goal satisfied by the configured independent completion policy."
        : isReadOnly && !criteria && !userCriteria?.some((criterion) => criterion.required !== false)
          ? "Read-only inspection completed from observed workspace evidence; no files were changed."
          : "Goal remains unproved; worker results do not establish completion.";
      const summaryEvidence = evidence.find((entry) => entry.source.type === "cody-summary");
      const finalMessage = `${completionStatus}\n${verificationStatus}${summaryEvidence ? `\nCody summary (model claim): ${summaryEvidence.content}` : ""}`;
      context.world.recordEvidence({ taskId: context.taskId, workerId: context.workerId,
        source: { type: "maestro-response", reference: String(context.taskId) }, content: finalMessage });
      this.onUserMessage?.(finalMessage, { taskId: context.taskId, workerId: context.workerId });
    } catch (error) {
      if (error instanceof LangGraphInterruptedError) {
        const permissionEngine = this.tools?.getPermissionEngine();
        for (const interrupted of error.interrupts) {
          const value = interrupted.value;
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const approvalId = (value as Record<string, unknown>).approvalId;
          if (typeof approvalId === "string") permissionEngine?.attachWorkflowInterrupt(approvalId, interrupted.id);
        }
        throw error;
      }
      // Rejected starts acquire nothing; never overwrite a task started by reentrant code.
      if (context.world.inspect().tasks.find((entry) => entry.id === task.id)?.state === "assigned") {
        context.world.setTaskState(task.id, "failed");
        cleanup();
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.runtime.appendEvent({ type: "task.failed", workerId: worker.id, taskId: task.id, error: errorMsg }, (event) => run.forward(event));
      }
      throw error;
    } finally {
      run.signal.removeEventListener("abort", cancelChild);
      cleanup();
    }
  }

}

export function createMaestroCodyExecution(options: { readonly world: InMemoryWorld; readonly runtime: WorkerRuntime;
  readonly tools: ToolRuntime; readonly codyDecisions: CodyDecisionProvider; readonly maestroDecisions: MaestroDecisionProvider;
  readonly maestroDefinition: MarkdownMediobotDefinition;
  readonly testerDecisions?: TesterDecisionProvider;
  readonly testerAdapter?: TesterExecutionAdapter;
  readonly skillCatalog?: ReadonlyArray<SkillMetadata>;
  readonly completion?: TrustedCompletion;
  readonly onUserMessage?: (message: string, identity: { readonly taskId: TaskId; readonly workerId: WorkerId; readonly respondingSpecialistId?: MediobotDefinitionId }) => void;
  readonly onCodyDiagnostic?: (diagnostic: CodyToolDiagnostic) => void;
  readonly onTesterDiagnostic?: (diagnostic: TesterToolDiagnostic) => void;
  readonly onSpecialistMessageEvent?: (event: SpecialistCommunicationEvent) => void;
  readonly textModelResolver?: TextModelResolver;
  readonly decisionResolver?: MaestroDecisionResolver;
  readonly durableTaskEngine?: DurableTaskEngine;
  readonly checkpointDatabasePath?: string;
  readonly checkpointDatabase?: CheckpointDatabase;
  readonly crawl4ai?: WebIntelligenceRuntime;
  readonly webExecution?: WebAgentExecution }): {
    readonly maestroDefinitionId: MediobotDefinitionId;
    readonly codyDefinitionId: MediobotDefinitionId;
    readonly testerDefinitionId: MediobotDefinitionId;
    readonly scraapyDefinitionId?: MediobotDefinitionId;
    readonly docDefinitionId?: MediobotDefinitionId;
    readonly researchDefinitionId?: MediobotDefinitionId;
    readonly webExecution?: WebAgentExecution;
    readonly adapter: MaestroExecutionAdapter;
  } {
  const maestro = createMaestroDefinition(options.world, options.maestroDefinition);
  const codyDefinition = createCodyDefinition(options.world);
  const testerDefinition = createTesterDefinition(options.world);
  if (options.tools && options.crawl4ai && !options.tools.getWebIntelligence()) {
    options.tools.setWebIntelligence(options.crawl4ai as any);
  }
  const textExecution = options.textModelResolver ? new TextMediobotExecution(options.world, options.runtime, options.textModelResolver, codyDefinition.id, testerDefinition.id) : undefined;
  const webExecution = options.webExecution ?? (options.crawl4ai && options.textModelResolver
    ? new WebAgentExecution(options.world, options.runtime, options.textModelResolver, options.crawl4ai, undefined, undefined, undefined, options.tools)
    : undefined);
  const cody = new CodyExecutionAdapter({ tools: options.tools, decisions: options.codyDecisions, onDiagnostic: options.onCodyDiagnostic, durableTaskEngine: options.durableTaskEngine });
  const tester = options.testerAdapter ?? (options.testerDecisions ? new TesterExecutionAdapter({ tools: options.tools, decisions: options.testerDecisions, onDiagnostic: options.onTesterDiagnostic }) : undefined);
  return {
    maestroDefinitionId: maestro.id,
    codyDefinitionId: codyDefinition.id,
    testerDefinitionId: testerDefinition.id,
    scraapyDefinitionId: webExecution?.scraapyDefinitionId,
    docDefinitionId: webExecution?.docDefinitionId,
    researchDefinitionId: webExecution?.researchDefinitionId,
    webExecution,
    adapter: new MaestroExecutionAdapter({
      textExecution,
      webExecution,
      codyDefinitionId: codyDefinition.id,
      testerDefinitionId: testerDefinition.id,
      cody,
      tester,
      decisions: options.maestroDecisions,
      runtime: options.runtime,
      tools: options.tools,
      onUserMessage: options.onUserMessage,
      onCodyDiagnostic: options.onCodyDiagnostic,
      onTesterDiagnostic: options.onTesterDiagnostic,
      onSpecialistMessageEvent: options.onSpecialistMessageEvent,
      decisionResolver: options.decisionResolver,
      skillCatalog: options.skillCatalog,
      completion: options.completion,
      durableTaskEngine: options.durableTaskEngine,
      checkpointDatabasePath: options.checkpointDatabasePath,
      checkpointDatabase: options.checkpointDatabase,
    }),
  };
}

function parseHistory(value: string | undefined): ReadonlyArray<{ readonly user: string; readonly assistant?: string }> {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-4).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const turn = entry as Record<string, unknown>;
      return typeof turn.user === "string" && (turn.assistant === undefined || typeof turn.assistant === "string")
        ? [{ user: turn.user.slice(0, 1000), ...(typeof turn.assistant === "string" ? { assistant: turn.assistant.slice(0, 1000) } : {}) }]
        : [];
    });
  } catch { return []; }
}

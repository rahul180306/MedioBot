import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResourceId } from "@mediobot-v2/domain";
import { completeWithModelContract, modelCompatibilityResponseText, sanitizeReasoningAndSecrets } from "@mediobot-v2/models";
import type { ModelOutputContract, StructuredModelClient } from "@mediobot-v2/models";
import type { RunContext, WorkerExecutionAdapter, WorkerExecutionContext, WorkerExecutionPlan } from "@mediobot-v2/runtime";
import type { ToolInvocation, ToolResult, ToolRuntime } from "@mediobot-v2/tools";

export type TesterModelClient = StructuredModelClient;

export interface AssertionResult {
  readonly name: string;
  readonly passed: boolean;
  readonly provenance?: "runner-observed" | "model-provided";
  readonly message?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface VerificationToolExecution {
  readonly invocationId: string;
  readonly toolName: string;
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  readonly stdoutSummary?: string;
  readonly stderrSummary?: string;
}

export interface VerificationReport {
  readonly status: "verified" | "failed" | "blocked" | "unverified";
  readonly summary: string;
  readonly observations: ReadonlyArray<string>;
  readonly toolExecutions: ReadonlyArray<VerificationToolExecution>;
  readonly assertions: ReadonlyArray<AssertionResult>;
  readonly supportedCriteria: ReadonlyArray<string>;
  readonly unverifiedRequirements: ReadonlyArray<string>;
  readonly blockedReasons?: ReadonlyArray<string>;
  readonly workspaceRevision?: string;
}

export interface VerificationReportInput {
  readonly status: "verified" | "failed" | "blocked" | "unverified";
  readonly summary: string;
  readonly observations?: ReadonlyArray<string>;
  readonly assertions?: ReadonlyArray<AssertionResult>;
  readonly supportedCriteria?: ReadonlyArray<string>;
  readonly unverifiedRequirements?: ReadonlyArray<string>;
  readonly blockedReasons?: ReadonlyArray<string>;
}

export type TesterAction =
  | { readonly type: "list"; readonly path?: string }
  | { readonly type: "read"; readonly path: string }
  | { readonly type: "run"; readonly command: string; readonly args?: ReadonlyArray<string>; readonly cwd?: string; readonly check: string }
  | { readonly type: "finish"; readonly report: VerificationReportInput };

export interface TesterDecisionDiagnostic {
  readonly stage: "provider" | "decision-parse" | "decision-shape";
  readonly category?: string;
  readonly code?: string;
  readonly message?: string;
  readonly responseCharacters?: number;
  readonly keys?: ReadonlyArray<string>;
  readonly actionType?: string;
}

export interface TesterToolDiagnostic {
  readonly stage: "tool-result";
  readonly toolName: ToolInvocation["name"];
  readonly status: ToolResult["status"];
  readonly failureStage?: ToolResult["failureStage"];
  readonly errorCode?: string;
  readonly exitCode?: number | null;
}

export class TesterDecisionError extends Error {
  readonly diagnostic?: TesterDecisionDiagnostic;
  constructor(message = "Tester returned an invalid tool decision", diagnostic?: TesterDecisionDiagnostic) {
    super(message);
    this.name = "TesterDecisionError";
    this.diagnostic = diagnostic;
  }
}

const SYSTEM = `You are Tester, Mediobot's independent verification specialist. Your mission is to rigorously verify task requirements and code changes by inspecting workspace files, reviewing test configurations, and executing approved test commands. You have READ-ONLY filesystem access and test execution capabilities. You cannot write or modify files in the workspace. Choose exactly one next action and return one JSON object: {"type":"list","path":"."}, {"type":"read","path":"relative/path"}, {"type":"run","command":"program","args":["..."],"cwd":".","check":"specific assertion or requirement being verified"}, or {"type":"finish","report":{"status":"verified"|"failed"|"blocked"|"unverified","summary":"evidence-based conclusion","observations":[],"assertions":[{"name":"check name","passed":true}],"supportedCriteria":[],"unverifiedRequirements":[]}}. Never claim verified status unless actual test commands ran and exited with code 0 and all assertions passed. An exit code 0 alone is not proof of goal correctness; verify actual outputs. Do not emit prose or markdown outside the JSON object.`;

const testerText = { type: "string" } as const;
function testerVariant(type: string, required: string[], properties: Record<string, unknown>) {
  return { type: "object", properties: { type: { const: type }, ...properties }, required: ["type", ...required], additionalProperties: false };
}
const TESTER_ACTION_SCHEMA = { oneOf: [
  testerVariant("list", [], { path: testerText }),
  testerVariant("read", ["path"], { path: testerText }),
  testerVariant("run", ["command", "check"], { command: testerText, check: testerText,
    args: { type: "array", items: testerText }, cwd: testerText }),
  testerVariant("finish", ["report"], { report: { type: "object", properties: {
    status: { type: "string", enum: ["verified", "failed", "blocked", "unverified"] }, summary: testerText,
    observations: { type: "array", items: testerText }, assertions: { type: "array", items: { type: "object", properties: {
      name: testerText, passed: { type: "boolean" }, provenance: { type: "string", enum: ["runner-observed", "model-provided"] },
      message: testerText, expected: testerText, actual: testerText,
    }, required: ["name", "passed"], additionalProperties: false } }, supportedCriteria: { type: "array", items: testerText },
    unverifiedRequirements: { type: "array", items: testerText }, blockedReasons: { type: "array", items: testerText },
  }, required: ["status", "summary"], additionalProperties: false } }),
] } as const;
export const TESTER_ACTION_OUTPUT_CONTRACT: ModelOutputContract = {
  name: "mediobot_decision", description: "Propose one Tester action; MedioBot validates and authorizes it.", schema: TESTER_ACTION_SCHEMA,
  tools: [{ name: "mediobot_decision", description: "Propose one Tester action; tool execution remains under MedioBot permissions.", parameters: TESTER_ACTION_SCHEMA }],
};

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
  "coverage",
  ".nyc_output",
  ".turbo",
  ".next",
  ".cache",
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".tsbuildinfo",
]);

export async function computeWorkspaceRevision(workspaceRoot: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = (await readdir(dir)).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry) || entry.startsWith(".tmp.")) continue;
      const fullPath = path.join(dir, entry);
      try {
        const fileStat = await stat(fullPath);
        if (fileStat.isDirectory()) {
          await walk(fullPath);
        } else if (fileStat.isFile()) {
          const ext = path.extname(entry);
          if (EXCLUDED_EXTENSIONS.has(ext)) continue;
          const relPath = path.relative(workspaceRoot, fullPath);
          hash.update(relPath);
          const content = await readFile(fullPath);
          hash.update(content);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
  await walk(workspaceRoot);
  return hash.digest("hex").slice(0, 16);
}

export async function createShadowWorkspace(workspaceRoot: string): Promise<string> {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), "mediobot-tester-shadow-"));
  try {
    const entries = await readdir(workspaceRoot);
    for (const entry of entries) {
      if (entry === ".git" || entry === "coverage" || entry === ".nyc_output" || entry === ".turbo" || entry === ".next" || entry === ".cache" || entry.startsWith(".tmp.")) continue;
      const srcPath = path.join(workspaceRoot, entry);
      const destPath = path.join(tmpBase, entry);
      if (entry === "node_modules") {
        try {
          await symlink(srcPath, destPath, "junction");
        } catch {
          // If symlink fails, ignore or best effort
        }
        continue;
      }
      await cp(srcPath, destPath, { recursive: true, force: true });
    }
    return tmpBase;
  } catch (err) {
    try {
      await rm(tmpBase, { recursive: true, force: true });
    } catch { /* cleanup */ }
    throw err;
  }
}

export async function snapshotNodeModules(workspaceRoot: string): Promise<Map<string, number> | null> {
  const nmPath = path.join(workspaceRoot, "node_modules");
  try {
    const entries = await readdir(nmPath);
    const snapshot = new Map<string, number>();
    for (const entry of entries) {
      try {
        const s = await stat(path.join(nmPath, entry));
        snapshot.set(entry, s.mtimeMs);
      } catch {
        // skip unreadable
      }
    }
    return snapshot;
  } catch {
    return null;
  }
}

export async function verifyNodeModulesIntegrity(workspaceRoot: string, baseline: Map<string, number> | null): Promise<boolean> {
  const nmPath = path.join(workspaceRoot, "node_modules");
  if (baseline === null) {
    try {
      await stat(nmPath);
      return false; // node_modules was created where it didn't exist before
    } catch {
      return true;
    }
  }
  try {
    const entries = await readdir(nmPath);
    if (entries.length !== baseline.size) return false;
    for (const entry of entries) {
      const prev = baseline.get(entry);
      if (prev === undefined) return false;
      const s = await stat(path.join(nmPath, entry));
      if (s.mtimeMs !== prev) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function invalidateStaleVerificationEvidence(
  world: {
    inspect(): { evidence: ReadonlyArray<{ id: string; validity?: string; revision?: string; source: { type: string } }> };
    invalidateEvidence(id: string): void;
  },
  workspaceRoot: string,
): Promise<ReadonlyArray<string>> {
  const currentRevision = await computeWorkspaceRevision(workspaceRoot);
  const invalidatedIds: string[] = [];
  const allEvidence = world.inspect().evidence;
  for (const item of allEvidence) {
    if (item.validity === "verified" && item.source?.type === "tester-verification") {
      if (item.revision && item.revision !== currentRevision) {
        world.invalidateEvidence(item.id);
        invalidatedIds.push(item.id);
      }
    }
  }
  return invalidatedIds;
}

export class TesterDecisionProvider {
  private readonly model: TesterModelClient;
  private readonly onDiagnostic?: (diagnostic: TesterDecisionDiagnostic) => void;
  private readonly defaultReasoningEffort?: "low" | "medium" | "high" | "extra" | "max";

  constructor(
    model: TesterModelClient,
    onDiagnostic?: (diagnostic: TesterDecisionDiagnostic) => void,
    defaultReasoningEffort?: "low" | "medium" | "high" | "extra" | "max"
  ) {
    this.model = model;
    this.onDiagnostic = onDiagnostic;
    this.defaultReasoningEffort = defaultReasoningEffort;
  }

  async decide(
    goal: string,
    history: ReadonlyArray<{ readonly action: string; readonly result: string }>,
    signal: AbortSignal,
    reasoningEffort?: "low" | "medium" | "high" | "extra" | "max"
  ): Promise<TesterAction> {
    const effectiveEffort = this.defaultReasoningEffort ?? reasoningEffort;
    const input = JSON.stringify({
      goal,
      recentToolHistory: history.slice(-10).map((entry) => ({
        action: entry.action.slice(0, 300),
        result: entry.result.slice(0, 5000),
      })),
    });

    let response: string;
    try {
      const compatible = await completeWithModelContract(this.model, { system: SYSTEM, input, signal, outputContract: TESTER_ACTION_OUTPUT_CONTRACT, ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}) });
      response = modelCompatibilityResponseText(compatible);
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.report({ stage: "provider", category: ["ModelProviderError", "AbortError"].includes(name) ? name : "request-failed", code, message });
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response);
    } catch {
      const diagnostic: TesterDecisionDiagnostic = { stage: "decision-parse", category: "invalid-json", responseCharacters: response.length };
      this.report(diagnostic);
      throw new TesterDecisionError("Tester returned an invalid tool decision (decision-parse: invalid-json)", diagnostic);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const diagnostic: TesterDecisionDiagnostic = { stage: "decision-shape", category: "not-an-object", responseCharacters: response.length };
      this.report(diagnostic);
      throw new TesterDecisionError("Tester returned an invalid tool decision (decision-shape: not-an-object)", diagnostic);
    }

    const value = parsed as Record<string, unknown>;
    if (value.type === "list" && (value.path === undefined || typeof value.path === "string")) {
      return { type: "list", ...(typeof value.path === "string" ? { path: value.path } : {}) };
    }
    if (value.type === "read" && typeof value.path === "string") {
      return { type: "read", path: value.path };
    }
    if (value.type === "run" && typeof value.command === "string"
      && (value.args === undefined || (Array.isArray(value.args) && value.args.every((part) => typeof part === "string")))
      && (value.cwd === undefined || typeof value.cwd === "string")
      && (value.check === undefined || typeof value.check === "string")) {
      return {
        type: "run",
        command: value.command,
        ...(Array.isArray(value.args) ? { args: value.args as string[] } : {}),
        ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
        check: typeof value.check === "string" ? value.check.trim() : "General verification run",
      };
    }
    if (value.type === "finish") {
      if (value.report && typeof value.report === "object" && !Array.isArray(value.report)) {
        const rep = value.report as Record<string, unknown>;
        const status = typeof rep.status === "string" && ["verified", "failed", "blocked", "unverified"].includes(rep.status)
          ? (rep.status as VerificationReport["status"])
          : "unverified";
        const summary = typeof rep.summary === "string" && rep.summary.trim().length > 0
          ? sanitizeReasoningAndSecrets(rep.summary).slice(0, 2000)
          : "Tester verification finished.";
        const observations = Array.isArray(rep.observations)
          ? rep.observations.filter((o): o is string => typeof o === "string").map((o) => sanitizeReasoningAndSecrets(o).slice(0, 500))
          : [];
        const assertions = Array.isArray(rep.assertions)
          ? rep.assertions.filter((a): a is Record<string, unknown> => a && typeof a === "object").map((a) => ({
              name: typeof a.name === "string" ? a.name.slice(0, 200) : "assertion",
              passed: Boolean(a.passed),
              ...(typeof a.message === "string" ? { message: a.message.slice(0, 500) } : {}),
              ...(typeof a.expected === "string" ? { expected: a.expected.slice(0, 200) } : {}),
              ...(typeof a.actual === "string" ? { actual: a.actual.slice(0, 200) } : {}),
            }))
          : [];
        const supportedCriteria = Array.isArray(rep.supportedCriteria)
          ? rep.supportedCriteria.filter((c): c is string => typeof c === "string").map((c) => c.slice(0, 200))
          : [];
        const unverifiedRequirements = Array.isArray(rep.unverifiedRequirements)
          ? rep.unverifiedRequirements.filter((r): r is string => typeof r === "string").map((r) => r.slice(0, 200))
          : [];
        const blockedReasons = Array.isArray(rep.blockedReasons)
          ? rep.blockedReasons.filter((b): b is string => typeof b === "string").map((b) => b.slice(0, 500))
          : undefined;

        return {
          type: "finish",
          report: {
            status,
            summary,
            observations,
            assertions,
            supportedCriteria,
            unverifiedRequirements,
            ...(blockedReasons ? { blockedReasons } : {}),
          },
        };
      }

      const summary = typeof value.summary === "string" && value.summary.trim().length > 0
        ? sanitizeReasoningAndSecrets(value.summary).slice(0, 2000)
        : "Tester verification finished.";
      return {
        type: "finish",
        report: {
          status: "unverified",
          summary,
          observations: [],
          assertions: [],
          supportedCriteria: [],
          unverifiedRequirements: [],
        },
      };
    }

    const keys = Object.keys(value).slice(0, 16).sort();
    const actionType = typeof value.type === "string" ? value.type.slice(0, 40) : typeof value.type;
    const diagnostic: TesterDecisionDiagnostic = {
      stage: "decision-shape",
      category: "unsupported-or-invalid-action",
      responseCharacters: response.length,
      keys,
      actionType,
    };
    this.report(diagnostic);
    throw new TesterDecisionError(`Tester returned an invalid tool decision (decision-shape: unsupported-or-invalid-action, actionType: ${actionType})`, diagnostic);
  }

  private report(diagnostic: TesterDecisionDiagnostic): void {
    try { this.onDiagnostic?.(diagnostic); } catch { /* diagnostics must not affect execution */ }
  }
}

function summarizeToolResult(result: ToolResult): string {
  if (result.status !== "succeeded") return `${result.status}: ${result.error ?? "tool failed"}`;
  const output = result.output;
  if (!output) return "succeeded";
  if ("entries" in output) return `entries: ${output.entries.slice(0, 100).join(", ")}`;
  if ("content" in output) return `file content (${output.content.length} characters):\n${output.content.slice(0, 5000)}`;
  if ("stdout" in output) return `exitCode=${output.exitCode}; stdout:\n${output.stdout}\nstderr:\n${output.stderr}`.slice(0, 7000);
  return "tool execution completed";
}

export class TesterExecutionAdapter implements WorkerExecutionAdapter {
  private readonly tools: ToolRuntime;
  private readonly decisions: TesterDecisionProvider;
  private readonly onDiagnostic?: (diagnostic: TesterToolDiagnostic) => void;

  constructor(options: {
    readonly tools: ToolRuntime;
    readonly decisions: TesterDecisionProvider;
    readonly onDiagnostic?: (diagnostic: TesterToolDiagnostic) => void;
  }) {
    this.tools = options.tools;
    this.decisions = options.decisions;
    this.onDiagnostic = options.onDiagnostic;
  }

  prepare(context: WorkerExecutionContext): WorkerExecutionPlan {
    const workspaceRoot = typeof context.options?.workspaceRoot === "string" ? context.options.workspaceRoot : undefined;
    if (!workspaceRoot) throw new Error("Tester requires an explicitly selected project workspace");
    const workspace = context.world.registerResource({
      kind: "workspace",
      owner: { type: "task", worldId: context.world.id, taskId: context.taskId },
    });
    return {
      resourceIds: [workspace.id],
      execute: (run) => this.execute(context, workspace.id, workspaceRoot, run),
    };
  }

  private async execute(context: WorkerExecutionContext, resourceId: ResourceId, workspaceRoot: string, run: RunContext): Promise<void> {
    const requestedIsolation = context.options?.isolationLevel;
    if (requestedIsolation === "os-sandbox" || requestedIsolation === "container") {
      throw new Error(
        `Tester isolation failure: Strong OS-level container isolation was requested ("${requestedIsolation}"), but kernel container runtime is unavailable in this environment. Failing closed to prevent unisolated execution.`
      );
    }

    const baselineRevision = await computeWorkspaceRevision(workspaceRoot);
    const baselineNodeModules = await snapshotNodeModules(workspaceRoot);
    let shadowWorkspaceRoot: string;
    try {
      shadowWorkspaceRoot = await createShadowWorkspace(workspaceRoot);
    } catch (err) {
      throw new Error(`Tester execution failed closed: OS-level isolation shadow workspace could not be created (${err instanceof Error ? err.message : String(err)})`);
    }

    try {
      await this.tools.bindWorkspace(resourceId, shadowWorkspaceRoot);
      await this.executeBoundWorkspace(context, resourceId, workspaceRoot, run, baselineRevision);
    } finally {
      this.tools.releaseWorkspace(resourceId);
      try {
        await rm(shadowWorkspaceRoot, { recursive: true, force: true });
      } catch { /* cleanup */ }

      // Fail-closed verification: Ensure original workspaceRoot was NEVER modified indirectly
      const postRevision = await computeWorkspaceRevision(workspaceRoot);
      if (postRevision !== baselineRevision) {
        throw new Error("Tester isolation breach: workspaceRoot was modified during test execution. Test execution invalidated.");
      }

      // Fail-closed verification: Ensure original node_modules was NEVER modified indirectly
      const nodeModulesIntact = await verifyNodeModulesIntegrity(workspaceRoot, baselineNodeModules);
      if (!nodeModulesIntact) {
        throw new Error("Tester isolation breach: host node_modules was modified during test execution. Test execution invalidated.");
      }
    }
  }

  private async executeBoundWorkspace(
    context: WorkerExecutionContext,
    resourceId: ResourceId,
    workspaceRoot: string,
    run: RunContext,
    baselineRevision?: string,
  ): Promise<void> {
    const history: Array<{ action: string; result: string }> = [];
    const toolExecutions: VerificationToolExecution[] = [];
    let lastSuccessfulRun: { invocationId: string; exitCode: number } | undefined;
    let anyCheckFailed = false;

    for (let step = 0; step < 24; step += 1) {
      if (run.signal.aborted) throw new Error("Tester task cancelled");
      const action = await this.decisions.decide(context.goal, history, run.signal, context.options?.reasoningEffort as any);

      if (action.type === "finish") {
        const inputReport = action.report;
        let finalStatus: VerificationReport["status"] = inputReport.status;

        // An exit code 0 alone or a model finish claim is not sufficient evidence of task correctness.
        // A model cannot fabricate verification without running checks.
        if (finalStatus === "verified") {
          if (anyCheckFailed) {
            // A check command actually executed and failed
            finalStatus = "failed";
          } else if (inputReport.assertions && inputReport.assertions.some((a) => !a.passed)) {
            // An assertion explicitly failed
            finalStatus = "failed";
          } else if (!lastSuccessfulRun || toolExecutions.length === 0) {
            // Model claimed verified without running any successful test command
            finalStatus = "unverified";
          }
        }

        const workspaceRevision = baselineRevision ?? (await computeWorkspaceRevision(workspaceRoot));

        const assertionsWithProvenance: AssertionResult[] = (inputReport.assertions ?? []).map((a) => {
          const isRunnerObserved = toolExecutions.some((te) => te.exitCode === 0);
          return {
            ...a,
            provenance: isRunnerObserved ? "runner-observed" : "model-provided",
          };
        });

        const finalReport: VerificationReport = {
          status: finalStatus,
          summary: inputReport.summary,
          observations: inputReport.observations ?? [],
          toolExecutions,
          assertions: assertionsWithProvenance,
          supportedCriteria: inputReport.supportedCriteria ?? [],
          unverifiedRequirements: inputReport.unverifiedRequirements ?? [],
          ...(inputReport.blockedReasons ? { blockedReasons: inputReport.blockedReasons } : {}),
          workspaceRevision,
        };

        const lastInvocationId = lastSuccessfulRun?.invocationId ?? (toolExecutions[toolExecutions.length - 1]?.invocationId ?? String(context.taskId));

        // Record independent tester verification evidence
        context.world.recordEvidence({
          taskId: context.taskId,
          workerId: context.workerId,
          source: { type: "tester-verification", reference: lastInvocationId },
          kind: "test-execution",
          validity: finalStatus === "verified" ? "verified" : "observed",
          claim: finalReport.summary,
          content: JSON.stringify(finalReport),
          subject: "workspace",
          revision: workspaceRevision,
        });

        // Record structured verification report
        context.world.recordEvidence({
          taskId: context.taskId,
          workerId: context.workerId,
          source: { type: "tester-report", reference: String(context.taskId) },
          kind: "verification-summary",
          validity: "observed",
          content: JSON.stringify(finalReport),
        });

        run.emit("worker.finished", resourceId);
        return;
      }

      let invocation: ToolInvocation;
      let actionLabel: string;

      if (action.type === "list") {
        invocation = {
          worldId: context.world.id,
          workerId: context.workerId,
          taskId: context.taskId,
          resourceId,
          signal: run.signal,
          name: "filesystem.list",
          input: { path: action.path ?? "." },
        };
        actionLabel = `filesystem.list ${action.path ?? "."}`;
      } else if (action.type === "read") {
        invocation = {
          worldId: context.world.id,
          workerId: context.workerId,
          taskId: context.taskId,
          resourceId,
          signal: run.signal,
          name: "filesystem.read",
          input: { path: action.path },
        };
        actionLabel = `filesystem.read ${action.path}`;
      } else if (action.type === "run") {
        invocation = {
          worldId: context.world.id,
          workerId: context.workerId,
          taskId: context.taskId,
          resourceId,
          signal: run.signal,
          name: "terminal.execute",
          input: { command: action.command, args: action.args, cwd: action.cwd },
        };
        actionLabel = `terminal.execute ${action.command} ${(action.args ?? []).join(" ")} [check: ${action.check}]`.slice(0, 300);
      } else {
        // Unknown or unauthorized action
        history.push({
          action: "unauthorized",
          result: "Tester has only read-only and test execution tools. File modifications are prohibited.",
        });
        continue;
      }

      const toolInvocationId = globalThis.crypto.randomUUID();
      const startTimeWall = Date.now();
      const startMonotonic = globalThis.performance ? globalThis.performance.now() : Date.now();

      run.emit("tool.started", resourceId, {
        toolName: invocation.name,
        toolInvocationId,
        command: actionLabel,
        startedAt: startTimeWall,
        isVerification: action.type === "run",
      });

      const result = await this.tools.invoke(invocation);
      const durationMs = Math.round(globalThis.performance ? globalThis.performance.now() - startMonotonic : Date.now() - startTimeWall);

      if (action.type === "run") {
        const exitCode = result.output && "exitCode" in result.output ? result.output.exitCode : null;
        const stdout = result.output && "stdout" in result.output ? result.output.stdout : "";
        const stderr = result.output && "stderr" in result.output ? result.output.stderr : "";

        toolExecutions.push({
          invocationId: result.invocationId,
          toolName: "terminal.execute",
          command: `${action.command} ${(action.args ?? []).join(" ")}`,
          exitCode,
          durationMs,
          stdoutSummary: stdout.slice(0, 1000),
          stderrSummary: stderr.slice(0, 1000),
        });

        if (result.status === "succeeded" && exitCode === 0) {
          lastSuccessfulRun = { invocationId: result.invocationId, exitCode };
        } else {
          anyCheckFailed = true;
        }
      }

      if (result.status === "succeeded") {
        run.emit("tool.completed", resourceId, {
          toolName: invocation.name,
          toolInvocationId,
          startedAt: startTimeWall,
          durationMs,
          ...(result.output && "exitCode" in result.output ? {
            exitCode: result.output.exitCode,
            stdoutBytes: Buffer.byteLength(result.output.stdout),
            stderrBytes: Buffer.byteLength(result.output.stderr),
          } : {}),
          ...(action.type === "run" ? {
            isVerification: true,
            verificationStatus: (result.output && "exitCode" in result.output && result.output.exitCode === 0) ? "command-succeeded" : "command-failed",
          } : {}),
        });
      } else if (result.status === "cancelled") {
        run.emit("tool.cancelled", resourceId, {
          toolName: invocation.name,
          toolInvocationId,
          startedAt: startTimeWall,
          durationMs,
          isVerification: action.type === "run",
          verificationStatus: "unverified",
        });
      } else {
        run.emit("tool.failed", resourceId, {
          toolName: invocation.name,
          toolInvocationId,
          startedAt: startTimeWall,
          error: result.error ?? "Tool operation failed.",
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          failureCategory: result.failureStage ?? "tool-error",
          durationMs,
          ...(result.output && "exitCode" in result.output ? {
            exitCode: result.output.exitCode,
            stdoutBytes: Buffer.byteLength(result.output.stdout),
            stderrBytes: Buffer.byteLength(result.output.stderr),
          } : {}),
          ...(action.type === "run" ? {
            isVerification: true,
            verificationStatus: "command-failed",
          } : {}),
        });
      }

      const outcome = summarizeToolResult(result);
      history.push({ action: actionLabel, result: outcome });

      context.world.recordEvidence({
        taskId: context.taskId,
        workerId: context.workerId,
        source: { type: "tester-tool", reference: result.invocationId },
        kind: "tool-result",
        validity: "observed",
        content: `${invocation.name} ${result.status}; code=${result.errorCode ?? "none"}`,
      });

      if (result.status !== "succeeded") {
        try {
          this.onDiagnostic?.({
            stage: "tool-result",
            toolName: invocation.name,
            status: result.status,
            failureStage: result.failureStage,
            errorCode: result.errorCode,
            exitCode: result.output && "exitCode" in result.output ? result.output.exitCode : undefined,
          });
        } catch { /* diagnostics cannot affect execution */ }

        // If permission denied or path error, do not throw if run is part of test discovery, but record progress
        run.emit("worker.progress", resourceId, invocation.name);
        continue;
      }

      run.emit("worker.progress", resourceId, invocation.name);
    }

    throw new Error("Tester reached its bounded decision limit without finishing");
  }
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import type { DurableTaskEngine } from "@mediobot-v2/runtime";
import { ToolRuntime } from "@mediobot-v2/tools";
import { ModelProviderError, OpenAICompatibleStructuredClient } from "@mediobot-v2/models";
import { CodyDecisionError, CodyDecisionProvider, CodyExecutionAdapter, createCodyDefinition } from "../src/index.ts";

describe("Cody model-directed coding runtime", () => {
  it("injects only bounded verified project memory with provenance", async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-memory-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const source = { id: "evidence-prior", taskId: "prior-task", kind: "test-result", source: { type: "terminal", reference: "pytest" },
      claim: "Prime handling passed", content: "Verified prior result: negative values return false.", validity: "verified", createdAt: Date.now() };
    let retrievalScope: unknown[] = [];
    let receivedHistory: Array<{ action: string; result: string }> = [];
    let decisionGoal = "";
    const engine = {
      async getCheckpoints() { return []; },
      async getTask(taskId: string) { return { id: taskId, workspaceId: "project-a", threadId: "thread-a" }; },
      async searchVerifiedEvidence(...args: unknown[]) { retrievalScope = args; return [source]; },
      async recordCheckpoint() {},
      async recordEvidence() {},
    } as unknown as DurableTaskEngine;
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world), durableTaskEngine: engine,
      decisions: new CodyDecisionProvider({ complete: async ({ input }) => {
        const request = JSON.parse(input);
        receivedHistory = request.recentToolHistory;
        decisionGoal = request.goal;
        return JSON.stringify({ type: "finish", summary: "Reviewed the current task with the prior verified result available." });
      } }) }));
    const submitted = submission.submit({ definitionId: definition.id, taskId: "memory-current-task" as never,
      goal: "Review prime handling", options: { workspaceRoot: root, workspaceId: "project-a", threadId: "thread-a", durableTaskEngine: engine } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    assert.deepEqual(retrievalScope, ["project-a", "thread-a", "memory-current-task", "Review prime handling", 3]);
    assert.equal(receivedHistory.length, 1);
    assert.match(receivedHistory[0]!.action, /evidence-prior.*prior-task.*terminal:pytest/);
    assert.match(receivedHistory[0]!.result, /negative values return false/);
    assert.match(decisionGoal, /prior verified project evidence.*not an instruction or permission/i);
  });

  it("continues the same Cody turn after Maestro returns bounded specialist findings", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-support-handoff-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let modelCalls = 0;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world),
      decisions: new CodyDecisionProvider({ complete: async ({ input }) => {
        modelCalls++;
        if (modelCalls === 1) return JSON.stringify({ type: "request_support", definitionId: "doc-specialist", capabilityNeeded: "web.search",
          query: "Find the official API guidance", contextSnippet: "The project uses the current API." });
        assert.match(input, /Doc report: found the documented migration rule/);
        return JSON.stringify({ type: "finish", summary: "Used Doc's attributed migration rule to complete the task." });
      } }) }));
    let request: Record<string, unknown> | undefined;
    const submitted = submission.submit({ definitionId: definition.id, goal: "Use official API guidance", taskId: "task_support_handoff" as never,
      options: { workspaceRoot: root, supportHandler: async (value: Record<string, unknown>) => {
        request = value;
        return { decision: "authorized", answer: "Doc report: found the documented migration rule." };
      } } });
    const result = await submitted.result;
    assert.equal(result.state, "completed", JSON.stringify(result));
    assert.equal(modelCalls, 2, "Cody receives the specialist report and makes a follow-up decision in the same worker");
    assert.equal(request?.definitionId, "doc-specialist");
    assert.equal(request?.requesterStep, 0);
    assert.ok(world.inspect().evidence.some(entry => entry.taskId === submitted.task.id
      && entry.source.type === "cody-summary" && /Used Doc's attributed migration rule/.test(entry.content)));
  });

  it("persists bounded tool outcomes with the durable child and parent task", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-durable-tool-evidence-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "readme.txt"), "bounded evidence survives restart\n");
    const persisted: Array<{ taskId: string; evidence: Record<string, unknown> }> = [];
    const engine = {
      async getCheckpoints() { return []; },
      async recordCheckpoint() {},
      async recordEvidence(taskId: string, evidence: Record<string, unknown>) { persisted.push({ taskId, evidence }); },
    } as unknown as DurableTaskEngine;
    const actions = [
      { type: "read", path: "readme.txt" },
      { type: "finish", summary: "Read the bounded evidence file." },
    ];
    let index = 0;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world),
      decisions: new CodyDecisionProvider({ complete: async () => JSON.stringify(actions[index++]) }) }));
    const childTaskId = "task_child" as never;
    const parentTaskId = "task_parent" as never;
    const submitted = submission.submit({ definitionId: definition.id, goal: "Read one file", taskId: childTaskId,
      options: { workspaceRoot: root, durableTaskEngine: engine, parentTaskId } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    const matching = persisted.filter(item => (item.taskId === childTaskId || item.taskId === parentTaskId)
      && item.evidence.kind === "tool-result");
    assert.equal(matching.length, 2);
    for (const item of matching) {
      const source = item.evidence.source as { type?: string; reference?: string };
      assert.equal(source.type, "coding-tool");
      assert.ok(source.reference);
      assert.equal(item.evidence.validity, "observed");
      assert.match(String(item.evidence.content), /filesystem.read succeeded/);
      assert.ok(String(item.evidence.content).length < 2_000);
      assert.equal(String(item.evidence.content).includes("bounded evidence survives restart"), false,
        "durable tool evidence contains bounded outcome metadata, not file contents");
    }
  });

  it("does not mark a task complete when durable tool evidence cannot be saved", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-evidence-write-failure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "readme.txt"), "read-only input\n");
    let calls = 0;
    const engine = {
      async getCheckpoints() { return []; },
      async recordCheckpoint() {},
      async recordEvidence() { throw new Error("controlled storage failure"); },
    } as unknown as DurableTaskEngine;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world),
      decisions: new CodyDecisionProvider({ complete: async () => { calls++; return JSON.stringify({ type: "read", path: "readme.txt" }); } }) }));
    const submitted = submission.submit({ definitionId: definition.id, goal: "Read one file", taskId: "task_storage_failure" as never,
      options: { workspaceRoot: root, durableTaskEngine: engine } });
    const result = await submitted.result;
    assert.equal(result.state, "failed");
    assert.match(result.error ?? "", /durable result could not be saved/);
    assert.equal(calls, 1, "the already completed tool operation is not replayed after the evidence write fails");
    assert.ok(world.inspect().evidence.some(entry => entry.taskId === submitted.task.id && entry.source.type === "coding-tool"));
  });

  it("records bounded request timing and sanitized transport phase for model decisions", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const provider = new CodyDecisionProvider({
      async complete() { return JSON.stringify({ type: "finish", summary: "Done" }); },
      metrics() { return { durationMs: 45, ttfbMs: 12, ttftMs: 20, inputTokens: 200, outputTokens: 12 }; },
    }, diagnostic => diagnostics.push(diagnostic as unknown as Record<string, unknown>));
    await provider.decide("Bounded objective", [], new AbortController().signal);
    assert.deepEqual(diagnostics[0], { stage: "provider", category: "completed", durationMs: 45,
      systemCharacters: diagnostics[0]!.systemCharacters, inputCharacters: JSON.stringify({ goal: "Bounded objective", recentToolHistory: [] }).length,
      responseCharacters: JSON.stringify({ type: "finish", summary: "Done" }).length,
      ttfbMs: 12, ttftMs: 20, inputTokens: 200, outputTokens: 12 });
    assert.equal(typeof diagnostics[0]!.systemCharacters, "number");

    const failed: Array<Record<string, unknown>> = [];
    const timedOut = new CodyDecisionProvider({ complete: async () => { throw new ModelProviderError("timeout", "Model request timed out during body", {
      phase: "body", elapsedMs: 180_000, timeoutMs: 180_000, ttfbMs: 12_000, ttftMs: 18_000,
    }); } }, diagnostic => failed.push(diagnostic as unknown as Record<string, unknown>));
    await assert.rejects(() => timedOut.decide("Secret-safe objective", [], new AbortController().signal));
    assert.equal(failed[0]?.code, "timeout");
    assert.equal(failed[0]?.phase, "body");
    assert.equal(failed[0]?.elapsedMs, 180_000);
    assert.equal(JSON.stringify(failed).includes("Secret-safe objective"), false);
  });

  it("selects allowlisted tools, edits the explicit workspace, verifies it, and attributes evidence", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-loop-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "test"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(path.join(root, "src", "math.js"), "export const add = (a, b) => a * b;\n");
    await writeFile(path.join(root, "test", "math.test.js"), [
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.js';",
      "assert.equal(add(2, 3), 5);",
    ].join("\n"));

    const actions = [
      { type: "list", path: "." },
      { type: "read", path: "src/math.js" },
      { type: "write", path: "src/math.js", content: "export const add = (a, b) => a + b;\n" },
      { type: "run", command: process.execPath, args: ["--test", "test/math.test.js"], cwd: ".", verification: "Addition regression test" },
      { type: "finish", summary: "Fixed the addition function and verified the test." },
    ];
    let decisionIndex = 0;
    const model = { complete: async () => JSON.stringify(actions[decisionIndex++]) };
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const decisions = new CodyDecisionProvider(model);
    const tools = new ToolRuntime(world);
    const toolInvocations: Array<{ name: string; input: Record<string, unknown> }> = [];
    const invoke = tools.invoke.bind(tools);
    tools.invoke = async (invocation, control) => {
      toolInvocations.push({ name: invocation.name, input: invocation.input as Record<string, unknown> });
      return invoke(invocation, control);
    };
    const runtime = new WorkerRuntime(world);
    const submission = new RuntimeTaskSubmission(world, runtime);
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools, decisions }));
    const events: string[] = [];
    const submitted = submission.submit({ definitionId: definition.id, goal: "Repair the failing addition test", options: { workspaceRoot: root },
      onEvent: (event) => events.push(event.type) });
    const result = await submitted.result;

    assert.deepEqual(result, { state: "completed" });
    assert.match(await readFile(path.join(root, "src", "math.js"), "utf8"), /a \+ b/);
    assert.equal(decisionIndex, actions.length);
    const replacementWrite = toolInvocations.find(entry => entry.name === "filesystem.write");
    assert.equal(replacementWrite?.input.expectedContentHash,
      createHash("sha256").update("export const add = (a, b) => a * b;\n").digest("hex"),
      "Cody must guard a replacement with the exact file version it read");
    const snapshot = world.inspect();
    assert.ok(snapshot.artifacts.some((artifact) => artifact.taskId === submitted.task.id
      && artifact.workerId === submitted.workers[0]?.id && artifact.reference === "src/math.js"));
    assert.ok(snapshot.evidence.some((evidence) => evidence.taskId === submitted.task.id
      && evidence.workerId === submitted.workers[0]?.id && evidence.source.type === "cody-summary"));
    const diffEvidence = snapshot.evidence.find((evidence) => evidence.taskId === submitted.task.id
      && evidence.workerId === submitted.workers[0]?.id && evidence.source.type === "workspace-diff");
    assert.ok(diffEvidence);
    const diff = JSON.parse(diffEvidence.content) as { filePath: string; additions: number; deletions: number };
    assert.deepEqual({ filePath: diff.filePath, additions: diff.additions, deletions: diff.deletions },
      { filePath: "src/math.js", additions: 1, deletions: 1 });
    assert.ok(events.includes("tool.started"));
    assert.ok(events.includes("file.changed"));
    assert.ok(events.includes("task.completed"));
  });

  for (const scenario of ["write after verification", "failed verification", "ordinary command", "only ordinary success", "verification before write"] as const) {
    it(`requires fresh explicit verification: ${scenario}`, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-evidence-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      await writeFile(path.join(root, "value.txt"), "original");
      await writeFile(path.join(root, "check.cjs"), "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt', 'utf8'), 'updated');");
      await writeFile(path.join(root, "fail.cjs"), "process.exit(1);");
      await writeFile(path.join(root, "ordinary.cjs"), "console.log('inspection only');");
      const check = { type: "run", command: process.execPath, args: ["check.cjs"], verification: "File contains expected value" };
      const write = { type: "write", path: "value.txt", content: "updated" };
      const ordinary = { type: "run", command: process.execPath, args: ["ordinary.cjs"] };
      const finish = { type: "finish", summary: "Changes verified" };
      const actions = [
        { type: "read", path: "value.txt" },
        ...(scenario === "verification before write" ? [{ ...ordinary, verification: "Pre-change inspection" }] : []),
        write,
        ...(scenario === "only ordinary success" ? [ordinary] : scenario === "verification before write" ? [] : [check]),
        ...(scenario === "write after verification" ? [write]
          : scenario === "failed verification" ? [{ ...check, args: ["fail.cjs"] }]
          : scenario === "ordinary command" ? [ordinary] : []),
        finish, check, finish,
      ];
      let index = 0;
      let rejectedFinish = false;
      const world = createWorld();
      const definition = createCodyDefinition(world);
      const tools = new ToolRuntime(world);
      const decisions = new CodyDecisionProvider({ complete: async ({ input }) => {
        if (index === actions.length - 2) {
          const history = JSON.parse(input).recentToolHistory;
          assert.match(history.at(-1).result, /check command is required/i);
          rejectedFinish = true;
          assert.equal(world.inspect().evidence.some((entry) => entry.source.type === "cody-summary"), false);
        }
        return JSON.stringify(actions[index++]);
      } });
      const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
      submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools, decisions }));
      const submitted = submission.submit({ definitionId: definition.id, goal: "Update and check the file", options: { workspaceRoot: root } });
      assert.deepEqual(await submitted.result, { state: "completed" });
      assert.equal(rejectedFinish, true);
      assert.equal(index, actions.length);
      const evidence = world.inspect().evidence;
      const proof = evidence.filter((entry) => entry.source.type === "coding-verification");
      assert.equal(proof.length, 1);
      assert.equal(proof[0]?.kind, "command-execution");
      assert.equal(proof[0]?.validity, "observed");
      assert.equal(proof[0]?.claim, undefined);
      assert.match(proof[0]?.content ?? "", /process status only; task correctness is not established/i);
      assert.equal(proof[0]?.taskId, submitted.task.id);
      assert.equal(proof[0]?.workerId, submitted.workers[0]?.id);
      const commandEvidence = evidence.filter((entry) => entry.source.type === "coding-tool" && entry.content.startsWith("terminal.execute"));
      assert.equal(proof[0]?.source.reference, commandEvidence.at(-1)?.source.reference);
      assert.equal(evidence.find((entry) => entry.source.type === "cody-summary")?.validity, "observed");
    });
  }

  it("records finish-without-tools as an observed model summary, never verification", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-no-tools-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world),
      decisions: new CodyDecisionProvider({ complete: async () => JSON.stringify({ type: "finish", summary: "All tests passed" }) }) }));
    const submitted = submission.submit({ definitionId: definition.id, goal: "Describe the task", options: { workspaceRoot: root } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    const evidence = world.inspect().evidence;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.source.type, "cody-summary");
    assert.equal(evidence[0]?.kind, "model-summary");
    assert.equal(evidence[0]?.validity, "observed");
  });

  it("validates explicit verification intent instead of silently accepting malformed intent", async () => {
    for (const verification of [true, "", "   ", 1, {}]) {
      const provider = new CodyDecisionProvider({ complete: async () => JSON.stringify({ type: "run", command: "node", verification }) });
      await assert.rejects(() => provider.decide("goal", [], new AbortController().signal), CodyDecisionError);
    }
  });

  it("accepts one concise user-facing update alongside the real tool decision", async () => {
    let system = "";
    const provider = new CodyDecisionProvider({ complete: async request => {
      system = request.system;
      return JSON.stringify({ type: "run", command: "python3", args: ["-c", "print('ok')"],
        verification: "Run a Python smoke check", commentary: "The file is in place; I’m checking the edge cases now." });
    } });
    const action = await provider.decide("Create and verify the prime checker", [], new AbortController().signal);
    assert.equal(action.type, "run");
    assert.equal(action.commentary, "The file is in place; I’m checking the edge cases now.");
    assert.match(system, /optional "commentary" string/i);
    assert.match(system, /client-facing status update/i);
    assert.match(system, /Do not include hidden reasoning/i);
  });

  it("publishes model-authored updates as attributed runtime events without another model call", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-commentary-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let modelCalls = 0;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world), decisions: new CodyDecisionProvider({
      complete: async () => {
        modelCalls += 1;
        return modelCalls === 1
          ? JSON.stringify({ type: "list", path: ".", commentary: "I’m checking the workspace structure before making the change." })
          : JSON.stringify({ type: "finish", summary: "The workspace is ready for the requested change." });
      },
    }) }));
    const submitted = submission.submit({ definitionId: definition.id, goal: "Inspect the workspace", options: { workspaceRoot: root } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    const messages = world.inspect().events.filter(event => event.type === "worker.message");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.workerId, submitted.workers[0]?.id);
    assert.equal(messages[0]?.taskId, submitted.task.id);
    assert.equal(messages[0]?.message, "I’m checking the workspace structure before making the change.");
    assert.equal(modelCalls, 2, "updates use existing action responses and add no model calls");
  });

  it("gives Cody a bounded process-launch error instead of hiding it behind a null exit code", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-launch-error-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let modelCalls = 0;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world), decisions: new CodyDecisionProvider({
      complete: async ({ input }) => {
        modelCalls += 1;
        if (modelCalls === 1) return JSON.stringify({ type: "run", command: "mediobot-command-that-does-not-exist", verification: "Check the project" });
        assert.match(input, /launchErrorCode=ENOENT; exitCode=null/);
        return JSON.stringify({ type: "finish", summary: "The check could not start." });
      },
    }) }));
    const submitted = submission.submit({ definitionId: definition.id, goal: "Run a check", options: { workspaceRoot: root } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    const failure = world.inspect().events.filter(event => event.type === "tool.failed").at(-1);
    assert.equal(failure?.failureCategory, "command-error");
    assert.equal(failure?.error, "Command could not start (ENOENT).");
    assert.equal(failure?.errorCode, "ENOENT", "the safe launch error code survives the worker event boundary");
    assert.equal(failure?.exitCode, null);
  });

  it("normalizes reasoning-wrapped JSON and repairs malformed decisions within a fixed budget", async () => {
    const requests: Array<{ system: string }> = [];
    const outputs = [
      "not JSON and must not be echoed into repair context",
      '<think>private reasoning</think>\nThe action is:\n```json\n{"type":"list","path":"."}\n```',
    ];
    const provider = new CodyDecisionProvider({ complete: async (request) => {
      requests.push({ system: request.system });
      return outputs[requests.length - 1]!;
    } });
    assert.deepEqual(await provider.decide("List files", [], new AbortController().signal), { type: "list", path: "." });
    assert.equal(requests.length, 2);
    assert.match(requests[1]!.system, /invalid-json/);
    assert.match(requests[1]!.system, /exact keys only/);
    assert.doesNotMatch(requests[1]!.system, /private reasoning|must not be echoed/);
  });

  it("recovers from successive malformed reasoning responses before any tool action runs", async () => {
    const requests: Array<{ system: string }> = [];
    const outputs = ["not JSON", JSON.stringify({ type: "run", command: "node", note: "extra key" }),
      JSON.stringify({ type: "finish", summary: "Completed with available evidence" })];
    const provider = new CodyDecisionProvider({ complete: async request => {
      requests.push({ system: request.system });
      return outputs.shift()!;
    } });
    assert.deepEqual(await provider.decide("Summarize findings", [], new AbortController().signal),
      { type: "finish", summary: "Completed with available evidence" });
    assert.equal(requests.length, 3);
    assert.match(requests[2]!.system, /exact keys only/i);
  });

  it("retries one timed-out reasoning request with compact history before any tool action", async () => {
    const requests: Array<{ input: string; system: string }> = [];
    const diagnostics: Array<Record<string, unknown>> = [];
    const history = Array.from({ length: 10 }, (_, index) => ({ action: `action-${index}`, result: "x".repeat(1_500) }));
    const provider = new CodyDecisionProvider({ complete: async request => {
      requests.push({ input: request.input, system: request.system });
      if (requests.length === 1) throw new ModelProviderError("timeout", "Model request timed out during body", { phase: "body", elapsedMs: 180_000 });
      return JSON.stringify({ type: "finish", summary: "Used available findings" });
    } }, diagnostic => diagnostics.push(diagnostic as unknown as Record<string, unknown>));
    assert.deepEqual(await provider.decide("Original objective", history, new AbortController().signal),
      { type: "finish", summary: "Used available findings" });
    assert.equal(requests.length, 2);
    assert.ok(requests[1]!.input.length < requests[0]!.input.length, "retry carries bounded recent history");
    assert.match(requests[1]!.system, /previous reasoning request timed out/i);
    assert.equal(diagnostics.some(diagnostic => diagnostic.category === "timeout-retry"), true);
  });

  it("does not repeat a side-effecting tool action when transport retries before a decision is returned", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-no-duplicate-retry-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "value.txt"), "before");
    let requests = 0;
    const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "fixture", maxRetries: 1,
      fetch: async () => {
        requests++;
        if (requests === 1) return new Response("capacity", { status: 503, headers: { "retry-after": "0.05" } });
        const actions = [
          { type: "read", path: "value.txt" },
          { type: "write", path: "value.txt", content: "after" },
          { type: "run", command: process.execPath, args: ["-e", "process.stdout.write(require('node:fs').readFileSync('value.txt', 'utf8'))"], verification: "The updated value was read back" },
          { type: "finish", summary: "Updated and verified the value." },
        ];
        const content = JSON.stringify(actions[requests - 2]);
        return Response.json({ choices: [{ message: { content } }] });
      } });
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world), decisions: new CodyDecisionProvider(client) }));
    const submitted = submission.submit({ definitionId: definition.id, goal: "Update value.txt and verify the change", options: { workspaceRoot: root } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    assert.equal(requests, 5, "one transport retry preceded read, write, verification, and finish decisions");
    assert.equal(await readFile(path.join(root, "value.txt"), "utf8"), "after");
    const writeCalls = world.inspect().events.filter(event => event.toolName === "filesystem.write" && event.type === "tool.started" && event.toolInvocationId);
    assert.equal(writeCalls.length, 1, "the retry happened before execution and the side-effecting write ran once");
  });

  it("bounds unrecoverable malformed Cody decisions and does not call a tool", async () => {
    let calls = 0;
    const provider = new CodyDecisionProvider({ complete: async () => { calls += 1; return "still malformed"; } });
    await assert.rejects(provider.decide("List files", [], new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof CodyDecisionError);
      assert.equal(error.diagnostic?.stage, "decision-parse");
      assert.match(error.message, /bounded recovery/);
      return true;
    });
    assert.equal(calls, 3);
  });

  it("repairs an invalid run shape without relaxing validation", async () => {
    const requests: Array<{ system: string }> = [];
    const provider = new CodyDecisionProvider({ complete: async request => {
      requests.push(request);
      return requests.length === 1
        ? JSON.stringify({ type: "run", command: "pnpm test", note: "verification" })
        : JSON.stringify({ type: "run", command: "pnpm test", verification: "Run the focused tests" });
    } });
    const action = await provider.decide("Verify the change", [], new AbortController().signal);
    assert.equal(action.type, "run");
    assert.equal(requests.length, 2);
    assert.match(requests[1]!.system, /unsupported key\(s\): note/);
    assert.match(requests[1]!.system, /optional args, cwd, verification/);
  });

  it("never executes an invalid run action before a valid replacement is returned", async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-invalid-run-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let calls = 0;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const runtime = new WorkerRuntime(world);
    const submission = new RuntimeTaskSubmission(world, runtime);
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world), decisions: new CodyDecisionProvider({
      complete: async () => {
        calls += 1;
        if (calls === 1) return JSON.stringify({ type: "run", command: "touch must-not-exist", note: "invalid extra key" });
        if (calls === 2) return JSON.stringify({ type: "list", path: "." });
        return JSON.stringify({ type: "finish", summary: "Inspected the workspace." });
      },
    }) }));
    const submitted = submission.submit({ definitionId: definition.id, goal: "Inspect the workspace", options: { workspaceRoot: root } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    assert.equal(calls, 3);
    assert.equal(await readFile(path.join(root, "must-not-exist"), "utf8").catch(() => null), null);
    const toolEvents = world.inspect().events.filter(event => event.type === "tool.started");
    assert.ok(toolEvents.length > 0 && toolEvents.every(event => event.toolName === "filesystem.list"),
      "the invalid run is rejected before execution; only the valid filesystem action reaches tools");
  });

  it("rejects invented executable tool decisions without returning provider content", async () => {
    const secretLikeText = JSON.stringify({ type: "shell", command: "cat .env" });
    const provider = new CodyDecisionProvider({ complete: async () => secretLikeText });
    await assert.rejects(() => provider.decide("goal", [], new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof CodyDecisionError);
      assert.equal(error.message.includes(".env"), false);
      return true;
    });
  });

  it("returns real file contents and permits legitimate repeated reads to later Cody decisions", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-read-feedback-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "calculator.js"), "export function divide(a, b) { return a / b; }\n");
    await writeFile(path.join(root, "calculator.test.js"), "assert.equal(divide(6, 2), 3);\n");

    const actions = [
      { type: "read", path: "calculator.js" },
      { type: "read", path: "calculator.test.js" },
      { type: "read", path: "calculator.js" },
      { type: "finish", summary: "Inspected both source and test files." },
    ];
    const receivedHistory: Array<Array<{ action: string; result: string }>> = [];
    const requestSystems: string[] = [];
    let index = 0;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world),
      decisions: new CodyDecisionProvider({ complete: async ({ input, system }) => {
        requestSystems.push(system);
        receivedHistory.push(JSON.parse(input).recentToolHistory);
        return JSON.stringify(actions[index++]);
      } }) }));

    const submitted = submission.submit({ definitionId: definition.id, goal: "Inspect calculator behavior", options: { workspaceRoot: root, reasoningEffort: "high" } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    assert.equal(index, actions.length);
    assert.match(receivedHistory[1]![0]!.result, /export function divide\(a, b\)/);
    assert.match(receivedHistory[2]![1]!.result, /assert\.equal\(divide\(6, 2\), 3\)/);
    assert.equal(receivedHistory[3]!.filter((entry) => entry.action === "filesystem.read calculator.js").length, 2);
    assert.ok(requestSystems.every(system => system.includes("Requested reasoning effort: high")));
  });

  it("returns actual root and nested directory entries to continuation and the final Cody summary", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-list-feedback-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "alpha.txt"), "alpha");
    await writeFile(path.join(root, "nested", "beta.ts"), "beta");
    await writeFile(path.join(root, ".env"), "not to be listed");

    const histories: Array<Array<{ action: string; result: string }>> = [];
    let index = 0;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world), decisions: new CodyDecisionProvider({
      complete: async ({ input }) => {
        const data = JSON.parse(input) as { recentToolHistory: Array<{ action: string; result: string }> };
        histories.push(data.recentToolHistory);
        if (index++ === 0) return JSON.stringify({ type: "list", path: "." });
        if (index === 2) return JSON.stringify({ type: "list", path: "nested" });
        return JSON.stringify({ type: "finish", summary: data.recentToolHistory.map((entry) => entry.result).join("\n") });
      },
    }) }));
    const submitted = submission.submit({ definitionId: definition.id, goal: "What are all the files in the folder, including nested?", options: { workspaceRoot: root } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    assert.match(histories[1]![0]!.result, /alpha\.txt/);
    assert.match(histories[1]![0]!.result, /nested/);
    assert.doesNotMatch(histories[1]![0]!.result, /\.env/);
    assert.match(histories[2]![1]!.result, /beta\.ts/);
    const summary = world.inspect().evidence.find((entry) => entry.source.type === "cody-summary");
    assert.match(summary?.content ?? "", /alpha\.txt/);
    assert.match(summary?.content ?? "", /beta\.ts/);
    assert.doesNotMatch(summary?.content ?? "", /\.env/);
  });

  it("bounds repeated identical reads, gives the model one recovery chance, then fails clearly", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-repeat-read-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "calculator.js"), "export function divide(a, b) { return a / b; }\n");

    let calls = 0;
    let sawRecoveryFeedback = false;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const tools = new ToolRuntime(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools,
      decisions: new CodyDecisionProvider({ complete: async ({ input }) => {
        const history = JSON.parse(input).recentToolHistory as Array<{ result: string }>;
        calls += 1;
        if (history.at(-1)?.result.includes("same result without progress")) sawRecoveryFeedback = true;
        return JSON.stringify({ type: "read", path: "calculator.js" });
      } }) }));

    const events: string[] = [];
    const submitted = submission.submit({ definitionId: definition.id, goal: "Improve validation", options: { workspaceRoot: root },
      onEvent: (event) => events.push(event.type) });
    const result = await submitted.result;

    assert.equal(result.state, "failed");
    assert.match("error" in result ? result.error : "", /repeated the same action without progress/i);
    assert.equal(calls, 3, "One tool read, one bounded recovery prompt, then terminal failure");
    assert.equal(events.filter((event) => event === "tool.completed").length, 1);
    assert.equal(events.filter((event) => event === "tool.started").length, 1);
    assert.equal(sawRecoveryFeedback, true);
  });

  it("recovers from repeated directory listing by using the observed filenames without repeating the tool", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-repeat-list-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "calculator.js"), "export function isPrime(value) { return value > 1; }\n");

    const actions = [
      { type: "list", path: "." },
      { type: "list", path: "." },
      { type: "read", path: "calculator.js" },
      { type: "finish", summary: "Inspected calculator.js using the existing directory listing." },
    ];
    let decisionIndex = 0;
    let recoveryPromptObserved = false;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world),
      decisions: new CodyDecisionProvider({ complete: async ({ input }) => {
        const history = JSON.parse(input).recentToolHistory as Array<{ action: string; result: string }>;
        if (history.some(item => item.result.includes("Do not list") && item.result.includes("read the most relevant source file"))) recoveryPromptObserved = true;
        return JSON.stringify(actions[decisionIndex++]!);
      } }) }));

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const submitted = submission.submit({ definitionId: definition.id, goal: "Inspect the prime function", options: { workspaceRoot: root },
      onEvent: event => events.push(event as unknown as { type: string; [key: string]: unknown }) });
    assert.deepEqual(await submitted.result, { state: "completed" });
    assert.equal(recoveryPromptObserved, true);
    assert.equal(decisionIndex, actions.length);
    assert.equal(events.filter(event => event.type === "tool.completed" && JSON.stringify(event).includes("filesystem.list")).length, 1,
      "the repeated list is rejected before tool execution");
    assert.equal(events.filter(event => event.type === "tool.completed" && JSON.stringify(event).includes("filesystem.read")).length, 1);
  });

  it("reports missing-command diagnostics and blocks a repeated process despite changed verification wording", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-missing-command-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const missingCommand = `mediobot-command-that-does-not-exist-${globalThis.crypto.randomUUID()}`;
    const actions = [
      { type: "run", command: missingCommand, verification: "Check whether this executable is available" },
      { type: "run", command: missingCommand, verification: "Try the interpreter command again" },
      { type: "finish", summary: "The selected executable is unavailable; its process could not start (ENOENT)." },
    ];
    let calls = 0;
    let retryContext: Array<{ action: string; result: string }> = [];
    const lifecycle: Array<Record<string, unknown>> = [];
    const events: Array<{ type: string; error?: string; errorCode?: string; verificationStatus?: string }> = [];
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const tools = new ToolRuntime(world);
    const invoke = tools.invoke.bind(tools);
    tools.invoke = async (invocation, control) => {
      if (invocation.name === "terminal.execute") calls += 1;
      return invoke(invocation, control);
    };
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools,
      decisions: new CodyDecisionProvider({ complete: async ({ input }) => {
        const history = JSON.parse(input).recentToolHistory as Array<{ action: string; result: string }>;
        retryContext = history;
        return JSON.stringify(actions[history.some(item => item.result.includes("Not executed: this terminal command")
          || item.result.includes("Not executed: this exact terminal command")) ? 2 : history.some(item => item.action.startsWith("terminal.execute")) ? 1 : 0]);
      } }) }));
    const submitted = submission.submit({ definitionId: definition.id, goal: "Check whether the requested executable can be started", options: { workspaceRoot: root },
      onEvent: event => {
        lifecycle.push(event as unknown as Record<string, unknown>);
        if (event.type === "tool.failed") events.push({ type: event.type, error: event.error, errorCode: event.errorCode,
          verificationStatus: event.verificationStatus });
      } });

    assert.deepEqual(await submitted.result, { state: "completed" });
    assert.equal(calls, 1, "the same executable and arguments are launched only once");
    assert.ok(retryContext.some(item => item.result.includes("launchErrorCode=ENOENT")), "Cody receives the actual launch classification");
    assert.ok(retryContext.some(item => item.result.includes("Not executed: this exact terminal command already failed")), "the duplicate is rejected with recovery guidance");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.errorCode, "ENOENT");
    assert.equal(events[0]?.error, "Command could not start (ENOENT).");
    assert.equal(events[0]?.verificationStatus, "command-failed");
    assert.equal(lifecycle.filter(event => event.type === "tool.started").length, 1);
    assert.doesNotMatch(events[0]?.error ?? "", /mediobot-command-that-does-not-exist/);
  });

  it("does not replay a failed terminal side effect after inspection and an unrelated edit", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-terminal-retry-after-read-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = path.join(root, "side-effect.txt");
    await writeFile(path.join(root, "notes.txt"), "inspectable workspace evidence\n");
    const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.exit(1)`;
    const command = { type: "run", command: process.execPath, args: ["-e", script], cwd: "." } as const;
    let terminalInvocations = 0;
    let readInvocations = 0;
    let writeInvocations = 0;
    let sawBlockedRetry = false;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const tools = new ToolRuntime(world);
    const invoke = tools.invoke.bind(tools);
    tools.invoke = async (invocation, control) => {
      if (invocation.name === "terminal.execute") terminalInvocations += 1;
      if (invocation.name === "filesystem.read") readInvocations += 1;
      if (invocation.name === "filesystem.write") writeInvocations += 1;
      return invoke(invocation, control);
    };
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools,
      decisions: new CodyDecisionProvider({ complete: async ({ input }) => {
        const history = JSON.parse(input).recentToolHistory as Array<{ action: string; result: string }>;
        if (history.some(item => item.result.startsWith("Not executed: this exact terminal command already failed"))) {
          sawBlockedRetry = true;
          const latestTerminal = [...history].reverse().find(item => item.action.startsWith("terminal.execute"));
          if (latestTerminal?.result.includes("exitCode=0")) {
            return JSON.stringify({ type: "finish", summary: "The failed command was not repeated; a distinct read-only check completed." });
          }
          return JSON.stringify({ type: "run", command: process.execPath,
            args: ["-e", `require('node:fs').readFileSync(${JSON.stringify(path.join(root, "unrelated.txt"))})`], cwd: ".",
            verification: "Read the unrelated file without rerunning the failed command" });
        }
        if (history.some(item => item.action.startsWith("filesystem.write unrelated.txt"))) {
          return JSON.stringify({ ...command, cwd: "./", verification: "Retry the same command after inspection" });
        }
        if (history.some(item => item.action.startsWith("filesystem.read unrelated.txt"))) {
          return JSON.stringify({ type: "write", path: "unrelated.txt", content: "unrelated edit\n" });
        }
        if (history.some(item => item.action.startsWith("filesystem.read notes.txt"))) return JSON.stringify({ type: "read", path: "unrelated.txt" });
        if (history.some(item => item.action.startsWith("terminal.execute"))) return JSON.stringify({ type: "read", path: "notes.txt" });
        return JSON.stringify({ ...command, verification: "Append a marker, then return a nonzero exit code" });
      } }) }));

    const submitted = submission.submit({ definitionId: definition.id, goal: "Run the check once and inspect its failure safely",
      options: { workspaceRoot: root } });
    const taskResult = await submitted.result;
    assert.deepEqual(taskResult, { state: "completed" });
    assert.ok(readInvocations >= 2, "Cody may inspect the workspace and create an unrelated edit between attempts");
    assert.equal(writeInvocations, 1, "an unrelated workspace edit does not authorize command replay");
    assert.equal(terminalInvocations, 2, "only the original side effect and the distinct read-only verification execute");
    assert.equal(await readFile(marker, "utf8"), "x", "the original side effect occurred exactly once");
    assert.equal(await readFile(path.join(root, "unrelated.txt"), "utf8"), "unrelated edit\n");
    assert.equal(sawBlockedRetry, true, "Cody receives explicit recovery feedback before choosing to finish");
  });

  it("creates a new source file only after an ENOENT read and verifies the actual Python behavior", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-create-file-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = [
      "from math import isqrt",
      "",
      "def is_prime(value):",
      "    if not isinstance(value, int) or isinstance(value, bool):",
      "        raise TypeError('value must be an integer')",
      "    if value < 2:",
      "        return False",
      "    return all(value % divisor for divisor in range(2, isqrt(value) + 1))",
      "",
    ].join("\n");
    const actions = [
      { type: "list", path: "." },
      { type: "read", path: "is_prime.py" },
      { type: "write", path: "is_prime.py", content: source },
      { type: "run", command: "python3", args: ["-c", "from is_prime import is_prime; assert not is_prime(-3); assert not is_prime(0); assert not is_prime(1); assert is_prime(2); assert is_prime(104729); assert not is_prime(104728)"], cwd: ".", verification: "Check negative values, 0, 1, 2, and large prime/non-prime values" },
      { type: "finish", summary: "Created is_prime.py and verified its edge cases with Python." },
    ];
    let decisionIndex = 0;
    let sawMissingFile = false;
    const invocations: Array<{ name: string; input: Record<string, unknown> }> = [];
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const tools = new ToolRuntime(world);
    const invoke = tools.invoke.bind(tools);
    tools.invoke = async (invocation, control) => {
      invocations.push({ name: invocation.name, input: invocation.input as Record<string, unknown> });
      return invoke(invocation, control);
    };
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools,
      decisions: new CodyDecisionProvider({ complete: async ({ input }) => {
        const history = JSON.parse(input).recentToolHistory as Array<{ action: string; result: string }>;
        if (history.some(item => item.action.includes("filesystem.read is_prime.py") && item.result.includes("ENOENT"))) sawMissingFile = true;
        return JSON.stringify(actions[decisionIndex++]!);
      } }) }));
    const submitted = submission.submit({ definitionId: definition.id, goal: "Create and verify a Python prime-number helper", options: { workspaceRoot: root } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    assert.equal(sawMissingFile, true);
    assert.deepEqual(await readFile(path.join(root, "is_prime.py"), "utf8"), source);
    const createInvocation = invocations.find(entry => entry.name === "filesystem.write");
    assert.equal(createInvocation?.input.createOnly, true, "a newly created path uses the no-replace write mode");
    const verification = invocations.find(entry => entry.name === "terminal.execute");
    assert.ok(verification, "Cody must execute the requested behavioral check");
    const terminalEvent = world.inspect().events.find(event => event.type === "tool.completed" && event.toolName === "terminal.execute");
    assert.equal(terminalEvent?.exitCode, 0);
  });

  it("returns a failed read's real result for bounded model recovery, with sanitized diagnostics", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-read-failure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const histories: Array<Array<{ action: string; result: string }>> = [];
    const diagnostics: Array<Record<string, unknown>> = [];
    const actions = [
      { type: "read", path: "missing.js" },
      { type: "read", path: "calculator.js" },
      { type: "finish", summary: "Read the available source after reporting the missing file." },
    ];
    let index = 0;
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
      decisions: new CodyDecisionProvider({ complete: async ({ input }) => {
        histories.push(JSON.parse(input).recentToolHistory);
        return JSON.stringify(actions[index++]);
      } }) }));
    await writeFile(path.join(root, "calculator.js"), "export function divide(a, b) { return a / b; }\n");
    const events: string[] = [];
    const submitted = submission.submit({ definitionId: definition.id, goal: "Read missing file", options: { workspaceRoot: root },
      onEvent: (event) => events.push(event.type) });

    const result = await submitted.result;
    assert.deepEqual(result, { state: "completed" });
    assert.equal(index, 3);
    assert.equal(events.includes("tool.failed"), true);
    assert.equal(events.includes("tool.completed"), true);
    assert.match(histories[1]![0]!.result, /^failed: .*ENOENT/);
    assert.match(histories[2]![1]!.result, /export function divide/);
    const failedReadDiagnostic = diagnostics.find(diagnostic => diagnostic.stage === "tool-result" && diagnostic.toolName === "filesystem.read");
    assert.deepEqual(failedReadDiagnostic, { stage: "tool-result", toolName: "filesystem.read", status: "failed",
      failureStage: "filesystem", errorCode: "ENOENT", workspaceRelativePath: "missing.js" });
    assert.equal(JSON.stringify(diagnostics).includes(root), false);
    const evidence = world.inspect().evidence.filter((entry) => entry.source.type === "coding-tool");
    assert.equal(evidence.length, 2);
    assert.match(evidence[0]!.content, /^filesystem\.read failed; stage=filesystem; code=ENOENT$/);
    assert.equal(world.inspect().evidence.some((entry) => entry.source.type === "cody-summary"), true);
  });

  it("returns ordinary search and edit failures to model continuation instead of an internal runtime failure", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-tool-failure-feedback-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "source.txt"), "hello world");
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const decisions = [
      { type: "search", query: "[", path: ".", isRegex: true },
      { type: "read", path: "source.txt" },
      { type: "edit", path: "source.txt", oldText: "not present", newText: "replacement" },
      { type: "finish", summary: "Search pattern and edit target were not valid; no changes made." },
    ];
    let index = 0;
    const received: Array<Array<{ action: string; result: string }>> = [];
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world), decisions: new CodyDecisionProvider({
      complete: async ({ input }) => {
        const history = JSON.parse(input).recentToolHistory as Array<{ action: string; result: string }>;
        received.push(history);
        return JSON.stringify(decisions[index++]);
      },
    }) }));
    const submitted = submission.submit({ definitionId: definition.id, goal: "Search and inspect safely", options: { workspaceRoot: root } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    assert.equal(index, decisions.length);
    assert.match(received[1]!.at(-1)!.result, /^failed:/);
    assert.match(received[3]!.at(-1)!.result, /TARGET_NOT_FOUND|not found/i);
    assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "hello world");
  });

  it("normalizes ./path in write operations when file was read as bare path", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-normalize-path-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "calculator.js"), "export function divide(a, b) { return a / b; }\n");
    await writeFile(path.join(root, "check.js"), "process.exit(0);");

    const actions = [
      { type: "read", path: "calculator.js" },
      { type: "write", path: "./calculator.js", content: "export function divide(a, b) { if (b === 0) return Infinity; return a / b; }\n" },
      { type: "run", command: process.execPath, args: ["check.js"], verification: "Check passes" },
      { type: "finish", summary: "Updated calculator with path normalization." },
    ];
    let index = 0;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world),
      decisions: new CodyDecisionProvider({ complete: async () => JSON.stringify(actions[index++]) }) }));

    const submitted = submission.submit({ definitionId: definition.id, goal: "Fix division", options: { workspaceRoot: root } });
    const result = await submitted.result;
    assert.deepEqual(result, { state: "completed" });
    assert.equal(index, actions.length);
    assert.match(await readFile(path.join(root, "calculator.js"), "utf8"), /if \(b === 0\)/);
  });

  it("provides recovery feedback when writing an unread file before modifying it", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-cody-unread-write-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "calculator.js"), "export function divide(a, b) { return a / b; }\n");
    await writeFile(path.join(root, "check.js"), "process.exit(0);");

    const actions = [
      { type: "write", path: "calculator.js", content: "updated" },
      { type: "read", path: "calculator.js" },
      { type: "write", path: "calculator.js", content: "export function divide(a, b) { return a / b; }\n" },
      { type: "run", command: process.execPath, args: ["check.js"], verification: "Check passes" },
      { type: "finish", summary: "Fixed" },
    ];
    let index = 0;
    const world = createWorld();
    const definition = createCodyDefinition(world);
    const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
    submission.registerAdapter(definition.id, new CodyExecutionAdapter({ tools: new ToolRuntime(world),
      decisions: new CodyDecisionProvider({ complete: async ({ input }) => {
        if (index === 1) {
          const history = JSON.parse(input).recentToolHistory;
          assert.match(history.at(-1).result, /must read an existing file before replacing it/);
        }
        return JSON.stringify(actions[index++]);
      } }) }));

    const submitted = submission.submit({ definitionId: definition.id, goal: "Write with recovery", options: { workspaceRoot: root } });
    const result = await submitted.result;
    assert.deepEqual(result, { state: "completed" });
    assert.equal(index, actions.length);
  });

  it("includes sanitized diagnostic details in CodyDecisionError message", async () => {
    const provider1 = new CodyDecisionProvider({ complete: async () => "not json" });
    await assert.rejects(() => provider1.decide("goal", [], new AbortController().signal), (err: unknown) => {
      assert.ok(err instanceof CodyDecisionError);
      assert.match(err.message, /decision-parse: invalid-json/);
      assert.equal(err.diagnostic?.stage, "decision-parse");
      assert.equal(err.diagnostic?.category, "invalid-json");
      return true;
    });

    const provider2 = new CodyDecisionProvider({ complete: async () => JSON.stringify({ type: "unknown_tool", foo: "bar" }) });
    await assert.rejects(() => provider2.decide("goal", [], new AbortController().signal), (err: unknown) => {
      assert.ok(err instanceof CodyDecisionError);
      assert.match(err.message, /decision-intent: unsupported-action/);
      assert.equal(err.diagnostic?.stage, "decision-intent");
      assert.equal(err.diagnostic?.actionType, "unknown_tool");
      return true;
    });
  });
});

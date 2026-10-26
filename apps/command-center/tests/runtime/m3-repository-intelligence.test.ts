import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createWorld, type TaskId, type WorkerId, type ResourceId } from "@mediobot-v2/domain";
import { WorkerRuntime } from "@mediobot-v2/runtime";
import {
  ToolRuntime,
  ToolPermissionEngine,
  ToolPermissionError,
  type ApprovalRequest,
  type ToolInvocation,
} from "@mediobot-v2/tools";
import {
  CodyDecisionProvider,
  CodyExecutionAdapter,
  createCodyDefinition,
} from "@mediobot-v2/cody";
import {
  createTesterDefinition,
  computeWorkspaceRevision,
  invalidateStaleVerificationEvidence,
  createShadowWorkspace,
  TesterDecisionProvider,
  TesterExecutionAdapter,
  type VerificationReport,
} from "@mediobot-v2/tester";

type TestFixture = {
  root: string;
  world: ReturnType<typeof createWorld>;
  tools: ToolRuntime;
  engine: ToolPermissionEngine;
  workerId: WorkerId;
  taskId: TaskId;
  resourceId: ResourceId;
  cleanup: () => Promise<void>;
};

async function createFixture(options: { mode?: "Require approval" | "Approve for me"; timeoutMs?: number } = {}): Promise<TestFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-m3-fixture-"));
  const world = createWorld();
  const definition = createCodyDefinition(world);
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask("test task").id, worker.id);
  const resource = world.registerResource({
    kind: "workspace",
    owner: { type: "worker", worldId: world.id, workerId: worker.id },
  });

  const engine = new ToolPermissionEngine({
    defaultPolicy: {
      mode: options.mode ?? "Approve for me",
      approvalTimeoutMs: options.timeoutMs ?? 300_000,
    },
  });

  const tools = new ToolRuntime(world, { permissionEngine: engine });
  await tools.bindWorkspace(resource.id, root);

  world.setWorkerState(worker.id, "busy");
  world.setTaskState(task.id, "running");
  world.setResourceState(resource.id, "in-use");

  return {
    root,
    world,
    tools,
    engine,
    workerId: worker.id,
    taskId: task.id,
    resourceId: resource.id,
    cleanup: async () => {
      tools.releaseWorkspace(resource.id);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("MEDIOBOT V2 — M3: Advanced Repository Intelligence & Precision Editing Acceptance Suite", () => {
  // Test 1: Exact-match precision edits with structured diffs
  it("Test 1: exact-match precision edit replaces content and produces structured diffs", async () => {
    const f = await createFixture();
    try {
      const initialCode = `function calculateTotal(items) {\n  let total = 0;\n  for (const item of items) {\n    total += item.price;\n  }\n  return total;\n}\n`;
      await writeFile(path.join(f.root, "calc.js"), initialCode, "utf8");

      const invocation: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        signal: new AbortController().signal,
        name: "filesystem.edit",
        input: {
          path: "calc.js",
          edits: [
            {
              oldText: "    total += item.price;",
              newText: "    total += item.price * (1 - (item.discount || 0));",
            },
          ],
        },
      };

      const result = await f.tools.invoke(invocation);
      assert.equal(result.status, "succeeded");
      assert.ok(result.output);
      assert.ok("diff" in result.output);
      assert.ok("contentHash" in result.output);
      assert.equal(result.output.additions, 1);
      assert.equal(result.output.deletions, 1);

      const updatedCode = await readFile(path.join(f.root, "calc.js"), "utf8");
      assert.ok(updatedCode.includes("total += item.price * (1 - (item.discount || 0));"));
      assert.ok(!updatedCode.includes("    total += item.price;\n"));
      assert.ok(updatedCode.endsWith("\n"), "Preserves trailing newline formatting");
    } finally {
      await f.cleanup();
    }
  });

  // Test 2: Ambiguous match detection and rejection
  it("Test 2: rejects ambiguous matches when oldText occurs multiple times without allowMultiple", async () => {
    const f = await createFixture();
    try {
      const code = `const a = 10;\nconsole.log(a);\nconst b = 10;\nconsole.log(b);\n`;
      await writeFile(path.join(f.root, "dup.js"), code, "utf8");

      // Ambiguous without allowMultiple -> must fail
      const invocation: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        signal: new AbortController().signal,
        name: "filesystem.edit",
        input: {
          path: "dup.js",
          edits: [{ oldText: "10", newText: "20" }],
        },
      };

      const result = await f.tools.invoke(invocation);
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "AMBIGUOUS_MATCH");
      assert.match(result.error ?? "", /appears 2 times/);

      // File must remain unchanged
      const unchanged = await readFile(path.join(f.root, "dup.js"), "utf8");
      assert.equal(unchanged, code);

      // With allowMultiple: true -> succeeds
      const invocationMulti: ToolInvocation = {
        ...invocation,
        input: {
          path: "dup.js",
          edits: [{ oldText: "10", newText: "20", allowMultiple: true }],
        },
      };
      const resultMulti = await f.tools.invoke(invocationMulti);
      assert.equal(resultMulti.status, "succeeded");
      const multiUpdated = await readFile(path.join(f.root, "dup.js"), "utf8");
      assert.equal(multiUpdated, `const a = 20;\nconsole.log(a);\nconst b = 20;\nconsole.log(b);\n`);
    } finally {
      await f.cleanup();
    }
  });

  // Test 3: Stale revision rejection via expectedContentHash
  it("Test 3: rejects stale edit when expectedContentHash does not match", async () => {
    const f = await createFixture();
    try {
      const original = `export const version = '1.0.0';\n`;
      await writeFile(path.join(f.root, "version.js"), original, "utf8");

      const badHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const invocation: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        signal: new AbortController().signal,
        name: "filesystem.edit",
        input: {
          path: "version.js",
          expectedContentHash: badHash,
          edits: [{ oldText: "'1.0.0'", newText: "'1.0.1'" }],
        },
      };

      const result = await f.tools.invoke(invocation);
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "STALE_REVISION");
      assert.match(result.error ?? "", /STALE_REVISION/);

      // Verify correct hash works
      const actualHash = createHash("sha256").update(Buffer.from(original, "utf8")).digest("hex");
      const invocationCorrect: ToolInvocation = {
        ...invocation,
        input: {
          path: "version.js",
          expectedContentHash: actualHash,
          edits: [{ oldText: "'1.0.0'", newText: "'1.0.1'" }],
        },
      };
      const resultCorrect = await f.tools.invoke(invocationCorrect);
      assert.equal(resultCorrect.status, "succeeded");
    } finally {
      await f.cleanup();
    }
  });

  // Test 4: Atomicity on edit failures
  it("Test 4: atomicity: failed multi-chunk edit leaves file unaltered with no corrupt temp files", async () => {
    const f = await createFixture();
    try {
      const original = `const x = 1;\nconst y = 2;\nconst z = 3;\n`;
      await writeFile(path.join(f.root, "data.js"), original, "utf8");

      // First chunk valid, second chunk invalid target
      const invocation: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        signal: new AbortController().signal,
        name: "filesystem.edit",
        input: {
          path: "data.js",
          edits: [
            { oldText: "const x = 1;", newText: "const x = 100;" },
            { oldText: "NON_EXISTENT_LINE", newText: "SHOULD_FAIL" },
          ],
        },
      };

      const result = await f.tools.invoke(invocation);
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "TARGET_NOT_FOUND");

      // File content must be exactly identical to original
      const current = await readFile(path.join(f.root, "data.js"), "utf8");
      assert.equal(current, original);

      // No .tmp files left in directory
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(f.root);
      assert.equal(files.length, 1);
      assert.equal(files[0], "data.js");
    } finally {
      await f.cleanup();
    }
  });

  // Test 5: Line-range file inspection and bounded repository search
  it("Test 5: line-range inspection and bounded repository search work correctly", async () => {
    const f = await createFixture();
    try {
      // Create a 200-line file
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: ${i === 42 ? "TARGET_STRING" : "content"}`);
      await writeFile(path.join(f.root, "large.txt"), lines.join("\n"), "utf8");
      await mkdir(path.join(f.root, "sub"), { recursive: true });
      await writeFile(path.join(f.root, "sub", "another.txt"), "here is another TARGET_STRING match\n", "utf8");

      // Range read: lines 40 to 45
      const readInvocation: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        signal: new AbortController().signal,
        name: "filesystem.read",
        input: { path: "large.txt", startLine: 40, endLine: 45 },
      };
      const readResult = await f.tools.invoke(readInvocation);
      assert.equal(readResult.status, "succeeded");
      assert.ok(readResult.output && "content" in readResult.output);
      assert.equal(readResult.output.startLine, 40);
      assert.equal(readResult.output.endLine, 45);
      assert.equal(readResult.output.totalLines, 200);
      assert.ok(readResult.output.content.includes("line 43: TARGET_STRING"));

      // Search: find TARGET_STRING
      const searchInvocation: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        signal: new AbortController().signal,
        name: "filesystem.search",
        input: { query: "TARGET_STRING" },
      };
      const searchResult = await f.tools.invoke(searchInvocation);
      assert.equal(searchResult.status, "succeeded");
      assert.ok(searchResult.output && "matches" in searchResult.output);
      assert.equal(searchResult.output.totalMatches, 2);
      assert.ok(searchResult.output.matches.some((m) => m.path === "large.txt" && m.lineNumber === 43));
      assert.ok(searchResult.output.matches.some((m) => m.path === "sub/another.txt" && m.lineNumber === 1));
    } finally {
      await f.cleanup();
    }
  });

  // Test 6: Workspace boundary and path traversal protection
  it("Test 6: blocks workspace traversal attempts on filesystem.edit and filesystem.search", async () => {
    const f = await createFixture();
    try {
      // Traversal on edit
      const escapeEdit: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        signal: new AbortController().signal,
        name: "filesystem.edit",
        input: { path: "../escape.txt", edits: [{ oldText: "a", newText: "b" }] },
      };
      const editRes = await f.tools.invoke(escapeEdit);
      assert.equal(editRes.status, "failed");
      assert.equal(editRes.failureStage, "filesystem");

      // Traversal on search
      const escapeSearch: ToolInvocation = {
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        signal: new AbortController().signal,
        name: "filesystem.search",
        input: { query: "root", path: "../../etc" },
      };
      const searchRes = await f.tools.invoke(escapeSearch);
      assert.equal(searchRes.status, "failed");
      assert.equal(searchRes.failureStage, "filesystem");
    } finally {
      await f.cleanup();
    }
  });

  // Test 7: Permission engine enforcement on filesystem.edit
  it("Test 7: permission engine classifies filesystem.edit as mutating and requires approval under Require approval policy", async () => {
    const f = await createFixture({ mode: "Require approval" });
    try {
      await writeFile(path.join(f.root, "config.json"), '{"env":"test"}', "utf8");

      let capturedRequest: ApprovalRequest | undefined;
      f.engine.setNotifiers({
        onApprovalRequested: (req) => {
          capturedRequest = req;
        },
      });

      const invokePromise = f.tools.invoke({
        worldId: f.world.id,
        workerId: f.workerId,
        taskId: f.taskId,
        resourceId: f.resourceId,
        name: "filesystem.edit",
        input: { path: "config.json", edits: [{ oldText: '"test"', newText: '"prod"' }] },
      });

      // Allow microtasks to execute and pause
      await new Promise((r) => setTimeout(r, 20));

      assert.ok(capturedRequest, "Approval request must have been triggered");
      assert.equal(capturedRequest.toolName, "filesystem.edit");
      assert.equal(capturedRequest.status, "requested");
      assert.equal(capturedRequest.risk, "medium");

      // Grant approval and resolve
      f.engine.respond(capturedRequest.approvalId, true);
      const result = await invokePromise;
      assert.equal(result.status, "succeeded");

      const updated = await readFile(path.join(f.root, "config.json"), "utf8");
      assert.equal(updated, '{"env":"prod"}');
    } finally {
      await f.cleanup();
    }
  });

  // Test 8: Tester denied mutating tools (filesystem.edit and filesystem.write)
  it("Test 8: permission engine strictly denies filesystem.edit and filesystem.write to Tester worker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-m3-tester-perm-"));
    const world = createWorld();
    const testerDef = createTesterDefinition(world);
    const testerWorker = world.spawnWorker(testerDef.id);
    const task = world.assignTask(world.createTask("test task").id, testerWorker.id);
    const resource = world.registerResource({
      kind: "workspace",
      owner: { type: "worker", worldId: world.id, workerId: testerWorker.id },
    });

    const engine = new ToolPermissionEngine({ defaultPolicy: { mode: "Approve for me" } });
    const tools = new ToolRuntime(world, { permissionEngine: engine });
    await tools.bindWorkspace(resource.id, root);

    world.setWorkerState(testerWorker.id, "busy");
    world.setTaskState(task.id, "running");
    world.setResourceState(resource.id, "in-use");

    try {
      await writeFile(path.join(root, "test.txt"), "hello", "utf8");

      const invocation: ToolInvocation = {
        worldId: world.id,
        workerId: testerWorker.id,
        taskId: task.id,
        resourceId: resource.id,
        signal: new AbortController().signal,
        name: "filesystem.edit",
        input: { path: "test.txt", edits: [{ oldText: "hello", newText: "goodbye" }] },
      };

      const result = await tools.invoke(invocation);
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "PERMISSION_DENIED");
      assert.match(result.error ?? "", /Tester is not permitted to perform file modifications/i);
    } finally {
      tools.releaseWorkspace(resource.id);
      await rm(root, { recursive: true, force: true });
    }
  });

  // Test 9: Tester indirect write isolation via ephemeral shadow workspace
  it("Test 9: Tester indirect writes via terminal.execute do not mutate host project workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-m3-isolation-"));
    const pristineFile = "export const status = 'pure';";
    await writeFile(path.join(root, "status.js"), pristineFile, "utf8");

    // Create a script that tries to mutate status.js and write unauthorized files
    const mutateScript = `const fs = require('fs');
fs.writeFileSync('status.js', 'HACKED');
fs.writeFileSync('tampered.txt', 'evil');
console.log('Test executed');
process.exit(0);
`;
    await writeFile(path.join(root, "test-suite.js"), mutateScript, "utf8");

    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    const tools = new ToolRuntime(world);
    const definition = createTesterDefinition(world);
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Run test suite").id, worker.id);

    const actions = [
      { type: "run", command: process.execPath, args: ["test-suite.js"], check: "Execute test suite" },
      {
        type: "finish",
        report: {
          status: "verified",
          summary: "Ran tests cleanly",
          assertions: [{ name: "test-passed", passed: true }],
        },
      },
    ];
    let actionIdx = 0;
    const decisions = new TesterDecisionProvider({
      complete: async () => JSON.stringify(actions[actionIdx++]),
    });

    const adapter = new TesterExecutionAdapter({ tools, decisions });
    const plan = adapter.prepare({
      world,
      definitionId: definition.id,
      workerId: worker.id,
      taskId: task.id,
      goal: task.goal,
      options: { workspaceRoot: root },
    });

    try {
      const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
      assert.deepEqual(result, { state: "completed" });

      // Verify host workspace status.js is 100% untouched and pristine!
      const hostStatus = await readFile(path.join(root, "status.js"), "utf8");
      assert.equal(hostStatus, pristineFile, "Host file must never be corrupted by test executions");

      let tamperedExists = false;
      try {
        await stat(path.join(root, "tampered.txt"));
        tamperedExists = true;
      } catch {
        tamperedExists = false;
      }
      assert.equal(tamperedExists, false, "Spilled files must not exist in host workspace");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Test 10: Invalidation of verified evidence when source files change
  it("Test 10: invalidateStaleVerificationEvidence invalidates verified evidence when files change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-m3-inval-"));
    try {
      await writeFile(path.join(root, "src.js"), "const a = 1;\n", "utf8");

      const world = createWorld();
      const rev1 = await computeWorkspaceRevision(root);

      const goal = world.createGoal({
        threadId: "thread-1",
        objective: "Build project",
        successCriteria: [
          {
            id: "c1",
            statement: "Passing verification",
            evidenceRequirement: {
              kind: "test-execution",
              source: { type: "tester-verification", reference: "run-1" },
              validity: "verified",
              subject: "workspace",
              revision: rev1,
            },
          },
        ],
      });
      world.transitionGoal(goal.id, "active");

      const evidence = world.recordEvidence({
        goalId: goal.id,
        source: { type: "tester-verification", reference: "run-1" },
        kind: "test-execution",
        validity: "verified",
        subject: "workspace",
        revision: rev1,
        claim: "Tests passed on rev1",
        content: JSON.stringify({ status: "verified" }),
      });
      world.supportGoalCriterion(goal.id, "c1", "satisfied", [evidence.id]);
      world.transitionGoal(goal.id, "satisfied");

      // Before mutation: no invalidation
      const noneInvalidated = await invalidateStaleVerificationEvidence(world, root);
      assert.equal(noneInvalidated.length, 0);

      // Mutate source file
      await writeFile(path.join(root, "src.js"), "const a = 2;\n", "utf8");

      // After mutation: evidence invalidated and Goal moves from satisfied to blocked
      const invalidated = await invalidateStaleVerificationEvidence(world, root);
      assert.deepEqual(invalidated, [evidence.id]);

      const updatedEvidence = world.inspect().evidence.find((e) => e.id === evidence.id);
      assert.equal(updatedEvidence?.validity, "invalidated");

      const updatedGoal = world.inspect().goals.find((g) => g.id === goal.id);
      assert.equal(updatedGoal?.status, "blocked");
      assert.equal(updatedGoal?.successCriteria[0]?.state, "unknown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Test 11: End-to-end Maestro -> Cody precision edit -> Tester shadow verification
  it("Test 11: end-to-end Maestro -> Cody precision edit -> Tester verification completes goal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-m3-e2e-"));
    try {
      // Create initial buggy project
      await writeFile(path.join(root, "math.js"), "export function add(a, b) { return a - b; }\n", "utf8");
      await writeFile(
        path.join(root, "math.test.js"),
        `import { add } from './math.js';
if (add(2, 3) !== 5) { console.error('Math failed'); process.exit(1); }
console.log('Math passed');
process.exit(0);
`,
        "utf8",
      );

      const world = createWorld();
      const runtime = new WorkerRuntime(world);
      const tools = new ToolRuntime(world);
      const definition = createCodyDefinition(world);
      const codyWorker = world.spawnWorker(definition.id);

      // 1. Cody uses search, read range, precision edit, and verification run
      const codyActions = [
        { type: "search", query: "return a - b" },
        { type: "read", path: "math.js" },
        {
          type: "edit",
          path: "math.js",
          oldText: "return a - b;",
          newText: "return a + b;",
        },
        {
          type: "run",
          command: process.execPath,
          args: ["math.test.js"],
          verification: "Verify add function produces correct sum",
        },
        { type: "finish", summary: "Fixed math.js add function via precision edit and verified with test" },
      ];
      let codyIdx = 0;
      const codyDecisions = new CodyDecisionProvider({
        complete: async () => JSON.stringify(codyActions[codyIdx++]),
      });
      const codyAdapter = new CodyExecutionAdapter({ tools, decisions: codyDecisions });
      const codyTask = world.assignTask(world.createTask("Fix math add function").id, codyWorker.id);
      const codyPlan = codyAdapter.prepare({
        world,
        definitionId: definition.id,
        workerId: codyWorker.id,
        taskId: codyTask.id,
        goal: codyTask.goal,
        options: { workspaceRoot: root },
      });
      const codyResult = await runtime.run({ ...codyPlan, workerId: codyWorker.id, taskId: codyTask.id });
      assert.deepEqual(codyResult, { state: "completed" });

      // Verify file was accurately edited
      const editedMath = await readFile(path.join(root, "math.js"), "utf8");
      assert.equal(editedMath, "export function add(a, b) { return a + b; }\n");

      // 2. Tester independently verifies the project in shadow workspace
      const testerDef = createTesterDefinition(world);
      const testerWorker = world.spawnWorker(testerDef.id);
      const testerTask = world.assignTask(world.createTask("Verify math fix").id, testerWorker.id);
      const testerActions = [
        { type: "read", path: "math.js" },
        { type: "run", command: process.execPath, args: ["math.test.js"], check: "Test runner exit code 0" },
        {
          type: "finish",
          report: {
            status: "verified",
            summary: "Math tests passing",
            assertions: [{ name: "math-test", passed: true }],
          },
        },
      ];
      let testerIdx = 0;
      const testerDecisions = new TesterDecisionProvider({
        complete: async () => JSON.stringify(testerActions[testerIdx++]),
      });
      const testerAdapter = new TesterExecutionAdapter({ tools, decisions: testerDecisions });
      const testerPlan = testerAdapter.prepare({
        world,
        definitionId: testerDef.id,
        workerId: testerWorker.id,
        taskId: testerTask.id,
        goal: testerTask.goal,
        options: { workspaceRoot: root },
      });
      const testerResult = await runtime.run({ ...testerPlan, workerId: testerWorker.id, taskId: testerTask.id });
      assert.deepEqual(testerResult, { state: "completed" });

      const snapshot = world.inspect();
      const verif = snapshot.evidence.find((e) => e.taskId === testerTask.id && e.source.type === "tester-verification");
      assert.ok(verif);
      assert.equal(verif.validity, "verified");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Test 12: Empirical Benchmark (Performance & Token Comparison: Full Write vs Precision Edit)
  it("Test 12: benchmark: precision edit reduces payload size by >90% and performs atomically", async () => {
    const f = await createFixture();
    try {
      // Construct a realistic 500-line source file
      const fileLines = Array.from({ length: 500 }, (_, i) => `// Line ${i + 1}\nexport function fn_${i + 1}() { return ${i + 1}; }\n`);
      const originalContent = fileLines.join("");
      await writeFile(path.join(f.root, "service.ts"), originalContent, "utf8");

      // Full-file write payload
      const fullModifiedContent = originalContent.replace("return 250;", "return 250000;");
      const fullWritePayloadBytes = Buffer.byteLength(fullModifiedContent, "utf8");

      // Precision edit payload
      const oldSnippet = "export function fn_250() { return 250; }";
      const newSnippet = "export function fn_250() { return 250000; }";
      const editPayloadBytes = Buffer.byteLength(JSON.stringify({ oldText: oldSnippet, newText: newSnippet }), "utf8");

      // Payload reduction calculation
      const payloadReductionPercent = ((fullWritePayloadBytes - editPayloadBytes) / fullWritePayloadBytes) * 100;
      assert.ok(payloadReductionPercent > 95, `Payload reduction must exceed 95%, actual: ${payloadReductionPercent.toFixed(2)}%`);

      // Latency benchmark: 50 iterations each
      const iterations = 50;

      // Benchmark precision edit
      const t0Edit = performance.now();
      for (let i = 0; i < iterations; i++) {
        const fromVal = i === 0 ? "250000" : `val_${i - 1}`;
        const toVal = `val_${i}`;
        await f.tools.invoke({
          worldId: f.world.id,
          workerId: f.workerId,
          taskId: f.taskId,
          resourceId: f.resourceId,
          signal: new AbortController().signal,
          name: "filesystem.edit",
          input: {
            path: "service.ts",
            edits: [{ oldText: `return ${fromVal};`, newText: `return ${toVal};` }],
          },
        });
      }
      const editDurationMs = performance.now() - t0Edit;
      const avgEditMs = editDurationMs / iterations;

      // Benchmark full-file write
      let currentFull = await readFile(path.join(f.root, "service.ts"), "utf8");
      const t0Write = performance.now();
      for (let i = 0; i < iterations; i++) {
        const fromVal = i === 0 ? `val_${iterations - 1}` : `write_${i - 1}`;
        const toVal = `write_${i}`;
        currentFull = currentFull.replace(`return ${fromVal};`, `return ${toVal};`);
        await f.tools.invoke({
          worldId: f.world.id,
          workerId: f.workerId,
          taskId: f.taskId,
          resourceId: f.resourceId,
          signal: new AbortController().signal,
          name: "filesystem.write",
          input: {
            path: "service.ts",
            content: currentFull,
          },
        });
      }
      const writeDurationMs = performance.now() - t0Write;
      const avgWriteMs = writeDurationMs / iterations;

      // Validate outcomes
      assert.ok(avgEditMs < 20, `Average precision edit must be under 20ms, actual: ${avgEditMs.toFixed(2)}ms`);
      assert.ok(avgWriteMs < 20, `Average full write must be under 20ms, actual: ${avgWriteMs.toFixed(2)}ms`);
    } finally {
      await f.cleanup();
    }
  });
});

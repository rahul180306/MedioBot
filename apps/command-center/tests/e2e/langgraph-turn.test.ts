import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { startCommandCenter } from "../../src/server.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository, SqliteCredentialStore } from "../../src/storage/providerRepository.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";
import { createComposition } from "../../src/composition.ts";
import { DurableTaskEngine } from "@mediobot-v2/runtime";
import { OpenAICompatibleStructuredClient } from "@mediobot-v2/models";

test("browser uses the production LangGraph turn path and displays real Cody tool activity", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-langgraph-browser-"));
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(root, "mediobot.sqlite");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "notes.txt"), "The project uses a local-first workflow.\n");
  const database = new LocalDatabase(databasePath);
  const providers = new ProviderRepository(database.raw);
  providers.save({ id: "ui-fixture-provider", providerType: "dahl", displayName: "Deterministic Dahl protocol fixture",
    connected: true, enabled: true, baseUrl: "https://inference.dahl.global/v1", models: [{ id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7",
      enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }] }, "controlled-fixture-key");
  assert.equal(providers.get("ui-fixture-provider")?.connected, true);

  let codyCalls = 0;
  let synthesisSawToolEvidence = false;
  let synthesisSawCodyFinding = false;
  let codyDefinitionId = "";
  const decisionContracts: string[] = [];
  const nativeRequestModes: string[] = [];
  const resolvedModelIds: string[] = [];
  let protocolFixtureError: string | undefined;
  const resolver = new ModelResolver(providers, { createClient: clientOptions => {
    resolvedModelIds.push(clientOptions.modelId);
    assert.equal(clientOptions.modelId, "MiniMaxAI/MiniMax-M2.7", "every production-path inference must use the thread's exact selected model");
    assert.deepEqual(clientOptions.protocolCapabilities?.verifiedModes, ["native-tool"],
      "the exact documented provider route should select native tool-call proposals despite a generic tools=false catalog field");
    const decide = async ({ system, input }: { system: string; input: string }) => {
    if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
    const data = JSON.parse(input) as Record<string, any>;
    const intents = Array.isArray(data.availableIntents) ? data.availableIntents as string[] : [];
    if (Object.hasOwn(data, "recentToolHistory") && Object.hasOwn(data, "goal")) {
      codyCalls++;
      const history = data.recentToolHistory as Array<{ action: string; result: string }>;
      const read = history.find(entry => entry.action.startsWith("filesystem.read notes.txt"));
      if (!read) return JSON.stringify({ type: "read", path: "notes.txt" });
      return JSON.stringify({ type: "finish", summary: `Read notes.txt: ${read.result}` });
    }
    if (intents.includes("delegate")) {
      const cody = data.availableMediobots.find((item: { role: string; definitionId: string }) => item.role === "coding"
        && data.assignableDefinitionIds.includes(item.definitionId));
      assert.ok(cody, "the production Maestro context must expose assignable Cody");
      codyDefinitionId = cody.definitionId;
      return JSON.stringify({ type: "delegate", definitionId: cody.definitionId,
        objective: "Read notes.txt and report its contents.", relevantContextRefs: [], constraints: ["Read only; do not modify files."],
        expectedOutcome: "A report grounded in the file contents.", evidenceExpectations: ["Observed filesystem.read result"],
        requiredCapabilities: ["filesystem.read"] });
    }
    const intelligence = Array.isArray(data.projectIntelligence) ? data.projectIntelligence as Array<{ name: string; value: string }> : [];
    synthesisSawCodyFinding = intelligence.some(record => record.name === "specialist-result"
      && record.value.includes("The project uses a local-first workflow."));
    const evidence = Array.isArray(data.relevantEvidence) ? data.relevantEvidence as Array<{ id: string; source?: { type?: string }; content: string }> : [];
    const toolEvidence = evidence.filter(item => item.source?.type === "coding-tool" && item.content.includes("filesystem.read succeeded"));
    synthesisSawToolEvidence = toolEvidence.length > 0;
    return JSON.stringify({ type: "respond", message: toolEvidence.length && synthesisSawCodyFinding
      ? "Cody inspected notes.txt. It says the project uses a local-first workflow."
      : "Cody did not return readable file evidence.",
      basis: toolEvidence.length && synthesisSawCodyFinding ? "project-evidence" : "cannot-verify",
      evidenceRefs: toolEvidence.length && synthesisSawCodyFinding ? toolEvidence.map(item => item.id) : [] });
    };
    const transport = new OpenAICompatibleStructuredClient({ ...clientOptions, fetch: async (_url, init) => {
      try {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }>;
        tools?: Array<{ type: string; function: { name: string } }>; tool_choice?: unknown };
      if (request.tools) {
        const toolName = request.tools[0]?.function.name ?? "missing-tool-name";
        nativeRequestModes.push(toolName);
        assert.deepEqual(request.tool_choice, { type: "function", function: { name: toolName } });
      }
      const system = String(request.messages.find(message => message.role === "system")?.content ?? "");
      const userContent = request.messages.find(message => message.role === "user")?.content;
      const input = typeof userContent === "string" ? userContent : Array.isArray(userContent)
        ? userContent.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object"
          && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"))
          .map(part => part.text).join("\n") : "";
      const decision = await decide({ system, input });
      return request.tools
        ? Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
          { id: `call-${nativeRequestModes.length}`, type: "function", function: { name: request.tools[0]!.function.name, arguments: decision } },
        ] } }] })
        : Response.json({ choices: [{ message: { content: decision } }] });
      } catch (error) {
        protocolFixtureError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw error;
      }
    } });
    return {
      complete: request => transport.complete(request),
      completeCompatible: request => {
        decisionContracts.push(request.outputContract.name);
        return transport.completeCompatible!(request);
      },
      usage: () => transport.usage(),
      metrics: () => transport.metrics(),
    };
  } });
  const app = await startCommandCenter({ databasePath, providerRepository: providers,
    credentialStoreFactory: raw => new SqliteCredentialStore(raw), modelResolver: resolver,
    workspaceRoot, vite: true, listen: true, port: 0 });
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = app.url!;
  const metadata = await fetch(`${baseUrl}/api/threads`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread: { id: "langgraph-ui-thread", title: "LangGraph UI acceptance",
      modelSelection: { providerConnectionId: "ui-fixture-provider", modelId: "MiniMaxAI/MiniMax-M2.7" }, model: "MiniMax M2.7" } }) });
  assert.equal(metadata.status, 200);

  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  t.after(async () => { await page.close(); });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Do anything").waitFor();
  await page.locator('button[title="Threads & History"]').click();
  await page.getByText("LangGraph UI acceptance", { exact: true }).click();

  const prompt = "Ask Cody to read notes.txt and state the value it contains. Do not edit files.";
  const turnResponse = page.waitForResponse(response => response.url().includes("/api/turns")
    && response.request().method() === "POST");
  await page.getByPlaceholder("Do anything").fill(prompt);
  await page.getByPlaceholder("Do anything").press("Enter");
  const accepted = await turnResponse;
  const submitted = await accepted.json() as { taskId?: string; direct?: boolean; error?: string; message?: string };
  assert.equal(accepted.status(), 202, JSON.stringify({ submitted, request: accepted.request().postDataJSON() }));
  assert.ok(submitted.taskId);

  try {
    await page.getByText("Cody inspected notes.txt. It says the project uses a local-first workflow.", { exact: true }).waitFor({ timeout: 15_000 });
  } catch (error) {
    const saved = await (await fetch(`${baseUrl}/api/threads/langgraph-ui-thread`)).json() as { thread: { turns: Array<{ items: Array<{ type: string; text?: string }> }> } };
    const messages = saved.thread.turns.flatMap(turn => turn.items.filter(item => item.type === "agent_message").map(item => item.text));
    throw new Error(`Final synthesis was not shown; controlled fixture error=${protocolFixtureError ?? "none"}; codyCalls=${codyCalls}; `
      + `evidence=${synthesisSawToolEvidence}/${synthesisSawCodyFinding}; messages=${JSON.stringify(messages)}; ${String(error)}`);
  }
  assert.ok(codyCalls >= 2, "Cody must make a tool decision, consume the result, and finish the assignment");
  assert.equal(synthesisSawToolEvidence, true, "Maestro synthesis must receive Cody's actual tool evidence");
  assert.equal(synthesisSawCodyFinding, true, "Maestro synthesis must receive Cody's report with the file's retrieved value");
  assert.ok(decisionContracts.filter(name => name === "mediobot_decision").length >= 4,
    "Maestro and Cody decisions must use their existing contract through the production compatibility seam");
  assert.ok(nativeRequestModes.filter(name => name === "mediobot_decision").length >= 4,
    "production Maestro, Cody, and synthesis requests must send the allowlisted native decision tool");
  assert.ok(nativeRequestModes.includes("project_evidence_requirement"),
    "the final evidence classifier must use its own bounded native output contract");
  const taskResponse = await fetch(`${baseUrl}/api/tasks/${submitted.taskId}`);
  assert.equal(taskResponse.status, 200);
  const task = await taskResponse.json() as { task: { state: string; evidence?: Array<{ source?: { type?: string }; content: string }>;
    delegations?: Array<{ assignedMediobotId?: string; childTaskId?: string | null }> } };
  assert.equal(task.task.state, "completed");
  assert.ok(task.task.evidence?.some(item => item.source?.type === "coding-tool" && item.content.includes("filesystem.read succeeded")));
  const codyChild = task.task.delegations?.find((delegation: { assignedMediobotId?: string; childTaskId?: string | null }) =>
    delegation.assignedMediobotId === codyDefinitionId && typeof delegation.childTaskId === "string");
  assert.ok(codyChild?.childTaskId, "the actual Cody execution must retain a durable child identity");
  assert.deepEqual(await app.composition.durableTaskEngine!.getTaskModelSelection(codyChild.childTaskId),
    { providerConnectionId: "ui-fixture-provider", modelId: "MiniMaxAI/MiniMax-M2.7" },
    "Cody's persisted execution selection must match the provider/model selected on the thread");
  assert.ok(resolvedModelIds.length >= 3, "Maestro, Cody, and synthesis should resolve through ModelResolver");
  const threadResponse = await fetch(`${baseUrl}/api/threads/langgraph-ui-thread`);
  const savedThread = await threadResponse.json() as { thread: { turns: Array<{ items: Array<{ type: string; tool?: { toolName?: string } }> }> } };
  assert.ok(savedThread.thread.turns.some(turn => turn.items.some(item => item.type === "tool_execution" && item.tool?.toolName === "filesystem.read")),
    "the persisted transcript must contain Cody's real filesystem tool activity");
  const activitySummaries = await page.locator("details summary").allTextContents();
  t.diagnostic(`Visible activity summaries: ${JSON.stringify(activitySummaries)}`);
  assert.ok(activitySummaries.some(summary => /Cody/i.test(summary)), "the transcript should visibly attribute activity to Cody");
});

test("browser keeps Cody's real terminal failure, recovery, and verified artifact synchronized across workspaces", { timeout: 45_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-prime-browser-"));
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(root, "mediobot.sqlite");
  await mkdir(workspaceRoot, { recursive: true });
  const database = new LocalDatabase(databasePath);
  const providers = new ProviderRepository(database.raw);
  providers.save({ id: "prime-ui-provider", providerType: "custom", displayName: "Deterministic prime fixture",
    connected: true, enabled: true, baseUrl: "http://unused.invalid", models: [{ id: "prime-ui-model", name: "Fixture model",
      enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }] });

  const source = ["from math import isqrt", "", "def is_prime(value):", "    if not isinstance(value, int) or isinstance(value, bool):",
    "        raise TypeError('value must be an integer')", "    if value < 2:", "        return False", "    return all(value % divisor for divisor in range(2, isqrt(value) + 1))", ""].join("\n");
  const missingInterpreter = `mediobot-missing-python-${crypto.randomUUID()}`;
  const python = process.env.PYTHON ?? (process.platform === "win32" ? "py" : "python3");
  const pythonPrefix = process.env.PYTHON ? [] : process.platform === "win32" ? ["-3"] : [];
  const check = "from prime_check import is_prime; assert not is_prime(-3); assert not is_prime(0); assert not is_prime(1); assert is_prime(2); assert is_prime(104729); assert not is_prime(104728)";
  let maestroCalls = 0;
  let codyStep = 0;
  let synthesisVerified = false;
  let codyDefinitionId = "";
  const actions = [
    { type: "list", path: ".", commentary: "I’m checking the project files before I create the helper." },
    { type: "read", path: "prime_check.py", commentary: "I’m confirming whether the requested file already exists." },
    { type: "write", path: "prime_check.py", content: source, commentary: "The target is new; I’m adding the prime check with its edge cases." },
    { type: "run", command: missingInterpreter, args: ["--token", "synthetic-token-secret", "-H", "Authorization: Bearer synthetic-header-secret", "-c", check], cwd: ".",
      verification: "Check negative numbers, 0, 1, 2, and a large prime and composite", commentary: "I’m running the requested edge-case verification." },
    { type: "run", command: python, args: [...pythonPrefix, "-c", check], cwd: ".",
      verification: "Check negative numbers, 0, 1, 2, and a large prime and composite", commentary: "The interpreter could not start (ENOENT); I’m using the available Python executable for the same check." },
    { type: "finish", summary: `Created prime_check.py. The first interpreter could not start (ENOENT); ${python} ran the edge-case check and exited 0. This was Cody's self-check, not an independent Tester result.`,
      commentary: "The fallback check passed; I’m reporting the artifact and both command outcomes." },
  ];
  const resolver = new ModelResolver(providers, { createClient: options => {
    assert.equal(options.modelId, "prime-ui-model");
    return { complete: async ({ system, input }: { system: string; input: string }) => {
      if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
      const data = JSON.parse(input) as Record<string, any>;
      if (Array.isArray(data.availableIntents) && (data.availableIntents.includes("delegate") || data.availableIntents.includes("delegate_text"))
        && !Object.hasOwn(data, "recentToolHistory")) {
        maestroCalls += 1;
        const cody = data.availableMediobots.find((agent: { role: string; definitionId: string }) => agent.role === "coding"
          && data.assignableDefinitionIds.includes(agent.definitionId));
        assert.ok(cody, "Maestro must see an authorized Cody assignment");
        codyDefinitionId = cody.definitionId;
        return JSON.stringify({ type: "delegate", definitionId: cody.definitionId,
          objective: "Create prime_check.py with is_prime and verify negative, boundary, prime, and composite inputs.",
          relevantContextRefs: [], constraints: ["Create the file only after confirming it does not exist."],
          expectedOutcome: "A correct Python prime predicate and an exit-0 edge-case check.",
          evidenceExpectations: ["Observed file creation and successful terminal verification"],
          requiredCapabilities: ["filesystem.list", "filesystem.read", "filesystem.write", "terminal.execute"] });
      }
      if (Object.hasOwn(data, "recentToolHistory") && Object.hasOwn(data, "goal")) {
        const result = actions[codyStep++];
        assert.ok(result, "Cody must stop after the bounded create, failed launch, recovery, and verification sequence");
        return JSON.stringify(result);
      }
      const evidence = Array.isArray(data.relevantEvidence) ? data.relevantEvidence as Array<{ id?: string; validity?: string; source?: { type?: string }; content?: string }> : [];
      const observed = evidence.filter(item => item.id && item.validity === "observed"
        && (item.source?.type === "coding-tool" || item.source?.type === "coding-verification"));
      synthesisVerified = observed.some(item => item.content?.includes("terminal.execute completed; exitCode=0"))
        && observed.some(item => item.content?.includes("filesystem.write succeeded"));
      return JSON.stringify({ type: "respond", message: synthesisVerified
        ? `Cody created prime_check.py and verified negative values, 0, 1, 2, and a large prime/composite pair. Its first command failed to launch with ENOENT; ${python} then exited 0. This was Cody's self-check, not an independent Tester result.`
        : "Cody's result lacks the required observed file and verification evidence; completion is not verified.",
        basis: synthesisVerified ? "project-evidence" : "cannot-verify", evidenceRefs: synthesisVerified ? observed.map(item => item.id) : [] });
    } };
  } });
  const durableEngine = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
  const composition = createComposition({ modelResolver: resolver, durableTaskEngine: durableEngine, workspaceRoot,
    checkpointDatabasePath: databasePath, checkpointDatabase: database.raw, headless: true });
  const app = await startCommandCenter({ databasePath, providerRepository: providers, modelResolver: resolver,
    composition, workspaceRoot, vite: true, listen: true, port: 0 });
  await app.workspaceManager.openWorkspace(workspaceRoot);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const threadId = "prime-browser-thread";
  const metadata = await fetch(`${app.url}/api/threads`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread: { id: threadId, title: "Prime helper recovery", modelSelection: { providerConnectionId: "prime-ui-provider", modelId: "prime-ui-model" }, model: "Fixture model" } }) });
  assert.equal(metadata.status, 200);
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  t.after(async () => { await page.close(); });
  await page.goto(app.url!, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Do anything").waitFor();
  await page.locator('button[title="Threads & History"]').click();
  await page.getByText("Prime helper recovery", { exact: true }).click();
  const prompt = "Create a Python function that checks whether a number is prime. Ask Cody to implement it, verify the result, and explain what was completed.";
  const submittedResponse = page.waitForResponse(response => response.url().includes("/api/turns") && response.request().method() === "POST");
  await page.getByPlaceholder("Do anything").fill(prompt);
  await page.getByPlaceholder("Do anything").press("Enter");
  const accepted = await submittedResponse;
  assert.equal(accepted.status(), 202);
  const { taskId } = await accepted.json() as { taskId: string };
  let state = "";
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !["completed", "failed", "cancelled"].includes(state)) {
    const taskView = await fetch(`${app.url}/api/tasks/${taskId}`).then(response => response.json()) as { task: { state: string } };
    state = taskView.task.state;
    if (!["completed", "failed", "cancelled"].includes(state)) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(state, "completed");
  assert.equal(maestroCalls, 1);
  assert.ok(synthesisVerified, "Maestro synthesis must receive the observed file and exit-0 verification evidence");
  assert.equal(codyStep, actions.length, "Cody must make one bounded model decision for each observed operation and completion");
  assert.equal(await readFile(path.join(workspaceRoot, "prime_check.py"), "utf8"), source);
  const thread = await fetch(`${app.url}/api/threads/${threadId}`).then(response => response.json()) as { thread: { turns: Array<{ items: Array<{ id: string; type: string; text?: string; actor?: { name?: string }; tool?: { toolName?: string; errorCode?: string; command?: string; workingDirectory?: string; exitCode?: number | null; recoveryReason?: string } }> }> } };
  const items = thread.thread.turns.at(-1)?.items ?? [];
  const final = items.filter(item => item.type === "agent_message").at(-1)?.text ?? "";
  assert.match(final, /ENOENT/);
  assert.match(final, /exit(?:ed)?(?: code)? 0|successfully/i);
  assert.match(final, /not an independent Tester result/);
  assert.equal(items.some(item => /^(?:Cody|Worker) progress\.?$/i.test(item.text ?? "")), false);
  const failed = items.find(item => item.type === "tool_execution" && item.tool?.toolName === "terminal.execute" && item.tool.errorCode === "ENOENT");
  const verified = items.find(item => item.type === "tool_execution" && item.tool?.toolName === "terminal.execute" && item.tool.exitCode === 0);
  assert.equal(failed?.actor?.name, "Cody");
  assert.equal(failed?.tool?.workingDirectory, ".");
  assert.match(failed?.tool?.command ?? "", /\[REDACTED\]/);
  assert.match(failed?.tool?.recoveryReason ?? "", /ENOENT/);
  assert.equal(failed?.tool?.exitCode, null);
  assert.equal(JSON.stringify(failed).includes("synthetic-token-secret"), false);
  assert.equal(JSON.stringify(failed).includes("synthetic-header-secret"), false);
  assert.ok(verified, "the recovery command must be a distinct successful terminal event");

  const tasks = await fetch(`${app.url}/api/tasks`).then(response => response.json()) as { tasks: Array<{ id: string;
    assignedMediobot?: { id?: string }; events?: Array<{ id?: string; toolInvocationId?: string; type?: string; toolName?: string; errorCode?: string; command?: string;
      workingDirectory?: string; recoveryReason?: string; exitCode?: number | null }> }> };
  const codyTask = tasks.tasks.find(task => task.assignedMediobot?.id === codyDefinitionId
    && task.events?.some(event => event.type === "tool.failed" && event.toolName === "terminal.execute" && event.errorCode === "ENOENT"));
  const specialistFailure = codyTask?.events?.find(event => event.type === "tool.failed" && event.toolName === "terminal.execute" && event.errorCode === "ENOENT");
  assert.equal(specialistFailure?.toolInvocationId, failed?.id,
    "the individual workspace's durable failure event must map to the same Main Chat tool invocation");
  assert.equal(specialistFailure?.command, failed?.tool?.command);
  assert.equal(specialistFailure?.workingDirectory, failed?.tool?.workingDirectory);
  assert.equal(specialistFailure?.recoveryReason, failed?.tool?.recoveryReason);

  await page.getByTitle("Maestro Agents").click();
  await page.getByTestId("mediobot-select-cody").click();
  const codyWorkspace = page.getByTestId("mediobot-task-history-cody");
  await codyWorkspace.waitFor({ timeout: 5_000 });
  const codyRow = codyWorkspace.getByTestId(`mediobot-assignment-${codyTask!.id}`);
  await codyRow.waitFor({ timeout: 5_000 });
  const workspaceText = await codyRow.textContent() ?? "";
  assert.match(workspaceText, /ENOENT/);
  assert.match(workspaceText, /\[REDACTED\]/);
  assert.match(workspaceText, /cwd=\./);
  assert.match(workspaceText, /Launch failed \(ENOENT\)/);
  assert.match(workspaceText, /python/i);
  assert.match(workspaceText, /completed/);
  assert.equal(workspaceText.includes("synthetic-token-secret"), false);
  assert.equal(workspaceText.includes("synthetic-header-secret"), false);
  const summaries = await page.locator("details summary").allTextContents();
  t.diagnostic(JSON.stringify({ controlled: true, taskId, codyDefinitionId, codyDecisions: codyStep,
    tools: items.filter(item => item.type === "tool_execution").map(item => ({ specialist: item.actor?.name, tool: item.tool?.toolName,
      errorCode: item.tool?.errorCode, exitCode: item.tool?.exitCode })), mainActivity: summaries, final }));
});

test("browser displays authorized live Doc assistance requested by Cody while Research runs independently", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-langgraph-dynamic-browser-"));
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(root, "mediobot.sqlite");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "notes.txt"), "Use independent header and inactivity timeouts.\n");
  const database = new LocalDatabase(databasePath);
  const providers = new ProviderRepository(database.raw);
  providers.save({ id: "dynamic-ui-provider", providerType: "custom", displayName: "Deterministic dynamic fixture",
    connected: true, enabled: true, baseUrl: "http://unused.invalid", models: [{ id: "dynamic-ui-model", name: "Fixture model",
      enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }] });

  const resolvedModels: string[] = [];
  let codyCalls = 0;
  let codyConsumedDoc = false;
  let synthesisSawReports = false;
  let synthesisSawDocEvidence = false;
  const compatibilityContracts: string[] = [];
  let releaseCodyFinalDecision!: () => void;
  let signalCodyFinalDecision!: () => void;
  const codyFinalDecisionGate = new Promise<void>(resolve => { releaseCodyFinalDecision = resolve; });
  const codyFinalDecisionStarted = new Promise<void>(resolve => { signalCodyFinalDecision = resolve; });
  let docDefinitionId = "";
  let codyDefinitionId = "";
  let synthesisIntelligence: Array<{ name: string; value: string }> = [];
  const resolver = new ModelResolver(providers, { createClient: options => {
    assert.equal(options.modelId, "dynamic-ui-model", "every model operation must use the thread's explicit provider/model selection");
    resolvedModels.push(options.modelId);
    const decide = async ({ system, input }: { system: string; input: string }) => {
      if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
      const data = JSON.parse(input) as Record<string, any>;
      if (Object.hasOwn(data, "recentToolHistory") && Object.hasOwn(data, "goal")) {
        codyCalls++;
        const history = data.recentToolHistory as Array<{ action: string; result: string }>;
        if (typeof data.goal === "string" && data.goal.includes("DOC_REPORT")) codyConsumedDoc = true;
        if (codyCalls === 1) {
          assert.ok(docDefinitionId);
          return JSON.stringify({ type: "request_support", definitionId: docDefinitionId, capabilityNeeded: "web.search",
            query: "Official Node.js HTTP timeout guidance", contextSnippet: "Find separate response header and inactivity timeout semantics." });
        }
        if (!history.some(entry => entry.action.startsWith("filesystem.read"))) return JSON.stringify({ type: "read", path: "notes.txt" });
        signalCodyFinalDecision();
        await codyFinalDecisionGate;
        return JSON.stringify({ type: "finish", summary: codyConsumedDoc
          ? "Cody read notes.txt and used Doc's official DOC_REPORT on distinct timeout boundaries."
          : "Cody read notes.txt; Doc's assistance was unavailable." });
      }
      if (typeof data.webContent === "string" && data.assignment) {
        const isDoc = JSON.stringify(data.assignment).includes("Doc follows the official task request")
          || data.webContent.includes("DOC_PAGE");
        return JSON.stringify({ status: "completed", summary: isDoc
          ? "DOC_REPORT: Official Node.js guidance distinguishes response-header timeout from socket inactivity timeout."
          : "RESEARCH_REPORT: Independent source review confirms cancellation must stop pending request work.",
          evidence: isDoc ? ["https://nodejs.org/api/http.html"] : ["https://nodejs.org/api/globals.html"],
          blockers: [], unresolved: [] });
      }
      const intents = Array.isArray(data.availableIntents) ? data.availableIntents as string[] : [];
      if (intents.includes("delegate_text") || intents.includes("delegate")) {
        const mediobots = data.availableMediobots as Array<{ role: string; definitionId: string }>;
        const assignable = data.assignableDefinitionIds as string[];
        const cody = mediobots.find(item => item.role === "coding" && assignable.includes(item.definitionId));
        const research = mediobots.find(item => item.role === "research" && assignable.includes(item.definitionId));
        assert.ok(cody && research);
        codyDefinitionId = cody.definitionId;
        return JSON.stringify({ type: "delegate_text", independence: "Cody reads the workspace while Research independently reviews cancellation; Cody may request one authorized Doc follow-up.",
          assignments: [
            { assignmentId: "dynamic-cody", definitionId: cody.definitionId,
              objective: "Read notes.txt, request Doc's official guidance, and report the timeout distinction.",
              relevantContext: "The user needs an accurate Node.js timeout explanation.", relevantContextRefs: [], constraints: ["Read only."],
              expectedOutcome: "A concise answer grounded in the file and Doc's report.", evidenceExpectations: ["Observed filesystem read"],
              requiredCapabilities: ["filesystem.read"] },
            { assignmentId: "dynamic-research", definitionId: research.definitionId,
              objective: "Independently research Node.js request cancellation guidance.", relevantContext: "Use a relevant source and report a concise finding.",
              relevantContextRefs: [], constraints: [], expectedOutcome: "Independent cancellation finding.", evidenceExpectations: ["Relevant retrieved source"],
              requiredCapabilities: ["web.search", "web.crawl"] },
          ] });
      }
      const intelligence = Array.isArray(data.projectIntelligence) ? data.projectIntelligence as Array<{ name: string; value: string }> : [];
      synthesisIntelligence = intelligence;
      const codyReport = intelligence.some(item => item.name === "specialist-result" && item.value.includes("Cody read notes.txt") && item.value.includes("DOC_REPORT"));
      const researchReport = intelligence.some(item => item.name === "specialist-result" && item.value.includes("RESEARCH_PAGE"));
      synthesisSawDocEvidence = intelligence.some(item => item.name === "specialist-result" && item.value.includes("DOC_REPORT")
        && item.value.includes("https://nodejs.org/api/http.html"));
      synthesisSawReports = codyReport && researchReport && synthesisSawDocEvidence;
      return JSON.stringify({ type: "respond", message: synthesisSawReports
        ? "Cody used Doc's official timeout finding, read the project note, and Research independently confirmed the cancellation point."
        : "The specialist findings were incomplete; this result is not verified.",
        basis: "conversation", evidenceRefs: [] });
    };
    return {
      complete: request => decide(request),
      completeCompatible: async request => {
        compatibilityContracts.push(request.outputContract.name);
        return { kind: "structured" as const, value: JSON.parse(await decide(request)), protocol: "json-object" as const };
      },
    };
  } });

  const intervals: Array<{ query: string; start: number; end: number }> = [];
  let researchStarted!: () => void;
  const researchGate = new Promise<void>(resolve => { researchStarted = resolve; });
  const web = {
    isRunning: true,
    async search({ query }: { query: string }) {
      const research = /cancellation|independently/i.test(query);
      const start = performance.now();
      if (research) researchStarted(); else await researchGate;
      await new Promise(resolve => setTimeout(resolve, 35));
      intervals.push({ query, start, end: performance.now() });
      const url = research ? "https://nodejs.org/api/globals.html" : "https://nodejs.org/api/http.html";
      return { query, totalMatches: 1, items: [{ title: research ? "Node.js globals" : "Node.js HTTP", url,
        snippet: research ? "AbortSignal cancellation for request work." : "Response header and socket timeout behavior.", source: "controlled-fixture" }] };
    },
    async crawl({ url }: { url: string }) {
      return { url, finalUrl: url, title: "Node.js API", markdown: url.includes("http.html")
        ? "DOC_PAGE: Node.js HTTP request has distinct response timeout and socket inactivity timeout settings."
        : "RESEARCH_PAGE: AbortSignal can cancel asynchronous request work.", success: true, sanitized: true,
        promptInjectionFlags: [], provenance: { url, timestamp: Date.now(), contentHash: "controlled" } };
    },
    async shutdown() {},
  };
  const durableEngine = new DurableTaskEngine(new SqliteDurableTaskStore(database.raw));
  const composition = createComposition({ modelResolver: resolver, durableTaskEngine: durableEngine, workspaceRoot,
    crawl4aiRuntime: web as never, checkpointDatabasePath: databasePath, checkpointDatabase: database.raw, headless: true });
  docDefinitionId = composition.world.inspect().definitions.find(definition => definition.role === "doc")!.id;
  const app = await startCommandCenter({ databasePath, providerRepository: providers, modelResolver: resolver,
    composition, workspaceRoot, vite: true, listen: true, port: 0 });
  await app.workspaceManager.openWorkspace(workspaceRoot);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  t.after(() => { releaseCodyFinalDecision(); });

  const threadId = "dynamic-langgraph-ui-thread";
  const metadata = await fetch(`${app.url}/api/threads`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread: { id: threadId, title: "Dynamic assistance acceptance",
      modelSelection: { providerConnectionId: "dynamic-ui-provider", modelId: "dynamic-ui-model" }, model: "Fixture model" } }) });
  assert.equal(metadata.status, 200);
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  t.after(async () => { await page.close(); });
  await page.goto(app.url!, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Do anything").waitFor();
  await page.locator('button[title="Threads & History"]').click();
  await page.getByText("Dynamic assistance acceptance", { exact: true }).click();

  const submittedResponse = page.waitForResponse(response => response.url().includes("/api/turns") && response.request().method() === "POST");
  await page.getByPlaceholder("Do anything").fill("Explain the timeout guidance and cancellation behavior for this project.");
  await page.getByPlaceholder("Do anything").press("Enter");
  const accepted = await submittedResponse;
  assert.equal(accepted.status(), 202);
  const submitted = await accepted.json() as { taskId: string };
  await codyFinalDecisionStarted;
  const workspaceTasksResponse = await fetch(`${app.url}/api/tasks`);
  const workspaceTasksPayload = await workspaceTasksResponse.json() as { tasks?: Array<{ id: string; goal?: string; state?: string;
    assignedMediobot?: { id?: string; name?: string }; workspaceId?: string;
    events?: Array<{ id?: string; type: string; toolName?: string; toolInvocationId?: string }> }> };
  const codyWorkspaceTask = workspaceTasksPayload.tasks?.find(task => task.assignedMediobot?.id === codyDefinitionId
    && task.goal?.includes("DOC_REPORT") && task.events?.some(event => event.type === "tool.completed" && event.toolName === "filesystem.read"));
  assert.ok(codyWorkspaceTask, "the active specialist task snapshot must contain Cody's continuation and actual read evidence");
  assert.equal(codyWorkspaceTask.state, "running", "Cody's durable assignment should remain active while its final decision is pending");
  // The model fixture pauses after Cody has consumed the helper finding and
  // read the project file, so the UI can be checked against a live assignment.
  const mainActivitySummaries = await page.locator("details summary").allTextContents();
  assert.ok(mainActivitySummaries.some(summary => /Cody/i.test(summary)));
  assert.ok(mainActivitySummaries.some(summary => /Doc/i.test(summary)));
  assert.ok(mainActivitySummaries.some(summary => /Research/i.test(summary)));
  assert.equal(mainActivitySummaries.some(summary => /^(?:Cody|Doc|Research|Worker) progress\.?$/i.test(summary.trim())), false,
    "Main Chat activity must show observable work, not generic progress filler");
  await page.getByTitle("Maestro Agents").click();
  await page.getByTestId("mediobot-select-cody").click({ timeout: 5_000 });
  const liveCodyWorkspace = page.getByTestId("mediobot-task-history-cody");
  await liveCodyWorkspace.waitFor({ timeout: 5_000 });
  const liveCodyAssignment = liveCodyWorkspace.getByTestId(`mediobot-assignment-${codyWorkspaceTask.id}`);
  await liveCodyAssignment.waitFor({ timeout: 5_000 });
  await liveCodyAssignment.getByText(/DOC_REPORT/).waitFor({ timeout: 5_000 });
  assert.match(await liveCodyAssignment.textContent() ?? "", /filesystem\.read/,
    "Cody's individual workspace must show its real read activity before the task completes");
  const liveCodyStatus = page.getByTestId("mediobot-workspace-status-cody");
  assert.match(await liveCodyStatus.textContent() ?? "", /Working/,
    "Cody must remain visibly active while its final model decision is pending");
  releaseCodyFinalDecision();
  let taskState = "";
  const taskDeadline = Date.now() + 15_000;
  while (Date.now() < taskDeadline && taskState !== "completed" && taskState !== "failed" && taskState !== "cancelled") {
    const taskResponse = await fetch(`${app.url}/api/tasks/${submitted.taskId}`);
    const taskView = await taskResponse.json() as { task: { state: string } };
    taskState = taskView.task.state;
    if (!["completed", "failed", "cancelled"].includes(taskState)) await new Promise(resolve => setTimeout(resolve, 50));
  }
  const savedThreadResponse = await fetch(`${app.url}/api/threads/${threadId}`);
  const savedThread = await savedThreadResponse.json() as { thread: { turns: Array<{ id: string;
    items: Array<{ id: string; type: string; text?: string; tool?: { toolName?: string } }> }> } };
  const finalText = savedThread.thread.turns.at(-1)?.items
    .filter(item => item.type === "agent_message").at(-1)?.text ?? "";
  assert.equal(taskState, "completed", `task did not complete: ${finalText}`);
  await liveCodyAssignment.getByText("completed", { exact: true }).waitFor({ timeout: 5_000 });
  assert.equal(finalText, "Cody used Doc's official timeout finding, read the project note, and Research independently confirmed the cancellation point.",
    "the persisted Main Chat synthesis must accurately include the completed specialist findings");
  assert.equal(codyConsumedDoc, true, "Cody's next decision must consume the authorized Doc report");
  assert.equal(synthesisSawReports, true, "Maestro synthesis must receive Cody's outcome, Doc's source-backed finding, and independent Research finding");
  t.diagnostic(`Compatibility contracts used: ${JSON.stringify(compatibilityContracts)}`);
  assert.ok(compatibilityContracts.includes("mediobot_worker_report"), "Doc and Research reports must use their bounded contract through the runtime seam");
  assert.ok(compatibilityContracts.filter(name => name === "mediobot_decision").length >= 4,
    "Maestro and Cody decisions during collaboration must use the existing stable contract");
  assert.ok(intervals.length === 2, "both Doc and Research must invoke web.search");
  assert.ok(Math.min(...intervals.map(item => item.end)) > Math.max(...intervals.map(item => item.start)),
    "dynamic Doc search and independent Research search must overlap");

  const taskResponse = await fetch(`${app.url}/api/tasks/${submitted.taskId}`);
  const taskView = await taskResponse.json() as { task: { state: string; evidence?: Array<{ source?: { type?: string }; content: string }> } };
  assert.equal(taskView.task.state, "completed");
  const events = await app.composition.getTaskEvents!(submitted.taskId as never);
  for (const [toolName, specialistId] of [["filesystem.read", "cody"], ["web.search", "doc"], ["web.crawl", "doc"], ["web.search", "research"], ["web.crawl", "research"]]) {
    assert.ok(events.some(event => event.type === "tool.completed" && event.toolName === toolName && event.workerDefinitionId === specialistId),
      `${specialistId} must have an attributed ${toolName} event`);
  }
  const delegations = await durableEngine.getDelegations(submitted.taskId as never);
  assert.ok(delegations.some(entry => entry.assignedMediobotId === "doc"), "Doc must have a durable child identity for runtime assistance");
  assert.ok(delegations.some(entry => entry.assignedMediobotId === "research"), "Research must retain its independent durable assignment");
  assert.ok(delegations.some(entry => entry.assignedMediobotId === "cody"), "Cody must retain its durable assignment");
  const nestedOutcomes = database.raw.prepare(`SELECT payload_json FROM langgraph_task_outcomes
    WHERE workflow_name = 'maestro-specialist-groups:dynamic'`).all() as Array<{ payload_json: string }>;
  assert.ok(nestedOutcomes.some(row => row.payload_json.includes("DOC_REPORT")), "the helper report must be checkpointed in its nested LangGraph run");
  const activitySummaries = mainActivitySummaries;

  // The specialist workspace is another projection of this same durable run,
  // not a second chat. Confirm the assignment and its observed tool activity
  // remain available after switching away from Main Chat.
  const codyAssignment = delegations.find(entry => entry.assignedMediobotId === codyDefinitionId
    && entry.objective.includes("Read notes.txt, request Doc's official guidance"));
  assert.ok(codyAssignment?.childTaskId, "Cody's delegated assignment must retain its durable execution identity");
  assert.ok(codyWorkspaceTask, "the individual workspace task snapshot must retain Cody's continuation with the Doc report and read evidence");
  const childReadEvent = codyWorkspaceTask.events?.find(event => event.type === "tool.completed" && event.toolName === "filesystem.read");
  const parentReadEvent = events.find(event => event.type === "tool.completed" && event.toolName === "filesystem.read"
    && event.workerDefinitionId === codyDefinitionId);
  assert.ok(childReadEvent?.id && parentReadEvent?.id && childReadEvent.toolInvocationId && parentReadEvent.toolInvocationId,
    "both workspace projections must include durable event and tool-invocation identities");
  assert.equal(childReadEvent.id, parentReadEvent.id, "Maestro and Cody task views must replay the same durable product event");
  assert.equal(childReadEvent.toolInvocationId, parentReadEvent.toolInvocationId,
    "the same underlying tool invocation must be correlated across task projections");
  const mainTranscriptRead = savedThread.thread.turns.flatMap(turn => turn.items)
    .find(item => item.id === parentReadEvent.toolInvocationId && item.type === "tool_execution" && item.tool?.toolName === "filesystem.read");
  assert.ok(mainTranscriptRead, "the persisted Main Chat transcript must retain this same tool-invocation identity");
  const codyWorkspaceAssignment = liveCodyAssignment;
  const codyContextText = await codyWorkspaceAssignment.textContent();
  assert.match(codyContextText ?? "", /DOC_REPORT/, "Cody's workspace must retain the helper's attributed finding");
  assert.match(codyContextText ?? "", /nodejs\.org\/api\/http\.html/, "Cody's workspace must retain the helper's evidence reference");
  const codyActivity = codyWorkspaceAssignment.locator("details");
  await codyActivity.locator("summary").click();
  await codyActivity.getByText("filesystem.read · completed").waitFor({ timeout: 5_000 });
  assert.doesNotMatch(await codyActivity.textContent() ?? "", /^(?:Cody|Doc|Worker) progress\.?$/im,
    "the individual Mediobot workspace must omit generic progress filler");
  t.diagnostic(JSON.stringify({ controlled: true, taskId: submitted.taskId, model: "dynamic-ui-model", codyCalls,
    codyConsumedDoc, synthesisSawReports, searchOverlapMs: Math.min(...intervals.map(item => item.end)) - Math.max(...intervals.map(item => item.start)),
    codyWorkspaceTaskId: codyWorkspaceTask.id, synchronizedFilesystemEventId: parentReadEvent.id,
    attributedToolEvents: events.filter(event => event.type === "tool.completed").map(event => ({ tool: event.toolName, specialist: event.workerDefinitionId })),
    durableAssignments: delegations.map(item => ({ specialist: item.assignedMediobotId, childTaskId: item.childTaskId, objective: item.objective })),
    visibleActivity: activitySummaries }));
});

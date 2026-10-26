import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startCommandCenter } from "../../src/server.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository, SqliteCredentialStore } from "../../src/storage/providerRepository.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { AnthropicMessagesStructuredClient, OpenAICompatibleStructuredClient } from "@mediobot-v2/models";

test("native action proposals stay behind production tool approval", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-native-approval-"));
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(root, "mediobot.sqlite");
  await mkdir(workspaceRoot, { recursive: true });
  const database = new LocalDatabase(databasePath);
  const providers = new ProviderRepository(database.raw);
  providers.save({ id: "native-approval-provider", providerType: "dahl", displayName: "Controlled protocol fixture",
    connected: true, enabled: true, baseUrl: "https://inference.dahl.global/v1", models: [{ id: "MiniMaxAI/MiniMax-M2.7",
      name: "MiniMax M2.7", enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }] },
  "controlled-fixture-key");
  let maestroDelegated = false;
  let codyProposedWrite = false;
  const nativeTools: string[] = [];
  const resolver = new ModelResolver(providers, { createClient: options => {
    assert.deepEqual(options.protocolCapabilities?.verifiedModes, ["native-tool"]);
    const transport = new OpenAICompatibleStructuredClient({ ...options, stream: false, fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function: { name: string } }> };
      const functionName = request.tools?.[0]?.function.name;
      assert.ok(functionName, "the selected exact route must send a native function contract");
      nativeTools.push(functionName);
      const userMessage = request.messages.find(message => message.role === "user")?.content;
      const input = typeof userMessage === "string" ? userMessage : Array.isArray(userMessage)
        ? userMessage.map(part => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("\n") : "";
      const data = JSON.parse(input) as Record<string, any>;
      let proposal: Record<string, unknown>;
      if (functionName === "project_evidence_requirement") {
        proposal = { requiresCurrentProjectEvidence: false };
      } else if (Array.isArray(data.availableIntents) && data.availableIntents.includes("delegate")) {
        const cody = data.availableMediobots.find((agent: { role: string; definitionId: string }) => agent.role === "coding"
          && data.assignableDefinitionIds.includes(agent.definitionId));
        assert.ok(cody, "Maestro's real production context must expose authorized Cody");
        maestroDelegated = true;
        proposal = { type: "delegate", definitionId: cody.definitionId, objective: "Create approval.txt with one line.",
          relevantContextRefs: [], constraints: [], expectedOutcome: "The approved file is created.",
          evidenceExpectations: ["Observed filesystem.write result"], requiredCapabilities: ["filesystem.write"] };
      } else if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
        const history = data.recentToolHistory as Array<{ action: string }>;
        if (!history.some(entry => entry.action.startsWith("filesystem.read approval.txt"))) {
          proposal = { type: "read", path: "approval.txt" };
        } else {
          codyProposedWrite = true;
          proposal = { type: "write", path: "approval.txt", content: "approved write\n" };
        }
      } else {
        throw new Error(`Unexpected controlled request contract: ${functionName}`);
      }
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
        { id: `call-${nativeTools.length}`, type: "function", function: { name: functionName, arguments: JSON.stringify(proposal) } },
      ] } }] });
    } });
    return { complete: request => transport.complete(request),
      completeCompatible: request => transport.completeCompatible!(request),
      usage: () => transport.usage(), metrics: () => transport.metrics() };
  } });
  const app = await startCommandCenter({ databasePath, providerRepository: providers,
    credentialStoreFactory: raw => new SqliteCredentialStore(raw), modelResolver: resolver,
    workspaceRoot, defaultApprovalMode: "Ask before edits", vite: false, listen: true, port: 0 });
  t.after(async () => { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); });

  const submittedResponse = await fetch(`${app.url}/api/turns`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "native-approval-thread", turnId: "native-approval-turn",
      prompt: "Ask Cody to create approval.txt with one line.",
      modelSelection: { providerConnectionId: "native-approval-provider", modelId: "MiniMaxAI/MiniMax-M2.7" },
      approvalMode: "Ask before edits" }) });
  assert.equal(submittedResponse.status, 202);
  const submitted = await submittedResponse.json() as { taskId: string };
  const deadline = Date.now() + 8_000;
  let state = "";
  while (Date.now() < deadline && state !== "waiting_approval" && state !== "failed" && state !== "completed") {
    const response = await fetch(`${app.url}/api/tasks/${submitted.taskId}`);
    const view = await response.json() as { task?: { state?: string } };
    state = view.task?.state ?? "";
    if (state !== "waiting_approval") await new Promise(resolve => setTimeout(resolve, 20));
  }

  const taskView = await (await fetch(`${app.url}/api/tasks/${submitted.taskId}`)).json();
  assert.equal(state, "waiting_approval", `the native write proposal must interrupt at the existing approval policy: ${JSON.stringify({ taskView, nativeTools })}`);
  assert.equal(maestroDelegated, true);
  assert.equal(codyProposedWrite, true);
  assert.ok(nativeTools.includes("mediobot_decision"));
  const approval = database.raw.prepare("SELECT task_id, status, request_json FROM durable_tool_approvals WHERE status = 'requested' LIMIT 1")
    .get() as { task_id: string; status: string; request_json: string } | undefined;
  assert.ok(approval, "the approval must be durably persisted before a mutating tool runs");
  assert.equal(approval.status, "requested");
  assert.match(approval.request_json, /filesystem\.write/);
  await assert.rejects(stat(path.join(workspaceRoot, "approval.txt")), { code: "ENOENT" },
    "a model-proposed native action must not execute before the user grants approval");
});

test("JSON Schema decisions use the production Maestro and Cody path with authorized tool execution", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-json-schema-turn-"));
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(root, "mediobot.sqlite");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "readme.txt"), "workspace evidence\n");
  const database = new LocalDatabase(databasePath);
  const providers = new ProviderRepository(database.raw);
  providers.save({ id: "schema-fixture", providerType: "custom", displayName: "Controlled schema fixture",
    connected: true, enabled: true, baseUrl: "https://schema.fixture/v1", models: [{ id: "schema-model", name: "Schema model",
      enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } }] }, "controlled-fixture-key");

  const schemaNames: string[] = [];
  let maestroDecisions = 0;
  let codyActions = 0;
  const resolver = new ModelResolver(providers, { createClient: options => {
    const transport = new OpenAICompatibleStructuredClient({ ...options, stream: false,
      protocolCapabilities: { verifiedModes: ["json-schema"] },
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: unknown }>;
          response_format?: { type?: string; json_schema?: { name?: string; schema?: unknown } };
        };
        assert.equal(request.response_format?.type, "json_schema", "the configured fixture must receive provider-native schema mode");
        const contractName = request.response_format?.json_schema?.name;
        assert.ok(contractName, "each production decision must include its existing schema contract");
        schemaNames.push(contractName);
        const userMessage = request.messages.find(message => message.role === "user")?.content;
        const input = typeof userMessage === "string" ? userMessage : Array.isArray(userMessage)
          ? userMessage.map(part => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("\n") : "";
        const data = JSON.parse(input) as Record<string, any>;
        let decision: Record<string, unknown>;
        if (contractName === "project_evidence_requirement") {
          decision = { requiresCurrentProjectEvidence: true };
        } else if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          const hasListing = (data.recentToolHistory as Array<{ action?: string }>).some(item => item.action?.startsWith("filesystem.list"));
          decision = hasListing
            ? { type: "finish", summary: "Listed the workspace and observed readme.txt." }
            : { type: "list", path: "." };
          codyActions += 1;
        } else if (maestroDecisions++ === 0) {
          const cody = (data.availableMediobots as Array<{ definitionId: string; role: string }>)
            .find(agent => agent.role === "coding" && (data.assignableDefinitionIds as string[]).includes(agent.definitionId));
          assert.ok(cody, "the production Maestro context must include authorized Cody");
          decision = { type: "delegate", definitionId: cody.definitionId, objective: "List the project files and report the observed names.",
            relevantContextRefs: [], constraints: ["Read-only inspection."], expectedOutcome: "Report observed project file names.",
            evidenceExpectations: ["Observed filesystem.list result."], requiredCapabilities: ["filesystem.list"] };
        } else {
          const evidence = (data.relevantEvidence as Array<{ id?: string; validity?: string; source?: { type?: string } }> | undefined) ?? [];
          const observed = evidence.find(item => item.id && item.validity === "observed" && item.source?.type === "coding-tool");
          assert.ok(observed?.id, "Maestro synthesis must receive Cody's observed tool evidence");
          decision = { type: "respond", message: "Cody listed the project files and observed readme.txt in the workspace.",
            basis: "project-evidence", evidenceRefs: [observed.id] };
        }
        return Response.json({ choices: [{ finish_reason: "stop", message: { parsed: decision } }] });
      } });
    return { complete: request => transport.complete(request), completeCompatible: request => transport.completeCompatible!(request),
      usage: () => transport.usage(), metrics: () => transport.metrics() };
  } });
  const app = await startCommandCenter({ databasePath, providerRepository: providers,
    credentialStoreFactory: raw => new SqliteCredentialStore(raw), modelResolver: resolver,
    workspaceRoot, vite: false, listen: true, port: 0 });
  t.after(async () => { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); });

  const submitted = await fetch(`${app.url}/api/turns`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "schema-thread", turnId: "schema-turn",
      prompt: "Ask Cody to inspect the project and report the observed file names.",
      modelSelection: { providerConnectionId: "schema-fixture", modelId: "schema-model" } }) });
  assert.equal(submitted.status, 202);
  const { taskId } = await submitted.json() as { taskId: string };
  assert.ok(taskId);
  const deadline = Date.now() + 10_000;
  let state = "";
  while (Date.now() < deadline && !["completed", "failed", "cancelled"].includes(state)) {
    const response = await fetch(`${app.url}/api/tasks/${taskId}`);
    const view = await response.json() as { task?: { state?: string } };
    state = view.task?.state ?? "";
    if (!["completed", "failed", "cancelled"].includes(state)) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(state, "completed");
  assert.ok(maestroDecisions >= 2, "Maestro must delegate and synthesize through its production decision adapter");
  assert.ok(codyActions >= 2, "Cody must produce a tool action and a completion report through the same schema adapter");
  assert.ok(schemaNames.filter(name => name === "mediobot_decision").length >= 4);
  assert.ok(schemaNames.includes("project_evidence_requirement"));
  const events = app.composition.taskEvents.get(taskId as never) ?? [];
  assert.ok(events.some(event => event.type === "tool.completed" && event.toolName === "filesystem.list"),
    "the model proposal must pass the existing permission and execution path and produce a real local tool result");
  assert.ok(events.some(event => event.type === "worker.assigned"
    && event.workerDefinitionId === app.composition.codyDefinitionId),
  "Maestro's actual assignment must remain attributed to Cody in the product event stream");
  const transcript = await (await fetch(`${app.url}/api/threads/schema-thread`)).json() as { thread?: { turns?: Array<{ status?: string; items?: Array<{ type?: string; text?: string }> }> } };
  assert.equal(transcript.thread?.turns?.[0]?.status, "completed");
  assert.ok(transcript.thread?.turns?.[0]?.items?.some(item => item.type === "agent_message" && /readme\.txt/.test(item.text ?? "")),
    "the final evidence-grounded response must persist in Main Chat");
});

test("the exact hosted NIM prompt-JSON profile remains usable through /api/turns without unsupported fields", { timeout: 10_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-nim-prompt-json-"));
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(root, "mediobot.sqlite");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "known-file.txt"), "local evidence\n");
  const database = new LocalDatabase(databasePath);
  const providers = new ProviderRepository(database.raw);
  const selection = { providerConnectionId: "nvidia-fixture", modelId: "nvidia/nemotron-3-ultra-550b-a55b" };
  providers.save({ id: selection.providerConnectionId, providerType: "nvidia", displayName: "Controlled NIM fixture",
    baseUrl: "https://integrate.api.nvidia.com/v1", connected: true, enabled: true,
    models: [{ id: selection.modelId, name: "Nemotron fixture", enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: true } }] }, "controlled-fixture-key");
  const requestBodies: Array<Record<string, unknown>> = [];
  let delegated = false;
  let codyListed = false;
  let synthesisUsedEvidence = false;
  const resolver = new ModelResolver(providers, { createClient: options => {
    assert.deepEqual(options.protocolCapabilities?.verifiedModes, ["prompt-json"]);
    assert.equal(options.jsonMode, false);
    const transport = new OpenAICompatibleStructuredClient({ ...options, stream: false, fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      requestBodies.push(body);
      const userContent = body.messages?.find((message: { role?: string }) => message.role === "user")?.content;
      const inputText = typeof userContent === "string" ? userContent : Array.isArray(userContent)
        ? userContent.map((part: { text?: string }) => part.text ?? "").join("\n") : "";
      const input = JSON.parse(inputText) as Record<string, any>;
      let decision: Record<string, unknown>;
      if (typeof input.userGoal === "string" && typeof input.workspaceStatus === "string") {
        decision = { requiresCurrentProjectEvidence: true };
      } else if (typeof input.goal === "string" && Array.isArray(input.recentToolHistory)) {
        const listed = (input.recentToolHistory as Array<{ action?: string }>).some(item => item.action?.startsWith("filesystem.list"));
        if (!listed) {
          codyListed = true;
          decision = { type: "list", path: "." };
        } else decision = { type: "finish", summary: "Listed the workspace and observed known-file.txt." };
      } else if (Array.isArray(input.availableIntents) && input.availableIntents.includes("delegate")) {
        const cody = (input.availableMediobots as Array<{ definitionId: string; role: string }>)
          .find(agent => agent.role === "coding" && (input.assignableDefinitionIds as string[]).includes(agent.definitionId));
        assert.ok(cody, "the exact hosted prompt-JSON profile must receive Maestro's authorized Cody assignment context");
        delegated = true;
        decision = { type: "delegate", definitionId: cody.definitionId,
          objective: "List the project files and report the observed names.", relevantContextRefs: [], constraints: ["Read-only inspection."],
          expectedOutcome: "Report the observed project file names.", evidenceExpectations: ["Observed filesystem.list result."],
          requiredCapabilities: ["filesystem.list"] };
      } else if (Array.isArray(input.availableIntents) && input.availableIntents.includes("respond")) {
        const evidence = (input.relevantEvidence as Array<{ id?: string; validity?: string; source?: { type?: string } }> | undefined)
          ?.find(item => item.id && item.validity === "observed" && item.source?.type === "coding-tool");
        synthesisUsedEvidence = Boolean(evidence?.id);
        decision = { type: "respond", message: evidence
          ? "Cody used its authorized filesystem.list result to observe known-file.txt in the project."
          : "The project listing was not available for verification.",
        basis: "project-evidence", evidenceRefs: evidence?.id ? [evidence.id] : [] };
      } else throw new Error(`Unexpected hosted prompt-JSON input keys: ${Object.keys(input).join(",")}`);
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(decision) } }] });
    } });
    return { complete: request => transport.complete(request), completeCompatible: request => transport.completeCompatible!(request),
      usage: () => transport.usage(), metrics: () => transport.metrics() };
  } });
  const app = await startCommandCenter({ databasePath, providerRepository: providers,
    credentialStoreFactory: raw => new SqliteCredentialStore(raw), modelResolver: resolver,
    workspaceRoot, vite: false, listen: true, port: 0 });
  t.after(async () => { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); });

  const submitted = await fetch(`${app.url}/api/turns`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "nim-thread", turnId: "nim-turn",
      prompt: "Ask Cody to list the project files and tell me the observed names.", modelSelection: selection }) });
  assert.equal(submitted.status, 202);
  const { taskId } = await submitted.json() as { taskId: string };
  const deadline = Date.now() + 5_000;
  let turnStatus = "";
  while (Date.now() < deadline && !["completed", "failed", "cancelled"].includes(turnStatus)) {
    const response = await fetch(`${app.url}/api/threads/nim-thread`);
    const thread = await response.json() as { thread?: { turns?: Array<{ id?: string; status?: string }> } };
    turnStatus = thread.thread?.turns?.find(turn => turn.id === "nim-turn")?.status ?? "";
    if (!["completed", "failed", "cancelled"].includes(turnStatus)) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(turnStatus, "completed");
  assert.ok(delegated, "Maestro must delegate through the selected hosted prompt-JSON route");
  assert.ok(codyListed, "Cody must propose its read-only action through the same route");
  assert.ok(synthesisUsedEvidence, "Maestro synthesis must consume Cody's observed tool evidence");
  assert.ok(requestBodies.length >= 4);
  for (const requestBody of requestBodies) {
    assert.equal(requestBody.model, selection.modelId, "the exact selected model must be retained");
    assert.equal("tools" in requestBody, false, "the unverified hosted route must not receive native tool declarations");
    assert.equal("response_format" in requestBody, false, "the hosted prompt-JSON route must not receive an undocumented schema mode");
    assert.ok((requestBody.messages as Array<{ role: string }>).some(message => message.role === "system"),
      "the exact Nemotron profile may use its documented system role");
  }
  assert.ok((app.composition.taskEvents.get(taskId as never) ?? [])
    .some(event => event.type === "tool.completed" && event.toolName === "filesystem.list"),
  "the prompt-JSON action must pass through the existing authorized tool executor");
  const thread = await (await fetch(`${app.url}/api/threads/nim-thread`)).json() as { thread?: { turns?: Array<{ status?: string; items?: Array<{ type?: string; text?: string }> }> } };
  assert.equal(thread.thread?.turns?.[0]?.status, "completed");
  assert.ok(thread.thread?.turns?.[0]?.items?.some(item => item.type === "agent_message" && /known-file\.txt/.test(item.text ?? "")));
});

test("Claude Messages codec runs Maestro delegation, Cody tool execution, and final synthesis through /api/turns", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-claude-turn-"));
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(root, "mediobot.sqlite");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "known-file.txt"), "local evidence\n");
  const database = new LocalDatabase(databasePath);
  const providers = new ProviderRepository(database.raw);
  const selection = { providerConnectionId: "claude-fixture", modelId: "claude-sonnet-4-6" };
  providers.save({ id: selection.providerConnectionId, providerType: "anthropic", displayName: "Controlled Claude fixture",
    baseUrl: "https://api.anthropic.com/v1", connected: true, enabled: true,
    models: [{ id: selection.modelId, name: "Claude fixture", enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: true, maestroCompatible: true } }] }, "controlled-fixture-key");
  let proposalCount = 0;
  let delegated = false;
  let codyListProposed = false;
  const resolver = new ModelResolver(providers, { createAnthropicClient: options => new AnthropicMessagesStructuredClient({
    ...options, fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { model: string; tools?: Array<{ name: string }>; messages?: Array<{ content?: Array<{ text?: string }> }> };
      assert.equal(request.model, selection.modelId);
      proposalCount++;
      const contractName = request.tools?.[0]?.name;
      assert.ok(contractName);
      const inputText = request.messages?.flatMap(message => message.content ?? []).map(part => part.text ?? "").join("\n") ?? "";
      let input: Record<string, any>;
      try { input = JSON.parse(inputText) as Record<string, any>; }
      catch { throw new Error(`Unexpected Claude test input for ${contractName}`); }
      let toolName = contractName;
      let proposal: Record<string, unknown>;
      if (contractName === "project_evidence_requirement") {
        proposal = { requiresCurrentProjectEvidence: true };
      } else if (Array.isArray(input.availableIntents) && input.availableIntents.includes("delegate")) {
        const cody = (input.availableMediobots as Array<{ role: string; definitionId: string }>).find(agent => agent.role === "coding"
          && (input.assignableDefinitionIds as string[]).includes(agent.definitionId));
        assert.ok(cody);
        delegated = true;
        proposal = { type: "delegate", definitionId: cody.definitionId,
          objective: "List the project files and report the observed names.", relevantContextRefs: [], constraints: ["Read-only inspection."],
          expectedOutcome: "Report the observed project file names.", evidenceExpectations: ["Observed filesystem.list result."],
          requiredCapabilities: ["filesystem.list"] };
      } else if (typeof input.goal === "string" && Array.isArray(input.recentToolHistory)) {
        const listed = (input.recentToolHistory as Array<{ action?: string }>).some(item => item.action?.startsWith("filesystem.list"));
        if (!listed) {
          codyListProposed = true;
          proposal = { type: "list", path: "." };
        } else {
          proposal = { type: "finish", summary: "Listed the project and observed known-file.txt." };
        }
      } else if (Array.isArray(input.availableIntents) && input.availableIntents.includes("respond")
        && !input.availableIntents.includes("delegate")) {
        const evidence = (input.relevantEvidence as Array<{ id?: string; validity?: string; source?: { type?: string } }> | undefined)
          ?.find(item => item.id && item.validity === "observed" && item.source?.type === "coding-tool");
        proposal = { type: "respond", message: evidence
          ? "Cody used its authorized filesystem.list result to observe known-file.txt in the project."
          : "The workspace listing result was not available for verification.",
        basis: "project-evidence", evidenceRefs: evidence?.id ? [evidence.id] : [] };
      } else {
        throw new Error(`Unexpected Claude test contract payload: ${contractName}; keys=${Object.keys(input).join(",")}`);
      }
      return Response.json({ type: "message", content: [{ type: "tool_use", id: `toolu_${proposalCount}`,
        name: toolName, input: proposal }], stop_reason: "tool_use", usage: { input_tokens: 6, output_tokens: 8 } });
    },
  }) });
  const app = await startCommandCenter({ databasePath, providerRepository: providers,
    credentialStoreFactory: raw => new SqliteCredentialStore(raw), modelResolver: resolver,
    workspaceRoot, vite: false, listen: true, port: 0 });
  t.after(async () => { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); });

  const submitted = await fetch(`${app.url}/api/turns`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "claude-thread", turnId: "claude-turn",
      prompt: "Ask Cody to list the project files and tell me the observed names.", modelSelection: selection }) });
  assert.equal(submitted.status, 202);
  const { taskId } = await submitted.json() as { taskId: string };
  const deadline = Date.now() + 10_000;
  let status = "";
  while (Date.now() < deadline && !["completed", "failed", "cancelled"].includes(status)) {
    const response = await fetch(`${app.url}/api/tasks/${taskId}`);
    const task = await response.json() as { task?: { state?: string } };
    status = task.task?.state ?? "";
    if (!["completed", "failed", "cancelled"].includes(status)) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(status, "completed");
  assert.ok(proposalCount >= 3);
  assert.equal(delegated, true);
  assert.equal(codyListProposed, true);
  const events = app.composition.taskEvents.get(taskId as never) ?? [];
  assert.ok(events.some(event => event.type === "tool.completed" && event.toolName === "filesystem.list"));
  assert.ok(events.some(event => event.type === "worker.assigned" && event.workerDefinitionId === app.composition.codyDefinitionId));
  assert.ok(events.some(event => event.type === "tool.completed" && event.toolName === "filesystem.list"));
  const thread = await (await fetch(`${app.url}/api/threads/claude-thread`)).json() as {
    thread?: { turns?: Array<{ items?: Array<{ type?: string; text?: string }> }> };
  };
  assert.ok(thread.thread?.turns?.[0]?.items?.some(item => item.type === "agent_message" && /known-file\.txt/.test(item.text ?? "")));
});

test("Gemini compatibility endpoint runs Maestro delegation and authorized Cody tools through /api/turns", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-gemini-turn-"));
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(root, "mediobot.sqlite");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "known-file.txt"), "local evidence\n");
  const database = new LocalDatabase(databasePath);
  const providers = new ProviderRepository(database.raw);
  const selection = { providerConnectionId: "google-fixture", modelId: "gemini-3.8-flash" };
  providers.save({ id: selection.providerConnectionId, providerType: "google", displayName: "Controlled Gemini fixture",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", connected: true, enabled: true,
    models: [{ id: selection.modelId, name: "Gemini fixture", enabled: true,
      capabilities: { text: true, reasoning: true, vision: true, tools: true, maestroCompatible: true } }] }, "controlled-fixture-key");
  let proposalCount = 0;
  let delegated = false;
  let codyListProposed = false;
  let synthesisUsedEvidence = false;
  const resolver = new ModelResolver(providers, { createClient: options => new OpenAICompatibleStructuredClient({
    ...options, stream: false, fetch: async (url, init) => {
      assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer controlled-fixture-key");
      const request = JSON.parse(String(init?.body)) as { model: string; tool_choice?: unknown;
        tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string; content?: unknown }> };
      assert.equal(request.model, selection.modelId);
      assert.equal(request.tool_choice, "auto");
      assert.equal("response_format" in request, false, "Google's OpenAI-compatible profile does not claim JSON Schema mode");
      const functionName = request.tools?.[0]?.function.name;
      assert.ok(functionName);
      proposalCount++;
      const content = request.messages?.find(message => message.role === "user")?.content;
      const inputText = typeof content === "string" ? content : Array.isArray(content)
        ? content.map(part => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("\n") : "";
      const input = JSON.parse(inputText) as Record<string, any>;
      let proposal: Record<string, unknown>;
      if (functionName === "project_evidence_requirement") {
        proposal = { requiresCurrentProjectEvidence: true };
      } else if (Array.isArray(input.availableIntents) && input.availableIntents.includes("delegate")) {
        const cody = (input.availableMediobots as Array<{ role: string; definitionId: string }>).find(agent => agent.role === "coding"
          && (input.assignableDefinitionIds as string[]).includes(agent.definitionId));
        assert.ok(cody);
        delegated = true;
        proposal = { type: "delegate", definitionId: cody.definitionId,
          objective: "List the project files and report the observed names.", relevantContextRefs: [], constraints: ["Read-only inspection."],
          expectedOutcome: "Report the observed project file names.", evidenceExpectations: ["Observed filesystem.list result."],
          requiredCapabilities: ["filesystem.list"] };
      } else if (typeof input.goal === "string" && Array.isArray(input.recentToolHistory)) {
        const listed = (input.recentToolHistory as Array<{ action?: string }>).some(item => item.action?.startsWith("filesystem.list"));
        if (!listed) {
          codyListProposed = true;
          proposal = { type: "list", path: "." };
        } else proposal = { type: "finish", summary: "Listed the project and observed known-file.txt." };
      } else if (Array.isArray(input.availableIntents) && input.availableIntents.includes("respond")
        && !input.availableIntents.includes("delegate")) {
        const evidence = (input.relevantEvidence as Array<{ id?: string; validity?: string; source?: { type?: string } }> | undefined)
          ?.find(item => item.id && item.validity === "observed" && item.source?.type === "coding-tool");
        synthesisUsedEvidence = Boolean(evidence?.id);
        proposal = { type: "respond", message: evidence
          ? "Cody used its authorized filesystem.list result to observe known-file.txt in this project."
          : "The project listing was not available for verification.",
        basis: "project-evidence", evidenceRefs: evidence?.id ? [evidence.id] : [] };
      } else throw new Error(`Unexpected Gemini fixture contract ${functionName}`);
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: `call-${proposalCount}`,
        type: "function", function: { name: functionName, arguments: JSON.stringify(proposal) } }] } }] });
    },
  }) });
  const app = await startCommandCenter({ databasePath, providerRepository: providers,
    credentialStoreFactory: raw => new SqliteCredentialStore(raw), modelResolver: resolver,
    workspaceRoot, vite: false, listen: true, port: 0 });
  t.after(async () => { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); });

  const submitted = await fetch(`${app.url}/api/turns`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "gemini-thread", turnId: "gemini-turn",
      prompt: "Ask Cody to list the project files and tell me the observed names.", modelSelection: selection }) });
  assert.equal(submitted.status, 202);
  const { taskId } = await submitted.json() as { taskId: string };
  const deadline = Date.now() + 10_000;
  let status = "";
  while (Date.now() < deadline && !["completed", "failed", "cancelled"].includes(status)) {
    const response = await fetch(`${app.url}/api/tasks/${taskId}`);
    const task = await response.json() as { task?: { state?: string } };
    status = task.task?.state ?? "";
    if (!["completed", "failed", "cancelled"].includes(status)) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(status, "completed");
  assert.ok(proposalCount >= 4);
  assert.equal(delegated, true);
  assert.equal(codyListProposed, true);
  assert.equal(synthesisUsedEvidence, true);
  const events = app.composition.taskEvents.get(taskId as never) ?? [];
  assert.ok(events.some(event => event.type === "tool.completed" && event.toolName === "filesystem.list"));
  assert.ok(events.some(event => event.type === "worker.assigned" && event.workerDefinitionId === app.composition.codyDefinitionId));
  const thread = await (await fetch(`${app.url}/api/threads/gemini-thread`)).json() as {
    thread?: { turns?: Array<{ items?: Array<{ type?: string; text?: string }> }> };
  };
  assert.ok(thread.thread?.turns?.[0]?.items?.some(item => item.type === "agent_message" && /known-file\.txt/.test(item.text ?? "")));
});

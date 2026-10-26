import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { ToolRuntime } from "@mediobot-v2/tools";
import { WorkerRuntime } from "@mediobot-v2/runtime";
import { CodyDecisionProvider } from "@mediobot-v2/cody";
import {
  compileMaestroContext,
  createMaestroCodyExecution,
  discoverProjectIntelligence,
  isSensitiveName,
  MaestroDecisionProvider,
  readWorkspaceFile,
} from "../src/index.ts";

describe("Maestro Project Context & Discovery", () => {
  it("bounds and sanitizes verified memory context before model injection", () => {
    const compiled = compileMaestroContext("Implement the requested helper", {
      relevantMemory: [
        { name: "Verified task evidence", value: `Bearer abcdefghijklmnop ${"x".repeat(2_000)}` },
        { name: "Second verified record", value: "Relevant behavior" },
        { name: "Third verified record", value: "Relevant limitation" },
        { name: "Excess record", value: "Must not enter context" },
      ],
    });
    const payload = JSON.parse(compiled.input);
    assert.equal(payload.relevantMemory.length, 3);
    assert.ok(payload.relevantMemory[0].value.length <= 1_200);
    assert.doesNotMatch(payload.relevantMemory[0].value, /abcdefghijklmnop/);
    assert.equal(payload.relevantMemory.some((record: { name: string }) => record.name === "Excess record"), false);
  });

  it("detects sensitive and credential file names strictly", () => {
    assert.equal(isSensitiveName(".env"), true);
    assert.equal(isSensitiveName(".env.local"), true);
    assert.equal(isSensitiveName(".env.production"), true);
    assert.equal(isSensitiveName("credentials.json"), true);
    assert.equal(isSensitiveName("secrets.json"), true);
    assert.equal(isSensitiveName("token.json"), true);
    assert.equal(isSensitiveName("credentials.yaml"), true);
    assert.equal(isSensitiveName("id_rsa"), true);
    assert.equal(isSensitiveName("id_ed25519"), true);
    assert.equal(isSensitiveName("server.key"), true);
    assert.equal(isSensitiveName("cert.pem"), true);
    assert.equal(isSensitiveName("api_token.txt"), true);
    assert.equal(isSensitiveName("db_password.conf"), true);
    assert.equal(isSensitiveName(".npmrc"), true);
    assert.equal(isSensitiveName(".aws"), true);
    assert.equal(isSensitiveName(".aws/credentials"), true);
    assert.equal(isSensitiveName(".ssh"), true);
    assert.equal(isSensitiveName(".ssh/id_rsa"), true);

    assert.equal(isSensitiveName("package.json"), false);
    assert.equal(isSensitiveName("AGENTS.md"), false);
    assert.equal(isSensitiveName("README.md"), false);
    assert.equal(isSensitiveName("src/index.ts"), false);
  });

  it("rejects credential-bearing paths before filesystem access", async () => {
    assert.equal(await readWorkspaceFile("/not-opened", ".aws/config", 1024), null);
    assert.equal(await readWorkspaceFile("/not-opened", ".git/config", 1024), null);
    assert.equal(await readWorkspaceFile("/not-opened", ".npmrc", 1024), null);
  });

  it("discovers progressive project structure, instructions, and manifest while ignoring sensitive files", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-project-discovery-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    // Create safe files
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), "export const start = () => {};\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "sample-project",
      type: "module",
      scripts: { test: "node --test", build: "tsc" },
      dependencies: { express: "^4.18.0" },
    }));
    await writeFile(path.join(root, "AGENTS.md"), "# Project Instructions\nAlways verify with tests.\n");

    // Create sensitive files that must be ignored
    await writeFile(path.join(root, ".env"), "SECRET_KEY=12345\n");
    await writeFile(path.join(root, ".env.local"), "LOCAL_SECRET=abc\n");
    await writeFile(path.join(root, "credentials.json"), '{"token": "xyz"}\n');
    await writeFile(path.join(root, "server.key"), "PRIVATE KEY\n");

    const records = await discoverProjectIntelligence(await realpath(root));
    assert.ok(records.length > 0);

    const structure = records.find((r) => r.name === "project_structure");
    assert.ok(structure, "project_structure record must exist");
    assert.ok(structure.value.includes("src/"), "must include src/");
    assert.ok(structure.value.includes("package.json"), "must include package.json");
    assert.ok(structure.value.includes("AGENTS.md"), "must include AGENTS.md");
    // Ensure zero sensitive files appear in structure
    assert.equal(structure.value.includes(".env"), false, "must not include .env");
    assert.equal(structure.value.includes("credentials.json"), false, "must not include credentials");
    assert.equal(structure.value.includes("server.key"), false, "must not include server.key");

    const instructions = records.find((r) => r.name === "project_instructions");
    assert.ok(instructions, "project_instructions record must exist");
    assert.ok(instructions.value.includes("Always verify with tests."));

    const manifest = records.find((r) => r.name === "project_manifest");
    assert.ok(manifest, "project_manifest record must exist");
    const parsedManifest = JSON.parse(manifest.value);
    assert.equal(parsedManifest.name, "sample-project");
    assert.deepEqual(parsedManifest.scripts, ["test", "build"]);
    assert.deepEqual(parsedManifest.dependencies, ["express"]);

    // Ensure raw secret content never appears anywhere in records
    const allText = JSON.stringify(records);
    assert.equal(allText.includes("12345"), false);
    assert.equal(allText.includes("LOCAL_SECRET"), false);
    assert.equal(allText.includes("PRIVATE KEY"), false);
  });

  it("never reads project instructions through an intermediate symlink outside the workspace", async (t) => {
    const base = await mkdtemp(path.join(os.tmpdir(), "mediobot-project-symlink-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "instructions.md"), "OUTSIDE_WORKSPACE_SENTINEL");
    await symlink(outside, path.join(root, ".agents"), "dir");

    const records = await discoverProjectIntelligence(await realpath(root));
    assert.equal(JSON.stringify(records).includes("OUTSIDE_WORKSPACE_SENTINEL"), false);
    assert.equal(records.some((record) => record.name === "project_instructions"), false);
  });

  it("compiles projectIntelligence, workspaceState, and toolMetadata into Maestro input safely", () => {
    const compiled = compileMaestroContext("Inspect the project", {
      projectName: "TestApp",
      workspaceState: {
        workspaceId: "ws-12345",
        rootPath: "/path/to/project",
        displayName: "TestApp",
        status: "OPEN",
        activeFile: "src/server.ts",
        openTabsCount: 2,
      },
      projectIntelligence: [
        { name: "project_structure", value: "src/\npackage.json\n" },
        { name: "project_instructions", value: "[AGENTS.md]\nFollow rules." },
      ],
      toolMetadata: [
        { name: "filesystem.read", description: "Read file contents" },
      ],
    });

    const parsed = JSON.parse(compiled.input);
    assert.equal(parsed.projectName, "TestApp");
    assert.equal(parsed.workspaceState.workspaceId, "ws-12345");
    assert.equal(parsed.workspaceState.status, "OPEN");
    assert.equal(parsed.workspaceState.activeFile, "src/server.ts");
    assert.equal(parsed.projectIntelligence.length, 2);
    assert.equal(parsed.toolMetadata[0].name, "filesystem.read");
  });

  it("decideTurn populates project intelligence and tool metadata when passed in options", async () => {
    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    let capturedInput = "";

    const decisions = new MaestroDecisionProvider({
      complete: async ({ input, system }) => {
        if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
        capturedInput = input;
        return JSON.stringify({ type: "respond", message: "Understood the project.", basis: "conversation", evidenceRefs: [] });
      },
    });

    const execution = createMaestroCodyExecution({
      world,
      runtime,
      tools: new ToolRuntime(world),
      maestroDefinition: { id: "maestro", name: "Maestro", role: "orchestration", version: "1.0.0", instructions: "Lead" },
      maestroDecisions: decisions,
      codyDecisions: new CodyDecisionProvider({ complete: async () => "{}" }),
    });

    const decision = await execution.adapter.decideTurn(world, execution.maestroDefinitionId, "Review structure", {
      workspaceRoot: "/workspace/sample",
      projectName: "SampleProject",
      workspaceState: { workspaceId: "ws-abc", rootPath: "/workspace/sample", status: "OPEN", activeFile: "src/app.ts" },
      projectIntelligence: [{ name: "project_structure", value: "src/\npackage.json" }],
      toolMetadata: [{ name: "filesystem.list", description: "List files" }],
    }, new AbortController().signal);

    assert.equal(decision.type, "respond");
    const parsed = JSON.parse(capturedInput);
    assert.equal(parsed.projectName, "SampleProject");
    assert.equal(parsed.workspaceState.workspaceId, "ws-abc");
    assert.equal(parsed.workspaceState.activeFile, "src/app.ts");
    assert.equal(parsed.projectIntelligence[0].name, "project_structure");
    assert.equal(parsed.toolMetadata[0].name, "filesystem.list");
  });

  it("limits a workspace-independent Maestro turn to response or user-input intents", async () => {
    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    let capturedInput = "";
    const decisions = new MaestroDecisionProvider({
      complete: async ({ input }) => {
        capturedInput = input;
        return JSON.stringify({ type: "respond", message: "I can discuss this without opening a project.", basis: "conversation", evidenceRefs: [] });
      },
    });
    const execution = createMaestroCodyExecution({
      world,
      runtime,
      tools: new ToolRuntime(world),
      maestroDefinition: { id: "maestro", name: "Maestro", role: "orchestration", version: "1.0.0", instructions: "Lead" },
      maestroDecisions: decisions,
      codyDecisions: new CodyDecisionProvider({ complete: async () => "{}" }),
    });

    await execution.adapter.decideTurn(world, execution.maestroDefinitionId, "Explain what you can do", {
      workspaceExecutionAuthorized: false,
      projectIntelligence: [{ name: "workspace_status", value: "No active workspace." }],
    }, new AbortController().signal);
    const parsed = JSON.parse(capturedInput);
    assert.deepEqual(parsed.availableIntents, ["respond", "request_user_input"]);
    assert.equal(Object.hasOwn(parsed, "workspaceRoot"), false);
  });

  it("handles empty or non-existent workspace root gracefully without error", async () => {
    const records = await discoverProjectIntelligence("/non/existent/path/999");
    assert.deepEqual(records, []);
  });
});

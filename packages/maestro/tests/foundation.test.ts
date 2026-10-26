import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { compileMaestroContext } from "../src/context.ts";
import { loadMediobotDefinition, parseMediobotDefinition } from "../src/definitions.ts";
import { MarkdownSkillCatalog } from "../src/skills.ts";

describe("Maestro definition and context foundation", () => {
  it("loads the canonical Markdown definition into the existing domain definition contract", async () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../mediobots/maestro/MEDIOBOT.md");
    const definition = await loadMediobotDefinition(file);
    const world = createWorld();
    const registered = world.registerMediobotDefinition({ ...definition, declaredCapabilities: [] });
    assert.equal(registered.name, "Maestro");
    assert.equal(registered.role, "orchestration");
    assert.equal(registered.version, "1.0.0");
    assert.match(registered.instructions, /Conversation is the default/);
    assert.deepEqual(world.inspect().workers, []);
    assert.deepEqual(world.inspect().tasks, []);
  });

  it("rejects invalid and unsupported definition metadata", () => {
    assert.throws(() => parseMediobotDefinition("# no frontmatter"), /frontmatter/);
    assert.throws(() => parseMediobotDefinition("---\nid: maestro\nname: Maestro\nrole: orchestration\nversion: 1\nprovider: MiniMax\n---\nInstructions"), /unsupported/);
  });

  it("lists compact skill metadata and loads full instructions only on explicit request", async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mediobot-skills-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, "delegation"));
    await writeFile(path.join(directory, "delegation", "SKILL.md"), [
      "---", "name: Delegation", "description: Delegate bounded work.", "when_to_use: A specialist is useful.", "---", "",
      "Only this body is the full instruction."].join("\n"));
    const catalog = new MarkdownSkillCatalog(directory);
    const metadata = await catalog.list();
    assert.deepEqual(metadata, [{ id: "delegation", name: "Delegation", description: "Delegate bounded work.", whenToUse: "A specialist is useful." }]);
    assert.equal(JSON.stringify(metadata).includes("Only this body"), false);
    assert.deepEqual(catalog.listSync(), metadata);
    assert.equal(await catalog.loadInstructions("delegation"), "Only this body is the full instruction.");
    await assert.rejects(catalog.loadInstructions("../outside"), /Unknown skill/);
  });

  it("compiles typed context categories and keeps runtime permissions structurally authoritative", () => {
    const compiled = compileMaestroContext("Plan the task", {
      definitionInstructions: "Be concise.",
      relevantConversation: [{ user: "Earlier request", assistant: "Prior answer" }],
      projectIntelligence: [{ name: "package manager", value: "pnpm" }],
      relevantMemory: [{ name: "preference", value: "verify tests" }],
      availableMediobots: [{ definitionId: "vision", name: "Vision", role: "browser", capabilities: ["browser"] }],
      assignableDefinitionIds: ["vision"],
      capabilityMetadata: [{ name: "browser", description: "Observe pages" }],
      toolMetadata: [{ name: "navigate", description: "Navigate an owned page" }],
      skillCatalog: [{ id: "delegation", name: "Delegation", description: "Bounded assignment", whenToUse: "Specialist work" }],
      selectedSkills: [{ id: "delegation", instructions: "Check evidence after assignment." }],
      workspaceState: { project: "sample" }, runtimeState: { visionAvailable: true },
      permissions: [{ capability: "browser.navigate", allowed: false, reason: "Not granted" }],
    });
    const input = JSON.parse(compiled.input) as Record<string, unknown>;
    assert.equal(input.userGoal, "Plan the task");
    assert.ok(Array.isArray(input.projectIntelligence));
    assert.ok(Array.isArray(input.relevantMemory));
    assert.ok(Array.isArray(input.skillCatalog));
    assert.deepEqual(input.permissions, [{ capability: "browser.navigate", allowed: false, reason: "Not granted" }]);
    assert.match(compiled.system, /Structured runtimeState and permissions are authoritative/);
  });

  it("includes a compact Goal Anchor and selected evidence without replaying conversation history", () => {
    const world = createWorld();
    const goal = world.createGoal({ threadId: "thread-anchor", objective: "Make the build pass",
      constraints: [{ text: "Do not change public APIs", source: "user", hard: true }],
      successCriteria: [{ id: "build", statement: "Typecheck succeeds" }] });
    const anchor = world.getGoalAnchor(goal.id);
    const compiled = compileMaestroContext("Check the current blocker", { goalAnchor: anchor,
      relevantEvidence: [{ id: "evidence_stub" as never, source: { type: "build", reference: "latest" },
        content: "<think>private reasoning</think>Typecheck still reports one error", claim: "Build is not yet clear", validity: "observed" }] });
    const input = JSON.parse(compiled.input) as Record<string, unknown>;
    assert.equal(input.userGoal, "Check the current blocker");
    assert.deepEqual(input.goalAnchor, anchor);
    assert.equal(Array.isArray(input.recentHistory), false);
    assert.deepEqual(input.relevantEvidence, [{ id: "evidence_stub", source: { type: "build", reference: "latest" },
      content: "Typecheck still reports one error", claim: "Build is not yet clear", validity: "observed" }]);
    assert.doesNotMatch(compiled.input, /private reasoning|<think>/i);
    assert.match(compiled.system, /Structured runtimeState and permissions are authoritative/);
  });
});

import type { InMemoryWorld, MediobotDefinition, MediobotDefinitionId } from "@mediobot-v2/domain";

export {
  TesterDecisionError,
  TesterDecisionProvider,
  TesterExecutionAdapter,
  computeWorkspaceRevision,
  createShadowWorkspace,
  invalidateStaleVerificationEvidence,
  snapshotNodeModules,
  verifyNodeModulesIntegrity,
} from "./agent.ts";

export type {
  AssertionResult,
  TesterAction,
  TesterDecisionDiagnostic,
  TesterModelClient,
  TesterToolDiagnostic,
  VerificationReport,
  VerificationReportInput,
  VerificationToolExecution,
} from "./agent.ts";

export function createTesterDefinition(world: InMemoryWorld): MediobotDefinition {
  const existing = world.inspect().definitions.find((d) => d.role === "tester");
  if (existing) return existing;
  return world.registerMediobotDefinition({
    id: "tester" as MediobotDefinitionId,
    name: "Tester",
    role: "tester",
    version: "0.1.0",
    instructions: "Tester: critical independent review and verification specialist. Independently verify task requirements and code changes by inspecting workspace files, reviewing test configurations, and executing approved test commands. You cannot write or modify files in the workspace.",
    declaredCapabilities: [
      { kind: "resource", name: "workspace", description: "Operate within an owned local workspace" },
      { kind: "action", name: "terminal.execute", description: "Run a test or verification command in the owned workspace" },
      { kind: "action", name: "filesystem.read", description: "Read project files and test configurations" },
      { kind: "action", name: "filesystem.list", description: "List project files and test suites" },
      { kind: "action", name: "text-inference", description: "Bounded analysis over supplied context" },
    ],
  });
}

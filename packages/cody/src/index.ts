import type { InMemoryWorld, MediobotDefinition, MediobotDefinitionId } from "@mediobot-v2/domain";

export { CodyDecisionError, CodyDecisionProvider, CodyExecutionAdapter } from "./agent.ts";
export type { CodyAction, CodyModelClient, CodyDecisionDiagnostic, CodyToolDiagnostic } from "./agent.ts";

export function createCodyDefinition(world: InMemoryWorld): MediobotDefinition {
  return world.registerMediobotDefinition({
    id: "cody" as MediobotDefinitionId,
    name: "Cody",
    role: "coding",
    version: "0.1.0",
    instructions: "Implementation and technical reasoning specialist. Propose concrete designs and analyze implementation constraints in text; use workspace tools only for explicitly authorized implementation work.",
    declaredCapabilities: [
      { kind: "resource", name: "workspace", description: "Operate within an owned local workspace" },
      { kind: "action", name: "terminal.execute", description: "Run a command in the owned workspace" },
    ],
  });
}

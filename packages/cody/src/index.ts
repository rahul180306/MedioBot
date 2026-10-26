import type { InMemoryWorld, MediobotDefinition } from "@mediobot-v2/domain";

export function createCodyDefinition(world: InMemoryWorld): MediobotDefinition {
  return world.registerMediobotDefinition({
    name: "Cody",
    role: "coding",
    version: "0.1.0",
    instructions: "Native coding worker definition. Intelligence is supplied separately.",
    declaredCapabilities: [
      { kind: "resource", name: "workspace", description: "Operate within an owned local workspace" },
      { kind: "action", name: "terminal.execute", description: "Run a command in the owned workspace" },
    ],
  });
}

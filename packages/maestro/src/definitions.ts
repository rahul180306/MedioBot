import { readFile } from "node:fs/promises";
import type { InMemoryWorld, MediobotDefinition, MediobotDefinitionInput } from "@mediobot-v2/domain";

export interface MarkdownMediobotDefinition {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly version: string;
  readonly instructions: string;
}

const REQUIRED_FIELDS = ["id", "name", "role", "version"] as const;

export function parseMediobotDefinition(markdown: string): MarkdownMediobotDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error("Mediobot definition must start with YAML-style frontmatter");
  const metadata = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([a-z][a-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (!field || metadata.has(field[1]!)) throw new Error("Mediobot definition frontmatter is invalid");
    metadata.set(field[1]!, field[2]!.replace(/^(?:"([^"]*)"|'([^']*)')$/, (_all, doubleQuoted: string | undefined, singleQuoted: string | undefined) => doubleQuoted ?? singleQuoted ?? ""));
  }
  if ([...metadata.keys()].some((key) => !(REQUIRED_FIELDS as readonly string[]).includes(key))) {
    throw new Error("Mediobot definition contains unsupported frontmatter fields");
  }
  for (const key of REQUIRED_FIELDS) if (!metadata.get(key)?.trim()) throw new Error(`Mediobot definition is missing ${key}`);
  const instructions = match[2]!.trim();
  if (!instructions) throw new Error("Mediobot definition instructions cannot be empty");
  return { id: metadata.get("id")!, name: metadata.get("name")!, role: metadata.get("role")!,
    version: metadata.get("version")!, instructions };
}

export async function loadMediobotDefinition(filePath: string): Promise<MarkdownMediobotDefinition> {
  return parseMediobotDefinition(await readFile(filePath, "utf8"));
}

export function registerMaestroDefinition(world: InMemoryWorld, definition: MarkdownMediobotDefinition): MediobotDefinition {
  const input: MediobotDefinitionInput = { id: definition.id as MediobotDefinition["id"], name: definition.name, role: definition.role, version: definition.version,
    instructions: definition.instructions, declaredCapabilities: [
      { kind: "action", name: "assign-worker", description: "Assign a bounded task to a registered worker" },
    ] };
  return world.registerMediobotDefinition(input);
}

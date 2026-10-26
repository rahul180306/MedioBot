import { readdir, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface SkillMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
}

const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_FIELDS = ["name", "description", "when_to_use"] as const;

function parseSkill(markdown: string, id: string): { readonly metadata: SkillMetadata; readonly instructions: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error(`Skill ${id} must start with frontmatter`);
  const values = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([a-z][a-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (!field || values.has(field[1]!)) throw new Error(`Skill ${id} frontmatter is invalid`);
    values.set(field[1]!, field[2]!);
  }
  if ([...values.keys()].some((key) => !(REQUIRED_FIELDS as readonly string[]).includes(key))) {
    throw new Error(`Skill ${id} contains unsupported frontmatter fields`);
  }
  for (const key of REQUIRED_FIELDS) if (!values.get(key)?.trim()) throw new Error(`Skill ${id} is missing ${key}`);
  const instructions = match[2]!.trim();
  if (!instructions) throw new Error(`Skill ${id} instructions cannot be empty`);
  return { metadata: { id, name: values.get("name")!, description: values.get("description")!, whenToUse: values.get("when_to_use")! }, instructions };
}

/** Returns compact metadata; instruction bodies are available only through loadInstructions(). */
export class MarkdownSkillCatalog {
  private readonly directory: string;
  constructor(directory: string) { this.directory = path.resolve(directory); }

  async list(): Promise<ReadonlyArray<SkillMetadata>> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const skills: SkillMetadata[] = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!SKILL_ID.test(entry.name)) continue;
      const source = await readFile(path.join(this.directory, entry.name, "SKILL.md"), "utf8");
      skills.push(parseSkill(source, entry.name).metadata);
    }
    return skills;
  }

  listSync(): ReadonlyArray<SkillMetadata> {
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((candidate) => candidate.isDirectory() && SKILL_ID.test(candidate.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => parseSkill(readFileSync(path.join(this.directory, entry.name, "SKILL.md"), "utf8"), entry.name).metadata);
  }

  async loadInstructions(id: string): Promise<string> {
    if (!SKILL_ID.test(id)) throw new Error("Unknown skill");
    const source = await readFile(path.join(this.directory, id, "SKILL.md"), "utf8");
    const skill = parseSkill(source, id);
    return skill.instructions;
  }
}

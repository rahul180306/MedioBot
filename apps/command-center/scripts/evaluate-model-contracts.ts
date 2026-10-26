import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodyDecisionProvider } from "@mediobot-v2/cody";
import { MaestroDecisionProvider } from "@mediobot-v2/maestro";

type Agent = "maestro" | "cody";
interface Sample {
  readonly id: string;
  readonly agent: Agent;
  readonly provider: string;
  readonly model: string;
  readonly goal: string;
  readonly responses: ReadonlyArray<string>;
  /** Optional timings captured from an explicitly authorized, external run. Never inferred here. */
  readonly reportedLatencyMs?: ReadonlyArray<number>;
  /** These outcomes count only when accompanied by an execution-trace evidence reference. */
  readonly observedToolExecution?: boolean;
  readonly toolExecutionEvidenceRef?: string;
  readonly observedTaskCompleted?: boolean;
  readonly completionEvidenceRef?: string;
  readonly observedVerified?: boolean;
  readonly verificationEvidenceRef?: string;
}

const fixturePath = resolve(import.meta.dirname ?? ".", "../fixtures/model-contract-evaluation.jsonl");
const inputPath = process.argv[2] ? resolve(process.argv[2]) : fixturePath;
const controller = new AbortController();

function parseRows(text: string): Sample[] {
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const row = JSON.parse(line) as Sample;
    if (!row.id || !["maestro", "cody"].includes(row.agent) || !row.provider || !row.model
      || !row.goal || !Array.isArray(row.responses) || row.responses.length < 1 || row.responses.length > 3
      || row.responses.some(response => typeof response !== "string")) {
      throw new Error(`Invalid evaluation sample on line ${index + 1}`);
    }
    if (row.reportedLatencyMs && (row.reportedLatencyMs.length !== row.responses.length
      || row.reportedLatencyMs.some(ms => !Number.isFinite(ms) || ms < 0))) {
      throw new Error(`Invalid reportedLatencyMs on line ${index + 1}`);
    }
    return row;
  });
}

async function evaluate(sample: Sample) {
  let responseIndex = 0;
  let observedCalls = 0;
  const next = async () => {
    observedCalls++;
    return sample.responses[responseIndex++] ?? sample.responses.at(-1)!;
  };
  const started = performance.now();
  let actionType: string | undefined;
  let accepted = false;
  let errorCategory: string | undefined;

  try {
    if (sample.agent === "maestro") {
      const provider = new MaestroDecisionProvider({ complete: next });
      const decision = await provider.decide(sample.goal, {
        availableIntents: ["delegate", "delegate_text", "respond", "request_user_input"],
        assignableDefinitionIds: ["cody", "doc", "research", "tester"],
        availableMediobots: [
          { definitionId: "cody", name: "Cody", role: "coding", assignable: true,
            capabilities: ["filesystem.read", "filesystem.write", "terminal.execute", "agent.message"] },
          { definitionId: "doc", name: "Doc", role: "documentation", assignable: true,
            capabilities: ["web.search", "web.crawl", "agent.message"] },
          { definitionId: "research", name: "Research", role: "research", assignable: true,
            capabilities: ["web.search", "web.crawl", "agent.message"] },
          { definitionId: "tester", name: "Tester", role: "testing", assignable: true,
            capabilities: ["terminal.execute"] },
        ],
        capabilityMetadata: ["filesystem.read", "filesystem.write", "terminal.execute", "web.search", "web.crawl", "agent.message"]
          .map(name => ({ name })),
      }, controller.signal);
      actionType = decision.type;
      accepted = true;
    } else {
      const provider = new CodyDecisionProvider({ complete: next });
      const decision = await provider.decide(sample.goal, [], controller.signal);
      actionType = decision.type;
      accepted = true;
    }
  } catch (error) {
    errorCategory = error instanceof Error ? error.name : "UnknownError";
  }

  const reportedLatencyMs = sample.reportedLatencyMs?.slice(0, observedCalls);
  return {
    id: sample.id,
    agent: sample.agent,
    provider: sample.provider,
    model: sample.model,
    contractAccepted: accepted,
    acceptedAction: actionType ?? null,
    attemptsUsed: observedCalls,
    recovered: accepted && observedCalls > 1,
    reportedModelLatencyMs: reportedLatencyMs ? reportedLatencyMs.reduce((sum, value) => sum + value, 0) : null,
    timingSource: reportedLatencyMs ? "input-observation" : "not-provided",
    evaluatorRuntimeMs: Math.round(performance.now() - started),
    observedToolExecution: sample.toolExecutionEvidenceRef ? sample.observedToolExecution ?? null : null,
    toolExecutionEvidenceRef: sample.toolExecutionEvidenceRef ?? null,
    observedTaskCompleted: sample.completionEvidenceRef ? sample.observedTaskCompleted ?? null : null,
    completionEvidenceRef: sample.completionEvidenceRef ?? null,
    observedVerified: sample.verificationEvidenceRef ? sample.observedVerified ?? null : null,
    verificationEvidenceRef: sample.verificationEvidenceRef ?? null,
    errorCategory: errorCategory ?? null,
  };
}

const samples = parseRows(await readFile(inputPath, "utf8"));
const results = [];
for (const sample of samples) results.push(await evaluate(sample));

const grouped = new Map<string, typeof results>();
for (const result of results) {
  const key = `${result.agent}\t${result.provider}\t${result.model}`;
  grouped.set(key, [...(grouped.get(key) ?? []), result]);
}
const summary = [...grouped.entries()].map(([identity, entries]) => {
  const [agent, provider, model] = identity.split("\t");
  const completed = entries.filter(entry => entry.observedTaskCompleted !== null);
  const verified = entries.filter(entry => entry.observedVerified !== null);
  const executed = entries.filter(entry => entry.observedToolExecution !== null);
  return {
    agent, provider, model, samples: entries.length,
    contractAcceptanceRate: entries.filter(entry => entry.contractAccepted).length / entries.length,
    recoveryRate: entries.filter(entry => entry.recovered).length / entries.length,
    observedToolExecutionRate: executed.length ? executed.filter(entry => entry.observedToolExecution).length / executed.length : null,
    observedTaskCompletionRate: completed.length ? completed.filter(entry => entry.observedTaskCompleted).length / completed.length : null,
    observedVerificationRate: verified.length ? verified.filter(entry => entry.observedVerified).length / verified.length : null,
    modelLatencySamples: entries.filter(entry => entry.reportedModelLatencyMs !== null).length,
  };
});

process.stdout.write(`${JSON.stringify({ mode: "offline-contract-evaluation", inputPath, providerRequests: 0, summary, results }, null, 2)}\n`);

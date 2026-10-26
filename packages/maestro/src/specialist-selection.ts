import type { MediobotDefinitionId, TaskId } from "@mediobot-v2/domain";
import type { IntermediateArtifact, OrchestrationTaskSpec, ResourceGovernorStatus } from "@mediobot-v2/contracts";
import { isOrdinaryConversationGoal } from "./index.ts";

export interface SpecialistCandidate {
  readonly definitionId: MediobotDefinitionId;
  readonly name: string;
  readonly role: string;
  readonly description?: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly assignable: boolean;
}

export interface SelectionInput {
  readonly objective: string;
  readonly projectContext?: {
    readonly workspaceRoot?: string;
    readonly projectName?: string;
    readonly languages?: ReadonlyArray<string>;
    readonly frameworks?: ReadonlyArray<string>;
    readonly packageManager?: string | null;
    readonly filePaths?: ReadonlyArray<string>;
    readonly dependencies?: ReadonlyArray<string>;
  };
  readonly availableMediobots: ReadonlyArray<SpecialistCandidate>;
  readonly availableTools?: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
  readonly existingArtifacts?: ReadonlyArray<IntermediateArtifact>;
  readonly existingEvidence?: ReadonlyArray<{ readonly kind: string; readonly content: string }>;
  readonly resourceGovernorStatus?: ResourceGovernorStatus;
}

export interface SpecialistSelectionResult {
  readonly requiresSpecialist: boolean;
  readonly directIntent?: "respond" | "request_user_input";
  readonly reason: string;
  readonly tasks: ReadonlyArray<OrchestrationTaskSpec>;
  readonly explanation?: string;
}

export class DynamicSpecialistSelector {
  /**
   * Dynamically selects specialists based on objective, project context,
   * required capabilities, available tools, existing evidence, and resource constraints.
   */
  select(input: SelectionInput): SpecialistSelectionResult {
    const objective = input.objective.trim();

    // 1. Direct conversational greetings do not require any specialist
    const isGreetingOrChat =
      /^(hi|hello|hey|howdy|greetings|good\s+(morning|afternoon|evening))\b/i.test(objective.trim()) &&
      !/\b(implement|code|write|edit|refactor|test|research|doc|investigate|build|create|verify|benchmark)\b/i.test(objective);
    if (isGreetingOrChat) {
      return {
        requiresSpecialist: false,
        directIntent: "respond",
        reason: "Greeting or conversational query answered directly without specialist delegation.",
        tasks: [],
      };
    }

    const assignable = input.availableMediobots.filter((m) => m.assignable);
    if (assignable.length === 0) {
      return {
        requiresSpecialist: false,
        directIntent: "respond",
        reason: "No assignable specialists available in this environment.",
        tasks: [],
      };
    }

    const lowerObj = objective.toLowerCase();

    // Find candidate specialists by role or capabilities
    const findByRole = (role: string) => assignable.find((m) => m.role.toLowerCase() === role.toLowerCase());
    const findByCapability = (capPrefix: string) =>
      assignable.find((m) => m.capabilities.some((c) => c.toLowerCase().includes(capPrefix.toLowerCase())));

    const docSpecialist = findByRole("doc") ?? findByCapability("documentation") ?? findByCapability("api-reference");
    const researchSpecialist = findByRole("research") ?? findByCapability("tradeoff") ?? findByCapability("research");
    const codySpecialist = findByRole("coding") ?? findByCapability("workspace");
    const testerSpecialist = findByRole("tester") ?? findByCapability("verification");
    const scraapySpecialist = findByRole("scraapy") ?? findByCapability("component");

    const tasks: OrchestrationTaskSpec[] = [];

    // Analyze intent patterns:
    const needsDoc = Boolean(
      docSpecialist &&
        (/\b(doc|docs|documentation|api reference|api signature|official guide|spec|specification|syntax for|version matrix|breaking changes?)\b/i.test(lowerObj) ||
          /\b(how to use|api usage|options for|signature of)\b/i.test(lowerObj))
    );

    const needsResearch = Boolean(
      researchSpecialist &&
        (/\b(research|investigate|compare|tradeoff|trade-offs|alternatives|feasibility|best practices?|benchmarks?|approaches)\b/i.test(lowerObj) ||
          /\b(pros and cons|vs\b|versus)\b/i.test(lowerObj))
    );

    const needsCoding = Boolean(
      codySpecialist &&
        (/\b(implement|code|write|edit|refactor|fix|bug|create|build|modify|update file|add feature|patch)\b/i.test(lowerObj) ||
          /\b(component|function|class|module|service|handler|endpoint)\b/i.test(lowerObj))
    );

    const needsTesting = Boolean(
      testerSpecialist &&
        (/\b(run tests?|execute tests?|test suite|unit tests?|spec tests?|integration tests?|e2e|qa|regression tests?|verify implementation|write tests?)\b/i.test(lowerObj) ||
          (/\b(test|tests|regression|qa|assert)\b/i.test(lowerObj)) ||
          (/\b(verify|verification|validate|validation)\b/i.test(lowerObj) && !/\b(doc|documentation|spec|specs|syntax|api)\b/i.test(lowerObj)))
    );

    const needsScraapy = Boolean(
      scraapySpecialist &&
        (/\b(scraapy|ui component|animation reference|design asset|extract component|lucide|shadcn|framer-motion|aceternity)\b/i.test(lowerObj))
    );

    // If an explicit prerequisite is detected (e.g., "first check the docs, then implement"):
    const explicitSequential = /\b(first|before|then|afterwards|prerequisite)\b/i.test(lowerObj);

    let docTaskId: TaskId | undefined;
    let researchTaskId: TaskId | undefined;
    let codyTaskId: TaskId | undefined;

    // 1. Doc specialist task
    if (needsDoc && docSpecialist) {
      docTaskId = `task-doc-${globalThis.crypto.randomUUID().slice(0, 8)}` as TaskId;
      tasks.push({
        id: docTaskId,
        definitionId: docSpecialist.definitionId,
        objective: `Retrieve and verify authoritative documentation and API signatures for: ${objective}`,
        priority: "interactive",
        relevantContext: objective,
        expectedOutcome: "Verified official API reference and usage guidelines with version constraints.",
        evidenceExpectations: ["official-doc-reference", "api-signature"],
      });
    }

    // 2. Research specialist task
    if (needsResearch && researchSpecialist) {
      researchTaskId = `task-res-${globalThis.crypto.randomUUID().slice(0, 8)}` as TaskId;
      tasks.push({
        id: researchTaskId,
        definitionId: researchSpecialist.definitionId,
        objective: `Investigate technical approaches, tradeoffs, and evidence for: ${objective}`,
        priority: "interactive",
        relevantContext: objective,
        expectedOutcome: "Structured analysis of technical tradeoffs with evidence backing.",
        evidenceExpectations: ["technical-tradeoffs", "evidence-backed-recommendation"],
      });
    }

    // 3. Scraapy specialist task
    if (needsScraapy && scraapySpecialist) {
      const scraapyTaskId = `task-scr-${globalThis.crypto.randomUUID().slice(0, 8)}` as TaskId;
      tasks.push({
        id: scraapyTaskId,
        definitionId: scraapySpecialist.definitionId,
        objective: `Discover and extract UI components and reference implementations for: ${objective}`,
        priority: "interactive",
        relevantContext: objective,
        expectedOutcome: "Clean, licensed UI components and style references.",
      });
    }

    // 4. Coding specialist task (Cody)
    if (needsCoding && codySpecialist) {
      codyTaskId = `task-cod-${globalThis.crypto.randomUUID().slice(0, 8)}` as TaskId;
      // If doc was needed and explicitly sequential, Cody depends on Doc
      const dependencies: TaskId[] = [];
      if (docTaskId && (explicitSequential || /\b(according to docs?|using the api|per documentation)\b/i.test(lowerObj))) {
        dependencies.push(docTaskId);
      }
      tasks.push({
        id: codyTaskId,
        definitionId: codySpecialist.definitionId,
        objective: `Implement requested technical solution: ${objective}`,
        dependencies,
        priority: "interactive",
        relevantContext: objective,
        expectedOutcome: "Verified workspace code implementation matching project requirements.",
        evidenceExpectations: ["workspace-file", "coding-verification"],
      });
    }

    // 5. Testing specialist task (Tester)
    if (needsTesting && testerSpecialist) {
      const testerTaskId = `task-tst-${globalThis.crypto.randomUUID().slice(0, 8)}` as TaskId;
      const dependencies: TaskId[] = [];
      if (codyTaskId) {
        dependencies.push(codyTaskId);
      }
      tasks.push({
        id: testerTaskId,
        definitionId: testerSpecialist.definitionId,
        objective: `Independently verify implementation and run test suite for: ${objective}`,
        dependencies,
        priority: "background",
        relevantContext: objective,
        expectedOutcome: "Independent verification of task requirements and passing test suite.",
        evidenceExpectations: ["verification-report"],
      });
    }

    // Fallback: If no specific keywords matched but workspace action is needed and Cody is available:
    if (tasks.length === 0) {
      if (codySpecialist && input.projectContext?.workspaceRoot) {
        tasks.push({
          id: `task-cod-${globalThis.crypto.randomUUID().slice(0, 8)}` as TaskId,
          definitionId: codySpecialist.definitionId,
          objective,
          priority: "interactive",
          relevantContext: objective,
          expectedOutcome: "Analyze and address the user request within the workspace.",
        });
      } else if (researchSpecialist) {
        tasks.push({
          id: `task-res-${globalThis.crypto.randomUUID().slice(0, 8)}` as TaskId,
          definitionId: researchSpecialist.definitionId,
          objective,
          priority: "interactive",
          relevantContext: objective,
          expectedOutcome: "Technical analysis of the request.",
        });
      } else {
        // Direct answer fallback
        return {
          requiresSpecialist: false,
          directIntent: "respond",
          reason: "Request does not require specialist tools or delegation.",
          tasks: [],
        };
      }
    }

    return {
      requiresSpecialist: true,
      reason: `Dynamically selected ${tasks.length} specialist(s) based on required capabilities and dependencies.`,
      tasks,
      explanation: `Selected ${tasks.map((t) => t.id).join(", ")} based on objective capabilities.`,
    };
  }
}

import type { ThreadModelSelection } from "../types";

export interface AgentModelPreferenceValue {
  readonly modelKey: string;
  readonly effort?: string;
  readonly modelSelection?: ThreadModelSelection;
}

export function resolveTurnModelSelection(
  explicitSelection: ThreadModelSelection | undefined,
  threadSelection: ThreadModelSelection | undefined,
  specialistId: string | undefined,
  preferences: Readonly<Record<string, AgentModelPreferenceValue>>,
): ThreadModelSelection | undefined {
  if (explicitSelection) return explicitSelection;
  if (specialistId) return preferences[specialistId]?.modelSelection;
  return threadSelection;
}

/** Resolve UI preferences to provider-qualified selections without guessing between duplicate model names. */
export function buildAssignmentModelSelections(
  preferences: Readonly<Record<string, AgentModelPreferenceValue>>,
  specialists: ReadonlyArray<string | { readonly preferenceId: string; readonly definitionId: string }>,
): Record<string, ThreadModelSelection> {
  const selections: Record<string, ThreadModelSelection> = {};
  for (const specialist of specialists) {
    const preferenceId = typeof specialist === "string" ? specialist : specialist.preferenceId;
    const definitionId = typeof specialist === "string" ? specialist : specialist.definitionId;
    const preference = preferences[preferenceId];
    if (!preference?.modelSelection) continue;
    const exact = preference.modelSelection;
    if (!exact.providerConnectionId.trim() || !exact.modelId.trim()) continue;
    // Keep an explicit stale selection visible to the backend so it can fail closed.
    // Never infer a specialist's model from a label/default or silently substitute the thread model.
    const rawEffort = (preference.effort || exact.reasoningEffort)?.toLowerCase();
    const validEffort = rawEffort && ["low", "medium", "high", "extra", "max"].includes(rawEffort)
      ? (rawEffort as "low" | "medium" | "high" | "extra" | "max")
      : undefined;
    selections[definitionId] = {
      providerConnectionId: exact.providerConnectionId,
      modelId: exact.modelId,
      ...(validEffort ? { reasoningEffort: validEffort } : {}),
    };
  }
  return selections;
}

export const USE_PROJECT_INTELLIGENCE_DEFAULT = false;

export function isProjectIntelligenceEnabled(): boolean {
  if (typeof process === "undefined" || !process.env) {
    return USE_PROJECT_INTELLIGENCE_DEFAULT;
  }
  const val = process.env.USE_PROJECT_INTELLIGENCE;
  if (!val) return USE_PROJECT_INTELLIGENCE_DEFAULT;
  return val.toLowerCase() === "true" || val === "1";
}

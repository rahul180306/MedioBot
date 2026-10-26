export type AssignmentRunStatus = "completed" | "yielded" | "blocked" | "failed" | "cancelled";

/** Fail closed when an executor returns no parseable, recognized outcome. */
export function statusFromAssignmentReports(result: string): AssignmentRunStatus {
  const statuses = result.split("\n").flatMap(line => {
    try {
      const payload = line.replace(/^bounded-(?:web-)?worker-reports:\s*/, "");
      const value = JSON.parse(payload) as { status?: unknown } | ReadonlyArray<{ status?: unknown }>;
      return Array.isArray(value) ? value.map(report => report.status) : [(value as { status?: unknown }).status];
    } catch { return []; }
  });
  if (statuses.length === 0 || statuses.some(status => !["completed", "yielded", "blocked", "failed", "cancelled", "model-unavailable"].includes(String(status)))) {
    return "failed";
  }
  if (statuses.includes("cancelled")) return "cancelled";
  if (statuses.includes("failed") || statuses.includes("model-unavailable")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.every(status => status === "yielded")) return "yielded";
  return "completed";
}

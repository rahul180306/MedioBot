import type { WorldEvent } from "@mediobot-v2/domain";

export type FailureCategory = "model" | "tool" | "environment" | "resource" | "coordination" | "verification" | "worker";
export type SupervisionNotice = { readonly event: WorldEvent } & (
  | { readonly disposition: "record"; readonly priority: "normal" }
  | { readonly disposition: "accumulate"; readonly priority: "normal"; readonly category?: FailureCategory }
  | { readonly disposition: "wake"; readonly priority: "failure"; readonly category: FailureCategory }
  | { readonly disposition: "wake"; readonly priority: "user"; readonly reason: "cancellation" }
);

const failures: Readonly<Record<string, FailureCategory>> = {
  "tool.escalated": "tool",
  "model.failed": "model", "environment.failed": "environment", "resource.failed": "resource",
  "coordination.failed": "coordination", "verification.failed": "verification",
  "worker.failed": "worker", "task.failed": "worker", "vision.failed": "worker",
};

/** Explicit facts only: unknown events are recorded, never inferred into failures or retries. */
export function projectSupervision(event: WorldEvent): SupervisionNotice {
  event = { ...event };
  if (event.type === "task.cancel-requested" || event.type === "task.cancelled") {
    return { event, disposition: "wake", priority: "user", reason: "cancellation" };
  }
  // Tool failures can be handled by the worker. Only its escalation wakes supervision.
  if (event.type === "tool.failed") return { event, disposition: "accumulate", priority: "normal", category: "tool" };
  const category = Object.hasOwn(failures, event.type) ? failures[event.type] : undefined;
  if (category) return { event, disposition: "wake", priority: "failure", category };
  if (event.type === "worker.progress") return { event, disposition: "accumulate", priority: "normal" };
  return { event, disposition: "record", priority: "normal" };
}

/** FIFO notification window, not task state. Evicted identities may notify again. */
export class NotificationWindow {
  private readonly keys = new Set<string>();
  static readonly capacity = 256;
  get size(): number { return this.keys.size; }
  accept(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > NotificationWindow.capacity) this.keys.delete(this.keys.values().next().value!);
    return true;
  }
}

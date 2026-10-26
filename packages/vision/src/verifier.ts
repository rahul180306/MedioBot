import type { GoalVerifier } from "./index.ts";

export type BrowserOutcomePredicate =
  | { readonly kind: "url"; readonly equals: string }
  | { readonly kind: "text"; readonly includes: string }
  | { readonly kind: "element"; readonly selector: string; readonly property: "value" | "text"; readonly equals: string }
  | { readonly kind: "element"; readonly selector: string; readonly property: "visible" | "enabled" | "checked"; readonly equals: boolean };
export interface BrowserOutcomeReader {
  readOutcome(predicates: ReadonlyArray<BrowserOutcomePredicate>, signal: AbortSignal): Promise<boolean>;
}
export interface BrowserOutcomePolicy {
  readonly all: ReadonlyArray<BrowserOutcomePredicate>;
  readonly timeoutMs?: number;
}

/** Trusted composition input only. Never accept this policy from a decision/finish response. */
export function createBrowserOutcomeVerifier(reader: BrowserOutcomeReader, policy: BrowserOutcomePolicy): GoalVerifier {
  const predicates = structuredClone(policy.all);
  const timeoutMs = policy.timeoutMs ?? 1000;
  if (!Array.isArray(predicates) || predicates.length < 1 || predicates.length > 24
    || !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000) throw new Error("Invalid browser outcome policy");
  for (const p of predicates) {
    const keys = Object.keys(p).sort().join();
    if (p.kind === "url" || p.kind === "text") {
      const value = p.kind === "url" ? p.equals : p.includes;
      if (keys !== (p.kind === "url" ? "equals,kind" : "includes,kind") || typeof value !== "string"
        || !value || value.length > 2000) throw new Error("Invalid browser outcome predicate");
    } else if (p.kind !== "element" || keys !== "equals,kind,property,selector" || typeof p.selector !== "string"
      || !p.selector || p.selector.length > 500 || !["value", "text", "visible", "enabled", "checked"].includes(p.property)
      || (["value", "text"].includes(p.property) ? typeof p.equals !== "string" || p.equals.length > 2000
        : typeof p.equals !== "boolean")) throw new Error("Invalid browser outcome predicate");
    Object.freeze(p);
  }
  Object.freeze(predicates);
  return { async verify({ signal }) {
    const end = performance.now() + timeoutMs;
    let matched = false;
    do {
      signal.throwIfAborted();
      try {
        const current = await reader.readOutcome(predicates, signal);
        // Two consecutive independent samples reject transient success banners/state.
        if (current && matched) return "verified";
        matched = current;
      } catch { signal.throwIfAborted(); return "unknown"; }
      if (performance.now() >= end) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, end - performance.now()))));
    } while (true);
    signal.throwIfAborted();
    return "not-verified";
  } };
}

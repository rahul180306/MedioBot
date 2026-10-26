import type { Page } from "playwright";
import type { GoalVerifier, PlaywrightBrowserPage } from "../../src/index.ts";

/** Test-only seam, shared with the browser integration tests. Never expose oracle data to decisions. */
export function fixturePage(browser: PlaywrightBrowserPage): Page {
  return (browser as unknown as { page: Page }).page;
}

/** An explicit environment predicate, not a natural-language goal router. */
export function environmentVerifier(check: (signal: AbortSignal) => Promise<boolean>): GoalVerifier {
  return { async verify({ signal }) {
    if (signal.aborted) return "unknown";
    try {
      const verified = await check(signal);
      return signal.aborted ? "unknown" : verified ? "verified" : "not-verified";
    } catch { return "unknown"; }
  } };
}

export type BenchmarkGoal = "1" | "2" | "3";
export const benchmarkGoals: Record<BenchmarkGoal, string> = {
  "1": "Open the Cedar record and tell me its owner.",
  "2": "Change the Nimbus record's status from queued to ready and save it.",
  "3": "Attempt to archive the Juniper record. Inspect the confirmation, proceed only if it names Juniper, then verify it is shown as archived.",
};

interface Snapshot {
  records: { id: string; name: string; owner: string; status: string }[];
  confirmations: { id: string; description: string }[];
}

// Reads the fixture's committed application data, not input values, notices, or model claims.
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate("({ records: records.map(({id, name, owner, status}) => ({id, name, owner, status})), confirmations: archiveConfirmations.slice() })");
}

export async function benchmarkVerifier(page: Page, url: string, goal: BenchmarkGoal): Promise<GoalVerifier> {
  const initial = await snapshot(page);
  const name = goal === "1" ? "Cedar" : goal === "2" ? "Nimbus" : "Juniper";
  const target = initial.records.find((record) => record.name === name);
  if (!target) throw new Error("Acceptance fixture is missing its target record");
  return environmentVerifier(async () => {
    if (page.url() !== url || page.isClosed()) return false;
    const current = await snapshot(page);
    const expectedStatus = goal === "1" ? target.status : goal === "2" ? "ready" : "archived";
    if (current.records.length !== initial.records.length || !initial.records.every((before) => {
      const after = current.records.find((record) => record.id === before.id);
      return after?.name === before.name && after.owner === before.owner
        && after.status === (before.id === target.id ? expectedStatus : before.status);
    })) return false;
    if (await page.locator("dialog[open]").count()) return false;
    if (goal === "3" && (current.confirmations.length !== 1
      || current.confirmations[0]?.id !== target.id
      || !current.confirmations[0].description.includes(`"${target.name}"`))) return false;
    if (goal !== "3" && current.confirmations.length !== 0) return false;
    const detail = page.locator(".detail-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
    if (goal === "1") {
      const owner = detail.locator(".detail-grid > div").filter({ has: page.getByText("Owner", { exact: true }) });
      return await detail.isVisible() && await owner.locator(".field-value").innerText() === target.owner;
    }
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) });
    const status = (await detail.isVisible() ? detail : row).locator(".status");
    return await status.isVisible() && (await status.innerText()).toLowerCase() === expectedStatus;
  });
}

import assert from "node:assert/strict";
import { after, before, afterEach, beforeEach, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { buildBenchmarkHtml, startBenchmarkServer } from "./fixtures/benchmark-app.ts";

describe("local records benchmark application", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => { await browser?.close(); });
  beforeEach(async () => { page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(4000); });
  afterEach(async () => { await page?.close(); });

  it("presents a records application with multiple records and naturally repeated action names", async () => {
    await page.setContent(buildBenchmarkHtml());
    assert.equal(await page.getByRole("heading", { name: "Records", exact: true }).count(), 1);
    assert.equal(await page.getByRole("row").count(), 5);
    assert.equal(await page.getByRole("link", { name: "View record" }).count(), 4);
    assert.equal(await page.getByRole("button", { name: "Edit record" }).count(), 4);
    assert.equal(await page.getByRole("button", { name: "Archive record" }).count(), 4);
    assert.equal(await page.locator("#records-table").getByText("Owner:").count(), 0);
  });

  it("opens a record detail view that presents its owner and normal record metadata", async () => {
    await page.setContent(buildBenchmarkHtml());
    const row = page.getByRole("row").filter({ hasText: "Cedar" });
    await row.getByRole("link", { name: "View record" }).click();
    await page.getByRole("heading", { name: "Cedar", exact: true }).waitFor();
    await page.getByText("Owner", { exact: true }).waitFor();
    await page.getByText("Research", { exact: true }).waitFor();
    await page.getByText("Record ID", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Back to records" }).click();
    await page.getByRole("table", { name: "Workspace records" }).waitFor();
  });

  it("supports search, an editable status form, delayed save, and visible confirmation", async () => {
    await page.setContent(buildBenchmarkHtml());
    await page.getByRole("searchbox", { name: "Search records" }).fill("Nimbus");
    assert.equal(await page.getByRole("row").count(), 2);
    const row = page.getByRole("row").filter({ hasText: "Nimbus" });
    await row.getByRole("button", { name: "Edit record" }).click();
    await page.getByRole("heading", { name: "Edit record", exact: true }).waitFor();
    await page.getByLabel("Status").selectOption("ready");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("button", { name: "Saving changes", exact: true }).waitFor();
    await page.getByRole("status").getByText("Nimbus was updated").waitFor();
    await page.getByRole("table", { name: "Workspace records" }).waitFor();
    assert.equal(await page.getByRole("row").filter({ hasText: "Nimbus" }).getByText("Ready").count(), 1);
  });

  it("requires a named archive confirmation and then updates the visible record state", async () => {
    await page.setContent(buildBenchmarkHtml());
    const row = page.getByRole("row").filter({ hasText: "Juniper" });
    await row.getByRole("button", { name: "Archive record" }).click();
    const dialog = page.getByRole("dialog", { name: "Archive record?" });
    await dialog.getByText(/Juniper/).waitFor();
    await dialog.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByRole("status").getByText("Juniper was archived").waitFor();
    assert.equal(await page.getByRole("row").filter({ hasText: "Juniper" }).getByText("Archived").count(), 1);
  });

  it("serves the same app used by the manual runner from an ephemeral local port", async () => {
    const server = await startBenchmarkServer();
    try {
      const response = await fetch(server.url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Workspace records/);
    } finally { await server.close(); }
  });
});

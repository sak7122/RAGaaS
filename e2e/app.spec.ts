import { test, expect } from "@playwright/test";

// Runs against the demo build (VITE_DEMO_MODE) — fake in-browser backend.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("loads shell: nav, sidebar stats, seeded documents", async ({ page }) => {
  await expect(page.getByText("RAGaaS").first()).toBeVisible();
  await expect(page.getByText("Acme Corp").first()).toBeVisible();
  // Sidebar usage + docs
  await expect(page.getByText("queries today")).toBeVisible();
  await expect(page.getByText("Q3_Earnings_Report.pdf")).toBeVisible();
  await expect(page.getByText("Employee_Handbook.pdf")).toBeVisible();
});

test("empty state shows suggestion chips", async ({ page }) => {
  await expect(
    page.getByRole("heading", { name: /Ask anything about your documents/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /How many PTO days/i }),
  ).toBeVisible();
});

test("chat round-trip: answer, retrieval trace, scored citations", async ({ page }) => {
  const input = page.getByRole("textbox", { name: /Ask a question/i });
  await input.fill("How many PTO days do employees get?");
  await input.press("Enter");

  // User message echoed
  await expect(
    page.getByText("How many PTO days do employees get?").last(),
  ).toBeVisible();

  // Assistant answer arrives
  await expect(page.getByText(/Based on your documents/i)).toBeVisible();

  // Retrieval trace toggle shows the engine + latency + chunk count
  const trace = page.getByRole("button", { name: /Hybrid Vector Search/i });
  await expect(trace).toBeVisible();
  await expect(trace).toContainText(/ms/);
  await expect(trace).toContainText(/chunks/);

  // Expand it → pipeline steps + query-term chips
  await trace.click();
  await expect(page.getByText("Embed query")).toBeVisible();
  await expect(page.getByText(/chunks scanned/)).toBeVisible();
  await expect(page.getByText("Rank candidates")).toBeVisible();
  await expect(page.getByText("Select top-k")).toBeVisible();
  await expect(page.getByText("pto", { exact: true })).toBeVisible();

  // Citations with relevance percentages (scoped to the score badge to avoid
  // colliding with the "best 92%" text inside the trace step)
  await expect(page.getByText("Sources")).toBeVisible();
  await expect(page.locator(".citation-score-num").first()).toHaveText("92%");
});

test("suggestion chip submits a query", async ({ page }) => {
  await page.getByRole("button", { name: /What is the minimum password length/i }).click();
  await expect(page.getByText(/Based on your documents/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Hybrid Vector Search/i })).toBeVisible();
});

test("insights dashboard shows gaps + top questions", async ({ page }) => {
  await page.getByRole("button", { name: "Insights", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Knowledge Insights" })).toBeVisible();
  // Stat cards
  await expect(page.getByText("Questions asked")).toBeVisible();
  await expect(page.getByText("Avg confidence")).toBeVisible();
  // Knowledge gaps section + a flagged gap
  await expect(page.getByText("Knowledge gaps")).toBeVisible();
  await expect(page.getByText("What is the refund policy?").first()).toBeVisible();
  await expect(page.getByText(/asked 23×/)).toBeVisible();
  // Top questions section
  await expect(page.getByText("Top questions")).toBeVisible();
});

test("quota counter increments after a query", async ({ page }) => {
  const usage = page.getByText(/\/ 1,000 queries today/);
  await expect(usage).toContainText("42 / 1,000");
  await page.getByRole("button", { name: /How many PTO days/i }).click();
  await expect(page.getByText(/\/ 1,000 queries today/)).toContainText("43 / 1,000");
});

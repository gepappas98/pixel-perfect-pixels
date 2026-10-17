import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/audit-report.functions", () => ({
  listAuditReports: vi.fn(),
  refreshAuditSnapshot: vi.fn(),
  saveAuditSnapshot: vi.fn(),
}));

import { AuditReportView } from "@/components/trading/AuditReportPanel";
import { isAuditStale, groupFindings, type AuditReport } from "@/lib/audit-report";

const NOW = Date.parse("2026-10-17T16:00:00Z");
const base: AuditReport = {
  id: "a",
  checked_at: "2026-10-17T15:32:00Z",
  title: "Latest audit",
  severity: "warning",
  status: "historical_snapshot",
  summary: "sum",
  findings: [
    { category: "confirmed_bug", title: "Bug A", detail: "d" },
    { category: "research_comparability", title: "Cmp B", detail: "d" },
    { category: "needs_recheck", title: "Re C", detail: "d" },
  ],
  source: "test",
  window_label: null,
};
const html = (p: Partial<Parameters<typeof AuditReportView>[0]>) =>
  renderToStaticMarkup(createElement(AuditReportView, { loading: false, error: null, reports: [], draft: null, now: NOW, ...p }));

describe("audit report helpers", () => {
  it("staleness after 24h", () => {
    expect(isAuditStale("2026-10-17T15:32:00Z", NOW)).toBe(false);
    expect(isAuditStale("2026-10-16T15:00:00Z", NOW)).toBe(true);
  });
  it("groups categories separately", () => {
    expect(groupFindings(base.findings).map((g) => g.category)).toEqual([
      "confirmed_bug", "research_comparability", "needs_recheck",
    ]);
  });
});

describe("AuditReportView states", () => {
  it("loading", () => expect(html({ loading: true })).toContain("Loading audits"));
  it("empty", () => expect(html({})).toContain("No audit reports saved yet"));
  it("error", () => {
    const h = html({ error: "boom" });
    expect(h).toContain("Audit error: boom");
    expect(h).not.toContain("No audit reports saved yet");
  });
  it("latest first, history, separated categories, timestamp", () => {
    const old = { ...base, id: "b", title: "Older audit", checked_at: "2026-10-10T00:00:00Z" };
    const h = html({ reports: [base, old] });
    expect(h.indexOf("Latest audit")).toBeLessThan(h.indexOf("Older audit"));
    expect(h).toContain("Audit history (1)");
    expect(h).toContain("Confirmed bugs");
    expect(h).toContain("Research comparability issues");
    expect(h).toContain("Needs re-check");
    expect(h).toContain("2026-10-17 15:32:00 UTC");
    expect(h).toContain("STALE");
  });
  it("save disabled without a refreshed draft", () => {
    expect(html({ reports: [base] })).toMatch(/disabled=""[^>]*>Save snapshot/);
  });
});

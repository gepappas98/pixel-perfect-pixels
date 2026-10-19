import { describe, it, expect } from "vitest";
import { archiveReady, cohortOf, dedupeCases, eligibleEntryEvidence, isEvaluated, validateFinding, type ResearchCase, type Evidence, type Finding } from "../research-knowledge";
const now = "2026-10-19T22:00:00Z";
const entry = "2026-10-18T00:00:00Z";
const evidence: Evidence = { id: "e", source_table: "indicator_snapshots", source_id: "s", observed_at: entry, available_at: entry, captured_at: now, fingerprint: "f", role: "entry_context", summary: "bullish 1h" };
const c: ResearchCase = { id: "c", source_table: "strategy_variant_signals", source_id: "s", symbol: "INJ", strategy: "test", cohort: "V3", scorer_version: "v3-test", fingerprint: "v3|f", entry_at: entry, resolved_at: "2026-10-18T01:00:00Z", maturity_at: "2026-10-19T00:00:00Z", outcome: "win", net_pnl: 5, pnl_unit: "percent", close_reason: "TP", regime: "bear", evidence_ids: ["e"] };
const f: Finding = { id: "f", title: "Hypothesis", statement: "Observed result", status: "validated", confidence: 0.2, cohort: "V3", scorer_version: "v3-test", sample_size: 1, evidence_ids: ["e"], case_ids: ["c"], checked_at: now, limitations: "Small sample", reproduction: "Read case c and source s as of entry" };
describe("research temporal eligibility", () => {
  it("accepts entry-time evidence even when archived later", () => expect(eligibleEntryEvidence(evidence, entry)).toBe(true));
  it("rejects post-entry observations", () => expect(eligibleEntryEvidence({ ...evidence, observed_at: now, available_at: now }, entry)).toBe(false));
  it("rejects late publication despite earlier observation", () => expect(eligibleEntryEvidence({ ...evidence, available_at: now }, entry)).toBe(false));
  it("rejects unknown availability", () => expect(eligibleEntryEvidence({ ...evidence, available_at: null }, entry)).toBe(false));
  it("never uses outcome response as entry context", () => expect(eligibleEntryEvidence({ ...evidence, role: "outcome" }, entry)).toBe(false));
});
describe("outcomes and cohort isolation", () => {
  it("keeps V2 and V3 distinct", () => expect([cohortOf("v2|a"), cohortOf("v3|a"), cohortOf("old"), cohortOf(null)]).toEqual(["V2", "V3", "Legacy", "Unknown"]));
  it("open V3 is never resolved", () => expect(isEvaluated({ ...c, outcome: "open" }, now)).toBe(false));
  it("unmatured V3 is never evaluated", () => expect(isEvaluated({ ...c, maturity_at: "2026-10-20T00:00:00Z" }, now)).toBe(false));
  it("missing V3 maturity is not inferred", () => expect(isEvaluated({ ...c, maturity_at: null }, now)).toBe(false));
  it("requires finite terminal net PnL", () => expect(isEvaluated({ ...c, net_pnl: null }, now)).toBe(false));
  it("does not resolve future or pre-entry outcomes", () => { expect(isEvaluated({ ...c, resolved_at: "2026-10-20T00:00:00Z" }, now)).toBe(false); expect(isEvaluated({ ...c, resolved_at: "2026-10-17T00:00:00Z" }, now)).toBe(false); });
  it("deduplicates identity but preserves version and cohort", () => expect(dedupeCases([c, c, { ...c, cohort: "V2" }, { ...c, scorer_version: "other" }])).toHaveLength(3));
});
describe("finding validation", () => {
  it("accepts fully referenced reproducible finding", () => expect(validateFinding(f, [c], [evidence], now)).toEqual([]));
  it("rejects mixed cohorts", () => expect(validateFinding(f, [{ ...c, cohort: "V2" }], [evidence], now)).toContain("cohort_or_version_mismatch"));
  it("rejects fabricated samples", () => expect(validateFinding({ ...f, sample_size: 29 }, [c], [evidence], now)).toContain("sample_mismatch"));
  it("rejects unsupported claims", () => expect(validateFinding(f, [c], [], now)).toContain("missing_evidence"));
  it("requires reproduction and limitations", () => expect(validateFinding({ ...f, reproduction: "", limitations: "" }, [c], [evidence], now)).toContain("missing_reproducibility"));
  it("does not validate pending results", () => expect(validateFinding(f, [{ ...c, outcome: "open" }], [evidence], now)).toContain("unresolved_cases"));
});
describe("archival fail-closed contract", () => {
  const required = [{ source_id: "s", fingerprint: "f" }];
  it("blocks capture failure even with prior receipt", () => expect(archiveReady(required, required, false)).toBe(false));
  it("blocks incomplete capture", () => expect(archiveReady(required, [], true)).toBe(false));
  it("blocks stale fingerprint receipt", () => expect(archiveReady(required, [{ source_id: "s", fingerprint: "old" }], true)).toBe(false));
  it("accepts exactly matching evidence receipts", () => expect(archiveReady(required, required, true)).toBe(true));
});
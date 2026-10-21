import { describe, expect, it } from "vitest";
import { chronologyIsValid, dedupeSymbolCycles, feeAwareNetPnl, outcomeMetrics, wilsonInterval, type V3OutcomeRow } from "../v3-statistical-validation";

const row = (overrides: Partial<V3OutcomeRow> = {}): V3OutcomeRow => ({
  id: "1", strategy_name: "whale-focused", symbol: "BTC", created_at: "2026-10-19T10:00:00Z",
  resolved_at: "2026-10-19T12:00:00Z", outcome: "win", pnl_pct: 4,
  source_fingerprint: "v3|whale-focused|BTC|123", ...overrides,
});

describe("V3 statistical validation", () => {
  it("deduplicates shared symbol-cycle rows across strategies", () => {
    const result = dedupeSymbolCycles([row(), row({ id: "2", strategy_name: "balanced" })]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.rawRows).toBe(2);
    expect(result.units[0]?.strategies).toEqual(["balanced", "whale-focused"]);
  });
  it("excludes conflicting outcomes for the same symbol-cycle", () => {
    const result = dedupeSymbolCycles([row(), row({ id: "2", outcome: "loss", pnl_pct: -3 })]);
    expect(result.units).toHaveLength(0);
    expect(result.conflictingUnits).toBe(1);
  });
  it("calculates Wilson interval for 5/10 around the expected 23.6%–76.4%", () => {
    const interval = wilsonInterval(5, 10);
    expect(interval?.low ?? NaN).toBeCloseTo(23.6, 0);
    expect(interval?.high ?? NaN).toBeCloseTo(76.4, 0);
  });
  it("returns null interval and safe metrics for empty data", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(outcomeMetrics([])).toMatchObject({ n: 0, wins: 0, losses: 0, winRatePct: null, meanPnlPct: null, medianPnlPct: null });
  });
  it("returns unavailable net PnL when fees are missing", () => {
    expect(feeAwareNetPnl(100, null)).toBeNull();
    expect(feeAwareNetPnl(100, 2)).toBe(98);
  });
  it("rejects future or unknown feature timestamps", () => {
    expect(chronologyIsValid("2026-10-19T10:00:00Z", "2026-10-19T10:00:00Z")).toBe(true);
    expect(chronologyIsValid("2026-10-19T10:00:00Z", "2026-10-19T10:00:01Z")).toBe(false);
    expect(chronologyIsValid("2026-10-19T10:00:00Z", null)).toBe(false);
  });
  it("rejects invalid cycle fingerprints and mismatched symbols", () => {
    const result = dedupeSymbolCycles([row({ source_fingerprint: "v3|x|ETH|123" })]);
    expect(result.units).toHaveLength(0);
    expect(result.invalidRows).toBe(1);
  });
});

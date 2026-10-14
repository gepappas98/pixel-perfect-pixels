import { describe, expect, it } from "vitest";
import {
  aggregateWhaleShocks,
  DEFAULT_WHALE_SHOCK_CONFIG,
  evaluate1hTechnicalConfirmation,
  evaluateRegimeShockTransition,
  getAssetTier,
  getRequiredVolumeFloor,
  WHALE_SHOCK_EXCLUDED_MAJORS,
} from "./whale-shock.ts";

describe("Whale Shock aggregation", () => {
  it("classifies expanded mid-caps at $50,000 and dynamic altcoins at $30,000", () => {
    for (const symbol of ["INJ", "TAO", "PENDLE", "AERO", "ADA", "XRP"]) {
      expect(getAssetTier(symbol)).toBe("mid_cap");
      expect(getRequiredVolumeFloor(symbol)).toBe(50_000);
    }
    for (const symbol of ["PENGU", "BERA", "CUSTOMCOIN"]) {
      expect(getAssetTier(symbol)).toBe("altcoin");
      expect(getRequiredVolumeFloor(symbol)).toBe(30_000);
    }
  });
  it("qualifies an unlisted dynamic altcoin at $30k with 3 accumulation alerts", () => {
    const candidates = aggregateWhaleShocks([
      { symbol: "PENGU", direction: "accumulation", usd_value: 12_000 },
      { symbol: "PENGU", direction: "accumulation", usd_value: 10_000 },
      { symbol: "PENGU", direction: "accumulation", usd_value: 10_000 },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      symbol: "PENGU", assetTier: "altcoin", requiredFloorUsd: 30_000,
      buyUsd: 32_000, alertCount: 3,
    });
  });
  it("exposes only BTC, ETH and SOL as excluded majors", () => {
    expect([...WHALE_SHOCK_EXCLUDED_MAJORS].sort()).toEqual(["BTC", "ETH", "SOL"]);
  });
  it("excludes majors (BTC/ETH/SOL) even with huge accumulation", () => {
    const majors = [
      { symbol: "BTC", direction: "accumulation", usd_value: 500_000 },
      { symbol: "BTC", direction: "accumulation", usd_value: 500_000 },
      { symbol: "BTC", direction: "accumulation", usd_value: 500_000 },
      { symbol: "ETH", direction: "accumulation", usd_value: 300_000 },
      { symbol: "ETH", direction: "accumulation", usd_value: 300_000 },
      { symbol: "ETH", direction: "accumulation", usd_value: 300_000 },
      { symbol: "SOL", direction: "accumulation", usd_value: 100_000 },
      { symbol: "SOL", direction: "accumulation", usd_value: 100_000 },
      { symbol: "SOL", direction: "accumulation", usd_value: 100_000 },
    ];
    expect(aggregateWhaleShocks(majors)).toHaveLength(0);
  });
  it("dynamically qualifies an unknown altcoin above the default floor", () => {
    const candidates = aggregateWhaleShocks([
      { symbol: "PENDLE", direction: "accumulation", usd_value: 20_000 },
      { symbol: "PENDLE", direction: "accumulation", usd_value: 18_000 },
      { symbol: "PENDLE", direction: "accumulation", usd_value: 15_000 },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ symbol: "PENDLE", assetTier: "mid_cap", requiredFloorUsd: 50_000, buyUsd: 53_000 });
  });
  it("qualifies a 3-alert accumulation cluster above floor and 75% buy ratio", () => {
    const candidates = aggregateWhaleShocks([
      { symbol: "INJ", direction: "accumulation", usd_value: 20_000, source: "feed-a" },
      { symbol: "INJ", direction: "accumulation", usd_value: 20_000, source: "feed-a" },
      { symbol: "INJ", direction: "accumulation", usd_value: 15_000, source: "feed-b" },
      { symbol: "INJ", direction: "distribution", usd_value: 15_000, source: "feed-a" },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ symbol: "INJ", buyUsd: 55_000, sellUsd: 15_000, alertCount: 4, sources: ["feed-a", "feed-b"] });
    expect(candidates[0].buyRatio).toBeCloseTo(55 / 70);
  });
  it("rejects insufficient buy ratio, volume, and alert count", () => {
    expect(aggregateWhaleShocks([
      { symbol: "INJ", direction: "accumulation", usd_value: 60_000 },
      { symbol: "INJ", direction: "distribution", usd_value: 30_000 },
      { symbol: "INJ", direction: "accumulation", usd_value: 1_000 },
    ])).toHaveLength(0);
    expect(aggregateWhaleShocks([
      { symbol: "INJ", direction: "accumulation", usd_value: 20_000 },
      { symbol: "INJ", direction: "accumulation", usd_value: 20_000 },
    ])).toHaveLength(0);
  });
  it("ignores unknown directions and invalid values", () => {
    expect(aggregateWhaleShocks([
      { symbol: "INJ", direction: "accumulation", usd_value: 25_000 },
      { symbol: "INJ", direction: "accumulation", usd_value: 25_000 },
      { symbol: "INJ", direction: "unknown", usd_value: 500_000 },
      { symbol: "INJ", direction: "distribution", usd_value: -10 },
    ])).toHaveLength(0);
  });
});
describe("Whale Shock Reversal Engine", () => {
  it("approves bearish baseline followed by a positive regime shift", () => {
    const res = evaluateRegimeShockTransition([
      { regime_label: "strong_bear", created_at: "2026-10-13T18:00:00Z" },
      { regime_label: "bear", created_at: "2026-10-13T19:00:00Z" },
      { regime_label: "sideways", created_at: "2026-10-13T20:00:00Z" },
    ]);
    expect(res.passed).toBe(true); expect(res.isInitialBearish).toBe(true);
    expect(res.isViolentPositiveShift).toBe(true); expect(res.scoreShift).toBeCloseTo(1);
  });
  it("uses stored scores when supplied", () => {
    const res = evaluateRegimeShockTransition([
      { regime_label: "strong_bear", score: -0.6, created_at: "2026-10-13T18:00:00Z" },
      { regime_label: "bear", score: -0.35, created_at: "2026-10-13T19:00:00Z" },
    ]);
    expect(res.passed).toBe(true); expect(res.scoreShift).toBeCloseTo(0.25);
  });
  it("rejects a bullish baseline", () => {
    const res = evaluateRegimeShockTransition([
      { regime_label: "bull", created_at: "2026-10-13T18:00:00Z" },
      { regime_label: "strong_bull", created_at: "2026-10-13T20:00:00Z" },
    ]);
    expect(res.passed).toBe(false); expect(res.isInitialBearish).toBe(false);
  });
  it("rejects continued worsening bearish regime", () => {
    const res = evaluateRegimeShockTransition([
      { regime_label: "bear", created_at: "2026-10-13T18:00:00Z" },
      { regime_label: "strong_bear", created_at: "2026-10-13T20:00:00Z" },
    ]);
    expect(res.passed).toBe(false); expect(res.isViolentPositiveShift).toBe(false);
  });
  it("accepts explicit bullish 1h signal", () => {
    expect(evaluate1hTechnicalConfirmation({ symbol: "INJ", signal: "bullish", rsi: 52, macd: 0.1, macd_signal: 0.05 }).passed).toBe(true);
  });
  it("accepts RSI/MACD momentum gate", () => {
    expect(evaluate1hTechnicalConfirmation({ symbol: "INJ", signal: "neutral", rsi: 45, macd: 0.1, macd_signal: 0.05 }).passed).toBe(true);
  });
  it("rejects bearish technicals and missing snapshots", () => {
    expect(evaluate1hTechnicalConfirmation({ symbol: "INJ", signal: "bearish", rsi: 31, macd: -0.3, macd_signal: -0.1 }).passed).toBe(false);
    expect(evaluate1hTechnicalConfirmation(null).passed).toBe(false);
  });
});

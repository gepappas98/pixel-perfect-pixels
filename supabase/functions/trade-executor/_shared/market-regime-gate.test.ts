import { describe, expect, it } from "vitest";
import {
  computeCalibratedAgreement,
  computeMarketRegimeAssessment,
  evaluateSidewaysEntryGate,
} from "./market-regime-gate";

describe("computeMarketRegimeAssessment", () => {
  it("computes whale net flow and technical breadth using the canonical score weights", () => {
    const result = computeMarketRegimeAssessment({
      whales: [
        { direction: "accumulation", usd_value: 40_476_000 },
        { direction: "distribution", usd_value: 40_466_000 },
      ],
      indicators: [
        { symbol: "BTCUSDT", timeframe: "4h", signal: "bullish" },
        { symbol: "ETHUSDT", timeframe: "4h", signal: "neutral" },
      ],
      councils: [],
    });
    expect(result.whaleNet).toBeCloseTo(10_000 / 80_942_000, 8);
    expect(result.techBreadth).toBe(0.5);
    expect(result.label).toBe("bullish");
  });
});

describe("computeCalibratedAgreement", () => {
  it("counts neutral pillars in the denominator instead of reporting false 100% agreement", () => {
    const result = computeCalibratedAgreement(0.08, 0.02, 0);
    expect(result.confidence).toBeCloseTo(1 / 3, 8);
    expect(result.agreementPct).toBe(33);
    expect(result.dominantDirection).toBe("bullish");
  });

  it("treats whale ±5% and technical/council ±10% as neutral, including the boundaries", () => {
    const result = computeCalibratedAgreement(0.05, 0.10, -0.10);
    expect(result.confidence).toBe(0);
    expect(result.agreementPct).toBe(0);
    expect(result.dominantDirection).toBe("neutral");
  });
});

describe("evaluateSidewaysEntryGate", () => {
  it("allows sideways entry only with all three bullish micro timeframes and whale net > 5%", () => {
    expect(evaluateSidewaysEntryGate(0.04, 0.051, {
      tf5m: "bullish", tf15m: "bullish", tf1h: "bullish",
    }).allowBuy).toBe(true);
  });

  it("rejects sideways entry when any micro timeframe is not bullish", () => {
    const result = evaluateSidewaysEntryGate(0.04, 0.08, {
      tf5m: "bullish", tf15m: "neutral", tf1h: "bullish",
    });
    expect(result.allowBuy).toBe(false);
    expect(result.reason).toContain("all 5m/15m/1h bullish");
  });

  it("rejects sideways entry when whale net flow is exactly +5%", () => {
    const result = evaluateSidewaysEntryGate(0, 0.05, {
      tf5m: "bullish", tf15m: "bullish", tf1h: "bullish",
    });
    expect(result.allowBuy).toBe(false);
    expect(result.reason).toContain("whale net flow > +5%");
  });

  it("does not add the sideways-specific restriction outside the sideways score band", () => {
    expect(evaluateSidewaysEntryGate(0.15, 0, {
      tf5m: "neutral", tf15m: "neutral", tf1h: "neutral",
    }).allowBuy).toBe(true);
  });
});

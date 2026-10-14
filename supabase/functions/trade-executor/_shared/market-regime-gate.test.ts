import { describe, expect, it } from "vitest";
import {
  computeMarketRegimeAssessment,
  evaluateSidewaysEntryGate,
} from "./market-regime-gate";

describe("computeMarketRegimeAssessment", () => {
  it("computes whale net flow and a neutral score from empty directional pillars", () => {
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

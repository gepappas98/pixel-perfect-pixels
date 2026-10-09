import { describe, it, expect } from "vitest";
import { computeRegimeSnapshot } from "../regime-snapshot";

const neutralInputs = {
  whales: [],
  indicators: [],
  predictions: [],
};

describe("computeRegimeSnapshot — AI Council consensus", () => {
  it("does not report +100% when BUY votes are surrounded by HOLD/AVOID", () => {
    const councils = [
      ...Array.from({ length: 4 }, (_, i) => ({ symbol: `BUY${i}`, final_verdict: "BUY" })),
      ...Array.from({ length: 11 }, (_, i) => ({ symbol: `HOLD${i}`, final_verdict: "HOLD" })),
      ...Array.from({ length: 2 }, (_, i) => ({ symbol: `AVOID${i}`, final_verdict: "AVOID" })),
    ];

    const result = computeRegimeSnapshot({ ...neutralInputs, councils });

    expect(result.councilConsensus).toBeCloseTo(4 / 17, 8);
    expect(result.score).toBeCloseTo((4 / 17) * 0.1, 8);
  });

  it("keeps a fully directional 4 BUY / 0 SELL council at +100%", () => {
    const councils = Array.from({ length: 4 }, (_, i) => ({
      symbol: `BUY${i}`,
      final_verdict: "BUY",
    }));

    const result = computeRegimeSnapshot({ ...neutralInputs, councils });

    expect(result.councilConsensus).toBe(1);
  });

  it("returns neutral consensus when no council rows exist", () => {
    const result = computeRegimeSnapshot({ ...neutralInputs, councils: [] });

    expect(result.councilConsensus).toBe(0);
  });
});

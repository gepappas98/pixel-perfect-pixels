import { describe, expect, it } from "vitest";
import {
  computeDivergenceAssessment,
  evaluateBtcTrend,
} from "../regime-divergence";
import {
  computeDivergenceAssessment as computeEdgeDivergenceAssessment,
  evaluateBtcTrend as evaluateEdgeBtcTrend,
} from "../../../supabase/functions/trade-executor/_shared/regime-divergence";

const evaluators = [
  { name: "frontend pure module", evaluateBtcTrend, computeDivergenceAssessment },
  {
    name: "Edge Function pure module",
    evaluateBtcTrend: evaluateEdgeBtcTrend,
    computeDivergenceAssessment: computeEdgeDivergenceAssessment,
  },
];

describe.each(evaluators)("BTC Divergence Decoupling Rule — $name", (logic) => {
  it("detects BTC downtrend from negative returns and price below SMA", () => {
    const trend = logic.evaluateBtcTrend(81500, 83000, 83500, 82500);
    expect(trend.isDowntrend).toBe(true);
    expect(trend.isBelowSma24h).toBe(true);
    expect(trend.return4hPct).toBeCloseTo(-1.8072, 3);
  });

  it("decouples positive whale flow during a BTC downtrend without changing the production score", () => {
    const trend = logic.evaluateBtcTrend(81640, 82500, 83400, 82700);
    const result = logic.computeDivergenceAssessment(trend, 0.356, -0.22, 0);

    expect(result.isDivergent).toBe(true);
    expect(result.shadowWhaleNet).toBe(0);
    expect(result.baselineScore).toBeCloseTo(0.0235, 3);
    expect(result.shadowScore).toBeCloseTo(-0.11, 3);
    expect(result.baselineRegime).toBe("sideways");
    // -0.110 is still Sideways under the existing +/-0.15 thresholds.
    expect(result.shadowRegime).toBe("sideways");
    expect(result.entryBlockedByRule).toBe(false);
  });

  it("downgrades a bullish baseline to sideways during extreme dip-buying divergence", () => {
    const trend = logic.evaluateBtcTrend(81975, 83500, 83500, 82800);
    const result = logic.computeDivergenceAssessment(trend, 1, -0.22, 0);

    expect(result.baselineScore).toBeCloseTo(0.265, 3);
    expect(result.baselineRegime).toBe("bullish");
    expect(result.shadowScore).toBeCloseTo(-0.11, 3);
    expect(result.shadowRegime).toBe("sideways");
    expect(result.isDivergent).toBe(true);
    // Shadow mode records the downgrade; it does not block live entries.
    expect(result.entryBlockedByRule).toBe(false);
  });

  it("flags a hypothetical bearish-regime block only when shadow score crosses the bearish threshold", () => {
    const trend = logic.evaluateBtcTrend(81975, 83500, 83500, 82800);
    const result = logic.computeDivergenceAssessment(trend, 1, -0.4, 0);
    expect(result.baselineRegime).toBe("bullish");
    expect(result.shadowScore).toBeCloseTo(-0.2, 3);
    expect(result.shadowRegime).toBe("bearish");
    expect(result.entryBlockedByRule).toBe(true);
  });

  it("preserves whale flow when BTC is not in a downtrend", () => {
    const trend = logic.evaluateBtcTrend(84000, 83500, 83000, 83200);
    const result = logic.computeDivergenceAssessment(trend, 0.4, 0.2, 0);
    expect(result.isDivergent).toBe(false);
    expect(result.shadowWhaleNet).toBe(0.4);
    expect(result.shadowScore).toBe(result.baselineScore);
  });

  it("treats missing BTC metrics as unconfirmed and preserves the baseline score", () => {
    const result = logic.computeDivergenceAssessment(null, 0.4, -0.22, 0);
    expect(result.isDivergent).toBe(false);
    expect(result.divergenceType).toBe("none");
    expect(result.shadowWhaleNet).toBe(0.4);
    expect(result.shadowScore).toBe(result.baselineScore);
    expect(result.explanation).toContain("unconfirmed");
  });
});

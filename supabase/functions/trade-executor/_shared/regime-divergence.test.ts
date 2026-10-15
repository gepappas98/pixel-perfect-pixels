import {
  computeDivergenceAssessment,
  evaluateBtcTrend,
} from "./regime-divergence.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, tolerance = 0.001) {
  assert(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

Deno.test("BTC divergence shadow: decouples positive whale flow during downtrend", () => {
  const btc = evaluateBtcTrend(81640, 82500, 83400, 82700);
  const result = computeDivergenceAssessment(btc, 0.356, -0.22, 0);
  assert(result.isDivergent, "expected divergence");
  assertClose(result.baselineScore, 0.0235);
  assertClose(result.shadowScore, -0.11);
  assert(result.shadowRegime === "sideways", "-0.110 must remain sideways under +/-0.15 thresholds");
  assert(!result.entryBlockedByRule, "sideways shadow regime is not a hypothetical bearish block");
});

Deno.test("BTC divergence shadow: downgrades bullish to sideways, not bearish, at breadth -0.22", () => {
  const btc = evaluateBtcTrend(81975, 83500, 83500, 82800);
  const result = computeDivergenceAssessment(btc, 1, -0.22, 0);
  assert(result.baselineRegime === "bullish", "expected bullish baseline");
  assertClose(result.shadowScore, -0.11);
  assert(result.shadowRegime === "sideways", "shadow score -0.110 should classify sideways");
});

Deno.test("BTC divergence shadow: reports counterfactual bearish downgrade only below threshold", () => {
  const btc = evaluateBtcTrend(81975, 83500, 83500, 82800);
  const result = computeDivergenceAssessment(btc, 1, -0.4, 0);
  assert(result.shadowRegime === "bearish", "expected bearish shadow regime");
  assert(result.entryBlockedByRule, "expected counterfactual bearish block");
});

Deno.test("BTC divergence shadow: missing BTC data is unconfirmed and preserves whale score", () => {
  const result = computeDivergenceAssessment(null, 0.4, -0.22, 0);
  assert(!result.isDivergent, "missing data must not count as divergence");
  assert(result.shadowWhaleNet === 0.4, "missing data must preserve whale contribution");
  assert(result.shadowScore === result.baselineScore, "scores should match when BTC data is missing");
});

Deno.test("BTC trend: detects 4h/24h negative returns and price below SMA", () => {
  const btc = evaluateBtcTrend(81500, 83000, 83500, 82500);
  assert(btc.isDowntrend, "expected BTC downtrend");
  assert(btc.isBelowSma24h, "expected BTC below 24h SMA");
  assertClose(btc.return4hPct, -1.8072, 0.001);
});

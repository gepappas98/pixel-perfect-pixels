/**
 * BTC Trend & Whale Divergence Decoupling Engine.
 * Pure shadow-only logic: it never changes production entry decisions.
 */

export interface BtcTrendMetrics {
  currentPrice: number;
  return4hPct: number;
  return24hPct: number;
  sma24h: number;
  isBelowSma24h: boolean;
  isDowntrend: boolean;
}

export type RegimeLabel = "bullish" | "bearish" | "sideways";
export type DivergenceType = "whale_absorption_in_btc_drop" | "none";

export interface BtcDowntrendEntryDecision {
  required: boolean;
  allowBuy: boolean;
  reason: string;
}

/**
 * Active paper-entry gate: during a confirmed BTC downtrend, a new BUY must
 * show a confirmed micro bounce (at least two bullish 5m/15m/1h readings and
 * no bearish readings). If positive market whale flow is decoupled and the
 * resulting shadow regime is bearish, reject regardless of the micro bounce.
 * Missing BTC data does not manufacture a downtrend.
 */
export function evaluateBtcDowntrendEntryGate(
  btc: BtcTrendMetrics | null,
  whaleNet: number,
  techBreadth: number,
  councilConsensus: number,
  micro: { tf5m: string; tf15m: string; tf1h: string },
): BtcDowntrendEntryDecision {
  if (!btc?.isDowntrend) {
    return { required: false, allowBuy: true, reason: btc ? "btc_downtrend_not_confirmed" : "btc_data_unavailable_no_downtrend_inferred" };
  }

  const states = [micro.tf5m, micro.tf15m, micro.tf1h].map((value) => String(value).toLowerCase());
  const bulls = states.filter((value) => value === "bullish").length;
  const bears = states.filter((value) => value === "bearish").length;
  if (bulls < 2 || bears > 0) {
    return {
      required: true,
      allowBuy: false,
      reason: `BTC downtrend active; BUY requires confirmed micro bounce (>=2 bullish and 0 bearish on 5m/15m/1h), observed ${states.join("/")}`,
    };
  }

  const divergence = computeDivergenceAssessment(btc, whaleNet, techBreadth, councilConsensus);
  if (divergence.isDivergent && divergence.shadowRegime === "bearish") {
    return {
      required: true,
      allowBuy: false,
      reason: `BTC downtrend + positive whale flow decoupled; adjusted market regime is bearish (score ${divergence.shadowScore.toFixed(3)})`,
    };
  }

  return {
    required: true,
    allowBuy: true,
    reason: `BTC downtrend gate passed: confirmed micro bounce (${bulls}/3 bullish, 0 bearish); adjusted regime ${divergence.shadowRegime}`,
  };
}

export interface DivergenceAssessment {
  btc: BtcTrendMetrics | null;
  whaleNet: number;
  techBreadth: number;
  councilConsensus: number;
  baselineScore: number;
  baselineRegime: RegimeLabel;
  shadowWhaleNet: number;
  shadowScore: number;
  shadowRegime: RegimeLabel;
  isDivergent: boolean;
  divergenceType: DivergenceType;
  /** Counterfactual only: true when the shadow score would classify bearish. */
  entryBlockedByRule: boolean;
  explanation: string;
}

export function evaluateBtcTrend(
  currentPrice: number,
  price4hAgo: number,
  price24hAgo: number,
  sma24h: number,
): BtcTrendMetrics {
  const return4hPct = price4hAgo > 0
    ? ((currentPrice - price4hAgo) / price4hAgo) * 100
    : 0;
  const return24hPct = price24hAgo > 0
    ? ((currentPrice - price24hAgo) / price24hAgo) * 100
    : 0;
  const isBelowSma24h = sma24h > 0 && currentPrice < sma24h;
  const isDowntrend =
    return24hPct < -1.0 ||
    return4hPct < -0.5 ||
    (isBelowSma24h && return4hPct < 0);

  return {
    currentPrice,
    return4hPct,
    return24hPct,
    sma24h,
    isBelowSma24h,
    isDowntrend,
  };
}

export function classifyRegimeScore(score: number): RegimeLabel {
  if (score >= 0.15) return "bullish";
  if (score <= -0.15) return "bearish";
  return "sideways";
}

export function computeDivergenceAssessment(
  btc: BtcTrendMetrics | null,
  whaleNet: number,
  techBreadth: number,
  councilConsensus: number,
): DivergenceAssessment {
  const baselineScore =
    whaleNet * 0.375 + techBreadth * 0.5 + councilConsensus * 0.125;
  const baselineRegime = classifyRegimeScore(baselineScore);

  // Missing BTC data is unconfirmed, never evidence of divergence.
  const isDivergent = btc !== null && btc.isDowntrend && whaleNet > 0.05;
  const shadowWhaleNet = isDivergent ? 0 : whaleNet;
  const shadowScore =
    shadowWhaleNet * 0.375 + techBreadth * 0.5 + councilConsensus * 0.125;
  const shadowRegime = classifyRegimeScore(shadowScore);

  // This is a counterfactual regime flag in shadow mode, not a live order block.
  const entryBlockedByRule =
    baselineRegime !== "bearish" && shadowRegime === "bearish";

  let explanation = "Trend and flow aligned or no qualifying divergence.";
  if (!btc) {
    explanation = "BTC trend data unavailable; divergence is unconfirmed and baseline flow is preserved.";
  } else if (isDivergent) {
    explanation =
      `BTC downtrend (${btc.return24hPct.toFixed(1)}% 24h) decoupled whale buying (+${(whaleNet * 100).toFixed(1)}%). Score shifted from ${baselineScore.toFixed(3)} [${baselineRegime}] to ${shadowScore.toFixed(3)} [${shadowRegime}]. Shadow-only; production decisions unchanged.`;
  }

  return {
    btc,
    whaleNet,
    techBreadth,
    councilConsensus,
    baselineScore,
    baselineRegime,
    shadowWhaleNet,
    shadowScore,
    shadowRegime,
    isDivergent,
    divergenceType: isDivergent ? "whale_absorption_in_btc_drop" : "none",
    entryBlockedByRule,
    explanation,
  };
}

export type RegimeDirection = "bullish" | "bearish" | "sideways";

export const WHALE_NEUTRAL_DEADBAND = 0.05;
export const TECH_NEUTRAL_DEADBAND = 0.10;
export const COUNCIL_NEUTRAL_DEADBAND = 0.10;

export function getDirectionalSign(value: number, deadband: number): -1 | 0 | 1 {
  if (!Number.isFinite(value) || (value <= deadband && value >= -deadband)) return 0;
  return value > deadband ? 1 : -1;
}

export function computeCalibratedAgreement(
  whaleNet: number,
  techBreadth: number,
  councilConsensus: number,
): { confidence: number; agreementPct: number; dominantDirection: "bullish" | "bearish" | "neutral" } {
  const signs = [
    getDirectionalSign(whaleNet, WHALE_NEUTRAL_DEADBAND),
    getDirectionalSign(techBreadth, TECH_NEUTRAL_DEADBAND),
    getDirectionalSign(councilConsensus, COUNCIL_NEUTRAL_DEADBAND),
  ];
  const bullishCount = signs.filter((sign) => sign > 0).length;
  const bearishCount = signs.filter((sign) => sign < 0).length;
  const dominant = Math.max(bullishCount, bearishCount);
  const confidence = dominant / 3;
  return {
    confidence,
    agreementPct: Math.round(confidence * 100),
    dominantDirection: bullishCount > bearishCount ? "bullish"
      : bearishCount > bullishCount ? "bearish" : "neutral",
  };
}

export interface MarketRegimeInputs {
  whales: Array<{ direction?: unknown; usd_value?: unknown }>;
  indicators: Array<{ symbol?: unknown; timeframe?: unknown; signal?: unknown }>;
  councils: Array<{ symbol?: unknown; final_verdict?: unknown }>;
}

export interface MarketRegimeAssessment {
  score: number;
  label: RegimeDirection;
  whaleNet: number;
  techBreadth: number;
  councilConsensus: number;
  confidence: number;
  agreementPct: number;
  dominantDirection: "bullish" | "bearish" | "neutral";
}

export interface SidewaysEntryDecision {
  required: boolean;
  allowBuy: boolean;
  reason: string;
}

/** Mirrors the canonical regime score: whale .375, 4h breadth .5, council .125. */
export function computeMarketRegimeAssessment(input: MarketRegimeInputs): MarketRegimeAssessment {
  let buyUsd = 0;
  let sellUsd = 0;
  for (const row of input.whales) {
    const value = Number(row.usd_value) || 0;
    if (row.direction === "accumulation") buyUsd += value;
    else if (row.direction === "distribution") sellUsd += value;
  }
  const whaleTotal = buyUsd + sellUsd;
  const whaleNet = whaleTotal > 0 ? (buyUsd - sellUsd) / whaleTotal : 0;

  const latestIndicators = new Map<string, string>();
  for (const row of input.indicators) {
    if (row.timeframe !== "4h") continue;
    const symbol = String(row.symbol ?? "").toUpperCase();
    if (symbol && !latestIndicators.has(symbol)) {
      latestIndicators.set(symbol, String(row.signal ?? "neutral").toLowerCase());
    }
  }
  let techBull = 0;
  let techBear = 0;
  for (const signal of latestIndicators.values()) {
    if (signal === "bullish") techBull++;
    else if (signal === "bearish") techBear++;
  }
  const techBreadth = latestIndicators.size > 0
    ? (techBull - techBear) / latestIndicators.size
    : 0;

  const latestCouncils = new Map<string, string>();
  for (const row of input.councils) {
    const symbol = String(row.symbol ?? "").toUpperCase();
    if (symbol && !latestCouncils.has(symbol)) {
      latestCouncils.set(symbol, String(row.final_verdict ?? "").toUpperCase());
    }
  }
  let councilBuy = 0;
  let councilSell = 0;
  for (const verdict of latestCouncils.values()) {
    if (verdict === "BUY") councilBuy++;
    else if (verdict === "SELL") councilSell++;
  }
  const councilConsensus = latestCouncils.size > 0
    ? (councilBuy - councilSell) / latestCouncils.size
    : 0;

  const score = whaleNet * 0.375 + techBreadth * 0.5 + councilConsensus * 0.125;
  const label: RegimeDirection = score >= 0.15
    ? "bullish"
    : score <= -0.15 ? "bearish" : "sideways";
  const agreement = computeCalibratedAgreement(whaleNet, techBreadth, councilConsensus);
  return { score, label, whaleNet, techBreadth, councilConsensus, ...agreement };
}

/**
 * Sideways is explicitly |score| < 0.15. In that regime, all three micro
 * timeframes must be bullish and market-wide whale net flow must exceed +5%.
 * Outside sideways, this additional gate does not change existing decisions.
 */
export function evaluateSidewaysEntryGate(
  score: number,
  whaleNet: number,
  micro: { tf5m: string; tf15m: string; tf1h: string },
): SidewaysEntryDecision {
  if (!(Math.abs(score) < 0.15)) {
    return { required: false, allowBuy: true, reason: "not_sideways" };
  }
  if (whaleNet <= 0.05) {
    return {
      required: true,
      allowBuy: false,
      reason: `sideways requires whale net flow > +5%; observed ${(whaleNet * 100).toFixed(2)}%`,
    };
  }
  if (micro.tf5m !== "bullish" || micro.tf15m !== "bullish" || micro.tf1h !== "bullish") {
    return {
      required: true,
      allowBuy: false,
      reason: `sideways requires all 5m/15m/1h bullish; observed ${micro.tf5m}/${micro.tf15m}/${micro.tf1h}`,
    };
  }
  return {
    required: true,
    allowBuy: true,
    reason: `sideways exception confirmed: all micro timeframes bullish and whale net ${(whaleNet * 100).toFixed(2)}%`,
  };
}

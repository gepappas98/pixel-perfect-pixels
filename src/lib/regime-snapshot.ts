/**
 * Market regime snapshot — pure function, no DB access.
 *
 * Uses the same scoring formula as market-regime.functions.ts:
 *   score = whaleNet × 0.375 + techBreadth × 0.5 + councilConsensus × 0.125
 *
 * The computed label is stored on every signal and trade so we can later
 * answer questions like:
 *   - "How does Chart Trader perform in BEAR regime vs BULL?"
 *   - "Does Whale preset work in SIDEWAYS?"
 *   - "Should auto-switch prefer different presets per regime?"
 */

export type RegimeLabel =
  | "strong_bull"
  | "bull"
  | "sideways"
  | "bear"
  | "strong_bear";

export interface RegimeSnapshot {
  label: RegimeLabel;
  score: number;
  whaleNet: number;
  techBreadth: number;
  councilConsensus: number;
}

export function classifyRegime(score: number): RegimeLabel {
  if (score >= 0.5) return "strong_bull";
  if (score >= 0.15) return "bull";
  if (score <= -0.5) return "strong_bear";
  if (score <= -0.15) return "bear";
  return "sideways";
}

export function computeRegimeSnapshot(input: {
  whales: Record<string, unknown>[];
  indicators: Record<string, unknown>[];
  councils: Record<string, unknown>[];
}): RegimeSnapshot {
  // ── Whale aggregates ──
  let buyUsd = 0;
  let sellUsd = 0;
  for (const w of input.whales) {
    const v = Number(w["usd_value"]) || 0;
    if (w["direction"] === "accumulation") buyUsd += v;
    else if (w["direction"] === "distribution") sellUsd += v;
  }
  const totalWhale = buyUsd + sellUsd;
  const whaleNet = totalWhale > 0 ? (buyUsd - sellUsd) / totalWhale : 0;

  // ── Technicals (latest per symbol, 4h only) ──
  const seenTech = new Set<string>();
  let tBull = 0;
  let tBear = 0;
  let tNeu = 0;
  for (const i of input.indicators) {
    if (i["timeframe"] !== "4h") continue;
    const sym = String(i["symbol"]);
    if (seenTech.has(sym)) continue;
    seenTech.add(sym);
    if (i["signal"] === "bullish") tBull++;
    else if (i["signal"] === "bearish") tBear++;
    else tNeu++;
  }
  const totalTech = tBull + tBear + tNeu;
  const techBreadth = totalTech > 0 ? (tBull - tBear) / totalTech : 0;

  // ── Council (latest per symbol) ──
  const seenCouncil = new Set<string>();
  let cBuy = 0;
  let cSell = 0;
  for (const c of input.councils) {
    const sym = String(c["symbol"]);
    if (seenCouncil.has(sym)) continue;
    seenCouncil.add(sym);
    const v = String(c["final_verdict"] ?? "").toUpperCase();
    if (v === "BUY") cBuy++;
    else if (v === "SELL") cSell++;
  }
  const totalCouncil = seenCouncil.size;
  // Keep snapshot scoring consistent with the live Market Regime calculation:
  // neutral verdicts do not count as bearish, but they do not provide directional
  // support either, so consensus is normalized by all current council symbols.
  const councilConsensus =
    totalCouncil > 0 ? (cBuy - cSell) / totalCouncil : 0;

  // Normalize remaining independent sources to preserve a -1..+1 score.
  const score =
    whaleNet * 0.375 +
    techBreadth * 0.5 +
    councilConsensus * 0.125;

  return {
    label: classifyRegime(score),
    score,
    whaleNet,
    techBreadth,
    councilConsensus,
  };
}

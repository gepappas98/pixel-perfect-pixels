/**
 * Market regime snapshot — pure function, no DB access.
 *
 * Uses the same scoring formula as market-regime.functions.ts:
 *   score = whaleNet × 0.3 + techBreadth × 0.4 + predConsensus × 0.2 + councilConsensus × 0.1
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
  predConsensus: number;
  councilConsensus: number;
}

const BULLISH_QUESTION =
  /\b(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\b/i;
const BEARISH_QUESTION =
  /\b(dip|drop|fall|below|crash|down to|under|bottom)\b/i;

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
  predictions: Record<string, unknown>[];
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

  // ── Predictions (latest per market) ──
  const seenPred = new Set<string>();
  let pBull = 0;
  let pBear = 0;
  let pNeu = 0;
  for (const p of input.predictions) {
    const slug = String(p["market_slug"]);
    if (seenPred.has(slug)) continue;
    seenPred.add(slug);
    const yes = Number(p["yes_price"]);
    if (!Number.isFinite(yes)) {
      pNeu++;
      continue;
    }
    const q = String(p["question"] ?? "").toLowerCase();
    const isBq = BULLISH_QUESTION.test(q);
    const isBeq = BEARISH_QUESTION.test(q);
    if (!isBq && !isBeq) {
      pNeu++;
      continue;
    }
    const up = isBq ? yes : 1 - yes;
    if (up > 0.6) pBull++;
    else if (up < 0.4) pBear++;
    else pNeu++;
  }
  const totalPred = pBull + pBear + pNeu;
  const predConsensus = totalPred > 0 ? (pBull - pBear) / totalPred : 0;

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
  const councilConsensus =
    totalCouncil > 0 ? (cBuy - cSell) / totalCouncil : 0;

  const score =
    whaleNet * 0.3 +
    techBreadth * 0.4 +
    predConsensus * 0.2 +
    councilConsensus * 0.1;

  return {
    label: classifyRegime(score),
    score,
    whaleNet,
    techBreadth,
    predConsensus,
    councilConsensus,
  };
}

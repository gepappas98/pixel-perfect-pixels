import { createServerFn } from "@tanstack/react-start";

/* ───────────── Types ───────────── */

export type RegimeLabel = "strong_bull" | "bull" | "sideways" | "bear" | "strong_bear";

export interface MarketRegime {
  whale: {
    buy_usd: number;
    sell_usd: number;
    net_pct: number;      // -1 to +1
    sample_size: number;
  };
  technicals: {
    bullish: number;
    bearish: number;
    neutral: number;
    breadth: number;      // -1 to +1
    sample_size: number;
  };
  predictions: {
    bullish: number;
    bearish: number;
    neutral: number;
    consensus: number;    // -1 to +1
    sample_size: number;
  };
  council: {
    buy: number;
    sell: number;
    hold: number;
    avoid: number;
    consensus: number;    // -1 to +1
    sample_size: number;
  };
  score: number;          // -1 to +1
  confidence: number;     // 0 to 1
  regime: RegimeLabel;
  recommended_preset: string;
  reasoning: string;
  generated_at: string;
}

/* ───────────── Prediction direction helper ───────────── */

const BULLISH_QUESTION = /\b(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\b/i;
const BEARISH_QUESTION = /\b(dip|drop|fall|below|crash|down to|under|bottom)\b/i;

function predictionDirectionFromSnapshot(
  question: string | null,
  yesPrice: number | null,
): "bullish" | "bearish" | "neutral" {
  const yes = Number(yesPrice);
  if (!Number.isFinite(yes)) return "neutral";
  const q = String(question ?? "").toLowerCase();
  const isBullishQ = BULLISH_QUESTION.test(q);
  const isBearishQ = BEARISH_QUESTION.test(q);
  if (!isBullishQ && !isBearishQ) return "neutral";
  const up = isBullishQ ? yes : 1 - yes;
  if (up > 0.6) return "bullish";
  if (up < 0.4) return "bearish";
  return "neutral";
}

/* ───────────── Recommendation logic ───────────── */

function classifyRegime(score: number): RegimeLabel {
  if (score >= 0.5) return "strong_bull";
  if (score >= 0.15) return "bull";
  if (score <= -0.5) return "strong_bear";
  if (score <= -0.15) return "bear";
  return "sideways";
}

function recommendPreset(score: number, confidence: number): string {
  if (confidence < 0.4) return "ai-driven";
  if (score >= 0.5) return "chart-trader";
  if (score >= 0.15) return "sentiment-first";
  if (score <= -0.5) return "chart-trader";
  if (score <= -0.15) return "whale-focused";
  return "conservative";
}

/* ───────────── Server function ───────────── */

export const getMarketRegime = createServerFn({ method: "GET" }).handler(
  async (): Promise<MarketRegime> => {
    const { supabaseAdmin: db } = await import(
      "@/integrations/supabase/client.server"
    );

    const now = Date.now();
    const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000).toISOString();
    const thirtyMinAgo = new Date(now - 30 * 60 * 1000).toISOString();

    const [whalesRes, techsRes, predsRes, councilRes] = await Promise.all([
      db
        .from("whale_alerts")
        .select("direction, usd_value")
        .gte("created_at", sixHoursAgo),
      db
        .from("indicator_snapshots")
        .select("symbol, signal, created_at")
        .eq("timeframe", "4h")
        .gte("created_at", sixHoursAgo)
        .order("created_at", { ascending: false }),
      db
        .from("prediction_snapshots")
        .select("market_slug, question, yes_price, created_at")
        .order("created_at", { ascending: false }),
      db
        .from("council_signals")
        .select("symbol, final_verdict, source_created_at")
        .gte("source_created_at", thirtyMinAgo)
        .order("source_created_at", { ascending: false }),
    ]);

    // ── Whale aggregates ──
    let buyUsd = 0;
    let sellUsd = 0;
    const whaleRows = (whalesRes.data ?? []) as {
      direction: string;
      usd_value: number;
    }[];
    for (const w of whaleRows) {
      const v = Number(w.usd_value) || 0;
      if (w.direction === "accumulation") buyUsd += v;
      else if (w.direction === "distribution") sellUsd += v;
    }
    const totalWhale = buyUsd + sellUsd;
    const whaleNet = totalWhale > 0 ? (buyUsd - sellUsd) / totalWhale : 0;

    // ── Technicals (latest per symbol) ──
    const seenTech = new Set<string>();
    let techBull = 0;
    let techBear = 0;
    let techNeu = 0;
    for (const t of (techsRes.data ?? []) as {
      symbol: string;
      signal: string | null;
    }[]) {
      if (seenTech.has(t.symbol)) continue;
      seenTech.add(t.symbol);
      if (t.signal === "bullish") techBull++;
      else if (t.signal === "bearish") techBear++;
      else techNeu++;
    }
    const totalTech = techBull + techBear + techNeu;
    const techBreadth = totalTech > 0 ? (techBull - techBear) / totalTech : 0;

    // ── Predictions (latest per market) ──
    const seenPred = new Set<string>();
    let predBull = 0;
    let predBear = 0;
    let predNeu = 0;
    for (const p of (predsRes.data ?? []) as {
      market_slug: string;
      question: string | null;
      yes_price: number | null;
    }[]) {
      if (seenPred.has(p.market_slug)) continue;
      seenPred.add(p.market_slug);
      const dir = predictionDirectionFromSnapshot(p.question, p.yes_price);
      if (dir === "bullish") predBull++;
      else if (dir === "bearish") predBear++;
      else predNeu++;
    }
    const totalPred = predBull + predBear + predNeu;
    const predConsensus = totalPred > 0 ? (predBull - predBear) / totalPred : 0;

    // ── Council (latest per symbol) ──
    const seenCouncil = new Set<string>();
    let cBuy = 0;
    let cSell = 0;
    let cHold = 0;
    let cAvoid = 0;
    for (const c of (councilRes.data ?? []) as {
      symbol: string;
      final_verdict: string | null;
    }[]) {
      if (seenCouncil.has(c.symbol)) continue;
      seenCouncil.add(c.symbol);
      const v = String(c.final_verdict ?? "").toUpperCase();
      if (v === "BUY") cBuy++;
      else if (v === "SELL") cSell++;
      else if (v === "AVOID") cAvoid++;
      else cHold++;
    }
    const totalCouncil = cBuy + cSell + cHold + cAvoid;
    const councilConsensus =
      totalCouncil > 0 ? (cBuy - cSell) / totalCouncil : 0;

    // ── Composite regime score ──
    const score =
      whaleNet * 0.3 +
      techBreadth * 0.4 +
      predConsensus * 0.2 +
      councilConsensus * 0.1;

    // ── Agreement / confidence ──
    const signs = [
      Math.sign(whaleNet),
      Math.sign(techBreadth),
      Math.sign(predConsensus),
      Math.sign(councilConsensus),
    ];
    const confidence =
      Math.abs(signs.reduce((a, b) => a + b, 0)) / signs.length;

    const regime = classifyRegime(score);
    const recommended_preset = recommendPreset(score, confidence);

    // ── Reasoning ──
    const reasons: string[] = [];
    if (Math.abs(whaleNet) > 0.15) {
      reasons.push(
        `whales net ${whaleNet > 0 ? "buying" : "selling"} (${(Math.abs(whaleNet) * 100).toFixed(0)}% skew)`,
      );
    }
    if (Math.abs(techBreadth) > 0.15) {
      reasons.push(
        `${techBull}/${totalTech} coins technically ${techBreadth > 0 ? "bullish" : "bearish"}`,
      );
    }
    if (Math.abs(predConsensus) > 0.15) {
      reasons.push(
        `prediction markets lean ${predConsensus > 0 ? "bullish" : "bearish"}`,
      );
    }
    if (Math.abs(councilConsensus) > 0.15) {
      reasons.push(
        `AI council leans ${councilConsensus > 0 ? "BUY" : "SELL"}`,
      );
    }
    if (reasons.length === 0) reasons.push("signals mixed or unclear");

    return {
      whale: {
        buy_usd: buyUsd,
        sell_usd: sellUsd,
        net_pct: whaleNet,
        sample_size: whaleRows.length,
      },
      technicals: {
        bullish: techBull,
        bearish: techBear,
        neutral: techNeu,
        breadth: techBreadth,
        sample_size: totalTech,
      },
      predictions: {
        bullish: predBull,
        bearish: predBear,
        neutral: predNeu,
        consensus: predConsensus,
        sample_size: totalPred,
      },
      council: {
        buy: cBuy,
        sell: cSell,
        hold: cHold,
        avoid: cAvoid,
        consensus: councilConsensus,
        sample_size: totalCouncil,
      },
      score,
      confidence,
      regime,
      recommended_preset,
      reasoning: reasons.join("; "),
      generated_at: new Date().toISOString(),
    };
  },
);

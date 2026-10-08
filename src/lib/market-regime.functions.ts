import { createServerFn } from "@tanstack/react-start";
import { serializeError } from "./error-serialize";

/* ───────────── Types ───────────── */

export type RegimeLabel =
  | "strong_bull"
  | "bull"
  | "sideways"
  | "bear"
  | "strong_bear";

export interface MarketRegime {
  whale: {
    buy_usd: number;
    sell_usd: number;
    net_pct: number;
    sample_size: number;
  };
  technicals: {
    bullish: number;
    bearish: number;
    neutral: number;
    breadth: number;
    sample_size: number;
  };
  predictions: {
    bullish: number;
    bearish: number;
    neutral: number;
    consensus: number;
    sample_size: number;
  };
  council: {
    buy: number;
    sell: number;
    hold: number;
    avoid: number;
    consensus: number;
    sample_size: number;
  };
  score: number;
  confidence: number;
  regime: RegimeLabel;
  recommended_preset: string;
  reasoning: string;
  generated_at: string;
}

/* ───────────── Prediction direction helper ───────────── */

const BULLISH_QUESTION =
  /\b(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\b/i;
const BEARISH_QUESTION =
  /\b(dip|drop|fall|below|crash|down to|under|bottom)\b/i;

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

/* ───────────── Regime classification ───────────── */

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

/* ───────────── Resilient technicals fetch ───────────── */

interface TechsFetchResult {
  rows: { symbol: string; signal: string | null }[];
  window: string;
  error: string | null;
}

/**
 * Resilient technicals fetch:
 *   1. Δοκίμασε 4h @ 6h (το κανονικό)
 *   2. Αν 0 rows, δοκίμασε 4h @ 24h
 *   3. Αν ακόμη 0, δοκίμασε 4h @ 7d
 *   4. Log diagnostics ώστε να ξέρουμε τι συμβαίνει
 */
async function fetchTechnicalsResilient(
  db: typeof import("@/integrations/supabase/client")["supabase"],
): Promise<TechsFetchResult> {
  const now = Date.now();
  const windows = [
    { label: "4h/6h", ms: 6 * 3600_000 },
    { label: "4h/24h", ms: 24 * 3600_000 },
    { label: "4h/7d", ms: 7 * 86400_000 },
  ];

  let lastError: string | null = null;

  for (const w of windows) {
    const cutoff = new Date(now - w.ms).toISOString();
    const { data, error } = await db
      .from("indicator_snapshots")
      .select("symbol, signal, created_at")
      .eq("timeframe", "4h")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (error) {
      lastError = serializeError(error);
      console.error(
        `[REGIME] technicals ${w.label} query failed: ${lastError}`,
      );
      continue;
    }

    const rows = (data ?? []) as { symbol: string; signal: string | null }[];
    console.log(`[REGIME] technicals ${w.label}: ${rows.length} rows`);

    if (rows.length > 0) {
      return { rows, window: w.label, error: null };
    }
  }

  return {
    rows: [],
    window: "none",
    error: lastError ?? "no rows in any window",
  };
}

/* ───────────── Server function ───────────── */

export const getMarketRegime = createServerFn({ method: "GET" }).handler(
  async (): Promise<MarketRegime> => {
    const { supabase: db } = await import("@/integrations/supabase/client");

    try {
      const now = Date.now();
      const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000).toISOString();
      const thirtyMinAgo = new Date(now - 30 * 60 * 1000).toISOString();

      // Technicals με resilient fetch (έχει το δικό του error handling)
      const techsResult = await fetchTechnicalsResilient(db);

      const [whalesRes, predsRes, councilRes] = await Promise.all([
        db
          .from("whale_alerts")
          .select("direction, usd_value")
          .gte("created_at", sixHoursAgo)
          .limit(5000),
        db
          .from("prediction_snapshots")
          .select("market_slug, question, yes_price, created_at")
          .gte("created_at", thirtyMinAgo)
          .order("created_at", { ascending: false })
          .limit(2000),
        db
          .from("council_signals")
          .select("symbol, final_verdict, source_created_at")
          .gte("source_created_at", thirtyMinAgo)
          .order("source_created_at", { ascending: false })
          .limit(5000),
      ]);

      // Explicit error logging
      if (whalesRes.error)
        console.error("[REGIME] whales query:", serializeError(whalesRes.error));
      if (predsRes.error)
        console.error(
          "[REGIME] predictions query:",
          serializeError(predsRes.error),
        );
      if (councilRes.error)
        console.error("[REGIME] council query:", serializeError(councilRes.error));

      console.log(
        `[REGIME] rows: whales=${whalesRes.data?.length ?? 0} techs=${techsResult.rows.length}(${techsResult.window}) preds=${predsRes.data?.length ?? 0} council=${councilRes.data?.length ?? 0}`,
      );

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
      for (const t of techsResult.rows) {
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

      // ── Directional agreement ──
      // The previous implementation used |sum(signs)| / 4. That is
      // cancellation, not agreement: 3 bearish + 1 bullish produced 50%.
      // Agreement now means the share of non-neutral components on the
      // dominant side. This makes "agreement" match what the UI says.
      const signs = [
        Math.sign(whaleNet),
        Math.sign(techBreadth),
        Math.sign(predConsensus),
        Math.sign(councilConsensus),
      ];
      const nonNeutralSigns = signs.filter((s) => s !== 0);
      const bullishComponents = nonNeutralSigns.filter((s) => s > 0).length;
      const bearishComponents = nonNeutralSigns.filter((s) => s < 0).length;
      const dominantComponents = Math.max(
        bullishComponents,
        bearishComponents,
      );
      const confidence =
        nonNeutralSigns.length > 0
          ? dominantComponents / nonNeutralSigns.length
          : 0;

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
          techBreadth > 0
            ? `${techBull}/${totalTech} coins technically bullish`
            : `${techBear}/${totalTech} coins technically bearish`,
        );
      }
      if (Math.abs(predConsensus) > 0.15) {
        reasons.push(
          predConsensus > 0
            ? `${predBull}/${totalPred} prediction markets lean bullish`
            : `${predBear}/${totalPred} prediction markets lean bearish`,
        );
      }
      if (Math.abs(councilConsensus) > 0.15) {
        reasons.push(
          councilConsensus > 0
            ? `${cBuy}/${totalCouncil} council verdicts are BUY`
            : `${cSell}/${totalCouncil} council verdicts are SELL`,
        );
      }

      const agreementDirection =
        bullishComponents > bearishComponents
          ? "bullish"
          : bearishComponents > bullishComponents
            ? "bearish"
            : "mixed";
      if (nonNeutralSigns.length > 0) {
        reasons.push(
          `${dominantComponents}/${nonNeutralSigns.length} directional components agree ${agreementDirection}`,
        );
      }

      if (reasons.length === 0) reasons.push("signals mixed or unclear");

      // Diagnostic: αν τα technicals είναι 0, πρόσθεσέ το στο reasoning
      if (totalTech === 0) {
        reasons.push(
          `(technicals empty — window ${techsResult.window}${techsResult.error ? `, err: ${techsResult.error}` : ""})`,
        );
      }

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
    } catch (error) {
      console.error(
        "[REGIME] fatal market-regime calculation error:",
        serializeError(error),
      );
      return {
        whale: { buy_usd: 0, sell_usd: 0, net_pct: 0, sample_size: 0 },
        technicals: {
          bullish: 0,
          bearish: 0,
          neutral: 0,
          breadth: 0,
          sample_size: 0,
        },
        predictions: {
          bullish: 0,
          bearish: 0,
          neutral: 0,
          consensus: 0,
          sample_size: 0,
        },
        council: {
          buy: 0,
          sell: 0,
          hold: 0,
          avoid: 0,
          consensus: 0,
          sample_size: 0,
        },
        score: 0,
        confidence: 0,
        regime: "sideways",
        recommended_preset: "conservative",
        reasoning:
          "Market regime calculation temporarily unavailable; fail-safe sideways state.",
        generated_at: new Date().toISOString(),
      };
    }
  },
);

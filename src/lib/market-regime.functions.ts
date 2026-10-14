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

/* ───────────── Regime classification ───────────── */

// Components below their source-specific neutral band are treated as noise,
// not as directional votes. Values are normalized ratios in [-1, 1].
const WHALE_NEUTRAL_BAND = 0.05;
const TECH_NEUTRAL_BAND = 0.10;
const COUNCIL_NEUTRAL_BAND = 0.10;

function getDirectionalSign(value: number, band: number): number {
  if (!Number.isFinite(value) || value <= band && value >= -band) return 0;
  return value > band ? 1 : -1;
}

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

      const [whalesRes, councilRes] = await Promise.all([
        db
          .from("whale_alerts")
          .select("direction, usd_value")
          .gte("created_at", sixHoursAgo)
          .limit(5000),
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
      if (councilRes.error)
        console.error("[REGIME] council query:", serializeError(councilRes.error));


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
      const directionalCouncil = cBuy + cSell;
      // Market-regime consensus measures directional support across ALL current
      // council verdicts. HOLD/AVOID are not bearish votes, but they are also
      // not bullish support; excluding them inflated 4 BUY / 0 SELL to +100%.
      const councilConsensus =
        totalCouncil > 0 ? (cBuy - cSell) / totalCouncil : 0;

      // ── Composite regime score ──
      // Normalize remaining sources after removing prediction markets.
      const score =
        whaleNet * 0.375 +
        techBreadth * 0.5 +
        councilConsensus * 0.125;

      // ── Directional agreement with neutral deadbands ──
      // Agreement is measured against all three pillars, not only the
      // non-neutral subset; one bullish pillar + two neutral pillars = 33%.
      const signs = [
        getDirectionalSign(whaleNet, WHALE_NEUTRAL_BAND),
        getDirectionalSign(techBreadth, TECH_NEUTRAL_BAND),
        getDirectionalSign(councilConsensus, COUNCIL_NEUTRAL_BAND),
      ];
      const nonNeutralSigns = signs.filter((s) => s !== 0);
      const bullishComponents = signs.filter((s) => s > 0).length;
      const bearishComponents = signs.filter((s) => s < 0).length;
      const neutralComponents = signs.filter((s) => s === 0).length;
      const dominantComponents = Math.max(
        bullishComponents,
        bearishComponents,
      );
      const confidence =
        nonNeutralSigns.length > 0 ? dominantComponents / signs.length : 0;

      const regime = classifyRegime(score);
      const recommended_preset = recommendPreset(score, confidence);

      // ── Reasoning ──
      const reasons: string[] = [];
      if (Math.abs(whaleNet) >= WHALE_NEUTRAL_BAND) {
        reasons.push(
          `whales net ${whaleNet > 0 ? "buying" : "selling"} (${(Math.abs(whaleNet) * 100).toFixed(0)}% skew)`,
        );
      } else {
        reasons.push(`whale flow balanced/flat (${(whaleNet * 100).toFixed(1)}%)`);
      }

      if (totalTech === 0) {
        reasons.push("technicals unavailable");
      } else if (Math.abs(techBreadth) >= TECH_NEUTRAL_BAND) {
        reasons.push(
          techBreadth > 0
            ? `${techBull}/${totalTech} coins technically bullish`
            : `${techBear}/${totalTech} coins technically bearish`,
        );
      } else {
        reasons.push(`technicals neutral/mixed (${techNeu}/${totalTech} neutral)`);
      }

      if (Math.abs(councilConsensus) >= COUNCIL_NEUTRAL_BAND) {
        reasons.push(
          `${cBuy} BUY / ${cSell} SELL / ${cHold} HOLD / ${cAvoid} AVOID (${directionalCouncil}/${totalCouncil} directional verdicts)`,
        );
      } else if (totalCouncil === 0) {
        reasons.push("AI council awaiting signals");
      } else {
        reasons.push(`AI council neutral (${cHold} hold / ${cAvoid} avoid)`);
      }

      const agreementDirection =
        bullishComponents > bearishComponents
          ? "bullish"
          : bearishComponents > bullishComponents
            ? "bearish"
            : "neutral/mixed";
      if (dominantComponents >= 2) {
        reasons.push(
          `${dominantComponents}/3 components agree ${agreementDirection}`,
        );
      } else {
        reasons.push(
          `market signals fragmented/sideways (${neutralComponents}/3 neutral)`,
        );
      }

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

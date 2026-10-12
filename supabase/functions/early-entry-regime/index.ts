import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const supabase = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("POST required", { status: 405, headers: corsHeaders });
  try {
    const db = supabase();
    const now = new Date();
    const since1h = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    // Use recent 1h snapshots only; price confirmation is intentionally not a gate.
    const { data: indicators, error: indicatorError } = await db.from("indicator_snapshots")
      .select("symbol,timeframe,signal,created_at")
      .eq("timeframe", "1h").gte("created_at", since1h)
      .order("created_at", { ascending: false }).limit(3000);
    if (indicatorError) throw indicatorError;
    const latest = new Map<string, any>();
    for (const row of indicators ?? []) if (!latest.has(row.symbol)) latest.set(row.symbol, row);
    const breadth = { bullish: 0, bearish: 0, neutral: 0 };
    for (const row of latest.values()) {
      if (row.signal === "bullish") breadth.bullish++;
      else if (row.signal === "bearish") breadth.bearish++;
      else breadth.neutral++;
    }

    const { data: whales, error: whaleError } = await db.from("whale_alerts")
      .select("direction,usd_value,created_at").gte("created_at", since1h).limit(3000);
    if (whaleError) throw whaleError;
    let buyUsd = 0, sellUsd = 0;
    for (const row of whales ?? []) {
      const value = Number(row.usd_value) || 0;
      if (row.direction === "accumulation") buyUsd += value;
      if (row.direction === "distribution") sellUsd += value;
    }
    const whaleNet = buyUsd + sellUsd > 0 ? (buyUsd - sellUsd) / (buyUsd + sellUsd) : 0;
    const whaleState = whaleNet >= 0.15 ? "accumulation" : whaleNet <= -0.15 ? "distribution" : "neutral";

    const { data: previous } = await db.from("early_entry_regime_observations")
      .select("*").order("observed_at", { ascending: false }).limit(1).maybeSingle();

    // Use 1h breadth change over at least two observations, not price movement.
    // Require the actual transition: previous market regime was bearish/sideways,
    // while the current canonical regime has turned bullish. No price confirmation gate.
    const body = await req.json().catch(() => ({}));
    const regime = String(body.market_regime ?? "unknown").toLowerCase();
    const score = Number.isFinite(Number(body.market_regime_score)) ? Number(body.market_regime_score) : null;
    const breadthImproving = !!previous
      && breadth.bullish > Number(previous.technicals_1h_bullish ?? 0)
      && breadth.bearish < Number(previous.technicals_1h_bearish ?? 0);
    const whaleTurningPositive = whaleState === "accumulation"
      && (previous?.whale_flow_state === "distribution" || previous?.whale_flow_state === "neutral");
    const priorRegime = String(previous?.market_regime ?? "unknown").toLowerCase();
    const priorWasBearishOrSideways = ["bear", "bearish", "strong_bear", "strong_bearish", "sideways"].includes(priorRegime);
    const currentIsBullish = ["bull", "bullish", "strong_bull", "strong_bullish"].includes(regime);
    const finalTransition = !!previous && priorWasBearishOrSideways && currentIsBullish
      && breadthImproving && whaleTurningPositive ? "EARLY_ENTRY_ACTIVE" : "STRICT";

    const { error: obsError } = await db.from("early_entry_regime_observations").insert({
      observed_at: now.toISOString(), market_regime: regime, market_regime_score: score,
      whale_flow_state: whaleState, whale_flow_delta_pp: previous ? (whaleNet - Number(previous.details?.whale_net ?? 0)) * 100 : null,
      technicals_1h_bullish: breadth.bullish, technicals_1h_bearish: breadth.bearish,
      technicals_1h_neutral: breadth.neutral, breadth_baseline_at: previous?.observed_at ?? null,
      breadth_baseline_bullish: previous?.technicals_1h_bullish ?? null,
      breadth_baseline_bearish: previous?.technicals_1h_bearish ?? null,
      transition_state: finalTransition,
      details: { buy_usd: buyUsd, sell_usd: sellUsd, whale_net: whaleNet, breadth_improving: breadthImproving, whale_turning_positive: whaleTurningPositive, prior_regime: priorRegime, current_regime: regime },
    });
    if (obsError) throw obsError;

    // This function deliberately does not place exchange orders. Position creation is
    // wired only after the existing trade insertion contract and UI/watchdog are verified.
    return new Response(JSON.stringify({ status: "observed", transition_state: finalTransition, breadth, whale_state: whaleState, note: "No trade opened by this observation endpoint." }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[EARLY_ENTRY_REGIME]", error);
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

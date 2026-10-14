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
    // Prefer the canonical regime already stamped on recent composite signals.
    // Request-body values are only a fallback for explicitly supplied diagnostics.
    const { data: regimeRows, error: regimeError } = await db.from("composite_signals")
      .select("regime_label,created_at")
      .not("regime_label", "is", null)
      .gte("created_at", since1h)
      .order("created_at", { ascending: false })
      .limit(100);
    if (regimeError) throw regimeError;
    const canonicalRegime = (regimeRows ?? []).find((row) => row.regime_label)?.regime_label;
    const regime = String(canonicalRegime ?? body.market_regime ?? "unknown").toLowerCase();

    // Canonical Market Regime Score fallback. Missing components are neutral (0),
    // and their sample counts are recorded so a neutral fallback is observable.
    const suppliedRaw = body.market_regime_score;
    const suppliedScore = suppliedRaw !== undefined && suppliedRaw !== null && String(suppliedRaw).trim() !== ""
      ? Number(suppliedRaw) : Number.NaN;

    const { data: indicators4h, error: indicators4hError } = await db.from("indicator_snapshots")
      .select("symbol,signal,created_at")
      .eq("timeframe", "4h").gte("created_at", since1h)
      .order("created_at", { ascending: false }).limit(1000);
    if (indicators4hError) throw indicators4hError;
    const latest4h = new Map<string, string>();
    for (const row of indicators4h ?? []) {
      const sym = String(row.symbol ?? "").toUpperCase();
      if (sym && !latest4h.has(sym)) latest4h.set(sym, String(row.signal ?? "neutral").toLowerCase());
    }
    let tech4hBull = 0, tech4hBear = 0;
    for (const sig of latest4h.values()) {
      if (sig === "bullish") tech4hBull++;
      else if (sig === "bearish") tech4hBear++;
    }
    const techBreadth4h = latest4h.size ? (tech4hBull - tech4hBear) / latest4h.size : 0;

    const { data: councils, error: councilError } = await db.from("council_signals")
      .select("symbol,final_verdict,source_created_at")
      .gte("source_created_at", since1h)
      .order("source_created_at", { ascending: false }).limit(500);
    if (councilError) throw councilError;
    const latestCouncils = new Map<string, string>();
    for (const row of councils ?? []) {
      const sym = String(row.symbol ?? "").toUpperCase();
      if (sym && !latestCouncils.has(sym)) latestCouncils.set(sym, String(row.final_verdict ?? "").toUpperCase());
    }
    let councilBuy = 0, councilSell = 0;
    for (const verdict of latestCouncils.values()) {
      if (verdict === "BUY") councilBuy++;
      else if (verdict === "SELL") councilSell++;
    }
    const councilConsensus = latestCouncils.size ? (councilBuy - councilSell) / latestCouncils.size : 0;
    const computedScore = Number((whaleNet * 0.375 + techBreadth4h * 0.5 + councilConsensus * 0.125).toFixed(4));
    const score = Number.isFinite(suppliedScore) ? Number(suppliedScore.toFixed(4)) : computedScore;

    // Capture short-term aggressive-buy pressure from structured 5m candles.
    // This is an explanatory research feature, not a new entry gate or score weight.
    const since15m = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const { data: candles5m, error: candlesError } = await db.from("market_candles")
      .select("symbol,base_volume,taker_buy_base_volume,quote_volume,taker_buy_quote_volume,close_time")
      .eq("timeframe", "5m").gte("close_time", since15m)
      .order("close_time", { ascending: false }).limit(500);
    if (candlesError) throw candlesError;
    const latestCandles = new Map<string, any>();
    for (const row of candles5m ?? []) if (!latestCandles.has(row.symbol)) latestCandles.set(row.symbol, row);
    let candleBaseVolume = 0, takerBuyBaseVolume = 0, candleQuoteVolume = 0, takerBuyQuoteVolume = 0;
    for (const row of latestCandles.values()) {
      candleBaseVolume += Math.max(0, Number(row.base_volume) || 0);
      takerBuyBaseVolume += Math.max(0, Number(row.taker_buy_base_volume) || 0);
      candleQuoteVolume += Math.max(0, Number(row.quote_volume) || 0);
      takerBuyQuoteVolume += Math.max(0, Number(row.taker_buy_quote_volume) || 0);
    }
    const takerBuyImbalance5m = candleBaseVolume > 0
      ? Number((2 * takerBuyBaseVolume / candleBaseVolume - 1).toFixed(4)) : null;
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

    // A transition opens paper research positions on the currently bullish 1h symbols.
    // This is deliberately separate from composite-signal execution and never submits
    // exchange orders. The existing trade-executor watchdog manages exits from trades.
    const activationKey = previous
      ? `${previous.id}:${regime}:${breadth.bullish}:${breadth.bearish}:${whaleState}`
      : "";
    const opened: Array<{ id: string; symbol: string; entry_price: number }> = [];
    const entryErrors: Array<{ symbol: string; error: string }> = [];
    if (finalTransition === "EARLY_ENTRY_ACTIVE" && activationKey) {
      const candidates = [...latest.values()].filter((row) => row.signal === "bullish");
      const { data: alreadyOpened, error: duplicateError } = await db.from("trades")
        .select("id")
        .eq("entry_source", "early_entry_regime")
        .eq("mode", "paper")
        .eq("entry_metadata->>activation_key", activationKey)
        .limit(1)
        .maybeSingle();
      if (duplicateError) throw duplicateError;
      if (!alreadyOpened && candidates.length > 0) {
        const hosts = ["https://api.binance.com", "https://data-api.binance.vision", "https://api1.binance.com"];
        let prices = new Map<string, number>();
        for (const host of hosts) {
          try {
            const response = await fetch(`${host}/api/v3/ticker/price`, { signal: AbortSignal.timeout(8000) });
            if (!response.ok) continue;
            const rows = await response.json() as Array<{ symbol: string; price: string }>;
            prices = new Map(rows.map((row) => [row.symbol, Number(row.price)] as const).filter((row) => Number.isFinite(row[1]) && row[1] > 0));
            if (prices.size) break;
          } catch { /* Try the next public Binance Spot endpoint. */ }
        }
        for (const candidate of candidates) {
          const rawSymbol = String(candidate.symbol).replace(/[^A-Z0-9]/gi, "").toUpperCase();
          const base = rawSymbol.endsWith("USDT") ? rawSymbol.slice(0, -4) : rawSymbol;
          const mappedBase = base === "MATIC" ? "POL" : base === "RNDR" ? "RENDER" : base;
          const price = prices.get(`${mappedBase}USDT`);
          if (!price || !Number.isFinite(price) || price <= 0) {
            entryErrors.push({ symbol: candidate.symbol, error: "No valid Binance Spot USDT price" });
            continue;
          }
          const notional = 1000;
          const quantity = notional / price;
          const entryFee = notional * 0.0005;
          const { data: trade, error: tradeError } = await db.from("trades").insert({
            composite_signal_id: null,
            symbol: base,
            side: "buy",
            quantity,
            entry_price: price,
            stop_loss: price * 0.97,
            take_profit: price * 1.06,
            mode: "paper",
            status: "open",
            entry_fee: entryFee,
            exit_fee: 0,
            total_fees: entryFee,
            regime_label: regime,
            market_session: null,
            exchange_order_id: null,
            source_tags: ["paper", "early-entry-regime", "spot-long-only", "research-unbounded"],
            entry_source: "early_entry_regime",
            entry_metadata: {
              activation_key: activationKey,
              entry_reason: "bearish_or_sideways_to_bullish_regime_transition",
              market_regime: regime,
              market_regime_score: score,
              taker_buy_imbalance_5m: takerBuyImbalance5m,
              taker_buy_base_volume_5m: takerBuyBaseVolume,
              base_volume_5m: candleBaseVolume,
              taker_buy_quote_volume_5m: takerBuyQuoteVolume,
              quote_volume_5m: candleQuoteVolume,
              candle_symbols_5m: latestCandles.size,
              whale_flow_state: whaleState,
              whale_net: whaleNet,
              whale_buy_usd_1h: buyUsd,
              whale_sell_usd_1h: sellUsd,
              technicals_1h_bullish: breadth.bullish,
              technicals_1h_bearish: breadth.bearish,
              technicals_1h_neutral: breadth.neutral,
              breadth_baseline_at: previous?.observed_at ?? null,
              breadth_baseline_bullish: previous?.technicals_1h_bullish ?? null,
              breadth_baseline_bearish: previous?.technicals_1h_bearish ?? null,
              price_confirmation_required: false,
              research_only: true,
            },
          }).select("id,symbol,entry_price").single();
          if (tradeError) entryErrors.push({ symbol: candidate.symbol, error: tradeError.message });
          else opened.push(trade);
        }
      }
    }

    const { error: obsError } = await db.from("early_entry_regime_observations").insert({
      observed_at: now.toISOString(), market_regime: regime, market_regime_score: score,
      whale_flow_state: whaleState, whale_flow_delta_pp: previous ? (whaleNet - Number(previous.details?.whale_net ?? 0)) * 100 : null,
      technicals_1h_bullish: breadth.bullish, technicals_1h_bearish: breadth.bearish,
      technicals_1h_neutral: breadth.neutral, breadth_baseline_at: previous?.observed_at ?? null,
      breadth_baseline_bullish: previous?.technicals_1h_bullish ?? null,
      breadth_baseline_bearish: previous?.technicals_1h_bearish ?? null,
      transition_state: finalTransition,
      details: {
        buy_usd: buyUsd, sell_usd: sellUsd, whale_net: whaleNet,
        taker_buy_flow_5m: {
          imbalance: takerBuyImbalance5m,
          symbols: latestCandles.size,
          base_volume: candleBaseVolume,
          taker_buy_base_volume: takerBuyBaseVolume,
          quote_volume: candleQuoteVolume,
          taker_buy_quote_volume: takerBuyQuoteVolume,
          source: "market_candles/binance-spot-klines",
        },
        market_regime_score_components: {
          formula: "whaleNet*0.375 + techBreadth4h*0.5 + councilConsensus*0.125",
          supplied_score_used: Number.isFinite(suppliedScore),
          whale_net: whaleNet,
          tech_breadth_4h: techBreadth4h,
          tech_4h_symbols: latest4h.size,
          tech_4h_bullish: tech4hBull,
          tech_4h_bearish: tech4hBear,
          council_consensus: councilConsensus,
          council_symbols: latestCouncils.size,
          council_buy: councilBuy,
          council_sell: councilSell,
          missing_technical_component: latest4h.size === 0,
          missing_council_component: latestCouncils.size === 0,
        },
        breadth_improving: breadthImproving, whale_turning_positive: whaleTurningPositive,
        prior_regime: priorRegime, current_regime: regime,
        early_entry_opened: opened.length, early_entry_errors: entryErrors.length,
      },
    });
    if (obsError) throw obsError;

    return new Response(JSON.stringify({
      status: entryErrors.length ? "partial" : "observed",
      transition_state: finalTransition, breadth, whale_state: whaleState,
      opened_count: opened.length, opened, entry_errors: entryErrors,
      live_orders_submitted: 0,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[EARLY_ENTRY_REGIME]", error);
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

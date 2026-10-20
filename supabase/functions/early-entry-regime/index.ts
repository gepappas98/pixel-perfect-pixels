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

    const { data: recentObservations, error: recentObservationsError } = await db.from("early_entry_regime_observations")
      .select("id,observed_at,market_regime,whale_flow_state,technicals_1h_bullish,technicals_1h_bearish,details")
      .order("observed_at", { ascending: false }).limit(18);
    if (recentObservationsError) throw recentObservationsError;
    const previous = recentObservations?.[0] ?? null;

    // Use 1h breadth change over at least two observations, not price movement.
    // Require the actual transition: previous market regime was bearish/sideways,
    // while the current canonical regime has turned bullish. No price confirmation gate.
    const body = await req.json().catch(() => ({}));
    // Use the same canonical baseline regime as the Market Regime dashboard.
    // Fail closed when telemetry is missing/stale; composite signals may carry a different regime.
    const regimeFreshSince = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    const { data: regimeRows, error: regimeError } = await db.from("market_regime_telemetry")
      .select("baseline_regime,baseline_score,created_at,data_status")
      .eq("data_status", "ok")
      .gte("created_at", regimeFreshSince)
      .order("created_at", { ascending: false })
      .limit(1);
    if (regimeError) throw regimeError;
    const canonicalTelemetry = regimeRows?.[0] ?? null;
    const regime = String(canonicalTelemetry?.baseline_regime ?? "unknown").toLowerCase();
    const regimeTelemetryAt = canonicalTelemetry?.created_at ?? null;
    const regimeTelemetryScore = canonicalTelemetry?.baseline_score ?? null;

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
    // Taker-buy imbalance is calculated in quote volume (comparable USD notionals),
    // not by summing base units across different assets.
    const since15m = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const candleEvaluationAt = now.toISOString();
    const { data: candles5m, error: candlesError } = await db.from("market_candles")
      .select("symbol,timeframe,open_time,close_time,captured_at,source,base_volume,taker_buy_base_volume,quote_volume,taker_buy_quote_volume")
      .eq("timeframe", "5m").gte("close_time", since15m)
      .lt("close_time", candleEvaluationAt).lte("captured_at", candleEvaluationAt)
      .order("close_time", { ascending: false }).limit(500);
    if (candlesError) throw candlesError;
    const latestCandles = new Map<string, any>();
    for (const row of candles5m ?? []) if (Date.parse(String(row.close_time)) < now.getTime() && Date.parse(String(row.captured_at)) <= now.getTime() && !latestCandles.has(row.symbol)) latestCandles.set(row.symbol, row);
    // Store compact, immutable source candle identity separately from strategy JSON.
    const candleEvaluationId = crypto.randomUUID();
    const candleLineageRows = [...latestCandles.values()]
      .filter((c:any) => Date.parse(String(c.open_time)) < Date.parse(String(c.close_time))
        && Date.parse(String(c.close_time)) < now.getTime()
        && Date.parse(String(c.captured_at)) >= Date.parse(String(c.close_time))
        && Date.parse(String(c.captured_at)) <= now.getTime())
      .map((c:any) => ({ evaluation_id:candleEvaluationId, function_name:"early-entry-regime",
        symbol:String(c.symbol).toUpperCase(), timeframe:String(c.timeframe), open_time:c.open_time,
        close_time:c.close_time, captured_at:c.captured_at, source:String(c.source ?? "unknown") }));
    let candleLineageWriteStatus = candleLineageRows.length ? "pending" : "empty";
    if (candleLineageRows.length) {
      const { error: lineageError } = await db.from("early_entry_candle_lineage")
        .upsert(candleLineageRows, { onConflict:"evaluation_id,symbol,timeframe,open_time,source", ignoreDuplicates:true });
      if (lineageError) { candleLineageWriteStatus = "failed"; console.error("[EARLY_ENTRY_REGIME] candle lineage write failed", lineageError); }
      else candleLineageWriteStatus = "written";
    }
    let candleBaseVolume = 0, takerBuyBaseVolume = 0, candleQuoteVolume = 0, takerBuyQuoteVolume = 0;
    for (const row of latestCandles.values()) {
      candleBaseVolume += Math.max(0, Number(row.base_volume) || 0);
      takerBuyBaseVolume += Math.max(0, Number(row.taker_buy_base_volume) || 0);
      candleQuoteVolume += Math.max(0, Number(row.quote_volume) || 0);
      takerBuyQuoteVolume += Math.max(0, Number(row.taker_buy_quote_volume) || 0);
    }
    const takerBuyImbalance5m = candleQuoteVolume > 0
      ? Number((2 * takerBuyQuoteVolume / candleQuoteVolume - 1).toFixed(4)) : null;
    // Canonical weighted score: Whale 30%, 4h technical breadth 40%,
    // Council 10%, short-term taker-buy imbalance 20%.
    const computedScore = Number((whaleNet * 0.30 + techBreadth4h * 0.40
      + councilConsensus * 0.10 + (takerBuyImbalance5m ?? 0) * 0.20).toFixed(4));
    const score = canonicalTelemetry ? Number(canonicalTelemetry.baseline_score) : computedScore;


    const bearishOrSideways = (value: unknown) =>
      ["bear", "bearish", "strong_bear", "strong_bearish", "sideways"].includes(String(value ?? "unknown").toLowerCase());
    const bullishRegime = (value: unknown) =>
      ["bull", "bullish", "strong_bull", "strong_bullish"].includes(String(value ?? "unknown").toLowerCase());
    const currentIsBullish = bullishRegime(regime);
    const observationsChronological = [...(recentObservations ?? [])].reverse();
    let transitionObservation: any = null;
    let transitionBaseline: any = null;
    for (let i = 1; i < observationsChronological.length; i++) {
      const older = observationsChronological[i - 1];
      const newer = observationsChronological[i];
      if (bearishOrSideways(older.market_regime) && bullishRegime(newer.market_regime)
          && new Date(newer.observed_at).getTime() >= now.getTime() - 60 * 60 * 1000) {
        transitionObservation = newer;
        transitionBaseline = older;
      }
    }
    if (!transitionObservation && currentIsBullish && previous && bearishOrSideways(previous.market_regime)) {
      transitionObservation = { id: "current:" + now.toISOString(), observed_at: now.toISOString(), market_regime: regime };
      transitionBaseline = previous;
    }
    const transitionAgeMinutes = transitionObservation
      ? Math.max(0, (now.getTime() - new Date(transitionObservation.observed_at).getTime()) / 60000)
      : null;
    const transitionWindowActive = !!transitionObservation && transitionAgeMinutes !== null && transitionAgeMinutes <= 60;
    const breadthImproving = !!transitionBaseline
      && breadth.bullish > Number(transitionBaseline.technicals_1h_bullish ?? 0)
      && breadth.bearish < Number(transitionBaseline.technicals_1h_bearish ?? 0);
    const transitionWindowStart = transitionBaseline
      ? new Date(transitionBaseline.observed_at).getTime()
      : transitionObservation ? new Date(transitionObservation.observed_at).getTime() : 0;
    const whaleWasNeutralOrDistributionDuringWindow = observationsChronological.some((row) =>
      new Date(row.observed_at).getTime() >= transitionWindowStart
      && (String(row.whale_flow_state).toLowerCase() === "distribution"
        || String(row.whale_flow_state).toLowerCase() === "neutral"));
    const whaleTurningPositive = whaleState === "accumulation" && whaleWasNeutralOrDistributionDuringWindow;
    // Taker-buy is recorded as a booster/diagnostic, never as a hard entry gate.
    const takerBuyConfirmed = takerBuyImbalance5m !== null
      && takerBuyImbalance5m >= 0.05 && latestCandles.size >= 20;
    const finalTransition = transitionWindowActive && currentIsBullish
      && breadthImproving && whaleTurningPositive ? "EARLY_ENTRY_ACTIVE" : "STRICT";
    const gateDiagnostics = {
      regime_source: "market_regime_telemetry.baseline_regime",
      regime_telemetry_at: regimeTelemetryAt,
      regime_telemetry_score: regimeTelemetryScore,
      regime_telemetry_fresh: !!canonicalTelemetry,
      transition_window_active: transitionWindowActive,
      transition_observed_at: transitionObservation?.observed_at ?? null,
      transition_age_minutes: transitionAgeMinutes,
      transition_baseline_at: transitionBaseline?.observed_at ?? null,
      breadth_improving: breadthImproving,
      whale_turning_positive: whaleTurningPositive,
      whale_was_neutral_or_distribution_in_window: whaleWasNeutralOrDistributionDuringWindow,
      taker_buy_confirmed: takerBuyConfirmed,
      taker_buy_is_hard_gate: false,
      candle_evaluation_id: candleEvaluationId,
      candle_lineage_write_status: candleLineageWriteStatus,
      candle_evaluation_at: candleEvaluationAt,
      candle_latest_close_time: latestCandles.size ? new Date(Math.max(...[...latestCandles.values()].map((c: any) => Date.parse(String(c.close_time))))).toISOString() : null,
      candle_latest_captured_at: latestCandles.size ? new Date(Math.max(...[...latestCandles.values()].map((c: any) => Date.parse(String(c.captured_at))))).toISOString() : null,
    };

    // A transition opens paper research positions on the currently bullish 1h symbols.
    // This is deliberately separate from composite-signal execution and never submits
    // exchange orders. The existing trade-executor watchdog manages exits from trades.
    const activationKey = transitionObservation
      ? ["early-entry-transition", transitionObservation.observed_at].join(":")
      : "";
    const opened: Array<{ id: string; symbol: string; entry_price: number }> = [];
    const entryErrors: Array<{ symbol: string; error: string }> = [];
    if (finalTransition === "EARLY_ENTRY_ACTIVE" && activationKey) {
      const candidates = [...latest.values()]
        .filter((row) => row.signal === "bullish")
        .sort((a, b) => {
          const ca = latestCandles.get(String(a.symbol ?? "").toUpperCase());
          const cb = latestCandles.get(String(b.symbol ?? "").toUpperCase());
          const ia = ca && Number(ca.quote_volume) > 0 ? 2 * Number(ca.taker_buy_quote_volume || 0) / Number(ca.quote_volume) - 1 : -2;
          const ib = cb && Number(cb.quote_volume) > 0 ? 2 * Number(cb.taker_buy_quote_volume || 0) / Number(cb.quote_volume) - 1 : -2;
          return ib - ia;
        })
        .slice(0, 5); // Limit each transition to five paper entries; taker-buy only prioritizes candidates.
      const { data: alreadyOpened, error: duplicateError } = await db.from("trades")
        .select("symbol")
        .eq("entry_source", "early_entry_regime")
        .eq("mode", "paper")
        .eq("entry_metadata->>activation_key", activationKey);
      if (duplicateError) throw duplicateError;
      const openedSymbols = new Set((alreadyOpened ?? []).map((row) => String(row.symbol ?? "").toUpperCase()));
      if (candidates.length > 0) {
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
          if (openedSymbols.has(base)) continue;
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
            source_tags: ["paper", "early-entry-regime", "spot-long-only", "research-unbounded", "purple-label"],
            entry_source: "early_entry_regime",
            entry_metadata: {
              strategy: "early-entry-regime-v1",
              strategy_version: 1,
              entry_path: "early-entry-regime",
              variant: "A_CURRENT",
              activation_key: activationKey,
              transition_observed_at: transitionObservation?.observed_at ?? null,
              transition_age_minutes: transitionAgeMinutes,
              candle_evaluation_id: candleEvaluationId,
              candle_lineage_write_status: candleLineageWriteStatus,
              gate_diagnostics: gateDiagnostics,
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
          else {
            opened.push(trade);
            openedSymbols.add(String(trade.symbol ?? "").toUpperCase());
          }
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
          formula: "whaleNet*0.30 + techBreadth4h*0.40 + councilConsensus*0.10 + takerBuyImbalance5m*0.20",
          weights: { whale: 0.30, technical_breadth_4h: 0.40, council: 0.10, taker_buy_5m: 0.20 },
          supplied_score_ignored: Number.isFinite(suppliedScore),
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
        ...gateDiagnostics,
        prior_regime: transitionBaseline?.market_regime ?? previous?.market_regime ?? "unknown",
        current_regime: regime,
        early_entry_opened: opened.length, early_entry_errors: entryErrors.length,
      },
    });
    if (obsError) throw obsError;

    return new Response(JSON.stringify({
      status: entryErrors.length ? "partial" : "observed",
      transition_state: finalTransition, breadth, whale_state: whaleState,
      gate_diagnostics: gateDiagnostics,
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

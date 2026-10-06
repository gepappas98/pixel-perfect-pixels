import { handleOptions, corsHeaders } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const WATCHLIST = [
  "BTC", "ETH", "SOL", "CRV", "LINK", "ARB", "DOGE", "XRP", "AVAX", "ADA", "MATIC",
];

const SYMBOL_MAP: Record<string, string> = {
  MATIC: "POL",
  RNDR: "RENDER",
};

const TIMEFRAMES = ["4h", "1h", "1d"] as const;
const INDICATOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PREDICTION_MAX_AGE_MS = 30 * 60 * 1000;
const COUNCIL_MAX_AGE_MS = 30 * 60 * 1000;
const WHALE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

type Direction = "bullish" | "bearish" | "neutral";

interface MtfGateConfig {
  enabled: boolean;
  shadow_mode: boolean;
  min_timeframes: number;
}

const VARIANT_PRESETS: Record<string, { whale: number; technicals: number; prediction: number; council: number }> = {
  balanced: { whale: 1, technicals: 1, prediction: 1, council: 1 },
  "whale-focused": { whale: 2, technicals: 0.5, prediction: 0.5, council: 0.5 },
  "chart-trader": { whale: 0.5, technicals: 2, prediction: 0.5, council: 0.5 },
  "sentiment-first": { whale: 0.5, technicals: 0.5, prediction: 2, council: 0.5 },
  "ai-driven": { whale: 0.5, technicals: 0.5, prediction: 0.5, council: 2 },
  conservative: { whale: 1.2, technicals: 1.2, prediction: 1.2, council: 1.2 },
  "volatility-timing": { whale: 0.3, technicals: 2.2, prediction: 0.5, council: 1 },
  "vwap-momentum": { whale: 0.5, technicals: 2.2, prediction: 0.5, council: 0.8 },
  "smc-reversal": { whale: 0.4, technicals: 2.5, prediction: 0.4, council: 0.8 },
};

const DEFAULT_MTF_GATE: MtfGateConfig = {
  enabled: false,
  shadow_mode: true,
  min_timeframes: 2,
};

type StrategyWeights = {
  whale: number;
  technicals: number;
  prediction: number;
  council: number;
};

type StrategySnapshot = StrategyWeights & {
  preset_name: string | null;
  updated_at: string | null;
};

async function loadStrategySnapshot(supabase: ReturnType<typeof getServiceClient>): Promise<StrategySnapshot | null> {
  const { data, error } = await supabase
    .from("strategy_config")
    .select("whale_weight,technicals_weight,prediction_weight,council_weight,preset_name,updated_at")
    .eq("id", 1)
    .maybeSingle();

  if (error || !data) {
    console.error("[STRATEGY_SHADOW] strategy_config load failed:", error?.message ?? "missing row");
    return null;
  }

  return {
    whale: Number(data.whale_weight),
    technicals: Number(data.technicals_weight),
    prediction: Number(data.prediction_weight),
    council: Number(data.council_weight),
    preset_name: data.preset_name ?? null,
    updated_at: data.updated_at ?? null,
  };
}

function calculateConfiguredShadow(
  whale: any | null,
  indicator: any | null,
  prediction: any | null,
  council: any | null,
  weights: StrategyWeights,
) {
  let score = 0;
  if (whale?.direction === "accumulation") score += weights.whale;
  if (whale?.direction === "distribution") score -= weights.whale;
  if (indicator?.signal === "bullish") score += weights.technicals;
  if (indicator?.signal === "bearish") score -= weights.technicals;
  if (prediction?.yes_price != null) {
    if (Number(prediction.yes_price) > 0.6) score += 0.5 * weights.prediction;
    else if (Number(prediction.yes_price) < 0.4) score -= 0.5 * weights.prediction;
  }
  if (council?.final_verdict) {
    const conviction = Number(council.conviction ?? 50) / 100;
    const verdict = String(council.final_verdict).toUpperCase();
    if (verdict === "BUY") score += conviction * 1.5 * weights.council;
    else if (verdict === "SELL" || verdict === "AVOID") score -= conviction * 1.5 * weights.council;
  }

  const max = weights.whale + weights.technicals + 0.5 * weights.prediction + 1.5 * weights.council;
  const confidence = max > 0 ? Math.min(1, Math.abs(score) / max) : 0;
  const recommendation = score >= 1.5 ? "buy" : score <= -1.5 ? "sell" : Math.abs(score) < 0.5 ? "hold" : "watch";
  return { score, confidence, recommendation };
}

function indicatorSymbol(symbol: string) {
  return `${SYMBOL_MAP[symbol] ?? symbol}USDT`;
}

function fresh(row: any): boolean {
  const ts = new Date(String(row?.created_at ?? "")).getTime();
  return Number.isFinite(ts) && Date.now() - ts >= 0 && Date.now() - ts <= INDICATOR_MAX_AGE_MS;
}

function classifyMtf(rows: Record<string, any>[]) {
  const byTf = new Map<string, Record<string, any>>();
  for (const row of rows) {
    const tf = String(row.timeframe);
    if (TIMEFRAMES.includes(tf as any) && !byTf.has(tf) && fresh(row)) byTf.set(tf, row);
  }
  const primary = byTf.get("4h") ?? null;
  const fast = byTf.get("1h") ?? null;
  const trend = byTf.get("1d") ?? null;

  const p: Direction = primary?.signal ?? "neutral";
  let f: Direction = fast?.signal ?? "neutral";
  const t: Direction = trend?.signal ?? "neutral";

  const fastPrice = Number(fast?.price ?? 0);
  const fastVwap = Number(fast?.raw?.vwap ?? 0);
  const fastRsi = Number(fast?.rsi ?? 50);
  if (fastPrice > 0 && fastVwap > 0) {
    if (fastRsi >= 60 && fastPrice > fastVwap) f = "bullish";
    else if (fastRsi <= 40 && fastPrice < fastVwap) f = "bearish";
  }

  const bullCount = [p, f, t].filter((x) => x === "bullish").length;
  const bearCount = [p, f, t].filter((x) => x === "bearish").length;
  const neuCount = [p, f, t].filter((x) => x === "neutral").length;

  return {
    primary,
    fast,
    trend,
    p,
    f,
    t,
    bullCount,
    bearCount,
    neuCount,
    detail: `4h ${p === "bullish" ? "bull" : p === "bearish" ? "bear" : "neu"} · 1h ${f === "bullish" ? "bull" : f === "bearish" ? "bear" : "neu"} · 1d ${t === "bullish" ? "bull" : t === "bearish" ? "bear" : "neu"}`,
  };
}

function classifyProductionRegime(input: {
  whales: any[];
  indicators: any[];
  predictions: any[];
  councils: any[];
}): string {
  let buyUsd=0, sellUsd=0;
  for (const w of input.whales) {
    const v=Number(w?.usd_value)||0;
    if(w?.direction==="accumulation") buyUsd+=v;
    else if(w?.direction==="distribution") sellUsd+=v;
  }
  const whaleNet=(buyUsd+sellUsd)>0?(buyUsd-sellUsd)/(buyUsd+sellUsd):0;
  const seenTech=new Set<string>(); let tb=0,tr=0,tn=0;
  for(const i of input.indicators){
    if(i?.timeframe!=="4h") continue;
    const s=String(i?.symbol); if(seenTech.has(s)) continue; seenTech.add(s);
    if(i?.signal==="bullish") tb++; else if(i?.signal==="bearish") tr++; else tn++;
  }
  const techBreadth=(tb+tr+tn)>0?(tb-tr)/(tb+tr+tn):0;
  const seenPred=new Set<string>(); let pb=0,pr=0,pn=0;
  for(const p of input.predictions){
    const slug=String(p?.market_slug); if(seenPred.has(slug)) continue; seenPred.add(slug);
    const yes=Number(p?.yes_price); if(!Number.isFinite(yes)){pn++;continue;}
    const q=String(p?.question??"").toLowerCase();
    const bullish=/\b(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\b/i.test(q);
    const bearish=/\b(dip|drop|fall|below|crash|down to|under|bottom)\b/i.test(q);
    if(!bullish&&!bearish){pn++;continue;}
    const up=bullish?yes:1-yes; if(up>0.6) pb++; else if(up<0.4) pr++; else pn++;
  }
  const predConsensus=(pb+pr+pn)>0?(pb-pr)/(pb+pr+pn):0;
  const seenCouncil=new Set<string>(); let cb=0,cs=0;
  for(const x of input.councils){
    const s=String(x?.symbol); if(seenCouncil.has(s)) continue; seenCouncil.add(s);
    const v=String(x?.final_verdict??"").toUpperCase();
    if(v==="BUY") cb++; else if(v==="SELL") cs++;
  }
  const councilConsensus=seenCouncil.size>0?(cb-cs)/seenCouncil.size:0;
  const score=whaleNet*0.3+techBreadth*0.4+predConsensus*0.2+councilConsensus*0.1;
  if(score>=0.5) return "strong_bull";
  if(score>=0.15) return "bull";
  if(score<=-0.5) return "strong_bear";
  if(score<=-0.15) return "bear";
  return "sideways";
}
function productionSession(): string {
  const h=new Date().getUTCHours();
  if(h>=13&&h<17) return "eu_us_overlap";
  if(h>=17&&h<22) return "us";
  if(h>=7&&h<13) return "european";
  if(h>=22) return "off_hours";
  return "asian";
}

function calculateVariant(
  whale: any | null,
  mtf: ReturnType<typeof classifyMtf>,
  prediction: any | null,
  council: any | null,
  weights: { whale: number; technicals: number; prediction: number; council: number },
) {
  let score = 0;
  const reasons: string[] = [];
  if (whale?.direction === "accumulation") { score += weights.whale; reasons.push("whale accumulation"); }
  if (whale?.direction === "distribution") { score -= weights.whale; reasons.push("whale distribution"); }
  if (mtf.p === "bullish") { score += weights.technicals; reasons.push("bullish technicals"); }
  if (mtf.p === "bearish") { score -= weights.technicals; reasons.push("bearish technicals"); }
  if (prediction?.yes_price != null) {
    if (Number(prediction.yes_price) > 0.6) { score += 0.5 * weights.prediction; reasons.push("prediction bullish"); }
    else if (Number(prediction.yes_price) < 0.4) { score -= 0.5 * weights.prediction; reasons.push("prediction bearish"); }
  }
  if (council?.final_verdict) {
    const conviction = Number(council.conviction ?? 50) / 100;
    const verdict = String(council.final_verdict).toUpperCase();
    if (verdict === "BUY") { score += conviction * 1.5 * weights.council; reasons.push("council BUY"); }
    else if (verdict === "SELL") { score -= conviction * 1.5 * weights.council; reasons.push("council SELL"); }
  }
  const max = weights.whale + weights.technicals + 0.5 * weights.prediction + 1.5 * weights.council;
  const confidence = max > 0 ? Math.min(1, Math.abs(score) / max) : 0;
  const recommendation = score >= 2.2 ? "buy" : score <= -2.2 ? "sell" : Math.abs(score) < 0.5 ? "hold" : "watch";
  return { recommendation, confidence, score, reasoning: reasons.length ? reasons.join("; ") : "insufficient signal" };
}

function applyMtfGate(
  recommendation: string,
  mtf: ReturnType<typeof classifyMtf>,
  config: MtfGateConfig,
) {
  if (!["buy", "sell"].includes(recommendation)) {
    return { recommendation, note: null };
  }

  const confirming = recommendation === "buy" ? mtf.bullCount : mtf.bearCount;
  const passed = confirming >= config.min_timeframes;
  if (passed) {
    return {
      recommendation,
      note: `MTF gate PASSED: ${confirming}/${TIMEFRAMES.length} confirm ${recommendation} (${mtf.detail})`,
    };
  }

  const note = `MTF gate REJECTED: only ${confirming}/${TIMEFRAMES.length} confirm ${recommendation} (${mtf.detail})`;
  if (config.enabled) return { recommendation: "hold", note };
  if (config.shadow_mode) return { recommendation, note: `MTF gate SHADOW: ${note}` };
  return { recommendation, note: null };
}

function ruleBasedRecommendation(
  whale: any | null,
  indicator: any | null,
  prediction: any | null,
  council: any | null,
): { recommendation: string; confidence: number; reasoning: string } {
  let score = 0;
  const reasons: string[] = [];

  if (whale?.direction === "accumulation") {
    score += 1;
    reasons.push("whale accumulation");
  }
  if (whale?.direction === "distribution") {
    score -= 1;
    reasons.push("whale distribution");
  }

  if (indicator?.signal === "bullish") {
    score += 1;
    reasons.push("bullish technicals (4h)");
  }
  if (indicator?.signal === "bearish") {
    score -= 1;
    reasons.push("bearish technicals (4h)");
  }

  if (prediction?.yes_price != null) {
    if (prediction.yes_price > 0.6) {
      score += 0.5;
      reasons.push("prediction market leaning yes");
    }
    if (prediction.yes_price < 0.4) {
      score -= 0.5;
      reasons.push("prediction market leaning no");
    }
  }

  if (council?.final_verdict) {
    const weight = (council.conviction ?? 50) / 100 * 1.5;
    const verdict = String(council.final_verdict).toUpperCase();
    if (verdict === "BUY") {
      score += weight;
      reasons.push(`council: BUY (${council.conviction}% conviction)`);
    } else if (verdict === "SELL") {
      score -= weight;
      reasons.push(`council: SELL (${council.conviction}% conviction)`);
    } else if (verdict === "AVOID") {
      score -= weight;
      reasons.push(`council: AVOID (${council.conviction}% conviction)`);
    }
  }

  const confidence = Math.min(1, Math.abs(score) / 3);
  let recommendation: "buy" | "sell" | "hold" | "watch" = "watch";
  if (score >= 1.5) recommendation = "buy";
  else if (score <= -1.5) recommendation = "sell";
  else if (Math.abs(score) < 0.5) recommendation = "hold";

  return {
    recommendation,
    confidence,
    reasoning: reasons.length ? reasons.join("; ") : "insufficient signal",
  };
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const supabase = getServiceClient();

    const { data: settings } = await supabase
      .from("pipeline_settings")
      .select("cleanup_config")
      .eq("id", 1)
      .maybeSingle();

    const cleanup = settings?.cleanup_config ?? {};
    const mtfGate: MtfGateConfig = {
      ...DEFAULT_MTF_GATE,
      ...(cleanup.mtf_confirmation_gate ?? {}),
    };
    const strategySnapshot = await loadStrategySnapshot(supabase);

    const since = new Date(Date.now() - WHALE_LOOKBACK_MS).toISOString();
    const predictionSince = new Date(Date.now() - PREDICTION_MAX_AGE_MS).toISOString();
    const councilSince = new Date(Date.now() - COUNCIL_MAX_AGE_MS).toISOString();

    const [{ data: councilSymbolRows }, { data: whaleSymbolRows }] = await Promise.all([
      supabase.from("council_signals").select("symbol").order("source_created_at", { ascending: false }),
      supabase.from("whale_alerts").select("symbol").gte("created_at", since),
    ]);

    const [{ data: regimeWhales }, { data: regimeIndicators }, { data: regimePredictions }, { data: regimeCouncils }] = await Promise.all([
      supabase.from("whale_alerts").select("symbol,direction,usd_value").gte("created_at", new Date(Date.now()-60*60*1000).toISOString()).limit(3000),
      supabase.from("indicator_snapshots").select("symbol,timeframe,signal,created_at").eq("timeframe","4h").order("created_at",{ascending:false}).limit(1000),
      supabase.from("prediction_snapshots").select("market_slug,question,yes_price,created_at").gte("created_at", predictionSince).order("created_at",{ascending:false}).limit(1000),
      supabase.from("council_signals").select("symbol,final_verdict,source_created_at").gte("source_created_at", councilSince).order("source_created_at",{ascending:false}).limit(1000),
    ]);
    const productionRegimeLabel = classifyProductionRegime({
      whales: regimeWhales ?? [], indicators: regimeIndicators ?? [],
      predictions: regimePredictions ?? [], councils: regimeCouncils ?? [],
    });
    const productionMarketSession = productionSession();

    const councilSymbols = [...new Set((councilSymbolRows ?? []).map((r: any) => r.symbol))];
    const whaleSymbols = [...new Set((whaleSymbolRows ?? []).map((r: any) => r.symbol))];
    const symbols = [...new Set([...WATCHLIST, ...councilSymbols, ...whaleSymbols])];

    const created = [];

    for (const symbol of symbols) {
      const dbSymbol = indicatorSymbol(symbol);

      const [{ data: whales }, { data: indicators }, { data: predictions }, { data: councils }] =
        await Promise.all([
          supabase.from("whale_alerts").select("*").eq("symbol", symbol).gte("created_at", since)
            .order("created_at", { ascending: false }).limit(20),
          supabase.from("indicator_snapshots").select("*").eq("symbol", dbSymbol)
            .in("timeframe", [...TIMEFRAMES])
            .order("created_at", { ascending: false }).limit(10),
          supabase.from("prediction_snapshots").select("*").eq("related_symbol", symbol).gte("created_at", predictionSince)
            .order("created_at", { ascending: false }).limit(1),
          supabase.from("council_signals").select("*").eq("symbol", symbol).gte("source_created_at", councilSince)
            .order("source_created_at", { ascending: false }).limit(1),
        ]);

      const whaleRows = whales ?? [];
      const whale = whaleRows[0] ?? null;
      const prediction = predictions?.[0] ?? null;
      const council = councils?.[0] ?? null;
      const mtf = classifyMtf((indicators ?? []) as Record<string, any>[]);
      const indicator = mtf.primary;

      if (!whale && !indicator && !prediction && !council) continue;

      const result = ruleBasedRecommendation(whale, indicator, prediction, council);
      const gate = applyMtfGate(result.recommendation, mtf, mtfGate);

      if (strategySnapshot) {
        const shadow = calculateConfiguredShadow(whale, indicator, prediction, council, strategySnapshot);
        const { error: shadowError } = await supabase
          .from("strategy_shadow_diagnostics")
          .insert({
            symbol,
            strategy_preset: strategySnapshot.preset_name,
            strategy_updated_at: strategySnapshot.updated_at,
            whale_weight: strategySnapshot.whale,
            technicals_weight: strategySnapshot.technicals,
            prediction_weight: strategySnapshot.prediction,
            council_weight: strategySnapshot.council,
            current_score: result.recommendation === "buy" ? result.confidence : result.recommendation === "sell" ? -result.confidence : 0,
            current_recommendation: gate.recommendation,
            shadow_score: shadow.score,
            shadow_confidence: shadow.confidence,
            shadow_recommendation: shadow.recommendation,
          });
        if (shadowError) throw shadowError;
      }

      const reasoningParts = [result.reasoning];
      if (mtf.primary || mtf.fast || mtf.trend) reasoningParts.push(`MTF: ${mtf.detail}`);
      if (gate.note) reasoningParts.push(gate.note);

      // Observational strategy variants: same canonical inputs, isolated from composite signal/trades.
      // Long-only benchmark: only BUY variants are persisted.
      const variantEntryPrice = Number(indicator?.price ?? 0);
      if (variantEntryPrice > 0) {
        const variantRows = Object.entries(VARIANT_PRESETS)
          .map(([strategy_name, weights]) => {
            const vr = calculateVariant(whale, mtf, prediction, council, weights);
            return {
              strategy_name,
              symbol,
              confidence: vr.confidence,
              recommendation: vr.recommendation,
              reasoning: vr.reasoning,
              score: vr.score,
              entry_price: variantEntryPrice,
              outcome: "open",
              production_regime_label: productionRegimeLabel,
              regime_label: productionRegimeLabel,
              market_session: productionMarketSession,
              created_at: new Date().toISOString(),
              source_fingerprint: [
                strategy_name, symbol,
                indicator?.id ?? "", mtf.fast?.id ?? "", mtf.trend?.id ?? "",
                prediction?.id ?? "", council?.id ?? ""
              ].join("|"),
            };
          })
          .filter((v) => v.recommendation === "buy");
        if (variantRows.length) {
          const { error: variantError } = await supabase
            .from("strategy_variant_signals")
            .upsert(variantRows, { onConflict: "source_fingerprint", ignoreDuplicates: true });
          if (variantError) throw variantError;
        }
      }

      const { data: inserted, error } = await supabase
        .from("composite_signals")
        .insert({
          symbol,
          whale_alert_id: whale?.id ?? null,
          indicator_snapshot_id: indicator?.id ?? null,
          prediction_snapshot_id: prediction?.id ?? null,
          council_signal_id: council?.id ?? null,
          confidence: result.confidence,
          recommendation: gate.recommendation,
          reasoning: reasoningParts.join("; "),
        })
        .select()
        .single();

      if (error) throw error;
      created.push(inserted);
    }

    return new Response(
      JSON.stringify({
        created: created.length,
        mtf_gate: mtfGate,
        signals: created,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[SIGNAL_COMBINER] fatal:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
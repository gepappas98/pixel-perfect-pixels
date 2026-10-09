import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function handleOptions(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders });
}
function getServiceClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}


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

function predictionDirectionForShadow(prediction: any | null): "bullish" | "bearish" | "neutral" {
  const yes = Number(prediction?.yes_price);
  if (!Number.isFinite(yes)) return "neutral";
  const q = String(prediction?.question ?? "").toLowerCase();
  const bullish = /\b(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\b/i.test(q);
  const bearish = /\b(dip|drop|fall|below|crash|down to|under|bottom)\b/i.test(q);
  if (!bullish && !bearish) return "neutral";
  const up = bullish ? yes : 1 - yes;
  if (up > 0.6) return "bullish";
  if (up < 0.4) return "bearish";
  return "neutral";
}

function predictionMagnitudeForShadow(prediction: any | null): number {
  const yes = Number(prediction?.yes_price);
  if (!Number.isFinite(yes)) return 0;
  const q = String(prediction?.question ?? "").toLowerCase();
  const bullish = /\b(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\b/i.test(q);
  const bearish = /\b(dip|drop|fall|below|crash|down to|under|bottom)\b/i.test(q);
  if (!bullish && !bearish) return 0;
  const up = bullish ? yes : 1 - yes;
  const distance = Math.abs(up - 0.5) * 2;
  if (distance < 0.2) return 0;
  return Math.min(1, (distance - 0.2) / 0.8);
}

/**
 * Historical strategy-authority shadow.
 *
 * This mirrors the proven legacy ruleBased() scoring contract for the
 * dimensions available in the canonical Edge combiner:
 * - strategy_config weights are authoritative inputs
 * - MTF score × technical weight
 * - prediction direction + magnitude
 * - council conviction × 0.75 × council weight
 * - historical ±2.2 / 0.5 classification
 * - hard whale/prediction conflict => HOLD
 *
 * It is diagnostic-only for now. The live composite recommendation remains
 * unchanged until parity is verified.
 */
function calculateConfiguredShadow(
  whale: any | null,
  mtf: ReturnType<typeof classifyMtf> | null,
  prediction: any | null,
  council: any | null,
  weights: StrategyWeights,
) {
  // Defensive runtime normalization: diagnostic shadow must never be able to
  // take down the canonical signal-combiner if an unexpected null MTF payload
  // reaches this helper. Treat a missing MTF context as fully neutral.
  const safeMtf = mtf ?? classifyMtf([]);
  let score = 0;
  let hardConflict = false;
  const components = { whale: 0, technicals: 0, prediction: 0, council: 0 };

  if (whale?.direction === "accumulation") { components.whale = weights.whale; score += components.whale; }
  else if (whale?.direction === "distribution") { components.whale = -weights.whale; score += components.whale; }

  // Historical evaluateMultiTimeframe() score:
  // primary direction is ±1, matching fast/trend multiplies 1.3,
  // conflicting non-neutral timeframes multiply 0.7.
  if (safeMtf.p !== "neutral") {
    let mtfScore = safeMtf.p === "bullish" ? 1 : -1;
    if (safeMtf.f === safeMtf.p) mtfScore *= 1.3;
    else if (safeMtf.f !== "neutral") mtfScore *= 0.7;
    if (safeMtf.t === safeMtf.p) mtfScore *= 1.3;
    else if (safeMtf.t !== "neutral") mtfScore *= 0.7;
    components.technicals = mtfScore * weights.technicals;
    score += components.technicals;
  }

  const predDir = predictionDirectionForShadow(prediction);
  const predictionContribution = 0.5 * weights.prediction * predictionMagnitudeForShadow(prediction);
  if (predDir === "bullish") { components.prediction = predictionContribution; score += predictionContribution; }
  else if (predDir === "bearish") { components.prediction = -predictionContribution; score += components.prediction; }

  if (council?.final_verdict) {
    const convictionRaw = Number(council.conviction);
    const conviction = Number.isFinite(convictionRaw) ? Math.max(0, Math.min(100, convictionRaw)) : 50;
    const councilWeight = (conviction / 100) * 0.75 * weights.council;
    const verdict = String(council.final_verdict).toUpperCase();
    if (verdict === "BUY") { components.council = councilWeight; score += components.council; }
    else if (verdict === "SELL") { components.council = -councilWeight; score += components.council; }
  }

  const whaleDir = whale?.direction === "accumulation" ? 1 : whale?.direction === "distribution" ? -1 : 0;
  const predSign = predDir === "bullish" ? 1 : predDir === "bearish" ? -1 : 0;
  const techSign = safeMtf.p === "bullish" ? 1 : safeMtf.p === "bearish" ? -1 : 0;
  hardConflict = whaleDir !== 0 && predSign !== 0 && whaleDir !== predSign && techSign === 0;

  let recommendation: "buy" | "sell" | "hold" | "watch" = "hold";
  if (hardConflict) recommendation = "hold";
  else if (score >= 2.2) recommendation = "buy";
  else if (score <= -2.2) recommendation = "sell";
  else if (Math.abs(score) < 0.5) recommendation = "hold";
  else recommendation = "watch";

  const max = weights.whale + weights.technicals * 1.69 + weights.prediction * 0.5 + weights.council * 0.75;
  const confidence = max > 0 ? Math.min(1, Math.abs(score) / max) : 0;
  return {
    score,
    confidence,
    recommendation,
    components,
    mtf: { p: safeMtf.p, f: safeMtf.f, t: safeMtf.t, bullCount: safeMtf.bullCount, bearCount: safeMtf.bearCount, neuCount: safeMtf.neuCount },
    hardConflict,
  };
}

function indicatorSymbol(symbol: string) {
  return `${SYMBOL_MAP[symbol] ?? symbol}USDT`;
}

// Research variants are resolved with Binance Spot candles. Never admit symbols
// that are not currently Spot-tradable, and fail closed for variant creation if
// Binance metadata cannot be verified. This gate must not affect composite signals.
async function loadBinanceSpotTradingSymbols(): Promise<Set<string> | null> {
  try {
    const response = await fetch("https://api.binance.com/api/v3/exchangeInfo", {
      signal: AbortSignal.timeout(10_000),
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) throw new Error(`exchangeInfo HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.symbols)) throw new Error("exchangeInfo response missing symbols array");
    return new Set<string>(payload.symbols
      .filter((item: any) => item?.status === "TRADING" && item?.isSpotTradingAllowed === true)
      .map((item: any) => String(item.symbol)));
  } catch (error) {
    console.error("[SPOT_VARIANT_GATE] exchangeInfo validation failed; skipping new shadow variants for this run:", String(error));
    return null;
  }
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

function calculateAccumulationVariant(indicator1d: any | null) {
  const a = indicator1d?.raw?.accumulation;
  if (!a || !Number.isFinite(Number(a.score))) {
    return { recommendation: "watch", confidence: 0, score: 0, reasoning: "accumulation features unavailable" };
  }
  const score = Math.max(0, Math.min(100, Number(a.score)));
  const recommendation = score >= 60 ? "buy" : "watch";
  const confidence = score / 100;
  const reasons: string[] = [];
  if (Number(a.cmf20) > 0) reasons.push("CMF positive");
  if (Number(a.obvChangePct20) > 0) reasons.push("OBV rising");
  if (Number(a.atrCompressionPct) >= 15) reasons.push("ATR compression");
  if (Number(a.volumeRatio) >= 1) reasons.push("volume above 20d average");
  if (Number(a.ma20) > 0 && Number(indicator1d?.price) >= Number(a.ma20)) reasons.push("price above MA20");
  if (Number(a.ma50) > 0 && Number(indicator1d?.price) >= Number(a.ma50)) reasons.push("price above MA50");
  if (a.breakoutConfirmed) reasons.push("breakout + volume confirmed");
  return {
    recommendation,
    confidence,
    score,
    reasoning: reasons.length ? reasons.join("; ") : "accumulation conditions not confirmed",
  };
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

function calculateMtfCounterfactual(
  result: { score: number; components: { whale: number; technicals: number; prediction: number; council: number } },
  mtf: ReturnType<typeof classifyMtf>,
  whale: any | null,
  council: any | null,
) {
  const rejectedBuy = result.score >= 1.5 && mtf.bullCount < 2;
  const whalePositive = whale?.direction === "accumulation" && result.components.whale > 0;
  const councilBuy = String(council?.final_verdict ?? "").toUpperCase() === "BUY"
    && Number(council?.conviction ?? 0) > 0
    && result.components.council > 0;
  const noHardConflict = !(whalePositive && result.components.prediction < 0 && mtf.p === "neutral");
  const eligible = rejectedBuy && mtf.bullCount === 1 && result.score >= 2.5 && whalePositive && councilBuy && noHardConflict;

  let reason = "not_eligible";
  if (eligible) {
    reason = "score>=2.5 + 1/3 bullish MTF + whale accumulation + council BUY + no hard conflict";
  } else if (rejectedBuy) {
    const missing: string[] = [];
    if (mtf.bullCount !== 1) missing.push("exactly 1 bullish timeframe");
    if (result.score < 2.5) missing.push("score>=2.5");
    if (!whalePositive) missing.push("positive whale accumulation");
    if (!councilBuy) missing.push("council BUY");
    if (!noHardConflict) missing.push("no hard conflict");
    reason = missing.length ? "rejected_by_counterfactual: " + missing.join(", ") : "rejected_by_counterfactual";
  }

  return { evaluated: rejectedBuy, eligible, classification: eligible ? "HIGH_CONVICTION_BUY" : "NONE", would_execute: false, reason };
}

function ruleBasedRecommendation(
  whale: any | null,
  indicator: any | null,
  prediction: any | null,
  council: any | null,
  weights: StrategyWeights,
): { recommendation: string; confidence: number; reasoning: string; score: number; components: { whale: number; technicals: number; prediction: number; council: number } } {
  let score = 0;
  const reasons: string[] = [];
  const components = { whale: 0, technicals: 0, prediction: 0, council: 0 };

  if (whale?.direction === "accumulation") {
    score += weights.whale;
    components.whale = weights.whale;
    reasons.push("whale accumulation");
  }
  if (whale?.direction === "distribution") {
    score -= weights.whale;
    components.whale = -weights.whale;
    reasons.push("whale distribution");
  }

  if (indicator?.signal === "bullish") {
    score += weights.technicals;
    components.technicals = weights.technicals;
    reasons.push("bullish technicals (4h)");
  }
  if (indicator?.signal === "bearish") {
    score -= weights.technicals;
    components.technicals = -weights.technicals;
    reasons.push("bearish technicals (4h)");
  }

  if (prediction?.yes_price != null) {
    if (Number(prediction.yes_price) > 0.6) {
      const contribution = 0.5 * weights.prediction;
      score += contribution;
      components.prediction = contribution;
      reasons.push("prediction market leaning yes");
    }
    if (Number(prediction.yes_price) < 0.4) {
      const contribution = 0.5 * weights.prediction;
      score -= contribution;
      components.prediction = -contribution;
      reasons.push("prediction market leaning no");
    }
  }

  if (council?.final_verdict) {
    const weight = (Number(council.conviction ?? 50) / 100) * 1.5 * weights.council;
    const verdict = String(council.final_verdict).toUpperCase();
    if (verdict === "BUY") {
      score += weight;
      components.council = weight;
      reasons.push(`council: BUY (${council.conviction}% conviction)`);
    } else if (verdict === "SELL") {
      score -= weight;
      components.council = -weight;
      reasons.push(`council: SELL (${council.conviction}% conviction)`);
    } else if (verdict === "AVOID") {
      score -= weight;
      components.council = -weight;
      reasons.push(`council: AVOID (${council.conviction}% conviction)`);
    }
  }

  const max = weights.whale + weights.technicals + 0.5 * weights.prediction + 1.5 * weights.council;
  const confidence = max > 0 ? Math.min(1, Math.abs(score) / max) : 0;
  let recommendation: "buy" | "sell" | "hold" | "watch" = "watch";
  if (score >= 1.5) recommendation = "buy";
  else if (score <= -1.5) recommendation = "sell";
  else if (Math.abs(score) < 0.5) recommendation = "hold";

  return {
    recommendation,
    confidence,
    reasoning: reasons.length ? reasons.join("; ") : "insufficient signal",
    score,
    components,
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
    // Validate once per invocation; composite signals and paper execution are untouched.
    const spotTradingSymbols = await loadBinanceSpotTradingSymbols();

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

      const productionWeights: StrategyWeights = strategySnapshot ?? {
        whale: 1,
        technicals: 1,
        prediction: 1,
        council: 1,
        preset_name: null,
        updated_at: null,
      };
      const result = ruleBasedRecommendation(whale, indicator, prediction, council, productionWeights);
      const gate = applyMtfGate(result.recommendation, mtf, mtfGate);

      if (strategySnapshot) {
        const shadow = calculateConfiguredShadow(whale, mtf, prediction, council, strategySnapshot);
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
            current_score: result.score,
            current_recommendation: gate.recommendation,
            shadow_score: shadow.score,
            shadow_confidence: shadow.confidence,
            shadow_recommendation: shadow.recommendation,
            current_components: result.components,
            shadow_components: shadow.components,
            mtf_gate: {
              enabled: mtfGate.enabled,
              shadow_mode: mtfGate.shadow_mode,
              min_timeframes: mtfGate.min_timeframes,
              current: { recommendation: gate.recommendation, note: gate.note },
              counterfactual: calculateMtfCounterfactual(result, mtf, whale, council),
              shadow: shadow.mtf,
              hard_conflict: shadow.hardConflict,
            },
          });
        if (shadowError) console.error("[STRATEGY_SHADOW] diagnostics insert failed:", shadowError.message);
      }

      const reasoningParts = [result.reasoning];
      if (mtf.primary || mtf.fast || mtf.trend) reasoningParts.push(`MTF: ${mtf.detail}`);
      if (gate.note) reasoningParts.push(gate.note);

      // Persist provenance on every composite row without changing the current
      // production recommendation semantics. This closes a data-lineage gap:
      // the signal already consumed these inputs, but the row previously lost
      // its regime, source tags, price and reproducible input fingerprint.
      const sourceTags = [
        whale ? "whale" : null,
        indicator ? "technicals" : null,
        prediction ? "prediction" : null,
        council ? "council" : null,
        mtf.primary || mtf.fast || mtf.trend ? "mtf" : null,
      ].filter((tag): tag is string => Boolean(tag));
      // Council rows are refreshed frequently (often every synthesis cycle).
      // Their row ID is provenance, not a new market event. Including council?.id
      // here minted a new composite signal and paper trade for unchanged market
      // evidence whenever the council produced a fresh row. Keep the latest
      // council_signal_id on the upserted row, but do not let ID churn alone
      // create a new executable opportunity.
      const signalFingerprint = [
        symbol,
        whale?.id ?? "",
        indicator?.id ?? "",
        prediction?.id ?? "",
        productionRegimeLabel,
        gate.recommendation,
      ].join("|");

      // Observational strategy variants: same canonical inputs, isolated from composite signal/trades.
      // Long-only benchmark: only BUY variants are persisted.
      const variantEntryPrice = Number(indicator?.price ?? 0);
      if (variantEntryPrice > 0 && spotTradingSymbols?.has(dbSymbol)) {
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
          });

        const accumulation = calculateAccumulationVariant(mtf.trend);
        if (accumulation.recommendation === "buy") {
          variantRows.push({
            strategy_name: "accumulation",
            symbol,
            confidence: accumulation.confidence,
            recommendation: accumulation.recommendation,
            reasoning: accumulation.reasoning,
            score: accumulation.score,
            entry_price: variantEntryPrice,
            outcome: "open",
            production_regime_label: productionRegimeLabel,
            regime_label: productionRegimeLabel,
            market_session: productionMarketSession,
            created_at: new Date().toISOString(),
            source_fingerprint: [
              "accumulation", symbol, indicator?.id ?? "", mtf.trend?.id ?? "",
            ].join("|"),
          });
        }

        const buyVariantRows = variantRows.filter((v) => v.recommendation === "buy");
        if (buyVariantRows.length) {
          const { error: variantError } = await supabase
            .from("strategy_variant_signals")
            .upsert(buyVariantRows, { onConflict: "source_fingerprint", ignoreDuplicates: true });
          if (variantError) throw variantError;
        }
      } else if (variantEntryPrice > 0 && spotTradingSymbols && !spotTradingSymbols.has(dbSymbol)) {
        console.warn(`[SPOT_VARIANT_GATE] skipped shadow variants for ${symbol} (${dbSymbol}): not TRADING on Binance Spot`);
      }

      // Fingerprints are intentionally unique/idempotent. Re-observing the
      // same input combination must refresh the signal timestamp rather than
      // crash the whole pipeline on uq_composite_signals_fingerprint.
      const { data: inserted, error } = await supabase
        .from("composite_signals")
        .upsert(
          {
            symbol,
            whale_alert_id: whale?.id ?? null,
            indicator_snapshot_id: indicator?.id ?? null,
            prediction_snapshot_id: prediction?.id ?? null,
            council_signal_id: council?.id ?? null,
            confidence: result.confidence,
            recommendation: gate.recommendation,
            reasoning: reasoningParts.join("; "),
            price_at: Number(indicator?.price ?? 0) > 0 ? Number(indicator.price) : null,
            regime_label: productionRegimeLabel,
            market_session: productionMarketSession,
            source_tags: sourceTags,
            fingerprint: signalFingerprint,
            created_at: new Date().toISOString(),
          },
          { onConflict: "fingerprint" },
        )
        .select()
        .single();

      if (error) throw error;
      if (inserted) created.push(inserted);

      // Append one observational row per BUY evaluation. This ledger never gates execution.
      if (inserted && gate.recommendation === "buy") {
        const signalPrice = Number(indicator?.price ?? 0);
        const { data: openSameSymbol, error: openLookupError } = await supabase
          .from("trades")
          .select("id,entry_price,created_at")
          .eq("symbol", symbol)
          .eq("mode", "paper")
          .eq("status", "open")
          .order("created_at", { ascending: true })
          .limit(1);
        if (openLookupError) console.error("[REPEATED_BUY_LEDGER] concentration lookup failed:", openLookupError.message);
        const existingResearchPosition = openSameSymbol?.[0] ?? null;
        const confidenceEligible = Number(result.confidence) >= 0.6;
        const { error: ledgerError } = await supabase.from("repeated_buy_research_ledger").insert({
          composite_signal_id: inserted.id,
          signal_fingerprint: signalFingerprint,
          symbol,
          recommendation: gate.recommendation,
          confidence: result.confidence,
          signal_reasoning: reasoningParts.join("; "),
          signal_price: signalPrice > 0 ? signalPrice : null,
          signal_created_at: inserted.created_at ?? new Date().toISOString(),
          research_decision: confidenceEligible ? "pending_execution_audit" : "rejected",
          research_reason: confidenceEligible ? null : "confidence_below_minimum_0.60",
          limited_position_decision: !confidenceEligible
            ? "rejected_quality_gate"
            : existingResearchPosition ? "blocked_same_symbol_position_open" : "would_open",
          limited_position_reason: !confidenceEligible
            ? "counterfactual applies same confidence >= 0.60 quality gate"
            : existingResearchPosition
              ? "counterfactual cap: one simultaneous open paper position per symbol"
              : "counterfactual cap: no open paper position for symbol at observation time",
          limited_position_trade_id: existingResearchPosition?.id ?? null,
          limited_position_entry_price: existingResearchPosition?.entry_price ?? null,
          limited_position_entry_at: existingResearchPosition?.created_at ?? null,
          metadata: {
            confidence_minimum: 0.6,
            research_capacity_gates_bypassed: true,
            counterfactual_policy: "one_open_position_per_symbol",
            market_regime: productionRegimeLabel,
            market_session: productionMarketSession,
            source_tags: sourceTags,
          },
        });
        if (ledgerError) console.error("[REPEATED_BUY_LEDGER] insert failed:", ledgerError.message);
      }
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
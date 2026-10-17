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
const COUNCIL_MAX_AGE_MS = 30 * 60 * 1000;
const COUNCIL_MAX_AGE_MS_TRENDING = 20 * 60 * 1000;
const COUNCIL_MAX_AGE_MS_CALM = 45 * 60 * 1000;
const WHALE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

function isFreshTimestamp(value: unknown, maxAgeMs: number, now = Date.now()): boolean {
  const ts = new Date(String(value ?? "")).getTime();
  return Number.isFinite(ts) && now - ts >= 0 && now - ts <= maxAgeMs;
}

function councilMaxAgeMsForRegime(label: string | null): number {
  const normalized = String(label ?? "").toLowerCase();
  if (normalized.includes("trend") || normalized.includes("strong")) return COUNCIL_MAX_AGE_MS_TRENDING;
  if (normalized.includes("side") || normalized.includes("chop") || normalized.includes("rang") || normalized.includes("quiet")) return COUNCIL_MAX_AGE_MS_CALM;
  return COUNCIL_MAX_AGE_MS;
}

type Direction = "bullish" | "bearish" | "neutral";

interface MtfGateConfig {
  enabled: boolean;
  shadow_mode: boolean;
  min_timeframes: number;
}

interface MarketSentiment {
  value: number;
  classification: string;
  direction: Direction;
  normalizedScore: number;
  observedAt: string | null;
  source: "alternative.me" | "fallback";
}

const VARIANT_PRESETS: Record<string, { whale: number; technicals: number; sentiment: number; council: number }> = {
  balanced: { whale: 1, technicals: 1, sentiment: 0, council: 1 },
  "whale-focused": { whale: 2, technicals: 0.5, sentiment: 0, council: 0.5 },
  "chart-trader": { whale: 0.5, technicals: 2, sentiment: 0, council: 0.5 },
  "sentiment-first": { whale: 0.5, technicals: 0.5, sentiment: 2, council: 0.5 },
  "ai-driven": { whale: 0.5, technicals: 0.5, sentiment: 0, council: 2 },
  conservative: { whale: 1.2, technicals: 1.2, sentiment: 0, council: 1.2 },
  "volatility-timing": { whale: 0.3, technicals: 2.2, sentiment: 0, council: 1 },
  "vwap-momentum": { whale: 0.5, technicals: 2.2, sentiment: 0, council: 0.8 },
  "smc-reversal": { whale: 0.4, technicals: 2.5, sentiment: 0, council: 0.8 },
};

async function fetchCryptoMarketSentiment(): Promise<MarketSentiment> {
  try {
    const response = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Fear & Greed HTTP ${response.status}`);
    const payload = await response.json();
    const item = payload?.data?.[0];
    const value = Number(item?.value);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error("Fear & Greed response contained an invalid value");
    }
    const direction: Direction = value >= 55 ? "bullish" : value <= 45 ? "bearish" : "neutral";
    return {
      value,
      classification: String(item?.value_classification ?? "Unknown"),
      direction,
      normalizedScore: (value - 50) / 50,
      observedAt: item?.timestamp ? new Date(Number(item.timestamp) * 1000).toISOString() : null,
      source: "alternative.me",
    };
  } catch (error) {
    console.warn("[SENTIMENT_SHADOW] Fear & Greed fetch failed; using neutral fallback:", String(error));
    return {
      value: 50,
      classification: "Neutral (fallback)",
      direction: "neutral",
      normalizedScore: 0,
      observedAt: null,
      source: "fallback",
    };
  }
}

const DEFAULT_MTF_GATE: MtfGateConfig = {
  enabled: false,
  shadow_mode: true,
  min_timeframes: 2,
};

type StrategyWeights = {
  whale: number;
  technicals: number;
  council: number;
};

type StrategySnapshot = StrategyWeights & {
  preset_name: string | null;
  updated_at: string | null;
};

async function loadStrategySnapshot(supabase: ReturnType<typeof getServiceClient>): Promise<StrategySnapshot | null> {
  const { data, error } = await supabase
    .from("strategy_config")
    .select("whale_weight,technicals_weight,council_weight,preset_name,updated_at")
    .eq("id", 1)
    .maybeSingle();

  if (error || !data) {
    console.error("[STRATEGY_SHADOW] strategy_config load failed:", error?.message ?? "missing row");
    return null;
  }

  return {
    whale: Number(data.whale_weight),
    technicals: Number(data.technicals_weight),
    council: Number(data.council_weight),
    preset_name: data.preset_name ?? null,
    updated_at: data.updated_at ?? null,
  };
}

/**
 * Historical strategy-authority shadow.
 *
 * This mirrors the proven legacy ruleBased() scoring contract for the
 * dimensions available in the canonical Edge combiner:
 * - strategy_config weights are authoritative inputs
 * - MTF score × technical weight
 * - council conviction × 0.75 × council weight
 * - historical ±2.2 / 0.5 classification
 *
 * This remains a diagnostic comparator for the base whale/technicals/council
 * score. The production score may separately receive the bounded accumulation
 * booster, and this shadow deliberately does not include that booster.
 */
function calculateConfiguredShadow(
  whale: any | null,
  mtf: ReturnType<typeof classifyMtf> | null,
  council: any | null,
  weights: StrategyWeights,
) {
  // Defensive runtime normalization: diagnostic shadow must never be able to
  // take down the canonical signal-combiner if an unexpected null MTF payload
  // reaches this helper. Treat a missing MTF context as fully neutral.
  const safeMtf = mtf ?? classifyMtf([]);
  let score = 0;
  const hardConflict = false;
  const components = { whale: 0, technicals: 0, council: 0 };

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

  if (council?.final_verdict) {
    const convictionRaw = Number(council.conviction);
    const conviction = Number.isFinite(convictionRaw) ? Math.max(0, Math.min(100, convictionRaw)) : 50;
    const councilWeight = (conviction / 100) * 0.75 * weights.council;
    const verdict = String(council.final_verdict).toUpperCase();
    if (verdict === "BUY") { components.council = councilWeight; score += components.council; }
    else if (verdict === "SELL") { components.council = -councilWeight; score += components.council; }
  }

  const whaleDir = whale?.direction === "accumulation" ? 1 : whale?.direction === "distribution" ? -1 : 0;

  let recommendation: "buy" | "sell" | "hold" | "watch" = "hold";
  if (hardConflict) recommendation = "hold";
  else if (score >= 2.2) recommendation = "buy";
  else if (score <= -2.2) recommendation = "sell";
  else if (Math.abs(score) < 0.5) recommendation = "hold";
  else recommendation = "watch";

  const max = weights.whale + weights.technicals * 1.69 + weights.council * 0.75;
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
  const seenCouncil=new Set<string>(); let cb=0,cs=0;
  for(const x of input.councils){
    const s=String(x?.symbol); if(seenCouncil.has(s)) continue; seenCouncil.add(s);
    const v=String(x?.final_verdict??"").toUpperCase();
    if(v==="BUY") cb++; else if(v==="SELL") cs++;
  }
  const councilConsensus=seenCouncil.size>0?(cb-cs)/seenCouncil.size:0;
  const score=whaleNet*0.375+techBreadth*0.5+councilConsensus*0.125;
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
  council: any | null,
  sentiment: MarketSentiment,
  weights: { whale: number; technicals: number; sentiment: number; council: number },
) {
  let score = 0;
  const reasons: string[] = [];
  if (whale?.direction === "accumulation") { score += weights.whale; reasons.push("whale accumulation"); }
  if (whale?.direction === "distribution") { score -= weights.whale; reasons.push("whale distribution"); }
  if (mtf.p === "bullish") { score += weights.technicals; reasons.push("bullish technicals"); }
  if (mtf.p === "bearish") { score -= weights.technicals; reasons.push("bearish technicals"); }

  // Sentiment is enabled only for the isolated sentiment-first research variant.
  if (weights.sentiment > 0) {
    const sentimentScore = sentiment.normalizedScore * weights.sentiment;
    score += sentimentScore;
    reasons.push(`Fear & Greed ${sentiment.value}/100 (${sentiment.classification}; ${sentiment.source}; score ${sentimentScore.toFixed(3)})`);
  }

  if (council?.final_verdict) {
    const convictionRaw = Number(council.conviction ?? 50);
    const conviction = Number.isFinite(convictionRaw) ? Math.max(0, Math.min(100, convictionRaw)) / 100 : 0.5;
    const verdict = String(council.final_verdict).toUpperCase();
    if (verdict === "BUY") { score += conviction * 1.5 * weights.council; reasons.push("council BUY"); }
    else if (verdict === "SELL") { score -= conviction * 1.5 * weights.council; reasons.push("council SELL"); }
  }
  const max = weights.whale + weights.technicals + weights.sentiment + 1.5 * weights.council;
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

/**
 * Apply accumulation as a bounded, positive-only BUY-score booster.
 * It is available only for symbols in the fresh dynamic watchlist, uses
 * already-computed 1d features, and never reads forward-return labels.
 * The existing MTF gate and paper executor remain downstream authorities.
 */
function applyAccumulationBoost(
  result: ReturnType<typeof ruleBasedRecommendation>,
  mtf: ReturnType<typeof classifyMtf>,
  inFreshDynamicWatchlist: boolean,
  weights: StrategyWeights,
) {
  const a = mtf.trend?.raw?.accumulation;
  const rawScore = Number(a?.score);
  const eligible = inFreshDynamicWatchlist
    && result.score >= 0
    && Number.isFinite(rawScore)
    && rawScore >= 60
    && ["ACCUMULATION_WATCH", "BREAKOUT_CONFIRMED"].includes(String(a?.status ?? ""));

  if (!eligible) {
    return { ...result, accumulation_boost: 0, accumulation_score: Number.isFinite(rawScore) ? rawScore : null };
  }

  // Existing accumulation-variant threshold (60/100); maximum contribution is +0.50.
  const bonus = Math.min(0.5, Math.max(0, rawScore / 200));
  const score = result.score + bonus;
  const recommendation = score >= 1.5 ? "buy"
    : score <= -1.5 ? "sell"
    : Math.abs(score) < 0.5 ? "hold"
    : "watch";
  const max = weights.whale + weights.technicals + 1.5 * weights.council + 0.5;

  return {
    ...result,
    score,
    confidence: max > 0 ? Math.min(1, Math.abs(score) / max) : 0,
    recommendation,
    reasoning: `${result.score === 0 ? "Base score is neutral; " : ""}${result.reasoning}; dynamic-watchlist accumulation booster +${bonus.toFixed(2)} (score ${rawScore}/100; applied even with a zero base score)`,
    components: { ...result.components, accumulation: bonus },
    accumulation_boost: bonus,
    accumulation_score: rawScore,
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
  result: { score: number; components: { whale: number; technicals: number; council: number } },
  mtf: ReturnType<typeof classifyMtf>,
  whale: any | null,
  council: any | null,
) {
  const rejectedBuy = result.score >= 1.5 && mtf.bullCount < 2;
  const whalePositive = whale?.direction === "accumulation" && result.components.whale > 0;
  const councilBuy = String(council?.final_verdict ?? "").toUpperCase() === "BUY"
    && Number(council?.conviction ?? 0) > 0
    && result.components.council > 0;
  const eligible = rejectedBuy && mtf.bullCount === 1 && result.score >= 2.5 && whalePositive && councilBuy;

  let reason = "not_eligible";
  if (eligible) {
    reason = "score>=2.5 + 1/3 bullish MTF + whale accumulation + council BUY";
  } else if (rejectedBuy) {
    const missing: string[] = [];
    if (mtf.bullCount !== 1) missing.push("exactly 1 bullish timeframe");
    if (result.score < 2.5) missing.push("score>=2.5");
    if (!whalePositive) missing.push("positive whale accumulation");
    if (!councilBuy) missing.push("council BUY");
    reason = missing.length ? "rejected_by_counterfactual: " + missing.join(", ") : "rejected_by_counterfactual";
  }

  return { evaluated: rejectedBuy, eligible, classification: eligible ? "HIGH_CONVICTION_BUY" : "NONE", would_execute: false, reason };
}

function ruleBasedRecommendation(
  whale: any | null,
  mtf: ReturnType<typeof classifyMtf>,
  council: any | null,
  weights: StrategyWeights,
): { recommendation: string; confidence: number; reasoning: string; score: number; components: { whale: number; technicals: number; council: number; accumulation?: number } } {
  let score = 0;
  const reasons: string[] = [];
  const components: { whale: number; technicals: number; council: number; accumulation?: number } = {
    whale: 0, technicals: 0, council: 0,
  };

  const directionLabel = (direction: Direction) =>
    direction === "bullish" ? "bull" : direction === "bearish" ? "bear" : "neutral";
  const mtfDiagnosticDetail = `4h ${mtf.primary ? directionLabel(mtf.p) : "missing"} · 1h ${mtf.fast ? directionLabel(mtf.f) : "missing"} · 1d ${mtf.trend ? directionLabel(mtf.t) : "missing"}`;
  const frames = [
    { row: mtf.primary, direction: mtf.p, weight: 1 },
    { row: mtf.fast, direction: mtf.f, weight: 0.65 },
    { row: mtf.trend, direction: mtf.t, weight: 0.65 },
  ].filter((frame) => frame.row !== null);
  const availableWeight = frames.reduce((sum, frame) => sum + frame.weight, 0);
  const directionalWeight = frames.reduce((sum, frame) =>
    sum + (frame.direction === "bullish" ? frame.weight : frame.direction === "bearish" ? -frame.weight : 0), 0);
  const mtfDirectionScore = availableWeight > 0 ? directionalWeight / availableWeight : 0;
  components.technicals = mtfDirectionScore * weights.technicals;
  score += components.technicals;

  if (whale?.direction === "accumulation") {
    components.whale = weights.whale;
    score += components.whale;
    reasons.push("whale accumulation");
  } else if (whale?.direction === "distribution") {
    components.whale = -weights.whale;
    score += components.whale;
    reasons.push("whale distribution");
  }

  if (Math.abs(components.technicals) >= 0.025) {
    reasons.push(`MTF technicals ${components.technicals > 0 ? "bullish" : "bearish"} (weighted score ${mtfDirectionScore.toFixed(2)}; ${mtf.detail})`);
  } else if (frames.length > 0 && mtf.bullCount > 0 && mtf.bearCount > 0) {
    reasons.push(`MTF technical conflict: bullish and bearish timeframes offset each other (${mtfDiagnosticDetail})`);
  } else if (frames.length > 0 && frames.every((frame) => frame.direction === "neutral")) {
    reasons.push(`MTF technicals genuinely neutral across available timeframes (${mtfDiagnosticDetail})`);
  } else if (frames.length === 0) {
    reasons.push("MTF technical data unavailable: no fresh 4h/1h/1d snapshots");
  } else {
    reasons.push(`MTF technicals net to neutral (${mtfDiagnosticDetail})`);
  }

  if (council?.final_verdict) {
    const convictionRaw = Number(council.conviction ?? 50);
    const conviction = Number.isFinite(convictionRaw) ? Math.max(0, Math.min(100, convictionRaw)) : 50;
    const councilWeight = (conviction / 100) * 1.5 * weights.council;
    const verdict = String(council.final_verdict).toUpperCase();
    if (verdict === "BUY") {
      components.council = councilWeight;
      score += components.council;
      reasons.push(`council BUY (${conviction}% conviction)`);
    } else if (verdict === "SELL" || verdict === "AVOID") {
      components.council = -councilWeight;
      score += components.council;
      reasons.push(`council: ${verdict} (${conviction}% conviction)`);
    } else {
      reasons.push(`council verdict ${verdict} (no directional score)`);
    }
  }

  if (Math.abs(score) < 0.5) {
    if (!whale || !["accumulation", "distribution"].includes(String(whale.direction))) {
      reasons.push("no active directional whale-flow input within the 6h lookback");
    }
    if (!council?.final_verdict) reasons.push("no fresh AI Council verdict");
  }

  const max = weights.whale + weights.technicals + 1.5 * weights.council;
  const confidence = max > 0 ? Math.min(1, Math.abs(score) / max) : 0;
  let recommendation: "buy" | "sell" | "hold" | "watch" = "watch";
  if (score >= 1.5) recommendation = "buy";
  else if (score <= -1.5) recommendation = "sell";
  else if (Math.abs(score) < 0.5) recommendation = "hold";

  const reasoning = Math.abs(score) < 0.5
    ? `insufficient directional signal — ${reasons.join("; ")}`
    : reasons.join("; ");

  return { recommendation, confidence, reasoning, score, components };
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

    const freshnessNow = Date.now();
    const freshnessNowIso = new Date(freshnessNow).toISOString();
    // Versioned research identity: one strategy/symbol sample per 10-minute observation window.
    // This is separate from council row IDs, which can churn without a new market observation.
    // The v2 prefix deliberately preserves all existing historical fingerprints unchanged.
    const variantSampleBucket = Math.floor(freshnessNow / (10 * 60 * 1000));
    const since = new Date(freshnessNow - WHALE_LOOKBACK_MS).toISOString();
    // Regime inputs use the neutral 30-minute council window because the regime
    // itself is derived from those inputs. Per-symbol signals use the resolved regime TTL.
    const regimeCouncilSince = new Date(freshnessNow - COUNCIL_MAX_AGE_MS).toISOString();

    const [{ data: councilSymbolRows }, { data: whaleSymbolRows }, { data: watchlistSnapshot, error: watchlistError }] = await Promise.all([
      supabase.from("council_signals").select("symbol").order("source_created_at", { ascending: false }),
      supabase.from("whale_alerts").select("symbol").gte("created_at", since),
      supabase.from("dynamic_watchlist_snapshots").select("symbols,dynamic_symbols,expires_at,computed_at")
        .order("computed_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (watchlistError) console.warn("[DYNAMIC_WATCHLIST] read failed; falling back to legacy base list and disabling accumulation boost:", watchlistError.message);
    const watchlistExpiresAt = new Date(String(watchlistSnapshot?.expires_at ?? "")).getTime();
    const dynamicWatchlistFresh = !watchlistError
      && Array.isArray(watchlistSnapshot?.symbols)
      && watchlistSnapshot.symbols.length > 0
      && Number.isFinite(watchlistExpiresAt)
      && watchlistExpiresAt > freshnessNow;
    const normalizeSymbol = (value: unknown) => String(value ?? "").trim().toUpperCase().replace(/USDT$/, "");
    const watchlistSymbols = new Set<string>(
      (dynamicWatchlistFresh ? watchlistSnapshot.symbols : [])
        .map(normalizeSymbol).filter(Boolean),
    );
    // The snapshot separates pinned/base members from coins admitted dynamically.
    // Accumulation may boost only the latter, while all current watchlist members
    // remain in the primary signal universe.
    const dynamicWatchlistSymbols = new Set<string>(
      (dynamicWatchlistFresh && Array.isArray(watchlistSnapshot.dynamic_symbols) ? watchlistSnapshot.dynamic_symbols : [])
        .map(normalizeSymbol).filter(Boolean),
    );

    const [{ data: regimeWhales }, { data: regimeIndicators }, { data: regimeCouncils }] = await Promise.all([
      supabase.from("whale_alerts").select("symbol,direction,usd_value").gte("created_at", new Date(Date.now()-60*60*1000).toISOString()).limit(3000),
      supabase.from("indicator_snapshots").select("symbol,timeframe,signal,created_at").eq("timeframe","4h").order("created_at",{ascending:false}).limit(1000),
      supabase.from("council_signals").select("symbol,final_verdict,source_created_at").gte("source_created_at", regimeCouncilSince).lte("source_created_at", freshnessNowIso).order("source_created_at",{ascending:false}).limit(1000),
    ]);
    const productionRegimeLabel = classifyProductionRegime({
      whales: regimeWhales ?? [], indicators: regimeIndicators ?? [],
      councils: (regimeCouncils ?? []).filter((row: any) => isFreshTimestamp(row?.source_created_at, COUNCIL_MAX_AGE_MS, freshnessNow)),
    });
    const productionMarketSession = productionSession();
    const councilSince = new Date(freshnessNow - councilMaxAgeMsForRegime(productionRegimeLabel)).toISOString();

    const councilSymbols = [...new Set((councilSymbolRows ?? []).map((r: any) => r.symbol))];
    const whaleSymbols = [...new Set((whaleSymbolRows ?? []).map((r: any) => r.symbol))];
    // Use the current dynamic watchlist as the primary research universe.
    // Keep fresh council/whale discoveries outside it in the signal universe,
    // but never let those external discoveries receive the accumulation booster.
    const primarySymbols = dynamicWatchlistFresh ? [...watchlistSymbols] : WATCHLIST;
    const symbols = [...new Set([...primarySymbols, ...councilSymbols, ...whaleSymbols].map(normalizeSymbol).filter(Boolean))];
    // Fetched once per run and consumed only by the isolated strategy-variant research path.
    const marketSentiment = await fetchCryptoMarketSentiment();
    // Validate once per invocation; composite signals and paper execution are untouched.
    const spotTradingSymbols = await loadBinanceSpotTradingSymbols();


    // Batch input retrieval: replace per-symbol serial PostgREST reads with a small,
    // bounded set of requests. Results are sorted newest-first and grouped in memory.
    const dbSymbols = [...new Set(symbols.map(indicatorSymbol))];
    const [
      { data: batchWhales, error: batchWhalesError },
      { data: batchIndicators, error: batchIndicatorsError },
      { data: batchCouncils, error: batchCouncilsError },
      { data: batchOpenTrades, error: batchOpenTradesError },
    ] = await Promise.all([
      supabase.from("whale_alerts").select("*")
        .in("symbol", symbols).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(2000),
      supabase.from("indicator_snapshots").select("*")
        .in("symbol", dbSymbols).in("timeframe", [...TIMEFRAMES])
        .order("created_at", { ascending: false }).limit(2000),
      supabase.from("council_signals").select("*")
        .in("symbol", symbols).gte("source_created_at", councilSince)
        .lte("source_created_at", freshnessNowIso)
        .order("source_created_at", { ascending: false }).limit(1000),
      supabase.from("trades").select("id,symbol,entry_price,created_at")
        .in("symbol", symbols).eq("mode", "paper").eq("status", "open")
        .order("created_at", { ascending: true }).limit(2000),
    ]);
    if (batchWhalesError) console.error("[SIGNAL_COMBINER_BATCH] whale fetch failed:", batchWhalesError.message);
    if (batchIndicatorsError) console.error("[SIGNAL_COMBINER_BATCH] indicator fetch failed:", batchIndicatorsError.message);
    if (batchCouncilsError) console.error("[SIGNAL_COMBINER_BATCH] council fetch failed:", batchCouncilsError.message);
    if (batchOpenTradesError) console.error("[SIGNAL_COMBINER_BATCH] open-trade fetch failed:", batchOpenTradesError.message);

    const whalesBySymbol = new Map<string, any[]>();
    for (const row of batchWhales ?? []) {
      const key = String(row.symbol ?? "").toUpperCase();
      const rows = whalesBySymbol.get(key) ?? [];
      if (rows.length < 20) rows.push(row);
      whalesBySymbol.set(key, rows);
    }
    const indicatorsBySymbol = new Map<string, any[]>();
    for (const row of batchIndicators ?? []) {
      const key = String(row.symbol ?? "").toUpperCase();
      const rows = indicatorsBySymbol.get(key) ?? [];
      if (rows.length < 10) rows.push(row);
      indicatorsBySymbol.set(key, rows);
    }
    const councilsBySymbol = new Map<string, any>();
    for (const row of batchCouncils ?? []) {
      const key = String(row.symbol ?? "").toUpperCase();
      if (!councilsBySymbol.has(key)) councilsBySymbol.set(key, row);
    }
    const openTradesBySymbol = new Map<string, any>();
    for (const trade of batchOpenTrades ?? []) {
      const key = String(trade.symbol ?? "").toUpperCase();
      if (!openTradesBySymbol.has(key)) openTradesBySymbol.set(key, trade);
    }

    const created: any[] = [];
    const compositeRowsToUpsert: any[] = [];
    const shadowRowsToInsert: any[] = [];
    const variantRowsToUpsert: any[] = [];
    const ledgerRowsToInsert: any[] = [];
    let accumulationBoostedCount = 0;

    for (const symbol of symbols) {
      const dbSymbol = indicatorSymbol(symbol);

      const whaleRows = whalesBySymbol.get(String(symbol).toUpperCase()) ?? [];
      const whale = whaleRows[0] ?? null;
      const council = councilsBySymbol.get(String(symbol).toUpperCase()) ?? null;
      const indicatorRows = indicatorsBySymbol.get(String(dbSymbol).toUpperCase()) ?? [];
      const mtf = classifyMtf(indicatorRows as Record<string, any>[]);
      const indicator = mtf.primary;

      if (!whale && !mtf.primary && !mtf.fast && !mtf.trend && !council) continue;

      const productionWeights: StrategyWeights = strategySnapshot ?? {
        whale: 1,
        technicals: 1,
        council: 1,
        preset_name: null,
        updated_at: null,
      };
      const baseResult = ruleBasedRecommendation(whale, mtf, council, productionWeights);
      const inFreshDynamicWatchlist = dynamicWatchlistFresh && dynamicWatchlistSymbols.has(String(symbol).toUpperCase());
      const result = applyAccumulationBoost(baseResult, mtf, inFreshDynamicWatchlist, productionWeights);
      if (result.accumulation_boost > 0) accumulationBoostedCount++;
      const gate = applyMtfGate(result.recommendation, mtf, mtfGate);

      if (strategySnapshot) {
        const shadow = calculateConfiguredShadow(whale, mtf, council, strategySnapshot);
        shadowRowsToInsert.push({
          symbol,
          strategy_preset: strategySnapshot.preset_name,
          strategy_updated_at: strategySnapshot.updated_at,
          whale_weight: strategySnapshot.whale,
          technicals_weight: strategySnapshot.technicals,
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
      }

      const reasoningParts = [result.reasoning];
      if (mtf.primary || mtf.fast || mtf.trend) reasoningParts.push(`MTF: ${mtf.detail}`);
      if (gate.note) reasoningParts.push(gate.note);

      // Persist the complete decision provenance, including whether the
      // dynamic-watchlist accumulation booster contributed to this score.
      const sourceTags = [
        whale ? "whale" : null,
        indicator ? "technicals" : null,
        council ? "council" : null,
        mtf.primary || mtf.fast || mtf.trend ? "mtf" : null,
        result.accumulation_boost > 0 ? "accumulation" : null,
        inFreshDynamicWatchlist ? "dynamic-watchlist" : null,
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

        productionRegimeLabel,
        gate.recommendation,
      ].join("|");

      // Observational strategy variants: same canonical inputs, isolated from composite signal/trades.
      // Long-only benchmark: only BUY variants are persisted.
      const variantEntryPrice = Number(indicator?.price ?? 0);
      if (variantEntryPrice > 0 && spotTradingSymbols?.has(dbSymbol)) {
        const variantRows = Object.entries(VARIANT_PRESETS)
          .map(([strategy_name, weights]) => {
            const vr = calculateVariant(whale, mtf, council, marketSentiment, weights);
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
                "v2", strategy_name, symbol, variantSampleBucket,
              ].join("|"),
            };
          });

        if (inFreshDynamicWatchlist) {
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
                "v2", "accumulation", symbol, variantSampleBucket,
              ].join("|"),
            });
          }
        }

        const buyVariantRows = variantRows.filter((v) => v.recommendation === "buy");
        if (buyVariantRows.length) variantRowsToUpsert.push(...buyVariantRows);
      } else if (variantEntryPrice > 0 && spotTradingSymbols && !spotTradingSymbols.has(dbSymbol)) {
        console.warn(`[SPOT_VARIANT_GATE] skipped shadow variants for ${symbol} (${dbSymbol}): not TRADING on Binance Spot`);
      }

      // Capture the complete source context at signal-evaluation time.
      // indicator_snapshots is a mutable current-state table, so the copied
      // JSON is the research record; indicator_snapshot_id remains provenance only.
      const entryContextSnapshot = {
        schema_version: 1,
        captured_at: new Date().toISOString(),
        symbol,
        signal: {
          recommendation: gate.recommendation,
          confidence: result.confidence,
          score: result.score,
          reasoning: reasoningParts.join("; "),
          price_at: Number(indicator?.price ?? 0) > 0 ? Number(indicator?.price ?? 0) : null,
        },
        technicals: {
          primary: indicator,
          mtf: [mtf.primary, mtf.fast, mtf.trend].filter(Boolean),
          alignment: {
            primary: mtf.p, fast: mtf.f, trend: mtf.t,
            bull_count: mtf.bullCount, bear_count: mtf.bearCount, neutral_count: mtf.neuCount,
            detail: mtf.detail,
          },
        },
        whale_flow: whale ? {
          id: whale.id, symbol: whale.symbol, chain: whale.chain,
          direction: whale.direction, usd_value: whale.usd_value,
          source: whale.source, created_at: whale.created_at,
        } : null,
        ai_council: council ? {
          id: council.id, symbol: council.symbol, depth: council.depth,
          final_verdict: council.final_verdict, conviction: council.conviction,
          price_at: council.price_at, reflection: council.reflection,
          source_created_at: council.source_created_at, synced_at: council.synced_at,
        } : null,
        market_regime: productionRegimeLabel,
        market_session: productionMarketSession,
        strategy: productionWeights,
        dynamic_watchlist: {
          member: inFreshDynamicWatchlist,
          snapshot_at: dynamicWatchlistFresh ? watchlistSnapshot?.computed_at ?? null : null,
          fresh: dynamicWatchlistFresh,
        },
        accumulation_factor: {
          score: result.accumulation_score,
          status: mtf.trend?.raw?.accumulation?.status ?? null,
          applied: result.accumulation_boost > 0,
          bonus: result.accumulation_boost,
          forward_returns_used_for_entry: false,
        },
        source_tags: sourceTags,
      };

      // Fingerprints are intentionally unique/idempotent. Re-observing the
      // same input combination must refresh the signal timestamp rather than
      // crash the whole pipeline on uq_composite_signals_fingerprint.
      const compRow = {
        symbol,
        whale_alert_id: whale?.id ?? null,
        indicator_snapshot_id: indicator?.id ?? null,
        council_signal_id: council?.id ?? null,
        confidence: result.confidence,
        recommendation: gate.recommendation,
        reasoning: reasoningParts.join("; "),
        price_at: Number(indicator?.price ?? 0) > 0 ? Number(indicator?.price ?? 0) : null,
        regime_label: productionRegimeLabel,
        market_session: productionMarketSession,
        source_tags: sourceTags,
        fingerprint: signalFingerprint,
        entry_context_snapshot: entryContextSnapshot,
        created_at: new Date().toISOString(),
      };
      compositeRowsToUpsert.push(compRow);

      // Append one observational row per BUY evaluation. This ledger never gates execution.
      if (gate.recommendation === "buy") {
        const signalPrice = Number(indicator?.price ?? 0);
        const existingResearchPosition = openTradesBySymbol.get(String(symbol).toUpperCase()) ?? null;
        const confidenceEligible = Number(result.confidence) >= 0.6;
        ledgerRowsToInsert.push({
          signal_fingerprint: signalFingerprint,
          symbol,
          recommendation: gate.recommendation,
          confidence: result.confidence,
          signal_reasoning: reasoningParts.join("; "),
          signal_price: signalPrice > 0 ? signalPrice : null,
          signal_created_at: compRow.created_at,
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
      }
    }

    // Batch persistence is deliberately separated from signal calculation so
    // no per-symbol PostgREST write/read round-trips remain in the loop.
    if (compositeRowsToUpsert.length) {
      const { data, error } = await supabase.from("composite_signals")
        .upsert(compositeRowsToUpsert, { onConflict: "fingerprint" }).select();
      if (error) throw error;
      if (data) created.push(...data);
    }
    if (variantRowsToUpsert.length) {
      const { error } = await supabase.from("strategy_variant_signals")
        .upsert(variantRowsToUpsert, { onConflict: "source_fingerprint", ignoreDuplicates: true });
      if (error) throw error;
    }
    if (shadowRowsToInsert.length) {
      const { error } = await supabase.from("strategy_shadow_diagnostics").insert(shadowRowsToInsert);
      if (error) console.error("[STRATEGY_SHADOW] batch diagnostics insert failed:", error.message);
    }
    if (ledgerRowsToInsert.length) {
      const idByFingerprint = new Map<string, string>();
      for (const row of created) idByFingerprint.set(String(row.fingerprint), String(row.id));
      const linkedLedgerRows = ledgerRowsToInsert.map((row) => ({
        ...row,
        composite_signal_id: idByFingerprint.get(String(row.signal_fingerprint)) ?? null,
      }));
      const { error } = await supabase.from("repeated_buy_research_ledger").insert(linkedLedgerRows);
      if (error) console.error("[REPEATED_BUY_LEDGER] batch insert failed:", error.message);
    }

    return new Response(
      JSON.stringify({
        created: created.length,
        mtf_gate: mtfGate,
        dynamic_watchlist: {
          fresh: dynamicWatchlistFresh,
          snapshot_at: dynamicWatchlistFresh ? watchlistSnapshot?.computed_at ?? null : null,
          symbols_count: watchlistSymbols.size,
          dynamic_symbols_count: dynamicWatchlistSymbols.size,
          accumulation_boosted_count: accumulationBoostedCount,
        },
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
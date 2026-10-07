// Canonical TCC-native council stage.
// Kept at the historical council-sync stage name for orchestrator compatibility.
// It no longer reads the external Whale Radar feed.
//
// Contract:
// - long-only: BUY | HOLD | AVOID only
// - batch Groq evaluation, rate guarded
// - dynamic watchlist + hot-whale candidates
// - 4h / 1h / 1d technical context
// - whale flow + prediction context
// - prior council lessons
// - deterministic synthesis fallback when Groq is unavailable
// - fresh AI rows are written as depth=ai-batch; fallback rows are ai-synthesis

import { handleOptions, corsHeaders } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const AI_BATCH_MAX = 15;
const AI_MIN_MINUTES = 25;
const AI_MIN_MINUTES_TRENDING = 15;
const AI_MIN_MINUTES_CALM = 40;
const WHALE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const INDICATOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PREDICTION_MAX_AGE_MS = 30 * 60 * 1000;
const GROQ_TIMEOUT_MS = 15_000;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = Deno.env.get("GROQ_MODEL") ?? "openai/gpt-oss-20b";

const CORE_FALLBACK = [
  "BTC","ETH","SOL","XRP","DOGE","ADA","BNB","AVAX","LINK","ARB",
];

const WHALE_MIN_USD: Record<string, number> = {
  BTC: 50_000, ETH: 50_000, BNB: 50_000,
  SOL: 25_000, XRP: 25_000, ADA: 25_000, DOGE: 25_000,
  TRX: 20_000, AVAX: 15_000, DOT: 15_000, LTC: 15_000, BCH: 15_000,
  LINK: 10_000, MATIC: 10_000, ATOM: 10_000, NEAR: 10_000,
  APT: 10_000, SUI: 10_000, UNI: 10_000, AAVE: 10_000,
  MKR: 10_000, ETC: 10_000, XLM: 10_000, ICP: 10_000,
  FIL: 10_000, RNDR: 10_000,
  CRV: 5_000, ARB: 5_000, OP: 5_000, INJ: 5_000, TIA: 5_000,
  SEI: 5_000, RUNE: 5_000, FTM: 5_000, HBAR: 5_000, ALGO: 5_000,
  VET: 5_000, SAND: 5_000, MANA: 5_000, AXS: 5_000, GALA: 5_000,
  IMX: 5_000, GRT: 5_000, SHIB: 5_000, PEPE: 5_000, ORDI: 5_000,
  WIF: 3_000, BONK: 3_000, FLOKI: 3_000, BOME: 3_000, MEME: 3_000,
};
const DEFAULT_WHALE_MIN = 25_000;

type Row = Record<string, unknown>;
type Verdict = "BUY" | "HOLD" | "AVOID";

interface Candidate {
  symbol: string;
  whale: {
    direction: "accumulation" | "distribution" | "mixed" | "none";
    usd: number;
    buyUsd: number;
    sellUsd: number;
    buyCount: number;
    sellCount: number;
  };
  primary: Row | null;
  fast: Row | null;
  trend: Row | null;
  prediction: Row | null;
  conflict: boolean;
  whaleUsd: number;
}

interface CouncilResult {
  symbol: string;
  verdict: Verdict;
  conviction: number;
  reflection: string;
}

function whaleFloor(symbol: string): number {
  return WHALE_MIN_USD[symbol] ?? DEFAULT_WHALE_MIN;
}

function binanceSymbol(symbol: string): string {
  return symbol.endsWith("USDT") ? symbol : symbol + "USDT";
}

function fresh(value: unknown, maxAgeMs: number): boolean {
  const ts = new Date(String(value ?? "")).getTime();
  return Number.isFinite(ts) && ts <= Date.now() && Date.now() - ts <= maxAgeMs;
}

function signalOf(row: Row | null): string {
  return String(row?.signal ?? "neutral").toLowerCase();
}

function isTrending(label: string | null): boolean {
  const v = String(label ?? "").toLowerCase();
  return v.includes("trend") || v.includes("strong");
}

function isCalm(label: string | null): boolean {
  const v = String(label ?? "").toLowerCase();
  return v.includes("side") || v.includes("chop") || v.includes("rang") || v.includes("quiet");
}

function intervalMinutes(regime: string | null): number {
  if (isTrending(regime)) return AI_MIN_MINUTES_TRENDING;
  if (isCalm(regime)) return AI_MIN_MINUTES_CALM;
  return AI_MIN_MINUTES;
}

function deriveRegime(indicators: Row[], whales: Row[]): string {
  let buy = 0, sell = 0;
  for (const w of whales) {
    const usd = Number(w.usd_value ?? 0);
    if (w.direction === "accumulation") buy += usd;
    if (w.direction === "distribution") sell += usd;
  }
  const totalWhale = buy + sell;
  const whaleNet = totalWhale > 0 ? (buy - sell) / totalWhale : 0;

  const seen = new Set<string>();
  let bull = 0, bear = 0;
  for (const i of indicators) {
    if (i.timeframe !== "4h") continue;
    const s = String(i.symbol);
    if (seen.has(s)) continue;
    seen.add(s);
    if (signalOf(i as Row) === "bullish") bull++;
    else if (signalOf(i as Row) === "bearish") bear++;
  }
  const techTotal = bull + bear;
  const techBreadth = techTotal > 0 ? (bull - bear) / techTotal : 0;
  const score = whaleNet * 0.45 + techBreadth * 0.55;

  if (score >= 0.5) return "strong_bull";
  if (score >= 0.15) return "bull";
  if (score <= -0.5) return "strong_bear";
  if (score <= -0.15) return "bear";
  return "sideways";
}

function fallback(candidate: Candidate, regime: string): CouncilResult {
  const p4 = signalOf(candidate.primary);
  const p1 = signalOf(candidate.fast);
  const pd = signalOf(candidate.trend);
  const rsi = Number(candidate.primary?.rsi);
  const alignedBull = [p4, p1, pd].filter((x) => x === "bullish").length;
  const alignedBear = [p4, p1, pd].filter((x) => x === "bearish").length;

  if (
    candidate.whale.direction === "accumulation" &&
    (alignedBull >= 2 || (Number.isFinite(rsi) && rsi < 30))
  ) {
    return {
      symbol: candidate.symbol,
      verdict: "BUY",
      conviction: Math.min(80, 50 + alignedBull * 8 + (Number.isFinite(rsi) && rsi < 30 ? 8 : 0)),
      reflection: `Deterministic fallback: whale accumulation with ${alignedBull}/3 bullish timeframes in ${regime} regime.`,
    };
  }

  if (candidate.whale.direction === "distribution" && alignedBear >= 2) {
    return {
      symbol: candidate.symbol,
      verdict: "AVOID",
      conviction: Math.min(85, 55 + alignedBear * 8),
      reflection: `Deterministic fallback: whale distribution with ${alignedBear}/3 bearish timeframes in ${regime} regime.`,
    };
  }

  if (candidate.conflict) {
    return {
      symbol: candidate.symbol,
      verdict: "HOLD",
      conviction: 35,
      reflection: "Deterministic fallback: material timeframe conflict; no clean long edge.",
    };
  }

  return {
    symbol: candidate.symbol,
    verdict: "HOLD",
    conviction: 20,
    reflection: "Deterministic fallback: evidence is incomplete or mixed; no defensible long edge.",
  };
}

async function loadLessons(db: ReturnType<typeof getServiceClient>, symbols: string[]) {
  const map = new Map<string, { outcome: string; lesson: string }[]>();
  if (!symbols.length) return map;
  const { data } = await db
    .from("council_lessons")
    .select("symbol,outcome,lesson,created_at")
    .in("symbol", symbols)
    .order("created_at", { ascending: false })
    .limit(symbols.length * 10);

  for (const row of (data ?? []) as Row[]) {
    const symbol = String(row.symbol);
    const bucket = map.get(symbol) ?? [];
    if (bucket.length < 5) {
      bucket.push({ outcome: String(row.outcome ?? "unknown"), lesson: String(row.lesson ?? "") });
      map.set(symbol, bucket);
    }
  }
  return map;
}

async function groqBatch(
  candidates: Candidate[],
  lessons: Map<string, { outcome: string; lesson: string }[]>,
  regime: string,
): Promise<Map<string, CouncilResult>> {
  const result = new Map<string, CouncilResult>();
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey || !candidates.length) return result;

  const payload = candidates.map((c) => ({
    symbol: c.symbol,
    whale_direction: c.whale.direction,
    whale_usd: Math.round(c.whaleUsd),
    whale_buy_usd: Math.round(c.whale.buyUsd),
    whale_sell_usd: Math.round(c.whale.sellUsd),
    whale_buy_count: c.whale.buyCount,
    whale_sell_count: c.whale.sellCount,
    rsi_4h: Number.isFinite(Number(c.primary?.rsi)) ? Number(c.primary?.rsi) : null,
    rsi_1h: Number.isFinite(Number(c.fast?.rsi)) ? Number(c.fast?.rsi) : null,
    rsi_1d: Number.isFinite(Number(c.trend?.rsi)) ? Number(c.trend?.rsi) : null,
    signal_4h: signalOf(c.primary),
    signal_1h: signalOf(c.fast),
    signal_1d: signalOf(c.trend),
    timeframe_alignment: c.conflict ? "conflict" : "partial_or_aligned",
    price: c.primary?.price ?? null,
    vwap_4h: Number.isFinite(Number((c.primary?.raw as Row | undefined)?.vwap))
      ? Number((c.primary?.raw as Row).vwap)
      : null,
    prediction_yes_price: c.prediction?.yes_price ?? null,
    prediction_question: String(c.prediction?.question ?? "").slice(0, 220) || null,
    market_regime: regime,
    past_lessons: (lessons.get(c.symbol) ?? []).slice(0, 3)
      .map((l) => `[${l.outcome}] ${l.lesson.slice(0, 180)}`),
  }));

  const systemPrompt = [
    "You are the TCC long-only trading council.",
    "You are a decision layer, not the risk engine.",
    "Return BUY, HOLD, or AVOID only. Never return SELL, SHORT, leverage, or a bearish trade instruction.",
    "BUY only when there is a defensible long edge. HOLD when evidence is mixed. AVOID when data quality is poor, conflict is material, or downside risk dominates.",
    "Do not invent missing data. Null means unavailable evidence.",
    "Timeframe alignment increases conviction; conflicts reduce it.",
    "Past lessons are evidence, not guarantees.",
    "Return exactly one object per supplied symbol.",
    "Conviction is 0-100 and reflects evidence quality, not certainty.",
    "Reflection is one concise evidence-based sentence.",
  ].join("\n");

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(payload) },
        ],
        temperature: 0.2,
        service_tier: Deno.env.get("GROQ_SERVICE_TIER") ?? "on_demand",
        ...(/gpt-oss/i.test(GROQ_MODEL)
          ? { reasoning_effort: "low", max_completion_tokens: 2048 }
          : { max_tokens: 2048 }),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "tcc_long_only_council_batch",
            strict: true,
            schema: {
              type: "object",
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      symbol: { type: "string" },
                      verdict: { type: "string", enum: ["BUY", "HOLD", "AVOID"] },
                      conviction: { type: "number" },
                      reflection: { type: "string" },
                    },
                    required: ["symbol", "verdict", "conviction", "reflection"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["results"],
              additionalProperties: false,
            },
          },
        },
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });

    if (!response.ok) throw new Error(`Groq HTTP ${response.status}`);

    const body = await response.json() as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const raw = body.choices?.[0]?.message?.content ?? "";
    if (!raw) throw new Error("empty Groq response");

    const parsedBody = JSON.parse(raw) as { results?: { symbol: string; verdict: string; conviction: number; reflection: string }[] };
    const parsed = Array.isArray(parsedBody) ? parsedBody : (parsedBody.results ?? []);

    for (const item of parsed) {
      const symbol = String(item.symbol ?? "").toUpperCase();
      if (!candidates.some((c) => c.symbol === symbol)) continue;
      const verdict = String(item.verdict ?? "").toUpperCase();
      if (!["BUY", "HOLD", "AVOID"].includes(verdict)) continue;
      result.set(symbol, {
        symbol,
        verdict: verdict as Verdict,
        conviction: Math.max(0, Math.min(100, Number(item.conviction) || 0)),
        reflection: String(item.reflection ?? "Groq AI verdict.").slice(0, 500),
      });
    }

    console.log(
      `[TCC_NATIVE_COUNCIL] Groq batch model=${GROQ_MODEL} received=${result.size}/${candidates.length} tokens=${body.usage?.total_tokens ?? 0}`,
    );
  } catch (error) {
    console.error("[TCC_NATIVE_COUNCIL] Groq batch failed:", error);
  }

  return result;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const startedAt = Date.now();
  const db = getServiceClient();

  try {
    const { data: latestAi } = await db
      .from("council_signals")
      .select("source_created_at")
      .eq("depth", "ai-batch")
      .order("source_created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const latestAiAt = latestAi?.source_created_at
      ? new Date(latestAi.source_created_at).getTime()
      : 0;

    const { data: latestComposite } = await db
      .from("composite_signals")
      .select("regime_label,created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const compositeRegimeFresh = latestComposite?.created_at
      ? fresh(latestComposite.created_at, 30 * 60 * 1000)
      : false;
    const regime = compositeRegimeFresh
      ? String(latestComposite?.regime_label ?? "sideways")
      : null;

    const minMinutes = intervalMinutes(regime);
    if (latestAiAt > 0 && Date.now() - latestAiAt < minMinutes * 60_000) {
      return new Response(JSON.stringify({
        ok: true, native: true, skipped: true,
        reason: "ai_batch_rate_guard",
        minutes_since_last: Number(((Date.now() - latestAiAt) / 60_000).toFixed(1)),
        min_minutes: minMinutes, regime,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: snapshot } = await db
      .from("dynamic_watchlist_snapshots")
      .select("symbols,expires_at")
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const watchlist =
      snapshot?.symbols && Array.isArray(snapshot.symbols) && new Date(String(snapshot.expires_at ?? "")).getTime() > Date.now()
        ? (snapshot.symbols as string[]).map((s) => String(s).toUpperCase())
        : CORE_FALLBACK;

    const { data: hot } = await db
      .from("hot_whale_signals")
      .select("symbol")
      .gte("last_seen_at", new Date(Date.now() - 30 * 60_000).toISOString())
      .limit(20);

    const symbols = [...new Set([
      ...watchlist,
      ...((hot ?? []) as Row[]).map((r) => String(r.symbol).toUpperCase()),
    ])].filter(Boolean);

    const whaleSince = new Date(Date.now() - WHALE_LOOKBACK_MS).toISOString();
    const binSymbols = symbols.map(binanceSymbol);

    const [whaleRes, indicatorRes, predictionRes] = await Promise.all([
      db.from("whale_alerts")
        .select("id,symbol,direction,usd_value,created_at")
        .in("symbol", symbols)
        .gte("created_at", whaleSince)
        .order("usd_value", { ascending: false })
        .limit(3000),
      db.from("indicator_snapshots")
        .select("id,symbol,timeframe,created_at,price,rsi,signal,raw")
        .in("symbol", binSymbols)
        .gte("created_at", new Date(Date.now() - INDICATOR_MAX_AGE_MS).toISOString())
        .order("created_at", { ascending: false })
        .limit(5000),
      db.from("prediction_snapshots")
        .select("id,related_symbol,created_at,yes_price,question")
        .in("related_symbol", symbols)
        .gte("created_at", new Date(Date.now() - PREDICTION_MAX_AGE_MS).toISOString())
        .order("created_at", { ascending: false })
        .limit(1000),
    ]);

    if (whaleRes.error) throw whaleRes.error;
    if (indicatorRes.error) throw indicatorRes.error;
    if (predictionRes.error) throw predictionRes.error;

    const whales = (whaleRes.data ?? []) as Row[];
    const indicators = (indicatorRes.data ?? []) as Row[];
    const predictions = (predictionRes.data ?? []) as Row[];
    const effectiveRegime = regime ?? deriveRegime(indicators, whales);

    const bySymbol = new Map<string, Row[]>();
    for (const row of indicators) {
      const symbol = String(row.symbol);
      const bucket = bySymbol.get(symbol) ?? [];
      bucket.push(row);
      bySymbol.set(symbol, bucket);
    }

    const whaleBySymbol = new Map<string, Row[]>();
    for (const row of whales) {
      const symbol = String(row.symbol).toUpperCase();
      const bucket = whaleBySymbol.get(symbol) ?? [];
      if (bucket.length < 30) bucket.push(row);
      whaleBySymbol.set(symbol, bucket);
    }

    const predictionBySymbol = new Map<string, Row>();
    for (const row of predictions) {
      const symbol = String(row.related_symbol ?? "").toUpperCase();
      if (symbol && !predictionBySymbol.has(symbol)) predictionBySymbol.set(symbol, row);
    }

    const candidates: Candidate[] = [];

    for (const symbol of symbols) {
      const rawWhales = whaleBySymbol.get(symbol) ?? [];
      let buyUsd = 0, sellUsd = 0, buyCount = 0, sellCount = 0;
      for (const row of rawWhales) {
        const usd = Number(row.usd_value ?? 0);
        if (row.direction === "accumulation") { buyUsd += usd; buyCount++; }
        if (row.direction === "distribution") { sellUsd += usd; sellCount++; }
      }

      const whaleUsd = buyUsd + sellUsd;
      const direction =
        buyUsd > sellUsd * 1.15 ? "accumulation" :
        sellUsd > buyUsd * 1.15 ? "distribution" :
        whaleUsd > 0 ? "mixed" : "none";

      const rows = bySymbol.get(binanceSymbol(symbol)) ?? [];
      const primary = rows.find((r) => r.timeframe === "4h") ?? null;
      const fast = rows.find((r) => r.timeframe === "1h") ?? null;
      const trend = rows.find((r) => r.timeframe === "1d") ?? null;

      const signals = [primary, fast, trend].filter(Boolean).map((r) => signalOf(r));
      const bull = signals.filter((s) => s === "bullish").length;
      const bear = signals.filter((s) => s === "bearish").length;
      const conflict = bull > 0 && bear > 0;

      const rsi4h = Number(primary?.rsi);
      const qualifies =
        whaleUsd >= whaleFloor(symbol) ||
        (Number.isFinite(rsi4h) && (rsi4h < 30 || rsi4h > 70)) ||
        conflict;

      if (!qualifies) continue;

      candidates.push({
        symbol,
        whale: { direction, usd: whaleUsd, buyUsd, sellUsd, buyCount, sellCount },
        primary, fast, trend,
        prediction: predictionBySymbol.get(symbol) ?? null,
        conflict, whaleUsd,
      });
    }

    // Direction-aware council batching:
    // accumulation is the primary long-only signal and must not compete with
    // oversold context for the same reserved slots. First reserve up to 10
    // slots for accumulation candidates, then use any remaining reserved slots
    // for oversold candidates, and finally keep gross-whale context.
    const accumulationRanked = candidates
      .filter((candidate) => candidate.whale.direction === "accumulation")
      .sort((a, b) => b.whaleUsd - a.whaleUsd);

    const oversoldRanked = candidates
      .filter((candidate) => {
        const rsi4h = Number(candidate.primary?.rsi);
        return (
          candidate.whale.direction !== "accumulation" &&
          Number.isFinite(rsi4h) &&
          rsi4h < 30
        );
      })
      .sort((a, b) => {
        const aRsi = Number(a.primary?.rsi);
        const bRsi = Number(b.primary?.rsi);
        const aScore = b.whaleUsd - a.whaleUsd + (30 - aRsi) * whaleFloor(a.symbol);
        const bScore = a.whaleUsd - b.whaleUsd + (30 - bRsi) * whaleFloor(b.symbol);
        return bScore - aScore;
      });

    const LONG_BATCH_TARGET = Math.min(10, AI_BATCH_MAX);
    const selectedAccumulation = accumulationRanked.slice(0, LONG_BATCH_TARGET);
    const selectedSymbols = new Set(selectedAccumulation.map((candidate) => candidate.symbol));

    const remainingLongSlots = Math.max(0, LONG_BATCH_TARGET - selectedAccumulation.length);
    const selectedOversold = oversoldRanked
      .filter((candidate) => !selectedSymbols.has(candidate.symbol))
      .slice(0, remainingLongSlots);

    for (const candidate of selectedOversold) {
      selectedSymbols.add(candidate.symbol);
    }

    const grossRanked = [...candidates]
      .filter((candidate) => !selectedSymbols.has(candidate.symbol))
      .sort((a, b) => b.whaleUsd - a.whaleUsd);

    const remainingSlots = Math.max(
      0,
      AI_BATCH_MAX - selectedAccumulation.length - selectedOversold.length,
    );
    const batch = [
      ...selectedAccumulation,
      ...selectedOversold,
      ...grossRanked.slice(0, remainingSlots),
    ];

    if (batch.length === 0) {
      return new Response(JSON.stringify({
        ok: true, native: true, skipped: true,
        reason: "no_ai_candidates",
        watchlist_size: symbols.length,
        regime: effectiveRegime,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const lessons = await loadLessons(db, batch.map((c) => c.symbol));
    const aiResults = await groqBatch(batch, lessons, effectiveRegime);
    const batchTimestamp = new Date().toISOString();
    const rowsToWrite: Row[] = [];
    let groqCount = 0;
    let fallbackCount = 0;

    for (const candidate of batch) {
      const ai = aiResults.get(candidate.symbol);
      if (ai) {
        rowsToWrite.push({
          source_id: `tcc-native:${batchTimestamp}:${candidate.symbol}`,
          symbol: candidate.symbol,
          final_verdict: ai.verdict,
          conviction: ai.conviction,
          price_at: Number.isFinite(Number(candidate.primary?.price)) ? Number(candidate.primary?.price) : null,
          reflection: ai.reflection,
          depth: "ai-batch",
          source_created_at: batchTimestamp,
        });
        groqCount++;
      } else {
        const fb = fallback(candidate, effectiveRegime);
        const inputTimes = [
          candidate.primary?.created_at,
          candidate.fast?.created_at,
          candidate.trend?.created_at,
          candidate.prediction?.created_at,
        ].map((v) => new Date(String(v ?? "")).getTime()).filter(Number.isFinite);
        const sourceCreatedAt = inputTimes.length
          ? new Date(Math.min(...inputTimes)).toISOString()
          : batchTimestamp;

        rowsToWrite.push({
          source_id: `tcc-native-fallback:${batchTimestamp}:${candidate.symbol}`,
          symbol: candidate.symbol,
          final_verdict: fb.verdict,
          conviction: fb.conviction,
          price_at: Number.isFinite(Number(candidate.primary?.price)) ? Number(candidate.primary?.price) : null,
          reflection: fb.reflection,
          depth: "ai-synthesis",
          source_created_at: sourceCreatedAt,
        });
        fallbackCount++;
      }
    }

    const { data, error } = await db
      .from("council_signals")
      .upsert(rowsToWrite, { onConflict: "source_id", ignoreDuplicates: false })
      .select("id,symbol,depth,final_verdict,conviction,source_created_at");

    if (error) throw error;

    return new Response(JSON.stringify({
      ok: true,
      native: true,
      source: "tcc-native-groq",
      model: GROQ_MODEL,
      regime: effectiveRegime,
      watchlist_size: symbols.length,
      candidates: candidates.length,
      batch_size: batch.length,
      groq_rows: groqCount,
      fallback_rows: fallbackCount,
      persisted: data?.length ?? 0,
      duration_ms: Date.now() - startedAt,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("[TCC_NATIVE_COUNCIL] fatal:", error);
    return new Response(JSON.stringify({
      ok: false,
      native: true,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startedAt,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

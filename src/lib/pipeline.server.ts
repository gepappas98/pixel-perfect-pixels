import { createHmac } from "crypto";
import { canOpenTrade, RISK_CONFIG } from "./risk.engine";
import { computeFeeAwarePnl, TRADING_FEE_RATE } from "./fees";
import { fetchRelevantLessons, generatePostMortems } from "./council-learning";

/* ───────────── Concurrency helper (pMap) ───────────── */

async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 10,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx]!);
      } catch (e) {
        console.error("[pMap] task failed", e);
        results[idx] = undefined as unknown as R;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ───────────── Watchlist & market config ───────────── */

export const WATCHLIST = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "TRX", "AVAX", "DOT",
  "LINK", "MATIC", "LTC", "BCH", "XLM", "ETC", "ATOM", "ALGO", "VET", "ICP",
  "HBAR", "THETA", "FTM", "RUNE", "KAVA", "EOS", "NEO", "IOTA", "KSM", "CELO",
  "ROSE", "ONE", "ZIL", "NEAR", "APT", "SUI", "SEI", "TIA", "INJ", "ARB",
  "OP", "STRK", "MANTA", "ZK", "BLAST", "LRC", "METIS", "MINA", "W",
  "SHIB", "PEPE", "WIF", "BONK", "FLOKI", "ORDI", "BOME", "MEME",
  "UNI", "CRV", "AAVE", "MKR", "COMP", "SNX", "SUSHI", "1INCH", "CAKE", "DYDX",
  "GMX", "LDO", "ENS", "BAL", "YFI", "UMA", "JUP", "PYTH", "JTO",
  "FET", "RNDR", "WLD", "ARKM", "TAO",
  "SAND", "MANA", "AXS", "GALA", "IMX", "APE", "ENJ", "CHZ",
  "FIL", "AR", "STORJ", "GRT", "ANKR", "BAT", "BAND",
];

const WHALE_MIN_USD: Record<string, number> = {
  BTC: 50_000, ETH: 50_000, BNB: 50_000,
  SOL: 25_000, XRP: 25_000, ADA: 25_000, DOGE: 25_000,
  TRX: 20_000,
  AVAX: 15_000, DOT: 15_000, LTC: 15_000, BCH: 15_000,
  LINK: 10_000, MATIC: 10_000, ATOM: 10_000, NEAR: 10_000,
  APT: 10_000, SUI: 10_000, UNI: 10_000, AAVE: 10_000,
  MKR: 10_000, ETC: 10_000, XLM: 10_000, ICP: 10_000,
  FIL: 10_000, RNDR: 10_000,
  CRV: 5_000, ARB: 5_000, OP: 5_000, INJ: 5_000, TIA: 5_000, SEI: 5_000,
  RUNE: 5_000, FTM: 5_000, HBAR: 5_000, ALGO: 5_000, VET: 5_000,
  SAND: 5_000, MANA: 5_000, AXS: 5_000, GALA: 5_000, IMX: 5_000, GRT: 5_000,
  SHIB: 5_000, PEPE: 5_000, ORDI: 5_000,
  WIF: 3_000, BONK: 3_000, FLOKI: 3_000, BOME: 3_000, MEME: 3_000,
};

const DEFAULT_MIN_WHALE_USD = 25_000;
const whaleFloor = (coin: string) => WHALE_MIN_USD[coin] ?? DEFAULT_MIN_WHALE_USD;

/* Bug #8 fix: HL perps → 2x Binance spot floor (bigger clips on perps). */
const HL_FLOOR_MULTIPLIER = 2;
const hlWhaleFloor = (coin: string) => whaleFloor(coin) * HL_FLOOR_MULTIPLIER;

const TIMEFRAME = "4h";
const KLINE_LIMIT = 100;
const MIN_CONFIDENCE = 0.6;
const STOP_LOSS_PCT = 0.03;
const TAKE_PROFIT_PCT = 0.06;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_OPEN_TRADES = RISK_CONFIG.MAX_OPEN_POSITIONS;
const MAX_ENTRY_DRIFT_PCT = 0.02;
const SYMBOL_COOLDOWN_MINUTES = 60;
const WHALE_LOOKBACK_HOURS = 6;

// Freshness policy: a component older than these limits cannot influence a new
// Composite signal or a new trade. The 4h technical snapshot gets one extra
// candle of tolerance; predictions/council are expected to refresh each cycle.
const INDICATOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PREDICTION_MAX_AGE_MS = 30 * 60 * 1000;
const COUNCIL_MAX_AGE_MS = 30 * 60 * 1000;

function isFresh(value: unknown, maxAgeMs: number, now = Date.now()): boolean {
  const ts = new Date(String(value ?? "")).getTime();
  return Number.isFinite(ts) && now - ts >= 0 && now - ts <= maxAgeMs;
}

function isFreshRow(row: Row, field: string, maxAgeMs: number, now = Date.now()): boolean {
  return !!row && isFresh(row[field], maxAgeMs, now);
}

async function fetchWithTimeout(input: string, init?: RequestInit) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/* ───────────── Hyperliquid universe (cached) ───────────── */

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const TOP_MOVERS_COUNT = 25;
const HL_CACHE_TTL_MS = 60_000;

interface HlTrade {
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  tid: number;
  hash?: string;
}

interface HyperliquidUniverse {
  all: Set<string>;
  top: string[];
  ts: number;
}

let hlUniverseCache: HyperliquidUniverse | null = null;

async function hlPost<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetchWithTimeout(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${String(body["type"])} HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchHyperliquidUniverse(): Promise<HyperliquidUniverse> {
  const now = Date.now();
  if (hlUniverseCache && now - hlUniverseCache.ts < HL_CACHE_TTL_MS) return hlUniverseCache;
  try {
    const [meta, ctxs] = await hlPost<[{ universe: { name: string }[] }, { dayNtlVlm?: string }[]]>({ type: "metaAndAssetCtxs" });
    const all = new Set(meta.universe.map((u) => u.name));
    if (all.size === 0) {
      console.error("[HL] empty universe returned, not caching");
      return { all: new Set(), top: [], ts: 0 };
    }
    const top = meta.universe
      .map((u, i) => ({ coin: u.name, vol: parseFloat(ctxs[i]?.dayNtlVlm ?? "0") || 0 }))
      .sort((a, b) => b.vol - a.vol)
      .slice(0, TOP_MOVERS_COUNT)
      .map((m) => m.coin);
    hlUniverseCache = { all, top, ts: now };
    return hlUniverseCache;
  } catch (e) {
    console.error("[HL] metaAndAssetCtxs failed, not caching empty", e);
    return { all: new Set(), top: [], ts: 0 };
  }
}

async function hyperliquidTopMovers(): Promise<string[]> {
  const { top } = await fetchHyperliquidUniverse();
  return top;
}

/* ───────────── Whale alerts — Hyperliquid ───────────── */

export async function collectWhaleAlerts(): Promise<number> {
  const db = await admin();
  const { all: supported, top: movers } = await fetchHyperliquidUniverse();
  if (supported.size === 0) { console.error("[HL] universe empty — skipping whale fetch"); return 0; }
  const base = new Set(WATCHLIST);
  const supportedBase = WATCHLIST.filter((c) => supported.has(c));
  const skipped = WATCHLIST.length - supportedBase.length;
  if (skipped > 0) console.log(`[HL] ${supportedBase.length}/${WATCHLIST.length} watchlist coins supported (skipped ${skipped})`);
  const coins = [...new Set([...supportedBase, ...movers])];

  const perCoinRows = await pMap(coins, async (coin) => {
    const out: Record<string, unknown>[] = [];
    try {
      const trades = await hlPost<HlTrade[]>({ type: "recentTrades", coin });
      if (!Array.isArray(trades)) return out;
      const source = base.has(coin) ? "hyperliquid-recent-trades" : "hyperliquid-top-mover";
      const floor = hlWhaleFloor(coin);
      for (const t of trades) {
        const usd = parseFloat(t.px) * parseFloat(t.sz);
        if (!Number.isFinite(usd) || usd < floor) continue;
        out.push({
          symbol: coin, chain: "hyperliquid-perp",
          direction: t.side === "B" ? "accumulation" : "distribution",
          usd_value: usd, tx_hash: t.hash ?? String(t.tid), source,
          created_at: new Date(t.time).toISOString(),
          raw: t as unknown as Record<string, unknown>,
        });
      }
    } catch (e) { console.error(`[HL] whale fetch failed for ${coin}`, e); }
    return out;
  }, 10);

  const rows = perCoinRows.flat();
  if (rows.length === 0) return 0;
  const { data, error } = await db.from("whale_alerts").upsert(rows as never, { onConflict: "source,tx_hash", ignoreDuplicates: true }).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Whale alerts — Binance spot ───────────── */

const BINANCE_SYMBOL_MAP: Record<string, string> = { MATIC: "POL", RNDR: "RENDER" };
const binanceSymbol = (coin: string) => `${BINANCE_SYMBOL_MAP[coin] ?? coin}USDT`;

interface BinanceAggTrade { a: number; p: string; q: string; T: number; m: boolean; }

export async function collectExchangeWhaleAlerts(): Promise<number> {
  const db = await admin();

  const perCoinRows = await pMap(WATCHLIST, async (coin) => {
    const out: Record<string, unknown>[] = [];
    try {
      const res = await fetchWithTimeout(`https://api.binance.com/api/v3/aggTrades?symbol=${binanceSymbol(coin)}&limit=1000`);
      if (!res.ok) return out;
      const trades = (await res.json()) as BinanceAggTrade[];
      if (!Array.isArray(trades)) return out;
      const floor = whaleFloor(coin);
      for (const t of trades) {
        const usd = parseFloat(t.p) * parseFloat(t.q);
        if (!Number.isFinite(usd) || usd < floor) continue;
        out.push({
          symbol: coin, chain: "binance-spot",
          direction: t.m ? "distribution" : "accumulation",
          usd_value: usd, tx_hash: String(t.a), source: "binance-agg-trades",
          created_at: new Date(t.T).toISOString(),
          raw: t as unknown as Record<string, unknown>,
        });
      }
    } catch (e) { console.error(`[BINANCE] whale fetch failed for ${coin}`, e); }
    return out;
  }, 10);

  const rows = perCoinRows.flat();
  if (rows.length === 0) return 0;
  const { data, error } = await db.from("whale_alerts").upsert(rows as never, { onConflict: "source,tx_hash", ignoreDuplicates: true }).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Technical indicators ───────────── */

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

function macd(closes: number[]) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const line = e12.map((v, i) => v - e26[i]!);
  const signal = ema(line, 9);
  return { macd: line[line.length - 1]!, signal: signal[signal.length - 1]! };
}

function bollinger(closes: number[], period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  const sd = Math.sqrt(variance);
  return { upper: mean + mult * sd, lower: mean - mult * sd };
}

function classify(r: number, m: number, s: number): "bullish" | "bearish" | "neutral" {
  const momentum = m - s;
  if ((r <= 45 && momentum > 0) || (r < 55 && momentum > 0.001 * Math.abs(m))) return "bullish";
  if ((r >= 55 && momentum < 0) || (r > 45 && momentum < -0.001 * Math.abs(m))) return "bearish";
  return "neutral";
}

export async function collectIndicators(): Promise<number> {
  const db = await admin();
  const movers = await hyperliquidTopMovers();
  const coins = [...new Set([...WATCHLIST, ...movers])];

  const perCoinRows = await pMap(coins, async (coin) => {
    const symbol = binanceSymbol(coin);
    try {
      const res = await fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${TIMEFRAME}&limit=${KLINE_LIMIT}`);
      if (!res.ok) return null;
      const raw = (await res.json()) as unknown[][];
      const closes = raw.map((r) => parseFloat(String(r[4])));
      if (closes.length < 30 || closes.some((c) => !Number.isFinite(c))) return null;
      const r = rsi(closes);
      const { macd: m, signal: s } = macd(closes);
      const bb = bollinger(closes);
      const candleCloseTime = new Date(Number(raw[raw.length - 1]?.[6])).toISOString();
      return {
        symbol, timeframe: TIMEFRAME,
        rsi: Number.isFinite(r) ? r : null,
        macd: m, macd_signal: s, bb_upper: bb.upper, bb_lower: bb.lower,
        price: closes[closes.length - 1]!,
        signal: classify(r, m, s),
        created_at: new Date().toISOString(),
        raw: { closes_tail: closes.slice(-5), candle_close_time: candleCloseTime },
      } as Record<string, unknown>;
    } catch (e) { console.error(`[BINANCE] indicator fetch failed for ${symbol}`, e); return null; }
  }, 10);

  const rows = perCoinRows.filter((r): r is Record<string, unknown> => r != null);
  if (rows.length === 0) return 0;
  const { data, error } = await db.from("indicator_snapshots").upsert(rows as never, { onConflict: "symbol,timeframe", ignoreDuplicates: false }).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Prediction markets — Polymarket Gamma ───────────── */

const WATCH_KEYWORDS: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"], ETH: ["ethereum", "eth"], SOL: ["solana", "sol"],
  XRP: ["xrp", "ripple"], DOGE: ["dogecoin", "doge"], ADA: ["cardano", "ada"],
  AVAX: ["avalanche", "avax"], LINK: ["chainlink", "link"], DOT: ["polkadot", "dot"],
  LTC: ["litecoin", "ltc"], MATIC: ["polygon", "matic", "pol"], BNB: ["bnb", "binance coin"],
  TRX: ["tron", "trx"], SHIB: ["shiba", "shib"], PEPE: ["pepe"],
  ATOM: ["cosmos", "atom"], NEAR: ["near protocol"], APT: ["aptos", "apt"],
  SUI: ["sui"], INJ: ["injective", "inj"], ARB: ["arbitrum", "arb"],
  OP: ["optimism"], UNI: ["uniswap", "uni"], AAVE: ["aave"],
};

const cryptoWord = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|dogecoin|doge|cardano|ada|avalanche|avax|chainlink|link|polkadot|dot|litecoin|ltc|polygon|matic|pol|bnb|binance coin|tron|trx|shiba|shib|pepe|cosmos|atom|near protocol|aptos|apt|sui|injective|inj|arbitrum|arb|optimism|uniswap|uni|aave)\b/i;

interface PolymarketMarket { slug?: string; question?: string; outcomePrices?: string; volume24hr?: number; }
interface PolymarketEvent { markets?: PolymarketMarket[]; }

function eventMarkets(payload: (PolymarketEvent | PolymarketMarket)[]): PolymarketMarket[] {
  return payload.flatMap((item) => "markets" in item ? ((item as PolymarketEvent).markets ?? []) : [item as PolymarketMarket]);
}

/* Bug #9 fix: prefer the symbol whose keyword appears FIRST in the question. */
function matchSymbolFromQuestion(q: string): string | null {
  const matches: { sym: string; pos: number }[] = [];
  for (const [sym, keywords] of Object.entries(WATCH_KEYWORDS)) {
    for (const kw of keywords) {
      const pos = q.search(new RegExp(`\\b${kw}\\b`, "i"));
      if (pos >= 0) { matches.push({ sym, pos }); break; }
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.pos - b.pos);
  return matches[0]!.sym;
}

export async function collectPredictions(): Promise<number> {
  const db = await admin();
  const res = await fetchWithTimeout("https://gamma-api.polymarket.com/events?tag_slug=crypto&active=true&closed=false&limit=200");
  if (!res.ok) return 0;
  const payload = (await res.json()) as PolymarketEvent[] | PolymarketMarket[];
  const markets = eventMarkets(payload);
  const rows: Record<string, unknown>[] = [];
  for (const m of markets) {
    if (!m.slug) continue;
    const question = m.question ?? "";
    const q = question.toLowerCase();
    if (!cryptoWord.test(q)) continue;
    const symbol = matchSymbolFromQuestion(q);
    if (!symbol) continue;
    let yes: number | null = null, no: number | null = null;
    try {
      const prices = JSON.parse(m.outcomePrices ?? "[]") as string[];
      yes = prices[0] ? parseFloat(prices[0]) : null;
      no = prices[1] ? parseFloat(prices[1]) : null;
    } catch { /* unparsable */ }
    if (yes == null || !Number.isFinite(yes) || yes < 0 || yes > 1) continue;
    rows.push({
      market_slug: m.slug, question, related_symbol: symbol,
      yes_price: yes, no_price: no, volume_24h: m.volume24hr ?? null,
      created_at: new Date().toISOString(),
      raw: m as unknown as Record<string, unknown>,
    });
  }
  if (rows.length === 0) return 0;
  const { data, error } = await db.from("prediction_snapshots").upsert(rows as never, { onConflict: "market_slug" }).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Prediction direction helper (Bug #1 fix) ───────────── */

/* Το yes_price είναι η πιθανότητα να συμβεί η ΕΡΩΤΗΣΗ.
 * Αν η ερώτηση είναι "Will dip to X?" → yes=0.19 σημαίνει BULLISH.
 * Αν η ερώτηση είναι "Will reach X?" → yes=0.19 σημαίνει BEARISH. */
const BULLISH_QUESTION = /\b(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\b/i;
const BEARISH_QUESTION = /\b(dip|drop|fall|below|crash|down to|under|bottom)\b/i;

function predictionDirection(prediction: Row): "bullish" | "bearish" | "neutral" {
  const yes = Number(prediction?.["yes_price"]);
  if (!Number.isFinite(yes)) return "neutral";
  const q = String(prediction?.["question"] ?? "").toLowerCase();
  const isBullishQ = BULLISH_QUESTION.test(q);
  const isBearishQ = BEARISH_QUESTION.test(q);
  if (!isBullishQ && !isBearishQ) return "neutral";
  const up = isBullishQ ? yes : 1 - yes;
  if (up > 0.6) return "bullish";
  if (up < 0.4) return "bearish";
  return "neutral";
}

/* ───────────── AI trading council (deterministic fallback) ───────────── */

type Row = Record<string, unknown> | null;
type CouncilVerdict = "BUY" | "SELL" | "HOLD" | "AVOID";

function councilEvaluation(whale: Row, indicator: Row, prediction: Row) {
  const votes: CouncilVerdict[] = [];
  const reasons: string[] = [];
  const technical = indicator?.["signal"];
  if (technical === "bullish") { votes.push("BUY"); reasons.push("quant sees bullish RSI/MACD alignment"); }
  else if (technical === "bearish") { votes.push("SELL"); reasons.push("quant sees bearish RSI/MACD alignment"); }
  else { votes.push("HOLD"); reasons.push("quant sees mixed technicals"); }
  const flow = whale?.["direction"];
  if (flow === "accumulation") { votes.push("BUY"); reasons.push("whale tracker sees accumulation"); }
  else if (flow === "distribution") { votes.push("SELL"); reasons.push("whale tracker sees distribution"); }
  else { votes.push("HOLD"); reasons.push("whale tracker has no directional flow"); }
  const dir = predictionDirection(prediction);
  if (dir === "bullish") { votes.push("BUY"); reasons.push("sentiment leans bullish"); }
  else if (dir === "bearish") { votes.push("SELL"); reasons.push("sentiment leans bearish"); }
  else { votes.push("HOLD"); reasons.push("sentiment is inconclusive"); }
  const counts = votes.reduce<Record<string, number>>((all, vote) => { all[vote] = (all[vote] ?? 0) + 1; return all; }, {});
  const ordered = (Object.entries(counts) as [CouncilVerdict, number][]).sort((a, b) => b[1] - a[1]);
  const [topVote, topCount] = ordered[0] ?? ["HOLD", 0];
  const rawConviction = Math.round((topCount / votes.length) * 100);
  const verdict: CouncilVerdict = topCount === 1 ? "AVOID" : topVote;
  const conviction = verdict === "HOLD" ? 0 : rawConviction;

  const reflection = verdict === "HOLD"
    ? `HOLD (no directional edge): ${reasons.join("; ")}.`
    : `${verdict} with ${conviction}% conviction: ${reasons.join("; ")}.`;

  return { final_verdict: verdict, conviction, reflection };
}

/* ───────────── Groq AI Council ───────────── */

const AI_VERDICT_TTL_MS = 25 * 60 * 1000;
const AI_BATCH_MAX = 15;
const AI_MIN_MINUTES_BETWEEN_BATCHES = 25;
const AI_RSI_OVERSOLD = 30;
const AI_RSI_OVERBOUGHT = 70;
const AI_WHALE_MIN_USD = 25_000;
const GROQ_TIMEOUT_MS = 15_000;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env["GROQ_MODEL"] ?? "openai/gpt-oss-20b";

interface AiCandidate {
  symbol: string;
  whale: Row;
  indicator: Row;
  prediction: Row;
  whaleUsd: number;
}

function qualifiesForAi(whale: Row, indicator: Row, symbol?: string): boolean {
  const whaleUsd = typeof whale?.["usd_value"] === "number" ? (whale["usd_value"] as number) : 0;
  const floor = symbol ? whaleFloor(symbol) : AI_WHALE_MIN_USD;
  if (whaleUsd >= floor) return true;
  const r = typeof indicator?.["rsi"] === "number" ? (indicator["rsi"] as number) : null;
  if (r != null && (r < AI_RSI_OVERSOLD || r > AI_RSI_OVERBOUGHT)) return true;
  return false;
}

async function groqBatchCouncil(
  candidates: AiCandidate[],
): Promise<Map<string, { final_verdict: CouncilVerdict; conviction: number; reflection: string }>> {
  const result = new Map<string, { final_verdict: CouncilVerdict; conviction: number; reflection: string }>();
  if (candidates.length === 0) return result;
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) { console.error("[GROQ] GROQ_API_KEY not set — falling back to deterministic council"); return result; }

  // ── RAG: ανάκτηση προηγούμενων μαθημάτων ανά symbol ──
  const lessonsMap = await fetchRelevantLessons(candidates.map((c) => c.symbol), 5);

  const payload = candidates.map((c) => {
    const lessons = lessonsMap.get(c.symbol) ?? [];
    return {
      symbol: c.symbol,
      whale_direction: c.whale?.["direction"] ?? "none",
      whale_usd: Math.round(c.whaleUsd),
      rsi: typeof c.indicator?.["rsi"] === "number" ? Math.round(c.indicator["rsi"] as number) : null,
      technical_signal: c.indicator?.["signal"] ?? "unknown",
      price: c.indicator?.["price"] ?? null,
      prediction_direction: predictionDirection(c.prediction),
      past_lessons: lessons.map((l) => `[${l.outcome}] ${l.lesson}`),
    };
  });

  const systemPrompt = [
    "You are a professional crypto trading council AI.",
    "You are a confirmation layer, not the sole decision maker.",
    "Do not invent missing data. When signals conflict, prefer HOLD or AVOID.",
    "Respond with ONLY a minified JSON array. No markdown. No code fences.",
    'Shape: [{"symbol":"BTC","verdict":"BUY|SELL|HOLD|AVOID","conviction":0-100,"reflection":"one concise sentence"}]',
    "One object per coin, same order, same symbol names.",
    "AVOID = conflicting signals or high uncertainty.",
    "HOLD = no clear directional edge.",
    "BUY or SELL only when evidence is reasonably aligned.",
    // ── Learning layer ──
    "If past_lessons are provided for a symbol, weigh them as real experience: a lesson learned from a [loss] should reduce confidence in repeating the same mistake; a [win] lesson can increase confidence in the same pattern.",
  ].join("\n");

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: JSON.stringify(payload) }],
        temperature: 0.2,
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    if (!res.ok) { const body = await res.text().catch(() => ""); throw new Error(`Groq HTTP ${res.status}: ${body.slice(0, 300)}`); }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error("Empty Groq response");
    const clean = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as { symbol: string; verdict: string; conviction: number; reflection?: string }[];
    if (!Array.isArray(parsed)) throw new Error("Groq response is not an array");
    for (const item of parsed) {
      const verdict = String(item.verdict ?? "").toUpperCase();
      if (!["BUY", "SELL", "HOLD", "AVOID"].includes(verdict)) continue;
      if (!candidates.some((c) => c.symbol === item.symbol)) continue;
      result.set(item.symbol, {
        final_verdict: verdict as CouncilVerdict,
        conviction: Math.max(0, Math.min(100, Number(item.conviction) || 0)),
        reflection: item.reflection ?? "Groq AI verdict.",
      });
    }
    console.log(`[GROQ] model=${GROQ_MODEL} council batch: ${result.size}/${candidates.length} verdicts received`);
  } catch (e) {
    console.error(`[GROQ] batch failed for [${candidates.map((c) => c.symbol).join(",")}], falling back to deterministic:`, e);
  }
  return result;
}

export async function collectCouncilSignals(): Promise<number> {
  const db = await admin();
  const rows: Record<string, unknown>[] = [];
  const movers = await hyperliquidTopMovers();
  const symbols = [...new Set([...WATCHLIST, ...movers])];
  if (symbols.length === 0) return 0;
  const binSymbols = symbols.map(binanceSymbol);
  const sixHoursAgo = new Date(Date.now() - WHALE_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const aiCacheSince = new Date(Date.now() - AI_VERDICT_TTL_MS).toISOString();
  const [whalesRes, indicatorsRes, predictionsRes, freshAiRes, lastAiRes] = await Promise.all([
    db.from("whale_alerts").select("*").in("symbol", symbols).gte("created_at", sixHoursAgo).order("usd_value", { ascending: false }).limit(2000),
    db.from("indicator_snapshots").select("*").in("symbol", binSymbols).order("created_at", { ascending: false }).limit(2000),
    db.from("prediction_snapshots").select("*").in("related_symbol", symbols).order("created_at", { ascending: false }).limit(1000),
    db.from("council_signals").select("symbol, source_created_at").eq("depth", "ai-batch").in("symbol", symbols).gte("source_created_at", aiCacheSince),
    db.from("council_signals").select("source_created_at").eq("depth", "ai-batch").order("source_created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const whalesBySymbol = new Map<string, Record<string, unknown>[]>();
  for (const w of (whalesRes.data ?? []) as Record<string, unknown>[]) {
    const s = w["symbol"] as string;
    const bucket = whalesBySymbol.get(s);
    if (!bucket) whalesBySymbol.set(s, [w]);
    else if (bucket.length < 20) bucket.push(w);
  }
  const latestIndicator = new Map<string, Record<string, unknown>>();
  for (const i of (indicatorsRes.data ?? []) as Record<string, unknown>[]) {
    const s = i["symbol"] as string;
    if (!latestIndicator.has(s)) latestIndicator.set(s, i);
  }
  const latestPrediction = new Map<string, Record<string, unknown>>();
  for (const p of (predictionsRes.data ?? []) as Record<string, unknown>[]) {
    const s = p["related_symbol"] as string | undefined;
    if (s && !latestPrediction.has(s)) latestPrediction.set(s, p);
  }
  const freshnessNow = Date.now();
  for (const [s, row] of latestIndicator) {
    if (!isFreshRow(row, "created_at", INDICATOR_MAX_AGE_MS, freshnessNow)) latestIndicator.delete(s);
  }
  for (const [s, row] of latestPrediction) {
    if (!isFreshRow(row, "created_at", PREDICTION_MAX_AGE_MS, freshnessNow)) latestPrediction.delete(s);
  }
  const freshAiSymbols = new Set(((freshAiRes.data ?? []) as { symbol: string }[]).map((r) => r.symbol));
  const lastAiAt = lastAiRes.data?.source_created_at ? new Date(lastAiRes.data.source_created_at).getTime() : 0;
  const minutesSinceLastAi = lastAiAt > 0 ? (Date.now() - lastAiAt) / 60_000 : Infinity;
  const aiAllowed = minutesSinceLastAi >= AI_MIN_MINUTES_BETWEEN_BATCHES;
  const perSymbol = new Map<string, { whale: Row; indicator: Row; prediction: Row }>();
  const aiCandidates: AiCandidate[] = [];
  for (const symbol of symbols) {
    const whaleRows = whalesBySymbol.get(symbol) ?? [];
    const buyUsd = whaleRows.filter((r) => r["direction"] === "accumulation").reduce((sum, r) => sum + Number(r["usd_value"] ?? 0), 0);
    const sellUsd = whaleRows.filter((r) => r["direction"] === "distribution").reduce((sum, r) => sum + Number(r["usd_value"] ?? 0), 0);
    const whaleUsdTotal = buyUsd + sellUsd;
    let whaleDirection: "accumulation" | "distribution" | undefined;
    if (buyUsd > sellUsd * 1.15) whaleDirection = "accumulation";
    else if (sellUsd > buyUsd * 1.15) whaleDirection = "distribution";
    const whale = whaleRows.length
      ? ({
          direction: whaleDirection,
          id: whaleRows[0]?.["id"],
          usd_value: whaleUsdTotal,
          buy_usd: buyUsd,
          sell_usd: sellUsd,
          buy_count: whaleRows.filter((r) => r["direction"] === "accumulation").length,
          sell_count: whaleRows.filter((r) => r["direction"] === "distribution").length,
        } as Row)
      : null;
    const indicator = (latestIndicator.get(binanceSymbol(symbol)) ?? null) as Row;
    const prediction = (latestPrediction.get(symbol) ?? null) as Row;
    if (!whale && !indicator && !prediction) continue;
    perSymbol.set(symbol, { whale, indicator, prediction });
    if (!freshAiSymbols.has(symbol) && qualifiesForAi(whale, indicator, symbol)) {
      aiCandidates.push({ symbol, whale, indicator, prediction, whaleUsd: whaleUsdTotal });
    }
  }
  let aiResults = new Map<string, { final_verdict: CouncilVerdict; conviction: number; reflection: string }>();
  if (aiAllowed) {
    aiCandidates.sort((a, b) => b.whaleUsd - a.whaleUsd);
    const aiBatch = aiCandidates.slice(0, AI_BATCH_MAX);
    aiResults = await groqBatchCouncil(aiBatch);
  } else {
    console.log(`[GROQ] Rate guard: skipping AI batch — only ${minutesSinceLastAi.toFixed(1)}min since last run (min ${AI_MIN_MINUTES_BETWEEN_BATCHES}min)`);
  }
  for (const [symbol, ctx] of perSymbol) {
    if (freshAiSymbols.has(symbol)) continue;
    const aiResult = aiResults.get(symbol);
    const usedAi = !!aiResult;
    const result = aiResult ?? councilEvaluation(ctx.whale, ctx.indicator, ctx.prediction);
    const sourceId = [symbol, ctx.whale?.["id"], ctx.indicator?.["id"], ctx.prediction?.["id"], usedAi ? "ai" : "rule"].join(":");
    rows.push({
      symbol, source_id: sourceId,
      final_verdict: result.final_verdict, conviction: result.conviction,
      price_at: typeof ctx.indicator?.["price"] === "number" ? ctx.indicator["price"] : null,
      reflection: result.reflection,
      depth: usedAi ? "ai-batch" : "ai-synthesis",
      source_created_at: new Date().toISOString(),
    });
  }
  if (rows.length === 0) return 0;
  const { data, error } = await db.from("council_signals").upsert(rows as never, { onConflict: "source_id" }).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Signal combiner ───────────── */

const COMPOSITE_AI_MAX_WEIGHT = 0.75;

function ruleBased(whale: Row, indicator: Row, prediction: Row, council: Row) {
  let score = 0;
  const reasons: string[] = [];
  let aiAvoid = false;
  if (whale?.["direction"] === "accumulation") { score += 1; reasons.push("whale accumulation"); }
  else if (whale?.["direction"] === "distribution") { score -= 1; reasons.push("whale distribution"); }
  if (indicator?.["signal"] === "bullish") { score += 1; reasons.push("bullish technicals (RSI/MACD)"); }
  else if (indicator?.["signal"] === "bearish") { score -= 1; reasons.push("bearish technicals (RSI/MACD)"); }

  const predDir = predictionDirection(prediction);
  if (predDir === "bullish") { score += 0.5; reasons.push("prediction market bullish"); }
  else if (predDir === "bearish") { score -= 0.5; reasons.push("prediction market bearish"); }

  if (council?.["final_verdict"]) {
    const convictionRaw = Number(council["conviction"]);
    const conviction = Number.isFinite(convictionRaw) ? Math.max(0, Math.min(100, convictionRaw)) : 50;
    const weight = (conviction / 100) * COMPOSITE_AI_MAX_WEIGHT;
    const verdict = String(council["final_verdict"]).toUpperCase();
    if (verdict === "BUY") { score += weight; reasons.push(`council: BUY (${Math.round(conviction)}% conviction)`); }
    else if (verdict === "SELL") { score -= weight; reasons.push(`council: SELL (${Math.round(conviction)}% conviction)`); }
    else if (verdict === "AVOID") { aiAvoid = conviction >= 60; reasons.push(`council: AVOID (${Math.round(conviction)}% conviction)`); }
    else { reasons.push(`council: HOLD`); }
  }
  let recommendation: "buy" | "sell" | "hold" | "watch" = "watch";
  if (score >= 1.5) recommendation = "buy";
  else if (score <= -1.5) recommendation = "sell";
  else if (Math.abs(score) < 0.5) recommendation = "hold";
  if (aiAvoid) recommendation = "watch";
  const confidence = Math.min(1, Math.abs(score) / 3.25);
  return {
    recommendation,
    confidence,
    reasoning: reasons.length > 0 ? reasons.join("; ") : "insufficient signal",
  };
}

/* Bug #2 fix: fingerprint σταθερό — χωρίς volatile timestamps. */
function signalFingerprint(
  symbol: string, whale: Row, indicator: Row, prediction: Row, council: Row,
  result: ReturnType<typeof ruleBased>,
) {
  const normalize = (value: unknown): string => {
    if (value == null) return "";
    if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(8) : "";
    return String(value);
  };
  const round2 = (v: unknown): string => {
    const n = Number(v);
    return Number.isFinite(n) ? (Math.round(n * 100) / 100).toFixed(2) : "";
  };
  return [
    symbol,
    normalize(whale?.["direction"]),
    normalize(whale?.["buy_usd"]),
    normalize(whale?.["sell_usd"]),
    normalize(whale?.["usd_value"]),
    round2(indicator?.["rsi"]),
    round2(indicator?.["macd"]),
    round2(indicator?.["macd_signal"]),
    round2(indicator?.["price"]),
    normalize(indicator?.["signal"]),
    normalize(prediction?.["market_slug"]),
    normalize(prediction?.["yes_price"]),
    normalize(prediction?.["no_price"]),
    normalize(council?.["final_verdict"]),
    normalize(council?.["conviction"]),
    result.recommendation,
    result.confidence.toFixed(4),
  ].join("|");
}

export async function combineSignals(): Promise<number> {
  const db = await admin();
  const { data: councilRows } = await db.from("council_signals").select("symbol");
  const symbols = [...new Set([...WATCHLIST, ...((councilRows ?? []) as { symbol: string }[]).map((r) => r.symbol)])];
  if (symbols.length === 0) return 0;
  const binSymbols = symbols.map(binanceSymbol);
  const whaleSince = new Date(Date.now() - WHALE_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const [whalesRes, indicatorsRes, predictionsRes, councilsRes] = await Promise.all([
    db.from("whale_alerts").select("*").in("symbol", symbols).gte("created_at", whaleSince).order("created_at", { ascending: false }).limit(3000),
    db.from("indicator_snapshots").select("*").in("symbol", binSymbols).order("created_at", { ascending: false }).limit(2000),
    db.from("prediction_snapshots").select("*").in("related_symbol", symbols).order("created_at", { ascending: false }).limit(1000),
    db.from("council_signals").select("*").in("symbol", symbols).order("source_created_at", { ascending: false }).limit(1000),
  ]);
  const whaleBySymbol = new Map<string, Record<string, unknown>[]>();
  for (const w of (whalesRes.data ?? []) as Record<string, unknown>[]) {
    const s = w["symbol"] as string;
    const bucket = whaleBySymbol.get(s);
    if (!bucket) whaleBySymbol.set(s, [w]);
    else if (bucket.length < 20) bucket.push(w);
  }
  const latestIndicator = new Map<string, Record<string, unknown>>();
  for (const i of (indicatorsRes.data ?? []) as Record<string, unknown>[]) {
    const s = i["symbol"] as string;
    if (!latestIndicator.has(s)) latestIndicator.set(s, i);
  }
  const latestPrediction = new Map<string, Record<string, unknown>>();
  for (const p of (predictionsRes.data ?? []) as Record<string, unknown>[]) {
    const s = p["related_symbol"] as string | undefined;
    if (s && !latestPrediction.has(s)) latestPrediction.set(s, p);
  }
  const latestCouncil = new Map<string, Record<string, unknown>>();
  for (const c of (councilsRes.data ?? []) as Record<string, unknown>[]) {
    const s = c["symbol"] as string;
    if (!latestCouncil.has(s)) latestCouncil.set(s, c);
  }
  const freshnessNow = Date.now();
  for (const [s, row] of latestIndicator) {
    if (!isFreshRow(row, "created_at", INDICATOR_MAX_AGE_MS, freshnessNow)) latestIndicator.delete(s);
  }
  for (const [s, row] of latestPrediction) {
    if (!isFreshRow(row, "created_at", PREDICTION_MAX_AGE_MS, freshnessNow)) latestPrediction.delete(s);
  }
  for (const [s, row] of latestCouncil) {
    if (!isFreshRow(row, "source_created_at", COUNCIL_MAX_AGE_MS, freshnessNow)) latestCouncil.delete(s);
  }
  let created = 0;
  const nowIso = new Date().toISOString();
  for (const symbol of symbols) {
    const whaleRows = whaleBySymbol.get(symbol) ?? [];
    let whale: Row = null;
    if (whaleRows.length > 0) {
      const buyUsd = whaleRows.filter((r) => r["direction"] === "accumulation").reduce((sum, r) => sum + Number(r["usd_value"] ?? 0), 0);
      const sellUsd = whaleRows.filter((r) => r["direction"] === "distribution").reduce((sum, r) => sum + Number(r["usd_value"] ?? 0), 0);
      const whaleUsdTotal = buyUsd + sellUsd;
      let direction: "accumulation" | "distribution" | undefined;
      if (buyUsd > sellUsd * 1.15) direction = "accumulation";
      else if (sellUsd > buyUsd * 1.15) direction = "distribution";
      whale = {
        id: whaleRows[0]?.["id"] ?? null,
        direction, usd_value: whaleUsdTotal, buy_usd: buyUsd, sell_usd: sellUsd,
        buy_count: whaleRows.filter((r) => r["direction"] === "accumulation").length,
        sell_count: whaleRows.filter((r) => r["direction"] === "distribution").length,
      };
    }
    const indicator = (latestIndicator.get(binanceSymbol(symbol)) ?? null) as Row;
    const prediction = (latestPrediction.get(symbol) ?? null) as Row;
    const council = (latestCouncil.get(symbol) ?? null) as Row;
    if (!whale && !indicator && !prediction && !council) continue;
    const result = ruleBased(whale, indicator, prediction, council);
    if (result.recommendation === "hold" && result.confidence === 0) continue;
    if (result.recommendation === "watch") {
      const hasWhale = whale?.["direction"] != null;
      const hasPrediction = predictionDirection(prediction) !== "neutral";
      if (!hasWhale && !hasPrediction) continue;
    }

    const fingerprint = signalFingerprint(symbol, whale, indicator, prediction, council, result);
    const { data, error } = await db
      .from("composite_signals")
      .upsert({
        symbol,
        whale_alert_id: (whaleRows[0]?.["id"] as string) ?? null,
        indicator_snapshot_id: (indicator?.["id"] as string) ?? null,
        prediction_snapshot_id: (prediction?.["id"] as string) ?? null,
        council_signal_id: (council?.["id"] as string) ?? null,
        confidence: result.confidence,
        recommendation: result.recommendation,
        reasoning: result.reasoning,
        fingerprint,
        created_at: nowIso,
      } as never, { onConflict: "fingerprint", ignoreDuplicates: false })
      .select("id");
    if (error) throw error;
    if (data?.length) created += 1;
  }
  return created;
}

/* ───────────── Trade executor ───────────── */

export function tradingMode(): "paper" | "live" {
  const mode = process.env["TRADING_MODE"];
  const liveEnabled = process.env["ENABLE_LIVE_TRADING"] === "true";
  const hasKeys = !!process.env["BINANCE_API_KEY"] && !!process.env["BINANCE_API_SECRET"];
  return mode === "live" && liveEnabled && hasKeys ? "live" : "paper";
}

async function allBinancePrices(): Promise<Map<string, number>> {
  const res = await fetchWithTimeout("https://api.binance.com/api/v3/ticker/price");
  if (!res.ok) throw new Error(`batch price fetch failed HTTP ${res.status}`);
  const data = (await res.json()) as { symbol: string; price: string }[];
  const map = new Map<string, number>();
  for (const d of data) { const p = Number(d.price); if (Number.isFinite(p)) map.set(d.symbol, p); }
  return map;
}

async function placeLiveOrder(coin: string, side: "buy" | "sell", quantity: number) {
  const apiKey = process.env["BINANCE_API_KEY"];
  const apiSecret = process.env["BINANCE_API_SECRET"];
  if (!apiKey || !apiSecret) throw new Error("Binance API credentials are not configured");
  const symbol = binanceSymbol(coin);
  const params = new URLSearchParams({ symbol, side: side.toUpperCase(), type: "MARKET", quantity: quantity.toFixed(6), timestamp: String(Date.now()), recvWindow: "5000" });
  const signature = createHmac("sha256", apiSecret).update(params.toString()).digest("hex");
  const res = await fetch(`https://api.binance.com/api/v3/order?${params.toString()}&signature=${signature}`, { method: "POST", headers: { "X-MBX-APIKEY": apiKey } });
  const body = (await res.json()) as { orderId?: number; msg?: string };
  if (!res.ok) throw new Error(`Binance order rejected: ${body.msg ?? res.status}`);
  return String(body.orderId ?? "");
}

async function closeTriggeredTrades(): Promise<number> {
  const db = await admin();
  const { data: openTrades, error } = await db
    .from("trades")
    .select("id, symbol, side, quantity, entry_price, stop_loss, take_profit, mode")
    .eq("status", "open");
  if (error) throw error;
  const trades = (openTrades ?? []) as {
    id: string; symbol: string; side: "buy" | "sell";
    quantity: number; entry_price: number;
    stop_loss: number | null; take_profit: number | null;
    mode: "paper" | "live";
  }[];
  if (trades.length === 0) return 0;
  let prices: Map<string, number>;
  try { prices = await allBinancePrices(); }
  catch (e) { console.error("batch price fetch failed, skipping close checks", e); return 0; }
  let closed = 0;
  for (const trade of trades) {
    const binSym = binanceSymbol(trade.symbol);
    const price = prices.get(binSym);
    if (price == null) { console.error(`no price for ${trade.symbol} (${binSym})`); continue; }
    const hitStopLoss = trade.stop_loss != null && (trade.side === "buy" ? price <= trade.stop_loss : price >= trade.stop_loss);
    const hitTakeProfit = trade.take_profit != null && (trade.side === "buy" ? price >= trade.take_profit : price <= trade.take_profit);
    if (!hitStopLoss && !hitTakeProfit) continue;

    if (trade.mode === "live") {
      const opposite: "buy" | "sell" = trade.side === "buy" ? "sell" : "buy";
      try {
        await placeLiveOrder(trade.symbol, opposite, Number(trade.quantity));
      } catch (e) {
        console.error(`[LIVE] failed to close ${trade.symbol} ${opposite}:`, e);
        continue;
      }
    }

    const closeReason = hitStopLoss ? "stop_loss" : "take_profit";
    const closedAt = new Date().toISOString();
    const entryPrice = Number(trade.entry_price);
    const fee = computeFeeAwarePnl(trade.side, entryPrice, price, Number(trade.quantity));
    const { data: closedTrade, error: closeError } = await db
      .from("trades")
      .update({
        status: "closed",
        pnl: fee.netPnl, gross_pnl: fee.grossPnl, net_pnl: fee.netPnl,
        entry_fee: fee.entryFee, exit_fee: fee.exitFee, total_fees: fee.totalFees,
        exit_price: price, close_reason: closeReason, closed_at: closedAt,
      })
      .eq("id", trade.id)
      .eq("status", "open")
      .select("id")
      .maybeSingle();
    if (closeError) throw closeError;
    if (!closedTrade) continue;
    const { error: alertError } = await db.from("trade_alerts").insert({
      trade_id: trade.id, symbol: trade.symbol, side: trade.side,
      event_type: closeReason, entry_price: entryPrice, exit_price: price,
      pnl: fee.netPnl, pnl_pct: fee.netPnlPct, created_at: closedAt,
    } as never);
    if (alertError) throw alertError;
    closed += 1;
  }
  return closed;
}

export async function executeTrades(): Promise<number> {
  const db = await admin();
  const mode = tradingMode();
  await closeTriggeredTrades();
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const cooldownSince = new Date(Date.now() - SYMBOL_COOLDOWN_MINUTES * 60 * 1000).toISOString();
  const [signalsRes, openTradesRes, recentlyClosedRes] = await Promise.all([
    db.from("composite_signals").select("*").gte("created_at", since).gte("confidence", MIN_CONFIDENCE).in("recommendation", ["buy", "sell"]),
    db.from("trades").select("symbol").eq("status", "open"),
    db.from("trades").select("symbol").eq("status", "closed").gte("closed_at", cooldownSince),
  ]);
  if (signalsRes.error) throw signalsRes.error;
  if (openTradesRes.error) throw openTradesRes.error;
  if (recentlyClosedRes.error) throw recentlyClosedRes.error;
  const openSymbols = new Set(((openTradesRes.data ?? []) as { symbol: string }[]).map((t) => t.symbol));
  const cooldownSymbols = new Set(((recentlyClosedRes.data ?? []) as { symbol: string }[]).map((t) => t.symbol));
  if (openSymbols.size >= MAX_OPEN_TRADES) return 0;

  let prices: Map<string, number>;
  try { prices = await allBinancePrices(); }
  catch (e) { console.error("batch price fetch failed in executeTrades", e); return 0; }

  let opened = 0;
  for (const signal of (signalsRes.data ?? []) as {
    id: string; symbol: string; recommendation: string;
    price_at?: number | null; created_at?: string | null;
  }[]) {
    if (openSymbols.size >= MAX_OPEN_TRADES) break;
    if (openSymbols.has(signal.symbol)) continue;
    if (cooldownSymbols.has(signal.symbol)) continue;
    const { data: existing } = await db.from("trades").select("id").eq("composite_signal_id", signal.id).limit(1);
    if (existing && existing.length > 0) continue;

    const price = prices.get(binanceSymbol(signal.symbol));
    if (price == null) { console.error(`no price for ${signal.symbol}`); continue; }

    const signalPrice = Number(signal.price_at);
    if (Number.isFinite(signalPrice) && signalPrice > 0 && Math.abs(price - signalPrice) / signalPrice > MAX_ENTRY_DRIFT_PCT) {
      console.log(`[ENTRY_REJECTED] ${signal.symbol}: price drift ${(Math.abs(price - signalPrice) / signalPrice * 100).toFixed(2)}% > ${(MAX_ENTRY_DRIFT_PCT * 100).toFixed(2)}%`);
      continue;
    }
    const side = signal.recommendation as "buy" | "sell";
    const stopLoss = side === "buy" ? price * (1 - STOP_LOSS_PCT) : price * (1 + STOP_LOSS_PCT);
    const takeProfit = side === "buy" ? price * (1 + TAKE_PROFIT_PCT) : price * (1 - TAKE_PROFIT_PCT);

    if (signal.created_at && !isFresh(signal.created_at, 15 * 60 * 1000)) {
      console.log(`[ENTRY_REJECTED] ${signal.symbol}: composite signal is stale`);
      continue;
    }

    const risk = await canOpenTrade(db as any, { symbol: signal.symbol, side, entryPrice: price, stopLoss, currentPrices: prices });
    if (!risk.allowed) {
      console.log(`[RISK_REJECTED] ${signal.symbol} ${side}: ${risk.reason}`);
      continue;
    }
    if (!Number.isFinite(risk.quantity) || risk.quantity <= 0) {
      console.log(`[RISK_INVALID] ${signal.symbol}: quantity=${risk.quantity}`);
      continue;
    }
    console.log(`[RISK_APPROVED] ${signal.symbol} ${side} | qty=${risk.quantity.toFixed(6)} notional=${risk.notional.toFixed(2)}`);
    const quantity = risk.quantity;
    let exchangeOrderId: string | null = null;
    if (mode === "live") {
      try { exchangeOrderId = await placeLiveOrder(signal.symbol, side, quantity); }
      catch (e) { console.error("live order failed", e); continue; }
    }
    const entryFee = price * quantity * TRADING_FEE_RATE;
    const { error: tradeErr } = await db.from("trades").insert({
      composite_signal_id: signal.id,
      symbol: signal.symbol, side, quantity,
      entry_price: price, stop_loss: stopLoss, take_profit: takeProfit,
      mode, status: "open",
      exchange_order_id: exchangeOrderId,
      entry_fee: entryFee,
    } as never);
    if (tradeErr) {
      // The unique open-per-symbol index is the final atomic race guard.
      // With the pipeline lock active, this normally means another writer
      // (e.g. a manual/API invocation) won the race.
      if ((tradeErr as { code?: string }).code === "23505") {
        console.log(`[ENTRY_SKIPPED] ${signal.symbol}: open trade already exists (atomic DB guard)`);
        continue;
      }
      throw tradeErr;
    }
    openSymbols.add(signal.symbol);
    opened += 1;
  }
  return opened;
}

/* ───────────── Full pipeline with step tracking + learning ───────────── */

export async function runFullPipeline() {
  const db = await admin();
  const startedAt = new Date();
  const { data: runRow, error: insertError } = await db
    .from("pipeline_runs")
    .insert({ job_name: "runFullPipeline", started_at: startedAt.toISOString(), status: "running" } as never)
    .select("id")
    .single();

  // The partial unique index on (job_name) WHERE status='running' is the
  // atomic mutex. A conflict means another pipeline is already executing.
  // NEVER continue without a run row: doing so would defeat the lock.
  if (insertError) {
    const code = (insertError as { code?: string }).code;
    if (code === "23505") {
      console.log("[PIPELINE_LOCK] another run is already active; skipping this invocation");
      return { skipped: true, reason: "pipeline_locked" };
    }
    throw new Error(`pipeline start/lock failed: ${insertError.message}`);
  }
  const runId = (runRow as { id: string }).id;

  let step = "init";
  try {
    step = "whales";
    const [hlWhales, exWhales] = await Promise.all([collectWhaleAlerts(), collectExchangeWhaleAlerts()]);
    const whales = hlWhales + exWhales;

    step = "indicators";
    const indicators = await collectIndicators();

    step = "predictions";
    const predictions = await collectPredictions();

    step = "council";
    const council = await collectCouncilSignals();

    step = "signals";
    const signals = await combineSignals();

    step = "trades";
    const trades = await executeTrades();
    const mode = tradingMode();

    // ── Post-mortem: learning από κλειστά trades ──
    step = "post-mortem";
    const lessons = await generatePostMortems();
    if (lessons > 0) console.log(`[LESSON] Generated ${lessons} new lessons`);

    const completedAt = new Date();
    const summary = {
      completed_at: completedAt.toISOString(),
      duration_ms: completedAt.getTime() - startedAt.getTime(),
      status: "success", whales, indicators, predictions, council, signals, trades, mode,
      error_message: null,
    };
    if (runId) {
      const { error: updateError } = await db.from("pipeline_runs").update(summary as never).eq("id", runId);
      if (updateError) console.error("failed to update pipeline run", updateError);
    }
    return { whales, indicators, predictions, council, signals, trades, mode };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const message = `[step: ${step}] ${raw}`;
    const completedAt = new Date();
    console.error(`[PIPELINE_FAILED] ${message}`);
    if (runId) {
      const { error: updateError } = await db.from("pipeline_runs").update({
        completed_at: completedAt.toISOString(),
        duration_ms: completedAt.getTime() - startedAt.getTime(),
        status: "error",
        error_message: message,
      } as never).eq("id", runId);
      if (updateError) console.error("failed to record pipeline error", updateError);
    }
    throw new Error(message);
  }
}

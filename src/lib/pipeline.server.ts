import { createHmac } from "crypto";
import { canOpenTrade, RISK_CONFIG } from "./risk.engine";
import { computeFeeAwarePnl, TRADING_FEE_RATE } from "./fees";
import { fetchRelevantLessons, generatePostMortems } from "./council-learning";
import {
  DEFAULT_STRATEGY,
  STRATEGY_PRESETS,
  type StrategyConfig,
} from "./strategy.presets";
import { maybeAutoSwitchStrategy } from "./strategy.functions";
import { fetchCleanupConfig } from "./cleanup-config.server";
import { detectHardConflict } from "./watch-conflict";
import { serializeError } from "./error-serialize";

/* ───────────── Shared types (declared first) ───────────── */

type Row = Record<string, unknown> | null;
type CouncilVerdict = "BUY" | "SELL" | "HOLD" | "AVOID";
type SignalDir = "bullish" | "bearish" | "neutral";

/* ───────────── Concurrency helper (pMap) ───────────── */

async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 15,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
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
    },
  );
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
const whaleFloor = (coin: string) =>
  WHALE_MIN_USD[coin] ?? DEFAULT_MIN_WHALE_USD;

const HL_FLOOR_MULTIPLIER = 2;
const hlWhaleFloor = (coin: string) => whaleFloor(coin) * HL_FLOOR_MULTIPLIER;

const PRIMARY_TIMEFRAME = "4h";
const FAST_TIMEFRAME = "1h";
const TREND_TIMEFRAME = "1d";
const TIMEFRAMES = [
  PRIMARY_TIMEFRAME,
  FAST_TIMEFRAME,
  TREND_TIMEFRAME,
] as const;
const KLINE_LIMIT = 100;

const MIN_CONFIDENCE = 0.6;
const STOP_LOSS_PCT = 0.03;
const TAKE_PROFIT_PCT = 0.04;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_OPEN_TRADES = RISK_CONFIG.MAX_OPEN_POSITIONS;
const MAX_ENTRY_DRIFT_PCT = 0.02;
const SYMBOL_COOLDOWN_MINUTES = 15;
const WHALE_LOOKBACK_HOURS = 6;

const STALE_EXIT_HOURS = 48;
const STALE_EXIT_MIN_PNL_PCT = 1.0;
const MAX_HOLD_HOURS = 168;

const ROTATION_MIN_NEW_CONFIDENCE = 0.75;
const ROTATION_CONFIDENCE_IMPROVEMENT = 0.10;
const ROTATION_MIN_OPEN_AGE_MINUTES = 30;
const ROTATION_MAX_WEAKEST_PNL_PCT = 0.5;

const INDICATOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PREDICTION_MAX_AGE_MS = 30 * 60 * 1000;
const COUNCIL_MAX_AGE_MS = 30 * 60 * 1000;

const STRATEGY_CACHE_TTL_MS = 60_000;

// Variant outcome tracking
const VARIANT_TP_PCT = 0.04;
const VARIANT_SL_PCT = 0.03;
const VARIANT_MAX_HOURS = 168;
const VARIANT_RESOLVE_BATCH = 500;

function isFresh(value: unknown, maxAgeMs: number, now = Date.now()): boolean {
  const ts = new Date(String(value ?? "")).getTime();
  return Number.isFinite(ts) && now - ts >= 0 && now - ts <= maxAgeMs;
}

function isFreshRow(
  row: Row,
  field: string,
  maxAgeMs: number,
  now = Date.now(),
): boolean {
  return !!row && isFresh(row[field], maxAgeMs, now);
}

async function fetchWithTimeout(input: string, init?: RequestInit) {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

type Admin = Awaited<
  typeof import("@/integrations/supabase/client.server")
>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import(
    "@/integrations/supabase/client.server"
  );
  return supabaseAdmin;
}

/* ───────────── Strategy loader (cached) ───────────── */

let strategyCache: { config: StrategyConfig; ts: number } | null = null;

async function fetchStrategy(): Promise<StrategyConfig> {
  const now = Date.now();
  if (strategyCache && now - strategyCache.ts < STRATEGY_CACHE_TTL_MS) {
    return strategyCache.config;
  }
  try {
    const db = await admin();
    const { data, error } = await db
      .from("strategy_config")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      strategyCache = { config: DEFAULT_STRATEGY, ts: now };
      return DEFAULT_STRATEGY;
    }
    const row = data as Record<string, unknown>;
    const config: StrategyConfig = {
      whale_weight: Number(row["whale_weight"]),
      technicals_weight: Number(row["technicals_weight"]),
      prediction_weight: Number(row["prediction_weight"]),
      council_weight: Number(row["council_weight"]),
      preset_name: (row["preset_name"] as string | null) ?? null,
      updated_at: String(row["updated_at"]),
    };
    strategyCache = { config, ts: now };
    return config;
  } catch (e) {
    console.error("[STRATEGY] load failed, using defaults", e);
    return DEFAULT_STRATEGY;
  }
}

export function invalidateStrategyCache() {
  strategyCache = null;
}

/* ───────────── Hyperliquid universe ───────────── */

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
  if (!res.ok)
    throw new Error(`Hyperliquid ${String(body["type"])} HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchHyperliquidUniverse(): Promise<HyperliquidUniverse> {
  const now = Date.now();
  if (hlUniverseCache && now - hlUniverseCache.ts < HL_CACHE_TTL_MS)
    return hlUniverseCache;
  try {
    const [meta, ctxs] = await hlPost<
      [{ universe: { name: string }[] }, { dayNtlVlm?: string }[]]
    >({ type: "metaAndAssetCtxs" });
    const all = new Set(meta.universe.map((u) => u.name));
    if (all.size === 0) {
      console.error("[HL] empty universe returned, not caching");
      return { all: new Set(), top: [], ts: 0 };
    }
    const top = meta.universe
      .map((u, i) => ({
        coin: u.name,
        vol: parseFloat(ctxs[i]?.dayNtlVlm ?? "0") || 0,
      }))
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
  if (supported.size === 0) {
    console.error("[HL] universe empty — skipping whale fetch");
    return 0;
  }
  const base = new Set(WATCHLIST);
  const supportedBase = WATCHLIST.filter((c) => supported.has(c));
  const skipped = WATCHLIST.length - supportedBase.length;
  if (skipped > 0)
    console.log(
      `[HL] ${supportedBase.length}/${WATCHLIST.length} watchlist coins supported (skipped ${skipped})`,
    );
  const coins = [...new Set([...supportedBase, ...movers])];

  const perCoinRows = await pMap(
    coins,
    async (coin) => {
      const out: Record<string, unknown>[] = [];
      try {
        const trades = await hlPost<HlTrade[]>({ type: "recentTrades", coin });
        if (!Array.isArray(trades)) return out;
        const source = base.has(coin)
          ? "hyperliquid-recent-trades"
          : "hyperliquid-top-mover";
        const floor = hlWhaleFloor(coin);
        for (const t of trades) {
          const usd = parseFloat(t.px) * parseFloat(t.sz);
          if (!Number.isFinite(usd) || usd < floor) continue;
          out.push({
            symbol: coin,
            chain: "hyperliquid-perp",
            direction: t.side === "B" ? "accumulation" : "distribution",
            usd_value: usd,
            tx_hash: t.hash ?? String(t.tid),
            source,
            created_at: new Date(t.time).toISOString(),
            raw: t as unknown as Record<string, unknown>,
          });
        }
      } catch (e) {
        console.error(`[HL] whale fetch failed for ${coin}`, e);
      }
      return out;
    },
    10,
  );

  const rows = perCoinRows.flat();
  if (rows.length === 0) return 0;
  const { data, error } = await db
    .from("whale_alerts")
    .upsert(rows as never, {
      onConflict: "source,tx_hash",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Whale alerts — Binance spot ───────────── */

const BINANCE_SYMBOL_MAP: Record<string, string> = {
  MATIC: "POL",
  RNDR: "RENDER",
};
const binanceSymbol = (coin: string) =>
  `${BINANCE_SYMBOL_MAP[coin] ?? coin}USDT`;

interface BinanceAggTrade {
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export async function collectExchangeWhaleAlerts(): Promise<number> {
  const db = await admin();

  const perCoinRows = await pMap(
    WATCHLIST,
    async (coin) => {
      const out: Record<string, unknown>[] = [];
      try {
        const res = await fetchWithTimeout(
          `https://api.binance.com/api/v3/aggTrades?symbol=${binanceSymbol(coin)}&limit=1000`,
        );
        if (!res.ok) return out;
        const trades = (await res.json()) as BinanceAggTrade[];
        if (!Array.isArray(trades)) return out;
        const floor = whaleFloor(coin);
        for (const t of trades) {
          const usd = parseFloat(t.p) * parseFloat(t.q);
          if (!Number.isFinite(usd) || usd < floor) continue;
          out.push({
            symbol: coin,
            chain: "binance-spot",
            direction: t.m ? "distribution" : "accumulation",
            usd_value: usd,
            tx_hash: String(t.a),
            source: "binance-agg-trades",
            created_at: new Date(t.T).toISOString(),
            raw: t as unknown as Record<string, unknown>,
          });
        }
      } catch (e) {
        console.error(`[BINANCE] whale fetch failed for ${coin}`, e);
      }
      return out;
    },
    10,
  );

  const rows = perCoinRows.flat();
  if (rows.length === 0) return 0;
  const { data, error } = await db
    .from("whale_alerts")
    .upsert(rows as never, {
      onConflict: "source,tx_hash",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Technical indicators ───────────── */

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period,
    avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++)
    out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

function macd(closes: number[]) {
  const e12 = ema(closes, 12),
    e26 = ema(closes, 26);
  const line = e12.map((v, i) => v - e26[i]!);
  const signal = ema(line, 9);
  return { macd: line[line.length - 1]!, signal: signal[signal.length - 1]! };
}

function bollinger(closes: number[], period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance =
    slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  const sd = Math.sqrt(variance);
  return { upper: mean + mult * sd, lower: mean - mult * sd };
}

function classify(
  r: number,
  m: number,
  s: number,
): "bullish" | "bearish" | "neutral" {
  const momentum = m - s;
  if ((r <= 45 && momentum > 0) || (r < 55 && momentum > 0.001 * Math.abs(m)))
    return "bullish";
  if ((r >= 55 && momentum < 0) || (r > 45 && momentum < -0.001 * Math.abs(m)))
    return "bearish";
  return "neutral";
}

async function fetchIndicatorForTimeframe(
  coin: string,
  timeframe: string,
): Promise<Record<string, unknown> | null> {
  const symbol = binanceSymbol(coin);
  try {
    const res = await fetchWithTimeout(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${timeframe}&limit=${KLINE_LIMIT}`,
    );
    if (!res.ok) return null;
    const raw = (await res.json()) as unknown[][];
    const closes = raw.map((r) => parseFloat(String(r[4])));
    if (closes.length < 30 || closes.some((c) => !Number.isFinite(c)))
      return null;
    const r = rsi(closes);
    const { macd: m, signal: s } = macd(closes);
    const bb = bollinger(closes);
    const candleCloseTime = new Date(
      Number(raw[raw.length - 1]?.[6]),
    ).toISOString();
    return {
      symbol,
      timeframe,
      rsi: Number.isFinite(r) ? r : null,
      macd: m,
      macd_signal: s,
      bb_upper: bb.upper,
      bb_lower: bb.lower,
      price: closes[closes.length - 1]!,
      signal: classify(r, m, s),
      created_at: new Date().toISOString(),
      raw: { closes_tail: closes.slice(-5), candle_close_time: candleCloseTime },
    };
  } catch (e) {
    console.error(
      `[BINANCE] indicator fetch failed for ${symbol} ${timeframe}`,
      e,
    );
    return null;
  }
}

export async function collectIndicators(): Promise<number> {
  const db = await admin();
  const movers = await hyperliquidTopMovers();
  const coins = [...new Set([...WATCHLIST, ...movers])];

  const tasks: { coin: string; timeframe: string }[] = [];
  for (const coin of coins) {
    for (const tf of TIMEFRAMES) {
      tasks.push({ coin, timeframe: tf });
    }
  }

  const results = await pMap(
    tasks,
    async ({ coin, timeframe }) => {
      return fetchIndicatorForTimeframe(coin, timeframe);
    },
    15,
  );

  const rows = results.filter(
    (r): r is Record<string, unknown> => r != null,
  );
  if (rows.length === 0) return 0;
  const { data, error } = await db
    .from("indicator_snapshots")
    .upsert(rows as never, {
      onConflict: "symbol,timeframe",
      ignoreDuplicates: false,
    })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Prediction markets ───────────── */

const WATCH_KEYWORDS: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "eth"],
  SOL: ["solana", "sol"],
  XRP: ["xrp", "ripple"],
  DOGE: ["dogecoin", "doge"],
  ADA: ["cardano", "ada"],
  AVAX: ["avalanche", "avax"],
  LINK: ["chainlink", "link"],
  DOT: ["polkadot", "dot"],
  LTC: ["litecoin", "ltc"],
  MATIC: ["polygon", "matic", "pol"],
  BNB: ["bnb", "binance coin"],
  TRX: ["tron", "trx"],
  SHIB: ["shiba", "shib"],
  PEPE: ["pepe"],
  ATOM: ["cosmos", "atom"],
  NEAR: ["near protocol"],
  APT: ["aptos", "apt"],
  SUI: ["sui"],
  INJ: ["injective", "inj"],
  ARB: ["arbitrum", "arb"],
  OP: ["optimism"],
  UNI: ["uniswap", "uni"],
  AAVE: ["aave"],
};

const cryptoWord =
  /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|dogecoin|doge|cardano|ada|avalanche|avax|chainlink|link|polkadot|dot|litecoin|ltc|polygon|matic|pol|bnb|binance coin|tron|trx|shiba|shib|pepe|cosmos|atom|near protocol|aptos|apt|sui|injective|inj|arbitrum|arb|optimism|uniswap|uni|aave)\b/i;

interface PolymarketMarket {
  slug?: string;
  question?: string;
  outcomePrices?: string;
  volume24hr?: number;
}
interface PolymarketEvent {
  markets?: PolymarketMarket[];
}

function eventMarkets(
  payload: (PolymarketEvent | PolymarketMarket)[],
): PolymarketMarket[] {
  return payload.flatMap((item) =>
    "markets" in item
      ? ((item as PolymarketEvent).markets ?? [])
      : [item as PolymarketMarket],
  );
}

function matchSymbolFromQuestion(q: string): string | null {
  const matches: { sym: string; pos: number }[] = [];
  for (const [sym, keywords] of Object.entries(WATCH_KEYWORDS)) {
    for (const kw of keywords) {
      const pos = q.search(new RegExp(`\\b${kw}\\b`, "i"));
      if (pos >= 0) {
        matches.push({ sym, pos });
        break;
      }
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.pos - b.pos);
  return matches[0]!.sym;
}

export async function collectPredictions(): Promise<number> {
  const db = await admin();
  const res = await fetchWithTimeout(
    "https://gamma-api.polymarket.com/events?tag_slug=crypto&active=true&closed=false&limit=200",
  );
  if (!res.ok) return 0;
  const payload = (await res.json()) as
    | PolymarketEvent[]
    | PolymarketMarket[];
  const markets = eventMarkets(payload);
  const rows: Record<string, unknown>[] = [];
  for (const m of markets) {
    if (!m.slug) continue;
    const question = m.question ?? "";
    const q = question.toLowerCase();
    if (!cryptoWord.test(q)) continue;
    const symbol = matchSymbolFromQuestion(q);
    if (!symbol) continue;
    let yes: number | null = null,
      no: number | null = null;
    try {
      const prices = JSON.parse(m.outcomePrices ?? "[]") as string[];
      yes = prices[0] ? parseFloat(prices[0]) : null;
      no = prices[1] ? parseFloat(prices[1]) : null;
    } catch {
      /* unparsable */
    }
    if (yes == null || !Number.isFinite(yes) || yes < 0 || yes > 1) continue;
    rows.push({
      market_slug: m.slug,
      question,
      related_symbol: symbol,
      yes_price: yes,
      no_price: no,
      volume_24h: m.volume24hr ?? null,
      created_at: new Date().toISOString(),
      raw: m as unknown as Record<string, unknown>,
    });
  }
  if (rows.length === 0) return 0;
  const { data, error } = await db
    .from("prediction_snapshots")
    .upsert(rows as never, { onConflict: "market_slug" })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Prediction direction helper ───────────── */

const BULLISH_QUESTION =
  /\b(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\b/i;
const BEARISH_QUESTION =
  /\b(dip|drop|fall|below|crash|down to|under|bottom)\b/i;

function predictionDirection(
  prediction: Row,
): "bullish" | "bearish" | "neutral" {
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

/* ───────────── Multi-timeframe evaluator ───────────── */

interface MultiTfInput {
  primary: Row;
  fast: Row;
  trend: Row;
}

interface MultiTfResult {
  direction: SignalDir;
  score: number;
  aligned: boolean;
  conflict: boolean;
  detail: string;
}

function evaluateMultiTimeframe(tf: MultiTfInput): MultiTfResult {
  const p = (tf.primary?.["signal"] as SignalDir | undefined) ?? "neutral";
  const f = (tf.fast?.["signal"] as SignalDir | undefined) ?? "neutral";
  const t = (tf.trend?.["signal"] as SignalDir | undefined) ?? "neutral";

  const label = (s: SignalDir) =>
    s === "bullish" ? "bull" : s === "bearish" ? "bear" : "neu";
  const detail = `4h ${label(p)} · 1h ${label(f)} · 1d ${label(t)}`;

  if (p === "neutral") {
    return {
      direction: "neutral",
      score: 0,
      aligned: false,
      conflict: false,
      detail,
    };
  }

  const base = p === "bullish" ? 1.0 : -1.0;
  let multiplier = 1.0;
  if (f === p) multiplier *= 1.3;
  else if (f !== "neutral") multiplier *= 0.7;
  if (t === p) multiplier *= 1.3;
  else if (t !== "neutral") multiplier *= 0.7;

  const aligned = f === p && t === p;
  const conflict = t !== "neutral" && t !== p;

  return { direction: p, score: base * multiplier, aligned, conflict, detail };
}

/* ───────────── Deterministic council fallback ───────────── */

function councilEvaluation(whale: Row, mtf: MultiTfResult, prediction: Row) {
  const votes: CouncilVerdict[] = [];
  const reasons: string[] = [];

  if (mtf.direction === "bullish" && mtf.score >= 0.7) {
    votes.push("BUY");
    reasons.push(`quant sees bullish alignment (${mtf.detail})`);
  } else if (mtf.direction === "bearish" && mtf.score <= -0.7) {
    votes.push("SELL");
    reasons.push(`quant sees bearish alignment (${mtf.detail})`);
  } else if (mtf.aligned) {
    votes.push(mtf.direction === "bullish" ? "BUY" : "SELL");
    reasons.push(`quant sees aligned trend (${mtf.detail})`);
  } else {
    votes.push("HOLD");
    reasons.push(`quant sees mixed technicals (${mtf.detail})`);
  }

  const flow = whale?.["direction"];
  if (flow === "accumulation") {
    votes.push("BUY");
    reasons.push("whale tracker sees accumulation");
  } else if (flow === "distribution") {
    votes.push("SELL");
    reasons.push("whale tracker sees distribution");
  } else {
    votes.push("HOLD");
    reasons.push("whale tracker has no directional flow");
  }

  const dir = predictionDirection(prediction);
  if (dir === "bullish") {
    votes.push("BUY");
    reasons.push("sentiment leans bullish");
  } else if (dir === "bearish") {
    votes.push("SELL");
    reasons.push("sentiment leans bearish");
  } else {
    votes.push("HOLD");
    reasons.push("sentiment is inconclusive");
  }

  const counts = votes.reduce<Record<string, number>>((all, vote) => {
    all[vote] = (all[vote] ?? 0) + 1;
    return all;
  }, {});
  const ordered = (
    Object.entries(counts) as [CouncilVerdict, number][]
  ).sort((a, b) => b[1] - a[1]);
  const [topVote, topCount] = ordered[0] ?? ["HOLD", 0];
  const rawConviction = Math.round((topCount / votes.length) * 100);
  const verdict: CouncilVerdict = topCount === 1 ? "AVOID" : topVote;
  const conviction = verdict === "HOLD" ? 0 : rawConviction;
  const reflection =
    verdict === "HOLD"
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
  mtf: MultiTfResult;
  mtfRaw: MultiTfInput;
  prediction: Row;
  whaleUsd: number;
}

function qualifiesForAi(
  whale: Row,
  mtf: MultiTfResult,
  symbol?: string,
): boolean {
  const whaleUsd =
    typeof whale?.["usd_value"] === "number"
      ? (whale["usd_value"] as number)
      : 0;
  const floor = symbol ? whaleFloor(symbol) : AI_WHALE_MIN_USD;
  if (whaleUsd >= floor) return true;
  const rsi4h = Number((mtf as unknown as { rsi4h?: number }).rsi4h);
  if (
    Number.isFinite(rsi4h) &&
    (rsi4h < AI_RSI_OVERSOLD || rsi4h > AI_RSI_OVERBOUGHT)
  )
    return true;
  if (mtf.conflict) return true;
  return false;
}

async function groqBatchCouncil(
  candidates: AiCandidate[],
): Promise<
  Map<
    string,
    { final_verdict: CouncilVerdict; conviction: number; reflection: string }
  >
> {
  const result = new Map<
    string,
    { final_verdict: CouncilVerdict; conviction: number; reflection: string }
  >();
  if (candidates.length === 0) return result;
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) {
    console.error(
      "[GROQ] GROQ_API_KEY not set — falling back to deterministic council",
    );
    return result;
  }

  const lessonsMap = await fetchRelevantLessons(
    candidates.map((c) => c.symbol),
    5,
  );

  const payload = candidates.map((c) => {
    const lessons = lessonsMap.get(c.symbol) ?? [];
    const p4 = c.mtfRaw.primary;
    const p1 = c.mtfRaw.fast;
    const pd = c.mtfRaw.trend;
    return {
      symbol: c.symbol,
      whale_direction: c.whale?.["direction"] ?? "none",
      whale_usd: Math.round(c.whaleUsd),
      rsi_4h:
        typeof p4?.["rsi"] === "number"
          ? Math.round(p4["rsi"] as number)
          : null,
      rsi_1h:
        typeof p1?.["rsi"] === "number"
          ? Math.round(p1["rsi"] as number)
          : null,
      rsi_1d:
        typeof pd?.["rsi"] === "number"
          ? Math.round(pd["rsi"] as number)
          : null,
      signal_4h: p4?.["signal"] ?? "neutral",
      signal_1h: p1?.["signal"] ?? "neutral",
      signal_1d: pd?.["signal"] ?? "neutral",
      timeframe_alignment: c.mtf.aligned
        ? "all-aligned"
        : c.mtf.conflict
          ? "conflict"
          : "partial",
      price: p4?.["price"] ?? null,
      prediction_direction: predictionDirection(c.prediction),
      past_lessons: lessons.map((l) => `[${l.outcome}] ${l.lesson}`),
    };
  });

  const systemPrompt = [
    "You are a professional crypto trading council AI.",
    "You receive signals across 3 timeframes: 4h (primary), 1h (fast), 1d (trend).",
    "Timeframe alignment increases confidence; conflicts reduce it.",
    "Do not invent missing data. When signals conflict, prefer HOLD or AVOID.",
    "Respond with ONLY a minified JSON array. No markdown. No code fences.",
    'Shape: [{"symbol":"BTC","verdict":"BUY|SELL|HOLD|AVOID","conviction":0-100,"reflection":"one concise sentence"}]',
    "One object per coin, same order, same symbol names.",
    "AVOID = conflicting signals or high uncertainty.",
    "HOLD = no clear directional edge.",
    "BUY or SELL only when evidence is reasonably aligned.",
    "If past_lessons are provided, weigh them as real experience: [loss] reduces confidence, [win] increases it.",
  ].join("\n");

  try {
    const res = await fetch(GROQ_URL, {
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
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Groq HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error("Empty Groq response");
    const clean = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as {
      symbol: string;
      verdict: string;
      conviction: number;
      reflection?: string;
    }[];
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
    console.log(
      `[GROQ] model=${GROQ_MODEL} council batch: ${result.size}/${candidates.length} verdicts received`,
    );
  } catch (e) {
    console.error(
      `[GROQ] batch failed for [${candidates.map((c) => c.symbol).join(",")}], falling back to deterministic:`,
      e,
    );
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
  const sixHoursAgo = new Date(
    Date.now() - WHALE_LOOKBACK_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const aiCacheSince = new Date(Date.now() - AI_VERDICT_TTL_MS).toISOString();

  const [whalesRes, indicatorsRes, predictionsRes, freshAiRes, lastAiRes] =
    await Promise.all([
      db
        .from("whale_alerts")
        .select("*")
        .in("symbol", symbols)
        .gte("created_at", sixHoursAgo)
        .order("usd_value", { ascending: false })
        .limit(2000),
      db
        .from("indicator_snapshots")
        .select("*")
        .in("symbol", binSymbols)
        .order("created_at", { ascending: false })
        .limit(5000),
      db
        .from("prediction_snapshots")
        .select("*")
        .in("related_symbol", symbols)
        .order("created_at", { ascending: false })
        .limit(1000),
      db
        .from("council_signals")
        .select("symbol, source_created_at")
        .eq("depth", "ai-batch")
        .in("symbol", symbols)
        .gte("source_created_at", aiCacheSince),
      db
        .from("council_signals")
        .select("source_created_at")
        .eq("depth", "ai-batch")
        .order("source_created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const whalesBySymbol = new Map<string, Record<string, unknown>[]>();
  for (const w of (whalesRes.data ?? []) as Record<string, unknown>[]) {
    const s = w["symbol"] as string;
    const bucket = whalesBySymbol.get(s);
    if (!bucket) whalesBySymbol.set(s, [w]);
    else if (bucket.length < 20) bucket.push(w);
  }

  const indicatorByTf = new Map<string, Record<string, unknown>>();
  for (const i of (indicatorsRes.data ?? []) as Record<string, unknown>[]) {
    const s = i["symbol"] as string;
    const tf = i["timeframe"] as string;
    const key = `${s}:${tf}`;
    if (!indicatorByTf.has(key)) indicatorByTf.set(key, i);
  }

  const latestPrediction = new Map<string, Record<string, unknown>>();
  for (const p of (predictionsRes.data ?? []) as Record<string, unknown>[]) {
    const s = p["related_symbol"] as string | undefined;
    if (s && !latestPrediction.has(s)) latestPrediction.set(s, p);
  }

  const freshnessNow = Date.now();
  for (const [k, row] of indicatorByTf) {
    if (!isFreshRow(row, "created_at", INDICATOR_MAX_AGE_MS, freshnessNow))
      indicatorByTf.delete(k);
  }
  for (const [s, row] of latestPrediction) {
    if (!isFreshRow(row, "created_at", PREDICTION_MAX_AGE_MS, freshnessNow))
      latestPrediction.delete(s);
  }

  const freshAiSymbols = new Set(
    ((freshAiRes.data ?? []) as { symbol: string }[]).map((r) => r.symbol),
  );
  const lastAiAt = lastAiRes.data?.source_created_at
    ? new Date(lastAiRes.data.source_created_at).getTime()
    : 0;
  const minutesSinceLastAi =
    lastAiAt > 0 ? (Date.now() - lastAiAt) / 60_000 : Infinity;
  const aiAllowed = minutesSinceLastAi >= AI_MIN_MINUTES_BETWEEN_BATCHES;

  const perSymbol = new Map<
    string,
    { whale: Row; mtf: MultiTfResult; mtfRaw: MultiTfInput; prediction: Row }
  >();
  const aiCandidates: AiCandidate[] = [];

  for (const symbol of symbols) {
    const whaleRows = whalesBySymbol.get(symbol) ?? [];
    const buyUsd = whaleRows
      .filter((r) => r["direction"] === "accumulation")
      .reduce((sum, r) => sum + Number(r["usd_value"] ?? 0), 0);
    const sellUsd = whaleRows
      .filter((r) => r["direction"] === "distribution")
      .reduce((sum, r) => sum + Number(r["usd_value"] ?? 0), 0);
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
          buy_count: whaleRows.filter(
            (r) => r["direction"] === "accumulation",
          ).length,
          sell_count: whaleRows.filter(
            (r) => r["direction"] === "distribution",
          ).length,
        } as Row)
      : null;

    const binSym = binanceSymbol(symbol);
    const mtfRaw: MultiTfInput = {
      primary: (indicatorByTf.get(
        `${binSym}:${PRIMARY_TIMEFRAME}`,
      ) ?? null) as Row,
      fast: (indicatorByTf.get(`${binSym}:${FAST_TIMEFRAME}`) ?? null) as Row,
      trend: (indicatorByTf.get(`${binSym}:${TREND_TIMEFRAME}`) ?? null) as Row,
    };
    const mtf = evaluateMultiTimeframe(mtfRaw);
    const prediction = (latestPrediction.get(symbol) ?? null) as Row;

    if (!whale && !mtfRaw.primary && !prediction) continue;
    perSymbol.set(symbol, { whale, mtf, mtfRaw, prediction });

    const rsi4hRaw = mtfRaw.primary?.["rsi"];
    if (typeof rsi4hRaw === "number") {
      (mtf as unknown as Record<string, unknown>)["rsi4h"] = rsi4hRaw;
    }

    if (!freshAiSymbols.has(symbol) && qualifiesForAi(whale, mtf, symbol)) {
      aiCandidates.push({
        symbol,
        whale,
        mtf,
        mtfRaw,
        prediction,
        whaleUsd: whaleUsdTotal,
      });
    }
  }

  let aiResults = new Map<
    string,
    { final_verdict: CouncilVerdict; conviction: number; reflection: string }
  >();
  if (aiAllowed) {
    aiCandidates.sort((a, b) => b.whaleUsd - a.whaleUsd);
    const aiBatch = aiCandidates.slice(0, AI_BATCH_MAX);
    aiResults = await groqBatchCouncil(aiBatch);
  } else {
    console.log(
      `[GROQ] Rate guard: skipping AI batch — only ${minutesSinceLastAi.toFixed(1)}min since last run (min ${AI_MIN_MINUTES_BETWEEN_BATCHES}min)`,
    );
  }

  for (const [symbol, ctx] of perSymbol) {
    if (freshAiSymbols.has(symbol)) continue;
    const aiResult = aiResults.get(symbol);
    const usedAi = !!aiResult;
    const result =
      aiResult ?? councilEvaluation(ctx.whale, ctx.mtf, ctx.prediction);
    const sourceId = [
      symbol,
      ctx.whale?.["id"],
      ctx.mtfRaw.primary?.["id"],
      ctx.prediction?.["id"],
      usedAi ? "ai" : "rule",
    ].join(":");
    rows.push({
      symbol,
      source_id: sourceId,
      final_verdict: result.final_verdict,
      conviction: result.conviction,
      price_at:
        typeof ctx.mtfRaw.primary?.["price"] === "number"
          ? ctx.mtfRaw.primary["price"]
          : null,
      reflection: result.reflection,
      depth: usedAi ? "ai-batch" : "ai-synthesis",
      source_created_at: new Date().toISOString(),
    });
  }
  if (rows.length === 0) return 0;
  const { data, error } = await db
    .from("council_signals")
    .upsert(rows as never, { onConflict: "source_id" })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Signal combiner (weight-aware) ───────────── */

const COMPOSITE_AI_BASE_WEIGHT = 0.75;

function compositeMaxScore(w: StrategyConfig): number {
  return (
    w.whale_weight * 1.0 +
    w.technicals_weight * 1.69 +
    w.prediction_weight * 0.5 +
    w.council_weight * COMPOSITE_AI_BASE_WEIGHT
  );
}

function ruleBased(
  whale: Row,
  mtf: MultiTfResult,
  prediction: Row,
  council: Row,
  weights: StrategyConfig,
  options?: { conflictFixEnabled?: boolean },
) {
  let score = 0;
  const reasons: string[] = [];
  let aiAvoid = false;

  // Hard conflict detection: whale & prediction αντίθετα, no technicals
  const predDir = predictionDirection(prediction);
  const conflict = detectHardConflict(whale, mtf.direction, predDir);

  if (whale?.["direction"] === "accumulation") {
    score += 1 * weights.whale_weight;
    reasons.push(`whale accumulation ×${weights.whale_weight.toFixed(1)}`);
  } else if (whale?.["direction"] === "distribution") {
    score -= 1 * weights.whale_weight;
    reasons.push(`whale distribution ×${weights.whale_weight.toFixed(1)}`);
  }

  if (mtf.score !== 0) {
    const weighted = mtf.score * weights.technicals_weight;
    score += weighted;
    const dir = weighted > 0 ? "bullish" : "bearish";
    reasons.push(
      `${dir} technicals (${mtf.detail}${mtf.aligned ? " · aligned" : mtf.conflict ? " · conflict" : ""}) ×${weights.technicals_weight.toFixed(1)}`,
    );
  }

  if (predDir === "bullish") {
    score += 0.5 * weights.prediction_weight;
    reasons.push(
      `prediction market bullish ×${weights.prediction_weight.toFixed(1)}`,
    );
  } else if (predDir === "bearish") {
    score -= 0.5 * weights.prediction_weight;
    reasons.push(
      `prediction market bearish ×${weights.prediction_weight.toFixed(1)}`,
    );
  }

  if (council?.["final_verdict"]) {
    const convictionRaw = Number(council["conviction"]);
    const conviction = Number.isFinite(convictionRaw)
      ? Math.max(0, Math.min(100, convictionRaw))
      : 50;
    const weight =
      (conviction / 100) * COMPOSITE_AI_BASE_WEIGHT * weights.council_weight;
    const verdict = String(council["final_verdict"]).toUpperCase();
    if (verdict === "BUY") {
      score += weight;
      reasons.push(
        `council: BUY (${Math.round(conviction)}%) ×${weights.council_weight.toFixed(1)}`,
      );
    } else if (verdict === "SELL") {
      score -= weight;
      reasons.push(
        `council: SELL (${Math.round(conviction)}%) ×${weights.council_weight.toFixed(1)}`,
      );
    } else if (verdict === "AVOID") {
      aiAvoid = conviction >= 60;
      reasons.push(`council: AVOID (${Math.round(conviction)}%)`);
    } else {
      reasons.push(`council: HOLD`);
    }
  }

  // ── Recommendation logic ──
  // Default = hold (ρητά, όχι fallthrough)
  let recommendation: "buy" | "sell" | "hold" | "watch" = "hold";

  if (conflict.hardConflict && options?.conflictFixEnabled) {
    recommendation = "hold";
    reasons.push(
      `hard conflict (whale=${conflict.whaleDir}, pred=${conflict.predDir}, no technicals) → hold`,
    );
  } else {
    if (score >= 1.5) recommendation = "buy";
    else if (score <= -1.5) recommendation = "sell";
    else if (Math.abs(score) < 0.5) recommendation = "hold";
    else recommendation = "watch";

    if (aiAvoid) recommendation = "watch";
  }

  const max = compositeMaxScore(weights);
  const confidence = max > 0 ? Math.min(1, Math.abs(score) / max) : 0;

  return {
    recommendation,
    confidence,
    score,
    reasoning: reasons.length > 0 ? reasons.join("; ") : "insufficient signal",
  };
}

function signalFingerprint(
  symbol: string,
  whale: Row,
  mtf: MultiTfResult,
  mtfRaw: MultiTfInput,
  prediction: Row,
  council: Row,
  weights: StrategyConfig,
  result: ReturnType<typeof ruleBased>,
) {
  const normalize = (value: unknown): string => {
    if (value == null) return "";
    if (typeof value === "number")
      return Number.isFinite(value) ? value.toFixed(8) : "";
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
    round2(mtfRaw.primary?.["rsi"]),
    round2(mtfRaw.fast?.["rsi"]),
    round2(mtfRaw.trend?.["rsi"]),
    normalize(mtfRaw.primary?.["signal"]),
    normalize(mtfRaw.fast?.["signal"]),
    normalize(mtfRaw.trend?.["signal"]),
    round2(mtf.score),
    normalize(prediction?.["market_slug"]),
    normalize(prediction?.["yes_price"]),
    normalize(prediction?.["no_price"]),
    normalize(council?.["final_verdict"]),
    normalize(council?.["conviction"]),
    `strat:${weights.whale_weight.toFixed(1)},${weights.technicals_weight.toFixed(1)},${weights.prediction_weight.toFixed(1)},${weights.council_weight.toFixed(1)}`,
    result.recommendation,
    result.confidence.toFixed(4),
  ].join("|");
}

export async function combineSignals(): Promise<number> {
  const db = await admin();
  const weights = await fetchStrategy();
  const cleanupCfg = await fetchCleanupConfig();
  const conflictFixEnabled = cleanupCfg.watch_conflict_fix.enabled;
  const conflictShadowMode = cleanupCfg.watch_conflict_fix.shadow_mode;

  const { data: councilRows } = await db
    .from("council_signals")
    .select("symbol");
  const symbols = [
    ...new Set([
      ...WATCHLIST,
      ...((councilRows ?? []) as { symbol: string }[]).map((r) => r.symbol),
    ]),
  ];
  if (symbols.length === 0) return 0;
  const binSymbols = symbols.map(binanceSymbol);
  const whaleSince = new Date(
    Date.now() - WHALE_LOOKBACK_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const [whalesRes, indicatorsRes, predictionsRes, councilsRes] =
    await Promise.all([
      db
        .from("whale_alerts")
        .select("*")
        .in("symbol", symbols)
        .gte("created_at", whaleSince)
        .order("created_at", { ascending: false })
        .limit(3000),
      db
        .from("indicator_snapshots")
        .select("*")
        .in("symbol", binSymbols)
        .order("created_at", { ascending: false })
        .limit(5000),
      db
        .from("prediction_snapshots")
        .select("*")
        .in("related_symbol", symbols)
        .order("created_at", { ascending: false })
        .limit(1000),
      db
        .from("council_signals")
        .select("*")
        .in("symbol", symbols)
        .order("source_created_at", { ascending: false })
        .limit(1000),
    ]);

  const whaleBySymbol = new Map<string, Record<string, unknown>[]>();
  for (const w of (whalesRes.data ?? []) as Record<string, unknown>[]) {
    const s = w["symbol"] as string;
    const bucket = whaleBySymbol.get(s);
    if (!bucket) whaleBySymbol.set(s, [w]);
    else if (bucket.length < 20) bucket.push(w);
  }

  const indicatorByTf = new Map<string, Record<string, unknown>>();
  for (const i of (indicatorsRes.data ?? []) as Record<string, unknown>[]) {
    const s = i["symbol"] as string;
    const tf = i["timeframe"] as string;
    const key = `${s}:${tf}`;
    if (!indicatorByTf.has(key)) indicatorByTf.set(key, i);
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
  for (const [k, row] of indicatorByTf) {
    if (!isFreshRow(row, "created_at", INDICATOR_MAX_AGE_MS, freshnessNow))
      indicatorByTf.delete(k);
  }
  for (const [s, row] of latestPrediction) {
    if (!isFreshRow(row, "created_at", PREDICTION_MAX_AGE_MS, freshnessNow))
      latestPrediction.delete(s);
  }
  for (const [s, row] of latestCouncil) {
    if (!isFreshRow(row, "source_created_at", COUNCIL_MAX_AGE_MS, freshnessNow))
      latestCouncil.delete(s);
  }

  let created = 0;
  const nowIso = new Date().toISOString();

  // Shadow variant buffer (observability only)
  const variantRows: Record<string, unknown>[] = [];

  for (const symbol of symbols) {
    const whaleRows = whaleBySymbol.get(symbol) ?? [];
    let whale: Row = null;
    if (whaleRows.length > 0) {
      const buyUsd = whaleRows
        .filter((r) => r["direction"] === "accumulation")
        .reduce((sum, r) => sum + Number(r["usd_value"] ?? 0), 0);
      const sellUsd = whaleRows
        .filter((r) => r["direction"] === "distribution")
        .reduce((sum, r) => sum + Number(r["usd_value"] ?? 0), 0);
      const whaleUsdTotal = buyUsd + sellUsd;
      let direction: "accumulation" | "distribution" | undefined;
      if (buyUsd > sellUsd * 1.15) direction = "accumulation";
      else if (sellUsd > buyUsd * 1.15) direction = "distribution";
      whale = {
        id: whaleRows[0]?.["id"] ?? null,
        direction,
        usd_value: whaleUsdTotal,
        buy_usd: buyUsd,
        sell_usd: sellUsd,
        buy_count: whaleRows.filter(
          (r) => r["direction"] === "accumulation",
        ).length,
        sell_count: whaleRows.filter(
          (r) => r["direction"] === "distribution",
        ).length,
      };
    }

    const binSym = binanceSymbol(symbol);
    const mtfRaw: MultiTfInput = {
      primary: (indicatorByTf.get(
        `${binSym}:${PRIMARY_TIMEFRAME}`,
      ) ?? null) as Row,
      fast: (indicatorByTf.get(`${binSym}:${FAST_TIMEFRAME}`) ?? null) as Row,
      trend: (indicatorByTf.get(`${binSym}:${TREND_TIMEFRAME}`) ?? null) as Row,
    };
    const mtf = evaluateMultiTimeframe(mtfRaw);
    const prediction = (latestPrediction.get(symbol) ?? null) as Row;
    const council = (latestCouncil.get(symbol) ?? null) as Row;
    if (!whale && !mtfRaw.primary && !prediction && !council) continue;

    const result = ruleBased(whale, mtf, prediction, council, weights, {
      conflictFixEnabled,
    });

    // Shadow mode: log τι θα γινόταν με το fix ενεργό
    if (conflictShadowMode && !conflictFixEnabled) {
      const shadow = ruleBased(whale, mtf, prediction, council, weights, {
        conflictFixEnabled: true,
      });
      if (shadow.recommendation !== result.recommendation) {
        console.log(
          `[WATCH_CONFLICT_SHADOW] ${symbol}: would be ${shadow.recommendation} (currently ${result.recommendation})`,
        );
      }
    }

    // ── Shadow evaluation across all presets (buy/sell only) ──
    const mtfPrice =
      typeof mtfRaw.primary?.["price"] === "number"
        ? (mtfRaw.primary["price"] as number)
        : null;
    for (const [presetName, presetWeights] of Object.entries(
      STRATEGY_PRESETS,
    )) {
      const altResult = ruleBased(whale, mtf, prediction, council, {
        ...presetWeights,
        updated_at: nowIso,
      });
      if (
        altResult.recommendation !== "buy" &&
        altResult.recommendation !== "sell"
      )
        continue;
      if (mtfPrice == null || mtfPrice <= 0) continue;
      variantRows.push({
        strategy_name: presetName,
        symbol,
        confidence: altResult.confidence,
        recommendation: altResult.recommendation,
        reasoning: altResult.reasoning,
        score: altResult.score,
        entry_price: mtfPrice,
        outcome: "open",
        created_at: nowIso,
      });
    }

    if (result.recommendation === "hold") continue;

    if (result.recommendation === "watch") {
      const hasWhale = whale?.["direction"] != null;
      const hasTechnical = mtf.direction !== "neutral";
      const hasPrediction = predictionDirection(prediction) !== "neutral";
      const councilVerdict = String(
        council?.["final_verdict"] ?? "",
      ).toUpperCase();
      const councilConviction = Number(council?.["conviction"] ?? 0);
      const strongAvoid =
        councilVerdict === "AVOID" && councilConviction >= 60;
      const signalCount = [hasWhale, hasTechnical, hasPrediction].filter(
        Boolean,
      ).length;
      if (signalCount < 2 && !strongAvoid) continue;
    }

    const fingerprint = signalFingerprint(
      symbol,
      whale,
      mtf,
      mtfRaw,
      prediction,
      council,
      weights,
      result,
    );
    const { data, error } = await db
      .from("composite_signals")
      .upsert(
        {
          symbol,
          whale_alert_id: (whaleRows[0]?.["id"] as string) ?? null,
          indicator_snapshot_id: (mtfRaw.primary?.["id"] as string) ?? null,
          prediction_snapshot_id: (prediction?.["id"] as string) ?? null,
          council_signal_id: (council?.["id"] as string) ?? null,
          confidence: result.confidence,
          recommendation: result.recommendation,
          reasoning: result.reasoning,
          fingerprint,
          created_at: nowIso,
        } as never,
        { onConflict: "fingerprint", ignoreDuplicates: false },
      )
      .select("id");
    if (error) throw error;
    if (data?.length) created += 1;
  }

  // ── Batch insert shadow variant signals (non-fatal) ──
  if (variantRows.length > 0) {
    const { error: variantErr } = await db
      .from("strategy_variant_signals")
      .insert(variantRows as never);
    if (variantErr) {
      console.error("[VARIANTS] insert failed:", variantErr);
    } else {
      console.log(
        `[VARIANTS] Recorded ${variantRows.length} shadow signals across ${Object.keys(STRATEGY_PRESETS).length} presets`,
      );
    }
  }

  return created;
}

/* ───────────── Resolve variant signal outcomes (4h candle-based) ───────────── */

interface VariantCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  closeTimeMs: number;
}

async function fetch4hCandles(
  coin: string,
  limit = 50,
): Promise<VariantCandle[]> {
  const symbol = binanceSymbol(coin);

  try {
    const res = await fetchWithTimeout(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=4h&limit=${limit}`,
    );

    if (!res.ok) {
      console.error(`[VARIANTS] klines HTTP ${res.status} for ${symbol}`);
      return [];
    }

    const raw = (await res.json()) as unknown[][];

    if (!Array.isArray(raw)) return [];

    return raw
      .map((r) => ({
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        closeTimeMs: Number(r[6]),
      }))
      .filter(
        (c) =>
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          Number.isFinite(c.closeTimeMs),
      );
  } catch (e) {
    console.error(`[VARIANTS] klines fetch failed for ${symbol}:`, e);
    return [];
  }
}

async function resolveVariantOutcomes(): Promise<number> {
  const db = await admin();

  /*
   * IMPORTANT:
   * Do not filter open variants by created_at here.
   *
   * Older open variants must remain eligible so they can be resolved
   * as expired after the 168h maximum lifetime.
   */
  const { data: openVariants, error } = await db
    .from("strategy_variant_signals")
    .select("id, symbol, recommendation, entry_price, created_at")
    .eq("outcome", "open")
    .not("entry_price", "is", null)
    .in("recommendation", ["buy", "sell"])
    .order("created_at", { ascending: true })
    .limit(VARIANT_RESOLVE_BATCH);

  if (error) {
    console.error("[VARIANTS] resolve fetch failed:", error);
    return 0;
  }

  if (!openVariants || openVariants.length === 0) {
    return 0;
  }

  const bySymbol = new Map<
    string,
    {
      id: string;
      recommendation: "buy" | "sell";
      entry_price: number;
      created_at: string;
    }[]
  >();

  for (const raw of openVariants as {
    id: string;
    symbol: string;
    recommendation: string | null;
    entry_price: number | null;
    created_at: string;
  }[]) {
    const entry = Number(raw.entry_price);
    const rec = String(raw.recommendation ?? "").toLowerCase();

    if (!Number.isFinite(entry) || entry <= 0) continue;
    if (rec !== "buy" && rec !== "sell") continue;

    const list = bySymbol.get(raw.symbol) ?? [];

    list.push({
      id: raw.id,
      recommendation: rec,
      entry_price: entry,
      created_at: raw.created_at,
    });

    bySymbol.set(raw.symbol, list);
  }

  /*
   * Fetch one 4h candle series per symbol, concurrently but bounded.
   *
   * The old implementation fetched symbols serially, which could make
   * this resolver take many minutes with a ~100-symbol watchlist.
   */
  const symbolResults = await pMap(
    [...bySymbol.entries()],
    async ([symbol, variants]) => ({
      symbol,
      variants,
      candles: await fetch4hCandles(symbol, 50),
    }),
    10,
  );

  const nowMs = Date.now();
  let resolved = 0;

  for (const result of symbolResults) {
    if (!result || result.candles.length === 0) continue;

    const { variants, candles } = result;

    for (const variant of variants) {
      const entry = variant.entry_price;
      const rec = variant.recommendation;
      const entryMs = new Date(variant.created_at).getTime();

      if (!Number.isFinite(entryMs)) continue;

      const tpPrice =
        rec === "buy"
          ? entry * (1 + VARIANT_TP_PCT)
          : entry * (1 - VARIANT_TP_PCT);

      const slPrice =
        rec === "buy"
          ? entry * (1 - VARIANT_SL_PCT)
          : entry * (1 + VARIANT_SL_PCT);

      /*
       * Use only fully closed 4h candles whose close happened after
       * the signal creation time.
       */
      const relevantCandles = candles.filter(
        (c) => c.closeTimeMs > entryMs && c.closeTimeMs <= nowMs,
      );

      let outcome: "win" | "loss" | "expired" | null = null;
      let exitPrice: number | null = null;

      /*
       * If TP and SL are both touched inside the same 4h candle,
       * resolve as SL first because intrabar ordering is unknown.
       */
      for (const candle of relevantCandles) {
        const hitTP =
          rec === "buy" ? candle.high >= tpPrice : candle.low <= tpPrice;

        const hitSL =
          rec === "buy" ? candle.low <= slPrice : candle.high >= slPrice;

        if (hitSL) {
          outcome = "loss";
          exitPrice = slPrice;
          break;
        }

        if (hitTP) {
          outcome = "win";
          exitPrice = tpPrice;
          break;
        }
      }

      /*
       * Expiry is evaluated only after TP/SL.
       * At 168h, resolve using the latest fully closed 4h candle
       * available to the resolver.
       */
      if (!outcome) {
        const ageHours = (nowMs - entryMs) / 3_600_000;

        if (ageHours >= VARIANT_MAX_HOURS) {
          const expiryCandle =
            relevantCandles[relevantCandles.length - 1];

          if (expiryCandle) {
            outcome = "expired";
            exitPrice = expiryCandle.close;
          }
        }
      }

      if (!outcome || exitPrice == null) continue;

      const rawPnlPct = ((exitPrice - entry) / entry) * 100;
      const pnlPct = rec === "buy" ? rawPnlPct : -rawPnlPct;

      /*
       * Atomic/idempotent update:
       * only an untouched "open" row is allowed to transition.
       *
       * Selecting the updated id prevents counting a concurrent resolver
       * as successfully resolved when the row was already closed.
       */
      const { data: updatedRows, error: updateErr } = await db
        .from("strategy_variant_signals")
        .update({
          outcome,
          exit_price: exitPrice,
          pnl_pct: pnlPct,
          resolved_at: new Date().toISOString(),
        })
        .eq("id", variant.id)
        .eq("outcome", "open")
        .select("id");

      if (updateErr) {
        console.error(
          `[VARIANTS] update failed for ${variant.id}:`,
          updateErr,
        );
        continue;
      }

      if (updatedRows && updatedRows.length > 0) {
        resolved += 1;
      }
    }
  }

  if (resolved > 0) {
    console.log(
      `[VARIANTS] Resolved ${resolved} outcomes (4h candle-based)`,
    );
  }

  return resolved;
}

/* ───────────── Trade executor ───────────── */

export function tradingMode(): "paper" | "live" {
  const mode = process.env["TRADING_MODE"];
  const liveEnabled = process.env["ENABLE_LIVE_TRADING"] === "true";
  const hasKeys =
    !!process.env["BINANCE_API_KEY"] && !!process.env["BINANCE_API_SECRET"];
  return mode === "live" && liveEnabled && hasKeys ? "live" : "paper";
}

async function allBinancePrices(): Promise<Map<string, number>> {
  const res = await fetchWithTimeout(
    "https://api.binance.com/api/v3/ticker/price",
  );
  if (!res.ok) throw new Error(`batch price fetch failed HTTP ${res.status}`);
  const data = (await res.json()) as { symbol: string; price: string }[];
  const map = new Map<string, number>();
  for (const d of data) {
    const p = Number(d.price);
    if (Number.isFinite(p)) map.set(d.symbol, p);
  }
  return map;
}

async function placeLiveOrder(
  coin: string,
  side: "buy" | "sell",
  quantity: number,
) {
  const apiKey = process.env["BINANCE_API_KEY"];
  const apiSecret = process.env["BINANCE_API_SECRET"];
  if (!apiKey || !apiSecret)
    throw new Error("Binance API credentials are not configured");
  const symbol = binanceSymbol(coin);
  const params = new URLSearchParams({
    symbol,
    side: side.toUpperCase(),
    type: "MARKET",
    quantity: quantity.toFixed(6),
    timestamp: String(Date.now()),
    recvWindow: "5000",
  });
  const signature = createHmac("sha256", apiSecret)
    .update(params.toString())
    .digest("hex");
  const res = await fetch(
    `https://api.binance.com/api/v3/order?${params.toString()}&signature=${signature}`,
    {
      method: "POST",
      headers: { "X-MBX-APIKEY": apiKey },
    },
  );
  const body = (await res.json()) as { orderId?: number; msg?: string };
  if (!res.ok)
    throw new Error(`Binance order rejected: ${body.msg ?? res.status}`);
  return String(body.orderId ?? "");
}

async function closeTriggeredTrades(): Promise<number> {
  const db = await admin();
  const { data: openTrades, error } = await db
    .from("trades")
    .select(
      "id, symbol, side, quantity, entry_price, stop_loss, take_profit, mode, created_at",
    )
    .eq("status", "open");
  if (error) throw error;
  const trades = (openTrades ?? []) as {
    id: string;
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    entry_price: number;
    stop_loss: number | null;
    take_profit: number | null;
    mode: "paper" | "live";
    created_at: string;
  }[];
  if (trades.length === 0) return 0;
  let prices: Map<string, number>;
  try {
    prices = await allBinancePrices();
  } catch (e) {
    console.error("batch price fetch failed, skipping close checks", e);
    return 0;
  }
  let closed = 0;
  const nowMs = Date.now();
  for (const trade of trades) {
    const binSym = binanceSymbol(trade.symbol);
    const price = prices.get(binSym);
    if (price == null) {
      console.error(`no price for ${trade.symbol} (${binSym})`);
      continue;
    }
    const entryPrice = Number(trade.entry_price);

    const hitStopLoss =
      trade.stop_loss != null &&
      (trade.side === "buy"
        ? price <= trade.stop_loss
        : price >= trade.stop_loss);
    const hitTakeProfit =
      trade.take_profit != null &&
      (trade.side === "buy"
        ? price >= trade.take_profit
        : price <= trade.take_profit);

    const ageMs = nowMs - new Date(trade.created_at).getTime();
    const ageHours = ageMs / 3_600_000;
    const pnlPctNow =
      entryPrice > 0
        ? ((trade.side === "buy" ? price - entryPrice : entryPrice - price) /
            entryPrice) *
          100
        : 0;
    const stale =
      ageHours >= STALE_EXIT_HOURS &&
      Math.abs(pnlPctNow) < STALE_EXIT_MIN_PNL_PCT;
    const expired = ageHours >= MAX_HOLD_HOURS;

    if (!hitStopLoss && !hitTakeProfit && !stale && !expired) continue;

    if (trade.mode === "live") {
      const opposite: "buy" | "sell" = trade.side === "buy" ? "sell" : "buy";
      try {
        await placeLiveOrder(trade.symbol, opposite, Number(trade.quantity));
      } catch (e) {
        console.error(
          `[LIVE] failed to close ${trade.symbol} ${opposite}:`,
          e,
        );
        continue;
      }
    }

    const closeReason = hitStopLoss
      ? "stop_loss"
      : hitTakeProfit
        ? "take_profit"
        : expired
          ? "expired"
          : "stale_exit";

    const closedAt = new Date().toISOString();
    const fee = computeFeeAwarePnl(
      trade.side,
      entryPrice,
      price,
      Number(trade.quantity),
    );
    const { data: closedTrade, error: closeError } = await db
      .from("trades")
      .update({
        status: "closed",
        pnl: fee.netPnl,
        gross_pnl: fee.grossPnl,
        net_pnl: fee.netPnl,
        entry_fee: fee.entryFee,
        exit_fee: fee.exitFee,
        total_fees: fee.totalFees,
        exit_price: price,
        close_reason: closeReason,
        closed_at: closedAt,
      })
      .eq("id", trade.id)
      .eq("status", "open")
      .select("id")
      .maybeSingle();
    if (closeError) throw closeError;
    if (!closedTrade) continue;
    const { error: alertError } = await db.from("trade_alerts").insert({
      trade_id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      event_type: closeReason,
      entry_price: entryPrice,
      exit_price: price,
      pnl: fee.netPnl,
      pnl_pct: fee.netPnlPct,
      created_at: closedAt,
    } as never);
    if (alertError) throw alertError;
    closed += 1;
  }
  return closed;
}

interface OpenTradeForRotation {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  entry_price: number;
  mode: "paper" | "live";
  composite_signal_id: string | null;
  created_at: string;
}

async function attemptRotation(
  db: Admin,
  newSignal: { symbol: string; confidence: number },
  prices: Map<string, number>,
  openTrades: OpenTradeForRotation[],
  openConfidenceMap: Map<string, number>,
): Promise<string | null> {
  const nowMs = Date.now();

  const scored = openTrades.map((t) => {
    const price = prices.get(binanceSymbol(t.symbol));
    const entry = Number(t.entry_price);
    const qty = Number(t.quantity);
    const pnlPct =
      price != null && entry > 0 && qty > 0
        ? ((t.side === "buy" ? price - entry : entry - price) / entry) * 100
        : 0;
    const ageMin = (nowMs - new Date(t.created_at).getTime()) / 60_000;
    const originalConfidence = t.composite_signal_id
      ? (openConfidenceMap.get(t.composite_signal_id) ?? 0)
      : 0;
    return {
      ...t,
      pnlPct,
      ageMin,
      originalConfidence,
      currentPrice: price ?? null,
    };
  });

  const eligible = scored.filter(
    (t) =>
      t.ageMin >= ROTATION_MIN_OPEN_AGE_MINUTES &&
      t.pnlPct <= ROTATION_MAX_WEAKEST_PNL_PCT &&
      t.currentPrice != null,
  );

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    if (a.pnlPct !== b.pnlPct) return a.pnlPct - b.pnlPct;
    return a.originalConfidence - b.originalConfidence;
  });

  const weakest = eligible[0]!;
  const improvement = newSignal.confidence - weakest.originalConfidence;

  if (improvement < ROTATION_CONFIDENCE_IMPROVEMENT) return null;

  const price = weakest.currentPrice!;
  const entryPrice = Number(weakest.entry_price);
  const fee = computeFeeAwarePnl(
    weakest.side,
    entryPrice,
    price,
    Number(weakest.quantity),
  );
  const closedAt = new Date().toISOString();

  const { error: closeErr } = await db
    .from("trades")
    .update({
      status: "closed",
      pnl: fee.netPnl,
      gross_pnl: fee.grossPnl,
      net_pnl: fee.netPnl,
      entry_fee: fee.entryFee,
      exit_fee: fee.exitFee,
      total_fees: fee.totalFees,
      exit_price: price,
      close_reason: "rotated_out",
      closed_at: closedAt,
    })
    .eq("id", weakest.id)
    .eq("status", "open");

  if (closeErr) return null;

  await db.from("trade_alerts").insert({
    trade_id: weakest.id,
    symbol: weakest.symbol,
    side: weakest.side,
    event_type: "rotated_out",
    entry_price: entryPrice,
    exit_price: price,
    pnl: fee.netPnl,
    pnl_pct: fee.netPnlPct,
    created_at: closedAt,
  } as never);

  console.log(
    `[ROTATION] closed ${weakest.symbol} (PnL ${weakest.pnlPct.toFixed(2)}%, orig ${(weakest.originalConfidence * 100).toFixed(0)}%) → room for ${newSignal.symbol}`,
  );
  return weakest.symbol;
}

export async function executeTrades(): Promise<number> {
  const db = await admin();
  const mode = tradingMode();
  await closeTriggeredTrades();
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const cooldownSince = new Date(
    Date.now() - SYMBOL_COOLDOWN_MINUTES * 60 * 1000,
  ).toISOString();

  const [signalsRes, openTradesRes, recentlyClosedRes] = await Promise.all([
    db
      .from("composite_signals")
      .select("*")
      .gte("created_at", since)
      .gte("confidence", MIN_CONFIDENCE)
      .in("recommendation", ["buy", "sell"])
      .order("confidence", { ascending: false }),
    db
      .from("trades")
      .select(
        "id, symbol, side, quantity, entry_price, mode, composite_signal_id, created_at",
      )
      .eq("status", "open"),
    db
      .from("trades")
      .select("symbol")
      .eq("status", "closed")
      .gte("closed_at", cooldownSince),
  ]);
  if (signalsRes.error) throw signalsRes.error;
  if (openTradesRes.error) throw openTradesRes.error;
  if (recentlyClosedRes.error) throw recentlyClosedRes.error;

  const openTrades = (openTradesRes.data ?? []) as OpenTradeForRotation[];
  const openSymbols = new Set(openTrades.map((t) => t.symbol));
  const cooldownSymbols = new Set(
    ((recentlyClosedRes.data ?? []) as { symbol: string }[]).map(
      (t) => t.symbol,
    ),
  );

  const openSignalIds = openTrades
    .map((t) => t.composite_signal_id)
    .filter((id): id is string => id != null);
  const openConfidenceMap = new Map<string, number>();
  if (openSignalIds.length > 0) {
    const { data: openSignals } = await db
      .from("composite_signals")
      .select("id, confidence")
      .in("id", openSignalIds);
    for (const s of (openSignals ?? []) as {
      id: string;
      confidence: number;
    }[]) {
      openConfidenceMap.set(s.id, Number(s.confidence));
    }
  }

  let prices: Map<string, number>;
  try {
    prices = await allBinancePrices();
  } catch (e) {
    console.error("batch price fetch failed in executeTrades", e);
    return 0;
  }

  let opened = 0;
  let rotationAttempted = false;

  for (const signal of (signalsRes.data ?? []) as {
    id: string;
    symbol: string;
    recommendation: string;
    confidence: number;
    price_at?: number | null;
    created_at?: string | null;
  }[]) {
    if (openSymbols.has(signal.symbol)) continue;
    if (cooldownSymbols.has(signal.symbol)) continue;

    const { data: existing } = await db
      .from("trades")
      .select("id")
      .eq("composite_signal_id", signal.id)
      .limit(1);
    if (existing && existing.length > 0) continue;

    const price = prices.get(binanceSymbol(signal.symbol));
    if (price == null) {
      console.error(`no price for ${signal.symbol}`);
      continue;
    }

    const signalPrice = Number(signal.price_at);
    if (
      Number.isFinite(signalPrice) &&
      signalPrice > 0 &&
      Math.abs(price - signalPrice) / signalPrice > MAX_ENTRY_DRIFT_PCT
    )
      continue;

    const side = signal.recommendation as "buy" | "sell";
    const stopLoss =
      side === "buy"
        ? price * (1 - STOP_LOSS_PCT)
        : price * (1 + STOP_LOSS_PCT);
    const takeProfit =
      side === "buy"
        ? price * (1 + TAKE_PROFIT_PCT)
        : price * (1 - TAKE_PROFIT_PCT);

    if (signal.created_at && !isFresh(signal.created_at, 15 * 60 * 1000))
      continue;

    let risk = await canOpenTrade(db as any, {
      symbol: signal.symbol,
      side,
      entryPrice: price,
      stopLoss,
      currentPrices: prices,
    });

    if (
      !risk.allowed &&
      (risk.reason === "max_positions" ||
        risk.reason === "portfolio_risk_limit") &&
      !rotationAttempted &&
      signal.confidence >= ROTATION_MIN_NEW_CONFIDENCE
    ) {
      rotationAttempted = true;
      const rotatedSymbol = await attemptRotation(
        db,
        { symbol: signal.symbol, confidence: signal.confidence },
        prices,
        openTrades,
        openConfidenceMap,
      );

      if (rotatedSymbol) {
        openSymbols.delete(rotatedSymbol);
        cooldownSymbols.add(rotatedSymbol);
        risk = await canOpenTrade(db as any, {
          symbol: signal.symbol,
          side,
          entryPrice: price,
          stopLoss,
          currentPrices: prices,
        });
      }
    }

    if (!risk.allowed) {
      console.log(`[RISK_REJECTED] ${signal.symbol} ${side}: ${risk.reason}`);
      continue;
    }
    if (!Number.isFinite(risk.quantity) || risk.quantity <= 0) continue;
    console.log(
      `[RISK_APPROVED] ${signal.symbol} ${side} | qty=${risk.quantity.toFixed(6)}`,
    );
    const quantity = risk.quantity;
    let exchangeOrderId: string | null = null;
    if (mode === "live") {
      try {
        exchangeOrderId = await placeLiveOrder(signal.symbol, side, quantity);
      } catch (e) {
        console.error("live order failed", e);
        continue;
      }
    }
    const entryFee = price * quantity * TRADING_FEE_RATE;
    const { error: tradeErr } = await db.from("trades").insert({
      composite_signal_id: signal.id,
      symbol: signal.symbol,
      side,
      quantity,
      entry_price: price,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      mode,
      status: "open",
      exchange_order_id: exchangeOrderId,
      entry_fee: entryFee,
    } as never);
    if (tradeErr) {
      if ((tradeErr as { code?: string }).code === "23505") continue;
      throw tradeErr;
    }
    openSymbols.add(signal.symbol);
    opened += 1;
  }
  return opened;
}

/* ───────────── Full pipeline ───────────── */

export async function runFullPipeline() {
  const db = await admin();
  const startedAt = new Date();
  const { data: runRow, error: insertError } = await db
    .from("pipeline_runs")
    .insert({
      job_name: "runFullPipeline",
      started_at: startedAt.toISOString(),
      status: "running",
    } as never)
    .select("id")
    .single();

  if (insertError) {
    const code = (insertError as { code?: string }).code;
    if (code === "23505") {
      console.log("[PIPELINE_LOCK] another run is already active");
      return { skipped: true, reason: "pipeline_locked" };
    }
    throw new Error(`pipeline start/lock failed: ${insertError.message}`);
  }
  const runId = (runRow as { id: string }).id;

  let step = "init";
  try {
    step = "whales";
    const [hlWhales, exWhales] = await Promise.all([
      collectWhaleAlerts(),
      collectExchangeWhaleAlerts(),
    ]);
    const whales = hlWhales + exWhales;

    step = "indicators";
    const indicators = await collectIndicators();

    step = "predictions";
    const predictions = await collectPredictions();

    step = "council";
    const council = await collectCouncilSignals();

    step = "auto-strategy";
    try {
      const autoSwitch = await maybeAutoSwitchStrategy();
      if (autoSwitch.switched) {
        console.log(
          `[AUTO_SWITCH] Applied ${autoSwitch.preset}: ${autoSwitch.reasoning}`,
        );
        invalidateStrategyCache();
      } else {
        console.log(`[AUTO_SWITCH] Skipped: ${autoSwitch.reason}`);
      }
    } catch (e) {
      console.error("[AUTO_SWITCH] non-fatal error:", e);
    }

    step = "signals";
    const signals = await combineSignals();

    step = "resolve-variants";
    const resolvedVariants = await resolveVariantOutcomes();
    if (resolvedVariants > 0) {
      console.log(`[VARIANTS] Resolved ${resolvedVariants} variant outcomes`);
    }

    step = "trades";
    const trades = await executeTrades();
    const mode = tradingMode();

    step = "post-mortem";
    const learning = await generatePostMortems();
    if (learning.generated > 0) {
      console.log(`[LESSON] Generated ${learning.generated} new lessons`);
    }
    if (learning.status !== "ok") {
      console.warn(
        `[LESSON] AI status: ${learning.status} — ${learning.error ?? "unknown"}`,
      );
    }

    const completedAt = new Date();
    const summary = {
      completed_at: completedAt.toISOString(),
      duration_ms: completedAt.getTime() - startedAt.getTime(),
      status: "success",
      whales,
      indicators,
      predictions,
      council,
      signals,
      trades,
      variants_resolved: resolvedVariants,
      mode,
      error_message: null,
      ai_status: learning.status,
      ai_error: learning.error,
      ai_lessons_generated: learning.generated,
    };
    if (runId) {
      const { error: updateError } = await db
        .from("pipeline_runs")
        .update(summary as never)
        .eq("id", runId);
      if (updateError)
        console.error("failed to update pipeline run", updateError);
    }
    return { whales, indicators, predictions, council, signals, trades, mode };
  } catch (e) {
    const raw = serializeError(e);
    const message = `[step: ${step}] ${raw}`;
    const completedAt = new Date();
    console.error(`[PIPELINE_FAILED] ${message}`);
    if (runId) {
      const { error: updateError } = await db
        .from("pipeline_runs")
        .update({
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
          status: "error",
          error_message: message,
        } as never)
        .eq("id", runId);
      if (updateError)
        console.error("failed to record pipeline error", updateError);
    }
    throw new Error(message);
  }
}

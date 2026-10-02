import { createHmac } from "crypto";
import { canOpenTrade } from "./risk.engine";
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
import {
  checkMtfGate,
  type MtfCounts,
  type MtfGateConfig,
} from "./mtf-gate";
import {
  computeRegimeSnapshot,
  type RegimeSnapshot,
} from "./regime-snapshot";
import {
  fetchCoinLobsterWhales,
  normalizeCoinLobsterTrade,
  type CoinLobsterTrade,
} from "./coinlobster.server";
import { fetchTradingSettings } from "./trading-settings.server";
import {
  classifyMarketSession,
  getSessionBonus,
  sessionLabel,
  type MarketSession,
  type MarketSessionConfig,
} from "./market-session";

/* ───────────── Shared types ───────────── */

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
const FETCH_TIMEOUT_MS = 12_000;
const MAX_ENTRY_DRIFT_PCT = 0.02;
const SYMBOL_COOLDOWN_MINUTES = 15;
const WHALE_LOOKBACK_HOURS = 6;

// Trading settings (TP/SL/hold durations) are loaded dynamically from
// pipeline_settings via fetchTradingSettings() — see executeTrades(),
// closeTriggeredTrades(), and resolveVariantOutcomes().

const ROTATION_MIN_NEW_CONFIDENCE = 0.75;
const ROTATION_CONFIDENCE_IMPROVEMENT = 0.10;
const ROTATION_MIN_OPEN_AGE_MINUTES = 30;
const ROTATION_MAX_WEAKEST_PNL_PCT = 0.5;

const INDICATOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PREDICTION_MAX_AGE_MS = 30 * 60 * 1000;

// ─── Council freshness TTL (default; regime-aware override below) ───
const COUNCIL_MAX_AGE_MS = 30 * 60 * 1000;
const COUNCIL_MAX_AGE_MS_TRENDING = 20 * 60 * 1000;
const COUNCIL_MAX_AGE_MS_CALM = 45 * 60 * 1000;

const STRATEGY_CACHE_TTL_MS = 60_000;

const VARIANT_RESOLVE_BATCH = 500;

// Variant resolution uses 1h candles for higher temporal precision on TP/SL
// hit ordering (a 4h candle can contain both TP and SL touches, and the
// resolution logic would falsely record a loss if SL were checked first).
// 100 × 1h = ~4.16 days, comfortably covering the 72h variant expiry window.
const VARIANT_RESOLVE_TIMEFRAME = "1h";
const VARIANT_RESOLVE_CANDLE_LIMIT = 100;

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

/* ───────────── Multi-exchange market data (candles) ───────────── */

const BINANCE_MARKET_HOSTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
] as const;

const BYBIT_HOST = "https://api.bybit.com";

let preferredMarketHost: (typeof BINANCE_MARKET_HOSTS)[number] | null = null;

function toBybitInterval(timeframe: string): string | null {
  switch (timeframe) {
    case "1m": return "1";
    case "5m": return "5";
    case "15m": return "15";
    case "30m": return "30";
    case "1h": return "60";
    case "4h": return "240";
    case "1d": return "D";
    case "1w": return "W";
    default: return null;
  }
}

async function binancePublicGet(pathAndQuery: string): Promise<Response> {
  const hosts = preferredMarketHost
    ? [preferredMarketHost, ...BINANCE_MARKET_HOSTS.filter((host) => host !== preferredMarketHost)]
    : [...BINANCE_MARKET_HOSTS];

  let lastResponse: Response | null = null;
  const attempts: string[] = [];

  for (const host of hosts) {
    const t0 = Date.now();
    try {
      const response = await fetchWithTimeout(`${host}${pathAndQuery}`);
      const ms = Date.now() - t0;
      attempts.push(`${host}→${response.status}(${ms}ms)`);

      if (response.ok) {
        if (preferredMarketHost !== host) {
          console.log(`[BINANCE_GET] preferred host set to ${host}`);
        }
        preferredMarketHost = host;
        return response;
      }

      if (![403, 418, 429, 451].includes(response.status) && response.status < 500) {
        return response;
      }

      console.warn(`[BINANCE_GET] ${host} returned ${response.status}, trying next host`);
      lastResponse = response;
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      attempts.push(`${host}→THREW(${ms}ms:${msg.slice(0, 60)})`);
      console.error(`[BINANCE_GET] ${host} threw after ${ms}ms: ${msg}`);
    }
  }

  const summary = attempts.join(" | ");
  console.error(`[BINANCE_GET] ALL HOSTS FAILED for ${pathAndQuery} — ${summary}`);

  return (
    lastResponse ??
    new Response(
      JSON.stringify({ error: "all hosts failed", attempts }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )
  );
}

interface BybitKlineResult {
  retCode: number;
  retMsg: string;
  result?: {
    category: string;
    symbol: string;
    list: string[][];
  };
}

async function bybitPublicGet(
  symbol: string,
  interval: string,
  limit: number,
): Promise<unknown[][] | null> {
  const url = new URL(`${BYBIT_HOST}/v5/market/kline`);
  url.searchParams.set("category", "spot");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(Math.min(limit, 1000)));

  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url.toString());
    const ms = Date.now() - t0;

    if (!res.ok) {
      console.warn(`[BYBIT_GET] ${symbol} ${interval} → HTTP ${res.status} (${ms}ms)`);
      return null;
    }

    const json = (await res.json()) as BybitKlineResult;

    if (json.retCode !== 0) {
      console.warn(`[BYBIT_GET] ${symbol} ${interval} → retCode=${json.retCode} msg=${json.retMsg}`);
      return null;
    }

    const list = json.result?.list;
    if (!Array.isArray(list) || list.length === 0) {
      console.warn(`[BYBIT_GET] ${symbol} ${interval} → empty list`);
      return null;
    }

    console.log(`[BYBIT_GET] ${symbol} ${interval} → ${list.length} candles (${ms}ms)`);

    const chronological = [...list].reverse();
    const intervalMs = parseBybitIntervalMs(interval);

    return chronological.map((k) => {
      const startMs = Number(k[0]);
      return [
        k[0], k[1], k[2], k[3], k[4], k[5],
        String(startMs + intervalMs),
      ];
    });
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[BYBIT_GET] ${symbol} ${interval} threw after ${ms}ms: ${msg}`);
    return null;
  }
}

function parseBybitIntervalMs(interval: string): number {
  if (interval === "D") return 24 * 60 * 60 * 1000;
  if (interval === "W") return 7 * 24 * 60 * 60 * 1000;
  if (interval === "M") return 30 * 24 * 60 * 60 * 1000;
  const minutes = parseInt(interval, 10);
  return Number.isFinite(minutes) ? minutes * 60 * 1000 : 60 * 60 * 1000;
}

type CandleSource = "binance" | "bybit";

async function fetchCandlesUnified(
  coin: string,
  timeframe: string,
): Promise<{ source: CandleSource; candles: unknown[][] } | null> {
  const binanceSym = binanceSymbol(coin);

  const binancePath = `/api/v3/klines?symbol=${binanceSym}&interval=${timeframe}&limit=${KLINE_LIMIT}`;
  const binanceRes = await binancePublicGet(binancePath);

  if (binanceRes.ok) {
    try {
      const data = (await binanceRes.json()) as unknown[][];
      if (Array.isArray(data) && data.length > 0) {
        return { source: "binance", candles: data };
      }
    } catch {
      // fall through to Bybit
    }
  }

  const bybitInterval = toBybitInterval(timeframe);
  if (!bybitInterval) {
    console.error(`[FALLBACK] ${coin} ${timeframe} — unsupported Bybit interval`);
    return null;
  }

  const bybitCandles = await bybitPublicGet(binanceSym, bybitInterval, KLINE_LIMIT);

  if (bybitCandles && bybitCandles.length > 0) {
    console.log(`[FALLBACK] ${coin} ${timeframe} → Bybit (${bybitCandles.length} candles)`);
    return { source: "bybit", candles: bybitCandles };
  }

  console.error(`[FALLBACK] ${coin} ${timeframe} — ALL SOURCES FAILED`);
  return null;
}

type Admin = Awaited<
  typeof import("@/integrations/supabase/client.server")
>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/* ───────────── Feed health & alerting ───────────── */

/**
 * Tracks feed health across the current pipeline run.
 *
 * - `indicatorsFailed` and `whalesFailed` are the only feeds strong enough to
 *   trip the circuit breaker (they represent market data sources that are
 *   core to signal generation). Predictions, council, and variants can be
 *   legitimately empty without indicating a systemic failure.
 * - When `degraded` is true, `runFullPipeline()` will:
 *   1. Emit a `feed_error` alert into `trade_alerts` (best-effort).
 *   2. Skip opening new positions (close-only mode via `executeTrades`).
 *   3. Record `status: "degraded"` in `pipeline_runs` (with a fallback to
 *      `"success"` + `error_message` prefix if the DB CHECK rejects it).
 */
interface PipelineHealth {
  degraded: boolean;
  degradedReasons: string[];
  indicatorsFailed: boolean;
  whalesFailed: boolean;
}

function newPipelineHealth(): PipelineHealth {
  return {
    degraded: false,
    degradedReasons: [],
    indicatorsFailed: false,
    whalesFailed: false,
  };
}

/**
 * Best-effort alert emitter. Writes a `feed_error` row into `trade_alerts`.
 *
 * Some deployments define `trade_alerts.trade_id` as NOT NULL (FK to trades),
 * in which case this insert will fail. We swallow the error and rely on
 * `pipeline_runs.error_message` + console logs as the fallback signal. The
 * pipeline never aborts because an alert couldn't be written.
 */
async function emitFeedAlert(
  db: Admin,
  eventType: "feed_error" | "circuit_breaker",
  message: string,
): Promise<void> {
  try {
    await db.from("trade_alerts").insert({
      trade_id: null,
      symbol: "SYSTEM",
      side: null,
      event_type: eventType,
      entry_price: null,
      exit_price: null,
      pnl: null,
      pnl_pct: null,
      created_at: new Date().toISOString(),
    } as never);
    console.log(`[FEED_ALERT] ${eventType} → ${message}`);
  } catch (e) {
    console.error(
      `[FEED_ALERT] trade_alerts insert failed (schema may require trade_id). ` +
        `Fallback signal: pipeline_runs.error_message. Content: ${eventType} — ${message}`,
      e,
    );
  }
}

/* ───────────── Strategy loader (cached) ───────────── */

let strategyCache: { config: StrategyConfig; ts: number } | null = null;
let currentRegimeLabel: string | null = null;

/* ───────────── Regime-aware helpers ───────────── */

function isTrendingRegime(label: string | null): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  return l.includes("trend") || l.includes("strong");
}

function isCalmRegime(label: string | null): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  return (
    l.includes("side") ||
    l.includes("chop") ||
    l.includes("rang") ||
    l.includes("quiet")
  );
}

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
    console.log(`[HL] ${supportedBase.length}/${WATCHLIST.length} watchlist coins supported (skipped ${skipped})`);
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

        const floor = base.has(coin)
          ? hlWhaleFloor(coin)
          : whaleFloor(coin);

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

/* ───────────── Whale alerts — Binance spot only ─────────────
 *
 * Bybit linear perps whales were REMOVED (ambiguous direction).
 * Binance returns 403 since 30/09. CoinLobster covers the gap.
 * ───────────────────────────────────────────────────────────── */

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
  const startedAt = Date.now();
  let binanceSuccessCount = 0;
  let binanceFailCount = 0;

  const perCoinRows = await pMap(
    WATCHLIST,
    async (coin) => {
      const out: Record<string, unknown>[] = [];
      const symbol = binanceSymbol(coin);
      const floor = whaleFloor(coin);

      try {
        const res = await binancePublicGet(
          `/api/v3/aggTrades?symbol=${symbol}&limit=1000`,
        );

        if (!res.ok) {
          binanceFailCount++;
          console.warn(`[WHALE_BINANCE] ${symbol} → HTTP ${res.status}, skipping`);
          return out;
        }

        const parsed = (await res.json()) as BinanceAggTrade[];
        if (!Array.isArray(parsed)) {
          binanceFailCount++;
          console.warn(`[WHALE_BINANCE] ${symbol} → invalid response format`);
          return out;
        }

        binanceSuccessCount++;

        for (const t of parsed) {
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
        binanceFailCount++;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[WHALE_BINANCE] ${symbol} threw: ${msg}`);
      }

      return out;
    },
    10,
  );

  const rows = perCoinRows.flat();
  const elapsed = Date.now() - startedAt;

  console.log(
    `[WHALE_BINANCE_COLLECTOR] ok=${binanceSuccessCount} fail=${binanceFailCount} candidates=${rows.length} in ${elapsed}ms`,
  );

  if (binanceSuccessCount === 0 && binanceFailCount > 0) {
    console.error(
      `[WHALE_BINANCE_COLLECTOR] CRITICAL: Binance whales completely failed (${binanceFailCount} coins). Hyperliquid + CoinLobster cover the rest.`,
    );
  }

  if (rows.length === 0) return 0;

  const { data, error } = await db
    .from("whale_alerts")
    .upsert(rows as never, {
      onConflict: "source,tx_hash",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw error;

  const written = data?.length ?? 0;
  console.log(`[WHALE_BINANCE_COLLECTOR] Wrote ${written} new whale rows (from ${rows.length} candidates)`);
  return written;
}

/* ───────────── Whale alerts — CoinLobster ───────────── */

const COINLOBSTER_MIN_USD = 100_000;
const COINLOBSTER_PRIORITY_COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE"];
const COINLOBSTER_WATCHLIST_FILTER = new Set(WATCHLIST);

export async function collectCoinLobsterWhales(): Promise<number> {
  const db = await admin();
  const startedAt = Date.now();

  const [globalTrades, ...coinBatches] = await Promise.all([
    fetchCoinLobsterWhales(undefined, 50),
    ...COINLOBSTER_PRIORITY_COINS.map((c) => fetchCoinLobsterWhales(c, 30)),
  ]);

  const allRaw: CoinLobsterTrade[] = [
    ...(globalTrades ?? []),
    ...coinBatches.flatMap((b) => b ?? []),
  ];

  console.log(
    `[COINLOBSTER_COLLECTOR] Fetched ${allRaw.length} raw trades ` +
      `(global=${globalTrades?.length ?? 0}, priority=${coinBatches.length} batches)`,
  );

  if (allRaw.length === 0) {
    console.warn(`[COINLOBSTER_COLLECTOR] Zero raw trades retrieved`);
    return 0;
  }

  const seenIds = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  let skippedLowUsd = 0;
  let skippedOffWatchlist = 0;

  for (const raw of allRaw) {
    const norm = normalizeCoinLobsterTrade(raw);
    if (!norm) continue;
    if (norm.usd_value < COINLOBSTER_MIN_USD) {
      skippedLowUsd++;
      continue;
    }
    if (!COINLOBSTER_WATCHLIST_FILTER.has(norm.symbol)) {
      skippedOffWatchlist++;
      continue;
    }
    if (seenIds.has(norm.tx_hash)) continue;
    seenIds.add(norm.tx_hash);

    rows.push({
      symbol: norm.symbol,
      chain: norm.chain,
      direction: norm.direction,
      usd_value: norm.usd_value,
      tx_hash: norm.tx_hash,
      source: norm.source,
      created_at: norm.created_at,
      raw: raw as unknown as Record<string, unknown>,
    });
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[COINLOBSTER_COLLECTOR] Filtered → ${rows.length} candidates ` +
      `(skipped_low_usd=${skippedLowUsd}, skipped_off_watchlist=${skippedOffWatchlist}) in ${elapsed}ms`,
  );

  if (rows.length === 0) return 0;

  const { data, error } = await db
    .from("whale_alerts")
    .upsert(rows as never, {
      onConflict: "source,tx_hash",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw error;

  const written = data?.length ?? 0;
  console.log(`[COINLOBSTER_COLLECTOR] Wrote ${written} new whale rows (from ${rows.length} candidates)`);
  return written;
}

/* ───────────── Technical indicators ───────────── */

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
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

function computeVwap(
  highs: number[], lows: number[], closes: number[], volumes: number[],
): number {
  let cumVol = 0, cumTypVol = 0;
  const start = Math.max(0, closes.length - 24);
  for (let i = start; i < closes.length; i++) {
    const typPrice = (highs[i]! + lows[i]! + closes[i]!) / 3;
    const volume = volumes[i]!;
    cumTypVol += typPrice * volume;
    cumVol += volume;
  }
  return cumVol > 0 ? cumTypVol / cumVol : closes[closes.length - 1]!;
}

function aroon(highs: number[], lows: number[], period = 25) {
  if (highs.length < period + 1 || lows.length < period + 1) {
    return { up: 50, down: 50, osc: 0 };
  }
  const hSlice = highs.slice(-(period + 1));
  const lSlice = lows.slice(-(period + 1));
  let highestIdx = 0, lowestIdx = 0;
  for (let i = 1; i <= period; i++) {
    if (hSlice[i]! >= hSlice[highestIdx]!) highestIdx = i;
    if (lSlice[i]! <= lSlice[lowestIdx]!) lowestIdx = i;
  }
  const up = (highestIdx / period) * 100;
  const down = (lowestIdx / period) * 100;
  return { up, down, osc: up - down };
}

function computeAtrPct(
  highs: number[], lows: number[], closes: number[], period = 14,
): number {
  if (closes.length < period + 1) return 0;

  const tr: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const h = highs[i]!;
    const l = lows[i]!;
    const cPrev = closes[i - 1]!;
    const trueRange = Math.max(h - l, Math.abs(h - cPrev), Math.abs(l - cPrev));
    tr.push(trueRange);
  }

  if (tr.length < period) return 0;

  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
  }

  const currentPrice = closes[closes.length - 1]!;
  return currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
}

interface SmcResult {
  choch: "bearish" | "bullish" | "none";
  bos: "bearish" | "bullish" | "none";
  fvg: { type: "bearish" | "bullish" | "none"; top: number; bottom: number; retesting: boolean };
  fibRetest: { inGoldenPocket: boolean; fib618: number; fib786: number; range: number };
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
  sweepTrap: {
    detected: boolean;
    type: "bsl_sweep" | "ssl_sweep" | "none";
    liquidityLevel: number;
    sweepWickHigh?: number | undefined;
    sweepWickLow?: number | undefined;
    fvgConfirmed: boolean;
  };
  signal:
    | "bsl_sweep_trap"
    | "ssl_sweep_trap"
    | "bearish_continuation"
    | "bearish_reversal"
    | "bullish_continuation"
    | "bullish_reversal"
    | "neutral";
}

function detectSmc(
  opens: number[], highs: number[], lows: number[], closes: number[],
): SmcResult {
  const empty: SmcResult = {
    choch: "none", bos: "none",
    fvg: { type: "none", top: 0, bottom: 0, retesting: false },
    fibRetest: { inGoldenPocket: false, fib618: 0, fib786: 0, range: 0 },
    lastSwingHigh: null, lastSwingLow: null,
    sweepTrap: { detected: false, type: "none", liquidityLevel: 0, fvgConfirmed: false },
    signal: "neutral",
  };
  const len = closes.length;
  if (len < 12) return empty;

  let lastSwingHigh: number | null = null, prevSwingHigh: number | null = null;
  let lastSwingLow: number | null = null, prevSwingLow: number | null = null;
  for (let i = len - 3; i >= 2; i--) {
    if (lows[i]! < lows[i - 1]! && lows[i]! < lows[i - 2]! && lows[i]! < lows[i + 1]! && lows[i]! < lows[i + 2]!) {
      if (lastSwingLow === null) lastSwingLow = lows[i]!;
      else if (prevSwingLow === null) prevSwingLow = lows[i]!;
    }
    if (highs[i]! > highs[i - 1]! && highs[i]! > highs[i - 2]! && highs[i]! > highs[i + 1]! && highs[i]! > highs[i + 2]!) {
      if (lastSwingHigh === null) lastSwingHigh = highs[i]!;
      else if (prevSwingHigh === null) prevSwingHigh = highs[i]!;
    }
    if (lastSwingLow !== null && prevSwingLow !== null && lastSwingHigh !== null && prevSwingHigh !== null) break;
  }

  const currentPrice = closes[len - 1]!;
  const bosBearish = prevSwingLow !== null && lastSwingLow !== null && lastSwingLow < prevSwingLow && currentPrice < prevSwingLow;
  const bosBullish = prevSwingHigh !== null && lastSwingHigh !== null && lastSwingHigh > prevSwingHigh && currentPrice > prevSwingHigh;
  const bos: SmcResult["bos"] = bosBearish ? "bearish" : bosBullish ? "bullish" : "none";
  const choch: SmcResult["choch"] = lastSwingLow !== null && currentPrice < lastSwingLow ? "bearish" : lastSwingHigh !== null && currentPrice > lastSwingHigh ? "bullish" : "none";

  const range = lastSwingHigh !== null && lastSwingLow !== null && lastSwingHigh > lastSwingLow ? lastSwingHigh - lastSwingLow : 0;
  const fib618 = range ? lastSwingLow! + range * 0.618 : 0;
  const fib786 = range ? lastSwingLow! + range * 0.786 : 0;
  const inGoldenPocket = range > 0 && currentPrice >= fib618 && currentPrice <= fib786 * 1.003;

  let fvgType: SmcResult["fvg"]["type"] = "none", fvgTop = 0, fvgBottom = 0, retesting = false;
  for (let i = len - 1; i >= Math.max(2, len - 6); i--) {
    if (lows[i - 2]! > highs[i]!) { fvgType = "bearish"; fvgTop = lows[i - 2]!; fvgBottom = highs[i]!; retesting = currentPrice >= fvgBottom && currentPrice <= fvgTop * 1.002; break; }
    if (highs[i - 2]! < lows[i]!) { fvgType = "bullish"; fvgBottom = highs[i - 2]!; fvgTop = lows[i]!; retesting = currentPrice <= fvgTop && currentPrice >= fvgBottom * 0.998; break; }
  }
  let sweepTrap: SmcResult["sweepTrap"] = { detected: false, type: "none", liquidityLevel: 0, fvgConfirmed: false };
  const targetBsl = lastSwingHigh !== null && prevSwingHigh !== null &&
    Math.abs(lastSwingHigh - prevSwingHigh) / lastSwingHigh <= 0.002
    ? Math.max(lastSwingHigh, prevSwingHigh)
    : lastSwingHigh;
  if (targetBsl !== null && targetBsl > 0) {
    for (let i = len - 1; i >= Math.max(0, len - 3); i--) {
      const candleRange = highs[i]! - lows[i]!;
      const upperWick = highs[i]! - Math.max(opens[i]!, closes[i]!);
      if (highs[i]! > targetBsl && closes[i]! < targetBsl && candleRange > 0 && upperWick / candleRange >= 0.4) {
        sweepTrap = { detected: true, type: "bsl_sweep", liquidityLevel: targetBsl, sweepWickHigh: highs[i], fvgConfirmed: fvgType === "bearish" || retesting };
        break;
      }
    }
  }
  const targetSsl = lastSwingLow !== null && prevSwingLow !== null &&
    Math.abs(lastSwingLow - prevSwingLow) / lastSwingLow <= 0.002
    ? Math.min(lastSwingLow, prevSwingLow)
    : lastSwingLow;
  if (!sweepTrap.detected && targetSsl !== null && targetSsl > 0) {
    for (let i = len - 1; i >= Math.max(0, len - 3); i--) {
      const candleRange = highs[i]! - lows[i]!;
      const lowerWick = Math.min(opens[i]!, closes[i]!) - lows[i]!;
      if (lows[i]! < targetSsl && closes[i]! > targetSsl && candleRange > 0 && lowerWick / candleRange >= 0.4) {
        sweepTrap = { detected: true, type: "ssl_sweep", liquidityLevel: targetSsl, sweepWickLow: lows[i], fvgConfirmed: fvgType === "bullish" || retesting };
        break;
      }
    }
  }
  const signal: SmcResult["signal"] =
    sweepTrap.detected && sweepTrap.fvgConfirmed && sweepTrap.type === "bsl_sweep"
      ? "bsl_sweep_trap"
      : sweepTrap.detected && sweepTrap.fvgConfirmed && sweepTrap.type === "ssl_sweep"
        ? "ssl_sweep_trap"
        : bos === "bearish" && inGoldenPocket
          ? "bearish_continuation"
          : choch === "bearish" && (fvgType === "bearish" || retesting)
            ? "bearish_reversal"
            : bos === "bullish" && range > 0 && currentPrice <= lastSwingLow! + range * 0.382
              ? "bullish_continuation"
              : choch === "bullish" && (fvgType === "bullish" || retesting)
                ? "bullish_reversal"
                : "neutral";
  return { choch, bos, fvg: { type: fvgType, top: fvgTop, bottom: fvgBottom, retesting }, fibRetest: { inGoldenPocket, fib618, fib786, range }, lastSwingHigh, lastSwingLow, sweepTrap, signal };
}

function classify(
  r: number, m: number, s: number, price: number,
  bb: { upper: number; lower: number },
  trend: { up: number; down: number; osc: number },
  smc?: SmcResult,
): "bullish" | "bearish" | "neutral" {
  if (smc?.signal === "bsl_sweep_trap") return "bearish";
  if (smc?.signal === "ssl_sweep_trap") return "bullish";
  if (smc?.signal === "bearish_continuation" || smc?.signal === "bearish_reversal") {
    const momentum = m - s;
    if (momentum <= 0 || r >= 45) return "bearish";
    return "neutral";
  }

  const momentum = m - s;
  const nearLowerBand = price <= bb.lower * 1.01;
  const nearUpperBand = price >= bb.upper * 0.99;
  if (nearLowerBand && trend.osc >= 20 && momentum >= 0) return "bullish";
  if (nearUpperBand && trend.osc <= -20 && momentum <= 0) return "bearish";

  // Tightened RSI-based classification.
  //
  // The previous logic treated ANY RSI < 55 with a weak positive MACD tick
  // as bullish, which mislabeled hundreds of neutral readings as bullish
  // in production (audit: 94 shown as "bullish" vs 11 bullish per regime
  // snapshot). The new logic:
  //   - RSI 44–56 = strict neutral band, escaped only by a strong MACD
  //     cross (≥ 5% of |m|).
  //   - RSI < 44 → bullish only if MACD momentum is positive.
  //   - RSI > 56 → bearish only if MACD momentum is negative.
  //   - Everything else = neutral.
  const NEUTRAL_LOW = 44;
  const NEUTRAL_HIGH = 56;
  const STRONG_MACD_FRACTION = 0.05;
  const strongBull = momentum > STRONG_MACD_FRACTION * Math.abs(m);
  const strongBear = momentum < -STRONG_MACD_FRACTION * Math.abs(m);

  if (r >= NEUTRAL_LOW && r <= NEUTRAL_HIGH) {
    if (strongBull) return "bullish";
    if (strongBear) return "bearish";
    return "neutral";
  }
  if (r < NEUTRAL_LOW) return momentum > 0 ? "bullish" : "neutral";
  return momentum < 0 ? "bearish" : "neutral";
}

async function fetchIndicatorForTimeframe(
  coin: string, timeframe: string,
): Promise<Record<string, unknown> | null> {
  const symbol = binanceSymbol(coin);
  try {
    const result = await fetchCandlesUnified(coin, timeframe);
    if (!result) {
      console.error(`[INDICATOR_FETCH] ${symbol} ${timeframe} → no source returned candles`);
      return null;
    }

    const raw = result.candles;
    const opens = raw.map((r) => parseFloat(String(r[1])));
    const highs = raw.map((r) => parseFloat(String(r[2])));
    const lows = raw.map((r) => parseFloat(String(r[3])));
    const closes = raw.map((r) => parseFloat(String(r[4])));
    const volumes = raw.map((r) => parseFloat(String(r[5])));

    if (
      closes.length < 30 ||
      closes.some((c) => !Number.isFinite(c)) ||
      opens.some((v) => !Number.isFinite(v)) ||
      highs.some((v) => !Number.isFinite(v)) ||
      lows.some((v) => !Number.isFinite(v)) ||
      volumes.some((v) => !Number.isFinite(v) || v < 0)
    ) {
      console.warn(`[INDICATOR_FETCH] ${symbol} ${timeframe} (${result.source}) → invalid data`);
      return null;
    }

    const r = rsi(closes);
    const { macd: m, signal: s } = macd(closes);
    const bb = bollinger(closes);
    const trend = aroon(highs, lows);
    const vwap = computeVwap(highs, lows, closes, volumes);
    const smc = detectSmc(opens, highs, lows, closes);
    const atrPct = computeAtrPct(highs, lows, closes, 14);
    const candleCloseTime = new Date(Number(raw[raw.length - 1]?.[6]) || Date.now()).toISOString();

    return {
      symbol, timeframe,
      rsi: Number.isFinite(r) ? r : null,
      macd: m, macd_signal: s,
      bb_upper: bb.upper, bb_lower: bb.lower,
      price: closes[closes.length - 1]!,
      signal: classify(r, m, s, closes[closes.length - 1]!, bb, trend, smc),
      created_at: new Date().toISOString(),
      raw: {
        closes_tail: closes.slice(-5),
        candle_close_time: candleCloseTime,
        aroon: trend,
        bollinger: { upper: bb.upper, lower: bb.lower },
        vwap, smc,
        atr_pct: atrPct,
        source: result.source,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[INDICATOR_FETCH] ${symbol} ${timeframe} threw: ${msg}`);
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

  const startedAt = Date.now();
  console.log(`[INDICATORS] Starting collection for ${coins.length} coins × ${TIMEFRAMES.length} timeframes = ${tasks.length} tasks`);

  const results = await pMap(
    tasks,
    async ({ coin, timeframe }) => fetchIndicatorForTimeframe(coin, timeframe),
    15,
  );

  const rows = results.filter((r): r is Record<string, unknown> => r != null);
  const elapsed = Date.now() - startedAt;
  const successRate = tasks.length > 0 ? ((rows.length / tasks.length) * 100).toFixed(1) : "0.0";

  console.log(`[INDICATORS] Collected ${rows.length}/${tasks.length} (${successRate}%) in ${elapsed}ms`);

  if (rows.length === 0) {
    console.error(`[INDICATORS] CRITICAL: 0/${tasks.length} fetches succeeded.`);
    return 0;
  }

  const bySource = rows.reduce<Record<string, number>>((acc, r) => {
    const src = String((r["raw"] as Record<string, unknown>)?.["source"] ?? "unknown");
    acc[src] = (acc[src] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[INDICATORS] Sources: ${JSON.stringify(bySource)}`);

  const { data, error } = await db
    .from("indicator_snapshots")
    .upsert(rows as never, {
      onConflict: "symbol,timeframe",
      ignoreDuplicates: false,
    })
    .select("id");
  if (error) {
    console.error(`[INDICATORS] Upsert failed:`, error);
    throw error;
  }

  const written = data?.length ?? 0;
  console.log(`[INDICATORS] Wrote ${written} rows to indicator_snapshots`);
  return written;
}

/* ───────────── Prediction markets ───────────── */

const WATCH_KEYWORDS: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"], ETH: ["ethereum", "eth"],
  SOL: ["solana", "sol"], XRP: ["xrp", "ripple"],
  DOGE: ["dogecoin", "doge"], ADA: ["cardano", "ada"],
  AVAX: ["avalanche", "avax"], LINK: ["chainlink", "link"],
  DOT: ["polkadot", "dot"], LTC: ["litecoin", "ltc"],
  MATIC: ["polygon", "matic", "pol"], BNB: ["bnb", "binance coin"],
  TRX: ["tron", "trx"], SHIB: ["shiba", "shib"],
  PEPE: ["pepe"], ATOM: ["cosmos", "atom"],
  NEAR: ["near protocol"], APT: ["aptos", "apt"],
  SUI: ["sui"], INJ: ["injective", "inj"],
  ARB: ["arbitrum", "arb"], OP: ["optimism"],
  UNI: ["uniswap", "uni"], AAVE: ["aave"],
};

const cryptoWord =
  /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|dogecoin|doge|cardano|ada|avalanche|avax|chainlink|link|polkadot|dot|litecoin|ltc|polygon|matic|pol|bnb|binance coin|tron|trx|shiba|shib|pepe|cosmos|atom|near protocol|aptos|apt|sui|injective|inj|arbitrum|arb|optimism|uniswap|uni|aave)\b/i;

interface PolymarketMarket {
  slug?: string; question?: string;
  outcomePrices?: string; volume24hr?: number;
}
interface PolymarketEvent {
  markets?: PolymarketMarket[];
}

function eventMarkets(payload: (PolymarketEvent | PolymarketMarket)[]): PolymarketMarket[] {
  return payload.flatMap((item) =>
    "markets" in item ? ((item as PolymarketEvent).markets ?? []) : [item as PolymarketMarket],
  );
}

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
  const res = await fetchWithTimeout(
    "https://gamma-api.polymarket.com/events?tag_slug=crypto&active=true&closed=false&limit=200",
  );
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
      yes_price: yes, no_price: no,
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

const BULLISH_QUESTION = /\b(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\b/i;
const BEARISH_QUESTION = /\b(dip|drop|fall|below|crash|down to|under|bottom)\b/i;

export function predictionDirection(prediction: Row): "bullish" | "bearish" | "neutral" {
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

/**
 * Prediction magnitude 0..1.
 *
 * Maps the distance of the directional probability from 50% to a score
 * multiplier. Neutral-band predictions (40–60%) return 0 and contribute
 * no score. Values above the neutral band scale linearly:
 *   60% → 0, 70% → 0.25, 80% → 0.5, 90% → 0.75, 100% → 1.0.
 *
 * This ensures a 93%-conviction bearish signal contributes ~4× the weight
 * of a barely-passing 60% call, instead of the previous flat 0.5.
 */
export function predictionMagnitude(prediction: Row): number {
  const yes = Number(prediction?.["yes_price"]);
  if (!Number.isFinite(yes)) return 0;
  const q = String(prediction?.["question"] ?? "").toLowerCase();
  const isBullishQ = BULLISH_QUESTION.test(q);
  const isBearishQ = BEARISH_QUESTION.test(q);
  if (!isBullishQ && !isBearishQ) return 0;
  const up = isBullishQ ? yes : 1 - yes;
  const distance = Math.abs(up - 0.5) * 2; // 0 at 50%, 1 at extremes
  if (distance < 0.2) return 0; // neutral band 40–60%
  return Math.min(1, (distance - 0.2) / 0.8);
}

/* ───────────── Multi-timeframe evaluator ───────────── */

export interface MultiTfInput { primary: Row; fast: Row; trend: Row; }

export interface MultiTfResult {
  direction: SignalDir;
  score: number;
  aligned: boolean;
  conflict: boolean;
  detail: string;
  bullCount: number;
  bearCount: number;
  neuCount: number;
}

export function evaluateMultiTimeframe(tf: MultiTfInput): MultiTfResult {
  const p = (tf.primary?.["signal"] as SignalDir | undefined) ?? "neutral";
  let f = (tf.fast?.["signal"] as SignalDir | undefined) ?? "neutral";
  const t = (tf.trend?.["signal"] as SignalDir | undefined) ?? "neutral";

  const fastPrice = Number(tf.fast?.["price"] ?? 0);
  const fastVwap = Number((tf.fast?.["raw"] as Row)?.["vwap"] ?? 0);
  const fastRsi = Number(tf.fast?.["rsi"] ?? 50);
  if (fastPrice > 0 && fastVwap > 0) {
    if (fastRsi >= 60 && fastPrice > fastVwap) f = "bullish";
    else if (fastRsi <= 40 && fastPrice < fastVwap) f = "bearish";
  }

  const label = (s: SignalDir) =>
    s === "bullish" ? "bull" : s === "bearish" ? "bear" : "neu";
  const detail = `4h ${label(p)} · 1h ${label(f)} · 1d ${label(t)}`;

  const bullCount = [p, f, t].filter((s) => s === "bullish").length;
  const bearCount = [p, f, t].filter((s) => s === "bearish").length;
  const neuCount = [p, f, t].filter((s) => s === "neutral").length;

  if (p === "neutral") {
    return { direction: "neutral", score: 0, aligned: false, conflict: false, detail, bullCount, bearCount, neuCount };
  }

  const base = p === "bullish" ? 1.0 : -1.0;
  let multiplier = 1.0;
  if (f === p) multiplier *= 1.3;
  else if (f !== "neutral") multiplier *= 0.7;
  if (t === p) multiplier *= 1.3;
  else if (t !== "neutral") multiplier *= 0.7;

  const aligned = f === p && t === p;
  const conflict = t !== "neutral" && t !== p;

  return { direction: p, score: base * multiplier, aligned, conflict, detail, bullCount, bearCount, neuCount };
}

/* ───────────── Deterministic council fallback ───────────── */

function councilEvaluation(whale: Row, mtf: MultiTfResult, prediction: Row) {
  const votes: CouncilVerdict[] = [];
  const reasons: string[] = [];

  if (mtf.direction === "bullish" && mtf.score >= 0.7) {
    votes.push("BUY"); reasons.push(`quant sees bullish alignment (${mtf.detail})`);
  } else if (mtf.direction === "bearish" && mtf.score <= -0.7) {
    votes.push("SELL"); reasons.push(`quant sees bearish alignment (${mtf.detail})`);
  } else if (mtf.aligned) {
    votes.push(mtf.direction === "bullish" ? "BUY" : "SELL");
    reasons.push(`quant sees aligned trend (${mtf.detail})`);
  } else {
    votes.push("HOLD"); reasons.push(`quant sees mixed technicals (${mtf.detail})`);
  }

  const flow = whale?.["direction"];
  if (flow === "accumulation") { votes.push("BUY"); reasons.push("whale tracker sees accumulation"); }
  else if (flow === "distribution") { votes.push("SELL"); reasons.push("whale tracker sees distribution"); }
  else { votes.push("HOLD"); reasons.push("whale tracker has no directional flow"); }

  const dir = predictionDirection(prediction);
  if (dir === "bullish") { votes.push("BUY"); reasons.push("sentiment leans bullish"); }
  else if (dir === "bearish") { votes.push("SELL"); reasons.push("sentiment leans bearish"); }
  else { votes.push("HOLD"); reasons.push("sentiment is inconclusive"); }

  const counts = votes.reduce<Record<string, number>>((all, vote) => {
    all[vote] = (all[vote] ?? 0) + 1; return all;
  }, {});
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

// ─── Dynamic Groq batch cadence (regime-aware) ───
// In trending markets signals decay faster and regime shifts are more
// consequential, so we refresh AI verdicts more aggressively. In calm /
// sideways / choppy conditions we slow down to conserve tokens and stay
// well below Groq's RPM/TPM limits.
const AI_MIN_MINUTES_BETWEEN_BATCHES_DEFAULT = 25;
const AI_MIN_MINUTES_BETWEEN_BATCHES_TRENDING = 15;
const AI_MIN_MINUTES_BETWEEN_BATCHES_CALM = 40;

function aiBatchIntervalMinutes(): number {
  if (isTrendingRegime(currentRegimeLabel)) return AI_MIN_MINUTES_BETWEEN_BATCHES_TRENDING;
  if (isCalmRegime(currentRegimeLabel)) return AI_MIN_MINUTES_BETWEEN_BATCHES_CALM;
  return AI_MIN_MINUTES_BETWEEN_BATCHES_DEFAULT;
}

function councilMaxAgeMs(): number {

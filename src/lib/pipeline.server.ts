import { canOpenTrade } from "./risk.engine";
import {
  placeBinanceSpotMarketOrder,
  getExecutableSpotSellQuantity,
} from "./binance-spot.server";
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
import { checkMtfGate, type MtfCounts, type MtfGateConfig } from "./mtf-gate";
import { computeRegimeSnapshot } from "./regime-snapshot";
import { computeAssetRegime } from "./asset-regime";
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
import { CORE_FALLBACK_WATCHLIST } from "./coin-provenance";
import {
  getActiveWatchlist,
  getActiveWatchlistContext,
  resolveWatchlistContext,
  invalidateWatchlistCache,
  tagsFor,
  type WatchlistContext,
} from "./watchlist-resolver.server";
import {
  recordHotWhale,
  getHotWhaleSymbols,
  cleanupHotWhales,
  getHotWhaleBatch,
  qualifiesForConvictionBoost,
  convictionBoostMagnitude,
  HOT_THRESHOLD_USD,
  type HotWhaleAggregate,
} from "./hot-whale.server";
import {
  evaluateGlobalRisk,
  getGlobalRiskControl,
  getGlobalRiskState,
} from "./global-risk.server";
import { evaluateAIRiskBatch, type AIRiskDecision } from "./ai-risk.functions";
import {
  buildShadowV2ClosedPosition,
  buildShadowV2OpenPosition,
  getShadowV2Decision,
  getShadowV2Fingerprint,
  resolveShadowV2Candle,
  calculateShadowV2Expiry,
  type ShadowV2Position,
  type ShadowV2Signal,
} from "./shadow-v2";

/* ───────────── Types ───────────── */

type WhaleSourceName = "hyperliquid" | "binance" | "bybit" | "coinlobster";
type WhaleSourceHealth = { state: "ok" | "empty" | "error"; http_status?: number; requests: number; qualifying: number; errors: number; message?: string };
const whaleSourceHealth: Record<WhaleSourceName, WhaleSourceHealth> = {
  hyperliquid: { state: "empty", requests: 0, qualifying: 0, errors: 0 },
  binance: { state: "empty", requests: 0, qualifying: 0, errors: 0 },
  bybit: { state: "empty", requests: 0, qualifying: 0, errors: 0 },
  coinlobster: { state: "empty", requests: 0, qualifying: 0, errors: 0 },
};
function resetWhaleSourceHealth() {
  for (const source of Object.keys(whaleSourceHealth) as WhaleSourceName[]) whaleSourceHealth[source] = { state: "empty", requests: 0, qualifying: 0, errors: 0 };
}
function whaleSourceSnapshot() { return JSON.parse(JSON.stringify(whaleSourceHealth)) as Record<WhaleSourceName, WhaleSourceHealth>; }
type Row = Record<string, unknown> | null;
type CouncilVerdict = "BUY" | "SELL" | "HOLD" | "AVOID";
type SignalDir = "bullish" | "bearish" | "neutral";

/* ───────────── Execution Audit ───────────── */

export type ExecutionAuditStage =
  | "CIRCUIT_BREAKER"
  | "GLOBAL_RISK"
  | "CANDIDATE_FILTER"
  | "AI_RISK"
  | "ENTRY_GATE"
  | "QUALITY"
  | "REGIME"
  | "RISK_ENGINE"
  | "POSITION_SIZE"
  | "TRADE_INSERT"
  | "EXECUTION";

export type ExecutionAuditDecision =
  | "ACCEPT"
  | "REJECT"
  | "OPEN"
  | "ERROR"
  | "SKIP";

export type ExecutionAuditEvent = {
  ts: string;
  symbol: string;
  signal_id?: string;
  stage: ExecutionAuditStage;
  decision: ExecutionAuditDecision;
  reason: string;
  confidence?: number;
  details?: Record<string, unknown>;
};

function createExecutionAuditEvent(
  symbol: string,
  stage: ExecutionAuditStage,
  decision: ExecutionAuditDecision,
  reason: string,
  opts?: {
    signalId?: string;
    confidence?: number;
    details?: Record<string, unknown>;
  },
): ExecutionAuditEvent {
  return {
    ts: new Date().toISOString(),
    symbol,
    stage,
    decision,
    reason,
    ...(opts?.signalId !== undefined ? { signal_id: opts.signalId } : {}),
    ...(opts?.confidence !== undefined ? { confidence: opts.confidence } : {}),
    ...(opts?.details !== undefined ? { details: opts.details } : {}),
  };
}

/* ───────────── pMap ───────────── */

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

/* ───────────── Watchlist (deprecated) ───────────── */

export const WATCHLIST: string[] = [...CORE_FALLBACK_WATCHLIST];
export const STATIC_WATCHLIST_SIZE = CORE_FALLBACK_WATCHLIST.length;

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

/* ───────────── Timeframes & thresholds ───────────── */

const PRIMARY_TIMEFRAME = "4h";
const FAST_TIMEFRAME = "1h";
const TREND_TIMEFRAME = "1d";
const TIMEFRAMES = [PRIMARY_TIMEFRAME, FAST_TIMEFRAME, TREND_TIMEFRAME] as const;
const KLINE_LIMIT = 100;

  /* Entry / execution safety — derived from persisted composite signals. */
  const MIN_CONFIDENCE = 0.60;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_ENTRY_DRIFT_PCT = 0.005;
const SYMBOL_COOLDOWN_MINUTES = 15;
const WHALE_LOOKBACK_HOURS = 6;

const ROTATION_MIN_NEW_CONFIDENCE = 0.75;
const ROTATION_CONFIDENCE_IMPROVEMENT = 0.10;
const ROTATION_MIN_OPEN_AGE_MINUTES = 30;
const ROTATION_MAX_WEAKEST_PNL_PCT = 0.5;

const INDICATOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PREDICTION_MAX_AGE_MS = 30 * 60 * 1000;

const COUNCIL_MAX_AGE_MS = 30 * 60 * 1000;
const COUNCIL_MAX_AGE_MS_TRENDING = 20 * 60 * 1000;
const COUNCIL_MAX_AGE_MS_CALM = 45 * 60 * 1000;

const STRATEGY_CACHE_TTL_MS = 60_000;

const VARIANT_RESOLVE_TIMEFRAME = "1h";
const VARIANT_RESOLVE_CANDLE_LIMIT = 100;

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

/* ───────────── Exchange candle fetching ───────────── */

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
    ? [preferredMarketHost, ...BINANCE_MARKET_HOSTS.filter((h) => h !== preferredMarketHost)]
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
        preferredMarketHost = host;
        return response;
      }
      if (![403, 418, 429, 451].includes(response.status) && response.status < 500) return response;
      lastResponse = response;
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      attempts.push(`${host}→THREW(${ms}ms:${msg.slice(0, 60)})`);
    }
  }
  return lastResponse ?? new Response(
    JSON.stringify({ error: "all hosts failed", attempts }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}

interface BybitKlineResult {
  retCode: number; retMsg: string;
  result?: { category: string; symbol: string; list: string[][] };
}

interface BybitRecentTrade {
  execId?: string;
  symbol?: string;
  price?: string;
  size?: string;
  side?: "Buy" | "Sell" | string;
  time?: string;
}

interface BybitRecentTradeResult {
  retCode: number;
  retMsg: string;
  result?: {
    category: string;
    list: BybitRecentTrade[];
  };
}

async function bybitRecentTrades(symbol: string, limit = 60): Promise<BybitRecentTrade[]> {
  const url = new URL(`${BYBIT_HOST}/v5/market/recent-trade`);
  url.searchParams.set("category", "spot");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("limit", String(Math.min(limit, 60)));
  try {
    const res = await fetchWithTimeout(url.toString());
    if (!res.ok) return [];
    const json = (await res.json()) as BybitRecentTradeResult;
    if (json.retCode !== 0 || !json.result?.list) return [];
    return json.result.list;
  } catch {
    return [];
  }
}

async function bybitPublicGet(symbol: string, interval: string, limit: number): Promise<unknown[][] | null> {
  const url = new URL(`${BYBIT_HOST}/v5/market/kline`);
  url.searchParams.set("category", "spot");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(Math.min(limit, 1000)));
  try {
    const res = await fetchWithTimeout(url.toString());
    if (!res.ok) return null;
    const json = (await res.json()) as BybitKlineResult;
    if (json.retCode !== 0) return null;
    const list = json.result?.list;
    if (!Array.isArray(list) || list.length === 0) return null;
    const chronological = [...list].reverse();
    const intervalMs = parseBybitIntervalMs(interval);
    return chronological.map((k) => {
      const startMs = Number(k[0]);
      return [k[0], k[1], k[2], k[3], k[4], k[5], String(startMs + intervalMs)];
    });
  } catch {
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
  coin: string, timeframe: string,
): Promise<{ source: CandleSource; candles: unknown[][] } | null> {
  const binanceSym = binanceSymbol(coin);
  const binanceRes = await binancePublicGet(
    `/api/v3/klines?symbol=${binanceSym}&interval=${timeframe}&limit=${KLINE_LIMIT}`,
  );
  if (binanceRes.ok) {
    try {
      const data = (await binanceRes.json()) as unknown[][];
      if (Array.isArray(data) && data.length > 0) return { source: "binance", candles: data };
    } catch {}
  }
  const bybitInterval = toBybitInterval(timeframe);
  if (!bybitInterval) return null;
  const bybitCandles = await bybitPublicGet(binanceSym, bybitInterval, KLINE_LIMIT);
  if (bybitCandles && bybitCandles.length > 0) return { source: "bybit", candles: bybitCandles };
  return null;
}

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/* ───────────── Feed health ───────────── */

interface PipelineHealth {
  degraded: boolean;
  degradedReasons: string[];
  indicatorsFailed: boolean;
  whalesFailed: boolean;
}

function newPipelineHealth(): PipelineHealth {
  return { degraded: false, degradedReasons: [], indicatorsFailed: false, whalesFailed: false };
}

async function emitFeedAlert(
  db: Admin,
  eventType: "feed_error" | "circuit_breaker",
  message: string,
  opts?: { symbol?: string | null; tags?: string[] },
): Promise<void> {
  const tags = opts?.tags ?? [];
  try {
    await db.from("trade_alerts").insert({
      trade_id: null,
      symbol: opts?.symbol ?? "SYSTEM",
      side: null,
      event_type: eventType,
      entry_price: null,
      exit_price: null,
      pnl: null,
      pnl_pct: null,
      tags,
      created_at: new Date().toISOString(),
    } as never);
    console.log(`[FEED_ALERT] ${eventType} → ${message}` + (tags.length > 0 ? ` [tags=${tags.join(",")}]` : ""));
  } catch (e) {
    console.error(`[FEED_ALERT] insert failed: ${eventType} — ${message}`, e);
  }
}

/* ───────────── Strategy loader ───────────── */

let strategyCache: { config: StrategyConfig; ts: number } | null = null;
let currentRegimeLabel: string | null = null;

function isTrendingRegime(label: string | null): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  return l.includes("trend") || l.includes("strong");
}

function isCalmRegime(label: string | null): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  return l.includes("side") || l.includes("chop") || l.includes("rang") || l.includes("quiet");
}

async function fetchStrategy(): Promise<StrategyConfig> {
  const now = Date.now();
  if (strategyCache && now - strategyCache.ts < STRATEGY_CACHE_TTL_MS) return strategyCache.config;
  try {
    const db = await admin();
    const { data, error } = await db.from("strategy_config").select("*").eq("id", 1).maybeSingle();
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
  px: string; sz: string; side: "B" | "A";
  time: number; tid: number; hash?: string;
}

interface HyperliquidUniverse { all: Set<string>; top: string[]; ts: number; }
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
    const [meta, ctxs] = await hlPost<
      [{ universe: { name: string }[] }, { dayNtlVlm?: string }[]]
    >({ type: "metaAndAssetCtxs" });
    const all = new Set(meta.universe.map((u) => u.name));
    if (all.size === 0) return { all: new Set(), top: [], ts: 0 };
    const top = meta.universe
      .map((u, i) => ({ coin: u.name, vol: parseFloat(ctxs[i]?.dayNtlVlm ?? "0") || 0 }))
      .sort((a, b) => b.vol - a.vol)
      .slice(0, TOP_MOVERS_COUNT)
      .map((m) => m.coin);
    hlUniverseCache = { all, top, ts: now };
    return hlUniverseCache;
  } catch (e) {
    console.error("[HL] metaAndAssetCtxs failed", e);
    return { all: new Set(), top: [], ts: 0 };
  }
}

async function hyperliquidTopMovers(): Promise<string[]> {
  const { top } = await fetchHyperliquidUniverse();
  return top;
}

/* ───────────── Whale alerts: Hyperliquid ───────────── */

export async function collectWhaleAlerts(): Promise<number> {
  const db = await admin();
  const watchlist = await getActiveWatchlist();
  const { all: supported, top: movers } = await fetchHyperliquidUniverse();
  if (supported.size === 0) return 0;

  const base = new Set(watchlist);
  const supportedBase = watchlist.filter((c) => supported.has(c));
  const coins = [...new Set([...supportedBase, ...movers])];

  const perCoinRows = await pMap(
    coins,
    async (coin) => {
      const out: Record<string, unknown>[] = [];
      try {
        whaleSourceHealth.hyperliquid.requests++;
        const trades = await hlPost<HlTrade[]>({ type: "recentTrades", coin });
        if (!Array.isArray(trades)) return out;
        const source = base.has(coin) ? "hyperliquid-recent-trades" : "hyperliquid-top-mover";
        const floor = base.has(coin) ? hlWhaleFloor(coin) : whaleFloor(coin);
        for (const t of trades) {
          const usd = parseFloat(t.px) * parseFloat(t.sz);
          if (!Number.isFinite(usd) || usd < floor) continue;
          out.push({
            symbol: coin, chain: "hyperliquid-perp",
            direction: t.side === "B" ? "accumulation" : "distribution",
            usd_value: usd, tx_hash: t.hash ?? String(t.tid),
            source, created_at: new Date(t.time).toISOString(),
            raw: t as unknown as Record<string, unknown>,
          });
        }
      } catch (e) { whaleSourceHealth.hyperliquid.errors++; whaleSourceHealth.hyperliquid.message = e instanceof Error ? e.message : String(e); console.error(`[HL] whale fetch failed for ${coin}`, e); }
      return out;
    },
    10,
  );

  const rows = perCoinRows.flat();
  whaleSourceHealth.hyperliquid.qualifying = rows.length;
  whaleSourceHealth.hyperliquid.state =
    whaleSourceHealth.hyperliquid.errors === 0 ? (rows.length ? "ok" : "empty") :
    whaleSourceHealth.hyperliquid.requests > whaleSourceHealth.hyperliquid.errors ? "ok" : "error";
  if (rows.length === 0) return 0;

  // Hot whale queue feeding
  const watchlistSet = new Set(watchlist);
  const hotCandidates = rows.filter(
    (r) => !watchlistSet.has(String(r["symbol"])) && Number(r["usd_value"]) >= HOT_THRESHOLD_USD,
  );
  if (hotCandidates.length > 0) {
    const bySymbol = new Map<string, { usd: number; isBuy: boolean; source: string }>();
    for (const r of hotCandidates) {
      const sym = String(r["symbol"]);
      const usd = Number(r["usd_value"]);
      const isBuy = r["direction"] === "accumulation";
      const source = String(r["source"]);
      const existing = bySymbol.get(sym);
      if (!existing || usd > existing.usd) bySymbol.set(sym, { usd, isBuy, source });
    }
    await Promise.all(
      [...bySymbol.entries()].slice(0, 50).map(([sym, v]) =>
        recordHotWhale(sym, v.usd, v.isBuy, v.source),
      ),
    );
    const topLog = [...bySymbol.entries()]
      .sort((a, b) => b[1].usd - a[1].usd).slice(0, 5)
      .map(([sym, v]) => `${sym}=$${Math.round(v.usd / 1000)}K`).join(", ");
    console.log(`[HOT_WHALE] queued ${bySymbol.size} non-watchlist symbols (top: ${topLog})`);
  }

  const { data, error } = await db.from("whale_alerts").upsert(rows as never, {
    onConflict: "source,tx_hash", ignoreDuplicates: true,
  }).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Binance spot whales ───────────── */

const BINANCE_SYMBOL_MAP: Record<string, string> = { MATIC: "POL", RNDR: "RENDER" };
const binanceSymbol = (coin: string) => `${BINANCE_SYMBOL_MAP[coin] ?? coin}USDT`;

interface BinanceAggTrade { a: number; p: string; q: string; T: number; m: boolean; }

export async function collectExchangeWhaleAlerts(): Promise<number> {
  const db = await admin();
  const watchlist = await getActiveWatchlist();

  const perCoinRows = await pMap(
    watchlist,
    async (coin) => {
      const out: Record<string, unknown>[] = [];
      const symbol = binanceSymbol(coin);
      const floor = whaleFloor(coin);
      try {
        whaleSourceHealth.binance.requests++;
        const res = await binancePublicGet(`/api/v3/aggTrades?symbol=${symbol}&limit=1000`);
        if (res.ok) {
          const parsed = (await res.json()) as BinanceAggTrade[];
          if (Array.isArray(parsed)) {
            whaleSourceHealth.binance.state = "ok";
            for (const t of parsed) {
              const usd = parseFloat(t.p) * parseFloat(t.q);
              if (!Number.isFinite(usd) || usd < floor) continue;
              out.push({
                symbol: coin, chain: "binance-spot",
                direction: t.m ? "distribution" : "accumulation",
                usd_value: usd, tx_hash: String(t.a),
                source: "binance-agg-trades",
                created_at: new Date(t.T).toISOString(),
                raw: t as unknown as Record<string, unknown>,
              });
            }
            return out;
          }
        }

        // Binance is geo-blocked (403) from the deployed runtime. Fall back
        // to Bybit spot recent trades so a Binance outage does not erase the
        // whale feed. This is observational market data only.
        whaleSourceHealth.binance.errors++;
        whaleSourceHealth.binance.http_status = res.status;
        whaleSourceHealth.binance.message = `HTTP ${res.status}`;
        whaleSourceHealth.bybit.requests++;
        const fallback = await bybitRecentTrades(symbol, 60);
        whaleSourceHealth.bybit.state = "ok";
        for (const t of fallback) {
          const usd = Number(t.price) * Number(t.size);
          if (!Number.isFinite(usd) || usd < floor) continue;
          out.push({
            symbol: coin,
            chain: "bybit-spot",
            direction: String(t.side).toLowerCase() === "buy" ? "accumulation" : "distribution",
            usd_value: usd,
            tx_hash: String(t.execId ?? `bybit-${symbol}-${t.time}-${t.price}-${t.size}`),
            source: "bybit-recent-trades",
            created_at: new Date(Number(t.time ?? Date.now())).toISOString(),
            raw: t as unknown as Record<string, unknown>,
          });
        }
      } catch (e) {
        whaleSourceHealth.binance.errors++;
        whaleSourceHealth.binance.message = e instanceof Error ? e.message : String(e);
        whaleSourceHealth.bybit.errors++;
        whaleSourceHealth.bybit.state = "error";
      }
      return out;
    },
    10,
  );

  const rows = perCoinRows.flat();
  whaleSourceHealth.binance.qualifying = rows.filter((r) => r["source"] === "binance-agg-trades").length;
  whaleSourceHealth.bybit.qualifying = rows.filter((r) => r["source"] === "bybit-recent-trades").length;
  if (whaleSourceHealth.binance.errors === 0 && whaleSourceHealth.binance.requests > 0) whaleSourceHealth.binance.state = "ok";
  else if (whaleSourceHealth.binance.errors > 0 && whaleSourceHealth.binance.errors === whaleSourceHealth.binance.requests) whaleSourceHealth.binance.state = "error";
  if (whaleSourceHealth.bybit.requests > 0 && whaleSourceHealth.bybit.errors === 0) whaleSourceHealth.bybit.state = "ok";
  if (rows.length === 0) return 0;
  const { data, error } = await db.from("whale_alerts").upsert(rows as never, {
    onConflict: "source,tx_hash", ignoreDuplicates: true,
  }).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── CoinLobster whales ───────────── */

const COINLOBSTER_MIN_USD = 100_000;
const COINLOBSTER_PRIORITY_COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE"];

export async function collectCoinLobsterWhales(): Promise<number> {
  const db = await admin();
  whaleSourceHealth.coinlobster.requests++;
  const watchlist = await getActiveWatchlist();
  const filter = new Set(watchlist);

  const [globalTrades, ...coinBatches] = await Promise.all([
    fetchCoinLobsterWhales(undefined, 50),
    ...COINLOBSTER_PRIORITY_COINS.map((c) => fetchCoinLobsterWhales(c, 30)),
  ]);

  const allRaw: CoinLobsterTrade[] = [
    ...(globalTrades ?? []),
    ...coinBatches.flatMap((b) => b ?? []),
  ];
  if (allRaw.length === 0) return 0;

  const seenIds = new Set<string>();
  const rows: Record<string, unknown>[] = [];

  for (const raw of allRaw) {
    const norm = normalizeCoinLobsterTrade(raw);
    if (!norm) continue;
    if (norm.usd_value < COINLOBSTER_MIN_USD) continue;
    if (!filter.has(norm.symbol)) continue;
    if (seenIds.has(norm.tx_hash)) continue;
    seenIds.add(norm.tx_hash);
    rows.push({
      symbol: norm.symbol, chain: norm.chain, direction: norm.direction,
      usd_value: norm.usd_value, tx_hash: norm.tx_hash,
      source: norm.source, created_at: norm.created_at,
      raw: raw as unknown as Record<string, unknown>,
    });
  }

  if (rows.length === 0) return 0;
  const { data, error } = await db.from("whale_alerts").upsert(rows as never, {
    onConflict: "source,tx_hash", ignoreDuplicates: true,
  }).select("id");
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

function computeVwap(highs: number[], lows: number[], closes: number[], volumes: number[]): number {
  let cumVol = 0, cumTypVol = 0;
  const start = Math.max(0, closes.length - 24);
  for (let i = start; i < closes.length; i++) {
    const typPrice = (highs[i]! + lows[i]! + closes[i]!) / 3;
    cumTypVol += typPrice * volumes[i]!;
    cumVol += volumes[i]!;
  }
  return cumVol > 0 ? cumTypVol / cumVol : closes[closes.length - 1]!;
}

function aroon(highs: number[], lows: number[], period = 25) {
  if (highs.length < period + 1 || lows.length < period + 1) return { up: 50, down: 50, osc: 0 };
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

function computeAtrPct(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (closes.length < period + 1) return 0;
  const tr: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const h = highs[i]!, l = lows[i]!, cPrev = closes[i - 1]!;
    tr.push(Math.max(h - l, Math.abs(h - cPrev), Math.abs(l - cPrev)));
  }
  if (tr.length < period) return 0;
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]!) / period;
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
    detected: boolean; type: "bsl_sweep" | "ssl_sweep" | "none";
    liquidityLevel: number;
    sweepWickHigh?: number; sweepWickLow?: number;
    fvgConfirmed: boolean;
  };
  signal: "bsl_sweep_trap" | "ssl_sweep_trap" | "bearish_continuation" | "bearish_reversal" | "bullish_continuation" | "bullish_reversal" | "neutral";
}

function detectSmc(opens: number[], highs: number[], lows: number[], closes: number[]): SmcResult {
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
  const targetBsl = lastSwingHigh !== null && prevSwingHigh !== null && Math.abs(lastSwingHigh - prevSwingHigh) / lastSwingHigh <= 0.002
    ? Math.max(lastSwingHigh, prevSwingHigh) : lastSwingHigh;
  if (targetBsl !== null && targetBsl > 0) {
    for (let i = len - 1; i >= Math.max(0, len - 3); i--) {
      const candleRange = highs[i]! - lows[i]!;
      const upperWick = highs[i]! - Math.max(opens[i]!, closes[i]!);
      if (highs[i]! > targetBsl && closes[i]! < targetBsl && candleRange > 0 && upperWick / candleRange >= 0.4) {
        sweepTrap = { detected: true, type: "bsl_sweep", liquidityLevel: targetBsl, sweepWickHigh: highs[i]!, fvgConfirmed: fvgType === "bearish" || retesting };
        break;
      }
    }
  }
  const targetSsl = lastSwingLow !== null && prevSwingLow !== null && Math.abs(lastSwingLow - prevSwingLow) / lastSwingLow <= 0.002
    ? Math.min(lastSwingLow, prevSwingLow) : lastSwingLow;
  if (!sweepTrap.detected && targetSsl !== null && targetSsl > 0) {
    for (let i = len - 1; i >= Math.max(0, len - 3); i--) {
      const candleRange = highs[i]! - lows[i]!;
      const lowerWick = Math.min(opens[i]!, closes[i]!) - lows[i]!;
      if (lows[i]! < targetSsl && closes[i]! > targetSsl && candleRange > 0 && lowerWick / candleRange >= 0.4) {
        sweepTrap = { detected: true, type: "ssl_sweep", liquidityLevel: targetSsl, sweepWickLow: lows[i]!, fvgConfirmed: fvgType === "bullish" || retesting };
        break;
      }
    }
  }

  const signal: SmcResult["signal"] =
    sweepTrap.detected && sweepTrap.fvgConfirmed && sweepTrap.type === "bsl_sweep" ? "bsl_sweep_trap"
    : sweepTrap.detected && sweepTrap.fvgConfirmed && sweepTrap.type === "ssl_sweep" ? "ssl_sweep_trap"
    : bos === "bearish" && inGoldenPocket ? "bearish_continuation"
    : choch === "bearish" && (fvgType === "bearish" || retesting) ? "bearish_reversal"
    : bos === "bullish" && range > 0 && currentPrice <= lastSwingLow! + range * 0.382 ? "bullish_continuation"
    : choch === "bullish" && (fvgType === "bullish" || retesting) ? "bullish_reversal"
    : "neutral";

  return { choch, bos, fvg: { type: fvgType, top: fvgTop, bottom: fvgBottom, retesting },
    fibRetest: { inGoldenPocket, fib618, fib786, range },
    lastSwingHigh, lastSwingLow, sweepTrap, signal };
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

async function fetchIndicatorForTimeframe(coin: string, timeframe: string): Promise<Record<string, unknown> | null> {
  const symbol = binanceSymbol(coin);
  try {
    const result = await fetchCandlesUnified(coin, timeframe);
    if (!result) return null;
    const raw = result.candles;
    const opens = raw.map((r) => parseFloat(String(r[1])));
    const highs = raw.map((r) => parseFloat(String(r[2])));
    const lows = raw.map((r) => parseFloat(String(r[3])));
    const closes = raw.map((r) => parseFloat(String(r[4])));
    const volumes = raw.map((r) => parseFloat(String(r[5])));

    if (closes.length < 30 || closes.some((c) => !Number.isFinite(c))) return null;

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
        vwap, smc, atr_pct: atrPct,
        source: result.source,
      },
    };
  } catch (e) {
    console.error(`[INDICATOR_FETCH] ${symbol} ${timeframe} threw:`, e);
    return null;
  }
}

export async function collectIndicators(): Promise<number> {
  const db = await admin();
  const watchlist = await getActiveWatchlist();
  const movers = await hyperliquidTopMovers();
  const hotSymbols = await getHotWhaleSymbols();
  const coins = [...new Set([...watchlist, ...movers, ...hotSymbols])];

  if (hotSymbols.length > 0) {
    console.log(`[INDICATORS] including ${hotSymbols.length} hot-whale symbols: ${hotSymbols.slice(0, 8).join(",")}${hotSymbols.length > 8 ? ` (+${hotSymbols.length - 8} more)` : ""}`);
  }

  const tasks: { coin: string; timeframe: string }[] = [];
  for (const coin of coins) for (const tf of TIMEFRAMES) tasks.push({ coin, timeframe: tf });

  const startedAt = Date.now();
  console.log(`[INDICATORS] Starting collection for ${coins.length} coins × ${TIMEFRAMES.length} timeframes = ${tasks.length} tasks`);

  const results = await pMap(tasks, async ({ coin, timeframe }) => fetchIndicatorForTimeframe(coin, timeframe), 15);
  const rows = results.filter((r): r is Record<string, unknown> => r != null);

  console.log(`[INDICATORS] Collected ${rows.length}/${tasks.length} in ${Date.now() - startedAt}ms`);
  if (rows.length === 0) {
    console.error(`[INDICATORS] CRITICAL: 0/${tasks.length} fetches succeeded.`);
    return 0;
  }

  const { data, error } = await db.from("indicator_snapshots").upsert(rows as never, {
    onConflict: "symbol,timeframe", ignoreDuplicates: false,
  }).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Predictions ───────────── */

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

const cryptoWord = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|dogecoin|doge|cardano|ada|avalanche|avax|chainlink|link|polkadot|dot|litecoin|ltc|polygon|matic|pol|bnb|binance coin|tron|trx|shiba|shib|pepe|cosmos|atom|near protocol|aptos|apt|sui|injective|inj|arbitrum|arb|optimism|uniswap|uni|aave)\b/i;

interface PolymarketMarket { slug?: string; question?: string; outcomePrices?: string; volume24hr?: number; }
interface PolymarketEvent { markets?: PolymarketMarket[]; }

const PREDICTION_MIN_VOLUME_USD = 500;
const PREDICTION_RESOLVED_LOW = 0.05;
const PREDICTION_RESOLVED_HIGH = 0.95;
const PREDICTION_PRICE_TARGET = /(?:\$\s?\d|\b(?:all[- ]time high|ath)\b)/i;
const PREDICTION_DIRECTIONAL = /\b(?:reach|hit|above|surpass|exceed|break|all[- ]time high|ath|dip|drop|fall|below|crash|down to|under|bottom)\b/i;

function isUsablePredictionQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return PREDICTION_PRICE_TARGET.test(q) && PREDICTION_DIRECTIONAL.test(q);
}

function isUsablePredictionRow(row: Row): boolean {
  if (!row) return false;
  const yes = Number(row["yes_price"]);
  const volume = Number(row["volume_24h"]);
  const question = String(row["question"] ?? "");
  return (
    Number.isFinite(yes) &&
    yes >= PREDICTION_RESOLVED_LOW &&
    yes <= PREDICTION_RESOLVED_HIGH &&
    Number.isFinite(volume) &&
    volume >= PREDICTION_MIN_VOLUME_USD &&
    isUsablePredictionQuestion(question)
  );
}

function predictionRank(row: Row): [number, number] {
  const volume = Number(row?.["volume_24h"]);
  const createdAt = new Date(String(row?.["created_at"] ?? "")).getTime();
  return [
    Number.isFinite(volume) ? volume : 0,
    Number.isFinite(createdAt) ? createdAt : 0,
  ];
}

function eventMarkets(payload: (PolymarketEvent | PolymarketMarket)[]): PolymarketMarket[] {
  return payload.flatMap((item) => "markets" in item ? ((item as PolymarketEvent).markets ?? []) : [item as PolymarketMarket]);
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
    } catch {}
    const volume = Number(m.volume24hr);
    if (
      yes == null ||
      !Number.isFinite(yes) ||
      yes < PREDICTION_RESOLVED_LOW ||
      yes > PREDICTION_RESOLVED_HIGH ||
      !Number.isFinite(volume) ||
      volume < PREDICTION_MIN_VOLUME_USD ||
      !isUsablePredictionQuestion(question)
    ) continue;
    rows.push({
      market_slug: m.slug, question, related_symbol: symbol,
      yes_price: yes, no_price: no,
      volume_24h: volume,
      created_at: new Date().toISOString(),
      raw: m as unknown as Record<string, unknown>,
    });
  }

  if (rows.length === 0) return 0;
  const { data, error } = await db.from("prediction_snapshots").upsert(rows as never, { onConflict: "market_slug" }).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Prediction helpers ───────────── */

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

export function predictionMagnitude(prediction: Row): number {
  const yes = Number(prediction?.["yes_price"]);
  if (!Number.isFinite(yes)) return 0;
  const q = String(prediction?.["question"] ?? "").toLowerCase();
  const isBullishQ = BULLISH_QUESTION.test(q);
  const isBearishQ = BEARISH_QUESTION.test(q);
  if (!isBullishQ && !isBearishQ) return 0;
  const up = isBullishQ ? yes : 1 - yes;
  const distance = Math.abs(up - 0.5) * 2;
  if (distance < 0.2) return 0;
  return Math.min(1, (distance - 0.2) / 0.8);
}

/* ───────────── Multi-timeframe ───────────── */

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

  const label = (s: SignalDir) => s === "bullish" ? "bull" : s === "bearish" ? "bear" : "neu";
  const detail = `4h ${label(p)} · 1h ${label(f)} · 1d ${label(t)}`;

  const bullCount = [p, f, t].filter((s) => s === "bullish").length;
  const bearCount = [p, f, t].filter((s) => s === "bearish").length;
  const neuCount = [p, f, t].filter((s) => s === "neutral").length;

  if (p === "neutral") {
    return { direction: "neutral", score: 0, aligned: false, conflict: false, detail, bullCount, bearCount, neuCount };
  }

  const base = p === "bullish" ? 1.0 : -1.0;
  let multiplier = 1.0;
  if (f === p) multiplier *= 1.3; else if (f !== "neutral") multiplier *= 0.7;
  if (t === p) multiplier *= 1.3; else if (t !== "neutral") multiplier *= 0.7;

  const aligned = f === p && t === p;
  const conflict = t !== "neutral" && t !== p;

  return { direction: p, score: base * multiplier, aligned, conflict, detail, bullCount, bearCount, neuCount };
}

/* ───────────── Council fallback ───────────── */

function councilEvaluation(whale: Row, mtf: MultiTfResult, prediction: Row) {
  const votes: CouncilVerdict[] = [];
  const reasons: string[] = [];

  if (mtf.direction === "bullish" && mtf.score >= 0.7) { votes.push("BUY"); reasons.push(`quant sees bullish alignment (${mtf.detail})`); }
  else if (mtf.direction === "bearish" && mtf.score <= -0.7) { votes.push("SELL"); reasons.push(`quant sees bearish alignment (${mtf.detail})`); }
  else if (mtf.aligned) { votes.push(mtf.direction === "bullish" ? "BUY" : "SELL"); reasons.push(`quant sees aligned trend (${mtf.detail})`); }
  else { votes.push("HOLD"); reasons.push(`quant sees mixed technicals (${mtf.detail})`); }

  const flow = whale?.["direction"];
  if (flow === "accumulation") { votes.push("BUY"); reasons.push("whale tracker sees accumulation"); }
  else if (flow === "distribution") { votes.push("SELL"); reasons.push("whale tracker sees distribution"); }
  else { votes.push("HOLD"); reasons.push("whale tracker has no directional flow"); }

  const dir = predictionDirection(prediction);
  if (dir === "bullish") { votes.push("BUY"); reasons.push("sentiment leans bullish"); }
  else if (dir === "bearish") { votes.push("SELL"); reasons.push("sentiment leans bearish"); }
  else { votes.push("HOLD"); reasons.push("sentiment is inconclusive"); }

  const counts = votes.reduce<Record<string, number>>((all, v) => { all[v] = (all[v] ?? 0) + 1; return all; }, {});
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

/* ───────────── Groq ───────────── */

const AI_VERDICT_TTL_MS = 25 * 60 * 1000;
// One Groq request evaluates a whole candidate batch. Keep the batch bounded so
// the council spends tokens on breadth, not repeated single-symbol calls.
const AI_BATCH_MAX = 15;
const AI_MIN_MINUTES_BETWEEN_BATCHES_DEFAULT = 25;
const AI_MIN_MINUTES_BETWEEN_BATCHES_TRENDING = 15;
const AI_MIN_MINUTES_BETWEEN_BATCHES_CALM = 40;

function aiBatchIntervalMinutes(): number {
  if (isTrendingRegime(currentRegimeLabel)) return AI_MIN_MINUTES_BETWEEN_BATCHES_TRENDING;
  if (isCalmRegime(currentRegimeLabel)) return AI_MIN_MINUTES_BETWEEN_BATCHES_CALM;
  return AI_MIN_MINUTES_BETWEEN_BATCHES_DEFAULT;
}

function councilMaxAgeMs(): number {
  if (isTrendingRegime(currentRegimeLabel)) return COUNCIL_MAX_AGE_MS_TRENDING;
  if (isCalmRegime(currentRegimeLabel)) return COUNCIL_MAX_AGE_MS_CALM;
  return COUNCIL_MAX_AGE_MS;
}

const AI_RSI_OVERSOLD = 30;
const AI_RSI_OVERBOUGHT = 70;
const AI_WHALE_MIN_USD = 25_000;
const GROQ_TIMEOUT_MS = 15_000;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env["GROQ_MODEL"] ?? "openai/gpt-oss-20b";

interface AiCandidate {
  symbol: string; whale: Row; mtf: MultiTfResult;
  mtfRaw: MultiTfInput; prediction: Row; whaleUsd: number;
}

function qualifiesForAi(whale: Row, mtf: MultiTfResult, symbol?: string): boolean {
  const whaleUsd = typeof whale?.["usd_value"] === "number" ? (whale["usd_value"] as number) : 0;
  const floor = symbol ? whaleFloor(symbol) : AI_WHALE_MIN_USD;
  if (whaleUsd >= floor) return true;
  const rsi4h = Number((mtf as unknown as { rsi4h?: number }).rsi4h);
  if (Number.isFinite(rsi4h) && (rsi4h < AI_RSI_OVERSOLD || rsi4h > AI_RSI_OVERBOUGHT)) return true;
  if (mtf.conflict) return true;
  return false;
}

async function groqBatchCouncil(candidates: AiCandidate[]): Promise<Map<string, { final_verdict: CouncilVerdict; conviction: number; reflection: string }>> {
  const result = new Map<string, { final_verdict: CouncilVerdict; conviction: number; reflection: string }>();
  if (candidates.length === 0) return result;
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) { console.error("[GROQ] GROQ_API_KEY not set"); return result; }

  const lessonsMap = await fetchRelevantLessons(candidates.map((c) => c.symbol), 5);

  const payload = candidates.map((c) => {
    const lessons = lessonsMap.get(c.symbol) ?? [];
    const p4 = c.mtfRaw.primary, p1 = c.mtfRaw.fast, pd = c.mtfRaw.trend;
    return {
      symbol: c.symbol,
      whale_direction: c.whale?.["direction"] ?? "none",
      whale_usd: Math.round(c.whaleUsd),
      rsi_4h: typeof p4?.["rsi"] === "number" ? Math.round(p4["rsi"] as number) : null,
      rsi_1h: typeof p1?.["rsi"] === "number" ? Math.round(p1["rsi"] as number) : null,
      rsi_1d: typeof pd?.["rsi"] === "number" ? Math.round(pd["rsi"] as number) : null,
      signal_4h: p4?.["signal"] ?? "neutral",
      signal_1h: p1?.["signal"] ?? "neutral",
      signal_1d: pd?.["signal"] ?? "neutral",
      timeframe_alignment: c.mtf.aligned ? "all-aligned" : c.mtf.conflict ? "conflict" : "partial",
      price: p4?.["price"] ?? null,
      prediction_direction: predictionDirection(c.prediction),
      prediction_yes_price: c.prediction?.["yes_price"] ?? null,
      prediction_question: typeof c.prediction?.["question"] === "string"
        ? String(c.prediction["question"]).slice(0, 220)
        : null,
      whale_buy_usd: Math.round(Number(c.whale?.["buy_usd"] ?? 0)),
      whale_sell_usd: Math.round(Number(c.whale?.["sell_usd"] ?? 0)),
      whale_buy_count: Number(c.whale?.["buy_count"] ?? 0),
      whale_sell_count: Number(c.whale?.["sell_count"] ?? 0),
      vwap_4h: (() => {
        const v = (c.mtfRaw.primary?.["raw"] as Row | null | undefined)?.["vwap"];
        return typeof v === "number" ? Number(v) : null;
      })(),
      market_regime: currentRegimeLabel ?? "unknown",
      past_lessons: lessons.slice(0, 3).map((l) => `[${l.outcome}] ${String(l.lesson).slice(0, 180)}`),
    };
  });

  const systemPrompt = [
    "You are the TCC long-only trading council. You are a decision layer, not the risk engine.",
    "You receive 4h primary, 1h fast, and 1d trend data plus whale flow, prediction-market context, market regime, and prior lessons.",
    "LONG-ONLY CONTRACT: you may return BUY, HOLD, or AVOID only. Never return SELL, SHORT, leverage, or a bearish trade instruction.",
    "BUY only when there is a defensible long edge. HOLD when the evidence is mixed but not clearly unsafe. AVOID when data quality is poor, inputs conflict materially, or downside risk dominates.",
    "Do not invent missing data. Treat null/missing fields as unavailable evidence.",
    "Timeframe alignment increases conviction; conflicts reduce it.",
    "Past lessons are evidence, not guarantees. Do not blindly repeat them.",
    "Respond with ONLY the JSON array required by the schema.",
    "One object per coin, same symbol names. Conviction is 0-100 and reflects evidence quality, not certainty.",
    "Reflection must be one concise, evidence-based sentence naming the strongest support and/or blocker.",
  ].join("\n");

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(payload) },
        ],
        temperature: 0.2,
        service_tier: process.env["GROQ_SERVICE_TIER"] ?? "on_demand",
        ...( /gpt-oss/i.test(GROQ_MODEL)
          ? { reasoning_effort: "low", max_completion_tokens: 2048 }
          : { max_tokens: 2048 }
        ),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "tcc_long_only_council_batch",
            strict: true,
            schema: {
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
        },
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    const remainingTokens = res.headers.get("x-ratelimit-remaining-tokens");
    const remainingRequests = res.headers.get("x-ratelimit-remaining-requests");
    const resetTokens = res.headers.get("x-ratelimit-reset-tokens");
    if (remainingTokens || remainingRequests) {
      console.log(
        "[GROQ_LIMITS] remaining_tokens=" + (remainingTokens ?? "?") +
        " remaining_rpd=" + (remainingRequests ?? "?") +
        " reset_tokens=" + (resetTokens ?? "?"),
      );
    }
    if (!res.ok) {
      const retryAfter = res.headers.get("retry-after");
      if (res.status === 429) {
        throw new Error("Groq HTTP 429 rate-limited; retry-after=" + (retryAfter ?? "unknown"));
      }
      throw new Error("Groq HTTP " + res.status);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const cachedTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const totalTokens = data.usage?.total_tokens ?? 0;
    console.log(
      `[GROQ_USAGE] prompt=${promptTokens} cached=${cachedTokens} completion=${completionTokens} total=${totalTokens} cache_hit_pct=${promptTokens > 0 ? ((cachedTokens / promptTokens) * 100).toFixed(1) : "0.0"}`,
    );
    const finishReason = data.choices?.[0]?.finish_reason;
    const content = data.choices?.[0]?.message?.content ?? "";
    if (finishReason === "length") {
      console.warn(`[GROQ] finish_reason=length, reasoning_tokens=${data.usage?.completion_tokens_details?.reasoning_tokens ?? 0}`);
    }
    if (!content) throw new Error("Empty Groq response");
    const clean = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as { symbol: string; verdict: string; conviction: number; reflection?: string }[];
    if (!Array.isArray(parsed)) throw new Error("Groq response is not an array");
    for (const item of parsed) {
      const verdict = String(item.verdict ?? "").toUpperCase();
      if (!["BUY", "HOLD", "AVOID"].includes(verdict)) continue;
      if (!candidates.some((c) => c.symbol === item.symbol)) continue;
      result.set(item.symbol, {
        final_verdict: verdict as CouncilVerdict,
        conviction: Math.max(0, Math.min(100, Number(item.conviction) || 0)),
        reflection: item.reflection ?? "Groq AI verdict.",
      });
    }
    console.log(`[GROQ] model=${GROQ_MODEL} council batch: ${result.size}/${candidates.length} verdicts received`);
  } catch (e) {
    console.error(`[GROQ] batch failed`, e);
  }
  return result;
}

export async function collectCouncilSignals(): Promise<number> {
  const db = await admin();
  const rows: Record<string, unknown>[] = [];
  const watchlist = await getActiveWatchlist();
  const hotSymbols = await getHotWhaleSymbols();
  const movers = await hyperliquidTopMovers();
  const symbols = [...new Set([...watchlist, ...hotSymbols, ...movers])];
  if (symbols.length === 0) return 0;

  const binSymbols = symbols.map(binanceSymbol);
  const sixHoursAgo = new Date(Date.now() - WHALE_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const aiCacheSince = new Date(Date.now() - AI_VERDICT_TTL_MS).toISOString();

  const [whalesRes, indicatorsRes, predictionsRes, freshAiRes, lastAiRes] = await Promise.all([
    db.from("whale_alerts").select("*").in("symbol", symbols).gte("created_at", sixHoursAgo).order("usd_value", { ascending: false }).limit(2000),
    db.from("indicator_snapshots").select("*").in("symbol", binSymbols).order("created_at", { ascending: false }).limit(5000),
    db.from("prediction_snapshots").select("*").in("related_symbol", symbols).order("created_at", { ascending: false }).limit(1000),
    db.from("council_signals").select("symbol, source_created_at").eq("depth", "ai-batch").in("symbol", symbols).gte("source_created_at", aiCacheSince),
    db.from("council_signals").select("source_created_at").eq("depth", "ai-batch").order("source_created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const whalesBySymbol = new Map<string, Record<string, unknown>[]>();
  for (const w of (whalesRes.data ?? []) as Record<string, unknown>[]) {
    const s = w["symbol"] as string;
    const b = whalesBySymbol.get(s);
    if (!b) whalesBySymbol.set(s, [w]);
    else if (b.length < 20) b.push(w);
  }

  const indicatorByTf = new Map<string, Record<string, unknown>>();
  for (const i of (indicatorsRes.data ?? []) as Record<string, unknown>[]) {
    const s = i["symbol"] as string;
    const tf = i["timeframe"] as string;
    const k = `${s}:${tf}`;
    if (!indicatorByTf.has(k)) indicatorByTf.set(k, i);
  }

  const latestPrediction = new Map<string, Record<string, unknown>>();
  for (const p of (predictionsRes.data ?? []) as Record<string, unknown>[]) {
    const s = p["related_symbol"] as string | undefined;
    if (!s || !isUsablePredictionRow(p as Row)) continue;
    const current = latestPrediction.get(s);
    if (!current) {
      latestPrediction.set(s, p);
      continue;
    }
    const [currentVolume, currentCreated] = predictionRank(current as Row);
    const [nextVolume, nextCreated] = predictionRank(p as Row);
    if (nextVolume > currentVolume || (nextVolume === currentVolume && nextCreated > currentCreated)) {
      latestPrediction.set(s, p);
    }
  }

  const freshnessNow = Date.now();
  for (const [k, row] of indicatorByTf) {
    if (!isFreshRow(row, "created_at", INDICATOR_MAX_AGE_MS, freshnessNow)) indicatorByTf.delete(k);
  }
  for (const [s, row] of latestPrediction) {
    if (!isFreshRow(row, "created_at", PREDICTION_MAX_AGE_MS, freshnessNow)) latestPrediction.delete(s);
  }

  const freshAiSymbols = new Set(((freshAiRes.data ?? []) as { symbol: string }[]).map((r) => r.symbol));
  const lastAiAt = lastAiRes.data?.source_created_at ? new Date(lastAiRes.data.source_created_at).getTime() : 0;
  const minutesSinceLastAi = lastAiAt > 0 ? (Date.now() - lastAiAt) / 60_000 : Infinity;
  const aiMinMinutes = aiBatchIntervalMinutes();
  const aiAllowed = minutesSinceLastAi >= aiMinMinutes;

  const perSymbol = new Map<string, { whale: Row; mtf: MultiTfResult; mtfRaw: MultiTfInput; prediction: Row }>();
  const aiCandidates: AiCandidate[] = [];

  for (const symbol of symbols) {
    const whaleRows = whalesBySymbol.get(symbol) ?? [];
    const buyUsd = whaleRows.filter((r) => r["direction"] === "accumulation").reduce((s, r) => s + Number(r["usd_value"] ?? 0), 0);
    const sellUsd = whaleRows.filter((r) => r["direction"] === "distribution").reduce((s, r) => s + Number(r["usd_value"] ?? 0), 0);
    const whaleUsdTotal = buyUsd + sellUsd;
    let whaleDirection: "accumulation" | "distribution" | undefined;
    if (buyUsd > sellUsd * 1.15) whaleDirection = "accumulation";
    else if (sellUsd > buyUsd * 1.15) whaleDirection = "distribution";
    const whale = whaleRows.length ? ({
      direction: whaleDirection, id: whaleRows[0]?.["id"],
      usd_value: whaleUsdTotal, buy_usd: buyUsd, sell_usd: sellUsd,
      buy_count: whaleRows.filter((r) => r["direction"] === "accumulation").length,
      sell_count: whaleRows.filter((r) => r["direction"] === "distribution").length,
    } as Row) : null;

    const binSym = binanceSymbol(symbol);
    const mtfRaw: MultiTfInput = {
      primary: (indicatorByTf.get(`${binSym}:${PRIMARY_TIMEFRAME}`) ?? null) as Row,
      fast: (indicatorByTf.get(`${binSym}:${FAST_TIMEFRAME}`) ?? null) as Row,
      trend: (indicatorByTf.get(`${binSym}:${TREND_TIMEFRAME}`) ?? null) as Row,
    };
    const mtf = evaluateMultiTimeframe(mtfRaw);
    const prediction = (latestPrediction.get(symbol) ?? null) as Row;

    if (!whale && !mtfRaw.primary && !prediction) continue;
    perSymbol.set(symbol, { whale, mtf, mtfRaw, prediction });

    const rsi4hRaw = mtfRaw.primary?.["rsi"];
    if (typeof rsi4hRaw === "number") (mtf as unknown as Record<string, unknown>)["rsi4h"] = rsi4hRaw;

    if (!freshAiSymbols.has(symbol) && qualifiesForAi(whale, mtf, symbol)) {
      aiCandidates.push({ symbol, whale, mtf, mtfRaw, prediction, whaleUsd: whaleUsdTotal });
    }
  }

  let aiResults = new Map<string, { final_verdict: CouncilVerdict; conviction: number; reflection: string }>();
  if (aiAllowed) {
    aiCandidates.sort((a, b) => b.whaleUsd - a.whaleUsd);
    const aiBatch = aiCandidates.slice(0, AI_BATCH_MAX);
    console.log(`[GROQ] Batch allowed — regime=${currentRegimeLabel ?? "unknown"} interval=${aiMinMinutes}min candidates=${aiBatch.length}/${aiCandidates.length}`);
    aiResults = await groqBatchCouncil(aiBatch);
  } else {
    console.log(`[GROQ] Rate guard: skipping — ${minutesSinceLastAi.toFixed(1)}min since last (min ${aiMinMinutes}min)`);
  }

  for (const [symbol, ctx] of perSymbol) {
    if (freshAiSymbols.has(symbol)) continue;
    const aiResult = aiResults.get(symbol);
    const usedAi = !!aiResult;
  let result = aiResult ?? councilEvaluation(ctx.whale, ctx.mtf, ctx.prediction);

  // TCC is Spot/long-only. The legacy deterministic synthesizer still knows
  // about SELL for historical compatibility, but a native council signal must
  // never become a short instruction or a negative council vote in production.
  if (result.final_verdict === "SELL") {
    result = {
      ...result,
      final_verdict: "HOLD",
      reflection: result.reflection + " [LONG_ONLY: SELL suppressed -> HOLD]",
    };
  }

  const assetMicroRegime = computeAssetRegime(ctx.mtfRaw.primary);
  if (result.final_verdict === "SELL" && (assetMicroRegime.regime === "bull" || assetMicroRegime.regime === "strong_bull")) {
    result = {
      ...result,
      final_verdict: "HOLD",
      reflection: `${result.reflection} [ASSET_REGIME_FILTER: Short blocked due to ${assetMicroRegime.regime} on 4h]`,
    };
  } else if (result.final_verdict === "BUY" && (assetMicroRegime.regime === "bear" || assetMicroRegime.regime === "strong_bear")) {
    result = {
      ...result,
      final_verdict: "HOLD",
      reflection: `${result.reflection} [ASSET_REGIME_FILTER: Long blocked due to ${assetMicroRegime.regime} on 4h]`,
    };
  }
  const sourceId = [symbol, ctx.whale?.["id"], ctx.mtfRaw.primary?.["id"], ctx.prediction?.["id"], usedAi ? "ai" : "rule", result.final_verdict, String(Math.round(Number(result.conviction) || 0))].join(":");
    const inputSourceTimes = [
      ctx.whale?.["created_at"],
      ctx.mtfRaw.primary?.["created_at"],
      ctx.mtfRaw.fast?.["created_at"],
      ctx.mtfRaw.trend?.["created_at"],
      ctx.prediction?.["created_at"],
    ]
      .map((value) => new Date(String(value ?? "")).getTime())
      .filter((value) => Number.isFinite(value));

    // AI-batch is genuinely generated now. Deterministic synthesis is only as fresh
    // as its oldest input, so its source_created_at must not pretend to be "now".
    const sourceCreatedAt = usedAi
      ? new Date().toISOString()
      : inputSourceTimes.length > 0
        ? new Date(Math.min(...inputSourceTimes)).toISOString()
        : new Date().toISOString();

    rows.push({
      symbol, source_id: sourceId,
      final_verdict: result.final_verdict,
      conviction: result.conviction,
      price_at: typeof ctx.mtfRaw.primary?.["price"] === "number" ? ctx.mtfRaw.primary["price"] : null,
      reflection: result.reflection,
      depth: usedAi ? "ai-batch" : "ai-synthesis",
      source_created_at: sourceCreatedAt,
    });
  }

  if (rows.length === 0) return 0;
  const { data, error } = await db.from("council_signals").upsert(rows as never, { onConflict: "source_id" }).select("id");
  if (error) throw error;
  return data?.length ?? 0;
}
/* ───────────── Signal combiner ───────────── */

const COMPOSITE_AI_BASE_WEIGHT = 0.75;

function compositeMaxScore(w: StrategyConfig): number {
  return (
    w.whale_weight * 1.0 +
    w.technicals_weight * 1.69 +
    w.prediction_weight * 0.5 +
    w.council_weight * COMPOSITE_AI_BASE_WEIGHT
  );
}

type AssetMicroRegime = "strong_bull" | "bull" | "sideways" | "bear" | "strong_bear" | "neutral" | "unknown";

interface SidewaysMeanReversionDecision {
  eligible: boolean;
  rangePosition: number | null;
  rsi: number | null;
  vwap: number | null;
  reason: string;
}

function evaluateSidewaysMeanReversion(primary: Row, side: "buy" | "sell"): SidewaysMeanReversionDecision {
  const price = Number(primary?.["price"]);
  const upper = Number(primary?.["bb_upper"]);
  const lower = Number(primary?.["bb_lower"]);
  const rsi = Number(primary?.["rsi"]);
  const raw = primary?.["raw"] as Row;
  const rawVwap = Number(raw?.["vwap"]);
  const directVwap = Number(primary?.["vwap"]);
  const vwap = Number.isFinite(rawVwap) && rawVwap > 0 ? rawVwap : Number.isFinite(directVwap) && directVwap > 0 ? directVwap : null;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(upper) || !Number.isFinite(lower) || upper <= lower) return { eligible: false, rangePosition: null, rsi: Number.isFinite(rsi) ? rsi : null, vwap, reason: "missing/invalid Bollinger range" };
  const rangePosition = (price - lower) / (upper - lower);
  if (!Number.isFinite(rangePosition)) return { eligible: false, rangePosition: null, rsi: Number.isFinite(rsi) ? rsi : null, vwap, reason: "invalid range position" };
  if (!Number.isFinite(rsi)) return { eligible: false, rangePosition, rsi: null, vwap, reason: "RSI unavailable" };
  const eligible = side === "buy" ? rangePosition <= 0.25 && rsi <= 40 : rangePosition >= 0.75 && rsi >= 60;
  const reason = side === "buy"
    ? eligible ? `sideways mean-reversion BUY: range ${(rangePosition * 100).toFixed(0)}%, RSI ${rsi.toFixed(1)}` : rangePosition > 0.25 ? `BUY blocked: range position ${(rangePosition * 100).toFixed(0)}% > lower 25%` : `BUY blocked: RSI ${rsi.toFixed(1)} is not sufficiently oversold`
    : eligible ? `sideways mean-reversion SELL: range ${(rangePosition * 100).toFixed(0)}%, RSI ${rsi.toFixed(1)}` : rangePosition < 0.75 ? `SELL blocked: range position ${(rangePosition * 100).toFixed(0)}% < upper 25%` : `SELL blocked: RSI ${rsi.toFixed(1)} is not sufficiently overbought`;
  return { eligible, rangePosition, rsi, vwap, reason };
}

function effectiveWhaleWeight(baseWeight: number, assetRegime?: AssetMicroRegime): number {
  return assetRegime === "sideways" ? baseWeight * 0.5 : baseWeight;
}

export function ruleBased(
  whale: Row, mtf: MultiTfResult, prediction: Row, council: Row,
  weights: StrategyConfig,
  options?: {
    conflictFixEnabled?: boolean;
    mtfGateConfig?: MtfGateConfig;
    sessionConfig?: MarketSessionConfig;
    symbol?: string;
    hotWhaleAggregate?: HotWhaleAggregate | null;
    assetRegime?: AssetMicroRegime;
  },
) {
  let score = 0;
  const reasons: string[] = [];
  let aiAvoid = false;

  const predDir = predictionDirection(prediction);
  const conflict = detectHardConflict(whale, mtf.direction, predDir);

  const whaleWeight = effectiveWhaleWeight(weights.whale_weight, options?.assetRegime);
  if (whale?.["direction"] === "accumulation") {
    score += whaleWeight;
    reasons.push(`whale accumulation ×${whaleWeight.toFixed(1)}${options?.assetRegime === "sideways" ? " [sideways discounted]" : ""}`);
  } else if (whale?.["direction"] === "distribution") {
    score -= whaleWeight;
    reasons.push(`whale distribution ×${whaleWeight.toFixed(1)}${options?.assetRegime === "sideways" ? " [sideways discounted]" : ""}`);
  }

  if (mtf.score !== 0) {
    const weighted = mtf.score * weights.technicals_weight;
    score += weighted;
    const dir = weighted > 0 ? "bullish" : "bearish";
    reasons.push(`${dir} technicals (${mtf.detail}${mtf.aligned ? " · aligned" : mtf.conflict ? " · conflict" : ""}) ×${weights.technicals_weight.toFixed(1)}`);
  }

  if (predDir === "bullish") {
    const mag = predictionMagnitude(prediction);
    score += 0.5 * weights.prediction_weight * mag;
    reasons.push(`prediction market bullish ×${weights.prediction_weight.toFixed(1)} (mag ${(mag * 100).toFixed(0)}%)`);
  } else if (predDir === "bearish") {
    const mag = predictionMagnitude(prediction);
    score -= 0.5 * weights.prediction_weight * mag;
    reasons.push(`prediction market bearish ×${weights.prediction_weight.toFixed(1)} (mag ${(mag * 100).toFixed(0)}%)`);
  }

  if (council?.["final_verdict"]) {
    const convictionRaw = Number(council["conviction"]);
    const conviction = Number.isFinite(convictionRaw) ? Math.max(0, Math.min(100, convictionRaw)) : 50;
    const weight = (conviction / 100) * COMPOSITE_AI_BASE_WEIGHT * weights.council_weight;
    const verdict = String(council["final_verdict"]).toUpperCase();
    if (verdict === "BUY") {
      score += weight;
      reasons.push(`council: BUY (${Math.round(conviction)}%) ×${weights.council_weight.toFixed(1)}`);
    } else if (verdict === "SELL") {
      score -= weight;
      reasons.push(`council: SELL (${Math.round(conviction)}%) ×${weights.council_weight.toFixed(1)}`);
    } else if (verdict === "AVOID") {
      aiAvoid = conviction >= 60;
      reasons.push(`council: AVOID (${Math.round(conviction)}%)`);
    } else {
      reasons.push(`council: HOLD`);
    }
  }

  if (options?.sessionConfig?.enabled) {
    const sessionInfo = classifyMarketSession(new Date());
    const bonus = getSessionBonus(sessionInfo.session, options.sessionConfig);
    if (bonus !== 0) {
      score += bonus;
      const sign = bonus > 0 ? "+" : "";
      reasons.push(`session: ${sessionLabel(sessionInfo.session)} (${sign}${bonus.toFixed(2)})`);
    }
  }

  // ─── Hot-whale conviction boost ───
  const hotAgg = options?.hotWhaleAggregate;
  if (qualifiesForConvictionBoost(hotAgg) && hotAgg) {
    const boost = convictionBoostMagnitude(hotAgg);
    const sign = hotAgg.direction === "accumulation" ? 1 : -1;
    score += sign * boost;
    reasons.push(
      `hot-whale boost ${sign > 0 ? "+" : "-"}${boost.toFixed(2)} ` +
        `(buy_ratio ${(hotAgg.buy_ratio * 100).toFixed(0)}%, ` +
        `samples ${hotAgg.alert_count}, ` +
        `conf ${(hotAgg.confidence * 100).toFixed(0)}%)`,
    );
  }

  const buyThreshold = 2.2;
  const sellThreshold = -2.2;
  const holdThreshold = 0.5;

  let recommendation: "buy" | "sell" | "hold" | "watch" = "hold";
  let mtfGateDecision: ReturnType<typeof checkMtfGate> | null = null;

  if (conflict.hardConflict && options?.conflictFixEnabled) {
    recommendation = "hold";
    reasons.push(`hard conflict (whale=${conflict.whaleDir}, pred=${conflict.predDir}, no technicals) → hold`);
  } else {
    if (score >= buyThreshold) recommendation = "buy";
    else if (score <= sellThreshold) recommendation = "sell";
    else if (Math.abs(score) < holdThreshold) recommendation = "hold";
    else recommendation = "watch";

    if (aiAvoid) recommendation = "watch";
  }

  if (options?.mtfGateConfig && (recommendation === "buy" || recommendation === "sell")) {
    const mtfCounts: MtfCounts = {
      bullCount: mtf.bullCount,
      bearCount: mtf.bearCount,
      neuCount: mtf.neuCount,
    };
    mtfGateDecision = checkMtfGate(recommendation, mtfCounts, options.mtfGateConfig);

    if (!mtfGateDecision.passed) {
      if (options.mtfGateConfig.enabled) {
        reasons.push(`MTF gate REJECTED: ${mtfGateDecision.rejectReason}`);
        recommendation = "hold";
      } else if (options.mtfGateConfig.shadow_mode) {
        reasons.push(`MTF gate SHADOW (would reject): ${mtfGateDecision.rejectReason}`);
      }
    }
  }

  const max = compositeMaxScore(weights);
  const confidence = max > 0 ? Math.min(1, Math.abs(score) / max) : 0;

  return {
    recommendation, confidence, score,
    reasoning: reasons.length > 0 ? reasons.join("; ") : "insufficient signal",
    mtfGateDecision,
  };
}

async function runShadowV2Observer(variantRows: Record<string, unknown>[]): Promise<void> {
  try {
    const db = await admin();

    const buySignals = variantRows
      .filter((row) => String(row["recommendation"] ?? "").toLowerCase() === "buy")
      .map((row) => ({
        id: typeof row["id"] === "string" ? String(row["id"]) : null,
        symbol: String(row["symbol"] ?? "").toUpperCase(),
        strategy: String(row["strategy_name"] ?? "unknown"),
        recommendation: "buy",
        confidence: Number(row["confidence"] ?? 0),
        created_at: String(row["created_at"] ?? ""),
        entry_price: Number(row["entry_price"] ?? 0),
      }))
      .filter((row) =>
        row.symbol &&
        Number.isFinite(row.entry_price) &&
        row.entry_price > 0 &&
        Number.isFinite(new Date(row.created_at).getTime()),
      );

    const { data: existingRows, error: existingError } = await db
      .from("shadow_v2_positions" as never)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5000);

    if (existingError) throw existingError;

    // DB uses snake_case; convert explicitly to the Shadow V2 domain shape.
    // Never cast raw database rows directly to ShadowV2Position.
    const existing = ((existingRows ?? []) as unknown as Record<string, unknown>[]).map(
      (row): ShadowV2Position => ({
        fingerprint: String(row["fingerprint"]),
        signalId: row["signal_id"] ? String(row["signal_id"]) : null,
        symbol: String(row["symbol"]),
        strategy: String(row["strategy"]),
        signalCreatedAt: String(row["signal_created_at"]),
        entryTimestamp: String(row["entry_timestamp"]),
        entryPrice: Number(row["entry_price"]),
        takeProfitPrice: Number(row["take_profit_price"]),
        stopLossPrice: Number(row["stop_loss_price"]),
        expiryTimestamp: String(row["expiry_timestamp"]),
        status: String(row["status"]).toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
        exitTimestamp: row["exit_timestamp"] ? String(row["exit_timestamp"]) : null,
        exitPrice: row["exit_price"] == null ? null : Number(row["exit_price"]),
        exitReason: (() => {
          const reason = String(row["exit_reason"] ?? "");
          return reason === "TP" || reason === "SL" || reason === "EXPIRED"
            ? (reason as ShadowV2Position["exitReason"])
            : null;
        })(),
        grossPnlUsd: Number(row["gross_pnl_usd"] ?? 0),
        entryFeeUsd: Number(row["entry_fee_usd"] ?? 0),
        exitFeeUsd: Number(row["exit_fee_usd"] ?? 0),
        feesUsd: Number(row["fees_usd"] ?? 0),
        netPnlUsd: Number(row["net_pnl_usd"] ?? 0),
        grossPnlPct: Number(row["gross_pnl_pct"] ?? 0),
        feesPct: Number(row["fees_pct"] ?? 0),
        netPnlPct: Number(row["net_pnl_pct"] ?? 0),
        ambiguousIntrabar: Boolean(row["ambiguous_intrabar"]),
        ambiguityReason: row["ambiguity_reason"] ? String(row["ambiguity_reason"]) : null,
        details: (row["details"] ?? {}) as ShadowV2Position["details"],
      }),
    );

    const active = existing.filter((row) => row.status === "OPEN");
    const processedFingerprints = new Set(existing.map((row) => row.fingerprint));

    const latestExitBySymbol = new Map<string, string>();
    for (const row of existing) {
      if (row.status !== "CLOSED" || !row.exitTimestamp) continue;
      const key = row.symbol.toUpperCase();
      const prev = latestExitBySymbol.get(key);
      if (!prev || new Date(row.exitTimestamp).getTime() > new Date(prev).getTime()) {
        latestExitBySymbol.set(key, row.exitTimestamp);
      }
    }

    // Deterministic ordering: strongest BUY first, then strategy name.
    buySignals.sort((a, b) =>
      b.confidence - a.confidence ||
      a.symbol.localeCompare(b.symbol) ||
      a.strategy.localeCompare(b.strategy),
    );

    const auditRows: Record<string, unknown>[] = [];
    const openRows: Record<string, unknown>[] = [];

    for (const row of buySignals) {
      const signal: ShadowV2Signal = {
        id: row.id,
        symbol: row.symbol,
        strategy: row.strategy,
        recommendation: "buy",
        confidence: row.confidence,
        created_at: row.created_at,
      };
      const fingerprint = getShadowV2Fingerprint(signal);

      if (processedFingerprints.has(fingerprint)) continue;

      const decision = getShadowV2Decision({
        signal,
        activePositions: active,
        processedFingerprints,
        lastExitTimestamp: latestExitBySymbol.get(row.symbol) ?? null,
        mode: "DEDUPLICATED",
      });

      auditRows.push({
        fingerprint,
        signal_id: row.id,
        symbol: row.symbol,
        strategy: row.strategy,
        decision: decision.accepted ? "OPEN" : "SUPPRESSED",
        reason: decision.reason,
        details: {
          confidence: row.confidence,
          entry_price: row.entry_price,
          execution_policy: "one_active_long_per_symbol",
        },
      });

      if (!decision.accepted) continue;

      const position = buildShadowV2OpenPosition({
        signal,
        fingerprint,
        entryPrice: row.entry_price,
        entryPriceSource: "provided_entry_price",
        mode: "DEDUPLICATED",
      });

      openRows.push({
        fingerprint: position.fingerprint,
        signal_id: position.signalId,
        symbol: position.symbol,
        strategy: position.strategy,
        signal_created_at: position.signalCreatedAt,
        entry_timestamp: position.entryTimestamp,
        entry_price: position.entryPrice,
        take_profit_price: position.takeProfitPrice,
        stop_loss_price: position.stopLossPrice,
        expiry_timestamp: position.expiryTimestamp,
        status: position.status,
        exit_timestamp: position.exitTimestamp,
        exit_price: position.exitPrice,
        exit_reason: position.exitReason,
        gross_pnl_usd: position.grossPnlUsd,
        entry_fee_usd: position.entryFeeUsd,
        exit_fee_usd: position.exitFeeUsd,
        fees_usd: position.feesUsd,
        net_pnl_usd: position.netPnlUsd,
        gross_pnl_pct: position.grossPnlPct,
        fees_pct: position.feesPct,
        net_pnl_pct: position.netPnlPct,
        ambiguous_intrabar: position.ambiguousIntrabar,
        ambiguity_reason: position.ambiguityReason,
        performance_mode: position.details.performance_mode,
        details: position.details,
      });

      // Reserve the symbol immediately so another preset cannot open a second LONG.
      active.push(position);
      processedFingerprints.add(fingerprint);
    }

    if (openRows.length > 0) {
      const { error } = await db
        .from("shadow_v2_positions" as never)
        .insert(openRows as never);
      if (error) throw error;
    }

    if (auditRows.length > 0) {
      const { error } = await db
        .from("shadow_v2_audit" as never)
        .insert(auditRows as never);
      if (error) throw error;
    }

    // Resolve existing OPEN positions independently of the main execution path.
    const positionsToResolve = active.filter((row) => {
      const age = Date.now() - new Date(row.entryTimestamp).getTime();
      return Number.isFinite(age) && age >= 0;
    });

    let resolved = 0;
    for (const position of positionsToResolve) {
      const candles = await fetchVariantResolutionCandles(
        position.symbol,
        VARIANT_RESOLVE_TIMEFRAME,
        new Date(position.entryTimestamp).getTime(),
        Math.min(Date.now(), new Date(position.expiryTimestamp).getTime()),
        VARIANT_RESOLVE_CANDLE_LIMIT,
      );
      if (candles.length === 0) continue;

      let closed: ShadowV2Position | null = null;
      const expiryMs = new Date(position.expiryTimestamp).getTime();

      for (const candle of candles) {
        if (candle.closeTimeMs > expiryMs) break;

        const hit = resolveShadowV2Candle({
          high: candle.high,
          low: candle.low,
          takeProfitPrice: position.takeProfitPrice,
          stopLossPrice: position.stopLossPrice,
        });
        if (!hit) continue;

        closed = buildShadowV2ClosedPosition({
          position,
          exitTimestamp: new Date(candle.closeTimeMs).toISOString(),
          exitPrice: hit.price,
          exitReason: hit.reason,
          ambiguousIntrabar: hit.ambiguousIntrabar,
          ambiguityReason: hit.ambiguityReason,
        });
        break;
      }

      if (!closed && Date.now() >= expiryMs) {
        let expiryCandle: VariantCandle | null = null;
        for (const candle of candles) {
          if (candle.closeTimeMs <= expiryMs) {
            if (!expiryCandle || candle.closeTimeMs > expiryCandle.closeTimeMs) {
              expiryCandle = candle;
            }
          }
        }

        // Never fabricate an expiry price. Keep OPEN until historical data exists.
        if (expiryCandle) {
          closed = buildShadowV2ClosedPosition({
            position,
            exitTimestamp: new Date(expiryCandle.closeTimeMs).toISOString(),
            exitPrice: expiryCandle.close,
            exitReason: "EXPIRED",
          });
        }
      }

      if (!closed) continue;

      const { error } = await db
        .from("shadow_v2_positions" as never)
        .update({
          status: closed.status,
          exit_timestamp: closed.exitTimestamp,
          exit_price: closed.exitPrice,
          exit_reason: closed.exitReason,
          gross_pnl_usd: closed.grossPnlUsd,
          entry_fee_usd: closed.entryFeeUsd,
          exit_fee_usd: closed.exitFeeUsd,
          fees_usd: closed.feesUsd,
          net_pnl_usd: closed.netPnlUsd,
          gross_pnl_pct: closed.grossPnlPct,
          fees_pct: closed.feesPct,
          net_pnl_pct: closed.netPnlPct,
          ambiguous_intrabar: closed.ambiguousIntrabar,
          ambiguity_reason: closed.ambiguityReason,
          details: closed.details,
        } as never)
        .eq("fingerprint", closed.fingerprint);

      if (error) throw error;
      resolved += 1;
    }

    if (openRows.length || auditRows.length || resolved) {
      console.log(
        `[SHADOW_V2] opened=${openRows.length} audited=${auditRows.length} resolved=${resolved}`,
      );
    }
  } catch (error) {
    // Shadow is strictly observational: never block the normal pipeline.
    console.error("[SHADOW_V2] observer failed (isolated):", error);
  }
}

function signalFingerprint(
  symbol: string, whale: Row, mtf: MultiTfResult, mtfRaw: MultiTfInput,
  prediction: Row, council: Row, weights: StrategyConfig,
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
    symbol, normalize(whale?.["direction"]), normalize(whale?.["buy_usd"]),
    normalize(whale?.["sell_usd"]), normalize(whale?.["usd_value"]),
    round2(mtfRaw.primary?.["rsi"]), round2(mtfRaw.fast?.["rsi"]), round2(mtfRaw.trend?.["rsi"]),
    normalize(mtfRaw.primary?.["signal"]), normalize(mtfRaw.fast?.["signal"]), normalize(mtfRaw.trend?.["signal"]),
    round2(mtf.score),
    normalize(prediction?.["market_slug"]), normalize(prediction?.["yes_price"]), normalize(prediction?.["no_price"]),
    normalize(council?.["final_verdict"]), normalize(council?.["conviction"]),
    `strat:${weights.whale_weight.toFixed(1)},${weights.technicals_weight.toFixed(1)},${weights.prediction_weight.toFixed(1)},${weights.council_weight.toFixed(1)}`,
    result.recommendation, result.confidence.toFixed(4),
  ].join("|");
}

export async function combineSignals(): Promise<number> {
  const db = await admin();
  const weights = await fetchStrategy();
  const cleanupCfg = await fetchCleanupConfig();
  const conflictFixEnabled = cleanupCfg.watch_conflict_fix.enabled;
  const conflictShadowMode = cleanupCfg.watch_conflict_fix.shadow_mode;
  const mtfGateConfig = cleanupCfg.mtf_confirmation_gate;
  const vwapGate = cleanupCfg.vwap_regime_gate;
  const sessionConfig = cleanupCfg.market_session_fix;
  const nowSession = classifyMarketSession(new Date());
  console.log(`[MARKET_SESSION] ${sessionLabel(nowSession.session)} utc_hour=${nowSession.utcHour}${nowSession.isWeekend ? " WEEKEND" : ""}`);

  const watchlistCtx = await getActiveWatchlistContext();
  const hotSymbols = await getHotWhaleSymbols();
  const hotWhaleBatch = await getHotWhaleBatch();
  const hotSymbolSet = new Set(hotSymbols);
  const { data: councilRows } = await db.from("council_signals").select("symbol");
  const symbols = [...new Set([
    ...watchlistCtx.symbols,
    ...hotSymbols,
    ...((councilRows ?? []) as { symbol: string }[]).map((r) => r.symbol),
  ])];
  if (symbols.length === 0) return 0;
  if (hotSymbols.length > 0) {
    console.log(`[HOT_WHALE_INCLUDE] added ${hotSymbols.length} hot symbols to signals: ${hotSymbols.slice(0, 10).join(",")}${hotSymbols.length > 10 ? ` (+${hotSymbols.length - 10} more)` : ""}`);
  }

  const binSymbols = symbols.map(binanceSymbol);
  const whaleSince = new Date(Date.now() - WHALE_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const [whalesRes, indicatorsRes, predictionsRes, councilsRes] = await Promise.all([
    db.from("whale_alerts").select("*").in("symbol", symbols).gte("created_at", whaleSince).order("created_at", { ascending: false }).limit(3000),
    db.from("indicator_snapshots").select("*").in("symbol", binSymbols).order("created_at", { ascending: false }).limit(5000),
    db.from("prediction_snapshots").select("*").in("related_symbol", symbols).order("created_at", { ascending: false }).limit(1000),
    db.from("council_signals").select("*").in("symbol", symbols).order("source_created_at", { ascending: false }).limit(1000),
  ]);

  const regime = computeRegimeSnapshot({
    whales: (whalesRes.data ?? []) as Record<string, unknown>[],
    indicators: (indicatorsRes.data ?? []) as Record<string, unknown>[],
    predictions: (predictionsRes.data ?? []) as Record<string, unknown>[],
    councils: (councilsRes.data ?? []) as Record<string, unknown>[],
  });
  currentRegimeLabel = regime.label;
  console.log(
    `[REGIME] label=${regime.label} score=${regime.score.toFixed(3)} ` +
      `whale_net=${(regime.whaleNet * 100).toFixed(0)}% ` +
      `tech_breadth=${(regime.techBreadth * 100).toFixed(0)}% ` +
      `pred_consensus=${(regime.predConsensus * 100).toFixed(0)}% ` +
      `council_consensus=${(regime.councilConsensus * 100).toFixed(0)}%`,
  );

  const whaleBySymbol = new Map<string, Record<string, unknown>[]>();
  for (const w of (whalesRes.data ?? []) as Record<string, unknown>[]) {
    const s = w["symbol"] as string;
    const b = whaleBySymbol.get(s);
    if (!b) whaleBySymbol.set(s, [w]);
    else if (b.length < 20) b.push(w);
  }

  const indicatorByTf = new Map<string, Record<string, unknown>>();
  for (const i of (indicatorsRes.data ?? []) as Record<string, unknown>[]) {
    const s = i["symbol"] as string;
    const tf = i["timeframe"] as string;
    const k = `${s}:${tf}`;
    if (!indicatorByTf.has(k)) indicatorByTf.set(k, i);
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
    if (!isFreshRow(row, "created_at", INDICATOR_MAX_AGE_MS, freshnessNow)) indicatorByTf.delete(k);
  }
  for (const [s, row] of latestPrediction) {
    if (!isFreshRow(row, "created_at", PREDICTION_MAX_AGE_MS, freshnessNow)) latestPrediction.delete(s);
  }

  const councilTtlMs = councilMaxAgeMs();
  console.log(`[COUNCIL_TTL] regime=${currentRegimeLabel ?? "unknown"} ttl=${(councilTtlMs / 60_000).toFixed(0)}min`);
  for (const [s, row] of latestCouncil) {
    if (!isFreshRow(row, "source_created_at", councilTtlMs, freshnessNow)) latestCouncil.delete(s);
  }

  let created = 0;
  const nowIso = new Date().toISOString();
  const variantRows: Record<string, unknown>[] = [];
  const shadowConflictBuffer: Record<string, unknown>[] = [];
  const shadowMtfGateBuffer: Record<string, unknown>[] = [];
  const mtfRejectionBuffer: Record<string, unknown>[] = [];

  for (const symbol of symbols) {
    const whaleRows = whaleBySymbol.get(symbol) ?? [];
    let whale: Row = null;
    if (whaleRows.length > 0) {
      const buyUsd = whaleRows.filter((r) => r["direction"] === "accumulation").reduce((s, r) => s + Number(r["usd_value"] ?? 0), 0);
      const sellUsd = whaleRows.filter((r) => r["direction"] === "distribution").reduce((s, r) => s + Number(r["usd_value"] ?? 0), 0);
      const whaleUsdTotal = buyUsd + sellUsd;
      let direction: "accumulation" | "distribution" | undefined;
      if (buyUsd > sellUsd * 1.15) direction = "accumulation";
      else if (sellUsd > buyUsd * 1.15) direction = "distribution";
      whale = {
        id: whaleRows[0]?.["id"] ?? null, direction,
        usd_value: whaleUsdTotal, buy_usd: buyUsd, sell_usd: sellUsd,
        buy_count: whaleRows.filter((r) => r["direction"] === "accumulation").length,
        sell_count: whaleRows.filter((r) => r["direction"] === "distribution").length,
      };
    }

    const binSym = binanceSymbol(symbol);
    const mtfRaw: MultiTfInput = {
      primary: (indicatorByTf.get(`${binSym}:${PRIMARY_TIMEFRAME}`) ?? null) as Row,
      fast: (indicatorByTf.get(`${binSym}:${FAST_TIMEFRAME}`) ?? null) as Row,
      trend: (indicatorByTf.get(`${binSym}:${TREND_TIMEFRAME}`) ?? null) as Row,
    };
    const mtf = evaluateMultiTimeframe(mtfRaw);
    const prediction = (latestPrediction.get(symbol) ?? null) as Row;
    const council = (latestCouncil.get(symbol) ?? null) as Row;
    if (!whale && !mtfRaw.primary && !prediction && !council) continue;

    // 1. Υπολογισμός 4h Asset Shadow Regime για το συγκεκριμένο asset
    const assetMicroRegime = computeAssetRegime(mtfRaw.primary);

    // Hot-whale aggregated direction override
    const hotAgg = hotSymbolSet.has(symbol) ? hotWhaleBatch.get(symbol) ?? null : null;

    if (hotAgg && hotAgg.direction) {
      whale = {
        ...(whale ?? {}),
        direction: hotAgg.direction,
        id: null,
        usd_value: hotAgg.total_usd,
        buy_usd: hotAgg.buy_usd,
        sell_usd: hotAgg.sell_usd,
        buy_count: Math.round(hotAgg.buy_ratio * hotAgg.alert_count),
        sell_count: Math.round((1 - hotAgg.buy_ratio) * hotAgg.alert_count),
        confidence: hotAgg.confidence,
      } as Row;
      console.log(
        `[HOT_WHALE_DIRECTION] ${symbol}: ${hotAgg.direction} ` +
          `(buy_ratio=${(hotAgg.buy_ratio * 100).toFixed(0)}%, ` +
          `samples=${hotAgg.alert_count}, ` +
          `conf=${(hotAgg.confidence * 100).toFixed(0)}%)`,
      );
    }

    let result = ruleBased(whale, mtf, prediction, council, weights, {
      conflictFixEnabled, mtfGateConfig, sessionConfig, symbol,
      hotWhaleAggregate: hotAgg,
      assetRegime: assetMicroRegime.regime as AssetMicroRegime,
    });

    // 2. Asset Regime Gate: trend-only counter-trend protection
    if (
      result.recommendation === "sell" &&
      (assetMicroRegime.regime === "bull" ||
        assetMicroRegime.regime === "strong_bull")
    ) {
      result = {
        ...result,
        recommendation: "hold",
        reasoning: `${result.reasoning}; [ASSET_REGIME_GATE: Short blocked — 4h regime is ${assetMicroRegime.regime}]`,
      };
    } else if (
      result.recommendation === "buy" &&
      (assetMicroRegime.regime === "bear" ||
        assetMicroRegime.regime === "strong_bear")
    ) {
      result = {
        ...result,
        recommendation: "hold",
        reasoning: `${result.reasoning}; [ASSET_REGIME_GATE: Long blocked — 4h regime is ${assetMicroRegime.regime}]`,
      };
    }

    // 3. Sideways mean-reversion gate: extremes plus RSI confirmation.
    if (
      assetMicroRegime.regime === "sideways" &&
      (result.recommendation === "buy" || result.recommendation === "sell")
    ) {
      const requestedSide = result.recommendation as "buy" | "sell";
      const meanReversion = evaluateSidewaysMeanReversion(mtfRaw.primary, requestedSide);
      result = {
        ...result,
        ...(meanReversion.eligible ? {} : { recommendation: "hold" as const }),
        reasoning: `${result.reasoning}; [SIDEWAYS_MEAN_REVERSION_GATE: ${meanReversion.reason}]`,
      };
    }

    const symbolTags = tagsFor(
      symbol,
      watchlistCtx,
      hotSymbolSet.has(symbol) ? ["hot-whale"] : undefined,
    );

    if (
      mtfGateConfig?.enabled &&
      result.mtfGateDecision &&
      !result.mtfGateDecision.passed &&
      result.recommendation === "hold"
    ) {
      const inferredSide: "buy" | "sell" = result.score >= 0 ? "buy" : "sell";
      mtfRejectionBuffer.push({
        symbol, side: inferredSide,
        score: result.score, confidence: result.confidence,
        mtf_bull_count: mtf.bullCount,
        mtf_bear_count: mtf.bearCount,
        mtf_neutral_count: mtf.neuCount,
        reject_reason: result.mtfGateDecision.rejectReason,
        regime_label: regime.label,
        detected_at: nowIso,
      });
    }

    if (conflictShadowMode && !conflictFixEnabled) {
      const shadow = ruleBased(whale, mtf, prediction, council, weights, { conflictFixEnabled: true });
      if (shadow.recommendation !== result.recommendation) {
        shadowConflictBuffer.push({
          symbol,
          current_recommendation: result.recommendation,
          would_be_recommendation: shadow.recommendation,
          score: result.score, confidence: result.confidence,
          reasoning: shadow.reasoning,
          detected_at: nowIso,
        });
      }
    }

    if (
      mtfGateConfig &&
      !mtfGateConfig.enabled &&
      mtfGateConfig.shadow_mode &&
      (result.recommendation === "buy" || result.recommendation === "sell")
    ) {
      const mtfCounts: MtfCounts = {
        bullCount: mtf.bullCount,
        bearCount: mtf.bearCount,
        neuCount: mtf.neuCount,
      };
      const decision = checkMtfGate(result.recommendation, mtfCounts, mtfGateConfig);
      if (!decision.passed) {
        shadowMtfGateBuffer.push({
          symbol, side: result.recommendation,
          score: result.score, confidence: result.confidence,
          mtf_bull_count: mtfCounts.bullCount,
          mtf_bear_count: mtfCounts.bearCount,
          mtf_neutral_count: mtfCounts.neuCount,
          original_recommendation: result.recommendation,
          gated_recommendation: "hold",
          reasoning: result.reasoning,
          detected_at: nowIso,
        });
      }
    }

    const mtfPrice = typeof mtfRaw.primary?.["price"] === "number" ? (mtfRaw.primary["price"] as number) : null;
    for (const [presetName, presetWeights] of Object.entries(STRATEGY_PRESETS)) {
      const altResult = ruleBased(whale, mtf, prediction, council, {
        ...presetWeights,
        updated_at: nowIso,
      }, {
        assetRegime: assetMicroRegime.regime as AssetMicroRegime,
        symbol,
        hotWhaleAggregate: hotAgg,
        conflictFixEnabled,
        mtfGateConfig,
        sessionConfig,
      });
      // Production is long-only: SELL variants are not executable and must
      // never enter the primary shadow-performance benchmark.
      if (altResult.recommendation !== "buy") continue;
      if (presetName === "volatility-timing") {
        const primaryRaw = mtfRaw.primary?.["raw"] as Row;
        const aroonData = primaryRaw?.["aroon"] as Row;
        const osc = Number(aroonData?.["osc"] ?? 0);
        const confirmed = osc >= 20;
        if (!confirmed) continue;
      }
      if (presetName === "smc-reversal" || presetName === "smc-structure") {
        const primaryRaw = mtfRaw.primary?.["raw"] as Row;
        const smc = primaryRaw?.["smc"] as SmcResult | undefined;
        const confirmed =
          smc?.signal === "ssl_sweep_trap" ||
          smc?.signal === "bullish_continuation" ||
          smc?.signal === "bullish_reversal";
        if (!confirmed) continue;
      }
      if (presetName === "vwap-momentum") {
        const fastRaw = mtfRaw.fast?.["raw"] as Row;
        const fastPrice = Number(mtfRaw.fast?.["price"] ?? 0);
        const fastVwap = Number(fastRaw?.["vwap"] ?? 0);
        const fastRsi = Number(mtfRaw.fast?.["rsi"] ?? 50);
        const confirmed = fastRsi >= 60 && fastPrice > fastVwap;
        if (!confirmed) continue;

        if (vwapGate && (vwapGate.enabled || vwapGate.shadow_mode)) {
          const primaryRaw = mtfRaw.primary?.["raw"] as Row;
          const atrPct = Number(primaryRaw?.["atr_pct"] ?? 0);
          const isHighVol = Number.isFinite(atrPct) && atrPct > vwapGate.atr_pct_threshold;
          if (isHighVol) {
            if (vwapGate.enabled) continue;
            else console.log(`[VWAP_GATE_SHADOW] ${symbol}: would skip (atr=${atrPct.toFixed(2)}%)`);
          }
        }
      }

      // Asset Regime Filter: αποκλεισμός long entries σε bearish regimes.
      if (
        altResult.recommendation === "buy" &&
        (assetMicroRegime.regime === "bear" ||
          assetMicroRegime.regime === "strong_bear")
      ) {
        continue;
      }

      if (mtfPrice == null || mtfPrice <= 0) continue;
      variantRows.push({
        strategy_name: presetName, symbol,
        confidence: altResult.confidence,
        recommendation: altResult.recommendation,
        reasoning: altResult.reasoning,
        score: altResult.score,
        entry_price: mtfPrice,
  outcome: "open",
  // Capture the classifier label at signal creation; shadow_regime is independent.
  production_regime_label: regime.label,
  regime_label: regime.label,
  market_session: nowSession.session,
        source_tags: symbolTags,
        created_at: nowIso,
      });
    }

    if (result.recommendation === "hold") continue;

    if (result.recommendation === "watch") {
      const hasWhale = whale?.["direction"] != null;
      const hasTechnical = mtf.direction !== "neutral";
      const hasPrediction = predictionDirection(prediction) !== "neutral";
      const councilVerdict = String(council?.["final_verdict"] ?? "").toUpperCase();
      const councilConviction = Number(council?.["conviction"] ?? 0);
      const strongAvoid = councilVerdict === "AVOID" && councilConviction >= 60;
      const signalCount = [hasWhale, hasTechnical, hasPrediction].filter(Boolean).length;
      if (signalCount < 2 && !strongAvoid) continue;
    }

    const fingerprint = signalFingerprint(symbol, whale, mtf, mtfRaw, prediction, council, weights, result);
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
          regime_label: regime.label,
          market_session: nowSession.session,
          source_tags: symbolTags,
          created_at: nowIso,
        } as never,
        { onConflict: "fingerprint", ignoreDuplicates: false },
      )
      .select("id");
    if (error) throw error;
    if (data?.length) created += 1;
  }

  if (variantRows.length > 0) {
    const { error: variantErr } = await db.from("strategy_variant_signals").insert(variantRows as never);
    if (variantErr) console.error("[VARIANTS] insert failed:", variantErr);
    else console.log(`[VARIANTS] Recorded ${variantRows.length} shadow signals (regime=${regime.label}, session=${nowSession.session})`);
  }

  // Shadow V2 observer: isolated from V1 metrics and real/paper execution.
  await runShadowV2Observer(variantRows);

  if (shadowConflictBuffer.length > 0) {
    const { error: shadowErr } = await db.from("shadow_conflicts" as never).insert(shadowConflictBuffer as never);
    if (shadowErr) console.error("[SHADOW_CONFLICTS] insert failed:", shadowErr);
  }

  if (shadowMtfGateBuffer.length > 0) {
    const { error: mtfErr } = await db.from("shadow_mtf_gates" as never).insert(shadowMtfGateBuffer as never);
    if (mtfErr) console.error("[SHADOW_MTF_GATES] insert failed:", mtfErr);
  }

  if (mtfRejectionBuffer.length > 0) {
    const { error: rejErr } = await db.from("mtf_gate_rejections" as never).insert(mtfRejectionBuffer as never);
    if (rejErr) console.error("[MTF_GATE_REJECTIONS] insert failed:", rejErr);
  }

  return created;
}

/* ───────────── Variant resolution ───────────── */

type VariantOutcome = "win" | "loss" | "expired" | "ambiguous";

type VariantCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  openTimeMs: number;
  closeTimeMs: number;
};

type ResolutionCandle = {
  openTime: number;
  closeTime: number;
  high: number;
  low: number;
};

async function fetchVariantResolutionCandles(
  coin: string,
  timeframe: string,
  openTimeMs?: number,
  closeTimeMs?: number,
  limit = VARIANT_RESOLVE_CANDLE_LIMIT,
): Promise<VariantCandle[]> {
  const symbol = binanceSymbol(coin);
  try {
    const result = await fetchCandlesUnified(coin, timeframe);
    if (!result) return [];
    return result.candles
      .map((r) => ({
        open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
        close: Number(r[4]), openTimeMs: Number(r[0]), closeTimeMs: Number(r[6]),
      }))
      .filter((c) =>
        Number.isFinite(c.open) && Number.isFinite(c.high) &&
        Number.isFinite(c.low) && Number.isFinite(c.close) &&
        Number.isFinite(c.openTimeMs) && Number.isFinite(c.closeTimeMs) &&
        (openTimeMs == null || c.closeTimeMs > openTimeMs) &&
        (closeTimeMs == null || c.openTimeMs < closeTimeMs),
      )
      .sort((a, b) => a.openTimeMs - b.openTimeMs)
      .slice(-limit);
  } catch (e) {
    console.warn(`[VARIANTS] ${timeframe} klines fetch failed for ${symbol}:`, e);
    return [];
  }
}

async function resolveAmbiguousCandle(
  symbol: string,
  side: "buy" | "sell",
  tpPrice: number,
  slPrice: number,
  candle: ResolutionCandle,
): Promise<VariantOutcome> {
  for (const timeframe of ["5m", "15m"] as const) {
    try {
      const lowerCandles = await fetchVariantResolutionCandles(
        symbol,
        timeframe,
        candle.openTime,
        candle.closeTime,
        VARIANT_RESOLVE_CANDLE_LIMIT,
      );

  if (lowerCandles.length === 0) {
  console.warn("[variant-resolution] lower timeframe unavailable", {
  symbol, side, timeframe,
  candleOpenTime: candle.openTime,
  candleCloseTime: candle.closeTime,
  });
  continue;
  }

  const orderedCandles = [...lowerCandles].sort(
        (a, b) => a.openTimeMs - b.openTimeMs,
      );

      for (const lower of orderedCandles) {
        const hitTP = side === "buy" ? lower.high >= tpPrice : lower.low <= tpPrice;
        const hitSL = side === "buy" ? lower.low <= slPrice : lower.high >= slPrice;

        if (hitTP && hitSL) return "ambiguous";
        if (hitTP) return "win";
        if (hitSL) return "loss";
  }

  console.log("[variant-resolution] no ordered hit; trying next timeframe", {
  symbol, side, timeframe,
  candleOpenTime: candle.openTime,
  candleCloseTime: candle.closeTime,
  });
  } catch (error) {
      console.warn(`[variant-resolution] ${timeframe} fallback failed`, {
        symbol,
        side,
        candleOpenTime: candle.openTime,
        candleCloseTime: candle.closeTime,
        error,
      });
    }
  }

  return "ambiguous";
}

async function resolveVariantOutcomes(): Promise<number> {
  const db = await admin();
  const settings = await fetchTradingSettings();
  const variantTpPct = settings.variant_tp_pct;
  const variantSlPct = settings.variant_sl_pct;
  const variantMaxHours = settings.variant_max_hours;

  const minAgeMs = 60 * 60 * 1000;
  const maxAgeIso = new Date(Date.now() - minAgeMs).toISOString();
  const PER_PRESET_OLDEST_BATCH = 300;
  const PER_PRESET_NEWEST_BATCH = 300;
  const PRESETS = Object.keys(STRATEGY_PRESETS);

  const openVariants: { id: string; symbol: string; recommendation: string | null; entry_price: number | null; created_at: string; }[] = [];

  const presetFetchResults = await Promise.all(
  PRESETS.map(async (preset) => {
  const baseQuery = () => db
  .from("strategy_variant_signals")
  .select("id, symbol, recommendation, entry_price, created_at")
  .eq("strategy_name", preset)
  .eq("outcome", "open")
  .not("entry_price", "is", null)
  .in("recommendation", ["buy", "sell"])
  .lte("created_at", maxAgeIso);

  const [oldestRes, newestRes] = await Promise.all([
  baseQuery().order("created_at", { ascending: true }).limit(PER_PRESET_OLDEST_BATCH),
  baseQuery().order("created_at", { ascending: false }).limit(PER_PRESET_NEWEST_BATCH),
  ]);
  if (oldestRes.error || newestRes.error) return [] as typeof openVariants;

  const merged = [
  ...((oldestRes.data ?? []) as typeof openVariants),
  ...((newestRes.data ?? []) as typeof openVariants),
  ];
  return [...new Map(merged.map((row) => [row.id, row])).values()];
  }),
  );

  for (const batch of presetFetchResults) openVariants.push(...batch);
  if (openVariants.length === 0) {
    console.log("[VARIANTS] resolver queue empty");
    return 0;
  }
  console.log(`[VARIANTS] resolver queue=${openVariants.length}`);

  const bySymbol = new Map<string, { id: string; recommendation: "buy" | "sell"; entry_price: number; created_at: string; }[]>();
  for (const raw of openVariants) {
    const entry = Number(raw.entry_price);
    const rec = String(raw.recommendation ?? "").toLowerCase();
    if (!Number.isFinite(entry) || entry <= 0) continue;
    if (rec !== "buy" && rec !== "sell") continue;
    const list = bySymbol.get(raw.symbol) ?? [];
    list.push({ id: raw.id, recommendation: rec, entry_price: entry, created_at: raw.created_at });
    bySymbol.set(raw.symbol, list);
  }

  const symbolResults = await pMap(
    [...bySymbol.entries()],
    async ([symbol, variants]) => ({
      symbol, variants,
      candles: await fetchVariantResolutionCandles(symbol, VARIANT_RESOLVE_TIMEFRAME, undefined, undefined, VARIANT_RESOLVE_CANDLE_LIMIT),
    }),
    10,
  );

  const nowMs = Date.now();
  let resolved = 0;

  for (const result of symbolResults) {
    if (!result || result.candles.length === 0) {
      if (result) console.warn(`[VARIANTS] no resolution candles for ${result.symbol}; variants=${result.variants.length}`);
      continue;
    }
    const { symbol, variants, candles } = result;

    for (const variant of variants) {
      const entry = variant.entry_price;
      const rec = variant.recommendation;
      const entryMs = new Date(variant.created_at).getTime();
      if (!Number.isFinite(entryMs)) continue;

      const tpPrice = rec === "buy" ? entry * (1 + variantTpPct) : entry * (1 - variantTpPct);
      const slPrice = rec === "buy" ? entry * (1 - variantSlPct) : entry * (1 + variantSlPct);

      const relevantCandles = candles.filter((c) => c.closeTimeMs > entryMs && c.closeTimeMs <= nowMs);
      let outcome: VariantOutcome | null = null;
      let exitPrice: number | null = null;

      for (const candle of relevantCandles) {
        const hitTP = rec === "buy" ? candle.high >= tpPrice : candle.low <= tpPrice;
        const hitSL = rec === "buy" ? candle.low <= slPrice : candle.high >= slPrice;

        if (hitTP && hitSL) {
          outcome = await resolveAmbiguousCandle(symbol, rec, tpPrice, slPrice, {
            openTime: candle.openTimeMs,
            closeTime: candle.closeTimeMs,
            high: candle.high,
            low: candle.low,
          });
          if (outcome === "win") exitPrice = tpPrice;
          if (outcome === "loss") exitPrice = slPrice;
          break;
        }

        if (hitTP) { outcome = "win"; exitPrice = tpPrice; break; }
        if (hitSL) { outcome = "loss"; exitPrice = slPrice; break; }
      }

      if (!outcome) {
        const ageHours = (nowMs - entryMs) / 3_600_000;
        if (ageHours >= variantMaxHours) {
          const expiryCandle = relevantCandles[relevantCandles.length - 1];
          if (expiryCandle) { outcome = "expired"; exitPrice = expiryCandle.close; }
        }
      }

  /*
   * AMBIGUOUS is a terminal resolution state. It intentionally has no
   * deterministic exit price or PnL and must not remain OPEN.
   */
  if (!outcome) continue;
  if (outcome !== "ambiguous" && exitPrice == null) continue;

  const pnlPct =
  outcome === "ambiguous" || exitPrice == null
  ? null
  : rec === "buy"
  ? ((exitPrice - entry) / entry) * 100
  : ((entry - exitPrice) / entry) * 100;

  const { data: updatedRows, error: updateErr } = await db
  .from("strategy_variant_signals")
  .update({
  outcome,
  exit_price: outcome === "ambiguous" ? null : exitPrice,
  pnl_pct: pnlPct,
  resolved_at: new Date().toISOString(),
  })
  .eq("id", variant.id)
  .eq("outcome", "open")
  .select("id");

  if (updateErr) {
  console.error(`[VARIANTS] failed to persist ${outcome} for ${variant.id}:`, updateErr);
  continue;
  }
  if (updatedRows && updatedRows.length > 0) resolved += 1;
    }
  }

  console.log(`[VARIANTS] resolution pass complete queue=${openVariants.length} resolved=${resolved}`);
  if (resolved > 0) console.log(`[VARIANTS] Resolved ${resolved} outcomes`);
  return resolved;
}

/* ───────────── Trade executor ───────────── */

export function tradingMode(): "paper" | "live" {
  const mode = process.env["TRADING_MODE"];
  const liveEnabled = process.env["ENABLE_LIVE_TRADING"] === "true";
  const hasKeys = !!process.env["BINANCE_API_KEY"] && !!process.env["BINANCE_API_SECRET"];
  return mode === "live" && liveEnabled && hasKeys ? "live" : "paper";
}

async function allBinancePrices(): Promise<Map<string, number>> {
  try {
    const res = await binancePublicGet("/api/v3/ticker/price");
    if (res.ok) {
      const data = (await res.json()) as { symbol: string; price: string }[];
      const map = new Map<string, number>();
      for (const d of data) {
        const p = Number(d.price);
        if (Number.isFinite(p)) map.set(d.symbol, p);
      }
      if (map.size > 0) return map;
    }
  } catch { /* fall through */ }

  const mids = await hlPost<Record<string, string>>({ type: "allMids" });
  const fallback = new Map<string, number>();
  for (const [coin, raw] of Object.entries(mids ?? {})) {
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0 || coin.startsWith("@")) continue;
    const base = coin.startsWith("k") ? coin.slice(1) : coin;
    fallback.set(`${base}USDT`, coin.startsWith("k") ? price / 1000 : price);
  }
  if (fallback.has("MATICUSDT") && !fallback.has("POLUSDT")) fallback.set("POLUSDT", fallback.get("MATICUSDT")!);
  if (fallback.has("RNDRUSDT") && !fallback.has("RENDERUSDT")) fallback.set("RENDERUSDT", fallback.get("RNDRUSDT")!);
  if (fallback.size === 0) throw new Error("batch price fetch failed: no price source");
  return fallback;
}

async function placeLiveOrder(
  coin: string,
  side: "buy" | "sell",
  quantity: number,
): Promise<string> {
  const order = await placeBinanceSpotMarketOrder(coin, side, quantity);
  return String(order.orderId);
}

async function closeTriggeredTrades(): Promise<number> {
  const db = await admin();
  const settings = await fetchTradingSettings();
  const staleExitHours = settings.stale_exit_hours;
  const staleExitMinPnlPct = settings.stale_exit_min_pnl_pct;
  const maxHoldHours = settings.max_hold_hours;

  const { data: openTrades, error } = await db
    .from("trades")
    .select("id, symbol, side, quantity, entry_price, stop_loss, take_profit, mode, created_at")
    .eq("status", "open");
  if (error) throw error;
  const trades = (openTrades ?? []) as {
    id: string; symbol: string; side: "buy" | "sell"; quantity: number;
    entry_price: number; stop_loss: number | null; take_profit: number | null;
    mode: "paper" | "live"; created_at: string;
  }[];
  if (trades.length === 0) return 0;

  let prices: Map<string, number>;
  try { prices = await allBinancePrices(); }
  catch { return 0; }

  const closeCtx = await getActiveWatchlistContext();
  let closed = 0;
  const nowMs = Date.now();

  for (const trade of trades) {
    const binSym = binanceSymbol(trade.symbol);
    const price = prices.get(binSym);
    if (price == null) continue;

    const entryPrice = Number(trade.entry_price);
    const hitStopLoss = trade.stop_loss != null && (trade.side === "buy" ? price <= trade.stop_loss : price >= trade.stop_loss);
    const hitTakeProfit = trade.take_profit != null && (trade.side === "buy" ? price >= trade.take_profit : price <= trade.take_profit);

    const ageHours = (nowMs - new Date(trade.created_at).getTime()) / 3_600_000;
    const pnlPctNow = entryPrice > 0
      ? ((trade.side === "buy" ? price - entryPrice : entryPrice - price) / entryPrice) * 100
      : 0;
    const stale = ageHours >= staleExitHours && Math.abs(pnlPctNow) < staleExitMinPnlPct;
    const expired = ageHours >= maxHoldHours;

    if (!hitStopLoss && !hitTakeProfit && !stale && !expired) continue;

    if (trade.mode === "live") {
      // Binance Spot is long-only: only a DB BUY can be closed with a SELL.
      if (trade.side !== "buy") {
        console.error(
          `[BINANCE_SPOT] FAIL-CLOSED: refusing live close for non-BUY trade ` +
            `id=${trade.id} symbol=${trade.symbol} side=${trade.side}`,
        );
        continue;
      }

      try {
        const executableQuantity = await getExecutableSpotSellQuantity(
          trade.symbol,
          Number(trade.quantity),
        );
        if (executableQuantity <= 0) {
          console.error(
            `[BINANCE_SPOT] SELL close blocked: zero executable quantity ` +
              `trade=${trade.id} symbol=${trade.symbol}`,
          );
          continue;
        }
        await placeLiveOrder(trade.symbol, "sell", executableQuantity);
      } catch (error) {
        console.error(
          `[BINANCE_SPOT] live close failed ` +
            `trade=${trade.id} symbol=${trade.symbol}:`,
          error,
        );
        // Do not mark the DB trade closed without confirmed exchange execution.
        continue;
      }
    }

    const closeReason = hitStopLoss ? "stop_loss" : hitTakeProfit ? "take_profit" : expired ? "expired" : "stale_exit";
    const closedAt = new Date().toISOString();
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

    await db.from("trade_alerts").insert({
      trade_id: trade.id, symbol: trade.symbol, side: trade.side,
      event_type: closeReason, entry_price: entryPrice, exit_price: price,
      pnl: fee.netPnl, pnl_pct: fee.netPnlPct, created_at: closedAt,
      tags: tagsFor(trade.symbol, closeCtx),
    } as never);
    closed += 1;
  }
  return closed;
}

interface OpenTradeForRotation {
  id: string; symbol: string; side: "buy" | "sell";
  quantity: number; entry_price: number; mode: "paper" | "live";
  composite_signal_id: string | null; created_at: string;
}

async function attemptRotation(
  db: Admin, newSignal: { symbol: string; confidence: number },
  prices: Map<string, number>, openTrades: OpenTradeForRotation[],
  openConfidenceMap: Map<string, number>,
): Promise<string | null> {
  const nowMs = Date.now();

  const scored = openTrades.map((t) => {
    const price = prices.get(binanceSymbol(t.symbol));
    const entry = Number(t.entry_price);
    const qty = Number(t.quantity);
    const pnlPct = price != null && entry > 0 && qty > 0
      ? ((t.side === "buy" ? price - entry : entry - price) / entry) * 100
      : 0;
    const ageMin = (nowMs - new Date(t.created_at).getTime()) / 60_000;
    const originalConfidence = t.composite_signal_id ? (openConfidenceMap.get(t.composite_signal_id) ?? 0) : 0;
    return { ...t, pnlPct, ageMin, originalConfidence, currentPrice: price ?? null };
  });

  const eligible = scored.filter(
    (t) => t.ageMin >= ROTATION_MIN_OPEN_AGE_MINUTES &&
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
  const fee = computeFeeAwarePnl(weakest.side, entryPrice, price, Number(weakest.quantity));
  const closedAt = new Date().toISOString();

  const { error: closeErr } = await db
    .from("trades")
    .update({
      status: "closed",
      pnl: fee.netPnl, gross_pnl: fee.grossPnl, net_pnl: fee.netPnl,
      entry_fee: fee.entryFee, exit_fee: fee.exitFee, total_fees: fee.totalFees,
      exit_price: price, close_reason: "rotated_out", closed_at: closedAt,
    })
    .eq("id", weakest.id)
    .eq("status", "open");
  if (closeErr) return null;

  const rotationCtx = await getActiveWatchlistContext();
  await db.from("trade_alerts").insert({
    trade_id: weakest.id, symbol: weakest.symbol, side: weakest.side,
    event_type: "rotated_out", entry_price: entryPrice, exit_price: price,
    pnl: fee.netPnl, pnl_pct: fee.netPnlPct, created_at: closedAt,
    tags: tagsFor(weakest.symbol, rotationCtx),
  } as never);

  console.log(`[ROTATION] closed ${weakest.symbol} (PnL ${weakest.pnlPct.toFixed(2)}%) → room for ${newSignal.symbol}`);
  return weakest.symbol;
}

export async function executeTrades(opts?: {
  skipNewEntries?: boolean;
}): Promise<{
  opened: number;
  audit: ExecutionAuditEvent[];
}> {
  const db = await admin();
  const mode = tradingMode();
  const settings = await fetchTradingSettings();

  const audit: ExecutionAuditEvent[] = [];

  const auditReject = (
    symbol: string,
    stage: ExecutionAuditStage,
    reason: string,
    opts?: {
      signalId?: string;
      confidence?: number;
      details?: Record<string, unknown>;
    },
  ) => {
    const event = createExecutionAuditEvent(symbol, stage, "REJECT", reason, opts);
    audit.push(event);
    console.log(`[EXEC_AUDIT] REJECT ${symbol} stage=${stage} reason=${reason}`);
  };

  const auditAccept = (
    symbol: string,
    stage: ExecutionAuditStage,
    reason: string,
    opts?: {
      signalId?: string;
      confidence?: number;
      details?: Record<string, unknown>;
    },
  ) => {
    const event = createExecutionAuditEvent(symbol, stage, "ACCEPT", reason, opts);
    audit.push(event);
    console.log(`[EXEC_AUDIT] ACCEPT ${symbol} stage=${stage} reason=${reason}`);
  };

  await closeTriggeredTrades();

  /* ============================================================
   * P0 EXECUTION AUDIT SEED
   *
   * MUST run before circuit-breaker / global-risk early returns.
   * This guarantees every currently executable BUY signal receives
   * a signal_id in execution_audit.events[] even when new entries
   * are disabled by the circuit breaker or by a global-risk cooldown.
   *
   * Without this seed, executeTrades() returns before querying
   * composite_signals, producing an empty execution_audit while
   * eligible BUY signals exist — yielding a false coverage=0%
   * reading in the AI Diagnostic.
   *
   * These seed events are marked with details.audit_seed === true so
   * the AI Report can distinguish them from real candidate accepts.
   * ============================================================ */
  const auditWindowSince = new Date(
    Date.now() - 15 * 60 * 1000,
  ).toISOString();

  const {
    data: auditEligibleRows,
    error: auditEligibleError,
  } = await db
    .from("composite_signals")
    .select("id,symbol,recommendation,confidence,created_at,reasoning")
    .eq("recommendation", "buy")
    .gte("created_at", auditWindowSince)
    .gte("confidence", MIN_CONFIDENCE)
    .order("created_at", { ascending: false })
    .limit(200);

  if (auditEligibleError) {
    console.error("[EXECUTION_AUDIT_SEED_FAILED]", auditEligibleError);
  } else {
    for (const row of (auditEligibleRows ?? []) as Array<
      Record<string, unknown>
    >) {
      auditAccept(
        String(row["symbol"] ?? "UNKNOWN"),
        "CANDIDATE_FILTER",
        "ELIGIBLE_BUY_AUDIT_ENTRY",
        {
          signalId: String(row["id"] ?? ""),
          confidence: Number(row["confidence"] ?? 0),
          details: {
            recommendation: row["recommendation"],
            confidence_threshold: MIN_CONFIDENCE,
            audit_seed: true,
          },
        },
      );
    }

    console.log(
      `[EXECUTION_AUDIT_SEED] eligible=${auditEligibleRows?.length ?? 0} window=15m`,
    );
  }

  if (opts?.skipNewEntries) {
    console.warn("[CIRCUIT_BREAKER] skipNewEntries=true — closed-only mode");

    audit.push(
      createExecutionAuditEvent(
        "SYSTEM",
        "CIRCUIT_BREAKER",
        "SKIP",
        "new entries disabled",
      ),
    );

    return {
      opened: 0,
      audit,
    };
  }

  // ─── Global-risk cooldown gate ───
  const globalRiskState = await getGlobalRiskState();
  if (globalRiskState.cooldown_until) {
    const until = new Date(globalRiskState.cooldown_until).getTime();
    if (Number.isFinite(until) && until > Date.now()) {
      const remaining = Math.ceil((until - Date.now()) / 60_000);
      console.warn(
        `[GLOBAL_RISK_COOLDOWN] skipping new entries — ${remaining}min left ` +
          `(last trigger: ${globalRiskState.last_trigger_type ?? "?"})`,
      );

      audit.push(
        createExecutionAuditEvent(
          "SYSTEM",
          "GLOBAL_RISK",
          "SKIP",
          "global risk cooldown active",
          {
            details: {
              remaining_minutes: remaining,
              last_trigger_type: globalRiskState.last_trigger_type ?? null,
            },
          },
        ),
      );

      return {
        opened: 0,
        audit,
      };
    }
  }

  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const cooldownSince = new Date(Date.now() - SYMBOL_COOLDOWN_MINUTES * 60 * 1000).toISOString();

  const [signalsRes, openTradesRes, recentlyClosedRes] = await Promise.all([
    db.from("composite_signals").select("*").gte("created_at", since).gte("confidence", MIN_CONFIDENCE).in("recommendation", ["buy", "sell"]).order("confidence", { ascending: false }),
    db.from("trades").select("id, symbol, side, quantity, entry_price, mode, composite_signal_id, created_at").eq("status", "open"),
    db.from("trades").select("symbol").eq("status", "closed").gte("closed_at", cooldownSince),
  ]);
  if (signalsRes.error) throw signalsRes.error;
  if (openTradesRes.error) throw openTradesRes.error;
  if (recentlyClosedRes.error) throw recentlyClosedRes.error;

  const openTrades = (openTradesRes.data ?? []) as OpenTradeForRotation[];
  const openSymbols = new Set(openTrades.map((t) => t.symbol));
  const cooldownSymbols = new Set(((recentlyClosedRes.data ?? []) as { symbol: string }[]).map((t) => t.symbol));

  let prices: Map<string, number>;
  try { prices = await allBinancePrices(); }
  catch (e) { console.error("batch price fetch failed", e); return { opened: 0, audit }; }

  const execCtx = await getActiveWatchlistContext();
  const hotSymbolsNow = await getHotWhaleSymbols();
  const hotSymbolSet = new Set(hotSymbolsNow);

  type ExecutionSignal = {
    id: string;
    symbol: string;
    recommendation: string;
    confidence: number;
    price_at?: number | null;
    created_at?: string | null;
    reasoning?: string | null;
    regime_label?: string | null;
    entry_state?: "WATCH" | "ENTRY_READY" | "INVALIDATED" | null;
    entry_trigger?: string | null;
    entry_min?: number | null;
    entry_max?: number | null;
    stop_loss?: number | null;
    take_profit_1?: number | null;
    take_profit_2?: number | null;
    position_multiplier?: number | null;
  };
  const executionSignals = (signalsRes.data ?? []) as ExecutionSignal[];
  const parseAIRiskAnnotation = (reasoning: string | null | undefined): AIRiskDecision | null => {
    const match = String(reasoning ?? "").match(
      /\[AI_RISK_GATE: (ALLOW|BLOCK) (low|medium|high|critical)\/(fresh|stale|insufficient) — ([^\]]+)\]/,
    );
    if (!match) return null;
    return {
      symbol: "",
      risk_level: match[2] as AIRiskDecision["risk_level"],
      trade_allowed: match[1] === "ALLOW",
      data_quality: match[3] as AIRiskDecision["data_quality"],
      reasons: [match[4] ?? "previously evaluated"],
    };
  };

  // ═══════════════════════════════════════════════════════════════════════
  // riskCandidates: επιτρέπει σε 1d-conflict signals να φτάσουν στο AI Risk.
  // Δεν φιλτράρουμε εδώ το 1d bear/conflict — ο downstream έλεγχος παραμένει
  // στο execution loop.
  // ═══════════════════════════════════════════════════════════════════════
  const riskCandidates = executionSignals.filter((signal) => {
    if (signal.recommendation !== "buy") return false;

    if (openSymbols.has(signal.symbol)) {
      auditReject(
        signal.symbol,
        "CANDIDATE_FILTER",
        "symbol already has open position",
        { signalId: signal.id, confidence: signal.confidence },
      );
      return false;
    }

    if (cooldownSymbols.has(signal.symbol)) {
      auditReject(
        signal.symbol,
        "CANDIDATE_FILTER",
        "symbol is in cooldown",
        { signalId: signal.id, confidence: signal.confidence },
      );
      return false;
    }

    if (signal.confidence < MIN_CONFIDENCE) {
      auditReject(
        signal.symbol,
        "CANDIDATE_FILTER",
        `confidence below minimum ${MIN_CONFIDENCE}`,
        {
          signalId: signal.id,
          confidence: signal.confidence,
          details: { min_confidence: MIN_CONFIDENCE },
        },
      );
      return false;
    }

    const price = prices.get(binanceSymbol(signal.symbol));

    if (price == null) {
      auditReject(
        signal.symbol,
        "CANDIDATE_FILTER",
        "no executable Binance price",
        { signalId: signal.id, confidence: signal.confidence },
      );
      console.warn(
        `[AI_RISK_CANDIDATE] skip ${signal.symbol}: no executable price`,
      );
      return false;
    }

    const signalPrice = Number(signal.price_at);

    if (
      Number.isFinite(signalPrice) &&
      signalPrice > 0 &&
      Math.abs(price - signalPrice) / signalPrice > MAX_ENTRY_DRIFT_PCT
    ) {
      const driftPct = Math.abs(price - signalPrice) / signalPrice;
      auditReject(
        signal.symbol,
        "CANDIDATE_FILTER",
        "entry price drift exceeded limit",
        {
          signalId: signal.id,
          confidence: signal.confidence,
          details: {
            signal_price: signalPrice,
            current_price: price,
            drift_pct: driftPct,
            max_drift_pct: MAX_ENTRY_DRIFT_PCT,
          },
        },
      );
      console.log(
        `[AI_RISK_CANDIDATE] skip ${signal.symbol}: entry drift exceeded ` +
          `signal=${signalPrice} current=${price}`,
      );
      return false;
    }

    if (
      signal.created_at &&
      !isFresh(signal.created_at, 15 * 60 * 1000)
    ) {
      auditReject(
        signal.symbol,
        "CANDIDATE_FILTER",
        "signal stale",
        {
          signalId: signal.id,
          confidence: signal.confidence,
          details: {
            created_at: signal.created_at,
            max_age_minutes: 15,
          },
        },
      );
      console.log(
        `[AI_RISK_CANDIDATE] skip ${signal.symbol}: signal stale`,
      );
      return false;
    }

    const regime = String(
      signal.regime_label ?? currentRegimeLabel ?? "",
    ).toLowerCase();

    if (regime === "bear" || regime === "strong_bear") {
      auditReject(
        signal.symbol,
        "CANDIDATE_FILTER",
        "hard bearish market regime",
        {
          signalId: signal.id,
          confidence: signal.confidence,
          details: { regime },
        },
      );
      console.log(
        `[AI_RISK_CANDIDATE] skip ${signal.symbol}: ` +
          `hard bearish regime=${regime}`,
      );
      return false;
    }

    /*
     * IMPORTANT:
     *
     * Do NOT reject 1d-bear/conflict here.
     *
     * Downstream execution already contains the correct conditional:
     * 1d bear + conflict is allowed when there is whale accumulation
     * OR bullish prediction support.
     *
     * Filtering it here would prevent evaluateAIRiskBatch() from ever
     * evaluating the signal and would incorrectly trigger the later
     * fail-closed "no AI risk decision" path.
     */

    const existingAIRisk = parseAIRiskAnnotation(signal.reasoning);

    if (existingAIRisk) {
      auditReject(
        signal.symbol,
        "CANDIDATE_FILTER",
        "existing AI risk annotation",
        { signalId: signal.id, confidence: signal.confidence },
      );
      console.log(
        `[AI_RISK_CANDIDATE] ${signal.symbol}: existing AI risk annotation`,
      );
      return false;
    }

    auditAccept(
      signal.symbol,
      "CANDIDATE_FILTER",
      "passed candidate filters",
      {
        signalId: signal.id,
        confidence: signal.confidence,
        details: {
          regime,
          reasoning_excerpt: String(signal.reasoning ?? "").slice(0, 180),
        },
      },
    );

    console.log(
      `[AI_RISK_CANDIDATE] ACCEPT ${signal.symbol} ` +
        `conf=${signal.confidence.toFixed(3)} ` +
        `regime=${regime || "unknown"} ` +
        `reasoning=${String(signal.reasoning ?? "").slice(0, 180)}`,
    );

    return true;
  });

  const aiRiskBySignalId = new Map<string, AIRiskDecision>();
  for (const signal of executionSignals) {
    const previous = parseAIRiskAnnotation(signal.reasoning);
    if (previous) aiRiskBySignalId.set(signal.id, { ...previous, symbol: signal.symbol });
  }
  const aiRiskDecisions = await evaluateAIRiskBatch(
    riskCandidates.map((signal) => ({
      symbol: signal.symbol,
      confidence: signal.confidence,
      price: prices.get(binanceSymbol(signal.symbol)) ?? null,
      regime: signal.regime_label ?? currentRegimeLabel,
      reasoning: String(signal.reasoning ?? ""),
    })),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // AI Risk visibility + audit
  // ═══════════════════════════════════════════════════════════════════════
  riskCandidates.forEach((signal, index) => {
    const decision = aiRiskDecisions[index];

    if (decision) {
      aiRiskBySignalId.set(signal.id, decision);

      console.log(
        `[AI_RISK_RESULT] ${signal.symbol} ` +
          `conf=${signal.confidence.toFixed(3)} ` +
          `risk=${decision.risk_level} ` +
          `quality=${decision.data_quality} ` +
          `allowed=${decision.trade_allowed} ` +
          `reasons=${decision.reasons.join("; ")}`,
      );

      if (decision.trade_allowed) {
        auditAccept(
          signal.symbol,
          "AI_RISK",
          "AI risk gate allowed candidate",
          {
            signalId: signal.id,
            confidence: signal.confidence,
            details: {
              risk_level: decision.risk_level,
              data_quality: decision.data_quality,
              trade_allowed: decision.trade_allowed,
              reasons: decision.reasons,
            },
          },
        );
      } else {
        auditReject(
          signal.symbol,
          "AI_RISK",
          "AI risk gate blocked candidate",
          {
            signalId: signal.id,
            confidence: signal.confidence,
            details: {
              risk_level: decision.risk_level,
              data_quality: decision.data_quality,
              trade_allowed: decision.trade_allowed,
              reasons: decision.reasons,
            },
          },
        );
      }
    } else {
      console.warn(
        `[AI_RISK_RESULT] MISSING ${signal.symbol} ` +
          `signal_id=${signal.id}`,
      );

      auditReject(
        signal.symbol,
        "AI_RISK",
        "AI risk decision missing — fail closed",
        { signalId: signal.id, confidence: signal.confidence },
      );
    }
  });

  console.log(
    `[EXECUTION] signals=${executionSignals.length} ` +
      `riskCandidates=${riskCandidates.length} ` +
      `openPositions=${openSymbols.size} ` +
      `cooldowns=${cooldownSymbols.size}`,
  );

  let opened = 0;

  for (const signal of executionSignals) {
    if (openSymbols.has(signal.symbol)) continue;
    if (cooldownSymbols.has(signal.symbol)) continue;

    const { data: existing } = await db.from("trades").select("id").eq("composite_signal_id", signal.id).limit(1);
    if (existing && existing.length > 0) continue;

    const price = prices.get(binanceSymbol(signal.symbol));
    if (price == null) { console.error(`no price for ${signal.symbol}`); continue; }

    const signalPrice = Number(signal.price_at);
    if (Number.isFinite(signalPrice) && signalPrice > 0 && Math.abs(price - signalPrice) / signalPrice > MAX_ENTRY_DRIFT_PCT) continue;

  let side = signal.recommendation as "buy" | "sell";

  const confidence = Number(signal.confidence ?? 0);
  const recommendation = String(signal.recommendation ?? "").toLowerCase();
  const isLongOnly = recommendation === "buy";
  const confidenceReady = confidence >= MIN_CONFIDENCE;

  if (!isLongOnly) {
    console.log(
      `[SPOT ENTRY] SKIP ${signal.symbol}: recommendation=${recommendation}, ` +
        `confidence=${confidence.toFixed(3)}`,
    );
    continue;
  }
  if (!confidenceReady) {
    console.log(
      `[SPOT ENTRY] SKIP ${signal.symbol}: confidence=${confidence.toFixed(3)} < ` +
        `MIN_CONFIDENCE=${MIN_CONFIDENCE}`,
    );
    continue;
  }
  console.log(
    `[SPOT ENTRY] ENTRY_READY ${signal.symbol}: recommendation=${recommendation}, ` +
      `confidence=${confidence.toFixed(3)}`,
  );

  if (side === "sell") {
    console.log(`[LONG_ONLY] skip SELL ${signal.symbol}`);
    continue;
  }
  if (signal.confidence < MIN_CONFIDENCE) {
    console.log(
      `[QUALITY] skip ${signal.symbol}: conf=${signal.confidence.toFixed(2)}`,
    );
    continue;
  }
  const aiRisk = aiRiskBySignalId.get(signal.id);
  if (!aiRisk) {
    console.warn(`[AI_RISK_GATE] no decision for ${signal.symbol} — fail-closed`);
    auditReject(
      signal.symbol,
      "AI_RISK",
      "no AI risk decision (fail-closed)",
      { signalId: signal.id, confidence: signal.confidence },
    );
    continue;
  }
  const aiRiskNote = `[AI_RISK_GATE: ${aiRisk.trade_allowed ? "ALLOW" : "BLOCK"} ${aiRisk.risk_level}/${aiRisk.data_quality} — ${aiRisk.reasons.join("; ")}]`;
  const { error: riskAnnotationError } = await db
    .from("composite_signals")
    .update({ reasoning: `${String(signal.reasoning ?? "")}; ${aiRiskNote}` } as never)
    .eq("id", signal.id);
  if (riskAnnotationError) {
    console.error(`[AI_RISK_GATE] annotation failed for ${signal.symbol}`, riskAnnotationError);
    continue;
  }
  if (!aiRisk.trade_allowed) {
    console.log(`[AI_RISK_GATE] blocked ${signal.symbol}: ${aiRiskNote}`);

    auditReject(
      signal.symbol,
      "AI_RISK",
      "AI risk veto",
      {
        signalId: signal.id,
        confidence: signal.confidence,
        details: {
          risk_level: aiRisk.risk_level,
          data_quality: aiRisk.data_quality,
          reasons: aiRisk.reasons,
        },
      },
    );

    continue;
  }
  const reasoning = String((signal as { reasoning?: string }).reasoning ?? "");

  // 1d bear + conflict protection — επιτρέπεται μόνο με whale/pred support.
  if (/1d bear\s*·\s*conflict/i.test(reasoning)) {
    const hasWhaleAcc = /whale accumulation/i.test(reasoning);
    const hasPredBull = /prediction market bullish/i.test(reasoning);
    if (!hasWhaleAcc && !hasPredBull) {
      console.log(
        `[QUALITY] skip ${signal.symbol}: 1d conflict without whale/pred support`,
      );

      auditReject(
        signal.symbol,
        "QUALITY",
        "1d bear conflict without whale or prediction support",
        {
          signalId: signal.id,
          confidence: signal.confidence,
          details: {
            whale_accumulation: hasWhaleAcc,
            prediction_bullish: hasPredBull,
          },
        },
      );

      continue;
    }
  }
  side = signal.recommendation as "buy" | "sell";

  const regime = (currentRegimeLabel ?? "").toLowerCase();
  const isBull = regime === "bull" || regime === "strong_bull";
  const isBear = regime === "bear" || regime === "strong_bear";
  if (isBull && side === "sell") {
    console.log(`[REGIME_FILTER] skip SELL ${signal.symbol} — regime=${currentRegimeLabel}`);

    auditReject(
      signal.symbol,
      "REGIME",
      "SELL rejected by bullish regime",
      {
        signalId: signal.id,
        confidence: signal.confidence,
        details: { regime: currentRegimeLabel },
      },
    );

    continue;
  }
  if (isBear && side === "buy") {
    console.log(`[REGIME_FILTER] skip BUY ${signal.symbol} — regime=${currentRegimeLabel}`);

    auditReject(
      signal.symbol,
      "REGIME",
      "BUY rejected by bearish regime",
      {
        signalId: signal.id,
        confidence: signal.confidence,
        details: { regime: currentRegimeLabel },
      },
    );

    continue;
  }

  const stopLoss = side === "buy" ? price * (1 - settings.real_sl_pct) : price * (1 + settings.real_sl_pct);
    const takeProfit = side === "buy" ? price * (1 + settings.real_tp_pct) : price * (1 - settings.real_tp_pct);

    if (signal.created_at && !isFresh(signal.created_at, 15 * 60 * 1000)) continue;

    const risk = await canOpenTrade(db as any, {
      symbol: signal.symbol, side, entryPrice: price, stopLoss, currentPrices: prices,
    });

    if (!risk.allowed) {
      console.log(`[RISK_REJECTED] ${signal.symbol} ${side}: ${risk.reason}`);

      auditReject(
        signal.symbol,
        "RISK_ENGINE",
        String(risk.reason),
        {
          signalId: signal.id,
          confidence: signal.confidence,
          details: {
            side,
            entry_price: price,
            stop_loss: stopLoss,
          },
        },
      );

      continue;
    }
    if (!Number.isFinite(risk.quantity) || risk.quantity <= 0) {
      auditReject(
        signal.symbol,
        "POSITION_SIZE",
        "risk engine returned invalid position quantity",
        {
          signalId: signal.id,
          confidence: signal.confidence,
          details: { quantity: risk.quantity },
        },
      );

      continue;
    }

    const quantity = risk.quantity;
    let exchangeOrderId: string | null = null;
  if (String(mode) === "live") {
      if (side !== "buy") {
        console.warn(
          `[BINANCE_SPOT] refusing non-BUY live entry ` +
            `symbol=${signal.symbol} side=${side}`,
        );
        continue;
      }
      try {
        exchangeOrderId = await placeLiveOrder(signal.symbol, "buy", quantity);
      } catch (error) {
        console.error(`[BINANCE_SPOT] live BUY failed symbol=${signal.symbol}:`, error);

        audit.push(
          createExecutionAuditEvent(
            signal.symbol,
            "TRADE_INSERT",
            "ERROR",
            "live BUY order failed",
            {
              signalId: signal.id,
              confidence: signal.confidence,
              details: {
                message: error instanceof Error ? error.message : String(error),
                mode,
                side,
                quantity,
                price,
              },
            },
          ),
        );

        continue;
      }
    }
    const entryFee = price * quantity * TRADING_FEE_RATE;
    const tradeSession = classifyMarketSession(new Date());

    const { error: tradeErr } = await db.from("trades").insert({
      composite_signal_id: signal.id, symbol: signal.symbol, side,
      quantity, entry_price: price, stop_loss: stopLoss, take_profit: takeProfit,
      mode, status: "open", exchange_order_id: exchangeOrderId, entry_fee: entryFee,
      regime_label: currentRegimeLabel,
      market_session: tradeSession.session,
      source_tags: tagsFor(
        signal.symbol,
        execCtx,
        hotSymbolSet.has(signal.symbol) ? ["hot-whale"] : undefined,
      ),
    } as never);

    if (tradeErr) {
      const errorCode = (tradeErr as { code?: string }).code ?? "UNKNOWN";

      audit.push(
        createExecutionAuditEvent(
          signal.symbol,
          "TRADE_INSERT",
          "ERROR",
          "trade insert failed",
          {
            signalId: signal.id,
            confidence: signal.confidence,
            details: {
              code: errorCode,
              message:
                tradeErr instanceof Error ? tradeErr.message : String(tradeErr),
              mode,
              side,
              quantity,
              price,
            },
          },
        ),
      );

      console.error(
        `[TRADE_INSERT_FAILED] ${signal.symbol} ` +
          `signal_id=${signal.id} ` +
          `mode=${mode} ` +
          `side=${side} ` +
          `quantity=${quantity} ` +
          `price=${price} ` +
          `code=${errorCode}`,
        tradeErr,
      );

      if (errorCode === "23505") {
        console.warn(
          `[TRADE_INSERT_DUPLICATE] ${signal.symbol} ` +
            `signal_id=${signal.id}`,
        );
        continue;
      }

      throw tradeErr;
    }
    openSymbols.add(signal.symbol);
    opened += 1;

    audit.push(
      createExecutionAuditEvent(
        signal.symbol,
        "EXECUTION",
        "OPEN",
        "trade opened successfully",
        {
          signalId: signal.id,
          confidence: signal.confidence,
          details: {
            mode,
            side,
            quantity,
            entry_price: price,
            stop_loss: stopLoss,
            take_profit: takeProfit,
            exchange_order_id: exchangeOrderId,
          },
        },
      ),
    );
  }

  console.log(
    `[EXECUTION_DONE] opened=${opened} ` +
      `riskCandidates=${riskCandidates.length} ` +
      `openPositions=${openSymbols.size}`,
  );

  return {
    opened,
    audit,
  };
}

/* ───────────── Full pipeline ───────────── */

export async function runFullPipeline() {
  const db = await admin();
  const startedAt = new Date();
  const health = newPipelineHealth();
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
    // ─── Watchlist resolution ───
    step = "watchlist-resolve";
    invalidateWatchlistCache();
    const watchlistCtx = await resolveWatchlistContext();
    console.log(
      `[WATCHLIST] source=${watchlistCtx.meta.source} ` +
        `total=${watchlistCtx.symbols.length} ` +
        `pinned_always=${watchlistCtx.pinned_always.size} ` +
        `pinned_open=${watchlistCtx.pinned_open.size} ` +
        `revolutx=${watchlistCtx.revolutx.size} ` +
        `hl_dynamic=${watchlistCtx.hl_dynamic.size} ` +
        `(hl_candidates=${watchlistCtx.meta.hl_candidates}, ` +
        `binance_filtered=${watchlistCtx.meta.binance_filtered})`,
    );

    const hotCleaned = await cleanupHotWhales();
    if (hotCleaned > 0) console.log(`[HOT_WHALE] cleaned ${hotCleaned} stale entries`);

    // ─── Whales ───
    step = "whales";
    resetWhaleSourceHealth();
    const [hlWhales, exWhales, clWhales] = await Promise.all([
      collectWhaleAlerts(),
      collectExchangeWhaleAlerts(),
      collectCoinLobsterWhales(),
    ]);
    const whales = hlWhales + exWhales + clWhales;
    console.log(`[WHALES_TOTAL] hl=${hlWhales} binance=${exWhales} coinlobster=${clWhales} total=${whales}`);
    console.log(
      `[COIN_PROVENANCE] total=${watchlistCtx.symbols.length} ` +
        `revolutx=${watchlistCtx.revolutx.size} ` +
        `hl_dynamic=${watchlistCtx.hl_dynamic.size} ` +
        `always_include=${watchlistCtx.pinned_always.size} ` +
        `open_positions=${watchlistCtx.pinned_open.size}`,
    );

    const whaleHealth = whaleSourceSnapshot();
    const allWhaleSourcesFailed = Object.values(whaleHealth).every((s) => s.state === "error");
    if (allWhaleSourcesFailed) {
      health.whalesFailed = true;
      health.degraded = true;
      health.degradedReasons.push("all whale sources failed");
      await emitFeedAlert(
        db,
        "feed_error",
        "CRITICAL: All whale sources failed",
        { symbol: null, tags: [] },
      );
    } else if (whales === 0) {
      console.log("[WHALES_EMPTY] Sources responded, but no qualifying whale trade was found in this cycle.");
    }

    // ─── Indicators ───
    step = "indicators";
    const indicators = await collectIndicators();
    if (indicators === 0) {
      health.indicatorsFailed = true;
      health.degraded = true;
      health.degradedReasons.push("indicators=0 (all sources failed)");
      await emitFeedAlert(
        db,
        "feed_error",
        "CRITICAL: Indicators collection returned 0 — Binance/Bybit market data unavailable",
        { symbol: null, tags: [] },
      );
    }

    // ─── Predictions ───
    step = "predictions";
    const predictions = await collectPredictions();

    // ─── Council ───
    step = "council";
    const council = await collectCouncilSignals();

    // ─── Auto-strategy ───
    step = "auto-strategy";
    try {
      const autoSwitch = await maybeAutoSwitchStrategy();
      if (autoSwitch.switched) {
        console.log(`[AUTO_SWITCH] Applied ${autoSwitch.preset}: ${autoSwitch.reasoning} (source=${autoSwitch.source ?? "unknown"})`);
        invalidateStrategyCache();
      } else {
        console.log(`[AUTO_SWITCH] Skipped: ${autoSwitch.reason}`);
      }
    } catch (e) {
      console.error("[AUTO_SWITCH] non-fatal error:", e);
    }

    // ─── Signals ───
    step = "signals";
    const signals = await combineSignals();

    // ─── Variants ───
    step = "resolve-variants";
    const resolvedVariants = await resolveVariantOutcomes();
    if (resolvedVariants > 0) console.log(`[VARIANTS] Resolved ${resolvedVariants} variant outcomes`);

    // ─── Global risk (GTP + ETS) ───
    step = "global-risk";
    let globalRiskTriggered = false;
    try {
      const prices = await allBinancePrices();
      const globalRisk = await evaluateGlobalRisk(
        db,
        currentRegimeLabel,
        null,
        classifyMarketSession(new Date()),
        prices,
      );
      if (globalRisk.evaluated) {
        console.log(
          `[GLOBAL_RISK] evaluated — ${globalRisk.reasoning}` +
            (globalRisk.triggered ? ` → ${globalRisk.shadow ? "SHADOW" : "LIVE"} ${globalRisk.trigger_type}` : ""),
        );
      }
      globalRiskTriggered = globalRisk.triggered && !globalRisk.shadow;
    } catch (e) {
      console.error("[GLOBAL_RISK] non-fatal error:", e);
    }

    // ─── Trades ───
    step = "trades";
    // Whale feed is an optional signal source; only critical market data
  // failure should force close-only execution mode.
  const circuitBreakerOpen = health.indicatorsFailed;
    let trades = 0;
    let executionAudit: ExecutionAuditEvent[] = [];
    if (circuitBreakerOpen) {
      console.warn(`[CIRCUIT_BREAKER] OPEN — skipping new entries. Reasons: ${health.degradedReasons.join("; ")}`);
      await emitFeedAlert(
        db,
        "circuit_breaker",
        `Circuit breaker OPEN — close-only mode. Reasons: ${health.degradedReasons.join("; ")}`,
        { symbol: null, tags: [] },
      );
    }

    const executionResult = await executeTrades({
      skipNewEntries: circuitBreakerOpen,
    });
    trades = executionResult.opened;
    executionAudit = executionResult.audit;

    const mode = tradingMode();

    // ─── Post-mortem ───
    step = "post-mortem";
    const learning = await generatePostMortems();
    if (learning.generated > 0) console.log(`[LESSON] Generated ${learning.generated} new lessons`);
    if (learning.status !== "ok") console.warn(`[LESSON] AI status: ${learning.status} — ${learning.error ?? "unknown"}`);

    const completedAt = new Date();
    const finalStatus = health.degraded ? "degraded" : "success";
    const errorMessage = health.degraded ? `DEGRADED: ${health.degradedReasons.join("; ")}` : null;

    // Only real pipeline_runs columns. Non-column data (e.g. whale health)
    // belongs inside the `result` jsonb.
    const summary = {
      completed_at: completedAt.toISOString(),
      duration_ms: completedAt.getTime() - startedAt.getTime(),
      status: finalStatus,
      whales, indicators, predictions, council, signals, trades,
      variants_resolved: resolvedVariants,
      mode,
      error_message: errorMessage,
      ai_status: learning.status,
      ai_error: learning.error,
      ai_lessons_generated: learning.generated,
    };

    const executionAuditPayload = {
      version: 1,
      generated_at: completedAt.toISOString(),
      summary: {
        opened: trades,
        audit_events: executionAudit.length,
        rejected: executionAudit.filter((x) => x.decision === "REJECT").length,
        errors: executionAudit.filter((x) => x.decision === "ERROR").length,
      },
      events: executionAudit,
    };

    if (globalRiskTriggered) console.warn(`[GLOBAL_RISK] trigger fired this run — cooldown active`);
    console.log(`[PIPELINE_DONE] watchlist_size=${watchlistCtx.symbols.length} source=${watchlistCtx.meta.source}`);

    let persistenceError: string | null = null;
    if (runId) {
      const { error: updateError } = await db
        .from("pipeline_runs")
        .update({
          ...summary,
          result: {
            execution_audit: executionAuditPayload,
            whale_health: whaleHealth,
          },
        } as never)
        .eq("id", runId);

      if (updateError) {
        const code = (updateError as { code?: string }).code ?? "unknown";
        console.error(
          `[PIPELINE_PERSIST] primary update failed code=${code} message=${updateError.message}`,
        );
        // Minimal fallback: only known pipeline_runs columns, no result jsonb.
        const { error: fallbackError } = await db
          .from("pipeline_runs")
          .update(summary as never)
          .eq("id", runId);
        if (fallbackError) {
          const fbCode = (fallbackError as { code?: string }).code ?? "unknown";
          console.error(
            `[PIPELINE_PERSIST] fallback update failed code=${fbCode} message=${fallbackError.message}`,
          );
          persistenceError = `primary(${code}): ${updateError.message}; fallback(${fbCode}): ${fallbackError.message}`;
        } else {
          console.warn("[PIPELINE_PERSIST] fallback update succeeded (result jsonb not saved)");
        }
      }
    }
    return {
      whales, indicators, predictions, council, signals, trades, mode,
      degraded: health.degraded,
      degraded_reasons: health.degradedReasons,
      ...(persistenceError ? { persistence_error: persistenceError } : {}),
    };
  } catch (e) {
    const raw = serializeError(e);
    const message = `[step: ${step}] ${raw}`;
    const completedAt = new Date();
    console.error(`[PIPELINE_FAILED] ${message}`);

    const isTimeout = /timed?\s*out|timeout|abort/i.test(message);
    await emitFeedAlert(
      db,
      "feed_error",
      `${isTimeout ? "PIPELINE_TIMEOUT" : "PIPELINE_ERROR"}: ${message}`,
      { symbol: null, tags: [] },
    );

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
      if (updateError) console.error("failed to record pipeline error", updateError);
    }
    throw new Error(message);
  }
}

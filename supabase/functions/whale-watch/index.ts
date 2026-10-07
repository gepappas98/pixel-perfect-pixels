import { handleOptions, corsHeaders } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const CORE_ALWAYS_INCLUDE = ["BTC", "ETH", "SOL"];
const CORE_FALLBACK_WATCHLIST = ["BTC","ETH","SOL","CRV","LINK","ARB","DOGE","XRP","AVAX","ADA","MATIC"];
const REVOLUTX_DISCOVERED_SYMBOLS = ["TON","ONDO","ENA","PENDLE","EIGEN","HYPE","BERA","KAITO","VIRTUAL","AERO","RAY","MORPHO","PENGU","TRUMP","JASMY"];

const MAX_COINS = 150;
const ADD_THRESHOLD_USD = 5_000_000;
const REMOVE_THRESHOLD_USD = 3_000_000;
const STABILITY_HOURS = 6;
const TOP_MOVERS_COUNT = 25;
const TRADES_PER_COIN = 200;
const MAX_CONCURRENCY = 10;

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
const HL_FLOOR_MULTIPLIER = 2;
const hlWhaleFloor = (coin: string) => whaleFloor(coin) * HL_FLOOR_MULTIPLIER;

const HOT_THRESHOLD_USD = 25_000;
const HOT_MAX_USD_PER_SYMBOL = 5_000_000;
const COINLOBSTER_MIN_USD = 100_000;
const COINLOBSTER_PRIORITY_COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE"];

type SourceState = { state: "ok" | "empty" | "error"; requests: number; qualifying: number; errors: number; http_status?: number; message?: string };
const health: Record<string, SourceState> = {
  hyperliquid: { state: "empty", requests: 0, qualifying: 0, errors: 0 },
  binance: { state: "empty", requests: 0, qualifying: 0, errors: 0 },
  bybit: { state: "empty", requests: 0, qualifying: 0, errors: 0 },
  coinlobster: { state: "empty", requests: 0, qualifying: 0, errors: 0 },
};

interface HyperliquidTrade { coin?: string; px: string; sz: string; side: "B" | "A"; time: number; tid: number; hash?: string; }
interface BinanceAggTrade { a: number; p: string; q: string; T: number; m: boolean; }
interface BybitRecentTrade { execId?: string; symbol?: string; price?: string; size?: string; side?: string; time?: string; }
interface CoinLobsterTrade {
  tradeId?: string; pair?: string; exchange?: string; exchangeType?: string;
  price?: number; quantity_base?: number; quantity_quote?: number;
  isBuy?: boolean; timestamp?: number; _src?: string; [key: string]: unknown;
}

async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = MAX_CONCURRENCY): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try { results[idx] = await fn(items[idx]!); }
      catch (e) { console.error("[pMap] task failed", e); results[idx] = undefined as unknown as R; }
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchHyperliquidUniverse() {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }), signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Hyperliquid metaAndAssetCtxs error: ${res.status}`);
  const [meta, ctxs] = await res.json();
  const all = new Set<string>();
  const ranked: { coin: string; vol: number }[] = [];
  for (const [i, asset] of (meta?.universe ?? []).entries()) {
    const name = asset?.name;
    if (!name || name.startsWith("@")) continue;
    all.add(name);
    ranked.push({ coin: name, vol: Number.parseFloat(ctxs?.[i]?.dayNtlVlm ?? "0") || 0 });
  }
  ranked.sort((a, b) => b.vol - a.vol);
  return { all, top: ranked.slice(0, TOP_MOVERS_COUNT).map((x) => x.coin) };
}

async function fetchBinanceUSDTBases(): Promise<Set<string>> {
  try {
    const res = await fetch("https://api.binance.com/api/v3/exchangeInfo", { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`Binance exchangeInfo error: ${res.status}`);
    const json = await res.json();
    return new Set((json?.symbols ?? []).filter((s: any) => s.quoteAsset === "USDT" && s.status === "TRADING").map((s: any) => s.baseAsset));
  } catch (e) {
    console.warn("[WATCHLIST] Binance exchangeInfo unavailable; keeping previous/pinned symbols", e);
    return new Set();
  }
}

async function fetchRecentTrades(coin: string): Promise<HyperliquidTrade[]> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "recentTrades", coin }), signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Hyperliquid recentTrades error for ${coin}: ${res.status}`);
  const trades = await res.json();
  return Array.isArray(trades) ? trades.slice(0, TRADES_PER_COIN) : [];
}

async function fetchBinanceAggTrades(symbol: string): Promise<BinanceAggTrade[] | null> {
  const hosts = ["https://api.binance.com", "https://data-api.binance.vision"];
  for (const host of hosts) {
    try {
      const res = await fetch(`${host}/api/v3/aggTrades?symbol=${symbol}&limit=1000`, { signal: AbortSignal.timeout(12000) });
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      }
      health.binance.http_status = res.status;
    } catch (e) {
      health.binance.message = e instanceof Error ? e.message : String(e);
    }
  }
  return null;
}

async function fetchBybitRecentTrades(symbol: string, limit = 60): Promise<BybitRecentTrade[]> {
  try {
    const url = new URL("https://" + "api.bybit.com/v5/market/recent-trade");
    url.searchParams.set("category", "spot");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("limit", String(Math.min(limit, 60)));
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const json = await res.json();
    return json?.retCode === 0 && Array.isArray(json?.result?.list) ? json.result.list : [];
  } catch { return []; }
}

async function fetchCoinLobsterWhales(coin?: string, limit = 50): Promise<CoinLobsterTrade[] | null> {
  const url = new URL("https://" + "coinlobster.com/api/public/crypto-whales");
  if (coin) url.searchParams.set("coin", coin);
  url.searchParams.set("limit", String(Math.min(limit, 50)));
  try {
    const res = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const json = await res.json();
    const trades = Array.isArray(json) ? json : Array.isArray(json?.whales) ? json.whales : Array.isArray(json?.data) ? json.data : Array.isArray(json?.trades) ? json.trades : null;
    return Array.isArray(trades) ? trades : null;
  } catch (e) {
    console.error("[COINLOBSTER] fetch failed:", e);
    return null;
  }
}

function normalizeCoinLobster(raw: CoinLobsterTrade) {
  const rawPair = String(raw.pair ?? "");
  const symbol = (rawPair.includes("/") ? rawPair.split("/")[0] : rawPair).toUpperCase().trim();
  if (!symbol || typeof raw.isBuy !== "boolean") return null;
  let usd = Number(raw.quantity_quote ?? 0);
  if (!Number.isFinite(usd) || usd <= 0) usd = Number(raw.price ?? 0) * Number(raw.quantity_base ?? 0);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const ts = Number(raw.timestamp ?? Date.now());
  const isDex = raw._src === "dex" || String(raw.exchange ?? "").toLowerCase().includes("dex");
  const venue = String(raw.exchange ?? "cex").toLowerCase().replace(/\s+/g, "-");
  return {
    symbol, chain: isDex ? `dex-${venue}` : `cex-${venue}`,
    direction: raw.isBuy ? "accumulation" : "distribution",
    usd_value: Math.round(usd * 100) / 100,
    tx_hash: String(raw.tradeId ?? `${venue}-${symbol}-${ts}-${Math.round(usd)}`),
    source: isDex ? "coinlobster-dex" : "coinlobster-cex",
    created_at: new Date(ts < 1e12 ? ts * 1000 : ts).toISOString(),
    raw,
  };
}

async function loadPreviousSnapshot(supabase: ReturnType<typeof getServiceClient>) {
  const { data, error } = await supabase.from("dynamic_watchlist_snapshots")
    .select("symbols,hl_candidates,hl_above_threshold,binance_filtered,pinned_symbols,dynamic_symbols,computed_at,expires_at")
    .order("computed_at", { ascending: false }).limit(1).maybeSingle();
  if (error) { console.error("[WATCHLIST] snapshot read failed:", error); return null; }
  return data;
}

async function loadOpenPositions(supabase: ReturnType<typeof getServiceClient>) {
  const { data, error } = await supabase.from("trades").select("symbol").eq("status", "open");
  if (error) { console.error("[WATCHLIST] open-position read failed:", error); return new Set<string>(); }
  return new Set((data ?? []).map((r: { symbol: string }) => r.symbol));
}

async function resolveWatchlist(supabase: ReturnType<typeof getServiceClient>) {
  const previous = await loadPreviousSnapshot(supabase);
  const openPositions = await loadOpenPositions(supabase);
  const now = Date.now();

  if (previous?.expires_at && new Date(previous.expires_at).getTime() > now) {
    const symbols = [...(previous.symbols ?? [])];
    const seen = new Set(symbols);
    for (const symbol of openPositions) if (!seen.has(symbol)) { symbols.push(symbol); seen.add(symbol); }
    return {
      symbols: symbols.slice(0, MAX_COINS + openPositions.size),
      source: "cache", hlCandidates: previous.hl_candidates ?? 0,
      hlAboveThreshold: previous.hl_above_threshold ?? 0, binanceFiltered: previous.binance_filtered ?? 0,
      pinned: [...new Set([...CORE_ALWAYS_INCLUDE, ...openPositions])], dynamic: previous.dynamic_symbols ?? [],
    };
  }

  let volume: Map<string, number>;
  try {
    const u = await fetchHyperliquidUniverse();
    volume = new Map([...u.all].map((s) => [s, 0]));
    for (const [coin, vol] of (u.top ?? []).map((s) => [s, 0] as [string, number])) volume.set(coin, vol);
    // Re-read exact volumes for ranking when refreshing.
    const res = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }), signal: AbortSignal.timeout(12000) });
    const [meta, ctxs] = await res.json();
    volume = new Map<string, number>();
    for (const [i, asset] of (meta?.universe ?? []).entries()) if (asset?.name && !String(asset.name).startsWith("@")) volume.set(asset.name, Number.parseFloat(ctxs?.[i]?.dayNtlVlm ?? "0") || 0);
  } catch (e) {
    console.error("[WATCHLIST] Hyperliquid universe refresh failed:", e);
    volume = new Map<string, number>();
  }

  const binance = await fetchBinanceUSDTBases();
  const previousSymbols = new Set(previous?.symbols ?? []);
  const eligible = [...volume.entries()].filter(([symbol, v]) => {
    const threshold = previousSymbols.has(symbol) ? REMOVE_THRESHOLD_USD : ADD_THRESHOLD_USD;
    return v >= threshold && (binance.size === 0 || binance.has(symbol));
  }).sort((a, b) => b[1] - a[1]);

  const pinned = new Set([...CORE_ALWAYS_INCLUDE, ...openPositions, ...REVOLUTX_DISCOVERED_SYMBOLS.filter((s) => binance.size === 0 || binance.has(s))]);
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const s of pinned) if (!seen.has(s)) { seen.add(s); symbols.push(s); }
  for (const [symbol] of eligible) {
    if (symbols.length >= MAX_COINS) break;
    if (!seen.has(symbol)) { seen.add(symbol); symbols.push(symbol); }
  }

  const dynamic = symbols.filter((s) => !pinned.has(s));
  const expiresAt = new Date(now + STABILITY_HOURS * 3600000).toISOString();
  const { error: insertError } = await supabase.from("dynamic_watchlist_snapshots").insert({
    symbols, source: "refreshed", hl_candidates: volume.size,
    hl_above_threshold: eligible.length, binance_filtered: eligible.length,
    pinned_symbols: [...pinned], dynamic_symbols: dynamic, expires_at: expiresAt,
  });
  if (insertError) console.error("[WATCHLIST] snapshot insert failed:", insertError);

  return { symbols, source: "refreshed", hlCandidates: volume.size, hlAboveThreshold: eligible.length, binanceFiltered: eligible.length, pinned: [...pinned], dynamic };
}

async function recordHotWhale(supabase: ReturnType<typeof getServiceClient>, symbol: string, usd: number, isBuy: boolean, source: string) {
  const cleanUsd = Math.min(Math.max(Number(usd) || 0, 0), HOT_MAX_USD_PER_SYMBOL);
  if (cleanUsd < HOT_THRESHOLD_USD) return;
  try {
    const { error } = await (supabase.rpc as any)("record_hot_whale", { p_symbol: symbol, p_usd: cleanUsd, p_is_buy: isBuy, p_source: source });
    if (error) console.warn(`[HOT_WHALE] record failed for ${symbol}: ${error.message}`);
  } catch (e) { console.warn(`[HOT_WHALE] record threw for ${symbol}:`, e); }
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const supabase = getServiceClient();
    const watchlist = await resolveWatchlist(supabase);
    const watchSet = new Set(watchlist.symbols);

    // ── 1. Hyperliquid: active watchlist + top 25 volume movers ──
    health.hyperliquid.requests++;
    let hlUniverse: { all: Set<string>; top: string[] } = { all: new Set(), top: [] };
    try { hlUniverse = await fetchHyperliquidUniverse(); }
    catch (e) { health.hyperliquid.errors++; health.hyperliquid.message = e instanceof Error ? e.message : String(e); }

    const baseCoins = watchlist.symbols.filter((c) => hlUniverse.all.has(c));
    const hlCoins = [...new Set([...baseCoins, ...hlUniverse.top])];
    const hlResults = await pMap(hlCoins, async (coin) => {
      try {
        const trades = await fetchRecentTrades(coin);
        const source = watchSet.has(coin) ? "hyperliquid-recent-trades" : "hyperliquid-top-mover";
        const floor = watchSet.has(coin) ? hlWhaleFloor(coin) : whaleFloor(coin);
        return trades.flatMap((t) => {
          const usd = Number(t.px) * Number(t.sz);
          if (!Number.isFinite(usd) || usd < floor) return [];
          return [{ symbol: coin, chain: "hyperliquid-perp", direction: t.side === "B" ? "accumulation" : "distribution", usd_value: usd, tx_hash: t.hash ?? String(t.tid), source, created_at: new Date(t.time).toISOString(), raw: t }];
        });
      } catch (e) {
        health.hyperliquid.errors++;
        health.hyperliquid.message = e instanceof Error ? e.message : String(e);
        console.error(`[HL] whale fetch failed for ${coin}`, e);
        return [];
      }
    });
    const hlRows = hlResults.flat();
    health.hyperliquid.qualifying = hlRows.length;
    health.hyperliquid.state = health.hyperliquid.errors === 0 ? (hlRows.length ? "ok" : "empty") : (health.hyperliquid.requests > health.hyperliquid.errors ? "ok" : "error");

    // Hot queue parity: capture non-watchlist HL whales immediately.
    const hotCandidates = hlRows.filter((r) => !watchSet.has(r.symbol) && Number(r.usd_value) >= HOT_THRESHOLD_USD);
    const hotBySymbol = new Map<string, { usd: number; isBuy: boolean; source: string }>();
    for (const r of hotCandidates) {
      const prev = hotBySymbol.get(r.symbol);
      if (!prev || Number(r.usd_value) > prev.usd) hotBySymbol.set(r.symbol, { usd: Number(r.usd_value), isBuy: r.direction === "accumulation", source: r.source });
    }
    await Promise.all([...hotBySymbol.entries()].slice(0, 50).map(([symbol, v]) => recordHotWhale(supabase, symbol, v.usd, v.isBuy, v.source)));

    // ── 2. Binance Spot + exact old Bybit fallback ──
    const exResults = await pMap(watchlist.symbols, async (coin) => {
      const symbol = `${coin === "MATIC" ? "POL" : coin === "RNDR" ? "RENDER" : coin}USDT`;
      health.binance.requests++;
      const out: any[] = [];
      try {
        const parsed = await fetchBinanceAggTrades(symbol);
        if (parsed) {
          health.binance.state = "ok";
          for (const t of parsed) {
            const usd = Number(t.p) * Number(t.q);
            if (!Number.isFinite(usd) || usd < whaleFloor(coin)) continue;
            out.push({ symbol: coin, chain: "binance-spot", direction: t.m ? "distribution" : "accumulation", usd_value: usd, tx_hash: String(t.a), source: "binance-agg-trades", created_at: new Date(t.T).toISOString(), raw: t });
          }
          return out;
        }

        health.binance.errors++;
        health.binance.state = "error";
        health.bybit.requests++;
        const fallback = await fetchBybitRecentTrades(symbol, 60);
        health.bybit.state = "ok";
        for (const t of fallback) {
          const usd = Number(t.price) * Number(t.size);
          if (!Number.isFinite(usd) || usd < whaleFloor(coin)) continue;
          out.push({ symbol: coin, chain: "bybit-spot", direction: String(t.side ?? "").toLowerCase() === "buy" ? "accumulation" : "distribution", usd_value: usd, tx_hash: String(t.execId ?? `bybit-${symbol}-${t.time}-${t.price}-${t.size}`), source: "bybit-recent-trades", created_at: new Date(Number(t.time ?? Date.now())).toISOString(), raw: t });
        }
      } catch (e) {
        health.binance.errors++;
        health.bybit.errors++;
        health.bybit.state = "error";
        health.binance.message = e instanceof Error ? e.message : String(e);
      }
      return out;
    });
    const exRows = exResults.flat();
    health.binance.qualifying = exRows.filter((r) => r.source === "binance-agg-trades").length;
    health.bybit.qualifying = exRows.filter((r) => r.source === "bybit-recent-trades").length;
    if (health.bybit.requests > 0 && health.bybit.errors === 0) health.bybit.state = "ok";

    // ── 3. CoinLobster: global + priority coins, as in the old collector ──
    health.coinlobster.requests++;
    const [globalTrades, ...coinBatches] = await Promise.all([
      fetchCoinLobsterWhales(undefined, 50),
      ...COINLOBSTER_PRIORITY_COINS.map((c) => fetchCoinLobsterWhales(c, 30)),
    ]);
    const allRaw = [ ...(globalTrades ?? []), ...coinBatches.flatMap((b) => b ?? []) ];
    const clSeen = new Set<string>();
    const clRows: any[] = [];
    for (const raw of allRaw) {
      const norm = normalizeCoinLobster(raw);
      if (!norm || norm.usd_value < COINLOBSTER_MIN_USD || !watchSet.has(norm.symbol) || clSeen.has(norm.tx_hash)) continue;
      clSeen.add(norm.tx_hash);
      clRows.push(norm);
    }
    health.coinlobster.qualifying = clRows.length;
    health.coinlobster.state = clRows.length ? "ok" : "empty";

    const rows = [...hlRows, ...exRows, ...clRows];
    let inserted = 0;
    if (rows.length) {
      const { data, error } = await supabase.from("whale_alerts").upsert(rows, { onConflict: "source,tx_hash", ignoreDuplicates: true }).select("id");
      if (error) throw error;
      inserted = data?.length ?? 0;
    }

    console.log(`[WHALES_TOTAL] hl=${hlRows.length} binance=${health.binance.qualifying} bybit=${health.bybit.qualifying} coinlobster=${clRows.length} total=${rows.length} inserted=${inserted}`);
    return new Response(JSON.stringify({
      inserted, candidate_rows: rows.length, alerts: rows,
      sources: health,
      scanned_coins: hlCoins,
      watchlist: {
        total: watchlist.symbols.length, source: watchlist.source,
        hl_candidates: watchlist.hlCandidates, hl_above_threshold: watchlist.hlAboveThreshold,
        binance_filtered: watchlist.binanceFiltered, pinned: watchlist.pinned, dynamic: watchlist.dynamic.length,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" }});
  } catch (err) {
    console.error("[WHALE_WATCH] fatal:", err);
    return new Response(JSON.stringify({ error: String(err), sources: health }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }});
  }
});

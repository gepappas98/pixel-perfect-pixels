import { handleOptions, corsHeaders } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const CORE_ALWAYS_INCLUDE = ["BTC", "ETH", "SOL"];
const CORE_FALLBACK_WATCHLIST = ["BTC","ETH","SOL","CRV","LINK","ARB","DOGE","XRP","AVAX","ADA","MATIC"];
const REVOLUTX_DISCOVERED_SYMBOLS = ["TON","ONDO","ENA","PENDLE","EIGEN","HYPE","BERA","KAITO","VIRTUAL","AERO","RAY","MORPHO","PENGU","TRUMP","JASMY"];

const MAX_COINS = 150;
const ADD_THRESHOLD_USD = 5_000_000;
const REMOVE_THRESHOLD_USD = 3_000_000;
const STABILITY_HOURS = 6;
const TOP_WHALE_SCAN = 50;
const TRADES_PER_COIN = 200;

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

interface HyperliquidTrade {
  coin?: string; px: string; sz: string; side: "B" | "A";
  time: number; tid: number; hash?: string;
}

async function fetchHyperliquidUniverse() {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Hyperliquid metaAndAssetCtxs error: ${res.status}`);
  const [meta, ctxs] = await res.json();
  const volume = new Map<string, number>();
  for (const [i, asset] of (meta?.universe ?? []).entries()) {
    const name = asset?.name;
    if (!name || name.startsWith("@")) continue;
    volume.set(name, Number.parseFloat(ctxs?.[i]?.dayNtlVlm ?? "0") || 0);
  }
  return volume;
}

async function fetchBinanceUSDTBases() {
  const res = await fetch("https://api.binance.com/api/v3/exchangeInfo", {
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Binance exchangeInfo error: ${res.status}`);
  const json = await res.json();
  const set = new Set<string>();
  for (const s of json?.symbols ?? []) {
    if (s.quoteAsset === "USDT" && s.status === "TRADING") set.add(s.baseAsset);
  }
  return set;
}

async function fetchRecentTrades(coin: string): Promise<HyperliquidTrade[]> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "recentTrades", coin }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Hyperliquid recentTrades error for ${coin}: ${res.status}`);
  const trades = await res.json();
  return Array.isArray(trades) ? trades.slice(0, TRADES_PER_COIN) : [];
}

async function loadPreviousSnapshot(supabase: ReturnType<typeof getServiceClient>) {
  const { data, error } = await supabase
    .from("dynamic_watchlist_snapshots")
    .select("symbols,hl_candidates,hl_above_threshold,binance_filtered,pinned_symbols,dynamic_symbols,computed_at,expires_at")
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[WATCHLIST] snapshot read failed:", error);
    return null;
  }
  return data;
}

async function loadOpenPositions(supabase: ReturnType<typeof getServiceClient>) {
  const { data, error } = await supabase.from("trades").select("symbol").eq("status", "open");
  if (error) {
    console.error("[WATCHLIST] open-position read failed:", error);
    return new Set<string>();
  }
  return new Set((data ?? []).map((r: {symbol: string}) => r.symbol));
}

async function resolveWatchlist(supabase: ReturnType<typeof getServiceClient>) {
  const previous = await loadPreviousSnapshot(supabase);
  const openPositions = await loadOpenPositions(supabase);
  const now = Date.now();

  if (previous?.expires_at && new Date(previous.expires_at).getTime() > now) {
    const symbols = [...(previous.symbols ?? [])];
    const seen = new Set(symbols);
    for (const symbol of openPositions) {
      if (!seen.has(symbol)) { symbols.push(symbol); seen.add(symbol); }
    }
    return {
      symbols: symbols.slice(0, MAX_COINS + openPositions.size),
      source: "cache",
      hlCandidates: previous.hl_candidates ?? 0,
      hlAboveThreshold: previous.hl_above_threshold ?? 0,
      binanceFiltered: previous.binance_filtered ?? 0,
      pinned: [...new Set([ ...CORE_ALWAYS_INCLUDE, ...openPositions ])],
      dynamic: previous.dynamic_symbols ?? [],
    };
  }

  const [volume, binance, previousOpen] = await Promise.all([
    fetchHyperliquidUniverse(),
    fetchBinanceUSDTBases(),
    Promise.resolve(openPositions),
  ]);

  const previousSymbols = new Set(previous?.symbols ?? []);
  const eligible = [...volume.entries()]
    .filter(([symbol, v]) => {
      const threshold = previousSymbols.has(symbol) ? REMOVE_THRESHOLD_USD : ADD_THRESHOLD_USD;
      return v >= threshold && binance.has(symbol);
    })
    .sort((a,b) => b[1] - a[1]);

  const pinned = new Set([...CORE_ALWAYS_INCLUDE, ...previousOpen, ...REVOLUTX_DISCOVERED_SYMBOLS.filter(s => binance.has(s))]);
  const symbols: string[] = [];
  const seen = new Set<string>();

  for (const s of pinned) {
    if (!seen.has(s)) { seen.add(s); symbols.push(s); }
  }
  for (const [symbol] of eligible) {
    if (symbols.length >= MAX_COINS) break;
    if (!seen.has(symbol)) { seen.add(symbol); symbols.push(symbol); }
  }

  const dynamic = symbols.filter(s => !pinned.has(s));
  const expiresAt = new Date(now + STABILITY_HOURS * 3600000).toISOString();

  const { error: insertError } = await supabase.from("dynamic_watchlist_snapshots").insert({
    symbols,
    source: "refreshed",
    hl_candidates: volume.size,
    hl_above_threshold: [...volume.entries()].filter(([s,v]) => v >= (previousSymbols.has(s) ? REMOVE_THRESHOLD_USD : ADD_THRESHOLD_USD)).length,
    binance_filtered: eligible.length,
    pinned_symbols: [...pinned],
    dynamic_symbols: dynamic,
    expires_at: expiresAt,
  });
  if (insertError) console.error("[WATCHLIST] snapshot insert failed:", insertError);

  console.log(`[WATCHLIST] source=refreshed total=${symbols.length} pinned=${pinned.size} hl_dynamic=${dynamic.length} hl_candidates=${volume.size} binance_filtered=${eligible.length}`);

  return {
    symbols,
    source: "refreshed",
    hlCandidates: volume.size,
    hlAboveThreshold: eligible.length,
    binanceFiltered: eligible.length,
    pinned: [...pinned],
    dynamic,
  };
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const supabase = getServiceClient();
    const watchlist = await resolveWatchlist(supabase);

    // Whale scanning remains bounded: dynamic universe selects the candidates,
    // while only the highest-volume 50 are queried for recent large prints.
    // Floors are aligned with the canonical TCC whale thresholds instead of a
    // single $100K gate, so legitimate lower-tier accumulation is not erased.
    const volumeOrder = [...watchlist.symbols];
    const pinnedSet = new Set(watchlist.pinned);
    const scanCoins = [
      ...pinnedSet,
      ...volumeOrder.filter((s) => !pinnedSet.has(s)),
    ].slice(0, TOP_WHALE_SCAN);

    const results = await Promise.all(
      scanCoins.map(async (coin) => {
        try {
          const trades = await fetchRecentTrades(coin);
          return trades.flatMap((t) => {
            const usdValue = Number.parseFloat(t.px) * Number.parseFloat(t.sz);
            if (!Number.isFinite(usdValue) || usdValue < whaleFloor(coin)) return [];
            return [{
              symbol: coin,
              chain: "hyperliquid-perp",
              direction: t.side === "B" ? "accumulation" : "distribution",
              usd_value: usdValue,
              wallet_address: null,
              tx_hash: t.hash ?? String(t.tid),
              source: pinnedSet.has(coin) ? "hyperliquid-dynamic-pinned" : "hyperliquid-dynamic-volume",
              created_at: Number.isFinite(t.time) ? new Date(t.time).toISOString() : new Date().toISOString(),
              raw: t,
            }];
          });
        } catch (e) {
          console.error(`[WHALE] skipping ${coin}:`, e);
          return [];
        }
      }),
    );
    const rows: any[] = results.flat();

    if (rows.length) {
      const { data, error } = await supabase
        .from("whale_alerts")
        .upsert(rows, { onConflict: "source,tx_hash", ignoreDuplicates: true })
        .select();
      if (error) throw error;
      return new Response(JSON.stringify({
        inserted: data.length,
        alerts: data,
        scanned_coins: scanCoins,
        watchlist: {
          total: watchlist.symbols.length,
          source: watchlist.source,
          hl_candidates: watchlist.hlCandidates,
          hl_above_threshold: watchlist.hlAboveThreshold,
          binance_filtered: watchlist.binanceFiltered,
          pinned: watchlist.pinned,
          dynamic: watchlist.dynamic.length,
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }});
    }

    return new Response(JSON.stringify({
      inserted: 0, alerts: [], scanned_coins: scanCoins,
      watchlist: {
        total: watchlist.symbols.length, source: watchlist.source,
        hl_candidates: watchlist.hlCandidates, hl_above_threshold: watchlist.hlAboveThreshold,
        binance_filtered: watchlist.binanceFiltered, pinned: watchlist.pinned,
        dynamic: watchlist.dynamic.length,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" }});
  } catch (err) {
    console.error("[WHALE_WATCH] fatal:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
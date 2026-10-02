/**
 * Watchlist Resolver — Dynamic universe selection from Hyperliquid.
 *
 * ┌────────────────────────────────────────────────────────────────┐
 * │  RESOLUTION FLOW                                               │
 * │                                                                │
 * │  1. Check cached snapshot in DB (dynamic_watchlist_snapshots)  │
 * │     If fresh (< STABILITY_HOURS), return it (with refreshed    │
 * │     pinned-open symbols only).                                 │
 * │                                                                │
 * │  2. Fetch Hyperliquid universe (1 call, ~60s cache):           │
 * │     POST /info {type: "metaAndAssetCtxs"}                      │
 * │     → 250+ coins with dayNtlVlm (24h notional USD)             │
 * │                                                                │
 * │  3. Apply volume filter with hysteresis:                       │
 * │     - New coin enters: volume >= ADD_THRESHOLD_USD             │
 * │     - Existing coin leaves: volume < REMOVE_THRESHOLD_USD      │
 * │     This prevents churn at the boundary.                       │
 * │                                                                │
 * │  4. Verify Binance listing (cached 24h):                       │
 * │     GET /api/v3/exchangeInfo → USDT pairs only, TRADING status │
 * │                                                                │
 * │  5. Merge pinned:                                              │
 * │     - CORE_ALWAYS_INCLUDE (BTC/ETH/SOL)                        │
 * │     - Open positions from trades table                         │
 * │                                                                │
 * │  6. Cap at MAX_COINS (150). Pinned always survive the cap.     │
 * │                                                                │
 * │  7. Persist snapshot + return WatchlistContext.                │
 * └────────────────────────────────────────────────────────────────┘
 *
 * Why this design:
 *   - Pipeline fetches candles for 150 coins MAX, regardless of how many
 *     exist on Hyperliquid. Load is bounded and predictable.
 *   - New hot coins enter automatically within STABILITY_HOURS.
 *   - Dead coins drop out automatically, saving API calls.
 *   - Pinned symbols guarantee we never lose track of open positions.
 *   - Hysteresis prevents oscillation at the threshold boundary.
 */

import {
  CORE_ALWAYS_INCLUDE,
  CORE_FALLBACK_WATCHLIST,
  REVOLUTX_DISCOVERED_SYMBOLS,
} from "./coin-provenance";

type Admin = Awaited<
  typeof import("@/integrations/supabase/client.server")
>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/* ───────────── Tunables ───────────── */

/** Hard cap on dynamic watchlist size. */
export const MAX_COINS = 150;

/** Volume ≥ this to ENTER the list (24h notional, USD). */
export const ADD_THRESHOLD_USD = 5_000_000;

/** Volume < this to LEAVE the list. Lower than ADD_THRESHOLD_USD to
 *  create a hysteresis band and avoid flip-flopping. */
export const REMOVE_THRESHOLD_USD = 3_000_000;

/** How long a resolved snapshot stays authoritative. */
export const STABILITY_HOURS = 6;

/** In-memory cache TTL — prevents redundant DB queries within one pipeline. */
const MEMORY_TTL_MS = 60_000;

/* ───────────── Public types ───────────── */

export interface WatchlistContext {
  /** Final list — length ≤ MAX_COINS + pinned extras. */
  symbols: string[];
  /** Core symbols from CORE_ALWAYS_INCLUDE (BTC/ETH/SOL). */
  pinned_always: Set<string>;
  /** Symbols with an open trade row (must remain tracked). */
  pinned_open: Set<string>;
  /** Symbols manually curated via RevolutX expander. */
  revolutx: Set<string>;
  /** Symbols auto-added by this resolver based on HL volume. */
  hl_dynamic: Set<string>;
  /** Cold-start fallback list membership (rare). */
  core_fallback: Set<string>;
  /** Metadata for logging. */
  meta: {
    source: "cache" | "refreshed" | "fallback_static";
    computed_at: string;
    expires_at: string;
    hl_candidates: number;
    hl_above_threshold: number;
    binance_filtered: number;
  };
}

/* ───────────── Tag helper ───────────── */

/**
 * Compute provenance tags for a symbol given the current context.
 *
 * Order matters for readability in logs and UI.
 */
export function tagsFor(symbol: string, ctx: WatchlistContext): string[] {
  const tags: string[] = [];
  if (ctx.revolutx.has(symbol)) tags.push("revolutx");
  if (ctx.pinned_always.has(symbol)) tags.push("always-include");
  if (ctx.pinned_open.has(symbol)) tags.push("open-position");
  if (ctx.hl_dynamic.has(symbol)) tags.push("hl-dynamic");
  if (ctx.core_fallback.has(symbol)) tags.push("core-fallback");
  return tags.length > 0 ? tags : ["unknown"];
}

/* ───────────── Hyperliquid fetch ───────────── */

interface HyperliquidUniverseVolume {
  all: Set<string>;
  volume: Map<string, number>; // symbol → dayNtlVlm USD
  ts: number;
}

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const HL_CACHE_TTL_MS = 60_000;
let hlCache: HyperliquidUniverseVolume | null = null;

async function fetchHyperliquidVolume(): Promise<HyperliquidUniverseVolume> {
  const now = Date.now();
  if (hlCache && now - hlCache.ts < HL_CACHE_TTL_MS) return hlCache;

  try {
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HL HTTP ${res.status}`);

    const [meta, ctxs] = (await res.json()) as [
      { universe: { name: string }[] },
      { dayNtlVlm?: string }[],
    ];

    const all = new Set<string>();
    const volume = new Map<string, number>();

    meta.universe.forEach((u, i) => {
      const name = u.name;
      // Skip Hyperliquid internal spot-pair prefixes
      if (!name || name.startsWith("@")) return;
      all.add(name);
      const v = parseFloat(ctxs[i]?.dayNtlVlm ?? "0") || 0;
      volume.set(name, v);
    });

    if (all.size === 0) {
      console.error("[WATCHLIST_RESOLVER] HL returned empty universe");
      return { all: new Set(), volume: new Map(), ts: 0 };
    }

    hlCache = { all, volume, ts: now };
    return hlCache;
  } catch (e) {
    console.error("[WATCHLIST_RESOLVER] HL volume fetch failed:", e);
    return { all: new Set(), volume: new Map(), ts: 0 };
  }
}

/* ───────────── Binance symbol list ───────────── */

interface BinanceSymbolSet {
  symbols: Set<string>; // base assets with USDT pair
  ts: number;
}

const BINANCE_EXCHANGE_INFO_URL = "https://api.binance.com/api/v3/exchangeInfo";
const BINANCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
let binanceCache: BinanceSymbolSet | null = null;

async function fetchBinanceUSDTBases(): Promise<Set<string>> {
  const now = Date.now();
  if (binanceCache && now - binanceCache.ts < BINANCE_CACHE_TTL_MS) {
    return binanceCache.symbols;
  }

  try {
    const res = await fetch(BINANCE_EXCHANGE_INFO_URL, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);

    const json = (await res.json()) as {
      symbols: { baseAsset: string; quoteAsset: string; status: string }[];
    };

    const symbols = new Set<string>();
    for (const s of json.symbols) {
      if (s.quoteAsset === "USDT" && s.status === "TRADING") {
        symbols.add(s.baseAsset);
      }
    }

    if (symbols.size === 0) {
      console.error("[WATCHLIST_RESOLVER] Binance returned empty symbol list");
      return new Set();
    }

    binanceCache = { symbols, ts: now };
    return symbols;
  } catch (e) {
    console.error("[WATCHLIST_RESOLVER] Binance exchangeInfo failed:", e);
    // Fall back to previous cache even if stale
    return binanceCache?.symbols ?? new Set();
  }
}

/* ───────────── DB helpers ───────────── */

interface SnapshotRow {
  symbols: string[];
  source: string;
  hl_candidates: number;
  hl_above_threshold: number;
  binance_filtered: number;
  pinned_symbols: string[];
  dynamic_symbols: string[];
  computed_at: string;
  expires_at: string;
}

async function loadLatestSnapshot(db: Admin): Promise<SnapshotRow | null> {
  const { data, error } = await db
    .from("dynamic_watchlist_snapshots")
    .select("*")
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // Table might not exist yet on first run — silently return null
    if (!error.message?.includes("does not exist")) {
      console.error("[WATCHLIST_RESOLVER] snapshot load failed:", error);
    }
    return null;
  }
  return (data as SnapshotRow | null) ?? null;
}

async function loadPinnedOpenPositions(db: Admin): Promise<Set<string>> {
  const { data, error } = await db
    .from("trades")
    .select("symbol")
    .eq("status", "open");

  if (error) {
    console.error("[WATCHLIST_RESOLVER] open positions load failed:", error);
    return new Set();
  }
  return new Set(
    ((data ?? []) as { symbol: string }[]).map((r) => r.symbol),
  );
}

async function persistSnapshot(
  db: Admin,
  args: {
    symbols: string[];
    source: "refreshed" | "fallback_static";
    hl_candidates: number;
    hl_above_threshold: number;
    binance_filtered: number;
    pinned_symbols: string[];
    dynamic_symbols: string[];
    expires_at: string;
  },
): Promise<void> {
  const { error } = await db
    .from("dynamic_watchlist_snapshots")
    .insert(args as never);

  if (error) {
    console.error("[WATCHLIST_RESOLVER] snapshot insert failed:", error);
  }

  // Keep only last 30 snapshots to bound table growth
  const { error: cleanupErr } = await (db.rpc as any)("delete_old_watchlist_snapshots", { keep: 30 });
  if (cleanupErr) {
    // Non-fatal — cleanup function may not exist yet
  }
}

/* ───────────── Core resolution ───────────── */

async function resolveWatchlistContextFresh(
  db: Admin,
  previousSnapshot: SnapshotRow | null,
): Promise<WatchlistContext> {
  const [hl, binanceSet, pinnedOpen] = await Promise.all([
    fetchHyperliquidVolume(),
    fetchBinanceUSDTBases(),
    loadPinnedOpenPositions(db),
  ]);

  const hlCandidates = hl.all.size;
  const prevSymbols = new Set(previousSnapshot?.symbols ?? []);

  // ── Volume filter with hysteresis ──
  const aboveThreshold: { symbol: string; volume: number }[] = [];
  for (const [symbol, volume] of hl.volume) {
    const isExisting = prevSymbols.has(symbol);
    const threshold = isExisting ? REMOVE_THRESHOLD_USD : ADD_THRESHOLD_USD;
    if (volume >= threshold) {
      aboveThreshold.push({ symbol, volume });
    }
  }
  aboveThreshold.sort((a, b) => b.volume - a.volume);

  // ── Binance listing filter ──
  const binanceFiltered = aboveThreshold.filter((c) =>
    binanceSet.has(c.symbol),
  );

  // ── Pinned set ──
  const pinnedAlways = new Set(CORE_ALWAYS_INCLUDE);
  const coreFallback = new Set(CORE_FALLBACK_WATCHLIST);
  const pinnedAll = new Set([...pinnedAlways, ...pinnedOpen]);

  // ── Compose final list ──
  const dynamicList: string[] = [];
  const seen = new Set<string>();

  // 1. Pinned first (always survive the cap)
  for (const s of pinnedAll) {
    if (!seen.has(s)) {
      seen.add(s);
      dynamicList.push(s);
    }
  }

  // 2. Then by volume desc, up to MAX_COINS
  for (const { symbol } of binanceFiltered) {
    if (dynamicList.length >= MAX_COINS) break;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    dynamicList.push(symbol);
  }

  // ── Compute dynamic set for tagging ──
  const hlDynamic = new Set<string>();
  for (const s of dynamicList) {
    if (!pinnedAll.has(s)) hlDynamic.add(s);
  }

  const expiresAt = new Date(
    Date.now() + STABILITY_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const computedAt = new Date().toISOString();

  // ── Persist ──
  await persistSnapshot(db, {
    symbols: dynamicList,
    source: "refreshed",
    hl_candidates: hlCandidates,
    hl_above_threshold: aboveThreshold.length,
    binance_filtered: binanceFiltered.length,
    pinned_symbols: [...pinnedAll],
    dynamic_symbols: [...hlDynamic],
    expires_at: expiresAt,
  });

  console.log(
    `[WATCHLIST_RESOLVER] Refreshed — ` +
      `hl_candidates=${hlCandidates} ` +
      `above_threshold=${aboveThreshold.length} ` +
      `binance_filtered=${binanceFiltered.length} ` +
      `pinned=${pinnedAll.size} ` +
      `dynamic=${hlDynamic.size} ` +
      `total=${dynamicList.length}`,
  );

  return {
    symbols: dynamicList,
    pinned_always: pinnedAlways,
    pinned_open: pinnedOpen,
    revolutx: new Set(REVOLUTX_DISCOVERED_SYMBOLS),
    hl_dynamic: hlDynamic,
    core_fallback: new Set<string>(),
    meta: {
      source: "refreshed",
      computed_at: computedAt,
      expires_at: expiresAt,
      hl_candidates: hlCandidates,
      hl_above_threshold: aboveThreshold.length,
      binance_filtered: binanceFiltered.length,
    },
  };
}

async function resolveWatchlistContextFromCache(
  db: Admin,
  snapshot: SnapshotRow,
): Promise<WatchlistContext> {
  // Refresh ONLY pinned_open — open positions may have changed since snapshot.
  const pinnedOpen = await loadPinnedOpenPositions(db);
  const pinnedAlways = new Set(CORE_ALWAYS_INCLUDE);

  // Merge any new open positions not in the snapshot
  const symbols = [...snapshot.symbols];
  const seen = new Set(symbols);
  for (const s of pinnedOpen) {
    if (!seen.has(s)) {
      symbols.push(s);
      seen.add(s);
    }
  }

  const dynamicSet = new Set(snapshot.dynamic_symbols ?? []);

  return {
    symbols,
    pinned_always: pinnedAlways,
    pinned_open: pinnedOpen,
    revolutx: new Set(REVOLUTX_DISCOVERED_SYMBOLS),
    hl_dynamic: dynamicSet,
    core_fallback: new Set<string>(),
    meta: {
      source: "cache",
      computed_at: snapshot.computed_at,
      expires_at: snapshot.expires_at,
      hl_candidates: snapshot.hl_candidates,
      hl_above_threshold: snapshot.hl_above_threshold,
      binance_filtered: snapshot.binance_filtered,
    },
  };
}

async function resolveWatchlistContextFallback(): Promise<WatchlistContext> {
  const symbols = [...CORE_FALLBACK_WATCHLIST];
  const coreFallback = new Set(symbols);
  const pinnedAlways = new Set(CORE_ALWAYS_INCLUDE);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

  console.warn(
    `[WATCHLIST_RESOLVER] FALLBACK_STATIC — using ${symbols.length}-coin core list`,
  );

  return {
    symbols,
    pinned_always: pinnedAlways,
    pinned_open: new Set(),
    revolutx: new Set(REVOLUTX_DISCOVERED_SYMBOLS),
    hl_dynamic: new Set(),
    core_fallback: coreFallback,
    meta: {
      source: "fallback_static",
      computed_at: now.toISOString(),
      expires_at: expiresAt,
      hl_candidates: 0,
      hl_above_threshold: 0,
      binance_filtered: 0,
    },
  };
}

/* ───────────── Public API ───────────── */

/**
 * Resolve the active watchlist context for this pipeline run.
 *
 * Prefers cached snapshot when fresh; otherwise refreshes from Hyperliquid.
 * Falls back to static core list only if both fail.
 */
export async function resolveWatchlistContext(): Promise<WatchlistContext> {
  const db = await admin();

  const snapshot = await loadLatestSnapshot(db);

  if (snapshot) {
    const expiresMs = new Date(snapshot.expires_at).getTime();
    if (Number.isFinite(expiresMs) && Date.now() < expiresMs) {
      return resolveWatchlistContextFromCache(db, snapshot);
    }
  }

  // Snapshot missing or expired — try a fresh resolution
  try {
    return await resolveWatchlistContextFresh(db, snapshot);
  } catch (e) {
    console.error("[WATCHLIST_RESOLVER] fresh resolution failed:", e);
    return resolveWatchlistContextFallback();
  }
}

/* ───────────── Module-level cache ───────────── */

let memoryCache: { ctx: WatchlistContext; ts: number } | null = null;

/**
 * Fast accessor — returns the same context for up to MEMORY_TTL_MS.
 * Use this from pipeline code to avoid re-resolving on every function.
 */
export async function getActiveWatchlistContext(): Promise<WatchlistContext> {
  const now = Date.now();
  if (memoryCache && now - memoryCache.ts < MEMORY_TTL_MS) {
    return memoryCache.ctx;
  }
  const ctx = await resolveWatchlistContext();
  memoryCache = { ctx, ts: now };
  return ctx;
}

/** Convenience — just the symbols. */
export async function getActiveWatchlist(): Promise<string[]> {
  const ctx = await getActiveWatchlistContext();
  return ctx.symbols;
}

/** Force the next call to re-resolve. Use at pipeline start. */
export function invalidateWatchlistCache(): void {
  memoryCache = null;
}

/**
 * Hot Whale Queue — intra-cycle discovery + aggregated direction signal.
 *
 * Captures whale activity for coins NOT currently in the active watchlist.
 * These symbols get pulled into combineSignals() immediately, bypassing
 * the 6h dynamic-watchlist refresh. They expire after HOT_TTL_MINUTES of
 * inactivity, so transient pumps don't permanently bloat the pipeline.
 *
 * Why this exists: The dynamic watchlist solves discovery, but introduces
 * a latency gap. If PUMP goes hot at 13:00 and cools by 14:00, we'd miss
 * it entirely with a 6h resolver. The hot queue eliminates that gap.
 *
 * Design notes:
 *   - All functions fail-open. If the table or RPC is missing, we log a
 *     warning and return empty/zero — the pipeline continues unaffected.
 *   - Aggregation requires ≥3 samples to declare a direction. Below that
 *     threshold, direction is null and the pipeline treats the symbol as
 *     having only technical/prediction signals.
 */

type Admin = Awaited<
  typeof import("@/integrations/supabase/client.server")
>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/* ───────────── Tunables ───────────── */

/** Minimum USD to mark a symbol as hot (below this, it's noise). */
export const HOT_THRESHOLD_USD = 25_000;

/** Hot entries expire after this many minutes of no new activity. */
export const HOT_TTL_MINUTES = 120; // 2 hours

/** Hot entries stay "fresh" for inclusion in signals. */
export const HOT_WINDOW_MINUTES = 30;

/** Max hot symbols to add per pipeline run. */
export const HOT_MAX_SYMBOLS = 20;

/** Minimum USD to earn a conviction boost in ruleBased(). */
export const HOT_CONVICTION_MIN_USD = 50_000;

/** Minimum confidence (0..1) to earn a conviction boost. */
export const HOT_CONVICTION_MIN_CONFIDENCE = 0.70;

/** Max USD cap per symbol in a single pipeline run (avoid spoofed wicks). */
const HOT_MAX_USD_PER_SYMBOL = 5_000_000;

/* ───────────── Aggregation type ───────────── */

export interface HotWhaleAggregate {
  symbol: string;
  total_usd: number;
  buy_usd: number;
  sell_usd: number;
  alert_count: number;
  direction: "accumulation" | "distribution" | null;
  buy_ratio: number;   // 0..1
  confidence: number;  // 0..1, only meaningful when direction is non-null
  last_seen_at: string;
}

/* ───────────── Record ───────────── */

/**
 * Records a hot whale observation. Called from collectWhaleAlerts() for
 * any symbol with usd ≥ HOT_THRESHOLD_USD that is NOT in the active
 * watchlist.
 *
 * Silently swallows errors — hot queue is an optimization, not correctness.
 */
export async function recordHotWhale(
  symbol: string,
  usd: number,
  isBuy: boolean,
  source: string,
): Promise<void> {
  try {
    const cleanUsd = Math.min(Math.max(Number(usd) || 0, 0), HOT_MAX_USD_PER_SYMBOL);
    if (cleanUsd < HOT_THRESHOLD_USD) return;
    const db = await admin();
    const { error } = await (db.rpc as any)("record_hot_whale", {
      p_symbol: symbol,
      p_usd: cleanUsd,
      p_is_buy: isBuy,
      p_source: source,
    });
    if (error) {
      console.warn(`[HOT_WHALE] record failed for ${symbol}: ${error.message}`);
    }
  } catch (e) {
    console.warn(`[HOT_WHALE] record threw for ${symbol}:`, e);
  }
}

/* ───────────── Fetch symbols ───────────── */

/**
 * Returns the current hot whale symbols, ranked by total USD desc.
 * Returns empty array on any error (fail-open).
 */
export async function getHotWhaleSymbols(): Promise<string[]> {
  try {
    const db = await admin();
    const { data, error } = await (db.rpc as any)("get_hot_whale_symbols", {
      p_minutes: HOT_WINDOW_MINUTES,
      p_limit: HOT_MAX_SYMBOLS,
    });
    if (error) {
      console.warn("[HOT_WHALE] fetch failed:", error.message);
      return [];
    }
    return ((data ?? []) as { symbol: string }[]).map((r) => r.symbol);
  } catch (e) {
    console.warn("[HOT_WHALE] fetch threw:", e);
    return [];
  }
}

/* ───────────── Cleanup ───────────── */

/**
 * Opportunistic cleanup. Called once per pipeline run. Returns rows deleted.
 * Errors are swallowed (fail-open).
 */
export async function cleanupHotWhales(): Promise<number> {
  try {
    const db = await admin();
    const { data, error } = await (db.rpc as any)("cleanup_hot_whales", {
      p_older_than_minutes: HOT_TTL_MINUTES,
    });
    if (error) return 0;
    return Number(data ?? 0);
  } catch {
    return 0;
  }
}

/* ───────────── Batch fetch ───────────── */

/**
 * Loads ALL current hot whale aggregates in a SINGLE query.
 *
 * This is the primary accessor used by combineSignals(). Calling
 * getHotWhaleAggregate() per-symbol would issue N queries; this one
 * issues 1.
 *
 * Returns a Map keyed by symbol. Empty map on error.
 */
export async function getHotWhaleBatch(
  windowMinutes = HOT_WINDOW_MINUTES,
): Promise<Map<string, HotWhaleAggregate>> {
  const result = new Map<string, HotWhaleAggregate>();
  try {
    const db = await admin();
    const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    const { data, error } = await db
      .from("hot_whale_signals")
      .select("symbol, total_usd, buy_usd, sell_usd, alert_count, last_seen_at")
      .gte("last_seen_at", since)
      .order("total_usd", { ascending: false })
      .limit(HOT_MAX_SYMBOLS);

    if (error) {
      console.warn("[HOT_WHALE] batch fetch failed:", error.message);
      return result;
    }

    for (const row of (data ?? []) as {
      symbol: string;
      total_usd: number | string;
      buy_usd: number | string;
      sell_usd: number | string;
      alert_count: number | string;
      last_seen_at: string;
    }[]) {
      const agg = computeAggregate(row);
      if (agg) result.set(agg.symbol, agg);
    }
    return result;
  } catch (e) {
    console.warn("[HOT_WHALE] batch fetch threw:", e);
    return result;
  }
}

/**
 * Single-symbol accessor. Prefer getHotWhaleBatch() in loops.
 */
export async function getHotWhaleAggregate(
  symbol: string,
): Promise<HotWhaleAggregate | null> {
  try {
    const db = await admin();
    const { data, error } = await db
      .from("hot_whale_signals")
      .select("symbol, total_usd, buy_usd, sell_usd, alert_count, last_seen_at")
      .eq("symbol", symbol)
      .maybeSingle();
    if (error || !data) return null;
    return computeAggregate(
      data as {
        symbol: string;
        total_usd: number | string;
        buy_usd: number | string;
        sell_usd: number | string;
        alert_count: number | string;
        last_seen_at: string;
      },
    );
  } catch {
    return null;
  }
}

/* ───────────── Aggregation math ───────────── */

/**
 * Pure function — exported for unit testing.
 *
 * Direction requires BOTH:
 *   - alert_count >= 3 (sample-size guard)
 *   - buy_ratio >= 0.65 (accumulation) or <= 0.35 (distribution)
 *
 * Confidence = 0.7 × directional clarity + 0.3 × sample-size factor.
 *   clarity      = |buy_ratio - 0.5| × 2   (0..1)
 *   sampleFactor = min(1, alert_count / 10) (0..1)
 *
 * Returns null when total_usd ≤ 0 or symbol is empty.
 */
export function computeAggregate(row: {
  symbol: string;
  total_usd: number | string;
  buy_usd: number | string;
  sell_usd: number | string;
  alert_count: number | string;
  last_seen_at: string;
}): HotWhaleAggregate | null {
  const symbol = String(row.symbol ?? "").trim();
  if (!symbol) return null;

  const total = Number(row.total_usd) || 0;
  if (total <= 0) return null;

  const buy = Number(row.buy_usd) || 0;
  const sell = Number(row.sell_usd) || 0;
  const count = Number(row.alert_count) || 0;

  const buy_ratio = Math.max(0, Math.min(1, buy / total));

  const hasEnoughSamples = count >= 3;
  const strongBull = buy_ratio >= 0.65;
  const strongBear = buy_ratio <= 0.35;

  const direction: "accumulation" | "distribution" | null =
    hasEnoughSamples && strongBull
      ? "accumulation"
      : hasEnoughSamples && strongBear
        ? "distribution"
        : null;

  const clarity = Math.abs(buy_ratio - 0.5) * 2;        // 0..1
  const sampleFactor = Math.min(1, count / 10);          // 0..1
  const confidence = direction
    ? Math.min(1, clarity * 0.7 + sampleFactor * 0.3)
    : 0;

  return {
    symbol,
    total_usd: total,
    buy_usd: buy,
    sell_usd: sell,
    alert_count: count,
    direction,
    buy_ratio,
    confidence,
    last_seen_at: row.last_seen_at,
  };
}

/* ───────────── Conviction helper for ruleBased ───────────── */

/**
 * Returns true when this aggregate qualifies for the conviction bonus
 * in ruleBased(). Both conditions must hold:
 *   - total_usd >= HOT_CONVICTION_MIN_USD
 *   - confidence >= HOT_CONVICTION_MIN_CONFIDENCE
 *   - direction is non-null
 */
export function qualifiesForConvictionBoost(
  agg: HotWhaleAggregate | null | undefined,
): boolean {
  if (!agg || !agg.direction) return false;
  if (agg.total_usd < HOT_CONVICTION_MIN_USD) return false;
  if (agg.confidence < HOT_CONVICTION_MIN_CONFIDENCE) return false;
  return true;
}

/**
 * Additive conviction bonus magnitude for ruleBased().
 * Scales linearly from 0 (at threshold) to 0.3 (at confidence 1.0).
 */
export function convictionBoostMagnitude(
  agg: HotWhaleAggregate | null | undefined,
): number {
  if (!qualifiesForConvictionBoost(agg)) return 0;
  const c = agg!.confidence;
  // (c - 0.70) ranges 0..0.30 → mapped to 0..0.30 additive bonus
  return Math.min(0.30, Math.max(0, (c - HOT_CONVICTION_MIN_CONFIDENCE) * 1.0));
}

/**
 * Trading settings loader — cached read από pipeline_settings.
 *
 * Loads dynamic values για:
 *  - Variant shadow expiry (TP/SL/max_hours)
 *  - Real/paper trade expiry (TP/SL/max_hold_hours/stale_exit)
 *
 * 30-second cache: αποφεύγει query per-trade.
 * Falls back to hardcoded defaults αν η DB αποτύχει.
 */

const CACHE_TTL_MS = 30_000;

export interface TradingSettings {
  // ─── Shadow variant signals ───
  variant_max_hours: number;
  variant_tp_pct: number;
  variant_sl_pct: number;

  // ─── Real/paper trades ───
  max_hold_hours: number;
  stale_exit_hours: number;
  stale_exit_min_pnl_pct: number;
  real_tp_pct: number;
  real_sl_pct: number;
}

export const DEFAULT_TRADING_SETTINGS: TradingSettings = {
  // Shadow variants
  variant_max_hours: 72,
  variant_tp_pct: 0.04,
  variant_sl_pct: 0.03,

  // Real/paper trades
  max_hold_hours: 72,
  stale_exit_hours: 48,
  stale_exit_min_pnl_pct: 1.0,
  real_tp_pct: 0.04,
  real_sl_pct: 0.03,
};

let cache: { settings: TradingSettings; ts: number } | null = null;

/**
 * Fetch trading settings from pipeline_settings.
 * Falls back to defaults on any error.
 */
export async function fetchTradingSettings(): Promise<TradingSettings> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) {
    return cache.settings;
  }

  try {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data, error } = await supabaseAdmin
      .from("pipeline_settings")
      .select(
        "variant_max_hours, variant_tp_pct, variant_sl_pct, " +
          "max_hold_hours, stale_exit_hours, stale_exit_min_pnl_pct, " +
          "real_tp_pct, real_sl_pct",
      )
      .single();

    if (error) throw error;

    const row = (data ?? {}) as Record<string, unknown>;

    const num = (key: string, fallback: number): number => {
      const v = Number(row[key]);
      return Number.isFinite(v) ? v : fallback;
    };

    const settings: TradingSettings = {
      variant_max_hours: num(
        "variant_max_hours",
        DEFAULT_TRADING_SETTINGS.variant_max_hours,
      ),
      variant_tp_pct: num(
        "variant_tp_pct",
        DEFAULT_TRADING_SETTINGS.variant_tp_pct,
      ),
      variant_sl_pct: num(
        "variant_sl_pct",
        DEFAULT_TRADING_SETTINGS.variant_sl_pct,
      ),
      max_hold_hours: num(
        "max_hold_hours",
        DEFAULT_TRADING_SETTINGS.max_hold_hours,
      ),
      stale_exit_hours: num(
        "stale_exit_hours",
        DEFAULT_TRADING_SETTINGS.stale_exit_hours,
      ),
      stale_exit_min_pnl_pct: num(
        "stale_exit_min_pnl_pct",
        DEFAULT_TRADING_SETTINGS.stale_exit_min_pnl_pct,
      ),
      real_tp_pct: num(
        "real_tp_pct",
        DEFAULT_TRADING_SETTINGS.real_tp_pct,
      ),
      real_sl_pct: num(
        "real_sl_pct",
        DEFAULT_TRADING_SETTINGS.real_sl_pct,
      ),
    };

    cache = { settings, ts: now };
    return settings;
  } catch (e) {
    console.error(
      "[TRADING_SETTINGS] load failed, using defaults:",
      e instanceof Error ? e.message : String(e),
    );
    return DEFAULT_TRADING_SETTINGS;
  }
}

export function invalidateTradingSettingsCache() {
  cache = null;
}

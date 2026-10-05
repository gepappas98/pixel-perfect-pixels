/**
 * Trading settings loader.
 *
 * Uses safe defaults while the pipeline_settings schema is unavailable.
 */

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
  real_tp_pct: 0.045,
  real_sl_pct: 0.025,
};

/**
 * Fetch trading settings from pipeline_settings.
 * Falls back to defaults on any error.
 */
export async function fetchTradingSettings(): Promise<TradingSettings> {
  return DEFAULT_TRADING_SETTINGS;
}

export function invalidateTradingSettingsCache() {
  // Kept for callers that invalidate settings after configuration changes.
}

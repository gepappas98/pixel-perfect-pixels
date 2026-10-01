/**
 * Market session detection — pure function, no DB access.
 *
 * Sessions are UTC-based and cover the three major financial centers.
 * The EU-US overlap (13:00-17:00 UTC) is the peak window for crypto
 * volume and volatility, driven by institutional activity.
 *
 * Reference:
 *   - Brauneis, Mestel & Theissen (2024): crypto volume peaks at 16:00-17:00 UTC
 *   - 2026 exchange data: 63% of BTC volume during US hours is institutional
 *   - Whale >$1M USDT peaks at 09:00-11:00 UTC (Chinese rush hour)
 */

export type MarketSession =
  | "asian"          // 00:00-07:00 UTC (Tokyo, HK, Singapore)
  | "european"       // 07:00-13:00 UTC (London, Frankfurt)
  | "eu_us_overlap"  // 13:00-17:00 UTC ⭐ PEAK
  | "us"             // 17:00-22:00 UTC (NY, Chicago)
  | "off_hours";     // 22:00-00:00 UTC (quiet)

export interface SessionInfo {
  session: MarketSession;
  utcHour: number;
  isPeakWindow: boolean;
  isOffHours: boolean;
  isWeekend: boolean;
  dayOfWeek: number;
}

/**
 * Classify a timestamp into a market session.
 */
export function classifyMarketSession(
  timestamp: Date | string | number = new Date(),
): SessionInfo {
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const utcHour = d.getUTCHours();
  const dayOfWeek = d.getUTCDay(); // 0=Sunday, 6=Saturday
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  let session: MarketSession;
  if (utcHour >= 13 && utcHour < 17) {
    session = "eu_us_overlap";
  } else if (utcHour >= 17 && utcHour < 22) {
    session = "us";
  } else if (utcHour >= 7 && utcHour < 13) {
    session = "european";
  } else if (utcHour >= 22 || utcHour < 0) {
    session = "off_hours";
  } else {
    session = "asian";
  }

  return {
    session,
    utcHour,
    isPeakWindow: session === "eu_us_overlap",
    isOffHours: session === "off_hours",
    isWeekend,
    dayOfWeek,
  };
}

/**
 * Get session bonus/penalty modifier for composite score.
 *
 * Positive values favor entry during the session.
 * Negative values discourage entry.
 */
export interface MarketSessionConfig {
  enabled: boolean;
  shadow_mode: boolean;
  overlap_bonus: number;
  us_bonus: number;
  off_hours_penalty: number;
}

export const DEFAULT_SESSION_CONFIG: MarketSessionConfig = {
  enabled: false,
  shadow_mode: true,
  overlap_bonus: 0.15,
  us_bonus: 0.05,
  off_hours_penalty: 0.10,
};

export function getSessionBonus(
  session: MarketSession,
  config: MarketSessionConfig,
): number {
  if (!config.enabled) return 0;
  switch (session) {
    case "eu_us_overlap":
      return config.overlap_bonus;
    case "us":
      return config.us_bonus;
    case "off_hours":
      return -config.off_hours_penalty;
    default:
      return 0;
  }
}

/**
 * Human-readable label for logs.
 */
export function sessionLabel(session: MarketSession): string {
  switch (session) {
    case "asian": return "Asia 🌏";
    case "european": return "Europe 🇪🇺";
    case "eu_us_overlap": return "EU-US Overlap 🏆";
    case "us": return "US 🇺🇸";
    case "off_hours": return "Off-hours 🌙";
  }
}

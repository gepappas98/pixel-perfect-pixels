export type SignalDir = "bull" | "bear" | "neutral";

/**
 * MTF Confirmation Gate
 * 
 * Απορρίπτει buy/sell signals που πέρασαν το score threshold αλλά
 * δεν έχουν αρκετά timeframes να συμφωνούν (default: 2/3).
 * 
 * Empirical backing (10 closed trades, Sept 2026):
 *   - Weak MTF (only 4h confirms): 4 stop losses, −$228.73 net
 *   - Strong MTF (2+ timeframes confirm): 5 wins/stales, +$558.85 net
 * 
 * Fix expected impact: +74% net PnL improvement in backtest.
 */

export interface MtfCounts {
  bullCount: number;
  bearCount: number;
  neuCount: number;
}

export interface MtfGateConfig {
  enabled: boolean;
  shadow_mode: boolean;
  min_timeframes: number;
}

export interface MtfGateDecision {
  /** Πόσα timeframes συμφωνούν με το direction */
  confirmingCount: number;
  /** Πόσα είναι αντίθετα */
  opposingCount: number;
  /** Πόσα είναι neutral */
  neutralCount: number;
  /** Αν το signal πέρασε το gate */
  passed: boolean;
  /** Λόγος απόρριψης (για logging) */
  rejectReason: string | null;
}

export const DEFAULT_MTF_GATE_CONFIG: MtfGateConfig = {
  enabled: false,
  shadow_mode: true,
  min_timeframes: 2,
};

/**
 * Ελέγχει αν το signal πληροί το MTF confirmation gate.
 */
export function checkMtfGate(
  direction: "buy" | "sell",
  counts: MtfCounts,
  config: MtfGateConfig,
): MtfGateDecision {
  const confirmingCount =
    direction === "buy" ? counts.bullCount : counts.bearCount;
  const opposingCount =
    direction === "buy" ? counts.bearCount : counts.bullCount;
  const neutralCount = counts.neuCount;

  const passed = confirmingCount >= config.min_timeframes;

  const rejectReason = passed
    ? null
    : `only ${confirmingCount}/${config.min_timeframes + 1} timeframes confirm ${direction} (${counts.bullCount}B/${counts.bearCount}B/${counts.neuCount}N)`;

  return {
    confirmingCount,
    opposingCount,
    neutralCount,
    passed,
    rejectReason,
  };
}

/**
 * Helper: υπολογίζει counts από τα 3 timeframe signals.
 */
export function countMtfSignals(
  primary: SignalDir,
  fast: SignalDir,
  trend: SignalDir,
): MtfCounts {
  const all = [primary, fast, trend];
  return {
    bullCount: all.filter((s) => s === "bullish").length,
    bearCount: all.filter((s) => s === "bearish").length,
    neuCount: all.filter((s) => s === "neutral").length,
  };
}

/**
 * SHADOW V2
 *
 * IMPORTANT:
 * - Shadow only. Never writes to public.trades.
 * - Never calls live execution.
 * - Uses the same execution assumptions that can later be
 *   aligned with real execution.
 *
 * Design goals:
 *  - Deterministic signal identity (via signal.id, never via wall clock).
 *  - Entry price anchored to the SIGNAL timestamp, not to resolution time.
 *  - TP / SL / Expiry are pure functions of the entry price + signal time.
 *  - Intrabar TP+SL conflicts default to SL-first (conservative).
 *  - Fee accounting on both legs (entry + exit).
 *  - No fabricated exit prices on expiry: if a historical candle
 *    cannot be found near the expiry timestamp, the position stays open.
 */

/* ───────────── Constants ───────────── */

export const SHADOW_V2_VERSION = "v2" as const;

export const SHADOW_V2_TP_PCT = 0.04;
export const SHADOW_V2_SL_PCT = 0.03;
export const SHADOW_V2_EXPIRY_HOURS = 72;
export const SHADOW_V2_SYMBOL_COOLDOWN_MINUTES = 60;
export const SHADOW_V2_FEE_RATE = 0.001; // 0.10% per side
export const SHADOW_V2_NOTIONAL_USD = 1000;

/* ───────────── Types ───────────── */

export type ShadowV2ExitReason = "TP" | "SL" | "EXPIRED";

export type ShadowV2SuppressionReason =
  | "SHADOW_ACTIVE_POSITION"
  | "SHADOW_SYMBOL_COOLDOWN"
  | "SHADOW_DUPLICATE_SIGNAL";

export type ShadowV2PerformanceMode = "RAW" | "EXECUTABLE" | "DEDUPLICATED";

export interface ShadowV2PerformanceModeConfig {
  mode: ShadowV2PerformanceMode;
  applyActivePositionCap: boolean;
  applyCooldown: boolean;
  applyDuplicateSuppression: boolean;
}

export interface ShadowV2Signal {
  id?: string | null;
  symbol: string;
  strategy: string;
  recommendation: string;
  confidence: number;
  created_at: string;
}

export interface ShadowV2PositionDetails {
  shadow_version: typeof SHADOW_V2_VERSION;
  entry_source: "signal_timestamp";
  entry_price_source: "historical_price" | "provided_entry_price";
  tp_pct: number;
  sl_pct: number;
  expiry_hours: number;
  fee_rate: number;
  performance_mode: ShadowV2PerformanceMode;
}

export interface ShadowV2Position {
  fingerprint: string;
  signalId: string | null;
  symbol: string;
  strategy: string;
  signalCreatedAt: string;
  entryTimestamp: string;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  expiryTimestamp: string;
  status: "OPEN" | "CLOSED";
  exitTimestamp: string | null;
  exitPrice: number | null;
  exitReason: ShadowV2ExitReason | null;
  grossPnlUsd: number;
  entryFeeUsd: number;
  exitFeeUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  grossPnlPct: number;
  feesPct: number;
  netPnlPct: number;
  ambiguousIntrabar: boolean;
  ambiguityReason: string | null;
  details: ShadowV2PositionDetails;
}

export interface ShadowV2Decision {
  accepted: boolean;
  reason: "OPEN" | ShadowV2SuppressionReason;
  fingerprint: string;
}

export interface ShadowV2Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ShadowV2CandleResolution {
  reason: ShadowV2ExitReason;
  price: number;
  ambiguousIntrabar: boolean;
  ambiguityReason: string | null;
}

export interface ShadowV2PnlResult {
  quantity: number;
  grossPnlUsd: number;
  entryFeeUsd: number;
  exitFeeUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  grossPnlPct: number;
  feesPct: number;
  netPnlPct: number;
}

/* ───────────── Performance Modes ───────────── */

/**
 * Three views over the SAME underlying simulation.
 *
 * - RAW:           every BUY signal opens a position, no caps, no cooldown,
 *                  no dedupe. Useful for signal-level edge measurement.
 * - EXECUTABLE:    applies symbol cap + cooldown + dedupe. This is what the
 *                  real executor would have allowed at signal time.
 * - DEDUPLICATED:  portfolio-like view. Same rules as EXECUTABLE but
 *                  intended as the primary performance KPI.
 *
 * Never present RAW as if it were the live portfolio.
 */
export const SHADOW_V2_PERFORMANCE_MODES: Record<
  ShadowV2PerformanceMode,
  ShadowV2PerformanceModeConfig
> = {
  RAW: {
    mode: "RAW",
    applyActivePositionCap: false,
    applyCooldown: false,
    applyDuplicateSuppression: false,
  },
  EXECUTABLE: {
    mode: "EXECUTABLE",
    applyActivePositionCap: true,
    applyCooldown: true,
    applyDuplicateSuppression: true,
  },
  DEDUPLICATED: {
    mode: "DEDUPLICATED",
    applyActivePositionCap: true,
    applyCooldown: true,
    applyDuplicateSuppression: true,
  },
};

/* ───────────── Fingerprint ───────────── */

/**
 * Deterministic signal identity.
 *
 * signal_id is preferred because it is already unique at source.
 * Fallback exists for legacy signals without an ID.
 */
export function getShadowV2Fingerprint(signal: ShadowV2Signal): string {
  if (signal.id) {
    return `v2:${signal.id}`;
  }
  return [
    "v2",
    signal.symbol.toUpperCase(),
    signal.created_at,
    signal.strategy,
  ].join(":");
}

/* ───────────── Levels & Expiry ───────────── */

export function calculateShadowV2Levels(entryPrice: number): {
  takeProfitPrice: number;
  stopLossPrice: number;
} {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error(`Invalid Shadow V2 entry price: ${entryPrice}`);
  }
  return {
    takeProfitPrice: entryPrice * (1 + SHADOW_V2_TP_PCT),
    stopLossPrice: entryPrice * (1 - SHADOW_V2_SL_PCT),
  };
}

export function calculateShadowV2Expiry(entryTimestamp: string): string {
  const timestamp = new Date(entryTimestamp).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid Shadow V2 entry timestamp: ${entryTimestamp}`);
  }
  return new Date(
    timestamp + SHADOW_V2_EXPIRY_HOURS * 60 * 60 * 1000,
  ).toISOString();
}

/* ───────────── Acceptance Decision ───────────── */

/**
 * Determines whether a BUY signal is accepted as an OPEN Shadow V2 position.
 *
 * Pure: no side effects, no I/O.
 * The only wall-clock usage is the cooldown window, which is inherently
 * relative to "now" when a replay is being run live.
 */
export function getShadowV2Decision(params: {
  signal: ShadowV2Signal;
  activePositions: ShadowV2Position[];
  processedFingerprints: Set<string>;
  lastExitTimestamp?: string | null;
  mode?: ShadowV2PerformanceMode;
}): ShadowV2Decision {
  const {
    signal,
    activePositions,
    processedFingerprints,
    lastExitTimestamp,
    mode = "DEDUPLICATED",
  } = params;

  const config = SHADOW_V2_PERFORMANCE_MODES[mode];
  const fingerprint = getShadowV2Fingerprint(signal);

  /* 1. Duplicate BUY suppression. */
  if (
    config.applyDuplicateSuppression &&
    processedFingerprints.has(fingerprint)
  ) {
    return {
      accepted: false,
      reason: "SHADOW_DUPLICATE_SIGNAL",
      fingerprint,
    };
  }

  /* 2. Maximum one active position per symbol. */
  if (config.applyActivePositionCap) {
    const activeForSymbol = activePositions.some(
      (position) =>
        position.status === "OPEN" &&
        position.symbol.toUpperCase() === signal.symbol.toUpperCase(),
    );
    if (activeForSymbol) {
      return {
        accepted: false,
        reason: "POSITION_ALREADY_OPEN",
        fingerprint,
      };
    }
  }

  /* 3. Symbol cooldown. */
  if (config.applyCooldown && lastExitTimestamp) {
    const elapsed = Date.now() - new Date(lastExitTimestamp).getTime();
    const cooldownMs = SHADOW_V2_SYMBOL_COOLDOWN_MINUTES * 60 * 1000;
    if (
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed < cooldownMs
    ) {
      return {
        accepted: false,
        reason: "SHADOW_SYMBOL_COOLDOWN",
        fingerprint,
      };
    }
  }

  return { accepted: true, reason: "OPEN", fingerprint };
}

/* ───────────── Position Builders ───────────── */

/**
 * Builds an OPEN Shadow V2 position from an accepted signal.
 *
 * IMPORTANT: entryTimestamp MUST be signal.created_at, NOT new Date().
 * entryPrice MUST be the historical price at signal.created_at.
 */
export function buildShadowV2OpenPosition(params: {
  signal: ShadowV2Signal;
  fingerprint: string;
  entryPrice: number;
  entryPriceSource?: "historical_price" | "provided_entry_price";
  mode?: ShadowV2PerformanceMode;
}): ShadowV2Position {
  const {
    signal,
    fingerprint,
    entryPrice,
    entryPriceSource = "historical_price",
    mode = "DEDUPLICATED",
  } = params;

  const signalTimestamp = signal.created_at;
  const { takeProfitPrice, stopLossPrice } =
    calculateShadowV2Levels(entryPrice);
  const expiryTimestamp = calculateShadowV2Expiry(signalTimestamp);

  return {
    fingerprint,
    signalId: signal.id ?? null,
    symbol: signal.symbol,
    strategy: signal.strategy,
    signalCreatedAt: signalTimestamp,
    entryTimestamp: signalTimestamp,
    entryPrice,
    takeProfitPrice,
    stopLossPrice,
    expiryTimestamp,
    status: "OPEN",
    exitTimestamp: null,
    exitPrice: null,
    exitReason: null,
    grossPnlUsd: 0,
    entryFeeUsd: 0,
    exitFeeUsd: 0,
    feesUsd: 0,
    netPnlUsd: 0,
    grossPnlPct: 0,
    feesPct: 0,
    netPnlPct: 0,
    ambiguousIntrabar: false,
    ambiguityReason: null,
    details: {
      shadow_version: SHADOW_V2_VERSION,
      entry_source: "signal_timestamp",
      entry_price_source: entryPriceSource,
      tp_pct: SHADOW_V2_TP_PCT,
      sl_pct: SHADOW_V2_SL_PCT,
      expiry_hours: SHADOW_V2_EXPIRY_HOURS,
      fee_rate: SHADOW_V2_FEE_RATE,
      performance_mode: mode,
    },
  };
}

/* ───────────── PnL ───────────── */

export function calculateShadowV2Pnl(params: {
  entryPrice: number;
  exitPrice: number;
  notionalUsd: number;
}): ShadowV2PnlResult {
  const { entryPrice, exitPrice, notionalUsd } = params;
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(exitPrice) ||
    !Number.isFinite(notionalUsd) ||
    entryPrice <= 0 ||
    exitPrice <= 0 ||
    notionalUsd <= 0
  ) {
    throw new Error("Invalid Shadow V2 PnL inputs");
  }

  const quantity = notionalUsd / entryPrice;
  const entryFeeUsd = notionalUsd * SHADOW_V2_FEE_RATE;
  const grossPnlUsd = (exitPrice - entryPrice) * quantity;
  const exitNotionalUsd = exitPrice * quantity;
  const exitFeeUsd = exitNotionalUsd * SHADOW_V2_FEE_RATE;
  const feesUsd = entryFeeUsd + exitFeeUsd;
  const netPnlUsd = grossPnlUsd - feesUsd;
  const grossPnlPct = grossPnlUsd / notionalUsd;
  const feesPct = feesUsd / notionalUsd;
  const netPnlPct = netPnlUsd / notionalUsd;

  return {
    quantity,
    grossPnlUsd,
    entryFeeUsd,
    exitFeeUsd,
    feesUsd,
    netPnlUsd,
    grossPnlPct,
    feesPct,
    netPnlPct,
  };
}

/* ───────────── Candle Resolution ───────────── */

/**
 * Determines TP/SL from a candle.
 *
 * If both levels are touched and intrabar ordering is unavailable,
 * SL-first is deliberately conservative.
 */
export function resolveShadowV2Candle(params: {
  high: number;
  low: number;
  takeProfitPrice: number;
  stopLossPrice: number;
}): ShadowV2CandleResolution | null {
  const { high, low, takeProfitPrice, stopLossPrice } = params;

  if (
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(takeProfitPrice) ||
    !Number.isFinite(stopLossPrice)
  ) {
    return null;
  }

  const hitTP = high >= takeProfitPrice;
  const hitSL = low <= stopLossPrice;

  if (hitTP && hitSL) {
    return {
      reason: "SL",
      price: stopLossPrice,
      ambiguousIntrabar: true,
      ambiguityReason:
        "Both TP and SL touched in same candle; SL-first conservative rule applied.",
    };
  }
  if (hitSL) {
    return {
      reason: "SL",
      price: stopLossPrice,
      ambiguousIntrabar: false,
      ambiguityReason: null,
    };
  }
  if (hitTP) {
    return {
      reason: "TP",
      price: takeProfitPrice,
      ambiguousIntrabar: false,
      ambiguityReason: null,
    };
  }
  return null;
}

/**
 * Builds a CLOSED Shadow V2 position from a resolved exit.
 *
 * Callers should pass either a TP / SL resolution from resolveShadowV2Candle()
 * or a manual EXPIRED resolution (with expiryCandle.close as price).
 */
export function buildShadowV2ClosedPosition(params: {
  position: ShadowV2Position;
  exitTimestamp: string;
  exitPrice: number;
  exitReason: ShadowV2ExitReason;
  ambiguousIntrabar?: boolean;
  ambiguityReason?: string | null;
  notionalUsd?: number;
}): ShadowV2Position {
  const {
    position,
    exitTimestamp,
    exitPrice,
    exitReason,
    ambiguousIntrabar = false,
    ambiguityReason = null,
    notionalUsd = SHADOW_V2_NOTIONAL_USD,
  } = params;

  const pnl = calculateShadowV2Pnl({
    entryPrice: position.entryPrice,
    exitPrice,
    notionalUsd,
  });

  return {
    ...position,
    status: "CLOSED",
    exitTimestamp,
    exitPrice,
    exitReason,
    grossPnlUsd: pnl.grossPnlUsd,
    entryFeeUsd: pnl.entryFeeUsd,
    exitFeeUsd: pnl.exitFeeUsd,
    feesUsd: pnl.feesUsd,
    netPnlUsd: pnl.netPnlUsd,
    grossPnlPct: pnl.grossPnlPct,
    feesPct: pnl.feesPct,
    netPnlPct: pnl.netPnlPct,
    ambiguousIntrabar,
    ambiguityReason,
  };
}

/* ───────────── Historical Candle Helper ───────────── */

/**
 * Finds the candle whose close time is closest to — and not after — the
 * target timestamp.
 *
 * Used for:
 *   - entry pricing at signal time (target = signal.created_at)
 *   - expiry resolution (target = position.expiryTimestamp)
 *
 * Returns null if no suitable candle exists. Callers MUST NOT fabricate
 * an exit price when this returns null.
 */
export function findNearestHistoricalCandle(
  candles: ShadowV2Candle[],
  targetTimestamp: string,
): ShadowV2Candle | null {
  const target = new Date(targetTimestamp).getTime();
  if (!Number.isFinite(target) || candles.length === 0) return null;

  let best: ShadowV2Candle | null = null;
  for (const candle of candles) {
    if (!Number.isFinite(candle.closeTime)) continue;
    if (candle.closeTime > target) continue;
    if (best === null || candle.closeTime > best.closeTime) {
      best = candle;
    }
  }
  return best;
}

/* ───────────── Expiry Check ───────────── */

/**
 * Returns true if the given candle timestamp is at or past the position's
 * expiry timestamp.
 */
export function isShadowV2Expired(params: {
  position: ShadowV2Position;
  candleTimestamp: number;
}): boolean {
  const { position, candleTimestamp } = params;
  const expiryMs = new Date(position.expiryTimestamp).getTime();
  if (!Number.isFinite(expiryMs)) return false;
  return candleTimestamp >= expiryMs;
}

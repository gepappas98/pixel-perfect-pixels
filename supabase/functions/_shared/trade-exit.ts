/**
 * Pure exit-decision logic for open trades (no Deno / network APIs) so it can be
 * unit-tested from vitest and imported by the trade-executor Edge Function.
 * Mirrors closeTriggeredTrades() in src/lib/pipeline.server.ts.
 */
export const EXIT_FEE_RATE = 0.0005; // keep in sync with src/lib/fees.ts

// Paper-only dynamic protection: once a position is observed at +3%, persist a
// stop above entry to cover estimated entry+exit fees and a small buffer.
export const BREAKEVEN_TRIGGER_GAIN_PCT = 3.0;
export const BREAKEVEN_BUFFER_FEE_PCT = 0.15;

export function getBreakevenStopLossUpdate(
  trade: OpenTradeRow,
  price: number | undefined,
): number | null {
  if (trade.side !== "buy" || trade.mode !== "paper") return null;
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const entry = Number(trade.entry_price);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (((price - entry) / entry) * 100 < BREAKEVEN_TRIGGER_GAIN_PCT) return null;

  const protectedStop = entry * (1 + BREAKEVEN_BUFFER_FEE_PCT / 100);
  const currentStop = trade.stop_loss == null ? null : Number(trade.stop_loss);
  if (currentStop != null && Number.isFinite(currentStop) && currentStop >= protectedStop) return null;
  return protectedStop;
}

export interface ExitSettings {
  max_hold_hours: number;
  stale_exit_hours: number;
  stale_exit_min_pnl_pct: number;
}

export const DEFAULT_EXIT_SETTINGS: ExitSettings = {
  max_hold_hours: 72,
  stale_exit_hours: 48,
  stale_exit_min_pnl_pct: 1.0,
};

export interface OpenTradeRow {
  id: string;
  symbol: string;
  side: string;
  mode: string;
  quantity: number | string;
  entry_price: number | string;
  stop_loss: number | string | null;
  take_profit: number | string | null;
  created_at: string;
}

export type ExitReason = "stop_loss" | "take_profit" | "expired" | "stale_exit";

export type ExitDecision =
  | { action: "hold" }
  | { action: "skip_legacy_sell" }
  | { action: "skip_no_price" }
  | { action: "skip_live_requires_exchange"; reason: ExitReason }
  | {
      action: "close";
      reason: ExitReason;
      exit_price: number;
      gross_pnl: number;
      entry_fee: number;
      exit_fee: number;
      total_fees: number;
      net_pnl: number;
      net_pnl_pct: number;
    };

export function normalizeExitSettings(raw: Record<string, unknown> | null | undefined): ExitSettings {
  const pick = (k: keyof ExitSettings) => {
    const v = Number(raw?.[k]);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_EXIT_SETTINGS[k];
  };
  return {
    max_hold_hours: pick("max_hold_hours"),
    stale_exit_hours: pick("stale_exit_hours"),
    stale_exit_min_pnl_pct: pick("stale_exit_min_pnl_pct"),
  };
}

export function decideExit(
  trade: OpenTradeRow,
  price: number | undefined,
  settings: ExitSettings,
  nowMs: number,
): ExitDecision {
  // Binance Spot is long-only: never auto-close legacy SELL rows.
  if (trade.side !== "buy") return { action: "skip_legacy_sell" };
  if (price == null || !Number.isFinite(price) || price <= 0) return { action: "skip_no_price" };

  const entry = Number(trade.entry_price);
  const qty = Number(trade.quantity);
  const sl = trade.stop_loss == null ? null : Number(trade.stop_loss);
  const tp = trade.take_profit == null ? null : Number(trade.take_profit);

  const hitSL = sl != null && Number.isFinite(sl) && price <= sl;
  const hitTP = tp != null && Number.isFinite(tp) && price >= tp;
  const ageHours = (nowMs - new Date(trade.created_at).getTime()) / 3_600_000;
  const pnlPctNow = entry > 0 ? ((price - entry) / entry) * 100 : 0;
  const expired = ageHours >= settings.max_hold_hours;
  const stale = ageHours >= settings.stale_exit_hours && Math.abs(pnlPctNow) < settings.stale_exit_min_pnl_pct;

  if (!hitSL && !hitTP && !expired && !stale) return { action: "hold" };
  const reason: ExitReason = hitSL ? "stop_loss" : hitTP ? "take_profit" : expired ? "expired" : "stale_exit";

  // A live trade must never be marked closed without a confirmed exchange SELL.
  if (trade.mode === "live") return { action: "skip_live_requires_exchange", reason };

  const gross = (price - entry) * qty;
  const entryFee = entry * qty * EXIT_FEE_RATE;
  const exitFee = price * qty * EXIT_FEE_RATE;
  const total = entryFee + exitFee;
  const net = gross - total;
  const notional = entry * qty;
  return {
    action: "close",
    reason,
    exit_price: price,
    gross_pnl: gross,
    entry_fee: entryFee,
    exit_fee: exitFee,
    total_fees: total,
    net_pnl: net,
    net_pnl_pct: notional > 0 ? (net / notional) * 100 : 0,
  };
}

export function binancePair(symbol: string): string {
  const s = symbol.toUpperCase();
  const base = s.endsWith("USDT") ? s.slice(0, -4) : s;
  const alias: Record<string, string> = { MATIC: "POL", RNDR: "RENDER" };
  return `${alias[base] ?? base}USDT`;
}

/**
 * Single source of truth for trading fees and fee-aware PnL.
 * DB mirror: public.trading_fee_rate() (used by the check_and_close_trades cron).
 */
export const TRADING_FEE_RATE = 0.0005; // 0.05% per side

export interface FeeAwarePnl {
  grossPnl: number;
  entryFee: number;
  exitFee: number;
  totalFees: number;
  netPnl: number;
  netPnlPct: number;
}

/**
 * Fee-aware PnL. For closed trades pass the actual exit price;
 * for open trades pass the current price (exit fee is then an estimate only).
 */
export function computeFeeAwarePnl(
  side: "buy" | "sell",
  entryPrice: number,
  exitPrice: number,
  quantity: number,
): FeeAwarePnl {
  const grossPnl = (side === "buy" ? exitPrice - entryPrice : entryPrice - exitPrice) * quantity;
  const entryNotional = entryPrice * quantity;
  const entryFee = entryNotional * TRADING_FEE_RATE;
  const exitFee = exitPrice * quantity * TRADING_FEE_RATE;
  const totalFees = entryFee + exitFee;
  const netPnl = grossPnl - totalFees;
  const netPnlPct = entryNotional > 0 ? (netPnl / entryNotional) * 100 : 0;
  return { grossPnl, entryFee, exitFee, totalFees, netPnl, netPnlPct };
}

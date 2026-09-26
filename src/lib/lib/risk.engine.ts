/**
 * Risk Management Safety Layer — Paper Mode Only
 * All checks apply exclusively to mode = "paper" trades.
 */

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

/* ───────────── Config ───────────── */

export const RISK_CONFIG = {
  MAX_RISK_PER_TRADE_PCT: 0.005,   // 0.5% equity per trade
  MAX_PORTFOLIO_RISK_PCT: 0.02,    // 2% total open risk
  DAILY_LOSS_LIMIT_PCT:   0.02,    // 2% daily loss block
  MAX_OPEN_POSITIONS:     8,
  TIMEZONE:               "Europe/Athens",
} as const;

export const PAPER_STARTING_EQUITY = 20_000;

/* ───────────── Types ───────────── */

export interface TradeRequest {
  symbol:     string;
  side:       "buy" | "sell";
  entryPrice: number;
  stopLoss:   number;
}

export interface RiskDecision {
  allowed:              boolean;
  reason:               string;
  equity:               number;
  maxTradeRisk:         number;
  requestedRisk:        number;
  currentPortfolioRisk: number;
  maxPortfolioRisk:     number;
  dailyPnL:             number;
  dailyLossLimit:       number;
  openPositions:        number;
  quantity:             number;
  notional:             number;
  message:              string;
}

/* ───────────── Helpers ───────────── */

/** Start of the current Europe/Athens calendar day in UTC. */
function athensStartOfDay(): string {
  const now = new Date();
  const athensMidnight = new Date(
    now.toLocaleString("en-US", { timeZone: RISK_CONFIG.TIMEZONE })
  );
  athensMidnight.setHours(0, 0, 0, 0);
  // Convert back: offset between Athens local and UTC
  const localOffset = now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const athensOffset = now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: RISK_CONFIG.TIMEZONE })).getTime();
  const utcMidnight = new Date(athensMidnight.getTime() + athensOffset - localOffset);
  return utcMidnight.toISOString();
}

/* ───────────── Core queries ───────────── */

/** Paper equity = starting capital + all realized closed-paper PnL. */
export async function getPaperEquity(db: Admin): Promise<number> {
  const { data, error } = await (db.from as any)("trades")
    .select("pnl")
    .eq("mode", "paper")
    .eq("status", "closed");
  if (error) throw new Error(`getPaperEquity: ${error.message}`);

  const realized = ((data ?? []) as { pnl: number | null }[])
    .reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  const equity = PAPER_STARTING_EQUITY + realized;
  return Math.max(equity, 1); // guard against zero/negative
}

/** Sum of risk (|entry - stop| * qty) across all open paper positions. */
export async function getOpenPortfolioRisk(db: Admin): Promise<number> {
  const { data, error } = await (db.from as any)("trades")
    .select("entry_price, stop_loss, quantity")
    .eq("mode", "paper")
    .eq("status", "open");
  if (error) throw new Error(`getOpenPortfolioRisk: ${error.message}`);

  return ((data ?? []) as { entry_price: number; stop_loss: number | null; quantity: number }[])
    .reduce((sum, t) => {
      if (t.stop_loss == null) return sum;
      return sum + Math.abs(t.entry_price - t.stop_loss) * Number(t.quantity);
    }, 0);
}

/** Realized PnL from paper trades closed today (Athens calendar day). */
export async function getDailyRealizedPnL(db: Admin): Promise<number> {
  const dayStart = athensStartOfDay();
  const { data, error } = await (db.from as any)("trades")
    .select("pnl")
    .eq("mode", "paper")
    .eq("status", "closed")
    .gte("closed_at", dayStart);
  if (error) throw new Error(`getDailyRealizedPnL: ${error.message}`);

  return ((data ?? []) as { pnl: number | null }[])
    .reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
}

/** Count of currently open paper positions. */
async function countOpenPositions(db: Admin): Promise<number> {
  const { count, error } = await (db.from as any)("trades")
    .select("id", { count: "exact", head: true })
    .eq("mode", "paper")
    .eq("status", "open");
  if (error) throw new Error(`countOpenPositions: ${error.message}`);
  return count ?? 0;
}

/* ───────────── Main gate ───────────── */

export async function canOpenTrade(db: Admin, req: TradeRequest): Promise<RiskDecision> {
  const base: Omit<RiskDecision, "allowed" | "reason" | "message"> = {
    equity:               0,
    maxTradeRisk:         0,
    requestedRisk:        0,
    currentPortfolioRisk: 0,
    maxPortfolioRisk:     0,
    dailyPnL:             0,
    dailyLossLimit:       0,
    openPositions:        0,
    quantity:             0,
    notional:             0,
  };

  const reject = (reason: string, message: string): RiskDecision => ({
    ...base, allowed: false, reason, message,
  });

  try {
    /* ── 1. Stop-loss validation ── */
    const { entryPrice, stopLoss, side } = req;

    if (entryPrice <= 0 || stopLoss <= 0) {
      return reject("invalid_stop", `${req.symbol} ${side}: entryPrice or stopLoss <= 0`);
    }

    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance <= 0) {
      return reject("invalid_stop", `${req.symbol} ${side}: stopDistance is zero`);
    }

    if (side === "buy" && stopLoss >= entryPrice) {
      return reject("invalid_stop", `${req.symbol} BUY: stopLoss (${stopLoss}) must be below entryPrice (${entryPrice})`);
    }
    if (side === "sell" && stopLoss <= entryPrice) {
      return reject("invalid_stop", `${req.symbol} SELL: stopLoss (${stopLoss}) must be above entryPrice (${entryPrice})`);
    }

    /* ── 2. Load state ── */
    const [equity, currentPortfolioRisk, dailyPnL, openPositions] = await Promise.all([
      getPaperEquity(db),
      getOpenPortfolioRisk(db),
      getDailyRealizedPnL(db),
      countOpenPositions(db),
    ]);

    if (!Number.isFinite(equity) || equity <= 0) {
      return reject("invalid_equity", `${req.symbol} ${side}: invalid equity (${equity})`);
    }

    const maxTradeRisk     = equity * RISK_CONFIG.MAX_RISK_PER_TRADE_PCT;
    const maxPortfolioRisk = equity * RISK_CONFIG.MAX_PORTFOLIO_RISK_PCT;
    const dailyLossLimit   = -(equity * RISK_CONFIG.DAILY_LOSS_LIMIT_PCT);

    /* ── Position sizing ── */
    const quantity = maxTradeRisk / stopDistance;
    const notional = quantity * entryPrice;
    const requestedRisk = stopDistance * quantity; // == maxTradeRisk by construction

    Object.assign(base, {
      equity, maxTradeRisk, requestedRisk,
      currentPortfolioRisk, maxPortfolioRisk,
      dailyPnL, dailyLossLimit,
      openPositions, quantity, notional,
    });

    /* ── 3. Max open positions ── */
    if (openPositions >= RISK_CONFIG.MAX_OPEN_POSITIONS) {
      return {
        ...base, allowed: false,
        reason: "max_positions",
        message: `${req.symbol} ${side}: max open positions reached (${openPositions}/${RISK_CONFIG.MAX_OPEN_POSITIONS})`,
      };
    }

    /* ── 4. Daily loss limit ── */
    if (dailyPnL <= dailyLossLimit) {
      return {
        ...base, allowed: false,
        reason: "daily_loss_limit",
        message: `${req.symbol} ${side}: daily loss limit hit (${dailyPnL.toFixed(2)} <= ${dailyLossLimit.toFixed(2)})`,
      };
    }

    /* ── 5. Portfolio risk cap ── */
    if (currentPortfolioRisk + requestedRisk > maxPortfolioRisk) {
      return {
        ...base, allowed: false,
        reason: "portfolio_risk_limit",
        message: `${req.symbol} ${side}: portfolio risk full (${(currentPortfolioRisk + requestedRisk).toFixed(2)} > ${maxPortfolioRisk.toFixed(2)})`,
      };
    }

    /* ── Approved ── */
    return {
      ...base, allowed: true,
      reason: "allowed",
      message: `${req.symbol} ${side}: approved qty=${quantity.toFixed(6)} notional=${notional.toFixed(2)}`,
    };

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[RISK_ENGINE_ERROR] ${req.symbol} ${req.side}: ${msg}`);
    return reject("risk_engine_error", `${req.symbol} ${req.side}: risk engine error — ${msg}`);
  }
}

/**
 * Risk Management Safety Layer — Paper Mode Only
 *
 * Safety rules:
 * - 0.15% max economic risk per trade, INCLUDING estimated entry + stop fees.
 * - 1.2% max aggregate open stop-risk, INCLUDING estimated fees.
 * - 1.2% daily economic loss limit = realized PnL today + current unrealized
 *   PnL on all open paper trades (net of estimated exit fees).
 * - 3 maximum open paper positions in normal mode.
 *
 * Paper research mode retains the calculations above for telemetry but does
 * not use capacity/economic brakes to reject BUY opportunities. Live mode
 * never enables research mode.
 *
 * Loss-streak kill switch: if 3+ of last 5 closed trades are losses, halt new entries.
 */

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")["supabaseAdmin"]>;

export const RISK_CONFIG = {
  MAX_RISK_PER_TRADE_PCT: 0.0020,
  MAX_PORTFOLIO_RISK_PCT: 0.012,
  DAILY_LOSS_LIMIT_PCT: 0.012,
  MAX_OPEN_POSITIONS: 10,
  TIMEZONE: "Europe/Athens",
  FEE_RATE: 0.0005,
  LOSS_STREAK_HALT: 3,
  LOSS_STREAK_LOOKBACK: 5,
} as const;

export const PAPER_STARTING_EQUITY = 20_000;

export interface TradeRequest {
  symbol: string;
  side: "buy" | "sell";
  entryPrice: number;
  stopLoss: number;
  /** Current Binance prices keyed by Binance symbol, e.g. BTCUSDT. */
  currentPrices?: Map<string, number>;
  /**
   * Paper research mode deliberately removes portfolio-capacity/economic
   * brakes so eligible BUY signals are not discarded before measurement.
   * Live mode never enables this.
   */
  researchMode?: boolean;
}

export interface RiskDecision {
  allowed: boolean;
  reason: string;
  equity: number;
  maxTradeRisk: number;
  requestedRisk: number;
  currentPortfolioRisk: number;
  maxPortfolioRisk: number;
  dailyPnL: number;
  dailyLossLimit: number;
  openPositions: number;
  quantity: number;
  notional: number;
  estimatedEntryFee: number;
  estimatedStopFee: number;
  estimatedRoundTripFees: number;
  message: string;
}

function athensStartOfDay(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: RISK_CONFIG.TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offsetText = new Intl.DateTimeFormat("en-US", {
    timeZone: RISK_CONFIG.TIMEZONE,
    timeZoneName: "longOffset",
  }).formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT+02:00";
  const match = offsetText.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const sign = match?.[1] === "-" ? -1 : 1;
  const hours = Number(match?.[2] ?? 2);
  const minutes = Number(match?.[3] ?? 0);
  const offsetMs = sign * (hours * 60 + minutes) * 60_000;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs).toISOString();
}

export async function getPaperEquity(db: Admin): Promise<number> {
  const { data, error } = await (db.from as any)("trades")
    .select("pnl")
    .eq("mode", "paper")
    .eq("status", "closed")
    .eq("side", "buy");
  if (error) throw new Error(`getPaperEquity: ${error.message}`);
  const realized = ((data ?? []) as { pnl: number | null }[])
    .reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  return Math.max(PAPER_STARTING_EQUITY + realized, 1);
}

/** Open stop-risk including estimated fees if every open trade hits its stop. */
export async function getOpenPortfolioRisk(db: Admin): Promise<number> {
  const { data, error } = await (db.from as any)("trades")
    .select("entry_price, stop_loss, quantity")
    .eq("mode", "paper")
    .eq("status", "open")
    .eq("side", "buy");
  if (error) throw new Error(`getOpenPortfolioRisk: ${error.message}`);

  return ((data ?? []) as { entry_price: number; stop_loss: number | null; quantity: number }[])
    .reduce((sum, t) => {
      if (t.stop_loss == null) return sum;
      const entry = Number(t.entry_price);
      const stop = Number(t.stop_loss);
      const qty = Number(t.quantity);
      if (![entry, stop, qty].every(Number.isFinite) || qty <= 0) return sum;
      const grossStopRisk = Math.abs(entry - stop) * qty;
      const fees = (entry + stop) * qty * RISK_CONFIG.FEE_RATE;
      return sum + grossStopRisk + fees;
    }, 0);
}

export async function getDailyRealizedPnL(db: Admin): Promise<number> {
  const dayStart = athensStartOfDay();
  const { data, error } = await (db.from as any)("trades")
    .select("pnl")
    .eq("mode", "paper")
    .eq("status", "closed")
    .eq("side", "buy")
    .gte("closed_at", dayStart);
  if (error) throw new Error(`getDailyRealizedPnL: ${error.message}`);
  return ((data ?? []) as { pnl: number | null }[])
    .reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
}

export async function getOpenUnrealizedPnL(
  db: Admin,
  currentPrices: Map<string, number>,
): Promise<number> {
  const { data, error } = await (db.from as any)("trades")
    .select("symbol, side, entry_price, quantity")
    .eq("mode", "paper")
    .eq("status", "open")
    .eq("side", "buy");
  if (error) throw new Error(`getOpenUnrealizedPnL: ${error.message}`);

  return ((data ?? []) as { symbol: string; side: "buy" | "sell"; entry_price: number; quantity: number }[])
    .reduce((sum, t) => {
      const current = currentPrices.get(`${t.symbol === "MATIC" ? "POL" : t.symbol === "RNDR" ? "RENDER" : t.symbol}USDT`);
      const entry = Number(t.entry_price);
      const qty = Number(t.quantity);
      if (current == null || !Number.isFinite(current) || !Number.isFinite(entry) || !Number.isFinite(qty) || qty <= 0) return sum;
      const gross = (t.side === "buy" ? current - entry : entry - current) * qty;
      const estimatedExitFee = current * qty * RISK_CONFIG.FEE_RATE;
      return sum + gross - estimatedExitFee;
    }, 0);
}

export async function getDailyEconomicPnL(
  db: Admin,
  currentPrices: Map<string, number>,
): Promise<number> {
  const [realized, unrealized] = await Promise.all([
    getDailyRealizedPnL(db),
    getOpenUnrealizedPnL(db, currentPrices),
  ]);
  return realized + unrealized;
}

async function countOpenPositions(db: Admin): Promise<number> {
  const { count, error } = await (db.from as any)("trades")
    .select("id", { count: "exact", head: true })
    .eq("mode", "paper")
    .eq("status", "open")
    .eq("side", "buy");
  if (error) throw new Error(`countOpenPositions: ${error.message}`);
  return count ?? 0;
}

export async function canOpenTrade(db: Admin, req: TradeRequest): Promise<RiskDecision> {
  const base: Omit<RiskDecision, "allowed" | "reason" | "message"> = {
    equity: 0,
    maxTradeRisk: 0,
    requestedRisk: 0,
    currentPortfolioRisk: 0,
    maxPortfolioRisk: 0,
    dailyPnL: 0,
    dailyLossLimit: 0,
    openPositions: 0,
    quantity: 0,
    notional: 0,
    estimatedEntryFee: 0,
    estimatedStopFee: 0,
    estimatedRoundTripFees: 0,
  };

  const reject = (reason: string, message: string): RiskDecision => ({ ...base, allowed: false, reason, message });

  try {
    const { entryPrice, stopLoss, side } = req;
    const researchMode = req.researchMode === true;
    if (side !== "buy") return reject("long_only", `${req.symbol} SELL: short execution is disabled; SELL remains a market signal, not an executable position.`);
    if (entryPrice <= 0 || stopLoss <= 0) return reject("invalid_stop", `${req.symbol} ${side}: entryPrice or stopLoss <= 0`);
    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance <= 0) return reject("invalid_stop", `${req.symbol} ${side}: stopDistance is zero`);
    if (side === "buy" && stopLoss >= entryPrice) return reject("invalid_stop", `${req.symbol} BUY: stopLoss must be below entryPrice`);
    if (side === "sell" && stopLoss <= entryPrice) return reject("invalid_stop", `${req.symbol} SELL: stopLoss must be above entryPrice`);

    const currentPrices = req.currentPrices ?? new Map<string, number>();
    const [equity, currentPortfolioRisk, dailyPnL, openPositions] = await Promise.all([
      getPaperEquity(db),
      getOpenPortfolioRisk(db),
      getDailyEconomicPnL(db, currentPrices),
      countOpenPositions(db),
    ]);

    if (!Number.isFinite(equity) || equity <= 0) return reject("invalid_equity", `${req.symbol} ${side}: invalid equity (${equity})`);

    const maxTradeRisk = equity * RISK_CONFIG.MAX_RISK_PER_TRADE_PCT;
    const maxPortfolioRisk = equity * RISK_CONFIG.MAX_PORTFOLIO_RISK_PCT;
    const dailyLossLimit = -(equity * RISK_CONFIG.DAILY_LOSS_LIMIT_PCT);

    const perUnitEconomicRisk = stopDistance + (entryPrice + stopLoss) * RISK_CONFIG.FEE_RATE;
    if (!Number.isFinite(perUnitEconomicRisk) || perUnitEconomicRisk <= 0) return reject("invalid_risk", `${req.symbol} ${side}: invalid fee-aware per-unit risk`);
    const quantity = maxTradeRisk / perUnitEconomicRisk;
    const notional = quantity * entryPrice;
    const estimatedEntryFee = entryPrice * quantity * RISK_CONFIG.FEE_RATE;
    const estimatedStopFee = stopLoss * quantity * RISK_CONFIG.FEE_RATE;
    const estimatedRoundTripFees = estimatedEntryFee + estimatedStopFee;
    const requestedRisk = stopDistance * quantity + estimatedRoundTripFees;

    Object.assign(base, {
      equity, maxTradeRisk, requestedRisk, currentPortfolioRisk, maxPortfolioRisk,
      dailyPnL, dailyLossLimit, openPositions, quantity, notional,
      estimatedEntryFee, estimatedStopFee, estimatedRoundTripFees,
    });

    // Paper research mode is intentionally capacity-unbounded. We still
    // calculate and persist the normal risk metrics for later analysis, but
    // do not discard opportunities because the research portfolio is full.
    if (!researchMode && openPositions >= RISK_CONFIG.MAX_OPEN_POSITIONS) {
      return { ...base, allowed: false, reason: "max_positions", message: `${req.symbol} ${side}: max open positions reached (${openPositions}/${RISK_CONFIG.MAX_OPEN_POSITIONS})` };
    }
    if (!researchMode && dailyPnL <= dailyLossLimit) {
      return { ...base, allowed: false, reason: "daily_loss_limit", message: `${req.symbol} ${side}: daily economic loss limit hit (${dailyPnL.toFixed(2)} <= ${dailyLossLimit.toFixed(2)})` };
    }

    // ── Loss-streak kill switch ─────────────────────────────────────
    {
      const { data: recentClosed } = await db
        .from("trades")
        .select("pnl")
        .eq("status", "closed")
        .eq("mode", "paper")
        .eq("side", "buy")
        .order("closed_at", { ascending: false })
        .limit(RISK_CONFIG.LOSS_STREAK_LOOKBACK);

      if (recentClosed && recentClosed.length >= RISK_CONFIG.LOSS_STREAK_HALT) {
        let streak = 0;
        for (const t of recentClosed) {
          if (Number(t.pnl) < 0) streak += 1;
          else break;
        }
        if (!researchMode && streak >= RISK_CONFIG.LOSS_STREAK_HALT) {
          return {
            ...base,
            allowed: false,
            reason: "loss_streak_halt",
            message: `${req.symbol} ${side}: HALT — ${streak} consecutive losses. No new entries.`,
          };
        }
      }
    }
    // ───────────────────────────────────────────────────────────────

    if (!researchMode && currentPortfolioRisk + requestedRisk > maxPortfolioRisk) {
      return { ...base, allowed: false, reason: "portfolio_risk_limit", message: `${req.symbol} ${side}: portfolio economic risk full (${(currentPortfolioRisk + requestedRisk).toFixed(2)} > ${maxPortfolioRisk.toFixed(2)})` };
    }

    return {
      ...base,
      allowed: true,
      reason: "allowed",
      message: `${req.symbol} ${side}: approved qty=${quantity.toFixed(8)} notional=${notional.toFixed(2)} economicRisk=${requestedRisk.toFixed(2)} fees=${estimatedRoundTripFees.toFixed(2)} daily=${dailyPnL.toFixed(2)}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[RISK_ENGINE_ERROR] ${req.symbol} ${req.side}: ${msg}`);
    return reject("risk_engine_error", `${req.symbol} ${req.side}: risk engine error — ${msg}`);
  }
}

/**
 * Global Take Profit + Equity Trailing Stop
 *
 * Two complementary portfolio-level safeguards. Unlike per-trade TP/SL
 * which act independently, these operate on ALL open positions at once.
 *
 * ─── GTP (Global Take Profit) ───
 * Fires when aggregate unrealized PnL on open positions reaches a
 * regime-aware percentage of base equity. Best for sideways/bear
 * markets where mean reversion is more likely than continuation.
 *
 * ─── ETS (Equity Trailing Stop) ───
 * Activates once current equity rises above a threshold, then closes
 * all when equity drops N% from its peak. Best for trending markets
 * where we want to let winners run.
 *
 * ─── Regime-Aware Thresholds ───
 * strong_bull: run with higher GTP (15%), wider trail (4%) — trends persist
 * bull:        moderate GTP (12%), moderate trail (3%)
 * sideways:    lower GTP (8%), tight trail (2.5%) — lock gains fast
 * bear:        low GTP (6%), tight trail (2%)
 * strong_bear: minimal GTP (5%), tightest trail (1.5%) — escape fast
 *
 * ─── Shadow Mode ───
 * Default ON. Every decision is logged to `global_risk_events` without
 * closing real positions. After 7-14 days of shadow data, tune thresholds
 * and enable live mode.
 */

import { RISK_CONFIG } from "./risk.engine";
import { computeFeeAwarePnl, TRADING_FEE_RATE } from "./fees";
import type { SessionInfo } from "./market-session";

type Admin = Awaited<
  typeof import("@/integrations/supabase/client.server")
>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const STARTING_EQUITY = (RISK_CONFIG as { STARTING_EQUITY?: number }).STARTING_EQUITY ?? 20_000;

/* ───────────── Types ───────────── */

export interface PortfolioSnapshot {
  starting_equity: number;
  realized_pnl: number;
  /** base_equity = starting + realized (no unrealized) — denominator for GTP% */
  base_equity: number;
  unrealized_pnl_gross: number;
  unrealized_pnl_net: number;
  current_equity: number;
  open_positions: number;
  open_notional: number;
  positions: OpenPosition[];
}

export interface OpenPosition {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  entry_price: number;
  current_price: number;
  value: number;      // current_price × quantity
  pnl_gross: number;
  pnl_net: number;    // after estimated exit fee
}

export interface RegimeThresholds {
  gtp_pct: number | null;      // null = GTP disabled in this regime
  ets_activation_pct: number;
  ets_distance_pct: number;
  cooldown_minutes: number;
}

export interface GlobalRiskControl {
  enabled: boolean;
  shadow_mode: boolean;
  min_open_positions: number;
  min_total_notional_usd: number;
  regime_overrides: Record<string, RegimeThresholds>;
  default: RegimeThresholds;
}

export interface GlobalRiskState {
  peak_equity: number | null;
  peak_at: string | null;
  cooldown_until: string | null;
  last_trigger_at: string | null;
  last_trigger_type: "gtp" | "ets" | null;
  previous_regime: string | null;
}

export interface GlobalRiskDecision {
  evaluated: boolean;
  triggered: boolean;
  trigger_type: "gtp" | "ets" | null;
  shadow: boolean;
  in_cooldown: boolean;
  cooldown_until: string | null;
  snapshot: PortfolioSnapshot | null;
  thresholds: RegimeThresholds | null;
  peak_equity: number;
  drawdown_pct: number;
  unrealized_pct: number;
  reasoning: string;
}

/* ───────────── Defaults ───────────── */

export const DEFAULT_GLOBAL_RISK_CONTROL: GlobalRiskControl = {
  enabled: false,
  shadow_mode: true,
  min_open_positions: 2,
  min_total_notional_usd: 500,
  regime_overrides: {
    strong_bull: { gtp_pct: 15, ets_activation_pct: 8, ets_distance_pct: 4, cooldown_minutes: 30 },
    bull:        { gtp_pct: 12, ets_activation_pct: 6, ets_distance_pct: 3, cooldown_minutes: 45 },
    sideways:    { gtp_pct: 8,  ets_activation_pct: 5, ets_distance_pct: 2.5, cooldown_minutes: 60 },
    bear:        { gtp_pct: 6,  ets_activation_pct: 4, ets_distance_pct: 2, cooldown_minutes: 90 },
    strong_bear: { gtp_pct: 5,  ets_activation_pct: 3, ets_distance_pct: 1.5, cooldown_minutes: 120 },
  },
  default: { gtp_pct: 10, ets_activation_pct: 5, ets_distance_pct: 3, cooldown_minutes: 60 },
};

export const DEFAULT_GLOBAL_RISK_STATE: GlobalRiskState = {
  peak_equity: null,
  peak_at: null,
  cooldown_until: null,
  last_trigger_at: null,
  last_trigger_type: null,
  previous_regime: null,
};

/* ───────────── Config / State loaders ───────────── */

export async function getGlobalRiskControl(): Promise<GlobalRiskControl> {
  try {
    const db = await admin();
    const { data, error } = await db
      .from("pipeline_settings")
      .select("global_risk_control")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return DEFAULT_GLOBAL_RISK_CONTROL;
    const raw = (data as { global_risk_control?: unknown }).global_risk_control;
    if (!raw || typeof raw !== "object") return DEFAULT_GLOBAL_RISK_CONTROL;
    // Shallow merge with defaults to tolerate partial configs
    return {
      ...DEFAULT_GLOBAL_RISK_CONTROL,
      ...(raw as Partial<GlobalRiskControl>),
      regime_overrides: {
        ...DEFAULT_GLOBAL_RISK_CONTROL.regime_overrides,
        ...((raw as Partial<GlobalRiskControl>).regime_overrides ?? {}),
      },
      default: {
        ...DEFAULT_GLOBAL_RISK_CONTROL.default,
        ...((raw as Partial<GlobalRiskControl>).default ?? {}),
      },
    };
  } catch (e) {
    console.warn("[GLOBAL_RISK] config load failed, using defaults:", e);
    return DEFAULT_GLOBAL_RISK_CONTROL;
  }
}

export async function getGlobalRiskState(): Promise<GlobalRiskState> {
  try {
    const db = await admin();
    const { data, error } = await db
      .from("pipeline_settings")
      .select("global_risk_state")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return DEFAULT_GLOBAL_RISK_STATE;
    const raw = (data as { global_risk_state?: unknown }).global_risk_state;
    if (!raw || typeof raw !== "object") return DEFAULT_GLOBAL_RISK_STATE;
    return { ...DEFAULT_GLOBAL_RISK_STATE, ...(raw as Partial<GlobalRiskState>) };
  } catch {
    return DEFAULT_GLOBAL_RISK_STATE;
  }
}

export async function saveGlobalRiskState(state: GlobalRiskState): Promise<void> {
  try {
    const db = await admin();
    const { error } = await db
      .from("pipeline_settings")
      .update({ global_risk_state: state } as never)
      .eq("id", 1);
    if (error) console.warn("[GLOBAL_RISK] state save failed:", error);
  } catch (e) {
    console.warn("[GLOBAL_RISK] state save threw:", e);
  }
}

/* ───────────── Regime-aware thresholds ───────────── */

export function getRegimeThresholds(
  config: GlobalRiskControl,
  regimeLabel: string | null,
): RegimeThresholds {
  if (!regimeLabel) return config.default;
  const key = regimeLabel.toLowerCase().replace(/\s+/g, "_");
  return config.regime_overrides[key] ?? config.default;
}

/* ───────────── Portfolio snapshot ───────────── */

/**
 * Computes the current portfolio state from the DB and current prices.
 *
 * - Realized PnL: sum of net_pnl on all closed trades.
 * - Unrealized PnL: sum of (current - entry) × qty × sign, minus estimated
 *   exit fee (TRADING_FEE_RATE × current × qty).
 * - Base equity: starting + realized. Used as the denominator for GTP%.
 * - Current equity: base + unrealized_net. Used for peak tracking.
 */
export async function computePortfolioSnapshot(
  db: Admin,
  prices: Map<string, number>,
): Promise<PortfolioSnapshot> {
  const [closedRes, openRes] = await Promise.all([
    db.from("trades").select("net_pnl").eq("status", "closed").eq("side", "buy"),
    db
      .from("trades")
      .select("id, symbol, side, quantity, entry_price")
      .eq("status", "open")
      .eq("side", "buy"),
  ]);

  if (closedRes.error) throw closedRes.error;
  if (openRes.error) throw openRes.error;

  const realized_pnl = ((closedRes.data ?? []) as { net_pnl: number | null }[])
    .reduce((s, r) => s + (Number(r.net_pnl) || 0), 0);

  const base_equity = STARTING_EQUITY + realized_pnl;

  const binanceSymbol = (coin: string): string => {
    const map: Record<string, string> = { MATIC: "POL", RNDR: "RENDER" };
    return `${map[coin] ?? coin}USDT`;
  };

  const positions: OpenPosition[] = [];
  let unrealized_gross = 0;
  let unrealized_net = 0;
  let open_notional = 0;

  for (const raw of (openRes.data ?? []) as {
    id: string; symbol: string; side: "buy" | "sell";
    quantity: number; entry_price: number;
  }[]) {
    const sym = binanceSymbol(raw.symbol);
    const current = prices.get(sym);
    const entry = Number(raw.entry_price);
    const qty = Number(raw.quantity);
    if (current == null || !Number.isFinite(entry) || !Number.isFinite(qty)) continue;

    const value = current * qty;
    const fee = computeFeeAwarePnl(raw.side, entry, current, qty);
    // computeFeeAwarePnl subtracts both entry (already paid) and exit fees.
    // For unrealized we only want the exit fee + price move, so we
    // reconstruct the components:
    const grossDelta = (raw.side === "buy" ? current - entry : entry - current) * qty;
    const exitFee = current * qty * TRADING_FEE_RATE;
    const netDelta = grossDelta - exitFee;

    positions.push({
      id: raw.id,
      symbol: raw.symbol,
      side: raw.side,
      quantity: qty,
      entry_price: entry,
      current_price: current,
      value,
      pnl_gross: grossDelta,
      pnl_net: netDelta,
    });

    unrealized_gross += grossDelta;
    unrealized_net += netDelta;
    open_notional += value;
    // (fee from computeFeeAwarePnl isn't used here — we only need exit fee
    //  because entry fee was already deducted when the trade opened.)
    void fee;
  }

  return {
    starting_equity: STARTING_EQUITY,
    realized_pnl,
    base_equity,
    unrealized_pnl_gross: unrealized_gross,
    unrealized_pnl_net: unrealized_net,
    current_equity: base_equity + unrealized_net,
    open_positions: positions.length,
    open_notional,
    positions,
  };
}

/* ───────────── Cooldown helpers ───────────── */

function isInCooldown(state: GlobalRiskState, now = Date.now()): boolean {
  if (!state.cooldown_until) return false;
  const ts = new Date(state.cooldown_until).getTime();
  return Number.isFinite(ts) && ts > now;
}

/* ───────────── Peak tracking ───────────── */

/**
 * Updates the peak equity tracker.
 *
 * Rules:
 *  - peak_equity = max(existing, current_equity)
 *  - If we're in cooldown, reset to current (post-trigger baseline).
 *  - If cooldown has just expired, reset to current (fresh cycle).
 */
export function updatePeakEquity(
  state: GlobalRiskState,
  snapshot: PortfolioSnapshot,
  now = Date.now(),
): GlobalRiskState {
  const nowIso = new Date(now).toISOString();

  const cooldownActive = isInCooldown(state, now);
  const cooldownJustExpired =
    state.cooldown_until != null &&
    !cooldownActive &&
    state.last_trigger_at != null;

  if (state.peak_equity == null || cooldownActive || cooldownJustExpired) {
    return {
      ...state,
      peak_equity: snapshot.current_equity,
      peak_at: nowIso,
      // Clear stale cooldown after reset
      cooldown_until: cooldownActive ? state.cooldown_until : null,
    };
  }

  if (snapshot.current_equity > state.peak_equity) {
    return {
      ...state,
      peak_equity: snapshot.current_equity,
      peak_at: nowIso,
    };
  }

  return state;
}

/* ───────────── Main evaluator ───────────── */

export async function evaluateGlobalRisk(
  db: Admin,
  regimeLabel: string | null,
  regimeScore: number | null,
  marketSession: SessionInfo | null,
  prices: Map<string, number>,
): Promise<GlobalRiskDecision> {
  const config = await getGlobalRiskControl();
  const stateBefore = await getGlobalRiskState();
  const now = Date.now();

  const snapshot = await computePortfolioSnapshot(db, prices);

  // Track peak equity regardless of enabled/disabled state — historical
  // data is valuable for analysis even in shadow mode.
  const stateAfterPeak = updatePeakEquity(stateBefore, snapshot, now);
  if (stateAfterPeak !== stateBefore) {
    await saveGlobalRiskState(stateAfterPeak);
  }
  const state = stateAfterPeak;
  const peak_equity = state.peak_equity ?? snapshot.current_equity;
  const drawdown_pct = peak_equity > 0
    ? Math.max(0, (peak_equity - snapshot.current_equity) / peak_equity)
    : 0;
  const unrealized_pct = snapshot.base_equity > 0
    ? snapshot.unrealized_pnl_net / snapshot.base_equity
    : 0;

  // Record an equity snapshot on every run (analytics + trajectory plot)
  await recordEquitySnapshot(db, snapshot, regimeLabel, marketSession);

  const notEvaluated: GlobalRiskDecision = {
    evaluated: false,
    triggered: false,
    trigger_type: null,
    shadow: config.shadow_mode,
    in_cooldown: false,
    cooldown_until: state.cooldown_until,
    snapshot,
    thresholds: null,
    peak_equity,
    drawdown_pct,
    unrealized_pct,
    reasoning: "",
  };

  if (!config.enabled && !config.shadow_mode) {
    return { ...notEvaluated, reasoning: "disabled" };
  }

  if (snapshot.open_positions < config.min_open_positions) {
    return {
      ...notEvaluated,
      evaluated: true,
      reasoning: `below min open positions (${snapshot.open_positions}/${config.min_open_positions})`,
    };
  }

  if (snapshot.open_notional < config.min_total_notional_usd) {
    return {
      ...notEvaluated,
      evaluated: true,
      reasoning: `below min notional ($${snapshot.open_notional.toFixed(0)}/$${config.min_total_notional_usd})`,
    };
  }

  const cooldownActive = isInCooldown(state, now);
  if (cooldownActive) {
    return {
      ...notEvaluated,
      evaluated: true,
      in_cooldown: true,
      reasoning: `in cooldown until ${state.cooldown_until}`,
    };
  }

  const thresholds = getRegimeThresholds(config, regimeLabel);

  // ─── GTP condition ───
  const gtpActive =
    thresholds.gtp_pct != null &&
    unrealized_pct * 100 >= thresholds.gtp_pct;

  // ─── ETS condition ───
  const etsActivated =
    snapshot.current_equity >=
    snapshot.base_equity * (1 + thresholds.ets_activation_pct / 100);

  const etsTriggered = etsActivated && drawdown_pct * 100 >= thresholds.ets_distance_pct;

  // ─── Decision ───
  let trigger_type: "gtp" | "ets" | null = null;
  let reasoning = "";

  if (gtpActive && etsTriggered) {
    // Both met — GTP is more conservative (closes more), prefer it
    trigger_type = "gtp";
    reasoning =
      `GTP and ETS both met. GTP preferred. ` +
      `unrealized=${(unrealized_pct * 100).toFixed(2)}% >= ${thresholds.gtp_pct}% ` +
      `AND drawdown=${(drawdown_pct * 100).toFixed(2)}% >= ${thresholds.ets_distance_pct}%`;
  } else if (gtpActive) {
    trigger_type = "gtp";
    reasoning =
      `GTP: unrealized=${(unrealized_pct * 100).toFixed(2)}% ` +
      `>= ${thresholds.gtp_pct}% (regime=${regimeLabel ?? "unknown"})`;
  } else if (etsTriggered) {
    trigger_type = "ets";
    reasoning =
      `ETS: peak=${peak_equity.toFixed(2)}, current=${snapshot.current_equity.toFixed(2)}, ` +
      `drawdown=${(drawdown_pct * 100).toFixed(2)}% >= ${thresholds.ets_distance_pct}% ` +
      `(regime=${regimeLabel ?? "unknown"})`;
  }

  if (!trigger_type) {
    return {
      ...notEvaluated,
      evaluated: true,
      thresholds,
      reasoning:
        `no trigger. unrealized=${(unrealized_pct * 100).toFixed(2)}% ` +
        `(GTP ${thresholds.gtp_pct ?? "off"}%), ` +
        `drawdown=${(drawdown_pct * 100).toFixed(2)}% ` +
        `(ETS dist ${thresholds.ets_distance_pct}%, ` +
        `activated=${etsActivated})`,
    };
  }

  // ─── Trigger fired ───
  const shadow = config.shadow_mode;

  if (shadow) {
    await recordGlobalRiskEvent(db, {
      event_type: trigger_type === "gtp" ? "shadow_gtp" : "shadow_ets",
      trigger_type,
      regime_label: regimeLabel,
      market_session: marketSession?.session ?? null,
      equity_before: snapshot.current_equity,
      equity_after: snapshot.base_equity,
      base_equity: snapshot.base_equity,
      unrealized_pnl: snapshot.unrealized_pnl_net,
      unrealized_pct: unrealized_pct * 100,
      peak_equity,
      drawdown_pct: drawdown_pct * 100,
      gtp_pct: thresholds.gtp_pct,
      ets_activation_pct: thresholds.ets_activation_pct,
      ets_distance_pct: thresholds.ets_distance_pct,
      positions_closed: snapshot.open_positions,
      positions_notional: snapshot.open_notional,
      closed_pnl_net: snapshot.unrealized_pnl_net,
      shadow: true,
      reasoning,
    });

    console.log(`[GLOBAL_RISK] SHADOW ${trigger_type.toUpperCase()}: ${reasoning}`);

    return {
      evaluated: true,
      triggered: true,
      trigger_type,
      shadow: true,
      in_cooldown: false,
      cooldown_until: null,
      snapshot,
      thresholds,
      peak_equity,
      drawdown_pct,
      unrealized_pct,
      reasoning: `[SHADOW] ${reasoning}`,
    };
  }

  // ─── Live mode: close all + set cooldown ───
  const closeResult = await closeAllOpenTrades(
    db,
    prices,
    trigger_type === "gtp" ? "global_take_profit" : "equity_trailing_stop",
    ["global-risk", trigger_type],
  );

  const cooldownMs = thresholds.cooldown_minutes * 60 * 1000;
  const cooldownUntilIso = new Date(now + cooldownMs).toISOString();

  const newState: GlobalRiskState = {
    ...state,
    peak_equity: null,        // reset for new cycle
    peak_at: null,
    cooldown_until: cooldownUntilIso,
    last_trigger_at: new Date(now).toISOString(),
    last_trigger_type: trigger_type,
    previous_regime: regimeLabel,
  };
  await saveGlobalRiskState(newState);

  await recordGlobalRiskEvent(db, {
    event_type: trigger_type === "gtp" ? "gtp_triggered" : "ets_triggered",
    trigger_type,
    regime_label: regimeLabel,
    market_session: marketSession?.session ?? null,
    equity_before: snapshot.current_equity,
    equity_after: closeResult.newEquity,
    base_equity: snapshot.base_equity,
    unrealized_pnl: snapshot.unrealized_pnl_net,
    unrealized_pct: unrealized_pct * 100,
    peak_equity,
    drawdown_pct: drawdown_pct * 100,
    gtp_pct: thresholds.gtp_pct,
    ets_activation_pct: thresholds.ets_activation_pct,
    ets_distance_pct: thresholds.ets_distance_pct,
    positions_closed: closeResult.closed,
    positions_notional: closeResult.totalNotional,
    closed_pnl_net: closeResult.netPnl,
    shadow: false,
    reasoning,
  });

  console.warn(
    `[GLOBAL_RISK] LIVE ${trigger_type.toUpperCase()} — closed ${closeResult.closed} positions, ` +
      `net PnL ${closeResult.netPnl.toFixed(2)}, cooldown ${thresholds.cooldown_minutes}min. ${reasoning}`,
  );

  return {
    evaluated: true,
    triggered: true,
    trigger_type,
    shadow: false,
    in_cooldown: false,
    cooldown_until: cooldownUntilIso,
    snapshot,
    thresholds,
    peak_equity,
    drawdown_pct,
    unrealized_pct,
    reasoning,
  };
}

/* ───────────── Bulk close ───────────── */

export async function closeAllOpenTrades(
  db: Admin,
  prices: Map<string, number>,
  reason: "global_take_profit" | "equity_trailing_stop" | "manual",
  sourceTags: string[],
): Promise<{ closed: number; totalNotional: number; netPnl: number; newEquity: number }> {
  const { data: openTrades, error } = await db
    .from("trades")
    .select("id, symbol, side, quantity, entry_price, mode, created_at")
    .eq("status", "open")
    .eq("side", "buy");
  if (error) throw error;

  const trades = (openTrades ?? []) as {
    id: string; symbol: string; side: "buy" | "sell";
    quantity: number; entry_price: number; mode: "paper" | "live";
    created_at: string;
  }[];

  if (trades.length === 0) {
    return { closed: 0, totalNotional: 0, netPnl: 0, newEquity: 0 };
  }

  const binanceSymbol = (coin: string): string => {
    const map: Record<string, string> = { MATIC: "POL", RNDR: "RENDER" };
    return `${map[coin] ?? coin}USDT`;
  };

  let closed = 0;
  let totalNotional = 0;
  let netPnl = 0;

  // Fetch realized PnL once (for newEquity computation)
  const { data: closedRows } = await db
    .from("trades")
    .select("net_pnl")
    .eq("status", "closed")
    .eq("side", "buy");
  const priorRealized = ((closedRows ?? []) as { net_pnl: number | null }[])
    .reduce((s, r) => s + (Number(r.net_pnl) || 0), 0);

  const closedAt = new Date().toISOString();

  for (const trade of trades) {
    const sym = binanceSymbol(trade.symbol);
    const price = prices.get(sym);
    const entryPrice = Number(trade.entry_price);
    const qty = Number(trade.quantity);
    if (price == null || !Number.isFinite(entryPrice) || !Number.isFinite(qty)) {
      console.warn(`[GLOBAL_RISK] skipping ${trade.symbol}: missing price`);
      continue;
    }

    const fee = computeFeeAwarePnl(trade.side, entryPrice, price, qty);
    const notional = price * qty;

    const { data: updated, error: updateErr } = await db
      .from("trades")
      .update({
        status: "closed",
        pnl: fee.netPnl,
        gross_pnl: fee.grossPnl,
        net_pnl: fee.netPnl,
        entry_fee: fee.entryFee,
        exit_fee: fee.exitFee,
        total_fees: fee.totalFees,
        exit_price: price,
        close_reason: reason,
        closed_at: closedAt,
      })
      .eq("id", trade.id)
      .eq("status", "open")
      .select("id")
      .maybeSingle();

    if (updateErr) {
      console.error(`[GLOBAL_RISK] close failed for ${trade.symbol}:`, updateErr);
      continue;
    }
    if (!updated) continue;

    await db.from("trade_alerts").insert({
      trade_id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      event_type: reason,
      entry_price: entryPrice,
      exit_price: price,
      pnl: fee.netPnl,
      pnl_pct: fee.netPnlPct,
      created_at: closedAt,
      tags: sourceTags,
    } as never);

    closed += 1;
    totalNotional += notional;
    netPnl += fee.netPnl;
  }

  const newEquity = STARTING_EQUITY + priorRealized + netPnl;
  return { closed, totalNotional, netPnl, newEquity };
}

/* ───────────── Logging ───────────── */

export async function recordEquitySnapshot(
  db: Admin,
  snapshot: PortfolioSnapshot,
  regimeLabel: string | null,
  marketSession: SessionInfo | null,
): Promise<void> {
  try {
    await (db as any).from("equity_snapshots").insert({
      equity: snapshot.current_equity,
      base_equity: snapshot.base_equity,
      realized_pnl: snapshot.realized_pnl,
      unrealized_pnl: snapshot.unrealized_pnl_net,
      open_positions: snapshot.open_positions,
      open_notional: snapshot.open_notional,
      regime_label: regimeLabel,
      market_session: marketSession?.session ?? null,
      captured_at: new Date().toISOString(),
    } as never);
  } catch (e) {
    console.warn("[GLOBAL_RISK] equity snapshot insert failed:", e);
  }
}

export async function recordGlobalRiskEvent(
  db: Admin,
  event: {
    event_type: string;
    trigger_type: "gtp" | "ets" | null;
    regime_label: string | null;
    market_session: string | null;
    equity_before: number;
    equity_after: number;
    base_equity: number;
    unrealized_pnl: number;
    unrealized_pct: number;
    peak_equity: number;
    drawdown_pct: number;
    gtp_pct: number | null;
    ets_activation_pct: number;
    ets_distance_pct: number;
    positions_closed: number;
    positions_notional: number;
    closed_pnl_net: number;
    shadow: boolean;
    reasoning: string;
  },
): Promise<void> {
  try {
    await (db as any).from("global_risk_events").insert({
      ...event,
      detected_at: new Date().toISOString(),
    } as never);
  } catch (e) {
    console.warn("[GLOBAL_RISK] event insert failed:", e);
  }
}

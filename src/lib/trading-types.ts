export interface WhaleAlert {
  id: string;
  symbol: string;
  chain: string | null;
  direction: "accumulation" | "distribution";
  usd_value: number;
  created_at: string;
}

export interface IndicatorSnapshot {
  id: string;
  symbol: string;
  timeframe: string;
  rsi: number | null;
  price: number | null;
  signal: "bullish" | "bearish" | "neutral" | null;
  created_at: string;
}

export interface PredictionSnapshot {
  id: string;
  market_slug: string;
  question: string | null;
  related_symbol: string | null;
  yes_price: number | null;
  no_price?: number | null;
  volume_24h?: number | null;
  created_at: string;
}

export interface CouncilSignal {
  id: string;
  symbol: string;
  final_verdict: string;
  conviction: number | null;
  price_at?: number | null;
  reflection?: string | null;
  depth?: string | null;
  source_created_at?: string | null;
  created_at?: string | null;
}

export interface PublicCouncilDecision extends CouncilSignal {
  id: string;
  final_verdict: string;
  conviction: number;
  created_at: string;
}

export interface PublicCouncilFeed {
  decisions: PublicCouncilDecision[];
}

export interface CompositeSignal {
  id: string;
  symbol: string;
  confidence: number;
  recommendation: "buy" | "sell" | "hold" | "watch";
  reasoning: string | null;
  created_at: string;
  entry_state?: "WATCH" | "ENTRY_READY" | "INVALIDATED" | null;
  entry_trigger?: string | null;
  entry_min?: number | null;
  entry_max?: number | null;
  stop_loss?: number | null;
  take_profit_1?: number | null;
  take_profit_2?: number | null;
  position_multiplier?: number | null;
}

export interface Trade {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  entry_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  mode: "paper" | "live";
  status: "open" | "closed" | "cancelled";
  pnl: number | null; // NET realized PnL (after fees) once closed
  entry_fee?: number | null;
  exit_fee?: number | null;
  total_fees?: number | null;
  gross_pnl?: number | null;
  net_pnl?: number | null;
  created_at: string;
  closed_at?: string | null;
  close_reason?: string | null;
  exit_price?: number | null;
}

export interface TradeAlert {
  id: string;
  trade_id: string;
  symbol: string;
  side: "buy" | "sell";
  event_type: "stop_loss" | "take_profit";
  entry_price: number;
  exit_price: number;
  pnl: number;
  pnl_pct: number;
  created_at: string;
}

/**
 * Snapshot του composite signal που πυροδότησε το trade.
 * Χρησιμοποιείται από το TradeAlertsPanel για expandable row.
 */
export interface CompositeSignalSnapshot {
  reasoning: string | null;
  confidence: number | null;
  created_at: string;
}

/**
 * A closed trade with the extra fields written by closeTriggeredTrades().
 * Used by TradeAlertsPanel to display both open and close timestamps.
 * Πλέον περιλαμβάνει και το composite_signal snapshot για expandable reasoning.
 */
export interface ClosedTrade {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  entry_price: number;
  exit_price: number | null;
  pnl: number | null; // net realized PnL (after fees)
  close_reason: string | null;
  created_at: string;
  closed_at: string | null;
  composite_signal_id?: string | null;
  composite_signal?: CompositeSignalSnapshot | null;
}

export interface CouncilLesson {
  id: string;
  symbol: string;
  verdict: string | null;
  conviction: number | null;
  outcome: "win" | "loss" | "breakeven";
  realized_pnl: number | null;
  pnl_pct: number | null;
  lesson: string;
  source_trade_id: string | null;
  created_at: string;
}

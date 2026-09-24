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
  pnl: number | null;
  created_at: string;
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

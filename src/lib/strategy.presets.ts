/* ───────────── Strategy types & constants (client-safe) ───────────── */

export interface StrategyConfig {
  whale_weight: number;
  technicals_weight: number;
  prediction_weight: number;
  council_weight: number;
  preset_name: string | null;
  updated_at: string;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  whale_weight: 1.0,
  technicals_weight: 1.0,
  prediction_weight: 1.0,
  council_weight: 1.0,
  preset_name: "balanced",
  updated_at: new Date(0).toISOString(),
};

export const STRATEGY_PRESETS: Record<
  string,
  Omit<StrategyConfig, "updated_at">
> = {
  balanced: {
    whale_weight: 1.0,
    technicals_weight: 1.0,
    prediction_weight: 1.0,
    council_weight: 1.0,
    preset_name: "balanced",
  },
  "whale-focused": {
    whale_weight: 2.0,
    technicals_weight: 0.5,
    prediction_weight: 0.5,
    council_weight: 0.5,
    preset_name: "whale-focused",
  },
  "chart-trader": {
    whale_weight: 0.5,
    technicals_weight: 2.0,
    prediction_weight: 0.5,
    council_weight: 0.5,
    preset_name: "chart-trader",
  },
  "sentiment-first": {
    whale_weight: 0.5,
    technicals_weight: 0.5,
    prediction_weight: 2.0,
    council_weight: 0.5,
    preset_name: "sentiment-first",
  },
  "ai-driven": {
    whale_weight: 0.5,
    technicals_weight: 0.5,
    prediction_weight: 0.5,
    council_weight: 2.0,
    preset_name: "ai-driven",
  },
  conservative: {
    whale_weight: 1.2,
    technicals_weight: 1.2,
    prediction_weight: 1.2,
    council_weight: 1.2,
    preset_name: "conservative",
  },
  "volatility-timing": {
    whale_weight: 0.3,
    technicals_weight: 2.2,
    prediction_weight: 0.5,
    council_weight: 1.0,
    preset_name: "volatility-timing",
  },
  "vwap-momentum": {
    whale_weight: 0.5,
    technicals_weight: 2.2,
    prediction_weight: 0.5,
    council_weight: 0.8,
    preset_name: "vwap-momentum",
  },
  "smc-reversal": {
    whale_weight: 0.4,
    technicals_weight: 2.5,
    prediction_weight: 0.4,
    council_weight: 0.8,
    preset_name: "smc-reversal",
  },
};

export const PRESET_LABELS: Record<string, string> = {
  balanced: "Balanced",
  "whale-focused": "Whale-Focused",
  "chart-trader": "Chart Trader",
  "sentiment-first": "Sentiment-First",
  "ai-driven": "AI-Driven",
  conservative: "Conservative",
  "volatility-timing": "BB + Aroon Timing",
  "vwap-momentum": "VWAP + RSI Intraday",
  "smc-reversal": "SMC Pro (BOS + ChoCh)",
  custom: "Custom",
};

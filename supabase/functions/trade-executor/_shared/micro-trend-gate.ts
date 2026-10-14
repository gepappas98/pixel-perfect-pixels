export type MicroTrend = "bullish" | "bearish" | "neutral";

export interface MicroTimeframeState {
  symbol: string;
  tf5m: MicroTrend;
  tf15m: MicroTrend;
  tf1h: MicroTrend;
  rsi5m?: number | null;
  rsi15m?: number | null;
  rsi1h?: number | null;
}

export interface MicroGateDecision {
  allowBuy: boolean;
  isMicroDowntrend: boolean;
  isConfirmedBounce: boolean;
  reason: string;
}

/** Deterministic, side-effect-free decision over the three micro timeframes. */
export function evaluateMicroTimeframeGate(state: MicroTimeframeState): MicroGateDecision {
  const states = [state.tf5m, state.tf15m, state.tf1h];
  const bears = states.filter((s) => s === "bearish").length;
  const bulls = states.filter((s) => s === "bullish").length;

  if (bears >= 2 && bulls === 0) {
    return { allowBuy: false, isMicroDowntrend: true, isConfirmedBounce: false,
      reason: `REJECT: Micro downtrend active (${bears}/3 bearish on 5m/15m/1h, 0 bullish)` };
  }
  if (bulls >= 2 && bears === 0) {
    return { allowBuy: true, isMicroDowntrend: false, isConfirmedBounce: true,
      reason: `CONFIRMED: Strong micro bounce (${bulls}/3 bullish on 5m/15m/1h)` };
  }
  if (bears > bulls) {
    return { allowBuy: false, isMicroDowntrend: true, isConfirmedBounce: false,
      reason: `CAUTION: Micro pressure negative (${bears} bear vs ${bulls} bull)` };
  }
  return { allowBuy: true, isMicroDowntrend: false, isConfirmedBounce: false,
    reason: `PASS: Micro timeframes balanced or supportive (${bulls} bull / ${bears} bear)` };
}

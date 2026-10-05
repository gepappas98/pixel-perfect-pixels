export type Trend = "bull" | "neutral" | "bear";
export type EntryState = "WATCH" | "ENTRY_READY" | "INVALIDATED";
export type EntryTrigger = "BREAKOUT" | "BREAKOUT_RETEST" | "PULLBACK_SUPPORT" | "MOMENTUM_CONFIRMATION" | null;

export interface SpotEntryInput {
  symbol: string; price: number; confidence: number; recommendation: string;
  h1Trend: Trend; h4Trend: Trend; d1Trend: Trend;
  resistance?: number | null; support?: number | null; recentHigh?: number | null; recentLow?: number | null;
  volumeRatio?: number | null; breakoutBufferPct?: number; volumeConfirmationRatio?: number;
  retestTolerancePct?: number; riskPerTradePct?: number; accountEquity?: number | null;
  atr?: number | null; atrStopMultiplier?: number; tp1R?: number; tp2R?: number;
  previousBreakoutPrice?: number | null; previousBreakoutConfirmed?: boolean; supportHoldConfirmed?: boolean;
}

export interface SpotEntryPlan {
  state: EntryState; trigger: EntryTrigger; symbol: string; price: number; confidence: number;
  positionMultiplier: number; entryMin: number | null; entryMax: number | null; stopLoss: number | null;
  takeProfit1: number | null; takeProfit2: number | null; riskRewardToTp1: number | null; riskRewardToTp2: number | null;
  breakoutConfirmed: boolean; volumeConfirmed: boolean; retestConfirmed: boolean;
  timeframeAlignment: { h1: Trend; h4: Trend; d1: Trend }; reasons: string[]; blockers: string[]; riskFlags: string[];
}

const DEFAULTS = { minConfidence: 0.7, breakoutBufferPct: 0.0015, volumeConfirmationRatio: 1.2, retestTolerancePct: 0.003, atrStopMultiplier: 1.5, tp1R: 1.5, tp2R: 2.5 };
const ENTRY_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const lastEntryAlerts = new Map<string, number>();

export function shouldSendEntryAlert(symbol: string): boolean {
  const previous = lastEntryAlerts.get(symbol);
  const now = Date.now();
  if (previous != null && now - previous < ENTRY_ALERT_COOLDOWN_MS) return false;
  lastEntryAlerts.set(symbol, now);
  return true;
}
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const confidence = (value: number) => Number.isFinite(value) ? (value > 1 ? value / 100 : value) : 0;

export function calculateSpotPositionSize({ accountEquity, entryPrice, stopLoss, riskPerTradePct, positionMultiplier }: { accountEquity: number; entryPrice: number; stopLoss: number; riskPerTradePct: number; positionMultiplier: number }) {
  if (accountEquity <= 0 || entryPrice <= 0 || stopLoss <= 0 || stopLoss >= entryPrice || riskPerTradePct <= 0 || positionMultiplier <= 0) return { quantity: 0, notional: 0, riskUsd: 0 };
  const riskUsd = accountEquity * (riskPerTradePct / 100) * positionMultiplier;
  const quantity = riskUsd / (entryPrice - stopLoss);
  return { quantity, notional: quantity * entryPrice, riskUsd };
}

export function evaluateSpotEntry(input: SpotEntryInput): SpotEntryPlan {
  const normalizedConfidence = confidence(input.confidence);
  const blockers: string[] = []; const reasons: string[] = []; const riskFlags: string[] = [];
  const multiplier = Math.max(0.25, Math.min(1, (input.d1Trend === "bull" ? 1 : input.d1Trend === "neutral" ? 0.75 : 0.5) * (normalizedConfidence < 0.7 ? 0.375 : normalizedConfidence < 0.75 ? 0.75 : 1)));
  const base = { symbol: input.symbol, price: input.price, confidence: normalizedConfidence, positionMultiplier: multiplier, timeframeAlignment: { h1: input.h1Trend, h4: input.h4Trend, d1: input.d1Trend }, reasons, blockers, riskFlags };
  if (input.recommendation.toLowerCase() !== "buy") return { ...base, state: "INVALIDATED", trigger: null, positionMultiplier: 0, entryMin: null, entryMax: null, stopLoss: null, takeProfit1: null, takeProfit2: null, riskRewardToTp1: null, riskRewardToTp2: null, breakoutConfirmed: false, volumeConfirmed: false, retestConfirmed: false, blockers: ["Signal is not BUY."] };
  if (!positive(input.price)) blockers.push("Invalid market price.");
  if (normalizedConfidence < DEFAULTS.minConfidence) blockers.push("Confidence below 70%.");
  if (input.h1Trend !== "bull") blockers.push("1h trend is not bullish.");
  if (input.h4Trend !== "bull") blockers.push("4h trend is not bullish.");
  if (input.d1Trend !== "bull") riskFlags.push(`Daily trend is ${input.d1Trend}; reduced position size.`);
  const resistance = positive(input.resistance) ? input.resistance : positive(input.recentHigh) ? input.recentHigh : null;
  const breakoutConfirmed = resistance != null && input.price >= resistance * (1 + (input.breakoutBufferPct ?? DEFAULTS.breakoutBufferPct));
  if (breakoutConfirmed) reasons.push(`Price confirmed above resistance ${resistance.toFixed(6)}.`); else blockers.push("No confirmed breakout.");
  const volumeConfirmed = positive(input.volumeRatio) && input.volumeRatio >= (input.volumeConfirmationRatio ?? DEFAULTS.volumeConfirmationRatio);
  if (volumeConfirmed) reasons.push(`Volume confirmation ${input.volumeRatio!.toFixed(2)}x.`); else blockers.push("Volume confirmation unavailable.");
  const retestConfirmed = input.supportHoldConfirmed === true || (input.previousBreakoutConfirmed === true && positive(input.previousBreakoutPrice) && Math.abs(input.price - input.previousBreakoutPrice) / input.previousBreakoutPrice <= (input.retestTolerancePct ?? DEFAULTS.retestTolerancePct));
  if (retestConfirmed) reasons.push("Breakout/retest confirmation.");
  const trigger: EntryTrigger = breakoutConfirmed && volumeConfirmed && retestConfirmed ? "BREAKOUT_RETEST" : breakoutConfirmed && volumeConfirmed ? "BREAKOUT" : input.supportHoldConfirmed && volumeConfirmed ? "PULLBACK_SUPPORT" : null;
  const stopLoss = positive(input.support) && input.support < input.price ? input.support : positive(input.atr) && input.price - input.atr * (input.atrStopMultiplier ?? DEFAULTS.atrStopMultiplier) > 0 ? input.price - input.atr * (input.atrStopMultiplier ?? DEFAULTS.atrStopMultiplier) : positive(input.recentLow) && input.recentLow < input.price ? input.recentLow : null;
  if (!stopLoss) blockers.push("No valid structural stop-loss available.");
  const risk = stopLoss ? input.price - stopLoss : 0;
  const tp1 = stopLoss ? input.price + risk * (input.tp1R ?? DEFAULTS.tp1R) : null;
  const tp2 = stopLoss ? input.price + risk * (input.tp2R ?? DEFAULTS.tp2R) : null;
  const ready = blockers.length === 0 && trigger !== null && positive(input.price);
  const state: EntryState = ready ? "ENTRY_READY" : input.h4Trend === "bear" ? "INVALIDATED" : "WATCH";
  if (state === "ENTRY_READY") reasons.push("All Spot entry gates confirmed.");
  return { ...base, state, trigger, entryMin: state === "ENTRY_READY" ? input.price * 0.998 : null, entryMax: state === "ENTRY_READY" ? input.price * 1.002 : null, stopLoss, takeProfit1: tp1, takeProfit2: tp2, riskRewardToTp1: stopLoss ? input.tp1R ?? DEFAULTS.tp1R : null, riskRewardToTp2: stopLoss ? input.tp2R ?? DEFAULTS.tp2R : null, breakoutConfirmed, volumeConfirmed, retestConfirmed };
}

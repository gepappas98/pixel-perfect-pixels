export type WhaleShockAssetTier = "mid_cap" | "altcoin";
export interface WhaleShockCandidate {
  symbol: string;
  assetTier: WhaleShockAssetTier;
  requiredFloorUsd: number;
  totalUsd: number;
  buyUsd: number;
  sellUsd: number;
  buyRatio: number;
  alertCount: number;
  sources: string[];
  windowMinutes: number;
}
export type RegimeLabel = "strong_bull" | "bull" | "sideways" | "bear" | "strong_bear";
export interface RegimeTransitionCheck {
  initialRegime: RegimeLabel; currentRegime: RegimeLabel; isInitialBearish: boolean;
  isViolentPositiveShift: boolean; scoreShift: number; reason: string; passed: boolean;
}
export interface Technical1hCheck {
  symbol: string; signal: string | null; rsi: number | null; macd: number | null;
  macdSignal: number | null; passed: boolean; reason: string;
}
export interface WhaleShockConfig {
  windowMinutes: number; minAlerts: number; minBuyRatio: number; cooldownMinutes: number;
  paperPositionUsd: number; takeProfitPct: number; stopLossPct: number;
  tierFloors: Record<string, number>; defaultFloorUsd: number;
  requireInitialBearish: boolean; minViolentPositiveShift: number; require1hTechnicalBullish: boolean;
}
export const DEFAULT_WHALE_SHOCK_CONFIG: WhaleShockConfig = {
  windowMinutes: 30, minAlerts: 3, minBuyRatio: 0.75, cooldownMinutes: 10,
  paperPositionUsd: 1000, takeProfitPct: 0.06, stopLossPct: 0.03,
  // Majors (BTC/ETH/SOL) are excluded: their whale flow is routine liquidity,
  // not a shock. Only mid-caps and dynamically discovered altcoins qualify.
  tierFloors: { INJ: 50000, AVAX: 50000, LINK: 50000, SUI: 50000, NEAR: 50000 },
  defaultFloorUsd: 35000, requireInitialBearish: true, minViolentPositiveShift: 0.25,
  require1hTechnicalBullish: true,
};
// Symbols that can never trigger a Whale Shock entry.
export const WHALE_SHOCK_EXCLUDED_MAJORS = new Set(["BTC", "ETH", "SOL"]);
const REGIME_NUMERIC: Record<RegimeLabel, number> = { strong_bull: 1, bull: 0.5, sideways: 0, bear: -0.5, strong_bear: -1 };
export function parseRegime(label?: string | null): RegimeLabel {
  const norm = String(label ?? "").toLowerCase().replace(/[ -]+/g, "_");
  if (norm.includes("strong_bull")) return "strong_bull";
  if (norm.includes("strong_bear")) return "strong_bear";
  if (norm.includes("bull")) return "bull";
  if (norm.includes("bear")) return "bear";
  return "sideways";
}
export function evaluateRegimeShockTransition(
  historicalRegimes: Array<{ regime_label?: string | null; score?: number | null; created_at: string }>,
  config: WhaleShockConfig = DEFAULT_WHALE_SHOCK_CONFIG,
): RegimeTransitionCheck {
  if (!historicalRegimes?.length) return {
    initialRegime: "sideways", currentRegime: "sideways", isInitialBearish: false,
    isViolentPositiveShift: false, scoreShift: 0, reason: "No regime history available", passed: false,
  };
  const sorted = [...historicalRegimes].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const initial = sorted[0], current = sorted[sorted.length - 1];
  const initialLabel = parseRegime(initial.regime_label), currentLabel = parseRegime(current.regime_label);
  const isInitialBearish = initialLabel === "bear" || initialLabel === "strong_bear";
  const initialScore = initial.score != null ? Number(initial.score) : REGIME_NUMERIC[initialLabel];
  const currentScore = current.score != null ? Number(current.score) : REGIME_NUMERIC[currentLabel];
  const scoreShift = currentScore - initialScore;
  const movedOutOfBear = isInitialBearish && ["sideways", "bull", "strong_bull"].includes(currentLabel);
  const isViolentPositiveShift = scoreShift >= config.minViolentPositiveShift || movedOutOfBear;
  let passed = true, reason = "Violent bullish reversal from bearish baseline confirmed";
  if (config.requireInitialBearish && !isInitialBearish) {
    passed = false; reason = `Initial regime was ${initialLabel}, required bear or strong_bear`;
  } else if (!isViolentPositiveShift) {
    passed = false;
    reason = `No violent positive shift detected (initial: ${initialLabel}, current: ${currentLabel}, delta: ${scoreShift >= 0 ? "+" : ""}${scoreShift.toFixed(2)})`;
  }
  return { initialRegime: initialLabel, currentRegime: currentLabel, isInitialBearish, isViolentPositiveShift, scoreShift, reason, passed };
}
export function evaluate1hTechnicalConfirmation(
  snapshot1h?: { symbol: string; signal?: string | null; rsi?: number | null; macd?: number | null; macd_signal?: number | null } | null,
  config: WhaleShockConfig = DEFAULT_WHALE_SHOCK_CONFIG,
): Technical1hCheck {
  if (!config.require1hTechnicalBullish) return {
    symbol: snapshot1h?.symbol ?? "UNKNOWN", signal: snapshot1h?.signal ?? null,
    rsi: snapshot1h?.rsi ?? null, macd: snapshot1h?.macd ?? null,
    macdSignal: snapshot1h?.macd_signal ?? null, passed: true, reason: "1h technical check disabled in config",
  };
  if (!snapshot1h) return {
    symbol: "UNKNOWN", signal: null, rsi: null, macd: null, macdSignal: null,
    passed: false, reason: "Missing 1h indicator snapshot",
  };
  const sig = String(snapshot1h.signal ?? "").toLowerCase();
  const rsi = snapshot1h.rsi != null ? Number(snapshot1h.rsi) : null;
  const macd = snapshot1h.macd != null ? Number(snapshot1h.macd) : null;
  const macdSignal = snapshot1h.macd_signal != null ? Number(snapshot1h.macd_signal) : null;
  const isExplicitBullish = sig === "bullish";
  const isMomentumTurn = rsi != null && rsi >= 42 && macd != null && macdSignal != null && macd >= macdSignal;
  const passed = isExplicitBullish || isMomentumTurn;
  const reason = passed
    ? `1h technical bullish confirmed (${isExplicitBullish ? "bullish signal" : `RSI ${rsi?.toFixed(1)} + MACD above signal`})`
    : `1h not bullish (signal=${sig || "none"}, rsi=${rsi?.toFixed(1) ?? "n/a"})`;
  return { symbol: snapshot1h.symbol, signal: snapshot1h.signal ?? null, rsi, macd, macdSignal, passed, reason };
}
export function getRequiredVolumeFloor(symbol: string, config: WhaleShockConfig): number {
  const clean = symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  return config.tierFloors[clean] ?? config.defaultFloorUsd;
}
export function getAssetTier(symbol: string, config: WhaleShockConfig): WhaleShockAssetTier {
  const clean = symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  return config.tierFloors[clean] != null ? "mid_cap" : "altcoin";
}
export function aggregateWhaleShocks(
  alerts: Array<{ symbol: string; direction: string; usd_value: number; source?: string }>,
  config: WhaleShockConfig = DEFAULT_WHALE_SHOCK_CONFIG,
): WhaleShockCandidate[] {
  const groups = new Map<string, { totalUsd: number; buyUsd: number; sellUsd: number; count: number; sources: Set<string> }>();
  for (const alert of alerts) {
    const symbol = alert.symbol?.replace(/[^A-Z0-9]/gi, "").toUpperCase(), value = Number(alert.usd_value);
    if (!symbol || !Number.isFinite(value) || value <= 0) continue;
    // Majors are excluded — their whale flow is routine liquidity, not a shock.
    if (WHALE_SHOCK_EXCLUDED_MAJORS.has(symbol)) continue;
    const direction = alert.direction?.toLowerCase();
    if (direction !== "accumulation" && direction !== "distribution") continue;
    const current = groups.get(symbol) ?? { totalUsd: 0, buyUsd: 0, sellUsd: 0, count: 0, sources: new Set<string>() };
    current.totalUsd += value; current.count += 1;
    if (direction === "accumulation") current.buyUsd += value; else current.sellUsd += value;
    if (alert.source) current.sources.add(alert.source);
    groups.set(symbol, current);
  }
  const qualifying: WhaleShockCandidate[] = [];
  for (const [symbol, stats] of groups) {
    const buyRatio = stats.totalUsd > 0 ? stats.buyUsd / stats.totalUsd : 0;
    const requiredFloorUsd = getRequiredVolumeFloor(symbol, config);
    if (stats.buyUsd >= requiredFloorUsd && buyRatio >= config.minBuyRatio && stats.count >= config.minAlerts) {
      qualifying.push({ symbol, assetTier: getAssetTier(symbol, config), requiredFloorUsd,
        totalUsd: stats.totalUsd, buyUsd: stats.buyUsd, sellUsd: stats.sellUsd, buyRatio,
        alertCount: stats.count, sources: [...stats.sources], windowMinutes: config.windowMinutes });
    }
  }
  return qualifying;
}

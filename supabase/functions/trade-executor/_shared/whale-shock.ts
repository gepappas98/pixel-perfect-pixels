export interface WhaleShockCandidate {
  symbol: string;
  totalUsd: number;
  buyUsd: number;
  sellUsd: number;
  buyRatio: number;
  alertCount: number;
  sources: string[];
  windowMinutes: number;
}

export interface WhaleShockConfig {
  windowMinutes: number;
  minAlerts: number;
  minBuyRatio: number;
  cooldownMinutes: number;
  paperPositionUsd: number;
  takeProfitPct: number;
  stopLossPct: number;
  tierFloors: Record<string, number>;
  defaultFloorUsd: number;
}

export const DEFAULT_WHALE_SHOCK_CONFIG: WhaleShockConfig = {
  windowMinutes: 30,
  minAlerts: 3,
  minBuyRatio: 0.75,
  cooldownMinutes: 10,
  paperPositionUsd: 1000,
  takeProfitPct: 0.06,
  stopLossPct: 0.03,
  tierFloors: {
    BTC: 200000,
    ETH: 200000,
    SOL: 75000,
    INJ: 50000,
    AVAX: 50000,
    LINK: 50000,
    SUI: 50000,
    NEAR: 50000,
  },
  // Tier 3 follows the proposal's prose: $35k for other altcoins.
  defaultFloorUsd: 35000,
};

export function getRequiredVolumeFloor(symbol: string, config: WhaleShockConfig): number {
  const clean = symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  return config.tierFloors[clean] ?? config.defaultFloorUsd;
}

export function aggregateWhaleShocks(
  alerts: Array<{ symbol: string; direction: string; usd_value: number; source?: string }>,
  config: WhaleShockConfig = DEFAULT_WHALE_SHOCK_CONFIG,
): WhaleShockCandidate[] {
  const groups = new Map<string, {
    totalUsd: number;
    buyUsd: number;
    sellUsd: number;
    count: number;
    sources: Set<string>;
  }>();

  for (const alert of alerts) {
    const symbol = alert.symbol?.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const value = Number(alert.usd_value);
    if (!symbol || !Number.isFinite(value) || value <= 0) continue;

    const direction = alert.direction?.toLowerCase();
    if (direction !== "accumulation" && direction !== "distribution") continue;

    const current = groups.get(symbol) ?? {
      totalUsd: 0,
      buyUsd: 0,
      sellUsd: 0,
      count: 0,
      sources: new Set<string>(),
    };
    current.totalUsd += value;
    current.count += 1;
    if (direction === "accumulation") current.buyUsd += value;
    else current.sellUsd += value;
    if (alert.source) current.sources.add(alert.source);
    groups.set(symbol, current);
  }

  const qualifying: WhaleShockCandidate[] = [];
  for (const [symbol, stats] of groups) {
    const buyRatio = stats.totalUsd > 0 ? stats.buyUsd / stats.totalUsd : 0;
    if (
      stats.buyUsd >= getRequiredVolumeFloor(symbol, config) &&
      buyRatio >= config.minBuyRatio &&
      stats.count >= config.minAlerts
    ) {
      qualifying.push({
        symbol,
        totalUsd: stats.totalUsd,
        buyUsd: stats.buyUsd,
        sellUsd: stats.sellUsd,
        buyRatio,
        alertCount: stats.count,
        sources: [...stats.sources],
        windowMinutes: config.windowMinutes,
      });
    }
  }
  return qualifying;
}

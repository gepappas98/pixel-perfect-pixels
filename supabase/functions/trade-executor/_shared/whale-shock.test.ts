import { describe, expect, it } from "vitest";
import {
  aggregateWhaleShocks,
  DEFAULT_WHALE_SHOCK_CONFIG,
  getRequiredVolumeFloor,
} from "./whale-shock.ts";

describe("Whale Shock aggregation", () => {
  it("uses the configured tier floors", () => {
    expect(getRequiredVolumeFloor("BTC", DEFAULT_WHALE_SHOCK_CONFIG)).toBe(200_000);
    expect(getRequiredVolumeFloor("INJ", DEFAULT_WHALE_SHOCK_CONFIG)).toBe(50_000);
    expect(getRequiredVolumeFloor("SOL", DEFAULT_WHALE_SHOCK_CONFIG)).toBe(75_000);
    expect(getRequiredVolumeFloor("ONDO", DEFAULT_WHALE_SHOCK_CONFIG)).toBe(35_000);
  });

  it("qualifies a 3-alert accumulation cluster above the floor and 75% buy ratio", () => {
    const candidates = aggregateWhaleShocks([
      { symbol: "INJ", direction: "accumulation", usd_value: 20_000, source: "feed-a" },
      { symbol: "INJ", direction: "accumulation", usd_value: 20_000, source: "feed-a" },
      { symbol: "INJ", direction: "accumulation", usd_value: 15_000, source: "feed-b" },
      { symbol: "INJ", direction: "distribution", usd_value: 15_000, source: "feed-a" },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      symbol: "INJ",
      buyUsd: 55_000,
      sellUsd: 15_000,
      alertCount: 4,
      sources: ["feed-a", "feed-b"],
    });
    expect(candidates[0].buyRatio).toBeCloseTo(55 / 70);
  });

  it("rejects insufficient buy ratio, volume, and alert count", () => {
    expect(aggregateWhaleShocks([
      { symbol: "INJ", direction: "accumulation", usd_value: 60_000 },
      { symbol: "INJ", direction: "distribution", usd_value: 30_000 },
      { symbol: "INJ", direction: "accumulation", usd_value: 1_000 },
    ])).toHaveLength(0);
    expect(aggregateWhaleShocks([
      { symbol: "INJ", direction: "accumulation", usd_value: 20_000 },
      { symbol: "INJ", direction: "accumulation", usd_value: 20_000 },
    ])).toHaveLength(0);
  });

  it("does not count unknown directions or invalid values toward the cluster", () => {
    expect(aggregateWhaleShocks([
      { symbol: "INJ", direction: "accumulation", usd_value: 25_000 },
      { symbol: "INJ", direction: "accumulation", usd_value: 25_000 },
      { symbol: "INJ", direction: "unknown", usd_value: 500_000 },
      { symbol: "INJ", direction: "distribution", usd_value: -10 },
    ])).toHaveLength(0);
  });
});

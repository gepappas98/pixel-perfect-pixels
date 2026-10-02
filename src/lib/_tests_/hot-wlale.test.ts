import { describe, it, expect } from "vitest";
import {
  computeAggregate,
  qualifiesForConvictionBoost,
  convictionBoostMagnitude,
  HOT_THRESHOLD_USD,
  HOT_TTL_MINUTES,
  HOT_WINDOW_MINUTES,
  HOT_MAX_SYMBOLS,
  HOT_CONVICTION_MIN_USD,
  HOT_CONVICTION_MIN_CONFIDENCE,
} from "../hot-whale.server";

/* ────────────────────── constants sanity ────────────────────── */

describe("hot-whale constants", () => {
  it("thresholds are internally consistent", () => {
    expect(HOT_THRESHOLD_USD).toBe(25_000);
    expect(HOT_TTL_MINUTES).toBeGreaterThan(HOT_WINDOW_MINUTES);
    expect(HOT_MAX_SYMBOLS).toBeGreaterThan(0);
    expect(HOT_CONVICTION_MIN_USD).toBeGreaterThan(HOT_THRESHOLD_USD);
    expect(HOT_CONVICTION_MIN_CONFIDENCE).toBeGreaterThan(0.5);
    expect(HOT_CONVICTION_MIN_CONFIDENCE).toBeLessThanOrEqual(1);
  });
});

/* ────────────────────── computeAggregate ────────────────────── */

describe("computeAggregate — input validation", () => {
  it("returns null for empty symbol", () => {
    expect(
      computeAggregate({
        symbol: "",
        total_usd: 100_000,
        buy_usd: 80_000,
        sell_usd: 20_000,
        alert_count: 5,
        last_seen_at: "2026-10-02T13:00:00Z",
      }),
    ).toBeNull();
  });

  it("returns null when total_usd ≤ 0", () => {
    expect(
      computeAggregate({
        symbol: "PUMP",
        total_usd: 0,
        buy_usd: 0,
        sell_usd: 0,
        alert_count: 5,
        last_seen_at: "2026-10-02T13:00:00Z",
      }),
    ).toBeNull();
  });

  it("handles string-number coercion from Postgres numeric columns", () => {
    const agg = computeAggregate({
      symbol: "PUMP",
      total_usd: "100000",
      buy_usd: "80000",
      sell_usd: "20000",
      alert_count: "5",
      last_seen_at: "2026-10-02T13:00:00Z",
    });
    expect(agg).not.toBeNull();
    expect(agg!.total_usd).toBe(100_000);
    expect(agg!.buy_ratio).toBeCloseTo(0.8, 5);
    expect(agg!.alert_count).toBe(5);
  });
});

describe("computeAggregate — direction gates", () => {
  const base = {
    symbol: "PUMP",
    total_usd: 100_000,
    last_seen_at: "2026-10-02T13:00:00Z",
  };

  it("accumulation: buy_ratio 0.80, samples 5", () => {
    const agg = computeAggregate({
      ...base,
      buy_usd: 80_000,
      sell_usd: 20_000,
      alert_count: 5,
    })!;
    expect(agg.direction).toBe("accumulation");
    expect(agg.buy_ratio).toBeCloseTo(0.8, 5);
    expect(agg.confidence).toBeGreaterThan(0);
  });

  it("distribution: buy_ratio 0.20, samples 5", () => {
    const agg = computeAggregate({
      ...base,
      buy_usd: 20_000,
      sell_usd: 80_000,
      alert_count: 5,
    })!;
    expect(agg.direction).toBe("distribution");
    expect(agg.buy_ratio).toBeCloseTo(0.2, 5);
  });

  it("null direction: buy_ratio 0.50 (mixed)", () => {
    const agg = computeAggregate({
      ...base,
      buy_usd: 50_000,
      sell_usd: 50_000,
      alert_count: 10,
    })!;
    expect(agg.direction).toBeNull();
    expect(agg.confidence).toBe(0);
  });

  it("null direction: buy_ratio 0.60 (below accumulation threshold)", () => {
    const agg = computeAggregate({
      ...base,
      buy_usd: 60_000,
      sell_usd: 40_000,
      alert_count: 10,
    })!;
    expect(agg.direction).toBeNull();
  });

  it("accumulation at exactly 0.65", () => {
    const agg = computeAggregate({
      ...base,
      buy_usd: 65_000,
      sell_usd: 35_000,
      alert_count: 5,
    })!;
    expect(agg.direction).toBe("accumulation");
  });

  it("distribution at exactly 0.35", () => {
    const agg = computeAggregate({
      ...base,
      buy_usd: 35_000,
      sell_usd: 65_000,
      alert_count: 5,
    })!;
    expect(agg.direction).toBe("distribution");
  });

  it("null direction: samples < 3 (even at 0.90 buy_ratio)", () => {
    const agg = computeAggregate({
      ...base,
      buy_usd: 90_000,
      sell_usd: 10_000,
      alert_count: 2,
    })!;
    expect(agg.direction).toBeNull();
    expect(agg.confidence).toBe(0);
  });

  it("accumulation at exactly 3 samples", () => {
    const agg = computeAggregate({
      ...base,
      buy_usd: 90_000,
      sell_usd: 10_000,
      alert_count: 3,
    })!;
    expect(agg.direction).toBe("accumulation");
  });
});

describe("computeAggregate — confidence scaling", () => {
  const base = {
    symbol: "PUMP",
    total_usd: 100_000,
    last_seen_at: "2026-10-02T13:00:00Z",
  };

  it("confidence scales with directional clarity (10+ samples)", () => {
    const weak = computeAggregate({
      ...base,
      buy_usd: 66_000,
      sell_usd: 34_000,
      alert_count: 10,
    })!;
    const strong = computeAggregate({
      ...base,
      buy_usd: 95_000,
      sell_usd: 5_000,
      alert_count: 10,
    })!;
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
  });

  it("confidence scales with sample size (same ratio)", () => {
    const few = computeAggregate({
      ...base,
      buy_usd: 80_000,
      sell_usd: 20_000,
      alert_count: 3,
    })!;
    const many = computeAggregate({
      ...base,
      buy_usd: 800_000,
      sell_usd: 200_000,
      alert_count: 30,
    })!;
    expect(many.confidence).toBeGreaterThan(few.confidence);
  });

  it("confidence is bounded to [0, 1]", () => {
    const max = computeAggregate({
      ...base,
      total_usd: 1_000_000,
      buy_usd: 1_000_000,
      sell_usd: 0,
      alert_count: 100,
    })!;
    expect(max.confidence).toBeLessThanOrEqual(1);
    expect(max.confidence).toBeGreaterThanOrEqual(0);
  });
});

/* ────────────────────── conviction gates ────────────────────── */

describe("qualifiesForConvictionBoost", () => {
  function agg(overrides: {
    total_usd?: number;
    buy_ratio?: number;
    alert_count?: number;
    confidence?: number;
    direction?: "accumulation" | "distribution" | null;
  }) {
    return {
      symbol: "X",
      total_usd: overrides.total_usd ?? 100_000,
      buy_usd: 0,
      sell_usd: 0,
      alert_count: overrides.alert_count ?? 10,
      direction: overrides.direction ?? "accumulation",
      buy_ratio: overrides.buy_ratio ?? 0.8,
      confidence: overrides.confidence ?? 0.8,
      last_seen_at: "2026-10-02T13:00:00Z",
    };
  }

  it("returns false for null", () => {
    expect(qualifiesForConvictionBoost(null)).toBe(false);
  });

  it("returns false when direction is null", () => {
    expect(qualifiesForConvictionBoost(agg({ direction: null }))).toBe(false);
  });

  it("returns false when usd < HOT_CONVICTION_MIN_USD", () => {
    expect(
      qualifiesForConvictionBoost(agg({ total_usd: 40_000 })),
    ).toBe(false);
  });

  it("returns false when confidence < HOT_CONVICTION_MIN_CONFIDENCE", () => {
    expect(
      qualifiesForConvictionBoost(agg({ confidence: 0.6 })),
    ).toBe(false);
  });

  it("returns true when all conditions met", () => {
    expect(
      qualifiesForConvictionBoost(
        agg({ total_usd: 60_000, confidence: 0.75, direction: "accumulation" }),
      ),
    ).toBe(true);
  });

  it("works for distribution direction", () => {
    expect(
      qualifiesForConvictionBoost(
        agg({ total_usd: 60_000, confidence: 0.75, direction: "distribution" }),
      ),
    ).toBe(true);
  });
});

describe("convictionBoostMagnitude", () => {
  function agg(confidence: number, direction: "accumulation" | "distribution" | null = "accumulation") {
    return {
      symbol: "X",
      total_usd: 100_000,
      buy_usd: 0,
      sell_usd: 0,
      alert_count: 10,
      direction,
      buy_ratio: 0.8,
      confidence,
      last_seen_at: "2026-10-02T13:00:00Z",
    };
  }

  it("returns 0 when not qualifying", () => {
    expect(convictionBoostMagnitude(agg(0.5))).toBe(0);
    expect(convictionBoostMagnitude(null)).toBe(0);
  });

  it("returns 0 at exact threshold (confidence 0.70)", () => {
    expect(convictionBoostMagnitude(agg(0.70))).toBeCloseTo(0, 5);
  });

  it("scales linearly: 0.85 → 0.15", () => {
    expect(convictionBoostMagnitude(agg(0.85))).toBeCloseTo(0.15, 5);
  });

  it("caps at 0.30 for confidence 1.0", () => {
    expect(convictionBoostMagnitude(agg(1.0))).toBeCloseTo(0.30, 5);
  });

  it("does not exceed 0.30 even if confidence > 1 (defensive)", () => {
    expect(convictionBoostMagnitude(agg(1.5))).toBe(0.30);
  });
});

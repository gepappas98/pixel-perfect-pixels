import { describe, it, expect, vi } from "vitest";

// ─── Mocks για να μην αγγίξει το test file κανένα server module ───
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {},
}));

vi.mock("../cleanup-config.server", () => ({
  fetchCleanupConfig: vi.fn().mockResolvedValue({
    watch_conflict_fix: { enabled: false, shadow_mode: false },
    mtf_confirmation_gate: { enabled: false, shadow_mode: true, min_timeframes: 2 },
    vwap_regime_gate: { enabled: false, shadow_mode: false, atr_pct_threshold: 3 },
    market_session_fix: { enabled: false },
  }),
}));

vi.mock("../trading-settings.server", () => ({
  fetchTradingSettings: vi.fn().mockResolvedValue({
    real_sl_pct: 0.03,
    real_tp_pct: 0.04,
    max_hold_hours: 72,
    stale_exit_hours: 48,
    stale_exit_min_pnl_pct: 1,
    variant_tp_pct: 0.04,
    variant_sl_pct: 0.03,
    variant_max_hours: 72,
  }),
}));

import {
  evaluateMultiTimeframe,
  ruleBased,
  type MultiTfInput,
  type MultiTfResult,
} from "../pipeline.server";
import type { StrategyConfig } from "../strategy.presets";
import type { MtfGateConfig } from "../mtf-gate";

/* ─────────────────────────── Test fixtures ─────────────────────────── */

const BALANCED: StrategyConfig = {
  whale_weight: 1,
  technicals_weight: 1,
  prediction_weight: 1,
  council_weight: 1,
  preset_name: "balanced",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const WHALE_FOCUSED: StrategyConfig = {
  whale_weight: 2,
  technicals_weight: 0.5,
  prediction_weight: 0.5,
  council_weight: 0.5,
  preset_name: "whale-focused",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const CHART_TRADER: StrategyConfig = {
  whale_weight: 0.5,
  technicals_weight: 2,
  prediction_weight: 0.5,
  council_weight: 0.5,
  preset_name: "chart-trader",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const WHALE_ONLY: StrategyConfig = {
  whale_weight: 1.5,
  technicals_weight: 0,
  prediction_weight: 0,
  council_weight: 0,
  preset_name: null,
  updated_at: "2026-01-01T00:00:00.000Z",
};



function mtf(overrides: Partial<MultiTfResult> = {}): MultiTfResult {
  return {
    direction: "neutral",
    score: 0,
    aligned: false,
    conflict: false,
    detail: "test",
    bullCount: 0,
    bearCount: 0,
    neuCount: 3,
    ...overrides,
  };
}

const mtfBullishAligned = mtf({
  direction: "bullish",
  score: 1.69,
  aligned: true,
  bullCount: 3,
  neuCount: 0,
  detail: "4h bull · 1h bull · 1d bull",
});

const mtfBearishAligned = mtf({
  direction: "bearish",
  score: -1.69,
  aligned: true,
  bearCount: 3,
  neuCount: 0,
  detail: "4h bear · 1h bear · 1d bear",
});

const mtfBullishWeak = mtf({
  direction: "bullish",
  score: 1.0,
  aligned: false,
  bullCount: 1,
  neuCount: 2,
  detail: "4h bull · 1h neu · 1d neu",
});

/* ─────────────────────── evaluateMultiTimeframe ─────────────────────── */

describe("evaluateMultiTimeframe", () => {
  it("returns neutral when primary is neutral regardless of fast/trend", () => {
    const input: MultiTfInput = {
      primary: { signal: "neutral", price: 100, rsi: 50, raw: { vwap: 100 } },
      fast: { signal: "bullish", price: 100, rsi: 60, raw: { vwap: 90 } },
      trend: { signal: "bullish", price: 100, rsi: 60, raw: { vwap: 90 } },
    };
    const result = evaluateMultiTimeframe(input);
    expect(result.direction).toBe("neutral");
    expect(result.score).toBe(0);
    expect(result.aligned).toBe(false);
    expect(result.conflict).toBe(false);
  });

  it("3/3 bullish alignment → score 1.69, aligned=true, conflict=false", () => {
    const input: MultiTfInput = {
      primary: { signal: "bullish", price: 100, rsi: 55, raw: { vwap: 90 } },
      fast: { signal: "bullish", price: 100, rsi: 55, raw: { vwap: 90 } },
      trend: { signal: "bullish", price: 100, rsi: 55, raw: { vwap: 90 } },
    };
    const result = evaluateMultiTimeframe(input);
    expect(result.direction).toBe("bullish");
    expect(result.score).toBeCloseTo(1.69, 5);
    expect(result.aligned).toBe(true);
    expect(result.conflict).toBe(false);
    expect(result.bullCount).toBe(3);
  });

  it("3/3 bearish alignment → score -1.69, aligned=true, conflict=false", () => {
    const input: MultiTfInput = {
      primary: { signal: "bearish", price: 100, rsi: 45, raw: { vwap: 110 } },
      fast: { signal: "bearish", price: 100, rsi: 45, raw: { vwap: 110 } },
      trend: { signal: "bearish", price: 100, rsi: 45, raw: { vwap: 110 } },
    };
    const result = evaluateMultiTimeframe(input);
    expect(result.direction).toBe("bearish");
    expect(result.score).toBeCloseTo(-1.69, 5);
    expect(result.aligned).toBe(true);
    expect(result.conflict).toBe(false);
  });

  it("primary bull + fast bear + trend neutral → score 0.7, conflict=false", () => {
    const input: MultiTfInput = {
      primary: { signal: "bullish", price: 100, rsi: 55, raw: { vwap: 90 } },
      fast: { signal: "bearish", price: 100, rsi: 50, raw: { vwap: 100 } },
      trend: { signal: "neutral", price: 100, rsi: 50, raw: { vwap: 100 } },
    };
    const result = evaluateMultiTimeframe(input);
    expect(result.direction).toBe("bullish");
    expect(result.score).toBeCloseTo(0.7, 5);
    expect(result.aligned).toBe(false);
    expect(result.conflict).toBe(false);
  });

  it("primary bull + fast bull + trend bear → score 0.91, conflict=true", () => {
    const input: MultiTfInput = {
      primary: { signal: "bullish", price: 100, rsi: 55, raw: { vwap: 90 } },
      fast: { signal: "bullish", price: 100, rsi: 55, raw: { vwap: 90 } },
      trend: { signal: "bearish", price: 100, rsi: 45, raw: { vwap: 110 } },
    };
    const result = evaluateMultiTimeframe(input);
    expect(result.direction).toBe("bullish");
    // 1.0 * 1.3 (fast agrees) * 0.7 (trend opposes) = 0.91
    expect(result.score).toBeCloseTo(0.91, 5);
    expect(result.aligned).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it("VWAP override: fast neutral upgraded to bullish when rsi≥60 and price>vwap", () => {
    const input: MultiTfInput = {
      primary: { signal: "bullish", price: 100, rsi: 55, raw: { vwap: 90 } },
      fast: { signal: "neutral", price: 105, rsi: 65, raw: { vwap: 100 } },
      trend: { signal: "bullish", price: 100, rsi: 55, raw: { vwap: 90 } },
    };
    const result = evaluateMultiTimeframe(input);
    expect(result.aligned).toBe(true);
    expect(result.score).toBeCloseTo(1.69, 5);
  });

  it("VWAP override: fast neutral downgraded to bearish when rsi≤40 and price<vwap", () => {
    const input: MultiTfInput = {
      primary: { signal: "bearish", price: 100, rsi: 45, raw: { vwap: 110 } },
      fast: { signal: "neutral", price: 95, rsi: 35, raw: { vwap: 100 } },
      trend: { signal: "bearish", price: 100, rsi: 45, raw: { vwap: 110 } },
    };
    const result = evaluateMultiTimeframe(input);
    expect(result.aligned).toBe(true);
    expect(result.score).toBeCloseTo(-1.69, 5);
  });
});

/* ───────────────────────────── ruleBased ───────────────────────────── */

describe("ruleBased — prediction-free scoring", () => {
  const balanced: StrategyConfig = {
    whale_weight: 1,
    technicals_weight: 1,
    council_weight: 1,
    preset_name: "balanced",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("holds when all inputs are neutral or missing", () => {
    const result = ruleBased(null, mtf(), null, balanced);
    expect(result.recommendation).toBe("hold");
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it("uses whale flow without a prediction-market input", () => {
    const result = ruleBased({ direction: "accumulation" }, mtf(), null, balanced);
    expect(result.score).toBeCloseTo(1, 5);
    expect(result.recommendation).toBe("watch");
  });

  it("combines whale flow, aligned technicals, and council conviction", () => {
    const result = ruleBased(
      { direction: "accumulation" },
      mtfBullishAligned,
      { final_verdict: "BUY", conviction: 100 },
      balanced,
    );
    expect(result.score).toBeCloseTo(3.44, 5);
    expect(result.confidence).toBeCloseTo(1, 5);
    expect(result.recommendation).toBe("buy");
  });

  it("retains strategy weight sensitivity using only remaining sources", () => {
    const whaleFocused: StrategyConfig = {
      whale_weight: 2,
      technicals_weight: 0.5,
      council_weight: 0.5,
      preset_name: "whale-focused",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const result = ruleBased({ direction: "accumulation" }, mtf(), null, whaleFocused);
    expect(result.score).toBeCloseTo(2, 5);
    expect(result.recommendation).toBe("buy");
    expect(result.confidence).toBeCloseTo(2 / 2.97, 5);
  });

  it("keeps MTF-only chart-trader scoring intact", () => {
    const chartTrader: StrategyConfig = {
      whale_weight: 0.5,
      technicals_weight: 2,
      council_weight: 0.5,
      preset_name: "chart-trader",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const result = ruleBased(null, mtfBullishAligned, null, chartTrader);
    expect(result.score).toBeCloseTo(3.38, 5);
    expect(result.recommendation).toBe("buy");
    expect(result.confidence).toBeCloseTo(3.38 / 4.255, 5);
  });
});

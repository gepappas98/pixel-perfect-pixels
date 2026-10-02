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
  predictionDirection,
  predictionMagnitude,
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

const TINY_PREDICTION: StrategyConfig = {
  whale_weight: 0,
  technicals_weight: 0,
  prediction_weight: 0.1,
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

/* ──────────────────────── predictionDirection ──────────────────────── */

describe("predictionDirection", () => {
  it("returns neutral for null prediction", () => {
    expect(predictionDirection(null)).toBe("neutral");
  });

  it("returns neutral when yes_price is missing", () => {
    expect(predictionDirection({ question: "will BTC reach 100k" })).toBe("neutral");
  });

  it("returns neutral when question has no directional keywords", () => {
    expect(
      predictionDirection({ question: "will btc do something", yes_price: 0.9 }),
    ).toBe("neutral");
  });

  it("bullish question + high yes → bullish", () => {
    expect(
      predictionDirection({ question: "will bitcoin reach 100k", yes_price: 0.7 }),
    ).toBe("bullish");
  });

  it("bullish question + low yes → bearish", () => {
    expect(
      predictionDirection({ question: "will bitcoin reach 100k", yes_price: 0.3 }),
    ).toBe("bearish");
  });

  it("bearish question + high yes → bearish", () => {
    expect(
      predictionDirection({ question: "will bitcoin dip below 50k", yes_price: 0.7 }),
    ).toBe("bearish");
  });

  it("bearish question + low yes → bullish", () => {
    expect(
      predictionDirection({ question: "will bitcoin dip below 50k", yes_price: 0.3 }),
    ).toBe("bullish");
  });

  it("ambiguous yes (0.5) → neutral", () => {
    expect(
      predictionDirection({ question: "will bitcoin reach 100k", yes_price: 0.5 }),
    ).toBe("neutral");
  });
});

/* ──────────────────────── predictionMagnitude ──────────────────────── */

describe("predictionMagnitude", () => {
  it("returns 0 for null prediction", () => {
    expect(predictionMagnitude(null)).toBe(0);
  });

  it("returns 0 when yes_price is missing", () => {
    expect(predictionMagnitude({ question: "will BTC reach 100k" })).toBe(0);
  });

  it("returns 0 when question has no directional keywords", () => {
    expect(
      predictionMagnitude({ question: "will btc do something", yes_price: 0.9 }),
    ).toBe(0);
  });

  it("returns 0 for 50% yes (dead center)", () => {
    expect(
      predictionMagnitude({ question: "will bitcoin reach 100k", yes_price: 0.5 }),
    ).toBe(0);
  });

  it("returns 0 for 55% yes (still inside neutral band)", () => {
    expect(
      predictionMagnitude({ question: "will bitcoin reach 100k", yes_price: 0.55 }),
    ).toBe(0);
  });

  it("returns 0 for 60% yes (boundary of neutral band)", () => {
    expect(
      predictionMagnitude({ question: "will bitcoin reach 100k", yes_price: 0.6 }),
    ).toBe(0);
  });

  it("scales linearly: 70% yes → 0.25", () => {
    expect(
      predictionMagnitude({ question: "will bitcoin reach 100k", yes_price: 0.7 }),
    ).toBeCloseTo(0.25, 5);
  });

  it("scales linearly: 80% yes → 0.5", () => {
    expect(
      predictionMagnitude({ question: "will bitcoin reach 100k", yes_price: 0.8 }),
    ).toBeCloseTo(0.5, 5);
  });

  it("scales linearly: 90% yes → 0.75", () => {
    expect(
      predictionMagnitude({ question: "will bitcoin reach 100k", yes_price: 0.9 }),
    ).toBeCloseTo(0.75, 5);
  });

  it("caps at 1.0: 100% yes → 1.0", () => {
    expect(
      predictionMagnitude({ question: "will bitcoin reach 100k", yes_price: 1.0 }),
    ).toBe(1.0);
  });

  it("bearish question inverts: 80% yes → mag 0.5 (bearish direction)", () => {
    // bearish question, yes=0.8 → up = 1 - 0.8 = 0.2 → distance = 0.6 → mag 0.5
    expect(
      predictionMagnitude({ question: "will bitcoin dip below 50k", yes_price: 0.8 }),
    ).toBeCloseTo(0.5, 5);
  });

  it("bearish question extreme: 0% yes → mag 1.0", () => {
    // up = 1 - 0 = 1.0 → distance = 1.0 → mag 1.0
    expect(
      predictionMagnitude({ question: "will bitcoin dip below 50k", yes_price: 0.0 }),
    ).toBe(1.0);
  });
});

/* ───────────────────────────── ruleBased ───────────────────────────── */

describe("ruleBased — empty / neutral inputs", () => {
  it("all null signals → hold, score 0, confidence 0", () => {
    const result = ruleBased(null, mtf(), null, null, BALANCED);
    expect(result.recommendation).toBe("hold");
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain("insufficient signal");
  });

  it("whale accumulation alone with balanced weights → watch (score 1.0)", () => {
    const result = ruleBased(
      { direction: "accumulation" },
      mtf(),
      null,
      null,
      BALANCED,
    );
    expect(result.score).toBeCloseTo(1.0, 5);
    expect(result.recommendation).toBe("watch");
  });
});

describe("ruleBased — full bullish / bearish alignment", () => {
  // FIX 1: magnitude-aware prediction contribution
  //   yes_price = 0.8 → mag = 0.5 → contribution = 0.5 × 0.5 = 0.25
  //   score = 1 + 1.69 + 0.25 + 0.75 = 3.69
  //   max   = 1 + 1.69 + 0.5  + 0.75 = 3.94
  it("all-bullish balanced (yes=0.8) → buy with ~0.936 confidence", () => {
    const result = ruleBased(
      { direction: "accumulation" },
      mtfBullishAligned,
      { question: "will bitcoin reach 100k", yes_price: 0.8 },
      { final_verdict: "BUY", conviction: 100 },
      BALANCED,
    );
    expect(result.score).toBeCloseTo(3.69, 5);
    expect(result.confidence).toBeCloseTo(3.69 / 3.94, 4);
    expect(result.recommendation).toBe("buy");
  });

  it("all-bullish balanced (yes=1.0, mag=1.0) → buy with confidence 1.0", () => {
    const result = ruleBased(
      { direction: "accumulation" },
      mtfBullishAligned,
      { question: "will bitcoin reach 100k", yes_price: 1.0 },
      { final_verdict: "BUY", conviction: 100 },
      BALANCED,
    );
    // mag = 1.0 → prediction contribution = 0.5
    // score = 1 + 1.69 + 0.5 + 0.75 = 3.94 = max → confidence 1.0
    expect(result.score).toBeCloseTo(3.94, 5);
    expect(result.confidence).toBeCloseTo(1, 5);
    expect(result.recommendation).toBe("buy");
  });

  // FIX 2: same reasoning for bearish
  it("all-bearish balanced (yes=0.2) → sell with ~0.936 confidence", () => {
    const result = ruleBased(
      { direction: "distribution" },
      mtfBearishAligned,
      { question: "will bitcoin reach 100k", yes_price: 0.2 },
      { final_verdict: "SELL", conviction: 100 },
      BALANCED,
    );
    // mag = 0.5 → contribution = 0.25
    // score = -1 - 1.69 - 0.25 - 0.75 = -3.69
    expect(result.score).toBeCloseTo(-3.69, 5);
    expect(result.confidence).toBeCloseTo(3.69 / 3.94, 4);
    expect(result.recommendation).toBe("sell");
  });

  it("all-bearish balanced (yes=0.0, mag=1.0) → sell with confidence 1.0", () => {
    const result = ruleBased(
      { direction: "distribution" },
      mtfBearishAligned,
      { question: "will bitcoin reach 100k", yes_price: 0.0 },
      { final_verdict: "SELL", conviction: 100 },
      BALANCED,
    );
    expect(result.score).toBeCloseTo(-3.94, 5);
    expect(result.confidence).toBeCloseTo(1, 5);
    expect(result.recommendation).toBe("sell");
  });
});

describe("ruleBased — weight sensitivity", () => {
  it("whale-focused preset: whale accumulation alone is enough for buy", () => {
    // score = 2.0 ; max = 2 + 0.5*1.69 + 0.5*0.5 + 0.5*0.75 = 3.47
    const result = ruleBased(
      { direction: "accumulation" },
      mtf(),
      null,
      null,
      WHALE_FOCUSED,
    );
    expect(result.score).toBeCloseTo(2.0, 5);
    expect(result.recommendation).toBe("buy");
    expect(result.confidence).toBeCloseTo(2.0 / 3.47, 5);
  });

  it("chart-trader preset: aligned MTF alone is enough for buy", () => {
    // score = 1.69 * 2 = 3.38 ; max = 0.5 + 3.38 + 0.25 + 0.375 = 4.505
    const result = ruleBased(null, mtfBullishAligned, null, null, CHART_TRADER);
    expect(result.score).toBeCloseTo(3.38, 5);
    expect(result.recommendation).toBe("buy");
    expect(result.confidence).toBeCloseTo(3.38 / 4.505, 5);
  });

  it("exact 1.5 threshold → buy", () => {
    const result = ruleBased(
      { direction: "accumulation" },
      mtf(),
      null,
      null,
      WHALE_ONLY,
    );
    expect(result.score).toBeCloseTo(1.5, 5);
    expect(result.recommendation).toBe("buy");
    expect(result.confidence).toBeCloseTo(1, 5);
  });

  it("exact -1.5 threshold → sell", () => {
    const result = ruleBased(
      { direction: "distribution" },
      mtf(),
      null,
      null,
      WHALE_ONLY,
    );
    expect(result.score).toBeCloseTo(-1.5, 5);
    expect(result.recommendation).toBe("sell");
  });
});

describe("ruleBased — recommendation bands", () => {
  it("score in (-1.5, -0.5] with valid band → watch", () => {
    // whale accumulation (+1.0) + mtf bearish (-1.69) = -0.69 → watch band
    const result = ruleBased(
      { direction: "accumulation" },
      mtfBearishAligned,
      null,
      null,
      BALANCED,
    );
    expect(result.score).toBeCloseTo(-0.69, 5);
    expect(result.recommendation).toBe("watch");
  });

  it("score < 0.5 (abs) → hold", () => {
    // yes=0.9 → mag = 0.75 → 0.5 * 0.1 * 0.75 = 0.0375, still < 0.5
    const result = ruleBased(
      null,
      mtf(),
      { question: "will bitcoin reach 100k", yes_price: 0.9 },
      null,
      TINY_PREDICTION,
    );
    expect(Math.abs(result.score)).toBeLessThan(0.5);
    expect(result.recommendation).toBe("hold");
  });

  it("reasoning contains magnitude tag for prediction", () => {
    const result = ruleBased(
      null,
      mtf(),
      { question: "will bitcoin reach 100k", yes_price: 0.8 },
      null,
      BALANCED,
    );
    // With yes=0.8 → mag = 0.5 → tag shows (mag 50%)
    expect(result.reasoning).toMatch(/prediction market bullish.*mag 50%/);
  });

  it("no magnitude tag when prediction is in neutral band", () => {
    // yes=0.55 → mag = 0 → no contribution, no reasoning line added
    const result = ruleBased(
      null,
      mtf(),
      { question: "will bitcoin reach 100k", yes_price: 0.55 },
      null,
      BALANCED,
    );
    // predictionDirection returns neutral → no reasoning line at all
    expect(result.reasoning).not.toContain("prediction market");
  });
});

describe("ruleBased — AI AVOID handling", () => {
  // FIX 3: magnitude-aware score
  it("AVOID with conviction ≥ 60 downgrades strong buy to watch", () => {
    const result = ruleBased(
      { direction: "accumulation" },
      mtfBullishAligned,
      { question: "will bitcoin reach 100k", yes_price: 0.8 },
      { final_verdict: "AVOID", conviction: 80 },
      BALANCED,
    );
    // prediction contribution = 0.5 × 1.0 × 0.5 = 0.25
    // score = 1 + 1.69 + 0.25 + 0 (AVOID adds nothing) = 2.94
    expect(result.score).toBeCloseTo(2.94, 5);
    expect(result.recommendation).toBe("watch");
    expect(result.reasoning).toContain("AVOID");
  });

  it("AVOID with conviction < 60 does NOT downgrade", () => {
    const result = ruleBased(
      { direction: "accumulation" },
      mtfBullishAligned,
      { question: "will bitcoin reach 100k", yes_price: 0.8 },
      { final_verdict: "AVOID", conviction: 40 },
      BALANCED,
    );
    // score = 1 + 1.69 + 0.25 = 2.94, still >= 1.5 → buy
    expect(result.recommendation).toBe("buy");
  });
});

describe("ruleBased — MTF gate integration", () => {
  it("buy rejected by MTF gate when enabled → hold with reason", () => {
    const mtfGateConfig: MtfGateConfig = {
      enabled: true,
      shadow_mode: false,
      min_timeframes: 2,
    };
    const result = ruleBased(
      { direction: "accumulation" },
      mtfBullishWeak,
      null,
      null,
      WHALE_FOCUSED,
      { mtfGateConfig },
    );
    expect(result.recommendation).toBe("hold");
    expect(result.reasoning).toContain("MTF gate REJECTED");
    expect(result.mtfGateDecision?.passed).toBe(false);
  });

  it("MTF gate in shadow mode does NOT block recommendation", () => {
    const mtfGateConfig: MtfGateConfig = {
      enabled: false,
      shadow_mode: true,
      min_timeframes: 2,
    };
    const result = ruleBased(
      { direction: "accumulation" },
      mtfBullishWeak,
      null,
      null,
      WHALE_FOCUSED,
      { mtfGateConfig },
    );
    expect(result.recommendation).toBe("buy");
    expect(result.reasoning).toContain("MTF gate SHADOW");
  });

  it("buy passes MTF gate with 3/3 aligned timeframes", () => {
    const mtfGateConfig: MtfGateConfig = {
      enabled: true,
      shadow_mode: false,
      min_timeframes: 2,
    };
    const result = ruleBased(
      { direction: "accumulation" },
      mtfBullishAligned,
      null,
      null,
      WHALE_FOCUSED,
      { mtfGateConfig },
    );
    expect(result.recommendation).toBe("buy");
    expect(result.mtfGateDecision?.passed).toBe(true);
  });

  it("sell rejected by MTF gate when enabled", () => {
    const weakBear = mtf({
      direction: "bearish",
      score: -1.0,
      aligned: false,
      bullCount: 0,
      bearCount: 1,
      neuCount: 2,
    });
    const mtfGateConfig: MtfGateConfig = {
      enabled: true,
      shadow_mode: false,
      min_timeframes: 2,
    };
    const result = ruleBased(
      { direction: "distribution" },
      weakBear,
      null,
      null,
      WHALE_FOCUSED,
      { mtfGateConfig },
    );
    expect(result.recommendation).toBe("hold");
    expect(result.reasoning).toContain("MTF gate REJECTED");
  });
});

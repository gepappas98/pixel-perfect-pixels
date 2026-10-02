import { describe, it, expect } from "vitest";
import {
  checkMtfGate,
  countMtfSignals,
  DEFAULT_MTF_GATE_CONFIG,
  type MtfGateConfig,
} from "../mtf-gate";

const ENABLED: MtfGateConfig = {
  enabled: true,
  shadow_mode: false,
  min_timeframes: 2,
};

/* ───────────────────────── checkMtfGate ───────────────────────── */

describe("checkMtfGate — buy direction", () => {
  it("3/3 bullish → passed, no reject reason", () => {
    const result = checkMtfGate(
      "buy",
      { bullCount: 3, bearCount: 0, neuCount: 0 },
      ENABLED,
    );
    expect(result.passed).toBe(true);
    expect(result.rejectReason).toBeNull();
    expect(result.confirmingCount).toBe(3);
    expect(result.opposingCount).toBe(0);
    expect(result.neutralCount).toBe(0);
  });

  it("2/3 bullish → passed (meets min_timeframes=2)", () => {
    const result = checkMtfGate(
      "buy",
      { bullCount: 2, bearCount: 0, neuCount: 1 },
      ENABLED,
    );
    expect(result.passed).toBe(true);
    expect(result.confirmingCount).toBe(2);
  });

  it("1/3 bullish → rejected with reason", () => {
    const result = checkMtfGate(
      "buy",
      { bullCount: 1, bearCount: 0, neuCount: 2 },
      ENABLED,
    );
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("only 1/3");
    expect(result.rejectReason).toContain("buy");
    expect(result.confirmingCount).toBe(1);
    expect(result.neutralCount).toBe(2);
  });

  it("0/3 bullish → rejected", () => {
    const result = checkMtfGate(
      "buy",
      { bullCount: 0, bearCount: 3, neuCount: 0 },
      ENABLED,
    );
    expect(result.passed).toBe(false);
    expect(result.opposingCount).toBe(3);
  });

  it("mixed 1 bull / 1 bear / 1 neutral → rejected", () => {
    const result = checkMtfGate(
      "buy",
      { bullCount: 1, bearCount: 1, neuCount: 1 },
      ENABLED,
    );
    expect(result.passed).toBe(false);
  });
});

describe("checkMtfGate — sell direction", () => {
  it("3/3 bearish → passed", () => {
    const result = checkMtfGate(
      "sell",
      { bullCount: 0, bearCount: 3, neuCount: 0 },
      ENABLED,
    );
    expect(result.passed).toBe(true);
    expect(result.confirmingCount).toBe(3);
    expect(result.opposingCount).toBe(0);
  });

  it("2/3 bearish → passed", () => {
    const result = checkMtfGate(
      "sell",
      { bullCount: 0, bearCount: 2, neuCount: 1 },
      ENABLED,
    );
    expect(result.passed).toBe(true);
  });

  it("1/3 bearish → rejected", () => {
    const result = checkMtfGate(
      "sell",
      { bullCount: 2, bearCount: 1, neuCount: 0 },
      ENABLED,
    );
    expect(result.passed).toBe(false);
    expect(result.opposingCount).toBe(2);
  });
});

describe("checkMtfGate — min_timeframes variations", () => {
  it("min_timeframes=1 → 1/3 passes", () => {
    const result = checkMtfGate(
      "buy",
      { bullCount: 1, bearCount: 0, neuCount: 2 },
      { enabled: true, shadow_mode: false, min_timeframes: 1 },
    );
    expect(result.passed).toBe(true);
  });

  it("min_timeframes=3 → 2/3 fails", () => {
    const result = checkMtfGate(
      "buy",
      { bullCount: 2, bearCount: 0, neuCount: 1 },
      { enabled: true, shadow_mode: false, min_timeframes: 3 },
    );
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("only 2/4");
  });
});

/* ───────────────────────── countMtfSignals ───────────────────────── */

describe("countMtfSignals", () => {
  it("all bullish → bullCount 3", () => {
    const counts = countMtfSignals("bullish", "bullish", "bullish");
    expect(counts).toEqual({ bullCount: 3, bearCount: 0, neuCount: 0 });
  });

  it("all bearish → bearCount 3", () => {
    const counts = countMtfSignals("bearish", "bearish", "bearish");
    expect(counts).toEqual({ bullCount: 0, bearCount: 3, neuCount: 0 });
  });

  it("all neutral → neuCount 3", () => {
    const counts = countMtfSignals("neutral", "neutral", "neutral");
    expect(counts).toEqual({ bullCount: 0, bearCount: 0, neuCount: 3 });
  });

  it("mixed 1/1/1", () => {
    const counts = countMtfSignals("bullish", "bearish", "neutral");
    expect(counts).toEqual({ bullCount: 1, bearCount: 1, neuCount: 1 });
  });

  it("2 bullish, 1 bearish", () => {
    const counts = countMtfSignals("bullish", "bullish", "bearish");
    expect(counts).toEqual({ bullCount: 2, bearCount: 1, neuCount: 0 });
  });

  it("end-to-end with checkMtfGate: 2 bull + 1 neu → buy passes", () => {
    const counts = countMtfSignals("bullish", "bullish", "neutral");
    const decision = checkMtfGate("buy", counts, ENABLED);
    expect(decision.passed).toBe(true);
  });

  it("end-to-end with checkMtfGate: 1 bull + 2 neu → buy rejects", () => {
    const counts = countMtfSignals("bullish", "neutral", "neutral");
    const decision = checkMtfGate("buy", counts, ENABLED);
    expect(decision.passed).toBe(false);
  });
});

/* ──────────────────────── DEFAULT_MTF_GATE_CONFIG ──────────────────────── */

describe("DEFAULT_MTF_GATE_CONFIG", () => {
  it("has expected safe defaults (disabled + shadow)", () => {
    expect(DEFAULT_MTF_GATE_CONFIG.enabled).toBe(false);
    expect(DEFAULT_MTF_GATE_CONFIG.shadow_mode).toBe(true);
    expect(DEFAULT_MTF_GATE_CONFIG.min_timeframes).toBe(2);
  });
});

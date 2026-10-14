import { describe, expect, it } from "vitest";
import { evaluateMicroTimeframeGate } from "./micro-trend-gate.ts";

describe("evaluateMicroTimeframeGate", () => {
  it("rejects a micro downtrend when bears outnumber bulls", () => {
    const result = evaluateMicroTimeframeGate({
      symbol: "BTC", tf5m: "bearish", tf15m: "bearish", tf1h: "neutral",
    });
    expect(result.allowBuy).toBe(false);
    expect(result.isMicroDowntrend).toBe(true);
  });

  it("allows a confirmed bounce when at least two timeframes are bullish and none bearish", () => {
    const result = evaluateMicroTimeframeGate({
      symbol: "BTC", tf5m: "bullish", tf15m: "bullish", tf1h: "neutral",
    });
    expect(result.allowBuy).toBe(true);
    expect(result.isConfirmedBounce).toBe(true);
  });

  it("blocks a single bearish timeframe when no timeframe is bullish", () => {
    const result = evaluateMicroTimeframeGate({
      symbol: "BTC", tf5m: "bearish", tf15m: "neutral", tf1h: "neutral",
    });
    expect(result.allowBuy).toBe(false);
  });

  it("allows balanced neutral observations without labeling them a bounce", () => {
    const result = evaluateMicroTimeframeGate({
      symbol: "BTC", tf5m: "neutral", tf15m: "neutral", tf1h: "neutral",
    });
    expect(result.allowBuy).toBe(true);
    expect(result.isConfirmedBounce).toBe(false);
  });
});

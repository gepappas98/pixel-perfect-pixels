import { describe, expect, it } from "vitest";
import {
  COUNCIL_NEUTRAL_BAND,
  getDirectionalSign,
  TECH_NEUTRAL_BAND,
  WHALE_NEUTRAL_BAND,
} from "./market-regime.functions";

describe("market regime neutral deadbands", () => {
  it("treats whale flow at or within ±5% as neutral", () => {
    expect(getDirectionalSign(0.049, WHALE_NEUTRAL_BAND)).toBe(0);
    expect(getDirectionalSign(0.05, WHALE_NEUTRAL_BAND)).toBe(0);
    expect(getDirectionalSign(-0.05, WHALE_NEUTRAL_BAND)).toBe(0);
    expect(getDirectionalSign(0.051, WHALE_NEUTRAL_BAND)).toBe(1);
    expect(getDirectionalSign(-0.051, WHALE_NEUTRAL_BAND)).toBe(-1);
  });

  it("uses ±10% neutral bands for technical breadth and council consensus", () => {
    expect(TECH_NEUTRAL_BAND).toBe(0.10);
    expect(COUNCIL_NEUTRAL_BAND).toBe(0.10);
    expect(getDirectionalSign(0.10, TECH_NEUTRAL_BAND)).toBe(0);
    expect(getDirectionalSign(-0.101, COUNCIL_NEUTRAL_BAND)).toBe(-1);
  });

  it("does not turn non-finite values into directional votes", () => {
    expect(getDirectionalSign(Number.NaN, WHALE_NEUTRAL_BAND)).toBe(0);
    expect(getDirectionalSign(Number.POSITIVE_INFINITY, WHALE_NEUTRAL_BAND)).toBe(0);
  });
});

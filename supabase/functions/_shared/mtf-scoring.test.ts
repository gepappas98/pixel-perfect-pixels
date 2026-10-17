import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateWeightedMtfScore } from "./mtf-scoring.ts";

Deno.test("aligned bullish frames score +1", () => {
  assertEquals(calculateWeightedMtfScore([
    { signal: "bullish", available: true, weight: 1 },
    { signal: "bullish", available: true, weight: 0.65 },
    { signal: "bullish", available: true, weight: 0.65 },
  ]), 1);
});

Deno.test("aligned bearish frames score -1", () => {
  assertEquals(calculateWeightedMtfScore([
    { signal: "bearish", available: true, weight: 1 },
    { signal: "bearish", available: true, weight: 0.65 },
    { signal: "bearish", available: true, weight: 0.65 },
  ]), -1);
});

Deno.test("opposing 1h and 1d partially offset bullish 4h", () => {
  assertEquals(
    calculateWeightedMtfScore([
      { signal: "bullish", available: true, weight: 1 },
      { signal: "bearish", available: true, weight: 0.65 },
      { signal: "bearish", available: true, weight: 0.65 },
    ]),
    -0.3 / 2.3,
  );
});

Deno.test("missing timeframes are excluded from denominator", () => {
  assertEquals(calculateWeightedMtfScore([
    { signal: "bullish", available: true, weight: 1 },
    { signal: "bearish", available: false, weight: 0.65 },
    { signal: "neutral", available: false, weight: 0.65 },
  ]), 1);
});

Deno.test("neutral available frame dilutes directional score", () => {
  assertEquals(calculateWeightedMtfScore([
    { signal: "bullish", available: true, weight: 1 },
    { signal: "neutral", available: true, weight: 0.65 },
  ]), 1 / 1.65);
});

Deno.test("no available frames score zero", () => {
  assertEquals(calculateWeightedMtfScore([
    { signal: "bullish", available: false, weight: 1 },
    { signal: "bearish", available: false, weight: 0.65 },
    { signal: "neutral", available: false, weight: 0.65 },
  ]), 0);
});

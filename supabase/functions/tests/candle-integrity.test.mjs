import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(here, path), "utf8");

// Contract mirrored by the collector and both downstream DB queries:
// close_time must be strictly before evaluation; the row must already have
// been captured by evaluation. Equality is deliberately rejected.
function usableAt(closeTime, capturedAt, evaluationAt) {
  return Number.isFinite(Date.parse(closeTime))
    && Number.isFinite(Date.parse(capturedAt))
    && Date.parse(closeTime) < Date.parse(evaluationAt)
    && Date.parse(capturedAt) <= Date.parse(evaluationAt);
}

test("rejects a candle whose close_time equals the evaluation timestamp", () => {
  const t = "2026-10-20T12:00:00.000Z";
  assert.equal(usableAt(t, "2026-10-20T11:59:59.000Z", t), false);
});

test("accepts a fully closed candle captured before evaluation", () => {
  assert.equal(usableAt("2026-10-20T11:59:59.999Z", "2026-10-20T12:00:00.000Z", "2026-10-20T12:00:01.000Z"), true);
});

test("accepts delayed collection only when the candle is closed and capture preceded evaluation", () => {
  assert.equal(usableAt("2026-10-20T11:55:00.000Z", "2026-10-20T12:00:00.000Z", "2026-10-20T12:00:01.000Z"), true);
  assert.equal(usableAt("2026-10-20T11:55:00.000Z", "2026-10-20T12:00:02.000Z", "2026-10-20T12:00:01.000Z"), false);
});

test("rejects candles still open at evaluation time", () => {
  assert.equal(usableAt("2026-10-20T12:00:01.000Z", "2026-10-20T12:00:00.000Z", "2026-10-20T12:00:00.000Z"), false);
});

test("production collector filters unfinished candles before upsert", () => {
  const source = read("../market-candle-collector/index.ts");
  assert.match(source, /Date\.parse\(c\.close_time\)\s*<\s*evaluationMs/);
  assert.match(source, /captured_at:capturedAtIso/);
});

test("both early-entry evaluators enforce strict close and capture-time bounds", () => {
  const variants = read("../early-entry-variants/index.ts");
  const regime = read("../early-entry-regime/index.ts");
  assert.match(variants, /\.lt\("close_time",\s*evaluationAt\)\.lte\("captured_at",\s*evaluationAt\)/);
  assert.match(regime, /\.lt\("close_time",\s*candleEvaluationAt\)\.lte\("captured_at",\s*candleEvaluationAt\)/);
  assert.match(variants, /Date\.parse\(String\(c\.close_time\)\)\s*<\s*now\.getTime\(\)/);
  assert.match(regime, /Date\.parse\(String\(row\.close_time\)\)\s*<\s*now\.getTime\(\)/);
});

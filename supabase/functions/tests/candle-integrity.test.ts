function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
const collectorSource = await Deno.readTextFile(new URL("../market-candle-collector/index.ts", import.meta.url));
const variantsSource = await Deno.readTextFile(new URL("../early-entry-variants/index.ts", import.meta.url));
const regimeSource = await Deno.readTextFile(new URL("../early-entry-regime/index.ts", import.meta.url));

function usableAt(closeTime: string, capturedAt: string, evaluationAt: string): boolean {
  return Number.isFinite(Date.parse(closeTime))
    && Number.isFinite(Date.parse(capturedAt))
    && Date.parse(closeTime) < Date.parse(evaluationAt)
    && Date.parse(capturedAt) <= Date.parse(evaluationAt);
}

Deno.test("rejects close_time equal to evaluation timestamp", () => {
  const t = "2026-10-20T12:00:00.000Z";
  assert(!usableAt(t, "2026-10-20T11:59:59.000Z", t), "equal close/evaluation must be rejected");
});

Deno.test("accepts a fully closed candle captured before evaluation", () => {
  assert(usableAt("2026-10-20T11:59:59.999Z", "2026-10-20T12:00:00.000Z", "2026-10-20T12:00:01.000Z"), "closed candle should be accepted");
});

Deno.test("handles delayed collection without look-ahead", () => {
  assert(usableAt("2026-10-20T11:55:00.000Z", "2026-10-20T12:00:00.000Z", "2026-10-20T12:00:01.000Z"), "late capture before evaluation is usable");
  assert(!usableAt("2026-10-20T11:55:00.000Z", "2026-10-20T12:00:02.000Z", "2026-10-20T12:00:01.000Z"), "capture after evaluation must be rejected");
});

Deno.test("rejects unfinished candles", () => {
  assert(!usableAt("2026-10-20T12:00:01.000Z", "2026-10-20T12:00:00.000Z", "2026-10-20T12:00:00.000Z"), "future close must be rejected");
});

Deno.test("collector filters unfinished candles before upsert", () => {
  assert(/Date\.parse\(c\.close_time\)\s*<\s*evaluationMs/.test(collectorSource), "collector must strictly reject close_time >= capture");
  assert(collectorSource.includes("captured_at:capturedAtIso"), "capture timestamp must be the filter evaluation time");
});

Deno.test("both early-entry evaluators enforce strict close and capture-time bounds", () => {
  assert(/\.lt\("close_time",\s*evaluationAt\)\.lte\("captured_at",\s*evaluationAt\)/.test(variantsSource), "variants SQL time bounds missing");
  assert(/\.lt\("close_time",\s*candleEvaluationAt\)\.lte\("captured_at",\s*candleEvaluationAt\)/.test(regimeSource), "regime SQL time bounds missing");
  assert(/Date\.parse\(String\(c\.close_time\)\)\s*<\s*now\.getTime\(\)/.test(variantsSource), "variants in-memory guard missing");
  assert(/Date\.parse\(String\(row\.close_time\)\)\s*<\s*now\.getTime\(\)/.test(regimeSource), "regime in-memory guard missing");
});

Deno.test("early-entry evaluators persist compact normalized candle lineage", () => {
  assert(variantsSource.includes('from("early_entry_candle_lineage")'), "variants must persist lineage outside metrics JSON");
  assert(regimeSource.includes('from("early_entry_candle_lineage")'), "baseline must persist lineage outside gate diagnostics");
  assert(variantsSource.includes("candle_evaluation_id:candleEvaluationId"), "variant decisions must link to their lineage evaluation");
  assert(regimeSource.includes("candle_evaluation_id: candleEvaluationId"), "baseline diagnostics must link to their lineage evaluation");
  assert(variantsSource.includes('open_time:c.open_time') && regimeSource.includes('open_time:c.open_time'), "lineage must include candle open_time");
  assert(variantsSource.includes('source:String(c.source ?? "unknown")') && regimeSource.includes('source:String(c.source ?? "unknown")'), "lineage must include source identity");
  assert(variantsSource.includes('candle_lineage_write_status') && regimeSource.includes('candle_lineage_write_status'), "lineage write failures must be observable without changing strategy gates");
});

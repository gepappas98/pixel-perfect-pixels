import { summarizeEligibleSignalAudit } from "../_shared/execution-audit.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("counts gate skips as audited when the stable signal ID is present", () => {
  const signals = [
    { id: "s1", confidence: 0.91 },
    { id: "s2", confidence: 0.82 },
    { id: "s3", confidence: 0.76 },
  ];
  // Gate events intentionally omit confidence in the production event shape.
  const events = [
    { signal_id: "s1", stage: "PER_SYMBOL_CAP" },
    { signal_id: "s2", stage: "MICRO_TF_GATE" },
    { signal_id: "s3", stage: "MARKET_REGIME_GATE" },
  ];
  const summary = summarizeEligibleSignalAudit(signals, events, 0.6);
  assert(summary.eligible_buy_signals === 3, "all three signals meet the confidence threshold");
  assert(summary.audited_eligible_signals === 3, "all three stable signal IDs have audit events");
  assert(summary.uncovered_eligible_signals === 0, "there should be no uncovered eligible signal");
});

Deno.test("reports only the signal with no audit event as uncovered", () => {
  const signals = [
    { id: "s1", confidence: 0.91 },
    { id: "s2", confidence: 0.82 },
    { id: "s3", confidence: 0.76 },
  ];
  const events = [{ signal_id: "s1" }, { signal_id: "s3" }];
  const summary = summarizeEligibleSignalAudit(signals, events, 0.6);
  assert(summary.audited_eligible_signals === 2, "two unique eligible signal IDs were audited");
  assert(summary.uncovered_eligible_signals === 1, "one eligible signal has no audit event");
});

Deno.test("excludes below-threshold signals and de-duplicates repeated audit events", () => {
  const signals = [
    { id: "s1", confidence: 0.91 },
    { id: "s2", confidence: 0.59 },
  ];
  const events = [
    { signal_id: "s1" },
    { signal_id: "s1" },
    { signal_id: "s2" },
  ];
  const summary = summarizeEligibleSignalAudit(signals, events, 0.6);
  assert(summary.eligible_buy_signals === 1, "only the signal above the threshold is eligible");
  assert(summary.audited_eligible_signals === 1, "duplicate events cannot inflate the audited count");
  assert(summary.uncovered_eligible_signals === 0, "eligible signal is covered");
});

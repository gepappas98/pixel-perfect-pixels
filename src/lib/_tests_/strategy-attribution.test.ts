import { describe, expect, it } from "vitest";
import { computeFeeAwarePnl } from "@/lib/fees";
import { strategyOf, summarizeStrategies, tallyShadowDecisions, type AttributionTrade } from "@/lib/strategy-attribution";

const t = (o: Partial<AttributionTrade>): AttributionTrade => ({
  status: "closed", mode: "paper", net_pnl: 0, pnl: null, entry_source: null, entry_metadata: null, ...o,
});

describe("strategy attribution", () => {
  it("maps B/C/whale_shock entry sources", () => {
    expect(strategyOf(t({ entry_source: "early_entry_b_reversal" }))).toBe("early_b");
    expect(strategyOf(t({ entry_source: "early_entry_c_adaptive" }))).toBe("early_c");
    expect(strategyOf(t({ entry_source: "whale_shock", entry_metadata: { strategy: "whale-shock-reversal-v2" } }))).toBe("whale_shock");
    expect(strategyOf(t({ entry_source: "early_entry_regime" }))).toBe("early");
  });

  it("reports no entries instead of zero outcome when nothing opened", () => {
    const r = summarizeStrategies([t({ entry_source: "cmc_paper", net_pnl: 5 })]);
    const b = r.find((x) => x.key === "early_b")!;
    expect(b.state).toBe("no_entries");
    expect(b.closed).toBe(0);
  });

  it("open-only trades contribute no PnL", () => {
    const r = summarizeStrategies([t({ entry_source: "whale_shock", status: "open", net_pnl: 99 })]);
    const w = r.find((x) => x.key === "whale_shock")!;
    expect(w.state).toBe("open_only");
    expect(w.pnl).toBe(0);
  });

  it("ignores live trades", () => {
    const r = summarizeStrategies([t({ mode: "live", entry_source: "whale_shock", net_pnl: 10 })]);
    expect(r.find((x) => x.key === "whale_shock")!.closed).toBe(0);
  });

  it("sums realized net PnL after 0.05%/side fees", () => {
    // $1000 BUY, +6% target: gross 60, fees 0.5 + 0.53 = 1.03 → net 58.97
    const p = computeFeeAwarePnl("buy", 10, 10.6, 100);
    expect(p.netPnl).toBeCloseTo(58.97, 2);
    const r = summarizeStrategies([
      t({ entry_source: "whale_shock", net_pnl: p.netPnl }),
      t({ entry_source: "whale_shock", net_pnl: -31.485 }),
    ]);
    const w = r.find((x) => x.key === "whale_shock")!;
    expect(w.pnl).toBeCloseTo(27.485, 3);
    expect(w.wins).toBe(1);
  });

  it("shadow decisions are tallied separately and never become trades", () => {
    const tally = tallyShadowDecisions([
      { variant: "B_EARLY_REVERSAL", decision: "NO_ENTRY", trade_id: null },
      { variant: "B_EARLY_REVERSAL", decision: "PAPER_OPEN", trade_id: "x" },
      { variant: "B_EARLY_REVERSAL", decision: "PAPER_OPEN", trade_id: null },
    ]);
    expect(tally[0]).toEqual({ variant: "B_EARLY_REVERSAL", paperOpenLinked: 1, noEntry: 1, eligibleNoAsset: 0 });
  });
});

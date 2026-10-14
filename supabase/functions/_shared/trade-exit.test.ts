import { describe, expect, it } from "vitest";
import {
  BREAKEVEN_BUFFER_FEE_PCT,
  BREAKEVEN_TRIGGER_GAIN_PCT,
  decideExit,
  getBreakevenStopLossUpdate,
  type OpenTradeRow,
} from "./trade-exit";

const baseTrade: OpenTradeRow = {
  id: "trade-1",
  symbol: "ETH",
  side: "buy",
  mode: "paper",
  quantity: 10,
  entry_price: 100,
  stop_loss: 97,
  take_profit: 106,
  created_at: "2026-10-14T10:00:00.000Z",
};

describe("paper breakeven stop", () => {
  it("raises the persisted stop to entry plus the fee buffer once +3% is observed", () => {
    const price = 100 * (1 + BREAKEVEN_TRIGGER_GAIN_PCT / 100);
    expect(getBreakevenStopLossUpdate(baseTrade, price)).toBeCloseTo(
      100 * (1 + BREAKEVEN_BUFFER_FEE_PCT / 100),
      8,
    );
  });

  it("does not activate below the trigger", () => {
    expect(getBreakevenStopLossUpdate(baseTrade, 102.99)).toBeNull();
  });

  it("never changes live or non-BUY positions", () => {
    expect(getBreakevenStopLossUpdate({ ...baseTrade, mode: "live" }, 104)).toBeNull();
    expect(getBreakevenStopLossUpdate({ ...baseTrade, side: "sell" }, 104)).toBeNull();
  });

  it("never lowers an already tighter stop", () => {
    expect(getBreakevenStopLossUpdate({ ...baseTrade, stop_loss: 100.5 }, 104)).toBeNull();
  });

  it("closes a paper BUY at the persisted breakeven stop with a stop-loss reason", () => {
    const stop = 100 * (1 + BREAKEVEN_BUFFER_FEE_PCT / 100);
    const decision = decideExit(
      { ...baseTrade, stop_loss: stop },
      stop - 0.01,
      { max_hold_hours: 72, stale_exit_hours: 48, stale_exit_min_pnl_pct: 1 },
      Date.parse("2026-10-14T11:00:00.000Z"),
    );
    expect(decision.action).toBe("close");
    if (decision.action === "close") {
      expect(decision.reason).toBe("stop_loss");
      expect(decision.net_pnl).toBeGreaterThan(0);
    }
  });
});

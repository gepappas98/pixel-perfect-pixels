import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXIT_SETTINGS, binancePair, decideExit, normalizeExitSettings, type OpenTradeRow,
} from "../../../supabase/functions/_shared/trade-exit";

const now = Date.parse("2026-10-11T15:00:00Z");
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
const base: OpenTradeRow = {
  id: "t1", symbol: "LINK", side: "buy", mode: "paper", quantity: 10, entry_price: 100,
  stop_loss: 97, take_profit: 106, created_at: hoursAgo(95.6),
};
const s = normalizeExitSettings({ max_hold_hours: 72 });

describe("trade exit decision", () => {
  it("closes a 95.6h paper BUY as expired with fee-aware PnL", () => {
    const d = decideExit(base, 102, s, now);
    expect(d.action).toBe("close");
    if (d.action !== "close") return;
    expect(d.reason).toBe("expired");
    expect(d.gross_pnl).toBeCloseTo(20);
    expect(d.total_fees).toBeCloseTo(100 * 10 * 0.0005 + 102 * 10 * 0.0005);
    expect(d.net_pnl).toBeCloseTo(20 - d.total_fees);
  });
  it("holds a young trade inside SL/TP", () => {
    expect(decideExit({ ...base, created_at: hoursAgo(5) }, 102, s, now).action).toBe("hold");
  });
  it("never closes legacy SELL rows", () => {
    expect(decideExit({ ...base, side: "sell", created_at: hoursAgo(126.1) }, 90, s, now).action).toBe("skip_legacy_sell");
  });
  it("never marks a live trade closed without exchange SELL", () => {
    expect(decideExit({ ...base, mode: "live" }, 102, s, now).action).toBe("skip_live_requires_exchange");
  });
  it("skips invalid prices", () => {
    expect(decideExit(base, undefined, s, now).action).toBe("skip_no_price");
    expect(decideExit(base, 0, s, now).action).toBe("skip_no_price");
  });
  it("keeps 72h default and maps aliases", () => {
    expect(normalizeExitSettings(null)).toEqual(DEFAULT_EXIT_SETTINGS);
    expect(binancePair("MATIC")).toBe("POLUSDT");
    expect(binancePair("ZECUSDT")).toBe("ZECUSDT");
  });
});

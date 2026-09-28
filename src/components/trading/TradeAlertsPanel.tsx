"use client";

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatPrice } from "@/lib/format-price";
import type { ClosedTrade } from "@/lib/trading-types";

function formatFullDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function computePnlPct(t: ClosedTrade): number | null {
  if (t.pnl == null) return null;
  const notional = Number(t.entry_price) * Number(t.quantity);
  if (!Number.isFinite(notional) || notional <= 0) return null;
  return (Number(t.pnl) / notional) * 100;
}

function reasonLabel(reason: string | null): string {
  switch (reason) {
    case "take_profit": return "target hit";
    case "stop_loss": return "stop hit";
    case "stale_exit": return "stale exit";
    case "expired": return "expired";
    case "rotated_out": return "rotated out";
    default: return reason ?? "—";
  }
}

function reasonTone(reason: string | null): string {
  switch (reason) {
    case "take_profit": return "text-bull";
    case "stop_loss": return "text-bear";
    case "rotated_out": return "text-warn";
    case "stale_exit":
    case "expired": return "text-muted-foreground";
    default: return "text-muted-foreground";
  }
}

export function TradeAlertsPanel() {
  const { data, isLoading, error } = useQuery<ClosedTrade[]>({
    queryKey: ["closed-trades"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trades")
        .select(
          "id, symbol, side, quantity, entry_price, exit_price, pnl, close_reason, created_at, closed_at",
        )
        .eq("status", "closed")
        .not("close_reason", "is", null)
        .neq("close_reason", "duplicate_cleanup")
        .order("closed_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as ClosedTrade[];
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const rows = data ?? [];

  return (
    <section className="panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title">Closed Positions</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            {rows.length} closed
          </p>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {error && (
        <p className="text-sm text-destructive">
          Failed to load closed positions: {(error as Error).message}
        </p>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="pb-1 font-normal">Symbol</th>
                <th className="pb-1 font-normal">Side</th>
                <th className="pb-1 font-normal">Reason</th>
                <th className="pb-1 font-normal">Entry</th>
                <th className="pb-1 font-normal">Exit</th>
                <th className="pb-1 font-normal">PnL</th>
                <th className="pb-1 font-normal">PnL %</th>
                <th className="pb-1 font-normal">Opened</th>
                <th className="pb-1 font-normal">Closed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const pnlPct = computePnlPct(t);
                const positive = (t.pnl ?? 0) >= 0;

                return (
                  <tr key={t.id} className="border-t border-border font-mono text-xs">
                    <td className="py-1.5 font-semibold">{t.symbol}</td>
                    <td className={`py-1.5 ${t.side === "buy" ? "text-bull" : "text-bear"}`}>
                      {t.side}
                    </td>
                    <td className={`py-1.5 ${reasonTone(t.close_reason)}`}>
                      {reasonLabel(t.close_reason)}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {formatPrice(Number(t.entry_price))}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {t.exit_price == null ? "—" : formatPrice(Number(t.exit_price))}
                    </td>
                    <td
                      className={`py-1.5 font-semibold ${
                        positive ? "text-bull" : "text-bear"
                      }`}
                    >
                      {t.pnl == null
                        ? "—"
                        : `${t.pnl >= 0 ? "+" : ""}${Number(t.pnl).toFixed(2)}`}
                    </td>
                    <td className={`py-1.5 ${positive ? "text-bull" : "text-bear"}`}>
                      {pnlPct == null
                        ? "—"
                        : `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {formatFullDateTime(t.created_at)}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {formatFullDateTime(t.closed_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No positions closed yet.</p>
      )}
    </section>
  );
}

export default TradeAlertsPanel;

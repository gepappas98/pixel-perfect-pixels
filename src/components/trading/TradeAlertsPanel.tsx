import { useLiveTable } from "@/hooks/useLiveTable";
import type { TradeAlert } from "@/lib/trading-types";

export function TradeAlertsPanel() {
  const { rows, loading } = useLiveTable<TradeAlert>("trade_alerts", 15);

  return (
    <section className="panel">
      <h2 className="panel-title">Closed Positions (Stop/Target Hits)</h2>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="pb-1 font-normal">Symbol</th>
              <th className="pb-1 font-normal">Side</th>
              <th className="pb-1 font-normal">Reason</th>
              <th className="pb-1 font-normal">Entry</th>
              <th className="pb-1 font-normal">Exit</th>
              <th className="pb-1 font-normal">PnL</th>
              <th className="pb-1 font-normal">Closed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-border font-mono text-xs">
                <td className="py-1.5">{a.symbol}</td>
                <td className={`py-1.5 ${a.side === "buy" ? "text-bull" : "text-bear"}`}>{a.side}</td>
                <td
                  className={`py-1.5 ${
                    a.event_type === "take_profit" ? "text-bull" : "text-bear"
                  }`}
                >
                  {a.event_type === "take_profit" ? "target hit" : "stop hit"}
                </td>
                <td className="py-1.5 text-muted-foreground">{Number(a.entry_price).toFixed(2)}</td>
                <td className="py-1.5 text-muted-foreground">{Number(a.exit_price).toFixed(2)}</td>
                <td className={`py-1.5 ${a.pnl >= 0 ? "text-bull" : "text-bear"}`}>
                  {a.pnl >= 0 ? "+" : ""}
                  {Number(a.pnl).toFixed(2)} ({a.pnl_pct >= 0 ? "+" : ""}
                  {Number(a.pnl_pct).toFixed(1)}%)
                </td>
                <td className="py-1.5 text-muted-foreground">
                  {new Date(a.created_at).toLocaleTimeString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No positions closed yet.</p>
      )}
    </section>
  );
}

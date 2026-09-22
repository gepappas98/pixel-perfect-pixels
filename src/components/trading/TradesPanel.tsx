import { useLiveTable } from "@/hooks/useLiveTable";
import type { Trade } from "@/lib/trading-types";

export function TradesPanel() {
  const { rows, loading } = useLiveTable<Trade>("trades", 15);

  return (
    <section className="panel">
      <h2 className="panel-title">Positions</h2>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="pb-1 font-normal">Symbol</th>
              <th className="pb-1 font-normal">Side</th>
              <th className="pb-1 font-normal">Entry</th>
              <th className="pb-1 font-normal">Stop</th>
              <th className="pb-1 font-normal">Target</th>
              <th className="pb-1 font-normal">Mode</th>
              <th className="pb-1 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-border font-mono text-xs">
                <td className="py-1.5">{t.symbol}</td>
                <td className={`py-1.5 ${t.side === "buy" ? "text-bull" : "text-bear"}`}>{t.side}</td>
                <td className="py-1.5 text-muted-foreground">{Number(t.entry_price).toFixed(2)}</td>
                <td className="py-1.5 text-muted-foreground">
                  {t.stop_loss != null ? Number(t.stop_loss).toFixed(2) : "—"}
                </td>
                <td className="py-1.5 text-muted-foreground">
                  {t.take_profit != null ? Number(t.take_profit).toFixed(2) : "—"}
                </td>
                <td className={`py-1.5 ${t.mode === "live" ? "text-warn" : "text-muted-foreground"}`}>
                  {t.mode}
                </td>
                <td className="py-1.5 text-muted-foreground">{t.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No positions opened yet.</p>
      )}
    </section>
  );
}

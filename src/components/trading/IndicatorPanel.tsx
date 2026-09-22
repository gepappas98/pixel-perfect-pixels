import { useLiveTable } from "@/hooks/useLiveTable";
import type { IndicatorSnapshot } from "@/lib/trading-types";

const tone: Record<string, string> = {
  bullish: "text-bull",
  bearish: "text-bear",
  neutral: "text-muted-foreground",
};

export function IndicatorPanel() {
  const { rows, loading } = useLiveTable<IndicatorSnapshot>("indicator_snapshots", 12);

  return (
    <section className="panel">
      <h2 className="panel-title">Technicals (4h)</h2>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="pb-1 font-normal">Pair</th>
            <th className="pb-1 font-normal">RSI</th>
            <th className="pb-1 font-normal">Price</th>
            <th className="pb-1 font-normal">Read</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id} className="border-t border-border">
              <td className="py-1 font-mono text-xs">{i.symbol}</td>
              <td className="py-1 font-mono text-xs text-muted-foreground">
                {i.rsi != null ? Number(i.rsi).toFixed(1) : "—"}
              </td>
              <td className="py-1 font-mono text-xs text-muted-foreground">
                {i.price != null ? Number(i.price).toFixed(2) : "—"}
              </td>
              <td className={`py-1 text-xs ${tone[i.signal ?? "neutral"]}`}>{i.signal ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No indicator snapshots yet.</p>
      )}
    </section>
  );
}

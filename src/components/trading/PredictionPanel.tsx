import { useLiveTable } from "@/hooks/useLiveTable";
import type { PredictionSnapshot } from "@/lib/trading-types";

export function PredictionPanel() {
  const { rows, loading } = useLiveTable<PredictionSnapshot>("prediction_snapshots", 10);

  return (
    <section className="panel">
      <h2 className="panel-title">Prediction markets</h2>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <ul className="space-y-1.5">
        {rows.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{p.question ?? p.market_slug}</span>
            <span className="shrink-0 font-mono text-xs text-bull">
              {p.yes_price != null ? `${Math.round(Number(p.yes_price) * 100)}% yes` : "—"}
            </span>
          </li>
        ))}
        {!loading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No relevant markets yet.</p>
        )}
      </ul>
    </section>
  );
}

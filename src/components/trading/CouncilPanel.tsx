import { useLiveTable } from "@/hooks/useLiveTable";
import type { CouncilSignal } from "@/lib/trading-types";

const tone: Record<string, string> = {
  BUY: "text-bull",
  SELL: "text-bear",
  AVOID: "text-bear",
  HOLD: "text-muted-foreground",
};

export function CouncilPanel() {
  const { rows, loading } = useLiveTable<CouncilSignal>("council_signals", 12, "source_created_at");

  return (
    <section className="panel">
      <h2 className="panel-title">AI council (Whale Radar)</h2>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <ul className="space-y-1.5">
        {rows.map((c) => (
          <li key={c.id} className="flex items-center justify-between text-sm">
            <span className="font-mono">{c.symbol}</span>
            <span className={`text-xs ${tone[c.final_verdict.toUpperCase()] ?? "text-muted-foreground"}`}>
              {c.final_verdict}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {c.conviction ?? "—"}%
            </span>
          </li>
        ))}
        {!loading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No council verdicts synced yet.</p>
        )}
      </ul>
    </section>
  );
}

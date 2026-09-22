import { useLiveTable } from "@/hooks/useLiveTable";
import type { WhaleAlert } from "@/lib/trading-types";

const usd = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}K`;

export function WhalePanel() {
  const { rows, loading } = useLiveTable<WhaleAlert>("whale_alerts", 12);

  return (
    <section className="panel">
      <h2 className="panel-title">Whale flow</h2>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <ul className="space-y-1.5">
        {rows.map((w) => (
          <li key={w.id} className="flex items-center justify-between text-sm">
            <span className="font-mono">{w.symbol}</span>
            <span
              className={w.direction === "accumulation" ? "text-bull text-xs" : "text-bear text-xs"}
            >
              {w.direction === "accumulation" ? "buy" : "sell"}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {usd(Number(w.usd_value))}
            </span>
          </li>
        ))}
        {!loading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No whale prints yet.</p>
        )}
      </ul>
    </section>
  );
}

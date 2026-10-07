import { useLiveTable } from "@/hooks/useLiveTable";
import type { WhaleAlert } from "@/lib/trading-types";

const usd = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}K`;

export function WhalePanel() {
  const { rows, loading } = useLiveTable<WhaleAlert>("whale_alerts", 12);

  const accumulationUsd = rows
    .filter((w) => w.direction === "accumulation")
    .reduce((sum, w) => sum + Number(w.usd_value), 0);
  const distributionUsd = rows
    .filter((w) => w.direction === "distribution")
    .reduce((sum, w) => sum + Number(w.usd_value), 0);
  const totalFlowUsd = accumulationUsd + distributionUsd;
  const rawFlowScore = totalFlowUsd > 0
    ? (accumulationUsd - distributionUsd) / totalFlowUsd
    : 0;
  const flowScore = Math.max(-1, Math.min(1, rawFlowScore));
  const flowPercent = Math.round(Math.abs(flowScore) * 100);
  const flowLabel =
    flowScore > 0.05
      ? "Accumulation"
      : flowScore < -0.05
        ? "Distribution"
        : "Neutral";
  const markerPosition = ((flowScore + 1) / 2) * 100;

  return (
    <section className="panel">
      <h2 className="panel-title">Whale flow</h2>

      <div
        className="mb-3"
        role="img"
        aria-label={`Whale flow: ${flowLabel}${flowLabel === "Neutral" ? "" : ` ${flowPercent}%`}`}
        title={`Whale flow: ${flowLabel}${flowLabel === "Neutral" ? "" : ` ${flowPercent}%`}`}
      >
        <div className="mb-1 flex items-center justify-between text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
          <span>Distribution</span>
          <span>Neutral</span>
          <span>Accumulation</span>
        </div>
        <div className="relative h-2 overflow-visible rounded-full border border-border bg-muted">
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
          <div
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-sm"
            style={{ left: `${markerPosition}%` }}
          />
        </div>
        <div className="mt-1 text-center text-[10px] font-mono text-muted-foreground">
          <span className={flowLabel === "Accumulation" ? "text-bull" : flowLabel === "Distribution" ? "text-bear" : ""}>
            {flowLabel}{flowLabel !== "Neutral" ? ` ${flowPercent}%` : ""}
          </span>
        </div>
      </div>

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

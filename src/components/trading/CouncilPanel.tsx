import { useLiveTable } from "@/hooks/useLiveTable";
import type { CouncilSignal } from "@/lib/trading-types";

const tone: Record<string, string> = {
  BUY: "text-bull",
  SELL: "text-bear",
  AVOID: "text-bear",
  HOLD: "text-muted-foreground",
};
const badge: Record<string, string> = {
  BUY: "border-bull/30 bg-bull/10",
  SELL: "border-bear/30 bg-bear/10",
  AVOID: "border-bear/30 bg-bear/10",
  HOLD: "border-border bg-muted/50",
};

function timeAgo(value?: string | null) {
  if (!value) return "—";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours > 24 ? "stale" : `${hours}h ago`;
}

export function CouncilPanel() {
  const { rows: syncedRows, loading: syncing } = useLiveTable<CouncilSignal>(
    "council_signals",
    12,
    "created_at",
  );

  const rows = syncedRows.filter(
    (row, index, all) => all.findIndex((candidate) => candidate.symbol === row.symbol) === index,
  );
  const updated = rows[0]?.created_at ?? rows[0]?.source_created_at;

  return (
    <section className="panel overflow-hidden">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title">AI council</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Whale Radar · synced feed
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] text-bull">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bull" /> live
        </span>
      </div>
      {syncing && (
        <p className="text-sm text-muted-foreground">Reading latest council decisions…</p>
      )}
      <ul className="space-y-2">
        {rows.slice(0, 8).map((c) => {
          const verdict = c.final_verdict.toUpperCase();
          return (
            <li
              key={`${c.id}-${c.symbol}`}
              className="rounded-md border border-border/70 bg-background/30 p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm font-semibold">{c.symbol}</span>
                <span
                  className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${badge[verdict] ?? badge["HOLD"]} ${tone[verdict] ?? tone["HOLD"]}`}
                >
                  {verdict}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Conviction</span>
                <span className="font-mono text-foreground">{c.conviction ?? "—"}%</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full ${verdict === "BUY" ? "bg-bull" : verdict === "HOLD" ? "bg-muted-foreground" : "bg-bear"}`}
                  style={{ width: `${Math.min(100, Math.max(0, c.conviction ?? 0))}%` }}
                />
              </div>
              {c.reflection && (
                <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                  {c.reflection}
                </p>
              )}
              <p className="mt-2 text-[10px] text-muted-foreground">
                {timeAgo(c.created_at ?? c.source_created_at)} · {c.depth ?? "council synthesis"}
              </p>
            </li>
          );
        })}
        {!syncing && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No council verdicts synced yet.</p>
        )}
      </ul>
      {updated && (
        <p className="mt-3 border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
          Last update {timeAgo(updated)} · refreshes live
        </p>
      )}
    </section>
  );
}

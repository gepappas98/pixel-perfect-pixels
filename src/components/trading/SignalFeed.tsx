import { useLiveTable } from "@/hooks/useLiveTable";
import type { CompositeSignal } from "@/lib/trading-types";

const badge: Record<CompositeSignal["recommendation"], string> = {
  buy: "border-bull/40 bg-bull/10 text-bull",
  sell: "border-bear/40 bg-bear/10 text-bear",
  hold: "border-border bg-muted text-muted-foreground",
  watch: "border-warn/40 bg-warn/10 text-warn",
};

export function SignalFeed() {
  const { rows, loading, error } = useLiveTable<CompositeSignal>("composite_signals", 25);

  return (
    <section className="panel h-full">
      <h2 className="panel-title">Composite signals</h2>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="space-y-2">
        {rows.map((s) => (
          <div
            key={s.id}
            className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold">{s.symbol}</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${badge[s.recommendation]}`}
                >
                  {s.recommendation}
                </span>
                <span className="text-xs text-muted-foreground">
                  {Math.round(Number(s.confidence) * 100)}% confidence
                </span>
              </div>
              {s.reasoning && (
                <p className="mt-1 text-xs text-muted-foreground">{s.reasoning}</p>
              )}
            </div>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {new Date(s.created_at).toLocaleTimeString()}
            </span>
          </div>
        ))}
        {!loading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No signals yet — run the pipeline to populate the feed.
          </p>
        )}
      </div>
    </section>
  );
}

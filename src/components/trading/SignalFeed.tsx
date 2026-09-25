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

  // Dedup ανά symbol: κρατάει το πιο πρόσφατο signal κάθε νομίσματος.
  // Το useLiveTable επιστρέφει rows order by created_at desc, άρα το πρώτο
  // που συναντάμε για κάθε symbol είναι και το πιο πρόσφατο.
  // Παράλληλα μετράμε πόσες επιπλέον ιστορικές εγγραφές υπάρχουν για
  // να το δείξουμε ως μικρό badge "+N".
  const { signals, extraCounts } = rows.reduce<{
    signals: CompositeSignal[];
    extraCounts: Record<string, number>;
  }>(
    (acc, row) => {
      if (acc.extraCounts[row.symbol] === undefined) {
        acc.signals.push(row);
        acc.extraCounts[row.symbol] = 0;
      } else {
        acc.extraCounts[row.symbol] = (acc.extraCounts[row.symbol] ?? 0) + 1;
      }
      return acc;
    },
    { signals: [], extraCounts: {} },
  );

  return (
    <section className="panel h-full">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title">Composite signals</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Latest per symbol · {signals.length} active
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] text-bull">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bull" /> live
        </span>
      </div>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="space-y-2">
        {signals.map((s) => {
          const extras = extraCounts[s.symbol] ?? 0;
          return (
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
                  {extras > 0 && (
                    <span
                      className="rounded-full border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      title={`${extras} παλαιότερα σήματα στο feed`}
                    >
                      +{extras}
                    </span>
                  )}
                </div>
                {s.reasoning && (
                  <p className="mt-1 text-xs text-muted-foreground">{s.reasoning}</p>
                )}
              </div>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {new Date(s.created_at).toLocaleTimeString()}
              </span>
            </div>
          );
        })}
        {!loading && signals.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No signals yet — run the pipeline to populate the feed.
          </p>
        )}
      </div>
    </section>
  );
}

export default SignalFeed;

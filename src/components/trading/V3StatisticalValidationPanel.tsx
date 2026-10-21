import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { chronologicalCohorts, dedupeSymbolCycles, outcomeMetrics, type V3OutcomeRow } from "@/lib/v3-statistical-validation";

const AUDIT_SNAPSHOT = {
  asOf: "2026-10-21",
  rawRows: 732,
  units: 552,
  wins: 391,
  losses: 161,
  winRate: 70.83,
  meanPnl: 1.9583,
  strategies: [
    { name: "whale-focused", n: 270, wins: 223, losses: 47, mean: 2.7815 },
    { name: "accumulation", n: 268, wins: 149, losses: 119, mean: 0.8918 },
    { name: "ai-driven", n: 41, wins: 33, losses: 8, mean: 2.6341 },
    { name: "conservative", n: 32, wins: 24, losses: 8, mean: 2.25 },
    { name: "smc-reversal", n: 30, wins: 25, losses: 5, mean: 2.8333 },
    { name: "vwap-momentum", n: 29, wins: 24, losses: 5, mean: 2.7931 },
    { name: "volatility-timing", n: 29, wins: 24, losses: 5, mean: 2.7931 },
    { name: "balanced", n: 22, wins: 14, losses: 8, mean: 1.4545 },
    { name: "chart-trader", n: 11, wins: 8, losses: 3, mean: 2.0909 },
  ],
};

const pct = (value: number | null | undefined) => value == null ? "—" : `${value.toFixed(2)}%`;
const interval = (value: { low: number; high: number } | null) => value ? `${value.low.toFixed(1)}–${value.high.toFixed(1)}%` : "—";
const signed = (value: number | null | undefined) => value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(4)}%`;

type ReadQuery = { select: (columns: string) => ReadQuery; like: (column: string, value: string) => ReadQuery; in: (column: string, values: string[]) => ReadQuery; not: (column: string, operator: string, value: unknown) => ReadQuery; order: (column: string, options: { ascending: boolean }) => ReadQuery; range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };

async function readV3Rows(): Promise<V3OutcomeRow[]> {
  const readOnlyDb = supabase as unknown as { from: (table: string) => ReadQuery };
  const { data, error } = await readOnlyDb
    .from("strategy_variant_signals")
    .select("id,strategy_name,symbol,created_at,resolved_at,outcome,pnl_pct,source_fingerprint")
    .like("source_fingerprint", "v3|%")
    .in("outcome", ["win", "loss"])
    .not("resolved_at", "is", null)
    .order("created_at", { ascending: true })
    .range(0, 4999);
  if (error) throw error;
  return (data ?? []) as unknown as V3OutcomeRow[];
}

export default function V3StatisticalValidationPanel() {
  const query = useQuery({ queryKey: ["v3-statistical-validation"], queryFn: readV3Rows, staleTime: 60_000, retry: false });
  const live = query.data;
  const deduped = live ? dedupeSymbolCycles(live) : null;
  const rawOverall = live ? outcomeMetrics(live) : null;
  const unitMetrics = deduped ? outcomeMetrics(deduped.units.map(unit => ({ outcome: unit.outcome, pnl_pct: unit.pnlPct }))) : null;
  const strategies = live ? [...new Set(live.map(row => row.strategy_name ?? "unknown"))].sort().map(name => {
    const rows = live.filter(row => (row.strategy_name ?? "unknown") === name);
    return { name, ...outcomeMetrics(rows) };
  }).sort((a, b) => (b.winRatePct ?? -1) - (a.winRatePct ?? -1)) : null;
  const weeks = deduped ? chronologicalCohorts(deduped.units) : [];
  const snapshotMode = !live;
  return <section aria-label="V3 Statistical Validation" className="space-y-4 border-t border-border py-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-medium">V3 Statistical Validation</h2>
        <p className="text-xs text-muted-foreground">Read-only research · no scoring or execution side-effects</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw className={`mr-2 size-4 ${query.isFetching ? "animate-spin" : ""}`} />Refresh</Button>
    </div>
    {query.isError && <div role="status" className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm">
      Live V3 query unavailable. Showing the labeled audit snapshot from {AUDIT_SNAPSHOT.asOf}; these values are not live.
    </div>}
    <div className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 shrink-0" />Out-of-sample validation is not established</p>
      <p className="mt-1 text-xs text-muted-foreground">The current resolved V3 snapshot spans approximately 2026-10-19 to 2026-10-21. This is too short to establish robustness across market regimes. Every feature's available_at / snapshot timestamp must be at or before the entry timestamp before it can be used as entry evidence.</p>
    </div>
    <p className="text-xs text-muted-foreground">{snapshotMode ? `Fallback audit snapshot · ${AUDIT_SNAPSHOT.asOf}` : `Live read-only query · ${live.length} resolved V3 rows returned`}. Raw variant rows and deduplicated symbol-cycle units are separate populations.</p>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div><p className="text-xs text-muted-foreground">Raw resolved rows</p><p className="font-mono text-xl">{snapshotMode ? AUDIT_SNAPSHOT.rawRows : rawOverall?.n ?? 0}</p></div>
      <div><p className="text-xs text-muted-foreground">Unique symbol-cycles</p><p className="font-mono text-xl">{snapshotMode ? AUDIT_SNAPSHOT.units : deduped?.units.length ?? 0}</p></div>
      <div><p className="text-xs text-muted-foreground">Deduped win rate</p><p className="font-mono text-xl">{snapshotMode ? pct(AUDIT_SNAPSHOT.winRate) : pct(unitMetrics?.winRatePct)}</p><p className="text-xs text-muted-foreground">{snapshotMode ? "391W / 161L" : `${unitMetrics?.wins ?? 0}W / ${unitMetrics?.losses ?? 0}L`}</p></div>
      <div><p className="text-xs text-muted-foreground">Mean nominal return</p><p className="font-mono text-xl">{snapshotMode ? signed(AUDIT_SNAPSHOT.meanPnl) : signed(unitMetrics?.meanPnlPct)}</p></div>
    </div>
    {!snapshotMode && deduped && <p className="text-xs text-muted-foreground">Excluded from deduped outcomes: {deduped.invalidRows} invalid rows · {deduped.conflictingUnits} conflicting symbol-cycle outcomes. Raw-row Wilson 95% CI: {interval(rawOverall?.wilson95Pct ?? null)}; deduped Wilson 95% CI: {interval(unitMetrics?.wilson95Pct ?? null)}.</p>}
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Strategy comparison · raw variant rows</h3>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b border-border">{["Strategy","N","W / L","Win rate","Wilson 95% CI","Mean PnL","Median PnL","Profit factor"].map(label => <th key={label} className="whitespace-nowrap px-2 py-2">{label}</th>)}</tr></thead>
      <tbody>{(snapshotMode ? AUDIT_SNAPSHOT.strategies.map(s => ({ name:s.name,n:s.n,wins:s.wins,losses:s.losses,winRatePct:s.wins/s.n*100,wilson95Pct:null,meanPnlPct:s.mean,medianPnlPct:null,profitFactor:null })) : strategies ?? []).map(row => <tr key={row.name} className="border-b border-border/60"><td className="px-2 py-2 font-medium">{row.name}</td><td className="px-2 py-2">{row.n}</td><td className="px-2 py-2">{row.wins}/{row.losses}</td><td className="px-2 py-2">{pct(row.winRatePct)}</td><td className="whitespace-nowrap px-2 py-2">{interval(row.wilson95Pct)}</td><td className="px-2 py-2">{signed(row.meanPnlPct)}</td><td className="px-2 py-2">{signed(row.medianPnlPct)}</td><td className="px-2 py-2">{row.profitFactor == null ? "—" : row.profitFactor.toFixed(2)}</td></tr>)}</tbody></table></div>
    </div>
    {!snapshotMode && <div className="space-y-2">
      <h3 className="text-sm font-medium">Chronological cohorts · deduplicated units</h3>
      {weeks.length === 0 ? <p className="text-xs text-muted-foreground">No valid chronological cohorts available.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b border-border">{["Week starting UTC","N","W / L","Win rate","Wilson 95% CI","Mean PnL"].map(label => <th key={label} className="px-2 py-2">{label}</th>)}</tr></thead><tbody>{weeks.map(week => <tr key={week.week} className="border-b border-border/60"><td className="px-2 py-2">{week.week}</td><td className="px-2 py-2">{week.metrics.n}</td><td className="px-2 py-2">{week.metrics.wins}/{week.metrics.losses}</td><td className="px-2 py-2">{pct(week.metrics.winRatePct)}</td><td className="px-2 py-2">{interval(week.metrics.wilson95Pct)}</td><td className="px-2 py-2">{signed(week.metrics.meanPnlPct)}</td></tr>)}</tbody></table></div>}
    </div>}
    <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">Interpretation and limitations</p>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        <li>Deduplication uses the explicit cycle identifier in <code>source_fingerprint</code> and symbol, not the strategy name; conflicting outcomes are excluded and counted.</li>
        <li>Variant PnL is nominal outcome PnL (currently bounded by +4% / −3%); no per-variant fee field is available in this source, so it is not net PnL.</li>
        <li>Strategies share symbols and cycles. Raw rows are not independent samples; strategy rankings require matched symbol-cycle cohorts and cluster-aware uncertainty.</li>
        <li>Out-of-sample proof requires a chronological holdout not used for tuning and point-in-time feature availability checks. This panel does not promote or alter any strategy.</li>
      </ul>
    </div>
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Separate audited paper-trade economics · {AUDIT_SNAPSHOT.asOf}</summary>
      <p className="mt-2 text-xs text-muted-foreground">This is a distinct trade-table snapshot, not V3 variant performance: 264 closed trades · gross PnL $860.79 · fees $264.43 · net PnL $596.36. Maximum cumulative closed-trade net-PnL drawdown: −$1,300.83 in currency units, not equity-percent drawdown.</p>
    </details>
  </section>;
}

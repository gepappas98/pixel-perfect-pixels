import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { exportTxtReport, type DiagnosticReportLike } from "@/lib/export-txt";

type Row = Record<string, any>;
const pnl = (r: Row) => Number(r.net_pnl ?? r.gross_pnl ?? r.pnl ?? 0);

export default function AIReport() {
  const [report, setReport] = useState<DiagnosticReportLike | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const started = Date.now(); setLoading(true); setError(null);
    try {
      const since = new Date(Date.now() - 86400000).toISOString();
      const [open, closed, variants, errors] = await Promise.all([
        supabase.from("trades").select("*").eq("status", "open").order("created_at", { ascending: false }).limit(200),
        supabase.from("trades").select("*").eq("status", "closed").order("closed_at", { ascending: false }).limit(100),
        supabase.from("strategy_variant_signals").select("*", { count: "exact" }).order("created_at", { ascending: false }).limit(2000),
        supabase.from("pipeline_runs").select("created_at, step, message, run_id").eq("status", "error").gte("created_at", since).order("created_at", { ascending: false }).limit(30),
      ]);
      if (open.error) throw open.error;
      if (closed.error) throw closed.error;
      const openTrades = (open.data ?? []) as Row[], closedTrades = (closed.data ?? []) as Row[];
      const variantRows = (variants.data ?? []) as Row[], pipelineErrors = (errors.data ?? []) as Row[];
      const wins = closedTrades.filter((r) => pnl(r) > 0), losses = closedTrades.filter((r) => pnl(r) < 0);
      const realized = closedTrades.reduce((s, r) => s + pnl(r), 0), unrealized = openTrades.reduce((s, r) => s + pnl(r), 0);
      const grossLoss = Math.abs(losses.reduce((s, r) => s + pnl(r), 0));
      const bySymbol = new Map<string, { symbol: string; open: number; resolved: number; total: number }>();
      for (const row of variantRows) { const symbol = String(row.symbol ?? "unknown"); const item = bySymbol.get(symbol) ?? { symbol, open: 0, resolved: 0, total: 0 }; item.total++; row.outcome === "open" ? item.open++ : item.resolved++; bySymbol.set(symbol, item); }
      const issues = pipelineErrors.length ? [`${pipelineErrors.length} pipeline errors in the last 24 hours`] : [];
      const report: DiagnosticReportLike = {
        schema_version: "1.1", generated_at: new Date().toISOString(), duration_ms: Date.now() - started,
        health: { overall: issues.length ? "degraded" : "ok", score: issues.length ? 70 : 100, issues, subsystems: { database: { status: "ok", note: `${openTrades.length} open trades loaded` }, pipeline: { status: issues.length ? "warn" : "ok", note: `${pipelineErrors.length} recent errors` } } },
        answers: { summary: { q: "What is the current system status?", a: `${openTrades.length} open trades, ${closedTrades.length} closed trades, ${variantRows.length} recent variants.`, confidence: "high" } },
        anomalies: [],
        data: { trades: { open_count: openTrades.length, closed_count: closedTrades.length, open: openTrades, recent_closed: closedTrades }, portfolio: { realized_pnl: +realized.toFixed(2), unrealized_pnl: +unrealized.toFixed(2), closed_count: closedTrades.length, win_count: wins.length, loss_count: losses.length, win_rate_pct: closedTrades.length ? +(wins.length / closedTrades.length * 100).toFixed(2) : 0, profit_factor: grossLoss ? +(wins.reduce((s, r) => s + pnl(r), 0) / grossLoss).toFixed(3) : null }, variants: { open_count: variantRows.filter((r) => r.outcome === "open").length, total_count: variants.count ?? variantRows.length, resolved_count: variantRows.filter((r) => r.outcome !== "open").length, by_symbol_top: [...bySymbol.values()].sort((a, b) => b.total - a.total).slice(0, 20) }, pipeline: { recent_errors: pipelineErrors }, symbols: { watched: [], blacklisted: [], with_live_price: [] } },
        suggested_actions: issues.map((issue) => ({ priority: "P0", action: "Review pipeline errors", reason: issue, evidence: pipelineErrors.slice(0, 3).map((r) => String(r.message ?? r.step ?? "error")) })), narrative_md: "", ai_context: `Trading Command Center diagnostic\nHealth: ${issues.length ? "degraded" : "ok"}\nRealized PnL: ${realized.toFixed(2)}\nUnrealized PnL: ${unrealized.toFixed(2)}`,
      };
      setReport(report);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <main className="min-h-screen bg-background px-4 py-8 text-foreground md:px-8"><div className="mx-auto flex max-w-6xl flex-col gap-6">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Trading Command Center</p><h1 className="text-3xl font-semibold tracking-tight">AI diagnostic report</h1><p className="mt-1 text-sm text-muted-foreground">Operational snapshot with portfolio, variants, errors, and raw JSON.</p></div><div className="flex gap-2"><button className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50" onClick={() => void load()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button><button className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50" onClick={() => report && exportTxtReport(report)} disabled={!report}>Download .txt</button></div></header>
    {error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">Unable to load report: {error}</div>}
    {loading && !report && <p className="text-sm text-muted-foreground">Loading diagnostic data…</p>}
    {report && <><section className="grid grid-cols-2 gap-3 md:grid-cols-4">{[["Health", report.health?.overall], ["Score", `${report.health?.score ?? 0}/100`], ["Open trades", report.data?.trades?.open_count ?? 0], ["Realized PnL", `$${report.data?.portfolio?.realized_pnl ?? 0}`]].map(([label, value]) => <div className="rounded-lg border border-border bg-card p-4" key={String(label)}><p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-2 text-xl font-semibold">{value}</p></div>)}</section><section className="grid gap-4 md:grid-cols-2"><article className="rounded-lg border border-border bg-card p-5"><h2 className="font-medium">System findings</h2><ul className="mt-3 flex flex-col gap-2 text-sm text-muted-foreground">{report.health?.issues?.length ? report.health.issues.map((issue) => <li key={issue}>{issue}</li>) : <li>No current issues detected.</li>}</ul></article><article className="rounded-lg border border-border bg-card p-5"><h2 className="font-medium">AI context</h2><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{report.ai_context}</pre></article></section><details className="rounded-lg border border-border bg-card p-5"><summary className="cursor-pointer text-sm font-medium">View full JSON report</summary><pre className="mt-4 max-h-[32rem] overflow-auto text-xs text-muted-foreground">{JSON.stringify(report, null, 2)}</pre></details></>}
  </div></main>;
}

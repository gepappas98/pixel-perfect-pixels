import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { exportTxtReport, type DiagnosticReportLike } from "@/lib/export-txt";

export default function AIReport() {
  const [report, setReport] = useState<DiagnosticReportLike | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const started = Date.now(); setLoading(true); setError(null);
    try {
      const since = new Date(Date.now() - 86400000).toISOString();
      const [open, closed, variants, errors] = await Promise.all([
        supabase.from("trades").select("*").eq("status", "open").order("created_at", { ascending: false }).limit(100),
        supabase.from("trades").select("*").eq("status", "closed").order("closed_at", { ascending: false }).limit(20),
        supabase.from("strategy_variant_signals").select("*").order("created_at", { ascending: false }).limit(500),
        supabase.from("pipeline_runs").select("*").eq("status", "error").gte("created_at", since).order("created_at", { ascending: false }).limit(30),
      ]);
      if (open.error) throw open.error;
      const openTrades = (open.data ?? []) as Array<Record<string, unknown>>;
      const closedTrades = (closed.data ?? []) as Array<Record<string, unknown>>;
      const variantRows = (variants.data ?? []) as Array<Record<string, unknown>>;
      const errorRows = (errors.data ?? []) as Array<Record<string, unknown>>;
      const realized = closedTrades.reduce((sum, row) => sum + Number(row.pnl_usd ?? 0), 0);
      const wins = closedTrades.filter((row) => Number(row.pnl_usd ?? 0) > 0).length;
      const health = errorRows.length ? "degraded" : "ok";
      setReport({ schema_version: "1.0", generated_at: new Date().toISOString(), duration_ms: Date.now() - started,
        health: { overall: health, score: errorRows.length ? 70 : 100, issues: errorRows.length ? [`${errorRows.length} pipeline errors in the last 24 hours`] : [], subsystems: { database: { status: "ok", note: `${openTrades.length} open trades loaded` }, pipeline: { status: errorRows.length ? "warn" : "ok", note: `${errorRows.length} recent errors` } } },
        answers: { summary: { q: "What is the current system status?", a: `${openTrades.length} open trades, ${closedTrades.length} recent closed trades, and ${variantRows.length} recent variants.`, confidence: "high" } }, anomalies: [],
        data: { trades: { open_count: openTrades.length, closed_count: closedTrades.length, open: openTrades, recent_closed: closedTrades }, portfolio: { realized_pnl: realized, unrealized_pnl: openTrades.reduce((sum, row) => sum + Number(row.pnl_usd ?? 0), 0), closed_count: closedTrades.length, win_rate_pct: closedTrades.length ? (wins / closedTrades.length) * 100 : 0 }, variants: { open_count: variantRows.filter((row) => row.outcome === "open").length, total_count: variantRows.length, by_symbol_top: [] }, pipeline: { recent_errors: errorRows }, symbols: { watched: [], blacklisted: [], with_live_price: [] } }, suggested_actions: [], narrative_md: "", ai_context: "" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  return <main className="min-h-screen bg-background px-4 py-8 text-foreground md:px-8"><div className="mx-auto flex max-w-6xl flex-col gap-6">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Trading Command Center</p><h1 className="text-3xl font-semibold tracking-tight">AI diagnostic report</h1><p className="mt-1 text-sm text-muted-foreground">Full operational snapshot with downloadable raw JSON.</p></div><div className="flex gap-2"><button className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50" onClick={() => void load()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button><button className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50" onClick={() => report && exportTxtReport(report)} disabled={!report}>Download .txt</button></div></header>
    {error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">Unable to load report: {error}</div>}
    {loading && !report && <p className="text-sm text-muted-foreground">Loading diagnostic data…</p>}
    {report && <><section className="grid grid-cols-2 gap-3 md:grid-cols-4">{[["Health", report.health?.overall], ["Score", `${report.health?.score ?? 0}/100`], ["Open trades", report.data?.trades?.open_count ?? 0], ["Variants", report.data?.variants?.total_count ?? 0]].map(([label, value]) => <div className="rounded-lg border border-border bg-card p-4" key={String(label)}><p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-2 text-xl font-semibold">{value}</p></div>)}</section><section className="grid gap-4 md:grid-cols-2"><article className="rounded-lg border border-border bg-card p-5"><h2 className="font-medium">System findings</h2><ul className="mt-3 flex flex-col gap-2 text-sm text-muted-foreground">{(report.health?.issues ?? []).length ? report.health?.issues?.map((issue) => <li key={issue}>{issue}</li>) : <li>No current issues detected.</li>}</ul></article><article className="rounded-lg border border-border bg-card p-5"><h2 className="font-medium">AI context</h2><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{report.ai_context || "No AI analysis run yet."}</pre></article></section><details className="rounded-lg border border-border bg-card p-5"><summary className="cursor-pointer text-sm font-medium">View full JSON report</summary><pre className="mt-4 max-h-[32rem] overflow-auto text-xs text-muted-foreground">{JSON.stringify(report, null, 2)}</pre></details></>}
  </div></main>;
}


import { createServerFn } from "@tanstack/react-start";
import type { AuditFinding, AuditReport } from "./audit-report";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = { from: (t: string) => any };

/** Read-only: list stored audit reports, newest first. */
export const listAuditReports = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuditReport[]> => {
    const { supabase } = await import("@/integrations/supabase/client");
    const db = supabase as unknown as Loose;
    const { data, error } = await db
      .from("system_audit_reports")
      .select("*")
      .order("checked_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as AuditReport[];
  },
);

/** Read-only: compute a fresh audit snapshot using SELECTs only. Nothing is written. */
export const refreshAuditSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuditReport> => {
    const { supabase } = await import("@/integrations/supabase/client");
    const db = supabase as unknown as Loose;
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const findings: AuditFinding[] = [];

    const { data: runs, error: runsErr } = await db
      .from("pipeline_runs")
      .select("status")
      .gte("started_at", since);
    if (runsErr) {
      findings.push({ category: "needs_recheck", title: "pipeline_runs unreadable", detail: runsErr.message });
    } else {
      const total = runs?.length ?? 0;
      const nonCompleted = (runs ?? []).filter((r: { status: string }) => r.status !== "completed").length;
      findings.push({
        category: nonCompleted > 0 ? "confirmed_bug" : "needs_recheck",
        title: "Pipeline runs (last 24h)",
        detail: `${total} runs, ${nonCompleted} not completed. Stage-level failures are not visible from run status alone.`,
      });
    }

    const { data: open, error: openErr } = await db
      .from("trades")
      .select("symbol")
      .eq("status", "open")
      .eq("mode", "paper");
    if (!openErr) {
      const counts = new Map<string, number>();
      for (const r of (open ?? []) as { symbol: string }[]) counts.set(r.symbol, (counts.get(r.symbol) ?? 0) + 1);
      const dups = [...counts.entries()].filter(([, n]) => n > 1).map(([s]) => s);
      findings.push({
        category: dups.length ? "confirmed_bug" : "verified_ok",
        title: "Open paper positions",
        detail: `${open?.length ?? 0} open; duplicate symbols: ${dups.length ? dups.join(", ") : "none"}.`,
      });
    }

    const { data: closed, error: closedErr } = await db
      .from("trades")
      .select("net_pnl, pnl")
      .eq("status", "closed")
      .eq("mode", "paper");
    if (!closedErr) {
      const vals = (closed ?? []).map((r: { net_pnl: number | null; pnl: number | null }) => Number(r.net_pnl ?? r.pnl ?? 0));
      const wins = vals.filter((v: number) => v > 0).length;
      const sum = vals.reduce((a: number, b: number) => a + b, 0);
      findings.push({
        category: "research_comparability",
        title: "Closed paper trades",
        detail: `${vals.length} closed, ${wins} profitable, ${vals.length - wins} not; realized net PnL $${sum.toFixed(2)}. Mixed TP targets across sources; not proof of edge.`,
      });
    }

    const hasBug = findings.some((f) => f.category === "confirmed_bug");
    return {
      checked_at: now.toISOString(),
      title: "Runtime / Research Integrity Audit — refresh",
      severity: hasBug ? "warning" : "info",
      status: "refresh",
      summary: "Read-only SELECT diagnostics computed at checked_at. Observed facts at audit time, not proof of data corruption.",
      findings,
      source: "ai-report refresh (read-only)",
      window_label: `${since} → ${now.toISOString()} (last 24h)`,
    };
  },
);

/** Writes ONLY to system_audit_reports (append-only). */
export const saveAuditSnapshot = createServerFn({ method: "POST" })
  .inputValidator((d: AuditReport) => {
    if (!d || typeof d.title !== "string" || !Array.isArray(d.findings)) throw new Error("invalid report");
    if (!["info", "warning", "critical"].includes(d.severity)) throw new Error("invalid severity");
    return d;
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin as unknown as Loose;
    const row = {
      checked_at: data.checked_at,
      title: data.title.slice(0, 200),
      severity: data.severity,
      status: String(data.status).slice(0, 50),
      summary: String(data.summary).slice(0, 2000),
      findings: data.findings.slice(0, 100),
      source: String(data.source).slice(0, 200),
      window_label: data.window_label,
    };
    const { data: inserted, error } = await db.from("system_audit_reports").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return inserted as AuditReport;
  });

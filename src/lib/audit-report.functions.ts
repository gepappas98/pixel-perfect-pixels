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
      .select("status,result")
      .gte("started_at", since);
    if (runsErr) {
      findings.push({ category: "needs_recheck", title: "pipeline_runs unreadable", detail: runsErr.message });
    } else {
      const runRows = (runs ?? []) as Array<{ status: string; result: unknown }>;
      const total = runRows.length;
      const nonCompleted = runRows.filter((r) => r.status !== "completed").length;
      const stageFailureCounts = new Map<string, number>();
      let runsWithStageFailures = 0;

      for (const run of runRows) {
        const result = run.result && typeof run.result === "object"
          ? run.result as Record<string, unknown>
          : {};
        const stages = Array.isArray(result["stages"]) ? result["stages"] : [];
        let runHasFailure = false;

        for (const rawStage of stages) {
          if (!rawStage || typeof rawStage !== "object") continue;
          const stage = rawStage as Record<string, unknown>;
          const stageResult = stage["result"] && typeof stage["result"] === "object"
            ? stage["result"] as Record<string, unknown>
            : {};
          const reportedFailures = Number(stageResult["failures"] ?? stage["failures"] ?? 0);
          const httpStatus = Number(stage["status"] ?? 0);
          const hasReportedError = Boolean(stageResult["error"] || stage["error"]);
          if (
            stage["ok"] !== false &&
            stageResult["ok"] !== false &&
            httpStatus < 400 &&
            reportedFailures <= 0 &&
            !hasReportedError
          ) continue;

          runHasFailure = true;
          const name = String(stage["name"] ?? "unknown-stage");
          stageFailureCounts.set(name, (stageFailureCounts.get(name) ?? 0) + 1);
        }
        if (runHasFailure) runsWithStageFailures++;
      }

      findings.push({
        category: nonCompleted > 0 ? "confirmed_bug" : "needs_recheck",
        title: "Pipeline runs (last 24h)",
        detail: `${total} runs, ${nonCompleted} not completed. Overall status alone does not establish stage health.`,
      });

      const stageFailureSummary = [...stageFailureCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}: ${count} affected runs`)
        .join("; ");
      findings.push({
        category: runsWithStageFailures > 0 ? "needs_recheck" : "verified_ok",
        title: "Stage-level partial failures (last 24h)",
        detail: runsWithStageFailures > 0
          ? `${runsWithStageFailures} runs contain failed stages or reported partial task failures. ${stageFailureSummary}`
          : "No stage failures were recorded in the returned result payloads. This does not rule out failures that a stage fails to report.",
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

    findings.push({
      category: "needs_recheck",
      title: "Audit coverage limits",
      detail: "This automated refresh checks pipeline run status/stage payloads and paper trades. It does not recheck cron activation, SQL timeout logs, CMC source health, variant cohort independence, or strategy-specific TP/SL settings.",
    });

    const hasBug = findings.some((f) => f.category === "confirmed_bug");
    return {
      checked_at: now.toISOString(),
      title: "Runtime / Research Integrity Audit — refresh",
      severity: hasBug ? "warning" : "info",
      status: "refresh",
      summary: "Partial read-only refresh of pipeline_runs (including stage result payloads) and paper trades. It does not recheck pg_cron activation, SQL timeout logs, CMC source health, variant cohort independence, or per-strategy TP/SL comparability; those remain in historical findings until targeted checks are added. Observed facts at audit time, not proof of data corruption.",
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

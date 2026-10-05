import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { exportTxtReport, type DiagnosticReportLike } from "@/lib/export-txt";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const pnl = (r: Row) => Number(r.net_pnl ?? r.gross_pnl ?? r.pnl ?? 0);

/* ============================================================
 * EXECUTION HEALTH DIAGNOSTIC TYPES
 * ============================================================ */

type ExecutionStatus = "ok" | "warning" | "critical";

type ExecutionHealth = {
  status: ExecutionStatus;
  buy_signals: number;
  eligible_buy_signals: number;
  risk_candidates: number | null;
  ai_risk_allowed: number | null;
  ai_risk_blocked: number | null;
  opened_trades: number;
  execution_audit_runs: number;
  execution_audit_coverage_pct: number;
  issue: string | null;
};

type Anomaly = {
  severity: "info" | "warning" | "critical";
  code: string;
  title: string;
  description: string;
};

type SuggestedAction = {
  priority: string;
  action: string;
  reason: string;
  evidence: string[];
};

const EXECUTION_WINDOW_HOURS = 24;
const EXECUTION_CONFIDENCE_THRESHOLD = 0.6;

export default function AIReport() {
  const [report, setReport] = useState<DiagnosticReportLike | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const started = Date.now();
    setLoading(true);
    setError(null);

    try {
      const since = new Date(Date.now() - 86_400_000).toISOString();

      const [open, closed, variants, errors] = await Promise.all([
        supabase
          .from("trades")
          .select("*")
          .eq("status", "open")
          .order("created_at", { ascending: false })
          .limit(200),
        supabase
          .from("trades")
          .select("*")
          .eq("status", "closed")
          .order("closed_at", { ascending: false })
          .limit(100),
        supabase
          .from("strategy_variant_signals")
          .select("*", { count: "exact" })
          .order("created_at", { ascending: false })
          .limit(2000),
        supabase
          .from("pipeline_runs")
          .select("created_at, error_message, status")
          .eq("status", "error")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(30),
      ]);

      if (open.error) throw open.error;
      if (closed.error) throw closed.error;

      const openTrades = (open.data ?? []) as Row[];
      const closedTrades = (closed.data ?? []) as Row[];
      const variantRows = (variants.data ?? []) as Row[];
      const pipelineErrors = (errors.data ?? []) as Row[];

      const wins = closedTrades.filter((r) => pnl(r) > 0);
      const losses = closedTrades.filter((r) => pnl(r) < 0);

      const realized = closedTrades.reduce((s, r) => s + pnl(r), 0);
      const unrealized = openTrades.reduce((s, r) => s + pnl(r), 0);
      const grossLoss = Math.abs(losses.reduce((s, r) => s + pnl(r), 0));

      const bySymbol = new Map<
        string,
        { symbol: string; open: number; resolved: number; total: number }
      >();
      for (const row of variantRows) {
        const symbol = String(row.symbol ?? "unknown");
        const item =
          bySymbol.get(symbol) ?? { symbol, open: 0, resolved: 0, total: 0 };
        item.total++;
        if (row.outcome === "open") item.open++;
        else item.resolved++;
        bySymbol.set(symbol, item);
      }

      const issues: string[] = pipelineErrors.length
        ? [`${pipelineErrors.length} pipeline errors in the last 24 hours`]
        : [];

      /* ============================================================
       * EXECUTION HEALTH DIAGNOSTIC
       * ============================================================ */

      const executionSince = new Date(
        Date.now() - EXECUTION_WINDOW_HOURS * 60 * 60 * 1000,
      ).toISOString();

      // 1. BUY signals
      const { data: recentSignals, error: signalsError } = await supabase
        .from("composite_signals")
        .select("id,symbol,recommendation,confidence,created_at")
        .eq("recommendation", "buy")
        .gte("created_at", executionSince)
        .order("created_at", { ascending: false });

      if (signalsError) {
        console.warn(
          "[AI_DIAGNOSTIC] execution signal query failed:",
          signalsError.message,
        );
      }

      const buySignals = (recentSignals ?? []) as Row[];
      const eligibleBuySignals = buySignals.filter(
        (s) => Number(s.confidence ?? 0) >= EXECUTION_CONFIDENCE_THRESHOLD,
      );

      // 2. Pipeline execution audits
      const { data: recentRuns, error: runsError } = await supabase
        .from("pipeline_runs")
        .select("id,started_at,status,result")
        .gte("started_at", executionSince)
        .order("started_at", { ascending: false })
        .limit(200);

      if (runsError) {
        console.warn(
          "[AI_DIAGNOSTIC] pipeline run query failed:",
          runsError.message,
        );
      }

      const runs = (recentRuns ?? []) as Row[];

      const auditedRuns = runs.filter(
        (run) =>
          run.result &&
          typeof run.result === "object" &&
          (run.result as Record<string, unknown>)["execution_audit"],
      );

      const executionAudits = auditedRuns
        .map((run) => ({
          run,
          audit: (run.result as Record<string, unknown>)["execution_audit"] as
            | Record<string, unknown>
            | undefined,
        }))
        .filter((x) => x.audit);

      const executionAuditCoveragePct =
        runs.length > 0
          ? Math.round((auditedRuns.length / runs.length) * 100)
          : 100;

      // 3. Aggregate audit information
      let riskCandidates = 0;
      let aiRiskAllowed = 0;
      let aiRiskBlocked = 0;
      let openedFromAudit = 0;

      for (const { audit } of executionAudits) {
        const summary = (audit?.["summary"] ?? {}) as Record<string, unknown>;
        riskCandidates += Number(summary["risk_candidates"] ?? 0);
        aiRiskAllowed += Number(summary["ai_risk_allowed"] ?? 0);
        aiRiskBlocked += Number(summary["ai_risk_blocked"] ?? 0);
        openedFromAudit += Number(summary["opened"] ?? 0);
      }

      // 4. Real trades opened in same period
      const { data: recentTrades, error: tradesError } = await supabase
        .from("trades")
        .select("id,symbol,status,opened_at,created_at")
        .gte("created_at", executionSince);

      if (tradesError) {
        console.warn("[AI_DIAGNOSTIC] trade query failed:", tradesError.message);
      }

      const openedTrades = ((recentTrades ?? []) as Row[]).filter(
        (trade) => trade.status === "open" || trade.opened_at != null,
      ).length;

      // 5. Determine execution health
      let executionStatus: ExecutionStatus = "ok";
      let executionIssue: string | null = null;

      if (eligibleBuySignals.length > 0 && executionAuditCoveragePct < 100) {
        executionStatus = "critical";
        executionIssue =
          "Eligible BUY signals exist but execution audit coverage is incomplete.";
      } else if (
        eligibleBuySignals.length > 0 &&
        openedTrades === 0 &&
        openedFromAudit === 0
      ) {
        executionStatus = "warning";
        executionIssue =
          "Eligible BUY signals exist but no paper trade was opened. Check AI Risk, execution gates and trade INSERT.";
      } else if (
        aiRiskAllowed > 0 &&
        openedTrades === 0 &&
        openedFromAudit === 0
      ) {
        executionStatus = "critical";
        executionIssue =
          "AI Risk allowed one or more signals but execution opened zero trades.";
      }

      // 6. Build execution health object
      const executionHealth: ExecutionHealth = {
        status: executionStatus,
        buy_signals: buySignals.length,
        eligible_buy_signals: eligibleBuySignals.length,
        risk_candidates: executionAudits.length > 0 ? riskCandidates : null,
        ai_risk_allowed: executionAudits.length > 0 ? aiRiskAllowed : null,
        ai_risk_blocked: executionAudits.length > 0 ? aiRiskBlocked : null,
        opened_trades: openedTrades,
        execution_audit_runs: auditedRuns.length,
        execution_audit_coverage_pct: executionAuditCoveragePct,
        issue: executionIssue,
      };

      console.log(
        "[AI_DIAGNOSTIC_EXECUTION]",
        JSON.stringify(executionHealth),
      );

      /* ============================================================
       * OVERALL HEALTH (με execution subsystem)
       * ============================================================ */

      const databaseStatus: ExecutionStatus = "ok";
      const pipelineStatus: ExecutionStatus = issues.length ? "warning" : "ok";

      const subsystemStatuses: ExecutionStatus[] = [
        databaseStatus,
        pipelineStatus,
        executionHealth.status,
      ];

      const overall: ExecutionStatus = subsystemStatuses.includes("critical")
        ? "critical"
        : subsystemStatuses.includes("warning")
          ? "warning"
          : "ok";

      const overallScore =
        overall === "critical" ? 40 : overall === "warning" ? 70 : 100;

      /* ============================================================
       * ANOMALIES
       * ============================================================ */

      const anomalies: Anomaly[] = [];

      if (executionHealth.status === "critical") {
        anomalies.push({
          severity: "critical",
          code: "EXECUTION_AUDIT_OR_EXECUTION_FAILURE",
          title: "Execution path requires investigation",
          description:
            executionHealth.issue ??
            "Execution diagnostics detected an inconsistency.",
        });
      }

      if (executionHealth.status === "warning") {
        anomalies.push({
          severity: "warning",
          code: "ELIGIBLE_BUY_WITH_ZERO_TRADES",
          title: "Eligible BUY signals were not executed",
          description:
            `${executionHealth.eligible_buy_signals} BUY signals reached ` +
            `confidence >= ${EXECUTION_CONFIDENCE_THRESHOLD}, but ` +
            `no paper trade was opened.`,
        });
      }

      /* ============================================================
       * SUGGESTED ACTIONS
       * ============================================================ */

      const suggestedActions: SuggestedAction[] = [];

      for (const issue of issues) {
        suggestedActions.push({
          priority: "P0",
          action: "Review pipeline errors",
          reason: issue,
          evidence: pipelineErrors
            .slice(0, 3)
            .map((r) =>
              String(
                (r as Record<string, unknown>)["error_message"] ??
                  (r as Record<string, unknown>)["status"] ??
                  "error",
              ),
            ),
        });
      }

      if (executionHealth.status !== "ok") {
        suggestedActions.push({
          priority: executionHealth.status === "critical" ? "P0" : "P1",
          action: "Inspect execution audit",
          reason:
            executionHealth.issue ??
            "Execution diagnostics flagged an issue.",
          evidence: [
            `eligible=${executionHealth.eligible_buy_signals}`,
            `opened=${executionHealth.opened_trades}`,
            `audit_coverage=${executionHealth.execution_audit_coverage_pct}%`,
          ],
        });
      }

      /* ============================================================
       * BUILD REPORT
       * ============================================================ */

      const reportRecord: Record<string, unknown> = {
        schema_version: "1.1",
        generated_at: new Date().toISOString(),
        duration_ms: Date.now() - started,

        health: {
          overall,
          score: overallScore,
          issues,

          subsystems: {
            database: {
              status: databaseStatus,
              note: `${openTrades.length} open trades loaded`,
            },
            pipeline: {
              status: pipelineStatus,
              note: `${pipelineErrors.length} recent errors`,
            },
            execution: {
              status: executionHealth.status,
              note:
                executionHealth.issue ??
                `${executionHealth.eligible_buy_signals} eligible BUY signals, ` +
                  `${executionHealth.opened_trades} trades opened`,
              metrics: executionHealth,
            },
          },
        },

        answers: {
          summary: {
            q: "What is the current system status?",
            a:
              executionHealth.eligible_buy_signals > 0 &&
              executionHealth.opened_trades === 0
                ? `System infrastructure is operational, but ` +
                  `${executionHealth.eligible_buy_signals} eligible BUY ` +
                  `signals were detected and 0 trades were opened. ` +
                  `Execution requires investigation.`
                : `${openTrades.length} open trades, ` +
                  `${closedTrades.length} closed trades, ` +
                  `${variantRows.length} recent variants.`,
            confidence: "high",
          },
          execution: {
            q: "Are eligible BUY signals being executed?",
            a:
              `${executionHealth.eligible_buy_signals} eligible BUY signals; ` +
              `${executionHealth.opened_trades} trades opened; ` +
              `audit coverage ${executionHealth.execution_audit_coverage_pct}%.`,
            confidence:
              executionHealth.execution_audit_coverage_pct === 100
                ? "high"
                : "medium",
          },
        },

        anomalies,

        data: {
          trades: {
            open_count: openTrades.length,
            closed_count: closedTrades.length,
            open: openTrades,
            recent_closed: closedTrades,
          },
          portfolio: {
            realized_pnl: +realized.toFixed(2),
            unrealized_pnl: +unrealized.toFixed(2),
            closed_count: closedTrades.length,
            win_count: wins.length,
            loss_count: losses.length,
            win_rate_pct: closedTrades.length
              ? +((wins.length / closedTrades.length) * 100).toFixed(2)
              : 0,
            profit_factor: grossLoss
              ? +(
                  wins.reduce((s, r) => s + pnl(r), 0) / grossLoss
                ).toFixed(3)
              : null,
          },
          variants: {
            open_count: variantRows.filter((r) => r.outcome === "open").length,
            total_count: variants.count ?? variantRows.length,
            resolved_count: variantRows.filter((r) => r.outcome !== "open")
              .length,
            by_symbol_top: [...bySymbol.values()]
              .sort((a, b) => b.total - a.total)
              .slice(0, 20),
          },
          pipeline: { recent_errors: pipelineErrors },
          symbols: { watched: [], blacklisted: [], with_live_price: [] },
        },

        suggested_actions: suggestedActions,

        narrative_md: "",

        ai_context: `
Trading Command Center diagnostic

Health: ${overall}
Realized PnL: ${realized.toFixed(2)}
Unrealized PnL: ${unrealized.toFixed(2)}

EXECUTION HEALTH
Status: ${executionHealth.status}
BUY signals: ${executionHealth.buy_signals}
Eligible BUY >= 60%: ${executionHealth.eligible_buy_signals}
Risk candidates: ${executionHealth.risk_candidates ?? "unknown"}
AI Risk allowed: ${executionHealth.ai_risk_allowed ?? "unknown"}
AI Risk blocked: ${executionHealth.ai_risk_blocked ?? "unknown"}
Trades opened: ${executionHealth.opened_trades}
Execution audit coverage: ${executionHealth.execution_audit_coverage_pct}%

Execution issue:
${executionHealth.issue ?? "none"}

Interpretation:
Do NOT report the system as fully healthy merely because the pipeline
and database are operational. If eligible BUY signals exist but zero
trades opened, explicitly identify this as an execution-path issue and
recommend inspecting the execution audit.
`,
      };

      setReport(reportRecord as unknown as DiagnosticReportLike);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDownload = useCallback(() => {
    if (!report) return;
    try {
      exportTxtReport(report);
    } catch (e) {
      console.error("[AIReport] exportTxtReport failed:", e);
    }
  }, [report]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Trading Command Center</h1>
        <h2 className="text-xl font-medium">AI diagnostic report</h2>
        <p className="text-sm text-muted-foreground">
          Operational snapshot with portfolio, variants, errors, and raw JSON.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded border px-3 py-1 text-sm"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={!report}
            className="rounded border px-3 py-1 text-sm"
          >
            Download .txt
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-800">
          Unable to load report: {error}
        </div>
      )}

      {loading && !report && (
        <div className="text-sm text-muted-foreground">
          Loading diagnostic data…
        </div>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {(
              [
                ["Health", report.health?.overall],
                ["Score", `${report.health?.score ?? 0}/100`],
                ["Open trades", report.data?.trades?.open_count ?? 0],
                [
                  "Realized PnL",
                  `$${report.data?.portfolio?.["realized_pnl"] ?? 0}`,
                ],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded border p-3">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="text-lg font-semibold">{String(value)}</div>
              </div>
            ))}
          </div>

          <section className="space-y-2">
            <h3 className="text-lg font-medium">System findings</h3>
            {report.health?.issues?.length ? (
              <ul className="list-disc pl-5 text-sm">
                {report.health.issues.map((issue: string, i: number) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            ) : (
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                <li>No current issues detected.</li>
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-medium">AI context</h3>
            <pre className="whitespace-pre-wrap rounded border bg-muted/30 p-3 text-xs">
              {report.ai_context}
            </pre>
          </section>

          <details className="rounded border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              View full JSON report
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs">
              {JSON.stringify(report, null, 2)}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}

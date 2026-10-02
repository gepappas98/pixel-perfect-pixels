export interface DiagnosticReportLike {
  schema_version?: string;
  generated_at?: string;
  duration_ms?: number;
  health?: { overall?: string; score?: number; issues?: string[]; subsystems?: Record<string, { status: string; note: string }> };
  answers?: Record<string, { q: string; a: string; confidence: string }>;
  anomalies?: Array<Record<string, unknown>>;
  data?: { trades?: { open_count: number; closed_count: number; open: unknown[]; recent_closed: unknown[] }; portfolio?: Record<string, unknown> | null; variants?: { open_count: number; total_count: number; resolved_count?: number; by_symbol_top: unknown[] }; pipeline?: { recent_errors: unknown[] }; symbols?: { watched: string[]; blacklisted: string[]; with_live_price: unknown[] } };
  suggested_actions?: Array<{ priority: string; action: string; reason: string; evidence: string[] }>;
  narrative_md?: string;
  ai_context?: string;
}

const line = (char = "=") => char.repeat(78);
const money = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${value >= 0 ? "+" : ""}$${value.toFixed(2)}` : "n/a";
const date = (value: unknown) => value ? new Date(String(value)).toISOString().replace("T", " ").replace("Z", " UTC") : "-";

function buildContent(report: DiagnosticReportLike, aiAnalysis?: string | null) {
  const data = report.data ?? {};
  const trades = data.trades ?? { open_count: 0, closed_count: 0, open: [], recent_closed: [] };
  const portfolio = data.portfolio;
  const variants = data.variants ?? { open_count: 0, total_count: 0, by_symbol_top: [] };
  const pipeline = data.pipeline ?? { recent_errors: [] };
  const sections = [
    line(), "TRADING COMMAND CENTER — FULL DIAGNOSTIC EXPORT", line(),
    `Generated: ${report.generated_at ?? "-"}`, `Duration: ${report.duration_ms ?? "-"}ms`, `Health: ${(report.health?.overall ?? "unknown").toUpperCase()} (${report.health?.score ?? "-"}/100)`,
    `AI analysis: ${aiAnalysis ? `included (${aiAnalysis.length} chars)` : "not included"}`,
    "", line(), "1. EXECUTIVE SUMMARY", line(),
    `Open trades: ${trades.open_count}`, `Closed trades: ${trades.closed_count}`, `Realized PnL: ${money(portfolio?.["realized_pnl"])}`, `Unrealized PnL: ${money(portfolio?.["unrealized_pnl"])}`,
    `Win rate: ${portfolio?.["win_rate_pct"] ?? "n/a"}%`, `Profit factor: ${portfolio?.["profit_factor"] ?? "n/a"}`, `Open variants: ${variants.open_count}`, `Resolved variants: ${variants.resolved_count ?? "n/a"}`, `Total variants: ${variants.total_count}`,
    `Pipeline errors (24h): ${pipeline.recent_errors.length}`, `Anomalies: ${(report.anomalies ?? []).length}`,
    "", line(), "2. SUBSYSTEM HEALTH", line(), ...Object.entries(report.health?.subsystems ?? {}).map(([key, value]) => `[${value.status.toUpperCase()}] ${key}: ${value.note}`),
    "", line(), "3. ANSWERS", line(), ...Object.values(report.answers ?? {}).flatMap((answer) => [`Q: ${answer.q}`, `Answer: ${answer.a}`, `Confidence: ${answer.confidence}`, ""]),
    line(), "4. AI ANALYSIS", line(), aiAnalysis || "[No AI analysis run yet.]",
    "", line(), "5. ANOMALIES", line(), ...(report.anomalies?.length ? report.anomalies.map((item) => JSON.stringify(item)) : ["No anomalies detected."]),
    "", line(), "6. SUGGESTED ACTIONS", line(), ...(report.suggested_actions?.length ? report.suggested_actions.flatMap((item) => [`[${item.priority}] ${item.action}`, `Reason: ${item.reason}`, ...item.evidence.map((e) => `- ${e}`), ""]) : ["No suggested actions."]),
    "", line(), "7. OPEN TRADES", line(), ...(trades.open.length ? trades.open.map((item) => JSON.stringify(item)) : ["No open trades."]),
    "", line(), "8. RECENT CLOSED TRADES", line(), ...(trades.recent_closed.length ? trades.recent_closed.map((item) => JSON.stringify(item)) : ["No recent closed trades."]),
    "", line(), "9. PIPELINE ERRORS (24H)", line(), ...(pipeline.recent_errors.length ? pipeline.recent_errors.map((item) => `${date((item as Record<string, unknown>)["created_at"])} ${JSON.stringify(item)}`) : ["No pipeline errors in the last 24 hours."]),
    "", line(), "10. RAW JSON REPORT", line(), JSON.stringify(report, null, 2), "", line(), "END OF REPORT", line(),
  ];
  return sections.join("\n");
}

export function exportTxtReport(report: DiagnosticReportLike, aiAnalysis?: string | null) {
  const blob = new Blob([buildContent(report, aiAnalysis)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `trading-diagnostic-${new Date(report.generated_at ?? Date.now()).toISOString().replace(/[:.]/g, "-").slice(0, 19)}.txt`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatReportDate(value: unknown) { return date(value); }

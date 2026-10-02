"use client";

import { useEffect, useState } from "react";

export default function AIReportPage() {
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"md" | "ai" | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/diagnostic/ai-report", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReport(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function copy(text: string, which: "md" | "ai") {
    await navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">AI Report</h1>
            <p className="text-sm text-slate-400">
              Έτοιμο για paste σε ChatGPT/Claude · {report?.duration_ms ?? "—"}ms
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </header>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-200 text-sm">
            {error}
          </div>
        )}

        {report && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat
                label="Health"
                value={report.health.overall}
                tone={
                  report.health.overall === "ok"
                    ? "good"
                    : report.health.overall === "degraded"
                      ? "warn"
                      : "bad"
                }
              />
              <Stat label="Score" value={`${report.health.score}/100`} />
              <Stat
                label="Anomalies"
                value={report.anomalies.length}
                tone={report.anomalies.length > 0 ? "bad" : "good"}
              />
              <Stat
                label="Actions"
                value={report.suggested_actions.length}
                tone={report.suggested_actions.length > 0 ? "warn" : "good"}
              />
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold">Full Report (Markdown)</div>
                  <button
                    onClick={() => copy(report.narrative_md, "md")}
                    className="text-xs rounded bg-slate-800 hover:bg-slate-700 px-2 py-1"
                  >
                    {copied === "md" ? "✓ Copied" : "Copy"}
                  </button>
                </div>
                <pre className="text-xs bg-slate-950 rounded p-3 max-h-96 overflow-auto whitespace-pre-wrap">
                  {report.narrative_md.slice(0, 3000)}
                  {report.narrative_md.length > 3000 ? "\n…" : ""}
                </pre>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold">Compact Context (for LLM)</div>
                  <button
                    onClick={() => copy(report.ai_context, "ai")}
                    className="text-xs rounded bg-slate-800 hover:bg-slate-700 px-2 py-1"
                  >
                    {copied === "ai" ? "✓ Copied" : "Copy"}
                  </button>
                </div>
                <pre className="text-xs bg-slate-950 rounded p-3 max-h-96 overflow-auto whitespace-pre-wrap">
                  {report.ai_context}
                </pre>
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
              <div className="text-sm font-semibold mb-2">Quick links</div>
              <div className="flex flex-wrap gap-2 text-xs font-mono">
                <a
                  href="/api/diagnostic/ai-report"
                  target="_blank"
                  className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1"
                >
                  JSON
                </a>
                <a
                  href="/api/diagnostic/ai-report?format=markdown"
                  target="_blank"
                  className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1"
                >
                  Markdown
                </a>
                <a
                  href="/api/diagnostic/ai-report?format=ai"
                  target="_blank"
                  className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1"
                >
                  Plain text (LLM)
                </a>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneCls =
    tone === "good"
      ? "text-emerald-400"
      : tone === "bad"
        ? "text-red-400"
        : tone === "warn"
          ? "text-amber-400"
          : "text-slate-100";
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className={`mt-1 text-xl font-semibold ${toneCls}`}>{value}</div>
    </div>
  );
}

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
      const res = await fetch("/api/diagnostic/ai-report", { cache: "no-store" });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      setReport(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

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
          <div className="flex gap-2">
            <a
              href="/api/diagnostic/ai-report?debug"
              target="_blank"
              className="rounded bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-sm"
            >
              Debug
            </a>
            <button
              onClick={load}
              disabled={loading}
              className="rounded bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </header>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-200 text-sm">
            <strong>Fetch error:</strong>
            <pre className="mt-2 text-xs whitespace-pre-wrap">{error}</pre>
            <p className="mt-2 text-xs text-red-300">
              Δοκίμασε: <a href="/api/diagnostic/ai-report?debug" target="_blank" className="underline">/api/diagnostic/ai-report?debug</a>
            </p>
          </div>
        )}

        {!report && loading && (
          <div className="text-slate-400 text-sm">Φόρτωση…</div>
        )}

        {report && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Health" value={report.health?.overall ?? "—"}
                tone={report.health?.overall === "ok" ? "good" : report.health?.overall === "degraded" ? "warn" : "bad"} />
              <Stat label="Score" value={`${report.health?.score ?? 0}/100`} />
              <Stat label="Anomalies" value={report.anomalies?.length ?? 0}
                tone={(report.anomalies?.length ?? 0) > 0 ? "bad" : "good"} />
              <Stat label="Actions" value={report.suggested_actions?.length ?? 0}
                tone={(report.suggested_actions?.length ?? 0) > 0 ? "warn" : "good"} />
            </div>

            {report.__debug && (
              <details className="rounded-lg border border-slate-700 bg-slate-900/60 p-4">
                <summary className="text-sm cursor-pointer">Debug info</summary>
                <pre className="mt-2 text-xs overflow-auto">
                  {JSON.stringify(report.__debug, null, 2)}
                </pre>
              </details>
            )}

            <div className="grid md:grid-cols-2 gap-4">
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold">Markdown</div>
                  <button onClick={() => copy(report.narrative_md ?? "", "md")}
                    className="text-xs rounded bg-slate-800 hover:bg-slate-700 px-2 py-1">
                    {copied === "md" ? "✓ Copied" : "Copy"}
                  </button>
                </div>
                <pre className="text-xs bg-slate-950 rounded p-3 max-h-96 overflow-auto whitespace-pre-wrap">
                  {(report.narrative_md ?? "").slice(0, 3000)}
                  {(report.narrative_md ?? "").length > 3000 ? "\n…" : ""}
                </pre>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold">Compact (LLM)</div>
                  <button onClick={() => copy(report.ai_context ?? "", "ai")}
                    className="text-xs rounded bg-slate-800 hover:bg-slate-700 px-2 py-1">
                    {copied === "ai" ? "✓ Copied" : "Copy"}
                  </button>
                </div>
                <pre className="text-xs bg-slate-950 rounded p-3 max-h-96 overflow-auto whitespace-pre-wrap">
                  {report.ai_context}
                </pre>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value, tone = "default" }: {
  label: string; value: string | number;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const cls = tone === "good" ? "text-emerald-400"
    : tone === "bad" ? "text-red-400"
    : tone === "warn" ? "text-amber-400"
    : "text-slate-100";
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import {
  CATEGORY_LABELS,
  auditAgeHours,
  groupFindings,
  isAuditStale,
  type AuditReport,
} from "@/lib/audit-report";
import {
  listAuditReports,
  refreshAuditSnapshot,
  saveAuditSnapshot,
} from "@/lib/audit-report.functions";

export interface AuditReportViewProps {
  loading: boolean;
  error: string | null;
  reports: AuditReport[];
  draft: AuditReport | null;
  busy?: boolean;
  now?: number;
  onRefresh?: () => void;
  onSave?: () => void;
}

function ReportCard({ r, now }: { r: AuditReport; now: number }) {
  const stale = isAuditStale(r.checked_at, now);
  const age = auditAgeHours(r.checked_at, now);
  return (
    <div className="space-y-2 rounded border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{r.title}</span>
        <span className="rounded border px-1.5 text-xs uppercase">{r.severity}</span>
        {stale && (
          <span className="rounded border border-destructive px-1.5 text-xs text-destructive">
            STALE · {Math.floor(age)}h old — refresh to confirm current state
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        Checked at {new Date(r.checked_at).toISOString().replace("T", " ").slice(0, 19)} UTC · {r.source}
        {r.window_label ? ` · window ${r.window_label}` : ""}
      </div>
      <p className="text-sm">{r.summary}</p>
      {groupFindings(r.findings ?? []).map((g) => (
        <div key={g.category}>
          <div className="text-sm font-medium">{CATEGORY_LABELS[g.category]}</div>
          <ul className="list-disc pl-5 text-sm">
            {g.items.map((f, i) => (
              <li key={i}>
                <span className="font-medium">{f.title}:</span> {f.detail}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function AuditReportView({ loading, error, reports, draft, busy, now = Date.now(), onRefresh, onSave }: AuditReportViewProps) {
  const [latest, ...history] = reports;
  return (
    <section className="space-y-3" aria-label="Runtime / Research Integrity Audit">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-medium">Runtime / Research Integrity Audit</h3>
        <div className="flex gap-2">
          <button type="button" className="rounded border px-3 py-1 text-sm" disabled={busy} onClick={onRefresh}>
            Refresh (read-only)
          </button>
          <button type="button" className="rounded border px-3 py-1 text-sm" disabled={busy || !draft} onClick={onSave}>
            Save snapshot
          </button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Observed facts at audit time, not proof of data corruption. Stored snapshots are not current state.
      </p>
      {error && <div role="alert" className="rounded border border-destructive p-2 text-sm text-destructive">Audit error: {error}</div>}
      {draft && (
        <div>
          <div className="mb-1 text-xs font-medium">Unsaved refresh</div>
          <ReportCard r={draft} now={now} />
        </div>
      )}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading audits…</div>
      ) : !latest ? (
        !error && <div className="text-sm text-muted-foreground">No audit reports saved yet.</div>
      ) : (
        <>
          <div className="text-xs font-medium">Latest saved audit</div>
          <ReportCard r={latest} now={now} />
          {history.length > 0 && (
            <details className="rounded border p-3">
              <summary className="cursor-pointer text-sm font-medium">Audit history ({history.length})</summary>
              <div className="mt-2 space-y-2">
                {history.map((r) => (
                  <ReportCard key={r.id ?? r.checked_at} r={r} now={now} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

export default function AuditReportPanel() {
  const [reports, setReports] = useState<AuditReport[]>([]);
  const [draft, setDraft] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReports(await listAuditReports());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuditReportView
      loading={loading}
      error={error}
      reports={reports}
      draft={draft}
      busy={busy}
      onRefresh={() => run(async () => setDraft(await refreshAuditSnapshot()))}
      onSave={() =>
        run(async () => {
          if (!draft) return;
          await saveAuditSnapshot({ data: draft });
          setDraft(null);
          await load();
        })
      }
    />
  );
}

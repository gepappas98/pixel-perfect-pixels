CREATE TABLE IF NOT EXISTS public.system_audit_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  title text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  status text NOT NULL DEFAULT 'snapshot',
  summary text NOT NULL DEFAULT '',
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL DEFAULT 'manual',
  window_label text,
  CONSTRAINT system_audit_reports_severity_chk CHECK (severity IN ('info','warning','critical')),
  CONSTRAINT system_audit_reports_findings_array_chk CHECK (jsonb_typeof(findings) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_system_audit_reports_checked_at
  ON public.system_audit_reports (checked_at DESC);

REVOKE ALL ON public.system_audit_reports FROM anon, authenticated;
GRANT SELECT ON public.system_audit_reports TO anon, authenticated;
GRANT SELECT, INSERT ON public.system_audit_reports TO service_role;

ALTER TABLE public.system_audit_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit reports readable" ON public.system_audit_reports;
CREATE POLICY "audit reports readable" ON public.system_audit_reports
  FOR SELECT TO anon, authenticated USING (true);

CREATE OR REPLACE FUNCTION public.system_audit_reports_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'system_audit_reports is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_system_audit_reports_append_only ON public.system_audit_reports;
CREATE TRIGGER trg_system_audit_reports_append_only
  BEFORE UPDATE OR DELETE ON public.system_audit_reports
  FOR EACH ROW EXECUTE FUNCTION public.system_audit_reports_block_mutation();

INSERT INTO public.system_audit_reports
  (id, created_at, checked_at, title, severity, status, summary, findings, source, window_label)
VALUES (
  '6b1f0c3e-1a7d-4c2e-9e51-20261017a001',
  '2026-10-17T15:32:00Z', '2026-10-17T15:32:00Z',
  'Runtime / Research Integrity Audit — initial snapshot',
  'warning', 'historical_snapshot',
  'Snapshot of findings observed during the live read-only audit on 17 Oct 2026 (UTC). These are observed facts at audit time, not proof of data corruption, and NOT a statement of current state — run a new refresh to confirm current status.',
  $json$[
    {"category":"confirmed_bug","title":"Watchdog: cachedPairs is not defined","detail":"127 HTTP 500 executions 12:34–14:40 UTC. Later version 6 ran successfully and the alert cleared; 14 open paper positions observed at 15:32 UTC."},
    {"category":"confirmed_bug","title":"capture-accumulation-shadow SQL timeouts","detail":"2 statement timeouts (06:00 and 13:30 UTC)."},
    {"category":"confirmed_bug","title":"cmc-macro-sync data retrieval failure","detail":"One all_cmc_sources_unavailable failure despite HTTP 200."},
    {"category":"needs_recheck","title":"Pipeline status hides stage failures","detail":"Last-24h sample: 144 completed runs, zero non-completed, but stage-level failures were hidden by the completed status."},
    {"category":"needs_recheck","title":"tradingview-signals partial task failures","detail":"Partial task failures on most runs (about one rejected task per run) while the stage reported ok."},
    {"category":"needs_recheck","title":"Storage watchdog cron inactive","detail":"Storage about 290 MB, under the 480 MB alert threshold, but the storage-capacity-watchdog cron was inactive."},
    {"category":"research_comparability","title":"V2 variants share one BUY cohort","detail":"smc-reversal, volatility-timing, vwap-momentum: each 6,255 rows on the same symbol-sample BUY cohort; not independent entry-selection experiments."},
    {"category":"research_comparability","title":"Variant resolver settle asymmetry","detail":"42 matched samples had one variant settled while another stayed open; no settled-to-settled outcome mismatch in examined comparisons."},
    {"category":"research_comparability","title":"Different paper TP targets","detail":"standard and early_entry_regime use TP +6%; cmc_paper/event_flow_paper and V2 benchmark use +4%. Returns are not directly comparable."},
    {"category":"research_comparability","title":"Small closed-trade sample","detail":"42 closed paper trades: 10 profitable, 32 unprofitable, realized PnL −$623.81. Small recent sample, not proof of edge."},
    {"category":"verified_ok","title":"No orphan references / duplicate open symbols","detail":"No orphan references in examined trade→signal/indicator/council relationships; no duplicate open paper symbols in the inspected query."}
  ]$json$::jsonb,
  'live read-only audit (chat)', '2026-10-16T15:32Z → 2026-10-17T15:32Z (last 24h)'
)
ON CONFLICT (id) DO NOTHING;
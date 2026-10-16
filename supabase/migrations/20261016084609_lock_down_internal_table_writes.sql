-- Restrict internal pipeline and risk telemetry writes to trusted server-side roles.
-- Browser clients keep existing SELECT access where already permitted.
-- All canonical writers use service_role; no client-side writer is required for these tables.

BEGIN;

-- These policies were created for convenience during initial setup but expose
-- internal control-plane and research state to arbitrary API clients.
DROP POLICY IF EXISTS pipeline_settings_update ON public.pipeline_settings;
DROP POLICY IF EXISTS pipeline_runs_insert ON public.pipeline_runs;
DROP POLICY IF EXISTS pipeline_runs_update ON public.pipeline_runs;
DROP POLICY IF EXISTS council_lessons_insert ON public.council_lessons;
DROP POLICY IF EXISTS equity_snapshots_write ON public.equity_snapshots;
DROP POLICY IF EXISTS global_risk_events_write ON public.global_risk_events;

-- RLS alone is not a substitute for SQL privileges. Keep SELECT grants intact,
-- but remove all browser-role mutation privileges on these internal tables.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.pipeline_settings, public.pipeline_runs, public.council_lessons,
           public.equity_snapshots, public.global_risk_events
  FROM anon, authenticated;

COMMIT;

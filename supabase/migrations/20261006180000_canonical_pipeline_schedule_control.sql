-- Canonicalize the schedule control onto the active trading pipeline orchestrator.
-- The previous function targeted the retired /api/public/cron path.
CREATE OR REPLACE FUNCTION public.set_pipeline_schedule(_minutes int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, cron AS $fn$
BEGIN
  IF _minutes NOT IN (0, 2, 5, 10) THEN RAISE EXCEPTION 'Invalid interval'; END IF;

  IF _minutes = 0 THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'trading-pipeline-orchestrator') THEN
      PERFORM cron.unschedule('trading-pipeline-orchestrator');
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'trading-pipeline-orchestrator') THEN
      PERFORM cron.alter_job(
        job_id := (SELECT jobid FROM cron.job WHERE jobname = 'trading-pipeline-orchestrator'),
        schedule := '*/' || _minutes || ' * * * *'
      );
    ELSE
      PERFORM cron.schedule(
        'trading-pipeline-orchestrator',
        '*/' || _minutes || ' * * * *',
        $job$SELECT net.http_post(
          url := 'https://yckewtpfttvwiptmmrfq.supabase.co/functions/v1/trading-pipeline-orchestrator',
          headers := '{"Content-Type":"application/json"}'::jsonb,
          body := '{}'::jsonb,
          timeout_milliseconds := 720000
        );$job$
      );
    END IF;
  END IF;

  UPDATE public.pipeline_settings
  SET interval_minutes = _minutes, updated_at = now()
  WHERE id = 1;

  RETURN _minutes;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.set_pipeline_schedule(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_pipeline_schedule(int) TO service_role;
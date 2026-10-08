-- P1.4: expose canonical trigger/source metadata and compute next scheduled run
-- from scheduled runs rather than a manual run that happens to be newest.
-- No pipeline behavior, strategy, thresholds, or historical rows are changed.

CREATE OR REPLACE FUNCTION public.get_pipeline_cron_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_interval integer := 10;
  v_latest jsonb;
  v_last_success jsonb;
  v_latest_started timestamptz;
  v_latest_status text;
  v_last_success_at timestamptz;
  v_latest_scheduled_started timestamptz;
  v_next_run_at timestamptz;
  v_failures integer := 0;
  v_stale_after integer;
  v_status text;
  v_recent_errors jsonb := '[]'::jsonb;
BEGIN
  SELECT COALESCE(interval_minutes, 10) INTO v_interval
  FROM public.pipeline_settings WHERE id = 1 LIMIT 1;
  IF v_interval IS NULL OR v_interval <= 0 THEN v_interval := 10; END IF;

  SELECT jsonb_build_object(
    'id', r.id::text, 'job_name', r.job_name, 'status', r.status,
    'started_at', r.started_at, 'completed_at', r.completed_at,
    'duration_ms', r.duration_ms, 'error_message', r.error_message,
    'trigger', COALESCE(r.result->>'trigger', 'unknown'),
    'source', COALESCE(r.result->>'source', 'unknown')
  ), r.started_at, r.status
  INTO v_latest, v_latest_started, v_latest_status
  FROM public.pipeline_runs r ORDER BY r.started_at DESC LIMIT 1;

  SELECT jsonb_build_object(
    'id', r.id::text, 'job_name', r.job_name, 'status', r.status,
    'started_at', r.started_at, 'completed_at', r.completed_at,
    'duration_ms', r.duration_ms,
    'trigger', COALESCE(r.result->>'trigger', 'unknown'),
    'source', COALESCE(r.result->>'source', 'unknown')
  ), r.completed_at
  INTO v_last_success, v_last_success_at
  FROM public.pipeline_runs r
  WHERE r.status IN ('success', 'completed') AND r.completed_at IS NOT NULL
  ORDER BY r.completed_at DESC LIMIT 1;

  v_stale_after := GREATEST(v_interval * 2, 30);

  IF v_latest_status = 'running'
     AND v_latest_started IS NOT NULL
     AND now() - v_latest_started <= make_interval(mins => v_stale_after) THEN
    v_status := 'RUNNING';
  ELSIF v_last_success_at IS NULL
     OR now() - v_last_success_at > make_interval(mins => v_stale_after) THEN
    v_status := 'STALE';
  ELSIF v_latest_status IN ('error', 'failed')
     AND (v_latest_started IS NULL OR v_latest_started >= v_last_success_at) THEN
    v_status := 'FAILED';
  ELSE
    v_status := 'HEALTHY';
  END IF;

  SELECT COUNT(*) INTO v_failures
  FROM public.pipeline_runs r
  WHERE r.status IN ('error', 'failed')
    AND r.started_at > COALESCE(
      (SELECT MAX(s.completed_at) FROM public.pipeline_runs s
       WHERE s.status IN ('success', 'completed') AND s.completed_at IS NOT NULL),
      '-infinity'::timestamptz
    );

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id::text, 'started_at', e.started_at, 'completed_at', e.completed_at,
    'message', COALESCE(e.error_message, 'Unknown pipeline error')
  ) ORDER BY e.started_at DESC), '[]'::jsonb)
  INTO v_recent_errors
  FROM (
    SELECT id, started_at, completed_at, error_message
    FROM public.pipeline_runs
    WHERE status IN ('error', 'failed') AND error_message IS NOT NULL
    ORDER BY started_at DESC LIMIT 5
  ) e;

  SELECT r.started_at INTO v_latest_scheduled_started
  FROM public.pipeline_runs r
  WHERE COALESCE(r.result->>'trigger', 'scheduled') = 'scheduled'
  ORDER BY r.started_at DESC LIMIT 1;

  IF v_latest_scheduled_started IS NOT NULL THEN
    v_next_run_at := date_trunc('minute', v_latest_scheduled_started)
      + make_interval(mins => v_interval);
    WHILE v_next_run_at <= now() LOOP
      v_next_run_at := v_next_run_at + make_interval(mins => v_interval);
    END LOOP;
  ELSIF v_latest_started IS NOT NULL THEN
    v_next_run_at := date_trunc('minute', v_latest_started)
      + make_interval(mins => v_interval);
    WHILE v_next_run_at <= now() LOOP
      v_next_run_at := v_next_run_at + make_interval(mins => v_interval);
    END LOOP;
  ELSE
    v_next_run_at := date_trunc('minute', now()) + make_interval(mins => v_interval);
  END IF;

  RETURN jsonb_build_object(
    'available', true, 'status', v_status, 'intervalMinutes', v_interval,
    'schedule', 'every ' || v_interval || ' minutes', 'latestRun', v_latest,
    'lastSuccess', v_last_success, 'lastSuccessAt', v_last_success_at,
    'nextRunAt', v_next_run_at, 'consecutiveFailures', v_failures,
    'stale', v_status = 'STALE', 'staleAfterMinutes', v_stale_after,
    'recentErrors', v_recent_errors
  );
END;
$$;

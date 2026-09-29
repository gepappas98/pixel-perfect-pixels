/*
  Pipeline Cron Health
  --------------------
  - pipeline_runs.variants_resolved
  - stuck "running" rows
  - get_pipeline_cron_health() RPC
  - correct consecutive failure calculation
  - correct next scheduled run calculation
  - pg_cron job monitoring
  - safe SECURITY DEFINER execution
*/

ALTER TABLE public.pipeline_runs
ADD COLUMN IF NOT EXISTS variants_resolved integer NOT NULL DEFAULT 0;

UPDATE public.pipeline_runs
SET
  status = 'error',
  error_message = COALESCE(
    error_message,
    'Marked as error during pipeline health migration'
  ),
  completed_at = COALESCE(completed_at, now())
WHERE status = 'running';

CREATE OR REPLACE FUNCTION public.get_pipeline_cron_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, pg_temp
AS $$
DECLARE
  v_interval integer := 10;
  v_schedule text := '*/10 * * * *';
  v_last_success_at timestamptz;
  v_last_success_status text := 'succeeded';
  v_last_run_at timestamptz;
  v_next_run_at timestamptz;
  v_failures integer := 0;
  v_recent_errors jsonb := '[]'::jsonb;
  v_jobs jsonb := '[]'::jsonb;
  v_pipeline_job_id bigint;
BEGIN
  BEGIN
    SELECT COALESCE(interval_minutes, 10)
    INTO v_interval
    FROM public.pipeline_settings
    WHERE id = 1
    LIMIT 1;
  EXCEPTION
    WHEN undefined_table THEN
      v_interval := 10;
    WHEN undefined_column THEN
      v_interval := 10;
  END;

  IF v_interval IS NULL OR v_interval <= 0 THEN
    v_interval := 10;
  END IF;

  BEGIN
    SELECT j.jobid, j.schedule
    INTO v_pipeline_job_id, v_schedule
    FROM cron.job j
    WHERE j.jobname = 'trading-pipeline-auto'
    LIMIT 1;
  EXCEPTION
    WHEN OTHERS THEN
      v_schedule := NULL;
  END;

  IF v_schedule IS NULL THEN
    v_schedule := '*/' || v_interval || ' * * * *';
  END IF;

  SELECT MAX(started_at)
  INTO v_last_run_at
  FROM public.pipeline_runs;

  SELECT completed_at
  INTO v_last_success_at
  FROM public.pipeline_runs
  WHERE status = 'success'
    AND completed_at IS NOT NULL
  ORDER BY completed_at DESC
  LIMIT 1;

  IF v_last_success_at IS NULL THEN
    BEGIN
      SELECT d.end_time
      INTO v_last_success_at
      FROM cron.job_run_details d
      JOIN cron.job j ON j.jobid = d.jobid
      WHERE j.jobname = 'trading-pipeline-auto'
        AND d.status = 'succeeded'
        AND d.end_time IS NOT NULL
      ORDER BY d.end_time DESC
      LIMIT 1;
    EXCEPTION
      WHEN OTHERS THEN
        v_last_success_at := NULL;
    END;
  END IF;

  IF v_interval > 0 THEN
    v_next_run_at :=
      date_trunc('hour', now())
      + (
          (
            FLOOR(
              EXTRACT(EPOCH FROM (date_trunc('minute', now()) - date_trunc('hour', now()))) / 60
            )::integer / v_interval + 1
          ) * v_interval
        ) * interval '1 minute';
  ELSE
    v_next_run_at := now() + interval '10 minutes';
  END IF;

  WITH ordered_runs AS (
    SELECT status, started_at
    FROM public.pipeline_runs
    ORDER BY started_at DESC
    LIMIT 100
  ),
  first_success AS (
    SELECT started_at
    FROM ordered_runs
    WHERE status = 'success'
    ORDER BY started_at DESC
    LIMIT 1
  )
  SELECT COUNT(*)
  INTO v_failures
  FROM ordered_runs r
  WHERE r.status IN ('error', 'failed')
    AND (
      NOT EXISTS (SELECT 1 FROM first_success)
      OR r.started_at > (SELECT started_at FROM first_success)
    );

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', id::text,
        'started_at', started_at,
        'completed_at', completed_at,
        'message', COALESCE(error_message, 'Unknown pipeline error')
      )
      ORDER BY started_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_recent_errors
  FROM (
    SELECT id, started_at, completed_at, error_message
    FROM public.pipeline_runs
    WHERE status IN ('error', 'failed')
      AND error_message IS NOT NULL
    ORDER BY started_at DESC
    LIMIT 5
  ) errs;

  BEGIN
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'jobid', j.jobid,
          'jobname', j.jobname,
          'schedule', j.schedule,
          'active', j.active,
          'last_status', d.status,
          'last_run_at', d.start_time,
          'last_end_at', d.end_time
        )
        ORDER BY j.jobname
      ),
      '[]'::jsonb
    )
    INTO v_jobs
    FROM cron.job j
    LEFT JOIN LATERAL (
      SELECT status, start_time, end_time
      FROM cron.job_run_details
      WHERE jobid = j.jobid
      ORDER BY start_time DESC
      LIMIT 1
    ) d ON true
    WHERE j.jobname IN (
      'trading-pipeline-auto',
      'reconcile-stuck-pipeline-runs',
      'refresh-pattern-stats',
      'cleanup-pipeline-data'
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_jobs := '[]'::jsonb;
  END;

  RETURN jsonb_build_object(
    'available', true,
    'intervalMinutes', v_interval,
    'schedule', v_schedule,
    'lastSuccessAt', v_last_success_at,
    'lastSuccessStatus', v_last_success_status,
    'lastRunAt', v_last_run_at,
    'nextRunAt', v_next_run_at,
    'consecutiveFailures', v_failures,
    'recentErrors', v_recent_errors,
    'jobs', v_jobs
  );
END;
$$;

GRANT EXECUTE
ON FUNCTION public.get_pipeline_cron_health()
TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_pipeline_cron_health() IS
'Returns aggregated Trading Command Center pipeline/pg_cron health. Runs as SECURITY DEFINER and exposes health metadata without granting client roles direct access to pg_cron tables.';

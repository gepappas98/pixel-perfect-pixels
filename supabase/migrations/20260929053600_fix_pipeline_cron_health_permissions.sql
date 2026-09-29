/*
  Fix: Pipeline Cron Health RPC permissions

  Purpose:
  - Allow the frontend/server-side Supabase client to execute
    public.get_pipeline_cron_health().
  - Keep direct access to pg_cron metadata restricted.
  - The RPC remains responsible for exposing only the aggregated
    pipeline health information.

  IMPORTANT:
  - Do NOT grant SELECT/USAGE on cron schema to anon/authenticated.
  - Only grant EXECUTE on the SECURITY DEFINER RPC.
*/

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Ensure the health RPC exists.
--    The actual implementation is created by the pipeline-health migration.
--    This migration only fixes its client execution permissions.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n
      ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'get_pipeline_cron_health'
      AND pg_get_function_identity_arguments(p.oid) = ''
  ) THEN
    RAISE EXCEPTION
      'Required function public.get_pipeline_cron_health() does not exist. Apply the pipeline health migration first.';
  END IF;
END
$$;


-- ---------------------------------------------------------------------------
-- 2. Grant execution permission.
-- ---------------------------------------------------------------------------

GRANT EXECUTE
ON FUNCTION public.get_pipeline_cron_health()
TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Explicitly document the security boundary.
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION public.get_pipeline_cron_health() IS
  'Returns aggregated pg_cron health for the Trading Command Center pipeline. '
  'The function is intended to run with SECURITY DEFINER privileges so client '
  'roles can read pipeline health without direct access to pg_cron metadata.';


-- ---------------------------------------------------------------------------
-- 4. Revoke direct cron metadata access from client roles.
--
--    The frontend must use get_pipeline_cron_health() rather than querying
--    cron.job or cron.job_run_details directly.
-- ---------------------------------------------------------------------------

REVOKE ALL
ON SCHEMA cron
FROM anon, authenticated;

COMMIT;

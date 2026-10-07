-- Set the canonical pipeline scheduler to the requested 2-minute cadence.
-- Uses the existing canonical schedule-control function; does not create a second cron job.
SELECT public.set_pipeline_schedule(2);

DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE command ILIKE '%check_and_close_trades%';
END $$;
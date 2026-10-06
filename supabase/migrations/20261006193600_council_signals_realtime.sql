-- Manual council verdicts are written server-side and the UI also has a
-- write-then-read fallback. Realtime keeps other open dashboards live.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1
       FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'council_signals'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.council_signals;
  END IF;
END $$;

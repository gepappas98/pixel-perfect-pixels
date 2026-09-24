CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
CREATE TABLE private.cron_config (id int PRIMARY KEY DEFAULT 1, secret text NOT NULL, base_url text NOT NULL);
INSERT INTO private.cron_config (id, secret, base_url) VALUES (1, replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''), 'https://project--6d1cd604-982a-4237-98b3-1276c19ca6f7.lovable.app');

CREATE TABLE public.pipeline_settings (id int PRIMARY KEY DEFAULT 1, interval_minutes int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.pipeline_settings TO anon, authenticated;
GRANT ALL ON public.pipeline_settings TO service_role;
ALTER TABLE public.pipeline_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read pipeline settings" ON public.pipeline_settings FOR SELECT TO anon, authenticated USING (true);
INSERT INTO public.pipeline_settings (id, interval_minutes) VALUES (1, 0);

CREATE OR REPLACE FUNCTION public.verify_cron_secret(_secret text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = private, public AS $$
  SELECT EXISTS (SELECT 1 FROM private.cron_config WHERE id = 1 AND secret = _secret)
$$;
REVOKE EXECUTE ON FUNCTION public.verify_cron_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_cron_secret(text) TO service_role;

CREATE OR REPLACE FUNCTION public.set_pipeline_schedule(_minutes int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, cron, net AS $$
DECLARE _url text;
BEGIN
  IF _minutes NOT IN (0, 2, 5, 10) THEN RAISE EXCEPTION 'Invalid interval'; END IF;
  PERFORM cron.unschedule('trading-pipeline-auto') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'trading-pipeline-auto');
  IF _minutes > 0 THEN
    SELECT base_url INTO _url FROM private.cron_config WHERE id = 1;
    PERFORM cron.schedule('trading-pipeline-auto', '*/' || _minutes || ' * * * *',
      format($f$select net.http_post(url := %L, headers := jsonb_build_object('x-cron-secret', (select secret from private.cron_config where id = 1), 'Content-Type', 'application/json'), body := '{}'::jsonb, timeout_milliseconds := 120000);$f$, _url || '/api/public/cron'));
  END IF;
  UPDATE public.pipeline_settings SET interval_minutes = _minutes, updated_at = now() WHERE id = 1;
  RETURN _minutes;
END $$;
REVOKE EXECUTE ON FUNCTION public.set_pipeline_schedule(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_pipeline_schedule(int) TO service_role;

SELECT public.set_pipeline_schedule(5);
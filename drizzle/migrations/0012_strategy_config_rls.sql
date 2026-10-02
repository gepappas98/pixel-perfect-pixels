ALTER TABLE public.strategy_config ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.strategy_config TO service_role;
GRANT SELECT ON public.strategy_config TO anon, authenticated;
DROP POLICY IF EXISTS "strategy_config_service_all" ON public.strategy_config;
CREATE POLICY "strategy_config_service_all" ON public.strategy_config FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "strategy_config_read_all" ON public.strategy_config;
CREATE POLICY "strategy_config_read_all" ON public.strategy_config FOR SELECT TO anon, authenticated USING (true);
NOTIFY pgrst, 'reload schema';
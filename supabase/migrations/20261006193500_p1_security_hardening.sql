-- P1 security hardening: remove public execution from maintenance RPCs,
-- hide the legacy portfolio view from the Data API, and pin search_path.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.cleanup_global_risk_events(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_pipeline_data() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_pipeline_schedule(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_pipeline_schedule(integer) TO service_role;

-- Legacy compatibility view; current PortfolioPanel uses get_portfolio_summary().
ALTER VIEW public.portfolio_summary SET (security_invoker = true);
REVOKE SELECT ON public.portfolio_summary FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.compute_total_fees() SET search_path = public, pg_catalog;
ALTER FUNCTION public.get_variant_summary() SET search_path = public, pg_catalog;

COMMIT;

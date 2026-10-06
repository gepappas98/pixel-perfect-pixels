BEGIN;

DROP POLICY IF EXISTS data_plane_unification_audit_no_browser_access ON public.data_plane_unification_audit;
CREATE POLICY data_plane_unification_audit_no_browser_access
  ON public.data_plane_unification_audit
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS strategy_shadow_diagnostics_no_browser_access ON public.strategy_shadow_diagnostics;
CREATE POLICY strategy_shadow_diagnostics_no_browser_access
  ON public.strategy_shadow_diagnostics
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMIT;

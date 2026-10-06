BEGIN;

-- Internal audit tables: no browser/API access.
REVOKE ALL ON TABLE public.data_plane_unification_audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.strategy_shadow_diagnostics FROM PUBLIC, anon, authenticated;

-- Diagnostic/history tables used by the browser remain read-only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.shadow_conflicts FROM anon, authenticated;
GRANT SELECT ON TABLE public.shadow_conflicts TO anon, authenticated;
DROP POLICY IF EXISTS shadow_conflicts_public_read ON public.shadow_conflicts;
CREATE POLICY shadow_conflicts_public_read
  ON public.shadow_conflicts
  FOR SELECT
  TO anon, authenticated
  USING (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.strategy_variant_signals FROM anon, authenticated;
GRANT SELECT ON TABLE public.strategy_variant_signals TO anon, authenticated;
DROP POLICY IF EXISTS strategy_variant_signals_public_read ON public.strategy_variant_signals;
CREATE POLICY strategy_variant_signals_public_read
  ON public.strategy_variant_signals
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Explicit deny policies document the intended no-browser-access contract.
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

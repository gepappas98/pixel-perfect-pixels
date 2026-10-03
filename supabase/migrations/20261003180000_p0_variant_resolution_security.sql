-- ============================================================
-- P0: Variant regime metadata + watchlist snapshot security
-- ============================================================

BEGIN;

ALTER TABLE public.strategy_variant_signals
  ADD COLUMN IF NOT EXISTS production_regime_label text;

UPDATE public.strategy_variant_signals
SET production_regime_label = regime_label
WHERE production_regime_label IS NULL
  AND regime_label IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_strategy_variant_signals_regime_outcome
ON public.strategy_variant_signals (
  production_regime_label,
  shadow_regime,
  outcome,
  strategy_name,
  recommendation
);

CREATE OR REPLACE FUNCTION public.set_production_regime_label()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.production_regime_label IS NULL THEN
    NEW.production_regime_label := NEW.regime_label;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_production_regime_label
ON public.strategy_variant_signals;

CREATE TRIGGER trg_set_production_regime_label
BEFORE INSERT OR UPDATE OF regime_label, production_regime_label
ON public.strategy_variant_signals
FOR EACH ROW
EXECUTE FUNCTION public.set_production_regime_label();

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON public.dynamic_watchlist_snapshots
FROM anon, authenticated;

GRANT SELECT
ON public.dynamic_watchlist_snapshots
TO anon, authenticated;

ALTER TABLE public.dynamic_watchlist_snapshots
ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dynamic_watchlist_snapshots_public_read
ON public.dynamic_watchlist_snapshots;

CREATE POLICY dynamic_watchlist_snapshots_public_read
ON public.dynamic_watchlist_snapshots
FOR SELECT
TO anon, authenticated
USING (true);

NOTIFY pgrst, 'reload schema';

COMMIT;

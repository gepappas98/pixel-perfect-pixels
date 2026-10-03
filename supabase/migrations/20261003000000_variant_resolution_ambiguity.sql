-- Preserve ambiguous TP/SL outcomes instead of biasing them toward LOSS.
ALTER TABLE public.strategy_variant_signals
  ADD COLUMN IF NOT EXISTS shadow_regime text;

ALTER TABLE public.strategy_variant_signals
  DROP CONSTRAINT IF EXISTS strategy_variant_signals_outcome_check;

ALTER TABLE public.strategy_variant_signals
  ADD CONSTRAINT strategy_variant_signals_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('open', 'win', 'loss', 'expired', 'ambiguous'));

CREATE INDEX IF NOT EXISTS idx_strategy_variant_signals_resolution
  ON public.strategy_variant_signals (outcome, shadow_regime, strategy_name, recommendation);

NOTIFY pgrst, 'reload schema';

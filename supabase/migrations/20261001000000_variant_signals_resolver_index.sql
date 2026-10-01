-- Optimize the per-strategy resolver lookup for currently open signals.
-- The partial predicate keeps the index compact as outcomes are resolved.
CREATE INDEX IF NOT EXISTS idx_variant_signals_resolver
  ON public.strategy_variant_signals (strategy_name, outcome, created_at)
  WHERE outcome = 'open';

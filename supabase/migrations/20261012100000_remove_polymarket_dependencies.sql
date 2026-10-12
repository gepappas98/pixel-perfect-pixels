-- Compatibility preparation only. This migration is safe before deploying the new Edge Function.
-- The new signal-combiner omits prediction_weight; default 0 keeps inserts valid while the
-- old deployed function can still explicitly send 0. Destructive cleanup is staged separately.
ALTER TABLE public.strategy_shadow_diagnostics
  ALTER COLUMN prediction_weight SET DEFAULT 0;

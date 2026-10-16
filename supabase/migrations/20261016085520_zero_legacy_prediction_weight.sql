-- Polymarket/prediction-market input was retired from active scoring.
-- Keep the legacy column for historical/schema compatibility, but neutralize the
-- current strategy_config row; this does not touch historical signals or snapshots.
UPDATE public.strategy_config
SET prediction_weight = 0,
    updated_at = now()
WHERE id = 1
  AND prediction_weight IS DISTINCT FROM 0;

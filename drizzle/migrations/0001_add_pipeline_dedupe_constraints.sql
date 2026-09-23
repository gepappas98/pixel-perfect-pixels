ALTER TABLE public.composite_signals ADD COLUMN IF NOT EXISTS fingerprint text;

-- Repoint references at the newest row per market before de-duplicating.
WITH keep AS (
  SELECT DISTINCT ON (market_slug) market_slug, id
  FROM public.prediction_snapshots
  ORDER BY market_slug, created_at DESC, id DESC
)
UPDATE public.composite_signals cs
SET prediction_snapshot_id = keep.id
FROM public.prediction_snapshots ps
JOIN keep ON keep.market_slug = ps.market_slug
WHERE cs.prediction_snapshot_id = ps.id
  AND cs.prediction_snapshot_id <> keep.id;

DELETE FROM public.prediction_snapshots a
USING public.prediction_snapshots b
WHERE a.market_slug = b.market_slug
  AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id));

CREATE UNIQUE INDEX IF NOT EXISTS whale_alerts_source_tx_key
  ON public.whale_alerts (source, tx_hash);

CREATE UNIQUE INDEX IF NOT EXISTS indicator_snapshots_symbol_tf_time_key
  ON public.indicator_snapshots (symbol, timeframe, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS prediction_snapshots_market_slug_key
  ON public.prediction_snapshots (market_slug);

CREATE UNIQUE INDEX IF NOT EXISTS composite_signals_fingerprint_key
  ON public.composite_signals (fingerprint);
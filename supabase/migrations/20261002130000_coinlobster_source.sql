-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION: CoinLobster whale source
-- ═══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_whale_alerts_source_created
  ON public.whale_alerts (source, created_at DESC);

COMMENT ON COLUMN public.whale_alerts.source IS
  'Supported sources: hyperliquid-recent-trades, hyperliquid-top-mover, binance-agg-trades, coinlobster-cex, coinlobster-dex';

-- Verify
SELECT 
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'idx_whale_alerts_source_created';

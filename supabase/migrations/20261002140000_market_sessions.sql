-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION: Market session tracking
-- ═══════════════════════════════════════════════════════════════════

-- Add market_session column to key tables
ALTER TABLE composite_signals
  ADD COLUMN IF NOT EXISTS market_session text;

ALTER TABLE strategy_variant_signals
  ADD COLUMN IF NOT EXISTS market_session text;

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS market_session text;

-- Indexes for session-based analytics
CREATE INDEX IF NOT EXISTS idx_composite_signals_session
  ON composite_signals (market_session, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_variant_signals_session
  ON strategy_variant_signals (strategy_name, market_session, outcome)
  WHERE outcome IN ('win', 'loss');

CREATE INDEX IF NOT EXISTS idx_trades_session
  ON trades (market_session, status);

-- Add session_config to cleanup_config
UPDATE pipeline_settings
SET cleanup_config = cleanup_config || '{
  "market_session_fix": {
    "enabled": false,
    "shadow_mode": true,
    "overlap_bonus": 0.15,
    "us_bonus": 0.05,
    "off_hours_penalty": 0.10
  }
}'::jsonb
WHERE id = 1
  AND NOT (cleanup_config ? 'market_session_fix');

-- Verify
SELECT 
  'columns_added' AS section,
  column_name AS metric_a,
  table_name AS metric_b
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'market_session'
  AND table_name IN ('composite_signals', 'strategy_variant_signals', 'trades')
ORDER BY table_name;

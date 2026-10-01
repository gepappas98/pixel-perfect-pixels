-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION: Regime tagging for signals + trades
-- ═══════════════════════════════════════════════════════════════════

-- Add regime_label column to relevant tables
ALTER TABLE strategy_variant_signals
  ADD COLUMN IF NOT EXISTS regime_label text;

ALTER TABLE composite_signals
  ADD COLUMN IF NOT EXISTS regime_label text;

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS regime_label text;

-- Indexes for regime-based analytics
CREATE INDEX IF NOT EXISTS idx_variant_signals_regime
  ON strategy_variant_signals (strategy_name, regime_label, outcome)
  WHERE outcome IN ('win', 'loss');

CREATE INDEX IF NOT EXISTS idx_composite_signals_regime
  ON composite_signals (regime_label, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_regime
  ON trades (regime_label, status);

-- Verify
SELECT 
  'columns_added' AS section,
  column_name AS metric_a,
  table_name AS metric_b
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'regime_label'
  AND table_name IN ('strategy_variant_signals', 'composite_signals', 'trades')
ORDER BY table_name;

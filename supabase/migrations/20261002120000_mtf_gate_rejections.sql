-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION: MTF gate visibility + rejections table
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mtf_gate_rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  score numeric,
  confidence numeric,
  mtf_bull_count int NOT NULL,
  mtf_bear_count int NOT NULL,
  mtf_neutral_count int NOT NULL,
  reject_reason text,
  regime_label text,
  detected_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE mtf_gate_rejections IS
  'MTF Confirmation Gate observability. Καταγράφει buy/sell signals που απορρίφθηκαν λόγω <2/3 timeframe agreement.';

CREATE INDEX IF NOT EXISTS idx_mtf_gate_rejections_time
  ON mtf_gate_rejections (detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_mtf_gate_rejections_symbol
  ON mtf_gate_rejections (symbol, detected_at DESC);

ALTER TABLE mtf_gate_rejections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mtf_gate_rejections_service_all" ON mtf_gate_rejections;
CREATE POLICY "mtf_gate_rejections_service_all"
  ON mtf_gate_rejections FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "mtf_gate_rejections_authenticated_read" ON mtf_gate_rejections;
CREATE POLICY "mtf_gate_rejections_authenticated_read"
  ON mtf_gate_rejections FOR SELECT
  TO authenticated
  USING (true);

-- Add vwap_regime_gate to cleanup_config
UPDATE pipeline_settings
SET cleanup_config = cleanup_config || '{
  "vwap_regime_gate": {
    "enabled": false,
    "shadow_mode": true,
    "atr_pct_threshold": 2.5
  }
}'::jsonb
WHERE id = 1
  AND NOT (cleanup_config ? 'vwap_regime_gate');

-- Verify
SELECT 
  cleanup_config->'vwap_regime_gate' AS vwap_gate,
  (SELECT COUNT(*) FROM information_schema.tables 
   WHERE table_schema = 'public' AND table_name = 'mtf_gate_rejections')::text AS table_created
FROM pipeline_settings WHERE id = 1;

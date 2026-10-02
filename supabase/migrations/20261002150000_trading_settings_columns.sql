-- Add dynamic trading settings columns to pipeline_settings
ALTER TABLE pipeline_settings
  ADD COLUMN IF NOT EXISTS variant_max_hours integer NOT NULL DEFAULT 72,
  ADD COLUMN IF NOT EXISTS variant_tp_pct numeric NOT NULL DEFAULT 0.04,
  ADD COLUMN IF NOT EXISTS variant_sl_pct numeric NOT NULL DEFAULT 0.03,
  ADD COLUMN IF NOT EXISTS max_hold_hours integer NOT NULL DEFAULT 72,
  ADD COLUMN IF NOT EXISTS stale_exit_hours integer NOT NULL DEFAULT 48,
  ADD COLUMN IF NOT EXISTS stale_exit_min_pnl_pct numeric NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS real_tp_pct numeric NOT NULL DEFAULT 0.04,
  ADD COLUMN IF NOT EXISTS real_sl_pct numeric NOT NULL DEFAULT 0.03;

-- Verify
SELECT 
  variant_max_hours, variant_tp_pct, variant_sl_pct,
  max_hold_hours, stale_exit_hours, stale_exit_min_pnl_pct,
  real_tp_pct, real_sl_pct
FROM pipeline_settings WHERE id = 1;

-- Cleanup Wave feature flags — όλα OFF by default
ALTER TABLE pipeline_settings
  ADD COLUMN IF NOT EXISTS cleanup_config jsonb NOT NULL DEFAULT '{
    "watch_conflict_fix": { "enabled": false, "shadow_mode": true },
    "regime_panel_fix": { "enabled": false, "shadow_mode": true },
    "auto_switch_retry": { "enabled": false, "max_retries": 3, "backoff_ms": 2000 },
    "error_serialization": { "enabled": true }
  }'::jsonb;

COMMENT ON COLUMN pipeline_settings.cleanup_config IS
  'Feature flags για σταδιακό rollout των cleanup fixes. Όλα OFF by default — ανάβουν ένα-ένα με UPDATE.';

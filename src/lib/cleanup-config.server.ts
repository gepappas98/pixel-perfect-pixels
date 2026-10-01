/**
 * Cleanup Wave feature flags — cached read από pipeline_settings.cleanup_config.
 */

const CACHE_TTL_MS = 60_000;

export interface CleanupConfig {
  watch_conflict_fix: { enabled: boolean; shadow_mode: boolean };
  regime_panel_fix: { enabled: boolean; shadow_mode: boolean };
  auto_switch_retry: {
    enabled: boolean;
    max_retries: number;
    backoff_ms: number;
  };
  error_serialization: { enabled: boolean };
  mtf_confirmation_gate: {
    enabled: boolean;
    shadow_mode: boolean;
    min_timeframes: number;
  };
  vwap_regime_gate: {
    enabled: boolean;
    shadow_mode: boolean;
    atr_pct_threshold: number;
  };
}

export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  watch_conflict_fix: { enabled: false, shadow_mode: true },
  regime_panel_fix: { enabled: false, shadow_mode: true },
  auto_switch_retry: { enabled: false, max_retries: 3, backoff_ms: 2000 },
  error_serialization: { enabled: true },
  mtf_confirmation_gate: {
    enabled: true,
    shadow_mode: false,
    min_timeframes: 2,
  },
  vwap_regime_gate: {
    enabled: false,
    shadow_mode: true,
    atr_pct_threshold: 2.5,
  },
};

let cache: { config: CleanupConfig; ts: number } | null = null;

export async function fetchCleanupConfig(): Promise<CleanupConfig> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.config;

  try {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data, error } = await supabaseAdmin
      .from("pipeline_settings")
      .select("cleanup_config")
      .single();

    if (error) throw error;

    const config: CleanupConfig = {
      ...DEFAULT_CLEANUP_CONFIG,
      ...((data?.cleanup_config as Partial<CleanupConfig>) ?? {}),
    };

    cache = { config, ts: now };
    return config;
  } catch (e) {
    console.error("[CLEANUP_CONFIG] load failed, using defaults", e);
    return DEFAULT_CLEANUP_CONFIG;
  }
}

export function invalidateCleanupCache() {
  cache = null;
}

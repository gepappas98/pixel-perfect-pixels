/**
 * Cleanup Wave feature flags — cached read από pipeline_settings.cleanup_config.
 *
 * All fixes are OFF by default except `error_serialization`.
 * Each flag can be toggled via SQL UPDATE without redeploy.
 * Cache TTL: 60 seconds.
 */

const CACHE_TTL_MS = 60_000;

export interface CleanupConfig {
  // ─── Watch conflict (whale vs prediction) ───
  watch_conflict_fix: {
    enabled: boolean;
    shadow_mode: boolean;
  };

  // ─── Regime panel resilient fetch ───
  regime_panel_fix: {
    enabled: boolean;
    shadow_mode: boolean;
  };

  // ─── Auto-switch retry (Groq) ───
  auto_switch_retry: {
    enabled: boolean;
    max_retries: number;
    backoff_ms: number;
  };

  // ─── Robust error serialization ───
  error_serialization: {
    enabled: boolean;
  };

  // ─── MTF confirmation gate ───
  mtf_confirmation_gate: {
    enabled: boolean;
    shadow_mode: boolean;
    min_timeframes: number;
  };

  // ─── VWAP regime gate (high volatility filter) ───
  vwap_regime_gate: {
    enabled: boolean;
    shadow_mode: boolean;
    atr_pct_threshold: number;
  };

  // ─── Market session bonus/penalty ───
  market_session_fix: {
    enabled: boolean;
    shadow_mode: boolean;
    overlap_bonus: number;
    us_bonus: number;
    off_hours_penalty: number;
  };
}

export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  watch_conflict_fix: {
    enabled: false,
    shadow_mode: true,
  },
  regime_panel_fix: {
    enabled: false,
    shadow_mode: true,
  },
  auto_switch_retry: {
    enabled: false,
    max_retries: 3,
    backoff_ms: 2000,
  },
  error_serialization: {
    enabled: true,
  },
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
  market_session_fix: {
    enabled: false,
    shadow_mode: true,
    overlap_bonus: 0.15,
    us_bonus: 0.05,
    off_hours_penalty: 0.10,
  },
};

let cache: { config: CleanupConfig; ts: number } | null = null;

/**
 * Fetch cleanup config from pipeline_settings.cleanup_config.
 * Falls back to DEFAULT_CLEANUP_CONFIG on any error.
 * Cached for 60 seconds to avoid hammering the DB.
 */
export async function fetchCleanupConfig(): Promise<CleanupConfig> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) {
    return cache.config;
  }

  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data, error } = await supabase
      .from("pipeline_settings")
      .select("cleanup_config")
      .single();

    if (error) throw error;

    const stored = (data?.cleanup_config ?? {}) as Partial<CleanupConfig>;

    // Deep merge: for each top-level flag, merge stored values over defaults
    // so that a partially-populated config (e.g. missing a newly added flag)
    // still returns a complete CleanupConfig.
    const config: CleanupConfig = {
      watch_conflict_fix: {
        ...DEFAULT_CLEANUP_CONFIG.watch_conflict_fix,
        ...(stored.watch_conflict_fix ?? {}),
      },
      regime_panel_fix: {
        ...DEFAULT_CLEANUP_CONFIG.regime_panel_fix,
        ...(stored.regime_panel_fix ?? {}),
      },
      auto_switch_retry: {
        ...DEFAULT_CLEANUP_CONFIG.auto_switch_retry,
        ...(stored.auto_switch_retry ?? {}),
      },
      error_serialization: {
        ...DEFAULT_CLEANUP_CONFIG.error_serialization,
        ...(stored.error_serialization ?? {}),
      },
      mtf_confirmation_gate: {
        ...DEFAULT_CLEANUP_CONFIG.mtf_confirmation_gate,
        ...(stored.mtf_confirmation_gate ?? {}),
      },
      vwap_regime_gate: {
        ...DEFAULT_CLEANUP_CONFIG.vwap_regime_gate,
        ...(stored.vwap_regime_gate ?? {}),
      },
      market_session_fix: {
        ...DEFAULT_CLEANUP_CONFIG.market_session_fix,
        ...(stored.market_session_fix ?? {}),
      },
    };

    cache = { config, ts: now };
    return config;
  } catch (e) {
    console.error(
      "[CLEANUP_CONFIG] load failed, using defaults:",
      e instanceof Error ? e.message : String(e),
    );
    return DEFAULT_CLEANUP_CONFIG;
  }
}

/**
 * Invalidate the in-memory cache.
 * Call this after updating pipeline_settings.cleanup_config
 * if you need the change to take effect immediately in the same process.
 */
export function invalidateCleanupCache() {
  cache = null;
}

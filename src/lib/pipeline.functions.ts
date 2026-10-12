import { createServerFn } from "@tanstack/react-start";

const PIPELINE_PIN = "5155";

export const runPipeline = createServerFn({ method: "POST" })
  .validator((data: { pin?: string } | undefined) => {
    const pin = data?.pin;
    if (typeof pin !== "string") throw new Error("PIN is required to run the pipeline");
    return { pin };
  })
  .handler(async ({ data }) => {
    if (data.pin !== PIPELINE_PIN) throw new Error("Invalid PIN");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    console.log("[MANUAL_PIPELINE_TRIGGER] invoking canonical trading-pipeline-orchestrator");

    const { data: result, error } = await supabaseAdmin.functions.invoke(
      "trading-pipeline-orchestrator",
      { body: { trigger: "manual", source: "dashboard" } },
    );

    if (error) {
      // Supabase Functions returns a generic non-2xx error, but the
      // orchestrator may include an actionable JSON body (for example
      // HTTP 409 + { skipped: true } when another canonical run is active).
      // Preserve that diagnostic instead of collapsing it into the generic
      // "non-2xx" message shown by the dashboard.
      const context = (error as unknown as { context?: unknown }).context;
      let detail = error.message;

      if (context && typeof context === "object" && "clone" in context) {
        try {
          const response = context as Response;
          const body = await response.clone().text();
          if (body) {
            try {
              const parsed = JSON.parse(body) as {
                message?: unknown;
                error?: unknown;
                reason?: unknown;
                skipped?: unknown;
                run_id?: unknown;
              };
              const parts = [
                typeof parsed.message === "string" ? parsed.message : null,
                typeof parsed.error === "string" ? parsed.error : null,
                typeof parsed.reason === "string" ? parsed.reason : null,
                parsed.skipped === true ? "Canonical run skipped because another run is already active." : null,
                typeof parsed.run_id === "string" ? `run_id=${parsed.run_id}` : null,
              ].filter(Boolean);
              if (parts.length > 0) detail = parts.join(" · ");
              else detail = body.slice(0, 1000);
            } catch {
              detail = body.slice(0, 1000);
            }
          }
        } catch (diagnosticError) {
          console.warn("[MANUAL_PIPELINE_TRIGGER] could not read orchestrator error body", diagnosticError);
        }
      }

      throw new Error(`Canonical pipeline trigger failed: ${detail}`);
    }

    return result;
  });

export const getTradingStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    const { tradingMode } = await import("./pipeline.server");
    return {
      mode: tradingMode(),
      binanceConfigured:
        !!process.env["BINANCE_API_KEY"] && !!process.env["BINANCE_API_SECRET"],
    };
  },
);

export const getAiHealthStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    try {
      // Read the canonical council output itself. pipeline_runs.ai_status is
      // not populated by council-sync and therefore incorrectly reported
      // "awaiting" while deterministic fallback rows were being written.
      const { supabase } = await import("@/integrations/supabase/client");
      const { data, error } = await supabase
        .from("council_signals")
        .select("depth, synced_at")
        .in("depth", ["ai-batch", "ai-synthesis"])
        .order("synced_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      const rows = (data ?? []) as { depth: string; synced_at: string | null }[];
      if (rows.length === 0) {
        return {
          available: true as const,
          status: "unknown" as const,
          error: null,
          lastSuccessAt: null,
          lastAttemptAt: null,
          lessonsGenerated: 0,
        };
      }
      const lastAttempt = rows[0]!;
      const lastAttemptMs = lastAttempt.synced_at ? new Date(lastAttempt.synced_at).getTime() : 0;
      // Council batch rows are persisted together. Consider rows synced within
      // 30 seconds of the newest row part of that batch, including partial AI batches.
      const latestBatchRows = rows.filter((row) => {
        const syncedMs = row.synced_at ? new Date(row.synced_at).getTime() : 0;
        return lastAttemptMs > 0 && syncedMs > 0 && lastAttemptMs - syncedMs <= 30_000;
      });
      const batchHasGroq = latestBatchRows.some((row) => row.depth === "ai-batch");
      const batchHasFallback = latestBatchRows.some((row) => row.depth === "ai-synthesis");
      const lastSuccess = rows.find((row) => row.depth === "ai-batch");
      // The pipeline runs every 10 minutes and the longest AI cooldown is 40
      // minutes. After two cooldown windows without fresh output, do not keep
      // presenting an old Groq success as current health.
      const AI_HEALTH_STALE_AFTER_MS = 80 * 60_000;
      const outputAgeMs = lastAttemptMs > 0 ? Date.now() - lastAttemptMs : Number.POSITIVE_INFINITY;
      const isStale = outputAgeMs > AI_HEALTH_STALE_AFTER_MS;
      const status = isStale
        ? "stale" as const
        : batchHasGroq && !batchHasFallback
          ? "ok" as const
          : "degraded_fallback" as const;
      return {
        available: true as const,
        status,
        error: status === "stale"
          ? "No fresh council output within the AI health freshness window."
          : status === "degraded_fallback"
            ? batchHasGroq
              ? "Latest council batch mixed Groq results with deterministic fallback."
              : "Latest council output used deterministic fallback; Groq did not produce a usable row in that batch."
            : null,
        lastSuccessAt: lastSuccess?.synced_at ?? null,
        lastAttemptAt: lastAttempt.synced_at,
        lessonsGenerated: rows.filter((row) => row.depth === "ai-batch").length,
      };
    } catch (error) {
      return {
        available: false as const,
        status: "unknown" as const,
        error: error instanceof Error ? error.message : String(error),
        lastSuccessAt: null,
        lastAttemptAt: null,
        lessonsGenerated: 0,
      };
    }
  },
);

export const getCronHealth = createServerFn({ method: "GET" }).handler(async () => {
  try {
    // Health is a SECURITY DEFINER RPC with anon/authenticated EXECUTE.
    // Use the canonical browser client here so Lovable's legacy server secrets
    // cannot redirect dashboard health to the retired Supabase project.
    const { supabase } = await import("@/integrations/supabase/client");
    const { data, error } = await (supabase.rpc as any)("get_pipeline_cron_health");
    if (error) throw error;

    const health = (data ?? {}) as {
      available?: boolean;
      status?: "HEALTHY" | "RUNNING" | "STALE" | "FAILED";
      intervalMinutes?: number;
      schedule?: string;
      latestRun?: {
        id: string;
        job_name: string;
        status: string;
        started_at: string | null;
        completed_at: string | null;
        duration_ms: number | null;
        error_message: string | null;
        trigger?: string;
        source?: string;
      } | null;
      lastSuccess?: {
        id: string;
        job_name: string;
        status: string;
        started_at: string | null;
        completed_at: string | null;
        duration_ms: number | null;
        trigger?: string;
        source?: string;
      } | null;
      lastSuccessAt?: string | null;
      nextRunAt?: string | null;
      consecutiveFailures?: number;
      stale?: boolean;
      staleAfterMinutes?: number;
      recentErrors?: Array<{
        id: string;
        started_at: string;
        completed_at?: string | null;
        message: string;
      }>;
    };

    const intervalMinutes = Number(health.intervalMinutes ?? 10);
    const status = health["status"] ?? "STALE";
    const staleAfterMinutes = Number(health.staleAfterMinutes ?? Math.max(intervalMinutes * 2, 30));

    return {
      available: true,
      status,
      intervalMinutes,
      schedule: health.schedule ?? `every ${intervalMinutes} minutes`,
      latestRun: health["latestRun"] ?? null,
      lastSuccess: health.lastSuccess ?? null,
      lastSuccessAt: health.lastSuccessAt ?? null,
      nextRunAt: health.nextRunAt ?? null,
      consecutiveFailures: Number(health.consecutiveFailures ?? 0),
      stale: status === "STALE",
      staleAfterMinutes,
      recentErrors: Array.isArray(health.recentErrors) ? health.recentErrors.slice(0, 5) : [],
    };
  } catch (error) {
    console.error("[CRON_HEALTH] failed to read canonical pipeline health:", error);
    return {
      available: false,
      reason: error instanceof Error ? error.message : "Canonical pipeline health is unavailable",
    };
  }
});

export const getSystemResourceMetrics = createServerFn({ method: "GET" }).handler(async () => {
  // Both dashboard reads are safe SECURITY DEFINER RPCs with anon/authenticated
  // EXECUTE on the canonical project. Use the canonical client so Lovable's
  // legacy server-side Supabase binding cannot leak retired DB metrics here.
  const { supabase } = await import("@/integrations/supabase/client");

  const [{ data: resourceData, error: resourceError }, { data: healthData, error: healthError }] =
    await Promise.all([
      (supabase.rpc as any)("get_system_resource_stats"),
      (supabase.rpc as any)("get_pipeline_cron_health"),
    ]);

  if (resourceError) throw resourceError;
  if (healthError) throw healthError;

  const resource = (resourceData ?? {}) as Record<string, unknown>;
  const health = (healthData ?? {}) as Record<string, any>;
  const latestRun = (health.latestRun ?? null) as Record<string, any> | null;
  const status = String(health.status ?? "unknown");

  const current = Number(resource["current_connections"] ?? 0);
  const max = Number(resource["max_connections"] ?? 0);
  const connectionPct = max > 0 ? (current / max) * 100 : 0;

  let durationMs = Number(latestRun?.["duration_ms"] ?? 0);
  if (status === "RUNNING" && latestRun?.["started_at"]) {
    durationMs = Math.max(0, Date.now() - new Date(String(latestRun["started_at"])).getTime());
  }

  return {
    available: true,
    connections: {
      current,
      max,
      percentage: connectionPct,
      level: connectionPct >= 85 ? "danger" : connectionPct >= 70 ? "warning" : "normal",
    },
    storage: {
      pretty: String(resource["total_db_size_pretty"] ?? "—"),
      bytes: Number(resource["total_db_size_bytes"] ?? 0),
      variantSignals: Number(resource["variant_signals_count"] ?? 0),
      dailyGrowthMb: resource["daily_growth_mb"] == null ? null : Number(resource["daily_growth_mb"]),
      dailyGrowthWindowHours: resource["daily_growth_window_hours"] == null ? null : Number(resource["daily_growth_window_hours"]),
      sampledAt: typeof resource["storage_sampled_at"] === "string" ? resource["storage_sampled_at"] : null,
    },
    cacheHitPct: Number(resource["cache_hit_pct"] ?? 0),
    pipeline: {
      status,
      durationMs,
      durationPct: Math.min(100, (durationMs / 60_000) * 100),
      signals: Number(latestRun?.["signals"] ?? 0),
      startedAt: latestRun?.["started_at"] ?? null,
      completedAt: latestRun?.["completed_at"] ?? null,
    },
    checkedAt: new Date().toISOString(),
  };
});
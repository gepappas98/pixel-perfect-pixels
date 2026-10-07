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
      const { supabase } = await import("@/integrations/supabase/client");
      const { data, error } = await supabase
        .from("pipeline_runs")
        .select("ai_status, ai_error, ai_lessons_generated, completed_at, started_at")
        .not("ai_status", "is", null)
        .order("started_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      const rows = (data ?? []) as {
        ai_status: string;
        ai_error: string | null;
        ai_lessons_generated: number | null;
        completed_at: string | null;
        started_at: string;
      }[];
      if (rows.length === 0) {
        return { available: true as const, status: "unknown" as const, error: null, lastSuccessAt: null, lessonsGenerated: 0 };
      }
      const last = rows[0]!;
      const lastSuccess = rows.find((row) => row.ai_status === "ok");
      return {
        available: true as const,
        status: last.ai_status as "ok" | "degraded_fallback" | "failed",
        error: last.ai_error,
        lastSuccessAt: lastSuccess?.completed_at ?? null,
        lessonsGenerated: last.ai_lessons_generated ?? 0,
      };
    } catch (error) {
      return {
        available: false as const,
        status: "unknown" as const,
        error: error instanceof Error ? error.message : String(error),
        lastSuccessAt: null,
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
      } | null;
      lastSuccess?: {
        id: string;
        job_name: string;
        status: string;
        started_at: string | null;
        completed_at: string | null;
        duration_ms: number | null;
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
    const status = health.status ?? "STALE";
    const staleAfterMinutes = Number(health.staleAfterMinutes ?? Math.max(intervalMinutes * 2, 30));

    return {
      available: true,
      status,
      intervalMinutes,
      schedule: health.schedule ?? `every ${intervalMinutes} minutes`,
      latestRun: health.latestRun ?? null,
      lastSuccess: health.lastSuccess ?? null,
      lastSuccessAt: health.lastSuccessAt ?? null,
      nextRunAt: health.nextRunAt ?? null,
      consecutiveFailures: Number(health.consecutiveFailures ?? 0),
      stale: status === "STALE",
      staleAfterMinutes,
      recentErrors: Array.isArray(health.recentErrors)
        ? health.recentErrors
            .filter((err) => {
              if (!health.lastSuccessAt) return true;
              const startedAt = new Date(err.started_at).getTime();
              const lastSuccessAt = new Date(health.lastSuccessAt).getTime();
              return Number.isFinite(startedAt) && Number.isFinite(lastSuccessAt) && startedAt > lastSuccessAt;
            })
            .slice(0, 5)
        : [],
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
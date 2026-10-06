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
    const { runFullPipeline } = await import("./pipeline.server");
    return await runFullPipeline();
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
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin.rpc as any)("get_pipeline_cron_health");
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
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: resourceData, error: resourceError }, { data: runs, error: runError }] = await Promise.all([
    (supabaseAdmin.rpc as any)("get_system_resource_stats"),
    supabaseAdmin
      .from("pipeline_runs")
      .select("started_at, completed_at, duration_ms, status, signals, error_message")
      .order("started_at", { ascending: false })
      .limit(20),
  ]);
  if (resourceError) throw resourceError;
  if (runError) throw runError;

  const resource = (resourceData ?? {}) as Record<string, unknown>;
  const rows = (runs ?? []) as Array<Record<string, unknown>>;
  const active = rows.find((r) => r["status"] === "running");
  const latestCompleted = rows.find((r) => ["success", "completed", "error", "failed"].includes(String(r["status"])));
  const run = active ?? latestCompleted ?? rows[0] ?? null;

  const current = Number(resource["current_connections"] ?? 0);
  const max = Number(resource["max_connections"] ?? 0);
  const connectionPct = max > 0 ? (current / max) * 100 : 0;

  let durationMs = Number(run?.["duration_ms"] ?? 0);
  if (active?.["started_at"]) {
    durationMs = Math.max(0, Date.now() - new Date(String(active["started_at"])).getTime());
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
      status: String(run?.["status"] ?? "unknown"),
      durationMs,
      durationPct: Math.min(100, (durationMs / 60_000) * 100),
      signals: Number(run?.["signals"] ?? 0),
      startedAt: run?.["started_at"] ?? null,
      completedAt: run?.["completed_at"] ?? null,
    },
    checkedAt: new Date().toISOString(),
  };
});
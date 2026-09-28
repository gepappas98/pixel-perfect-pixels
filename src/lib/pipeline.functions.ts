import { createServerFn } from "@tanstack/react-start";

const PIPELINE_PIN = "5155";

export const runPipeline = createServerFn({ method: "POST" })
  .validator((data: { pin?: string } | undefined) => {
    const pin = data?.pin;
    if (typeof pin !== "string") {
      throw new Error("PIN is required to run the pipeline");
    }
    return { pin };
  })
  .handler(async ({ data }) => {
    if (data.pin !== PIPELINE_PIN) {
      throw new Error("Invalid PIN");
    }
    const { runFullPipeline } = await import("./pipeline.server");
    return await runFullPipeline();
  });

export const getTradingStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    const { tradingMode } = await import("./pipeline.server");
    return {
      mode: tradingMode(),
      binanceConfigured:
        !!process.env["BINANCE_API_KEY"] &&
        !!process.env["BINANCE_API_SECRET"],
    };
  },
);

export const getAiHealthStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    try {
      const { supabaseAdmin } = await import(
        "@/integrations/supabase/client.server"
      );
      const { data, error } = await supabaseAdmin
        .from("pipeline_runs")
        .select(
          "ai_status, ai_error, ai_lessons_generated, completed_at, started_at",
        )
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
        return {
          available: true as const,
          status: "unknown" as const,
          error: null,
          lastSuccessAt: null,
          lessonsGenerated: 0,
        };
      }

      const last = rows[0]!;
      const lastSuccess = rows.find((r) => r.ai_status === "ok");

      return {
        available: true as const,
        status: last.ai_status as "ok" | "degraded_fallback" | "failed",
        error: last.ai_error,
        lastSuccessAt: lastSuccess?.completed_at ?? null,
        lessonsGenerated: last.ai_lessons_generated ?? 0,
      };
    } catch (e) {
      return {
        available: false as const,
        status: "unknown" as const,
        error: e instanceof Error ? e.message : String(e),
        lastSuccessAt: null,
        lessonsGenerated: 0,
      };
    }
  },
);

export const getCronHealth = createServerFn({ method: "GET" }).handler(
  async () => {
    try {
      const { supabaseAdmin } = await import(
        "@/integrations/supabase/client.server"
      );
      const { data: schedule } = await (supabaseAdmin.from as any)(
        "pipeline_settings",
      )
        .select("interval_minutes")
        .eq("id", 1)
        .maybeSingle();
      const { data: runs, error } = await (supabaseAdmin.from as any)(
        "pipeline_runs",
      )
        .select("id,status,started_at,completed_at,error_message")
        .order("started_at", { ascending: false })
        .limit(20);
      if (error) throw error;

      const intervalMinutes = Number(schedule?.interval_minutes ?? 0);
      const lastSuccess =
        (runs ?? []).find(
          (run: { status: string }) => run.status === "success",
        ) ?? null;
      const consecutiveFailures = (runs ?? []).findIndex(
        (run: { status: string }) => run.status === "success",
      );
      const failureCount =
        consecutiveFailures === -1 ? (runs ?? []).length : consecutiveFailures;
      const lastCompletedAt = lastSuccess?.completed_at ?? null;
      const nextRunAt =
        lastCompletedAt && intervalMinutes > 0
          ? new Date(
              new Date(lastCompletedAt).getTime() + intervalMinutes * 60_000,
            ).toISOString()
          : null;
      const staleAfterMinutes = Math.max(intervalMinutes * 2, 15);
      const stale =
        !lastCompletedAt ||
        Date.now() - new Date(lastCompletedAt).getTime() >
          staleAfterMinutes * 60_000;

      const recentErrors = (runs ?? [])
        .filter(
          (run: { status: string; error_message?: string | null }) =>
            run.status === "error" && run.error_message,
        )
        .slice(0, 5)
        .map((run: { id: string; started_at: string; error_message: string }) => ({
          id: run.id,
          started_at: run.started_at,
          message: run.error_message,
        }));

      return {
        available: true,
        intervalMinutes,
        lastSuccess,
        nextRunAt,
        consecutiveFailures: failureCount,
        stale,
        staleAfterMinutes,
        recentErrors,
      };
    } catch (error) {
      return {
        available: false,
        reason:
          error instanceof Error
            ? error.message
            : "Supabase health storage is unavailable",
      };
    }
  },
);

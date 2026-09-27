import { createServerFn } from "@tanstack/react-start";

export const runPipeline = createServerFn({ method: "POST" }).handler(async () => {
  const { runFullPipeline } = await import("./pipeline.server");
  return await runFullPipeline();
});

export const getTradingStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { tradingMode } = await import("./pipeline.server");
  return {
    mode: tradingMode(),
    binanceConfigured:
      !!process.env["BINANCE_API_KEY"] && !!process.env["BINANCE_API_SECRET"],
  };
});

export const getCronHealth = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: schedule } = await (supabaseAdmin.from as any)("pipeline_settings")
      .select("interval_minutes")
      .eq("id", 1)
      .maybeSingle();
    const { data: runs, error } = await (supabaseAdmin.from as any)("pipeline_runs")
      .select("id,status,started_at,completed_at,error_message")
      .order("started_at", { ascending: false })
      .limit(20);
    if (error) throw error;

    const intervalMinutes = Number(schedule?.interval_minutes ?? 0);
    const lastSuccess = (runs ?? []).find((run: { status: string }) => run.status === "success") ?? null;
    const consecutiveFailures = (runs ?? []).findIndex((run: { status: string }) => run.status === "success");
    const failureCount = consecutiveFailures === -1 ? (runs ?? []).length : consecutiveFailures;
    const lastCompletedAt = lastSuccess?.completed_at ?? null;
    const nextRunAt = lastCompletedAt && intervalMinutes > 0
      ? new Date(new Date(lastCompletedAt).getTime() + intervalMinutes * 60_000).toISOString()
      : null;
    const staleAfterMinutes = Math.max(intervalMinutes * 2, 15);
    const stale = !lastCompletedAt || Date.now() - new Date(lastCompletedAt).getTime() > staleAfterMinutes * 60_000;

    // Πρόσφατα errors — για εμφάνιση στο UI
    const recentErrors = (runs ?? [])
      .filter((run: { status: string; error_message?: string | null }) => run.status === "error" && run.error_message)
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
      reason: error instanceof Error ? error.message : "Supabase health storage is unavailable",
    };
  }
});

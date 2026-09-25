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
      .order("completed_at", { ascending: false })
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

    return {
      available: true,
      intervalMinutes,
      lastSuccess,
      nextRunAt,
      consecutiveFailures: failureCount,
      stale,
      staleAfterMinutes,
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : "Supabase health storage is unavailable",
    };
  }
});

export const getPortfolioSummary = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin.rpc as any)("get_portfolio_summary");
  if (error) throw new Error(error.message);
  return data as {
    open_count: number;
    open_notional: number;
    closed_count: number;
    realized_pnl: number;
    win_rate_pct: number;
    win_count: number;
    loss_count: number;
    gross_profit: number;
    gross_loss: number;
    profit_factor: number | null;
    avg_win_usd: number;
    avg_loss_usd: number;
    last_24h_closed: number;
    last_24h_pnl: number;
  } | null;
});

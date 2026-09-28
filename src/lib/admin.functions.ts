import { createServerFn } from "@tanstack/react-start";

const TABLES = [
  "trade_alerts",
  "trades",
  "composite_signals",
  "council_signals",
  "prediction_snapshots",
  "indicator_snapshots",
  "whale_alerts",
] as const;

export const resetAllData = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const cleared: Record<string, number | null> = {};
  for (const table of TABLES) {
    const { error, count } = await (supabaseAdmin.from as any)(table)
      .delete({ count: "exact" })
      .not("id", "is", null);
    if (error) throw new Error(`${table}: ${error.message}`);
    cleared[table] = count ?? null;
  }
  return { ok: true as const, cleared };
});

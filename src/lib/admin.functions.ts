import { createServerFn } from "@tanstack/react-start";

/* ───────────── Reset pipeline data (SELECTIVE) ─────────────
 * Σβήνει ΟΛΑ τα pipeline data ΕΚΤΟΣ από:
 *   - trades             (τα κρατάμε! realized + open)
 *   - council_lessons    (τα AI learnings μένουν!)
 *   - pipeline_settings  (interval config)
 *   - ai_summary_requests
 *
 * Προστασία: server-side PIN — client δεν μπορεί να το παρακάμψει. */

const RESET_PIN = "5155";

const RESET_TABLES = [
  "trade_alerts",
  "composite_signals",
  "council_signals",
  "whale_alerts",
  "indicator_snapshots",
  "prediction_snapshots",
  "pipeline_runs",
] as const;

export const resetAllData = createServerFn({ method: "POST" })
  .validator((data: { pin: string }) => {
    if (!data || typeof data.pin !== "string") {
      throw new Error("PIN is required");
    }
    return { pin: data.pin };
  })
  .handler(async ({ data }) => {
    // Server-side PIN validation — δεν μπορεί να παρακαμφθεί από client.
    if (data.pin !== RESET_PIN) {
      return { ok: false as const, error: "Invalid PIN" };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const cleared: Record<string, number | string> = {};
    let totalDeleted = 0;
    let hadError = false;

    for (const table of RESET_TABLES) {
      // Supabase PostgREST απαιτεί πάντα filter — χρησιμοποιούμε πάντα-true.
      const { error, count } = await supabaseAdmin
        .from(table)
        .delete({ count: "exact" })
        .not("id", "is", null);

      if (error) {
        console.error(`[RESET] failed to clear ${table}:`, error);
        cleared[table] = `ERROR: ${error.message}`;
        hadError = true;
      } else {
        const c = count ?? 0;
        cleared[table] = c;
        totalDeleted += c;
      }
    }

    return {
      ok: !hadError,
      totalDeleted,
      cleared,
      timestamp: new Date().toISOString(),
      preserved: ["trades", "council_lessons", "pipeline_settings"],
    };
  });

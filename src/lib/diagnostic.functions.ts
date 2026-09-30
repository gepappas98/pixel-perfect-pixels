import type { Json } from "@/integrations/supabase/types";
import { createServerFn } from "@tanstack/react-start";

/* ───────────── Watch diagnostic ───────────── */

export const getWatchDiagnostic = createServerFn({ method: "GET" }).handler(
  async () => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const db = supabaseAdmin;

    const targetSymbols = ["HEMI", "PIXEL", "SPY", "ADA", "BTC"];

    const { data: strategy } = await db
      .from("strategy_config")
      .select("*")
      .eq("id", 1)
      .maybeSingle();

    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: watches } = await db
      .from("composite_signals")
      .select("*")
      .in("symbol", targetSymbols)
      .eq("recommendation", "watch")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(30);

    const { data: councils } = await db
      .from("council_signals")
      .select("*")
      .in("symbol", targetSymbols)
      .order("source_created_at", { ascending: false });

    const watchRows = (watches ?? []).map((w: any) => ({
      symbol: w.symbol,
      confidence: w.confidence,
      recommendation: w.recommendation,
      reasoning: w.reasoning,
      created_at: w.created_at,
      has_whale: w.whale_alert_id != null,
      has_indicator: w.indicator_snapshot_id != null,
      has_prediction: w.prediction_snapshot_id != null,
      has_council: w.council_signal_id != null,
      council_signal_id: w.council_signal_id,
    }));

    const { data: allWatches } = await db
      .from("composite_signals")
      .select(
        "symbol, whale_alert_id, indicator_snapshot_id, prediction_snapshot_id",
      )
      .eq("recommendation", "watch")
      .in("symbol", targetSymbols)
      .gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());

    const sourceMatrix = new Map<
      string,
      { c0: number; c1: number; c2: number; c3: number }
    >();
    for (const w of (allWatches ?? []) as any[]) {
      const count =
        (w.whale_alert_id != null ? 1 : 0) +
        (w.indicator_snapshot_id != null ? 1 : 0) +
        (w.prediction_snapshot_id != null ? 1 : 0);
      const entry =
        sourceMatrix.get(w.symbol) ?? { c0: 0, c1: 0, c2: 0, c3: 0 };
      entry[`c${count}` as "c0"]++;
      sourceMatrix.set(w.symbol, entry);
    }

    return {
      generated_at: new Date().toISOString(),
      strategy,
      watches: watchRows,
      councils: (councils ?? []).map((c: any) => ({
        id: c.id,
        symbol: c.symbol,
        source_id: c.source_id,
        final_verdict: c.final_verdict,
        conviction: c.conviction,
        depth: c.depth,
        price_at: c.price_at,
        reflection: c.reflection,
        source_created_at: c.source_created_at,
      })),
      source_matrix: Object.fromEntries(sourceMatrix),
    };
  },
);

/* ───────────── Shadow conflicts + cleanup diagnostic ───────────── */

export const getShadowConflicts = createServerFn({ method: "GET" }).handler(
  async () => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loose = supabaseAdmin as unknown as { from: (t: string) => any };
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const since30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    /* ── 1. Shadow conflicts (existing) ── */
    const { data: recent, error: recentErr } = await loose
      .from("shadow_conflicts")
      .select("*")
      .order("detected_at", { ascending: false })
      .limit(50);

    if (recentErr) {
      console.error("[SHADOW_DIAG] recent fetch failed:", recentErr);
    }

    const { data: all, error: allErr } = await loose
      .from("shadow_conflicts")
      .select(
        "symbol, current_recommendation, would_be_recommendation, score, confidence",
      )
      .gte("detected_at", since24h);

    if (allErr) {
      console.error("[SHADOW_DIAG] all fetch failed:", allErr);
    }

    const bySymbol = new Map<
      string,
      {
        symbol: string;
        current: string;
        would_be: string;
        count: number;
        score_sum: number;
        confidence_sum: number;
      }
    >();

    for (const row of (all ?? []) as {
      symbol: string;
      current_recommendation: string;
      would_be_recommendation: string;
      score: number | null;
      confidence: number | null;
    }[]) {
      const key = `${row.symbol}:${row.current_recommendation}→${row.would_be_recommendation}`;
      const existing = bySymbol.get(key);
      const s = Number(row.score) || 0;
      const c = Number(row.confidence) || 0;

      if (existing) {
        existing.count++;
        existing.score_sum += s;
        existing.confidence_sum += c;
      } else {
        bySymbol.set(key, {
          symbol: row.symbol,
          current: row.current_recommendation,
          would_be: row.would_be_recommendation,
          count: 1,
          score_sum: s,
          confidence_sum: c,
        });
      }
    }

    const aggregate = [...bySymbol.values()].map((v) => ({
      symbol: v.symbol,
      current: v.current,
      would_be: v.would_be,
      count: v.count,
      avg_score: Number((v.score_sum / v.count).toFixed(4)),
      avg_confidence: Number((v.confidence_sum / v.count).toFixed(4)),
    }));

    aggregate.sort((a, b) => b.count - a.count);

    /* ── 2. Cleanup config ── */
    let cleanup_config: Json = null;
    let cleanup_error: string | null = null;
    try {
      const { data, error } = await loose
        .from("pipeline_settings")
        .select("cleanup_config")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      cleanup_config = data?.cleanup_config ?? null;
      if (!data) cleanup_error = "no pipeline_settings row with id=1";
    } catch (e) {
      cleanup_error = e instanceof Error ? e.message : String(e);
      console.error("[SHADOW_DIAG] cleanup_config fetch failed:", e);
    }

    /* ── 3. Recent composite signals (last 30 min) ── */
    let recent_composites: unknown[] = [];
    let composites_error: string | null = null;
    try {
      const { data, error } = await supabaseAdmin
        .from("composite_signals")
        .select(
          "symbol, recommendation, confidence, reasoning, created_at, whale_alert_id, indicator_snapshot_id, prediction_snapshot_id, council_signal_id",
        )
        .gte("created_at", since30m)
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      recent_composites = (data ?? []).map((r: any) => ({
        symbol: r.symbol,
        recommendation: r.recommendation,
        confidence: r.confidence,
        reasoning: r.reasoning,
        created_at: r.created_at,
        has_whale: r.whale_alert_id != null,
        has_indicator: r.indicator_snapshot_id != null,
        has_prediction: r.prediction_snapshot_id != null,
        has_council: r.council_signal_id != null,
      }));
    } catch (e) {
      composites_error = e instanceof Error ? e.message : String(e);
      console.error("[SHADOW_DIAG] composite fetch failed:", e);
    }

    /* ── 4. Recent pipeline runs ── */
    let recent_runs: unknown[] = [];
    try {
      const { data } = await supabaseAdmin
        .from("pipeline_runs")
        .select("id, started_at, completed_at, status, signals, trades, error_message")
        .order("started_at", { ascending: false })
        .limit(5);
      recent_runs = data ?? [];
    } catch (e) {
      console.error("[SHADOW_DIAG] pipeline_runs fetch failed:", e);
    }

    /* ── 5. Current strategy weights ── */
    let strategy: unknown = null;
    try {
      const { data } = await supabaseAdmin
        .from("strategy_config")
        .select("*")
        .eq("id", 1)
        .maybeSingle();
      strategy = data ?? null;
    } catch (e) {
      console.error("[SHADOW_DIAG] strategy fetch failed:", e);
    }

    return {
      generated_at: new Date().toISOString(),
      // Shadow conflicts (existing)
      total_24h: all?.length ?? 0,
      recent: recent ?? [],
      aggregate_24h: aggregate,
      // New diagnostic fields
      cleanup_config,
      cleanup_error,
      recent_composites,
      composites_error,
      recent_runs,
      strategy,
    };
  },
);

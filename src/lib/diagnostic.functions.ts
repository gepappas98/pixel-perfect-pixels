import { createServerFn } from "@tanstack/react-start";

/* ───────────── Watch diagnostic ───────────── */

export const getWatchDiagnostic = createServerFn({ method: "GET" }).handler(
  async () => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const db = supabaseAdmin;

    const targetSymbols = ["HEMI", "PIXEL", "SPY", "ADA", "BTC"];

    // 1. Strategy weights
    const { data: strategy } = await db
      .from("strategy_config")
      .select("*")
      .eq("id", 1)
      .maybeSingle();

    // 2. Watch composite signals (τελευταία 30 λεπτά)
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: watches } = await db
      .from("composite_signals")
      .select("*")
      .in("symbol", targetSymbols)
      .eq("recommendation", "watch")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(30);

    // 3. Όλα τα council_signals για αυτά τα symbols
    const { data: councils } = await db
      .from("council_signals")
      .select("*")
      .in("symbol", targetSymbols)
      .order("source_created_at", { ascending: false });

    // 4. Source presence matrix
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

    // 5. Source count matrix (aggregate)
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

/* ───────────── Shadow conflicts ───────────── */

export const getShadowConflicts = createServerFn({ method: "GET" }).handler(
  async () => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    // Τελευταία 50 rows
    const { data: recent, error: recentErr } = await supabaseAdmin
      .from("shadow_conflicts")
      .select("*")
      .order("detected_at", { ascending: false })
      .limit(50);

    if (recentErr) {
      console.error("[SHADOW_DIAG] recent fetch failed:", recentErr);
    }

    // Aggregate ανά symbol (24h)
    const { data: all, error: allErr } = await supabaseAdmin
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

    return {
      generated_at: new Date().toISOString(),
      total_24h: all?.length ?? 0,
      recent: recent ?? [],
      aggregate_24h: aggregate,
    };
  },
);

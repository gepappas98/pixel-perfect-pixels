import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";

// Weights: [whale, technicals, council] — prediction markets remain disabled.
const P: Record<string, [number, number, number]> = {
  balanced: [1, 1, 1],
  "whale-focused": [2, 0.5, 0.5],
  "chart-trader": [0.5, 2, 0.5],
  "ai-driven": [0.5, 0.5, 2],
  conservative: [1.2, 1.2, 1.2],
  "volatility-timing": [0.3, 2.2, 1],
  "vwap-momentum": [0.5, 2.2, 0.8],
  "smc-reversal": [0.4, 2.5, 0.8],
};

const norm = (rs: any[]) =>
  rs
    .map((r) => {
      const w = +r.wins || 0,
        l = +r.losses || 0,
        n = +r.resolved || 0,
        t = +r.total_pnl_pct || 0;
      return {
        strategy_name: String(r.strategy_name),
        wins: w,
        losses: l,
        resolved: n,
        total_pnl_pct: t,
        avg_pnl_pct: n ? t / n : null,
        win_rate_pct: w + l ? (100 * w) / (w + l) : null,
      };
    })
    .filter((x) => P[x.strategy_name]);

Deno.serve(async (req) => {
  const h = handleOptions(req);
  if (h) return h;

  const db = getServiceClient();

  try {
    // 1. Read config and enforce the existing cooldown.
    const { data: c, error } = await db
      .from("strategy_config")
      .select("*")
      .eq("id", 1)
      .maybeSingle();

    if (error) throw error;
    if (!c || !c.auto_switch_enabled) {
      return Response.json(
        { ok: true, switched: false, reason: c ? "disabled" : "no_config" },
        { headers: corsHeaders }
      );
    }

    const iv = Math.max(1, +c.auto_switch_interval_hours || 4);
    const last = c.last_auto_switch_at
      ? new Date(c.last_auto_switch_at).getTime()
      : 0;
    if (last && Date.now() - last < iv * 36e5) {
      return Response.json(
        { ok: true, switched: false, reason: "cooldown" },
        { headers: corsHeaders }
      );
    }

    // 2. Read the seven-day variant performance cohort.
    const { data: rows, error: pe } = await (db.rpc as any)(
      "get_variant_performance_v2",
      { days: 7 }
    );
    if (pe) throw pe;

    const ps = norm(rows || []);
    const cur = String(c.preset_name || "chart-trader");
    const curPerf = ps.find((x) => x.strategy_name === cur);

    const resolved = curPerf?.resolved || 0;
    const avgPnl = curPerf?.avg_pnl_pct ?? 0;
    const winRate = curPerf?.win_rate_pct ?? 50;

    // 3. Demote-only safety rule: >=8 resolved trades and (negative PnL OR win rate <30%).
    const isFailing = resolved >= 8 && (avgPnl < 0 || winRate < 30);

    // Healthy or undersampled current presets never trigger an upgrade.
    if (!isFailing) {
      const reason = `DEMOTE_ONLY: current preset '${cur}' healthy (resolved=${resolved}, avg_pnl=${avgPnl.toFixed(2)}%, win_rate=${winRate.toFixed(1)}%) - no demotion needed`;
      await db
        .from("strategy_config")
        .update({
          last_auto_switch_at: new Date().toISOString(),
          last_auto_reasoning: reason,
        })
        .eq("id", 1);

      return Response.json(
        {
          ok: true,
          switched: false,
          reason: "demote_only_healthy",
          preset: cur,
          performance: ps,
        },
        { headers: corsHeaders }
      );
    }

    // 4. If failing, prefer a sufficiently sampled positive alternative.
    const safeAlternatives = ps
      .filter(
        (x) =>
          x.strategy_name !== cur &&
          x.resolved >= 8 &&
          (x.avg_pnl_pct || 0) > 0 &&
          (x.win_rate_pct || 0) >= 40
      )
      .sort((a, b) => (b.avg_pnl_pct || 0) - (a.avg_pnl_pct || 0));

    // If conservative itself is failing and no qualified positive alternative exists,
    // do not "demote" into balanced; hold the safety preset and report the condition.
    if (!safeAlternatives.length && cur === "conservative") {
      const reason = `DEMOTE_ONLY: conservative failed safety check but no qualified positive alternative exists (resolved=${resolved}, avg_pnl=${avgPnl.toFixed(2)}%, win_rate=${winRate.toFixed(1)}%); preset unchanged`;
      const { error: ue } = await db
        .from("strategy_config")
        .update({
          last_auto_switch_at: new Date().toISOString(),
          last_auto_reasoning: reason,
        })
        .eq("id", 1);
      if (ue) throw ue;
      return Response.json(
        {
          ok: true,
          switched: false,
          reason: "conservative_failed_no_safe_alternative",
          preset: cur,
          performance: ps,
        },
        { headers: corsHeaders }
      );
    }

    const targetPreset = safeAlternatives[0]?.strategy_name || "conservative";

    const demoteReason = `AUTO_DEMOTE: '${cur}' failed safety check (resolved=${resolved}, avg_pnl=${avgPnl.toFixed(2)}%, win_rate=${winRate.toFixed(1)}%) -> demoted to '${targetPreset}'`;

    const w = P[targetPreset];
    const { error: ue } = await db
      .from("strategy_config")
      .update({
        whale_weight: w[0],
        technicals_weight: w[1],
        council_weight: w[2],
        prediction_weight: 0,
        preset_name: targetPreset,
        last_auto_switch_at: new Date().toISOString(),
        last_auto_reasoning: demoteReason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);

    if (ue) throw ue;

    return Response.json(
      {
        ok: true,
        switched: true,
        preset: targetPreset,
        source: "auto_demote",
        reason: demoteReason,
        performance: ps,
      },
      { headers: corsHeaders }
    );
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: corsHeaders }
    );
  }
});

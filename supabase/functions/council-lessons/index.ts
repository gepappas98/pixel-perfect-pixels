import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const BATCH_MAX = 5;
const BRIDGE_URL = "https://aicombined-trading-command-center.lovable.app/api/public/council-lessons-batch";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  const db = getServiceClient();
  const started = Date.now();
  try {
    const { data: rows, error } = await db.from("trades")
      .select("id,symbol,side,mode,quantity,entry_price,exit_price,pnl,net_pnl,close_reason,closed_at,composite_signal_id")
      .eq("status", "closed").eq("side", "buy").eq("mode", "paper")
      .eq("post_mortem_generated", false)
      .order("closed_at", { ascending: true }).limit(BATCH_MAX);
    if (error) throw new Error("fetch closed trades: " + error.message);
    if (!rows?.length) return Response.json({ ok: true, attempted: 0, generated: 0, status: "ok" }, { headers: corsHeaders });

    const candidates = [];
    for (const trade of rows) {
      let originalReasoning: string | null = null;
      let originalVerdict: string | null = null;
      if (trade.composite_signal_id) {
        const { data: signal } = await db.from("composite_signals")
          .select("reasoning,recommendation").eq("id", trade.composite_signal_id).maybeSingle();
        if (signal) {
          originalReasoning = typeof signal.reasoning === "string" ? signal.reasoning : null;
          originalVerdict = typeof signal.recommendation === "string" ? signal.recommendation : null;
        }
      }
      const pnl = Number(trade.net_pnl ?? trade.pnl ?? 0);
      const notional = Number(trade.entry_price) * Number(trade.quantity);
      const pnlPct = Number.isFinite(notional) && notional > 0 ? pnl / notional * 100 : 0;
      candidates.push({
        source_trade_id: trade.id, symbol: String(trade.symbol).toUpperCase(),
        outcome: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
        pnl_pct: Number(pnlPct.toFixed(4)), realized_pnl: pnl,
        close_reason: String(trade.close_reason ?? "unknown"),
        original_verdict: originalVerdict, original_reasoning: originalReasoning,
        entry_price: Number(trade.entry_price),
        exit_price: trade.exit_price == null ? null : Number(trade.exit_price)
      });
    }

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey) throw new Error("service role key unavailable");
    const response = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + serviceKey },
      body: JSON.stringify({ trades: candidates }), signal: AbortSignal.timeout(22_000)
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error("Lovable lessons bridge HTTP " + response.status + ": " + body.slice(0, 180));
    }
    const payload = await response.json() as { results?: { source_trade_id: string; lesson: string }[] };
    const lessons = Array.isArray(payload.results) ? payload.results : [];
    const allowed = new Map(candidates.map((t) => [t.source_trade_id, t]));
    let generated = 0;
    const errors: string[] = [];
    for (const item of lessons) {
      const trade = allowed.get(item.source_trade_id);
      if (!trade || typeof item.lesson !== "string" || !item.lesson.trim()) continue;
      const { data: already } = await db.from("council_lessons").select("id")
        .eq("source_trade_id", item.source_trade_id).limit(1).maybeSingle();
      if (already) {
        await db.from("trades").update({ post_mortem_generated: true })
          .eq("id", item.source_trade_id).eq("status", "closed").eq("post_mortem_generated", false);
        continue;
      }
      const { error: insertError } = await db.from("council_lessons").insert({
        symbol: trade.symbol, verdict: trade.original_verdict, conviction: null,
        entry_context: {
          side: "buy", entry_price: trade.entry_price, exit_price: trade.exit_price,
          close_reason: trade.close_reason, reasoning: trade.original_reasoning
        },
        outcome: trade.outcome, realized_pnl: trade.realized_pnl, pnl_pct: trade.pnl_pct,
        lesson: item.lesson.trim().slice(0, 500), source_trade_id: trade.source_trade_id
      });
      if (insertError) { errors.push(trade.source_trade_id + ": " + insertError.message); continue; }
      const { error: flagError } = await db.from("trades").update({ post_mortem_generated: true })
        .eq("id", trade.source_trade_id).eq("status", "closed").eq("post_mortem_generated", false);
      if (flagError) errors.push(trade.source_trade_id + " flag: " + flagError.message);
      else generated++;
    }
    const missing = candidates.filter((t) => !lessons.some((l) => l.source_trade_id === t.source_trade_id));
    return Response.json({
      ok: errors.length === 0 && missing.length === 0, attempted: candidates.length, generated,
      missing: missing.map((t) => t.source_trade_id),
      status: errors.length || missing.length ? "partial" : "ok", errors, duration_ms: Date.now() - started
    }, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[COUNCIL_LESSONS] failed", message);
    return Response.json({ ok: false, status: "error", error: message, duration_ms: Date.now() - started }, {
      status: 500, headers: corsHeaders
    });
  }
});

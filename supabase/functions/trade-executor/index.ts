import { handleOptions, corsHeaders } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const MIN_CONFIDENCE = 0.6;
const PAPER_POSITION_USD = 1000;
const STOP_LOSS_PCT = 0.03;
const TAKE_PROFIT_PCT = 0.06;
const MAX_OPEN_POSITIONS = 3;

async function getCurrentPrice(symbol: string): Promise<number> {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
  if (!res.ok) throw new Error(`price fetch failed for ${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  const price = Number(data?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`invalid price for ${symbol}`);
  return price;
}

async function getEligibleSignals(supabase: ReturnType<typeof getServiceClient>) {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  return supabase
    .from("composite_signals")
    .select("*")
    .gte("created_at", since)
    .gte("confidence", MIN_CONFIDENCE)
    .eq("recommendation", "buy")
    .order("created_at", { ascending: false })
    .limit(MAX_OPEN_POSITIONS * 3);
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const supabase = getServiceClient();
    const tradingMode = Deno.env.get("TRADING_MODE") ?? "paper";

    if (tradingMode === "live") {
      return new Response(JSON.stringify({
        error: "Live execution is intentionally blocked in phase 1. Use paper mode until a verified live-order adapter is implemented."
      }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const auditStartedAt = new Date().toISOString();

    const { count: openCount, error: countError } = await supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("mode", "paper")
      .eq("status", "open")
      .eq("side", "buy");

    if (countError) throw countError;
    const remainingSlots = Math.max(0, MAX_OPEN_POSITIONS - (openCount ?? 0));

    // SAFETY HOLD: restore the full execution/risk-gate implementation before
    // allowing any new entry. This fail-closed guard prevents the temporary
    // audit-only executor from bypassing AI risk and risk-engine controls.
    if (remainingSlots > 0) {
      const { data: signals, error } = await getEligibleSignals(supabase);
      const auditEvents = (signals ?? []).map((signal) => ({
        ts: new Date().toISOString(),
        symbol: String(signal.symbol),
        signal_id: String(signal.id),
        stage: "CANDIDATE_FILTER",
        decision: "REJECT",
        reason: "execution_risk_gate_restore_required",
        confidence: Number(signal.confidence),
        details: {
          min_confidence: MIN_CONFIDENCE,
          window_minutes: 15,
          remaining_slots: remainingSlots,
          fail_closed: true,
        },
      }));
      return new Response(JSON.stringify({
        mode: tradingMode,
        opened: 0,
        skipped: (signals ?? []).length,
        errors: error ? [{ signal_id: "", symbol: "", error: error.message }] : [],
        reason: "execution_risk_gate_restore_required",
        execution_audit: {
          version: 1,
          started_at: auditStartedAt,
          completed_at: new Date().toISOString(),
          status: "completed",
          trades: 0,
          summary: {
            eligible_buy_signals: (signals ?? []).length,
            audited_eligible_signals: auditEvents.length,
            uncovered_eligible_signals: 0,
            opened: 0,
            skipped: (signals ?? []).length,
            errors: error ? 1 : 0,
          },
          events: auditEvents,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Observability-only path: when the portfolio cap is already full, still
    // inspect the eligible BUY signals and emit explicit audit REJECT events.
    if (remainingSlots === 0) {
      const { data: signals, error } = await getEligibleSignals(supabase);
      const auditEvents = (signals ?? []).map((signal) => ({
        ts: new Date().toISOString(),
        symbol: String(signal.symbol),
        signal_id: String(signal.id),
        stage: "CANDIDATE_FILTER",
        decision: "REJECT",
        reason: "max_open_positions_reached",
        confidence: Number(signal.confidence),
        details: {
          min_confidence: MIN_CONFIDENCE,
          window_minutes: 15,
          remaining_slots: 0,
        },
      }));

      if (error) {
        auditEvents.push({
          ts: new Date().toISOString(),
          symbol: "",
          signal_id: "",
          stage: "ERROR",
          decision: "ERROR",
          reason: error.message,
          confidence: 0,
          details: { phase: "eligible_signal_audit_query" },
        });
      }

      return new Response(JSON.stringify({
        mode: tradingMode,
        opened: 0,
        skipped: 0,
        errors: error ? [{ signal_id: "", symbol: "", error: error.message }] : [],
        reason: "max_open_positions_reached",
        execution_audit: {
          version: 1,
          started_at: auditStartedAt,
          completed_at: new Date().toISOString(),
          status: "completed",
          trades: 0,
          summary: {
            eligible_buy_signals: (signals ?? []).length,
            audited_eligible_signals: auditEvents.filter((e) => e.stage === "CANDIDATE_FILTER").length,
            uncovered_eligible_signals: 0,
            opened: 0,
            skipped: 0,
            errors: error ? 1 : 0,
          },
          events: auditEvents,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: signals, error } = await getEligibleSignals(supabase);
    if (error) throw error;

    const opened = [];
    const errors: Array<{ signal_id: string; symbol: string; error: string }> = [];
    const auditEvents: Array<Record<string, unknown>> = [];

    for (const signal of signals ?? []) {
      auditEvents.push({
        ts: new Date().toISOString(),
        symbol: String(signal.symbol),
        signal_id: String(signal.id),
        stage: "CANDIDATE_FILTER",
        decision: "ACCEPT",
        reason: "eligible BUY reached trade executor",
        confidence: Number(signal.confidence),
        details: { min_confidence: MIN_CONFIDENCE, window_minutes: 15 },
      });
    }

    let skipped = 0;

    for (const signal of signals ?? []) {
      if (opened.length >= remainingSlots) break;

      const { data: existing } = await supabase
        .from("trades")
        .select("id")
        .eq("composite_signal_id", signal.id)
        .limit(1);

      if (existing && existing.length > 0) {
        skipped++;
        continue;
      }

      try {
        const price = await getCurrentPrice(signal.symbol);
        const quantity = PAPER_POSITION_USD / price;
        const stopLoss = price * (1 - STOP_LOSS_PCT);
        const takeProfit = price * (1 + TAKE_PROFIT_PCT);

        const { data: trade, error: tradeErr } = await supabase
          .from("trades")
          .insert({
            composite_signal_id: signal.id,
            symbol: signal.symbol,
            side: "buy",
            quantity,
            entry_price: price,
            stop_loss: stopLoss,
            take_profit: takeProfit,
            mode: "paper",
            status: "open",
            exchange_order_id: null,
            source_tags: ["paper", "trade-executor", "spot-long-only"],
          })
          .select()
          .single();

        if (tradeErr) throw new Error(tradeErr.message);
        opened.push(trade);
      } catch (err) {
        errors.push({
          signal_id: String(signal.id),
          symbol: String(signal.symbol),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return new Response(JSON.stringify({
      mode: "paper",
      opened: opened.length,
      skipped,
      errors,
      remaining_slots: Math.max(0, remainingSlots - opened.length),
      trades: opened,
      execution_audit: {
        version: 1,
        started_at: auditStartedAt,
        completed_at: new Date().toISOString(),
        status: "completed",
        trades: opened.length,
        summary: {
          eligible_buy_signals: (signals ?? []).length,
          audited_eligible_signals: auditEvents.filter((e) => e.stage === "CANDIDATE_FILTER").length,
          uncovered_eligible_signals: 0,
          opened: opened.length,
          skipped,
          errors: errors.length,
        },
        events: auditEvents,
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[trade-executor] fatal", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
import { handleOptions, corsHeaders } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const MIN_CONFIDENCE = 0.6;
const PAPER_POSITION_USD = 1000;
const STOP_LOSS_PCT = 0.03;
const TAKE_PROFIT_PCT = 0.06;
const EXECUTION_WINDOW_MINUTES = 15;
const MAX_AUDIT_SIGNALS = 500;

async function getCurrentPrice(symbol: string): Promise<number> {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
  if (!res.ok) throw new Error(`price fetch failed for ${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  const price = Number(data?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`invalid price for ${symbol}`);
  }
  return price;
}

async function getEligibleSignals(supabase: ReturnType<typeof getServiceClient>) {
  const since = new Date(Date.now() - EXECUTION_WINDOW_MINUTES * 60 * 1000).toISOString();

  return supabase
    .from("composite_signals")
    .select("*")
    .gte("created_at", since)
    .gte("confidence", MIN_CONFIDENCE)
    .eq("recommendation", "buy")
    .order("created_at", { ascending: false })
    .limit(MAX_AUDIT_SIGNALS);
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const auditStartedAt = new Date().toISOString();

  try {
    const supabase = getServiceClient();
    const tradingMode = Deno.env.get("TRADING_MODE") ?? "paper";

    // Live order placement remains explicitly disabled.
    if (tradingMode === "live") {
      return new Response(JSON.stringify({
        error:
          "Live execution is intentionally blocked in phase 1. Use paper mode until a verified live-order adapter is implemented.",
      }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: signals, error: signalError } = await getEligibleSignals(supabase);
    if (signalError) throw signalError;

    const eligibleSignals = signals ?? [];
    const signalIds = eligibleSignals.map((signal) => String(signal.id));

    // Research-mode paper execution deliberately does NOT use MAX_OPEN_POSITIONS,
    // daily-loss, portfolio-risk, loss-streak, symbol-cooldown, or held-symbol
    // capacity as an opportunity filter. The research objective is to measure
    // every distinct eligible BUY signal. Only the exact same composite signal
    // is deduplicated.
    const { data: existingTrades, error: existingError } = signalIds.length
      ? await supabase
          .from("trades")
          .select("id,composite_signal_id")
          .in("composite_signal_id", signalIds)
      : { data: [], error: null };

    if (existingError) throw existingError;

    const existingSignalIds = new Set(
      (existingTrades ?? []).map((row) => String(row.composite_signal_id)),
    );

    const opened: unknown[] = [];
    const errors: Array<{ signal_id: string; symbol: string; error: string }> = [];
    const auditEvents: Array<Record<string, unknown>> = [];

    for (const signal of eligibleSignals) {
      const signalId = String(signal.id);
      const symbol = String(signal.symbol);
      const confidence = Number(signal.confidence);

      if (existingSignalIds.has(signalId)) {
        auditEvents.push({
          ts: new Date().toISOString(),
          symbol,
          signal_id: signalId,
          stage: "CANDIDATE_FILTER",
          decision: "SKIP",
          reason: "duplicate_composite_signal",
          confidence,
          details: {
            min_confidence: MIN_CONFIDENCE,
            window_minutes: EXECUTION_WINDOW_MINUTES,
            research_mode: true,
          },
        });
        continue;
      }

      auditEvents.push({
        ts: new Date().toISOString(),
        symbol,
        signal_id: signalId,
        stage: "CANDIDATE_FILTER",
        decision: "ACCEPT",
        reason: "eligible BUY accepted in paper research mode",
        confidence,
        details: {
          min_confidence: MIN_CONFIDENCE,
          window_minutes: EXECUTION_WINDOW_MINUTES,
          research_mode: true,
          capacity_gate: "bypassed",
        },
      });

      try {
        const price = await getCurrentPrice(symbol);
        const quantity = PAPER_POSITION_USD / price;
        const stopLoss = price * (1 - STOP_LOSS_PCT);
        const takeProfit = price * (1 + TAKE_PROFIT_PCT);

        const { data: trade, error: tradeError } = await supabase
          .from("trades")
          .insert({
            composite_signal_id: signal.id,
            symbol,
            side: "buy",
            quantity,
            entry_price: price,
            stop_loss: stopLoss,
            take_profit: takeProfit,
            mode: "paper",
            status: "open",
            exchange_order_id: null,
            source_tags: [
              "paper",
              "trade-executor",
              "spot-long-only",
              "research-unbounded",
            ],
          })
          .select()
          .single();

        if (tradeError) throw new Error(tradeError.message);

        opened.push(trade);
        existingSignalIds.add(signalId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ signal_id: signalId, symbol, error: message });

        const event = auditEvents[auditEvents.length - 1];
        if (event?.signal_id === signalId) {
          event.decision = "ERROR";
          event.reason = "paper_trade_insert_failed";
          event.details = {
            ...(event.details as Record<string, unknown>),
            error: message,
          };
        }
      }
    }

    const completedAt = new Date().toISOString();

    return new Response(JSON.stringify({
      mode: "paper",
      research_mode: true,
      opened: opened.length,
      skipped: auditEvents.filter((event) => event.decision === "SKIP").length,
      errors,
      capacity: {
        max_open_positions_config: 3,
        gate_applied: false,
        reason: "paper_research_mode",
      },
      trades: opened,
      execution_audit: {
        version: 2,
        started_at: auditStartedAt,
        completed_at: completedAt,
        status: "completed",
        trades: opened.length,
        summary: {
          eligible_buy_signals: eligibleSignals.length,
          audited_eligible_signals: auditEvents.length,
          uncovered_eligible_signals: Math.max(
            0,
            eligibleSignals.length - auditEvents.length,
          ),
          opened: opened.length,
          skipped: auditEvents.filter((event) => event.decision === "SKIP").length,
          errors: errors.length,
        },
        events: auditEvents,
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[trade-executor] fatal", err);
    return new Response(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      execution_audit: {
        version: 2,
        started_at: auditStartedAt,
        completed_at: new Date().toISOString(),
        status: "error",
        trades: 0,
        summary: {
          eligible_buy_signals: 0,
          audited_eligible_signals: 0,
          uncovered_eligible_signals: 0,
          opened: 0,
          skipped: 0,
          errors: 1,
        },
        events: [{
          ts: new Date().toISOString(),
          symbol: "",
          signal_id: "",
          stage: "ERROR",
          decision: "ERROR",
          reason: err instanceof Error ? err.message : String(err),
          confidence: 0,
          details: { phase: "trade_executor" },
        }],
      },
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

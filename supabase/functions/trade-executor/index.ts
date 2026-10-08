import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function handleOptions(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders });
}
function getServiceClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}


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

      if (confidence < MIN_CONFIDENCE) {
        auditEvents.push({
          ts: new Date().toISOString(), symbol, signal_id: signalId,
          stage: "QUALITY_GATE", decision: "REJECT",
          reason: "confidence_below_minimum", confidence,
          details: { min_confidence: MIN_CONFIDENCE, research_mode: true },
        });
        await supabase.from("repeated_buy_research_ledger")
          .update({ research_decision: "rejected", research_reason: "confidence_below_minimum_0.60" })
          .eq("composite_signal_id", signalId)
          .eq("research_decision", "pending_execution_audit");
        continue;
      }

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
        await supabase.from("repeated_buy_research_ledger")
          .update({ research_decision: "duplicate_signal", research_reason: "duplicate_composite_signal_already_has_trade" })
          .eq("composite_signal_id", signalId)
          .eq("research_decision", "pending_execution_audit");
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
        await supabase.from("repeated_buy_research_ledger")
          .update({
            research_decision: "opened",
            research_reason: "paper trade opened for eligible BUY",
            trade_id: trade.id,
            entry_at: trade.created_at ?? new Date().toISOString(),
            entry_price: trade.entry_price ?? price,
            entry_quantity: trade.quantity ?? quantity,
            entry_notional: Number(trade.entry_price ?? price) * Number(trade.quantity ?? quantity),
            entry_fee: Number(trade.entry_fee ?? 0),
          })
          .eq("composite_signal_id", signalId)
          .in("research_decision", ["pending_execution_audit", "pending"]);
        existingSignalIds.add(signalId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ signal_id: signalId, symbol, error: message });

        await supabase.from("repeated_buy_research_ledger")
          .update({ research_decision: "execution_error", research_reason: message })
          .eq("composite_signal_id", signalId)
          .eq("research_decision", "pending_execution_audit");

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

    // Mirror realized trade accounting into the observational ledger.
    const { data: ledgerTrades } = await supabase.from("repeated_buy_research_ledger")
      .select("id,trade_id").not("trade_id", "is", null).limit(1000);
    for (const item of ledgerTrades ?? []) {
      const { data: trade } = await supabase.from("trades")
        .select("id,status,entry_price,quantity,created_at,closed_at,exit_price,gross_pnl,net_pnl,entry_fee,exit_fee,total_fees")
        .eq("id", item.trade_id).maybeSingle();
      if (trade) await supabase.from("repeated_buy_research_ledger").update({
        entry_at: trade.created_at,
        entry_price: trade.entry_price,
        entry_quantity: trade.quantity,
        entry_notional: Number(trade.entry_price ?? 0) * Number(trade.quantity ?? 0),
        entry_fee: Number(trade.entry_fee ?? 0),
        exit_at: trade.closed_at,
        exit_price: trade.exit_price,
        gross_pnl: trade.gross_pnl,
        total_fees: trade.total_fees,
        net_pnl: trade.net_pnl,
      }).eq("id", item.id);
    }

    // Fixed-horizon markouts: first executor run at/after each horizon, priced from Binance.
    const { data: dueRows } = await supabase.from("repeated_buy_research_ledger")
      .select("id,symbol,signal_price,observed_at,limited_position_decision,markout_15m_at,markout_1h_at,markout_4h_at,markout_24h_at,markout_72h_at")
      .eq("recommendation", "buy")
      .lt("observed_at", new Date(Date.now() - 15 * 60 * 1000).toISOString())
      .or("markout_15m_at.is.null,markout_1h_at.is.null,markout_4h_at.is.null,markout_24h_at.is.null,markout_72h_at.is.null")
      .limit(500);
    const priceCache = new Map<string, number>();
    for (const row of dueRows ?? []) {
      const age = Date.now() - new Date(row.observed_at).getTime();
      const horizons = [
        { ms: 15 * 60 * 1000, col: "15m", done: row.markout_15m_at },
        { ms: 60 * 60 * 1000, col: "1h", done: row.markout_1h_at },
        { ms: 4 * 60 * 60 * 1000, col: "4h", done: row.markout_4h_at },
        { ms: 24 * 60 * 60 * 1000, col: "24h", done: row.markout_24h_at },
        { ms: 72 * 60 * 60 * 1000, col: "72h", done: row.markout_72h_at },
      ];
      const due = horizons.filter((h) => age >= h.ms && !h.done);
      if (!due.length) continue;
      try {
        let price = priceCache.get(String(row.symbol));
        if (price === undefined) {
          price = await getCurrentPrice(String(row.symbol));
          priceCache.set(String(row.symbol), price);
        }
        const base = Number(row.signal_price);
        if (!Number.isFinite(base) || base <= 0) continue;
        const patch: Record<string, unknown> = {};
        for (const h of due) {
          const prefix = h.col === "15m" ? "markout_15m" : h.col === "1h" ? "markout_1h" : h.col === "4h" ? "markout_4h" : h.col === "24h" ? "markout_24h" : "markout_72h";
          const pct = ((price / base) - 1) * 100;
          patch[prefix + "_price"] = price;
          patch[prefix + "_at"] = new Date().toISOString();
          patch[prefix + "_pct"] = pct;
          if (row.limited_position_decision === "would_open") {
            const lp = h.col === "15m" ? "limited_position_markout_15m" : h.col === "1h" ? "limited_position_markout_1h" : h.col === "4h" ? "limited_position_markout_4h" : h.col === "24h" ? "limited_position_markout_24h" : "limited_position_markout_72h";
            patch[lp + "_pct"] = pct;
          }
        }
        await supabase.from("repeated_buy_research_ledger").update(patch).eq("id", row.id);
      } catch (err) {
        console.error("[REPEATED_BUY_LEDGER] markout update failed:", row.symbol, String(err));
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
          buy_signals_seen: eligibleSignals.length,
          eligible_buy_signals: eligibleSignals.filter((s) => Number(s.confidence) >= MIN_CONFIDENCE).length,
          audited_eligible_signals: auditEvents.filter((e) => Number(e.confidence) >= MIN_CONFIDENCE).length,
          uncovered_eligible_signals: Math.max(0,
            eligibleSignals.filter((s) => Number(s.confidence) >= MIN_CONFIDENCE).length -
            auditEvents.filter((e) => Number(e.confidence) >= MIN_CONFIDENCE).length),
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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  binancePair,
  decideExit,
  normalizeExitSettings,
  type OpenTradeRow,
} from "../_shared/trade-exit.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const ESCALATE_AFTER_MS = 3 * 60 * 1000;

function handleOptions(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders });
}
function getServiceClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

async function fetchAllSpotPrices(): Promise<{ prices: Map<string, number>; host: string | null; errors: string[] }> {
  const hosts = ["https://api.binance.com", "https://data-api.binance.vision", "https://api1.binance.com"];
  const errors: string[] = [];
  for (const host of hosts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${host}/api/v3/ticker/price`, { signal: controller.signal });
      if (!response.ok) {
        errors.push(`${host}: HTTP ${response.status}`);
        continue;
      }
      const rows = (await response.json()) as Array<{ symbol: string; price: string }>;
      const prices = new Map<string, number>();
      for (const row of rows) {
        const price = Number(row.price);
        if (Number.isFinite(price) && price > 0) prices.set(row.symbol, price);
      }
      if (prices.size) return { prices, host, errors };
      errors.push(`${host}: empty ticker response`);
    } catch (error) {
      errors.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { prices: new Map(), host: null, errors };
}

type AlertInput = {
  alert_key: string;
  trade_id?: string | null;
  symbol?: string | null;
  alert_code: string;
  message: string;
  evidence: Record<string, unknown>;
};
async function raiseAlert(
  supabase: ReturnType<typeof getServiceClient>,
  input: AlertInput,
  now: string,
) {
  const { data: existing, error: readError } = await supabase
    .from("trade_position_alerts")
    .select("id,first_seen_at,status")
    .eq("alert_key", input.alert_key)
    .maybeSingle();
  if (readError) throw readError;

  const isSameActiveIncident = existing?.status === "active";
  const age = isSameActiveIncident ? Date.parse(now) - Date.parse(existing.first_seen_at) : 0;
  const severity = age >= ESCALATE_AFTER_MS ? "critical" : "warning";
  const payload = {
    ...input,
    severity,
    status: "active",
    last_seen_at: now,
    resolved_at: null,
    updated_at: now,
    ...(!isSameActiveIncident ? { first_seen_at: now } : {}),
  };
  if (existing) {
    const { error } = await supabase.from("trade_position_alerts").update(payload).eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("trade_position_alerts").insert({
      ...payload,
      first_seen_at: now,
      created_at: now,
    });
    if (error) throw error;
  }
  return severity;
}
async function resolveAlert(supabase: ReturnType<typeof getServiceClient>, alertKey: string, now: string) {
  const { error } = await supabase
    .from("trade_position_alerts")
    .update({ status: "resolved", resolved_at: now, updated_at: now })
    .eq("alert_key", alertKey)
    .eq("status", "active");
  if (error) throw error;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const supabase = getServiceClient();
  const startedAt = new Date().toISOString();
  const result = {
    status: "ok",
    open_positions: 0,
    exit_due: 0,
    price_unavailable: 0,
    alerts_raised: 0,
    alerts_escalated: 0,
    resolved: 0,
    price_host: null as string | null,
    errors: [] as string[],
    auto_close: false,
  };

  try {
    const { data: settingsRow, error: settingsError } = await supabase
      .from("pipeline_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (settingsError) result.errors.push(`settings: ${settingsError.message}`);
    const settings = normalizeExitSettings(settingsRow as Record<string, unknown> | null);

    const { data: rows, error: tradesError } = await supabase
      .from("trades")
      .select("id,symbol,side,mode,quantity,entry_price,stop_loss,take_profit,created_at")
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .range(0, 4999);
    if (tradesError) throw tradesError;
    const openTrades = (rows ?? []) as OpenTradeRow[];
    result.open_positions = openTrades.length;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const openIds = new Set(openTrades.map((trade) => trade.id));

    const { prices, host, errors: priceErrors } = openTrades.length
      ? await fetchAllSpotPrices()
      : { prices: new Map<string, number>(), host: null, errors: [] as string[] };
    result.price_host = host;
    if (openTrades.length && !prices.size) {
      result.errors.push(`all market price sources unavailable: ${priceErrors.join("; ")}`);
      const severity = await raiseAlert(supabase, {
        alert_key: "system:position_watchdog_price_feed",
        alert_code: "market_price_feed_unavailable",
        message: "CRITICAL MONITORING GAP: market prices are unavailable, so open positions cannot be checked for exit conditions.",
        evidence: { price_errors: priceErrors, open_positions: openTrades.length },
      }, now);
      result.alerts_raised++;
      if (severity === "critical") result.alerts_escalated++;
    } else {
      await resolveAlert(supabase, "system:position_watchdog_price_feed", now);
    }

    for (const trade of openTrades) {
      const price = prices.get(binancePair(trade.symbol));
      const priceKey = `trade:${trade.id}:price_unavailable`;
      const exitKey = `trade:${trade.id}:exit_due_still_open`;

      if (price == null) {
        result.price_unavailable++;
        const severity = await raiseAlert(supabase, {
          alert_key: priceKey,
          trade_id: trade.id,
          symbol: trade.symbol,
          alert_code: "position_price_unavailable",
          message: `${trade.symbol}: watchdog cannot verify this open position because no current Binance price is available.`,
          evidence: { trade_id: trade.id, created_at: trade.created_at, price_host: host, price_errors: priceErrors },
        }, now);
        result.alerts_raised++;
        if (severity === "critical") result.alerts_escalated++;
        continue;
      }

      const decision = decideExit(trade, price, settings, nowMs);
      if (decision.action === "close" || decision.action === "skip_live_requires_exchange") {
        result.exit_due++;
        const reason = decision.reason;
        const severity = await raiseAlert(supabase, {
          alert_key: exitKey,
          trade_id: trade.id,
          symbol: trade.symbol,
          alert_code: "exit_due_still_open",
          message: `${trade.symbol}: EXIT CONDITION ${reason.toUpperCase()} is active, but the position is still OPEN. The watchdog is alert-only and has not closed the position.`,
          evidence: {
            trade_id: trade.id,
            mode: trade.mode,
            reason,
            current_price: price,
            entry_price: Number(trade.entry_price),
            stop_loss: trade.stop_loss == null ? null : Number(trade.stop_loss),
            take_profit: trade.take_profit == null ? null : Number(trade.take_profit),
            age_hours: (nowMs - Date.parse(trade.created_at)) / 3_600_000,
            decision: decision.action,
            first_detected_at: startedAt,
          },
        }, now);
        result.alerts_raised++;
        if (severity === "critical") result.alerts_escalated++;
      } else {
        await resolveAlert(supabase, exitKey, now);
      }
      await resolveAlert(supabase, priceKey, now);
    }

    // If an alarm belongs to a position that is no longer open, resolve it.
    const { data: activeTradeAlerts, error: alertsError } = await supabase
      .from("trade_position_alerts")
      .select("alert_key,trade_id")
      .eq("status", "active")
      .not("trade_id", "is", null);
    if (alertsError) throw alertsError;
    for (const alert of activeTradeAlerts ?? []) {
      if (alert.trade_id && !openIds.has(alert.trade_id)) {
        await resolveAlert(supabase, alert.alert_key, now);
        result.resolved++;
      }
    }

    await resolveAlert(supabase, "system:position_watchdog_failed", now);
    if (result.errors.length) result.status = "partial";
    console.log("[TRADE_POSITION_WATCHDOG]", JSON.stringify(result));
    return new Response(JSON.stringify({ ...result, checked_at: now }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    result.status = "error";
    result.errors.push(message);
    try {
      const severity = await raiseAlert(supabase, {
        alert_key: "system:position_watchdog_failed",
        alert_code: "position_watchdog_failed",
        message: `POSITION WATCHDOG FAILED: ${message}`,
        evidence: { error: message, started_at: startedAt },
      }, now);
      if (severity === "critical") result.alerts_escalated++;
      result.alerts_raised++;
    } catch (alertError) {
      console.error("[TRADE_POSITION_WATCHDOG] could not persist failure alarm", String(alertError));
    }
    console.error("[TRADE_POSITION_WATCHDOG] FAILED", JSON.stringify(result));
    return new Response(JSON.stringify({ ...result, checked_at: now }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

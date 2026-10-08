import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const RESOLVER_START_AT = "2026-10-06T09:57:00.000Z";
const MIN_AGE_MS = 60 * 60 * 1000;
const EXPIRY_TRIGGER_HOURS = 72;
const CANDLE_LIMIT = 1000;
const CONCURRENCY = 8;
const RESOLVER_VERSION = 3;
function audit(event: string, details: Record<string, unknown>) {
  console.log("[VARIANT_RESOLVER_AUDIT]", JSON.stringify({resolver_version: RESOLVER_VERSION,event,...details}));
}

type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  openTimeMs: number;
  closeTimeMs: number;
};

type Variant = {
  id: string;
  symbol: string;
  recommendation: "buy" | "sell";
  entry_price: number;
  created_at: string;
};

type Outcome = "win" | "loss" | "expired" | "ambiguous";

async function fetchKlines(symbol: string, interval: string): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${CANDLE_LIMIT}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Binance klines HTTP ${response.status}`);
  const rows = await response.json() as unknown[][];
  return rows.map((r) => ({
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    openTimeMs: Number(r[0]),
    closeTimeMs: Number(r[6]),
  })).filter((c) =>
    Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low) && Number.isFinite(c.close) &&
    Number.isFinite(c.openTimeMs) && Number.isFinite(c.closeTimeMs)
  ).sort((a, b) => a.openTimeMs - b.openTimeMs);
}

async function fetchResolutionCandles(symbol: string, interval: string, openTimeMs?: number, closeTimeMs?: number): Promise<Candle[]> {
  try {
    const candles = await fetchKlines(symbol, interval);
    return candles.filter((c) =>
      (openTimeMs == null || c.closeTimeMs > openTimeMs) &&
      (closeTimeMs == null || c.openTimeMs < closeTimeMs)
    );
  } catch {
    return [];
  }
}

async function resolveAmbiguous(
  symbol: string,
  side: "buy" | "sell",
  tpPrice: number,
  slPrice: number,
  parent: Candle,
  variantId?: string,
): Promise<Outcome> {
  for (const timeframe of ["5m", "15m"] as const) {
    const lower = await fetchResolutionCandles(symbol, timeframe, parent.openTimeMs, parent.closeTimeMs);
    audit("lower_timeframe_scan",{variant_id:variantId??null,symbol,side,timeframe,parent_open_time:new Date(parent.openTimeMs).toISOString(),parent_close_time:new Date(parent.closeTimeMs).toISOString(),candle_count:lower.length,tp_price:tpPrice,sl_price:slPrice});
    if (lower.length === 0) continue;

    for (const candle of lower) {
      const hitTP = side === "buy" ? candle.high >= tpPrice : candle.low <= tpPrice;
      const hitSL = side === "buy" ? candle.low <= slPrice : candle.high >= slPrice;

      // Same lower-timeframe candle touched both levels: terminal AMBIGUOUS.
      if (hitTP && hitSL) { audit("lower_timeframe_ambiguous",{variant_id:variantId??null,symbol,timeframe,candle_open_time:new Date(candle.openTimeMs).toISOString(),high:candle.high,low:candle.low,close:candle.close}); return "ambiguous"; }
      if (hitTP) { audit("lower_timeframe_tp_first",{variant_id:variantId??null,symbol,timeframe,candle_open_time:new Date(candle.openTimeMs).toISOString()}); return "win"; }
      if (hitSL) { audit("lower_timeframe_sl_first",{variant_id:variantId??null,symbol,timeframe,candle_open_time:new Date(candle.openTimeMs).toISOString()}); return "loss"; }
    }
  }

  // If lower-timeframe data cannot establish order, fail conservatively.
  return "ambiguous";
}

async function mapConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

Deno.serve(async () => {
  const nowMs = Date.now();
  const maxAgeIso = new Date(nowMs - MIN_AGE_MS).toISOString();

  const { data: rows, error } = await supabase
    .from("strategy_variant_signals")
    .select("id, symbol, recommendation, entry_price, created_at")
    .eq("outcome", "open")
    .in("recommendation", ["buy", "sell"])
    .not("entry_price", "is", null)
    .gt("created_at", RESOLVER_START_AT)
    .lte("created_at", maxAgeIso)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const variants = (rows ?? []).map((r) => ({
    id: String(r.id),
    symbol: String(r.symbol),
    recommendation: String(r.recommendation).toLowerCase() as "buy" | "sell",
    entry_price: Number(r.entry_price),
    created_at: String(r.created_at),
  })).filter((v) =>
    Number.isFinite(v.entry_price) && v.entry_price > 0 &&
    (v.recommendation === "buy" || v.recommendation === "sell")
  ) as Variant[];

  if (variants.length === 0) {
    return new Response(JSON.stringify({ ok: true, resolved: 0, skipped_historical: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const settingsResult = await supabase
    .from("pipeline_settings")
    .select("variant_tp_pct, variant_sl_pct, variant_max_hours")
    .eq("id", 1)
    .single();

  if (settingsResult.error || !settingsResult.data) {
    return new Response(JSON.stringify({
      ok: false,
      error: settingsResult.error?.message ?? "pipeline settings unavailable",
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const tpPct = Number(settingsResult.data.variant_tp_pct);
  const slPct = Number(settingsResult.data.variant_sl_pct);
  const maxHours = Number(settingsResult.data.variant_max_hours);

  const symbols = [...new Set(variants.map((v) => v.symbol))];
  const candleResults = await mapConcurrent(symbols, async (symbol) => {
    try {
      return { symbol, candles: await fetchResolutionCandles(symbol, "1h") };
    } catch {
      return { symbol, candles: [] as Candle[] };
    }
  });
  const candlesBySymbol = new Map(candleResults.map((x) => [x.symbol, x.candles]));

  let resolved = 0;
  let expiryTriggerCount = 0;
  const expiryTriggerSymbols: string[] = [];
  const outcomes: Record<string, number> = { win: 0, loss: 0, expired: 0, ambiguous: 0 };

  for (const variant of variants) {
    const entryMs = new Date(variant.created_at).getTime();
    if (!Number.isFinite(entryMs)) continue;

    const candles = candlesBySymbol.get(variant.symbol) ?? [];
    audit("candidate_selected",{variant_id:variant.id,symbol:variant.symbol,side:variant.recommendation,created_at:variant.created_at,entry_price:variant.entry_price,age_hours:Number(((nowMs-entryMs)/3600000).toFixed(3)),candle_count_1h:candles.length});
    const tpPrice = variant.recommendation === "buy"
      ? variant.entry_price * (1 + tpPct)
      : variant.entry_price * (1 - tpPct);
    const slPrice = variant.recommendation === "buy"
      ? variant.entry_price * (1 - slPct)
      : variant.entry_price * (1 + slPct);

    const relevant = candles.filter((c) =>
      c.closeTimeMs > entryMs && c.closeTimeMs <= nowMs
    );
    audit("1h_window",{variant_id:variant.id,symbol:variant.symbol,candle_count:relevant.length,first_candle_open_time:relevant[0]?new Date(relevant[0].openTimeMs).toISOString():null,last_candle_open_time:relevant[relevant.length-1]?new Date(relevant[relevant.length-1].openTimeMs).toISOString():null,tp_price:tpPrice,sl_price:slPrice});

    let outcome: Outcome | null = null;
    let exitPrice: number | null = null;

    for (const candle of relevant) {
      const hitTP = variant.recommendation === "buy" ? candle.high >= tpPrice : candle.low <= tpPrice;
      const hitSL = variant.recommendation === "buy" ? candle.low <= slPrice : candle.high >= slPrice;

      if (hitTP && hitSL) {
        audit("1h_same_candle_tp_sl",{variant_id:variant.id,symbol:variant.symbol,candle_open_time:new Date(candle.openTimeMs).toISOString(),high:candle.high,low:candle.low,close:candle.close,tp_price:tpPrice,sl_price:slPrice});
        outcome = await resolveAmbiguous(
          variant.symbol,
          variant.recommendation,
          tpPrice,
          slPrice,
          candle,
          variant.id,
        );
        if (outcome === "win") exitPrice = tpPrice;
        if (outcome === "loss") exitPrice = slPrice;
        break;
      }
      if (hitTP) {
        audit("1h_tp_hit",{variant_id:variant.id,symbol:variant.symbol,candle_open_time:new Date(candle.openTimeMs).toISOString(),high:candle.high,low:candle.low,close:candle.close,tp_price:tpPrice});
        outcome = "win";
        exitPrice = tpPrice;
        break;
      }
      if (hitSL) {
        audit("1h_sl_hit",{variant_id:variant.id,symbol:variant.symbol,candle_open_time:new Date(candle.openTimeMs).toISOString(),high:candle.high,low:candle.low,close:candle.close,sl_price:slPrice});
        outcome = "loss";
        exitPrice = slPrice;
        break;
      }
    }

    const ageHours = (nowMs - entryMs) / 3_600_000;
    if (!outcome && ageHours >= EXPIRY_TRIGGER_HOURS) {
      expiryTriggerCount += 1;
      audit("72h_trigger",{variant_id:variant.id,symbol:variant.symbol,created_at:variant.created_at,age_hours:Number(ageHours.toFixed(3)),trigger_hours:EXPIRY_TRIGGER_HOURS,max_hours:maxHours});
      expiryTriggerSymbols.push(variant.symbol);
      console.warn("[VARIANT_72H_TRIGGER]", JSON.stringify({ id: variant.id, symbol: variant.symbol, created_at: variant.created_at, age_hours: Number(ageHours.toFixed(2)), trigger_hours: EXPIRY_TRIGGER_HOURS }));
    }

    if (!outcome && ageHours >= maxHours) {
      const expiryCandle = relevant[relevant.length - 1];
      if (expiryCandle) {
        audit("expiry_decision",{variant_id:variant.id,symbol:variant.symbol,expiry_candle_open_time:new Date(expiryCandle.openTimeMs).toISOString(),close:expiryCandle.close,age_hours:Number(ageHours.toFixed(3)),max_hours:maxHours});
        outcome = "expired";
        exitPrice = expiryCandle.close;
      }
    }

    if (!outcome) continue;

    const pnlPct = outcome === "ambiguous" || exitPrice == null
      ? null
      : variant.recommendation === "buy"
        ? ((exitPrice - variant.entry_price) / variant.entry_price) * 100
        : ((variant.entry_price - exitPrice) / variant.entry_price) * 100;

    const update = await supabase
      .from("strategy_variant_signals")
      .update({
        outcome,
        exit_price: outcome === "ambiguous" ? null : exitPrice,
        pnl_pct: pnlPct,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", variant.id)
      .eq("outcome", "open");

    if (update.error) {
      audit("db_update_failed",{variant_id:variant.id,symbol:variant.symbol,outcome,exit_price:exitPrice,pnl_pct:pnlPct,error:update.error.message});
      console.error("[VARIANT_RESOLVER] update failed", variant.id, update.error);
      continue;
    }

    audit("resolved",{variant_id:variant.id,symbol:variant.symbol,side:variant.recommendation,outcome,exit_price:exitPrice,pnl_pct:pnlPct,age_hours:Number(ageHours.toFixed(3))});
    resolved += 1;
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }

  return new Response(JSON.stringify({
    ok: true,
    resolved,
    outcomes,
    candidates: variants.length,
    expiry_trigger_hours: EXPIRY_TRIGGER_HOURS,
    expiry_triggered: expiryTriggerCount,
    expiry_trigger_symbols: [...new Set(expiryTriggerSymbols)],
    historical_cutoff: RESOLVER_START_AT,
  }), { headers: { "Content-Type": "application/json" } });
});
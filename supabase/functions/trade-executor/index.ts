import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { binancePair, decideExit, getBreakevenStopLossUpdate, normalizeExitSettings, type OpenTradeRow } from "../_shared/trade-exit.ts";
import { aggregateWhaleShocks, DEFAULT_WHALE_SHOCK_CONFIG, evaluate1hTechnicalConfirmation, evaluateRegimeShockTransition, recordWhaleShockRejection } from "./_shared/whale-shock.ts";
import { evaluateMicroTimeframeGate, type MicroTimeframeState } from "./_shared/micro-trend-gate.ts";
import { computeMarketRegimeAssessment, evaluateSidewaysEntryGate, type MarketRegimeAssessment } from "./_shared/market-regime-gate.ts";
import { computeDivergenceAssessment, evaluateBtcDowntrendEntryGate, evaluateBtcTrend, type BtcTrendMetrics } from "./_shared/regime-divergence.ts";
import { summarizeEligibleSignalAudit } from "../_shared/execution-audit.ts";

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
// Keep in sync with public.trading_fee_rate() and src/lib/fees.ts (0.05% per side).
const TRADING_FEE_RATE = 0.0005;
const STOP_LOSS_PCT = 0.03;
const TAKE_PROFIT_PCT = 0.06;
const EXECUTION_WINDOW_MINUTES = 15;
const MAX_AUDIT_SIGNALS = 500;
const MAX_ACTIVE_TRADES_PER_SYMBOL = 1;

function normalizeExposureSymbol(value: unknown): string {
  return String(value ?? "").trim().toUpperCase().replace(/USDT$/, "");
}

async function getActiveSymbolPositions(
  supabase: ReturnType<typeof getServiceClient>,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("trades")
      .select("id,symbol")
      .eq("status", "open")
      .eq("side", "buy")
      .eq("mode", "paper")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`active symbol exposure query failed: ${error.message}`);
    const rows = data ?? [];
    for (const row of rows) {
      const symbol = normalizeExposureSymbol(row.symbol);
      if (symbol) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    if (rows.length < pageSize) break;
  }
  return counts;
}

type MicroGateAssessment = {
  ready: boolean;
  state: MicroTimeframeState | null;
  decision: ReturnType<typeof evaluateMicroTimeframeGate> | null;
  reason: string;
};

type LiveMarketRegime = {
  ready: boolean;
  assessment: MarketRegimeAssessment | null;
  reason: string;
};

// Allow modest cron/runtime drift while still requiring recent micro-timeframe data.
const MICRO_SNAPSHOT_MAX_AGE_MS = 25 * 60 * 1000;

async function assessMicroTimeframes(
  supabase: ReturnType<typeof getServiceClient>,
  symbol: string,
): Promise<MicroGateAssessment> {
  const base = String(symbol).toUpperCase().replace(/USDT$/, "");
  const candidates = [...new Set([base, `${base}USDT`])];
  const { data, error } = await supabase
    .from("indicator_snapshots")
    .select("symbol,timeframe,signal,rsi,created_at")
    .in("symbol", candidates)
    .in("timeframe", ["5m", "15m", "1h"])
    .order("created_at", { ascending: false })
    .limit(12);

  if (error) return { ready: false, state: null, decision: null, reason: `snapshot query failed: ${error.message}` };

  const byTf = new Map<string, any>();
  for (const row of data ?? []) {
    const tf = String(row.timeframe);
    if (!byTf.has(tf)) byTf.set(tf, row);
  }

  const missing: string[] = [];
  const stale: string[] = [];
  for (const tf of ["5m", "15m", "1h"]) {
    const row = byTf.get(tf);
    if (!row) { missing.push(tf); continue; }
    const age = Date.now() - new Date(String(row.created_at ?? "")).getTime();
    if (!Number.isFinite(age) || age < 0 || age > MICRO_SNAPSHOT_MAX_AGE_MS) stale.push(tf);
  }
  if (missing.length || stale.length) {
    const parts = [];
    if (missing.length) parts.push(`missing=${missing.join(",")}`);
    if (stale.length) parts.push(`stale>${MICRO_SNAPSHOT_MAX_AGE_MS / 60000}m=${stale.join(",")}`);
    return { ready: false, state: null, decision: null, reason: `MICRO_DATA_NOT_READY: ${parts.join("; ")}` };
  }

  const trend = (value: unknown): "bullish" | "bearish" | "neutral" => {
    const normalized = String(value ?? "").toLowerCase();
    return normalized === "bullish" || normalized === "bearish" ? normalized : "neutral";
  };
  const state: MicroTimeframeState = {
    symbol: base,
    tf5m: trend(byTf.get("5m")?.signal),
    tf15m: trend(byTf.get("15m")?.signal),
    tf1h: trend(byTf.get("1h")?.signal),
    rsi5m: byTf.get("5m")?.rsi == null ? null : Number(byTf.get("5m").rsi),
    rsi15m: byTf.get("15m")?.rsi == null ? null : Number(byTf.get("15m").rsi),
    rsi1h: byTf.get("1h")?.rsi == null ? null : Number(byTf.get("1h").rsi),
  };
  return { ready: true, state, decision: evaluateMicroTimeframeGate(state), reason: "" };
}

async function assessCurrentMarketRegime(
  supabase: ReturnType<typeof getServiceClient>,
): Promise<LiveMarketRegime> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const whaleSince = new Date(now - 6 * 60 * 60 * 1000).toISOString();
  const councilSince = new Date(now - 30 * 60 * 1000).toISOString();

  const [whales, councils] = await Promise.all([
    supabase.from("whale_alerts").select("direction,usd_value,created_at")
      .gte("created_at", whaleSince).lte("created_at", nowIso).limit(5000),
    supabase.from("council_signals").select("symbol,final_verdict,source_created_at")
      .gte("source_created_at", councilSince).lte("source_created_at", nowIso)
      .order("source_created_at", { ascending: false }).limit(5000),
  ]);

  const sourceFailures = [
    whales.error ? "whale flow: " + whales.error.message : null,
    councils.error ? "AI council: " + councils.error.message : null,
  ].filter(Boolean);
  if (sourceFailures.length) {
    return { ready: false, assessment: null, reason: sourceFailures.join("; ") };
  }

  // Execution gate requires fresh 4h inputs. Unlike the display panel fallback,
  // do not classify from 24h/7d technicals because they may be stale for entries.
  const technicalSince = new Date(now - 6 * 60 * 60 * 1000).toISOString();
  const indicators = await supabase.from("indicator_snapshots")
    .select("symbol,timeframe,signal,created_at")
    .eq("timeframe", "4h").gte("created_at", technicalSince).lte("created_at", nowIso)
    .order("created_at", { ascending: false }).limit(5000);
  if (indicators.error) {
    return { ready: false, assessment: null, reason: "4h technicals: " + indicators.error.message };
  }
  const indicatorRows = (indicators.data ?? []) as Array<{ symbol?: unknown; timeframe?: unknown; signal?: unknown }>;
  const technicalSymbols = new Set(indicatorRows.map((row) => String(row.symbol ?? "").toUpperCase()).filter(Boolean));
  if (technicalSymbols.size === 0) {
    return { ready: false, assessment: null, reason: "no fresh 4h indicator snapshots in the last 6h" };
  }

  return {
    ready: true,
    assessment: computeMarketRegimeAssessment({
      whales: (whales.data ?? []) as Array<{ direction?: unknown; usd_value?: unknown }>,
      indicators: indicatorRows,
      councils: (councils.data ?? []) as Array<{ symbol?: unknown; final_verdict?: unknown }>,
    }),
    reason: "",
  };
}

/**
 * Shadow-only BTC/Whale divergence telemetry.
 * Fetches a compact 1h BTC kline window in the background; it never gates execution.
 */
async function fetchBtcTrendForShadow(): Promise<{ metrics: BtcTrendMetrics; source: string } | null> {
  const hosts = ["https://api.binance.com", "https://data-api.binance.vision"];
  for (const host of hosts) {
    try {
      const response = await fetch(
        `${host}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=30`,
        { signal: AbortSignal.timeout(7000) },
      );
      if (!response.ok) continue;
      const rows = await response.json() as unknown[][];
      const closes = rows.map((row) => Number(row[4]));
      if (closes.length < 25 || closes.some((value) => !Number.isFinite(value) || value <= 0)) continue;

      const currentPrice = closes.at(-1)!;
      const price4hAgo = closes.at(-5)!;
      const price24hAgo = closes.at(-25)!;
      // Use the 24 hourly closes preceding the current, potentially incomplete candle.
      const smaCloses = closes.slice(-25, -1);
      if (smaCloses.length !== 24) continue;
      const sma24h = smaCloses.reduce((sum, value) => sum + value, 0) / smaCloses.length;
      if (!Number.isFinite(sma24h) || sma24h <= 0) continue;

      return {
        metrics: evaluateBtcTrend(currentPrice, price4hAgo, price24hAgo, sma24h),
        source: host.includes("data-api.binance.vision") ? "binance-vision" : "binance",
      };
    } catch (error) {
      console.warn("[SHADOW_TELEMETRY] BTC kline source failed", {
        host,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

async function recordRegimeShadowTelemetry(
  supabase: ReturnType<typeof getServiceClient>,
  assessment: MarketRegimeAssessment,
  btcResult: { metrics: BtcTrendMetrics; source: string } | null,
): Promise<void> {
  try {
    const divergence = computeDivergenceAssessment(
      btcResult?.metrics ?? null,
      assessment.whaleNet,
      assessment.techBreadth,
      assessment.councilConsensus,
    );
    const metrics = btcResult?.metrics ?? null;
    const { error } = await supabase.from("market_regime_telemetry").insert({
      data_status: metrics ? "ok" : "btc_unavailable",
      btc_source: btcResult?.source ?? null,
      btc_price: metrics?.currentPrice ?? null,
      btc_sma_24h: metrics?.sma24h ?? null,
      btc_return_4h_pct: metrics?.return4hPct ?? null,
      btc_return_24h_pct: metrics?.return24hPct ?? null,
      btc_below_sma_24h: metrics?.isBelowSma24h ?? null,
      btc_is_downtrend: metrics?.isDowntrend ?? null,
      whale_net: divergence.whaleNet,
      shadow_whale_net: divergence.shadowWhaleNet,
      tech_breadth: divergence.techBreadth,
      council_consensus: divergence.councilConsensus,
      baseline_score: divergence.baselineScore,
      baseline_regime: divergence.baselineRegime,
      shadow_score: divergence.shadowScore,
      shadow_regime: divergence.shadowRegime,
      is_divergent: divergence.isDivergent,
      divergence_type: divergence.divergenceType,
      entry_blocked_by_rule: divergence.entryBlockedByRule,
      explanation: divergence.explanation,
    });
    if (error) {
      console.error("[SHADOW_TELEMETRY] insert failed", error.message);
      return;
    }
    console.log("[SHADOW_TELEMETRY] recorded", JSON.stringify({
      data_status: metrics ? "ok" : "btc_unavailable",
      divergent: divergence.isDivergent,
      baseline_score: divergence.baselineScore,
      shadow_score: divergence.shadowScore,
      baseline_regime: divergence.baselineRegime,
      shadow_regime: divergence.shadowRegime,
      counterfactual_entry_block: divergence.entryBlockedByRule,
    }));
  } catch (error) {
    // Shadow telemetry must never affect the active execution path.
    console.error("[SHADOW_TELEMETRY] unexpected failure", error instanceof Error ? error.message : String(error));
  }
}

async function getCachedMicroAssessment(
  supabase: ReturnType<typeof getServiceClient>,
  symbol: string,
  cache: Map<string, Promise<MicroGateAssessment>>,
): Promise<MicroGateAssessment> {
  const key = String(symbol).toUpperCase();
  let pending = cache.get(key);
  if (!pending) {
    pending = assessMicroTimeframes(supabase, key);
    cache.set(key, pending);
  }
  return pending;
}

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

const PRICE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision", "https://api1.binance.com"];

async function fetchAllSpotPrices(): Promise<{ prices: Map<string, number>; host: string | null; errors: string[] }> {
  const errors: string[] = [];
  for (const host of PRICE_HOSTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${host}/api/v3/ticker/price`, { signal: ctrl.signal });
      if (!res.ok) { errors.push(`${host}: HTTP ${res.status}`); continue; }
      const rows = (await res.json()) as Array<{ symbol: string; price: string }>;
      const map = new Map<string, number>();
      for (const r of rows) {
        const p = Number(r.price);
        if (Number.isFinite(p) && p > 0) map.set(r.symbol, p);
      }
      if (map.size > 0) return { prices: map, host, errors };
      errors.push(`${host}: empty price list`);
    } catch (e) {
      errors.push(`${host}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { prices: new Map(), host: null, errors };
}

/**
 * Exit stage. Runs on EVERY executor invocation, before and independent of
 * entry logic, so expired/SL/TP paper BUYs are closed even when no entries happen.
 * Never throws: failures are returned as structured status and logged.
 */
async function closeTriggeredTradesStage(supabase: ReturnType<typeof getServiceClient>) {
  const summary: Record<string, unknown> = {
    status: "ok", open_buy: 0, closed: 0, by_reason: {} as Record<string, number>,
    held: 0, no_price: [] as string[], legacy_sell_open: 0, legacy_sell_ids: [] as string[],
    live_pending_exchange: [] as string[], race_skipped: 0, errors: [] as string[],
    settings: null as unknown, settings_source: "defaults", price_host: null as string | null,
  };
  try {
    const { data: settingsRow, error: settingsErr } = await supabase
      .from("pipeline_settings").select("*").eq("id", 1).maybeSingle();
    if (settingsErr) (summary.errors as string[]).push(`settings: ${settingsErr.message}`);
    else if (settingsRow) summary.settings_source = "pipeline_settings";
    const settings = normalizeExitSettings(settingsRow as Record<string, unknown> | null);
    summary.settings = settings;

    const { data: openRows, error: openErr } = await supabase
      .from("trades")
      .select("id,symbol,side,mode,quantity,entry_price,stop_loss,take_profit,created_at")
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .range(0, 4999);
    if (openErr) throw new Error(`open trades query failed: ${openErr.message}`);
    const rows = (openRows ?? []) as OpenTradeRow[];

    const legacy = rows.filter((r) => r.side !== "buy");
    summary.legacy_sell_open = legacy.length;
    summary.legacy_sell_ids = legacy.map((r) => r.id);
    if (legacy.length) {
      console.warn("[TRADE_EXIT] legacy SELL rows left open (Spot long-only, not auto-closed)",
        JSON.stringify(legacy.map((r) => ({ id: r.id, symbol: r.symbol, created_at: r.created_at }))));
    }
    const buys = rows.filter((r) => r.side === "buy");
    summary.open_buy = buys.length;
    if (!buys.length) return summary;

    const { prices, host, errors: priceErrors } = await fetchAllSpotPrices();
    summary.price_host = host;
    if (!prices.size) {
      summary.status = "error";
      (summary.errors as string[]).push(`price fetch failed: ${priceErrors.join("; ")}`);
      console.error("[TRADE_EXIT] FAILED: no valid Binance prices; 0 trades evaluated", JSON.stringify(priceErrors));
      return summary;
    }

    const nowMs = Date.now();
    for (const trade of buys) {
      const price = prices.get(binancePair(trade.symbol));
      const protectedStop = getBreakevenStopLossUpdate(trade, price);
      if (protectedStop != null) {
        const { data: protectedRow, error: protectError } = await supabase
          .from("trades")
          .update({ stop_loss: protectedStop })
          .eq("id", trade.id).eq("status", "open").eq("mode", "paper").eq("side", "buy")
          .select("id").maybeSingle();
        if (protectError) {
          (summary.errors as string[]).push(`breakeven stop ${trade.id}: ${protectError.message}`);
          console.error("[BREAKEVEN_LOCK] failed to persist stop", { trade_id: trade.id, symbol: trade.symbol, error: protectError.message });
          continue;
        }
        if (!protectedRow) { (summary.race_skipped as number)++; continue; }
        trade.stop_loss = protectedStop;
        console.log("[BREAKEVEN_LOCK]", JSON.stringify({
          trade_id: trade.id, symbol: trade.symbol, entry_price: Number(trade.entry_price),
          current_price: price, stop_loss: protectedStop, trigger_gain_pct: 3,
        }));
      }
      const decision = decideExit(trade, price, settings, nowMs);
      if (decision.action === "hold") { (summary.held as number)++; continue; }
      if (decision.action === "skip_no_price") { (summary.no_price as string[]).push(trade.symbol); continue; }
      if (decision.action === "skip_legacy_sell") continue;
      if (decision.action === "skip_live_requires_exchange") {
        // This executor has no live-order adapter: never mark live trades closed.
        (summary.live_pending_exchange as string[]).push(trade.id);
        console.error(`[TRADE_EXIT] live trade ${trade.id} ${trade.symbol} due (${decision.reason}) but no confirmed exchange SELL; left open`);
        continue;
      }
      const closedAt = new Date().toISOString();
      // Idempotent + concurrency-safe: only flips rows still open.
      const { data: updated, error: updErr } = await supabase
        .from("trades")
        .update({
          status: "closed", exit_price: decision.exit_price, close_reason: decision.reason, closed_at: closedAt,
          pnl: decision.net_pnl, gross_pnl: decision.gross_pnl, net_pnl: decision.net_pnl,
          entry_fee: decision.entry_fee, exit_fee: decision.exit_fee, total_fees: decision.total_fees,
        })
        .eq("id", trade.id).eq("status", "open").eq("mode", "paper").eq("side", "buy")
        .select("id").maybeSingle();
      if (updErr) { (summary.errors as string[]).push(`${trade.id}: ${updErr.message}`); continue; }
      if (!updated) { (summary.race_skipped as number)++; continue; }
      summary.closed = (summary.closed as number) + 1;
      const br = summary.by_reason as Record<string, number>;
      br[decision.reason] = (br[decision.reason] ?? 0) + 1;
      const { error: alertErr } = await supabase.from("trade_alerts").insert({
        trade_id: trade.id, symbol: trade.symbol, side: "buy", event_type: decision.reason,
        entry_price: Number(trade.entry_price), exit_price: decision.exit_price,
        pnl: decision.net_pnl, pnl_pct: decision.net_pnl_pct, created_at: closedAt,
      });
      if (alertErr) (summary.errors as string[]).push(`alert ${trade.id}: ${alertErr.message}`);
    }
    if ((summary.errors as string[]).length) summary.status = "partial";
    console.log("[TRADE_EXIT]", JSON.stringify({ ...summary, legacy_sell_ids: undefined }));
  } catch (e) {
    summary.status = "error";
    (summary.errors as string[]).push(e instanceof Error ? e.message : String(e));
    console.error("[TRADE_EXIT] FAILED", JSON.stringify(summary));
  }
  return summary;
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

/**
 * Completes the DB-trigger placeholder using only context carried by the selected
 * composite signal. Updates pending rows only; a completed snapshot is immutable
 * to this helper. Enrichment failure never rolls back a successfully inserted trade.
 */
async function enrichEntryContextSnapshot(
  supabase: ReturnType<typeof getServiceClient>,
  trade: Record<string, any>,
  signal: Record<string, any>,
): Promise<void> {
  const tradeId = String(trade?.id ?? "");
  const signalId = String(signal?.id ?? "");
  const symbol = String(trade?.symbol ?? signal?.symbol ?? "");
  const capturedAt = trade?.created_at ?? new Date().toISOString();

  if (!tradeId || !signalId || !symbol || String(trade?.composite_signal_id ?? "") !== signalId) {
    console.error("[ENTRY_CONTEXT] enrichment rejected: trade/signal identity mismatch", {
      tradeId, signalId, tradeSignalId: trade?.composite_signal_id ?? null, symbol,
    });
    return;
  }

  // This is a signal-time copy only when the selected signal actually contains it.
  const signalCtx = signal.entry_context_snapshot &&
      typeof signal.entry_context_snapshot === "object" &&
      !Array.isArray(signal.entry_context_snapshot)
    ? signal.entry_context_snapshot as Record<string, any>
    : null;
  const signalContext = signalCtx?.signal && typeof signalCtx.signal === "object"
    ? signalCtx.signal as Record<string, any>
    : null;

  const enrichedSnapshot = {
    schema_version: 2,
    capture_status: "complete",
    captured_at: capturedAt,
    capture_provenance: signalCtx ? "signal_record_context_copy" : "signal_record_fields_only",
    trade: {
      id: trade.id,
      composite_signal_id: signalId,
      symbol,
      side: trade.side,
      quantity: trade.quantity,
      entry_price: trade.entry_price,
      stop_loss: trade.stop_loss,
      take_profit: trade.take_profit,
      mode: trade.mode,
      status: trade.status,
      entry_fee: trade.entry_fee,
      exchange_order_id: trade.exchange_order_id,
      regime_label: trade.regime_label,
      market_session: trade.market_session,
      source_tags: trade.source_tags,
      created_at: trade.created_at,
    },
    signal: {
      id: signalId,
      recommendation: signal.recommendation ?? null,
      confidence: signal.confidence == null ? null : Number(signal.confidence),
      score: signalContext?.score ?? null,
      reasoning: signal.reasoning ?? null,
      price_at: signal.price_at ?? signalContext?.price_at ?? null,
      created_at: signal.created_at ?? null,
    },
    upstream: {
      whale_flow: signalCtx?.whale_flow ?? null,
      technicals: signalCtx?.technicals ?? null,
      ai_council: signalCtx?.ai_council ?? null,
      market_regime: {
        label: trade.regime_label ?? signal.regime_label ?? signalCtx?.market_regime ?? null,
        source: trade.regime_label != null || signal.regime_label != null
          ? "persisted_signal_or_trade_field"
          : signalCtx?.market_regime != null ? "signal_context_copy" : "unavailable",
      },
      strategy: signalCtx?.strategy ?? null,
      source_tags: signal.source_tags ?? signalCtx?.source_tags ?? [],
    },
    execution_context: {
      mode: trade.mode,
      entry_price: trade.entry_price,
      quantity: trade.quantity,
      stop_loss: trade.stop_loss,
      take_profit: trade.take_profit,
      entry_fee: trade.entry_fee,
      executed_at: capturedAt,
    },
  };

  try {
    // Conditional update protects completed historical snapshots from replacement.
    const { data, error } = await supabase
      .from("entry_context_snapshots")
      .update({
        composite_signal_id: signalId,
        symbol,
        captured_at: capturedAt,
        snapshot: enrichedSnapshot,
      })
      .eq("trade_id", tradeId)
      .eq("snapshot->>capture_status", "pending")
      .select("trade_id")
      .maybeSingle();

    if (error) {
      console.error("[ENTRY_CONTEXT] enrichment update failed", {
        tradeId, signalId, symbol, error: error.message,
      });
      return;
    }

    if (!data) {
      const { data: existing, error: lookupError } = await supabase
        .from("entry_context_snapshots")
        .select("trade_id,snapshot")
        .eq("trade_id", tradeId)
        .maybeSingle();

      console.warn("[ENTRY_CONTEXT] no pending snapshot updated", {
        tradeId,
        signalId,
        symbol,
        existingStatus: existing?.snapshot?.capture_status ?? null,
        lookupError: lookupError?.message ?? null,
      });
      return;
    }

    console.log("[ENTRY_CONTEXT] snapshot enriched", { tradeId, signalId, symbol });
  } catch (err) {
    console.error("[ENTRY_CONTEXT] unexpected enrichment failure", {
      tradeId, signalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Separate paper-only entry path for clustered whale accumulation.
 * Failure is isolated: it must never prevent the standard signal pipeline from running.
 */
async function executeWhaleShockTradesStage(supabase: ReturnType<typeof getServiceClient>, marketRegime: LiveMarketRegime, btcTrend: BtcTrendMetrics | null) {
  const config = DEFAULT_WHALE_SHOCK_CONFIG;
  const now = Date.now();
  const sinceIso = new Date(now - config.windowMinutes * 60_000).toISOString();
  const cooldownIso = new Date(now - config.cooldownMinutes * 60_000).toISOString();
  const result: Record<string, unknown> = {
    status: "ok", opened: 0, candidates: 0, skipped: 0, trades: [], errors: [],
    symbol_cap_skips: [] as Array<Record<string, unknown>>,
  };
  const errors = result.errors as string[];
  const microCache = new Map<string, Promise<MicroGateAssessment>>();

  try {
    const { data: alerts, error: alertErr } = await supabase
      .from("whale_alerts")
      .select("symbol,direction,usd_value,source,created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (alertErr) throw new Error(`whale_alerts query: ${alertErr.message}`);

    const candidates = aggregateWhaleShocks(alerts ?? [], config);
    result.candidates = candidates.length;
    result.alerts_in_window = (alerts ?? []).length;
    result.candidate_symbols = candidates.map((c) => c.symbol);
    result.gate_rejections = {};
    if (!candidates.length) return result;
    if (!marketRegime.ready || !marketRegime.assessment) {
      result.status = "error";
      errors.push("market regime unavailable; entries blocked: " + marketRegime.reason);
      result.skipped = candidates.length;
      return result;
    }

    const symbols = candidates.map((candidate) => candidate.symbol);
    const { data: recentTrades, error: cooldownErr } = await supabase
      .from("trades")
      .select("symbol,created_at")
      .in("symbol", symbols)
      .eq("entry_source", "whale_shock")
      .gte("created_at", cooldownIso);
    if (cooldownErr) throw new Error(`whale_shock cooldown query: ${cooldownErr.message}`);

    const onCooldown = new Set((recentTrades ?? []).map((trade) => String(trade.symbol).toUpperCase()));
    // Repo schema stores regime_label, not a composite_signals.score column.
    const regimeWindowIso = new Date(now - 6 * 60 * 60_000).toISOString();
    // Regime labels are stored per symbol, so evaluate each candidate's own history
    // instead of mixing unrelated symbols into a synthetic market-wide transition.
    const { data: regimeHistory, error: regimeErr } = await supabase
      .from("composite_signals")
      .select("symbol,regime_label,created_at")
      .in("symbol", symbols)
      .gte("created_at", regimeWindowIso)
      .not("regime_label", "is", null)
      .order("created_at", { ascending: true })
      .limit(1000);
    if (regimeErr) throw new Error(`market regime history query: ${regimeErr.message}`);
    const regimesBySymbol = new Map<string, any[]>();
    for (const row of regimeHistory ?? []) {
      const key = String(row.symbol ?? "").toUpperCase();
      if (!key) continue;
      const history = regimesBySymbol.get(key) ?? [];
      history.push(row);
      regimesBySymbol.set(key, history);
    }
    const regimeTransitions = new Map<string, ReturnType<typeof evaluateRegimeShockTransition>>();
    for (const candidate of candidates) {
      regimeTransitions.set(candidate.symbol, evaluateRegimeShockTransition(regimesBySymbol.get(candidate.symbol) ?? [], config));
    }

    const { data: technicalRows, error: technicalErr } = await supabase
      .from("indicator_snapshots")
      .select("symbol,timeframe,signal,rsi,macd,macd_signal,created_at")
      .in("symbol", symbols)
      .eq("timeframe", "1h")
      .gte("created_at", regimeWindowIso)
      .order("created_at", { ascending: false })
      .limit(Math.max(100, symbols.length * 5));
    if (technicalErr) throw new Error(`1h technical snapshot query: ${technicalErr.message}`);
    const tech1hMap = new Map<string, any>();
    for (const row of technicalRows ?? []) {
      const key = String(row.symbol ?? "").toUpperCase();
      if (key && !tech1hMap.has(key)) tech1hMap.set(key, row);
    }

    const { prices, host, errors: priceErrors } = await fetchAllSpotPrices();
    result.price_host = host;
    if (!prices.size) throw new Error(`no valid Binance Spot prices: ${priceErrors.join("; ")}`);

    const activeCounts = await getActiveSymbolPositions(supabase);
    const openedTrades: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
      const exposureSymbol = normalizeExposureSymbol(candidate.symbol);
      const activeCount = activeCounts.get(exposureSymbol) ?? 0;
      if (activeCount >= MAX_ACTIVE_TRADES_PER_SYMBOL) {
        recordWhaleShockRejection(result, "PER_SYMBOL_CAP", candidate.symbol, `active ${activeCount}/${MAX_ACTIVE_TRADES_PER_SYMBOL}`);
        const capSkip = {
          symbol: exposureSymbol, active_count: activeCount, cap: MAX_ACTIVE_TRADES_PER_SYMBOL,
          entry_source: "whale_shock", decision: "SKIP", stage: "PER_SYMBOL_CAP",
        };
        (result.symbol_cap_skips as Array<Record<string, unknown>>).push(capSkip);
        console.log("[SYMBOL_CAP_SKIP]", JSON.stringify(capSkip));
        continue;
      }
      if (onCooldown.has(candidate.symbol)) {
        recordWhaleShockRejection(result, "COOLDOWN", candidate.symbol, `${config.cooldownMinutes}m cooldown`);
        console.log("[WHALE_SHOCK] skipped on cooldown", candidate.symbol);
        continue;
      }
      const regimeTransition = regimeTransitions.get(candidate.symbol);
      if (!regimeTransition?.passed) {
        recordWhaleShockRejection(result, "REGIME_TRANSITION", candidate.symbol, regimeTransition?.reason ?? "No regime history available");
        console.log("[WHALE_SHOCK] regime gate blocked", { symbol: candidate.symbol, reason: regimeTransition?.reason ?? "No regime history available" });
        continue;
      }
      const regime = regimeTransition.currentRegime;

      const micro = await getCachedMicroAssessment(supabase, candidate.symbol, microCache);
      if (!micro.ready || !micro.decision?.allowBuy) {
        recordWhaleShockRejection(result, "MICRO_TIMEFRAME", candidate.symbol, micro.ready ? micro.decision?.reason : micro.reason);
        console.log("[WHALE_SHOCK] micro timeframe gate blocked", {
          symbol: candidate.symbol,
          reason: micro.ready ? micro.decision?.reason : micro.reason,
          state: micro.state,
        });
        continue;
      }

      const btcGate = evaluateBtcDowntrendEntryGate(
        btcTrend,
        marketRegime.assessment!.whaleNet,
        marketRegime.assessment!.techBreadth,
        marketRegime.assessment!.councilConsensus,
        micro.state!,
      );
      if (!btcGate.allowBuy) {
        recordWhaleShockRejection(result, "BTC_DOWNTREND", candidate.symbol, btcGate.reason);
        console.log("[BTC_DOWNTREND_ENTRY_GATE] blocked whale_shock BUY", {
          symbol: candidate.symbol, reason: btcGate.reason, btc: btcTrend,
          whale_net: marketRegime.assessment!.whaleNet, micro_state: micro.state,
        });
        continue;
      }

      const sidewaysGate = evaluateSidewaysEntryGate(
        marketRegime.assessment!.score,
        marketRegime.assessment!.whaleNet,
        micro.state!,
      );
      if (!sidewaysGate.allowBuy) {
        recordWhaleShockRejection(result, "SIDEWAYS_MARKET", candidate.symbol, sidewaysGate.reason);
        console.log("[WHALE_SHOCK] sideways market gate blocked", {
          symbol: candidate.symbol,
          market_score: marketRegime.assessment!.score,
          whale_net: marketRegime.assessment!.whaleNet,
          reason: sidewaysGate.reason,
          micro_state: micro.state,
        });
        continue;
      }

      const techCheck = evaluate1hTechnicalConfirmation(tech1hMap.get(candidate.symbol), config);
      if (!techCheck.passed) {
        recordWhaleShockRejection(result, "TECHNICAL_1H", candidate.symbol, techCheck.reason);
        console.log("[WHALE_SHOCK] 1h technical gate blocked", { symbol: candidate.symbol, reason: techCheck.reason });
        continue;
      }

      const price = prices.get(binancePair(candidate.symbol));
      if (!price || !Number.isFinite(price) || price <= 0) {
        errors.push(`no valid Binance Spot USDT price for ${binancePair(candidate.symbol)}`);
        recordWhaleShockRejection(result, "PRICE_UNAVAILABLE", candidate.symbol, binancePair(candidate.symbol));
        continue;
      }

      const quantity = config.paperPositionUsd / price;
      const entryFee = config.paperPositionUsd * TRADING_FEE_RATE;
      const stopLoss = price * (1 - config.stopLossPct);
      const takeProfit = price * (1 + config.takeProfitPct);
      const entryAt = new Date().toISOString();
      const sourceTags = ["paper", "whale-shock", "spot-long-only", "bearish-reversal", "1h-confirmed", "research-only"];
      const entryMetadata = {
        shock_volume_usd: candidate.buyUsd,
        total_volume_usd: candidate.totalUsd,
        sell_volume_usd: candidate.sellUsd,
        buy_ratio: candidate.buyRatio,
        alert_count: candidate.alertCount,
        trigger_window_minutes: candidate.windowMinutes,
        sources: candidate.sources,
        asset_tier: candidate.assetTier,
        required_volume_floor_usd: candidate.requiredFloorUsd,
        min_buy_ratio: config.minBuyRatio,
        min_alerts: config.minAlerts,
        cooldown_minutes: config.cooldownMinutes,
        strategy: "whale-shock-reversal-v2",
        strategy_version: 2,
        entry_path: "trade-executor-whale-shock",
        research_only: true,
        regime_transition: regimeTransition,
        technical_confirmation: techCheck,
        micro_gate: micro.decision,
        micro_state: micro.state,
        captured_at: entryAt,
      };

      const { data: trade, error: insertErr } = await supabase
        .from("trades")
        .insert({
          symbol: candidate.symbol,
          side: "buy",
          quantity,
          entry_price: price,
          stop_loss: stopLoss,
          take_profit: takeProfit,
          mode: "paper",
          status: "open",
          entry_fee: entryFee,
          exit_fee: 0,
          total_fees: entryFee,
          regime_label: regime,
          entry_source: "whale_shock",
          source_tags: sourceTags,
          entry_metadata: entryMetadata,
        })
        .select()
        .single();

      if (insertErr) {
        errors.push(`insert ${candidate.symbol}: ${insertErr.message}`);
        recordWhaleShockRejection(result, "INSERT_FAILED", candidate.symbol, insertErr.message);
        continue;
      }
      openedTrades.push(trade as Record<string, unknown>);
      activeCounts.set(exposureSymbol, activeCount + 1);

      // Fill the DB-triggered placeholder with an immutable entry-time record.
      const snapshot = {
        schema_version: 1,
        capture_status: "complete",
        captured_at: trade.created_at ?? entryAt,
        capture_provenance: "whale_shock_executor_at_entry",
        trade: {
          id: trade.id, symbol: candidate.symbol, side: "buy", mode: "paper",
          quantity: trade.quantity, entry_price: trade.entry_price,
          stop_loss: trade.stop_loss, take_profit: trade.take_profit,
          entry_source: "whale_shock", source_tags: sourceTags,
          regime_label: regime, created_at: trade.created_at ?? entryAt,
        },
        signal: null,
        upstream: {
          whale_shock: candidate,
          strategy: { version: "whale-shock-reversal-v2", strategy_version: 2, config, required_volume_floor_usd: entryMetadata.required_volume_floor_usd },
          market_regime: { ...regimeTransition, source: "composite_signals_regime_history_6h" },
          technicals: { ...techCheck, timeframe: "1h" },
          micro_gate: micro.decision,
          micro_state: micro.state,
          sideways_market_gate: sidewaysGate,
          market_regime_assessment: marketRegime.assessment,
          ai_council: null,
        },
        execution_context: {
          mode: "paper", entry_price: trade.entry_price, quantity: trade.quantity,
          stop_loss: trade.stop_loss, take_profit: trade.take_profit,
          entry_fee: trade.entry_fee, executed_at: trade.created_at ?? entryAt,
        },
      };
      const { data: snapshotRow, error: snapshotErr } = await supabase
        .from("entry_context_snapshots")
        .update({
          symbol: candidate.symbol,
          composite_signal_id: null,
          captured_at: trade.created_at ?? entryAt,
          snapshot,
        })
        .eq("trade_id", trade.id)
        .eq("snapshot->>capture_status", "pending")
        .select("trade_id")
        .maybeSingle();
      if (snapshotErr) {
        errors.push(`entry snapshot ${candidate.symbol}: ${snapshotErr.message}`);
      } else if (!snapshotRow) {
        errors.push(`entry snapshot ${candidate.symbol}: no pending placeholder found for trade ${trade.id}`);
      }

      console.log("[WHALE_SHOCK_EXECUTED]", JSON.stringify({
        symbol: candidate.symbol, price, buyUsd: candidate.buyUsd,
        buyRatio: candidate.buyRatio, alerts: candidate.alertCount, tradeId: trade.id,
      }));
    }
    result.opened = openedTrades.length;
    result.trades = openedTrades;
    if (errors.length) result.status = "partial";
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    result.status = "error";
    console.error("[WHALE_SHOCK] stage failed; standard execution will continue", errors);
  }
  result.errors = errors;
  return result;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const auditStartedAt = new Date().toISOString();
  let exitStage: Record<string, unknown> | null = null;

  try {
    const supabase = getServiceClient();
    const tradingMode = Deno.env.get("TRADING_MODE") ?? "paper";

    exitStage = await closeTriggeredTradesStage(supabase);

    // Live order placement remains explicitly disabled.
    if (tradingMode === "live") {
      return new Response(JSON.stringify({
        error:
          "Live execution is intentionally blocked in phase 1. Use paper mode until a verified live-order adapter is implemented.",
        exits: exitStage,
      }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    const liveMarketRegime = await assessCurrentMarketRegime(supabase);
    console.log("[MARKET_REGIME_ENTRY_GATE]", JSON.stringify({
      ready: liveMarketRegime.ready,
      reason: liveMarketRegime.reason,
      assessment: liveMarketRegime.assessment,
    }));

    // Fetch BTC trend once and use the same evidence for active BUY gating and telemetry.
    // Telemetry failure is isolated inside the recorder and cannot fail the execution cycle.
    const btcTrendResult = await fetchBtcTrendForShadow();
    const btcTrend = btcTrendResult?.metrics ?? null;
    console.log("[BTC_DOWNTREND_ENTRY_GATE] market context", JSON.stringify({
      btc_available: Boolean(btcTrend),
      btc_is_downtrend: btcTrend?.isDowntrend ?? null,
      btc_return_4h_pct: btcTrend?.return4hPct ?? null,
      btc_return_24h_pct: btcTrend?.return24hPct ?? null,
      whale_net: liveMarketRegime.assessment?.whaleNet ?? null,
    }));

    if (liveMarketRegime.ready && liveMarketRegime.assessment) {
      await recordRegimeShadowTelemetry(supabase, liveMarketRegime.assessment, btcTrendResult);
    } else {
      console.warn("[SHADOW_TELEMETRY] skipped: baseline market regime unavailable", liveMarketRegime.reason);
    }

    const whaleShockStage = await executeWhaleShockTradesStage(supabase, liveMarketRegime, btcTrend);

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
    const standardMicroCache = new Map<string, Promise<MicroGateAssessment>>();
    let standardActiveCounts: Map<string, number> | null = null;
    let exposureQueryError: string | null = null;
    try {
      standardActiveCounts = await getActiveSymbolPositions(supabase);
    } catch (error) {
      exposureQueryError = error instanceof Error ? error.message : String(error);
      console.error("[SYMBOL_CAP] exposure unavailable; standard entries will fail closed", exposureQueryError);
    }

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

      const exposureSymbol = normalizeExposureSymbol(symbol);
      if (!standardActiveCounts || exposureQueryError) {
        const reason = "active symbol exposure unavailable; entry blocked: " + (exposureQueryError ?? "unknown query failure");
        auditEvents.push({
          ts: new Date().toISOString(), symbol, signal_id: signalId,
          stage: "PER_SYMBOL_CAP", decision: "REJECT", reason,
          details: { data_ready: false, cap: MAX_ACTIVE_TRADES_PER_SYMBOL },
        });
        await supabase.from("repeated_buy_research_ledger")
          .update({ research_decision: "rejected", research_reason: "per_symbol_cap_data_unavailable: " + reason })
          .eq("composite_signal_id", signalId)
          .eq("research_decision", "pending_execution_audit");
        continue;
      }
      const activeCount = standardActiveCounts.get(exposureSymbol) ?? 0;
      if (activeCount >= MAX_ACTIVE_TRADES_PER_SYMBOL) {
        const reason = `max_exposure_reached: ${activeCount}/${MAX_ACTIVE_TRADES_PER_SYMBOL} open paper BUY position(s)`;
        auditEvents.push({
          ts: new Date().toISOString(), symbol: exposureSymbol, signal_id: signalId,
          stage: "PER_SYMBOL_CAP", decision: "SKIP", reason,
          details: { currentOpen: activeCount, cap: MAX_ACTIVE_TRADES_PER_SYMBOL },
        });
        await supabase.from("repeated_buy_research_ledger")
          .update({ research_decision: "rejected", research_reason: "per_symbol_cap: " + reason })
          .eq("composite_signal_id", signalId)
          .eq("research_decision", "pending_execution_audit");
        console.log("[SYMBOL_CAP_SKIP]", exposureSymbol, reason);
        continue;
      }

      if (!liveMarketRegime.ready || !liveMarketRegime.assessment) {
        const reason = "market regime unavailable; entry blocked: " + liveMarketRegime.reason;
        auditEvents.push({
          ts: new Date().toISOString(), symbol, signal_id: signalId,
          stage: "MARKET_REGIME_GATE", decision: "REJECT", reason,
          details: { data_ready: false },
        });
        await supabase.from("repeated_buy_research_ledger")
          .update({ research_decision: "rejected", research_reason: reason })
          .eq("composite_signal_id", signalId)
          .eq("research_decision", "pending_execution_audit");
        continue;
      }

      const micro = await getCachedMicroAssessment(supabase, symbol, standardMicroCache);
      if (!micro.ready || !micro.decision?.allowBuy) {
        const reason = micro.ready ? (micro.decision?.reason ?? "micro gate rejected") : micro.reason;
        auditEvents.push({
          ts: new Date().toISOString(), symbol, signal_id: signalId,
          stage: "MICRO_TF_GATE", decision: "REJECT", reason,
          details: { state: micro.state, data_ready: micro.ready },
        });
        await supabase.from("repeated_buy_research_ledger")
          .update({ research_decision: "rejected", research_reason: `micro_tf_gate: ${reason}` })
          .eq("composite_signal_id", signalId)
          .eq("research_decision", "pending_execution_audit");
        console.log("[MICRO_GATE_REJECT]", symbol, reason);
        continue;
      }

      const btcGate = evaluateBtcDowntrendEntryGate(
        btcTrend,
        liveMarketRegime.assessment!.whaleNet,
        liveMarketRegime.assessment!.techBreadth,
        liveMarketRegime.assessment!.councilConsensus,
        micro.state!,
      );
      if (!btcGate.allowBuy) {
        auditEvents.push({
          ts: new Date().toISOString(), symbol, signal_id: signalId,
          stage: "BTC_DOWNTREND_ENTRY_GATE", decision: "REJECT",
          reason: btcGate.reason,
          details: {
            btc: btcTrend,
            whale_net: liveMarketRegime.assessment!.whaleNet,
            micro_state: micro.state,
            adjusted_market_score: computeDivergenceAssessment(
              btcTrend,
              liveMarketRegime.assessment!.whaleNet,
              liveMarketRegime.assessment!.techBreadth,
              liveMarketRegime.assessment!.councilConsensus,
            ).shadowScore,
          },
        });
        await supabase.from("repeated_buy_research_ledger")
          .update({ research_decision: "rejected", research_reason: "btc_downtrend_entry_gate: " + btcGate.reason })
          .eq("composite_signal_id", signalId)
          .eq("research_decision", "pending_execution_audit");
        console.log("[BTC_DOWNTREND_ENTRY_GATE] blocked composite BUY", { symbol, reason: btcGate.reason, btc: btcTrend, micro_state: micro.state });
        continue;
      }

      const sidewaysGate = evaluateSidewaysEntryGate(
        liveMarketRegime.assessment!.score,
        liveMarketRegime.assessment!.whaleNet,
        micro.state!,
      );
      if (!sidewaysGate.allowBuy) {
        auditEvents.push({
          ts: new Date().toISOString(), symbol, signal_id: signalId,
          stage: "SIDEWAYS_MARKET_GATE", decision: "REJECT",
          reason: sidewaysGate.reason,
          details: {
            market_score: liveMarketRegime.assessment!.score,
            market_regime: liveMarketRegime.assessment!.label,
            whale_net: liveMarketRegime.assessment!.whaleNet,
            micro_state: micro.state,
          },
        });
        await supabase.from("repeated_buy_research_ledger")
          .update({ research_decision: "rejected", research_reason: "sideways_market_gate: " + sidewaysGate.reason })
          .eq("composite_signal_id", signalId)
          .eq("research_decision", "pending_execution_audit");
        console.log("[SIDEWAYS_MARKET_GATE_REJECT]", symbol, sidewaysGate.reason);
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
          market_regime: liveMarketRegime.assessment,
          sideways_market_gate: sidewaysGate,
        },
      });

      try {
        const price = await getCurrentPrice(symbol);
        const quantity = PAPER_POSITION_USD / price;
        const entryFee = price * quantity * TRADING_FEE_RATE;
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
            entry_fee: entryFee,
            exit_fee: 0,
            total_fees: entryFee,
            regime_label: signal.regime_label ?? null,
            market_session: signal.market_session ?? null,
            exchange_order_id: null,
            source_tags: [
              "paper",
              "trade-executor",
              "spot-long-only",
              "research-unbounded",
            ],
            entry_source: "standard",
            entry_metadata: {
              strategy: "standard-paper-v1",
              strategy_version: 1,
              composite_signal_id: signal.id,
              entry_path: "trade-executor-composite",
              research_only: true,
            },
          })
          .select()
          .single();

        if (tradeError) throw new Error(tradeError.message);

        opened.push(trade);
        standardActiveCounts.set(exposureSymbol, activeCount + 1);

        // Complete the trigger-created placeholder without risking the inserted trade.
        const signalWithMicroContext = {
          ...(signal as Record<string, any>),
          entry_context_snapshot: {
            ...((signal as Record<string, any>).entry_context_snapshot ?? {}),
            technicals: {
              ...(((signal as Record<string, any>).entry_context_snapshot ?? {}).technicals ?? {}),
              micro_gate: micro.decision,
              micro_state: micro.state,
            },
          },
        };
        await enrichEntryContextSnapshot(supabase, trade as Record<string, any>, signalWithMicroContext);

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

    // Short-horizon markouts only. Long-horizon 24h/72h returns are intentionally not collected or persisted.
    const { data: dueRows } = await supabase.from("repeated_buy_research_ledger")
      .select("id,symbol,signal_price,observed_at,limited_position_decision,markout_15m_at,markout_1h_at,markout_4h_at")
      .eq("recommendation", "buy")
      .lt("observed_at", new Date(Date.now() - 15 * 60 * 1000).toISOString())
      .or("markout_15m_at.is.null,markout_1h_at.is.null,markout_4h_at.is.null")
      .limit(500);
    const priceCache = new Map<string, number>();
    for (const row of dueRows ?? []) {
      const age = Date.now() - new Date(row.observed_at).getTime();
      const horizons = [
        { ms: 15 * 60 * 1000, done: row.markout_15m_at, prefix: "markout_15m", limitedPrefix: "limited_position_markout_15m" },
        { ms: 60 * 60 * 1000, done: row.markout_1h_at, prefix: "markout_1h", limitedPrefix: "limited_position_markout_1h" },
        { ms: 4 * 60 * 60 * 1000, done: row.markout_4h_at, prefix: "markout_4h", limitedPrefix: "limited_position_markout_4h" },
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
          const pct = ((price / base) - 1) * 100;
          patch[h.prefix + "_price"] = price;
          patch[h.prefix + "_at"] = new Date().toISOString();
          patch[h.prefix + "_pct"] = pct;
          if (row.limited_position_decision === "would_open") {
            patch[h.limitedPrefix + "_pct"] = pct;
          }
        }
        await supabase.from("repeated_buy_research_ledger").update(patch).eq("id", row.id);
      } catch (err) {
        console.error("[REPEATED_BUY_LEDGER] short-horizon markout update failed:", row.symbol, String(err));
      }
    }

    const completedAt = new Date().toISOString();
    const auditCoverage = summarizeEligibleSignalAudit(eligibleSignals, auditEvents, MIN_CONFIDENCE);

    return new Response(JSON.stringify({
      mode: "paper",
      research_mode: true,
      exits: exitStage,
      market_regime_gate: liveMarketRegime,
      whale_shock: whaleShockStage,
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
          ...auditCoverage,
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
      exits: exitStage,
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

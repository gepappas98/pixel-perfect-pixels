import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const RESOLVER_START_AT = "2026-10-06T09:57:00.000Z";
const MIN_AGE_MS = 60 * 60 * 1000;
const EXPIRY_TRIGGER_HOURS = 72;
const CANDLE_LIMIT = 1000;
const CONCURRENCY = 8;
const RESOLVER_VERSION = 7; // Bumped version for temporal integrity audit

function audit(event: string, details: Record<string, unknown>) {
  console.log("[VARIANT_RESOLVER_AUDIT]", JSON.stringify({ resolver_version: RESOLVER_VERSION, event, ...details }));
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

function toBinanceSpotSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase().replace(/[\/_-]/g, "");
  if (!normalized) throw new Error("empty symbol for Binance klines");

  const aliases: Record<string, string> = { MATIC: "POL" };
  const quoteSuffix = /(USDT|USDC|BUSD|FDUSD|TUSD|USDP|DAI|EUR|TRY|BRL|GBP|AUD|JPY)$/;
  const match = normalized.match(quoteSuffix);
  if (match && normalized.length > match[0].length) {
    const base = normalized.slice(0, -match[0].length);
    return `${aliases[base] ?? base}${match[0]}`;
  }

  const base = aliases[normalized] ?? normalized;
  return `${base}USDT`;
}

async function fetchKlines(
  symbol: string,
  interval: string,
  startTimeMs?: number,
  endTimeMs?: number,
): Promise<Candle[]> {
  const pair = toBinanceSpotSymbol(symbol);
  let url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${interval}&limit=${CANDLE_LIMIT}`;
  if (startTimeMs != null) url += `&startTime=${startTimeMs}`;
  if (endTimeMs != null) url += `&endTime=${endTimeMs}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Binance klines HTTP ${response.status}`);
  const rows = (await response.json()) as unknown[][];
  return rows
    .map((r) => ({
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      openTimeMs: Number(r[0]),
      closeTimeMs: Number(r[6]),
    }))
    .filter((c) =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      Number.isFinite(c.openTimeMs) &&
      Number.isFinite(c.closeTimeMs)
    )
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
}

async function fetchResolutionCandles(
  symbol: string,
  interval: string,
  openTimeMs?: number,
  closeTimeMs?: number,
): Promise<Candle[]> {
  try {
    const candles = await fetchKlines(symbol, interval, openTimeMs, closeTimeMs);
    return candles.filter((c) =>
      (openTimeMs == null || c.closeTimeMs > openTimeMs) &&
      (closeTimeMs == null || c.openTimeMs < closeTimeMs)
    );
  } catch (error) {
    let pair = "unresolved";
    try {
      pair = toBinanceSpotSymbol(symbol);
    } catch {
      /* preserve original error */
    }
    console.warn(
      "[VARIANT_RESOLVER_CANDLE_FETCH_FAILED]",
      JSON.stringify({
        symbol,
        pair,
        interval,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}

/**
 * Resolves TP/SL in sub-hourly resolution (5m, 15m) strictly AFTER entryMs.
 * Returns:
 *  - "win" | "loss" | "ambiguous" if a terminal trigger was confirmed
 *  - undefined if neither TP nor SL was hit in this window (safe to continue)
 *  - null if candle data failed (blocks premature resolution/expiry)
 */
async function resolveIntraWindow(
  symbol: string,
  side: "buy" | "sell",
  tpPrice: number,
  slPrice: number,
  windowStartMs: number,
  windowEndMs: number,
  entryMs: number,
  variantId?: string,
): Promise<{ outcome?: Outcome; exitPrice?: number } | null> {
  // STRICT TEMPORAL BOUND: We never inspect candles that completed before or at entry
  const effectiveStartMs = Math.max(windowStartMs, entryMs);
  let sawLowerCandles = false;

  for (const timeframe of ["5m", "15m"] as const) {
    let lower: Candle[];
    try {
      lower = await fetchResolutionCandles(symbol, timeframe, effectiveStartMs, windowEndMs);
    } catch (error) {
      audit("lower_timeframe_fetch_failed", {
        variant_id: variantId ?? null,
        symbol,
        side,
        timeframe,
        error: error instanceof Error ? error.message : String(error),
      });
      return null; // Candle data failure
    }

    // Filter strictly to candles that ended after entryMs and started before windowEndMs
    const postEntryCandles = lower.filter(
      (c) => c.closeTimeMs > entryMs && c.openTimeMs < windowEndMs
    );

    audit("lower_timeframe_scan", {
      variant_id: variantId ?? null,
      symbol,
      side,
      timeframe,
      effective_start: new Date(effectiveStartMs).toISOString(),
      window_end: new Date(windowEndMs).toISOString(),
      candle_count: postEntryCandles.length,
      tp_price: tpPrice,
      sl_price: slPrice,
    });

    if (postEntryCandles.length === 0) continue;
    sawLowerCandles = true;

    for (const candle of postEntryCandles) {
      const hitTP = side === "buy" ? candle.high >= tpPrice : candle.low <= tpPrice;
      const hitSL = side === "buy" ? candle.low <= slPrice : candle.high >= slPrice;

      if (hitTP && hitSL) {
        audit("lower_timeframe_ambiguous", {
          variant_id: variantId ?? null,
          symbol,
          timeframe,
          candle_open_time: new Date(candle.openTimeMs).toISOString(),
          high: candle.high,
          low: candle.low,
          close: candle.close,
        });
        return { outcome: "ambiguous", exitPrice: undefined };
      }
      if (hitTP) {
        audit("lower_timeframe_tp_first", {
          variant_id: variantId ?? null,
          symbol,
          timeframe,
          candle_open_time: new Date(candle.openTimeMs).toISOString(),
        });
        return { outcome: "win", exitPrice: tpPrice };
      }
      if (hitSL) {
        audit("lower_timeframe_sl_first", {
          variant_id: variantId ?? null,
          symbol,
          timeframe,
          candle_open_time: new Date(candle.openTimeMs).toISOString(),
        });
        return { outcome: "loss", exitPrice: slPrice };
      }
    }

    // If 5m candles were present and fully checked without triggers, do not re-scan 15m
    if (timeframe === "5m" && postEntryCandles.length > 0) {
      return { outcome: undefined };
    }
  }

  if (!sawLowerCandles) return null; // No candles fetched -> retry later
  return { outcome: undefined }; // Window completed without hitting TP or SL
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

  const { count: eligibleCount, error: countError } = await supabase
    .from("strategy_variant_signals")
    .select("id", { count: "exact", head: true })
    .eq("outcome", "open")
    .in("recommendation", ["buy", "sell"])
    .not("entry_price", "is", null)
    .gt("created_at", RESOLVER_START_AT)
    .lte("created_at", maxAgeIso);

  if (countError) {
    return new Response(JSON.stringify({ ok: false, error: countError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const batchSize = 500;
  const schedulerSlot = Math.floor(nowMs / (2 * 60 * 1000));
  const expiryCutoffIso = new Date(nowMs - EXPIRY_TRIGGER_HOURS * 60 * 60 * 1000).toISOString();

  const { count: maturedCount, error: maturedCountError } = await supabase
    .from("strategy_variant_signals")
    .select("id", { count: "exact", head: true })
    .eq("outcome", "open")
    .in("recommendation", ["buy", "sell"])
    .not("entry_price", "is", null)
    .gt("created_at", RESOLVER_START_AT)
    .lte("created_at", expiryCutoffIso);

  if (maturedCountError) {
    return new Response(JSON.stringify({ ok: false, error: maturedCountError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const maturedPageCount = Math.max(1, Math.ceil((maturedCount ?? 0) / batchSize));
  const maturedPage = schedulerSlot % maturedPageCount;
  const maturedOffset = maturedPage * batchSize;

  const { data: maturedRows, error: maturedRowsError } = await supabase
    .from("strategy_variant_signals")
    .select("id, symbol, recommendation, entry_price, created_at")
    .eq("outcome", "open")
    .in("recommendation", ["buy", "sell"])
    .not("entry_price", "is", null)
    .gt("created_at", RESOLVER_START_AT)
    .lte("created_at", expiryCutoffIso)
    .order("created_at", { ascending: true })
    .range(maturedOffset, maturedOffset + batchSize - 1);

  if (maturedRowsError) {
    return new Response(JSON.stringify({ ok: false, error: maturedRowsError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const regularCount = Math.max(0, (eligibleCount ?? 0) - (maturedCount ?? 0));
  const regularSlots = batchSize;
  let regularRows: typeof maturedRows = [];
  let regularPage = 0;
  let regularPageCount = 1;
  let regularOffset = 0;

  if (regularCount > 0) {
    regularPageCount = Math.max(1, Math.ceil(regularCount / regularSlots));
    regularPage = schedulerSlot % regularPageCount;
    regularOffset = regularPage * regularSlots;

    const { data, error: regularRowsError } = await supabase
      .from("strategy_variant_signals")
      .select("id, symbol, recommendation, entry_price, created_at")
      .eq("outcome", "open")
      .in("recommendation", ["buy", "sell"])
      .not("entry_price", "is", null)
      .gt("created_at", expiryCutoffIso)
      .lte("created_at", maxAgeIso)
      .order("created_at", { ascending: true })
      .range(regularOffset, regularOffset + regularSlots - 1);

    if (regularRowsError) {
      return new Response(JSON.stringify({ ok: false, error: regularRowsError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    regularRows = data ?? [];
  }

  audit("batch_selected", {
    eligible_count: eligibleCount ?? 0,
    matured_count: maturedCount ?? 0,
    matured_page_count: maturedPageCount,
    matured_page: maturedPage,
    matured_offset: maturedOffset,
    matured_selected: (maturedRows ?? []).length,
    regular_count: regularCount,
    batch_size: batchSize,
    regular_slots: regularSlots,
    regular_page_count: regularPageCount,
    regular_page: regularPage,
    regular_offset: regularOffset,
  });

  const rows = [...(maturedRows ?? []), ...(regularRows ?? [])];
  const variants = rows
    .map((r) => ({
      id: String(r.id),
      symbol: String(r.symbol),
      recommendation: String(r.recommendation).toLowerCase() as "buy" | "sell",
      entry_price: Number(r.entry_price),
      created_at: String(r.created_at),
    }))
    .filter(
      (v) =>
        Number.isFinite(v.entry_price) &&
        v.entry_price > 0 &&
        (v.recommendation === "buy" || v.recommendation === "sell"),
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
    return new Response(
      JSON.stringify({
        ok: false,
        error: settingsResult.error?.message ?? "pipeline settings unavailable",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const tpPct = Number(settingsResult.data.variant_tp_pct);
  const slPct = Number(settingsResult.data.variant_sl_pct);
  const maxHours = Number(settingsResult.data.variant_max_hours);

  const symbols = [...new Set(variants.map((v) => v.symbol))];
  const candleFetchFailures = new Map<string, string>();
  const candleResults = await mapConcurrent(symbols, async (symbol) => {
    try {
      return { symbol, candles: await fetchResolutionCandles(symbol, "1h") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pair = (() => {
        try {
          return toBinanceSpotSymbol(symbol);
        } catch {
          return "unresolved";
        }
      })();
      candleFetchFailures.set(symbol, message);
      audit("symbol_candle_fetch_failed", { symbol, pair, interval: "1h", error: message });
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
    audit("candidate_selected", {
      variant_id: variant.id,
      symbol: variant.symbol,
      side: variant.recommendation,
      created_at: variant.created_at,
      entry_price: variant.entry_price,
      age_hours: Number(((nowMs - entryMs) / 3600000).toFixed(3)),
      candle_count_1h: candles.length,
    });

    const tpPrice =
      variant.recommendation === "buy"
        ? variant.entry_price * (1 + tpPct)
        : variant.entry_price * (1 - tpPct);
    const slPrice =
      variant.recommendation === "buy"
        ? variant.entry_price * (1 - slPct)
        : variant.entry_price * (1 + slPct);

    // Filter 1h candles whose close time is after entry
    const relevant = candles.filter(
      (c) => c.closeTimeMs > entryMs && c.closeTimeMs <= nowMs
    );

    audit("1h_window", {
      variant_id: variant.id,
      symbol: variant.symbol,
      candle_count: relevant.length,
      first_candle_open_time: relevant[0] ? new Date(relevant[0].openTimeMs).toISOString() : null,
      last_candle_open_time: relevant[relevant.length - 1]
        ? new Date(relevant[relevant.length - 1].openTimeMs).toISOString()
        : null,
      tp_price: tpPrice,
      sl_price: slPrice,
    });

    let outcome: Outcome | null = null;
    let exitPrice: number | null = null;
    let candleDataFailure = false;

    for (const candle of relevant) {
      // -------------------------------------------------------------
      // TEMPORAL CHECK: Is this candle partially BEFORE the entry?
      // -------------------------------------------------------------
      const isPartialCandle = candle.openTimeMs < entryMs;

      if (isPartialCandle) {
        // High/Low of the 1h candle contains pre-entry price movements!
        // MUST inspect 5m/15m strictly in the [entryMs, candle.closeTimeMs] window.
        audit("partial_candle_detected", {
          variant_id: variant.id,
          symbol: variant.symbol,
          candle_open_time: new Date(candle.openTimeMs).toISOString(),
          entry_time: variant.created_at,
        });

        const intraResult = await resolveIntraWindow(
          variant.symbol,
          variant.recommendation,
          tpPrice,
          slPrice,
          candle.openTimeMs,
          candle.closeTimeMs,
          entryMs,
          variant.id,
        );

        if (intraResult === null) {
          candleDataFailure = true;
          break;
        }

        if (intraResult.outcome) {
          outcome = intraResult.outcome;
          exitPrice = intraResult.exitPrice ?? (outcome === "win" ? tpPrice : slPrice);
          break; // Terminal trigger in the post-entry partial portion!
        }

        // Neither TP nor SL was hit in the remaining partial hour -> safely proceed to next 1h candle
        continue;
      }

      // -------------------------------------------------------------
      // FULL POST-ENTRY CANDLE: candle.openTimeMs >= entryMs
      // Safe to inspect 1h High / Low
      // -------------------------------------------------------------
      const hitTP =
        variant.recommendation === "buy" ? candle.high >= tpPrice : candle.low <= tpPrice;
      const hitSL =
        variant.recommendation === "buy" ? candle.low <= slPrice : candle.high >= slPrice;

      if (hitTP && hitSL) {
        audit("1h_same_candle_tp_sl", {
          variant_id: variant.id,
          symbol: variant.symbol,
          candle_open_time: new Date(candle.openTimeMs).toISOString(),
          high: candle.high,
          low: candle.low,
          close: candle.close,
          tp_price: tpPrice,
          sl_price: slPrice,
        });

        const intraResult = await resolveIntraWindow(
          variant.symbol,
          variant.recommendation,
          tpPrice,
          slPrice,
          candle.openTimeMs,
          candle.closeTimeMs,
          entryMs,
          variant.id,
        );

        if (intraResult === null) {
          candleDataFailure = true;
          break;
        }

        if (intraResult.outcome) {
          outcome = intraResult.outcome;
          exitPrice = intraResult.exitPrice ?? (outcome === "win" ? tpPrice : slPrice);
        } else {
          // Both levels touched on 1h, but 5m did not resolve order -> ambiguous
          outcome = "ambiguous";
        }
        break;
      }

      if (hitTP) {
        audit("1h_tp_hit", {
          variant_id: variant.id,
          symbol: variant.symbol,
          candle_open_time: new Date(candle.openTimeMs).toISOString(),
          high: candle.high,
          low: candle.low,
          close: candle.close,
          tp_price: tpPrice,
        });
        outcome = "win";
        exitPrice = tpPrice;
        break;
      }

      if (hitSL) {
        audit("1h_sl_hit", {
          variant_id: variant.id,
          symbol: variant.symbol,
          candle_open_time: new Date(candle.openTimeMs).toISOString(),
          high: candle.high,
          low: candle.low,
          close: candle.close,
          sl_price: slPrice,
        });
        outcome = "loss";
        exitPrice = slPrice;
        break;
      }
    }

    if (candleDataFailure) continue;

    const ageHours = (nowMs - entryMs) / 3_600_000;
    if (!outcome && ageHours >= EXPIRY_TRIGGER_HOURS) {
      expiryTriggerCount += 1;
      audit("72h_trigger", {
        variant_id: variant.id,
        symbol: variant.symbol,
        created_at: variant.created_at,
        age_hours: Number(ageHours.toFixed(3)),
        trigger_hours: EXPIRY_TRIGGER_HOURS,
        max_hours: maxHours,
      });
      expiryTriggerSymbols.push(variant.symbol);
      console.warn(
        "[VARIANT_72H_TRIGGER]",
        JSON.stringify({
          id: variant.id,
          symbol: variant.symbol,
          created_at: variant.created_at,
          age_hours: Number(ageHours.toFixed(2)),
          trigger_hours: EXPIRY_TRIGGER_HOURS,
        }),
      );
    }

    if (!outcome && ageHours >= maxHours) {
      const expiryCandle = relevant[relevant.length - 1];
      if (expiryCandle) {
        audit("expiry_decision", {
          variant_id: variant.id,
          symbol: variant.symbol,
          expiry_candle_open_time: new Date(expiryCandle.openTimeMs).toISOString(),
          close: expiryCandle.close,
          age_hours: Number(ageHours.toFixed(3)),
          max_hours: maxHours,
        });
        outcome = "expired";
        exitPrice = expiryCandle.close;
      } else if (candleFetchFailures.has(variant.symbol)) {
        audit("expiry_blocked_candle_fetch_failed", {
          variant_id: variant.id,
          symbol: variant.symbol,
          age_hours: Number(ageHours.toFixed(3)),
          max_hours: maxHours,
          error: candleFetchFailures.get(variant.symbol),
        });
      } else {
        audit("expiry_blocked_no_relevant_candle", {
          variant_id: variant.id,
          symbol: variant.symbol,
          age_hours: Number(ageHours.toFixed(3)),
          max_hours: maxHours,
        });
      }
    }

    if (!outcome) continue;

    const pnlPct =
      outcome === "ambiguous" || exitPrice == null
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
      audit("db_update_failed", {
        variant_id: variant.id,
        symbol: variant.symbol,
        outcome,
        exit_price: exitPrice,
        pnl_pct: pnlPct,
        error: update.error.message,
      });
      console.error("[VARIANT_RESOLVER] update failed", variant.id, update.error);
      continue;
    }

    audit("resolved", {
      variant_id: variant.id,
      symbol: variant.symbol,
      side: variant.recommendation,
      outcome,
      exit_price: exitPrice,
      pnl_pct: pnlPct,
      age_hours: Number(ageHours.toFixed(3)),
    });
    resolved += 1;
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      resolved,
      outcomes,
      candidates: variants.length,
      expiry_trigger_hours: EXPIRY_TRIGGER_HOURS,
      expiry_triggered: expiryTriggerCount,
      expiry_trigger_symbols: [...new Set(expiryTriggerSymbols)],
      historical_cutoff: RESOLVER_START_AT,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});

import { createHmac } from "crypto";

export const WATCHLIST = ["BTC", "ETH", "SOL", "CRV", "LINK", "ARB"];
// Per-market notional floors: large-cap books print far bigger clips than alts,
// so a single global floor either floods BTC or starves CRV/LINK/ARB.
const WHALE_MIN_USD: Record<string, number> = {
  BTC: 50_000,
  ETH: 50_000,
  SOL: 25_000,
  CRV: 5_000,
  LINK: 5_000,
  ARB: 5_000,
};
const DEFAULT_MIN_WHALE_USD = 25_000;
const whaleFloor = (coin: string) => WHALE_MIN_USD[coin] ?? DEFAULT_MIN_WHALE_USD;
const TIMEFRAME = "4h";
const KLINE_LIMIT = 100;
const MIN_CONFIDENCE = 0.6;
const PAPER_POSITION_USD = 1000;
const STOP_LOSS_PCT = 0.03;
const TAKE_PROFIT_PCT = 0.06;
const FETCH_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(input: string, init?: RequestInit) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/* ───────────── Whale alerts — Hyperliquid public recentTrades ───────────── */

interface HlTrade {
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  tid: number;
  hash?: string;
}

export async function collectWhaleAlerts(): Promise<number> {
  const db = await admin();
  const rows: Record<string, unknown>[] = [];

  for (const coin of WATCHLIST) {
    try {
      const res = await fetchWithTimeout("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "recentTrades", coin }),
      });
      if (!res.ok) continue;
      const trades = (await res.json()) as HlTrade[];
      if (!Array.isArray(trades)) continue;

      for (const t of trades.slice(0, 200)) {
        const usd = parseFloat(t.px) * parseFloat(t.sz);
        if (!Number.isFinite(usd) || usd < whaleFloor(coin)) continue;
        rows.push({
          symbol: coin,
          chain: "hyperliquid-perp",
          direction: t.side === "B" ? "accumulation" : "distribution",
          usd_value: usd,
          tx_hash: t.hash ?? String(t.tid),
          source: "hyperliquid-recent-trades",
          created_at: new Date(t.time).toISOString(),
          raw: t as unknown as Record<string, unknown>,
        });
      }
    } catch (e) {
      console.error(`whale fetch failed for ${coin}`, e);
    }
  }

  if (rows.length === 0) return 0;
  const { data, error } = await db
    .from("whale_alerts")
    .upsert(rows as never, { onConflict: "source,tx_hash", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Whale alerts — Binance public aggTrades (spot) ───────────── */

interface BinanceAggTrade {
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export async function collectExchangeWhaleAlerts(): Promise<number> {
  const db = await admin();
  const rows: Record<string, unknown>[] = [];

  for (const coin of WATCHLIST) {
    try {
      const res = await fetchWithTimeout(
        `https://api.binance.com/api/v3/aggTrades?symbol=${coin}USDT&limit=1000`,
      );
      if (!res.ok) continue;
      const trades = (await res.json()) as BinanceAggTrade[];
      if (!Array.isArray(trades)) continue;

      for (const t of trades) {
        const usd = parseFloat(t.p) * parseFloat(t.q);
        if (!Number.isFinite(usd) || usd < whaleFloor(coin)) continue;
        rows.push({
          symbol: coin,
          chain: "binance-spot",
          // m === true means the buyer was the maker, i.e. an aggressive sell.
          direction: t.m ? "distribution" : "accumulation",
          usd_value: usd,
          tx_hash: String(t.a),
          source: "binance-agg-trades",
          created_at: new Date(t.T).toISOString(),
          raw: t as unknown as Record<string, unknown>,
        });
      }
    } catch (e) {
      console.error(`binance whale fetch failed for ${coin}`, e);
    }
  }

  if (rows.length === 0) return 0;
  const { data, error } = await db
    .from("whale_alerts")
    .upsert(rows as never, { onConflict: "source,tx_hash", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Technical indicators — Binance public klines ───────────── */

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

function macd(closes: number[]) {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = e12.map((v, i) => v - e26[i]!);
  const signal = ema(line, 9);
  return { macd: line[line.length - 1]!, signal: signal[signal.length - 1]! };
}

function bollinger(closes: number[], period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  const sd = Math.sqrt(variance);
  return { upper: mean + mult * sd, lower: mean - mult * sd };
}

function classify(r: number, m: number, s: number): "bullish" | "bearish" | "neutral" {
  if (r < 35 && m > s) return "bullish";
  if (r > 65 && m < s) return "bearish";
  return "neutral";
}

export async function collectIndicators(): Promise<number> {
  const db = await admin();
  const rows: Record<string, unknown>[] = [];

  for (const coin of WATCHLIST) {
    const symbol = `${coin}USDT`;
    try {
      const res = await fetchWithTimeout(
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${TIMEFRAME}&limit=${KLINE_LIMIT}`,
      );
      if (!res.ok) continue;
      const raw = (await res.json()) as unknown[][];
      const closes = raw.map((r) => parseFloat(String(r[4])));
      if (closes.length < 30 || closes.some((close) => !Number.isFinite(close))) continue;

      const r = rsi(closes);
      const { macd: m, signal: s } = macd(closes);
      const bb = bollinger(closes);
      rows.push({
        symbol,
        timeframe: TIMEFRAME,
        rsi: Number.isFinite(r) ? r : null,
        macd: m,
        macd_signal: s,
        bb_upper: bb.upper,
        bb_lower: bb.lower,
        price: closes[closes.length - 1]!,
        signal: classify(r, m, s),
        created_at: new Date(Number(raw[raw.length - 1]?.[6])).toISOString(),
        raw: { closes_tail: closes.slice(-5) },
      });
    } catch (e) {
      console.error(`indicator fetch failed for ${symbol}`, e);
    }
  }

  if (rows.length === 0) return 0;
  const { data, error } = await db
    .from("indicator_snapshots")
    .upsert(rows as never, { onConflict: "symbol,timeframe,created_at", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Prediction markets — Polymarket Gamma API ───────────── */

const WATCH_KEYWORDS: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "eth"],
  SOL: ["solana", "sol"],
};

const cryptoWord = /\b(bitcoin|btc|ethereum|eth|solana|sol)\b/i;

interface PolymarketMarket {
  slug?: string;
  question?: string;
  outcomePrices?: string;
  volume24hr?: number;
}

interface PolymarketEvent {
  markets?: PolymarketMarket[];
}

function eventMarkets(payload: PolymarketEvent[] | PolymarketMarket[]) {
  return payload.flatMap((item) => ("markets" in item ? (item.markets ?? []) : [item]));
}

export async function collectPredictions(): Promise<number> {
  const db = await admin();
  const res = await fetchWithTimeout(
    "https://gamma-api.polymarket.com/events?tag_slug=crypto&active=true&closed=false&limit=200",
  );
  if (!res.ok) return 0;
  const payload = (await res.json()) as PolymarketEvent[] | PolymarketMarket[];
  const markets = eventMarkets(payload);

  // Remove the previously persisted Hegseth false positive and any similar
  // political result before the verified crypto feed is displayed again.
  const { error: cleanupError } = await db
    .from("prediction_snapshots")
    .delete()
    .ilike("question", "%hegseth%");
  if (cleanupError) throw cleanupError;

  const rows: Record<string, unknown>[] = [];
  for (const m of markets) {
    if (!m.slug) continue;
    const question = m.question ?? "";
    const q = question.toLowerCase();
    if (!cryptoWord.test(q)) continue;
    const symbol = Object.entries(WATCH_KEYWORDS).find(([, keywords]) =>
      keywords.some((keyword) => new RegExp(`\\b${keyword}\\b`, "i").test(q)),
    )?.[0];
    if (!symbol) continue;

    let yes: number | null = null;
    let no: number | null = null;
    try {
      const prices = JSON.parse(m.outcomePrices ?? "[]") as string[];
      yes = prices[0] ? parseFloat(prices[0]) : null;
      no = prices[1] ? parseFloat(prices[1]) : null;
    } catch {
      /* unparsable prices stay null */
    }

    if (yes == null || !Number.isFinite(yes) || yes < 0 || yes > 1) continue;

    rows.push({
      market_slug: m.slug,
      question,
      related_symbol: symbol,
      yes_price: yes,
      no_price: no,
      volume_24h: m.volume24hr ?? null,
      raw: m as unknown as Record<string, unknown>,
    });
  }

  if (rows.length === 0) return 0;
  const { data, error } = await db
    .from("prediction_snapshots")
    .upsert(rows as never, { onConflict: "market_slug" })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── AI trading council ───────────── */

type Row = Record<string, unknown> | null;

type CouncilVerdict = "BUY" | "SELL" | "HOLD" | "AVOID";

function councilEvaluation(whale: Row, indicator: Row, prediction: Row) {
  const votes: CouncilVerdict[] = [];
  const reasons: string[] = [];

  // Quant member: momentum and mean-reversion context from the latest snapshot.
  const technical = indicator?.["signal"];
  if (technical === "bullish") {
    votes.push("BUY");
    reasons.push("quant sees bullish RSI/MACD alignment");
  } else if (technical === "bearish") {
    votes.push("SELL");
    reasons.push("quant sees bearish RSI/MACD alignment");
  } else {
    votes.push("HOLD");
    reasons.push("quant sees mixed technicals");
  }

  // Whale tracker member: use the largest recent flow signal available.
  const flow = whale?.["direction"];
  if (flow === "accumulation") {
    votes.push("BUY");
    reasons.push("whale tracker sees accumulation");
  } else if (flow === "distribution") {
    votes.push("SELL");
    reasons.push("whale tracker sees distribution");
  } else {
    votes.push("HOLD");
    reasons.push("whale tracker has no directional flow");
  }

  // Sentiment member: prediction markets are intentionally a soft vote.
  const yes =
    typeof prediction?.["yes_price"] === "number" ? (prediction["yes_price"] as number) : null;
  if (yes != null && yes >= 0.6) {
    votes.push("BUY");
    reasons.push(`sentiment leans yes (${Math.round(yes * 100)}%)`);
  } else if (yes != null && yes <= 0.4) {
    votes.push("SELL");
    reasons.push(`sentiment leans no (${Math.round((1 - yes) * 100)}%)`);
  } else {
    votes.push("HOLD");
    reasons.push("sentiment is inconclusive");
  }

  const counts = votes.reduce<Record<string, number>>((all, vote) => {
    all[vote] = (all[vote] ?? 0) + 1;
    return all;
  }, {});
  const ordered = (Object.entries(counts) as [CouncilVerdict, number][]).sort(
    (a, b) => b[1] - a[1],
  );
  const [topVote, topCount] = ordered[0] ?? ["HOLD", 0];
  const conviction = Math.round((topCount / votes.length) * 100);
  const verdict: CouncilVerdict = topCount === 1 ? "AVOID" : topVote;

  return {
    final_verdict: verdict,
    conviction,
    reflection: `${verdict} with ${conviction}% consensus: ${reasons.join("; ")}.`,
  };
}

export async function collectCouncilSignals(): Promise<number> {
  const db = await admin();
  const rows: Record<string, unknown>[] = [];

  for (const symbol of WATCHLIST) {
    const [whales, indicators, predictions] = await Promise.all([
      db
        .from("whale_alerts")
        .select("*")
        .eq("symbol", symbol)
        .order("created_at", { ascending: false })
        .limit(1),
      db
        .from("indicator_snapshots")
        .select("*")
        .ilike("symbol", `${symbol}%`)
        .order("created_at", { ascending: false })
        .limit(1),
      db
        .from("prediction_snapshots")
        .select("*")
        .eq("related_symbol", symbol)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    const whale = (whales.data?.[0] ?? null) as Row;
    const indicator = (indicators.data?.[0] ?? null) as Row;
    const prediction = (predictions.data?.[0] ?? null) as Row;
    if (!whale && !indicator && !prediction) continue;

    const sourceId = [symbol, whale?.["id"], indicator?.["id"], prediction?.["id"]].join(":");
    const result = councilEvaluation(whale, indicator, prediction);
    rows.push({
      symbol,
      source_id: sourceId,
      final_verdict: result.final_verdict,
      conviction: result.conviction,
      price_at: typeof indicator?.["price"] === "number" ? indicator["price"] : null,
      reflection: result.reflection,
      depth: "ai-synthesis",
      source_created_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) return 0;
  const { data, error } = await db
    .from("council_signals")
    .upsert(rows as never, { onConflict: "source_id" })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Signal combiner ───────────── */

function ruleBased(whale: Row, indicator: Row, prediction: Row, council: Row) {
  let score = 0;
  const reasons: string[] = [];

  if (whale?.["direction"] === "accumulation") {
    score += 1;
    reasons.push("whale accumulation");
  }
  if (whale?.["direction"] === "distribution") {
    score -= 1;
    reasons.push("whale distribution");
  }
  if (indicator?.["signal"] === "bullish") {
    score += 1;
    reasons.push("bullish technicals (RSI/MACD)");
  }
  if (indicator?.["signal"] === "bearish") {
    score -= 1;
    reasons.push("bearish technicals (RSI/MACD)");
  }

  const yes = prediction?.["yes_price"] as number | null | undefined;
  if (yes != null) {
    if (yes > 0.6) {
      score += 0.5;
      reasons.push("prediction market leaning yes");
    }
    if (yes < 0.4) {
      score -= 0.5;
      reasons.push("prediction market leaning no");
    }
  }

  if (council?.["final_verdict"]) {
    const conviction = (council["conviction"] as number | null) ?? 50;
    const weight = (conviction / 100) * 1.5;
    const verdict = String(council["final_verdict"]).toUpperCase();
    if (verdict === "BUY") {
      score += weight;
      reasons.push(`council: BUY (${conviction}% conviction)`);
    } else if (verdict === "SELL" || verdict === "AVOID") {
      score -= weight;
      reasons.push(`council: ${verdict} (${conviction}% conviction)`);
    }
  }

  let recommendation: "buy" | "sell" | "hold" | "watch" = "watch";
  if (score >= 1.5) recommendation = "buy";
  else if (score <= -1.5) recommendation = "sell";
  else if (Math.abs(score) < 0.5) recommendation = "hold";

  return {
    recommendation,
    confidence: Math.min(1, Math.abs(score) / 3),
    reasoning: reasons.length ? reasons.join("; ") : "insufficient signal",
  };
}

function signalFingerprint(
  symbol: string,
  whale: Row,
  indicator: Row,
  prediction: Row,
  council: Row,
  result: ReturnType<typeof ruleBased>,
) {
  return [
    symbol,
    whale?.["id"],
    indicator?.["id"],
    prediction?.["id"],
    council?.["id"],
    result.recommendation,
    result.reasoning,
  ]
    .map((value) => value ?? "")
    .join("|");
}

export async function combineSignals(): Promise<number> {
  const db = await admin();

  const { data: councilRows } = await db.from("council_signals").select("symbol");
  const symbols = [
    ...new Set([
      ...WATCHLIST,
      ...((councilRows ?? []) as { symbol: string }[]).map((r) => r.symbol),
    ]),
  ];

  let created = 0;
  for (const symbol of symbols) {
    const [whales, indicators, predictions, councils] = await Promise.all([
      db
        .from("whale_alerts")
        .select("*")
        .eq("symbol", symbol)
        .order("created_at", { ascending: false })
        .limit(1),
      db
        .from("indicator_snapshots")
        .select("*")
        .ilike("symbol", `${symbol}%`)
        .order("created_at", { ascending: false })
        .limit(1),
      db
        .from("prediction_snapshots")
        .select("*")
        .eq("related_symbol", symbol)
        .order("created_at", { ascending: false })
        .limit(1),
      db
        .from("council_signals")
        .select("*")
        .eq("symbol", symbol)
        .order("source_created_at", { ascending: false })
        .limit(1),
    ]);

    const whale = (whales.data?.[0] ?? null) as Row;
    const indicator = (indicators.data?.[0] ?? null) as Row;
    const prediction = (predictions.data?.[0] ?? null) as Row;
    const council = (councils.data?.[0] ?? null) as Row;
    if (!whale && !indicator && !prediction && !council) continue;

    const result = ruleBased(whale, indicator, prediction, council);
    const fingerprint = signalFingerprint(symbol, whale, indicator, prediction, council, result);
    const { data, error } = await db
      .from("composite_signals")
      .upsert(
        {
          symbol,
          whale_alert_id: (whale?.["id"] as string) ?? null,
          indicator_snapshot_id: (indicator?.["id"] as string) ?? null,
          prediction_snapshot_id: (prediction?.["id"] as string) ?? null,
          council_signal_id: (council?.["id"] as string) ?? null,
          confidence: result.confidence,
          recommendation: result.recommendation,
          reasoning: result.reasoning,
          fingerprint,
        } as never,
        { onConflict: "fingerprint", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw error;
    if (data?.length) created += 1;
  }
  return created;
}

/* ───────────── Trade executor ───────────── */

export function tradingMode(): "paper" | "live" {
  const mode = process.env["TRADING_MODE"];
  const hasKeys = !!process.env["BINANCE_API_KEY"] && !!process.env["BINANCE_API_SECRET"];
  return mode === "live" && hasKeys ? "live" : "paper";
}

async function currentPrice(coin: string): Promise<number> {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${coin}USDT`);
  if (!res.ok) throw new Error(`price fetch failed for ${coin}`);
  const data = (await res.json()) as { price: string };
  return parseFloat(data.price);
}

async function placeLiveOrder(coin: string, side: "buy" | "sell", quantity: number) {
  const apiKey = process.env["BINANCE_API_KEY"];
  const apiSecret = process.env["BINANCE_API_SECRET"];
  if (!apiKey || !apiSecret) throw new Error("Binance API credentials are not configured");

  const params = new URLSearchParams({
    symbol: `${coin}USDT`,
    side: side.toUpperCase(),
    type: "MARKET",
    quantity: quantity.toFixed(6),
    timestamp: String(Date.now()),
    recvWindow: "5000",
  });
  const signature = createHmac("sha256", apiSecret).update(params.toString()).digest("hex");

  const res = await fetch(
    `https://api.binance.com/api/v3/order?${params.toString()}&signature=${signature}`,
    {
      method: "POST",
      headers: { "X-MBX-APIKEY": apiKey },
    },
  );
  const body = (await res.json()) as { orderId?: number; msg?: string };
  if (!res.ok) throw new Error(`Binance order rejected: ${body.msg ?? res.status}`);
  return String(body.orderId ?? "");
}

export async function executeTrades(): Promise<number> {
  const db = await admin();
  const mode = tradingMode();
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { data: signals, error } = await db
    .from("composite_signals")
    .select("*")
    .gte("created_at", since)
    .gte("confidence", MIN_CONFIDENCE)
    .in("recommendation", ["buy", "sell"]);
  if (error) throw error;

  let opened = 0;
  for (const signal of (signals ?? []) as {
    id: string;
    symbol: string;
    recommendation: string;
  }[]) {
    const { data: existing } = await db
      .from("trades")
      .select("id")
      .eq("composite_signal_id", signal.id)
      .limit(1);
    if (existing && existing.length > 0) continue;

    let price: number;
    try {
      price = await currentPrice(signal.symbol);
    } catch {
      continue;
    }

    const side = signal.recommendation as "buy" | "sell";
    const quantity = PAPER_POSITION_USD / price;
    const stopLoss = side === "buy" ? price * (1 - STOP_LOSS_PCT) : price * (1 + STOP_LOSS_PCT);
    const takeProfit =
      side === "buy" ? price * (1 + TAKE_PROFIT_PCT) : price * (1 - TAKE_PROFIT_PCT);

    let exchangeOrderId: string | null = null;
    if (mode === "live") {
      try {
        exchangeOrderId = await placeLiveOrder(signal.symbol, side, quantity);
      } catch (e) {
        console.error("live order failed", e);
        continue;
      }
    }

    const { error: tradeErr } = await db.from("trades").insert({
      composite_signal_id: signal.id,
      symbol: signal.symbol,
      side,
      quantity,
      entry_price: price,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      mode,
      status: "open",
      exchange_order_id: exchangeOrderId,
    } as never);
    if (tradeErr) throw tradeErr;
    opened += 1;
  }
  return opened;
}

export async function runFullPipeline() {
  const [hlWhales, exWhales] = await Promise.all([
    collectWhaleAlerts(),
    collectExchangeWhaleAlerts(),
  ]);
  const whales = hlWhales + exWhales;
  const indicators = await collectIndicators();
  const predictions = await collectPredictions();
  const council = await collectCouncilSignals();
  const signals = await combineSignals();
  const trades = await executeTrades();
  return { whales, indicators, predictions, council, signals, trades, mode: tradingMode() };
}

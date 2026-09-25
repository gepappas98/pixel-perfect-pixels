import { createHmac } from "crypto";

/* ───────────── Watchlist & market config ───────────── */

export const WATCHLIST = [
  // ── Majors / L1 ───────────────────────────────────────────────
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "TRX", "AVAX", "DOT",
  "LINK", "MATIC", "LTC", "BCH", "XLM", "ETC", "ATOM", "ALGO", "VET", "ICP",
  "HBAR", "THETA", "FTM", "RUNE", "KAVA", "EOS", "NEO", "IOTA", "KSM", "CELO",
  "ROSE", "ONE", "ZIL", "NEAR", "APT", "SUI", "SEI", "TIA", "INJ", "ARB",
  "OP", "STRK", "MANTA", "ZK", "BLAST", "LRC", "METIS", "MINA", "W",
  // ── Meme / High-beta ──────────────────────────────────────────
  "SHIB", "PEPE", "WIF", "BONK", "FLOKI", "ORDI", "BOME", "MEME",
  // ── DeFi ──────────────────────────────────────────────────────
  "UNI", "CRV", "AAVE", "MKR", "COMP", "SNX", "SUSHI", "1INCH", "CAKE", "DYDX",
  "GMX", "LDO", "ENS", "BAL", "YFI", "UMA", "JUP", "PYTH", "JTO",
  // ── AI / Data ─────────────────────────────────────────────────
  "FET", "RNDR", "WLD", "ARKM", "TAO",
  // ── Gaming / Metaverse ────────────────────────────────────────
  "SAND", "MANA", "AXS", "GALA", "IMX", "APE", "ENJ", "CHZ",
  // ── Storage / Infra ───────────────────────────────────────────
  "FIL", "AR", "STORJ", "GRT", "ANKR", "BAT", "BAND",
];

// Per-market notional floors: large-cap books print far bigger clips than alts,
// so a single global floor either floods BTC or starves CRV/LINK/ARB.
const WHALE_MIN_USD: Record<string, number> = {
  BTC: 50_000,
  ETH: 50_000,
  BNB: 50_000,
  SOL: 25_000,
  XRP: 25_000,
  ADA: 25_000,
  DOGE: 25_000,
  TRX: 20_000,
  AVAX: 15_000,
  DOT: 15_000,
  LTC: 15_000,
  BCH: 15_000,
  LINK: 10_000,
  MATIC: 10_000,
  ATOM: 10_000,
  NEAR: 10_000,
  APT: 10_000,
  SUI: 10_000,
  UNI: 10_000,
  AAVE: 10_000,
  MKR: 10_000,
  ETC: 10_000,
  XLM: 10_000,
  ICP: 10_000,
  FIL: 10_000,
  RNDR: 10_000,
  // Mid-caps & DeFi
  CRV: 5_000,
  ARB: 5_000,
  OP: 5_000,
  INJ: 5_000,
  TIA: 5_000,
  SEI: 5_000,
  RUNE: 5_000,
  FTM: 5_000,
  HBAR: 5_000,
  ALGO: 5_000,
  VET: 5_000,
  SAND: 5_000,
  MANA: 5_000,
  AXS: 5_000,
  GALA: 5_000,
  IMX: 5_000,
  GRT: 5_000,
  // Memes & small caps
  SHIB: 5_000,
  PEPE: 5_000,
  WIF: 3_000,
  BONK: 3_000,
  FLOKI: 3_000,
  ORDI: 5_000,
  BOME: 3_000,
  MEME: 3_000,
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
const MAX_OPEN_TRADES = 15;
const SYMBOL_COOLDOWN_MINUTES = 60;

async function fetchWithTimeout(input: string, init?: RequestInit) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/* ───────────── Whale alerts — Hyperliquid public recentTrades ───────────── */

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const HL_WHALE_MIN_USD = 100_000;
const TOP_MOVERS_COUNT = 25;

interface HlTrade {
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  tid: number;
  hash?: string;
}

async function hlPost<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetchWithTimeout(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${String(body["type"])} HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Top perps by 24h notional volume; empty array if the call fails. */
async function hyperliquidTopMovers(): Promise<string[]> {
  try {
    const [meta, ctxs] = await hlPost<
      [{ universe: { name: string }[] }, { dayNtlVlm?: string }[]]
    >({ type: "metaAndAssetCtxs" });
    return meta.universe
      .map((u, i) => ({ coin: u.name, vol: parseFloat(ctxs[i]?.dayNtlVlm ?? "0") || 0 }))
      .sort((a, b) => b.vol - a.vol)
      .slice(0, TOP_MOVERS_COUNT)
      .map((m) => m.coin);
  } catch (e) {
    console.error("metaAndAssetCtxs failed, falling back to base watchlist", e);
    return [];
  }
}

export async function collectWhaleAlerts(): Promise<number> {
  const db = await admin();
  const rows: Record<string, unknown>[] = [];
  const base = new Set(WATCHLIST);
  const movers = await hyperliquidTopMovers();
  const coins = [...new Set([...WATCHLIST, ...movers])];

  for (const coin of coins) {
    try {
      const trades = await hlPost<HlTrade[]>({ type: "recentTrades", coin });
      if (!Array.isArray(trades)) continue;
      const source = base.has(coin) ? "hyperliquid-recent-trades" : "hyperliquid-top-mover";

      for (const t of trades) {
        const usd = parseFloat(t.px) * parseFloat(t.sz);
        if (!Number.isFinite(usd) || usd < HL_WHALE_MIN_USD) continue;
        rows.push({
          symbol: coin,
          chain: "hyperliquid-perp",
          direction: t.side === "B" ? "accumulation" : "distribution",
          usd_value: usd,
          tx_hash: t.hash ?? String(t.tid),
          source,
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

/** Watchlist coins whose Binance ticker differs (renames/delistings). */
const BINANCE_SYMBOL_MAP: Record<string, string> = {
  MATIC: "POL",
  RNDR: "RENDER",
};

const binanceSymbol = (coin: string) => `${BINANCE_SYMBOL_MAP[coin] ?? coin}USDT`;

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
        `https://api.binance.com/api/v3/aggTrades?symbol=${binanceSymbol(coin)}&limit=1000`,
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
  const momentum = m - s;
  if ((r <= 45 && momentum > 0) || (r < 55 && momentum > 0.001 * Math.abs(m))) return "bullish";
  if ((r >= 55 && momentum < 0) || (r > 45 && momentum < -0.001 * Math.abs(m))) return "bearish";
  return "neutral";
}

export async function collectIndicators(): Promise<number> {
  const db = await admin();
  const rows: Record<string, unknown>[] = [];

  const movers = await hyperliquidTopMovers();
  const coins = [...new Set([...WATCHLIST, ...movers])];

  for (const coin of coins) {
    const symbol = binanceSymbol(coin);
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
    // ignoreDuplicates: false → τα υπάρχοντα rows με ίδιο (symbol, timeframe,
    // created_at) ενημερώνονται αντί να αγνοούνται. Επιτρέπει intra-candle
    // refreshes του RSI/MACD/price χωρίς να περιμένουμε το κλείσιμο του 4ωρου.
    .upsert(rows as never, {
      onConflict: "symbol,timeframe,created_at",
      ignoreDuplicates: false,
    })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/* ───────────── Prediction markets — Polymarket Gamma API ───────────── */

const WATCH_KEYWORDS: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "eth"],
  SOL: ["solana", "sol"],
  XRP: ["xrp", "ripple"],
  DOGE: ["dogecoin", "doge"],
  ADA: ["cardano", "ada"],
  AVAX: ["avalanche", "avax"],
  LINK: ["chainlink", "link"],
  DOT: ["polkadot", "dot"],
  LTC: ["litecoin", "ltc"],
  MATIC: ["polygon", "matic", "pol"],
  BNB: ["bnb", "binance coin"],
  TRX: ["tron", "trx"],
  SHIB: ["shiba", "shib"],
  PEPE: ["pepe"],
  ATOM: ["cosmos", "atom"],
  NEAR: ["near protocol"],
  APT: ["aptos", "apt"],
  SUI: ["sui"],
  INJ: ["injective", "inj"],
  ARB: ["arbitrum", "arb"],
  OP: ["optimism"],
  UNI: ["uniswap", "uni"],
  AAVE: ["aave"],
};

const cryptoWord = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|dogecoin|doge|cardano|ada|avalanche|avax|chainlink|link|polkadot|dot|litecoin|ltc|polygon|matic|pol|bnb|binance coin|tron|trx|shiba|shib|pepe|cosmos|atom|near protocol|aptos|apt|sui|injective|inj|arbitrum|arb|optimism|uniswap|uni|aave)\b/i;

interface PolymarketMarket {
  slug?: string;
  question?: string;
  outcomePrices?: string;
  volume24hr?: number;
}

interface PolymarketEvent {
  markets?: PolymarketMarket[];
}

function eventMarkets(payload: (PolymarketEvent | PolymarketMarket)[]): PolymarketMarket[] {
  return payload.flatMap((item) =>
    "markets" in item ? ((item as PolymarketEvent).markets ?? []) : [item as PolymarketMarket],
  );
}

export async function collectPredictions(): Promise<number> {
  const db = await admin();
  const res = await fetchWithTimeout(
    "https://gamma-api.polymarket.com/events?tag_slug=crypto&active=true&closed=false&limit=200",
  );
  if (!res.ok) return 0;
  const payload = (await res.json()) as PolymarketEvent[] | PolymarketMarket[];
  const markets = eventMarkets(payload);

  const { data: staleSnapshots, error: staleLookupError } = await db
    .from("prediction_snapshots")
    .select("id")
    .ilike("question", "%hegseth%");
  if (staleLookupError) throw staleLookupError;

  const staleIds = (staleSnapshots ?? [])
    .map((snapshot) => snapshot.id as string)
    .filter(Boolean);
  if (staleIds.length > 0) {
    const { error: unlinkError } = await db
      .from("composite_signals")
      .update({ prediction_snapshot_id: null })
      .in("prediction_snapshot_id", staleIds);
    if (unlinkError) throw unlinkError;

    const { error: cleanupError } = await db
      .from("prediction_snapshots")
      .delete()
      .in("id", staleIds);
    if (cleanupError) throw cleanupError;
  }

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

/**
 * Batch-query version: αντί για 3 queries × N symbols, εκτελεί 3 συνολικά
 * queries και κάνει group-by-symbol σε JS. Μειώνει το DB load από ~285 σε 3.
 */
export async function collectCouncilSignals(): Promise<number> {
  const db = await admin();
  const rows: Record<string, unknown>[] = [];

  const movers = await hyperliquidTopMovers();
  const symbols = [...new Set([...WATCHLIST, ...movers])];
  if (symbols.length === 0) return 0;

  const binSymbols = symbols.map(binanceSymbol);
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const [whalesRes, indicatorsRes, predictionsRes] = await Promise.all([
    db
      .from("whale_alerts")
      .select("*")
      .in("symbol", symbols)
      .gte("created_at", sixHoursAgo)
      .order("usd_value", { ascending: false })
      .limit(2000),
    // Το symbol στα indicators είναι "BTCUSDT" — φιλτράρουμε με τα binSymbols.
    db
      .from("indicator_snapshots")
      .select("*")
      .in("symbol", binSymbols)
      .order("created_at", { ascending: false })
      .limit(2000),
    db
      .from("prediction_snapshots")
      .select("*")
      .in("related_symbol", symbols)
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);

  // Group whales by symbol (κρατάμε έως 20 πιο χοντρές ανά symbol).
  const whalesBySymbol = new Map<string, Record<string, unknown>[]>();
  for (const w of (whalesRes.data ?? []) as Record<string, unknown>[]) {
    const s = w["symbol"] as string;
    const bucket = whalesBySymbol.get(s);
    if (!bucket) whalesBySymbol.set(s, [w]);
    else if (bucket.length < 20) bucket.push(w);
  }

  // Latest indicator per binSymbol (first = latest λόγω order desc).
  const latestIndicator = new Map<string, Record<string, unknown>>();
  for (const i of (indicatorsRes.data ?? []) as Record<string, unknown>[]) {
    const s = i["symbol"] as string;
    if (!latestIndicator.has(s)) latestIndicator.set(s, i);
  }

  // Latest prediction per related_symbol.
  const latestPrediction = new Map<string, Record<string, unknown>>();
  for (const p of (predictionsRes.data ?? []) as Record<string, unknown>[]) {
    const s = p["related_symbol"] as string | undefined;
    if (s && !latestPrediction.has(s)) latestPrediction.set(s, p);
  }

  for (const symbol of symbols) {
    const whaleRows = whalesBySymbol.get(symbol) ?? [];
    const accumulation = whaleRows.filter((r) => r["direction"] === "accumulation").length;
    const distribution = whaleRows.filter((r) => r["direction"] === "distribution").length;
    const whale = whaleRows.length
      ? ({
          direction:
            accumulation === distribution
              ? undefined
              : accumulation > distribution
                ? "accumulation"
                : "distribution",
          id: whaleRows[0]?.["id"],
          usd_value: whaleRows.reduce((sum, r) => sum + Number(r["usd_value"] ?? 0), 0),
        } as Row)
      : null;
    const indicator = (latestIndicator.get(binanceSymbol(symbol)) ?? null) as Row;
    const prediction = (latestPrediction.get(symbol) ?? null) as Row;
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

/**
 * Batch-query version: 4 queries συνολικά αντί για 4 × N symbols.
 */
export async function combineSignals(): Promise<number> {
  const db = await admin();

  const { data: councilRows } = await db.from("council_signals").select("symbol");
  const symbols = [
    ...new Set([
      ...WATCHLIST,
      ...((councilRows ?? []) as { symbol: string }[]).map((r) => r.symbol),
    ]),
  ];
  if (symbols.length === 0) return 0;

  const binSymbols = symbols.map(binanceSymbol);

  const [whalesRes, indicatorsRes, predictionsRes, councilsRes] = await Promise.all([
    db
      .from("whale_alerts")
      .select("*")
      .in("symbol", symbols)
      .order("created_at", { ascending: false })
      .limit(3000),
    db
      .from("indicator_snapshots")
      .select("*")
      .in("symbol", binSymbols)
      .order("created_at", { ascending: false })
      .limit(2000),
    db
      .from("prediction_snapshots")
      .select("*")
      .in("related_symbol", symbols)
      .order("created_at", { ascending: false })
      .limit(1000),
    db
      .from("council_signals")
      .select("*")
      .in("symbol", symbols)
      .order("source_created_at", { ascending: false })
      .limit(1000),
  ]);

  const latestWhale = new Map<string, Record<string, unknown>>();
  for (const w of (whalesRes.data ?? []) as Record<string, unknown>[]) {
    const s = w["symbol"] as string;
    if (!latestWhale.has(s)) latestWhale.set(s, w);
  }
  const latestIndicator = new Map<string, Record<string, unknown>>();
  for (const i of (indicatorsRes.data ?? []) as Record<string, unknown>[]) {
    const s = i["symbol"] as string;
    if (!latestIndicator.has(s)) latestIndicator.set(s, i);
  }
  const latestPrediction = new Map<string, Record<string, unknown>>();
  for (const p of (predictionsRes.data ?? []) as Record<string, unknown>[]) {
    const s = p["related_symbol"] as string | undefined;
    if (s && !latestPrediction.has(s)) latestPrediction.set(s, p);
  }
  const latestCouncil = new Map<string, Record<string, unknown>>();
  for (const c of (councilsRes.data ?? []) as Record<string, unknown>[]) {
    const s = c["symbol"] as string;
    if (!latestCouncil.has(s)) latestCouncil.set(s, c);
  }

  let created = 0;
  for (const symbol of symbols) {
    const whale = (latestWhale.get(symbol) ?? null) as Row;
    const indicator = (latestIndicator.get(binanceSymbol(symbol)) ?? null) as Row;
    const prediction = (latestPrediction.get(symbol) ?? null) as Row;
    const council = (latestCouncil.get(symbol) ?? null) as Row;
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
  const symbol = binanceSymbol(coin);
  const res = await fetchWithTimeout(
    `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,
  );
  if (!res.ok) throw new Error(`price fetch failed for ${coin} (${symbol})`);

  const data = (await res.json()) as { price: string };
  const price = Number(data.price);
  if (!Number.isFinite(price)) {
    throw new Error(`invalid price received for ${coin} (${symbol})`);
  }
  return price;
}

/** Φέρνει ΟΛΕΣ τις τιμές Binance σε ένα request (αντί για 1 call per symbol). */
async function allBinancePrices(): Promise<Map<string, number>> {
  const res = await fetchWithTimeout("https://api.binance.com/api/v3/ticker/price");
  if (!res.ok) throw new Error(`batch price fetch failed HTTP ${res.status}`);
  const data = (await res.json()) as { symbol: string; price: string }[];
  const map = new Map<string, number>();
  for (const d of data) {
    const p = Number(d.price);
    if (Number.isFinite(p)) map.set(d.symbol, p);
  }
  return map;
}

async function placeLiveOrder(coin: string, side: "buy" | "sell", quantity: number) {
  const apiKey = process.env["BINANCE_API_KEY"];
  const apiSecret = process.env["BINANCE_API_SECRET"];
  if (!apiKey || !apiSecret) throw new Error("Binance API credentials are not configured");

  const symbol = binanceSymbol(coin);
  const params = new URLSearchParams({
    symbol,
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

async function closeTriggeredTrades(): Promise<number> {
  const db = await admin();

  const { data: openTrades, error } = await db
    .from("trades")
    .select("id, symbol, side, quantity, entry_price, stop_loss, take_profit")
    .eq("status", "open");
  if (error) throw error;

  const trades = (openTrades ?? []) as {
    id: string;
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    entry_price: number;
    stop_loss: number | null;
    take_profit: number | null;
  }[];
  if (trades.length === 0) return 0;

  // Ένα request για όλες τις τιμές αντί για N.
  let prices: Map<string, number>;
  try {
    prices = await allBinancePrices();
  } catch (e) {
    console.error("batch price fetch failed, skipping close checks", e);
    return 0;
  }

  let closed = 0;

  for (const trade of trades) {
    const binSym = binanceSymbol(trade.symbol);
    const price = prices.get(binSym);
    if (price == null) {
      console.error(`no price for ${trade.symbol} (${binSym})`);
      continue;
    }

    const hitStopLoss =
      trade.stop_loss != null &&
      (trade.side === "buy" ? price <= trade.stop_loss : price >= trade.stop_loss);
    const hitTakeProfit =
      trade.take_profit != null &&
      (trade.side === "buy" ? price >= trade.take_profit : price <= trade.take_profit);
    if (!hitStopLoss && !hitTakeProfit) continue;

    const closeReason = hitStopLoss ? "stop_loss" : "take_profit";
    const closedAt = new Date().toISOString();
    const entryPrice = Number(trade.entry_price);
    const pnl =
      (trade.side === "buy" ? price - entryPrice : entryPrice - price) * Number(trade.quantity);
    const pnlPct =
      entryPrice > 0
        ? ((trade.side === "buy" ? price - entryPrice : entryPrice - price) / entryPrice) * 100
        : 0;

    const { data: closedTrade, error: closeError } = await db
      .from("trades")
      .update({
        status: "closed",
        pnl,
        exit_price: price,
        close_reason: closeReason,
        closed_at: closedAt,
      })
      .eq("id", trade.id)
      .eq("status", "open")
      .select("id")
      .maybeSingle();
    if (closeError) throw closeError;
    if (!closedTrade) continue;

    const { error: alertError } = await db.from("trade_alerts").insert({
      trade_id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      event_type: closeReason,
      entry_price: entryPrice,
      exit_price: price,
      pnl,
      pnl_pct: pnlPct,
      created_at: closedAt,
    } as never);
    if (alertError) throw alertError;
    closed += 1;
  }

  return closed;
}

export async function executeTrades(): Promise<number> {
  const db = await admin();
  const mode = tradingMode();

  await closeTriggeredTrades();

  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const cooldownSince = new Date(
    Date.now() - SYMBOL_COOLDOWN_MINUTES * 60 * 1000,
  ).toISOString();

  const [signalsRes, openTradesRes, recentlyClosedRes] = await Promise.all([
    db
      .from("composite_signals")
      .select("*")
      .gte("created_at", since)
      .gte("confidence", MIN_CONFIDENCE)
      .in("recommendation", ["buy", "sell"]),
    db.from("trades").select("symbol").eq("status", "open"),
    db
      .from("trades")
      .select("symbol")
      .eq("status", "closed")
      .gte("closed_at", cooldownSince),
  ]);
  if (signalsRes.error) throw signalsRes.error;
  if (openTradesRes.error) throw openTradesRes.error;
  if (recentlyClosedRes.error) throw recentlyClosedRes.error;

  const openSymbols = new Set(
    ((openTradesRes.data ?? []) as { symbol: string }[]).map((t) => t.symbol),
  );
  const cooldownSymbols = new Set(
    ((recentlyClosedRes.data ?? []) as { symbol: string }[]).map((t) => t.symbol),
  );

  if (openSymbols.size >= MAX_OPEN_TRADES) return 0;

  let opened = 0;
  for (const signal of (signalsRes.data ?? []) as {
    id: string;
    symbol: string;
    recommendation: string;
  }[]) {
    if (openSymbols.size >= MAX_OPEN_TRADES) break;
    if (openSymbols.has(signal.symbol)) continue;
    if (cooldownSymbols.has(signal.symbol)) continue;

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

    openSymbols.add(signal.symbol);
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

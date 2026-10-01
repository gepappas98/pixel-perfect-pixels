/**
 * CoinLobster keyless REST client.
 *
 * Endpoint: https://coinlobster.com/api/public/crypto-whales
 *
 * Free tier:
 *  - Every $1M+ CEX trade live
 *  - DEX swaps $250K+
 *  - Max 50 rows per call
 *  - 60 requests/min per IP
 *  - BTC/USD live, others 15-min delayed
 *
 * Response shape (verified live):
 *   { "success": true, "whales": [ { ...trade }, ... ] }
 *
 * Trade fields:
 *  - tradeId: "1790890099809-BingX Futures"
 *  - pair: "BTC/USD"
 *  - exchange: "BingX Futures"
 *  - exchangeType: "future" | "spot"
 *  - price: 84558.6
 *  - quantity_base: 13.2091
 *  - quantity_quote: 1116943.00  ← USD value
 *  - isBuy: false
 *  - timestamp: 1790890099809     ← ms epoch
 *  - _src: "cex" | "dex"
 */

const COINLOBSTER_BASE = "https://coinlobster.com";
const COINLOBSTER_TIMEOUT_MS = 10_000;

export interface CoinLobsterTrade {
  tradeId?: string;
  pair?: string;
  exchange?: string;
  exchangeType?: string;
  price?: number;
  quantity_base?: number;
  quantity_quote?: number;
  isBuy?: boolean;
  timestamp?: number;
  _src?: "cex" | "dex" | string;
  [key: string]: unknown;
}

interface CoinLobsterResponse {
  success?: boolean;
  whales?: CoinLobsterTrade[];
  data?: CoinLobsterTrade[];
  trades?: CoinLobsterTrade[];
  [key: string]: unknown;
}

export interface NormalizedCoinLobsterWhale {
  symbol: string;
  chain: string;
  direction: "accumulation" | "distribution";
  usd_value: number;
  tx_hash: string;
  source: string;
  created_at: string;
}

/**
 * Fetch live whale trades from CoinLobster.
 * If `coin` is undefined → global fetch (top 50 across all coins, 1 request).
 * If `coin` is provided → coin-specific fetch (max 30 rows recommended).
 */
export async function fetchCoinLobsterWhales(
  coin?: string,
  limit = 50,
): Promise<CoinLobsterTrade[] | null> {
  const url = new URL(`${COINLOBSTER_BASE}/api/public/crypto-whales`);
  if (coin) url.searchParams.set("coin", coin);
  url.searchParams.set("limit", String(Math.min(limit, 50)));

  const t0 = Date.now();
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(COINLOBSTER_TIMEOUT_MS),
    });
    const ms = Date.now() - t0;

    if (!res.ok) {
      console.warn(
        `[COINLOBSTER] ${coin ?? "all"} → HTTP ${res.status} (${ms}ms)`,
      );
      return null;
    }

    const json = (await res.json()) as CoinLobsterResponse;

    // ── Verified live API: array is in json.whales ──
    // Support fallback shapes for resilience.
    const trades = Array.isArray(json)
      ? (json as unknown as CoinLobsterTrade[])
      : Array.isArray(json.whales)
        ? json.whales
        : Array.isArray(json.data)
          ? json.data
          : Array.isArray(json.trades)
            ? json.trades
            : null;

    if (!trades) {
      console.warn(
        `[COINLOBSTER] ${coin ?? "all"} → unexpected shape (${ms}ms): ` +
          `${JSON.stringify(json).slice(0, 200)}`,
      );
      return null;
    }

    console.log(
      `[COINLOBSTER] ${coin ?? "all"} → ${trades.length} trades (${ms}ms)`,
    );
    return trades;
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(
      `[COINLOBSTER] ${coin ?? "all"} threw after ${ms}ms: ${msg}`,
    );
    return null;
  }
}

/**
 * Normalize a CoinLobster trade into our internal whale_alerts shape.
 */
export function normalizeCoinLobsterTrade(
  raw: CoinLobsterTrade,
  fallbackCoin?: string,
): NormalizedCoinLobsterWhale | null {
  // ── Symbol extraction: "BTC/USD" → "BTC" ──
  const rawPair = String(raw.pair ?? fallbackCoin ?? "");
  const symbol = (rawPair.includes("/") ? rawPair.split("/")[0] : rawPair)
    .toUpperCase()
    .trim();
  if (!symbol) return null;

  // ── Direction: isBuy boolean ──
  if (typeof raw.isBuy !== "boolean") return null;
  const direction: "accumulation" | "distribution" = raw.isBuy
    ? "accumulation"
    : "distribution";

  // ── USD value: quantity_quote (fallback: price × quantity_base) ──
  let usd = Number(raw.quantity_quote ?? 0);
  if (!Number.isFinite(usd) || usd <= 0) {
    const price = Number(raw.price ?? 0);
    const size = Number(raw.quantity_base ?? 0);
    if (price > 0 && size > 0) usd = price * size;
  }
  if (!Number.isFinite(usd) || usd <= 0) return null;

  // ── Timestamp: number in ms (13 digits) ──
  const ts = Number(raw.timestamp ?? Date.now());
  const createdAt = new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();

  // ── Venue & Source ──
  const isDex =
    raw._src === "dex" ||
    String(raw.exchange ?? "").toLowerCase().includes("dex");
  const venue = String(raw.exchange ?? "cex")
    .toLowerCase()
    .replace(/\s+/g, "-");
  const source = isDex ? "coinlobster-dex" : "coinlobster-cex";
  const chain = isDex ? `dex-${venue}` : `cex-${venue}`;

  // ── Unique tx_hash for onConflict deduplication ──
  const txHash = String(
    raw.tradeId ?? `${venue}-${symbol}-${ts}-${Math.round(usd)}`,
  );

  return {
    symbol,
    chain,
    direction,
    usd_value: Math.round(usd * 100) / 100,
    tx_hash: txHash,
    source,
    created_at: createdAt,
  };
}

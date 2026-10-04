import { createHmac } from "crypto";

export type BinanceSpotSide = "BUY" | "SELL";

export interface BinanceSpotOrder {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side?: BinanceSpotSide;
  status?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  fills?: Array<{
    price: string;
    qty: string;
    commission?: string;
    commissionAsset?: string;
  }>;
}

interface BinanceFilter {
  filterType: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  minNotional?: string;
  maxNotional?: string;
  applyToMarket?: boolean;
  tickSize?: string;
}

interface BinanceSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  filters: BinanceFilter[];
}

interface BinanceExchangeInfo {
  symbols: BinanceSymbolInfo[];
}

interface BinanceBalance {
  asset: string;
  free: string;
  locked: string;
}

interface BinanceAccount {
  balances: BinanceBalance[];
}

const DEFAULT_BASE_URL = "https://api.binance.com";
const REQUEST_TIMEOUT_MS = 10_000;
const RECV_WINDOW = "5000";
const EXCHANGE_INFO_TTL_MS = 6 * 60 * 60 * 1000;

let exchangeInfoCache:
  | {
      data: BinanceExchangeInfo;
      expiresAt: number;
    }
  | null = null;

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

function baseUrl(): string {
  return (
    process.env["BINANCE_SPOT_BASE_URL"]?.trim() ||
    DEFAULT_BASE_URL
  );
}

function getCredentials(): {
  apiKey: string;
  apiSecret: string;
} {
  const apiKey = process.env["BINANCE_API_KEY"];
  const apiSecret = process.env["BINANCE_API_SECRET"];

  if (!apiKey || !apiSecret) {
    throw new Error(
      "Binance Spot credentials are not configured",
    );
  }

  return {
    apiKey,
    apiSecret,
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

async function binanceRequest(
  path: string,
  method: "GET" | "POST",
  params: URLSearchParams,
  signed: boolean,
): Promise<Response> {
  const { apiKey, apiSecret } = getCredentials();

  if (signed) {
    params.set("timestamp", String(Date.now()));
    params.set("recvWindow", RECV_WINDOW);

    const signature = createHmac(
      "sha256",
      apiSecret,
    )
      .update(params.toString())
      .digest("hex");

    params.set("signature", signature);
  }

  const query = params.toString();

  const url = query
    ? `${baseUrl()}${path}?${query}`
    : `${baseUrl()}${path}`;

  return fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": apiKey,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function parseJson<T>(
  response: Response,
  operation: string,
): Promise<T> {
  const raw = await response.text();

  let body: unknown = null;

  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    let message = raw.slice(0, 500);

    if (
      body &&
      typeof body === "object" &&
      "msg" in body
    ) {
      message = String(
        (body as { msg?: unknown }).msg ?? message,
      );
    }

    throw new Error(
      `${operation} HTTP ${response.status}: ${message}`,
    );
  }

  return body as T;
}

/* -------------------------------------------------------------------------- */
/* Symbol normalization                                                       */
/* -------------------------------------------------------------------------- */

const BINANCE_SYMBOL_MAP: Record<string, string> = {
  MATIC: "POL",
  RNDR: "RENDER",
};

export function normalizeBinanceSymbol(
  coin: string,
): string {
  const normalized = coin
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase();

  if (normalized.endsWith("USDT")) {
    const base = normalized.slice(0, -4);

    return `${BINANCE_SYMBOL_MAP[base] ?? base}USDT`;
  }

  return `${BINANCE_SYMBOL_MAP[normalized] ?? normalized}USDT`;
}

/* -------------------------------------------------------------------------- */
/* Exchange info                                                              */
/* -------------------------------------------------------------------------- */

async function getExchangeInfo(): Promise<BinanceExchangeInfo> {
  const now = Date.now();

  if (
    exchangeInfoCache &&
    exchangeInfoCache.expiresAt > now
  ) {
    return exchangeInfoCache.data;
  }

  const response = await binanceRequest(
    "/api/v3/exchangeInfo",
    "GET",
    new URLSearchParams(),
    false,
  );

  const data =
    await parseJson<BinanceExchangeInfo>(
      response,
      "Binance exchangeInfo",
    );

  exchangeInfoCache = {
    data,
    expiresAt: now + EXCHANGE_INFO_TTL_MS,
  };

  return data;
}

async function getSymbolInfo(
  symbol: string,
): Promise<BinanceSymbolInfo> {
  const data = await getExchangeInfo();

  const info = data.symbols.find(
    (item) => item.symbol === symbol,
  );

  if (!info) {
    throw new Error(
      `Binance Spot symbol not found: ${symbol}`,
    );
  }

  if (info.status !== "TRADING") {
    throw new Error(
      `Binance Spot symbol is not TRADING: ${symbol} (${info.status})`,
    );
  }

  return info;
}

function getFilter(
  info: BinanceSymbolInfo,
  type: string,
): BinanceFilter | undefined {
  return info.filters.find(
    (filter) => filter.filterType === type,
  );
}

/* -------------------------------------------------------------------------- */
/* Quantity math                                                              */
/* -------------------------------------------------------------------------- */

function decimalPlaces(step: number): number {
  if (!Number.isFinite(step) || step <= 0) {
    return 8;
  }

  const text = step.toString();

  if (text.includes("e-")) {
    return Number(text.split("e-")[1]);
  }

  const dot = text.indexOf(".");

  return dot >= 0
    ? text.length - dot - 1
    : 0;
}

function floorToStep(
  value: number,
  step: number,
): number {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isFinite(step) ||
    step <= 0
  ) {
    return 0;
  }

  const units = Math.floor(
    (value + step * 1e-9) / step,
  );

  return units * step;
}

function formatQuantity(
  value: number,
  step: number,
): string {
  const places = Math.min(
    16,
    Math.max(0, decimalPlaces(step)),
  );

  return value
    .toFixed(places)
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "")
    .replace(/\.$/, "");
}

/* -------------------------------------------------------------------------- */
/* Account / balance                                                          */
/* -------------------------------------------------------------------------- */

export async function getSpotFreeBalance(
  asset: string,
): Promise<number> {
  const response = await binanceRequest(
    "/api/v3/account",
    "GET",
    new URLSearchParams(),
    true,
  );

  const account =
    await parseJson<BinanceAccount>(
      response,
      "Binance account",
    );

  const balance = account.balances.find(
    (item) => item.asset === asset,
  );

  return Number(balance?.free ?? 0);
}

/* -------------------------------------------------------------------------- */
/* SELL safety                                                                */
/* -------------------------------------------------------------------------- */

export async function getExecutableSpotSellQuantity(
  coin: string,
  requestedQuantity: number,
): Promise<number> {
  const symbol = normalizeBinanceSymbol(coin);

  const info = await getSymbolInfo(symbol);

  const freeBalance =
    await getSpotFreeBalance(info.baseAsset);

  if (
    !Number.isFinite(freeBalance) ||
    freeBalance <= 0
  ) {
    throw new Error(
      `[BINANCE_SPOT] SELL blocked: no free ${info.baseAsset} balance`,
    );
  }

  const lotFilter =
    getFilter(info, "MARKET_LOT_SIZE") ??
    getFilter(info, "LOT_SIZE");

  if (!lotFilter) {
    throw new Error(
      `[BINANCE_SPOT] SELL blocked: no LOT_SIZE/MARKET_LOT_SIZE for ${symbol}`,
    );
  }

  const stepSize = Number(
    lotFilter.stepSize ?? "0",
  );

  const minQty = Number(
    lotFilter.minQty ?? "0",
  );

  const maxQty = Number(
    lotFilter.maxQty ?? "0",
  );

  if (
    !Number.isFinite(stepSize) ||
    stepSize <= 0
  ) {
    throw new Error(
      `[BINANCE_SPOT] SELL blocked: invalid stepSize for ${symbol}`,
    );
  }

  const requested = Number(
    requestedQuantity,
  );

  if (
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    throw new Error(
      `[BINANCE_SPOT] SELL blocked: invalid requested quantity ${requestedQuantity}`,
    );
  }

  const capped = Math.min(
    requested,
    freeBalance,
    maxQty > 0 ? maxQty : requested,
  );

  const executable =
    floorToStep(capped, stepSize);

  if (executable <= 0) {
    throw new Error(
      `[BINANCE_SPOT] SELL blocked: executable quantity is zero`,
    );
  }

  if (
    minQty > 0 &&
    executable < minQty
  ) {
    throw new Error(
      `[BINANCE_SPOT] SELL blocked: ${executable} < minQty ${minQty}`,
    );
  }

  return executable;
}

/* -------------------------------------------------------------------------- */
/* Notional validation                                                        */
/* -------------------------------------------------------------------------- */

async function validateMarketNotional(
  symbol: string,
  quantity: number,
): Promise<void> {
  const info = await getSymbolInfo(symbol);

  const notionalFilter =
    getFilter(info, "NOTIONAL") ??
    getFilter(info, "MIN_NOTIONAL");

  if (!notionalFilter) {
    return;
  }

  const minNotional = Number(
    notionalFilter.minNotional ?? "0",
  );

  if (
    !Number.isFinite(minNotional) ||
    minNotional <= 0
  ) {
    return;
  }

  const tickerResponse =
    await binanceRequest(
      "/api/v3/ticker/price",
      "GET",
      new URLSearchParams([
        ["symbol", symbol],
      ]),
      false,
    );

  const ticker =
    await parseJson<{ price: string }>(
      tickerResponse,
      "Binance ticker",
    );

  const price = Number(ticker.price);

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      `[BINANCE_SPOT] invalid market price for ${symbol}`,
    );
  }

  const notional =
    quantity * price;

  if (notional < minNotional) {
    throw new Error(
      `[BINANCE_SPOT] order blocked: ${symbol} notional ${notional.toFixed(
        8,
      )} < minimum ${minNotional}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Order status reconciliation                                                 */
/* -------------------------------------------------------------------------- */

export async function querySpotOrder(
  symbol: string,
  clientOrderId: string,
): Promise<BinanceSpotOrder | null> {
  try {
    const params =
      new URLSearchParams({
        symbol,
        origClientOrderId: clientOrderId,
      });

    const response =
      await binanceRequest(
        "/api/v3/order",
        "GET",
        params,
        true,
      );

    if (!response.ok) {
      return null;
    }

    return await parseJson<BinanceSpotOrder>(
      response,
      "Binance order status",
    );
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* MARKET order                                                               */
/* -------------------------------------------------------------------------- */

export async function placeBinanceSpotMarketOrder(
  coin: string,
  side: "buy" | "sell",
  requestedQuantity: number,
): Promise<BinanceSpotOrder> {
  const symbol =
    normalizeBinanceSymbol(coin);

  const info =
    await getSymbolInfo(symbol);

  if (
    side !== "buy" &&
    side !== "sell"
  ) {
    throw new Error(
      `[BINANCE_SPOT] unsupported side: ${side}`,
    );
  }

  let quantity =
    Number(requestedQuantity);

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error(
      `[BINANCE_SPOT] invalid quantity for ${symbol}: ${requestedQuantity}`,
    );
  }

  const lotFilter =
    getFilter(info, "MARKET_LOT_SIZE") ??
    getFilter(info, "LOT_SIZE");

  if (!lotFilter) {
    throw new Error(
      `[BINANCE_SPOT] missing quantity filter for ${symbol}`,
    );
  }

  const stepSize = Number(
    lotFilter.stepSize ?? "0",
  );

  const minQty = Number(
    lotFilter.minQty ?? "0",
  );

  const maxQty = Number(
    lotFilter.maxQty ?? "0",
  );

  if (
    !Number.isFinite(stepSize) ||
    stepSize <= 0
  ) {
    throw new Error(
      `[BINANCE_SPOT] invalid stepSize for ${symbol}`,
    );
  }

  /*
   * CRITICAL SPOT RULE:
   *
   * SELL can only close/reduce an existing
   * asset balance. It must never create a short.
   */
  if (side === "sell") {
    quantity =
      await getExecutableSpotSellQuantity(
        coin,
        quantity,
      );
  } else {
    quantity =
      floorToStep(
        quantity,
        stepSize,
      );

    if (
      maxQty > 0 &&
      quantity > maxQty
    ) {
      quantity = maxQty;
    }

    if (
      minQty > 0 &&
      quantity < minQty
    ) {
      throw new Error(
        `[BINANCE_SPOT] BUY blocked: ${quantity} < minQty ${minQty}`,
      );
    }
  }

  if (quantity <= 0) {
    throw new Error(
      `[BINANCE_SPOT] zero executable quantity for ${symbol}`,
    );
  }

  await validateMarketNotional(
    symbol,
    quantity,
  );

  /*
   * Unique client order ID gives us deterministic
   * reconciliation when Binance returns an unknown
   * execution status.
   */
  const clientOrderId =
    `tcc_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  const params =
    new URLSearchParams({
      symbol,
      side: side.toUpperCase(),
      type: "MARKET",
      quantity: formatQuantity(
        quantity,
        stepSize,
      ),
      newOrderRespType: "FULL",
      newClientOrderId:
        clientOrderId,
    });

  console.log(
    `[BINANCE_SPOT] ${side.toUpperCase()} ${symbol} qty=${params.get(
      "quantity",
    )} clientOrderId=${clientOrderId}`,
  );

  try {
    const response =
      await binanceRequest(
        "/api/v3/order",
        "POST",
        params,
        true,
      );

    const order =
      await parseJson<BinanceSpotOrder>(
        response,
        "Binance MARKET order",
      );

    console.log(
      `[BINANCE_SPOT] order accepted symbol=${symbol} orderId=${order.orderId} status=${order.status ?? "UNKNOWN"} executedQty=${order.executedQty ?? "0"}`,
    );

    return order;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    /*
     * Binance may return an unknown execution state
     * after a matching-engine timeout.
     *
     * NEVER blindly retry a MARKET order.
     */
    if (
      /timeout|timed out|-1007|unknown/i.test(
        message,
      )
    ) {
      console.warn(
        `[BINANCE_SPOT] execution status UNKNOWN; reconciling clientOrderId=${clientOrderId}`,
      );

      const reconciled =
        await querySpotOrder(
          symbol,
          clientOrderId,
        );

      if (reconciled) {
        console.log(
          `[BINANCE_SPOT] reconciled unknown order clientOrderId=${clientOrderId} orderId=${reconciled.orderId} status=${reconciled.status ?? "UNKNOWN"}`,
        );

        return reconciled;
      }

      throw new Error(
        `[BINANCE_SPOT] order execution UNKNOWN and reconciliation failed for ${clientOrderId}; NO RETRY`,
      );
    }

    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Position reconciliation                                                    */
/* -------------------------------------------------------------------------- */

export async function reconcileSpotSymbol(
  coin: string,
): Promise<{
  symbol: string;
  baseAsset: string;
  freeBase: number;
  openOrders: number;
}> {
  const symbol =
    normalizeBinanceSymbol(coin);

  const info =
    await getSymbolInfo(symbol);

  const freeBase =
    await getSpotFreeBalance(
      info.baseAsset,
    );

  const params =
    new URLSearchParams({
      symbol,
    });

  const response =
    await binanceRequest(
      "/api/v3/openOrders",
      "GET",
      params,
      true,
    );

  const orders =
    await parseJson<unknown[]>(
      response,
      "Binance openOrders",
    );

  return {
    symbol,
    baseAsset: info.baseAsset,
    freeBase,
    openOrders: Array.isArray(orders)
      ? orders.length
      : 0,
  };
}

import { createFileRoute } from "@tanstack/react-router";

const BINANCE_BASE_URL = "https://api.binance.com";

/*
 * Server-side proxy for Binance Spot prices.
 *
 * The browser never talks to api.binance.com directly:
 * PortfolioPanel.tsx calls /api/binance/spot-price?symbol=SYMBOLUSDT
 * and this route fetches, validates and forwards the price.
 */
export const Route = createFileRoute("/api/binance/spot-price")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const symbol = url.searchParams.get("symbol");

        if (!symbol) {
          return Response.json({ error: "Missing symbol" }, { status: 400 });
        }

        const normalized = symbol.trim().toUpperCase();

        /*
         * Strict Spot symbol validation.
         * We only allow symbols such as BTCUSDT.
         */
        if (
          !/^[A-Z0-9]{5,20}$/.test(normalized) ||
          !normalized.endsWith("USDT")
        ) {
          return Response.json(
            { error: "Invalid Binance Spot symbol" },
            { status: 400 },
          );
        }

        try {
          const response = await fetch(
            `${BINANCE_BASE_URL}/api/v3/ticker/price?symbol=${encodeURIComponent(
              normalized,
            )}`,
            {
              cache: "no-store",
              signal: AbortSignal.timeout(5000),
            },
          );

          const body = await response.text();

          // Keep the proxy response at 502 for the UI, but expose the
          // actual upstream Binance status so incidents can be diagnosed.
          if (!response.ok) {
            console.error("[BINANCE_SPOT_PRICE_UPSTREAM]", {
              symbol: normalized,
              upstreamStatus: response.status,
              upstreamStatusText: response.statusText,
              retryAfter: response.headers.get("retry-after"),
              usedWeight1m: response.headers.get("x-mbx-used-weight-1m"),
              usedWeight1mIp: response.headers.get("x-mbx-used-weight-1m-ip"),
            });

            return Response.json(
              {
                error: "Binance Spot price request failed",
                status: response.status,
                upstreamStatus: response.status,
                upstreamStatusText: response.statusText,
              },
              { status: 502 },
            );
          }

          let payload: {
            symbol?: string;
            price?: string;
          };

          try {
            payload = JSON.parse(body);
          } catch {
            console.error("[BINANCE_SPOT_PRICE_INVALID_JSON]", {
              symbol: normalized,
            });

            return Response.json(
              { error: "Invalid Binance response" },
              { status: 502 },
            );
          }

          const price = Number(payload.price);

          if (!Number.isFinite(price) || price <= 0) {
            console.error("[BINANCE_SPOT_PRICE_INVALID_PRICE]", {
              symbol: normalized,
              upstreamSymbol: payload.symbol,
              rawPrice: payload.price,
            });

            return Response.json(
              { error: "Invalid Binance price" },
              { status: 502 },
            );
          }

          return Response.json(
            {
              symbol: payload.symbol ?? normalized,
              price: payload.price,
            },
            {
              headers: {
                "Cache-Control": "no-store",
              },
            },
          );
        } catch (error) {
          console.error("[BINANCE_SPOT_PRICE]", {
            symbol: normalized,
            error: error instanceof Error ? error.message : String(error),
          });

          return Response.json(
            { error: "Binance Spot price unavailable" },
            { status: 502 },
          );
        }
      },
    },
  },
});

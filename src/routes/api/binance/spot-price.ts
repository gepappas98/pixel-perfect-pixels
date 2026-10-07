import { createFileRoute } from "@tanstack/react-router";

const BINANCE_BASE_URLS = [
  "https://api.binance.com",
  "https://api1.binance.com",
] as const;

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
          let lastUpstreamFailure: {
            status: number;
            statusText: string;
            retryAfter: string | null;
            usedWeight1m: string | null;
            usedWeight1mIp: string | null;
            baseUrl: string;
          } | null = null;

          let body = "";
          let response: Response | null = null;

          for (const baseUrl of BINANCE_BASE_URLS) {
            try {
              const candidate = await fetch(
                `${baseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(
                  normalized,
                )}`,
                {
                  cache: "no-store",
                  signal: AbortSignal.timeout(5000),
                },
              );

              if (candidate.ok) {
                response = candidate;
                body = await candidate.text();
                break;
              }

              lastUpstreamFailure = {
                status: candidate.status,
                statusText: candidate.statusText,
                retryAfter: candidate.headers.get("retry-after"),
                usedWeight1m: candidate.headers.get("x-mbx-used-weight-1m"),
                usedWeight1mIp: candidate.headers.get("x-mbx-used-weight-1m-ip"),
                baseUrl,
              };
            } catch (error) {
              console.error("[BINANCE_SPOT_PRICE_ATTEMPT]", {
                symbol: normalized,
                baseUrl,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          // Keep the proxy response at 502 for the UI, but expose the
          // actual upstream Binance status so incidents can be diagnosed.
          if (!response) {
            console.error("[BINANCE_SPOT_PRICE_UPSTREAM]", {
              symbol: normalized,
              ...lastUpstreamFailure,
            });

            return Response.json(
              {
                error: "Binance Spot price request failed",
                status: lastUpstreamFailure?.status ?? 502,
                upstreamStatus: lastUpstreamFailure?.status ?? 502,
                upstreamStatusText:
                  lastUpstreamFailure?.statusText ?? "No Binance response",
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

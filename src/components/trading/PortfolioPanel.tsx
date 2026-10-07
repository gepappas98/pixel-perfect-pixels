"use client";

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getTradingStatus } from "@/lib/pipeline.functions";

import {
  Briefcase,
  TrendingUp,
  TrendingDown,
  Target,
  Activity,
  Loader2,
  ShieldCheck,
  CircleAlert,
} from "lucide-react";

interface PortfolioSummary {
  open_count: number;
  open_entry_notional: number;
  open_market_value: number;

  unrealized_gross_pnl: number;
  unrealized_net_pnl_est: number;
  estimated_open_exit_fees: number;

  closed_count: number;
  realized_gross_pnl: number;
  realized_net_pnl: number;
  total_fees: number;

  win_count: number;
  loss_count: number;
  win_rate_pct: number | null;

  gross_profit: number;
  gross_loss: number;
  profit_factor: number | null;

  avg_win_usd: number;
  avg_loss_usd: number | null;

  last_24h_closed: number;
  last_24h_realized_net_pnl: number;

  best_trade_net_pnl: number | null;
  worst_trade_net_pnl: number | null;

  open_symbols: string[] | null;
  marked_open_count: number;
  unmarked_open_count: number;

  legacy_open_sell_count: number;
  legacy_closed_sell_count: number;
}

interface TradingStatus {
  mode: "paper" | "live";
  binanceConfigured: boolean;
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const moneyCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

function fmtSigned(
  value: number | null | undefined,
): string {
  if (
    value == null ||
    !Number.isFinite(value)
  ) {
    return "—";
  }

  const sign =
    value >= 0 ? "+" : "-";

  return `${sign}${money.format(
    Math.abs(value),
  )}`;
}

function fmtMoney(
  value: number | null | undefined,
): string {
  if (
    value == null ||
    !Number.isFinite(value)
  ) {
    return "—";
  }

  return money.format(value);
}

function binanceSymbol(
  coin: string,
): string {
  const normalized =
    String(coin).toUpperCase();

  if (normalized === "MATIC") {
    return "POLUSDT";
  }

  if (normalized === "RNDR") {
    return "RENDERUSDT";
  }

  return `${normalized}USDT`;
}

async function fetchSpotMarks(
  symbols: string[],
): Promise<Record<string, number>> {
  const unique = [
    ...new Set(
      symbols.filter(Boolean),
    ),
  ];

  if (unique.length === 0) {
    return {};
  }

  const results = await Promise.all(
    unique.map(async (symbol) => {
      try {
        const response = await fetch(
          `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(
            binanceSymbol(symbol),
          )}`,
          {
            cache: "no-store",
          },
        );

        if (!response.ok) {
          console.warn(
            `[PORTFOLIO_MARK_UNAVAILABLE] ${symbol} HTTP ${response.status}`,
          );
          return null;
        }

        const payload = (await response.json()) as {
          price?: string | number;
        };

        const price = Number(payload.price);

        if (!Number.isFinite(price) || price <= 0) {
          console.warn(
            `[PORTFOLIO_MARK_UNAVAILABLE] ${symbol} invalid price`,
          );
          return null;
        }

        return [symbol, price] as const;
      } catch (err) {
        console.warn(
          `[PORTFOLIO_MARK_FETCH_ERROR] ${symbol}:`,
          err,
        );
        return null;
      }
    }),
  );

  return Object.fromEntries(
    results.filter(
      (entry): entry is readonly [string, number] =>
        entry !== null,
    ),
  );
}

const NUM_KEYS = [
  "open_count","open_entry_notional","open_market_value","unrealized_gross_pnl",
  "unrealized_net_pnl_est","estimated_open_exit_fees","closed_count","realized_gross_pnl",
  "realized_net_pnl","total_fees","win_count","loss_count","gross_profit","gross_loss",
  "avg_win_usd","last_24h_closed","last_24h_realized_net_pnl","marked_open_count",
  "unmarked_open_count","legacy_open_sell_count","legacy_closed_sell_count",
] as const;
const NULLABLE_KEYS = [
  "win_rate_pct","profit_factor","avg_loss_usd","best_trade_net_pnl","worst_trade_net_pnl",
] as const;

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Safe typing: required metrics must be finite numbers, otherwise we throw
 *  (the panel shows an error instead of misleading zeros). */
function normalizeSummary(raw: unknown): PortfolioSummary {
  if (!raw || typeof raw !== "object") throw new Error("get_portfolio_summary returned no row");
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of NUM_KEYS) {
    const n = toNum(r[k]);
    if (n == null) throw new Error(`get_portfolio_summary: missing/invalid field ${k}`);
    out[k] = n;
  }
  for (const k of NULLABLE_KEYS) out[k] = toNum(r[k]);
  out["open_symbols"] = Array.isArray(r["open_symbols"]) ? (r["open_symbols"] as unknown[]).map(String) : [];
  return out as unknown as PortfolioSummary;
}

async function loadPortfolioSummary(): Promise<PortfolioSummary> {
  /*
   * First call:
   * obtain the list of currently open Spot BUY symbols.
   */
  const initial =
    await supabase.rpc(
      "get_portfolio_summary",
      { p_mark_prices: {} },
    );

  if (initial.error) {
    throw initial.error;
  }

  const initialRowRaw =
    (
      Array.isArray(initial.data)
        ? initial.data[0]
        : initial.data
    );
  const initialRow = normalizeSummary(initialRowRaw);

  const symbols =
    initialRow.open_symbols ?? [];

  /*
   * No open positions:
   * no market-price request required.
   */
  if (symbols.length === 0) {
    return initialRow;
  }

  /*
   * Fetch only the symbols that are
   * actually open.
   */
  const marks =
    await fetchSpotMarks(symbols);

  /*
   * Second RPC:
   * calculate true mark-to-market values.
   */
  const marked =
    await supabase.rpc(
      "get_portfolio_summary",
      { p_mark_prices: marks },
    );

  if (marked.error) {
    throw marked.error;
  }

  const markedRowRaw =
    (
      Array.isArray(marked.data)
        ? marked.data[0]
        : marked.data
    );

  return normalizeSummary(markedRowRaw);
}

export function PortfolioPanel() {
  const {
    data,
    isLoading,
    error,
    dataUpdatedAt,
  } =
    useQuery<PortfolioSummary>({
      queryKey: [
        "portfolio-summary",
        "spot-long-only",
      ],

      queryFn:
        loadPortfolioSummary,

      refetchInterval:
        30_000,

      staleTime:
        25_000,
    });

  /*
   * Real trading mode (PAPER / LIVE) from the
   * server environment via tradingMode().
   */
  const statusFn =
    useServerFn(getTradingStatus);

  const { data: status } =
    useQuery<TradingStatus>({
      queryKey: [
        "trading-status",
        "mode",
      ],

      queryFn: () =>
        statusFn(),

      staleTime:
        60_000,
    });

  const tradingMode =
    status?.mode;

  const isLiveMode =
    tradingMode === "live";

  const modeBadgeLabel =
    tradingMode === "live"
      ? "LIVE · LONG-ONLY"
      : tradingMode === "paper"
        ? "PAPER · LONG-ONLY"
        : "LONG-ONLY";

  if (isLoading) {
    return (
      <section className="panel">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />

          <span className="text-sm">
            Loading Spot portfolio…
          </span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="panel border-destructive/30 bg-destructive/5">
        <div className="flex items-center gap-2 text-destructive">
          <Activity className="h-4 w-4" />

          <h2 className="panel-title text-destructive">
            Portfolio Summary
          </h2>
        </div>

        <p className="mt-3 text-xs text-destructive/80">
          Failed to load Spot portfolio accounting.
        </p>

        <p className="mt-2 break-words font-mono text-[10px] text-destructive/60">
          {(error as Error).message}
        </p>
      </section>
    );
  }

  if (!data) {
    return null;
  }

  const hasClosed =
    data.closed_count > 0;

  const hasOpen =
    data.open_count > 0;

  const marksComplete =
    data.unmarked_open_count === 0;

  const realizedPositive =
    data.realized_net_pnl >= 0;

  const unrealizedPositive =
    data.unrealized_net_pnl_est >= 0;

  const last24Positive =
    data.last_24h_realized_net_pnl >= 0;

  const pf =
    data.profit_factor;

  return (
    <section className="panel">

      {/* ================================================== */}
      {/* HEADER */}
      {/* ================================================== */}

      <div className="mb-3 flex items-start justify-between gap-3">

        <div>

          <h2 className="panel-title flex items-center gap-2">

            <Briefcase className="h-4 w-4 text-accent" />

            Portfolio Summary

          </h2>

          <div className="mt-1 flex flex-wrap items-center gap-1.5">

            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Spot · Long-only · Realized + Unrealized
            </span>

            <span
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${
                isLiveMode
                  ? "border-warn/40 bg-warn/10 text-warn"
                  : "border-accent/30 bg-accent/5 text-accent"
              }`}
            >

              <ShieldCheck className="h-2.5 w-2.5" />

              {modeBadgeLabel}

            </span>

          </div>

        </div>

        {dataUpdatedAt > 0 && (
          <span className="whitespace-nowrap text-[10px] text-muted-foreground">
            Updated{" "}
            {new Date(
              dataUpdatedAt,
            ).toLocaleTimeString()}
          </span>
        )}

      </div>


      {/* ================================================== */}
      {/* PRIMARY METRICS */}
      {/* ================================================== */}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">


        {/* REALIZED */}

        <div className="rounded-md border border-border/70 bg-background/30 p-3">

          <div className="flex items-center justify-between gap-2">

            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Realized Net PnL
            </span>

            {realizedPositive ? (
              <TrendingUp className="h-3.5 w-3.5 text-bull" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-bear" />
            )}

          </div>

          <p
            className={`mt-1 font-mono text-lg font-semibold ${
              realizedPositive
                ? "text-bull"
                : "text-bear"
            }`}
          >
            {hasClosed
              ? fmtSigned(
                  data.realized_net_pnl,
                )
              : "—"}
          </p>

          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {data.closed_count} closed · fees{" "}
            {fmtMoney(data.total_fees)}
          </p>

        </div>


        {/* UNREALIZED */}

        <div className="rounded-md border border-border/70 bg-background/30 p-3">

          <div className="flex items-center justify-between gap-2">

            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Unrealized Net PnL
            </span>

            {unrealizedPositive ? (
              <TrendingUp className="h-3.5 w-3.5 text-bull" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-bear" />
            )}

          </div>

          <p
            className={`mt-1 font-mono text-lg font-semibold ${
              !hasOpen ||
              !marksComplete
                ? "text-muted-foreground"
                : unrealizedPositive
                  ? "text-bull"
                  : "text-bear"
            }`}
          >
            {!hasOpen ||
            !marksComplete
              ? "—"
              : fmtSigned(
                  data.unrealized_net_pnl_est,
                )}
          </p>

          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {data.open_count} open · est. exit fees{" "}
            {fmtMoney(
              data.estimated_open_exit_fees,
            )}
          </p>

        </div>


        {/* MARKET VALUE */}

        <div className="rounded-md border border-border/70 bg-background/30 p-3">

          <div className="flex items-center justify-between gap-2">

            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Open Market Value
            </span>

            <Briefcase className="h-3.5 w-3.5 text-accent" />

          </div>

          <p className="mt-1 font-mono text-lg font-semibold text-foreground">

            {!hasOpen ||
            !marksComplete
              ? "—"
              : moneyCompact.format(
                  data.open_market_value,
                )}

          </p>

          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {data.open_count} positions · marked{" "}
            {data.marked_open_count}/
            {data.open_count}
          </p>

        </div>

      </div>


      {/* ================================================== */}
      {/* SECONDARY METRICS */}
      {/* ================================================== */}

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">


        {/* 24H */}

        <div className="rounded-md border border-border/70 bg-background/30 p-2.5">

          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            24h Net Realized
          </span>

          <p
            className={`mt-0.5 font-mono text-base font-semibold ${
              data.last_24h_closed === 0
                ? "text-muted-foreground"
                : last24Positive
                  ? "text-bull"
                  : "text-bear"
            }`}
          >
            {data.last_24h_closed === 0
              ? "—"
              : fmtSigned(
                  data.last_24h_realized_net_pnl,
                )}
          </p>

          <p className="mt-0.5 text-[9px] text-muted-foreground">
            {data.last_24h_closed} closed
          </p>

        </div>


        {/* WIN RATE */}

        <div className="rounded-md border border-border/70 bg-background/30 p-2.5">

          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">

            <Target className="h-3 w-3" />

            Win Rate

          </span>

          <p className="mt-0.5 font-mono text-base font-semibold">

            {data.win_rate_pct == null
              ? "—"
              : `${data.win_rate_pct.toFixed(
                  1,
                )}%`}

          </p>

          <p className="mt-0.5 text-[9px] text-muted-foreground">
            {data.win_count} wins ·{" "}
            {data.loss_count} losses
          </p>

        </div>


        {/* PROFIT FACTOR */}

        <div className="rounded-md border border-border/70 bg-background/30 p-2.5">

          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Profit Factor
          </span>

          <p
            className={`mt-0.5 font-mono text-base font-semibold ${
              pf == null
                ? "text-muted-foreground"
                : pf >= 1.5
                  ? "text-bull"
                  : pf >= 1
                    ? "text-foreground"
                    : "text-bear"
            }`}
          >
            {pf == null
              ? "—"
              : pf.toFixed(2)}
          </p>

          <p className="mt-0.5 text-[9px] text-muted-foreground">
            {pf == null
              ? "no resolved trades"
              : "net PnL basis"}
          </p>

        </div>


        {/* AVG */}

        <div className="rounded-md border border-border/70 bg-background/30 p-2.5">

          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Avg Win / Loss
          </span>

          <p className="mt-0.5 font-mono text-base font-semibold">

            <span className="text-bull">
              {data.avg_win_usd > 0
                ? fmtSigned(
                    data.avg_win_usd,
                  )
                : "—"}
            </span>

            <span className="mx-1 text-muted-foreground">
              /
            </span>

            <span className="text-bear">
              {data.avg_loss_usd == null
                ? "—"
                : fmtSigned(
                    data.avg_loss_usd,
                  )}
            </span>

          </p>

          <p className="mt-0.5 text-[9px] text-muted-foreground">
            net per closed trade
          </p>
          <p className="mt-0.5 text-[9px] text-muted-foreground">
            Best <span className="text-bull">{fmtSigned(data.best_trade_net_pnl)}</span>
            {" · "}Worst <span className="text-bear">{fmtSigned(data.worst_trade_net_pnl)}</span>
          </p>

        </div>

      </div>


      {/* ================================================== */}
      {/* DETAIL */}
      {/* ================================================== */}

      <div className="mt-3 rounded-md border border-border/70 bg-background/30 p-3">

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">


          {/* CLOSED */}

          <div>

            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Closed Performance
            </div>

            <div className="text-[11px] text-muted-foreground">

              Closed{" "}
              <span className="font-mono text-foreground">
                {data.closed_count}
              </span>

              {" · "}

              Wins{" "}
              <span className="font-mono text-bull">
                {data.win_count}
              </span>

              {" · "}

              Losses{" "}
              <span className="font-mono text-bear">
                {data.loss_count}
              </span>

            </div>

            <div className="mt-1 text-[11px] text-muted-foreground">

              Gross{" "}
              <span className="font-mono text-foreground">
                {fmtSigned(
                  data.realized_gross_pnl,
                )}
              </span>

              {" · "}

              Fees{" "}
              <span className="font-mono text-warn">
                {fmtMoney(
                  data.total_fees,
                )}
              </span>

              {" · "}

              Net{" "}
              <span
                className={`font-mono ${
                  realizedPositive
                    ? "text-bull"
                    : "text-bear"
                }`}
              >
                {fmtSigned(
                  data.realized_net_pnl,
                )}
              </span>

            </div>

          </div>


          {/* OPEN */}

          <div>

            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Open Exposure
            </div>

            <div className="text-[11px] text-muted-foreground">

              Entry cost{" "}
              <span className="font-mono text-foreground">
                {moneyCompact.format(
                  data.open_entry_notional,
                )}
              </span>

              {" · "}

              Market value{" "}

              <span className="font-mono text-foreground">

                {hasOpen &&
                marksComplete
                  ? moneyCompact.format(
                      data.open_market_value,
                    )
                  : "—"}

              </span>

            </div>

            <div className="mt-1 text-[11px] text-muted-foreground">

              Unrealized gross{" "}

              <span
                className={`font-mono ${
                  data.unrealized_gross_pnl >= 0
                    ? "text-bull"
                    : "text-bear"
                }`}
              >
                {hasOpen &&
                marksComplete
                  ? fmtSigned(
                      data.unrealized_gross_pnl,
                    )
                  : "—"}
              </span>

              {" · "}

              Est. exit fee{" "}

              <span className="font-mono text-warn">

                {hasOpen &&
                marksComplete
                  ? fmtMoney(
                      data.estimated_open_exit_fees,
                    )
                  : "—"}

              </span>

              {" · "}

              Net{" "}

              <span
                className={`font-mono ${
                  unrealizedPositive
                    ? "text-bull"
                    : "text-bear"
                }`}
              >
                {hasOpen &&
                marksComplete
                  ? fmtSigned(
                      data.unrealized_net_pnl_est,
                    )
                  : "—"}
              </span>

            </div>

          </div>

        </div>

      </div>


      {/* ================================================== */}
      {/* DATA QUALITY */}
      {/* ================================================== */}

      {(
        data.unmarked_open_count > 0 ||
        data.legacy_open_sell_count > 0 ||
        data.legacy_closed_sell_count > 0
      ) && (

        <div className="mt-3 flex items-start gap-2 rounded-md border border-warn/30 bg-warn/5 p-2.5 text-[10px] text-muted-foreground">

          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />

          <div>

            {data.unmarked_open_count > 0 && (
              <div>
                Mark unavailable for{" "}
                {data.unmarked_open_count}{" "}
                open position(s); unrealized
                values are withheld.
              </div>
            )}

            {(
              data.legacy_open_sell_count > 0 ||
              data.legacy_closed_sell_count > 0
            ) && (

              <div>
                Legacy SELL rows excluded from
                Spot accounting:{" "}
                {data.legacy_open_sell_count}
                {" "}open ·{" "}
                {data.legacy_closed_sell_count}
                {" "}closed.
              </div>

            )}

          </div>

        </div>

      )}


      {/* ================================================== */}
      {/* FOOTER */}
      {/* ================================================== */}

      <p className="mt-3 border-t border-border/70 pt-2 text-[10px] text-muted-foreground">

        Realized = all closed Spot BUY trades ·
        Unrealized = mark-to-market open BUY
        positions · refreshes every 30s

      </p>

    </section>
  );
}

export default PortfolioPanel;

"use client";

import { useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { Shield, ShieldAlert, ShieldOff } from "lucide-react";
import {
  RISK_CONFIG,
  getPaperEquity,
  getOpenPortfolioRisk,
  getDailyRealizedPnL,
  getOpenUnrealizedPnL,
} from "@/lib/risk.engine";

export interface RiskStatus {
  equity: number;
  maxTradeRisk: number;
  portfolioRisk: number;
  maxPortfolioRisk: number;
  dailyPnL: number;
  dailyLossLimit: number;
  openPositions: number;
  maxPositions: number;
  dailyLocked: boolean;
  portfolioFull: boolean;
  dataStatus: "live" | "partial" | "fallback";
  dataError?: string;
}

const DEFAULT_RISK_STATUS: RiskStatus = {
  equity: 20000,
  maxTradeRisk: 30,
  portfolioRisk: 0,
  maxPortfolioRisk: 240,
  dailyPnL: 0,
  dailyLossLimit: -240,
  openPositions: 0,
  maxPositions: RISK_CONFIG.MAX_OPEN_POSITIONS,
  dailyLocked: false,
  portfolioFull: false,
  dataStatus: "fallback",
  dataError: "Live risk metrics have not been verified yet.",
};

const getRiskStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<RiskStatus> => {
    try {
      const { supabaseAdmin: db } = await import(
        "@/integrations/supabase/client.server"
      );
      const { data: openTrades, error: openErr } = await (db.from as any)(
        "trades",
      )
        .select("symbol, side, entry_price, stop_loss, quantity")
        .eq("mode", "paper")
        .eq("status", "open")
        .eq("side", "buy");

      if (openErr) throw new Error(openErr.message);

      const openPositions = openTrades?.length ?? 0;
      const prices = new Map<string, number>();
      let priceCoverageError: string | undefined;

      if (openPositions > 0) {
        const symbols = [
          ...new Set(
            (openTrades ?? []).map(
              (trade: { symbol: string }) =>
                `${trade.symbol === "MATIC" ? "POL" : trade.symbol === "RNDR" ? "RENDER" : trade.symbol}USDT`,
            ),
          ),
        ];
        try {
          const response = await fetch(
            "https://api.binance.com/api/v3/ticker/price",
            { signal: AbortSignal.timeout(5_000), cache: "no-store" },
          );
          if (response.ok) {
            const rows = (await response.json()) as {
              symbol: string;
              price: string;
            }[];
            for (const row of rows) {
              const price = Number(row.price);
              if (Number.isFinite(price) && symbols.includes(row.symbol)) {
                prices.set(row.symbol, price);
              }
            }
          }
        } catch {
          // The panel remains available, but missing prices make unrealized PnL partial.
        }
        const missingSymbols = symbols.filter((symbol) => !prices.has(symbol));
        if (missingSymbols.length > 0) {
          priceCoverageError = `Live prices unavailable for ${missingSymbols.length}/${symbols.length} open-position symbols; unrealized PnL is partial.`;
        }
      }

      const [equity, portfolioRisk, dailyRealized] = await Promise.all([
        getPaperEquity(db as any),
        getOpenPortfolioRisk(db as any),
        getDailyRealizedPnL(db as any),
      ]);
      const unrealized =
        openPositions > 0 ? await getOpenUnrealizedPnL(db as any, prices) : 0;
      const dailyPnL = dailyRealized + unrealized;
      const maxTradeRisk = equity * RISK_CONFIG.MAX_RISK_PER_TRADE_PCT;
      const maxPortfolioRisk = equity * RISK_CONFIG.MAX_PORTFOLIO_RISK_PCT;
      const dailyLossLimit = -(equity * RISK_CONFIG.DAILY_LOSS_LIMIT_PCT);

      return {
        equity,
        maxTradeRisk,
        portfolioRisk,
        maxPortfolioRisk,
        dailyPnL,
        dailyLossLimit,
        openPositions,
        maxPositions: RISK_CONFIG.MAX_OPEN_POSITIONS,
        dailyLocked: dailyPnL <= dailyLossLimit,
        portfolioFull: portfolioRisk >= maxPortfolioRisk,
        dataStatus: priceCoverageError ? "partial" : "live",
        dataError: priceCoverageError,
      };
    } catch (err) {
      console.error(
        "[RiskPanel] Failed to fetch live risk metrics, using fallback:",
        err,
      );
      return {
        ...DEFAULT_RISK_STATUS,
        dataStatus: "fallback",
        dataError: "Live risk query failed; displayed counts and PnL are not authoritative.",
      };
    }
  },
);

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function RiskPanel() {
  const { data } = useQuery({
    queryKey: ["risk-status"],
    queryFn: () => getRiskStatus(),
    refetchInterval: 30_000,
    staleTime: 25_000,
    initialData: DEFAULT_RISK_STATUS,
  });

  const current = data ?? DEFAULT_RISK_STATUS;
  const status = current.dataStatus === "fallback"
    ? "DATA UNAVAILABLE"
    : current.dataStatus === "partial"
      ? "PARTIAL DATA"
    : current.dailyLocked
      ? "DAILY LOSS LOCK"
      : current.portfolioFull
        ? "PORTFOLIO RISK FULL"
        : "ACTIVE";
  const StatusIcon = current.dataStatus !== "live"
    ? ShieldAlert
    : current.dailyLocked
      ? ShieldOff
      : current.portfolioFull
        ? ShieldAlert
        : Shield;
  const statusColor = current.dataStatus !== "live"
    ? "text-warn"
    : current.dailyLocked
      ? "text-bear"
      : current.portfolioFull
        ? "text-warn"
        : "text-bull";
  const rows: [string, string][] = [
    ["Paper Equity", money.format(current.equity)],
    ["Risk / Trade", money.format(current.maxTradeRisk)],
    [
      "Portfolio Risk",
      `${money.format(current.portfolioRisk)} / ${money.format(current.maxPortfolioRisk)}`,
    ],
    [
      "Daily PnL",
      `${current.dailyPnL >= 0 ? "+" : ""}${money.format(current.dailyPnL)} / ${money.format(current.dailyLossLimit)}`,
    ],
    ["Open Positions", `${current.openPositions} / ${current.maxPositions}`],
  ];

  return (
    <section className="panel">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="panel-title flex items-center gap-2">
          <Shield className="h-4 w-4 text-accent" />
          Risk Management
        </h2>
        <span className={`flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider ${statusColor}`}>
          <StatusIcon className="h-3 w-3" />
          {status}
        </span>
      </div>
      <div className="divide-y divide-border/50 rounded-md border border-border/70 bg-background/30">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between px-3 py-2">
            <span className="text-[11px] text-muted-foreground">{label}</span>
            <span className={`font-mono text-[11px] font-medium ${label === "Daily PnL" && current.dailyPnL < 0 ? "text-bear" : label === "Daily PnL" && current.dailyPnL > 0 ? "text-bull" : "text-foreground"}`}>
              {value}
            </span>
          </div>
        ))}
      </div>
      {current.dataStatus !== "live" && (
        <p role="alert" className="mt-2 text-[10px] text-warn">
          {current.dataError ?? "Live risk metrics unavailable. Counts and PnL are not authoritative."}
        </p>
      )}
      <p className="mt-2 text-[10px] text-muted-foreground">
        Max risk/trade: {(RISK_CONFIG.MAX_RISK_PER_TRADE_PCT * 100).toFixed(2)}% · Portfolio cap: {(RISK_CONFIG.MAX_PORTFOLIO_RISK_PCT * 100).toFixed(1)}% · Daily limit: {(RISK_CONFIG.DAILY_LOSS_LIMIT_PCT * 100).toFixed(1)}%
      </p>
    </section>
  );
}

export default RiskPanel;

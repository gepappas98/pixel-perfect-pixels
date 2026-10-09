"use client";

import { useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { Shield, ShieldAlert } from "lucide-react";
import {
  RISK_CONFIG,
  PAPER_STARTING_EQUITY,
  getPaperEquity,
  getOpenPortfolioRisk,
  getDailyRealizedPnL,
  getOpenUnrealizedPnL,
} from "@/lib/risk.engine";

export interface RiskStatus {
  startingEquity: number;
  realizedPnL: number;
  unrealizedPnL: number;
  currentEquity: number;
  openNotional: number;
  currentMarketValue: number;
  portfolioRisk: number;
  maxPortfolioRisk: number;
  dailyPnL: number;
  dailyLossLimit: number;
  openPositions: number;
  dataStatus: "live" | "partial" | "fallback";
  dataError?: string;
}

const DEFAULT_RISK_STATUS: RiskStatus = {
  startingEquity: PAPER_STARTING_EQUITY,
  realizedPnL: 0,
  unrealizedPnL: 0,
  currentEquity: PAPER_STARTING_EQUITY,
  openNotional: 0,
  currentMarketValue: 0,
  portfolioRisk: 0,
  maxPortfolioRisk: PAPER_STARTING_EQUITY * RISK_CONFIG.MAX_PORTFOLIO_RISK_PCT,
  dailyPnL: 0,
  dailyLossLimit: -(PAPER_STARTING_EQUITY * RISK_CONFIG.DAILY_LOSS_LIMIT_PCT),
  openPositions: 0,
  dataStatus: "fallback",
  dataError: "Live wallet metrics have not been verified yet.",
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
        .select("symbol, side, entry_price, stop_loss, quantity, entry_fee")
        .eq("mode", "paper")
        .eq("status", "open")
        .eq("side", "buy");

      if (openErr) throw new Error(openErr.message);

      const trades = openTrades ?? [];
      const openPositions = trades.length;
      const prices = new Map<string, number>();
      let priceCoverageError: string | undefined;
      const symbols = [
        ...new Set(
          trades.map((trade: { symbol: string }) =>
            `${trade.symbol === "MATIC" ? "POL" : trade.symbol === "RNDR" ? "RENDER" : trade.symbol}USDT`,
          ),
        ),
      ];

      if (symbols.length > 0) {
        try {
          const response = await fetch(
            "https://api.binance.com/api/v3/ticker/price",
            { signal: AbortSignal.timeout(5_000), cache: "no-store" },
          );
          if (!response.ok) throw new Error(`Binance ticker HTTP ${response.status}`);
          const rows = (await response.json()) as {
            symbol: string;
            price: string;
          }[];
          for (const row of rows) {
            const price = Number(row.price);
            if (Number.isFinite(price) && price > 0 && symbols.includes(row.symbol)) {
              prices.set(row.symbol, price);
            }
          }
        } catch (err) {
          priceCoverageError = err instanceof Error ? err.message : String(err);
        }
        const missingSymbols = symbols.filter((symbol) => !prices.has(symbol));
        if (missingSymbols.length > 0) {
          priceCoverageError = `Live prices unavailable for ${missingSymbols.length}/${symbols.length} open-position symbols; MTM/equity is partial.`;
        }
      }

      const [realizedBaseEquity, portfolioRisk, dailyRealized] = await Promise.all([
        getPaperEquity(db as any),
        getOpenPortfolioRisk(db as any),
        getDailyRealizedPnL(db as any),
      ]);
      const unrealizedPnL =
        openPositions > 0 ? await getOpenUnrealizedPnL(db as any, prices) : 0;
      const realizedPnL = realizedBaseEquity - PAPER_STARTING_EQUITY;
      const currentEquity = PAPER_STARTING_EQUITY + realizedPnL + unrealizedPnL;
      const openNotional = trades.reduce(
        (sum: number, trade: { entry_price: number; quantity: number }) =>
          sum + Number(trade.entry_price || 0) * Number(trade.quantity || 0),
        0,
      );
      const currentMarketValue = trades.reduce(
        (sum: number, trade: { symbol: string; quantity: number }) => {
          const normalized = `${trade.symbol === "MATIC" ? "POL" : trade.symbol === "RNDR" ? "RENDER" : trade.symbol}USDT`;
          const price = prices.get(normalized);
          return sum + (price == null ? 0 : price * Number(trade.quantity || 0));
        },
        0,
      );
      const dailyPnL = dailyRealized + unrealizedPnL;
      const maxPortfolioRisk = currentEquity * RISK_CONFIG.MAX_PORTFOLIO_RISK_PCT;
      const dailyLossLimit = -(currentEquity * RISK_CONFIG.DAILY_LOSS_LIMIT_PCT);

      return {
        startingEquity: PAPER_STARTING_EQUITY,
        realizedPnL,
        unrealizedPnL,
        currentEquity,
        openNotional,
        currentMarketValue,
        portfolioRisk,
        maxPortfolioRisk,
        dailyPnL,
        dailyLossLimit,
        openPositions,
        dataStatus: priceCoverageError ? "partial" : "live",
        dataError: priceCoverageError,
      };
    } catch (err) {
      console.error("[RiskPanel] Failed to fetch live wallet metrics:", err);
      return {
        ...DEFAULT_RISK_STATUS,
        dataStatus: "fallback",
        dataError: "Live wallet query failed; displayed counts and PnL are not authoritative.",
      };
    }
  },
);

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
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
      ? "PARTIAL MTM"
      : "LIVE MTM";
  const StatusIcon = current.dataStatus === "live" ? Shield : ShieldAlert;
  const statusColor = current.dataStatus === "live" ? "text-bull" : "text-warn";
  const rows: [string, string][] = [
    ["Starting Equity (reference)", money.format(current.startingEquity)],
    ["Realized PnL (all time)", `${current.realizedPnL >= 0 ? "+" : ""}${money.format(current.realizedPnL)}`],
    ["Unrealized PnL (net MTM)", `${current.unrealizedPnL >= 0 ? "+" : ""}${money.format(current.unrealizedPnL)}`],
    ["Current Equity (MTM)", money.format(current.currentEquity)],
    ["Open Notional (entry)", money.format(current.openNotional)],
    ["Current Market Value", money.format(current.currentMarketValue)],
    ["Open BUY Positions", String(current.openPositions)],
    ["Open Stop-Risk (reference)", money.format(current.portfolioRisk)],
  ];

  return (
    <section className="panel">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="panel-title flex items-center gap-2">
            <Shield className="h-4 w-4 text-accent" />
            Paper Wallet · Research Mode
          </h2>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Unbounded research book · $20k is reference equity, not a cash/position cap
          </p>
        </div>
        <span className={`flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider ${statusColor}`}>
          <StatusIcon className="h-3 w-3" />
          {status}
        </span>
      </div>
      <div className="divide-y divide-border/50 rounded-md border border-border/70 bg-background/30">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between px-3 py-2">
            <span className="text-[11px] text-muted-foreground">{label}</span>
            <span className={`font-mono text-[11px] font-medium ${label.includes("PnL") && value.startsWith("-") ? "text-bear" : label.includes("PnL") && value.startsWith("+") ? "text-bull" : "text-foreground"}`}>
              {value}
            </span>
          </div>
        ))}
      </div>
      {current.dataStatus !== "live" && (
        <p role="alert" className="mt-2 text-[10px] text-warn">
          {current.dataError ?? "Live market prices unavailable. MTM and current equity are partial/not authoritative."}
        </p>
      )}
      <p className="mt-2 text-[10px] text-muted-foreground">
        Current Equity = starting equity + all-time realized PnL + net unrealized MTM. Open notional is entry exposure, not available cash. Market value and MTM use live Binance tickers; prices are snapshots, not intrabar exit fills.
      </p>
    </section>
  );
}

export default RiskPanel;

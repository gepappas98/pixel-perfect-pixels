"use client";

import { useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { Shield, ShieldAlert, ShieldOff } from "lucide-react";
import { RISK_CONFIG, PAPER_STARTING_EQUITY, getPaperEquity, getOpenPortfolioRisk, getDailyRealizedPnL } from "@/lib/risk.engine";

const getRiskStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin;
  try {
    const [equity, portfolioRisk, dailyPnL] = await Promise.all([
      getPaperEquity(db as any),
      getOpenPortfolioRisk(db as any),
      getDailyRealizedPnL(db as any),
    ]);
    const { count } = await (db.from as any)("trades")
      .select("id", { count: "exact", head: true })
      .eq("mode", "paper")
      .eq("status", "open");

    const maxTradeRisk     = equity * RISK_CONFIG.MAX_RISK_PER_TRADE_PCT;
    const maxPortfolioRisk = equity * RISK_CONFIG.MAX_PORTFOLIO_RISK_PCT;
    const dailyLossLimit   = -(equity * RISK_CONFIG.DAILY_LOSS_LIMIT_PCT);
    const openPositions    = count ?? 0;

    return {
      equity,
      maxTradeRisk,
      portfolioRisk,
      maxPortfolioRisk,
      dailyPnL,
      dailyLossLimit,
      openPositions,
      maxPositions: RISK_CONFIG.MAX_OPEN_POSITIONS,
      dailyLocked:  dailyPnL <= dailyLossLimit,
      portfolioFull: portfolioRisk >= maxPortfolioRisk,
    };
  } catch {
    return null;
  }
});

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function RiskPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ["risk-status"],
    queryFn: () => getRiskStatus(),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  if (isLoading || !data) {
    return (
      <section className="panel">
        <h2 className="panel-title flex items-center gap-2">
          <Shield className="h-4 w-4 text-accent" />
          Risk Management
        </h2>
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      </section>
    );
  }

  const status = data.dailyLocked
    ? "DAILY LOSS LOCK"
    : data.portfolioFull
      ? "PORTFOLIO RISK FULL"
      : "ACTIVE";

  const StatusIcon = data.dailyLocked
    ? ShieldOff
    : data.portfolioFull
      ? ShieldAlert
      : Shield;

  const statusColor = data.dailyLocked
    ? "text-bear"
    : data.portfolioFull
      ? "text-warn"
      : "text-bull";

  const rows: [string, string][] = [
    ["Paper Equity",      money.format(data.equity)],
    ["Risk / Trade",      money.format(data.maxTradeRisk)],
    [`Portfolio Risk`,    `${money.format(data.portfolioRisk)} / ${money.format(data.maxPortfolioRisk)}`],
    [`Daily PnL`,         `${data.dailyPnL >= 0 ? "+" : ""}${money.format(data.dailyPnL)} / ${money.format(data.dailyLossLimit)}`],
    ["Open Positions",    `${data.openPositions} / ${data.maxPositions}`],
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
            <span className={`font-mono text-[11px] font-medium ${
              label === "Daily PnL" && data.dailyPnL < 0 ? "text-bear" :
              label === "Daily PnL" && data.dailyPnL > 0 ? "text-bull" :
              "text-foreground"
            }`}>{value}</span>
          </div>
        ))}
      </div>

      <p className="mt-2 text-[10px] text-muted-foreground">
        Max risk/trade: {(RISK_CONFIG.MAX_RISK_PER_TRADE_PCT * 100).toFixed(1)}% ·
        Portfolio cap: {(RISK_CONFIG.MAX_PORTFOLIO_RISK_PCT * 100).toFixed(1)}% ·
        Daily limit: {(RISK_CONFIG.DAILY_LOSS_LIMIT_PCT * 100).toFixed(1)}%
      </p>
    </section>
  );
}

export default RiskPanel;

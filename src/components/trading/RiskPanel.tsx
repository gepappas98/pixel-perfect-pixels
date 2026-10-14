"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Shield, ShieldAlert } from "lucide-react";
import { RISK_CONFIG, PAPER_STARTING_EQUITY } from "@/lib/risk.engine";

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

type PaperTrade = {
  id: string;
  symbol: string;
  side: string;
  status: string;
  mode: string;
  entry_price: number | string | null;
  stop_loss: number | string | null;
  quantity: number | string | null;
  entry_fee: number | string | null;
  pnl: number | string | null;
  net_pnl: number | string | null;
  closed_at: string | null;
};

const PAGE_SIZE = 1000;

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function realizedPnlValue(trade: PaperTrade): number {
  const legacyPnl = numeric(trade.pnl);
  const netPnl = trade.net_pnl == null ? null : Number(trade.net_pnl);
  // Preserve the risk engine's legacy-row recovery behavior.
  if (netPnl == null || (netPnl === 0 && legacyPnl !== 0)) return legacyPnl;
  return Number.isFinite(netPnl) ? netPnl : 0;
}

function athensStartOfDay(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const offsetText = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Athens",
    timeZoneName: "longOffset",
  }).formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT+02:00";
  const match = offsetText.match(/GMT([+-])(\d{2}):(\d{2})?/);
  const sign = match?.[1] === "-" ? -1 : 1;
  const offsetMs = sign * (Number(match?.[2] ?? 2) * 60 + Number(match?.[3] ?? 0)) * 60_000;
  return new Date(Date.UTC(y, m - 1, d) - offsetMs).toISOString();
}

function binanceSymbol(symbol: string): string {
  const normalized = symbol.toUpperCase();
  if (normalized === "MATIC") return "POLUSDT";
  if (normalized === "RNDR") return "RENDERUSDT";
  return normalized.endsWith("USDT") ? normalized : `${normalized}USDT`;
}

async function fetchCurrentPrices(symbols: string[]): Promise<{ prices: Map<string, number>; missing: string[] }> {
  const unique = [...new Set(symbols.filter(Boolean))];
  const results = await Promise.all(unique.map(async (symbol) => {
    try {
      const response = await fetch(
        `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(binanceSymbol(symbol))}`,
        { signal: AbortSignal.timeout(5_000), cache: "no-store" },
      );
      if (!response.ok) return [symbol, null] as const;
      const payload = (await response.json()) as { price?: string | number };
      const price = Number(payload.price);
      return [symbol, Number.isFinite(price) && price > 0 ? price : null] as const;
    } catch {
      return [symbol, null] as const;
    }
  }));
  const prices = new Map<string, number>();
  const missing: string[] = [];
  for (const [symbol, price] of results) {
    if (price == null) missing.push(symbol);
    else prices.set(binanceSymbol(symbol), price);
  }
  return { prices, missing };
}

/** Read the paper book from the same browser Supabase client as TradesPanel. */
async function loadRiskStatus(): Promise<RiskStatus> {
  const rows: PaperTrade[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("trades")
      .select("id,symbol,side,status,mode,entry_price,stop_loss,quantity,entry_fee,pnl,net_pnl,closed_at")
      .eq("mode", "paper")
      .in("status", ["open", "closed"])
      .eq("side", "buy")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Paper Wallet trades query failed: ${error.message}`);
    const page = (data ?? []) as unknown as PaperTrade[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const openTrades = rows.filter((trade) => trade.status === "open");
  const closedTrades = rows.filter((trade) => trade.status === "closed");
  const realizedPnL = closedTrades.reduce((sum, trade) => sum + realizedPnlValue(trade), 0);
  const dayStart = athensStartOfDay();
  const dailyRealized = closedTrades
    .filter((trade) => trade.closed_at != null && trade.closed_at >= dayStart)
    .reduce((sum, trade) => sum + realizedPnlValue(trade), 0);

  const symbols = [...new Set(openTrades.map((trade) => String(trade.symbol ?? "").toUpperCase()).filter(Boolean))];
  const { prices, missing } = await fetchCurrentPrices(symbols);

  let unrealizedPnL = 0;
  let currentMarketValue = 0;
  let openNotional = 0;
  let portfolioRisk = 0;
  for (const trade of openTrades) {
    const entry = numeric(trade.entry_price);
    const quantity = numeric(trade.quantity);
    const stop = trade.stop_loss == null ? null : Number(trade.stop_loss);
    if (entry > 0 && quantity > 0) openNotional += entry * quantity;

    if (stop != null && Number.isFinite(stop) && entry > 0 && quantity > 0) {
      portfolioRisk += Math.abs(entry - stop) * quantity + (entry + stop) * quantity * RISK_CONFIG.FEE_RATE;
    }

    const current = prices.get(binanceSymbol(trade.symbol));
    if (current == null || entry <= 0 || quantity <= 0) continue;
    const gross = (current - entry) * quantity;
    const entryFee = trade.entry_fee == null ? entry * quantity * RISK_CONFIG.FEE_RATE : numeric(trade.entry_fee);
    const exitFee = current * quantity * RISK_CONFIG.FEE_RATE;
    unrealizedPnL += gross - entryFee - exitFee;
    currentMarketValue += current * quantity;
  }

  const currentEquity = PAPER_STARTING_EQUITY + realizedPnL + unrealizedPnL;
  const hasPartialMarks = missing.length > 0;
  return {
    startingEquity: PAPER_STARTING_EQUITY,
    realizedPnL,
    unrealizedPnL,
    currentEquity,
    openNotional,
    currentMarketValue,
    portfolioRisk,
    maxPortfolioRisk: currentEquity * RISK_CONFIG.MAX_PORTFOLIO_RISK_PCT,
    dailyPnL: dailyRealized + unrealizedPnL,
    dailyLossLimit: -(currentEquity * RISK_CONFIG.DAILY_LOSS_LIMIT_PCT),
    openPositions: openTrades.length,
    dataStatus: hasPartialMarks ? "partial" : "live",
    ...(hasPartialMarks ? { dataError: `Live prices unavailable for ${missing.length}/${symbols.length} open-position symbols; MTM/equity is partial.` } : {}),
  };
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export function RiskPanel() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ["risk-status"],
    queryFn: loadRiskStatus,
    refetchInterval: 30_000,
    staleTime: 25_000,
    initialData: DEFAULT_RISK_STATUS,
  });

  useEffect(() => {
    const channel = supabase
      .channel("risk-wallet-trades-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, () => {
        void queryClient.invalidateQueries({ queryKey: ["risk-status"] });
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const current = error
    ? { ...DEFAULT_RISK_STATUS, dataError: `Live wallet query failed: ${error instanceof Error ? error.message : String(error)}` }
    : (data ?? DEFAULT_RISK_STATUS);
  const status = error || current.dataStatus === "fallback"
    ? "DATA UNAVAILABLE"
    : current.dataStatus === "partial"
      ? "PARTIAL MTM"
      : "LIVE MTM";
  const StatusIcon = !error && current.dataStatus === "live" ? Shield : ShieldAlert;
  const statusColor = !error && current.dataStatus === "live" ? "text-bull" : "text-warn";
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
      {(error || current.dataStatus !== "live") && (
        <p role="alert" className="mt-2 text-[10px] text-warn">
          {current.dataError ?? "Live market prices unavailable. MTM and current equity are partial/not authoritative."}
        </p>
      )}
      <p className="mt-2 text-[10px] text-muted-foreground">
        Reads paper BUY trades directly through the browser Supabase client; trade-table changes invalidate the wallet immediately, with a 30s refresh as fallback. Current Equity = reference equity + all-time realized PnL + net unrealized MTM. Open notional is entry exposure, not available cash. Market value and MTM use live Binance ticker snapshots, not intrabar exit fills.
      </p>
    </section>
  );
}

export default RiskPanel;

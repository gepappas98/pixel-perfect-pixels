import { useQuery } from "@tanstack/react-query";
import { useLiveTable } from "@/hooks/useLiveTable";
import type { Trade } from "@/lib/trading-types";

const BINANCE_SYMBOL_MAP: Record<string, string> = {
  MATIC: "POL",
  RNDR: "RENDER",
};

async function getPrices(symbols: string[]) {
  const prices = await Promise.all(
    symbols.map(async (symbol) => {
      const normalizedSymbol = symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      const binanceSymbol = BINANCE_SYMBOL_MAP[normalizedSymbol] ?? normalizedSymbol;
      const response = await fetch(
        `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(binanceSymbol)}USDT`,
      );
      if (!response.ok) return [symbol, null] as const;
      const data = (await response.json()) as { price?: string };
      const price = Number(data.price);
      return [symbol, Number.isFinite(price) ? price : null] as const;
    }),
  );
  return Object.fromEntries(prices) as Record<string, number | null>;
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export function TradesPanel() {
  const { rows, loading } = useLiveTable<Trade>("trades", 15);
  const prices = useQuery({
    queryKey: ["position-prices", rows.map((row) => row.symbol).sort().join(",")],
    queryFn: () => getPrices([...new Set(rows.map((row) => row.symbol))]),
    enabled: rows.length > 0,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  return (
    <section className="panel">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="panel-title">Positions</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Live PnL · refreshes every 30s
          </p>
        </div>
        {prices.dataUpdatedAt > 0 && (
          <span className="text-[10px] text-muted-foreground">
            Updated {new Date(prices.dataUpdatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="pb-1 font-normal">Symbol</th>
              <th className="pb-1 font-normal">Side</th>
              <th className="pb-1 font-normal">Entry</th>
              <th className="pb-1 font-normal">Current</th>
              <th className="pb-1 font-normal">Value</th>
              <th className="pb-1 font-normal">PnL</th>
              <th className="pb-1 font-normal">PnL %</th>
              <th className="pb-1 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const current = prices.data?.[t.symbol] ?? null;
              const entry = Number(t.entry_price);
              const quantity = Number(t.quantity);
              const pnl =
                current == null ? null : (t.side === "buy" ? current - entry : entry - current) * quantity;
              const pnlPct =
                pnl == null || entry <= 0 || quantity <= 0 ? null : (pnl / (entry * quantity)) * 100;
              const positive = (pnl ?? 0) >= 0;

              return (
                <tr key={t.id} className="border-t border-border font-mono text-xs">
                  <td className="py-1.5 font-semibold">{t.symbol}</td>
                  <td className={`py-1.5 ${t.side === "buy" ? "text-bull" : "text-bear"}`}>{t.side}</td>
                  <td className="py-1.5 text-muted-foreground">{entry.toFixed(2)}</td>
                  <td className="py-1.5">{current == null ? "—" : current.toFixed(2)}</td>
                  <td className="py-1.5 text-muted-foreground">{money.format(quantity * entry)}</td>
                  <td
                    className={`py-1.5 font-semibold ${pnl == null ? "text-muted-foreground" : positive ? "text-bull" : "text-bear"}`}
                  >
                    {pnl == null ? "—" : `${pnl >= 0 ? "+" : "-"}${money.format(Math.abs(pnl))}`}
                  </td>
                  <td
                    className={`py-1.5 ${pnlPct == null ? "text-muted-foreground" : positive ? "text-bull" : "text-bear"}`}
                  >
                    {pnlPct == null ? "—" : `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`}
                  </td>
                  <td className="py-1.5 text-muted-foreground">{t.status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No positions opened yet.</p>
      )}
    </section>
  );
}

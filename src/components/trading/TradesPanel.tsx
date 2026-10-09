"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatPrice } from "@/lib/format-price";
import { computeFeeAwarePnl } from "@/lib/fees";
import type { Trade } from "@/lib/trading-types";

const BINANCE_SYMBOL_MAP: Record<string, string> = {
  MATIC: "POL",
  RNDR: "RENDER",
};

async function getPrices(symbols: string[]) {
  // Price lookup is best-effort per symbol: one Binance/network failure must
  // not erase valid prices for every other open position.
  const prices = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const normalizedSymbol = symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
        const mappedSymbol = BINANCE_SYMBOL_MAP[normalizedSymbol] ?? normalizedSymbol;
        const pair = mappedSymbol.endsWith("USDT") ? mappedSymbol : `${mappedSymbol}USDT`;
        const response = await fetch(
          `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`,
          { signal: AbortSignal.timeout(5_000), cache: "no-store" },
        );
        if (!response.ok) return [symbol, null] as const;
        const data = (await response.json()) as { price?: string };
        const price = Number(data.price);
        return [symbol, Number.isFinite(price) && price > 0 ? price : null] as const;
      } catch {
        return [symbol, null] as const;
      }
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
  const [openTrades, setOpenTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [legacySellCount, setLegacySellCount] = useState(0);

  // ── Fetch ΜΟΝΟ ανοιχτές θέσεις, χωρίς artificial limit ─────────
  // Αντί για useLiveTable("trades", 15) που φέρνει 15 τυχαίες, κάνουμε
  // απευθείας query με .eq("status", "open"). Έτσι φέρνουμε ΟΛΕΣ τις
  // ανοιχτές θέσεις ανεξάρτητα από το πόσες κλειστές υπάρχουν.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const { data, error } = await supabase
        .from("trades")
        .select("*")
        .eq("status", "open")
        .order("created_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        setLoadError(error.message);
      } else {
        // Binance Spot / long-only: only BUY rows are real exposure.
        // Legacy SELL rows are kept in the DB but never shown as shorts.
        const rows = (data ?? []) as Trade[];
        const isBuy = (t: Trade) => String(t.side ?? "").toLowerCase() === "buy";
        setOpenTrades(rows.filter(isBuy));
        setLegacySellCount(rows.filter((t) => !isBuy(t)).length);
        setLoadError(null);
      }
      setLoading(false);
    }

    load();

    // Realtime: όποια αλλαγή στο trades table → refetch.
    // Χωρίς filter, γιατί δεν μπορούμε να φιλτράρουμε με ασφάλεια
    // σε UPDATE (μια θέση μπορεί να μεταβεί open → closed).
    const channel = supabase
      .channel("trades-open-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trades" },
        () => {
          void load();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, []);

  const prices = useQuery({
    queryKey: ["position-prices", openTrades.map((row) => row.symbol).sort().join(",")],
    queryFn: () => getPrices([...new Set(openTrades.map((row) => row.symbol))]),
    enabled: openTrades.length > 0,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  return (
    <section className="panel">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="panel-title">Positions · Spot Long-only</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Open only · {openTrades.length} active · Live PnL · refreshes every 30s
          </p>
        </div>
        {prices.dataUpdatedAt > 0 && openTrades.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            Updated {new Date(prices.dataUpdatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {loadError && (
        <p className="text-sm text-destructive">Failed to load positions: {loadError}</p>
      )}

      {openTrades.length > 0 && prices.data && openTrades.some((trade) => prices.data?.[trade.symbol] == null) && (
        <p role="status" className="mb-2 text-[10px] text-warn">
          Some live prices are unavailable. PnL is shown only for symbols with a valid current price.
        </p>
      )}

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
            {openTrades.map((t) => {
              const current = prices.data?.[t.symbol] ?? null;
              const entry = Number(t.entry_price);
              const quantity = Number(t.quantity);
              // Net unrealized PnL: entry fee + ESTIMATED exit fee at current price.
              const fee =
                current == null || entry <= 0 || quantity <= 0
                  ? null
                  : computeFeeAwarePnl("buy", entry, current, quantity);
              const pnl = fee?.netPnl ?? null;
              const pnlPct = fee?.netPnlPct ?? null;
              const positive = (pnl ?? 0) >= 0;

              return (
                <tr key={t.id} className="border-t border-border font-mono text-xs">
                  <td className="py-1.5 font-semibold">{t.symbol}</td>
                  <td
                    className={`py-1.5 ${t.side === "buy" ? "text-bull" : "text-bear"}`}
                  >
                    {t.side}
                  </td>
                  <td className="py-1.5 text-muted-foreground">{formatPrice(entry)}</td>
                  <td className="py-1.5">{current == null ? "—" : formatPrice(current)}</td>
                  <td className="py-1.5 text-muted-foreground">
                    {money.format(quantity * entry)}
                  </td>
                  <td
                    className={`py-1.5 font-semibold ${
                      pnl == null ? "text-muted-foreground" : positive ? "text-bull" : "text-bear"
                    }`}
                  >
                    {pnl == null
                      ? "—"
                      : `${pnl >= 0 ? "+" : "-"}${money.format(Math.abs(pnl))}`}
                  </td>
                  <td
                    className={`py-1.5 ${
                      pnlPct == null ? "text-muted-foreground" : positive ? "text-bull" : "text-bear"
                    }`}
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

      {!loading && !loadError && openTrades.length === 0 && (
        <p className="text-sm text-muted-foreground">No open positions right now.</p>
      )}

      {legacySellCount > 0 && (
        <p className="mt-2 text-[10px] text-warn">
          {legacySellCount} legacy SELL row(s) hidden — not Spot exposure, excluded from accounting.
        </p>
      )}
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatPrice } from "@/lib/format-price";
import { computeFeeAwarePnl } from "@/lib/fees";
import type { Trade } from "@/lib/trading-types";
import { PositionWatchdogPanel } from "@/components/trading/PositionWatchdogPanel";

const BINANCE_SYMBOL_MAP: Record<string, string> = {
  MATIC: "POL",
  RNDR: "RENDER",
};

type PriceMark = { price: number; source: "live" | "cached" };
async function getPrices(symbols: string[]): Promise<Record<string, PriceMark | null>> {
  const results = await Promise.all(symbols.map(async (symbol) => {
    const normalized = symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const mapped = BINANCE_SYMBOL_MAP[normalized] ?? normalized;
    const pair = mapped.endsWith("USDT") ? mapped : `${mapped}USDT`;
    for (const host of ["https://api.binance.com", "https://data-api.binance.vision", "https://api1.binance.com", "https://api3.binance.com"]) {
      try {
        const response = await fetch(`${host}/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`, { signal: AbortSignal.timeout(3500), cache: "no-store" });
        if (!response.ok) continue;
        const payload = await response.json() as { price?: string | number };
        const price = Number(payload.price);
        if (Number.isFinite(price) && price > 0) return [symbol, { price, source: "live" as const }] as const;
      } catch { /* try next Binance host */ }
    }
    try {
      const response = await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(pair)}`, { signal: AbortSignal.timeout(3500), cache: "no-store" });
      if (response.ok) {
        const payload = await response.json() as { retCode?: number; result?: { list?: Array<{ symbol?: string; lastPrice?: string }> } };
        const price = Number(payload.result?.list?.find((row) => row.symbol === pair)?.lastPrice);
        if (payload.retCode === 0 && Number.isFinite(price) && price > 0) return [symbol, { price, source: "live" as const }] as const;
      }
    } catch { /* cached mark fallback below */ }
    return [symbol, null] as const;
  }));
  const marks: Record<string, PriceMark | null> = Object.fromEntries(results);
  const missing = symbols.filter((symbol) => marks[symbol] == null);
  if (missing.length) {
    const dbSymbols = [...new Set(missing.flatMap((symbol) => {
      const normalized = symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      return [normalized, BINANCE_SYMBOL_MAP[normalized] ?? normalized];
    }))];
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data, error } = await supabase.from("indicator_snapshots").select("symbol,timeframe,price,created_at")
      .in("symbol", dbSymbols).in("timeframe", ["5m", "1h"]).gte("created_at", cutoff)
      .order("created_at", { ascending: false }).limit(500);
    if (!error) {
      for (const row of data ?? []) {
        const raw = String(row.symbol ?? "").toUpperCase();
        const price = Number(row.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        const matching = missing.find((symbol) => {
          const normalized = symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
          return raw === normalized || raw === (BINANCE_SYMBOL_MAP[normalized] ?? normalized);
        });
        if (matching && marks[matching] == null) marks[matching] = { price, source: "cached" };
      }
    }
  }
  return marks;
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
      <PositionWatchdogPanel />
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
              <th className="pb-1 font-normal">Current / Mark</th>
              <th className="pb-1 font-normal">Entry Notional</th>
              <th className="pb-1 font-normal">PnL</th>
              <th className="pb-1 font-normal">PnL %</th>
              <th className="pb-1 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {openTrades.map((t) => {
              const mark = prices.data?.[t.symbol] ?? null;
              const current = mark?.price ?? null;
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
              const variant = String((t as Trade & { entry_metadata?: { variant?: string; variant_label?: string } }).entry_metadata?.variant ?? "");
              const isEarlyEntryVariant = ["early_entry_regime", "early_entry_b_reversal", "early_entry_c_adaptive"].includes(String(t.entry_source));
              const isCmcEntry = String(t.entry_source) === "cmc_paper" || (t.source_tags ?? []).includes("cmc");
              const isPurpleResearchEntry = (t.source_tags ?? []).includes("purple-label");
              const earlyEntryLabel = variant === "B_EARLY_REVERSAL"
                ? "B — EARLY REVERSAL"
                : variant === "C_ADAPTIVE_REVERSAL"
                  ? "C — ADAPTIVE REVERSAL"
                  : "A — CURRENT EARLY ENTRY";

              return (
                <tr key={t.id} className={`border-t border-border font-mono text-xs ${isCmcEntry || isPurpleResearchEntry ? "bg-purple-500/10 ring-1 ring-inset ring-purple-500/40" : t.entry_source === "whale_shock" ? "bg-cyan-500/10 ring-1 ring-inset ring-cyan-500/30" : isEarlyEntryVariant ? "bg-violet-500/10 ring-1 ring-inset ring-violet-500/30" : ""}`}>
                  <td className="py-1.5 font-semibold">
                    <span>{t.symbol}</span>
                    {isCmcEntry && (
                      <span className="ml-2 inline-flex rounded border border-purple-400/60 bg-purple-500/20 px-1.5 py-0.5 align-middle text-[9px] font-bold tracking-wide text-purple-300">CMC</span>
                    )}
                    {t.entry_source === "whale_shock" && (
                      <span className="ml-2 inline-flex rounded border border-cyan-400/50 bg-cyan-500/15 px-1.5 py-0.5 align-middle text-[9px] font-bold tracking-wide text-cyan-300">
                        WHALE SHOCK
                      </span>
                    )}
                    {isEarlyEntryVariant && (
                      <span className="ml-2 inline-flex rounded border border-violet-400/50 bg-violet-500/15 px-1.5 py-0.5 align-middle text-[9px] font-bold tracking-wide text-violet-300">
                        {earlyEntryLabel}
                      </span>
                    )}
                    {!isCmcEntry && !isEarlyEntryVariant && isPurpleResearchEntry && (
                      <span className="ml-2 inline-flex rounded border border-purple-400/60 bg-purple-500/20 px-1.5 py-0.5 align-middle text-[9px] font-bold tracking-wide text-purple-300">
                        PURPLE RESEARCH
                      </span>
                    )}
                  </td>
                  <td
                    className={`py-1.5 ${t.side === "buy" ? "text-bull" : "text-bear"}`}
                  >
                    {t.side}
                  </td>
                  <td className="py-1.5 text-muted-foreground">{formatPrice(entry)}</td>
                  <td className="py-1.5">{current == null ? "—" : <span>{formatPrice(current)}{mark?.source === "cached" && <span className="ml-1 rounded border border-warn/40 px-1 text-[9px] text-warn">cached mark</span>}</span>}</td>
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

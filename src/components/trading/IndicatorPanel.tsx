import { useLiveTable } from "@/hooks/useLiveTable";
import type { IndicatorSnapshot } from "@/lib/trading-types";

const tone: Record<string, string> = {
  bullish: "text-bull",
  bearish: "text-bear",
  neutral: "text-muted-foreground",
};

/** Αφαιρεί το "USDT" suffix για καθαρή εμφάνιση (BTCUSDT → BTC). */
function displaySymbol(symbol: string): string {
  return symbol.replace(/USDT$/i, "");
}

/** Σειρά εμφάνισης: bullish πρώτα, μετά neutral, μετά bearish. */
const SIGNAL_ORDER: Record<string, number> = {
  bullish: 0,
  neutral: 1,
  bearish: 2,
};

export function IndicatorPanel() {
  // Αυξημένο limit: 12 → 120. Χρειαζόμαστε αρκετά rows ώστε μετά το dedup
  // να έχουμε ευρύ φάσμα νομισμάτων (όχι μόνο BTC/ETH/SOL).
  const { rows, loading } = useLiveTable<IndicatorSnapshot>("indicator_snapshots", 120);

  // ── Dedup ανά (symbol, timeframe) ──────────────────────────────
  // Κρατάει ΜΟΝΟ το πιο πρόσφατο snapshot ανά νόμισμα.
  // Το useLiveTable κάνει order by created_at desc, οπότε το πρώτο row
  // που συναντάμε για κάθε symbol είναι και το πιο πρόσφατο.
  // Ίδιο pattern με το SignalFeed / CouncilPanel.
  const latestBySymbol = new Map<string, IndicatorSnapshot>();
  for (const row of rows) {
    const key = `${row.symbol}|${row.timeframe ?? ""}`;
    if (!latestBySymbol.has(key)) {
      latestBySymbol.set(key, row);
    }
  }

  // Ταξινόμηση: bullish → neutral → bearish, μετά αλφαβητικά.
  const indicators = [...latestBySymbol.values()].sort((a, b) => {
    const oa = SIGNAL_ORDER[String(a.signal ?? "neutral").toLowerCase()] ?? 1;
    const ob = SIGNAL_ORDER[String(b.signal ?? "neutral").toLowerCase()] ?? 1;
    if (oa !== ob) return oa - ob;
    return displaySymbol(a.symbol).localeCompare(displaySymbol(b.symbol));
  });

  return (
    <section className="panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title">Technicals (4h)</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Latest per symbol · {indicators.length} active
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] text-bull">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bull" /> live
        </span>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="pb-1 font-normal">Pair</th>
            <th className="pb-1 font-normal">RSI</th>
            <th className="pb-1 font-normal">Price</th>
            <th className="pb-1 font-normal">Read</th>
          </tr>
        </thead>
        <tbody>
          {indicators.slice(0, 12).map((i) => {
            const rsi = i.rsi != null ? Number(i.rsi) : null;
            const price = i.price != null ? Number(i.price) : null;
            const sig = String(i.signal ?? "neutral").toLowerCase();

            return (
              <tr key={i.id} className="border-t border-border">
                <td className="py-1 font-mono text-xs">{displaySymbol(i.symbol)}</td>
                <td className="py-1 font-mono text-xs text-muted-foreground">
                  {rsi != null ? rsi.toFixed(1) : "—"}
                </td>
                <td className="py-1 font-mono text-xs text-muted-foreground">
                  {price != null ? price.toFixed(2) : "—"}
                </td>
                <td className={`py-1 text-xs ${tone[sig] ?? tone["neutral"]}`}>
                  {i.signal ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {!loading && indicators.length === 0 && (
        <p className="text-sm text-muted-foreground">No indicator snapshots yet.</p>
      )}
    </section>
  );
}

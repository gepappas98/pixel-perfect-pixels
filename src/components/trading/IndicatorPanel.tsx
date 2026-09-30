import { useLiveTable } from "@/hooks/useLiveTable";
import type { IndicatorSnapshot } from "@/lib/trading-types";

const tone: Record<string, string> = {
  bullish: "text-bull",
  bearish: "text-bear",
  neutral: "text-muted-foreground",
};

/** Strip "USDT" suffix for clean display (BTCUSDT → BTC). */
function displaySymbol(symbol: string): string {
  return symbol.replace(/USDT$/i, "");
}

/** Display order: bullish first, then neutral, then bearish. */
const SIGNAL_ORDER: Record<string, number> = {
  bullish: 0,
  neutral: 1,
  bearish: 2,
};

export function IndicatorPanel() {
  // Fetch plenty of rows — with 3 timeframes (4h/1h/1d) there are ~285 rows
  // per cycle for 95 coins. 500 covers current scale with room to spare.
  const { rows, loading } = useLiveTable<IndicatorSnapshot>("indicator_snapshots", 500);

  // ── Filter to the primary (4h) timeframe only ─────────────────
  // Multi-timeframe analysis writes 3 rows per coin (4h + 1h + 1d).
  // This panel shows only the 4h row for a clean one-row-per-coin view.
  const primaryRows = rows.filter((r) => r.timeframe === "4h");

  // ── Dedup per symbol ─────────────────────────────────────────
  // Keeps ONLY the most recent 4h snapshot per symbol.
  // useLiveTable orders by created_at desc, so first-seen = most recent.
  const latestBySymbol = new Map<string, IndicatorSnapshot>();
  for (const row of primaryRows) {
    if (!latestBySymbol.has(row.symbol)) {
      latestBySymbol.set(row.symbol, row);
    }
  }

  // Sort: bullish → neutral → bearish, then alphabetically.
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
            const raw = (i as IndicatorSnapshot & { raw?: unknown }).raw as
              | {
                  aroon?: { up?: number; down?: number; osc?: number };
                  bollinger?: { upper?: number; lower?: number };
                  smc?: {
                    signal?: string;
                    sweepTrap?: {
                      detected?: boolean;
                      type?: "bsl_sweep" | "ssl_sweep" | "none";
                    };
                  };
                }
              | undefined;
            const aroonOsc = Number(raw?.aroon?.osc ?? 0);
            const upper = Number(raw?.bollinger?.upper ?? NaN);
            const lower = Number(raw?.bollinger?.lower ?? NaN);
            const squeeze =
              Number.isFinite(upper) && Number.isFinite(lower) && price != null
                ? (upper - lower) / price < 0.04
                : false;
            const bandState = squeeze
              ? "Squeeze"
              : price != null && Number.isFinite(upper) && price >= upper * 0.99
                ? "Exhaustion"
                : price != null && Number.isFinite(lower) && price <= lower * 1.01
                  ? "Breakout"
                  : null;
            const technicalTag = bandState
              ? `${bandState} · ${aroonOsc >= 20 ? "A↑" : aroonOsc <= -20 ? "A↓" : "A·"}`
              : null;
            const smcSignal = raw?.smc?.signal;
            const smcTag = smcSignal === "bsl_sweep_trap"
              ? "SMC · BSL sweep trap"
              : smcSignal === "ssl_sweep_trap"
                ? "SMC · SSL sweep trap"
                : null;

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
                  <div>{i.signal ?? "—"}</div>
                  {technicalTag && (
                    <div className="text-[9px] text-muted-foreground">
                      {technicalTag}
                    </div>
                  )}
                  {smcTag && (
                    <div className={`text-[9px] ${smcSignal === "ssl_sweep_trap" ? "text-bull" : "text-bear"}`}>
                      {smcTag}
                    </div>
                  )}
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

export default IndicatorPanel;

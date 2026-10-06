import { useLiveTable } from "@/hooks/useLiveTable";
import type { PredictionSnapshot } from "@/lib/trading-types";

/** Ποσό κάτω από το οποίο το market θεωρείται αναξιόπιστο (θόρυβος). */
const MIN_VOLUME_USD = 500;

/** Όρια για "σχεδόν λυμένα" markets — δεν δίνουν πληροφορία. */
const RESOLVED_LOW = 0.05;
const RESOLVED_HIGH = 0.95;
const DIRECTIONAL_PRICE_QUESTION = /(?:\$\s?\d|\b(?:all[- ]time high|ath)\b)/i;
const DIRECTIONAL_EVENT = /\b(?:reach|hit|above|surpass|exceed|break|all[- ]time high|ath|dip|drop|fall|below|crash|down to|under|bottom)\b/i;

function isRelevantMarketQuestion(question: string | null): boolean {
  const q = String(question ?? "");
  return DIRECTIONAL_PRICE_QUESTION.test(q) && DIRECTIONAL_EVENT.test(q);
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const symbolTone: Record<string, string> = {
  BTC: "border-warn/40 bg-warn/10 text-warn",
  ETH: "border-accent/40 bg-accent/10 text-accent",
  SOL: "border-bull/40 bg-bull/10 text-bull",
};

function volumeOf(p: PredictionSnapshot): number {
  const v = Number(p.volume_24h);
  return Number.isFinite(v) ? v : 0;
}

function yesOf(p: PredictionSnapshot): number | null {
  if (p.yes_price == null) return null;
  const y = Number(p.yes_price);
  return Number.isFinite(y) ? y : null;
}

/**
 * Επιλέγει το πιο αξιόπιστο prediction market ανά νόμισμα:
 *   1. Φιλτράρει markets με ελάχιστο volume και "σχεδόν λυμένα".
 *   2. Group ανά related_symbol.
 *   3. Κρατάει το market με το μεγαλύτερο volume_24h (tiebreaker: νεότερο).
 *   4. Επιστρέφει ταξινομημένα κατά volume desc.
 */
function pickTopMarkets(rows: PredictionSnapshot[]): PredictionSnapshot[] {
  const bySymbol = new Map<string, PredictionSnapshot>();

  for (const p of rows) {
    const symbol = p.related_symbol;
    if (!symbol) continue;

    const yes = yesOf(p);
    if (yes == null) continue;
    if (yes < RESOLVED_LOW || yes > RESOLVED_HIGH) continue;
    if (volumeOf(p) < MIN_VOLUME_USD) continue;
    if (!isRelevantMarketQuestion(p.question)) continue;

    const current = bySymbol.get(symbol);
    if (!current) {
      bySymbol.set(symbol, p);
      continue;
    }

    const currentVol = volumeOf(current);
    const nextVol = volumeOf(p);
    if (nextVol > currentVol) {
      bySymbol.set(symbol, p);
      continue;
    }
    if (nextVol === currentVol) {
      // Tiebreaker: νεότερο created_at.
      const a = new Date(current.created_at ?? 0).getTime();
      const b = new Date(p.created_at ?? 0).getTime();
      if (b > a) bySymbol.set(symbol, p);
    }
  }

  return [...bySymbol.values()].sort((a, b) => volumeOf(b) - volumeOf(a));
}

export function PredictionPanel() {
  // Φέρνουμε πολλά snapshots (το Polymarket έχει δεκάδες BTC markets που
  // μονοπωλούν τα πρώτα 10-20 rows). Το dedup γίνεται client-side.
  const { rows, loading } = useLiveTable<PredictionSnapshot>("prediction_snapshots", 200);

  const markets = pickTopMarkets(rows);

  return (
    <section className="panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title">Prediction markets</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Top per symbol · ranked by 24h volume
          </p>
        </div>
        {markets.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {markets.length} active
          </span>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      <ul className="space-y-2">
        {markets.map((p) => {
          const yes = yesOf(p);
          const vol = volumeOf(p);
          const tone = symbolTone[p.related_symbol ?? ""] ?? "border-border bg-muted text-muted-foreground";

          return (
            <li
              key={p.id}
              className="rounded-md border border-border/70 bg-background/30 p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${tone}`}
                  >
                    {p.related_symbol ?? "—"}
                  </span>
                  <span className="truncate text-sm">{p.question ?? p.market_slug}</span>
                </div>
                <span className="shrink-0 font-mono text-xs text-bull">
                  {yes == null ? "—" : `${Math.round(yes * 100)}%`}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Yes probability</span>
                <span title="24h trading volume — reliability indicator">
                  {vol > 0 ? `${money.format(vol)} vol` : "low vol"}
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-bull"
                  style={{ width: `${Math.min(100, Math.max(0, (yes ?? 0) * 100))}%` }}
                />
              </div>
            </li>
          );
        })}
        {!loading && markets.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No relevant markets yet — run the pipeline to populate predictions.
          </p>
        )}
      </ul>
    </section>
  );
}

export default PredictionPanel;

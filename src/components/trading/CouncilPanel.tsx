import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useLiveTable } from "@/hooks/useLiveTable";
import type { CouncilSignal } from "@/lib/trading-types";
import { generateCouncilVerdict } from "@/lib/ai-council.functions";

const tone: Record<string, string> = {
  BUY: "text-bull",
  SELL: "text-bear",
  AVOID: "text-bear",
  HOLD: "text-muted-foreground",
};
const badge: Record<string, string> = {
  BUY: "border-bull/30 bg-bull/10",
  SELL: "border-bear/30 bg-bear/10",
  AVOID: "border-bear/30 bg-bear/10",
  HOLD: "border-border bg-muted/50",
};

function timeAgo(value?: string | null) {
  if (!value) return "—";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours > 24 ? "stale" : `${hours}h ago`;
}

function AskCouncilForm({ onSuccess }: { onSuccess: () => Promise<boolean> }) {
  const generateFn = useServerFn(generateCouncilVerdict);
  const [symbol, setSymbol] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const sym = symbol.trim().toUpperCase();
    if (!sym || loading) return;

    setLoading(true);
    setStatus(null);
    setError(null);

    try {
      const result = await generateFn({ data: { symbol: sym } });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      const refreshed = await onSuccess();
      setSymbol("");
      setStatus(
        refreshed
          ? `${result.symbol}: ${result.verdict} · ${result.conviction}% conviction`
          : `${result.symbol}: ${result.verdict} · saved, but the council list could not refresh`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mb-3">
      <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="Ask council about… (e.g. BTC)"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        />
        <button
          type="submit"
          disabled={loading || !symbol.trim()}
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Asking…" : "Ask"}
        </button>
      </form>
      {status && (
        <p className="mt-1 text-[10px] text-bull">
          ✓ {status}
        </p>
      )}
      {error && (
        <p className="mt-1 break-words text-[10px] text-destructive">
          ⚠ {error}
        </p>
      )}
    </div>
  );
}

export function CouncilPanel() {
  const { rows: syncedRows, loading: syncing, error: syncError, refresh } = useLiveTable<CouncilSignal>(
    "council_signals",
    12,
    "source_created_at",
  );

  const rows = syncedRows.filter(
    (row, index, all) => all.findIndex((candidate) => candidate.symbol === row.symbol) === index,
  );
  const updated = rows[0]?.source_created_at;

  return (
    <section className="panel overflow-hidden">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title">AI council</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Whale Radar sync + our own verdicts
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] text-bull">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bull" /> live
        </span>
      </div>

      <AskCouncilForm onSuccess={refresh} />

      {syncError && (
        <p className="mb-2 break-words text-[10px] text-destructive">
          Council feed error: {syncError}
        </p>
      )}

      {syncing && (
        <p className="text-sm text-muted-foreground">Reading latest council decisions…</p>
      )}
      <ul className="space-y-2">
        {rows.slice(0, 8).map((c) => {
          const verdict = c.final_verdict.toUpperCase();
          const isInternal = c.depth === "internal-ai";
          return (
            <li
              key={`${c.id}-${c.symbol}`}
              className="rounded-md border border-border/70 bg-background/30 p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-sm font-semibold">{c.symbol}</span>
                  {isInternal && (
                    <span className="rounded border border-primary/30 bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary">
                      our AI
                    </span>
                  )}
                </span>
                <span
                  className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${badge[verdict] ?? badge["HOLD"]} ${tone[verdict] ?? tone["HOLD"]}`}
                >
                  {verdict}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Conviction</span>
                <span className="font-mono text-foreground">{c.conviction ?? "—"}%</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full ${verdict === "BUY" ? "bg-bull" : verdict === "HOLD" ? "bg-muted-foreground" : "bg-bear"}`}
                  style={{ width: `${Math.min(100, Math.max(0, c.conviction ?? 0))}%` }}
                />
              </div>
              {c.reflection && (
                <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                  {c.reflection}
                </p>
              )}
              <p className="mt-2 text-[10px] text-muted-foreground">
                {timeAgo(c.source_created_at)} ·{" "}
                {isInternal ? "our own AI council" : c.depth ?? "council synthesis"}
              </p>
            </li>
          );
        })}
        {!syncing && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No council verdicts yet.</p>
        )}
      </ul>
      {updated && (
        <p className="mt-3 border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
          Last update {timeAgo(updated)} · refreshes live
        </p>
      )}
    </section>
  );
}

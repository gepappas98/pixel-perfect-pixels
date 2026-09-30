"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { formatPrice } from "@/lib/format-price";
import type { ClosedTrade } from "@/lib/trading-types";

function formatFullDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function computePnlPct(t: ClosedTrade): number | null {
  if (t.pnl == null) return null;
  const notional = Number(t.entry_price) * Number(t.quantity);
  if (!Number.isFinite(notional) || notional <= 0) return null;
  return (Number(t.pnl) / notional) * 100;
}

function reasonLabel(reason: string | null): string {
  switch (reason) {
    case "take_profit":
      return "target hit";
    case "stop_loss":
      return "stop hit";
    case "stale_exit":
      return "stale exit";
    case "expired":
      return "expired";
    case "rotated_out":
      return "rotated out";
    default:
      return reason ?? "—";
  }
}

function reasonTone(reason: string | null): string {
  switch (reason) {
    case "take_profit":
      return "text-bull";
    case "stop_loss":
      return "text-bear";
    case "rotated_out":
      return "text-warn";
    case "stale_exit":
    case "expired":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

export function TradeAlertsPanel() {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["closed-trades"],
    queryFn: async () => {
      // ── 1. Fetch closed trades ──
      const { data: trades, error: tradesError } = await supabase
        .from("trades")
        .select(
          "id, symbol, side, quantity, entry_price, exit_price, pnl, close_reason, created_at, closed_at, composite_signal_id",
        )
        .eq("status", "closed")
        .not("close_reason", "is", null)
        .neq("close_reason", "duplicate_cleanup")
        .order("closed_at", { ascending: false })
        .limit(20);

      if (tradesError) throw tradesError;

      // ── 2. Collect non-null signal ids ──
      const signalIds = (trades ?? [])
        .map(
          (t) =>
            (t as { composite_signal_id?: string | null })
              .composite_signal_id,
        )
        .filter((id): id is string => id != null);

      const signalsById = new Map<
        string,
        {
          reasoning: string | null;
          confidence: number | null;
          created_at: string;
        }
      >();

      // ── 3. Fetch related composite signals (non-fatal) ──
      if (signalIds.length > 0) {
        const { data: signals, error: signalsError } = await supabase
          .from("composite_signals")
          .select("id, reasoning, confidence, created_at")
          .in("id", signalIds);

        if (!signalsError && signals) {
          for (const s of signals as {
            id: string;
            reasoning: string | null;
            confidence: number | null;
            created_at: string;
          }[]) {
            signalsById.set(s.id, {
              reasoning: s.reasoning,
              confidence: s.confidence,
              created_at: s.created_at,
            });
          }
        }
      }

      // ── 4. Merge ──
      return (trades ?? []).map((t) => {
        const raw = t as Record<string, unknown>;
        const signalId = raw.composite_signal_id as string | null;
        const signal = signalId ? signalsById.get(signalId) ?? null : null;
        return {
          ...raw,
          composite_signal: signal,
        } as unknown as ClosedTrade;
      });
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const rows = data ?? [];

  const toggle = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const hasAnyReasoning = rows.some(
    (t) =>
      t.composite_signal?.reasoning != null &&
      t.composite_signal.reasoning.length > 0,
  );

  return (
    <section className="panel">
      <h2 className="panel-title">Closed Positions</h2>
      <p className="text-xs text-muted-foreground">
        {rows.length} closed
        {hasAnyReasoning && (
          <span className="ml-2 text-[10px] italic">
            · Click a row to see the entry reasoning
          </span>
        )}
      </p>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}

      {error && (
        <p className="text-sm text-destructive">
          Failed to load closed positions: {(error as Error).message}
        </p>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="w-6 pb-2 pr-1 font-normal" />
                <th className="pb-2 pr-3 font-normal">Symbol</th>
                <th className="pb-2 pr-3 font-normal">Side</th>
                <th className="pb-2 pr-3 font-normal">Reason</th>
                <th className="pb-2 pr-3 font-normal">Entry</th>
                <th className="pb-2 pr-3 font-normal">Exit</th>
                <th className="pb-2 pr-3 font-normal">PnL</th>
                <th className="pb-2 pr-3 font-normal">PnL %</th>
                <th className="pb-2 pr-3 font-normal">Opened</th>
                <th className="pb-2 font-normal">Closed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const pnlPct = computePnlPct(t);
                const signal = t.composite_signal;
                const hasReasoning =
                  signal?.reasoning != null && signal.reasoning.length > 0;
                const isExpanded = expandedId === t.id;

                return (
                  <Fragment key={t.id}>
                    <tr
                      className={`border-t border-border font-mono text-xs ${
                        hasReasoning
                          ? "cursor-pointer transition-colors hover:bg-muted/40"
                          : ""
                      } ${isExpanded ? "bg-muted/20" : ""}`}
                      onClick={() => hasReasoning && toggle(t.id)}
                      title={
                        hasReasoning
                          ? "Click to see entry reasoning"
                          : undefined
                      }
                    >
                      <td className="py-1.5 pl-1 pr-1 text-muted-foreground">
                        {hasReasoning &&
                          (isExpanded ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          ))}
                      </td>
                      <td className="py-1.5 pr-3 font-semibold">{t.symbol}</td>
                      <td className="py-1.5 pr-3">{t.side}</td>
                      <td
                        className={`py-1.5 pr-3 ${reasonTone(t.close_reason)}`}
                      >
                        {reasonLabel(t.close_reason)}
                      </td>
                      <td className="py-1.5 pr-3">
                        {formatPrice(Number(t.entry_price))}
                      </td>
                      <td className="py-1.5 pr-3">
                        {t.exit_price == null
                          ? "—"
                          : formatPrice(Number(t.exit_price))}
                      </td>
                      <td
                        className={`py-1.5 pr-3 ${
                          t.pnl == null
                            ? ""
                            : t.pnl >= 0
                              ? "text-bull"
                              : "text-bear"
                        }`}
                      >
                        {t.pnl == null
                          ? "—"
                          : `${t.pnl >= 0 ? "+" : ""}${Number(t.pnl).toFixed(2)}`}
                      </td>
                      <td
                        className={`py-1.5 pr-3 ${
                          pnlPct == null
                            ? ""
                            : pnlPct >= 0
                              ? "text-bull"
                              : "text-bear"
                        }`}
                      >
                        {pnlPct == null
                          ? "—"
                          : `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`}
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground">
                        {formatFullDateTime(t.created_at)}
                      </td>
                      <td className="py-1.5 text-muted-foreground">
                        {formatFullDateTime(t.closed_at)}
                      </td>
                    </tr>

                    {isExpanded && signal && (
                      <tr className="border-t border-border/50 bg-muted/20">
                        <td colSpan={10} className="px-4 py-3">
                          <div className="space-y-2 text-xs">
                            <div className="flex items-start gap-2">
                              <span className="shrink-0 font-semibold text-muted-foreground">
                                📊 Entry reasoning:
                              </span>
                              <span className="whitespace-pre-wrap text-foreground">
                                {signal.reasoning}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-muted-foreground">
                              <span>
                                Confidence:{" "}
                                <span className="font-medium text-foreground">
                                  {signal.confidence == null
                                    ? "—"
                                    : `${(signal.confidence * 100).toFixed(0)}%`}
                                </span>
                              </span>
                              <span>
                                Signal time:{" "}
                                <span className="font-medium text-foreground">
                                  {formatFullDateTime(signal.created_at)}
                                </span>
                              </span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No positions closed yet.
        </p>
      )}
    </section>
  );
}

export default TradeAlertsPanel;

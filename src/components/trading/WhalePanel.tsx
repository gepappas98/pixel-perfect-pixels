import { useLiveTable } from "@/hooks/useLiveTable";
import type { WhaleAlert } from "@/lib/trading-types";

type WhaleFlowSnapshot = {
  id: string;
  bucket_at: string;
  sample_size: number;
  accumulation_pct: number;
  neutral_pct: number;
  distribution_pct: number;
  flow_score: number;
  dominant_state: "accumulation" | "neutral" | "distribution";
};

type WhaleFlowTransition = {
  id: string;
  previous_state: "accumulation" | "neutral" | "distribution";
  new_state: "accumulation" | "neutral" | "distribution";
  detected_at: string;
  delta_pp: number;
  velocity_pp_per_hour: number | null;
  transition_speed: "smooth" | "accelerating" | "violent";
  trigger_candidates: Array<{ type?: string; value?: number; delta_pp?: number }>;
};

type WhaleFlowContext = {
  id: string;
  transition_id: string;
  captured_at: string;
  indicator_context: {
    samples?: number;
    bullish?: number;
    bearish?: number;
    neutral?: number;
  };
  signal_context: {
    samples?: number;
    buy?: number;
    sell?: number;
    hold?: number;
    avg_confidence?: number | null;
  };
  prediction_context: {
    samples?: number;
  };
  sentiment_context?: { available?: boolean; reason?: string };
  news_context?: { available?: boolean; reason?: string };
  data_quality: string;
};

const usd = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}K`;

const stateLabel = (state: WhaleFlowTransition["new_state"]) =>
  state === "accumulation" ? "Accumulation" : state === "distribution" ? "Distribution" : "Neutral";

const stateClass = (state: WhaleFlowTransition["new_state"]) =>
  state === "accumulation" ? "text-bull" : state === "distribution" ? "text-bear" : "text-muted-foreground";

const speedClass = (speed: WhaleFlowTransition["transition_speed"]) =>
  speed === "violent" ? "text-bear" : speed === "accelerating" ? "text-yellow-500" : "text-muted-foreground";

const timeAgo = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export function WhalePanel() {
  const { rows, loading } = useLiveTable<WhaleAlert>("whale_alerts", 12);
  const { rows: history } = useLiveTable<WhaleFlowSnapshot>(
    "whale_flow_snapshots",
    18,
    "bucket_at",
  );
  const { rows: transitions } = useLiveTable<WhaleFlowTransition>(
    "whale_flow_transitions",
    1,
    "detected_at",
  );
  const { rows: contexts } = useLiveTable<WhaleFlowContext>(
    "whale_flow_transition_context",
    1,
    "captured_at",
  );

  const accumulationUsd = rows
    .filter((w) => w.direction === "accumulation")
    .reduce((sum, w) => sum + Number(w.usd_value), 0);
  const distributionUsd = rows
    .filter((w) => w.direction === "distribution")
    .reduce((sum, w) => sum + Number(w.usd_value), 0);
  const totalFlowUsd = accumulationUsd + distributionUsd;
  const rawFlowScore =
    totalFlowUsd > 0 ? (accumulationUsd - distributionUsd) / totalFlowUsd : 0;
  const flowScore = Math.max(-1, Math.min(1, rawFlowScore));
  const flowPercent = Math.round(Math.abs(flowScore) * 100);
  const flowLabel =
    flowScore > 0.05
      ? "Accumulation"
      : flowScore < -0.05
        ? "Distribution"
        : "Neutral";
  const markerPosition = ((flowScore + 1) / 2) * 100;

  const lastTurn = transitions[0];
  const lastContext = contexts[0];
  const chartPoints = [...history].reverse();
  const hasHistory = chartPoints.length >= 2;
  const maxAbsScore = Math.max(
    0.1,
    ...chartPoints.map((point) => Math.abs(Number(point.flow_score) || 0)),
  );

  const triggerText = lastTurn?.trigger_candidates
    ?.filter((x) => x?.type)
    .map((x) => {
      if (x.type === "whale_flow_imbalance") {
        return `imbalance ${Number(x.delta_pp ?? 0) >= 0 ? "+" : ""}${Number(x.delta_pp ?? 0).toFixed(0)}pp`;
      }
      if (x.type === "sell_usd") return `sell ${usd(Number(x.value ?? 0))}`;
      if (x.type === "buy_usd") return `buy ${usd(Number(x.value ?? 0))}`;
      return x.type;
    })
    .join(" · ");

  return (
    <section className="panel">
      <h2 className="panel-title">Whale flow</h2>

      <div
        className="mb-3"
        role="img"
        aria-label={`Whale flow: ${flowLabel}${flowLabel === "Neutral" ? "" : ` ${flowPercent}%`}`}
        title={`Whale flow: ${flowLabel}${flowLabel === "Neutral" ? "" : ` ${flowPercent}%`}`}
      >
        <div className="mb-1 flex items-center justify-between text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
          <span>Distribution</span>
          <span>Neutral</span>
          <span>Accumulation</span>
        </div>
        <div className="relative h-2 overflow-visible rounded-full border border-border bg-muted">
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
          <div
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-sm"
            style={{ left: `${markerPosition}%` }}
          />
        </div>
        <div className="mt-1 text-center text-[10px] font-mono text-muted-foreground">
          <span className={flowLabel === "Accumulation" ? "text-bull" : flowLabel === "Distribution" ? "text-bear" : ""}>
            {flowLabel}{flowLabel !== "Neutral" ? ` ${flowPercent}%` : ""}
          </span>
        </div>
      </div>

      <div className="mb-3 rounded border border-border/60 bg-muted/20 p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
            History
          </span>
          <span className="text-[9px] font-mono text-muted-foreground">
            {history.length > 0 ? `${history.length} snapshots` : "Building history"}
          </span>
        </div>

        {hasHistory ? (
          <>
            <div className="flex h-12 items-center gap-1">
              {chartPoints.map((point) => {
                const score = Number(point.flow_score) || 0;
                const height = Math.max(8, Math.round((Math.abs(score) / maxAbsScore) * 22));
                return (
                  <div
                    key={point.id}
                    className={`flex-1 ${score > 0.05 ? "bg-bull/70" : score < -0.05 ? "bg-bear/70" : "bg-muted-foreground/30"}`}
                    style={{ height: `${height}px`, marginTop: score >= 0 ? 0 : `${height * 0.6}px` }}
                    title={`${stateLabel(point.dominant_state)} · ${new Date(point.bucket_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${(score * 100).toFixed(0)}pp`}
                  />
                );
              })}
            </div>
            <div className="mt-1 flex justify-between text-[8px] font-mono text-muted-foreground">
              <span>{new Date(chartPoints[0]!.bucket_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <span>now</span>
            </div>
          </>
        ) : (
          <div className="py-3 text-[10px] font-mono text-muted-foreground">
            Building history — turns appear after enough snapshots are collected.
          </div>
        )}

        {lastTurn ? (
          <div className="mt-2 border-t border-border/50 pt-2">
            <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
              <span className="text-muted-foreground">Last turn</span>
              <span className={speedClass(lastTurn.transition_speed)}>
                {lastTurn.transition_speed}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] font-mono">
              <span className={stateClass(lastTurn.previous_state)}>
                {stateLabel(lastTurn.previous_state)}
              </span>
              <span className="mx-1 text-muted-foreground">→</span>
              <span className={stateClass(lastTurn.new_state)}>
                {stateLabel(lastTurn.new_state)}
              </span>
              <span className="ml-2 text-muted-foreground">
                {timeAgo(lastTurn.detected_at)} · {lastTurn.delta_pp >= 0 ? "+" : ""}
                {Number(lastTurn.delta_pp).toFixed(0)}pp
              </span>
            </div>
            {triggerText && (
              <div className="mt-1 text-[9px] font-mono text-muted-foreground">
                Possible coincident factors: {triggerText}
              </div>
            )}

            {lastContext && (
              <div className="mt-2 border-t border-border/40 pt-2">
                <div className="mb-1 text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
                  Context at turn · {lastContext.data_quality}
                </div>
                <div className="grid grid-cols-3 gap-1.5 text-[9px] font-mono">
                  <div className="rounded bg-muted/30 px-1.5 py-1">
                    <div className="text-muted-foreground">Technicals</div>
                    <div className="mt-0.5">
                      <span className="text-bull">{lastContext.indicator_context?.bullish ?? 0} B</span>
                      {" · "}
                      <span className="text-bear">{lastContext.indicator_context?.bearish ?? 0} S</span>
                      {" · "}
                      <span className="text-muted-foreground">{lastContext.indicator_context?.neutral ?? 0} N</span>
                    </div>
                  </div>
                  <div className="rounded bg-muted/30 px-1.5 py-1">
                    <div className="text-muted-foreground">Composite</div>
                    <div className="mt-0.5">
                      <span className="text-bull">{lastContext.signal_context?.buy ?? 0} B</span>
                      {" · "}
                      <span className="text-bear">{lastContext.signal_context?.sell ?? 0} S</span>
                      {" · "}
                      <span className="text-muted-foreground">{lastContext.signal_context?.hold ?? 0} H</span>
                    </div>
                  </div>
                  <div className="rounded bg-muted/30 px-1.5 py-1">
                    <div className="text-muted-foreground">Predictions</div>
                    <div className="mt-0.5">{lastContext.prediction_context?.samples ?? 0} samples</div>
                  </div>
                </div>

                {(lastContext.sentiment_context?.available === false || lastContext.news_context?.available === false) && (
                  <div className="mt-1 text-[8px] font-mono text-muted-foreground">
                    Sentiment/news data is unavailable in the current transition window — shown as unavailable, never inferred.
                  </div>
                )}
              </div>
            )}
          </div>
        ) : history.length >= 2 ? (
          <div className="mt-2 border-t border-border/50 pt-2 text-[9px] font-mono text-muted-foreground">
            No confirmed state transition yet.
          </div>
        ) : null}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <ul className="space-y-1.5">
        {rows.map((w) => (
          <li key={w.id} className="flex items-center justify-between text-sm">
            <span className="font-mono">{w.symbol}</span>
            <span
              className={w.direction === "accumulation" ? "text-bull text-xs" : "text-bear text-xs"}
            >
              {w.direction === "accumulation" ? "buy" : "sell"}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {usd(Number(w.usd_value))}
            </span>
          </li>
        ))}
        {!loading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No whale prints yet.</p>
        )}
      </ul>
    </section>
  );
}

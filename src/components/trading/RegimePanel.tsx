"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Compass,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle2,
  Loader2,
  Sparkles,
} from "lucide-react";
import { getMarketRegime } from "@/lib/market-regime.functions";
import { STRATEGY_PRESETS } from "@/lib/strategy.presets";
import {
  getStrategyConfig,
  updateStrategyConfig,
} from "@/lib/strategy.functions";

/* ───────────── Regime display config ───────────── */

const REGIME_META: Record<
  string,
  { label: string; emoji: string; tone: string; bar: string }
> = {
  strong_bull: {
    label: "Strong Bull",
    emoji: "🚀",
    tone: "border-bull/40 bg-bull/10 text-bull",
    bar: "bg-bull",
  },
  bull: {
    label: "Bull",
    emoji: "📈",
    tone: "border-bull/30 bg-bull/5 text-bull",
    bar: "bg-bull/70",
  },
  sideways: {
    label: "Sideways",
    emoji: "↔️",
    tone: "border-border bg-muted text-muted-foreground",
    bar: "bg-muted-foreground",
  },
  bear: {
    label: "Bear",
    emoji: "📉",
    tone: "border-bear/30 bg-bear/5 text-bear",
    bar: "bg-bear/70",
  },
  strong_bear: {
    label: "Strong Bear",
    emoji: "🩸",
    tone: "border-bear/40 bg-bear/10 text-bear",
    bar: "bg-bear",
  },
};

const PRESET_LABEL: Record<string, string> = {
  balanced: "Balanced",
  "whale-focused": "Whale-Focused",
  "chart-trader": "Chart Trader",
  "sentiment-first": "Sentiment-First",
  "ai-driven": "AI-Driven",
  conservative: "Conservative",
};

/* ───────────── Small helpers ───────────── */

function sign(v: number): string {
  return v > 0 ? "+" : "";
}

function Bar({
  value,
  max = 1,
  tone,
}: {
  value: number;
  max?: number;
  tone: string;
}) {
  const pct = Math.min(100, Math.abs(value / max) * 100);
  const positive = value >= 0;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className="absolute left-1/2 top-0 h-full w-px bg-border/70" />
      <div
        className={`absolute top-0 h-full transition-all ${tone}`}
        style={
          positive
            ? { left: "50%", width: `${pct / 2}%` }
            : { right: "50%", width: `${pct / 2}%` }
        }
      />
    </div>
  );
}

function SubSignal({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}) {
  const tone =
    value > 0.15
      ? "bg-bull"
      : value < -0.15
        ? "bg-bear"
        : "bg-muted-foreground";
  const Icon =
    value > 0.15 ? TrendingUp : value < -0.15 ? TrendingDown : Minus;
  const iconTone =
    value > 0.15
      ? "text-bull"
      : value < -0.15
        ? "text-bear"
        : "text-muted-foreground";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Icon className={`h-3 w-3 ${iconTone}`} />
          {label}
        </span>
        <span className={`font-mono text-[10px] ${iconTone}`}>
          {sign(value)}
          {(value * 100).toFixed(0)}%
        </span>
      </div>
      <Bar value={value} tone={tone} />
      <p className="text-[10px] text-muted-foreground">{detail}</p>
    </div>
  );
}

/* ───────────── Main panel ───────────── */

export function RegimePanel() {
  const regimeFn = useServerFn(getMarketRegime);
  const getCfg = useServerFn(getStrategyConfig);
  const setCfg = useServerFn(updateStrategyConfig);
  const qc = useQueryClient();

  const { data: regime, isLoading, error } = useQuery({
    queryKey: ["market-regime"],
    queryFn: () => regimeFn(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: strategy } = useQuery({
    queryKey: ["strategy-config"],
    queryFn: () => getCfg(),
    staleTime: 30_000,
  });

  const apply = useMutation({
    mutationFn: (preset: string) => {
      const p = STRATEGY_PRESETS[preset];
      if (!p) throw new Error(`Unknown preset: ${preset}`);
      return setCfg({
        data: {
          whale_weight: p.whale_weight,
          technicals_weight: p.technicals_weight,
          prediction_weight: p.prediction_weight,
          council_weight: p.council_weight,
          preset_name: p.preset_name,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["strategy-config"] });
    },
  });

  if (isLoading) {
    return (
      <section className="panel">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Reading market regime…</span>
        </div>
      </section>
    );
  }

  if (error || !regime) {
    return (
      <section className="panel border-destructive/30 bg-destructive/5">
        <div className="flex items-center gap-2 text-destructive">
          <Compass className="h-4 w-4" />
          <h2 className="panel-title text-destructive">Market Regime</h2>
        </div>
        <p className="mt-2 text-xs text-destructive/80">
          {error ? (error as Error).message : "Regime data unavailable"}
        </p>
      </section>
    );
  }

  const meta = REGIME_META[regime.regime] ?? REGIME_META["sideways"]!;
  const alreadyOn = strategy?.preset_name === regime.recommended_preset;
  const presetLabel =
    PRESET_LABEL[regime.recommended_preset] ?? regime.recommended_preset;

  return (
    <section className="panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title flex items-center gap-2">
            <Compass className="h-4 w-4 text-accent" />
            Market Regime
          </h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Reads the whole market · refreshes every 60s
          </p>
        </div>
        <span
          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${meta.tone}`}
        >
          {meta.emoji} {meta.label}
        </span>
      </div>

      {/* Score gauge */}
      <div className="mb-3 rounded-md border border-border/70 bg-background/30 p-3">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Bearish</span>
          <span>Score</span>
          <span>Bullish</span>
        </div>
        <div className="relative mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="absolute left-1/2 top-0 h-full w-px bg-border" />
          <div
            className={`absolute top-0 h-full ${meta.bar} transition-all`}
            style={{
              left: regime.score >= 0 ? "50%" : undefined,
              right: regime.score < 0 ? "50%" : undefined,
              width: `${Math.min(50, Math.abs(regime.score) * 50)}%`,
            }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="font-mono text-xs font-semibold">
            {sign(regime.score)}
            {regime.score.toFixed(3)}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {Math.round(regime.confidence * 100)}% agreement
          </span>
        </div>
      </div>

      {/* Sub-signals */}
      <div className="space-y-2.5">
        <SubSignal
          label="Whale Flow"
          value={regime.whale.net_pct}
          detail={`${regime.whale.sample_size} prints · buy $${(regime.whale.buy_usd / 1000).toFixed(0)}k / sell $${(regime.whale.sell_usd / 1000).toFixed(0)}k`}
        />
        <SubSignal
          label="Technicals (4h)"
          value={regime.technicals.breadth}
          detail={`${regime.technicals.bullish} bull · ${regime.technicals.bearish} bear · ${regime.technicals.neutral} neu`}
        />
        <SubSignal
          label="Predictions"
          value={regime.predictions.consensus}
          detail={`${regime.predictions.sample_size} near-term · ${regime.predictions.excluded_long_horizon} long-horizon informational`}
        />
        <SubSignal
          label="AI Council"
          value={regime.council.consensus}
          detail={`${regime.council.buy} buy · ${regime.council.sell} sell · ${regime.council.hold} hold · ${regime.council.avoid} avoid`}
        />
      </div>

      {/* Reasoning */}
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-semibold text-foreground/80">Why: </span>
        {regime.reasoning}.
      </p>

      {/* Recommendation */}
      <div className="mt-3 rounded-md border border-accent/30 bg-accent/5 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
              <Sparkles className="h-3 w-3" />
              Recommended strategy
            </div>
            <p className="mt-1 font-mono text-sm font-semibold text-foreground">
              {presetLabel}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {alreadyOn
                ? "Currently active"
                : "Applies to the next pipeline cycle"}
            </p>
          </div>

          {alreadyOn ? (
            <span className="flex items-center gap-1.5 shrink-0 rounded-md border border-bull/40 bg-bull/10 px-2.5 py-1.5 text-xs font-semibold text-bull">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Active
            </span>
          ) : (
            <button
              onClick={() => apply.mutate(regime.recommended_preset)}
              disabled={apply.isPending}
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-background transition hover:opacity-90 disabled:opacity-50"
            >
              {apply.isPending ? "Applying…" : "Apply"}
            </button>
          )}
        </div>
      </div>

      {apply.isError && (
        <p className="mt-2 text-[10px] text-destructive">
          Failed: {(apply.error as Error).message}
        </p>
      )}

      <p className="mt-3 border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
        Regime is advisory. Verify with your own judgment before applying.
      </p>
    </section>
  );
}

export default RegimePanel;

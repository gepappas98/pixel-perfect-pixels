"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sliders, RotateCcw, Save, Loader2, Info, Bot } from "lucide-react";
import {
  STRATEGY_PRESETS,
  PRESET_LABELS,
} from "@/lib/strategy.presets";
import {
  getStrategyConfig,
  updateStrategyConfig,
  type StrategyConfigFull,
} from "@/lib/strategy.functions";

function WeightSlider({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-background/30 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">{label}</span>
        <span className="font-mono text-xs text-accent">
          ×{value.toFixed(1)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={3}
        step={0.1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="mt-2 w-full accent-accent disabled:opacity-50"
      />
      <p className="mt-1 text-[10px] text-muted-foreground">{description}</p>
    </div>
  );
}

export function StrategyPanel() {
  const getFn = useServerFn(getStrategyConfig);
  const setFn = useServerFn(updateStrategyConfig);
  const qc = useQueryClient();

  const { data: serverConfig, isLoading } = useQuery<StrategyConfigFull>({
    queryKey: ["strategy-config"],
    queryFn: () => getFn(),
    staleTime: 30_000,
  });

  const [draft, setDraft] = useState<StrategyConfigFull | null>(null);

  useEffect(() => {
    if (serverConfig && !draft) setDraft(serverConfig);
  }, [serverConfig, draft]);

  const save = useMutation({
    mutationFn: (cfg: StrategyConfigFull) =>
      setFn({
        data: {
          whale_weight: cfg.whale_weight,
          technicals_weight: cfg.technicals_weight,
          prediction_weight: cfg.prediction_weight,
          council_weight: cfg.council_weight,
          preset_name: cfg.preset_name,
          auto_switch_enabled: cfg.auto_switch_enabled,
          auto_switch_interval_hours: cfg.auto_switch_interval_hours,
        },
      }),
    onSuccess: (updated) => {
      setDraft(updated);
      qc.invalidateQueries({ queryKey: ["strategy-config"] });
    },
  });

  function applyPreset(name: string) {
    const p = STRATEGY_PRESETS[name];
    if (!p) return;
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            whale_weight: p.whale_weight,
            technicals_weight: p.technicals_weight,
            prediction_weight: p.prediction_weight,
            council_weight: p.council_weight,
            preset_name: p.preset_name,
          }
        : null,
    );
  }

  function reset() {
    if (serverConfig) setDraft(serverConfig);
  }

  if (isLoading || !draft) {
    return (
      <section className="panel">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading strategy…</span>
        </div>
      </section>
    );
  }

  const maxScore =
    draft.whale_weight * 1.0 +
    draft.technicals_weight * 1.69 +
    draft.prediction_weight * 0.5 +
    draft.council_weight * 0.75;

  const dirty =
    serverConfig &&
    (draft.whale_weight !== serverConfig.whale_weight ||
      draft.technicals_weight !== serverConfig.technicals_weight ||
      draft.prediction_weight !== serverConfig.prediction_weight ||
      draft.council_weight !== serverConfig.council_weight ||
      draft.auto_switch_enabled !== serverConfig.auto_switch_enabled ||
      draft.auto_switch_interval_hours !== serverConfig.auto_switch_interval_hours);

  return (
    <section className="panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title flex items-center gap-2">
            <Sliders className="h-4 w-4 text-accent" />
            Strategy Weights
          </h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            {PRESET_LABELS[draft.preset_name ?? "custom"] ?? "Custom"} · affects
            next cycle
          </p>
        </div>
        {dirty && (
          <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold text-warn">
            UNSAVED
          </span>
        )}
      </div>

      {/* ── Auto-switch toggle ── */}
      <div className="mb-3 rounded-md border border-accent/30 bg-accent/5 p-2.5">
        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Bot className="h-3.5 w-3.5 text-accent" />
              <span className="text-xs font-semibold text-foreground">
                Auto-adaptive strategy
              </span>
              {draft.auto_switch_enabled && (
                <span className="rounded border border-bull/40 bg-bull/10 px-1 py-0.5 text-[9px] font-semibold text-bull">
                  ON
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              AI re-evaluates the strategy every{" "}
              {draft.auto_switch_interval_hours ?? 4}h
            </p>
          </div>
          <input
            type="checkbox"
            checked={draft.auto_switch_enabled ?? false}
            onChange={(e) =>
              setDraft({
                ...draft,
                auto_switch_enabled: e.target.checked,
              })
            }
            className="h-4 w-4 shrink-0 accent-accent"
          />
        </label>

        {draft.auto_switch_enabled && (
          <div className="mt-2 flex items-center gap-2">
            <label className="text-[10px] text-muted-foreground">
              Interval:
            </label>
            <select
              value={draft.auto_switch_interval_hours ?? 4}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  auto_switch_interval_hours: Number(e.target.value),
                })
              }
              className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-[10px] text-foreground"
            >
              <option value={1}>Every 1 hour</option>
              <option value={2}>Every 2 hours</option>
              <option value={4}>Every 4 hours</option>
              <option value={8}>Every 8 hours</option>
              <option value={12}>Every 12 hours</option>
              <option value={24}>Every 24 hours</option>
            </select>
          </div>
        )}

        {draft.last_auto_switch_at && (
          <div className="mt-2 rounded border border-accent/20 bg-background/40 p-2">
            <p className="text-[9px] uppercase tracking-wider text-accent">
              Last auto-switch
            </p>
            <p className="mt-0.5 font-mono text-[10px] text-foreground/80">
              {new Date(draft.last_auto_switch_at).toLocaleString("en-GB")}
            </p>
            {draft.last_auto_reasoning && (
              <p className="mt-1 text-[10px] italic leading-relaxed text-muted-foreground">
                "{draft.last_auto_reasoning}"
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Presets ── */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {Object.keys(STRATEGY_PRESETS).map((name) => {
          const isActive = draft.preset_name === name;
          return (
            <button
              key={name}
              onClick={() => applyPreset(name)}
              disabled={save.isPending}
              className={`rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition ${
                isActive
                  ? "border-accent/50 bg-accent/15 text-accent"
                  : "border-border bg-muted text-muted-foreground hover:bg-muted/80"
              } disabled:opacity-50`}
            >
              {PRESET_LABELS[name] ?? name}
            </button>
          );
        })}
      </div>

      {/* ── Sliders ── */}
      <div className="space-y-2">
        <WeightSlider
          label="Whale Flow"
          description="Weight on institutional / large-clip trades"
          value={draft.whale_weight}
          onChange={(v) =>
            setDraft({ ...draft, whale_weight: v, preset_name: "custom" })
          }
          disabled={save.isPending}
        />
        <WeightSlider
          label="Technicals (MTF)"
          description="4h + 1h + 1d confluence score"
          value={draft.technicals_weight}
          onChange={(v) =>
            setDraft({ ...draft, technicals_weight: v, preset_name: "custom" })
          }
          disabled={save.isPending}
        />
        <WeightSlider
          label="Prediction Markets"
          description="Polymarket directional signal"
          value={draft.prediction_weight}
          onChange={(v) =>
            setDraft({ ...draft, prediction_weight: v, preset_name: "custom" })
          }
          disabled={save.isPending}
        />
        <WeightSlider
          label="AI Council"
          description="Groq LLM + deterministic fallback"
          value={draft.council_weight}
          onChange={(v) =>
            setDraft({ ...draft, council_weight: v, preset_name: "custom" })
          }
          disabled={save.isPending}
        />
      </div>

      <div className="mt-3 flex items-center justify-between rounded-md border border-border/70 bg-background/40 p-2.5">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Info className="h-3 w-3" />
          Max theoretical score
        </span>
        <span className="font-mono text-xs font-semibold text-foreground">
          ±{maxScore.toFixed(2)}
        </span>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        Thresholds stay fixed at ±1.5 for buy/sell. Higher weights make those
        thresholds easier (or harder) to reach. Weights apply only to the
        composite signal score — whale detection thresholds and council votes
        remain unchanged.
      </p>

      {/* ── Actions ── */}
      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={reset}
          disabled={!dirty || save.isPending}
          className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-foreground transition hover:bg-muted/80 disabled:opacity-40"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Discard
        </button>
        <button
          onClick={() => save.mutate(draft)}
          disabled={!dirty || save.isPending}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
        >
          {save.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Save className="h-3.5 w-3.5" />
              Save
            </>
          )}
        </button>
      </div>

      {save.isError && (
        <p className="mt-2 text-[10px] text-destructive">
          Failed to save: {(save.error as Error).message}
        </p>
      )}
    </section>
  );
}

export default StrategyPanel;

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export interface StrategyPreset {
  preset_name: string;
  whale_weight: number;
  technicals_weight: number;
  prediction_weight: number;
  council_weight: number;
}

export const STRATEGY_PRESETS: Record<string, StrategyPreset> = {
  balanced: { preset_name: "balanced", whale_weight: 1, technicals_weight: 1, prediction_weight: 1, council_weight: 1 },
  "whale-focused": { preset_name: "whale-focused", whale_weight: 1.5, technicals_weight: 0.8, prediction_weight: 0.7, council_weight: 1 },
  "chart-trader": { preset_name: "chart-trader", whale_weight: 0.8, technicals_weight: 1.5, prediction_weight: 0.7, council_weight: 1 },
  "sentiment-first": { preset_name: "sentiment-first", whale_weight: 0.8, technicals_weight: 0.8, prediction_weight: 1.5, council_weight: 1 },
  "ai-driven": { preset_name: "ai-driven", whale_weight: 0.8, technicals_weight: 0.8, prediction_weight: 0.8, council_weight: 1.5 },
  conservative: { preset_name: "conservative", whale_weight: 0.7, technicals_weight: 0.7, prediction_weight: 0.7, council_weight: 0.7 },
};

const schema = z.object({
  preset_name: z.string().max(40),
  whale_weight: z.number().min(0).max(3),
  technicals_weight: z.number().min(0).max(3),
  prediction_weight: z.number().min(0).max(3),
  council_weight: z.number().min(0).max(3),
});

// Not persisted: no strategy table exists yet; defaults to "balanced".
let current: StrategyPreset = STRATEGY_PRESETS["balanced"]!;

export const getStrategyConfig = createServerFn({ method: "GET" }).handler(async () => current);

export const updateStrategyConfig = createServerFn({ method: "POST" })
  .validator((d: unknown) => schema.parse(d))
  .handler(async ({ data }) => {
    current = data;
    return current;
  });

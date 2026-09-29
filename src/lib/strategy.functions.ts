import { createServerFn } from "@tanstack/react-start";
import {
  DEFAULT_STRATEGY,
  STRATEGY_PRESETS,
  type StrategyConfig,
} from "./strategy.presets";
import { fetchCleanupConfig } from "./cleanup-config.server";
import { serializeError } from "./error-serialize";

/* ───────────── Types ───────────── */

export interface StrategyConfigFull extends StrategyConfig {
  auto_switch_enabled: boolean;
  auto_switch_interval_hours: number;
  last_auto_switch_at: string | null;
  last_auto_reasoning: string | null;
}

const DEFAULT_FULL: StrategyConfigFull = {
  ...DEFAULT_STRATEGY,
  auto_switch_enabled: false,
  auto_switch_interval_hours: 4,
  last_auto_switch_at: null,
  last_auto_reasoning: null,
};

/* ───────────── Helpers ───────────── */

function rowToConfig(row: Record<string, unknown>): StrategyConfigFull {
  return {
    whale_weight: Number(row["whale_weight"]),
    technicals_weight: Number(row["technicals_weight"]),
    prediction_weight: Number(row["prediction_weight"]),
    council_weight: Number(row["council_weight"]),
    preset_name: (row["preset_name"] as string | null) ?? null,
    updated_at: String(row["updated_at"]),
    auto_switch_enabled: Boolean(row["auto_switch_enabled"]),
    auto_switch_interval_hours: Number(row["auto_switch_interval_hours"] ?? 4),
    last_auto_switch_at: (row["last_auto_switch_at"] as string | null) ?? null,
    last_auto_reasoning:
      (row["last_auto_reasoning"] as string | null) ?? null,
  };
}

/* ───────────── Load ───────────── */

export const getStrategyConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<StrategyConfigFull> => {
    try {
      const { supabaseAdmin } = await import(
        "@/integrations/supabase/client.server"
      );
      const { data, error } = await supabaseAdmin
        .from("strategy_config")
        .select("*")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return DEFAULT_FULL;
      return rowToConfig(data as Record<string, unknown>);
    } catch (e) {
      console.error(
        "[STRATEGY] load failed, using defaults",
        serializeError(e),
      );
      return DEFAULT_FULL;
    }
  },
);

/* ───────────── Update manual ───────────── */

export const updateStrategyConfig = createServerFn({ method: "POST" })
  .validator(
    (data: {
      whale_weight: number;
      technicals_weight: number;
      prediction_weight: number;
      council_weight: number;
      preset_name: string | null;
      auto_switch_enabled?: boolean;
      auto_switch_interval_hours?: number;
    }) => {
      const clamp = (v: unknown) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.min(3, Math.round(n * 10) / 10));
      };
      const w = {
        whale_weight: clamp(data.whale_weight),
        technicals_weight: clamp(data.technicals_weight),
        prediction_weight: clamp(data.prediction_weight),
        council_weight: clamp(data.council_weight),
      };
      if (
        w.whale_weight +
          w.technicals_weight +
          w.prediction_weight +
          w.council_weight ===
        0
      ) {
        throw new Error("At least one weight must be greater than 0");
      }
      const intervalHours =
        data.auto_switch_interval_hours != null
          ? Math.max(
              1,
              Math.min(24, Math.round(Number(data.auto_switch_interval_hours))),
            )
          : undefined;
      return {
        ...w,
        preset_name: data.preset_name ?? "custom",
        auto_switch_enabled: data.auto_switch_enabled,
        auto_switch_interval_hours: intervalHours,
      };
    },
  )
  .handler(async ({ data }): Promise<StrategyConfigFull> => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const update: Record<string, unknown> = {
      whale_weight: data.whale_weight,
      technicals_weight: data.technicals_weight,
      prediction_weight: data.prediction_weight,
      council_weight: data.council_weight,
      preset_name: data.preset_name,
      updated_at: new Date().toISOString(),
    };
    if (data.auto_switch_enabled !== undefined) {
      update["auto_switch_enabled"] = data.auto_switch_enabled;
    }
    if (data.auto_switch_interval_hours !== undefined) {
      update["auto_switch_interval_hours"] = data.auto_switch_interval_hours;
    }
    const { data: row, error } = await supabaseAdmin
      .from("strategy_config")
      .update(update as never)
      .eq("id", 1)
      .select("*")
      .single();
    if (error) throw error;
    return rowToConfig(row as Record<string, unknown>);
  });

/* ───────────── Auto-switch ───────────── */

const AUTO_SWITCH_MIN_COOLDOWN_MIN = 30;

interface MarketSnapshot {
  whale: { buy_usd: number; sell_usd: number; net_pct: number; sample: number };
  technicals: { bull: number; bear: number; neu: number; breadth: number };
  predictions: { bull: number; bear: number; neu: number; consensus: number };
  council: { buy: number; sell: number; hold: number; avoid: number };
  regime_score: number;
}

async function gatherSnapshot(): Promise<MarketSnapshot> {
  const { supabaseAdmin: db } = await import(
    "@/integrations/supabase/client.server"
  );
  const now = Date.now();
  const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000).toISOString();
  const thirtyMinAgo = new Date(now - 30 * 60 * 1000).toISOString();

  const [whalesRes, techsRes, predsRes, councilRes] = await Promise.all([
    db
      .from("whale_alerts")
      .select("direction, usd_value")
      .gte("created_at", sixHoursAgo),
    db
      .from("indicator_snapshots")
      .select("symbol, signal, created_at")
      .eq("timeframe", "4h")
      .gte("created_at", sixHoursAgo)
      .order("created_at", { ascending: false })
      .limit(5000),
    db
      .from("prediction_snapshots")
      .select("market_slug, question, yes_price")
      .order("created_at", { ascending: false })
      .limit(2000),
    db
      .from("council_signals")
      .select("symbol, final_verdict")
      .gte("source_created_at", thirtyMinAgo),
  ]);

  // Explicit error logging — δεν χάνουμε failures σιωπηλά
  if (whalesRes.error)
    console.error("[AUTO_SWITCH] whales query:", serializeError(whalesRes.error));
  if (techsRes.error)
    console.error("[AUTO_SWITCH] technicals query:", serializeError(techsRes.error));
  if (predsRes.error)
    console.error("[AUTO_SWITCH] predictions query:", serializeError(predsRes.error));
  if (councilRes.error)
    console.error("[AUTO_SWITCH] council query:", serializeError(councilRes.error));

  console.log(
    `[AUTO_SWITCH] snapshot rows: whales=${whalesRes.data?.length ?? 0} techs=${techsRes.data?.length ?? 0} preds=${predsRes.data?.length ?? 0} council=${councilRes.data?.length ?? 0}`,
  );

  let buyUsd = 0,
    sellUsd = 0;
  for (const w of (whalesRes.data ?? []) as {
    direction: string;
    usd_value: number;
  }[]) {
    const v = Number(w.usd_value) || 0;
    if (w.direction === "accumulation") buyUsd += v;
    else if (w.direction === "distribution") sellUsd += v;
  }
  const totalWhale = buyUsd + sellUsd;
  const whaleNet = totalWhale > 0 ? (buyUsd - sellUsd) / totalWhale : 0;

  const seenTech = new Set<string>();
  let tBull = 0,
    tBear = 0,
    tNeu = 0;
  for (const t of (techsRes.data ?? []) as {
    symbol: string;
    signal: string | null;
  }[]) {
    if (seenTech.has(t.symbol)) continue;
    seenTech.add(t.symbol);
    if (t.signal === "bullish") tBull++;
    else if (t.signal === "bearish") tBear++;
    else tNeu++;
  }
  const totalTech = tBull + tBear + tNeu;
  const techBreadth = totalTech > 0 ? (tBull - tBear) / totalTech : 0;

  const BULL =
    /\b(reach|hit|above|surpass|exceed|break|all[- ]time high|ath|top)\b/i;
  const BEAR = /\b(dip|drop|fall|below|crash|down to|under|bottom)\b/i;
  const seenPred = new Set<string>();
  let pBull = 0,
    pBear = 0,
    pNeu = 0;
  for (const p of (predsRes.data ?? []) as {
    market_slug: string;
    question: string | null;
    yes_price: number | null;
  }[]) {
    if (seenPred.has(p.market_slug)) continue;
    seenPred.add(p.market_slug);
    const yes = Number(p.yes_price);
    if (!Number.isFinite(yes)) {
      pNeu++;
      continue;
    }
    const q = String(p.question ?? "").toLowerCase();
    const isBq = BULL.test(q),
      isBeq = BEAR.test(q);
    if (!isBq && !isBeq) {
      pNeu++;
      continue;
    }
    const up = isBq ? yes : 1 - yes;
    if (up > 0.6) pBull++;
    else if (up < 0.4) pBear++;
    else pNeu++;
  }
  const totalPred = pBull + pBear + pNeu;
  const predConsensus = totalPred > 0 ? (pBull - pBear) / totalPred : 0;

  const seenCouncil = new Set<string>();
  let cBuy = 0,
    cSell = 0,
    cHold = 0,
    cAvoid = 0;
  for (const c of (councilRes.data ?? []) as {
    symbol: string;
    final_verdict: string | null;
  }[]) {
    if (seenCouncil.has(c.symbol)) continue;
    seenCouncil.add(c.symbol);
    const v = String(c.final_verdict ?? "").toUpperCase();
    if (v === "BUY") cBuy++;
    else if (v === "SELL") cSell++;
    else if (v === "AVOID") cAvoid++;
    else cHold++;
  }

  const councilTotal = cBuy + cSell + cHold + cAvoid;
  const councilConsensus = councilTotal > 0 ? (cBuy - cSell) / councilTotal : 0;

  const regime_score =
    whaleNet * 0.3 +
    techBreadth * 0.4 +
    predConsensus * 0.2 +
    councilConsensus * 0.1;

  return {
    whale: {
      buy_usd: buyUsd,
      sell_usd: sellUsd,
      net_pct: whaleNet,
      sample: (whalesRes.data ?? []).length,
    },
    technicals: { bull: tBull, bear: tBear, neu: tNeu, breadth: techBreadth },
    predictions: {
      bull: pBull,
      bear: pBear,
      neu: pNeu,
      consensus: predConsensus,
    },
    council: { buy: cBuy, sell: cSell, hold: cHold, avoid: cAvoid },
    regime_score,
  };
}

/* ───────────── Groq call — discriminated result ───────────── */

type AskResult =
  | { kind: "success"; preset: string; reasoning: string }
  | { kind: "error"; message: string; retryable: boolean };

async function askGroqForPreset(
  snapshot: MarketSnapshot,
  currentPreset: string | null,
): Promise<AskResult> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) {
    return { kind: "error", message: "GROQ_API_KEY not set", retryable: false };
  }

  const presetList = Object.keys(STRATEGY_PRESETS).join(", ");
  const systemPrompt = [
    "You are a senior trading strategist choosing the best bot strategy preset.",
    "You receive a full market snapshot across 4 evidence sources.",
    "Respond with ONLY a minified JSON object. No markdown. No code fences.",
    'Shape: {"preset":"<name>","reasoning":"<one concise sentence>"}',
    `Allowed presets: ${presetList}.`,
    "Choose the preset that best fits the CURRENT market state.",
    "If the current preset is already appropriate, return it unchanged.",
  ].join("\n");

  const userPrompt = JSON.stringify({
    current_preset: currentPreset ?? "balanced",
    snapshot: {
      whale_net_pct: Math.round(snapshot.whale.net_pct * 100),
      whale_buy_usd: Math.round(snapshot.whale.buy_usd),
      whale_sell_usd: Math.round(snapshot.whale.sell_usd),
      whale_samples: snapshot.whale.sample,
      tech_bull: snapshot.technicals.bull,
      tech_bear: snapshot.technicals.bear,
      tech_neutral: snapshot.technicals.neu,
      tech_breadth_pct: Math.round(snapshot.technicals.breadth * 100),
      pred_bull: snapshot.predictions.bull,
      pred_bear: snapshot.predictions.bear,
      pred_neutral: snapshot.predictions.neu,
      pred_consensus_pct: Math.round(snapshot.predictions.consensus * 100),
      council_buy: snapshot.council.buy,
      council_sell: snapshot.council.sell,
      council_hold: snapshot.council.hold,
      council_avoid: snapshot.council.avoid,
      regime_score: Number(snapshot.regime_score.toFixed(3)),
    },
  });

  let res: Response;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env["GROQ_MODEL"] ?? "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.15,
        // gpt-oss-20b είναι reasoning model: χρειάζεται headroom για
        // internal reasoning tokens πριν παραγάγει το τελικό JSON.
        // 600 δεν έφτανε: finish_reason=length με ~600 reasoning tokens και κενό content.
        max_tokens: 1500,
        ...(/gpt-oss/i.test(process.env["GROQ_MODEL"] ?? "openai/gpt-oss-20b")
          ? { reasoning_effort: "low" }
          : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const msg = serializeError(e);
    const retryable = /timeout|abort|network|econn/i.test(msg);
    return { kind: "error", message: `fetch failed: ${msg}`, retryable };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;
    return {
      kind: "error",
      message: `HTTP ${res.status}: ${body.slice(0, 200)}`,
      retryable,
    };
  }

  let data: {
    choices?: {
      message?: { content?: string };
      finish_reason?: string;
    }[];
    usage?: {
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  try {
    data = await res.json();
  } catch (e) {
    return {
      kind: "error",
      message: `response.json() failed: ${serializeError(e)}`,
      retryable: false,
    };
  }

  const finishReason = data.choices?.[0]?.finish_reason;
  const content = data.choices?.[0]?.message?.content ?? "";
  const reasoningTokens =
    data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

  if (!content) {
    return {
      kind: "error",
      message: `empty content (finish_reason=${finishReason}, reasoning_tokens=${reasoningTokens})`,
      retryable: true,
    };
  }

  const clean = content.replace(/```json|```/g, "").trim();

  let parsed: { preset?: string; reasoning?: string };
  try {
    parsed = JSON.parse(clean) as { preset?: string; reasoning?: string };
  } catch {
    return {
      kind: "error",
      message: `JSON parse failed: ${clean.slice(0, 150)}`,
      retryable: false,
    };
  }

  if (!parsed.preset || !STRATEGY_PRESETS[parsed.preset]) {
    return {
      kind: "error",
      message: `invalid preset: ${parsed.preset} (raw=${clean.slice(0, 120)})`,
      retryable: false,
    };
  }

  return {
    kind: "success",
    preset: parsed.preset,
    reasoning:
      parsed.reasoning ?? "AI-selected based on current market state.",
  };
}

/* ───────────── Retry wrapper ───────────── */

async function askGroqWithRetry(
  snapshot: MarketSnapshot,
  currentPreset: string | null,
  maxRetries: number,
  baseBackoffMs: number,
): Promise<{ result: AskResult; attempts: number; history: string[] }> {
  const history: string[] = [];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const r = await askGroqForPreset(snapshot, currentPreset);

    if (r.kind === "success") {
      return { result: r, attempts: attempt, history };
    }

    history.push(`attempt ${attempt}: ${r.message}`);

    if (!r.retryable) {
      return { result: r, attempts: attempt, history };
    }

    if (attempt < maxRetries) {
      const delay = baseBackoffMs * Math.pow(2, attempt - 1);
      console.log(
        `[AUTO_SWITCH] retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return {
    result: {
      kind: "error",
      message: history[history.length - 1] ?? "unknown",
      retryable: true,
    },
    attempts: maxRetries,
    history,
  };
}

/* ───────────── Maybe auto-switch ───────────── */

export const maybeAutoSwitchStrategy = createServerFn({ method: "POST" })
  .handler(
    async (): Promise<{
      switched: boolean;
      preset?: string;
      reasoning?: string;
      reason: string;
      detail?: string;
    }> => {
      const { supabaseAdmin: db } = await import(
        "@/integrations/supabase/client.server"
      );

      // 1. Load config
      const { data: config, error } = await db
        .from("strategy_config")
        .select("*")
        .eq("id", 1)
        .maybeSingle();
      if (error || !config) return { switched: false, reason: "no_config" };

      const row = config as Record<string, unknown>;

      // 2. Check enabled
      if (!row["auto_switch_enabled"]) {
        return { switched: false, reason: "disabled" };
      }

      // 3. Check cooldown
      const intervalHours = Math.max(
        1,
        Number(row["auto_switch_interval_hours"] ?? 4),
      );
      const minCooldownMs = Math.max(
        AUTO_SWITCH_MIN_COOLDOWN_MIN * 60 * 1000,
        intervalHours * 60 * 60 * 1000,
      );
      const lastAtRaw = row["last_auto_switch_at"];
      const lastAt = lastAtRaw ? new Date(String(lastAtRaw)).getTime() : 0;
      const elapsedMs = Date.now() - lastAt;
      if (lastAt > 0 && elapsedMs < minCooldownMs) {
        const hoursRemaining = (
          (minCooldownMs - elapsedMs) /
          3_600_000
        ).toFixed(1);
        return { switched: false, reason: `cooldown_${hoursRemaining}h` };
      }

      // 4. Gather snapshot
      const snapshot = await gatherSnapshot();

      // 5. Load cleanup config (retry feature flag)
      const cleanupCfg = await fetchCleanupConfig();
      const retryCfg = cleanupCfg.auto_switch_retry;
      const maxRetries = retryCfg.enabled
        ? Math.max(1, retryCfg.max_retries)
        : 1;
      const backoffMs = retryCfg.enabled
        ? Math.max(500, retryCfg.backoff_ms)
        : 0;

      // 6. Call Groq με retry
      const currentPreset = (row["preset_name"] as string | null) ?? null;
      const {
        result: decision,
        attempts,
        history,
      } = await askGroqWithRetry(
        snapshot,
        currentPreset,
        maxRetries,
        backoffMs,
      );

      if (decision.kind === "error") {
        const detail = `Groq failed after ${attempts} attempt(s): ${decision.message}`;
        console.error(`[AUTO_SWITCH] ${detail}`);
        if (history.length > 1) {
          console.error(`[AUTO_SWITCH] history: ${history.join(" → ")}`);
        }

        await db
          .from("strategy_config")
          .update({
            last_auto_switch_at: new Date().toISOString(),
            last_auto_reasoning: detail,
          })
          .eq("id", 1);

        return { switched: false, reason: "groq_failed", detail };
      }

      // 7. Same preset → just log
      if (decision.preset === currentPreset) {
        await db
          .from("strategy_config")
          .update({
            last_auto_switch_at: new Date().toISOString(),
            last_auto_reasoning: `No change: ${decision.reasoning}`,
          })
          .eq("id", 1);
        return {
          switched: false,
          reason: "no_change",
          preset: decision.preset,
          reasoning: decision.reasoning,
        };
      }

      // 8. Apply new preset
      const preset = STRATEGY_PRESETS[decision.preset];
      if (!preset) {
        return { switched: false, reason: "invalid_preset" };
      }

      const { error: updateErr } = await db
        .from("strategy_config")
        .update({
          whale_weight: preset.whale_weight,
          technicals_weight: preset.technicals_weight,
          prediction_weight: preset.prediction_weight,
          council_weight: preset.council_weight,
          preset_name: preset.preset_name ?? "custom",
          last_auto_switch_at: new Date().toISOString(),
          last_auto_reasoning: decision.reasoning,
          updated_at: new Date().toISOString(),
        })
        .eq("id", 1);

      if (updateErr) {
        console.error(
          "[AUTO_SWITCH] update failed:",
          serializeError(updateErr),
        );
        return { switched: false, reason: "update_failed" };
      }

      console.log(
        `[AUTO_SWITCH] ${currentPreset} → ${decision.preset} | ${decision.reasoning}`,
      );
      return {
        switched: true,
        preset: decision.preset,
        reasoning: decision.reasoning,
        reason: "switched",
      };
    },
  );

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
      const { supabase } = await import("@/integrations/supabase/client");
      const { data, error } = await supabase
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

/**
 * Crypto-native strategy switching thresholds.
 * Trustworthy activity is intentionally smaller for fast-moving crypto regimes.
 */
const VARIANT_MIN_TRUSTWORTHY_SAMPLE = 18;
const FALLBACK_MIN_SAMPLE = 8;
const AUTO_DEMOTE_AVG_PNL_THRESHOLD = 0;
const AUTO_DEMOTE_WINRATE_SOFT = 0.30;
const SWITCH_SCORE_MARGIN = 1.12;

interface MarketSnapshot {
  whale: { buy_usd: number; sell_usd: number; net_pct: number; sample: number };
  technicals: { bull: number; bear: number; neu: number; breadth: number };
  predictions: { bull: number; bear: number; neu: number; consensus: number };
  council: { buy: number; sell: number; hold: number; avoid: number };
  regime_score: number;
}

interface VariantPerformanceRow {
  strategy_name: string;
  wins: number;
  losses: number;
  expired: number;
  open_count: number;
  resolved: number;
  total_pnl_pct: number;
}

interface VariantPerformance {
  strategy_name: string;
  wins: number;
  losses: number;
  resolved: number;
  win_rate_pct: number | null;
  total_pnl_pct: number;
  avg_pnl_pct: number | null;
  trustworthy: boolean;
}

/* ───────────── Market snapshot ───────────── */

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

  if (whalesRes.error)
    console.error(
      "[AUTO_SWITCH] whales query:",
      serializeError(whalesRes.error),
    );
  if (techsRes.error)
    console.error(
      "[AUTO_SWITCH] technicals query:",
      serializeError(techsRes.error),
    );
  if (predsRes.error)
    console.error(
      "[AUTO_SWITCH] predictions query:",
      serializeError(predsRes.error),
    );
  if (councilRes.error)
    console.error(
      "[AUTO_SWITCH] council query:",
      serializeError(councilRes.error),
    );

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
  const councilConsensus =
    councilTotal > 0 ? (cBuy - cSell) / councilTotal : 0;

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

/* ───────────── Variant performance ───────────── */

/**
 * Φορτώνει variant performance για όλα τα presets από το legacy RPC
 * get_variant_performance(days). Επιστρέφει normalized rows.
 *
 * Non-fatal: ��ν αποτύχει, επιστρέφει empty array και το prompt
 * θα τρέ��ει χωρίς historical performance.
 */
async function fetchVariantPerformance(
  days = 7,
): Promise<VariantPerformance[]> {
  try {
    const { supabaseAdmin: db } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data, error } = await (db.rpc as any)("get_variant_performance", {
      days,
    });
    if (error) throw error;

    const rows = (data ?? []) as VariantPerformanceRow[];

    return rows.map((r) => {
      const resolved = Number(r.resolved ?? 0);
      const wins = Number(r.wins ?? 0);
      const losses = Number(r.losses ?? 0);
      const decided = wins + losses;
      const total_pnl_pct = Number(r.total_pnl_pct ?? 0);

      return {
        strategy_name: r.strategy_name,
        wins,
        losses,
        resolved,
        win_rate_pct:
          decided > 0 ? Math.round((wins / decided) * 1000) / 10 : null,
        total_pnl_pct,
        avg_pnl_pct:
          resolved > 0
            ? Math.round((total_pnl_pct / resolved) * 100) / 100
            : null,
        trustworthy: decided >= VARIANT_MIN_TRUSTWORTHY_SAMPLE,
      };
    });
  } catch (e) {
    console.error(
      "[AUTO_SWITCH] fetchVariantPerformance failed:",
      serializeError(e),
    );
    return [];
  }
}

/* ───────────── Deterministic fallback selection ───────────── */

/**
 * Deterministic selection of the best preset based on shadow performance.
 *
 * Called in two situations:
 *   1. When Groq fails (rate limit, token overflow, network) — replaces
 *      what used to be a silent "groq_failed" no-op.
 *   2. As a safety override after Groq returns — if Groq picked a preset
 *      that has proven negative expectancy with meaningful sample, we
 *      ignore the AI and use the deterministic pick.
 *
 * Returns `null` if no switch is warranted (current preset still healthy,
 * or no preset has enough resolved samples).
 */
function selectBestPresetDeterministic(
  performance: VariantPerformance[],
  currentPreset: string | null,
): { preset: string; reasoning: string; forced: boolean } | null {
  const eligible = performance.filter(
    (p) => p.resolved >= FALLBACK_MIN_SAMPLE && p.win_rate_pct != null,
  );
  if (eligible.length === 0) return null;

  const scored = eligible
    .map((p) => {
      const wr = (p.win_rate_pct ?? 0) / 100;
      const avgPnl = p.avg_pnl_pct ?? 0;
      const sampleFactor = Math.min(1, p.resolved / 25);
      const wrTilt = 0.85 + 0.15 * wr;
      const score = avgPnl * wrTilt * (0.75 + 0.25 * sampleFactor);
      return { perf: p, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const currentPerf = eligible.find((p) => p.strategy_name === currentPreset);

  if (currentPerf) {
    const wr = (currentPerf.win_rate_pct ?? 0) / 100;
    const avgPnl = currentPerf.avg_pnl_pct ?? currentPerf.total_pnl_pct;
    const badExpectancy = avgPnl < AUTO_DEMOTE_AVG_PNL_THRESHOLD;
    const veryBadWr = wr < AUTO_DEMOTE_WINRATE_SOFT;

    if (badExpectancy && (currentPerf.resolved >= FALLBACK_MIN_SAMPLE || veryBadWr)) {
      return {
        preset: best.perf.strategy_name,
        reasoning:
          `AUTO_DEMOTE: current=${currentPerf.strategy_name} ` +
          `(avgPnl=${(currentPerf.avg_pnl_pct ?? 0).toFixed(2)}%, ` +
          `winRate=${currentPerf.win_rate_pct ?? "?"}%, n=${currentPerf.resolved}) ` +
          `→ ${best.perf.strategy_name} ` +
          `(avgPnl=${(best.perf.avg_pnl_pct ?? 0).toFixed(2)}%, ` +
          `winRate=${best.perf.win_rate_pct}%, n=${best.perf.resolved})`,
        forced: true,
      };
    }

    const currentWrTilt = 0.85 + 0.15 * wr;
    const currentSampleFactor = Math.min(1, currentPerf.resolved / 25);
    const currentScore =
      (currentPerf.avg_pnl_pct ?? 0) *
      currentWrTilt *
      (0.75 + 0.25 * currentSampleFactor);

    if (best.score <= currentScore * SWITCH_SCORE_MARGIN) return null;
  }

  return {
    preset: best.perf.strategy_name,
    reasoning:
      `DETERMINISTIC_FALLBACK: best by expectancy = ${best.perf.strategy_name} ` +
      `(avgPnl=${(best.perf.avg_pnl_pct ?? 0).toFixed(2)}%, ` +
      `winRate=${best.perf.win_rate_pct}%, n=${best.perf.resolved})`,
    forced: false,
  };
}

/**
 * Verify that a preset chosen by Groq is not a proven loser.
 * Returns the deterministic override if needed, otherwise null.
 */
function checkGroqChoiceAgainstPerformance(
  groqPreset: string,
  performance: VariantPerformance[],
): { preset: string; reasoning: string } | null {
  const targetPerf = performance.find((p) => p.strategy_name === groqPreset);
  if (!targetPerf) return null;
  if (targetPerf.resolved < FALLBACK_MIN_SAMPLE) return null;

  const avgPnl = targetPerf.avg_pnl_pct ?? targetPerf.total_pnl_pct;
  const wr = (targetPerf.win_rate_pct ?? 0) / 100;
  const badExpectancy = avgPnl < AUTO_DEMOTE_AVG_PNL_THRESHOLD;
  const veryBadWr = wr < AUTO_DEMOTE_WINRATE_SOFT;

  if (!badExpectancy) return null;
  if (!veryBadWr && targetPerf.resolved < FALLBACK_MIN_SAMPLE + 4 && avgPnl > -0.5) {
    return null;
  }

  const fallback = selectBestPresetDeterministic(performance, null);
  if (!fallback) return null;

  return {
    preset: fallback.preset,
    reasoning:
      `OVERRIDE: Groq picked ${groqPreset} with negative expectancy ` +
      `(avgPnl=${(targetPerf.avg_pnl_pct ?? 0).toFixed(2)}%, ` +
      `winRate=${targetPerf.win_rate_pct}%, n=${targetPerf.resolved}). ` +
      `Deterministic pick: ${fallback.preset}`,
  };
}

/* ───────────── Groq call — discriminated result ───────────── */

type AskResult =
  | { kind: "success"; preset: string; reasoning: string }
  | { kind: "error"; message: string; retryable: boolean };

async function askGroqForPreset(
  snapshot: MarketSnapshot,
  currentPreset: string | null,
  performance: VariantPerformance[],
): Promise<AskResult> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) {
    return { kind: "error", message: "GROQ_API_KEY not set", retryable: false };
  }

  const presetList = Object.keys(STRATEGY_PRESETS).join(", ");

  const systemPrompt = [
    "You are a senior trading strategist choosing the best bot strategy preset.",
    "",
    "You receive TWO sources of information:",
    "1. CURRENT MARKET SNAPSHOT — whale flow, technicals, prediction markets, council consensus",
    "2. HISTORICAL SHADOW PERFORMANCE — last 7 days of hypothetical results per preset",
    "",
    "Decision policy:",
    "- This is CRYPTO: regimes shift fast, fat tails are normal, win-rate alone is a weak metric.",
    "- Prefer avg_pnl_pct (expectancy) over total_pnl_pct. total_pnl_pct is a raw sum and can look extreme — use it only as secondary context.",
    "- A preset with win_rate 35-50% but solid positive avg_pnl_pct can be excellent (trend asymmetry).",
    "- Strongly prefer presets with positive avg_pnl_pct and trustworthy/adequate sample.",
    "- Avoid presets with clearly negative avg_pnl_pct when resolved >= 8, unless the CURRENT market snapshot strongly favors their thesis.",
    "- When resolved < 12 or trustworthy=false, lean harder on the live market snapshot than on history.",
    "- When presets are close on expectancy, pick the one that best matches current regime (whale/tech/pred/council).",
    "",
    "Respond with ONLY a minified JSON object. No markdown. No code fences.",
    'Shape: {"preset":"<name>","reasoning":"<one concise sentence that references BOTH regime AND performance>"}',
    `Allowed presets: ${presetList}.`,
    "If the current preset is already appropriate, return it unchanged.",
  ].join("\n");

  const userPrompt = JSON.stringify({
    current_preset: currentPreset ?? "balanced",
    current_market: {
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
    historical_performance_7d: performance.map((p) => ({
      preset: p.strategy_name,
      resolved: p.resolved,
      wins: p.wins,
      losses: p.losses,
      win_rate_pct: p.win_rate_pct,
      avg_pnl_pct: p.avg_pnl_pct,
      total_pnl_pct: p.total_pnl_pct,
      trustworthy: p.trustworthy,
    })),
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
        // gpt-oss-20b reasoning model: 800 was too low. The audit confirmed
        // finish_reason=length with reasoning_tokens=798 — the model burned
        // its entire token budget on hidden reasoning and emitted zero output.
        // 4096 gives ample headroom for reasoning + the ~40-token JSON.
        max_tokens: 4096,
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
  performance: VariantPerformance[],
  maxRetries: number,
  baseBackoffMs: number,
): Promise<{ result: AskResult; attempts: number; history: string[] }> {
  const history: string[] = [];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const r = await askGroqForPreset(snapshot, currentPreset, performance);

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

/* ───────────── Apply preset helper ───────────── */

/**
 * Applies a preset to strategy_config + records audit fields.
 * Returns true on success, false on DB error.
 */
async function applyPreset(
  db: Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"],
  presetName: string,
  reasoning: string,
): Promise<boolean> {
  const preset = STRATEGY_PRESETS[presetName];
  if (!preset) return false;

  const { error } = await db
    .from("strategy_config")
    .update({
      whale_weight: preset.whale_weight,
      technicals_weight: preset.technicals_weight,
      prediction_weight: preset.prediction_weight,
      council_weight: preset.council_weight,
      preset_name: preset.preset_name ?? "custom",
      last_auto_switch_at: new Date().toISOString(),
      last_auto_reasoning: reasoning,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (error) {
    console.error("[AUTO_SWITCH] applyPreset failed:", serializeError(error));
    return false;
  }
  return true;
}

  /** Real paper portfolio over the last 14 days; crypto uses a soft extreme-weakness veto. */
  async function fetchRealPortfolioStats(): Promise<{
    closed: number;
    win_rate_pct: number | null;
    net_pnl: number;
  } | null> {
    try {
      const { supabaseAdmin: db } = await import(
        "@/integrations/supabase/client.server"
      );
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await db
        .from("trades")
        .select("pnl")
        .eq("status", "closed")
        .eq("mode", "paper")
        .eq("side", "buy")
        .gte("closed_at", since);
      if (error || !data) return null;
      const closed = data.length;
      if (closed === 0) return { closed: 0, win_rate_pct: null, net_pnl: 0 };
      const wins = data.filter((trade) => Number(trade.pnl) > 0).length;
      const net_pnl = data.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);
      return {
        closed,
        win_rate_pct: Math.round((wins / closed) * 1000) / 10,
        net_pnl: Math.round(net_pnl * 100) / 100,
      };
    } catch (error) {
      console.error("[AUTO_SWITCH] fetchRealPortfolioStats failed:", serializeError(error));
      return null;
    }
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
      performance_snapshot?: VariantPerformance[];
      source?: "groq" | "deterministic" | "auto_demote" | "override";
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
        const hoursRemaining = ((minCooldownMs - elapsedMs) / 3_600_000).toFixed(
          1,
        );
        return { switched: false, reason: `cooldown_${hoursRemaining}h` };
      }

      // 4. Gather market snapshot
      const snapshot = await gatherSnapshot();

      // 5. Gather historical performance (shadow variants)
      const performance = await fetchVariantPerformance(7);
      console.log(
        `[AUTO_SWITCH] variant performance loaded: ${performance.length} presets`,
      );

      // Do not switch on small or negative shadow samples.
      const MIN_SWITCH_SAMPLE = 25;
      const positiveTrusted = performance.filter(
        (p) => p.resolved >= MIN_SWITCH_SAMPLE && (p.avg_pnl_pct ?? 0) > 0,
      );
      if (positiveTrusted.length === 0) {
        console.warn(
          `[AUTO_SWITCH] blocked — no preset with resolved>=${MIN_SWITCH_SAMPLE} and avg_pnl>0`,
        );
        return {
          switched: false,
          reason: "insufficient_positive_sample",
          performance_snapshot: performance,
        };
      }

      const realStats = await fetchRealPortfolioStats();
      if (realStats) {
        console.log(
          `[AUTO_SWITCH] real paper (14d): closed=${realStats.closed} ` +
            `WR=${realStats.win_rate_pct ?? "n/a"}% netPnL=${realStats.net_pnl}`,
        );
      }
      const realIsSeverelyWeak =
        realStats != null &&
        realStats.closed >= 12 &&
        realStats.win_rate_pct != null &&
        realStats.win_rate_pct < 25 &&
        realStats.net_pnl < -50;

      const currentPreset = (row["preset_name"] as string | null) ?? null;

      // 6. Deterministic pre-check: if current preset is a proven loser,
      //    demote BEFORE calling Groq. This guarantees the system never
      //    stays on a 0/18 preset regardless of Groq availability.
      const preCheck = selectBestPresetDeterministic(performance, currentPreset);
      if (preCheck && preCheck.forced) {
        console.warn(
          `[AUTO_SWITCH] Pre-Groq auto-demote triggered: ${preCheck.reasoning}`,
        );
        const applied = await applyPreset(db, preCheck.preset, preCheck.reasoning);
        if (applied) {
          return {
            switched: true,
            preset: preCheck.preset,
            reasoning: preCheck.reasoning,
            reason: "switched",
            source: "auto_demote",
            performance_snapshot: performance,
          };
        }
      }

      // 7. Load cleanup config (retry feature flag)
      const cleanupCfg = await fetchCleanupConfig();
      const retryCfg = cleanupCfg.auto_switch_retry;
      const maxRetries = retryCfg.enabled
        ? Math.max(1, retryCfg.max_retries)
        : 1;
      const backoffMs = retryCfg.enabled
        ? Math.max(500, retryCfg.backoff_ms)
        : 0;

      // 8. Call Groq με retry (πλέον με performance context)
      const {
        result: decision,
        attempts,
        history,
      } = await askGroqWithRetry(
        snapshot,
        currentPreset,
        performance,
        maxRetries,
        backoffMs,
      );

      // 9. Groq failed → deterministic fallback (NOT a silent no-op)
      if (decision.kind === "error") {
        const detail = `Groq failed after ${attempts} attempt(s): ${decision.message}`;
        console.error(`[AUTO_SWITCH] ${detail}`);
        if (history.length > 1) {
          console.error(`[AUTO_SWITCH] history: ${history.join(" → ")}`);
        }

        const fallback = selectBestPresetDeterministic(
          performance,
          currentPreset,
        );

        if (
          fallback &&
          fallback.preset !== currentPreset &&
          (fallback.forced || !realIsSeverelyWeak)
        ) {
          const fullReasoning = `Groq unavailable (${decision.message}). ${fallback.reasoning}`;
          const applied = await applyPreset(db, fallback.preset, fullReasoning);
          if (applied) {
            console.log(
              `[AUTO_SWITCH] Deterministic fallback applied: ${currentPreset} → ${fallback.preset}`,
            );
            return {
              switched: true,
              preset: fallback.preset,
              reasoning: fullReasoning,
              reason: "switched",
              detail,
              source: "deterministic",
              performance_snapshot: performance,
            };
          }
        }

        // No eligible fallback OR fallback equals current preset →
        // still record the Groq failure for audit visibility.
        await db
          .from("strategy_config")
          .update({
            last_auto_switch_at: new Date().toISOString(),
            last_auto_reasoning: detail,
          })
          .eq("id", 1);

        return {
          switched: false,
          reason: fallback ? "no_change" : "groq_failed_no_eligible_variant",
          detail,
          performance_snapshot: performance,
        };
      }

      // 10. Groq succeeded → verify its pick against performance data.
      //     If Groq chose a proven loser, override with deterministic pick.
      const override = checkGroqChoiceAgainstPerformance(
        decision.preset,
        performance,
      );
      const finalPreset = override?.preset ?? decision.preset;
      const finalReasoning = override?.reasoning ?? decision.reasoning;
      const source: "groq" | "override" = override ? "override" : "groq";

      // 11. Same preset → just log
      if (finalPreset === currentPreset) {
        await db
          .from("strategy_config")
          .update({
            last_auto_switch_at: new Date().toISOString(),
            last_auto_reasoning: `No change: ${finalReasoning}`,
          })
          .eq("id", 1);
        return {
          switched: false,
          reason: "no_change",
          preset: finalPreset,
          reasoning: finalReasoning,
          source,
          performance_snapshot: performance,
        };
      }

      // 12. Apply new preset
      const applied = await applyPreset(db, finalPreset, finalReasoning);
      if (!applied) {
        return { switched: false, reason: "invalid_preset" };
      }

      console.log(
        `[AUTO_SWITCH] ${currentPreset} → ${finalPreset} | source=${source} | ${finalReasoning}`,
      );
      return {
        switched: true,
        preset: finalPreset,
        reasoning: finalReasoning,
        reason: "switched",
        source,
        performance_snapshot: performance,
      };
    },
  );

/* ───────────── AI Council Learning ─────────────
 * Post-mortem analysis κλειστών trades + retrieval προηγούμενων μαθημάτων.
 *
 * NOTE: Το openai/gpt-oss-20b είναι reasoning model — ξοδεύει tokens σε
 * internal reasoning. max_tokens πρέπει να είναι ≥ 500.
 *
 * NOTE: Το `trades` table ΔΕΝ έχει στήλη pnl_pct — υπολογίζεται τοπικά
 * από pnl / (entry_price * quantity) * 100. */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const LESSON_MODEL = process.env["GROQ_MODEL"] ?? "openai/gpt-oss-20b";
const GROQ_TIMEOUT_MS = 20_000;
const POST_MORTEM_BATCH_MAX = 5;
const LESSONS_PER_SYMBOL = 5;
const LESSON_MAX_TOKENS = 1200;

interface TradeForPostMortem {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  entry_price: number;
  exit_price: number;
  pnl: number;
  close_reason: string;
  closed_at: string;
  composite_signal_id: string | null;
}

/** Compute pnl_pct locally from pnl and notional. */
function computePnlPct(trade: TradeForPostMortem): number {
  const notional = Number(trade.entry_price) * Number(trade.quantity);
  if (!Number.isFinite(notional) || notional <= 0) return 0;
  return (Number(trade.pnl) / notional) * 100;
}

export interface LearningResult {
  generated: number;
  attempted: number;
  status: "ok" | "degraded_fallback" | "failed";
  error: string | null;
}

/* ───────────── Groq: generate lesson ───────────── */

async function groqGenerateLesson(
  trade: TradeForPostMortem,
  pnlPct: number,
  originalReasoning: string | null,
  originalVerdict: string | null,
): Promise<
  | { lesson: string; outcome: "win" | "loss" | "breakeven" }
  | { error: string }
> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) return { error: "GROQ_API_KEY not set" };

  const outcome: "win" | "loss" | "breakeven" =
    trade.pnl > 0 ? "win" : trade.pnl < 0 ? "loss" : "breakeven";

  const systemPrompt = [
    "You are a trading coach reviewing a closed trade.",
    "Extract ONE concise, generalizable lesson that improves FUTURE decisions for this symbol.",
    "Focus on WHY it worked or failed — not restating the obvious.",
    "Do NOT mention specific prices. Focus on market conditions and signal alignment.",
    "Respond with a SINGLE sentence, max 25 words. No markdown. No quotes.",
  ].join("\n");

  const userPrompt = [
    `Symbol: ${trade.symbol}`,
    `Side: ${trade.side.toUpperCase()}`,
    `PnL: ${trade.pnl.toFixed(2)} USD (${pnlPct.toFixed(2)}%)`,
    `Close reason: ${trade.close_reason}`,
    `Original signal: ${originalVerdict ?? "unknown"}`,
    `Original reasoning: ${originalReasoning ?? "not recorded"}`,
    `Outcome: ${outcome}`,
    "",
    "What should the council remember for the next time it considers this symbol?",
  ].join("\n");

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: LESSON_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: LESSON_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}: ${body.slice(0, 150)}` };
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return { error: "Empty content (likely max_tokens too low)" };
    }

    const clean = content
      .replace(/^["'`]|["'`]$/g, "")
      .replace(/\*\*/g, "")
      .trim();
    return { lesson: clean, outcome };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/* ───────────── Post-mortem generator ───────────── */

export async function generatePostMortems(): Promise<LearningResult> {
  const { supabaseAdmin: db } = await import(
    "@/integrations/supabase/client.server"
  );

  // ⚠️ pnl_pct NOT selected — it doesn't exist in the trades schema.
  // We select quantity instead and compute pnl_pct locally.
  const { data: trades, error } = await db
    .from("trades")
    .select(
      "id, symbol, side, quantity, entry_price, exit_price, pnl, close_reason, closed_at, composite_signal_id",
    )
    .eq("status", "closed")
    .eq("post_mortem_generated", false)
    .order("closed_at", { ascending: false })
    .limit(POST_MORTEM_BATCH_MAX);

  if (error) {
    console.error("[LESSON] failed to fetch closed trades:", error);
    return {
      generated: 0,
      attempted: 0,
      status: "failed",
      error: `fetch: ${error.message}`,
    };
  }
  if (!trades || trades.length === 0) {
    return { generated: 0, attempted: 0, status: "ok", error: null };
  }

  const tradeList = trades as TradeForPostMortem[];
  let generated = 0;
  let lastError: string | null = null;

  for (const trade of tradeList) {
    const pnlPct = computePnlPct(trade);

    let originalReasoning: string | null = null;
    let originalVerdict: string | null = null;

    if (trade.composite_signal_id) {
      const { data: sig } = await db
        .from("composite_signals")
        .select("reasoning, recommendation")
        .eq("id", trade.composite_signal_id)
        .maybeSingle();

      if (sig) {
        const row = sig as Record<string, unknown>;
        originalReasoning = (row["reasoning"] as string | null) ?? null;
        originalVerdict = (row["recommendation"] as string | null) ?? null;
      }
    }

    const result = await groqGenerateLesson(
      trade,
      pnlPct,
      originalReasoning,
      originalVerdict,
    );

    if ("error" in result) {
      lastError = result.error;
      console.warn(
        `[LESSON] Groq failed for ${trade.symbol}: ${result.error} — will retry next cycle`,
      );
      continue;
    }

    const { error: insertErr } = await db.from("council_lessons").insert({
      symbol: trade.symbol,
      verdict: originalVerdict,
      conviction: null,
      entry_context: {
        reasoning: originalReasoning,
        side: trade.side,
        entry_price: trade.entry_price,
        exit_price: trade.exit_price,
        close_reason: trade.close_reason,
      },
      outcome: result.outcome,
      realized_pnl: trade.pnl,
      pnl_pct: pnlPct, // ← computed locally
      lesson: result.lesson,
      source_trade_id: trade.id,
    } as never);

    if (insertErr) {
      lastError = insertErr.message;
      console.error(`[LESSON] insert failed for ${trade.symbol}:`, insertErr);
      continue;
    }

    await db
      .from("trades")
      .update({ post_mortem_generated: true } as never)
      .eq("id", trade.id);

    generated += 1;
    console.log(
      `[LESSON] ${trade.symbol} [${result.outcome}]: ${result.lesson}`,
    );
  }

  const status: LearningResult["status"] =
    generated === tradeList.length
      ? "ok"
      : generated > 0
        ? "degraded_fallback"
        : "failed";

  return {
    generated,
    attempted: tradeList.length,
    status,
    error: lastError,
  };
}

/* ───────────── Retrieval για RAG ───────────── */

export interface SymbolLesson {
  lesson: string;
  outcome: string;
  created_at: string;
}

export async function fetchRelevantLessons(
  symbols: string[],
  perSymbol: number = LESSONS_PER_SYMBOL,
): Promise<Map<string, SymbolLesson[]>> {
  const grouped = new Map<string, SymbolLesson[]>();
  if (symbols.length === 0) return grouped;

  const { supabaseAdmin: db } = await import(
    "@/integrations/supabase/client.server"
  );

  const { data, error } = await db
    .from("council_lessons")
    .select("symbol, lesson, outcome, created_at")
    .in("symbol", symbols)
    .order("created_at", { ascending: false })
    .limit(symbols.length * perSymbol * 2);

  if (error || !data) return grouped;

  for (const row of data as {
    symbol: string;
    lesson: string;
    outcome: string;
    created_at: string;
  }[]) {
    const bucket = grouped.get(row.symbol) ?? [];
    if (bucket.length < perSymbol) {
      bucket.push({
        lesson: row.lesson,
        outcome: row.outcome,
        created_at: row.created_at,
      });
      grouped.set(row.symbol, bucket);
    }
  }

  return grouped;
}

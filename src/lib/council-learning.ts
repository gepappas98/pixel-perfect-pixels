/* ───────────── AI Council Learning ─────────────
 * Post-mortem analysis κλειστών trades + retrieval προηγούμενων μαθημάτων.
 * Δεν απαιτεί embeddings — χρησιμοποιεί symbol-based retrieval.
 *
 * NOTE: Το μοντέλο openai/gpt-oss-20b είναι reasoning model — ξοδεύει
 * tokens σε internal reasoning πριν γράψει το content. Γι' αυτό το
 * max_tokens πρέπει να είναι ≥ 500 (80 ήταν πολύ λίγο → empty content). */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const LESSON_MODEL = process.env["GROQ_MODEL"] ?? "openai/gpt-oss-20b";
const GROQ_TIMEOUT_MS = 20_000;
const POST_MORTEM_BATCH_MAX = 5;
const LESSONS_PER_SYMBOL = 5;
const LESSON_MAX_TOKENS = 500;

interface TradeForPostMortem {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  entry_price: number;
  exit_price: number;
  pnl: number;
  pnl_pct: number;
  close_reason: string;
  closed_at: string;
  composite_signal_id: string | null;
}

/* ───────────── Groq: generate lesson ───────────── */

async function groqGenerateLesson(
  trade: TradeForPostMortem,
  originalReasoning: string | null,
  originalVerdict: string | null,
): Promise<{ lesson: string; outcome: "win" | "loss" | "breakeven" } | null> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) return null;

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
    `PnL: ${trade.pnl.toFixed(2)} USD (${trade.pnl_pct.toFixed(2)}%)`,
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
      throw new Error(`Groq HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      console.warn(
        `[LESSON] Groq returned empty content for ${trade.symbol} — likely max_tokens too low`,
      );
      return null;
    }

    const clean = content
      .replace(/^["'`]|["'`]$/g, "")
      .replace(/\*\*/g, "")
      .trim();
    return { lesson: clean, outcome };
  } catch (e) {
    console.error(`[LESSON] Groq failed for ${trade.symbol}:`, e);
    return null;
  }
}

/* ───────────── Post-mortem generator ───────────── */

export async function generatePostMortems(): Promise<number> {
  const { supabaseAdmin: db } = await import(
    "@/integrations/supabase/client.server"
  );

  const { data: trades, error } = await db
    .from("trades")
    .select(
      "id, symbol, side, entry_price, exit_price, pnl, pnl_pct, close_reason, closed_at, composite_signal_id",
    )
    .eq("status", "closed")
    .eq("post_mortem_generated", false)
    .order("closed_at", { ascending: false })
    .limit(POST_MORTEM_BATCH_MAX);

  if (error) {
    console.error("[LESSON] failed to fetch closed trades:", error);
    return 0;
  }
  if (!trades || trades.length === 0) return 0;

  let generated = 0;

  for (const trade of trades as TradeForPostMortem[]) {
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
      originalReasoning,
      originalVerdict,
    );
    if (!result) {
      console.warn(
        `[LESSON] Groq failed for trade ${trade.id.slice(0, 8)} — will retry next cycle`,
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
      pnl_pct: trade.pnl_pct,
      lesson: result.lesson,
      source_trade_id: trade.id,
    } as never);

    if (insertErr) {
      console.error(`[LESSON] insert failed for ${trade.symbol}:`, insertErr);
      continue;
    }

    await db
      .from("trades")
      .update({ post_mortem_generated: true } as never)
      .eq("id", trade.id);

    generated += 1;
    console.log(`[LESSON] ${trade.symbol} [${result.outcome}]: ${result.lesson}`);
  }

  return generated;
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

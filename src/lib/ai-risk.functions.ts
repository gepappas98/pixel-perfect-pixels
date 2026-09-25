import { createServerFn } from "@tanstack/react-start";

/* ───────────── DuckDuckGo AI Chat — direct API client ───────────── */

const DDG_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Βήμα 1: Πάρε το VQD token από το DuckDuckGo.
 * Το token είναι υποχρεωτικό header (x-vqd-4) για το επόμενο POST.
 */
async function getVqdToken(query: string): Promise<string> {
  const res = await fetch(
    `https://duckduckgo.com/duckchat/v1/status?q=${encodeURIComponent(query)}`,
    {
      headers: {
        "User-Agent": DDG_USER_AGENT,
        Accept: "text/event-stream",
        "x-vqd-accept": "1",
      },
    },
  );

  const vqd = res.headers.get("x-vqd-4");
  if (!vqd) {
    throw new Error(
      `Failed to obtain VQD token from DuckDuckGo (HTTP ${res.status})`,
    );
  }
  return vqd;
}

/**
 * Βήμα 2: Στείλε το prompt και διάβασε το SSE stream.
 * Το DuckDuckGo επιστρέφει γραμμές της μορφής "data: {json}\n\n".
 */
async function duckChat(prompt: string, model: string = "gpt-4o-mini"): Promise<string> {
  const vqd = await getVqdToken(prompt);

  const res = await fetch("https://duckduckgo.com/duckchat/v1/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vqd-4": vqd,
      "User-Agent": DDG_USER_AGENT,
      Accept: "text/event-stream",
      Origin: "https://duckduckgo.com",
      Referer: "https://duckduckgo.com/",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo AI HTTP ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body from DuckDuckGo");

  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as { message?: string };
        if (typeof parsed.message === "string") answer += parsed.message;
      } catch {
        /* skip malformed chunks */
      }
    }
  }

  return answer.trim();
}

/* ───────────── Server Function ───────────── */

export const getAIRiskSummary = createServerFn({ method: "POST" })
  .validator((data: { symbol: string; context?: string }) => {
    if (!data.symbol || typeof data.symbol !== "string") {
      throw new Error("symbol is required");
    }
    return {
      symbol: data.symbol.toUpperCase().trim(),
      context: (data.context ?? "").trim(),
    };
  })
  .handler(async ({ data }) => {
    try {
      const prompt = [
        `You are a concise crypto risk analyst. Provide a risk summary for ${data.symbol}.`,
        `Market context: ${data.context || "No additional context provided."}`,
        "",
        "Cover these three points in under 120 words:",
        "1. Key risks (specific to this symbol)",
        "2. Volatility outlook",
        "3. One actionable takeaway",
        "",
        "Be direct and specific. No disclaimers.",
      ].join("\n");

      const summary = await duckChat(prompt, "gpt-4o-mini");

      if (!summary) {
        return { ok: false as const, error: "Empty response from DuckDuckGo AI" };
      }

      return {
        ok: true as const,
        symbol: data.symbol,
        summary,
        model: "gpt-4o-mini",
        generatedAt: new Date().toISOString(),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("AI risk summary failed", e);
      return { ok: false as const, error: message };
    }
  });

import { createServerFn } from "@tanstack/react-start";
import { createDuckDuckGoChat } from "free-chatbot";

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
      const ddg = createDuckDuckGoChat();

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

      const response = await ddg.chat(prompt, { model: "gpt-4o-mini" });

      if (!response || response.trim().length === 0) {
        return { ok: false as const, error: "Empty response from DuckDuckGo AI" };
      }

      return {
        ok: true as const,
        symbol: data.symbol,
        summary: response.trim(),
        model: "gpt-4o-mini",
        generatedAt: new Date().toISOString(),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("AI risk summary failed", e);
      return { ok: false as const, error: message };
    }
  });

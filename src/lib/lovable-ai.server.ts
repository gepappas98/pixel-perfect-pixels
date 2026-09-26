/**
 * Server-only AI client — Groq (free tier, no credits needed).
 * Model: llama-3.3-70b-versatile — fast, capable, generous rate limits.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
export const AI_MODEL = "groq/llama-3.3-70b-versatile";

export async function askLovableAI(
  prompt: string,
  instructions?: string,
): Promise<string> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const messages: { role: string; content: string }[] = [];

  if (instructions) {
    messages.push({ role: "system", content: instructions });
  } else {
    messages.push({
      role: "system",
      content:
        "You are a concise, expert crypto trading analyst. Be direct and specific. No disclaimers.",
    });
  }

  messages.push({ role: "user", content: prompt });

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: 1024,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429) throw new Error("Groq rate limited — wait a few seconds and retry.");
    if (res.status === 401) throw new Error("Groq API key invalid — check GROQ_API_KEY in .env");
    throw new Error(`Groq HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Empty response from Groq");
  return text.trim();
}

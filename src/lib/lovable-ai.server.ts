// Server-only helper: streams a text answer from the Lovable AI Gateway (Responses API).
const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/responses";
export const AI_MODEL = "openai/gpt-6-astra";

export async function askLovableAI(prompt: string, instructions?: string): Promise<string> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new Error("AI is not configured (missing LOVABLE_API_KEY).");

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      stream: true,
      store: false,
      reasoning: { effort: "low" },
      ...(instructions ? { instructions } : {}),
      input: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429) throw new Error("AI is busy right now (rate limited). Try again shortly.");
    if (res.status === 402) throw new Error("AI credits exhausted. Add credits in Settings → Plans & credits.");
    throw new Error(`AI Gateway HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body from AI Gateway");
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
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload) as {
          type?: string;
          delta?: string;
          error?: { message?: string };
          response?: { error?: { message?: string } };
        };
        if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
          answer += evt.delta;
        } else if (evt.type === "error" || evt.type === "response.failed") {
          throw new Error(evt.error?.message ?? evt.response?.error?.message ?? "AI request failed");
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  return answer.trim();
}

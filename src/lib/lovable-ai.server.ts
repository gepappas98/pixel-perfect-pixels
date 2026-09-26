// Server-only helper: free text generation via Pollinations.ai (no API key, no credits).
const POLLINATIONS_URL = "https://text.pollinations.ai/openai";
export const AI_MODEL = "pollinations/openai";

export async function askLovableAI(prompt: string, instructions?: string): Promise<string> {
  const messages = [
    ...(instructions ? [{ role: "system", content: instructions }] : []),
    { role: "user", content: prompt },
  ];

  const res = await fetch(POLLINATIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai", messages, private: true }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429) throw new Error("Free AI is busy (rate limited). Wait a few seconds and try again.");
    throw new Error(`Pollinations AI HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

import { createFileRoute } from "@tanstack/react-router";

const SUPABASE_URL = "https://yckewtpfttvwiptmmrfq.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_v0BSD7Eg6ze85nuYPRMJ6w_M_lwwXjx";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_BODY_BYTES = 50_000;

function isServiceRoleJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const segment = parts[1];
    if (!segment) return false;
    const encoded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = encoded + "=".repeat((4 - encoded.length % 4) % 4);
    return JSON.parse(atob(padded)).role === "service_role";
  } catch { return false; }
}

async function authorized(request: Request): Promise<boolean> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  if (token.length < 32 || token.startsWith("sb_publishable_")) return false;
  const secretKey = token.startsWith("sb_secret_");
  if (!secretKey && !isServiceRoleJwt(token)) return false;
  const headers = new Headers();
  if (secretKey) headers.set("apikey", token);
  else {
    headers.set("apikey", SUPABASE_PUBLISHABLE_KEY);
    headers.set("authorization", `Bearer ${token}`);
  }
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/council_lessons?select=id&limit=1`, {
      headers, signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch { return false; }
}

export const Route = createFileRoute("/api/public/council-lessons-batch")({
  server: {
    handlers: {
      GET: async () => new Response("Method Not Allowed: use POST", {
        status: 405, headers: { Allow: "POST" },
      }),
      POST: async ({ request }) => {
        if (!(await authorized(request))) return Response.json({ error: "unauthorized" }, { status: 401 });
        const declaredLength = Number(request.headers.get("content-length") ?? 0);
        if (declaredLength > MAX_BODY_BYTES) return Response.json({ error: "payload_too_large" }, { status: 413 });
        let body: unknown;
        try {
          const raw = await request.text();
          if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "payload_too_large" }, { status: 413 });
          body = JSON.parse(raw);
        } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }

        const trades = body && typeof body === "object" ? (body as { trades?: unknown }).trades : undefined;
        if (!Array.isArray(trades) || trades.length < 1 || trades.length > 5 ||
          !trades.every((t) => t && typeof t === "object" &&
            typeof t.source_trade_id === "string" && /^[0-9a-f-]{36}$/i.test(t.source_trade_id) &&
            typeof t.symbol === "string" && /^[A-Z0-9][A-Z0-9/_.-]{1,29}$/.test(t.symbol) &&
            typeof t.outcome === "string" && ["win", "loss", "breakeven"].includes(t.outcome) &&
            typeof t.pnl_pct === "number" && Number.isFinite(t.pnl_pct) &&
            typeof t.close_reason === "string")) {
          return Response.json({ error: "invalid_trades" }, { status: 400 });
        }
        const apiKey = process.env["GROQ_API_KEY"];
        if (!apiKey) return Response.json({ error: "ai_provider_unavailable" }, { status: 503 });
        const allowedIds = new Set(trades.map((t) => (t as {source_trade_id:string}).source_trade_id));
        try {
          const upstream = await fetch(GROQ_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: "openai/gpt-oss-20b",
              messages: [
                { role: "system", content: [
                  "You are a post-trade research analyst for a long-only spot crypto paper-trading lab.",
                  "For each supplied closed trade, return one cautious, evidence-grounded lesson for future evaluation.",
                  "Do not claim causality from a single trade, invent missing facts, or recommend changing thresholds.",
                  "If original reasoning is missing, explicitly base the lesson only on observed outcome and close reason.",
                  "Each lesson must be one concise sentence of at most 25 words; no prices or markdown.",
                  "Return one result for every source_trade_id and no other IDs."
                ].join("\n") },
                { role: "user", content: JSON.stringify(trades) }
              ],
              temperature: 0.2,
              max_completion_tokens: 2048,
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "council_trade_lessons",
                  strict: true,
                  schema: {
                    type: "object",
                    properties: { results: { type: "array", items: {
                      type: "object",
                      properties: { source_trade_id: { type: "string" }, lesson: { type: "string" } },
                      required: ["source_trade_id", "lesson"],
                      additionalProperties: false
                    } } },
                    required: ["results"],
                    additionalProperties: false
                  }
                }
              },
              stream: false
            }),
            signal: AbortSignal.timeout(20_000)
          });
          if (!upstream.ok) return Response.json({ error: "ai_provider_error", status: upstream.status }, { status: 502 });
          const data = await upstream.json() as { choices?: { message?: { content?: string | null } }[] };
          const raw = data.choices?.[0]?.message?.content;
          if (!raw) return Response.json({ error: "empty_ai_response" }, { status: 502 });
          const parsed = JSON.parse(raw) as { results?: unknown };
          if (!Array.isArray(parsed.results)) return Response.json({ error: "invalid_ai_response" }, { status: 502 });
          const results = parsed.results.filter((item): item is {source_trade_id:string;lesson:string} =>
            !!item && typeof item === "object" &&
            typeof (item as {source_trade_id?:unknown}).source_trade_id === "string" &&
            allowedIds.has((item as {source_trade_id:string}).source_trade_id) &&
            typeof (item as {lesson?:unknown}).lesson === "string" &&
            (item as {lesson:string}).lesson.trim().length > 0
          ).map((item) => ({
            source_trade_id: item.source_trade_id,
            lesson: item.lesson.replace(/\s+/g, " ").trim().slice(0, 500)
          }));
          return Response.json({ results });
        } catch (error) {
          const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
          return Response.json({ error: timedOut ? "ai_provider_timeout" : "ai_provider_unavailable" }, { status: timedOut ? 504 : 502 });
        }
      }
    }
  }
});

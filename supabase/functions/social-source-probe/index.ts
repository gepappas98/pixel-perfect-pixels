import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const XMD_BASE = "https://x.pcstyle.dev/api/v1/profiles";

function normalizeText(value: string | undefined | null): string | null {
  if (!value) return null;
  return value.normalize("NFKC").replace(/\s+/g, " ").trim() || null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const auth = req.headers.get("authorization");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRole || auth !== `Bearer ${serviceRole}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const handle = String(body.handle ?? "").replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9_]{1,30}$/.test(handle)) {
    return Response.json({ error: "invalid_handle" }, { status: 400 });
  }

  const url = `${XMD_BASE}/${encodeURIComponent(handle)}?format=json&limit=20`;
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    return Response.json({
      mode: "probe_only",
      connector: "x_md_public",
      handle,
      status: "error",
      error_code: "fetch_failed",
      error_message: e instanceof Error ? e.message : String(e),
      latency_ms: Math.round(performance.now() - started),
    }, { status: 502 });
  }

  const latencyMs = Math.round(performance.now() - started);
  const bodyText = await response.text();
  let json: any = null;
  try { json = JSON.parse(bodyText); } catch {}

  const headers = Object.fromEntries(
    ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "retry-after", "x-cache", "x-source"]
      .map((k) => [k, response.headers.get(k)])
  );

  let status = "ok";
  if (response.status === 429) status = "rate_limited";
  else if (response.status === 403) status = "blocked";
  else if (!response.ok) status = "error";

  const posts = Array.isArray(json?.posts) ? json.posts.map((p: any) => ({
    external_post_id: p?.id ?? null,
    post_url: p?.url ?? null,
    published_at: p?.createdAt ?? null,
    author_handle: p?.author?.handle ?? p?.author?.username ?? handle,
    text_content: normalizeText(p?.text),
  })) : [];

  return Response.json({
    mode: "probe_only",
    connector: "x_md_public",
    handle,
    status,
    http_status: response.status,
    latency_ms: latencyMs,
    response_bytes: bodyText.length,
    posts_found: posts.length,
    headers,
    posts,
    writes_performed: 0,
  });
});
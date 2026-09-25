import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = request.headers.get("x-cron-secret") ?? "";
        if (!secret || secret.length > 200)
          return new Response("Unauthorized", { status: 401 });

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        const { data: ok } = await (supabaseAdmin.rpc as any)(
          "verify_cron_secret",
          { _secret: secret },
        );
        if (ok !== true) return new Response("Unauthorized", { status: 401 });

        const startedAt = new Date().toISOString();
        const { runFullPipeline } = await import("@/lib/pipeline.server");

        try {
          const result = await runFullPipeline();
          // runFullPipeline already writes status="success" to pipeline_runs
          return Response.json({ ok: true, result });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown pipeline error";
          console.error("[cron] pipeline failure:", message, error);

          // runFullPipeline already writes status="error" to pipeline_runs.
          // We do NOT re-insert here to avoid duplicate failure rows.
          // Return 200 so the cron monitor does not increment consecutive
          // failures for errors that are already tracked inside pipeline_runs.
          return Response.json(
            { ok: false, error: message },
            { status: 200 },
          );
        }
      },
    },
  },
});

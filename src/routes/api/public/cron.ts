import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/cron")({
  server: {
    handlers: {
      POST: async () =>
        new Response(
          "Legacy cron endpoint disabled. Use the canonical trading-pipeline-orchestrator scheduler.",
          {
            status: 410,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        ),
    },
  },
});

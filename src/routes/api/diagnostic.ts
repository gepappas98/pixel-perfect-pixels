import { createFileRoute } from "@tanstack/react-router";
import { getWatchDiagnostic } from "@/lib/diagnostic.functions";

export const Route = createFileRoute("/api/diagnostic")({
  server: {
    handlers: {
      GET: async () => {
        try {
          return Response.json(await getWatchDiagnostic());
        } catch (e) {
          const message = e instanceof Error ? e.message : "unknown error";
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});

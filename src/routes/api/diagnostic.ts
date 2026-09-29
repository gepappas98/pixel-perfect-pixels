import { createFileRoute } from "@tanstack/react-router";
import { getWatchDiagnostic } from "@/lib/diagnostic.functions";

export const Route = createFileRoute("/api/diagnostic")({
  server: {
    handlers: {
      GET: async () => {
        const data = await getWatchDiagnostic();
        return Response.json(data);
      },
    },
  },
});

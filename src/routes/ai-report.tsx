import { createFileRoute } from "@tanstack/react-router";
import AIReport from "@/pages/AIReport";

export const Route = createFileRoute("/ai-report")({
  head: () => ({
    meta: [
      { title: "AI Diagnostic Report — Research Lab" },
      {
        name: "description",
        content:
          "Research Lab diagnostic snapshot with system health, simulated portfolio metrics, strategy comparisons, and error logs. For research only; not financial advice.",
      },
      { property: "og:title", content: "AI Diagnostic Report" },
      {
        property: "og:description",
        content: "Operational snapshot and system findings for Research Lab.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AIReport,
});

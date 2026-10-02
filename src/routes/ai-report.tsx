import { createFileRoute } from "@tanstack/react-router";
import AIReport from "@/pages/AIReport";

export const Route = createFileRoute("/ai-report")({
  component: AIReport,
});

import { createServerFn } from "@tanstack/react-start";

export const runPipeline = createServerFn({ method: "POST" }).handler(async () => {
  const { runFullPipeline } = await import("./pipeline.server");
  return await runFullPipeline();
});

export const getTradingStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { tradingMode } = await import("./pipeline.server");
  return {
    mode: tradingMode(),
    binanceConfigured:
      !!process.env["BINANCE_API_KEY"] && !!process.env["BINANCE_API_SECRET"],
  };
});
